/**
 * gui/src/main/devtoolsPort.ts — 开发期 CDP（远程调试）端口的**选择与发布**（A-1110）。
 *
 * ## 症状（用户截图，pnpm dev 的调试面板）
 *
 * ```
 * ERROR:tcp_socket_win.cc(458)] bind() returned an error:
 *   通常每个套接字地址(协议/网络地址/端口)只允许使用一次。(0x2740)
 * ERROR:devtools_http_handler.cc(313)] Cannot start http server for devtools.
 * ```
 *
 * ## 根因
 *
 * `index.ts` 把端口**硬编码成 9222**。Chromium 的 devtools http server **不会自己换端口**：
 * 一旦 9222 已被占（上一个 dev 实例的 Electron 主进程没退干净、另一个 userData 目录的实例、
 * 或 agent-browser / playwright 之类的工具自己就开着 9222），bind 失败 ⇒ 这两条红字。
 * ⇒ **一个占用者 = 整套 CDP 能力静默消失**（`verify-packaged.mjs`、agent-browser 技能全哑），
 * 而用户只看到两句「看不懂的英文报错」。
 *
 * ## 对策（三层，写在**选择**里，顺序即优先级）
 *
 * ① 环境变量 `SLIME_DEVTOOLS_PORT` 显式指定（`0` ⇒ 交给系统挑临时端口）；
 * ② 默认 9222：**先用同步探针查占用**，被占则顺着 9223… 往上找第一个空闲（`DEVTOOLS_PORT_SCAN` 个）；
 * ③ 连扫的这段也全占 ⇒ 用 `0`（Chromium 自己挑临时端口，**绝不再报 bind 失败**）。
 * 选中的端口**落盘**（`<userData>/devtools-port.json`）并**出声**（`[gui:devtools] …`）——
 * 外部工具据落盘文件发现端口。写在 userData 而不是硬编码 9222，正是因为端口现在会变。
 *
 * ## ⚠️ 为什么探针**必须同步**（这是本模块存在的全部理由）
 *
 * `app.commandLine.appendSwitch("remote-debugging-port", …)` **只能在 `ready` 之前**调用；
 * ready 之后的调用**不生效**（Chromium 已经起来了，命令行早读完了）。
 * 而 `net.createServer().listen()` 是**异步**的 ⇒ 一旦那个 promise 落在 ready 之后，
 * 我们就悄悄退回「本次根本没开 CDP」—— 这比原来的红字**更难查**（连报错都没有）。
 * ⇒ 用 `execSync` 问系统要监听端口表：同步、在 `ready` 之前拿到、失败可退。
 *
 * ## 判定必须锚定「监听」状态
 *
 * ⚠️ `parseListeningPorts` 只认**带 LISTEN/LISTENING 标记的行**。若退化成「在整份输出里
 * 搜 `:9222`」，会把**对端端口**（一条 ESTABLISHED 连接的对端恰好是 9222）也算成占用
 * ⇒ 空闲端口被误判 ⇒ CDP 白白让位到 9223，而用户永远不知道为什么（**反向静默失效**）。
 * 探针本身不可用（命令不存在 / 超时）时返回**空集合**：退回「用首选端口」的老行为，
 * 不发明结论、也不放宽判据。
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 显式指定端口的唯一出处（读它的地方只有 `resolveDevtoolsPort` 的调用点） */
export const DEVTOOLS_PORT_ENV = "SLIME_DEVTOOLS_PORT";
/** 首选端口：与既有工具链（agent-browser 技能、历史文档）约定的默认值 */
export const DEVTOOLS_PORT_DEFAULT = 9222;
/** 首选被占时往后顺延的窗口大小（9222…9241） */
export const DEVTOOLS_PORT_SCAN = 20;
/** 端口选择结果的落盘文件名（住 userData，与 exit-mode.json / subagent-models.json 同级） */
export const DEVTOOLS_PORT_FILE = "devtools-port.json";

/**
 * 从系统命令输出里解析**正在监听**的端口集合。
 *
 * 三种输入形态（都只取「带监听标记那一行」上的 `:port`）：
 *   · win32 `netstat -ano -p tcp` → `  TCP    0.0.0.0:9222    0.0.0.0:0    LISTENING    107672`
 *     （对端那列是 `0.0.0.0:0` ⇒ 解析出的 `0` 被 `>= 1` 滤掉，不会误判）
 *   · linux `ss -ltn`             → `LISTEN 0 511 0.0.0.0:9222 0.0.0.0:*`
 *   · darwin `lsof -nP -iTCP`     → `node 1234 me 21u IPv4 … TCP *:9222 (LISTEN)`
 * IPv6 形态 `[::]:9222` 同样命中（`[` 之后是 `::`，`:(\d)` 匹配不到冒号本身）。
 */
export function parseListeningPorts(stdout: string, platform: NodeJS.Platform): Set<number> {
  const listening = platform === "win32" ? /\bLISTENING\b/i : /\bLISTEN\b/i;
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!listening.test(line)) { continue; }
    for (const m of line.matchAll(/:(\d{1,5})(?=\s|$|\))/g)) {
      const p = Number(m[1]);
      if (p >= 1 && p <= 65535) { ports.add(p); }
    }
  }
  return ports;
}

/**
 * 纯选择：首选端口空闲就用它；否则在 `首选+1 … 首选+scan` 里取第一个空闲。
 * 全占 ⇒ 返回 `0`（Chromium 的约定：0 = 让操作系统分配临时端口）。
 * `preferred === 0` 直接透传 —— 这是用户显式要「随便给一个」。
 */
export function pickDevtoolsPort(
  preferred: number,
  listening: ReadonlySet<number>,
  scan: number = DEVTOOLS_PORT_SCAN,
): number {
  if (preferred === 0) { return 0; }
  if (!listening.has(preferred)) { return preferred; }
  for (let i = 1; i <= scan; i++) {
    const candidate = preferred + i;
    if (candidate > 65535) { break; }
    if (!listening.has(candidate)) { return candidate; }
  }
  return 0;
}

export interface DevtoolsPortDecision {
  /** 最终交给 `--remote-debugging-port` 的值（`0` = 系统临时端口） */
  port: number;
  /** 用户/默认期望的端口（用于出声解释「为什么不是 9222」） */
  preferred: number;
  /** 是否来自环境变量显式指定 */
  explicit: boolean;
  /** free = 首选就空闲；shifted = 被占后顺延；ephemeral = 顺延窗口也满了 */
  reason: "free" | "shifted" | "ephemeral";
}

/**
 * 解析环境变量 + 探测结果 ⇒ 最终决定。
 * ⚠️ 环境变量的解析**只在这里**：非法值（非数字 / 越界）当没给，回落到默认 —— 
 * 一个手滑的 `SLIME_DEVTOOLS_PORT=abc` 不该让 CDP 变成「用 NaN 当端口」。
 */
export function resolveDevtoolsPort(
  rawEnv: string | undefined,
  listening: ReadonlySet<number>,
  scan: number = DEVTOOLS_PORT_SCAN,
): DevtoolsPortDecision {
  let preferred = DEVTOOLS_PORT_DEFAULT;
  let explicit = false;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const n = Number(rawEnv.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 65535) {
      preferred = n;
      explicit = true;
    }
  }
  const port = pickDevtoolsPort(preferred, listening, scan);
  const reason: DevtoolsPortDecision["reason"] =
    port === 0 ? "ephemeral" : (port === preferred ? "free" : "shifted");
  return { port, preferred, explicit, reason };
}

/** 各平台的「列出监听端口」命令（唯一出处；`listeningPortsSync` 只负责执行它） */
export function listeningPortsCommand(platform: NodeJS.Platform): string {
  if (platform === "win32") { return "netstat -ano -p tcp"; }
  if (platform === "darwin") { return "lsof -nP -iTCP -sTCP:LISTEN"; }
  return "ss -ltn";
}

/**
 * 同步探针。**失败即返回空集合**（不抛）—— 探针拿不到事实时，行为必须**等同于今天**
 * （照用首选端口），而不是把「问不到」当成「端口全闲」或「端口全占」。
 */
export function listeningPortsSync(platform: NodeJS.Platform = process.platform): Set<number> {
  try {
    const stdout = execSync(listeningPortsCommand(platform), {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseListeningPorts(stdout, platform);
  } catch {
    return new Set<number>();
  }
}

/**
 * Chromium 在 `--remote-debugging-port=0` 时会把真实端口写进 `<userData>/DevToolsActivePort`
 * （两行：端口 + 浏览器级 ws 路径）。解析第一行。
 */
export function parseDevToolsActivePort(text: string): number | null {
  const first = text.split(/\r?\n/)[0]?.trim() ?? "";
  const n = Number(first);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/**
 * 把选择结果落盘。写失败**不抛**（它只是给工具用的便利文件，不该拖垮启动），
 * 但调用方必须**出声**把端口打到日志里 —— 落盘与日志是两条独立发现路径。
 */
export function writeDevtoolsPortFile(
  userDataDir: string,
  decision: DevtoolsPortDecision,
  actualPort: number | null = null,
): string | null {
  try {
    mkdirSync(userDataDir, { recursive: true });
    const file = join(userDataDir, DEVTOOLS_PORT_FILE);
    writeFileSync(file, JSON.stringify({
      port: actualPort ?? decision.port,
      requested: decision.port,
      preferred: decision.preferred,
      reason: decision.reason,
      explicit: decision.explicit,
      pid: process.pid,
      at: new Date().toISOString(),
    }, null, 2), "utf8");
    return file;
  } catch {
    return null;
  }
}

/** 读取落盘端口（工具侧用；文件不存在 / 非法一律 `null`，由调用方决定回落到什么） */
export function readDevtoolsPortFile(userDataDir: string): number | null {
  try {
    const raw = readFileSync(join(userDataDir, DEVTOOLS_PORT_FILE), "utf8");
    const parsed = JSON.parse(raw) as { port?: unknown };
    const n = Number(parsed.port);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
