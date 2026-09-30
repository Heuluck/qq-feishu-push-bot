import { loadConfig } from "./core/config.js";
import { loadDotEnv } from "./core/env.js";
import { log, setLogLevel } from "./core/log.js";
import { KnowledgeBaseRuntime } from "./kb/runtime.js";
import { LlmClient } from "./llm/client.js";
import { LarkKbAdmin } from "./lark/admin.js";
import { FeedbackForwarder } from "./lark/forwarder.js";
import { createQqBot } from "./qq/bot.js";
import { initRawDump } from "./store/debugDump.js";
import { History } from "./store/history.js";
import { Limits } from "./store/limits.js";
import { Maintenance, migrateLegacyForwards } from "./store/retention.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);

  // 兜底：任何「发出去就不管」的 Promise 被拒绝时只记日志。Node 默认会因此结束进程，
  // 而一次飞书 429、一次落盘失败都不该把 QQ 机器人一起带走。
  process.on("unhandledRejection", (reason) => {
    log.error("boot", `未处理的 Promise 拒绝（已忽略，不退出）：${reason instanceof Error ? reason.message : String(reason)}`);
  });

  // 知识库：基线（kb.yaml，人工维护）+ 飞书补充层（kb.feishu.yaml，群里菜单写）。持有在运行时里，
  // 飞书那边改完就地热重载，不必重启容器，更不必重新 deploy。
  const kb = new KnowledgeBaseRuntime(cfg);
  await kb.load();
  await initRawDump(cfg.DATA_DIR, cfg.LOG_LEVEL === "debug");

  // 数据文件：旧格式迁移 → 启动即执行一次保留策略 → 之后每 6 小时一次。
  await migrateLegacyForwards(cfg.DATA_DIR);
  const maintenance = new Maintenance(cfg.DATA_DIR, cfg.DATA_RETENTION_DAYS);
  await maintenance.runOnce();
  maintenance.start();

  const initial = kb.current();
  log.info(
    "boot",
    `知识库已加载：kb-${initial.version}（基线 kb-${initial.baseVersion} ${initial.entries.length} 条；` +
      `飞书补充 ${initial.feishuPresent ? `fs-${initial.feishuVersion} ${initial.feishuEntries.length} 条` : "无"}` +
      `${initial.feishuEnabled ? "" : "（注入已停用）"}），system prompt ${initial.systemPrompt.length} 字符`,
  );
  if (initial.systemPrompt.length > cfg.KB_MAX_PROMPT_CHARS) {
    log.warn(
      "boot",
      `知识库偏大（system prompt ${initial.systemPrompt.length} 字符，超过 ${cfg.KB_MAX_PROMPT_CHARS}），` +
        `可能拖慢响应并抬高成本，建议精简；飞书卡片会拒绝继续写入直到降下来`,
    );
  }

  const forwarder = new FeedbackForwarder(cfg);
  await forwarder.init();

  const limits = new Limits(cfg);
  await limits.init();

  const history = new History(cfg);
  await history.init();

  const llm = new LlmClient(cfg);
  const bot = createQqBot({ cfg, llm, forwarder, limits, history, systemPrompt: kb.systemPrompt });

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    log.info("boot", `收到 ${signal}，准备退出…`);
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("boot", `启动完成：模型 ${cfg.LLM_MODEL} @ ${cfg.LLM_BASE_URL}（出站长连接，无监听端口）`);
  log.info(
    "boot",
    `生成参数：max_tokens=${cfg.LLM_MAX_TOKENS}，思考档位=${cfg.LLM_REASONING_EFFORT}（none = 关闭思考；` +
      `推理内容计入 max_tokens，关掉可避免正文被推理挤空）`,
  );

  // 飞书知识库管理复用反馈群：@机器人 弹主菜单，之后所有卡片收进那条消息的话题里。
  // 它在自己的长连接上跑，起不来也只记日志，不影响 QQ 侧。
  const admin = new LarkKbAdmin(cfg, kb);
  await admin.start(forwarder.targetChatId, controller.signal);

  await bot.start(controller.signal);
  bot.stop();
  await admin.stop();
  maintenance.stop();
  await Promise.all([limits.flush(), history.flush()]);
  log.info("boot", "已退出");
}

main().catch((err: unknown) => {
  log.error("boot", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
