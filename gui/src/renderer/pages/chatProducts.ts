/**
 * gui/src/renderer/pages/chatProducts.ts — 聊天「产物卡 / 工具留痕」的**纯逻辑**（A-1007）。
 *
 * **为什么独立成模块（A-990）**：这些函数原先直接写在 `ChatPanel.tsx` 里（5000+ 行的组件）。
 * 于是 `tests/core-ts/gui-products.spec.ts` 想测一个纯字符串函数，只能
 * `import { extractProducts } from ".../ChatPanel.js"` —— 测试的模块图里因此出现
 * **整个 React 组件**（含 15 个 svg 资源导入、Portal、Markdown 渲染器…）。
 * 后果不是"慢一点"，而是**耦合**：组件里加一个 svg 导入，就会让根工程的类型检查全线报红
 * （本仓库真发生过：17 条 TS2307）。纯逻辑与视图分家之后，测试只依赖纯模块，
 * 组件怎么长大都与它无关。
 *
 * 本模块**不得**出现：React / JSX / DOM / 静态资源导入。它只做字符串与数组处理，
 * 因此在 Node（vitest）与渲染进程里行为完全一致 —— 这点很重要，见下面 `b64ToText` 的教训。
 */

/**
 * 工具留痕事件（阶段卡工具行 / 产物卡的数据源）。
 *
 * 为什么放在本模块而不是组件里：它是 `extractProducts` 的**输入契约**，同时也是
 * ChatPanel 时间线/工具行共用的类型。放在无 JSX 的模块里，任何消费者（含测试）
 * 都能拿到真实类型，而不必为了一个 interface 去 import 一个 5000 行的组件。
 *
 * 教训（A-990）：此前它只在组件内可见，测试于是自造 `Ev` 再 `as Ev[]` 强转 ——
 * 强转把"字段对不上"藏成了 9 条类型错。导出真实类型后，新增必填字段会在 **tsc** 阶段
 * 就让测试失败，而不是等运行时字段缺失。
 */
export interface ToolEvent {
  id: number;
  /** 原始 tool name（如 web_search、delegate:alice） */
  name: string;
  /** 用户可见标签（已语义化） */
  label: string;
  /** A-162：具体抓手（访问的网址 / 查询词 / 文件路径），供阶段卡工具行展示 */
  detail?: string;
  /** A-172：工具执行结果（上游已截断 200 字符；成功=返回内容，失败=失败原因表述） */
  result?: string;
}

/** A-1007：产物卡条目。kind 为写/读（暂无删除类工具，删除体现为 diff 的红色 - 行）。 */
export type ProductKind = "write" | "read";
export interface ProductItem {
  rel: string;
  name: string;
  kind: ProductKind;
  ext: string;
  /** 变更统计（+n -m）——由 file_write result 内嵌 [__slime_diff__] 标记解析 */
  diff?: { add: number; del: number };
  /** 变更全文（old/new 原文）——产物卡点击展开 diff 详情用；超过大小上限省略 */
  diffFull?: { old: string; new: string };
  /**
   * A-1029：**详情被持久化限流省略过**（只丢 `diffFull`，`diff` 计数仍在）。
   *
   * 为什么必须有这个标记：产物卡的 `diffFull` 要进 localStorage（会话级），而 localStorage
   * 每 origin 只有约 5MB —— 一条 40 万字符的 diffFull 就能吃掉 8%。所以落盘必须限流，
   * 但限流**不能静默**（A-1029 的整条教训就是这个）：打了这个标记，界面才能如实说
   * "详情未随记录保存"，而不是让用户点开一片空白、以为是坏了。
   */
  diffTrimmed?: boolean;
}

/**
 * base64 → UTF-8 文本。**渲染进程绝对不能用 `Buffer`**。
 *
 * ⚠️ 这是一个"测试全绿、线上全废"的经典环境差事故（A-979）：
 * 主进程 BrowserWindow 是 `contextIsolation: true, sandbox: true, nodeIntegration: false`，
 * 渲染层**没有 `Buffer` 全局**，`Buffer.from(...)` 抛 `ReferenceError`；
 * 而 `parseDiffStat/parseDiffFull` 里的 `try/catch` 会把它吞成 `null` ——
 * 于是"产物卡的 +n/-m"与"工具行的红绿 diff 块"**全部静默失效**，一行报错都没有。
 * 更隐蔽的是 `gui-products.spec.ts` 在 **Node 里**跑（那里有 Buffer）→ 测试 100% 通过。
 * 结论：渲染层一律用 `atob` + `TextDecoder`，并且**加源码守卫禁止 `Buffer.` 出现在 renderer**。
 */
function b64ToText(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) { bytes[i] = bin.charCodeAt(i); }
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}

/**
 * 从工具结果文本里**彻底剥离** `[__slime_diff__]old|new[/__slime_diff__]` 机器标记。
 *
 * 为什么要"彻底"而不是"配对就删"：这个标记是给**程序**读的（base64 全文，动辄几十 KB），
 * 一旦原样漏进界面就是截图里那几行乱码。而它可能因为任何一环截断/中断而**不闭合**
 * （工具结果有 1200/24000 字符两道截断、流式可被打断、历史记录可能来自旧版本）。
 * 只处理"配对成功"的情况 = 只要有一处不配对，用户就会看到一整屏 base64。
 * 故分三步：① 删配对标记；② 删未闭合的起始标记**及其后全部内容**；③ 删孤立结束标记。
 */
export function stripDiffTag(raw: string | undefined): string {
  if (!raw || !raw.includes("__slime_diff__")) { return raw ?? ""; }
  return raw
    .replace(/\[__slime_diff__\][\s\S]*?\[\/__slime_diff__\]/g, "")
    .replace(/\[__slime_diff__\][\s\S]*$/g, "")
    .replace(/\[\/__slime_diff__\]/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** 产物卡工具集——diff 变更统计解析：解析 file_write result 内嵌的
 *  [__slime_diff__]base64(old)|base64(new)[/__slime_diff__] 变更统计（A-172 同款标记）：
 *  行级近似（new 相对 old 净增/净删行数）；无标记/base64 损坏 → null（不显示 +n -m）。 */
export function parseDiffStat(result: string | undefined): { add: number; del: number } | null {
  if (!result) { return null; }
  const m = /\[__slime_diff__\]([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\[\/__slime_diff__\]/.exec(result);
  if (!m) { return null; }
  const oldTxt = b64ToText(m[1]);
  const newTxt = b64ToText(m[2]);
  if (!oldTxt && !newTxt) { return null; }
  const oldLines = new Set(oldTxt.split("\n"));
  const newLines = new Set(newTxt.split("\n"));
  let add = 0, del = 0;
  for (const l of newLines) { if (l && !oldLines.has(l)) { add += 1; } }
  for (const l of oldLines) { if (l && !newLines.has(l)) { del += 1; } }
  return add > 0 || del > 0 ? { add, del } : null;
}

/**
 * A-1029：**内联 diff 用于渲染时**的字符上限（old + new 合计）。
 *
 * ⚠️ 这里原先是硬编码 `20000`，是一道**静默悬崖**，代价实测：
 * 本仓库 `config/history.jsonl` 里带 diff 标记的 `file_write` 共 14 处，**5 处（36%）超过 20000 被丢**；
 * 而且用户能明确感知到"以前能看、现在看不了"——同一个 `index.html` 从 13.9k 字符长到 27.2k 就越过阈值，
 * **变更详情从此永久消失，界面上一个字的提示都没有**（用户截图那两次写入 24481 / 27219 字符全在内）。
 *
 * 为什么可以给这么大：渲染路径**不经过 localStorage**，只受"一次 LCS 的行数"约束，
 * 而外层容器本来就有 `maxHeight: 340 + overflowY: auto` 兜住视觉；历史最大值约 4.8 万字符，
 * 这里留了 8 倍余量。真正需要保守的是**落盘**那条路，单独限流见 `PRODUCT_DIFF_PERSIST_MAX`。
 */
export const DIFF_FULL_MAX_RENDER = 400000;

/**
 * A-1029：**单条 `diffFull` 进 localStorage** 的字符上限（old + new 合计）。
 *
 * 为什么落盘必须比渲染保守得多：产物卡按会话级 key 存进 localStorage，而 localStorage
 * 每 origin 只有约 5MB。一个会话几十个产物，若每条都放行 40 万字符，几次就撑爆配额
 * （`setItem` 抛 QuotaExceededError → 被 `catch` 吞掉 → **产物卡整体静默不持久化**）。
 * 超限的条目**只丢 `diffFull`、保留 `diff` 计数**，并打 `diffTrimmed` 让界面如实说明，
 * 而不是让用户点开一片空白。
 */
export const PRODUCT_DIFF_PERSIST_MAX = 120000;

/**
 * A-1029：**落盘前**的产物瘦身——把超过 localStorage 上限的 `diffFull` 摘掉并打标记。
 *
 * 必须在**写**的入口做（`writeSessionProducts` 内部调用），而不是在每个调用点各做一次：
 * 限流是一份策略，散成多处就必然漂移（本项目"同一动作只有一个入口/一份实现"的规矩）。
 * 摘掉的是**磁盘副本**，内存里那份完整 `diffFull` 不受影响 → 本轮对话照常能看全。
 */
export function slimProductsForPersist(products: ProductItem[]): ProductItem[] {
  return products.map((p) => {
    if (!p.diffFull) { return p; }
    if (p.diffFull.old.length + p.diffFull.new.length <= PRODUCT_DIFF_PERSIST_MAX) { return p; }
    const { diffFull: _drop, ...rest } = p;
    return { ...rest, diffTrimmed: true };
  });
}

/**
 * A-1029：一条「写入文件」留痕该给出哪种**可见的降级说明**？
 *
 * 为什么是一个独立的纯函数（而不是两处 JSX 里各写一遍条件）：A-1029 的整条教训就是
 * **失败被吞掉**——"有改动计数、却拿不到前后全文"时界面什么都不说。这种"该不该说话"的
 * 判据一旦散进 `.tsx` 的条件表达式里，就只能靠"字符串还在不在源码里"来守卫，
 * 而字符串守卫抓不住 `false && 原条件`（一改就静默失效，守卫照样全绿 —— 实测过）。
 * 所以判据必须住在这里，由行为测试盯，`.tsx` 只负责把返回值映射成文案。
 *
 * 三档语义（`null` = 没什么可说）：
 *   - `"too-large"`：有改动计数、但解析不出全文 → 本次**未内联**展示（超渲染上限）
 *   - `"trimmed"`  ：全文曾因落盘限流被摘掉（`slimProductsForPersist`）→ 详情未随记录保存
 *   - `null`       ：拿到全文了（无需说明），或压根没有改动信息
 *
 * `hasFullText` 优先级最高：有全文就永远不需要降级说明，哪怕 `trimmed` 因为历史数据而残留。
 */
export type DiffNotice = "too-large" | "trimmed" | null;

export function diffNoticeKind(
  diff: { add: number; del: number } | null | undefined,
  hasFullText: boolean,
  trimmed: boolean,
): DiffNotice {
  if (hasFullText) { return null; }
  if (trimmed) { return "trimmed"; }
  if (diff) { return "too-large"; }
  return null;
}

/** 解析 file_write result 内嵌 diff 标记的**全文**（old/new 原文，产物卡点击展开 diff 详情用）。
 *  与 parseDiffStat 同规：无标记/base64 损坏/空串 → null。
 *
 *  ⚠️ A-1029：`maxChars` 的**默认值是渲染上限**（`DIFF_FULL_MAX_RENDER`），不再是那个会静默丢弃
 *  用户数据的 20000。落盘路径请勿依赖本函数的默认值去限流 —— 那是 `slimProductsForPersist` 的职责
 *  （两者取舍不同：一个怕卡渲染，一个怕撑爆 localStorage）。 */
export function parseDiffFull(result: string | undefined, maxChars = DIFF_FULL_MAX_RENDER): { old: string; new: string } | null {
  if (!result) { return null; }
  const m = /\[__slime_diff__\]([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\[\/__slime_diff__\]/.exec(result);
  if (!m) { return null; }
  const oldTxt = b64ToText(m[1]);
  const newTxt = b64ToText(m[2]);
  if (!oldTxt && !newTxt) { return null; }
  if (oldTxt.length + newTxt.length > maxChars) { return null; }
  return { old: oldTxt, new: newTxt };
}

/** 行级 diff（LCS 回溯，保序）：old/new 逐行标 eq/add/del——产物卡展开后的红绿 diff 详情。
 *  纯函数，vitest 可直测。行数受 parseDiffFull 20k 字符上限约束，DP 表规模可控。 */
export function diffLines(oldTxt: string, newTxt: string): Array<{ type: "eq" | "add" | "del"; text: string }> {
  const a = oldTxt ? oldTxt.split("\n") : [];
  const b = newTxt ? newTxt.split("\n") : [];
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ type: "eq" | "add" | "del"; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "eq", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
    else { out.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: "del", text: a[i] }); i++; }
  while (j < m) { out.push({ type: "add", text: b[j] }); j++; }
  return out;
}

/** 从工具留痕提炼本轮真实产物文件（纯函数）——
 *  优先 file_write（写/改），file_read 作补充；去重、过滤 URL/空串/非文件；写入者排前。
 *  file_write 的 result 若带 [__slime_diff__] 标记 → 附 diff 变更统计 + diffFull 全文（点击产物卡展开详情）。
 *  返回 { ext, ... } 均带扩展名以备 `productIconUrl` 映射图标。 */
export function extractProducts(events: ToolEvent[]): ProductItem[] {
  const out: ProductItem[] = [];
  const wrote = new Set<string>();
  const reads: Array<{ rel: string; name: string; ext: string }> = [];
  const base = (rel: string): string => (rel.split(/[\\/]/).pop() ?? rel);
  const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");
  for (const t of events) {
    if (t.name !== "file_write" && t.name !== "file_read") { continue; }
    const rel = (t.detail ?? "").trim();
    if (!rel || /^https?:\/\//i.test(rel)) { continue; }
    const name = base(rel);
    const ext = extOf(name);
    if (t.name === "file_write") {
      if (wrote.has(rel)) { continue; }
      wrote.add(rel);
      const diff = parseDiffStat(t.result);
      const diffFull = parseDiffFull(t.result);
      out.push(diff
        ? diffFull
          ? { rel, name, kind: "write", ext, diff, diffFull }
          : { rel, name, kind: "write", ext, diff }
        : { rel, name, kind: "write", ext });
    } else {
      reads.push({ rel, name, ext });
    }
  }
  for (const r of reads) {
    if (wrote.has(r.rel)) { continue; } // 已作为写产物展示，不再重复
    wrote.add(r.rel);
    out.push({ ...r, kind: "read" });
  }
  return out;
}
