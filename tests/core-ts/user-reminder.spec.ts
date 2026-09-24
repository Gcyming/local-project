/**
 * 守卫：提醒**折进最后一条 user 消息**，而不是新增一条 `role: "system"`。
 *
 * ## 为什么这是协议级缺陷（不是风格问题）
 *
 * A-1061① 的"计划复述"曾实现成 `messages.push({ role: "system", content: reminder })`
 * —— 消息数组里出现了**非首位 system**。同一份数据在四条协议上是四种语义：
 *
 * | 上游 | 非首位 system 的下场 |
 * | --- | --- |
 * | OpenAI 兼容（`agnes` 等网关）| 多数**直接 400**（协议校验） |
 * | Anthropic | 不报错，但 `role === "user" ? "user" : "assistant"` 把它**静默改写成 assistant** |
 * | Responses | 只把 system 收进 `instructions`（**丢掉位置**）|
 * | Gemini | 全部拼进 systemText（丢掉顺序）|
 *
 * ⇒ 判据只有一条、且与实现无关：**system 只允许出现在第 0 位**。
 * 本文件因此**直接断言不变量**（`hasOnlyLeadingSystem`），换实现也不用重写。
 *
 * 变异见 `gui/scripts/mut-a1061-reminder.mjs`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  foldUserReminder, hasOnlyLeadingSystem, type RemindableMessage,
} from "../../core-ts/src/llm/userReminder.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const REMIND = "【计划复述】进度 1/3：…";
const sys = (content = "S"): RemindableMessage => ({ role: "system", content });

describe("userReminder · 不变量：system 只能在第 0 位", () => {
  it("hasOnlyLeadingSystem 放行「首位 system + 任意 user/assistant」", () => {
    expect(hasOnlyLeadingSystem([sys(), { role: "user", content: "u" }])).toBe(true);
    expect(hasOnlyLeadingSystem([sys(), { role: "user", content: "u" }, { role: "assistant", content: "a" }])).toBe(true);
    expect(hasOnlyLeadingSystem([])).toBe(true);
  });

  it("🐛 hasOnlyLeadingSystem 抓住「第二位及之后的 system」", () => {
    expect(hasOnlyLeadingSystem([sys(), { role: "user", content: "u" }, sys("R")])).toBe(false);
    expect(hasOnlyLeadingSystem([sys(), sys("R")])).toBe(false);
  });

  it("🐛 折入之后仍满足不变量（这是本模块存在的全部理由）", () => {
    const msgs: RemindableMessage[] = [sys(), { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "u2" }];
    const out = foldUserReminder(msgs, REMIND);
    expect(hasOnlyLeadingSystem(out)).toBe(true);
    // [反例] 旧写法必须被判死 —— 守卫自检：证明这条判据不是恒真
    const naive = [...msgs, { role: "system", content: REMIND }];
    expect(hasOnlyLeadingSystem(naive)).toBe(false);
  });
});

describe("userReminder · 落点与内容", () => {
  it("🐛 折进**最后一条 user**（不是第一条）—— recency 是复述的全部价值", () => {
    const out = foldUserReminder([
      sys(), { role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }, { role: "user", content: "新问题" },
    ], REMIND) as Array<{ role: string; content: unknown }>;
    expect(out[1]!.content).toBe("旧问题");
    expect(out[out.length - 1]!.role).toBe("user");
    expect(out[out.length - 1]!.content).toContain("新问题");
    expect(out[out.length - 1]!.content).toContain(REMIND);
  });

  it("字符串内容 → 追加一段（原话必须原样保留，不许被顶掉）", () => {
    const out = foldUserReminder([sys(), { role: "user", content: "原话" }], REMIND) as Array<{ content: string }>;
    expect(out[1]!.content).toBe(`原话\n\n${REMIND}`);
  });

  it("内容为空的 user 消息 → 直接放提醒（不产生前导空行）", () => {
    const out = foldUserReminder([sys(), { role: "user", content: "   " }], REMIND) as Array<{ content: string }>;
    expect(out[1]!.content).toBe(REMIND);
  });

  it("🐛 content-blocks 数组（有图那条）→ 追加 text 块，**图片块必须还在**", () => {
    const blocks = [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:x" } }];
    const out = foldUserReminder([sys(), { role: "user", content: blocks }], REMIND) as Array<{ content: Array<{ type: string; text?: string }> }>;
    const c = out[1]!.content;
    expect(Array.isArray(c)).toBe(true);
    expect(c.filter((b) => b.type === "image_url").length).toBe(1);
    expect(c[c.length - 1]!.type).toBe("text");
    expect(c[c.length - 1]!.text).toBe(REMIND);
  });

  it("提醒为空 / 全空白 → **零行为变化**（不制造空消息，也不新增 system）", () => {
    const msgs: RemindableMessage[] = [sys(), { role: "user", content: "u" }];
    expect(foldUserReminder(msgs, "")).toEqual(msgs);
    expect(foldUserReminder(msgs, "   \n\t ")).toEqual(msgs);
    const out = foldUserReminder(msgs, "");
    expect(hasOnlyLeadingSystem(out)).toBe(true);
  });

  it("🐛 没有任何 user 回合（异常调用）→ 追加一条 **user**（仍不许造非首位 system）", () => {
    const out = foldUserReminder([sys()], REMIND) as Array<{ role: string }>;
    expect(out.length).toBe(2);
    expect(out[1]!.role).toBe("user");
    expect(hasOnlyLeadingSystem(out)).toBe(true);
  });

  it("返回**新数组**且不改入参（纯函数 —— 守卫才好直接喂字面量断言）", () => {
    const msgs: RemindableMessage[] = [sys(), { role: "user", content: "u" }];
    const before = JSON.stringify(msgs);
    const out = foldUserReminder(msgs, REMIND);
    expect(out).not.toBe(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

describe("userReminder · 接线：引擎不再 push 一条尾随 system", () => {
  it("引擎改用 foldUserReminder，且旧写法已绝迹", () => {
    const src = code("core-ts/src/services/engine.ts");
    expect(src).toContain('import { foldUserReminder } from "../llm/userReminder.js";');
    expect(src).toContain("out = foldUserReminder(out, reminder)");
    expect(src, "尾随 system 的旧写法必须绝迹（它会让 OpenAI 兼容上游 400）")
      .not.toContain('out.push({ role: "system", content: reminder })');
  });
});
