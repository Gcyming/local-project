

















export type InvokeOk<T> = { ok: true; value: T };
export type InvokeErr = { ok: false; error: string };
export type InvokeResult<T> = InvokeOk<T> | InvokeErr;












export async function tryInvoke<T>(fn: () => Promise<T> | undefined): Promise<InvokeResult<T>> {
  try {
    const v = await fn();
    if (v === undefined) { return { ok: false, error: "通道不可用（后台服务尚未就绪，请稍候重试）" }; }
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}















export function asReply<T>(res: InvokeResult<T>): Partial<T> & { ok?: boolean; error?: string } {
  




  const shape = res.ok ? res.value : { ok: false, error: res.error };
  return shape as unknown as Partial<T> & { ok?: boolean; error?: string };
}
