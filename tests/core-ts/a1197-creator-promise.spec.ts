/**
 * tests/core-ts/a1197-creator-promise.spec.ts — 创造模式导引「不许瞎承诺工具能力」的守卫
 *
 * ## 要防的缺陷（与 A-1196 selfAwarenessGuide 同一族）
 *   A-1196 修的是「Agent 不知道自己有什么能力，于是瞎猜/瞎承诺」。
 *   本轮修的是**导引自己教它瞎承诺**：creatorGuide 的 provides 字段要点写着
 *   「本模式写 ["instructions"]；将来要贡献工具再加 tools」——
 *   而事实上 GUI 侧 createPluginHost 的 registerTools 是 `() => []`（空实现），
 *   写 `provides: ["tools"]` **不会真的多出任何工具**，宿主只会如实记「尚未接线」。
 *   ⇒ 导引把「未接线的能力」说成「将来加上就有」，等于教它做出无法兑现的承诺。
 *
 * ## 修法（与 selfAwarenessGuide 同口径）
 *   如实说明现状（只真正生效 instructions）→ 明说不要因为写了字段就宣称多了工具 →
 *   给出正确做法（如实告诉用户去哪里调整，不要假装已具备）。
 *
 * ## 断言分五类
 *   A. 旧的错误承诺表述已被彻底移除（含「以后/后续…就能加工具」这一族的变体）
 *   B. 必须明说工具贡献当前未接线（且不得反向吹「已经接线」）
 *   C. 必须明说「不要因为写了字段就宣称多了工具能力」
 *   D. 必须给出正确做法（如实告诉用户去哪里调整）
 *   E. 回归保护：origin=agent / 禁写 builtin / 自验四步 / loop_config 不许被改坏
 *
 * ⚠️ 词边界（项目前科：`markPluginDisabled` 被 `unmarkPluginDisabled` 假命中）：
 *   ① 判「旧承诺已移除」用**正则族 + 负向语义**，而不是只搜那一句原文 ——
 *      否则把文案换成「以后加 tools 就有工具」就绕过去了；
 *   ② 判「未接线」这类短词时，「未接线」是「尚未接线」的**子串**，只断言短词等于没断言 ——
 *      所以正向断言用长的那句整句，反向断言才用带边界的短词。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  creatorGuide,
  skillsRootDir,
  selfAwarenessGuide,
  DEFAULT_TOOL_PROFILE,
} from "../../core-ts/src/services/agentTools.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = readFileSync(join(ROOT, "core-ts", "src", "services", "agentTools.ts"), "utf8").replace(/\r\n/g, "\n");

const GUIDE = creatorGuide(skillsRootDir());

describe("A-1197④ 创造模式导引：工具贡献当前未接线，必须如实说", () => {
  it("A 旧的错误承诺必须消失：不得出现「将来要贡献工具再加 tools」及其变体", () => {
    // 逐字判据（原文那一句）
    expect(GUIDE).not.toContain("将来要贡献工具再加");
    /* ⚠️ 词边界：不能只判上面那一句 —— 换个说法（「以后加 tools 就有工具」）同样会教它瞎承诺。
       这里判的是**整族语义**：「将来/以后/后续/等有空」+ 20 字内出现 tools/工具 + 紧跟生效类动词。 */
    expect(GUIDE).not.toMatch(/(将来|以后|后续|将来再|等有空)[^。\n]{0,24}(tools|工具)[^。\n]{0,16}(生效|可用|能用|注册|就有)/);
    /* 「未接线」是「尚未接线」的子串 —— 断言短词等于没断言。正向断言交由下一组的长句做。 */
    expect(GUIDE).not.toMatch(/(?<!尚未)(?<!还没)接线/);
    expect(GUIDE).not.toContain("将来");
  });

  it("B 必须明说 provides 的合法取值（四个、含 mode），且保守写法（只贡献指令只写 instructions）仍在", () => {
    /* A-1198 同步（2026-10-08，B3 落地后）：合法值从三个扩到四个（加了 `mode`）。
       判据同时钉住**数目**与**每个取值** —— 只数个数会被等量替换绕过（如 tools↔mode 互换），
       只列取值又会漏掉「说三个」这种过期表述。 */
    expect(GUIDE).toMatch(/合法值只有\s*`instructions`\s*\/\s*`tools`\s*\/\s*`prompt`\s*\/\s*`mode`\s*四个/);
    for (const legal of ["instructions", "tools", "prompt", "mode"]) {
      expect(GUIDE, `provides 合法值漏了 ${legal}`).toContain(legal);
    }
    // 保守写法仍在：只贡献指令时就只写 instructions（mode 是「要额外贡献」才加）
    expect(GUIDE).toContain("**只贡献指令时只写 `instructions`**");
    // 最小模板本身必须还是只声明 instructions（导引不能自己打脸）
    expect(GUIDE).toContain('"provides": ["instructions"]');
  });

  it("B 必须明说工具贡献未接线、不会真的多出工具（用整句做正向断言）", () => {
    // ⚠️ 用整句而不是「未接线」三个字：「未接线」是「尚未接线」的子串，短词断言会被更长/更短的写法绕过。
    expect(GUIDE).toContain("装载后插件清单里那一项只会显示「尚未接线」，**不会真的多出任何工具**。");
    expect(GUIDE).toMatch(/写 `tools` 或 `prompt` \*\*不会被拒绝，但也不会生效\*\*/);
    /* 反向守卫：不得出现任何「已经接线」式的反向吹牛（比缺失更坏：错的承诺）。 */
    expect(GUIDE).not.toMatch(/(已经|已|均已)接线|接线完成|接好了/);
  });

  it("C 必须明说不要因为写了字段就宣称自己多了工具能力", () => {
    expect(GUIDE).toContain("**不要因为清单里写了某个字段，就宣称自己多了工具能力**");
    expect(GUIDE).toContain("那是无法兑现的承诺");
  });

  it("D 需要新工具时必须给出正确做法（两条真路径 + 如实告诉用户，不许含糊承诺）", () => {
    /* ⚠️ A-1198 同步（2026-10-08，B4 落地后）：原文「插件目前只能贡献指令（技能）」
       已**不成立**（`contributes.scripts` 能装配出真工具）—— 继续钉它等于逼导引说假话。
       迁移后钉的是两条真路径，**语义更强**（旧的错误口径另配反向断言防回潮）：
       ① 脚本工具走 `contributes.scripts`；② 否则引导用户去调工具配置 / MCP。 */
    expect(GUIDE).toContain("确实需要新工具时");
    expect(GUIDE).toContain("如实告诉用户两条路");
    expect(GUIDE).toContain("contributes.scripts");
    expect(GUIDE).toContain("设置 → Agent 管理");
    expect(GUIDE).toContain("不要假装已具备");
    // 旧口径不许回潮：它把「脚本工具」这条真路径说成不存在
    expect(GUIDE).not.toContain("插件目前只能贡献指令");
    // 与 selfAwarenessGuide 同口径：含糊承诺 / 假装具备 两句话都不许出现在导引里
    expect(GUIDE).not.toContain("含糊承诺");
  });
});

describe("A-1197④ 口径一致性：事实只在创造模式导引里说，且与 selfAwarenessGuide 同调", () => {
  it("「未接线」这个事实属于创造模式导引，默认模式的自述不该重复它", () => {
    expect(GUIDE).toContain("尚未接线");
    expect(selfAwarenessGuide(DEFAULT_TOOL_PROFILE)).not.toContain("尚未接线");
    expect(selfAwarenessGuide(DEFAULT_TOOL_PROFILE)).not.toContain("provides");
  });

  it("两处都守住「不许含糊承诺」这条同款口径", () => {
    expect(selfAwarenessGuide(DEFAULT_TOOL_PROFILE)).toContain("不要含糊承诺");
    expect(selfAwarenessGuide(DEFAULT_TOOL_PROFILE)).toContain("也不要假装已具备");
    expect(GUIDE).not.toMatch(/(将来|以后|后续)[^。\n]{0,24}(tools|工具)/);
  });

  it("自述与导引仍按模式分派（这次改动没把两段导引合并/串味）", () => {
    const creator = selfAwarenessGuide({ mode: "creator", skills: [], mcp: [] });
    expect(creator).toContain("被授权为自己创建插件");
    expect(creator).not.toBe(selfAwarenessGuide(DEFAULT_TOOL_PROFILE));
  });
});

describe("A-1197④ 回归保护：既有约束没被改坏", () => {
  it("origin 必须如实写 agent（模板 + 字段要点 + 安全红线三处都在）", () => {
    expect(GUIDE).toContain('"origin": "agent"');
    expect(GUIDE).toContain("· `origin`：如实写 `agent`");
    expect(GUIDE).toContain("`origin` 必须如实写 `agent`，禁止写 `builtin`");
  });

  it("禁写 builtin 的两处提示都还在（系统保留值）", () => {
    expect(GUIDE).toContain("**绝不能写 `builtin`**");
    expect(GUIDE).toContain("磁盘清单写 builtin 会被直接拒绝");
  });

  it("自验四步没被改坏：plugin_status / skill_search / 实跑 / 删插件如实告知", () => {
    expect(GUIDE).toContain("### 四、落位后必须自验，四步都过才算完成");
    expect(GUIDE).toContain("`plugin_status` 复核插件**真的被装载**");
    expect(GUIDE).toContain("`skill_search` 复核技能能被检索到");
    expect(GUIDE).toContain("**不证明「可用」**");
    expect(GUIDE).toContain("实跑一次");
    expect(GUIDE).toContain("**删除该插件**");
    expect(GUIDE).toContain("如实告知用户，不留半成品");
  });

  it("loop_config 如实转述、不越权声称那条没被改坏", () => {
    expect(GUIDE).toContain("loop_config");
    expect(GUIDE).toContain("不要越权声称");
    expect(GUIDE).toContain("**你自己没有改这个文件的权限**");
  });

  it("安全红线三条都在（权限沙箱 / 不擅自联网删文件 / 零宽字符）", () => {
    expect(GUIDE).toContain("不得修改权限与沙箱配置");
    expect(GUIDE).toContain("不得创建会执行用户未明确要求的网络请求或文件删除的插件");
    expect(GUIDE).toMatch(/零宽[\s\S]{0,40}不可见 Unicode/);
  });
});

describe("A-1197⑤ B1「设置贡献点」必须被写进创造模式导引（否则能力等于不存在）", () => {
  /* ## 这一组在防什么
   * B1（L4b）已落地：插件可在自己的 plugin.json 里用 `contributes.settings` **声明设置项**
   * （五种类型，含加密项），由宿主在「扩展」页渲染并持久化到插件自己的目录。
   * 但若导引里一个字都不提，Agent 被问「你能给插件加设置项吗」就会答「不能」——
   * 与 A-1196/A-1197④ 同一个病根：**能力边界没被告知 ⇒ Agent 只能瞎猜**。
   * 本组断言把「怎么写 / 落在哪 / 什么会被拒 / 不能干什么」四件事钉在导引里。
   */

  it("F-1 B1 能力确实在导引里：contributes.settings 与五种 type 全都在（词边界写严）", () => {
    expect(GUIDE).toContain("`contributes`");
    expect(GUIDE).toContain("contributes.settings");
    // 五种类型逐个点名，且都必须在「type」这一段里出现（不许只写「五种类型」糊弄）
    for (const t of ["boolean", "string", "number", "enum", "path"]) {
      expect(GUIDE, `五种 type 漏了 ${t}`).toContain(`\`${t}\``);
    }
    expect(GUIDE).toContain("只有五种");
    // 声明形状的必需字段
    expect(GUIDE).toContain("`key`");
    expect(GUIDE).toContain("`label`");
    expect(GUIDE).toContain("`type`（必填）");
    expect(GUIDE).toContain("`default`");
    expect(GUIDE).toContain("`hint`");
  });

  it("F-2 每种 type 的专属约束必须写清（min/max 必填、options 必填、root 只有两个值）", () => {
    // number：min 与 max 都必填 + min ≤ max
    expect(GUIDE).toMatch(/`number`[^。\n]{0,40}`min` 与 `max` \*\*都必填\*\*/);
    expect(GUIDE).toContain("min ≤ max");
    // enum：options 必填且非空
    expect(GUIDE).toMatch(/`enum`[^。\n]{0,40}`options` 必填且非空/);
    // path：root 必填且只有 plugin / workspace 两个枚举值
    expect(GUIDE).toMatch(/`path`[^。\n]{0,40}`root` 必填/);
    expect(GUIDE).toContain("`plugin`（相对插件目录）");
    expect(GUIDE).toContain("`workspace`（相对会话工作目录）");
    // 专属字段挂错 type 会被拒（不许静默忽略）
    expect(GUIDE).toContain("专属字段挂到别的 type 上会被拒，不静默忽略");
  });

  it("G 落点与安全边界必须说清：插件自己的目录 + 不许传路径", () => {
    expect(GUIDE).toContain("值存在**这个插件自己的目录**里");
    // 密文落盘文件名也要如实写出（读回只有 hasValue 这一条另有守卫）
    expect(GUIDE).toContain("settings.json");
    expect(GUIDE).toContain("settings.enc.json");
    expect(GUIDE).toContain("**不进** slime 主配置");
    // 「不许传路径」这条是结构性的，导引必须说出来
    expect(GUIDE).toContain("路径**只由插件名推导**");
    expect(GUIDE).toContain("**根本没有「路径」这个参数**");
    expect(GUIDE).toContain("结构上就不成立");
  });

  it("H secret：加密落盘 + 读回只给「是否已有值」，不许出现回显明文这类反表述", () => {
    expect(GUIDE).toContain('`"secret": true`');
    expect(GUIDE).toContain("**加密落盘**");
    expect(GUIDE).toContain("只对 `string` / `enum` / `path` 有意义");
    expect(GUIDE).toContain("读回来只告知「是否已有值」，**不回显明文**");
    expect(GUIDE).toContain("`secret: true` 时**不许**写 `default`");
    /* ⚠️ 词边界：「不回显明文」里含「回显明文」⇒ 只做正向整句断言，反向必须带否定边界，
       否则这条守卫会被自己人写的正确文案误伤（项目前科：未接线 / 尚未接线）。 */
    expect(GUIDE).not.toMatch(/(?<!不)回显明文/);
    expect(GUIDE).not.toMatch(/secret[^。\n]{0,30}(可读出明文|能读出明文|明文可见)/);
  });

  it("I fail-closed 纪律必须写清：拼错 / 类型不符 / 未知字段 ⇒ 整份清单被拒", () => {
    expect(GUIDE).toContain("校验是 **fail-closed**");
    expect(GUIDE).toContain("字段名拼错");
    expect(GUIDE).toContain("出现未知字段");
    expect(GUIDE).toMatch(/⇒ \*\*整份 plugin\.json 被拒\*\*/);
    // 必须明说「不是配了但没生效」——这是本仓判据（能配但没生效 = 陷阱）
    expect(GUIDE).toContain("而不是「配了但没生效」");
    // 反向：不得把校验说成宽松放行
    expect(GUIDE).not.toMatch(/未知字段[^。\n]{0,20}(忽略|跳过|放行)/);
  });

  it("J 边界必须直说：设置项只影响该插件，不等于「插件能改 slime 的配置」", () => {
    expect(GUIDE).toMatch(/设置项\*\*只影响该插件自己\*\*/);
    expect(GUIDE).toContain("**不等于**「插件能改 slime 的配置」");
    expect(GUIDE).toContain("没有这条声明式路径");
  });

  it("K 与 provides 的关系必须说清（provides 无 UI / contributes.* 带宿主 UI 或装配工具）", () => {
    /* A-1198 同步（B2–B6 落地后）：contributes 从「只有 settings」扩到五类（+ 主题皮肤 theme）
       （settings / ui / scripts / page）—— 判据随之泛化，但
       「provides 与 contributes 是两回事」这条**语义一字不动**。 */
    expect(GUIDE).toContain("`provides` 是无 UI 的资产贡献");
    expect(GUIDE).toContain("`contributes.*` 是**由宿主渲染成 UI 或装配成工具**的贡献点");
    // 四类都必须点名（少一类 = 那一类的能力对 Agent 等于不存在）
    for (const c of ["`settings`", "`ui`", "`scripts`", "`page`", "`theme`"]) {
      expect(GUIDE, `contributes 四类漏了 ${c}`).toContain(c);
    }
  });

  it("L 口径不许出现「无缝 / 即将支持」这类话（与 selfAwarenessGuide 同调）", () => {
    for (const bad of ["无缝", "即将支持", "即将上线", "未来支持", "很快就能"]) {
      expect(GUIDE, `导引出现了承诺词 ${bad}`).not.toContain(bad);
    }
  });

  it("M B1 那几段确实落在 creatorGuide 里（双产地漂移的粗判据）", () => {
    const guideIdx = SRC.indexOf("export function creatorGuide");
    const awareIdx = SRC.indexOf("export function selfAwarenessGuide");
    expect(guideIdx).toBeGreaterThan(-1);
    expect(awareIdx).toBeGreaterThan(guideIdx);
    for (const needle of ["contributes.settings", "路径**只由插件名推导**", "校验是 **fail-closed**"]) {
      const idx = SRC.indexOf(needle);
      expect(idx, `源码里找不到 ${needle}`).toBeGreaterThan(-1);
      expect(idx, `${needle} 必须落在 creatorGuide 里`).toBeLessThan(awareIdx);
    }
  });
});

describe("A-1197⑤ 回归保护：B1 那批改动没把既有四条语义改坏", () => {
  it("N-1 provides「工具贡献尚未接线」那条仍完整（不许被 B1 文案挤掉）", () => {
    expect(GUIDE).toContain("写 `tools` 或 `prompt` **不会被拒绝，但也不会生效**");
    expect(GUIDE).toContain("装载后插件清单里那一项只会显示「尚未接线」，**不会真的多出任何工具**。");
    expect(GUIDE).toContain("**不要因为清单里写了某个字段，就宣称自己多了工具能力**");
    // 反向吹牛守卫仍在
    expect(GUIDE).not.toMatch(/(已经|已|均已)接线|接线完成|接好了/);
  });

  it("N-2 origin=agent / 禁写 builtin 三处仍在", () => {
    expect(GUIDE).toContain('"origin": "agent"');
    expect(GUIDE).toContain("· `origin`：如实写 `agent`");
    expect(GUIDE).toContain("**绝不能写 `builtin`**");
    expect(GUIDE).toContain("`origin` 必须如实写 `agent`，禁止写 `builtin`");
  });

  it("N-3 自验四步仍在（B1 段落插在字段要点里，不许把自验步骤挪掉）", () => {
    expect(GUIDE).toContain("### 四、落位后必须自验，四步都过才算完成");
    expect(GUIDE).toContain("`plugin_status` 复核插件**真的被装载**");
    expect(GUIDE).toContain("`skill_search` 复核技能能被检索到");
    expect(GUIDE).toContain("**删除该插件**");
  });

  it("N-4 loop_config 不越权 + 安全红线仍在", () => {
    expect(GUIDE).toContain("loop_config");
    expect(GUIDE).toContain("不要越权声称");
    expect(GUIDE).toContain("**你自己没有改这个文件的权限**");
    expect(GUIDE).toContain("不得修改权限与沙箱配置");
    expect(GUIDE).toContain("不得创建会执行用户未明确要求的网络请求或文件删除的插件");
  });

  it("N-5 B1 也不能反过来变成「插件能改主配置 / 能塞凭据」的承诺", () => {
    expect(GUIDE).toContain("想让用户改主配置或塞凭据进来，没有这条声明式路径");
    // 安全红线仍明写 Agent 自建插件不得能改自己权限
    expect(GUIDE).toContain("Agent 自建的插件不得能改自己的权限。");
  });
});

describe("A-1197④ 源码形状断言（导引文案本体，改完回读得能查）", () => {
  it("源码里已经没有那句错误承诺（防「只在产物里消失、源码里还留着」）", () => {
    expect(SRC).not.toContain("将来要贡献工具再加");
  });

  it("provides 字段要点是 creatorGuide 的一部分，且带「未接线」的事实句", () => {
    const idx = SRC.indexOf("合法值只有");
    expect(idx, "源码里找不到 provides 的合法值说明").toBeGreaterThan(-1);
    const guideIdx = SRC.indexOf("export function creatorGuide");
    expect(guideIdx).toBeGreaterThan(-1);
    expect(idx, "provides 说明必须落在 creatorGuide 里，而不是别处").toBeGreaterThan(guideIdx);
    expect(SRC).toContain("不会真的多出任何工具");
  });

  it("provides 说明与 selfAwarenessGuide 同在一个文件里（双产地漂移的粗判据）", () => {
    expect(SRC).toContain("export function selfAwarenessGuide");
    expect(SRC.match(/export function creatorGuide/g)?.length).toBe(1);
  });
});