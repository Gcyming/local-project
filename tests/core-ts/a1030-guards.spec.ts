/**
 * tests/core-ts/a1030-guards.spec.ts — A-1030 守卫：**源码树里不许有编译影子 `.js`**。
 *
 * 现场（2026-09-20，查 A-1029 的变异测试时挖出来的）：
 * `gui/src` 下并排躺着 75 个 `.js`（含 `chatProducts.js` 共 76 个），
 * 加上 `core-ts/src`、`gateway-ts/src`、`shared` 共 **95 个**。
 * 它们都不是交付物（`git ls-files` 命中 0 —— 干净检出根本没有这些文件），
 * 而是**一次裸 `tsc -p tsconfig.base.json`（漏了 `--noEmit`）就地 emit 出来的**。
 *
 * 后果不是"多了几个文件"，而是**测试静默锁错对象**（本项目最贵的一类失效）：
 * `tests/core-ts/*` 用 `.../chatProducts.js` 这种说明符 import 源码，
 * `.js` 真实存在时 vite 直接命中**编译副本**，`.ts` 源码根本不进模块图。
 *
 * 决定性证据（探针实测）：`.ts` 里 `DIFF_FULL_MAX_RENDER = 111111`、`.js` 里留 `400000`，
 * 探针读出 **400000**。A-1029 的 14 条变异里 5 条（M2–M6）因此"改坏也不红"；
 * 把 `.js` 移走后同样 5 条立刻变红。守卫一直盯着一份旧代码 —— 它通过，但锁错了对象。
 *
 * **自我加强的陷阱**（为什么它会一直不暴露）：影子一旦存在，tsc 解析 `.js` 说明符就命中影子，
 * `.ts` 再也不进 program，也就再也不会被重新 emit —— 于是影子**永久冻结**在某个历史版本，
 * 而所有守卫继续安静地全绿。
 *
 * 本 spec 钉死三层：
 *   ① 四个源码树下不得存在"有 `.ts`/`.tsx` 兄弟的 `.js`"；
 *   ② `tsconfig.base.json` / `gui/tsconfig.json` 必须 `noEmit`（类型检查配置，永不 emit）；
 *      `core-ts` / `gateway-ts` 必须显式 `noEmit: false`（它们是**构建**配置，产物落 `dist`）——
 *      这三者必须同时成立，否则"堵住污染"会顺手"弄坏构建"；
 *   ③ **自检扫描器**（临时目录里造影子必须被检出）——否则它会退化成永远返回空数组的死守卫。
 *
 * ⚠️ `core-ts/tsconfig.json` 与 `gateway-ts/tsconfig.json` 都 `extends` 根配置，
 * 所以根配置上任何 emit 相关的改动都会被它们**继承**：这正是为什么 ② 必须成对断言，
 * 而不是只看根配置。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "out", "dist", ".git"]);

/** 源码树（这些目录下出现 `.js` 一律视为编译影子）。 */
// ⚠️ `tests` 必须一并扫描：A-1030 首版只列了四棵源码树，漏了 tests/，
// 结果 tests/core-ts 下攒了 109 个 *.spec.js 影子（每个都有同名 .spec.ts）没被任何守卫发现，
// 还差点被整批提交进仓库。vitest 的 include 只收 .spec.ts 所以**不会被执行**，
// 但任何 import "./xxx.js" 的解析仍会命中影子 —— 同样的"锁错对象"陷阱。
const SHADOW_ROOTS = ["gui/src", "core-ts/src", "gateway-ts/src", "shared", "tests"];

/** 只做类型检查、必须永不 emit 的配置。 */
const TYPECHECK_ONLY_CFG = ["tsconfig.base.json", "gui/tsconfig.json"];

/** 承载构建、必须能 emit 的配置（产物落 dist；被根配置的 noEmit 连坐时必须显式盖回来）。 */
const EMIT_CAPABLE_CFG = ["core-ts/tsconfig.json", "gateway-ts/tsconfig.json"];

/**
 * 扫描 `dir` 下所有"有 `.ts`/`.tsx` 兄弟"的 `.js`/`.jsx`（= 编译影子）。
 * 纯文件系统逻辑，可对任意目录跑 —— 自检就是拿它跑临时目录。
 */
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

/**
 * 去 JSONC 注释 —— **必须逐字符跳过字符串字面量**，绝不能用正则。
 *
 * 教训（本次实写出来、当场被守卫抓住的）：naive 的块注释正则会把 `include` 里
 * `"src` + 双星号 + 斜杠 + `*.ts"` 这种**通配符路径**的「双星号 + 斜杠」当成注释终结符啃掉，
 * 于是该字符串变成 `"src` + `*.ts"`，`JSON.parse` 直接报 position 619。
 * 一个"读配置"的辅助函数自己先把配置读坏 —— 这类"守卫自身有 bug 却看不出来"正是本项目最忌讳的。
 */
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

/** 读取 tsconfig（允许注释）。 */
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
      // 光有 noEmit:false 不够，还得真的有输出目录，否则产物仍会落在源码树旁边
      expect(cfg.compilerOptions?.outDir, `${rel} 必须指定 outDir，产物不能落在源码树里`).toBeTruthy();
    });
  }

  it("反假阳：读取器确实读得到真实配置（不是恒真）", () => {
    expect(readTsconfig("tsconfig.base.json").compilerOptions?.noEmit).toBe(true);
    // ⚠️ 只断言各配置**自己声明**的键：core-ts / gateway-ts 都 extends 根配置，
    //    继承来的 target 不会出现在它们的 JSON 文本里（本读取器不解析 extends，只看字面量）
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
