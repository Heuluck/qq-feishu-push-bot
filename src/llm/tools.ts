/**
 * 暴露给模型的工具：定义、参数校验，以及本轮的调用执行器。
 *
 * 目前只有一个写操作工具（转交人工）+ 一个「再单独发一条消息」的出口。
 * 工具集必须保持稳定，否则会破坏请求前缀缓存。
 */
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { FeedbackForwarder } from "../lark/forwarder.js";
import type { ToolExecutionResult } from "./messages.js";

export const ForwardFeedbackArgs = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("以「用户<昵称>」开头的概括，例如「用户Heuluck要求修改姓名」，不超过 80 字"),
  details: z
    .string()
    .trim()
    .min(1)
    .max(1500)
    .describe("转交详情：用户现象、已提供的信息、缺失的信息、引用或图片要点、知识库条目的转交说明"),
});

export type ForwardFeedbackInput = z.infer<typeof ForwardFeedbackArgs>;

export const FORWARD_FEEDBACK_TOOL: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "forward_feedback",
    description:
      "把需要人工处理的问题转交到人工反馈群。知识库标记为「需转交人工」的问题、以及知识库无法回答的问题，都必须调用它。",
    parameters: z.toJSONSchema(ForwardFeedbackArgs),
  },
};

export const SEND_FOLLOWUP_TOOL_NAME = "send_followup";

export const SendFollowupArgs = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .describe("要单独发出去的那条消息的完整内容。用户会直接看到，不要写「知识库」「条目」这类内部词"),
});

export type SendFollowupInput = z.infer<typeof SendFollowupArgs>;

/**
 * 在主的回复之外再单独给用户发一条消息。
 *
 * 为什么需要它：一条消息里往往有**两件性质不同的事**——知识库里能直接答的内容，
 * 和「已转给负责的同学」这类跟进说明。实测模型在转交时会只顾后者，把答案写进那份
 * 给处理人员看的 details 里（用户看不到），于是用户看不到任何答复。
 * 给它一个「可以再单独说一句」的出口，比要求它把两件事挤进一句更符合它的表达习惯。
 *
 * 每轮最多一条，且在**代码层**拦死（见 createTurnTools）：提示词层面说明限制，
 * 第二次调用不会发出任何东西。
 */
export const SEND_FOLLOWUP_TOOL: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: SEND_FOLLOWUP_TOOL_NAME,
    description:
      "在你的主回复之外，再单独给用户发一条消息。每轮对话最多调用一次。" +
      "用于把两件事分开说清楚，例如主回复把知识库里的答案答完整，再用它单独说一句「已转给负责的同学」。",
    parameters: z.toJSONSchema(SendFollowupArgs),
  },
};

/**
 * 暴露给模型的工具定义。个数与内容必须稳定，否则会破坏请求前缀缓存。
 *
 * `SEND_FOLLOWUP_TOOL` 是「模型想多发一条消息」的出口：正文之外再排一条，由 `qq/bot.ts`
 * 在正文之后发出。一次调用完成的流程下它不是必需的（实测只有 1/10 会用到），留着是因为
 * 「想分开说两件事」是真实需求，而平台允许同一 `msg_id` 最多发 5 条（见 MAX_PASSIVE_REPLIES）。
 */
export const EXPOSED_TOOLS: ChatCompletionFunctionTool[] = [FORWARD_FEEDBACK_TOOL, SEND_FOLLOWUP_TOOL];

export interface TurnTools {
  exec: (name: string, argsJson: string) => Promise<ToolExecutionResult>;
  /**
   * 本轮模型要求单独发出的补充消息，按调用顺序（代码层已保证最多一条）。
   * 由调用方在主回复**之后**发出去。
   */
  followups: string[];
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；");
}

/**
 * 本轮的工具集：一个写操作工具（转交人工）+ 一个「再发一条消息」的出口。
 *
 * `followups` 是**每轮一份**的可变状态，所以这个工厂必须每轮调用一次。
 * 「每轮最多一条」在这里拦：第二次调用直接返回拒绝说明，不发出任何东西。
 */
export function createTurnTools(
  forwarder: FeedbackForwarder,
  meta: { msgId: string; senderId: string; exemptHourlyLimit?: boolean },
): TurnTools {
  const followups: string[] = [];

  const exec = async (name: string, argsJson: string): Promise<ToolExecutionResult> => {
    if (name === SEND_FOLLOWUP_TOOL_NAME) {
      if (followups.length > 0) {
        return {
          text: "本轮已经用过 send_followup 了（每轮最多一条），这条**没有发出**。请把剩下的内容写进你的主回复里。",
          forwarded: false,
        };
      }
      const parsed = SendFollowupArgs.safeParse(safeParseJson(argsJson));
      if (!parsed.success) {
        return { text: `补充消息参数不合法（${issueText(parsed.error)}），没有发出，请修正后重试。`, forwarded: false };
      }
      followups.push(parsed.data.message);
      return { text: "补充消息已记下，会在你这条主回复之后单独发出去。", forwarded: false };
    }

    if (name !== FORWARD_FEEDBACK_TOOL.function.name) {
      return { text: `未知工具：${name}`, forwarded: false };
    }

    const parsed = ForwardFeedbackArgs.safeParse(safeParseJson(argsJson));
    if (!parsed.success) {
      return { text: `参数不合法（${issueText(parsed.error)}），请修正后重试。`, forwarded: false };
    }

    const outcome = await forwarder.push({
      ...parsed.data,
      msgId: meta.msgId,
      senderId: meta.senderId,
      exemptHourlyLimit: meta.exemptHourlyLimit === true,
    });
    return { text: outcome.message, forwarded: outcome.ok };
  };

  return { exec, followups };
}
