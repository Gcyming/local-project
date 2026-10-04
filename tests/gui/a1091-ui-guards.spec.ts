










import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { stripToolTraceMark } from "../../gui/src/renderer/pages/thinkingText.js";
import { shouldShowStreamCursor, STREAM_CURSOR_IDLE_MS } from "../../gui/src/renderer/pages/streamCursor.js";

const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");


const chatPanel = readSrc("../../gui/src/renderer/pages/ChatPanel.tsx");



describe("A-1091 ① — 每个已注册工具都必须有中文标签 + 专属图标（不许落到兜底）", () => {
  
  const labelKeysOf = (src: string): Set<string> =>
    new Set([...src.matchAll(/(?:^|\n)[ \t]{2}([a-z][a-z0-9_]*):[ \t]*\{[ \t]*label:/g)].map((m) => m[1]));

  
  const registeredToolNames = (): Set<string> => {
    const names = new Set<string>();
    const dir = new URL("../../core-ts/src/tools/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const s = readFileSync(new URL(f, dir), "utf8");
      for (const m of s.matchAll(/name:[ \t]*"([a-z][a-z0-9_]*)"/g)) { names.add(m[1]); }
    }
    return names;
  };

  const labelKeys = labelKeysOf(chatPanel);
  it("T1 **没有任何**已注册工具缺标签（缺了就退化成「⚡ 英文原名」）", () => {
    const missing = [...registeredToolNames()].filter((n) => !labelKeys.has(n)).sort();
    expect(missing, `以下工具缺 TOOL_LABELS 映射，会显示成闪电图标 + 英文原名：${missing.join("、")}`).toEqual([]);
  });

  it("T2 terminal_run 用的是 TerminalIcon（就是图标库里的 terminal.svg），不是兜底的闪电", () => {
    const m = /terminal_run:[ \t]*\{[ \t]*label:[ \t]*"([^"]+)",[ \t]*Icon:[ \t]*([A-Za-z]+)[ \t]*\}/.exec(chatPanel);
    expect(m, "terminal_run 的映射条目必须存在且写成单行形态").toBeTruthy();
    expect(m![2]).toBe("TerminalIcon");
    expect(m![1]).not.toMatch(/^[a-z_]+$/); 
  });

  it("T3 TerminalIcon 真的从 Icon.js 导入（光写映射不导入 = 构建期就报错，但配置稿里看不出来）", () => {
    const importLine = /import \{([^}]+)\} from "\.\.\/components\/Icon\.js"/.exec(chatPanel)?.[1] ?? "";
    expect(importLine).toContain("TerminalIcon");
  });

  it("T4 `delegate:` 归并后的裸键 `delegate` 也登记了（否则工具调用摘要显示英文 `delegate`）", () => {
    expect(labelKeys.has("delegate")).toBe(true);
  });
});



describe("A-1091 ② — `⟳` 是落盘日志标记，界面必须剥掉", () => {
  it("T5 stripToolTraceMark 剥前缀；无标记时原样返回（幂等）", () => {
    expect(stripToolTraceMark("⟳ 执行命令")).toBe("执行命令");
    expect(stripToolTraceMark("⟳  执行命令")).toBe("执行命令");
    expect(stripToolTraceMark("执行命令")).toBe("执行命令");
    expect(stripToolTraceMark(stripToolTraceMark("⟳ 执行命令"))).toBe("执行命令");
    expect(stripToolTraceMark(undefined)).toBe("");
  });

  it("T6 ⚠️ **只剥行首**：工具名里/正文里的 ⟳ 不许被误删", () => {
    expect(stripToolTraceMark("执行 ⟳ 命令")).toBe("执行 ⟳ 命令");
    expect(stripToolTraceMark("a⟳ b")).toBe("a⟳ b");
  });

  it("T7 思考历程的**卡片渲染点**必须调用它（不只依赖产地剥 —— 历史数据已经存进去了）", () => {
    const body = stripComments(chatPanel);
    const card = /className="think-tool-name"[^>]*>\{([^}]+)\}</.exec(body);
    expect(card, "工具卡的名字渲染点必须存在").toBeTruthy();
    expect(card![1]).toContain("stripToolTraceMark");
  });

  it("T8 工具名的每条渲染路径都必须剥标记（旧状：摘要块是第二条路径，已删除）", () => {
    const body = stripComments(chatPanel);
    









    const exprs = [...body.matchAll(/\{([^{}]*\btool\.label\b[^{}]*)\}/g)].map((m) => m[1]);
    expect(exprs.length, "找不到渲染 tool.label 的地方（锚点失效）").toBeGreaterThan(0);
    for (const expr of exprs) {
      expect(expr, `工具名没有剥 ⟳ 标记：{${expr}}`).toContain("stripToolTraceMark");
    }
    
    expect(body, "「工具调用」摘要块已删除，pendingRow 不许复活").not.toMatch(/pendingRow/);
  });

  it("T9 剥法只有一处实现（不许再有内联的 /^⟳\\s*/ 正则）", () => {
    const body = stripComments(chatPanel);
    
    const inlineStrip = [...body.matchAll(/\.replace\(\/\^⟳\\s\*\/,\s*""\)/g)];
    expect(inlineStrip.length, "剥离逻辑必须收敛到 stripToolTraceMark（唯一出处）").toBe(0);
  });
});



describe("A-1091 ③ — 吐字光标：只有真的在吐字才显示", () => {
  it("T10 刚吐过字（间隔 < 阈值）⇒ 显示", () => {
    expect(shouldShowStreamCursor(1_000, 1_000)).toBe(true);
    expect(shouldShowStreamCursor(1_000 + STREAM_CURSOR_IDLE_MS - 1, 1_000)).toBe(true);
  });

  it("T11 【事故本体】停滞超过阈值 ⇒ **隐藏**（真机是卡了 6m49s 仍一直在闪）", () => {
    expect(shouldShowStreamCursor(1_000 + STREAM_CURSOR_IDLE_MS, 1_000)).toBe(false);
    expect(shouldShowStreamCursor(1_000 + 6 * 60_000 + 49_000, 1_000)).toBe(false);
  });

  it("T12 本轮还没吐过任何字（lastEmitAt=0/非法）⇒ 不显示（此时是「正在思考」三点动画）", () => {
    expect(shouldShowStreamCursor(9_999_999, 0)).toBe(false);
    expect(shouldShowStreamCursor(9_999_999, Number.NaN)).toBe(false);
  });

  it("T13 阈值非法 ⇒ 不显示（坏配置不该让光标永远亮着）", () => {
    expect(shouldShowStreamCursor(1_000, 1_000, 0)).toBe(false);
    expect(shouldShowStreamCursor(1_000, 1_000, Number.NaN)).toBe(false);
  });

  it("T14 ⚠️ 时钟回拨（now < lastEmitAt）⇒ 显示（差值负说明刚刚才吐过，不是「很久没吐」）", () => {
    expect(shouldShowStreamCursor(500, 1_000)).toBe(true);
  });

  it("T15 渲染点用判据门控（不许再是无条件那条 span）", () => {
    const body = stripComments(chatPanel);
    expect(body).toMatch(/shouldShowStreamCursor\(Date\.now\(\),\s*lastEmitAtRef\.current\)\s*&&/);
  });

  it("T16 吐字时间戳由**显示层真的推进**来刷新，且复位时清空", () => {
    const body = stripComments(chatPanel);
    expect(body).toMatch(/lastEmitAtRef\.current\s*=\s*now/);
    expect(body).toMatch(/lastEmitAtRef\.current\s*=\s*0/);
  });
});
