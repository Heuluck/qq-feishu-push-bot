type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";

export function setLogLevel(level: string): void {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") minLevel = level;
}

function emit(level: Level, tag: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${tag}] ${message}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export const log = {
  debug: (tag: string, message: string, extra?: unknown) => emit("debug", tag, message, extra),
  info: (tag: string, message: string, extra?: unknown) => emit("info", tag, message, extra),
  warn: (tag: string, message: string, extra?: unknown) => emit("warn", tag, message, extra),
  error: (tag: string, message: string, extra?: unknown) => emit("error", tag, message, extra),
};

/** @tencent-connect/qqbot-nodejs 的 Logger 形状。 */
export const qqLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => log.info("qq-sdk", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log.error("qq-sdk", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log.warn("qq-sdk", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log.debug("qq-sdk", msg, meta),
};

/** @larksuiteoapi/node-sdk 的 Logger 形状（可变参数）。 */
export const larkLogger = {
  error: (...msg: unknown[]) => log.error("lark-sdk", msg.map(String).join(" ")),
  warn: (...msg: unknown[]) => log.warn("lark-sdk", msg.map(String).join(" ")),
  info: (...msg: unknown[]) => log.info("lark-sdk", msg.map(String).join(" ")),
  debug: (...msg: unknown[]) => log.debug("lark-sdk", msg.map(String).join(" ")),
  trace: (...msg: unknown[]) => log.debug("lark-sdk", msg.map(String).join(" ")),
};
