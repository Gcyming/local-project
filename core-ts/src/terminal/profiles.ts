/**
 * core-ts/src/terminal/profiles.ts — 「内置终端用哪个 shell / 怎么调它」的**纯判据唯一产地**。
 *
 * ## 为什么要有这个模块
 * 用户实测反馈（2026-10-01）：「内置终端体验很差……**可以在使用时自适应直接接入主机本地终端的
 * 各个组件**」。他给的对标是 VS Code 的终端下拉（Windows PowerShell / 命令提示符 /
 * Azure Cloud Shell / Ubuntu / Developer Command Prompt for VS 2022 / Developer PowerShell
 * for VS 2022）—— 也就是**自动探测主机上真实存在的那些 shell，并让用户选**。
 *
 * 原先的实现把这件事写死在主进程里：`exec(cmd, { cwd })` —— 等于**永远只有 cmd.exe**。
 * 于是：
 *   · 用户装的是 PowerShell 7，却在 cmd 里跑命令；
 *   · WSL 里的工程路径（`/home/x/proj`）根本传不进去；
 *   · Git Bash 的 `$VAR` / `&&` 语义与 cmd 不同，同一条命令在两边结果不一样。
 *
 * ## 为什么是纯函数
 * 「探测到了哪些 shell」是 IO（看文件在不在、问 `wsl -l -q` 要发行版列表），
 * 但「这些 shell 各自怎么调」是**纯映射**。把它拆开之后：
 *   · 本模块可以被守卫**逐条断言**（不 import electron / child_process）；
 *   · 主进程那边只剩"探测 + 缓存"这点 IO（`gui/src/main/termProfiles.ts`）。
 *
 * ⚠️ 本模块**不 import electron / node:fs / node:child_process**。
 */

/** shell 的调用家族（决定 argv 怎么拼）。 */
export type TermProfileKind =
  | "cmd"          // Windows 命令提示符
  | "powershell"   // Windows PowerShell 5.1
  | "pwsh"         // PowerShell 7+
  | "wsl"          // WSL 里的某个发行版
  | "bash"         // POSIX bash（Linux/macOS，或 Git Bash）
  | "sh"           // POSIX sh
  | "vsdevcmd"     // Developer Command Prompt for VS
  | "vspwsh";      // Developer PowerShell for VS

/** 一个可用的终端配置（渲染层的下拉里就是它）。 */
export interface TermProfile {
  /** 唯一 id（IPC 只传这个，渲染层不传可执行路径 —— 路径属于主进程的事实）。 */
  id: string;
  /** 显示名（下拉里的主文案）。 */
  label: string;
  kind: TermProfileKind;
  /** 可执行文件**绝对路径**。 */
  file: string;
  /** 副标题：版本 / 发行版 / 备注（渲染层灰色小字）。 */
  detail?: string;
  /** WSL 专用：发行版名（`Ubuntu` / `Ubuntu-22.04` …）。 */
  distro?: string;
  /** VS 专用：先跑的初始化脚本（VsDevCmd.bat / Launch-VsDevShell.ps1）。 */
  setup?: string;
}

/** 一条命令在这个 shell 里该被怎么调起来。 */
export interface ShellInvocation {
  file: string;
  args: string[];
}

/**
 * 组装 argv。**纯函数**（不碰 IO）⇒ 每条 kind 都能被单测钉住。
 *
 * @param cwd 工作目录。⚠️ 只有 WSL 需要它**进 argv**（`--cd`）：其它 kind 一律由
 *            `spawn` 的 `cwd` 选项设工作目录，**不**往命令里注入 `cd`
 *            （注入就会改变用户的命令文本，`$?` / `%ERRORLEVEL%` 语义跟着变）。
 */
export function shellInvocation(p: TermProfile, cmd: string, cwd?: string): ShellInvocation {
  switch (p.kind) {
    case "cmd":
      /* `/d` 跳过 AutoRun（注册表里的 AutoRun 会在每条命令前插一段，用户看不出来）、
         `/s` 保留引号语义、`/c` 执行完就退出。 */
      return { file: p.file, args: ["/d", "/s", "/c", cmd] };
    case "vsdevcmd": {
      /* 必须是 `call`：直接跑 .bat 会在它结束时**终止整个 cmd**，后面的用户命令就不会执行
         （这是 cmd 的经典坑：批处理没有 call 时是"chained"，控制权不回来）。 */
      const full = p.setup ? `call "${p.setup}" >nul && ${cmd}` : cmd;
      return { file: p.file, args: ["/d", "/s", "/c", full] };
    }
    case "powershell":
    case "pwsh":
      /* `-NonInteractive` 防止脚本卡在确认提示上（一个没人回答的 Read-Host 会挂到超时）；
         `-NoProfile` 让输出可复现（用户的 profile 里可能有会打印东西的自定义提示符）。 */
      return { file: p.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd] };
    case "vspwsh": {
      const full = p.setup
        ? `& "${p.setup}" -Arch amd64 -HostArch amd64 | Out-Null; ${cmd}`
        : cmd;
      return { file: p.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", full] };
    }
    case "bash":
      /* `-l` 读登录 profile（PATH 才完整 —— Git Bash 的 /usr/bin 靠它加进来）。 */
      return { file: p.file, args: ["-lc", cmd] };
    case "sh":
      return { file: p.file, args: ["-c", cmd] };
    case "wsl": {
      const args: string[] = [];
      if (p.distro) { args.push("-d", p.distro); }
      if (cwd) { args.push("--cd", cwd); }
      args.push("--", "bash", "-lc", cmd);
      return { file: p.file, args };
    }
  }
}

/**
 * 默认选哪个配置。
 *
 * 规则（与 VS Code 的默认一致，也和"用户期望"一致）：
 *   · Windows：**优先 pwsh（PowerShell 7）> Windows PowerShell > cmd** ——
 *     用户装了 7 说明他想要 7；没装则用系统自带的 5.1；连 5.1 都没有才退 cmd。
 *   · 非 Windows：bash > sh。
 *   · 列表为空 ⇒ `null`（调用方负责给出"一个 shell 都没探测到"的可见说明，不要静默）。
 */
export function pickDefaultProfile(list: readonly TermProfile[]): TermProfile | null {
  const priority: TermProfileKind[] = ["pwsh", "powershell", "cmd", "bash", "sh", "wsl", "vsdevcmd", "vspwsh"];
  for (const kind of priority) {
    const hit = list.find((p) => p.kind === kind);
    if (hit) { return hit; }
  }
  return list[0] ?? null;
}

/** 下拉里的展示顺序（对齐 VS Code 的终端下拉：先系统自带，再发行版/环境，最后 Git Bash）。 */
export const PROFILE_KIND_ORDER: readonly TermProfileKind[] =
  ["pwsh", "powershell", "cmd", "wsl", "vsdevcmd", "vspwsh", "bash", "sh"];

/** 按 `PROFILE_KIND_ORDER` 稳定排序（同类保持探测顺序 —— 多个 WSL 发行版不能被打乱）。 */
export function orderProfiles(list: readonly TermProfile[]): TermProfile[] {
  const rank = (k: TermProfileKind): number => {
    const i = PROFILE_KIND_ORDER.indexOf(k);
    return i < 0 ? PROFILE_KIND_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/**
 * 从列表里按 id 取一个；取不到时**退到默认**而不是报错。
 *
 * ⚠️ 为什么退而不是报错：渲染层记的是**持久化的 id**（用户上次选的 shell）。
 * 换了机器 / 卸了 PowerShell 7 之后那个 id 就不存在了 —— 这时正确的行为是
 * "用默认的 shell 照常工作"，而不是"终端打不开"。但**必须让用户看见**退到了哪个
 * （渲染层显示当前的 profile 名 ⇒ 用户一眼就知道不是自己选的那个）。
 */
export function resolveProfile(list: readonly TermProfile[], id: string | undefined | null): TermProfile | null {
  if (id) {
    const hit = list.find((p) => p.id === id);
    if (hit) { return hit; }
  }
  return pickDefaultProfile(list);
}

/* ══ cwd 延续（`cd xxx` 之后的下一条命令要落在新目录）════════════════════════════
 *
 * ## 为什么需要"本地推导"
 * 内置终端是**一次性进程**模型（每条命令一个 `spawn`，没有 PTY，也就没有常驻 shell 可以
 * 记住 cwd）。于是"`cd src` 然后 `ls`"里的 `cd` **什么也不会发生** —— 用户看到的是
 * "命令跑了但目录没变"，这是"终端体验很差"里最隐蔽的一条（不报错、只是不对）。
 *
 * ## 为什么只处理"整条命令就是一次目录切换"
 * 一旦出现 `&`/`&&`/`|`/`;`，命令序列结束时的 cwd 取决于**整条链路**（可能中间进了子 shell、
 * 可能 `cd` 在 `&&` 的失败分支里没执行）。本地推导必然出错，而出错的后果比"不生效"更糟
 * （命令跑在用户没预期的目录里）。⇒ **算不出就返回 `null`，宁可不猜。** 返回 `null` 时
 * cwd 保持不变，与旧行为一致（不是回归）。
 *
 * ## 为什么不用 `node:path`
 * 本模块要能被**渲染层**引用（它零依赖、纯函数）。而 `node:path` 在浏览器构建里不存在，
 * `path.sep` 还依赖运行平台（我们算的可能是 Windows 路径、也可能 WSL 里的 Linux 路径，
 * 二者与"我们跑在哪个平台"无关）⇒ 自己写几个二十行的纯 helper，反而更准。
 *
 * ⚠️ **本函数只"提议"**：真正采用前必须由主进程校验（存在且是目录），并以主进程回带的
 *    `cwd` 为准 —— 渲染层不持有"事实"。
 */

/** 路径是不是 Windows 风格（盘符 / UNC 开头）。 */
function isWinPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** 绝对路径判定（Windows 盘符 / UNC / POSIX 根）。 */
export function isAbsoluteTarget(p: string): boolean {
  return isWinPath(p) || p.startsWith("/");
}

/** 拼一段相对路径（分隔符跟**目标路径**走，不跟运行平台走）。 */
export function joinTarget(cwd: string, rel: string): string {
  const sep = isWinPath(cwd) ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

/** 归一化 `.` / `..` / 重复分隔符；`..` 越过根时**停在根**（与真实 shell 一致）。 */
export function normalizeTarget(p: string): string {
  if (isWinPath(p)) {
    const drive = /^[a-zA-Z]:/.exec(p)?.[0] ?? "";
    const body = p.slice(drive.length);
    const out: string[] = [];
    for (const seg of body.split(/[\\/]+/)) {
      if (!seg || seg === ".") { continue; }
      if (seg === "..") { if (out.length > 0) { out.pop(); } continue; }
      out.push(seg);
    }
    return `${drive}\\${out.join("\\")}`;
  }
  const out: string[] = [];
  for (const seg of p.slice(1).split(/[\\/]+/)) {
    if (!seg || seg === ".") { continue; }
    if (seg === "..") { if (out.length > 0) { out.pop(); } continue; }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** 该 kind 下"切换目录"用的动词（**按 kind 白名单**，避免把 bash 里的 `sl` 当成 Set-Location）。 */
function cdVerbs(kind: TermProfileKind): readonly string[] {
  if (kind === "cmd" || kind === "vsdevcmd") { return ["cd", "chdir"]; }
  if (kind === "powershell" || kind === "pwsh" || kind === "vspwsh") { return ["cd", "chdir", "set-location", "sl"]; }
  return ["cd"];
}

/**
 * 把一条命令解释成"新的 cwd"。返回 `null` = **无法可靠判定**（调用方保持原 cwd）。
 *
 * @param home `~` 展开目标（拿不到就不展开，返回 `null`）
 */
export function resolveCd(
  raw: string,
  cwd: string | undefined,
  kind: TermProfileKind,
  home?: string,
): { next: string } | null {
  const cmd = String(raw ?? "").trim();
  if (!cmd || !cwd) { return null; }

  /* 只处理「整条命令就是一个目录切换」：任何分隔/重定向/反引号/换行都意味着后面还有别的事。 */
  if (/[&|;<>`\r\n]/.test(cmd)) { return null; }

  const verbs = cdVerbs(kind);
  const verbRe = new RegExp(`^(${verbs.join("|")})\\b\\s*(.*)$`, "i");
  const m = verbRe.exec(cmd);
  if (!m) { return null; }
  let rest = (m[2] ?? "").trim();

  if (rest === "") {
    /* `cd` 单独用：cmd 是**打印**当前目录（不变）；bash / PowerShell 回到 HOME。 */
    const isWinShell = kind === "cmd" || kind === "vsdevcmd";
    if (isWinShell) { return null; }
    return home ? { next: normalizeTarget(home) } : null;
  }

  /* cmd 的 `/d`（允许跨盘切换）—— 只对 cmd 家族剥掉；bash 里 `cd /d` 是去 `/d` 目录。 */
  if ((kind === "cmd" || kind === "vsdevcmd") && /^\/d\s+/i.test(rest)) {
    rest = rest.replace(/^\/d\s+/i, "").trim();
  }

  let p = rest;
  /* 成对引号剥掉（`cd "Program Files"`）。 */
  const q = p[0];
  if ((q === "\"" || q === "'") && p.length >= 2 && p.endsWith(q)) { p = p.slice(1, -1); }
  if (p === "") { return null; }
  /* `cd -`（上个目录）/ `-Path` 之类的开关：我们不知道目标，不猜。 */
  if (p.startsWith("-")) { return null; }
  /* 变量 / 通配 / 延迟展开：真值只有 shell 自己知道。 */
  if (/[%$!*?]/.test(p)) { return null; }
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    if (!home) { return null; }
    p = home + p.slice(1);
  }
  p = p.replace(/[\\/]+$/, "");
  if (p === "") { return null; }

  return { next: isAbsoluteTarget(p) ? normalizeTarget(p) : normalizeTarget(joinTarget(cwd, p)) };
}
