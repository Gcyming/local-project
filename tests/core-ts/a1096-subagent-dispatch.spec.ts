/**
 * tests/core-ts/a1096-subagent-dispatch.spec.ts — 「谁能被派发为子代理」与「子代理用哪个模型」两条链路的守卫。
 *
 * 背景（用户诉求原话）：
 *   「让主Agent可以自如的派发子代理，而不是独自工作……不能所有项目都让主Agent做，效率太低了。」
 *   「现在的子代理调用模型只能指定一个，还是太少了，开个窗口让模型可以多选。」
 *
 * 这两条链路的失效**全部是静默的**：tsc 过、构建过、逻辑测试全过，但功能在真实运行里不存在：
 *   ① 授权判据曾是"独立勾选文件"，默认为空 ⇒ 自建 Agent 一个都进不了清单
 *      （症状：用户配好了 Agent，主 Agent 却只知道 3 个内置专家，于是"独自工作"）；
 *   ② 清单有**两个渲染产地**（系统提示段 + 工具报错提示），分组与标签各写一遍 ⇒ 口径漂移；
 *   ③ `spawnFromDef`（点名/打分两条主路都走它）漏传 `networkEnabled` ⇒ 关了联网子代理照样联网；
 *   ④ 模型池若只落盘、不进上下文 ⇒ "能设置却没人用"（死开关，A-1091 已归档过同族）。
 *
 * 因此这里分两层锁：
 *   - **纯模块层**：判据三态、映射字段、分组渲染、模型池规范化 —— 直接调用，可精确定位；
 *   - **源码接线层**：装配/提示词/UI 的"必须用哪个入口"约定 —— 这些只能靠读源码断言，
 *     因为写错也编译通过（去掉注释后再断言，避免被修复说明里的旧写法对照误伤）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  SUBAGENT_CATALOG_LABELS,
  agentToSubagentDefinition,
  dispatchableAgentIds,
  dispatchableSubagentDefinitions,
  groupSubagentCatalog,
  isSubagentDispatchAllowed,
  renderSubagentCatalogLines,
  renderSubagentModelSegments,
} from "../../core-ts/src/services/subagentCatalog.js";
import {
  DEFAULT_EXEC_BUDGET_MS,
  SUBAGENT_MODEL_POOL_MAX,
  SubAgentManager,
  normalizeModelPool,
} from "../../core-ts/src/services/subagent.js";
import type { AgentState } from "../../core-ts/src/services/agents.js";

/** 去掉注释行后的可执行源码（与 subagent-wiring.spec.ts 同款：修复说明会引用旧写法做对照） */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** 最小可用 AgentState（只填本模块用到的字段，其余靠索引签名）。 */
function agent(patch: Partial<AgentState> & { id: string; name: string }): AgentState {
  return {
    role: "",
    identity_prompt: "",
    model_choice: "inherit",
    parent_id: null,
    persona: {} as AgentState["persona"],
    emotion: {},
    behavior: {},
    children: [],
    created_at: "2026-09-24T00:00:00.000Z",
    ...patch,
  } as AgentState;
}

describe("A-1096 — 子代理派发授权判据（三态，唯一出处）", () => {
  it("缺省 / 显式 true ⇒ 允许；只有显式 false 才拒绝（不允许把 undefined 与 false 合并）", () => {
    expect(isSubagentDispatchAllowed({ subagent_dispatch: undefined })).toBe(true);
    expect(isSubagentDispatchAllowed({ subagent_dispatch: true })).toBe(true);
    expect(isSubagentDispatchAllowed({ subagent_dispatch: false })).toBe(false);
    // 空对象（历史配置里这个字段根本不存在）同样必须判「允许」——
    // 若这里退化成 `=== true`，开箱即用的用户会一个子代理都派不出去。
    expect(isSubagentDispatchAllowed({} as Pick<AgentState, "subagent_dispatch">)).toBe(true);
  });

  it("Agent → 子代理定义：路由键 = 名字：角色，绑定 agentId，预算取唯一真源", () => {
    const def = agentToSubagentDefinition(agent({
      id: "ag-1", name: "架构师", role: "负责模块边界与接口设计", identity_prompt: "  你是架构师，先画图再写码。  ",
    }));
    expect(def.name).toBe("架构师");
    expect(def.description).toBe("架构师：负责模块边界与接口设计");
    expect(def.agentId).toBe("ag-1");
    expect(def.model).toBe("inherit");
    expect(def.outputSchema).toBe(true);
    // 预算必须是常量（历史上这里是散落的 300s 字面量，正是 A-983 记录的"把 4/4 步的工作掐掉"的元凶）
    expect(def.timeoutMs).toBe(DEFAULT_EXEC_BUDGET_MS);
    // 身份提示要 trim 后使用
    expect(def.systemPrompt).toBe("你是架构师，先画图再写码。");
  });

  it("身份提示为空时回退到「你是「名字」，负责：角色。」，不得产出空系统提示", () => {
    const def = agentToSubagentDefinition(agent({ id: "ag-2", name: "调研员", role: "多来源资料汇总" }));
    expect(def.systemPrompt).toBe("你是「调研员」，负责：多来源资料汇总。");
    /* ⚠️ `SubagentDefinition.systemPrompt` 是**可选**字段 ⇒ 必须先收窄再用（否则 root tsc TS18048）。
       收窄后仍断言"非空且 trim 后非空"——意图不变：不许产出空系统提示。 */
    const sp = def.systemPrompt ?? "";
    expect(sp).not.toBe("");
    expect(sp.trim().length).toBeGreaterThan(0);
  });

  it("可派发清单：只含被允许的、保持注册顺序；id 清单与定义清单用**同一判据**", () => {
    const list = [
      agent({ id: "a1", name: "甲", role: "r1" }),
      agent({ id: "a2", name: "乙", role: "r2", subagent_dispatch: false }),
      agent({ id: "a3", name: "丙", role: "r3", subagent_dispatch: true }),
    ];
    expect(dispatchableSubagentDefinitions(list).map((d) => d.name)).toEqual(["甲", "丙"]);
    expect(dispatchableAgentIds(list)).toEqual(["a1", "a3"]);
    // 定义清单里的 agentId 必须与 id 清单一一对应（否则"面板勾上了、注册的是另一个"）
    expect(dispatchableSubagentDefinitions(list).map((d) => d.agentId)).toEqual(dispatchableAgentIds(list));
  });
});

describe("A-1096 — 清单分组/标签唯一出处（两个渲染产地同源）", () => {
  it("分组：source=user 进「可派发的 Agent」组，其余进「内置专家」组", () => {
    const grouped = groupSubagentCatalog([
      { name: "甲", description: "甲：r", source: "user" },
      { name: "代码审查员", description: "审查", source: "builtin" },
      { name: "乙", description: "乙：r", source: "user" },
    ]);
    expect(grouped.agents.map((c) => c.name)).toEqual(["甲", "乙"]);
    expect(grouped.builtin.map((c) => c.name)).toEqual(["代码审查员"]);
  });

  it("渲染行使用的分组标题就是共享常量（改一处即两处同变，不许硬编码字面量）", () => {
    const lines = renderSubagentCatalogLines(groupSubagentCatalog([
      { name: "甲", description: "甲：r", source: "user" },
      { name: "代码审查员", description: "审查", source: "builtin" },
    ])).join("\n");
    expect(lines).toContain(`${SUBAGENT_CATALOG_LABELS.agents}：`);
    expect(lines).toContain(`${SUBAGENT_CATALOG_LABELS.builtin}：`);
    expect(lines).toContain("- 甲：甲：r");
    expect(lines).toContain("- 代码审查员：审查");
    // 标签文案必须与"实际语义"一致：source=user 现在是"用户的 Agent（已同意被派发）"，
    // 不再是"用户勾选的少数几个"——旧文案「用户选定」在这个语义下是假描述。
    expect(SUBAGENT_CATALOG_LABELS.agents).not.toContain("选定");
  });

  it("空分组不渲染标题（避免出现一个孤零零、下面什么都没有的小标题）", () => {
    const onlyBuiltin = renderSubagentCatalogLines(groupSubagentCatalog([
      { name: "调研员", description: "调研", source: "builtin" },
    ])).join("\n");
    expect(onlyBuiltin).not.toContain(SUBAGENT_CATALOG_LABELS.agents);
    expect(onlyBuiltin).toContain(SUBAGENT_CATALOG_LABELS.builtin);
  });
});

describe("A-1097 — 执行模型池：规范化与提示段", () => {
  it("规范化：剔空串与 inherit、去重保序、限长（顺序即优先级，不许排序）", () => {
    expect(normalizeModelPool(undefined)).toEqual([]);
    expect(normalizeModelPool("api:x")).toEqual([]);          // 非数组 ⇒ 空池（不猜）
    expect(normalizeModelPool([" api:a:1 ", "", "  ", "inherit"])).toEqual(["api:a:1"]);
    // 去重但保序：b 在前就留在前（池首 = 兜底档，顺序有语义）
    expect(normalizeModelPool(["local:b", "api:a:1", "local:b"])).toEqual(["local:b", "api:a:1"]);
    const many = Array.from({ length: SUBAGENT_MODEL_POOL_MAX + 5 }, (_, i) => `api:p:m${i}`);
    expect(normalizeModelPool(many)).toHaveLength(SUBAGENT_MODEL_POOL_MAX);
  });

  it("提示段：空池 ⇒ 不产生任何段（不许凭空造出「默认执行档：」这种空承诺）", () => {
    expect(renderSubagentModelSegments([])).toEqual([]);
    expect(renderSubagentModelSegments(["inherit"])).toEqual([]);
  });

  it("提示段：单档 ⇒ 只给默认执行档，不出现「可点名换用」", () => {
    const seg = renderSubagentModelSegments(["api:cheap:light"]).join("\n");
    expect(seg).toContain("默认执行档：api:cheap:light");
    expect(seg).not.toContain("可点名换用");
  });

  it("提示段：多档 ⇒ 池首作兜底档、其余列为可点名档位（这就是「让模型可以多选」的落地）", () => {
    const seg = renderSubagentModelSegments(["api:cheap:light", "api:strong:big", "local:qwen"]).join("\n");
    expect(seg).toContain("默认执行档：api:cheap:light");
    expect(seg).toContain("可点名换用：api:strong:big / local:qwen");
    // 兜底档不许同时出现在"可点名换用"里（重复列出会让模型以为有两个默认）
    expect(seg.match(/api:cheap:light/g)).toHaveLength(1);
    expect(seg).toContain("inherit");
  });
});

describe("A-1097 — SubAgentManager 的池路由（池首 = 兜底档）", () => {
  async function modelSeenBy(over: { model?: string }): Promise<string | undefined> {
    let seen: string | undefined;
    const mgr = new SubAgentManager(async (def) => {
      seen = def.model;
      return "ok";
    }, { defaultModels: ["api:cheap:light", "api:strong:big"] });
    const run = mgr.spawn({ name: "t", task: "do it", ...(over.model !== undefined ? { model: over.model } : {}) });
    await mgr.wait(run.id, 5_000);
    return seen;
  }

  it("未指定 model ⇒ 用池首（兜底档）", async () => {
    expect(await modelSeenBy({})).toBe("api:cheap:light");
  });

  it("显式 model ⇒ 覆盖池首（可为不同子任务点不同档位）", async () => {
    expect(await modelSeenBy({ model: "api:strong:big" })).toBe("api:strong:big");
  });

  it("model=inherit ⇒ 仍走兜底档（inherit 是「不覆盖」的占位，不是档位）", async () => {
    expect(await modelSeenBy({ model: "inherit" })).toBe("api:cheap:light");
  });

  it("空池 ⇒ 不覆盖（effectiveModel 为空，交由引擎沿用目标 Agent 模型）", async () => {
    let seen: string | undefined = "sentinel";
    const mgr = new SubAgentManager(async (def) => { seen = def.model; return "ok"; });
    const run = mgr.spawn({ name: "t", task: "do it" });
    await mgr.wait(run.id, 5_000);
    expect(seen === "" || seen === undefined).toBe(true);
  });

  it("setDefaultModels/getDefaultModels 与旧单值入口口径一致（getDefaultModel = 池首）", () => {
    const mgr = new SubAgentManager(async () => "ok");
    mgr.setDefaultModels(["api:a:1", "api:a:1", "inherit", "local:b"]);
    expect(mgr.getDefaultModels()).toEqual(["api:a:1", "local:b"]);
    expect(mgr.getDefaultModel()).toBe("api:a:1");
    mgr.setDefaultModel("local:b");           // 旧入口 = 整池换成只有一个档位
    expect(mgr.getDefaultModels()).toEqual(["local:b"]);
    mgr.setDefaultModel("");
    expect(mgr.getDefaultModels()).toEqual([]);
    expect(mgr.getDefaultModel()).toBe("");
  });

  it("构造参数兼容：旧调用点传单值 defaultModel 等价于只有一档的池", () => {
    const mgr = new SubAgentManager(async () => "ok", { defaultModel: "api:legacy:1" });
    expect(mgr.getDefaultModels()).toEqual(["api:legacy:1"]);
  });
});

describe("A-1096/A-1097 — 源码接线守卫（写错也编译通过的那些约定）", () => {
  const MAIN = codeOf("gui/src/main/index.ts");
  const SUBAGENT = codeOf("core-ts/src/services/subagent.ts");
  const BUILTIN = codeOf("core-ts/src/tools/builtin.ts");
  const CHAT = codeOf("core-ts/src/services/chat.ts");
  /** A-1106：委派规范的唯一出处（chat 与 engine 共用同一常量 —— 文本住在这里，不在调用点） */
  const CATALOG = codeOf("core-ts/src/services/subagentCatalog.ts");
  const AGENTS_PANEL = codeOf("gui/src/renderer/pages/AgentsPanel.tsx");
  const RESIDENT_PANEL = codeOf("gui/src/renderer/pages/ResidentPanel.tsx");
  const PRELOAD = codeOf("gui/src/preload/index.ts");

  it("装配层：清单段必须复用共享渲染（不许就地 filter 分组 —— 那是第二个产地）", () => {
    expect(MAIN).toContain("renderSubagentCatalogLines(groupSubagentCatalog(cat))");
    // 就地分组的老写法（`cat.filter((c) => c.source === "user")`）不得再出现在 main 里
    expect(MAIN).not.toContain("cat.filter((c) => c.source");
  });

  it("工具层：subagentCatalogHint 同样复用共享渲染（提示与系统提示不许两套说法）", () => {
    expect(BUILTIN).toContain("renderSubagentCatalogLines(groupSubagentCatalog(cat))");
    expect(BUILTIN).not.toContain("cat.filter((c) => c.source");
  });

  it("装配层：注册的是「全部被授权的 Agent」而不是勾选文件（第二真相源已退役）", () => {
    expect(MAIN).toContain("dispatchableSubagentDefinitions(agentRegistry?.loadedAgents ?? [])");
    // ⚠️ **A-1106 迁移（2026-09-25）—— 是迁移，不是删除**：本轮把这段登记逻辑收进了唯一的模块级
    //   `syncDispatchableSubagents(mgr)`，接收者由模块级 `subagents` 改成**显式传入的** `mgr`
    //   （启动期 `subagentsRef` 仍是 `null` ⇒ 收进函数时必须传参，见 a1106-subagent-dispatch 的 P3）。
    //   **原意图完好，故只换锚点**：① 登记的清单必须来自 `dispatchableSubagentDefinitions`
    //   （由 Agent 开关推导，**不是**旧的勾选文件）；② 登记**只能有一处**（两处 = 两个产地，
    //   判据会各说各话 —— 旧「第二真相源」正是这么来的）。
    //   ② 是**计数型**断言 ⇒ 必须配变异（`mut-a1106.mjs` 第 75 条）。
    expect(MAIN, "登记必须用**参数传入**的管理器（读模块级 ref 在启动期是 null ⇒ 静默不登记）")
      .toContain("mgr.setUserSelected(defs)");
    expect((MAIN.match(/\.setUserSelected\(defs\)/g) ?? []).length, "登记只能有一处")
      .toBe(1);
    // 旧第二真相源（独立勾选文件 + 内存清单）必须彻底消失，否则"面板勾了、Agent 设置里看不出来"
    expect(MAIN).not.toContain("subagentSelectedAgentIds");
    expect(MAIN).not.toContain("subagent-selection.json");
    expect(MAIN).not.toContain("saveSubagentSelection");
  });

  it("装配层：三段内置专家的执行预算取唯一真源（不许再出现 300_000 字面量）", () => {
    expect((MAIN.match(/timeoutMs: DEFAULT_EXEC_BUDGET_MS/g) ?? []).length).toBe(3);
    expect(MAIN).not.toContain("timeoutMs: 300_000");
  });

  it("Agent 详情必须**原样透传** subagent_dispatch（用 ?? true 兜住就等于三态塌成一态）", () => {
    expect(MAIN).toContain("subagent_dispatch: a.subagent_dispatch");
    expect(MAIN).not.toContain("subagent_dispatch: a.subagent_dispatch ?? ");
  });

  it("resident「可派发」读写落到 Agent 字段上（与 Agent 设置同源），不是另写一份清单", () => {
    expect(MAIN).toContain("dispatchableAgentIds(agentRegistry?.loadedAgents ?? [])");
    expect(MAIN).toContain("updateAgent(a.id, { subagent_dispatch: want })");
  });

  it("子代理 runner 的两条派发主路都必须保留（点名 + 自动路由），点名失败不许静默回落", () => {
    expect(SUBAGENT).toContain("return this.spawnFromDef(named, task, overrides);");
    expect(SUBAGENT).toContain("if (def) { return this.spawnFromDef(def, task, overrides); }");
  });

  it("spawnFromDef 必须透传 networkEnabled（漏传 ⇒ 关了联网的子代理照样联网）", () => {
    const at = SUBAGENT.indexOf("private spawnFromDef(");
    expect(at).toBeGreaterThan(-1);
    const body = SUBAGENT.slice(at, at + 900);
    expect(body).toContain("networkEnabled: overrides.networkEnabled");
  });

  it("chat.ts：编译期恒假的清单判据已移除，且派发引导来自唯一出处（A-1106 迁移）", () => {
    expect(CHAT).not.toContain('sys.includes("## 可用子代理")');
    // ⚠️ A-1106 迁移（2026-09-25）：规范整段搬到 `subagentCatalog.ts::DELEGATION_GUIDANCE`
    //（与 `Engine.buildSystem` 共用同一出处）。原断言的 `CHAT).toContain("先拆再干")` /
    // `toContain("点名优先")` 随文本一起失效 —— 按纪律**迁移**（保留意图 + 配新变异 M13），
    // 不许删：意图是「派发引导必须真的存在且要求主动拆分」，现在改为锁「chat 引用常量」+「常量本身有那两条」。
    expect(CHAT).toContain("DELEGATION_GUIDANCE");
    expect(CATALOG).toContain("默认派发");
    expect(CATALOG).toContain("点名优先");
  });

  it("Agent 设置里有「子代理派发」开关，且保存时把布尔值落库", () => {
    expect(AGENTS_PANEL).toContain("子代理派发");
    expect(AGENTS_PANEL).toContain("patchLocal({ subagent_dispatch: o.v })");
    expect(AGENTS_PANEL).toContain("patch.subagent_dispatch = detail.subagent_dispatch");
    // 三态回显：未设置 / 已同意 / 已拒绝三种文案都要有，否则用户看不到"未设置"这一态
    expect(AGENTS_PANEL).toContain("未设置（默认允许）");
  });

  it("resident 面板：模型入口是**多选弹层**（不是单值下拉），清单走 setModels 通道", () => {
    expect(RESIDENT_PANEL).toContain("subagentSetModels");
    expect(RESIDENT_PANEL).toContain('position: "fixed"');      // 弹层（窗口）
    expect(RESIDENT_PANEL).toContain("兜底档");
    // 单值下拉入口必须已移除（保留两个入口 = 两套真相源，用户改一处另一处不动）
    expect(RESIDENT_PANEL).not.toContain("subagentSetDefaultModel");
  });

  it("preload：多选模型池通道有真实现（只有类型声明 ⇒ 调用处永远静默失败）", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("slime:resident:subagent:setModels"');
  });
});
