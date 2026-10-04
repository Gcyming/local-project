













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
    
    expect(toolStatusLabel(null, false)).toBe("");
  });

  it("已完成：成功 / 失败照旧", () => {
    expect(toolStatusLabel("已写入", false)).toBe("成功");
    expect(toolStatusLabel("[错误] 文件不存在", true)).toBe("失败");
    
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
    





    expect(src, "卡片必须先剥 diff 标记再判失败").toMatch(/const displayResult = stripDiffTag\(rawResult\);/);
    expect(src, "判据的入参必须是剥完标记并 trim 过的文本").toMatch(/const r = displayResult\.trim\(\);/);
    
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
    
    expect(startBody).toContain("detail: extractToolDetail(c.data.args, undefined)");

    const atTool = src.indexOf('if (c.type === "tool" && c.data?.name) {');
    

    const atNext = src.indexOf('if (c.type === "reasoning") {', atTool);
    expect(atNext, "取不到 tool 分支的下一个兄弟（右界）").toBeGreaterThan(atTool);
    const toolBody = src.slice(atTool, atNext);
    expect(toolBody).toContain("toolId: typeof c.data.toolId === \"string\" ? c.data.toolId : undefined,");
    expect(toolBody).toContain("setRunningTool((cur) => {");
  });

  it("工具卡渲染逐条状态（调 toolStatusLabel 并带 running）—— **唯一产地**", () => {
    const src = code(PANEL);
    







    expect(src, "重复的「工具调用」摘要块必须绝迹（否则工具状态有两个产地）")
      .not.toMatch(/const pendingRow = runningTool &&/);
    expect(src, "「最近 5 条实时行」是第二个产地的特征 —— 不许复活")
      .not.toMatch(/const recent = toolEvents\.slice\(-5\);/);

    const at = src.indexOf("const statusLabel = toolStatusLabel(");
    expect(at, "思考历程的工具卡没有产出状态词").toBeGreaterThan(-1);
    
    const end = src.indexOf("const statusTitle =", at);
    expect(end, "取不到工具卡的右界（statusTitle）").toBeGreaterThan(at);
    const body = src.slice(at, end);
    expect(body).toContain("toolStatusLabel(tool.result, isFail, isRunning)");
    
    expect(body).toContain("toolStatusPhase(tool.result, isRunning)");

    
    const count = (needle: string): number => src.split(needle).length - 1;
    expect(count('data-running={statusPhase === "running" ? "1" : undefined}'),
      "工具卡运行态渲染点必须唯一").toBe(1);
    expect(count('data-settled={statusPhase === "settled" ? "1" : undefined}'),
      "工具卡落位渲染点必须唯一").toBe(1);
  });

  it("复位时清掉「执行中」行（否则上一轮的命令会在新一轮里假装在跑）", () => {
    const src = code(PANEL);
    const n = (src.match(/setRunningTool\(null\);/g) ?? []).length;
    
    expect(n, "复位点太少，可能漏了清").toBeGreaterThanOrEqual(3);
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    
    const wrong = (result: unknown, running: boolean): string => (typeof result === "string" ? "成功" : running ? "" : "");
    expect(wrong(undefined, true)).toBe("");
    expect(toolStatusLabel(undefined, false, true)).toBe("执行中");
  });
});
