/**
 * tests/core-ts/a1072-trash.spec.ts —— `file_delete` 必须真的进回收站（#231 收口）。
 *
 * ## 为什么要这条守卫
 *
 * `file_delete` 的回收站能力**不是** core-ts 自己实现的：core-ts 不许 import electron，所以
 * 由主进程注入 `shell.trashItem`（`setTrashService`，与 `setAdbService` 同模式）。
 * 未注入时工具**不会报错**，而是静默退化：走 `rm` 永久删除 + 回执如实标注「未进回收站」。
 *
 * ⇒ 后果是**门禁全绿而用户不可还原地丢文件**。而且它真的发生过：2026-09-23 的改动里
 * `setTrashService` 只加了 import、**调用没落地** —— 只有「导入未使用」这一条恰好被 tsc
 * （TS6133）抓住；一旦有人把 import 和调用**一起**删掉，tsc / 构建 / 全部 vitest 都不会响。
 * 所以这里既锁**行为**（三态：进回收站 / 未注入走永久 / 回收站失败不许改永久），
 * 也锁**接线事实**（主进程确实调用、且实现用的是 `shell.trashItem`）。
 *
 * 变异：`gui/scripts/mut-a1072-trash.mjs`
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry, getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setTrashService, PROJECT_ROOT } from "../../core-ts/src/tools/builtin.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 去掉注释：接线判据读的是**代码**，注释里提到某个标识符不算接线（否则删了调用仍绿）。 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const between = (src: string, start: string, end: string): string => {
  const p = src.indexOf(start);
  if (p < 0) { return ""; }
  const e = src.indexOf(end, p + start.length);
  return e < 0 ? "" : src.slice(p, e + end.length);
};

const exists = async (p: string): Promise<boolean> => {
  try { await stat(p); return true; } catch { return false; }
};

describe("A-1072：file_delete 的三态（进回收站 / 未注入 / 回收站失败）", () => {
  let reg: ToolRegistry;
  let work: string;
  let file: string;

  beforeEach(async () => {
    resetRegistry();
    registerBuiltinTools();
    reg = getRegistry();
    // 项目根内临时目录（与 tools.spec.ts 同约定：路径必须落在项目根/工作目录内才允许删）
    work = await mkdtemp(join(PROJECT_ROOT, "data", "trash-tmp-"));
    file = join(work, "to-delete.txt");
  });

  afterEach(async () => {
    /* ⚠️ 这是模块级单例，不还原会泄漏给同进程的其它用例（"未注入"那一条尤其会被污染）。 */
    setTrashService(null);
    await rm(work, { recursive: true, force: true });
  });

  it("注入回收站 → 走回收站，回执说「移入回收站」，绝不说「永久删除」", async () => {
    const seen: string[] = [];
    setTrashService({
      trash: async (absPath: string) => {
        seen.push(absPath);
        await rm(absPath, { force: true }); // 模拟系统回收站：文件从原位置消失
        return { ok: true };
      },
    });
    await writeFile(file, "bye", "utf-8");

    const out = await reg.get("file_delete")!.executeFn({ path: file });

    expect(seen).toEqual([file]);
    expect(out).toContain("移入回收站");
    expect(out).not.toContain("永久删除");
    expect(await exists(file)).toBe(false);
  });

  it("回收站失败 → **不许**改写语义成永久删除（保守取舍：宁可删不掉，也不可还原地删掉）", async () => {
    setTrashService({ trash: async () => ({ ok: false, error: "回收站不可用" }) });
    await writeFile(file, "keep me", "utf-8");

    const out = await reg.get("file_delete")!.executeFn({ path: file });

    expect(out).toContain("移入回收站失败");
    expect(out).toContain("未执行永久删除");
    expect(await exists(file)).toBe(true); // 文件还在 —— 这才是关键
  });

  it("未注入回收站 → 退化为永久删除，但回执必须**如实标注**不可还原", async () => {
    setTrashService(null);
    await writeFile(file, "gone", "utf-8");

    const out = await reg.get("file_delete")!.executeFn({ path: file });

    expect(out).toContain("永久删除");
    expect(out).toContain("未进回收站");
    expect(await exists(file)).toBe(false);
  });
});

describe("A-1072：接线——主进程必须真的注入 shell.trashItem", () => {
  const MAIN_C = strip(read("gui/src/main/index.ts"));

  it("调用真的存在（只 import 不调用 → file_delete 静默退化为永久删除，而门禁全绿）", () => {
    expect(MAIN_C, "主进程没有调用 setTrashService → 回收站能力从未装配")
      .toContain("setTrashService({");
  });

  it("注入的实现用 shell.trashItem（系统回收站），不是替代品", () => {
    const block = between(MAIN_C, "setTrashService({", "});");
    expect(block, "setTrashService(...) 调用块里没有 shell.trashItem → 删了就真没了")
      .toContain("shell.trashItem(");
  });
});
