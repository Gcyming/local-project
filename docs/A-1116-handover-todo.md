# A-1116 待办与交接 —— **① ② ③ ⑤ 全部已闭环**（本文件现为完成记录）

> **只读这一个文件就能接着干** —— 下面写明的「交接点」都是已核实过的**事实**（带文件:行号），
> 不要再重新勘查一遍，也不要凭记忆改行号（行号可能因为本轮改动而位移，若对不上就 `grep` 关键词）。
> 最后更新：2026-09-26 18:15 ｜ 状态：**改动全部未提交**（等用户明确指令）
> §3 的四项**全部做完并配了守卫 + 变异**；每项原「待办描述」保留在下方（作为"当时为什么这么定"的判据），
> 只在其下追加「✅ 已落地」+ 证据。**唯一未做的是活实例取证**（见 §4）。
> ⚠️ **§6 = 同日追加的 A-1124**（用户实测四诉求：正文后置闸门复发 / 阶段提前收起 / 渐入全灭 / 待办不跟进）
> —— 与 ① ② ③ ⑤ 无关，但**改了同一批文件**（`ChatPanel.tsx` / `index.css` / 若干守卫与变异脚本），
> 接着干之前**先读那一段**，免得对着旧形状找锚点。

---

## 0. 铁律（每次都适用，别省）

1. **门禁串行**：`node scripts/parse-check.mjs <file>`（改 tsx 时）→ 三处 `tsc --noEmit`
   （根 `tsconfig.base.json` / `gui` / `gateway-ts`）→ 全量 `vitest run --config vitest.config.ts`
   （**必须从仓库根跑**）→ `cd gui && node ./node_modules/electron-vite/bin/electron-vite.js build`
   → `cd gui && node scripts/assert-bundle.mjs`。**不并发**。
2. **每个新守卫必须配变异，且逐条实跑**。判据 = `exit≠0` **且**输出里有剥掉 ANSI 的 `Tests N` 汇总行；
   只看 exit code 会把「vitest 启动失败」误当成「变异被捕获」。
3. **重构打红存量守卫 → 迁移**（保留意图 + 补接线守卫 + 配新变异），**不许删**。
4. **改了宿主 JSX / 类名 / 源码形状 → 同步 `gui/scripts/mut-*.mjs` 的锚点并实跑**
   （锚点漂移 = 那条变异静默未命中 = 守卫已失去保护，与「存活」同罪）。
   每次收尾跑一遍 `node gui/scripts/check-mut-anchors.mjs`（**不带参数**，必须全量），要求
   **未命中 0 / 不唯一 0**。
5. **未获明确指令不提交**；「提交」= commit + push，**永不推 main**。
6. **中文一律用「」**，不许在中文句子/断言名里夹 ASCII 双引号 —— 本轮为此炸过 **3 次** spec
   （`Expected ")" but found "…"`，字符串被截断）。
7. 收尾必须告知用户「**重载窗口 / 重启才看得到**」；并如实说明**哪一条没做活实例取证**（门禁绿 ≠ 用户看得见）。

---

## 2. 已完成（未提交，待提交清单）

| 项 | 内容 | 证据 |
|---|---|---|
| **#305 目录卷轴（投产）** | `railParams.ts`（参数唯一出处）/ `TopicRail.tsx`（wave+ticks 两模式）/ 接入 ChatPanel 与右栏 md 预览 | 守卫 `tests/gui/a1115-topic-rail.spec.ts`(16) · 变异 `mut-a1115.mjs`(17/17 实跑) |
| **设置「外观」栏** | 左侧实时演示框（同一组件同一份参数）+ 全部参数 + **主题已从「通用」迁入**（`THEMES` 搬到 `theme.ts`） | 同上 |
| **时间线动作平铺（真缺陷）** | `TimelineGroupBlock`：**末组也画阶段容器与组头**（原 `foldable=!isLast…` + `if(!foldable) return body` ⇒ 只有一组时组头被跳过 ⇒ 动作平铺） | 迁移 `a1095-timeline-groups.spec.ts`(15) · `mut-a1115` M17 实跑捕获 |
| **④ HTTP 产出任意本地 web 程序** | `http_create_app` 增 `files:[{path,content}]` 任意多文件；`normalizeAppFiles` 拒绝绝对路径/盘符/`..`；描述写清「做成什么样才算好」；回执列真实写入清单 | 守卫 `tests/core-ts/a1116-web-app.spec.ts`(7) · `mut-a1116.mjs`(3/3 实跑) |
| **顺带修掉的守卫缺陷** | a1113 ⑦ 断言过死（迁移）；a1113 ⑧ **自身假红机制**（`\s*(?!none\b)` 的前瞻跟在可回溯 `\s*` 后 ⇒ 把合法的 `scrollbar-width:none` 判违规）⇒ 改成 `(?!\s*none\b)` **并补检测器自检** | `check-mut-anchors` 全量：命中且唯一 1172 / 未命中 0 |

**上一轮门禁结果**（做上面这些时）：三处 tsc 全 0 错 · 全量 vitest **204 文件 / 3821 通过 / 6 跳过** ·
build 绿 · `assert-bundle` ALL PASSED。

---

## 3. 四项已闭环（① → ② → ③ → ⑤；每项下面是"当时的判据"，已全部满足）

### ① 产物按类型分流：有 html 就直接在右栏**浏览器**打开 ✅ 已闭环
- **现状**：产物卡点击 → 有 `diffFull` 就地展开，否则 `requestSidebarOpen({kind:"file", rel, name})`；
  `.html` 落到文件页走 `highlightCode(content,"html")` = **源码**，不是渲染/运行。
- **交接点（已核实）**：
  - `gui/src/renderer/pages/ChatPanel.tsx` 的 `ProductPanel.renderCard`（约 1894-1897）是**决策点**；
  - `requestSidebarOpen(payload)` 定义在 `gui/src/renderer/pages/Markdown.tsx:19`，
    事件 `SIDEBAR_OPEN_EVENT="slime:open-in-sidebar"`，payload 只有 `{kind:"url"|"file", url?, rel?, name?, from?}`；
  - **分流必须放在 `RightSidebar`**（`gui/src/renderer/pages/RightSidebar.tsx` 的
    `SIDEBAR_OPEN_EVENT` 处理处，约 503-536），**不能放 `ProductPanel`** ——
    因为 `ProductItem`（`gui/src/renderer/pages/chatProducts.ts:110`）只有
    `{rel,name,kind,ext?,diff?,diffFull?}`，**没有绝对路径**；而侧栏自己就有 workspace / `readFileAbs`
    **以及 `slimeAPI.http.serve`**（preload 已暴露：`gui/src/preload/index.ts:673-684`）。
- **做法**：侧栏拿到文件后按扩展名分流 —— `.html/.htm` → `slimeAPI.http.serve({ dir: dirname(abs) })`
  → 开**右栏 browser 页**（`TabType` 里已有 `"browser"`，`RightSidebar.tsx:40`）指向
  `http://127.0.0.1:<port>/<name>`；其余仍走 file 页。
- **判据**：点一个 `.html` 产物 → 右栏出现**渲染后的页面**（不是源码）；点 `.md` → 仍是文件页。
- **风险**：`http.serve` 会留一个常驻服务 ⇒ 复用同一个 dir 的服务、或用 `http.stop` 收尾；别每点一次起一个。
- **✅ 已落地**：分流放在 `RightSidebar`（拿文件后按扩展名判）——`.html/.htm` 走 `slimeAPI.http.serve({dir:dirname(abs)})`
  → 开 `browser` 标签页指向 `http://127.0.0.1:<port>/<name>`；其余仍走 file 页。**按 dir 复用同一个服务**（没有每点一次起一个）。
  证据：守卫 `tests/gui/a1120-web-preview.spec.ts` · 变异 `gui/scripts/mut-a1120.mjs`（**16/16 逐条实跑捕获**）。

### ② 让 Agent 能开右栏的终端 / 文件树（右栏 = Agent 的工具栏）✅ 已闭环
- **现状**：**浏览器类 12 个工具已齐全**（`core-ts/src/tools/browser.ts`，走
  `gui/src/main/browserBridge.ts` 且会主动展开右栏）；**终端与文件树没有任何 Agent 工具**。
- **交接点（已核实）**：
  - `core-ts/src/tools/builtin.ts:1306` `sidebarOpenerRef: ((url, name?) => void) | null` +
    `setSidebarOpener`；唯一调用者 `httpCreateApp`（写文件后自动开右栏）。
  - `gui/src/main/index.ts:4567` 的 `setSidebarOpener(...)` 只发 `{"slime:sidebar:open", {kind:"url", url, name}}`。
  - 侧栏标签类型：`RightSidebar.tsx:40` `TabType = "tasks" | "terminal" | "browser" | "git" | "file"`；
    终端面板是 `TerminalTab`（`RightSidebar.tsx` 内定义），用户经「+」`addTab` 打开。
- **做法**：把 opener **扩成 payload 化**（`{kind:"url"|"terminal"|"files", ...}`，**保持旧调用兼容**：字符串入参仍按 url 处理）→
  `main` 原样转发 → `RightSidebar` 按 kind 建对应标签页；然后注册
  `sidebar_open_terminal`（可带 `cmd` 预填）与 `sidebar_open_files`（可带 `root`/`rel`）。
- **判据**：让 Agent「打开终端」→ 右栏真的出现终端页；「打开文件树到 apps/」→ 右栏文件页定位到该目录。
- **✅ 已落地**：opener 已 **payload 化**（`{kind:"url"|"terminal"|"files", …}`，字符串入参仍按 url 处理 ⇒ 旧调用兼容）→
  `main` 原样转发 → `RightSidebar` 按 kind 建标签页；新注册 `sidebar_open_terminal`（可带 `cmd`）与 `sidebar_open_files`（可带 `root`/`rel`）。
  证据：守卫 `tests/core-ts/a1121-sidebar-open.spec.ts` · 变异 `mut-a1121.mjs`（**22/22 逐条实跑捕获**）。

### ③ 回滚产物改动状态（用户点名，最大的一块）✅ 已闭环
- **现状（已核实）**：`rollbackTo`（`ChatPanel.tsx` 约 5432-5449）只做 `messages.slice` + `setInput` +
  `resetPartial` + `api.chat.truncateFrom`；`truncateHistoryFrom`（`core-ts/src/services/history.ts:538-588`）
  **只重写 `history.jsonl`**，对磁盘零影响。`file_write`（`core-ts/src/tools/builtin.ts:395-443`）
  覆盖前**读了旧内容但只喂给 `buildDiffMarker` 做显示、不落盘**。
- **好消息（省一大截工作量）**：`[__slime_diff__]base64(old)|base64(new)` 已经**随
  `reasoning`/`timeline` 落库**（`core-ts/src/services/chat.ts:119-141`）⇒
  「改前内容」其实**已在会话数据里**，只是非结构化、且超 `TRACE_DIFF_MAX=60000` 会被截断
  （`chat.ts:113`）。Python 侧还有 `tools/git.py:860/1000` 的 `git_checkpoint_save/restore`，
  **但未接入 GUI/TS 链路**。
- **做法（建议最小闭环）**：
  1. `file_write` 覆盖前把 `{abs, oldContent|null(新建), newContent}` 追加到一份**结构化清单**
     （按 `sessionId` + 消息轮次归组；放 `data/generated` 之外的一个 jsonl，别塞进 history）；
  2. `rollbackTo` 时按清单**逆序还原**（`null` ⇒ 删除该文件），并在 UI 上先给出「将还原 N 个文件」确认；
  3. 超限内容不搞 base64 塞进对话，改为**落盘快照**（这才是能还原的那一份）。
- **判据**：让 Agent 改 2 个文件 → 回滚该消息 → 两个文件内容都回到改动前；新建的文件被删掉。
- **风险**：还原失败必须**出声**并列出失败清单，不许半途而废（否则用户以为回滚干净了）。
- **✅ 已落地**：结构化账本 `data/file-undo/<session>.jsonl`（`{abs, oldContent|null, newContent, t, sessionId, foreign}`，
  超 `TRACE_DIFF_MAX` 的走**落盘快照**而不是 base64 塞进对话）；`rollbackTo` 先弹「将还原 N 个文件」确认再**逆序还原**
  （`null` ⇒ 删除新建文件）；失败/被占/外来会话改动**逐类出声**（横幅 + 清单，不半途而废）。
  顺带把子代理会话前缀收成**唯一出处** `core-ts/src/services/subagent.ts::SUBAGENT_SESSION_PREFIX`（main 改为 import）。
  证据：守卫 `tests/core-ts/a1122-file-undo.spec.ts` + `tests/gui/a1122-undo-report.spec.ts` ·
  变异 `mut-a1122.mjs`（**27/27 逐条实跑捕获**）。

### ⑤ 屏幕控制提到「业界优秀」✅ 已闭环
- **现状（已核实，及格线之上）**：`core-ts/src/screen/`（工具→controller→backends），桌面走**常驻 PowerShell 宿主**；
  13 种动作；DPI `per-monitor v2`；多显示器取**虚拟桌面原点**；窗口相对→绝对；**明确区分「截图像素」与「逻辑坐标」**、
  无基准时**直接报错不猜**；缩放上限 1600；6 个工具 + `screen.spec` / `a1088` / `mut-a1088`。
- **与业界优秀（Claude Computer Use / OpenAI Operator 公开做法）的差距**：
  1. **动作后没有自动复核** —— 现在只是动作后复截自证，缺「动作前后差异校验 + 失败自动重试」；
  2. **没有元素级定位** —— 桌面端无元素树、点击**无法校验命中**（有 `Set-of-Marks`/编号框的底子：
     `setImageOptimizer` 已能叠刻度网格与编号，`gui/src/main/index.ts:4567` 附近）；
  3. 两个**静默点**：`controller.listTargets` 的 catch 吞、`uiDump` catch 返 `[]` —— 应改为出声。
- **判据**：点击一个按钮后，能在回执里看到「命中校验」结果（命中/未命中），未命中时自动重试一次。
- **✅ 已落地（三处差距逐条对应）**：
  1. **动作后自动复核 + 未命中重试一次**：`controller.verifyFeedback` —— 数据源 = 动作前后两张截图的**像素差异率**
     （`optimize.ts::imageDiffRatio`，注入点与 `setImageOptimizer` 同款，GUI 用 `nativeImage` 实现逐像素带容差比较）。
     判据**三分**（关键）：`ratio === null`（未装配度量 / 参考图没取到 / 两张图不可比）⇒ **没有判据**，
     `hit:true` 且**不重试**（把"没判据"当"未命中"会把一次成功的点击**再点一遍** = 多余的双击）；
     `>= VERIFY_MIN_RATIO(0.2%)` ⇒ 命中；`<` ⇒ 未命中并**原样重试一次**（`attempts` 如实回传）。
     回执里由 `builtin.ts::describeVerify` 统一成一句 `命中校验：✓ 命中 / ✗ 未命中 / 未判定`，
     未命中还给出可操作下一步（重新 `screen_capture`，不要盲目重复同一坐标）。
     ⚠️ 参考图**直调 `backend.capture(target,{marks:false})`**（不经 `this.capture`）——后者会 `rememberBasis`，
     一张整屏参考图会覆盖"按窗口截图"的基准 ⇒ 下一次动作整体偏移。且**只有真的能比较时才拍**
     （否则每次点击白拍一张，并打红既有的"动作后复截恰好一次"判据）。
  2. **元素级定位（桌面 = 窗口粒度）**：`desktop.ts::uiDump()` 用 `listWindows()` 做数据源（复用既有
     `GetWindowRect`，不去啃 UIAutomation 控件树），返回**虚拟桌面坐标**（与 `SetCursorPos` 同空间）；
     同时 `capture` 补上**窗口编号框**（Set-of-Marks 的数据源）——⚠️ 编号框坐标要**减 `originX/originY` 换成图像空间**，
     与 `uiDump` 的坐标空间**刻意不同**，两处不许混用（副屏在左/上时窗口坐标为负，不减就画到图外）。
  3. **两个静默点出声**：`listTargets` → **`listTargetsReport`**（每后端的失败归集进 `failures`，不再 `catch` 吞掉），
     工具层 `screen_info` **逐条列出**失败原因并说明「不是没有目标」；`uiDump` 改**三态** `UiDumpOutcome`
     （未注册 / 无元素树能力 / 抛错都是 `ok:false` 且带原因），`screen_ui_dump` 把「导出故障」与
     「界面没有可操作元素」**分成两态**（导出故障必须抛错、不许返空数组）。
     连带：`controller.perform` 里元素定位也分两态 —— **导出故障**（去修宿主）vs **selector 没匹配**（去改 selector/下滑翻页，
     并报「已导出多少元素」）。
  证据：守卫 `tests/core-ts/a1123-screen-verify.spec.ts`（**38 条**，A 命中校验 / B 元素定位 / C 失败归集 / D 回执措辞 / E 装配点唯一出处）
  · 变异 `mut-a1123.mjs`（**28/28 逐条实跑捕获**，其中 M9 的守卫在**另一个文件** `screen.spec.ts` ⇒ 用 `--specs` 声明，不许手写）。
  ⚠️ 本轮真实踩到的两个坑（已修）：① 新 `VERIFY_ACTIONS` 与 `USER_CONFLICT_ACTIONS` 写成了**逐字相同的行** ⇒
  `mut-a1044` M6 的按行锚点变成"不唯一"（`check-mut-anchors` 抓到）；② 「故障态又附一句『无可用目标』」这种
  **两态同形**没有被任何断言锁住 ⇒ 补 `D7` 的 `not.toMatch(/无可用目标/)` 才捕获 M23。

---

## 4. 全局未验证项（别当成已完成）

- **没有做过活实例取证**：目录卷轴（对话页 / 外观页）、时间线末组阶段容器、`http_create_app` 的新多文件路径、
  ① 的 html 分流、② 的终端/文件树工具、③ 的回滚确认与横幅、**⑤ 的「命中校验」回执行**，
  **都只在源码 + 产物 + 守卫/变异层面证明过**。用户屏幕上是否已经这样，**未验证**。
  ⇒ 交付时如实说明，并请用户**重载窗口（或重启）**后自查；⑤ 尤其要在真机上点一个按钮，看回执里那行
  `命中校验：✓/✗` 是否出现、未命中时是否多注入了一次（变异只能证明"守卫抓得住"，证明不了"宿主接得对"）。
- `#262 工具归组` 的残留：`ChatPanel.tsx` 的 `formatToolSummary`（约 5890）仍供折叠态摘要行用，
  与时间线不是两个归组产地（归组唯一出处是 `todoPanorama.ts::groupTimeline`），但**未提交**。
- **本轮门禁结果**（做完 ③ 收尾 + ⑤ 之后，串行跑）：`parse-check` 绿 · 三处 `tsc --noEmit` 全 0 错
  （根 / `gui` / `gateway-ts`）· 全量 vitest **211 文件通过 / 1 跳过 · 4059 通过 / 6 跳过 / 0 失败** ·
  `electron-vite build` 绿 · `assert-bundle` ALL ASSERTIONS PASSED · `check-mut-anchors`
  **91 份脚本全部命中且唯一（未命中 0 / 不唯一 0）**。

## 5. 已知的设计取舍（用户确认过或需要确认）

- 对话区与右栏 md 的**右侧内边距加宽**：卷轴占位（`RAIL_INSET 6` + 卷轴宽 12 = 18）
  + 「向左隆起」要伸出去的那 12px + 呼吸余量 ⇒ 对话页最终取 **38**（先 30，用户反馈「正文跟卷轴挤在一起」后调到 38）。
  改这个数时**必须**一起看 `TopicRail.tsx` 的 `LEFT_ROOM / RIGHT_ROOM / RAIL_INSET`（那 12 就是它们推出来的）。
  **代价：正文宽度相应变窄**（用户明确要求"把文本那一整块向左移一点"）。
- 卷轴参数**按目标分开存**（对话页 / md 各一份），「恢复默认」只影响当前目标。
- 产物**不做**「每轮结束自动弹右栏」（会很烦）；只做「点击产物按类型选承载」+「应用类产物产出后自动打开」。

---

## 6. 后续追加：A-1124（用户实测四诉求，同日闭环）

> 与本文件的 ① ② ③ ⑤ 无关，但**改了同一批文件**（`ChatPanel.tsx` / `index.css` / 若干守卫与变异脚本）
> ⇒ 接着干之前先读一段，免得对着旧形状找锚点。**细则与证据见 `.workbuddy/memory/2026-09-26.md` §10。**

- **(a) 正文后置闸门「被老设定覆盖」+ (c) 渐入全灭 —— 同根**：同一份正文原有**两套渲染路径**
  （流式现场块有闸门+渐入；**切会话恢复**的占位气泡是裸 `<Markdown>` 且不传 `liveStream`）。
  ⇒ 抽 `GatedBody`（闸门 + 渐入 + 占位**唯一产地**），两条路径共用；守卫 `a1095-body-gate.spec.ts` ⑤
  断言 `<GatedBody` **恰好 2 处**调用（少一处 = 切回来观感回退复发）。
- **(d) 阶段不再提前收起**：折叠判据从**位置**（`group.isLast`）改成**时间**（`holdOpen = Boolean(liveStream)`）。
- **(c) 第二个全局开关**：减动效块 `.stream-fade-unit { animation: none; }` ⇒ 改成**只去位移、留不透明度渐入**
  （⚠️ 该块 HEAD 里就有，是否命中用户系统设置**未证实**；主进程没有强制 `force-prefers-reduced-motion`）。
- **(b) 右侧「待办」列表不跟进 = 该板块既有语义**（只定性未改）：`broadcastTodos` 只在 `todo_write` 拦截时触发，
  切会话时订阅卸载、切回靠 `loadTodos` 拉盘 ⇒ 显示最后一次 `todo_write` 落盘内容。**要改行为需用户明确指令**。
- **迁移了一处存量守卫**（不许删）：`tests/core-ts/a1054-guards.spec.ts:153` 的 `ReasoningSection` 断言
  补上 `liveStream={liveStream}`（全量 vitest 首跑因此 1 红）。
- **本轮门禁**（串行）：`parse-check` 绿 · 三处 `tsc --noEmit` 全 0 错 · 全量 vitest
  **211 文件通过 / 1 跳过 · 4060 通过 / 6 跳过 / 0 失败** · `electron-vite build` 绿 ·
  `assert-bundle` ALL ASSERTIONS PASSED · `check-mut-anchors` 91 份全绿 · 变异逐条实跑
  `mut-a1095s2` 6/6、`s3` 9/9、`s5` 5/5、`mut-a1061-visual` M9、`mut-a1054` C3。
- **未做活实例取证**：四条都没在真窗口里点/看 ⇒ 交付时请用户**重载窗口 / 重启**后自查
  （① 切走再切回一个在跑的会话；② 阶段是否全摊开、收尾才收起；③ 思考与正文渐入是否回来）。
