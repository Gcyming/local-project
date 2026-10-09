



















import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ScreenController } from "../../core-ts/src/screen/controller.js";
import { setImageDiffer, imageDiffRatio } from "../../core-ts/src/screen/optimize.js";
import type {
  DisplayInfo,
  ScreenAction,
  ScreenActionResult,
  ScreenBackend,
  ScreenBackendId,
  ScreenCaptureResult,
  UiElement,
} from "../../core-ts/src/screen/types.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setScreenController, describeVerify } from "../../core-ts/src/tools/builtin.js";
import type { ActionVerify } from "../../core-ts/src/screen/types.js";








const differ = (a: string, b: string): number | null => {
  void a;
  if (b === "boom") { throw new Error("差异度量炸了"); }
  if (b.startsWith("after:")) {
    const v = b.slice("after:".length);
    return v === "null" ? null : Number(v);
  }
  return 1;
};

class FakeBackend implements ScreenBackend {
  readonly id: ScreenBackendId;
  readonly actions = new Set<ScreenAction["kind"]>(["click", "mouse_move", "wait", "scroll", "type"]);
  
  pngs: string[] = ["before", "after:0.5"];
  performed: ScreenAction[] = [];
  captureCalls: Array<{ marks?: boolean } | undefined> = [];
  
  performFailOn = 0;
  
  captureFailOn = 0;
  
  dumpImpl: (() => Promise<UiElement[]>) | null = null;

  
  constructor(id: ScreenBackendId = "desktop") { this.id = id; }

  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: this.id, target: "primary", width: 1000, height: 500, label: "fake" };
  }
  async capture(_target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    this.captureCalls.push(opts);
    if (this.captureFailOn && this.captureCalls.length === this.captureFailOn) {
      return { ok: false, error: "截图失败（模拟）" };
    }
    const png = this.pngs[Math.min(this.captureCalls.length - 1, this.pngs.length - 1)] ?? "P";
    
    return { ok: true, pngBase64: png, dataUrl: `data:image/png;base64,${png}`, width: 1000, height: 500, imageWidth: 1000, imageHeight: 500 };
  }
  async perform(action: ScreenAction): Promise<ScreenActionResult> {
    this.performed.push(action);
    if (this.performFailOn && this.performed.length === this.performFailOn) {
      return { ok: false, error: "动作失败（模拟）" };
    }
    return { ok: true, detail: `did ${action.kind}` };
  }
  async uiDump(): Promise<UiElement[]> {
    if (this.dumpImpl) { return this.dumpImpl(); }
    return [];
  }
}


class NoDumpBackend extends FakeBackend {
  /* 模拟「宿主没有 uiDump」的后端：实例属性**遮蔽**原型方法（运行时即 undefined）。
     基类把它声明为方法 ⇒ 这里的 undefined 需要显式断言盖过类型（测试替身，语义是「属性不存在」）。 */
  uiDump = undefined as unknown as () => Promise<UiElement[]>;
}


class FaultTargetsBackend extends FakeBackend {
  async listTargets(): Promise<DisplayInfo[]> { throw new Error("宿主已退出（模拟）"); }
}

function mk(be: ScreenBackend = new FakeBackend()): { ctl: ScreenController; be: FakeBackend } {
  const ctl = new ScreenController();
  ctl.register(be);
  return { ctl, be: be as FakeBackend };
}


const clickAt = (x = 10, y = 10): ScreenAction => ({ kind: "click", x, y, coordSpace: "device" });

afterEach(() => {
  setImageDiffer(null);      
  setScreenController(null); 
});



describe("A-1123 A 组 — 命中校验：动作有没有真的生效", () => {
  it("A1 画面有变化 ⇒ 命中，且**不重试**（只注入一次）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0.5"];
    const r = await ctl.perform("desktop", clickAt());
    expect(r.ok).toBe(true);
    expect(r.verify?.hit).toBe(true);
    expect(r.verify?.ratio).toBeCloseTo(0.5);
    expect(r.verify?.attempts).toBe(1);
    expect(be.performed).toHaveLength(1);
  });

  it("A2 画面无变化 ⇒ **自动重试一次**（判据本体）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0", "after:0"];
    const r = await ctl.perform("desktop", clickAt());
    expect(be.performed).toHaveLength(2);
    expect(r.verify?.attempts).toBe(2);
    expect(r.verify?.hit).toBe(false);
    expect(r.verify?.note).toMatch(/重试一次后画面仍无可见变化/);
  });

  it("A3 首次未命中、重试后命中 ⇒ hit:true 且说明是第几次才生效", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0", "after:0.4"];
    const r = await ctl.perform("desktop", clickAt());
    expect(be.performed).toHaveLength(2);
    expect(r.verify?.hit).toBe(true);
    expect(r.verify?.ratio).toBeCloseTo(0.4);
    expect(r.verify?.attempts).toBe(2);
    expect(r.verify?.note).toMatch(/自动重试后检测到画面可见变化/);
  });

  it("A4 **没有判据**（未装配差异度量）⇒ 不判负、不重试，回执说「未判定」", async () => {
    const { ctl, be } = mk();
    setImageDiffer(null);
    be.pngs = ["before", "after:0"];
    const r = await ctl.perform("desktop", clickAt());
    expect(r.verify?.ratio).toBeNull();
    expect(r.verify?.hit).toBe(true);
    expect(r.verify?.attempts).toBe(1);
    expect(be.performed).toHaveLength(1);
    expect(r.verify?.note).toMatch(/未做命中判定/);
  });

  it("A5 差异度量抛错 ⇒ 折成「没有判据」（不炸、不重试）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "boom"];
    const r = await ctl.perform("desktop", clickAt());
    expect(r.ok).toBe(true);
    expect(r.verify?.ratio).toBeNull();
    expect(be.performed).toHaveLength(1);
  });

  it("A6 阈值边界：恰好等于阈值算命中，低于阈值算未命中", async () => {
    const hit = mk();
    setImageDiffer(differ);
    hit.be.pngs = ["before", "after:0.002"];
    const r1 = await hit.ctl.perform("desktop", clickAt());
    expect(r1.verify?.hit).toBe(true);
    expect(hit.be.performed).toHaveLength(1);

    const miss = mk();
    setImageDiffer(differ);
    miss.be.pngs = ["before", "after:0.0019", "after:0.0019"];
    const r2 = await miss.ctl.perform("desktop", clickAt());
    expect(r2.verify?.hit).toBe(false);
    expect(miss.be.performed).toHaveLength(2);
  });

  it("A7 `mouse_move` 不做校验（画面本就不该变 ⇒ 纳入只会造假未命中）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0"];
    const r = await ctl.perform("desktop", { kind: "mouse_move", x: 1, y: 1, coordSpace: "device" });
    expect(r.verify).toBeUndefined();
    
    expect(be.captureCalls).toHaveLength(1);
  });

  it("A8 `wait` 不做校验、也不复截", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    
    ctl.noteCaptureBasis("desktop", undefined, 1000, 500, 1000, 500, 0, 0);
    const r = await ctl.perform("desktop", { kind: "wait", durationMs: 1 });
    expect(r.ok).toBe(true);
    expect(r.verify).toBeUndefined();
    expect(be.captureCalls).toHaveLength(0);
  });

  it("A9 关闭动作后复截 ⇒ 跳过校验但**出声**（不说的话「没校验」与「校验通过」又同形）", async () => {
    const { ctl, be } = mk();
    ctl.autoCapture = false;
    setImageDiffer(differ);
    be.pngs = [];
    const r = await ctl.perform("desktop", clickAt());
    expect(r.verify?.ratio).toBeNull();
    expect(r.verify?.note).toMatch(/已关闭动作后复截/);
    expect(be.captureCalls).toHaveLength(0);
    expect(be.performed).toHaveLength(1);
  });

  it("A10 参考图**不污染坐标基准**（按窗口截图后仍按窗口基准折算）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0.5"];
    
    ctl.noteCaptureBasis("desktop", undefined, 200, 100, 1000, 500, 0, 0);
    const r = await ctl.perform("desktop", { kind: "click", x: 100, y: 50 });
    expect(r.ok).toBe(true);
    
    expect(be.performed[0].x).toBe(500);
    expect(be.performed[0].y).toBe(250);
    
    expect(be.captureCalls[0]).toEqual({ marks: false });
  });

  it("A11 未命中**不吞**动作本身的成功（ok 仍为 true，只是多一条校验结论）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0", "after:0"];
    const r = await ctl.perform("desktop", clickAt());
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/did click/);
    expect(r.verify?.hit).toBe(false);
  });

  it("A12 重试时动作本身失败 ⇒ 如实报（不假装校验通过）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0"];
    be.performFailOn = 2;
    const r = await ctl.perform("desktop", clickAt());
    expect(r.ok).toBe(false);
    expect(r.verify?.attempts).toBe(2);
    expect(r.verify?.hit).toBe(false);
    expect(r.verify?.note).toMatch(/重试时动作本身失败/);
  });

  it("A13 参考图取不到 ⇒ 无法比较（不判负、不重试）", async () => {
    const { ctl, be } = mk();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0.5"];
    be.captureFailOn = 1;
    const r = await ctl.perform("desktop", clickAt());
    expect(r.ok).toBe(true);
    expect(r.verify?.ratio).toBeNull();
    expect(r.verify?.note).toMatch(/参考图未取到/);
    expect(be.performed).toHaveLength(1);
  });
});



describe("A-1123 B 组 — uiDump 三态：不支持 / 导出故障 / 导出成功但没有元素", () => {
  it("B1 导出**抛错** ⇒ ok:false 并带原文（旧实现吞成空数组）", async () => {
    const { ctl, be } = mk();
    be.dumpImpl = async () => { throw new Error("uiautomator 挂了（模拟）"); };
    const r = await ctl.uiDump("desktop");
    expect(r.ok).toBe(false);
    expect(r.elements).toEqual([]);
    expect(r.error).toMatch(/uiautomator 挂了/);
  });

  it("B2 导出成功但界面没有可操作元素 ⇒ ok:true + 空数组（**业务态**，不是故障）", async () => {
    const { ctl } = mk();
    const r = await ctl.uiDump("desktop");
    expect(r).toEqual({ ok: true, elements: [] });
  });

  it("B3 后端未注册 ⇒ ok:false 且说明未注册", async () => {
    const ctl = new ScreenController();
    const r = await ctl.uiDump("android");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未注册/);
  });

  it("B4 后端**没有**元素树能力 ⇒ ok:false 且措辞是能力缺失（不是故障）", async () => {
    const { ctl } = mk(new NoDumpBackend());
    const r = await ctl.uiDump("desktop");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没有元素树能力/);
  });

  it("B5 selector 没匹配 ⇒ 「元素定位失败」（存量判据不许变）", async () => {
    const { ctl } = mk();
    const r = await ctl.perform("desktop", { kind: "click", selector: { index: 99 }, coordSpace: "device" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/元素定位失败/);
    
    expect(r.error).toMatch(/已导出 \d+ 个元素/);
  });

  it("B6 导出**故障** ⇒ 措辞与 B5 **不同**（否则模型去改 selector，而坏的是宿主）", async () => {
    const { ctl, be } = mk();
    be.dumpImpl = async () => { throw new Error("dump 命令超时（模拟）"); };
    const r = await ctl.perform("desktop", { kind: "click", selector: { index: 1 }, coordSpace: "device" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/元素层级导出失败/);
    expect(r.error).toMatch(/dump 命令超时/);
    expect(r.error).not.toMatch(/元素定位失败/);
  });

  it("B7 selector 命中 ⇒ 以元素中心作为 device 坐标点击", async () => {
    const { ctl, be } = mk();
    be.dumpImpl = async () => [{
      index: 3, text: "登录", bounds: { x1: 100, y1: 200, x2: 300, y2: 260 }, center: { x: 200, y: 230 }, clickable: true,
    }];
    const r = await ctl.perform("desktop", { kind: "click", selector: { index: 3 }, coordSpace: "device" });
    expect(r.ok).toBe(true);
    expect(be.performed[0].x).toBe(200);
    expect(be.performed[0].y).toBe(230);
    expect(r.detail).toMatch(/按元素 #3/);
  });
});



describe("A-1123 C 组 — listTargetsReport：失败原因不许被吞", () => {
  it("C1 一个后端抛错、另一个正常 ⇒ 失败归集进 failures，正常目标仍在 targets", async () => {
    const ctl = new ScreenController();
    
    ctl.register(new FaultTargetsBackend("desktop"));
    ctl.register(new FakeBackend("android"));
    const rep = await ctl.listTargetsReport();
    expect(rep.targets).toHaveLength(1);
    expect(rep.targets[0].backend).toBe("android");
    expect(rep.failures).toHaveLength(1);
    expect(rep.failures[0].backend).toBe("desktop");
    expect(rep.failures[0].error).toMatch(/宿主已退出/);
  });

  it("C2 全部后端失败 ⇒ targets 空但 failures 逐条说明（不是「没有目标」）", async () => {
    const ctl = new ScreenController();
    ctl.register(new FaultTargetsBackend());
    const rep = await ctl.listTargetsReport();
    expect(rep.targets).toEqual([]);
    expect(rep.failures).toHaveLength(1);
  });

  it("C3 全部正常 ⇒ failures 为空", async () => {
    const { ctl } = mk();
    const rep = await ctl.listTargetsReport();
    expect(rep.failures).toEqual([]);
    expect(rep.targets).toHaveLength(1);
  });
});



describe("A-1123 D 组 — 回执措辞：模型靠这几句话决定下一步", () => {
  const runAction = async (be: FakeBackend, action: ScreenAction): Promise<string> => {
    const ctl = new ScreenController();
    ctl.register(be);
    setScreenController(ctl);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    return await reg.callTool("screen_action", { backend: "desktop", ...action });
  };
  const runDump = async (be: ScreenBackend, args: Record<string, unknown> = {}): Promise<string> => {
    const ctl = new ScreenController();
    ctl.register(be);
    setScreenController(ctl);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    return await reg.callTool("screen_ui_dump", { backend: "desktop", ...args });
  };
  const runInfo = async (be: ScreenBackend): Promise<string> => {
    const ctl = new ScreenController();
    ctl.register(be);
    setScreenController(ctl);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    return await reg.callTool("screen_info", {});
  };

  it("D1 命中 ⇒ 回执里有「命中校验：✓ 命中」", async () => {
    const be = new FakeBackend();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0.5"];
    const out = await runAction(be, clickAt());
    expect(out).toMatch(/命中校验：✓ 命中/);
    expect(out).toMatch(/画面变化 50\.00%/);
  });

  it("D2 未命中 ⇒ 回执里有「✗ 未命中」且给出正确的下一步（重新截图，而非重复同一坐标）", async () => {
    const be = new FakeBackend();
    setImageDiffer(differ);
    be.pngs = ["before", "after:0", "after:0"];
    const out = await runAction(be, clickAt());
    expect(out).toMatch(/命中校验：✗ 未命中/);
    expect(out).toMatch(/重新 screen_capture/);
    expect(out).toMatch(/不要盲目重复同一坐标/);
  });

  it("D3 没有判据 ⇒ 回执说「未判定」，绝不说「未命中」", async () => {
    const be = new FakeBackend();
    setImageDiffer(null);
    be.pngs = ["before", "after:0"];
    const out = await runAction(be, clickAt());
    expect(out).toMatch(/命中校验：未判定/);
    expect(out).not.toMatch(/未命中/);
  });

  it("D4 导出故障 ⇒ [错误]，且**不许**出现「全屏画布」（那是业务态的解释）", async () => {
    const be = new FakeBackend();
    be.dumpImpl = async () => { throw new Error("adb 掉线（模拟）"); };
    const out = await runDump(be);
    expect(out).toMatch(/\[错误\]/);
    expect(out).toMatch(/adb 掉线/);
    expect(out).not.toMatch(/全屏画布/);
  });

  it("D5 导出成功但没元素 ⇒ 提示里必须说「已导出成功」（与故障区分）", async () => {
    const be = new FakeBackend();
    const out = await runDump(be);
    expect(out).toMatch(/导出成功/);
    expect(out).not.toMatch(/\[错误\]/);
  });

  it("D6 桌面窗口级元素 ⇒ 说清粒度是「窗口」，并列出编号与标题", async () => {
    const be = new FakeBackend();
    be.dumpImpl = async () => [
      { index: 1, className: "Window", text: "记事本", bounds: { x1: 0, y1: 0, x2: 800, y2: 600 }, center: { x: 400, y: 300 }, clickable: true, enabled: true },
    ];
    const out = await runDump(be);
    expect(out).toMatch(/粒度是「窗口」/);
    expect(out).toMatch(/#1 .*记事本/);
    expect(out).not.toMatch(/\[错误\]/);
  });

  it("D7 目标枚举失败 ⇒ screen_info 逐条列出原因，且说明不是「没有目标」", async () => {
    const out = await runInfo(new FaultTargetsBackend());
    expect(out).toMatch(/枚举失败/);
    expect(out).toMatch(/宿主已退出/);
    expect(out).toMatch(/不是「没有目标」/);
    
    
    expect(out).not.toMatch(/无可用目标/);
  });

  it("D8 枚举正常 ⇒ 不出现失败字样，照常列目标", async () => {
    const out = await runInfo(new FakeBackend());
    expect(out).toMatch(/目标=primary/);
    expect(out).not.toMatch(/枚举失败/);
  });
});



describe("A-1123 E 组 — 装配点与文案唯一出处", () => {
  
  const codeOf = (rel: string): string =>
    readFileSync(rel, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("E1 主进程**确实装配**了差异度量，且三态判据在位（尺寸不一致→1；解码失败→null）", () => {
    const src = codeOf("gui/src/main/index.ts");
    expect(src).toContain("setImageDiffer(");
    expect(src).toMatch(/sa\.width !== sb\.width/);
    expect(src).toMatch(/if \(sa\.width !== sb\.width \|\| sa\.height !== sb\.height\) \{ return 1; \}/);
    expect(src).toMatch(/if \(ia\.isEmpty\(\) \|\| ib\.isEmpty\(\)\) \{ return null; \}/);
  });

  it("E2 差异度量的比较入口是**唯一实现**（controller 只调 imageDiffRatio，不自己比像素）", () => {
    const ctl = codeOf("core-ts/src/screen/controller.ts");
    expect(ctl).toContain("imageDiffRatio(");
    
    expect(ctl).not.toMatch(/toBitmap|createFromBuffer/);
  });

  it("E3 controller 只用 `backend.capture` 取参考图，且不叠标注", () => {
    const ctl = codeOf("core-ts/src/screen/controller.ts");
    expect(ctl).toMatch(/backend\.capture\(target, \{ marks: false \}\)/);
  });

  it("E4 describeVerify 三分支各自可读（命中 / 未命中 / 未判定）", () => {
    const hit: ActionVerify = { hit: true, ratio: 0.25, attempts: 1, note: "检测到画面可见变化" };
    const miss: ActionVerify = { hit: false, ratio: 0.001, attempts: 2, note: "首次未命中，自动重试一次后画面仍无可见变化" };
    const none: ActionVerify = { hit: true, ratio: null, attempts: 1, note: "未装配画面差异度量" };
    expect(describeVerify(hit)).toMatch(/✓ 命中/);
    expect(describeVerify(miss)).toMatch(/✗ 未命中/);
    
    expect(describeVerify(miss)).toMatch(/重新 screen_capture/);
    expect(describeVerify(miss)).not.toMatch(/未判定/);
    
    const lateHit: ActionVerify = { hit: true, ratio: 0.4, attempts: 2, note: "首次未命中，自动重试后检测到画面可见变化" };
    expect(describeVerify(lateHit)).toMatch(/第 2 次尝试才生效/);
    expect(describeVerify(none)).toMatch(/未判定/);
    expect(describeVerify(none)).not.toMatch(/未命中/);
  });

  it("E5 桌面后端有窗口级元素源，且 capture 会叠窗口编号框（Set-of-Marks 数据源）", () => {
    const d = codeOf("core-ts/src/screen/backends/desktop.ts");
    expect(d).toMatch(/async uiDump\(\): Promise<UiElement\[\]>/);
    expect(d).toContain("marksSpace");
    
    expect(d).toMatch(/x1: w\.x - originX/);
  });

  it("E6 参考图与编号框用的是**不同**坐标空间（判据不许只有一个产地混用）", () => {
    const d = codeOf("core-ts/src/screen/backends/desktop.ts");
    
    expect(d).toMatch(/center: \{ x: Math\.round\(w\.x \+ w\.width \/ 2\), y: Math\.round\(w\.y \+ w\.height \/ 2\) \}/);
    expect(d).toMatch(/x1: w\.x - originX, y1: w\.y - originY/);
  });

  it("E7 imageDiffRatio 的归一化在唯一出口（越界/NaN/异常一律折成 null）", () => {
    setImageDiffer(() => Number.NaN);
    expect(imageDiffRatio("a", "b")).toBeNull();
    setImageDiffer(() => 5);
    expect(imageDiffRatio("a", "b")).toBe(1);
    setImageDiffer(() => -3);
    expect(imageDiffRatio("a", "b")).toBe(0);
    setImageDiffer(() => { throw new Error("x"); });
    expect(imageDiffRatio("a", "b")).toBeNull();
    setImageDiffer(null);
    expect(imageDiffRatio("a", "b")).toBeNull();
    expect(imageDiffRatio(undefined, "b")).toBeNull();
  });
});
