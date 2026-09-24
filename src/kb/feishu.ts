/**
 * 飞书补充知识库（`kb/kb.feishu.yaml`）的读写、快照、审计与卡片回传签名。
 *
 * 这一层是**唯一**由飞书卡片写入的知识库数据。基线的 `kb/kb.yaml` 永远只由人手工改、
 * 随镜像发布，所以卡片再怎么乱填也污染不到它。
 *
 * 写入策略：先留快照 → 临时文件 + rename 原子替换。任何一步失败都不会让磁盘上留下一份
 * 半截的 YAML（下次启动会直接拒绝加载）。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { log } from "../core/log.js";
import { monthKey, stampKey } from "../store/retention.js";
import { FeishuEntrySchema, FeishuFileSchema, versionOf } from "./kb.js";
import type { FeishuKbEntry } from "./kb.js";

/** 保留多少份历史快照（按文件名倒序保留最新的）。 */
const KEEP_SNAPSHOTS = 30;
/** 卡片回传签名的长度（base64url 前 N 个字符）。 */
const SIG_CHARS = 32;

/** 生成文件顶部的说明。每次写入都会重新生成，所以这段注释不会被人改坏后遗失。 */
const FILE_HEADER = `# 飞书补充知识库 —— 由飞书群里的管理菜单写入，请勿手工编辑（改错了菜单里也能一键回滚）。
#
# 想把某一条「转正」进正式知识库：把它的条目原样复制到 kb/kb.yaml 的 entries 下面，
# 再从这里删掉（id 必须全局唯一，两处不能同时存在，否则启动会直接报错拒绝加载）。
#
# enabled: false 表示整层暂不注入 system prompt（条目仍然保留，随时可以再打开）。
# added_by / added_at 是审计字段，不进提示词；added_at 还是「24 小时内才能删」的判据。`;

export interface FeishuLayerFile {
  enabled: boolean;
  /** 原样保留：卡片只增删 entries，不该顺手把人工写的变量表丢掉。 */
  variables: Record<string, unknown> | undefined;
  entries: FeishuKbEntry[];
}

/** 按 schema 解析飞书层原文。占位符**故意不展开**——写回时要原样保留 `{{jwpt}}` 这类引用。 */
export function parseFeishuFileText(raw: string, file: string): FeishuLayerFile {
  const doc = FeishuFileSchema.safeParse(parseYaml(raw));
  if (!doc.success) {
    const first = doc.error.issues[0];
    throw new Error(`${file}: ${first ? `${first.path.join(".") || "(根)"} ${first.message}` : "解析失败"}`);
  }
  const entries = z.array(FeishuEntrySchema).safeParse(doc.data.entries);
  if (!entries.success) {
    const first = entries.error.issues[0];
    throw new Error(`${file}: ${first ? `条目 ${first.path.join(".") || ""} ${first.message}` : "条目解析失败"}`);
  }
  return { enabled: doc.data.enabled, variables: doc.data.variables, entries: entries.data };
}

function entryToYaml(entry: FeishuKbEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    title: entry.title,
    keywords: entry.keywords,
    route: entry.route,
  };
  if (entry.answer !== undefined) out["answer"] = entry.answer;
  if (entry.forward_hint !== undefined) out["forward_hint"] = entry.forward_hint;
  if (entry.added_by !== undefined) out["added_by"] = entry.added_by;
  if (entry.added_at !== undefined) out["added_at"] = entry.added_at;
  return out;
}

/** 渲染成 YAML 文本（`|` 块标量由 yaml 库自己挑，长文本会保持多行可读）。 */
export function renderFeishuFileText(file: FeishuLayerFile): string {
  const doc: Record<string, unknown> = { enabled: file.enabled };
  if (file.variables !== undefined) doc["variables"] = file.variables;
  doc["entries"] = file.entries.map(entryToYaml);
  return `${FILE_HEADER}\n\n${stringifyYaml(doc, { lineWidth: 0 })}`;
}

/**
 * 规范化序列化：按键名排序后输出 `[[k,v],…]`。
 *
 * 不用 `JSON.stringify(obj, keys)` —— 那个 replay 过滤会作用到嵌套对象上，
 * 而现在扁平、将来一眼能看出它是扁平的，比埋一个「嵌套会静默丢字段」的坑好。
 */
function canonical(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return JSON.stringify(keys.map((key) => [key, payload[key]]));
}

function hmac(secret: string, payload: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(canonical(payload)).digest("base64url").slice(0, SIG_CHARS);
}

/**
 * 给卡片按钮的回传数据签名。
 *
 * 卡片里的 `value` 是发卡片时由服务端写死的，普通用户改不了；但签名让「伪造一张卡片
 * 或者把旧卡片的价值重放」也一并失效——验签不过就只弹 toast，什么都不做。
 * 密钥直接复用 `LARK_APP_SECRET`，省一个要轮换的机密；换 app secret 会让旧卡片失效，
 * 而旧卡片本来就只在 24 小时内可删，代价可以接受。
 */
export function signActionValue(secret: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, sig: hmac(secret, payload) };
}

export type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/** 校验卡片回传数据。失败原因直接可以给用户看（不含机密）。 */
export function verifyActionValue(secret: string, value: unknown): VerifyResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "回传数据不是对象" };
  }
  const record = value as Record<string, unknown>;
  const sig = record["sig"];
  if (typeof sig !== "string" || sig === "") return { ok: false, reason: "回传数据没有签名" };
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key !== "sig") payload[key] = item;
  }
  const expected = hmac(secret, payload);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "回传数据签名不匹配" };
  return { ok: true, payload };
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/**
 * 能不能从卡片上删掉这一条。抽成纯函数是因为这是整个功能里最要紧的一条规则，
 * 必须能在 `npm run smoke` 里离线把每个分支都走一遍。
 *
 * 四道闸，任何一道不过都拒绝：
 *   1. id 必须**严格相等**地命中一条（绝不按标题/关键词模糊匹配）；
 *   2. 那条必须带 `added_at`——手工塞进文件的条目不受卡片管辖；
 *   3. 卡片带回来的时间必须和文件里的完全一致（对不上说明条目已被改过）；
 *   4. 从添加到现在不能超过窗口期（默认 24 小时）。
 */
export function checkDeletable(
  entries: FeishuKbEntry[],
  id: string,
  cardAddedAt: string,
  now: number,
  windowMs: number,
): { ok: true; entry: FeishuKbEntry } | { ok: false; reason: string } {
  if (id === "") return { ok: false, reason: "回传数据里没有条目 id" };
  const entry = entries.find((item) => item.id === id);
  if (entry === undefined) return { ok: false, reason: `id「${id}」已经不在飞书补充层里了` };
  if (entry.added_at === undefined || entry.added_at === "") {
    return { ok: false, reason: "这条不是通过卡片添加的，请直接编辑 kb/kb.feishu.yaml" };
  }
  if (cardAddedAt !== entry.added_at) {
    return { ok: false, reason: "卡片里的时间和当前条目对不上，可能已经被改过，请重新打开菜单" };
  }
  const age = now - Date.parse(entry.added_at);
  if (!Number.isFinite(age) || age < 0 || age > windowMs) {
    return {
      ok: false,
      reason: `已经超过 ${Math.round(windowMs / 3_600_000)} 小时，不能再从卡片删除；请手工编辑 kb/kb.feishu.yaml`,
    };
  }
  return { ok: true, entry };
}

/**
 * 飞书层的磁盘门面：读、写（含快照）、审计。
 *
 * 不做校验——「这份内容能不能用」是 `compileKnowledgeBase` 的事，
 * 调用方必须先试编译通过再调 `save`，这样坏内容永远不会落到磁盘上。
 */
export class FeishuKbStore {
  constructor(
    private readonly path: string,
    private readonly dataDir: string,
  ) {}

  get filePath(): string {
    return this.path;
  }

  private get snapshotDir(): string {
    return join(this.dataDir, "kb-feishu-snapshots");
  }

  /** 读当前内容；文件不存在时返回一个空的启用态（首次运行的正常情况）。 */
  async load(): Promise<{ present: boolean; file: FeishuLayerFile }> {
    try {
      const raw = await readFile(this.path, "utf8");
      return { present: true, file: parseFeishuFileText(raw, this.path) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { present: false, file: { enabled: true, variables: undefined, entries: [] } };
      throw err;
    }
  }

  /** 落盘：先快照，再原子替换，最后按份数裁剪快照。 */
  async save(file: FeishuLayerFile): Promise<void> {
    await this.snapshot();
    await atomicWrite(this.path, renderFeishuFileText(file));
    await this.pruneSnapshots();
  }

  /** 把当前文件复制进快照目录。文件不存在（第一次写入）时什么都不做。 */
  async snapshot(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    try {
      await mkdir(this.snapshotDir, { recursive: true });
      const name = `${stampKey()}-${versionOf(raw)}.yaml`;
      await writeFile(join(this.snapshotDir, name), raw, "utf8");
      log.info("kb-admin", `已留存快照 ${name}`);
    } catch (err) {
      // 快照失败不该拦住主流程（内容本身还是要写进去的），但必须留痕。
      log.warn("kb-admin", `快照失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 只保留最新的 N 份快照，其余删除。文件名前缀是东八区时间戳，按名字倒序即按时间倒序。 */
  async pruneSnapshots(): Promise<void> {
    try {
      const names = (await readdir(this.snapshotDir)).filter((name) => name.endsWith(".yaml")).sort();
      for (const name of names.slice(0, Math.max(0, names.length - KEEP_SNAPSHOTS))) {
        await unlink(join(this.snapshotDir, name));
      }
    } catch {
      // 目录还不存在，忽略。
    }
  }

  /** 最近 N 份快照的文件名（新的在前），供将来做「回滚」入口。 */
  async listSnapshots(limit = 10): Promise<string[]> {
    try {
      const names = (await readdir(this.snapshotDir)).filter((name) => name.endsWith(".yaml")).sort().reverse();
      return names.slice(0, limit);
    } catch {
      return [];
    }
  }

  /** 按 id 精确删除一条；返回被删掉的那条（不存在则返回 undefined）。 */
  async removeEntry(id: string): Promise<FeishuKbEntry | undefined> {
    const { file } = await this.load();
    const hit = file.entries.find((entry) => entry.id === id);
    if (!hit) return undefined;
    const rest = file.entries.filter((entry) => entry.id !== id);
    await this.save({ ...file, entries: rest });
    return hit;
  }

  /** 审计留档：一条 JSON，一行。按月切分，保留期由 store/retention.ts 统一清理。 */
  async audit(record: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const file = join(this.dataDir, `kb-feishu-audit-${monthKey()}.jsonl`);
      await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
    } catch (err) {
      log.warn("kb-admin", `审计日志写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 快照目录的字节数（给状态卡片用，顺手看看它有没有失控）。 */
  async snapshotBytes(): Promise<number> {
    try {
      const names = await readdir(this.snapshotDir);
      let total = 0;
      for (const name of names) {
        try {
          total += (await stat(join(this.snapshotDir, name))).size;
        } catch {
          // 单个文件读不到就跳过
        }
      }
      return total;
    } catch {
      return 0;
    }
  }
}
