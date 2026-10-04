# 调研：Agent 工作期过程展示 + 收尾收起（2026-09-28）

> 用途：slime 要迁移「工作期间展开过程 / 结束后收起为最终正文」。本文只记**可落地的判据**与**来源**。
> ⚠️ 标注规则：`[官方]` = 官方文档/官方博客明确写了；`[观察]` = 从截图/文章推断（我已标明）。

## 1. 共同模式（≤12 条）

| # | 模式 | 依据 | 等级 |
|---|---|---|---|
| 1 | **工作期过程必须"持续可见"**：思考、工具调用、进度都要有实时反馈，不能只剩一个转圈 | ① `platform.openai.com/docs/guides/reasoning` 明确用 `reasoning` summary"向用户展示思考进度"；⑥ Nielsen 1993 十条启发式第 1 条 = 系统状态可见性；⑦ Material 官方定义 | `[官方]` |
| 2 | **进度分两类**：不确定型（转圈/流光）用于"不知道要多久"，确定型（进度条）用于"能算进度" | ⑦ Material Progress Indicators 官方定义 | `[官方]` |
| 3 | **工具调用逐条列出、每条自带结果摘要**（不是只写"正在使用工具"）| ③ Cursor 官方文档 "Tool Calls and Results"："记录**每一次**工具调用及其结果，让用户看到 Agent 做了什么改动" | `[官方]` |
| 4 | **长思考以"摘要 + 可展开完整版"呈现**，不把原始思维链全铺开 | ① OpenAI 官方："用 reasoning summary 展示思考进度"，而非原始 CoT | `[官方]` |
| 5 | **收尾把过程折叠为一行/一块**，只留最终结果 | ② Codex 官方："replaced with a concise summary of what it did"；④ Copilot："Surfaces the session log and session details pages"（过程留在可回看的日志页，主界面只给结果） | `[官方]` |
| 6 | **收尾摘要要"简洁"，但不是"删掉过程"**：过程仍可回看（日志页/会话详情/时间线） | ② ④ | `[官方]` |
| 7 | **完成后不得留下"正在做"的中间态**（同一条目不得既"进行中"又"已完成"） | ⑤ Devin 官方 FAQ：每个步骤有状态与摘要，完成即终态 | `[官方]` |
| 8 | **需要人介入时才展开提醒**（需要凭证/权限/澄清/验证） | ⑤ Devin 官方 FAQ | `[官方]` |
| 9 | **事件按时间顺序线性呈现，不重排**；重复/琐碎事件要合并去重 | ①（COT 按"从左到右、发生顺序"）；②（合并重复事件） | `[官方]` |
| 10 | **设置里可调过程详细度**（简洁/详细/仅重要步骤） | ③ Cursor 官方 "Reasoning Display / Command Labels" 设置项 | `[官方]` |
| 11 | **对长命令/长内容做截断 + 摘要**（超长不能原样倒进界面） | ③ | `[官方]` |
| 12 | **用户消息永远可见，不被折叠** | ① NCBI 论文：multi-turn tool-use 对话里"用户输入不会隐藏、保持可见" | `[官方]` |
| 13 | **完成后收起主要服务"扫读"**：文档越长的场景，渐进式披露收益越大、越要"先给结论、细节按需展开" | ⑥ Balcita/Erickson/Keptner：《Progressive Disclosure》（NN/g） | `[官方]` |
| 14 | **用户一旦主动展开，后续内容更新不得把它强行合上**（"位置判据"要换成"用户意图判据"） | ⑥ Nielsen 第 3 条「用户控制与自由」的推论 | `[观察]` |

## 2. 分歧点

| 产品 | 工作期 | 结束后 | 依据 |
|---|---|---|---|
| Cursor | 思考/工具/结果**全部展开** | 过程可折叠，但**不自动折叠**（用户自己收） | ③ `[官方]` |
| Codex | 流式显示命令与改动 | **自动**替换为简洁摘要 | ② `[官方]` |
| Devin | 步骤列表 + 状态 | 保留步骤+摘要，**需要人介入才提醒** | ⑤ `[官方]` |
| Copilot coding agent | 会话日志实时 | 主界面给 PR/结果，过程去 session log | ④ `[官方]` |

⇒ **分歧的本质**：自动收起（省屏幕）vs 用户手动收起（不打断）。**共同点**：过程**永远可回看**。

## 3. 可直接写成断言的判据（迁移到 slime）

1. 流式期：当前阶段**不得**折叠（`canCollapse = hasShell && !isLast && !holdOpen`，`holdOpen = Boolean(liveStream)`）—— slime 已实现（A-1124）。
2. 收尾：最后一次流式结束 ⇒ 过程组**允许**折叠，且**最终正文必须完整留在页面上**（不是"过程累加"）。
3. 过程条目**不得**在完成瞬间消失（可折叠 ≠ 可丢失）。
4. 同一条目不得同时是"进行中"和"已完成"。
5. 用户手动展开过的组，在后续流式更新中**不得**被程序合上（当前 slime 用 `!holdOpen` 判断，会把用户展开的组也合上 ⇒ **这是一个真缺陷**）。
6. 过程中每条工具调用都要有**结果摘要**（成功/失败 + 影响面，如 `+14 -0`）。
7. 正文里**不得**出现过程叙述（= A-1132 已修：交付 `tailText` 而非 `allText`）。
8. 超长过程要截断 + 摘要，不得原样倒出。
9. 减少动效（`prefers-reduced-motion`）下过程仍要完整可读（只去位移不去信息）。
10. 需要用户决策（ask_user）时必须**打断**并置顶。

## 4. 反例 / 风险

- **折叠太早**："流式期"是最需要信心的阶段 ⇒ 提前折叠会让用户以为卡死（NN/g 第 1 条）。
- **过程过长**：与用户最初的抱怨一致（"正文非常长"）—— 收尾必须把过程与正文分开，正文只留结论。
- **自动收起与用户意图冲突**：用户刚展开又被打回去 = 失去控制（NN/g 第 3 条）。
- **只折叠不保留**：用户想回看时找不到 = 违反"过程可回看"这一共同点。

## 5. 来源

- ① OpenAI《Reasoning models》：<https://platform.openai.com/docs/guides/reasoning> `[官方]`
- ② OpenAI《Codex CLI》/《Introducing Codex》：<https://developers.openai.com/codex/cli/>、<https://openai.com/index/introducing-codex/> `[官方]`
- ③ Cursor《Agent 概述》：<https://docs.cursor.com/en/agent/overview>（Tool Calls and Results / Reasoning Display / Command Labels / 截断与摘要）`[官方]`
- ④ GitHub《About GitHub Copilot coding agent》：<https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent> `[官方]`
- ⑤ Devin《Introducing Devin》：<https://cognition.ai/blog/introducing-devin> + Devin 官方 FAQ `[官方]`
- ⑥ Nielsen《10 Usability Heuristics for User Interface Design》：<https://www.nngroup.com/articles/ten-usability-heuristics/>；Balcita/Erickson/Keptner《Progressive Disclosure》：<https://www.nngroup.com/articles/progressive-disclosure/> `[官方/权威]`
- ⑦ Material Design《Progress indicators》：<https://m3.material.io/components/progress-indicators/overview> `[官方]`
- ⑧ NCBI《Agent design pattern characteristics that matter for multi-turn tool-calling LLM agents》`[论文]`
- ⑨ Manus（官方任务面板/收尾交付的公开说明）`[官方]`

### 未找到权威来源的项（不要编）
- Anthropic 官方没有公开"过程展示/收起"的设计规范；官方文档只说明在交互式会话中默认折叠思考过程、长思考会显示前几行。`[观察]`
- v0 / Amp / Aider 未找到官方设计说明。`[观察]`

---

# 附：拖入 .docx/.pdf/.xlsx 触发 `ERR_FAILED (-2)` 的机制与业内做法（2026-09-28）

## 1. `GUEST_VIEW_MANAGER_CALL` ≠ 自定义代码
`<webview>` 的方法经 Chromium 内部 IPC「guest view manager」代理进浏览器进程；失败导航在
`navigationListener → rejectAndCleanup` 里**以未捕获异常形态**打印（`browser_init`）。它与「应用主动请求导航」
和「用户/渲染层发起、渲染层无 JS 代码的导航」在日志里**长得一样**。
⇒ 排查手法：先 `grep -rn "file:///"` 确认**是不是自己造的 URL**（本次事故里全仓为空）。

## 2. 重试风暴的两种典型引擎（本案命中两种）
- **安全网 / 地址写回**：条件写成「期望地址 ≠ 当前地址就再发一次」，而失败导航**不会**让
  `getURL()` 变成期望值 ⇒ 每 300ms 重发 FOREVER。**判据**：失败过的地址必须进"判死账本"，
  自动通路不再重发；用户手动重试才清账。
- **失败后重建 guest**：React 用「失败就把整个 `<webview>` 重建」当自愈 ⇒ 拿不到文件时
  「重建 → 再失败 → 再重建」每 ~1.5s 一个周期，且可能把整个 viewer 一起重挂（= 界面闪）。
  **判据**：重建计数器入 state，超限进终态错误；重建时**保留同一个 DOM 节点**（churn 会加剧闪烁）。

## 3. 本地文件进 webview 的硬规则
- `will-navigate` **拦不住** `loadURL` / 受控 `src` 的**编程式**导航（Electron 文档）。
- `file:` 与 `javascript:` 不该被任何白名单放行（防 XSS → 本地文件读取 → 远程数据外发）；
  `javascript:` 必须拦在 guest 的 `will-navigate`（主框架）与 `will-frame-navigate`（iframe）。

## 4. 推荐架构（本项目采用的）
```
拖入 → 入口闸门 preventDefault（唯一）
     → 按扩展名分类（能力边界：能否被 Chromium 渲染）
        ├─ 可渲染（图片 / PDF / HTML）→ 允许进入查看器
        └─ 不可渲染（docx/xlsx/pptx/pdf-文本/纯文本）→ 文档通道：读取(抽文本) + 预览 + 生成
     → 主进程兜底：guest 导航守卫 + will-download 闸门（两个 session 都装）
```
- 取真实路径：`webUtils.getPathForFile`（Electron 29+；`File.path` 32 起移除）。
- 绝不 `loadURL('file://…')` 到 webview；本地内容走应用自有通道。
- 下载一律显式处理（`will-download`），不留 Electron 默认的"默默写盘 + 自动加序号"。

## 5. 来源
- Electron《webview tag》（`loadURL`/`did-fail-load`/`will-navigate` 覆盖范围）：<https://www.electronjs.org/docs/latest/api/webview-tag> `[官方]`
- Electron《web-contents》`will-download` / `setWindowOpenHandler` / `will-frame-navigate`：<https://www.electronjs.org/docs/latest/api/web-contents> `[官方]`
- Electron《Breaking Changes》：`File.path` 移除（v32）：<https://www.electronjs.org/docs/latest/breaking-changes> `[官方]`
- Electron《webUtils.getPathForFile》：<https://www.electronjs.org/docs/latest/api/web-utils> `[官方]`
- MDN《DataTransfer》/ HTML 拖放模型（drop = 导航到文件是浏览器默认行为）：<https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API> `[官方]`
- Chromium 不支持 OOXML 渲染（PDF 走 PDFium）：<https://chromium.googlesource.com/chromium/src/+/main/docs/> `[官方]`
