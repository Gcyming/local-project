























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatRescueHint,
  formatCannotFit,
  pickRescueModel,
  planSend,
  type CapCandidate,
} from "../../core-ts/src/services/context_loop.js";
import { rescueSwitchLabel, RESCUE_SWITCH_TITLE } from "../../gui/src/renderer/pages/streamErrors.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));


function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const mainSrc = stripComments(readFileSync(join(ROOT, "gui", "src", "main", "index.ts"), "utf8"));
const panelSrc = stripComments(readFileSync(join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx"), "utf8"));
const ipcSrc = readFileSync(join(ROOT, "gui", "src", "shared", "ipc.ts"), "utf8");
const streamErrSrc = stripComments(readFileSync(join(ROOT, "gui", "src", "renderer", "pages", "streamErrors.ts"), "utf8"));


const count = (src: string, needle: string): number => src.split(needle).length - 1;


const cand = (id: string, cap: number, choice?: string): CapCandidate =>
  choice === undefined ? { id, cap } : { id, cap, choice };

describe("A-1090 A. 可救模型必须自带「可直接写入的选择串」", () => {
  it("平手（同 cap）按 `choice ?? id` 排 —— 与调用方去重键**同源**", () => {
    


    const a = cand("a-model", 200_000, "api:zz:flat");
    const b = cand("b-model", 200_000, "api:aa:flat");
    expect(pickRescueModel(10_000, 1_000, [a, b])?.choice).toBe("api:aa:flat");
    
    expect(pickRescueModel(10_000, 1_000, [b, a])?.choice).toBe("api:aa:flat");
  });

  it("全无 `choice` 时仍按 `id` 字典序 —— 老调用方行为零变化", () => {
    const a = cand("bbb", 200_000);
    const b = cand("aaa", 200_000);
    expect(pickRescueModel(10_000, 1_000, [a, b])?.id).toBe("aaa");
    expect(pickRescueModel(10_000, 1_000, [b, a])?.id).toBe("aaa");
  });

  it("`choice` 只是**可选**字段：不带它照样能被挑中（不许把老输入判成非法）", () => {
    const picked = pickRescueModel(10_000, 1_000, [cand("only", 200_000)]);
    expect(picked?.id).toBe("only");
    expect(picked?.choice).toBeUndefined();
  });

  it("`choice` 不参与「装得下」的判据（cap 才是唯一依据）", () => {
    
    const chosen = pickRescueModel(300_000, 1_000, [
      cand("too-small", 100_000, "api:aaa:tiny"),
      cand("big-enough", 400_000, "api:zzz:huge"),
    ]);
    expect(chosen?.id).toBe("big-enough");
  });
});

describe("A-1090 B. 「没查」≠「查过没有」（三态不许合并）", () => {
  it("`undefined`（没人查）不许说「已查过」—— 本仓最直接的**假陈述**形态", () => {
    const txt = formatRescueHint(undefined);
    expect(txt, "「没查」被说成「查过没有」= 替一个没做过的检查背书").not.toContain("已查过");
    expect(txt, "必须如实说没检查").toContain("没有检查");
    
    expect(txt).toMatch(/换模型|模型选择器/);
  });

  it("`null`（查过、确实没有）必须如实说 —— 不许沉默", () => {
    const txt = formatRescueHint(null);
    expect(txt).toContain("已查过");
    expect(txt).toContain("没有");
    expect(txt).toMatch(/新会话/);
  });

  it("两态必须是**不同的**话（合并回去就是这条回归）", () => {
    expect(formatRescueHint(undefined)).not.toBe(formatRescueHint(null));
  });

  it("找到候选时不提「没查」也不提「没有」—— 只说结论 + 动作", () => {
    const txt = formatRescueHint({ id: "qwen-long", label: "Qwen Long", cap: 512_000 });
    expect(txt).toContain("512000");
    expect(txt).toMatch(/切到它/);
    expect(txt).not.toContain("已查过");
  });

  it("`formatCannotFit` 缺省调用（引擎侧保险门走的就是这条）说「没查」", () => {
    const plan = planSend({ estimatedInput: 200_000, cap: 100_000, canShrink: false });
    const txt = formatCannotFit(plan);
    expect(txt, "拒发文案里出现了「已查过」—— 引擎侧根本没查过模型清单").not.toContain("已查过");
    expect(txt).toContain("没有检查");
    expect(txt, "拒发文案本身的可操作性不许丢").toContain("没有把它发出去");
  });

  it("`formatCannotFit(plan, null)`（主进程查过没有）才走「已查过」", () => {
    const plan = planSend({ estimatedInput: 200_000, cap: 100_000, canShrink: false });
    expect(formatCannotFit(plan, null)).toContain("已查过");
  });
});

describe("A-1090 C. 主进程 `suggestWiderChatModel`：回带 choice + 「没查成」不算「没有」", () => {
  it("本地候选的 choice 是 `local:<id>`，供应商候选是 `api:<key>:<id>`（与渲染层模型选择器同源）", () => {
    expect(mainSrc, "本地候选没带可写入的选择串").toContain("const choice = `local:${m.id}`;");
    expect(mainSrc, "供应商候选没带可写入的选择串").toContain("key ? `api:${key}:${id}` : \"\"");
  });

  it("没有供应商 key 就**不能**登记该候选（拼不出可用串 ⇒ 宁可少一条出路，也不给一条点了没用的）", () => {
    

    expect(mainSrc, "缺 key 时仍然登记 ⇒ 切到一个不存在的模型（静默失败）")
      .toContain("if (!mid || !ch || c <= 0 || seen.has(ch)) { return; }");
    expect(mainSrc, "候选列表里没带选择串 ⇒ 渲染层永远拿不到 choice（按钮切不过去）")
      .toContain("cap: c, choice: ch });");
  });

  it("去重键是 `choice`（按裸 id 去重会吞掉另一供应商下的同名模型）", () => {
    const fn = mainSrc.slice(mainSrc.indexOf("async function suggestWiderChatModel"));
    expect(fn.length, "取不到函数体 —— 锚点漂移，守卫需同步更新").toBeGreaterThan(200);
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body, "去重键退回裸 id ⇒ 另一个供应商下的同名模型被整个吞掉").not.toContain("seen.has(mid)");
    expect(body).toContain("seen.add(ch);");
  });

  it("需求量未知 ⇒ `undefined`（那个 null 的语义是「不知道要多大」，不是「查过没有」）", () => {
    expect(mainSrc, "非有限/非正的需求量被当成「查过一轮、没有候选」⇒ 假陈述")
      .toContain("if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) { return undefined; }");
  });

  it("解析抛异常 ⇒ 也是 `undefined`（不许说成「查过没有候选」）", () => {
    const fn = mainSrc.slice(mainSrc.indexOf("async function suggestWiderChatModel"));
    const tail = fn.slice(0, fn.indexOf("\n}\n"));
    const catchBlock = tail.slice(tail.indexOf("catch (e)"));
    expect(catchBlock, "catch 分支仍返回 null ⇒ 解析失败被说成「查过没有」").not.toContain("return null;");
    expect(catchBlock, "catch 分支必须返回 undefined（= 没查成）").toContain("return undefined;");
  });

  it("两条「压无可压」路径都回带**结构化** `rescueModel`（只有文本时渲染层点不了）", () => {
    

    expect(count(mainSrc, "...(rescue ? { rescueModel: rescue } : {}),"), "拒发路径没回带结构化候选")
      .toBe(1);
    expect(count(mainSrc, "...(stillOverflow && rescue ? { rescueModel: rescue } : {}),"), "压完仍超限路径没回带结构化候选")
      .toBe(1);
  });
});

describe("A-1090 D. 渲染层接线：await 写盘 / 不留死横幅 / 文案唯一产地", () => {
  it("切模型必须 `await`（不 await ⇒ 主进程仍按旧模型算窗口 ⇒ 必然同样超限）", () => {
    expect(panelSrc, "没 await ⇒ 「点了按钮还是同一个错」，比不给按钮更伤")
      .toContain("await onModelChange?.(choice);");
  });

  it("`failReconnect` 必须 `keepBanner`（同一批 setState 后者胜 ⇒ 横幅永不显示）", () => {
    expect(panelSrc).toContain("resetStreamUI({ keepBanner: true });");
    expect(panelSrc, "复位函数没留出 keepBanner 口子").toContain("if (!opts?.keepBanner) { setStreamErrorBanner(null); }");
  });

  it("压缩结论把 `rescueModel` 一路回带（否则反应式路径拿不到按钮）", () => {
    expect(panelSrc).toContain("...(res?.rescueModel ? { rescueModel: res.rescueModel } : {}),");
    expect(panelSrc, "`CompressOutcome` 没声明 rescueModel ⇒ 赋值处静默丢字段")
      .toMatch(/type CompressOutcome = \{[^}]*rescueModel\?: RescueModel;/);
  });

  it("按钮文案取自**唯一产地**（组件里不许内联「切到…」字面量）", () => {
    expect(panelSrc).toContain("{rescueSwitchLabel(rescueAction.model)}");
    expect(panelSrc, "组件里又手拼了一份按钮文案 ⇒ 改一处漂移一处（文案与动作说反话的温床）")
      .not.toContain("并继续本轮");
    
    expect(panelSrc).toContain("title={RESCUE_SWITCH_TITLE}");
  });

  it("点击动作必须接到处理器上，且处理器不许往输入框回填（会覆盖用户正在写的内容）", () => {
    expect(panelSrc).toContain("void handleRescueSwitch();");
    const fn = panelSrc.slice(panelSrc.indexOf("async function handleRescueSwitch"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    expect(body.length, "取不到处理器函数体 —— 锚点漂移，守卫需同步更新").toBeGreaterThan(200);
    expect(body, "处理器去写输入框 = 有覆盖用户草稿的风险").not.toMatch(/setInput\(/);
    expect(body, "续的是本轮，不是重发用户消息（用户消息已落库，再发会重复）")
      .toContain("api.chat.stream({ ...req, resumeHint: buildResumeHint() })");
  });

  it("跨进程契约把结构化模型透出去（与 core-ts 的 `RescuableModel` 同源，不手抄形状）", () => {
    expect(ipcSrc).toContain("rescueModel?: RescuableModel;");
    expect(ipcSrc, "形状被手抄了一份 ⇒ 主进程加字段时渲染层静默少用一个字段")
      .toContain("import type { RescuableModel } from \"../../../core-ts/src/services/context_loop.js\";");
  });

  it("`rescueSwitchLabel` 由 streamErrors 导出（唯一产地）", () => {
    expect(count(streamErrSrc, "export function rescueSwitchLabel")).toBe(1);
  });
});

describe("A-1090 E. 按钮文案与动作必须同源（说反话是 A-1062 那一族）", () => {
  it("含模型名与窗口数（用户要的是「切到哪个」，不是原则）", () => {
    const txt = rescueSwitchLabel({ id: "qwen-long", label: "Qwen Long", cap: 512_000 });
    expect(txt).toContain("Qwen Long");
    expect(txt).toContain("512000");
  });

  it("label 与 id 相同时不重复写两遍", () => {
    expect(rescueSwitchLabel({ id: "qwen-long", label: "qwen-long", cap: 200_000 }))
      .toBe(rescueSwitchLabel({ id: "qwen-long", cap: 200_000 }));
  });

  it("窗口数缺失/非法时不留空括号（坏数据不该印出「（）」）", () => {
    const txt = rescueSwitchLabel({ id: "m", cap: 0 });
    expect(txt).not.toContain("（）");
    expect(txt).not.toContain("(");
  });

  it("说「继续」**不说「重发」** —— 动作续的是被打断的那一轮，用户消息不会重复", () => {
    const txt = rescueSwitchLabel({ id: "m", cap: 1000 });
    expect(txt).toContain("继续");
    expect(txt, "说「重发」= 与真实动作说反话（用户会以为自己的消息要再发一遍）").not.toContain("重发");
    expect(RESCUE_SWITCH_TITLE, "悬停说明必须点明「不会重复发送」").toContain("不会重复发送");
    expect(RESCUE_SWITCH_TITLE, "悬停说明必须点明输入框不被动").toContain("输入框");
  });
});
