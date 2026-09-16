import {
  QQBot,
  contentSanitizer,
  errorHandler,
  mentionGate,
  messageFilter,
  quoteRef,
} from "@tencent-connect/qqbot-nodejs";
import type { ResolvedQuote } from "@tencent-connect/qqbot-nodejs";
import type { Config } from "./config.js";
import { splitContextAttachments } from "./context.js";
import { dumpRawEvent } from "./debugDump.js";
import type { FeedbackForwarder } from "./forward.js";
import type { History } from "./history.js";
import type { Limits } from "./limits.js";
import type { LlmClient, LlmTurn, MessagePart } from "./llm.js";
import { log, qqLogger } from "./log.js";
import { normalizeUrl, prepareImageUrls, prepareImages, quotedImageUrls } from "./media.js";
import type { InboundAttachment, PreparedImage } from "./media.js";
import { stripMentions, truncateText } from "./text.js";
import { FORWARD_FEEDBACK_TOOL, createTurnTools } from "./tools.js";

/** 单条回复的分段长度。 */
const MAX_REPLY_CHARS = 1600;

/**
 * 同一个 `msg_id` 最多能发几条被动回复。
 *
 * 官方文档（tencent-connect/bot-docs，send.md）按场景写明：群聊「被动消息（回复类）有效时间为 5 分钟，
 * **每个消息最多回复 5 次**，超时或超频会发送（回复）失败」。注意是 5 分钟不是 60 分钟——
 * 60 分钟那条是**单聊**的。同一 `msg_id` 下每条回复要用不同的 `msg_seq`（SDK 会自动填）。
 *
 * 因此主回复的分段数 + 补充消息要一起卡在这条线以内，否则最后几条会发不出去。
 */
const MAX_PASSIVE_REPLIES = 5;

/**
 * 按 key 串行执行，后到的任务等前一个跑完。
 *
 * 上下文是同群共享的可变状态，而「读历史 → 调模型 → 写回复」这一整段不能被别的消息插进来：
 * 插进来就会读到「有问题、还没答复」的中间态，历史错乱后模型会把自己的上一轮回答当成新问题，
 * 出现「自问自答」（中文社区有同构的踩坑记录）。CowAgent 的默认也是这个语义
 * （`concurrency_in_session: 1`，注释直写 >1 可能导致回复乱序）。
 */
export function createSerialQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    // 前一个任务失败也要继续排队，所以 onFulfilled / onRejected 都指向 task。
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return next;
  };
}

/**
 * QQ 单条文本长度有限，长回复按段落拆成多条发送（SDK 会自动递增 msg_seq）。
 * 段数也设上限：平台对同一 msg_id 的被动回复条数存在限制（具体数值官方未公开），
 * 超出的部分并入最后一条并标注截断。
 */
export function splitReply(text: string, max = MAX_REPLY_CHARS, maxChunks = 3): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max && chunks.length < maxChunks) {
    const head = rest.slice(0, max);
    const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("。"), head.lastIndexOf("；"));
    const at = cut > max * 0.5 ? cut + 1 : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }

  if (rest !== "") {
    if (chunks.length >= maxChunks) {
      // 段数已到上限：把剩余内容的提示并入最后一段，并让它整体仍不超过单段上限。
      const note = "…（内容过长，已截断）";
      const lastIndex = chunks.length - 1;
      const last = chunks[lastIndex]!;
      chunks[lastIndex] = `${last.slice(0, Math.max(1, max - note.length)).trimEnd()}${note}`;
    } else {
      chunks.push(rest);
    }
  }
  return chunks.filter((chunk) => chunk !== "");
}

/**
 * 暴露给模型的工具定义。个数与内容必须稳定，否则会破坏请求前缀缓存。
 *
 * `SEND_FOLLOWUP_TOOL` **故意不在这里**：工具本体与「每轮最多一条」的代码层限制都留着
 * （见 `src/tools.ts` 的 `createTurnTools`），但实测给模型这个出口并不减少漏答——
 * 用真实历史做对照、两臂各跑 8 次，漏答率都在 25%–40%，和不给时一样，代价是平均多
 * 0.4–0.8 条消息。所以「转交时把答案说清楚」改由提示词的硬规则来保证。
 */
export const EXPOSED_TOOLS = [FORWARD_FEEDBACK_TOOL];

export const PLATFORM_CONTEXT_LABEL =
  "[对话上下文] 平台给的背景：这条消息之前群里的最近几条消息，可能含其他成员的消息与附件。它是背景，不是这次要处理的新问题";

/**
 * 平台给的上下文渲染成一个内容片段。
 *
 * 这段文本是平台预渲染好的，没有发言人归属、也没有每条的发言时间，拼不出「轮次」，
 * 所以只能整段跟在问题后面当背景，不能塞进历史里当一轮。
 * 它的图片紧跟在说明文字之后——位置在说明之后，模型才能知道这些是背景里的图，不是这次发的。
 */
export function platformBackground(text: string): string {
  return `${PLATFORM_CONTEXT_LABEL}：\n${text}`;
}

export function buildUserText(args: {
  question: string;
  senderName?: string;
  skippedImages: number;
  /** 今天的读图额度已用完：要照常回答文字问题，但明确告诉用户图看不了了。 */
  imageQuotaExhausted?: boolean;
}): string {
  const lines: string[] = [];
  if (args.senderName) lines.push(`（发送者：${args.senderName}）`);
  // 【必须告知】放在问题前面：这个位置模型更容易照做（实测放在末尾时转交场景会漏）。
  // 约定标记的硬规则写在系统提示词里：出现这个标记，就必须把这句写进给用户的回复。
  if (args.skippedImages > 0) {
    lines.push(`【必须告知】另有 ${args.skippedImages} 张图片没能读取，请让用户重发或改用文字描述。`);
  }
  if (args.imageQuotaExhausted) {
    lines.push(
      "【必须告知】该用户今天的读图额度已经用完，这条消息里的图片没有被读取。" +
        "回复里必须带上这句意思（可直接用这句话）：「今天图片额度用完了，图我没读到」——" +
        "然后请他先用文字描述，或明天再发图。转交时也要写这句。",
    );
  }
  lines.push(args.question !== "" ? `问题：${args.question}` : "问题：（无文字，见上面的历史或下面的图片）");
  return lines.join("\n");
}

/** 读图额度用完时的固定告知句（模型漏说时由代码补上）。 */
const QUOTA_NOTICE = "今天图片额度用完了，图我没读到，麻烦先用文字描述一下，或者明天再发图喵~";
const QUOTA_MENTIONED = /额度|没读|读不了|读不到|明天再发图|明天再补/;

/**
 * 保证「读图额度用完」这件事一定被说出口。
 * 提示词里已经立了硬规则、还给了可照抄的句子，但实测在「转交」场景仍有约 1/3 会漏
 * （模型在工具调用之后只顾着写收尾话术），所以这里补一道确定性兜底：漏了就追加一句。
 */
export function ensureQuotaNotice(reply: string, quotaExhausted: boolean): string {
  if (!quotaExhausted || QUOTA_MENTIONED.test(reply)) return reply;
  return reply === "" ? QUOTA_NOTICE : `${reply}\n${QUOTA_NOTICE}`;
}

export interface QqDeps {
  cfg: Config;
  llm: LlmClient;
  forwarder: FeedbackForwarder;
  limits: Limits;
  history: History;
  systemPrompt: string;
}

export function createQqBot(deps: QqDeps): QQBot {
  const { cfg, llm, forwarder, limits, history, systemPrompt } = deps;
  const enqueue = createSerialQueue();
  const bot = new QQBot({
    appId: cfg.QQBOT_APP_ID,
    appSecret: cfg.QQBOT_APP_SECRET,
    logger: qqLogger,
  });

  // errorHandler 放在最前面：下游任何异常都会兜底回复一条友好提示，并重新抛出交给 bot.on("error") 记日志。
  bot.use(errorHandler({ format: () => "抱歉，这边刚出了点小问题，麻烦再发一次喵~", rethrow: true }));
  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 30_000, maxSize: 2_000 } }));
  // 不折叠空白：用户粘贴的报错日志/堆栈靠换行保持结构，折成一行会丢信息。
  // transform 兜底清洗十六进制形态的 @ 标记（SDK 内置规则只认纯数字形态）。
  bot.use(
    contentSanitizer({
      stripBotMention: true,
      transform: (content) => stripMentions(content),
    }),
  );
  bot.use(
    mentionGate({
      requireMentionInGroup: true,
      alwaysAnswerC2C: false,
      // 群里未 @机器人的消息：不回复，但要记进对话缓冲。
      // 平台在「获取群内全部消息」模式下会把普通消息也推过来（事件类型 GROUP_MESSAGE_CREATE），
      // 记下来之后，用户随后 @ 一句「这个怎么办」才接得上上文。
      onSkip: (ctx, decision) => {
        const m = ctx.message;
        dumpRawEvent("gate:skip", {
          reason: decision.reason,
          groupOpenid: m.groupOpenid,
          senderId: m.senderId,
          senderName: m.senderName,
          content: m.content,
          mentions: m.mentions,
          rawEventType: m.rawEventType,
        });
        if (m.kind !== "group") return;
        const text = (m.content ?? "").trim();
        const imageUrls = (m.attachments ?? [])
          .filter((att) => att.content_type?.startsWith("image/") && typeof att.url === "string")
          .map((att) => att.url);
        // 图片 URL 一并记下来：用户常常先发一张截图、再 @ 机器人提问，
        // 只有把图带上，模型才不会回答"截图我看不清"。
        const content = text !== "" ? text : imageUrls.length > 0 ? "（发了图片）" : "";
        if (content === "") return;
        history.record(m.groupOpenid ?? "", {
          at: Date.now(),
          role: "user",
          senderId: m.senderId,
          ...(m.senderName ? { senderName: m.senderName } : {}),
          content,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });
      },
    }),
  );
  // 频次与配额在 Limits 里统一处理（豁免用户需要跳过部分限制，SDK 的 rateLimiter 做不到条件豁免）。
  bot.use(quoteRef({ maxSize: 500 }));

  bot.on("ready", () => log.info("qq", "WebSocket 网关已连接"));
  bot.on("resumed", () => log.info("qq", "WebSocket 会话已恢复"));
  bot.on("error", (err) => log.error("qq", `网关错误：${err.message}`));
  // SDK 没内部处理的事件（新增事件类型、群设置相关通知等）都会落到这里。
  bot.on("rawEvent", (ctx) => dumpRawEvent(`rawEvent:${ctx.eventType}`, ctx.data));

  bot.on("message", async (ctx, msg) => {
    if (msg.kind !== "group") return;
    if (cfg.QQ_GROUP_OPENID && msg.groupOpenid !== cfg.QQ_GROUP_OPENID) {
      log.debug("qq", `忽略非目标群消息：group=${msg.groupOpenid ?? "?"}`);
      return;
    }

    // 同步申请配额：被拒时直接返回，不会下载图片、不会解析上下文、更不会调用模型。
    const decision = limits.reserve(msg.senderId, msg.groupOpenid);
    if (!decision.ok) {
      log.info("qq", `已限流（${decision.reason}）sender=${msg.senderId}`);
      if (decision.message && decision.reason && limits.shouldNotify(msg.senderId, decision.reason)) {
        await bot.sendText(msg.replyTarget, decision.message);
      }
      return;
    }

    // 同群串行：整段「读历史 → 调模型 → 写回复」不能被打断，否则后一条消息读到的是中间态。
    await enqueue(msg.groupOpenid ?? "", async () => {
      const quote = ctx.state.quote as ResolvedQuote | undefined;
      const platformContext = quote?.text
        ? splitContextAttachments(quote.text, {
            maxChars: cfg.CONTEXT_MAX_CHARS,
            maxPerMessage: cfg.CONTEXT_MESSAGE_MAX_CHARS,
          })
        : { text: "", imageUrls: [] as string[], truncated: false };
      const question = truncateText((msg.content ?? "").trim(), cfg.QUESTION_MAX_CHARS);
      const attachments: InboundAttachment[] = msg.attachments ?? [];
      const hasImage = attachments.some((att) => att.content_type?.startsWith("image/"));
      // 被引用消息里的图片（结构化附件），优先级高于平台上下文文本里的图片。
      const quotedImages = quotedImageUrls(quote?.attachments);

      // 历史渲染成真正的多轮 messages，图挂在它到来的那一轮上。
      // 必须在记录本轮提问**之前**渲染，否则当前问题会在历史里出现两次。
      const rendered = history.render(msg.groupOpenid ?? "", { speakerId: msg.senderId });

      // 群 openid 首次出现在日志里，方便填进 .env 的 QQ_GROUP_OPENID。
      log.info("qq", `收到群消息 group=${msg.groupOpenid ?? "?"} sender=${msg.senderId}`);
      log.info(
        "qq",
        rendered.turns.length === 0
          ? "本轮历史：无（新会话，或已超过会话窗口）"
          : `本轮历史：${rendered.turns.length} 轮` +
            (rendered.dropped > 0 ? `（另有 ${rendered.dropped} 条超出会话窗口或字符预算，未带上）` : ""),
      );
      dumpRawEvent("group-message", {
        rawEventType: msg.rawEventType,
        groupOpenid: msg.groupOpenid,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: question,
        mentions: msg.mentions,
        attachments: attachments.map((att) => ({ content_type: att.content_type, url: att.url })),
        msgElements: msg.msgElements,
        messageScene: msg.messageScene,
        context: {
          source: quote?.source,
          historyTurns: rendered.turns,
          platformText: platformContext.text,
          platformImageUrls: platformContext.imageUrls,
          trunc: platformContext.truncated,
        },
        raw: msg.raw,
      });

      // 完全空的消息（只 @ 了一下、没有文字/图片/历史）也交给模型自由发挥。
      const nothingAtAll =
        question === "" &&
        !hasImage &&
        quotedImages.length === 0 &&
        rendered.turns.length === 0 &&
        platformContext.text === "";
      const modelQuestion = nothingAtAll ? "（用户只 @ 了你，没有说任何内容）" : question;

      const started = Date.now();
      // 图片额度分两层：各来源的张数上限，以及单用户每日**新读**上限。
      // 额度按「真正下载了几张」算：同一张图第二次遇到就走缓存，不重复扣，
      // 否则用户发一张截图聊三句，今天的额度就用完了。
      const dailyBudget = limits.imageBudget(msg.senderId);
      let downloaded = 0;
      let skippedForQuota = 0;
      const newSlots = (): number => Math.max(0, dailyBudget - downloaded);
      const account = (batch: { downloaded: number; skippedForQuota: number }): void => {
        downloaded += batch.downloaded;
        skippedForQuota += batch.skippedForQuota;
      };
      // 同一个 URL 只喂一次：同一张图可能同时出现在当前消息、引用、历史、平台文本里。
      const usedUrls = new Set<string>();
      const takeNew = (urls: string[]): string[] =>
        urls.filter((url) => {
          const key = normalizeUrl(url);
          if (usedUrls.has(key)) return false;
          usedUrls.add(key);
          return true;
        });
      const toParts = (images: PreparedImage[]): MessagePart[] => images.map((image) => ({ image: image.dataUrl }));

      // 1) 当前消息自带的附件
      const prepared = await prepareImages(attachments, cfg, cfg.IMG_MAX_COUNT, newSlots());
      account(prepared);
      // 只把**真的取到**的标成已用：下载失败的那张留给后面的来源再试一次。
      takeNew(prepared.images.map((image) => image.url));

      // 2) 被引用消息里的图片（平台不会把它渲染进上下文文本，必须单独读）
      const fromQuote = await prepareImageUrls(takeNew(quotedImages), cfg, cfg.IMG_MAX_COUNT, newSlots());
      account(fromQuote);

      // 3) 历史轮次：图挂在**它自己那一轮**上，不挪到当前轮——位置本身就是模型区分新旧的依据
      const historyTurns: LlmTurn[] = [];
      let historyImageCount = 0;
      for (const turn of rendered.turns) {
        const role = turn.role === "bot" ? ("assistant" as const) : ("user" as const);
        const toolRounds = turn.toolRounds.length > 0 ? { toolRounds: turn.toolRounds } : {};
        if (turn.images.length === 0) {
          historyTurns.push({ role, parts: [{ text: turn.text }], ...toolRounds });
          continue;
        }
        const batch = await prepareImageUrls(takeNew(turn.images), cfg, turn.images.length, newSlots());
        account(batch);
        historyImageCount += batch.images.length;
        historyTurns.push({ role, parts: [{ text: turn.text }, ...toParts(batch.images)], ...toolRounds });
      }

      // 4) 平台上下文里的图片：平台那段文本拼不出轮次，只能整段当背景，图紧跟在说明之后
      const fromContext = await prepareImageUrls(
        platformContext.text !== "" ? takeNew(platformContext.imageUrls) : [],
        cfg,
        cfg.IMG_MAX_COUNT,
        newSlots(),
      );
      account(fromContext);

      const skippedImages = prepared.skipped + Math.max(0, quotedImages.length - fromQuote.images.length);
      const quotaExhausted = skippedForQuota > 0;
      if (downloaded > 0) limits.consumeImages(msg.senderId, downloaded);
      if (quotaExhausted) {
        log.info("qq", `读图额度已用完（今日上限 ${cfg.IMG_DAILY_LIMIT_PER_USER} 张），本次放弃 ${skippedForQuota} 张`);
      }

      const userParts: MessagePart[] = [
        {
          text: buildUserText({
            question: modelQuestion,
            senderName: msg.senderName,
            skippedImages,
            ...(quotaExhausted ? { imageQuotaExhausted: true } : {}),
          }),
        },
        ...toParts(prepared.images),
        ...toParts(fromQuote.images),
      ];
      if (platformContext.text !== "") {
        userParts.push({ text: platformBackground(platformContext.text) });
        userParts.push(...toParts(fromContext.images));
      }

      // 记录本轮提问：放在渲染历史之后，当前问题才不会在历史里出现两次。
      history.record(msg.groupOpenid ?? "", {
        at: Date.now(),
        role: "user",
        senderId: msg.senderId,
        ...(msg.senderName ? { senderName: msg.senderName } : {}),
        content: question !== "" ? question : hasImage ? "（发了图片）" : "（只 @ 了机器人，没有说话）",
        ...(attachments.some((att) => att.content_type?.startsWith("image/"))
          ? {
              imageUrls: attachments
                .filter((att) => att.content_type?.startsWith("image/") && typeof att.url === "string")
                .map((att) => att.url),
            }
          : {}),
      });

      const tools = createTurnTools(forwarder, {
        msgId: msg.messageId,
        senderId: msg.senderId,
        exemptHourlyLimit: decision.isPrivileged,
      });
      const result = await llm.complete(
        {
          history: historyTurns,
          userParts,
          tools: EXPOSED_TOOLS,
          execTool: tools.exec,
        },
        systemPrompt,
      );

      const reply = ensureQuotaNotice(
        result.text !== ""
          ? result.text
          : result.forwarded
            ? "已经转交给人工了，正在处理中喵~"
            : "呜……我暂时没找到答案，换个说法再问一次好不好喵~",
        quotaExhausted,
      );
      // 有补充消息时先给它留一条：主回复的分段数 + 补充消息要一起落在平台那 5 条以内。
      const maxMainChunks = Math.max(1, Math.min(cfg.REPLY_MAX_CHUNKS, MAX_PASSIVE_REPLIES - tools.followups.length));
      for (const chunk of splitReply(reply, MAX_REPLY_CHARS, maxMainChunks)) {
        await bot.sendText(msg.replyTarget, chunk);
      }
      // 补充消息在主回复**之后**单独发出。当前没有把 send_followup 暴露给模型，
      // 所以 tools.followups 恒为空——这段留着是为了让工具随时能重新启用（见 EXPOSED_TOOLS）。
      for (const extra of tools.followups) {
        log.info("qq", `补充消息：${extra.slice(0, 60)}`);
        for (const chunk of splitReply(extra, MAX_REPLY_CHARS, 1)) {
          await bot.sendText(msg.replyTarget, chunk);
        }
      }
      // 回复与**这一轮做过的工具调用**都要进历史：前者让用户接着追问时模型知道自己说过什么，
      // 后者让它知道自己已经转过人工、转过谁——少了它就会出现同一个问题重复转交。
      history.record(msg.groupOpenid ?? "", {
        at: Date.now(),
        role: "bot",
        content: reply,
        ...(result.toolRounds.length > 0 ? { toolRounds: result.toolRounds } : {}),
      });
      log.info(
        "qq",
        `回复完成 ${Date.now() - started}ms｜转交=${result.forwarded}｜工具轮 ${result.toolRounds.length}` +
          `（${result.toolRounds.flatMap((r) => r.calls.map((c) => c.name)).join(",") || "无"}）` +
          `｜历史 ${historyTurns.length} 轮（历史图 ${historyImageCount} 张）｜本图 消息 ${prepared.images.length}/${attachments.length}` +
          `、引用 ${fromQuote.images.length}/${quotedImages.length}｜新读 ${downloaded} 张` +
          `（缓存 ${prepared.cached + fromQuote.cached + fromContext.cached}）｜平台背景=${platformContext.text !== ""}`,
      );
    });
  });

  return bot;
}
