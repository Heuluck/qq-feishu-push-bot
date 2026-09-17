/**
 * 平台会把"最近 N 条消息"预渲染成一段文本，塞在 msg_elements[0].content 里，
 * 由 SDK 的 quoteRef 中间件解析成 ctx.state.quote.text。格式形如：
 *
 *   === 消息 1 ===
 *   [消息内容] 我要退款旺仔牛奶
 *   === 消息 2 ===
 *   [附件1] 类型:图片 文件名:xxx.png 尺寸:872x544 大小:292.6KB URL:https://multimedia.nt.qq.com.cn/download?...
 *
 * 处理三件事：
 *   1. 图片只以 URL 形式出现，模型既看不到也访问不了 → 抠出来交给图片处理链路下载；
 *   2. URL 本身又长又没用 → 从文本里去掉，只留文件名/尺寸等元数据；
 *   3. 上下文里的单条消息、以及整段上下文都可能超长（有人粘贴大段日志时会很离谱）
 *      → 单条按上限截断，整段超出则以保留最新消息为优先从头部裁掉。
 */
import { stripMentions, truncateText } from "../core/text.js";

export interface ContextLimits {
  /** 整段上下文最多保留多少字符。 */
  maxChars: number;
  /** 单条消息最多保留多少字符。 */
  maxPerMessage: number;
}

export interface ContextResult {
  /** 可直接进 prompt 的上下文文本（已去掉附件 URL、已按需截断）。 */
  text: string;
  /** 上下文里出现的图片 URL。 */
  imageUrls: string[];
  /** 是否发生了截断（单条或整段）。 */
  truncated: boolean;
}

const ATTACHMENT_LINE = /\[附件\d+\][^\n]*/g;
const IMAGE_URL = /URL:(https?:\/\/\S+)/;
const MESSAGE_HEADER = /^=== 消息 \d+ ===$/;
/** 在整段文本里找消息开头（上面的那个逐行判断用，没有 /m）。 */
const MESSAGE_HEADER_LINE = /^=== 消息 \d+ ===$/m;

/** 按上限截断上下文里的单条消息，避免一条超长粘贴挤掉其他消息。 */
function truncatePerMessage(text: string, maxPerMessage: number): { text: string; truncated: boolean } {
  if (maxPerMessage <= 0) return { text, truncated: false };
  let truncated = false;
  const blocks = text.split(/(?=^=== 消息 \d+ ===$)/m).map((block) => {
    if (block.length <= maxPerMessage) return block;
    const lines = block.split("\n");
    if (!MESSAGE_HEADER.test(lines[0] ?? "")) return block;
    const header = lines[0]!;
    const body = lines.slice(1).join("\n");
    if (body.length <= maxPerMessage) return block;
    truncated = true;
    return `${header}\n${truncateText(body, maxPerMessage, "…（本条过长，已截断）")}`;
  });
  return { text: blocks.join(""), truncated };
}

export function splitContextAttachments(rawText: string, limits?: ContextLimits): ContextResult {
  const imageUrls: string[] = [];
  let text = rawText
    .replace(ATTACHMENT_LINE, (line) => {
      if (!line.includes("类型:图片")) return line;
      const url = IMAGE_URL.exec(line)?.[1];
      if (!url) return line;
      imageUrls.push(url);
      // 保留文件名/尺寸等元数据，去掉超长的 URL。
      return line.replace(IMAGE_URL, "URL:(已作为图片附上)");
    })
    .trim();

  let truncated = false;
  // 上下文里同样可能带 @ 标记（平台渲染的历史消息），去掉后再进 prompt。
  text = stripMentions(text);
  if (limits && limits.maxPerMessage > 0) {
    const perMessage = truncatePerMessage(text, limits.maxPerMessage);
    text = perMessage.text;
    truncated = perMessage.truncated;
  }

  // 消息按时间从旧到新排列，超长时保留最新的部分。
  if (limits && limits.maxChars > 0 && text.length > limits.maxChars) {
    const tail = text.slice(-limits.maxChars);
    // 直接切字符串会从半条消息（甚至某个附件行）中间开始。平台这段是按消息渲染的，
    // 所以往前挪到下一条消息的开头，让模型从一条完整消息开始看。
    const nextHeader = tail.search(MESSAGE_HEADER_LINE);
    text = `（较早的上下文已省略）\n${nextHeader > 0 ? tail.slice(nextHeader) : tail}`;
    truncated = true;
  }

  return { text, imageUrls, truncated };
}
