/**
 * tests/gui/a1110-devtools-port.spec.ts — CDP（远程调试）端口选择与发布的守卫（A-1110）。
 *
 * ## 为什么这一整套必须有守卫（症状是"两条看不懂的英文报错"）
 *
 * 用户截图（`pnpm dev` 的调试面板）：
 * ```
 * ERROR:tcp_socket_win.cc(458)] bind() returned an error: …只允许使用一次。(0x2740)
 * ERROR:devtools_http_handler.cc(313)] Cannot start http server for devtools.
 * ```
 * 根因：端口**硬编码 9222**，而 Chromium 的 devtools http server **不会自己换端口**，
 * 一旦被占就 bind 失败 ⇒ **整套 CDP 能力静默消失**（`verify-packaged.mjs`、agent-browser 全哑），
 * 用户只看到两句英文。
 *
 * 这一类缺陷的守卫必须**行为级**：它过 tsc、过构建、过所有其它测试，只在真启动时翻车。
 * 所以本文件对纯逻辑直接调函数（不读文本猜），只对**接线**（`index.ts`）做静态判据。
 *
 * ⚠️ 三处**反向静默失效**是本文件的重点（改了照样绿、但行为悄悄变坏）：
 *   ① 判定退化成「在整份 netstat 输出里搜 `:9222`」⇒ **对端端口**被当成占用 ⇒ 空闲端口白让位；
 *   ② 环境变量非法值（`abc` / `-1` / `99999`）被当成端口用 ⇒ `NaN` / 越界值交给 Chromium；
 *   ③ 探针拿不到事实 vs 端口真的空闲 —— 两者**不能并成一支**（A-1051 家族）。
 *
 * ⚠️ 探针必须**同步**：`app.commandLine.appendSwitch("remote-debugging-port", …)` 只能在 `ready`
 *   之前调用，ready 之后调用**不生效**。异步探针会把整件事静默推到"本次根本没开 CDP"
 *   （连报错都没有，比原来的红字更难查）。所以下面有一条**行为**断言：`listeningPortsSync`
 *   必须**同步返回 Set**（一旦被改成 async，返回值变成 Promise ⇒ 本用例响亮报错）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEVTOOLS_PORT_ENV,
  DEVTOOLS_PORT_DEFAULT,
  DEVTOOLS_PORT_SCAN,
  DEVTOOLS_PORT_FILE,
  parseListeningPorts,
  pickDevtoolsPort,
  resolveDevtoolsPort,
  listeningPortsCommand,
  listeningPortsSync,
  parseDevToolsActivePort,
  writeDevtoolsPortFile,
  readDevtoolsPortFile,
} from "../../gui/src/main/devtoolsPort.js";

const ROOT = resolve(__dirname, "../..");
const MAIN = readFileSync(resolve(ROOT, "gui/src/main/index.ts"), "utf8");
const MODULE_SRC = readFileSync(resolve(ROOT, "gui/src/main/devtoolsPort.ts"), "utf8");

/** 真实形态的 `netstat -ano -p tcp` 片段（缩进与列顺序照抄） */
const NETSTAT_WIN32 = [
  "活动连接",
  "",
  "  协议  本地地址          外部地址        状态           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1060",
  "  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       107672",
  "  TCP    127.0.0.1:54321        127.0.0.1:9222         ESTABLISHED     107672",
  "  TCP    [::]:9223              [::]:0                 LISTENING       107672",
].join("\r\n");

/** ⚠️ 反面样本：`9222` **只作为对端**出现（没有任何一行在 9222 上监听） */
const NETSTAT_WIN32_PEER_ONLY = [
  "  协议  本地地址          外部地址        状态           PID",
  "  TCP    127.0.0.1:54321        127.0.0.1:9222         ESTABLISHED     107672",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1060",
].join("\r\n");

const SS_LINUX = [
  "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
  "LISTEN 0      511          0.0.0.0:9222       0.0.0.0:*",
  "LISTEN 0      4096               [::]:9223          [::]:*",
  "ESTAB 0      0      127.0.0.1:50123    127.0.0.1:9224",
  "LISTEN 0      128            0.0.0.0:22         0.0.0.0:*",
].join("\n");

const LSOF_DARWIN = [
  "COMMAND   PID USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
  "node    1234   me   21u  IPv4  0x123      0t0  TCP *:9222 (LISTEN)",
  "node    1234   me   22u  IPv6  0x124      0t0  TCP *:9223 (LISTEN)",
  "node    9999   me   30u  IPv4  0x125      0t0  TCP 127.0.0.1:50123->127.0.0.1:9224 (ESTABLISHED)",
].join("\n");

describe("A-1110 ① `parseListeningPorts`：只认**监听**行（对端端口绝不算占用）", () => {
  it("win32：取 LISTENING 行上的端口（含 IPv6），**且不把 0 收进来**", () => {
    const ports = parseListeningPorts(NETSTAT_WIN32, "win32");
    expect(ports.has(9222), "netstat 里明明有 LISTENING 9222").toBe(true);
    expect(ports.has(9223), "IPv6 形态 [::]:9223 也要认出来").toBe(true);
    expect(ports.has(135)).toBe(true);
    /* ⚠️ 对端列是 `0.0.0.0:0` —— 端口 0 不是"被占用的端口"。收进来会让
       `pickDevtoolsPort(0, …)` 之类的调用被污染（0 是"交系统分配"的哨兵值）。 */
    expect(ports.has(0), "端口 0（对端列）被当成了监听端口").toBe(false);
  });

  it("win32 反面：`9222` 只出现在 ESTABLISHED 行的**对端**列 ⇒ 不得算作占用", () => {
    /* 这是本模块头节点名的**反向静默失效**：退化实现（整份输出里搜 `:9222`）会让一个
       **空闲**的 9222 被误判为占用 ⇒ CDP 白白让位到 9223，而用户永远不知道为什么。 */
    const ports = parseListeningPorts(NETSTAT_WIN32_PEER_ONLY, "win32");
    expect(ports.has(9222), "把对端端口 9222 当成监听端口了（空闲端口被误判为占用）").toBe(false);
    expect(ports.has(54321), "本地端口 54321 出现在 ESTABLISHED 行上，不算监听").toBe(false);
    expect(ports.has(135)).toBe(true);
  });

  it("linux `ss -ltn` / darwin `lsof`：同一判据（marker 分别是 LISTEN / (LISTEN)）", () => {
    const s = parseListeningPorts(SS_LINUX, "linux");
    expect(s.has(9222)).toBe(true);
    expect(s.has(9223)).toBe(true);
    expect(s.has(9224), "ESTAB 行上的 9224 不算监听").toBe(false);
    expect(s.has(22)).toBe(true);

    const d = parseListeningPorts(LSOF_DARWIN, "darwin");
    expect(d.has(9222)).toBe(true);
    expect(d.has(9223)).toBe(true);
    /* 反面：`->127.0.0.1:9224` 是**对端**（ESTABLISHED），不许收。 */
    expect(d.has(9224), "lsof 的 ESTABLISHED 行被当成了监听").toBe(false);
  });

  it("linux marker `LISTEN` 不会误吞 win32 的 `LISTENING`（反向亦然）", () => {
    /* `\bLISTEN\b` 在 `LISTENING` 上**没有**词尾边界 ⇒ 不匹配。这条锁的是"两种 marker 各管各的"，
       免得有人把两边统一成一个宽松正则（那会让 win32 输出在 linux 分支下全被当监听）。 */
    expect(parseListeningPorts("TCP 0.0.0.0:9222 0.0.0.0:0 LISTENING 1", "linux").has(9222)).toBe(false);
    expect(parseListeningPorts("TCP 0.0.0.0:9222 0.0.0.0:0 LISTENING 1", "win32").has(9222)).toBe(true);
  });
});

describe("A-1110 ② `pickDevtoolsPort`：空闲即用 / 被占顺延 / 窗口满就交系统", () => {
  it("首选空闲 ⇒ 用首选；被占 ⇒ 顺着往上找第一个空闲", () => {
    expect(pickDevtoolsPort(9222, new Set())).toBe(9222);
    expect(pickDevtoolsPort(9222, new Set([9999]))).toBe(9222);
    expect(pickDevtoolsPort(9222, new Set([9222]))).toBe(9223);
    expect(pickDevtoolsPort(9222, new Set([9222, 9223, 9224]))).toBe(9225);
  });

  it("`preferred === 0` 直接透传（用户显式要「随便给一个」）—— 哪怕 0 出现在占用集里", () => {
    /* ⚠️ 这一条**专门**给"删掉 `preferred === 0` 直通"这个等价变异体留的区分度：
       写成 `if (!listening.has(preferred)) return preferred;` 时，占用集里**含 0** 就会走进顺延分支
       ⇒ 返回 9223，而不是用户要的 0。 */
    expect(pickDevtoolsPort(0, new Set())).toBe(0);
    expect(pickDevtoolsPort(0, new Set([0])), "0 是哨兵值，不该被「占用」影响").toBe(0);
  });

  it("顺延窗口全占 ⇒ 返回 0（交系统分配临时端口，绝不再报 bind 失败）", () => {
    const full = new Set<number>();
    for (let i = 0; i <= DEVTOOLS_PORT_SCAN; i++) { full.add(DEVTOOLS_PORT_DEFAULT + i); }
    expect(pickDevtoolsPort(DEVTOOLS_PORT_DEFAULT, full), "窗口全占时必须回落 0").toBe(0);
    /* scan = 0 ⇒ 没有候选 ⇒ 首选被占就是 0（不放宽、也不发明端口）。 */
    expect(pickDevtoolsPort(9222, new Set([9222]), 0)).toBe(0);
  });

  it("候选越过 65535 就停（不产出非法端口）", () => {
    expect(pickDevtoolsPort(65535, new Set([65535])), "越界时必须回落 0，不能返回 65536").toBe(0);
    expect(pickDevtoolsPort(65534, new Set([65534]))).toBe(65535);
  });
});

describe("A-1110 ③ `resolveDevtoolsPort`：env 优先，非法值回落默认（绝不用 NaN 当端口）", () => {
  it("未给 env ⇒ 默认 9222、explicit=false、reason=free", () => {
    expect(resolveDevtoolsPort(undefined, new Set())).toEqual({
      port: 9222, preferred: 9222, explicit: false, reason: "free",
    });
    expect(resolveDevtoolsPort("", new Set()).explicit, "空串等于没给").toBe(false);
    expect(resolveDevtoolsPort("   ", new Set()).explicit, "纯空白等于没给").toBe(false);
  });

  it("env 合法 ⇒ 显式优先（含前后空白；顺延时 reason=shifted 且 explicit 仍为 true）", () => {
    expect(resolveDevtoolsPort("9223", new Set())).toEqual({
      port: 9223, preferred: 9223, explicit: true, reason: "free",
    });
    expect(resolveDevtoolsPort("  9224  ", new Set()).preferred, "前后空白要 trim").toBe(9224);
    const shifted = resolveDevtoolsPort("9222", new Set([9222]));
    expect(shifted).toEqual({ port: 9223, preferred: 9222, explicit: true, reason: "shifted" });
  });

  it("顺延必须基于**用户指定的**端口（env=9300 被占 ⇒ 9301/9302…，不是回默认 9222 起算）", () => {
    /* ⚠️ 这条是本轮实跑逼出来的：把 `const candidate = preferred + i` 写成
       `DEVTOOLS_PORT_DEFAULT + i` 时，**下面这些用例原先一条都不红** —— 因为我当时只用过
       `preferred === 9222` 的场景（那时两者恒等 ⇒ 变异体等价 ⇒ 守卫没锁住它）。
       `SLIME_DEVTOOLS_PORT=9300`（用户显式指定）被占时，顺延必须从 9300 起算：
       从 9222 起算会给出一个**用户没要过**的端口，而用户还在等 9300 上的那个实例。 */
    expect(resolveDevtoolsPort("9300", new Set([9300])))
      .toEqual({ port: 9301, preferred: 9300, explicit: true, reason: "shifted" });
    expect(resolveDevtoolsPort("9300", new Set([9300, 9301])), "顺延要能连续跳过多个占用者")
      .toEqual({ port: 9302, preferred: 9300, explicit: true, reason: "shifted" });
  });

  it("env 非法（abc / -1 / 99999 / 1.5 / 带单位）⇒ 一律回落到 9222，且 explicit=false", () => {
    /* ⚠️ 一个手滑的 `SLIME_DEVTOOLS_PORT=abc` 不该让 CDP 变成"用 NaN 当端口"
       （Chromium 拿到 NaN 的行为是未定义的，最可能是静默不开 CDP）。
       ⚠️ 判据是 `Number()` + `Number.isInteger` 的**实际语义**，不是"看起来像不像数字"：
          `"0x10"` 会被解析成 **16**（合法整数）⇒ 它是**被接受**的，故**不在**下面这组反例里
          （写进去就是一条恒红的假断言）。 */
    for (const bad of ["abc", "-1", "99999", "1.5", "9222px"]) {
      const d = resolveDevtoolsPort(bad, new Set());
      expect(d.preferred, `env=${bad} 应回落到 ${DEVTOOLS_PORT_DEFAULT}`).toBe(DEVTOOLS_PORT_DEFAULT);
      expect(d.explicit, `env=${bad} 不算显式指定`).toBe(false);
      expect(Number.isInteger(d.port), `env=${bad} 产出的必须仍是整数端口`).toBe(true);
    }
  });

  it("env=0 是**合法显式值**（0 = 交系统分配）⇒ reason=ephemeral", () => {
    expect(resolveDevtoolsPort("0", new Set())).toEqual({
      port: 0, preferred: 0, explicit: true, reason: "ephemeral",
    });
  });

  it("首选及其后整个窗口被占 ⇒ port=0 / reason=ephemeral（默认端口虽被占，仍显式报告 preferred）", () => {
    const full = new Set<number>();
    for (let i = 0; i <= DEVTOOLS_PORT_SCAN; i++) { full.add(DEVTOOLS_PORT_DEFAULT + i); }
    expect(resolveDevtoolsPort(undefined, full)).toEqual({
      port: 0, preferred: DEVTOOLS_PORT_DEFAULT, explicit: false, reason: "ephemeral",
    });
  });
});

describe("A-1110 ④ 探针：必须**同步**、失败即空集（不把「问不到」当成「全闲」或「全占」）", () => {
  it("`listeningPortsSync` 同步返回 Set（改成 async ⇒ 返回 Promise，本用例响亮报错）", () => {
    /* 为什么这条是**行为**判据而不是文本判据：`app.commandLine.appendSwitch` 只能在 `ready`
       之前调用；异步探针会把整件事静默推到"本次根本没开 CDP"（连报错都没有）。文本上写
       `listeningPortsSync` 却让它 `return new Promise(...)` 是可能的 ⇒ 只有真调一次才拦得住。 */
    const got = listeningPortsSync("win32");
    expect(got, "`listeningPortsSync` 不再同步返回 Set（成了 Promise？见本文件头部）").toBeInstanceOf(Set);
  });

  it("各平台的探针命令唯一出处，且 win32 用 netstat（不发明跨平台命令）", () => {
    expect(listeningPortsCommand("win32")).toBe("netstat -ano -p tcp");
    expect(listeningPortsCommand("darwin")).toContain("lsof");
    expect(listeningPortsCommand("linux")).toBe("ss -ltn");
  });

  it("模块源码里用的是 `execSync`（同步）；出现 `exec(` / `await exec` 这类异步形态即红", () => {
    expect(MODULE_SRC, "探针不再用 execSync ⇒ 拿不到 ready 之前的事实").toMatch(/execSync\(/);
    /* 反面：不许出现异步 exec 的形态（`exec(` 会把结论推到 ready 之后）。 */
    expect(/[^S]\bexec\(/.test(MODULE_SRC), "模块里出现了异步 exec（结论会落在 ready 之后）").toBe(false);
  });

  it("`parseDevToolsActivePort`：只认第一行的合法端口（0 / 非数字 / 空 ⇒ null）", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc")).toBe(9222);
    expect(parseDevToolsActivePort("  9223  \r\n/devtools/browser/x")).toBe(9223);
    /* ⚠️ 0 不是端口：`--remote-debugging-port=0` 时 Chromium 才写这个文件，
       所以这里读到的**必须**是一个真实端口；把 0 当有效值会让调用方以为"端口是 0"。 */
    expect(parseDevToolsActivePort("0\n/devtools/browser/x"), "0 不是真实端口").toBeNull();
    expect(parseDevToolsActivePort("abc\n")).toBeNull();
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("70000\n")).toBeNull();
    expect(parseDevToolsActivePort("\n/devtools/browser/x"), "第一行空 ⇒ 别去猜后面").toBeNull();
  });
});

describe("A-1110 ⑤ 落盘 / 读回：两条独立的发现路径（文件给脚本，日志给人）", () => {
  const withTmp = <T,>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "a1110-"));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("写→读 回环：文件里记的是**实际**端口（有 actual 时不是 requested）", () => {
    withTmp((dir) => {
      const d = resolveDevtoolsPort("0", new Set());
      const file = writeDevtoolsPortFile(dir, d, 51234);
      expect(file, "落盘失败（返回 null）").toBeTruthy();
      expect(file!.endsWith(DEVTOOLS_PORT_FILE), `文件名必须是 ${DEVTOOLS_PORT_FILE}`).toBe(true);
      expect(readDevtoolsPortFile(dir), "读回的应是**实际**端口而非请求值 0").toBe(51234);
    });
  });

  it("没给 actual 时回落到 requested；文件不存在 / JSON 坏 / port 非法 ⇒ null", () => {
    withTmp((dir) => {
      const d = resolveDevtoolsPort(undefined, new Set());
      writeDevtoolsPortFile(dir, d);
      expect(readDevtoolsPortFile(dir)).toBe(d.port);

      expect(readDevtoolsPortFile(join(dir, "nope")), "目录不存在 ⇒ null（不许抛）").toBeNull();

      writeFileSync(join(dir, DEVTOOLS_PORT_FILE), "{ not json", "utf8");
      expect(readDevtoolsPortFile(dir), "JSON 坏了 ⇒ null").toBeNull();

      writeFileSync(join(dir, DEVTOOLS_PORT_FILE), JSON.stringify({ port: 0 }), "utf8");
      expect(readDevtoolsPortFile(dir), "port=0 不是可用的 CDP 端口 ⇒ null").toBeNull();

      writeFileSync(join(dir, DEVTOOLS_PORT_FILE), JSON.stringify({ port: "9222" }), "utf8");
      expect(readDevtoolsPortFile(dir), "字符串端口也算合法数字（Number() 转得动）").toBe(9222);
    });
  });
});

describe("A-1110 ⑥ 接线（index.ts）：ready 之前 appendSwitch、用决定值而非硬编码 9222", () => {
  it("端口来自 `resolveDevtoolsPort`，**不是**字面量 9222", () => {
    expect(MAIN, "index.ts 不再调用 resolveDevtoolsPort")
      .toMatch(/resolveDevtoolsPort\(process\.env\[DEVTOOLS_PORT_ENV\],\s*listeningPortsSync\(\)\)/);
    expect(MAIN, "appendSwitch 必须传决定值")
      .toMatch(/appendSwitch\("remote-debugging-port",\s*String\(devtoolsDecision\.port\)\)/);
    /* ⚠️ 反面：这就是用户截图里那两条报错的**直接产地**（硬编码端口 ⇒ 被占就 bind 失败）。 */
    expect(/appendSwitch\("remote-debugging-port",\s*"9222"\)/.test(MAIN),
      "CDP 端口又写死 9222 了 —— 9222 被占时必然 bind 失败并让整套 CDP 静默消失").toBe(false);
  });

  it("在 `app.whenReady()` **之前** appendSwitch（ready 之后再调用不生效）", () => {
    const at = MAIN.indexOf('appendSwitch("remote-debugging-port"');
    const ready = MAIN.indexOf("app.whenReady()");
    expect(at, "找不到 appendSwitch 那一行").toBeGreaterThan(-1);
    expect(ready, "找不到 app.whenReady()").toBeGreaterThan(-1);
    expect(at, "appendSwitch 落在 whenReady 之后 —— Chromium 早已读完命令行，本次 CDP 静默不生效")
      .toBeLessThan(ready);
  });

  it("正式包（app.isPackaged）必须**关掉** CDP（安全：否则任意本机进程可附到渲染层）", () => {
    expect(MAIN, "判定不再是 isPackaged ⇒ 正式包可能默认开放 CDP（安全回归）")
      .toMatch(/const devtoolsDecision = app\.isPackaged\s*\?\s*null\s*:\s*resolveDevtoolsPort\(/);
  });

  it("端口会变 ⇒ 必须落盘发布（外部工具历史上都写死 9222）", () => {
    expect(MAIN, "index.ts 不再落盘 CDP 端口 ⇒ verify-packaged / agent-browser 会被悄悄弄坏")
      .toMatch(/writeDevtoolsPortFile\(app\.getPath\("userData"\),\s*devtoolsDecision,\s*actual\)/);
    expect(MAIN, "没有读 DevToolsActivePort 的兜底 ⇒ port=0（临时端口）时拿不到真值")
      .toMatch(/parseDevToolsActivePort\(readFileSync\(activePath, "utf8"\)\)/);
    /* 端口变化必须**出声**（老文档/老习惯写的都是 9222）—— 三档各一条日志。 */
    expect(MAIN, "顺延没出声").toMatch(/\[gui:devtools\][^\n]*顺延/);
    expect(MAIN, "临时端口没出声").toMatch(/\[gui:devtools\][^\n]*临时端口/);
    expect(MAIN, "env 显式指定没出声").toMatch(/\[gui:devtools\][^\n]*来自 \$\{DEVTOOLS_PORT_ENV\}/);
    expect(DEVTOOLS_PORT_ENV).toBe("SLIME_DEVTOOLS_PORT");
  });
});
