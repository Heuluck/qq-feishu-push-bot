import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { runTextToolCalls } from "./toolmarkup.js";

export interface ToolExecutionResult {
  /** 回填给模型的工具结果文本。 */
  text: string;
  /** 是否真的完成了转交（用于兜底文案）。 */
  forwarded: boolean;
}

export type ToolExecutor = (name: string, argsJson: string) => Promise<ToolExecutionResult>;

/** 一条消息里的内容片段，按顺序排列：一段文本，或一张图片（data URL）。 */
export type MessagePart = { text: string } | { image: string };

/** 历史里的一轮对话（不含本轮）。文本已渲染好，图片是 data URL。 */
export interface LlmTurn {
  role: "user" | "assistant";
  parts: MessagePart[];
}

export interface CompleteInput {
  /** 历史轮次，按时间从早到晚。为空表示这是本会话第一句。 */
  history: LlmTurn[];
  /** 本轮提问的内容片段（文本 + 图片，按展示顺序）。 */
  userParts: MessagePart[];
  tool: ChatCompletionTool;
  execTool: ToolExecutor;
}

export interface CompleteResult {
  text: string;
  forwarded: boolean;
}

export class LlmClient {
  private readonly client: OpenAI;

  constructor(private readonly cfg: Config) {
    this.client = new OpenAI({
      baseURL: cfg.LLM_BASE_URL,
      apiKey: cfg.LLM_API_KEY,
      timeout: cfg.LLM_DEADLINE_MS,
      maxRetries: 1,
    });
  }

  /**
   * 思考档位参数。`default` 表示一个都不带、用厂商默认值。
   *
   * 默认档位由 `LLM_REASONING_EFFORT` 决定（默认 `none`，即关掉思考）：
   * 推理内容计入 `max_tokens`，DeepSeek 在「读一张报错截图」这类任务上能让 reasoning
   * 吃光整个预算，返回空正文——于是 `askForReply` 再要一次，而它用的是同一个预算。
   *
   * 两处请求都要带上：补答那次如果关掉思考而这里开着，就会重演同一个问题。
   */
  private thinkingParams(): { reasoning_effort?: Exclude<Config["LLM_REASONING_EFFORT"], "default"> } {
    const effort = this.cfg.LLM_REASONING_EFFORT;
    return effort === "default" ? {} : { reasoning_effort: effort };
  }

  /**
   * 请求结构：`[system 规则 + 知识库]` + 历史轮次 + `[本轮提问]`。
   *
   * 历史用真正的多轮 messages 而不是拼成一段文本，有两个理由：
   *   - 图片待在它到来的那一轮里，模型才有依据区分「这次发的」和「翻出来的旧图」；
   *   - 从 system 到历史是**逐字节稳定、只往后追加**的前缀，能命中厂商的前缀缓存，
   *     只有最新那一轮按原价计费。把整段历史塞进当前那条 user 消息，它每轮都变，缓存全废。
   * 工具定义在每轮都传入且不变，避免破坏前缀。
   */
  async complete(input: CompleteInput, systemPrompt: string): Promise<CompleteResult> {
    const messages = buildMessages(input, systemPrompt);

    const deadline = AbortSignal.timeout(this.cfg.LLM_DEADLINE_MS);
    let forwarded = false;
    let lastText = "";

    for (let round = 0; round < 2; round += 1) {
      const res = await this.client.chat.completions.create(
        {
          model: this.cfg.LLM_MODEL,
          messages,
          tools: [input.tool],
          tool_choice: "auto",
          max_tokens: this.cfg.LLM_MAX_TOKENS,
          ...this.thinkingParams(),
        },
        { signal: deadline },
      );
      this.logUsage(res.usage);

      const choice = res.choices[0]?.message;
      if (!choice) throw new Error("模型返回了空响应");

      const calls = (choice.tool_calls ?? []).filter((call) => call.type === "function");
      if (calls.length === 0) {
        lastText = (choice.content ?? "").trim();
        break;
      }

      // 回传时必须手工构造一个最小且合法的 assistant 轮：只带 role / content / tool_calls。
      // 直接把 SDK 返回的对象 push 回去会带上 reasoning_content 等字段（DeepSeek 要求后续请求
      // 不得包含它），assistant 轮不干净会让模型下一轮不再用结构化调用、改写散文。
      messages.push({
        role: "assistant",
        content: choice.content ?? "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      });
      for (const call of calls) {
        const result = await input.execTool(call.function.name, call.function.arguments);
        if (result.forwarded) forwarded = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
      }
      lastText = (choice.content ?? "").trim();
    }

    // 模型没给出任何对用户说的话（常见于它接不上这个话题，比如看不到上文）：
    // 不再回一句写死的文案，而是明确要求它自己组织一句。
    // 注意这里必须把工具一起传下去——不给工具时，上下文里「答不了就转交」的要求会让它
    // 只能把调用写成正文（这正是我们之前踩过的坑）。
    if (lastText === "") {
      const fallback = await this.askForReply(messages, input.tool, input.execTool, deadline);
      lastText = fallback.text;
      if (fallback.forwarded) forwarded = true;
    }

    // 正文形态的工具调用：模型有时不返回结构化 tool_calls，而是把调用写进正文
    // （原生 <||DSML||…> 标记或散文式一行）。放在最后跑，保证任何来源的文本都被处理：
    // 不处理既会把内部信息发给用户，又会出现「说已转交但其实没转交」。
    const textCalls = await runTextToolCalls(lastText, (name, argsJson) => input.execTool(name, argsJson));
    if (textCalls.forwarded) forwarded = true;
    if (textCalls.calls.length > 0) {
      log.warn("llm", `模型把工具调用写成了正文，已解析并执行 ${textCalls.calls.length} 个：${textCalls.calls.map((c) => c.name).join(", ")}`);
    }
    lastText = textCalls.text;

    return { text: lastText, forwarded };
  }

  /**
   * 追加一句要求，让模型自己补一句给用户的回复（不写死文案）。
   * 必须把工具一起传下去：不给工具时，上下文里「答不了就转交」的要求会让它只能把调用写成正文。
   */
  private async askForReply(
    messages: ChatCompletionMessageParam[],
    tool: ChatCompletionTool,
    execTool: ToolExecutor,
    signal: AbortSignal,
  ): Promise<{ text: string; forwarded: boolean }> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.cfg.LLM_MODEL,
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "（系统提示：请直接用一两句话回应用户。如果是因为你看不到上一条消息或缺少上文，就直接说明这一点，并请他把问题再发一次、或引用你上一条回复。）",
            },
          ],
          tools: [tool],
          tool_choice: "auto",
          max_tokens: this.cfg.LLM_MAX_TOKENS,
          ...this.thinkingParams(),
        },
        { signal },
      );
      this.logUsage(res.usage);
      const choice = res.choices[0]?.message;
      let forwarded = false;
      for (const call of (choice?.tool_calls ?? []).filter((item) => item.type === "function")) {
        const result = await execTool(call.function.name, call.function.arguments);
        if (result.forwarded) forwarded = true;
      }
      return { text: (choice?.content ?? "").trim(), forwarded };
    } catch (err) {
      log.warn("llm", `补一次回复失败：${err instanceof Error ? err.message : String(err)}`);
      return { text: "", forwarded: false };
    }
  }

  /** 记录 token 与缓存命中情况，用来观察前缀缓存是否生效。 */
  private logUsage(usage: unknown): void {
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const details = (u["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
    const cached = details["cached_tokens"] ?? u["prompt_cache_hit_tokens"];
    log.info(
      "llm",
      `tokens prompt=${u["prompt_tokens"] ?? "?"}（缓存命中=${cached ?? "?"}）completion=${u["completion_tokens"] ?? "?"}`,
    );
  }
}

/**
 * 把「system + 历史轮次 + 本轮」组装成请求的 messages。
 *
 * 历史是**逐字节稳定、只往后追加**的前缀，所以能被厂商的前缀缓存命中，只有最新那一轮按原价计费。
 * 反过来，如果把历史拼成一段文本塞进当前那条 user 消息，它每轮都变，缓存全废。
 */
export function buildMessages(input: CompleteInput, systemPrompt: string): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
  for (const turn of input.history) {
    if (turn.role === "assistant") {
      // 机器人自己只发文本，不带图。
      messages.push({ role: "assistant", content: plainText(turn.parts) });
      continue;
    }
    messages.push({ role: "user", content: toContent(turn.parts) });
  }
  messages.push({ role: "user", content: toContent(input.userParts) });
  return messages;
}

/**
 * 把内容片段转成 OpenAI 的 content。
 * 只有一段文本时直接给字符串：更紧凑，也和大多数框架写出来的历史一致，便于命中前缀缓存。
 */
function toContent(parts: MessagePart[]): string | ChatCompletionContentPart[] {
  const [only] = parts;
  if (parts.length === 1 && only !== undefined && "text" in only) return only.text;
  return parts.map((part) =>
    "text" in part
      ? ({ type: "text", text: part.text } as const)
      : ({ type: "image_url", image_url: { url: part.image } } as const),
  );
}

/** 只取文本片段（assistant 轮从不带图）。 */
function plainText(parts: MessagePart[]): string {
  return parts
    .filter((part): part is { text: string } => "text" in part)
    .map((part) => part.text)
    .join("\n");
}
