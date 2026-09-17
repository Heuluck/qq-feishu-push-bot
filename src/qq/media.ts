import sharp from "sharp";
import type { InboundMessage, QuotedAttachment } from "@tencent-connect/qqbot-nodejs";
import type { Config } from "../core/config.js";
import { log } from "../core/log.js";

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

export interface PreparedImageBatch {
  images: PreparedImage[];
  /** 复用本地缓存的张数（不消耗每日额度）。 */
  cached: number;
  /** 真正下载处理的张数（要计入每日读图额度）。 */
  downloaded: number;
  /** 因为每日额度用完而主动放弃的张数。 */
  skippedForQuota: number;
}

/**
 * 处理好的图片在本进程内缓存。
 *
 * 历史里的图在每一轮都要重新交给模型（图留在它到来的那一轮，见 `src/store/history.ts`），
 * 所以同一张截图一小时内会被问很多次。没有这层缓存，每一轮都要重新下载 + 缩放，
 * 而且会把「今天读了几张图」的额度反复扣掉——用户发一张截图聊三句就没额度了。
 */
const CACHE_MAX_ITEMS = 60;
/** 缓存的总字节上限，防止大量截图把内存吃掉。 */
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const preparedCache = new Map<string, Omit<PreparedImage, "url">>();
let preparedCacheBytes = 0;

function cacheGet(key: string): Omit<PreparedImage, "url"> | undefined {
  const hit = preparedCache.get(key);
  if (hit === undefined) return undefined;
  // 命中的挪到末尾：Map 的迭代顺序就是 LRU 的淘汰顺序。
  preparedCache.delete(key);
  preparedCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, image: Omit<PreparedImage, "url">): void {
  if (image.bytes > CACHE_MAX_BYTES) return;
  const previous = preparedCache.get(key);
  if (previous !== undefined) preparedCacheBytes -= previous.bytes;
  preparedCache.set(key, image);
  preparedCacheBytes += image.bytes;
  while (preparedCache.size > CACHE_MAX_ITEMS || preparedCacheBytes > CACHE_MAX_BYTES) {
    const oldest = preparedCache.keys().next().value;
    if (oldest === undefined) break;
    preparedCacheBytes -= preparedCache.get(oldest)?.bytes ?? 0;
    preparedCache.delete(oldest);
  }
}

/** 仅供 smoke 用例复位缓存用。 */
export function clearPreparedImageCache(): void {
  preparedCache.clear();
  preparedCacheBytes = 0;
}

export interface PrepareImagesResult {
  images: PreparedImage[];
  /** 有图但没能处理的张数（下载失败/过大/超过张数上限）。 */
  skipped: number;
  /** 消息里图片总数。 */
  total: number;
  /** 其中复用本地缓存的张数。 */
  cached: number;
  /** 真正下载处理的张数。 */
  downloaded: number;
  /** 因为每日额度用完而放弃的张数。 */
  skippedForQuota: number;
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
  maxNew = Number.POSITIVE_INFINITY,
  alreadyCharged: (key: string) => boolean = () => false,
): Promise<PrepareImagesResult> {
  const imageAtts = attachments.filter(
    (att) => typeof att.content_type === "string" && att.content_type.startsWith("image/") && typeof att.url === "string",
  );
  const picked = max > 0 ? imageAtts.slice(0, max) : [];
  const prepared = await prepareImageUrls(picked.map((att) => att.url), cfg, max, maxNew, alreadyCharged);
  return {
    images: prepared.images,
    skipped: imageAtts.length - prepared.images.length,
    total: imageAtts.length,
    cached: prepared.cached,
    downloaded: prepared.downloaded,
    skippedForQuota: prepared.skippedForQuota,
  };
}

/**
 * 按 URL 准备图片。用于三类来源：当前消息的附件、被引用消息的图片、以及历史轮次里该用户的图片。
 *
 * `max` 限制这一来源最多要几张；`maxNew` 限制其中最多**新计几张额度**——缓存命中的不受它约束，
 * 这样每日额度用完之后，之前读过的图仍然能正常出现在历史里。
 * `alreadyCharged` 告诉这里「这张图今天已经计过额度」（key 是补全协议后的 URL）：那种图即使
 * 缓存已被淘汰、需要重新下载，也不占用 `maxNew` 的名额——否则额度用完后，同一张旧图会被判成
 * 「额度不足」而从历史里消失。额度本身由调用方按 `images[].url` 计（见 store/limits.ts）。
 * 处理结果按 URL 缓存，同一张图只下载一次。
 */
export async function prepareImageUrls(
  urls: string[],
  cfg: Config,
  max = cfg.IMG_MAX_COUNT,
  maxNew = Number.POSITIVE_INFINITY,
  alreadyCharged: (key: string) => boolean = () => false,
): Promise<PreparedImageBatch> {
  const images: PreparedImage[] = [];
  let cached = 0;
  let downloaded = 0;
  let skippedForQuota = 0;
  /** 本次要新计额度的张数（已经计过的不算）。 */
  let chargedNew = 0;
  for (const url of urls.slice(0, max)) {
    const key = normalizeUrl(url);
    const hit = cacheGet(key);
    if (hit !== undefined) {
      images.push({ ...hit, url });
      cached += 1;
      continue;
    }
    const charged = alreadyCharged(key);
    if (!charged && chargedNew >= maxNew) {
      skippedForQuota += 1;
      continue;
    }
    try {
      const raw = await fetchBytes(key, cfg.IMG_MAX_BYTES);
      const prepared = await resizeImageBuffer(raw, cfg);
      const meta = await sharp(prepared.data).metadata();
      const image = {
        dataUrl: `data:${prepared.mime};base64,${prepared.data.toString("base64")}`,
        width: meta.width,
        height: meta.height,
        bytes: prepared.data.byteLength,
      };
      cacheSet(key, image);
      images.push({ ...image, url });
      if (!charged) chargedNew += 1;
      downloaded += 1;
      log.debug("media", `图片已处理：${meta.width}x${meta.height}, ${prepared.data.byteLength} 字节（${prepared.mime}）`);
    } catch (err) {
      log.warn("media", `图片处理失败已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { images, cached, downloaded, skippedForQuota };
}
