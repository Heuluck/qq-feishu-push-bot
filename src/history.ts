import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { truncateText } from "./text.js";

/**
 * 本地对话缓冲：记录本群「用户 @ 消息」「机器人回复」，以及在平台投递全量消息时的普通消息。
 *
 * 用途：平台的群聊上下文附件并不可靠（实测在部分场景下不投递，纯 @ 消息根本不带）。
 * 这份缓冲被渲染成**多轮 messages 的历史部分**，是上下文的主要来源。
 *
 * 为什么是多轮 messages，而不是把历史拼成一段文本塞进当前那条 user 消息：
 *
 *   1. **图片必须待在它到来时的那一轮。** 拼成一段文本时，翻出来的旧截图只能作为「当前这条
 *      消息」的附件交给模型，模型没有依据区分新旧——实测它把 25 分钟前的崩溃截图当成这次的
 *      新证据，回了「看你发的截图还是会弹严重错误崩溃」，并因此误转交了一次人工。
 *      Anthropic 的 vision 文档给的就是这个模型：图留在原始轮次，模型能看到历史里的所有图，
 *      但不要在新增的那一轮里重复贴。
 *   2. **历史成为请求前缀的一部分**，可以命中厂商的前缀缓存，只有最新那一轮按原价计费。
 *      「把历史里的图删掉」看着省 token，实际会让缓存从改动点起整段失效——OpenAI 与 Anthropic
 *      的缓存文档都明确写了这一点，删一张图远不够抵消这个代价。
 */
export interface HistoryEntry {
  at: number;
  role: "user" | "bot";
  /** 用户 openid（机器人自己的记录没有）。用于按提问者挑图与区分发言人。 */
  senderId?: string;
  senderName?: string;
  content: string;
  /** 这条消息带的图片 URL，渲染时挂在**这一轮**上。 */
  imageUrls?: string[];
}

/** 渲染给模型的一轮。 */
export interface HistoryTurn {
  role: "user" | "bot";
  /** 该轮要喂的图片 URL（原始形态，由调用方下载）。 */
  images: string[];
  /** 已渲染好的文本：user 轮形如 `[15:08] Luck: 我也有这个问题`，bot 轮只有时间戳。 */
  text: string;
}

export interface RenderedHistory {
  turns: HistoryTurn[];
  /** 因为条数或字符预算被丢掉的轮数（日志用）。 */
  dropped: number;
}

/** 渲染历史时需要的当前提问者信息。 */
export interface RenderOptions {
  /** 当前提问者的 openid：只为他挑图，别人发的图与当前问题无关。 */
  speakerId?: string;
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
            `会话窗口 ${this.cfg.HISTORY_INJECT_MINUTES} 分钟内 ${this.cfg.HISTORY_MAX_ENTRIES} 轮）`,
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
   * 渲染成本轮的历史轮次（不含当前这条消息）。
   *
   * 图只挑**当前提问者**发过的：群里别人的截图与当前问题无关，带上既费 token 又可能干扰判断。
   * 不按「最近 N 条消息」找图，而是按「该用户最近的图」找——用户连发几张截图后中间常会插入
   * 别人的消息，按消息条数回看会把图挤出去（实测踩过）。挑中的图挂在**它到来的那一轮**上。
   */
  render(groupOpenid: string, options: RenderOptions = {}): RenderedHistory {
    if (!this.cfg.HISTORY_ENABLED || groupOpenid === "") return { turns: [], dropped: 0 };
    const entries = this.injectable(groupOpenid);
    const windowed = entries.slice(-this.cfg.HISTORY_MAX_ENTRIES);
    const picked = pickImages(windowed, options.speakerId, this.cfg.IMG_CONTEXT_MAX_COUNT);

    const turns: HistoryTurn[] = windowed.map((entry) => {
      const images = (entry.imageUrls ?? []).filter((url) => picked.has(url));
      const text = line(entry, this.cfg.CONTEXT_MESSAGE_MAX_CHARS);
      // 带图的轮次后面加一个图注，作为这张图在本会话里的**名字**：
      // Anthropic 的 vision 文档要求在多轮里给每张图一个短标签，否则后续轮次没法按名字引用它
      // （实测问「第 1 张、第 2 张分别是什么颜色」会答错——模型没有「第几张」的概念）。
      // 用该轮的时间而不是序号：时间不随窗口滑动而变，序号会。
      const label = images.length === 0 ? "" : ` ［图：${hhmm(entry.at)}${images.length > 1 ? `（共 ${images.length} 张）` : ""}］`;
      return { role: entry.role, images, text: `${text}${label}` };
    });

    // 字符预算：从最新往前留，超了就**整轮**丢掉。
    // 不能像切字符串那样从中间切——切开会让「回答」和它的「提问」分家，模型会看到一个没有前因的答复。
    const kept: HistoryTurn[] = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i]!;
      if (kept.length > 0 && used + turn.text.length > this.cfg.CONTEXT_MAX_CHARS) break;
      used += turn.text.length;
      kept.unshift(turn);
    }

    return { turns: kept, dropped: entries.length - kept.length };
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving;
    if (this.dirty) await this.writeEntries();
  }

  /**
   * 本会话里可以用上的条目。
   *
   * 会话边界就是「闲置」：超过 `HISTORY_INJECT_MINUTES` 分钟没说话就当作新会话——
   * 这是各家对话平台的通行约定（Dialogflow CX 默认 30 分钟、Rasa 60 分钟、Amazon Lex 5 分钟）。
   * 存储窗口另有 6 小时，是为了留下记录，不是为了喂给模型：太旧的话题已经翻篇，喂进去只会串台。
   */
  private injectable(groupOpenid: string): HistoryEntry[] {
    const cutoff = Date.now() - this.cfg.HISTORY_INJECT_MINUTES * 60_000;
    return this.fresh(this.byGroup.get(groupOpenid) ?? []).filter((entry) => entry.at >= cutoff);
  }

  /** 按时间窗过滤，并按「存储上限」截取最新的一批。 */
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

/** 挑出本轮要喂的图片 URL：只取当前提问者的，最新的优先，最多 `max` 张。 */
function pickImages(entries: HistoryEntry[], speakerId: string | undefined, max: number): Set<string> {
  const picked = new Set<string>();
  if (!speakerId || max <= 0) return picked;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.senderId !== speakerId) continue;
    for (const url of entry.imageUrls ?? []) {
      if (picked.size >= max) return picked;
      picked.add(url);
    }
  }
  return picked;
}

/**
 * 渲染一行。
 *
 * user 轮带 `[HH:mm] 用户<昵称>: ` 前缀：群里多个同学共用一份上下文，靠前缀区分谁说的，
 * 时间戳用来判断「这是不是很久以前的旧消息」。发言人用前缀而不是 messages 的 `name` 字段，
 * 是因为实测 DeepSeek 与 GLM 都接受 `name` 却不生效（不报错，也不影响归属判断）。
 *
 * assistant 轮**不加**前缀：加了模型会照着自己历史的格式，在给用户的回复里也带上时间戳
 * （实测出现过「[16:12] 好嘞，搞定就行喵~」）。
 */
function line(entry: HistoryEntry, maxChars: number): string {
  const text = truncateText(entry.content.replace(/\s+/g, " ").trim(), maxChars);
  if (entry.role === "bot") return text;
  return `[${hhmm(entry.at)}] 用户${entry.senderName ?? ""}: ${text}`;
}

/** 东八区的 HH:mm。 */
function hhmm(ts: number): string {
  const date = new Date(ts + 8 * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
