/**
 * gui/src/renderer/pages/SubAgentExpandButton.tsx — 子代理的**悬浮按钮坞**条目（A-976 → A-1074）。
 *
 * A-1074（#230）用户原话：「**子代理从右侧监测栏移出**，做成**同款**悬浮按钮」。
 * ⇒ 本组件不再渲染在底部监测栏的数值行里（那行只报数：tokens / 耗时 / context / 模型），
 *   而是和「后台进程」并排放在输入框正上方的坞里，用**同一套**类名：
 *   `dock-slot` / `dock-pill`（胶囊按钮，展开时横向延伸）/ `dock-panel` + `.collapse`（向上展开）。
 *
 * 展开/渐出的判据**不在这里**：`open` / `faded` 由父级从 `floatDock.ts` 的**单值** state 派生后传进来 ——
 * 这样"两个同时展开"这种非法状态在结构上就不存在（见 floatDock.ts 的说明）。
 */
import React, { type JSX, useEffect, useState } from "react";
import SubAgentModal from "./SubAgentModal.js";
import SubagentAvatar from "../components/SubagentAvatar.js";
import { ChevronIcon } from "../components/Icon.js";
import { dockSlotClassOf } from "./floatDock.js";

interface SubRun {
  id: string;
  name: string;
  status: string;
  task?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  model?: string;
  timeoutMs?: number;
}

/**
 * A-980-R31：补上 `timeout`。
 * 此前缺这一项，超时中断的子代理在下拉里显示成**原始英文 `timeout`**（STATUS_META 未命中 →
 * 回落 `{ txt: r.status }`），而同一套状态在设置页里明明写着"⏱ 超时中断"——同一种事实两种说法。
 */
const STATUS_META: Record<string, { txt: string; c: string }> = {
  pending: { txt: "排队", c: "#fbbf24" },
  running: { txt: "运行", c: "#22c55e" },
  done: { txt: "完成", c: "#22c55e" },
  fail: { txt: "失败", c: "#f87171" },
  timeout: { txt: "超时中断", c: "#fbbf24" },
  cancelled: { txt: "取消", c: "var(--text-muted)" },
};

export default function SubAgentExpandButton(
  { slot, onToggle }: { slot: { open: boolean; faded: boolean }; onToggle: () => void },
): JSX.Element | null {
  const { open, faded } = slot;
  const [runs, setRuns] = useState<SubRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = React.useCallback((): void => {
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.state?.()
      .then((s: { subagents?: SubRun[] }) => { if (Array.isArray(s?.subagents)) { setRuns(s.subagents); } })
      .catch(() => { /* 服务未就绪 */ });
  }, []);

  useEffect(() => {
    refresh();
    const w = window as unknown as { slimeAPI?: any };
    const off = w.slimeAPI?.resident?.onUpdate?.(() => refresh());
    const iv = window.setInterval(refresh, 3000);
    return () => { off?.(); window.clearInterval(iv); };
  }, [refresh]);

  const active = runs.filter((r) => r.status === "running" || r.status === "pending");
  /* 没有任何子代理记录 → 这一格整个不渲染（不留空壳，与「后台进程」同约定）。
     ⚠️ A-1106/5b 更正：可见性判据**就住在本组件里** —— 调用方 ChatPanel 是**无条件**挂载本组件的
     （外层只判 `!pendingAsk`），并不存在「ChatPanel 据 runs 决定要不要显示坞」那一层（旧注释那条
     说法是错的，会把人引去改错地方）。故「看不到子代理按钮」= 一条记录都没拉回来：
       ① 主因是委派没发生（提示词层，见 subagentCatalog.ts 的力度预算分档）；
       ② 次因是派发/取消没**如实推送**（见 gui/src/main/index.ts 的 onSpawn 与 cancel 通道）——
          此前 pending 阶段与「取消排队中」都不广播 ⇒ 面板只能等 3 秒轮询，观感就是「不实时」。
     放宽这里（改成恒显）只会多一个恒为 0 的空壳，不解决上面两条。 */
  if (runs.length === 0) { return null; }

  return (
    <>
      {/* 面板：**常驻挂载** + 切 `is-open` 类名（A-1015b 约定），向上展开。
          绝对定位在坞的上沿 → 高度增长不顶动输入框。 */}
      <div className="dock-panel">
        <div className={`collapse${open ? " is-open" : ""}`}>
          <div className="dock-panel-card">
            <div style={{
              padding: "8px 11px", borderBottom: "1px solid var(--border)",
              fontSize: 12, fontWeight: 700, color: "var(--text)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>子代理 ({runs.length})</span>
              <button
                onClick={onToggle}
                title="收起"
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", fontSize: 14, padding: 0,
                }}
              >✕</button>
            </div>
            {/* 列表可滚动（子代理可能很多） */}
            <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 340, overflow: "auto" }}>
              {runs.slice().reverse().map((r) => {
                const m = STATUS_META[r.status] ?? { txt: r.status, c: "var(--text-dim)" };
                return (
                  <button
                    key={r.id}
                    onClick={() => { setSelectedId(r.id); onToggle(); }}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 10px", borderRadius: 6, background: "var(--bg-hover)",
                      border: "none", cursor: "pointer", textAlign: "left",
                    }}
                  >
                    {/* A-980-R31：与设置页同一套头像（图标=身份），下拉与详情里能一眼对上人 */}
                    <SubagentAvatar name={r.name} size={22} running={r.status === "running"} />
                    <span style={{
                      flex: 1, fontSize: 12, fontWeight: 600, color: "var(--text)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {r.name}
                    </span>
                    <span style={{ fontSize: 11, color: m.c, flexShrink: 0 }}>{m.txt}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 悬浮按钮：与「后台进程」同款（同一套 .dock-slot / .dock-pill） */}
      <span className={dockSlotClassOf(open, faded)}>
        <button
          className="dock-pill"
          onClick={onToggle}
          title={active.length > 0 ? `${active.length} 个子代理运行中` : "查看子代理"}
        >
          <span style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: active.length > 0 ? "#22c55e" : "var(--text-dim)",
            animation: active.length > 0 ? "liveDot 1.5s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontWeight: 600, flexShrink: 0 }}>子代理</span>
          {/* A-1109：数字框格里的数字「不在最中心」—— 用户原话「这个悬浮按钮的后面的数字
              感觉不在框格最中心，你微调一下」。
              病根：上一版靠 `padding: 0 6px` + `lineHeight: "15px"` **伪居中** ——
              行盒高度由 line-height 决定，而**字形在行盒里的落位由字体度量（ascent/descent）
              决定**；`Microsoft YaHei` 的数字是半角、其度量与中文字面不同 ⇒ 视觉上偏离中心。
              改法：不再依赖行高，改成**几何居中** —— `inline-flex` + 两个方向都 `center`，
              并给一个固定方框（`minWidth: 16` / `height: 16`）。这样"3"这个字形是被
              **盒子的中心对齐**拉正的，与字体度量无关 ⇒ 换字体也不会再歪。
              `minWidth` 而非 `width`：两位数仍能自动变宽，不会被挤压。
              `lineHeight: 1`：把行高对字形的残余影响清零（居中已由 flex 负责）。 */}
          <span style={{
            flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
            minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, lineHeight: 1,
            background: "var(--bg-hover)", border: "1px solid var(--border)",
            color: "var(--text-muted)", fontSize: 10.5, fontWeight: 600,
          }}>{runs.length}</span>
          {/* A-1079：**不再有"横向延伸"的摘要段**（与「后台进程」同款：任何状态下都紧凑） */}
          {/* A-1079：箭头收起态**朝上**（面板从上方浮出），展开态朝下 */}
          <ChevronIcon size={10} rotate={open ? 90 : 270} style={{ flexShrink: 0 }} />
        </button>
      </span>

      {/* 详情弹窗 */}
      {selectedId && (
        <SubAgentModal runId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </>
  );
}
