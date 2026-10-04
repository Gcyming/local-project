import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const CSS_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");
/* ⚠️⚠️⚠️ A-1167：左栏**不许**参与 flex 压缩（`flex-shrink: 0`）。
   六轮抖动的真正源头。用户自检数据（Ctrl+Shift+D，真实会话，逐帧实测）：

     sb.width      303 → **247** → 303       ← 硬跳一帧，再靠 0.5s 过渡弹回
     rw.width      1029 → 1085 → 1029        ← = 1332 − sb.width，**完全等价**
     rs.left       303 → 247 → 455
     host.left     628 → 630 → 303
     host.width    40 → 36 → 598
     chat.clientW  448 → 380 → 665

   `rw.width` 恒等于 `vw − sb.width` ⇒ 右栏宽度**不是 JS 算的**，而是 flexbox
   自动吃剩余空间的结果 ⇒ 其余五列全是左栏的下游，**只有左栏自己是因**。

   机制：`.sidebar` 只有 `width` / `min-width` / `max-width`，**没有** `flex-shrink`
   ⇒ 默认 1 ⇒ `.body` 出现**瞬时溢出**时（典型：`.main` 还没塌到 0 而右栏已就位，
   那一帧总需求超过容器）浏览器就去挤最可挤的 flex item ⇒ 左栏短一帧；
   约束一解除，左栏靠常驻的 `transition: width 0.5s` 平滑弹回 ⇒ **一来一回 = 抽搐**。

   ⚠️ `min-width: 240px` 挡不住：实测 247 > 240，浏览器只是**少挤一点**，并未停止挤压。
   ⚠️ 与 A-1156 已记的死循环同源：那里的后果是左栏被压到 ~1px；这里的后果是
      "挤一下再弹回"，症状轻得多，所以五轮都没被认出来。

   ⚠️⚠️ **同时否证了 A-1166**：那份数据里 `--left-w` **全程 0 次写入** ——
      该变量在浮层态根本没被用过，"观测→写回→再观测的闭环"并不存在。
      A-1166 那条把反馈环的力气用在了不存在的地方（它本身的写法仍是对的：
      写目标值而不是写动画中间值），但**不是本问题的成因**。 */
describe("A-1167 左栏不参与 flex 压缩（瞬时溢出会把左栏挤一下再弹回）", () => {
  const rule = /(^|\n)\.sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);

  it("`.sidebar` 声明 `flex-shrink: 0`", () => {
    expect(rule, "找不到裸 `.sidebar` 规则").toBeTruthy();
    expect(rule![2], "左栏必须 flex-shrink: 0 —— 否则瞬时溢出会把它挤一下再弹回（= 抽搐）")
      .toMatch(/flex-shrink:\s*0/);
  });

  it("`min-width` 仍然保留（不可压缩不等于可以无视下限）", () => {
    expect(rule![2], "min-width 被误删").toMatch(/min-width:\s*240px/);
  });

  it("`.body` 仍允许横向滚动（收缩策略改由左栏的 flex-shrink: 0 承担）", () => {
    /* ⚠️ 反向守卫：有人可能想把 `overflow-x: auto` 去掉来"防止溢出"——
       那会让溢出变成裁切，症状更糟。真正的解法是**不让左栏被挤**。 */
    const body = /(^|\n)\.body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(body![2], ".body 的 overflow-x 被误删 ⇒ 溢出从滚动退化成裁切").toMatch(/overflow-x:\s*auto/);
  });

  it("**诚实边界**：`--left-w` 在浮层态本就不被写入（A-1166 的因果前提不成立）", () => {
    /* ⚠️ 这条不是功能守卫，是**记录一条被否证的因果链**，防止后来者重蹈：
       A-1166 认定 `--left-w` 逐帧回写实测值形成闭环，但实测数据里该变量全程为 `-`
       （从未写入）⇒ 闭环不存在。真正的耦合是 **flexbox 的剩余空间分配**，纯结构性。 */
    expect(CSS_CODE, "`.right-wrapper` 居然在 CSS 里读 `--left-w` —— 与实测数据矛盾，需重新取证")
      .not.toMatch(/var\(--left-w/);
  });
});