



















































export const FOLLOW_RELEASE_PX = 48;

export const FOLLOW_RESUME_PX = 8;

export interface ScrollMetrics {
  
  top: number;
  scrollHeight: number;
  clientHeight: number;
  
  following: boolean;
}















export function decideFollow(m: ScrollMetrics): boolean {
  const gap = m.scrollHeight - m.top - m.clientHeight;
  if (gap <= FOLLOW_RESUME_PX) { return true; }
  if (gap > FOLLOW_RELEASE_PX) { return false; }
  return m.following;
}


export interface ScrollBox {
  scrollHeight: number;
  clientHeight: number;
  
  overflowY: string;
}







export function hasInnerScroller(ancestors: readonly ScrollBox[]): boolean {
  return ancestors.some(
    (a) => a.scrollHeight > a.clientHeight + 1 && (a.overflowY === "auto" || a.overflowY === "scroll"),
  );
}
