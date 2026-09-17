/**
 * llm 层的数据契约（消息片段、历史轮次、工具调用）与「system + 历史 + 本轮」到请求 messages 的组装。
 *
 * 这里只有纯数据与纯函数：不碰 SDK、不发请求，可直接单测（见 src/smoke.ts）。
 */
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

/** 一条消息里的内容片段，按顺序排列：一段文本，或一张图片（data URL）。 */
export type MessagePart = { text: string } | { image: string };

/** 历史里的一轮对话（不含本轮）。文本已渲染好，图片是 data URL。 */
export interface LlmTurn {
  role: "user" | "assistant";
  parts: MessagePart[];
  /** 这一轮里做过的工具调用。回放时要还原成 assistant(tool_calls) + tool 消息。 */
  toolRounds?: ToolRound[];
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

/** 一次请求要喂给模型的东西。 */
export interface CompleteInput {
  /** 历史轮次，按时间从早到晚。为空表示这是本会话第一句。 */
  history: LlmTurn[];
  /** 本轮提问的内容片段（文本 + 图片，按展示顺序）。 */
  userParts: MessagePart[];
  /** 本轮可用的工具定义。个数与内容都必须稳定，否则会破坏请求前缀缓存。 */
  tools: ChatCompletionTool[];
  execTool: ToolExecutor;
}

/** 工具执行器：把模型要的调用真正做掉，并把结果文本回填给模型。 */
export type ToolExecutor = (name: string, argsJson: string) => Promise<ToolExecutionResult>;

export interface ToolExecutionResult {
  /** 回填给模型的工具结果文本。 */
  text: string;
  /** 是否真的完成了转交（用于兜底文案）。 */
  forwarded: boolean;
}

export interface CompleteResult {
  text: string;
  forwarded: boolean;
  /** 本轮真的执行过的工具调用，按发生顺序。调用方要把它写进对话缓冲。 */
  toolRounds: ToolRound[];
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
      // 但模型「正文 + 工具调用」本来就是**同一条** assistant 消息，那段正文已经随 tool_calls
      // 回放过了；这里再补一条同样的文本，历史里就会出现两份答案（提示词又要求它「不要重复
      // 自己说过的话」）。所以正文与那次工具调用的正文相同时只回放一遍。
      const text = plainText(turn.parts);
      const lastRound = turn.toolRounds?.at(-1);
      if (lastRound === undefined || lastRound.content.trim() !== text.trim()) {
        messages.push({ role: "assistant", content: text });
      }
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
