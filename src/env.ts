import { existsSync, readFileSync } from "node:fs";

/**
 * 极简 .env 读取：只做 KEY=VALUE 解析，已存在的环境变量优先。
 * 不引入 dotenv 依赖；Docker 部署时由 compose 的 env_file 注入，这里会自然跳过。
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
