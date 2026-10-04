







import { describe, expect, it } from "vitest";
import { DOC_ATTACH_MARK, baseNameOf, formatDocAttachments, splitDocAttachments } from "../../gui/src/renderer/pages/docAttachments.js";

describe("A-1133-A 编码：附件块长什么样", () => {
  it("空列表不产生任何块（否则每条消息都会多出两个空行）", () => {
    expect(formatDocAttachments([])).toBe("");
    expect(formatDocAttachments(["", "   "])).toBe("");
  });

  it("每个路径一行、行首是机读标记（Agent 与落库历史都能看出这是附件）", () => {
    const block = formatDocAttachments(["D:\\a\\报告.docx", "/home/x/表.xlsx"]);
    expect(block.startsWith("\n\n"), "前面要空出块级边界，否则会和正文粘在同一段").toBe(true);
    const lines = block.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`${DOC_ATTACH_MARK}D:\\a\\报告.docx`);
  });
});

describe("A-1133-B 解码：拆出正文与附件（界面据此显示卡片）", () => {
  it("round-trip：encode → decode 拿回原文与路径", () => {
    const body = "帮我看看这份报告讲了什么";
    const paths = ["D:\\Downloads\\张龚文-《互联网思维》.docx"];
    const text = body + formatDocAttachments(paths);
    const r = splitDocAttachments(text);
    expect(r.body, "正文必须原样回来（附件行不该混在正文里显示）").toBe(body);
    expect(r.docs).toEqual([{ name: "张龚文-《互联网思维》.docx", path: paths[0] }]);
  });

  it("无附件时是恒等变换（绝不动正文一个字符）", () => {
    const t = "一行正文\n\n另一段";
    const r = splitDocAttachments(t);
    expect(r.body).toBe(t);
    expect(r.docs).toHaveLength(0);
  });

  it("⚠️ 只认**整行**以标记开头：正文里写到标记不该被吃掉半句", () => {
    const t = "见【附件】说明那一节\n【附件】D:\\x\\a.docx";
    const r = splitDocAttachments(t);
    expect(r.body, "行内出现的标记必须留在正文里").toContain("见【附件】说明那一节");
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("a.docx");
  });

  it("幂等：拆过的文本再拆一次不会再少东西", () => {
    const once = splitDocAttachments("正文" + formatDocAttachments(["D:\\a\\b.pdf"]));
    const twice = splitDocAttachments(once.body);
    expect(twice.body).toBe(once.body);
    expect(twice.docs).toHaveLength(0);
  });

  it("尾部空行被清掉（否则气泡底部会多出一截空白）", () => {
    const r = splitDocAttachments("正文\n\n【附件】D:\\a\\b.pdf\n");
    expect(r.body).toBe("正文");
  });

  it("多个附件按顺序全部接住", () => {
    const r = splitDocAttachments("看这三个" + formatDocAttachments(["D:\\1.docx", "D:\\2.xlsx", "D:\\3.pptx"]));
    expect(r.docs.map((d) => d.name)).toEqual(["1.docx", "2.xlsx", "3.pptx"]);
  });
});

describe("A-1133-C baseNameOf：win / posix 两种分隔符都要认", () => {
  it("取文件名", () => {
    expect(baseNameOf("D:\\a\\b\\报告.docx")).toBe("报告.docx");
    expect(baseNameOf("/home/x/表.xlsx")).toBe("表.xlsx");
    expect(baseNameOf("只有文件名.docx")).toBe("只有文件名.docx");
    expect(baseNameOf("")).toBe("");
  });
});
