/**
 * 飞书侧的知识库管理入口。
 *
 * 交互形状（`@机器人` 是唯一入口）：
 * ```
 * 群里 @机器人
 *   └─ 主菜单卡片（平铺在主消息流，成为话题的根）
 *       ├─ 新增条目     → 两步向导（进话题）→ 「已新增」卡片（带删除按钮）
 *       ├─ 查看补充条目 → 列表卡片（进话题，条目折叠）
 *       └─ 切换注入     → 结果卡片（进话题）
 * ```
 * 卡片之间的父子关系靠 `reply_in_thread: true` 建立：被回复的消息成为话题根，之后所有
 * 回复自动落回同一话题，所以**这一层不需要保存任何会话状态**。
 *
 * 全程走长连接（`WSClient`），进程依旧不监听任何端口。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import type { Config } from "../core/config.js";
import { larkLogger, log } from "../core/log.js";
import { FeishuKbStore, checkDeletable, renderFeishuFileText, signActionValue, verifyActionValue } from "../kb/feishu.js";
import type { FeishuLayerFile } from "../kb/feishu.js";
import { FeishuEntrySchema, compileKnowledgeBase } from "../kb/kb.js";
import type { KnowledgeBaseRuntime } from "../kb/runtime.js";
import {
  EMPTY_DRAFT,
  MAX_ANSWER_CHARS,
  MAX_FORWARD_HINT_CHARS,
  MAX_ID_CHARS,
  MAX_KEYWORDS_CHARS,
  MAX_TITLE_CHARS,
  OP,
  buildAddedCard,
  buildDeletedCard,
  buildEntryListCard,
  buildMenuCard,
  buildResultCard,
  buildStep1Card,
  buildStep2Card,
  buildSubmittedCard,
  buildToggleResultCard,
  draftFromValue,
  isRoute,
  mergeDraft,
} from "./kbCards.js";
import type { Card, KbState, WizardDraft } from "./kbCards.js";

/** 事件体（SDK 会把 header 与 event 摊平成一个对象，所以字段都在顶层）。 */
interface MessageReceiveData {
  event_id?: string;
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
  };
  sender?: { sender_id?: { open_id?: string } };
}

interface CardActionData {
  event_id?: string;
  operator?: { open_id?: string; name?: string };
  action?: {
    tag?: string;
    name?: string;
    value?: unknown;
    form_value?: Record<string, unknown>;
    input_value?: string;
  };
  context?: { open_message_id?: string; open_chat_id?: string };
}

/** 卡片回传的响应体：`toast` 是弹窗提示，`card` 会把来源卡片原地换掉。 */
type CallbackResponse = Record<string, unknown>;

function toast(type: "success" | "error" | "info" | "warning", content: string): CallbackResponse {
  return { toast: { type, content } };
}

function toastWithCard(type: "success" | "error" | "info" | "warning", content: string, card: Card): CallbackResponse {
  return { toast: { type, content }, card: { type: "raw", data: card } };
}

/** 只换卡片、不弹 toast。卡片本身就是反馈的场合用它（向导翻页、原地改状态）。 */
function cardOnly(card: Card): CallbackResponse {
  return { card: { type: "raw", data: card } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 保留最近多少条消息 id / 回调 id，用来挡住飞书的重复推送。 */
const SEEN_CAP = 5_000;

export class LarkKbAdmin {
  private readonly client: Lark.Client;
  private readonly ws: Lark.WSClient;
  private readonly store: FeishuKbStore;
  private readonly admins: Set<string>;
  private chatId: string | undefined;
  /** 最近一次发出的主菜单消息 id。卡片内容变了就靠它原地刷新（`message.patch`）。 */
  private menuMessageId: string | undefined;
  /** 飞书不让更新这张卡片时置位，避免每次都白试一遍。 */
  private menuPatchable = true;
  /** 幂等集合：飞书明说「特殊情况下可能重复推送」，且让用 message_id 去重而不是 event_id。 */
  private readonly seen = new Set<string>();
  /** 群里不支持话题回复时置位，避免每次都白试一遍、也只提醒一次。 */
  private threadsUnsupported = false;
  private stopped = false;

  constructor(
    private readonly cfg: Config,
    private readonly kb: KnowledgeBaseRuntime,
  ) {
    this.client = new Lark.Client({ appId: cfg.LARK_APP_ID, appSecret: cfg.LARK_APP_SECRET, logger: larkLogger });
    this.ws = new Lark.WSClient({
      appId: cfg.LARK_APP_ID,
      appSecret: cfg.LARK_APP_SECRET,
      logger: larkLogger,
      loggerLevel: Lark.LoggerLevel.info,
    });
    this.store = new FeishuKbStore(cfg.KB_FEISHU_PATH, cfg.DATA_DIR);
    this.admins = new Set(
      cfg.LARK_ADMIN_OPEN_IDS.split(",")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    );
  }

  /** 建长连接。任何失败都只记日志——知识库管理挂了不能连带把 QQ 机器人拖死。 */
  async start(chatId: string | undefined, signal: AbortSignal): Promise<void> {
    if (!this.cfg.KB_ADMIN_ENABLED) {
      log.info("kb-admin", "飞书知识库管理已关闭（KB_ADMIN_ENABLED=false）");
      return;
    }
    if (chatId === undefined) {
      log.warn("kb-admin", "没有可用的飞书群，知识库管理未启动");
      return;
    }
    this.chatId = chatId;
    if (this.admins.size === 0) {
      log.warn(
        "kb-admin",
        "LARK_ADMIN_OPEN_IDS 为空：现在谁点菜单都不会生效。@机器人 时会把 open_id 打进日志，复制进 .env 即可授权",
      );
    } else {
      log.info("kb-admin", `知识库管理员 ${this.admins.size} 人，操作群 ${chatId}`);
    }

    await this.logChatMode();

    const dispatcher = new Lark.EventDispatcher({});
    // register 的泛型签名只声明了事件订阅，`card.action.trigger` 是回调、不在 IHandles 里
    // （SDK 自己的 Channel 也是这么注册的），所以这里跨过类型检查一次。
    dispatcher.register({
      "im.message.receive_v1": (data: MessageReceiveData) => this.onMessage(data),
      "card.action.trigger": (data: CardActionData) => this.onCardAction(data),
    } as unknown as Lark.EventHandles);

    try {
      await this.ws.start({ eventDispatcher: dispatcher });
      log.info("kb-admin", "飞书长连接已建立（事件 im.message.receive_v1 / 回调 card.action.trigger）");
    } catch (err) {
      log.error("kb-admin", `飞书长连接建立失败，知识库管理不可用：${errorText(err)}`);
      return;
    }
    signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.ws.close({ force: false });
    } catch {
      // 关闭失败没有补救手段，进程马上就退了。
    }
  }

  /**
   * 群的消息形式只用来打日志。
   *
   * 普通群也能「对一条消息创建话题」（`reply_in_thread: true`），不需要把群改成话题形式群；
   * 这里读一次是为了在真出问题时能一眼看出群配置，而不是去猜。
   */
  private async logChatMode(): Promise<void> {
    try {
      const res = await this.client.im.v1.chat.get({ path: { chat_id: this.chatId! } });
      if (res.code !== 0) {
        log.debug("kb-admin", `读取群信息失败：code=${res.code} msg=${res.msg}`);
        return;
      }
      const mode = res.data?.chat_mode ?? "(未知)";
      const messageType = res.data?.group_message_type ?? "(不支持设置)";
      log.info("kb-admin", `操作群消息形式：chat_mode=${mode} group_message_type=${messageType}`);
    } catch (err) {
      log.debug("kb-admin", `读取群信息异常：${errorText(err)}`);
    }
  }

  // ── 事件：@机器人 → 主菜单 ────────────────────────────────────────────────

  private async onMessage(data: MessageReceiveData): Promise<void> {
    const msg = data.message;
    if (!msg?.message_id || !msg.chat_id) return;
    if (msg.chat_type !== "group") return;
    if (msg.chat_id !== this.chatId) {
      // 别静默丢掉：排查「@了机器人但日志里什么都没有」时，最大的坑就是分不清
      // 「事件根本没到」和「到了但不是这个群」。留下这条，两种情况一眼可辨。
      log.info("kb-admin", `收到其它群的消息，忽略：${msg.chat_id}（本机器人只在 ${this.chatId ?? "(未配置)"} 里工作）`);
      return;
    }
    if (!this.once(`msg:${msg.message_id}`)) return;

    const openId = data.sender?.sender_id?.open_id ?? "";
    if (!this.isAdmin(openId)) {
      // 不回复、不暴露功能，只留一条日志方便回填白名单。
      log.info("kb-admin", `忽略非白名单成员的知识库请求：open_id=${openId}`);
      return;
    }

    log.info("kb-admin", `管理员 ${openId} @了机器人，发送主菜单`);
    // 主菜单留在主消息流，后续所有卡片都回复它 → 收进它下面的话题。
    const sent = await this.replyCard(msg.message_id, buildMenuCard(this.state(), this.sign), {
      inThread: false,
      uuid: `kbmenu-${msg.message_id}`,
    });
    if (sent === undefined) log.warn("kb-admin", "主菜单发送失败，请检查机器人是否还在群里、是否有发言权限");
    else this.menuMessageId = sent;
  }

  // ── 回调：卡片交互 ────────────────────────────────────────────────────────

  private async onCardAction(data: CardActionData): Promise<CallbackResponse> {
    const openId = data.operator?.open_id ?? "";
    const chatId = data.context?.open_chat_id ?? "";
    const messageId = data.context?.open_message_id ?? "";

    if (this.chatId === undefined || chatId !== this.chatId) {
      return toast("error", "这张卡片不在知识库管理群里");
    }
    if (!this.isAdmin(openId)) {
      log.warn("kb-admin", `非白名单成员点击了知识库卡片：open_id=${openId}`);
      return toast("error", "你不是知识库管理员");
    }
    const verified = verifyActionValue(this.cfg.LARK_APP_SECRET, data.action?.value);
    if (!verified.ok) {
      log.warn("kb-admin", `回传数据校验失败：${verified.reason}（open_id=${openId}）`);
      return toast("error", `回传数据校验失败：${verified.reason}`);
    }
    if (!this.once(`card:${data.event_id ?? messageId}`)) return toast("info", "这次操作已经处理过了");

    const op = String(verified.payload["op"] ?? "");
    try {
      switch (op) {
        case OP.add:
          return await this.onAdd(messageId);
        case OP.wizardNext:
          return await this.onWizardNext(verified.payload, data.action?.form_value ?? {});
        case OP.wizardBack:
          return await this.onWizardBack(verified.payload, data.action?.form_value ?? {});
        case OP.submit:
          return await this.onSubmit(openId, verified.payload, data.action?.form_value ?? {}, messageId);
        case OP.list:
          return await this.onList(messageId);
        case OP.toggle:
          return await this.onToggle(messageId);
        case OP.del:
          return await this.onDelete(openId, verified.payload, messageId);
        default:
          return toast("warning", `未知操作：${op === "" ? "(空)" : op}`);
      }
    } catch (err) {
      log.error("kb-admin", `处理 ${op} 失败：${errorText(err)}`);
      return toast("error", `处理失败：${errorText(err)}`);
    }
  }

  /** 新增条目：不碰菜单卡片，另发一张向导卡片（第一步）进话题。 */
  private async onAdd(messageId: string): Promise<CallbackResponse> {
    await this.replyCard(messageId, buildStep1Card(this.sign, EMPTY_DRAFT), { inThread: true });
    return toast("info", "已发到下方话题");
  }

  /**
   * 向导第一步 → 第二步。
   *
   * 「下一步」是表单的提交按钮，所以这里能拿到 `form_value`（用户刚填的四个字段）；
   * 返回的卡片会**原地替换**掉第一步那张卡。校验不过时只回 toast、**不返回 card**，
   * 这样用户已经敲进去的内容原样留在屏幕上，改完直接再点一次即可。
   */
  private async onWizardNext(payload: Record<string, unknown>, form: Record<string, unknown>): Promise<CallbackResponse> {
    const draft = mergeDraft(draftFromValue(payload), form);
    const problem = this.checkStep1(draft);
    if (problem !== "") return toast("error", problem);
    return cardOnly(buildStep2Card(draft, this.sign));
  }

  /**
   * 向导第二步 → 第一步（回退）。
   *
   * 这里同样能拿到 `form_value`（第二步那个输入框里已经敲了一半的内容），
   * 于是回退后**再点「下一步」时那段内容还在**——第一/二步之间可以随便来回切。
   */
  private async onWizardBack(payload: Record<string, unknown>, form: Record<string, unknown>): Promise<CallbackResponse> {
    const draft = mergeDraft(draftFromValue(payload), form);
    return cardOnly(buildStep1Card(this.sign, draft));
  }

  /** 查看补充条目。 */
  private async onList(messageId: string): Promise<CallbackResponse> {
    const { file } = await this.store.load();
    await this.replyCard(messageId, buildEntryListCard(this.state(), file.entries), { inThread: true });
    return toast("info", "已发到下方话题");
  }

  /** 切换「飞书补充知识」注入开关。按**当前状态取反**，不信任卡片上烘焙的旧状态。 */
  private async onToggle(messageId: string): Promise<CallbackResponse> {
    const { present, file } = await this.store.load();
    const wanted = !file.enabled;
    if (!present && !wanted) return toast("info", "飞书补充知识为空，无需停用");
    const next: FeishuLayerFile = { ...file, enabled: wanted };
    await this.store.save(next);
    await this.kb.reload();
    await this.store.audit({ action: "toggle", enabled: wanted, source_message: messageId });

    const state = this.state();
    await this.replyCard(messageId, buildToggleResultCard(state, this.sign), { inThread: true });
    // 菜单上的状态行也得跟着变，否则它一直显示旧状态。
    void this.refreshMenu();
    return toast("success", wanted ? `已启用，${state.feishuCount} 条` : "已停用");
  }

  /** 删除刚添加的那一条：24 小时窗口 + id 严格相等 + 签名三重校验。 */
  private async onDelete(openId: string, payload: Record<string, unknown>, messageId: string): Promise<CallbackResponse> {
    const id = typeof payload["id"] === "string" ? payload["id"] : "";
    const cardAddedAt = typeof payload["added_at"] === "string" ? payload["added_at"] : "";

    const { file } = await this.store.load();
    const check = checkDeletable(file.entries, id, cardAddedAt, Date.now(), this.cfg.KB_DELETE_WINDOW_HOURS * 3_600_000);
    if (!check.ok) return toast("error", check.reason);
    const entry = check.entry;

    const next: FeishuLayerFile = { ...file, entries: file.entries.filter((item) => item.id !== id) };
    await this.store.save(next);
    await this.kb.reload();
    await this.store.audit({
      action: "delete",
      id: entry.id,
      title: entry.title,
      actor: openId,
      added_by: entry.added_by ?? "",
      source_message: messageId,
    });

    // 新发一张结果卡片（用户要求的「操作结果回卡片」），同时把那张「已新增」卡片原地
    // 换成「已删除」——按钮随之消失，点不动第二次。
    void this.refreshMenu();
    void this.replyCard(
      messageId,
      buildResultCard(true, `已删除：${entry.title}`, [`**id**　\`${entry.id}\``]),
      { inThread: true },
    );
    return toastWithCard("success", `已删除「${entry.title}」`, buildDeletedCard(entry));
  }

  /** 向导第二步的提交：合并草稿 → 校验 → 写盘 → 热重载 → 结果卡片。 */
  private async onSubmit(
    openId: string,
    payload: Record<string, unknown>,
    form: Record<string, unknown>,
    messageId: string,
  ): Promise<CallbackResponse> {
    // 第一步的 id/标题/关键词/处理方式在按钮的签名值里，第二步的答案/转交说明刚随
    // form_value 上来 —— 合并成完整草稿。
    const draft = mergeDraft(draftFromValue(payload), form);
    const problem = this.checkStep1(draft);
    if (problem !== "") return toast("error", problem);

    const text = (value: string): string => value.trim();
    const candidate = {
      id: text(draft.id),
      title: text(draft.title),
      keywords: text(draft.keywords)
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter((item) => item !== ""),
      route: text(draft.route),
      answer: text(draft.answer) === "" ? undefined : text(draft.answer),
      forward_hint: text(draft.forward_hint) === "" ? undefined : text(draft.forward_hint),
      added_by: openId,
      added_at: new Date().toISOString(),
    };

    const parsed = FeishuEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return toast("error", `校验失败：${issue ? issue.message : "未知原因"}`);
    }
    const entry = parsed.data;

    const tooLong = this.checkLengths(entry);
    if (tooLong !== "") return toast("error", tooLong);

    const { file } = await this.store.load();
    if (file.entries.some((item) => item.id === entry.id)) {
      return toast("error", `id「${entry.id}」已存在，请换一个`);
    }
    const next: FeishuLayerFile = { ...file, entries: [...file.entries, entry] };

    // 用真正的编译器试一遍：id 与正式知识库撞车、变量引用不存在、总量超限都在这里拦下。
    const compileProblem = await this.tryCompile(next);
    if (compileProblem !== "") return toast("error", compileProblem);

    await this.store.save(next);
    await this.kb.reload();
    await this.store.audit({
      action: "add",
      id: entry.id,
      title: entry.title,
      route: entry.route,
      keywords: entry.keywords,
      actor: openId,
      source_message: messageId,
      feishu_enabled: next.enabled,
    });

    log.info("kb-admin", `飞书补充知识新增：${entry.id}（${entry.title}），操作者 ${openId}`);
    // 结果卡片新发到话题里（删除按钮就挂在那张卡上），同时把表单卡片原地换成「已提交」，
    // 免得有人对着同一张表单再点一次提交。
    void this.refreshMenu();
    void this.replyCard(messageId, buildAddedCard(entry, this.sign), { inThread: true });
    return toastWithCard("success", `已新增「${entry.title}」`, buildSubmittedCard(entry));
  }

  /**
   * 第一步那四个字段的校验，返回空串表示通过。
   *
   * 「下一步」和「提交」两处都要调用：第二步的卡片里根本没有这四个字段，它们的值来自按钮的
   * 签名回传，所以最终提交时必须重新验一遍。客户端上那四个框也带 `required`，但那是前端拦截，
   * 只是体验优化、不能当校验。
   */
  private checkStep1(draft: WizardDraft): string {
    const id = draft.id.trim();
    if (id === "") return "请填 id";
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return "id 只能用字母、数字、下划线、短横线";
    if (id.length > MAX_ID_CHARS) return `id 不能超过 ${MAX_ID_CHARS} 字`;

    const title = draft.title.trim();
    if (title === "") return "请填标题";
    if (title.length > MAX_TITLE_CHARS) return `标题不能超过 ${MAX_TITLE_CHARS} 字`;

    const keywords = draft.keywords
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (keywords.length === 0) return "关键词至少填一个（用逗号分隔）";
    if (keywords.join("、").length > MAX_KEYWORDS_CHARS) return `关键词合计不能超过 ${MAX_KEYWORDS_CHARS} 字`;

    if (!isRoute(draft.route.trim())) return "请选择处理方式";
    return "";
  }

  /** 卡片输入框能限住的长度先在这里再兜一遍（客户端可以绕过前端限制）。 */
  private checkLengths(entry: { id: string; title: string; keywords: string[]; answer?: string; forward_hint?: string }): string {
    if (!/^[A-Za-z0-9_-]+$/.test(entry.id)) return "id 只能用字母、数字、下划线、短横线";
    if (entry.id.length > MAX_ID_CHARS) return `id 不能超过 ${MAX_ID_CHARS} 字`;
    if (entry.title.length > MAX_TITLE_CHARS) return `标题不能超过 ${MAX_TITLE_CHARS} 字`;
    const keywords = entry.keywords.join("、");
    if (keywords.length > MAX_KEYWORDS_CHARS) return `关键词合计不能超过 ${MAX_KEYWORDS_CHARS} 字`;
    if (entry.answer !== undefined && entry.answer.length > MAX_ANSWER_CHARS) {
      return `答案不能超过 ${MAX_ANSWER_CHARS} 字`;
    }
    if (entry.forward_hint !== undefined && entry.forward_hint.length > MAX_FORWARD_HINT_CHARS) {
      return `转交说明不能超过 ${MAX_FORWARD_HINT_CHARS} 字`;
    }
    return "";
  }

  /**
   * 写盘前试编译。返回空串表示没问题，否则返回可以直接给用户看的原因。
   *
   * 这里用的是**和启动时同一个** `compileKnowledgeBase`，所以「飞书加得进去、重启却起不来」
   * 这种最坏情况不可能发生。
   */
  private async tryCompile(file: FeishuLayerFile): Promise<string> {
    const raw = renderFeishuFileText(file);
    try {
      const compiled = compileKnowledgeBase(await this.kb.baseRaw(), this.cfg.KB_PATH, raw, this.store.filePath);
      const feishuChars = compiled.feishuBlock.length;
      if (feishuChars > this.cfg.KB_FEISHU_MAX_CHARS) {
        return `飞书补充知识已达 ${feishuChars} 字，超过上限 ${this.cfg.KB_FEISHU_MAX_CHARS}，请精简或转正`;
      }
      if (compiled.systemPrompt.length > this.cfg.KB_MAX_PROMPT_CHARS) {
        return `提示词已达 ${compiled.systemPrompt.length} 字，超过上限 ${this.cfg.KB_MAX_PROMPT_CHARS}，请精简`;
      }
      return "";
    } catch (err) {
      // 校验失败的原文是给人看的（哪一条 id 撞了、哪个变量没定义），直接透传。
      return errorText(err);
    }
  }

  // ── 发送与簿记 ────────────────────────────────────────────────────────────

  /**
   * 原地刷新主菜单（状态行里的条数、注入开关、提示词字符数都会变）。
   *
   * 用 `message.patch`（按 message_id 更新应用自己发的卡片），不占用回调那个
   * 「30 分钟最多 2 次」的 token 额度。失败只影响菜单上那行状态是否最新，
   * 所以降级成一条 debug 日志并就此关掉，不再反复重试。
   */
  private async refreshMenu(): Promise<void> {
    if (this.menuMessageId === undefined || !this.menuPatchable) return;
    try {
      const res = await this.client.im.v1.message.patch({
        path: { message_id: this.menuMessageId },
        data: { content: JSON.stringify(buildMenuCard(this.state(), this.sign)) },
      });
      if (res.code === 0) return;
      this.menuPatchable = false;
      log.debug("kb-admin", `主菜单刷新失败：code=${res.code} msg=${res.msg}（只影响菜单上的状态行）`);
    } catch (err) {
      this.menuPatchable = false;
      log.debug("kb-admin", `主菜单刷新异常：${errorText(err)}`);
    }
  }

  /** 回复某条消息并附一张卡片。`inThread` 为真时收进那条消息的话题。 */
  private async replyCard(
    messageId: string,
    card: Card,
    opts: { inThread: boolean; uuid?: string },
  ): Promise<string | undefined> {
    const inThread = opts.inThread && !this.threadsUnsupported;
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: inThread,
        ...(opts.uuid !== undefined ? { uuid: opts.uuid } : {}),
      },
    });
    if (res.code === 0 && res.data?.message_id) return res.data.message_id;

    // 230071：群聊不支持话题回复。降级成发到主消息流，并只提醒一次。
    if (inThread && (res.code === 230071 || res.code === 230072)) {
      this.threadsUnsupported = true;
      log.warn("kb-admin", `该群不支持话题回复（code=${res.code}），知识库卡片将直接发在群里`);
      return this.replyCard(messageId, card, { ...opts, inThread: false });
    }
    log.warn("kb-admin", `卡片发送失败：code=${res.code} msg=${res.msg}`);
    return undefined;
  }

  private isAdmin(openId: string): boolean {
    return openId !== "" && this.admins.has(openId);
  }

  private get sign(): (payload: Record<string, unknown>) => Record<string, unknown> {
    return (payload) => signActionValue(this.cfg.LARK_APP_SECRET, payload);
  }

  private state(): KbState {
    const kb = this.kb.current();
    return {
      baseVersion: kb.baseVersion,
      baseCount: kb.entries.length,
      feishuVersion: kb.feishuVersion,
      feishuEnabled: kb.feishuEnabled,
      feishuCount: kb.feishuEntries.length,
      promptChars: kb.systemPrompt.length,
      feishuPresent: kb.feishuPresent,
    };
  }

  /**
   * 幂等簿记。飞书可能重复推送同一条消息/回调，重复执行会变成「同一张表单提交两次」。
   * 满了丢**最旧的**（重新 set 让它排到 Set 末尾，淘汰顺序才是真正的 LRU）。
   */
  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.delete(key);
    this.seen.add(key);
    while (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}
