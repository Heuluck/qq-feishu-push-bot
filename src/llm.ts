import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Config } from "./config.js";
import { log } from "./log.js";

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

      messages.push(choice);
      for (const call of calls) {
        const result = await input.execTool(call.function.name, call.function.arguments);
        if (result.forwarded) forwarded = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
      }
      lastText = (choice.content ?? "").trim();
    }

    // 模型没给出任何对用户说的话（常见于它接不上这个话题，比如看不到上文）：
    // 不再回一句写死的文案，而是明确要求它自己组织一句。
    if (lastText === "") {
      lastText = await this.askForReply(messages, deadline);
    }
    return { text: lastText, forwarded };
  }

  /** 追加一句要求，让模型自己补一句给用户的回复（不写死文案）。 */
  private async askForReply(
    messages: ChatCompletionMessageParam[],
    signal: AbortSignal,
  ): Promise<string> {
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
          max_tokens: this.cfg.LLM_MAX_TOKENS,
        },
        { signal },
      );
      this.logUsage(res.usage);
      return (res.choices[0]?.message.content ?? "").trim();
    } catch (err) {
      log.warn("llm", `补一次回复失败：${err instanceof Error ? err.message : String(err)}`);
      return "";
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
