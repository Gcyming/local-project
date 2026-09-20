/**
 * session-member-effort.spec.ts — 群聊成员推理强度（A-1011）派生/纯函数回归。
 * 只测 core-ts/src/services/sessions.ts 的两个纯函数，不碰 fs、不写 config/（目录已加固，任何写入都会 PermissionError）。
 * 锁死语义：
 *  - memberEffortsOf：仅收录 { id, effort } 形态；纯 string / 仅 model 无 effort 不产生键；空/undefined 输入返回 {}。
 *  - applyMemberEffort：写入升级 string→对象、对象补 effort；清除后无 model 还原纯 string、有 model 保留对象；
 *    effort=null 与 effort="" 等价；id 未命中返回 null 且不修改原数组；未命中/变化时返回新数组（引用语义由 null 表达"未命中"）。
 *  - memberIdsOf / memberModelsOf 对带 effort 的新成员形态不得退化（回归保护）。
 */
import { describe, it, expect } from "vitest";
import {
  type MemberEntry,
  memberIdsOf,
  memberModelsOf,
  memberEffortsOf,
  applyMemberEffort,
} from "../../core-ts/src/services/sessions.js";

describe("memberEffortsOf", () => {
  it("空/undefined 输入返回 {}", () => {
    expect(memberEffortsOf(undefined)).toEqual({});
    expect(memberEffortsOf([])).toEqual({});
  });

  it("纯字符串条目被忽略", () => {
    expect(memberEffortsOf(["a", "b"])).toEqual({});
  });

  it("{id, effort} 被收录", () => {
    expect(memberEffortsOf([{ id: "a", effort: "low" }, { id: "b", effort: "high" }])).toEqual({ a: "low", b: "high" });
  });

  it("{id, model}（无 effort）不产生键", () => {
    expect(memberEffortsOf([{ id: "a", model: "api:x:y" }, "b"])).toEqual({});
  });

  it("混合形态：仅带 effort 的对象参与", () => {
    const entries: MemberEntry[] = ["plain", { id: "m", model: "api:x:y" }, { id: "e", effort: "medium" }];
    expect(memberEffortsOf(entries)).toEqual({ e: "medium" });
  });
});

describe("applyMemberEffort（写入）", () => {
  it('纯字符串条目 "a" 设置 "low" → { id:"a", effort:"low" }', () => {
    const out = applyMemberEffort(["a", "b"], "a", "low");
    expect(out).toEqual([{ id: "a", effort: "low" }, "b"]);
  });

  it('已有 {id:"b", model} 设置 effort → 保留 model 且带 effort', () => {
    const out = applyMemberEffort([{ id: "b", model: "api:x:y" }], "b", "high");
    expect(out).toEqual([{ id: "b", model: "api:x:y", effort: "high" }]);
  });

  it("其余条目保持原引用（未被重写的对象引用不变）", () => {
    const kept = { id: "b", model: "api:x:y" };
    const arr: MemberEntry[] = ["a", kept];
    const out = applyMemberEffort(arr, "a", "low");
    expect(out).not.toBeNull();
    expect(out![1]).toBe(kept); // 同引用
  });

  it("返回的是新数组（不修改入参）", () => {
    const arr: MemberEntry[] = ["a"];
    const out = applyMemberEffort(arr, "a", "low");
    expect(out).not.toBe(arr);
    expect(arr).toEqual(["a"]);
  });
});

describe("applyMemberEffort（清除）", () => {
  it('{id:"a", effort:"low"} 清除 → "a"（还原纯字符串）', () => {
    expect(applyMemberEffort([{ id: "a", effort: "low" }], "a", null)).toEqual(["a"]);
    expect(applyMemberEffort([{ id: "a", effort: "low" }], "a", "")).toEqual(["a"]);
  });

  it('{id:"b", model:"m", effort:"low"} 清除 → {id:"b", model:"m"}（仍有 model，保持对象）', () => {
    const expected = [{ id: "b", model: "m" }];
    expect(applyMemberEffort([{ id: "b", model: "m", effort: "low" }], "b", null)).toEqual(expected);
    expect(applyMemberEffort([{ id: "b", model: "m", effort: "low" }], "b", "")).toEqual(expected);
  });

  it("effort=null 与 effort='' 等价（均清除）", () => {
    const withNull = applyMemberEffort([{ id: "a", effort: "low" }], "a", null);
    const withEmpty = applyMemberEffort([{ id: "a", effort: "low" }], "a", "");
    expect(withNull).toEqual(withEmpty);
    expect(withNull).toEqual(["a"]);
  });
});

describe("applyMemberEffort（未命中）", () => {
  it("id 不在列表中 → 返回 null（且原数组不被修改）", () => {
    const arr: MemberEntry[] = ["a", "b"];
    const before = JSON.stringify(arr);
    const out = applyMemberEffort(arr, "z", "low");
    expect(out).toBeNull();
    expect(JSON.stringify(arr)).toBe(before);
  });

  it("undefined 列表未命中 → null", () => {
    expect(applyMemberEffort(undefined, "a", "low")).toBeNull();
  });
});

describe("memberIdsOf / memberModelsOf 对 effort 新形态（回归保护）", () => {
  it("带 effort 的对象条目不影响 memberIdsOf / memberModelsOf 结果", () => {
    const entries: MemberEntry[] = [
      "plain",
      { id: "b", model: "api:x:y" },
      { id: "e", effort: "low" },
      { id: "both", model: "api:p:q", effort: "high" },
    ];
    expect(memberIdsOf(entries)).toEqual(["plain", "b", "e", "both"]);
    expect(memberModelsOf(entries)).toEqual({ b: "api:x:y", both: "api:p:q" });
  });
});
