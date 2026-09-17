/**
 * 群消息的排队与到达簿记：都是与 QQ SDK 无关的纯逻辑，便于离线单测。
 */

/**
 * 按 key 串行执行，后到的任务等前一个跑完。
 *
 * 上下文是同群共享的可变状态，而「读历史 → 调模型 → 写回复」这一整段不能被别的消息插进来：
 * 插进来就会读到「有问题、还没答复」的中间态，历史错乱后模型会把自己的上一轮回答当成新问题，
 * 出现「自问自答」（中文社区有同构的踩坑记录）。CowAgent 的默认也是这个语义
 * （`concurrency_in_session: 1`，注释直写 >1 可能导致回复乱序）。
 */
export function createSerialQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    // 前一个任务失败也要继续排队，所以 onFulfilled / onRejected 都指向 task。
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return next;
  };
}

/**
 * 每个群里「最近一条进来的消息」的序号。
 *
 * 只服务于一个判断：**从收到这条 @ 消息、到答案生成完毕准备发送，这中间群里有没有人插话**。
 * 平台把同一 `msg_id` 的多条回复排在触发消息下面，一旦有人插话，机器人的回复就飘在新消息上面、
 * 群里看不出它在回谁——这时要显式引用那条 @ 消息（见 `sendMainReply`）。
 */
export interface ArrivalTracker {
  /** 记一条刚收到的群消息，返回该群的新序号——调用方把它当作「我这条」的序号留着。 */
  mark(groupId: string): number;
  /** 这个序号之后，该群是否又进过消息。 */
  hasNewArrival(groupId: string, seq: number): boolean;
}

/** 久未活跃的群，簿记留 30 分钟即可：比任何一次「生成 + 发送」的时长都宽裕得多。 */
const ARRIVAL_TTL_MS = 30 * 60_000;

export function createArrivalTracker(): ArrivalTracker {
  // 序号全局递增，每个群只记「自己最后一条」：别的群进消息不会让这个群误判。
  let nextSeq = 1;
  const last = new Map<string, { seq: number; at: number }>();
  return {
    mark(groupId: string): number {
      const seq = nextSeq++;
      last.set(groupId, { seq, at: Date.now() });
      // 机器人进的群会一直变多，簿记只该跟「最近活跃的群数」有关：攒到一定量就清掉久未发言的。
      if (last.size > 200) {
        const deadline = Date.now() - ARRIVAL_TTL_MS;
        for (const [key, entry] of last) {
          if (entry.at < deadline) last.delete(key);
        }
      }
      return seq;
    },
    hasNewArrival(groupId: string, seq: number): boolean {
      const entry = last.get(groupId);
      return entry !== undefined && entry.seq > seq;
    },
  };
}

/** 该群在「我这条」之后又进过消息 → 回复要引用回那条 @ 消息。 */
export function needsQuote(arrivals: ArrivalTracker, groupId: string, ownSeq: unknown): boolean {
  return typeof ownSeq === "number" && arrivals.hasNewArrival(groupId, ownSeq);
}
