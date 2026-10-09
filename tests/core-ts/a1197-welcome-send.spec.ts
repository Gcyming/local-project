/**
 * tests/core-ts/a1197-welcome-send.spec.ts — A-1197 ①「初始欢迎页点了没反应」的验收基线
 *
 * 用户原话：
 *   「初始界面没用 —— 下面快捷按钮没用，上面输入栏也没用，点了没反应，
 *     输入回车没反应 —— 这是老毛病了」
 *
 * 根因（两条叠加，都在 gui/src/renderer/App.tsx）：
 *   ① **全链路静默返回**：handleWelcomeSend 在「api 缺失 / create 抛错 / 主进程返回
 *      {ok:false}」三处都是裸 `return;`（或 catch 里 return null），任何失败用户
 *      都看不到 —— 点了按钮 / 按了回车，界面上什么都没有。
 *   ② **会话创建成功了但界面没反映**：旧代码 `setSelectedSessionId` 后只 `void
 *      loadSessions()`，而 `selectedSession = sessions.find(...)` 要等 loadSessions
 *      （主进程全量 list + loadHistory(null,100000) 聚合）回来才非空，期间渲染分支
 *      仍判 `hasNoSession` → 继续挂 WelcomeChat，「点了以后界面毫无变化」。
 *
 * 修复：
 *   ① 三条失败路径全部 `throw`（由 WelcomeChat.handleSend 的 catch 接成可见 notice，
 *      沿用 GeneralPanel.showNotice 的局部 state + 内联 div 惯例，不新造 toast）；
 *   ② create 返回的 `res.session` 是完整 SessionItem，乐观 `setSessions` 插进去，
 *      让 selectedSession 立刻非空、ChatPanel 立刻挂载并订阅流（不丢首包）。
 *
 * ⚠️ 全部走**源码形状断言**（读文本 + 正则），不 import App.tsx（它顶层会拉起
 *    整个渲染依赖图，vitest 的 node 环境里不可行）。本仓同类守卫一贯如此
 *    （见 a1024-guards / a1194-abort-retry / a1197-data-root）。
 *
 * 每条断言锚住的是**我真正修的那条不变量**：
 *   · I1 三条失败路径必须出声（throw / 可见），不许退回静默 `return;`
 *   · I2 会话创建成功必须立即反映到界面（乐观 setSessions），不许只靠 loadSessions
 *   · I3 WelcomeChat.handleSend 必须把 onSend 的 reject 接成可见 notice
 *   · I4 notice 必须在 WelcomeChat 渲染层真的画出来（否则 I3 接了也没人看见）
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** 从 `decl`（函数声明原文）起，按括号配对抠出函数体。 */
function bodyOf(srcText: string, decl: string): string {
  const at = srcText.indexOf(decl);
  expect(at, `${decl.slice(0, 40)}… 必须存在`).toBeGreaterThan(-1);
  const open = srcText.indexOf("{", at);
  expect(open, "函数体左花括号缺失").toBeGreaterThan(at);
  let depth = 0;
  for (let i = open; i < srcText.length; i += 1) {
    if (srcText[i] === "{") { depth += 1; }
    else if (srcText[i] === "}") {
      depth -= 1;
      if (depth === 0) { return srcText.slice(open, i + 1); }
    }
  }
  throw new Error(`decl 的函数体括号不配对：${decl.slice(0, 40)}`);
}

const APP = readText("gui/src/renderer/App.tsx");
/* 抠出 handleWelcomeSend 函数体（锚在声明原文，唯一） */
const welcome = bodyOf(
  APP,
  "const handleWelcomeSend = React.useCallback(async (text: string): Promise<void> => {",
);
/* 抠出 WelcomeChat 里的 handleSend（函数声明，唯一） */
const welcomeSend = bodyOf(
  APP,
  "async function handleSend(text: string): Promise<void> {",
);

describe("A-1197① I1：handleWelcomeSend 三条失败路径必须出声（不许静默 return）", () => {
  it("api 缺失 → 必须 throw（旧写法是 `if (!api || !text.trim()) { return; }` 静默返回）", () => {
    // 边界写严：`!api` 后面紧跟的是 `{ throw`，M1 把它改回 `return;` 即红。
    expect(welcome).toMatch(/if\s*\(\s*!api\s*\)\s*\{\s*throw\s+new\s+Error\(/);
  });

  it("create 抛错 → catch 里必须 throw（旧写法 catch 里 return null + 上面裸 return）", () => {
    expect(welcome).toContain('throw new Error("会话创建失败，请稍后重试")');
  });

  it("主进程返回 {ok:false} / 缺 session → 必须 throw（旧写法是裸 `return;`）", () => {
    expect(welcome).toContain('throw new Error("会话创建未成功，请稍后重试")');
  });

  it("不变量锚点：`if (!res?.ok || !res.session)` 这个分支体里**不许**再出现裸 `return;`", () => {
    // 词边界写严（负向前瞻 + 白名单）：分支体里只允许 throw/console，不允许 return。
    // M3 把 throw 改回 `return;` 时这里立刻红。
    const m = /if\s*\(\s*!\s*res\?\.ok\s*\|\|\s*!\s*res\.session\s*\)\s*\{([\s\S]*?)\};?/.exec(welcome);
    expect(m, "找不到 `if (!res?.ok || !res.session) {` 分支").not.toBeNull();
    const body = m![1];
    expect(body, "该分支体里不允许出现 `return;`（静默返回 = 用户点了没反应）")
      .not.toMatch(/\breturn\s*;/);
  });
});

describe("A-1197① I2：会话创建成功必须立即反映到界面（乐观 setSessions）", () => {
  it("create 成功后必须乐观把 res.session 插进 sessions（不等 loadSessions 回来）", () => {
    // 这是根因②的修复锚点：M4 删掉这行 → 界面又「点了没反应」。
    expect(welcome).toContain(
      "setSessions((prev) => (prev.some((s) => s.sessionId === sessionId) ? prev : [res.session, ...prev]))",
    );
  });

  it("乐观插入之后仍要 setSelectedSessionId + loadSessions（三件事都齐，缺一 = 反映不全）", () => {
    const setIdx = welcome.indexOf("setSelectedSessionId(sessionId);");
    const lsIdx = welcome.indexOf("void loadSessions();");
    const optIdx = welcome.indexOf("[res.session, ...prev]");
    expect(setIdx).toBeGreaterThan(-1);
    expect(lsIdx).toBeGreaterThan(-1);
    expect(optIdx).toBeGreaterThan(-1);
    // 乐观插入必须先于（或至少与）setSelectedSessionId 出现，才能让 selectedSession 立刻非空
    expect(optIdx).toBeLessThan(setIdx);
  });
});

describe("A-1197① I3：WelcomeChat.handleSend 必须把 onSend 的 reject 接成可见 notice", () => {
  it("handleSend 的 catch 必须调 showNotice（旧写法只有 finally，reject 被调用方 `void` 吞掉）", () => {
    expect(welcomeSend).toMatch(/showNotice\(false,\s*e\s+instanceof\s+Error/);
  });

  it("showNotice 必须走 alive 守卫（组件卸载后不许再 setState）", () => {
    const showDef = APP.indexOf("const showNotice = React.useCallback((ok: boolean, text: string): void => {");
    expect(showDef).toBeGreaterThan(-1);
    const showBody = bodyOf(APP, "const showNotice = React.useCallback((ok: boolean, text: string): void => {");
    expect(showBody).toMatch(/aliveRef\.current/);
  });
});

describe("A-1197① I4：notice 必须在 WelcomeChat 渲染层真的画出来", () => {
  it("渲染树里存在 `{notice && (` 的内联 div（沿用 GeneralPanel 的 notice 惯例）", () => {
    // 词边界写严：`{false && (` 这种被 M6 改坏的形态必须判红 —— 用负向前瞻排除 false。
    expect(APP).toMatch(/\{\s*notice\s*&&\s*\(/);
    expect(APP).not.toMatch(/\{\s*false\s*&&\s*\(\s*[\s\S]{0,80}notice/);
  });

  it("notice div 必须用既有 CSS 变量（--danger-soft / --success-soft），不许新造一套配色", () => {
    const at = APP.indexOf("{notice && (");
    expect(at).toBeGreaterThan(-1);
    const seg = APP.slice(at, at + 400);
    expect(seg).toContain("--danger-soft");
    expect(seg).toContain("--success-soft");
  });
});
