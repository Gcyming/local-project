





























export const STREAM_CURSOR_IDLE_MS = 1200;













export function shouldShowStreamCursor(
  now: number,
  lastEmitAt: number,
  idleMs: number = STREAM_CURSOR_IDLE_MS,
): boolean {
  if (!Number.isFinite(lastEmitAt) || lastEmitAt <= 0) { return false; }
  if (!Number.isFinite(idleMs) || idleMs <= 0) { return false; }
  return now - lastEmitAt < idleMs;
}
