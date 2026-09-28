/**
 * 飞书知识库管理卡片（卡片 JSON 2.0）。
 *
 * 全是纯函数（入参 → 卡片 JSON），可以在 `npm run smoke` 里离线检查结构；
 * 签名由调用方通过 `sign` 传进来，本模块不碰机密。
 *
 * ## 两步向导：值是怎么过河的
 *
 * 飞书卡片是**静态一次渲染**的，没有条件显隐，也没法让客户端自己在两步之间留着输入。
 * 所以「上一步填的东西还在」是这么做到的：
 *   1. 每一步的「下一步 / 提交 / 上一步」都是**表单容器里的提交按钮**
 *      （`form_action_type: "submit"`）。只有提交按钮的回调才带 `action.form_value`，
 *      放在表单外面的按钮只会回传发卡时写死的 `value`，拿不到用户敲进去的字。
 *   2. 服务端拿到 `form_value` 后，把整份草稿重新写进下一张卡片：能填的字段用
 *      `input.default_value` 回填，下拉用 `select_static.initial_option` 回填。
 *   3. 当前这一步表单里**没有**的字段（例如第二步不显示 id/标题），由按钮的签名 `value`
 *      带着走 —— 全程无服务端状态，来回切多少次都不会错。
 *
 * 注意：因此第二步的输入框**故意不设 `required`**。`required` 是前端拦截，一旦设上，
 * 用户点「上一步」会先被「有必填项未填写」挡住、带不走已经写好的内容。
 * 第二步的校验改在服务端做（错了只弹 toast、**不更新卡片**，用户填的字原地保留）。
 *
 * 为什么统一用 2.0：表单容器、输入框多行、下拉选择这些都要 2.0；而且飞书明确
 * 「JSON 2.0 的卡片不能更新成 1.0」（错误码 200830），一张卡片从生到死必须同版本。
 * 转交提醒那套卡片在 `./cards.ts`，是 1.0，两套互不影响、也不互相更新。
 */
import { ROUTE_LABEL } from "../kb/kb.js";
import type { FeishuKbEntry, KbEntry } from "../kb/kb.js";

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
  remove: "kb.remove",
  wizardNext: "kb.wizard.next",
  wizardBack: "kb.wizard.back",
  /** 主菜单上的红色入口 → 正式知识库（kb.yaml）菜单。 */
  baseMenu: "kb.base.menu",
  baseList: "kb.base.list",
  baseAdd: "kb.base.add",
  baseBack: "kb.base.back",
  baseConfirm: "kb.base.confirm",
  baseRemove: "kb.base.remove",
  baseRemoveConfirm: "kb.base.remove.confirm",
} as const;

/**
 * 向导与卡片针对的知识库层。
 *   - feishu：kb.feishu.yaml（原有的补充层）
 *   - base  ：kb.yaml（正式库，改动要二次确认 + git 提交）
 */
export type Layer = "feishu" | "base";

export function layerFromValue(payload: Record<string, unknown>): Layer {
  return payload["layer"] === "base" ? "base" : "feishu";
}

/** 正式知识库的提交说明上限（会拼在 `chore(kb): ` 后面）。 */
export const MAX_COMMIT_MSG_CHARS = 80;
/** 自动生成的 commit 前缀。 */
export const COMMIT_PREFIX = "chore(kb): ";

export const ROUTES = ["answer", "forward", "answer_and_forward"] as const;
export type Route = (typeof ROUTES)[number];

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

function routeLabel(route: string): string {
  return isRoute(route) ? ROUTE_LABEL[route] : "（未选择）";
}

// ── 向导草稿：在几张卡片之间传递的那份「填了一半的条目」 ──────────────────────

/**
 * 全部字段都是**用户敲进去的原文**，空串表示还没填。
 * 不做 trim、不做拆分——原样来回搬，用户看到的就是自己写的。
 */
export interface WizardDraft {
  id: string;
  title: string;
  keywords: string;
  route: string;
  answer: string;
  forward_hint: string;
}

export const EMPTY_DRAFT: WizardDraft = {
  id: "",
  title: "",
  keywords: "",
  route: "",
  answer: "",
  forward_hint: "",
};

const DRAFT_KEYS: (keyof WizardDraft)[] = ["id", "title", "keywords", "route", "answer", "forward_hint"];

/**
 * 把草稿塞进按钮的回传值，并签名。
 *
 * **展平成顶层键**而不是塞成一个嵌套对象：`signActionValue` 只对顶层键排序做规范化，
 * 嵌套对象内部的键序依赖 JSON 往返是否原样保留——展平以后顺序完全确定，验签不会漂。
 */
export function draftValue(
  sign: ActionSigner,
  op: string,
  draft: WizardDraft,
  layer: Layer = "feishu",
): Record<string, unknown> {
  const payload: Record<string, unknown> = { op, layer };
  for (const key of DRAFT_KEYS) payload[key] = draft[key];
  return sign(payload);
}

/** 从按钮回传值里还原草稿（内部用；调用方拿到的是签名校验后的 payload）。 */
export function draftFromValue(payload: Record<string, unknown>): WizardDraft {
  const draft: WizardDraft = { ...EMPTY_DRAFT };
  for (const key of DRAFT_KEYS) {
    const value = payload[key];
    if (typeof value === "string") draft[key] = value;
  }
  return draft;
}

/**
 * 把刚提交上来的表单值合并进草稿。
 *
 * 只有**表单里真实存在的字段**才覆盖：第一步的表单没有 answer/forward_hint，所以从第二步
 * 退回第一步时，用户刚敲的那段答案会跟在按钮的签名值里活下来，再点「下一步」又回到眼前。
 */
export function mergeDraft(draft: WizardDraft, form: Record<string, unknown>): WizardDraft {
  const next: WizardDraft = { ...draft };
  for (const key of DRAFT_KEYS) {
    const value = form[key];
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

// ── 卡片零件 ────────────────────────────────────────────────────────────────

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
 * 「传入不支持的属性将报错」（1.0 只是忽略），`hr` 虽然确实在 2.0 组件表里，但 markdown
 * 的 `---` 是标准语法、一定有，少一个需要赌的组件。
 */
function hr(): unknown {
  return { tag: "markdown", content: "---" };
}

/**
 * `confirm` 是飞书客户端自带的二次确认弹窗：确认之前**不会**发起回调，省一次往返，
 * 也省得服务端自己维护"待确认"状态。注意 `title` 必填，缺了在老客户端上会点了没反应。
 */
function button(text: string, type: string, value: Record<string, unknown>, confirmText?: string): unknown {
  return {
    tag: "button",
    type,
    text: { tag: "plain_text", content: text },
    behaviors: [{ type: "callback", value }],
    ...(confirmText !== undefined
      ? {
          confirm: {
            title: { tag: "plain_text", content: text },
            text: { tag: "plain_text", content: confirmText },
          },
        }
      : {}),
  };
}

/** 表单容器里的提交按钮。必须有 `name`，否则飞书报 200530（表单项标识为空）。 */
function submitButton(text: string, type: string, name: string, value: Record<string, unknown>): unknown {
  return {
    tag: "button",
    type,
    text: { tag: "plain_text", content: text },
    form_action_type: "submit",
    name,
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

function inputField(
  name: string,
  label: string,
  options: { required?: boolean; max?: number; multiline?: boolean; placeholder?: string; value?: string } = {},
): unknown {
  return {
    tag: "input",
    name,
    label: { tag: "plain_text", content: label },
    placeholder: { tag: "plain_text", content: options.placeholder ?? "请输入" },
    required: options.required ?? false,
    width: "fill",
    max_length: options.max ?? MAX_ANSWER_CHARS,
    ...(options.value !== undefined && options.value !== "" ? { default_value: options.value } : {}),
    ...(options.multiline === true ? { input_type: "multiline_text", rows: 4, auto_resize: true } : {}),
  };
}

function routeSelect(draft: WizardDraft): unknown {
  return {
    tag: "select_static",
    name: "route",
    placeholder: { tag: "plain_text", content: "请选择" },
    width: "fill",
    required: true,
    // initial_option 取的是**选项文本**（不是 value），所以这里用中文标签回填；回传的仍是 value。
    ...(isRoute(draft.route) ? { initial_option: ROUTE_LABEL[draft.route] } : {}),
    options: ROUTES.map((route) => ({
      text: { tag: "plain_text", content: ROUTE_LABEL[route] },
      value: route,
    })),
  };
}

/** 关键词在卡片上一律用顿号分隔——用户填的时候可能用半角逗号、全角逗号或混着来。 */
function formatKeywords(raw: string): string {
  return raw
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .join("、");
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
      ? `已启用，${state.feishuCount} 条（fs-${state.feishuVersion}）`
      : `已停用，${state.feishuCount} 条（fs-${state.feishuVersion}）`
    : "无";
  return [
    `**正式知识库**　kb-${state.baseVersion}，${state.baseCount} 条`,
    `**飞书补充知识**　${feishu}`,
    `**当前提示词**　${state.promptChars} 字`,
  ].join("\n");
}

// ── 卡片 ────────────────────────────────────────────────────────────────────

/** 主菜单。这个卡片留在群的主消息流里，别的卡片都收进它下面的话题。 */
export function buildMenuCard(state: KbState, sign: ActionSigner): Card {
  return card({ title: "知识库管理", template: "blue" }, [
    md(stateLines(state)),
    hr(),
    buttons([
      button("新增条目", "primary", sign({ op: OP.add })),
      button("查看飞书补充知识", "default", sign({ op: OP.list })),
      // 标签用「开关」这个名词，不用「启用/停用」那种状态词：卡片一旦发出就改不了文字，
      // 而服务端是按当前状态取反，写成状态词迟早会和实际状态对不上；「切换」又太容易被读成别的意思。
      button("飞书补充知识开关", "default", sign({ op: OP.toggle })),
    ]),
    // 红色 = 直接改正式知识库（kb.yaml）。危险配色 + 进去后每步二次确认 + 回收站 + git 兜底。
    buttons([button("正式知识库（kb.yaml）", "danger", sign({ op: OP.baseMenu }))]),
  ]);
}

// ── 正式知识库（kb.yaml）────────────────────────────────────────────────────

/** 正式知识库的入口卡片。红色标题提醒这是直接改主文件、不是补充层。 */
export function buildBaseMenuCard(state: KbState, sign: ActionSigner): Card {
  return card({ title: "正式知识库（kb.yaml）", template: "red" }, [
    md(stateLines(state)),
    md("这里的增删都会**二次确认**、删除进回收站，并自动 git 提交（`chore(kb): <你填的说明>`）"),
    hr(),
    buttons([
      button("新增条目", "primary", sign({ op: OP.baseAdd })),
      button("查看条目（可删）", "danger", sign({ op: OP.baseList })),
    ]),
  ]);
}

/** 正式条目的列表：一条一个折叠面板，面板里带删除入口。 */
export function buildBaseListCard(state: KbState, entries: KbEntry[], sign: ActionSigner): Card {
  const elements: unknown[] = [md(stateLines(state)), hr()];
  if (entries.length === 0) {
    elements.push(md("正式知识库为空"));
  } else {
    const budget = entries.length > 20 ? 120 : 300;
    for (const entry of entries) {
      const lines = [`**处理方式**　${ROUTE_LABEL[entry.route]}\n**关键词**　${entry.keywords.join("、")}`];
      if (entry.answer) lines.push(`**答案**\n${truncate(entry.answer, budget)}`);
      if (entry.forward_hint) lines.push(`**转交说明**\n${truncate(entry.forward_hint, budget)}`);
      elements.push(
        panel(`\`${entry.id}\`　${entry.title}`, [
          ...lines.map((line) => md(line)),
          // 这里不用客户端原生 confirm：下一步要收「提交说明」，必须自己出一张卡。
          button("删除", "danger", sign({ op: OP.baseRemove, id: entry.id })),
        ]),
      );
    }
  }
  elements.push(md("删除前会再确认一次并要求填写提交说明；删掉的条目进回收站（`kb/kb.trash.yaml`），并由 git 留痕"));
  return card({ title: `正式知识库（${entries.length} 条）`, template: "red" }, elements);
}

/** 正式条目向导的第二步（确认页）：展示草稿 + 要求填写提交说明。 */
export function buildBaseAddConfirmCard(draft: WizardDraft, sign: ActionSigner): Card {
  const askAnswer = draft.route === "answer" || draft.route === "answer_and_forward";
  const askForward = draft.route === "forward" || draft.route === "answer_and_forward";
  const lines = [
    `**id**　\`${draft.id.trim()}\``,
    `**标题**　${draft.title.trim()}`,
    `**关键词**　${formatKeywords(draft.keywords)}`,
    `**处理方式**　${routeLabel(draft.route)}`,
  ];
  if (askAnswer && draft.answer.trim() !== "") lines.push(`**答案**\n${truncate(draft.answer.trim(), 600)}`);
  if (askForward && draft.forward_hint.trim() !== "") {
    lines.push(`**转交说明**\n${truncate(draft.forward_hint.trim(), 400)}`);
  }
  return card({ title: "新增正式条目 · 确认", template: "red" }, [
    md(lines.join("\n")),
    hr(),
    md(`确认后写入 \`kb/kb.yaml\`、热重载并提交：\n\`${COMMIT_PREFIX}<提交说明>\``),
    {
      tag: "form",
      name: "kb_base_add_confirm",
      elements: [
        // 故意不设 required：这张表单里还有「上一步」这个提交按钮，设了必填用户就退不回去
        // （会先被「有必填项未填写」拦住）。空说明由服务端拦截，只弹 toast、不更新卡片。
        inputField("commit_msg", "提交说明", {
          max: MAX_COMMIT_MSG_CHARS,
          placeholder: "如：新增 XX 条目",
        }),
        buttons([
          submitButton("确认写入", "danger", "kb_base_confirm", draftValue(sign, OP.baseConfirm, draft, "base")),
          submitButton("上一步", "default", "kb_base_back", draftValue(sign, OP.baseBack, draft, "base")),
        ]),
      ],
    },
  ]);
}

/** 删除正式条目的确认页：展示该条 + 要求填写提交说明。 */
export function buildBaseDeleteConfirmCard(entry: KbEntry, sign: ActionSigner): Card {
  const lines = [
    `**id**　\`${entry.id}\``,
    `**标题**　${entry.title}`,
    `**处理方式**　${ROUTE_LABEL[entry.route]}\n**关键词**　${entry.keywords.join("、")}`,
  ];
  if (entry.answer) lines.push(`**答案**\n${truncate(entry.answer, 400)}`);
  if (entry.forward_hint) lines.push(`**转交说明**\n${truncate(entry.forward_hint, 300)}`);
  return card({ title: "删除正式条目 · 确认", template: "red" }, [
    md(lines.join("\n")),
    hr(),
    md(`确认后从 \`kb/kb.yaml\` 删除、归档进 \`kb/kb.trash.yaml\` 并提交：\n\`${COMMIT_PREFIX}<提交说明>\``),
    {
      tag: "form",
      name: "kb_base_delete_confirm",
      elements: [
        inputField("commit_msg", "提交说明", {
          required: true,
          max: MAX_COMMIT_MSG_CHARS,
          placeholder: "如：删除过期的 XX 条目",
        }),
        buttons([submitButton("确认删除", "danger", "kb_base_delete", sign({ op: OP.baseRemoveConfirm, id: entry.id }))]),
      ],
    },
  ]);
}

/** 正式条目新增成功后的结果卡片，带一个能直接去看列表的按钮。 */
export function buildBaseAddedCard(entry: KbEntry, sign: ActionSigner): Card {
  return card({ title: `已写入正式知识库：${entry.title}`, template: "green" }, [
    md(`id \`${entry.id}\` 已写入 \`kb/kb.yaml\`，下一次提问即生效`),
    buttons([button("查看条目", "default", sign({ op: OP.baseList }))]),
  ]);
}

/**
 * 把确认页表单里的提交说明拼成完整 commit message。
 * 空说明直接拒绝——提交信息是这一整套「改动可追溯」的核心，不能留默认值。
 */
export function commitMessageFrom(form: Record<string, unknown>): { ok: true; message: string } | { ok: false; reason: string } {
  const raw = typeof form["commit_msg"] === "string" ? form["commit_msg"].trim() : "";
  if (raw === "") return { ok: false, reason: "请填写提交说明" };
  if (raw.length > MAX_COMMIT_MSG_CHARS) {
    return { ok: false, reason: `提交说明不能超过 ${MAX_COMMIT_MSG_CHARS} 字` };
  }
  return { ok: true, message: `${COMMIT_PREFIX}${raw}` };
}

/** 第一步：基本信息 + 处理方式。点「下一步」时才决定第二步要填哪个框。 */
export function buildStep1Card(sign: ActionSigner, draft: WizardDraft, layer: Layer = "feishu"): Card {
  const title = layer === "base" ? "新增正式条目 1/2" : "新增飞书补充知识 1/2";
  const footer =
    layer === "base"
      ? `写进 \`kb/kb.yaml\`，最后还要确认一次并填写提交说明；已存在的 id 不能重复`
      : `id 全局唯一，只能用字母、数字、下划线、短横线（≤ ${MAX_ID_CHARS} 字）`;
  return card({ title, template: layer === "base" ? "red" : "turquoise" }, [
    {
      tag: "form",
      name: "kb_step1",
      elements: [
        inputField("id", "id", {
          required: true,
          max: MAX_ID_CHARS,
          placeholder: layer === "base" ? "如 app-download-tip" : "如 feishu-jwpt-phone",
          value: draft.id,
        }),
        inputField("title", "标题", {
          required: true,
          max: MAX_TITLE_CHARS,
          placeholder: "如 教务系统打不开",
          value: draft.title,
        }),
        inputField("keywords", "关键词", {
          required: true,
          max: MAX_KEYWORDS_CHARS,
          placeholder: "如 教务,打不开,登录不上",
          value: draft.keywords,
        }),
        // select_static 没有 label 属性（只有 input 有），所以标签用一个 markdown 兄弟节点，
        // 这也是官方表单示例里的写法。
        md("**处理方式**"),
        routeSelect(draft),
        buttons([submitButton("下一步", "primary_filled", "kb_next", draftValue(sign, OP.wizardNext, draft, layer))]),
      ],
    },
    md(`${footer}；标题 ≤ ${MAX_TITLE_CHARS} 字；关键词用逗号分隔、合计 ≤ ${MAX_KEYWORDS_CHARS} 字`),
  ]);
}

/**
 * 第二步：只显示这次要填的那个输入框。第一步的内容用**纯字符串**展示在上面
 * （不做成 disabled 输入框：那需要客户端 V7.4+，而且「disabled 的输入框会不会随
 * form_value 一起提交」文档没写清楚——权威值本来就在按钮的签名值里，展示用文本最省事）。
 */
export function buildStep2Card(draft: WizardDraft, sign: ActionSigner, layer: Layer = "feishu"): Card {
  const askAnswer = draft.route === "answer" || draft.route === "answer_and_forward";
  const askForward = draft.route === "forward" || draft.route === "answer_and_forward";
  const fields: unknown[] = [];
  if (askAnswer) {
    fields.push(
      inputField("answer", "答案", {
        multiline: true,
        max: MAX_ANSWER_CHARS,
        placeholder: "如：先连校园网再试一次",
        value: draft.answer,
      }),
    );
  }
  if (askForward) {
    fields.push(
      inputField("forward_hint", "转交说明", {
        multiline: true,
        max: MAX_FORWARD_HINT_CHARS,
        placeholder: "如：学号、报错截图",
        value: draft.forward_hint,
      }),
    );
  }

  return card({ title: layer === "base" ? "新增正式条目 2/2" : "新增飞书补充知识 2/2", template: layer === "base" ? "red" : "turquoise" }, [
    md(
      [
        `**id**　\`${draft.id}\``,
        `**标题**　${draft.title}`,
        `**关键词**　${formatKeywords(draft.keywords)}`,
        `**处理方式**　${routeLabel(draft.route)}`,
      ].join("\n"),
    ),
    // 提示只讲这次真的出现的字段，别在「只填答案」时还念一遍转交说明。
    md(
      [...(askAnswer ? ["答案会回复给同学"] : []), ...(askForward ? ["转交说明只给处理人员看"] : [])].join("；"),
    ),
    {
      tag: "form",
      name: "kb_step2",
      elements: [
        ...fields,
        buttons([
          submitButton("提交", "primary_filled", "kb_submit", draftValue(sign, OP.submit, draft, layer)),
          submitButton("上一步", "default", "kb_back", draftValue(sign, OP.wizardBack, draft, layer)),
        ]),
      ],
    },
  ]);
}

/** 表单提交成功后**原地**替换掉那张向导卡片：去掉输入框，防止重复提交。 */
export function buildSubmittedCard(entry: FeishuKbEntry): Card {
  return card({ title: "已提交", template: "green" }, [
    md(`**${entry.title}**（id \`${entry.id}\`）已写入飞书补充知识，下一次提问即生效`),
  ]);
}

/** 新增成功后**新发**的结果卡片，删除按钮就挂在这张卡上。 */
export function buildAddedCard(entry: FeishuKbEntry, sign: ActionSigner): Card {
  const elements: unknown[] = [
    md(`**处理方式**　${routeLabel(entry.route)}\n**关键词**　${entry.keywords.join("、")}`),
  ];
  if (entry.answer) elements.push(md(`**答案**\n${truncate(entry.answer, 600)}`));
  if (entry.forward_hint) elements.push(md(`**转交说明**\n${truncate(entry.forward_hint, 400)}`));
  elements.push(hr());
  elements.push(
    button("删除这一条", "danger", sign({ op: OP.del, id: entry.id, added_at: entry.added_at ?? "" })),
  );
  elements.push(md("24 小时内可删除（只删这一条）"));
  return card({ title: `已新增：${entry.title}`, template: "green" }, elements);
}

/** 删除成功后**原地**替换那张「已新增」卡片：按钮消失，防止重复点。 */
export function buildDeletedCard(entry: FeishuKbEntry): Card {
  return card({ title: "已删除", template: "grey" }, [
    md(`**${entry.title}**（id \`${entry.id}\`）已从飞书补充知识移除`),
  ]);
}

/** 通用结果卡片（成功/失败都走它）。 */
export function buildResultCard(ok: boolean, title: string, lines: string[]): Card {
  return card(
    { title, template: ok ? "green" : "orange" },
    lines.length > 0 ? lines.map((line) => md(line)) : [md("没有更多信息")],
  );
}

/** 查看补充条目：一条一个折叠面板，正文默认收起。 */
export function buildEntryListCard(state: KbState, entries: FeishuKbEntry[], sign: ActionSigner): Card {
  const elements: unknown[] = [md(stateLines(state)), hr()];
  if (entries.length === 0) {
    elements.push(md("飞书补充知识为空"));
  } else {
    // 卡片消息有 30KB 上限，条目多时把答案截短，避免整张卡发不出去。
    const budget = entries.length > 20 ? 120 : 300;
    for (const entry of entries) {
      const lines = [`**处理方式**　${ROUTE_LABEL[entry.route]}\n**关键词**　${entry.keywords.join("、")}`];
      if (entry.answer) lines.push(`**答案**\n${truncate(entry.answer, budget)}`);
      if (entry.forward_hint) lines.push(`**转交说明**\n${truncate(entry.forward_hint, budget)}`);
      const added = entry.added_at ? `　·　${entry.added_at.slice(0, 16).replace("T", " ")}` : "";
      elements.push(
        panel(`\`${entry.id}\`　${entry.title}${added}`, [
          ...lines.map((line) => md(line)),
          // 每条自带删除按钮：查看和删除在同一张卡上，不用记 id 再去找入口。
          button("删除", "danger", sign({ op: OP.remove, id: entry.id }), "会移入回收站，且不会自动恢复"),
        ]),
      );
    }
  }
  elements.push(md("删除会移入回收站（`kb/kb.feishu.trash.yaml`），程序不会自动恢复"));
  elements.push(md("转正：复制进 `kb/kb.yaml`，再从飞书补充知识删掉（id 不能两处同时存在）"));
  return card({ title: `飞书补充知识（${entries.length} 条）`, template: "blue" }, elements);
}

/** 开关操作的结果卡片，带一个能再按一次的按钮。 */
export function buildToggleResultCard(state: KbState, sign: ActionSigner): Card {
  const on = state.feishuEnabled;
  return card(
    { title: on ? "飞书补充知识已启用" : "飞书补充知识已停用", template: on ? "green" : "grey" },
    [
      md(stateLines(state)),
      buttons([
        button("开关", "default", sign({ op: OP.toggle })),
        button("查看飞书补充知识", "default", sign({ op: OP.list })),
      ]),
    ],
  );
}
