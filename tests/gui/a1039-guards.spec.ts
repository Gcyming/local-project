



















import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const APP = "gui/src/renderer/App.tsx";

describe("A-1039 ① 启动门判据：首屏数据到齐才算就绪", () => {
  it("门判据只看「首屏数据齐 + 最短展示时间」，与 boot.phase 解耦", () => {
    const src = code(APP);
    
    expect(src).not.toContain('boot?.phase === "ready" && !uiReady');
    expect(src).toContain("const splashVisible = !splashMinDone || !uiReady;");
  });

  it("🐛 回归红线：`degraded` 绝不能成为「放行」的理由", () => {
    
    const src = code(APP);
    const m = /const splashVisible = ([^;]+);/.exec(src);
    expect(m, "找不到 splashVisible 判据").not.toBeNull();
    expect(m![1]).not.toMatch(/phase/);
  });

  it("uiReady 由登记表 + 总超时兜底共同决定（缺一项就不能收门）", () => {
    const src = code(APP);
    




    expect(src).toContain("const uiReadyDecision = decideUiReady({");
    expect(src).toContain("const uiReady = uiReadyDecision.ready;");
    expect(src).not.toContain("const uiReady = firstLoadGuard || FIRST_LOAD_KEYS.every((k) => firstLoad[k]);");
    
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"agents"/);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"sessions"/);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"providers"/);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"localModels"/);
    
    expect(src).toContain("const METADATA_LOAD_KEYS = [\"agents\", \"sessions\", \"providers\", \"localModels\"] as const;");
    expect(src).toContain('const CONTENT_LOAD_KEY = "chatHistory";');
  });

  it("四个数据源的**加载点**都真的调了 markFirstLoad（函数写了不调用 = 白写）", () => {
    const src = code(APP);
    for (const k of ["agents", "sessions", "providers", "localModels"]) {
      expect(src.includes(`markFirstLoad("${k}")`), `缺少 markFirstLoad("${k}") 调用`).toBe(true);
    }
  });

  it("🐛 异步数据源必须**成功与失败两条路径都登记**（只登记成功路径 = 失败时靠 8s 兜底干等）", () => {
    
    
    
    const src = code(APP);
    for (const k of ["providers", "localModels"]) {
      const n = (src.match(new RegExp(`markFirstLoad\\("${k}"\\)`, "g")) ?? []).length;
      expect(n, `${k} 的 markFirstLoad 只出现 ${n} 次，成功/失败两条路径未都覆盖`).toBeGreaterThanOrEqual(2);
    }
  });

  it("失败也必须放行：每个数据源的 catch 里都要 markFirstLoad（否则门变成新的卡死源）", () => {
    const src = code(APP);
    
    const catches = src.match(/\.catch\([^)]*\)\s*=>\s*\{[^}]*markFirstLoad[^}]*\}/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(2);
  });

  it("必须有总超时兜底，且阈值是有限的（8s）", () => {
    const src = code(APP);
    expect(src).toContain("setFirstLoadGuard(true), 8000");
  });

  it("[反例] 上面几条正则/包含断言必须真的能抓到坏写法（守卫自检）", () => {
    
    expect(/phase/.test('boot?.phase === "degraded" ? "x" : "y"')).toBe(true);
    
    const badCatch = ".catch(console.error);";
    expect(/\.catch\([^)]*\)\s*=>\s*\{[^}]*markFirstLoad[^}]*\}/.test(badCatch)).toBe(false);
  });

  it("已废弃的 bootStallGuard 不得复活（它与新门冲突：会提前放行）", () => {
    const src = code(APP);
    expect(src).not.toContain("bootStallGuard");
    expect(src).not.toContain("setBootStallGuard");
  });
});

describe("A-1039 ② 加载面板：内容如实、可优雅退场、主题跟随", () => {
  const SPLASH = "gui/src/renderer/pages/SplashScreen.tsx";

  it("面板组件独立成文件（可单测、可优雅退场）", () => {
    expect(existsSync(join(ROOT, SPLASH))).toBe(true);
  });

  it("App 用组件渲染，而不是内联裸 JSX 的硬切（条件一变组件立刻消失）", () => {
    const src = code(APP);
    expect(src).toContain("<SplashScreen");
    expect(src).toContain('from "./pages/SplashScreen.js"');
    
    
    
    const inApp = src.match(/slime-boot-slide/g) ?? [];
    expect(inApp.length).toBe(1);
    const splash = code("gui/src/renderer/pages/SplashScreen.tsx");
    expect(splash).toContain("slime-boot-slide");
  });

  it("退场走淡出过渡（先降透明度、再等过渡结束才卸载）", () => {
    const s = code(SPLASH);
    expect(s).toContain("transition: \"opacity 240ms ease\"");
    
    expect(s).toContain("setMounted(false), 260");
  });

  it("给出了「在等什么」——阶段清单，而不是只有一个转圈", () => {
    const s = code(SPLASH);
    expect(s).toContain("steps");
    expect(s).toContain("s.done");
  });

  it("阶段清单来自 App 的真实门内状态（不得写死为已完成）", () => {
    const src = code(APP);
    expect(src).toContain("const splashSteps: SplashStep[] = [");
    
    expect(src).toContain("firstLoad.agents && firstLoad.sessions");
    expect(src).toContain("firstLoad.providers && firstLoad.localModels");
  });

  it("主题跟随：颜色一律走 CSS 变量，不写死深色/浅色", () => {
    const s = code(SPLASH);
    expect(s).not.toMatch(/background:\s*"#0[0-9a-f]{5}"/i);   
    expect(s).toMatch(/var\(--bg\)/);
    expect(s).toMatch(/var\(--accent\)/);
  });

  it("面板必须真的被 App 渲染出来（接线守卫）", () => {
    const src = code(APP);
    expect(src).toContain("visible={splashVisible}");
    expect(src).toContain("status={splashStatus}");
  });
});











describe("A-1058① 启动门覆盖中间栏的会话内容", () => {
  const CHAT = "gui/src/renderer/pages/ChatPanel.tsx";

  it("门内登记表新增 chatHistory（少这一项 = 门又提前放行）", () => {
    const src = code(APP);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"chatHistory"/);
  });

  it("阶段清单如实报出「会话内容」，而不是只说列表类数据", () => {
    const src = code(APP);
    expect(src).toContain("firstLoad.chatHistory");
  });

  it("ChatPanel 的会话恢复**成功与失败两条路径都回执**（失败不回执 = 只能靠 8s 兜底干等）", () => {
    const src = code(CHAT);
    expect(src).toContain("onHistoryLoaded?: () => void;");
    
    
    const n = (src.match(/reportHistoryLoaded\(\);/g) ?? []).length;
    expect(n, `reportHistoryLoaded 只出现 ${n} 次，success/catch 未都覆盖`).toBeGreaterThanOrEqual(2);
    
    expect(src).toMatch(/settleAfterFrames\(HISTORY_SETTLE_FRAMES,\s*\(\)\s*=>\s*onHistoryLoaded\?\.\(\)\)/);
  });

  it("🐛 App 必须真的把它接到 ChatPanel 上（props 写了不传 = 门永远收不齐）", () => {
    const src = code(APP);
    expect(src).toContain("onHistoryLoaded={markChatHistoryLoaded}");
  });

  it("🐛 传给 ChatPanel 的回调必须是**稳定引用**（内联箭头 + 写进 effect 依赖 = 反复重拉历史）", () => {
    const src = code(APP);
    
    expect(src).toMatch(/const markChatHistoryLoaded = React\.useCallback\(/);
    expect(src).not.toMatch(/onHistoryLoaded=\{\(\)\s*=>/);
  });

  





  it("🐛 没有会话内容可等时由 startupGate 判据收尾，且装配层真的在用它", () => {
    const app = code(APP);
    
    expect(app).toContain("decideHistoryGate({");
    expect(app).toMatch(/if \(decision === "self-finish"\) \{ markChatHistoryLoaded\(\); \}/);
    
    expect(app).not.toContain("if (hasNoSession || !selectedAgentId) { markChatHistoryLoaded(); }");
    
    const gate = code("gui/src/renderer/pages/startupGate.ts");
    expect(gate).toContain("export function decideHistoryGate");
    expect(gate).toContain("if (!input.selectionSettled) { return \"wait\"; }");
  });

  it("[反例] 上面几条正则/包含断言必须真的能抓到坏写法（守卫自检）", () => {
    expect(/FIRST_LOAD_KEYS = \[[^\]]*"chatHistory"/.test('const FIRST_LOAD_KEYS = ["agents"] as const;')).toBe(false);
    expect(/onHistoryLoaded=\{\(\)\s*=>/.test("onHistoryLoaded={() => markFirstLoad(\"chatHistory\")}")).toBe(true);
  });
});

describe("A-1039 ③ 版本号通道（副标题数据来源）", () => {
  it("主进程提供 slime:app:version，用 app.getVersion() 作为权威值", () => {
    const src = code("gui/src/main/index.ts");
    expect(src).toContain('ipcMain.handle("slime:app:version"');
    expect(src).toMatch(/ipcMain\.handle\("slime:app:version",[^;]*app\.getVersion\(\)/);
  });

  it("preload 暴露 boot.version，且类型声明同步（跨进程契约两侧都要有）", () => {
    const p = code("gui/src/preload/index.ts");
    expect(p).toContain('ipcRenderer.invoke("slime:app:version")');
    expect(p).toContain("version: () => Promise<string>;");
  });

  it("渲染层拿不到版本号时不崩（可选链 + catch）", () => {
    const src = code(APP);
    expect(src).toMatch(/api\?\.boot\?\.version\?\.\(\)/);
  });
});
