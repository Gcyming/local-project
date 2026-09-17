/**
 * tests/core-ts/crash-safety.spec.ts — 意外退出保底（A-986）。
 *
 * 背景：用户 App 卡死 → 任务管理器强杀 → 重启后（a）待办里那一项永远停在「进行中」、
 * （b）列表出"莫须有的任务"、勾选也没反应。根子都在**没做意外情况防护**：
 *   - 写入不是原子的：`writeFileSync` 覆盖会**先截断旧文件**，此刻崩溃就留下半个 JSON，
 *     而 `readTodos` 解析失败返回 `[]` → "待办全没了"且查不出原因；
 *   - 崩溃现场没有任何记录，事后只能靠"日志停止写入"反推（用户实测过的场景）。
 *
 * 这里锁三件事：① 原子写（临时文件 + fsync + rename）② 损坏时回退 `.bak` 且留证
 * ③ 崩溃判定用的脏标记语义。**注意本文件与 file-read-paging 一样，是"环境差"类问题的守卫**：
 * 这些逻辑在真机上只在"真崩过一次"时才生效，纯功能测试永远测不到，所以必须直测存储层。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { todoPath, readTodos, writeTodos, writeFileAtomic } from "../../core-ts/src/services/todoStore.js";

const DATA_DIR = join(PROJECT_ROOT, "data");
const MARK = "__spec_crash_";
let sid = "";

function cleanMarked(): void {
  let names: string[] = [];
  try { names = readdirSync(DATA_DIR); } catch { return; }
  for (const n of names) {
    if (n.includes(MARK)) { try { rmSync(join(DATA_DIR, n), { force: true }); } catch { /* 忽略 */ } }
  }
}
beforeEach(() => {
  cleanMarked();
  sid = `${MARK}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
});
afterAll(() => { cleanMarked(); });

describe("A-986：原子写 —— 崩在写入过程中不会留下半截文件", () => {
  it("写完后不留 .tmp：临时文件被 rename 掉，不是残留", () => {
    const p = todoPath(sid)!;
    writeTodos(sid, [{ id: "a", content: "x", status: "pending" }]);
    expect(existsSync(p)).toBe(true);
    const leftovers = readdirSync(DATA_DIR).filter((n) => n.includes(MARK) && n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("写内容始终保持**完整 JSON**（不存在「写到一半」的中间态可被读到）", () => {
    const p = todoPath(sid)!;
    for (let i = 1; i <= 5; i += 1) {
      writeTodos(sid, Array.from({ length: i }, (_, k) => ({ id: `t${k}`, content: `任务${k}`, status: "pending" as const })));
      // 任意时刻读到的都必须是可解析的完整 JSON
      const raw = readFileSync(p, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw).items).toHaveLength(i);
    }
  });

  it("第二次写入会留下上一份 .bak（崩溃时的回退来源）", () => {
    const p = todoPath(sid)!;
    writeTodos(sid, [{ id: "a", content: "第一版", status: "pending" }]);
    writeTodos(sid, [{ id: "a", content: "第二版", status: "pending" }]);
    expect(existsSync(`${p}.bak`)).toBe(true);
    expect(readFileSync(`${p}.bak`, "utf8")).toContain("第一版");
  });

  it("主文件损坏 → 自动回退 .bak 读出上一份完好内容（不是静默返回空表）", () => {
    const p = todoPath(sid)!;
    writeTodos(sid, [{ id: "a", content: "完好内容", status: "pending" }]);
    writeTodos(sid, [{ id: "a", content: "更新内容", status: "pending" }]); // 生成 .bak（内容=完好内容）
    writeFileSync(p, "{\"items\": [ { 半个 JSON", "utf8"); // 模拟崩在写一半
    expect(readTodos(sid).map((t) => t.content)).toEqual(["完好内容"]);
  });

  it("两份都坏 → 返回空表，但把损坏文件**改名留证**（不静默丢弃）", () => {
    const p = todoPath(sid)!;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(p, "坏掉了", "utf8");
    expect(readTodos(sid)).toEqual([]);
    expect(existsSync(`${p}.corrupt`)).toBe(true);
  });

  it("writeFileAtomic 是通用能力：任意路径都能原子替换", () => {
    const p = join(DATA_DIR, `${MARK}plain.txt`);
    writeFileAtomic(p, "v1");
    expect(readFileSync(p, "utf8")).toBe("v1");
    writeFileAtomic(p, "v2");
    expect(readFileSync(p, "utf8")).toBe("v2");
    expect(existsSync(`${p}.bak`)).toBe(true);
  });
});

describe("A-986：崩溃判定用「脏标记」—— 强杀下唯一可靠的判据", () => {
  it("crashGuard 用 run.lock 的存在与否判定异常退出，并落 crash-report.log", () => {
    const src = readFileSync(join(PROJECT_ROOT, "gui/src/main/crashGuard.ts"), "utf8");
    expect(src).toContain("const LOCK_PATH = join(DATA_DIR, \"run.lock\")");
    expect(src).toContain("export function sweepAfterCrash");
    expect(src).toContain("export function markRunning");
    expect(src).toContain("export function markCleanExit");
    expect(src).toContain("crash-report.log");
    // 为什么不能靠 process.on('exit')：强杀（SIGKILL / 任务管理器结束进程）根本不会调用它。
    // 只能靠"正常退出时主动删标记"，下次启动看到残留即判定上次异常。
    expect(src).toContain("强杀");
  });

  it("启动时先扫（判定+清障）再写标记；正常退出删标记（顺序错了判定就失效）", () => {
    const main = readFileSync(join(PROJECT_ROOT, "gui/src/main/index.ts"), "utf8");
    const sweepAt = main.indexOf("sweepAfterCrash()");
    const markAt = main.indexOf("markRunning(app.getVersion())");
    expect(sweepAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(sweepAt); // 必须在扫之后写，否则本次标记会被当成"上次残留"
    expect(main).toContain("app.on(\"will-quit\", () => { markCleanExit(); })");
  });

  it("清障只删**陈旧**临时文件，不碰正在写的那一个", () => {
    const src = readFileSync(join(PROJECT_ROOT, "gui/src/main/crashGuard.ts"), "utf8");
    expect(src).toContain("age > STALE_TMP_MS");
    expect(src).toContain("const STALE_TMP_MS = 60_000;");
  });
});
