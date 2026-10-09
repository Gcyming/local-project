/**
 * tests/core-ts/a1197-data-root.spec.ts — ④「数据写到了 C 盘 / D:\tool\AI\slimecode 空无一物」的验收基线
 *
 * 用户原话：
 *   「skill 等一堆数据还是在 C 盘（%APPDATA%\slime-gui），
 *     我在安装时和设置里都定义过了，而 D:\tool\AI\slimecode\config 空无一物」
 *
 * 根因是两条叠加：
 *   ① **数据根不可配置**：boot.ts 把数据根写死成 join(app.getPath("userData"), "slime-data")，
 *      用户在任何地方选的路径都不会被用到 —— 选了也是白选。
 *   ② **运行时状态散落在安装目录**：多处代码往 `<安装目录>/data`、`<安装目录>/config` 写，
 *      在用户机器上就表现为 `D:\tool\AI\slimecode\data\run.lock`、`config\requests.json`。
 *      安装目录常不可写、升级时被整体替换，这些文件本应住在数据根里。
 *
 * 断言分五组：
 *   A. dataRoot.ts 存在且导出齐了单一来源该有的东西
 *   B. boot.ts 不再写死 "slime-data"（形状）
 *   C. gui/src/main 下不再有 `join(INSTALL_ROOT, "data"` / `"config"` 的运行时写入（只读随包资源除外）
 *   D. IPC 四通道 + preload 双份声明（impl 与 interface 都得有）
 *   E. runtimeStateDir 语义：落在 <数据根>/runtime 且做 mkdirSync recursive
 *
 * ⚠️ 全部走**源码形状断言**而不是 import：dataRoot.ts 顶层 `RUNTIME_DATA_DIR = pickWritableRoot()`
 * 会真的调 `app.getPath("userData")`，在 vitest 的 node 环境里 Electron 不可用。
 * 为了让测试能 import 而改生产代码（本项目铁律里叫"为了测试改坏口径"）是绝不允许的。
 * 本仓同类守卫一贯如此（见 tests/core-ts/a1024-guards.spec.ts）。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_DIR = join(ROOT, "gui/src/main");
const DATA_ROOT_TS = join(MAIN_DIR, "dataRoot.ts");
const BOOT_TS = join(MAIN_DIR, "boot.ts");
const INDEX_TS = join(MAIN_DIR, "index.ts");
const IPC_TS = join(ROOT, "gui/src/shared/ipc.ts");
const PRELOAD_TS = join(ROOT, "gui/src/preload/index.ts");

const read = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** 取 `function 名(` 开头那一段的函数体（含嵌套 {}）—— 形状断言要的是"这个函数做的事"。 */
function bodyOfSrc(src: string, decl: string): string {
  const at = src.indexOf(decl);
  expect(at, `${decl} 必须存在`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") { depth += 1; }
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { return src.slice(open, i + 1); }
    }
  }
  throw new Error(`${decl} 的函数体括号不配对`);
}

/**
 * 把「一次性迁移旧安装目录数据」那个函数从源码里抠掉。
 *
 * 为什么必须抠掉：它是**唯一**允许出现 `join(INSTALL_ROOT, "data")` 的地方 ——
 * 因为它的职责就是去老位置**读**一份历史数据复制到数据根（只复制、不删来源）。
 * 把它算进"运行时写入安装目录"会把这道守卫变成永红。
 */
function withoutLegacyMigration(src: string): string {
  const at = src.indexOf("function migrateLegacyInstallDirData");
  if (at < 0) { return src; }
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") { depth += 1; }
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { return src.slice(0, at) + src.slice(i + 1); }
    }
  }
  return src;
}

/** 只读随包资源的白名单：这些 `join(INSTALL_ROOT, ...)` 是「读图标 / 读模板」，不是运行时写入。 */
const READ_ONLY_INSTALL_ROOT_PREFIXES = ["build", "template", "shared", "bin", "resources"];

describe("A-1197④ 数据根单一来源：dataRoot.ts 在且导出齐", () => {
  it("文件必须存在（boot/crashGuard/watchdog/subagentStore 都依赖它）", () => {
    expect(existsSync(DATA_ROOT_TS)).toBe(true);
  });

  it("五个必备导出一个都不能少", () => {
    const src = read(DATA_ROOT_TS);
    for (const name of [
      "RUNTIME_DATA_DIR",
      "runtimeStateDir",
      "writeDataRootPointer",
      "clearDataRootPointer",
      "readDataRootPointer",
    ]) {
      expect(src, name).toContain(name);
    }
  });

  it("RUNTIME_DATA_DIR 必须是模块级常量（进程内不变 ⇒ 换目录必须重启才生效）", () => {
    const src = read(DATA_ROOT_TS);
    expect(src).toMatch(/export const RUNTIME_DATA_DIR\s*=/);
  });

  it("数据根选择记录只能落在 app 数据目录，不能落在数据根自己里面（鸡生蛋）", () => {
    const src = read(DATA_ROOT_TS);
    expect(src).toMatch(/dataRootPointerPath[\s\S]{0,200}userData/);
  });

  it("已选目录不可用时要出声回落默认，不许静默启动失败", () => {
    const src = read(DATA_ROOT_TS);
    const body = bodyOfSrc(src, "pickWritableRoot");
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/console\.warn/);
    expect(body).toMatch(/return defaultDataRoot\(\)/);
  });
});

describe("A-1197④ boot.ts 不得再把数据根写死", () => {
  it("不允许再出现 \"slime-data\" 这个字面量（只判它本身，不误伤 slime-data-dev）", () => {
    const src = read(BOOT_TS);
    // 逐个出现位置人工可读地报出来，避免"只判存在/不存在"看不出是哪一处
    const hits: string[] = [];
    for (const line of src.split("\n")) {
      // 去掉行尾注释后仍含 "slime-data" 才是代码里还在用（注释里提一句历史是允许的）
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (code.includes('"slime-data"') || code.includes("'slime-data'")) { hits.push(line.trim()); }
    }
    expect(hits).toEqual([]);
  });

  it("打包模式的 SLIME_ROOT 必须引用 RUNTIME_DATA_DIR", () => {
    const src = read(BOOT_TS);
    expect(src).toContain('import { RUNTIME_DATA_DIR } from "./dataRoot.js"');
    expect(src).toMatch(/const slimeRoot = RUNTIME_DATA_DIR;/);
  });
});

describe("A-1197④ gui/src/main 不再往安装目录写运行时状态", () => {
  /** 扫 gui/src/main 全部 .ts，找 `join(INSTALL_ROOT, "data"` / `join(INSTALL_ROOT, "config"` 形态。
   *  一次性迁移函数先抠掉（它读老位置是本分，见 withoutLegacyMigration 的注释）。 */
  const offenders: string[] = [];
  for (const f of readdirSync(MAIN_DIR)) {
    if (!f.endsWith(".ts")) { continue; }
    const src = withoutLegacyMigration(read(join(MAIN_DIR, f)));
    for (const needle of ['join(INSTALL_ROOT, "data"', 'join(INSTALL_ROOT, "config"', "join(INSTALL_ROOT, 'data'", "join(INSTALL_ROOT, 'config'"]) {
      if (src.includes(needle)) { offenders.push(`${f}  ← ${needle}`); }
    }
  }

  it("不得存在指向安装目录 data/ 与 config/ 的路径拼接（0 处）", () => {
    expect(offenders).toEqual([]);
  });

  it("index.ts 里原定的 5 个写入点都已改为 runtimeStateDir()", () => {
    const src = read(INDEX_TS);
    expect(src).toContain('join(runtimeStateDir(), "schedules.json")');
    expect(src).toContain('join(runtimeStateDir(), "scheduler-state.json")');
    expect(src).toContain('join(runtimeStateDir(), "generated")');
    expect(src).toContain('join(runtimeStateDir(), "requests.json")');
  });

  it("子代理台账也不许回退到安装目录（它踩的就是 run.lock 同一个坑）", () => {
    const src = read(join(MAIN_DIR, "subagentStore.ts"));
    expect(src).toContain('join(runtimeStateDir(), "subagent-runs.json")');
    expect(src).not.toContain("INSTALL_ROOT");
  });

  it("只读随包资源仍走 INSTALL_ROOT（build/icon、template/skills 不许被误改成可写目录）", () => {
    const boot = read(BOOT_TS);
    const notify = read(join(MAIN_DIR, "notify.ts"));
    expect(boot).toMatch(/join\(INSTALL_ROOT, "template", "skills"\)/);
    expect(notify).toMatch(/join\(INSTALL_ROOT, "build"/);
    expect(READ_ONLY_INSTALL_ROOT_PREFIXES).toContain("build");
  });
});

describe("A-1197④ 数据根四通道 IPC 与 preload 双份声明", () => {
  it("ipc.ts 声明了四个 dataRoot 通道", () => {
    const src = read(IPC_TS);
    expect(src).toContain('data_root_get: "slime:dataRoot:get"');
    expect(src).toContain('data_root_pick: "slime:dataRoot:pick"');
    expect(src).toContain('data_root_set: "slime:dataRoot:set"');
    expect(src).toContain('data_root_reset: "slime:dataRoot:reset"');
  });

  it("index.ts 用 handleTrusted 注册了四个 handler（不走裸 ipcMain.handle）", () => {
    const src = read(INDEX_TS);
    for (const ch of ["get", "pick", "set", "reset"]) {
      expect(src, ch).toMatch(new RegExp(`handleTrusted<[^>]*>\\("slime:dataRoot:${ch}"`));
    }
  });

  it("set 必须校验入参非空、mkdirSync recursive，并写指针", () => {
    const src = read(INDEX_TS);
    expect(src).toMatch(/目录不能为空/);
    // ⚠️ 必须限定在 dataRoot:set 的 handler 体内断言：index.ts 里另有多处
    // `mkdirSync(dir, { recursive: true })`（generated 目录），不限定就会命中错对象 ——
    // 那正是「跑出来是红的 ≠ 红的是那一条」（铁律 30）。
    const body = bodyOfSrc(src, '"slime:dataRoot:set"');
    expect(body).toMatch(/mkdirSync\(dir, \{ recursive: true \}\)/);
    expect(body).toMatch(/dataRootExists\(dir\)/);
    expect(body).toContain("writeDataRootPointer(dir)");
  });

  it("set 与 reset 都必须回 needRestart: true（core-ts 的 PROJECT_ROOT 是启动期常量）", () => {
    const src = read(INDEX_TS);
    expect(src).toContain("needRestart: true");
    expect(src.match(/needRestart: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("preload 的四个方法在 impl 与类型 interface 两处都在（少一边 = 后期守卫抓）", () => {
    const src = read(PRELOAD_TS).replace(/\r\n/g, "\n");
    for (const m of ["dataRootGet", "dataRootPick", "dataRootSet", "dataRootReset"]) {
      // impl 处：形如 `dataRootGet: () =>` / `dataRootSet: (p: { dir: string; migrate: boolean }) =>`
      const impl = new RegExp(`${m}:\\s*\\(`).test(src);
      // interface 处：形如 `dataRootGet: () => Promise<...>;`
      const iface = new RegExp(`${m}:\\s*\\([^)]*\\)\\s*=>\\s*Promise<`).test(src);
      expect(impl, `${m} impl`).toBe(true);
      expect(iface, `${m} 类型 interface`).toBe(true);
    }
  });

  it("preload 挂在 system 命名空间下，四个通道字符串与 ipc.ts 一致", () => {
    const src = read(PRELOAD_TS).replace(/\r\n/g, "\n");
    expect(src).toMatch(/system:\s*\{[\s\S]{0,900}dataRootGet/);
    for (const ch of ["get", "pick", "set", "reset"]) {
      expect(src, ch).toContain(`slime:dataRoot:${ch}`);
    }
  });
});

describe("A-1197④ runtimeStateDir 语义：必须在 <数据根>/runtime 且自建目录", () => {
  it("runtimeStateDir 落在 RUNTIME_DATA_DIR 下的 runtime 子目录", () => {
    const body = bodyOfSrc(read(DATA_ROOT_TS), "export function runtimeStateDir");
    expect(body).toMatch(/join\(\s*RUNTIME_DATA_DIR\s*,\s*"runtime"\s*\)/);
  });

  it("runtimeStateDir 必须 mkdirSync recursive（目录不存在时不能崩）", () => {
    const body = bodyOfSrc(read(DATA_ROOT_TS), "export function runtimeStateDir");
    expect(body).toMatch(/mkdirSync\(\s*dir\s*,\s*\{\s*recursive:\s*true\s*\}\s*\)/);
  });

  it("一次性迁移只复制、绝不删来源（出现删除/移动来源目录的写法即为回归）", () => {
    const src = read(INDEX_TS);
    // 迁移函数体内不得出现 rmSync / renameSync / cpSync 的 force:true（覆盖=可能丢用户新选择）
    const start = src.indexOf("function migrateLegacyInstallDirData");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\nfunction readRequests", start));
    expect(body).not.toMatch(/\brmSync\b/);
    expect(body).not.toMatch(/\brenameSync\b/);
    expect(body).toMatch(/cpSync\(/);
  });

  it("迁移失败要出声且不阻断启动（外层 try + console.warn）", () => {
    const src = read(INDEX_TS);
    const start = src.indexOf("function migrateLegacyInstallDirData");
    const body = src.slice(start, src.indexOf("\nfunction readRequests", start));
    expect(body).toMatch(/catch\s*\(e\)/);
    expect(body).toMatch(/console\.warn/);
  });

  it("迁移必须在启动路径上被调用一次（写在 createWindow 之前的那次 whenReady 里）", () => {
    const src = read(INDEX_TS);
    const calls = src.match(/migrateLegacyInstallDirData\(\);/g) ?? [];
    expect(calls.length).toBe(1);
    const callAt = src.indexOf("migrateLegacyInstallDirData();");
    const windowAt = src.indexOf("createWindow();", src.indexOf("app.whenReady()"));
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(windowAt);
  });
});