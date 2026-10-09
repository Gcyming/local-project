/**
 * tests/core-ts/a1197-silam-off.spec.ts — 「silam 自研模型下线」的守卫
 *
 * ## 要防的缺陷（为什么必须下线，而不是继续藏着）
 *   sidecar 能跑（依赖齐、权重在、6秒拉起），但**模型层有病**，且病在管道层治不了：
 *     · 语言脑是 6922 词表 d16 线性模型、无训练支撑 ⇒ 16/16 轮压测全是乱码；
 *       而 sidecar 的退化阀 _degenerate（silam_brain_sidecar.py:66-80）**全部放行**。
 *     · 截断是硬切：lang_core.py:429 的 `for _step in range(max_len)`，
 *       sidecar:157-160 传 max_len=128 ⇒ 16 轮里 14 轮精确 138 字。
 *   用户已授权「修不了就暂时去除，留占位」⇒ 本轮下线，资产全留。
 *
 * ## 最要紧的一条：4 处「无可路由模型时的 siliam 兑底」
 *   旧实现在用户没配任何模型时，让 SILAM 离线大脑接管应答（model="silam-brain"）。
 *   ⇒ 没配模型的用户收到的是**一堆乱码**，而不是一句清楚的话。
 *   这4 处（chat 2 处 + stream 2 处）必须全部换掉，且 `model` 字段要如实为 "none"。
 *
 * ## 断言分六组
 *   A. 开关已断，但整段与占位保留
 *   B. 4 处兑底不再返回 siliam 内容（model 字段尤其不能是 "silam-brain"）
 *   C. 占位文案如实（不吹「即将/敬请期待」，也不假装是模型回答）
 *   D. 入口门控（下拉条目不再无条件可见）
 *   E. _onStdout 不再静默 continue（项目铁律：静默失效必须出声）
 *   F. slime_memory 已转发（加载了却没发出去 = 契约半截）
 *
 * ⚠️ 词边界（本文件踩过的坑，改断言前先读）：
 *   ① **注释必须先剥掉再做代码形状断言**。本轮第一版就栽在这：源码注释里写着
 *      「model="silam-brain"」（解释历史缺陷），结果 `not.toMatch(/model\s*=\s*"silam-brain"/)`
 *      被注释里的历史说明命中 ⇒ 假红。⇒ 代码断言一律走 stripCode()，只有
 *      「注释里必须留X 依据」这类断言（E4）才用原文。
 *   ② 判「旧兑底已消失」用**带边界的正则**（`model` 前后不许有别的标识符字符），
 *      不能只搜 `silam-brain` 三个字 —— 换个键名照样是同一个缺陷。
 *   ③ 项目前科：`markPluginDisabled` 被 `unmarkPluginDisabled` 假命中。
 *      下拉门控那一条要求条目本体与门控条件**相邻出现**，各自出现不算。
 *   ④ 反向断言只判短词等于没判（「未接线」是「尚未接线」的子串）。
 *      判「不吹」用整族正则：即将 / 敬请期待 / 马上就好 / 很快就。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 统一行尾，避免 CRLF 影响跨行正则。 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

/**
 * 剥掉注释，只留代码 —— 代码形状断言必须用它（见文件头①）。
 * 简单但对 TS 足够：字符串字面量里的 `//` 极少（本文件断言的代码里没有）。
 */
function stripCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

const ENGINE_RAW = read("core-ts/src/services/engine.ts");
const ENGINE = stripCode(ENGINE_RAW);
const SILAM_RAW = read("core-ts/src/services/silam_brain.ts");
const SILAM_BRAIN = stripCode(SILAM_RAW);
const CHATPANEL_RAW = read("gui/src/renderer/pages/ChatPanel.tsx");
const CHATPANEL = stripCode(CHATPANEL_RAW);
const APP_RAW = read("gui/src/renderer/App.tsx");
const APP = stripCode(APP_RAW);
const NEWPROJ = stripCode(read("gui/src/renderer/pages/NewProjectDialog.tsx"));
const PLUGINS = stripCode(read("core-ts/src/plugin/builtin-plugins.ts"));
const TOML = read("slime.toml");

/** 取出 slime.toml 的 [silam] 段正文（到下一个段头为止）。 */
function sahamSection(): string {
  const m = TOML.match(/^\[silam\][\s\S]*?(?=^\[|\Z)/m);
  return m ? m[0] : "";
}

describe("A-1197 A 开关：slime.toml [silam] 已下线，但整段与占位保留", () => {
  it("A1 [silam] 段的 enabled 与 as_brain 都必须是 false", () => {
    const sec = sahamSection();
    expect(sec).not.toBe("");
    expect(sec).toMatch(/^enabled\s*=\s*false\s*(#.*)?$/m);
    /* ⚠️ 两个键都要钉死：只判 enabled 的话，把 as_brain 改回 true（重新启用兜底）
       而enabled 仍为 false 时，断言照样绿 —— 而那正是本轮要拆掉的路径。 */
    expect(sec).toMatch(/^as_brain\s*=\s*false\s*(#.*)?$/m);
    // 整段不许被删：其余键仍在
    expect(sec).toContain("agent_id");
    expect(sec).toContain("backbone_path");
  });

  it("A2 占位说明必须写清关闭原因与将来自研要接的契约", () => {
    const sec = sahamSection();
    const lead = TOML.slice(0, TOML.indexOf("[silam]"));
    // 说清是质量下线，不是「临时维护」
    expect(lead).toMatch(/下线|关闭/);
    expect(lead + sec).toMatch(/乱码|截断/);
    // 点到将来自研要接的契约位置
    expect(lead + sec).toContain("silam_brain_sidecar.py");
    expect(lead + sec).toMatch(/SilamBrain/);
    // 不吹
    expect(lead + sec).not.toMatch(/(即将|敬请期待|马上就好|即将支持|很快就)/);
  });

  it("A3 保留资产不许被删", () => {
    for (const rel of [
      "core-ts/src/services/silam_brain.ts",
      "sidecar/silam_brain_sidecar.py",
    ]) {
      expect(existsSync(join(ROOT, rel)), `${rel} 属保留资产，不许被删`).toBe(true);
    }
    /* ⚠️ 词边界（前科：markPluginDisabled 被 unmarkPluginDisabled 假命中）：
     * 只判 "export interface SilamBrain" 的话，把接口改名成
     * SilamBrainRemovedByMutation 后它仍是子串 ⇒ 假绿（M13 曾存活）。
     * ⇒ 名字后面必须**紧跟**一个「{」，那才是「接口还在」的真判据。 */
    expect(SILAM_BRAIN).toMatch(/export interface SilamBrain\s*\{/);
    expect(SILAM_BRAIN).toMatch(/class SilamBrainClient\b/);
    // 类型引用处也还在用真名：实现类implements 这个接口（改名会把它变成悬空类型）
    expect(SILAM_BRAIN).toMatch(/implements\s+SilamBrain\s*\{/);
  });
});

describe("A-1197 B 4 处兑底：不再返回 siliam 内容（最要紧）", () => {
  it("B1 model 字段不得再出现 siliam-brain（带词边界）", () => {
    expect(ENGINE).not.toMatch(/(?<![A-Za-z0-9_-])model\s*:\s*"silam-brain"/);
    expect(ENGINE).not.toMatch(/(?<![A-Za-z0-9_-])model\s*=\s*"silam-brain"/);
    /* WARNING 这里**不能**粗暴断言 "silam-brain" 这个词在代码里彻底消失：
     * engine.ts:486 还有一处合法留存 —— modelId === "silam-brain" 是**用量记录跳过条件**
     * （不是这个模型就不记 token 用量）。删了它反而会往统计里灌一个不存在模型的用量。
     * => 只钉死它不得作为「响应的 model 名」出现，那才是兑底路径。 */
    expect(ENGINE).not.toMatch(/(?<![A-Za-z0-9_-])(replyRaw|reply|model)\s*[:=]\s*"silam-brain"/);
  });

  it("B2 无路由兑底走 noModelRouteText（定义 1 + chat/stream 调用 2）", () => {
    expect((ENGINE.match(/noModelRouteText\(/g) ?? []).length).toBe(3);
    expect(ENGINE).toContain("private noModelRouteText(agent: AgentState, error: string | null): string {");
  });

  it("B3 显式选 siliam 的分支改用占位文案", () => {
    expect(ENGINE).not.toContain("this.silamUnavailableText(");
    expect((ENGINE.match(/this\.silamPlaceholderText\(/g) ?? []).length).toBe(2);
    expect(ENGINE).toContain("private silamPlaceholderText(agent: AgentState): string {");
  });

  it("B4 chat 的 !router 兑底：model 如实为 none", () => {
    /* ⚠️ 锚点从 const reply 那行起算：若从 `if (!router)` 起算，正则会一路贪到
     * stream 那段去（chat 的块里没有 model 键），把 stream 的 model:"silam" 一并吃进来。 */
    const block = ENGINE.match(
      /const reply = this\.noModelRouteText\(opts\.agent, error\);\n      return \{[\s\S]*?\n      \};/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/(?<![A-Za-z0-9_-])model\s*:\s*"none"/);
    expect(block![0]).not.toMatch(/model\s*:\s*"silam/);
  });

  it("B5 stream 的 !router 兑底：model 如实为 none", () => {
    const block = ENGINE.match(
      /const reply = this\.noModelRouteText\(opts\.agent, error\);\n      yield \{ type: "done"[\s\S]*?return;/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/(?<![A-Za-z0-9_-])model\s*:\s*"none"/);
    expect(block![0]).not.toMatch(/model\s*:\s*"silam/);
    // stream 侧不得再凭空造一个 reasoning帧去转述「由 SILAM 兜底」
    expect(block![0]).not.toContain('type: "reasoning"');
  });

  it("B6 兑底文案如实：说清没有可用模型 + 去哪里配，且不假装是模型回答", () => {
    const m = ENGINE.match(/private noModelRouteText\([\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    const text = m![0];
    expect(text).toContain("不是模型回答");
    expect(text).toMatch(/没有可用模型/);
    expect(text).toMatch(/供应商/);
    expect(text).toMatch(/本地模型/);
    expect(text).not.toMatch(/(即将|敬请期待|马上就好|即将支持|很快就)/);
  });

  it("B7 不得再宣称「兜底应答/ 保底应答」", () => {
    expect(ENGINE).not.toMatch(/兜底应答|保底应答/);
    //随兑底一起失效的 fallbackNotice 必须真的删掉（留着一个没人调的私有方法
    // 在 noUnusedLocals 下就是编译错，且它本身就是「还能兜底」的错觉）
    expect(ENGINE).not.toContain("fallbackNotice");
    // 同理：defaultReply 链（旧兜底文案）不许留成死代码
    expect(ENGINE).not.toContain("defaultReply");
  });
});

describe("A-1197 C 占位文案：说清现状，不吹", () => {
  it("C1 显式选 siliam 的占位文案必须如实", () => {
    const m = ENGINE.match(/private silamPlaceholderText\([\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    const text = m![0];
    // 说清现状：下线 + 未启用
    expect(text).toMatch(/下线|未启用/);
    // 给出将来自研模型要接的契约位置
    expect(text).toContain("[silam]");
    expect(text).toContain("silam_brain_sidecar.py");
    expect(text).toContain("SilamBrain");
    // 不吹
    expect(text).not.toMatch(/(即将|敬请期待|马上就好|即将支持|很快|下个版本)/);
    // 不保留旧的「请检查 enabled=true」式指引 —— 那会教用户去打开一个已知有病的开关
    expect(text).not.toContain("需 enabled=true");
  });
});

describe("A-1197 D 入口门控：下拉条目不再无条件可见", () => {
  it("D1 ChatPanel 模型下拉里的 siliam 条目必须受 siliamOk 门控", () => {
    /* ⚠️ 前科：`markPluginDisabled` 被 `unmarkPluginDisabled` 假命中。
     * 这里要求门控条件与条目本体**紧邻**（三元 + 紧跟的 options 元素），
     * 各自出现在文件不同地方不算通过。 */
    expect(CHATPANEL).toMatch(
      /\.\.\.\(silamOk\s*\?\s*\[\{ value: "silam", label: "silam", group: "内置"/,
    );
    // 且不得再有「无条件」的同一条目
    expect(CHATPANEL).not.toMatch(/^\s*\{ value: "silam", label: "silam", group: "内置",/m);
  });

  it("D2 ChatPanel 的 siliamOk 必须真的来自 siliam status", () => {
    expect(CHATPANEL).toMatch(/const \[silamOk, setSilamOk\] = React\.useState\(false\)/);
    expect(CHATPANEL).toMatch(/silam\?\.status\?\.\(\)/);
    expect(CHATPANEL).toMatch(/setSilamOk\(r\?\.enabled === true\)/);
    // 失败路径必须落到 false（静默失败也要有明确状态）
    expect(CHATPANEL).toMatch(/\.catch\(\(\) => \{ if \(!dead\) setSilamOk\(false\); \}\)/);
  });

  it("D3 其余入口降级为「实验中/占位」，仍以 status 为准", () => {
    // App.tsx：条目保留（不删），但标签不再宣称能兜底
    expect(APP).toMatch(/if \(silamOk\) \{[\s\S]{0,400}?kind: "silam"/);
    expect(APP).toMatch(/SILAM 自研（实验中）/);
    expect(APP).not.toMatch(/情感脑\+语言脑兜底/);
    // status 查询保留（自研接回来后自动恢复显示的「唯一如实产地」）
    expect(APP).toContain("refreshSilamStatus");
    expect(APP).toMatch(/setSilamOk\(r\.enabled === true\)/);
    // 插件登记降级为实验中/占位
    expect(PLUGINS).toMatch(/name: "silam",[\s\S]{0,600}?实验中/);
    // NewProjectDialog 仍是「不可用即归 null」的门控语义
    expect(NEWPROJ).toMatch(/choice === "silam"[\s\S]{0,80}?silamOk \? "silam" : null/);
  });
});

describe("A-1197 E _onStdout 不再静默失效（静默必须出声）", () => {
  it("E1 parse 失败不得再是裸 continue（必须出声）", () => {
    const body = SILAM_BRAIN.match(/private _onStdout\([\s\S]*?\n  \}/)![0];
    // 旧的静默形态不在了
    expect(body).not.toMatch(/\}\s*catch\s*\{\s*\n\s*continue;\s*\n\s*\}/);
    // catch 分支里必须有 warn
    expect(body).toMatch(/catch\s*\{[\s\S]*?console\.warn/);
  });

  it("E2 无 request_id 的 JSON 行也不得再是裸 continue", () => {
    const body = SILAM_BRAIN.match(/private _onStdout\([\s\S]*?\n  \}/)![0];
    expect(body).not.toMatch(/const rid = msg\.request_id;\s*\n\s*if \(!rid\) continue;/);
    expect(body).toMatch(/if \(!rid\) \{[\s\S]{0,300}?console\.warn/);
  });

  it("E3 出声不得打断正常帧解析（只 warn，不 throw；解析成功分支照旧）", () => {
    const body = SILAM_BRAIN.match(/private _onStdout\([\s\S]*?\n  \}/)![0];
    expect(body).toContain("entry.resolve(msg.payload ?? {})");
    expect(body).toContain("entry.reject(new Error(");
    // throw 会打断整个 stdout 流 —— 出声只能用 warn
    expect(body).not.toMatch(/throw\s+new\s+Error\(/);
    // 且 while 循环仍在逐行消费
    expect(body).toContain('this.buf.indexOf("\\n")');
  });

  it("E4 已知事实：stdout混着非 JSON 行（不得逐行刷屏）", () => {
    const body = SILAM_BRAIN.match(/private _onStdout\([\s\S]*?\n  \}/)![0];
    /* 逐行 warn 的判据必须**锚在 else 分支上**（第一版栽在这）：
     * 只判 _onStdout 全体里出现 noiseLines 是不够的—— 汇总块与字段声明里本来就有它，
     * 于是「把裸 print 分支改成每行 console.warn」也能判绿（M11 存活）。 */
    const elseBranch = body.match(
      /else \{\n([\s\S]*?)\n\s*\}/,
    );
    expect(elseBranch).not.toBeNull();
    // 裸 print 分支：计数，不逐行 warn
    expect(elseBranch![1]).toMatch(/noiseLines \+= 1/);
    expect(elseBranch![1]).not.toContain("console.warn");
    // 汇总出声只报一次
    expect(body).toMatch(/noiseReported/);
    // 区分「以 { 开头却解析失败」（真故障，逐条 warn）与「裸 print 噪声」（计数）
    expect(body).toMatch(/startsWith\("\{"\)/);
    /* 这条断言看的是**注释**（须用原文）：代码里不该硬写sidecar 文件名，
     * 但注释必须留着这条已知事实的依据，否则后人会把裸 print 当故障来「修」。 */
    const doc = SILAM_RAW.match(/\/\* A-1197：原先这里是两处裸[\s\S]*?\*\//);
    expect(doc).not.toBeNull();
    expect(doc![0]).toMatch(/backbone\.py/);
    expect(doc![0]).toMatch(/lang_core\.py/);
  });
});

describe("A-1197 F slime_memory 真正转发给了 sidecar", () => {
  it("F1 reply 请求体必须带 slime_memory（加载了却没发出去 = 契约半截）", () => {
    const m = SILAM_BRAIN.match(/async reply\([\s\S]*?queueRequest\("reply", \{[\s\S]*?\}\)\)/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/slime_memory/);
    /* ⚠️ 词边界：`slimeMemory` 是 TS 侧字段名，`slime_memory` 才是 JSON 协议键。
     * 只判前者会被「读了 opts.slimeMemory 却没放进 payload」骗过 —— 那正是原缺陷。 */
  });

  it("F2 契约名与 sidecar 等待的字段一致（资产侧不许单边改）", () => {
    const sidecar = read("sidecar/silam_brain_sidecar.py");
    expect(sidecar).toContain('payload.get("slime_memory")');
    // TS 侧接口仍声明该字段（契约不撤）
    expect(SILAM_BRAIN).toMatch(/slimeMemory\?: string\[\]/);
    // engine.ts 侧仍在加载记忆
    expect(ENGINE).toMatch(/slimeMemory/);
  });
});
