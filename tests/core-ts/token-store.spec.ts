import { describe, it, expect, vi } from "vitest";
import { TokenStore } from "../../gateway-ts/src/tokenStore.js";

const MIN = 60_000;

describe("TokenStore", () => {
  describe("resolve", () => {
    it("命中启用令牌", () => {
      const s = new TokenStore([{ key: "slime_abc123", label: "测试" }]);
      expect(s.resolve("slime_abc123")?.label).toBe("测试");
    });

    it("未命中 / 空 / 停用 → null", () => {
      const s = new TokenStore([
        { key: "slime_active" },
        { key: "slime_off", active: false },
      ]);
      expect(s.resolve("nope")).toBeNull();
      expect(s.resolve("")).toBeNull();
      expect(s.resolve(null)).toBeNull();
      expect(s.resolve("slime_off")).toBeNull();
      expect(s.resolve("slime_active")).not.toBeNull();
    });

    it("key 太短抛错", () => {
      expect(() => new TokenStore([{ key: "abc" }])).toThrow();
    });
  });

  describe("checkModel（模型白名单）", () => {
    it("空白名单放行一切", () => {
      const s = new TokenStore([{ key: "slime_k1" }]);
      const d = s.resolve("slime_k1")!;
      expect(s.checkModel(d, "gpt-4o")).toBe(true);
      expect(s.checkModel(d, "any-model")).toBe(true);
    });

    it("白名单精确匹配（纯名）", () => {
      const s = new TokenStore([{ key: "slime_k2", models: ["gpt-4o", "deepseek-chat"] }]);
      const d = s.resolve("slime_k2")!;
      expect(s.checkModel(d, "gpt-4o")).toBe(true);
      expect(s.checkModel(d, "claude")).toBe(false);
    });

    it("白名单同时接受 provider:模型 写法", () => {
      const s = new TokenStore([{ key: "slime_k3", models: ["gpt-4o"] }]);
      const d = s.resolve("slime_k3")!;
      expect(s.checkModel(d, "openai:gpt-4o")).toBe(true); // bare 命中
      expect(s.checkModel(d, "openai:claude")).toBe(false);
    });

    it("未指定模型（/v1/models 列表）不校验白名单", () => {
      const s = new TokenStore([{ key: "slime_k4", models: ["gpt-4o"] }]);
      const d = s.resolve("slime_k4")!;
      expect(s.checkModel(d, "")).toBe(true);
      expect(s.checkModel(d, undefined)).toBe(true);
    });
  });

  describe("checkRate（分钟速率 + 日配额）", () => {
    it("未配置限流 → 全放行，剩余 undefined", () => {
      const s = new TokenStore([{ key: "slime_free" }]);
      const d = s.resolve("slime_free")!;
      const r = s.checkRate(d);
      expect(r.ok).toBe(true);
      expect(r.remainingRate).toBeUndefined();
      expect(r.remainingQuota).toBeUndefined();
    });

    it("分钟速率：超过上限被拒", () => {
      let t = 0;
      const s = new TokenStore([{ key: "slime_rate", ratePerMin: 2 }], { now: () => t });
      const d = s.resolve("slime_rate")!;
      expect(s.checkRate(d).ok).toBe(true); t += 1000; // t=1000
      expect(s.checkRate(d).ok).toBe(true); t += 1000; // t=2000
      const third = s.checkRate(d); // t=2000 时已有 2 条，触发拒绝
      t += 1000;
      expect(third.ok).toBe(false);
      expect(third.reason).toBe("rate");
    });

    it("分钟速率跨窗口恢复", () => {
      let t = 0;
      const s = new TokenStore([{ key: "slime_rate2", ratePerMin: 1 }], { now: () => t });
      const d = s.resolve("slime_rate2")!;
      expect(s.checkRate(d).ok).toBe(true); // t=0
      t = MIN + 1000; // 下一个窗口
      expect(s.checkRate(d).ok).toBe(true);
    });

    it("日配额：超过上限被拒", () => {
      const dateNow = vi.fn(() => new Date("2026-09-11T05:00:00Z"));
      const s = new TokenStore([{ key: "slime_quota", dailyQuota: 3 }], { dateNow });
      const d = s.resolve("slime_quota")!;
      expect(s.checkRate(d).ok).toBe(true);
      expect(s.checkRate(d).ok).toBe(true);
      expect(s.checkRate(d).ok).toBe(true);
      const over = s.checkRate(d);
      expect(over.ok).toBe(false);
      expect(over.reason).toBe("quota");
    });

    it("日配额跨 UTC 日期清零", () => {
      let day = new Date("2026-09-11T00:00:00Z");
      const s = new TokenStore([{ key: "slime_quota2", dailyQuota: 1 }], { dateNow: () => day });
      const d = s.resolve("slime_quota2")!;
      expect(s.checkRate(d).ok).toBe(true); // 第1天
      expect(s.checkRate(d).ok).toBe(false); // 第1天耗尽
      day = new Date("2026-09-12T00:00:00Z"); // 第2天
      expect(s.checkRate(d).ok).toBe(true);
    });

    it("速率通过但配额耗尽 → 整体拒绝（reason=quota）", () => {
      const dateNow = vi.fn(() => new Date("2026-09-11T00:00:00Z"));
      const s = new TokenStore([{ key: "slime_mix", ratePerMin: 10, dailyQuota: 1 }], { dateNow });
      const d = s.resolve("slime_mix")!;
      expect(s.checkRate(d).ok).toBe(true); // 1
      const over = s.checkRate(d); // 配额第2次耗尽
      expect(over.ok).toBe(false);
      expect(over.reason).toBe("quota");
    });

    it("remainingRate / remainingQuota 回写（限放行时）", () => {
      let t = 0;
      const s = new TokenStore([{ key: "slime_left", ratePerMin: 5, dailyQuota: 10 }], {
        now: () => t,
        dateNow: () => new Date("2026-09-11T00:00:00Z"),
      });
      const d = s.resolve("slime_left")!;
      const r = s.checkRate(d);
      expect(r.remainingRate).toBe(4);
      expect(r.remainingQuota).toBe(9);
    });
  });

  describe("list / remove / generateKey", () => {
    it("list 返回全部，remove 删除", () => {
      const s = new TokenStore([{ key: "slime_token_a" }, { key: "slime_token_b" }]);
      expect(s.list().map((x) => x.key).sort()).toEqual(["slime_token_a", "slime_token_b"]);
      expect(s.remove("slime_token_a")).toBe(true);
      expect(s.list().length).toBe(1);
      expect(s.remove("slime_token_x")).toBe(false);
    });

    it("generateKey 返回 ≥24 字符且前缀正确", () => {
      const k = TokenStore.generateKey();
      expect(k.startsWith("slime_")).toBe(true);
      expect(k.length).toBeGreaterThanOrEqual(24);
      expect(k).not.toBe(TokenStore.generateKey()); // 随机性
    });
  });
});
