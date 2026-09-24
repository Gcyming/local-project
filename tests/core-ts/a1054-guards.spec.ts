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
/* A-1087 迁移：上下文 K 的显示判据已收口到 contextMath 的 fmtTokens / pickTokenBase ——
 * 本节 ③ 的"显示层"那两条必须调**真函数**，不许在这里自己写一遍 n/1000 之类的近似。 */
import { fmtTokens, pickTokenBase } from "../../gui/src/renderer/pages/contextMath.js";

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
 * ③ Agnes / 小红书 上下文口径（**两层**：表内值 + 它渲染出来的 K）
 *
 * A-1087 迁移说明：本节原来是「十进制 K（÷1000）必须与官方 K 一致」，判据挂在
 * `context / 1000 === 512` 上。A-1087 把显示层改成**按上限自适进制**后，÷1000 不再是
 * 全项目口径（它会把 524288 读成 524K）—— 那条判据的**判据家**搬到了
 * `gui/src/renderer/pages/contextMath.ts` 的 `pickTokenBase` / `fmtTokens`。
 * 这里保留两层：① 表内值（不改数值的约定）；② **用户看得见的那一层** ——
 * 表内值经显示函数必须正好渲染成官方标注的 K（这才是 A-1054 当初真正想守的东西）。
 * ══════════════════════════════════════════════════════════════════ */

describe("A-1054③ 上下文口径：表内值 + 它渲染出的 K 都必须等于官方标注", () => {
  const familyOf = (key: string) => MODEL_CAPABILITIES.find((v) => v.key === key);

  it("agnes 家族 = 512000（A-1054 的数值约定；⚠️ 显示层现在两种进制都读 512K，见下一条）", () => {
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

  /**
   * ② 用户看得见的那一层（A-1087 新增）。判据挂在**显示函数**上，而不是某个数字口径：
   * 官方标「512K」而界面显示别的数，就是 A-1054 那起事故的形态。
   * 这条同时守住"表内值被改成非整数 K 的数"（如 512100 → 渲染成别的写法）。
   */
  it("两个家族的 context 经 fmtTokens 必须正好渲染成官方那个 K（本案 512K）", () => {
    for (const key of ["agnes", "note"]) {
      const cap = familyOf(key)?.context ?? 0;
      expect(cap, `${key} 的 context 没取到`).toBeGreaterThan(0);
      expect(fmtTokens(cap, cap), `${key} 渲染出的 K 不等于官方的 512K`).toBe("512K");
    }
  });

  /**
   * ③ 回归钉子（A-1087）：**这次事故的原始触发值**。`config/global_config.json` 里用户自己
   * 写的是 2^19，右栏上限就取它 —— 旧实现 `fmtK(n)=n/1000` 把它印成「524K」，
   * 而厂商文档写 512K（用户原话：「没有 524K 容量的上下文，只有 512K」）。
   * ⚠️ 这条**不能只用 `512000` 测**：512000 在两个进制下都是整数 512，恰好绕过了差异。
   */
  it("★ 回归：524288 必须读作 512K（不是 524K）—— 事故的原始触发值", () => {
    expect(fmtTokens(524288, 524288)).toBe("512K");
  });

  /**
   * ④ 另一半（A-1087）：**进制不许全局写死**。把显示层"干脆统一成 ÷1024"是同一个错误的镜像 ——
   * 它会把这些厂商自己写的十进制 K 印成文档里查不到的数（128000 → 125K）。
   * 判据必须"按上限反推"，而不是"选一个进制全站硬套"。
   */
  it("★ 回归：十进制口径的上限必须仍读作厂商写法（128K / 200K，不许变 125K / 195K）", () => {
    expect(pickTokenBase(128000)).toBe(1000);
    expect(fmtTokens(128000, 128000), "gpt-4o 的 128K 被二进制口径印成了 125K").toBe("128K");
    expect(fmtTokens(200000, 200000), "claude 的 200K 被二进制口径印成了别的数").toBe("200K");
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

  it("状态行的扫光**受 animated 控制**（不许无条件挂动画类：等用户时会假装还在跑）", () => {
    // A-1056②：状态行从底部监测栏搬到 Agent 输出最下方，渲染者变成 `LiveStatusLine`
    // （props 名由 liveStatus 变 status），但这条不变式原样保留：动画只由 animated 决定。
    //
    // A-1092 迁移：承载动画的类从 `text-scan-light` 换成 `text-breathe` ——
    //   `text-scan-light` 是 `background-clip:text + -webkit-text-fill-color:transparent`
    //   （光带定位靠 background-position），在窄元素上光带会整段移出文字区 ⇒ 文字全透明。
    //   `text-breathe` 走 opacity 呼吸，文字**恒为实体**。守卫意图（条件门控、不许无条件挂）
    //   不变，只是不再绑死具体类名 —— 否则每次换动画实现都要来改这条守卫。
    expect(chat).toMatch(/status\.animated \? "text-(scan-light|breathe)"/);
    // 反空转：不许出现"直接给状态文案挂扫描动画"的写法
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
    /* A-1062 **迁移**（不删）：判据从内联 `(input.trim() || pendingImages.length > 0)`
       搬到纯模块 `insertCopy.canSubmitSteer` —— 语义等价（"有文字或有图才给按钮"），
       但从此与输入框 placeholder / 发送按钮 title 同源，且能喂真值表。
       本意（有内容才给按钮）逐字保留，故这里只把判据**搬到新家**：
         · 新判据在这条断言（接线）；
         · 真值表在 `tests/gui/insert-copy.spec.ts`；
         · 弄红它的是 `mut-a1062-insertcopy` M4（纯空格也能提交）。 */
    expect(chat).toContain("canSubmitSteer(input, pendingImages.length) && (");
    // 旧内联写法必须绝迹：留着就说明"能不能发"有两个产地，必然漂移
    expect(chat).not.toContain("(input.trim() || pendingImages.length > 0) && (");
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
    // A-1062 迁移：入队从「先算 queued 局部量再 enqueue」改成「对象字面量内联」，
    // 旧锚点 `syncQueue(enqueue(interruptQueueRef.current, queued));` 已失配 ——
    // 改按**入队分支内部**断言（同一意图：这一支只排队、不抢先、也不投递）。
    const at = chat.indexOf("if (loading || stopping) {");
    expect(at, "找不到入队分支").toBeGreaterThan(-1);
    const seg = chat.slice(at, at + 1600);
    expect(seg, "入队分支必须调 enqueue").toContain("syncQueue(enqueue(interruptQueueRef.current, {");
    expect(seg, "入队分支必须落在 queue 态（排队不直接发送）").toContain('mode: "queue"');
    expect(seg, "入队分支不许出现 promote 抢先").not.toContain("promote(");
    expect(seg, "入队分支不许顺手投递（否则「排队」这条语义再无出口）").not.toMatch(/chat\??\.steer\??\.\(/);
  });
});
