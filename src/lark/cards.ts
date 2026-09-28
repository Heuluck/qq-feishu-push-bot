/**
 * 飞书提醒卡片的结构。
 *
 * 群里只该看到一行问题概要：详情与诊断信息全部收进折叠面板，避免刷屏、也避免把用户 openid
 * 直接铺在群里。这里只有纯函数（入参 → 卡片 JSON），便于离线单测（见 src/smoke.ts）。
 */
import type { ForwardRequest } from "./forwarder.js";

/**
 * 中和模型产出文本里的 markdown 结构，避免它在内部反馈群里渲染出可点击链接、@ 提及、
 * 代码块等——这些能让一条「转交卡片」看起来像官方公告，或把管理员引去钓鱼页。
 * 保留 `**加粗**` 与换行：提示词要求模型用 `**现象**` 这类小标题分段。
 */
export function sanitizeLarkMd(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [文字](链接) / ![图](链接) → 只留文字
    .replace(/<\/?at\b[^>]*>/gi, "") // @ 提及标签
    .replace(/^\s{0,3}(```|~~~).*$/gm, "") // 代码围栏行
    .replace(/`([^`]*)`/g, "$1"); // 行内代码 → 纯文字
}

/** 折叠面板：详情、诊断信息默认收起，群里只看到一行问题。 */
function collapsiblePanel(title: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "markdown", content: `**${title}**` },
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

function shortSender(senderId: string): string {
  return senderId.length > 10 ? `${senderId.slice(0, 10)}…` : senderId;
}

/** 详情 + 诊断信息合并成一个折叠面板，卡片外露的只有问题概要。 */
function detailPanel(req: ForwardRequest): Record<string, unknown> {
  const time = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return collapsiblePanel("详情", [
    { tag: "div", text: { tag: "lark_md", content: sanitizeLarkMd(req.details) } },
    { tag: "hr" },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**来自**　${shortSender(req.senderId)}　·　${time}\n**openid**　${req.senderId}\n**消息 id**　${req.msgId}`,
      },
    },
  ]);
}

export function buildRootCard(req: ForwardRequest): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "🔔 QQ 群问题转交" },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: sanitizeLarkMd(req.summary) } },
      detailPanel(req),
    ],
  };
}

export function buildFollowUpCard(req: ForwardRequest, count: number): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: `🔁 补充 #${count}` },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: sanitizeLarkMd(req.summary) } },
      detailPanel(req),
    ],
  };
}
