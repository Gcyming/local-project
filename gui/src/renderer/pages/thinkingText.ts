/**
 * gui/src/renderer/pages/thinkingText.ts — 思考文本净化纯函数（无 React 依赖，vitest 可直测）。
 *
 * 为什么独立成模块：思考内容来自各上游的 reasoning_content，形态极脏——逐 token 换行、
 * 词内被空格切开、模型把预训练 XML 工具格式泄进思考、中文 token 级空格（`好 的 ， 我`）。
 * 这些净化规则必须有回归测试兜住，否则一次"顺手优化正则"就会像本轮这样把整段英文粘成一坨。
 *
 * 三条规则的分工：
 *   normalizeThinkingText —— 只处理**换行**：单换行（逐 token 断行）→ 空格；空行 → 段落分隔。
 *   stripMarkdown         —— 摘要行用：抹掉 markdown 符号，避免折叠标题暴露 * # |。
 *   sanitizeThinking      —— 展开正文用：剥 XML 残留 + 归一空白 + 拼合被切开的英文词。
 */

/** 摘要用：把 markdown 符号剥离成纯文本（时间线思考步的折叠标题，避免暴露 * # | 等底层符号） */
export function stripMarkdown(text: string): string {
  return text
    .replace(/`{1,4}/g, "")
    .replace(/[#*_>|~]{1,3}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 规范化思考文本：单换行合并为空格（模型逐 token 输出带单换行），双换行保留为段落分隔。
 * 避免 white-space: pre-wrap 把逐词换行全部保留导致"每个字独占一行"。
 */
export function normalizeThinkingText(text: string): string {
  // 先按 \n\n 分段 → 段内单 \n 合并为空格 → 段间保留 \n\n
  return text
    .split(/\n\s*\n/)
    .map(seg => seg.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(seg => seg.length > 0)
    .join("\n\n");
}

/**
 * A-923：思考过程整体净化——
 *   ① 剥离 XML 风格工具调用残留（`<parameter>`/`<function>`/`<tool_call>`/`<result>` 等半成品标签，
 *      模型把预训练 XML 工具格式泄进 reasoning，样例：`</parameter name="test_file.txt">` 直接露出）；
 *   ② 归一空白（逐词断行 / 多余空格合并）；
 *   ③ 拼合被 token 断行切开的英文词。
 * 输出为可读纯文本，供思考卡与最终 reasoning 折叠卡。
 */
export function sanitizeThinking(text: string): string {
  const stripped = (text ?? "")
    .replace(/<\/?(?:parameter|function|tool_call|result|safety|safety_check|ban_message|reasoning|system)\b[^>]*>/gi, "");
  return normalizeThinkingText(stripped)
    // A-924：收敛词间空格观感——中文标点前不得留空格、开括号后不得留空格（上游 token 级空格常见 `好 的 ， 我`）
    .replace(/\s+([，。；：！？、）》】）])/g, "$1")
    .replace(/([（《【])\s+/g, "$1")
    // A-928：思考区英文 token 断词收敛（`B ing`→`Bing`、`S tudio`→`Studio`）——上游逐 token 换行会把
    // 单词内部切成两半，normalizeThinkingText 已把该换行转成空格，故此处只在「单词首字母 + 小写词尾」时拼合。
    // ⚠️ 历史上的 /([A-Za-z0-9])\s+([A-Za-z0-9])/g 会删掉**任意**两个字母数字之间的空格，
    // 把 "The user is asking" 变成 "Theuserisasking"（本轮 bug 根因）——已收窄为：
    //   ① 单字母开头（排除冠词 a/A/i/I，避免吃掉 "a cat" / "I think" 的空格）
    //   ② 2 个以上小写字母结尾，两端都要有词边界（`\b`）
    //   ③ 负向断言排除撇号后紧跟的字母——否则 "DeepSeek's web" 会被误判为
    //      「s + web」两个 token 而粘成 "DeepSeek'sweb"（所有格、缩写的 's 必须原样保留）。
    .replace(/(?<!['\u2018\u2019])\b([b-hj-zB-HJ-Z])\s+([a-z]{2,})\b/g, "$1$2");
}
