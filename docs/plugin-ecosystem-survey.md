# Agent 产品的「创造模式 / 插件系统」调研报告

> 访问日期：**2026-10-06**。所有结论均以官方文档 / 官方仓库原文为准，二手来源仅作线索并已回溯官方源。
> 查不到的条目一律写「未查到」，不做推测填充。

---

## 0. 摘要：五个问题的直接答案

| 问题 | 一句话答案 |
|---|---|
| 1. 各家的「插件」贡献什么 | 见 §3 对照表。一句话：**插件 = 「贡献类型 × 装载时机 × 可逆性」三者组合**，各家只覆盖其中一小块格子，没有一家覆盖全部。 |
| 2. 谁做到了真正的运行时可逆 | **DeepSeek Harness**（Cordis fiber/effect 模型）。官方原文：`registrations are effects that unwind when their plugin unloads`。其余各家普遍是「重启生效」或「不提供卸载」。 |
| 3. 谁在做「Agent 自己创建并装上插件」 | **只有 DSH 有完整的官方实现**（Creator 模式 + `plugin_manager` + 3 个 skill + Web 入口）。且 DSH **曾经做过「模型直接生成并运行代码」的版本并主动删掉了**——这是本报告最有价值的发现，见 §5.1。 |
| 4. MCP 在各家体系里的位置 | **横向结论：MCP 一律是「工具的一种来源」，不是独立子系统。** 各家都把 MCP 工具降级汇入自己的 tool registry。DSH 甚至明确写了「不发布共享 `ctx.mcp` 服务」。 |
| 5. 创造模式给 Agent 多挂工具是否好实践 | **是坏实践，DSH 有直接的反向证据。** DSH creator preset 相对 default **只多挂 2 个工具**，且明确「不是生成代码、而是装持久 bundle」。见 §5.1 全文。→ **slime 现在 creator 与 default 同工具面，很可能是对的。** |

---

## 1. DeepSeek Harness（DSH）——最高优先级对标

### 1.0 首要更正：仓库是公开的

任务描述中提到「DSH 的 GitHub 仓库我查过是 404」。**实际情况：仓库公开且是官方主仓。**

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `deepseek-ai/deepseek-harness` | https://api.github.com/repos/deepseek-ai/deepseek-harness |
| 描述 | `DeepSeek Harness: Everything is a Plugin.` | 同上 |
| 许可证 | MIT | 同上 |
| 创建时间 | 2026-08-13 | 同上 |
| 默认分支 | `master` | 同上 |
| star / fork | 244219 / 29256 | 同上 |
| topics | `ai-agents`, `cordis`, `dsh`, `dsh-plugin` | 同上 |
| 主页 | https://deepseek.com/harness | 同上 |

**文档站 `deepseek-harness.github.io/deepseek-harness/` 是客户端渲染的单页应用，WebFetch 只能取到标题。** 用户提到的 `cordis-primer` / `subsystems/skills` / `subsystems/core` 等页面在 GitHub 仓库 `docs/` 下有对应 Markdown 原文（且每个都有 `.zh.md` 官方中文版）。**本报告全部 DSH 结论来自仓库 `docs/` 原文，不依赖文档站。**

关键文档索引（均已逐字读取）：
- `docs/cordis-primer.md`、`docs/architecture.md`
- `docs/subsystems/`（约 60 个子系统页，含 `core.md` / `tools.md` / `skills.md` / `mcp.md` / `extensions.md` / `boot.md` / `scope.md` / `claude-code-mods.md`）
- `docs/cordis-api/`（`context.md` / `fiber.md` / `registry.md` / `events.md` / `service.md`）
- `docs/cookbook/`（`adding-a-tool.md` / `adding-a-package.md` / `extension-cookbook.md`）
- `docs/tool-catalog.md`
- `SAFETY.md`

---

### 1.1 插件形态：npm 包 / 目录，不是单文件

DSH 有**两层**"插件"，形态完全不同，必须分清：

**第一层：bundle（分发格式）**

原文（`docs/architecture.md`）：

> A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it.
>
> Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file.

清单字段（来自 `packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md` 的官方示例）：

```json
{
  "name": "@local/dsh-review-preset",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

客户端插件额外声明 `dsh.client`（`docs/cookbook/adding-a-package.md`）。

Loader patch 方言（来自 `cordis-composition-reference/SKILL.md`，逐字要点）：
- `insert: [rows]` 追加行；带 `id` 指向已存在的 `group: true` 行时，追加进该组的 `config` 列表
- 带 `id` 且无 `insert` 的 patch 覆盖该行；**`config` 整体替换，永不深合并**
- 行字段：`id`、`name`、可选 `config`、以及 `disabled` / `inject` / `intercept` / `isolate`
- `group: true` + `name: cordis:group` 让 `config` 变成嵌套入口列表
- `disabled` 接受布尔 / null / `!!js` 表达式（在每个挂载决策处针对 Loader 上下文求值）
- `isolate` 把服务名映射到 `true` 或 realm 标签

**第二层：单文件插件（仅客户端浏览器侧）**
`packages/client/*` 声明 `dsh.client`、导出 `./client`。这是 UI 侧的产物形态。

**装载与卸载（`apps/cli/reference/README.md` 逐字）**：

> `dsh plugin --profile <name> <args...>` initializes the profile when missing ... then forwards `<args...>` to `pnpm` with the profile directory as working directory — `add`, `remove`, `why`, `update`, and every other pnpm verb work unchanged
>
> After every successful run, `dsh.profile.bundles` is reconciled against the installed state: each dependency resolving to a package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` joins the layer stack ... a bundle-less dependency stays plain with a one-time warning, and a removed dependency leaves the stack.

安装源支持：npm 包名、Git 地址（`github:org/repo`）、tarball、本地绝对路径。

**卸载顺序（`packages/boot/plugin-manager/README.md` 逐字）**：

> Removal proceeds in order: remove the bundle from `dsh.profile.bundles`, unload its runtime contributions, run `pnpm remove`, then publish runtime resolution unless a deselected startup bundle still runs without HMR. A failed step prevents subsequent steps; publication failure after removal does not restore deleted packages.

失败回滚（逐字）：

> A run that fails, is cancelled, or adds a package without a bundle patch restores `package.json` and `pnpm-lock.yaml` as they were

**重启边界（重要且常被忽略）**：

> The successful pnpm operation changes the Profile manifest and Bundle list on disk; a running Profile keeps the Bundle set from its current start. **Restart that Profile after adding, removing, or updating a Bundle.** This startup boundary applies to Bundle membership, while ordinary edits to the Profile or home `cordis.patch.yml` take effect through hot reload.

---

### 1.2 ctx 上挂了哪些能力（逐个列出）

`ctx` 是 Cordis 的 Context 对象，扮演**服务仓库**。原文（`docs/cordis-primer.md`）：

> **A context is a repository of services.** A service claims a stable `ctx.<key>` such as `ctx.tools`, `ctx.llm`, or `ctx.sessions` from a context; other plugins find services via key instead of importing a concrete implementation.

Context 本体自带（`docs/cordis-api/context.md`）：`ctx.extend()` / `ctx.isolate()` / `ctx.intercept()` / `ctx.root` / `ctx.baseUrl` / `ctx.events` / `ctx.logger` / `ctx.reflect` / `ctx.registry`，以及混入的 `ctx.on` `ctx.emit` `ctx.waterfall` 等事件方法、`ctx.plugin` `ctx.inject` 两个注册表方法。服务注册原语：`ctx.get/set/provide/accessor/mixin`。

**harness 自有服务（有官方文档证据的逐个列举）**：

| 服务 | 归属 | 来源 |
|---|---|---|
| `ctx.sessions` | append-only SessionEvent 日志与内存 store，唯一真相源 | `docs/subsystems/core.md` |
| `ctx.systemPrompt` | 提示词分段与工具 schema 组装 | 同上 |
| `ctx.tools` | 分层工具注册表 + 受保护的执行管线 | 同上 |
| `ctx.agents` | Agent 接口、活动注册表、`agent/*` 事件词汇表 | 同上 |
| `ctx.agentLoop` | 默认 Agent 驱动器（可替换） | 同上 |
| `ctx.agentDefaultModel` | 默认模型选择 | 同上 |
| `ctx.agentPresets` | YAML 声明的 preset 注册表 | 同上 |
| `ctx.skills` | 分层 skill 提供者注册表 | `docs/subsystems/skills.md` |
| `ctx.sessionSkillCatalog` | 不激活冷 Agent 也能列 skill | 同上 |
| `ctx.mcpResources` | 跨 MCP server 的共享资源工具 | `docs/subsystems/mcp.md` |
| `ctx.pluginManager` | profile 文件与插件/bundle 生命周期管理 | `docs/subsystems/boot.md` |
| `ctx.pluginRegistryProbe` | npm / npmmirror 竞速探测 | 同上 |
| `ctx.profileContext` | 当前 profile 事实 | 同上 |
| `ctx.dynamicCordisRunner` | 动态插件注册表与 Host 半边生命周期 | `docs/subsystems/extensions.md` |
| `ctx.cordisInspect` | 回答浏览器查询的 inspect 注册表 | 同上 |
| `ctx.llm` / `ctx.commands` / `ctx.jobs` / `ctx.goals` / `ctx.sandbox` / `ctx.approval` / `ctx.subagents` / `ctx.compaction` / `ctx.workflowEngine` / `ctx.terminals` / `ctx.fs` / `ctx.shell` / `ctx.sessionTitle` / `ctx.webhookRuntime` | 扩展点地图中「新行为放哪」表所列服务 | `docs/architecture.md` |

`services/` 类页面（`ctx.tools` / `ctx.skills` / `ctx.sessions` 等）在 `docs/subsystems/` 下有生成的完整 service/event 目录。

**"一切皆插件"的官方声明（`docs/architecture.md` 逐字）**：

> Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration.
>
> There is no privileged core to patch: you extend dsh by **mounting a plugin beside the others**, and registrations are effects that unwind when their plugin unloads.

---

### 1.3 ctx.effect()：可逆性的机制核心

**这是「真正的运行时可逆」的关键。**

`docs/cordis-primer.md` 的五条核心思想之一逐字：

> **Registrations are reversible effects.** Prompt sections, tool schemas, adapters, providers, and listeners are installed through `ctx.effect()` or `ctx.on()` so reload and teardown unwind them predictably.

并加了一条硬规则：

> Every registration should have a disposer, either by returning one from `ctx.effect()` or using a Cordis helper that does it for you. If teardown order matters, keep the related work in one effect so disposal unwinds in the intended sequence.

签名（`docs/cordis-api/fiber.md` 逐字）：

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

语义（JSDoc 逐字要点）：

> `execute` runs immediately; the disposers it produces are collected and run (**in reverse order**) either when the returned disposer is called **or when the fiber unloads, whichever comes first**. Calling the disposer twice is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.

`Effect` 类型：

> Either a single disposer, a promise of one, or a (possibly async) iterable yielding several — **generator effects register each yielded disposer as it is produced.**

`Disposable`：

> Disposers run in reverse registration order when the owning fiber unloads; they may be async, in which case unloading awaits them.

事件监听同样返回 disposer（`docs/cordis-api/events.md`）：

```ts
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```
> @returns a disposer removing the listener; `true` if it was still registered.

`ctx.on` 监听器由当前 fiber 拥有——所以 fiber 卸载时监听器一起消失，这就是"hook 能恢复"。

**HMR 直接受益于该模型（`docs/cookbook/extension-cookbook.md` feature map 最后一行逐字）**：

> Plugin hot-reload | every registration is a `ctx.effect` → vendored HMR just works

** disposer 身份敏感（`docs/subsystems/core.md` 逐字）**：

> Exact identity is load-bearing: a composite (generator) effect that owns a teardown ORDER — the agent factory's lifecycle chain — must yield THIS function so Cordis nests the unregistration at that yield position; yielding a wrapper would leave it disposing as a concurrent sibling on owner unload.

`ctx.inject` 的卸载语义（`docs/cordis-api/registry.md` 逐字）：

> Shorthand for `ctx.plugin({ inject, apply: callback })`: the callback **is unloaded and re-run whenever a required service changes**.

---

### 1.4 skills 与 tools 的关系：**两个独立子系统，skill 通过 tool + prompt section 接入 tools**

`docs/subsystems/skills.md` 逐字：

> The [skill capability family](../../packages/skill) includes the Service Definition (`dsh-skill`, `ctx.skills`), the local Service Provider (`dsh-skill-filesystem`), optional packaged providers (`dsh-skill-badge`, `dsh-skill-office`, and the Windows ACL diagnosis provider in `dsh-sandbox-windows-acl`), and the Consumer (`dsh-tool-skill`). The registry merges provider catalogs across its host and per-scope layers; providers contribute local or packaged skills; **the Consumer owns the initial and replacement catalogs plus the model-facing `skill` tool.**
>
> **Skills are optional instructions, not session events**, so their vocabulary lives here rather than in `core.md`.

**skill 是独立子系统（有自己的 Service `ctx.skills`、Provider 接口、事件），但它对工具系统的贡献是「一个 tool + 若干 prompt section」。**

skill 形态（逐字）：

> The local provider accepts directory bundles (`<name>/SKILL.md`) and flat Markdown files (`<name>.md`). **Nested recursive `**/SKILL.md` discovery is not supported.**

Skill 名称必须是 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。

**双向调用（这是关键的相互调用证据）**：

*skill → tool*：`dsh-tool-skill` 在活体会话第一个 `agent/pre-step` 注入持久的 user-role `<system-reminder>`，内容只含排序后的 skill `name` 与规范化、XML 转义的 `description`，**不含正文、路径、来源、路由提示**。后续每一步做 diff，变化时通过 `agent.inject()` 追加完整替换。

*tool → skill*：模型可见的 `skill({ name })` 工具校验 kebab-case 名、在中立目录中查摘要、**在加载前**检查 `isModelInvocable`，然后重读完整定义并**再检查一次策略**，返回含 `<skill_content>` / `<skill_resources>` / `<skill_instructions>` 的工具结果。

策略四组合（逐字）：

| 设置 | 用户可调 | 模型可调 | 载入上下文 |
|---|---|---|---|
| 默认 | 是 | 是 | description 常驻，正文调用时载入 |
| `disable-model-invocation: true` | 是 | 否 | description 常驻，正文调用时载入 |
| `user-invocable: false` | 否 | 是 | description 常驻，正文调用时载入 |
| 两者皆 false | 否 | 否 | 仅受信任的 `ctx.skills.get()` 调用者可见 |

注册与失效（逐字）：`ctx.skills.registerProvider()` / `ctx.skills.register()` **都返回那个"确切的 Cordis effect disposer"**，卸载时注销并让目录缓存失效。变更通过未过滤的 `skills/change` 事件广播（emit 模式，监听器失败被隔离、无法否决注册表变更）。

分层：与 tools registry 同样采用 host + per-scope 分层，读取时合并全局层与 scope 链，**最近层同名条目直接获胜**。

---

### 1.5 MCP 被当成什么：**可组合的 package group + 每 server 一个插件，但明确不是共享服务**

我原本预设 DSH 会把 MCP 做成独立子系统。**官方原文否定了这个预设**，这是本报告的一个反直觉结论。

`docs/subsystems/mcp.md` 逐字：

> **It does not publish a shared `ctx.mcp` service.**

只有 `ctx.mcpResources`（`McpResourceRuntime`）是公开服务，负责跨 server 的三个共享资源工具，按调用者 scope 选 provider。

三层定位（原文组合）：
1. **package group**：MCP 作为一个 package group 被组合进产品 profile
2. **每 server 一个连接插件**：`@deepseek-ai/dsh-mcp-client` 逐字是 "a per-server connection plugin and a consumer of the harness tool registry"
3. **工具来源**：逐字 "Each configured server contributes **ordinary harness tools** with cancellation, permission checks, recorded results, and supported image output."

`docs/cookbook/extension-cookbook.md` 的 feature map 一行给出了最简公式：

> MCP | one plugin per server: discover tools → `ctx.tools.register()`

而 `docs/cookbook/adding-a-tool.md` 明确了 MCP 工具与第一方工具的**同源性**：

> Raw JSON-Schema `ToolDefinition`s are also accepted by `ctx.tools.register()` directly (**that is how MCP-sourced tools arrive**); `defineTool` is the typed helper for first-party tools.

其他 MCP 事实（逐字）：
- MCP server **默认关闭、opt-in**："MCP servers are opt-in."
- 失败韧性："A failed refresh retains the previous tool generation." / "Connection failures do not remove shared resource tools while a visible client entry remains active."
- 不支持项："MCP prompt templates, human-input elicitation, task-based execution, and resource subscriptions are unsupported."
- `serverName` 在 registration scope 内唯一，不同 Agent scope 可复用同名

---

### 1.6 extensions 包：自举能力已被主动移除

`packages/extensions/` 组（逐字）：

> The extensions group provides read-only runtime API discovery for agents, process-local runners for programmatic and browser consumers, and historical generated-plugin cards. **Creator mode installs persistent plugins through Plugin Manager.**

四个子包：

| 包 | 角色 | ctx |
|---|---|---|
| `tool-cordis` | 两个只读的运行时 API 发现工具 | 注册到 `ctx.tools` |
| `cordis-host-runner` | Host 半边：definition 注册表、沙箱化生命周期、inspect 注册表 | `ctx.dynamicCordisRunner`、`ctx.cordisInspect` |
| `cordis-client-runner` | 浏览器半边：把源码求值成活插件 | 浏览器 `ctx.dynamicCordisRunner` |
| `ui-cordis` | 浏览器面板与历史生命周期卡片 | 注册 slots |

**关键：`cordis-host-runner` 的运行时自修改能力仍然存在，但已对模型关闭**（逐字）：

> Host halves run in a `node:vm` realm; browser halves use the Client runner and approval UI. **Definitions disappear on restart.** Agents discover APIs through `tool-cordis` and install persistent bundles through Plugin Manager; **no model tool creates dynamic definitions.**
>
> The shipped Creator workflow uses installed bundles instead of this definition registry.
>
> This package registers no tool or prompt. Programmatic `run` calls and browser controls can steer the owning session with outcomes and diagnostics ... **Shipped model tools cannot create or update dynamic definitions.**

生命周期 API（供程序化 / 浏览器消费者使用）：`define` / `run` / `stop` / `undefine`，`currentPackageId` / `nextPackageId`，`mode: "run" | "update"`。

沙箱边界（诚实声明，逐字）：

> The sandbox isolates globals but **is not a security boundary**: Node globals are absent or redirect to Cordis services (`ctx.fs`, `ctx.web`, `ctx.bash`, the timer helpers), and a host half receives a façade without framework internals, yet the services it declares reach the live runtime. **Treat a dynamic package like bash access.**
>
> `vmTimeoutMs` bounds only synchronous evaluation — an async host-half body escapes it, matching the toolset's cooperative trust stance.

`tool-cordis` 提供的两个只读工具（`docs/tool-catalog.md` 逐字）：
- `cordis_inspect_list`：列出所有 Cordis Inspect Provider（含 Client 同步来的 manifest）
- `cordis_inspect_query(platform, provider, method, input)`：只读查询。**"This Tool cannot invoke business Service methods or modify the runtime."**

---

### 1.7 「创造/生成插件」的交互入口：有，而且有两条

**DSH 有正式的 Creator 模式（agent preset id = `cordis`）。**

**入口 A：Web UI**
`packages/client/ui-plugin-manager/README.md` 逐字，Plugins 页的 **Add plugin** 分裂按钮菜单项：

> **Let the agent create a plugin** | When [ui-agent-preset] contributes this item, closes the menu and opens Creator to author a DSH plugin.

`packages/client/ui-agent-preset/README.md` 补充：

> **Let the agent create a plugin** in the Plugins page's **Add plugin** arrow menu enters the same Creator flow as Settings. **It submits no message and preserves unsent drafts.** While the roster loads or Creator is unavailable, the menu item is disabled with an explanation. Both entries show a Toast with the reason if the Host refuses the preset switch.
>
> Entering Creator selects `cordis` for the receiving blank Session without changing the new-task default or Coding Tools setting.

即：**不是发一条神奇提示词，而是切换到 `cordis` preset 起一个新任务**。

**入口 B：Settings 的 Creator 卡片**
> a group without presets is omitted, except the custom group, which keeps its Creator entry on screen.

**模式对模型可见的差异（我做了逐行 diff）**

对比 `packages/bundle/web-app/presets/standard.patch.yml`（default）与 `presets/cordis.patch.yml`（Creator）：

```
standard rows: 35
cordis   rows: 36
ONLY in cordis  : ['preset-cordis', 'tool-cordis']
ONLY in standard: ['preset-standard']
```

去掉各自那一行 preset 声明后，**cordis preset 的插件 id 集合与 standard 完全一致，只多一个 `tool-cordis`**：

```yaml
# cordis.patch.yml 末尾（Creator 独有）
- id: tool-cordis
  name: '@deepseek-ai/dsh-tool-cordis'
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: !!js "!ctx.get('profileContext')"
```

而 `standard.patch.yml` 里同一行是：

```yaml
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
```

**结论：creator 相对 default 的工具面差异 = `+cordis_inspect_list` / `+cordis_inspect_query` / `+plugin_manager`，以及 `plugin_manager` 从禁用变为启用。没有任何"通用能力工具"被加进来。**

`tool-cordis` 的自我描述也印证（逐字）：

> **Creator mode includes this toolset.** Other compositions mount `@deepseek-ai/dsh-tool-cordis/host` once in the host composition ... and `@deepseek-ai/dsh-tool-cordis` in each agent preset that exposes the tools; a preset row alone registers no Host providers.

**Agent 侧的 3 个 Creator 专属 skill**（目录 `packages/preset/agent-preset/skills/`，我通过仓库树确认）：
- `cordis-plugin-development/SKILL.md` —— 主工作流
- `editing-cordis-compositions/SKILL.md` —— 改 agent preset
- `cordis-composition-reference/SKILL.md` —— Loader YAML 方言速查

主 skill 的工作流（`cordis-plugin-development` 逐字，节选）：

> For implementation, use ordinary workspace files to author a bundle, then `plugin_manager` with `action: install_bundle` and the absolute package directory as `target` to install it in the current profile. Changes affect every session in that profile and survive restart.
>
> **Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory**: `install_bundle` performs those steps, and each hand-made write outside the workspace needs its own approval.
>
> 2. Discover only the APIs needed for that version: `cordis_inspect_list`, then targeted `cordis_inspect_query` calls. ... **Once the chosen slot and registration API are known, write the plugin.**
>
> 3. Read and copy the matching template files into one workspace directory ... **Use the installed plugin as the first preview; do not create preview HTML, mock shells, design variants, screenshot scripts, or rasterizer tooling first.**

注意 step 2 的措辞：**先查 API 再写插件**——这正是"先把工具面补齐，再让 Agent 写插件"的顺序。

---

### 1.8 信任边界（官方声明相当坦诚）

`SAFETY.md` 逐字：

> DeepSeek Harness is experimental developer-preview software. **It has not undergone a security audit and must not be treated as secure or production-ready.**
>
> The project can execute model-generated code and commands, load third-party plugins, and access the network, processes, credentials, and files made available to it.
>
> Sandboxing, approval prompts, and permission controls can reduce risk, but **they do not guarantee isolation or prevent damage.**
>
> **Do not rely on DeepSeek Harness as the sole security control for untrusted workloads.**

`packages/boot/plugin-manager/README.md` 的权限模型（逐字）：

> **Every tool action requires `danger-full-access` or approval for that call.** Under lower sandbox modes, `ask` requests approval; `never`, rejection, cancellation, or an unavailable approval channel prevents execution. An approval leaves the session permission mode unchanged. **Profile changes persist across sessions, and installed Host code executes in-process outside the workspace sandbox.**

第三方插件的风险提示（社区目录 `awesome-dsh-plugin` 自述，非官方文档，仅作佐证）：

> Installing any third-party dsh plugin runs its code on your machine with your own permissions. Being listed here is not a security review.

其他边界机制（`docs/subsystems/claude-code-mods.md`，官方且非常坦诚——对标 Claude Code 的兼容层）：

> Mods run in-process with `$` as their only access to the host | The hooks module runs in-process with Node's globals, no access rule, and **the process's full authority**: `$.env` reads and writes the harness environment, `$.http.fetch` reaches any URL, `$.fs` and `$.tool.call` act as the session | **No sandbox is applied to mods**; mount only mods you would run as a plugin

兼容性豁免机制（`docs/subsystems/boot.md` + plugin-manager README）：`compatibility.json` 里 `package-name@version` → 允许的 DSH 运行时版本列表；授予需 `acceptRisk: true`，且"Version exemptions do not authorize dependency scripts"。

---

## 2. 其他产品（逐个附官方来源）

### 2.1 Anthropic Claude（Claude Code plugins + Agent Skills）

**插件形态：目录 + 可选 manifest。**

`code.claude.com/docs/en/plugins/overview` 逐字：

> A plugin is a directory of components, usually with a manifest. The manifest, a JSON file at `.claude-plugin/plugin.json`, gives the plugin its name and can add a version, a description, and other metadata.

贡献类型（逐字列举）：
> - **Skills**: `SKILL.md` instructions Claude loads when relevant, and that you can also run as a command
> - **Agents**: subagent definitions Claude can delegate to
> - **Hooks**: commands Claude Code runs at points in its lifecycle
> - **A hooks module**: hooks written as JavaScript functions, which can also draw panes and add commands. A plugin that has one is called a mod
> - **MCP servers**: tool servers Claude Code connects to while the plugin is enabled

官方仓库 `anthropics/claude-plugins-official` 给出的目录结构（逐字）：
```
plugin-name/
├── .claude-plugin/plugin.json    # Plugin metadata (required)
├── .mcp.json                     # MCP server configuration (optional)
├── commands/                     # Slash commands (optional)
├── agents/                       # Agent definitions (optional)
├── skills/                       # Skill definitions (optional)
└── README.md
```
（另据该仓库，`lspServers`、`outputStyles`、`experimental.themes`/`monitors`、`userConfig`、`channels`、`dependencies` 也可声明——见 manifest reference。）

**关键：Skills / subagents / hooks / MCP servers 全部可以脱离插件独立存在。**
> Skills, subagents, hooks, and MCP servers all work on their own, without a plugin.

所以 Claude 的"插件"是**打包分发单元**，不是运行时扩展点机制。

**卸载 / 可逆性：只有关闭，没有运行时卸载。**
`code.claude.com/docs/en/plugins/loading` 逐字：
> **Loaded, in the running session**: the plugin set Claude Code loaded at startup or at the last `/reload-plugins`. Changes to settings or to disk don't reach this layer until you run `/reload-plugins` or start a new session. That is why `claude plugin update` ends with `Restart to apply changes.`

`code.claude.com/docs/en/plugins/overview`：
> To stop it without uninstalling: disable the plugin with `/plugin` or, in your shell, `cline plugin disable`（原文为 `claude plugin disable`）。

**已启用插件的影响面（官方明确警告，逐字）**：
> An enabled plugin is part of every session, not only the sessions where you use it.
> - **Context and usage**: for each skill, agent, and command that Claude can invoke on its own, the name and description are in Claude's context on **every turn** ... Those tokens count toward your usage and leave less room in the context window **even in sessions where nothing from the plugin runs**.
> - **Permissions**: what the plugin runs, it runs as you.

**Agent Skills 标准**（`code.claude.com/docs/en/skills`）：
- 遵循 Agent Skills 开放标准（`agentskills.io`），Claude Code 额外扩展
- SKILL.md = YAML frontmatter + markdown 正文；`description` 会与 `when_to_use` 一起被截断到 **1536 字符**
- 渐进式披露：目录描述常驻上下文，正文只在调用时载入；`SKILL.md` 建议 < 500 行，细节拆到 `reference.md` / `examples.md` / `scripts/`
- 大量 frontmatter 字段：`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context: fork`、`agent`、`background`、`hooks`、`paths`、`shell`、`metadata`……
- 打包/上传到 claude.ai 时**只允许 spec 白名单字段**，多一个就硬失败：`Unexpected key(s) in SKILL.md frontmatter: argument-hint. Allowed properties are: allowed-tools, compatibility, description, license, metadata, name`

### 2.2 OpenAI GPTs / Apps SDK

⚠️ **`developers.openai.com` 全站对本环境返回 403 Forbidden / fetch failed**，因此 Apps SDK 的组件模型、manifest 字段、`_meta` 契约**未查到官方一手页面**。

仅确认到官方公告（`https://openai.com/index/introducing-apps-in-chatgpt/`）逐字：
> Developers can start building and testing apps today with the new Apps SDK preview, which we're releasing as an **open standard built on the Model Context Protocol (MCP)**.
>
> The Apps SDK builds on the Model Context Protocol (MCP), the open standard that lets ChatGPT connect to external tools and data. **It extends MCP so developers can design both the logic and interface of their apps.**
>
> **We've made the Apps SDK open source so that apps built with it can run anywhere that adopts this standard.**

可从公告确定的结论：**ChatGPT 的扩展模型 = MCP + UI 组件**，没有"Agent 自己装插件"的入口；且 Apps SDK 是 MCP 的**扩展**而非替代。GPT Store / Actions 的分层机制**未查到官方一手来源**。

### 2.3 Google Gemini / ADK

`https://adk.dev/plugins/`（由 `google.github.io/adk-docs/plugins/` 重定向而来）逐字：

> A Plugin in Agent Development Kit (ADK) is a custom code module that can be executed at various stages of an agent workflow lifecycle using callback hooks.
>
> An ADK Plugin extends the `BasePlugin` class and contains one or more `callback` methods ... You integrate Plugins into an agent by registering them in your agent's `Runner` class.
>
> While a typical Agent Callback is configured on a *single agent*, a single *tool* for a *specific task*, a Plugin is registered *once* on the `Runner` and its callbacks apply *globally* to every agent, tool, and LLM call managed by that runner.

三种 hook 模式（逐字）：**To Observe**（无返回值）/ **To Intervene**（返回值短路工作流）/ **To Amend**（改 Context）。

回调清单：`on_user_message_callback`、`before/after_run_callback`、`before/after_agent_callback`、`before/after_model_callback`、`on_model_error_callback`、`before/after_tool_callback`、`on_tool_error_callback`、`on_event_callback`。

优先级陷阱（逐字）：
> Plugin callback functions have precedence over callbacks implemented at the object level ... Any Plugin callbacks code is executed *before* any Agent, Model, or Tool objects callbacks are executed. Furthermore, if a Plugin-level agent callback returns any value, and not an empty (`None`) response, the Agent, Model, or Tool-level callback is *not executed* (skipped).

**装载方式：编程式**（Runner 构造函数的 `plugins=[...]`，Python/TS/Java/Go/Kotlin 各语言）。**没有声明式 manifest，没有分发/安装/卸载机制。ADK 的 Plugin 只贡献 callback，不贡献 tool。**

### 2.4 Cline（开源 coding agent）

`https://docs.cline.bot/customization/plugins`：

插件形态：**四种源**——file URL（单个 `.ts`/`.js`）、git 仓库（支持 `@ref`）、npm（`npm:@scope/pkg`）、本地路径。安装到 `~/.cline/plugins/_installed/{npm,git,remote,local}` 或项目 `.cline/plugins/`。

manifest 逐字（官方示例）：
```json
{
  "name": "my-cline-plugin",
  "version": "1.0.0",
  "cline": {
    "plugins": [
      { "paths": ["./index.ts"], "capabilities": ["tools", "hooks"] }
    ]
  }
}
```
> If no `cline.plugins` field is present, the installer falls back to auto-discovery

贡献类型（逐字）：
> Plugins extend Cline with custom tools, lifecycle hooks, slash commands, and more.
> Plugins extend Cline with custom tools, hooks, and capabilities.

宿主提供的依赖（值得注意的设计，逐字）：
> Dependencies under the `@cline/` scope are provided by the host runtime. The installer automatically strips these from the plugin's dependency list before running `npm install` ... The host currently provides `@cline/sdk`, `@cline/core`, `@cline/agents`, `@cline/llms`, and `@cline/shared`.

注册 API（`https://docs.cline.bot/sdk/guides/creating-custom-tools`）：`api.registerTool(tool)`；工具用 `createTool({ name, description, inputSchema (zod), execute })`。

限制（逐字）：
> <Warning> This feature currently only applies to Cline SDK, CLI, and Kanban. This feature is not applicable on VSCode and JetBrains Extension for now.

### 2.5 LangChain / LangGraph

`https://docs.langchain.com/oss/python/langchain/overview`：
> **Agent = Model + Harness.** LangChain provides `create_agent`: a minimal, highly configurable agent harness. The harness is everything around the model loop: the prompt, the tools, and any **middleware** that shapes behavior.

`https://docs.langchain.com/oss/python/langchain/middleware/overview`：
> Middleware provides a way to more tightly control what happens inside the agent ... Transforming prompts, **tool selection**, and output formatting. Adding retries, fallbacks, and early termination logic. Applying rate limits, guardrails, and PII detection.

关键设计（逐字）：
> **Middleware is not a separate runtime**: hooks run inside the compiled LangGraph that `create_agent` returns.

middleware 即"围绕 agent loop 的 hook 包装"，与 DSH 的 waterfall 概念相近，但是**构造期传入的数组**，不是运行时装载的插件。**无分发/安装/卸载/信任边界机制**——它是进程内的库调用。

### 2.6 AutoGen（AG2 / Microsoft）

`https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/tools.html`：
> In AutoGen, every tool is a subclass of `BaseTool`, which automatically generates the JSON schema for the tool.
> The model client takes the list of tools and generates a JSON schema for the parameters of each tool.

注册是**构造期传列表**（`tools=[...]` / `ToolUseAgent.register(runtime, ...)`）。无插件分发机制。Core 层刻意最小：
> Note: The Core API is designed to be minimal and you need to build your own agent logic around model clients and tools.

### 2.7 MCP 规范本身

`https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro`：
> MCP (Model Context Protocol) is an open-source standard for connecting AI applications to external systems ... Think of MCP like a USB-C port for AI applications.

生态广泛支持（原文列举 Claude、ChatGPT、VS Code Copilot、Cursor、MCPJam 等）。
⚠️ **MCP 规范中的 security/trust 章节本环境未能取到（`modelcontextprotocol.io/specification/latest` fetch failed）**，故 MCP 官方的信任模型细节**未查到**。

### 2.8 Dify / Coze / 扣子

**未查到。** `docs.dify.ai` 的三个候选路径分别返回 404 / 重定向到首页 / 重定向到不存在的路径。二手来源一律不作为结论依据，故 Dify 插件体系（tool/agent/model/provider 四类、`manifest.yaml`、依赖声明、daemon 打包）**本报告不做任何断言**。Coze / 扣子未查。

---

## 3. 横向对照表

字段：产品 / 插件形态 / 贡献类型 / 装载时机 / 卸载（可逆？）/ 权限与信任边界 / 官方来源 URL

| 产品 | 插件形态 | 贡献类型（可多选） | 装载时机 | 卸载 / 可逆性 | 权限与信任边界 | 官方来源 |
|---|---|---|---|---|---|---|
| **DeepSeek Harness** | npm 包 / git 仓库 / 本地目录；清单 = `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` Loader 行 | 工具、UI 面板、hook 拦截、提示词分段、服务（模型适配器/沙箱/会话存储/**agent loop 本身**）、MCP 连接、skill、命令、subagent | 启动时按 profile 分层组合；支持 HMR 热重载（配置级）；**bundle 成员变更需重启 profile** | ✅ **运行时可逆**：所有注册是 `ctx.effect` / `ctx.on`，fiber 卸载按**逆序**执行 disposer；`setPluginEnabled` 即时卸载单个 row。`remove_bundle` 四步有序卸载 | `plugin_manager` 每个 action 都需 `danger-full-access` 或逐次审批；`SAFETY.md` 明说**未经安全审计**、沙箱**不构成安全边界**；版本豁免需 `acceptRisk` | [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [cordis-primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md) · [fiber](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/fiber.md) · [plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md) · [SAFETY](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) |
| **Claude Code plugins** | 目录（`.claude-plugin/plugin.json` 可选但推荐）；来源 = marketplace / `--plugin-dir` / skills 目录 / claude.ai 同步 | skill、subagent、hook（命令式）、hooks module（"mod"，JS 函数）、MCP server、LSP server、output style、channel | 会话启动时或 `/reload-plugins` 时；从 `installed_plugins.json` + cache 离线加载 | ⚠️ **只能禁用**（`enabledPlugins: false`），无运行时卸载；改设置/磁盘**必须** `/reload-plugins` 或新会话生效。更新依赖重启 | "what the plugin runs, it runs as you"；project-scope 插件的 MCP server 走**与 `.mcp.json` 相同的逐 server 审批**；synced 插件可被组织强制 required | [overview](https://code.claude.com/docs/en/plugins/overview) · [loading](https://code.claude.com/docs/en/plugins/loading) |
| **Claude Skills（独立于插件）** | 单个 `SKILL.md`（+ 可选同目录附属文件） | 纯提示词 / 流程指令 | 会话启动时把 `description` 注入上下文（**每轮都占 token**）；正文按需载入 | ✅ 纯文件，删文件即失效；无残留 | `allowed-tools` / `disallowed-tools` 在调用该 skill 的那一轮授予/移除，下一条用户消息即清除 | [skills](https://code.claude.com/docs/en/skills) |
| **OpenAI Apps SDK / GPTs** | ⚠️ 未查到（一手页面 403） | 公告只确认：MCP 工具/数据 + 界面组件 | 未查到 | 未查到 | 未查到 | [公告](https://openai.com/index/introducing-apps-in-chatgpt/)（仅公告级信息） |
| **Google ADK** | Python/TS/Java/Go/Kotlin 类，`BasePlugin` 子类 | **仅 lifecycle callback**（观察/介入/修正）；**不贡献 tool** | 构造期：`Runner(plugins=[...])`，回调全局作用于该 runner 的每个 agent/tool/LLM 调用 | ✅ 构造期对象，无需卸载；但**无分发/安装机制** | 无内建权限模型；靠进程权限 | [adk.dev/plugins](https://adk.dev/plugins/) |
| **Cline** | 单个 `.ts`/`.js` 文件，或带 `package.json` 的目录；清单 = `cline.plugins[{paths, capabilities}]` | tool（`createTool` + zod）、lifecycle hook、slash command | 会话启动时；支持 `@ref` 指定 git 分支/tag | ⚠️ 有 `--force` 覆盖安装、`cline config` 查看；**未查到运行时卸载 API** | `@cline/*` 由宿主提供并在装包前剥离；未查到权限模型 | [plugins](https://docs.cline.bot/customization/plugins) · [custom-tools](https://docs.cline.bot/sdk/guides/creating-custom-tools) |
| **LangChain middleware** | 类/对象，构造期传入 | agent loop 的 hook 包装（提示词变换、工具选择、重试/降级、限流、PII 脱敏） | `create_agent(middleware=[...])` 构造期 | ✅ 构造期对象，无运行时装载概念 | 无（进程内库） | [middleware](https://docs.langchain.com/oss/python/langchain/middleware/overview) · [overview](https://docs.langchain.com/oss/python/langchain/overview) |
| **AutoGen** | `BaseTool` 子类实例 | tool（自动生成 JSON schema） | 构造期传 `tools=[...]` | ✅ 构造期对象 | 无 | [tools](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/tools.html) |
| **Dify / Coze / 扣子** | 未查到 | 未查到 | 未查到 | 未查到 | 未查到 | — |

---

## 4. 三个横向结论

### 4.1 「插件」贡献什么——四种贡献类型的正交分解

把各家拆开看，插件贡献的东西落在四个互不重叠的维度上：

1. **能力（capability）**：新工具 / 新模型 / 新沙箱后端 —— DSH、Cline、LangChain、AutoGen
2. **指令（instruction）**：提示词分段 / skill 正文 —— Claude Skills、DSH skills 子系统、DSH `systemPrompt.section()`
3. **拦截（interception）**：hook / waterfall / callback —— DSH `tools/*`+`agent/*`、ADK callbacks、LangChain middleware、Cline hooks
4. **分发（distribution）**：可安装、可版本化、可卸载 —— **几乎只有 DSH 与 Claude Code 做到**

**关键洞察：主流 Agent 产品的「插件」绝大多数只覆盖 1–3，唯二覆盖第 4 维的是 DSH 与 Claude Code。而 DSH 是唯一把 4 个维度统一在一个 `ctx` 对象契约下的。**

DSH 官方甚至把这件事做成了可检查的声明（`docs/cookbook/extension-cookbook.md`）：

> **Every product feature maps to a listener on a documented extension point — the microkernel claim made checkable.** No row modifies the loop.

### 4.2 「真正的运行时可逆」——只有 DSH

判据是三个同时成立的性质：
1. 卸载后不留残留
2. hook 能恢复到卸载前状态
3. 逆序释放（teardown order 可控）

DSH 三条全有，且有官方原文逐条支撑：`ctx.effect` 逆序 disposer + fiber 卸载自动触发 + `ctx.on` 监听器由 fiber 拥有。

对比：
- **Claude Code** 明确要求 `/reload-plugins` 或重启 —— **不满足 1/2**
- **Cline** 未查到运行时卸载 —— 不能断言其不可逆，但也没有 DSH 那样的保证
- **ADK / LangChain / AutoGen** 是构造期注入，不涉及运行时状态 —— 严格说"不存在卸载问题"，但也**不提供运行时可插拔性**

DSH 的一条补充设计也值得 slime 注意 —— disposer 的**身份**是承重的（`docs/subsystems/core.md`）：

> a composite (generator) effect that owns a teardown ORDER ... must yield THIS function so Cordis nests the unregistration at that yield position; yielding a wrapper would leave it disposing as a concurrent sibling on owner unload

即：**不能把 disposer 包一层再交出去**，否则会破坏卸载顺序。这是一条容易踩的实现细节。

### 4.3 MCP 在各家体系里的位置——横向结论

**MCP 一律是「工具的一种来源」，不是独立子系统。** 证据：

| 产品 | 证据 | 定位 |
|---|---|---|
| DSH | "one plugin per server: discover tools → `ctx.tools.register()`"；"It does not publish a shared `ctx.mcp` service."；MCP 工具是 "ordinary harness tools" | 工具来源 |
| Claude Code | 插件可声明 `mcpServers`；且 MCP server **可脱离插件独立使用** | 工具来源 |
| OpenAI Apps SDK | 公告："The Apps SDK **builds on** the Model Context Protocol ... It **extends** MCP" | 工具来源（且反向：MCP 是基座） |
| Gemini ADK | Plugin 页只讲 callback，**未提 MCP** | 未查到 |

**推论：MCP 是一个"外部工具的接入协议"，而各产品都把它降解成自己工具注册表里的一批普通条目。** MCP 本身**不是**运行时扩展点机制（不能注册 hook、不能贡献提示词分段、不能改 UI 面板）。这与 DSH 把「自己的插件系统」建立在 Cordis 而非 MCP 之上，是同一个判断。

---

## 5. 关键发现：DSH 曾经做了「让 Agent 直接生成并运行插件」，然后主动删掉了

这是本报告对 slime 最有直接参考价值的一节。

### 5.1 官方决策原文

`.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md`，状态 `implemented`，逐字：

> **## Problem**
>
> **Agents need to install capabilities and use them during the same conversation. Generated-code tools create a second plugin lifecycle alongside ordinary installed bundles.**
>
> **## Decision**
>
> **Creator mode enables the existing `plugin_manager` tool.** Agents author packages and Loader YAML patches as workspace files, then install them through `install_bundle`. An MCP connection is a configuration-only bundle inserting the installed `dsh-mcp-client`; a UI bundle includes a Host entry and a Client artifact. **Profile locking, package installation, enablement and HMR remain owned by the existing manager.** The entire management tool requires `danger-full-access` or approval for one call: **profile changes can load code with host permissions and affect other sessions.**
>
> The model sees two read-only Cordis inspection tools. **Generated-code define/run/stop/undefine and dynamic self-inspection tool APIs are absent.**
>
> **## Alternatives considered**
>
> **Generic entry CRUD and an MCP-specific management API duplicate operations expressible as bundle files plus existing installation and enablement. They are unnecessary for prompt-driven installation. Moving generated-code versioning into Plugin Manager retains two lifecycles without providing ordinary package persistence.**
>
> **## Consequences**
>
> **Side effects belong to the plugin lifecycle, including stylesheet cleanup.**
>
> A built Web profile test installs an MCP bundle, checks existing and new Creator sessions, restarts the process, and **verifies tool disposal after bundle removal**.

对照 `packages/extensions/cordis-host-runner/README.md` 现状（逐字）：
> no model tool creates dynamic definitions.
> Shipped model tools cannot create or update dynamic definitions.

**时间线（据文件日期）**：`.agents/notes/archived/feature/2026-08-10-creator-guidance-introduce-cue.md`（2026-08-10，Creator 早期是提示词引导）→ `2026-09-16-creator-persistent-plugin-management.md`（2026-09-16，改为持久 bundle）→ `2026-09-21-creator-skills-progressive-disclosure.md`（2026-09-21，改为渐进披露的 skill）。

archived 笔记里有一句极有信息量（逐字）：
> The cue is pure presentation: it is client-side seat-store state, **never a session event, because the model-visible composition is already carried by the staged preset itself.**

——即 **"模型看到的组合"由 preset 承载，而不是靠提示词描述**。

### 5.2 裁决：creator 与 default 同工具面，很可能是对的

对 slime 的问题 5 裁决如下，**每条都有官方来源**：

| 论据 | 官方来源 |
|---|---|
| DSH 的 creator preset 相对 standard **只多 1 个插件包**（`tool-cordis`，含 2 个只读工具）+ `plugin_manager` 启用。**没有加任何"通用创造能力"工具。** | 我对 `packages/bundle/web-app/presets/{standard,cordis}.patch.yml` 的逐行 diff |
| creator 模式把写代码的**能力**放在 skill（提示词/流程）里，把**落地的权限**放在一个受管控的安装工具里，而不是"给 Agent 更多工具" | `cordis-plugin-development/SKILL.md`、`docs/tool-catalog.md` |
| 官方明确否定了"第二套插件生命周期" | `2026-09-16-creator-persistent-plugin-management.md` |
| 官方明确否定了"动态生成代码"这条路，并把副作用归回插件生命周期 | 同上 + `cordis-host-runner/README.md` |
| Claude Code 的做法也是"插件里带 skills + MCP"，而非"给 Agent 加创造工具"；且官方警告已启用插件的 skill 描述**每轮都占 token**，即便该会话里什么都不跑 | `code.claude.com/docs/en/plugins/overview` |

**因此：「给 Agent 多挂工具」在两家最认真做过这件事的产品里都没有先例，且都有反向证据。** slime 现状（creator 与 default 同一个 `DEFAULT_TOOL_PROFILE`）**更接近 DSH 的选择，而不是偏离它**。

但要注意一个重要 nuance：**DSH 的 creator 与 default 并非完全同工具面** —— 它多挂了 `plugin_manager` + `cordis_inspect_*`。也就是说 DSH 的答案是「同工具面 + 少量专用管控工具 + 大量 skill 指导」，而不是「同工具面，什么都不加」。

---

## 6. 对 slime 的启示（可执行结论）

> 每条都标注证据来源。凡未标注即为我的设计判断（已单独标出），不与官方证据混淆。

### 结论 1：不要给 creator 模式加"创造类工具"，要把创造流程写进 skill/skill 等价物

DSH 的 creator 相对 default **只多 3 个工具**（`cordis_inspect_list`、`cordis_inspect_query`、`plugin_manager`），其中 2 个是只读查询、1 个是受管控的安装入口。它把"怎么写插件"的知识全部放进 `packages/preset/agent-preset/skills/` 下的三个 SKILL.md（`cordis-plugin-development` / `editing-cordis-compositions` / `cordis-composition-reference`）。

**行动**：slime 的 `creatorGuide()` 单段提示词是正确方向的第一步，但应当拆成**可按需加载的多个 skill**（描述常驻、正文按需载入），对应 DSH 的渐进披露结构。至少覆盖：插件清单格式、Loader/注册行语义、安装与验证流程。

> 证据：`packages/preset/agent-preset/skills/`（三个文件，已逐字读取）；`docs/subsystems/skills.md`；我实测的 preset diff。

### 结论 2：先建"可逆"的注册原语，再谈插件系统

DSH 全部可逆性压缩在一个原语上：`ctx.effect(execute, label?)` —— 立即执行、收集 disposer、**逆序**释放、fiber 卸载时自动触发、二次调用是 no-op。`ctx.on()` 的监听器同理由 fiber 拥有。

**行动**：在 slime 里定义一个等价的 `effect()`（哪怕先只是 `Disposer[]` 的逆序释放 + owner 绑定），并**强制**所有能力注册走它：工具注册、prompt section、MCP 工具、hook listener。如果这一步不做，后面任何"插件系统"都会留下卸不干净的残留。

> 证据：`docs/cordis-api/fiber.md`（签名 + 逆序 + 双重触发逐字）；`docs/cordis-primer.md`（"Registrations are reversible effects" + "Every registration should have a disposer"）。

### 结论 3：desposer 身份是承重的，不要包一层

DSH 明确写了：composite（generator）effect 想控制 teardown 顺序时**必须 `yield` 那个确切的 disposer 函数**，包一层会让它在 owner 卸载时变成并发兄弟，从而"在最后一轮还在 drain 时就注销 agent"。

**行动**：slime 的 effect 实现不要写成 `() => { wrapper(); inner(); }`。要么直接透传，要么明确定义顺序契约。

> 证据：`docs/subsystems/core.md`（"Exact identity is load-bearing" 整段）。

### 结论 4：把 creator 模式与 default 的差异收窄到「读 + 受管控的写」，并且写操作要逐次审批

DSH 的 `plugin_manager` 每个 action（含 `list_plugins` 这种只读列举）**都要 `danger-full-access` 或逐次审批**，且"一次授权不改会话权限模式，但 profile 变更会跨会话持久化"。默认 preset 里这一行是 `disabled: true`。

**行动**：slime 若要给 creator 一个"落地"入口（写文件 + 装上），就照这个形状做：默认不给，逐次审批，且明示"影响该 profile 的所有会话"。**不要**做成一个常驻的高权限工具。

> 证据：`packages/boot/plugin-manager/README.md`（权限段逐字）；`packages/bundle/base/cordis.patch.yml`（`tool-plugin-manager` 的 `disabled: true`）。

### 结论 5：MCP 只当"工具来源"，不要为它建独立子系统

横向结论：DSH、Claude Code、OpenAI Apps SDK 全都把 MCP 降解成自己工具注册表里的普通条目。DSH 甚至明确"不发布共享 `ctx.mcp` 服务"，把跨 server 的共享部分单独做成 `ctx.mcpResources`。

**行动**：slime 的 MCP 接入继续沿用"MCP server → 注册为普通工具"的路线，**不要**为它设计独立的服务对象/事件词汇。若有多 server 共享资源的需求，单独开一个 `mcpResources` 式的服务，不要让 server 概念渗进核心。

> 证据：`docs/subsystems/mcp.md`；`docs/cookbook/extension-cookbook.md` feature map；`docs/cookbook/adding-a-tool.md`（"that is how MCP-sourced tools arrive"）。

### 结论 6：主动砍掉"让 Agent 生成并运行代码"的第二套生命周期

这是 DSH 花了一个多月才做出的结论，值得直接抄。它删掉的理由不是安全洁癖，而是**架构重复**："Generated-code tools create a second plugin lifecycle alongside ordinary installed bundles."

**行动**：如果 slime 未来考虑"Agent 现场写一个插件并热加载"，先回答一个问题：**这个插件的生命周期由谁拥有、如何卸载、卸载后 agent 的工具面怎么恢复？** 如果答案是"另一套 loader + 另一个 registry + 另一个清理路径"，那就按 DSH 的判据拒绝它，改走"写成 bundle/文件 → 走同一个安装入口"。

> 证据：`.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md`（Problem 与 Alternatives considered 逐字）；`packages/extensions/cordis-host-runner/README.md`（"no model tool creates dynamic definitions"）。

---

## 7. 本报告的局限

### 7.1 未查到的（明确列出，不做推断）

| 项 | 原因 |
|---|---|
| **OpenAI Apps SDK / GPTs / Actions 的组件模型、`_meta` 字段、manifest 结构、GPT Store 的插件模型** | `developers.openai.com` 全站对本环境返回 403 Forbidden。仅取到官方发布公告页，够不到参考文档。搜索结果里出现了大量第三方转述（含 GitHub 上的 skill 仓库、gist），**按要求已全部排除，不作为结论依据**。 |
| **MCP 规范的安全 / 信任模型章节** | `modelcontextprotocol.io/specification/latest` fetch failed；只取到 intro 页。 |
| **Dify / Coze / 扣子 的插件体系** | `docs.dify.ai` 三个候选路径全部 404 或重定向到首页。未做任何断言。 |
| **Cline 的运行时卸载语义** | 官方文档只写了 `--force` 覆盖安装与 `cline config` 查看，未查到卸载 API。不能断言其不可逆。 |
| **DSH 的 `dsh.bundle` manifest 完整 schema** | `docs/cookbook/adding-a-package.md` **没有**列出 `"dsh"` 字段的完整 schema。本报告中的 bundle 清单字段来自 `editing-cordis-compositions/SKILL.md` 的**官方示例**（是官方给出的可用样例，但不是规范文档）。`docs/config-catalog.md` 未逐字读取。 |
| **DSH 各 `ctx.*` 服务的完整方法签名** | 只逐字读取了 `core.md` / `tools.md` / `skills.md` / `mcp.md` / `boot.md` / `extensions.md` / `scope.md` 的服务部分。`docs/subsystems/` 下其余 ~50 个页面（`shell.md`、`fs`、`jobs`、`approval`、`commands` 等）与 `docs/service.md` 未逐字读取，故 §1.2 表格中后 14 行服务只列名字、不列签名。 |
| **DSH 文档站 `deepseek-harness.github.io` 的实际内容** | 客户端渲染单页，WebFetch 只能取到站点标题。子路径（`.html` 与无后缀）均 404，无 sitemap。全部结论改由 GitHub 仓库 `docs/` 原文取得。 |
| **DSH 第三方插件生态的规模与质量** | `awesome-dsh-plugin`（社区维护）自称"well over a thousand community plugins"，但这是二手来源且无可验证统计，**未采信任何数量结论**。 |
| **"Agent 自己创建插件"这件事的公开踩坑记录** | **未查到官方来源的踩坑复盘。** 我找到的最接近的是 DSH 官方决策文档里的两行"Problem/Alternatives considered"，那是我唯一的证据依据（二手教程里的"我试了，效果不错"一律未采信）。 |

### 7.2 属于间接推断的部分（已标注，但仍是推断）

1. **§5.2 的"裁决"是推断。** 我把 DSH 的 preset diff + 决策文档外推到 slime 的架构决策上。DSH 的形态受它的 Cordis 技术栈、Electron 宿主、`node:vm` 沙箱可用性约束；slime 若目标平台不同（如纯浏览器、无 Node 子进程），部分结论可能不适用。
2. **§4.2 的"只有 DSH 做到了运行时可逆"是基于"已查到的官方文档"得出的。** 对 ADK / LangChain / AutoGen 我确认了它们是构造期注入（因此不存在运行时卸载问题），但我**没有**逐字核查它们是否另有运行时装载 API。Cline 可能存在但我未查到。
3. **`cordis-host-runner` 的 `node:vm` 沙箱能力我没有实测。** 我只读了它的官方声明（"isolates globals but is not a security boundary"）与 `vmTimeoutMs` 的边界说明（"bounds only synchronous evaluation — an async host-half body escapes it"）。这条逃逸路径是文档自述，我没有独立验证。
4. **DSH 的 star/fork 数量（244219 / 29256）是 2026-10-06 的快照**，且该仓库创建于 2026-08-13（三周内）。数量本身可能受刷量影响，我不据此推断任何质量结论。
5. **preset diff 我是用正则提取 `- id:` 行做的集合比对**，不是完整 YAML 语义 diff。配置值差异（例如同 id 但 config 不同）不在我的比对范围内。我逐字读过两个文件的完整内容，视觉上未发现其他差异，但严格意义上这是"未穷尽验证"。

### 7.3 方法论说明

- 二手来源（BestHub、CSDN、awesome-dsh-plugin、第三方 skill 仓库、各类 gist）**只用于发现官方 URL**，所有进入本报告的结论都回溯到 `github.com/deepseek-ai/deepseek-harness`、`code.claude.com`、`adk.dev`、`docs.cline.bot`、`docs.langchain.com`、`microsoft.github.io`、`modelcontextprotocol.io`、`openai.com` 原文。
- 官方文档同时提供 `.en` 与 `.zh` 版本（DSH 每页都有 `.zh.md`），本报告引用英文原文并译为中文，以避免翻译引入歧义。
- 仓库全量文件树（14208 个 blob）用于定位 Creator 模式相关文件，这是唯一一处使用非 WebFetch 的网络调用。
- **本次调研未创建、未修改 slime 项目的任何文件**，除本报告 `docs/plugin-ecosystem-survey.md` 外无任何写操作；未安装任何依赖，未运行 build/test。