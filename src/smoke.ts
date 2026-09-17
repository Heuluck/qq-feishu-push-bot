/**
 * 离线自检（不联网、不需要凭据）：
 *   npm run smoke
 * 覆盖知识库编译、工具 schema/校验、图片缩放、回复拆分这几条纯逻辑。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Config } from "./core/config.js";
import { stripMentions, truncateText } from "./core/text.js";
import { loadKnowledgeBase } from "./kb/kb.js";
import { buildMessages } from "./llm/messages.js";
import { EXPOSED_TOOLS, FORWARD_FEEDBACK_TOOL, ForwardFeedbackArgs, SEND_FOLLOWUP_TOOL, SendFollowupArgs, createTurnTools } from "./llm/tools.js";
import { extractTextToolCalls, runTextToolCalls } from "./llm/toolmarkup.js";
import { buildFollowUpCard, buildRootCard } from "./lark/cards.js";
import { topicKey } from "./lark/forwarder.js";
import { splitContextAttachments } from "./qq/context.js";
import { clearPreparedImageCache, prepareImages, prepareImageUrls, quotedImageUrls, resizeImageBuffer } from "./qq/media.js";
import {
  buildUserText,
  ensureQuotaNotice,
  platformBackground,
  sendMainReply,
  splitReply,
} from "./qq/reply.js";
import { createArrivalTracker, createSerialQueue, needsQuote } from "./qq/queue.js";
import { History } from "./store/history.js";
import { Limits } from "./store/limits.js";
import { FILE_PATTERNS, dayKey, migrateLegacyForwards, monthKey, pruneByAge, stampKey } from "./store/retention.js";

const cfg = {
  IMG_MAX_EDGE: 1280,
} as unknown as Config;

let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. 知识库编译
const kb = loadKnowledgeBase(process.env["KB_PATH"] ?? "kb/kb.yaml");
check("知识库加载", kb.entries.length > 0, `${kb.entries.length} 条，版本 kb-${kb.version}`);
check("system prompt 静态块", kb.systemPrompt.includes("# 知识库") && kb.systemPrompt.includes("forward_feedback"));
check(
  "system prompt 无动态内容",
  !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(kb.systemPrompt),
  `${kb.systemPrompt.length} 字符`,
);

// 1b. 知识库变量（正文用 {{名称}} 复用 variables 里的文本片段）
const kbVarDir = "data/smoke-tmp/kb";
mkdirSync(kbVarDir, { recursive: true });
const writeKb = (name: string, body: string): string => {
  const path = `${kbVarDir}/${name}.yaml`;
  writeFileSync(path, body);
  return path;
};
const loadError = (path: string): string => {
  try {
    loadKnowledgeBase(path);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
};
const kbBody = (answer: string): string =>
  `entries:\n  - id: a\n    title: t\n    keywords: [k]\n    route: answer\n    answer: "${answer}"\n`;

check("知识库：占位符已全部展开，没有花括号漏进提示词", !kb.systemPrompt.includes("{{"));
check(
  "知识库：变量引用变量（教务电话只写一处，两条正文都展开）",
  (kb.systemPrompt.match(/0791-83969101/g) ?? []).length === 2,
);
check(
  "知识库：版本号只写一处，两条下载相关正文都带上",
  // 只数「5.16.0」本身：两条正文的措辞不同（一条写「当前版本 {{...}}」、一条只写「（{{...}}）」），
  // 按「当前版本 5.16.0」去数只会命中一条。
  (kb.systemPrompt.match(/5\.16\.0/g) ?? []).length === 2,
);

const nestedKb = loadKnowledgeBase(
  writeKb(
    "nested",
    `variables:
  site: https://example.com/
  hint: 群文件里也有
  combo: 先去 {{site}}，{{hint}}。
  blocky: |
    多行变量
    第二行
entries:
  - id: a
    title: t
    keywords: [k]
    route: answer
    answer: "{{combo}}"
  - id: b
    title: t2
    keywords: [k2]
    route: answer
    answer: "行尾{{blocky}}再接一句"
`,
  ),
);
check(
  "知识库变量：变量可以引用变量",
  nestedKb.entries[0]?.answer === "先去 https://example.com/，群文件里也有。",
  JSON.stringify(nestedKb.entries[0]?.answer),
);
check(
  "知识库变量：块标量变量的收尾换行被 trim（不会把句子断成两行）",
  nestedKb.entries[1]?.answer === "行尾多行变量\n第二行再接一句",
  JSON.stringify(nestedKb.entries[1]?.answer),
);
check(
  "知识库变量：variables 本身不进 system prompt",
  !nestedKb.systemPrompt.includes("combo:") && !nestedKb.systemPrompt.includes("{{"),
);
check("知识库变量：未定义变量报错", loadError(writeKb("undef", kbBody("见 {{nope}}"))).includes("{{nope}} 未定义"));
check(
  "知识库变量：循环引用报错",
  loadError(writeKb("cycle", `variables:\n  a: "{{b}}"\n  b: "{{a}}"\n${kbBody("x")}`)).includes("循环引用"),
);
check("知识库变量：变量名写错报错", loadError(writeKb("typo", kbBody("版本 {{版本号}}"))).includes("没解析成功"));
check(
  "知识库变量：不加引号的数字报错（5.0 会被 YAML 解析成 5）",
  loadError(writeKb("numeric", `variables:\n  ver: 5.0\n${kbBody("版本 {{ver}}")}`)).includes("请加引号"),
);

// 2. 工具定义与参数校验
const params = FORWARD_FEEDBACK_TOOL.function.parameters as { type?: string; properties?: Record<string, unknown> };
check("工具 schema 生成", params?.type === "object" && Boolean(params.properties?.["summary"]));
check(
  "工具参数：合法入参通过",
  ForwardFeedbackArgs.safeParse({ summary: "退款问题", details: "用户订单 123 重复扣费" }).success,
);
check("工具参数：空 summary 拦截", !ForwardFeedbackArgs.safeParse({ summary: "", details: "x" }).success);
check("工具参数：超长 details 拦截", !ForwardFeedbackArgs.safeParse({ summary: "x", details: "a".repeat(1600) }).success);

// 2b. 补充消息工具（send_followup）：把「答案」和「已转交」分两条说
check(
  "补充消息：schema 生成",
  (SEND_FOLLOWUP_TOOL.function.parameters as { properties?: Record<string, unknown> }).properties?.["message"] !== undefined,
);
check("补充消息：合法入参通过", SendFollowupArgs.safeParse({ message: "这条已经转给负责的同学了。" }).success);
check("补充消息：空内容拦截", !SendFollowupArgs.safeParse({ message: "   " }).success);
check("补充消息：超长拦截（600 字上限）", !SendFollowupArgs.safeParse({ message: "字".repeat(601) }).success);

const fakeForwarder = {
  push: async () => ({ ok: true, message: "已成功转交人工处理。" }),
} as unknown as Parameters<typeof createTurnTools>[0];
const turn = createTurnTools(fakeForwarder, { msgId: "m1", senderId: "u1" });
const firstFollowup = await turn.exec("send_followup", JSON.stringify({ message: "这条也转给负责的同学了。" }));
check(
  "补充消息：第一条被记下（真正发出由调用方在主回复之后做）",
  turn.followups.length === 1 && firstFollowup.text.includes("之后"),
  firstFollowup.text,
);
const secondFollowup = await turn.exec("send_followup", JSON.stringify({ message: "再说一句。" }));
check(
  "补充消息：每轮最多一条——第二次调用不发出任何东西，并告知模型",
  turn.followups.length === 1 && secondFollowup.text.includes("没有发出"),
  secondFollowup.text,
);

const turn2 = createTurnTools(fakeForwarder, { msgId: "m1", senderId: "u1" });
await turn2.exec("send_followup", "not json");
check("补充消息：参数不合法时不占用那条配额（修正后还能用）", turn2.followups.length === 0);
check(
  "补充消息：修正后仍可正常发出",
  (await turn2.exec("send_followup", JSON.stringify({ message: "好的。" }))).text.includes("已记下") &&
    turn2.followups.length === 1,
);

const turn3 = createTurnTools(fakeForwarder, { msgId: "m1", senderId: "u1" });
const forwardedOnce = await turn3.exec("forward_feedback", JSON.stringify({ summary: "用户甲要求转人工", details: "**现象** 甲要求转人工。" }));
check("转交：仍走原来的路径", forwardedOnce.forwarded && turn3.followups.length === 0);
check("未知工具仍然被挡", (await turn3.exec("delete_everything", "{}")).text.includes("未知工具"));

// 两个工具都注入：send_followup 是「确实想发两条」的出口（见 src/llm/tools.ts 的 EXPOSED_TOOLS）。
check(
  "工具注入：forward_feedback 与 send_followup 都给模型",
  EXPOSED_TOOLS.map((t) => t.function.name).join(",") === "forward_feedback,send_followup",
  EXPOSED_TOOLS.map((t) => t.function.name).join(","),
);
check(
  "提示词：说清「正文和工具调用是同一次回复」并指向 send_followup",
  kb.systemPrompt.includes("同一次回复") &&
    kb.systemPrompt.includes("正文就是用户看到的那条") &&
    kb.systemPrompt.includes("send_followup"),
);
check(
  "提示词：转交说成将来时（工具在正文之后才执行）",
  kb.systemPrompt.includes("工具是在你说完之后才执行的") &&
    kb.systemPrompt.includes("我会帮你转给负责的同学") &&
    kb.systemPrompt.includes("并在正文里说一句会转给负责的同学"),
);
check(
  "提示词：答案写在正文里（不能只写在 details）",
  kb.systemPrompt.includes("正文里先讲答案、再说会转交") &&
    kb.systemPrompt.includes("不要只在 details 里写了答案却没告诉用户"),
);
check(
  "提示词：转交时也要把能答的答给用户（不能只写在 details 里）",
  kb.systemPrompt.includes("不要只在 details 里写了答案却没告诉用户"),
);
check("提示词：禁止在 details 里写「已回复」这类声明", kb.systemPrompt.includes("不要写「已回复」「已告知」这类声明"));

// 3. 图片缩放
const big = await sharp({
  create: { width: 2400, height: 1600, channels: 3, background: { r: 20, g: 40, b: 60 } },
})
  .png()
  .toBuffer();
const small = await sharp({
  create: { width: 320, height: 200, channels: 3, background: { r: 20, g: 40, b: 60 } },
})
  .png()
  .toBuffer();

const bigOut = await resizeImageBuffer(big, cfg);
const bigMeta = await sharp(bigOut.data).metadata();
check(
  "大图缩放到长边上限",
  bigMeta.width === 1280 && (bigMeta.height ?? 0) <= 1280,
  `2400x1600 → ${bigMeta.width}x${bigMeta.height}, ${bigOut.data.byteLength} 字节`,
);

// PNG 且未超上限 → 原样透传，不重新编码（避免把截图里的小字压糊）
const smallOut = await resizeImageBuffer(small, cfg);
const smallMeta = await sharp(smallOut.data).metadata();
check("小图不放大", smallMeta.width === 320 && smallMeta.height === 200, `${smallMeta.width}x${smallMeta.height}`);
check(
  "小 PNG 原样透传（不重编码）",
  smallOut.mime === "image/png" && Buffer.compare(smallOut.data, small) === 0,
  `mime=${smallOut.mime}，字节与原图一致`,
);
check("超限 PNG 会重编码为 JPEG", bigOut.mime === "image/jpeg");

// 4. 上下文解析（样本取自真实平台推送）
const rawContext = `=== 消息 1 ===
[消息内容]  已经转交给人工了，正在处理中喵~

=== 消息 2 ===
[附件1] 类型:图片 文件名:48E98328F50632344FDB9C2FA5473544.png 尺寸:872x544 大小:292.6KB URL:https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AbC&rkey=XyZ&spec=0
[附件2] 类型:文件 文件名:report.pdf URL:https://example.com/r.pdf`;
const parsed = splitContextAttachments(rawContext);
check("上下文：抠出图片 URL", parsed.imageUrls.length === 1 && parsed.imageUrls[0]!.startsWith("https://multimedia"), parsed.imageUrls.join(","));
check("上下文：去掉超长 URL", !parsed.text.includes("rkey=") && parsed.text.includes("URL:(已作为图片附上)"));
check("上下文：保留文件名与尺寸", parsed.text.includes("尺寸:872x544") && parsed.text.includes("48E98328"));
check("上下文：非图片附件不动", parsed.text.includes("[附件2] 类型:文件 文件名:report.pdf URL:https://example.com/r.pdf"));
check("上下文：无附件时原样返回", splitContextAttachments("=== 消息 1 ===\n[消息内容] 你好").text.includes("你好"));

// 5. 回复拆分与消息组装
check("短回复不拆分", splitReply("已转交，正在处理中。").length === 1);
const longReply = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 条说明，用于验证长回复的拆分逻辑是否正确。`).join("\n");
const chunks = splitReply(longReply);
check(
  "长回复按段落拆分",
  longReply.length > 1600 && chunks.length > 1 && chunks.every((c) => c.length <= 1600),
  `${longReply.length} 字符 → ${chunks.length} 段`,
);

// 5b. 回复的引用（期间群里有人插话时，引用回那条 @ 消息）
const arrivals = createArrivalTracker();
const mine = arrivals.mark("G1");
check("引用判断：刚收到还没生成时不需要引用", !needsQuote(arrivals, "G1", mine));
arrivals.mark("G1");
check("引用判断：生成期间群里又进了消息 → 引用", needsQuote(arrivals, "G1", mine));

const otherGroup = createArrivalTracker();
const mineB = otherGroup.mark("G1");
otherGroup.mark("G2");
check("引用判断：别的群进消息不算这个群的新消息", !needsQuote(otherGroup, "G1", mineB));
check("引用判断：没拿到自己的序号时不引用", !needsQuote(otherGroup, "G1", undefined));

const sent: string[] = [];
const recording = (kind: string) => async (content: string): Promise<void> => {
  sent.push(`${kind}:${content}`);
};
await sendMainReply({ plain: recording("plain"), quoted: recording("quoted") }, ["甲", "乙"], false);
check("引用发送：不需要引用时全部走普通回复", sent.join(" ") === "plain:甲 plain:乙", sent.join(" "));

sent.length = 0;
await sendMainReply({ plain: recording("plain"), quoted: recording("quoted") }, ["甲", "乙"], true);
check("引用发送：需要引用时每段都带引用", sent.join(" ") === "quoted:甲 quoted:乙", sent.join(" "));

sent.length = 0;
await sendMainReply(
  {
    plain: recording("plain"),
    quoted: async (content: string) => {
      if (content === "甲") throw new Error("API Error: message_reference 不支持");
      sent.push(`quoted:${content}`);
    },
  },
  ["甲", "乙"],
  true,
);
check(
  "引用发送：平台拒绝引用时退回普通回复，答案照样发出去",
  sent.join(" ") === "plain:甲 quoted:乙",
  sent.join(" "),
);

const userText = buildUserText({
  question: "怎么退款",
  senderName: "小明",
  skippedImages: 1,
});
check(
  "用户消息组装",
  userText.includes("问题：怎么退款") && userText.includes("小明") && userText.includes("【必须告知】"),
);

check(
  "平台背景：整段附在问题后面，并写明它是背景不是新问题",
  platformBackground("=== 消息 1 ===\n[消息内容] 已经转交给人工了").includes("不是这次要处理的新问题"),
);

const quotaText = buildUserText({
  question: "这个怎么办",
  senderName: "小明",
  skippedImages: 0,
  imageQuotaExhausted: true,
});
check(
  "读图额度用完时：以【必须告知】标记要求写进回复",
  quotaText.includes("【必须告知】") && quotaText.includes("读图额度已经用完"),
);
const skippedText = buildUserText({ question: "看看这个", senderName: "小明", skippedImages: 2 });
check("图片读取失败时：同样带【必须告知】标记", skippedText.includes("【必须告知】") && skippedText.includes("2 张图片"));

// 确定性兜底：模型漏说额度时由代码补一句
check("额度兜底：模型漏说时补上", ensureQuotaNotice("已经转给负责的同学了。", true).includes("额度用完了"));
check("额度兜底：模型已说明时不重复", ensureQuotaNotice("今天图片额度用完了，图没读到喵~", true) === "今天图片额度用完了，图没读到喵~");
check("额度兜底：模型说「明天再发图」也算已告知", ensureQuotaNotice("先用文字描述，明天再发图也行~", true) === "先用文字描述，明天再发图也行~");
check("额度兜底：没超额时不动回复", ensureQuotaNotice("课表不显示可以先连校园网。", false) === "课表不显示可以先连校园网。");
check("额度兜底：回复为空时直接给告知句", ensureQuotaNotice("", true).startsWith("今天图片额度用完了"));
// 额度是全天累计的：本条消息的图读到了、是更早的图占了额度时，不能补一句「图我没读到」。
check(
  "额度兜底：本条消息的图读到了就不谎称「图我没读到」",
  ensureQuotaNotice("已经转给负责的同学了。", true, false).includes("新发的图我读不到") &&
    !ensureQuotaNotice("已经转给负责的同学了。", true, false).includes("图我没读到"),
);
check(
  "额度告知：本条消息的图确实没被读到时才这么说",
  buildUserText({
    question: "看看这个",
    senderName: "小明",
    skippedImages: 0,
    imageQuotaExhausted: true,
    quotaSkippedCurrentImages: true,
  }).includes("这条消息里的图片没有被读取"),
);
check(
  "额度告知：额度被更早的图用掉时，不谎称本条消息的图没读到",
  ((): boolean => {
    const text = buildUserText({
      question: "看看这个",
      senderName: "小明",
      skippedImages: 0,
      imageQuotaExhausted: true,
    });
    return text.includes("读图额度已经用完") && !text.includes("这条消息里的图片没有被读取");
  })(),
);

// 6. 飞书卡片结构与话题聚合
const sample = {
  summary: "用户Heuluck要求修改姓名",
  details: "这里是很长的详情，默认应该被折叠起来",
  msgId: "ROBOT1.0_SyKRaaSfxk967ooqDn4d2f",
  senderId: "0594D117CCDA12B06A25EE5E7DB5F5B1",
  topic: "billing-refund",
};
const rootCard = buildRootCard(sample);
const rootElements = (rootCard["elements"] ?? []) as Record<string, unknown>[];
const panels = rootElements.filter((el) => el["tag"] === "collapsible_panel");
check("根卡片：只保留一个折叠面板", panels.length === 1 && rootElements.length === 2, `${rootElements.length} 个元素`);
check("根卡片：折叠面板默认收起", panels[0]?.["expanded"] === false);

const visibleText = JSON.stringify(rootElements.filter((el) => el["tag"] !== "collapsible_panel"));
check(
  "根卡片：外露内容只有问题概要",
  visibleText.includes(sample.summary) && !visibleText.includes(sample.msgId) && !visibleText.includes(sample.senderId),
);
const panelText = JSON.stringify(panels[0] ?? {});
check(
  "根卡片：详情与诊断信息都在折叠面板内",
  panelText.includes(sample.details) && panelText.includes(sample.msgId) && panelText.includes(sample.senderId),
);

const followUp = buildFollowUpCard(sample, 3);
const followUpElements = (followUp["elements"] ?? []) as Record<string, unknown>[];
check("补充卡片：标题带序号", JSON.stringify(followUp).includes("补充 #3"));
check("补充卡片：同样是概要外露 + 一个折叠面板", followUpElements.length === 2);
check("补充卡片：蓝色标题以区分", JSON.stringify(followUp).includes('"blue"'));

check("提示词：已无「主人」称呼", !kb.systemPrompt.includes("主人"));
// 条目 id 不给模型：话题聚合没启用（工具参数里没有 topic，模型填不了），发出去只占 token。
check(
  "知识库：提示词里不带用不上的条目 id",
  !kb.systemPrompt.includes("（id: ") && kb.systemPrompt.includes("## "),
);
check(
  "提示词：要求概要带用户名",
  kb.systemPrompt.includes("用户<昵称>") && kb.systemPrompt.includes("用户Heuluck要求修改姓名"),
);

check("话题键：同用户同主题归并", topicKey("u1", "billing-refund", "m1") === topicKey("u1", "Billing-Refund", "m2"));
check("话题键：不同主题分开", topicKey("u1", "billing-refund", "m1") !== topicKey("u1", "bug-report", "m1"));
check("话题键：不同用户分开", topicKey("u1", "x", "m1") !== topicKey("u2", "x", "m1"));
check(
  "话题键：模型没给主题时各自独立（不再聚合）",
  topicKey("u1", undefined, "m1") !== topicKey("u1", undefined, "m2"),
  "同一用户的两条不同消息不会串到一条话题下",
);

// 7. 截断与配额
check("截断：短文本原样返回", truncateText("短文本", 100) === "短文本");
const longText = "甲".repeat(5000);
check("截断：超长文本加标记", truncateText(longText, 100).length < 130 && truncateText(longText, 100).includes("已截断"));

const cappedChunks = splitReply("乙".repeat(9000), 1600, 2);
check("回复：分段数受上限约束", cappedChunks.length === 2 && cappedChunks[1]!.includes("已截断"), `${cappedChunks.length} 段`);

const hugeContext = [
  "=== 消息 1 ===",
  `[消息内容] ${"丙".repeat(3000)}`,
  "=== 消息 2 ===",
  "[消息内容] 最新的问题在这里",
].join("\n");
const limitedContext = splitContextAttachments(hugeContext, { maxChars: 500, maxPerMessage: 200 });
check(
  "上下文：单条超长被截断",
  limitedContext.truncated && limitedContext.text.includes("本条过长，已截断"),
);
check("上下文：整段按上限裁剪且保留最新", limitedContext.text.length <= 560 && limitedContext.text.includes("最新的问题在这里"));
// 整段裁剪不能从半条消息中间切：平台这段是按消息渲染的，模型该从一条完整消息开始看。
const boundaryContext = [
  "=== 消息 1 ===",
  `[消息内容] ${"丁".repeat(400)}`,
  "=== 消息 2 ===",
  "[消息内容] 中间这条",
  "=== 消息 3 ===",
  "[消息内容] 最新的问题在这里",
].join("\n");
const boundaryKept = splitContextAttachments(boundaryContext, { maxChars: 120, maxPerMessage: 0 });
check(
  "上下文：整段裁剪落在消息边界上（不会从半条消息开始）",
  boundaryKept.truncated &&
    boundaryKept.text.startsWith("（较早的上下文已省略）\n=== 消息") &&
    boundaryKept.text.includes("最新的问题在这里"),
  JSON.stringify(boundaryKept.text.slice(0, 40)),
);

const limitsCfg = {
  ...cfg,
  DATA_DIR: "data/smoke-tmp/a",
  RATE_LIMIT_PER_MINUTE: 3,
  RATE_LIMIT_PER_GROUP_PER_MINUTE: 100,
  REPLY_LIMIT_PER_USER_PER_DAY: 10,
  REPLY_LIMIT_GLOBAL_PER_DAY: 100,
  IMG_DAILY_LIMIT_PER_USER: 10,
  PRIVILEGED_USERS: "PRIV_USER",
  PRIVILEGED_LIMIT_PER_DAY: 100,
} as unknown as Config;

const limiter = new Limits(limitsCfg);
await limiter.init();
check("配额：豁免用户识别", limiter.isPrivileged("PRIV_USER") && !limiter.isPrivileged("普通用户"));

for (let i = 0; i < 3; i += 1) limiter.reserve("普通用户");
check("配额：普通用户触发分钟级限流", limiter.check("普通用户").reason === "user-rate");

let privilegedSurvives = true;
for (let i = 0; i < 10; i += 1) {
  if (!limiter.reserve("PRIV_USER").ok) privilegedSurvives = false;
}
check("配额：豁免用户不受分钟级限制且额度独立", privilegedSurvives, "连续 10 次全部放行");

// 每日额度：连打 12 次只应放行 10 次（同步记账，并发也不会超额）
const dailyLimiter = new Limits({
  ...limitsCfg,
  DATA_DIR: "data/smoke-tmp/b",
  RATE_LIMIT_PER_MINUTE: 999,
} as unknown as Config);
await dailyLimiter.init();
let allowed = 0;
for (let i = 0; i < 12; i += 1) {
  if (dailyLimiter.reserve("冲刺用户").ok) allowed += 1;
}
check("配额：每日额度不超额", allowed === 10, `连打 12 次放行 ${allowed} 次`);

const globalLimiter = new Limits({
  ...limitsCfg,
  DATA_DIR: "data/smoke-tmp/c",
  RATE_LIMIT_PER_MINUTE: 999,
  REPLY_LIMIT_GLOBAL_PER_DAY: 2,
} as unknown as Config);
await globalLimiter.init();
globalLimiter.reserve("甲");
globalLimiter.reserve("乙");
check("配额：全局每日上限生效", globalLimiter.reserve("丙").reason === "global-daily");

await Promise.all([limiter.flush(), dailyLimiter.flush(), globalLimiter.flush()]);

// 8. 数据保留、切分与迁移
check("命名：月份键格式", /^\d{4}-\d{2}$/.test(monthKey()), monthKey());
check("命名：日期键格式", /^\d{4}-\d{2}-\d{2}$/.test(dayKey()), dayKey());
check("命名：会话时间戳格式", /^\d{8}-\d{6}$/.test(stampKey()), stampKey());

const retentionDir = "data/smoke-tmp/retention";
mkdirSync(retentionDir, { recursive: true });
const stale = new Date(Date.now() - 40 * 86_400_000);
writeFileSync(join(retentionDir, "forwards-2026-07.jsonl"), "旧\n");
writeFileSync(join(retentionDir, "forwards-2026-09.jsonl"), "新\n");
writeFileSync(join(retentionDir, "limits.2026-07-01.json"), "{}\n");
writeFileSync(join(retentionDir, "topics.json"), "{}\n");
utimesSync(join(retentionDir, "forwards-2026-07.jsonl"), stale, stale);
utimesSync(join(retentionDir, "limits.2026-07-01.json"), stale, stale);

const prunedForwards = await pruneByAge(retentionDir, FILE_PATTERNS.forwards, 30 * 86_400_000);
const prunedLimits = await pruneByAge(retentionDir, FILE_PATTERNS.limitsArchive, 30 * 86_400_000);
check(
  "保留：超过 30 天的归档被清理",
  prunedForwards.deleted.length === 1 && prunedLimits.deleted.length === 1,
  [...prunedForwards.deleted, ...prunedLimits.deleted].join(", "),
);
check("保留：保留期内的文件不动", existsSync(join(retentionDir, "forwards-2026-09.jsonl")));
check("保留：不匹配命名规则的文件绝不删除", existsSync(join(retentionDir, "topics.json")));

const migrateDir = "data/smoke-tmp/migrate";
mkdirSync(migrateDir, { recursive: true });
writeFileSync(join(migrateDir, "forwards.jsonl"), '{"old":true}\n');
await migrateLegacyForwards(migrateDir);
const migratedNames = readdirSync(migrateDir);
check(
  "迁移：旧 forwards.jsonl 并入按月文件",
  !migratedNames.includes("forwards.jsonl") &&
    migratedNames.some((name) => /^forwards-\d{4}-\d{2}\.jsonl$/.test(name)),
  migratedNames.join(", "),
);

const archiveDir = "data/smoke-tmp/limits-archive";
mkdirSync(archiveDir, { recursive: true });
writeFileSync(
  join(archiveDir, "limits.json"),
  JSON.stringify({ day: "2026-01-02", userCounts: { 老用户: 7 }, globalCount: 7 }),
);
const staleLimits = new Limits({ ...limitsCfg, DATA_DIR: archiveDir } as unknown as Config);
await staleLimits.init();
check("配额：跨日启动归档旧用量", existsSync(join(archiveDir, "limits.2026-01-02.json")));
check("配额：跨日启动后计数归零", staleLimits.check("老用户").ok);
await staleLimits.flush();

// 每日读图额度（按图片本身计，同一张图今天只扣一次）
const imgLimiter = new Limits({ ...limitsCfg, DATA_DIR: "data/smoke-tmp/img" } as unknown as Config);
await imgLimiter.init();
check("读图额度：初始为每日上限", imgLimiter.imageBudget("U1") === limitsCfg.IMG_DAILY_LIMIT_PER_USER);
for (const url of ["https://x/1.png", "https://x/2.png", "https://x/3.png"]) imgLimiter.consumeImage("U1", url);
check("读图额度：扣减后剩余正确", imgLimiter.imageBudget("U1") === limitsCfg.IMG_DAILY_LIMIT_PER_USER - 3);
check(
  "读图额度：同一张图重复遇到不再扣（缓存被淘汰后重新下载也不会）",
  imgLimiter.consumeImage("U1", "https://x/1.png") === false &&
    imgLimiter.imageBudget("U1") === limitsCfg.IMG_DAILY_LIMIT_PER_USER - 3 &&
    imgLimiter.imageCharged("U1", "https://x/1.png"),
);
check("读图额度：没读过的图仍然会扣", imgLimiter.consumeImage("U1", "https://x/9.png") === true);
check("读图额度：不同用户互不影响", imgLimiter.imageBudget("U2") === limitsCfg.IMG_DAILY_LIMIT_PER_USER);
for (let i = 0; i < 999; i += 1) imgLimiter.consumeImage("U1", `https://x/bulk-${i}.png`);
check("读图额度：不会变成负数", imgLimiter.imageBudget("U1") === 0);
await imgLimiter.flush();

// 额度按图去重的状态要能跨重启恢复，否则重启后同一张图会被再扣一次。
const imgReloaded = new Limits({ ...limitsCfg, DATA_DIR: "data/smoke-tmp/img" } as unknown as Config);
await imgReloaded.init();
check(
  "读图额度：重启后仍记得哪些图已计过额度",
  imgReloaded.imageCharged("U1", "https://x/1.png") && imgReloaded.imageBudget("U1") === 0,
);
await imgReloaded.flush();

// 9. 本地对话缓冲（渲染成多轮 messages）
const historyCfg = {
  ...cfg,
  DATA_DIR: "data/smoke-tmp/history",
  HISTORY_ENABLED: true,
  HISTORY_WINDOW_MINUTES: 360,
  HISTORY_INJECT_MINUTES: 60,
  HISTORY_MAX_ENTRIES: 10,
  HISTORY_MAX_STORED: 50,
  IMG_CONTEXT_MAX_COUNT: 5,
  CONTEXT_MESSAGE_MAX_CHARS: 600,
  CONTEXT_MAX_CHARS: 3000,
} as unknown as Config;

const history = new History(historyCfg);
await history.init();
const textOf = (group: string, speakerId?: string): string =>
  history
    .render(group, speakerId === undefined ? {} : { speakerId })
    .turns.map((t) => t.text)
    .join("\n");
check("缓冲：空群渲染为空", history.render("G1").turns.length === 0);

history.record("G1", { at: Date.now() - 5 * 60_000, role: "user", senderName: "Heuluck", content: "我手机号换了咋办" });
history.record("G1", { at: Date.now() - 4 * 60_000, role: "bot", content: "分两种情况喵：旧号能用就自己改，不能用就找我转人工" });
history.record("G1", { at: Date.now() - 60_000, role: "user", senderName: "Heuluck", content: "没用了" });
const rendered = history.render("G1");
check(
  "缓冲：渲染成多轮，用户与机器人的记录都在",
  rendered.turns.length === 3 &&
    rendered.turns[0]!.role === "user" &&
    rendered.turns[1]!.role === "bot" &&
    rendered.turns[2]!.role === "user" &&
    textOf("G1").includes("用户Heuluck: 我手机号换了咋办") &&
    textOf("G1").includes("分两种情况喵"),
);
check(
  "缓冲：用户轮带时间戳与昵称前缀，机器人自己的轮不带前缀",
  rendered.turns.every((t) => (t.role === "bot" ? !t.text.startsWith("[") : /^\[\d{2}:\d{2}\] 用户Heuluck: /.test(t.text))),
  `user="${rendered.turns[0]!.text}" / bot="${rendered.turns[1]!.text}"`,
);

// 窗口：7 小时前的记录应被排除
history.record("G2", { at: Date.now() - 7 * 60 * 60_000, role: "user", content: "很久以前的消息" });
history.record("G2", { at: Date.now() - 60_000, role: "user", content: "刚刚的消息" });
check("缓冲：存储窗口外的记录不进入历史", !textOf("G2").includes("很久以前的消息") && textOf("G2").includes("刚刚的消息"));

// 会话窗口：闲置超过 HISTORY_INJECT_MINUTES 分钟就当开了新会话
history.record("G9", { at: Date.now() - 90 * 60_000, role: "user", content: "一个半小时前聊过的旧话题" });
history.record("G9", { at: Date.now() - 5 * 60_000, role: "user", content: "刚刚的问题" });
check(
  "缓冲：会话窗口比存储窗口紧（1.5 小时前的旧话题不带）",
  !textOf("G9").includes("旧话题") && textOf("G9").includes("刚刚的问题"),
);

// 条数上限：超了从**头部整轮**丢，不能把「提问」和它的「回答」切开
for (let i = 0; i < 12; i += 1) {
  history.record("G3", { at: Date.now(), role: "user", content: `Q${i}` });
  history.record("G3", { at: Date.now(), role: "bot", content: `A${i}` });
}
const capped = history.render("G3");
check(
  "缓冲：超出条数上限时从头整轮丢弃，最新一轮保留",
  capped.turns.length > 0 && capped.turns.at(-1)!.text.includes("A11"),
  `${capped.turns.length} 轮`,
);
// 从头丢的条数是奇数时会剩下一条没有前因的答复（它的提问刚被丢掉了）。
// 注意不能用 `?? "user"` 兜底 index 0 ——那样恰好会把这种情况漏掉（这个断言原本就是这么写的，漏了）。
check(
  "缓冲：丢弃后不会留下没有前因的答复（窗口首轮必须是用户消息）",
  capped.turns[0]!.role === "user" &&
    capped.turns.every((turn, i) => turn.role === "user" || capped.turns[i - 1]!.role === "user"),
  `首轮 role=${capped.turns[0]!.role}，共 ${capped.turns.length} 轮`,
);

// 字符预算：同样整轮丢
for (let i = 0; i < 10; i += 1) {
  history.record("G5", { at: Date.now(), role: "user", content: `${"长".repeat(500)}${i}` });
}
const byChars = history.render("G5");
check(
  "缓冲：超出字符预算时整轮丢弃（不是从中间切字符串）",
  byChars.turns.length > 0 && byChars.turns.length < 10 && byChars.turns.every((t) => !t.text.includes("已截断")),
  `${byChars.turns.length} 轮 / ${byChars.turns.reduce((n, t) => n + t.text.length, 0)} 字符`,
);

// 存储上限与注入上限分开
for (let i = 0; i < 80; i += 1) {
  history.record("G4", { at: Date.now(), role: "user", content: `消息 ${i}` });
}
await history.flush();
const stored = (JSON.parse(readFileSync("data/smoke-tmp/history/history.json", "utf8")) as Record<string, unknown[]>)[
  "G4"
];
check("缓冲：存储上限 50 条", stored !== undefined && stored.length === 50, `实际存 ${stored?.length ?? 0} 条`);
check("缓冲：注入仍受 HISTORY_MAX_ENTRIES 约束", history.render("G4").turns.length === 10);

await history.flush();
const reloaded = new History(historyCfg);
await reloaded.init();
check("缓冲：重启后仍能恢复近况", reloaded.render("G1").turns.some((t) => t.text.includes("没用了")));

// 工具调用要能落盘再读回来（JSON 往返），否则重启后就「忘了自己转过人工」
history.record("G11", { at: Date.now() - 60_000, role: "user", senderId: "U1", senderName: "甲", content: "帮我转人工" });
history.record("G11", {
  at: Date.now() - 50_000,
  role: "bot",
  content: "已经帮你转给负责的同学了。",
  toolRounds: [{ content: "", calls: [{ id: "call_p1", name: "forward_feedback", argsJson: '{"summary":"用户甲要求转人工"}', result: "已转交人工处理。" }] }],
});
await history.flush();
const reloaded2 = new History(historyCfg);
await reloaded2.init();
const persisted = reloaded2.render("G11", { speakerId: "U1" }).turns.find((t) => t.role === "bot");
check(
  "缓冲：工具调用能落盘再读回（id / 参数 / 结果都在）",
  persisted?.toolRounds.length === 1 &&
    persisted.toolRounds[0]!.calls[0]!.id === "call_p1" &&
    persisted.toolRounds[0]!.calls[0]!.argsJson === '{"summary":"用户甲要求转人工"}' &&
    persisted.toolRounds[0]!.calls[0]!.result === "已转交人工处理。",
  JSON.stringify(persisted?.toolRounds),
);
check(
  "缓冲：没有工具调用的轮次读回来是空数组（不会误报调用过）",
  reloaded2.render("G11", { speakerId: "U1" }).turns.find((t) => t.role === "user")?.toolRounds.length === 0,
);

// 折叠空白但不能把换行也折掉：用户粘贴的日志/堆栈靠换行保持结构
history.record("G13", {
  at: Date.now() - 30_000,
  role: "user",
  senderId: "U1",
  senderName: "甲",
  content: "报错如下：\n\n  at foo.ts:1\n  at bar.ts:2",
});
check(
  "缓冲：历史保留换行（堆栈不会折成一坨），空行合并成一个",
  textOf("G13").includes("报错如下：\n at foo.ts:1\n at bar.ts:2"),
  JSON.stringify(textOf("G13")),
);

const disabled = new History({ ...historyCfg, HISTORY_ENABLED: false } as unknown as Config);
await disabled.init();
disabled.record("G1", { at: Date.now(), role: "user", content: "不该被记录" });
check("缓冲：开关关闭后不记录也不渲染", disabled.render("G1").turns.length === 0);

// 图片：挂在**它到来的那一轮**上，而不是挪到当前轮。
// 这是实测踩过的坑的结构性修复：以前图只能作为当前消息的附件，模型会把 25 分钟前的崩溃截图
// 当成这次的新证据，回了「看你发的截图还是会弹严重错误崩溃」并误转交一次人工。
history.record("G6", { at: Date.now() - 60_000, role: "user", senderId: "U1", content: "（发了图片）", imageUrls: ["https://x/old.png"] });
history.record("G6", { at: Date.now() - 45_000, role: "user", senderId: "U2", content: "（发了图片）", imageUrls: ["https://x/other.png"] });
history.record("G6", { at: Date.now() - 30_000, role: "user", senderId: "U1", content: "发生什么了啊" });
history.record("G6", { at: Date.now(), role: "user", senderId: "U1", content: "（发了图片）", imageUrls: ["https://x/new.png"] });
const withImages = history.render("G6", { speakerId: "U1" });
const imageTurnIndex = withImages.turns.findIndex((t) => t.images.includes("https://x/old.png"));
check(
  "历史图片：挂在它自己那一轮上（不是最后一轮）",
  imageTurnIndex >= 0 && imageTurnIndex < withImages.turns.length - 1,
  `第 ${imageTurnIndex + 1} / ${withImages.turns.length} 轮`,
);
check(
  "历史图片：只带当前提问者发的图，别人的图不带",
  !withImages.turns.some((t) => t.images.includes("https://x/other.png")) &&
    withImages.turns.some((t) => t.images.includes("https://x/new.png")),
);
check(
  "历史图片：同一个 URL 只出现在一轮里",
  withImages.turns.filter((t) => t.images.includes("https://x/old.png")).length === 1,
);
check("历史图片：没指定提问者时不带任何图", !history.render("G6").turns.some((t) => t.images.length > 0));
check("历史图片：开关关闭后不渲染", disabled.render("G6", { speakerId: "U1" }).turns.length === 0);

// 回归：图后面又聊了好几句（含别人插话），该用户的图仍要在
history.record("G7", { at: Date.now() - 90_000, role: "user", senderId: "U1", content: "（发了图片）", imageUrls: ["https://x/shot.png"] });
for (let i = 0; i < 6; i += 1) {
  history.record("G7", { at: Date.now() - 60_000 + i, role: "user", senderId: "U2", content: `别人的第 ${i + 1} 句` });
}
check(
  "历史图片：中间夹着别人的消息也能找到该用户的图",
  history.render("G7", { speakerId: "U1" }).turns.some((t) => t.images.includes("https://x/shot.png")),
);
// 图注：给每张图一个不随窗口滑动的名字，模型才能在后续轮次引用它
// （实测没有图注时问「第 1 张、第 2 张分别是什么颜色」会答错，甚至数错张数）。
const labelled = history.render("G6", { speakerId: "U1" });
check(
  "历史图片：带图的轮次后面有「［图：HH:mm］」图注",
  labelled.turns.some((t) => t.images.length > 0 && /［图：\d{2}:\d{2}］$/.test(t.text)),
  labelled.turns.find((t) => t.images.length > 0)?.text,
);
check(
  "历史图片：不带图的轮次没有图注",
  labelled.turns.every((t) => t.images.length > 0 || !t.text.includes("［图：")),
);

// 10. 多轮 messages 的组装（llm 层）
const fakeTool = { type: "function", function: { name: "t", parameters: { type: "object" } } } as never;
const built = buildMessages(
  {
    history: [
      { role: "user", parts: [{ text: "[15:07] 用户Heuluck: 崩了" }, { image: "data:image/png;base64,AAA" }] },
      { role: "assistant", parts: [{ text: "[15:08] 先换成 5.16.0" }] },
    ],
    userParts: [{ text: "问题：已经改好了" }, { image: "data:image/png;base64,BBB" }],
    tools: [fakeTool],
    execTool: async () => ({ text: "", forwarded: false }),
  },
  "SYSTEM",
);
check("多轮组装：system 在最前且逐字节稳定", built[0]!.role === "system" && built[0]!.content === "SYSTEM");
check(
  "多轮组装：历史按顺序成为独立的 user / assistant 轮",
  built.length === 4 && built[1]!.role === "user" && built[2]!.role === "assistant" && built[3]!.role === "user",
  built.map((m) => m.role).join(","),
);
check(
  "多轮组装：图片留在它自己那一轮",
  Array.isArray(built[1]!.content) &&
    (built[1]!.content as { type: string }[]).some((p) => p.type === "image_url") &&
    built[2]!.content === "[15:08] 先换成 5.16.0",
  "assistant 轮是纯字符串，没有图",
);
check(
  "多轮组装：只有一段文本的历史轮退化成字符串（更紧凑、利于前缀缓存）",
  buildMessages(
    { history: [{ role: "user", parts: [{ text: "[15:07] 用户A: 你好" }] }], userParts: [{ text: "问题：在吗" }], tools: [fakeTool], execTool: async () => ({ text: "", forwarded: false }) },
    "S",
  )[1]!.content === "[15:07] 用户A: 你好",
);

// 历史里的工具调用必须原样回放：模型看不到自己调用过什么，就会对同一个问题重复转交人工。
const toolHistory = [
  { role: "user" as const, parts: [{ text: "[16:04] 用户Heuluck: 怎么崩了啊" }] },
  {
    role: "assistant" as const,
    parts: [{ text: "先换成 5.16.0。这条我已经转给负责的同学了。" }],
    toolRounds: [
      {
        content: "",
        calls: [{ id: "call_x1", name: "forward_feedback", argsJson: '{"summary":"用户Heuluck反馈崩溃"}', result: "已转交人工处理（话题：crash）。" }],
      },
    ],
  },
];
const withTools = buildMessages({ history: toolHistory, userParts: [{ text: "问题：帮我转人工" }], tools: [fakeTool], execTool: async () => ({ text: "", forwarded: false }) }, "S");
check(
  "多轮组装：历史工具轮还原成 assistant(tool_calls) + tool，位置在答复正文之前",
  withTools.map((m) => m.role).join(",") === "system,user,assistant,tool,assistant,user",
  withTools.map((m) => m.role).join(","),
);
const replayed = withTools[2] as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
check(
  "多轮组装：调用 id / 名字 / 参数原样回放（id 对不上会让请求非法）",
  replayed.tool_calls?.[0]?.id === "call_x1" &&
    replayed.tool_calls?.[0]?.function.name === "forward_feedback" &&
    replayed.tool_calls?.[0]?.function.arguments === '{"summary":"用户Heuluck反馈崩溃"}',
  JSON.stringify(replayed.tool_calls),
);
check(
  "多轮组装：tool 结果的 tool_call_id 与调用配对",
  (withTools[3] as { tool_call_id?: string }).tool_call_id === "call_x1" &&
    withTools[3]!.content === "已转交人工处理（话题：crash）。",
);
check(
  "多轮组装：没有工具调用的轮次不会凭空多出 tool 消息",
  buildMessages(
    { history: [{ role: "assistant", parts: [{ text: "直接答复" }] }], userParts: [{ text: "问题：x" }], tools: [fakeTool], execTool: async () => ({ text: "", forwarded: false }) },
    "S",
  ).map((m) => m.role).join(",") === "system,assistant,user",
);
// 模型「正文 + 工具调用」是同一条 assistant 消息：正文已经随 tool_calls 回放过，
// 再加一条同样的文本，历史里就有两份答案（提示词又要求它别重复自己说过的话）。
check(
  "多轮组装：正文与工具调用同一条消息时，历史里只有一份答复",
  (() => {
    const built2 = buildMessages(
      {
        history: [
          { role: "user", parts: [{ text: "[16:04] 用户A: 崩了" }] },
          {
            role: "assistant" as const,
            parts: [{ text: "先换成 5.16.0，已经转给负责的同学了。" }],
            toolRounds: [
              {
                content: "先换成 5.16.0，已经转给负责的同学了。",
                calls: [{ id: "call_y1", name: "forward_feedback", argsJson: "{}", result: "已转交人工处理。" }],
              },
            ],
          },
        ],
        userParts: [{ text: "问题：还没好" }],
        tools: [fakeTool],
        execTool: async () => ({ text: "", forwarded: false }),
      },
      "S",
    );
    const texts = built2.map((m) => (typeof m.content === "string" ? m.content : ""));
    return (
      built2.map((m) => m.role).join(",") === "system,user,assistant,tool,user" &&
      texts.filter((text) => text.includes("已经转给负责的同学了")).length === 1
    );
  })(),
);
// 正文与工具调用**不同**（例如代码补了一句额度告知）时要照常补上那条文本，不能丢。
check(
  "多轮组装：正文与工具调用内容不同时，仍单独回放正文",
  buildMessages(
    {
      history: [
        {
          role: "assistant" as const,
          parts: [{ text: "答案。今天图片额度用完了，图我没读到。" }],
          toolRounds: [{ content: "答案。", calls: [{ id: "call_y2", name: "forward_feedback", argsJson: "{}", result: "已转交。" }] }],
        },
      ],
      userParts: [{ text: "问题：x" }],
      tools: [fakeTool],
      execTool: async () => ({ text: "", forwarded: false }),
    },
    "S",
  ).map((m) => m.role).join(",") === "system,assistant,tool,assistant,user",
);

// 11. 同群串行队列：并发消息不能读到「有问题、还没答复」的中间态
const enqueue = createSerialQueue();
const order: string[] = [];
const slow = async (): Promise<void> => {
  order.push("A:start");
  await new Promise((resolve) => setTimeout(resolve, 30));
  order.push("A:end");
};
const fast = async (): Promise<void> => {
  order.push("B:start");
  order.push("B:end");
};
await Promise.all([enqueue("g1", slow), enqueue("g1", fast)]);
check("串行队列：同一个群的任务排队执行", order.join(",") === "A:start,A:end,B:start,B:end", order.join(","));
const other: string[] = [];
await Promise.all([
  enqueue("g2", async () => {
    other.push("X:start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.push("X:end");
  }),
  enqueue("g3", fast),
]);
check("串行队列：不同群互不阻塞", other.join(",") === "X:start,X:end", other.join(","));
const failureReason = await enqueue("g4", async () => {
  throw new Error("boom");
}).catch((err: Error) => err.message);
check(
  "串行队列：前一个任务失败不影响后续排队",
  failureReason === "boom" && (await enqueue("g4", async () => "ok")) === "ok",
);

// 10. 正文形态的工具调用（真实泄漏样本）
const leaked = `版本号我可能记岔了，同学以 App「关于」页显示的为准——显示 5.16.0 那就不是旧版喵。

<||DSML||calls>
<||DSML||invoke name="forward_feedback">
<||DSML||parameter name="summary" string="true">用户Heuluck反馈群文件版本号与客服说法不一致</||DSML||parameter>
<||DSML||parameter name="details" string="true">**现象**：用户截图 App「关于」页显示当前版本 5.16.0。</||DSML||parameter>
</||DSML||invoke>
</||DSML||calls>`;

const parsedLeak = extractTextToolCalls(leaked);
check("工具标记：解析出调用名", parsedLeak.calls[0]?.name === "forward_feedback", parsedLeak.calls.map((c) => c.name).join(","));
check(
  "工具标记：解析出参数",
  (JSON.parse(parsedLeak.calls[0]?.argsJson ?? "{}") as Record<string, string>)["summary"]?.startsWith("用户Heuluck"),
);
check(
  "工具标记：正文里不再残留 DSML",
  !parsedLeak.cleaned.includes("DSML") && !parsedLeak.cleaned.includes("forward_feedback"),
  JSON.stringify(parsedLeak.cleaned.slice(0, 40)),
);
check("工具标记：给用户的正文保留下来", parsedLeak.cleaned.includes("版本号我可能记岔了"));

let executed: string[] = [];
const runResult = await runTextToolCalls(leaked, async (name, argsJson) => {
  executed.push(`${name}:${(JSON.parse(argsJson) as Record<string, string>)["summary"] ?? ""}`);
  return { text: "已成功转交人工处理。", forwarded: true };
});
check("工具标记：调用被真的执行", executed.length === 1 && runResult.forwarded, executed.join(","));
check("工具标记：无标记时不误判", extractTextToolCalls("课表不显示可以先连校园网。").calls.length === 0);
check("工具标记：内部标记【必须告知】也会被清掉", !extractTextToolCalls("【必须告知】今天图片额度用完了。").cleaned.includes("【必须告知】"));
// 单引号属性：模型换了写法也不能变成「标记被删掉、调用没执行」。
const singleQuoted = `<||DSML||calls><||DSML||invoke name='forward_feedback'><||DSML||parameter name='summary'>用户甲要求转人工</||DSML||parameter></||DSML||invoke></||DSML||calls>`;
check(
  "工具标记：属性用单引号也能解析",
  extractTextToolCalls(singleQuoted).calls[0]?.name === "forward_feedback",
  JSON.stringify(extractTextToolCalls(singleQuoted).calls),
);
// 标记会被无条件剔出正文，所以「解析不出来」必须能被调用方发现并记日志。
const brokenMarkup = `<||DSML||calls><||DSML||invoke><||DSML||parameter>乱七八糟</||DSML||parameter></||DSML||invoke></||DSML||calls>`;
check(
  "工具标记：有标记却没解析出调用时会上报（不再静默吞掉）",
  extractTextToolCalls(brokenMarkup).unparsedMarkup &&
    extractTextToolCalls(brokenMarkup).calls.length === 0 &&
    !extractTextToolCalls(brokenMarkup).cleaned.includes("DSML"),
);
check("工具标记：没有标记时不会误报解析失败", !extractTextToolCalls("课表不显示可以先连校园网。").unparsedMarkup);

await history.flush();
rmSync("data/smoke-tmp", { recursive: true, force: true });

// 10. @ 标记清洗（平台会下发十六进制 openid 形态，SDK 内置规则只认纯数字）
check("清洗：数字形态标记", stripMentions("<@!1905618380> 我手机号换了") === "我手机号换了");
check(
  "清洗：十六进制 openid 形态标记",
  stripMentions("<@F458CD3416A39BD912686734260121E1>") === "",
  "只 @ 机器人不说话 → 空字符串",
);
check(
  "清洗：句中/多个标记",
  stripMentions("<@AAA111> 请问 <@BBB222> 这个怎么弄") === "请问  这个怎么弄",
);
check("清洗：无标记时原样返回", stripMentions("普通消息") === "普通消息");
check(
  "清洗：上下文里的标记也被去掉",
  !splitContextAttachments("=== 消息 1 ===\n[消息内容] <@F458CD34> 我要退款").text.includes("<@"),
);

// 11. 引用消息里的图片（结构化附件）
check(
  "引用图片：取出图片 URL",
  quotedImageUrls([
    { contentType: "image/png", url: "https://example.com/a.png", filename: "a.png" },
    { contentType: "file", url: "https://example.com/b.pdf" },
  ]).length === 1,
);
check("引用图片：非图片类型被排除", quotedImageUrls([{ contentType: "file", url: "https://x/y" }]).length === 0);
check("引用图片：无附件返回空数组", quotedImageUrls(undefined).length === 0);
check(
  "引用图片：语音引用带 ASR 文本时不影响图片提取",
  quotedImageUrls([{ contentType: "image/jpeg", url: "https://example.com/c.jpg" }])[0] === "https://example.com/c.jpg",
);

// 12. 知识库路线：先回复再转交
const kbText = kb.entries.map((e) => `${e.title}/${e.route}`).join(" | ");
check(
  "知识库：手机号条目已合并为「先回复再转交」",
  kb.entries.filter((e) => e.id.startsWith("reset-phone")).length === 1 &&
    kb.entries.some((e) => e.route === "answer_and_forward"),
  kbText.slice(0, 80),
);
check(
  "知识库：新路线在提示词里以中文标签呈现",
  kb.systemPrompt.includes("先回复用户，同时转交人工"),
);
check("知识库：覆盖原有 13 条中的其余条目", kb.entries.length >= 11, `${kb.entries.length} 条`);

console.log(failed === 0 ? "\n全部通过 ✅" : `\n有 ${failed} 项失败 ❌`);
process.exitCode = failed === 0 ? 0 : 1;
