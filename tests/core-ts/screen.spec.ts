/**
 * tests/core-ts/screen.spec.ts — 图形控制能力（screen_*）回归测试。
 *
 * 覆盖：
 *  - 坐标归一化缩放（toPixel）：0-1000 → 像素 / absolute 直通 / 越界夹取
 *  - ScreenController：后端注册与枚举、不支持动作拒绝、紧急停止、互斥串行、动作后复截
 *  - AndroidScreenBackend：动作 → adb shell 命令映射（tap/swipe/text/key/long_press/scroll/type）
 *  - AndroidScreenBackend：分辨率解析（Override 优先于 Physical）
 *  - 工具注册表：riskKind / effectiveRiskKind / autoApprovable 默认值 + 类别闸门
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { toPixel, NORMALIZED_MAX, coordToDeviceInRegion } from "../../core-ts/src/screen/types.js";
import { ScreenController } from "../../core-ts/src/screen/controller.js";
import { AndroidScreenBackend, parseUiHierarchy, type AdbLike } from "../../core-ts/src/screen/backends/android.js";
import type {
  DisplayInfo,
  ScreenAction,
  ScreenActionResult,
  ScreenBackend,
  ScreenCaptureResult,
} from "../../core-ts/src/screen/types.js";
import { Tool, ToolRegistry, setToolCategoryGate } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools } from "../../core-ts/src/tools/builtin.js";

/* ───────────────────────── toPixel ───────────────────────── */

describe("screen/toPixel — 归一化坐标缩放", () => {
  it("0-1000 归一化 → 像素（按分辨率等比）", () => {
    expect(toPixel(0, 1920, false)).toBe(0);
    expect(toPixel(500, 1920, false)).toBe(960);
    expect(toPixel(1000, 1920, false)).toBe(1920);
    expect(toPixel(500, 1080, false)).toBe(540);
  });

  it("absolute=true 时按像素直通", () => {
    expect(toPixel(960, 1920, true)).toBe(960);
    expect(toPixel(1234, 100, true)).toBe(1234);
  });

  it("越界的归一化值被夹取到 [0, 1000]", () => {
    expect(toPixel(-50, 1000, false)).toBe(0);
    expect(toPixel(9999, 1000, false)).toBe(NORMALIZED_MAX);
  });

  it("非有限值返回 undefined", () => {
    expect(toPixel(undefined, 1000, false)).toBeUndefined();
    expect(toPixel(Number.NaN, 1000, false)).toBeUndefined();
  });
});

/* ───────────────────────── 假后端 ───────────────────────── */

class FakeBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click", "type"]);
  performed: ScreenAction[] = [];
  captureCount = 0;
  failNext = false;

  async listTargets(): Promise<DisplayInfo[]> {
    return [await this.displayInfo()];
  }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "desktop", target: "primary", width: 1000, height: 500, label: "fake" };
  }
  async capture(): Promise<ScreenCaptureResult> {
    this.captureCount++;
    // A-975：图像尺寸（模型所见）与设备物理尺寸故意不同（200×100 → 1000×500），
    // 用于验证「镜像坐标按比例折算」而非拿图像坐标当物理坐标。
    return { ok: true, pngBase64: "AAA", dataUrl: "data:image/png;base64,AAA", width: 1000, height: 500, imageWidth: 200, imageHeight: 100, bytes: 2 };
  }
  async perform(action: ScreenAction): Promise<ScreenActionResult> {
    if (this.failNext) { return { ok: false, error: "boom" }; }
    this.performed.push(action);
    return { ok: true, detail: `did ${action.kind}` };
  }
}

/* ───────────────────────── ScreenController ───────────────────────── */

describe("ScreenController — 后端分发 / 能力校验 / 互斥 / 紧急停止", () => {
  let ctl: ScreenController;
  let be: FakeBackend;

  beforeEach(() => {
    ctl = new ScreenController();
    be = new FakeBackend();
    ctl.register(be);
  });

  it("注册后可枚举后端", () => {
    expect(ctl.listBackends()).toEqual(["desktop"]);
    expect(ctl.has("desktop")).toBe(true);
    expect(ctl.has("android")).toBe(false);
  });

  it("未注册后端 → 明确报错（不静默失败）", async () => {
    await expect(ctl.displayInfo("android")).rejects.toThrow(/不可用/);
  });

  it("后端不支持的动作 → 拒绝并列出支持集", async () => {
    const r = await ctl.perform("desktop", { kind: "scroll", x: 0, y: 0, delta: -100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不支持动作 'scroll'/);
    expect(r.error).toMatch(/click/);
    expect(be.performed).toHaveLength(0);
  });

  it("A-975 默认 image 语义：截图后按「图像尺寸→设备分辨率」比例折算", async () => {
    await ctl.capture("desktop"); // 记录基准：图像 200×100 → 设备 1000×500（比例 5）
    await ctl.perform("desktop", { kind: "click", x: 100, y: 50 });
    expect(be.performed[0].x).toBe(500); // 100 × (1000/200)
    expect(be.performed[0].y).toBe(250); // 50  × (500/100)
    expect(be.performed[0].absolute).toBe(true);
  });

  it("A-1014 无截图基准 + image 语义 → 明确报错（不再静默按 1:1 当物理像素）", async () => {
    const ctl2 = new ScreenController();
    const be2 = new FakeBackend();
    ctl2.register(be2);
    const r = await ctl2.perform("desktop", { kind: "click", x: 500, y: 500 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/坐标基准缺失/);
    // 关键：绝不能把 image 坐标当物理坐标下发（改前就是这么静默点掉 (500,500) 的）
    expect(be2.performed).toHaveLength(0);
  });

  it("A-1014 显式 coordSpace=device 时不依赖基准（物理像素本就无需换算）", async () => {
    const ctl2 = new ScreenController();
    const be2 = new FakeBackend();
    ctl2.register(be2);
    const r = await ctl2.perform("desktop", { kind: "click", x: 500, y: 500, coordSpace: "device" });
    expect(r.ok).toBe(true);
    expect(be2.performed[0].x).toBe(500);
    expect(be2.performed[0].y).toBe(500);
  });

  it("coordSpace=normalized 显式 0-1000 语义仍按分辨率缩放", async () => {
    await ctl.capture("desktop"); // A-1014：缩放离开截图基准无从解释，先建立基准
    await ctl.perform("desktop", { kind: "click", x: 500, y: 500, coordSpace: "normalized" });
    expect(be.performed[0].x).toBe(500); // 1000 宽 × 500/1000
    expect(be.performed[0].y).toBe(250); // 500 高 × 500/1000
  });

  it("absolute=true（等价 device 语义）时不缩放", async () => {
    await ctl.perform("desktop", { kind: "click", x: 321, y: 123, absolute: true });
    expect(be.performed[0].x).toBe(321);
    expect(be.performed[0].y).toBe(123);
  });

  it("动作成功后自动复截一次", async () => {
    await ctl.capture("desktop"); // 建立坐标基准（A-1014 后 image 语义必须先有基准）
    const r = await ctl.perform("desktop", { kind: "click", x: 1, y: 1 });
    expect(r.ok).toBe(true);
    expect(r.capture?.ok).toBe(true);
    expect(be.captureCount).toBe(2); // 1 次显式建立基准 + 1 次动作后复截
  });

  it("wait 动作不复截", async () => {
    const c2 = new ScreenController();
    const waitBe = new FakeBackend();
    // 注意：不能写 `{ ...waitBe }` —— 类方法是原型属性，展开会丢（旧写法因此一直在空转）
    waitBe.actions.clear();
    waitBe.actions.add("wait");
    c2.register(waitBe);
    await c2.capture("desktop"); // 建立基准，确保真的走到了 perform 分支
    const before = waitBe.captureCount;
    const r = await c2.perform("desktop", { kind: "wait", durationMs: 1 });
    expect(r.ok).toBe(true);
    expect(waitBe.performed).toHaveLength(1); // 动作确实下发了（不是被基准检查提前拦掉）
    expect(waitBe.captureCount).toBe(before); // 且 wait 不触发复截
  });

  it("动作失败时不复截", async () => {
    await ctl.capture("desktop");
    be.failNext = true;
    const r = await ctl.perform("desktop", { kind: "click", x: 1, y: 1 });
    expect(r.ok).toBe(false);
    expect(be.captureCount).toBe(1); // 只有建立基准那一次，失败动作不再复截
    expect(r.capture).toBeUndefined();
  });

  it("紧急停止后拒绝后续动作，resume 后恢复", async () => {
    await ctl.capture("desktop"); // 基准先备好：halt 只拦动作，不该与坐标基准混淆
    ctl.halt();
    expect(ctl.isHalted()).toBe(true);
    const r1 = await ctl.perform("desktop", { kind: "click", x: 1, y: 1 });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/紧急停止/);
    ctl.resume();
    const r2 = await ctl.perform("desktop", { kind: "click", x: 1, y: 1 });
    expect(r2.ok).toBe(true);
  });

  it("并发提交的动作被串行化（互斥锁），不交错执行", async () => {
    const order: string[] = [];
    const seq = new ScreenController();
    const slow: ScreenBackend = {
      id: "desktop",
      actions: new Set<ScreenAction["kind"]>(["click", "type"]),
      listTargets: async () => [],
      displayInfo: async () => ({ backend: "desktop", target: "p", width: 100, height: 100, label: "s" }),
      capture: async () => ({ ok: true, dataUrl: "data:image/png;base64,AA", width: 100, height: 100, imageWidth: 100, imageHeight: 100 }),
      perform: async (a: ScreenAction) => {
        order.push(`${a.kind}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${a.kind}:end`);
        return { ok: true };
      },
    } as unknown as ScreenBackend;
    seq.register(slow);
    seq.autoCapture = false;
    await seq.capture("desktop"); // A-1014：建立基准，动作才会真正下发给后端
    await Promise.all([
      seq.perform("desktop", { kind: "click", x: 1, y: 1 }),
      seq.perform("desktop", { kind: "type", text: "a" }),
    ]);
    // 严格 start→end→start→end，不出现 start:start 交错
    expect(order).toEqual(["click:start", "click:end", "type:start", "type:end"]);
  });
});

/* ───────────────────────── AndroidScreenBackend ───────────────────────── */

/** 记录所有下发到设备的命令 */
class FakeAdb implements AdbLike {
  calls: string[] = [];
  wmSizeReply = "Physical size: 1080x2400";
  async devices() {
    return { ok: true, devices: [{ serial: "emulator-5554", state: "device", model: "Pixel_7" }] };
  }
  async shell(_serial: string, cmd: string) {
    this.calls.push(cmd);
    if (cmd === "wm size") { return { ok: true, stdout: this.wmSizeReply }; }
    if (cmd.startsWith("getprop")) { return { ok: true, stdout: "Pixel_7\n" }; }
    return { ok: true, stdout: "ok" };
  }
  async screencap() {
    this.calls.push("__screencap__");
    return { ok: true, pngBase64: "iVBORw0KGgo=" };
  }
}

describe("AndroidScreenBackend — 动作 → adb shell 命令映射", () => {
  let adb: FakeAdb;
  let be: AndroidScreenBackend;

  beforeEach(() => {
    adb = new FakeAdb();
    be = new AndroidScreenBackend(adb);
  });

  it("click → input tap x y", async () => {
    await be.perform({ kind: "click", x: 300, y: 500, absolute: true }, "emulator-5554");
    expect(adb.calls).toContain("input tap 300 500");
  });

  it("long_press → 同点 input swipe 且时长下限 500ms", async () => {
    await be.perform({ kind: "long_press", x: 10, y: 20, absolute: true, durationMs: 100 }, "s");
    expect(adb.calls).toContain("input swipe 10 20 10 20 500");
  });

  it("swipe → input swipe x1 y1 x2 y2 duration", async () => {
    await be.perform({ kind: "swipe", x: 0, y: 0, x2: 100, y2: 200, absolute: true, durationMs: 400 }, "s");
    expect(adb.calls).toContain("input swipe 0 0 100 200 400");
  });

  it("swipe 缺少终点 → 明确报错，不下发命令", async () => {
    const r = await be.perform({ kind: "swipe", x: 0, y: 0, absolute: true }, "s");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/x2/);
    expect(adb.calls).toHaveLength(0);
  });

  it("type → input text 且空格转义为 %s、单引号安全转义", async () => {
    await be.perform({ kind: "type", text: "hello world" }, "s");
    expect(adb.calls).toContain("input text 'hello%sworld'");

    adb.calls = [];
    await be.perform({ kind: "type", text: "it's ok" }, "s");
    expect(adb.calls[0]).toBe("input text 'it'\\''s%20ok'".replace("%20", "%s"));
  });

  it("key → input keyevent KEYCODE_xxx（别名与单字母均可）", async () => {
    await be.perform({ kind: "key", key: "BACK" }, "s");
    expect(adb.calls).toContain("input keyevent KEYCODE_BACK");

    adb.calls = [];
    await be.perform({ kind: "key", key: "home" }, "s");
    expect(adb.calls).toContain("input keyevent KEYCODE_HOME");

    adb.calls = [];
    await be.perform({ kind: "key", key: "a" }, "s");
    expect(adb.calls).toContain("input keyevent KEYCODE_A");
  });

  it("无法识别的按键 → 报错且不下发", async () => {
    const r = await be.perform({ kind: "key", key: "!!!badkey" }, "s");
    expect(r.ok).toBe(false);
    expect(adb.calls).toHaveLength(0);
  });

  it("scroll → 纵向 input swipe（delta 正负决定方向）", async () => {
    const info = await be.displayInfo("s");
    await be.perform({ kind: "scroll", x: 500, y: 1200, delta: -100, absolute: true }, "s", info);
    const last = adb.calls[adb.calls.length - 1];
    expect(last).toMatch(/^input swipe 500 \d+ 500 \d+ 200$/);
  });

  it("不支持的动作（right_click）→ 明确报错", async () => {
    const r = await be.perform({ kind: "right_click", x: 1, y: 1, absolute: true }, "s");
    expect(r.ok).toBe(false);
    expect(adb.calls).toHaveLength(0);
  });

  it("desktop 专属动作不在能力集里", () => {
    expect(be.actions.has("mouse_move")).toBe(false);
    expect(be.actions.has("right_click")).toBe(false);
    expect(be.actions.has("tap")).toBe(true);
  });
});

describe("AndroidScreenBackend — 分辨率解析", () => {
  it("Override size 优先于 Physical size", async () => {
    const adb = new FakeAdb();
    adb.wmSizeReply = "Physical size: 1080x2400\nOverride size: 720x1280";
    const be = new AndroidScreenBackend(adb);
    const info = await be.displayInfo("s");
    expect(info.width).toBe(720);
    expect(info.height).toBe(1280);
  });

  it("只有 Physical size 时用它", async () => {
    const adb = new FakeAdb();
    adb.wmSizeReply = "Physical size: 1080x2400";
    const be = new AndroidScreenBackend(adb);
    const info = await be.displayInfo("s");
    expect(info.width).toBe(1080);
    expect(info.height).toBe(2400);
  });

  it("解析失败 → 明确报错", async () => {
    const adb = new FakeAdb();
    adb.wmSizeReply = "unknown";
    const be = new AndroidScreenBackend(adb);
    await expect(be.displayInfo("s")).rejects.toThrow(/无法解析设备分辨率/);
  });

  it("无设备时 listTargets 返回空数组", async () => {
    const adb: AdbLike = {
      devices: async () => ({ ok: true, devices: [{ serial: "x", state: "offline" }] }),
      shell: async () => ({ ok: true, stdout: "" }),
      screencap: async () => ({ ok: true }),
    };
    const be = new AndroidScreenBackend(adb);
    expect(await be.listTargets()).toEqual([]);
  });
});

/* ───────────────────────── 工具注册表：风险自述 + 类别闸门 ───────────────────────── */

describe("ToolRegistry — riskKind / autoApprovable / 类别闸门", () => {
  it("缺省 riskKind 由 permissions 推导（取最高风险类别）", () => {
    expect(new Tool({ name: "a", description: "", parameters: {}, executeFn: async () => "" }).effectiveRiskKind()).toBe("read");
    expect(new Tool({ name: "b", description: "", parameters: {}, executeFn: async () => "", permissions: ["write"] }).effectiveRiskKind()).toBe("write");
    expect(new Tool({ name: "c", description: "", parameters: {}, executeFn: async () => "", permissions: ["read", "network"] }).effectiveRiskKind()).toBe("network");
    expect(new Tool({ name: "d", description: "", parameters: {}, executeFn: async () => "", permissions: ["write", "terminal"] }).effectiveRiskKind()).toBe("terminal");
  });

  it("显式 riskKind 优先于 permissions 推导", () => {
    const t = new Tool({ name: "e", description: "", parameters: {}, executeFn: async () => "", permissions: ["write", "network"], riskKind: "write" });
    expect(t.effectiveRiskKind()).toBe("write");
  });

  it("autoApprovable 缺省为 false（fail-closed）", () => {
    expect(new Tool({ name: "f", description: "", parameters: {}, executeFn: async () => "" }).autoApprovable).toBe(false);
    expect(new Tool({ name: "g", description: "", parameters: {}, executeFn: async () => "", autoApprovable: true }).autoApprovable).toBe(true);
  });

  it("类别闸门拒绝时 callTool 不执行并把原因回传", async () => {
    const reg = new ToolRegistry();
    let ran = false;
    reg.register(new Tool({
      name: "danger", description: "", parameters: {},
      executeFn: async () => { ran = true; return "done"; },
      permissions: ["terminal"],
    }));
    setToolCategoryGate((tool) => (tool.name === "danger" ? { allowed: false, reason: "「终端」类别已关闭" } : { allowed: true }));
    const r = await reg.callTool("danger", {});
    expect(ran).toBe(false);
    expect(r).toMatch(/权限已关闭/);
    expect(r).toMatch(/终端/);
    setToolCategoryGate(null);
  });

  it("闸门放行时正常执行；清除闸门后恢复", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "ok", description: "", parameters: {}, executeFn: async () => "executed" }));
    setToolCategoryGate(() => ({ allowed: true }));
    expect(await reg.callTool("ok", {})).toBe("executed");
    setToolCategoryGate(null);
    expect(await reg.callTool("ok", {})).toBe("executed");
  });

  it("闸门自身抛异常不阻断调用（fail-open 仅在闸门故障时）", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "z", description: "", parameters: {}, executeFn: async () => "ok" }));
    setToolCategoryGate(() => { throw new Error("gate broken"); });
    expect(await reg.callTool("z", {})).toBe("ok");
    setToolCategoryGate(null);
  });
});

/* ───────────────────────── 内置工具的风险声明（防 A-918++ 分类失配回归） ───────────────────────── */

describe("内置工具风险声明 — 高风险动作必须不可自动放行", () => {
  let reg: ToolRegistry;

  beforeEach(() => {
    reg = new ToolRegistry();
    registerBuiltinTools(reg);
  });

  const expectTool = (name: string, kind: string, auto: boolean): void => {
    const t = reg.get(name);
    expect(t, `工具 ${name} 应已注册`).toBeTruthy();
    expect(t!.effectiveRiskKind(), `${name} 的 riskKind`).toBe(kind);
    expect(t!.autoApprovable, `${name} 的 autoApprovable`).toBe(auto);
  };

  it("只读工具 → read 类（分类器对 read 类直接放行，无需 autoApprovable）", () => {
    for (const n of ["file_read", "file_list", "code_check", "memory_search", "todo_write", "adb_devices", "adb_screencap", "http_list", "screen_info", "screen_capture"]) {
      const t = reg.get(n);
      expect(t, `工具 ${n} 应已注册`).toBeTruthy();
      expect(t!.effectiveRiskKind(), `${n} 的 riskKind`).toBe("read");
    }
  });

  it("设备写入类（adb_install / adb_push / adb_pull）→ write 且不可自动放行", () => {
    for (const n of ["adb_install", "adb_push", "adb_pull"]) {
      expectTool(n, "write", false);
    }
  });

  it("图形控制动作 → write 且不可自动放行（必须走审批）", () => {
    expectTool("screen_action", "write", false);
  });

  it("ADB shell → terminal 且不可自动放行（受「终端」开关 + 审批双重约束）", () => {
    expectTool("adb_shell", "terminal", false);
  });

  it("网络类高危（adb_connect / http_serve / http_stop / http_create_app）→ 不可自动放行", () => {
    for (const n of ["adb_connect", "http_serve", "http_stop", "http_create_app"]) {
      expectTool(n, "network", false);
    }
  });

  it("无副作用的检索/写入类仍免审批（保证日常体验不退化）", () => {
    for (const n of ["web_search", "web_fetch", "file_write", "memory_insert", "memory_forget"]) {
      expect(reg.get(n), `工具 ${n} 应已注册`).toBeTruthy();
      expect(reg.get(n)!.autoApprovable, `${n} 应保持免审批`).toBe(true);
    }
  });
});

/* ───────────────────────── A-975：UI 层级解析 + 元素定位 ───────────────────────── */

describe("A-975 parseUiHierarchy — uiautomator XML → 可操作元素", () => {
  const XML = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">
    <node index="1" text="登录" resource-id="com.x:id/btnLogin" class="android.widget.Button" clickable="true" enabled="true" bounds="[100,200][500,320]" />
    <node index="2" text="" content-desc="返回" class="android.widget.ImageButton" clickable="true" bounds="[20,60][100,140]" />
    <node index="3" text="纯文本" resource-id="" class="android.widget.TextView" clickable="false" bounds="[0,400][1080,460]" />
    <node index="4" text="" resource-id="com.x:id/list" class="androidx.recyclerview.widget.RecyclerView" scrollable="true" clickable="false" bounds="[0,500][1080,2000]" />
  </node>
</hierarchy>`;

  it("解析出可操作元素并给 1 起编号、中心点取包围盒中点", () => {
    const els = parseUiHierarchy(XML);
    // 过滤掉无内容/不可点/不可滚的容器节点
    expect(els.map((e) => e.text ?? e.desc ?? e.id)).toEqual([
      "登录", "返回", "纯文本", "com.x:id/list",
    ]);
    expect(els[0].index).toBe(1);
    expect(els[0].center).toEqual({ x: 300, y: 260 }); // [(100+500)/2, (200+320)/2]
    expect(els[0].clickable).toBe(true);
    expect(els[3].scrollable).toBe(true);
  });

  it("空 XML / 非法 XML 安全返回空数组", () => {
    expect(parseUiHierarchy("")).toEqual([]);
    expect(parseUiHierarchy("<hierarchy></hierarchy>")).toEqual([]);
  });

  it("按 selector 定位元素并以其中心执行点击（不依赖模型给坐标）", async () => {
    const ctl = new ScreenController();
    const be = new UiBackend();
    ctl.register(be);
    const r = await ctl.perform("android", { kind: "click", selector: { text: "登录" } } as ScreenAction);
    expect(r.ok).toBe(true);
    expect(be.performed[0].x).toBe(300);
    expect(be.performed[0].y).toBe(260);
    expect(be.performed[0].coordSpace).toBe("device");
  });

  it("selector 命中不到 → 明确报错（提示先 screen_ui_dump）", async () => {
    const ctl = new ScreenController();
    const be = new UiBackend();
    ctl.register(be);
    const r = await ctl.perform("android", { kind: "click", selector: { text: "不存在的按钮" } } as ScreenAction);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/元素定位失败/);
  });
});

/** 带 UI 层级的假后端（用于元素定位测试） */
class UiBackend implements ScreenBackend {
  readonly id = "android" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click", "tap"]);
  performed: ScreenAction[] = [];
  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "android", target: "emu-5554", width: 1080, height: 2400, label: "fake-android" };
  }
  async capture(): Promise<ScreenCaptureResult> {
    return { ok: true, dataUrl: "data:image/png;base64,AAA", width: 1080, height: 2400, imageWidth: 1080, imageHeight: 2400, bytes: 2 };
  }
  async uiDump() {
    return [
      { index: 1, text: "登录", bounds: { x1: 100, y1: 200, x2: 500, y2: 320 }, center: { x: 300, y: 260 }, clickable: true },
      { index: 2, desc: "返回", bounds: { x1: 20, y1: 60, x2: 100, y2: 140 }, center: { x: 60, y: 100 }, clickable: true },
    ];
  }
  async perform(action: ScreenAction): Promise<ScreenActionResult> {
    this.performed.push(action);
    return { ok: true, detail: `did ${action.kind}` };
  }
}

/* ───────────────────────── A-978：按窗口截图 + 区域坐标偏移 ───────────────────────── */

describe("A-978 按窗口截图 — 坐标必须带区域原点", () => {
  it("coordToDeviceInRegion：image 坐标 = 原点 + 图内比例 × 区域尺寸", () => {
    // 窗口在 (400,300)，尺寸 800×600；模型看到的图也是 800×600（未缩放）
    expect(coordToDeviceInRegion("image", 0, 800, 800, 400)).toBe(400);
    expect(coordToDeviceInRegion("image", 400, 800, 800, 400)).toBe(800);
    // y 轴同理：(300) + 300 = 600
    expect(coordToDeviceInRegion("image", 300, 600, 600, 300)).toBe(600);
  });

  it("图像被缩放时按比例折算，再加原点", () => {
    // 窗口 1600×1200 被缩到图像 800×600（比例 2），图内 x=100 → 200 + 原点 50 = 250
    expect(coordToDeviceInRegion("image", 100, 800, 1600, 50)).toBe(250);
  });

  it("device 语义直通（不再加原点，调用方已给绝对坐标）", () => {
    expect(coordToDeviceInRegion("device", 123, 800, 800, 400)).toBe(123);
  });

  it("normalized 语义按区域尺寸折算并加原点", () => {
    expect(coordToDeviceInRegion("normalized", 500, 0, 800, 400)).toBe(800); // 400 + 0.5*800
  });

  it("控制器用【窗口截图】记录的原点折算点击坐标（不再整体偏移）", async () => {
    const ctl = new ScreenController();
    const be = new WindowBackend();
    ctl.register(be);
    const cap = await ctl.captureWindow("desktop", "记事本");
    expect(cap.ok).toBe(true);
    expect(cap.width).toBe(800);   // 区域尺寸
    expect(cap.originX).toBe(400); // 区域原点
    // 模型在图内量到 (100, 50) → 屏幕绝对坐标 (500, 350)
    await ctl.perform("desktop", { kind: "click", x: 100, y: 50 });
    expect(be.performed[0].x).toBe(500);
    expect(be.performed[0].y).toBe(350);
  });
});

/** 支持按窗口截图的假桌面后端（窗口位于 (400,300)，尺寸 800×600，图像未缩放） */
class WindowBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click"]);
  performed: ScreenAction[] = [];
  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "desktop", target: "primary", width: 2560, height: 1440, label: "fake-desktop" };
  }
  async capture(): Promise<ScreenCaptureResult> {
    return { ok: true, dataUrl: "data:image/png;base64,AAA", width: 2560, height: 1440, imageWidth: 1600, imageHeight: 900, bytes: 2 };
  }
  async focusWindow() {
    return { focused: true, detail: "已聚焦窗口「记事本」", rect: { x: 400, y: 300, width: 800, height: 600 } };
  }
  async captureWindow(): Promise<ScreenCaptureResult> {
    return {
      ok: true, dataUrl: "data:image/png;base64,AAA",
      width: 800, height: 600, imageWidth: 800, imageHeight: 600,
      originX: 400, originY: 300, bytes: 2,
    };
  }
  async perform(action: ScreenAction): Promise<ScreenActionResult> {
    this.performed.push(action);
    return { ok: true, detail: `did ${action.kind}` };
  }
}

/* ───────────────────────── A-1014：多屏原点 / 基准兜底 / 聚焦诚实 / 源码守卫 ───────────────────────── */

/** 副屏在主屏左侧的假桌面后端：虚拟桌面原点为负（Windows 常见布局） */
class SecondaryBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click"]);
  performed: ScreenAction[] = [];
  async listTargets(): Promise<DisplayInfo[]> {
    return [{
      backend: "desktop", target: String.raw`\\.\DISPLAY2`, width: 1920, height: 1080,
      label: "副屏", originX: -1920, originY: 0,
    }];
  }
  async displayInfo(): Promise<DisplayInfo> { return (await this.listTargets())[0]; }
  async capture(): Promise<ScreenCaptureResult> {
    return {
      ok: true, dataUrl: "data:image/png;base64,AAA",
      width: 1920, height: 1080, imageWidth: 1600, imageHeight: 900,
      originX: -1920, originY: 0, bytes: 2,
    };
  }
  async perform(action: ScreenAction): Promise<ScreenActionResult> {
    this.performed.push(action);
    return { ok: true, detail: `did ${action.kind}` };
  }
}

describe("A-1014 多屏虚拟桌面原点 — 副屏（负原点）不再整体偏移", () => {
  it("显示信息透传 originX/originY（副屏原点为负）", async () => {
    const ctl = new ScreenController();
    ctl.register(new SecondaryBackend());
    const info = await ctl.displayInfo("desktop");
    expect(info.originX).toBe(-1920);
    expect(info.originY).toBe(0);
  });

  it("副屏截图后点击：图像坐标按比例折算并加上负原点", async () => {
    const ctl = new ScreenController();
    const be = new SecondaryBackend();
    ctl.register(be);
    await ctl.capture("desktop"); // 图像 1600×900 = 设备 1920×1080 缩小后（比例 1.2）
    // 模型在图内量到 (100, 50) → 设备 (−1920 + 100×1.2, 0 + 50×1.2) = (−1800, 60)
    await ctl.perform("desktop", { kind: "click", x: 100, y: 50 });
    expect(be.performed[0].x).toBe(-1800);
    expect(be.performed[0].y).toBe(60);
    expect(be.performed[0].absolute).toBe(true);
  });

  it("后端不回传原点时按 0 处理（不产生 NaN/undefined 坐标）", async () => {
    const ctl = new ScreenController();
    const be = new FakeBackend(); // displayInfo / capture 都不带 origin 字段
    ctl.register(be);
    await ctl.capture("desktop");
    const r = await ctl.perform("desktop", { kind: "click", x: 10, y: 10 });
    expect(r.ok).toBe(true);
    expect(Number.isFinite(be.performed[0].x)).toBe(true);
    expect(Number.isFinite(be.performed[0].y)).toBe(true);
  });
});

describe("A-1014 基准兜底 — 按窗口截图建的基准能被「带 target 的动作」复用", () => {
  it("captureWindow 记在 `desktop|` 上的基准，执行时带 target 也能命中（不再一律报基准缺失）", async () => {
    const ctl = new ScreenController();
    const be = new WindowBackend();
    ctl.register(be);
    await ctl.captureWindow("desktop", "记事本");
    // 两种 key 不一致：截图记 `desktop|`，动作带 target → `desktop|记事本`
    const r = await ctl.perform("desktop", { kind: "click", x: 100, y: 50 }, "记事本");
    expect(r.ok).toBe(true);
    expect(be.performed[0].x).toBe(500); // 400 原点 + 100（图像未缩放）
    expect(be.performed[0].y).toBe(350); // 300 原点 + 50
  });

  it("既无基准也无物理语义 → 报错而不是猜一个比例", async () => {
    const ctl = new ScreenController();
    ctl.register(new WindowBackend());
    const r = await ctl.perform("desktop", { kind: "click", x: 100, y: 50 }, "记事本");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/坐标基准缺失/);
  });
});

/** 抢不到前台窗口的假后端（SetForegroundWindow 被系统拒绝的真实情形） */
class UnfocusedBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click"]);
  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "desktop", target: "primary", width: 1920, height: 1080, label: "fake" };
  }
  async capture(): Promise<ScreenCaptureResult> {
    return { ok: true, dataUrl: "data:image/png;base64,AAA", width: 1920, height: 1080, bytes: 2 };
  }
  async perform(): Promise<ScreenActionResult> { return { ok: true }; }
  async focusWindow() {
    return {
      focused: false,
      detail: "未能把窗口「记事本」带到前台（SetForegroundWindow 返回 False，当前前台是「其它窗口」）——画面可能被遮挡",
      rect: { x: 0, y: 0, width: 800, height: 600 },
    };
  }
  async captureWindow(): Promise<ScreenCaptureResult> {
    return {
      ok: true, dataUrl: "data:image/png;base64,AAA",
      width: 800, height: 600, imageWidth: 800, imageHeight: 600,
      originX: 0, originY: 0, bytes: 2,
      warning: "窗口「记事本」未在前台（当前前台是「其它窗口」），画面可能被其它窗口遮挡",
    };
  }
}

describe("A-1014 聚焦诚实 — 抢不到前台不再谎报成功", () => {
  it("focusWindow 未抢到前台 → focused:false，但仍回传矩形（位置可用，下层窗口照样能截）", async () => {
    const ctl = new ScreenController();
    ctl.register(new UnfocusedBackend());
    const r = await ctl.focusWindow("desktop", "记事本");
    expect(r.focused).toBe(false);
    expect(r.detail).toMatch(/未能把窗口/);
    expect(r.rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("captureWindow 把 warning 带回来（上层才能如实告知遮挡风险）", async () => {
    const ctl = new ScreenController();
    ctl.register(new UnfocusedBackend());
    const r = await ctl.captureWindow("desktop", "记事本");
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/未在前台/);
  });

  it("后端不支持按窗口截图 → 明确报错（不静默退回整屏）", async () => {
    const ctl = new ScreenController();
    ctl.register(new FakeBackend());
    const r = await ctl.captureWindow("desktop", "记事本");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不支持按窗口截图/);
  });
});

/* ───────────────────────── A-1014 源码守卫（产物层做不了，只能在源码层钉死） ───────────────────────── */

describe("A-1014 源码守卫 — 指针定位只有一条路 / 聚焦不谎报 / 换算只有一处", () => {
  const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
  /** 剥注释后再断言（注释里会故意写"旧写法"，不剥就是假红灯）。
   *  除 JS 注释外还要剥 PowerShell 的 `#` 行注释 —— desktop.ts 内嵌大段 PS 脚本，
   *  那些说明文字里同样会引用旧写法。 */
  const stripComments = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "");

  const desktopSrc = stripComments(readSrc("../../core-ts/src/screen/backends/desktop.ts"));
  const controllerSrc = stripComments(readSrc("../../core-ts/src/screen/controller.ts"));

  it("desktop.ts：指针定位收口到 Move-SlimeCursor，SetCursorPos 只允许出现在「声明 + 守卫调用」两处", () => {
    expect(desktopSrc).toContain("function Move-SlimeCursor");
    const uses = desktopSrc.match(/SetCursorPos\(/g) ?? [];
    expect(uses).toHaveLength(2);
    // 也不再有任何被管道吞掉返回值的写法
    expect(desktopSrc).not.toMatch(/SetCursorPos\([^)]*\)\s*\|\s*Out-Null/);
  });

  it("desktop.ts：Move-SlimeCursor 校验返回值并在失败时抛错（不再静默打偏）", () => {
    const i = desktopSrc.indexOf("function Move-SlimeCursor");
    const body = desktopSrc.slice(i, desktopSrc.indexOf("\n}\n", i));
    expect(body).toMatch(/-not \[SlimeInput\]::SetCursorPos/);
    expect(body).toMatch(/throw/);
  });

  it("desktop.ts：focus 通过回读真实前台窗口判断，不再无条件宣布成功", () => {
    const i = desktopSrc.indexOf("'focus' {");
    const body = desktopSrc.slice(i, desktopSrc.indexOf("'move' {", i));
    expect(body).toContain("GetForegroundWindow()");
    expect(body).toMatch(/focused = \$false/);
  });

  it("controller.ts：没有基准且非 device 语义 → 直接报错（守「坐标基准缺失」这条线）", () => {
    expect(controllerSrc).toMatch(/space !== "device" && !basis/);
    expect(controllerSrc).toContain("坐标基准缺失");
  });

  it("coordToDeviceInRegion 是唯一生效的换算实现（controller 不 import 已弃用的 toPixel/imageToDevice）", () => {
    expect(controllerSrc).toContain("coordToDeviceInRegion(");
    expect(controllerSrc).not.toMatch(/\btoPixel\(/);
    expect(controllerSrc).not.toMatch(/\bimageToDevice\(/);
  });
});
