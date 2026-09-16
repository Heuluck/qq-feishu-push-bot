import { z } from "zod";

/** .env 里还没粘贴真实凭据时的占位符形态。 */
const PLACEHOLDER = /^(PASTE_|YOUR_|在此|TODO)/i;

const requiredStr = z
  .string()
  .trim()
  .min(1, "不能为空")
  .refine((v) => !PLACEHOLDER.test(v), "仍是占位符，请在 .env 中粘贴真实值");

const EnvSchema = z.object({
  // QQ 开放平台
  QQBOT_APP_ID: requiredStr,
  QQBOT_APP_SECRET: requiredStr,
  QQ_GROUP_OPENID: z.string().trim().optional(),

  // 飞书自建应用
  LARK_APP_ID: requiredStr,
  LARK_APP_SECRET: requiredStr,
  LARK_FEEDBACK_CHAT_ID: z.string().trim().optional(),

  // 模型（OAI 兼容）
  LLM_BASE_URL: z
    .string()
    .trim()
    .refine((v) => /^https?:\/\/.+/i.test(v), "需要形如 https://api.deepseek.com 的完整地址"),
  LLM_API_KEY: requiredStr,
  LLM_MODEL: z.string().trim().min(1).default("deepseek-flash"),
  LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(8192).default(1024),
  LLM_DEADLINE_MS: z.coerce.number().int().min(5_000).max(120_000).default(45_000),

  // 图片
  /**
   * 客户端缩放的长边上限。
   *
   * 依据 DeepSeek 视觉文档：每张图 token 上限 1024，且大于约 1300×1300 总像素（≈169 万）的图
   * 都会被它内部缩到那个量级——也就是说缩得比这更狠只会白白丢掉截图里的文字细节，省不到钱
   * （单图最多约 0.002 元）。1920 长边对应 1080×2400 手机截图 → 864×1920 ≈ 166 万像素，
   * 正好落在它内部目标附近；再大的图（如相机原图）仍会被缩到这里，避免上传无谓的字节。
   */
  IMG_MAX_EDGE: z.coerce.number().int().min(256).max(4096).default(1920),
  IMG_MAX_COUNT: z.coerce.number().int().min(0).max(4).default(2),
  IMG_MAX_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
  /**
   * 上下文（对话缓冲）里最多为该用户读几张图。
   * 与 IMG_MAX_COUNT（单条消息自带的图）分开算：用户常常连发几张截图、中间还夹着别人的消息，
   * 因此按「该用户最近的图」去找，而不是按「最近 N 条消息」去找。
   */
  IMG_CONTEXT_MAX_COUNT: z.coerce.number().int().min(0).max(20).default(5),
  /** 同一个用户每天最多读几张图（超出后仍回答文字问题，但会告知用户读图额度用完）。 */
  IMG_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(1).max(1000).default(10),

  // 超长内容截断
  /** 用户单条提问最多保留多少字符（超出部分截断并标注）。 */
  QUESTION_MAX_CHARS: z.coerce.number().int().min(200).max(50_000).default(4_000),
  /** 上下文整段最多保留多少字符（保留最新的部分）。 */
  CONTEXT_MAX_CHARS: z.coerce.number().int().min(200).max(50_000).default(3_000),
  /** 上下文里单条消息最多保留多少字符。 */
  CONTEXT_MESSAGE_MAX_CHARS: z.coerce.number().int().min(50).max(10_000).default(600),
  /** 本地对话缓冲：平台没给上下文时用它兜底（平台给了就优先用平台的）。 */
  HISTORY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** 本地对话缓冲保留多久（分钟），默认 6 小时。 */
  HISTORY_WINDOW_MINUTES: z.coerce.number().int().min(1).max(10_080).default(360),
  /** 本地对话缓冲最多注入几条（默认最近 10 条）。 */
  HISTORY_MAX_ENTRIES: z.coerce.number().int().min(1).max(100).default(10),
  /** 本地对话缓冲最多存放几条（只影响存储；留多一些，方便以后调大注入条数）。 */
  HISTORY_MAX_STORED: z.coerce.number().int().min(1).max(1000).default(50),
  /** 回复最多分成几条发送（QQ 对同一 msg_id 的被动回复条数有限，防御性设上限）。 */
  REPLY_MAX_CHUNKS: z.coerce.number().int().min(1).max(10).default(3),

  // 频次与配额
  /** 单用户每分钟最多处理几条消息（豁免用户不受此限）。 */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(6),
  /** 单群每分钟最多处理几条消息。 */
  RATE_LIMIT_PER_GROUP_PER_MINUTE: z.coerce.number().int().min(1).max(6000).default(40),
  /** 单用户每日最多处理几条消息。 */
  REPLY_LIMIT_PER_USER_PER_DAY: z.coerce.number().int().min(1).max(10_000).default(10),
  /** 全机器人每日最多处理几条消息（成本护栏）。 */
  REPLY_LIMIT_GLOBAL_PER_DAY: z.coerce.number().int().min(1).max(100_000).default(100),
  /** 豁免名单：逗号分隔的用户 openid，不受分钟级限制，每日额度单独放宽。 */
  PRIVILEGED_USERS: z.string().trim().default(""),
  /** 豁免用户的每日额度。 */
  PRIVILEGED_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(100_000).default(100),

  // 转交
  FORWARD_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
  /** 同一用户同一主题在这个时间窗内再次转交，会作为话题回复挂到原卡片下。 */
  FORWARD_TOPIC_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // 路径与日志
  KB_PATH: z.string().trim().min(1).default("kb/kb.yaml"),
  DATA_DIR: z.string().trim().min(1).default("data"),
  /** 数据文件（转交留档/调试转储/配额归档）的保留天数。 */
  DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  // 空字符串按「未设置」处理，这样 .env 里注释掉的选填项不会误触发校验。
  const source: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    source[key] = value === "" ? undefined : value;
  }

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(root)";
      return `  - ${name}: ${issue.message}`;
    });
    throw new Error(`配置校验失败，请检查 .env：\n${lines.join("\n")}`);
  }
  return parsed.data;
}
