import { appendFile, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../core/log.js";

/**
 * 数据文件的命名、切分与保留策略。
 *
 * 三类数据文件，全部按「东八区时间」切分，保留期默认 30 天（DATA_RETENTION_DAYS）：
 *   - forwards-YYYY-MM.jsonl     转交留档，按月切分
 *   - raw-events.<时间戳>.jsonl  调试转储，每次开启 debug 的会话一个文件
 *   - limits.YYYY-MM-DD.json     配额归档，每天一份（跨日时归档）
 *
 * 清理只在「启动时」和「每 6 小时」执行，不做定时删文件的常驻逻辑；
 * 只删除严格匹配上述模式的过期文件，绝不碰目录里的其他东西。
 */
export const RETENTION_MS_PER_DAY = 86_400_000;
const MAINTENANCE_INTERVAL_MS = 6 * 3_600_000;

/** 东八区时间。 */
function cn(date: Date): Date {
  return new Date(date.getTime() + 8 * 3_600_000);
}

/** YYYY-MM（东八区）。 */
export function monthKey(date = new Date()): string {
  return cn(date).toISOString().slice(0, 7);
}

/** YYYY-MM-DD（东八区）。 */
export function dayKey(date = new Date()): string {
  return cn(date).toISOString().slice(0, 10);
}

/** YYYYMMDD-HHmmss（东八区），用于会话级文件名。 */
export function stampKey(date = new Date()): string {
  const iso = cn(date).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

export const FILE_PATTERNS = {
  forwards: /^forwards-\d{4}-\d{2}\.jsonl$/,
  rawEvents: /^raw-events\.\d{8}-\d{6}\.jsonl$/,
  limitsArchive: /^limits\.\d{4}-\d{2}-\d{2}\.json$/,
};

export interface PruneResult {
  deleted: string[];
  freedBytes: number;
}

/** 删除目录里匹配 pattern 且「最后修改时间」超过保留期的文件。 */
export async function pruneByAge(dir: string, pattern: RegExp, maxAgeMs: number): Promise<PruneResult> {
  const result: PruneResult = { deleted: [], freedBytes: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      result.deleted.push(entry.name);
      result.freedBytes += info.size;
    } catch (err) {
      log.warn("retention", `清理 ${entry.name} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/**
 * 把旧的单文件格式（forwards.jsonl）迁移成按月切分：
 * 目标文件已存在则追加，然后删掉旧文件。只在文件存在时执行一次。
 */
export async function migrateLegacyForwards(dir: string): Promise<void> {
  const legacy = join(dir, "forwards.jsonl");
  let info;
  try {
    info = await stat(legacy);
  } catch {
    return;
  }
  if (!info.isFile()) return;

  const target = join(dir, `forwards-${monthKey(new Date(info.mtimeMs))}.jsonl`);
  try {
    const content = await readFile(legacy, "utf8");
    if (content !== "") await appendFile(target, content, "utf8");
    await unlink(legacy);
    log.info("retention", `已把 forwards.jsonl 迁移到 ${target}（${info.size} 字节）`);
  } catch (err) {
    log.warn("retention", `迁移 forwards.jsonl 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 启动时 + 每 6 小时执行一次保留策略。 */
export class Maintenance {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly retentionDays: number,
  ) {}

  async runOnce(): Promise<void> {
    const maxAgeMs = this.retentionDays * RETENTION_MS_PER_DAY;
    const results = await Promise.all([
      pruneByAge(this.dataDir, FILE_PATTERNS.forwards, maxAgeMs),
      pruneByAge(this.dataDir, FILE_PATTERNS.rawEvents, maxAgeMs),
      pruneByAge(this.dataDir, FILE_PATTERNS.limitsArchive, maxAgeMs),
    ]);
    const deleted = results.flatMap((item) => item.deleted);
    if (deleted.length > 0) {
      const freed = results.reduce((sum, item) => sum + item.freedBytes, 0);
      log.info("retention", `已清理 ${deleted.length} 个过期文件（释放 ${Math.round(freed / 1024)}KB）：${deleted.join(", ")}`);
    } else {
      log.debug("retention", `保留策略检查完成（保留 ${this.retentionDays} 天）`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), MAINTENANCE_INTERVAL_MS);
    // 不因为这个定时器而阻止进程退出
    this.timer.unref();
    log.info("retention", `数据保留 ${this.retentionDays} 天，每 6 小时清理一次`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
