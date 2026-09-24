/**
 * A-1060 守卫：中途「引导」（steer）—— 不打断地把一句话注进正在跑的那一轮。
 *
 * 用户原话：「中间插入输出**还是会直接中断** …… 现在很多 agent 都不是直接中断了，
 * 而是在 agent 输出中插入『引导』」。
 *
 * 权威依据（一手来源）：
 * - **Cursor changelog 2026-08-19**（Steering improvements）：
 *   「send a message to steer the agent while it's working **without interruption**.
 *   Follow-ups **wait for the next tool call** instead of cutting the agent off mid-action」。
 * - **Claude Code 交互模式**：Enter 把消息**排队**到"下一轮边界"，只有 Esc 才中断。
 *
 * 本文件分三层：
 *   A 组 —— `steerBus` 的**行为**（真模块真值，不是搜字符串）：取走即清空、上限、拒绝空文本；
 *   B 组 —— **接线**（这些地方没有可执行入口，只能搜源码）：工具循环在轮次边界消费、
 *          引擎显式成一支、主进程白名单透传 `steerId`、流结束清缓冲、preload 暴露、界面改语义；
 *   C 组 —— 反例自检（证明上面的断言真的抓得住坏写法）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pushSteer, drainSteers, clearSteers, pendingSteerCount,
  resetSteerBusForTest, STEER_MAX_PENDING, STEER_TEXT_MAX,
} from "../../core-ts/src/services/steerBus.js";
import { shouldDeferToSteer, STREAM_ALIVE_MS } from "../../gui/src/renderer/pages/instructionQueue.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const TOOL_LOOP = "core-ts/src/tool_loop.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const CHAT_SVC = "core-ts/src/services/chat.ts";
const MAIN = "gui/src/main/index.ts";
const PRELOAD = "gui/src/preload/index.ts";
const IPC = "gui/src/shared/ipc.ts";
const QUEUE = "gui/src/renderer/pages/instructionQueue.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";

// ── A 组：steerBus 行为 ──────────────────────────────────────────────────────
describe("A-1060-A steerBus 行为（真模块）", () => {
  it("投入 + 取走：取走即清空（同一条引导只能进一次上下文）", () => {
    resetSteerBusForTest();
    expect(pushSteer("s1", { id: "1", text: "改一下方向" })).toBe(1);
    expect(pendingSteerCount("s1")).toBe(1);
    const drained = drainSteers("s1");
    expect(drained.map((i) => i.text)).toEqual(["改一下方向"]);
    // ⚠️ 这条是"不重复注入"的核心：第二次必须为空
    expect(drainSteers("s1")).toEqual([]);
    expect(pendingSteerCount("s1")).toBe(0);
  });

  it("FIFO：多条按投入顺序取出（用户说的顺序就是模型读到的顺序）", () => {
    resetSteerBusForTest();
    pushSteer("s2", { id: "a", text: "第一句" });
    pushSteer("s2", { id: "b", text: "第二句" });
    expect(drainSteers("s2").map((i) => i.text)).toEqual(["第一句", "第二句"]);
  });

  it("会话隔离：A 会话的引导绝不进 B 会话", () => {
    resetSteerBusForTest();
    pushSteer("sA", { id: "1", text: "给 A 的" });
    expect(drainSteers("sB")).toEqual([]);
    expect(pendingSteerCount("sB")).toBe(0);
    expect(drainSteers("sA").map((i) => i.text)).toEqual(["给 A 的"]);
  });

  it("空文本 / 无会话 → **拒绝入队**（不许塞一条无内容的 user 消息进上下文）", () => {
    resetSteerBusForTest();
    expect(pushSteer("s3", { id: "1", text: "   " })).toBe(0);
    expect(pushSteer("", { id: "1", text: "有字但没会话" })).toBe(0);
    expect(pendingSteerCount("s3")).toBe(0);
    expect(drainSteers(undefined)).toEqual([]);
  });

  it("文本两侧空白被去掉（用户手滑的空行不该进上下文）", () => {
    resetSteerBusForTest();
    pushSteer("s4", { id: "1", text: "  去看看那个报错  " });
    expect(drainSteers("s4")[0].text).toBe("去看看那个报错");
  });

  it("超长文本被截断到上限（防止一句话把上下文吃光）", () => {
    resetSteerBusForTest();
    pushSteer("s5", { id: "1", text: "x".repeat(STEER_TEXT_MAX + 500) });
    expect(drainSteers("s5")[0].text.length).toBe(STEER_TEXT_MAX);
  });

  it("待注入上限：超出时丢**最早**的（最新说的一定最相关）", () => {
    resetSteerBusForTest();
    for (let i = 1; i <= STEER_MAX_PENDING + 3; i++) {
      pushSteer("s6", { id: String(i), text: `第 ${i} 句` });
    }
    const got = drainSteers("s6");
    expect(got.length).toBe(STEER_MAX_PENDING);
    expect(got[0].text).toBe("第 4 句");
    expect(got[got.length - 1].text).toBe(`第 ${STEER_MAX_PENDING + 3} 句`);
  });

  it("clearSteers 丢弃全部（流结束时必须能清干净）", () => {
    resetSteerBusForTest();
    pushSteer("s7", { id: "1", text: "会被丢掉" });
    clearSteers("s7");
    expect(pendingSteerCount("s7")).toBe(0);
    expect(drainSteers("s7")).toEqual([]);
  });
});

// ── B 组：接线 ──────────────────────────────────────────────────────────────
describe("A-1060-B 接线：谁在什么时机消费 / 透传 / 清理", () => {
  it("工具循环在**轮次边界**消费（工具执行完、下一次模型请求之前）", () => {
    const src = code(TOOL_LOOP);
    // 消费函数存在，且从 steerBus 取（唯一实现，不许本地再写一份队列）
    expect(src).toContain("import { drainSteers } from \"./services/steerBus.js\";");
    expect(src).toContain("private injectSteers(");
    expect(src).toContain("const items = drainSteers(sessionId);");
    /* 两条路径都要调：流式（带事件）与非流式。
       ⚠️ A-1061⑥ 之后这两个串都成了**同名多产地**（轮次边界一处 + 续轮一处），
       裸 `toContain` 已经**锁不住**"删掉其中一处"（删一处字串还在 → 假绿，实测踩到）。
       所以这里改判**调用点数量**：非流式两处、流式两处。 */
    expect((src.match(/this\.injectSteers\(opts\.sessionId, opts\.messages, opts\.onEvent\);/g) ?? []).length)
      .toBe(2);
    expect((src.match(/this\.injectSteers\(opts\.sessionId, opts\.messages\);/g) ?? []).length).toBe(2);
    /* A-1061⑩ 迁移：注入的不再是裸原文，而是**编排指令 + 原文** ——
       用户原话：「让 Agent 先响应一下、了解用户需求，Agent-Loop 内部重新编排一下流程，
       将用户插入的请求列入任务，在这轮会话解决」。三条要求都必须在指令里。 */
    expect(src).toContain('content: [');
    expect(src).toContain('"[用户中途插入 · Agent-Loop 编排指令]"');
    /* A-1064 迁移（#225）：原文里的 markdown 加粗 `**` 在提示词清理时去掉了。
       锚点不该依赖**装饰性记号** —— 换个加粗方式就静默失配，而判据（要求用 todo_write 列入清单）
       一个字都没变。更强的判据（必须给 `action="add"`，否则模型会落到 replace 上把计划抹掉）
       已搬到 A-1064-C 独立锁住。 */
    expect(src).toContain("调用 todo_write 把它列入当前任务清单");
    expect(src).toContain("it.text,");
    /* M9：注入的必须是 **user** 消息。
       写成 assistant 时模型会把"用户插入的话"当成**自己刚说过的话** →
       它会顺着自己那句往下跑，用户的请求等于没提。
       判据取"指令串之前的 300 字符"，既不依赖缩进（重构挪缩进不会静默失配），
       也不会被文件里其它 `role: "user"`（截图回灌那条）蒙到。 */
    const atInstr = src.indexOf('"[用户中途插入 · Agent-Loop 编排指令]"');
    const head = src.slice(Math.max(0, atInstr - 300), atInstr);
    expect(head, "注入点前 300 字符里找不到 role: \"user\" —— 这条引导不是以用户身份说给模型的").toContain('role: "user"');
    expect(head, "注入成 assistant 了：模型会把自己当成说过这句话").not.toContain('role: "assistant"');
    // 事件里带的仍是**原文**（界面折进思考历程的是用户说的话，不是元指令）
    expect(src).toContain('onEvent?.({ type: "steer", id: it.id, text: it.text });');
  });

  it("流式路径的消费点落在 payload 构造**之前**（否则这一轮看不到引导）", () => {
    const src = code(TOOL_LOOP);
    const atInject = src.indexOf("this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);");
    const atPayload = src.indexOf("const payload: ChatRequest = {", atInject);
    expect(atInject, "找不到流式路径的 injectSteers").toBeGreaterThan(-1);
    expect(atPayload, "injectSteers 之后没有 payload 构造，位置可疑").toBeGreaterThan(atInject);
  });

  it("引擎把 steer 事件**显式**成一支（不能落进 tool 兜底分支）", () => {
    const src = code(ENGINE);
    expect(src).toContain('} else if (ev.type === "steer") {');
    expect(src).toContain('liveQueue.push({ type: "steer", content: ev.text, steerId: ev.id });');
    // 兜底分支仍必须是 tool（顺序：steer 在 else 之前）
    const atSteer = src.indexOf('ev.type === "steer"');
    // ⚠️ 锚点跟着契约走：A-1061② 给 tool 事件补了 `toolId: ev.id`，旧串已不存在
    const atElseTool = src.indexOf('liveQueue.push({ type: "tool", name: ev.name, args: ev.args, result: ev.result, toolId: ev.id });');
    expect(atSteer).toBeGreaterThan(-1);
    expect(atElseTool).toBeGreaterThan(atSteer);
  });

  it("契约类型：EngineChunk / StreamChunk 都认 steer 与 steerId", () => {
    expect(code(CHAT_SVC)).toMatch(/type: "chunk"[^;]*"steer"/);
    expect(code(CHAT_SVC)).toContain("steerId?: string;");
    expect(code(IPC)).toMatch(/type: "chunk"[^;]*"steer"/);
    expect(code(IPC)).toContain("steerId?: string;");
  });

  it("🐛 主进程的 data 是**白名单构造** —— steerId 必须显式透传（漏一行就被静默丢掉）", () => {
    const src = code(MAIN);
    expect(src).toContain('steerId: typeof d.steerId === "string" ? d.steerId : undefined,');
  });

  it("IPC + preload：有 steer 通道与类型声明", () => {
    const main = code(MAIN);
    expect(main).toContain('handleTrusted<{ sessionId?: string; id?: string; text?: string }>("slime:chat:steer"');
    expect(main).toContain("pushSteer(sid, { id: String(payload?.id ?? \"\"), text: String(payload?.text ?? \"\") });");
    const pre = code(PRELOAD);
    expect(pre).toContain('ipcRenderer.invoke("slime:chat:steer", { sessionId, id: String(id), text })');
    expect(pre).toContain("steer: (sessionId: string, id: number | string, text: string) => Promise<{ ok: boolean; pending?: number; error?: string }>;");
  });

  it("🐛 流一结束就清缓冲（成功/出错/取消三条路径都走 finally）", () => {
    const src = code(MAIN);
    /* ⚠️ 锚点必须唯一：文件里前面还有别的 `} finally {`（`indexOf` 会命中第一个，
       于是 900 字窗口根本够不到这条流的 finally —— 本次首跑就是这么假红的）。
       改为以 `chunkSender.dispose()`（该 finally 块的首句）为基准，向前确认 finally、向后确认清缓冲。 */
    const atDispose = src.indexOf("chunkSender.dispose();");
    expect(atDispose, "找不到流收尾处的 chunkSender.dispose()").toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, atDispose - 300), atDispose), "dispose 不在 finally 块里")
      .toContain("} finally {");
    expect(src.slice(atDispose, atDispose + 600), "clearSteers 不在流结束的 finally 里")
      .toContain("clearSteers(cancelKey);");
  });

  it("🐛 界面：待发卡片的「插入」动作**不再取消当前流**", () => {
    const src = code(PANEL);
    const at = src.indexOf("async function insertQueueItemNow(");
    expect(at, "找不到 insertQueueItemNow").toBeGreaterThan(-1);
    const body = src.slice(at, at + 1200);
    // A-1061⑤ 迁移：投递用**卡片自己的会话号**（`item.sessionId`），不是当前视图的 sessionId ——
    // 否则跨会话翻卡片时这句话会跑到别人的运行里去。
    expect(body).toContain("api.chat?.steer?.(item.sessionId, item.id, item.text)");
    // 旧实现是掐流：这条必须绝迹（用户说的"还是会直接中断"就是它）
    expect(body).not.toContain("api.chat.cancel(");
    // 卡片要标成 steer 态（与"排队等下一轮"在观感上分开）
    expect(body).toContain('setMode(interruptQueueRef.current, id, "steer")');
  });

  it("界面：onChunk 里有 steer 分支，撤卡片 + 折进**思考历程**，且**不进正文**", () => {
    const src = code(PANEL);
    const at = src.indexOf('if (c.type === "steer") {');
    expect(at, "onChunk 没有 steer 分支 → 界面不知道引导已生效").toBeGreaterThan(-1);
    const body = src.slice(at, at + 1400);
    // ① 撤卡片（不撤 = onDone 会再发一遍 = 重复发送）
    expect(body).toContain("removeAt(interruptQueueRef.current, steerId)");
    // ② 折进思考历程的时间线，并推送渲染
    expect(body).toContain("timelineStepsRef.current = appendTimelineStep(");
    /* A-1064 迁移（#223）：折进去的是**独立节点** `kind: "steer"`，不再是"think + 引导：前缀"。
       原因（用户原话："思考历程看不到我插入的引导的卡片"）：折成 think 会被合并进相邻思考段，
       既不成卡片，也会污染 onDone 里"要不要用 reasoning 兜底补 think"的判据。 */
    expect(body).toContain('{ kind: "steer", text: steerText }');
    /* 而「引导」这个词**没有消失**，只是从正文文本挪到了卡片的标题上 ——
       这条单独锁住：用户抱怨的正是"看不到引导卡片"，把可见标签弄丢等于没修。 */
    expect(code(PANEL), "引导卡片上的可见标签没了 → 用户又「看不到引导」")
      .toContain('steer-card-title">引导<');
    expect(body).toContain("setLiveTimeline(timelineStepsRef.current);");
    /* ③ 🐛 回归红线：**不许把它当成一条正文消息**（用户明确："插入的对话作为引导，
       是不该出现在正文记录中的，最多也只能存在于思考历程内"）。
       此前正是追加了一条 user 气泡 —— 那句话会混进正文记录里。 */
    expect(body).not.toContain('makeMessage("user", steerText)');
  });

  it("纯逻辑：InsertMode 三态（queue / steer / interrupt）", () => {
    const src = code(QUEUE);
    expect(src).toContain('export type InsertMode = "interrupt" | "queue" | "steer";');
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // ① 兜底分支没显式分家 → 上面那条 `} else if (ev.type === "steer") {` 必须能区分
    expect('} else {\n liveQueue.push({type:"tool"})'.includes('} else if (ev.type === "steer") {')).toBe(false);
    // ② 白名单漏一行 → 断言的字串不会在别的行上偶然为真
    expect('name: typeof d.name === "string" ? d.name : undefined,').not.toContain("steerId");
    // ③ 清缓冲挂在成功路径而非 finally → 片段断言必须能区分（没有 finally 时 indexOf 为 -1）
    const noFinally = "try { done(); } catch { /* ignore */ } \nclearSteers(k);";
    expect(noFinally.indexOf("} finally {")).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A-1061⑤ 同一会话绝不并行开第二条流（插入无论何时都不打断）", () => {
  const base = {
    streamActive: true,
    streamSession: "s1",
    targetSession: "s1",
    lastActivityAt: 1_000_000,
    now: 1_000_000,
  };

  it("🐛 回归红线：同会话、流刚有活动 → 必须让位给引导（不许开第二条流）", () => {
    expect(shouldDeferToSteer(base)).toBe(true);
  });

  it("内部调用（done 后续发 / 引导兜底发送）显式 forceNewTurn → 不受拦截", () => {
    expect(shouldDeferToSteer({ ...base, forceNewTurn: true })).toBe(false);
  });

  it("没有流在跑 → 正常发送（这是用户按回车要的默认行为）", () => {
    expect(shouldDeferToSteer({ ...base, streamActive: false })).toBe(false);
  });

  it("目标是**别的会话** → 不拦（会话 A 的流不该影响在会话 B 发消息）", () => {
    expect(shouldDeferToSteer({ ...base, targetSession: "s2" })).toBe(false);
  });

  it("流归属会话为空（未知归属）→ 不拦（宁可放行，也不吞用户的话）", () => {
    expect(shouldDeferToSteer({ ...base, streamSession: "" })).toBe(false);
  });

  it("🐛 活动时间戳过期 → 自动失效（粘性 ref 残留不许把用户的话吞掉）", () => {
    expect(shouldDeferToSteer({ ...base, lastActivityAt: base.now - STREAM_ALIVE_MS })).toBe(false);
    expect(shouldDeferToSteer({ ...base, lastActivityAt: base.now - STREAM_ALIVE_MS + 1 })).toBe(true);
    // 从未有过活动（0）→ 视作没在动
    expect(shouldDeferToSteer({ ...base, lastActivityAt: 0 })).toBe(false);
  });

  it("接线：doSend 用它做入口拦截，且在**重置流式现场之前**", () => {
    const src = code(PANEL);
    const atGuard = src.indexOf("const deferToSteer = shouldDeferToSteer({");
    const atCompress = src.indexOf("await maybeAutoCompress(", atGuard);
    expect(atGuard, "doSend 里没有引导让位判据").toBeGreaterThan(-1);
    expect(atCompress, "取不到 maybeAutoCompress 的位置").toBeGreaterThan(atGuard);
    // 判据的六个输入都要真值透传
    const body = src.slice(atGuard, atCompress);
    for (const k of ["forceNewTurn: opts?.forceNewTurn", "streamActive: streamActiveRef.current", "streamSession: streamSessionRef.current ?? \"\"", "targetSession: sendSid", "lastActivityAt: streamActivityAtRef.current", "now: Date.now()"]) {
      expect(body, `判据缺输入 ${k}`).toContain(k);
    }
  });

  it("🐛 判据**不看 loading**（loading 会被 A-1051 支④ 提前收掉，那正是被打断的入口）", () => {
    const src = code(PANEL);
    const atGuard = src.indexOf("const deferToSteer = shouldDeferToSteer({");
    const body = src.slice(atGuard, atGuard + 700);
    expect(body).not.toContain("loading");
  });

  it("活动时间戳必须**两处**刷新：每次流事件 + 开流那一刻", () => {
    const src = code(PANEL);
    const n = (src.match(/streamActivityAtRef\.current = Date\.now\(\);/g) ?? []).length;
    expect(n, "只刷新一处 → 另一处会判成「流没在动」而放行第二条流").toBeGreaterThanOrEqual(2);
    expect(src).toContain("if (otherSid == null) { streamActivityAtRef.current = Date.now(); }");
  });

  it("被让位时只入队（不开第二条流）；真正投递在 insertQueueItemNow，且用**卡片自己的 id**", () => {
    /* A-1062 **迁移**（不删，保留原意）：
       原实现（A-1061⑦）在 doSend 的让位分支里**边建卡边投递**（`steerId` 建卡 →
       `chat.steer(sendSid, steerId, replayText)`），所以守卫锚的是那两句。
       用户裁决撤销该行为（「排队不直接发送，不排队直接发送」）后，让位分支**只入队**，
       「投递」整件事搬到「现在插入」这个动作里 —— 但**同一条不变量仍在**：
       投给主进程的 id 必须就是**卡片自己的 id**（不是新生成的），否则撤卡片配不上、
       该条会被再发一遍。于是判据搬到新家：doSend 侧断言"只排队不投递"，
       insertQueueItemNow 侧断言"用 item.id，且不生成新 id"。 */
    const src = code(PANEL);
    const atGuard = src.indexOf("const deferToSteer = shouldDeferToSteer({");
    expect(atGuard, "找不到让位判据").toBeGreaterThan(-1);
    const body = src.slice(atGuard, atGuard + 1600);
    expect(body, "被让位时必须落成待发（排队）").toContain('mode: "queue"');
    expect(body, "被让位时不许直接投递（那是「现在插入」的动作）").not.toMatch(/chat\??\.steer\??\.\(/);

    const atNow = src.indexOf("async function insertQueueItemNow");
    expect(atNow, "找不到投递点").toBeGreaterThan(-1);
    const now = src.slice(atNow, atNow + 4000);
    expect(now, "投给主进程的 id 必须是卡片自己的 id").toContain("chat?.steer?.(item.sessionId, item.id, item.text)");
    // 两次 nextQueueId() 会得到不同 id → 撤卡片配不上 → 该条被再发一遍
    expect((now.match(/nextQueueId\(\)/g) ?? []).length, "投递点不许再生成新 id").toBe(0);
  });

  it("两个内部调用点都带 forceNewTurn（否则续发会被自己拦住 → 发了没反应）", () => {
    const src = code(PANEL);
    const n = (src.match(/forceNewTurn: true \}\)/g) ?? []).length;
    expect(n, "内部续发点漏了 forceNewTurn").toBeGreaterThanOrEqual(2);
  });

  it("「引导」投递用**卡片自己的会话号**（跨会话翻卡片时不许投错运行）", () => {
    // A-1062 迁移：投递点从 `.catch(() => undefined)` 改成 try/catch（失败要能退回 queue 态，
    // 见 tests/gui/insert-copy.spec.ts），但**本意不变**：会话号必须取卡片自己的。
    const src = code(PANEL);
    expect(src).toContain("await api.chat?.steer?.(item.sessionId, item.id, item.text);");
    expect(src).not.toContain("await api.chat?.steer?.(sessionId, item.id, item.text);");
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 用 loading 当判据的实现：loading 被提前收掉时它就不拦了 —— 正是被打断的入口
    const withLoading = (loading: boolean, active: boolean): boolean => loading && active;
    expect(withLoading(false, true)).toBe(false);
    // 我们的判据在同样输入下仍然拦（因为看的是活动时间戳）
    expect(shouldDeferToSteer({ ...base, streamActive: true })).toBe(true);
  });
});
