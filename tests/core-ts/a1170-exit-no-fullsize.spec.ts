import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");

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















describe("A-1170 退出路径不许回落完整尺寸 / 不许搬动已最小化的图标", () => {
  it("`floatBoxW/H` 走「图标态」判据，且判据含**曾处于图标态**的闩锁", () => {
    expect(APP_CODE, "找不到 floatBoxW 的图标判据").toMatch(/floatIconLike\s*\?/);
    expect(APP_CODE, "退出路径仍可能回落到 floatSize.w —— 完整尺寸会闪一帧")
      .toMatch(/floatWasMinRef/);
    
    expect(APP_CODE, "闩锁没有复位条件 ⇒ restoreFloat 之后浮窗会缩成图标")
      .toMatch(/floatState\s*===\s*"float"\s*\)\s*\{\s*floatWasMinRef\.current\s*=\s*false/);
  });

  it("`floatClosing` 仍是第一优先级（退出时宽度必须 0）", () => {
    expect(APP_CODE, "floatClosing 不再优先 ⇒ 退场收不到 0").toMatch(/floatClosing\s*\?\s*0\s*:/);
  });

  it("`dismissFloat` 对**已最小化**的窗口保持原地，不搬位置", () => {
    const fn = fnBody(APP_CODE, "dismissFloat");
    expect(fn, "dismissFloat 里没有图标判定").toMatch(/FLOAT_ICON_SIZE/);
    
    expect(fn, "仍在无条件把图标搬到中心 ⇒ 退出时会整块位移（实测 628 → 303）")
      .not.toMatch(/const cx = Math\.round\(el\.offsetLeft \+ el\.offsetWidth \/ 2\)/);
  });

  it("⚠️ 完整浮窗的「向中心收拢」行为**必须保留**（不能为了修图标把这条也废掉）", () => {
    


    const fn = fnBody(APP_CODE, "dismissFloat");
    expect(fn, "完整浮窗的向中心收拢被误删").toMatch(/isIcon\s*\?\s*el\.offsetLeft\s*:\s*Math\.round/);
  });
});