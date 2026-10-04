





import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildRenderHtml, libFileName, renderDirName, writeRenderPage } from "../../gui/src/main/docRenderPage.js";

const LIBS = [
  { name: "jszip", path: "/_lib/jszip-aaaaaaaaaaaa.js" },
  { name: "docx-preview", path: "/_lib/docx-preview-bbbbbbbbbbbb.js" },
  { name: "pptx-preview", path: "/_lib/pptx-preview-cccccccccccc.js" },
  { name: "xlsx", path: "/_lib/xlsx-dddddddddddd.js" },
];

const html = (render: Parameters<typeof buildRenderHtml>[0]["render"]) =>
  buildRenderHtml({ render, fileName: "file.bin", title: "t.pptx", libPaths: LIBS });


function withRender<T>(fn: (dir: string, srcFile: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "a1136-wp-"));
  const srcFile = join(root, "样本.pptx");
  
  writeFileSync(srcFile, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
  try { return fn(root, srcFile); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("A-1136 ④ 渲染页：自包含 + 不引外网", () => {
  it("库用**根绝对路径**引用（页面在子目录里，相对路径会 404）", () => {
    const h = html("pptx-preview");
    expect(h).toContain('src="/_lib/pptx-preview-cccccccccccc.js"');
    expect(h).not.toMatch(/src="_lib\//); 
  });

  it("不引任何外网资源（离线可用、不违 CSP）", () => {
    const h = html("docx-preview");
    expect(h).not.toMatch(/<link[^>]+href=["']https?:/);
    expect(h).not.toMatch(/@import\s+url\(["']?https?:/);
    expect(h).not.toMatch(/src=["']https?:/);
  });

  it("标题被转义（不转义会被当标签吃掉）", () => {
    const h = buildRenderHtml({ render: "sheetjs", fileName: "f.bin", title: 'a<b>&"c"', libPaths: LIBS });
    expect(h).toContain("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(h).not.toContain("<b>&");
  });
});

describe("A-1136 ⑤ 渲染页：每个渲染器调到**对的**库", () => {
  it("pptx → window.pptxPreview.init(...,mode:'list')（list = 全部页）", () => {
    const h = html("pptx-preview");
    expect(h).toContain("window.pptxPreview.init(");
    expect(h).toContain("mode:'list'");
    expect(h).toContain("pv.preview(");
  });

  it("docx → window.docx.renderAsync（真渲染，非抽文本重排）", () => {
    const h = html("docx-preview");
    expect(h).toContain("window.docx.renderAsync(");
    expect(h).toContain("breakPages:true");
  });

  it("xlsx → window.XLSX.read + **按源文件几何**建表（每张表一块）", () => {
    const h = html("sheetjs");
    expect(h).toContain("window.XLSX.read(");
    expect(h).toContain("wb.SheetNames.forEach");
    



    expect(h).not.toContain("sheet_to_html");
    expect(h).toContain("!cols");
    expect(h).toContain("!merges");
    expect(h).toContain("format_cell");
    expect(h).toContain("<colgroup>");
  });

  it("⚠️ 不许把库名写错（写错 = 运行期 undefined，页面一片空白但**不报错**）", () => {
    
    expect(html("pptx-preview")).toContain("pptxPreview");
    expect(html("docx-preview")).toContain("docx.");
    expect(html("sheetjs")).toContain("XLSX.");
  });
});

describe("A-1136 ⑥ 渲染页：失败必须**出声**（不许静默白屏）", () => {
  it("有错误横幅 + 超时兜底（渲染库不出画面时说明原因）", () => {
    const h = html("pptx-preview");
    expect(h).toContain("id=\"err\"");
    expect(h).toContain("window.__renderError");
    expect(h).toContain("渲染失败");
    expect(h).toContain("setTimeout"); 
  });

  it("⚠️ **每个**渲染器的 catch 都要把错误写进 __renderError（删掉 = 静默转圈 FOREVER）", () => {
    


    for (const r of ["pptx-preview", "docx-preview", "sheetjs"] as const) {
      const h = html(r);
      const m = h.match(/\.catch\(function\(e\)\{([^}]*)\}/);
      expect(m, `${r} 没有 .catch 分支`).not.toBeNull();
      expect(m![1], `${r} 的 catch 没有写 __renderError`).toContain("window.__renderError=");
    }
  });

  it("成功时置 data-ready（与 loading 的 CSS 联动）", () => {
    const h = html("docx-preview");
    expect(h).toContain("setAttribute('data-ready','1')");
    expect(h).toContain("body[data-ready] #loading");
  });
});

describe("A-1136 ⑦ 幂等命名（同内容同路径，防目录膨胀/串版本）", () => {
  it("同一个 src 两次得到同一个库文件名；不同 src 不同", () => {
    expect(libFileName("x", "AAA")).toBe(libFileName("x", "AAA"));
    expect(libFileName("x", "AAA")).not.toBe(libFileName("x", "BBB"));
    expect(libFileName("x", "AAA")).toMatch(/^_lib\/x-[0-9a-f]{12}\.js$/);
  });

  it("渲染页目录名含安全源名 + 16 位键（人可读 + 幂等）", () => {
    const d = renderDirName("D:/a/b/报告 2024.pptx");
    expect(d).toMatch(/^报告 2024-[0-9a-f]{16}$/);
  });
});

describe("A-1136 ⑪ writeRenderPage 真落盘（纯函数断言覆盖不到的那半）", () => {
  it("库文件与页面都写到磁盘上，且**返回的 name 带子目录前缀**（否则服务错文件/404）", () => {
    withRender((root, src) => {
      const r = writeRenderPage(root, src, "样本.pptx");
      expect(r.ok).toBe(true);
      if (!r.ok) { return; }
      
      expect(r.name).toMatch(/^[^/]+\/index\.html$/);
      expect(existsSync(join(root, r.name))).toBe(true);
      
      const sub = r.name.split("/")[0];
      const files = readFileSync(join(root, r.name), "utf8");
      expect(files).toContain("样本.pptx"); 
    });
  });

  it("⚠️ 页面引库用**根绝对路径**（页面在子目录，相对路径必然 404 ⇒ 白屏）", () => {
    withRender((root, src) => {
      const r = writeRenderPage(root, src, "样本.pptx");
      if (!r.ok) { throw new Error(r.error); }
      const h = readFileSync(join(root, r.name), "utf8");
      const srcs = [...h.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
      expect(srcs.length).toBeGreaterThan(0);
      for (const s of srcs) {
        expect(s.startsWith("/_lib/"), `库路径必须是根绝对路径，实际是 ${s}`).toBe(true);
        expect(existsSync(join(root, s.replace(/^\//, ""))), `库文件不存在：${s}`).toBe(true);
      }
    });
  });

  it("⚠️ 老格式/未知类型**拒绝生成**（不许假装能画 ⇒ 用户看到白屏）", () => {
    withRender((root, src) => {
      const legacy = join(root, "老讲义.doc");
      writeFileSync(legacy, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
      const r = writeRenderPage(root, legacy, "老讲义.doc");
      expect(r.ok).toBe(false);
      const r2 = writeRenderPage(root, join(root, "没有扩展名"), "x");
      expect(r2.ok).toBe(false);
    });
  });

  it("文件不存在 ⇒ 明确失败（不静默产出空页面）", () => {
    withRender((root) => {
      const r = writeRenderPage(root, join(root, "不存在.pptx"), "x.pptx");
      expect(r.ok).toBe(false);
    });
  });
});













describe("A-1136 ⑫ vendor 副本与依赖包逐字节一致（手工复制的防漂守卫）", () => {
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

  
  const MAP: { vendor: string; dir: string; pkg: string; src: string }[] = [
    { vendor: "jszip.min.js", dir: "jszip@3.10.2", pkg: "jszip", src: "dist/jszip.min.js" },
    { vendor: "docx-preview.min.js", dir: "docx-preview@0.4.1", pkg: "docx-preview", src: "dist/docx-preview.min.js" },
    { vendor: "pptx-preview.umd.js", dir: "pptx-preview@1.0.7", pkg: "pptx-preview", src: "dist/pptx-preview.umd.js" },
    { vendor: "xlsx.full.min.js", dir: "xlsx@0.18.5", pkg: "xlsx", src: "dist/xlsx.full.min.js" },
  ];

  const repoRoot = resolve(__dirname, "../..");

  it("四个 vendor 文件都在（少一个 ⇒ 构建期就该断，而不是运行期白屏）", () => {
    for (const m of MAP) {
      expect(existsSync(join(repoRoot, "gui", "vendor", m.vendor)), `缺 vendor 文件：${m.vendor}`).toBe(true);
    }
  });

  it("每个 vendor 文件与其声明版本的依赖包内容一致（不是「差不多的版本」）", () => {
    const missing: string[] = [];
    for (const m of MAP) {
      const dep = join(repoRoot, "node_modules", ".pnpm", m.dir, "node_modules", m.pkg, m.src);
      if (!existsSync(dep)) { missing.push(m.vendor + " ← " + m.dir); continue; }
      const a = sha(dep);
      const b = sha(join(repoRoot, "gui", "vendor", m.vendor));
      expect(b, `${m.vendor} 与 ${m.dir} 漂移（手工复制的副本过期了 ⇒ 画的是旧版本）`).toBe(a);
    }
    
    if (missing.length) {
      console.warn("[A-1136 ⑫] 未核验（依赖未安装）：\n  " + missing.join("\n  "));
    }
  });
});

















describe("A-1136 ⑬ 自适应右栏尺寸 + 内容居中（用户实测反馈）", () => {
  const p = html("pptx-preview");
  const d = html("docx-preview");

  it("⚠️ pptx 的宽度必须取**容器实宽**，不许写死像素（写死 ⇒ 窄右栏横向被裁 = 「只显示一半」）", () => {
    expect(p).not.toMatch(/width:\s*1280/);
    
    expect(p).toMatch(/pptxPreview\.init\(wrap,\{width:curW/);
    expect(p).not.toMatch(/pptxPreview\.init\(wrap,\{width:\d/);
    expect(p).toMatch(/availW\(\)/);
    
    expect(p).toMatch(/clientWidth/);
  });

  it("容器尺寸变化时必须**重渲染**（否则拖动右栏后幻灯片不跟着变 ⇒ 仍然被裁/过小）", () => {
    expect(p).toMatch(/ResizeObserver/);
    expect(p).toMatch(/observe\(/);
    
    expect(p).toMatch(/setTimeout\(/);
    expect(p).toMatch(/clearTimeout\(/);
  });

  it("pptx 重画后必须仍是 16:9（缩放比例随宽度走，不能只改宽改高）", () => {
    expect(p).toMatch(/9\s*\/\s*16|0\.5625/);
  });

  it("⚠️ docx 必须 `ignoreWidth:true`（否则锁死 A4 固定宽 ⇒ 窄右栏纸张溢出被裁）", () => {
    expect(d).toMatch(/ignoreWidth\s*:\s*true/);
    expect(d).not.toMatch(/ignoreWidth\s*:\s*false/);
    
    expect(d).toMatch(/ignoreHeight\s*:\s*false/);
  });

  it("⚠️ 舞台必须**垂直居中**且撑满页头以下的高度（否则内容贴在顶上 = 「只放在最上面」）", () => {
    expect(p).toMatch(/justify-content:\s*center/);          
    expect(p).toMatch(/align-items:\s*center/);              
    expect(p).toMatch(/min-height:\s*calc\(100vh\s*-\s*var\(--bar-h\)\)/);
    

    expect(p).toMatch(/#stage\{[^}]*min-height/);
    expect(p).not.toMatch(/#stage\{[^}]*[^-]height:calc\(100vh/);
  });

  it("最后一个块不许留底部 margin（否则 flex 居中把空白算进内容盒 ⇒ 整体偏下）", () => {
    expect(p).toMatch(/#stage>\*:last-child\{margin-bottom:0/);
  });

  it("⚠️ docx 的 .docx-wrapper 不许超出容器（窄屏实测右侧溢出 7px ⇒ 文字被切）", () => {
    expect(p).toMatch(/\.docx-wrapper\{max-width:100%/);
  });
});
