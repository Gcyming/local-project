














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
    expect(w).toContain("watchdog.log"); 
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
