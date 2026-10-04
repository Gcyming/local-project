/**
 * tests/gui/a1133-drop-and-nav.spec.ts — 拖放分流与导航失败锁存的守卫（A-1133）。
 *
 * 事故（用户定性「重大事故」）：拖入 .docx/.pdf/.xlsx ⇒ 无休止
 * `GUEST_VIEW_MANAGER_CALL: ERR_FAILED (-2) loading 'file:///…docx'` + 文件夹疯狂生成无效文件 + 界面闪烁。
 * 两条判据是本轮修法的核心，都在这一个文件里锁住：
 *   ① `dropGuard.planFileDrop` —— 拖入的文件**怎么分流**（图片 / 文档 / 不支持）；
 *   ② `webviewNav.navAutoLoadAllowed` —— **自动重发**到底允不允许（"无休止"的闸门）。
 *
 * ⚠️ 两者都是**纯函数**，所以这里能真跑判据；变异脚本 `gui/scripts/mut-a1133-docs.mjs` 逐条弄红。
 *
 * ⚠️ 中文串里嵌引用一律「」。
 */
import { describe, expect, it } from "vitest";
import { dropPlanIsEmpty, isFileDrag, planFileDrop } from "../../gui/src/renderer/pages/dropGuard.js";
import {
  clearNavFailure, isNavLatchBlocked, isTerminalNavFailure, navAutoLoadAllowed, noteNavFailure,
  type NavFailureBook,
} from "../../gui/src/renderer/pages/webviewNav.js";

const f = (name: string, type = "") => ({ name, type });

describe("A-1133-A planFileDrop：拖入的文件怎么分流", () => {
  it("图片进聊天（既有行为不许丢）", () => {
    const p = planFileDrop([f("a.png", "image/png"), f("b.jpg", "image/jpeg")]);
    expect(p.images.map((x) => x.index)).toEqual([0, 1]);
    expect(p.documents).toHaveLength(0);
  });

  it("⚠️ 工作文档进**文档通道**（不是 rejected、也不是 images）—— 这正是本次事故的主诉", () => {
    const p = planFileDrop([f("报告.docx"), f("表.xlsx"), f("稿.pptx"), f("说明.pdf"), f("notes.md")]);
    expect(p.documents.map((x) => x.index), "工作文档被丢掉或误判 ⇒ 用户看到「拖进来没反应」").toEqual([0, 1, 2, 3, 4]);
    expect(p.rejected).toHaveLength(0);
    expect(p.images).toHaveLength(0);
  });

  it("⚠️ 老版格式（.doc/.xls/.ppt）**必须进文档通道**，不许拒（仓库的 OLE 解析器能真读它们）", () => {
    /* 2026-09-28 用户当场拍到的事故：拖入 .ppt 弹「暂不支持」。
       根因是我把 `fileKinds.legacy`（= 格式老）当成了"读不了"。
       判据必须是 `parser === "none"` 才算读不了 —— 「格式老」与「读不了」是两件事。 */
    const p = planFileDrop([f("旧.doc"), f("旧.xls"), f("旧.ppt")]);
    expect(p.documents.map((x) => x.index), "老版 Office 是可读文档，必须接住").toEqual([0, 1, 2]);
    expect(p.rejected, "不许把它们拒掉").toHaveLength(0);
  });

  it("真正读不了的（.zip/.bin/无扩展名）才进 rejected，且带可操作原因", () => {
    const p = planFileDrop([f("a.zip"), f("a.bin"), f("noext")]);
    expect(p.rejected.map((x) => x.index)).toEqual([0, 1, 2]);
    for (const r of p.rejected) {
      expect(r.reason.length, "拒绝必须给出理由，否则表现成「拖进来没反应」").toBeGreaterThan(0);
    }
  });

  it("混拖：图片与文档**两边都要接住**（旧代码只认图片 ⇒ 文档掉进 Chromium 默认导航）", () => {
    const p = planFileDrop([f("a.png", "image/png"), f("b.docx"), f("c.bin")]);
    expect(p.images.map((x) => x.index)).toEqual([0]);
    expect(p.documents.map((x) => x.index)).toEqual([1]);
    expect(p.rejected.map((x) => x.index)).toEqual([2]);
  });

  it("空拖 / 无文件：plan 为空（调用方据此静默忽略，不弹无意义提示）", () => {
    expect(dropPlanIsEmpty(planFileDrop([]))).toBe(true);
    expect(dropPlanIsEmpty(planFileDrop([f("a.png", "image/png")]))).toBe(false);
  });

  it("闸门判据：只有真的带 Files 才算文件拖入（文本拖入不该被拦）", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });
});

describe("A-1133-B 导航失败锁存：自动重发的闸门（「无休止报错」的终结者）", () => {
  it("`-3` ERR_ABORTED 是正常噪声 ⇒ **不进**账本（进了会把正常导航误判成终态）", () => {
    const book: NavFailureBook = new Map();
    expect(noteNavFailure(book, "https://a", -3), "-3 不该记为失败").toBe(false);
    expect(isNavLatchBlocked(book, "https://a")).toBe(false);
    expect(isTerminalNavFailure(-3)).toBe(false);
    expect(isTerminalNavFailure(-2), "-2 才是真失败").toBe(true);
  });

  it("⚠️ 真失败过一次 ⇒ **所有自动通路**都不许再重发（这就是「无休止」的闸门）", () => {
    const book: NavFailureBook = new Map();
    const url = "file:///D:/x/报告.docx";
    expect(noteNavFailure(book, url, -2)).toBe(true);
    expect(isNavLatchBlocked(book, url)).toBe(true);
    for (const trigger of ["attach", "url-change", "net"] as const) {
      expect(navAutoLoadAllowed(book, url, trigger, false), `${trigger} 通路还在重发已判死的地址`).toBe(false);
    }
    /* 手动重试是唯一逃生口（用户的明确意图）—— 不许也被挡掉，否则错误页上的按钮是死的。 */
    expect(navAutoLoadAllowed(book, url, "manual", true)).toBe(true);
  });

  it("用户手动「重试」清账本后，该地址恢复可加载", () => {
    const book: NavFailureBook = new Map();
    noteNavFailure(book, "https://a", -2);
    clearNavFailure(book, "https://a");
    expect(isNavLatchBlocked(book, "https://a")).toBe(false);
    expect(navAutoLoadAllowed(book, "https://a", "url-change", false)).toBe(true);
  });

  it("⚠️ 安全网（`net`）在 guest 已 attach 后必须停手 —— 它的职责只是首帧竞态兜底", () => {
    const book: NavFailureBook = new Map();
    expect(navAutoLoadAllowed(book, "https://a", "net", false), "attach 前的兜底要放行").toBe(true);
    expect(navAutoLoadAllowed(book, "https://a", "net", true), "attach 后仍定时重发 = 力竭式重试").toBe(false);
  });

  it("空地址一律不许加载（否则会往 webview 里塞空导航）", () => {
    const book: NavFailureBook = new Map();
    for (const t of ["attach", "url-change", "net"] as const) {
      expect(navAutoLoadAllowed(book, "", t, false)).toBe(false);
    }
    expect(noteNavFailure(book, "", -2), "空地址不记账").toBe(false);
  });

  it("账本按**地址**隔离：另一个地址不受牵连", () => {
    const book: NavFailureBook = new Map();
    noteNavFailure(book, "https://a", -2);
    expect(navAutoLoadAllowed(book, "https://b", "url-change", false)).toBe(true);
  });
});
