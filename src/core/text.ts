/**
 * 文本截断：超长时保留前 max 个字符并标注，避免把巨大的粘贴内容原样喂给模型。
 */
export function truncateText(text: string, max: number, marker = "…（内容过长，已截断）"): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}${marker}`;
}

/**
 * 去掉 @ 提及标记。
 *
 * SDK 的 contentSanitizer 只处理纯数字形态（`<@!?123456>` / 匹配 appId），
 * 但平台还会下发十六进制 openid 形态（例如 `<@F458CD3416A39BD912686734260121E1>`），
 * 那种会漏过去。漏掉的后果不只是噪音：一条「只 @ 机器人、没有说话」的消息
 * 会被当成有内容的问题，从而匹配到错误的条目。
 */
export function stripMentions(text: string): string {
  return text.replace(/<@!?[0-9A-Za-z]+>/g, "").trim();
}
