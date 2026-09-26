/**
 * A-1061② 守卫：工具执行的**实时**状态（「执行中…」→「✓ 成功 / ✗ 失败」）。
 *
 * 用户原话（配 WorkBuddy 的「运行命令」块截图）：
 * 「中间运行脚本的过程也加上……要可以跟你一样，实时监测进程，成功了要返回成功提示」。
 *
 * 根因：主进程此前**只在工具执行完**才发 tool 事件（带 result）→ 界面只能事后显示成败。
 * 更隐蔽的一层：`toolStatusLabel` 在 result 不是字符串时返回**空串**（A-1028 的
 * "结果未记录 ≠ 结果为空"）→ 正在跑的调用落到那一支，界面上是一行**没有状态词**的哑行。
 *
 * 权威形态（对齐）：Claude Agent SDK 流式示例用 `content_block_start(tool_use)` 打
 * `[Using Read…]`、`content_block_stop` 打 `done`；Claude Code 的 TUI 用
 * `tool_start` 建块 / `tool_end` 更新块，显示 `• ToolName(params) 2.3s` + 结果摘要。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolStatusLabel } from "../../gui/src/renderer/pages/thinkingText.js";
import { isToolFailResult } from "../../gui/src/renderer/pages/chatProducts.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const LOOP = "core-ts/src/tool_loop.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const CHAT_SVC = "core-ts/src/services/chat.ts";
const IPC = "gui/src/shared/ipc.ts";
const MAIN = "gui/src/main/index.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";

describe("A-1061②-A 状态词：正在执行必须优先于「未记录」", () => {
  it("🐛 running=true 且结果还没到 → 「执行中」（此前返回空串，界面是一行哑行）", () => {
    expect(toolStatusLabel(undefined, false, true)).toBe("执行中");
  });

  it("running 优先于已有结果（收尾那一瞬仍显示执行中，由下一个渲染翻成成功）", () => {
    expect(toolStatusLabel("一切正常", false, true)).toBe("执行中");
  });

  it("**未记录**（非 running）仍返回空串 —— A-1028 的口径不许被这条改动带偏", () => {
    expect(toolStatusLabel(undefined, false)).toBe("");
    expect(toolStatusLabel(undefined, false, false)).toBe("");
    // 非字符串结果同样算"未记录"
    expect(toolStatusLabel(null, false)).toBe("");
  });

  it("已完成：成功 / 失败照旧", () => {
    expect(toolStatusLabel("已写入", false)).toBe("成功");
    expect(toolStatusLabel("[错误] 文件不存在", true)).toBe("失败");
    // isFail 由调用方判定 → 本函数不重复解释文本
    expect(toolStatusLabel("任意文本", true)).toBe("失败");
  });
});

describe("A-1061②-A 失败判定唯一出处（实时行与完成卡共用）", () => {
  it("成功/中性前缀不判失败，错误前缀判失败，空文本不判失败", () => {
    for (const s of ["", "   ", "[已委派] x", "[提示] y", "[成功] z", "[已保存] w", "写好了"]) {
      expect(isToolFailResult(s), `${s} 被误判为失败`).toBe(false);
    }
    for (const s of ["[错误] boom", "[失败] nope", "错误: 路径不存在", "failed to open", "denied", "not found"]) {
      expect(isToolFailResult(s), `${s} 没被判失败`).toBe(true);
    }
  });

  it("🐛 卡片的旧内联判据必须绝迹（两处各写一份必然漂移）", () => {
    const src = code(PANEL);
    expect(src).toContain("const isFail = isToolFailResult(r);");
    expect(src).not.toContain("isSuccessPrefix");
    /* A-1095 #9（返工）迁移：原断言要求**实时摘要行**也走同一判据
       （`isToolFailResult(stripDiffTag(t.result ?? "").trim())`）—— 该摘要块已删除，
       工具状态**只剩**思考历程的工具卡这一个产地，所以判据收敛点也只剩它。
       意图（"判据唯一 + 先剥 diff 标记再判"）逐字保留，改为锁定卡片里那条**链路**：
       `stripDiffTag(rawResult)` → `.trim()` → `isToolFailResult(...)`。
       少了任一段，同一条命令就会在卡片里被判成相反的结果。 */
    expect(src, "卡片必须先剥 diff 标记再判失败").toMatch(/const displayResult = stripDiffTag\(rawResult\);/);
    expect(src, "判据的入参必须是剥完标记并 trim 过的文本").toMatch(/const r = displayResult\.trim\(\);/);
    // 第二个产地不许复活
    expect(src, "重复的「工具调用」摘要块已删除，不许复活").not.toMatch(/const pendingRow = runningTool &&/);
  });
});

describe("A-1061②-B 接线：开始事件 → 配对 → 清行", () => {
  it("工具循环在**执行前**逐个播 tool-start（然后才 Promise.all）", () => {
    const src = code(LOOP);
    expect(src).toContain('onEvent({ type: "tool-start", id: tc.id, name: tc.name, args: tc.arguments ?? "" });');
    const atStart = src.indexOf('onEvent({ type: "tool-start"');
    const atAll = src.indexOf("const results = await Promise.all(");
    expect(atStart, "找不到 tool-start 广播").toBeGreaterThan(-1);
    expect(atAll, "Promise.all 应在开始事件之后").toBeGreaterThan(atStart);
  });

  it("完成事件带上同一个 id（否则界面无法配对，那一行会永远停在执行中）", () => {
    const src = code(LOOP);
    expect(src).toContain('onEvent({ type: "tool", id: tc.id, name: tc.name');
  });

  it("引擎把 tool-start **显式**成一支，并给完成事件带上 toolId", () => {
    const src = code(ENGINE);
    expect(src).toContain('} else if (ev.type === "tool-start") {');
    expect(src).toContain('liveQueue.push({ type: "tool-start", name: ev.name, args: ev.args, toolId: ev.id });');
    const atStart = src.indexOf("ev.type === \"tool-start\"");
    const atElse = src.indexOf('liveQueue.push({ type: "tool", name: ev.name, args: ev.args, result: ev.result, toolId: ev.id });');
    expect(atElse, "tool-start 必须排在 tool 兜底之前").toBeGreaterThan(atStart);
  });

  it("契约类型：EngineChunk / StreamChunk 都认 tool-start 与 toolId", () => {
    expect(code(CHAT_SVC)).toMatch(/type: "chunk"[^;]*"tool-start"/);
    expect(code(CHAT_SVC)).toContain("toolId?: string;");
    expect(code(IPC)).toMatch(/type: "chunk"[^;]*"tool-start"/);
    expect(code(IPC)).toContain("toolId?: string;");
  });

  it("🐛 白名单必须透传 toolId（漏一行 → 界面永远翻不过状态）", () => {
    expect(code(MAIN)).toContain('toolId: typeof d.toolId === "string" ? d.toolId : undefined,');
  });

  it("界面：tool-start 建「执行中」行、完成按 toolId 配对收掉", () => {
    const src = code(PANEL);
    const atStart = src.indexOf('if (c.type === "tool-start" && c.data?.name) {');
    expect(atStart, "onChunk 没有 tool-start 分支").toBeGreaterThan(-1);
    const startBody = src.slice(atStart, atStart + 700);
    expect(startBody).toContain("setRunningTool({");
    // 抓手复用同一套抽取（否则同一条命令在执行中/成功两种行里长得不一样）
    expect(startBody).toContain("detail: extractToolDetail(c.data.args, undefined)");

    const atTool = src.indexOf('if (c.type === "tool" && c.data?.name) {');
    /* ⚠️ 右界必须**动态**取下一个分支 —— 固定 4200 字窗口不够（实测该分支去掉注释后
       仍有 5082 字），会假红。这正是 skill §8.1「窗口边界要比断言粒度更细」的教训。 */
    const atNext = src.indexOf('if (c.type === "reasoning") {', atTool);
    expect(atNext, "取不到 tool 分支的下一个兄弟（右界）").toBeGreaterThan(atTool);
    const toolBody = src.slice(atTool, atNext);
    expect(toolBody).toContain("toolId: typeof c.data.toolId === \"string\" ? c.data.toolId : undefined,");
    expect(toolBody).toContain("setRunningTool((cur) => {");
  });

  it("工具卡渲染逐条状态（调 toolStatusLabel 并带 running）—— **唯一产地**", () => {
    const src = code(PANEL);
    /*
     * A-1095 #9（返工）迁移：本断言原先锚在 `const pendingRow = runningTool && …`——
     * 那是思考卡**下方**由 `toolEvents` 驱动的「工具调用」摘要块（分组计数 + 最近 5 条实时行）。
     * 它是工具状态的**第二个产地**：用户看到的正是它，于是"工具调用挪进时间线"看起来**没有发生**
     * （用户驳回原话：「工具调用和正文怎么还是这个布局？你改了什么？」）。
     * 该块已**删除**；意图（逐条状态由 `toolStatusLabel` 产出、且阶段判据与卡片同源）**逐字保留**，
     * 只是产地从"摘要块"收敛到"思考历程的工具卡"。下面同时锁住"第二条路径不许复活"。
     */
    expect(src, "重复的「工具调用」摘要块必须绝迹（否则工具状态有两个产地）")
      .not.toMatch(/const pendingRow = runningTool &&/);
    expect(src, "「最近 5 条实时行」是第二个产地的特征 —— 不许复活")
      .not.toMatch(/const recent = toolEvents\.slice\(-5\);/);

    const at = src.indexOf("const statusLabel = toolStatusLabel(");
    expect(at, "思考历程的工具卡没有产出状态词").toBeGreaterThan(-1);
    // 右界取**下一个兄弟语句**（skill §17④：固定窗口会因注释变长而假红）
    const end = src.indexOf("const statusTitle =", at);
    expect(end, "取不到工具卡的右界（statusTitle）").toBeGreaterThan(at);
    const body = src.slice(at, end);
    expect(body).toContain("toolStatusLabel(tool.result, isFail, isRunning)");
    /* A-1094：卡片的阶段判据与动画同源（两处各写一份必然漂移）。 */
    expect(body).toContain("toolStatusPhase(tool.result, isRunning)");

    /* 唯一的渲染点：`data-running` / `data-settled` 各只允许出现一次（多一处就是又开了第二产地）。 */
    const count = (needle: string): number => src.split(needle).length - 1;
    expect(count('data-running={statusPhase === "running" ? "1" : undefined}'),
      "工具卡运行态渲染点必须唯一").toBe(1);
    expect(count('data-settled={statusPhase === "settled" ? "1" : undefined}'),
      "工具卡落位渲染点必须唯一").toBe(1);
  });

  it("复位时清掉「执行中」行（否则上一轮的命令会在新一轮里假装在跑）", () => {
    const src = code(PANEL);
    const n = (src.match(/setRunningTool\(null\);/g) ?? []).length;
    // 一处是配对收尾用的函数式返回 null，不算；其余必须是复位点
    expect(n, "复位点太少，可能漏了清").toBeGreaterThanOrEqual(3);
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // "running 不优先" 的实现：正在跑会掉进"未记录 → 空串"
    const wrong = (result: unknown, running: boolean): string => (typeof result === "string" ? "成功" : running ? "" : "");
    expect(wrong(undefined, true)).toBe("");
    expect(toolStatusLabel(undefined, false, true)).toBe("执行中");
  });
});
