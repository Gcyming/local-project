/**
 * tests/core-ts/a1027-guards.spec.ts — 「`marker@0` 工具留痕整条不可见」的守卫。
 *
 * 用户裁决项（原话："修，解析成 tool 节点"）。缺陷链（三个环节，缺一不成立）：
 *   ① **产地**：`core-ts/src/services/chat.ts` 的 `composeToolCallBlock()` 在**无思考模型**下
 *      把工具块写成**整段** reasoning —— marker 落在偏移 **0**（`reasoningBuf` 为空时
 *      `reasoningBuf = toolBlock`）。有思考的模型是追加在末尾，所以这个形态只出现在无思考模型上。
 *   ② **消费**：渲染层用 `/\n?### 工具调用记录\n[\s\S]*$/` 从 marker **一路砍到文本结尾** →
 *      对 marker@0 的记录，reasoning 被砍成空串。
 *   ③ **兜底**：历史记录里 `stages` 整个字段都**不存在**（实测 6 条 marker@0 记录全部如此）
 *      → 时间线长度 0 → 渲染处 `return null` → **整个思考面板不渲染**：按钮在、点它没反应。
 *
 * 所以修法不是"换个正则"，而是**把工具块解析成 tool 节点**：留痕本来就是工具信息，
 * 丢掉它才是错的。守卫必须同时覆盖"解析正确"与"解析结果真的接到了渲染上"两件事 ——
 * 只测前者就是 A-1022 那种"改坏了守卫还挺绿"的假修。
 *
 * ⚠️ 每条守卫都必须过**变异测试**（见 `gui/scripts/mut-a1027-tooltrace.mjs`）。
 *    断言一律用**结构锚点**（函数名/属性名/整块形态），不用"起点 + N 字符"的取样窗口。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_TRACE_HEADING,
  splitToolTrace,
  traceEntriesToToolSteps,
  composeToolTrace,
  splitThinkingIntoSteps,
  resolveToolEntry,
} from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");
const THINKING_TEXT = join(ROOT, "gui/src/renderer/pages/thinkingText.ts");
const CORE_CHAT = join(ROOT, "core-ts/src/services/chat.ts");
const HISTORY = join(ROOT, "config/history.jsonl");

const chatSrc = readFileSync(CHAT_PANEL, "utf8");
const thinkSrc = readFileSync(THINKING_TEXT, "utf8");
const coreSrc = readFileSync(CORE_CHAT, "utf8");

/**
 * 剥掉注释再断言。
 * 本轮的修复代码里**故意**在注释里写了旧正则与旧字面量（解释"为什么不能这样"），
 * 不对注释脱敏就会自己把自己判红 —— 最后被人"顺手删掉守卫"收场。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const chatCode = stripComments(chatSrc);
const thinkCode = stripComments(thinkSrc);

/**
 * 工具栏表替身：**形状必须与真实 `TOOL_LABELS` 一致**（键 = 工具名，值 = `{label}`）。
 * ⚠️ 早先这里写成了"展示名 → {name,label}"的反向表，配上 `resolveToolEntry` 后键被当成
 *    工具名解释，第一步反查就命中了错误的 name（`{name:"网络搜索"}`）—— 替身形状错 = 守卫失效。
 */
const LOOKUP = {
  web_search: { label: "网络搜索" },
  file_read: { label: "读取文件" },
  file_list: { label: "列出文件" },
  ask_user: { label: "询问用户" },
  // A-975 那批的**裸名**：core-ts 展示名表没覆盖 → 落盘原样写了工具名
  screen_capture: { label: "屏幕截图" },
} as const;
const lookup = (e: string) => resolveToolEntry(e, LOOKUP);

/** 复刻渲染层兜底时间线的**纯逻辑部分**（JSX 那一层由结构守卫钉死）。 */
function fallbackTimeline(reasoning: string, existingTools: Array<{ name?: string; label?: string }> = []) {
  const trace = splitToolTrace(reasoning);
  return {
    body: trace.text,
    steps: [
      ...splitThinkingIntoSteps(trace.text).map((t) => ({ kind: "think" as const, text: t })),
      ...existingTools.map((t) => ({ kind: "tool" as const, name: t.name, label: t.label })),
      ...traceEntriesToToolSteps(trace.traces, lookup, existingTools).map((t) => ({ kind: "tool" as const, ...t })),
    ],
  };
}

describe("A-1027 ①：marker@0 不再砍空 —— 工具块被解析成节点", () => {
  it("整段 reasoning 就是工具块（marker@0）→ 正文为空但工具条目全部保留", () => {
    const r = "### 工具调用记录\n- ⟳ 询问用户";
    const out = fallbackTimeline(r);
    expect(out.body, "marker@0 的正文应为空（它本来就没有思考文本）").toBe("");
    expect(out.steps.length, "★ 面板能否渲染全看这个长度：为 0 就是原来的『点了没反应』").toBe(1);
    expect(out.steps[0]).toMatchObject({ kind: "tool", name: "ask_user", label: "询问用户" });
  });

  it("多个条目按原顺序成节点，且名字反查成功时带上 name（图标才对）", () => {
    const r = "### 工具调用记录\n- ⟳ 列出文件\n- ⟳ 网络搜索\n- ⟳ 读取文件\n- ⟳ 读取文件";
    const out = fallbackTimeline(r);
    expect(out.steps.filter((s) => s.kind === "tool").map((s) => s.label)).toEqual(["列出文件", "网络搜索", "读取文件", "读取文件"]);
    expect(out.steps[1]).toMatchObject({ name: "web_search" });
    expect(out.steps[2]).toMatchObject({ name: "file_read" });
  });

  it("落盘的是**原始工具名**时也顺手升级成人类可读名（core-ts 展示名表没覆盖 A-975/976 那批）", () => {
    const out = fallbackTimeline("### 工具调用记录\n- ⟳ screen_capture");
    expect(out.steps[0], "裸工具名必须被反查成展示名，否则界面上会出现 screen_capture 这种标识符")
      .toMatchObject({ name: "screen_capture", label: "屏幕截图" });
  });

  it("反查不到 → 原样展示（不猜、不吞）", () => {
    const out = fallbackTimeline("### 工具调用记录\n- ⟳ 某个自定义工具");
    expect(out.steps[0]).toEqual({ kind: "tool", label: "某个自定义工具" });
  });

  it("结构化来源优先：已被 `stages.tools` 覆盖的条目不再重复出节点", () => {
    // 新格式里两条来源同时存在（reasoning 落块 + stages.tools 结构化）→ 不去重就会显示两遍
    const existing = [{ name: "web_search", label: "网络搜索" }];
    const out = fallbackTimeline("### 工具调用记录\n- ⟳ 网络搜索\n- ⟳ 读取文件", existing);
    const labels = out.steps.filter((s) => s.kind === "tool").map((s) => s.label);
    expect(labels, "网络搜索被显示了两遍（结构化来源 + 文本块各一次）").toEqual(["网络搜索", "读取文件"]);
  });

  it("去重是**多重集**语义：同名工具调用两次、结构化只覆盖一次 → 仍要补出第二次", () => {
    const existing = [{ name: "file_read", label: "读取文件" }];
    const out = fallbackTimeline("### 工具调用记录\n- ⟳ 读取文件\n- ⟳ 读取文件", existing);
    const labels = out.steps.filter((s) => s.kind === "tool").map((s) => s.label);
    expect(labels).toEqual(["读取文件", "读取文件"]);
  });

  it("有思考文本时：思考段在前、工具节点在后（跟随块的**记录位置**）", () => {
    const out = fallbackTimeline("模型先想了一段。\n\n### 工具调用记录\n- ⟳ 网络搜索");
    expect(out.steps.map((s) => s.kind)).toEqual(["think", "tool"]);
    expect(out.body).toBe("模型先想了一段。");
  });
});

describe("A-1027 ②：解析器本身的三条硬约束", () => {
  it("无损：块后出现非列表行 → 块到此结束，该行**保留**在正文里", () => {
    const out = splitToolTrace("### 工具调用记录\n- ⟳ 网络搜索\n这段不是列表，必须留下");
    expect(out.traces).toEqual(["网络搜索"]);
    expect(out.text, "吞内容正是这个 bug 的原始形态，绝不许再犯").toContain("这段不是列表，必须留下");
  });

  it("块可出现在中间：以「下一个行首同级标题」为终点，后续章节保留", () => {
    const src = "前言\n\n### 工具调用记录\n- ⟳ 读取文件\n\n### 结论\n收尾";
    const out = splitToolTrace(src);
    expect(out.traces).toEqual(["读取文件"]);
    expect(out.text).toContain("前言");
    expect(out.text, "旧正则 `[\\s\\S]*$` 会把结论一起吃掉").toContain("### 结论");
    expect(out.text).toContain("收尾");
  });

  it("块终点（通用规则）：块后**任何**非列表行都终止块，且该行之后的列表项不得再被当成留痕", () => {
    // 这是"块跑到文末"这个原始病灶的反面：终止规则只有一条（首个非列表行），
    // 去掉 `inBlock = false` 后，后面章节自己的列表项会被吃进留痕节点里。
    const src = "### 工具调用记录\n- ⟳ 网络搜索\n\n### 结论\n- 这一条是结论自己的列表项";
    const out = splitToolTrace(src);
    expect(out.traces, "块已经结束了，后面章节的列表项还进了留痕").toEqual(["网络搜索"]);
    expect(out.text).toContain("- 这一条是结论自己的列表项");
  });

  it("无块 → 原样返回（不加工、不加 trim 之外的东西）", () => {
    expect(splitToolTrace("就是一段普通文本\n\n第二段")).toEqual({ text: "就是一段普通文本\n\n第二段", traces: [] });
  });

  it("条目前缀容错：`- ` / `* ` 有无 `⟳` 都要认（渲染层还产出一批不带 ⟳ 的错误留痕）", () => {
    expect(splitToolTrace("### 工具调用记录\n- 无箭头的条目\n* ⟳ 星号条目").traces)
      .toEqual(["无箭头的条目", "星号条目"]);
  });

  it("composeToolTrace 与 core-ts 的输出**逐字节一致**（同一个格式，两份实现）", () => {
    // core-ts：`### 工具调用记录\n${lines.join("\n")}`，lines = `- ⟳ ${toolDisplayName(n)}`
    expect(composeToolTrace(["⟳ 网络搜索", "⟳ 读取文件"]))
      .toBe("### 工具调用记录\n- ⟳ 网络搜索\n- ⟳ 读取文件");
    expect(composeToolTrace([]), "空条目不许产出空块（否则历史里会留下一句光秃秃的标题）").toBe("");
  });
});

describe("A-1027 ③：解析结果必须真的接到渲染上（否则是假修）", () => {
  it("兜底路径用唯一解析实现，旧的『砍到文末』内联正则不得残留", () => {
    expect(chatCode, "兜底路径必须走 splitToolTrace")
      .toContain("splitToolTrace(m.reasoning ?? \"\")");
    expect(chatCode, "旧的 `[\\s\\S]*$` 会从 marker 吞到文末（marker@0 时把整段推理砍空）")
      .not.toMatch(/replace\(\/\\n\?### 工具调用记录\\n\[\\s\\S\]\*\$\//);
  });

  it("解析出的工具节点真的进了 timeline 数组", () => {
    // A-1034：断言从"整行字面量"改为"映射表达式必须产出 name/label（可带其它字段）"——
    // 原写法只要给节点加一个字段（例如 A-1034 补的 result）就会误红，
    // 而它真正要守的是"解析出来必须渲染"，不是"字段不能增加"。
    const m = /\.\.\.tracedTools\.map\(\(t\) => \(\{([\s\S]{0,220}?)\}\)\)/.exec(chatCode);
    expect(m, "解析出来却不渲染 = 白修：找不到 tracedTools 的映射表达式").not.toBeNull();
    const body = m![1];
    expect(body, "映射出的节点必须带上工具名").toMatch(/name:\s*t\.name/);
    expect(body, "映射出的节点必须带上展示标签").toMatch(/label:\s*t\.label/);
    expect(chatCode).toContain("traceEntriesToToolSteps(trace.traces, matchToolLabel, tools)");
  });

  it("渲染层反查函数存在且被兜底路径引用（薄壳：逻辑在纯模块）", () => {
    expect(chatCode).toContain("export function matchToolLabel(");
    expect(chatCode, "薄壳必须把图标表注入纯函数；自己再抄一遍 = 两处实现")
      .toContain("return resolveToolEntry(entry, TOOL_LABELS);");
    expect(chatCode, "反查逻辑不得在渲染层复活（住 `.tsx` 就只能被结构断言钉住 → 短路成 null 也全绿）")
      .not.toContain("Object.entries(TOOL_LABELS)");
  });

  it("反查两步都住在纯模块里（行为由下面的 ⑤ 直接钉）", () => {
    expect(thinkCode, "缺了『按展示名反查』那一步")
      .toContain("for (const [name, v] of Object.entries(table)) {");
    expect(thinkCode, "展示名反查的比较条件被改掉了").toContain("if (v.label === t) { return { name, label: v.label }; }");
    expect(thinkCode, "缺了『按工具名直查』那一步 → screen_capture / adb_shell 这类裸名继续出现在界面上")
      .toContain("const byKey = Object.prototype.hasOwnProperty.call(table, t) ? table[t] : undefined;");
  });

  it("工具块格式在渲染层**只有一个产地**（此前 ChatPanel 手写了两遍）", () => {
    expect(chatCode, "标题字面量必须只在 thinkingText.ts（唯一产地）")
      .not.toContain("\"### 工具调用记录");
    expect(thinkCode).toContain("export function composeToolTrace(");
    expect(chatCode).toContain("composeToolTrace(");
    // 旧手写形态（模板串里裸写标题）不得复活
    expect(chatCode, "手写块格式复活 → 改一处漂一处")
      .not.toMatch(/`### 工具调用记录\\n/);
  });

  it("跨进程格式一致性：渲染层的标题常量 == core-ts 组装器里的字面量", () => {
    // 渲染层不 import core-ts（避免把主进程图谱打进浏览器构建）→ 只能钉死两边字面量：
    // core-ts 组装器写出的块，渲染层必须能认出标题。改一边不改另一边 → 留痕整条又不可见。
    const coreHeading = "### 工具调用记录";
    expect(coreSrc, "core-ts 侧组装器的标题字面量不在了（改名前请先改本守卫）").toContain(`\`${coreHeading}\\n`);
    expect(TOOL_TRACE_HEADING, "★ 两边标题不一致：core-ts 写的块，渲染层将解析不出来").toBe(coreHeading);
    expect(thinkSrc).toContain(`export const TOOL_TRACE_HEADING = "${coreHeading}";`);
  });
});

describe("A-1027 ④：工具条目反查 —— 纯逻辑就必须**行为**可测", () => {
  // ⚠️ 这一段是 A-1027 变异 ③ 漏网后的补课：反查原先住在 `ChatPanel.tsx`（带图标表），
  //    守卫只能断言"那几行在不在"，把它短路成 `return null` 依然全绿。
  //    纯逻辑搬进 `thinkingText.ts` 后，用注入的替代表就能直接测 —— 短路立刻变红。
  const TABLE = { web_search: { label: "网络搜索" }, screen_capture: { label: "屏幕截图" } };

  it("① 按**展示名**反查：core-ts 落盘写的是展示名 → 必须能拿回工具名（否则图标全退化）", () => {
    expect(resolveToolEntry("网络搜索", TABLE)).toEqual({ name: "web_search", label: "网络搜索" });
  });

  it("② 按**工具名**直查：A-975/976 那批落盘的是裸名 → 必须升级成人类可读名", () => {
    expect(resolveToolEntry("screen_capture", TABLE)).toEqual({ name: "screen_capture", label: "屏幕截图" });
  });

  it("③ 都不命中 → null（调用方原样展示；不猜、不吞）", () => {
    expect(resolveToolEntry("某个自定义工具", TABLE)).toBeNull();
  });

  it("空白输入 → null（不许把空串当成一个工具）", () => {
    expect(resolveToolEntry("", TABLE)).toBeNull();
    expect(resolveToolEntry("   ", TABLE)).toBeNull();
  });

  it("先 trim 再查（块里的条目可能带尾随空格）", () => {
    expect(resolveToolEntry("  网络搜索 ", TABLE)).toEqual({ name: "web_search", label: "网络搜索" });
  });

  it("原型链上的键不得被当成合法工具（`constructor` / `__proto__` 会命中原型链）", () => {
    expect(resolveToolEntry("constructor", TABLE)).toBeNull();
    expect(resolveToolEntry("__proto__", TABLE)).toBeNull();
  });
});

describe("A-1027 ⑤：真实语料核对（config/history.jsonl）", () => {
  const has = existsSync(HISTORY);
  const records = has
    ? readFileSync(HISTORY, "utf8").split("\n").filter((l) => l.trim().length > 0)
        .map((l) => { try { return JSON.parse(l) as { reasoning?: string; stages?: { tools?: unknown[]; timeline?: unknown[] } }; } catch { return null; } })
        .filter((r): r is { reasoning?: string; stages?: { tools?: unknown[]; timeline?: unknown[] } } => r !== null)
    : [];

  const withMarker = records.filter((r) => (r.reasoning ?? "").includes(TOOL_TRACE_HEADING));

  it.skipIf(!has)("每一条含工具块的记录都至少能产出 1 个节点（留痕不再凭空消失）", () => {
    expect(withMarker.length, "语料里应当有含工具块的记录").toBeGreaterThan(0);
    const empty = withMarker.filter((r) => {
      const t = fallbackTimeline(r.reasoning ?? "", (r.stages?.tools ?? []) as Array<{ name?: string; label?: string }>);
      return t.steps.length === 0;
    });
    expect(empty.length, `有 ${empty.length} 条记录解析后依然零节点（= 面板不渲染）`).toBe(0);
  });

  it.skipIf(!has)("marker@0（无思考模型）这一类：旧实现必然零节点，新实现必须有工具节点", () => {
    const atZero = withMarker.filter((r) => (r.reasoning ?? "").startsWith(TOOL_TRACE_HEADING));
    if (atZero.length === 0) { return; }  // 语料里暂时没有这类记录 → 不假红
    for (const r of atZero) {
      const legacy = (r.reasoning ?? "").replace(/\n?### 工具调用记录\n[\s\S]*$/g, "");
      expect(legacy.trim(), "前提核对：这类记录的旧实现产物确实为空").toBe("");
      const t = fallbackTimeline(r.reasoning ?? "", (r.stages?.tools ?? []) as Array<{ name?: string; label?: string }>);
      expect(t.steps.length, `marker@0 记录仍产不出节点：${JSON.stringify((r.reasoning ?? "").slice(0, 40))}`).toBeGreaterThan(0);
    }
  });
});
