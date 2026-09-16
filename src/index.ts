import { loadConfig } from "./config.js";
import { initRawDump } from "./debugDump.js";
import { loadDotEnv } from "./env.js";
import { FeedbackForwarder } from "./forward.js";
import { History } from "./history.js";
import { loadKnowledgeBase } from "./kb.js";
import { Limits } from "./limits.js";
import { LlmClient } from "./llm.js";
import { log, setLogLevel } from "./log.js";
import { createQqBot } from "./qq.js";
import { Maintenance, migrateLegacyForwards } from "./retention.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);

  const kb = loadKnowledgeBase(cfg.KB_PATH);
  await initRawDump(cfg.DATA_DIR, cfg.LOG_LEVEL === "debug");

  // 数据文件：旧格式迁移 → 启动即执行一次保留策略 → 之后每 6 小时一次。
  await migrateLegacyForwards(cfg.DATA_DIR);
  const maintenance = new Maintenance(cfg.DATA_DIR, cfg.DATA_RETENTION_DAYS);
  await maintenance.runOnce();
  maintenance.start();
  log.info(
    "boot",
    `知识库已加载：kb-${kb.version}，${kb.entries.length} 条，system prompt ${kb.systemPrompt.length} 字符`,
  );
  if (kb.systemPrompt.length > 8_000) {
    log.warn("boot", "知识库偏大（system prompt 超过 8000 字符），可能拖慢响应并抬高成本，建议精简");
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
  await bot.start(controller.signal);
  bot.stop();
  maintenance.stop();
  await Promise.all([limits.flush(), history.flush()]);
  log.info("boot", "已退出");
}

main().catch((err: unknown) => {
  log.error("boot", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
