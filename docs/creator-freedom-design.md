# 高自由度创造模式 —— 分层设计（面向深度/资深用户）

> 用户口径（2026-10-06）：「我要的创造模式是那种**高自由度**的，可以自己**指挥 Agent 为 slime 做插件**，
> 自己通过指挥 Agent **形成自己的工作模式**，自己**定义 Agent-Loop** 的，等等一系列自由度极高的模式，
> 这个模式也是**专门面向深度、资深用户**的。」
>
> 用户口径（2026-10-07，本轮追加）：「自由度还是不够…… 现在的扩展更像一个 skill，
> 我希望通过扩展自由支配 slime 的方方面面，UI、设置……」
> 「我愿意把 slime 的改动权限放开点（**主干别坏就行**）」
> 「甚至能开发一个**连 Agent-Loop 都没有**、纯粹由用户定义的模式」
>
> 本文是这条产品方向的落地设计：**盘点已有自由度 → 分层定义「还缺什么」→ 每层的操作面与边界**。
> 轮次记录：A-1195（creator 第一版落地：`plugin_status` + 自验四步）→ A-1196（L3 参数化 + 能力自述）
> → **A-1198（本文：L4 从路线图升级为可执行方案，四个诉求逐条给落地步骤与守卫）**。
>
> **本文性质**：设计与验收规格，**不是实现记录**。每条「落地步骤」都是待派工的清单，
> 派工前请先跑一遍现状取证（§4.0），别信任何文档里的「已做 / 未做」声明 —— 项目铁律。

---

## 0. 一张图看自由度分层

```
L1 资产自由度   插件 / 技能 / MCP 的创建与装卸          ← 已落地（A-1191~1195）
L2 工作模式自由度  把「怎么干活」固化成资产（流程/规范/分工） ← A-1196：creatorGuide 成体系指导
L3 Loop 自由度    按 Agent 定制循环预算与节奏            ← A-1196：loop_config（参数化第一步）
L4 内核自由度     行为契约 / critic-veto / 自定义阶段机 / 代码级贡献 ← 本轮：拆成四个可执行子层
```

L4 本轮拆开，因为四件事的**风险等级差一个数量级**，混在一张 roadmap 里会让人以为它们同样可行：

| 子层 | 名字 | 一句话 | 本轮结论 |
| --- | --- | --- | --- |
| **L4a** | UI 贡献点 | 扩展在 slime 界面里插入自己的面板 / 按钮 / 状态项 | **可做，纯声明式**，本轮给完整方案 |
| **L4b** | 设置贡献点 | 扩展自带设置项，持久化到自己的目录 | **可做，纯声明式**，本轮给完整方案 |
| **L4c** | 无 Agent-Loop 模式 | 纯粹由用户定义的运行模式（阶段机） | **可做声明式阶段机**；进程外代码 runner 只给协议，不给承诺 |
| **L4d** | 分层授信 | 放开改动权限但主干别坏 | **先收紧一处现存缺口**；「改主干」方向 **2026-10-09 已按用户口径作废** —— 扩展 = 外部武装（可开可关），不改程序本身（见§4.4 末「已撤销」） |

**判断标准**（沿用 A-1196，未变）：每一层都要求「**用户/Agent 能自己做到，且产物有守卫、失败不静默**」——
**能写但看不见**（写了技能但白名单不认）、**能配但不生效**（配置字段被忽略）都不算自由度，算陷阱。

---

## 1. L1 资产自由度（已落地）

| 能做什么 | 操作面 | 约束（有意保留的边界） |
| --- | --- | --- |
| 建插件（plugin.json + 技能/工具贡献） | 创造模式下 Agent 自己写；用户手放 `config/plugins/<名>/` | `origin` 必须如实；名字与目录同名；清单 fail-closed |
| 建技能（SKILL.md） | 写进技能目录（`config/skills/<名>/`） | 默认模式下自建技能**对自己不可见**（白名单）；创造模式可见 |
| 接 MCP | 扩展页 / MCP 管理 | 远程插件包下载尚未开放（需签名校验） |
| 启停插件 | **扩展页拨片开关**（A-1196）→ 改动记草稿 → 右下角悬浮栏点「保存并生效」（A-1198）统一写盘 + 重扫广播加载；关闭持久化于 `config/plugins-disabled.json` | 系统默认插件不可关（builtin）；**保存前怎么点都不动系统状态**；**保存不退出进程** |

**当前实际生效的贡献只有 `instructions`**（证据：`core-ts/src/plugin/host.ts:243` 对非
instructions/tools 的贡献直接记 `WIRING_PENDING`；`gui/src/main/index.ts:1466` 的
`registerTools: () => []` 是空实现）。⇒ 扩展现在**确实更像一个 skill**，这正是用户 2026-10-07
那句判断的成因。L4a/L4b 要补的就是「除 instructions 之外的第二条真实通路」，且**不引入可执行代码**。

## 2. L2 工作模式自由度（A-1196 成体系）

「通过指挥 Agent 形成自己的工作模式」= 把**反复出现的协作套路**固化成可复用资产。
A-1196 把这条写进 `creatorGuide`（第五节），给出三条固化路径：

1. **固定流程/规范 → 技能**：SKILL.md 写流程与规范，下次直接加载，不再在对话里重复交代；
2. **固定输出形态 → 技能正文**：模板、检查清单、字段规范放进技能，让产物一次成型；
3. **固定分工 → 子代理编队**：沿用同一套「谁调研、谁写、谁验收」的角色划分（`delegate_subagent`）。

**边界**：目前「工作模式」是**指导文本 + 既有机制的组合**，不是一个独立的新实体。
如果后续需要「可装配的工作流对象」（步骤图、并行/串行、条件分支），那是 L4c 的范畴 ———
需先有阶段机的持久化形态与子代理编排的持久化形态。

## 3. L3 Loop 自由度（A-1196：参数化第一步）

「自己定义 Agent-Loop」的**第一步 = 把硬编码的循环预算变成按 Agent 可配置**。

**配置面**（`config/agents.json` 里目标 Agent 的 `loop_config` 字段，全部可省略）：

```json
{
  "name": "silam",
  "loop_config": {
    "maxRounds": 60,
    "maxToolCalls": 500,
    "maxTotalTokens": 5000000,
    "maxWallClockMs": 3600000
  }
}
```

| 字段 | 含义 | 默认 | 封顶 |
| --- | --- | --- | --- |
| `maxRounds` | 工具轮上限（一个请求最多几轮「模型↔工具」） | `TOOL_MAX_ROUNDS`（500，可经 `SLIME_TOOL_MAX_ROUNDS` 环境变量改默认） | 500 |
| `maxToolCalls` | 单请求工具调用次数上限 | 不限制 | 10000 |
| `maxTotalTokens` | 单请求 token 预算 | 1200 万（`SLIME_MAX_TOTAL_TOKENS` 可改） | 10 亿 |
| `maxWallClockMs` | 单请求墙钟上限 | 3 小时（`SLIME_MAX_WALL_CLOCK_MS` 可改） | 24 小时 |

**读取语义**（`agentLoopBudget`，`core-ts/src/services/chat.ts:86`）：只认正数；非法值丢弃（回退默认）；
超上限封顶 —— **不静默放大**。配置只影响该 Agent 的请求，两条执行路径（`engine.ts:1242` 非流式 /
`engine.ts:1541` 流式）都生效。

**为什么「越过默认」是安全的**：预算是**上限**而不是目标 —— 调大只放宽、不强制消耗；
真正防失控的是「模型自己收敛 + 用户随时按停止（A-1194 已修）+ 预算到顶后如实提示收束」。

**L3 的下一步（属于 L4d 的授权面，不属于本层）**：现在这四个字段只有用户能改
（`config/agents.json` 在 `sensitive_filenames` 里，Agent 写了必被 block）。
要不要给「Agent 在创造模式下可申请调高自己的预算」，是授信问题，见 §4.4 的 T2 档。

---

## 4. L4 内核自由度（本轮：从 roadmap 变成可执行方案）

### 4.0 动手前必读的现状取证（2026-10-07 实测）

派工前请自己重跑一遍，下面每条都有文件行号可核：

| 事实 | 证据 | 对设计的约束 |
| --- | --- | --- |
| 清单只认三种贡献类型，且**非 instructions/tools 一律记「尚未接线」** | `core-ts/src/plugin/manifest.ts:3`；`core-ts/src/plugin/host.ts:243` | 新贡献类型必须先改 `PLUGIN_CONTRIBUTIONS`，否则装了不生效 |
| 工具贡献在 GUI 侧是空实现 | `gui/src/main/index.ts:1466` `registerTools: () => []` | 「扩展贡献工具」这条现在是假自由度，谁写谁背锅 |
| 插件根 = `<数据根>/config/plugins` | `gui/src/main/index.ts:1439` | 打包形态下 `<数据根>` 就是 slime 根（`core-ts/src/paths.ts` 的 `PROJECT_ROOT`） |
| 禁用名单 = `config/plugins-disabled.json`，装载后按名单立即卸载 | `gui/src/main/index.ts:1442` / `:1527`；写名单在 `:5035`（unload）与 `:5049`（enable） | **任何新贡献点必须与这条名单对齐**，否则就是假开关 |
| 贡献目录已有 watcher（500ms 去抖 → 重扫 → 广播 `plugins_changed`） | `gui/src/main/index.ts:1585`–`:1656`；通道 `gui/src/shared/ipc.ts:107` | 扩展改了 UI 声明后不必重启应用即可重扫生效（**渲染层挂载除外，见 §5**） |
| 设置页的 tab 是**硬编码联合类型 + 硬编码数组 + 硬编码 switch** | `gui/src/renderer/pages/SettingsDialog.tsx:28` / `:73` / `:319` | 贡献一个设置面板要改这三处，漏一处就静默不出现 |
| 撤销内核已到位：注册即副作用、逆序撤销、幂等、单失败不阻断 | `core-ts/src/plugin/scope.ts:36` | 新贡献点一律走 `ContributionScope`，不许自己存句柄 |
| ToolLoop 有**两份几乎重复**的实现，且实例化只有两处 | `core-ts/src/tool_loop.ts:916`（`run`）/ `:1067`（`runStream`）；`core-ts/src/services/engine.ts:1236` / `:1531` | 抽 `ChatRunner` 接口的改动点就是这四行 —— 好抓手，也是风险点 |
| 沙箱等级 L0–L5 + 三档审批（auto / confirm / block） | `core-ts/src/sandbox.ts:22`；`core-ts/src/tools/classifier.ts:11`；默认档位表 `sandbox.ts:189`–`:199` | 授信分层要落到这三处既有概念上，不许新造第四套 |
| 安全策略是单一真相源，双栈生成 | `shared/security-policy.yaml` → `scripts/gen_security_policy.py` → `shared/gen/security-policy.{ts,py}` | 新的授信清单**必须**加进这个 yaml，不许第二产地 |
| 受保护目录口径 = **未豁免一律禁写**；已豁免 `config/skills` 与 `config/plugins` | `shared/security-policy.yaml:47`；`core-ts/src/tools/classifier.ts:90`–`:111` | 豁免的是**写入**，不是**执行**；见 §5.1、§4.4 的缺口 |
| 主窗口渲染进程是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` | `gui/src/main/index.ts:3328`–`:3336` | **渲染层无法 require/eval 任何扩展代码** —— 这条决定了 L4a 只能做声明式 |
| 外部进程的既有铁律：`spawn` + 显式 timeout（终端 30s `index.ts:1218`、git 探针 4s `index.ts:5193`、子代理 `DEFAULT_EXEC_BUDGET_MS`） | `gui/src/main/index.ts:330`（`spawn` 导入）/ `:1290`（`spawn` 调用）/ `:1218` / `:5193`；`core-ts/src/services/subagent.ts` | 任何「插件要跑自己的程序」都必须走这套，且**无常驻进程** |
| 既有的「非 ToolLoop 范式」已经存在：会话 `type: "brainstorm"` 会走 `streamGroupTalkFlow` 而不是 ToolLoop | `gui/src/main/index.ts:3671` / `:3713`；`core-ts/src/services/brainstorm.ts:126` | L4c **不是新概念**，是给既有分派加第三分支 |

---

### 4.1 L4a · UI 贡献点（可做）

#### 现状

扩展只能贡献技能（Markdown）。`provides` 里的 `tools` 与 `prompt` 一个是空实现、一个记「尚未接线」。
插件**完全进不了界面** —— 扩展页只有一张清单卡，用户看得到名字、描述、贡献类型徽章，仅此。

#### 目标

扩展在**四个白名单槽位**里声明 UI，宿主按声明渲染：

| 槽位 | 声明字段 | 宿主挂载点 | 典型用途 |
| --- | --- | --- | --- |
| `settings_panel` | `id` / `title` / `icon?` / `order?` | `SettingsDialog.tsx:73` 的 `SECTIONS` 之后动态追加 + `:319` 的 switch 增分支 | 一个专属设置页（含 L4b 的设置项） |
| `status_item` | `id` / `label` / `order?` / `refresh: "manual" \| "on_event"` | 右侧栏 `StatusPanel` 底部新增一行 | 展示本扩展的运行态 / 计数 / 一键动作 |
| `chat_action` | `id` / `label` / `icon?` / `when?` | 输入栏动作区（与「联网搜索」开关同级） | 「用本扩展处理这条消息」 |
| `toolbar_item` | `id` / `label` / `icon?` | 会话头部工具条 | 打开扩展自己的页面（`page` 字段，见下） |

外加一个可选的**自有页面**：`page: { kind: "webview", entry: "panel.html" }` 或
`{ kind: "html", entry: "panel.html" }`。`html` 走 `gui/src/main/httpServer.ts` 的
`127.0.0.1` 静态服务（**绝不 `file://`**，理由见 §5.4）。

**明确不做**（红线，写进清单校验）：扩展**不能**贡献 JSX、不能贡献 CSS、不能注入脚本、
不能改宿主样式表、不能注册全局快捷键、不能覆盖宿主已有槽位。UI 只能是「宿主已实现的渲染器 + 声明」。
> **唯一允许的「外观」形态是主题贡献点（2026-10-09 落地）**：插件声明白名单 design tokens
> （配色 hex / 字体族枚举 / 圆角枚举），由宿主校验后落成全局 CSS 变量 —— 仍然**没有**任何扩展
> CSS 或样式表进入宿主，是「宿主渲染器 + 声明」在颜色维度上的等价物（见 §4.6）。

#### 怎么识别

- **声明**：`plugin.json` 新增 `contributes` 字段（与 `provides` 并列，不混用 —— `provides` 语义是
  「进上下文的东西」，`contributes` 语义是「进界面的东西」，两者判据不同）。
- **校验**：新增 `core-ts/src/plugin/contributes.ts`，导出 `parsePluginContributes(raw)`，
  **fail-closed**（与 `parsePluginManifest` 同款：任一槽位非法 ⇒ 整个插件 rejected 并进
  `rejected[]` 回传扩展页，不静默忽略单个字段）。
  校验项：`id` 必须匹配 `PLUGIN_NAME_PATTERN` 同款命名；`entry` 必须是**纯相对路径**、
  不含 `..`、不许盘符、不许以 `/` 开头（照抄 `loader.ts` 对 `entry` 的现有处理口径）；
  `refresh` 只认枚举值；同一插件内 `id` 不得重复；**跨插件的槽位冲突留给宿主裁决**（见「失控时怎么兜」）。
- **生效判定**：`PluginRecord.contributions` 里出现 `ui:<ids>` 才算真生效；
  沿用 `host.ts:257` 的 `contribute()` 口径 —— 钩子缺失或返回空 ⇒ 记「尚未接线」，**不假装已生效**。

#### 撒在哪一层

四层各一处，**不新建第五个产地**：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 清单 | `core-ts/src/plugin/manifest.ts`（类型） + 新 `core-ts/src/plugin/contributes.ts`（校验） | 声明形状与 fail-closed 校验 |
| 装配 | `core-ts/src/plugin/host.ts`（`PluginHostOptions` 增 `registerUi` 钩子；`activate()` 增分支） | 贡献登记 + `ContributionScope` track |
| 主进程 | `gui/src/main/index.ts`（`createPluginHost` 增 `registerUi`；新增 IPC `slime:plugins:ui`） | 读声明 → 汇总 → 回传渲染层；`page` 走 http 服务 |
| 渲染层 | `gui/src/renderer/pages/SettingsDialog.tsx` + `StatusPanel.tsx` + `ChatPanel.tsx`（输入栏） | 按声明渲染与**彻底摘除** |

#### 落地步骤（按文件粒度，串行，见 §4.5）

1. `core-ts/src/plugin/contributes.ts`（新建）：`PLUGIN_UI_SLOTS` 常量 + `parsePluginContributes`。
   纯函数、无 IO，**先写它的守卫**（`tests/core-ts/a1198-contributes.spec.ts`）。
2. `core-ts/src/plugin/manifest.ts`：`PluginManifest` 增 `contributes?: PluginUiContribution[]`，
   `parsePluginManifest` 里挂 `parsePluginContributes`，非法即整份 rejected。
3. `core-ts/src/plugin/loader.ts`：`entry` 的相对路径校验与 `contributes` 里 `page.entry` **共用同一个
   校验函数**（不许两处各写一遍）。
4. `core-ts/src/plugin/host.ts`：`PluginHostOptions.registerUi?: (manifest) => PluginContributionHandle[]`；
   `activate()` 里 `contributes` 非空 ⇒ 调 `registerUi` 并把 handle 全部 `scope.track`。
5. `gui/src/shared/ipc.ts`：`plugins_ui: "slime:plugins:ui"` 进 `IPC_CHANNELS`；
   `PluginUiSlotDTO`（`slot` / `plugin` / `id` / `title` / `order` / `payload`）进 `gui/src/shared/ipc.ts`。
6. `gui/src/preload/index.ts`：`pluginsUi()` + 类型声明（同文件 `:972` 那一块）。
7. `gui/src/main/index.ts`：`createPluginHost` 增 `registerUi`（**返回空数组前先如实记「尚未接线」**）；
   新 IPC handler `plugins_ui`：调 `host.list()` → 收集声明 → 按 `slot` 分组 → **同 `slot` 同 `id` 冲突时
   按 `order` 再按插件名排序，冲突项标 `conflict: true` 一并回传，宿主渲染成禁用态并在扩展页显示冲突原因**。
8. `gui/src/renderer/pages/SettingsDialog.tsx`：`:28` 的 `SettingsTab` 联合类型改为
   `SettingsTab | string`（**注意**：这是本步唯一的类型面放宽，`:211` 的 `activeTab` 兜底逻辑要一并验）；
   `:73` 的 `SECTIONS` 之后追加扩展声明的项；`:319` 的 switch 增 `ui:` 前缀分支走通用 `UiSlotPanel`。
9. 新建 `gui/src/renderer/components/UiSlotHost.tsx`：`slot → 渲染器` 的**唯一映射表**，
   四个已知槽位各有显式分支，**未知槽位渲染成一块「本槽位尚未接线」而不是空白**（不静默）。
10. `StatusPanel.tsx` / `ChatPanel.tsx`：各加一个读取 `slots.status_item` / `slots.chat_action` 的挂载点。
11. `page` 字段（可选，放最后做）：`gui/src/main/index.ts` 复用 `httpServer.ts` 的
    `serve({ dir, host: "127.0.0.1" })`，目录白名单限定在**该插件自己的目录**内。

#### 失控时怎么兜

| 失控形态 | 兜底 |
| --- | --- |
| 声明非法 | 整份插件 rejected ⇒ `rejected[]` 回传扩展页，**该插件一个贡献都不装**（fail-closed，与现有清单口径一致） |
| 槽位跨插件冲突 | 排序后取第一个，其余标 `conflict` 渲染成禁用态 + 扩展页显示「与 X 插件的 Y 槽位冲突」。**不静默丢弃、不静默覆盖** |
| 渲染层抛异常 | `UiSlotHost` 每个槽位外面包一层 `ErrorBoundary`（`gui/src/renderer/ErrorBoundary.tsx` 已有）⇒ 一个扩展的槽位炸了不带塌设置页 |
| **卸载不彻底**（历史缺陷高发区，A-1195 修过一次泄漏） | ① 渲染层以 **`plugin` + `slot` + `id` 三元组**为 React `key` 与数据源过滤依据，`plugins_changed` 一到就按当前声明**全量重算**（不做增量 diff，避免漏摘）；② 卸载路径统一走 `ContributionScope`，主进程侧 `dispose` 负责关掉 `page` 的 http 服务；③ 扩展页的启停**必须**同时（a）写 `plugins-disabled.json`（b）重启后由重扫按名单卸载 —— 缺任一步就是假开关。**A-1198 起这两步收敛在 `plugins_apply_changes` 一个写盘点**（草稿 → 保存 → 重扫），守卫要求该段内**恰好一次** `runContribRescan` 且位置在「写盘全成功」之后（提前跑 = 半套状态） |
| 扩展把自己的 `config/plugins/<名>/` 删了 | watcher 会触发重扫 ⇒ 该插件直接消失（`rejected` 或不再出现），**界面同步摘除**。不保留幽灵槽位 |
| `page` 的 http 服务泄漏 | 端口复用既有 `serve` 实现的生命周期；`dispose` 里显式 `close()`；`close()` 失败**如实 console.error 并在扩展页显示**，不静默 |

#### 验收守卫

- `tests/core-ts/a1198-contributes.spec.ts`（新建）：声明校验的合法/非法矩阵；
  必含反例 —— `entry: "../../evil.html"`、`entry: "C:\\evil.html"`、`id` 含大写、`refresh` 拼错、
  同插件内重复 `id`，**每条都必须真的 rejected**（反例必须失败，否则判据没测到点上）。
- `tests/core-ts/plugin-host.spec.ts`（扩写）：`registerUi` 钩子缺失 ⇒ 记「尚未接线」；
  钩子返回空 ⇒ 记「尚未接线」；handle 的 `dispose` 全部被 `disposeAll` 逆序调用；
  **重装后旧 handle 不得残留**（这条是 A-1195 遗留面的延伸，变异必测）。
- `tests/core-ts/a1198-ui-slot.spec.ts`（新建）：三元组 key 的全量重算 —— 拔掉一个插件后，
  其 `status_item` / `chat_action` / `settings_panel` 在快照里**一个都不剩**。
- 变异 `gui/scripts/mut-a1198-ui-slot.mjs`（新建）：
  ① `registerUi` 改回返回空 ⇒ 应被「尚未接线」守卫抓住；
  ② 渲染层改成增量 diff（只加不减）⇒ 应被「全量重算」守卫抓住；
  ③ `plugins_ui` handler 漏掉 `conflict` 标记 ⇒ 应被冲突守卫抓住；
  ④ 卸载不广播 `plugins_changed` ⇒ 应被扩展页刷新守卫抓住；
  ⑤ `entry` 校验去掉 `..` 检查 ⇒ 应被清单守卫抓住。
  **跑批**：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-ui-slot.mjs`，
  收尾跑 `node gui/scripts/check-mut-anchors.mjs`（**不带参数，必须全量**）。
- 收尾门禁：根 `tsc -p tsconfig.base.json --noEmit`、`gui/` 内 `tsc -p tsconfig.json --noEmit`、
  全量 vitest、`electron-vite build`。**主进程改动需重启应用目视验收**（见 §5.3）。

---

### 4.2 L4b · 设置贡献点（可做）

#### 现状

设置项散落在各 `*Panel.tsx` 的硬编码 JSX 里（如 `GeneralPanel` 的自启/通知/提示音）。
插件**没有任何持久化位置** —— 插件目录里只有 `plugin.json` 与 `skills/`，
往插件目录写设置在策略上是豁免的（A-1197），但**没有任何代码会去读它**。
⇒ 想做也做不了，不是「难」，是**没有读端**。

#### 目标

扩展自带设置项，**持久化到自己的目录**，且**主配置零污染**：

- 落点固定为 `<数据根>/config/plugins/<插件名>/settings.json`（**插件自己的目录**，不进 `slime.toml`、
  不进 `agents.json`、不进 `global_config.json`）。
- 主进程只认这一个路径，**由 `plugin.name` 推导，不接受渲染层传任意路径**（渲染层只传
  `{ plugin, id, value }`）。
- 写入语义：整文件覆写 + 先写 `.tmp` 再 `rename`（照抄 `gui/src/main/config_files.ts:117`–`:122`
  的既有原子写 + `.bak` 备份做法）。**不在 `WRITABLE` 白名单里加任何东西** —— 不污染主配置这条是硬的。

**两条路径必须分清**（这是本层最容易设计错的地方）：

| 路径 | 经不经过沙箱 | 判据 |
| --- | --- | --- |
| **用户在设置界面里改扩展的设置** | **不经** —— 这是用户行为，由主进程直接写盘 | 既有先例：改主配置的 `slime:config:write` 也不经 Agent 沙箱 |
| **Agent 用工具改扩展的设置** | **必须经** —— 这是工具调用，走 `gateToolCall` / `classifyToolCall` / `hardRuleCheck` 全链 | `config/plugins` 已被 `protected_path_exemptions` 放行，所以**能写**；但受 §4.4 的 T1 约束（只能写自己插件的目录） |

#### 怎么识别

- **声明**：`contributes.settings`（不是 `provides`）—— 一组声明项：
  `{ key, label, type: "boolean" | "string" | "number" | "enum" | "path", options?, default?, hint?, secret? }`。
  `secret: true` 的项**不**明文落盘，落 `settings.enc.json`（复用既有加密配置原语，口径与
  `providers.enc.json` 一致）；渲染层读回时只拿到 `hasValue: true`。
- **校验**：同样 fail-closed。`key` 匹配 `^[a-z0-9]+(?:[-_.][a-z0-9]+)*$`（与插件名同族但允许 `_`/`.`）；
  `type` 只认枚举；`enum` 必须给非空 `options`；`number` 必须给 `min`/`max`；
  `default` 必须能通过 `type` 校验（**默认值的类型错了也是拒绝，不是静默丢弃**）；
  `path` 类型**必须声明 `root`**，取值只允许 `plugin`（插件自己目录）或 `workspace`（会话工作目录）——
  **没有第种取值**。
- **生效判定**：`PluginRecord.contributions` 里出现 `settings:<n>项`。

#### 撒在哪一层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 声明与校验 | `core-ts/src/plugin/contributes.ts` | `parsePluginSettings`（与 UI 槽位共用文件，共享 `entry`/`path` 校验） |
| 持久化 | 新 `core-ts/src/plugin/settings-store.ts` | `readPluginSettings/writePluginSetting`；**路径只由 `plugin.name` 推导**；原子写 + `.bak`；文件损坏 ⇒ 回退 `{}` 并在扩展页显示「设置文件损坏已忽略」 |
| 装配 | `core-ts/src/plugin/host.ts` | 不新增钩子（设置项由 UI 层按声明读，无需在主进程缓存）——**刻意不缓存**，避免第二个真相源 |
| IPC | `gui/src/shared/ipc.ts` + `gui/src/preload/index.ts` | `plugins_settings_get` / `plugins_settings_set`（参数只含 `plugin` / `key` / `value`） |
| 渲染层 | `gui/src/renderer/components/UiSlotHost.tsx` | 按声明渲染四种控件 + 校验；**不做持久化判断**（持久化只在主进程） |

#### 落地步骤

1. 新 `core-ts/src/plugin/settings-store.ts`：`SettingsStore` 类。**先写守卫**
   （`tests/core-ts/a1198-settings-store.spec.ts`）—— 文件不存在 ⇒ `{}`；坏 JSON ⇒ `{}` + 记一条 warning；
   `.bak` 恢复路径可用；路径推导拒绝 `plugin.name` 含路径分隔符（照抄 `PLUGIN_NAME_PATTERN` 的保证，
   但**这里要再 assert 一次**，不靠上游）。
2. `core-ts/src/plugin/contributes.ts` 增 `parsePluginSettings` + `PLUGIN_SETTING_TYPES`。
3. `gui/src/shared/ipc.ts` 增两个通道 + `PluginSettingDTO`；`gui/src/preload/index.ts` 增对应方法与类型。
4. `gui/src/main/index.ts` 增两个 handler，**入参先过 `host.get(plugin)`**：
   插件未装载/已卸载 ⇒ 返回 `{ ok: false, error: "插件未装载" }`（**不给未装载插件写盘的机会**）。
5. `UiSlotHost.tsx` 增设置项渲染器：控件按 `type` 分支，写入前本地校验（与服务端口径一致，
   两处都要有 —— 渲染层为了即时反馈，主进程为了不信任）。
6. `PluginsPanel.tsx`：每个带 `settings` 贡献的插件卡上给一个「设置」入口，**跳转/就地展开都行，
   但必须能到达**。
7. `secret: true` 项：接既有加密配置原语，加密文件落 `<插件目录>/settings.enc.json`。

#### 失控时怎么兜

| 失控形态 | 兜底 |
| --- | --- |
| 设置文件写坏 | 读侧回退 `{}` + 扩展页显示警告；**不静默当空配置继续跑** |
| 设置项 key 冲突（同一插件内两个声明项同 key） | 清单校验阶段直接 rejected |
| 扩展想借设置项写主配置 | 类型里**没有** `path` 以外的自由文本落点；`path` 的 `root` 只有两个枚举值 ⇒ 结构上做不到 |
| `secret` 项被读回明文 | 读回 DTO 只有 `hasValue`；**主进程不提供读明文的 IPC**（想看只能自己去读自己插件目录的文件 —— 那是同一个用户的文件，威胁模型成立） |
| 插件被禁用后仍有设置改动请求 | `host.get()` 返回 `status !== "loaded"` ⇒ 拒绝写盘 |
| 设置写入与贡献撤销竞态 | 设置**不进 `ContributionScope`**（它是持久数据，不是运行期副作用）⇒ 禁用插件后数据保留、启用后仍在。**这是有意的**：用户关掉插件不该丢配置 |

#### 验收守卫

- `tests/core-ts/a1198-settings-store.spec.ts`（新建）：原子写、`.bak`、坏 JSON 回退、
  **路径推导拒绝穿越**（`plugin.name` 伪造 `../..`、绝对路径、盘符）。
- `tests/core-ts/a1198-contributes.spec.ts`（并入）：`parsePluginSettings` 矩阵，
  必含反例 —— `enum` 无 `options`、`number` 无 `min`/`max`、`default` 类型不符、
  `path` 的 `root` 拼错、`secret` 写在非插件目录下。**反例必须真拒绝。**
- `tests/gui/a1198-plugin-settings.spec.ts`（新建）：插件未装载时 `plugins_settings_set` 拒绝。
- 变异 `gui/scripts/mut-a1198-ui-slot.mjs`（**同脚本追加**，编号续排）：
  ⑥ `readPluginSettings` 读失败改成静默 `{}` 且不记警告 ⇒ 应被「损坏有提示」守卫抓住；
  ⑦ IPC 改成接受渲染层传入的任意 `path` ⇒ 应被「路径只由插件名推导」守卫抓住；
  ⑧ `secret` 项改成明文落盘 ⇒ 应被 secret 守卫抓住；
  ⑨ `plugins_settings_set` 去掉 `host.get()` 前置检查 ⇒ 应被「未装载拒绝」守卫抓住。

---

### 4.3 L4c · 无 Agent-Loop 的纯用户定义模式（本轮最重要）

#### 现状：这件事已经有先例，不是新发明

`gui/src/main/index.ts:3671` 已经在做模式分派：

```
会话 meta.type === "brainstorm" && 成员数 > 0
  ⇒ 走 streamGroupTalkFlow（core-ts/src/services/grouptalk.ts / brainstorm.ts）
  ⇒ 否则走 ToolLoop（core-ts/src/services/engine.ts:1531）
```

也就是说 **slime 已经有「非 ToolLoop 的第二种运行范式」**，只是它写死在代码里、不由用户定义、
且只服务「头脑风暴」这一个场景。⇒ L4c 的正确做法**不是造第三套引擎**，而是：

1. 把「谁来跑这个会话」从 `if (brainstorm)` 提升为**一层可注册的运行器（`ChatRunner`）**；
2. 让运行器可以由**插件声明**，但**只能是声明式**。

#### 目标：三个范式的边界（这是本节的核心，不能含糊）

| 范式 | 谁决定跑什么 | 轮次从哪来 | 声明方式 | 工具 | 落点 |
| --- | --- | --- | --- | --- | --- |
| **A. 模型 + 工具**（既有主范式） | 模型 | `ToolLoop` 的 `for (round = 1; round <= maxRounds)`（`tool_loop.ts:916` / `:1067`） | `agent.loop_config` 调**预算**，不调结构 | 允许（走白名单 + 沙箱） | 保留为**默认实现**，一行不改 |
| **B. 多成员协作**（既有 brainstorm） | 代码写死的成员轮转 | `runBrainstorm` 的 `maxRounds` | 会话 `type: "brainstorm"` | 目前不给工具 | 保留为一个注册好的 runner |
| **C. 纯用户定义**（本节新增） | **用户写的阶段清单** | **阶段清单的长度** | 插件 `provides: ["mode"]` + `mode` 字段 | 每阶段**独立**白名单 | 新增，见下 |

**C 与 A 的边界（必须写清，否则就是「什么都能干」的口子）**：

- C **不是**「关掉 Agent-Loop 的 A」。C 是**并列的第三种分派分支**，用户在会话上选一个就用一个。
  用户想要「A 但轮数少一点」⇒ 用 A + `loop_config`；想要「我规定好每一步」⇒ 用 C。
- C **不能**省掉的安全环节（**一个都不省**）：沙箱判定（`sandboxGateFrom`）、硬规则（`hardRuleCheck`）、
  工具去重、`truncateForContext` 上下文截断、用户「停止」（`signal.aborted`）、每阶段预算上限。
  **C 只允许换「跑什么」，不允许换「怎么判权限」。**
- C **不做**的事：不改 `OutputFilter` 的身份过滤口径、不改上下文压缩策略、不绕 `executePendingTools` 的
  `Promise.all` + abort 竞跑处理（`tool_loop.ts:551`）。⇒ C 的阶段机**必须复用 `ToolLoop` 的
  单轮执行与工具执行**（抽出来共用，不复制一份）。

#### 怎么识别（manifest 表达）

```json
{
  "name": "my-pipeline",
  "version": "1.0.0",
  "description": "…何时用…",
  "origin": "agent",
  "provides": ["mode"],
  "mode": {
    "kind": "stages",
    "stages": [
      { "id": "survey",  "title": "调研", "prompt": "只读调研…", "tools": ["file_read", "file_list", "web_search"],
        "maxRounds": 8, "allowSteer": false },
      { "id": "plan",    "title": "方案", "prompt": "产出方案…", "tools": ["file_write"],
        "maxRounds": 1, "requirePrevious": "survey" },
      { "id": "verify",  "title": "验收", "prompt": "按方案自检…", "tools": ["file_read", "code_check"],
        "maxRounds": 6, "requirePrevious": "plan" }
    ],
    "maxTotalStages": 8
  }
}
```

校验（`core-ts/src/plugin/mode.ts`，同样 fail-closed）：
`provides` 必须含 `mode`；`mode.kind` 只认 `"stages"`；`stages` 长度 1–8；
每阶段 `id` 唯一、`prompt` 非空且 ≤ 4000 字符（**prompt 是要进上下文的，必须有上限**）、
`tools` 里的每个名字**必须真实存在于当前工具表**（**清单装载时查一次**，查不到 ⇒ 拒绝装载，
不留「配了但不生效」的假自由度）、`requirePrevious` 必须指向**前面的**阶段（禁止前向引用与环）、
每阶段 `maxRounds` 1–500。`origin: builtin` 时 `mode` 一律拒绝（内置运行器不走插件路径）。

#### 怎么跳过 / 替换 ToolLoop

**不替换、不 fork、只加分派分支**。改动点恰好四个（都已取证）：

1. 新 `core-ts/src/services/chatRunner.ts`：`interface ChatRunner { kind: string; run(opts): AsyncIterable<EngineChunk> }`
   + `registry`（Map）+ `resolveRunner(session)`。**ToolLoop 以 `kind: "agent-loop"` 注册进去，逻辑一行不改。**
2. `core-ts/src/tool_loop.ts`：把 `run`/`runStream` 里**单轮的那一段**
   （`executePendingTools` + `router.chat` / `chatStream` + abort 竞跑 + 预算检查 + steer 注入）
   抽成一个**可复用**的 `runSingleRound()`；`run` / `runStream` 改成「循环调用它」。
   **这一步是纯重构，行为必须逐字不变**（有既有守卫 `tests/core-ts/a1194-abort-retry.spec.ts` 兜底）。
3. 新 `core-ts/src/services/stageRunner.ts`（C 的实现）：按 `stages` 顺序，
   每阶段 = 构造 messages（上一阶段的收束结论 + 本阶段 prompt）+ 用 `runSingleRound`
   跑到本阶段 `maxRounds` 或无工具调用为止；阶段间**必须裁剪上下文**（只留上一阶段的收束段，
   否则 4 阶段 = 4 倍 token —— 这是 L4 原 roadmap 里点明的先决问题，本轮给死口径：
   **只保留上一阶段的最终文本 + 工具调用摘要，不保留完整工具输出**）。
4. `gui/src/main/index.ts:3671`：`isBrainstorm` 那个三元表达式改成
   `const runner = resolveRunner(session, host)`，优先级 **显式 mode 会话 > brainstorm > agent-loop**。
   `streamGroupTalkFlow` 作为 runner 注册，B 的行为不变。

**用户改了什么才生效**：mode 是**会话级**的，随会话创建/切换选定 ⇒ **新请求立即生效，不需重启**
（与 L3 的 `loop_config` 同口径：都在请求组装时读）。
**哪些改动需要重启**：见 §5.3（主进程侧代码变更）。

#### UI 上怎么选与切换

- 会话创建/会话设置里加一个**运行模式**下拉，三项：`模型 + 工具`（默认）/ `多成员协作` / `<扩展提供的模式名>`。
  选项来源 = `host.list()` 里 `provides` 含 `mode` 且 `status === "loaded"` 的插件
  （**禁用/卸载的插件不出现在下拉里**，与拨片开关同一份状态，不做第二套）。
- 会话头与 `StatusPanel` 常驻显示当前运行模式名 + 当前阶段（第 n / N 步），**用户随时知道自己在哪一步**。
- **切换运行模式要弹二次确认**：会让当前进行中的阶段作废。确认文案要写明「会丢弃当前阶段的中间上下文」。
- 阶段执行时，`chat_action` / `status_item` 的渲染器要能显示阶段进度（L4a 的槽位正好承载这个）。

#### 失控时怎么兜

| 失控形态 | 兜底 |
| --- | --- |
| mode 声明非法 | 清单 rejected，插件不装载 ⇒ 下拉里根本不出现 |
| 某阶段引用了已被禁用的工具 | **运行前**（每阶段开始时）重查工具表；查不到 ⇒ 该阶段不执行，**如实把「阶段 X 因工具不可用而跳过」写进对话**，并给出一条可执行建议（去权限页开工具 / 关掉这个扩展）。**不静默跳阶段** |
| 阶段死循环（模型在同一步里反复） | 每阶段 `maxRounds` 是硬上限（≤500）+ 阶段级 `maxTotalTokens`；到顶即收束并**说明是哪个阶段到顶** |
| 用户在阶段中按停止 | `signal` 一路透传到 `runSingleRound`（复用 `abortableToValue`），阶段标记 `interrupted`，**下一阶段不再开始** |
| 扩展被禁用时会话正跑在它的 mode 上 | 阶段边界检查插件 `status`；不是 `loaded` ⇒ 当前阶段收束、本会话**回落到 `agent-loop`**，并在对话里说明「扩展已停用，回落到默认模式」。**不静默换模式** |
| renderer 抛异常 | `resolveRunner` 之外包一层：任何异常 ⇒ 回落 `agent-loop` + 如实上报 + 扩展页显示该插件 `status: failed` |
| 上下文爆炸 | 阶段间强制裁剪（上面第 2 条口径）+ 沿用 `truncateForContext` + 沿用既有上下文压缩预检（`engine.ts:1519` 的 `guard.allow` 那一段，装不下则**不发送**） |
| 用户给了一个不含工具的 mode | **允许**（那就是「纯用户定义的固定流程」）；此时不装配工具表，`runSingleRound` 走 `router.chat` 直连分支 |

#### 验收守卫

- `tests/core-ts/a1198-mode-manifest.spec.ts`（新建）：阶段校验矩阵。
  **必含反例**：`tools` 里写一个不存在的工具名、`requirePrevious` 前向引用、阶段数 9、
  `prompt` 5000 字、`origin: builtin` 带 `mode`。**反例必须真拒绝。**
- `tests/core-ts/a1198-runner.spec.ts`（新建）：
  ① **抽取 `runSingleRound` 后 `run`/`runStream` 行为逐字不变**（跑既有 A-1194 断言，全绿才算过）；
  ② stageRunner 三阶段 happy path：阶段顺序、每阶段 prompt 真的进了 messages、阶段间上下文被裁剪
  （断言 messages 长度不随阶段数线性增长）；
  ③ 阶段中工具不可用 ⇒ 阶段跳过 + 对话里有可执行说明；
  ④ 阶段中 `abort` ⇒ 后续阶段不开始；
  ⑤ 插件被禁用 ⇒ 回落 `agent-loop` 且对话里说明；
  ⑥ renderer 抛异常 ⇒ 回落 `agent-loop` 且扩展页拿到 `failed`。
- 变异 `gui/scripts/mut-a1198-stage-runner.mjs`（新建），**这是本轮最关键的一份变异脚本**：
  ① `resolveRunner` 把显式 mode 的优先级排在 brainstorm 之后 ⇒ 应被优先级守卫抓住；
  ② stageRunner 阶段间**不裁剪**上下文 ⇒ 应被裁剪守卫抓住；
  ③ 阶段边界不重查工具表 ⇒ 应被「工具不可用被跳过」守卫抓住；
  ④ 插件禁用后不回落 ⇒ 应被回落守卫抓住；
  ⑤ `maxRounds` 上限被写成 5000 ⇒ 应被清单校验守卫抓住；
  ⑥ `abort` 后继续跑下一阶段 ⇒ 应被 abort 守卫抓住；
  ⑦ 抽 `runSingleRound` 时漏掉 abort 竞跑（退回裸 `Promise.all`）⇒ **必须被 A-1194 既有守卫抓住**
  （这条专门防「重构偷掉安全行为」）。
- 目视：主进程改动 ⇒ **重启应用**后确认会话模式下拉出现扩展提供的模式、阶段进度可见、
  停用扩展后会话回落（§5.3）。

---

### 4.4 L4d · 分层授信：放开改动权限，但主干别坏

#### 先说清楚「放开」在当前策略下意味着什么（口径对齐）

`shared/security-policy.yaml` 的口径是 **受保护目录「未豁免一律禁写」**，命中即 block 级硬规则，
**任何审批档位、任何权限开关都批不了**（`core-ts/src/tools/hard_rules.ts:64`–`:66`）。
已放行的只有两条（`:47`）：`config/skills` 与 `config/plugins`。

⇒ **因此本文不承诺「让扩展能改 slime 主干」**。理由不是保守，是**做得到但不该做**：
一旦在策略层放开 `core-ts` / `gui`，`hard_rules.ts` 的保护就退化成 advisory，
而这两个目录里的东西（沙箱、权限、工具表、门禁脚本）**正是保护本身的实现**。
用户说「主干别坏就行」—— 那主干就必须**继续被硬规则挡着**，这与「放开」不矛盾，因为放开的是
**扩展能做的事**，不是**扩展能碰的文件**。

**用户真正要的「放开」在这里**：让扩展能在**自己的地盘**上自由（UI、设置、模式、自己的数据），
并在**明确列出的几处**允许写代码 —— 但那些地方**必须是可守卫、可回滚、可评审的**。

#### ⚠️ 顺带发现的一处现存缺口（先收紧，再谈放开）

`config/plugins` 被**整目录**豁免（`security-policy.yaml:47`–`:49`）。
豁免的实现是「目录前缀匹配」（`classifier.ts:106`–`:111`）⇒ **任何 Agent、任何插件都能写任意插件的目录**，
包括改别人的 `plugin.json`、删别人的 `skills/`。

这不是理论风险：`docs/HANDOFF-plugin-system.md` §1 记着 DSH 的真实事故（**别人生成的插件代码与宿主抢
lifecycle**，且 DSH 在 2026-09-16 **主动删掉**了「让 Agent 直接生成并运行插件」这条路，理由正是架构重复），
而「改别人的清单」是最省事的注入面 —— 把另一个插件的 `provides` 改成 `tools`，宿主就会去登记它。

⇒ **L4d 的第一步不是放开，是收紧**：加一条「写入 `config/plugins/**` 时，写入方必须是该插件自身
（或无归属的技能目录）」的判定，落在 `classifier.ts` 的 `isProtectedSourcePath` 之后
（新函数 `isForeignPluginWrite`，**不覆盖原函数的语义**）。这条收紧**不放宽任何东西**，只多挡一种写。

#### 分层授信表

| 档 | 能做什么 | 触发条件 | 验证机制（守卫） | 失控兜底 |
| --- | --- | --- | --- | --- |
| **T0 自动** | 往**自己**插件目录 / 技能目录写 `plugin.json` / `SKILL.md` / `settings.json` / `data/**` | 创造模式 + `origin: agent` + 路径落在自己名下 | 现有 A-1197 守卫 + 新增「跨插件写入被拒」守卫 + 变异 ① | 越界即 block，并把拒绝理由翻成可执行建议（复用 `explainDenial`） |
| **T1 自动（需用户在扩展页点一次「信任」**） | 往**自己**插件目录写**可执行脚本**（如 `tools/*.mjs`），并由主进程 `spawn` + **显式 timeout** 执行 | 扩展页逐插件开关「信任本插件的脚本」，**不持久化到主配置**，落 `config/plugins/<名>/trust.json` | 守卫：无 `trust.json` ⇒ 脚本入口永不装配；变异「信任开关被旁路」必须变红 | 关闭信任开关 ⇒ 脚本入口立即撤装（进 `ContributionScope`） |
| **T2 二次确认（逐次）** | ① 在**用户工作区**里增删改文件（现有「工作目录外需确认」的补集：区内从 auto 提到 confirm）；② 调高自己 Agent 的 `loop_config`；③ 安装/启用 `origin: market` 的扩展 | 每一次都弹确认，**不允许「always allow」**（对齐 `AGENTS.md` §6 的口径：`always-allow` 也不管用） | 守卫：确认弹窗被跳过（无 requestId / 超时当放行）必须变红；变异「超时默认放行」必须变红 | 超时/取消 ⇒ 视为拒绝，并把「需要用户当面批准」写进工具结果（`explainDenial` 已有这条） |
| **T3 绝对禁止（永不放开）** | ① 写 `core-ts` / `gui` / `tools` / `shared` / `scripts` / `tests` / `.git` / `config`（除已豁免两条）；② 写 `slime.toml` / `agents.json` / `global_config.json` / `*.enc` / `audit.jsonl` / `history.jsonl` / `passphrase`；③ 改 `security-policy.yaml` / `gen_security_policy.py`；④ 改 `AGENTS.md` / `CLAUDE.md` / `qa.py` / `run_tests.py` / `pytest.ini`；⑤ 把自己 `origin` 写成 `builtin`；⑥ 插件代码里 `import`/`require` 宿主模块 | 无条件拒绝，**不接受任何授权** | 现有 A-1197 守卫已覆盖 ①②的绝大部分；③④⑤⑥ 需补 shape + 行为双重断言 | 命中即 block + 明确来源。**注意 ③④ 是「改规则绕过自己」**，对应 `AGENTS.md` §6 的受保护模块清单，不许因为「用户说放开」而松动 |

**T1 为什么只到「脚本 + spawn + timeout」**：这是当前平台**唯一**能安全跑扩展代码的形态 ——
渲染进程 `sandbox: true` + `nodeIntegration: false`（`gui/src/main/index.ts:3329`）⇒ 进程内 eval/require
被 Electron 挡住；外部进程按项目铁律必须 `spawn` + 显式 timeout、且**无常驻**。
⇒ T1 的能力上限就是「一次性子进程，跑完就退，超时被杀」。这不是偷懒，是平台给出的唯一缝隙。
T1 那个子进程的边界也要说死：`cwd` = 该插件目录、**不注入任何宿主对象**、
不持有 `ipcMain` 引用、只以 stdout 返回结构化结果（宿主按既有 `execFile`/`spawn` 口径收尾）。

#### 已撤销：「开发者模式 D1（改主干）」（2026-10-09 用户口径更正）

> **用户原话**：「不应该是开发者模式 —— 我要求制作的高自由度扩展本质是**外部插件，可开可关的**，
> 而非对程序本身进行修改，打个比方，更像『精装』或者说『武装』。」

⇒ 本设计曾把「改主干」（用户当时问「那我要真能改主干怎么办」，答复口径是「主干别坏就行」）
写成一张带闸的 D1 表。**该方向现已整体作废**：

- **高自由度的正解 = 外部武装**：插件六类贡献点（指令 / 设置项 / UI 槽位 / 脚本工具 / 自有页面 /
  运行模式），全部**可开可关**（拨片启停、脚本信任开关、卸载即恢复原样），**不修改程序本身**。
- **已撤除的落地物**（曾按 D1 实现，现全部移除）：`core-ts/src/plugin/dev-mode.ts`、
  sandbox 的 worktree 放行分支、扩展页「开发者模式」总开关、IPC/preload 通道、自述段落、
  守卫 `a1198-dev-mode` 与变异 `mut-a1198-dev-mode`。
- **反回归锁**：`tests/core-ts/a1198-self-awareness.spec.ts ①` 断言「仓库里不存在改程序本身的通路」
  （`dev-mode.ts` 不许存在 + 五处触点零残留），配套变异 M26–M28（自述/沙箱/扩展页三处表述回潮必须变红）。
  将来要改这个决定，必须先显式改守卫 —— 回归只能是一次可见动作。
- **配套物独立保留**：`git_*` 工具层（身份铁律 + commit 门禁 + diff 评审 + 无合并权，
  `core-ts/src/tools/git.ts`）不再隶属 D1，改为「**Agent 提交代码**的治理层」——对任何工作区仓库通用。
- **D1 里的一般原则仍然成立**（只是不再有「改主干」这个对象）：主干永远只读；
  「能跑 QA + 能被评审 + 能回退」是任何自动改动进入人类视野前的准入线；**合并永远是人的动作**。

原 D1 表（开启方式 / worktree 强制 / 分支前缀 / 门禁 / 差异评审 / 无合并权 / 关闭即回归）已在此删除，
其可复用部分已分别归位：门禁与评审在 `git_*` 工具层，授权寿命与「每次启动重新确认」的思路
在脚本信任开关（`trust.json`，可随时撤）。

#### 每层的验证机制（守卫 + 变异是本项目硬规矩）

| 能力 | 守卫测试（必须存在） | 变异脚本（必须实跑捕获） |
| --- | --- | --- |
| T0 跨插件写入收紧 | `tests/core-ts/a1198-plugin-write-scope.spec.ts`：写自己目录 auto、写兄弟目录 block、写 `config/plugins/x/settings.json`（无归属）block | `mut-a1198-plugin-write-scope.mjs`：① 去掉跨插件判定；② 判定只比 `startsWith` 前缀不比分隔符（`config/plugins-evil` 误放）；③ 相对路径与绝对路径不同口径 |
| T1 信任开关 | `tests/core-ts/a1198-plugin-trust.spec.ts`：无 `trust.json` ⇒ `registerScripts` 不被调用；有 ⇒ 被调用；`dispose` 后不残留；子进程 `cwd` 必须是该插件目录、**不带宿主环境变量以外的注入** | 同脚本追加：④ `trust.json` 缺失时默认放行；⑤ 关信任后脚本入口未撤 |
| T2 二次确认不可绕过 | `tests/gui/a1198-approval.spec.ts`：无 requestId ⇒ 拒绝；超时 ⇒ 拒绝；`alwaysAllow` 对 T2 无效（不得调 `approveToolForSession`） | `mut-a1198-approval.mjs`：⑥ 超时当放行；⑦ 跳过确认直接执行；⑧ T2 误复用 T0 的 auto 通道 |
| T3 不可放开 | 在现有 `a1197-contrib-write.spec.ts` 上**追加**：`security-policy.yaml` / `gen_security_policy.py` / `AGENTS.md` / `CLAUDE.md` / `qa.py` / `run_tests.py` / `pytest.ini` 全部 block；`origin: builtin` 的磁盘清单 rejected（现有断言已覆盖，回归要钉住） | `mut-a1198-protected-surface.mjs`：⑨ 从 `protected_dirs` 摘掉一项；⑩ 从 `sensitive_filenames` 摘掉 `slime.toml`；⑪ 生成器被改成手改生成物不被发现（`--check` 幂等断言） |
| ~~D1 开发者模式~~（**2026-10-09 已撤销**） | 通路整体撤除 ⇒ 守卫换成**反回归锁**：`tests/core-ts/a1198-self-awareness.spec.ts ①` —— `dev-mode.ts` 不许存在 + sandbox/main/preload/ipc/扩展页五处零残留（剥注释后匹配） | `mut-a1197-creator-promise.mjs` **M26–M28**：自述 / 沙箱 / 扩展页三处「开发者模式」表述回潮必须变红 |
| 策略单一产地 | 改 `security-policy.yaml` 后 `py scripts/gen_security_policy.py --check` 必须退出 0 且无 diff（**CI 可跑的幂等断言**） | 并入 ⑪ |

#### 「扩展自己改坏了 slime」的可回滚路径

四道，按代价从低到高：

1. **禁用名单**（现成，已验证）：扩展页拨片关 ⇒ 草稿 ⇒ 右下角悬浮栏「保存并生效」写 `plugins-disabled.json`
   ⇒ `runContribRescan` 重扫时按名单**不装载** ⇒ 贡献全撤。**跨重启有效**。
   **A-1198 变更**：启停与脚本信任都**不再逐个即时应用**（旧体验是「点一下等一会儿、
   有的还得刷页面才生效」），统一攒成一次保存 —— 换来**确定性**的生效点：
   保存之前怎么点都不动系统状态。**生效不退出进程**（用户口径：「我要的是重启不退出，要的是刷新 slime 的状态」）——
   写盘后走 `reloadPlugins` + `refreshAgentSkills` + `broadcastContribRescan`，窗口全程不中断。
   守卫钉住「重扫恰好一次且在写盘成功之后」「段内不许 `app.exit`」「保存栏 `position: fixed` 钉在右下角」。
   L4a/L4c 的所有新贡献点都必须与这条对齐 —— 有一条没对齐就是假开关，守卫点名。
2. **目录级回滚**：`config/plugins-disabled.json` 旁边维护一份 `config/plugins-backup/<时间戳>/`，
   在**装载前**对插件目录做一次快照（只在该插件声明了 `tools`/`mode`/`scripts` 这类**有装配副作用**的贡献时做，
   纯 `instructions` 不做 —— 否则快照目录会被无意义地撑大）。
   回滚 = 关开关 + 从快照恢复 + 重扫。**粒度 = 一个插件目录**。
3. **安全模式启动**：直接**复用** `gui/src/main/crashGuard.ts` 已有的机制 ——
   `sweepAfterCrash()` 返回 `abnormalExit: true`（判据是 `data/runtime/run.lock` 残留，`crashGuard.ts:100`–`:103`），
   或启动参数 `SLIME_SAFE_MODE=1` 强制进入。
   进入时**只装 `origin: builtin`**，并在扩展页顶部挂一条「上次异常退出，已进入安全模式（扩展未装载）」。
   ⚠️ **安全模式必须能明确退出**（扩展页「信任并重装」按钮 + 清 `run.lock`），否则用户会被卡在坏状态里。
   ⚠️ 这条是**误报友好**取向：`run.lock` 残留也可能来自强杀/断电，代价只是「这次扩展没装、提示一句」，
   而漏判的代价是「坏插件反复把主进程带崩」。
4. **兜底**：以上全失效时的最后手段是手工 —— 把 `<数据根>/config/plugins` 整个改名，
   slime 照常启动（`loadPluginsFromDisk` 遇 ENOENT 返回空清单，见 `loader.ts:67`–`:69`）。

> 这一整套**都不许**做「自动回滚/自动重装扩展」：扩展自己改了 slime 的代码后自动把它改回去，
> 等于让扩展获得了对宿主自身行为的写权限。回滚必须是**用户动作**。

#### 落地步骤

1. **先收紧**：`shared/security-policy.yaml` 不动；新增判定函数落在 `core-ts/src/tools/classifier.ts`
   （`isForeignPluginWrite`），由 `hard_rules.ts` 的 write 分支调用。**这一步单独成一包、单独走守卫与变异。**
2. `core-ts/src/plugin/trust.ts`（新建）：`trust.json` 的读/写 + 默认拒绝。
3. `gui/src/main/index.ts`：扩展页新增「信任本插件的脚本」开关（落 `trust.json`，**不进主配置**）；
   新 IPC `plugins_trust`；`registerScripts` 钩子（**先返回空数组**，即 T1 只落开关不落执行，
   执行能力在下一包，见 §5.1）。
4. T2：确认流复用既有 `askCoordinator` + `PermissionRequestUI` 通道 ——
   超时按拒绝处理（`gui/src/main/index.ts:1812`–`:1818`：定时器到点即
   `approved: false` + 理由「权限请求超时」）、渲染层不可用也按拒绝（`:1822`）。
   **不许新造第二套确认机制。**
   ⚠️ 现状有一处必须改：`index.ts:1806`–`:1808` 的 `d.alwaysAllow` 会调
   `sandbox.approveToolForSession` 做**会话级放行**。T2 档**必须显式不接这条**
   （对齐 `AGENTS.md` §6 的口径：`always-allow` 也不管用，必须本次显式批准）。
5. 安全模式：`startContributionWatchers()` 之前插分支 ——
   `sweepAfterCrash().abnormalExit === true`（`crashGuard.ts:95` 已算出这个判据，**不新增第二套锁文件**）
   或 `process.env.SLIME_SAFE_MODE === "1"` ⇒ 只把 `builtinPluginManifests()` 交给 `host.load()`，
   磁盘来源整批不扫；再在扩展页顶部挂提示条 + 「信任并重装」出口（清 `run.lock` 后重扫）。
   守卫要点：**安全模式下 `loadPluginsFromDisk` 必须一次都不被调用**（用注入 spy 断言），否则等于没拦。
6. 收尾：`py qa.py`（**只改 TS 也照跑**，它是项目约定全量入口）+ 根/gui `tsc` + 全量 vitest +
   全量变异（含既有全部 mut 脚本，防回归）。
7. ~~（独立一包，需用户明确要求才做）D1 开发者模式~~ —— **2026-10-09 已撤销**（用户口径：
   扩展 = 外部武装、可开可关，不改程序本身）。配套的 `git_*` 治理层独立保留（Agent 提交代码用）。

---

### 4.5 实施批次与依赖顺序

| 批 | 内容 | 依赖 | 为什么排这个位置 |
| --- | --- | --- | --- |
| **B0** | §4.4 的「跨插件写入收紧」+ T3 守卫补齐 | 无 | **纯收紧、零新能力**，先把现存缺口堵上，否则后面每加一个面都在扩大暴露面 |
| **B1** | L4b 设置贡献点（先做，因为它最小且不碰渲染层结构） | B0 | 落点单一（一个 store + 一个渲染器），守卫最便宜 |
| **B2** | L4a UI 贡献点，`settings_panel` + `status_item` + `chat_action` 三个槽位 | B1（复用 `UiSlotHost`） | 不含 `page`/webview，风险可控；`page` 单独一包（§5.4 的限制） |
| **B3** | L4c 阶段机（`ChatRunner` 抽象 + `runSingleRound` 抽取 + `stageRunner`） | B0（要能判断插件是否 loaded） | **必须在 B0 之后**：否则「扩展被禁用时模式回落」这条根本无从判断 |
| **B4** | T1 脚本信任（真正 spawn 执行） | B0 + 用户明确要求 | 见 §5.1：本轮**不承诺** |
| **B5** | L4a `page`（webview / http 静态页） | B2 | 见 §5.4 的 webview 限制 |
| **B6** | ~~D1 开发者模式（主干可改）~~ **2026-10-09 已撤销** | — | 改程序本身不是本产品要的自由度（用户口径：扩展 = 外部武装、可开可关）；B6 曾落地后又整体撤除，反回归锁见 §4.4 末 |

**排期决定（2026-10-08，用户授权「接着跑」后拍板）**：

- **B0 ✅ 已完成**（跨插件写入收紧，2026-10-07）。
- **B1 ✅ 已完成**（L4b 设置贡献点：`contributes.ts` / `settings-store.ts` / `settings-service.ts`
  + `PluginsPanel` 声明式渲染；守卫 59 例 + 变异 10/10）。
- **B2 = 下一包（已就绪，可直接开工）**：
  - 范围：`UiSlotHost.tsx`（**新建**）+ `manifest` slots 解析/校验 + 三个挂载点
    （`SettingsDialog` 追加页 / `StatusPanel` 底部行 / 输入栏动作区）+ §4.1 的三槽位；
  - 依赖：B1（`ContributesScope` 家族）；**不**含 `page`/webview（那是 B5）。
  - 验收口径（照 B1 先例）：守卫「声明→渲染→卸载全量重算」三段 + 拨片开关**第三条**
    （`plugins_changed` 广播）+ `ErrorBoundary` 隔离 + 变异全抓。
  - 工作量依据：与 B1 同量级（B1 = 3 个新文件 + 59 守卫 + 10 变异）——**须独占一轮完整执行**，
    不在其他工作轮里切半包落地（项目铁律：不做「有实现没接线」的半成品）。
- **B3 → B5 顺序确认**（B3 阶段机 → B5 `page`）；**B4 / B6 等用户明确要求**（§5.1 / §5.4 的限制仍成立）。
- **B7 ✅ 已完成**（2026-10-09，用户明确要求）：**主题贡献点（皮肤）** + **官方示例扩展包**（见 §4.6）。
  口径来自用户原话：「高自由度扩展本质是**外部插件，可开可关的**……更像『精装』或者说『武装』」——
  皮肤是外部武器的一种：装上就有、卸下即恢复原样，**不修改程序本身**。

**并发约束（硬约束，不是建议）**：`AGENTS.md` §1.3 明确「同工作目录禁止并发写代码」。
本轮 B1–B5 全部落在 `core-ts/` `gui/src/` `tests/` 三个目录 ⇒ **必须串行派工，或用
`git worktree` 给每个 worker 独立物理工作目录**（路径口径见 `AGENTS.md` §1.3）。
子代理撞名/半途而废的排查口径见 `docs/HANDOFF-plugin-system.md` §8。

### 4.6 主题贡献点（皮肤）+ 官方示例扩展（2026-10-09 落地 · B7）

**口径**（用户原话）：「高自由度扩展本质是**外部插件，可开可关的**，而非对程序本身进行修改 ——
更像『精装』或者说『武装』。」⇒ 外观定制 = 插件的一项**声明**，装卸即增删。

- **声明形状**：`contributes.theme = { name, tokens }`；令牌是**白名单**且值形态受限：
  - 色彩（只收 `#RRGGBB` / `#RRGGBBAA`）：accent / accentHover / accentSoft / bg / bgSecondary /
    bgCard / bgInput / bgHover / border / text / textSecondary / textMuted；
  - 形状（枚举）：`font` = system / serif / mono；`radius` = default / round / sharp。
  - 未知字段、未知令牌、非法色值、枚举越界 ⇒ **整份清单被拒**（与 settings/ui 同款 fail-closed）。
- **落值**：核心映射单一产地在 `contributes.ts` 的 `themeTokenAssignments`（色彩→变量、font→
  `--font-ui` 预置栈、radius→四个 `--radius-*`）；渲染层由 `PluginThemeHost` 写到
  `documentElement` 的内联样式；**令牌丢失/换肤/卸载都会清理自己写过的变量**（不残留、不叠加）。
- **可开可关**：皮肤在「设置 → 外观 → 扩展皮肤」里选用；停用/卸载该插件 ⇒ 从可用列表消失 ⇒
  **自动回落默认并清理脏选择**（`resolveActiveTheme` + 宿主组件的清理分支）。
- **与红线的边界**：扩展仍不能贡献 CSS/JSX；主题是「宿主渲染器 + 声明」在颜色维度上的等价物 ——
  **没有任何扩展 CSS 进入宿主样式表**（§4.4 红线段的补充说明）。
- **官方示例包 `hello-slime`**（活教材，随包 `template/plugins`）：把全部贡献类型演示一遍
  （指令 / 设置 / 四 UI 槽位 / 脚本工具 / 自有页面 / 运行模式 / 主题皮肤）；首次启动**播种**到
  `<数据根>/config/plugins`（复用技能播种的台账机制：不覆盖已存在目录、删掉不复活），
  扩展页另有「安装示例扩展」一键入口（已存在则不覆盖）。示例的自有页面演示「完全自定义外观的工作面板」。
- **验证对账**：守卫 `tests/core-ts/a1198-plugin-theme.spec.ts`（22 例：解析 fail-closed / 映射与
  `index.css` 真变量同源 / 回落与落值（注入 root 替身）/ 接线 / **示例包真过 `parsePluginManifest`**）；
  变异 `mut-a1198-plugin-theme.mjs` **19/19 全抓**（含两轮等价变异 triage 的教训：空 tokens 有双校验，
  只短路一处是等价变异 ⇒ 嵌套 sub 双点改）。

---

## 5. 当前还不能承诺的能力（老实写清限制）

这一节是本文档的**免责段**。下面每条都是**当前平台的真实约束**，不是「还没做所以以后做」。

### 5.1 扩展不能贡献可执行代码给宿主（进程内）

- 渲染进程是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`
  （`gui/src/main/index.ts:3329`）⇒ 扩展**无法**在渲染层被 `import`/`require`/`eval`。
  ⇒ L4a 的 UI 只能是**声明式 + 宿主渲染器**。任何「扩展自带 React 组件」的设计在当前架构下**做不到**，
  要做到就得先拆掉 `sandbox`/`contextIsolation`，而那等于**放弃渲染层隔离** —— 代价远大于收益，不做。
- 主进程侧不做「按插件名动态 `require` 一个不受控模块」⇒ 扩展代码**不能**拿到宿主的
  `ToolRegistry` / `SandboxManager` / `fs`。
- **更关键的一条口径**：受保护目录豁免放行的是**写入**，不是**执行**。
  `security-policy.yaml:42`–`:46` 写得很清楚 —— 放行 `config/skills` 与 `config/plugins` 的理由是
  「这两个目录里只有 Markdown 指令 + JSON 清单，无可执行代码、无入口可被 require/import」。
  ⇒ **只要往这两个目录里放 `.mjs`/`.ts`/`.js`，那条豁免的前提就被破坏了**，
  而宿主**不会**因此自动改策略（策略单一产地，人工裁决）。所以「扩展贡献代码」这条路
  **不能靠往插件目录扔脚本走通**，必须走 §4.4 的 T1（显式信任 + `spawn` + timeout），
  并且**要在文档与导引里如实写清这个区别**。上一轮 `creatorGuide` 里
  「`provides`: 本模式写 `["instructions"]`；将来要贡献工具再加 `tools`」
  这句也**不准确**（`tools` 在 GUI 侧是空实现，加了不生效）—— B2/B3 落地时要一并改掉，
  **不能让 Agent 以为加了 `tools` 就有了工具**。

### 5.2 常驻后台进程不承诺

按项目铁律，外部进程一律 `spawn` + **显式 timeout**。⇒ 扩展不能要求「一个常驻的服务」、
不能要求「一个一直在听的端口」（除非它走既有 `httpServer.ts` 那种**宿主代管**的服务，
而那必须由宿主显式起停并纳入 `ContributionScope`）。⇒ 长时任务的正确形态是
既有那套：定时任务 + 子代理（`slime:resident:*`），而不是让扩展自己起 daemon。

### 5.3 主进程改动必须重启才生效

本轮 B0–B6 绝大多数改动落在主进程与渲染层。⇒ **派工后的第一件事是重启应用目视验收**，
不是让用户去猜「为什么没变」。这一点在 `docs/A-1136-office-render-plan.md:203` 已吃过一次亏
（「主进程改动**必须重启应用**才生效（本机是 dev 运行）」）。
⇒ **设计承诺只能到「新请求立即生效」这一级**：`loop_config`、mode 选择、设置项写入都是请求时读，
立即生效；**贡献点装配、主进程分派、信任开关、安全模式都是启动时读，必须重启**。

### 5.4 `<webview>` 的样式与导航限制

- **祖先不能带 `opacity` / `filter` / `backdrop-filter`** —— Chromium 的合成层不支持对
  `<webview>` 的 guest 应用这些属性 ⇒ 一旦把 `<webview>` 放在带这些属性的容器里（浮层、毛玻璃、
  半透明遮罩），guest 内容**会消失或不刷新**。⇒ L4a 的 `page` 槽位**必须**挂在不带这三类属性的
  容器里；宿主自己的磨砂浮层（`.ghost-dropdown`、`.ctx-menu`，见 `gui/src/renderer/index.css:837` / `:935`）
  与 `OperationFocusOverlay` **不得**成为 webview 的祖先。
- **加载本地文件绝不用 `file://`** —— 项目已有明文口径（`docs/research/agent-process-ui-2026-09-28.md:104`：
  「绝不 `loadURL('file://…')` 到 webview；本地内容走应用自有通道」），
  且实测踩过「页面写在临时目录里、紧接着被删 ⇒ 服务报目录不存在 ⇒ 页面只剩重排」
  （`docs/A-1136-office-render-plan.md:228`–`:251`）。
  ⇒ `page` 只能走 `127.0.0.1` 静态服务，目录必须落在**持久目录**，不得用会话临时目录。
- **不需要开 `plugins`** —— 这条**已被实测证伪**（开不开 `plugins`，PDF 近白像素占比 0.641 vs 0.641，
  差 0.0 个百分点，见 `docs/A-1136-office-render-plan.md:206`–`:222`）。
  ⇒ 不许把「开 `plugins`」写成插件页能工作的前提条件。
- `will-attach-webview` 的 guest preload 清洗在审计里被标过（`docs/_archive/AUDIT-2026-09-08.md:246`）
  ⇒ 插件页若要挂 `<webview>`，宿主必须**显式设置 guest 的 preload 与 sandbox**，
  不能依赖默认值。

### 5.5 插件不能改的东西（再说一遍，因为这是最容易「顺手就做了」的地方）

任何开关状态下都不允许：主配置与凭据（`slime.toml` / `agents.json` / `global_config.json` /
`*.enc` / `audit.jsonl` / `history.jsonl` / passphrase）、**策略与门禁自身**
（`security-policy.yaml` / `gen_security_policy.py` / `AGENTS.md` / `CLAUDE.md` / `qa.py` /
`run_tests.py` / `pytest.ini`）、以及**受保护分支上的直接写入**（`main` / `release/*` / `hotfix/*`）。
最后这组是**元层保护**：改了它们就等于改了「谁来管插件」的规则；`main` 上直接写则等于绕过评审。
⇒ 对应 `AGENTS.md` §6 与 §1.1 的口径，**always-allow 也不管用**。
受保护源码目录（`core-ts` / `gui` / `tools` / `shared` / `scripts` / `tests` / `.git`）全禁 ——
且**不存在任何「开发者模式」放行**（2026-10-09 撤销，反回归锁见 §4.4 末）：
本产品不提供「改 slime 程序本身」的通路，能力一律以外部插件形态提供。

### 5.6 其它四条已知做不到 / 不做

- **远程扩展包下载**不做，直到有签名校验（沿用 `docs/plugin-system-design.md` 的裁决）。
- **插件之间的互相调用**不做：没有 `requires` 之外的依赖语义，装载顺序只是拓扑排序，
  不是能力可见性。要做插件间 API 得先有版本化的接口契约，代价远超收益。
- **UI 贡献点不进主进程热插拔**：贡献点装配走 `ensurePluginHostOnce`（启动时一次）
  + `reloadPlugins`（重扫时），**不是**每帧热插。⇒ 「插件 UI 立刻出现」只在**重扫**后成立
  **启停的生效点只有一个**（A-1198）：拨片改动只入草稿，保存后**重扫 + 广播**使其生效，**slime 全程不退出**。
  代价：一次保存要等一次全量重扫（换来的是「不会半生效、不用刷页面、不重启程序」）。
  生效点只有一个，且是确定的。代价：改一次启停要重启一次（换来的是「不会半生效、不用刷页面」）。
- ~~**D1 不保证「装上就能改主干」**~~ **（2026-10-09 该方向整体撤销）**：`git_*` 治理层
  （commit 门禁 / diff 评审 / 无合并权）独立保留、服务「Agent 提交代码」，与「改主干」无关；
  门禁红了就是红了，它不降低 `py qa.py` 的标准，也不绕过 `AGENTS.md` 的分支与身份铁律。

---

## 6. 与「能力自述」的关系（A-1196 同批）

自由度再高，**Agent 不知道自己有什么能力/边界**就全是空转（用户实测：默认模式 Agent 被问
「能给自己写插件吗」时列了四个方向、唯独没提插件体系）。
⇒ 所有模式的 system prompt 现在都注入「你的能力边界」自述：三机制（技能/MCP/插件）+ 当前模式能做什么
+ 升级路径（告诉用户去 Agent 管理切「创造模式」）；创造模式下接完整操作指引。

**本轮要跟着改的两处**（不写进代码，但要在这轮派工单里，别忘了）：

1. `core-ts/src/services/agentTools.ts` 的 `creatorGuide` 里
   「`provides`: 本模式写 `["instructions"]`；将来要贡献工具再加 `tools`」——
   B3 落地前这句是**错的**（`tools` 是空实现），必须改成「当前只有 `instructions` 是真生效的；
   `tools` 需宿主接线后才生效」。
2. B1/B2/B3 每落一包，就要同步往 `creatorGuide` 加该包的**如实描述**（能做什么、写到哪、怎么自验）。
   判据沿用 A-1196：**不许承诺做不到的事**（默认模式说「可以自建插件」这类文案，
   `tests/core-ts/a1196-self-awareness.spec.ts` 已有守卫钉住）。

---

## 7. 验收守卫总表（一页看完）

| 层 | 守卫 spec | 变异脚本 | 关键断言 |
| --- | --- | --- | --- |
| L4a UI 槽位 | `a1198-contributes` / `a1198-ui-slot` / `plugin-host`（扩写） | `mut-a1198-ui-slot.mjs` | 非法声明 rejected；撤销彻底；冲突有标记不静默 |
| L4b 设置 | `a1198-settings-store` / `a1198-contributes` / `a1198-plugin-settings` | `mut-a1198-ui-slot.mjs`（⑥–⑨） | 路径只由插件名推导；坏文件有提示；secret 不明文 |
| L4c 模式 | `a1198-mode-manifest` / `a1198-runner` | `mut-a1198-stage-runner.mjs`（①–⑦） | 优先级对；上下文裁剪；工具失效有说明；插件停用会回落；abort 不续跑 |
| L4d 授信 | `a1198-plugin-write-scope` / `a1198-plugin-trust` / `a1198-approval` / `a1197-contrib-write`（扩写）/（**已撤销的 D1**）反回归锁 `a1198-self-awareness` ① | `mut-a1198-plugin-write-scope.mjs`（①–⑤）/ `mut-a1198-approval.mjs`（⑥–⑧）/ `mut-a1198-protected-surface.mjs`（⑨–⑪）/ `mut-a1197-creator-promise.mjs`（M26–M28 反回归） | 跨插件写 block；无信任不装配；确认不可绕过；元层 block；策略生成幂等；**「改程序本身」无通路（反回归锁）** |

**通用收尾（每批都跑）**：根 `tsc -p tsconfig.base.json --noEmit`、
`gui/` 内 `tsc -p tsconfig.json --noEmit`、全量 vitest、`py qa.py`、
`node gui/scripts/check-mut-anchors.mjs`（不带参数）、`py scripts/gen_security_policy.py --check`。
改了 `gui/src/main/**` 或 `core-ts/src/**` ⇒ **重启应用目视验收**（§5.3）。

**变异纪律**（项目硬规矩，写给派工的人）：反例必须**真的失败**；
锚点必须锚「不变量」而不是「当前这行长什么样」；名字序号 == 数组位置；
锚必须唯一（`mut-a1196` 的 M3 教训：`unmarkPluginDisabled` 含 `markPluginDisabled`，子串匹配会假命中）；
不要用 `python open().write()` 改文件（会把 LF 全转 CRLF，源码文本断言假红）。

---

## 8. 使用速查（资深用户）

- **让某 Agent 能自建插件**：Agent 管理 → 工具配置 → 切「创造模式」。它会获得 `plugin_status`（自验装载）
  与本篇 §2 的固化指导。
- **放宽某个 Agent 的工作量上限**：编辑 `config/agents.json` 对应项的 `loop_config`（表格见 §3），
  保存后对**新请求**生效（无需重启）。
- **关掉某个插件而不卸载文件**：扩展页 → 该插件 → 拨片开关关 → 行上出现「待生效」→
  点**右下角悬浮栏**的「**保存并生效**」（一次写盘 + 重扫 + 广播，界面就地刷新，**slime 不退出**）。
  不想保存可点「放弃改动」。**L4a/L4c 的贡献点同样受这条管**。
- **看插件是否真的生效**：扩展页状态徽章；或让创造模式 Agent 调 `plugin_status`。
  「尚未接线」徽章 = 声明了但宿主没实现，**不是生效**。
  「待生效」徽章 = 你的改动还没写盘（保存重启后才真的生效）。
- **用扩展提供的运行模式**：会话创建/会话设置 → 运行模式 → 选扩展提供的模式名；
  会话头显示当前阶段。停用该扩展 ⇒ 当前阶段收束并**回落到「模型 + 工具」**，对话里会说明。
- **扩展改坏了 slime**：扩展页关拨片 → **保存并生效**（仍关）；再不行启动加 `SLIME_SAFE_MODE=1`
  （只装系统默认插件）；再不行把 `<数据根>/config/plugins` 改名（slime 照常启动）。
  回滚**永远是用户动作**，不会有「自动修回去」。
- ~~想改 slime 主干~~（**2026-10-09 已撤销**）：扩展一律是**外部**能力（可开可关、卸下即恢复原样），
  **不提供改程序本身的通路**。要给 slime 加能力 → 写扩展（上面六类贡献点，扩展页可见可开关）；
  要 Agent 替你提交代码 → `git_*` 工具层（身份 + 门禁 + 评审 + 无合并权）。
