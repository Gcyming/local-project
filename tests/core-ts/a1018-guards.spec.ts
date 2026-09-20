/**
 * tests/core-ts/a1018-guards.spec.ts — A-1018 的**结构/不变量守卫**。
 *
 * 这一轮修的都是"改回去不报错、测试也不红"的静默类问题，所以只能钉结构。
 * 每一条都能通过变异测试验红（改坏被锁的结构 → 红）。
 *
 *  ① **窗口最小宽度必须 ≥ 三栏硬下限之和**（左 240 + 聊 380 + 右 260 = 880）。
 *     小于它 → 右栏 wrapper 被压缩、内层 min-width 顶着不让 → 右栏超出并被裁掉，
 *     **右上角的展开/折叠按钮正好被裁到视野外**（用户实测症状）。
 *  ② **两侧栏默认宽度必须是"比例 + clamp"**（纯 CSS 自适应），且未拖拽时不许下发内联 px
 *     （内联 px 会把比例自适应整个盖掉，退回"窗口变了布局不变"）。
 *  ③ **`--reasoning-format` 只能传 llama-server 认可的取值**（none/deepseek/deepseek-legacy/auto）。
 *     写 `qwen` 会让进程当场 exit 1 → 本地模型永远起不来（只报"启动超时 60s"）。
 *  ④ **后台子进程不许 `stdio:"ignore"`**：丢掉的是唯一的归因线索。
 *  ⑤ **兜底分支必须报因**：`fallbackNotice` 在 chat 与 stream 两条路径都要出现（数量守恒）。
 */
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
    // 右栏下限取 CSS（权威处）：.right-sidebar 块里的 min-width
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
    // 拖拽是唯一的"自定义"来源：两个拖拽处理函数里各要置一次标志
    expect(appSrc.split("setSidebarCustom(true)").length - 1).toBeGreaterThanOrEqual(1);
    expect(appSrc.split("setRightCustom(true)").length - 1).toBeGreaterThanOrEqual(1);
  });
});

describe("A-1018 ③④：本地模型启动参数与子进程输出", () => {
  const src = read(MODEL_SERVER);

  it("--reasoning-format 只允许 llama-server 认可的取值", () => {
    // 抓出 --reasoning-format 这一项实际传的值（本文件只应有一处 push）
    const pushes = [...src.matchAll(/argv\.push\("--reasoning-format",\s*([^)]*)\)/g)].map((m) => m[1].trim());
    expect(pushes.length, "找不到 --reasoning-format 的 argv.push（守卫自己失效了）").toBeGreaterThan(0);
    for (const v of pushes) {
      // 允许字面量或三元（三元两侧都必须是合法值）
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
    // 旧的裸工具名标签必须已消失（否则同一件事两处各说各话）
    expect(rsSrc).not.toContain("⟳ 调用工具 ${name}");
    // 事件要带原始工具名，行首才能渲染该工具自己的图标
    expect(rsSrc).toContain("tool?: string");
    expect(rsSrc).toContain("pushEvent(\"tool\", label, name)");
  });

  it("广告拦截装在 webview 分区上，且监听器只注册一次（Electron 只保留最后一个）", () => {
    expect(mainSrc).toContain('installAdBlocker(session.fromPartition("persist:slime-browser"), PROJECT_ROOT)');
    expect(adSrc).toContain("let installed = false;");
    expect(adSrc).toContain("if (installed) { return; }");
    expect(adSrc).toContain("onBeforeRequest");
    // 开关必须有读取者：设置文件真的被读，并在关闭时不安装
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
    // 旧的"内联 +{p.diff.add}"实现必须已删除，否则就是两份实现
    expect(chatSrc).not.toContain("+{p.diff.add}");
  });

  it("颜色走主题变量 + 数字变化会重放动画（动态感），且尊重减弱动效", () => {
    expect(cssSrc).toMatch(/\.diff-stat-add \{ color: var\(--diff-add/);
    expect(cssSrc).toMatch(/\.diff-stat-del \{ color: var\(--diff-del/);
    expect(cssSrc).toContain("@keyframes slime-diff-stat-pop");
    expect(cssSrc).toMatch(/prefers-reduced-motion[\s\S]{0,120}\.diff-stat-add/);
    // 动画挂内层数字（靠 key 重挂载触发），不是挂壳
    expect(chatSrc).toContain("key={`a${add}`}");
    expect(chatSrc).toContain("key={`d${del}`}");
  });
});
describe("A-1018 ⑥：工具卡的徽标对齐 + 点击只展开", () => {
  const cssSrc = read(INDEX_CSS);
  const chatSrc = read(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"));

  it("detail 吃掉剩余宽度、状态徽标定宽 + 内容真居中（否则徽标位置随 detail 长短漂 / 文字贴边）", () => {
    // 机制就是这几条：detail flex:1 1 auto（把后面两项顶到行尾）+ status 定宽且不收缩
    // → 徽标位置不随 detail 长短漂。
    expect(cssSrc).toMatch(/\.think-tool-detail \{[^}]*flex:\s*1 1 auto/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*min-width:\s*3\.6em/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*flex-shrink:\s*0/);
    // ⚠️ A-1021 修正：**居中要靠 flex，不是 `text-align`**。
    // 旧断言锁的是 `text-align: right` —— 那是"贴右边缘"，不是居中（用户原话"这个字不在
    // 文本框正中心啊"）。原断言把这个错误锁死了，所以这轮**必须同轮改断言**
    // （陈旧守卫比没有守卫更糟：它会把病灶当规范保护起来）。
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*display:\s*inline-flex/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*align-items:\s*center/);
    expect(cssSrc).toMatch(/\.think-tool-status \{[^}]*justify-content:\s*center/);
    // 回归闸门：① `text-align`（left/right）是错的方向；② 不许再靠固定 height/line-height
    // 去"凑"居中 —— `.think-tool-btn` 没声明 line-height，钉死高度会把胶囊拔高（尺寸变更
    // 是用户没要求的；已实测自然高度 ≈13px，height:18px 会 +5px）。
    expect(cssSrc).not.toMatch(/\.think-tool-status \{[^}]*text-align:\s*(right|left)/);
    expect(cssSrc).not.toMatch(/\.think-tool-status \{[^}]*\bheight:\s*\d/);
    expect(cssSrc).not.toMatch(/\.think-tool-status \{[^}]*line-height:/);
  });

  it("整行点击 = 展开/收起；展开箭头必须 stopPropagation（否则一次点击被切换两次）", () => {
    expect(chatSrc).toContain("if (hasBody) { setExpanded(!expanded); }");
    expect(chatSrc).toContain('onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}');
    // 卡片点击不许直接跳右侧栏（跳转必须走 detail 上的链接，onClickDetail 自带 stopPropagation）。
    // 取卡片头部 JSX 的一段窗口来断言：窗口内不应出现 requestSidebarOpen 字面量。
    const btnAt = chatSrc.indexOf('className="think-tool-btn"');
    expect(btnAt).toBeGreaterThan(-1);
    const headerWindow = chatSrc.slice(btnAt, btnAt + 1600);
    expect(headerWindow).not.toContain("requestSidebarOpen");
  });
});
