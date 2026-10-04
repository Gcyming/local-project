






















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collapseBlankRuns, BLANK_RUN_KEEP } from "../../gui/src/renderer/pages/messageText.js";

const ROOT = join(__dirname, "..", "..");
const CHAT_PANEL = join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");



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
    expect(collapseBlankRuns("A\n\n\n\nB", 0)).toBe("A\n\nB"); 
    expect(collapseBlankRuns("A\n\n\n\nB", Number.NaN)).toBe("A\n\nB");
  });
});

describe("A-1052 B 组：ChatPanel 源码契约", () => {
  it("三处纯文本渲染点都走 collapseBlankRuns（用户气泡 + 发言失败 + 错误气泡）", () => {
    



    const userBubble = chatSrc.match(/\{collapseBlankRuns\(att\.body\)\}/g) ?? [];
    expect(userBubble.length, "用户气泡必须渲染**去掉附件行**的正文").toBe(1);
    const others = chatSrc.match(/\{collapseBlankRuns\(m\.content\)\}/g) ?? [];
    expect(others.length, "发言失败 + 错误气泡两处仍取原文").toBe(2);
    expect(userBubble.length + others.length, "纯文本渲染点总数").toBe(3);
  });

  it("不得再有裸 `{m.content}` 直落在 pre-wrap 容器里", () => {
    
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
    
    
    expect((chatSrc.match(/collapseBlankRuns\(/g) ?? []).length).toBe(3);
    



    expect(/message: (text|outbound), sessionId: sid/.test(chatSrc), "发送路径不得用净化后的文本").toBe(true);
    expect(/message: collapseBlankRuns/.test(chatSrc), "净化绝不许进入发送路径").toBe(false);
  });

  it("净化模块必须真的被 import —— 否则「调用计数」可被「名字还在、实现没了」绕过", () => {
    expect(/import \{ collapseBlankRuns \} from "\.\/messageText\.js";/.test(chatSrc)).toBe(true);
  });
});
