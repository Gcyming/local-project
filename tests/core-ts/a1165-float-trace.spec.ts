import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");

/** 剥掉注释再断言。
 *  ⚠️ 为什么必须剥：本模块的注释里**故意**写了 querySelectorAll 通配这个反例
 *  （解释"为什么不用它"），不剥注释的话守卫会把这段说明当成违规代码 ——
 *  这正是「守卫匹配到注释」的假阳性：A-1153 那轮栽在 CSS 选择器上，这次栽在 JS 上。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const TRACE_RAW = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/float-trace.ts"), "utf8");
const TRACE = stripComments(TRACE_RAW);
/* ⚠️⚠️ A-1165：窗口化自检录制器必须**常驻可达**，且**空闲时零开销**。
   这条的存在理由是复盘结论：用户连续五轮报抖动，我提交了五个修复（A-1159/1160/1161/
   1162/1164）**全被推翻** —— 根因不是猜错，而是**测量环境错了**：
   我的探针跑在「隔离 root + 空会话 + 1332px」，用户那边是「真实长会话 + 最大化窗口」。
   空会话挂载是瞬时的、长会话要好几帧 ⇒ 空环境**复现不出**这个问题，
   我却一直用它向你保证"测出来一切正常"。
   ⇒ 必须有一条机制保证「尺子能搬到用户机器上」，否则下一轮还会重复同样的错误。 */
describe("A-1165 窗口化自检录制器（把测量搬到用户真实环境）", () => {

  it("录制器模块存在且导出 `installFloatTrace`", () => {
    expect(TRACE, "录制器文件不见了").toContain("export function installFloatTrace");
  });

  it("App 把它装上了（否则热键永远不生效）", () => {
    expect(APP_CODE, "App.tsx 没有 import/install float-trace").toMatch(/import\s*\{\s*installFloatTrace\s*\}/);
    expect(APP_CODE, "App.tsx 没有调用 installFloatTrace()").toMatch(/installFloatTrace\s*\(\s*\)/);
  });

  it("有热键开关（`Ctrl+Shift+D`），且返回卸载函数（铁律 11：挂了要负责摘）", () => {
    expect(TRACE, "没有热键开关").toMatch(/ctrlKey[\s\S]{0,80}shiftKey/);
    expect(TRACE, "没有返回卸载函数").toMatch(/removeEventListener\(\s*"keydown"/);
  });

  it("**必须**逐帧记录「当前正在跑动画的元素」——这是本录制器最有价值的一列", () => {
    /* ⚠️ 这条是整个录制器的立身之本：A-1162 证明了"进度由外部量反推"是不确定性的来源，
       而"是什么在动、是不是有东西在反复重播"只有这一列能回答。
       ⚠️ 同时**禁止**每帧 `querySelectorAll("*")`：几千个元素会把 App 拖垮，
       录出来的数据本身就不可信了（观测扰动被观测）。 */
    expect(TRACE, "没有 animators() 采集").toMatch(/function animators/);
    expect(TRACE, "animators() 没有过滤 transition/animation").toMatch(/animationName|transitionDuration/);
    expect(TRACE, "animators() 用了全文档遍历 —— 会把 App 拖垮，数据不可信")
      .not.toMatch(/querySelectorAll\(\s*["']\*["']\s*\)/);
  });

  it("**必须**记录「浮窗中心那个点在屏幕上是谁」——用于抓中间那块黑洞", () => {
    expect(TRACE, "没有 elementFromPoint 空洞探测").toMatch(/elementFromPoint/);
  });

  it("摘要必须包含方向反转计数（A-1164 那次整面板由黑变亮就是完全单调的）", () => {
    /* ⚠️ 反向教训：A-1164「整个右栏 opacity 0→1」**没有任何方向反转**，我的"反转检测"
       根本看不见它 —— 恰恰因为它单调才看起来正常。所以摘要除了反转还要报
       opacity / 空洞 / 正在动画的元素这三列。 */
    expect(TRACE, "摘要没有反转分析").toMatch(/function reversals/);
    expect(TRACE, "摘要没报 opacity 取值").toMatch(/opacity 取值/);
    expect(TRACE, "摘要没报正在跑动画的元素").toMatch(/正在跑动画的元素/);
  });

  it("诚实地写明「观测扰动被观测」，并要求录两次（录/不录各一份）", () => {
    /* ⚠️ 这是本模块**最容易被自己骗到**的地方：逐帧 getBoundingClientRect 是强制同步
       布局、getComputedStyle 是强制样式重算。若抖动只在**不录制**时出现，
       这份数据反而会骗人 ⇒ 必须同时录一次、不录一次。
       ⚠️ 这两条断言查的是**注释**，所以必须用**未剥注释**的原文 ——
          上面 TRACE 已剥过注释，用它会把这段说明一起剥没，得到假红。 */
    expect(TRACE_RAW, "没有说明观测扰动").toMatch(/观测扰动被观测/);
    expect(TRACE_RAW, "没有要求录/不录各一份").toMatch(/不录一次/);
  });
});