#!/usr/bin/env node
/**
 * gui/scripts/mut-a1139-terminal.mjs — A-1139（内置终端适配主机本地终端组件）的变异验证。
 *
 * ## 这一组要护的是什么
 * 用户实测：「体验很差……**我本地部分代码都无法适配**，全面优化，适配现在终端的所有样式，
 * 可以在使用时**自适应直接接入主机本地终端的各个组件**」。
 * 这条链上最危险的失效方式**不是崩溃**，而是「跑得起来但不对」：
 *   1  cmd 少了 `/d` ⇒ 注册表 AutoRun 会在每条命令前插一段（用户看不出来）
 *   2  cmd 少了 `/s` ⇒ 带引号的命令被解析成另一种意思
 *   3  **VS 少了 `call`** ⇒ .bat 结束时终止整个 cmd，用户的命令**根本不执行**（不报错）
 *   4  PowerShell 少了 `-NonInteractive` ⇒ 脚本卡在确认提示上，直到超时
 *   5  PowerShell 少了 `-NoProfile` ⇒ 用户 profile 打印的东西混进输出（不可复现）
 *   6  Developer PowerShell 不吞初始化输出 ⇒ 每次命令前面多一段环境横幅
 *   7  bash 少了 `-l` ⇒ PATH 不全（Git Bash 的 /usr/bin 不在里面）
 *   8  WSL 少了 `--cd` ⇒ 用户在 WSL 里永远停在 /mnt/c
 *   9  默认优先级改掉 ⇒ 装了 PowerShell 7 却跑 cmd（"本地代码不适配"的原样复现）
 *  10  下拉排序改掉 ⇒ 顺序与 VS Code 不一致
 *  11  排序不稳定 ⇒ 多个 WSL 发行版被打乱（选了 Ubuntu 跑成 Debian）
 *  12  id 失配时报错 ⇒ 换了机器/卸了 PS7 之后终端直接打不开
 *  13  **组合命令也去猜 cwd** ⇒ 命令静默跑在用户没预期的目录里（比"cd 不生效"糟糕得多）
 *  14  含变量/通配也去猜 cwd ⇒ 同上
 *  15  `cd -`（上个目录）也去猜 ⇒ 同上
 *  16  cmd 下裸 `cd` 当成回 HOME ⇒ 与 cmd 的真实语义（只打印）相反
 *  17  `..` 不归一 ⇒ cd 之后落在错目录
 *  18  `..` 越过根不夹住 ⇒ 同上
 *  19  路径分隔符跟运行平台走 ⇒ WSL 的 Linux 路径被拼成 `\`
 *  20  bash 里的 `sl` 被当成 Set-Location ⇒ 把用户想跑的程序当成了 cd
 *  21  bash 里剥掉 `/d` ⇒ `cd /d` 变成去根目录
 *  22  `0` 不重置样式 ⇒ 后面的普通文本继承上一个颜色
 *  23  片段展开顺序写错（`...style` 盖掉 `plain`）⇒ **每一段都变空**（静默清空）
 *  24  纯控制行也产出一段空文本 ⇒ 进度条刷屏（正是用户说的"脏"）
 *  25  `38;5;n` 取错参数 ⇒ 256 色全错
 *  26  真彩 `38;2;r;g;b` 写错 ⇒ 同上
 *  27  亮色 90-97 不映射 ⇒ 一半工具的高亮色丢失
 *  28  `color256` 立方公式错 ⇒ 256 色全偏
 *  29  `color256` 灰阶公式错 ⇒ 灰阶全偏
 *  30  不做严格 UTF-8 判别 ⇒ ASCII/UTF-8 全被判成 GB18030（**中文乱码的镜像 bug**）
 *  31  严格解码不 fatal ⇒ GBK 字节不抛、被当 UTF-8 解成 U+FFFD（乱码照旧）
 *  32  不认 BOM ⇒ 带 BOM 的文件首字符变乱码
 *  33  charset 别名不归一 ⇒ gbk 与 gb18030 分家
 *  34  不读 http-equiv ⇒ 老页面（大量存在）判不出编码
 *  35  `decodeHtmlBytes` 忽略页面声明 ⇒ 页面自己说了 gbk 也没用
 *  36  兜底表被扩成多个 ⇒ 判别顺序不再确定
 *  37  `supportsEncoding` 恒真 ⇒ 精简运行时上构造 TextDecoder 直接抛
 *  38  空字节也标 loose ⇒ 界面永远挂一个假的"编码兜底"提示
 *  39  **`wsl -l -q` 不判 UTF-16LE** ⇒ 下拉里多一条永远连不上的假发行版（不报错）
 *  40  发行版名不去空字节 ⇒ 同上
 *  41  `whichInPath` 不产 PATHEXT ⇒ Windows 上一个 shell 都探不到
 *  42  PATH 分隔符写死 `:` ⇒ Windows 上探不到任何东西
 *  43  主进程**不再回带默认 id** ⇒ 下拉永远是空的
 *  44  exec 忽略选中的 profile ⇒ 下拉变成了纯装饰（**用户点它没有任何效果**）
 *  45  输出不走 `decodeBytes` ⇒ 中文乱码回归（本轮的第一号问题）
 *  46  `loose` 不回带 ⇒ 界面永远显示不出"编码没能确认"
 *  47  超时不杀进程树 ⇒ 留下孤儿进程 + `close` 永不到来 ⇒ 终端挂死
 *  48  超时文案改掉 ⇒ 用户以为命令正常结束了（旧实现的坑）
 *  49  cwd 不由主进程回带 ⇒ 渲染层拿不到事实、cd 静默失效
 *  50  cwd 候选不做存在性校验 ⇒ 命令跑在不存在的目录里（错误信息还看不出是目录的问题）
 *  51  WSL 的 cwd 也走宿主 statSync ⇒ WSL 路径必然被拒（cd 在 WSL 里永远不生效）
 *  52  spawn 的 cwd 对 WSL 不特殊处理 ⇒ spawn 直接 ENOENT（终端整个用不了）
 *  53  preload 不传 profileId ⇒ 选中的 shell 传不到主进程（同 44，另一条通道）
 *  54  preload 不暴露 profiles ⇒ 下拉永远探测不到
 *  55  渲染层不探测 shell ⇒ 下拉永远空
 *  56  下拉的 onChange 断了 ⇒ 选了没反应（**最容易被"看起来做了"骗过的一条**）
 *  57  渲染层不解析 ANSI ⇒ 退回「满屏转义垃圾」
 *  58  渲染层不显示 notice ⇒ 超时/截断/编码兜底全部静默
 *  59  渲染层不采用主进程回带的 cwd ⇒ cd 之后下一条命令跑回原目录
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环逐条（或 `_run-mut-batch.sh`）。
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（剥 ANSI 之后）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 * ⚠️ 本文件必须是 **LF**（`check-mut-anchors.mjs` 按字节切锚点）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1139-terminal.spec.ts"];

const F_PROFILES = "core-ts/src/terminal/profiles.ts";
const F_ANSI = "core-ts/src/terminal/ansi.ts";
const F_ENC = "core-ts/src/text/encoding.ts";
const F_DETECT = "gui/src/main/termProfiles.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";

const TARGETS = [F_PROFILES, F_ANSI, F_ENC, F_DETECT, F_MAIN, F_PRELOAD, F_SIDEBAR];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1139");

const MUTATIONS = [
  /* ───── ① shellInvocation（怎么调一个 shell）───── */
  {
    name: "1 profiles：cmd 少了 /d（注册表 AutoRun 会在每条命令前插一段，用户看不出来）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'return { file: p.file, args: ["/d", "/s", "/c", cmd] };',
      'return { file: p.file, args: ["/s", "/c", cmd] };'),
  },
  {
    name: "2 profiles：cmd 少了 /s（带引号的命令被解析成另一种意思）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'return { file: p.file, args: ["/d", "/s", "/c", cmd] };',
      'return { file: p.file, args: ["/d", "/c", cmd] };'),
  },
  {
    name: "3 profiles：VS 少了 call（.bat 结束时终止整个 cmd ⇒ 用户命令根本不执行，且不报错）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'const full = p.setup ? `call "${p.setup}" >nul && ${cmd}` : cmd;',
      'const full = p.setup ? `"${p.setup}" >nul && ${cmd}` : cmd;'),
  },
  {
    name: "4 profiles：PowerShell 少了 -NonInteractive（脚本卡在确认提示上，直到超时）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'return { file: p.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd] };',
      'return { file: p.file, args: ["-NoLogo", "-NoProfile", "-Command", cmd] };'),
  },
  {
    name: "5 profiles：PowerShell 少了 -NoProfile（用户 profile 打印的东西混进输出）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'return { file: p.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd] };',
      'return { file: p.file, args: ["-NoLogo", "-NonInteractive", "-Command", cmd] };'),
  },
  {
    name: "6 profiles：Developer PowerShell 不吞初始化输出（每次命令前多一段环境横幅）",
    file: F_PROFILES,
    mutate: (t) => sub(t, '? `& "${p.setup}" -Arch amd64 -HostArch amd64 | Out-Null; ${cmd}`',
      '? `& "${p.setup}" -Arch amd64 -HostArch amd64; ${cmd}`'),
  },
  {
    name: "7 profiles：bash 少了 -l（PATH 不全 ⇒ Git Bash 的 /usr/bin 不在里面）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'return { file: p.file, args: ["-lc", cmd] };',
      'return { file: p.file, args: ["-c", cmd] };'),
  },
  {
    name: "8 profiles：WSL 少了 --cd（用户在 WSL 里永远停在 /mnt/c）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'if (cwd) { args.push("--cd", cwd); }', 'if (false) { args.push("--cd", cwd); }'),
  },

  /* ───── ② 选哪个 shell ───── */
  {
    name: "9 profiles：默认优先级改成 cmd 优先（装了 PowerShell 7 却跑 cmd ⇒ 本地代码不适配）",
    file: F_PROFILES,
    mutate: (t) => sub(t,
      'const priority: TermProfileKind[] = ["pwsh", "powershell", "cmd", "bash", "sh", "wsl", "vsdevcmd", "vspwsh"];',
      'const priority: TermProfileKind[] = ["cmd", "pwsh", "powershell", "bash", "sh", "wsl", "vsdevcmd", "vspwsh"];'),
  },
  {
    name: "10 profiles：下拉排序把 git bash 排到系统 shell 前面（与 VS Code 的下拉不一致）",
    file: F_PROFILES,
    mutate: (t) => sub(t,
      '["pwsh", "powershell", "cmd", "wsl", "vsdevcmd", "vspwsh", "bash", "sh"];',
      '["bash", "sh", "pwsh", "powershell", "cmd", "wsl", "vsdevcmd", "vspwsh"];'),
  },
  {
    name: "11 profiles：排序不再稳定（多个 WSL 发行版被打乱 ⇒ 选了 Ubuntu 跑成 Debian）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'return [...list].sort((a, b) => rank(a.kind) - rank(b.kind));', 'return [...list];'),
  },
  {
    name: "12 profiles：id 失配时报错（换了机器/卸了 PS7 之后终端直接打不开）",
    file: F_PROFILES,
    mutate: (t) => sub(t, '  if (id) {\n    const hit = list.find((p) => p.id === id);',
      '  if (false) {\n    const hit = list.find((p) => p.id === id);'),
  },

  /* ───── ③ cwd 延续（反例是判据的一半）───── */
  {
    name: "13 profiles：组合命令也去猜 cwd（命令静默跑在用户没预期的目录里）",
    file: F_PROFILES,
    /* ⚠️ 锚点里必须写 `\\r\\n`（转义过的反斜杠）：这行源码里的 `\r\n` 是**字符类的字面内容**，
       在 JS 字符串里写成 `\r\n` 会变成真的回车换行 ⇒ 锚点被当成多行锚点而**静默失配**。 */
    mutate: (t) => sub(t, 'if (/[&|;<>`\\r\\n]/.test(cmd)) { return null; }', 'if (false) { return null; }'),
  },
  {
    name: "14 profiles：含变量/通配也去猜 cwd（真值只有 shell 知道）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'if (/[%$!*?]/.test(p)) { return null; }', 'if (false) { return null; }'),
  },
  {
    name: "15 profiles：`cd -`（上个目录）也当成可解析的路径",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'if (p.startsWith("-")) { return null; }', 'if (false) { return null; }'),
  },
  {
    name: "16 profiles：cmd 下裸 `cd` 被当成回 HOME（与 cmd 的真实语义「只打印」相反）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'if (isWinShell) { return null; }', 'if (false) { return null; }'),
  },
  {
    name: "17 profiles：Windows 路径的 `..` 不归一（cd 之后落在错目录）",
    file: F_PROFILES,
    /* ⚠️ 必须带上**上一行**做前缀：`    if (seg === "..")` 这一串在 POSIX 分支里也出现，
       而缩进更深的 Windows 分支**包含**它（子串）⇒ 只给一行会被判「不唯一」。 */
    mutate: (t) => sub(t, '      if (!seg || seg === ".") { continue; }\n      if (seg === "..") { if (out.length > 0) { out.pop(); } continue; }',
      '      if (!seg || seg === ".") { continue; }\n      if (seg === "..") { out.push(seg); continue; }'),
  },
  {
    name: "18 profiles：POSIX 路径的 `..` 不归一（`cd /../../a` 落到 /a 而不是 /a 的规范化结果）",
    file: F_PROFILES,
    /* 同理：用 POSIX 分支**独有**的那一行（`p.slice(1)`）当锚点前缀。 */
    mutate: (t) => sub(t, '  for (const seg of p.slice(1).split(/[\\\\/]+/)) {\n    if (!seg || seg === ".") { continue; }\n    if (seg === "..") { if (out.length > 0) { out.pop(); } continue; }',
      '  for (const seg of p.slice(1).split(/[\\\\/]+/)) {\n    if (!seg || seg === ".") { continue; }\n    if (seg === "..") { out.push(seg); continue; }'),
  },
  {
    name: "19 profiles：路径分隔符跟运行平台走（WSL 的 Linux 路径被拼成反斜杠）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'const sep = isWinPath(cwd) ? "\\\\" : "/";', 'const sep = "/";'),
  },
  {
    name: "20 profiles：bash 里的 `sl` 被当成 Set-Location（把用户想跑的程序当成了 cd）",
    file: F_PROFILES,
    mutate: (t) => sub(t, '  return ["cd"];', '  return ["cd", "sl"];'),
  },
  {
    name: "21 profiles：bash 里也剥掉 `/d`（`cd /d` 变成去根目录）",
    file: F_PROFILES,
    mutate: (t) => sub(t, 'if ((kind === "cmd" || kind === "vsdevcmd") && /^\\/d\\s+/i.test(rest)) {',
      'if (/^\\/d\\s+/i.test(rest)) {'),
  },

  /* ───── ④ ANSI 渲染 ───── */
  {
    name: "22 ansi：`0` 不重置样式（后面的普通文本继承上一个颜色）",
    file: F_ANSI,
    mutate: (t) => sub(t, 'if (p === 0) {\n      delete style.fg; delete style.bg;', 'if (false) {\n      delete style.fg; delete style.bg;'),
  },
  {
    name: "23 ansi：片段展开顺序写错（`...style` 的 text 空串盖掉 plain ⇒ 每一段都变空）",
    file: F_ANSI,
    mutate: (t) => sub(t, 'const span: AnsiSpan = { text: plain };', 'const span: AnsiSpan = { text: plain, ...style };'),
  },
  {
    name: "24 ansi：纯控制行也产出一段空文本（进度条刷屏 —— 用户说的「脏」）",
    file: F_ANSI,
    mutate: (t) => sub(t, 'if (plain.length === 0) { return; }', 'if (false) { return; }'),
  },
  {
    name: "25 ansi：`38;5;n` 取错参数（256 色全错）",
    file: F_ANSI,
    mutate: (t) => sub(t, 'const c = color256(params[i + 2] ?? 0);', 'const c = color256(params[i + 1] ?? 0);'),
  },
  {
    name: "26 ansi：真彩 `38;2;r;g;b` 的蓝分量写死 0",
    file: F_ANSI,
    mutate: (t) => sub(t, 'const c = `rgb(${r},${g},${b})`;', 'const c = `rgb(${r},${g},0)`;'),
  },
  {
    name: "27 ansi：亮色 90-97 不映射（一半工具的高亮色丢失）",
    file: F_ANSI,
    mutate: (t) => sub(t, 'else if (p >= 90 && p <= 97) { style.fg = ANSI_16[p - 90 + 8]; }', 'else if (false) { style.fg = ANSI_16[8]; }'),
  },
  {
    name: "28 ansi：color256 立方步长写错（256 色全偏）",
    file: F_ANSI,
    mutate: (t) => sub(t, 'const v = (x: number): number => (x === 0 ? 0 : 55 + x * 40);',
      'const v = (x: number): number => (x === 0 ? 0 : 55 + x * 30);'),
  },
  {
    name: "29 ansi：color256 灰阶公式写错",
    file: F_ANSI,
    mutate: (t) => sub(t, 'const v = 8 + (i - 232) * 10;', 'const v = (i - 232) * 10;'),
  },
  {
    name: "30 ansi：color256 的 16 色段索引写死 0",
    file: F_ANSI,
    mutate: (t) => sub(t, 'if (i < 16) { return ANSI_16[i]!; }', 'if (i < 16) { return ANSI_16[0]!; }'),
  },

  /* ───── ⑤ 编码（中文乱码的根治）───── */
  {
    name: "31 encoding：不做严格 UTF-8 判别（ASCII/UTF-8 全被判成 GB18030 —— 乱码的镜像 bug）",
    file: F_ENC,
    mutate: (t) => sub(t, 'const utf8 = strictDecode(buf, "utf-8");', 'const utf8 = null;'),
  },
  {
    name: "32 encoding：严格解码不 fatal（GBK 字节不抛、被当 UTF-8 解成 U+FFFD ⇒ 乱码照旧）",
    file: F_ENC,
    mutate: (t) => sub(t, 'return new TextDecoder(encoding, { fatal: true }).decode(buf);',
      'return new TextDecoder(encoding).decode(buf);'),
  },
  {
    name: "33 encoding：不认 BOM（带 BOM 的文件首字符变乱码）",
    file: F_ENC,
    mutate: (t) => sub(t, 'const bom = bomEncoding(buf);', 'const bom = null;'),
  },
  {
    name: "34 encoding：charset 别名不归一（gbk 与 gb18030 分家 ⇒ 同一种编码走两条路）",
    file: F_ENC,
    mutate: (t) => sub(t, 'if (c === "gb2312" || c === "gbk" || c === "gb18030" || c === "x-gbk") { return "gb18030"; }',
      'if (c === "gb2312" || c === "gbk" || c === "gb18030" || c === "x-gbk") { return "gbk"; }'),
  },
  {
    name: "35 encoding：不读 `<meta http-equiv>`（大量老页面判不出编码）",
    file: F_ENC,
    mutate: (t) => sub(t, 'return equiv ? normalizeCharset(equiv) : null;', 'return null;'),
  },
  {
    name: "36 encoding：`decodeHtmlBytes` 忽略页面自己声明的 charset",
    file: F_ENC,
    mutate: (t) => sub(t, 'if (declared && declared !== "utf-8" && supportsEncoding(declared)) {', 'if (false) {'),
  },
  {
    name: "37 encoding：兜底表被扩成多个（判别顺序不再确定）",
    file: F_ENC,
    mutate: (t) => sub(t, 'export const DEFAULT_FALLBACKS: readonly string[] = ["gb18030"];',
      'export const DEFAULT_FALLBACKS: readonly string[] = ["gb18030", "big5"];'),
  },
  {
    name: "38 encoding：`supportsEncoding` 恒真（精简运行时上构造 TextDecoder 直接抛）",
    file: F_ENC,
    mutate: (t) => sub(t, 'try { new TextDecoder(name); return true; } catch { return false; }', 'return true;'),
  },
  {
    name: "39 encoding：空字节也标 loose（界面永远挂一个假的「编码兜底」提示）",
    file: F_ENC,
    mutate: (t) => sub(t, 'if (!buf || buf.length === 0) { return { text: "", encoding: "utf-8", loose: false }; }',
      'if (!buf || buf.length === 0) { return { text: "", encoding: "utf-8", loose: true }; }'),
  },

  /* ───── ⑥ 探测（PATH / wsl 的 UTF-16 坑）───── */
  {
    name: "40 detect：**`wsl -l -q` 不判 UTF-16LE**（下拉里多一条永远连不上的假发行版，不报错）",
    file: F_DETECT,
    mutate: (t) => sub(t, '  const isUtf16 = (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)\n    || (b.length >= 2 && b[1] === 0);',
      '  const isUtf16 = false;'),
  },
  {
    name: "41 detect：发行版名不去空字节（假名字照样进下拉）",
    file: F_DETECT,
    mutate: (t) => sub(t, '.map((s) => s.replace(/\\u0000/g, "").replace(/^\\*/, "").trim())',
      '.map((s) => s.replace(/^\\*/, "").trim())'),
  },
  {
    name: "42 detect：`whichInPath` 不产 PATHEXT（Windows 上一个 shell 都探不到）",
    file: F_DETECT,
    mutate: (t) => sub(t, '    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)\n    : [""];',
      '    ? [""]\n    : [""];'),
  },
  {
    name: "43 detect：PATH 分隔符写死 `:`（Windows 上探不到任何东西）",
    file: F_DETECT,
    mutate: (t) => sub(t, 'const dirs = (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);',
      'const dirs = (env.PATH ?? "").split(":").filter(Boolean);'),
  },

  /* ───── ⑦ 主进程接线 ───── */
  {
    name: "44 main：探测通道不注册（下拉永远是空的）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'handleTrusted<undefined>("slime:term:profiles"', 'handleTrusted<undefined>("slime:term:profilesX"'),
  },
  {
    name: "45 main：探测不回带默认 id（下拉永远选不中任何一项）",
    file: F_MAIN,
    mutate: (t) => sub(t, '      const def = pickDefaultProfile(profiles);', '      const def = null;'),
  },
  {
    name: "46 main：exec 忽略选中的 profile（下拉变成纯装饰 —— 点了没有任何效果）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'const prof = resolveProfile(profiles, p.profileId);', 'const prof = resolveProfile(profiles, undefined);'),
  },
  {
    name: "47 main：执行不走探测到的 profile（自己拼一个 shellInvocation）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'runShellCommand(shellInvocation(prof, cmd, cw.dir), prof, cw.dir)',
      'runShellCommand(shellInvocation({ file: prof.file, args: [] }, cmd, cw.dir), prof, cw.dir)'),
  },
  {
    name: "48 main：输出不走 decodeBytes（**中文乱码回归** —— 本轮的第一号问题）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'const so = decodeBytes(Buffer.concat(outChunks));',
      'const so = { text: Buffer.concat(outChunks).toString("utf8"), encoding: "utf-8", loose: false };'),
  },
  {
    name: "49 main：`loose` 不回带（界面永远显示不出「编码没能确认」）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'const looseEncoding = so.loose || se.loose;', 'const looseEncoding = false;'),
  },
  {
    name: "50 main：超时不杀进程树（留下孤儿 + `close` 永不到来 ⇒ 终端挂死）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'killProcessTree(child.pid, { onDone: () => { try { child.kill(); } catch { /* 已退出 */ } } });',
      'child.kill();'),
  },
  {
    name: "51 main：超时文案改掉（用户以为命令正常结束了 —— 旧实现的坑）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'notes.push(`命令超过 ${TERM_TIMEOUT_MS / 1000} 秒未结束，已终止进程树`);',
      'notes.push(`命令已结束`);'),
  },
  {
    name: "52 main：cwd 不由主进程回带（渲染层拿不到事实 ⇒ cd 静默失效）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'res.cwd = nextTermCwd(cmd, cw.dir, prof.kind);', 'res.cwd = cw.dir;'),
  },
  {
    name: "53 main：cwd 候选不做存在性校验（命令跑在不存在的目录里）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'try { return statSync(r.next).isDirectory() ? r.next : cwd; } catch { return cwd; }',
      'try { statSync(r.next); return r.next; } catch { return cwd; }'),
  },
  {
    name: "54 main：WSL 的 cwd 也走宿主 statSync（WSL 路径必然被拒 ⇒ cd 在 WSL 里永远不生效）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'if (kind === "wsl") { return r.next; }', 'if (false) { return r.next; }'),
  },
  {
    name: "55 main：spawn 的 cwd 对 WSL 不特殊处理（spawn 直接 ENOENT ⇒ 终端整个用不了）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'cwd: prof.kind === "wsl" ? undefined : spawnCwd,', 'cwd: spawnCwd,'),
  },

  /* ───── ⑧ preload / 渲染层 ───── */
  {
    name: "56 preload：exec 不传 profileId（选中的 shell 传不到主进程）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, 'ipcRenderer.invoke("slime:term:exec", { cmd, cwd, profileId }) as Promise<TermResult>,',
      'ipcRenderer.invoke("slime:term:exec", { cmd, cwd }) as Promise<TermResult>,'),
  },
  {
    name: "57 preload：不暴露 profiles（下拉永远探测不到）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, 'ipcRenderer.invoke("slime:term:profiles") as Promise<TermProfilesResult>,',
      'Promise.resolve({ ok: false, error: "n/a" } as TermProfilesResult),'),
  },
  {
    name: "58 sidebar：不探测主机 shell（下拉永远空）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'try { res = await api?.term?.profiles?.(); } catch (e) {', 'try { res = undefined; } catch (e) {'),
  },
  {
    name: "59 sidebar：下拉的 onChange 断了（选了没反应 —— 最容易被「看起来做了」骗过的一条）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'onChange={(e) => setProfileId(e.target.value)}', 'onChange={() => { /* 断线 */ }}'),
  },
  {
    name: "60 sidebar：不解析 ANSI（退回「满屏转义垃圾」）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'const spans = parseAnsi(line);', 'const spans = [{ text: stripAnsi(line) }];'),
  },
  {
    name: "61 sidebar：不显示 notice（超时/截断/编码兜底全部静默）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'if (res.notice) { extra.push({ kind: "notice", text: res.notice }); }', '/* 吞掉 notice */'),
  },
  {
    name: "62 sidebar：不采用主进程回带的 cwd（cd 之后下一条命令跑回原目录）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'setCwd(res.cwd ?? (props.workspace ?? ""));', 'setCwd(props.workspace ?? "");'),
  },
];

const arg = process.argv;
const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const p = spawnSync(process.execPath, [
    join(ROOT, "node_modules/.pnpm/vitest@2.1.0_@types+node@24.13.3_supports-color@7.1.0/node_modules/vitest/vitest.mjs"),
    "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot",
  ], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = (p.stdout || "") + (p.stderr || "");
  const spawnBlocked = /EBUSY|EINVAL.*spawn/i.test(out) && /node_modules/.test(out);
  const hasSummary = /Tests\s+\d+\s+(failed|passed)/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
  return { ok: p.status === 0, out, spawnBlocked, measurementFailed: !hasSummary };
}

const mode = arg.includes("--list") ? "list"
  : arg.includes("--restore") ? "restore"
    : arg.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(arg[arg.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮变异还没还原 —— 先 --restore。"); process.exit(1); }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* ⚠️ 签名是 `installRestoreOnSignal(targets, root)`（传**路径数组**，不是回调）——
   传回调时它内部 `targets.map` 直接 TypeError，而本环境全量模式跑不到那一行 ⇒ 缺陷会一直潜伏。 */
installRestoreOnSignal(TARGETS, ROOT);

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1139")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { for (const t of TARGETS) { writeFileSync(abs(t), originals.get(t)); } }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
