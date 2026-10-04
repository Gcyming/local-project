/**
 * gui/src/renderer/pages/docAttachments.ts — 「文档附件」在消息文本里的**唯一编解码产地**。
 *
 * ## 为什么需要它（用户原话）
 * 「首先是输入栏，我不想要这种直接显示文件地址的方式，我自己都可以去复制文件地址，
 *   我要的是直接显示带图标的卡片。」
 *
 * ## 两条需求同时成立，且互相拉扯
 * · **界面**：不许出现地址 —— 输入栏与已发气泡里都只显示"图标 + 文件名"的卡片；
 * · **Agent**：必须拿到**磁盘路径**，否则它读不到文件（`file_read` 要路径）。
 * ⇒ 唯一解法：**编码进消息文本、在渲染时解出来**。
 *   文本里保留一行可机读的 `【附件】<绝对路径>`（Agent 与落库的历史都能看到路径），
 *   渲染层把它**拆出来变成卡片**，正文里不留地址。
 *
 * ⚠️ 为什么不做成"只放进 UI state"：历史落库在**主进程**（`history.jsonl` 存的是消息文本），
 *    只挂 state 的话切会话/重启后附件信息就丢了，而 Agent 那条路仍要路径 ⇒ 必然要进文本。
 *
 * ⚠️ 解析必须是**幂等**的：用户自己手打的 `【附件】xxx` 也会被拆出来（可接受：
 *    那正是同一件事的写法），但**不许**把正文里的其它 `【…】` 吃掉。
 */
export const DOC_ATTACH_MARK = "【附件】";

export type DocAttachment = { name: string; path: string };

/** 取路径的文件名（win/posix 都吃） */
export function baseNameOf(p: string): string {
  return (p ?? "").replace(/\\/g, "/").split("/").pop() ?? p;
}

/**
 * 把附件列表编码成消息文本里的一行块。
 * ⚠️ 前面补**两个换行**：让它在 Markdown 里自成一个块级段落，渲染正文时切掉它不会粘连。
 */
export function formatDocAttachments(paths: readonly string[]): string {
  const list = paths.map((p) => (p ?? "").trim()).filter(Boolean);
  if (list.length === 0) { return ""; }
  return `\n\n${list.map((p) => `${DOC_ATTACH_MARK}${p}`).join("\n")}`;
}

/**
 * 从消息文本里拆出附件块：返回**去掉附件行的正文** + 附件列表。
 *
 * 判据：只认"**整行**以 `【附件】` 开头"的行（行内出现不算）—— 用户正文里写到
 * "见【附件】说明"这种句子不该被吃掉半句。
 */
export function splitDocAttachments(text: string): { body: string; docs: DocAttachment[] } {
  const src = text ?? "";
  if (!src.includes(DOC_ATTACH_MARK)) { return { body: src, docs: [] }; }
  const docs: DocAttachment[] = [];
  const kept: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith(DOC_ATTACH_MARK)) {
      const path = t.slice(DOC_ATTACH_MARK.length).trim();
      if (path) { docs.push({ name: baseNameOf(path), path }); continue; }
    }
    kept.push(line);
  }
  /* 去掉尾部因附件块留下的空行（否则气泡底部会多出一段空白） */
  const body = kept.join("\n").replace(/\n+$/, "");
  return { body, docs };
}
