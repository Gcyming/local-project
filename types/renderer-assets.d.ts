/**
 * types/renderer-assets.d.ts —— 给**非 vite 程序**（根 `tsconfig.base.json`）用的静态资源声明。
 *
 * ── 为什么需要这个文件（根因，不是权宜之计）──────────────────────────────
 * 根工程 `tsconfig.base.json` 的 include 里有 `tests/core-ts/**`，而其中
 * `gui-products.spec.ts` / `live-monitor.spec.ts` 等 13 个测试文件会 import
 * `gui/src/**` 下的实现（这是**有意**的：gui 侧纯逻辑必须有单测，而"两端 tsc"是本项目的
 * 既定验证习惯）。于是那批 renderer 文件被**作为依赖**拉进根工程 —— 注意 TS 的 `exclude`
 * 拦不住这种传递引入，被 import 到的文件一定会被检查。
 *
 * 问题在于两个工程描述的是**同一个源文件的两套环境**：
 *   · `gui/tsconfig.json`（vite）→ `types: ["vite/client"]`，其中已声明 `*.svg` 等资源模块；
 *   · 根工程（裸 tsc，node 向）→ 没有任何资源模块声明。
 * 结果：`ChatPanel.tsx` 里 17 条 `import xxIcon from "../assets/icons/xx.svg"` 全部报
 * TS2307，把根类型检查**永久染红**。门禁一旦常年是红的，里面藏着的**真实**类型错就没人看了
 * （本目录建立时，同一次检查里就藏着 22 条真错，见下）。
 *
 * ── 为什么是"补声明"而不是"把 renderer 排除掉"────────────────────────────
 * 排除不掉：renderer 是被测试 import 进来的依赖，`exclude` 对依赖无效；
 * 真正的解耦要求把纯逻辑从组件里抽出去（那是独立的结构性改造，不是本文件的职责）。
 * 而这里的声明**不是编造**：它逐字对齐 vite 提供的契约（资源默认导出其 URL 字符串），
 * 因为 slime 的 renderer 确实在 vite 下构建。
 *
 * ── 铁律 ──────────────────────────────────────────────────────────────
 * 本文件只声明**资源模块**，绝不在这里放宽类型或加 `any` 兜底 ——
 * 用"声明一个模块"来消灭红字是修复，用"给个 any"来消灭红字是掩盖。
 * 每次改这里都要问一遍：这真的是 vite 的契约，还是我在给报错打补丁？
 */

/** Vite：静态资源默认导出**解析后的 URL 字符串**（构建产物里是带 hash 的资源路径） */
declare module "*.svg" { const src: string; export default src; }
declare module "*.png" { const src: string; export default src; }
declare module "*.jpg" { const src: string; export default src; }
declare module "*.jpeg" { const src: string; export default src; }
declare module "*.gif" { const src: string; export default src; }
declare module "*.webp" { const src: string; export default src; }
declare module "*.avif" { const src: string; export default src; }
declare module "*.ico" { const src: string; export default src; }
declare module "*.bmp" { const src: string; export default src; }
declare module "*.woff" { const src: string; export default src; }
declare module "*.woff2" { const src: string; export default src; }
declare module "*.ttf" { const src: string; export default src; }
declare module "*.otf" { const src: string; export default src; }
declare module "*.eot" { const src: string; export default src; }
declare module "*.mp3" { const src: string; export default src; }
declare module "*.wav" { const src: string; export default src; }
declare module "*.mp4" { const src: string; export default src; }
declare module "*.webm" { const src: string; export default src; }
declare module "*.pdf" { const src: string; export default src; }

/**
 * 显式查询后缀（vite 的 `?raw` / `?url` / `?inline`）。
 * `?raw` 拿到**文件正文**（字符串），`?url` 拿到 URL，`?inline` 拿到内联数据。
 * 声明得比实际用量宽：漏声明会让"下次有人用 `?raw`"再次把门禁染色，
 * 而门禁反复变红正是本次要根除的病。
 */
declare module "*?raw" { const content: string; export default content; }
declare module "*?url" { const src: string; export default src; }
declare module "*?inline" { const src: string; export default src; }
declare module "*?worker" { const workerConstructor: new () => Worker; export default workerConstructor; }
declare module "*?worker&url" { const src: string; export default src; }

/**
 * CSS / CSS Modules（vite 侧由 `vite/client` 提供）。
 * `*.module.css` 必须排在 `*.css` 之前声明才生效？——TS 取**最具体**的匹配，与顺序无关，
 * 这里两种都写清楚：普通 css 默认导出空对象（vite 注入副作用），module.css 导出类名映射。
 */
declare module "*.css" { const css: Record<string, string>; export default css; }
declare module "*.module.css" { const classes: Record<string, string>; export default classes; }
