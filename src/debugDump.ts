import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";
import { stampKey } from "./retention.js";

/**
 * 诊断用：把平台推送的原始事件落到 data/raw-events.<时间戳>.jsonl。
 * 只在 LOG_LEVEL=debug 时启用，用来确认某个群设置下平台究竟投递了什么。
 *
 * 每次开启 debug 的会话一个新文件（旧的会被改名归档），单个会话最多 500 条，
 * 文件本身的保留期由 retention 模块统一处理（默认 30 天）。
 */
const MAX_RECORDS = 500;

let enabled = false;
let count = 0;
let dir = "data";
let currentFile = "";

export async function initRawDump(dataDir: string, on: boolean): Promise<void> {
  dir = dataDir;
  // 无论是否开启调试，都先把旧版固定文件名的转储归档，让它进入统一的保留策略。
  await archivePreviousSession(join(dir, "raw-events.jsonl"));

  enabled = on;
  if (!on) return;
  currentFile = join(dir, `raw-events.${stampKey()}.jsonl`);
  log.warn("debug", `原始事件转储已开启：${currentFile}（本次会话最多 ${MAX_RECORDS} 条）`);
}

/** 把上一版固定文件名的转储改名成带时间戳的归档，避免多次调试累积在一个文件里。 */
async function archivePreviousSession(legacyPath: string): Promise<void> {
  try {
    const info = await stat(legacyPath);
    if (!info.isFile() || info.size === 0) return;
    const archived = join(dir, `raw-events.${stampKey(new Date(info.mtimeMs))}.jsonl`);
    await rename(legacyPath, archived);
    log.info("debug", `上次的转储已归档为 ${archived}`);
  } catch {
    // 文件不存在，正常。
  }
}

export function dumpRawEvent(kind: string, payload: unknown): void {
  if (!enabled) return;
  if (count >= MAX_RECORDS) {
    if (count === MAX_RECORDS) {
      count += 1;
      log.warn("debug", `原始事件转储已达本次会话上限 ${MAX_RECORDS} 条，后续事件不再记录（重启可重新开始）`);
    }
    return;
  }
  count += 1;
  const line = `${JSON.stringify({ at: new Date().toISOString(), seq: count, kind, payload })}\n`;
  void (async () => {
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(currentFile, line, "utf8");
    } catch (err) {
      log.warn("debug", `原始事件转储失败：${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
