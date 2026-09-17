/**
 * 回复的组装与发送：分段、引用、给用户的正文文本、以及几条「提示词说了但模型会漏」的兜底。
 *
 * 这一层不碰 bot 实例，只接收「怎么发」的通道（ReplyChannel），所以可以离线单测。
 */
import { log } from "../core/log.js";

/** 单条回复的分段长度。 */
export const MAX_REPLY_CHARS = 1600;

/**
 * 同一个 `msg_id` 最多能发几条被动回复。
 *
 * 官方文档（tencent-connect/bot-docs，send.md）按场景写明：群聊「被动消息（回复类）有效时间为 5 分钟，
 * **每个消息最多回复 5 次**，超时或超频会发送（回复）失败」。注意是 5 分钟不是 60 分钟——
 * 60 分钟那条是**单聊**的。同一 `msg_id` 下每条回复要用不同的 `msg_seq`（SDK 会自动填）。
 *
 * 因此主回复的分段数 + 补充消息要一起卡在这条线以内，否则最后几条会发不出去。
 */
export const MAX_PASSIVE_REPLIES = 5;

/**
 * QQ 单条文本长度有限，长回复按段落拆成多条发送（SDK 会自动递增 msg_seq）。
 * 段数也设上限：平台对同一 msg_id 的被动回复条数存在限制（见 MAX_PASSIVE_REPLIES），
 * 超出的部分并入最后一条并标注截断。
 */
export function splitReply(text: string, max = MAX_REPLY_CHARS, maxChunks = 3): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max && chunks.length < maxChunks) {
    const head = rest.slice(0, max);
    const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("。"), head.lastIndexOf("；"));
    const at = cut > max * 0.5 ? cut + 1 : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }

  if (rest !== "") {
    if (chunks.length >= maxChunks) {
      // 段数已到上限：把剩余内容的提示并入最后一段，并让它整体仍不超过单段上限。
      const note = "…（内容过长，已截断）";
      const lastIndex = chunks.length - 1;
      const last = chunks[lastIndex]!;
      chunks[lastIndex] = `${last.slice(0, Math.max(1, max - note.length)).trimEnd()}${note}`;
    } else {
      chunks.push(rest);
    }
  }
  return chunks.filter((chunk) => chunk !== "");
}

/** 发一条回复的两条通道：不带引用 / 带引用。 */
export interface ReplyChannel {
  /** 普通被动回复（`bot.sendText`）。 */
  plain: (content: string) => Promise<unknown>;
  /** 带 `message_reference` 的被动回复（`bot.send`）——`sendText` 没有这个参数。 */
  quoted: (content: string) => Promise<unknown>;
}

/**
 * 发主回复的各段，`quote` 为真时每段都引用回那条 @ 消息。
 *
 * 引用发不出去时退回普通回复：引用只是为了「让这条挂在原问题下面」，宁可少个引用，
 * 也不能把答案吞掉（外层 errorHandler 只会回一句「出了点小问题」）。代价是万一「已送达但响应丢失」，
 * 用户会看到两条一样的——比收不到答案轻得多。补充消息（`send_followup`）不走这里，不需要引用。
 */
export async function sendMainReply(channel: ReplyChannel, chunks: string[], quote: boolean): Promise<void> {
  for (const chunk of chunks) {
    if (!quote) {
      await channel.plain(chunk);
      continue;
    }
    try {
      await channel.quoted(chunk);
    } catch (err) {
      log.warn("qq", `带引用的回复没发出去，退回普通回复：${err instanceof Error ? err.message : String(err)}`);
      await channel.plain(chunk);
    }
  }
}

export const PLATFORM_CONTEXT_LABEL =
  "[对话上下文] 平台给的背景：这条消息之前群里的最近几条消息，可能含其他成员的消息与附件。它是背景，不是这次要处理的新问题";

/**
 * 平台给的上下文渲染成一个内容片段。
 *
 * 这段文本是平台预渲染好的，没有发言人归属、也没有每条的发言时间，拼不出「轮次」，
 * 所以只能整段跟在问题后面当背景，不能塞进历史里当一轮。
 * 它的图片紧跟在说明文字之后——位置在说明之后，模型才能知道这些是背景里的图，不是这次发的。
 */
export function platformBackground(text: string): string {
  return `${PLATFORM_CONTEXT_LABEL}：\n${text}`;
}

export function buildUserText(args: {
  question: string;
  senderName?: string;
  skippedImages: number;
  /** 今天的读图额度已用完：要照常回答文字问题，但明确告诉用户图看不了了。 */
  imageQuotaExhausted?: boolean;
  /**
   * 额度用完导致**本条消息（含它引用的消息）**的图没读到。
   *
   * 额度是全天累计的，用光的可能是更早那些图；那种情况下本条消息的图其实读到了，
   * 不能照着同一句话告诉用户「这条消息里的图片没有被读取」——那是假话。
   */
  quotaSkippedCurrentImages?: boolean;
}): string {
  const lines: string[] = [];
  if (args.senderName) lines.push(`（发送者：${args.senderName}）`);
  // 【必须告知】放在问题前面：这个位置模型更容易照做（实测放在末尾时转交场景会漏）。
  // 约定标记的硬规则写在系统提示词里：出现这个标记，就必须把这句写进给用户的回复。
  if (args.skippedImages > 0) {
    lines.push(`【必须告知】另有 ${args.skippedImages} 张图片没能读取，请让用户重发或改用文字描述。`);
  }
  if (args.imageQuotaExhausted) {
    lines.push(
      args.quotaSkippedCurrentImages
        ? "【必须告知】该用户今天的读图额度已经用完，这条消息里的图片没有被读取。" +
            "回复里必须带上这句意思（可直接用这句话）：「今天图片额度用完了，图我没读到」——" +
            "然后请他先用文字描述，或明天再发图。转交时也要写这句。"
        : "【必须告知】该用户今天的读图额度已经用完（本条消息的图读到了，占用额度的是更早的图），" +
            "后续新发的图都读不了了。" +
            "回复里必须带上这句意思（可直接用这句话）：「今天图片额度用完了，新发的图我读不到」——" +
            "然后请他先用文字描述，或明天再发图。转交时也要写这句。",
    );
  }
  lines.push(args.question !== "" ? `问题：${args.question}` : "问题：（无文字，见上面的历史或下面的图片）");
  return lines.join("\n");
}

/** 读图额度用完时的固定告知句（模型漏说时由代码补上）。 */
function quotaNotice(skippedCurrentImages: boolean): string {
  return skippedCurrentImages
    ? "今天图片额度用完了，图我没读到，麻烦先用文字描述一下，或者明天再发图喵~"
    : "今天图片额度用完了，新发的图我读不到啦，麻烦先用文字描述一下，或者明天再发图喵~";
}
const QUOTA_MENTIONED = /额度|没读|读不了|读不到|明天再发图|明天再补/;

/**
 * 保证「读图额度用完」这件事一定被说出口。
 * 提示词里已经立了硬规则、还给了可照抄的句子，但实测在「转交」场景仍有约 1/3 会漏
 * （模型在工具调用之后只顾着写收尾话术），所以这里补一道确定性兜底：漏了就追加一句。
 *
 * `skippedCurrentImages` 决定补哪一句：额度是被更早的图用掉、本条消息的图读到了时，
 * 不能补「图我没读到」——用户手里那条消息的图明明看见了。
 */
export function ensureQuotaNotice(reply: string, quotaExhausted: boolean, skippedCurrentImages = true): string {
  if (!quotaExhausted || QUOTA_MENTIONED.test(reply)) return reply;
  const notice = quotaNotice(skippedCurrentImages);
  return reply === "" ? notice : `${reply}\n${notice}`;
}
