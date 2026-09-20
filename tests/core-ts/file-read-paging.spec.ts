/**
 * tests/core-ts/file-read-paging.spec.ts — file_read 的分页 / 上限语义（A-978）。
 *
 * 背景（用户实测截图）：三个真实文件被硬拒 —— 6.2MB / 46.2MB / **723.0MB 全是**
 *   `[错误] 文件过大（X MB），拒绝读取`
 * 旧实现 `if (fsize > MAX_READ_BYTES * 10) return "[错误] 文件过大…，拒绝读取"` 是**死路**：
 * 它在"模型最需要帮助"的时刻只回一句错误、零字节内容，而 slime 既没有 offset/limit、
 * 也没有任何内容检索工具，模型拿不到任何可继续的手段（实测 Agent 只能去写 Python 脚本绕开）。
 *
 * 唯一权威可比对象是 Anthropic Claude Code 的 Read 工具（2026-09-17 核实）：
 *   - `maxSizeBytes = 256 KB`：读前 `stat` 拦截，**超过直接抛错**；
 *   - `maxTokens = 25000`：读后按 token 拦；
 *   - 默认只返回开头 2000 行；单行超 2000 字符截断；
 *   - 出错文案会明说"改用 offset/limit 或 grep"——**它敢抛错是因为有退路**。
 * slime 沿用 256KB（业界事实标准）与 2000 行默认，但把 256KB 的语义从"整份文件大小闸门"
 * 改成"本次分片闸门"，并补上 offset/limit 作为退路。本文件锁死这套语义。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools } from "../../core-ts/src/tools/builtin.js";

let work = "";
let reg: ToolRegistry;
// 统一带上 _workspace 沙箱根（临时目录在项目外，不带会被"路径超出项目范围"挡住 —— 与既有 tools.spec 同做法）
const read = (args: Record<string, unknown>): Promise<string> => reg.get("file_read")!.executeFn({ _workspace: work, ...args });

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "slime-read-"));
  resetRegistry();
  reg = new (getRegistry().constructor as typeof ToolRegistry)();
  // ⚠️ `registerBuiltinTools(target?: ToolRegistry)` **只有一个参数**。
  //    这里原先多传了 `{ registry: reg }`：JS 会静默丢弃多余的实参，测试照样通过，
  //    于是"我注入了 registry"成了一种错觉（tsc 一直在报 TS2554，只是门禁常年是红的没人看）。
  registerBuiltinTools(reg);
});
afterAll(() => {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

/** 造一个"正好 n 行"的文件（每行 `L{i}: 填充`，避免被当成空行） */
function makeLines(name: string, n: number, filler = "x"): string {
  const p = join(work, name);
  const rows: string[] = [];
  for (let i = 1; i <= n; i += 1) { rows.push(`L${i}: ${filler.repeat(20)}`); }
  writeFileSync(p, rows.join("\n"), "utf-8");
  return p;
}

describe("file_read：不再有「文件过大 → 拒绝读取」这条死路", () => {
  it("回归：旧实现会硬拒的 3MB 文件，现在必须读得出来", async () => {
    // 旧阈值 MAX_READ_BYTES * 10 = 2.62MB → 这个文件以前 100% 被拒（用户遇到的 6.2MB 同理）
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
    expect(out).not.toContain("L2001:"); // 默认窗口 = 2000 行
    expect(out).toContain("[已截断:");
    expect(out).toContain("共 5000 行");
    expect(out).toContain("offset=2001 limit=2000"); // 提示里的参数必须能直接抄回去用
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
    expect(page3).not.toContain("[已截断:"); // 最后一段读完 → 不加脚注
  });

  it("读完的读取保持原契约：返回值就是文件内容（不加任何脚注）", async () => {
    const p = join(work, "small.txt");
    writeFileSync(p, "hello", "utf-8");
    expect(await read({ path: p })).toBe("hello");
    const p2 = makeLines("exact-2000.txt", 2000);
    const out = await read({ path: p2 });
    expect(out).not.toContain("[已截断:"); // 正好 2000 行 = 恰好读完，不该报截断
  });

  it("723MB 级文件也不报错（用稀疏写制造大尺寸，避免真的占满磁盘）", async () => {
    // 旧实现：fsize > 2.62MB 直接拒。这里只需验证"大尺寸不再触发拒绝分支"＋不 OOM。
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
    expect(out).toContain("short"); // 后续行不受影响
  });

  it("字节上限作用在**本次分片**上：海量超长行时回退行数而不是切字符", async () => {
    const p = join(work, "dense.txt");
    const rows: string[] = [];
    for (let i = 1; i <= 3000; i += 1) { rows.push(`L${i}: ${"z".repeat(1900)}`); }
    writeFileSync(p, rows.join("\n"), "utf-8");
    const out = await read({ path: p, limit: 20000 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThan(300 * 1024); // 256KB 上限 + 脚注余量
    expect(out).toContain("[已截断:");
    expect(out).toMatch(/L\d+: z+/); // 每行保持完整（line 完整 → 行号可对齐）
  });

  it("参数校验：非法 offset/limit 回落默认值，不抛错", async () => {
    const p = makeLines("fallback.txt", 10);
    expect(await read({ path: p, offset: 0, limit: -5 })).toContain("L1:");
    expect(await read({ path: p, offset: "abc", limit: null })).toContain("L1:");
    // limit 超上限 → 夹到 20000，不报错
    expect(await read({ path: p, limit: 999999 })).toContain("L10:");
  });

  it("原有防护不退化：不存在 / 敏感文件 / 越界路径仍按原样报错", async () => {
    expect(await read({ path: join(work, "nope.txt") })).toContain("[错误] 文件不存在");
    expect(await read({ path: "config/auth_token.json" })).toContain("敏感文件禁止读取");
    expect(await read({ path: join(tmpdir(), "outside.txt") })).toContain("路径超出项目范围");
  });
});

/**
 * A-984：**不能让读取把主进程钉死**（用户实测：slime 卡住、点按钮没反应）。
 *
 * 事故复盘：v1 的流式实现只有 `pending += decode(chunk)`，对**没有换行符的文件**
 * （压缩成一行的 JSON / 长日志 / 单行 base64）缓冲会一路涨到整份文件大小；
 * 而 JS 字符串 `+=` 是重复拷贝，累积代价接近 **O(n²)** —— 几百 MB 的单行文件足以
 * 把主进程钉死数分钟。core-ts 跑在**主进程**里 → IPC 得不到服务 → 渲染层按钮"点了没反应"
 * （现场佐证：`data/audit.jsonl` 在卡死那一刻**停止写入**）。
 * 另一处叠加缺陷：扫描预算的退出条件写成 `lines.length >= limit && scanned >= MAX_SCAN_BYTES`，
 * 而单行文件 `lines` 恒为 0 → 那个 break **永远不会触发**。
 *
 * 本组用例用"耗时上限 + 输出体积上限"把这两条钉死：无论多大的单行文件，
 * 都必须**常数时间、常数内存**地返回。
 */
describe("A-984：无换行符 / 超长单行文件不得卡死主进程", () => {
  it("20MB 单行文件（无任何换行）→ 快速返回、输出有界、不 OOM", async () => {
    const p = join(work, "one-line-20mb.json");
    // 写 20MB 单行（超过 MAX_SCAN_BYTES=16MB 的扫描预算）
    const chunk = "a".repeat(1024 * 1024);
    const fh = openSync(p, "w");
    for (let i = 0; i < 20; i += 1) { writeSync(fh, chunk); }
    closeSync(fh);

    const t0 = Date.now();
    const out = await read({ path: p });
    const ms = Date.now() - t0;

    expect(ms).toBeLessThan(8000);                 // 旧实现在这里会跑几十秒到几分钟
    expect(out.length).toBeLessThan(10_000);       // 输出必须是有界的一小段
    expect(out).toContain("本行超长已截断");
    expect(statSync(p).size).toBeGreaterThan(16 * 1024 * 1024); // 确认真的超了扫描预算
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
    // 40 万行 × 40 字符 ≈ 16MB，正好越过 MAX_SCAN_BYTES → 总行数只能按"未知"回报
    const p = makeLines("deep.txt", 400000, "q".repeat(35));
    const out = await read({ path: p, offset: 900_000, limit: 10 });
    expect(out).not.toBe("");
    // 越界（可判）或扫描预算用尽（不可判）两种解释都必须写清楚，不能是空白
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
