/**
 * core-ts/src/office/libreoffice.ts — 「本机有没有 LibreOffice」的**唯一产地**。
 *
 * ## 为什么需要它（阶段 C，2026-09-29 用户已定方向）
 * `.ppt/.doc/.xls` 是 OLE2 二进制，**纯 JS 渲染普遍不可靠**（见 `docs/research/office-preview-2026-09-28.md`）。
 * 业界可靠路线 = **LibreOffice headless 转 PDF**，再交给已经有的 PDF 查看器画。
 * 但 LibreOffice 是**约 350MB 的外部依赖**，用户选定「**先探测本机已有的，缺了再提示下载**」
 * （不随包分发）。⇒ 必须有且只有一个地方回答「这台机器上能不能用」。
 *
 * ## 为什么放在 core-ts（而不是 gui/src/main）
 * ① **纯逻辑**（候选路径表 + 结果解析）可以脱离 Electron 单测 —— 探测本体不能测（要真装 350MB），
 *    但"给哪些候选路径"「怎么判版本号」「找不到时的提示文案」全是纯函数，值得守；
 * ② 判断依据（`needs: "libreoffice"`）来自 `renderPlan.ts`（同目录）——两者必须住在一起才不会漂。
 *
 * ## 分层（谁负责什么，别混）
 * - **本模块**：只知道"文件系统里哪个路径像 soffice" + "怎么解析版本号" + "怎么说给用户听"。
 *   **绝不 spawn 进程**（那需要 node:child_process，会把 core-ts 拖进平台细节，也难单测）。
 * - **调用方**（`gui/src/main`）：用 `spawn` 真跑一次 `--version` 拿版本、跑 `--convert-to pdf` 真转换。
 *   `spawn` 一律带超时、绝不用 `spawnSync`（本仓铁律 26：阻塞事件循环）。
 *
 * ## 扩展名 → 要转成什么
 * `.doc/.docx` → `pdf`（Writer）、`.xls/.xlsx` → `pdf`（Calc）、`.ppt/.pptx` → `pdf`（Impress）。
 * LibreOffice 的 `--convert-to pdf` 会按扩展名自己选过滤器，调用方不需要指 filter。
 * ⚠️ 但**必须**加 `--headless --norestore --nolockcheck --nodefault --nologo`：
 *    否则首次运行会弹"文档恢复/欢迎页"窗口，在无 GUI 的调用里直接挂住（实测过）。
 */

/** 探测结果。**永远是"值"不是"抛异常"** —— 调用方要能把它直接讲给用户听。 */
export type LibreOfficeProbe = {
  /** 本机是否找得到可用的 soffice 可执行文件 */
  found: boolean;
  /** 找到时的绝对路径（未找到为 ""） */
  path: string;
  /**
   * 版本号（如 `"7.6.4.1"`）。⚠️ 只有**真跑过 `--version`** 才有；
   * 仅凭路径存在推断出来的探测结果，`version` 一定是 `""` —— 不许编一个出来。
   */
  version: string;
  /** 找不到时给用户看的**可操作**提示（含下载地址）；找到时为 "" */
  hint: string;
};

/** 各平台常见安装位置（**顺序即优先级**：先本机已装的，再兼容性发行版的）。 */
const CANDIDATES: Record<string, readonly string[]> = {
  win32: [
    /* ⚠️⚠️ Windows 上**必须优先用 `soffice.com`（控制台版），不是 `soffice.exe`**（2026-09-30 实测定位）。
       `.exe` 是 **GUI 子系统** 程序：它**压根不往 stdout 写**，`spawn`/`execFile` 收不到任何输出；
       而且启动器会**一直等 GUI 进程**。实测 `soffice.exe --version` 挂死 20~25s、零输出，
       **加 `--headless` 也一样挂**。后果最坏：探测超时 ⇒ 被判"没装" ⇒ 给用户弹下载提示，
       而用户其实**装得好好的**（这次就是这样：用户装了 LO，却被提示去下载，于是"老文件看不了"）。
       `.com` 是同一安装目录里的**控制台**版本：`--version` 0.28s 返回，`--convert-to pdf` 正常出产物。
       ⇒ 每条候选**先 `.com`、再 `.exe`**（`.exe` 只作 `.com` 不存在时的兜底；转换用法下 `.exe` 是能出产物的）。 */
    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice Still\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice 7\\program\\soffice.com",
    /* 部分系统装的是 LibreOffice **Still**（版本号带 `LibreOffice N` 前缀的老安装器），
       以及 Windows Store 版；这几处是实测见过的分布，别删。 */
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files\\LibreOffice Still\\program\\soffice.exe",
    "C:\\Program Files\\LibreOffice 7\\program\\soffice.exe",
  ],
  darwin: [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice.bin",
  ],
  linux: [
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/snap/bin/libreoffice",       // snap 安装
    "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",  // flatpak 安装
  ],
};

/**
 * 环境变量覆盖名（**给用户留的逃生门**）。
 * 场景：她把 LibreOffice 装在非标准位置（便携版 / D 盘 / 网络盘），或同时装了多个版本要指定一个。
 * ⚠️ 覆盖值**优先于所有内置候选**：用户显式指定的永远赢（否则这个变量没有意义）。
 */
export const LO_PATH_ENV = ["SLIME_LIBREOFFICE_PATH", "LIBREOFFICE_PATH"] as const;

/** 探测结果里给用户的那句话（**一处产地**：文案漂了就等于"提示"本身失效）。 */
export const LO_DOWNLOAD_HINT = [
  "本机没有找到 LibreOffice，老版 Office 文件（.doc/.xls/.ppt）暂时无法原样预览。",
  "装一个即可（装完重开应用，无需其他配置）：https://www.libreoffice.org/download/download-libreoffice/",
  "现有文件仍可正常阅读与编辑（应用会自动改用文本方式提取内容）。",
].join("");

/** 找不到时的标准结果（**唯一构造点**，避免各调用方各写一份表述）。 */
export function notFound(): LibreOfficeProbe {
  return { found: false, path: "", version: "", hint: LO_DOWNLOAD_HINT };
}

/**
 * 「这条路径看起来像不像 LibreOffice 本体」——**纯字符串判据**（不碰 fs）。
 *
 * 判据（白名单，故意保守 —— 不许 `startsWith` 裸匹配，否则目录/旁路文件也会混进来）：
 *  ① `soffice`（Unix 无扩展名脚本）
 *  ② `soffice.com` —— ⚠️ **Windows 上的正解**：控制台版，`--version` 0.28s、`--convert-to` 正常出产物
 *  ③ `soffice.exe` / `soffice.bin` —— 兜底；⚠️ `.exe` 是 **GUI 子系统**程序，**不往控制台写、`--version` 会挂死**
 *     （实测 20~25s 零输出，加 `--headless` 无关）⇒ 能选 `.com` 就选 `.com`（见 `consoleVariantOf`）
 *  ④ `libreoffice` / `libreoffice.exe`（Debian 系别名）
 *
 * ⚠️⚠️ **本函数曾把 `.com` 注释成「GUI 启动壳、headless 下不可靠」——完全说反了**
 *    （`09-30` 实测纠正）。这条错误注释很可能正是当初候选表优先选 `.exe` 的源头，
 *    并直接导致"用户装了 LibreOffice 却被判定没装"。**注释也是断言，写错会把人引到反方向。**
 *
 * 为什么需要它：`SLIME_LIBREOFFICE_PATH` 是用户手填的，最容易被填成
 * 「`C:\Program Files\LibreOffice\program`」（目录，不是文件）或 «快捷方式»。
 * 这里挡住明显不像的，调用方再 `existsSync` + 真跑 `--version` 兜第二层。
 */
export function looksLikeSoffice(p: string): boolean {
  const base = (p ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base) { return false; }
  const lower = base.toLowerCase();
  if (lower === "soffice.exe" || lower === "soffice.bin" || lower === "soffice" || lower === "soffice.com") { return true; }
  /* `libreoffice` 是 Debian 系发行版给的 shell 包装脚本（**无扩展名**）。
     ⚠️⚠️ 但它**只在 Unix 成立** —— 这条判据是 2026-09-29 由守卫 `a1136-stage-c` 抓出的真 bug：
     若裸放行 `lower === "libreoffice"`，则 Windows 上的**目录** `C:\Program Files\LibreOffice`
     会被算作"像本体"（basename 小写后正好是 `libreoffice`）⇒ 用户把环境变量填成目录时
     瞒过这道闸门，调用方拿目录去 `spawn` ⇒ 报一个令人困惑的 spawn 错，
     而原意是要给"路径填错了，请指向可执行文件"的清晰提示（与本函数注释里的承诺一致）。
     正解：`libreoffice` 别名**必须带 `.exe`** 才算 Windows 本体；无扩展名的才认（Unix 脚本）。
     额外好处：`C:\Program Files\LibreOffice` 这种**目录**（无扩展名、但不是脚本）也被挡住。 */
  if (lower === "libreoffice.exe") { return true; }
  if (lower === "libreoffice" && !/^[a-z]:\//i.test(p.replace(/\\/g, "/"))) { return true; }
  return false;
}

/**
 * Windows 专用：把 `...\soffice.exe` 映射到同目录的 `...\soffice.com`（**纯字符串，不碰 fs**）。
 *
 * ## 为什么需要它（2026-09-30 实测踩到）
 * 用户手动把 `SLIME_LIBREOFFICE_PATH` 指向 `soffice.exe` 是最**自然**的填法（资源管理器里就那个图标），
 * 而 `.exe` 是 GUI 子系统程序：**不往控制台写、且会挂住**（实测 `--version` 挂死 20~25s，加 `--headless` 无关）。
 * 若不放行这一步，用户"明明填对了路径"却依然被判不可用 —— 比不填还让人困惑。
 * ⇒ 探测时先看 `.com` 兄弟在不在：在就**换成 `.com`**；`null` 表示"这条不是 `.exe`，无需映射"。
 *
 * ⚠️ 只做字符串映射，**存在性由调用方查**（本模块是纯逻辑，不许碰 fs）。
 */
export function consoleVariantOf(p: string): string | null {
  const s = p ?? "";
  const base = s.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base.toLowerCase() !== "soffice.exe") { return null; }
  /* ⚠️ 只换结尾的文件名，**保留原分隔符风格**（`C:\a\soffice.exe` → `C:\a\soffice.com`）。
     别整个规范化成 `/`：这条路径会显示在设置页给用户看（`RuntimePanel` 的"路径"），
     Windows 用户看到 `C:/Program Files/…` 会以为自己填错了。 */
  return s.slice(0, s.length - base.length) + "soffice.com";
}

/**
 * 从 `soffice --version` 的**输出**里抠版本号（纯函数，可单测）。
 *
 * 实测输出形如（各版本略有差异，故用宽松匹配）：
 * ```
 * LibreOffice 7.6.4.1 639b8ac485750d569b4b5aba30b0d0a6f2e0b8a0
 * LibreOffice 24.2.5.2 (X86_64) ...
 * ```
 * ⚠️ 抠不到就返回 `""`（**不许**编一个 `"unknown"` 之类的假值 ——
 * 调用方要靠"空串 = 没真跑过"这个语义区分"找到了"与"验证过"）。
 */
export function parseVersion(stdout: string): string {
  const m = /LibreOffice\s+([0-9][0-9._]*)/i.exec(stdout ?? "");
  if (!m) { return ""; }
  return m[1].replace(/\.+$/, "");
}

/** 按平台给内置候选（导出便于单测：**守住"清单里有 _这个_ 路径"**，而不是守 fs）。 */
export function candidatesFor(platform: NodeJS.Platform | string): readonly string[] {
  /* ⚠️ `win32` 之外的 Windows 面孔不该出现；未知平台返回空数组而不是抛错 ——
     调用方（探测）拿空清单 = 找不到 = 走"如实提示下载"，比崩掉好。 */
  return CANDIDATES[platform] ?? [];
}

/**
 * 汇总「候选路径」与「环境变量覆盖」的**优先级清单**（纯函数，不碰 fs）。
 * 顺序 = 用户覆盖 > 平台内置候选；**同一条路径只留第一次出现的**（去重保序）。
 */
export function probeSearchList(platform: NodeJS.Platform | string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | undefined): void => {
    const v = (p ?? "").trim();
    if (!v || !looksLikeSoffice(v)) { return; }
    const k = v.toLowerCase();
    if (seen.has(k)) { return; }
    seen.add(k);
    out.push(v);
  };
  for (const name of LO_PATH_ENV) { push(env[name]); }
  for (const p of candidatesFor(platform)) { push(p); }
  return out;
}
