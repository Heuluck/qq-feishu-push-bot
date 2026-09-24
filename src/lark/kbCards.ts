/**
 * 飞书知识库管理卡片（卡片 JSON 2.0）。
 *
 * 全是纯函数（入参 → 卡片 JSON），可以在 `npm run smoke` 里离线检查结构，
 * 签名由调用方通过 `sign` 传进来，本模块不碰机密。
 *
 * 为什么统一用 2.0：表单容器、输入框多行、下拉选择这些都要 2.0；而且飞书明确
 * 「JSON 2.0 的卡片不能更新成 1.0」（错误码 200830），一张卡片从生到死必须同版本。
 * 转交提醒那套卡片在 `./cards.ts`，是 1.0，两套互不影响、也不互相更新。
 */
import { ROUTE_LABEL } from "../kb/kb.js";
import type { FeishuKbEntry } from "../kb/kb.js";

export type Card = Record<string, unknown>;
/** 把回传数据签好名再塞进按钮。 */
export type ActionSigner = (payload: Record<string, unknown>) => Record<string, unknown>;

/** 单个输入框的上限（飞书 input 的 max_length 硬上限就是 1000）。 */
export const MAX_ANSWER_CHARS = 1000;
export const MAX_FORWARD_HINT_CHARS = 500;
export const MAX_TITLE_CHARS = 60;
export const MAX_KEYWORDS_CHARS = 120;
export const MAX_ID_CHARS = 40;

/** 操作回传值的 op 取值。 */
export const OP = {
  add: "kb.add",
  list: "kb.list",
  toggle: "kb.toggle",
  submit: "kb.submit",
  del: "kb.del",
} as const;

export interface KbState {
  baseVersion: string;
  baseCount: number;
  feishuVersion: string;
  feishuEnabled: boolean;
  feishuCount: number;
  promptChars: number;
  /** 飞书层文件在不在（不在说明还没被写过）。 */
  feishuPresent: boolean;
}

function card(header: { title: string; template: string }, elements: unknown[]): Card {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { template: header.template, title: { tag: "plain_text", content: header.title } },
    body: { elements },
  };
}

function md(content: string): unknown {
  return { tag: "markdown", content };
}

/**
 * 分隔线。
 *
 * 故意用 markdown 的 thematic break 而不是 `{"tag": "hr"}` 组件：2.0 结构
 * 「传入不支持的属性将报错」（1.0 只是忽略），而 `hr` 组件在 2.0 的组件文档里没被明确列为可用，
 * 而 markdown 的 `---` 是标准语法、一定有。少一个需要赌的组件。
 */
function hr(): unknown {
  return { tag: "markdown", content: "---" };
}

function button(text: string, type: string, value: Record<string, unknown>): unknown {
  return {
    tag: "button",
    type,
    text: { tag: "plain_text", content: text },
    behaviors: [{ type: "callback", value }],
  };
}

/** 一组按钮按行流式排布（2.0 里没有 action 模块，按钮直接放在 column_set 里）。 */
function buttons(items: unknown[]): unknown {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: items.map((element) => ({
      tag: "column",
      width: "auto",
      vertical_align: "top",
      elements: [element],
    })),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/** 折叠面板：条目正文默认收起，避免一张卡片铺满整屏。 */
function panel(title: string, elements: unknown[], expanded = false): unknown {
  return {
    tag: "collapsible_panel",
    expanded,
    header: {
      title: { tag: "markdown", content: title },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    padding: "8px 8px 8px 8px",
    elements,
  };
}

function stateLines(state: KbState): string {
  const feishu = state.feishuPresent
    ? state.feishuEnabled
      ? `🟢 已启用，${state.feishuCount} 条（fs-${state.feishuVersion}）`
      : `⚪️ 已停用，${state.feishuCount} 条仍在文件里（fs-${state.feishuVersion}）`
    : "（还没有补充条目）";
  return [
    `**正式知识库**　kb-${state.baseVersion}，${state.baseCount} 条`,
    `**飞书补充**　${feishu}`,
    `**当前提示词**　${state.promptChars} 字符`,
  ].join("\n");
}

/** 主菜单。这个卡片留在群的主消息流里，别的卡片都收进它下面的话题。 */
export function buildMenuCard(state: KbState, sign: ActionSigner): Card {
  return card({ title: "🤖 知识库管理", template: "blue" }, [
    md(stateLines(state)),
    hr(),
    buttons([
      button("➕ 新增条目", "primary", sign({ op: OP.add })),
      button("📋 查看补充条目", "default", sign({ op: OP.list })),
      // 标签写成中性的「切换」而不是「启用/停用」：卡片一旦发出就改不了文字，
      // 而服务端是按当前状态取反，标签写成状态词迟早会和实际状态对不上。
      button("🔁 切换「飞书补充」注入", "default", sign({ op: OP.toggle })),
    ]),
    md(
      "点上面的按钮后，新的卡片会出现在**本条消息的话题**里，不会刷群。" +
        "飞书补充知识是临时的，想长期保留请把它搬进 `kb/kb.yaml` 转正。",
    ),
  ]);
}

/** 新增条目的表单卡片。字段名和 `kb.feishu.yaml` 的键一一对应，回传时不用翻译。 */
export function buildFormCard(sign: ActionSigner): Card {
  const input = (
    name: string,
    label: string,
    options: { required?: boolean; max?: number; multiline?: boolean; placeholder?: string } = {},
  ): unknown => ({
    tag: "input",
    name,
    label: { tag: "plain_text", content: label },
    placeholder: { tag: "plain_text", content: options.placeholder ?? "请输入" },
    required: options.required ?? false,
    width: "fill",
    max_length: options.max ?? MAX_ANSWER_CHARS,
    ...(options.multiline === true ? { input_type: "multiline_text", rows: 4, auto_resize: true } : {}),
  });

  return card({ title: "➕ 新增一条补充知识", template: "turquoise" }, [
    md("填完点「提交」即刻生效（可回滚）。字段名和正式知识库一致，方便日后转正。"),
    {
      tag: "form",
      name: "kb_form",
      elements: [
        input("id", "id（必填，全局唯一）", {
          required: true,
          max: MAX_ID_CHARS,
          placeholder: "如 feishu-jwpt-phone",
        }),
        input("title", "标题（必填）", { required: true, max: MAX_TITLE_CHARS, placeholder: "如 教务系统打不开" }),
        input("keywords", "关键词（必填，逗号分隔）", {
          required: true,
          max: MAX_KEYWORDS_CHARS,
          placeholder: "如 教务,打不开,登录不上",
        }),
        // select_static 没有 label 属性（只有 input 有），所以标签用一个 markdown 兄弟节点，
        // 这也是官方表单示例里的写法。
        md("**处理方式（必填）**"),
        {
          tag: "select_static",
          name: "route",
          placeholder: { tag: "plain_text", content: "请选择" },
          width: "fill",
          required: true,
          options: [
            { text: { tag: "plain_text", content: ROUTE_LABEL.answer }, value: "answer" },
            { text: { tag: "plain_text", content: ROUTE_LABEL.forward }, value: "forward" },
            { text: { tag: "plain_text", content: ROUTE_LABEL.answer_and_forward }, value: "answer_and_forward" },
          ],
        },
        input("answer", `答案（${ROUTE_LABEL.answer} / ${ROUTE_LABEL.answer_and_forward} 必填）`, {
          multiline: true,
          max: MAX_ANSWER_CHARS,
          placeholder: "给同学看的话，不要写内部信息",
        }),
        input("forward_hint", "转交说明（需转交人工时建议填）", {
          multiline: true,
          max: MAX_FORWARD_HINT_CHARS,
          placeholder: "处理人员需要同学提供什么材料",
        }),
        buttons([
          {
            tag: "button",
            type: "primary_filled",
            text: { tag: "plain_text", content: "提交" },
            form_action_type: "submit",
            name: "kb_submit",
            behaviors: [{ type: "callback", value: sign({ op: OP.submit }) }],
          },
          {
            tag: "button",
            type: "default",
            text: { tag: "plain_text", content: "重置" },
            form_action_type: "reset",
            name: "kb_reset",
          },
        ]),
      ],
    },
    md(
      `限制：标题 ≤ ${MAX_TITLE_CHARS} 字，答案 ≤ ${MAX_ANSWER_CHARS} 字，` +
        `转交说明 ≤ ${MAX_FORWARD_HINT_CHARS} 字；id 不能和正式知识库或已有补充条目重复。`,
    ),
  ]);
}

/** 表单提交成功后**原地**替换表单卡片：去掉输入框，防止重复提交。 */
export function buildSubmittedCard(entry: FeishuKbEntry): Card {
  return card({ title: "✅ 已提交", template: "green" }, [
    md(`**${entry.title}**（id \`${entry.id}\`）已经写入飞书补充知识库，下一次问答就会带上它。`),
    md("结果卡片在该消息的话题里，24 小时内可以点里面的「删除这一条」撤销。"),
  ]);
}

/** 新增成功后**新发**的结果卡片，删除按钮就挂在这张卡上。 */
export function buildAddedCard(entry: FeishuKbEntry, sign: ActionSigner): Card {
  const elements: unknown[] = [
    md(`**处理方式**　${ROUTE_LABEL[entry.route]}\n**关键词**　${entry.keywords.join("、")}`),
  ];
  if (entry.answer) elements.push(md(`**答案**\n${truncate(entry.answer, 600)}`));
  if (entry.forward_hint) elements.push(md(`**转交说明**\n${truncate(entry.forward_hint, 400)}`));
  elements.push(hr());
  elements.push(
    button("🗑 删除这一条", "danger", sign({ op: OP.del, id: entry.id, added_at: entry.added_at ?? "" })),
  );
  elements.push(md("删除按钮**只在 24 小时内有效**，且只会删掉 id 完全相同的这一条。"));
  return card({ title: `✅ 已新增：${entry.title}`, template: "green" }, elements);
}

/** 删除成功后**原地**替换那张「已新增」卡片：按钮消失，防止重复点。 */
export function buildDeletedCard(entry: FeishuKbEntry): Card {
  return card({ title: "🗑 已删除", template: "grey" }, [
    md(`**${entry.title}**（id \`${entry.id}\`）已从飞书补充知识库移除，不再注入提示词。`),
  ]);
}

/** 通用结果卡片（成功/失败都走它）。 */
export function buildResultCard(ok: boolean, title: string, lines: string[]): Card {
  return card(
    { title: `${ok ? "✅" : "⚠️"} ${title}`, template: ok ? "green" : "orange" },
    lines.length > 0 ? lines.map((line) => md(line)) : [md("（没有更多信息）")],
  );
}

/** 查看补充条目：一条一个折叠面板，正文默认收起。 */
export function buildEntryListCard(state: KbState, entries: FeishuKbEntry[]): Card {
  const elements: unknown[] = [md(stateLines(state)), hr()];
  if (entries.length === 0) {
    elements.push(md("飞书补充知识库现在是空的。"));
  } else {
    // 卡片消息有 30KB 上限，条目多时把答案截短，避免整张卡发不出去。
    const budget = entries.length > 20 ? 120 : 300;
    for (const entry of entries) {
      const lines = [`**处理方式**　${ROUTE_LABEL[entry.route]}\n**关键词**　${entry.keywords.join("、")}`];
      if (entry.answer) lines.push(`**答案**\n${truncate(entry.answer, budget)}`);
      if (entry.forward_hint) lines.push(`**转交说明**\n${truncate(entry.forward_hint, budget)}`);
      const added = entry.added_at ? `　·　${entry.added_at.slice(0, 16).replace("T", " ")}` : "";
      elements.push(panel(`\`${entry.id}\`　${entry.title}${added}`, lines.map((line) => md(line))));
    }
  }
  elements.push(md("要转正：把条目复制进 `kb/kb.yaml` 再从飞书层删掉（id 不能两处同时存在）。"));
  return card({ title: `📋 飞书补充条目（${entries.length} 条）`, template: "blue" }, elements);
}

/** 切换注入开关后的结果卡片，带一个「切回去」的按钮。 */
export function buildToggleResultCard(state: KbState, sign: ActionSigner): Card {
  const on = state.feishuEnabled;
  return card(
    { title: on ? "🟢 补充知识已启用" : "⚪️ 补充知识已停用", template: on ? "green" : "grey" },
    [
      md(stateLines(state)),
      md(
        on
          ? "飞书补充条目已经进入 system prompt，下一次问答就带上它们了。"
          : "飞书补充条目仍然留在文件里，只是不再注入提示词；正式知识库不受影响。",
      ),
      buttons([
        button("🔁 切换", "default", sign({ op: OP.toggle })),
        button("📋 查看补充条目", "default", sign({ op: OP.list })),
      ]),
    ],
  );
}
