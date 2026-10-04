































import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "out", "dist", ".git"]);






const SHADOW_ROOTS = ["gui/src", "core-ts/src", "gateway-ts/src", "shared", "tests"];


const TYPECHECK_ONLY_CFG = ["tsconfig.base.json", "gui/tsconfig.json"];


const EMIT_CAPABLE_CFG = ["core-ts/tsconfig.json", "gateway-ts/tsconfig.json"];





function findTsShadows(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { walk(p); } continue; }
      if (!/\.(js|jsx)$/.test(e.name)) { continue; }
      const base = p.replace(/\.(js|jsx)$/, "");
      if (existsSync(`${base}.ts`) || existsSync(`${base}.tsx`)) { out.push(p); }
    }
  };
  walk(dir);
  return out;
}









function stripJsonc(src: string): string {
  let out = "";
  let inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i += 1; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 1; }
      else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i += 1; continue; }
    if (c === "/" && n === "*") { inBlock = true; i += 1; continue; }
    out += c;
  }
  return out;
}


function readTsconfig(rel: string): { compilerOptions?: Record<string, unknown> } {
  return JSON.parse(stripJsonc(readFileSync(join(ROOT, rel), "utf8")));
}

describe("A-1030 ① 源码树下不得有编译影子 .js", () => {
  for (const rel of SHADOW_ROOTS) {
    it(`${rel} 下不得存在与 .ts/.tsx 同名的 .js/.jsx`, () => {
      const shadows = findTsShadows(join(ROOT, ...rel.split("/")));
      expect(
        shadows,
        `${rel} 发现 ${shadows.length} 个编译影子 —— 它们会**顶替 .ts 源码**被 test/运行时加载，` +
        `让守卫"通过但锁错对象"。请删除（裸 tsc 的产物，非交付物）：\n` +
        shadows.slice(0, 20).map((s) => "  " + s.replace(ROOT, "")).join("\n"),
      ).toEqual([]);
    });
  }

  it("扫描器自检：临时目录里造一对影子必须被检出（否则本守卫是永远为真的死守卫）", () => {
    const dir = mkdtempSync(join(tmpdir(), "slime-shadow-selftest-"));
    writeFileSync(join(dir, "plain.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "plain.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "only-ts.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, "no-sibling.js"), "// 无 .ts 兄弟，不算影子\n");
    const found = findTsShadows(dir).map((p) => p.split(/[\\/]/).pop());
    expect(found, "必须认出与 .ts 同名的 .js").toEqual(["plain.js"]);
  });

  it("扫描器自检：.jsx 影子同样要被检出", () => {
    const dir = mkdtempSync(join(tmpdir(), "slime-shadow-selftest-jsx-"));
    writeFileSync(join(dir, "Comp.tsx"), "export const C = () => null;\n");
    writeFileSync(join(dir, "Comp.jsx"), "export const C = () => null;\n");
    expect(findTsShadows(dir).length).toBe(1);
  });
});

describe("A-1030 ② 配置层：该禁 emit 的禁住，该能 emit 的不能被连坐", () => {
  for (const rel of TYPECHECK_ONLY_CFG) {
    it(`${rel} 必须显式 noEmit: true`, () => {
      const cfg = readTsconfig(rel);
      expect(
        cfg.compilerOptions?.noEmit,
        `${rel} 是**类型检查**配置（构建入口是 electron-vite / pnpm -r build），` +
        '`"declaration": false` 只挡 .d.ts、挡不住 .js —— ' +
        "一旦有人漏写 `--noEmit` 裸跑 tsc，就会把编译副本吐回源码树并永久顶替 .ts（A-1030 现场）",
      ).toBe(true);
    });
  }

  for (const rel of EMIT_CAPABLE_CFG) {
    it(`${rel} 必须显式 noEmit: false（extends 根配置，否则构建被连坐成空转）`, () => {
      const cfg = readTsconfig(rel);
      expect(
        cfg.compilerOptions?.noEmit,
        `${rel} extends 根配置、产物落 dist，是**构建**配置；` +
        "根配置上了 noEmit 之后它必须显式盖回来，否则 `pnpm -r build` 静默不产出",
      ).toBe(false);
      
      expect(cfg.compilerOptions?.outDir, `${rel} 必须指定 outDir，产物不能落在源码树里`).toBeTruthy();
    });
  }

  it("反假阳：读取器确实读得到真实配置（不是恒真）", () => {
    expect(readTsconfig("tsconfig.base.json").compilerOptions?.noEmit).toBe(true);
    
    
    expect(readTsconfig("core-ts/tsconfig.json").compilerOptions?.outDir).toBe("dist");
    expect(readTsconfig("gui/tsconfig.json").compilerOptions?.target).toBe("ES2022");
  });

  it("注释剥离器自检：通配符路径里的「双星号+斜杠」不能被当成注释（本次实测踩过）", () => {
    const jsonc = [
      "{",
      "  // 行注释",
      '  "include": ["src/**/*.ts"],',
      "  /* 块注释 */",
      '  "x": 1 // 尾注释',
      "}",
    ].join("\n");
    const parsed = JSON.parse(stripJsonc(jsonc)) as { include: string[]; x: number };
    expect(parsed.include, "glob 必须原样保留").toEqual(["src/**/*.ts"]);
    expect(parsed.x).toBe(1);
  });
});
