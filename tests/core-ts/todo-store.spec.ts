












import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  todoPath, readTodos, writeTodos, removeTodos, hasTodos,
  normalizeTodos, renderTodos, todoProgress, todosToPlanStatus,
  demoteStaleInProgress,
  planReconcileFromTodos,
  planReconcileText,
  type StoredTodo,
} from "../../core-ts/src/services/todoStore.js";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const DATA_DIR = join(PROJECT_ROOT, "data");
const MARK = "__spec_store_";
let sid = "";

function cleanMarked(): void {
  let names: string[] = [];
  try { names = readdirSync(DATA_DIR); } catch { return; }
  for (const n of names) {
    if (n.includes(MARK)) { try { rmSync(join(DATA_DIR, n), { force: true }); } catch {  } }
  }
}

const todo = (id: string, content: string, status: StoredTodo["status"] = "pending"): StoredTodo => ({ id, content, status });

beforeEach(() => {
  cleanMarked();
  sid = `${MARK}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
});
afterAll(() => { cleanMarked(); });

describe("todoStore — 空 sessionId 必须拒绝（R27 根因防线）", () => {
  it("todoPath 对空/纯空白 sessionId 返回 null，绝不拼出 todos_.json", () => {
    expect(todoPath("")).toBeNull();
    expect(todoPath("   ")).toBeNull();
    expect(todoPath(null as unknown as string)).toBeNull();
    expect(todoPath(undefined as unknown as string)).toBeNull();
    
    expect(todoPath(sid)).toMatch(new RegExp(`todos_${MARK}`));
  });

  it("读/写/删/查在空 sessionId 下都是安全的 no-op", () => {
    const ghost = join(DATA_DIR, "todos_.json");
    const hadGhost = existsSync(ghost);
    expect(readTodos("")).toEqual([]);
    expect(writeTodos("", [todo("1", "不该落盘")])).toBeNull();
    expect(hasTodos("")).toBe(false);
    removeTodos(""); 
    expect(existsSync(ghost)).toBe(hadGhost);
  });

  it("会话 id 首尾空白会被裁剪（不会造出 todos_ a.json 这种带空格的文件）", () => {
    const p = todoPath(`  ${sid}  `);
    expect(p).not.toBeNull();
    expect(p!.endsWith(`todos_${sid}.json`)).toBe(true);
  });
});

describe("todoStore — 读写与容错", () => {
  it("写入后能读回，且落盘结构含 updated_at / items", () => {
    writeTodos(sid, [todo("a", "第一步"), todo("b", "第二步")]);
    const raw = JSON.parse(readFileSync(todoPath(sid)!, "utf8")) as { updated_at?: string; items?: StoredTodo[] };
    expect(typeof raw.updated_at).toBe("string");
    expect(raw.items).toHaveLength(2);
    expect(readTodos(sid).map((t) => t.content)).toEqual(["第一步", "第二步"]);
  });

  it("文件缺失/JSON 损坏/结构不对 → 一律返回空表，不抛", () => {
    expect(readTodos(sid)).toEqual([]);
    writeFileSync(todoPath(sid)!, "{ 这不是 JSON", "utf8");
    expect(readTodos(sid)).toEqual([]);
    writeFileSync(todoPath(sid)!, JSON.stringify({ items: "不是数组" }), "utf8");
    expect(readTodos(sid)).toEqual([]);
  });

  it("读回时补齐缺失 id（界面 key 不能为空）", () => {
    writeFileSync(todoPath(sid)!, JSON.stringify({ items: [{ content: "没有 id 的任务" }] }), "utf8");
    const items = readTodos(sid);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).not.toBe("");
  });

  it("removeTodos 删掉文件；hasTodos 如实反映存在性", () => {
    writeTodos(sid, [todo("a", "任务")]);
    expect(hasTodos(sid)).toBe(true);
    removeTodos(sid);
    expect(hasTodos(sid)).toBe(false);
    removeTodos(sid); 
  });
});

describe("todoStore — 清空必须是真删除（A-987：用户实测'删了又回来'）", () => {
  it("removeTodos 连带删掉 .bak —— 否则 readTodos 会从备份把整张清单读回来", () => {
    writeTodos(sid, [todo("a", "第一版")]);
    writeTodos(sid, [todo("a", "第一版"), todo("b", "第二版")]); 
    const p = todoPath(sid)!;
    expect(existsSync(`${p}.bak`)).toBe(true); 

    removeTodos(sid);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.bak`)).toBe(false);
    
    expect(readTodos(sid)).toEqual([]);
  });

  it("removeTodos 连带清掉损坏留证 .corrupt（不删就永远挂在 data/ 里）", () => {
    writeTodos(sid, [todo("a", "任务")]);
    const p = todoPath(sid)!;
    writeFileSync(`${p}.corrupt`, "{ 坏文件");
    removeTodos(sid);
    expect(existsSync(`${p}.corrupt`)).toBe(false);
  });

  it("removeTodos 连带清掉同前缀的落盘半成品 .tmp（强杀留下的）", () => {
    const p = todoPath(sid)!;
    writeFileSync(`${p}.abc123.tmp`, "{ 半分片");
    removeTodos(sid);
    expect(existsSync(`${p}.abc123.tmp`)).toBe(false);
  });

  it("删除是幂等的：连删两次、删一个从没写过的会话都不抛", () => {
    writeTodos(sid, [todo("a", "任务")]);
    removeTodos(sid);
    removeTodos(sid);
    removeTodos(`${MARK}never_written_${Date.now().toString(36)}`);
    expect(readTodos(sid)).toEqual([]);
  });
});

describe("todoStore — 会话 id 必须转成单段合法文件名（A-987：NTFS 数据流幽灵文件）", () => {
  




  it("含冒号的子代理 id 不再产生 0 字节幽灵文件，且读写往返正常", () => {
    const sub = `${MARK}sub:run123`;
    writeTodos(sub, [todo("a", "子代理任务")]);

    const p = todoPath(sub)!;
    
    expect(basename(p)).not.toContain(":"); 
    expect(p.endsWith(".json")).toBe(true);

    
    expect(existsSync(join(DATA_DIR, `todos_${sub}`))).toBe(false);
    
    expect(JSON.parse(readFileSync(p, "utf8")).items).toHaveLength(1);
    expect(readTodos(sub).map((t) => t.content)).toEqual(["子代理任务"]);
  });

  it("不同 runId 各有独立文件，互不覆盖（未编码时它们共用同一个基名文件）", () => {
    const a = `${MARK}sub:runA`;
    const b = `${MARK}sub:runB`;
    writeTodos(a, [todo("a", "A 的任务")]);
    writeTodos(b, [todo("b", "B 的任务")]);
    expect(todoPath(a)).not.toBe(todoPath(b));
    expect(readTodos(a).map((t) => t.content)).toEqual(["A 的任务"]);
    expect(readTodos(b).map((t) => t.content)).toEqual(["B 的任务"]);
    
    removeTodos(a);
    expect(readTodos(b).map((t) => t.content)).toEqual(["B 的任务"]);
  });

  it("普通会话 id 编码前后一字不变（既有文件无需迁移）", () => {
    expect(todoPath(sid)!.endsWith(`todos_${sid}.json`)).toBe(true);
  });
});

describe("todoStore — 归一化规则（工具与主进程共用同一口径）", () => {
  it("最多一个 in_progress：保留第一个，其余降 pending", () => {
    const out = normalizeTodos([todo("1", "A", "in_progress"), todo("2", "B", "in_progress"), todo("3", "C", "in_progress")]);
    expect(out.filter((t) => t.status === "in_progress")).toHaveLength(1);
    expect(out[0]!.status).toBe("in_progress");
    expect(out[1]!.status).toBe("pending");
    expect(out[2]!.status).toBe("pending");
  });

  it("completedAt 自动打戳 / 退回时撤销 / 已有值不刷新", () => {
    const stamped = normalizeTodos([todo("1", "A", "completed")]);
    expect(typeof stamped[0]!.completedAt).toBe("string");

    const revoked = normalizeTodos([{ ...stamped[0]!, status: "pending" }]);
    expect(revoked[0]!.completedAt).toBeUndefined();

    const kept = normalizeTodos([{ id: "1", content: "A", status: "completed", completedAt: "2020-01-01T00:00:00.000Z" }]);
    expect(kept[0]!.completedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("写盘结果已归一化（不是把原始入参直接落盘）", () => {
    const written = writeTodos(sid, [todo("1", "A", "in_progress"), todo("2", "B", "in_progress")]);
    expect(written).not.toBeNull();
    expect(written!.filter((t) => t.status === "in_progress")).toHaveLength(1);
    
    expect(readTodos(sid).filter((t) => t.status === "in_progress")).toHaveLength(1);
  });
});

describe("todoStore — 派生视图", () => {
  it("todoProgress 统计完成数 / 百分比；空表不除零", () => {
    expect(todoProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(todoProgress([todo("1", "A", "completed"), todo("2", "B", "pending")])).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it("todosToPlanStatus 随进度变化（不再恒定 planning）", () => {
    expect(todosToPlanStatus([])).toBe("planning");
    expect(todosToPlanStatus([todo("1", "A", "pending"), todo("2", "B", "pending")])).toBe("planning");
    expect(todosToPlanStatus([todo("1", "A", "in_progress"), todo("2", "B", "pending")])).toBe("active");
    expect(todosToPlanStatus([todo("1", "A", "completed"), todo("2", "B", "pending")])).toBe("active");
    expect(todosToPlanStatus([todo("1", "A", "completed"), todo("2", "B", "completed")])).toBe("done");
  });

  it("renderTodos 是「目标复述」：带进度头 + 复选框清单 + 进行中标记", () => {
    const out = renderTodos([todo("1", "读代码", "completed"), todo("2", "改逻辑", "in_progress"), todo("3", "跑测试")]);
    expect(out).toContain("进度 1/3");
    expect(out).toContain("当前进行中：改逻辑");
    expect(out).toContain("- [x] 读代码");
    expect(out).toContain("- [ ] 改逻辑");
    expect(out).toContain("← 进行中");
    expect(out).toContain("- [ ] 跑测试");
    expect(renderTodos([])).toContain("待办列表为空");
  });

  it("renderTodos 超过上限时截断（防止复述把上下文撑爆）", () => {
    const many = Array.from({ length: 45 }, (_, i) => todo(`t${i}`, `任务 ${i}`));
    const out = renderTodos(many);
    expect(out).toContain("其余 15 项略");
    expect(out).toContain("进度 0/45");
  });
});










describe("todoStore — 僵尸 in_progress 收敛（A-985）", () => {
  it("没有流在跑时：in_progress → pending，已完成项与内容原样保留", () => {
    writeTodos(sid, [
      todo("a", "已完成的事", "completed"),
      todo("b", "卡在这一步（其实没人在做）", "in_progress"),
      todo("c", "还没开始", "pending"),
    ]);
    expect(demoteStaleInProgress(sid)).toBe(1);
    const after = readTodos(sid);
    expect(after.map((t) => t.status)).toEqual(["completed", "pending", "pending"]);
    
    expect(after.map((t) => t.content)).toEqual(["已完成的事", "卡在这一步（其实没人在做）", "还没开始"]);
  });

  it("幂等：收敛过一次后再调返回 0，且不重写文件（避免无谓的文件抖动）", () => {
    writeTodos(sid, [todo("b", "x", "in_progress")]);
    expect(demoteStaleInProgress(sid)).toBe(1);
    const stamp = JSON.parse(readFileSync(todoPath(sid)!, "utf8")).updated_at;
    expect(demoteStaleInProgress(sid)).toBe(0);
    const stamp2 = JSON.parse(readFileSync(todoPath(sid)!, "utf8")).updated_at;
    expect(stamp2).toBe(stamp);
  });

  it("无 in_progress / 无文件 / 空 sessionId → 一律安全返回 0", () => {
    writeTodos(sid, [todo("a", "只完成了", "completed"), todo("b", "待办", "pending")]);
    expect(demoteStaleInProgress(sid)).toBe(0);
    expect(demoteStaleInProgress("")).toBe(0);
    expect(demoteStaleInProgress(`${MARK}never_written_${Date.now().toString(36)}`)).toBe(0);
  });

  it("不误伤自动清空：全完成时收敛返回 0，清单保持全完成", () => {
    writeTodos(sid, [todo("a", "1", "completed"), todo("b", "2", "completed")]);
    expect(demoteStaleInProgress(sid)).toBe(0);
    expect(readTodos(sid).every((t) => t.status === "completed")).toBe(true);
  });

  it("主进程只在确证无活跃流时才收敛（源码守卫：入口受 activeChats 保护）", () => {
    const main = readFileSync(join(PROJECT_ROOT, "gui/src/main/index.ts"), "utf8");
    expect(main).toContain("demoteStaleInProgress(sid)");
    expect(main).toContain("if (!activeChats.has(sid))");
    
    expect(main).toContain("if (!staleChecked.has(sid))");
    
    expect(main).toContain("demoteStaleInProgress(key)");
  });

  it("读盘路径读到「已全部完成」的清单要**立即**清，不走 1.5s 延迟（源码守卫）", () => {
    const main = readFileSync(join(PROJECT_ROOT, "gui/src/main/index.ts"), "utf8");
    
    
    expect(main).toContain("if (allTodosCompleted(todos))");
    const loadTodos = main.slice(main.indexOf('"slime:sessions:loadTodos"'));
    const body = loadTodos.slice(0, loadTodos.indexOf("});"));
    expect(body).toContain("removeTodos(sid)");
    expect(body).not.toContain("scheduleTodoAutoClear(sid, todos)");
  });
});

describe("todoStore — 计划收尾核对（A-1061⑫：用户实测「大任务做完还有项没划掉」）", () => {
  




  it("空表 → null（没有计划就别多跑一轮）", () => {
    expect(planReconcileFromTodos([])).toBeNull();
  });

  it("**全部已完成** → null（收完了，零行为变化）", () => {
    expect(planReconcileFromTodos([
      todo("1", "改接口", "completed"),
      todo("2", "补测试", "completed"),
    ])).toBeNull();
  });

  it("有未完成项 → 返回核对要求，且**点名**还剩哪几项、当前状态是什么", () => {
    const text = planReconcileFromTodos([
      todo("1", "改接口", "completed"),
      todo("2", "补测试", "in_progress"),
      todo("3", "写文档", "pending"),
    ]);
    expect(text).not.toBeNull();
    expect(text).toContain("还有 2 项没标完成");
    expect(text).toContain("「补测试」(in_progress)");
    expect(text).toContain("「写文档」(pending)");
    
    expect(text).not.toContain("「改接口」(");
    
    expect(text).toContain("调 todo_write");
    expect(text).toContain("为什么留到下一轮");
  });

  it("planReconcileText：空 sessionId → null（读不到会话就没有计划可言）", () => {
    expect(planReconcileText("")).toBeNull();
  });

  it("planReconcileText：真会话走 readTodos —— 未完成要给出核对，全完成给 null", () => {
    writeTodos(sid, [todo("1", "甲", "in_progress")]);
    expect(planReconcileText(sid)).toContain("还有 1 项没标完成");
    writeTodos(sid, [todo("1", "甲", "completed")]);
    expect(planReconcileText(sid)).toBeNull();
  });

  it("工具循环真的会在**本轮不再要工具**时续一轮去做核对（源码接线）", () => {
    const src = readFileSync(join(PROJECT_ROOT, "core-ts/src/tool_loop.ts"), "utf8");
    
    expect((src.match(/this\.reconcilePlan\(/g) ?? []).length).toBe(2);
    const fn = src.slice(src.indexOf("private reconcilePlan("));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    
    expect(body).toContain('messages.push({ role: "assistant", content: roundText });');
    expect(body).toContain('messages.push({ role: "user", content: ask });');
    
    
    
    expect(body).toContain("if (!mayReconcile) { return false; }");
    expect(body).not.toContain("alreadyDone");
    
    
    
    expect((src.match(/this\.reconcilePlan\(opts\.sessionId, opts\.messages, (?:raw|roundText), !reconciled && usedTodoWrite\)/g) ?? []).length)
      .toBe(2);
    
    expect((src.match(/pending\.some\(\(tc\) => tc\.name === "todo_write"\)/g) ?? []).length).toBe(2);
  });
});
