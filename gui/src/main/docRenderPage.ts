
































import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { planRender, type RenderKind } from "../../../core-ts/src/office/renderPlan.js";
import { previewSafeName } from "../../../core-ts/src/previewPage.js";









import jszipSrc from "../../vendor/jszip.min.js?raw";
import docxPreviewSrc from "../../vendor/docx-preview.min.js?raw";
import pptxPreviewSrc from "../../vendor/pptx-preview.umd.js?raw";
import xlsxSrc from "../../vendor/xlsx.full.min.js?raw";


const LIBS: readonly { name: string; src: string }[] = [
  { name: "jszip", src: jszipSrc },
  { name: "docx-preview", src: docxPreviewSrc },
  { name: "pptx-preview", src: pptxPreviewSrc },
  { name: "xlsx", src: xlsxSrc },
];






export function libFileName(libName: string, src: string): string {
  const hash = createHash("sha1").update(src).digest("hex").slice(0, 12);
  return `_lib/${libName}-${hash}.js`;
}


export function renderKey(absPath: string): string {
  let size = 0, mtime = 0;
  try { const st = statSync(absPath); size = st.size; mtime = Math.floor(st.mtimeMs); } catch {  }
  return createHash("sha1").update(`${absPath}|${size}|${mtime}`).digest("hex").slice(0, 16);
}


export function renderDirName(absPath: string): string {
  return `${previewSafeName(basename(absPath))}-${renderKey(absPath)}`;
}


function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


function bootstrapScript(render: RenderKind, fileName: string): string {
  


  const name = JSON.stringify(fileName);
  if (render === "pptx-preview") {
    







    return [
      "var wrap=document.getElementById('stage');",
      "var pv=null,curW=0,timer=null;",
      
      "function availW(){var w=wrap.clientWidth-4;return w>240?w:240;}",
      "function draw(buf){",
      






      "  wrap.innerHTML='';",
      "  pv=window.pptxPreview.init(wrap,{width:curW,height:Math.round(curW*9/16),mode:'list'});",
      "  return pv.preview(buf);",
      "}",
      "fetch(" + name + ").then(function(r){return r.arrayBuffer();})",
      ".then(function(b){",
      "  curW=availW();",
      "  return draw(b).then(function(){",
      "    document.body.setAttribute('data-ready','1');",
      
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
    






    return [
      "var wrap=document.getElementById('stage');",
      "fetch(" + name + ").then(function(r){return r.arrayBuffer();})",
      ".then(function(b){return window.docx.renderAsync(b,wrap,null,{inWrapper:true,breakPages:true,ignoreWidth:true,ignoreHeight:false});})",
      ".then(function(){document.body.setAttribute('data-ready','1');})",
      ".catch(function(e){window.__renderError=String(e&&e.message||e);});",
    ].join("\n");
  }
  if (render === "sheetjs") {
    







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
  
  return "document.body.setAttribute('data-ready','1');";
}


const VIEWER_CSS = [
  "html,body{margin:0;background:#3a3f46;}",
  "*{box-sizing:border-box;}",
  

  ":root{--bar-h:34px;}",
  ".bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:10px;",
  "  padding:8px 14px;background:#2b3038;color:#e5e9f0;font:12px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;border-bottom:1px solid #454b55;}",
  ".bar b{font-weight:600;}.bar .path{color:#8b98ad;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  
  ".notice{padding:7px 14px;background:#4a3f22;color:#f0d79a;border-bottom:1px solid #5d4f2b;",
  "  font:12px/1.5 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;}",
  



  "#stage{padding:20px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;",
  "  min-height:calc(100vh - var(--bar-h));width:100%;}",
  


  "#stage>*:last-child{margin-bottom:0;}",
  



  ".docx-wrapper{max-width:100%;}",
  ".docx-wrapper>section{max-width:100%;}",
  


  "body[data-mode=\"sheet\"] #stage{justify-content:flex-start;align-items:stretch;padding:0 0 16px;}",
  ".sheet-name{margin:14px 16px 6px;color:#c8d0dc;font:600 13px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;}",
  ".sheet-box{background:#fff;margin:0 16px 16px;padding:0;border-radius:4px;overflow:auto;box-shadow:0 1px 3px rgba(0,0,0,.4);}",
  
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






export function buildRenderHtml(opts: {
  render: RenderKind;
  fileName: string;
  title: string;
  libPaths: readonly { name: string; path: string }[];
  




  notice?: string;
}): string {
  
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


export type RenderPageResult =
  | { ok: true; dir: string; name: string; }
  | { ok: false; error: string };

























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

  
  const pdfBase = basename(paths.pdf);
  copyFileSync(pdfAbs, paths.pdf);

  









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







export function writeRenderPage(
  rootDir: string,
  absPath: string,
  displayName?: string,
  opts: { useFallback?: boolean; notice?: string } = {},
): RenderPageResult {
  const plan = planRender(absPath);
  


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
    


    return { name: l.name, path: "/" + rel.replace(/\\/g, "/") };
  });

  const sub = renderDirName(absPath);
  const pageDir = join(rootDir, sub);
  mkdirSync(pageDir, { recursive: true });

  const srcBase = previewSafeName(basename(absPath)) + "." + (absPath.split(".").pop() ?? "bin").toLowerCase();
  const srcRel = srcBase.replace(/[\\/]/g, "_");
  const srcCopy = join(pageDir, srcRel);

  





  const libRelPaths = libPaths.map((p) => join(rootDir, p.path.replace(/^\//, "")));
  const htmlPath = join(pageDir, "index.html");
  

  const wantNotice = (opts.notice ?? "").trim().length > 0;
  if (!wantNotice && existsSync(htmlPath) && existsSync(srcCopy) && statSync(srcCopy).size > 0
      && libRelPaths.every((p) => existsSync(p)) && existsSync(join(rootDir, "viewer.css"))) {
    return { ok: true, dir: rootDir, name: `${sub}/index.html` };
  }

  copyFileSync(absPath, srcCopy);

  
  const render = useFallback ? (plan.fallback as RenderKind) : plan.render;
  const html = buildRenderHtml({ render, fileName: srcRel, title, libPaths, notice: opts.notice });
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(join(rootDir, "viewer.css"), VIEWER_CSS, "utf8");

  

  return { ok: true, dir: rootDir, name: `${sub}/index.html` };
}
