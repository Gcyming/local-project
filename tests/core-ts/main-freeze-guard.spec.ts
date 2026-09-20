/**
 * tests/core-ts/main-freeze-guard.spec.ts — 「主进程卡死 / 界面点不动」的源码守卫（A-984）。
 *
 * 用户实测：slime 卡住、点按钮没反应。现场唯一线索是 `data/audit.jsonl` 在那一刻**停止写入**
 * —— 反推主进程事件循环被长时间独占（渲染层 IPC 全排队）。
 * 事后归因发现两条**必然卡死**的实现缺陷，都在上一轮新加的流式文件读取里：
 *
 *   ① `pending += decode(chunk)` 无上限：对**没有换行符的文件**（压缩成一行的 JSON / 长日志）
 *      缓冲会涨到整份文件大小，而 JS 字符串 `+=` 是重复拷贝 → 代价接近 O(n²)；
 *   ② 扫描预算的退出条件写成 `lines.length >= limit && scanned >= MAX_SCAN_BYTES`，
 *      而单行文件 `lines` 恒为 0 → 那个 break **永远不会触发** → 一路读到底。
 *
 * 行为级回归在 `file-read-paging.spec.ts`（20MB 单行文件必须常数时间返回）。
 * 本文件补**源码守卫**：这些是"改回去不报错、只在真机上卡死"的写法，必须逐字钉住。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("A-984：无换行符 / 超长单行文件的读取必须有硬上限", () => {
  const src = read("core-ts/src/tools/builtin.ts");

  it("pending 缓冲必须有上限并用 skippingLong 丢弃超长行剩余部分", () => {
    expect(src).toContain("if (pending.length > MAX_LINE_CHARS)");
    expect(src).toContain("skippingLong = true");
    expect(src).toContain("pending = \"\";");
  });

  it("扫描预算必须是**无条件**硬闸（不得再要求「窗口已收满」才判）", () => {
    // 旧写法（要求 lines.length >= limit）在单行文件上永不触发 —— 这行断言就是防它回来
    expect(src).not.toContain("if (lines.length >= limit && scanned >= MAX_SCAN_BYTES)");
    expect(src).toContain("if (scanned >= MAX_SCAN_BYTES) { break; }");
  });

  it("一行都没取到时必须给出说明，绝不返回空串", () => {
    expect(src).toContain("if (win.lines.length === 0)");
    expect(src).toContain("已超出文件末尾");
    expect(src).toContain("未取到完整行");
  });
});

describe("A-984：主进程卡死看门狗（把下次卡顿变成可归因的日志）", () => {
  it("watchdog 模块存在，且掉拍检测不阻止进程退出（unref）", () => {
    const p = "gui/src/main/watchdog.ts";
    expect(existsSync(join(process.cwd(), p))).toBe(true);
    const w = read(p);
    expect(w).toContain("export function startMainWatchdog");
    expect(w).toContain("export function markMainActivity");
    expect(w).toContain("timer.unref?.()");
    expect(w).toContain("watchdog.log"); // 必须落盘 —— 打包后终端日志看不到
  });

  it("看门狗已在 app 启动时开启，并在工具事件处留下现场标记", () => {
    const main = read("gui/src/main/index.ts");
    expect(main).toContain("startMainWatchdog()");
    expect(main).toContain("markMainActivity(`tool ${String(t.name ?? \"?\")}`)");
    expect(main).toContain("from \"./watchdog.js\"");
  });

  it("LAG_WARN_MS 阈值不得低于 2s（正常 GC/大渲染有百毫秒抖动，调低会误报）", () => {
    const w = read("gui/src/main/watchdog.ts");
    expect(w).toContain("const LAG_WARN_MS = 2000;");
  });
});
