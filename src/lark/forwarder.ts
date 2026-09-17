/**
 * 飞书侧的转交通道与话题簿记（卡片长什么样在 `./cards.ts`）。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { Config } from "../core/config.js";
import { larkLogger, log } from "../core/log.js";
import { monthKey } from "../store/retention.js";
import { buildFollowUpCard, buildRootCard } from "./cards.js";

export interface ForwardRequest {
  summary: string;
  details: string;
  /**
   * 主题标识：同一用户同一主题的多次转交会聚合到同一条话题下。
   * 优先由模型填知识库条目的 id，兜底用问题本身的短标识。
   */
  topic?: string;
  /** QQ 消息 id：幂等键，同一条消息重复转交会被拦住。 */
  msgId: string;
  /** 发送者 openid：限频键，也是话题归属键。 */
  senderId: string;
  /** 豁免名单里的用户跳过「每小时转交次数」限制（每日额度仍然生效）。 */
  exemptHourlyLimit?: boolean;
}

export interface ForwardOutcome {
  ok: boolean;
  /** 回填给模型的说明文本。 */
  message: string;
}

interface TopicRecord {
  rootMessageId: string;
  createdAt: string;
  lastAt: string;
  count: number;
}

const HOUR_MS = 3_600_000;

/**
 * 把机器人无法直接回答的问题推到飞书反馈群。
 * 飞书侧只做提醒：机器人只发不收、不维护工单状态。
 * 同一用户同一主题的后续补充会作为「话题回复」挂在原始卡片下，群聊不会被刷屏。
 */
export class FeedbackForwarder {
  private readonly client: Lark.Client;
  private chatId: string | undefined;
  private readonly pushedMsgIds = new Set<string>();
  private readonly senderWindows = new Map<string, number[]>();
  private readonly topics = new Map<string, TopicRecord>();
  /** 飞书群不支持话题回复时置位，避免每次都白试一遍。 */
  private threadsUnsupported = false;

  constructor(private readonly cfg: Config) {
    this.client = new Lark.Client({
      appId: cfg.LARK_APP_ID,
      appSecret: cfg.LARK_APP_SECRET,
      logger: larkLogger,
    });
  }

  /** 启动时确定反馈群，并载入话题状态。 */
  async init(): Promise<void> {
    await this.loadTopics();

    const res = await this.client.im.v1.chat.list({ params: { page_size: 50 } });
    if (res.code !== 0) {
      throw new Error(`获取飞书群列表失败：code=${res.code} msg=${res.msg}（检查应用凭据与 im:chat:readonly 权限）`);
    }
    const items = res.data?.items ?? [];

    if (this.cfg.LARK_FEEDBACK_CHAT_ID) {
      this.chatId = this.cfg.LARK_FEEDBACK_CHAT_ID;
      const hit = items.find((chat) => chat.chat_id === this.chatId);
      if (hit) log.info("lark", `反馈群：${hit.name ?? "(无名)"} (${this.chatId})`);
      else log.warn("lark", `配置的 LARK_FEEDBACK_CHAT_ID 不在机器人所在群列表里，仍按配置使用：${this.chatId}`);
    } else if (items.length === 1) {
      const only = items[0]!;
      this.chatId = only.chat_id;
      log.info("lark", `自动识别反馈群：${only.name ?? "(无名)"} (${this.chatId})`);
    } else {
      const listing = items.map((chat) => `  - ${chat.name ?? "(无名)"} → ${chat.chat_id}`).join("\n");
      throw new Error(
        items.length === 0
          ? "机器人不在任何飞书群里。请把机器人拉进反馈群，或在 .env 设置 LARK_FEEDBACK_CHAT_ID。"
          : `机器人所在群不唯一，请在 .env 设置 LARK_FEEDBACK_CHAT_ID：\n${listing}`,
      );
    }

    log.info("lark", `已载入 ${this.topics.size} 个历史话题`);
  }

  async push(req: ForwardRequest): Promise<ForwardOutcome> {
    if (!this.chatId) return { ok: false, message: "转交通道尚未就绪，请稍后再试。" };

    if (this.pushedMsgIds.has(req.msgId)) {
      return { ok: true, message: "该消息已经转交过了，无需重复转交。" };
    }

    const now = Date.now();
    const window = (this.senderWindows.get(req.senderId) ?? []).filter((ts) => now - ts < HOUR_MS);
    if (!req.exemptHourlyLimit && window.length >= this.cfg.FORWARD_LIMIT_PER_HOUR) {
      return {
        ok: false,
        message: `同一用户每小时最多转交 ${this.cfg.FORWARD_LIMIT_PER_HOUR} 次，本次未转交。请告知用户稍后再试。`,
      };
    }

    const key = topicKey(req.senderId, req.topic, req.msgId);
    const existing = this.topics.get(key);
    const fresh = existing ? now - Date.parse(existing.lastAt) < this.cfg.FORWARD_TOPIC_WINDOW_HOURS * HOUR_MS : false;

    let messageId: string;
    let inThread = false;

    if (existing && fresh && !this.threadsUnsupported) {
      const count = existing.count + 1;
      const replied = await this.replyInThread(existing.rootMessageId, buildFollowUpCard(req, count));
      if (replied) {
        messageId = replied;
        inThread = true;
        existing.count = count;
        existing.lastAt = new Date().toISOString();
      } else {
        messageId = await this.sendCard(buildRootCard(req));
      }
    } else {
      messageId = await this.sendCard(buildRootCard(req));
    }

    if (inThread && existing) {
      this.topics.set(key, existing);
    } else {
      this.topics.set(key, {
        rootMessageId: messageId,
        createdAt: new Date().toISOString(),
        lastAt: new Date().toISOString(),
        count: 1,
      });
    }
    await this.saveTopics();

    this.rememberMsgId(req.msgId);
    window.push(now);
    this.senderWindows.set(req.senderId, window);
    await this.appendLog({
      ...req,
      topicKey: key,
      at: new Date().toISOString(),
      larkMessageId: messageId,
      inThread,
    });
    log.info(
      "fwd",
      `已转交${inThread ? "（话题回复）" : ""}：${req.summary}（主题=${key}，qqMsg=${req.msgId}）`,
    );
    return { ok: true, message: "已成功转交人工处理。" };
  }

  private async sendCard(card: Record<string, unknown>): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: this.chatId!,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (res.code !== 0 || !res.data?.message_id) {
      throw new Error(`飞书推送失败：code=${res.code} msg=${res.msg}`);
    }
    return res.data.message_id;
  }

  /** 话题回复失败（群里不支持话题）时返回 undefined，由调用方退回普通卡片。 */
  private async replyInThread(rootMessageId: string, card: Record<string, unknown>): Promise<string | undefined> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    });
    if (res.code === 0 && res.data?.message_id) return res.data.message_id;

    // 230071：群聊不支持话题回复；230072：聚合消息不支持话题回复。
    if (res.code === 230071 || res.code === 230072) {
      if (!this.threadsUnsupported) {
        this.threadsUnsupported = true;
        log.warn("fwd", `该群不支持话题回复（code=${res.code}），后续补充将作为新卡片发送`);
      }
      return undefined;
    }
    log.warn("fwd", `话题回复失败：code=${res.code} msg=${res.msg}，本次改为发送新卡片`);
    return undefined;
  }

  private get topicsFile(): string {
    return join(this.cfg.DATA_DIR, "topics.json");
  }

  private async loadTopics(): Promise<void> {
    try {
      const raw = await readFile(this.topicsFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, TopicRecord>;
      for (const [key, value] of Object.entries(parsed)) this.topics.set(key, value);
    } catch {
      // 首次运行时文件不存在，属于正常情况。
    }
  }

  private async saveTopics(): Promise<void> {
    try {
      await mkdir(this.cfg.DATA_DIR, { recursive: true });
      const tmp = `${this.topicsFile}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.topics), null, 2), "utf8");
      await rename(tmp, this.topicsFile);
    } catch (err) {
      log.warn("fwd", `话题状态保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 幂等集合只在内存里，重启后靠飞书群里的历史卡片兜底，因此设个上限避免无限增长。
   * 满了丢**最旧的**而不是清空：清空会让刚刚转交过的消息又变成「没转过」，重复推一张卡片。
   */
  private rememberMsgId(msgId: string): void {
    // 重新 set 一遍让它排到 Map 末尾，淘汰顺序才是真正的 LRU。
    this.pushedMsgIds.delete(msgId);
    this.pushedMsgIds.add(msgId);
    while (this.pushedMsgIds.size > 5_000) {
      const oldest = this.pushedMsgIds.values().next().value;
      if (oldest === undefined) break;
      this.pushedMsgIds.delete(oldest);
    }
  }

  private async appendLog(record: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.cfg.DATA_DIR, { recursive: true });
      // 按月切分，跨月自动落到新文件（保留期由 retention 模块统一清理）。
      const file = join(this.cfg.DATA_DIR, `forwards-${monthKey()}.jsonl`);
      await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      log.warn("fwd", `转发日志写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 话题归属键：同一用户 + 同一主题。
 *
 * 但**话题聚合当前没有启用**：forward_feedback 的参数里没有 topic，模型填不了这个字段，
 * 于是每条消息都各自独立成键，同一个用户的不同问题不会被串到一条话题下面。
 * 卡片、话题回复与 230071 降级这些代码都留着，把 topic 加回工具参数即可生效；
 * 注意 README 里的「话题聚合」一节与此处是同一件事的两处说明，改动时要一起改。
 */
export function topicKey(senderId: string, topic: string | undefined, fallbackId: string): string {
  const normalized = (topic ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return normalized === "" ? `${senderId}::solo-${fallbackId}` : `${senderId}::${normalized}`;
}
