import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { truncateText } from "./text.js";

/**
 * 本地对话缓冲：记录本群「用户 @ 消息」与「机器人回复」，默认保留最近 6 小时。
 *
 * 用途：平台的群聊上下文附件并不可靠（实测在部分场景下不投递），
 * 平台给了就用平台的（它还能看到非 @ 消息和图片），没给就退回这里，
 * 保证「用户接着上一轮追问」这类场景不会失忆。
 */
export interface HistoryEntry {
  at: number;
  role: "user" | "bot";
  senderName?: string;
  content: string;
}

export class History {
  private readonly byGroup = new Map<string, HistoryEntry[]>();
  private saving: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly cfg: Config) {}

  private get file(): string {
    return join(this.cfg.DATA_DIR, "history.json");
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, HistoryEntry[]>;
      let kept = 0;
      for (const [group, entries] of Object.entries(raw)) {
        const fresh = this.fresh(entries);
        if (fresh.length > 0) {
          this.byGroup.set(group, fresh);
          kept += fresh.length;
        }
      }
      if (kept > 0) log.info("history", `已载入 ${this.byGroup.size} 个群的近况（${kept} 条，窗口 ${this.cfg.HISTORY_WINDOW_MINUTES} 分钟）`);
    } catch {
      // 首次运行没有文件，正常。
    }
  }

  /** 记录一条对话（用户提问或机器人回复）。 */
  record(groupOpenid: string, entry: HistoryEntry): void {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "") return;
    const entries = [...this.fresh(this.byGroup.get(groupOpenid) ?? []), entry].slice(-this.cfg.HISTORY_MAX_ENTRIES);
    this.byGroup.set(groupOpenid, entries);
    this.scheduleSave();
  }

  /** 渲染成本轮可注入的上下文文本；不含当前这条消息。 */
  render(groupOpenid: string): string {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "") return "";
    const entries = this.fresh(this.byGroup.get(groupOpenid) ?? []);
    if (entries.length === 0) return "";

    const lines = entries.map((entry) => {
      const who = entry.role === "bot" ? "客服" : `用户${entry.senderName ?? ""}`;
      const text = truncateText(entry.content.replace(/\s+/g, " ").trim(), this.cfg.CONTEXT_MESSAGE_MAX_CHARS);
      return `[${hhmm(entry.at)}] ${who}: ${text}`;
    });

    let text = lines.join("\n");
    if (text.length > this.cfg.CONTEXT_MAX_CHARS) {
      text = `（更早的记录已省略）\n${text.slice(-this.cfg.CONTEXT_MAX_CHARS)}`;
    }
    return text;
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving;
    if (this.dirty) await this.writeEntries();
  }

  private fresh(entries: HistoryEntry[]): HistoryEntry[] {
    const cutoff = Date.now() - this.cfg.HISTORY_WINDOW_MINUTES * 60_000;
    return entries.filter((entry) => entry.at >= cutoff).slice(-this.cfg.HISTORY_MAX_ENTRIES);
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saving) return;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        await this.writeEntries();
      }
    })()
      .catch((err: unknown) => {
        log.warn("history", `对话缓冲落盘失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.saving = null;
      });
  }

  private async writeEntries(): Promise<void> {
    await mkdir(this.cfg.DATA_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.byGroup), null, 2), "utf8");
    await rename(tmp, this.file);
  }
}

/** 东八区的 HH:mm。 */
function hhmm(ts: number): string {
  const date = new Date(ts + 8 * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
