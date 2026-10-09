

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const PANEL = "gui/src/renderer/pages/AgentsPanel.tsx";
const SHELL = "gui/src/renderer/pages/SettingsDialog.tsx";
const OPFOCUS = "gui/src/renderer/pages/operationFocus.ts";

/**
 * A-1197 补片面：未保存改动的离开确认覆盖面 —— 关掉设置弹窗 + 在设置里切页。
 *
 * 上一轮只覆盖了「面板内切 Agent」。剩下两条离开路径的手势都发生在 `SettingsDialog`
 * （遮罩 / 关闭按钮 / Esc / 侧栏点页 / PluginsPanel 的 onNavigate / 搜索框派生页），
 * 而未保存的数据（`detail` 快照）在 AgentsPanel 里 —— 于是「谁来判脏」是本轮的核心问题。
 *
 * 这些断言是**形状断言**（读源码文本 + 正则），不是运行时行为测试 ——
 * 要守住的是「判据只有一份、且两条路径都真的接上了」，而 React 交互在 node 下跑不起来。
 *
 * ⚠️ 三条写码纪律（前两轮各栽过一次）：
 *  1. **词边界写严**：凡匹配「调用点」一律带 `(?<![\w$])` / `(?![\w$])`。
 *     本轮要匹配的 `requestLeave` 在两个文件里都有（面板内切 Agent / 闸门方法），
 *     所以**绝不能**只按名字数出现次数 —— 必须先把函数体切出来再看。
 *  2. **先剥注释**再判「有没有第二产地」：否则我们自己写的说明性注释
 *     （提到 localStorage / unsavedSnapshot / 第二份判据）会造成假命中。
 *  3. 断言的是**结构**（「判据只有一份」「每条路径都过闸门」），
 *     不是逐字匹配整个函数体 —— 逐字匹配会让任何一次无害的重排都变成假红。
 */

/** 正则元字符转义 —— 不转义时 `gate.requestLeave({...})` 里的 `(...)` 会被当捕获组，模式永不匹配。 */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在 src 里数「词边界严格」的匹配次数。 */
function countWord(src: string, word: string): number {
  const re = new RegExp(`(?<![\\w$])${escRe(word)}(?![\\w$])`, "g");
  return (src.match(re) ?? []).length;
}

/** 去掉块注释与行注释 —— 判「有没有第二产地」时**必须**先剥。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 切出一个具名函数/箭头函数的**函数体**（花括号配平 + 跳过字符串与注释）。
 *
 *  为什么不用一条正则：`SettingsDialog.leaveViaGate` 里有嵌套的 `if` 块与模板字面量，
 *  `[\s\S]*?\n  \}` 这类"偷懒到下一个缩进闭合"的写法会在**第一个**内层 `}` 处截断，
 *  于是断言在"半个函数"上判定 —— 这种守卫一半绿一半红，谁也说不清它在守什么。
 *  本函数是真配平，所以拿到的 body 一定是完整的那个函数。 */
function funcBody(src: string, header: RegExp): string {
  const m = header.exec(src);
  expect(m, `没找到函数头：${String(header)}`).not.toBeNull();
  const start = src.indexOf("{", m!.index + m![0].length - 1);
  expect(start, "函数头后没有 `{`").toBeGreaterThan(-1);
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) { quote = null; }
      i += 1;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") { quote = c; i += 1; continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "{") { depth += 1; }
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) { return src.slice(start + 1, i); }
    }
    i += 1;
  }
  throw new Error("函数体没有闭合");
}

describe("A-1197：判据只有一份 —— 外壳不自己判脏（否则两份判据必然漂移）", () => {
  it("外壳持有的是面板注册上来的闸门，不持有 detail / 快照", () => {
    const src = stripComments(readText(SHELL));
    // 外壳拿的是「闸门」这一个 ref…
    expect(src).toMatch(/const\s+shellGateRef\s*=\s*React\.useRef<AgentLeaveGate\s*\|\s*null>\(null\)/);
    // …并把它转交给面板注册（不是自己 new 一个）
    expect(src).toMatch(/const\s+registerLeaveGate\s*=\s*React\.useCallback\(\(gate:\s*AgentLeaveGate\s*\|\s*null\)\s*:\s*void\s*=>\s*\{/);
    const reg = funcBody(src, /const\s+registerLeaveGate\s*=\s*React\.useCallback\(\(gate:\s*AgentLeaveGate\s*\|\s*null\)\s*:\s*void\s*=>/);
    expect(reg).toMatch(/shellGateRef\.current\s*=\s*gate;/);
    // ⚠️ 第二产地判据：外壳里出现快照比对 / 判脏函数 = 复制了一份字段清单
    expect(src).not.toMatch(/unsavedSnapshot/);
    expect(src).not.toMatch(/savedRef/);
    expect(src).not.toMatch(/(?<!\w)detail(?![\w$])/);
    // ⚠️ 外壳只允许**一个** ref（闸门本身）。再出现第二个 ref 就是它在自建状态 ——
    //    而自建状态要么与面板那份漂移，要么漏一次同步 ⇒ 静默失守。
    expect(countWord(src, "React.useRef")).toBe(1);
  });

  it("外壳只能通过闸门问判脏，不能自建判脏谓词", () => {
    const src = stripComments(readText(SHELL));
    /* 把「闸门成员访问」（`.isDirty(`）与「闸门字段定义」（`isDirty:`）摘掉之后，
     * 剩下的任何 `isDirty` 都是**外壳自己写的判脏谓词**（第二份判据）。
     * ⚠️ 只查"有没有 isDirty"是不够的：外壳必须**用**闸门问判脏，
     *    所以真正要守的是"每一次出现都必须是闸门访问"。 */
    const residue = src.replace(/\.isDirty\(/g, "").replace(/isDirty:/g, "");
    expect(residue).not.toMatch(/(?<![\w$])isDirty(?![\w$])/);
    // 同理：闸门方法只能以成员访问形式出现
    const residue2 = src.replace(/\.isConfirming\(/g, "").replace(/\.requestLeave\(/g, "");
    expect(residue2).not.toMatch(/(?<![\w$])(isConfirming|requestLeave)(?![\w$])/);
  });

  it("面板通过 onRegisterLeaveGate 把闸门交出去，且卸载时注销", () => {
    const panel = readText(PANEL);
    const shell = readText(SHELL);
    // 外壳把它接到面板的注册 prop 上
    expect(shell).toMatch(/onRegisterLeaveGate=\{registerLeaveGate\}/);
    // 面板 prop 形状：可传 null（注销）
    expect(panel).toMatch(/onRegisterLeaveGate\?:\s*\(gate:\s*AgentLeaveGate\s*\|\s*null\)\s*=>\s*void/);
    // 注册 effect：挂载注册 + 清理注销，两者都在同一个 effect 里
    const src = stripComments(panel);
    expect(src).toMatch(/const\s+register\s*=\s*props\.onRegisterLeaveGate;\s*if\s*\(!register\)\s*\{\s*return;\s*\}\s*register\(shellGateRef\.current\);/);
    expect(src).toMatch(/return\s*\(\)\s*=>\s*\{\s*register\(null\);\s*\}\s*;/);
  });

  it("闸门实现活读面板闭包（不是注册那一刻的快照）", () => {
    const panel = readText(PANEL);
    // 每次渲染重建闸门对象 ⇒ 闭包里的 detail / hintHidden / pendingLeave 永不过期
    expect(panel).toMatch(/shellGateRef\.current\s*=\s*\{\s*isDirty:\s*\(\)\s*=>\s*isDirtyNow\(\)/);
    expect(panel).toMatch(/isConfirming:\s*\(\)\s*=>\s*pendingLeave\s*!==\s*null/);
    // ⚠️ 重建闸门的 effect **不能带依赖数组** —— 带了就只在首次渲染跑，
    //    闭包永远停在挂载那一刻（detail 还是 null）⇒ 外壳永远判"不脏"⇒ 静默放行。
    const refresh = /React\.useEffect\(\(\)\s*=>\s*\{\s*shellGateRef\.current\s*=\s*\{[\s\S]*?\};\s*\}\s*\);/.exec(panel);
    expect(refresh).not.toBeNull();
    expect(refresh![0]).not.toMatch(/\}\s*,?\s*\[[^\]]*\]\s*\)\s*;/);
  });
});

describe("A-1197：(A) 关闭整个设置弹窗 —— 遮罩 / 关闭按钮 / Esc 三条路都过闸门", () => {
  it("requestClose 把真正的关闭动作交给闸门，不是直接 onClose", () => {
    const src = readText(SHELL);
    const body = funcBody(src, /function\s+requestClose\(\):\s*void\s*\{/);
    // 直接调 props.onClose() = 没闸门
    expect(body).not.toMatch(/^\s*props\.onClose\(\);\s*$/m);
    expect(body).toMatch(/leaveViaGate\(/);
    // props.onClose 只作为**闸门放行后**的动作出现
    expect(body).toMatch(/props\.onClose\(\)/);
  });

  it("三个手势分别接到 requestClose（没有一条绕过闸门）", () => {
    const src = stripComments(readText(SHELL));
    // 遮罩
    expect(src).toMatch(/onClick=\{\(e\)\s*=>\s*\{\s*if\s*\(e\.target\s*===\s*e\.currentTarget\)\s*\{\s*requestClose\(\);/);
    // 关闭按钮
    expect(src).toMatch(/title="关闭设置"\s+onClick=\{requestClose\}/);
    // Esc（window 级；卡片级 onKeyDown 收不到，因为焦点可能在搜索框上）
    const key = /window\.addEventListener\("keydown",\s*onKey\)/.exec(src);
    expect(key).not.toBeNull();
    const keyBody = funcBody(src, /const\s+onKey\s*=\s*\(e:\s*KeyboardEvent\)\s*:\s*void\s*=>/);
    expect(keyBody).toMatch(/if\s*\(e\.key\s*!==\s*"Escape"\)\s*\{\s*return;\s*\}/);
    expect(keyBody).toMatch(/requestClose\(\)/);
    // 卸载时必须摘掉监听（否则重开设置后一次 Esc 关两次）
    expect(src).toMatch(/return\s*\(\)\s*=>\s*\{\s*window\.removeEventListener\("keydown",\s*onKey\);\s*\}/);
  });

  it("leaveViaGate 是唯一的收口：闸门缺席 / 已勾「以后不再」才直接放行", () => {
    const src = readText(SHELL);
    const body = funcBody(src, /function\s+leaveViaGate\(label:\s*string,\s*run:\s*\(\)\s*=>\s*void\):\s*void\s*\{/);
    // 闸门不在（面板已卸载 ⇒ 没有可丢的改动）⇒ 放行
    expect(body).toMatch(/if\s*\(!gate\)\s*\{\s*run\(\);\s*return;\s*\}/);
    // ⚠️ 已挂着确认弹窗 ⇒ 让位（否则会在用户还没回答"要不要放弃"时先关掉整个弹窗）
    expect(body).toMatch(/if\s*\(gate\.isConfirming\(\)\)\s*\{\s*return;\s*\}/);
    // 其余情况一律交给面板弹窗
    expect(body).toMatch(/gate\.requestLeave\(\{\s*label,\s*run\s*\}\)/);
    // ⚠️ 外壳不许自己判脏：不能出现任何本地 isDirty 比较
    expect(body).not.toMatch(/isDirtyNow/);
    expect(body).not.toMatch(/hintHidden/);
    /* ⚠️⚠️ 收口判据（这条是 M6「整体绕过闸门」的唯一拦阻）：
     *   `run()` **只能**出现在 `if (!gate)` 那一处。早退式的
     *   `run(); return;`（先执行再问闸门）会让整个离开请求失效，
     *   而"函数体里还有 requestLeave 字样"这类弱断言照样绿 —— 实测 M6 就这样活了下来。
     *   数的是**执行点**而不是"提到过"：早退写法里 requestLeave 仍在源码中，但永不执行。 */
    const runs = [...body.matchAll(/(?<![\w$.])run\(\)(?![\w$])/g)];
    expect(runs.length).toBe(1);
    const gateBranch = /if\s*\(!gate\)\s*\{\s*run\(\);\s*return;\s*\}/.exec(body);
    expect(gateBranch).not.toBeNull();
    expect(gateBranch!.index).toBeLessThan(runs[0].index!);
  });
});

describe("A-1197：(B) 在设置弹窗内切到别的设置页 —— 过同一道闸门", () => {
  it("requestTab 把 setTab 交给闸门", () => {
    const src = readText(SHELL);
    const body = funcBody(src, /function\s+requestTab\(next:\s*SettingsTab,\s*clearQuery\s*=\s*false\):\s*void\s*\{/);
    expect(body).toMatch(/leaveViaGate\(/);
    // setTab 只在**放行动作**里出现（闭包内），不能是函数体第一句
    expect(body.trim().startsWith("leaveViaGate(")).toBe(true);
    expect(body).toMatch(/setTab\(next\)/);
    // 文案要说明白"离开去干什么"，不能只丢一个英文 id
    // （2026-10-08 B2：`sectionLabel` 升级为 `labelOf` —— 能认得扩展动态页 `ui:<plugin>:<id>`）
    expect(body).toMatch(/labelOf\(next\)/);
  });

  it("两条真实的切页入口都走 requestTab（侧栏 + PluginsPanel 的 onNavigate）", () => {
    const src = stripComments(readText(SHELL));
    // 侧栏每一项
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*requestTab\(s\.id\)\}/);
    // 扩展页内部的跳转（它自己会 setQuery("")，所以走 clearQuery 分支）
    expect(src).toMatch(/onNavigate=\{\(t\)\s*=>\s*\{\s*requestTab\(t,\s*true\);\s*\}\}/);
    // ⚠️ 第二产地：还有别的地方直接 setTab 吗（query 派生那条走 activeTab，见下一条）
    const direct = /onClick=\{\(\)\s*=>\s*setTab\(/.exec(src);
    expect(direct).toBeNull();
  });

  it("搜索框把 Agent 页顶掉也算离开 ⇒ 有未保存改动时把本页钉住", () => {
    const src = stripComments(readText(SHELL));
    // activeTab 是从 query 派生的：敲一个字就能让 AgentsPanel 卸载 ⇒ 未保存改动消失
    expect(src).toMatch(/const\s+pinnedByUnsaved\s*=\s*tab\s*===\s*"agents"\s*&&\s*shellGateRef\.current\?\.isDirty\(\)\s*===\s*true;/);
    // 钉住时 activeTab 必须是 agents（不再派生）
    expect(src).toMatch(/const\s+activeTab\s*=\s*pinnedByUnsaved\s*\?\s*"agents"/);
    /* 2026-10-08（用户实测）：「左侧没必要加这个提示，只要有个弹窗就够了」⇒ 常驻提示块**移除**；
       钉住行为保留（上面两条），离开时的拦截由**弹窗**兜底（见「弹窗复用面板内那一个」一组）。
       这里反向断言，防止提示块"悄悄复活"。 */
    expect(src).not.toMatch(/\{pinnedByUnsaved\s*&&\s*\(/);
    expect(src).not.toContain("已暂时固定在本页");
  });
});

describe("A-1197：弹窗复用面板内那一个（外壳不另起一套）", () => {
  it("外壳请求的离开挂进同一个 pendingLeave（kind: shell）", () => {
    const panel = readText(PANEL);
    const body = funcBody(panel, /function\s+requestShellLeave\(target:\s*AgentShellLeave\):\s*void\s*\{/);
    // ⚠️ 放行条件必须与面板内切 Agent 那条**逐字一致**（同一对 isDirtyNow / hintHidden）
    //    —— 不一致就意味着「勾了以后不再，关闭弹窗时还在弹」这种半关闭状态。
    expect(body).toMatch(/if\s*\(!isDirtyNow\(\)\s*\|\|\s*hintHidden\)\s*\{\s*commitShellLeave\(target\);\s*return;\s*\}/);
    expect(body).toMatch(/setPendingLeave\(\{\s*kind:\s*"shell",\s*label:\s*target\.label,\s*run:\s*target\.run\s*\}\)/);
  });

  it("「放弃改动并离开」这一个按钮覆盖两类离开（不会卡死在弹窗态）", () => {
    const panel = readText(PANEL);
    const dispatch = funcBody(panel, /function\s+commitPendingLeave\(next:\s*PendingLeave\):\s*void\s*\{/);
    expect(dispatch).toMatch(/if\s*\(next\.kind\s*===\s*"select"\)\s*\{[^}]*commitLeave\(/);
    expect(dispatch).toMatch(/commitShellLeave\(/);
    // 按钮接的是这个分派器，不是某一类的专属执行器
    expect(panel).toMatch(/className="btn danger"\s+onClick=\{\(\)\s*=>\s*\{\s*commitPendingLeave\(pendingLeave\);\s*\}\}/);
  });

  it("弹窗文案随离开类型变化（说清是关弹窗还是切页）", () => {
    const panel = readText(PANEL);
    expect(panel).toMatch(/pendingLeave\.kind\s*===\s*"shell"\s*\?\s*<>[\s\S]*?\{pendingLeave\.label\}[\s\S]*?<\/>\s*:\s*null/);
  });

  it("PendingLeave 两种 kind 都在类型里声明（新增 kind 必须同步改类型）", () => {
    const panel = readText(PANEL);
    // 末尾是 `void };` ⇒ 只能按 `};` 收尾（按第一个 `;` 收会切在 union 的成员里）
    const m = /type\s+PendingLeave\s*=([\s\S]*?)\};/.exec(panel);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/kind:\s*"select"/);
    expect(body).toMatch(/kind:\s*"shell"/);
    expect(body).toMatch(/run:\s*\(\)\s*=>\s*void/);
  });
});

describe("A-1197：「以后不再」复用既有键位与写读函数（不新增第二产地）", () => {
  it("外壳不碰 hintHidden 的存储（那是面板的事）", () => {
    const src = stripComments(readText(SHELL));
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/UNSAVED_HINT_KEY/);
    expect(src).not.toMatch(/(?<![\w$])(readUnsavedHintHidden|writeUnsavedHintHidden)(?![\w$])/);
  });

  it("键位与读写函数仍是上一轮那一份（不许扩键、不许改名）", () => {
    const src = readText(OPFOCUS);
    expect(src).toMatch(/export const UNSAVED_HINT_KEY = "slime\.unsavedChanges\.hintHidden";/);
    expect(src).toMatch(/export function readUnsavedHintHidden\(\): boolean/);
    expect(src).toMatch(/export function writeUnsavedHintHidden\(hidden:\s*boolean\): void/);
    // ⚠️ 只允许这两个（+ 原本那把）⇒ 出现第三个 hint 键位就是第二产地
    const keys = [...stripComments(src).matchAll(/export const \w*HINT\w*KEY = "([^"]+)"/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["slime.opFocus.hintHidden", "slime.unsavedChanges.hintHidden"]);
  });
});

describe("A-1197：基线重置仍只在保存成功后（外壳改动不许把闸门放歪）", () => {
  it("markSavedFromServer 的调用点没变（回填 + res.ok 成功分支）", () => {
    const panel = readText(PANEL);
    // 服务端回填（两处：then 与 catch）仍是重置基线的地方
    expect(panel).toMatch(/markSavedFromServer\(next\)/);
    expect(panel).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*setDetail\(null\);\s*markSavedFromServer\(null\);\s*\}\)/);
    // 保存成功才重置
    const save = funcBody(panel, /async\s+function\s+saveDetail\(\)\s*:\s*Promise<void>\s*\{/);
    expect(save).toMatch(/if\s*\(res\.ok\)\s*\{[\s\S]*?(?<![\w$])markSavedFromServer\(detail\)/);
    // 失败分支绝不能重置
    const fail = /else\s*\{\s*showNotice\(false,\s*"保存失败"\);[\s\S]*?\n      \}/.exec(save);
    expect(fail).not.toBeNull();
    expect(fail![0]).not.toMatch(/(?<![\w$])markSavedFromServer/);
  });

  it("commitShellLeave 走之前先清挂起态（放行后弹窗不会二次弹出）", () => {
    const panel = readText(PANEL);
    const body = funcBody(panel, /function\s+commitShellLeave\(target:\s*AgentShellLeave\):\s*void\s*\{/);
    const clear = body.indexOf("setPendingLeave(null)");
    const run = body.indexOf("target.run()");
    expect(clear).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(run);
  });
});

describe("A-1197：回归 —— 上一轮那套判脏/闸门没被本轮改坏", () => {
  it("判脏基线 ref 与 isDirtyNow 仍在，且仍读同一个快照函数", () => {
    const panel = readText(PANEL);
    expect(panel).toMatch(/const\s+savedRef\s*=\s*React\.useRef<string>\(""\)/);
    const body = funcBody(panel, /function\s+isDirtyNow\(\)\s*:\s*boolean\s*\{/);
    /* 2026-10-08：判脏加「真编辑过」门槛（editedRef）后，**快照比较仍是判据的一部分** ——
       不能只剩 editedRef（否则"改过又改回原样"也会拦），两个条件都必须在这条 return 里。 */
    expect(body).toMatch(/unsavedSnapshot\(detail\)\s*!==\s*savedRef\.current/);
    expect(body).toMatch(/editedRef\.current/);
  });

  it("unsavedSnapshot 的字段清单没被本轮改动（仍是那五个可写回字段）", () => {
    const panel = readText(PANEL);
    const body = funcBody(panel, /function\s+unsavedSnapshot\(d:\s*AgentDetail\s*\|\s*null\):\s*string\s*\{/);
    for (const f of ["role", "mode", "show_thinking", "tool_profile", "subagent_dispatch"]) {
      expect(body).toMatch(new RegExp(`(?<![\\w$])${f}(?![\\w$])`));
    }
    // 只读展示字段仍不进快照
    expect(body).not.toMatch(/(?<![\w$])name(?![\w$])\s*:/);
    // 排序后比较仍在
    expect(body).toMatch(/\[\.\.\.tp\.skills\]\.sort\(\)/);
    expect(body).toMatch(/\[\.\.\.tp\.mcp\]\.sort\(\)/);
  });

  it("面板内切 Agent 仍走原来的 requestLeave（没有被本轮的 shell 通道吞掉）", () => {
    const panel = readText(PANEL);
    const body = funcBody(panel, /const\s+selectAgent\s*=\s*\(id:\s*string\)\s*:\s*void\s*=>/);
    expect(body).toMatch(/requestLeave\(\{\s*kind:\s*"select",\s*agentId:\s*id\s*\}\)/);
    expect(body).not.toMatch(/(?<![\w$])setLocalId\(id\)/);
    // 面板内那条闸门的放行条件也没被改
    const gate = funcBody(panel, /function\s+requestLeave\(next:\s*\{\s*kind:\s*"select"/);
    expect(gate).toMatch(/if\s*\(!isDirtyNow\(\)\s*\|\|\s*hintHidden\)\s*\{\s*commitLeave\(next\);\s*return;\s*\}/);
  });

  it("本轮没有把 AgentsPanel 的保存出口改掉（仍是唯一写回路径）", () => {
    const panel = readText(PANEL);
    const save = funcBody(panel, /async\s+function\s+saveDetail\(\)\s*:\s*Promise<void>\s*\{/);
    expect(save).toMatch(/api\.current\.agents\.update\(detail\.id,\s*patch\)/);
    // 面板里仍然只有这一处写回。
    // ⚠️ 这里**不能**用 countWord：它两侧都带 `(?<![\\w$])` / `(?![\\w$])`，而锚点以 `(` 结尾、
    // 后面紧跟的是 `detail` 的 `d`（词字符）⇒ 右边界必然失配 ⇒ 恒为 0 ⇒ 守卫静默失效。
    // 前缀形态只需要**左**边界（右边界由 `update(` 的括号本身保证了）；
    // 左边界不能含 `.` —— `agents.update(` 的前一个字符正是 `current.` 的那个点。
    const writes = [...panel.matchAll(/(?<![\w$])agents\.update\(/g)].length;
    expect(writes).toBe(1);
  });
});
