/**
 * 中途插入（排队 / 直接发送）的**文案与闸门**守卫 + 接线守卫。
 *
 * ## 本文件替代 `steer-intent.spec.ts`（A-1062 的方向选择器已撤销）
 *
 * 用户原话：「这个选项也没必要，原本的就够了，**排队不直接发送，不排队直接发送**，
 * 你还专门划分一下，很多余。现在当务之急是解决中途请求插入的问题」。
 *
 * ⇒ 撤掉 ◉引导 / ○排队 单选 + `steerIntent` 方向状态后，两条路各自有一个**动作**：
 *     · 回车（`send()`）→ 入队 `queue` = 排队，**不直接发送**；
 *     · 待发卡片的「引导」（`insertQueueItemNow`）→ `api.chat.steer` = **直接发送**。
 *
 * ## 这里锁住三件容易悄悄退化的事
 *
 * ① **文案与行为同源**（本项目反复踩的"说反话"）：placeholder/title 必须说"加入待发"，
 *    不能退回"输入消息（Enter 发送）"那种**新消息**口径，也不能声称"立刻注入"；
 * ② **回车不许自动投递**：`send()` 的入队分支里一旦再出现 `api.chat.steer(...)`，
 *    "排队"这条语义就**没有出口**了（这正是 A-1061⑦ 引入、A-1062 没修掉的病）；
 * ③ **"直接发送"的闸门必须与 `doSend` 同产地**：`insertQueueItemNow` 曾判 `streamActiveRef`
 *    （意图标记），而 A-1061⑤ 早已统一到**活动证据** `shouldDeferToSteer` ——
 *    两个判据打架的代价就是用户报的"某些时候还是会被打断重新输入正文 / 点了发不过去"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canSubmitSteer, insertNowTitle, isCompressWindow, steerPlaceholder, steerSubmitTitle,
} from "../../gui/src/renderer/pages/insertCopy.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 去掉块注释与整行行注释后再断言文本（注释里为了讲历史必然会提到旧写法） */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CHAT = "gui/src/renderer/pages/ChatPanel.tsx";

/** 三处用户可见文案（唯一出处都在 insertCopy.ts） */
const COPY: ReadonlyArray<readonly [string, string]> = [
  ["输入框 placeholder", steerPlaceholder()],
  ["发送按钮 title", steerSubmitTitle()],
  ["待发卡片「引导」title", insertNowTitle()],
];

describe("insertCopy · 压缩窗口判据（纯函数）", () => {
  it("prep / summarize / trunc 是窗口内（那时投了没人消费）", () => {
    expect(isCompressWindow("prep")).toBe(true);
    expect(isCompressWindow("summarize")).toBe(true);
    expect(isCompressWindow("trunc")).toBe(true);
  });

  it("A-1082：skip / overflow 也是窗口内（它们出现在**发送前**的压缩阶段，流还没起）", () => {
    // 若放行 → steer 落到没人消费的循环（空头支票）；反应式路径下还会与随后的重试流撞成两条并发流
    expect(isCompressWindow("skip"), "skip 放行 ⇒ 通知期间投出的引导无人消费").toBe(true);
    expect(isCompressWindow("overflow"), "overflow 放行 ⇒ 通知期间投出的引导无人消费").toBe(true);
  });

  it("🐛 done / null / undefined **不是**窗口内（压缩已结束，工具循环恢复消费引导）", () => {
    expect(isCompressWindow("done")).toBe(false);
    expect(isCompressWindow(null)).toBe(false);
    expect(isCompressWindow(undefined)).toBe(false);
  });
});

describe("insertCopy · 提交闸门（纯函数）", () => {
  it("有文字 → 可提交", () => {
    expect(canSubmitSteer("改一下这里", 0)).toBe(true);
  });

  it("只有图没有文字 → 仍可提交（对齐 doSend 的「只发图片」能力）", () => {
    expect(canSubmitSteer("", 1)).toBe(true);
  });

  it("🐛 纯空格不可提交（否则往队列塞一张既无文字又无图的幽灵卡片）", () => {
    expect(canSubmitSteer("   \n\t ", 0)).toBe(false);
  });

  it("空文本且无图 → 不可提交", () => {
    expect(canSubmitSteer("", 0)).toBe(false);
  });
});

describe("insertCopy · 文案说真话（防「说反话」）", () => {
  it("回车那条必须说**加入待发/排队**，不许退回「新消息」口径", () => {
    const ph = steerPlaceholder();
    const ti = steerSubmitTitle();
    for (const s of [ph, ti]) {
      expect(s, "运行中回车不是'发送新消息'，文案不能这么说").not.toMatch(/输入消息|Enter 发送/);
      expect(s, `必须说清它去待发/排队：${s}`).toMatch(/待发|排队/);
    }
  });

  it("🐛 回车那条**不许**声称立刻生效（它并不直接发送）", () => {
    const ph = steerPlaceholder();
    // 允许出现"立刻"但只能是在指路到另一个动作（点卡片）时出现
    expect(ph).toMatch(/现在插入|引导/);
    expect(steerSubmitTitle()).toMatch(/现在插入|引导/);
    // 「直接插入当前这一轮」这种承诺只能由卡片那个动作给出
    expect(ph).not.toMatch(/回车即.*注入/);
    expect(steerSubmitTitle()).not.toMatch(/回车.*注入/);
  });

  it("卡片「引导」那条必须说清**什么时候生效**（用户最容易误解的一点）", () => {
    const t = insertNowTitle();
    expect(t, "必须点明是注进当前这一轮").toMatch(/注进|插入/);
    expect(t, "必须点明生效时机 = 轮次边界").toMatch(/轮次边界/);
    expect(t, "必须交代插不进去时的去处（否则又被读成'点了没反应'）").toMatch(/顺延|下一轮/);
  });

  it("🐛 三处文案都不许混进实现黑话（用户原话「即将插入是什么鬼？」）", () => {
    for (const [what, s] of COPY) {
      expect(s, `${what} 混进了实现词：${s}`).not.toMatch(/即将插入|中途插入/);
    }
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 旧版（说反话）必须被判死
    const bad = "输入消息（Enter 发送，/ 展开指令，Shift+Enter 换行；可粘贴 / 拖拽图片识图）";
    expect(bad).toMatch(/输入消息|Enter 发送/);
    expect(steerPlaceholder()).not.toMatch(/输入消息|Enter 发送/);
  });
});

describe("insertCopy · 接线：两条路各自一个动作", () => {
  it("组件从 insertCopy 取文案与闸门（不再自己拼字符串）", () => {
    const src = code(CHAT);
    expect(src).toContain("from \"./insertCopy.js\"");
    expect(src).toContain("steerPlaceholder()");
    expect(src).toContain("steerSubmitTitle()");
    expect(src).toContain("insertNowTitle()");
    expect(src).toContain("canSubmitSteer(input, pendingImages.length)");
  });

  it("🐛 回车（`send()` 的流活跃分支）**只入队 `queue`**，不许顺手投递", () => {
    const src = code(CHAT);
    const atQueue = src.indexOf("if (loading || stopping) {");
    expect(atQueue, "找不到 send() 的流活跃分支").toBeGreaterThan(-1);
    const atEnd = src.indexOf("const hasVision = curProviderModel?.vision === true", atQueue);
    expect(atEnd, "找不到该分支的结束锚点").toBeGreaterThan(atQueue);
    const branch = src.slice(atQueue, atEnd);
    expect(branch, "回车必须落在 queue 态").toContain('mode: "queue"');
    expect(
      branch,
      "回车一旦自动投递，'排队'这条语义就再无出口（用户要的是两条路各自一个动作）",
    ).not.toMatch(/chat\??\.steer\??\./);
  });

  it("🐛 `doSend` 的 deferToSteer 兜底分支**也只入队**（同一缺陷的第二产地）", () => {
    // 「同名多产地」：修了 send() 却漏了 doSend() 的兜底路径 = 排队语义只剩一半出口
    const src = code(CHAT);
    const at = src.indexOf("if (deferToSteer) {");
    expect(at, "找不到 doSend 的 deferToSteer 分支").toBeGreaterThan(-1);
    const atEnd = src.indexOf("await maybeAutoCompress(targetSid ?? sessionId);", at);
    expect(atEnd, "找不到该分支的结束锚点").toBeGreaterThan(at);
    const branch = src.slice(at, atEnd);
    expect(branch, "兜底路径也必须落在 queue 态").toContain('mode: "queue"');
    expect(branch, "兜底路径一旦顺手投递，「排队」这条语义就再无出口").not.toMatch(/chat\??\.steer\??\./);
  });

  it("🐛 「直接发送」走 `insertQueueItemNow`，且闸门与 doSend 同产地（活动证据）", () => {
    const src = code(CHAT);
    const at = src.indexOf("async function insertQueueItemNow");
    expect(at, "找不到 insertQueueItemNow").toBeGreaterThan(-1);
    const body = src.slice(at, at + 4000);
    expect(body, "必须用唯一出处的判据 shouldDeferToSteer").toContain("shouldDeferToSteer({");
    expect(body, "唯一投递点（不调 chat.cancel）").toMatch(/chat\??\.steer\??\.\(/);
    expect(body, "压缩窗口必须拦下（投了没人消费 = 空头支票）").toContain("isCompressWindow(compressUi?.stage)");
    expect(body, "投递失败要退回 queue 态（否则卡片永远显示'已注入'）").toContain('setMode(interruptQueueRef.current, id, "queue")');
  });

  it("🐛 A-1062 的方向选择器**不得复活**（控件、状态、判据三样）", () => {
    const src = code(CHAT);
    expect(src, "方向单选行不该再出现").not.toContain("STEER_INTENT_OPTIONS");
    expect(src, "方向状态不该再出现").not.toMatch(/const \[steerIntent/);
    expect(src, "方向判据不该再出现").not.toContain("effectiveSteerIntent");
    // ⚠️ 不能简单断言「◉ 不存在」：ask_user 选项列表用的就是 `◉ 是 / ○ 否`
    //    （见 ChatPanel 的 askOption 渲染）—— 那是**另一个**控件，泛断言会误报。
    //    这里只锁「方向选择器特有的那对标记 + 标签」。
    expect(src, "◉/○ 方向行不该再出现").not.toMatch(/[◉○]\s*(引导|排队)/);
  });
});
