/**
 * 正式知识库（`kb/kb.yaml`）的读写、回收站、快照与审计。
 *
 * 与飞书补充层（`kb/feishu.ts`）最大的差别是**改法不同**：kb.yaml 是人工维护、随仓库走
 * 的主文件，里面写满了说明注释和变量表。所以这里用 `yaml` 的 `parseDocument` 直接改文档节点、
 * 再 `toString()` 写回——注释、缩进、`variables` 全部原样保留，而不是把整份 YAML 重新渲染。
 *
 * 写入策略和飞书层一致：先留快照 → 临时文件 + rename 原子替换。卡片改动还会额外走
 * `kb/git.ts` 提交一次（由调用方编排，见 `lark/admin.ts`）。
 */
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, stringify as stringifyYaml } from "yaml";
import { log } from "../core/log.js";
import { monthKey, stampKey } from "../store/retention.js";
import { atomicWrite, parseTrashFileText, renderTrashFileText, trashIdOf } from "./feishu.js";
import { versionOf } from "./kb.js";
import type { KbEntry } from "./kb.js";

/** 保留多少份历史快照（按文件名倒序保留最新的）。 */
const KEEP_SNAPSHOTS = 30;

/** 回收站文件头。 */
const TRASH_HEADER = `# 正式知识库回收站 —— 卡片上删掉的条目落在这里，只增不改，程序不会自动恢复。
#
# 要恢复某一条：把它的内容原样搬回 kb/kb.yaml 的 entries 下面，并把 id 末尾的 _<uuid> 去掉。
# 这一层还有 git 留痕（每次卡片增删都会提交），回收站只是给不熟 git 的人一个直观入口。
#
# 这个文件不参与自动清理，攒多了自己删。`;

/** 把一条 KbEntry 转成写进 YAML 的普通对象（键序固定，和 kb.yaml 里人写的顺序一致）。 */
function entryToPlain(entry: KbEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    title: entry.title,
    keywords: entry.keywords,
    route: entry.route,
  };
  if (entry.answer !== undefined) out["answer"] = entry.answer;
  if (entry.forward_hint !== undefined) out["forward_hint"] = entry.forward_hint;
  return out;
}

/** 解析成文档并检查语法；坏掉的 YAML 直接抛错，不去猜它想表达什么。 */
function parseDocumentOrThrow(raw: string, file: string) {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`${file}: ${doc.errors[0]!.message}`);
  }
  return doc;
}

function entriesSeq(doc: ReturnType<typeof parseDocument>, file: string) {
  const seq = doc.get("entries");
  if (!isSeq(seq)) throw new Error(`${file}: entries 不是数组，无法编辑`);
  return seq;
}

export interface BaseKbStorePaths {
  /** 可编辑的正式知识库。 */
  layer: string;
  /** 删除后归档到的回收站。 */
  trash: string;
  /** data/ 目录：快照与审计落在这里。 */
  dataDir: string;
}

export class BaseKbStore {
  constructor(private readonly paths: BaseKbStorePaths) {}

  private get snapshotDir(): string {
    return join(this.paths.dataDir, "kb-snapshots");
  }

  /** 读当前原文（文件必然存在——它是启动的硬依赖）。 */
  async readRaw(): Promise<string> {
    return readFile(this.paths.layer, "utf8");
  }

  /** 追加一条，返回新的文件文本。不落盘、不校验——校验由调用方试编译负责。 */
  addEntry(raw: string, entry: KbEntry): string {
    const doc = parseDocumentOrThrow(raw, this.paths.layer);
    entriesSeq(doc, this.paths.layer).add(entryToPlain(entry));
    return doc.toString({ lineWidth: 0 });
  }

  /**
   * 按 id **严格相等**删除一条，返回新文本与被删的那条；找不到返回 undefined。
   * 只删这一个节点，文档里其它内容（注释、变量表）逐字节不动。
   */
  removeEntry(raw: string, id: string): { text: string; entry: KbEntry } | undefined {
    const doc = parseDocumentOrThrow(raw, this.paths.layer);
    const seq = entriesSeq(doc, this.paths.layer);
    const index = seq.items.findIndex((item) => isMap(item) && item.get("id") === id);
    if (index === -1) return undefined;
    const node = seq.items[index] as unknown as { toJSON(): unknown };
    const entry = node.toJSON() as KbEntry;
    seq.delete(index);
    return { text: doc.toString({ lineWidth: 0 }), entry };
  }

  /** 落盘：先快照，再原子替换。 */
  async saveRaw(text: string): Promise<void> {
    await this.snapshot();
    await atomicWrite(this.paths.layer, text);
    await this.pruneSnapshots();
  }

  /** 把当前文件复制进快照目录（git 之外的兜底）。 */
  async snapshot(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.paths.layer, "utf8");
    } catch {
      return;
    }
    try {
      await mkdir(this.snapshotDir, { recursive: true });
      const name = `${stampKey()}-${versionOf(raw)}.yaml`;
      await writeFile(join(this.snapshotDir, name), raw, "utf8");
      log.info("kb-admin", `正式知识库已留存快照 ${name}`);
    } catch (err) {
      log.warn("kb-admin", `快照失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 只保留最新的 N 份快照（文件名前缀是东八区时间戳，按名字倒序即按时间倒序）。 */
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

  /**
   * 把一条移进回收站，返回它在回收站里的新 id。
   * **先写回收站、再改主文件**：反过来的话，中间挂掉就会丢掉这条内容。
   */
  async trash(entry: KbEntry, actor: string): Promise<string> {
    let records: Record<string, unknown>[] = [];
    try {
      records = parseTrashFileText(await readFile(this.paths.trash, "utf8"));
    } catch {
      records = [];
    }
    const id = trashIdOf(entry.id);
    records.push({
      id,
      deleted_at: new Date().toISOString(),
      deleted_by: actor,
      title: entry.title,
      keywords: entry.keywords,
      route: entry.route,
      ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
      ...(entry.forward_hint !== undefined ? { forward_hint: entry.forward_hint } : {}),
    });
    await atomicWrite(this.paths.trash, renderTrashFileText(records, TRASH_HEADER));
    return id;
  }

  /** 审计留档：一条 JSON，一行。按月切分，保留期由 store/retention.ts 统一清理。 */
  async audit(record: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.paths.dataDir, { recursive: true });
      const file = join(this.paths.dataDir, `kb-audit-${monthKey()}.jsonl`);
      await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
    } catch (err) {
      log.warn("kb-admin", `审计日志写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
