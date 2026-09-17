import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import { log } from "../core/log.js";
import { dayKey } from "./retention.js";

export type LimitReason = "user-rate" | "group-rate" | "user-daily" | "global-daily";

export interface LimitDecision {
  ok: boolean;
  reason?: LimitReason;
  /** 命中的用户是否在豁免名单里。 */
  isPrivileged: boolean;
  /** 给用户的提示语（ok=false 时非空）。 */
  message?: string;
}

const MINUTE_MS = 60_000;
/** 同一用户同一原因，最多每分钟提示一次，避免限额提示本身刷屏。 */
const NOTICE_COOLDOWN_MS = 60_000;

interface Persisted {
  day: string;
  userCounts: Record<string, number>;
  globalCount: number;
  /** 单用户当天已读取的图片张数。 */
  imageCounts?: Record<string, number>;
  /**
   * 当天已经计过额度的图片 URL（同一张图只计一次）。
   *
   * 只有 URL 集合能表达「这张图今天读过了」：进程内图片缓存有上限（60 张 / 24MB），
   * 历史里的图被淘汰后会重新下载，按下载次数计就会把用户当天的额度反复扣掉。
   */
  imageUrls?: Record<string, string[]>;
}

/**
 * 频次与配额控制：
 * - 分钟级：单用户、单群滑动窗口；
 * - 每日：单用户、全局计数（按东八区自然日，落盘 data/limits.json，重启不清零）。
 *
 * 豁免名单里的用户不受分钟级限制，每日额度也单独放宽。
 */
export class Limits {
  private day = dayKey();
  private readonly userCounts = new Map<string, number>();
  private readonly imageCounts = new Map<string, number>();
  /** 当天已经计过额度的图片 URL，按用户分组。 */
  private readonly imageUrls = new Map<string, Set<string>>();
  private globalCount = 0;
  private readonly minuteWindows = new Map<string, number[]>();
  private readonly groupWindows = new Map<string, number[]>();
  private readonly notices = new Map<string, number>();
  private readonly privileged: Set<string>;
  private saving: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly cfg: Config) {
    this.privileged = new Set(
      cfg.PRIVILEGED_USERS.split(",")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    );
  }

  isPrivileged(senderId: string): boolean {
    return this.privileged.has(senderId);
  }

  get privilegedUsers(): string[] {
    return [...this.privileged];
  }

  private get file(): string {
    return join(this.cfg.DATA_DIR, "limits.json");
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Persisted;
      if (raw.day === this.day) {
        this.globalCount = raw.globalCount ?? 0;
        for (const [key, value] of Object.entries(raw.userCounts ?? {})) this.userCounts.set(key, value);
        for (const [key, value] of Object.entries(raw.imageCounts ?? {})) this.imageCounts.set(key, value);
        for (const [key, value] of Object.entries(raw.imageUrls ?? {})) this.imageUrls.set(key, new Set(value));
        log.info(
          "limits",
          `今日配额已用：全局 ${this.globalCount}/${this.cfg.REPLY_LIMIT_GLOBAL_PER_DAY}`,
        );
      } else {
        // 上一次运行的日期已过：归档旧数据，从零开始（不覆盖 live 文件的归档由下次写入完成）。
        log.info("limits", `跨日，配额已重置（上次记录 ${raw.day}）`);
        await this.archiveDay(
          raw.day,
          new Map(Object.entries(raw.userCounts ?? {})),
          raw.globalCount ?? 0,
          new Map(Object.entries(raw.imageCounts ?? {})),
        );
      }
    } catch {
      // 首次运行没有文件，正常。
    }
    if (this.privileged.size > 0) {
      log.info("limits", `豁免限额用户 ${this.privileged.size} 个（每日 ${this.cfg.PRIVILEGED_LIMIT_PER_DAY} 次，不受分钟级限制）`);
    }
  }

  /** 只读检查，不消耗配额；消耗发生在 {@link consume}。 */
  check(senderId: string, groupOpenid?: string): LimitDecision {
    this.rollover();
    const isPrivileged = this.isPrivileged(senderId);
    const now = Date.now();

    if (!isPrivileged) {
      const userWindow = this.prune(this.minuteWindows.get(senderId), now);
      this.minuteWindows.set(senderId, userWindow);
      if (userWindow.length >= this.cfg.RATE_LIMIT_PER_MINUTE) {
        return this.deny("user-rate", isPrivileged, "消息发得有点快，稍等一分钟再发好不好喵~");
      }

      if (groupOpenid) {
        const groupWindow = this.prune(this.groupWindows.get(groupOpenid), now);
        this.groupWindows.set(groupOpenid, groupWindow);
        if (groupWindow.length >= this.cfg.RATE_LIMIT_PER_GROUP_PER_MINUTE) {
          return this.deny("group-rate", isPrivileged, "群里消息有点多，我喘口气，一分钟后再来找我喵~");
        }
      }
    }

    const userLimit = isPrivileged ? this.cfg.PRIVILEGED_LIMIT_PER_DAY : this.cfg.REPLY_LIMIT_PER_USER_PER_DAY;
    if ((this.userCounts.get(senderId) ?? 0) >= userLimit) {
      return this.deny("user-daily", isPrivileged, `今天已经聊了 ${userLimit} 次啦，明天再来找我可以吗喵~`);
    }

    if (this.globalCount >= this.cfg.REPLY_LIMIT_GLOBAL_PER_DAY) {
      return this.deny(
        "global-daily",
        isPrivileged,
        "今天咨询的人太多啦，我有点忙不过来，过一会儿再试好不好喵~",
      );
    }

    return { ok: true, isPrivileged };
  }

  /**
   * 申请一次配额：检查通过就**同步**记账并返回 ok。
   * 同步记账很关键——Node 是单线程，同步写计数能让并发到达的消息正确排队；
   * 若像 check 那样只读、把记账留到 await 之后，多条消息会同时通过检查、都去调模型。
   */
  reserve(senderId: string, groupOpenid?: string): LimitDecision {
    const decision = this.check(senderId, groupOpenid);
    if (!decision.ok) return decision;

    const now = Date.now();
    if (!decision.isPrivileged) {
      this.minuteWindows.set(senderId, [...this.prune(this.minuteWindows.get(senderId), now), now]);
      if (groupOpenid) {
        this.groupWindows.set(groupOpenid, [...this.prune(this.groupWindows.get(groupOpenid), now), now]);
      }
    }
    this.userCounts.set(senderId, (this.userCounts.get(senderId) ?? 0) + 1);
    this.globalCount += 1;
    this.scheduleSave();
    return decision;
  }

  /** 退出前把未落盘的计数写完。 */
  async flush(): Promise<void> {
    if (this.saving) await this.saving;
    if (this.dirty) await this.writeCounters();
  }

  /** 限额提示是否需要发给该用户（每分钟最多一次）。 */
  shouldNotify(senderId: string, reason: LimitReason): boolean {
    const key = `${senderId}:${reason}`;
    const now = Date.now();
    const last = this.notices.get(key) ?? 0;
    if (now - last < NOTICE_COOLDOWN_MS) return false;
    this.notices.set(key, now);
    if (this.notices.size > 5_000) this.notices.clear();
    return true;
  }

  private deny(reason: LimitReason, isPrivileged: boolean, message: string): LimitDecision {
    return { ok: false, reason, isPrivileged, message };
  }

  private prune(window: number[] | undefined, now: number): number[] {
    return (window ?? []).filter((ts) => now - ts < MINUTE_MS);
  }

  private rollover(): void {
    const today = dayKey();
    if (today === this.day) return;
    const previous = this.day;
    log.info("limits", `跨日（${previous} → ${today}），配额已重置`);
    if (this.globalCount > 0 || this.userCounts.size > 0 || this.imageCounts.size > 0) {
      // 归档当天的用量，方便事后核对（保留期由 retention 模块统一清理）。
      void this.archiveDay(previous, new Map(this.userCounts), this.globalCount, new Map(this.imageCounts));
    }
    this.day = today;
    this.userCounts.clear();
    this.imageCounts.clear();
    this.imageUrls.clear();
    this.globalCount = 0;
  }

  /** 今天还能为该用户读几张图。 */
  imageBudget(senderId: string): number {
    this.rollover();
    return Math.max(0, this.cfg.IMG_DAILY_LIMIT_PER_USER - (this.imageCounts.get(senderId) ?? 0));
  }

  /** 这张图今天是否已经计过额度（计过的重复遇到不再扣）。 */
  imageCharged(senderId: string, url: string): boolean {
    return this.imageUrls.get(senderId)?.has(url) === true;
  }

  /**
   * 为**一张具体的图**计一次额度；同一张图今天只计一次，返回是否真的扣了。
   *
   * 按图片本身计、而不是按「这一轮下载了几张」计：进程内缓存有上限，被淘汰的图会重新下载，
   * 按下载次数计会让用户在聊几句之后额度被重复扣光（同一张截图本来只该算一张）。
   */
  consumeImage(senderId: string, url: string): boolean {
    if (senderId === "" || url === "") return false;
    this.rollover();
    let charged = this.imageUrls.get(senderId);
    if (charged === undefined) {
      charged = new Set<string>();
      this.imageUrls.set(senderId, charged);
    }
    if (charged.has(url)) return false;
    charged.add(url);
    this.imageCounts.set(senderId, (this.imageCounts.get(senderId) ?? 0) + 1);
    this.scheduleSave();
    return true;
  }

  /** 把某一天的用量写成 limits.YYYY-MM-DD.json。 */
  private async archiveDay(
    day: string,
    userCounts: Map<string, number>,
    globalCount: number,
    imageCounts = new Map<string, number>(),
  ): Promise<void> {
    try {
      await mkdir(this.cfg.DATA_DIR, { recursive: true });
      const payload: Persisted = {
        day,
        userCounts: Object.fromEntries(userCounts),
        globalCount,
        ...(imageCounts.size > 0 ? { imageCounts: Object.fromEntries(imageCounts) } : {}),
      };
      await writeFile(join(this.cfg.DATA_DIR, `limits.${day}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      log.info("limits", `已归档 ${day} 的用量（全局 ${globalCount}，用户 ${userCounts.size} 个）`);
    } catch (err) {
      log.warn("limits", `用量归档失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 合并密集写入：同一时刻只有一次落盘在进行，期间的新计数合并到下一次。 */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saving) return;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        await this.writeCounters();
      }
    })()
      .catch((err: unknown) => {
        log.warn("limits", `配额落盘失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.saving = null;
      });
  }

  private async writeCounters(): Promise<void> {
    await mkdir(this.cfg.DATA_DIR, { recursive: true });
    const payload: Persisted = {
      day: this.day,
      userCounts: Object.fromEntries(this.userCounts),
      globalCount: this.globalCount,
      imageCounts: Object.fromEntries(this.imageCounts),
      imageUrls: Object.fromEntries([...this.imageUrls].map(([sender, urls]) => [sender, [...urls]])),
    };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}
