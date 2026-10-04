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
/* ⚠️⚠️⚠️ A-1170：退出路径**不许**把浮窗按完整尺寸渲染，也**不许**把它搬位置。
   用户自检数据（A-1169 生效后剩余的 12 次反转**全部**集中在此，三次操作各命中一次：
   2085 / 4675 / 7179ms），逐帧实测：

       host.left      628 → 630 → 303        host.width  40 → 36 → 598
       host.opacity%  100 → 100 → 100 → 100 → 0

   ⇒ 最小化的浮窗（40px 图标、停在 x=628）退出时，**先按完整浮窗渲染了一帧**
     （598px、跳到默认位置 x=303），**下一帧才淡出**。
   根因两处：
     ① 尺寸：三元 `floatClosing ? 0 : (floatMinIcon || floatAnimOut ? ICON : floatSize.w)`
        在退出流程里存在一帧 `floatClosing` 未置位、`floatMinIcon` 已失效
        ⇒ 三条件同时不成立 ⇒ 落到 `floatSize.w`。
     ② 位置：`dismissFloat` 无条件把元素搬到 `offsetLeft + offsetWidth/2`
        —— 对完整浮窗是"向中心收拢"，对图标则是**整块位移**（实测 628 → 303）。 */
describe("A-1170 退出路径不许回落完整尺寸 / 不许搬动已最小化的图标", () => {
  it("`floatBoxW/H` 走「图标态」判据，且判据含**曾处于图标态**的闩锁", () => {
    expect(APP_CODE, "找不到 floatBoxW 的图标判据").toMatch(/floatIconLike\s*\?/);
    expect(APP_CODE, "退出路径仍可能回落到 floatSize.w —— 完整尺寸会闪一帧")
      .toMatch(/floatWasMinRef/);
    /* ⚠️ 闩锁必须在「回到 float 态」时复位，否则恢复后浮窗永远是图标尺寸。 */
    expect(APP_CODE, "闩锁没有复位条件 ⇒ restoreFloat 之后浮窗会缩成图标")
      .toMatch(/floatState\s*===\s*"float"\s*\)\s*\{\s*floatWasMinRef\.current\s*=\s*false/);
  });

  it("`floatClosing` 仍是第一优先级（退出时宽度必须 0）", () => {
    expect(APP_CODE, "floatClosing 不再优先 ⇒ 退场收不到 0").toMatch(/floatClosing\s*\?\s*0\s*:/);
  });

  it("`dismissFloat` 对**已最小化**的窗口保持原地，不搬位置", () => {
    const fn = fnBody(APP_CODE, "dismissFloat");
    expect(fn, "dismissFloat 里没有图标判定").toMatch(/FLOAT_ICON_SIZE/);
    /* ⚠️ 反向守卫：不能再出现"无条件用 offsetWidth/2 算中心"的那一行。 */
    expect(fn, "仍在无条件把图标搬到中心 ⇒ 退出时会整块位移（实测 628 → 303）")
      .not.toMatch(/const cx = Math\.round\(el\.offsetLeft \+ el\.offsetWidth \/ 2\)/);
  });

  it("⚠️ 完整浮窗的「向中心收拢」行为**必须保留**（不能为了修图标把这条也废掉）", () => {
    /* ⚠️ 反向守卫：上面那条 `not.toMatch` 如果被"一刀切"地实现（例如直接把收拢删掉），
       完整浮窗的退场观感会从"向中心收拢"退化成"原地缩小" —— 那是**另一处**观感回归。
       ⇒ 必须保留三元里的非图标分支。 */
    const fn = fnBody(APP_CODE, "dismissFloat");
    expect(fn, "完整浮窗的向中心收拢被误删").toMatch(/isIcon\s*\?\s*el\.offsetLeft\s*:\s*Math\.round/);
  });
});