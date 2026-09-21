/**
 * tests/core-ts/a1056-guards.spec.ts — A-1056 回归守卫
 *   ① 阶段久等的激励语（阈值 5s / 轮换 4s / 文案不许写成"用法说明"）
 *   ② 监测栏不再承载"激励语那一块"（那一块搬到 Agent 输出最下方的状态行）
 *
 * 为什么要有这些断言：这两条都是**用户直接读到的观感**，且都极易在后续改动里悄悄回退 ——
 * 阈值被人改成 3s（太早出场）、句子被人补一句"输入消息… Enter 发送"（又变说明书）、
 * 状态行被人搬回监测栏。它们不会让任何类型检查失败，只会在用户脸上翻车。
 *
 * ⚠️ 中文文案里嵌套引用一律用 `「」`：ASCII 双引号会当场把字符串截断（a1054 踩过，本文件也踩过一次）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHEER_AFTER_MS,
  CHEER_ROTATE_MS,
  CHEER_PHRASES,
  pickCheer,
  shouldCheer,
} from "../../gui/src/renderer/pages/cheerPhrases.js";

const chatPanelPath = fileURLToPath(new URL("../../gui/src/renderer/pages/ChatPanel.tsx", import.meta.url));
const chatPanelSrc = readFileSync(chatPanelPath, "utf8");
const cheerPoolSrc = readFileSync(
  fileURLToPath(new URL("../../gui/src/renderer/pages/cheerPhrases.ts", import.meta.url)),
  "utf8",
);
/** 断言"代码里没有 X"时必须先剥注释：ChatPanel 里那段**追述性注释**会合法地提到旧符号
 *  （记录"为什么删"），把注释当成实现会让守卫变成"注释不许写历史"这种伪命题（a1054 同做法）。 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("A-1056① 激励语节拍", () => {
  it("阈值就是用户点名给的 5s，轮换不慢于阈值", () => {
    expect(CHEER_AFTER_MS).toBe(5000);
    expect(CHEER_ROTATE_MS).toBeGreaterThan(0);
    expect(CHEER_ROTATE_MS).toBeLessThanOrEqual(CHEER_AFTER_MS * 4);
  });

  it("shouldCheer：4999ms 不出场，5000ms 出场，非有限数不出场", () => {
    expect(shouldCheer(0)).toBe(false);
    expect(shouldCheer(CHEER_AFTER_MS - 1)).toBe(false);
    expect(shouldCheer(CHEER_AFTER_MS)).toBe(true);
    expect(shouldCheer(60_000)).toBe(true);
    // 时钟没量到就不播 —— 宁可不播，也不能因为 NaN 比较意外为真而乱播
    expect(shouldCheer(Number.NaN)).toBe(false);
    expect(shouldCheer(Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldCheer(-1)).toBe(false);
  });

  it("pickCheer：任意 seed（含负数/小数/超大）都落在合法下标，且同 seed 稳定", () => {
    const n = CHEER_PHRASES.length;
    for (const seed of [-1234, -1, 0, 1, 3, 17, 999, 1e9, 3.9, -0.2]) {
      const got = pickCheer(seed);
      expect(CHEER_PHRASES).toContain(got);
      // 同 seed 两次结果必须一致（否则状态行会每帧闪不同句子）
      expect(pickCheer(seed)).toBe(got);
    }
    expect(pickCheer(Number.NaN)).toBe(CHEER_PHRASES[0]);
    // 相邻 seed 轮换到不同句子（真正在"循环"而不是卡住一句）
    expect(pickCheer(0)).not.toBe(pickCheer(1 % n === 0 ? 2 : 1));
  });
});

describe("A-1056② 激励语文案纪律", () => {
  it("已扩充（用户要求「扩充活泼阳光的」）：至少 12 句", () => {
    expect(CHEER_PHRASES.length).toBeGreaterThanOrEqual(12);
  });

  it("每句都带表情包（emoji / 颜文字），不是纯文字", () => {
    // 覆盖常见 emoji 区段 + 颜文字符号；尾字符是 ASCII 单词的句子会被判失败
    const emojiLike = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\^[\^_]?\^|T_T|>_<|–/u;
    for (const p of CHEER_PHRASES) {
      expect(emojiLike.test(p), `这句没有表情包：${p}`).toBe(true);
    }
  });

  it("**删掉使用说明类**：文案里不许出现快捷键/输入引导", () => {
    const banned = [
      /Enter/i,
      /Shift/i,
      /粘贴/,
      /拖拽/,
      /剪贴板/,
      /输入消息/,
      /\/\s*展开指令/,
      /提示：/,
    ];
    for (const p of CHEER_PHRASES) {
      for (const b of banned) {
        expect(b.test(p), `激励语里混进了用法说明（${b}）：${p}`).toBe(false);
      }
    }
  });
});

describe("A-1056③ 监测栏与状态行的分工不许回退", () => {
  it("旧的使用说明型占位语列表已从 ChatPanel 代码里移除（注释里的追述不算）", () => {
    const code = strip(chatPanelSrc);
    expect(code.includes("PLACEHOLDER_PHRASES")).toBe(false);
    expect(code.includes("placeholderIndex")).toBe(false);
  });

  it("底部监测栏只报数：绿点 + 数值 + 子代理按钮，不许再出现激励语/状态叙事", () => {
    // 反面证据：这两样一旦被搬回监测栏，观感就回到"用户在输入区读到系统闲话"。
    // 按片段取（起点→压缩条），避免被文件别处（如状态行 LiveStatusLine）的 pickCheer 误判。
    const from = chatPanelSrc.indexOf("{/* ─ A-1056② 实时监测栏");
    const to = chatPanelSrc.indexOf("{/* A-969：上下文自动压缩过渡动画");
    expect(from, "监测栏起点标记没找到").toBeGreaterThanOrEqual(0);
    expect(to, "压缩条标记没找到").toBeGreaterThan(from);
    const bar = chatPanelSrc.slice(from, to);
    expect(bar).not.toContain("pickCheer");
    expect(bar).not.toContain("shouldCheer");
    expect(bar).not.toContain("liveStatus");
    // 绿点（"在线/就绪"信号）必须保留 —— 用户点名"保留绿色运行点"
    expect(bar).toContain("var(--success)");
  });

  it("两句被点名的「说明书」永远不许再进激励语池", () => {
    // 池子现在住在 cheerPhrases.ts；输入框的 placeholder 合法地保留 Enter/粘贴提示（那是输入区该说的），
    // 但**激励语**里不许再出现 —— 这两句正是用户说"读起来像系统敷衍"的源头。
    expect(cheerPoolSrc.includes("输入消息… Enter 发送")).toBe(false);
    expect(cheerPoolSrc.includes("可粘贴 / 拖拽图片识图")).toBe(false);
    for (const p of CHEER_PHRASES) {
      expect(p.includes("输入消息")).toBe(false);
      expect(p.includes("拖拽")).toBe(false);
    }
  });

  it("状态行自持时钟：LiveStatusLine 是 React.memo，1s 计时器住在它自己里（不拖垮 5000 行的面板）", () => {
    expect(chatPanelSrc.includes("./cheerPhrases.js")).toBe(true);
    const from = chatPanelSrc.indexOf("const LiveStatusLine = React.memo(");
    expect(from, "LiveStatusLine 不是 React.memo 了").toBeGreaterThanOrEqual(0);
    // 组件体：从 memo 包装到「QueueAction」注释（下一个兄弟定义）之间
    const body = chatPanelSrc.slice(from, chatPanelSrc.indexOf("A-1056③：待发指令卡片右侧", from));
    expect(body).toContain("window.setInterval(() => setNow(Date.now()), 1000)");
    expect(body).toContain("shouldCheer(stageMs)");
    expect(body).toContain("pickCheer(Math.floor(stageMs / CHEER_ROTATE_MS))");
  });

  it("状态行真的挂在 Agent 输出最下方（只「定义了组件」不算接线 —— A-1054 W1 的教训）", () => {
    // 反面：把渲染条件改成 `{false && (` 时，"文件里有 LiveStatusLine" 依然为真，
    // 但功能已经从界面上消失。所以这里断言的是**渲染表达式**本身，而不是组件是否存在。
    expect(chatPanelSrc).toContain(
      "{liveStatus && <LiveStatusLine status={liveStatus} stageKey={liveStageKey} />}",
    );
  });
});

/**
 * A-1058② 守卫：待发指令卡片必须长在**输入框（圆角容器）之上**，不在它里面。
 *
 * 用户原话：「这个插入怎么在输入框内？我要的是在输入框上面的**监测框上面**」
 * —— 即整块输入区（监测栏 + 输入框）的上方，而不是嵌在 `<div className="glass-input">`
 * 那圈圆角边框**内部**（嵌进去会跟监测栏/输入框挤在同一个框里，看起来像"输入框的一部分"）。
 *
 * ⚠️ 这条同样是"改回去不报错、只在界面上翻车"：JSX 层级变了，tsc/构建/所有逻辑测试都绿。
 *    所以用**源码顺序**把它钉死：待发卡块的起点必须早于 `glass-input` 容器。
 */
describe("A-1058② 待发卡片位置：在输入圆角容器之上", () => {
  const queueAt = chatPanelSrc.indexOf("{/* ── A-1056③ 待发指令");
  const glassAt = chatPanelSrc.indexOf('<div className="glass-input"');

  it("两个锚点都在（锚点消失 = 这条守卫在空转，比红更危险）", () => {
    expect(queueAt, "找不到待发卡片块").toBeGreaterThanOrEqual(0);
    expect(glassAt, "找不到 glass-input 容器").toBeGreaterThanOrEqual(0);
  });

  it("待发卡片出现在 glass-input **之前**（= 输入区上方，而非容器内部）", () => {
    expect(queueAt).toBeLessThan(glassAt);
  });

  it("待发卡片的渲染仍在（顺序对了但块被删掉 = 另一种失败）", () => {
    const panel = chatPanelSrc.slice(queueAt, glassAt);
    expect(panel).toContain("{queueOfMine.length > 0 && (");
    expect(panel).toContain("queueOfMine.map(");
    expect(panel).toContain("<QueueAction");
  });

  it("监测栏仍在 glass-input **之内**（容器内 = 输入区；卡片只搬到容器外，不许把监测栏一起搬走）", () => {
    const barAt = chatPanelSrc.indexOf("{/* ─ A-1056② 实时监测栏");
    expect(barAt, "找不到监测栏").toBeGreaterThan(glassAt);
  });
});

/**
 * A-1058③ 守卫：图标 mask 的 `url()` **必须加引号**。 *
 * 用户实测（v0.0.7）：「按钮图标怎么渲染异常了？」——三个图标渲染成**实心方块**。
 *
 * 这不是"颜色不对"级别的观感问题，而是**声明被静默丢弃**：
 *   vite 的 svgToDataURL 把 `import "*.svg"` 编译成 URL-encoded data URI，且内部双引号
 *   被换成**单引号**（`data:image/svg+xml,%3c?xml%20version='1.0'…`）。
 *   CSS 规范里未加引号的 `<url-unquoted>` **禁止**出现单引号 → 整条 `mask-image`
 *   被解析器丢掉（computed = `none`）→ span 只剩 `background: tint` = 实心方块。
 *
 * Electron 35 探针实测（双向闭环）：
 *   未加引号 → computed `none`（等于完全不设 mask）；加引号 → 回显该 url（mask 生效）。
 *
 * ⚠️ 这条改回去**不报任何错**：类型检查过、构建过、`git diff` 看着只是少两个字符，
 *    只有用户眼里那三个方块会回来。所以必须由守卫钉死。
 */
describe("A-1058③ 图标 mask 的 url() 必须加引号", () => {
  /* 组件体切片：从 `function QueueAction(` 到**下一个兄弟定义**（UserMessage）。
     不用固定长度窗口 —— 注释一加长就会把断言挤出视野（本项目已踩过"窗口太窄"的坑）。 */
  const from = chatPanelSrc.indexOf("function QueueAction(");
  const to = chatPanelSrc.indexOf("const UserMessage = React.memo(");
  const body = chatPanelSrc.slice(from, to);

  it("切片两端都命中（锚点失效 = 守卫在空转，比红更危险）", () => {
    expect(from, "找不到 QueueAction").toBeGreaterThanOrEqual(0);
    expect(to, "找不到下一个兄弟定义").toBeGreaterThan(from);
  });

  it("QueueAction 的 mask-image 走加引号模板（未加引号 = 声明被丢弃 = 实心方块）", () => {
    expect(body).toContain('WebkitMaskImage: `url("${src}")`');
    expect(body).toContain('maskImage: `url("${src}")`');
    // 反面证据：裸 src 插值一旦回来，这次修复就被抹掉了
    expect(body.includes("`url(${src})`"), "mask 又变回未加引号了").toBe(false);
  });

  it("必须带 -webkit- 前缀（Electron 35 = Chromium 134，标准 mask-image 在某些路径仍要前缀）", () => {
    expect(body).toContain("WebkitMaskImage");
    expect(body).toContain("WebkitMaskRepeat");
    expect(body).toContain("WebkitMaskSize");
    expect(body).toContain("WebkitMaskPosition");
  });

  it("[反例] 断言必须真能抓到未加引号的写法（守卫自检）", () => {
    const quoted = 'maskImage: `url("${src}")`,';
    const unquoted = "maskImage: `url(${src})`,";
    expect(quoted.includes('`url(${src})`')).toBe(false);
    expect(unquoted.includes('`url(${src})`')).toBe(true);
  });
});
