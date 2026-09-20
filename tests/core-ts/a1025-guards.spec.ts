/**
 * tests/core-ts/a1025-guards.spec.ts — S4「本地模型子系统：身份 / 状态 / 空闲回收」守卫。
 *
 * 这一族盯的是同一类病：**同一个事实有多个产地，且没有一方会抱怨**。
 *
 *  S4-A 身份：这个端口上跑的是哪个模型？此前只能靠**裸路径字符串**比较回答，
 *        而"同一个模型"在系统里有三种写法（用户填的、配置文件里的、相对 vs 绝对），
 *        任一处写法不同就永久判否 —— A-1017「模型已就绪却每轮弹加载面板」是这个病的一支。
 *        现改为给 llama-server 下发 `-a/--alias`，让**运行中的实例自述身份**。
 *
 *  S4-B 状态：端口上"有没有东西"此前只有布尔答案，于是**加载中**（503 `unavailable_error`）
 *        与"什么都没有"被压成同一个答案 → `probeLive` 判否 → `findFreePort` 跳过该端口
 *        → 在隔壁端口又拉起一个**同样的模型** → 白占双份显存。
 *        现在 `loading` 是一等状态：等它就绪并认领；等超时宁可报错也不重复拉起。
 *        同时把本机端点的 IO 原语收口到 `core-ts/src/local_server_io.ts`
 *        （此前只有 gui 层有，core-ts 用不到 → 才被迫各写一份探测）。
 *
 * ⚠️ 验收标准是**变异测试**（gui/scripts/mut-a1025-alias.mjs）：
 *    写完必须逐条把源码改坏、确认它变红。"通过但锁错对象"比没有守卫更糟。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import { spawn, execFileSync } from "node:child_process";
import { ModelServerManager, type ModelServerConfig } from "../../core-ts/src/model_server.js";
import { emptyCapability, type LocalServerCapability } from "../../core-ts/src/model_introspect.js";

const spawnMock = vi.mocked(spawn);
const execMock = vi.mocked(execFileSync);

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MODEL_SERVER = join(ROOT, "core-ts/src/model_server.ts");

/** 读文本并统一换行 —— 本仓库检出是 CRLF，`\n` 字面量断言会全线假红。 */
const read = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** 去注释：守卫必须盯**代码**。对注释敏感会把"写了解释"误判成"改了行为"。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 收集 core-ts/src 与 gui/src 下的全部实现文件（排除 d.ts 与产物目录）。
 *  放在模块级：S4-B 与 S4-D 都要用它做"全仓唯一产地 / 必须有生产读取者"的取证。 */
function implFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "dist") { continue; }
        walk(p);
      } else if (/\.tsx?$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) {
        out.push(p);
      }
    }
  };
  walk(join(ROOT, "core-ts/src"));
  walk(join(ROOT, "gui/src"));
  return out;
}

/** 跨进程契约：主进程入口。S4-D 的作废点就挂在这里。 */
const GUI_INDEX = join(ROOT, "gui/src/main/index.ts");

/** 测试专用高位端口（避开生产 8999/18082 与 model_server.spec.ts 的 19511/19521） */
const CHAT_PORT_START = 19731;
const FAKE_PID = 7391;

/** 夹具配置**按真实类型**声明（而非对象字面量推断）：否则 `embedding.idle_unload_min`
 *  这类真实存在的键会被窄化成"不存在"，守卫就只能靠 `as any` 硬塞。
 *  `chat` / `embedding` 在真实类型里是可选的，但夹具永远提供 → 收窄成必填，省掉断言噪音。 */
type TestCfg = Omit<ModelServerConfig, "chat" | "embedding"> & {
  chat: Record<string, unknown>;
  embedding: Record<string, unknown>;
};

function makeCfg(tmp: string): TestCfg {
  return {
    llama_bin: join(tmp, "llama-server.exe"),
    startup_timeout: 2,
    chat_est_gb: 4.0,
    embedding: { model_path: join(tmp, "bge.gguf"), port: 19711, gpu_layers: 99, ctx_len: 2048, persistent: true },
    chat: {
      models_dir: tmp,
      port_start: CHAT_PORT_START,
      gpu_layers: 99,
      ctx_len: 8192,
      persistent: false,
      idle_unload_min: 0,
    },
  };
}

/** execFileSync 按命令分派。**故意不返回 "llama-server"**：stop() 的校验会因此早退，
 *  不会掉进 processAlive 的 5s 等待循环（测试不该为了"优雅"多跑五秒）。 */
function dispatchExec(impl: (cmd: string, args: string[]) => string) {
  execMock.mockImplementation(((cmd: string, args: string[]) => impl(cmd, args)) as never);
}

const okFetch = (): typeof fetch =>
  (async () => ({ status: 200, json: async () => ({ status: "ok" }) })) as unknown as typeof fetch;

/** S4-B：probeImpl 返回**能力快照**（三态 state + 服务器自述身份） */
const readyCap = (alias?: string): LocalServerCapability =>
  ({ ...emptyCapability("ready"), effectiveCtx: 8192, alias: alias ?? null });
const loadingCap = (): LocalServerCapability => emptyCapability("loading");

const liveProbe = (ports: number[]) =>
  async (port: number) => (ports.includes(port) ? readyCap() : emptyCapability("down"));

/** 一套夹具：llama-server + 模型文件都"存在"，无活实例，无 GPU（跳过显存预检）。 */
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "a1025-"));
  writeFileSync(join(tmp, "llama-server.exe"), "");
  writeFileSync(join(tmp, "model-a.gguf"), "");
  writeFileSync(join(tmp, "model-b.gguf"), "");
  const cfg = makeCfg(tmp);
  const mgr = new ModelServerManager(cfg, {
    registryPath: join(tmp, "registry.json"),
    fetchImpl: okFetch(),
    probeImpl: liveProbe([]),
  });
  return { tmp, cfg, mgr };
}

/** 从第 n 次 spawn 调用里取 argv */
function argvOf(call = 0): string[] {
  return (spawnMock.mock.calls[call]?.[1] ?? []) as string[];
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnMock.mockReturnValue({ pid: FAKE_PID, kill: vi.fn() } as never);
  // 默认：nvidia-smi / tasklist 全部返回空 → 无 GPU、无存活 PID
  dispatchExec(() => "");
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════
// S4-A 行为：别名真的下发到 llama-server 的 argv 里
// ══════════════════════════════════════════════════════════

describe("S4-A：--alias 下发到真实 spawn 的 argv", () => {
  it("ensure(chat, path, id) → argv 带 `-a <id>`，路径仍照常下发", async () => {
    const { tmp, mgr } = fixture();
    try {
      const modelPath = join(tmp, "model-a.gguf");
      const result = await mgr.ensure("chat", modelPath, "qwen3-1.7b");
      expect(result.ok).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      const argv = argvOf(0);
      expect(argv[argv.indexOf("-a") + 1]).toBe("qwen3-1.7b");
      expect(argv[argv.indexOf("-m") + 1]).toBe(modelPath);
      // 别名不得破坏既有参数（防重排 argv 时把 -ngl/-c 弄丢）
      expect(argv[argv.indexOf("-c") + 1]).toBe("8192");
      expect(argv).toContain("--reasoning-format");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("id 含逗号 → argv 里的别名已被清洗（逗号是 --alias 的列表分隔符）", async () => {
    const { tmp, mgr } = fixture();
    try {
      await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3,1.7b");
      const got = argvOf(0)[argvOf(0).indexOf("-a") + 1];
      expect(got).toBe("qwen3_1.7b");
      expect(got).not.toContain(",");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("没有 id（走 models_dir 兜底）→ 别名取文件名去扩展名，仍然下发", async () => {
    const { tmp, mgr } = fixture();
    try {
      // 传空 modelName：ensureLocked 会用 models_dir 里排序第一的 gguf 兜底
      const result = await mgr.ensure("chat", "", "");
      expect(result.ok).toBe(true);
      const argv = argvOf(0);
      expect(argv[argv.indexOf("-a") + 1]).toBe("model-a");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════
// S4-A 行为：复用判同改为「别名优先」
// ══════════════════════════════════════════════════════════

describe("S4-A：复用判同别名优先（路径写法不再决定身份）", () => {
  /** 造一个"进程活着 + /health ok"的假象，让 reuseIfReady 能走到复用分支 */
  function withLivePid() {
    dispatchExec((cmd, args) => {
      if (cmd === "tasklist") {
        const pidArg = args.find((a) => a.startsWith("PID eq "))?.replace("PID eq ", "");
        // 只回 PID 本身、不回 "llama-server"：processAlive=true，verifyLlamaServerPid=false
        return pidArg === String(FAKE_PID) ? `${FAKE_PID}\n` : "INFO: No tasks are running.";
      }
      return "";
    });
  }

  it("★ 别名相同 + 路径写法不同 → 复用（不重启）。这正是路径比较会判否的场景", async () => {
    const { tmp, mgr } = fixture();
    try {
      const real = join(tmp, "model-a.gguf");
      const first = await mgr.ensure("chat", real, "qwen3");
      expect(first.ok).toBe(true);
      expect(first.state).toBe("ready");
      const port = first.port;
      withLivePid();

      // 同一个模型，但调用方这次拿的是**另一个路径字符串**（如配置里存的相对路径）
      const second = await mgr.ensure("chat", "models/chat/qwen3.gguf", "qwen3");
      expect(second.ok).toBe(true);
      expect(second.state).toBe("reused");
      expect(second.port).toBe(port);
      expect(spawnMock).toHaveBeenCalledTimes(1); // ★ 没有第二次拉起
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("★ 别名不同（哪怕路径字符串相同）→ 不复用，卸载旧实例后重载", async () => {
    const { tmp, mgr } = fixture();
    try {
      const samePath = join(tmp, "model-a.gguf");
      const first = await mgr.ensure("chat", samePath, "qwen3");
      expect(first.ok).toBe(true);
      withLivePid();

      const second = await mgr.ensure("chat", samePath, "qwen3-v2");
      expect(second.ok).toBe(true);
      expect(second.state).not.toBe("reused");
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(argvOf(1)[argvOf(1).indexOf("-a") + 1]).toBe("qwen3-v2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("别名不同但模型文件不同 → 同样重载（别名与路径判据同向时不冲突）", async () => {
    const { tmp, mgr } = fixture();
    try {
      await mgr.ensure("chat", join(tmp, "model-a.gguf"), "a");
      withLivePid();
      const second = await mgr.ensure("chat", join(tmp, "model-b.gguf"), "b");
      expect(second.state).not.toBe("reused");
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════
// S4-B 行为：加载中是**一等状态**，绝不重复拉起同一个模型
// ══════════════════════════════════════════════════════════

describe("S4-B：端口上已有实例正在加载 → 等它，不重复拉起", () => {
  /** 造一个 tmp 工作区 + 按需构造管理器（`startup_timeout` 是**构造期**读取的，
   *  所以必须在 `new ModelServerManager` 之前改 cfg，不能事后改）。 */
  function makeEnv(probeImpl: (port: number) => Promise<LocalServerCapability>, startupTimeout: number) {
    const tmp = mkdtempSync(join(tmpdir(), "a1025-"));
    writeFileSync(join(tmp, "llama-server.exe"), "");
    writeFileSync(join(tmp, "model-a.gguf"), "");
    const cfg = { ...makeCfg(tmp), startup_timeout: startupTimeout };
    const mgr = new ModelServerManager(cfg, {
      registryPath: join(tmp, "registry.json"),
      fetchImpl: okFetch(),
      probeImpl,
    });
    return { tmp, cfg, mgr };
  }

  /** 加载中的端口：前 N 次探测报 loading，之后报 ready（模拟加载完成） */
  function loadingThenReady(port: number, flipsAfter: number) {
    let n = 0;
    return async (p: number): Promise<LocalServerCapability> => {
      if (p !== port) { return emptyCapability("down"); }
      n += 1;
      return n > flipsAfter ? readyCap() : loadingCap();
    };
  }

  it("★ 探测到 loading → 不 spawn，等就绪后认领为 external", async () => {
    const { tmp, mgr } = makeEnv(loadingThenReady(CHAT_PORT_START, 1), 10);
    try {
      const result = await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3");
      expect(result.ok).toBe(true);
      expect(result.state).toBe("external");
      expect(result.port).toBe(CHAT_PORT_START);
      expect(spawnMock, "★ 端口上有实例在加载时绝不能再 spawn 一个（双份显存）").not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("★ 加载等待超时 → 返回明确错误，**依然不 spawn**（还在载 = 不能重复拉起）", async () => {
    const { tmp, mgr } = makeEnv(
      async (p) => (p === CHAT_PORT_START ? loadingCap() : emptyCapability("down")),
      1,
    );
    try {
      const result = await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3");
      expect(result.ok).toBe(false);
      expect(result.error).toContain(String(CHAT_PORT_START));
      expect(result.error).toContain("正在加载");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("加载中的实例**死掉**（探测转 down）→ 允许全新拉起（这不是双份）", async () => {
    let n = 0;
    const { tmp, mgr } = makeEnv(async (p) => {
      if (p !== CHAT_PORT_START) { return emptyCapability("down"); }
      n += 1;
      // 第 1 次（probeLive 扫描）报 loading；之后（等待循环）报 down = 进程没了
      return n === 1 ? loadingCap() : emptyCapability("down");
    }, 10);
    try {
      const result = await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3");
      expect(result.ok).toBe(true);
      expect(result.state).toBe("ready");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("★ 等待期间状态**抖动**（就绪后又变回 loading）→ 仍拒绝，不许拉起第二个", async () => {
    /* 两次探测之间状态抖动是真实存在的（大模型加载会被并发请求打断/重排）。
     * 这道闸门的意义：只要**最终**不是 ready/down，就既不能认领也不能重拉 —— 宁可报错。 */
    let n = 0;
    const { tmp, mgr } = makeEnv(async (p) => {
      if (p !== CHAT_PORT_START) { return emptyCapability("down"); }
      n += 1;
      if (n === 1) { return loadingCap(); }  // probeLive 扫描：加载中
      if (n === 2) { return readyCap(); }    // 等待循环：就绪
      return loadingCap();                   // 重新探测：又回到加载中（抖动）
    }, 10);
    try {
      const result = await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3");
      expect(result.ok).toBe(false);
      expect(spawnMock, "最终状态不是 ready/down 时绝不许往下走（会起第二个同模型进程）").not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("★ 就绪但自述是**另一个模型**的实例 → 跳过不认领（别把 B 的端口当成 A 的）", async () => {
    const { tmp, mgr } = makeEnv(
      async (p) => (p === CHAT_PORT_START ? readyCap("other-model") : emptyCapability("down")),
      10,
    );
    try {
      const result = await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3");
      // 不能认领别人的端口：要么另起一个（真实"未加载"语义），要么明确报错；总之不许回 external
      expect(result.state).not.toBe("external");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════
// S4-C 行为：空闲卸载前必须先问服务器「你忙不忙」
// ══════════════════════════════════════════════════════════

describe("S4-C：空闲到点先问 /slots，忙就不卸", () => {
  /** 管理器的 `_idle` 是私有的、计时器最短 1 分钟 —— 直接测 `touch` + 手动触发那条路径
   *  既慢又脆。这里用 `vi.useFakeTimers` 把 1 分钟压成瞬时。 */
  function busyFetch(slotsBody: unknown, ok = true): typeof fetch {
    return (async (url: string) => {
      if (String(url).endsWith("/slots")) {
        return { ok, status: ok ? 200 : 404, json: async () => slotsBody };
      }
      return { status: 200, json: async () => ({ status: "ok" }) };
    }) as unknown as typeof fetch;
  }

  /** 造一个"已就绪的 chat 实例"，并把 idle_unload_min 设成 1 分钟 */
  async function readyChatMgr(fetchImpl: typeof fetch) {
    const tmp = mkdtempSync(join(tmpdir(), "a1025-"));
    writeFileSync(join(tmp, "llama-server.exe"), "");
    writeFileSync(join(tmp, "model-a.gguf"), "");
    const cfg = { ...makeCfg(tmp), startup_timeout: 5 };
    cfg.chat.idle_unload_min = 1;
    const mgr = new ModelServerManager(cfg, {
      registryPath: join(tmp, "registry.json"),
      fetchImpl,
      probeImpl: liveProbe([]),
    });
    const r = await mgr.ensure("chat", join(tmp, "model-a.gguf"), "qwen3");
    expect(r.ok).toBe(true);
    return { tmp, mgr, port: r.port! };
  }

  afterAll(() => {
    vi.useRealTimers();
  });

  it("★ 服务器报「正在生成」→ **不卸载**（修「长生成被中途杀掉」）", async () => {
    vi.useFakeTimers();
    try {
      const { tmp, mgr } = await readyChatMgr(busyFetch([{ id: 0, is_processing: true }]));
      await vi.advanceTimersByTimeAsync(61_000);
      // 仍在服务：状态还是 ready（没有 release）
      expect(mgr.getPort("chat")).toBeGreaterThan(0);
      expect(mgr.status().find((s) => s.role === "chat")?.state).toBe("ready");
      rmSync(tmp, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("服务器报空闲（全 false）→ 卸载（该省的显存要省下来）", async () => {
    vi.useFakeTimers();
    try {
      const { tmp, mgr } = await readyChatMgr(busyFetch([{ id: 0, is_processing: false }]));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(mgr.status().find((s) => s.role === "chat")?.state).toBe("idle");
      rmSync(tmp, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ 问不进去（探测抛异常）→ 保守**不卸载**（负载最高时最容易超时，那正是最忙的时候）", async () => {
    vi.useFakeTimers();
    try {
      const throwing = (async (url: string) => {
        if (String(url).endsWith("/slots")) { throw new TypeError("fetch failed"); }
        return { status: 200, json: async () => ({ status: "ok" }) };
      }) as unknown as typeof fetch;
      const { tmp, mgr } = await readyChatMgr(throwing);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(mgr.status().find((s) => s.role === "chat")?.state).toBe("ready");
      rmSync(tmp, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("端点不存在（404 / 非槽位数组）→ 视为空闲并卸载（它明确回答了「没有槽位」）", async () => {
    vi.useFakeTimers();
    try {
      const { tmp, mgr } = await readyChatMgr(busyFetch({ detail: "not found" }, false));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(mgr.status().find((s) => s.role === "chat")?.state).toBe("idle");
      rmSync(tmp, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ embedding 的空闲 TTL 不再是「没有读取者的开关」（persistent=false 时必须生效）", () => {
    const { tmp, mgr, cfg } = (() => {
      const tmp = mkdtempSync(join(tmpdir(), "a1025-"));
      writeFileSync(join(tmp, "llama-server.exe"), "");
      writeFileSync(join(tmp, "bge.gguf"), "");
      const cfg = { ...makeCfg(tmp), startup_timeout: 5 };
      cfg.embedding.persistent = false;
      cfg.embedding.idle_unload_min = 1;
      const mgr = new ModelServerManager(cfg, {
        registryPath: join(tmp, "registry.json"),
        fetchImpl: okFetch(),
        probeImpl: liveProbe([]),
      });
      return { tmp, mgr, cfg };
    })();
    const s = stripComments(read(MODEL_SERVER));
    // 结构断言：不许再有 `role === "embedding"` 的无条件早退
    expect(s, "embedding 又被无条件跳过 → 用户设的 idle_unload_min 再次成为死开关")
      .not.toMatch(/idleMin <= 0 \|\| role === "embedding"/);
    expect(s, "常驻实例的跳过理由必须写明（否则又变成静默失效）").toContain("persistent = true");
    rmSync(tmp, { recursive: true, force: true });
    void mgr; void cfg;
  });
});

describe("S4-B 结构：三态与 IO 原语的单一产地", () => {
  const src = () => stripComments(read(MODEL_SERVER));
  const IO = join(ROOT, "core-ts/src/local_server_io.ts");
  const GUI_PROBE = join(ROOT, "gui/src/main/localServerProbe.ts");

  it("probeImpl 的返回类型必须是**能力快照**（布尔把 loading 与「什么都没有」压成同一个答案）", () => {
    const s = src();
    expect(s).toMatch(/probeImpl\??:\s*\(port: number\) => Promise<LocalServerCapability>/);
    expect(s, "回到布尔就是本轮重复拉起的根因复活").not.toMatch(/probeImpl\??:\s*\(port: number\) => Promise<boolean>/);
  });

  it("★ 探测到的 loading 必须有**等待**路径（否则仍在加载的实例会被当成不存在 → 重复拉起）", () => {
    const s = src();
    expect(s, "缺少等待逻辑").toContain("private async waitExternalReady(");
    expect(s, "probeLive 必须能区分 loading 与 down").toContain('cap.state === "loading"');
  });

  it("★ 等待超时**必须 return**，绝不许落到下方的 backend.start（那会起第二个同模型进程）", () => {
    const s = src();
    // 超时分支里出现"正在加载"那句文案 + 紧跟一个 return
    const idx = s.indexOf("上已有 llama-server 正在加载，等待");
    expect(idx, "超时文案不见了（说明超时被当成可继续的情形）").toBeGreaterThan(0);
    const before = s.slice(Math.max(0, idx - 400), idx);
    expect(before, "超时分支必须有 return，不能继续往下走").toMatch(/if \(outcome === "timeout"\) \{\s*return \{/);
  });

  it("★ 认领前必须显式收紧状态（只允许 ready / down 往下走）", () => {
    const s = src();
    expect(s).toMatch(/if \(cap\.state !== "ready" && cap\.state !== "down"\) \{/);
  });

  it("probe 与 probeState 同源：ready 布尔只是三态判定的投影", () => {
    const s = src();
    expect(s, "三态判定没有复用 classifyLocalServer").toMatch(/return classifyLocalServer\(status, body\);/);
    expect(s, "probe 不再从三态派生").toMatch(/async probe\(port: number\): Promise<boolean> \{\s*\n\s*return \(await this\.probeState\(port\)\) === "ready";/);
  });

  it("★ 本机端点拼接只有一处实现（`${stripApiSuffix(base)}/props` 全仓唯一）", () => {
    const hits: string[] = [];
    for (const f of implFiles()) {
      if (stripComments(read(f)).includes("${stripApiSuffix(base)}/props")) {
        // Windows 路径分隔符是 `\`，断言里用 `/`（本仓库其余路径断言同理，别在这里假红）
        hits.push(f.replace(ROOT, "").replace(/\\/g, "/"));
      }
    }
    expect(hits, `端点拼接出现了第二产地：${hits.join(", ")}`).toEqual(["core-ts/src/local_server_io.ts"]);
  });

  it("★ GUI 探针层不得再私自实现传输（getJson / stripApiSuffix 必须来自 core-ts）", () => {
    const g = stripComments(read(GUI_PROBE));
    expect(g, "GUI 又写了一份 HTTP GET").not.toContain("async function getJson");
    expect(g, "GUI 又写了一份版本尾巴剥离").not.toContain("function stripApiSuffix");
    expect(g, "GUI 没有从 core-ts 的 IO 原语 re-export（既有 import 路径会断）")
      .toContain('from "../../../core-ts/src/local_server_io.js"');
  });

  it("IO 原语模块只做 IO：不得自己判定状态（状态判定只许在 model_introspect）", () => {
    const io = stripComments(read(IO));
    expect(io).toContain("readLocalCapability(");
    // 不许在 IO 层出现"自己看状态码下结论"的写法
    expect(io).not.toMatch(/status === 200/);
    expect(io).not.toMatch(/state\s*=\s*"(ready|loading|down)"/);
  });
});

// ══════════════════════════════════════════════════════════
// S4-A 结构：单一产地
// ══════════════════════════════════════════════════════════

describe("S4-A 结构：别名清洗 / 身份判据 / argv 产地都必须唯一", () => {
  const src = () => stripComments(read(MODEL_SERVER));

  it("argv 里下发的是**清洗后**的别名，不是原始字符串", () => {
    expect(src()).toMatch(/const alias = sanitizeAlias\(args\.alias\);/);
    expect(src()).toMatch(/argv\.push\("-a", alias\);/);
  });

  it("清洗实现只有一处：`replace(/,/g` 在 model_server.ts 里只出现在 sanitizeAlias 内", () => {
    const hits = src().split("replace(/,/g").length - 1;
    expect(hits, "逗号清洗被复制成了第二份产地").toBe(1);
  });

  it("★ 身份判据只有一个实现（sameModel），定义 1 处 + 调用 2 处", () => {
    const s = src();
    expect(s.split("private sameModel(").length - 1).toBe(1);
    expect(s.split("this.sameModel(").length - 1, "复用判同 / 切换检测必须共用同一判据").toBe(2);
  });

  it("★ 不能复活裸路径比较（那是被 sameModel 取代的旧判据）", () => {
    const s = src();
    expect(s, "复用判同又回到裸路径比较").not.toMatch(/inst\.model_path !== matchModel/);
    expect(s, "切换检测又回到裸路径比较").not.toMatch(/prev\.model_path !== modelPath/);
  });

  it("★ 别名既记录在实例上、又真的传给 backend.start（只做一半 = 身份静默失效）", () => {
    const s = src();
    expect(s, "实例未记录别名 → 下次复用无从判同").toMatch(/alias: target\(\)\.alias/);
    expect(s, "别名没传给 llama-server → 实例自述的仍是路径").toMatch(/backend\.start\(\{[^}]*alias:/);
  });

  it("★ 外部采纳的实例只许写**服务器自述**的别名（S4-B 起问得到；不许填「我们想要的」）", () => {
    const s = src();
    const marks = s.split("external: true,");
    expect(marks.length - 1, "外部采纳路径应当只有一处").toBe(1);
    // 从 `external: true,` 到该对象字面量收尾之间：
    //   必须有 cap.alias（服务器自述 = 真身份）
    //   不许有 modelName / target()（那是"我们想要的" = 编造的身份，会让下游比对**通过**）
    const tail = marks[1]!.slice(0, marks[1]!.indexOf("};"));
    expect(tail, "外部实例必须记录服务器自述的别名").toContain("cap.alias");
    expect(tail, "外部实例不许把「我们想要的别名」写成身份").not.toContain("modelName");
    expect(tail).not.toContain("target()");
  });
});

// ══════════════════════════════════════════════════════════
// S4-D 跨进程契约：能力缓存必须被生命周期事件作废
// ══════════════════════════════════════════════════════════

describe("S4-D 契约：能力缓存的作废点必须真实存在（开关必须有读取者）", () => {
  it("★ clearLocalCapabilityCache 必须有**生产读取者**（此前只有测试在调 → 注释在说谎）", () => {
    const users: string[] = [];
    for (const f of implFiles()) {
      if (f.endsWith("localServerProbe.ts")) { continue; } // 定义处不算读取者
      if (stripComments(read(f)).includes("clearLocalCapabilityCache(")) {
        users.push(f.replace(ROOT, "").replace(/\\/g, "/"));
      }
    }
    expect(
      users,
      "clearLocalCapabilityCache 没有生产读取者 → 「模型切换/服务重启时清缓存」是假的，" +
        "切换后最多 2s 会拿上一个模型的 n_ctx（A-1018 ③）",
    ).toContain("gui/src/main/index.ts");
  });

  it("★ 作废点必须挂在 onChatState 上，且早于窗口判空（无窗口时也要作废）", () => {
    const s = stripComments(read(GUI_INDEX));
    const at = s.indexOf("onChatState: (ev) => {");
    expect(at, "onChatState 订阅点不见了（守卫锚点失效）").toBeGreaterThan(0);
    const tail = s.slice(at, at + 900);
    const inv = tail.indexOf("clearLocalCapabilityCache()");
    const guard = tail.indexOf("w.isDestroyed()");
    expect(inv, "状态迁移没有作废能力缓存 → 同端口换模型后按旧模型显示窗口").toBeGreaterThan(-1);
    expect(guard, "窗口判空不见了（守卫锚点失效）").toBeGreaterThan(-1);
    expect(inv, "作废必须早于窗口判空：否则无窗口时分支出去了，缓存永不失效").toBeLessThan(guard);
  });

  it("★ probeManagedChatCapability 问询时**不传 alias** → key 退化成「端口」，同端口换模型必然命中旧条目", () => {
    /* 这条断言锁的是"为什么必须靠事件作废、而不能靠缓存 key 自己分开"。
     * `getLocalCapability` 的 key 形如 `base|alias`，但下面这个调用点不传 alias，
     * 于是 alias 恒为 "" —— 模型切换发生在**同一个端口**上时 key 完全相同。 */
    const p = stripComments(read(join(ROOT, "gui/src/main/localServerProbe.ts")));
    const at = p.indexOf("export async function probeManagedChatCapability");
    expect(at, "函数不见了").toBeGreaterThan(0);
    const body = p.slice(at);
    expect(
      body,
      "若将来这里改成传 alias，key 就能按模型分开 —— 届时本条守卫的结论需重新论证（别默默放宽）",
    ).toMatch(/getLocalCapability\(`http:\/\/127\.0\.0\.1:\$\{port\}`\)/);
  });
});
