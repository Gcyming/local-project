














import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  FLOW_MAX_ENTRIES,
  FLOW_MAX_SESSIONS,
  FLOW_STORE_PREFIX,
  FLOW_THINKING_COALESCE_CHARS,
  appendFlowEvents,
  applyFlowEvent,
  clearFlowState,
  emptyFlowState,
  flowStorageKey,
  pruneFlowStorage,
  readFlowState,
  writeFlowState,
  type FlowEvent,
  type FlowState,
} from "../../gui/src/renderer/pages/brainstormFlow.js";


const mem = new Map<string, string>();
function installLocalStorage(): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string): string | null => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string): void => { mem.set(k, String(v)); },
    removeItem: (k: string): void => { mem.delete(k); },
    clear: (): void => { mem.clear(); },
    key: (i: number): string | null => Array.from(mem.keys())[i] ?? null,
    get length(): number { return mem.size; },
  } as unknown as Storage;
}
beforeEach(() => { mem.clear(); installLocalStorage(); });

const think = (name: string, text: string): FlowEvent => ({ kind: "thinking", name, text });
const idea = (name: string, text: string): FlowEvent => ({ kind: "idea", name, text });

const joinTextOf = (st: FlowState, name: string): string =>
  st.entries.filter((e) => e.name === name).map((e) => e.text).join("");

describe("applyFlowEvent —— 唯一写入路径的合并语义", () => {
  it("同一成员的连续 thinking 并入同一条（流式思考自然成段，不炸成几百条）", () => {
    let st = emptyFlowState();
    st = applyFlowEvent(st, think("甲", "先看"));
    st = applyFlowEvent(st, think("甲", "再看"));
    st = applyFlowEvent(st, think("甲", "再看一点"));
    expect(st.entries).toHaveLength(1);
    expect(st.entries[0].text).toBe("先看再看再看一点");
    expect(st.entries[0].kind).toBe("thinking");
  });

  it("换成员另起一条（不能把乙的思考接到甲的段落里）", () => {
    let st = emptyFlowState();
    st = applyFlowEvent(st, think("甲", "甲说"));
    st = applyFlowEvent(st, think("乙", "乙说"));
    st = applyFlowEvent(st, think("甲", "甲又说"));
    expect(st.entries.map((e) => e.name)).toEqual(["甲", "乙", "甲"]);
    expect(st.entries[2].text).toBe("甲又说");
  });

  it("★ 核心回归：idea（观点）永远另起一条，**不许覆盖**已累积的思考", () => {
    
    
    let st = emptyFlowState();
    st = applyFlowEvent(st, think("甲", "第一段思考"));
    st = applyFlowEvent(st, think("乙", "第二段思考"));
    st = applyFlowEvent(st, idea("甲", "因此我的结论是 A"));
    st = applyFlowEvent(st, think("乙", "继续想"));
    expect(st.entries.map((e) => e.kind)).toEqual(["thinking", "thinking", "idea", "thinking"]);
    expect(st.entries.filter((e) => e.kind === "thinking")).toHaveLength(3);
    expect(st.entries[0].text).toBe("第一段思考");
    expect(st.entries[1].text).toBe("第二段思考");
  });

  it("连续两条 idea 各自独立（观点是离散事件，合并会把它埋进上一条里）", () => {
    let st = emptyFlowState();
    st = applyFlowEvent(st, idea("甲", "观点一"));
    st = applyFlowEvent(st, idea("甲", "观点二"));
    expect(st.entries).toHaveLength(2);
    expect(st.entries.map((e) => e.text)).toEqual(["观点一", "观点二"]);
  });

  it("thinking 段落写满后另起新条，**不丢字**（旧实现是静默截断）", () => {
    const long = "x".repeat(FLOW_THINKING_COALESCE_CHARS + 250);
    let st = emptyFlowState();
    st = applyFlowEvent(st, think("甲", long));
    expect(st.entries).toHaveLength(2);
    expect(st.entries[0].text).toHaveLength(FLOW_THINKING_COALESCE_CHARS);
    
    expect(joinTextOf(st, "甲")).toBe(long);
  });

  it("跨多次调用的累计写入同样不丢字（分片到达是流式的常态）", () => {
    const parts = Array.from({ length: 7 }, (_, i) => `p${i}-` + "y".repeat(200));
    let st = emptyFlowState();
    for (const p of parts) { st = applyFlowEvent(st, think("甲", p)); }
    expect(joinTextOf(st, "甲")).toBe(parts.join(""));
  });

  it("空 / 纯空白文本不进流（杜绝「想」出空行的噪音）", () => {
    const base = emptyFlowState();
    expect(applyFlowEvent(base, think("甲", ""))).toBe(base);
    expect(applyFlowEvent(base, think("甲", "   \n\t "))).toBe(base);
    expect(applyFlowEvent(base, idea("甲", ""))).toBe(base);
  });

  it("条目 id 单调唯一（React key 稳定；同毫秒撞 key 会错渲染）", () => {
    let st = emptyFlowState();
    for (let i = 0; i < 5; i += 1) { st = applyFlowEvent(st, idea("甲", `m${i}`)); }
    const ids = st.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("超出上限时折叠最早的条目并**计入 dropped**（界面据此显式提示，不静默丢）", () => {
    let st = emptyFlowState();
    for (let i = 0; i < FLOW_MAX_ENTRIES + 5; i += 1) { st = applyFlowEvent(st, idea("甲", `m${i}`)); }
    expect(st.entries).toHaveLength(FLOW_MAX_ENTRIES);
    expect(st.dropped).toBe(5);
    
    expect(st.entries[st.entries.length - 1].text).toBe(`m${FLOW_MAX_ENTRIES + 4}`);
    expect(st.entries[0].text).toBe("m5");
  });

  it("applyFlowEvent 不改入参（纯函数：否则 ref 与 state 会共享同一数组，渲染错乱）", () => {
    const st = emptyFlowState();
    const before = JSON.stringify(st);
    applyFlowEvent(st, think("甲", "x"));
    expect(JSON.stringify(st)).toBe(before);
  });

  it("appendFlowEvents 等价于逐条 applyFlowEvent（rAF 合批不许改变语义）", () => {
    const evs = [think("甲", "a"), think("甲", "b"), idea("乙", "结论"), think("甲", "c"), think("甲", "")];
    let one = emptyFlowState();
    for (const e of evs) { one = applyFlowEvent(one, e); }
    const batch = appendFlowEvents(emptyFlowState(), evs);
    expect(batch.entries).toEqual(one.entries);
    expect(batch.dropped).toBe(one.dropped);
    expect(appendFlowEvents(emptyFlowState(), [])).toEqual(emptyFlowState());
  });
});

describe("持久化 —— 症状①「重启后内容消失」的根因修复", () => {
  const SID = "sess-1";

  it("写后可读回，条目逐字一致（这就是「重启后还在」的全部机制）", () => {
    let st = emptyFlowState();
    st = applyFlowEvent(st, think("甲", "思考一"));
    st = applyFlowEvent(st, idea("甲", "观点一"));
    writeFlowState(SID, st, 1700);
    const back = readFlowState(SID);
    expect(back).not.toBeNull();
    expect(back!.entries).toEqual(st.entries);
    expect(back!.nextId).toBe(st.nextId);
    expect(back!.updatedAt).toBe(1700);
  });

  it("key 带会话前缀且按会话隔离（A 群聊的流不许出现在 B 群聊）", () => {
    expect(flowStorageKey("abc")).toBe(`${FLOW_STORE_PREFIX}abc`);
    let a = emptyFlowState();
    a = applyFlowEvent(a, idea("甲", "A 群的观点"));
    let b = emptyFlowState();
    b = applyFlowEvent(b, idea("乙", "B 群的观点"));
    writeFlowState("sa", a);
    writeFlowState("sb", b);
    expect(readFlowState("sa")!.entries[0].text).toBe("A 群的观点");
    expect(readFlowState("sb")!.entries[0].text).toBe("B 群的观点");
    expect(readFlowState("sc")).toBeNull();
  });

  it("空 sessionId 不写不读（防把流写到全局 key 上）", () => {
    const st = appendFlowEvents(emptyFlowState(), [idea("甲", "x")]);
    writeFlowState("", st);
    expect(mem.size).toBe(0);
    expect(readFlowState("")).toBeNull();
  });

  it("坏数据一律回退 null，绝不把右栏整个打挂（旧结构 / 手改 / 别的模块误写）", () => {
    const k = flowStorageKey(SID);
    mem.set(k, "{ 这不是 JSON");
    expect(readFlowState(SID)).toBeNull();
    mem.set(k, JSON.stringify({ entries: "not-an-array" }));
    expect(readFlowState(SID)).toBeNull();
    mem.set(k, JSON.stringify(null));
    expect(readFlowState(SID)).toBeNull();
    mem.set(k, JSON.stringify({ entries: [] }));
    expect(readFlowState(SID)).toBeNull();
  });

  it("逐条校验条目：字段类型不对的丢掉，好的留下", () => {
    mem.set(flowStorageKey(SID), JSON.stringify({
      entries: [
        { id: 1, name: "甲", text: "好条目", kind: "thinking" },
        { id: 2, name: "甲", text: "kind 非法", kind: "weird" },
        { id: 3, name: 5, text: "name 不是串", kind: "idea" },
        { id: "4", name: "甲", text: "id 不是数字", kind: "idea" },
        { id: 5, name: "乙", text: "乙的观点", kind: "idea" },
      ],
    }));
    const st = readFlowState(SID)!;
    expect(st.entries.map((e) => e.text)).toEqual(["好条目", "乙的观点"]);
  });

  it("nextId 兜底：坏值 / 落后于最大 id 时都要能继续发号（否则新条目 key 撞旧条目）", () => {
    mem.set(flowStorageKey(SID), JSON.stringify({ entries: [{ id: 9, name: "甲", text: "t", kind: "idea" }], nextId: 3 }));
    expect(readFlowState(SID)!.nextId).toBe(10);
    mem.set(flowStorageKey(SID), JSON.stringify({ entries: [{ id: 9, name: "甲", text: "t", kind: "idea" }], nextId: 42 }));
    expect(readFlowState(SID)!.nextId).toBe(42);
    mem.set(flowStorageKey(SID), JSON.stringify({ entries: [{ id: 9, name: "甲", text: "t", kind: "idea" }], nextId: "x" }));
    expect(readFlowState(SID)!.nextId).toBe(10);
  });

  it("clearFlowState 只删本会话（清空不能顺手把别的群聊清掉）", () => {
    writeFlowState("sa", appendFlowEvents(emptyFlowState(), [idea("甲", "a")]));
    writeFlowState("sb", appendFlowEvents(emptyFlowState(), [idea("乙", "b")]));
    clearFlowState("sa");
    expect(readFlowState("sa")).toBeNull();
    expect(readFlowState("sb")).not.toBeNull();
  });

  it("老化清理：超过会话数上限时淘汰最旧的，刚写入的那个永不被淘汰", () => {
    for (let i = 0; i < FLOW_MAX_SESSIONS + 3; i += 1) {
      writeFlowState(`s${i}`, appendFlowEvents(emptyFlowState(), [idea("甲", `m${i}`)]), 1000 + i);
    }
    
    expect(mem.size).toBeLessThanOrEqual(FLOW_MAX_SESSIONS);
    expect(readFlowState(`s${FLOW_MAX_SESSIONS + 2}`)).not.toBeNull(); 
    expect(readFlowState("s0")).toBeNull();                            
  });

  it("pruneFlowStorage 返回被淘汰的条数，并在未超限时无条件返回 0（幂等）", () => {
    writeFlowState("only", appendFlowEvents(emptyFlowState(), [idea("甲", "x")]), 1);
    expect(pruneFlowStorage(FLOW_MAX_SESSIONS, "only")).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      
      
      writeFlowState(`m${i}`, appendFlowEvents(emptyFlowState(), [idea("甲", `m${i}`)]), i + 1);
    }
    const removed = pruneFlowStorage(3, "m4");
    expect(removed).toBeGreaterThan(0);
    expect(readFlowState("m4")).not.toBeNull();
  });
});





function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}
function codeOf(rel: string): string {
  return stripComments(readFileSync(join(PROJECT_ROOT, rel), "utf8"));
}

describe("A-1013 源码守卫：写入路径唯一 + 不静默截断 + 会话隔离", () => {
  const panel = codeOf("gui/src/renderer/pages/BrainstormPanel.tsx");
  const flowSrc = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/brainstormFlow.ts"), "utf8");

  it("★ 全组件只有两处 setFlow：rAF 合批处 + 切会话恢复处（第三条 = 老 bug 回来了）", () => {
    
    
    const hits = panel.match(/setFlow\(/g) ?? [];
    expect(hits).toHaveLength(2);
    expect(panel).toContain("setFlow(flowRef.current)");
    expect(panel).toContain("setFlow(restored)");
  });

  it("thinking 与 idea 走同一个入口 pushFlow（不许各自 setState）", () => {
    const events = panel.slice(panel.indexOf("api.brainstorm.onEvent"));
    expect(events).toContain('pushFlow([{ kind: "thinking"');
    expect(events).toContain('pushFlow([{ kind: "idea"');
    expect(panel).toContain("flowRef.current = appendFlowEvents(");
  });

  it("没有 flushFlow 这类「整批覆盖」的旧写法残留（去注释后仍必须为空）", () => {
    expect(panel).not.toContain("flushFlow");
    expect(panel).not.toMatch(/setFlow\(\s*snap\s*\)/);
  });

  it("无 slice(-N) 静默截断（上限折叠必须走 reducer 并计入 dropped）", () => {
    expect(panel).not.toMatch(/slice\(\s*-\s*\d+\s*\)/);
    expect(flowSrc).toContain("dropped += cut");
    expect(panel).toContain("条已折叠"); 
  });

  it("持久化只经模块函数：组件里不出现裸 localStorage（防再开一份私有的存取实现）", () => {
    expect(panel).not.toContain("localStorage");
    expect(panel).toContain("readFlowState(sessionId)");
    expect(panel).toContain("writeFlowState(");
    
    expect(panel).toContain("writeFlowState(prevSid, flowRef.current)");
  });

  it("成员卡也按 sessionId 复位（否则 A 群聊的成员卡整批留在 B 群聊里）", () => {
    expect(panel).toContain("membersSessionRef");
    expect(panel).toContain("setMembers([])");
    
    expect(panel).not.toContain("byId.has(");
  });

  it("流纯模块保持零 import（渲染进程无 Node 能力，必须能被安全导入）", () => {
    const imports = flowSrc.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
    expect(imports, `brainstormFlow.ts 不该有 import 语句（当前：${imports || "无"}）`).toBe("");
    
    expect(flowSrc).toContain("export function applyFlowEvent");
    expect(flowSrc).toContain("export function readFlowState");
  });
});
