# 交接文档 · slime 插件系统（P1–P5 + S1–S4 + 可逆性收尾）

> **给接手者的话**：本文档是**自包含**的——新会话/新账号没有历史上下文也能接手。
> 所有「已交付 / 欠账 / 基线数字」都是**换号前最后一次实测**（2026-10-06 22:16 前后，Git Bash），
> 不是凭记忆写的。**接手第一步：按 §7 重跑一遍门禁基线，确认磁盘上还是这个状态，再动手。**
> 项目铁律：动手前先 `ls` + 读源码，别信任何文档（包括本份）里的「已做 / 未做」声明。

---

## 1. 一句话

slime（Electron + React19 + TS monorepo，桌面多 Agent 应用）的**「一切皆插件」扩展体系**
已从「技能 / MCP 混装 + 创造模式只是粗浅命名」重构为：
**统一插件容器（可装卸）+ 三类来源（系统默认 / Agent 自建 / 外部载入）+ 可逆贡献 + 技能白名单强制力 + 诚实对外身份 + Apache-2.0 许可**。
本轮同时完成了一份 **DSH / 8 家厂商插件体系调研**，给出了「创造模式该怎么做」的裁决依据。

## 2. 当前工作树状态（实测）

- **分支**：`deepseek-correction-fork`（⚠️ 不是记忆里记的 `slime/v0-0-6`，**以 git 实测为准**）
- **未提交改动**：**82 个文件**（本轮全部改动**尚未 commit**，都在工作树里——这是资产，换号不会丢，但也没进版本库）
- **本轮 19 个新增文件全部落盘**（`core-ts/src/plugin/` 6 文件 + `product.ts` + `http-identity.ts` + 6 个 spec + 2 个 docs + LICENSE + THIRD-PARTY-NOTICES），状态为 `??` 未追踪
- **未提交 ≠ 会丢**：都在磁盘工作树；但也没进 git，**别指望 `git stash` 或分支切换能找回**

## 3. 已交付清单（每一项都过了门禁 + 有守卫测试）

### 插件系统核心（`core-ts/src/plugin/`，测试全绿）
| 文件 | 行数 | 作用 |
|---|---|---|
| `scope.ts` | 52 | `ContributionScope`：注册即副作用、**逆序撤销、幂等、单失败不阻断** |
| `manifest.ts` | 122 | `PluginManifest` + `parsePluginManifest`（**fail-closed** 校验） |
| `host.ts` | 247 | `PluginHost`：拓扑排序 + 传递性失败传播 + 环检测 + 重名拒绝 + `unload` 永不抛 |
| `builtin-plugins.ts` | 396 | 内置能力登记为**系统默认插件**（穷尽）+ `auditBuiltinCoverage` 覆盖自检 |
| `loader.ts` | 230 | 磁盘扫描装载 + 不可见 Unicode 投毒检测 + **`readPluginSkillNames` / `pluginSkillsRoot`（技能归属映射）** |
| `product.ts` | 36 | 对外身份**单一产地** `slime/0.0.8`（有守卫对齐 package.json） |
| `http-identity.ts` | 49 | 申请类流量身份入口（`applicationUserAgent`/`githubHeaders`/`identityHeaders`） |

### 各阶段
- **P1/P2**：可逆贡献原语 + 清单 + 加载器（地基）
- **P5**：内置能力穷尽登记为系统默认插件（`auditBuiltinCoverage` 实测 **58 工具覆盖 / 0 漏登 / 0 多余**）
- **P3**：「扩展」页 UI（三来源块 + 系统默认插件块）+ IPC `plugins_list/reload/unload`
- **P4**：技能白名单**强制力**（`agentToolsOnly` 之前根本没读 `profile.skills`，已修）
- **S1**：`host.ts` 两处瑕疵修复（去硬编码 `SKILL_TOOLS` / 去 `ToolRegistry` 硬依赖，`unload` 改返回报告）
- **S2**：`loader.ts` 磁盘装载 + creator 升级「写完整插件」+ 外部载入
- **S3**：产品身份统一 + 模型请求 4 处 headers 加 UA + 半伪装 UA 修正
- **S4**：LICENSE（Apache-2.0 全文 203 行）+ THIRD-PARTY-NOTICES.md
- **限流闸门三态**：`rateLimit` 恒真回归已修（`rateLimitGateOpen`），双向变异验证
- **插件按来源卸载**：`SkillRegistry.unloadBySource` / `loadFromSource`（**按名精确撤销、幂等、系统来源 fail-closed**），25 条新守卫

### 测试规模（插件相关，实测全绿）
`plugin-{scope,manifest,host,builtin,loader,unload-scope}` + `product` + `http-identity` = **约 159 例**（含 25 条 unload-scope、29 条 http-identity）。

## 4. 设计心智模型（这是全体系的纲）

```
插件（Plugin）= 可装卸容器（有来源 / 版本 / 清单）
   ├── 贡献「指令」instructions → SkillRegistry   （技能在这，指令层）
   ├── 贡献「工具」tools        → ToolRegistry    （MCP 桥接的工具在这，能力层）
   └── 贡献「提示词」prompt     → systemPrompt    （尚未接线，明确标注 WIRING_PENDING）
```
- **Skill = 指令层，MCP = 工具的一种来源**——它们**不是同层的两个类型**。
- **借 DSH 的 `ctx.effect()` 概念，不引 Cordis 实现**（slime 是单体应用，元框架 = 过度工程）。
- 可逆性内核 = `ContributionScope`：注册即副作用，卸载时逆序自动撤销。

## 5. 创造模式（creator）—— 裁决已出，落地未做

**调研结论（`docs/plugin-ecosystem-survey.md`，771 行，8 家对照）**：
- DSH 仓库是**公开的**（`deepseek-ai/deepseek-harness`，MIT）。文档站是 SPA，**子页全 404，要读仓库 `docs/` 原文**（每页有 `.zh.md`）。
- DSH 的 Creator 模式 = preset id `cordis`，**切 preset 起新任务（不发提示词）** + 3 个专属 skill + 只多 `tool-cordis`（2 个只读查询工具）。
- **DSH 做过「让 Agent 直接生成并运行插件」，2026-09-16 主动删掉**，理由是**架构重复**（generated-code tools 会另起一条 plugin lifecycle），不是安全洁癖。
- **裁决：creator 与 default 同工具面很可能是对的**。多挂「创造类通用工具」是坏实践（Claude Code 也警告「已启用插件的 skill 描述每轮都占 token」）。

**slime 该走的路**（设计设想，未实现）：
> 同工具面 + 少量**专用管控工具**（如 `plugin_list` / `plugin_create_scaffold` 只读或脚手架，非通用创造工具）+ **更强的 `creatorGuide` 指导**（已升级为「写完整插件」）—— **不靠多挂工具**。

**现状**：`agentTools.ts` 的 creator 分支仍是「同 `DEFAULT_TOOL_PROFILE` + 注入 `creatorGuide` 文本」。
要落地裁决，下一步是加「少量专用管控工具 + 把 creatorGuide 里的自验三步做实」，**这是独立一包，未做**。

## 6. 欠账清单（⚠️ **别当已修**，分级）

### A. 真欠账（有明确修复路径）
1. **`PluginHost.load` 覆盖式重装不撤销上一轮 scope**（`entries.clear()` 直接丢旧 disposer）。
   接线层用 `pluginSkillSourceHandles` Map 打了「先撤上一轮再重装」的补丁，但**核心层无保证**——绕过接线直接调 `host.load` 会泄漏句柄。修 `host.ts` 设计。
2. **creator 模式落地未做**（见 §5）—— 裁决出了，代码没动。
3. **`pptx-preview` 的 ISC 许可文本需人工确认**（`gui/vendor/pptx-preview.umd.js` 无内嵌许可，只从 npm 包 package.json 推断）；
   **Python 14 项依赖的 LICENSE 原文未逐字核对**（THIRD-PARTY-NOTICES 里填的是官方声明值，建议发布前 `pip-licenses` 实测）。
4. **`xlsx` 版本钉死在 0.18.5（Apache-2.0）**——升级 0.19+ 会换 SheetJS 自有协议，**升级时必须重查许可**。

### B. 需实测才能定论（静态断不了）
5. **`chromiumFetch` 是否真透传 User-Agent**（GUI 主链路走 Electron `net.fetch` 优先于 Node fetch）。
   若它覆盖了 UA，**主链路至今对供应商是匿名流量** —— 这可能是你被封号的真因之一。**需抓包确认。**
6. **`providers.ts:694/1400/1957` 供应商探测请求无 UA**，与模型请求指纹不一致（上轮超授权范围未改）。
7. **`chromiumFetch` 叠加重试 ×3 ⇒ 最坏 12 次/逻辑调用**（未改）。
8. **`provider` 态的 gate 是构造时快照**：存在「早于 manual RPM 注入的首请求」窗口（生产里三路径都落 explicit，实际不影响，但严格说有窗口）。

### C. 行为变化（方向对，知情即可）
9. 无闸门时不再 `observe` ⇒ 「撞 429 后靠响应头学额度」的自我强化在**零配置**场景失效（换不来阻塞卡死）。

### D. 用户未肉眼验收（主进程改动需重启才生效）
10. **扩展页 UI**（三来源块 / 29 族折叠 / 深色主题观感）**没跑过 Electron 目视确认**。
11. **P4 的 creator 豁免**（`origin: agent` 技能在 creator 下绕过白名单）仍是唯一「放宽而非收紧」处，需你知晓。

## 7. 门禁基线（**接手第一步：重跑一遍确认**）

```
分支          deepseek-correction-fork
根 tsc        6 条既有错误 / 0 新增   （全在 tests/core-ts/：a1123-screen-verify ×1、
              a1166-left-w-feedback ×1、ask-user-contract ×1、context-compress-defects ×3）
gui tsc       0 错误
全量 vitest   1 failed | 277 passed | 1 skipped (共 279)
              唯一的红 = tests/gui/a1113-scrollbar-capsule.spec.ts 的「⑦ 唯一产地」那条（既有基线红，与本体系无关）
build         上一轮 exit 0（§3 之后未再改源码，建议接手时重跑确认）
```
跑法（**必须从仓库根**，vitest 用 `node node_modules/vitest/vitest.mjs run --config vitest.config.ts`；
tsc 根用 `-p tsconfig.base.json`，gui 进 `gui/` 用 `-p tsconfig.json`，**都带 `--noEmit`**）。

## 8. 给接手 agent 的护栏（本轮踩出来的坑）

- **落盘 ≠ 可用**：被 429 / 空返回打断的子代理留下的代码可能**根本编译不过**（本次 `loader.ts` 的
  JSDoc 里 `skills/*/SKILL.md` 的 `*/` 提前终止块注释，导致 24 条语法错误）。**中断后必先 `tsc` 再谈验收。**
- **测试「超时」≠「断言失败」**：症状是 timeout，根因常在**跨用例共享的单例状态**（本次是进程级 `RpmLimiter` 的 20s 冷却）。先判症状类型再查根因。
- **`if (x)` 从可选变必有 ⇒ 恒真**：把「调用方显式传了才…」的守卫改成必有值，是最隐蔽的回归制造方式。
- **⚠️ 整文件 python 读写会把 LF 全转 CRLF** ⇒ 源码文本断言假红。改文件一律用 Edit/Write，别用 `python open().write()`。
- **别信上一轮子代理的「已核实」**：本次 `llmGateway.ts` / `engine.ts` 是否传 `rateLimit`，子代理说「没传」，实测**都传了**。
- **子代理撞名 / 半途而废时**：先查 `mtime` + 当前 `export`，判断是不是它**自己迭代覆盖**（本次 `http-identity.ts` 是它自己重写自己）。
- **AGENTS.md §1.3：同工作目录禁止并发写代码**。本轮全程**串行**发子代理（曾因并发让两个子代理互相覆盖 5 次、8 条红）。
- **中文串禁用 ASCII 双引号**，一律「」（项目铁律 25，ASCII 引号会断串）。
- **未获明确指令一律不提交**；「提交」= commit + push（**永不推 main**）。

## 9. 建议的接手顺序（如果你要继续）

1. 重跑 §7 门禁基线确认绿。
2. 抓包验证 §B.5（`chromiumFetch` 是否透传 UA）—— 这直接关系封号问题。
3. 决定 §5：要不要落「creator 模式按 DSH 方案」（同工具面 + 少量专用管控工具 + 更强指导）。
4. 收尾 §A：修 `PluginHost.load` 覆盖重装不撤销上一轮 scope；补 `pptx-preview` / Python 依赖许可原文核对。
5. 你肉眼验收扩展页 UI（需重启应用）。

---

## 10. A-1195 更新记录（2026-10-06 晚，接手轮：终止按钮修复 + 欠账补齐）

> 本节由接手会话追加。**原 §1–§9 保持原样**（它们是交接当时的证据快照）；本节只记录
> 「哪条欠账被消掉了、用的什么方法、验证在哪」。**未处理的条目继续以 §6 原文为准。**

**先修的用户主诉**（不在原清单里，用户当晚新报）：终止按钮「加载半天没反应 / 模型出问题时停不下来」
⇒ 诊断出 5 个 abort 盲区（重试退避 sleep / chromiumFetch 降级链 / 限流冷却 / 传唤与强制轮无 signal /
工具 Promise.all 干等）+ UI 15s 看门狗兜底。守卫 3 spec + 变异 `mut-a1194-stop-cancel.mjs`（13/13）。
详见工作日志 `10-06 §A-1194`。

**欠账逐条状态（A-1195）**：

| §6 条目 | 状态 | 落点与验证 |
| --- | --- | --- |
| A.1 `PluginHost.load` 覆盖重装不撤销 scope | ✅ **已修** | `host.ts` 的 `load` 改 async：重建前 `await disposeAllEntries()`（逆序、失败不阻断但 console.error）；四条守卫在 `plugin-host.spec.ts` 的 A-1195 describe（重装撤销/消失插件也撤/逆序/失败不阻断）；变异 M1–M3（`mut-a1195-debts.mjs`）。**接线层补丁保留**（句柄登记簿职责，注释已更新） |
| A.2 creator 模式落地 | ✅ **已落地** | 裁决照做：同工具面 + **1 个只读管控工具 `plugin_status`**（creator-only 可见，`CREATOR_ONLY_TOOL_NAMES`）+ creatorGuide 自验升为**四步**（第 1 步先查装载状态）。守卫 `a1195-creator-tools.spec.ts`（6）；工具已登记 `builtin-plugins.ts` 新族 `plugin-management`（58→59 工具）；`TOOL_LABELS` 已补（a1091 守卫当场抓住过一次缺登记） |
| A.3 许可核对 | ✅ **已逐字核对并修正** | `pptx-preview`：官方 tarball 47 文件复确认无 LICENSE ⇒ 补 `gui/vendor/pptx-preview.LICENSE.txt`（ISC 标准文本 + README 授权照录 + 核验记录）；Python 14 项 `pip download` 逐包读 wheel 内 `METADATA`+LICENSE 原文，**纠正旧表 4 处偏差**（beautifulsoup4→MIT、prompt_toolkit→BSD-3、python-multipart→Apache-2.0、cryptography BSD-2→BSD-3）。NOTICES §1/§3 已更新；证据 `_tmp-py-licenses/_report.txt` |
| A.4 xlsx 0.18.5 | ⏸ 保持（提示性） | 升级 0.19+ 必须重查许可（NOTICES §1 已明文） |
| B.5 chromiumFetch UA 实测 | ✅ **已实测结案** | 新探针 `gui/scripts/probe-ua-transmission.mjs`（本地 echo + 独立 Electron）：**net.fetch 原样透传显式 UA**（`slime/0.0.8 probe` 原样到达）；未给 UA 时默认值为 Chromium/Electron UA；**无 sec-ch-ua 自相矛盾指纹**。**结论：主链路不匿名，「封号真因=匿名流量」此条排除** |
| B.6 探测请求无 UA | ✅ **已修** | `providers.ts` 5 处探测（tryFetchModels / getJson / detectApiFormat / probeProvider×2）统一走 `identityHeaders()`；守卫 `a1195-ua-probes.spec.ts`（行为：本地 echo 断言 UA=productUserAgent；形状：≥5 处接线） |
| B.7 重试叠加「最坏 12 次」 | ✅ **已落档 + 有界守卫** | 分析落档在 `FETCH_RETRY_ATTEMPTS` 注释（两层处理不同错误域、共享同一超时窗口 ⇒ 总时长有界、连接失败时服务器不可见）；守卫 `a1195-chromiumfetch-bounds.spec.ts`（持续失败有限时间 settle + 次数常量锁）。**行为未改**（保留网络抖动容错） |
| B.8 gate 构造时快照 | ✅ **实测证伪 + 守卫** | 读码 + `a1195-gate-live.spec.ts`（3 例）：`rateLimitGateOpen` 是**请求时实时查询**（同一 identity 注入前后判定会变）——「构造时快照」说法不成立；已 export 该函数供守卫直接钉住 |
| C.9 无闸门不 observe | ⏸ 知情项（保持） | 行为变化方向正确，未动 |
| D.10 扩展页 UI 目视 | ⏳ 仍待用户 | 主进程改动需重启应用后肉眼验收（连同本轮 A-1195 的 creator 工具面） |
| D.11 creator 豁免 | ⏳ 知情项 | `allowAgentAuthored` 仍是唯一「放宽」处，未动 |

**本批新增守卫/脚本**：`plugin-host.spec.ts`（+3 例）/ `a1195-creator-tools.spec.ts` / `a1195-ua-probes.spec.ts` /
`a1195-chromiumfetch-bounds.spec.ts` / `a1195-gate-live.spec.ts`；变异 `gui/scripts/mut-a1195-debts.mjs`（8 条，**8/8 抓住**）；
探针 `gui/scripts/probe-ua-transmission.mjs`。

**本批还顺带修复的基础设施**：`_mut-eol.mjs` 的行尾自检夹具已腐坏（`updater.ts` 从 CRLF 变 LF ⇒
全仓 mut 脚本都跑不了批）——已改为**虚拟样本注入**（与仓库行尾现状解耦）。详见 `10-06 §A-1194` 事故清单。
