/**
 * groupRoster.ts — 群聊席位（参与名单）上限与判据的**唯一实现**（A-1012）。
 *
 * 为什么要有这个文件：
 * 群聊引擎侧曾把成员组装写成 `].filter(去重).slice(0, 5)` 一个内联字面量，而界面上
 * 没有任何地方知道这个 5 —— 于是用户能邀请 7 个 Agent 进群，第 6、7 张卡照样显示、
 * 照样能点「思考·X」、状态永远停在"待命"，但引擎**从不读它们**（静默丢弃）。
 * 这类"一个规则两处实现/一处实现零处知晓"在本项目已出过多次事故（取价优先级、联网开关口径），
 * 所以这里把上限与判据收成**零依赖纯模块**，引擎与界面共用：
 *   - 引擎：`gui/src/main/index.ts` 用它算出真正送进 runGroupTalk 的名单；
 *   - 界面：建群弹窗（`NewProjectDialog.tsx`）用它拦住第 N+1 位成员。
 * 两头同源 → 不可能再漂移。
 *
 * ⚠️ 改这个上限值时**只需改这里**，任何地方都不许再写 `slice(0, 5)` 或字面量 5。
 * 守卫：`tests/core-ts/group-talk-roster.spec.ts`。
 *
 * 零依赖：可以被渲染进程（无 Node 能力）安全导入，也可被 main / core-ts 导入。
 */

/**
 * 群聊单轮最多参与的 Agent 数（**含组长**）。
 *
 * 为什么是 5：一轮群聊里每位成员都要独立跑一次上游推理（contest 模式下还并行预研 + 互看回应），
 * 席位越多，单轮的 token 成本与"互相复读"概率越高。这个值目前是产品取舍，不是模型硬限制。
 */
export const GROUP_MAX_PARTICIPANTS = 5;

/**
 * 算出群聊**实际参与**的成员 id 名单（顺序即优先顺序，超限者在尾部被截掉）。
 *
 * 规则（与引擎组装逐字对应）：
 *  1. **组长永远在第 0 位**且不受 max 影响被挤掉——他是会话归属 Agent，群聊轮次由他承载；
 *  2. 其余成员按 `memberIds` 给定顺序补齐；
 *  3. **按 id 去重**（`session.members` 理论上不含组长，但旧数据/重设名单可能带，
 *     引擎原来是靠 `findIndex(...) === i` 去重的，这里承接同一语义）；
 *  4. 空串 / 非字符串一律跳过（脏数据不该占席位，否则一个空 id 会把真实成员挤出去）；
 *  5. 取满 `max` 即停止。
 *
 * @param leaderId  组长（会话归属 Agent）id；空值则视为没有组长，不占席位
 * @param memberIds 成员 id 列表（有序）
 * @param max       席位上限，默认 {@link GROUP_MAX_PARTICIPANTS}
 * @returns 参与名单（已去重、已截断）；入参全空时返回 `[]`
 */
export function groupParticipantIds(
  leaderId: string | null | undefined,
  memberIds: readonly (string | null | undefined)[] | null | undefined,
  max: number = GROUP_MAX_PARTICIPANTS,
): string[] {
  // 非法上限（NaN/负/非整数）一律当 0 处理——宁可算出空名单让调用方显式发现，
  // 也不要"上限失效 → 无限收人"这种静默失控。
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (id: string | null | undefined): void => {
    if (typeof id !== "string" || id === "" || seen.has(id) || out.length >= cap) { return; }
    seen.add(id);
    out.push(id);
  };
  take(leaderId);
  for (const id of memberIds ?? []) { take(id); }
  return out;
}

/**
 * 该会话是否**已达/超出**群聊席位上限（建群弹窗据此禁用候选、引擎据此决定要不要提示）。
 * 只看"人数"不看"是谁"——满员时换人（改模型）不受限，只有新增受限于 {@link GROUP_MAX_PARTICIPANTS}。
 *
 * @param memberCount 当前人数（**含组长**，与 {@link groupParticipantIds} 的输出口径一致）
 * @param max         席位上限，默认 {@link GROUP_MAX_PARTICIPANTS}
 */
export function isGroupRosterFull(memberCount: number, max: number = GROUP_MAX_PARTICIPANTS): boolean {
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  return memberCount >= cap;
}
