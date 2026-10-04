import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");
const CSS_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");






function fnBody(src: string, name: string): string {
  const m = new RegExp("(?:function\\s+|const\\s+|let\\s+|var\\s+)" + name + "\\b").exec(src);
  if (!m) { throw new Error("找不到声明 " + name); }
  const arrow = src.indexOf("=>", m.index);
  const brace = src.indexOf("{", m.index);
  const start = arrow >= 0 && arrow < brace ? arrow : brace;
  let depth = 0, started = false;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) { return src.slice(m.index, j + 1); } }
  }
  throw new Error("函数体未闭合 " + name);
}



















describe("A-1166 `--left-w` 写目标、不写实测（切断观测→写回→再观测的闭环）", () => {
  const sync = fnBody(APP_CODE, "attachLeftWidthObserver");

  it("`--left-w` 写入的是 `sidebarWidthRef`（目标），不是 `getBoundingClientRect()`（实测）", () => {
    expect(sync, "`--left-w` 仍在写实测宽度 ⇒ 闭环未切断，动画中间值会继续逐帧写回")
      .toMatch(/setProperty\(\s*"--left-w"[^\n]*sidebarWidthRef\.current/);
    expect(sync, "`--left-w` 仍从 getBoundingClientRect 取值 ⇒ 写回的是动画中间值")
      .not.toMatch(/setProperty\(\s*"--left-w"[^\n]*getBoundingClientRect/);
  });

  it("保留 ResizeObserver 作为**触发器**（窗口 resize 走 CSS `--sidebar-w`，不经 React state）", () => {
    


    expect(sync, "ResizeObserver 被删了 —— 窗口 resize 后 --left-w 会永久失同步")
      .toMatch(/ResizeObserver/);
  });

  it("只在浮层态同步（普通态不该持有浮层专用变量）", () => {
    expect(sync, "少了浮层态判断 ⇒ 普通态也会残留 --left-w").toMatch(/floatStateRef\.current\s*===\s*"none"/);
  });

  it("`--left-w` 的**逐帧写入点**只剩稳态读值，不许再有动画中间值回写", () => {
    






    const writes = [...APP_CODE.matchAll(/setProperty\(\s*"--left-w"\s*,\s*([^\n;]*)/g)]
      .map((m) => m[1]);
    expect(writes.length, "没找到 `--left-w` 的写入点（守卫失效，需重写）").toBeGreaterThan(0);
    for (const w of writes) {
      expect(w, "`--left-w` 又在写实测派生值 ⇒ 观测→写回→再观测的闭环没切断")
        .not.toMatch(/getBoundingClientRect/);
    }
    
    expect(APP_CODE, "稳态 `--left-w` 读值被误删 —— 窗口 resize 后会永久失同步")
      .toMatch(/leftWNow/);
  });
});