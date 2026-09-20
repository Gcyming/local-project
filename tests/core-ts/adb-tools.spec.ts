/**
 * tests/core-ts/adb-tools.spec.ts — ADB 工具链自愈能力回归测试。
 *
 * 背景：用户实测「模型说没有 adb_push / 无法检测模拟器 / 让用户自己去 cmd 跑命令」。
 * 根因是**本机没有 adb** 且模型缺少「下载 platform-tools / 启动 adb 服务」的工具。
 * 本测试锁死修复后的行为：
 *  - adb 未安装时 adb_devices / adb_connect 都给出「改用 adb_setup」的明确指引（而不是让用户跑命令行）
 *  - adb_devices 空列表时自动扫描常见模拟器端口（MuMu 7555/16384、雷电 5555…）
 *  - adb_setup 串起 检测 → 下载 → 启动服务 → 扫描连接 → 复读设备
 *  - adb_push / adb_pull / adb_shell / adb_screencap / adb_setup 均已注册
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRegistry, setToolCategoryGate } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setAdbService } from "../../core-ts/src/tools/builtin.js";

interface Call { method: string; args: unknown[] }

/** 可编排的假 AdbService（模拟 AdbService 的公开方法） */
class FakeAdb {
  calls: Call[] = [];
  adbInstalled = true;
  devicesList: Array<{ serial: string; state: string; model?: string }> = [];
  /** connect 时哪些端口算成功 */
  connectable = new Set<string>();
  downloadOk = true;
  startOk = true;

  async detect() {
    this.calls.push({ method: "detect", args: [] });
    return this.adbInstalled
      ? { ok: true, path: "C:/fake/adb.exe", version: "35.0.2", source: "bundled" }
      : { ok: false, source: "missing", error: "未检测到 adb" };
  }
  async downloadPlatformTools() {
    this.calls.push({ method: "downloadPlatformTools", args: [] });
    if (!this.downloadOk) { return { ok: false, error: "网络超时" }; }
    this.adbInstalled = true;
    return { ok: true, stdout: "platform-tools 已安装至 C:/fake" };
  }
  async startServer() {
    this.calls.push({ method: "startServer", args: [] });
    return this.startOk ? { ok: true, version: "Android Debug Bridge 1.0.41" } : { ok: false, error: "启动失败" };
  }
  async devices() {
    this.calls.push({ method: "devices", args: [] });
    return { ok: true, devices: this.devicesList };
  }
  async connect(host: string) {
    this.calls.push({ method: "connect", args: [host] });
    if (this.connectable.has(host)) {
      this.devicesList.push({ serial: host, state: "device", model: "MuMu" });
      return { ok: true, stdout: `connected to ${host}` };
    }
    // 真实 adb 对不存在的目标常返回 exit 0 + "failed to connect"
    return { ok: true, stdout: `failed to connect to ${host}` };
  }
  async shell(_s: string, cmd: string) { this.calls.push({ method: "shell", args: [cmd] }); return { ok: true, stdout: "ok" }; }
  async install() { return { ok: true }; }
  async screencap() { return { ok: true, pngBase64: "AAA" }; }
  async pull() { this.calls.push({ method: "pull", args: [] }); return { ok: true, stdout: "1 file pulled" }; }
  async push() { this.calls.push({ method: "push", args: [] }); return { ok: true, stdout: "1 file pushed" }; }
}

let reg: ToolRegistry;
let adb: FakeAdb;

beforeEach(() => {
  reg = new ToolRegistry();
  registerBuiltinTools(reg);
  adb = new FakeAdb();
  setAdbService(adb as never);
  setToolCategoryGate(null); // 测试关注工具行为，不测类别闸门
});

afterEach(() => {
  setAdbService(null);
  setToolCategoryGate(null);
});

describe("ADB 工具注册完整性", () => {
  it("adb_setup / adb_push / adb_pull / adb_shell / adb_screencap / adb_connect 全部已注册", () => {
    for (const n of ["adb_setup", "adb_devices", "adb_connect", "adb_shell", "adb_install", "adb_screencap", "adb_push", "adb_pull"]) {
      expect(reg.get(n), `缺少工具 ${n}`).toBeTruthy();
    }
  });
});

describe("adb 未安装 → 给出自愈指引（而不是让用户跑命令行）", () => {
  it("adb_devices 提示改用 adb_setup，且明确禁止甩给用户", async () => {
    adb.adbInstalled = false;
    const out = await reg.callTool("adb_devices", {});
    expect(out).toMatch(/未检测到 adb/);
    expect(out).toMatch(/adb_setup/);
    expect(out).toMatch(/不要要求用户/);
  });

  it("adb_connect 提示先调 adb_setup", async () => {
    adb.adbInstalled = false;
    const out = await reg.callTool("adb_connect", {});
    expect(out).toMatch(/adb_setup/);
  });
});

describe("adb_devices 空列表 → 自动扫描常见模拟器端口", () => {
  it("未连上时报告已尝试的端口清单并给出下一步（含具体端口号）", async () => {
    const out = await reg.callTool("adb_devices", {});
    expect(out).toMatch(/没有可用/);
    expect(out).toMatch(/127\.0\.0\.1:7555/);
    expect(out).toMatch(/127\.0\.0\.1:16384/); // MuMu 12
    expect(out).toMatch(/adb_connect/);
    // 确实尝试过扫描
    expect(adb.calls.filter((c) => c.method === "connect").length).toBeGreaterThan(5);
  });

  it("扫描到可用端口时自动连接并回报设备", async () => {
    adb.connectable.add("127.0.0.1:16384");
    const out = await reg.callTool("adb_devices", {});
    expect(out).toMatch(/serial=127\.0\.0\.1:16384/);
    expect(out).toMatch(/state=device/);
    expect(out).not.toMatch(/没有可用/);
  });
});

describe("adb_shell 缺少 serial 时报错（不静默）", () => {
  it("serial 为空 → 明确提示先取 serial", async () => {
    const out = await reg.callTool("adb_shell", { command: "pm list packages" });
    expect(out).toMatch(/serial 不能为空/);
  });
});

describe("adb_setup 一键自愈链路", () => {
  it("adb 缺失 → 自动下载 → 启动服务 → 扫描连接 → 复读设备", async () => {
    adb.adbInstalled = false;
    adb.connectable.add("127.0.0.1:7555");
    const out = await reg.callTool("adb_setup", {});
    const methods = adb.calls.map((c) => c.method);
    expect(methods).toContain("detect");
    expect(methods).toContain("downloadPlatformTools");
    expect(methods).toContain("startServer");
    expect(methods).toContain("connect");
    expect(out).toMatch(/未检测到 adb/);
    expect(out).toMatch(/已就绪/);
    expect(out).toMatch(/adb 服务已启动/);
    expect(out).toMatch(/已自动连接：127\.0\.0\.1:7555/);
  });

  it("adb 已就绪时不下载，直接启服务并扫描", async () => {
    const out = await reg.callTool("adb_setup", {});
    const methods = adb.calls.map((c) => c.method);
    expect(methods).not.toContain("downloadPlatformTools");
    expect(methods).toContain("startServer");
    expect(out).toMatch(/已就绪/);
  });

  it("download=false 且 adb 缺失 → 不下载，给出提示", async () => {
    adb.adbInstalled = false;
    const out = await reg.callTool("adb_setup", { download: false });
    expect(adb.calls.map((c) => c.method)).not.toContain("downloadPlatformTools");
    expect(out).toMatch(/download=false/);
  });

  it("下载失败 → 如实报错并给出人工入口", async () => {
    adb.adbInstalled = false;
    adb.downloadOk = false;
    const out = await reg.callTool("adb_setup", {});
    expect(out).toMatch(/下载失败/);
    expect(out).toMatch(/运行环境/);
  });
});

describe("adb_push / adb_pull 已具备文件互传能力", () => {
  it("adb_push 转发 local/remote 到服务并回报成功", async () => {
    const out = await reg.callTool("adb_push", { serial: "emulator-5554", local: "C:/a.txt", remote: "/sdcard/a.txt" });
    expect(out).toMatch(/已推送/);
    expect(adb.calls.map((c) => c.method)).toContain("push");
  });

  it("adb_push 缺 local/remote → 明确报错，不调用服务", async () => {
    const before = adb.calls.length;
    const out = await reg.callTool("adb_push", { local: "C:/a.txt" });
    expect(out).toMatch(/不能为空/);
    expect(adb.calls.length).toBe(before);
  });

  it("adb_pull 拉取并回报", async () => {
    const out = await reg.callTool("adb_pull", { remote: "/sdcard/a.png", local: "D:/out/a.png" });
    expect(out).toMatch(/已拉取/);
    expect(adb.calls.map((c) => c.method)).toContain("pull");
  });
});
