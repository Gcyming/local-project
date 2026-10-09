#!/usr/bin/env node
/**
 * gui/scripts/mut-a1136-render.mjs — A-1136（Office 保真渲染 + Agent 抽文本双通道）的变异验证。
 *
 * ## 为什么要这组变异
 * A-1136 的决定性证据来自**真文件端到端跑通**（`probe-render-fidelity.mjs` 截图肉眼验收）。
 * 但"跑通一次"不是保护 —— 回归保护要靠守卫，而守卫必须**能被改坏**：
 *   1  `renderPlan`：pptx 被判成 text-html（**保真渲染整条路消失**，退回 A-1135 那种抽文本重排）
 *   2  `renderPlan`：老格式的 needs 被抹掉（`.doc` 被当能直接渲染 ⇒ 页面必然白屏）
 *   3  `renderPlan`：unknown 兜底被判成 faithful（未知类型也走"保真"⇒ 白屏且不报错）
 *   4  `docRenderPage`：库路径去掉前导 `/`（页面在子目录里 ⇒ 库 404 ⇒ **用户看到的是一片空白**）
 *   5  `docRenderPage`：`name` 丢掉子目录前缀（服务错文件 / 404 —— `previewPage` 那个 404 的同宗）
 *   6  `docRenderPage`：pptx 的 `mode:'list'` 改成 `'slide'`（**只渲染第一页**，"全片预览"名存实亡）
 *   7  `docRenderPage`：渲染失败不置 `__renderError`（静默白屏，用户只看到"正在渲染…"转圈）
 *   8  `docRenderPage`：`writeRenderPage` 不再校验 faithful（老格式也生成页面 ⇒ 白屏）
 *   9  `RightSidebar`：**删掉 `docs.read` 那条落回**（Agent 通道被保真渲染挤掉 —— 用户点名担心的）
 *  10  `RightSidebar`：保真与落回的**顺序颠倒**（永远走旧通道 ⇒ 用户"没变化啊"复发）
 *  11  `main`：IPC 不再判 `planRender`（拿任意文件都去生成渲染页 ⇒ 老格式白屏）
 *  12  `main`：不返回 `degrade` 标记（渲染层不知道可以落回 ⇒ 直接弹错误）
 *  13  `gui/vendor/jszip.min.js`：**副本被改脏**（唯一一条改的不是源码，而是"手工复制的第二产地"）
 *  14  `docRenderPage`：pptx 宽度写死回 1280（窄右栏横向被裁 —— 用户实测「只显示一半」）
 *  15  `docRenderPage`：#stage 去掉垂直居中（内容贴顶 —— 用户实测「只放在最上面」）
 *  16  `docRenderPage`：docx 改回 ignoreWidth:false（锁 A4 固定宽 ⇒ 窄右栏溢出被裁）
 *
 * ── 阶段 C（老格式 → LibreOffice → PDF；2026-09-29 用户已定「探测本机，缺则提示下载」）──
 *  17  `libreoffice`：`looksLikeSoffice` 裸放行 `libreoffice` 别名 —— **本 spec 抓出的真 bug**：
 *      Windows 目录 `C:\Program Files\LibreOffice` 的 basename 小写后正好是 `libreoffice` ⇒
 *      用户把环境变量填成目录时瞒过闸门，调用方拿**目录**去 spawn（报令人困惑的 spawn 错）。
 *  18  `libreoffice`：`parseVersion` 抠不到时编个 `"unknown"`（调用方分不清「找到了」与「验证过」）
 *  19  `libreoffice`：`probeSearchList` 丢掉环境变量覆盖（用户显式指定失效 ⇒ 逃生门没了）
 *  20  `libreoffice`：`notFound` 的 hint 去掉下载地址（提示还在但**不可操作**）
 *  21  `doc_text`：`wIdent` 判据失效（损坏的 .doc 不再被拦）
 *  22  `doc_text`：`fEncrypted` 判据失效（加密文档解出密文喂给 Agent）
 *  23  `doc_text`：去重率阈值放宽到 0.9（损坏段 0.661 打不穿 ⇒ **伪汉字混进正文**）
 *  24  `doc_text`：`bad` 计数不涨（垃圾段仍丢弃，但**不再如实上报** ⇒ 用户/Agent 被蒙在鼓里）
 *  25  `libreofficeConvert`：改用 `spawnSync`（阻塞 Electron 主进程事件循环）
 *  26  `libreofficeConvert`：丢掉 `-env:UserInstallation`（用户开着 LO 时挂住等锁）
 *  27  `RightSidebar`：删掉 `missingLo` 分支（缺 LO 时默默退回文本 —— A-1133 那个「怎么没了」重演）
 *
 * ── 09-30：Windows `.com` vs `.exe`（本轮"用户装了 LO 却看不了老文件"的真根因）──
 * 实测：`soffice.exe --version` **挂死 20~25s 零输出**（加 `--headless` 也一样）且留孤儿 `soffice.bin`；
 *      `soffice.com --version` **0.28s** 返回。`.exe` 是 GUI 子系统程序 ⇒ 探测超时 ⇒ 判"没装" ⇒
 *      用户装了 LO 却被提示去下载。以下 6 条守住这个修法：
 *  28  `libreoffice`：`looksLikeSoffice` 不再认 `.com`
 *  29  `libreoffice`：win32 候选表把 `.com` 全改回 `.exe`（**直接复现原始 bug**）
 *  30  `libreoffice`：`consoleVariantOf` 恒返回 null（用户手填 `.exe` 时救不回来）
 *  31  `libreofficeConvert`：`resolveConsoleVariant` 不再换 `.com`
 *  32  `libreofficeConvert`：超时改用单进程 kill（Windows 留孤儿 `soffice.bin`）
 *  33  `libreofficeConvert`：`shouldSkipVersionProbe` 恒 false（win32 真跑 `.exe --version` ⇒ 挂满超时）
 *  34  `main`：转换成功后不再删临时目录（每次转换漏一个 `slime-lo-*`）
 *  35  `libreofficeConvert`：把杀树调用**短路掉**（孤儿进程堆积）
 *
 * ── 兜底路线（2026-09-30 用户拍板：「LibreOffice 优先 + SheetJS 兜底」）──
 *  36  `renderPlan`：`.xls` 丢掉 `fallback: sheetjs`（没装 LO 就彻底没得看）
 *  37  `renderPlan`：给 `.doc`/`.ppt` 也登记假 fallback（纯 JS 画不出 ⇒ 白屏，且掩盖"没装 LO"）
 *  38  `docRenderPage`：`useFallback` 不再校验 `plan.fallback`（调用方可塞任意渲染器）
 *  39  `docRenderPage`：提示带不渲染（走兜底却不吭声 ⇒ 用户以为看到了原版式）
 *  40  `docView`：结构化降级页不插提示（`.doc`/`.ppt` 静默降级）
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环逐条：
 *   for i in $(seq 1 40); do node gui/scripts/mut-a1136-render.mjs --apply $i
 *     && node <vitest.mjs> run --config vitest.config.ts
 *          tests/gui/a1136-render-page.spec.ts tests/gui/a1136-fidelity-route.spec.ts
 *          tests/core-ts/a1136-render-plan.spec.ts tests/core-ts/a1136-stage-c.spec.ts --reporter=dot;
 *     node gui/scripts/mut-a1136-render.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1136-render-plan.spec.ts",
  "tests/gui/a1136-render-page.spec.ts",
  "tests/gui/a1136-fidelity-route.spec.ts",
  "tests/core-ts/a1136-stage-c.spec.ts",
];
const F_PLAN = "core-ts/src/office/renderPlan.ts";
const F_PAGE = "gui/src/main/docRenderPage.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const F_MAIN = "gui/src/main/index.ts";
const F_VENDOR_JSZIP = "gui/vendor/jszip.min.js";
/* 阶段 C 新增产地 */
const F_LO = "core-ts/src/office/libreoffice.ts";
const F_DOCTEXT = "core-ts/src/doc_text.ts";
const F_CONV = "gui/src/main/libreofficeConvert.ts";
const F_PROCKILL = "core-ts/src/procKill.ts";
const F_VIEW = "gui/src/renderer/pages/docView.ts";
const F_CHATPANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
/* ── A1136 ①②③ 的锚点常量（2026-10-08 补）────────────────────────────────────
 * 这三条原先把 `from` 写在 `mutate:` 闭包里按 `indexOf` 切块，核验器解析不出来
 * ⇒ 报「未核验」。按铁律「没人核验 = 没有保护」，那三条锚点**从未被数过一次**
 * （而「未命中」至少会响，未核验是静默的）。
 * ⇒ 改成**模块级字面量常量**：`check-mut-anchors.mjs` 的 `constMap`认它
 *   （`const X = "…"` 单行字面量形态），`_run-mut-one.mjs` 的常量表也认它
 *   —— 两边都从同一份常量取值，不会出现「核验器说命中、运行期说未命中」的两边打架。
 * ⚠️ 三条常量都是**逐字节抄自当前源码**的连续块，且各自在目标文件里**唯一命中**
 *   （改源码形状时必须重新抄，否则这里报「未命中」——那正是它该报的）。
 * ⚠️ 一律用双引号字面量（换行写成转义 `\n`），**不用模板字面量**：
 *   锚点里天然含反引号与 `${`，模板形态会被插值规则吃掉（见 `_run-mut-one.mjs` 的
 *   `readTemplateLiteral`），双引号形态没有这个歧义。
 * ⚠️⚠️ 三条常量必须各自是**单个**字面量，**不许用 `+` 拼接**（2026-10-08 实测）：
 *   `check-mut-anchors.mjs` 的 `constMap` 对拼接形态走`readConcat`，而它要求
 *   每一段都是字面量；本文件的 M10 锚点里含 `${…}` 与反引号（模板文本），
 *   拼接写法会让它落到「常量字面量解析失败」⇒ `from` 解析不出来 ⇒ 又报「未核验」
 *   —— 也就是"改完还是没人核验"。分号收尾的单字面量才走第一段那个正则。 */
/** 落回块：`docs.read` 调用 + 失败闸门 + 后续空行（第 9 条的锚点）。 */
const A1136_SIDEBAR_DR_BLOCK = "const dr = await api?.docs?.read?.(path).catch(() => null) as\n        { ok?: boolean; text?: string; error?: string } | null | undefined;\n      if (!dr?.ok) {\n        openFileAbs(path, label, `${routeNote}\\n（另外，文本提取也没成功：${dr?.error ?? \"未知原因\"}）`);\n        return;\n      }\n      \n      ";
/** 保真块：`docs.renderPage` 调用 + routeNote 计算（第 10 条锚点的前半段）。 */
const A1136_SIDEBAR_RP_BLOCK = "const rp = await api?.docs?.renderPage?.({ path, name: label }).catch(() => null) as\n        { ok?: boolean; dir?: string; name?: string; error?: string; degrade?: boolean;\n          needs?: string; hint?: string; reason?: string; transient?: boolean } | null | undefined;\n      \n\n\n\n\n\n\n      let routeNote = \"\";\n      if (rp?.ok && rp.dir) {\n        const served = await api?.http?.serve?.({ dir: rp.dir }).catch(() => null) as\n          { ok?: boolean; urls?: string[]; error?: string } | null | undefined;\n        const url = served?.ok ? buildPreviewUrl(served.urls, rp.name ?? \"index.html\") : null;\n        if (url) { openBrowserTab(url, label); return; }\n        routeNote = `保真渲染页已生成，但本地服务没起来或没返回可用地址（${served?.error ?? \"未知原因\"}）。`\n          + \"当前按文本结构重排显示，不是原版式。\";\n      } else if (rp && rp.ok === false) {\n        routeNote = (rp.needs === \"libreoffice\" && rp.reason === \"no-libreoffice\")\n          ? `${rp.hint ?? \"需要本机安装 LibreOffice。\"}（当前按文本结构重排显示，不是原版式）`\n          : (rp.needs === \"libreoffice\" && rp.reason === \"failed\")\n            ? `LibreOffice 转换失败：${rp.error ?? \"未知原因\"}（当前按文本结构重排显示，不是原版式）`\n            : `保真渲染不可用：${rp.error ?? \"未知原因\"}（当前按文本结构重排显示，不是原版式）`;\n      } else {\n        \n\n        routeNote = \"保真渲染通道没有响应（若应用刚更新过，请**重启应用**后再试）。\"\n          + \"当前按文本结构重排显示，不是原版式。\";\n      }\n\n      ";
/** 「保真块 + 落回块」**连续**一段（第 10 条的锚点：两段中间没有别的语句，交换它们 = 顺序颠倒）。 */
const A1136_SIDEBAR_RP_DR_BLOCK = "const rp = await api?.docs?.renderPage?.({ path, name: label }).catch(() => null) as\n        { ok?: boolean; dir?: string; name?: string; error?: string; degrade?: boolean;\n          needs?: string; hint?: string; reason?: string; transient?: boolean } | null | undefined;\n      \n\n\n\n\n\n\n      let routeNote = \"\";\n      if (rp?.ok && rp.dir) {\n        const served = await api?.http?.serve?.({ dir: rp.dir }).catch(() => null) as\n          { ok?: boolean; urls?: string[]; error?: string } | null | undefined;\n        const url = served?.ok ? buildPreviewUrl(served.urls, rp.name ?? \"index.html\") : null;\n        if (url) { openBrowserTab(url, label); return; }\n        routeNote = `保真渲染页已生成，但本地服务没起来或没返回可用地址（${served?.error ?? \"未知原因\"}）。`\n          + \"当前按文本结构重排显示，不是原版式。\";\n      } else if (rp && rp.ok === false) {\n        routeNote = (rp.needs === \"libreoffice\" && rp.reason === \"no-libreoffice\")\n          ? `${rp.hint ?? \"需要本机安装 LibreOffice。\"}（当前按文本结构重排显示，不是原版式）`\n          : (rp.needs === \"libreoffice\" && rp.reason === \"failed\")\n            ? `LibreOffice 转换失败：${rp.error ?? \"未知原因\"}（当前按文本结构重排显示，不是原版式）`\n            : `保真渲染不可用：${rp.error ?? \"未知原因\"}（当前按文本结构重排显示，不是原版式）`;\n      } else {\n        \n\n        routeNote = \"保真渲染通道没有响应（若应用刚更新过，请**重启应用**后再试）。\"\n          + \"当前按文本结构重排显示，不是原版式。\";\n      }\n\n      const dr = await api?.docs?.read?.(path).catch(() => null) as\n        { ok?: boolean; text?: string; error?: string } | null | undefined;\n      if (!dr?.ok) {\n        openFileAbs(path, label, `${routeNote}\\n（另外，文本提取也没成功：${dr?.error ?? \"未知原因\"}）`);\n        return;\n      }\n      \n      ";
/** 交换后的产物（落回块在前 + 保真块在后）—— 与锚点**长度完全相同**（1586 = 1586），
 *  所以这条变异改完文件**长度不变**、花括号仍平衡（不是"改成语法错误"的弱化变异体）。 */
const A1136_SIDEBAR_DR_RP_BLOCK = "const dr = await api?.docs?.read?.(path).catch(() => null) as\n        { ok?: boolean; text?: string; error?: string } | null | undefined;\n      if (!dr?.ok) {\n        openFileAbs(path, label, `${routeNote}\\n（另外，文本提取也没成功：${dr?.error ?? \"未知原因\"}）`);\n        return;\n      }\n      \n      const rp = await api?.docs?.renderPage?.({ path, name: label }).catch(() => null) as\n        { ok?: boolean; dir?: string; name?: string; error?: string; degrade?: boolean;\n          needs?: string; hint?: string; reason?: string; transient?: boolean } | null | undefined;\n      \n\n\n\n\n\n\n      let routeNote = \"\";\n      if (rp?.ok && rp.dir) {\n        const served = await api?.http?.serve?.({ dir: rp.dir }).catch(() => null) as\n          { ok?: boolean; urls?: string[]; error?: string } | null | undefined;\n        const url = served?.ok ? buildPreviewUrl(served.urls, rp.name ?? \"index.html\") : null;\n        if (url) { openBrowserTab(url, label); return; }\n        routeNote = `保真渲染页已生成，但本地服务没起来或没返回可用地址（${served?.error ?? \"未知原因\"}）。`\n          + \"当前按文本结构重排显示，不是原版式。\";\n      } else if (rp && rp.ok === false) {\n        routeNote = (rp.needs === \"libreoffice\" && rp.reason === \"no-libreoffice\")\n          ? `${rp.hint ?? \"需要本机安装 LibreOffice。\"}（当前按文本结构重排显示，不是原版式）`\n          : (rp.needs === \"libreoffice\" && rp.reason === \"failed\")\n            ? `LibreOffice 转换失败：${rp.error ?? \"未知原因\"}（当前按文本结构重排显示，不是原版式）`\n            : `保真渲染不可用：${rp.error ?? \"未知原因\"}（当前按文本结构重排显示，不是原版式）`;\n      } else {\n        \n\n        routeNote = \"保真渲染通道没有响应（若应用刚更新过，请**重启应用**后再试）。\"\n          + \"当前按文本结构重排显示，不是原版式。\";\n      }\n\n      ";
/** vendor 副本的**文件末尾** 70 字节（第 13 条的锚点；唯一命中）。 */
const A1136_VENDOR_TAIL = " self?self:\"undefined\"!=typeof window?window:{})},{}]},{},[10])(10)});";
const A1136_VENDOR_DRIFT_PROBE = "\n/* A-1136-⑫-vendor-drift-probe */\n";
const TARGETS = [F_PLAN, F_PAGE, F_SIDEBAR, F_MAIN, F_VENDOR_JSZIP, F_LO, F_DOCTEXT, F_CONV, F_PROCKILL, F_VIEW, F_CHATPANEL, F_BUILTIN];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1136");

const MUTATIONS = [
  {
    name: "1 renderPlan：pptx 被判成 text-html（保真渲染整条路消失，退回抽文本重排）",
    file: F_PLAN,
    mutate: (t) => sub(t, 'if (PPTX_OOXML.includes(ext)) { return { render: "pptx-preview", faithful: true }; }',
      'if (PPTX_OOXML.includes(ext)) { return { render: "text-html", faithful: false }; }'),
  },
  {
    name: "2 renderPlan：老格式的 needs 被抹掉（.doc 被当能直接渲染 ⇒ 页面必然白屏）",
    file: F_PLAN,
    mutate: (t) => sub(t, 'return { render: "pdf-viewer", faithful: true, needs: "libreoffice" };',
      'return { render: "pdf-viewer", faithful: true };'),
  },
  {
    name: "3 renderPlan：未知类型兜底被判成 faithful（白屏且不报错）",
    file: F_PLAN,
    mutate: (t) => sub(t, 'return { render: "none", faithful: false };', 'return { render: "none", faithful: true };'),
  },
  {
    name: "4 docRenderPage：库路径去掉前导 /（页面在子目录 ⇒ 库 404 ⇒ 用户看到一片空白）",
    file: F_PAGE,
    mutate: (t) => sub(t, 'return { name: l.name, path: "/" + rel.replace(/\\\\/g, "/") };',
      'return { name: l.name, path: rel.replace(/\\\\/g, "/") };'),
  },
  {
    name: "5 docRenderPage：name 丢掉子目录前缀（服务错文件 / 404）",
    file: F_PAGE,
    /* ⚠️ 这条锚点现在命中**两处**（`writeRenderPage` 与阶段 C 新增的 `writePdfViewerPage`），
       两处都必须带子目录前缀 ⇒ 是**计数闸门**，用 all 整组改（否则核验器只能判"不唯一"）。 */
    all: true,
    mutate: (t) => subAll(t, 'return { ok: true, dir: rootDir, name: `${sub}/index.html` };',
      'return { ok: true, dir: rootDir, name: "index.html" };'),
  },
  {
    name: "6 docRenderPage：pptx mode 由 list 改成 slide（只渲染第一页，全片预览名存实亡）",
    file: F_PAGE,
    /* ⚠️ 锚点随源码形状同步（2026-09-29 自适应改造后 `width:1280` → `width:curW`）：
       锚在 `mode:'list'` 那一段，**不要锚在写死的尺寸上** —— 尺寸已经改成自适应的了。 */
    mutate: (t) => sub(t, "{width:curW,height:Math.round(curW*9/16),mode:'list'}",
      "{width:curW,height:Math.round(curW*9/16),mode:'slide'}"),
  },
  {
    name: "7 docRenderPage：失败不置 __renderError（静默白屏，只剩转圈）",
    file: F_PAGE,
    /* ⚠️ 锚点**故意命中 3 次**（pptx/docx/xlsx 三个 catch 长得一样）⇒ 必须 `subAll` + `all: true`：
       只改一个等于另外两个还能报错，不能证明"失败全静默"这条守卫有效（铁律 3 的"锚对象错"）。 */
    all: true,
    mutate: (t) => subAll(t, ".catch(function(e){window.__renderError=String(e&&e.message||e);});",
      ".catch(function(e){void e;});"),
  },
  {
    name: "8 docRenderPage：writeRenderPage 不再校验 faithful（老格式也生成页面 ⇒ 白屏）",
    file: F_PAGE,
    /* ⚠️ 2026-09-30 形状变了：闸门多了 `!useFallback &&`（兜底路线）⇒ 锚点同步（改源码形状必须同步锚点）。 */
    mutate: (t) => sub(t, 'if (!useFallback && (!plan.faithful || plan.needs)) {\n    return { ok: false, error: `该类型不支持保真渲染（${absPath}）` };\n  }', ""),
  },
  {
    name: "9 RightSidebar：删掉 docs.read 落回（Agent 通道被保真渲染挤掉 —— 用户点名担心的）",
    file: F_SIDEBAR,
    /* ⚠️ 2026-10-08：从闭包内 `indexOf` 切片改成**字面量锚点**。
       旧写法把 `from` 藏在 `mutate:` 闭包里 ⇒ 核验器解析不出来 ⇒ 报「未核验」
       （= 没人核验 = 没有保护，且比「未命中」更隐蔽：未命中会响，未核验是静默的）。
       语义完全不变：删掉 [落回块起点, `docViewToHtml(` 起点) 这一段。
       ⚠️ 锚点里那几行**空行/ 缩进被剥离残留**是源码原样，别顺手"整理"——
         整理会让它变成「未命中」，而症状读起来像"源码漂移了"（假警报指向错误对象）。 */
    from: A1136_SIDEBAR_DR_BLOCK,
    to: "",
    mutate: (t) => sub(t, A1136_SIDEBAR_DR_BLOCK, ""),
  },
  {
    name: "10 RightSidebar：保真与落回顺序颠倒（永远走旧通道 ⇒「没变化啊」复发）",
    file: F_SIDEBAR,
    /* ⚠️ 2026-10-08：**修掉一个弱化变异体**（实测发现，原写法压根没颠倒顺序）。
       旧写法是 `t.slice(0,i) + t.slice(j).replace(同串→同串) + block`：
       那个 `.replace()` 把它自己接在同串后面 ⇒ **恒等替换**（什么也没做），
       于是整条退化成「把保真块**追加到文件末尾**」——
         · 文件里 `renderPage` 变成 **3 处**、`docs?.read` 变成 **2 处**；
         · 守卫的顺序断言 `iRender < iRead` 在 openBody 切片里**仍然成立**（实测绿）；
         · 它之所以还是变红，是被a1136-stage-c 里两条**别的**断言撞上的
           （结构化页构造被挪走 / `notice: routeNote` 不在那段里），
           也就是"红了，但不是因为这条名字说的那个缺陷" —— 弱化变异体的教科书形态。
       现在改成**真交换**：把「落回块」整块搬到「保真块」之前（两段各自语法完整，
       花括号仍平衡、长度 delta 为 0），实测**恰好打破顺序断言那条**：
       `两条通道的先后：保真在前、落回在后`（+ stage-c 那两条）。 */
    from: A1136_SIDEBAR_RP_DR_BLOCK,
    to: A1136_SIDEBAR_DR_RP_BLOCK,
    mutate: (t) => sub(t, A1136_SIDEBAR_RP_DR_BLOCK, A1136_SIDEBAR_DR_RP_BLOCK),
  },
  {
    name: "11 main：IPC 不再判 planRender（老格式也去生成渲染页 ⇒ 白屏）",
    file: F_MAIN,
    /* ⚠️ 2026-09-30 形状变了：`html-native` 分支插在 `planRender` 与 `!plan.faithful` 之间
       ⇒ 锚点改锚**那句闸门表达式本身**（改源码形状必须同步锚点）。 */
    mutate: (t) => sub(t, "if (!plan.faithful) {", "if (false) {"),
  },
  {
    name: "12 main：不返回 degrade 标记（渲染层不知道能落回 ⇒ 直接弹错误）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'error: `该类型不支持保真渲染（.${abs.split(".").pop() ?? "?"}）`, degrade: true }',
      'error: `该类型不支持保真渲染（.${abs.split(".").pop() ?? "?"}）` }'),
  },
  {
    /* 这一条的"破坏方式"与其余不同：不改源码，改 **vendor 里那份手工复制的副本**。
       vendor 副本是 A-1136 里唯一的"手抄第二产地"（本仓铁律 10）—— 抄错不报错。
       把副本末尾追加几个字节 ⇒ 逐字节一致性判据必须变红（模拟"升级了依赖却忘了重新复制"）。 */
    name: "13 gui/vendor/jszip.min.js：副本被改脏（依赖升级后忘了重新复制 ⇒ 画的是旧版本）",
    file: F_VENDOR_JSZIP,
    /* ⚠️ 2026-10-08：从「整文件 `t + 探针`」改成**尾部锚点**。
       旧写法**压根没有 `from`**（核验器报「压根没有 from」⇒ 未核验 = 没人核验）。
       现在锚「文件末尾 70 字节」（实测唯一命中）+ 追加探针，
       **破坏方式逐字不变**（产物与旧的 `t + 探针` 完全相同：末尾多一段注释）。
       ⚠️ 为什么不用「整文件追加」当锚点：核验器只认 `from`/`to`/`sub(t,…)` 三种形态，
         「往后追加」没有可数的锚点 —— 而"没有锚点"就等于这条守卫从未被核验过。 */
    from: A1136_VENDOR_TAIL,
    to: A1136_VENDOR_TAIL + A1136_VENDOR_DRIFT_PROBE,
    mutate: (t) => sub(t, A1136_VENDOR_TAIL, A1136_VENDOR_TAIL + A1136_VENDOR_DRIFT_PROBE),
  },
  {
    /* 用户实测反馈（2026-09-29 截图）：「只显示一半」= 宽度写死。
       M14~M16 三条分别打「写死宽」「垂直不居中」「docx 锁 A4 宽」——都在 ⑬ 组里。 */
    name: "14 docRenderPage：pptx 宽度写死回 1280（窄右栏横向被裁 = 用户看到的「只显示一半」）",
    file: F_PAGE,
    mutate: (t) => sub(t, "pptxPreview.init(wrap,{width:curW,height:Math.round(curW*9/16),mode:'list'})",
      "pptxPreview.init(wrap,{width:1280,height:720,mode:'list'})"),
  },
  {
    name: "15 docRenderPage：#stage 去掉垂直居中（内容贴顶 = 用户看到的「只放在最上面」）",
    file: F_PAGE,
    mutate: (t) => sub(t,
      "#stage{padding:20px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "#stage{padding:20px 12px;display:flex;flex-direction:column;align-items:center;"),
  },
  {
    name: "16 docRenderPage：docx 改回 ignoreWidth:false（锁死 A4 固定宽 ⇒ 窄右栏纸张溢出被裁）",
    file: F_PAGE,
    mutate: (t) => sub(t, "breakPages:true,ignoreWidth:true,ignoreHeight:false",
      "breakPages:true,ignoreWidth:false,ignoreHeight:false"),
  },
  /* ── 阶段 C（老格式 → LibreOffice → PDF）—— 2026-09-29 ── */
  {
    name: "17 libreoffice：looksLikeSoffice 裸放行 `libreoffice` 别名（Windows 目录 `C:\Program Files\LibreOffice` 被当成本体）",
    file: F_LO,
    mutate: (t) => sub(t,
      'if (lower === "libreoffice.exe") { return true; }\n  if (lower === "libreoffice" && !/^[a-z]:\\//i.test(p.replace(/\\\\/g, "/"))) { return true; }',
      'if (lower === "libreoffice") { return true; }'),
  },
  {
    name: "18 libreoffice：parseVersion 抠不到时编一个假版本（调用方分不清「找到了」与「验证过」）",
    file: F_LO,
    mutate: (t) => sub(t, 'if (!m) { return ""; }', 'if (!m) { return "unknown"; }'),
  },
  {
    name: "19 libreoffice：probeSearchList 丢掉环境变量覆盖（用户显式指定失效 ⇒ 逃生门没了）",
    file: F_LO,
    mutate: (t) => sub(t, "for (const name of LO_PATH_ENV) { push(env[name]); }", ""),
  },
  {
    name: "20 libreoffice：notFound 的 hint 去掉下载地址（提示还在但不可操作）",
    file: F_LO,
    mutate: (t) => sub(t, '"装一个即可（装完重开应用，无需其他配置）：https://www.libreoffice.org/download/download-libreoffice/"',
      '"装一个即可。"'),
  },
  {
    name: "21 doc_text：wIdent 判据失效（损坏的 .doc 不再被拦）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "if (wIdent !== DOC_WIDENT) {", "if (false) {"),
  },
  {
    name: "22 doc_text：fEncrypted 判据失效（加密文档不再被拦，解出密文喂给 Agent）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "if ((flags & 0x0100) !== 0 || (flags & 0x8000) !== 0) {", "if (false) {"),
  },
  {
    name: "23 doc_text：去重率阈值放宽到 0.9（损坏段 0.661 打不穿 ⇒ 伪汉字混进正文）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "export const FAKE_TEXT_DEDUP_RATIO = 0.55;", "export const FAKE_TEXT_DEDUP_RATIO = 0.9;"),
  },
  {
    name: "24 doc_text：逐段判质的 bad 计数不涨（垃圾段仍丢弃，但**不再如实上报** ⇒ 用户/Agent 被蒙在鼓里）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "if (!compressed && !looksLikeRealText(seg)) { bad += 1; continue; }",
      "if (!compressed && !looksLikeRealText(seg)) { continue; }"),
  },
  {
    name: "25 libreofficeConvert：改用 spawnSync（阻塞 Electron 主进程事件循环）",
    file: F_CONV,
    mutate: (t) => sub(t, "child = spawn(bin, args, {", "child = spawnSync(bin, args, {"),
  },
  {
    name: "26 libreofficeConvert：丢掉 -env:UserInstallation（用户开着 LibreOffice 时挂住等锁）",
    file: F_CONV,
    mutate: (t) => sub(t, '"-env:UserInstallation=" + pathToFileURL(profileDir).href,', ""),
  },
  {
    name: "27 RightSidebar：删掉「保真通道没响应」那句说明（**复现用户实测**：样式变了却没有任何提示）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'routeNote = "保真渲染通道没有响应（若应用刚更新过，请**重启应用**后再试）。"',
      'routeNote = "";'),
  },
  /* ── 09-30：Windows `.com` vs `.exe`（本轮「用户装了 LO 却看不了老文件」的真根因）── */
  {
    name: "28 libreoffice：looksLikeSoffice 不再认 `.com`（Windows 唯一的可用形态被拒）",
    file: F_LO,
    mutate: (t) => sub(t, ' || lower === "soffice.com") { return true; }', ") { return true; }"),
  },
  {
    name: "29 libreoffice：win32 候选表把 `.com` 全改成 `.exe`（**复现原始 bug**：`.exe --version` 挂死 ⇒ 判没装）",
    file: F_LO,
    all: true,
    mutate: (t) => subAll(t, 'soffice.com",', 'soffice.exe",'),
  },
  {
    name: "30 libreoffice：consoleVariantOf 恒返回 null（用户手填 `.exe` 时救不回来）",
    file: F_LO,
    mutate: (t) => sub(t, 'return s.slice(0, s.length - base.length) + "soffice.com";', "return null;"),
  },
  {
    name: "31 libreofficeConvert：resolveConsoleVariant 不再换 `.com`（`.exe` 直接拿去 spawn ⇒ 挂死）",
    file: F_CONV,
    mutate: (t) => sub(t, "if (com && existsSync(com)) { return com; }", "if (false) { return com; }"),
  },
  {
    name: "32 procKill：`taskkill` 丢掉 `/T`（只杀启动器 ⇒ 留孤儿 soffice.bin）",
    file: F_PROCKILL,
    mutate: (t) => sub(t, 'return ["/PID", String(pid), "/T", "/F"];', 'return ["/PID", String(pid), "/F"];'),
  },
  {
    name: "33 libreofficeConvert：shouldSkipVersionProbe 恒 false（win32 上真跑 `.exe --version` ⇒ 挂满 8s 超时）",
    file: F_CONV,
    mutate: (t) => sub(t, 'return platform === "win32" && /\\.exe$/i.test(bin);', "return false;"),
  },
  {
    name: "34 main：转换成功后不再删临时目录（**每次转换漏一个 slime-lo-*** ⇒ 违反用户「不留文件」）",
    file: F_MAIN,
    mutate: (t) => sub(t,
      "      cleanupConvertDir(conv.dir);\n      if (!built.ok) {",
      "      if (!built.ok) {"),
  },
  {
    name: "35 libreofficeConvert：把杀树调用**短路掉**（`.exe`/`.bin` 孤儿进程堆积）",
    file: F_CONV,
    mutate: (t) => sub(t, "killProcessTree(child.pid, {", "void 0 && killProcessTree(child.pid, {"),
  },
  /* ── 兜底路线（用户口径：「LibreOffice 优先 + SheetJS 兜底」）── */
  {
    name: "36 renderPlan：`.xls` 丢掉 `fallback: sheetjs`（没装 LO 就彻底没得看）",
    file: F_PLAN,
    mutate: (t) => sub(t, 'return { render: "pdf-viewer", faithful: true, needs: "libreoffice", fallback: "sheetjs" };',
      'return { render: "pdf-viewer", faithful: true, needs: "libreoffice" };'),
  },
  {
    name: "37 renderPlan：给 `.doc`/`.ppt` 也登记假 fallback（纯 JS 画不出 ⇒ 白屏，且掩盖「没装 LO」）",
    file: F_PLAN,
    mutate: (t) => sub(t, 'return { render: "pdf-viewer", faithful: true, needs: "libreoffice" };',
      'return { render: "pdf-viewer", faithful: true, needs: "libreoffice", fallback: "text-html" };'),
  },
  {
    name: "38 docRenderPage：`useFallback` 不再校验 `plan.fallback`（调用方可塞任意渲染器 ⇒ 白屏）",
    file: F_PAGE,
    mutate: (t) => sub(t, "const useFallback = opts.useFallback === true && !!plan.fallback;",
      "const useFallback = opts.useFallback === true;"),
  },
  {
    name: "39 docRenderPage：提示带不渲染（走兜底却不吭声 ⇒ 用户以为看到了原版式）",
    file: F_PAGE,
    mutate: (t) => sub(t, "? '<div class=\"notice\">'", "? '<div>'"),
  },
  {
    name: "40 docView：结构化降级页不插提示（`.doc`/`.ppt` 静默降级）",
    file: F_VIEW,
    mutate: (t) => sub(t, '${opts.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ""}', "<div></div>"),
  },
  /* ── 2026-09-30 用户实测的两个新问题 ── */
  {
    name: "41 docRenderPage：把 pptx 的「清空容器」挪到 init **之后**（**复现**顺序错 ⇒ 重画追加出第二份）",
    file: F_PAGE,
    /* ⚠️ 不能用裸的 `  wrap.innerHTML='';` 当锚点 —— sheetjs 分支里有一处**同名**
       （不同语义：那是清空后追加表格，本来就该在 append 之前）⇒ 会「命中 2 次」。
       这里锚「清空 + pptx 的 init」这一对，唯一且**顺序就是判据**。 */
    mutate: (t) => sub(t,
      '"  wrap.innerHTML=\'\';",\n      "  pv=window.pptxPreview.init(wrap,{width:curW,height:Math.round(curW*9/16),mode:\'list\'});",',
      '"  pv=window.pptxPreview.init(wrap,{width:curW,height:Math.round(curW*9/16),mode:\'list\'});",\n      "  wrap.innerHTML=\'\';",'),
  },
  {
    name: "42 RightSidebar：删掉「ok 但服务没起来」那句说明（以前这条**完全静默**）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "保真渲染页已生成，但本地服务没起来或没返回可用地址", "服务异常"),
  },
  {
    name: "43 RightSidebar：`plugins` 不透传（**复现** PDF 一片空白：Electron 默认 Plugins are disabled）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "plugins: props.plugins ? \"true\" : undefined,", "plugins: undefined,"),
  },
  {
    name: "44 RightSidebar：使用处不传 `plugins`（只声明不传 ⇒ 同样空白）",
    file: F_SIDEBAR,
    /* ⚠️ 锚点曾两次漂移：先是在 `allowpopups` 与 `plugins` 之间被插入注释（A-1137），
       2026-10-05 全仓注释剥离又把那段注释变成了空行 ⇒ 整块（连注释三行）不再逐字相符。
       ⇒ 现在只锚「`plugins` 那一行 + 它后面那一行被剥离成空白的残留」——
         **不再跨任何注释、也不跨任何有内容的行**；实测唯一命中。
       ⚠️ 刻意**不**把 `allowpopups` 一起锚进来：这条变异的名字说的是「不传 plugins」，
         若连 `allowpopups` 一起删掉，红的原因就多了「popups 也没传」这一层
         （弱化变异体：红了，却不是这条名字说的那个缺陷）。
       ⚠️ 也刻意不用「向上扩到 partition/src」—— 那会跨好几个剥离残留的空行。 */
    mutate: (t) => sub(t,
      "          plugins\n          ",
      "",
    ),
  },
  {
    name: "45 main：把临时目录当页面 rootDir（**复现用户实测**：页面随临时目录一起被删 ⇒ 服务报「目录不存在」）",
    file: F_MAIN,
    mutate: (t) => sub(t, "writePdfViewerPage(pageRoot, conv.pdfPath, abs, title)",
      "writePdfViewerPage(conv.dir, conv.pdfPath, abs, title)"),
  },
  {
    name: "46 main：`isWebSafeUrl` 不放行 `chrome-extension`（**复现**弹窗：查看器被 frame 守卫掐断）",
    file: F_MAIN,
    mutate: (t) => sub(t, '"blob", "chrome", "chrome-extension"', '"blob", "chrome"'),
  },
  {
    name: "47 main：`openExternalSafe` 不再提前拒内部协议（**复现**「无法打开 chrome-extension://」系统框）",
    file: F_MAIN,
    mutate: (t) => sub(t,
      '  if (isChromiumInternalScheme(url)) {\n    return { ok: false, reason: "internal-scheme" };\n  }\n',
      ""),
  },
  {
    name: "48 docRenderPage：查看器页丢掉 blob，直接让 <embed> 指向服务器 URL（旧写法，失败即空白且无言）",
    file: F_PAGE,
    mutate: (t) => sub(t, "var o=URL.createObjectURL(new Blob([b],{type:'application/pdf'}));", "var o=url;"),
  },
  /* ── 加载速度优化（用户反馈「老版每次都要加载半天」）── */
  {
    name: "49 main：删掉老格式缓存短路（**复现**「每次打开都等 LibreOffice 冷启动 10~16s」）",
    file: F_MAIN,
    mutate: (t) => sub(t,
      "if (existsSync(cachedPage.html) && existsSync(cachedPage.pdf) && statSync(cachedPage.pdf).size > 0) {",
      "if (false) {"),
  },
  {
    name: "50 docRenderPage：快路径不排除带 notice 的页面（会显示**过期的降级理由**）",
    file: F_PAGE,
    mutate: (t) => sub(t, "if (!wantNotice && existsSync(htmlPath)", "if (existsSync(htmlPath)"),
  },
  {
    name: "51 libreofficeConvert：队列尾只推进成功（一次 reject 永久卡死整条队列）",
    file: F_CONV,
    mutate: (t) => sub(t, "convertChain = run.then(() => undefined, () => undefined);",
      "convertChain = run.then(() => undefined);"),
  },
  /* ── 第五轮：HTML 原生渲染 + 表格几何（用户实测）── */
  {
    name: "52 renderPlan：`.html` 退回 text-html（**复现**用户看到的是源码而不是网页）",
    file: F_PLAN,
    mutate: (t) => sub(t,
      'if (ext === "html" || ext === "htm" || ext === "xhtml") { return { render: "html-native", faithful: true }; }',
      'if (ext === "html" || ext === "htm" || ext === "xhtml") { return { render: "text-html", faithful: false }; }'),
  },
  {
    name: "53 docRenderPage：表格丢掉 `!merges`（**复现**「合并单元格不成形/太粗糙」）",
    file: F_PAGE,
    mutate: (t) => sub(t, "merges=ws['!merges']||[]", "merges=[]"),
  },
  {
    name: "54 docRenderPage：不再标记 sheet 模式（**复现**表格缩在屏幕中间一小块）",
    file: F_PAGE,
    mutate: (t) => sub(t, "setAttribute('data-mode','sheet')", "setAttribute('data-mode-x','sheet')"),
  },
  /* ── 附件卡片可点击预览（用户实测「只能看不能点」）── */
  {
    name: "55 ChatPanel：附件卡片不挂 onClick（**复现**用户实测「只能看不能点、关了页只能再拖一遍」）",
    file: F_CHATPANEL,
    all: true,
    mutate: (t) => subAll(t, "                  onClick={() => openDocInSidebar(d.path, d.name)}\n", ""),
  },
  {
    name: "56 ChatPanel：待发卡的 `×` 去掉 stopPropagation（点「移除」会顺带把预览打开）",
    file: F_CHATPANEL,
    mutate: (t) => sub(t, "onClick={(e) => { e.stopPropagation(); setPendingDocs(", "onClick={() => { setPendingDocs("),
  },
  /* ── 第七轮：附件上限 + Agent 生成 Office（用户实测 / 审计缺口）── */
  {
    name: "57 ChatPanel：文档附件上限改回 4（**复现**用户实测「为什么最多只能载入 4 个文件」）",
    file: F_CHATPANEL,
    mutate: (t) => sub(t, "const MAX_PENDING_DOCS = 32;", "const MAX_PENDING_DOCS = 4;"),
  },
  {
    name: "58 builtin：`docs_create` 的存在检查失效（**复现**覆盖已有文档 ⇒ 二进制没有回滚账本，覆盖即丢）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "      await stat(abs);", "      await stat(abs + \"-nope\");"),
  },
  {
    name: "59 builtin：`docs_create` 的扩展名表丢掉 `.xlsx`（**复现**「Agent 做不了 Excel」）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '  ".xlsx": "xlsx",', '  ".xls": "xlsx",'),
  },
];

/* ---------------- 以下与 mut-a1133-docs.mjs 同构（同一套校准逻辑） ---------------- */
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
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); console.error(base.out); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1136")) { process.exit(1); }
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
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
