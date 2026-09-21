/**
 * gui/src/shared/downloadPhase.ts — 下载/解压阶段进度的**唯一实现**（A-1038）。
 *
 * **为什么要有这个文件**：此前「进度」只有一根下载条，解压阶段**完全没有出口** ——
 * 用户看到条子冲到 100% 然后界面僵住几十秒（llama.cpp 的 win-cuda 包解压要写上千个文件），
 * 期间零反馈，只能怀疑卡死。加上安装包安装期的纯干等，用户的原话是「啥都不显示，纯干等」。
 *
 * 于是把「阶段 → 文案 / 百分比」的判据集中到一处：
 * - 主进程（downloader / updater / adb）负责**产生**事实（phase + 计数），
 * - 渲染层只把 `phase` 映射成文案，**不允许**在 `.tsx` 里另写一套 if/else 判据
 *   （否则三处 UI 各写一份，改一处漏两处 —— 本项目在展开/收起与状态徽标上已吃过两次亏）。
 *
 * 本模块是**纯函数**，不碰 fs / electron，可直接单测与变异。
 */

/**
 * 阶段枚举。
 * - `download`：网络传输中（百分比 = 已收字节 / 总字节，总字节可能未知 → 0）
 * - `extract`：解压中（百分比 = 已写字节 / 中央目录声明总字节）
 * - `config`：写配置（解压完到可用之间的收尾，通常一两百毫秒）
 * - `done`：全部完成
 */
export type DownloadPhase = "download" | "extract" | "config" | "done";

/** 阶段显示名。**这是唯一出处**，UI 不得自造同义词。 */
const LABELS: Record<DownloadPhase, string> = {
  download: "下载中",
  extract: "解压中",
  config: "配置中",
  done: "已完成",
};

/** 未识别/缺省阶段的兜底文案（老快照没有 phase 字段时会走到这里）。 */
export const UNKNOWN_PHASE_LABEL = "处理中";

/** 阶段 → 中文文案。未知值兜底为「处理中」，绝不回显英文枚举名。 */
export function phaseLabel(phase: string | undefined | null): string {
  if (phase && Object.prototype.hasOwnProperty.call(LABELS, phase)) {
    return LABELS[phase as DownloadPhase];
  }
  return UNKNOWN_PHASE_LABEL;
}

/** 百分比归一到 [0,100] 整数；NaN / 负数 / 无穷 → 0。 */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) { return 0; }
  return Math.max(0, Math.min(100, Math.round(n)));
}

export interface ExtractProgressLike {
  files: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

/**
 * 解压百分比。**优先字节口径**，无字节信息才退回文件数口径。
 *
 * 为什么字节优先：llama.cpp 的包是「几个几百 MB 的 DLL + 上千个小文件」，
 * 按文件数算会在最后一个大 DLL 上钉住不动（1/1000 的位移都没有），观感等同卡死；
 * 按字节算才是真实工作量。反过来，纯 stored / 尺寸未知的包 `totalBytes` 为 0，
 * 此时文件数口径仍然可用 —— 两条口径**必须都留着**，且判据只能在这里。
 */
export function extractPercent(p: ExtractProgressLike): number {
  if (p.totalBytes > 0) {
    return clampPercent((p.bytes / p.totalBytes) * 100);
  }
  if (p.total > 0) {
    return clampPercent((p.files / p.total) * 100);
  }
  return 0;
}

/** 解压明细文案（"128/305 个文件"）；无条目时返回空串（UI 负责不渲染空括号）。 */
export function extractDetail(p: ExtractProgressLike): string {
  if (!(p.total > 0)) { return ""; }
  return `${p.files}/${p.total} 个文件`;
}

/** 字节 → "12.3 MB"（下载/更新进度展示用；负数与 NaN 视为 0）。 */
export function formatMB(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${Math.round((b / 1024 / 1024) * 10) / 10} MB`;
}

/** 速率 → "1.2 MB/s"；未知（<=0 / NaN）返回空串，UI 不渲染占位。 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) { return ""; }
  const mb = bytesPerSecond / 1024 / 1024;
  if (mb >= 1) { return `${Math.round(mb * 10) / 10} MB/s`; }
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}
