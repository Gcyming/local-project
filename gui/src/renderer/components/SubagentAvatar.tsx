/**
 * gui/src/renderer/components/SubagentAvatar.tsx — 子代理头像（A-980-R31）。
 *
 * 图标来自用户指定的图标库 `gui/icon/icon_1cdszr8as42`（经 `gui/scripts/gen-subagent-icons.mjs`
 * 生成到 `subagentIcons.ts`），按**名字首字符**选图标：字母→字母图标、数字→数字、`-`/`_`→符号，
 * 中文名/emoji 等无首字母可用时回落 `head` 通用头像。颜色仍由名字哈希决定，
 * 于是"同一个人"在任何面板里都是同一个图标 + 同一个颜色（可辨识、可跨面板对上号）。
 *
 * 之前是"哈希出一个字母 + 纯色方块"——中文名的子代理（代码审查员/调研员/数据分析员）
 * 全部退化成同一个 head 分支或随机字母，看起来像占位符而不是实体。现在图标即身份。
 */
import type { CSSProperties, JSX } from "react";
import {
  SUBAGENT_ICON_FALLBACK,
  SUBAGENT_ICONS,
  SUBAGENT_ICON_VIEWBOX,
  pickSubagentIconKey,
} from "./subagentIcons.js";

/** 头像配色盘（深色主题下都有足够对比度；与图标 currentColor 联动） */
const AVATAR_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee",
  "#60a5fa", "#a78bfa", "#f472b6", "#94a3b8", "#fb7185", "#facc15",
  "#4ade80", "#38bdf8", "#818cf8", "#c084fc", "#e879f9", "#fda4af",
  "#fcd34d", "#86efac",
];

/** 名字 → 稳定颜色（同一名字恒定同色，跨面板一致） */
export function subagentAvatarColor(name: string): string {
  const sum = [...(name ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[Math.abs(sum) % AVATAR_COLORS.length];
}

/** 把 #rrggbb 加上 alpha（0-1）——用于头像底色/描边，避免到处写 rgba 字面量 */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) { return hex; }
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export interface SubagentAvatarProps {
  name: string;
  size?: number;
  /** 运行中：加绿色呼吸点 + 光晕 */
  running?: boolean;
  style?: CSSProperties;
  title?: string;
}

export default function SubagentAvatar({
  name,
  size = 24,
  running = false,
  style,
  title,
}: SubagentAvatarProps): JSX.Element {
  const key = pickSubagentIconKey(name);
  const shape = SUBAGENT_ICONS[key] ?? SUBAGENT_ICONS[SUBAGENT_ICON_FALLBACK] ?? [];
  const color = subagentAvatarColor(name);
  return (
    <div
      style={{ position: "relative", flexShrink: 0, ...style }}
      title={title ?? `${name}（图标 ${key}）`}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(4, Math.round(size * 0.26)),
          background: withAlpha(color, running ? 0.24 : 0.14),
          border: `1px solid ${withAlpha(color, running ? 0.75 : 0.42)}`,
          color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: running ? `0 0 0 2px ${withAlpha(color, 0.18)}, 0 0 10px ${withAlpha(color, 0.4)}` : "none",
          transition: "box-shadow 0.35s, background 0.35s",
        }}
      >
        <svg
          viewBox={SUBAGENT_ICON_VIEWBOX}
          width={Math.round(size * 0.72)}
          height={Math.round(size * 0.72)}
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          {shape.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      </div>
      {running && (
        <span
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(8, Math.round(size * 0.36)),
            height: Math.max(8, Math.round(size * 0.36)),
            borderRadius: "50%",
            background: "#22c55e",
            border: "2px solid var(--bg)",
            animation: "liveDot 1.2s ease-in-out infinite",
            willChange: "opacity, box-shadow, transform" as const,
          }}
        />
      )}
    </div>
  );
}
