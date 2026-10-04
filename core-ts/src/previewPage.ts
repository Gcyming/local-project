/**
 * core-ts/src/previewPage.ts — 「文档渲染页」的**落盘命名唯一产地**。
 *
 * ## 为什么单独成一个模块（这次踩的坑）
 * 主进程写文件用了一个名字、返回给渲染层的**却是另一个名字**：
 *   写的是 `<safe>-<hash>.html`，返回的 `name` 是 `<safe>.html`
 * ⇒ 右栏浏览器页按 `name` 拼 URL ⇒ **404 ⇒ 整页空白**（用户实测：「现在网页上什么都出现不了」）。
 *
 * 根因不是"写错了一个字符"，而是**同一件事（这个页面叫什么）有两个产地**。
 * ⇒ 收敛成本模块：谁要文件名、要写文件、要拼 URL，都从这里取；两个产地变一个。
 *
 * ## 两条硬约束（都来自实测）
 * 1. **幂等**：文件名由**内容哈希**决定（同内容 ⇒ 同名 ⇒ 覆盖），**禁止时间戳/自增序号** ——
 *    否则每看一次多一个文件，`doc-preview` 目录无限膨胀。
 * 2. **安全**：文档名里可能有 `\ / : * ? " < > |`（Windows 非法字符）与超长文本，
 *    直接拼进路径会失败或越界 ⇒ 统一走 `previewSafeName` 清洗（**只清洗文件名，不改变语义**）。
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

/** 文件名里的安全前缀（去非法字符、去扩展名、限长；空则回落 `document`）。 */
export function previewSafeName(name: string | undefined): string {
  const raw = (name ?? "").trim();
  const noExt = raw.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const safe = noExt.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 40);
  return safe || "document";
}

/** 渲染页的**唯一文件名**：`<安全前缀>-<内容哈希前 16 位>.html`。 */
export function previewFileName(name: string | undefined, html: string): string {
  const hash = createHash("sha1").update(html).digest("hex").slice(0, 16);
  return `${previewSafeName(name)}-${hash}.html`;
}

/**
 * 渲染页的**绝对路径** = `dir` + 唯一文件名。
 * ⚠️ 调用方**必须**把 `previewFileName(...)`（同一个函数）作为 `name` 返回给渲染层去拼 URL，
 * 否则又回到"两个产地"⇒ 404。`tests/core-ts/a1133-preview-page.spec.ts` 锁这条。
 */
export function previewHtmlPath(dir: string, name: string | undefined, html: string): { path: string; name: string } {
  const fileName = previewFileName(name, html);
  return { path: join(dir, fileName), name: fileName };
}

/** URL 里要用的文件名（防御：万一有人传了路径进来，只取最后一段）。 */
export function previewUrlName(writtenPathOrName: string): string {
  return basename(writtenPathOrName);
}
