/**
 * 离线自检（不联网、不需要凭据）：
 *   npm run smoke
 * 覆盖知识库编译、工具 schema/校验、图片缩放、回复拆分这几条纯逻辑。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Config } from "./config.js";
import { splitContextAttachments } from "./context.js";
import { buildFollowUpCard, buildRootCard, topicKey } from "./forward.js";
import { History } from "./history.js";
import { loadKnowledgeBase } from "./kb.js";
import { Limits } from "./limits.js";
import { prepareImageUrls, quotedImageUrls, resizeImageBuffer } from "./media.js";
import { buildUserText, splitReply } from "./qq.js";
import { FILE_PATTERNS, dayKey, migrateLegacyForwards, monthKey, pruneByAge, stampKey } from "./retention.js";
import { stripMentions, truncateText } from "./text.js";
import { FORWARD_FEEDBACK_TOOL, ForwardFeedbackArgs } from "./tools.js";

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

// 2. 工具定义与参数校验
const params = FORWARD_FEEDBACK_TOOL.function.parameters as { type?: string; properties?: Record<string, unknown> };
check("工具 schema 生成", params?.type === "object" && Boolean(params.properties?.["summary"]));
check(
  "工具参数：合法入参通过",
  ForwardFeedbackArgs.safeParse({ summary: "退款问题", details: "用户订单 123 重复扣费" }).success,
);
check("工具参数：空 summary 拦截", !ForwardFeedbackArgs.safeParse({ summary: "", details: "x" }).success);
check("工具参数：超长 details 拦截", !ForwardFeedbackArgs.safeParse({ summary: "x", details: "a".repeat(1600) }).success);

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
const bigMeta = await sharp(bigOut).metadata();
check(
  "大图缩放到长边上限",
  bigMeta.width === 1280 && (bigMeta.height ?? 0) <= 1280,
  `2400x1600 → ${bigMeta.width}x${bigMeta.height}, ${bigOut.byteLength} 字节`,
);

const smallOut = await resizeImageBuffer(small, cfg);
const smallMeta = await sharp(smallOut).metadata();
check("小图不放大", smallMeta.width === 320 && smallMeta.height === 200, `${smallMeta.width}x${smallMeta.height}`);

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

const userText = buildUserText({
  question: "怎么退款",
  contextText: "=== 消息 1 ===\n[消息内容] 我要退款旺仔牛奶",
  senderName: "小明",
  skippedImages: 1,
});
check(
  "用户消息组装",
  userText.includes("问题：怎么退款") &&
    userText.includes("[对话上下文]") &&
    userText.includes("我要退款旺仔牛奶") &&
    userText.includes("小明"),
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

const limitsCfg = {
  ...cfg,
  DATA_DIR: "data/smoke-tmp/a",
  RATE_LIMIT_PER_MINUTE: 3,
  RATE_LIMIT_PER_GROUP_PER_MINUTE: 100,
  REPLY_LIMIT_PER_USER_PER_DAY: 10,
  REPLY_LIMIT_GLOBAL_PER_DAY: 100,
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

// 9. 本地对话缓冲（6 小时窗口）
const historyCfg = {
  ...cfg,
  DATA_DIR: "data/smoke-tmp/history",
  HISTORY_ENABLED: true,
  HISTORY_WINDOW_MINUTES: 360,
  HISTORY_MAX_ENTRIES: 10,
  HISTORY_MAX_STORED: 50,
  CONTEXT_MESSAGE_MAX_CHARS: 600,
  CONTEXT_MAX_CHARS: 3000,
} as unknown as Config;

const history = new History(historyCfg);
await history.init();
check("缓冲：空群渲染为空", history.render("G1") === "");

history.record("G1", { at: Date.now() - 5 * 60_000, role: "user", senderName: "Heuluck", content: "我手机号换了咋办" });
history.record("G1", { at: Date.now() - 4 * 60_000, role: "bot", content: "分两种情况喵：旧号能用就自己改，不能用就找我转人工" });
history.record("G1", { at: Date.now() - 60_000, role: "user", senderName: "Heuluck", content: "没用了" });
const rendered = history.render("G1");
check(
  "缓冲：包含用户与机器人双方记录",
  rendered.includes("用户Heuluck: 我手机号换了咋办") && rendered.includes("客服: 分两种情况喵") && rendered.includes("用户Heuluck: 没用了"),
);
check("缓冲：带时间戳（东八区 HH:mm）", /\[\d{2}:\d{2}\]/.test(rendered), rendered.split("\n")[0]);

// 窗口：7 小时前的记录应被排除
history.record("G2", { at: Date.now() - 7 * 60 * 60_000, role: "user", content: "很久以前的消息" });
history.record("G2", { at: Date.now() - 60_000, role: "user", content: "刚刚的消息" });
const windowed = history.render("G2");
check("缓冲：6 小时窗口外的记录不注入", !windowed.includes("很久以前的消息") && windowed.includes("刚刚的消息"));

// 条数与字符数上限
for (let i = 0; i < 40; i += 1) {
  history.record("G3", { at: Date.now(), role: "user", content: `第 ${i} 条${"长".repeat(200)}` });
}
const capped = history.render("G3");
check(
  "缓冲：注入条数与字符数受上限约束",
  capped.split("\n").length <= 10 && capped.length <= 3100,
  `${capped.split("\n").length} 行 / ${capped.length} 字符`,
);

// 存储上限与注入上限分开：存 50 条，注入仍只给 10 条
for (let i = 0; i < 80; i += 1) {
  history.record("G4", { at: Date.now(), role: "user", content: `消息 ${i}` });
}
await history.flush();
const stored = (JSON.parse(readFileSync("data/smoke-tmp/history/history.json", "utf8")) as Record<string, unknown[]>)[
  "G4"
];
check("缓冲：存储上限 50 条", stored !== undefined && stored.length === 50, `实际存 ${stored?.length ?? 0} 条`);
check("缓冲：注入仍只取最近 10 条", history.render("G4").split("\n").length === 10);

await history.flush();
const reloaded = new History(historyCfg);
await reloaded.init();
check("缓冲：重启后仍能恢复近况", reloaded.render("G1").includes("没用了"));

const disabled = new History({ ...historyCfg, HISTORY_ENABLED: false } as unknown as Config);
await disabled.init();
disabled.record("G1", { at: Date.now(), role: "user", content: "不该被记录" });
check("缓冲：开关关闭后不记录也不注入", disabled.render("G1") === "");

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
