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
function normalizeUrl(url: string): string {
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
 * 等比缩放到长边不超过 cfg.IMG_MAX_EDGE（不放大），统一转 JPEG q82。
 * 只带当前消息的图片进模型：历史图片不重发，既省 token 也不破坏前缀缓存。
 */
export async function resizeImageBuffer(raw: Buffer, cfg: Config): Promise<Buffer> {
  return sharp(raw)
    .rotate()
    .resize({ width: cfg.IMG_MAX_EDGE, height: cfg.IMG_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

export async function prepareImages(attachments: InboundAttachment[], cfg: Config): Promise<PrepareImagesResult> {
  const imageAtts = attachments.filter(
    (att) => typeof att.content_type === "string" && att.content_type.startsWith("image/") && typeof att.url === "string",
  );
  const picked = cfg.IMG_MAX_COUNT > 0 ? imageAtts.slice(0, cfg.IMG_MAX_COUNT) : [];
  const images = await prepareImageUrls(picked.map((att) => att.url), cfg, cfg.IMG_MAX_COUNT);
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
      const resized = await resizeImageBuffer(raw, cfg);
      const meta = await sharp(resized).metadata();
      images.push({
        dataUrl: `data:image/jpeg;base64,${resized.toString("base64")}`,
        width: meta.width,
        height: meta.height,
        bytes: resized.byteLength,
      });
      log.debug("media", `图片已处理：${meta.width}x${meta.height}, ${resized.byteLength} 字节`);
    } catch (err) {
      log.warn("media", `图片处理失败已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return images;
}
