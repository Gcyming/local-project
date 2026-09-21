/**
 * tests/core-ts/a1054-guards.spec.ts — A-1054 三处修复的守卫。
 *
 * ① 会话加载慢：思考面板**懒挂载**（`gui/src/renderer/pages/reasoningGate.ts`）
 * ② 侧栏品牌图标：`S` 字面量 → 应用图标（`App.tsx` + `index.css`）
 * ③ Agnes / 小红书 上下文口径：`524288` → `512000`（`shared/gen/model-capabilities.ts`）
 *
 * ⚠️ 验收标准是**变异测试**：写完必须逐条把源码改坏、确认它变红。
 *    「通过但锁错对象」比没有守卫更糟 —— 因此本文件**优先测行为**（①③ 的核心是纯函数，直接喂输入），
 *    只在「接线 / 静态形态」这一层才做源码断言（② 只剩源码形态可断言，故把能断的都断上）。
 *
 * ⚠️ 中文文案里嵌套引用一律用 `「」`：ASCII 双引号会当场把字符串截断（本文件踩过）。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  advanceReasoningFrame,
  hasReasoningData,
  isOpenClass,
  shouldMountBody,
} from "../../gui/src/renderer/pages/reasoningGate.js";
import {
  MODEL_CAPABILITIES,
  PROBE_OUTCOME_HINT,
  classifyProbeOutcome,
} from "../../shared/gen/model-capabilities.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}/${rel}`, "utf8");

/** 取源码里一段（起点标记 → 下一个终点标记），用于「局部」不变式：避免被文件别处的同名符号干扰。 */
function segment(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `源码里找不到片段起点：${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `源码里找不到片段终点：${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

/* ══════════════════════════════════════════════════════════════════
 * ① 会话加载慢：懒挂载闸门（**行为**层）
 * ══════════════════════════════════════════════════════════════════ */

describe("A-1054① 懒挂载：数据存在性守卫", () => {
  it("无任何思考数据 → false（保留 A-1015 语义：不渲染空壳，避免「按钮在、点了没反应」）", () => {
    expect(hasReasoningData({})).toBe(false);
    expect(hasReasoningData({ reasoning: "" })).toBe(false);
    expect(hasReasoningData({ stages: {} })).toBe(false);
    expect(hasReasoningData({ stages: { timeline: [], tools: [], reads: [], urls: [] } })).toBe(false);
  });

  it("任一来源有数据 → true（五个字段各自独立成立）", () => {
    expect(hasReasoningData({ reasoning: "t" })).toBe(true);
    expect(hasReasoningData({ stages: { timeline: [1] } })).toBe(true);
    expect(hasReasoningData({ stages: { tools: [1] } })).toBe(true);
    expect(hasReasoningData({ stages: { reads: [1] } })).toBe(true);
    expect(hasReasoningData({ stages: { urls: [1] } })).toBe(true);
  });

  it("反空转：长度 1 与长度 0 结果必须不同（否则上面那组断言全是永真）", () => {
    // 专治把 `> 0` 写成 `>= 0`：那种改法会让**所有**消息都判定为有数据（懒挂载当场失效、
    // 每条消息都挂），而上面那组断言依然全绿 —— 单靠「有数据为真」是锁不住的。
    expect(hasReasoningData({ reasoning: "x" })).not.toBe(hasReasoningData({ reasoning: "" }));
    expect(hasReasoningData({ stages: { tools: [null] } })).not.toBe(hasReasoningData({ stages: { tools: [] } }));
  });
});

describe("A-1054① 懒挂载：是否挂载正文", () => {
  it("收起且从未展开过 → 不挂（这就是省下的 88ms / 1090 次挂载）", () => {
    expect(shouldMountBody(false, false)).toBe(false);
  });

  it("展开 → 挂", () => {
    expect(shouldMountBody(true, false)).toBe(true);
    expect(shouldMountBody(true, true)).toBe(true);
  });

  it("收起但展开过 → 仍挂（A-1015：收起只切类名、不卸载，否则收起瞬间没有可插值的元素）", () => {
    expect(shouldMountBody(false, true)).toBe(true);
  });
});

describe("A-1054① 懒挂载：is-open 类名", () => {
  it("未 readyToOpen → 不带 is-open（首次展开的第 1 帧必须先保持 0fr）", () => {
    expect(isOpenClass(true, false)).toBe(false);
  });

  it("展开且 readyToOpen → 带 is-open", () => {
    expect(isOpenClass(true, true)).toBe(true);
  });

  it("收起 → 一律不带 is-open，即使 readyToOpen 仍为 true（否则高度被 1fr 顶住、收起动画不塌）", () => {
    expect(isOpenClass(false, true)).toBe(false);
    expect(isOpenClass(false, false)).toBe(false);
  });
});

describe("A-1054① 懒挂载：两帧推进（首次展开必须有中间帧）", () => {
  it("第 1 帧：只挂正文、不展开 —— 若这一步直接置 readyToOpen，过渡会退化成生硬跳变", () => {
    expect(advanceReasoningFrame(true, false, false)).toEqual({ everMounted: true, readyToOpen: false });
  });

  it("第 2 帧：切 is-open", () => {
    expect(advanceReasoningFrame(true, true, false)).toEqual({ everMounted: true, readyToOpen: true });
  });

  it("幂等：已就绪再推不变", () => {
    expect(advanceReasoningFrame(true, true, true)).toEqual({ everMounted: true, readyToOpen: true });
  });

  it("收起不卸载：everMounted 保持 true，两个字段都不回退", () => {
    expect(advanceReasoningFrame(false, true, true)).toEqual({ everMounted: true, readyToOpen: true });
    expect(advanceReasoningFrame(false, false, false)).toEqual({ everMounted: false, readyToOpen: false });
  });

  it("两帧确实有序：把第 1 帧的产物再推一次才得到展开态，且第 1 帧不可见", () => {
    const f1 = advanceReasoningFrame(true, false, false);
    expect(f1.readyToOpen).toBe(false);                      // 第 1 帧若已展开，这行就红
    expect(isOpenClass(true, f1.readyToOpen)).toBe(false);   // 第 1 帧确实不可见（0fr）
    const f2 = advanceReasoningFrame(true, f1.everMounted, f1.readyToOpen);
    expect(f2).toEqual({ everMounted: true, readyToOpen: true });
  });
});

describe("A-1054① 接线：组件必须真的用这套闸门，且不许再有急切计算", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");
  const section = segment(chat, "const ReasoningSection = React.memo(", "const AssistantMessage = React.memo(");
  const assistant = segment(chat, "const AssistantMessage = React.memo(", "export default function ChatPanel(");

  it("ReasoningSection 调用了四个闸门函数（否则纯函数测试全绿、组件却根本没用它们）", () => {
    for (const fn of ["hasReasoningData(", "shouldMountBody(", "isOpenClass(", "advanceReasoningFrame("]) {
      expect(section, `ReasoningSection 未调用 ${fn}`).toContain(fn);
    }
  });

  it("闸门必须排在昂贵计算之前（先放行、再算时间线）—— 顺序反了就等于没有懒挂载", () => {
    const gate = section.indexOf("shouldMountBody(");
    const compute = section.indexOf("splitThinkingIntoSteps(");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(compute).toBeGreaterThan(gate);
  });

  it("AssistantMessage 内不得再出现 splitThinkingIntoSteps（急切计算已消除）", () => {
    expect(assistant).not.toContain("splitThinkingIntoSteps(");
  });

  it("AssistantMessage 把思考区委托给 ReasoningSection", () => {
    expect(assistant).toContain("<ReasoningSection m={m} collapsed={collapsed} />");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * ② 侧栏品牌图标：`S` 字面量 → 应用图标（只剩源码静态形态可断言）
 * ══════════════════════════════════════════════════════════════════ */

describe("A-1054② 品牌图标：侧栏必须用应用图标，不许再是字母 S", () => {
  const app = read("gui/src/renderer/App.tsx");
  const css = read("gui/src/renderer/index.css");

  it("brand-icon 挂在 <img> 上且 src 引用 appIconUrl", () => {
    expect(app).toContain('<img className="brand-icon" src={appIconUrl}');
  });

  it("不存在把 S 当内容渲染的 brand-icon", () => {
    expect(app).not.toMatch(/<div[^>]*className="brand-icon"[^>]*>\s*S\s*<\/div>/);
  });

  it("appIconUrl 的唯一产地是 build/icon.png（与欢迎页共用，防「改一处、漏一处」）", () => {
    expect(app).toContain('import appIconUrl from "../../build/icon.png"');
    const hits = app.match(/from "\.\.\/\.\.\/build\/icon\.png"/g) ?? [];
    // 反空转：若改成从别处导入，上面那条含 src={appIconUrl} 的断言仍会绿 —— 这条才锁得住产地
    expect(hits.length).toBe(1);
  });

  it(".brand-icon 不再保留文字样式（font-size/color 留着是误导：下一个人会以为这里还在渲染文字）", () => {
    const start = css.indexOf(".brand-icon {");
    expect(start, "index.css 里找不到 .brand-icon").toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).toContain("object-fit: cover");
    expect(body).not.toContain("font-size");
    expect(body).not.toContain("color:");
  });
});

/* ══════════════════════════════════════════════════════════════════
 * ③ Agnes / 小红书 上下文口径（**行为**层：直接读表）
 * ══════════════════════════════════════════════════════════════════ */

describe("A-1054③ 上下文口径：十进制 K（÷1000）必须与官方标注的 K 一致", () => {
  const familyOf = (key: string) => MODEL_CAPABILITIES.find((v) => v.key === key);

  it("agnes 家族 = 512000（官方文档写「512K」；写 524288 会在界面读成 524K）", () => {
    const f = familyOf("agnes");
    expect(f, "MODEL_CAPABILITIES 里没有 agnes 家族").toBeTruthy();
    expect(f?.context).toBe(512000);
    expect(f?.context).not.toBe(524288);
  });

  it("note（点点笔记 / 小红书 dots）家族 = 512000（注释自称「官方公布 512K」，值不能与注释自相矛盾）", () => {
    const f = familyOf("note");
    expect(f, "MODEL_CAPABILITIES 里没有 note 家族").toBeTruthy();
    expect(f?.context).toBe(512000);
  });

  it("两个家族的 context / 1000 必须正好等于官方那个 K（本案 512）", () => {
    for (const key of ["agnes", "note"]) {
      expect((familyOf(key)?.context ?? 0) / 1000, `${key} 的显示口径 K 不等于 512`).toBe(512);
    }
  });

  it("反空转：家族表非空且 key 唯一（否则上面几条全在比 undefined、恒真）", () => {
    expect(MODEL_CAPABILITIES.length).toBeGreaterThan(10);
    const keys = MODEL_CAPABILITIES.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Kimi / 豆包的 262144 保持不动（官方文档自己把 K 定义成 ×1024，是忠实值，不该顺手改成 260000）", () => {
    expect(familyOf("kimi")?.context).toBe(262144);
  });
});

describe("A-1054③ 探针结论：「上游不回传价目」必须被说成正常而不是故障", () => {
  it("分类：上游回传价 → upstream-hit", () => {
    expect(classifyProbeOutcome("upstream", "https://api.deepseek.com/v1")).toBe("upstream-hit");
  });

  it("分类：命中内置表（table / tier / snapshot 三种来源同义）→ builtin-table", () => {
    for (const origin of ["table", "tier", "snapshot"] as const) {
      expect(classifyProbeOutcome(origin, "https://api.deepseek.com/v1")).toBe("builtin-table");
    }
  });

  it("分类：本地 / 内网端点优先判 local（它本来就不需要按 token 的价目）", () => {
    expect(classifyProbeOutcome("none", "http://127.0.0.1:8800/v1")).toBe("local");
    expect(classifyProbeOutcome("upstream", "http://127.0.0.1:8800/v1")).toBe("local");
  });

  it("分类：表里也没有 → unpriced", () => {
    expect(classifyProbeOutcome("none", "https://api.deepseek.com/v1")).toBe("unpriced");
  });

  it("builtin-table 的说明不得出现「失败 / 故障 / 坏了」—— 那正是用户误判「探针坏了」的来源", () => {
    const hint = PROBE_OUTCOME_HINT["builtin-table"];
    expect(hint).toContain("不发布价目");
    for (const banned of ["失败", "故障", "坏了"]) {
      expect(hint, `builtin-table 文案出现「${banned}」→ 把正常形态说成故障，用户会一直去重修探针`).not.toContain(banned);
    }
  });

  it("反空转：四个分类都有文案（漏一个会让面板显示 undefined）", () => {
    for (const k of ["local", "upstream-hit", "builtin-table", "unpriced"] as const) {
      expect((PROBE_OUTCOME_HINT[k] ?? "").length, `缺少 ${k} 的说明文案`).toBeGreaterThan(10);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
 * ④ 新 UI 的「接线」：纯逻辑测过 ≠ 界面用上了
 *    （这两块是 A-1054⑤⑥：底部实时状态行 + 待发指令队列）
 * ══════════════════════════════════════════════════════════════════ */

describe("A-1054④ 接线：底部状态行必须真的接到界面上", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");

  it("组件调用了 deriveLiveStatus（否则纯逻辑测试全绿、界面还是那两个死值）", () => {
    expect(chat).toContain("deriveLiveStatus({");
  });

  it("状态行的扫光**受 animated 控制**（不许无条件挂 text-scan-light：等用户时会假装还在跑）", () => {
    // A-1056②：状态行从底部监测栏搬到 Agent 输出最下方，渲染者变成 `LiveStatusLine`
    // （props 名由 liveStatus 变 status），但这条不变式原样保留：扫光只由 animated 决定。
    expect(chat).toContain('status.animated ? "text-scan-light"');
    // 反空转：不许出现"直接给状态文案挂扫光"的写法
    expect(chat).not.toContain('className="text-scan-light thinking-hint-text"');
  });

  it("旧的死值三元式已被替换（否则状态行等于没做）", () => {
    // ⚠️ 断言必须锚**代码**而不是文案：同一个字符串会出现在解释历史的注释里
    // （改了源码却仍在注释里提到旧文案是正常的，锁文案会让守卫因为注释而红）。
    expect(chat).not.toContain('toolEvents.length > 0 ? "🔧');
    expect(chat).not.toContain('"💭 思考中…") : PLACEHOLDER_PHRASES');
  });
});

describe("A-1054④ 接线：待发指令队列必须真的接到界面上", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");

  /* A-1056③：这一段（"队列有渲染"）的整体契约没变 —— 待发指令必须真的接到界面上；
     但**呈现形态**换过了：不再是"徽标 + 一行纯文本 + describeMode/modeHint 的黑话"，
     而是**用户气泡卡片 + 三个图标操作**（修改 / 直接插入 / 撤销删除）。
     所以这里断言的对象随之更新（词表变了，功能没少）。 */
  it("队列有渲染（面板块存在，且用 summarize + 用户气泡 + 三个操作入口）", () => {
    expect(chat).toContain("待发");
    expect(chat).toContain("summarize(queueOfMine)");
    // 用户气泡卡片（与已发出的用户消息同款右对齐圆角）
    expect(chat).toContain('borderRadius: "16px 16px 4px 16px"');
    for (const fn of ["editQueueItem(q)", "insertQueueItemNow(q.id)", "removeQueueItem(q.id)"]) {
      expect(chat, `队列 UI 未提供 ${fn}`).toContain(fn);
    }
    // 黑话必须消失：界面上不许再出现这两个词（只在纯逻辑模块与其注释里保留）
    const ui = chat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(ui).not.toContain("即将插入");
    expect(ui).not.toContain("中途插入");
  });

  it("**渲染条件必须是「本会话有货」**，且面板内容真的落在这个条件里", () => {
    // ⚠️ 这条是 W1 变异逼出来的：只断言"文件里有 summarize(queueOfMine)"是**锁不到渲染的** ——
    //    把渲染条件改成 `{false && (` 时字符串还在，守卫照样绿（功能其实已经不见了）。
    //    所以必须按**片段**断言：从渲染条件起、到下一块（识图附件行）止，里面才有这些调用。
    const panel = segment(chat, "{queueOfMine.length > 0 && (", "{/* ── 识图：待发送图片附件行");
    expect(panel).toContain("summarize(queueOfMine)");
    expect(panel).toContain("queueOfMine.map(");
    expect(panel).toContain("removeQueueItem(q.id)");
    expect(panel).toContain("insertQueueItemNow(q.id)");
    expect(panel).toContain("editQueueItem(q)");
  });

  it("三处队列改动都走 syncQueue（唯一写入口），且**没有**绕过它直写 ref", () => {
    expect(chat).toContain("const syncQueue = React.useCallback");
    expect(chat).toContain("interruptQueueRef.current = next;");
    // 反空转：任何 `interruptQueueRef.current.push/splice/=` 的旁路写法都要挡掉
    // （只允许 syncQueue 内部那一次赋值；赋值语句以 `syncQueue(...)` 之外的形式出现即红）
    const direct = chat.match(/interruptQueueRef\.current\s*=[^=]/g) ?? [];
    expect(direct.length, `发现 ${direct.length} 处绕过 syncQueue 的直写`).toBe(1);
  });

  it("出队用 takeNext（会话隔离），不再用裸 shift()", () => {
    expect(chat).toContain("takeNext(interruptQueueRef.current");
    expect(chat).not.toContain("interruptQueueRef.current.shift()");
  });

  it("生成中也给得出「发送」按钮（否则鼠标用户无法插入指令，只能按回车）", () => {
    expect(chat).toContain("(input.trim() || pendingImages.length > 0) && (");
  });

  /* A-1056③：**「默认插入方式」这个全局开关已被撤掉**（连它的 localStorage 模块一起删）。
     用户原话："即将插入是什么鬼？" —— 那句话是我方的实现词，描述的却是"用户自己的话怎么发出去"，
     而且全局默认与"这一条我想马上发"的真实意图不匹配。
     新契约（守卫见 a1056-guards.spec.ts）：
       · Enter/发送按钮 → 一律**先排队不打断**（非破坏性的一侧是唯一默认）；
       · 想立刻发 → 点该条待发气泡卡片上的「直接插入」图标。 */
  it("旧的默认插入方式读写入口已彻底移除（模块 + 调用点都不许留）", () => {
    expect(chat).not.toContain("readInsertMode()");
    expect(chat).not.toContain("writeInsertMode(mode)");
    expect(chat).not.toContain("slime_insert_mode");
    // 模块文件本身也必须消失：`.ts` 与其**可能残留的编译影子 .js** 都不许在
    // （影子会让后续变异假绿 —— 见 mutation-harness §11⑦）。
    expect(existsSync(join(ROOT, "gui/src/renderer/insertModeToggle.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "gui/src/renderer/insertModeToggle.js"))).toBe(false);
  });
});

describe("A-1054④ / A-1056③ 默认插入行为：不打断是唯一默认", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");

  /* A-1056③ 之前，这里测的是「默认插入方式」的 localStorage 读写（未存过 → queue）。
     那个开关已被用户点名撤掉（"即将插入是什么鬼？"），模块随之删除；
     但**它当初立下的那条不变式依然是本次的规格**，所以在这里以"行为"而不是"读配置"的方式守住：
     没有配置项了，不打断就是唯一默认 —— 比原来更难被改坏。 */
  it("入队路径不再读任何'插入方式'配置：loading/stopping 时一律 enqueue（不打断）", () => {
    // 入队分支里必须出现 enqueue(...)，且**不得**出现 promote(...) 抢先 —— 抢先只允许来自
    // 用户的显式「直接插入」动作（insertQueueItemNow）。
    expect(chat).toContain("syncQueue(enqueue(interruptQueueRef.current, queued));");
    // 入队那一段（if (loading || stopping) { ... }）里不许有 promote
    const seg = chat.slice(chat.indexOf("if (loading || stopping) {"), chat.indexOf("if (loading || stopping) {") + 1600);
    expect(seg).not.toContain("promote(");
  });
});
