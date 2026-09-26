/**
 * gui/src/renderer/pages/railParams.ts — 目录卷轴参数的**唯一出处**（读取 / 保存 / 订阅）。
 *
 * 为什么要独立成模块（A-1115）：
 *   - 卷轴有两个使用者（对话页 / 右栏 md 阅读器）**外加**设置页里的实时演示 ——
 *     三处必须读**同一份**参数，否则"设置里调好了、实际界面没变"（这类静默失效本仓归档过多次）；
 *   - 参数存在 localStorage（纯渲染层偏好，与 `slime_auto_compress` 同口径），
 *     **不经主进程**：卷轴是纯视觉，落盘到 config/*.json 只会多一个真相源。
 *
 * ⚠️ 改参数必须**立即生效**：靠 `window` 上的自定义事件通知所有挂载中的卷轴（它们各自更新 ref，
 *    不触发 React 重渲染 —— 卷轴是逐帧 canvas，走重渲染就是每帧一次 diff）。
 * ⚠️ localStorage 读失败（隐私模式 / 配额）一律**回落到默认值**，绝不抛错、绝不留下半个状态。
 */

export interface RailParams {
  /** 两条线各自的波长（px）—— 不同才能让交点沿轴游走，即"交织"而不是对称透镜 */
  lam0: number;
  lam1: number;
  /** 常态振幅：占"波形带宽"的百分比。⚠️ 它与两条描边的覆盖宽度是**互相抢空间**的，压太低两线会糊成一条 */
  amp: number;
  /** 合拢强度：指针处两线间距归零的程度（1 = 完全重叠） */
  k: number;
  /** 平滑区宽度（× σ）：振荡被完全压平的范围。⚠️ 不能小到盖不住凹陷的尾巴，否则衔接处会出"锐角" */
  a: number;
  /** 隆起：指针处向左伸出的幅度（占半带宽 %） */
  bulge: number;
  /** 凹陷：两肩向右凹的深度（占半带宽 %） */
  dip: number;
  /** md 刻度突起：鼠标处那条刻度变长的幅度（占卷轴宽 %） */
  grow: number;
  /** 过渡尺度（px）：衬托的纵向尺度，越小上下越收窄 */
  sig: number;
  /** 端部过渡长度（px）：离上下端点多远内开始渐隐 + 收束 */
  tap: number;
  /** 端部残留（0..1）：端点处保留的比例。⚠️ 给 0 会让端点变成**精确直线**，反而成了"看得见的形状" */
  efloor: number;
  /** 荡漾速度 */
  spd: number;
  /** 指针跟随阻尼（越小越柔） */
  damp: number;
  /** 卷轴视觉宽度（px） */
  w: number;
  /** 悬停时暂停荡漾（相位冻住、不跳变） */
  pause: boolean;
  /** 已读段更亮（对话页用它代替进度刻度） */
  read: boolean;
  /** 衬托方向反过来（把隆起放到右侧） */
  flip: boolean;
}

/** 对话页（双线交织水波 + 衬托山包） */
export const DEFAULT_WAVE_PARAMS: RailParams = {
  lam0: 46, lam1: 53, amp: 55, k: 1, a: 4,
  bulge: 280, dip: 110, grow: 55, sig: 13,
  tap: 90, efloor: 0.12,
  spd: 1, damp: 0.22, w: 12,
  pause: true, read: true, flip: false,
};

/** md 文档（只保留刻度尺；鼠标处那条变长向左突起，不做凹陷） */
export const DEFAULT_TICKS_PARAMS: RailParams = {
  ...DEFAULT_WAVE_PARAMS,
  dip: 0,          // md **不做凹陷**（用户明确要求）
  grow: 55,
};

export type RailMode = "wave" | "ticks";

const KEY: Record<RailMode, string> = {
  wave: "slime_rail_params_chat",
  ticks: "slime_rail_params_md",
};

export const RAIL_PARAMS_EVENT = "slime:rail-params";

const NUM_RANGES: Record<string, [number, number]> = {
  lam0: [8, 400], lam1: [8, 400], amp: [0, 100], k: [0, 3], a: [1, 8],
  bulge: [0, 400], dip: [0, 200], grow: [0, 200], sig: [4, 120],
  tap: [0, 400], efloor: [0, 0.9], spd: [0, 4], damp: [0.02, 1], w: [6, 32],
};

/** 把任意输入收敛成一个**合法且完整**的参数对象（越界钳住、缺字段补默认、非数字丢弃）。 */
export function normalizeRailParams(input: unknown, base: RailParams): RailParams {
  const out: RailParams = { ...base };
  if (!input || typeof input !== "object") { return out; }
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof RailParams>) {
    const v = src[key];
    if (typeof v === "boolean") {
      if (typeof base[key] === "boolean") { (out as unknown as Record<string, unknown>)[key] = v; }
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      const r = NUM_RANGES[key as string];
      (out as unknown as Record<string, unknown>)[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
    }
  }
  return out;
}

export function defaultRailParams(mode: RailMode): RailParams {
  return mode === "ticks" ? { ...DEFAULT_TICKS_PARAMS } : { ...DEFAULT_WAVE_PARAMS };
}

/** 读参数；localStorage 不可用 / 内容损坏一律回落默认值（绝不抛错）。 */
export function loadRailParams(mode: RailMode): RailParams {
  const base = defaultRailParams(mode);
  try {
    const raw = localStorage.getItem(KEY[mode]);
    if (!raw) { return base; }
    return normalizeRailParams(JSON.parse(raw), base);
  } catch {
    return base;
  }
}

/** 保存参数并广播（返回归一化后的结果，调用方据此回显）。 */
export function saveRailParams(mode: RailMode, patch: Partial<RailParams>): RailParams {
  const next = normalizeRailParams({ ...loadRailParams(mode), ...patch }, defaultRailParams(mode));
  try { localStorage.setItem(KEY[mode], JSON.stringify(next)); } catch { /* 配额/隐私模式：内存里仍然生效 */ }
  try { window.dispatchEvent(new CustomEvent(RAIL_PARAMS_EVENT, { detail: { mode, params: next } })); } catch { /* ignore */ }
  return next;
}

/** 订阅参数变化（返回解绑函数）。挂载中的卷轴用它**即时**吃到新参数。 */
export function onRailParams(cb: (mode: RailMode, params: RailParams) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ mode?: RailMode }>).detail;
    if (!d || !d.mode) { return; }
    cb(d.mode, loadRailParams(d.mode));
  };
  window.addEventListener(RAIL_PARAMS_EVENT, h);
  return () => { window.removeEventListener(RAIL_PARAMS_EVENT, h); };
}

/**
 * 目录刻度的纵向位置（**纯函数，唯一出处**）：**均匀等距**铺满 [top, bot]。
 *
 * 为什么必须是等距而不是"按内容比例"（A-1115 实测）：
 *   - 按内容比例 ⇒ 忠实复现文档结构，而 md 里 `h3` 紧跟 `h2` ⇒ **间距一密一疏、成对出现**，
 *     被用户判定「分布不均匀」；
 *   - 按"滚到顶所需的 scrollTop" ⇒ 末尾一屏内的条目滚不到顶、位置被钳到同一个值 ⇒ **底部堆成一坨**。
 *   「条目少自然疏、多自然密」这句要求，**等距分布本身就满足**，而且不会产生上述两种副作用。
 */
export function tickPositions(n: number, top: number, bot: number): number[] {
  if (n <= 0) { return []; }
  if (n === 1) { return [(top + bot) / 2]; }
  const out: number[] = [];
  for (let i = 0; i < n; i++) { out.push(top + ((bot - top) * i) / (n - 1)); }
  return out;
}
