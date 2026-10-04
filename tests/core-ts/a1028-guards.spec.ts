






















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitToolTrace,
  traceEntriesToToolSteps,
  resolveToolEntry,
  toolStatusLabel,
} from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");
const read = (p: string): string => readFileSync(p, "utf8");



describe("A-1028 ①：工具卡状态词 —— 「结果未记录」不等于「结果为空」", () => {
  it("result 不是字符串（未记录）= 不给任何状态断言", () => {
    expect(toolStatusLabel(undefined, false)).toBe("");
    expect(toolStatusLabel(undefined, true)).toBe("");
    expect(toolStatusLabel(null, false)).toBe("");
    expect(toolStatusLabel(123, false)).toBe("");
  });

  it("result 是字符串才给状态；空串算「有结果」（工具确实返回了空）", () => {
    expect(toolStatusLabel("", false)).toBe("成功");
    expect(toolStatusLabel("[错误] 未找到", true)).toBe("失败");
    expect(toolStatusLabel("ok", false)).toBe("成功");
    expect(toolStatusLabel("\n  \n", false)).toBe("成功");
  });

  it("永不产出「调用中 / 已执行」这类占位状态", () => {
    for (const r of [undefined, null, "", "x", "[失败]"]) {
      const s = toolStatusLabel(r, false);
      expect(s).not.toBe("调用中");
      expect(s).not.toBe("已执行");
    }
  });
});



describe("A-1028 ②：ChatPanel 不得再自己拼状态词", () => {
  const src = read(CHAT_PANEL);

  it("状态词取自纯模块 toolStatusLabel(…)", () => {
    

    expect(src).toContain("const statusLabel = toolStatusLabel(tool.result, isFail, isRunning);");
    
    expect(src).not.toContain("const statusLabel = !r ?");
    expect(src).not.toContain('const statusLabel = !r ? (isWrite ? "已执行"');
  });

  it("状态列为空时整列省略（不留一条空白对齐位）", () => {
    



    expect(src).toContain('{statusPhase !== "none" && (');
    expect(src).toContain('className="think-tool-status"');
    

    expect(src).toContain('data-running={statusPhase === "running" ? "1" : undefined}');
    expect(src).toContain('data-settled={statusPhase === "settled" ? "1" : undefined}');
  });

  it("结果未记录时 title 要讲清「为什么没有状态」（不然像坏掉了）", () => {
    

    expect(src).toContain("const statusTitle = isRunning");
    expect(src).toContain("未随记录保存");
  });
});



describe("A-1028 ③：onDone 的时间线不许被门丢掉、也不许挂在 stages 之下落盘", () => {
  const src = read(CHAT_PANEL);

  it("stages 的门把 finalTimeline 算在内（否则带结果的真时间线被整个丢掉）", () => {
    expect(src).toMatch(/const stages = finalReasoning \|\| doneTools\.length > 0 \|\| finalTimeline\.length > 0\s*\r?\n\s*\? \{ reads, urls, tools: doneTools/);
    
    expect(src).not.toMatch(/const stages = finalReasoning \|\| doneTools\.length > 0\s*\r?\n\s*\? \{ reads/);
  });

  it("落盘判据直接用 finalTimeline（不再借道 stages）", () => {
    expect(src).toMatch(/if \(finalTimeline\.length > 0\) \{\s*\r?\n\s*const attachApi = [\s\S]{0,400}?attachTimeline\?\.\(agentId, sessionRef\.current, finalTimeline as unknown\[\]\)/);
  });

  it("空数组落盘分支已删（attachTimelineToRecord 对空数组直接 return false，那是个假承诺）", () => {
    expect(src).not.toMatch(/attachTimeline\?\.\(agentId, sessionRef\.current, \[\]\)/);
    expect(src).not.toMatch(/if \(stages\?\.timeline\?\.length\) \{\s*\r?\n\s*const attachApi/);
  });

  it("流式时间线为空时有兜底重建（用 done 载荷文本重解析，不另造第二份解析）", () => {
    expect(src).toMatch(/if \(finalTimeline\.length === 0\) \{\s*\r?\n\s*const seedTrace = splitToolTrace\(finalReasoning \?\? ""\);/);
    expect(src).toMatch(/traceEntriesToToolSteps\(seedTrace\.traces, matchToolLabel, doneTools\)/);
  });
});



describe("A-1028 ④：只有 `### 工具调用记录` 的历史记录，渲染出的工具卡不带任何状态词", () => {
  
  const REASONING = [
    "用户说「存在部分镜像无法连接」。我得逐个实测。",
    "",
    "实测结果：z-lib.li 连不上，z-lib.ac / z-lib.cc 能开。",
    "",
    "### 工具调用记录",
    "- ⟳ 网页抓取",
    "- ⟳ 网页抓取",
    "- ⟳ 写入文件",
    "- ⟳ http_serve",
    "- ⟳ screen_capture",
  ].join("\n");

  const LOOKUP: Record<string, { label: string }> = {
    web_fetch: { label: "网页抓取" },
    file_write: { label: "写入文件" },
    screen_capture: { label: "屏幕截图" },
  };

  it("工具块解析成 tool 节点，且这些节点一律没有 result（所以不该有状态词）", () => {
    const trace = splitToolTrace(REASONING);
    
    
    
    const steps = traceEntriesToToolSteps(trace.traces, (e) => resolveToolEntry(e, LOOKUP), []);
    expect(steps.map((s) => s.label)).toEqual(["网页抓取", "网页抓取", "写入文件", "http_serve", "屏幕截图"]);
    
    for (const s of steps) {
      expect(Object.prototype.hasOwnProperty.call(s, "result"), "回退节点不许带 result（带了才是说谎）").toBe(false);
      expect(toolStatusLabel(undefined, false)).toBe("");
    }
  });

  it("正文没被工具块的解析吃掉（A-1027 的无损约束仍然成立）", () => {
    const trace = splitToolTrace(REASONING);
    expect(trace.text).toContain("z-lib.ac / z-lib.cc 能开");
    expect(trace.text).not.toContain("工具调用记录");
  });
});
