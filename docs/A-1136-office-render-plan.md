# A-1136：Office 保真渲染（人看）与文本理解（Agent 读）双通道

> 2026-09-29 起。用户指令：「B 先落地新格式，然后做 C 对老格式的用户自选的随包适配」。
> 用户硬约束原话：**「不要漏了 Agent 对于这些文件的解析理解能力，不要到时候只能用户看，Agent 什么都做不了。」**

## 0. 为什么做（用户三轮反馈的收敛）

用户明确要的是**「类似以图片的形式直接用 HTML/Web 预览」**，而非「转成 md 文件阅读」。
A-1135 我做的「结构化重排版」（抽文字 → 纸张壳 + 页卡片）**路线本身不够** ——
字体/字号/颜色/位置/图片全丢，用户第三次看图仍说「没变化」。

实测（离屏 Playwright Chromium + 真 `第2章.pptx` 28 页）确认：
**`pptx-preview` 能把真 .pptx 忠实渲染**（28 页全出，绝对定位/颜色/图片都在）—— 这才是「像图片」。

## 1. 架构：一条文件 → 两条平行通道（互不替代）

| 通道 | 给谁 | 产出去向 | 实现 |
|---|---|---|---|
| **A · 保真渲染** | 人看 | 右栏浏览器页 | pptx-preview / docx-preview / SheetJS /（老格式）LibreOffice→PDF |
| **B · 文本抽取** | Agent 读 | 工具返回 / 上下文 | `core-ts/src/doc_text.ts`（**现有，原样保留**） |

⚠️ **通道 B 不许因通道 A 而削弱**：`slime:docs:read` 与 `doc_text.ts` 是 Agent 唯一理解文件内容的入口，
渲染通道是**新增**，不是替换。

## 2. 阶段 B（本轮）：新格式保真渲染（零系统依赖）

| 扩展名 | 渲染器 | 依赖 | 状态 |
|---|---|---|---|
| `.pptx/.pptm/.potx` | pptx-preview | `pptx-preview@1.0.7` | **已落地** |
| `.docx/.docm/.dotx` | docx-preview | `docx-preview@0.4.1` | **已落地** |
| `.xlsx/.xlsm/.xltx` | SheetJS | `xlsx@0.18.5` (SheetJS CE) | **已落地** |
| `.pdf` | 已有 Chromium PDF 查看器 | 无 | 已能用 |

**端到端实测（2026-09-29，`gui/scripts/probe-render-fidelity.mjs`）**：

- `第2章.pptx`（2.2MB）：**58 个渲染块 / 源 29 页**、177 张图 —— 蓝字标题、红横线、白底 16:9 全部还原。
- `20244222026-张裴文-《互联网思维》.docx`（729KB）：78 段 + 1 表格 20 格、`docx-wrapper` ✓ —— 校徽图片、
  下划线、☑ 复选框、**表格横排且边框完整**（A-1135 手工重排路线修不好的那个表格，真渲染一行代码就对了）。
- `_a1136-test.xlsx`（造样本）：2 张表、数值与表头全部正确。

**Agent 侧实测（`gui/scripts/probe-agent-read.mjs`，测 `doc_text.ts`）**：

| 文件 | 抽取字符数 | 内容正确 |
|---|---|---|
| `第2章.pptx` | 3372 | ✓（含"传感器"） |
| `…《互联网思维》.docx` | 4168 | ✓（含"互联网思维"） |
| `_a1136-test.xlsx` | 213 | ✓（含"传感器A"） |
| `jeny_第一章.ppt`（老格式） | 12701 | ✓（正常中文） |
| `专题3总结_….doc`（老格式） | **1711** | ✓ 干净正文（首版返回 3695 字、54% 是伪汉字；查明**是文件本身损坏**，已按段丢弃并**如实上报**） |

⇒ 用户硬约束「不要漏了 Agent 的解析理解能力」**成立**：新格式三类的抽取链一直是通的（A-1133 建立）；
老格式经阶段 C 后**七份样本全部可读**（见 §3）。

## 3. 阶段 C（已落地，2026-09-29）：老格式 → LibreOffice headless → PDF

`.doc/.xls/.ppt`（OLE2 二进制）纯前端无解 ⇒ LibreOffice headless 转 PDF → 已有 PDF 查看器。

**三决策（`AskUserQuestion` 用户已定）**：随包方式 = **不随包，先探测本机、缺了再提示下载**；
转换后 PDF = **每次转换都不留文件**；本轮程度 = **完整落地 + 端到端验证**。

**落点（唯一产地）**：
- `core-ts/src/office/libreoffice.ts` —— 「本机有没有 LO」的纯判据（候选路径表 / 版本解析 / 环境变量逃生门 / 提示文案）。
- `gui/src/main/libreofficeConvert.ts` —— 转换入口：`probeLibreOffice`（真跑 `--version`）+ `convertToPdf` + `cleanupConvertDir`；
  参数由 `buildConvertArgs` **一处拼装**；执行器可注入（`setConvertRunner`，见下）。
- `gui/src/main/docRenderPage.ts::writePdfViewerPage` —— 把转好的 PDF 落进固定目录并生成 `<embed>` 查看页。
- `gui/src/main/index.ts` —— IPC `slime:docs:renderPage` 的 `needs:"libreoffice"` 分支 + IPC `slime:office:libreofficeProbe`。
- `RuntimePanel` 设置卡片 —— 就绪/未安装 + 版本 + 路径 + 「前往下载」+「重新检测」。

**关键判据（每条都挡一个真实故障）**：
- 成功判据 = **磁盘上真出现非空 PDF**，**不是**退出码 0（LibreOffice 在过滤缺失/输出目录不可写时退出码仍 0 却无产物）。
- 必须带 `-env:UserInstallation=file://…` —— **绕单实例锁**（用户开着 LO 时 `--headless` 会排队等锁到超时，实测）。
- 绝不 `spawnSync`（阻塞 Electron 主进程事件循环）；一律 `spawn` + 显式超时 + 超时真 kill（SIGTERM → SIGKILL）。

### ⚠️⚠️ 09-30 补：Windows 上必须用 `soffice.com`，不是 `soffice.exe`（本轮「装了 LO 却看不了老文件」的真根因）

**现象**：用户装了 LibreOffice（`C:\Program Files\LibreOffice` 在、注册表有），但老文件依旧只能用纯文本看（效果差）。

**根因（实测三组对照）**：

| 命令 | 结果 |
| --- | --- |
| `soffice.exe --version` | **挂死 20~25s、零输出**（且留下孤儿 `soffice.bin` 进程） |
| `soffice.exe --headless --version` | **仍挂死 25s**（加 `--headless` 救不了） |
| `soffice.com --version` | **0.28s** 返回 `LibreOffice 26.8.0.3 …` |
| `soffice.com --headless --convert-to pdf` | 正常出产物（`.doc` 318KB / `.ppt` 4.2MB PDF） |

`.exe` 是 **GUI 子系统**程序 —— 它**不往 stdout 写**，且启动器会一直等 GUI 进程 ⇒ `spawn`/`execFile` 收不到
任何输出、超时被当成"没装"。探测超时 8s ⇒ 判 `not-found` ⇒ 给用户弹"去下载" ⇒ **用户明明装好了**。
`.com` 是同目录的**控制台**版本，Windows 上跑 CLI 的正解。

**修法（三处，缺一不可）**：
1. `win32` 候选表**先列 `.com` 再列 `.exe`**；
2. `consoleVariantOf()` / `resolveConsoleVariant()`：用户手动把环境变量填成 `soffice.exe` 时**自动换 `.com`**；
3. `shouldSkipVersionProbe()`：win32 上**根本不真跑 `.exe`**（挂死 + 留僵尸进程，得不偿失）。

**附带修掉的两个真 bug**：
- **超时杀不干净**：Windows 上 `child.kill()` 只终止**那一个**进程，`soffice` 会再拉起 `soffice.bin`
  ⇒ 孤儿进程堆积。改用 `taskkill /PID <pid> /T /F` 杀**整棵树**。
- **临时目录泄漏**：主进程把 `convertDir` `return` 给渲染层"让渲染层删"，**但渲染层从不消费它**
  ⇒ 每转一次在 `%TEMP%` 漏一个 `slime-lo-*`，**直接违反用户定的「不留文件」**。
  改成**复制完 PDF 后主进程当场删**（`writePdfViewerPage` 内部是 `copyFileSync`，删源不影响页面）。

⚠️ **教训（铁律 23 的实证）**：`looksLikeSoffice` 的旧注释把 `.com` 写成「GUI 启动壳、headless 下不可靠」——
**完全说反了**，而这很可能正是当初候选表优先选 `.exe` 的源头。**注释也是断言，写错会把人引到反方向。**

### 其他可选路线（评估过，附结论）

| 路线 | 稳定性 | 保真度 | 结论 |
| --- | --- | --- | --- |
| **LibreOffice headless → PDF**（现行） | 中（外部进程，但已修好） | **最高**（原版式） | ✅ `.doc`/`.ppt` 的唯一可靠路线，保留 |
| **SheetJS 直读 `.xls`（BIFF8）** | **高**（零外部依赖） | 表格网格（与 `.xlsx` 同款） | ✅ **实测可行**：已 vendored 的 `xlsx.full.min.js` 直接读出 2 张表、中文与数字全对 ⇒ `.xls` 可绕开 LibreOffice |
| LibreOffice WASM（ZetaOffice/LOWA） | 中高（无需装系统软件） | 高 | ⏸ 不作为：体积大、冷启动慢，且本机 LO 已可用 |
| 纯 JS 解析 `.doc`/`.ppt` | 低（普遍不可靠） | 低 | ❌ 不用 |

**端到端判据**：`gui/scripts/probe-libreoffice-e2e.mjs` **12/12**（含**真机**探测/转换 —— 直接断言探测路径以
`.com` 结尾，就是本次故障的回归守卫）。

**⚠️ 执行器为什么要可注入（受平台事实逼迫，不是为了"方便测试"）**：本机 Windows 造不出能被 spawn 的假 soffice ——
Unix 风 `#!` 脚本 spawn 报 `ENOENT`；`.cmd`/`.bat` 在 Node ≥18.20 无 `shell:true` 报 `EINVAL`（而生产不该开 shell）。
⇒ 在 `setConvertRunner` 这层注入替身，把「探测 → 参数拼装 → 结果判定 → 产物发现 → 清理」整条链真跑一遍。
**边界**：`spawn` 本体（真起进程 / 真等退出 / 真超时 kill）**只有装了 LibreOffice 才能验** —— 探针不覆盖、也不假装覆盖。

**老 `.doc` 乱码（见上表）—— 根因与修法**：**不是解析 bug，是文件本身损坏**（piece table 第 0 段指向垃圾区）。
三层防线：① `wIdent === 0xA5EC`（规范判据）② `fEncrypted`/`fObfuscated`（规范判据）③ **逐段去重率**（启发式，阈值 `0.55`；
实测正常段 0.123~0.390 vs 损坏段 0.661）。⇒ 损坏段被丢弃并**如实上报**（info 带「有 N 段无法还原…」）。

## 4. 新增落点（唯一产地）

- `gui/src/main/docRenderPage.ts`：**写渲染页目录**的唯一产地
  （`index.html` 自包含 + 源文件副本；命名 = 内容哈希，幂等）。
- `gui/vendor/*.js`：四个渲染库的分发产物（**手工复制**，见 `gui/vendor/README.md` 的升级纪律）。
  ⚠️ 不能 `import "包名/dist/x.js"` —— `docx-preview` 的 `exports: ["."]` 会拒深层导入。
- `core-ts/src/office/renderPlan.ts`：**「这个扩展名走哪条渲染路线」的唯一判据**
  （纯函数，可单测；与 `fileKinds.ts` 的 `parser` 是两个正交维度：parser 管"怎么读文本"，renderPlan 管"怎么画"）。
- IPC `slime:docs:renderPage`：主进程读源文件字节 + 落盘渲染页目录 → 复用既有 `http.serve` + `openBrowserTab`。
- `gui/scripts/probe-render-fidelity.mjs` / `probe-agent-read.mjs`：端到端判据工具（人肉眼验收 + Agent 可读性）。

## 5. 守卫与变异（已落）

- `tests/core-ts/a1136-render-plan.spec.ts`（**13**）：扩展名 → 路线的纯判据（含"未知类型不冒充可渲染"）。
- `tests/gui/a1136-render-page.spec.ts`（**18**）：HTML 自包含、库用根绝对路径、转义、**真落盘**（`writeRenderPage`）、
  **vendor 副本与依赖包逐字节一致**（手工复制的防漂守卫，对应 M13）。
- `tests/gui/a1136-fidelity-route.spec.ts`（**11**）：**双通道不许互相挤掉**（用户硬约束的守卫）。
- 变异脚本 `mut-a1136-render.mjs`：**27 条**。26 条改源码、第 13 条改的是 `gui/vendor/jszip.min.js`
  （唯一的"手抄第二产地"，抄错不报错 ⇒ 必须单独打）。
  **阶段 C 新增 M17~M27（11 条）**，已逐条实跑确认**变红且红的是对应那条**：
  M17 别名只在 Unix 成立（**这条真抓出一个 bug**）｜ M18 parseVersion 不许编假值 ｜ M19 环境变量逃生门 ｜
  M20 提示必须可操作 ｜ M21 wIdent 行为级 ｜ M22 fEncrypted 行为级 ｜ M23 阈值有实测依据 ｜
  M24 bad 计数要上报 ｜ M25 不许 spawnSync ｜ M26 必带 UserInstallation ｜ M27 missingLo 要真当闸门。
  ⚠️ M22/M27 首轮**存活**（我的守卫只是 `toContain` 文本断言 ⇒ 对"改条件"瞎，铁律 3）⇒ 已改成行为级/判据表达式断言。
  锚点核验：全量 100+ 份脚本"未命中 0 · 不唯一 0 · 序号错位 0"。

**端到端判据**：
- `gui/scripts/probe-libreoffice-e2e.mjs`（**10/10**）：本机现状（no-libreoffice + 可操作 hint）／注入替身后探测+真转换+
  产物 magic 校验+清理（用户要的「不留文件」）／**退出码 0 却没产物必须判 failed**／参数拼装完整。
- `gui/scripts/probe-agent-read.mjs`：新格式三类 + 老格式逐份可读（`专题3总结.doc` = 干净 1711 字）。
- 老格式全样本复检（7 份 .doc/.ppt/.xls）**全部可被 Agent 读取**。

## 6. 待办清单

- [x] `core-ts/src/office/renderPlan.ts` + 单测
- [x] 装 `docx-preview`、`xlsx`（pnpm workspace）
- [x] `gui/src/main/docRenderPage.ts`（写 index.html + 源文件副本）
- [x] IPC `slime:docs:renderPage` + preload
- [x] `RightSidebar.openDocPreviewPage` 分流：可保真走新通道，其余落回旧通道（**两条都在**）
- [x] 守卫（42 条）+ 变异（13/13 实跑变红）
- [x] 门禁全绿（三处 tsc / 全量 vitest / build / assert-bundle / contract-check / parse-check / check-mut-anchors）
- [x] `gui/vendor/README.md` 升级纪律
- [x] **阶段 C：LibreOffice 探测 + 转换 + 渲染层分流 + 设置页入口**（守卫 34 条 + 变异 M17~M35）
- [x] 老 `.doc` 抽取乱码排查（根因 = 文件本身损坏；三层防线：wIdent / fEncrypted / 逐段去重率 0.55）
- [x] **09-30：Windows 必须用 `soffice.com`（`.exe` 挂死 20~25s ⇒ 装了 LO 却被判"没装"）** —— 真机 12/12 验证通过
- [x] 09-30：超时杀**整棵进程树**（`taskkill` 收口到 `core-ts/src/procKill.ts`，GUI 主进程不许出现）
- [x] 09-30：修临时目录泄漏（曾 `return convertDir` 给渲染层"让它删"，而渲染层从不消费）
- [x] **09-30：老格式兜底路线**（用户拍板）——
      `.xls` 走 **LibreOffice 优先 + SheetJS 兜底**（`renderPlan.fallback` + `writeRenderPage({useFallback})`，
      真机 6/6）；`.doc`/`.ppt` 没装 LO 时走 **A-1135 结构化重排 + 页面可见提示**（不再退回纯文本）。
      守卫 42 条 + 变异扩到 **M1~M40**（全量逐条实跑，**40/40 变红、0 存活**）。

## 7. 09-30 第二轮：用户实测的两个问题

### 问题 ②「pptx 全屏后出现一大一小两份」—— 已修（根因确定）

**根因（读库源码确认，不是猜）**：`gui/vendor/pptx-preview.umd.js` 内部
`init(el, opts)` → `new NZ(el, opts)` → `_renderWrapper()` 里 **`document.createElement('div')` 并 append 进 `el`**；
而它自己的 `load()` 只清 **它自己那个** wrapper（`e.wrapper.innerHTML=""`）。
⇒ 在**同一个容器**上 `init` 两次 = **两个 wrapper 同时留在 DOM 里** = 一大一小两份。
⚠️ 库的 `destroy()` 只做 blob 回收（`RZ("destroy")`），**不摘 DOM** ⇒ 靠它没用。

**触发路径**：全屏 / 拉伸窗口 ⇒ `ResizeObserver` ⇒ 再跑一次 `draw()`。

**修法**：`draw()` 里 **`wrap.innerHTML=''` 必须排在 `init` 之前**（顺序就是判据）。

### 问题 ①「老 Office 只显示 md 样式、且没有任何提示」—— 已修（两处）

1. **渲染层：任何**一种失败都要有话说。旧实现只覆盖 `reason === "no-libreoffice"` 与 `"failed"`，
   下面三种**完全静默** ⇒ 用户只看到"样式变了个样"，既不知**为什么**也不知**怎么办**：
   - `rp` 为 `null`/`undefined`（**IPC 未接通 / 主进程抛了**）；
   - `rp.ok === false` 但是**别的原因**；
   - `rp.ok === true` 却 **serve / URL 失败**。
   ⇒ 统一拼成 `routeNote`，写进结构化页面的**可见提示条**（其中"通道没响应"那条会明确提示**重启应用**）。
2. **`.xls` 兜底 + `.doc`/`.ppt` 结构化降级**（见 §6 / 用户拍板）。

⚠️ **最可能的现场原因**：主进程改动**必须重启应用**才生效（本机是 dev 运行）。
   若重启后仍走 md 样式，**新提示条会把原因直接写在页面上** —— 不会再出现"没有任何提示"这种状态。

### ⚠️ 一条**被实测证伪**的推断（留痕，防止后人再走一遍）

我查到 Electron 官方 `<webview>` 文档原文「**Plugins are disabled by default.**」，
且 Chromium 的 PDF 查看器在 Electron 里以插件形式实现 ⇒ **推断**"不开 `plugins` ⇒ PDF 一片空白"，
并据此改了代码。**但实测否掉了这个推断**：

`gui/scripts/probe-pdf-webview.mjs`（**两个独立 Electron 进程**做 A/B，避免复用窗口拿到旧帧）
用**生产代码**落出真 PDF 查看器页 → 真 `<webview>` → `guest.capturePage().toBitmap()` 统计**近白像素占比**：

| 变体 | 近白占比 |
| --- | --- |
| 开 `plugins` | **0.641** |
| 关 `plugins` | **0.641** |

⇒ **这版 Electron（35）开不开都能渲染 PDF，差 0.0 个百分点。**
⇒ `plugins` 保留为**防守性**开启（官方默认关闭，成本为零），但**注释与守卫都已改成"非必需"** ——
   错误理由比没有理由更糟（铁律 23）。

**同一支探针给出的正面结论（这才是关键）**：
**生产代码落出的 PDF 查看器页，在真 `<webview>` 里能画出来（白纸占比 64.1%）** ⇒
只要主进程跑到 `needs:"libreoffice"` 那条分支，用户就能看到**原版式**。

## 8. 09-30 第三轮：**我自己引入的 bug**（页面写进临时目录后又把它删了）

用户截图里那条提示条把根因直接写了出来（§7 加的提示条**第一次派上用场**）：

> 保真渲染页已生成，但本地服务没起来或没返回可用地址（**目录不存在：`…\Temp\slime-lo-5pytap`**）。

### 根因

```ts
const built = writePdfViewerPage(conv.dir, conv.pdfPath, abs, title);  // ← conv.dir = 临时目录
cleanupConvertDir(conv.dir);                                            // ← 紧接着把它删了
return { ok: true, dir: built.dir, ... };                               // ← 渲染层要 serve 它的 dir
```

`writePdfViewerPage(rootDir,…)` 的 **`rootDir` 同时就是返回值里的 `dir`**（渲染层据此去 `http.serve`）。
⇒ 把临时目录当 `rootDir` = **把页面写在马上要删的目录里** ⇒ 服务报「目录不存在」⇒ 只剩重排。

### ⚠️⚠️ 关键：**旧代码也是这么传的，它"能用"是靠泄漏在续命**

旧实现 `return` 了 `convertDir` 给渲染层"让它删"，而**渲染层从不消费它** ⇒ 临时目录**从来没被删**
⇒ 页面侥幸一直活着。§1 把那个泄漏修掉，就等于**把这根拐杖抽走了**。
⇒ 正解不是回退泄漏，而是**把页面写进持久目录**（与 `writeRenderPage` 分支一致）：
`rootDir = join(app.getPath("userData"), "doc-render")`。

### ⚠️ 为什么上一轮的守卫没抓住它（**锚对象错**，铁律 3）

那条守卫的锚点正是 `writePdfViewerPage(conv.dir` —— **锚在了 bug 那个写法上**
⇒ 只要那行还在，守卫就是绿的。**教训：锚点必须锚"不变量"（rootDir 必须是持久目录），
不能锚"当前这行长什么样"。**

### 现在的判据
- 守卫：`writePdfViewerPage` 的第一实参**不许**匹配 `conv.dir`，且必须是 `pageRoot`（= `doc-render`）。
- **行为级探针**（`probe-pdf-webview.mjs` ②b，**含反例**）：
  - 正例：`rootDir` 传持久目录 ⇒ 删掉临时目录后**页面仍在**；
  - **反例**：`rootDir` 传临时目录 ⇒ 删掉后**页面确实一起没了** ⇒ 复现"服务起不来"。
  ⚠️ 反例**必须真的失败**，否则说明判据没测到点子上。

## 9. 09-30 第四轮：`.doc` 空白 + 「无法打开 chrome-extension:// 链接」；以及加载速度

### 9.1 症状
用户截图（`.ppt` 已能完美渲染，`.doc` 不行）：
- 弹窗：**「无法打开 chrome-extension:// 链接——系统未注册该协议」**，
  地址是 `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/…`；
- 查看器**只有半截工具栏 + 一片灰底**（对比 `.ppt` 那页有 `4 / 137`、缩放、下载/打印）。

### 9.2 两处修改（依据 = **用户截图里那个弹窗**，不是我的推断）
`mhjfbmdgcfjbbpaeojofohoefgiehjai` **就是 Chromium 的 PDF 查看器扩展 ID** ⇒ 那个弹窗是
`shell.openExternal("chrome-extension://…")` 被调用的**直接证据**。据此：

1. **`isWebSafeUrl` 放行 `chrome-extension`**：查看器住在该协议下，若白名单不认它，
   `will-frame-navigate` 会 `preventDefault()` **掐断查看器自身的导航**（⇒ 空白）+ 甩给系统（⇒ 弹窗）。
2. **`openExternalSafe` 在"问系统"之前就拒掉 Chromium 内部协议**（`isChromiumInternalScheme`：
   `chrome` / `chrome-extension` / `devtools` / `view-source`）—— 它们在 OS 里**永远没有处理器**，
   探测后再 `openExternal` 只会弹系统框（与该函数自己注释承诺的"绝不弹系统框"正好相反）。

### 9.3 ⚠️ 诚实交代：这条根因**没有被我的探针证实**
我写了 A/B（旧白名单 vs 新白名单，守卫装在 **guest** 上）想证明它，结果**两路都是 `blocked=0`**
⇒ 在我这个探针会话里**那条 frame 导航压根没发生**，所以这组对照**不构成**"白名单是根因"的证据。
（第一次装错对象：守卫装在了**宿主窗口**上，而 PDF 查看器的 frame 导航发生在 **guest** 里 ⇒ 看不到。
 修了之后仍然 `blocked=0`。）
⇒ 探针里已把这段写成**信息**而不是判据，并在断言里留了一句"本探针未能复现"。

### 9.4 加固：查看器页改成**自己取字节 → blob → 失败可见**
```html
fetch(pdf) → blob: URL → <embed src=blob>      // 旧写法是 <embed src="服务器 URL">
```
为什么值得改（即使根因未证实）：
- 取数不再穿过**独立 session（`persist:slime-browser`）+ 导航守卫 + 下载闸门**那条长链；
- **失败会说话**：`fetch` 不 ok 就把 HTTP 状态与地址写在页面上 ——
  "空白且一个字都不说"这种状态本身就是前四轮反复卡住的根源。
（探针验证：改完后 PDF 仍正常渲染，白纸占比 64.1%。）

### 9.5 加载速度（用户：「老版每次都要加载半天」）
| 优化 | 内容 | 实测 |
| --- | --- | --- |
| **老格式缓存短路** | 页面与 PDF 副本本来就**持久**落在 `doc-render/<sub>/`；目录名含**内容指纹**（路径+大小+mtime）⇒ 命中即直接返回，**跳过 LibreOffice** | 第 2 次打开从 **10~16s → 瞬时** |
| **LibreOffice profile 常驻** | 原先每次 `join(新临时目录,"profile")` ⇒ LO 每次重建 profile；改常驻后 | 同一 .doc：3534ms → **1729ms**（约 2 倍） |
| **转换串行化** | 共享 profile ⇒ 不能并发（会撞单实例锁）⇒ 队列串行；⚠️ 队列尾用 `then(ok, err)` **两个回调都推进**，否则一次 reject 会永久卡死整条队列 | — |
| **`writeRenderPage` 快路径** | 目录名已含指纹 ⇒ 页面/源副本/库文件都在位就直接返回；⚠️ **带 `notice` 的不走**（否则显示过期的降级理由） | 新版格式省掉重复写盘 |

⚠️ **用户那句「不留文件」仍然成立**：删的是**转换临时目录**；`doc-render/<sub>/` 里放的是**渲染页**
（与新版格式一直的做法一致，且是"命中缓存"能被实现的前提）。

### 9.6 ⚠️ 一个非显然的自伤：Python 文本模式把脚本写成了 CRLF
我用 `io.open(p,"w")` 批量改文件 ⇒ Windows 上默认把 `\n` 翻成 `\r\n`，把 `mut-a1136-render.mjs`
写成了 **CRLF**。而 `check-mut-anchors.mjs` 的静态切分是 `src.split(/\n\s*\{\n/)` ——
**CRLF 下 `{` 后面是 `\r`，于是"静态切出 0 条"**，报"无法核验序号"。
⚠️ 这个坑的隐蔽处：`tsc` 不报、锚点核验（单条）也不报，只在"位置 ↔ name 序号"那一项上炸。
⇒ 用 Python 改文件一律 `open(p,"rb")/open(p,"wb")` 或 `newline=""`；改完**跑一次全量锚点核验**。

## 10. 09-30 第五轮：HTML 应当**原生渲染**、Excel 应当**贴合原几何**

### 10.1 HTML 文件"反倒无法显示"（用户实测：看到的是**源码**）
根因：`planRender(".html")` 一直被归成 `text-html`（抽文本 → 结构重排）⇒ 页面里显示的是
`<!doctype html>` 那一堆**源码**。
⚠️ 而 `openWebPreview`（拖入时走的那条路）**本来是对的**（服务文件所在目录、直接打开它）——
只是**换个入口**（附件卡 / 文件浏览器）就退化成源码了 ⇒ 症状"时好时坏"。
**修法**：新增渲染路线 `html-native`（`faithful: true`），由主进程
**服务文件所在目录 + 用原文件名**打开它。
⚠️ 关键：**不能拷进 `doc-render` 再服务** —— 那会丢掉同目录的兄弟资源（css/js/图片）⇒ 页面残缺。

### 10.2 Excel「太粗糙」（用户实测：缩在屏幕中间一小块）
两个原因叠加：
1. **`#stage` 是 flex 居中**（⑬ 为幻灯片/纸张定的）⇒ 表格被放在屏幕中央；
2. **`XLSX.utils.sheet_to_html` 只吐裸 table**：无列宽（`!cols.wch`）、无行高（`!rows.hpx`）、
   合并单元格不带 rowspan/colspan、数字格式也不套。

**修法**：
- 自建表格：按 `!ref` / `!cols`（`<colgroup>` 定宽）/ `!rows`（行高）/ `!merges`（rowspan/colspan）/
  `format_cell`（数字格式）渲染；
- 新增 `data-mode="sheet"` ⇒ `#stage` 改成**左上对齐 + 拉满宽**（其它模式仍保持居中）；
- `.sheet-box` 白底、`table-layout:fixed`、单元格网格线。

⚠️ **能还原的是"几何"**（列宽/行高/合并/数字格式）；**配色不保证** ——
单元格填充色/字体属于"样式"，SheetJS 社区版默认不读。**不在文案里承诺还原颜色。**

**真机验收**（`probe-render-adapt.mjs`，4 个宽度 × 3 个样本）：
- `.pptx` / `.docx`：**垂直居中保持**（⑬ 的判据没被破坏）；
- `.xlsx`：**4 个宽度全部「左上铺开（顶距 14px）」** —— 正是用户要的。
⚠️ 该探针原来把 xlsx 当"单屏要居中"来验收（因为它是唯一单屏样本）——**那条判据现在是错的**，
已按"每样本各自的版式期望"改（sheet 走左上铺开、其余走居中）。

### 10.3 又踩/又同步的两条
- **改源码形状 → 必须同步变异锚点**：`html-native` 分支插进 `planRender` 与 `!plan.faithful` 之间
  ⇒ M11 的锚点漂移（已改锚"那句闸门表达式本身"）。
- **既有守卫会拦"有意替换"**：`a1136-render-page.spec.ts` ⑤ 原来断言 xlsx **含** `sheet_to_html`，
  而我正是要**去掉**它 ⇒ 基线变红。已把该守卫**反过来**（`not.toContain("sheet_to_html")` + 新几何判据），
  并在注释里写明"这条是故意反过来的，因为那个 API 正是粗糙的来源"。
  ⚠️ **基线不绿时，整轮变异判读作废**（本轮真发生过一次：基线 1 红、54 条全"红" = 无效结论）。

## 11. 09-30 第六轮：附件卡片**可点击预览**

用户实测：「像下面这样的卡片，我希望可以点击在右边预览，现状是**只能看不能点**，有点鸡肋；
拖进去后，右边的侧边栏页关了后就点不开了，再想开就只能再拖一遍。」

### 根因
附件卡是**没有 `onClick`、没有 pointer 光标**的 `<span>`/`<div>`；而"打开预览"这件事**只有拖入那一条入口**
（`ChatPanel` 的 drop → `requestSidebarOpen({kind:"doc", rel: 绝对路径})`）⇒
右栏页签一关，就没有第二条路能再打开它。

### 修法（**复用同一条路由**，不另写判据）
新增**模块级**唯一产地 `openDocInSidebar(path, name)`（`ChatPanel.tsx`），内容就是拖入那条路发的那个事件：
```ts
requestSidebarOpen({ kind: "doc", rel: <绝对路径>, name, from: "user" })
```
并挂到**两处**卡片：
- **输入区待发卡**（截图里那个）—— 卡身可点、`role=button` + Enter/Space 键盘可达；
- **已发送气泡卡** —— 同样可点。

⚠️ 为什么必须是**模块级函数**：卡片有两处，而"已发送气泡卡"在**另一个组件**里
⇒ 写成组件内 handler 会拿不到作用域（实测 `tsc` 直接报 `Cannot find name`），
而**写两遍**又会让"点击语义"出现第二个产地（铁律 11）。
⚠️ 待发卡的 `×`（移除）必须 `stopPropagation` —— 否则点"移除"会**顺带把预览打开**。
⚠️ 顺带确认过链路上两件事都成立（**读源码确认，不是猜**）：
- 右栏 `openBrowserTab` 按 **URL 去重** ⇒ 重复点同一文件**不会**开一堆重复页；
- `App` 收到 `SIDEBAR_OPEN_EVENT` 会 `setRightOpen(true)` ⇒ **侧栏收起时点一下会自动展开**。

判据：守卫 3 条（唯一产地 / **两处**都挂了 onClick + 键盘可达 / `×` 有 stopPropagation）+ 变异 **M55/M56**。

## 12. 09-30 第七轮：附件上限 + **能力审计**（web 构建 / Office 读写生成）

### 12.1 附件上限 4 → 32（文档）、4 → 8（图片）
用户原话：「为什么现在最多只能载入 4 个文件啊？能不能大幅上调一下这个数字。」

**根因**：上限是**散在 4 处的字面量** `slice(-4)`（`appendImageFiles` / `pick` / 文档 drop 三处 + 界面分母 `{n}/4`）
⇒ 不是"只能 4 个"这个设计，而是**一个没人改的数字**。

**改法**：抽成两条**具名常量**（唯一产地）+ 界面分母跟着常量走。
⚠️ **文档和图片刻意不同量级**，这不是漏改：
- `MAX_PENDING_DOCS = 32` —— 文档只带一条**磁盘路径**（几十字节，进消息文本），界面与上下文成本都极低；
- `MAX_PENDING_IMAGES = 8` —— 每张图是 **data URL**：既常驻内存（单张上限 8MB），
  又会**整张进模型上下文**（base64 再膨胀约 1/3）。把它放到 32 会直接把上下文和内存吃掉。

### 12.2 能力审计（**结论都有证据**）

| 能力 | 审计前 | 证据 | 处置 |
| --- | --- | --- | --- |
| **Web 文件构建** | ✅ **完备且强** | `http_create_app` 支持 `files:[{path,content}]` **任意多文件**（HTML/CSS/JS/JSON/子目录）、写 `index.html` 入口、自动起服务并在右栏打开；另有 `file_write` / `http_serve` / `http_stop` / `http_list` | 无需改动 |
| **Office 读取** | ✅ 有 | `file_read` → `doc_text.ts`（docx 段落+表格 / pptx 按页 / xlsx 按表） | 无需改动 |
| **Office 从零生成** | ❌ **断链** | `writeDocument()` 早实现且有完整 round-trip 测试；IPC `slime:docs:create` 也接好了 —— 但**没有任何 Agent 工具包装它**（`docs_create` 通道只有声明、**零消费者**，`gui/src/shared/ipc.ts:32` 是唯一出现处） | **本轮接上**（见下） |
| **Office 就地修改** | ❌ 无 | 只有覆盖式生成（`WriteSpec = path/format/title/body`），**没有**"改已有文档某段"的能力 | **如实留作欠账**（见下） |

### 12.3 新增 Agent 工具 `docs_create`（把断链接上）

`core-ts/src/tools/builtin.ts` 新增工具，包装现成的 `office/docWrite.ts::writeDocument()`：
按 `path` **扩展名**决定格式（`.docx/.xlsx/.pptx/.pdf/.csv/.md/.txt`），`body` 用纯文本表达结构
（docx：`#`/`##`/`-`；xlsx：TSV；pptx：`---` 分页）。

⚠️ **边界与 `fileWrite` 完全同一套**（新工具**绝不是绕过沙箱的口子**）：
项目根 / 工作目录内 + 符号链接拒绝 + 敏感路径黑名单，全走同一条 `resolveInProject`。
⚠️ **只创建新文件**，目标已存在就拒绝 —— `docWrite` 的产物是**二进制**，而"改动账本"
（`recordFileChange`）记的是**字符串**旧内容 ⇒ 允许覆盖会造出「能回滚、但回滚出来是个坏文件」的**假承诺**，
比"不支持回滚"更坏。文本格式要覆盖请走 `file_write`（它本来就有账本与 diff）。

**端到端判据**（新 spec `tests/core-ts/a1136-docs-create.spec.ts`）：
- 工具**在工具面里**（这是本轮的修复本身）；
- `.docx/.xlsx/.pptx` 生成 → **真 ZIP 容器**（`PK` magic）+ **能被自己的读取链读回内容**；
- 覆盖被拒且**磁盘一字节没变**（不只是回执说拒绝）；
- 未知扩展名如实拒绝并列出可用格式。

⚠️ **顺带被既有守卫抓到一次**：`a1091-ui-guards.spec.ts` T1「每个已注册工具都必须有中文标签 + 图标」
—— 我加了工具却没登记 `TOOL_LABELS` ⇒ 会静默退化成「⚡ docs_create」。已补
（`docs_create: { label: "生成 Office 文档", Icon: NotesIcon }`）。
**加工具必须同步登记标签**，这条守卫就是为此而设。

### 12.4 ⚠️ 留作欠账：Office **就地修改**
"改一份已有 docx 的某一段"需要 **OOXML 局部改写**（解包 → 定位部件 → 改 XML → 重打包 →
保持关系/内容类型自洽），并且必须带**二进制回滚**（`recordFileChange` 现在只收字符串，要扩成 Buffer）。
这是一块**独立的、有风险的**工作，**不在本轮草率半做**（半做出来的"能改但会悄悄丢格式"比不支持更坏）。

**当前可用的替代路径（是真的能用，但要说清它是什么）**：
`file_read` 读出全文 → 用户提改动 → `docs_create` 写到**新路径**（**重新生成**，不是就地编辑）。
