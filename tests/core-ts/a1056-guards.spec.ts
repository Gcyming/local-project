










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
    
    expect(shouldCheer(Number.NaN)).toBe(false);
    expect(shouldCheer(Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldCheer(-1)).toBe(false);
  });

  it("pickCheer：任意 seed（含负数/小数/超大）都落在合法下标，且同 seed 稳定", () => {
    const n = CHEER_PHRASES.length;
    for (const seed of [-1234, -1, 0, 1, 3, 17, 999, 1e9, 3.9, -0.2]) {
      const got = pickCheer(seed);
      expect(CHEER_PHRASES).toContain(got);
      
      expect(pickCheer(seed)).toBe(got);
    }
    expect(pickCheer(Number.NaN)).toBe(CHEER_PHRASES[0]);
    
    expect(pickCheer(0)).not.toBe(pickCheer(1 % n === 0 ? 2 : 1));
  });
});

describe("A-1056② 激励语文案纪律", () => {
  it("已扩充（用户要求「扩充活泼阳光的」）：至少 12 句", () => {
    expect(CHEER_PHRASES.length).toBeGreaterThanOrEqual(12);
  });

  it("每句都带表情包（emoji / 颜文字），不是纯文字", () => {
    
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
    
    
    const from = chatPanelSrc.indexOf("{/* ─ A-1056② 实时监测栏");
    const to = chatPanelSrc.indexOf("{/* A-969：上下文自动压缩过渡动画");
    expect(from, "监测栏起点标记没找到").toBeGreaterThanOrEqual(0);
    expect(to, "压缩条标记没找到").toBeGreaterThan(from);
    const bar = chatPanelSrc.slice(from, to);
    expect(bar).not.toContain("pickCheer");
    expect(bar).not.toContain("shouldCheer");
    expect(bar).not.toContain("liveStatus");
    
    expect(bar).toContain("var(--success)");
  });

  it("两句被点名的「说明书」永远不许再进激励语池", () => {
    
    
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
    
    const body = chatPanelSrc.slice(from, chatPanelSrc.indexOf("A-1056③：待发指令卡片右侧", from));
    expect(body).toContain("window.setInterval(() => setNow(Date.now()), 1000)");
    expect(body).toContain("shouldCheer(stageMs)");
    expect(body).toContain("pickCheer(Math.floor(stageMs / CHEER_ROTATE_MS))");
  });

  it("状态行真的挂在 Agent 输出最下方（只「定义了组件」不算接线 —— A-1054 W1 的教训）", () => {
    
    
    expect(chatPanelSrc).toContain(
      "{liveStatus && <LiveStatusLine status={liveStatus} stageKey={liveStageKey} />}",
    );
  });
});











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

















describe("A-1058③ 图标 mask 的 url() 必须加引号", () => {
  

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
