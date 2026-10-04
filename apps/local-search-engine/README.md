# Slime Search（本地 + 全网搜索器）v3.2.0

单文件应用 `index.html`，离线可用，无外链依赖。双击即可在浏览器打开。

## 功能（v3.2.0）
- **本地模式**：选择文件夹/文件/拖放建立倒排索引（BM25 + 中文二元切分），命中高亮、分页、标题点击看全文弹窗。
- **全网模式**：优先接入 slime 内置浏览器内核做实时联网检索；若自建索引服务（core/websearch，`127.0.0.1:8600`）在线，会把服务命中作为「自建索引 · 补充命中」叠加显示；内核未接入时降级为纯服务检索（见下方接线说明）。
- **联想下拉**：聚焦搜索框即展开「搜索历史 + 热门搜索」；输入时实时联想；↑↓ 选择、Enter 搜索、Esc 关闭；可逐条删除历史或一键清空。
- **搜索记录页**：顶栏「搜索记录」进入，含模式徽标、时间，可重搜/逐删/清空（localStorage 持久化，最多 20 条）。
- **热门搜索 / 相关搜索**：本地模式展示索引高频词；结果页底部生成相关词条。
- **手气不错**：直达首个结果（本地打开全文弹窗，全网打开首个网页）。
- **主题**：**不再由本页主动切换**；页面被动跟随 slime 主程序下发的配色，独立打开时跟随系统明暗。

> v3.2.0 变更：原「联网」与「全网」两个模式**合并为一个「全网」模式**（内核为主、索引服务为辅）；移除页面自带的配色切换按钮与本地持久化。

## 主题（被动跟随）
页面侧 API 仍保留：`window.SlimeSearch.setTheme('dark'|'light'|'auto')`（供宿主下发）。
被 slime 接入后：宿主 → 页面 `window.SlimeBrowserHost.onTheme(cb)` 订阅，首次加载再用 `getTheme()` 拉一次；页面 → 宿主 `reportTheme(detail)` 透传。
本版页面**不会**自行改配色、也不写 localStorage。

## 联网/全网接线（宿主侧）
宿主向页面注入 `window.SlimeBrowserHost`：

| 成员 | 作用 |
| --- | --- |
| `name` | 字符串；页面顶栏的「已接入：X」角标 |
| `query(q)` → `Promise<{ok,engine,engineName,items}>` | 全网检索（宿主侧唯一产地 `core-ts/src/search/onlineSearch.ts`） |
| `notify(evt)` | 上报页面事件（`ready`/`mode`/`results`/`open`/`page`/`index`/`error`） |
| `onTheme(cb)` / `getTheme()` | 主题订阅 / 主动拉取 |
| `reportTheme(detail)` | 页面回传主题 |

宿主实现两处（都在 slime 仓库内）：`gui/src/main/searchBridge.ts`（IPC 注册 + 来源白名单）与 `gui/src/preload/searchHost.cjs`（guest preload，注入上面这个对象）。
页面侧接入判据 = `window.SlimeBrowserHost` 在不在 + `stats().onlineHost`。

⚠️ 页面原设计的 `postMessage` 通道**在右栏 webview 里不生效**（`<webview>` 是独立顶层 frame，`window.parent === window`），仅作为「页面被同源 iframe 承载」时的降级路径保留；优先走宿主注入对象。

> Self-built index service: `core/websearch/python3 server.py --db search.db --port 8600`，页面可改地址并持久化。
