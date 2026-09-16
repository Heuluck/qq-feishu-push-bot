import sharp from "sharp";
import type { InboundMessage, QuotedAttachment } from "@tencent-connect/qqbot-nodejs";
import type { Config } from "./config.js";
import { log } from "./log.js";

/** SDK 没有从根导出附件类型，这里从入站消息上推导，避免深引内部路径。 */
export type InboundAttachment = NonNullable<InboundMessage["attachments"]>[number];

/**
 * 取出被引用消息里的图片 URL。
 *
 * 引用消息的图片是「结构化附件」（msg_elements[0].attachments，由 SDK 的 quoteRef 解析到
 * quote.attachments），平台不会把它渲染进上下文文本，所以必须单独读；
 * 否则「引用一张图问这是什么」时模型只能看到一个 [图片] 占位符。
 */
export function quotedImageUrls(attachments: QuotedAttachment[] | undefined): string[] {
  return (attachments ?? [])
    .filter((att) => typeof att.contentType === "string" && att.contentType.startsWith("image/") && Boolean(att.url))
    .map((att) => att.url);
}

export interface PreparedImage {
  dataUrl: string;
  /** 来源 URL（原始形态，未补协议）。调用方靠它回溯这张图是从哪儿来的。 */
  url: string;
  width?: number;
  height?: number;
  bytes: number;
}

export interface PrepareImagesResult {
  images: PreparedImage[];
  /** 有图但没能处理的张数（下载失败/过大/超过张数上限）。 */
  skipped: number;
  /** 消息里图片总数。 */
  total: number;
}

const FETCH_TIMEOUT_MS = 15_000;

/** QQ 返回的附件 URL 偶尔缺少协议前缀。 */
export function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

async function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`图片过大（${declared} 字节）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`图片过大（${buf.byteLength} 字节）`);
  return buf;
}

/**
 * 图片预处理：只在超过长边上限时才缩放，并且**PNG 型图片原样透传**。
 *
 * 依据（DeepSeek 视觉文档）：每张图 token 上限 1024，超过约 1300×1300 总像素后一律按上限计费，
 * 所以"传小一点"省不下钱（单图最多约 0.002 元），反而会把截图里的文字糊掉。
 * 客服场景里几乎都是带文字的截图，因此优先保清晰度：
 *   - 未超上限的 PNG → 不重新编码（重新编码成 JPEG 会把小字糊掉）；
 *   - 需要缩放或本就是 JPEG → 缩放后按 q90 编码（比原来的 q82 更清晰，token 不受影响）。
 */
export interface PreparedBuffer {
  data: Buffer;
  mime: "image/png" | "image/jpeg";
}

export async function resizeImageBuffer(raw: Buffer, cfg: Config): Promise<PreparedBuffer> {
  const meta = await sharp(raw).metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (meta.format === "png" && longEdge > 0 && longEdge <= cfg.IMG_MAX_EDGE) {
    return { data: raw, mime: "image/png" };
  }

  const data = await sharp(raw)
    .rotate()
    .resize({ width: cfg.IMG_MAX_EDGE, height: cfg.IMG_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { data, mime: "image/jpeg" };
}

export async function prepareImages(
  attachments: InboundAttachment[],
  cfg: Config,
  max = cfg.IMG_MAX_COUNT,
): Promise<PrepareImagesResult> {
  const imageAtts = attachments.filter(
    (att) => typeof att.content_type === "string" && att.content_type.startsWith("image/") && typeof att.url === "string",
  );
  const picked = max > 0 ? imageAtts.slice(0, max) : [];
  const images = await prepareImageUrls(picked.map((att) => att.url), cfg, max);
  return { images, skipped: imageAtts.length - images.length, total: imageAtts.length };
}

/**
 * 按 URL 下载并缩放图片。用于两类来源：当前消息的附件，以及上下文文本里
 * 抠出来的图片（上下文里的图只有 URL，模型看不见，必须抓下来喂进去）。
 * 超出 max 张数的 URL 计为跳过。
 */
export async function prepareImageUrls(urls: string[], cfg: Config, max = cfg.IMG_MAX_COUNT): Promise<PreparedImage[]> {
  const images: PreparedImage[] = [];
  for (const url of urls.slice(0, max)) {
    try {
      const raw = await fetchBytes(normalizeUrl(url), cfg.IMG_MAX_BYTES);
      const prepared = await resizeImageBuffer(raw, cfg);
      const meta = await sharp(prepared.data).metadata();
      images.push({
        dataUrl: `data:${prepared.mime};base64,${prepared.data.toString("base64")}`,
        url,
        width: meta.width,
        height: meta.height,
        bytes: prepared.data.byteLength,
      });
      log.debug("media", `图片已处理：${meta.width}x${meta.height}, ${prepared.data.byteLength} 字节（${prepared.mime}）`);
    } catch (err) {
      log.warn("media", `图片处理失败已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return images;
}
