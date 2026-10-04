/**
 * gui/src/main/docRenderPage.ts — **「保真渲染页」的唯一产地**（主进程侧）。
 *
 * ## 它解决什么（2026-09-29 用户三轮反馈的收敛）
 * 用户要的是「**类似以图片的形式**直接用 HTML/Web 预览」，而非「转成 md 阅读」。
 * 抽文字再重排版（A-1135 的 `docViewToHtml`）**路线本身做不到保真**：字体/字号/颜色/位置全丢。
 * ⇒ 这里改为：把**原始文件字节**交给**真渲染库**（pptx-preview / docx-preview / SheetJS），
 *   让浏览器按原版式画出来。
 *
 * ## 为什么在主进程生成（而不是渲染层）
 * ① 需要读**原始文件字节**（渲染层没有 fs）；
 * ② 渲染库体积大（pptx 1.4MB / docx 1.2MB / xlsx 0.9MB），要写成**可被静态服务发的独立文件**
 *    （`http.serve` 服务的是一整个目录 —— 这是既有链路，不新造）。
 *
 * ## 产出的目录形状（全部在 `userData/doc-render/` 下，**幂等**）
 * ```
 * doc-render/
 *   _lib/pptx-preview.js        ← 库（写一次，内容哈希命名防串版本）
 *   _lib/docx-preview.js
 *   _lib/jszip.js
 *   _lib/xlsx.js
 *   viewer.css
 *   <源文件安全名>-<哈希>/index.html   ← 每个文件一个子目录，内含该文件的 index.html + 副本
 *   .../<副本文件名>.<ext>
 * ```
 * ⚠️ 每个文件一个**子目录**（而不是平铺）：页与页之间要各自带一份源文件副本，
 *    平铺会让同名不同内容的两个文件互相覆盖。
 *
 * ## 两条硬约束（都来自实测教训）
 * 1. **幂等**：目录名由**源文件路径 + 大小 + 修改时间**决定（同文件重看 ⇒ 同目录 ⇒ 覆盖），
 *    禁止时间戳/自增序号（`previewPage.ts` 的同一条铁律）。
 * 2. **自包含 + 不引外网**：库是随包分发的本地文件，页面**不许**引 CDN（离线可用、不违 CSP）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { planRender, type RenderKind } from "../../../core-ts/src/office/renderPlan.js";
import { previewSafeName } from "../../../core-ts/src/previewPage.js";

/* ⚠️ `?raw` 是 Vite 内置能力：把库的**构建产物源码**读成字符串，随主进程产物一起打包。
   这样运行时不需要去 node_modules 找文件（打包后 node_modules 不一定在），也不引外网。

   ⚠️ 为什么用 `gui/vendor/*.min.js` 而不是 `包名/dist/x.js?raw`：
   `docx-preview` 的 `package.json` 有 `exports: ["."]`，Vite 会**拒绝深层导入**
   （`Missing "./dist/docx-preview.min.js" specifier`）—— 构建期就报错。
   ⇒ 把四个库的 dist **复制进 `gui/vendor/`**，用**相对路径**导入（绕开包解析，四条统一）
   见 `gui/vendor/README`（若有）。升级库时**必须重新复制**这四个文件。 */
import jszipSrc from "../../vendor/jszip.min.js?raw";
import docxPreviewSrc from "../../vendor/docx-preview.min.js?raw";
import pptxPreviewSrc from "../../vendor/pptx-preview.umd.js?raw";
import xlsxSrc from "../../vendor/xlsx.full.min.js?raw";

/** 渲染库清单（内容哈希命名 ⇒ 升级库版本会自动换名，不会被旧的缓存串味）。 */
const LIBS: readonly { name: string; src: string }[] = [
  { name: "jszip", src: jszipSrc },
  { name: "docx-preview", src: docxPreviewSrc },
  { name: "pptx-preview", src: pptxPreviewSrc },
  { name: "xlsx", src: xlsxSrc },
];

/**
 * 库文件在服务目录里的**相对路径**（由内容哈希决定，幂等）。
 * ⚠️ 返回的路径要能被 `writeRenderPage` 写出来、也要能被生成的 HTML 引到 —— 只用这一个函数算，
 *    避免"写的名字"与"引的名字"两处各算一次（`previewPage.ts` 踩过 404 的教训）。
 */
export function libFileName(libName: string, src: string): string {
  const hash = createHash("sha1").update(src).digest("hex").slice(0, 12);
  return `_lib/${libName}-${hash}.js`;
}

/** 一个可渲染单元的定位键：路径 + 大小 + mtime（同键 ⇒ 同目录 ⇒ 覆盖，幂等）。 */
export function renderKey(absPath: string): string {
  let size = 0, mtime = 0;
  try { const st = statSync(absPath); size = st.size; mtime = Math.floor(st.mtimeMs); } catch { /* 调用方会先确认存在 */ }
  return createHash("sha1").update(`${absPath}|${size}|${mtime}`).digest("hex").slice(0, 16);
}

/** 渲染页所在子目录名：`<安全源名>-<key>`（人可读 + 幂等唯一）。 */
export function renderDirName(absPath: string): string {
  return `${previewSafeName(basename(absPath))}-${renderKey(absPath)}`;
}

/** 转义 HTML 文本（标题要进 HTML）。 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 渲染器引导脚本：按扩展名调对应的库。**唯一产地** —— 每个库的调用姿势只写在这里一份。 */
function bootstrapScript(render: RenderKind, fileName: string): string {
  /* ⚠️ 这个字符串会被写进 HTML 的 <script> 里 ⇒ **绝对不许出现反引号或 `${`**
     （本仓铁律 25：模板字符串里出现反引号会提前闭合/触发插值，上一轮就因此 13 条守卫变红）。
     一律用普通字符串拼接。 */
  const name = JSON.stringify(fileName);
  if (render === "pptx-preview") {
    /* ⚠️⚠️ **宽度必须取容器实宽，不许写死 1280**（2026-09-29 用户实测截图）：
       pptx-preview 的 `options.width` 就是**渲染宽度**（`scale = viewPort.width / pptx.width`，
       `renderPort.width = viewPort.width`），而每张幻灯片是 `position:relative` 的固定像素块。
       写死 1280 的后果：右栏窄于 1280 时幻灯片**横向溢出被裁**（用户看到的"只显示一半"），
       而 `#stage` 又是顶部对齐 ⇒ 内容挤在左上角，下面一大片空白。
       ⇒ 取 `#stage` 内容区实宽（= 右栏宽 - padding），窗口/侧栏尺寸变化时**重渲染**。
       ⚠️ 重渲染必须有防抖（拖动侧栏会连续触发 resize）且必须**保留就绪标记**（否则 loading 会回来）。
       ⚠️ 也**绝不能用 `spawnSync` 之类阻塞**——这里是浏览器页，不涉及。 */
    return [
      "var wrap=document.getElementById('stage');",
      "var pv=null,curW=0,timer=null;",
      /* 可用宽度 = stage 客户区宽（已扣掉左右 padding；`clientWidth` 不含 border/滚动条） */
      "function availW(){var w=wrap.clientWidth-4;return w>240?w:240;}",
      "function draw(buf){",
      /* ⚠️⚠️ **必须先清空容器再 init**（2026-09-30 用户实测「全屏后出现一大一小两份」）：
         `pptxPreview.init(el, opts)` 每次都会 `new` 一个实例，其 `_renderWrapper()` 会
         `document.createElement('div')` 并 **append 进 el**（库内部实现，实测确认）。
         而它自己的 `load()` 只清 **它自己那个** wrapper（`e.wrapper.innerHTML=""`）
         ⇒ 在**同一个容器**上 init 两次 = **两个 wrapper 同时留在 DOM 里** = 一大一小两份。
         ⚠️ 库的 `destroy()` 只做 blob 回收（`RZ("destroy")`），**不摘 DOM** ⇒ 靠它没用。
         ⚠️ 触发路径：全屏 / 拉伸窗口 ⇒ `ResizeObserver` ⇒ 再跑一次 `draw()`（就是这个 bug 的来源）。 */
      "  wrap.innerHTML='';",
      "  pv=window.pptxPreview.init(wrap,{width:curW,height:Math.round(curW*9/16),mode:'list'});",
      "  return pv.preview(buf);",
      "}",
      "fetch(" + name + ").then(function(r){return r.arrayBuffer();})",
      ".then(function(b){",
      "  curW=availW();",
      "  return draw(b).then(function(){",
      "    document.body.setAttribute('data-ready','1');",
      /* 容器尺寸变化 ⇒ 换宽度重画（保持居中；防抖 160ms 避免拖动时狂重画） */
      "    var ro=new ResizeObserver(function(){",
      "      var w=availW();",
      "      if(Math.abs(w-curW)<24){return;}",
      "      clearTimeout(timer);",
      "      timer=setTimeout(function(){curW=w;draw(b).catch(function(){});},160);",
      "    });",
      "    ro.observe(wrap);",
      "  });",
      "})",
      ".catch(function(e){window.__renderError=String(e&&e.message||e);});",
    ].join("\n");
  }
  if (render === "docx-preview") {
    /* ⚠️ `ignoreWidth:true` 是**自适应右栏的关键**（2026-09-29 用户实测反馈后改）：
       docx-preview 默认把节属性里的 `pageSize.width`（A4=11906twips≈794px）写成 `section.width`。
       右栏比 A4 窄时 ⇒ 纸张**横向溢出被裁**（用户看到的"只显示一半"）。
       `ignoreWidth:true` = 不锁死纸张宽、随容器撑满 ⇒ 永远不需要横向滚动。
       `ignoreHeight:false` 保留：让长文档仍按 A4 高**分页**（`breakPages:true` 需要它）。
       ⚠️ 与 pptx 不同，docx 的版面是**流式重排**（不是绝对定位的固定像素画布）⇒ 不需要 resize 重渲染，
          浏览器自己会回流。这也正是 docx 能"自适应"而 pptx 必须重画的原因。 */
    return [
      "var wrap=document.getElementById('stage');",
      "fetch(" + name + ").then(function(r){return r.arrayBuffer();})",
      ".then(function(b){return window.docx.renderAsync(b,wrap,null,{inWrapper:true,breakPages:true,ignoreWidth:true,ignoreHeight:false});})",
      ".then(function(){document.body.setAttribute('data-ready','1');})",
      ".catch(function(e){window.__renderError=String(e&&e.message||e);});",
    ].join("\n");
  }
  if (render === "sheetjs") {
    /* ⚠️⚠️ **不用 `XLSX.utils.sheet_to_html`**（2026-09-30 用户实测「表格太粗糙」）：
       它只吐一张**裸 table** —— 没有列宽（`!cols.wch`）、没有行高（`!rows.hpx`）、
       合并单元格也不带 rowspan/colspan、数字格式也不套
       ⇒ 与源文件的"大小/版式"差得远（用户原话：「还是更贴合一点原本格式大小吧」）。
       ⇒ 自己按 `!ref` / `!cols` / `!rows` / `!merges` / `format_cell` 建表（这几样社区版**读得到**）。
       ⚠️ **能还原的是"几何"**（列宽、行高、合并、数字格式）；**配色不保证** ——
          单元格填充色/字体属于"样式"，社区版默认不读（别在文案里承诺还原颜色）。
       ⚠️ 不许用反引号 / `${`（本函数是**字符串数组拼接**出来的 —— 铁律 25）。 */
    return [
      "var wrap=document.getElementById('stage');",
      "document.body.setAttribute('data-mode','sheet');",
      "function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}",
      "function sheetHtml(ws){",
      "  var X=window.XLSX,U=X.utils,ref=ws['!ref'];",
      "  if(!ref){return '<p class=\"sheet-empty\">（空表）</p>';}",
      "  var R=U.decode_range(ref),merges=ws['!merges']||[],cols=ws['!cols']||[],rows=ws['!rows']||[];",
      "  var covered={},span={},i,m,r,c;",
      "  for(i=0;i<merges.length;i++){m=merges[i];",
      "    for(r=m.s.r;r<=m.e.r;r++){for(c=m.s.c;c<=m.e.c;c++){",
      "      if(r===m.s.r&&c===m.s.c){span[r+','+c]={rs:m.e.r-m.s.r+1,cs:m.e.c-m.s.c+1};}else{covered[r+','+c]=1;}",
      "    }}",
      "  }",
      "  var h='<table class=\"sheet\"><colgroup>';",
      "  for(c=R.s.c;c<=R.e.c;c++){var w=(cols[c]&&cols[c].wch)?cols[c].wch:8;h+='<col style=\"width:'+Math.round(w*8)+'px\">';}",
      "  h+='</colgroup><tbody>';",
      "  for(r=R.s.r;r<=R.e.r;r++){",
      "    var rh=(rows[r]&&rows[r].hpx)?rows[r].hpx:0;",
      "    h+='<tr'+(rh?' style=\"height:'+rh+'px\"':'')+'>';",
      "    for(c=R.s.c;c<=R.e.c;c++){",
      "      if(covered[r+','+c]){continue;}",
      "      var sp=span[r+','+c]||{rs:1,cs:1},cell=ws[U.encode_cell({r:r,c:c})];",
      "      h+='<td'+(sp.rs>1?' rowspan=\"'+sp.rs+'\"':'')+(sp.cs>1?' colspan=\"'+sp.cs+'\"':'')+'>'+esc(cell?U.format_cell(cell):'')+'</td>';",
      "    }",
      "    h+='</tr>';",
      "  }",
      "  return h+'</tbody></table>';",
      "}",
      "fetch(" + name + ").then(function(r){return r.arrayBuffer();})",
      ".then(function(b2){var wb=window.XLSX.read(b2,{type:'array'});",
      "  wrap.innerHTML='';",
      "  wb.SheetNames.forEach(function(sn){",
      "    if(wb.SheetNames.length>1){var t=document.createElement('div');t.className='sheet-name';t.textContent=sn;wrap.appendChild(t);}",
      "    var box=document.createElement('div');box.className='sheet-box';box.innerHTML=sheetHtml(wb.Sheets[sn]);wrap.appendChild(box);",
      "  });",
      "  document.body.setAttribute('data-ready','1');",
      "})",
      ".catch(function(e){window.__renderError=String(e&&e.message||e);});",
    ].join("\n");
  }
  /* pdf / text-html 不走这里（由调用方分流），留空避免生成非法脚本 */
  return "document.body.setAttribute('data-ready','1');";
}

/** 页面样式（渲染舞台 + 兜底提示）。⚠️ 里面**不许有反引号**。 */
const VIEWER_CSS = [
  "html,body{margin:0;background:#3a3f46;}",
  "*{box-sizing:border-box;}",
  /* ⚠️ 页头是 sticky 的，会占掉高度 ⇒ 舞台用 `calc(100vh - 页头高)` 才能"垂直居中于可见区域"。
     页头高度=8px*2 padding + 12px*1.4 行高 + 1px border ≈ 34px（本页字体固定，可算）。 */
  ":root{--bar-h:34px;}",
  ".bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:10px;",
  "  padding:8px 14px;background:#2b3038;color:#e5e9f0;font:12px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;border-bottom:1px solid #454b55;}",
  ".bar b{font-weight:600;}.bar .path{color:#8b98ad;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  /* 兜底路线的提示带（走 SheetJS 而非原版式时如实告知）。配色偏"告知"而非"报错"（琥珀色）。 */
  ".notice{padding:7px 14px;background:#4a3f22;color:#f0d79a;border-bottom:1px solid #5d4f2b;",
  "  font:12px/1.5 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;}",
  /* ⚠️ 舞台**水平 + 垂直都居中**，且撑满页头以下的全部高度：
     用户实测反馈「不要像图中一样只放在最上面，就算只能放这么大，也得给我放屏幕最中间」。
     `min-height` 而不是 `height`：内容比一屏高时（多页 pptx / 长文档）要能**正常滚动**，
     不能被 `height` 锁死导致下半截看不到（"以能正常显示所有内容为底线"）。 */
  "#stage{padding:20px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;",
  "  min-height:calc(100vh - var(--bar-h));width:100%;}",
  /* ⚠️ 块间距用 `margin-bottom`，但**最后一个必须归零**：否则 flex 的居中会把这段空白
     也算进内容盒 ⇒ 视觉上整体下偏（实测 xlsx 稳定偏下 40px = 两个 .sheet-box 的 18px×2 余量）。
     这条是「居中」判据能成立的前提（`probe-render-adapt.mjs` 的 ★ 判据）。 */
  "#stage>*:last-child{margin-bottom:0;}",
  /* ⚠️ docx-preview 的 `.docx-wrapper` 在 `ignoreWidth:true` 下按**视口宽**算宽度，
     但 `#stage` 有 12px 左右 padding ⇒ 可用宽少 24px ⇒ 窄屏时**右侧溢出被裁**
     （实测 520 宽窗口下 `.docx-wrapper` 宽 496 > 可用 481，溢出 7px×2，用户看到右侧字被切）。
     ⇒ 强制它不超过容器，并让内部页跟着缩（`section` 也压）。 */
  ".docx-wrapper{max-width:100%;}",
  ".docx-wrapper>section{max-width:100%;}",
  /* ⚠️⚠️ 电子表格**不该居中**（2026-09-30 用户实测「太粗糙、想更贴合原本格式」）：
     源文件里表格是从左上角铺开的、列宽是**源文件定的**，不是"缩成一小块放屏幕中间"。
     ⇒ `data-mode=sheet` 时把舞台改成**左上对齐 + 拉满宽**（其它模式仍保持 ⑬ 的居中）。 */
  "body[data-mode=\"sheet\"] #stage{justify-content:flex-start;align-items:stretch;padding:0 0 16px;}",
  ".sheet-name{margin:14px 16px 6px;color:#c8d0dc;font:600 13px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;}",
  ".sheet-box{background:#fff;margin:0 16px 16px;padding:0;border-radius:4px;overflow:auto;box-shadow:0 1px 3px rgba(0,0,0,.4);}",
  /* `table-layout:fixed` + `<colgroup>` 里的宽度 = 用**源文件的列宽**，而不是"按内容挤成一团" */
  ".sheet-box table.sheet{border-collapse:collapse;table-layout:fixed;",
  "  font:13px/1.5 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#1f2430;}",
  ".sheet-box table.sheet td{border:1px solid #d5d9e0;padding:2px 6px;vertical-align:bottom;",
  "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".sheet-empty{margin:16px;color:#8b98ad;font:13px 'Segoe UI','Microsoft YaHei',sans-serif;}",
  "#err{display:none;margin:40px auto;max-width:680px;padding:16px 20px;border-radius:6px;",
  "  background:#3a2020;color:#ffb4b4;font:13px/1.7 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;}",
  "body[data-ready] #loading{display:none;}",
  "#loading{margin:60px auto;color:#9aa5b4;font:13px 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;text-align:center;}",
].join("\n");

/**
 * 生成**自包含渲染页 HTML**（库用相对路径引用，由 `writeRenderPage` 一并落盘）。
 *
 * ⚠️ 纯函数（不碰 fs）⇒ 可被守卫直接断言（`tests/gui/a1136-render-page.spec.ts`）。
 */
export function buildRenderHtml(opts: {
  render: RenderKind;
  fileName: string;
  title: string;
  libPaths: readonly { name: string; path: string }[];
  /**
   * 页头下方的一条**提示带**（可选）。用途：走**兜底路线**时如实告诉用户"现在不是原版式、怎么才能看到"。
   * ⚠️ 必须真的**可见**：`A-1133` 的教训是"静默降级 = 用户以为功能没做" ——
   *    走了兜底却不吭声，用户会以为"这文件就长这样"。
   */
  notice?: string;
}): string {
  /* ⚠️ 不许用反引号/`${` —— 见 bootstrapScript 顶部警告。 */
  const scripts = opts.libPaths.map((l) => '<script src="' + l.path + '"></script>').join("\n");
  const boot = bootstrapScript(opts.render, opts.fileName);
  const notice = (opts.notice ?? "").trim()
    ? '<div class="notice">' + esc((opts.notice ?? "").trim()) + "</div>"
    : "";
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(opts.title) + "</title>",
    "<style>" + VIEWER_CSS + "</style>",
    "</head><body>",
    '<div class="bar"><b>' + esc(opts.title) + "</b><span class=\"path\">保真渲染 · 原文版式</span></div>",
    notice,
    '<div id="stage"></div>',
    '<div id="loading">正在渲染…</div>',
    '<div id="err"></div>',
    scripts,
    "<script>",
    "window.addEventListener('error',function(ev){var e=document.getElementById('err');",
    "  e.style.display='block';e.textContent='渲染失败：'+(ev.message||ev.error||'未知错误');});",
    "window.addEventListener('load',function(){setTimeout(function(){",
    "  if(window.__renderError){var e=document.getElementById('err');e.style.display='block';",
    "    e.textContent='渲染失败：'+window.__renderError;}",
    "  if(!document.body.hasAttribute('data-ready')&&!window.__renderError){",
    "    var e2=document.getElementById('err');e2.style.display='block';",
    "    e2.textContent='渲染库没有产出画面（可能这个文件不是标准的该格式，或文件已损坏）。';}",
    "},8000);});",
    "</script>",
    "<script>" + boot + "</script>",
    "</body></html>",
  ].join("\n");
}

/** 写渲染页的结果（调用方据此拼 URL）。 */
export type RenderPageResult =
  | { ok: true; dir: string; name: string; }
  | { ok: false; error: string };

/**
 * 阶段 C：给**已经转好的 PDF** 包一个查看页（把 PDF 复制进服务目录，页里用 `<embed>` 画）。
 *
 * ## 为什么不直接把临时目录交给 `http.serve`
 * 可以直接交 —— 但那样 URL 指向的是"某个随机临时目录里的文件"，而 `http.serve` 是**按目录**服务的，
 * 同一目录复用。用随机临时目录会让**每转一次就多开一个静态服务**（端口越开越多，直到耗尽）。
 * ⇒ 统一复制进一个固定目录（`<root>/<sub>/`），URL 稳定、服务可复用。
 *
 * ## 为什么用 `<embed>` 而不是把 PDF 字节塞进页面
 * ① Chromium 内置 PDF 查看器只认**真 PDF 资源**（`<embed type="application/pdf">` 或 `application/pdf` 响应），
 *    塞 base64 进 HTML 在顶层页面下会被某些 Electron 版本拒；
 * ② 右栏既有的 PDF 预览（`RightSidebar` 的 `preview.mime === "pdf"` 分支）用的就是 `<embed>` ——
 *    **同一形态**，用户看到的是同一个查看器（缩放/翻页/查找都有）。
 *
 * ⚠️ `srcRel` 必须与页面同目录（相对路径），不要写成根绝对路径 —— 那样又要多一条"服务根"心智负担。
 * ⚠️ 本函数**只搬文件**，不负责删除源 PDF（那是调用方的 `cleanupConvertDir`）。
 */
/**
 * 一页「PDF 查看器页」的两个落点（**唯一产地**）。
 *
 * ⚠️ 命名规则**不许在别处再算一遍**：主进程要用它做**缓存命中判断**（命中就跳过 LibreOffice 转换），
 *    而 `writePdfViewerPage` 要用它决定"写到哪"。两处各算一次 = 迟早漂（铁律 11），
 *    漂了的表现是"缓存永远不命中"或"命中了一个空目录"，都很难查。
 */
export function pdfViewerPaths(rootDir: string, absPath: string): { html: string; pdf: string; name: string } {
  const sub = renderDirName(absPath);
  const pdfBase = previewSafeName(basename(absPath)).replace(/\.[^.]+$/, "") + ".pdf";
  return { html: join(rootDir, sub, "index.html"), pdf: join(rootDir, sub, pdfBase), name: `${sub}/index.html` };
}

export function writePdfViewerPage(rootDir: string, pdfAbs: string, absPath: string, displayName?: string): RenderPageResult {
  if (!existsSync(pdfAbs)) { return { ok: false, error: `转换产物不存在：${pdfAbs}` }; }
  const title = (displayName ?? "").trim() || basename(absPath);
  const paths = pdfViewerPaths(rootDir, absPath);
  const pageDir = join(rootDir, renderDirName(absPath));
  mkdirSync(pageDir, { recursive: true });

  /* 同名源 PDF 直接搬过来（名字跟源文件走，人看得懂；同一源文件重转会覆盖，天然幂等）。 */
  const pdfBase = basename(paths.pdf);
  copyFileSync(pdfAbs, paths.pdf);

  /* ⚠️⚠️ 查看器页**先取字节、再喂给查看器**，而不是让 `<embed>` 直接指向服务器 URL
     （2026-09-30 用户实测「.doc 一片空白 + 弹『无法打开 chrome-extension:// 链接』」后的加固）：
     直接指 URL 时，Chromium 的 PDF 查看器（**它本身是个内置扩展**）会自己去取那个地址，
     这条链路要穿过本应用的 **独立 session（`persist:slime-browser`）+ 导航守卫 + 下载闸门**，
     任何一环不认它就只剩一块**空白灰底**、而且**页面上一个字都不说**（用户只能来问我们）。
     ⇒ 改成：页面自己 `fetch` 拿字节 → 生成 `blob:` URL 喂给 `<embed>`。
        · 绕开 session/分区/导航守卫对"查看器内部取数"的干扰；
        · **失败可见**：`fetch` 不 ok 就把 HTTP 状态与地址写在页面上（不再有"空白且无言"这种状态）；
        · blob 与服务器 URL **同源同内容**，渲染结果一字不差。
     ⚠️ 不许用反引号 / `${`（本函数的 HTML 是**字符串拼接**出来的，不是模板字符串 —— 铁律 25）。 */
  const pdfLit = JSON.stringify(pdfBase);
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(title) + "</title>",
    "<style>",
    "html,body{margin:0;height:100%;background:#3a3f46;}",
    "*{box-sizing:border-box;}",
    ".bar{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#2b3038;color:#e5e9f0;",
    "  font:12px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;border-bottom:1px solid #454b55;}",
    ".bar b{font-weight:600;}.bar .tag{color:#8b98ad;font-size:11px;}",
    ".pdf{display:block;width:100%;height:calc(100vh - 34px);border:none;background:#525659;}",
    ".hint{padding:14px;color:#c8d0dc;font:13px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;}",
    ".err{margin:14px;padding:12px 14px;border:1px solid #7a3b3b;background:#3a2426;color:#f3c7c7;",
    "  border-radius:6px;font:13px/1.7 'Segoe UI','Microsoft YaHei',sans-serif;white-space:pre-wrap;}",
    "</style></head><body>",
    '<div class="bar"><b>' + esc(title) + "</b><span class=\"tag\">保真渲染 · 原文版式</span></div>",
    '<div id="loading" class="hint">正在加载 PDF…</div>',
    '<div id="err" class="err" style="display:none"></div>',
    '<embed id="viewer" class="pdf" type="application/pdf" style="display:none">',
    "<script>",
    "(function(){var v=document.getElementById('viewer'),e=document.getElementById('err'),l=document.getElementById('loading');",
    "var url=" + pdfLit + ";",
    "function fail(msg){l.style.display='none';e.style.display='block';e.textContent='PDF 没能显示：'+msg;}",
    "fetch(url).then(function(r){if(!r.ok){throw new Error('取 PDF 失败：HTTP '+r.status+'（'+url+'）');}return r.blob();})",
    ".then(function(b){var o=URL.createObjectURL(new Blob([b],{type:'application/pdf'}));",
    "  v.addEventListener('load',function(){l.style.display='none';});",
    "  v.src=o;v.style.display='block';",
    "  setTimeout(function(){if(l.style.display!=='none'){l.textContent='PDF 已取到，正在交给查看器…';}},1500);})",
    ".catch(function(x){fail(String((x&&x.message)||x));});",
    "})();",
    "</script>",
    "</body></html>",
  ].join("\n");
  writeFileSync(join(pageDir, "index.html"), html, "utf8");
  return { ok: true, dir: rootDir, name: paths.name };
}

/**
 * 落盘一个**保真渲染页**：库文件（写一次）+ 每文件子目录（index.html + 源文件副本）。
 *
 * ⚠️ 只处理**能保真渲染**的（`planRender().faithful && 无 needs`）。
 *    老格式/未知类型由调用方分流，不在这里假装能画。
 */
export function writeRenderPage(
  rootDir: string,
  absPath: string,
  displayName?: string,
  opts: { useFallback?: boolean; notice?: string } = {},
): RenderPageResult {
  const plan = planRender(absPath);
  /* ⚠️ `useFallback` **只用来触发 plan 里已登记的兜底路线**，不允许调用方塞任意渲染器 ——
     否则 `.doc` 也能被"指定"成 `pptx-preview`，画出来必然是空白（等于把能力边界当儿戏）。
     没登记 `fallback` 的类型即使传了 `useFallback` 也照常拒绝。 */
  const useFallback = opts.useFallback === true && !!plan.fallback;
  if (!useFallback && (!plan.faithful || plan.needs)) {
    return { ok: false, error: `该类型不支持保真渲染（${absPath}）` };
  }
  if (!existsSync(absPath)) { return { ok: false, error: `文件不存在：${absPath}` }; }

  const title = (displayName ?? "").trim() || basename(absPath);
  const libDir = join(rootDir, "_lib");
  mkdirSync(libDir, { recursive: true });
  const libPaths = LIBS.map((l) => {
    const rel = libFileName(l.name, l.src);
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) { writeFileSync(abs, l.src, "utf8"); }
    /* ⚠️ 页面在**子目录**里（`<sub>/index.html`），而库在**根**（`_lib/…`）。
       若写相对路径 `_lib/x.js`，从子目录解析会变成 `<sub>/_lib/x.js` ⇒ 404。
       ⇒ 一律用**根绝对路径**（前导 `/`）——`http.serve` 的根就是 `rootDir`，与 URL 拼装对齐。 */
    return { name: l.name, path: "/" + rel.replace(/\\/g, "/") };
  });

  const sub = renderDirName(absPath);
  const pageDir = join(rootDir, sub);
  mkdirSync(pageDir, { recursive: true });

  const srcBase = previewSafeName(basename(absPath)) + "." + (absPath.split(".").pop() ?? "bin").toLowerCase();
  const srcRel = srcBase.replace(/[\\/]/g, "_");
  const srcCopy = join(pageDir, srcRel);

  /* ⚡ **命中即返回**（2026-09-30 用户反馈「所有 Office 文件拖入后响应都很慢」）：
     目录名 `renderDirName(absPath)` 里已经含了**内容指纹**（路径+大小+mtime 的 hash）
     ⇒ **目录存在就等于"这份文件的这一版已经渲染过"**，重写 page/copy 只是白费 I/O。
     ⚠️ 必须连"页面 + 源文件副本 + 库文件"三者都确认在位才敢走快路径 ——
        缺任何一个都可能服务出 404/白屏（比慢更坏）。
     ⚠️ 这条**不是**"另加一层缓存"：目录名本身就是键，过期由文件名变化自然处理（不会服务旧内容）。 */
  const libRelPaths = libPaths.map((p) => join(rootDir, p.path.replace(/^\//, "")));
  const htmlPath = join(pageDir, "index.html");
  /* ⚠️ 带 `notice` 的**不走快路径**：提示条内容取决于"这次为什么降级"，缓存会显示**过期的理由**
     （比如上次"没装 LO"、这次"转换失败"）—— 那比慢更坏（用户会照着错的理由去装东西）。 */
  const wantNotice = (opts.notice ?? "").trim().length > 0;
  if (!wantNotice && existsSync(htmlPath) && existsSync(srcCopy) && statSync(srcCopy).size > 0
      && libRelPaths.every((p) => existsSync(p)) && existsSync(join(rootDir, "viewer.css"))) {
    return { ok: true, dir: rootDir, name: `${sub}/index.html` };
  }

  copyFileSync(absPath, srcCopy);

  /* ⚠️ 注意这里是**生效路线**（可能是兜底路线），不是 `plan.render`。 */
  const render = useFallback ? (plan.fallback as RenderKind) : plan.render;
  const html = buildRenderHtml({ render, fileName: srcRel, title, libPaths, notice: opts.notice });
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(join(rootDir, "viewer.css"), VIEWER_CSS, "utf8");

  /* ⚠️ `name` 必须带**子目录前缀**：URL 是 `base/<name>`，而页面在 `<sub>/index.html`。
     漏掉前缀 ⇒ 服务的是根 index.html（可能是别的文件或 404）——就是 `previewPage.ts` 那个 404 的同宗。 */
  return { ok: true, dir: rootDir, name: `${sub}/index.html` };
}
