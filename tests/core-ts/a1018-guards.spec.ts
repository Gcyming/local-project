















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const APP_TSX = join(ROOT, "gui/src/renderer/App.tsx");
const INDEX_CSS = join(ROOT, "gui/src/renderer/index.css");
const MODEL_SERVER = join(ROOT, "core-ts/src/model_server.ts");
const ENGINE = join(ROOT, "core-ts/src/services/engine.ts");

const read = (p: string): string => readFileSync(p, "utf8");

function num(src: string, re: RegExp, label: string): number {
  const m = re.exec(src);
  expect(m, `取不到 ${label}（正则 ${re} 未命中 → 守卫自己失效了）`).toBeTruthy();
  return Number(m![1]);
}

describe("A-1018 ①：窗口最小宽度 ≥ 三栏硬下限之和", () => {
  const mainSrc = read(MAIN_INDEX);
  const appSrc = read(APP_TSX);
  const cssSrc = read(INDEX_CSS);

  it("三栏下限与窗口最小宽度满足不变量", () => {
    const winMinW = num(mainSrc, /const WIN_MIN = \{ width: (\d+), height: \d+ \}/, "WIN_MIN.width");
    const sidebarMin = num(appSrc, /const SIDEBAR_MIN_W = (\d+)/, "SIDEBAR_MIN_W");
    const chatMin = num(appSrc, /const CHAT_MIN_W = (\d+)/, "CHAT_MIN_W");
    
    const rsBlock = /\.right-sidebar \{[^}]*min-width:\s*(\d+)px/.exec(cssSrc);
    expect(rsBlock, "取不到 .right-sidebar 的 min-width").toBeTruthy();
    const rightMin = Number(rsBlock![1]);

    const need = sidebarMin + chatMin + rightMin;
    expect(
      winMinW,
      `窗口最小宽度 ${winMinW} < 三栏下限之和 ${need}（${sidebarMin}+${chatMin}+${rightMin}）：`
        + "窗口能缩到比布局还窄 → 右栏被裁、其展开/折叠按钮被裁出视野、聊天内容溢出屏外。",
    ).toBeGreaterThanOrEqual(need);
  });
});

describe("A-1018 ②：两侧栏默认宽度走 CSS 比例 + clamp（未拖拽时不下发内联 px）", () => {
  const cssSrc = read(INDEX_CSS);
  const appSrc = read(APP_TSX);

  it("CSS 默认宽度是 clamp(min, %, max)", () => {
    expect(cssSrc).toMatch(/--sidebar-w:\s*clamp\(/);
    expect(cssSrc).toMatch(/--right-sidebar-w:\s*clamp\(/);
  });

  it("未手动拖过 → 不下发内联宽度（否则比例自适应被盖掉）", () => {
    expect(appSrc).toContain("width: sidebarCustom ? sidebarWidth : undefined");
    expect(appSrc).toContain("width={rightCustom ? rightWidth : undefined}");
    
    expect(appSrc.split("setSidebarCustom(true)").length - 1).toBeGreaterThanOrEqual(1);
    expect(appSrc.split("setRightCustom(true)").length - 1).toBeGreaterThanOrEqual(1);
  });
});

describe("A-1018 ③④：本地模型启动参数与子进程输出", () => {
  const src = read(MODEL_SERVER);

  it("--reasoning-format 只允许 llama-server 认可的取值", () => {
    
    const pushes = [...src.matchAll(/argv\.push\("--reasoning-format",\s*([^)]*)\)/g)].map((m) => m[1].trim());
    expect(pushes.length, "找不到 --reasoning-format 的 argv.push（守卫自己失效了）").toBeGreaterThan(0);
    for (const v of pushes) {
      
      const values = v.split(/[:?]/).map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s && !/^(modelName|BASENAME)/.test(s));
      for (const one of values) {
        expect(
          ["none", "deepseek", "deepseek-legacy", "auto"],
          `--reasoning-format 的取值「${one}」不是 llama-server 认可的（none/deepseek/deepseek-legacy/auto）。`
            + "传非法值 → 进程 exit 1 → 本地模型永远起不来，且只报「启动超时 60s」。",
        ).toContain(one);
      }
    }
  });

  it("后台子进程不许 stdio:\"ignore\"（否则对方说什么都听不到）", () => {
    expect(src).not.toMatch(/stdio:\s*"ignore",\s*\n?\s*windowsHide/);
    expect(src).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(src).toContain("get output(): string");
  });
});

describe("A-1018 ⑤：兜底必须报因（数量守恒）", () => {
  const src = read(ENGINE);
  it("fallbackNotice 有定义，且在 chat / stream 两条兜底路径都被调用", () => {
    expect(src).toContain("private fallbackNotice(agent: AgentState, error: string | null): string");
    const calls = src.split("this.fallbackNotice(opts.agent, error)").length - 1;
    expect(calls, "兜底报因必须在 chat() 与 stream() 都接上（漏一处就有一个入口静默兜底）").toBeGreaterThanOrEqual(2);
  });
});

describe("A-1018 ⑧：工具名/图标只有一个来源 · 广告拦截真的接上了", () => {
  const chatSrc = read(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"));
  const rsSrc = read(join(ROOT, "gui/src/renderer/pages/RightSidebar.tsx"));
  const mainSrc = read(MAIN_INDEX);
  const adSrc = read(join(ROOT, "gui/src/main/adblock.ts"));

  it("工具映射是导出的唯一实现，活动记录复用它（不再裸拼工具名）", () => {
    expect(chatSrc).toContain("export const TOOL_LABELS");
    expect(chatSrc).toContain("export function resolveToolLabel");
    expect(rsSrc).toContain("resolveToolLabel");
    
    expect(rsSrc).not.toContain("⟳ 调用工具 ${name}");
    
    expect(rsSrc).toContain("tool?: string");
    expect(rsSrc).toContain("pushEvent(\"tool\", label, name)");
  });

  it("广告拦截装在 webview 分区上，且监听器只注册一次（Electron 只保留最后一个）", () => {
    expect(mainSrc).toContain('installAdBlocker(session.fromPartition("persist:slime-browser"), PROJECT_ROOT)');
    expect(adSrc).toContain("let installed = false;");
    expect(adSrc).toContain("if (installed) { return; }");
    expect(adSrc).toContain("onBeforeRequest");
    
    expect(adSrc).toContain("readAdblockSettings");
    expect(adSrc).toContain("if (!settings.enabled)");
  });
});
describe("A-1018 ⑦：文件改动行数徽标（+N/-N）只有一份实现，两处都接上", () => {
  const cssSrc = read(INDEX_CSS);
  const chatSrc = read(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"));

  it("DiffStatBadge 是唯一实现，且产物卡 / 工具卡都在用（数量守恒）", () => {
    expect(chatSrc).toContain("function DiffStatBadge({ add, del }: { add: number; del: number }): JSX.Element");
    const uses = chatSrc.split("<DiffStatBadge ").length - 1;
    expect(uses, "产物卡与思考历程的工具卡都要用同一份实现（各写一套颜色/字重迟早漂移）").toBeGreaterThanOrEqual(2);
    
    expect(chatSrc).not.toContain("+{p.diff.add}");
  });

  it("颜色走主题变量 + 数字变化会重放动画（动态感），且尊重减弱动效", () => {
    expect(cssSrc).toMatch(/\.diff-stat-add \{ color: var\(--diff-add/);
    expect(cssSrc).toMatch(/\.diff-stat-del \{ color: var\(--diff-del/);
    expect(cssSrc).toContain("@keyframes slime-diff-stat-pop");
    expect(cssSrc).toMatch(/prefers-reduced-motion[\s\S]{0,120}\.diff-stat-add/);
    
    expect(chatSrc).toContain("key={`a${add}`}");
    expect(chatSrc).toContain("key={`d${del}`}");
  });
});
describe("A-1018 ⑥：工具卡的徽标对齐 + 点击只展开", () => {
  const cssSrc = read(INDEX_CSS);
  const chatSrc = read(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"));

  it("detail 吃掉剩余宽度、状态徽标定宽 + 内容真居中（否则徽标位置随 detail 长短漂 / 文字贴边）", () => {
    
    
    expect(cssSrc).toMatch(/\.think-tool-detail \{[^}]*flex:\s*1 1 auto/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*min-width:\s*3\.6em/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*flex-shrink:\s*0/);
    
    
    
    
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*display:\s*inline-flex/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*align-items:\s*center/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*justify-content:\s*center/);
    
    
    
    expect(cssSrc).not.toMatch(/\.think-tool-status \{[^}]*text-align:\s*(right|left)/);
    expect(cssSrc).not.toMatch(/\.think-tool-status \{[^}]*\bheight:\s*\d/);
    expect(cssSrc).not.toMatch(/\.think-tool-status \{[^}]*line-height:/);
  });

  it("整行点击 = 展开/收起；展开箭头必须 stopPropagation（否则一次点击被切换两次）", () => {
    expect(chatSrc).toContain("if (hasBody) { setExpanded(!expanded); }");
    expect(chatSrc).toContain('onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}');
    
    
    const btnAt = chatSrc.indexOf('className="think-tool-btn"');
    expect(btnAt).toBeGreaterThan(-1);
    const headerWindow = chatSrc.slice(btnAt, btnAt + 1600);
    expect(headerWindow).not.toContain("requestSidebarOpen");
  });
});
