/**
 * QQ 侧的装配：中间件顺序、限流入口，以及「读历史 → 准备图片 → 调模型 → 发回复 → 写历史」这条主链路。
 *
 * 与 SDK 无关的纯逻辑分在 `./queue.ts`（排队与到达簿记）、`./reply.ts`（回复组装与发送）、
 * `./context.ts`（平台上下文解析）、`./media.ts`（图片处理）。
 */
import {
  MsgType,
  QQBot,
  contentSanitizer,
  errorHandler,
  mentionGate,
  messageFilter,
  quoteRef,
} from "@tencent-connect/qqbot-nodejs";
import type { ResolvedQuote } from "@tencent-connect/qqbot-nodejs";
import type { Config } from "../core/config.js";
import { log, qqLogger } from "../core/log.js";
import { stripMentions, truncateText } from "../core/text.js";
import type { LlmClient } from "../llm/client.js";
import type { LlmTurn, MessagePart } from "../llm/messages.js";
import { EXPOSED_TOOLS, createTurnTools } from "../llm/tools.js";
import type { FeedbackForwarder } from "../lark/forwarder.js";
import { dumpRawEvent } from "../store/debugDump.js";
import type { History } from "../store/history.js";
import type { Limits } from "../store/limits.js";
import { splitContextAttachments } from "./context.js";
import { normalizeUrl, prepareImageUrls, prepareImages, quotedImageUrls } from "./media.js";
import type { InboundAttachment, PreparedImage } from "./media.js";
import {
  MAX_PASSIVE_REPLIES,
  MAX_REPLY_CHARS,
  buildUserText,
  ensureQuotaNotice,
  platformBackground,
  sendMainReply,
  splitReply,
} from "./reply.js";
import { createArrivalTracker, createSerialQueue, needsQuote } from "./queue.js";

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
  const arrivals = createArrivalTracker();
  const bot = new QQBot({
    appId: cfg.QQBOT_APP_ID,
    appSecret: cfg.QQBOT_APP_SECRET,
    logger: qqLogger,
  });

  // errorHandler 放在最前面：下游任何异常都会兜底回复一条友好提示，并重新抛出交给 bot.on("error") 记日志。
  bot.use(errorHandler({ format: () => "抱歉，这边刚出了点小问题，麻烦再发一次喵~", rethrow: true }));
  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 30_000, maxSize: 2_000 } }));
  // 每条进来的群消息先记一笔（含不 @ 机器人的普通消息），发送前据此判断这期间群里有没有人插话。
  // 放在 messageFilter 之后：机器人自己的回显与被去重的重复推送不算「新消息」。
  bot.use((ctx, next) => {
    const m = ctx.message;
    if (m.kind === "group") ctx.state["arrivalSeq"] = arrivals.mark(m.groupOpenid ?? "");
    return next();
  });
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
        // 与 message 处理里的目标群过滤保持一致：别的群的闲聊不该进对话缓冲，
        // 否则机器人所在的群越多，data/history.json 被无关消息撑得越大。
        if (cfg.QQ_GROUP_OPENID && m.groupOpenid !== cfg.QQ_GROUP_OPENID) return;
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
  // 这里的 contentLimit 是**单条被引消息存多少字**（SDK 默认只有 200）：平台没下发 msg_elements 时
  // 引用只能从这个索引里取，默认 200 字会让「引用一条长消息」时模型只看到开头。
  // 注意别把 maxSize 当成字符上限——那是索引的 LRU 条数（默认 500，够用）。
  bot.use(quoteRef({ contentLimit: cfg.CONTEXT_MESSAGE_MAX_CHARS }));

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

    // 这条消息进来时的序号（上面那个中间件记的）。发送前拿它判断期间群里有没有人插话。
    const myArrivalSeq = ctx.state["arrivalSeq"];

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
      // 额度按**图片本身**计（同一张图今天只扣一次，见 Limits.consumeImage）：只按「这一轮下载了
      // 几张」计的话，缓存被淘汰后重新下载同一张图会反复扣，用户聊三句当天额度就没了。
      let skippedForQuota = 0;
      let downloadedTotal = 0;
      let chargedNew = 0;
      const newSlots = (): number => limits.imageBudget(msg.senderId);
      /** 这张图今天是否已经计过额度（额度不足时，已读过的旧图仍要能出现在历史里）。 */
      const alreadyCharged = (key: string): boolean => limits.imageCharged(msg.senderId, key);
      /** 真正读到（含缓存命中）才计额度；同一张图重复遇到不会重复扣。 */
      const chargeImages = (images: PreparedImage[]): void => {
        for (const image of images) {
          if (limits.consumeImage(msg.senderId, normalizeUrl(image.url))) chargedNew += 1;
        }
      };
      const account = (batch: { downloaded: number; skippedForQuota: number }): void => {
        downloadedTotal += batch.downloaded;
        skippedForQuota += batch.skippedForQuota;
      };
      // 同一个 URL 只喂一次：同一张图可能同时出现在当前消息、引用、历史、平台文本里。
      // takeNew 只**看一眼**是否已喂过，真正标记发生在取到图之后（markUsed）——
      // 下载失败的图要留给后面的来源再试一次。
      const usedUrls = new Set<string>();
      const takeNew = (urls: string[]): string[] => urls.filter((url) => !usedUrls.has(normalizeUrl(url)));
      const markUsed = (images: PreparedImage[]): void => {
        for (const image of images) usedUrls.add(normalizeUrl(image.url));
      };
      const toParts = (images: PreparedImage[]): MessagePart[] => images.map((image) => ({ image: image.dataUrl }));

      // 1) 当前消息自带的附件
      const prepared = await prepareImages(attachments, cfg, cfg.IMG_MAX_COUNT, newSlots(), alreadyCharged);
      account(prepared);
      chargeImages(prepared.images);
      markUsed(prepared.images);

      // 2) 被引用消息里的图片（平台不会把它渲染进上下文文本，必须单独读）
      const quoteCandidates = takeNew(quotedImages);
      const fromQuote = await prepareImageUrls(quoteCandidates, cfg, cfg.IMG_MAX_COUNT, newSlots(), alreadyCharged);
      account(fromQuote);
      chargeImages(fromQuote.images);
      markUsed(fromQuote.images);

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
        const batch = await prepareImageUrls(takeNew(turn.images), cfg, turn.images.length, newSlots(), alreadyCharged);
        account(batch);
        chargeImages(batch.images);
        markUsed(batch.images);
        historyImageCount += batch.images.length;
        historyTurns.push({ role, parts: [{ text: turn.text }, ...toParts(batch.images)], ...toolRounds });
      }

      // 4) 平台上下文里的图片：平台那段文本拼不出轮次，只能整段当背景，图紧跟在说明之后
      const fromContext = await prepareImageUrls(
        platformContext.text !== "" ? takeNew(platformContext.imageUrls) : [],
        cfg,
        cfg.IMG_MAX_COUNT,
        newSlots(),
        alreadyCharged,
      );
      account(fromContext);
      chargeImages(fromContext.images);
      markUsed(fromContext.images);

      // 「没能读取」只算真的试过却没拿到的，且**不含额度原因**：
      //   - 被别的来源先喂过的同一张图不算（那是去重，用户看到的图还在）；
      //   - 额度挡下的另有专门一句告知（「明天再发图」），混进来会变成让用户「重发一遍」——
      //     可额度没恢复，重发也读不到。
      const skippedImages =
        prepared.skipped -
        prepared.skippedForQuota +
        Math.max(0, quoteCandidates.length - fromQuote.images.length - fromQuote.skippedForQuota);
      // 额度是否用完了（可能是本条消息、也可能是更早的图占了额度）…
      const quotaExhausted = skippedForQuota > 0;
      // …但只有本条消息（含它引用的消息）的图确实被额度挡下时，才能说「这条消息里的图片没被读取」。
      const quotaSkippedCurrentImages = prepared.skippedForQuota + fromQuote.skippedForQuota > 0;
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
            ...(quotaSkippedCurrentImages ? { quotaSkippedCurrentImages: true } : {}),
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
        quotaSkippedCurrentImages,
      );
      // 有补充消息时先给它留一条：主回复的分段数 + 补充消息要一起落在平台那 5 条以内。
      const maxMainChunks = Math.max(1, Math.min(cfg.REPLY_MAX_CHUNKS, MAX_PASSIVE_REPLIES - tools.followups.length));
      // 从收到这条 @ 消息、到答案生成完毕，中间群里又有人说话 → 被动回复会飘在新消息上面，
      // 群里看不出这句话是回谁的。这时给正文带上 message_reference，引用回那条 @ 消息。
      // 判断全在代码里做：模型不参与，也不需要它产出引用；补充消息不引用。
      const quoteTrigger = needsQuote(arrivals, msg.groupOpenid ?? "", myArrivalSeq);
      if (quoteTrigger) log.info("qq", "这期间群里又进了消息，回复将引用那条 @ 消息");
      await sendMainReply(
        {
          plain: (content) => bot.sendText(msg.replyTarget, content),
          quoted: (content) =>
            bot.send({
              target: msg.replyTarget,
              msgType: MsgType.TEXT,
              content,
              messageReference: { message_id: msg.messageId },
            }),
        },
        splitReply(reply, MAX_REPLY_CHARS, maxMainChunks),
        quoteTrigger,
      );
      // 补充消息在主回复**之后**单独发出：模型想「答案一条、转交说明一条」时用它。
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
          `｜引用那条@=${quoteTrigger ? "是" : "否"}` +
          `｜历史 ${historyTurns.length} 轮（历史图 ${historyImageCount} 张）｜本图 消息 ${prepared.images.length}/${attachments.length}` +
          `、引用 ${fromQuote.images.length}/${quoteCandidates.length}｜下载 ${downloadedTotal} 张` +
          `、新计额度 ${chargedNew} 张（缓存 ${prepared.cached + fromQuote.cached + fromContext.cached}）` +
          `｜平台背景=${platformContext.text !== ""}`,
      );
    });
  });

  return bot;
}
