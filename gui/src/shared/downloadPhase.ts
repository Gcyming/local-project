





















export type DownloadPhase = "download" | "extract" | "config" | "done";


const LABELS: Record<DownloadPhase, string> = {
  download: "下载中",
  extract: "解压中",
  config: "配置中",
  done: "已完成",
};


export const UNKNOWN_PHASE_LABEL = "处理中";


export function phaseLabel(phase: string | undefined | null): string {
  if (phase && Object.prototype.hasOwnProperty.call(LABELS, phase)) {
    return LABELS[phase as DownloadPhase];
  }
  return UNKNOWN_PHASE_LABEL;
}


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









export function extractPercent(p: ExtractProgressLike): number {
  if (p.totalBytes > 0) {
    return clampPercent((p.bytes / p.totalBytes) * 100);
  }
  if (p.total > 0) {
    return clampPercent((p.files / p.total) * 100);
  }
  return 0;
}


export function extractDetail(p: ExtractProgressLike): string {
  if (!(p.total > 0)) { return ""; }
  return `${p.files}/${p.total} 个文件`;
}


export function formatMB(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${Math.round((b / 1024 / 1024) * 10) / 10} MB`;
}


export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) { return ""; }
  const mb = bytesPerSecond / 1024 / 1024;
  if (mb >= 1) { return `${Math.round(mb * 10) / 10} MB/s`; }
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}
