
















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


function fib(opts: { wIdent?: number; flags?: number; len?: number } = {}): Buffer {
  const len = opts.len ?? 64;
  const b = Buffer.alloc(len);
  b.writeUInt16LE(opts.wIdent ?? DOC_WIDENT, 0x0000);
  b.writeUInt16LE(193, 0x0002);                        
  b.writeUInt16LE(opts.flags ?? 0, 0x000A);            
  return b;
}








function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}



describe("A-1136-C ㈠ LibreOffice 探测（唯一产地，纯函数）", () => {
  it("looksLikeSoffice：认本体、拒目录与旁路文件", () => {
    
    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice\\program\\soffice.exe")).toBe(true);
    expect(looksLikeSoffice("/usr/lib/libreoffice/program/soffice.bin")).toBe(true);
    expect(looksLikeSoffice("/usr/bin/soffice")).toBe(true);
    expect(looksLikeSoffice("/usr/bin/libreoffice")).toBe(true);
    
    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice\\program")).toBe(false);
    expect(looksLikeSoffice("/Applications/LibreOffice.app")).toBe(false);
    expect(looksLikeSoffice("")).toBe(false);
    expect(looksLikeSoffice("soffice.lnk")).toBe(false);
  });

  it("⚠️ 回归：`libreoffice` 别名**只在 Unix 成立**（Windows 目录不许被当成本体）", () => {
    



    expect(looksLikeSoffice("C:\\Program Files\\LibreOffice")).toBe(false);
    expect(looksLikeSoffice("D:\\LibreOffice")).toBe(false);
    
    expect(looksLikeSoffice("/usr/bin/libreoffice")).toBe(true);
    expect(looksLikeSoffice("/opt/libreoffice/libreoffice")).toBe(true);
    
    expect(looksLikeSoffice("C:\\LO\\libreoffice.exe")).toBe(true);
  });

  it("parseVersion：抠出各版本输出里的版本号，抠不到就返回空串（不许编假值）", () => {
    expect(parseVersion("LibreOffice 7.6.4.1 639b8ac485750d569b4b5aba30b0d0a6f2e0b8a0")).toBe("7.6.4.1");
    expect(parseVersion("LibreOffice 24.2.5.2 (X86_64)")).toBe("24.2.5.2");
    
    expect(parseVersion("")).toBe("");
    expect(parseVersion("no such thing")).toBe("");
  });

  it("candidatesFor：三平台都有候选；未知平台给空数组而不是抛错", () => {
    expect(candidatesFor("win32").length).toBeGreaterThan(0);
    expect(candidatesFor("darwin").length).toBeGreaterThan(0);
    expect(candidatesFor("linux").length).toBeGreaterThan(0);
    
    expect(candidatesFor("aix")).toEqual([]);
  });

  it("probeSearchList：环境变量覆盖**优先于**内置候选，且去重保序", () => {
    const custom = "D:\\portable\\LibreOffice\\program\\soffice.exe";
    const list = probeSearchList("win32", { [LO_PATH_ENV[0]]: custom });
    expect(list[0]).toBe(custom);                                  
    const again = probeSearchList("win32", {
      [LO_PATH_ENV[0]]: custom,
      [LO_PATH_ENV[1]]: custom,                                    
    });
    expect(again.filter((p) => p === custom).length).toBe(1);      
    



    const DIR_ONLY = "C:\\Program Files\\LibreOffice";
    const bad = probeSearchList("win32", { [LO_PATH_ENV[0]]: DIR_ONLY });
    expect(bad.every((p) => p !== DIR_ONLY)).toBe(true);
    
    expect(probeSearchList("win32", {})[0]).toBe(candidatesFor("win32")[0]);
  });

  it("notFound()：唯一构造点，含可操作下载地址与「现有文件仍可读」的安抚", () => {
    const nf = notFound();
    expect(nf.found).toBe(false);
    expect(nf.path).toBe("");
    expect(nf.version).toBe("");
    expect(nf.hint).toContain("https://www.libreoffice.org/");   
    expect(nf.hint).toBe(LO_DOWNLOAD_HINT);                      
    
    expect(LO_DOWNLOAD_HINT).toContain("仍可正常阅读");
  });
});



describe("A-1136-C ㈡ .doc 三层防线：规范判据 + 逐段去重率", () => {
  it("wIdent 常量 = 0xA5EC（MS-DOC 2.5.1 规范值，唯一产地）", () => {
    expect(DOC_WIDENT).toBe(0xa5ec);
  });

  it("阈值必须有实测依据：正常中文段上界 < 阈值 < 损坏段下界", () => {
    


    expect(FAKE_TEXT_DEDUP_RATIO).toBeGreaterThan(0.39);
    expect(FAKE_TEXT_DEDUP_RATIO).toBeLessThan(0.661);
  });

  it("looksLikeRealText：真实中文放行、伪汉字拦下（用实测量的两端做样本）", () => {
    
    const real = "传感器是把被测量按一定规律转换成可用输出信号的器件或装置，通常由敏感元件和转换元件组成，其基本特性包括静态特性和动态特性两个方面，静态特性有线性度灵敏度和重复性等指标。".repeat(4);
    expect(looksLikeRealText(real)).toBe(true);

    
    let fake = "";
    for (let i = 0; i < 400; i++) { fake += String.fromCharCode(0x4e00 + i * 7); }
    expect(looksLikeRealText(fake)).toBe(false);
  });

  it("looksLikeRealText：短样本不下结论（< 80 字一律放行）—— 短句可以是任意组合", () => {
    
    let short = "";
    for (let i = 0; i < 60; i++) { short += String.fromCharCode(0x4e00 + i * 7); }
    expect(looksLikeRealText(short)).toBe(true);
  });

  it("源码里三层防线**都在**（缺一层就退化成「把垃圾当真」或「读都没有」）", () => {
    const src = codeOf("core-ts/src/doc_text.ts");
    
    expect(src).toContain("DOC_WIDENT");
    expect(src).toMatch(/wIdent\s*!==\s*DOC_WIDENT/);
    
    expect(src).toMatch(/0x0100/);
    expect(src).toContain("fEncrypted");
    
    expect(src).toContain("looksLikeRealText");
    expect(src).toContain("bad += 1");
  });

  



  it("行为级 · wIdent 不对 ⇒ 抛错（不是「读出一堆伪汉字」）", () => {
    expect(() => validateDocFib(fib({ wIdent: 0xcfd0 }))).toThrow(/wIdent/i);
    expect(() => validateDocFib(fib({ wIdent: DOC_WIDENT }))).not.toThrow();
  });

  it("行为级 · fEncrypted（bit8）⇒ 抛错，并给出「输入口令另存 docx」的可操作出路", () => {
    expect(() => validateDocFib(fib({ flags: 0x0100 }))).toThrow(/加密/);
    
    expect(() => validateDocFib(fib({ flags: 0x0100 }))).toThrow(/docx/);
  });

  it("行为级 · fObfuscated（bit15，旧式 XOR 混淆）同样拦下", () => {
    expect(() => validateDocFib(fib({ flags: 0x8000 }))).toThrow(/加密/);
  });

  it("行为级 · 流太短（读不到 FIB 头）⇒ 抛错，不静默返回空", () => {
    expect(() => validateDocFib(fib({ len: 16 }))).toThrow(/过短/);
  });

  it("行为级 · 干净的 FIB（只置合法位）⇒ 放行", () => {
    
    expect(() => validateDocFib(fib({ flags: 0x0200 }))).not.toThrow();
    expect(() => validateDocFib(fib({ flags: 0x0004 }))).not.toThrow();  
  });
});










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
    expect(consoleVariantOf("/usr/bin/soffice.com")).toBe(null);      
    expect(consoleVariantOf("/usr/bin/soffice")).toBe(null);          
    expect(consoleVariantOf("/usr/bin/soffice.bin")).toBe(null);      
    expect(consoleVariantOf("C:\\LO\\libreoffice.exe")).toBe(null);   
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
    

    expect(CONV).toMatch(/^\s*killProcessTree\(child\.pid/m);
    

    expect(CONV, "taskkill 必须收口在 core-ts/src/procKill.ts").not.toContain("taskkill");
    
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
    
    expect(SRC).toContain("statSync");
  });

  it("参数由 `buildConvertArgs` **一处产地**拼装（每个参数都挡一个真实故障）", () => {
    const args = buildConvertArgs("/tmp/profile", "/tmp/out", "/tmp/a.doc");
    for (const flag of ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard"]) {
      expect(args, "缺 " + flag + " ⇒ 可能弹窗挂住或起不来").toContain(flag);
    }
    
    const env = args.find((a) => a.startsWith("-env:UserInstallation="));
    expect(env, "缺 -env:UserInstallation ⇒ 用户开着 LO 时排队等锁到超时").toBeTruthy();
    expect(env).toContain("file://");
    
    expect(args[args.indexOf("--convert-to") + 1]).toBe("pdf");
    expect(args[args.indexOf("--outdir") + 1]).toBe("/tmp/out");
    expect(args[args.length - 1]).toBe("/tmp/a.doc");
  });

  it("执行器可注入（平台事实逼出来的缝：Windows 上造不出能被 spawn 的假 soffice）", () => {
    expect(SRC).toContain("setConvertRunner");
    expect(SRC).toContain("activeRunner ?? spawnCapture");
  });
});



describe("A-1136-C ㈣ 渲染层分流：失败要**出声**（A-1133 教训）", () => {
  const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");

  it("必须有 routeNote 这条统一说明（保真没成功就要**说原因**，不许默默换样式）", () => {
    expect(SIDEBAR).toContain("routeNote");
    
    expect(SIDEBAR).toContain("needsLibreOffice");
  });

  it("缺依赖时把 hint 带给用户（可操作），不是只说「失败了」", () => {
    const i = SIDEBAR.indexOf("let routeNote =");
    expect(i, "RightSidebar 里找不到 let routeNote（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = SIDEBAR.slice(i, i + 1800);
    expect(body).toContain("hint");
  });

  it("⚠️⚠️ `routeNote` 必须覆盖**全部**失败形态（旧实现只覆盖两种 ⇒ 其余静默）", () => {
    





    const i = SIDEBAR.indexOf("let routeNote =");
    expect(i, "找不到 let routeNote（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = SIDEBAR.slice(i, i + 2400);
    
    expect(body, "缺 `rp` 为空的说明 ⇒ 用户只会看到样式变了却不知为何").toContain("保真渲染通道没有响应");
    expect(body).toContain("重启应用");
    
    expect(body).toMatch(/保真渲染不可用/);
    
    expect(body).toMatch(/本地服务没起来|没返回可用地址/);
    
    expect(SIDEBAR).toContain("notice: routeNote");
  });

  it("⚠️ 保真没成功时**不许**退回纯文本文件页（用户实测「效果很差」的旧行为）", () => {
    





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
    





    const M = codeOf("gui/src/main/index.ts");
    expect(M, "rootDir 传 conv.dir ⇒ 页面写在临时目录、随后被删")
      .not.toMatch(/writePdfViewerPage\(\s*conv\.dir/);
    
    expect(M).toMatch(/writePdfViewerPage\(\s*pageRoot/);
    expect(M).toMatch(/pageRoot\s*=\s*join\(app\.getPath\("userData"\),\s*"doc-render"\)/);
  });

  it("⚠️ 转换临时目录必须**当场删**（返回给渲染层删 = 没人接住 ⇒ 每次转换漏一个目录）", () => {
    






    const M = codeOf("gui/src/main/index.ts");
    const i = M.indexOf("writePdfViewerPage(pageRoot");
    expect(i, "找不到 writePdfViewerPage(pageRoot…) 调用（改结构了？同步本守卫）").toBeGreaterThan(-1);
    
    const after = M.slice(i, i + 800);
    const at = after.indexOf("cleanupConvertDir(conv.dir)");
    expect(at, "复制完 PDF 后必须当场 cleanupConvertDir(conv.dir)").toBeGreaterThan(0);
    
    const ret = after.indexOf("return { ok: true, dir: built.dir, name: built.name, transient: true };");
    expect(ret, "返回值形状变了（是不是又把 convertDir 塞回来了？）").toBeGreaterThan(at);
    
    expect(after.slice(ret, ret + 120)).not.toContain("convertDir");
  });
});



describe("A-1136-C ㈥ 老格式兜底路线", () => {
  it("`.xls` 登记 `fallback: sheetjs`（BIFF8 可纯 JS 直读 —— 实测用 LibreOffice 转出的真 .xls 读出 2 表）", () => {
    const p = planRender("成绩.xls");
    expect(p.needs, "仍然**优先** LibreOffice（原版式最保真）").toBe("libreoffice");
    expect(p.fallback, "没装 LO 时也要能画出一张真表格").toBe("sheetjs");
    expect(fallbackRender("成绩.xls")).toBe("sheetjs");
    expect(fallbackRender("旧表.xlt")).toBe("sheetjs");
  });

  it("⚠️ `.doc` / `.ppt` **不许**登记 fallback（纯 JS 普遍不可靠 ⇒ 只能由渲染层做结构化降级）", () => {
    

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
      
      const r2 = writeRenderPage(join(dir, "o2"), doc, "样例.doc", { useFallback: true });
      expect(r2.ok, "`.doc` 没登记 fallback ⇒ useFallback 不许放行").toBe(false);
      
      expect(writeRenderPage(join(dir, "o3"), xls, "样例.xls").ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("⚠️ 兜底/降级必须**在页面上可见地说明**（静默 = 用户以为「这文件就长这样」）", () => {
    
    const PAGE = codeOf("gui/src/main/docRenderPage.ts");
    expect(PAGE).toMatch(/class="notice"/);
    expect(PAGE).toContain("notice: opts.notice");
    
    const VIEW = codeOf("gui/src/renderer/pages/docView.ts");
    expect(VIEW).toContain("opts.notice");
    
    const SIDE = codeOf("gui/src/renderer/pages/RightSidebar.tsx");
    const i = SIDE.indexOf("let routeNote =");
    expect(i, "找不到 let routeNote（改结构了？同步本守卫）").toBeGreaterThan(-1);
    expect(SIDE.slice(i, i + 2400)).toContain("notice: routeNote");
  });
});



describe("A-1136-C ㈦ pptx 重绘不许追加", () => {
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");

  it("⚠️ `draw()` 必须**先清空容器再 init**（库每次 init 都 append 一个新 wrapper）", () => {
    





    const i = PAGE.indexOf("function draw(buf)");
    expect(i, "找不到 draw(buf)（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = PAGE.slice(i, i + 500);
    const clearAt = body.indexOf("wrap.innerHTML=");
    const initAt = body.indexOf("pptxPreview.init(");
    expect(clearAt, "没有清空容器 ⇒ 重画会追加出第二份").toBeGreaterThan(-1);
    expect(initAt).toBeGreaterThan(-1);
    
    expect(clearAt, "清空必须在 init **之前**").toBeLessThan(initAt);
  });
});



describe("A-1136-C ㈧ 预览 webview 的 plugins（**防守性**：实测非必需，但官方默认关闭）", () => {
  const SIDE = codeOf("gui/src/renderer/pages/RightSidebar.tsx");

  it("⚠️ `WebviewTag` 要把 `plugins` 透传成**字符串** \"true\"（React 会丢弃值为 true 的未知布尔属性）", () => {
    






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
    
    expect(jsx, "布尔 `plugins` 会被 React 丢弃 ⇒ 必须走包装组件的字符串路径").not.toMatch(/plugins=\{true\}/);
  });
});



describe("A-1136-C ㈨ 内部协议与 PDF 取数", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");

  it("⚠️ `isWebSafeUrl` 必须放行 `chrome-extension`（PDF 查看器就住在该协议下）", () => {
    


    const i = MAIN.indexOf("function isWebSafeUrl");
    expect(i, "找不到 isWebSafeUrl（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const body = MAIN.slice(i, i + 600);
    



    expect(body).toMatch(
      /return \["http", "https", "about", "file", "data", "blob", "chrome", "chrome-extension"\]\.includes\(/);
  });

  it("⚠️⚠️ `openExternalSafe` 必须在**探测系统之前**就拒掉 Chromium 内部协议", () => {
    



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
    


    expect(PAGE, "不许再让 <embed> 直接指向服务器 URL").not.toMatch(/'<embed[^']*src="'\s*\+/);
    expect(PAGE, "必须自己 fetch 拿字节").toContain("fetch(url)");
    expect(PAGE, "必须喂 blob（绕开 session/守卫对查看器取数的干扰）").toContain("createObjectURL");
    expect(PAGE, "失败必须有可见落点").toMatch(/id="err"/);
  });
});



describe("A-1136-C ㈩ Office 打开速度", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");
  const CONV = codeOf("gui/src/main/libreofficeConvert.ts");

  it("⚠️ 老格式的**缓存短路必须在转换之前**（顺序就是判据，放后面等于没缓）", () => {
    

    const seg = MAIN.slice(MAIN.indexOf('if (plan.needs === "libreoffice")'));
    const cacheAt = seg.indexOf("pdfViewerPaths(pageRoot, abs)");
    const convAt = seg.indexOf("await convertToPdf(abs)");
    expect(cacheAt, "没有缓存短路 ⇒ 每次打开都要等 LibreOffice 冷启动").toBeGreaterThan(-1);
    expect(convAt).toBeGreaterThan(-1);
    expect(cacheAt, "缓存检查必须在 `convertToPdf` **之前**").toBeLessThan(convAt);
    
    expect(seg.slice(cacheAt, cacheAt + 300)).toMatch(/existsSync\(cachedPage\.pdf\)/);
  });

  it("⚠️ `writeRenderPage` 的快路径**必须排除带 notice 的情况**（否则会显示过期的降级理由）", () => {
    const i = PAGE.indexOf("const wantNotice");
    expect(i, "找不到 wantNotice（改结构了？同步本守卫）").toBeGreaterThan(-1);
    expect(PAGE.slice(i, i + 200)).toMatch(/wantNotice\s*=\s*\(opts\.notice \?\? ""\)\.trim\(\)\.length > 0/);
    
    expect(PAGE.slice(i, i + 500)).toMatch(/if \(!wantNotice && existsSync\(htmlPath\)/);
  });

  it("⚠️ 共享 profile ⇒ 转换必须**串行化**，且队列尾必须**永远前进**", () => {
    


    expect(CONV).toContain("serializeConvert");
    expect(CONV).toMatch(/convertChain\s*=\s*run\.then\(\(\)\s*=>\s*undefined,\s*\(\)\s*=>\s*undefined\)/);
    
    expect(CONV).toMatch(/export async function convertToPdf\(srcAbs: string\): Promise<ConvertResult> \{\s*return serializeConvert\(/);
    
    expect(CONV).toMatch(/function sharedProfileDir\(\): string \{\s*return join\(tmpdir\(\), "slime-lo-profile"\);/);
  });
});



describe("A-1136-C ㈪ HTML 原生渲染 + 表格几何", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const PAGE = codeOf("gui/src/main/docRenderPage.ts");

  it("⚠️⚠️ `.html/.htm/.xhtml` 必须是**保真**（`html-native`），不许当文本重排", () => {
    


    for (const f of ["a.html", "b.htm", "c.xhtml"]) {
      expect(planRender(f).render, f + " 应是 html-native").toBe("html-native");
      expect(planRender(f).faithful, f + " 应是保真").toBe(true);
      expect(canFaithfullyRender(f), f + " 应能保真渲染").toBe(true);
    }
  });

  it("⚠️ `html-native` 必须**服务文件所在目录 + 用原文件名**（拷贝会丢兄弟资源）", () => {
    

    const i = MAIN.indexOf('plan.render === "html-native"');
    expect(i, "找不到 html-native 分支（改结构了？同步本守卫）").toBeGreaterThan(-1);
    const seg = MAIN.slice(i, i + 400);
    expect(seg).toMatch(/dirname\(abs\)/);
    expect(seg).toMatch(/name:\s*basename\(abs\)/);
  });

  it("⚠️ 表格必须按**源文件的几何**画（列宽/行高/合并/数字格式），不许只吐裸表", () => {
    


    expect(PAGE, "不许再用 sheet_to_html（它吐的是裸表）").not.toContain("sheet_to_html");
    expect(PAGE).toContain("!cols");
    expect(PAGE).toContain("!merges");
    expect(PAGE).toContain("format_cell");
    
    expect(PAGE).toContain("data-mode','sheet'");
    expect(PAGE).toMatch(/body\[data-mode=\\"sheet\\"\] #stage\{[^}]*justify-content:flex-start/);
    
    expect(PAGE).toContain("<colgroup>");
    expect(PAGE).toContain("table-layout:fixed");
  });
});



describe("A-1136-C ㈫ 附件卡片可点击预览", () => {
  const CP = codeOf("gui/src/renderer/pages/ChatPanel.tsx");

  it("⚠️ 点击语义必须**唯一产地**，且与「拖入」走**同一条路由**", () => {
    



    expect(CP).toMatch(/function openDocInSidebar\(path: string, name\?: string\): void \{/);
    expect(CP).toMatch(/requestSidebarOpen\(\{ kind: "doc", rel: p,/);
  });

  it("⚠️ **两处**卡片都必须真的挂上 onClick（只定义不挂 = 没有保护）", () => {
    const hits = (CP.match(/onClick=\{\(\) => openDocInSidebar\(/g) ?? []).length;
    expect(hits, "待发卡 + 已发送气泡卡都要可点（共 2 处）").toBe(2);
    
    const keys = (CP.match(/onKeyDown=\{\(e\) => \{ if \(e\.key === "Enter" \|\| e\.key === " "\)/g) ?? []).length;
    expect(keys, "两处都要键盘可达").toBe(2);
  });

  it("⚠️ 待发卡上的 `×` 必须 `stopPropagation`（否则点「移除」会顺带把预览打开）", () => {
    expect(CP).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setPendingDocs\(/);
  });
});



describe("A-1136-C ㈬ 附件数量上限", () => {
  const CP = codeOf("gui/src/renderer/pages/ChatPanel.tsx");

  it("⚠️ 文档附件上限必须**大幅上调**（用户原话：「为什么现在最多只能载入 4 个文件啊？」）", () => {
    const m = /const MAX_PENDING_DOCS = (\d+);/.exec(CP);
    expect(m, "上限必须是**具名常量**（以前是散在 4 处的字面量 slice(-4)，改一处忘一处）").toBeTruthy();
    expect(Number(m![1]), "文档只带一条路径，成本极低 ⇒ 应放得很宽").toBeGreaterThanOrEqual(16);
    
    expect(CP, "还有硬编码的 slice(-4) ⇒ 某个入口没跟着改").not.toMatch(/slice\(-4\)/);
  });

  it("⚠️ 图片上限是**另一条**常量（data URL 会占内存且整张进上下文，不能跟文档一个量级）", () => {
    expect(CP).toMatch(/const MAX_PENDING_IMAGES = \d+;/);
    expect(CP, "图片上限也必须常量化").toMatch(/slice\(-MAX_PENDING_IMAGES\)/);
    
    expect(CP).toMatch(/\{pendingDocs\.length\}\/\{MAX_PENDING_DOCS\} 个/);
  });
});
