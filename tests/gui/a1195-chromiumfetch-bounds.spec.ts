import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { chromiumFetch } from "../../gui/src/main/providers.js";

/**
 * A-1195（交接欠账 B7）：chromiumFetch 的重试是**有界**的，且与外层退避不构成
 * 「无限放大等待」。交接疑点原文：「内层重试 ×3 ⇒ 最坏 12 次/逻辑调用（未改）」。
 *
 * 收尾结论（落档在 providers.ts 的常量注释）：两层退避处理的是**不同错误域**
 * （HTTP 状态 vs 连接层）、共享同一超时窗口 ⇒ 总时长有界。本守卫钉住两点：
 *   ① 网络层持续失败时，chromiumFetch 在有限时间内 settle（不无限重试）；
 *   ② 内层次数的**唯一产地**常量不许被大幅上调（调大 = 重审叠加分析 + 本守卫）。
 *
 * ── 环境隔离（必需，勿删）────────────────────────────────────────────────
 * 本用例要考的是「连接层持续失败 ⇒ 重试有界」，前提是**请求真的发不出去**。
 * 但 chromiumFetch 直连失败 3 次后会走 resolveSystemProxy 兜底，那儿读
 * HTTP_PROXY 等环境变量 **+ Windows 注册表**的 ProxyEnable/ProxyServer。
 * 在「开着系统代理」的机器上，请求会被代理转发回来 ⇒ chromiumFetch **正常
 * resolve** ⇒ 断言崩。⇒ 「必然连接失败」这个前提此前是**借了本机恰好没开代理**，
 * 不是本测试自己 establish 的。
 *
 * 隔离手段：**改 child_process 这个 CJS 模块对象上的 execFileSync**，让注册表读
 * 固定回答「ProxyEnable=0x0」（= 系统代理关），并清掉全部代理环境变量。
 *
 * 为什么不用 vi.mock("node:child_process")：resolveSystemProxy 里是**运行时
 * require()**，不经过 vite 的模块图，vi.mock 拦不住（实测：桩一次都没被调用）。
 *
 * 为什么必须守一条「桩确实生效」的断言：桩一旦失效（resolveSystemProxy 换实现、
 * 或改用别的注册表读法），本用例会静默退回「拜机器环境所赐」——在没开代理的机器
 * 上照样绿，是典型假绿。regReads > 0 证明它确实问了注册表、且确实是桩给的答案。
 */

/** 走运行时 require 拿到与 providers.ts **同一个** child_process 模块对象。 */
const nodeRequire = createRequire(__filename);
const childProcess = nodeRequire("node:child_process") as {
  execFileSync: (file: string, args: string[], opts?: unknown) => string;
};
const realExecFileSync = childProcess.execFileSync;

/** 注册表 query 的应答：ProxyEnable=0x0 ⇒ resolveSystemProxy 判定「系统代理关」。 */
const REG_OFF =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" +
  "\\ProxyEnable    REG_DWORD    0x0\r\n";

/** resolveSystemProxy 会 consult 的全部代理环境变量（含大小写两种拼法）。 */
const PROXY_ENV_VARS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
] as const;

/** 本次用例内注册表被读的次数（= 桩是否真的被用上的证据）。 */
let regReads = 0;
/** 原代理环境变量的存档，afterEach 原样还原（别给 vitest 进程留残留）。 */
let savedProxyEnv: Record<string, string | undefined> = {};

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

let server: Server | null = null;
let base = "";

beforeEach(async () => {
  // ① 代理环境变量：清空并留档
  savedProxyEnv = {};
  for (const k of PROXY_ENV_VARS) {
    savedProxyEnv[k] = process.env[k];
    delete process.env[k];
  }

  // ② 注册表读：打桩成「系统代理关」，并计数
  regReads = 0;
  childProcess.execFileSync = ((file: string, args: string[]) => {
    regReads += 1;
    if (String(file).toLowerCase().includes("reg")) { return REG_OFF; }
    return realExecFileSync(file as never, args as never);
  }) as typeof childProcess.execFileSync;

  server = createServer((req) => {
    // 每个请求立即断开：逼出「连接层持续失败」的最坏路径
    req.socket.destroy();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  childProcess.execFileSync = realExecFileSync;
  for (const [k, v] of Object.entries(savedProxyEnv)) {
    if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
  }
  savedProxyEnv = {};
  await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

describe("A-1195 B7：chromiumFetch 重试有界性", () => {
  it("网络层持续失败 → 有限时间内 settle（reject），不无限重试", async () => {
    const t0 = Date.now();
    const out = await chromiumFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
      .then(() => "resolved")
      .catch(() => "rejected");
    const cost = Date.now() - t0;

    expect(out).toBe("rejected");
    // 内层 3 次（250/600ms 退避）：给足余量仍远小于"无限"
    expect(cost, `settle 用时 ${cost}ms —— 重试失去边界`).toBeLessThan(10_000);
    /* 前提是真的被建立出来的，不是拜「本机恰好没开代理」所赐。
       ⚠️ 2026-10-08：loopback 短路（resolveSystemProxy 对本机目标直接返回 null）落地后，
       **期望值反转** —— 本用例的目标是 127.0.0.1，正确的证据是「注册表一次都不被读」：
       读了多少次仍是桩参与判定的证据，只是新语义下这个数必须是 0。 */
    expect(
      regReads,
      "loopback 目标读了注册表 —— 「loopback 不走代理」的短路被移除；"
        + "此时 reject 又会退回「依赖本机代理状态」，须恢复短路",
    ).toBe(0);
  });

  it("loopback 目标在「系统代理开」的配置下也不读注册表（短路先于一切代理探测）", async () => {
    childProcess.execFileSync = ((file: string, args: string[]) => {
      regReads += 1;
      const a = (args ?? []).join(" ");
      if (String(file).toLowerCase().includes("reg")) {
        // 「代理开」的应答：ProxyEnable=0x1 + ProxyServer=127.0.0.1:10808
        if (a.includes("ProxyServer")) {
          return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyServer    REG_SZ    127.0.0.1:10808\r\n";
        }
        return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n";
      }
      return realExecFileSync(file as never, args as never);
    }) as typeof childProcess.execFileSync;

    const out = await chromiumFetch(`${base}/loopback-through-proxy`, { signal: AbortSignal.timeout(8000) })
      .then(() => "resolved")
      .catch(() => "rejected");
    expect(out).toBe("rejected");
    expect(regReads, "代理开的配置下 loopback 仍读了注册表 —— 短路位置不对（应在函数最前）").toBe(0);
  });

  it("接线形状：内层次数唯一产地为 FETCH_RETRY_ATTEMPTS=3（调大=重审叠加分析）", () => {
    const src = read("gui/src/main/providers.ts");
    expect(src).toMatch(/const FETCH_RETRY_ATTEMPTS = 3;/);
  });
});
