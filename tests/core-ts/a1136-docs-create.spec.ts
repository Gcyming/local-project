










import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { extractDocText, docKindFromExt } from "../../core-ts/src/doc_text.js";

interface Bench { ws: string; tools: ToolRegistry; cleanup: () => Promise<void> }

async function makeBench(): Promise<Bench> {
  const dir = await mkdtemp(join(tmpdir(), "slime-docscreate-"));
  const ws = join(dir, "ws");
  await mkdir(ws, { recursive: true });
  vi.resetModules();
  const registry = await import("../../core-ts/src/tools/registry.js");
  const builtin = await import("../../core-ts/src/tools/builtin.js");
  registry.resetRegistry();
  builtin.registerBuiltinTools();
  return {
    ws, tools: registry.getRegistry(),
    cleanup: async () => { vi.resetModules(); await rm(dir, { recursive: true, force: true }).catch(() => undefined); },
  };
}

describe("A-1136-C ㈬ docs_create：Agent 从零生成 Office 文档", () => {
  it("⚠️⚠️ 工具**必须在工具面里**（以前能力在、通道在，但零消费者 ⇒ Agent 根本用不了）", async () => {
    const b = await makeBench();
    try {
      expect(b.tools.get("docs_create"), "工具面里没有 docs_create ⇒ 用户让 Agent「做个 Excel」它只能拒绝").toBeTruthy();
      const names = b.tools.listToolNames();
      expect(names).toContain("docs_create");
    } finally { await b.cleanup(); }
  });

  it.each([
    ["报告.docx", "docx", "# 标题\n\n正文第一段。\n- 列表项"],
    ["数据.xlsx", "xlsx", "名称\t数值\n甲\t1\n乙\t2"],
    ["演示.pptx", "pptx", "第一页标题\n正文\n---\n第二页标题\n正文2"],
  ])("⚠️ 生成 `%s` → 真文件、能读回（格式 %s）", async (file, kind, body) => {
    const b = await makeBench();
    try {
      const out = await b.tools.get("docs_create")!.executeFn({
        path: join(b.ws, file), body, title: "测试", _workspace: b.ws,
      }) as string;
      expect(out, "回执应是成功而不是错误：" + out).not.toContain("[错误]");

      const buf = await readFile(join(b.ws, file));
      expect(buf.length, "必须真有非空产物（成功判据 = 磁盘上有东西，不是回执里说成功）").toBeGreaterThan(200);
      
      expect(buf.subarray(0, 2).toString("latin1"), "OOXML 必须是 ZIP 容器").toBe("PK");

      const k = docKindFromExt("." + kind)!;
      const r = extractDocText(buf, k);
      expect(r.text.trim().length, "生成的文档必须能被**自己的读取链**读回内容").toBeGreaterThan(0);
    } finally { await b.cleanup(); }
  });

  it("⚠️ **不许覆盖已有文件**（二进制文档没有回滚账本，覆盖会造成「能回滚但文件已坏」的假承诺）", async () => {
    const b = await makeBench();
    try {
      const p = join(b.ws, "唯一.docx");
      const first = await b.tools.get("docs_create")!.executeFn({ path: p, body: "第一版", _workspace: b.ws }) as string;
      expect(first).not.toContain("[错误]");
      const before = await readFile(p);
      const second = await b.tools.get("docs_create")!.executeFn({ path: p, body: "第二版", _workspace: b.ws }) as string;
      expect(second, "第二次必须被拒绝").toContain("[错误]");
      expect(second).toContain("已存在");
      
      const after = await readFile(p);
      expect(Buffer.compare(before, after), "拒绝后原文件必须原封不动").toBe(0);
    } finally { await b.cleanup(); }
  });

  it("⚠️ 不支持的扩展名要**如实拒绝并列出可用格式**（不许瞎猜格式、也不许静默写个文本）", async () => {
    const b = await makeBench();
    try {
      const out = await b.tools.get("docs_create")!.executeFn({ path: join(b.ws, "奇怪.xyz"), body: "x", _workspace: b.ws }) as string;
      expect(out).toContain("[错误]");
      expect(out).toContain("不支持");
      expect(out).toContain(".docx");
    } finally { await b.cleanup(); }
  });
});
