/**
 * tests/core-ts/helpers/memoryHistoryStore.ts — 测试专用**内存版** HistoryStore。
 *
 * 为什么必须存在（A-1017 事故复盘）：
 * `ChatService` 的 `opts.history` 缺省值是 `fileHistoryStore`（`core-ts/src/services/chat.ts`
 * 的 `this.historyStore = opts.history ?? fileHistoryStore`），它直连**真实**
 * `config/history.jsonl`。测试里只要漏传 `history`，被测代码就会把测试数据写进用户真实历史。
 *
 * 2026-09-19 实测后果：`network-gate` / `chat_service` 共 6 个构造点漏传，多轮 `vitest run`
 * 累计写入 76 条 `agent_id = "agent_test1"` 的记录（该 id 只存在于测试 fixture，真实
 * `config/agents.json` 里没有它）。随后 GUI 的「孤儿历史惰性迁移」拿这个不存在的 agent_id
 * 建出了一个**幽灵会话**：模型选不了（引擎 `findAgent` 返回 undefined → 404「Agent 不存在」），
 * 删掉之后又被下一次列表刷新重新建回来（旧记录没有 session_id，`clearSessionHistory` 匹配不到）。
 *
 * 用法：`new ChatService({ registry, engine, history: memoryHistoryStore(), logger })`
 * 守卫：`tests/core-ts/chat-history-injection.spec.ts` 按「总数 − 具名豁免」锁死所有构造点。
 */
import type { HistoryRecord, HistoryStore } from "../../../core-ts/src/services/history.js";

/** 打印用：把 store 当成 truthy 也要能看出它是内存版（避免误用真实 store） */
export interface MemoryHistoryStore extends HistoryStore {
  /** 已写入的记录（断言用；顺序 = append 顺序） */
  records: HistoryRecord[];
  /** 真实落盘路径——内存版恒为 null，供守卫/断言区分「有没有碰真实 config」 */
  filePath: null;
}

export function memoryHistoryStore(seed: HistoryRecord[] = []): MemoryHistoryStore {
  const records: HistoryRecord[] = seed.map((r) => ({ ...r }));

  return {
    records,
    filePath: null,

    async append(agentId, userMsg, aiReply, success = true, sessionId, reasoning, elapsedMs, turns) {
      records.push({
        agent_id: agentId,
        user: userMsg,
        ai: aiReply,
        success,
        timestamp: new Date().toISOString(),
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
        ...(turns === undefined ? {} : { turns }),
      });
    },

    async load(agentId = null, limit = 200, sessionId) {
      const filtered = records.filter((r) => {
        if (agentId && r.agent_id !== agentId) { return false; }
        if (sessionId !== undefined && r.session_id !== sessionId) { return false; }
        return true;
      });
      // 与 fileHistoryStore 语义对齐：取**末尾** limit 条（最近的对话）
      return filtered.slice(Math.max(0, filtered.length - limit)).map((r) => ({ ...r }));
    },

    async popLast(agentId, sessionId) {
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r.agent_id !== agentId) { continue; }
        if (sessionId !== undefined && r.session_id !== sessionId) { continue; }
        records.splice(i, 1);
        return true;
      }
      return false;
    },
  };
}
