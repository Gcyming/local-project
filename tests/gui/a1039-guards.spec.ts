/**
 * A-1039 守卫：启动门（加载动画何时可以停）+ 加载面板构成。
 *
 * **用户实测（v0.0.4 打包版）**：「v0.0.4 下载后使用起来很卡，点击按钮、滚动、跳转、
 * 折叠展开都响应非常慢，卡成 PPT」——**重启一次又好了**。
 *
 * 这个"重启自愈"是关键判据：它排除稳态代码缺陷（那种重启也好不了），指向**首启冷态**
 * 与**二次启动命中缓存**的差异。而"加载动画停了但界面还没就绪"是同一根因的另一面 ——
 * 用户原话：「在程序彻底加载完成前，加载动画就别停了」。
 *
 * 归因（三条证据闭环，全部可复现）：
 *   ① `watchdog.log` **不存在** → 主进程事件循环从未被独占 >2s（不是主进程卡）；
 *   ② `GPUCache/data_1` 在运行期间持续写入 → GPU 硬件加速正常（不是软渲染）；
 *   ③ 旧门判据 `boot?.phase === "ready" && !uiReady` 里**没有 `degraded`**，
 *      而 `degraded` 是后端缺失/超时的必经状态 → 门在那条路径上**当场放行**。
 * 于是首屏只等了「会话列表」一项，provider / 本地模型 / 定价 / 探针快照都还在冷加载，
 * 用户点开界面撞上的就是这些未就绪的重活。
 *
 * 本文件把这些结构性事实钉死 —— 它们改回去都**不报错**，只在真机上表现为"很卡"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 去注释后的源码：避免"注释里提到旧写法"导致误判 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const APP = "gui/src/renderer/App.tsx";

describe("A-1039 ① 启动门判据：首屏数据到齐才算就绪", () => {
  it("门判据只看「首屏数据齐 + 最短展示时间」，与 boot.phase 解耦", () => {
    const src = code(APP);
    // 旧的坏判据：degraded 不匹配任何分支 → 放行。必须已消失。
    expect(src).not.toContain('boot?.phase === "ready" && !uiReady');
    expect(src).toContain("const splashVisible = !splashMinDone || !uiReady;");
  });

  it("🐛 回归红线：`degraded` 绝不能成为「放行」的理由", () => {
    // 这条是本次卡顿的直接成因。若有人把 phase 条件加回门里，这条必须变红。
    const src = code(APP);
    const m = /const splashVisible = ([^;]+);/.exec(src);
    expect(m, "找不到 splashVisible 判据").not.toBeNull();
    expect(m![1]).not.toMatch(/phase/);
  });

  it("uiReady 由登记表 + 总超时兜底共同决定（缺一项就不能收门）", () => {
    const src = code(APP);
    /* A-1061 迁移：判据从内联的 `firstLoadGuard || 全部到齐` 搬进纯模块
       `startupGate.decideUiReady`（因为那个 `||` 会让元数据组的 8s 兜底**绕过内容组**，
       导致"加载界面在会话内容没就绪时就结束"）。意图不变 —— 仍是"缺一项不收门"，
       只是现在**分组**：元数据 8s 兜底、内容 20s 兜底，且谁被兜底放行会打日志。
       判据本体的真值表见 a1059-guards.spec.ts。 */
    expect(src).toContain("const uiReadyDecision = decideUiReady({");
    expect(src).toContain("const uiReady = uiReadyDecision.ready;");
    expect(src).not.toContain("const uiReady = firstLoadGuard || FIRST_LOAD_KEYS.every((k) => firstLoad[k]);");
    // 登记表必须覆盖"首屏就要用、且拉取不快"的四个数据源
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"agents"/);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"sessions"/);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"providers"/);
    expect(src).toMatch(/FIRST_LOAD_KEYS = \[[^\]]*"localModels"/);
    // 分组常量与内容组兜底必须存在（否则内容组又会被元数据组的兜底顺带绕过）
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
    // providers / localModels 走 `.then(...).catch(...)`：只标成功路径的话，请求一旦失败
    // 登记表就永远收不齐 → 门只能等 8s 总超时。用户看到的就是"明明加载完了还在转圈"。
    // 所以这里要求**出现两次**，而不是"出现过"。
    const src = code(APP);
    for (const k of ["providers", "localModels"]) {
      const n = (src.match(new RegExp(`markFirstLoad\\("${k}"\\)`, "g")) ?? []).length;
      expect(n, `${k} 的 markFirstLoad 只出现 ${n} 次，成功/失败两条路径未都覆盖`).toBeGreaterThanOrEqual(2);
    }
  });

  it("失败也必须放行：每个数据源的 catch 里都要 markFirstLoad（否则门变成新的卡死源）", () => {
    const src = code(APP);
    // providers / localModels 的 catch 分支
    const catches = src.match(/\.catch\([^)]*\)\s*=>\s*\{[^}]*markFirstLoad[^}]*\}/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(2);
  });

  it("必须有总超时兜底，且阈值是有限的（8s）", () => {
    const src = code(APP);
    expect(src).toContain("setFirstLoadGuard(true), 8000");
  });

  it("[反例] 上面几条正则/包含断言必须真的能抓到坏写法（守卫自检）", () => {
    // 坏写法 1：phase 回到门判据里
    expect(/phase/.test('boot?.phase === "degraded" ? "x" : "y"')).toBe(true);
    // 坏写法 2：只等 sessions（旧行为）
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
    // ⚠️ 关键帧 `slime-boot-slide` 是被**复用**的：App 内还剩 **1 处**，属于「本地模型加载弹窗」
    //    （它不在启动门上，不需要淡出）。启动面板那份必须已经搬进 SplashScreen。
    //    用"计数"而不是"禁用字符串" —— 否则守卫会连合法复用一起锁死。
    const inApp = src.match(/slime-boot-slide/g) ?? [];
    expect(inApp.length).toBe(1);
    const splash = code("gui/src/renderer/pages/SplashScreen.tsx");
    expect(splash).toContain("slime-boot-slide");
  });

  it("退场走淡出过渡（先降透明度、再等过渡结束才卸载）", () => {
    const s = code(SPLASH);
    expect(s).toContain("transition: \"opacity 240ms ease\"");
    // 必须有"延时卸载"这一步，否则淡出还没跑完组件就没了
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
    // 每一项都要绑定到真实数据源
    expect(src).toContain("firstLoad.agents && firstLoad.sessions");
    expect(src).toContain("firstLoad.providers && firstLoad.localModels");
  });

  it("主题跟随：颜色一律走 CSS 变量，不写死深色/浅色", () => {
    const s = code(SPLASH);
    expect(s).not.toMatch(/background:\s*"#0[0-9a-f]{5}"/i);   // 不写死深色背景
    expect(s).toMatch(/var\(--bg\)/);
    expect(s).toMatch(/var\(--accent\)/);
  });

  it("面板必须真的被 App 渲染出来（接线守卫）", () => {
    const src = code(APP);
    expect(src).toContain("visible={splashVisible}");
    expect(src).toContain("status={splashStatus}");
  });
});

/**
 * A-1058① 守卫：「中间那栏的会话内容」也必须在启动门内。
 *
 * 用户实测（v0.0.7 dev 版）：「这个中间的界面加载要一段时间，我说话你是听不见吗？
 * 给我算在加载界面里面」——与 A-1039 是同一条线的下一步：A-1039 把"列表类"数据源
 * 收进门槛，但**中间那栏自己的内容**（`conversations.load` 的历史消息）还在门外。
 * 门放行后 ChatPanel 才挂载，历史到达前中间显示的是空态 —— 看着已就绪，实则没接上。
 *
 * ⚠️ 这些结构改回去都**不报错**，只在真机上表现为"对着新界面说话没人应"。
 */
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
    // A-1059② 迁移：回执不再是裸 `onHistoryLoaded?.()`，改为经 reportHistoryLoaded()
    //（它保证"DOM 提交后再发"，见 startupGate.ts）——判据跟着搬到新家，意图不变。
    const n = (src.match(/reportHistoryLoaded\(\);/g) ?? []).length;
    expect(n, `reportHistoryLoaded 只出现 ${n} 次，success/catch 未都覆盖`).toBeGreaterThanOrEqual(2);
    // 且它必须真的通过 settleAfterFrames 包一层（裸调用 = 又回到"门比内容先到"）
    expect(src).toMatch(/settleAfterFrames\(HISTORY_SETTLE_FRAMES,\s*\(\)\s*=>\s*onHistoryLoaded\?\.\(\)\)/);
  });

  it("🐛 App 必须真的把它接到 ChatPanel 上（props 写了不传 = 门永远收不齐）", () => {
    const src = code(APP);
    expect(src).toContain("onHistoryLoaded={markChatHistoryLoaded}");
  });

  it("🐛 传给 ChatPanel 的回调必须是**稳定引用**（内联箭头 + 写进 effect 依赖 = 反复重拉历史）", () => {
    const src = code(APP);
    // 只能是 useCallback 产物；不许出现 `onHistoryLoaded={() => ...}` 这种每次渲染换身份的写法
    expect(src).toMatch(/const markChatHistoryLoaded = React\.useCallback\(/);
    expect(src).not.toMatch(/onHistoryLoaded=\{\(\)\s*=>/);
  });

  /**
   * A-1059② 迁移：这条原先锁的是 App.tsx 里**内联**的两句自我收尾判断。
   * 判据已搬到纯模块 `startupGate.ts`（因为内联写法把「还没决定选哪个会话」与
   * 「已决定但拿不到 agentId」并成了一支，导致门提前放行）——
   * 按项目铁律：**迁移**（意图搬到判据新家 + 补接线守卫），不是删掉。
   */
  it("🐛 没有会话内容可等时由 startupGate 判据收尾，且装配层真的在用它", () => {
    const app = code(APP);
    // ① 接线：App 必须调用纯模块判据，而不是自己重新内联一套
    expect(app).toContain("decideHistoryGate({");
    expect(app).toMatch(/if \(decision === "self-finish"\) \{ markChatHistoryLoaded\(\); \}/);
    // ② 旧的内联写法必须绝迹（它正是"提前放行"的成因）
    expect(app).not.toContain("if (hasNoSession || !selectedAgentId) { markChatHistoryLoaded(); }");
    // ③ 判据本体在纯模块里（可单测/过变异）；五条顺序见 a1059-guards.spec.ts
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
