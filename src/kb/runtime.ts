/**
 * 知识库运行时：持有一份编译好的知识库，并支持原地热重载。
 *
 * 为什么需要它：知识库是**启动时**读进内存、编成 system prompt 的。飞书卡片改完文件后
 * 必须让新内容生效，而重启容器既慢（几秒断线）又没必要。所以这里把「当前生效的
 * systemPrompt」变成一个可原子替换的引用：编译成功才换、换的时候一次赋一个字符串，
 * 正在生成回复的那些请求要么用旧的要么用新的，不会读到写了一半的状态。
 *
 * 注意 systemPrompt 必须**逐字节稳定**（提示词缓存按字节前缀匹配），所以：
 *   - 只有内容真的变了（哈希变了）才值得换；
 *   - 换一次就让缓存按设计失效一次，这是有意的。
 */
import { readFile } from "node:fs/promises";
import type { Config } from "../core/config.js";
import { log } from "../core/log.js";
import { compileKnowledgeBase } from "./kb.js";
import type { KnowledgeBase } from "./kb.js";

export class KnowledgeBaseRuntime {
  private kb!: KnowledgeBase;

  constructor(private readonly cfg: Config) {}

  /** 读盘并编译。基线缺失或内容非法都会抛出（启动阶段应当直接失败）。 */
  async load(): Promise<KnowledgeBase> {
    const baseRaw = await readFile(this.cfg.KB_PATH, "utf8");
    let feishuRaw: string | undefined;
    try {
      feishuRaw = await readFile(this.cfg.KB_FEISHU_PATH, "utf8");
    } catch {
      // 首次运行时飞书层还不存在，属于正常情况。
      feishuRaw = undefined;
    }
    this.kb = compileKnowledgeBase(baseRaw, this.cfg.KB_PATH, feishuRaw, this.cfg.KB_FEISHU_PATH);
    return this.kb;
  }

  /**
   * 拿到基线原文——飞书卡片做「写盘前试编译」时要用它和候选内容一起编译，
   * 确保新内容与基线的 id、变量引用都能对上。
   */
  async baseRaw(): Promise<string> {
    return readFile(this.cfg.KB_PATH, "utf8");
  }

  /**
   * 拿到飞书层原文（不存在时 undefined）——改 kb.yaml 时要拿它一起试编译，
   * 否则「改完自己没问题、和飞书层 id 撞车」这种冲突要到重启才暴露。
   */
  async feishuRaw(): Promise<string | undefined> {
    try {
      return await readFile(this.cfg.KB_FEISHU_PATH, "utf8");
    } catch {
      return undefined;
    }
  }

  current(): KnowledgeBase {
    if (this.kb === undefined) throw new Error("知识库尚未加载");
    return this.kb;
  }

  /** 传给 QQ 侧的 system prompt 取值函数（每次请求现取，取到的是一整个字符串）。 */
  systemPrompt = (): string => this.current().systemPrompt;

  /** 重新读盘编译并原子替换。失败时抛错且**保持旧内容继续服务**。 */
  async reload(): Promise<KnowledgeBase> {
    const before = this.kb?.version;
    const next = await this.load();
    if (before !== next.version) {
      log.info(
        "kb",
        `知识库已热重载：kb-${next.version}（基线 ${next.entries.length} 条，飞书补充 ` +
          `${next.feishuEnabled ? next.feishuEntries.length : 0} 条${next.feishuEnabled ? "" : "（注入已停用）"}，` +
          `system prompt ${next.systemPrompt.length} 字符）`,
      );
    } else {
      log.info("kb", `知识库内容没有变化（kb-${next.version}），未触发缓存失效`);
    }
    return next;
  }
}
