# slime 插件系统设计（规划）

> 建立：2026-10-06 ｜ 性质：**设计规划**（决策与规格，非实现记录）
> 依据：DeepSeek Harness 官方文档（`deepseek-harness.github.io/.../reference/`）+ 本仓库代码取证
> 相关：`docs/README.md`（文档索引）· `docs/slime-agent-loop-design.md §6.3–6.5`（插件页与插件安全的早期裁决）

---

## 0. 先回答三个问题

| 问题 | 结论 |
| --- | --- |
| **Skill 与 MCP 是一个概念吗？** | **不是，而且不在同一层。** Skill 是**指令**（怎么做），MCP 是**工具来源**（能做什么） |
| **slime 有做「一切皆插件」的潜质吗？** | **有，且基础比预期好**——三个注册表 + 已有 `unregister` 原语 + 声明式 `SKILL.md` + 多贡献类型雏形 |
| **要不要引入 Cordis？** | **不要。** 单体应用 + 模块边界清晰，元框架是过度工程。**借概念，不借实现** |

---

## 1. 为什么现在要动

### 1.1 症状

「设置 → 插件」页把**技能列表**与 **MCP 服务器列表**上下堆叠成一个页面。而它每一件事在各自专业页都有**更完整**的实现：

| 页面 | 行数 | 能力 |
| --- | --- | --- |
| `SkillsPanel`（技能库） | 559 | 列表 / 启停 / 删除 / 打开 + **新增 + 市场搜索 + 市场安装** |
| `McpPanel`（MCP 接入） | 579 | 列表 / 启停 / 增删 / 打开 + **注册表搜索 + 注册表安装** |
| ~~`PluginsPanel`（插件）~~ | 303 | **只有** 列表 / 启停 / 删除 —— 退化版合集 |

⇒ 它既**职责错误**（把两层东西混为一类），又**功能冗余**（各自只做一半）。

### 1.2 病根

slime 目前**没有「插件」这个实体**——只有两种平行的扩展机制（技能 / MCP），却给它们套了一个叫「插件」的壳。

### 1.3 「创造模式」的现状

`core-ts/src/services/agentTools.ts` 的 `ToolProfile.mode` 有三个值：`default` / `creator` / `custom`。其中：

```ts
if (profile.mode === "creator") {
  return { mode: "creator", skills: DEFAULT_TOOL_PROFILE.skills.slice(), mcp: DEFAULT_TOOL_PROFILE.mcp.slice() };
}
```

与 `default` 分支**逐字相同**——唯一差别是把 `creatorGuide()` 那段文本拼进 system prompt。
⇒ **`creator` 目前是纯提示词，零能力差异。** 这就是「粗浅命名」的确切技术含义。

---

## 2. 概念模型（本设计的核心）

### 2.1 三层，不要混

```
插件（Plugin）                    ← 可装卸、可分发的容器（有来源/版本/清单）
   │
   ├── 贡献「指令」  instructions → SkillRegistry      ← 技能在这
   ├── 贡献「工具」  tools        → ToolRegistry        ← MCP 桥接产生的工具在这
   └── 贡献「提示词」prompt        → systemPrompt 组装
```

**关键区分：**

| | 技能（Skill） | MCP |
| --- | --- | --- |
| **层** | **指令层** | **能力层** |
| **回答** | 怎么做（知识 / 流程 / 规范） | 能做什么（可执行能力） |
| **载体** | Markdown 正文 + frontmatter | 外部进程 / HTTP 服务 |
| **进上下文的路径** | 注入**目录**（name + description），正文**按需加载** | 工具 schema 进**工具表** |
| **DSH 中的位置** | 独立子系统 `ctx.skills` + 消费者 `dsh-tool-skill` | **文档中完全未提**——它是 `ctx.tools` 的一个来源，不是子系统 |

> ⭐ **MCP 在 DSH 里连子系统都不是**——这一点最能说明「它不是和 Skill 并列的东西」。

### 2.2 一个反直觉但重要的推论

**MCP 不是「插件的对立面」，而是「工具的一种来源」。**

所以正确的层次是：

```
工具来源：内置工具 ｜ MCP 桥接 ｜ （未来）插件提供的工具
指令来源：内置提示 ｜ 技能(SKILL.md) ｜ （未来）插件提供的指令
```

⇒ UI 上不该问「这是技能还是 MCP」，而该问「这是**指令**还是**能力**」。

---

## 3. 现状盘点：slime 已有什么

**已具备的原语（比预期多）：**

| 原语 | 位置 | 状态 |
| --- | --- | --- |
| 工具注册 + **撤销** | `ToolRegistry.register/unregister` | ✅ 已有撤销 |
| 多贡献类型 | `MCPClient.registerCapabilities` → `mcp_*`(tools) / `mcp_res_*`(resources) / `mcp_prompt_*`(prompts) | ✅ **一个 server 贡献三类**，且 `uniqueSlimeName()` 去重 |
| 指令注册 | `SkillRegistry` + 声明式 `SKILL.md` + frontmatter + `clear()` | ✅ 声明式格式已定 |
| 提示词注入点 | `hooks.fixedSegments` / `hooks.volatileSegments` | ✅ 已有分段 |
| 作用域雏形 | per-agent `ToolProfile`（`skills[]` / `mcp[]` 白名单） | ⚠️ 仅 MCP 真过滤（`agentToolsOnly` 只挡 `mcp_*`）；技能白名单**只是提示词**，无强制力 |

**缺失（本设计要补的）：**

1. **统一的「插件」容器抽象**——三个平行 registry，没有共同单元
2. **自动撤销 / 依赖顺序**——`unregister` 存在，但没有「注册时收集 → 卸载时逆序撤销」的机制
3. **贡献类型的统一注册入口**
4. **作用域分层**（per-agent 插件可见性）
5. **技能白名单的强制力**（当前只写进提示词，不挡加载）

---

## 4. 设计

### 4.1 核心原语：可逆副作用（借 Cordis 的唯一一件事）

Cordis 最值得借的是 `ctx.effect()`：**注册即副作用，卸载时自动撤销**。

最小可用版本（不需要元框架）：

```ts
type Disposer = () => void | Promise<void>;

class ContributionScope {
  private disposers: Disposer[] = [];
  /** 注册时收集撤销函数 */
  track(d: Disposer): void;
  /** 卸载：逆序执行，单个失败不阻断其余 */
  async disposeAll(): Promise<{ ok: number; failed: Array<{ error: unknown }> }>;
}
```

配合已有的撤销原语：`ToolRegistry.unregister(name)` / `MCPClient.unregisterServerTools(name)` / `SkillRegistry.clear()`。

### 4.2 插件清单（声明式，落盘）

```
config/plugins/<plugin-name>/
  plugin.json          # 清单（必须）
  skills/              # 贡献「指令」（可选）
  tools.js|ts          # 贡献「工具」（可选，未来）
  prompt.md            # 贡献「提示词片段」（可选）
```

```jsonc
{
  "name": "kebab-case",           // 唯一标识
  "version": "1.0.0",
  "description": "何时用（模型据此判断，不是「这是什么」）",
  "origin": "user | market | agent",
  "provides": ["instructions", "tools", "prompt"],
  "requires": ["<其他插件名>"],    // 依赖（决定加载顺序）
  "entry": "tools.js"             // 可选
}
```

> 命名规则与技能对齐：kebab-case、`^[a-z0-9]+(?:-[a-z0-9]+)*$`。

### 4.3 生命周期

```
扫描 → 校验清单 → 按 requires 拓扑排序 → load（track 所有 disposer）
     → enable / disable → unload（disposeAll 逆序撤销）
```

**安全红线（沿用 `docs/slime-agent-loop-design.md §6.5` 的三条铁律）：**

1. **插件代码默认进沙箱** —— 不得像主流产品那样让插件代码跑在沙箱外
2. **Agent 自建的插件不得能修改自己的权限配置** —— `slime.toml [sandbox]` / `config/gui_permissions.json` 硬拒绝
3. **配置变更先同意后执行** —— 直接针对 CVE-2025-54135 的「自动启动无需确认」模式

---

## 5. 分阶段实施

| 阶段 | 内容 | 验收判据 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| **P0** | **概念分离**：拆开 UI 里的技能 / MCP 混装，明确两层差异 | 设置里不再有把两者当同类的列表 | 低 | ✅ **已完成** |
| **P1** | **贡献与撤销原语**：`ContributionScope`（注册即副作用 / 逆序撤销 / 幂等 / 单失败不阻断） | `plugin-scope.spec.ts` 11 例 | 低 | ✅ **已完成** |
| **P2** | **PluginManifest + PluginHost**：清单校验（fail-closed）+ 拓扑排序 + 传递性失败传播 + 环检测 + 重名拒绝 | `plugin-manifest.spec.ts` 20 例 + `plugin-host.spec.ts` 25 例 | 中 | ✅ **已完成** |
| **P5** | **系统默认插件**：内置能力登记为 29 族 + **覆盖自检** | `plugin-builtin.spec.ts` 24 例；`auditBuiltinCoverage` 实测 **58 覆盖 / 0 漏登** | 低 | ✅ **已完成**（本轮追加） |
| **P3** | **插件管理 UI**：IPC + 「系统默认插件」展示块 | GUI tsc 0 错误；29 族 / 58 工具 / 全 `unloadable=false` | 中 | ✅ **已完成** |
| **P4** | **作用域 + 技能白名单强制力** | `skill-whitelist-enforcement.spec.ts` 39 例 + 5 组变异测试全红 | 中 | ✅ **已完成** |

**P4 的取证修正**：设计文档原文说「技能白名单无强制力」——实际**更严重**：
`agentTools.ts:74` 的 `agentToolsOnly()` **从未读过 `profile.skills`**（只读 `profile.mcp`），
即技能白名单不是"没强制力"，而是**从未被使用过**。已在 P4 修复（并顺带修了一处 child agent 绕过）。

### ⚠️ 2026-10-09 全链路审计：发现并修复两处「插件对 Agent 不可用」

用户口径：「扩展能否被 Agent 检测到并正常使用」。**审计用实证探针跑出来（非阅读推测）**：

1. **插件技能被全量重载抹掉**（`skills.ts`）
   现场：`loadSkills()` 先 `skills.clear()` 再只重扫 `scanRoots()`（= `skillDir` + `extraDirs`）——
   插件技能根**从来不在**那个列表里 ⇒ 任何一次全量重载都把插件技能抹掉且不再扫回来。
   而 `refreshAgentSkills()`（内部即 `loadAllSkills` → `loadSkills()`）在**每次发消息**
   （`chat:stream` 开头）与每次「保存并生效」后都会跑。
   ⇒ 用户装好扩展、**发第一条消息之后**，扩展技能就从 `skill_search` 里消失了。
   修法：`loadFromSource` 把来源根登记进 `assembledSources`，`scanRoots()` 一并纳入
   （仍受 `unloadedSources` 拦截 ⇒「卸载不复活」语义不变）。

2. **插件技能对 Agent 两种模式都不可见**（`skills.ts` + 白名单交互）
   现场：默认模式的 `allowed` 只有内置推荐集（6 个名字）；创造模式的 `allowAgentAuthored`
   只放行 `origin=agent`，而 `origin` **只从 `manifest.yaml/json` 读**
   （SKILL.md frontmatter 的 origin 根本不解析）⇒ 照《创造模式导引》写的插件技能两种模式都搜不到。
   ⇒ 导引「四、落位后必须自验」第 2 步（`skill_search` 复核）**永远过不了**；
   且直接违反 `creator-freedom-design.md` §判断标准
   ——「**能写但看不见**（写了技能但白名单不认）… 都不算自由度，算陷阱」。
   修法：`SkillRegistry.isPluginContributed()`（来源 = `assembledSources`）在
   `search` 与 `callSkill` **两处**放行插件技能；开关交给**插件启停本身**（用户可控）。
   ⚠️ 刻意**不**连带放开非插件技能 —— 那会把 P4 的技能白名单强制力一起废掉（守卫已钉）。

**同时修的自述三处**（Agent 不知道的能力 = 不存在）：
`contributes` 计数「五类」→「六类」+ 补 `css` 的声明示例与两条护栏；
删掉「扩展提供不了任意 CSS」这句（红线已作废，与同段新写的「CSS 任意」自相矛盾）；
主题皮肤段不再宣称"外观武装的全部接口"。

**验证**：`plugin-unload-scope.spec.ts` 25 → **39 例**（新增 14：跨重载存活 4 / 对 Agent 可见 6 /
自述覆盖 4）；新增变异 `mut-a1198-plugin-skill-visibility.mjs` **7/7 全抓**
（含一轮等价变异 triage：`assembledSources.delete` 是不可观测的纯清理 ⇒ 换点）。

---

### 遗留（已知，未修）

1. **`host.ts` 两处架构瑕疵**（已裁决接受，不做 API 洁癖）：
   - 硬依赖 `ToolRegistry` 且**硬编码 `SKILL_TOOLS = ["skill_search", "skill_lookup"]`** —— host 不该知道具体工具名
   - `unload` 对 builtin **抛异常**，与其余路径返回 `DisposeReport` 不一致
2. **P4 的 creator 模式豁免是唯一一处「放宽而非收紧」**：`origin: agent` 的技能在 creator 模式下绕过白名单。
   理由：creator 的定位就是「Agent 自己造技能」，严格拦会让 `creatorGuide` 的三步自验立刻失效。
   代价：creator 下可加载**任何** `origin: agent` 的技能，不限于自己刚造的。当前 `config/skills/` 无此类技能 ⇒ 无线上影响。
   更紧的方案（未做）：只豁免「本次会话内新建」的技能。
3. **未做 Electron 目视确认**：P3 的 UI 只跑了 tsc + vitest + 逻辑层探针。

---

## 6. 明确不做的事

| 不做 | 原因 |
| --- | --- |
| **引入 Cordis 元框架** | 单体应用、模块边界清晰；元框架（服务容器 / 声明合并 / 作用域链）带来的复杂度远超收益 |
| **让 agent-loop 变成可替换插件** | DSH 做这个是因为它是框架；slime 是应用，循环就是它的产品本身 |
| **插件市场 / 远程分发（P0–P4 内）** | 先把本地装卸与撤销做对，分发是后续独立议题 |
| **让插件代码跑在沙箱外** | 见 §4.3 安全红线 1 —— 这是 slime 相对主流产品的**差异化机会**，不是可选项 |

---

## 7. 与 DSH 的对照（借鉴了什么 / 没借什么）

| DSH 的做法 | 我们 | 理由 |
| --- | --- | --- |
| `ctx.effect()` 注册即副作用、卸载自动撤销 | ✅ **借**（P1） | 这是「可逆」的最小内核，且 slime 已有 `unregister` 可复用 |
| 「插件贡献多种类型」的心智模型 | ✅ **借**（§2） | 直接解释了 Skill 与 MCP 为何不该混装 |
| Skill 目录注入（name+description） + 正文按需加载 | ✅ **已有** | slime 的 `skill_search`/`skill_lookup` 已是这个形态 |
| `modelInvocable` / `userInvocable` 双策略 | ⚠️ **考虑**（P4） | 当前技能对模型与用户都是全开的 |
| 来源桶 + rank 分层去重 | ⚠️ **部分借鉴**（P2 的 `origin`） | slime 已有 `origin` frontmatter，但无 rank 优先级 |
| `ctx` 服务容器 + `inject` 依赖图 | ❌ 不借 | 用现有的模块 import + 显式 `set*Ref` 注入即可；引入容器收益不抵复杂度 |
| 元框架本身（Cordis） | ❌ 不借 | 见 §6 |

---

## 8. 已知前提与风险

1. **`creator` 模式目前是空的**（§1.3）。插件系统 P2 落地后，`creator` 才有真实含义：
   让 Agent 产出的不再是"一段提示词 + 一个 SKILL.md"，而是**一个可装卸、可撤销的插件**。
2. **技能白名单无强制力**（§3）。P4 前，提示词里说"白名单内的才可用"而实际加载不拦——这是一个**已知的信任缺口**，不要误以为它已被约束。
3. **`a1125-settings-order.spec.ts` 硬编码了 `plugins: 14` / `7` 的条数**：
   本次 UI 重构是**巧合对齐**（重写后条数恰好不变）。后续增删该 tab 的 features 会以「搬漏了」的名义误报 ⇒ 该守卫需改造为语义断言。
