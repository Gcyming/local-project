



















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const APP_TSX = join(ROOT, "gui/src/renderer/App.tsx");
const INDEX_CSS = join(ROOT, "gui/src/renderer/index.css");


function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const appSrc = stripComments(readFileSync(APP_TSX, "utf8"));
const cssSrc = stripComments(readFileSync(INDEX_CSS, "utf8"));


function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}



function cssBlock(src: string, selector: string, must?: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  let first: string | null = null;
  while ((m = re.exec(src)) !== null) {
    if (first === null) { first = m[1]; }
    if (!must || m[1].includes(must)) { return m[1]; }
  }
  expect(first, `取不到 ${selector} 的规则块（守卫自己失效了）`).toBeTruthy();
  return first!;
}

describe("A-1149 ①：悬浮态右栏上限 = 整窗宽（不得再预留 48px）", () => {
  it("rightSidebarMaxW 的 floatActive 分支就是 window.innerWidth", () => {
    const body = fnBody(appSrc, "rightSidebarMaxW");
    const m = /floatActive\s*\??\s*([^:\n]+)\n?\s*:/.exec(body);
    expect(m, "取不到 floatActive 分支（守卫自己失效了）").toBeTruthy();
    const expr = m![1].trim();
    expect(
      /- ?48\b/.test(expr),
      `悬浮分支仍预留 48px：${expr} —— 那 48px 会变成 .main 的实宽（左边缘那条空白）`,
    ).toBe(false);
    expect(expr, `悬浮分支必须直接取整窗宽，实际：${expr}`).toMatch(/window\.innerWidth\s*$/);
  });

  it("非悬浮分支仍保留 CHAT_MIN_W 让位（回归：拖拽上限不受本次改动影响）", () => {
    const body = fnBody(appSrc, "rightSidebarMaxW");
    expect(body).toContain("CHAT_MIN_W");
    expect(body).toMatch(/innerWidth - leftW - CHAT_MIN_W/);
  });

  it("handleToggleFloat 唤出时请求**容器可用宽**（A-1155 修正：不是整窗宽）", () => {
    const body = fnBody(appSrc, "handleToggleFloat");
    const call = /animateRightSidebar\(true,([^)]*)\)/.exec(body);
    expect(call, "取不到唤出调用（守卫自己失效了）").toBeTruthy();
    const arg = call![1].trim();
    expect(/- ?48\b/.test(arg), `唤出仍请求 innerWidth - 48：${arg}`).toBe(false);
    











    expect(arg, `唤出必须请求容器可用宽（整窗宽会越窗），实际：${arg}`).toMatch(/^floatTargetW/);
    expect(
      /const\s+floatTargetW\s*=\s*Math\.max\(\s*560\s*,\s*Math\.round\(window\.innerWidth\s*-\s*leftWNow\)\s*\)/.test(body),
      "`floatTargetW` 的定义不是「`.body` 宽 − 左栏实宽」⇒ 浮层必越窗（A-1155 实测 240px）",
    ).toBe(true);
  });
});

describe("A-1149 ②：右栏 max-width 不得再钉在 100vw - 48px（第二个产地）", () => {
  it("max-width 只有 100%（跟随 wrapper），没有 100vw - 48px 那一半", () => {
    const block = cssBlock(cssSrc, ".right-sidebar", "max-width:");
    const m = /max-width:\s*([^;]+);/.exec(block);
    expect(m, "取不到 .right-sidebar 的 max-width（守卫自己失效了）").toBeTruthy();
    const v = m![1].trim();
    expect(
      /100vw\s*-\s*48px/.test(v),
      `max-width 仍是 ${v}：即使宽度请求整窗宽，也会被这条钉回 48px 缺口`,
    ).toBe(false);
    expect(v, `max-width 必须保留 100%（跟随 wrapper 收缩、不溢出），实际：${v}`).toContain("100%");
  });
});

describe("A-1149 ③：几何前提仍在（这三条一旦被改，上游取值对了也白搭）", () => {
  it("悬浮态主区必须能收成 0（.main.main-float { min-width: 0 }）", () => {
    const block = cssBlock(cssSrc, ".main.main-float");
    expect(block).toMatch(/min-width:\s*0/);
  });

  it("右栏容器可被 flex 收缩 + 内部跟随（左栏展开时右栏让位、不溢出）", () => {
    
    expect(appSrc).toMatch(/className=\{`right-wrapper/);
    const wrapStyle = /ref=\{rightWrapperRef\}[^]*?style=\{\{([^}]*)\}\}/.exec(appSrc);
    expect(wrapStyle, "取不到 right-wrapper 的 inline style（守卫自己失效了）").toBeTruthy();
    












    expect(wrapStyle![1]).toMatch(/flexShrink:\s*1\s*,/);
    expect(wrapStyle![1], "flexShrink 又被写成浮层态禁收缩（A-1157 已实测推翻）").not.toMatch(
      /flexShrink:\s*mainIsFloatLayout/,
    );
    expect(wrapStyle![1]).toMatch(/minWidth:\s*0/);
  });

  it("左栏收起恒为 0 宽（回归钉子）", () => {
    const block = cssBlock(cssSrc, ".sidebar.collapsed");
    expect(block).toMatch(/width:\s*0\s*!important/);
    expect(block).toMatch(/min-width:\s*0/);
  });
});

describe("A-1149 ④：解析器自检（注释里的字面量不许参与判据）", () => {
  it("剥注释后：注释里的 `innerWidth - 48` 不进判据、代码里的仍在", () => {
    const sample = [
      "// 旧值是 window.innerWidth - 48（已删）",
      "/* 也不许：innerWidth - 48 */",
      "const x = window.innerWidth;",
      "const url = 'https://a/b';",
    ].join("\n");
    const stripped = stripComments(sample);
    expect(stripped).not.toContain("innerWidth - 48");
    expect(stripped).toContain("const x = window.innerWidth;");
    
    expect(stripped).toContain("https://a/b");
  });

  it("真实源码里：旧取值只剩三处非悬浮语义（不再多出第四处）", () => {
    





    const codeHits = appSrc.split("window.innerWidth - 48").length - 1;
    expect(codeHits, `非悬浮语义的钳制只应有 3 处，实测 ${codeHits} 处（多出来的那处是不是又给悬浮态预留 48px 了？）`).toBe(3);
    
    expect(fnBody(appSrc, "rightSidebarMaxW")).toMatch(/\?\s*window\.innerWidth\b/);
  });
});
