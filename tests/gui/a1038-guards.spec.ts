















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
    
    expect(src).toContain('task.phase = "extract";');
    
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
    
    expect(src).not.toContain("task.received % (CHUNK * 16) === 0");
    
    expect(src).toContain("task.received = start;");
    expect(src).toContain("task.total = lenHeader > 0 ? start + lenHeader : 0;");
  });

  it("百分比口径唯一实现 currentPercent，不许散落三套", () => {
    const src = code(DL);
    expect(src).toContain("function currentPercent(t: Task): number");
    expect(src).toContain("percent: currentPercent(t),");
    
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
    
    
    const tarUses = src.match(/spawnSync\(\s*"tar"/g) ?? [];
    expect(tarUses.length).toBe(1);
    expect(src).not.toMatch(/\[\s*"-xf",\s*archive/);          
    expect(src).not.toMatch(/spawnSync\("tar",\s*args/);        
    
    const viaHelper = src.match(/extractArchiveTo\(/g) ?? [];
    expect(viaHelper.length).toBeGreaterThanOrEqual(3);          
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
    
    expect(src).toMatch(/onProgress\?\.\(\{[^}]*current: "" \}\)/);
  });

  it("「主进程卡死看门狗」的判据对得上：解压必须让出，否则会撞 A-984 的 2s 红线", () => {
    
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
    
    expect(adb).toContain("AdbDownloadProgress = AdbDownloadProgressInfo");
    const ipc = code("gui/src/shared/ipc.ts");
    expect(ipc).toContain("detail?: string;");
  });
});
