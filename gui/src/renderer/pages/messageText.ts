/**
 * gui/src/renderer/pages/messageText.ts — 消息正文的**渲染前净化**（纯函数，零依赖，vitest 直测）。
 *
 * 起因（A-1052，用户真机截图 + 像素取证）：
 *   用户报「巨型蓝色气泡」——气泡里所有可见文字只有顶行一句叙述与底行一句结论，
 *   中间是一大片**纯底色空白**（实测 646px 高里约 630px 是空的）。
 *
 *   根因不是配色、也不是气泡宽度，而是 **`whiteSpace: "pre-wrap"` 原样保留了正文里的连续空行**：
 *   预格式化下每个空行都占**一整行**（14px × 1.55 ≈ 21.7px），30 个空行就是 650px。
 *   于是"两句话的正文"被撑成一块满宽（`maxWidth: 78%`）的巨型色块。
 *
 * 为什么只折叠**空行**、绝不合并单换行：
 *   用户粘贴多行文本（日志、代码、报错串）时，**单换行是有意义的排版**；
 *   而连续空行只是模型/复制粘贴带出的噪声。`normalizeThinkingText` 会把单换行并成空格——
 *   那是"思考逐 token 断行"场景的口径，用在正文上会把用户的换行吃掉，故另开这一份，
 *   口径只做收敛、不做重排。
 *
 * ⚠️ 只用于**渲染**：复制/回滚必须拿原始 `m.content`（见 UserMessage 的 handleCopy /
 *    rollbackTo），否则用户复制到的是被改写过的文本。
 *
 * 为什么不并进 `Markdown.tsx` 的 `normalizeBrokenLines`（已有的 pre-wrap 通用兜底）：
 *   那是**另一个缺陷**——"token 碎片化换行"（每词一行）。而且它同时被 Markdown 管道与
 *   `<pre>` 代码块复用（`Markdown.tsx` 612 / 676），**代码块里的连续空行是有意义的**，
 *   把"折叠空行 + 去首尾空行"塞进去会改动代码文本。两者解决的问题不同、能承受的改写强度
 *   也不同，故各自独立，不合并。
 */

/** 折叠后保留的连续换行数：2 = 恰好留 1 个空行（段落分隔）。 */
export const BLANK_RUN_KEEP = 2;

/**
 * 折叠连续空行 + 去掉首尾空行，其余字符一律不动。
 *
 * 四步（顺序有意义）：
 *   ① 统一 `\r\n` / `\r` → `\n`（Windows 复制粘贴带 CRLF，漏了这一步 `\n{3,}` 就匹配不到）；
 *   ② 只含空格/制表符的行归一为**真空行** —— pre-wrap 下"看不见的空白行"同样占一整行，
 *      这是最容易漏的一类（`"   \n   \n   \n"` 在界面上与三个空行完全一样）；
 *   ③ 连续 `\n{3,}` 收敛为 2 个（= 1 个空行）；
 *   ④ 去掉正文首尾的空行（开头/结尾的空行没有任何排版价值，却各自贡献一整行高度）。
 */
export function collapseBlankRuns(text: string, keep: number = BLANK_RUN_KEEP): string {
  if (!text) { return text; }
  const n = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : BLANK_RUN_KEEP;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]+$/gm, "")
    .replace(new RegExp(`\\n{${n + 1},}`, "g"), "\n".repeat(n))
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
