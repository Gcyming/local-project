













import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planReminderText, TODO_RENDER_MAX, type StoredTodo } from "../../core-ts/src/services/todoStore.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const ENGINE = "core-ts/src/services/engine.ts";
const MAIN = "gui/src/main/index.ts";

const t = (id: string, content: string, status: StoredTodo["status"]): StoredTodo => ({ id, content, status });

describe("A-1061①-A 计划复述：真值表（纯函数）", () => {
  it("空表 → null（没有计划就别往上下文里塞一句空话）", () => {
    expect(planReminderText([])).toBeNull();
  });

  it("🐛 全部已完成 → null（那时主进程正在自动清空，复述纯属噪声）", () => {
    expect(planReminderText([t("1", "甲", "completed"), t("2", "乙", "completed")])).toBeNull();
  });

  it("有未完成项 → 给出进度、逐项状态与「不要重做」的明确要求", () => {
    const text = planReminderText([t("1", "装依赖", "completed"), t("2", "写测试", "in_progress"), t("3", "跑门禁", "pending")]);
    expect(text, "有未完成项却不复述 = 中断后必然不接续").not.toBeNull();
    expect(text!).toContain("进度 1/3");
    expect(text!).toContain("写测试");
    expect(text!).toContain("跑门禁");
    expect(text!).toContain("不要重做");
    
    expect(text!).toContain("- [x] 装依赖");
    expect(text!).toContain("- [ ] 跑门禁");
    
    expect(text!).toContain("← 进行中");
  });

  it("只有 pending、没有 completed 的全新计划同样要复述（别把「还没开始」当成「没计划」）", () => {
    const text = planReminderText([t("1", "第一步", "pending")]);
    expect(text).not.toBeNull();
    expect(text!).toContain("进度 0/1");
  });

  it("超长列表按 TODO_RENDER_MAX 截断并如实报出剩余条数（复述不许把上下文撑爆）", () => {
    const many = Array.from({ length: TODO_RENDER_MAX + 5 }, (_, i) => t(String(i), `项 ${i}`, "pending"));
    const text = planReminderText(many)!;
    expect(text).toContain("其余 5 项略");
    expect(text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(TODO_RENDER_MAX);
  });

  it("渲染的是**同一份**待办表（与右栏面板同源，不许另写一套格式）", () => {
    const src = code("core-ts/src/services/todoStore.ts");
    const at = src.indexOf("export function planReminderText");
    const body = src.slice(at, at + 900);
    expect(body).toContain("renderTodos(items)");
    expect(body).toContain("todoProgress(items)");
  });
});

describe("A-1061①-B 接线：每轮开头注入，且放在**最后**", () => {
  it("引擎在 buildMessages 里读该会话的待办并复述", () => {
    const src = code(ENGINE);
    expect(src).toContain("import { readTodos, planReminderText } from \"./todoStore.js\";");
    expect(src).toContain("const reminder = planReminderText(call.sessionId ? readTodos(call.sessionId) : []);");
  });

  it("🐛 复述必须折进消息数组**末尾**（放最前等于沉进中段，复述就白做了）", () => {
    const src = code(ENGINE);
    const atOut = src.indexOf("out = [", src.indexOf("const reminder = planReminderText"));
    
    
    const atFold = src.indexOf("out = foldUserReminder(out, reminder)", atOut);
    





    const afterFold = src.slice(atFold + "out = foldUserReminder(out, reminder);".length);
    const firstReturnAt = afterFold.indexOf("return ");
    expect(atOut, "找不到消息数组构造").toBeGreaterThan(-1);
    expect(atFold, "复述没有折进末尾（应调用 foldUserReminder）").toBeGreaterThan(atOut);
    expect(firstReturnAt, "折入之后没有立刻返回").toBeGreaterThan(-1);
    expect(afterFold.slice(firstReturnAt).startsWith("return out;"),
      `折入之后的第一件事必须是 \`return out;\`（不许再插内容改动）—— 实际是 ${JSON.stringify(afterFold.slice(firstReturnAt, firstReturnAt + 60))}`
    ).toBe(true);
  });

  it("🐛 复述不许造成**非首位 system**（旧写法 push({role:system}) 已废弃）", () => {
    const src = code(ENGINE);
    expect(src, "又用回了会产生非法 system 位置的写法").not.toContain("out.push({ role: \"system\", content: reminder })");
    expect(src).toContain("import { foldUserReminder } from \"../llm/userReminder.js\";");
  });

  it("无 sessionId 时不去读盘（避免把别人的/脏的待办读进来）", () => {
    const src = code(ENGINE);
    expect(src).toContain("planReminderText(call.sessionId ? readTodos(call.sessionId) : [])");
  });

  it("中断路径仍有「进行中 → 待办」降级（否则计划会一直停在「看起来还在跑」）", () => {
    const src = code(MAIN);
    const at = src.indexOf('handleTrusted<{ key?: string }>("slime:chat:cancel"');
    expect(at, "找不到 cancel handler").toBeGreaterThan(-1);
    expect(src.slice(at, at + 900)).toContain("demoteStaleInProgress(key)");
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    
    const naive = (items: StoredTodo[]): string | null => (items.length === 0 ? null : "x");
    expect(naive([t("1", "甲", "completed")])).not.toBeNull();
    expect(planReminderText([t("1", "甲", "completed")])).toBeNull();
  });
});
