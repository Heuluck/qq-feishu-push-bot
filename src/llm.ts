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

export interface CompleteInput {
  userText: string;
  /** 当前消息携带的图片（data URL）。 */
  images: string[];
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
   * 请求结构刻意做成「静态前缀 + 单个动态消息」：
   *   [system: 规则 + 知识库]  → 逐字节稳定，命中厂商前缀缓存
   *   [user: 本次提问 + 图片]  → 每次唯一，只有它按原价计费
   * 工具定义在每轮都传入且不变，避免破坏前缀。
   */
  async complete(input: CompleteInput, systemPrompt: string): Promise<CompleteResult> {
    const parts: ChatCompletionContentPart[] = [{ type: "text", text: input.userText }];
    for (const url of input.images) {
      parts.push({ type: "image_url", image_url: { url } });
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: parts },
    ];

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
