/**
 * A-1136 阶段 C：老版 Office（.doc/.xls/.ppt）→ LibreOffice headless → PDF 的守卫。
 *
 * ## 用户原话（2026-09-29，两段都要满足）
 * ① 「做完以上的优化，就继续"**阶段 C**……这个对于老文件的适配吧」；
 * ② 「做的时候**别忘了时时检查一下新老文件 Agent 能否解析阅读**……不要到头来用户能看了，
 *    Agent 不能看了，我要的是人与 Agent 协作，Agent 不能看不能修改那就没有意义了。」
 *
 * ## 本 spec 覆盖四块（对应四个"唯一产地"）
 * - ㈠ `core-ts/src/office/libreoffice.ts` —— 「本机有没有 LO」纯判据（候选表/版本解析/逃生门）。
 * - ㈡ `core-ts/src/doc_text.ts` —— `.doc` 乱码的**三层防线**（wIdent / fEncrypted / 逐段去重率）。
 *    ⚠️ 第三层是**启发式**，本 spec 必须把"阈值从哪来"钉成**可复算的事实**，
 *    否则下一次有人凭感觉改阈值，就会静默把垃圾喂给 Agent（本轮已踩：首版 0.75 打不穿 0.661）。
 * - ㈢ `gui/src/main/libreofficeConvert.ts` —— 转换入口的**声学形状**（绝不 spawnSync / 必须有超时 kill）。
 * - ㈣ `gui/src/renderer/pages/RightSidebar.tsx` —— 缺依赖/转换失败时**不默默退回文本**，
 *    而是**带着可操作提示**打开文件页（A-1133 教训：静默降级 = 用户以为"没做"）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  looksLikeSoffice,
  parseVersion,
  candidatesFor,
  probeSearchList,
  notFound,
  consoleVariantOf,
  LO_PATH_ENV,
  LO_DOWNLOAD_HINT,
} from "../../core-ts/src/office/libreoffice.js";
import {
  looksLikeRealText,
  FAKE_TEXT_DEDUP_RATIO,
  DOC_WIDENT,
  validateDocFib,
} from "../../core-ts/src/doc_text.js";
import {
  buildConvertArgs,
  resolveConsoleVariant,
  shouldSkipVersionProbe,
} from "../../gui/src/main/libreofficeConvert.js";
import { taskkillArgs, needsTreeKill } from "../../core-ts/src/procKill.js";
import { planRender, fallbackRender, canFaithfullyRender } from "../../core-ts/src/office/renderPlan.js";
import { writeRenderPage } from "../../gui/src/main/docRenderPage.js";

/** 造一个最小的合法 FIB 头（32 字节起），便于**行为级**验三道规范判据。 */
function fib(opts: { wIdent?: number; flags?: number; len?: number } = {}): Buffer {
  const len = opts.len ?? 64;
  const b = Buffer.alloc(len);
  b.writeUInt16LE(opts.wIdent ?? DOC_WIDENT, 0x0000);
  b.writeUInt16LE(193, 0x0002);                        // nFib = 193（Word 97）
  b.writeUInt16LE(opts.flags ?? 0, 0x000A);            // fibBase.flags
  return b;
}

/** 读源码并**真正剥掉注释**（本仓既有范式：`a1121-sidebar-open.spec.ts` 同款）。
 *
 * ⚠️⚠️ 不能只按"行首是不是 `*` / `//`"过滤 —— 本仓 JSDoc 里有大量以 `⚠️`、反引号、`⇒`、`教训：`
 *   **开头的续行**，它们都不以 `*` 开头，会被朴素过滤**当代码留下**。后果双向都坏：
 *     · 假绿：`toContain("某标识")` 在**注释里**命中（而这正是铁律 3 说的"文本断言"陷阱）；
 *     · 假红：注释把 `slice(i, i+N)` 的窗口撑爆，真正的代码行落在窗口外。
 *   ⇒ 必须**成对剥块注释**（`/* … *\/`），再逐行去掉 `//`。 */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/* ─────────────────────────── ㈠ LibreOffice 探测纯判据 ─────────────────────────── */

describe("A-1136-C ㈠ LibreOffice 探测（唯一产地，纯函数）", () => {
  it("looksLikeSoffice：认本体、拒目录与旁路文件", () => {
    /* 白名单三条（Windows exe / Unix bin / Unix 无扩展名）+ Debian 别名 */
    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice\\program\\soffice.exe")).toBe(true);
    expect(looksLikeSoffice("/usr/lib/libreoffice/program/soffice.bin")).toBe(true);
    expect(looksLikeSoffice("/usr/bin/soffice")).toBe(true);
    expect(looksLikeSoffice("/usr/bin/libreoffice")).toBe(true);
    /* ⚠️ 用户最常填错的两种：填目录、填快捷方式 */
    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice\\program")).toBe(false);
    expect(looksLikeSoffice("/Applications/LibreOffice.app")).toBe(false);
    expect(looksLikeSoffice("")).toBe(false);
    expect(looksLikeSoffice("soffice.lnk")).toBe(false);
  });

  it("⚠️ 回归：`libreoffice` 别名**只在 Unix 成立**（Windows 目录不许被当成本体）", () => {
    /* 2026-09-29 由本 spec 抓出的真 bug：`C:\Program Files\LibreOffice` 的 basename 小写后
       正好是 `libreoffice`，若裸放行别名就会被当成可执行文件 ⇒ 用户把环境变量填成**目录**时
       瞒过闸门，调用方拿目录去 spawn ⇒ 报令人困惑的 spawn 错，
       而原意是给"路径填错了"的清晰提示。 */
    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice")).toBe(false);
    expect(looksLikeSoffice("D:\\LibreOffice")).toBe(false);
    /* Unix 侧的两种合法形态必须仍然通过 */
    expect(looksLikeSoffice("/usr/bin/libreoffice")).toBe(true);
    expect(looksLikeSoffice("/opt/libreoffice/libreoffice")).toBe(true);
    /* Windows 上真要给别名路径，必须带 .exe */
    expect(looksLikeSoffice("C:\\LO\\libreoffice.exe")).toBe(true);
  });

  it("parseVersion：抠出各版本输出里的版本号，抠不到就返回空串（不许编假值）", () => {
    expect(parseVersion("LibreOffice 7.6.4.1 639b8ac485750d569b4b5aba30b0d0a6f2e0b8a0")).toBe("7.6.4.1");
    expect(parseVersion("LibreOffice 24.2.5.2 (X86_64)")).toBe("24.2.5.2");
    /* ⚠️ 空串 = "没真跑过"，这是调用方区分"找到了"与"验证过"的唯一语义 —— 不许返回 "unknown" */
    expect(parseVersion("")).toBe("");
    expect(parseVersion("no such thing")).toBe("");
  });

  it("candidatesFor：三平台都有候选；未知平台给空数组而不是抛错", () => {
    expect(candidatesFor("win32").length).toBeGreaterThan(0);
    expect(candidatesFor("darwin").length).toBeGreaterThan(0);
    expect(candidatesFor("linux").length).toBeGreaterThan(0);
    /* 未知平台 ⇒ 找不到 ⇒ 走"如实提示下载"，比崩掉好 */
    expect(candidatesFor("aix")).toEqual([]);
  });

  it("probeSearchList：环境变量覆盖**优先于**内置候选，且去重保序", () => {
    const custom = "D:\\portable\\LibreOffice\\program\\soffice.exe";
    const list = probeSearchList("win32", { [LO_PATH_ENV[0]]: custom });
    expect(list[0]).toBe(custom);                                  // 用户指定永远第一
    const again = probeSearchList("win32", {
      [LO_PATH_ENV[0]]: custom,
      [LO_PATH_ENV[1]]: custom,                                    // 两个变量填同一条
    });
    expect(again.filter((p) => p === custom).length).toBe(1);      // 去重
    /* ⚠️ 环境变量被填成目录 ⇒ looksLikeSoffice 拦掉 ⇒ **这一条**不进清单（不能拿目录去 spawn）。
       注意不能用 `not.toContain(...)` 判子串 —— 内置候选 `…\LibreOffice\program\soffice.exe`
       恰好包含 `…\LibreOffice` 这段前缀，那样断言会被**内置那个合法项**满足（假红/假绿）。
       正解：判清单里**没有任何一项恰好等于**那个目录。 */
    const DIR_ONLY = "C:\\Program Files\\LibreOffice";
    const bad = probeSearchList("win32", { [LO_PATH_ENV[0]]: DIR_ONLY });
    expect(bad.every((p) => p !== DIR_ONLY)).toBe(true);
    /* 没有覆盖时，内置候选原样保留（顺序 = 优先级） */
    expect(probeSearchList("win32", {})[0]).toBe(candidatesFor("win32")[0]);
  });

  it("notFound()：唯一构造点，含可操作下载地址与「现有文件仍可读」的安抚", () => {
    const nf = notFound();
    expect(nf.found).toBe(false);
    expect(nf.path).toBe("");
    expect(nf.version).toBe("");
    expect(nf.hint).toContain("https://www.libreoffice.org/");   // 必须真的可操作
    expect(nf.hint).toBe(LO_DOWNLOAD_HINT);                      // 文案一处产地
    /* ⚠️ 必须告诉用户"现有体验不受损"，否则会把"缺依赖"误读成"文件打不开了" */
    expect(LO_DOWNLOAD_HINT).toContain("仍可正常阅读");
  });
});

/* ─────────────────────── ㈡ .doc 三层防线（本轮根因修复） ─────────────────────── */

describe("A-1136-C ㈡ .doc 三层防线：规范判据 + 逐段去重率", () => {
  it("wIdent 常量 = 0xA5EC（MS-DOC 2.5.1 规范值，唯一产地）", () => {
    expect(DOC_WIDENT).toBe(0xa5ec);
  });

  it("阈值必须有实测依据：正常中文段上界 < 阈值 < 损坏段下界", () => {
    /* 这组数字来自 `gui/scripts/_diag-doc-ratio.mjs` 逐段实量（见 doc_text.ts 注释里的表）：
       正常段 0.123 / 0.298 / 0.319 / 0.357 / 0.390 ；损坏段 0.661。
       ⇒ 阈值必须落在 (0.390, 0.661) 开区间内，两侧才有余量。 */
    expect(FAKE_TEXT_DEDUP_RATIO).toBeGreaterThan(0.39);
    expect(FAKE_TEXT_DEDUP_RATIO).toBeLessThan(0.661);
  });

  it("looksLikeRealText：真实中文放行、伪汉字拦下（用实测量的两端做样本）", () => {
    /* 真实正文：从实样本里取规律汉字（用字集中 ⇒ 去重率低） */
    const real = "传感器是把被测量按一定规律转换成可用输出信号的器件或装置，通常由敏感元件和转换元件组成，其基本特性包括静态特性和动态特性两个方面，静态特性有线性度灵敏度和重复性等指标。".repeat(4);
    expect(looksLikeRealText(real)).toBe(true);

    /* 伪汉字：均匀散落在 CJK 区、几乎字字不同（模拟"被按 UTF-16 解的随机字节"） */
    let fake = "";
    for (let i = 0; i < 400; i++) { fake += String.fromCharCode(0x4e00 + i * 7); }
    expect(looksLikeRealText(fake)).toBe(false);
  });

  it("looksLikeRealText：短样本不下结论（< 80 字一律放行）—— 短句可以是任意组合", () => {
    /* 60 个互不相同的伪汉字，长度不够 ⇒ 统计无意义 ⇒ 放行（宁可放行也不误杀） */
    let short = "";
    for (let i = 0; i < 60; i++) { short += String.fromCharCode(0x4e00 + i * 7); }
    expect(looksLikeRealText(short)).toBe(true);
  });

  it("源码里三层防线**都在**（缺一层就退化成「把垃圾当真」或「读都没有」）", () => {
    const src = codeOf("core-ts/src/doc_text.ts");
    /* ① wIdent 规范判据 */
    expect(src).toContain("DOC_WIDENT");
    expect(src).toMatch(/wIdent\s*!==\s*DOC_WIDENT/);
    /* ② fEncrypted 规范判据（0x0100） */
    expect(src).toMatch(/0x0100/);
    expect(src).toContain("fEncrypted");
    /* ③ 逐段去重率（启发式）—— 且必须有 bad 计数上传 */
    expect(src).toContain("looksLikeRealText");
    expect(src).toContain("bad += 1");
  });

  /* ⚠️⚠️ 上面那条是**文本断言**，对"改条件"是瞎的（铁律 3）：把 `if ((flags & 0x0100) !== 0)`
     改成 `if (false)`，那些字符串一字未动、`toContain` 照样绿 —— 实测 M22 曾因此**存活**。
     ⇒ 规范判据必须**行为级**验：喂合成 FIB 字节进去，断言它**抛错**。 */

  it("行为级 · wIdent 不对 ⇒ 抛错（不是「读出一堆伪汉字」）", () => {
    expect(() => validateDocFib(fib({ wIdent: 0xcfd0 }))).toThrow(/wIdent/i);
    expect(() => validateDocFib(fib({ wIdent: DOC_WIDENT }))).not.toThrow();
  });

  it("行为级 · fEncrypted（bit8）⇒ 抛错，并给出「输入口令另存 docx」的可操作出路", () => {
    expect(() => validateDocFib(fib({ flags: 0x0100 }))).toThrow(/加密/);
    /* ⚠️ 只抛错还不够 —— 必须告诉用户怎么办（否则他只会以为"文件坏了"） */
    expect(() => validateDocFib(fib({ flags: 0x0100 }))).toThrow(/docx/);
  });

  it("行为级 · fObfuscated（bit15，旧式 XOR 混淆）同样拦下", () => {
    expect(() => validateDocFib(fib({ flags: 0x8000 }))).toThrow(/加密/);
  });

  it("行为级 · 流太短（读不到 FIB 头）⇒ 抛错，不静默返回空", () => {
    expect(() => validateDocFib(fib({ len: 16 }))).toThrow(/过短/);
  });

  it("行为级 · 干净的 FIB（只置合法位）⇒ 放行", () => {
    /* fWhichTblStm（bit9）是正常的，不该被误判成加密 */
    expect(() => validateDocFib(fib({ flags: 0x0200 }))).not.toThrow();
    expect(() => validateDocFib(fib({ flags: 0x0004 }))).not.toThrow();  // fComplex
  });
});

/* ───────── ㈤ Windows 必须用 `soffice.com`（09-30 本轮「老文件看不了」的真根因）─────────
 *
 * 实测事实（`probe-libreoffice-e2e.mjs` ① 真机模式复现）：
 *   `soffice.exe --version`  → **挂死 20~25s、零输出**（加 `--headless` 也一样），且留孤儿 `soffice.bin`
 *   `soffice.com --version`  → **0.28s** 返回 `LibreOffice 26.8.0.3 …`
 * `.exe` 是 **GUI 子系统**程序：不往 stdout 写。探测超时 8s ⇒ 被判"没装" ⇒
 * **用户装了 LibreOffice 却被提示去下载** ⇒ 老文件"看不了"。
 */

describe("A-1136-C ㈤ Windows 必须用 soffice.com（本轮故障的回归守卫）", () => {
  it("looksLikeSoffice 认 `soffice.com`（控制台版）", () => {
    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice\\program\\soffice.com")).toBe(true);
  });

  it("⚠️ win32 候选表：`.com` 必须**排在** `.exe` 之前（否则先撞上挂死的那个）", () => {
    const list = candidatesFor("win32");
    const firstExe = list.findIndex((p) => /\.exe$/i.test(p));
    const lastCom = list.map((p) => /\.com$/i.test(p)).lastIndexOf(true);
    expect(lastCom, "候选表里没有 .com ⇒ 会退回挂死的 .exe").toBeGreaterThanOrEqual(0);
    expect(firstExe, "候选表里没有 .exe 兜底").toBeGreaterThanOrEqual(0);
    expect(lastCom, "`.com` 必须全部排在 `.exe` 之前").toBeLessThan(firstExe);
  });

  it("probeSearchList：win32 无覆盖时**首选就是 `.com`**", () => {
    expect(probeSearchList("win32", {})[0].toLowerCase().endsWith("soffice.com")).toBe(true);
  });

  it("consoleVariantOf：`.exe` → 同目录 `.com`（**保留原分隔符**）；其他形态不映射", () => {
    expect(consoleVariantOf("C:\\Program Files\\LibreOffice\\program\\soffice.exe"))
      .toBe("C:\\Program Files\\LibreOffice\\program\\soffice.com");
    expect(consoleVariantOf("/usr/bin/soffice.com")).toBe(null);      // 已经是 .com
    expect(consoleVariantOf("/usr/bin/soffice")).toBe(null);          // Unix 无扩展名
    expect(consoleVariantOf("/usr/bin/soffice.bin")).toBe(null);      // .bin 不映射
    expect(consoleVariantOf("C:\\LO\\libreoffice.exe")).toBe(null);   // 别名不映射
  });

  it("行为级 · resolveConsoleVariant：`.com` 兄弟**存在**才换（本修法核心）", () => {
    const d = mkdtempSync(join(tmpdir(), "slime-cv-"));
    const exe = join(d, "soffice.exe");
    const com = join(d, "soffice.com");
    try {
      writeFileSync(exe, "x");
      expect(resolveConsoleVariant(exe), "没有 .com 兄弟 ⇒ 保持原样").toBe(exe);
      writeFileSync(com, "x");
      expect(resolveConsoleVariant(exe), "有 .com 兄弟 ⇒ 换成控制台版").toBe(com);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("行为级 · shouldSkipVersionProbe：win32 的 `.exe` 跳过，其他平台/形态不跳", () => {
    expect(shouldSkipVersionProbe("C:\\lo\\soffice.exe", "win32")).toBe(true);
    expect(shouldSkipVersionProbe("C:\\lo\\soffice.com", "win32")).toBe(false);
    expect(shouldSkipVersionProbe("/usr/bin/soffice", "linux")).toBe(false);
    expect(shouldSkipVersionProbe("/usr/bin/soffice.exe", "darwin")).toBe(false);
  });

  it("源码 · 超时必须杀**整棵进程树**，且 `taskkill` 收口在 core-ts（GUI 主进程不许出现它）", () => {
    const CONV = codeOf("gui/src/main/libreofficeConvert.ts");
    /* ① 转换入口超时时必须真的调杀树 —— ⚠️ 断言**调用表达式**而不是光有个标识符：
         否则 `void 0 && killProcessTree(...)`（短路掉调用）这种改法照样能过（铁律 3）。 */
    expect(CONV).toMatch(/^\s*killProcessTree\(child\.pid/m);
    /* ② ⚠️ `taskkill` **不许**出现在 GUI 主进程里 —— 仓库既有架构守卫 a1023 的规则：
          进程树回收属于运行时内部事务（否则"谁负责回收"会有 N 个产地，铁律 11）。 */
    expect(CONV, "taskkill 必须收口在 core-ts/src/procKill.ts").not.toContain("taskkill");
    /* ③ 产地本身：必须是 taskkill /T /F（`/T` 才含子进程，`/F` 才强制） */
    const PK = codeOf("core-ts/src/procKill.ts");
    expect(PK).toContain("taskkill");
  });

  it("行为级 · procKill 纯判据：`/T /F` 与平台门", () => {
    expect(taskkillArgs(123)).toEqual(["/PID", "123", "/T", "/F"]);
    expect(needsTreeKill("win32")).toBe(true);
    expect(needsTreeKill("linux")).toBe(false);
    expect(needsTreeKill("darwin")).toBe(false);
  });
});

/* ───────────────────── ㈢ 转换入口：绝不阻塞事件循环 ───────────────────── */

describe("A-1136-C ㈢ LibreOffice 转换入口（外部进程纪律）", () => {
  const SRC = codeOf("gui/src/main/libreofficeConvert.ts");

  it("⚠️ 绝不用 spawnSync（本仓铁律：阻塞 Electron 主进程事件循环）", () => {
    expect(SRC).not.toContain("spawnSync");
    expect(SRC).not.toContain("execSync");
    expect(SRC).toContain("spawn");
  });

  it("必须有显式超时，且超时**真 kill**（SIGTERM → SIGKILL 兜底）", () => {
    expect(SRC).toContain("CONVERT_TIMEOUT_MS");
    expect(SRC).toContain("VERSION_TIMEOUT_MS");
    expect(SRC).toContain("SIGTERM");
    expect(SRC).toContain("SIGKILL");
  });

  it("绕单实例锁：必须带 `-env:UserInstallation=file://…`（否则用户开着 LO 时会挂住等锁）", () => {
    expect(SRC).toContain("-env:UserInstallation=");
    expect(SRC).toContain("pathToFileURL");
    expect(SRC).toContain("--headless");
    expect(SRC).toContain("--nolockcheck");
  });

  it("成功判据 = 磁盘上真有非空 PDF（**不是**退出码 0）", () => {
    expect(SRC).toContain("findProducedPdf");
    /* 必须真的 statSync 看大小，而不是只看 spawn 的 exitCode */
    expect(SRC).toContain("statSync");
  });

  it("参数由 `buildConvertArgs` **一处产地**拼装（每个参数都挡一个真实故障）", () => {
    const args = buildConvertArgs("/tmp/profile", "/tmp/out", "/tmp/a.doc");
    for (const flag of ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard"]) {
      expect(args, "缺 " + flag + " ⇒ 可能弹窗挂住或起不来").toContain(flag);
    }
    /* ⚠️ 绕单实例锁的关键：必须带独立 profile，且是 **file:// URL** 形态 */
    const env = args.find((a) => a.startsWith("-env:UserInstallation="));
    expect(env, "缺 -env:UserInstallation ⇒ 用户开着 LO 时排队等锁到超时").toBeTruthy();
    expect(env).toContain("file://");
    /* 产物必须落在我们指定的 outdir，且源文件是最后一个参数 */
    expect(args[args.indexOf("--convert-to") + 1]).toBe("pdf");
    expect(args[args.indexOf("--outdir") + 1]).toBe("/tmp/out");
    expect(args[args.length - 1]).toBe("/tmp/a.doc");
  });

  it("执行器可注入（平台事实逼出来的缝：Windows 上造不出能被 spawn 的假 soffice）", () => {
    expect(SRC).toContain("setConvertRunner");
    expect(SRC).toContain("activeRunner ?? spawnCapture");
  });
});

/* ────────────── ㈣ 渲染层：缺依赖/转换失败时不静默降级 ────────────── */

describe("A-1136-C ㈣ 渲染层分流：失败要**出声**（A-1133 教训）", () => {
  const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");

  it("必须有 routeNote 这条统一说明（保真没成功就要**说原因**，不许默默换样式）", () => {
    expect(SIDEBAR).toContain("routeNote");
    /* 判据必须来自 `needsLibreOffice`（唯一产地），渲染层不许自己拼"是不是老格式" */
    expect(SIDEBAR).toContain("needsLibreOffice");
  });

  it("缺依赖时把 hint 带给用户（可操作），不是只说「失败了」", () => {
    const i = SIDEBAR.indexOf("let routeNote =");
    expect(i, "RightSidebar 里找不到 let routeNote（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = SIDEBAR.slice(i, i + 1800);
    expect(body).toContain("hint");
  });

  it("⚠️⚠️ `routeNote` 必须覆盖**全部**失败形态（旧实现只覆盖两种 ⇒ 其余静默）", () => {
    /* ⚠️ 只断言 `toContain("routeNote")` 是**瞎的**（铁律 3）。
       ⚠️⚠️ 2026-09-30 用户实测：「老 Office 只显示 md 样式、**没有任何提示**」——
          旧实现只处理 `reason === "no-libreoffice"` 与 `"failed"`，下面三种**完全静默**：
            ① `rp` 为 null/undefined（IPC 未接通 / 主进程抛了）；② `rp.ok===false` 但是别的原因；
            ③ `rp.ok===true` 却 serve/URL 失败。
          ⇒ 判据 = 这三个分支**都要真的写进 routeNote**（各锚一句只属于它的文案，防被删）。 */
    const i = SIDEBAR.indexOf("let routeNote =");
    expect(i, "找不到 let routeNote（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = SIDEBAR.slice(i, i + 2400);
    /* ① 通道没响应（含「重启应用」这句可操作指引） */
    expect(body, "缺 `rp` 为空的说明 ⇒ 用户只会看到样式变了却不知为何").toContain("保真渲染通道没有响应");
    expect(body).toContain("重启应用");
    /* ② 其它失败原因（不只是那两个 reason） */
    expect(body).toMatch(/保真渲染不可用/);
    /* ③ ok 但服务/URL 失败（这条以前**完全静默**） */
    expect(body).toMatch(/本地服务没起来|没返回可用地址/);
    /* ④ 最后必须真的挂到页面上（否则等于没说） */
    expect(SIDEBAR).toContain("notice: routeNote");
  });

  it("⚠️ 保真没成功时**不许**退回纯文本文件页（用户实测「效果很差」的旧行为）", () => {
    /* 旧坏行为：`if (missingLo || convertFail) { openFileAbs(path,label,hint); return; }`
       —— 直接退回**纯文本文件页**，段落/表格结构全丢 ⇒ 用户「效果很差」。
       判据 = 在 `routeNote` 求值之后、构造结构化页之前，`openFileAbs(` **只许出现一次**，
       且必须是「连文本都抽不出来」(`!dr?.ok`) 那条兜底。
       ⚠️ 注意：窗口里还有一处 `return;` 属于**成功路径**（`if (url) { openBrowserTab(...); return; }`），
          所以不能简单地数 `return;` 的个数（我第一版就是这么写错的）。 */
    const i = SIDEBAR.indexOf("let routeNote =");
    const body = SIDEBAR.slice(i, i + 2400);
    const j = body.indexOf("docViewToHtml(");
    expect(j, "找不到结构化页构造").toBeGreaterThan(-1);
    const before = body.slice(0, j);
    const k = before.indexOf("if (!dr?.ok)");
    expect(k, "那条唯一允许的兜底是 `!dr?.ok`（连文本都抽不出来）").toBeGreaterThan(-1);
    const calls = before.match(/openFileAbs\(/g) ?? [];
    expect(calls.length, "降级前只许有 `!dr?.ok` 那一处 openFileAbs").toBe(1);
    expect(before.indexOf("openFileAbs("), "那处 openFileAbs 必须在 `!dr?.ok` 分支里").toBeGreaterThan(k);
  });

  it("文件浏览器对老格式有前置提示（装好 LO 后可看原版式）", () => {
    expect(SIDEBAR).toContain("loNote");
    expect(SIDEBAR).toContain("LibreOffice");
  });

  it("⚠️⚠️ 页面必须落进**持久**目录（rootDir 传 `conv.dir` ⇒ 页面随后被删 ⇒ 服务报「目录不存在」）", () => {
    /* ⚠️⚠️ **这条是 2026-09-30 用户截图定位的真 bug**：`writePdfViewerPage(rootDir,…)` 的 `rootDir`
       同时是**返回值 `dir`**（渲染层据此去 serve）⇒ 传 `conv.dir`（临时目录）就等于"把页面写在马上要删的
       目录里" ⇒ 只剩重排、页面提示「保真渲染页已生成，但本地服务没起来或没返回可用地址（目录不存在：…）」。
       ⚠️ **旧的守卫为什么没抓住它**：它锚的正是 `writePdfViewerPage(conv.dir` ——
          **锚在了 bug 那个写法上**，所以只要那行还在，守卫就是绿的（铁律 3：锚对象错）。
          教训：锚点必须锚**不变量**（这里是"rootDir 是持久目录"），不能锚"当前这行长什么样"。 */
    const M = codeOf("gui/src/main/index.ts");
    expect(M, "rootDir 传 conv.dir ⇒ 页面写在临时目录、随后被删")
      .not.toMatch(/writePdfViewerPage\(\s*conv\.dir/);
    /* 必须与另一个分支一致：写进 `userData/doc-render` */
    expect(M).toMatch(/writePdfViewerPage\(\s*pageRoot/);
    expect(M).toMatch(/pageRoot\s*=\s*join\(app\.getPath\("userData"\),\s*"doc-render"\)/);
  });

  it("⚠️ 转换临时目录必须**当场删**（返回给渲染层删 = 没人接住 ⇒ 每次转换漏一个目录）", () => {
    /* 2026-09-30 修的真 bug：主进程把 `convertDir` `return` 给渲染层"让渲染层删"，
       但渲染层的类型里**根本没声明**它 ⇒ 从不消费 ⇒ 每转一次在 `%TEMP%` 漏一个 `slime-lo-*`，
       **直接违反用户定的「每次转换，不留文件」**。
       判据 = 主进程在 `writePdfViewerPage` 之后**当场** `cleanupConvertDir(conv.dir)`，
       且**不再**把临时目录返回出去。
       ⚠️ 与上一条是**一对**：删临时目录**只有在页面已落进持久目录时才安全** ——
          单看这一条会误以为"删了就对"（上一版就是这么翻车的）。 */
    const M = codeOf("gui/src/main/index.ts");
    const i = M.indexOf("writePdfViewerPage(pageRoot");
    expect(i, "找不到 writePdfViewerPage(pageRoot…) 调用（改结构了？同步本守卫）").toBeGreaterThan(-1);
    /* 从调用点往后取一段（`codeOf` 已剥注释，所以这段就是纯代码，不会被注释撑开）。 */
    const after = M.slice(i, i + 800);
    const at = after.indexOf("cleanupConvertDir(conv.dir)");
    expect(at, "复制完 PDF 后必须当场 cleanupConvertDir(conv.dir)").toBeGreaterThan(0);
    /* ⚠️ 顺序：删必须在**返回成功**之前（早于复制会删掉源 PDF ⇒ 404；晚于返回则已经漏给别人）。 */
    const ret = after.indexOf("return { ok: true, dir: built.dir, name: built.name, transient: true };");
    expect(ret, "返回值形状变了（是不是又把 convertDir 塞回来了？）").toBeGreaterThan(at);
    /* 返回值里**不许**再出现 convertDir（假接口 ⇒ 下一个人以为还有谁要管这个临时目录）。 */
    expect(after.slice(ret, ret + 120)).not.toContain("convertDir");
  });
});

/* ─────────── ㈥ 老格式的兜底路线（2026-09-30 用户拍板：「LibreOffice 优先 + SheetJS 兜底」）─────────── */

describe("A-1136-C ㈥ 老格式兜底路线", () => {
  it("`.xls` 登记 `fallback: sheetjs`（BIFF8 可纯 JS 直读 —— 实测用 LibreOffice 转出的真 .xls 读出 2 表）", () => {
    const p = planRender("成绩.xls");
    expect(p.needs, "仍然**优先** LibreOffice（原版式最保真）").toBe("libreoffice");
    expect(p.fallback, "没装 LO 时也要能画出一张真表格").toBe("sheetjs");
    expect(fallbackRender("成绩.xls")).toBe("sheetjs");
    expect(fallbackRender("旧表.xlt")).toBe("sheetjs");
  });

  it("⚠️ `.doc` / `.ppt` **不许**登记 fallback（纯 JS 普遍不可靠 ⇒ 只能由渲染层做结构化降级）", () => {
    /* 给它们登记一个假 fallback（比如 text-html）会让 `faithful` 这个字段失去意义，
       还会让"没装 LO"这件事被掩盖（用户以为看到了原版式）。 */
    expect(fallbackRender("报告.doc")).toBe(null);
    expect(fallbackRender("讲义.ppt")).toBe(null);
    expect(planRender("报告.doc").fallback).toBeUndefined();
    expect(planRender("讲义.ppt").fallback).toBeUndefined();
  });

  it("新格式 / PDF 没有 fallback 概念（它们本就是保真路线）", () => {
    expect(fallbackRender("a.pptx")).toBe(null);
    expect(fallbackRender("a.docx")).toBe(null);
    expect(fallbackRender("a.pdf")).toBe(null);
  });

  it("⚠️ `useFallback` **只触发已登记的兜底**（不许调用方塞任意渲染器）", () => {
    /* 判据 = 那句**表达式本身**（不是"文件里有没有 useFallback 这个词"）：
       必须先看 `plan.fallback` 在不在，再决定要不要用。 */
    const PAGE = codeOf("gui/src/main/docRenderPage.ts");
    expect(PAGE).toMatch(/useFallback\s*=\s*opts\.useFallback\s*===\s*true\s*&&\s*!!plan\.fallback/);
  });

  it("行为级 · `.xls` 兜底真能落盘；**没登记 fallback 的类型即使传了也仍被拒**", () => {
    const dir = mkdtempSync(join(tmpdir(), "slime-fb-"));
    const xls = join(dir, "样例.xls");
    const doc = join(dir, "样例.doc");
    writeFileSync(xls, Buffer.alloc(64, 1));
    writeFileSync(doc, Buffer.alloc(64, 1));
    try {
      const r1 = writeRenderPage(join(dir, "o1"), xls, "样例.xls", { useFallback: true });
      expect(r1.ok, "`.xls` 走兜底路线必须能落盘（否则没装 LO 就啥也没有）").toBe(true);
      /* ⚠️ `.doc` 没登记 fallback ⇒ 即使传了 useFallback 也必须拒绝（否则画出来必是空白） */
      const r2 = writeRenderPage(join(dir, "o2"), doc, "样例.doc", { useFallback: true });
      expect(r2.ok, "`.doc` 没登记 fallback ⇒ useFallback 不许放行").toBe(false);
      /* 不传 useFallback 时，`.xls` 仍按「要 LibreOffice」被拒 —— 默认路径一字不变 */
      expect(writeRenderPage(join(dir, "o3"), xls, "样例.xls").ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("⚠️ 兜底/降级必须**在页面上可见地说明**（静默 = 用户以为「这文件就长这样」）", () => {
    /* 渲染页（.xls 兜底）：notice 要真的拼进 HTML */
    const PAGE = codeOf("gui/src/main/docRenderPage.ts");
    expect(PAGE).toMatch(/class="notice"/);
    expect(PAGE).toContain("notice: opts.notice");
    /* 结构化页（.doc/.ppt 降级）：同样要能挂 notice */
    const VIEW = codeOf("gui/src/renderer/pages/docView.ts");
    expect(VIEW).toContain("opts.notice");
    /* 渲染层：老格式保真没成功时走**结构化重排 + 提示**，不许退回纯文本文件页 */
    const SIDE = codeOf("gui/src/renderer/pages/RightSidebar.tsx");
    const i = SIDE.indexOf("let routeNote =");
    expect(i, "找不到 let routeNote（改结构了？同步本守卫）").toBeGreaterThan(-1);
    expect(SIDE.slice(i, i + 2400)).toContain("notice: routeNote");
  });
});

/* ─────────── ㈦ 渲染页自身的重绘纪律（2026-09-30 用户实测「全屏后一大一小两份」）─────────── */

describe("A-1136-C ㈦ pptx 重绘不许追加", () => {
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");

  it("⚠️ `draw()` 必须**先清空容器再 init**（库每次 init 都 append 一个新 wrapper）", () => {
    /* 实测库实现（`gui/vendor/pptx-preview.umd.js`）：
       `init(el,opts)` → `new NZ(el,opts)` → `_renderWrapper()` 里 `document.createElement('div')`
       并 **append 进 el**；而它自己的 `load()` 只清 **它自己那个** wrapper（`e.wrapper.innerHTML=""`）。
       ⇒ 在同一个容器上 init 两次 = **两个 wrapper 同时留在 DOM 里** = 用户看到的「一大一小两份」。
       ⚠️ 库的 `destroy()` 只做 blob 回收（`RZ("destroy")`），**不摘 DOM** ⇒ 靠它没用。
       ⚠️ 触发路径：全屏 / 拉伸窗口 ⇒ `ResizeObserver` ⇒ 再跑一次 `draw()`。 */
    const i = PAGE.indexOf("function draw(buf)");
    expect(i, "找不到 draw(buf)（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = PAGE.slice(i, i + 500);
    const clearAt = body.indexOf("wrap.innerHTML=");
    const initAt = body.indexOf("pptxPreview.init(");
    expect(clearAt, "没有清空容器 ⇒ 重画会追加出第二份").toBeGreaterThan(-1);
    expect(initAt).toBeGreaterThan(-1);
    /* ⚠️ **顺序就是判据**：清空必须在 init 之前（清在后面就晚了）。 */
    expect(clearAt, "清空必须在 init **之前**").toBeLessThan(initAt);
  });
});

/* ─────── ㈧ PDF 能在预览标签页里**真的显示**（2026-09-30：查 Electron 官方文档确认的必开项）─────── */

describe("A-1136-C ㈧ 预览 webview 的 plugins（**防守性**：实测非必需，但官方默认关闭）", () => {
  const SIDE = codeOf("gui/src/renderer/pages/RightSidebar.tsx");

  it("⚠️ `WebviewTag` 要把 `plugins` 透传成**字符串** \"true\"（React 会丢弃值为 true 的未知布尔属性）", () => {
    /* ⚠️⚠️ **先说清它不是什么**：我一度以为"不开 `plugins` ⇒ PDF 一片空白"，**已被实测证伪** ——
       `probe-pdf-webview.mjs` 用两个独立 Electron 进程做 A/B，白纸占比**都是 0.641**（差 0.0）。
       ⇒ 这条断言守的是"**防守性**开启 + 传参形式正确"，**不是**"不加就坏"。
       （错误理由比没有理由更糟：它会把后来人引到反方向 —— 铁律 23。）
       ⚠️ 与 `allowpopups` 同一个坑（那段长注释就在旁边）：React 对未知元素会**丢弃值为 `true`
          的布尔属性** ⇒ 必须传字符串 "true"，否则属性根本没落到元素上、且只在控制台留一条警告。
       ⚠️ 断言的是**表达式**（不是"文件里有没有 plugins 这个词"）—— 铁律 3。 */
    const i = SIDE.indexOf("const WebviewTag =");
    expect(i, "找不到 WebviewTag 定义（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = SIDE.slice(i, i + 2200);
    expect(body).toMatch(/plugins:\s*props\.plugins\s*\?\s*"true"\s*:\s*undefined/);
  });

  it("⚠️ 使用处必须真的传 `plugins`（只声明不传 = 没有保护），且**不许**传布尔 true", () => {
    const j = SIDE.indexOf("<WebviewTag");
    expect(j, "找不到 <WebviewTag 使用处").toBeGreaterThan(-1);
    const jsx = SIDE.slice(j, j + 800);
    expect(jsx, "使用处没传 plugins ⇒ 失去那层防守（它**不是**「会空白」的原因）").toMatch(/(^|\s)plugins(\s|$|\/)/m);
    /* 布尔 true 会被 React 丢掉（正是 `allowpopups` 踩过的坑）⇒ 不许有人"顺手改成"布尔 */
    expect(jsx, "布尔 `plugins` 会被 React 丢弃 ⇒ 必须走包装组件的字符串路径").not.toMatch(/plugins=\{true\}/);
  });
});

/* ─── ㈨ 用户实测：`.doc` 空白 + 「无法打开 chrome-extension:// 链接」弹窗（2026-09-30 第四轮）─── */

describe("A-1136-C ㈨ 内部协议与 PDF 取数", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");

  it("⚠️ `isWebSafeUrl` 必须放行 `chrome-extension`（PDF 查看器就住在该协议下）", () => {
    /* Chromium 的 PDF 查看器是**内置扩展**（`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`）。
       若 `isWebSafeUrl` 不认它 ⇒ `will-frame-navigate` 会 `preventDefault()` **掐断查看器自身的导航**
       ⇒ `<embed>` 只剩一块空白灰底（用户实测）。 */
    const i = MAIN.indexOf("function isWebSafeUrl");
    expect(i, "找不到 isWebSafeUrl（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = MAIN.slice(i, i + 600);
    /* ⚠️⚠️ **必须锚"那一条白名单表达式"本身**，不能在窗口里 `toContain('"chrome-extension"')`（铁律 3）：
       紧挨着的 `isChromiumInternalScheme` 里**也有**这个字面量 ⇒ 删掉白名单里的那一项，
       窗口搜索照样命中 ⇒ 变异 M46 **实测存活**过。
       ⚠️ 顺带把整条数组钉死：**顺序与成员都别动**（少一个 = 查看器被掐断；多一个 = 放行了不该放行的协议）。 */
    expect(body).toMatch(
      /return \["http", "https", "about", "file", "data", "blob", "chrome", "chrome-extension"\]\.includes\(/);
  });

  it("⚠️⚠️ `openExternalSafe` 必须在**探测系统之前**就拒掉 Chromium 内部协议", () => {
    /* 内部协议（chrome-extension / chrome / devtools / view-source）在 OS 里**永远没有处理器** ⇒
       探测之后再 `shell.openExternal` 只会弹「无法打开 … 链接——系统未注册该协议」的系统框
       （用户实测截图里那个）。判据 = ① 有 `isChromiumInternalScheme` 这个判据函数；
       ② 那句提前返回**排在** `getApplicationInfoForProtocol` **之前**（顺序就是判据）。 */
    const i = MAIN.indexOf("function isChromiumInternalScheme");
    expect(i, "没有 isChromiumInternalScheme ⇒ 内部协议没有统一判据").toBeGreaterThan(-1);
    expect(MAIN.slice(i, i + 400)).toContain('"chrome-extension"');

    const j = MAIN.indexOf("async function openExternalSafe");
    expect(j).toBeGreaterThan(-1);
    const fn = MAIN.slice(j, j + 900);
    const guardAt = fn.indexOf("isChromiumInternalScheme(url)");
    const probeAt = fn.indexOf("getApplicationInfoForProtocol");
    expect(guardAt, "缺内部协议提前返回 ⇒ 会弹系统框").toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(-1);
    expect(guardAt, "提前返回必须在问系统**之前**（晚了就已经弹框了）").toBeLessThan(probeAt);
  });

  it("⚠️ 查看器页必须**自己取字节喂 blob**、且失败**在页面上说出来**（不再有「空白且无言」）", () => {
    /* 旧写法 `'<embed class=\"pdf\" src=\"' + esc(pdfBase) + '\"'` 把取数交给查看器自己 ⇒
       那条链路要穿过独立 session + 导航守卫 + 下载闸门，任何一环不认它就只剩空白、
       而且页面上**一个字都没有**（用户只能来问我们）。 */
    expect(PAGE, "不许再让 <embed> 直接指向服务器 URL").not.toMatch(/'<embed[^']*src="'\s*\+/);
    expect(PAGE, "必须自己 fetch 拿字节").toContain("fetch(url)");
    expect(PAGE, "必须喂 blob（绕开 session/守卫对查看器取数的干扰）").toContain("createObjectURL");
    expect(PAGE, "失败必须有可见落点").toMatch(/id="err"/);
  });
});

/* ──────── ㈩ 加载速度优化（2026-09-30 用户反馈「老版每次都要加载半天」）──────── */

describe("A-1136-C ㈩ Office 打开速度", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");
  const CONV = codeOf("gui/src/main/libreofficeConvert.ts");

  it("⚠️ 老格式的**缓存短路必须在转换之前**（顺序就是判据，放后面等于没缓）", () => {
    /* 实测单次转换 10~16s，绝大部分是 LibreOffice 冷启动；页面+PDF 本来就已经持久落盘
       ⇒ 同一文件重复打开不该再转。判据 = ① 有缓存检查；② 它**排在** `convertToPdf` 之前。 */
    const seg = MAIN.slice(MAIN.indexOf('if (plan.needs === "libreoffice")'));
    const cacheAt = seg.indexOf("pdfViewerPaths(pageRoot, abs)");
    const convAt = seg.indexOf("await convertToPdf(abs)");
    expect(cacheAt, "没有缓存短路 ⇒ 每次打开都要等 LibreOffice 冷启动").toBeGreaterThan(-1);
    expect(convAt).toBeGreaterThan(-1);
    expect(cacheAt, "缓存检查必须在 `convertToPdf` **之前**").toBeLessThan(convAt);
    /* ⚠️ 判据必须连 PDF 一起看：只有 html 没有 pdf ⇒ 上次写坏了，必须重转（否则稳定给空壳页） */
    expect(seg.slice(cacheAt, cacheAt + 300)).toMatch(/existsSync\(cachedPage\.pdf\)/);
  });

  it("⚠️ `writeRenderPage` 的快路径**必须排除带 notice 的情况**（否则会显示过期的降级理由）", () => {
    const i = PAGE.indexOf("const wantNotice");
    expect(i, "找不到 wantNotice（改结构了？同步本守卫）").toBeGreaterThan(-1);
    expect(PAGE.slice(i, i + 200)).toMatch(/wantNotice\s*=\s*\(opts\.notice \?\? ""\)\.trim\(\)\.length > 0/);
    /* 快路径的 if 必须以 `!wantNotice` 开头 */
    expect(PAGE.slice(i, i + 500)).toMatch(/if \(!wantNotice && existsSync\(htmlPath\)/);
  });

  it("⚠️ 共享 profile ⇒ 转换必须**串行化**，且队列尾必须**永远前进**", () => {
    /* 共享 `-env:UserInstallation` 时两个并发转换会撞 LibreOffice 单实例机制（可能等到超时）。
       ⚠️ 队列尾若写成 `then(() => undefined)`，**一次 reject 会让整条队列永久卡死** ——
          那是"不报错的死循环"的同宗（铁律 22），必须两个回调都推进。 */
    expect(CONV).toContain("serializeConvert");
    expect(CONV).toMatch(/convertChain\s*=\s*run\.then\(\(\)\s*=>\s*undefined,\s*\(\)\s*=>\s*undefined\)/);
    /* 对外入口必须真的走队列（只声明不用 = 没有保护） */
    expect(CONV).toMatch(/export async function convertToPdf\(srcAbs: string\): Promise<ConvertResult> \{\s*return serializeConvert\(/);
    /* 常驻 profile 必须是"同一个目录"，不是每次新建 */
    expect(CONV).toMatch(/function sharedProfileDir\(\): string \{\s*return join\(tmpdir\(\), "slime-lo-profile"\);/);
  });
});

/* ── ㈪ 第五轮：HTML 应当**原生渲染**、Excel 应当**贴合原几何**（2026-09-30 用户实测）── */

describe("A-1136-C ㈪ HTML 原生渲染 + 表格几何", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");

  it("⚠️⚠️ `.html/.htm/.xhtml` 必须是**保真**（`html-native`），不许当文本重排", () => {
    /* 用户实测：「HTML 文件怎么反倒无法显示」—— 他看到的是**源码**（`<!doctype html>` …）。
       根因：`.html` 之前被归成 `text-html`（抽文本重排）⇒ 只显示出源码样式。
       ⚠️ 它**本身就是网页** ⇒ 理应保真。 */
    for (const f of ["a.html", "b.htm", "c.xhtml"]) {
      expect(planRender(f).render, f + " 应是 html-native").toBe("html-native");
      expect(planRender(f).faithful, f + " 应是保真").toBe(true);
      expect(canFaithfullyRender(f), f + " 应能保真渲染").toBe(true);
    }
  });

  it("⚠️ `html-native` 必须**服务文件所在目录 + 用原文件名**（拷贝会丢兄弟资源）", () => {
    /* 拷进 `doc-render` 再服务 ⇒ 相对引用的 css/js/图片全 404 ⇒ 页面残缺。
       ⇒ 判据 = `dir` 取 `dirname(abs)`、`name` 取 `basename(abs)`（不是 `doc-render/<sub>/index.html`）。 */
    const i = MAIN.indexOf('plan.render === "html-native"');
    expect(i, "找不到 html-native 分支（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const seg = MAIN.slice(i, i + 400);
    expect(seg).toMatch(/dirname\(abs\)/);
    expect(seg).toMatch(/name:\s*basename\(abs\)/);
  });

  it("⚠️ 表格必须按**源文件的几何**画（列宽/行高/合并/数字格式），不许只吐裸表", () => {
    /* 用户实测：「excel表格目前显示还是太粗糙了，更贴合一点原本格式大小吧」。
       `XLSX.utils.sheet_to_html` 只吐裸 table：无列宽(`!cols.wch`)、无行高(`!rows.hpx`)、
       合并单元格不带 rowspan/colspan、数字格式也不套 ⇒ "大小"与源文件差得远。 */
    expect(PAGE, "不许再用 sheet_to_html（它吐的是裸表）").not.toContain("sheet_to_html");
    expect(PAGE).toContain("!cols");
    expect(PAGE).toContain("!merges");
    expect(PAGE).toContain("format_cell");
    /* 电子表格**不该居中**：源文件里表格从左上角铺开（其余模式仍保持 ⑬ 的居中） */
    expect(PAGE).toContain("data-mode','sheet'");
    expect(PAGE).toMatch(/body\[data-mode=\\"sheet\\"\] #stage\{[^}]*justify-content:flex-start/);
    /* 用源文件列宽（`<colgroup>` + `table-layout:fixed`），而不是按内容挤成一团 */
    expect(PAGE).toContain("<colgroup>");
    expect(PAGE).toContain("table-layout:fixed");
  });
});

/* ──────── ㈫ 附件卡片可点击预览（2026-09-30 用户实测「只能看不能点，有点鸡肋」）──────── */

describe("A-1136-C ㈫ 附件卡片可点击预览", () => {
  const CP = codeOf("gui/src/renderer/pages/ChatPanel.tsx");

  it("⚠️ 点击语义必须**唯一产地**，且与「拖入」走**同一条路由**", () => {
    /* 拖入那边发的是 `requestSidebarOpen({kind:"doc", rel: 绝对路径})` ⇒ 点击必须复用同一条，
       **绝不另写一套"该建什么页"的判据**（本仓既有约定：那个判据只有一处）。
       ⚠️ 必须是**模块级函数**：卡片有两处，而"已发送气泡卡"在**另一个组件**里 ⇒
          写成组件内 handler 拿不到作用域，写两遍又会出现第二个产地（铁律 11）。 */
    expect(CP).toMatch(/function openDocInSidebar\(path: string, name\?: string\): void \{/);
    expect(CP).toMatch(/requestSidebarOpen\(\{ kind: "doc", rel: p,/);
  });

  it("⚠️ **两处**卡片都必须真的挂上 onClick（只定义不挂 = 没有保护）", () => {
    const hits = (CP.match(/onClick=\{\(\) => openDocInSidebar\(/g) ?? []).length;
    expect(hits, "待发卡 + 已发送气泡卡都要可点（共 2 处）").toBe(2);
    /* 键盘可达（`role=button` + Enter/Space）—— 别做成只能用鼠标点 */
    const keys = (CP.match(/onKeyDown=\{\(e\) => \{ if \(e\.key === "Enter" \|\| e\.key === " "\)/g) ?? []).length;
    expect(keys, "两处都要键盘可达").toBe(2);
  });

  it("⚠️ 待发卡上的 `×` 必须 `stopPropagation`（否则点「移除」会顺带把预览打开）", () => {
    expect(CP).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setPendingDocs\(/);
  });
});

/* ──────────────── ㈬ 附件上限必须**常量化且大幅上调**（2026-09-30 用户实测）──────────────── */

describe("A-1136-C ㈬ 附件数量上限", () => {
  const CP = codeOf("gui/src/renderer/pages/ChatPanel.tsx");

  it("⚠️ 文档附件上限必须**大幅上调**（用户原话：「为什么现在最多只能载入 4 个文件啊？」）", () => {
    const m = /const MAX_PENDING_DOCS = (\d+);/.exec(CP);
    expect(m, "上限必须是**具名常量**（以前是散在 4 处的字面量 slice(-4)，改一处忘一处）").toBeTruthy();
    expect(Number(m![1]), "文档只带一条路径，成本极低 ⇒ 应放得很宽").toBeGreaterThanOrEqual(16);
    /* ⚠️ 不许再有散落的字面量：留一个 = 有的入口仍然只收 4 个 */
    expect(CP, "还有硬编码的 slice(-4) ⇒ 某个入口没跟着改").not.toMatch(/slice\(-4\)/);
  });

  it("⚠️ 图片上限是**另一条**常量（data URL 会占内存且整张进上下文，不能跟文档一个量级）", () => {
    expect(CP).toMatch(/const MAX_PENDING_IMAGES = \d+;/);
    expect(CP, "图片上限也必须常量化").toMatch(/slice\(-MAX_PENDING_IMAGES\)/);
    /* 界面上那个「N/4 个」的分母必须跟着常量走（写死 4 会让用户以为还是 4） */
    expect(CP).toMatch(/\{pendingDocs\.length\}\/\{MAX_PENDING_DOCS\} 个/);
  });
});
