# 对标 DSH：插件 UI 自由度设计（A-1200）

> 用户口径（本轮）：「我要插件可以任意定制的，你看看 deepseek harness 的插件系统啊，
> 外观市场都给用户做出来了，甚至能自定义主题；还有另一类，自己做功能，还配备专门的 UI。
> 这些都可以出现，为什么我的 slime 不行？你给我对标 deepseek 啊。」
>
> 本设计**只做顶层方案**（用户约束：规划/决策归主会话，底层编码派 `space-bunny-free` 子代理）。

---

## 0. 一句话结论

DSH 能做「任意位置 + 自带 UI + 全屏皮肤」，是因为**它的插件代码直接跑在宿主页面里**
（`dsh.client` + `window.__ModuleLoader__.load()` 把客户端 ESM 注入页面，与宿主同权）。

slime **不抄这条**——不是因为做不到，而是因为**我们已经有一个更好的底子**：
`contributes.page` 的**沙箱 iframe**（127.0.0.1 静态服务 + 跨源隔离）证明「插件自带完整 UI」
和「碰不到宿主」可以同时成立。DSH 的官方 `SAFETY.md` 自己也承认它的沙箱
「不构成安全边界」。

**⇒ slime 的路线：把「4 个固定槽位」升级成「区域注册表 + 两种贡献形态」，并把 iframe
从"右栏一个 tab"提升为"可在任意区域挂载的面板"。**

---

## 1. DSH 的做法（调研，非推测）

| 机制 | DSH 原文/事实 | 来源 |
|---|---|---|
| 客户端插件 | `package.json` 声明 `dsh.client`；Web 前端启动时扫描，经 `window.__ModuleLoader__.load()` 注入**自包含 ESM** | 官方文档 + 社区实测 |
| 运行位置 | **跑在宿主页面里**（与宿主同 DOM、同权） | 同上 |
| 卸载 | Cordis fiber：`registrations are effects that unwind when their plugin unloads` | `cordis-primer.md` |
| 主题形态 | 一个插件带 **N 套皮肤**（JSON），如 `dsh-theme-gallery` 一次给 12 套，含全屏覆盖 + 侧栏场景 + 壁纸 | 插件页原文 |
| 主题定制 | `dsh-theme-customizer`：**七区域背景**（主界面/侧栏/输入区/设置/浮窗/Cordis）、五类文字色、边框色、logo 色、预设导入导出（含图片） | 插件页原文 |
| 自带 UI 的功能插件 | `dsh-better-sidebar`：文件树 + 代码编辑器 + 内置终端 + Git 面板 + 文件预览塞进侧边栏（类 VSCode） | 官方博客 |
| 信任边界 | `SAFETY.md` 逐字：未过安全审计；沙箱「**do not guarantee isolation or prevent damage**」 | `SAFETY.md` |

---

## 2. slime 现状 vs DSH（真实差距）

| 能力 | DSH | slime 现状 | 差距 |
|---|---|---|---|
| 挂载位置 | 任意（注入页面） | **4 个固定槽位** | **大** ← 用户本轮主诉 |
| 插件自带 UI | 插件写前端代码 | 仅**声明式**（宿主渲染 label/icon） | **大** ← 用户本轮主诉 |
| 全屏皮肤 | 主题可全屏覆盖 + 壁纸 | CSS 贡献点在低层 + 作用域内 | 中 |
| 一插件多皮肤 | 一次 12 套 | **一插件一套** | 中 |
| 分发/市场 | dshmarket 839 个 | 无 | 中（后续批次） |

**已具备但没被用足的两块底子**（本轮要激活）：
1. `contributes.page`：插件自有 HTML 已能跑（沙箱 iframe + 127.0.0.1 服务）——但**只能开在右栏一个 tab**。
2. `contributes.css`：任意 CSS 已能落（`@layer` + 作用域）——但**够不到全屏/资源**。

---

## 3. 设计（三个批次）

### B1 · 区域注册表 + panel 形态（对标「任意位置 + 自带 UI」）

**3.1 槽位 → 区域**

`PLUGIN_UI_SLOTS`（4 个）→ `PLUGIN_UI_REGIONS`（13 个）。**既有 4 个名字原样保留**
（向后兼容：老插件不改一个字照常工作），新增 9 个：

| 区域 | 落点 | 形态 |
|---|---|---|
| `settings_panel` ← 既有 | 设置页整页 | item |
| `status_item` ← 既有 | 右栏状态行 | item |
| `chat_action` ← 既有 | 输入栏动作区 | item |
| `toolbar_item` ← 既有 | 输入栏工具条 | item |
| `titlebar_start` | 标题栏左 | item |
| `titlebar_end` | 标题栏右 | item |
| `chat_input_leading` | 输入栏左端 | item |
| `chat_input_trailing` | 输入栏右端 | item |
| `chat_message_actions` | 每条消息的动作区 | item |
| `sidebar_section` | 右栏整块分区 | **item + panel** |
| `status_bar` | 底部状态栏 | item |
| `overlay_floating` | **全屏浮动层（自由定位）** | **panel** |
| `overlay_fullscreen` | **全屏接管层** | **panel** |

`overlay_floating` 是「任意位置」的正解：宿主给一个全屏、`pointer-events: none` 的容器，
插件面板在里面自己定位（`pointer-events: auto` 只在自己的面板上）——
**插件想在哪个角落就在哪个角落**，且仍在沙箱 iframe 里。

**3.2 两种贡献形态**

```json
// ① 声明式（既有，不改）：宿主渲染
{ "slot": "titlebar_end", "id": "ping", "label": "测延迟", "icon": "⚡" }

// ② 面板式（新）：插件自带 UI，宿主给沙箱
{ "slot": "sidebar_section", "id": "files", "kind": "panel",
  "entry": "panel.html", "title": "文件树", "height": 320 }
```

- `kind` 缺省 = `"item"`（向后兼容）
- `kind: "panel"` 时 `entry` 必填（纯相对路径，与 `contributes.page` 同款校验）
- 宿主复用既有 `httpServer.serve({dir, host:"127.0.0.1"})` 起服务，区域内渲染
  `<iframe sandbox="allow-scripts allow-same-origin allow-forms">`
- panel 的**生命周期**：插件停用/卸载 ⇒ 声明撤销 ⇒ iframe 随之卸载（复用既有全量重算口径）

**3.3 与 `contributes.page` 的关系**

`page` 保留（右栏工具条打开 = `toolbar_item` + `page` 的组合），
**panel 是它的泛化**：同一份 HTML，从"一个固定 tab"变成"任意区域可挂"。

---

### B2 · 外观：多皮肤 + 资源 + 全屏层（对标「外观市场/自定义主题」）

**3.4 一个插件多套皮肤**

`contributes.theme`（单对象）→ `contributes.themes`（数组，最多 16 套）。
`theme` 保留为 `themes` 的长度 1 特例（向后兼容）。
这正是 DSH `dsh-theme-gallery` 的形态（一个插件 12 套皮肤）。

**3.5 皮肤资源（壁纸/背景图）**

现状 `url()` 被静态禁令封死（防外联）。放开方式：**只允许插件目录内的相对资源**，
形如 `url(plugin-asset:bg.png)`——宿主校验后改写为 `127.0.0.1` 服务地址。
外联（`http://` / `//` / `data:` 之外的绝对 URL）**仍然拒**。

**3.6 全屏皮肤层**

宿主新增一个**专用皮肤层容器**（`#slime-skin-layer`，在应用最底层，`pointer-events: none`），
皮肤可对它下样式（全屏背景/壁纸/纹理）。**安全关键 UI（权限弹窗等）不在这层之下**，
所以「能全屏改外观」与「盖不掉确认按钮」两件事同时成立。

---

### B3 · 插件自有栏目（views）—— 对标「整块功能区」

> **用户口径纠正（原话）**：「我不是要你去开发外观市场啊，我是给你举个例子。
> **别人甚至能自己造一个影响应用整体风格的功能栏目**，而我的 slime 只能小修小补。」
>
> ⇒ 这一条是**本设计最重要的目标**，比我原先写的"插件市场"重要得多。
> 市场是分发问题；**栏目是能力问题**。用户要的是后者。

#### B1 与 B3 的根本差别

| | B1（已落地） | B3（本批） |
|---|---|---|
| 给的是 | **插入点**：在宿主既有区域里放小组件（按钮/小面板） | **整块栏目**：插件开辟自己的功能区，有独立入口与整块 UI |
| 用户感受 | 还是"在别人的界面里加东西" | **"这个插件给 slime 加了一整个新功能区"** |
| 对标 | 槽位 | DSH `dsh-better-sidebar`（把文件树+编辑器+终端+Git 塞成整块侧栏工作台，整个应用看起来像 VSCode） |

#### 设计

`contributes.views`：插件声明 **一至多个**「栏目」，每个栏目 = 一块插件完全自有的 UI + 一个入口。

```json
"contributes": {
  "views": [
    { "id": "workbench", "title": "开发工作台", "icon": "🛠",
      "entry": "workbench.html", "placement": "main", "order": 0 },
    { "id": "files", "title": "文件树", "icon": "📁",
      "entry": "files.html", "placement": "right", "order": 10 }
  ]
}
```

**`placement`（落点）三选一**：

| 值 | 落点 | 强度 | 说明 |
|---|---|---|---|
| `"main"` | **主区整块视图** | ★★★ | 最接近"影响应用整体风格"：用户可把主区从「对话」切到插件的视图，整块区域归插件。DSH 那种"工作站"就靠它。 |
| `"right"` | 右栏 tab | ★★ | 泛化既有 `contributes.page`：从"一插件一页"变成"一插件多 tab"，且可声明默认打开。 |
| `"left"` | 左栏栏目块 | ★★ | 工作区列表下方的独立栏目（可折叠）。 |

**三条硬口径**：
1. **栏目内容仍是沙箱 iframe**（复用 B1/B2 的 `httpServer.serve` 机制）——
   插件在自己的 iframe 里可以做**任何** UI：自己的导航、自己的布局、自己的状态。
   宿主只提供"一块地 + 一个入口"。
2. **向后兼容**：`contributes.page` 保留，语义 = `views` 里唯一一个 `placement:"right"` 的特例。
   既有插件零改动。
3. **可开可关**：插件停用/卸载 ⇒ 栏目与入口一并消失（既有 `ContributionScope` 口径，无需新机制）。

**为什么这构成"影响应用整体风格"**：主区视图可以由插件**整块接管**——
用户装上插件后，slime 的主界面可以变成插件定义的工作台（文件树+编辑器+终端+看板…），
这正是 `dsh-better-sidebar` 让 DSH"看起来像另一个应用"的机制。

---

## 4. 验收口径（每批都必须）

- 守卫 spec（行为 + 源码锁）+ 变异脚本**全抓**；
- 门禁：双 tsc 0 + 全量 vitest 0 失败 + 锚点全中 + 语法全过；
- **向后兼容**：既有 4 槽位 / 单 `theme` / `page` 的插件**零改动**照常工作（有 spec 钉住）；
- 不静默失效：区域名写错 ⇒ 清单校验**拒**（不是"装载了但看不见"）。

---

## 5. 不做的事（明确）

- ❌ **不把插件代码注入宿主页面**（DSH 路线）。理由：DSH 官方自己承认那是不设防的；
  slime 的沙箱 iframe 已能给出同等 UI 自由度，且不牺牲可预测性。
- ❌ 不让插件覆盖宿主**安全关键 UI**（权限确认/门禁弹窗）——可以改外观，不能藏按钮。
- ❌ 不引入元框架（Cordis）：单体应用引元框架 = 过度工程（A-1197 已裁决）。
- ⏸️ **插件市场（分发）不在本设计范围**：用户已明确「不是要你开发外观市场」。
  市场是分发问题，栏目/外观是能力问题 —— **先把能力做够**，分发单独立项。
