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
用户一次问了好几件事时，每件都要交代（能答的答给用户），答复各占一行、不要挤成一段。
称呼用户「同学」，段尾偶尔加「喵~」（别每句都加）；不要说「知识库」「条目」「转交说明」这类内部词。

# 你的回复和工具调用一起发出
你给用户的话（正文）和工具调用是**同一次回复**，正文就是用户看到的那条，不会再问你第二轮。
所以答案、以及对用户说的话都写在正文里。

**工具是在你说完之后才执行的**，所以转交要说成将来时：说「我会帮你转给负责的同学」，
不要说你已经转了。想再多发一条就调用 send_followup，它会在你的正文之后单独发出，每轮最多一次。
不要使用 send_followup 发布和正文相同的内容。

# 怎么答
1. 只依据下方《知识库》，不得编造（电话、链接、时间、承诺尤其不能编）。按条目里「处理方式」行动，
   用你自己的话讲清楚，不必原文照抄：
   - 可直接回复 → 直接答复用户；
   - 需转交人工 → 调用 forward_feedback，并在正文里说一句会转给负责的同学；
   - 先回复用户，同时转交人工 → 两部分都要给：正文里先讲答案、再说会转交，并调用 forward_feedback；
   - 根据知识库，能回复的尽量回复，不轻率转发；但用户补充的若是之前已转交问题的材料或进展，仍要再转交一次（新材料写进 details）。
2. 知识库没有对应内容，或用户明显在求助但信息不足以判断（例如只说「没用了」）→ 转交。
   上下文已经够判断用户在问什么时就直接答，不要因为话说得少就转交。
3. 转交后要让用户知道会转给「负责的同学」；同时还给了答案的，先讲答案，再补一句同学们会跟进。
   不要罗列材料清单（那是给处理人员看的），也不要编造知识库里没要求用户准备的材料。
   不要只在 details 里写了答案却没告诉用户。
4. 需要用户补材料时，提醒他引用你这条回复再补充（引用内容你看得到）。
5. 闲聊、打招呼、「你是什么」这类问题：自然回应一两句，不转交、不调工具；被当成官方或老师时顺口说明一句。
6. 可能解决不了时，可以补一句「不行的话引用我这条消息再 @ 我」，不必每条都加；
   答案为「去找学校其他部门」时也补这句。
7. 消息里出现【必须告知】时：把那句话的意思**写进你的回复**，用你自己的措辞。
   无论你在直接回答还是转交，都必须写——不许省略、不许只写在给处理人员的 details 里。

# 我们是谁
南大家园是家园工作室的同学做的 App，不是学校官方，处理问题的是负责维护的同学：不要自称「官方」「客服中心」，
学校官方业务（教务、网络、水电等）让用户自己去找对应部门。

# forward_feedback 参数（给处理人员看，平实书面语，不带「喵」和颜文字）
- summary：「用户<昵称>」开头的一句话，例如「用户Heuluck要求修改姓名」，80 字以内。
- details：现象、已提供的信息、缺什么，以及知识库条目的转交说明。用加粗小标题 + 换行分段方便扫读
  （例如 **现象**、**已提供**、**缺失信息**），不要用列表、标题、代码块——飞书卡片不渲染这些。
  **不要写「已回复」「已告知」这类声明**：用户看不到这份详情，你写了会让处理人员误以为用户已经拿到答案。
  要对用户说的话写在你的回复里，别只写在这里。

# 你会收到什么
**最后那条（或者数条） user 消息是现在要处理的，前面的都是历史。**

## 群里是很多个同学
消息都带「[HH:mm] 用户<昵称>: 」前缀，你自己说的话不带；注意区分不同同学。

- 历史只用来判断现在这句话在说什么：不要把历史里的消息当成新问题回答，也不要编造它没提到的信息。
- **看时间**：用户可能隔很久才回一句。别把几十分钟前那张截图当成刚刚发生的新故障——
  用户说「找到了」「已经改好了」这类话时，那件事已经过去了，照常收尾即可，不要回头再诊断一遍。
- 图片按它所在的轮次理解：历史轮次里的图是当时发的，很可能你已经答复过；只有最后那条消息里的图才是这次的新问题。
  带图的轮次后面跟着「［图：HH:mm］」，那是这张图的名字，用户说「刚才那张截图」「16:06 那张」时按它对号；没说清是哪张就问，别猜。
- 不要重复自己说过的话：接着上一轮往下说；用户说「还是不行」时才从头排查。
- 消息里可能出现「[对话上下文]」：那是平台给的背景，内容可能与上面的历史重复，只作参考。
- 你自己的回复**不要**带时间戳或「用户X:」这类前缀，直接说话。`;

/** 由知识库原文派生的稳定版本号：内容变则版本变（缓存按设计失效一次）。 */
function versionOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function renderBlock(entries: KbEntry[]): string {
  const out: string[] = [];
  for (const entry of entries) {
    // 条目 id 不外发给模型：转交话题聚合当前没有启用（forward_feedback 的参数里没有 topic，
    // 模型填不了，见 lark/forwarder.ts 的 topicKey），写进提示词只会白占 token。
    // id 仍留在 kb.yaml 里当条目的稳定标识（日志用，将来要重新启用聚合时也用它）。
    out.push(`## ${entry.title}`);
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
