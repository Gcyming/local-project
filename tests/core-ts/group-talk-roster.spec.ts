




















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { GROUP_MAX_PARTICIPANTS, groupParticipantIds, isGroupRosterFull } from "../../shared/gen/groupRoster.js";





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
    
    const ids = groupParticipantIds("L", ["a", "b", "c", "d", "e"]);
    expect(ids.length).toBe(GROUP_MAX_PARTICIPANTS);
    expect(isGroupRosterFull(ids.length)).toBe(true);
    
    const roomier = groupParticipantIds("L", ["a", "b", "c"]);
    expect(roomier.length).toBe(GROUP_MAX_PARTICIPANTS - 1);
    expect(isGroupRosterFull(roomier.length)).toBe(false);
  });
});








describe("A-1012 源码守卫：席位上限只有一个出处（引擎与建群弹窗共用）", () => {
  const main = codeOf("gui/src/main/index.ts");
  const dialog = codeOf("gui/src/renderer/pages/NewProjectDialog.tsx");

  it("引擎侧用共享纯函数组装参与名单", () => {
    expect(main).toContain("groupParticipantIds(");
  });

  it("引擎侧不再有内联席位截断（`.slice(0, 5)` 一律视为回归）", () => {
    
    expect(main).not.toMatch(/\.slice\(\s*0\s*,\s*5\s*\)/);
    
    expect(main).not.toMatch(/\]\s*\.slice\(\s*0\s*,\s*\d+\s*\)\s*;/);
  });

  it("成员组装锚点附近不得出现任何截断（覆盖 `.filter(…).slice(…, N)` 这类更宽的形态）", () => {
    
    
    
    const anchor = "memberIdsOf(brainMeta!.members)";
    const at = main.indexOf(anchor);
    expect(at, "组装锚点找不到 —— 组装结构被改动了，请同步更新本守卫").toBeGreaterThan(-1);
    
    const window = main.slice(Math.max(0, at - 140), at + 400);
    
    expect(window).toContain("groupParticipantIds(");
    expect(window).not.toContain(".slice(");
  });

  it("建群弹窗引用同一个上限常量与满员判据（不许自己写 5）", () => {
    expect(dialog).toContain("GROUP_MAX_PARTICIPANTS");
    expect(dialog).toContain("isGroupRosterFull(");
    
    
    
    expect(dialog).not.toMatch(/members\.length\s*(?:>=|>|<|<=)\s*(?!2\b)\d/);
  });

  it("弹窗的**唯一入群入口**有兜底守卫（新增受上限约束、换模型不受限）", () => {
    
    
    const fn = dialog.slice(dialog.indexOf("const joinDraftMember"));
    const body = fn.slice(0, fn.indexOf("leaveDraftMember"));
    expect(body).toContain("isGroupRosterFull(prev.length)");
    
    expect(body.indexOf("if (idx >= 0)")).toBeLessThan(body.indexOf("isGroupRosterFull(prev.length)"));
  });

  it("共享模块保持零依赖（渲染进程无 Node 能力，必须能被安全导入）", () => {
    const src = readFileSync(join(PROJECT_ROOT, "shared/gen/groupRoster.ts"), "utf8");
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
    expect(imports, `groupRoster.ts 不该有 import 语句（当前：${imports || "无"}）`).toBe("");
  });
});
