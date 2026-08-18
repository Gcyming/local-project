/**
 * tests/core-ts/model_server.spec.ts — 模型生命周期管理测试。
 * 对照 tests/test_model_server.py 语义逐项移植（VRAM/Backend/Manager/孤儿回收）。
 * 不依赖真实 GPU/llama-server：execFileSync 走 mock 分派；fetch 走注入 fetchImpl。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import { spawn, execFileSync } from "node:child_process";
import {
  VRAMMonitor, ModelBackend, ModelServerManager,
  findFreePort, basePortFor, verifyLlamaServerPid,
  pidForPort, isOrphan, killPid,
  ServerState,
} from "../../core-ts/src/model_server.js";

const spawnMock = vi.mocked(spawn);
const execMock = vi.mocked(execFileSync);

// 测试专用高位端口（A-037 语义：避免与生产实例 8999/18082 冲突）
const EMBED_PORT = 19511;
const CHAT_PORT_START = 19521;

function makeCfg(tmp: string) {
  return {
    llama_bin: join(tmp, "llama-server.exe"),
    startup_timeout: 2,
    vram_budget_gb: 7.0,
    chat_est_gb: 4.0,
    embedding: {
      model_path: join(tmp, "bge.gguf"),
      port: EMBED_PORT,
      gpu_layers: 99,
      ctx_len: 2048,
      persistent: true,
      dim: 1024,
    },
    chat: {
      models_dir: tmp,
      port_start: CHAT_PORT_START,
      gpu_layers: 99,
      ctx_len: 8192,
      persistent: false,
      idle_unload_min: 0,
      max_instances: 1,
    },
  };
}

/** execFileSync 按命令分派的标准 mock（tasklist 输出需 per-test 覆盖） */
function dispatchExec(impl: (cmd: string, args: string[]) => string) {
  execMock.mockImplementation(((cmd: string, args: string[]) => impl(cmd, args)) as never);
}

/** 注入的 fetchImpl：默认所有 /health 返回 ok（waitReady 消费） */
function okFetch(): typeof fetch {
  return (async () => ({ status: 200, json: async () => ({ status: "ok" }) })) as unknown as typeof fetch;
}

/** probeImpl：指定端口视为有活实例 */
function liveProbe(ports: number[]): (port: number) => Promise<boolean> {
  return async (port) => ports.includes(port);
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnMock.mockReturnValue({ pid: 4242, kill: vi.fn() } as never);
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ── VRAMMonitor ───────────────────────────────────────────

describe("VRAMMonitor", () => {
  it("nvidia-smi CSV 解析（有效）", () => {
    execMock.mockReturnValue("8192, 2048, 6144\n" as never);
    const result = new VRAMMonitor().sample();
    expect(result).not.toBeNull();
    expect(result!.total_gb).toBe(Math.round(8192 / 1024 * 100) / 100);
    expect(result!.used_gb).toBe(Math.round(2048 / 1024 * 100) / 100);
    expect(result!.free_gb).toBe(Math.round(6144 / 1024 * 100) / 100);
  });

  it("nvidia-smi 失败 → null", () => {
    execMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(new VRAMMonitor().sample()).toBeNull();
  });

  it("空输出 → null", () => {
    execMock.mockReturnValue("" as never);
    expect(new VRAMMonitor().sample()).toBeNull();
  });
});

// ── ModelBackend ──────────────────────────────────────────

describe("ModelBackend", () => {
  it("start 缺失 binary → false", () => {
    const backend = new ModelBackend(join(tmpdir(), "nonexistent.exe"));
    expect(backend.start({ llamaBin: join(tmpdir(), "nonexistent.exe"), modelPath: "model.gguf", port: 9999, gpuLayers: 99, ctxLen: 2048 })).toBe(false);
  });

  it("start 缺失模型 → false", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ms-"));
    try {
      const bin = join(tmp, "llama-server.exe");
      writeFileSync(bin, "");
      const backend = new ModelBackend(bin);
      expect(backend.start({ llamaBin: bin, modelPath: join(tmp, "none.gguf"), port: 9999, gpuLayers: 99, ctxLen: 2048 })).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("probe 端口无服务 → false", async () => {
    const backend = new ModelBackend("llama-server", {
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    });
    expect(await backend.probe(19999)).toBe(false);
  });

  it("is_running 无 pid → false", async () => {
    const backend = new ModelBackend("llama-server");
    expect(await backend.isRunning()).toBe(false);
  });
});

// ── ModelServerManager ────────────────────────────────────

describe("ModelServerManager", () => {
  function makeManager(overrides: { registryPath?: string; fetchImpl?: typeof fetch; probeImpl?: (port: number) => Promise<boolean> } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), "ms-"));
    return { tmp, cfg: makeCfg(tmp), mgr: new ModelServerManager(makeCfg(tmp), {
      registryPath: overrides.registryPath ?? join(tmp, "registry.json"),
      fetchImpl: overrides.fetchImpl ?? okFetch(),
      probeImpl: overrides.probeImpl,
    }) };
  }

  it("ensure 缺模型 → ok=false 且带错误信息", async () => {
    const { tmp, cfg, mgr } = makeManager({ probeImpl: liveProbe([]) });
    writeFileSync(join(tmp, "llama-server.exe"), "");
    const result = await mgr.ensure("embedding", cfg.embedding.model_path, "bge-m3");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("release 不存在的 role → ok=false", () => {
    const { mgr } = makeManager();
    const result = mgr.release("embedding");
    expect(result.ok).toBe(false);
  });

  it("未启动时 status 为空数组", () => {
    const { mgr } = makeManager();
    expect(mgr.status()).toEqual([]);
  });

  it("readRegistry 无文件 → {}", () => {
    const { tmp } = makeManager();
    expect(ModelServerManager.readRegistry(join(tmp, "nonexistent.json"))).toEqual({});
  });

  it("findFreePort 找空闲端口（chat：从 port_start 起）", async () => {
    const port = await findFreePort(CHAT_PORT_START, 0, 100);
    expect(port).toBeGreaterThanOrEqual(CHAT_PORT_START);
    expect(port).toBeLessThan(CHAT_PORT_START + 100);
  });

  it("basePortFor 角色感知（A-003）+ 缺省兜底", () => {
    expect(basePortFor("embedding", { port: 8999 }, { port_start: 18082 })).toBe(8999);
    expect(basePortFor("chat", { port: 8999 }, { port_start: 18082 })).toBe(18082);
    expect(basePortFor("embedding", {}, {})).toBe(8999);
    expect(basePortFor("chat", {}, {})).toBe(18082);
  });

  it("startup 清空陈旧 registry（A-003/H1）", async () => {
    const { tmp, cfg } = makeManager();
    cfg.embedding.persistent = false; // 不拉起实例，只验证清理
    const stale = join(tmp, "stale_registry.json");
    writeFileSync(stale, JSON.stringify({
      embedding: { model: "bge-m3", port: EMBED_PORT, pid: 13272, state: "ready" },
    }), "utf8");
    const m = new ModelServerManager(cfg, { registryPath: stale, fetchImpl: okFetch() });
    await m.startup();
    expect(JSON.parse(readFileSync(stale, "utf8"))).toEqual({});
  });

  it("status 反映实例与 VRAM（含 vram_gb 字段）", async () => {
    const { tmp, cfg, mgr } = makeManager({ probeImpl: liveProbe([]) });
    execMock.mockReturnValue("8192, 2048, 6144\n" as never);
    writeFileSync(join(tmp, "llama-server.exe"), "");
    writeFileSync(join(tmp, "bge.gguf"), "");
    // 先通过 ensure 启动（spawn 已 mock；waitReady 走 okFetch）
    const result = await mgr.ensure("embedding", cfg.embedding.model_path, "bge-m3");
    expect(result.ok).toBe(true);
    const items = mgr.status();
    expect(items.length).toBe(1);
    expect(items[0].role).toBe("embedding");
    expect(items[0].state).toBe(ServerState.READY);
    expect(items[0].vram_gb?.free_gb).toBe(6);
  });
});

// ── 孤儿回收（A-017 语义移植） ────────────────────────────

describe("孤儿回收（OrphanRecovery）", () => {
  it("pidForPort 解析 LISTENING 行", () => {
    dispatchExec((cmd) => {
      if (cmd === "netstat") return "  TCP    127.0.0.1:8999   0.0.0.0:0    LISTENING    4242\n";
      return "";
    });
    expect(pidForPort(8999)).toBe(4242);
  });

  it("pidForPort 无监听 → null", () => {
    dispatchExec((cmd) => {
      if (cmd === "netstat") return "  TCP    127.0.0.1:9001   0.0.0.0:0    LISTENING    99\n";
      return "";
    });
    expect(pidForPort(8999)).toBeNull();
  });

  it("isOrphan 父已死 → true", () => {
    dispatchExec((cmd) => {
      if (cmd === "wmic") return "ParentProcessId\n99999\n";
      if (cmd === "tasklist") return "INFO: No tasks are running.";
      return "";
    });
    expect(isOrphan(4242)).toBe(true);
  });

  it("isOrphan 父存活 → false", () => {
    dispatchExec((cmd) => {
      if (cmd === "wmic") return "ParentProcessId\n99999\n";
      if (cmd === "tasklist") return "python.exe   99999 Console  1  100,000 K";
      return "";
    });
    expect(isOrphan(4242)).toBe(false);
  });

  it("verifyLlamaServerPid：tasklist 镜像名校验（llama-server 真/notepad 假）", () => {
    execMock.mockReturnValue('"llama-server.exe","4242","Console","1","2,000,000 K"\n' as never);
    expect(verifyLlamaServerPid(4242)).toBe(true);
    execMock.mockReturnValue('"notepad.exe","4242","Console","1","100 K"\n' as never);
    expect(verifyLlamaServerPid(4242)).toBe(false);
  });

  it("killPid 拒绝非 llama-server", () => {
    execMock.mockReturnValue('"notepad.exe","4242","Console","1","100 K"\n' as never);
    expect(killPid(4242)).toBe(false);
  });

  it("probeLive：embedding 查固定端口；chat 扫描无活实例 → null", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ms-"));
    try {
      const cfg = makeCfg(tmp);
      const mgr = new ModelServerManager(cfg, {
        registryPath: join(tmp, "registry.json"),
        fetchImpl: okFetch(),
        probeImpl: liveProbe([EMBED_PORT]),
      });
      dispatchExec((cmd) => cmd === "netstat" ? `  TCP    127.0.0.1:${EMBED_PORT}   0.0.0.0:0    LISTENING    4242\n` : "");
      const live = await mgr.probeLive("embedding", cfg.embedding);
      expect(live).toEqual([EMBED_PORT, 4242]);
      const live2 = await mgr.probeLive("chat", cfg.chat);
      expect(live2).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensure 外部实例复用（不杀不重启）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ms-"));
    try {
      const cfg = makeCfg(tmp);
      const mgr = new ModelServerManager(cfg, {
        registryPath: join(tmp, "registry.json"),
        fetchImpl: okFetch(),
        probeImpl: liveProbe([EMBED_PORT]),
      });
      dispatchExec((cmd) => {
        if (cmd === "netstat") return `  TCP    127.0.0.1:${EMBED_PORT}   0.0.0.0:0    LISTENING    4242\n`;
        return "";
      });
      const result = await mgr.ensure("embedding", cfg.embedding.model_path, "bge-m3");
      expect(result.ok).toBe(true);
      expect(result.state).toBe("external");
      expect(result.port).toBe(EMBED_PORT);
      const inst = mgr.status()[0];
      expect(inst.external).toBe(true);
      expect(inst.pid).toBeNull(); // 外部实例 backend 未 spawn，无 pid（Python 语义对照）
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ensure 孤儿回收后全新启动（自愈）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ms-"));
    try {
      const cfg = makeCfg(tmp);
      writeFileSync(join(tmp, "llama-server.exe"), "");
      writeFileSync(join(tmp, "bge.gguf"), "");
      const mgr = new ModelServerManager(cfg, {
        registryPath: join(tmp, "registry.json"),
        fetchImpl: okFetch(),
        probeImpl: liveProbe([EMBED_PORT]),
      });
      dispatchExec((cmd, args: string[]) => {
        if (cmd === "netstat") return `  TCP    127.0.0.1:${EMBED_PORT}   0.0.0.0:0    LISTENING    4242\n`;
        if (cmd === "wmic") return "ParentProcessId\n99999\n";
        // tasklist 按 PID 分派：查父 99999 → 已死（孤儿）；查子 4242 → llama-server（校验通过可回收）
        const pidArg = args.find((a) => a.startsWith("PID eq "))?.replace("PID eq ", "");
        if (pidArg === "99999") return "INFO: No tasks are running.";
        if (pidArg === "4242") return '"llama-server.exe","4242","Console","1","2,000,000 K"\n';
        return "";
      });
      const result = await mgr.ensure("embedding", cfg.embedding.model_path, "bge-m3");
      expect(result.ok).toBe(true);
      expect(result.state).toBe("ready");
      expect(result.port).toBe(EMBED_PORT);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const inst = mgr.status()[0];
      expect(inst.external).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
