/**
 * tests/core-ts/a1068-livecard.spec.ts — #227 收口守卫：**思考历程里的实时工具卡**
 *
 * ── 用户原话（这是他第 N 次提同一件事）───────────────────────────────────────
 * 「我要的程序执行一些任务，运行脚本时直接在思考历程那里出现如图……一样可展开栏目，
 *   而且实时返回状态，成功后直接更新状态。你现在只是在最下方标注的成功/失败，
 *   跟我的请求相去甚远。」
 *
 * ── 这条链路的四段（此前**每段各自有守卫，唯独断在中间**）────────────────
 *   ① `tool_loop.ts` 执行**前**广播 `tool-start`（A-1061②，有守卫）
 *   ② `engine.ts` 把它抬进 liveQueue，完成事件带 `toolId`（A-1061②，有守卫）
 *   ③ `chat.ts` 的中继把它透传到界面（A-1064，有穷举守卫）
 *   ④ **界面**：`tool-start` → 思考历程里建卡（`running`）→ 结果到了**原地**翻状态
 *
 * 前三段已被 `a1061-livetool.spec.ts` / `a1064-stream-relay.spec.ts` 锁住。本文件补第 ④ 段：
 * 它才是用户"跟我的请求相去甚远"的落点 —— 事件到了、卡片没建，用户看到的还是只有最下方
 * 那一行事后成败。**中间少一环 = 整条链看着全绿而用户什么都看不到。**
 *
 * ── 另外收掉一个假状态（A-1068-B）──────────────────────────────────────────
 * `running` 是普通字段、会随 localStorage 落盘，而落盘发生在**流式过程中**。进程在工具
 * 执行途中消失（崩溃/关窗）→ 磁盘上留下 `running: true` → 下次回看那张卡**永久**显示
 * 「执行中」。这与本仓写明的取舍直接冲突（ChatPanel：「宁可提前收起，也不留一行永远停在
 * 「执行中」的假状态 —— 那比没显示更糟，用户会以为它卡住了」）。
 *
 * ⚠️ 中文串里嵌引用一律 `「」`：ASCII 双引号会当场把 TS 字符串截断（a1054/a1055/a1056/a1067 都踩过）。
 * ⚠️ `toContain` 前先确认该串**唯一**（§8-1）：本文件多处断言都用"相邻性"或剥注释后的聚合体，
 *   不许只写一个到处都有的短串（a1067 首轮变异实锤过这种假绿）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { settleRunning, attachTimelineToHistory, type TimelineStepLite } from "../../gui/src/renderer/pages/sessionCtxMeta.js";
import { toolStatusLabel } from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const META = read("gui/src/renderer/pages/sessionCtxMeta.ts");

/** 取 onChunk 里某个 `if (c.type === "x" …) {` 分支的体：右界取**下一个兄弟分支**。
 *  ⚠️ 不许用固定字数窗口（a1061-livetool 已被这个坑咬过：该分支去掉注释后比窗口长 → 假红）。 */
function branchBody(src: string, sig: string, nextSig: string): string {
  const at = src.indexOf(sig);
  expect(at, `锚点漂移：找不到分支 ${sig}`).toBeGreaterThan(-1);
  const end = src.indexOf(nextSig, at + sig.length);
  expect(end, `锚点漂移：找不到 ${sig} 的下一个兄弟（右界）`).toBeGreaterThan(at);
  return src.slice(at, end);
}

/** TimelineNode 里 `kind === "tool"` 那一支的**完整**体：从工具卡起点到下一个组件（ThinkingPanel）之前。
 *  ⚠️ 首版用的是固定字数窗口（`+6000`）—— 实测不够（该分支去掉注释后仍远超），假红。
 *  Ref: a1061-livetool 已被同一个坑咬过（它的注释里写着"固定 4200 字窗口不够"）。
 *  ⇒ **窗口边界必须比断言粒度更细，且不能用字数**；这里用下一个顶层组件的声明当右界。 */
function toolNodeBody(): string {
  const at = PANEL.indexOf('const tool = step as TimelineStep & { kind: "tool" };');
  expect(at, "锚点漂移：找不到工具卡的渲染分支").toBeGreaterThan(-1);
  const end = PANEL.indexOf("const ThinkingPanel = React.memo(", at);
  expect(end, "锚点漂移：找不到工具卡分支的右界（ThinkingPanel）").toBeGreaterThan(at);
  return PANEL.slice(at, end);
}

describe("A-1068-A 思考历程的工具卡：tool-start 建卡、结果到了原地翻（不追加第二张）", () => {
  const startBody = branchBody(
    strip(PANEL),
    'if (c.type === "tool-start" && c.data?.name) {',
    'if (c.type === "tool" && c.data?.name) {',
  );
  const doneBody = branchBody(
    strip(PANEL),
    'if (c.type === "tool" && c.data?.name) {',
    'if (c.type === "reasoning") {',
  );

  it("tool-start 在思考历程里**建**一张 running 卡（这是用户盯着看的那块区域）", () => {
    expect(startBody, "tool-start 没有往时间线里建卡 → 用户又只剩最下方的事后成败").toContain("appendTimelineStep(");
    expect(startBody).toContain("timelineStepsRef.current = steps;");
    expect(startBody).toContain("setLiveTimeline(steps);");
  });

  it("建卡时**明确**带 running: true（不带就永远只是事后成败）", () => {
    expect(startBody, "建卡没带 running → 卡片一出现就是「未记录」的哑行").toContain("running: true");
  });

  it("建卡记下 toolId → 索引（结果到了靠它原地翻，而不是追加一张新卡）", () => {
    expect(startBody, "没有记 toolId → 结果到了配不上，必然出两张卡").toContain("toolStepIndexRef.current.set(toolId,");
    expect(startBody).toContain("if (toolId)");
  });

  it("结果到了**原地**翻状态：改那一格 + 收掉索引（不 push）", () => {
    expect(doneBody, "没有取配对索引").toContain("toolStepIndexRef.current.get(toolIdHere)");
    expect(doneBody, "没有判断它确实还处于 running（否则会把历史卡误翻）").toContain('pendingStep.running === true');
    expect(doneBody, "没有原地写回那一格").toContain("patched[stepIdx!] = { ...pendingStep, result: ev.result, running: false };");
    expect(doneBody, "原地翻完没有销掉索引 → 下一次调用会翻错卡").toContain("toolStepIndexRef.current.delete(toolIdHere);");
  });

  it("配对失败才追加（历史回退路径 / toolId 缺失），两条路互斥", () => {
    // 有 `else` 分支兜住"配不上"的情形，否则那类事件会被整条丢掉
    const atElse = doneBody.indexOf("} else {");
    expect(atElse, "没有 else 兜底 → 配不上的结果事件静默消失").toBeGreaterThan(-1);
    const elseBody = doneBody.slice(atElse);
    expect(elseBody, "else 分支没有兜底建卡").toContain("appendTimelineStep(");
    expect(elseBody, "兜底建的是**已完成**卡（不带 running）").not.toContain("running: true");
  });

  it("卡片可展开（用户要的是「可展开栏目」，不是一行摘要）", () => {
    // 展开能力在渲染层：结果/详情存在即可展开（`hasBody`）+ collapse 包裹
    const node = toolNodeBody();
    expect(node).toContain("const hasBody = !!tool.detail || !!r;");
    expect(node).toContain('className={`collapse${expanded ? " is-open" : ""}`}');
  });

  it("组件层：running 必须**优先于**「未记录」拿到状态词（否则正在跑是一行哑行）", () => {
    expect(toolStatusLabel(undefined, false, true)).toBe("执行中");
    const node = toolNodeBody();
    expect(node, "组件没有把 running 传进唯一出处").toContain("toolStatusLabel(tool.result, isFail, isRunning)");
    expect(node, "running 态没有可见的运动感（用户要「实时」看得见）").toContain("text-scan-light");
  });
});

describe("A-1068-B 回看历史时不许留下假的「执行中」（粘住的 running 必须在收编处清掉）", () => {
  it("settleRunning：把 running 清成 false，其余字段一字不动", () => {
    const steps: TimelineStepLite[] = [
      { kind: "think", text: "想了想" },
      { kind: "tool", name: "bash", label: "运行命令", detail: "npm test", running: true },
      { kind: "tool", name: "file_read", label: "读取文件", result: "ok", running: false },
    ];
    const out = settleRunning(steps)!;
    expect(out[1].running).toBe(false);
    expect(out[1].name).toBe("bash");
    expect(out[1].detail).toBe("npm test");
    expect(out[2]).toEqual({ kind: "tool", name: "file_read", label: "读取文件", result: "ok", running: false });
    expect(out[0]).toEqual({ kind: "think", text: "想了想" });
  });

  it("没有任何 running 时原样返回（不白拷一份数组）", () => {
    const steps: TimelineStepLite[] = [{ kind: "tool", name: "bash", result: "ok" }];
    expect(settleRunning(steps)).toBe(steps);
  });

  it("空/未定义输入安全（历史里没有时间线是常态）", () => {
    expect(settleRunning(undefined)).toBeUndefined();
    expect(settleRunning([])).toEqual([]);
  });

  it("🔌 接线：收编**两个来源之外**（localStorage 与消息记录都会带粘住的 running）", () => {
    const code = strip(META);
    const at = code.indexOf("const stored = meta?.timelineByAssistantIdx?.[aiOrd];");
    expect(at, "锚点漂移：找不到 attachTimelineToHistory 的取源处").toBeGreaterThan(-1);
    const body = code.slice(at, at + 700);
    expect(body, "settleRunning 没有包在两个来源之外 → 只清了一路，另一路照旧假「执行中」").toContain("settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline))");
  });

  it("行为：从 localStorage 与从消息记录两条路读回，running 都被清掉", () => {
    const live: TimelineStepLite[] = [{ kind: "tool", name: "bash", label: "运行命令", running: true }];
    // ① 走 localStorage 那一支
    const viaMeta = attachTimelineToHistory(
      [{ role: "assistant", content: "x" }],
      { used: 0, cap: 0, timelineByAssistantIdx: { 1: live } },
    );
    expect(viaMeta[0].timeline?.[0].running).toBe(false);
    // ② 走消息记录自带那一支（meta 缺失）
    const viaMsg = attachTimelineToHistory(
      [{ role: "assistant", content: "x", timeline: [{ kind: "tool", name: "bash", running: true }] }],
      null,
    );
    expect(viaMsg[0].timeline?.[0].running).toBe(false);
  });

  it("运行期的实时卡**不受影响**：settleRunning 只用在收编处，不在渲染层", () => {
    // 渲染层若也调用它，"实时状态"当场失效 —— 这条断言把用途钉在收编处
    expect(strip(PANEL), "渲染层不许调用 settleRunning（那会把真正在执行中的卡也抹平）").not.toContain("settleRunning");
    expect(strip(META)).toContain("export function settleRunning(");
  });

  it("接口注释不再声称「持久化时必然是 false」（那句假设正是这个 bug 的温床）", () => {
    /* ⚠️ 不能只 `not.toContain("持久化时它必然已是 false/缺省")`：**更正说明里会合法地引用它**
       （「这里原先写着「…」—— 那是错的」）。这正是 a1055 那条教训的加强版 —— 那里是"剥注释即可"，
       这里旧说法本身就住在注释里，剥了会连更正一起剥掉。
       ⇒ 判据要锁**那句承诺的完整原文**（含它的括号结论），而不是判据词本身。 */
    expect(META, "陈旧断言还在 → 下一个人会照着它继续相信 running 不会落盘")
      .not.toContain("持久化时它必然已是 false/缺省（结果到了才会落库）");
    expect(META).toContain("A-1068 更正");
  });
});
