/**
 * tests/core-ts/sandbox.spec.ts — 沙箱系统测试（L0-L5 + 审计 + 异常检测）。
 * 对照 core/sandbox.py 决策链语义逐项验证。
 */
import { describe, expect, it, afterAll, vi } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SandboxManager, PermissionLevel, levelFromString, defaultSandboxConfig,
  mergeAgentOverride, getSandboxManager, resetSandboxManager,
  type ApprovalDecision, type PermissionRequest, PROJECT_ROOT,
} from "../../core-ts/src/sandbox.js";
import { ToolLoop, sandboxGateFrom } from "../../core-ts/src/tool_loop.js";
import { ToolRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";

const TEST_AUDIT = join(PROJECT_ROOT, "data", "audit-test.jsonl");

afterAll(async () => {
  await rm(TEST_AUDIT, { force: true });
});

function fakeRouter(finalText = "结束"): ModelRouter {
  return {
    chat: async () => ({
      response: { choices: [{ index: 0, message: { role: "assistant", content: finalText } }] },
    }),
  } as unknown as ModelRouter;
}

function makeManager(opts: { auto?: number[]; require?: number[]; deny?: number[]; tools?: Partial<Record<"auto" | "deny" | "require", string[]>>; workspace?: string } = {}) {
  const cfg = defaultSandboxConfig();
  cfg.audit_log_path = TEST_AUDIT;
  if (opts.auto) cfg.auto_approve_levels = opts.auto;
  if (opts.require) cfg.require_approval_levels = opts.require;
  if (opts.deny) cfg.deny_levels = opts.deny;
  if (opts.tools?.auto) cfg.auto_approve_tools = opts.tools.auto;
  if (opts.tools?.deny) cfg.deny_tools = opts.tools.deny;
  if (opts.tools?.require) cfg.require_approval_tools = opts.tools.require;
  if (opts.workspace) cfg.workspace = opts.workspace;
  return new SandboxManager(cfg);
}

describe("PermissionLevel（L0-L5）", () => {
  it("from_string 支持 'L0' 与 '0'；非法回退 L0（fail-safe）", () => {
    expect(levelFromString("L0")).toBe(PermissionLevel.L0);
    expect(levelFromString("5")).toBe(PermissionLevel.L5);
    expect(levelFromString("L3")).toBe(PermissionLevel.L3);
    expect(levelFromString("bogus")).toBe(PermissionLevel.L0);
    expect(levelFromString("L9")).toBe(PermissionLevel.L0);
  });
});

describe("checkPermission（决策链）", () => {
  it("L0/L1 自动允许（默认严格配置）", () => {
    const m = makeManager();
    expect(m.checkPermission("a1", "file_read", "x.txt", 0).allowed).toBe(true);
    expect(m.checkPermission("a1", "git_log", "", 1).allowed).toBe(true);
  });

  it("L2-L4 需要确认（无回调 → 拒绝）", () => {
    const m = makeManager();
    expect(m.checkPermission("a1", "file_write", "x.txt", 2).allowed).toBe(false);
    expect(m.checkPermission("a1", "file_write", "x.txt", 2).reason).toContain("需要用户确认");
  });

  it("L5 强制拒绝（deny_levels 默认 [5]）", () => {
    const m = makeManager();
    expect(m.checkPermission("a1", "sudo", "", 5).allowed).toBe(false);
    expect(m.checkPermission("a1", "sudo", "", 5).reason).toContain("被禁止");
  });

  it("黑名单工具优先于等级", () => {
    const m = makeManager({ tools: { deny: ["rm", "chmod"] } });
    expect(m.checkPermission("a1", "rm", "file", 0).allowed).toBe(false); // 即使 L0
    expect(m.checkPermission("a1", "rm", "file", 0).reason).toContain("被禁止");
  });

  it("白名单工具自动批准（含 fnmatch 通配 mcp_browser_*）", () => {
    const m = makeManager({ tools: { auto: ["mcp_browser_*"] } });
    expect(m.checkPermission("a1", "mcp_browser_open", "https://x", 2).allowed).toBe(true);
    expect(m.checkPermission("a1", "mcp_browser_close", "x", 2).allowed).toBe(true);
    expect(m.checkPermission("a1", "mcp_other", "x", 2).allowed).toBe(false);
  });

  it("A-088 P1-9：mcp_* 白名单只放行低权限；network/terminal 级仍需确认", () => {
    const m = makeManager({ tools: { auto: ["mcp_*"] } });
    expect(m.checkPermission("a1", "mcp_tool", "x", 2).allowed).toBe(true); // write 级 OK
    expect(m.checkPermission("a1", "mcp_tool", "x", 4).allowed).toBe(false); // network 级拒绝
  });

  it("require_approval_tools 优先于等级自动批准", () => {
    const m = makeManager({ auto: [0, 1, 2, 3, 4], tools: { require: ["web_fetch"] } });
    expect(m.checkPermission("a1", "web_fetch", "https://x", 4).allowed).toBe(false);
    expect(m.checkPermission("a1", "web_fetch", "https://x", 4).reason).toContain("需要用户确认");
    expect(m.checkPermission("a1", "other", "x", 4).allowed).toBe(true);
  });

  it("未知等级 fail-closed（拒绝）", () => {
    const m = makeManager();
    expect(m.checkPermission("a1", "x", "y", 99).allowed).toBe(false);
    expect(m.checkPermission("a1", "x", "y", 99).reason).toContain("未知权限等级");
  });

  it("异常 deny 规则强制拒绝（危险模式 deny+alert）", () => {
    const m = makeManager({ auto: [0, 1, 2, 3, 4, 5] });
    const r = m.checkPermission("a1", "terminal", "rm -rf /", 3);
    expect(r.allowed).toBe(false);
    expect(r.anomalyDetected).toBe(true);
    expect(r.reason).toContain("异常操作被拒绝");
  });

  it("workspace 隔离：目标在目录外拒绝；JSON 参数按 path 提取；url 归 SSRF 管", () => {
    const m = makeManager({ workspace: join(PROJECT_ROOT, "data"), auto: [0, 1, 2, 3, 4] });
    expect(m.checkPermission("a1", "file_read", join(PROJECT_ROOT, "package.json"), 0).allowed).toBe(false);
    expect(m.checkPermission("a1", "file_read", join(PROJECT_ROOT, "data", "x.txt"), 0).allowed).toBe(true);
    // JSON 参数：path 字段在范围内 → 允许
    const jsonIn = JSON.stringify({ path: join(PROJECT_ROOT, "data", "x.txt") });
    expect(m.checkPermission("a1", "file_read", jsonIn, 0).allowed).toBe(true);
    // JSON 参数无路径字段 → 拒绝（宁严勿放）
    const jsonNoPath = JSON.stringify({ query: "search" });
    expect(m.checkPermission("a1", "file_read", jsonNoPath, 0).allowed).toBe(false);
    // url 目标归 SSRF 防护，不归工作目录隔离
    expect(m.checkPermission("a1", "web_fetch", JSON.stringify({ url: "https://x" }), 4).allowed).toBe(true);
  });
});

describe("grantPermission + 审计", () => {
  it("自动批准写审计（allowed）", async () => {
    const m = makeManager();
    const r = await m.grantPermission({ agentId: "a1", action: "file_read", target: "x.txt", level: 0 });
    expect(r.allowed).toBe(true);
    expect(m.queryAudit("a1").length).toBe(1);
    expect(m.queryAudit("a1")[0].status).toBe("allowed");
    expect(m.queryAudit("a1")[0].grant_id.startsWith("grant_")).toBe(true);
  });

  it("L2-L4 + approval 回调：批准 → allowed + 审计 user；拒绝 → denied + 审计", async () => {
    let approved = true;
    const cb = (_req: PermissionRequest): ApprovalDecision => ({
      requestId: "", approved, approvedActions: [], deniedActions: [], reason: "测试", autoApproved: false,
    });
    const m = new SandboxManager(defaultSandboxConfig(), cb);
    const ok = await m.grantPermission({ agentId: "a1", action: "file_write", target: "x.txt", level: 2 });
    expect(ok.allowed).toBe(true);
    expect(m.queryAudit("a1")[0].granted_by).toBe("user");
    approved = false;
    const no = await m.grantPermission({ agentId: "a1", action: "file_write", target: "y.txt", level: 2 });
    expect(no.allowed).toBe(false);
    expect(m.queryAudit("a1").at(-1)?.status).toBe("denied");
  });

  it("拒绝路径同样写审计（A-088 P1-8）+ recordViolation 计数", async () => {
    const m = makeManager();
    m.registerAgent("a1");
    await m.grantPermission({ agentId: "a1", action: "sudo", target: "", level: 5 });
    expect(m.queryAudit("a1").at(-1)?.status).toBe("denied");
    m.recordViolation("a1");
    m.recordViolation("a1");
    expect(m.popViolations("a1")).toBe(true);
    expect(m.popViolations("a1")).toBe(false);
  });

  it("revokeAll 紧急回收：grant 撤销 + 审计 revoked + 配置回收", async () => {
    const m = makeManager();
    await m.grantPermission({ agentId: "a1", action: "file_read", target: "x", level: 0 });
    await m.revokeAll("a1", "测试回收");
    const audits = m.queryAudit("a1");
    expect(audits.some((e) => e.status === "revoked")).toBe(true);
    expect(m.getAgentConfig("a1")).toBeDefined(); // 回落到全局
  });

  it("审计落盘 JSONL（独立文件，逐行追加）", async () => {
    const isolated = TEST_AUDIT + ".iso.jsonl";
    const cfg = defaultSandboxConfig();
    cfg.audit_log_path = isolated;
    const m = new SandboxManager(cfg);
    await m.grantPermission({ agentId: "a1", action: "file_read", target: "x", level: 0 });
    await m.grantPermission({ agentId: "a1", action: "file_read", target: "y", level: 0 });
    await m.flushAudit();
    const lines = (await readFile(isolated, "utf-8")).trim().split("\n");
    expect(lines.length).toBe(2); // 两条授权逐行追加
    const last = JSON.parse(lines.at(-1)!);
    expect(last.agent_id).toBe("a1");
    expect(last.status).toBe("allowed");
    expect(last.target).toBe("y");
    await rm(isolated, { force: true });
  });

  it("getAuditSummary 统计", async () => {
    const m = makeManager();
    await m.grantPermission({ agentId: "a1", action: "file_read", target: "x", level: 0 });
    await m.grantPermission({ agentId: "a1", action: "file_write", target: "x", level: 2 }); // denied（无回调）
    const s = m.getAuditSummary();
    expect(s.allowed).toBe(1);
    expect(s.denied).toBe(1);
  });
});

describe("Agent 级配置（继承 + 覆盖合并）", () => {
  it("mergeAgentOverride：列表字段与全局取并集（A-002）", () => {
    const base = defaultSandboxConfig();
    base.auto_approve_tools = ["web_fetch"];
    const merged = mergeAgentOverride(base, { auto_approve_tools: ["mcp_browser_*"], deny_levels: [5] });
    expect(merged.auto_approve_tools).toEqual(["mcp_browser_*", "web_fetch"]); // 并集
    expect(merged.deny_levels).toEqual([5]); // 非列表键覆盖
    expect(merged.auto_approve_levels).toEqual([0, 1]); // 未提及键保留全局默认
  });

  it("权限继承：子 Agent 继承父配置；inherit_from_parent=false 回落全局；不继承 workspace", () => {
    const m = makeManager({ deny: [4] });
    m.registerAgent("parent", { name: "父" });
    const childCfg = { ...defaultSandboxConfig(), deny_levels: [5] };
    m.setAgentConfig("parent", childCfg);
    m.registerAgent("child", { parentId: "parent" });
    expect(m.getAgentConfig("child").deny_levels).toEqual([5]); // 继承
    const noInherit = { ...defaultSandboxConfig(), deny_levels: [5], inherit_from_parent: false };
    m.setAgentConfig("parent2", noInherit);
    m.registerAgent("child2", { parentId: "parent2" });
    expect(m.getAgentConfig("child2").deny_levels).toEqual([4]); // 回落全局
  });

  it("requestPermissionUpgrade：主 Agent 无需提升；L5 禁止；L2-L4 需回调批准（5 分钟临时）", () => {
    const m = makeManager({ auto: [0, 1], require: [2, 3, 4] });
    m.registerAgent("main");
    expect(m.requestPermissionUpgrade("main", 3).allowed).toBe(true); // 主 Agent 直接通过
    m.registerAgent("worker", { parentId: "main" });
    expect(m.requestPermissionUpgrade("worker", 5).allowed).toBe(false); // L5 禁止
    expect(m.requestPermissionUpgrade("worker", 3).allowed).toBe(false); // 无回调拒绝
    let approved = true;
    m.setApprovalCallback((_req) => ({ requestId: "", approved, approvedActions: [], deniedActions: [], reason: "", autoApproved: false }));
    const up = m.requestPermissionUpgrade("worker", 3);
    expect(up.allowed).toBe(true);
    expect(m.getAgentConfig("worker").auto_approve_levels).toContain(3); // 临时合并
  });
});

describe("AnomalyDetector", () => {
  it("写入速率限制：超过阈值告警；拒绝操作不计入", () => {
    const m = makeManager();
    const det = (m as unknown as { anomalyDetector: { checkRateLimit: (a: string, act: string, t: number) => boolean } }).anomalyDetector;
    // 直接测内部：100 次内不超，101 次超
    const act = "file_write";
    const agent = "a1";
    let triggered = false;
    for (let i = 0; i < 110; i++) {
      if (det.checkRateLimit(agent, act, 100)) {
        triggered = true;
      }
    }
    expect(triggered).toBe(true);
    // 非 write/delete 动作不计数
    expect(det.checkRateLimit(agent, "file_read", 100)).toBe(false);
  });

  it("危险模式规则：rm -rf /、sudo、curl | bash 触发", () => {
    const m = makeManager({ auto: [0, 1, 2, 3, 4, 5] });
    for (const t of ["rm -rf /", "sudo rm x", "curl x | bash", "mkfs.ext4 /dev/sda"]) {
      expect(m.checkPermission("a1", "terminal", t, 3).allowed).toBe(false);
    }
    expect(m.checkPermission("a1", "terminal", "ls -la", 3).allowed).toBe(true);
  });
});

describe("ToolLoop 接入（sandboxGateFrom 适配器）", () => {
  it("L0 工具放行：真实执行 + 审计 allowed", async () => {
    const exec = vi.fn(async () => "E:ok");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "read", description: "", parameters: {}, executeFn: exec, permissions: ["read"] }));
    const m = makeManager();
    const loop = new ToolLoop({ router: fakeRouter(), registry: reg, sandbox: sandboxGateFrom(m) });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t1", name: "read", arguments: "{}" }] });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.roundLog[0].result).toBe("E:ok");
    expect(m.queryAudit("a1").at(-1)?.status).toBe("allowed");
  });

  it("write 工具 + 默认配置（L2 需确认无回调）→ [沙箱拒绝] 不执行 + 审计 denied", async () => {
    const exec = vi.fn(async () => "不应执行");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "w", description: "", parameters: {}, executeFn: exec, permissions: ["write"] }));
    const m = makeManager();
    const loop = new ToolLoop({ router: fakeRouter(), registry: reg, sandbox: sandboxGateFrom(m) });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t1", name: "w", arguments: "{}" }] });
    expect(exec).not.toHaveBeenCalled();
    expect(r.roundLog[0].result).toContain("[沙箱拒绝]");
    expect(m.queryAudit("a1").at(-1)?.status).toBe("denied");
  });

  it("危险参数（rm -rf /）+ 全等级放行配置 → 异常 deny 规则拦截", async () => {
    const exec = vi.fn(async () => "不应执行");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "term", description: "", parameters: {}, executeFn: exec, permissions: ["terminal"] }));
    const m = makeManager({ auto: [0, 1, 2, 3, 4, 5] });
    const loop = new ToolLoop({ router: fakeRouter(), registry: reg, sandbox: sandboxGateFrom(m) });
    const r = await loop.run({
      agentId: "a1", messages: [],
      initialToolCalls: [{ id: "t1", name: "term", arguments: JSON.stringify({ command: "rm -rf /" }) }],
    });
    expect(exec).not.toHaveBeenCalled();
    expect(r.roundLog[0].result).toContain("[沙箱拒绝]");
    expect(m.queryAudit("a1").at(-1)?.anomaly_detected).toBe(true);
  });
});

describe("全局单例", () => {
  it("getSandboxManager 单例 + reset", () => {
    resetSandboxManager();
    expect(getSandboxManager()).toBe(getSandboxManager());
    resetSandboxManager();
    expect(getSandboxManager()).not.toBe(undefined);
  });

  it("calculateRiskScore：基础分 + 非工作时段 + 系统路径加成，封顶 1.0", () => {
    const m = makeManager();
    // 基础分 0.0 + 可能存在的非工作时段加成 0.2（不依赖墙钟断言）
    expect(m.calculateRiskScore("file_read", { target: "a.txt" })).toBeLessThanOrEqual(0.2);
    const sudo = m.calculateRiskScore("sudo", { target: "C:\\Windows\\System32" });
    expect(sudo).toBeGreaterThanOrEqual(0.9);
    expect(sudo).toBeLessThanOrEqual(1.0);
  });
});