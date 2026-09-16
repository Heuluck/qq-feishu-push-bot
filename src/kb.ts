import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const EntrySchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    keywords: z.array(z.string().trim().min(1)).min(1),
    /**
     * answer             直接回复，不建工单
     * forward            只转交人工
     * answer_and_forward 先回复用户，同时转交人工（用户自助能办、但可能需要人工兜底的场景）
     */
    route: z.enum(["answer", "forward", "answer_and_forward"]),
    answer: z.string().trim().min(1).optional(),
    forward_hint: z.string().trim().min(1).optional(),
  })
  .refine((entry) => entry.route === "forward" || Boolean(entry.answer), {
    message: "route=answer / answer_and_forward 的条目必须提供 answer",
  });

const ROUTE_LABEL: Record<"answer" | "forward" | "answer_and_forward", string> = {
  answer: "可直接回复",
  forward: "需转交人工",
  answer_and_forward: "先回复用户，同时转交人工",
};

/**
 * 变量占位符 `{{名称}}`（名称两侧允许留空格）。
 * YAML 本身没有字符串插值，锚点又只能整体替换一个节点、没法嵌进句子中间，
 * 所以「同一段文本只写一处」这件事只能由加载器来做。
 *
 * 每次现建正则：`replace` 会改写 /g 实例的 lastIndex，而变量展开是递归的
 * （replace 回调里还会再替换一次），共用一个实例等于依赖引擎对重入的处理。
 */
function placeholderPattern(): RegExp {
  return /\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g;
}

/** 第一遍解析：variables 先按变量读出来，entries 原样放行——替换完变量再按 EntrySchema 严格校验。 */
const KbFileSchema = z.object({
  variables: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(z.unknown()).min(1),
});

export type KbEntry = z.infer<typeof EntrySchema>;

export interface KnowledgeBase {
  version: string;
  entries: KbEntry[];
  /** 编译后的知识库文本块（逐字节稳定，改内容才会变）。 */
  block: string;
  /** 完整 system prompt：静态规则 + 知识库，作为请求的固定前缀。 */
  systemPrompt: string;
}

/**
 * 静态规则段。这里绝不能出现时间戳、随机数、每次请求都会变的内容，
 * 否则前缀缓存会整体失效（提示词缓存按字节前缀匹配）。
 */
const SYSTEM_RULES = `你是 QQ 群里的「南大家园」客服机器人，群里都是同学。

# 说话方式
短：一般 1-2 句，最多 3 句，一段说完不要空行；不要套模板、不要重复自己说过的话。
称呼用户「同学」，段尾偶尔加「喵~」（别每句都加）；不要说「知识库」「条目」「转交说明」这类内部词。

# 怎么答
1. 只依据下方《知识库》，不得编造（电话、链接、时间、承诺尤其不能编）。按条目里「处理方式」行动，
   用你自己的话讲清楚，不必原文照抄：
   - 可直接回复 → 直接答复用户；
   - 需转交人工 → 调用 forward_feedback；
   - 先回复用户，同时转交人工 → 两部分都要给：先把答案讲给用户，再调用 forward_feedback。
2. 知识库没有对应内容，或用户明显在求助但信息不足以判断（例如只说「没用了」）→ 转交。
   上下文已经够判断用户在问什么时就直接答，不要因为话说得少就转交。
3. 转交后要让用户知道已转给「负责的同学」；同时还给了答案的，先讲答案，再补一句同学们会跟进。
   不要罗列材料清单（那是给处理人员看的），也不要编造知识库里没要求用户准备的材料。
   用户一次问了多件事时，每件都要在回复里交代：能答的答给用户，该转交的说已转交——
   不要只在 details 里写了答案却没告诉用户。
4. 需要用户补材料时，提醒他引用你这条回复再补充（引用内容你看得到）。
5. 闲聊、打招呼、「你是什么」这类问题：自然回应一两句，不转交、不调工具；被当成官方或老师时顺口说明一句。
6. 可能解决不了时，可以补一句「不行的话引用我这条消息再 @ 我」，不必每条都加；
   答案为「去找学校其他部门」时也补这句。
7. 消息里出现【必须告知】时：把那句话的意思**写进你的回复**，用你自己的措辞。
   无论你在直接回答还是转交，都必须写——不许省略、不许只写在给处理人员的 details 里。

# 我们是谁
南大家园是我们家园工作室的学生做的 App，不是学校官方，处理问题的是负责维护的同学：不要自称「官方」「客服中心」，
也不要让人以为我们代表学校；学校官方业务（教务、网络、水电等）该找对应部门的，就让用户去找对应部门。

# forward_feedback 参数（给处理人员看，平实书面语，不带「喵」和颜文字）
- summary：「用户<昵称>」开头的一句话，例如「用户Heuluck要求修改姓名」，80 字以内。
- details：现象、已提供的信息、缺什么，以及知识库条目的转交说明。用加粗小标题 + 换行分段方便扫读
  （例如 **现象**、**已提供**、**缺失信息**），不要用列表、标题、代码块——飞书卡片不渲染这些。

# 你会收到什么
用户消息可能带「对话上下文」「近期对话记录」或「机器人自己说过的话」（群里此前的消息，含你自己发过的）与图片。
- 上下文只用来判断用户在说什么：不要把历史消息当成新问题回答，也不要编造它没提到的信息。
- 出现【本轮图片】时按它的说明分辨每张图：只有来自当前这条消息的才是这次要解决的问题；
  其余是翻出来的旧图、很可能你已经答复过，不要把它当成又出现的新故障。
- 「机器人自己说过的话」是你自己上一轮的答复，用户接着追问时以它为准，不要从头再答一遍。`;

/** 由知识库原文派生的稳定版本号：内容变则版本变（缓存按设计失效一次）。 */
function versionOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function renderBlock(entries: KbEntry[]): string {
  const out: string[] = [];
  for (const entry of entries) {
    // 条目 id 一并给模型，转交时用它做话题标识，实现「同一主题聚合到一条话题」。
    out.push(`## ${entry.title}（id: ${entry.id}）`);
    out.push(`关键词：${entry.keywords.join("、")}`);
    out.push(`处理方式：${ROUTE_LABEL[entry.route]}`);
    if (entry.answer) out.push(`答案：${entry.answer}`);
    if (entry.forward_hint) out.push(`转交说明：${entry.forward_hint}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function placeholder(name: string): string {
  return `{{${name}}}`;
}

function undefinedVariable(file: string, name: string): Error {
  return new Error(`${file}: 变量 ${placeholder(name)} 未定义，请先在顶层 variables 里补上`);
}

/**
 * 变量值只能是字符串。不加引号的 `5.0`、`0791` 会被 YAML 当成数字，静默丢掉小数和前导零，
 * 而变量是直接拼给同学看的，宁可启动时报错让人加引号。
 */
function variableText(file: string, name: string, value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error(
    `${file}: 变量 ${placeholder(name)} 的值被 YAML 解析成了 ${typeof value}（${String(value)}），` +
      `请加引号写成 "${String(value)}"`,
  );
}

/** 展开 variables 自身：变量可以引用变量，循环引用直接报错。 */
function expandVariables(raw: Record<string, unknown>, file: string): Map<string, string> {
  const done = new Map<string, string>();
  const stack: string[] = [];

  const expand = (name: string): string => {
    const cached = done.get(name);
    if (cached !== undefined) return cached;
    const value = raw[name];
    if (value === undefined) throw undefinedVariable(file, name);
    const seenAt = stack.indexOf(name);
    if (seenAt !== -1) {
      throw new Error(`${file}: 变量循环引用 ${[...stack.slice(seenAt), name].map(placeholder).join(" → ")}`);
    }
    stack.push(name);
    // trim 掉块标量 `|` 自带的收尾换行，否则变量拼进句子中间会把句子断成两行。
    const expanded = variableText(file, name, value)
      .trim()
      .replace(placeholderPattern(), (_whole, ref: string) => expand(ref));
    stack.pop();
    done.set(name, expanded);
    return expanded;
  };

  for (const name of Object.keys(raw)) expand(name);
  return done;
}

/** 替换 entries 里所有字符串的占位符。没解析掉的占位符一律报错——否则花括号会原样发给同学。 */
function substituteVariables(value: unknown, vars: Map<string, string>, file: string): unknown {
  if (typeof value === "string") {
    const replaced = value.replace(placeholderPattern(), (_whole, name: string) => {
      const resolved = vars.get(name);
      if (resolved === undefined) throw undefinedVariable(file, name);
      return resolved;
    });
    const at = replaced.indexOf("{{");
    if (at !== -1) {
      const snippet = (replaced.slice(at, at + 30).split("\n")[0] ?? "").trim();
      throw new Error(
        `${file}: 占位符「${snippet}」没解析成功；变量名只能用字母、数字、下划线、短横线，且必须在顶层 variables 里定义`,
      );
    }
    return replaced;
  }
  if (Array.isArray(value)) return value.map((item) => substituteVariables(item, vars, file));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteVariables(item, vars, file)]));
  }
  return value;
}

export function loadKnowledgeBase(path: string): KnowledgeBase {
  const raw = readFileSync(path, "utf8");
  const doc = KbFileSchema.parse(parseYaml(raw));
  const vars = expandVariables(doc.variables ?? {}, path);
  const entries = z.array(EntrySchema).min(1).parse(substituteVariables(doc.entries, vars, path));
  const version = versionOf(raw);
  const block = renderBlock(entries);
  const systemPrompt = `${SYSTEM_RULES}\n\n# 知识库（版本 kb-${version}，共 ${entries.length} 条）\n\n${block}\n`;
  return { version, entries, block, systemPrompt };
}
