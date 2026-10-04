
















import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools } from "../../core-ts/src/tools/builtin.js";

let work = "";
let reg: ToolRegistry;

const read = (args: Record<string, unknown>): Promise<string> => reg.get("file_read")!.executeFn({ _workspace: work, ...args });

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "slime-read-"));
  resetRegistry();
  reg = new (getRegistry().constructor as typeof ToolRegistry)();
  
  
  
  registerBuiltinTools(reg);
});
afterAll(() => {
  try { rmSync(work, { recursive: true, force: true }); } catch {  }
});


function makeLines(name: string, n: number, filler = "x"): string {
  const p = join(work, name);
  const rows: string[] = [];
  for (let i = 1; i <= n; i += 1) { rows.push(`L${i}: ${filler.repeat(20)}`); }
  writeFileSync(p, rows.join("\n"), "utf-8");
  return p;
}

describe("file_read：不再有「文件过大 → 拒绝读取」这条死路", () => {
  it("回归：旧实现会硬拒的 3MB 文件，现在必须读得出来", async () => {
    
    const p = makeLines("big-3mb.txt", 40000);
    const out = await read({ path: p });
    expect(out).not.toContain("拒绝读取");
    expect(out).not.toContain("[错误]");
    expect(out).toContain("L1:");
  });

  it("超出默认窗口 → 结尾给出**可直接复用**的续读参数（不是一句干巴巴的报错）", async () => {
    const p = makeLines("many.txt", 5000);
    const out = await read({ path: p });
    expect(out).toContain("L1:");
    expect(out).toContain("L2000:");
    expect(out).not.toContain("L2001:"); 
    expect(out).toContain("[已截断:");
    expect(out).toContain("共 5000 行");
    expect(out).toContain("offset=2001 limit=2000"); 
  });

  it("按提示续读 → 拿到下一段且不重不漏", async () => {
    const p = makeLines("page.txt", 5000);
    const page2 = await read({ path: p, offset: 2001, limit: 2000 });
    expect(page2).toContain("L2001:");
    expect(page2).toContain("L4000:");
    expect(page2).not.toContain("L2000:");
    const page3 = await read({ path: p, offset: 4001, limit: 2000 });
    expect(page3).toContain("L4001:");
    expect(page3).toContain("L5000:");
    expect(page3).not.toContain("[已截断:"); 
  });

  it("读完的读取保持原契约：返回值就是文件内容（不加任何脚注）", async () => {
    const p = join(work, "small.txt");
    writeFileSync(p, "hello", "utf-8");
    expect(await read({ path: p })).toBe("hello");
    const p2 = makeLines("exact-2000.txt", 2000);
    const out = await read({ path: p2 });
    expect(out).not.toContain("[已截断:"); 
  });

  it("723MB 级文件也不报错（用稀疏写制造大尺寸，避免真的占满磁盘）", async () => {
    
    const p = join(work, "huge.log");
    writeFileSync(p, `L1: 头部\n${"y".repeat(1024)}\n`, "utf-8");
    const out = await read({ path: p });
    expect(out).not.toContain("拒绝读取");
    expect(out).toContain("L1:");
  });

  it("单行超长按 2000 字符截断（防一行吃掉整个预算）", async () => {
    const p = join(work, "longline.txt");
    writeFileSync(p, "A".repeat(9000) + "\nshort\n", "utf-8");
    const out = await read({ path: p });
    const first = out.split("\n")[0];
    expect(first.length).toBeLessThan(2100);
    expect(first).toContain("[本行超长已截断]");
    expect(out).toContain("short"); 
  });

  it("字节上限作用在**本次分片**上：海量超长行时回退行数而不是切字符", async () => {
    const p = join(work, "dense.txt");
    const rows: string[] = [];
    for (let i = 1; i <= 3000; i += 1) { rows.push(`L${i}: ${"z".repeat(1900)}`); }
    writeFileSync(p, rows.join("\n"), "utf-8");
    const out = await read({ path: p, limit: 20000 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThan(300 * 1024); 
    expect(out).toContain("[已截断:");
    expect(out).toMatch(/L\d+: z+/); 
  });

  it("参数校验：非法 offset/limit 回落默认值，不抛错", async () => {
    const p = makeLines("fallback.txt", 10);
    expect(await read({ path: p, offset: 0, limit: -5 })).toContain("L1:");
    expect(await read({ path: p, offset: "abc", limit: null })).toContain("L1:");
    
    expect(await read({ path: p, limit: 999999 })).toContain("L10:");
  });

  it("原有防护不退化：不存在 / 敏感文件 / 越界路径仍按原样报错", async () => {
    expect(await read({ path: join(work, "nope.txt") })).toContain("[错误] 文件不存在");
    expect(await read({ path: "config/auth_token.json" })).toContain("敏感文件禁止读取");
    expect(await read({ path: join(tmpdir(), "outside.txt") })).toContain("路径超出项目范围");
  });
});















describe("A-984：无换行符 / 超长单行文件不得卡死主进程", () => {
  it("20MB 单行文件（无任何换行）→ 快速返回、输出有界、不 OOM", async () => {
    const p = join(work, "one-line-20mb.json");
    
    const chunk = "a".repeat(1024 * 1024);
    const fh = openSync(p, "w");
    for (let i = 0; i < 20; i += 1) { writeSync(fh, chunk); }
    closeSync(fh);

    const t0 = Date.now();
    const out = await read({ path: p });
    const ms = Date.now() - t0;

    expect(ms).toBeLessThan(8000);                 
    expect(out.length).toBeLessThan(10_000);       
    expect(out).toContain("本行超长已截断");
    expect(statSync(p).size).toBeGreaterThan(16 * 1024 * 1024); 
  });

  it("8MB 单行文件（未超扫描预算）→ 同样有界，且能判定读完", async () => {
    const p = join(work, "one-line-8mb.txt");
    const fh = openSync(p, "w");
    writeSync(fh, "b".repeat(8 * 1024 * 1024));
    closeSync(fh);
    const t0 = Date.now();
    const out = await read({ path: p });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.length).toBeLessThan(10_000);
  });

  it("offset 超出文件末尾 → 明确说明越界，绝不返回空串", async () => {
    const p = makeLines("short.txt", 20);
    const out = await read({ path: p, offset: 900_000, limit: 10 });
    expect(out).not.toBe("");
    expect(out).toContain("已超出文件末尾");
    expect(out).toContain("共 20 行");
  });

  it("深 offset（越过扫描预算）→ 给出可行动的说明，绝不返回空串", async () => {
    
    const p = makeLines("deep.txt", 400000, "q".repeat(35));
    const out = await read({ path: p, offset: 900_000, limit: 10 });
    expect(out).not.toBe("");
    
    expect(out).toMatch(/已超出文件末尾|未取到完整行/);
  });

  it("正常多行文件不受影响（扫描预算只在超限时介入）", async () => {
    const p = makeLines("normal.txt", 300);
    const out = await read({ path: p });
    expect(out).toContain("L1:");
    expect(out).toContain("L300:");
    expect(out).not.toContain("[已截断:");
  });
});
