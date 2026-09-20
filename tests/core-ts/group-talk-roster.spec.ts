/**
 * group-talk-roster.spec.ts — 群聊席位上限与参与名单的回归（A-1012）。
 *
 * ## 这个文件为什么必须存在
 *
 * 症状（用户实测）：「群里邀请 7 个 Agent，第 6 位起在右栏卡片上照样能点『思考·X』、
 * 状态永远停在"待命"，但那位成员**从不发言**」。
 *
 * 根因不是引擎坏了，而是**上限只活在引擎里**：`gui/src/main/index.ts` 的成员组装写成
 * `…].filter(去重).slice(0, 5)` 一个内联字面量，界面上没有任何地方知道这个 5 ——
 * 于是建群弹窗不限量、右栏照常出卡，点了没反应 = 典型的「假旋钮」。
 *
 * 修法不是"把 5 调大"，而是让上限**只有一个出处**（`shared/gen/groupRoster.ts`），
 * 引擎组装参与名单与建群弹窗拦人共用它。所以本文件锁两件事：
 *
 *   1. `groupParticipantIds` / `isGroupRosterFull` 的语义（去重、组长优先、截断、脏值跳过）；
 *   2. **源码守卫**：引擎与弹窗都必须引用这个共享模块，任何一侧再长出硬编码的 5 都要变红
 *      —— 否则下次改上限时又只改一半，界面与引擎重新漂移回"能点但不生效"。
 *
 * 环境：vitest node（纯函数 + 源码文本断言，无 React/DOM）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { GROUP_MAX_PARTICIPANTS, groupParticipantIds, isGroupRosterFull } from "../../shared/gen/groupRoster.js";

/*
 * 剥注释后再断言 —— 三个源文件的注释里都**引用了事故写法本身**（`.slice(0, 5)`、
 * 硬编码 5 的说明），不剥就会被自己写的说明误伤（同 grouptalk-transcript.spec.ts 的手法）。
 */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("A-1012 群聊席位上限：上限值本身是有意识的取舍", () => {
  it("默认上限是 5（含组长）—— 改这个值必须先想清楚成本与复读概率", () => {
    // 不是为了"锁死 5"，而是让改动者**必须**回来读这段注释并同步所有文案/守卫：
    // 5 = 一轮群聊要跑 5 次上游推理（contest 模式还并行预研 + 互看回应）。
    expect(GROUP_MAX_PARTICIPANTS).toBe(5);
  });
});

describe("A-1012 groupParticipantIds：组长优先、按序补齐、去重、截断", () => {
  it("组长永远在第 0 位，其余按 memberIds 顺序补齐", () => {
    expect(groupParticipantIds("leader", ["a", "b", "c"])).toEqual(["leader", "a", "b", "c"]);
  });

  it("未超限时原样返回全部（顺序即优先顺序）", () => {
    expect(groupParticipantIds("L", ["a", "b", "c", "d"])).toEqual(["L", "a", "b", "c", "d"]);
  });

  it("超限时截断到上限，且被截掉的都是**尾部**成员（界面上最靠后的那几张卡）", () => {
    const ids = groupParticipantIds("L", ["a", "b", "c", "d", "e", "f"]);
    expect(ids).toEqual(["L", "a", "b", "c", "d"]);
    expect(ids).not.toContain("e");
    expect(ids).not.toContain("f");
    expect(ids.length).toBe(GROUP_MAX_PARTICIPANTS);
  });

  it("按 id 去重：组长同时出现在 memberIds 里也只占一个席位（不挤掉真实成员）", () => {
    // 引擎原来是靠 `findIndex(...) === i` 去重的；`members` 理论上不含组长，但旧数据会带。
    expect(groupParticipantIds("L", ["L", "a", "b"])).toEqual(["L", "a", "b"]);
  });

  it("重复的成员 id 只占一个席位", () => {
    expect(groupParticipantIds("L", ["a", "a", "b"])).toEqual(["L", "a", "b"]);
  });

  it("空串 / undefined / null 一律不占席位（否则一个脏 id 会把真实成员挤出去）", () => {
    const dirty = ["", null, undefined, "a", "", "b"] as unknown as string[];
    expect(groupParticipantIds("L", dirty)).toEqual(["L", "a", "b"]);
  });

  it("没有组长（空值）时不占席位，成员照常从第 0 位开始", () => {
    expect(groupParticipantIds("", ["a", "b"])).toEqual(["a", "b"]);
    expect(groupParticipantIds(null, ["a"])).toEqual(["a"]);
    expect(groupParticipantIds(undefined, ["a"])).toEqual(["a"]);
  });

  it("入参全空 → 空名单（调用方应据此跳过群聊分支）", () => {
    expect(groupParticipantIds("", [])).toEqual([]);
    expect(groupParticipantIds(null, null)).toEqual([]);
    expect(groupParticipantIds(undefined, undefined)).toEqual([]);
  });

  it("max 可参数化（收窄到 2 时组长 + 1 名成员）", () => {
    expect(groupParticipantIds("L", ["a", "b", "c"], 2)).toEqual(["L", "a"]);
  });

  it("非法 max（0 / 负数 / NaN）→ 空名单，而不是「上限失效后无限收人」", () => {
    // 语义取舍：宁可算出空名单让调用方显式发现配置错了，也不要静默失控。
    expect(groupParticipantIds("L", ["a", "b"], 0)).toEqual([]);
    expect(groupParticipantIds("L", ["a", "b"], -3)).toEqual([]);
    expect(groupParticipantIds("L", ["a", "b"], Number.NaN)).toEqual([]);
  });

  it("不改动入参数组（纯函数，调用方可以放心复用同一份 memberIds）", () => {
    const input = ["a", "b", "c"];
    groupParticipantIds("L", input);
    expect(input).toEqual(["a", "b", "c"]);
  });
});

describe("A-1012 isGroupRosterFull：满员判据（换人不受限，加人才受限）", () => {
  it("到达上限即为满员（含组长口径）", () => {
    expect(isGroupRosterFull(4)).toBe(false);
    expect(isGroupRosterFull(GROUP_MAX_PARTICIPANTS)).toBe(true);
    expect(isGroupRosterFull(GROUP_MAX_PARTICIPANTS + 1)).toBe(true);
  });

  it("max 可参数化，且非法 max 不静默放行", () => {
    expect(isGroupRosterFull(2, 3)).toBe(false);
    expect(isGroupRosterFull(3, 3)).toBe(true);
    expect(isGroupRosterFull(0, 0)).toBe(true);
    expect(isGroupRosterFull(1, Number.NaN)).toBe(true);
  });

  it("与 groupParticipantIds 口径一致：满员时名单长度恰好等于上限", () => {
    // 组长 + 5 名成员 → 被截到上限
    const ids = groupParticipantIds("L", ["a", "b", "c", "d", "e"]);
    expect(ids.length).toBe(GROUP_MAX_PARTICIPANTS);
    expect(isGroupRosterFull(ids.length)).toBe(true);
    // 组长 + 3 名成员 = 4 → 未满员，还能再加一位
    const roomier = groupParticipantIds("L", ["a", "b", "c"]);
    expect(roomier.length).toBe(GROUP_MAX_PARTICIPANTS - 1);
    expect(isGroupRosterFull(roomier.length)).toBe(false);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────
 * 源码守卫：上限只有一个出处，引擎与界面都必须引用它
 * ────────────────────────────────────────────────────────────────────────────
 * 这类"改回去完全不报错"的故障（tsc 绿、单测绿、只有真人建个 7 人群才看得见）
 * 只能把**结构**钉在源码文本上。
 */
describe("A-1012 源码守卫：席位上限只有一个出处（引擎与建群弹窗共用）", () => {
  const main = codeOf("gui/src/main/index.ts");
  const dialog = codeOf("gui/src/renderer/pages/NewProjectDialog.tsx");

  it("引擎侧用共享纯函数组装参与名单", () => {
    expect(main).toContain("groupParticipantIds(");
  });

  it("引擎侧不再有内联席位截断（`.slice(0, 5)` 一律视为回归）", () => {
    // 变红条件 = 有人把上限改回硬编码字面量。此时界面又变成"不知道上限"，假旋钮复现。
    expect(main).not.toMatch(/\.slice\(\s*0\s*,\s*5\s*\)/);
    // 更宽的兜底：任何"截成员数组"的字面量 5 都算（写 6/7 同样是硬编码，一并拦）
    expect(main).not.toMatch(/\]\s*\.slice\(\s*0\s*,\s*\d+\s*\)\s*;/);
  });

  it("成员组装锚点附近不得出现任何截断（覆盖 `.filter(…).slice(…, N)` 这类更宽的形态）", () => {
    // 上面两条正则各有盲区：`.filter(…).slice(0, 7)` 既不匹配 `.slice(0, 5)`，
    // 也因为 `]` 与 `.slice` 之间隔着 `.filter(…)` 而不匹配兜底那条。
    // 所以再按**位置**钉一次：名单函数的锚点之后不允许再出现截断调用。
    const anchor = "memberIdsOf(brainMeta!.members)";
    const at = main.indexOf(anchor);
    expect(at, "组装锚点找不到 —— 组装结构被改动了，请同步更新本守卫").toBeGreaterThan(-1);
    // 锚点是**实参**（在 `groupParticipantIds(` 之后），所以窗口要往前带一段才包住调用本身
    const window = main.slice(Math.max(0, at - 140), at + 400);
    // 反向确认窗口真的覆盖到了名单函数（否则下面的 not.toContain 等于空转）
    expect(window).toContain("groupParticipantIds(");
    expect(window).not.toContain(".slice(");
  });

  it("建群弹窗引用同一个上限常量与满员判据（不许自己写 5）", () => {
    expect(dialog).toContain("GROUP_MAX_PARTICIPANTS");
    expect(dialog).toContain("isGroupRosterFull(");
    // 硬编码上限 = 漂移的开始（改上限时这句不会跟着变）。
    // ⚠️ 负向前查排除 2：`members.length >= 2 / < 2` 是"至少 2 人才能创建群聊"的**业务规则**，
    // 与席位上限无关，误伤它会让守卫长期假红。
    expect(dialog).not.toMatch(/members\.length\s*(?:>=|>|<|<=)\s*(?!2\b)\d/);
  });

  it("弹窗的**唯一入群入口**有兜底守卫（新增受上限约束、换模型不受限）", () => {
    // joinDraftMember 是全项目唯一往 members 里加人的地方；界面禁用只是第一道，
    // 这里断言第二道还在（防将来新增调用点绕过界面）。
    const fn = dialog.slice(dialog.indexOf("const joinDraftMember"));
    const body = fn.slice(0, fn.indexOf("leaveDraftMember"));
    expect(body).toContain("isGroupRosterFull(prev.length)");
    // 已在群里（换模型）必须**先**返回，否则连换模型都会被上限挡住
    expect(body.indexOf("if (idx >= 0)")).toBeLessThan(body.indexOf("isGroupRosterFull(prev.length)"));
  });

  it("共享模块保持零依赖（渲染进程无 Node 能力，必须能被安全导入）", () => {
    const src = readFileSync(join(PROJECT_ROOT, "shared/gen/groupRoster.ts"), "utf8");
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
    expect(imports, `groupRoster.ts 不该有 import 语句（当前：${imports || "无"}）`).toBe("");
  });
});
