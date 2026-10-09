















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
  /* 2026-10-07 A-1197：silam 自研模型质量未达标（乱码 + 硬截断）已下线留占位，
   * 于是「无模型路由时的兜底」由 fallbackNotice(假借 SILAM 大脑应答) 换成 noModelRouteText(如实提示)。
   * ⇒ 守卫的**本意一字未改**：无路由时给出的文案必须说清原因、如实标明这不是模型回答，
   * 且 chat / stream 两条入口都必须接上（原守卫用 >=2 兜底，本轮收紧成**精确 2**，不许漏也不许多）。
   * 检查对象随之由 fallbackNotice 更新为 noModelRouteText；旧函数已整段删除，
   * 下面额外钉死它不得复活（有定义就等于「还能兜底」的错觉，且它本身是死代码）。 */
  it("noModelRouteText 有定义，且定义处恰好 1 处", () => {
    expect(src, "无路由兜底报因的方法必须存在（它就是「兜底必须报因」的载体）")
      .toContain("private noModelRouteText(agent: AgentState, error: string | null): string {");
    expect(
      src.split("private noModelRouteText(").length - 1,
      "noModelRouteText 的定义必须恰好 1 处（复制两份文案 = 两个真相源，改一处就漏一处）",
    ).toBe(1);
  });

  it("chat / stream 两条兜底路径各自恰好调用一次（精确 2，漏一处就有一个入口静默兜底）", () => {
    const calls = src.split("this.noModelRouteText(opts.agent, error)").length - 1;
    expect(calls, "兜底报因必须在 chat() 与 stream() 都接上（漏一处就有一个入口静默兜底）").toBe(2);

    // 两条路径必须**分别**被锚到自己的返回形状上：只数出现次数的话，
    // 同一个函数被同一个分支调两次也能凑够 2 —— 那等于 stream 入口仍然静默。
    const chatBlock = src.match(
      /const reply = this\.noModelRouteText\(opts\.agent, error\);\n      return \{[\s\S]*?\n      \};/,
    );
    expect(chatBlock, "chat() 的 !router 分支没有接上 noModelRouteText（或返回形状变了，锚点失效）").not.toBeNull();
    expect(chatBlock![0], "chat() 兜底必须如实标 model=\"none\"，不许再冒充 silam-brain").toMatch(
      /(?<![A-Za-z0-9_-])model\s*:\s*"none"/,
    );

    const streamBlock = src.match(
      /const reply = this\.noModelRouteText\(opts\.agent, error\);\n      yield \{ type: "done"[\s\S]*?return;/,
    );
    expect(streamBlock, "stream() 的 !router 分支没有接上 noModelRouteText（或 done 形状变了，锚点失效）").not.toBeNull();
    expect(streamBlock![0], "stream() 兜底必须如实标 model=\"none\"，不许再冒充 silam-brain").toMatch(
      /(?<![A-Za-z0-9_-])model\s*:\s*"none"/,
    );
    // stream 侧不得再凭空造一个 reasoning 帧去转述「由 SILAM 兜底」
    expect(streamBlock![0], "stream 兜底不许再凭空造 reasoning 帧（旧实现靠它转述 SILAM 兜底）")
      .not.toContain('type: "reasoning"');
  });

  it("兜底文案必须报因：说清「没有可用模型」+ 如实声明不是模型回答 + 指出去哪里配", () => {
    const m = src.match(/private noModelRouteText\([\s\S]*?\n  \}/);
    expect(m, "取不到 noModelRouteText 的方法体（锚点失效）").not.toBeNull();
    const text = m![0];
    expect(text, "兜底文案必须如实声明「这句话不是模型回答」").toContain("不是模型回答");
    expect(text, "兜底文案必须说清原因是「没有可用模型」").toMatch(/没有可用模型/);
    // 「报因」的关键：必须把上游查到的 error 真的插进文案，而不是丢掉
    expect(text, "兜底文案必须把 resolveRouteInternal 给出的 error 插进去（丢掉就等于没报因）")
      .toContain("${error");
    expect(text, "兜底文案必须给出去哪里配的下一步（否则用户只知道自己坏了，不知道怎么修）")
      .toMatch(/供应商[\s\S]*本地模型/);
  });

  it("旧兜底 fallbackNotice 不得复活（它假借 SILAM 大脑应答，正是本轮下线的那条路）", () => {
    expect(src, "fallbackNotice 已被整段删除；留着它等于留着一个没人调的私有方法 + 「还能兜底」的错觉")
      .not.toContain("fallbackNotice");
    expect(src, "无路由兜底不得再冒出兜底应答/保底应答这类宣称（实测是乱码，用户已拍板下线）")
      .not.toMatch(/兜底应答|保底应答/);
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
