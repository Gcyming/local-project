/**
 * gui/src/renderer/components/ThemeDialog.tsx — slime 主题化的确认/提示弹窗（A-1018）。
 *
 * 为什么要有它：`confirmAsync/alertAsync` 原先直接调主进程 `dialog.showMessageBox` ——
 * 那是**系统原生**弹窗：Windows 白底、系统图标、系统按钮顺序（取消在左、确定在右），
 * 与 slime 的暗色毛玻璃主题完全两套视觉（用户原话："还有很多弹窗都是系统风格弹窗，
 * 你给我绑定 slime 程序主题，同时改一下位置，左边确认，右边取消"）。
 *
 * 设计要点：
 * - **调用面零改动**：`dialog.ts` 的 `confirmAsync/alertAsync` 签名与语义保持不变，
 *   只是把实现换成「交给已挂载的主题弹窗宿主」。38 个调用点无需逐个改。
 * - 宿主**常驻挂载**（挂在 App 里），弹窗本体按需渲染；返回值走 Promise。
 * - 按钮顺序按用户要求：**左确认、右取消**（与 Windows 原生相反，这是用户明确的直觉要求）。
 * - 不写 inline `position:"absolute"`：静态守卫（assert-collapse-anim ⑬）会把它当成
 *   "条件渲染 + 绝对定位浮层"的残留。样式全部走 index.css 的 `.dlg-*` 类。
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { registerDialogHost, type DialogRequest } from "../dialog.js";

export function ThemeDialogHost(): JSX.Element | null {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    // 宿主注册给 dialog.ts：同一个请求一次只可能有一个（弹窗都由用户操作触发、串行）
    registerDialogHost((r) => new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setReq(r);
    }));
    return () => { registerDialogHost(null); };
  }, []);

  // Esc = 取消（confirm）/ 关闭（alert）。用户按 Esc 属于明确拒绝，不能返回 true。
  useEffect(() => {
    if (!req) { return; }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { close(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [req]);

  function close(ok: boolean): void {
    const r = resolverRef.current;
    resolverRef.current = null;
    setReq(null);
    r?.(ok);
  }

  if (!req) { return null; }

  return (
    <div className="dlg-backdrop" role="dialog" aria-modal="true"
      onClick={() => close(false)}>
      <div className="dlg-card" onClick={(e) => { e.stopPropagation(); }}>
        <div className="dlg-title">{req.kind === "confirm" ? "确认操作" : "提示"}</div>
        <div className="dlg-body">
          <div className="dlg-message">{req.message}</div>
          {req.detail ? <div className="dlg-detail">{req.detail}</div> : null}
        </div>
        <div className="dlg-actions">
          {/* 左确认、右取消（用户指定的直觉顺序） */}
          <button className="btn primary" onClick={() => close(true)} autoFocus>确定</button>
          {req.kind === "confirm" ? (
            <button className="btn" onClick={() => close(false)}>取消</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
