






























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";



const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const BOOT = read("gui/src/main/boot.ts");
const MAIN = read("gui/src/main/index.ts");
const MIND = read("gui/src/main/mind_config.ts");
const PATHS = read("core-ts/src/paths.ts");

describe("A-1003：随包资源根 —— 开发模式不能用 app.getAppPath()", () => {
  it("boot.ts 必须导出 BUNDLE_ROOT，且开发分支走「向上找 slime.toml」而不是裸用 app 根", () => {
    expect(BOOT).toContain("export const BUNDLE_ROOT = app.isPackaged");
    expect(BOOT).toContain(": findProjectRoot(app.getAppPath());");
    expect(BOOT).toContain("function findProjectRoot(start: string): string {");
    
    
    
    
    const decl = BOOT.slice(BOOT.indexOf("export const BUNDLE_ROOT"));
    const stmt = decl.slice(0, decl.indexOf(";") + 1);
    expect(stmt).toContain("findProjectRoot(app.getAppPath())");
    expect(stmt).not.toMatch(/:\s*app\.getAppPath\(\)\s*;/);
  });

  it("BUNDLE_ROOT 的推导算法必须与 core-ts paths.ts 是同一个（两处漂移 = 又一次找不到）", () => {
    
    expect(BOOT).toContain('existsSync(join(dir, "slime.toml"))');
    expect(PATHS).toContain('existsSync(join(dir, "slime.toml"))');
    
    expect(BOOT).not.toContain("from \"../../core-ts");
    expect(BOOT).not.toContain("from \"core-ts");
  });

  it("随包依赖必须走 resolveBundled（枚举全部取用点，漏一个就少一项）", () => {
    /* A-1200 · B4：该 import 多带了 takeSeedUpgrades（示例扩展升级结果 → 扩展页如实告知）。
       断言按**前缀**匹配而不是整行 —— 整行会在每次加/减一个具名导入时假红（这次就是）。
       真正要钉的不变量是「INSTALL_ROOT / BUNDLE_ROOT 从 boot.js 来」，不是导入列表的精确形状。 */
    expect(MAIN).toMatch(/import \{[^}]*INSTALL_ROOT[^}]*BUNDLE_ROOT[^}]*\} from "\.\/boot\.js";/);
    expect(MAIN).toContain("function resolveBundled(subpath: string): string {");
    expect(MAIN).toContain("return join(BUNDLE_ROOT, subpath);");
    for (const p of [
      'resolveBundled("runtime/venv/Scripts/python.exe")',
      'resolveBundled("runtime/venv/bin/python")',
      'resolveBundled("llama.cpp/build/bin/llama-server.exe")',
      'resolveBundled("llama.cpp/build/bin/llama-server")',
      'resolveBundled("models")',
      'resolveBundled("slime_server.py")',
      'resolveBundled("requirements.txt")',
      'resolveBundled("runtime/venv")',
      'resolveBundled(join("runtime", "venv", venvSub, venvPyName))',
      'resolveBundled(join("llama.cpp", "build", "bin"))',
    ]) {
      expect(MAIN, `随包依赖漏了：${p}`).toContain(p);
    }
  });

  it("随包依赖不得回退到 resolveExtra —— 含 `../` 字符串绕行（那只在开发模式蒙对）", () => {
    expect(MAIN).not.toMatch(/resolveExtra\("(runtime|llama|models|slime_server|requirements)/);
    
    
    expect(MAIN).not.toMatch(/resolveExtra\("\.\.\/(runtime|requirements)/);
    
    expect(MAIN).toContain("return join(INSTALL_ROOT, subpath);");
  });

  it("electron-builder extraFiles 与 resolveBundled 的字面量必须对得上（「随包标准」可核对）", () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "gui/electron-builder.json"), "utf8")) as {
      extraFiles: Array<{ from: string; to: string }>;
    };
    const tos = cfg.extraFiles.map((e) => e.to);
    
    for (const t of ["runtime/venv", "llama.cpp/build/bin", "slime_server.py", "requirements.txt"]) {
      expect(tos, `extraFiles 缺 ${t}：resolveBundled 在打包模式会指空`).toContain(t);
    }
    
    for (const t of ["runtime/venv", "llama.cpp/build/bin", "slime_server.py", "requirements.txt"]) {
      const e = cfg.extraFiles.find((x) => x.to === t);
      expect(e?.from.startsWith("../"), `${t} 的 from 不是 ../，与 BUNDLE_ROOT 的推导依据矛盾`).toBe(true);
    }
  });

  it("bootstrapToml 在开发模式也要跑（否则配置里的旧绝对路径永远不修）", () => {
    
    expect(BOOT).toMatch(/else\s*\{[\s\S]{0,600}bootstrapToml\(BUNDLE_ROOT\);/);
    expect(BOOT).toContain("const appRoot = BUNDLE_ROOT;");
    
    expect(BOOT).toContain("if (text !== original || !existed) {");
    expect(BOOT).not.toMatch(/writeFileSync\(target, text, "utf8"\);\s*\}\) catch/);
  });
});

describe("A-1003b：llamaBin 的就绪判据不得用体积门槛", () => {
  it("必须是「可执行文件魔数」判据，而不是 ≥1MB", () => {
    expect(MIND).toContain("llamaBin: Boolean(llamaBin) && looksLikeExecutable(llamaBin),");
    expect(MIND).toContain("function looksLikeExecutable(p: string): boolean {");
    
    expect(MIND).toContain("if (buf[0] === 0x4d && buf[1] === 0x5a) { return true; }");
    expect(MIND).toContain("if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) { return true; }");
    
    expect(MIND).not.toContain(">= 1 * 1024 * 1024");
  });

  it("残缺下载仍然要被拦住（魔数判据不能退化成「存在即就绪」）", () => {
    
    expect(MIND).toContain("if (!st || !st.isFile() || st.size < 1024) { return false; }");
    expect(MIND).toContain("catch {\n    return false;\n  }");
  });
});
