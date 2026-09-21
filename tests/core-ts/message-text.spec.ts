/**
 * tests/core-ts/message-text.spec.ts — 「巨型气泡」的渲染前净化守卫（A-1052）。
 *
 * 盯的病：**用户真机截图里出现一整块满宽的高饱和底色，里面只有顶行一句话、底行一句话，
 * 中间是约 630px 的纯空白**（气泡总高 646px）。
 *
 * 像素取证（`C:\Users\MR\Pictures\Screenshots\屏幕截图 2026-09-21 165320.png` 逐像素解码）：
 *   - 底色 `#38bdf8`，与 beta 主题的 `--accent` **逐字节相同**；页面底色 `#05070e` = beta `--bg`。
 *   - 色块右边缘与该按钮上方那条用户气泡的右边缘同为 808，宽 724 = `maxWidth: 78%` 的取值
 *     → 容器宽 928，即聊天内容区宽；左上圆角半径 ≈20（对上气泡的 `borderRadius: 16px`）。
 *   - 文字带只有两条：y=135..151（白字）与 y=786..803（白字 + 图标）。
 *   ⟹ 这不是配色错误，而是 **`whiteSpace: "pre-wrap"` 把正文里的连续空行各撑成一整行**
 *      （14px × 1.55 ≈ 21.7px/行，30 行 ≈ 650px）。两句话的正文被撑成巨型色块。
 *
 * 这一族守卫锁两个层次，缺一层就会重演：
 *  A. **语义层**（`collapseBlankRuns`）：只收敛**连续空行**与首尾空行；
 *     **单换行必须原样保留**（用户粘贴多行日志/报错时单换行是有意义的排版）。
 *  B. **契约层**（ChatPanel 源码静态不变式）：三处纯文本渲染点都必须走它；
 *     而**复制/回滚仍取原始 `m.content`** —— 否则用户复制到的是被改写过的文本。
 *
 * ⚠️ 验收标准是**变异测试**：写完必须逐条把源码改坏、确认它变红。
 *    "通过但锁错对象"比没有守卫更糟。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collapseBlankRuns, BLANK_RUN_KEEP } from "../../gui/src/renderer/pages/messageText.js";

const ROOT = join(__dirname, "..", "..");
const CHAT_PANEL = join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");

/** 断言前必须剥注释：本仓库的注释里**故意**引用老写法与事故形态，不剥会对自己的说明假红。
 *  行注释用 `[^:]` 前缀避开 `http://`。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const chatSrc = stripComments(readFileSync(CHAT_PANEL, "utf8"));

describe("A-1052 A 组：collapseBlankRuns 语义", () => {
  it("默认保留 1 个空行（连续换行上限 = 2）", () => {
    expect(BLANK_RUN_KEEP).toBe(2);
  });

  it("连续空行收敛为 1 个 —— 30 个空行不再撑出 650px 空白", () => {
    const src = `让我深入检查一下当前加载状态。${"\n".repeat(31)}找到问题了！`;
    const out = collapseBlankRuns(src);
    expect(out).toBe("让我深入检查一下当前加载状态。\n\n找到问题了！");
    // 行数从 32 行降到 3 行 —— 这就是"巨型"消失的量化口径
    expect(out.split("\n").length).toBe(3);
  });

  it("**单换行必须原样保留**（粘贴多行日志/报错不能被揉成一行）", () => {
    const src = "第一行\n第二行\n第三行";
    expect(collapseBlankRuns(src)).toBe("第一行\n第二行\n第三行");
  });

  it("恰好 1 个空行（\\n\\n）也不动 —— 段落分隔是正常排版", () => {
    expect(collapseBlankRuns("一段\n\n二段")).toBe("一段\n\n二段");
  });

  it("CRLF 归一：Windows 复制粘贴的 \\r\\n 同样要收敛", () => {
    const src = "A\r\n\r\n\r\n\r\nB";
    expect(collapseBlankRuns(src)).toBe("A\n\nB");
  });

  it("**只含空格/制表符的行算空行** —— pre-wrap 下看不见的空白行同样占一整行", () => {
    expect(collapseBlankRuns("A\n   \n\t\n  \nB")).toBe("A\n\nB");
  });

  it("去掉首尾空行（它们各自贡献一整行高度，且没有排版价值）", () => {
    expect(collapseBlankRuns("\n\n\n正文\n\n\n")).toBe("正文");
    // 注意：只去"空行"，**不去整行首尾的空白** —— 行内缩进是有意义的（见下一条）
    expect(collapseBlankRuns("  \n 正文 \n ")).toBe(" 正文 ");
  });

  it("不清洗行内空白（不能被当成 trim 用）", () => {
    expect(collapseBlankRuns("  缩进保留\n    更深  ")).toBe("  缩进保留\n    更深  ");
  });

  it("幂等：再跑一次结果不变", () => {
    const once = collapseBlankRuns("A\n\n\n\n\nB\n\n\n");
    expect(collapseBlankRuns(once)).toBe(once);
  });

  it("空串 / 只有空白的输入不炸", () => {
    expect(collapseBlankRuns("")).toBe("");
    expect(collapseBlankRuns("\n\n\n")).toBe("");
  });

  it("keep 参数可调（1 = 不留空行；非法值回退默认）", () => {
    expect(collapseBlankRuns("A\n\n\n\nB", 1)).toBe("A\nB");
    expect(collapseBlankRuns("A\n\n\n\nB", 0)).toBe("A\n\nB"); // 非法 → 回退 BLANK_RUN_KEEP
    expect(collapseBlankRuns("A\n\n\n\nB", Number.NaN)).toBe("A\n\nB");
  });
});

describe("A-1052 B 组：ChatPanel 源码契约", () => {
  it("三处纯文本渲染点都走 collapseBlankRuns（用户气泡 + 发言失败 + 错误气泡）", () => {
    const hits = chatSrc.match(/\{collapseBlankRuns\(m\.content\)\}/g) ?? [];
    expect(hits.length).toBe(3);
  });

  it("不得再有裸 `{m.content}` 直落在 pre-wrap 容器里", () => {
    // 三处渲染点已被 collapseBlankRuns 包住 → 裸写法必须绝迹
    expect(chatSrc.includes("{m.content}")).toBe(false);
  });

  it("**复制仍取原始 m.content**（渲染净化不许污染剪贴板）", () => {
    expect(/clipboard\.writeText\(m\.content\)/.test(chatSrc)).toBe(true);
    expect(/clipboard\.writeText\(collapseBlankRuns/.test(chatSrc)).toBe(false);
  });

  it("**回滚仍取原始 content**（渲染净化不许污染输入框）", () => {
    expect(/setInput\(target\.content\)/.test(chatSrc)).toBe(true);
    expect(/setInput\(collapseBlankRuns/.test(chatSrc)).toBe(false);
  });

  it("净化只在渲染层调用 —— 落库/发送路径（doSend）不得触碰原文", () => {
    // 全文件**调用**恰好 3 处（import 行后跟空格而非左括号，不计）；多一处即有人把它
    // 塞进了发送/落库路径 → 用户发出去、存下去的就是被改写过的文本。
    expect((chatSrc.match(/collapseBlankRuns\(/g) ?? []).length).toBe(3);
    // 发送路径的正文仍是原始 text（`api.chat.stream({ …, message: text, sessionId: sid … })`）
    expect(/message: text, sessionId: sid/.test(chatSrc)).toBe(true);
  });

  it("净化模块必须真的被 import —— 否则「调用计数」可被「名字还在、实现没了」绕过", () => {
    expect(/import \{ collapseBlankRuns \} from "\.\/messageText\.js";/.test(chatSrc)).toBe(true);
  });
});
