/**
 * gui/src/renderer/pages/ReleaseNotesView.tsx — 更新说明渲染（只负责画）。
 *
 * 解析在 `shared/releaseNotes.ts`（纯逻辑、可测）；这里只把结构化块映射成 React 元素。
 * **绝不用 `dangerouslySetInnerHTML`**：内容来自远端 Release 正文，注入执行等于把
 * preload 暴露给远端字符串。
 */
import React, { type JSX } from "react";
import { parseReleaseNotes, type ReleaseNoteBlock, type ReleaseNoteRun } from "../../shared/releaseNotes.js";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function Runs({ runs }: { runs?: ReleaseNoteRun[] }): JSX.Element {
  return (
    <>
      {(runs ?? []).map((r, i) => {
        let node: React.ReactNode = r.text;
        if (r.code) {
          node = (
            <code style={{
              fontFamily: MONO, fontSize: "0.92em", padding: "0.5px 4px", borderRadius: 4,
              background: "var(--bg-hover)", color: "var(--text)",
            }}>{r.text}</code>
          );
        }
        if (r.href) {
          node = (
            <a href={r.href} target="_blank" rel="noreferrer noopener"
              style={{ color: "var(--accent, #38bdf8)" }}>{node}</a>
          );
        }
        if (r.italic) { node = <em>{node}</em>; }
        if (r.bold) { node = <strong style={{ color: "var(--text)" }}>{node}</strong>; }
        return <React.Fragment key={i}>{node}</React.Fragment>;
      })}
    </>
  );
}

function Block({ b }: { b: ReleaseNoteBlock }): JSX.Element | null {
  switch (b.kind) {
    case "heading": {
      const size = b.level === 1 ? 15 : b.level === 2 ? 14 : 13;
      return (
        <div style={{
          fontSize: size, fontWeight: 700, color: "var(--text)",
          margin: "12px 0 6px", paddingBottom: 4, borderBottom: "1px solid var(--border)",
        }}>
          <Runs runs={b.runs} />
        </div>
      );
    }
    case "paragraph":
      return (
        <p style={{ margin: "5px 0", fontSize: 12.5, lineHeight: 1.65, color: "var(--text-muted)" }}>
          <Runs runs={b.runs} />
        </p>
      );
    case "list": {
      const List = b.ordered ? "ol" : "ul";
      return (
        <List style={{ margin: "5px 0", paddingLeft: 20, fontSize: 12.5, lineHeight: 1.65, color: "var(--text-muted)" }}>
          {(b.items ?? []).map((it, i) => <li key={i} style={{ margin: "2px 0" }}><Runs runs={it} /></li>)}
        </List>
      );
    }
    case "table":
      return (
        <div style={{ overflowX: "auto", margin: "8px 0" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            {(b.header ?? []).length > 0 && (
              <thead>
                <tr>
                  {(b.header ?? []).map((c, i) => (
                    <th key={i} style={{
                      textAlign: "left", padding: "5px 9px", color: "var(--text)",
                      borderBottom: "1px solid var(--border)", whiteSpace: "nowrap",
                    }}><Runs runs={c} /></th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(b.rows ?? []).map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci} style={{
                      padding: "5px 9px", color: "var(--text-muted)",
                      borderBottom: "1px solid var(--border)", verticalAlign: "top",
                    }}><Runs runs={c} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre style={{
          margin: "8px 0", padding: "8px 10px", borderRadius: 6, background: "var(--bg-hover)",
          color: "var(--text-muted)", fontSize: 11.5, fontFamily: MONO,
          overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{b.text}</pre>
      );
    case "hr":
      return <div style={{ height: 1, background: "var(--border)", margin: "10px 0" }} />;
    default:
      return null;
  }
}

/** 更新说明正文视图（限高滚动，避免长文把整面板顶爆） */
export default function ReleaseNotesView({ notes, maxHeight = 340 }: { notes: string; maxHeight?: number }): JSX.Element | null {
  const blocks = React.useMemo(() => parseReleaseNotes(notes), [notes]);
  if (blocks.length === 0) { return null; }
  return (
    <div style={{
      maxHeight, overflowY: "auto", marginTop: 8, paddingRight: 6,
      borderTop: "1px solid var(--border)", paddingTop: 4,
    }}>
      {blocks.map((b, i) => <Block key={i} b={b} />)}
    </div>
  );
}
