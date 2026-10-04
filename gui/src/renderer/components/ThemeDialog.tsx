















import { useEffect, useRef, useState, type JSX } from "react";
import { registerDialogHost, type DialogRequest } from "../dialog.js";

export function ThemeDialogHost(): JSX.Element | null {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    
    registerDialogHost((r) => new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setReq(r);
    }));
    return () => { registerDialogHost(null); };
  }, []);

  
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
          {}
          <button className="btn primary" onClick={() => close(true)} autoFocus>确定</button>
          {req.kind === "confirm" ? (
            <button className="btn" onClick={() => close(false)}>取消</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
