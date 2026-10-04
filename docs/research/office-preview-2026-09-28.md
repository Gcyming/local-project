# 调研：Office 文档在 Electron 里的预览方案（2026-09-28）

> 需求（用户原话）：「所有 Office 办公文件全给我做一遍适配，右侧边栏给我想办法显示正确内容，
> 我记得网页是可以显示的吧？」「至于后面的编辑问题，保留跳转按钮 + 说清只供浏览。」

## 1. 结论先行
「网页可以显示」这句话**是对的** —— 业界两条路线的第一条就是**把 Office 转成 HTML/SVG/Canvas 让浏览器画**：

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **① 格式转换**（主流、效果最好） | 解析文档 → 生成 HTML/CSS（或 Canvas）在页面里"重画" | 自主可控、离线可用、数据不出本机 | 需要解析库；复杂排版会失真 |
| ② 浏览器原生嵌入 | PDF 用 `<embed>`（Chromium 内置 PDFium）；Office 用微软在线预览 `view.officeapps.live.com` | 开发成本极低 | Office 那条**必须联网 + 文档要能公网访问** ⇒ 本机文件不可行；隐私与可用性都不可接受 |

## 2. 各格式的权威做法（来源见 §4）
| 格式 | 业内推荐 | 保真度 | 许可 / 维护 |
|---|---|---|---|
| `.docx` | **mammoth**（→HTML，偏语义）或 **docx-preview**（→HTML，偏版面，`renderAsync` 纯前端） | mammoth 中 / docx-preview 较高 | BSD-2 / Apache-2.0，均活跃 |
| `.xlsx` | **SheetJS(SheetJS CE)** 或 **exceljs** 读成二维数组 → **handsontable / 自绘表格**渲染 | 高（数据层） | CE 为 Apache-2.0（**npm 上是 0.18.5 停更版，现行分发在 cdn.sheetjs.com**）；exceljs MIT 但 Snyk 判 INACTIVE |
| `.pptx` | **PPTXjs**（解析每页元素 → HTML/CSS/SVG 重绘）；或 LibreOffice 转 PDF/图片 | 中 | PPTXjs 社区版质量参差 |
| `.pdf` | **pdf.js**（Canvas 渲染，保真极高） | 极高 | Apache-2.0，Mozilla 维护 |
| **旧版 `.doc/.xls/.ppt`** | ⚠️ **纯 JS 普遍不可靠** ⇒ 正解是 **LibreOffice headless 转 PDF/HTML** 再交给 PDF 查看器 | 转换后高 | 需本机装 LibreOffice |
| 企业级/高保真（公章、修订、公式） | **服务端/本地 LibreOffice headless 统一转 PDF**，前端只负责渲染 PDF | 最高、跨平台一致 | 需要多一个转换步骤 |

## 3. slime 的落地选择（本项目实际采用）
**本轮 = 零依赖的"结构化 HTML 渲染"**（上表路线①的精简版）：
`core-ts/src/doc_text.ts` 已经把 docx / xlsx / pptx / **旧版 OLE** 全部抽成**带轻结构**的文本
（段落 / `A | B` 网格 / `--- 第 N 页 ---`），而 `gui/src/renderer/pages/docView.ts` 把它转成
**真表格 / 分页卡片 / 段落**再由 React 渲染 —— 浏览器"画"HTML 这件事本来就在做。

**为什么不直接引 mammoth / docx-preview / SheetJS**：
1. 本仓是**零新依赖**纪律（打包体积 + 供应链），而文本抽取已经存在 ⇒ 引库会成为**同一事实的第二产地**；
2. 对"读内容"这个需求，**结构**（段落 / 表格 / 分页）比"原版面"重要；
3. 打包与体积：主进程 bundle 有 `assert-bundle` 的体积上限（10MB，现 3.07MB）。

**已确认的可选升级路径（不在本轮实现，等明确需求）**：
- 要**版面保真**：`docx-preview`（Apache-2.0，`renderAsync(buffer, container)`）+ `pptxgenjs`/PPTXjs；
- 要**通吃且高保真**（含 `.doc/.xls/.ppt`、公式、修订）：本机 **LibreOffice headless**
  `soffice --headless --convert-to pdf` → 交给**已有的** PDF 查看器（`<embed>`）；
  这条同时解决"旧版二进制版面保真"这个纯 JS 几乎做不到的点。

## 4. 来源
- 《纯前端实现 Office 文档在线预览：从原理到实战》（两条路线 + 各格式选型）：
  <https://blog.csdn.net/weixin_29229261/article/details/158107524> `[社区综述]`
- 文件预览工具集（Electron + mammoth/xlsx/pdfjs 的完整实现，含 .doc/.xls/.ppt 支持现状）：
  <https://gitee.com/JIJI258/electron_ocr> `[开源实现]`
- 常见预览库对照表（docx→mammoth/docx-preview；xlsx→SheetJS/exceljs；pptx→PPTXjs；pdf→pdf.js）：
  <https://cloud.tencent.com/developer/article/1983760> `[社区综述]`
- 《浏览器端处理 Word 文档的架构陷阱》：复杂公文/公式/嵌套表格在前端解析会崩，
  **正解是 LibreOffice/Office365 转 PDF 再前端渲染**：<https://tsight.io/articles/14345766> `[社区综述]`
- Electron 文档预览与 Office Online 嵌入的取舍（`view.officeapps.live.com` 需要公网可达）：
  <https://tsight.io/articles/14345766> `[同上]`

⚠️ 以上多为**社区综述**而非官方规范；各库的许可/维护状态以 npm/GitHub 当下页面为准（我未逐条打开发布页核对）。
