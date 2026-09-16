import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { FeedbackForwarder } from "./forward.js";
import type { ToolExecutionResult } from "./llm.js";

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

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** 唯一的写操作工具：参数经 zod 校验，且有幂等与限频保护（见 forward.ts）。 */
export function createToolExecutor(
  forwarder: FeedbackForwarder,
  meta: { msgId: string; senderId: string; exemptHourlyLimit?: boolean },
): (name: string, argsJson: string) => Promise<ToolExecutionResult> {
  return async (name, argsJson) => {
    if (name !== FORWARD_FEEDBACK_TOOL.function.name) {
      return { text: `未知工具：${name}`, forwarded: false };
    }

    const parsed = ForwardFeedbackArgs.safeParse(safeParseJson(argsJson));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；");
      return { text: `参数不合法（${detail}），请修正后重试。`, forwarded: false };
    }

    const outcome = await forwarder.push({
      ...parsed.data,
      msgId: meta.msgId,
      senderId: meta.senderId,
      exemptHourlyLimit: meta.exemptHourlyLimit === true,
    });
    return { text: outcome.message, forwarded: outcome.ok };
  };
}
