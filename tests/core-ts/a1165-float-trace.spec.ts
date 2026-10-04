import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");





function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const TRACE_RAW = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/float-trace.ts"), "utf8");
const TRACE = stripComments(TRACE_RAW);







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
    



    expect(TRACE, "没有 animators() 采集").toMatch(/function animators/);
    expect(TRACE, "animators() 没有过滤 transition/animation").toMatch(/animationName|transitionDuration/);
    expect(TRACE, "animators() 用了全文档遍历 —— 会把 App 拖垮，数据不可信")
      .not.toMatch(/querySelectorAll\(\s*["']\*["']\s*\)/);
  });

  it("**必须**记录「浮窗中心那个点在屏幕上是谁」——用于抓中间那块黑洞", () => {
    expect(TRACE, "没有 elementFromPoint 空洞探测").toMatch(/elementFromPoint/);
  });

  it("摘要必须包含方向反转计数（A-1164 那次整面板由黑变亮就是完全单调的）", () => {
    


    expect(TRACE, "摘要没有反转分析").toMatch(/function reversals/);
    expect(TRACE, "摘要没报 opacity 取值").toMatch(/opacity 取值/);
    expect(TRACE, "摘要没报正在跑动画的元素").toMatch(/正在跑动画的元素/);
  });

  it("诚实地写明「观测扰动被观测」，并要求录两次（录/不录各一份）", () => {
    




    expect(TRACE_RAW, "没有说明观测扰动").toMatch(/观测扰动被观测/);
    expect(TRACE_RAW, "没有要求录/不录各一份").toMatch(/不录一次/);
  });
});