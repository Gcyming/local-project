import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const AGENTS = "gui/src/renderer/pages/AgentsPanel.tsx";
const OPFOCUS = "gui/src/renderer/pages/operationFocus.ts";

/**
 * A-1197：Agent 配置的「未保存改动离开守卫」（用户原话「Agent 修改不点保存保存不了」）。
 *
 * 病根：`patchDetail()` 只改本地 state，只有 `saveDetail()` 才 `agents.update()` 写回。
 * 切到别的 Agent 时 `useEffect` 用服务端值覆盖 `detail`，未保存的编辑**静默消失**。
 *
 * 这些断言是**形状断言**（读源码文本 + 正则），不是运行时行为测试 ——
 * 因为要守住的是「这几行代码还在不在」，而 React 交互在 node 环境下无法真跑。
 *
 * ⚠️ 词边界一律写严：`markSavedFromServer` 与 `unsavedSnapshot` 都是本轮新增的独立标识符，
 * 但守卫里凡是要匹配"调用点"的，必须用 (?<![\w$]) 这类负向后顾，
 * 否则 `markSavedFromServer` 的**定义处**会被 `SavedFromServer` 之类的短模式假命中。
 */

/** 正则元字符转义 —— `countWord("f(x)")` 里若不转义，`(...)` 会被当**捕获组**，
 *  于是模式变成「f 后面紧跟 x」而永不匹配 ⇒ 计数恒为 0（守卫静默失效）。 */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在 src 里数「词边界严格」的匹配次数。 */
function countWord(src: string, word: string): number {
  const re = new RegExp(`(?<![\\w$])${escRe(word)}(?![\\w$])`, "g");
  return (src.match(re) ?? []).length;
}

/** 去掉块注释与行注释 —— 判「有没有第二产地」时**必须**先剥，
 *  否则我们自己写的说明性注释（提到 localStorage）会造成假命中。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("A-1197：定位结论 —— 守卫挂在 AgentsPanel（不是 ProvidersPanel / MindHubPanel）", () => {
  it("AgentsPanel 存在「已落盘基线」ref，且判脏函数读的是它", () => {
    const src = readText(AGENTS);
    // 基线 ref：与"当前值"比较才能知道有没有改动
    expect(src).toMatch(/const\s+savedRef\s*=\s*React\.useRef<string>\(""\)/);
    /* 2026-10-08（用户实测「不管是否修改都会弹窗」）：判脏升级为**双条件** ——
       ① 用户真编辑过（editedRef，只有 patchDetail 置位、markSavedFromServer 复位）
       ② 快照与已落盘基线不同（savedRef）。
       漏掉 ① ⇒ 假脏复发（每次离开都弹）；漏掉 ② ⇒ 改过又改回原样也会被拦。两者都必须被断言。 */
    expect(src).toMatch(/const\s+editedRef\s*=\s*React\.useRef\(false\)/);
    expect(src).toMatch(/function\s+isDirtyNow\(\)\s*:\s*boolean\s*\{\s*return\s+editedRef\.current\s*&&\s*unsavedSnapshot\(detail\)\s*!==\s*savedRef\.current;/);
    expect(src).toMatch(/function\s+markSavedFromServer\(d:\s*AgentDetail\s*\|\s*null\):\s*void\s*\{[\s\S]*?editedRef\.current\s*=\s*false/);
    expect(src).toMatch(/function\s+patchDetail\(patch:\s*Partial<AgentDetail>\):\s*void\s*\{\s*editedRef\.current\s*=\s*true;/);
  });

  it("unsavedSnapshot 只覆盖 saveDetail 真正写回的可编辑字段", () => {
    const src = readText(AGENTS);
    const m = /function\s+unsavedSnapshot\(d:\s*AgentDetail\s*\|\s*null\):\s*string\s*\{([\s\S]*?)\n\}/.exec(src);
    expect(m).not.toBeNull();
    const body = m![1];
    // 这五个字段正是 saveDetail 里 patch 会写的
    for (const f of ["role", "mode", "show_thinking", "tool_profile", "subagent_dispatch"]) {
      expect(body).toMatch(new RegExp(`(?<![\\w$])${f}(?![\\w$])`));
    }
    // name / id 是只读展示字段，计入快照 ⇒ 平白弹窗
    expect(body).not.toMatch(/name:/);
    expect(body).not.toMatch(/(?<!\w)id:/);
  });

  it("工具白名单按排序后比较（勾选顺序不同不该算改动）", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/\[\.\.\.tp\.skills\]\.sort\(\)/);
    expect(src).toMatch(/\[\.\.\.tp\.mcp\]\.sort\(\)/);
  });
});

describe("A-1197：切换 Agent 必须过闸门（不能静默丢弃）", () => {
  it("selectAgent 走 requestLeave，而不是直接 setLocalId", () => {
    const src = readText(AGENTS);
    const m = /const\s+selectAgent\s*=\s*\(id:\s*string\):\s*void\s*=>\s*\{([\s\S]*?)\n  \};/m.exec(src);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/(?<![\w$])requestLeave\(\{\s*kind:\s*"select",\s*agentId:\s*id\s*\}\)/);
    // 直接切走 = 原始 bug 复发
    expect(body).not.toMatch(/(?<![\w$])setLocalId\(id\)/);
  });

  it("requestLeave 的放行条件：无脏 或 已勾「以后不再」⇒ 直接走；否则挂起等确认", () => {
    const src = readText(AGENTS);
    const m = /function\s+requestLeave\(next:\s*\{[^}]*\}\):\s*void\s*\{([\s\S]*?)\n  \}/.exec(src);
    expect(m).not.toBeNull();
    const body = m![1];
    // 短路顺序：先判脏、再看 hintHidden，最后才挂起
    expect(body).toMatch(/if\s*\(!isDirtyNow\(\)\s*\|\|\s*hintHidden\)\s*\{\s*commitLeave\(next\);\s*return;\s*\}/);
    expect(body).toMatch(/(?<![\w$])setPendingLeave\(next\)/);
    // hintHidden 必须**参与**放行判断：勾了「以后不再」却仍然弹 = 假装有关闭
    expect(countWord(body, "hintHidden")).toBeGreaterThanOrEqual(1);
  });

  it("commitLeave 才真正执行切换，且用它收口 pendingLeave", () => {
    const src = readText(AGENTS);
    const m = /function\s+commitLeave\(next:\s*\{[^}]*\}\):\s*void\s*\{([\s\S]*?)\n  \}/.exec(src);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/(?<![\w$])setPendingLeave\(null\)/);
    expect(body).toMatch(/(?<![\w$])setLocalId\(next\.agentId\)/);
    expect(body).toMatch(/(?<![\w$])props\.onSelectAgent\(next\.agentId\)/);
  });
});

describe("A-1197：弹窗本身 —— 说清会丢什么 + 两个明确选择 + 可勾选且持久化", () => {
  it("弹窗挂在 pendingLeave 上，两个按钮分别对应放弃/留下", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/\{pendingLeave\s*&&\s*\(/);
    expect(src).toMatch(/>放弃改动并离开</);
    expect(src).toMatch(/>取消，留在此页保存</);
    // 关闭/取消都必须收回 pendingLeave，否则下次进来还卡在弹窗态
    expect(countWord(src, "setPendingLeave(null)")).toBeGreaterThanOrEqual(2);
  });

  it("文案说清「会直接丢掉」与两个选择的含义", () => {
    const src = readText(AGENTS);
    expect(src).toContain("直接丢掉");
    expect(src).toContain("不会自动保留");
  });

  it("中文串里没有 ASCII 双引号（一律用「」）", () => {
    const src = stripComments(readText(AGENTS));
    const block = /\{pendingLeave\s*&&\s*\([\s\S]*?\n      \)\}/.exec(src);
    expect(block).not.toBeNull();
    /* 只看 JSX **文本节点**：先摘掉所有 `attr="…"` 形式的属性值与字符串字面量，
     * 剩下的才是用户真正读到的文案。否则 `"btn danger"` 这类属性引号会被误判。 */
    const text = block![0]
      .replace(/"[^"\n]*"/g, '""')      // 属性值 / 字符串字面量
      .replace(/=\{[^}\n]*\}/g, "{}");  // {...} 表达式
    // 文案里出现 ASCII 双引号（含英文引号包裹的中文）即判红
    expect(/[\u4e00-\u9fa5][^<>{}"]*"/.test(text)).toBe(false);
    // 并且确实用了中文书名号式的引号
    expect(text).toContain("保存配置");
  });

  it("勾选框绑定 hintHidden，勾选即持久化", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/type="checkbox"\s+checked=\{hintHidden\}/);
    const m = /function\s+onHintHiddenChange\(v:\s*boolean\):\s*void\s*\{([\s\S]*?)\n  \}/.exec(src);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/(?<![\w$])setHintHidden\(v\)/);
    expect(body).toMatch(/(?<![\w$])writeUnsavedHintHidden\(v\)/);
  });

  it("面板内有常驻开关 ⇒ 存在恢复路径（勾错能改回来）", () => {
    const src = readText(AGENTS);
    // 常驻（非弹窗内）的同一套勾选框
    expect(countWord(src, "onHintHiddenChange(e.target.checked)")).toBeGreaterThanOrEqual(2);
    expect(src).toContain("以后不再提示未保存改动");
  });
});

describe("A-1197：基线重置时机 —— 只有真落盘才清脏", () => {
  it("服务端回填详情后立刻重置基线（否则切 Agent 拿新内容比旧基线 ⇒ 满屏误报）", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/markSavedFromServer\(next\)/);
    // catch 分支也必须重置，否则 detail 变 null 时旧基线残留
    expect(src).toMatch(/\.catch\(\(\)\s*=>\s*\{\s*setDetail\(null\);\s*markSavedFromServer\(null\);\s*\}\)/);
  });

  it("保存成功后才重置基线；失败分支不得出现 markSavedFromServer", () => {
    const src = readText(AGENTS);
    const m = /async\s+function\s+saveDetail\(\)[\s\S]*?\n  \}/.exec(src);
    expect(m).not.toBeNull();
    const body = m![0];
    // 成功分支里有
    expect(body).toMatch(/if\s*\(res\.ok\)\s*\{[\s\S]*?(?<![\w$])markSavedFromServer\(detail\)/);
    // 失败分支里绝不能有：保存失败还清脏 = 用户以为存好了、离开也不再被拦
    const failBranch = /else\s*\{\s*showNotice\(false,\s*"保存失败"\);[\s\S]*?\n      \}/.exec(body);
    expect(failBranch).not.toBeNull();
    expect(failBranch![0]).not.toMatch(/(?<![\w$])markSavedFromServer/);
  });

  it("markSavedFromServer 同时写基线 ref 与 dirty state", () => {
    const src = readText(AGENTS);
    const m = /function\s+markSavedFromServer\(d:\s*AgentDetail\s*\|\s*null\):\s*void\s*\{([\s\S]*?)\n  \}/.exec(src);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/savedRef\.current\s*=\s*unsavedSnapshot\(d\)/);
    expect(body).toMatch(/(?<![\w$])setDirty\(false\)/);
  });

  it("编辑入口统一走 patchDetail（否则改了字却不标脏）", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/function\s+patchDetail\(patch:\s*Partial<AgentDetail>\):\s*void/);
    const body = /function\s+patchDetail\(patch:\s*Partial<AgentDetail>\):\s*void\s*\{([\s\S]*?)\n  \}/.exec(src)![1];
    expect(body).toMatch(/(?<![\w$])setDirty\(true\)/);
    // 详情面板里的可编辑控件不得再直接 setDetail（会绕过脏标记）
    expect(src).toMatch(/(?<![\w$])onChange=\{\(v\)\s*=>\s*patchDetail\(\{\s*tool_profile:\s*v\s*\}\)\}/);
    expect(src).not.toMatch(/onChange=\{\(v\)\s*=>\s*setDetail\(\{ \.\.\.detail,/);
  });
});

describe("A-1197：「以后不再」复用既有 localStorage 键位惯例（不另起一套）", () => {
  it("键名沿用 slime.<域>.hintHidden 形态，值为 1/0", () => {
    const src = readText(OPFOCUS);
    expect(src).toMatch(/export const UNSAVED_HINT_KEY = "slime\.unsavedChanges\.hintHidden";/);
    // 存储形态与 OP_FOCUS_HINT_KEY 一致：恒为 "1" / "0"
    expect(src).toMatch(/getItem\(UNSAVED_HINT_KEY\)\s*===\s*"1"/);
    expect(src).toMatch(/setItem\(UNSAVED_HINT_KEY,\s*hidden\s*\?\s*"1"\s*:\s*"0"\)/);
    // 同一文件里已存在的那把钥匙（不许把它改坏）
    expect(src).toMatch(/export const OP_FOCUS_HINT_KEY = "slime\.opFocus\.hintHidden";/);
  });

  it("读写成对存在，且读写各自独立成函数", () => {
    const src = readText(OPFOCUS);
    expect(src).toMatch(/export function readUnsavedHintHidden\(\): boolean/);
    expect(src).toMatch(/export function writeUnsavedHintHidden\(hidden:\s*boolean\): void/);
  });

  it("存储不可用时出声，不静默吞异常", () => {
    const src = readText(OPFOCUS);
    for (const fn of ["readUnsavedHintHidden", "writeUnsavedHintHidden"]) {
      const m = new RegExp(`export function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(src);
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(/console\.error/);
      expect(m![1]).not.toMatch(/catch\s*\{\s*\}/);
    }
  });

  it("AgentsPanel 从 operationFocus 引入这两个函数（不自己再写一套 localStorage）", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/import\s*\{[^}]*readUnsavedHintHidden[^}]*\}\s*from\s*"\.\/operationFocus\.js"/);
    expect(src).toMatch(/import\s*\{[^}]*writeUnsavedHintHidden[^}]*\}\s*from\s*"\.\/operationFocus\.js"/);
    // 第二产地：AgentsPanel 里不该出现裸 localStorage（先剥注释，否则被自己写的说明命中）
    expect(stripComments(src)).not.toMatch(/localStorage/);
  });

  it("初始值从持久化读入（刷新后仍记得勾过）", () => {
    const src = readText(AGENTS);
    expect(src).toMatch(/React\.useState<boolean>\(\(\)\s*=>\s*readUnsavedHintHidden\(\)\)/);
  });
});