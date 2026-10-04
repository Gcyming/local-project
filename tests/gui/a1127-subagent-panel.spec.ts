





















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBAGENT_PANEL_LIMIT,
  latestSubagentRuns,
  subagentPanelCountLabel,
} from "../../gui/src/renderer/pages/subAgentPanel.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const BTN = read("gui/src/renderer/pages/SubAgentExpandButton.tsx");
const BTN_C = strip(BTN);
const PANEL_C = strip(read("gui/src/renderer/pages/ResidentPanel.tsx"));
const STORE_C = strip(read("gui/src/main/subagentStore.ts"));


const RUNS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];

describe("A-1127-A「最多 5 个最新的」——纯判据", () => {
  it("上限就是 5（唯一出处；组件不许自己写 5）", () => {
    expect(SUBAGENT_PANEL_LIMIT).toBe(5);
  });

  it("取的是**最近**的 5 条，且新的在最上面", () => {
    


    expect(latestSubagentRuns(RUNS)).toEqual(["r8", "r7", "r6", "r5", "r4"]);
  });

  it("条数不够时全部给出（不补空位），顺序仍是新的在前", () => {
    expect(latestSubagentRuns(["a", "b"])).toEqual(["b", "a"]);
    expect(latestSubagentRuns(["only"])).toEqual(["only"]);
  });

  it("空 / 非法上限 → 空数组（不抛：这里该是「少显示几条」，不是「把面板炸掉」）", () => {
    expect(latestSubagentRuns([])).toEqual([]);
    expect(latestSubagentRuns(RUNS, 0)).toEqual([]);
    expect(latestSubagentRuns(RUNS, -3)).toEqual([]);
    expect(latestSubagentRuns(RUNS, Number.NaN)).toEqual([]);
    expect(latestSubagentRuns(RUNS, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("limit 大于总数 → 全部（不重复、不补空）", () => {
    expect(latestSubagentRuns(RUNS, 99)).toEqual([...RUNS].reverse());
  });

  it("不修改入参、也不与入参共享数组（面板渲染不该反向污染真源）", () => {
    const src = [...RUNS];
    const out = latestSubagentRuns(src);
    expect(src, "入参被 reverse/slice 就地改动了").toEqual(RUNS);
    expect(out, "返回的是入参的同一个数组实例").not.toBe(src);
  });

  it("计数文案：没被截断就是 (N)，被截断说清 (显示 / 总数)", () => {
    expect(subagentPanelCountLabel(3, 3)).toBe("子代理 (3)");
    expect(subagentPanelCountLabel(12, 5)).toBe("子代理 (5 / 12)");
    expect(subagentPanelCountLabel(0, 0)).toBe("子代理 (0)");
  });
});

describe("A-1127-B 接线：面板取最近 5 条 / 有高度上限 / 设置页不受影响", () => {
  it("组件走**唯一判据**取列表（不再自己 `runs.slice().reverse()` 全量列出）", () => {
    expect(BTN_C, "面板没走 subAgentPanel 的判据 → 又变回全量列出").toContain("latestSubagentRuns(runs)");
    expect(BTN_C, "面板又自己反转全量列表了（那等于没有上限）").not.toContain("runs.slice().reverse()");
    expect(BTN_C, "计数文案没走唯一出处（两处口径迟早分家）").toContain("subagentPanelCountLabel(");
    
    expect(BTN_C, "列表渲染的是全量 runs（上限没接上）").toContain("visible.map((r) => {");
  });

  it("列表有高度上限且超出即滚动（用户：「超过这个上限后这个界面就不在增长，开始滚动」）", () => {
    const listAt = BTN_C.indexOf("data-subagent-panel-list");
    expect(listAt, "找不到面板列表容器（锚点漂移？）").toBeGreaterThan(-1);
    expect(BTN_C, "列表没有 maxHeight → 条目一多就把面板撑长，一直长下去").toContain("maxHeight");
    expect(BTN_C, "列表没有 overflow:auto → 超出的条目直接看不到（用户要的是滚动）").toMatch(/overflow:\s*"auto"/);
  });

  it("⚠️ 设置页的历史**不受**这条上限：它仍展示完整历史", () => {
    

    expect(PANEL_C, "设置页也用了面板的 5 条上限 → 完整历史被静默砍掉").not.toContain("latestSubagentRuns");
    expect(PANEL_C, "设置页引用了面板上限常量").not.toContain("SUBAGENT_PANEL_LIMIT");
    expect(PANEL_C, "设置页列表没走全量 runs 反转渲染").toContain("[...runs].reverse().map((r) => {");
  });

  it("设置页保留**用户可主动删除历史**的入口（用户明确要的那个按钮）", () => {
    expect(PANEL_C, "找不到「清空历史」入口 —— 用户要的「可主动选择删除历史记录」没了").toContain("清空历史");
    expect(PANEL_C, "入口没接 clearRuns → 点了没反应").toContain("onClick={() => void clearRuns()}");
    expect(PANEL_C, "入口没有说明（用户不知道删的是哪一份、能不能恢复）").toContain("title={`清空子代理历史记录");
  });

  it("面板上限 **不许**改到存储层（用户裁决：保持 100 条上限，只靠手动清空）", () => {
    expect(STORE_C, "存储上限被改动了 —— 用户选的是「100 条 + 手动清空」，不是让面板上限去删历史")
      .toContain("export const SUBAGENT_RUN_CAP = 100;");
    
    expect(read("gui/src/main/subagentStore.ts"), "主进程引用了渲染层的面板判据 → 两端口径会耦合")
      .not.toContain("subAgentPanel");
  });
});
