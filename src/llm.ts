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
  /** 这一轮里做过的工具调用。回放时要还原成 assistant(tool_calls) + tool 消息。 */
  toolRounds?: ToolRound[];
}

export interface CompleteInput {
  /** 历史轮次，按时间从早到晚。为空表示这是本会话第一句。 */
  history: LlmTurn[];
  /** 本轮提问的内容片段（文本 + 图片，按展示顺序）。 */
  userParts: MessagePart[];
  /** 本轮可用的工具定义。个数与内容都必须稳定，否则会破坏请求前缀缓存。 */
  tools: ChatCompletionTool[];
  execTool: ToolExecutor;
}

export interface CompleteResult {
  text: string;
  forwarded: boolean;
  /** 本轮真的执行过的工具调用，按发生顺序。调用方要把它写进对话缓冲。 */
  toolRounds: ToolRound[];
}

/**
 * 一次工具调用及其结果。
 *
 * 字段必须原样保留（尤其是 provider 给的 `id`）：回放历史时要把这一轮重新拼成
 * `assistant(tool_calls)` + `tool` 两个消息，只要和当时逐字节一致，请求前缀就还能命中缓存。
 * 只记「已转交」这类文本是不够的——模型看不到自己**调用过什么**，就会对同一个问题重复转交人工。
 */
export interface ToolCallRecord {
  id: string;
  name: string;
  argsJson: string;
  /** 工具执行结果原文。 */
  result: string;
}

/** 一轮模型回复里的工具调用（同一条 assistant 消息可以带多个调用）。 */
export interface ToolRound {
  /** 那条 assistant 消息的正文（通常是空字符串，但有的模型会边说边调）。 */
  content: string;
  calls: ToolCallRecord[];
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
   * 请求结构：`[system 规则 + 知识库]` + 历史轮次 + `[本轮提问]`，**一次调用完成**。
   *
   * 历史用真正的多轮 messages 而不是拼成一段文本，有两个理由：
   *   - 图片待在它到来的那一轮里，模型才有依据区分「这次发的」和「翻出来的旧图」；
   *   - 从 system 到历史是**逐字节稳定、只往后追加**的前缀，能命中厂商的前缀缓存，
   *     只有最新那一轮按原价计费。把整段历史塞进当前那条 user 消息，它每轮都变，缓存全废。
   * 工具定义在每轮都传入且不变，避免破坏前缀。
   *
   * **为什么不照抄「调用工具 → 回灌结果 → 再要一次」的标准两轮循环**：模型本来就是
   * 在**同一条 assistant 消息**里既给正文又给 tool_calls（协议允许，正文在协议上就是它说的话），
   * 而那一轮它通常已经把完整答案写好了。两轮循环只取第二轮，等于把第一轮的答案丢掉：
   * 实测最后一轮常常只剩一句「已转交」，甚至写一句指向上一轮的备注——用户收到的是
   * 「（已在上方回复中说明转交）」，而答案全在被丢掉的那一轮里。多一次调用还慢一倍。
   *
   * 代价是模型写正文时还不知道工具结果，所以提示词要求它把转交说成将来时（「我会帮你转给…」）。
   * 工具结果里那点信息（成功/已转过/通道没就绪/每小时超限）本来也只有失败路径需要它改口。
   */
  async complete(input: CompleteInput, systemPrompt: string): Promise<CompleteResult> {
    const messages = buildMessages(input, systemPrompt);

    const deadline = AbortSignal.timeout(this.cfg.LLM_DEADLINE_MS);
    let forwarded = false;
    const toolRounds: ToolRound[] = [];

    const res = await this.client.chat.completions.create(
      {
        model: this.cfg.LLM_MODEL,
        messages,
        tools: input.tools,
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
    let lastText = (choice.content ?? "").trim();

    if (calls.length > 0) {
      // 回传给下一步（补答）时必须手工构造一个最小且合法的 assistant 轮：只带
      // role / content / tool_calls。直接把 SDK 返回的对象 push 回去会带上 reasoning_content
      // 等字段（DeepSeek 要求后续请求不得包含它）。
      messages.push({
        role: "assistant",
        content: choice.content ?? "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      });
      const toolRound: ToolRound = { content: choice.content ?? "", calls: [] };
      for (const call of calls) {
        const result = await input.execTool(call.function.name, call.function.arguments);
        if (result.forwarded) forwarded = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
        toolRound.calls.push({
          id: call.id,
          name: call.function.name,
          argsJson: call.function.arguments,
          result: result.text,
        });
      }
      toolRounds.push(toolRound);
    }

    // 模型没给出任何对用户说的话（常见于它只顾着调工具）：不再回一句写死的文案，
    // 而是把工具结果一并交回去、明确要求它自己组织一句。
    if (lastText === "") {
      const fallback = await this.askForReply(messages, input.tools, input.execTool, deadline);
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

    return { text: lastText, forwarded, toolRounds };
  }

  /**
   * 追加一句要求，让模型自己补一句给用户的回复（不写死文案）。
   * 必须把工具一起传下去：不给工具时，上下文里「答不了就转交」的要求会让它只能把调用写成正文。
   */
  private async askForReply(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
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
          tools,
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
      // 工具轮要还原成当时的形状：assistant(tool_calls) + 每个调用一条 tool。
      // id / 参数 / 结果都按原样回放，这样这轮请求的前缀和上一轮逐字节一致，缓存能继续往后接。
      for (const round of turn.toolRounds ?? []) {
        messages.push({
          role: "assistant",
          content: round.content,
          tool_calls: round.calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.argsJson },
          })),
        });
        for (const call of round.calls) {
          messages.push({ role: "tool", tool_call_id: call.id, content: call.result });
        }
      }
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
