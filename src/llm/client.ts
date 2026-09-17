/**
 * OAI 兼容模型的调用客户端：一次调用完成（不照抄「调工具 → 回灌 → 再要一次」的两轮循环）。
 *
 * 请求结构与这样做的理由写在 `complete()` 上；请求 messages 的组装在 `./messages.ts`。
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Config } from "../core/config.js";
import { log } from "../core/log.js";
import { buildMessages } from "./messages.js";
import type { CompleteInput, CompleteResult, ToolExecutor, ToolRound } from "./messages.js";
import { runTextToolCalls } from "./toolmarkup.js";

/**
 * 正文形态的调用没有 provider 给的 id（`tool_call_id` 却必须有值，回放时还要与调用配对）。
 * 造一个够短、又不与别的轮次撞车的：它会跟着历史长期落盘，所以只求稳定唯一，不求可读。
 */
let textCallSeq = 0;
function textCallId(): string {
  textCallSeq += 1;
  return `text-${Date.now().toString(36)}-${textCallSeq.toString(36)}`;
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
      // 补答里发生的调用同样要记：不记的话下一轮模型不知道自己转过人工，会重复转交。
      if (fallback.toolRound.calls.length > 0) toolRounds.push(fallback.toolRound);
    }

    // 正文形态的工具调用：模型有时不返回结构化 tool_calls，而是把调用写进正文
    // （原生 <||DSML||…> 标记或散文式一行）。放在最后跑，保证任何来源的文本都被处理：
    // 不处理既会把内部信息发给用户，又会出现「说已转交但其实没转交」。
    const textRound: ToolRound = { content: "", calls: [] };
    const textCalls = await runTextToolCalls(lastText, async (name, argsJson) => {
      const result = await input.execTool(name, argsJson);
      textRound.calls.push({ id: textCallId(), name, argsJson, result: result.text });
      return result;
    });
    if (textCalls.forwarded) forwarded = true;
    if (textCalls.calls.length > 0) {
      log.warn("llm", `模型把工具调用写成了正文，已解析并执行 ${textCalls.calls.length} 个：${textCalls.calls.map((c) => c.name).join(", ")}`);
      // 用户实际看到的那段正文 + 这一轮的调用结果都要进历史（同 tool_calls 那条路径）：
      // 少了它，模型下一轮看不到自己转过人工，会对同一个问题重复转交。
      textRound.content = textCalls.text;
      toolRounds.push(textRound);
    }
    if (textCalls.unparsedMarkup) {
      log.warn(
        "llm",
        "正文里有工具调用标记，但没能解析出调用名（标记已从回复中剔除，这次调用**没有执行**）：检查模型是否换了写法",
      );
    }
    lastText = textCalls.text;

    return { text: lastText, forwarded, toolRounds };
  }

  /**
   * 追加一句要求，让模型自己补一句给用户的回复（不写死文案）。
   * 必须把工具一起传下去：不给工具时，上下文里「答不了就转交」的要求会让它只能把调用写成正文。
   *
   * 这里发生的工具调用同样要回传给调用方（`toolRound`）：它和第一轮一样会真的转交人工，
   * 只回传文本的话，下一轮模型就不知道自己已经转过谁了。
   */
  private async askForReply(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    execTool: ToolExecutor,
    signal: AbortSignal,
  ): Promise<{ text: string; forwarded: boolean; toolRound: ToolRound }> {
    const emptyRound: ToolRound = { content: "", calls: [] };
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
      const text = (choice?.content ?? "").trim();
      const toolRound: ToolRound = { content: text, calls: [] };
      let forwarded = false;
      for (const call of (choice?.tool_calls ?? []).filter((item) => item.type === "function")) {
        const result = await execTool(call.function.name, call.function.arguments);
        if (result.forwarded) forwarded = true;
        toolRound.calls.push({
          id: call.id,
          name: call.function.name,
          argsJson: call.function.arguments,
          result: result.text,
        });
      }
      return { text, forwarded, toolRound };
    } catch (err) {
      log.warn("llm", `补一次回复失败：${err instanceof Error ? err.message : String(err)}`);
      return { text: "", forwarded: false, toolRound: emptyRound };
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
