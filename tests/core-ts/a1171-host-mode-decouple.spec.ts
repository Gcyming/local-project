import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");
/* ⚠️⚠️⚠️ A-1171：宿主的**呈现模式**必须与业务状态 `mainIsFloatLayout` **解耦**。
   用户自检数据（1239 帧；A-1169/A-1170 之后剩余的 14 次反转**全部**集中在这个切换点，
   三次操作各命中一次：3618 / 5606 / 7461ms）。那个切换点的逐帧实测：

       host.left=303  host.width=598  main.width=598
       holeAtHostCenter = HOLE:div.msg-row        ← 中心点已是聊天内容，不是浮窗
       host.opacity% 100 → 100 → 0                ← **不透明地**跳了 2 帧才淡出

   ⇒ 单一宿主（A-1158）在退场时被**瞬间**切成内联聊天区：40px 图标 @628 一步跳成
     598px 面板 @303，且是可见地跳。根因：直接用**业务状态**选呈现模式，而
     `setFloatState("none")` 与退场动画收工是两次更新，业务状态先到。 */
describe("A-1171 呈现模式与业务状态解耦（退场收工前不切成内联）", () => {
  it("宿主的 style 走 `hostIsFloat`，**不再**直接用 `mainIsFloatLayout`", () => {
    expect(APP_CODE, "宿主呈现模式又直接绑回业务状态 ⇒ 退场时仍会可见地跳")
      .not.toMatch(/style=\{mainIsFloatLayout\s*\?\s*floatBoxStyle/);
    expect(APP_CODE, "宿主 style 没有走 hostIsFloat").toMatch(/style=\{hostIsFloat\s*\?\s*floatBoxStyle/);
  });

  it("`hostIsFloat` 必须**包含**进场态（否则进场会以内联尺寸闪一帧）", () => {
    /* ⚠️ 只判退场是不够的：进场那一瞬业务状态先到、动画后到，只看 mainIsFloatLayout
       会让宿主先以内联尺寸渲染一帧再跳成浮窗 —— 与退场同一种闪。 */
    expect(APP_CODE, "hostIsFloat 没包含进场态 ⇒ 进场时仍有一帧内联尺寸闪现")
      .toMatch(/hostIsFloat\s*=[^;]*floatAnim\s*===\s*"in"/);
  });

  it("`hostIsFloat` 覆盖 退场 / 最小化 / 进场 三种进行中状态", () => {
    const m = /const\s+hostIsFloat\s*=\s*([^;]+);/.exec(APP_CODE);
    expect(m, "找不到 hostIsFloat 定义").toBeTruthy();
    for (const k of ["mainIsFloatLayout", "floatClosing", "floatAnimOut"]) {
      expect(m![1], `hostIsFloat 少了 ${k} ⇒ 该状态下宿主会提前切成内联`).toMatch(new RegExp(k));
    }
  });

  it("切换发生的时刻浮窗必须是 0×0 且透明（否则解耦没有意义）", () => {
    /* ⚠️ 这是本条成立的前提：只有"退场收工时浮窗已收到 0、opacity 已 0"，
       把切换推迟到那一刻才是**视觉不可见**的。
       ⇒ 依赖 `floatClosing ? 0 :` 这条第一优先级分支。 */
    expect(APP_CODE, "floatClosing 不再优先 ⇒ 推迟切换会换来一个可见的静止浮窗")
      .toMatch(/floatClosing\s*\?\s*0\s*:/);
  });
});