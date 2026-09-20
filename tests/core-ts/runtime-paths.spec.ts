/**
 * tests/core-ts/runtime-paths.spec.ts — 「运行环境怎么都检测不到」的源码守卫（A-1003）。
 *
 * 用户实测：设置 → 运行环境里 **Python（随包 venv）/ llama.cpp / 本地模型 三项齐报「缺失」**，
 * 而三份资源其实都在磁盘上、且真能跑（实测：venv Python 3.12.9 + fastapi 可导入；
 * `llama-server.exe --version` → build 10509；BGE-M3 561MB、qwen3-1.7b 1GB）。
 *
 * 三层原因，逐层钉住：
 *
 *   ① **根解析**（主因）：`resolveExtra` = `INSTALL_ROOT + subpath`，而 `INSTALL_ROOT` 在开发
 *      模式下 = `app.getAppPath()` = **gui/**（boot.ts 的注释断言它"= 项目根"，实测不是）。
 *      随包依赖（llama.cpp / runtime/venv / models / slime_server.py）其实在**项目根**
 *      —— 依据两处互为佐证：`prepare-runtime.mjs` 的 `ROOT = scripts/..`，以及
 *      `mind_config.ts` / `downloader.ts` 读同一批资源时用的 core-ts `PROJECT_ROOT`。
 *      → 新增 `BUNDLE_ROOT`，随包依赖一律走它；`resolveExtra` 只留给应用自身资源
 *        （build/icon.png、data/、config/、Knowledge/）。
 *      同一个错还静默废掉了 Python sidecar（`startPythonBackend` 找不到 venv/slime_server.py
 *      → 直接判「后端组件缺失」进受限模式）。
 *
 *   ② **陈旧配置**：`bootstrapToml`（负责把 llama_bin/model_path/models_dir 矫正到随包位置）
 *      被 `if (app.isPackaged)` 整段包住，开发模式永不执行 → 配置里指向**另一份检出**
 *      的绝对路径长期得不到修复（实测指向 `D:\tool\slime\…` 这个旧检出）。
 *
 *   ③ **体积门槛**：`readDepStatus().ok.llamaBin` 要求 ≥1MB，而 llama.cpp 官方预编译包是
 *      shared-libs 布局 —— 代码在 `ggml-*.dll` / `llama.dll` 里，`llama-server.exe`
 *      只是个 **9216 字节**的薄壳 → 一个**完全可用**的二进制被判缺失，
 *      用户点一百次"下载"也还是同一个 9KB 的壳。改为判**文件头魔数**（与布局无关）。
 *
 * 本文件只做**源码/配置契约守卫**（这类写法改回去不报错、只在真机上表现为"检测不到"）；
 * 真实磁盘取证见 .workbuddy/memory 当日日志。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 读源码并剥离注释 —— 反向断言必须先去注释，否则一句解释性注释就能把守卫弄成假红。
 *  同时把 CRLF 归一成 LF：本仓库检出是 CRLF，字面量断言里写 `\n` 会全线假红。 */
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
    // ⚠️ 回归点：BUNDLE_ROOT 若退回裸 `app.getAppPath()`，随包依赖会全部落在 gui/ 下
    // → 三项齐报缺失。断言要**只看 BUNDLE_ROOT 这条声明**，不能全局否定 ——
    // INSTALL_ROOT 用 app.getAppPath() 是**正确**的（图标 / data/ 实测就在 gui/），
    // 全局 `not.toContain` 会把正确写法一起判死。
    const decl = BOOT.slice(BOOT.indexOf("export const BUNDLE_ROOT"));
    const stmt = decl.slice(0, decl.indexOf(";") + 1);
    expect(stmt).toContain("findProjectRoot(app.getAppPath())");
    expect(stmt).not.toMatch(/:\s*app\.getAppPath\(\)\s*;/);
  });

  it("BUNDLE_ROOT 的推导算法必须与 core-ts paths.ts 是同一个（两处漂移 = 又一次找不到）", () => {
    // 同一个标志文件、同一个上溯写法；paths.ts 是 core-ts 侧的唯一出处
    expect(BOOT).toContain('existsSync(join(dir, "slime.toml"))');
    expect(PATHS).toContain('existsSync(join(dir, "slime.toml"))');
    // 也不能靠 import 复用：paths.ts 有模块级 PROJECT_ROOT，被 import 即在 SLIME_ROOT 设置前求值
    expect(BOOT).not.toContain("from \"../../core-ts");
    expect(BOOT).not.toContain("from \"core-ts");
  });

  it("随包依赖必须走 resolveBundled（枚举全部取用点，漏一个就少一项）", () => {
    expect(MAIN).toContain("import { INSTALL_ROOT, BUNDLE_ROOT } from \"./boot.js\";");
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
    // 曾经的写法：resolveExtra("../runtime/venv") / `("../requirements.txt")`。
    // 开发模式靠 `gui/../` 恰好是项目根；打包模式 `../` 会指到安装根的**上一级** → 必然失败。
    expect(MAIN).not.toMatch(/resolveExtra\("\.\.\/(runtime|requirements)/);
    // resolveExtra 仍然服务应用自身资源，不许被顺手删掉
    expect(MAIN).toContain("return join(INSTALL_ROOT, subpath);");
  });

  it("electron-builder extraFiles 与 resolveBundled 的字面量必须对得上（「随包标准」可核对）", () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "gui/electron-builder.json"), "utf8")) as {
      extraFiles: Array<{ from: string; to: string }>;
    };
    const tos = cfg.extraFiles.map((e) => e.to);
    // 这些是 resolveBundled 在打包模式下的目标路径 —— 少一条，对应功能在正式安装包里就是死的
    for (const t of ["runtime/venv", "llama.cpp/build/bin", "slime_server.py", "requirements.txt"]) {
      expect(tos, `extraFiles 缺 ${t}：resolveBundled 在打包模式会指空`).toContain(t);
    }
    // 随包依赖的 from 全部是 `../`（项目根）—— 这正是开发模式 BUNDLE_ROOT = 项目根的依据
    for (const t of ["runtime/venv", "llama.cpp/build/bin", "slime_server.py", "requirements.txt"]) {
      const e = cfg.extraFiles.find((x) => x.to === t);
      expect(e?.from.startsWith("../"), `${t} 的 from 不是 ../，与 BUNDLE_ROOT 的推导依据矛盾`).toBe(true);
    }
  });

  it("bootstrapToml 在开发模式也要跑（否则配置里的旧绝对路径永远不修）", () => {
    // 打包：数据根落用户可写目录；开发：目标就是随包资源根下的 slime.toml
    expect(BOOT).toMatch(/else\s*\{[\s\S]{0,600}bootstrapToml\(BUNDLE_ROOT\);/);
    expect(BOOT).toContain("const appRoot = BUNDLE_ROOT;");
    // 只在内容真的变了时才写：开发模式下目标就在项目里，无条件写会每次启动刷 mtime
    expect(BOOT).toContain("if (text !== original || !existed) {");
    expect(BOOT).not.toMatch(/writeFileSync\(target, text, "utf8"\);\s*\}\) catch/);
  });
});

describe("A-1003b：llamaBin 的就绪判据不得用体积门槛", () => {
  it("必须是「可执行文件魔数」判据，而不是 ≥1MB", () => {
    expect(MIND).toContain("llamaBin: Boolean(llamaBin) && looksLikeExecutable(llamaBin),");
    expect(MIND).toContain("function looksLikeExecutable(p: string): boolean {");
    // PE "MZ" / ELF / "#!" —— 与构建布局无关
    expect(MIND).toContain("if (buf[0] === 0x4d && buf[1] === 0x5a) { return true; }");
    expect(MIND).toContain("if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) { return true; }");
    // 回归点：shared-libs 布局下合法 exe 只有 9KB，这个门槛会把它判成"缺失"
    expect(MIND).not.toContain(">= 1 * 1024 * 1024");
  });

  it("残缺下载仍然要被拦住（魔数判据不能退化成「存在即就绪」）", () => {
    // 空文件 / 残片 / HTML 错误页（<html 开头）都过不了魔数，且 1KB 下限兜住空文件
    expect(MIND).toContain("if (!st || !st.isFile() || st.size < 1024) { return false; }");
    expect(MIND).toContain("catch {\n    return false;\n  }");
  });
});
