/**
 * 从「正文」里兜底解析工具调用。
 *
 * 背景：deepseek-flash 这类模型有时不返回结构化的 `tool_calls`，而是把调用写进正文——
 * 既可能是它原生的 `<||DSML||invoke name="...">` 标记，也可能是中文散文式的一行
 * （`调用 research tech_id="A-07"`）。参考实现（paperclip-simulator 的 parseContentTool）
 * 对这种形态做了兜底解析，并指出这是该模型的常见行为，不是偶发。
 *
 * 不处理的后果有两层：
 *   1. 内部信息（summary/details 里的知识库条目、转交说明）被当作回复发到群里；
 *   2. 那次工具调用**并没有真的发生**（我们没收到 tool_calls），用户却被告知已转交。
 */

const DSML = "<\\|{2}DSML\\|{2}";
const CALLS_BLOCK = new RegExp(`${DSML}calls>[\\s\\S]*?(?:<\\/\\|{2}DSML\\|{2}calls>|$)`, "g");
const INVOKE_BLOCK = new RegExp(`${DSML}invoke[\\s\\S]*?(?=<\\/\\|{2}DSML\\|{2}invoke>|$)`, "g");
/** 名字/参数的引号两种都认：模型写单引号并不罕见，漏掉就变成「标记被删、调用没执行」。 */
const INVOKE_NAME = new RegExp(`${DSML}invoke\\s+name=["']([^"']+)["']`);
const PARAMETER = new RegExp(
  `${DSML}parameter\\s+name=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/\\|{2}DSML\\|{2}parameter>`,
  "g",
);
/** 只用来判断「正文里有没有调用标记」，与上面那些带 lastIndex 的 /g 正则分开。 */
const DSML_MARK = /<\|\|DSML\|\|/;
/** 我们自己的内部标记也可能被模型抄进回复。 */
const INTERNAL_MARKER = /【必须告知】/g;

export interface TextToolCall {
  name: string;
  /** 参数以 JSON 字符串给出，便于直接喂给现有的工具执行器。 */
  argsJson: string;
}

export interface ParsedTextToolCalls {
  /** 去掉调用标记后的正文（可以直接发给用户）。 */
  cleaned: string;
  calls: TextToolCall[];
  /**
   * 正文里有调用标记，却一个调用都没解析出来。
   *
   * 标记无论如何都会从正文里删掉（不能让内部信息漏到群里），所以这种情况必须让调用方
   * 知道并记日志：否则表现就是「模型说已转交、标记也消失了、但那次调用根本没发生」。
   */
  unparsedMarkup: boolean;
}

/** 抠出 k="v" / k：v / k 为「v」这类参数（兼容半角全角标点）。 */
function looseArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w]*)\s*(?:[:=：＝]|\s为\s*)\s*(?:"([^"]*)"|'([^']*)'|「([^」]*)」|([^\s,，。;；]+))/g;
  for (const match of text.matchAll(re)) {
    const value = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (match[1] && value !== undefined) out[match[1]] = value;
  }
  return out;
}

/** 尝试从 JSON 片段里取调用（{"tool"/"name": "...", "args"/"arguments": {...}}）。 */
function jsonCall(text: string): TextToolCall | undefined {
  const block = text.match(/\{[\s\S]*\}/);
  if (!block) return undefined;
  try {
    const parsed = JSON.parse(block[0]) as Record<string, unknown>;
    const name = String(parsed["tool"] ?? parsed["name"] ?? parsed["function"] ?? "");
    if (name === "") return undefined;
    const args = parsed["args"] ?? parsed["arguments"] ?? parsed["parameters"];
    return { name, argsJson: JSON.stringify(args ?? {}) };
  } catch {
    return undefined;
  }
}

/** 从正文里解析工具调用，并返回剔除标记后的正文。 */
export function extractTextToolCalls(text: string): ParsedTextToolCalls {
  const calls: TextToolCall[] = [];

  // 1) 原生标记形态（<||DSML||...>）
  for (const block of text.match(CALLS_BLOCK) ?? []) {
    const invokes = block.match(new RegExp(`${DSML}invoke[\\s\\S]*?(?=<\\/\\|{2}DSML\\|{2}invoke>|$)`, "g")) ?? [block];
    for (const invoke of invokes) {
      const name = INVOKE_NAME.exec(invoke)?.[1];
      if (!name) continue;
      const args: Record<string, string> = {};
      for (const match of invoke.matchAll(PARAMETER)) {
        if (match[1]) args[match[1]] = (match[2] ?? "").trim();
      }
      calls.push({ name, argsJson: JSON.stringify(args) });
    }
  }

  // 2) JSON 形态
  if (calls.length === 0) {
    const fromJson = jsonCall(text);
    if (fromJson) calls.push(fromJson);
  }

  // 3) 散文形态：调用 <name> / 调用工具 <name> / invoke name="<name>"
  if (calls.length === 0) {
    // 空白与可选分隔符写成一个字符类。原来写成 `\s*[:：,，]?\s*`，失败时要把两者的组合
    // 逐个回溯一遍：模型（或被注入的回复）吐一串空格就退化成 O(N²)——实测 128KB 要 9.6 秒，
    // 而这段解析跑在事件循环上，会卡住整个进程。
    const named = /(?:调用工具|调用|工具|invoke|tool)[\s:：,，]*"?([A-Za-z_][\w-]*)"?/i.exec(text);
    if (named?.[1]) {
      const rest = text.slice(named.index + named[0].length);
      const args = jsonCall(rest);
      calls.push({ name: named[1], argsJson: args?.argsJson ?? JSON.stringify(looseArgs(rest)) });
    }
  }

  let cleaned = text.replace(CALLS_BLOCK, "").replace(INVOKE_BLOCK, "");
  cleaned = cleaned.replace(new RegExp(`${DSML}[a-zA-Z/]*>?`, "g"), "");
  cleaned = cleaned.replace(INTERNAL_MARKER, "");
  if (calls.length > 0) {
    // 散文形态：把「调用 xxx …」那一行也去掉，避免残留
    cleaned = cleaned.replace(/(?:调用工具|调用|工具|invoke|tool)[\s:：,，]*"?[A-Za-z_][\w-]*"?[^\n]*/i, "");
  }

  return { cleaned: cleaned.trim(), calls, unparsedMarkup: calls.length === 0 && DSML_MARK.test(text) };
}

/**
 * 把正文里的工具调用真的执行掉，并返回给用户看的正文。
 * 参考实现同样这么做，理由是不执行就等于「模型以为调用了、实际没调用」。
 */
export async function runTextToolCalls(
  text: string,
  execTool: (name: string, argsJson: string) => Promise<{ text: string; forwarded: boolean }>,
): Promise<{ text: string; calls: TextToolCall[]; forwarded: boolean; unparsedMarkup: boolean }> {
  const { cleaned, calls, unparsedMarkup } = extractTextToolCalls(text);
  let forwarded = false;
  for (const call of calls) {
    const result = await execTool(call.name, call.argsJson);
    if (result.forwarded) forwarded = true;
  }
  return { text: cleaned, calls, forwarded, unparsedMarkup };
}
