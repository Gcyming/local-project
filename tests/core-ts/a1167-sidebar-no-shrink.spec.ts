import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const CSS_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");


























describe("A-1167 左栏不参与 flex 压缩（瞬时溢出会把左栏挤一下再弹回）", () => {
  const rule = /(^|\n)\.sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
  



  const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");

  it("**内联** `flexShrink` 是 0（这一条才是真正生效的）", () => {
    const aside = /<aside[\s\S]{0,6000}?flexShrink:\s*(\d)/.exec(APP_CODE);
    expect(aside, "找不到左栏 <aside> 的内联 flexShrink —— 守卫失效，需按新结构重写").toBeTruthy();
    expect(aside![1], "左栏内联 flexShrink 必须是 0：内联压过 CSS，A-1167 写在 index.css 的那条")
      .toBe("0");
  });

  it("`.sidebar` 的 CSS 里 `flex-shrink: 0` 仍在（内联缺失时的兜底）", () => {
    expect(rule, "找不到裸 `.sidebar` 规则").toBeTruthy();
    expect(rule![2], "CSS 兜底层不能删").toMatch(/flex-shrink:\s*0/);
  });

  it("`min-width` 仍然保留（不可压缩不等于可以无视下限）", () => {
    expect(rule![2], "min-width 被误删").toMatch(/min-width:\s*240px/);
  });

  it("`.body` 仍允许横向滚动（收缩策略改由左栏的 flex-shrink: 0 承担）", () => {
    

    const body = /(^|\n)\.body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(body![2], ".body 的 overflow-x 被误删 ⇒ 溢出从滚动退化成裁切").toMatch(/overflow-x:\s*auto/);
  });

  it("**诚实边界**：`--left-w` 在浮层态本就不被写入（A-1166 的因果前提不成立）", () => {
    


    expect(CSS_CODE, "`.right-wrapper` 居然在 CSS 里读 `--left-w` —— 与实测数据矛盾，需重新取证")
      .not.toMatch(/var\(--left-w/);
  });
});