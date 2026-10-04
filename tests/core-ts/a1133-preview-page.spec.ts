/**
 * tests/core-ts/a1133-preview-page.spec.ts — 「文档渲染页」落盘命名的守卫（A-1133）。
 *
 * 需求（用户原话）：「不是说了变换成 HTML 吗，如图怎么还在文件查看器内？」→ 转 HTML 落地后，
 * 紧接着用户实测「现在网页上什么都出现不了」（右栏浏览器页**整页空白**）。
 *
 * 根因不是"写错了一个字符"，而是**同一件事（这个页面叫什么）有两个产地**：
 *   主进程写的是 `<safe>-<contentHash>.html`，返回给渲染层的 `name` 却是 `<safe>.html`
 *   ⇒ 右栏按 `name` 拼 URL ⇒ 指向一个**不存在的文件** ⇒ 404 ⇒ 空白页。
 *
 * 本文件锁三件事（都对应一个**可复现的**真实后果）：
 *   ① **同源**：`previewHtmlPath` 返回的 `name` 必须**逐字节等于**落盘文件的 `basename`
 *      —— 这条一破，右栏就 404（就是用户拍到的空白页）；
 *   ② **幂等**：同一份 HTML 必须给出同一个文件名（否则每看一次多一个文件、`doc-preview` 目录无限膨胀）；
 *   ③ **安全**：文档名里的 Windows 非法字符 / 超长名不能拼进路径（会写盘失败或越界）。
 */
import { describe, expect, it } from "vitest";
import { basename, join } from "node:path";
import { previewFileName, previewHtmlPath, previewSafeName, previewUrlName } from "../../core-ts/src/previewPage.js";

const HTML = "<!doctype html><html><body><p>正文</p></body></html>";

describe("A-1133-P1 previewPage：path 与 name 必须同源（404 空白的根因）", () => {
  /* ⚠️ 这是**唯一一条真正锁住用户那次的 bug 的判据**：
     一旦谁再让两处分别算文件名，URL 就会指向不存在的文件 ⇒ 整页空白。 */
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
