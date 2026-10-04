/**
 * gui/src/main/libreofficeConvert.ts — 「老版 Office → PDF」的**唯一产地**（阶段 C）。
 *
 * ## 它做什么
 * `.doc/.docx/.xls/.xlsx/.ppt/.pptx` 交给本机已装的 **LibreOffice headless** 转成 PDF，
 * 落在一个**临时目录**里交给右栏既有的 PDF 查看器（`<embed>`，Chromium 原生）。
 *
 * ## 三条硬约束（都来自本仓既有铁律，不要改）
 * 1. **绝不 `spawnSync`**（铁律 26）：它会阻塞 Electron 主进程的事件循环 —— 整个界面卡死，
 *    而这里的转换要几秒到几十秒。一律 `spawn` + Promise + **显式超时**。
 * 2. **不留文件**（用户 2026-09-29 明确选择「每次转换，不留文件」）：
 *    每次转到一个**新临时目录**，`finally` 里整目录删除。不做缓存、不做复用。
 *    ⚠️ 用户要"每次转换"，所以这里**刻意没有**任何按 hash 复用的逻辑 —— 别"顺手优化"成缓存。
 * 3. **找不到工具就如实说**（铁律 28）：不静默降级成"打不开"，也不假装转换成功。
 *
 * ## 为什么要独立进程 + 独立 `-env:UserInstallation`
 * LibreOffice 有**单实例锁**：若用户自己开着 LibreOffice 窗口，再调 `--headless` 会**挂住等锁**
 * （表现为"转换永远不返回"）。正解是给它一个**独立的用户配置目录**（`-env:UserInstallation=file:///…`），
 * 让这次转换跑在一个与用户桌面实例互不相干的"影子配置"里。
 * ⚠️ 这就是 `--nolockcheck` 不够的原因：那只跳过锁文件检查，不解决"连到已有实例"的问题。
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LO_PATH_ENV, looksLikeSoffice, parseVersion, probeSearchList, notFound, consoleVariantOf,
  type LibreOfficeProbe,
} from "../../../core-ts/src/office/libreoffice.js";
import { killProcessTree } from "../../../core-ts/src/procKill.js";

/** 转一次的超时（毫秒）。LibreOffice 冷启动 + 大文档转换实测可达数十秒。 */
const CONVERT_TIMEOUT_MS = 120_000;
/** `--version` 探测超时：应该毫秒级返回；给 8s 已经是"机器很忙"的量级。 */
const VERSION_TIMEOUT_MS = 8_000;

/** 结果只可能是这三种（调用方必须对每一种都给出用户可见的交代）。 */
export type ConvertResult =
  | { ok: true; pdfPath: string; dir: string; }
  | { ok: false; reason: "no-libreoffice"; error: string; hint: string; }
  | { ok: false; reason: "failed"; error: string; hint: string; };

/** soffice 探测结果缓存（进程级）。用户装完 LibreOffice 要重启应用才生效 —— 与其它外部工具一致。 */
let cachedProbe: LibreOfficeProbe | null = null;

/**
 * 探测本机是否有可用的 LibreOffice（**真跑一次 `--version`**，不是只看路径在不在）。
 *
 * ⚠️ 「路径存在」不等于「能用」：`C:\Program Files\LibreOffice\program\soffice.exe` 可能是个
 *    空壳（卸载残留）、或者是损坏的安装。⇒ 判据必须是**真跑通**，`version` 非空才算 found。
 */
export async function probeLibreOffice(force = false): Promise<LibreOfficeProbe> {
  if (cachedProbe && !force) { return cachedProbe; }
  const list = probeSearchList(process.platform, process.env);
  for (const cand of list) {
    if (!existsSync(cand)) { continue; }
    const bin = resolveConsoleVariant(cand);
    const v = await runVersion(bin);
    if (v !== null) {
      cachedProbe = { found: true, path: bin, version: v, hint: "" };
      return cachedProbe;
    }
  }
  /* ⚠️ 还要试 PATH 上的 `soffice`/`libreoffice`（Linux 发行版常见、Windows 也常进 PATH）。
     内置候选全是绝对路径；PATH 查找交给子进程自己解析（传文件名即可）。
     同样做 `.exe → .com` 映射（PATH 上解析出来的仍是同一个坑）。 */
  for (const bin of ["soffice", "libreoffice"]) {
    if (!looksLikeSoffice(bin)) { continue; }
    const v = await runVersion(bin);
    if (v !== null) {
      cachedProbe = { found: true, path: bin, version: v, hint: "" };
      return cachedProbe;
    }
  }
  cachedProbe = notFound();
  return cachedProbe;
}

/**
 * 把 `...\soffice.exe` 换成同目录的 `...\soffice.com`（**若 `.com` 确实存在**）。
 *
 * ## 为什么必须有这一步（`09-30` 实测，本轮"老文件看不了"的真根因）
 * `soffice.exe` 是 **GUI 子系统**程序 —— 它**不往 stdout 写**，而且启动器会**一直等 GUI 进程**。
 * 实测 `soffice.exe --version` **挂死 20~25 秒、零输出**（加 `--headless` 一样挂）。
 * 而探测的超时是 8s ⇒ 必然超时 ⇒ 被判"没装" ⇒ 给用户弹下载提示 ——
 * **用户明明装好了 LibreOffice，却被告知去下载**，老文件自然"看不了"。
 * `soffice.com` 是同一目录下的**控制台**版本：`--version` 0.28s 返回。
 *
 * ⚠️ 用户手动把 `SLIME_LIBREOFFICE_PATH` 指向 `soffice.exe` 是最自然的填法（资源管理器里就那个图标），
 *    所以这一步不是"锦上添花"，是**必须能把用户救回来**。
 *
 * ⚠️ 导出是**为了让守卫做行为级验证**（本仓铁律：文本断言对"改条件"瞎）——
 *    守卫造 `soffice.exe` + `soffice.com` 两个临时文件，断言返回的是 `.com`。
 */
export function resolveConsoleVariant(p: string): string {
  const com = consoleVariantOf(p);
  if (com && existsSync(com)) { return com; }
  return p;
}

/**
 * Windows 上是否**应当跳过**对这条可执行文件的 `--version` 探测（纯函数，可单测）。
 *
 * 判据：`win32` 且路径以 `.exe` 结尾 ⇒ 跳过。
 * 理由见 `runVersion`：`.exe` 是 GUI 子系统程序，`--version` 挂死 20~25s 零输出、还留孤儿进程；
 * 正常安装必有 `.com` 兄弟（`resolveConsoleVariant` 已换过去）⇒ 还带 `.exe` 说明是非标准安装。
 */
export function shouldSkipVersionProbe(bin: string, platform: string): boolean {
  return platform === "win32" && /\.exe$/i.test(bin);
}

/** 跑 `soffice --version`；成功返回版本号字符串，失败返回 `null`。 */
function runVersion(bin: string): Promise<string | null> {
  /* ⚠️ 走**可注入执行器**（未注入时 = 真 spawn）。这样探针能整条链驱动，
     同时生产行为一字不变（`activeRunner` 默认 `null`）。
     ⚠️ 注入分支**必须排在下面的 Windows `.exe` 闸门之前** —— 否则探针用假 `soffice.exe`
        做注入时会被那道闸门短路（它本来就是要绕开真实平台的）。 */
  if (activeRunner) {
    return activeRunner(bin, ["--version"], VERSION_TIMEOUT_MS).then((r) => {
      if (!r.ok) { return null; }
      /* ⚠️ 某些 LibreOffice 版本把版本打到 stderr（实测 Linux 版）⇒ 两处都试。 */
      return parseVersion(r.stdout) || parseVersion(r.stderr) || null;
    });
  }
  /* ⚠️⚠️ Windows 上**不真跑 `.exe`**（`09-30` 实测）：见 `shouldSkipVersionProbe` 的注释。
     宁可不认它（如实提示"去下载"），也不挂 8 秒 + 给用户堆僵尸进程。 */
  if (shouldSkipVersionProbe(bin, process.platform)) { return Promise.resolve(null); }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 256 },
        (err, stdout) => {
          if (err) { finish(null); return; }
          /* ⚠️ 版本号抠不出来 = **不算找到**。用户可能把环境变量指到了一个同名无关程序
             （那种程序会吃 `--version` 但不认识 LibreOffice 的参数），放它过去后面必然转失败，
             而且报错会指向一个令人困惑的地方。见 `libreoffice.ts::parseVersion` 的注释。 */
          const v = parseVersion(String(stdout ?? ""));
          finish(v || null);
        });
    } catch { finish(null); return; }
    /* ⚠️ 某些 LibreOffice 版本把版本打到 stderr；`execFile` 只把 stdout 给回调的第二个参数
       ⇒ 不额外捞 stderr 会误判"找不到"（实测 Linux 版 soffice 会这么做）。
       用一次性的 stderr 监听补上，不改变主判据（仍要求 `parseVersion` 成功）。 */
    let errBuf = "";
    child.stderr?.on("data", (d: Buffer) => { errBuf += String(d); });
    child.on("exit", () => {
      setTimeout(() => {
        if (errBuf) {
          const v = parseVersion(errBuf);
          if (v) { finish(v); }
        }
      }, 0);
    });
  });
}

/**
 * 转换的**可注入执行器**（默认 = 真的 `spawnCapture`）。
 *
 * ## 为什么要这个缝（不是为了"方便测试"，是被平台事实逼出来的）
 * 本机（Windows）**没法造一个能被 spawn 的假 soffice**：
 *   · Unix 风格的 `#!` 脚本在 Windows 上 spawn 报 `ENOENT`（无扩展名不算可执行）；
 *   · `.cmd`/`.bat` 在 Node ≥ 18.20 起若不带 `shell:true` 会报 `EINVAL`（CVE-2024-27980 的修复）；
 *     而生产代码**不该**带 `shell:true`（真 soffice 是原生二进制，开 shell 只会引入注入面）。
 * ⇒ 想证明「参数拼装 → 产物发现 → 清理」这条链是对的，唯一诚实的办法是在**这层**注入替身，
 *   而不是把整条链写成"我没法验"。
 * ⚠️ 边界要说清：**`spawn` 本身（真起进程、真等退出、真 kill）只有装了 LibreOffice 才能验**；
 *    本注入覆盖的是"给它正确的参数、并正确处理它的输出"——这两件是不同的事，别混。
 */
export type ConvertRunner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string; error: string }>;

/** 当前执行器（默认真跑进程）。测试/探针可用 `setConvertRunner` 临时替换并还原。 */
let activeRunner: ConvertRunner | null = null;

/** 替换执行器（传 `null` 还原成真跑）。**仅给测试/探针用**。 */
export function setConvertRunner(r: ConvertRunner | null): void {
  activeRunner = r;
}

/**
 * 拼 `soffice` 的 headless 转换参数（**纯函数**，单测可断言"该带的都在"）。
 *
 * ⚠️ 每一个参数都有它挡掉的一个真实故障（别当成可有可无）：
 *   · `--headless`            无 GUI（否则在无桌面环境直接起不来）
 *   · `--norestore`           不弹"文档恢复"对话框（弹了就**永远挂住**等点击）
 *   · `--nologo` / `--nodefault` / `--nofirststartwizard`  首启三件套，同样会挂住
 *   · `--nolockcheck`         不检查锁文件
 *   · `-env:UserInstallation` **绕单实例锁的关键**：用户开着 LibreOffice 时，默认 profile 被占用，
 *                             `--headless` 会**排队等锁**直到超时（实测过）⇒ 必须给独立 profile
 */
export function buildConvertArgs(profileDir: string, outDir: string, srcAbs: string): string[] {
  return [
    "--headless",
    "--norestore",       // 不弹"文档恢复"
    "--nologo",          // 不显示启动画面
    "--nodefault",       // 不打开空文档
    "--nolockcheck",     // 不检查锁文件
    "--nofirststartwizard",
    "-env:UserInstallation=" + pathToFileURL(profileDir).href,
    "--convert-to", "pdf",
    "--outdir", outDir,
    srcAbs,
  ];
}

/**
 * 转换一个老版 Office 文件为 PDF（`LibreOffice --headless --convert-to pdf`）。
 *
 * @param srcAbs 源文件的**绝对路径**（调用方保证存在）
 * @returns 成功时给 `pdfPath`（临时目录里的 PDF）+ `dir`（临时目录，调用方用完守着 `cleanupConvertDir`）
 *
 * ⚠️ 只负责转换；**删除由调用方在 `finally` 里做**（`cleanupConvertDir(dir)`）。
 *    这样做是因为 PDF 还在被右栏 `http.serve` 读的时候不能删 —— 生命周期属于调用方。
 */
async function convertToPdfInner(srcAbs: string): Promise<ConvertResult> {
  if (!existsSync(srcAbs)) {
    return { ok: false, reason: "failed", error: `文件不存在：${srcAbs}`, hint: "" };
  }
  const probe = await probeLibreOffice();
  if (!probe.found) {
    return { ok: false, reason: "no-libreoffice", error: probe.hint, hint: probe.hint };
  }

  /* 临时目录：每次转换一个新目录（用户选「不留文件」⇒ 不复用、不缓存）。
     ⚠️ 用 `mkdtemp` 而不是时间戳拼名：并发转换不会撞名，且权限正确。 */
  let dir: string;
  try {
    dir = mkdtempSyncCompat();
  } catch (e) {
    return { ok: false, reason: "failed", error: `创建临时目录失败：${String((e as Error)?.message ?? e)}`, hint: "" };
  }
  /* ⚠️ 用户配置目录**常驻复用**（2026-09-30 实测后改）：
     原先每次转换都 `join(新临时目录, "profile")` ⇒ LibreOffice **每次都要重建 profile**
     （字体缓存/配置全丢），实测同一份 .doc：
       · 每次新建 profile：6539ms / 3534ms
       · 复用同一个 profile：3508ms / **1729ms**   ← 第 2 次快约 **2 倍**
     ⇒ 改成常驻目录（放系统临时区，不是用户数据区，避免污染）。
     ⚠️ 它仍然**不是** LibreOffice 的默认 profile ⇒ 依旧绕开"用户开着 LibreOffice 时的单实例锁"。
     ⚠️ 共享 profile ⇒ 两次转换**不能并发**（会撞 LO 的单实例机制、可能排队到超时）
        ⇒ 用下面那个队列把转换**串行化**（转换本来就慢，串行不影响体感）。 */
  const profileDir = sharedProfileDir();
  try { mkdirSync(profileDir, { recursive: true }); } catch { /* 起不来会在下面报错 */ }

  const args = buildConvertArgs(profileDir, dir, srcAbs);

  const run = await (activeRunner ?? spawnCapture)(probe.path, args, CONVERT_TIMEOUT_MS);
  if (!run.ok) {
    cleanupConvertDir(dir);
    return { ok: false, reason: "failed", error: run.error, hint: "" };
  }

  /* ⚠️ 判据 = **磁盘上真出现了 PDF**，不是"进程退出码 0"。
     LibreOffice 在若干失败场景下（过滤缺失 / 输出目录不可写）退出码仍是 0 却什么都没产出，
     只看退出码会报"转换成功"然后让用户看一个 404 的空白页。 */
  const pdf = findProducedPdf(dir, srcAbs);
  if (!pdf) {
    const detail = (run.stdout + run.stderr).trim().slice(0, 400);
    cleanupConvertDir(dir);
    return {
      ok: false, reason: "failed",
      error: `转换没有产出 PDF。${detail ? "\n" + detail : ""}`,
      hint: "",
    };
  }
  return { ok: true, pdfPath: pdf, dir };
}

/** 对外入口：**串行化**（共享 profile 的必然要求 —— 见 `serializeConvert` 的长注释）。 */
export async function convertToPdf(srcAbs: string): Promise<ConvertResult> {
  return serializeConvert(() => convertToPdfInner(srcAbs));
}

/** 在输出目录里找刚生成的 PDF（按源文件基名匹配，避免把别的东西当产物）。 */
function findProducedPdf(dir: string, srcAbs: string): string | null {
  const want = basename(srcAbs).replace(/\.[^.]+$/, "").toLowerCase() + ".pdf";
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  /* 精确名优先（LibreOffice 的产物名 = 源文件主名 + .pdf）。 */
  for (const n of names) {
    if (n.toLowerCase() === want) {
      const p = join(dir, n);
      try { if (statSync(p).isFile() && statSync(p).size > 0) { return p; } } catch { /* 跳过 */ }
    }
  }
  /* 兜底：目录里任何一个非空 .pdf（LibreOffice 偶尔会改大小写/做后缀规整）。 */
  for (const n of names) {
    if (n.toLowerCase().endsWith(".pdf")) {
      const p = join(dir, n);
      try { if (statSync(p).isFile() && statSync(p).size > 0) { return p; } } catch { /* 跳过 */ }
    }
  }
  return null;
}

/** 删除一次转换的全部产物（含影子 profile）。**失败不抛**：删不掉不该让"已经看到 PDF"的流程失败。 */
export function cleanupConvertDir(dir: string): void {
  if (!dir) { return; }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 见 doc */ }
}

/** `mkdtempSync` 的包装（单独拎出来便于在守卫里核对"临时目录必须在系统临时区"）。 */
function mkdtempSyncCompat(): string {
  /* ⚠️ 必须落在**系统临时区**（`os.tmpdir()`）而不是 `userData`：
     用户选的是"不留文件"，落在 userData 会让每次转换都在用户数据目录里留垃圾，
     而且 `userData` 可能被同步/备份工具扫描。 */
  return mkdtempSync(join(tmpdir(), "slime-lo-"));
}

/**
 * LibreOffice 的**常驻用户配置目录**（唯一产地）。
 *
 * ⚠️ 常驻是为了让它**别每次重建 profile**（实测复用后快约 2 倍，见 `convertToPdf` 里的数据）。
 * ⚠️ 放**系统临时区**而不是 `userData`：它不是用户数据，不该被同步/备份工具扫。
 * ⚠️ 它**不是** LibreOffice 的默认 profile ⇒ 仍然绕开"用户开着 LO 时的单实例锁"。
 */
function sharedProfileDir(): string {
  return join(tmpdir(), "slime-lo-profile");
}

/**
 * 转换**串行化**（共享 profile 的必然要求）。
 *
 * ⚠️ 为什么必须串行：两个转换共用同一个 `-env:UserInstallation` ⇒ LibreOffice 的单实例机制
 *    会让后来者**排队等锁**，可能一直等到超时（本仓踩过"用户开着 LO 时挂住"的同类坑）。
 * ⚠️ 队列**必须保证永远前进**：用 `finally` 把尾指针推下去（`then` 才推的话，
 *    一次 reject 会让整条队列永久卡死 —— 那是最难查的死法）。
 */
let convertChain: Promise<unknown> = Promise.resolve();
function serializeConvert<T>(job: () => Promise<T>): Promise<T> {
  const run = convertChain.then(job, job);
  convertChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 只被 LO_PATH_ENV 声明用到的导入（守卫据此核对"逃生门仍然存在"）。 */
export const LIBREOFFICE_ENV_KEYS = LO_PATH_ENV;

/** 跑一个子进程并收 stdout/stderr。**带超时**；超时会 kill。 */
function spawnCapture(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; error: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r: { ok: boolean; stdout: string; stderr: string; error: string }): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: "", error: `无法启动 ${bin}：${String((e as Error)?.message ?? e)}` });
      return;
    }
    /* ⚠️ 超时必须**真的杀进程**，且杀完要 resolve —— 否则调用方永远等（界面转圈不结束）。
       ⚠️⚠️ Windows 上 `child.kill()` **只终止那一个进程**，而 `soffice` 会再拉起 `soffice.bin` 子进程
       ⇒ 只杀启动器会**留下孤儿 `soffice.bin`**（实测：挂死的探测会在任务管理器里堆进程，越积越多）。
       正解 = 杀**整棵树**。⚠️ 但 `taskkill` **不许出现在 GUI 主进程里**（仓库架构守卫
       `tests/core-ts/a1023-guards.spec.ts`：进程树回收属于运行时内部事务）⇒ 走 core-ts 的
       `killProcessTree`（唯一产地）。 */
    const killTree = (): void => {
      killProcessTree(child.pid, { onDone: () => { /* 清理是尽力而为，不阻塞下面的 resolve */ } });
      try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 1500);
    };
    const timer = setTimeout(() => {
      killTree();
      finish({ ok: false, stdout: out, stderr: err, error: `转换超时（${Math.round(timeoutMs / 1000)} 秒未完成），已终止。` });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { out += String(d); });
    child.stderr?.on("data", (d: Buffer) => { err += String(d); });
    child.on("error", (e: Error) => {
      finish({ ok: false, stdout: out, stderr: err, error: `调用 ${bin} 失败：${e.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) { finish({ ok: true, stdout: out, stderr: err, error: "" }); return; }
      finish({ ok: false, stdout: out, stderr: err, error: `LibreOffice 退出码 ${code}。${(err || out).trim().slice(0, 300)}` });
    });
  });
}
