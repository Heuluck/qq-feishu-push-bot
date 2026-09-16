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
import { hhmm } from "./history.js";
import type { History } from "./history.js";
import type { Limits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { log, qqLogger } from "./log.js";
import { normalizeUrl, prepareImageUrls, prepareImages, quotedImageUrls } from "./media.js";
import type { InboundAttachment, PreparedImage } from "./media.js";
import { stripMentions, truncateText } from "./text.js";
import { FORWARD_FEEDBACK_TOOL, createToolExecutor } from "./tools.js";

/** 单条回复的分段长度。 */
const MAX_REPLY_CHARS = 1600;

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

export const PLATFORM_CONTEXT_LABEL =
  "[对话上下文] 这条消息之前群里的最近几条消息（含机器人此前的回复，可能含其他成员的消息与附件）：";
export const LOCAL_CONTEXT_LABEL =
  "[近期对话记录] 本机器人记录的本群最近交互（用户 @ 消息与机器人的回复），按时间从早到晚：";
export const OWN_REPLIES_LABEL =
  "[机器人自己说过的话] 平台给的上下文里没有这一段，由本机器人补记，用来避免重复回答已经答过的问题：";

/** 本轮图片的来源，写进提示词让模型知道每张图是新的还是翻出来的旧图。 */
const IMAGE_ORIGINS = {
  message: "来自当前这条消息",
  quote: "来自被引用的那条消息",
  history: (at: number): string => `是该用户 ${hhmm(at)} 发在群里的历史图片`,
  context: "来自平台给的上下文",
} as const;

/** 本轮要喂的一张图 + 它在提示词里的来源说明。 */
interface TurnImage extends PreparedImage {
  origin: string;
}

/**
 * 向模型交代本轮图片的来源与时间。
 *
 * 只说「有图」不够：实测模型会把从上下文里翻出来的旧截图当成当前消息的新证据——
 * 用户已经说「已经改好了」（话题是补卡），模型手里那张 25 分钟前的崩溃截图还在，
 * 于是回了「看你发的截图还是会弹严重错误崩溃」，并因此误转交了一次人工。
 * 全是当前消息自带的图时不必解释，那是默认理解，说了只是噪音。
 */
export function imageNotes(images: TurnImage[]): string {
  if (images.length === 0 || images.every((image) => image.origin === IMAGE_ORIGINS.message)) return "";
  const describes = images.map((image, index) => `第 ${index + 1} 张${image.origin}`);
  return (
    `【本轮图片】共 ${images.length} 张，按顺序：${describes.join("；")}。` +
    "不是来自当前这条消息的图可能已经答复过，只在确实与当前问题相关时才作为依据。"
  );
}

export function buildUserText(args: {
  question: string;
  contextText?: string;
  contextLabel?: string;
  senderName?: string;
  skippedImages: number;
  /** 今天的读图额度已用完：要照常回答文字问题，但明确告诉用户图看不了了。 */
  imageQuotaExhausted?: boolean;
  /** 本轮图片的来源与时间说明（见 {@link imageNotes}）。 */
  imageNote?: string;
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
  lines.push(args.question !== "" ? `问题：${args.question}` : "问题：（无文字，见下面的上下文或图片）");
  if (args.imageNote) lines.push(args.imageNote);
  if (args.contextText) {
    lines.push(args.contextLabel ?? PLATFORM_CONTEXT_LABEL);
    lines.push(args.contextText);
  }
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

    {
      const quote = ctx.state.quote as ResolvedQuote | undefined;
      const platformContext = quote?.text
        ? splitContextAttachments(quote.text, {
            maxChars: cfg.CONTEXT_MAX_CHARS,
            maxPerMessage: cfg.CONTEXT_MESSAGE_MAX_CHARS,
          })
        : { text: "", imageUrls: [] as string[], truncated: false };
      // 平台给了上下文就用平台的（它还能看到非 @ 消息与图片），同时不能丢机器人自己说过的话：
      // 平台那段附件覆盖不到机器人自己的回复，缺了它就会出现「上一轮已经答过、这一轮又从头答一遍」。
      const localContext = history.render(msg.groupOpenid ?? "");
      const usePlatform = platformContext.text !== "";
      const ownReplies = usePlatform ? history.recentBotReplies(msg.groupOpenid ?? "", platformContext.text) : [];
      const contextText = usePlatform
        ? [platformContext.text, ownReplies.length > 0 ? `${OWN_REPLIES_LABEL}\n${ownReplies.join("\n")}` : ""]
            .filter((part) => part !== "")
            .join("\n")
        : localContext;
      const contextLabel = usePlatform ? PLATFORM_CONTEXT_LABEL : LOCAL_CONTEXT_LABEL;
      const contextSource = usePlatform
        ? ownReplies.length > 0
          ? `平台+自记回复 ${ownReplies.length} 条`
          : "平台"
        : localContext !== ""
          ? "本地缓冲"
          : "无";
      const question = truncateText((msg.content ?? "").trim(), cfg.QUESTION_MAX_CHARS);
      const attachments: InboundAttachment[] = msg.attachments ?? [];
      const hasImage = attachments.some((att) => att.content_type?.startsWith("image/"));
      // 被引用消息里的图片（结构化附件），优先级高于平台上下文文本里的图片。
      const quotedImages = quotedImageUrls(quote?.attachments);

      // 群 openid 首次出现在日志里，方便填进 .env 的 QQ_GROUP_OPENID。
      log.info("qq", `收到群消息 group=${msg.groupOpenid ?? "?"} sender=${msg.senderId}`);
      log.info(
        "qq",
        contextText === ""
          ? "本轮上下文：无"
          : `本轮上下文：${contextText.length} 字符，来源=${contextSource}${platformContext.truncated ? "（平台内容已截断）" : ""}`,
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
          platformText: platformContext.text,
          platformImageUrls: platformContext.imageUrls,
          trunc: platformContext.truncated,
          localText: localContext,
        },
        raw: msg.raw,
      });

      // 完全空的消息（只 @ 了一下、没有文字/图片/上下文）也交给模型自由发挥，
      // 不再用固定的模板文案。
      const nothingAtAll = question === "" && !hasImage && quotedImages.length === 0 && contextText === "";
      const modelQuestion = nothingAtAll ? "（用户只 @ 了你，没有说任何内容）" : question;

      const started = Date.now();
      // 图片配额有两层：单次上限（消息/引用 2 张、上下文 5 张）与单用户每日读取上限。
      // 每日额度用完时不读图，但仍然回答文字问题，并在提示里说明额度已用完。
      const dailyBudget = limits.imageBudget(msg.senderId);
      const images: TurnImage[] = [];
      const slotsLeft = (): number => dailyBudget - images.length;

      const prepared = await prepareImages(attachments, cfg, Math.min(cfg.IMG_MAX_COUNT, slotsLeft()));
      // 同一个 URL 只取一次：同一张图可能同时出现在多个来源里，重复喂等于白花钱。
      const usedUrls = new Set(
        attachments
          .filter((att) => att.content_type?.startsWith("image/") && typeof att.url === "string")
          .slice(0, cfg.IMG_MAX_COUNT)
          .map((att) => normalizeUrl(att.url)),
      );

      // 同一个 URL 只取一次：同一张图可能同时出现在多个来源里，重复喂等于白花钱。
      // 各来源的张数上限由各自的 prepareImageUrls 负责，这里只管去重。
      const takeNew = (urls: string[]): string[] =>
        urls.filter((url) => {
          const key = normalizeUrl(url);
          if (usedUrls.has(key)) return false;
          usedUrls.add(key);
          return true;
        });

      images.push(...prepared.images.map((image) => ({ ...image, origin: IMAGE_ORIGINS.message })));
      const quoteSlots = Math.max(0, Math.min(cfg.IMG_MAX_COUNT - images.length, slotsLeft()));
      const quoteCandidates = quoteSlots > 0 ? takeNew(quotedImages) : [];
      const fromQuote = await prepareImageUrls(quoteCandidates, cfg, quoteSlots);
      images.push(...fromQuote.map((image) => ({ ...image, origin: IMAGE_ORIGINS.quote })));

      // 「用户先发截图、再 @ 提问」时，截图只存在于缓冲里：按「该用户最近的图」找，
      // 不受消息条数限制（中间夹了别人的消息也能找到），最多 IMG_CONTEXT_MAX_COUNT 张。
      // 已经答复过、或超过 IMG_CONTEXT_MAX_AGE_MINUTES 分钟的图不再带上——见 pendingImages。
      const historySlots = Math.max(0, Math.min(cfg.IMG_CONTEXT_MAX_COUNT, slotsLeft()));
      const pendingImages =
        historySlots > 0 ? history.pendingImages(msg.groupOpenid ?? "", msg.senderId, historySlots) : [];
      // 按 URL 回查每张图是什么时候发的，交给 imageNotes 写进提示词。
      const sentAt = new Map(pendingImages.map((item) => [item.url, item.at]));
      const historyCandidates = takeNew(pendingImages.map((item) => item.url));
      const fromHistory = await prepareImageUrls(historyCandidates, cfg, historySlots);
      images.push(
        ...fromHistory.map((image) => ({
          ...image,
          origin: IMAGE_ORIGINS.history(sentAt.get(image.url) ?? Date.now()),
        })),
      );

      const contextSlots = Math.max(0, Math.min(cfg.IMG_MAX_COUNT, slotsLeft()));
      const contextCandidates = contextSlots > 0 && usePlatform ? takeNew(platformContext.imageUrls) : [];
      const fromContext = await prepareImageUrls(contextCandidates, cfg, contextSlots);
      images.push(...fromContext.map((image) => ({ ...image, origin: IMAGE_ORIGINS.context })));

      const imageCandidates =
        prepared.total + quotedImages.length + historyCandidates.length + platformContext.imageUrls.length;
      const skippedImages =
        prepared.skipped +
        Math.max(0, quotedImages.length - fromQuote.length) +
        Math.max(0, platformContext.imageUrls.length - fromContext.length);
      // 每日读图额度用完（且本来有图可读）→ 让模型在回复里告诉用户
      const quotaExhausted = images.length >= dailyBudget && imageCandidates > images.length;
      if (images.length > 0) limits.consumeImages(msg.senderId, images.length);
      if (quotaExhausted) {
        log.info("qq", `读图额度已用完（今日上限 ${cfg.IMG_DAILY_LIMIT_PER_USER} 张），本次仅读 ${images.length} 张`);
      }

      // 先渲染上下文、再记录本轮提问，避免当前问题在上下文里出现两次。
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
      // 这一轮真正喂进去的图都记成「已答复」，下一轮不再重复注入（见 History.pendingImages）。
      // 必须在 record 之后调用：当前这条消息刚记进去，它自带的图也要一起标记。
      history.markImagesAnswered(
        msg.groupOpenid ?? "",
        images.map((image) => image.url),
      );

      const note = imageNotes(images);
      const result = await llm.complete(
        {
          userText: buildUserText({
            question: modelQuestion,
            contextText,
            contextLabel,
            senderName: msg.senderName,
            skippedImages,
            ...(quotaExhausted ? { imageQuotaExhausted: true } : {}),
            ...(note !== "" ? { imageNote: note } : {}),
          }),
          images: images.map((image) => image.dataUrl),
          tool: FORWARD_FEEDBACK_TOOL,
          execTool: createToolExecutor(forwarder, {
            msgId: msg.messageId,
            senderId: msg.senderId,
            exemptHourlyLimit: decision.isPrivileged,
          }),
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
      for (const chunk of splitReply(reply, MAX_REPLY_CHARS, cfg.REPLY_MAX_CHUNKS)) {
        await bot.sendText(msg.replyTarget, chunk);
      }
      history.record(msg.groupOpenid ?? "", { at: Date.now(), role: "bot", content: reply });
      log.info(
        "qq",
        `回复完成 ${Date.now() - started}ms｜转交=${result.forwarded}｜图片=${images.length}（消息附件 ${prepared.images.length}/${attachments.length}，引用 ${fromQuote.length}/${quotedImages.length}，缓冲 ${fromHistory.length}，上下文 ${fromContext.length}/${platformContext.imageUrls.length}）｜上下文来源=${contextSource}`,
      );
    }
  });

  return bot;
}
