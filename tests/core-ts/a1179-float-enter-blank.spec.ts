











































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));

describe("A-1179 进入窗口化：容器过渡期**必须不给宽度**（否则容器硬跳、露底 = 一帧黑屏）", () => {
  
  const widthExpr = (): string => {
    const i = APP_CODE.indexOf("width: (mainIsFloatLayout && !rightMin0)");
    expect(i, "取不到 `.right-wrapper` 的 style.width（守卫自己失效了）").toBeGreaterThan(-1);
    

    const end = APP_CODE.indexOf(': "auto") }}', i);
    expect(end, "三元表达式没有按预期闭合").toBeGreaterThan(-1);
    return APP_CODE.slice(i, end + ': "auto") }}'.length);
  };

  it("浮层过渡分支的容器宽度是 `undefined`（⇒ `auto` ⇒ 贴合内容）", () => {
    

    const seg = widthExpr();
    const floatBranch = /mainIsFloatLayout\s*\?\s*\(([\s\S]*?)\)\s*:\s*"auto"/.exec(seg);
    expect(floatBranch, "取不到浮层分支").toBeTruthy();
    expect(floatBranch![1], "浮层过渡分支给了具体宽度 ⇒ 容器硬跳 ⇒ 空白带（一帧黑屏）复现")
      .toMatch(/undefined/);
  });

  it("**退场期必须例外**（`rightExitAnim` 时仍给宽度，否则退出方向反而坏）", () => {
    


    const seg = widthExpr();
    const floatBranch = /mainIsFloatLayout\s*\?\s*\(([\s\S]*?)\)\s*:\s*"auto"/.exec(seg);
    expect(floatBranch![1], "浮层分支里没有 `rightExitAnim` 判断 ⇒ 退场期容器会变内容宽（A-1157-R2 被破坏）")
      .toMatch(/rightExitAnim\s*\?/);
  });

  it("过渡期**内容**宽度仍由 `--right-target-w` 驱动（不能一起改成 undefined）", () => {
    


    const m = /if\s*\(el\s*&&\s*isFloatExpand\)\s*\{[\s\S]*?\n      \}/.exec(APP_CODE);
    expect(m, "取不到写`--right-target-w` 的那段").toBeTruthy();
    expect(m![0], "过渡期不再写 `--right-target-w` ⇒ 内容宽度失去来源")
      .toMatch(/setProperty\("--right-target-w"/);
  });

  it("**不许**给过渡期容器加宽度过渡（实测无效：`auto` 不可插值）", () => {
    


    const m = /if\s*\(el\s*&&\s*isFloatExpand\)\s*\{([\s\S]*?)\n      \}/.exec(APP_CODE);
    expect(m![1], "又出现了 `offsetWidth` 强制同步布局 ⇒ 那套实测无效（空白 662px）")
      .not.toMatch(/offsetWidth/);
    expect(APP_CODE, "又出现了作废的 `--right-wrap-w` ⇒ 那套实测无效")
      .not.toMatch(/--right-wrap-w/);
  });
});