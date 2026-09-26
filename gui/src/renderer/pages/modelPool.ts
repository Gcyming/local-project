/**
 * gui/src/renderer/pages/modelPool.ts — A-1098：子代理**执行模型池**的草稿态纯逻辑。
 *
 * ── 为什么要抽成纯模块（而不留在 ResidentPanel.tsx 里）─────────────────────
 * A-1097 把「子代理执行模型」从单值改成多选后，用户实测：
 *   「这是我点击另一个模型的效果……过一会它就自动取消勾选了」。
 * 根因**不在勾选逻辑**，而在**草稿态与已保存态共用了同一个 state**：
 *   · `refresh()` 每 4 秒用主进程快照写 `defaultModels`；
 *   · 弹层里的 checkbox 当时也直接绑在同一个 `defaultModels` 上
 *   ⇒ 用户每勾一项，最多 4 秒后就被**服务端快照回滚**（用户眼里就是"它自己把勾去掉了"）。
 *
 * 修法判据（本轮）：**草稿只由用户手势改，轮询只能改已保存值**。
 * 这条判据是纯逻辑，但此前它"住在"一个 560 行的 .tsx 里 ——
 *   ① 单测覆盖不到（要起 React 才能验）；
 *   ② 无从做变异（改坏了没有任何测试会红，属于「未核验 = 没有保护」）。
 * 抽出来后 `toggleModelInPool` 有单测、有变异脚本，`ResidentPanel` 只负责接线，
 * 把"弹层读写草稿、轮询写已保存"这件事变成可以被机器盯着的不变量。
 *
 * ── 池语义（必须与主进程侧 A-1097 一致）──────────────────────────────────
 *  · 顺序 = 优先级，**第 1 个是兜底档**（主 Agent 不点名时用它）；
 *  · `inherit` 是"不覆盖目标 Agent 模型"的**占位**，不是档位 ⇒ 不允许进池；
 *  · 集合语义：同值不重复；先勾的在前（优先级更高）。
 */

/**
 * `inherit` = "不覆盖目标 Agent 的模型"，是**占位**不是档位。
 * 常量放在这里，是为了让"哪些项能进池"只有**一个出处**：
 * 面板侧过滤选项与池侧拒绝写入都用它，不许各写一份字面量。
 */
export const INHERIT_MODEL = "inherit";

/**
 * 在池里勾选 / 取消勾选一个档位。**不修改入参**（返回新数组，便于 React 判等与回滚）。
 *
 * @param pool    当前池（顺序即优先级，`pool[0]` = 兜底档）
 * @param value   被点的那一项
 * @param checked 目标状态：`true` = 勾上，`false` = 去掉
 * @returns 新池。非法入参（非数组 / 非字符串 / 空串 / `inherit`）**一律原样返回**——
 *          "点了一下却没变化"远好过"往池里塞进一个语义不明的值"。
 */
export function toggleModelInPool(pool: readonly string[], value: string, checked: boolean): string[] {
  // 顺带**自愈**：池里若混进过 `inherit`（历史数据 / 手改配置）就地剔除——
  // 本函数的契约是"返回一个合法池"，不是"原样搬运"。空串同理。
  const cur = Array.isArray(pool)
    ? pool.filter((v) => typeof v === "string" && v !== "" && v !== INHERIT_MODEL)
    : [];
  if (typeof value !== "string" || value === "" || value === INHERIT_MODEL) { return [...cur]; }
  if (checked) {
    // 勾上 = 追加到**末尾**（新勾的优先级最低，不打乱已有排序 —— 顺序即"档位"语义）
    return cur.includes(value) ? [...cur] : [...cur, value];
  }
  return cur.filter((v) => v !== value);
}
