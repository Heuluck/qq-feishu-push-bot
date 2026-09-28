type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";

export function setLogLevel(level: string): void {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") minLevel = level;
}

/**
 * 把可能来自用户/平台的文本压成单行，防日志注入。
 *
 * 换行转义成字面 `\n`、剥掉 ANSI 转义序列与控制字符：否则一条含换行、或带终端控制码的消息
 * 就能在日志里伪造出额外的行、或把日志刷花。对象类 `extra` 走 `util.inspect` 本就带转义，
 * 这里只处理会被原样拼进日志行的字符串。
 */
export function sanitizeLogText(text: string, max = 4_000): string {
  const oneLine = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\u001b/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\r\n\u2028\u2029]+/g, "\\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return oneLine.length > max ? `${oneLine.slice(0, max)}…（日志过长，已截断）` : oneLine;
}

function emit(level: Level, tag: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${tag}] ${sanitizeLogText(message)}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, typeof extra === "string" ? sanitizeLogText(extra) : extra);
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
