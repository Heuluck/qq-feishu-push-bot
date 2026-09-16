import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { truncateText } from "./text.js";

/**
 * 本地对话缓冲：记录本群「用户 @ 消息」与「机器人回复」，默认保留最近 6 小时。
 *
 * 用途：平台的群聊上下文附件并不可靠（实测在部分场景下不投递，纯 @ 消息根本不带），
 * 平台给了就用平台的（它还能看到非 @ 消息和图片），没给就退回这里，
 * 保证「用户接着上一轮追问」这类场景不会失忆。
 */
export interface HistoryEntry {
  at: number;
  role: "user" | "bot";
  /** 用户 openid（机器人自己的记录没有）。用于「只取同一个用户发的图」。 */
  senderId?: string;
  senderName?: string;
  content: string;
  /** 这条消息带的图片 URL（用来支持「用户先发截图、再 @ 提问」）。 */
  imageUrls?: string[];
  /**
   * 这些图已经被喂给模型的时间。
   *
   * 「已经答复过的图不再重复注入」是必须的：模型看过那张图并答复之后，后续每一轮
   * 再带上它，模型就会把旧截图当成当前消息的新证据。实测踩过——用户已经说「已经改好了」，
   * 模型手里还挂着 25 分钟前那张崩溃截图，于是回了「看你发的截图还是会弹严重错误崩溃」
   * 并误转交了一次人工。
   */
  imagesAnsweredAt?: number;
}

/** 缓冲里待注入的一张图，附带它在该群出现的时间。 */
export interface PendingImage {
  url: string;
  /** 这张图在该群出现的时间戳（给提示词标注「什么时候发的」用）。 */
  at: number;
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
      if (kept > 0) {
        log.info(
          "history",
          `已载入 ${this.byGroup.size} 个群的近况（${kept} 条，存储窗口 ${this.cfg.HISTORY_WINDOW_MINUTES} 分钟，最多存 ${this.cfg.HISTORY_MAX_STORED} 条；` +
            `注入最近 ${this.cfg.HISTORY_INJECT_MINUTES} 分钟内 ${this.cfg.HISTORY_MAX_ENTRIES} 条）`,
        );
      }
    } catch {
      // 首次运行没有文件，正常。
    }
  }

  /** 记录一条对话（用户提问或机器人回复）。 */
  record(groupOpenid: string, entry: HistoryEntry): void {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "") return;
    const entries = [...this.fresh(this.byGroup.get(groupOpenid) ?? []), entry].slice(-this.cfg.HISTORY_MAX_STORED);
    this.byGroup.set(groupOpenid, entries);
    this.scheduleSave();
  }

  /**
   * 该用户发过、**还没喂给过模型**的图，最新的优先。
   *
   * 用途：「用户先发一张报错截图、再 @ 机器人问一句」是最常见的用法，
   * 而截图那条消息没 @ 机器人，只进了缓冲——不把图抓下来，模型就只能说"看不清内容"。
   * 只取**同一个用户**发的图：群里其他人的截图与当前问题无关，带上既费 token 又可能干扰判断。
   * 不按「最近 N 条消息」找，而是按「该用户最近的图」找——用户连发几张截图后，中间很可能插入别人的消息，
   * 按消息条数回看会把这些图挤出去（实测踩过：截图 5 条消息之前，于是一张都没带上）。
   *
   * 两道时效限制，缺一个都会出问题（见 `HistoryEntry.imagesAnsweredAt` 与
   * `IMG_CONTEXT_MAX_AGE_MINUTES` 的注释）：已经答复过的不再给，超过
   * `IMG_CONTEXT_MAX_AGE_MINUTES` 分钟的也不再给。
   */
  pendingImages(
    groupOpenid: string,
    senderId: string,
    maxImages = this.cfg.IMG_CONTEXT_MAX_COUNT,
    maxAgeMinutes = this.cfg.IMG_CONTEXT_MAX_AGE_MINUTES,
  ): PendingImage[] {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "" || senderId === "" || maxImages <= 0) return [];
    const cutoff = Date.now() - maxAgeMinutes * 60_000;
    const pending: PendingImage[] = [];
    const seen = new Set<string>();
    for (const entry of [...this.fresh(this.byGroup.get(groupOpenid) ?? [])].reverse()) {
      if (entry.senderId !== senderId) continue;
      // 这一条里的图已经喂过了（模型看过并答复过）→ 整条跳过，不要再当成新截图。
      if (entry.imagesAnsweredAt !== undefined) continue;
      if (entry.at < cutoff) continue;
      for (const url of entry.imageUrls ?? []) {
        if (seen.has(url)) continue;
        seen.add(url);
        pending.push({ url, at: entry.at });
        if (pending.length >= maxImages) return pending;
      }
    }
    return pending;
  }

  /**
   * 记下「这些图已经喂给模型了」，之后不再重复注入。
   *
   * 由调用方在**真正喂成功之后**调用（下载失败的不标记，下次还能重试）。
   * 既覆盖从缓冲里翻出来的图，也覆盖当前消息自带的图——后者这一轮就已经被答复，
   * 下一轮再当新证据就是灾难。
   */
  markImagesAnswered(groupOpenid: string, urls: string[]): void {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "" || urls.length === 0) return;
    const wanted = new Set(urls);
    const entries = this.byGroup.get(groupOpenid);
    if (entries === undefined) return;
    const now = Date.now();
    let changed = false;
    for (const entry of entries) {
      if (entry.imagesAnsweredAt !== undefined) continue;
      if (!(entry.imageUrls ?? []).some((url) => wanted.has(url))) continue;
      entry.imagesAnsweredAt = now;
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  /** 渲染成本轮可注入的上下文文本；不含当前这条消息。 */
  render(groupOpenid: string): string {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "") return "";
    const entries = this.injectable(groupOpenid).slice(-this.cfg.HISTORY_MAX_ENTRIES);
    if (entries.length === 0) return "";
    return this.lines(entries);
  }

  /**
   * 机器人自己最近的回复，用于和平台上下文合并。
   *
   * 平台的上下文附件覆盖不到机器人自己说过的话（纯 @ 消息根本不带附件），
   * 缺了它就会出现「上一轮已经答过、这一轮又从头答一遍」。所以用平台上下文时把它补在后面。
   * `alreadyVisible` 传平台文本，已经写在里面的话不再重复。
   */
  recentBotReplies(groupOpenid: string, alreadyVisible: string): string[] {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "") return [];
    return this.injectable(groupOpenid)
      .filter((entry) => entry.role === "bot")
      .slice(-this.cfg.HISTORY_MAX_ENTRIES)
      .filter((entry) => entry.content.trim() !== "" && !alreadyVisible.includes(entry.content.trim()))
      .map((entry) => this.line(entry));
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving;
    if (this.dirty) await this.writeEntries();
  }

  /** 本轮可注入的条目：先按存储窗口瘦身，再收窄到「注入回看多少分钟」。 */
  private injectable(groupOpenid: string): HistoryEntry[] {
    const cutoff = Date.now() - this.cfg.HISTORY_INJECT_MINUTES * 60_000;
    return this.fresh(this.byGroup.get(groupOpenid) ?? []).filter((entry) => entry.at >= cutoff);
  }

  private line(entry: HistoryEntry): string {
    const who = entry.role === "bot" ? "客服" : `用户${entry.senderName ?? ""}`;
    const text = truncateText(entry.content.replace(/\s+/g, " ").trim(), this.cfg.CONTEXT_MESSAGE_MAX_CHARS);
    return `[${hhmm(entry.at)}] ${who}: ${text}`;
  }

  private lines(entries: HistoryEntry[]): string {
    let text = entries.map((entry) => this.line(entry)).join("\n");
    if (text.length > this.cfg.CONTEXT_MAX_CHARS) {
      text = `（更早的记录已省略）\n${text.slice(-this.cfg.CONTEXT_MAX_CHARS)}`;
    }
    return text;
  }

  /** 按时间窗过滤，并按「存储上限」截取最新的一批；注入时再收窄到 HISTORY_MAX_ENTRIES。 */
  private fresh(entries: HistoryEntry[]): HistoryEntry[] {
    const cutoff = Date.now() - this.cfg.HISTORY_WINDOW_MINUTES * 60_000;
    return entries.filter((entry) => entry.at >= cutoff).slice(-this.cfg.HISTORY_MAX_STORED);
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

/** 东八区的 HH:mm（缓冲行与「这张图什么时候发的」标注共用）。 */
export function hhmm(ts: number): string {
  const date = new Date(ts + 8 * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
