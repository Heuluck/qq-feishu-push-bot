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
import type { LlmClient } from "./llm.js";
import { log, qqLogger } from "./log.js";
import { prepareImageUrls, prepareImages, quotedImageUrls } from "./media.js";
import type { InboundAttachment } from "./media.js";
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

export function buildUserText(args: {
  question: string;
  contextText?: string;
  contextLabel?: string;
  senderName?: string;
  skippedImages: number;
}): string {
  const lines: string[] = [];
  if (args.senderName) lines.push(`（发送者：${args.senderName}）`);
  lines.push(args.question !== "" ? `问题：${args.question}` : "问题：（无文字，见下面的上下文或图片）");
  if (args.contextText) {
    lines.push(args.contextLabel ?? PLATFORM_CONTEXT_LABEL);
    lines.push(args.contextText);
  }
  if (args.skippedImages > 0) lines.push(`（另有 ${args.skippedImages} 张图片未能读取）`);
  return lines.join("\n");
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
        const hasImage = (m.attachments ?? []).some((att) => att.content_type?.startsWith("image/"));
        const content = text !== "" ? text : hasImage ? "（发了图片）" : "";
        if (content === "") return;
        history.record(m.groupOpenid ?? "", {
          at: Date.now(),
          role: "user",
          ...(m.senderName ? { senderName: m.senderName } : {}),
          content,
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
      // 平台给了上下文就用平台的（它还能看到非 @ 消息与图片），没给就退回本地缓冲。
      const localContext = history.render(msg.groupOpenid ?? "");
      const usePlatform = platformContext.text !== "";
      const contextText = usePlatform ? platformContext.text : localContext;
      const contextLabel = usePlatform ? PLATFORM_CONTEXT_LABEL : LOCAL_CONTEXT_LABEL;
      const contextSource = usePlatform ? "平台" : localContext !== "" ? "本地缓冲" : "无";
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
      const prepared = await prepareImages(attachments, cfg);
      // 图片配额按优先级分配：当前消息附件 → 引用的图片 → 平台上下文文本里的图片。
      const slotsAfterMessage = Math.max(0, cfg.IMG_MAX_COUNT - prepared.images.length);
      const fromQuote = slotsAfterMessage > 0 ? await prepareImageUrls(quotedImages, cfg, slotsAfterMessage) : [];
      const slotsAfterQuote = Math.max(0, cfg.IMG_MAX_COUNT - prepared.images.length - fromQuote.length);
      const fromContext =
        slotsAfterQuote > 0 && usePlatform
          ? await prepareImageUrls(platformContext.imageUrls, cfg, slotsAfterQuote)
          : [];
      const images = [...prepared.images, ...fromQuote, ...fromContext];
      const skippedImages =
        prepared.skipped +
        Math.max(0, quotedImages.length - fromQuote.length) +
        Math.max(0, platformContext.imageUrls.length - fromContext.length);

      // 先渲染上下文、再记录本轮提问，避免当前问题在上下文里出现两次。
      history.record(msg.groupOpenid ?? "", {
        at: Date.now(),
        role: "user",
        ...(msg.senderName ? { senderName: msg.senderName } : {}),
        content: question !== "" ? question : hasImage ? "（发了图片）" : "（只 @ 了机器人，没有说话）",
      });

      const result = await llm.complete(
        {
          userText: buildUserText({
            question: modelQuestion,
            contextText,
            contextLabel,
            senderName: msg.senderName,
            skippedImages,
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

      const reply =
        result.text !== ""
          ? result.text
          : result.forwarded
            ? "已经转交给人工了，正在处理中喵~"
            : "呜……我暂时没找到答案，换个说法再问一次好不好喵~";
      for (const chunk of splitReply(reply, MAX_REPLY_CHARS, cfg.REPLY_MAX_CHUNKS)) {
        await bot.sendText(msg.replyTarget, chunk);
      }
      history.record(msg.groupOpenid ?? "", { at: Date.now(), role: "bot", content: reply });
      log.info(
        "qq",
        `回复完成 ${Date.now() - started}ms｜转交=${result.forwarded}｜图片=${images.length}（消息附件 ${prepared.images.length}/${attachments.length}，引用 ${fromQuote.length}/${quotedImages.length}，上下文 ${fromContext.length}/${platformContext.imageUrls.length}）｜上下文来源=${contextSource}`,
      );
    }
  });

  return bot;
}
