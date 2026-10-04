








import { isBenignAbort } from "./browserErrors.js";


export type WebviewLike = { loadURL(url: string): unknown };
























export function safeLoadURL(wv: WebviewLike | null | undefined, url: string): void {
  if (!wv || !url || typeof wv.loadURL !== "function") { return; }
  let p: unknown;
  try {
    p = wv.loadURL(url);
  } catch {
    return; 
  }
  

  if (p && typeof (p as Promise<void>).catch === "function") {
    void (p as Promise<void>).catch((e: unknown) => {
      
      if (isBenignAbort(Number((e as { errno?: number } | null | undefined)?.errno))) { return; }
    });
  }
}






















export type NavFailureBook = Map<string, number>;


export type NavTrigger = "attach" | "url-change" | "net" | "manual";


export function isTerminalNavFailure(errno: number): boolean {
  return !isBenignAbort(errno);
}


export function noteNavFailure(book: NavFailureBook, url: string, errno: number): boolean {
  if (!url || !isTerminalNavFailure(errno)) { return false; }
  book.set(url, (book.get(url) ?? 0) + 1);
  return true;
}


export function isNavLatchBlocked(book: ReadonlyMap<string, number>, url: string): boolean {
  return Boolean(url) && (book.get(url) ?? 0) > 0;
}


export function clearNavFailure(book: NavFailureBook, url?: string): void {
  if (url === undefined) { book.clear(); return; }
  book.delete(url);
}











export function navAutoLoadAllowed(
  book: ReadonlyMap<string, number>,
  url: string,
  trigger: NavTrigger,
  attached: boolean,
): boolean {
  if (!url) { return false; }
  if (trigger === "manual") { return true; }
  if (isNavLatchBlocked(book, url)) { return false; }
  if (trigger === "net" && attached) { return false; }
  return true;
}
