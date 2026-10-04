















import { describe, expect, it } from "vitest";
import { basename, join } from "node:path";
import { previewFileName, previewHtmlPath, previewSafeName, previewUrlName } from "../../core-ts/src/previewPage.js";

const HTML = "<!doctype html><html><body><p>正文</p></body></html>";

describe("A-1133-P1 previewPage：path 与 name 必须同源（404 空白的根因）", () => {
  

  it("返回的 name == 落盘文件的 basename（不同源 ⇒ 右栏 404 ⇒ 整页空白）", () => {
    const dir = join("C:", "tmp", "doc-preview");
    const r = previewHtmlPath(dir, "季度报告.docx", HTML);
    expect(r.name, "name 必须就是文件名本身，不是另算一个").toBe(basename(r.path));
    expect(r.path).toBe(join(dir, r.name));
  });

  it("拼接出的 URL 文件名能还原回真实文件名（previewUrlName 是最后一层保险）", () => {
    const r = previewHtmlPath("/x", "a.docx", HTML);
    expect(previewUrlName(r.path)).toBe(r.name);
    expect(previewUrlName(r.name)).toBe(r.name);
  });

  it("含非法字符的名字也不会出现在路径里（Windows 会直接写盘失败）", () => {
    const r = previewHtmlPath("/x", 'a/b\\c:d*e?f"g<h>i|j.docx', HTML);
    expect(r.name).not.toMatch(/[\\/:*?"<>|]/);
    expect(r.name.endsWith(".html")).toBe(true);
  });
});

describe("A-1133-P2 previewPage：文件名必须幂等（否则目录无限膨胀）", () => {
  it("同一份 HTML ⇒ 同一个文件名（内容哈希，禁止时间戳/自增序号）", () => {
    expect(previewFileName("a.docx", HTML)).toBe(previewFileName("a.docx", HTML));
  });

  it("内容变了 ⇒ 文件名也跟着变（旧页面不会被同名覆盖掉内容）", () => {
    expect(previewFileName("a.docx", HTML)).not.toBe(previewFileName("a.docx", `${HTML}<!--x-->`));
  });

  it("扩展名不参与命名（`.docx` 与 `.doc` 同名同内容 ⇒ 同一个渲染页）", () => {
    expect(previewFileName("报告.docx", HTML)).toBe(previewFileName("报告.doc", HTML));
  });
});

describe("A-1133-P3 previewPage：安全前缀", () => {
  it("去掉扩展名、非法字符折成下划线、限长 40", () => {
    expect(previewSafeName("报告.docx")).toBe("报告");
    expect(previewSafeName("a/b:c.docx")).toBe("a_b_c");
    expect(previewSafeName("x".repeat(80) + ".docx")).toHaveLength(40);
  });

  it("空名 / 全非法名回落 `document`（不能让文件名变成 `.html` 这种隐藏文件）", () => {
    expect(previewSafeName(undefined)).toBe("document");
    expect(previewSafeName("   ")).toBe("document");
    expect(previewSafeName(".docx")).toBe("document");
  });
});
