/**
 * A-1038 守卫：内部下载 / 解压的**实时进度**（阶段 + 百分比判据）。
 *
 * **用户原话**：「给 slime 的内部下载、解压等操作都加一个实时监测，返回监测进度的进度条」
 * 以及「优化一下安装包，现在的安装包安装的时候啥都不显示，用户纯干等」。
 *
 * 旧实现的两个窟窿（都能复现，且都属于"改回去不报错、只见用户抱怨"的静默失效）：
 *   ① **解压期零反馈**：`runTask` 在下载一完成就置 `state="done"` → 界面立刻把进度条撤掉，
 *      而 llama.cpp 的包此时才开始解压上千个文件（实测几十秒）→ 用户看到条子冲满、然后干等。
 *   ② **第二条下载几乎没有进度**：`downloadArchive` 触发的条件是
 *      `task.received % (CHUNK * 16) === 0`（恰好 1MB 整数倍），实际**几乎永不命中**；
 *      而它的 `received` 还沿用主包残留值 → 分母是别的文件的字节数，百分比一开始就是 100%。
 *
 * 百分比判据集中在 `gui/src/shared/downloadPhase.ts`（`currentPercent` / `extractPercent`），
 * 三处 UI 只做「phase → 文案」映射，不得各写一套 if/else。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  phaseLabel, clampPercent, extractPercent, extractDetail, formatMB, formatSpeed,
  UNKNOWN_PHASE_LABEL,
} from "../../gui/src/shared/downloadPhase.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("A-1038 ① 阶段判据（纯函数）", () => {
  it("phaseLabel：四个阶段各有中文名，未知值兜底不露英文枚举", () => {
    expect(phaseLabel("download")).toBe("下载中");
    expect(phaseLabel("extract")).toBe("解压中");
    expect(phaseLabel("config")).toBe("配置中");
    expect(phaseLabel("done")).toBe("已完成");
    for (const bad of [undefined, null, "", "webpack", "__proto__", "toString"]) {
      expect(phaseLabel(bad as string)).toBe(UNKNOWN_PHASE_LABEL);
    }
  });

  it("clampPercent：NaN / 负数 / 超 100 / 无穷 都被收进 [0,100]", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(37.6)).toBe(38);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("extractPercent：**字节口径优先**（按文件数算会在最后一个大 DLL 上钉住不动）", () => {
    // 10 个文件，9 个小的已写完、剩 1 个占 90% 体积 → 字节口径应显示 ~10%，而不是 90%
    const p = { files: 9, total: 10, bytes: 10, totalBytes: 100 };
    expect(extractPercent(p)).toBe(10);
  });

  it("extractPercent：无字节信息时退回文件数口径（两条口径都必须可用）", () => {
    expect(extractPercent({ files: 3, total: 4, bytes: 0, totalBytes: 0 })).toBe(75);
  });

  it("extractPercent：两者都无 → 0（不猜、不除以零）", () => {
    expect(extractPercent({ files: 0, total: 0, bytes: 0, totalBytes: 0 })).toBe(0);
  });

  it("extractDetail：无条目返回空串（UI 负责不渲染空括号）", () => {
    expect(extractDetail({ files: 2, total: 5, bytes: 0, totalBytes: 0 })).toBe("2/5 个文件");
    expect(extractDetail({ files: 0, total: 0, bytes: 0, totalBytes: 0 })).toBe("");
  });

  it("formatMB / formatSpeed：非法输入不产出 'NaN MB'", () => {
    expect(formatMB(1024 * 1024 * 1.25)).toBe("1.3 MB");
    expect(formatMB(Number.NaN)).toBe("0 MB");
    expect(formatMB(-1)).toBe("0 MB");
    expect(formatSpeed(2 * 1024 * 1024)).toBe("2 MB/s");
    expect(formatSpeed(Number.NaN)).toBe("");
    expect(formatSpeed(0)).toBe("");
  });
});

describe("A-1038 ② main/downloader.ts：阶段贯通（下载→解压→配置）", () => {
  const DL = "gui/src/main/downloader.ts";

  it("🐛 回归红线：下载完成**不得**立刻置 done（那是「条子撤掉、解压期干等」的成因）", () => {
    const src = code(DL);
    // 下载段收尾后的正确写法：先把 phase 推到 extract，收尾由各分支负责
    expect(src).toContain('task.phase = "extract";');
    // 坏写法：下载完直接 state = "done" 然后 return（旧实现）
    expect(src).not.toMatch(/task\.state = "done";\s*emit\(taskProgress\(task\)\);\s*if \(task\.target === "llama"\)/);
  });

  it("下载段收尾走 await finishLlama 并把失败如实上报（不再是 void 丢弃）", () => {
    const src = code(DL);
    expect(src).toContain("const fin = await finishLlama(task);");
    expect(src).toContain("task.state = \"error\";");
    expect(src).not.toMatch(/void finishLlama\(task\)/);
  });

  it("finishLlama 返回 { ok, error }，失败必须能被调用方看见", () => {
    const src = code(DL);
    expect(src).toMatch(/function finishLlama\(task: Task\): Promise<\{ ok: boolean; error\?: string \}>/);
  });

  it("解压/配置期必须有出口（phase extract → config）", () => {
    const src = code(DL);
    expect(src).toContain('task.phase = "config";');
  });

  it("🐛 回归红线：子归档下载不得沿用主包残留的 received / 触发式节流", () => {
    const src = code(DL);
    // 旧的死条件
    expect(src).not.toContain("task.received % (CHUNK * 16) === 0");
    // 子归档必须整体重置 received / total
    expect(src).toContain("task.received = start;");
    expect(src).toContain("task.total = lenHeader > 0 ? start + lenHeader : 0;");
  });

  it("百分比口径唯一实现 currentPercent，不许散落三套", () => {
    const src = code(DL);
    expect(src).toContain("function currentPercent(t: Task): number");
    expect(src).toContain("percent: currentPercent(t),");
    // 旧的行内三目写法不得复活
    expect(src).not.toContain("percent: t.total > 0 ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0");
  });

  it("解压进度来自 zip 层的逐条目回调（不是自己数文件）", () => {
    const src = code(DL);
    expect(src).toContain("extractPercent(p)");
    expect(src).toContain("extractDetail(p)");
    expect(src).toContain("EXTRACT_EMIT_MS");
  });

  it("解压压频窗口 ≈150ms（解压是 CPU/IO 密集，逐条推会把 IPC 打满）", () => {
    const src = code(DL);
    expect(src).toContain("const EXTRACT_EMIT_MS = 150;");
  });

  it("Windows 归档解压不再依赖外部 tar（A-1034 同类隐患，别在两条路径各犯一次）", () => {
    const src = code(DL);
    expect(src).toContain("extractZipTo");
    // tar 只允许出现在 .tar.gz 分支（Node 的 zlib 解不了 tar 容器），且必须带 -xzf。
    // 全仓**只此一处** —— 两个入口（finishLlama / tryRelocateDownloads）必须共用它。
    const tarUses = src.match(/spawnSync\(\s*"tar"/g) ?? [];
    expect(tarUses.length).toBe(1);
    expect(src).not.toMatch(/\[\s*"-xf",\s*archive/);          // 旧的 zip 走 tar 写法
    expect(src).not.toMatch(/spawnSync\("tar",\s*args/);        // 旧的 args 变量写法
    // 两个入口都必须走 extractArchiveTo
    const viaHelper = src.match(/extractArchiveTo\(/g) ?? [];
    expect(viaHelper.length).toBeGreaterThanOrEqual(3);          // 定义 1 + 调用 2
  });

  it("tar 失败必须讲明真实原因（含 spawn 失败），不许只回一句「解压失败」", () => {
    const src = code(DL);
    expect(src).toContain("NodeJS.ErrnoException");
    expect(src).toContain("spawnErr");
  });
});

describe("A-1038 ③ core-ts/zip.ts：解压进度 + 让出事件循环", () => {
  const ZIP = "core-ts/src/zip.ts";

  it("extractZipTo 是 async 且逐条目让出事件循环（否则主进程被独占，进度只在最后落地）", () => {
    const src = code(ZIP);
    expect(src).toMatch(/export async function extractZipTo\(/);
    expect(src).toContain("setImmediate(done)");
    expect(src).toContain("yieldEvery");
  });

  it("进度口径：total 含将被拒的条目，且末条为收尾信号", () => {
    const src = code(ZIP);
    expect(src).toContain("const planned = list.filter((e) => !e.isDir);");
    expect(src).toContain("processed += 1;");
    // 收尾信号
    expect(src).toMatch(/onProgress\?\.\(\{[^}]*current: "" \}\)/);
  });

  it("「主进程卡死看门狗」的判据对得上：解压必须让出，否则会撞 A-984 的 2s 红线", () => {
    // 结构性交叉断言：两条守卫说的是同一件事，这里显式串起来防漂移
    const zipless = code(ZIP).replace(/\s+/g, "");
    expect(zipless).toContain("awaitnewPromise<void>((done)=>{setImmediate(done);})");
  });
});

describe("A-1038 ④ 渲染层接线：阶段文案必须显示（不能只推不算）", () => {
  it("DownloadProgressInfo 带 phase / detail，供 UI 渲染", () => {
    const ipc = code("gui/src/shared/ipc.ts");
    expect(ipc).toContain("phase: DownloadPhase;");
    expect(ipc).toContain("detail: string;");
  });

  it("右栏下载进度条使用 phaseLabel（而不是只显示裸百分比）", () => {
    const rs = code("gui/src/renderer/pages/RightSidebar.tsx");
    expect(rs).toContain("phaseLabel(");
  });

  it("MindHub 下载控件同样使用 phaseLabel + detail", () => {
    const mh = code("gui/src/renderer/pages/MindHubPanel.tsx");
    expect(mh).toContain("phaseLabel(");
    expect(mh).toContain(".detail");
  });

  it("adb 下载/解压进度带上解压明细（downloadPlatformTools 不再只在开解压时推一次）", () => {
    const adb = code("gui/src/main/adb.ts");
    expect(adb).toContain("extractPercent(p)");
    expect(adb).toContain("extractDetail(p)");
    // 进度形状收敛到共享类型（此前在 preload 里被内联抄了 5 遍）
    expect(adb).toContain("AdbDownloadProgress = AdbDownloadProgressInfo");
    const ipc = code("gui/src/shared/ipc.ts");
    expect(ipc).toContain("detail?: string;");
  });
});
