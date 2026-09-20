/**
 * tests/gui/todo-panorama.spec.ts — A-980-R32：任务规划折进思考历程（纯函数层）。
 *
 * 这一层的错误全是「看着对、实际串行」——少一条、重复播报、旧卡不刷新、时间线清空后基线残留。
 * 用真实 `renderTodos` 的回执文本形态做输入（而不是手搓理想字符串），
 * 才能覆盖"解析 → 折叠 → 原地刷新"整条链路。
 */
import { describe, it, expect } from "vitest";
import {
  parseTodoPanorama,
  planSignature,
  appendTimelineStep,
  foldTodoWriteIntoSteps,
  lastPlanItems,
  type TimelineStep,
} from "../../gui/src/renderer/pages/todoPanorama.js";

/** 按 core-ts todoStore.renderTodos 的真实形态拼回执（进度头 + `- [x] 内容` + 进行中标记） */
function receipt(items: Array<{ content: string; done?: boolean; doing?: boolean }>): string {
  const done = items.filter((i) => i.done).length;
  const active = items.find((i) => i.doing);
  const head = `进度 ${done}/${items.length}` + (active ? ` · 当前进行中：${active.content}` : " · 当前无进行中项");
  const lines = items.map((i) => `- ${i.done ? "[x]" : "[ ]"} ${i.content}${i.doing ? "   ← 进行中" : ""}`);
  return `${head}\n\n${lines.join("\n")}`;
}

const PLAN3 = [
  { content: "梳理现有登录链路" },
  { content: "抽出鉴权中间件" },
  { content: "补回归用例" },
];

describe("parseTodoPanorama", () => {
  it("解析整表：状态 / 去掉勾选框与进行中标记 / 正文不被污染", () => {
    const raw = receipt([
      { content: "梳理现有登录链路", done: true },
      { content: "抽出鉴权中间件", doing: true },
      { content: "补回归用例" },
    ]);
    const pano = parseTodoPanorama(raw);
    expect(pano?.items.map((i) => i.content)).toEqual(["梳理现有登录链路", "抽出鉴权中间件", "补回归用例"]);
    expect(pano?.items.map((i) => i.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  it("只认带勾选框的行（避免把回执里的说明性 '- ' 当成任务）", () => {
    const raw = "进度 0/1\n\n- 说明：这是一条提示\n- [ ] 真任务";
    expect(parseTodoPanorama(raw)?.items.map((i) => i.content)).toEqual(["真任务"]);
  });

  it("空 / 无清单 / 空列表回执 → null（调用方原样跳过，不产生空规划卡）", () => {
    expect(parseTodoPanorama("")).toBeNull();
    expect(parseTodoPanorama("（待办列表为空）")).toBeNull();
    expect(parseTodoPanorama("已清除 3 项待办")).toBeNull();
  });
});

describe("foldTodoWriteIntoSteps", () => {
  it("首份规划 → 插一张计划卡，且不播报任何「完成」（此前不存在任何项）", () => {
    const items = parseTodoPanorama(receipt(PLAN3))!.items;
    const { steps } = foldTodoWriteIntoSteps([], items, null);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("plan");
    expect(steps[0].items).toHaveLength(3);
    expect(steps.some((s) => s.kind === "todo")).toBe(false);
  });

  it("同一份计划的进度更新 → 就地刷新那张卡（不新增卡），并补「开始 / 完成」两行", () => {
    const first = parseTodoPanorama(receipt(PLAN3))!.items;
    const a = foldTodoWriteIntoSteps([], first, null);
    // 第二项开始做
    const second = parseTodoPanorama(receipt([
      { content: "梳理现有登录链路" },
      { content: "抽出鉴权中间件", doing: true },
      { content: "补回归用例" },
    ]))!.items;
    const b = foldTodoWriteIntoSteps(a.steps, second, a.items);
    expect(b.steps.filter((s) => s.kind === "plan")).toHaveLength(1); // 仍只有一张卡
    expect(b.steps[b.steps.length - 1]).toMatchObject({ kind: "todo", state: "start", text: "抽出鉴权中间件" });

    // 第一项完成 + 第二项完成
    const third = parseTodoPanorama(receipt([
      { content: "梳理现有登录链路", done: true },
      { content: "抽出鉴权中间件", done: true },
      { content: "补回归用例", doing: true },
    ]))!.items;
    const c = foldTodoWriteIntoSteps(b.steps, third, b.items);
    expect(c.steps.filter((s) => s.kind === "plan")).toHaveLength(1);
    expect(c.steps.filter((s) => s.kind === "todo").map((s) => `${s.state}:${s.text}`)).toEqual([
      "start:抽出鉴权中间件",
      "done:梳理现有登录链路",
      "done:抽出鉴权中间件",
      "start:补回归用例",
    ]);
    // 计划卡显示的是**当前**进度：2/3
    const card = c.steps.find((s) => s.kind === "plan")!;
    expect(card.items?.filter((i) => i.status === "completed")).toHaveLength(2);
  });

  it("同一项重复回执不重复播报（幂等）", () => {
    const items = parseTodoPanorama(receipt([
      { content: "A", done: true },
      { content: "B", doing: true },
    ]))!.items;
    const a = foldTodoWriteIntoSteps([], items, null);
    const b = foldTodoWriteIntoSteps(a.steps, items, a.items);
    expect(b.steps.filter((s) => s.kind === "todo")).toHaveLength(0);
    expect(b.steps).toEqual(a.steps);
  });

  it("重规划（条目内容变了）→ 插新卡，旧卡保留为历史，不误报完成", () => {
    const first = parseTodoPanorama(receipt(PLAN3))!.items;
    const a = foldTodoWriteIntoSteps([], first, null);
    const replan = parseTodoPanorama(receipt([
      { content: "改用 OAuth2 托管" },
      { content: "迁移历史会话" },
    ]))!.items;
    const b = foldTodoWriteIntoSteps(a.steps, replan, a.items);
    expect(b.steps.filter((s) => s.kind === "plan")).toHaveLength(2);
    expect(b.steps.filter((s) => s.kind === "todo")).toHaveLength(0); // 内容全变了，不许误判成"完成"
  });

  it("空回执（清除 / 报错）→ 时间线不变，基线保持上一份", () => {
    const items = parseTodoPanorama(receipt(PLAN3))!.items;
    const a = foldTodoWriteIntoSteps([], items, null);
    const b = foldTodoWriteIntoSteps(a.steps, [], a.items);
    expect(b.steps).toEqual(a.steps);
    expect(b.items).toEqual(a.items);
  });

  it("对齐按**内容**而非 id：两套 id 空间（序号 vs uuid）不许刷屏", () => {
    // 模拟 loadTodos 广播来的 uuid id 全景作为基线，回执解析出的却是序号 id
    const uuidBase = PLAN3.map((p, i) => ({ id: `uuid-${i}`, content: p.content, status: "pending" as const }));
    const next = parseTodoPanorama(receipt([
      { content: "梳理现有登录链路", done: true },
      { content: "抽出鉴权中间件" },
      { content: "补回归用例" },
    ]))!.items;
    const { steps } = foldTodoWriteIntoSteps([], next, uuidBase);
    // 只有第一项是真变化；若按 id 对齐，三项都会被当成新项
    expect(steps.filter((s) => s.kind === "todo")).toHaveLength(1);
    expect(steps.find((s) => s.kind === "todo")).toMatchObject({ state: "done", text: "梳理现有登录链路" });
  });
});

describe("lastPlanItems（对比基线与时间线同生共死）", () => {
  it("取最后一张计划卡的全景；时间线被清空后回到 null（新任务不会误播报完成）", () => {
    const items = parseTodoPanorama(receipt(PLAN3))!.items;
    const a = foldTodoWriteIntoSteps([], items, null);
    expect(lastPlanItems(a.steps)).toEqual(items);
    expect(lastPlanItems([])).toBeNull();
    // 清空后重新规划：首条不得被当成"完成"
    const b = foldTodoWriteIntoSteps([], a.items, lastPlanItems([]));
    expect(b.steps.filter((s) => s.kind === "todo")).toHaveLength(0);
  });
});

describe("appendTimelineStep", () => {
  it("think 段合并、tool/plan/todo 各成独立节点（按真实到达顺序交错）", () => {
    let steps: TimelineStep[] = [];
    steps = appendTimelineStep(steps, { kind: "think", text: "看" });
    steps = appendTimelineStep(steps, { kind: "think", text: "一下" });
    steps = appendTimelineStep(steps, { kind: "tool", name: "file_read" });
    steps = appendTimelineStep(steps, { kind: "think", text: "继续" });
    expect(steps.map((s) => s.kind)).toEqual(["think", "tool", "think"]);
    expect(steps[0].text).toBe("看一下");
    expect(steps[2].text).toBe("继续");
    // 空 think 不产生空节点
    expect(appendTimelineStep(steps, { kind: "think", text: "" })).toHaveLength(3);
  });

  it("planSignature 只看内容序列（条数相同但内容置换 = 另一张计划）", () => {
    const a = [{ id: "1", content: "A", status: "pending" as const }];
    const b = [{ id: "1", content: "B", status: "pending" as const }];
    expect(planSignature(a)).not.toBe(planSignature(b));
  });
});
