/**
 * core-ts/src/diff_marker.ts — 文件改动标记的**唯一出处**（A-1093）。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────────
 * 写入类工具（`file_write`）的回执里会内嵌一段机器标记：
 *
 *     [__slime_diff__]<base64(旧全文)>|<base64(新全文)>[/__slime_diff__]
 *
 * 它是「这次写入改了什么」的**唯一载体**：界面上工具卡的 `+N/-N` 徽标、
 * 展开后的红绿 diff 块、产物卡的改动统计，全部由它解析而来。
 *
 * ── 为什么要把它「写死」（A-1093 的用户原话）────────────────────────────────
 * 用户原话：「不行，都给我显示。而且这次你给我**根除**这个毛病，把这个会显示修改对比的
 * 设定**写死在 slime**，反正以后也不会删掉。顶多改一下前端的 UI 表现样式。」
 *
 * 这句话的工程含义是**分层**：
 *   · **生产/保留侧（本模块 + builtin.ts + tool_loop.ts + chat.ts）= 不可配置**：
 *     只要写入确实改变了内容，标记就**必须**产出、**必须**在所有截断路径里活下来；
 *     不存在"要不要带 diff"这种开关。任何试图把它做成可选的行为都是回归。
 *   · **表现侧（renderer）= 可调**：徽标长什么样、什么时候显示，由前端决定。
 *
 * ── 历史缺陷（为什么此前会「静默不显示」）──────────────────────────────────
 * 徽标的显示判据曾是 `add > 0 && del > 0`（**同时**有增有删），而 `parseDiffStat` 的
 * 计算是「行集合差」：
 *   · 新建文件（old 为空）→ 只有增、没有删 → `del === 0` → **不显示**；
 *   · 纯追加 → 同上 → **不显示**；
 *   · 纯删除 → 同上 → **不显示**。
 * 于是"新建一个文件"——最常见的那种写入——恰恰是唯一不显示改动的场景，
 * 而用户看到的是「有的卡片有 +N/-N、有的没有」，无从判断是"没改"还是"没记"。
 * ⇒ 判据改为 `add > 0 || del > 0`（**有任何改动就显示**）。
 * ⇒ 并且把"什么算有改动"收敛到本模块的 `diffStatOf`：三处各算一份必然漂移。
 *
 * ── 纯模块纪律 ──────────────────────────────────────────────────────────────
 * 本文件**只用 Node 内置能力以外的零依赖逻辑**，但**渲染层不能 import 它**
 * （渲染进程没有 `Buffer` —— A-979 的教训）。渲染层用的是
 * `gui/src/renderer/pages/chatProducts.ts` 里 `atob` 版本的解析器，
 * 两者**必须同规**，由 `tests/core-ts/a1093-diff-marker.spec.ts` 的跨实现一致性用例钉死。
 */

/**
 * 标记的正则（唯一出处）。`tool_loop.ts` 的 `DIFF_TAG_RE` 从本地重新导出。
 *
 * ⚠️ A-1093：两侧量词是 `*` 而**不是** `+` —— 必须允许**空的 base64**。
 *    新建文件时 `oldText === ""` ⇒ `b64("") === ""` ⇒ 标记形如
 *    `[__slime_diff__]|<new>[/__slime_diff__]`（左半边是空的）。
 *    旧正则写 `([A-Za-z0-9+/=]+)`（至少一个字符）⇒ **新建文件的标记根本匹配不上**
 *    ⇒ 回执里有标记、解析器却给 null ⇒ 徽标照样不显示。
 *    这正是用户报的"新建文件看不到改动"的**第二个产地**：判据改成 `||` 只解决了算得出，
 *    正则不认则连算的机会都没有。两者必须一起修，缺一仍是静默失效。
 */
export const DIFF_MARKER_RE = /\[__slime_diff__\]([A-Za-z0-9+/=]*)\|([A-Za-z0-9+/=]*)\[\/__slime_diff__\]/;

/** 超限时写进思考记录的位置占位：告知"曾有改动、但详情没存" */
export const DIFF_TRIMMED_MARKER = "[__slime_diff_trimmed__]";

/** 行集合差：新增行数 / 删除行数（空行不计） */
export interface DiffStat { add: number; del: number }

/**
 * 由 old/new 全文算改动行数。**纯函数**。
 *
 * 口径：按行去重后的集合差 —— 只看"这一行在不在对面"，不看位置与次数。
 * 这是一个**近似**（真实 diff 用 LCS，见 `diffLines`），但它与 UI 上那个
 * `+N/-N` 的口径一致，且对"新建/纯追加/纯删除"都能给出正确的非零值。
 *
 * ⚠️ 位置重排（同样的行、不同的顺序）会算出 `add=0, del=0` —— 这是**已知且接受**的近似：
 *    真实 LCS 会把整块判成"删 N 行 + 增 N 行"，对用户而言那反而不如"没变"好理解
 *    （内容确实一行没多一行没少）。若将来要改这个口径，必须**同时**改渲染层那份。
 */
export function diffStatOf(oldText: string, newText: string): DiffStat {
  const oldLines = new Set(oldText.split("\n"));
  const newLines = new Set(newText.split("\n"));
  let add = 0;
  let del = 0;
  for (const l of newLines) { if (l && !oldLines.has(l)) { add += 1; } }
  for (const l of oldLines) { if (l && !newLines.has(l)) { del += 1; } }
  return { add, del };
}

/**
 * 这次改动**有没有可展示的内容**？—— `add > 0 || del > 0`（A-1093 的判据）。
 *
 * ⚠️ 这是**表现的入场券**，也是"要不要显示徽标"的唯一答案。
 *    旧实现把它写成 `add > 0 && del > 0` 藏在渲染层的 `parseDiffStat` 里，
 *    于是"新建文件不显示改动"这个缺陷没有任何守卫能抓到（判据住在 `.ts` 的字符串里，
 *    而它连自己的名字都没起）。起个名字、给出唯一出处，才能被行为测试钉死。
 */
export function hasVisibleDiff(stat: DiffStat | null | undefined): boolean {
  return !!stat && (stat.add > 0 || stat.del > 0);
}

/** base64 → UTF-8 文本（Node 侧；渲染层另有 `atob` 版本，见文件头注） */
export function b64ToTextCore(b64: string): string {
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}

/**
 * 构造写入回执里的改动标记。**唯一产地**（此前是 `builtin.ts` 里一行内联模板串）。
 *
 * @returns 带前导换行的标记；`oldText === newText`（未改动）→ **空串**（不嵌标记）
 */
export function buildDiffMarker(oldText: string, newText: string): string {
  if (oldText === newText) { return ""; }
  const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");
  return `\n[__slime_diff__]${b64(oldText)}|${b64(newText)}[/__slime_diff__]`;
}

/**
 * 从写入回执文本里解析出改动统计。无标记 / base64 损坏 / **无任何改动** → `null`。
 *
 * ⚠️ 最后那条 `hasVisibleDiff` 的过滤是**刻意的**：它保证"返回非 null 就一定该显示徽标"，
 *    免得调用方还得各自再判一次（判两次就有一处会写反 —— 本项目吃过太多次）。
 */
export function parseDiffStatCore(result: string | undefined): DiffStat | null {
  if (!result) { return null; }
  const m = DIFF_MARKER_RE.exec(result);
  if (!m) { return null; }
  const oldTxt = b64ToTextCore(m[1]);
  const newTxt = b64ToTextCore(m[2]);
  if (!oldTxt && !newTxt) { return null; }
  const stat = diffStatOf(oldTxt, newTxt);
  return hasVisibleDiff(stat) ? stat : null;
}
