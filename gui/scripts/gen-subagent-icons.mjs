/**
 * gui/scripts/gen-subagent-icons.mjs — 从图标库 SVGs 生成子代理头像的 TS 模块（A-980-R31）。
 *
 * 为什么用脚本生成而不是把 SVG 抄成静态文件：
 * 渲染层要按「名字首字符」动态选图标，import 静态资源会把 39 个文件都打进 bundle 且拿不到
 * "选哪个"的逻辑；而手抄路径数据（11 万字符）既易错又不可维护。生成 + 提交产物，
 * 换图标库时重跑本脚本即可（**不要手改生成文件**）。
 *
 * 用法：node gui/scripts/gen-subagent-icons.mjs [图标目录] [输出文件]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(process.argv[2] ?? join(HERE, "..", "icon", "icon_1cdszr8as42"));
const OUT = resolve(process.argv[3] ?? join(HERE, "..", "src", "renderer", "components", "subagentIcons.ts"));

/**
 * 文件名 → 图标 key 的映射（key 就是"名字首字符"归一化之后的样子）。
 * 图标库命名：`A.svg`..`Z.svg`、`a-0.svg`..`a-9.svg`、`a-.svg`（连字符）、`a-_1.svg`（下划线）、`head.svg`。
 */
function keyOf(base) {
  if (base === "head") { return "head"; }
  if (/^[A-Za-z]$/.test(base)) { return base.toUpperCase(); }
  const digit = /^a-(\d)$/.exec(base);
  if (digit) { return digit[1]; }
  if (base === "a-") { return "-"; }
  if (base === "a-_1" || base === "a-_") { return "_"; }
  return null; // 未识别，跳过（并在 stdout 提示）
}

/** 取 SVG 中所有 `<path>` 的 d（保持出现顺序：先圆环、后字形） */
function pathsOf(svg) {
  return [...svg.matchAll(/<path\b[^>]*\sd="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
}

const files = readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith(".svg")).sort();
const entries = [];
const skipped = [];
for (const f of files) {
  const key = keyOf(basename(f, ".svg"));
  if (!key) { skipped.push(f); continue; }
  const ds = pathsOf(readFileSync(join(SRC_DIR, f), "utf8"));
  if (ds.length === 0) { skipped.push(f); continue; }
  entries.push([key, ds]);
}
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const body = entries
  .map(([key, ds]) => `  ${JSON.stringify(key)}: [\n${ds.map((d) => `    ${JSON.stringify(d)},`).join("\n")}\n  ],`)
  .join("\n");

const out = `/**
 * gui/src/renderer/components/subagentIcons.ts — 子代理头像图标库（A-980-R31）。
 *
 * ⚠️ **本文件由 gui/scripts/gen-subagent-icons.mjs 生成，请勿手改路径数据。**
 * 源图标库：D:\\pilot project\\gui\\icon\\icon_1cdszr8as42（${entries.length} 个单色 SVG，viewBox 0 0 1024 1024）。
 * 换图标库 → 重跑：node gui/scripts/gen-subagent-icons.mjs [图标目录] [输出文件]
 *
 * 每个图标含两条路径：① 细圆环底框（约 10/1024 线宽）② 字形/图形本体。
 * 渲染时统一用 currentColor，颜色由调用方（按名字着色）决定。
 */
export const SUBAGENT_ICON_VIEWBOX = "0 0 1024 1024";

/** key → 路径 d 列表 */
export const SUBAGENT_ICONS: Record<string, string[]> = {
${body}
};

/** 兜底图标（中文名 / emoji / 无首字母时使用） */
export const SUBAGENT_ICON_FALLBACK = "head";

/** 全部可用 key（断言/调试用） */
export const SUBAGENT_ICON_KEYS: string[] = ${JSON.stringify(entries.map(([k]) => k))};

/**
 * 按名字首字符选图标 key。
 *
 * 规则（与用户约定一致）：字母 → 对应大写字母图标；数字 → 数字图标；
 * \`-\` / \`_\` → 对应符号图标；全角字母先 NFKC 归一化；其余（中文/emoji/未知符号）→ head 兜底。
 */
export function pickSubagentIconKey(name: string): string {
  const chars = [...(name ?? "").trim()];
  const first = chars[0];
  if (!first) { return SUBAGENT_ICON_FALLBACK; }
  const up = first.toUpperCase();
  if (SUBAGENT_ICONS[up] && /^[A-Z]$/.test(up)) { return up; }
  if (/^[0-9]$/.test(first)) { return first; }
  if (first === "-" || first === "_") { return first; }
  // 全角/带圈字母等：归一化后再试一次（Ａ → A、ⓐ → a）
  const nf = first.normalize("NFKC").toUpperCase();
  if (/^[A-Z]$/.test(nf) && SUBAGENT_ICONS[nf]) { return nf; }
  return SUBAGENT_ICON_FALLBACK;
}
`;

writeFileSync(OUT, out, "utf8");
console.log(`[gen-subagent-icons] ${entries.length} 个图标 → ${OUT}`);
console.log(`[gen-subagent-icons] keys: ${entries.map(([k]) => k).join(" ")}`);
if (skipped.length > 0) { console.warn(`[gen-subagent-icons] 跳过未识别文件：${skipped.join(", ")}`); }
