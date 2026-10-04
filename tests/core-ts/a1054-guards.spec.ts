












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


import { fmtTokens, pickTokenBase } from "../../gui/src/renderer/pages/contextMath.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}/${rel}`, "utf8");


function segment(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `源码里找不到片段起点：${from}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `源码里找不到片段终点：${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
}





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
    expect(f1.readyToOpen).toBe(false);                      
    expect(isOpenClass(true, f1.readyToOpen)).toBe(false);   
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
    


    expect(assistant).toContain("<ReasoningSection m={m} collapsed={collapsed} liveStream={liveStream} />");
  });
});





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

  




  it("两个家族的 context 经 fmtTokens 必须正好渲染成官方那个 K（本案 512K）", () => {
    for (const key of ["agnes", "note"]) {
      const cap = familyOf(key)?.context ?? 0;
      expect(cap, `${key} 的 context 没取到`).toBeGreaterThan(0);
      expect(fmtTokens(cap, cap), `${key} 渲染出的 K 不等于官方的 512K`).toBe("512K");
    }
  });

  





  it("★ 回归：524288 必须读作 512K（不是 524K）—— 事故的原始触发值", () => {
    expect(fmtTokens(524288, 524288)).toBe("512K");
  });

  




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






describe("A-1054④ 接线：底部状态行必须真的接到界面上", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");

  it("组件调用了 deriveLiveStatus（否则纯逻辑测试全绿、界面还是那两个死值）", () => {
    expect(chat).toContain("deriveLiveStatus({");
  });

  it("状态行的扫光**受 animated 控制**（不许无条件挂动画类：等用户时会假装还在跑）", () => {
    
    
    
    
    
    
    
    
    expect(chat).toMatch(/status\.animated \? "text-(scan-light|breathe)"/);
    
    expect(chat).not.toContain('className="text-scan-light thinking-hint-text"');
  });

  it("旧的死值三元式已被替换（否则状态行等于没做）", () => {
    
    
    expect(chat).not.toContain('toolEvents.length > 0 ? "🔧');
    expect(chat).not.toContain('"💭 思考中…") : PLACEHOLDER_PHRASES');
  });
});

describe("A-1054④ 接线：待发指令队列必须真的接到界面上", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");

  



  it("队列有渲染（面板块存在，且用 summarize + 用户气泡 + 三个操作入口）", () => {
    expect(chat).toContain("待发");
    expect(chat).toContain("summarize(queueOfMine)");
    
    expect(chat).toContain('borderRadius: "16px 16px 4px 16px"');
    for (const fn of ["editQueueItem(q)", "insertQueueItemNow(q.id)", "removeQueueItem(q.id)"]) {
      expect(chat, `队列 UI 未提供 ${fn}`).toContain(fn);
    }
    
    const ui = chat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(ui).not.toContain("即将插入");
    expect(ui).not.toContain("中途插入");
  });

  it("**渲染条件必须是「本会话有货」**，且面板内容真的落在这个条件里", () => {
    
    
    
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
    
    
    const direct = chat.match(/interruptQueueRef\.current\s*=[^=]/g) ?? [];
    expect(direct.length, `发现 ${direct.length} 处绕过 syncQueue 的直写`).toBe(1);
  });

  it("出队用 takeNext（会话隔离），不再用裸 shift()", () => {
    expect(chat).toContain("takeNext(interruptQueueRef.current");
    expect(chat).not.toContain("interruptQueueRef.current.shift()");
  });

  it("生成中也给得出「发送」按钮（否则鼠标用户无法插入指令，只能按回车）", () => {
    






    expect(chat).toContain("canSubmitSteer(input, pendingImages.length) && (");
    
    expect(chat).not.toContain("(input.trim() || pendingImages.length > 0) && (");
  });

  





  it("旧的默认插入方式读写入口已彻底移除（模块 + 调用点都不许留）", () => {
    expect(chat).not.toContain("readInsertMode()");
    expect(chat).not.toContain("writeInsertMode(mode)");
    expect(chat).not.toContain("slime_insert_mode");
    
    
    expect(existsSync(join(ROOT, "gui/src/renderer/insertModeToggle.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "gui/src/renderer/insertModeToggle.js"))).toBe(false);
  });
});

describe("A-1054④ / A-1056③ 默认插入行为：不打断是唯一默认", () => {
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");

  



  it("入队路径不再读任何'插入方式'配置：loading/stopping 时一律 enqueue（不打断）", () => {
    
    
    
    
    
    const at = chat.indexOf("if (loading || stopping) {");
    expect(at, "找不到入队分支").toBeGreaterThan(-1);
    const seg = chat.slice(at, at + 1600);
    expect(seg, "入队分支必须调 enqueue").toContain("syncQueue(enqueue(interruptQueueRef.current, {");
    expect(seg, "入队分支必须落在 queue 态（排队不直接发送）").toContain('mode: "queue"');
    expect(seg, "入队分支不许出现 promote 抢先").not.toContain("promote(");
    expect(seg, "入队分支不许顺手投递（否则「排队」这条语义再无出口）").not.toMatch(/chat\??\.steer\??\.\(/);
  });
});
