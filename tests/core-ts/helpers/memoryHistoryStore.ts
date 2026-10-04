
















import type { HistoryRecord, HistoryStore } from "../../../core-ts/src/services/history.js";


export interface MemoryHistoryStore extends HistoryStore {
  
  records: HistoryRecord[];
  
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
