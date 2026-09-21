/**
 * A-1041 守卫（源码结构性）：LanceDB 不再被误打包，改为「内嵌组件」按需就位。
 *
 * **问题**：安装包 1GB 的元凶是 `out/main/chunks/lancedb.win32-x64-msvc-*.node`（297MB）。
 * 它不是被有意打进去的，而是 `store.ts` 里 `await import(/* @vite-ignore *\/ "@lancedb/lancedb")`
 * 让 vite **跳过 alias**、把真实包连同原生子包解析进了 bundle；而 `electron-builder.json`
 * 的 `files` 里根本没有 node_modules —— 这份 297MB 只存在于 bundle 里，既不好管理也没法裁剪。
 *
 * **要求（用户明确）**：lancedb 是向量记忆的兜底，**能力不许砍**；要"修好"，做成
 * slime 内嵌级组件：默认安装包不含 297MB，组件就位即用，未就位**如实告知**（不静默降级）。
 *
 * 这些结构性事实改回去**都不报错**，只在真机上表现为"安装包又变 1GB / 向量检索静默失效"，
 * 所以逐条钉死。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const STORE = "core-ts/src/memory/store.ts";
const MAIN = "gui/src/main/index.ts";
const STUB = "gui/src/main/__stubs/lancedb-stub.ts";
const VITE = "gui/vite.config.ts";
const IPC = "gui/src/shared/ipc.ts";
const PANEL = "gui/src/renderer/pages/MindHubPanel.tsx";

describe("A-1041 ① bundle 里不得出现 lancedb 裸 specifier 的字面量动态 import", () => {
  it("🐛 回归红线：`@lancedb/lancedb` 只许出现在**类型位置**，值位置必须走变量", () => {
    const lines = code(STORE).split(/\r?\n/);
    // 所有 `import("@lancedb/lancedb")` 出现处：只允许 `type X = import(...)` 这种类型别名。
    // 值位置（`await import("@lancedb/lancedb")`）会被 rollup 静态分析并内联 297MB。
    const hits = lines.filter((l) => /import\(\s*["']@lancedb\/lancedb["']\s*\)/.test(l));
    expect(hits.length, "store.ts 应至少保留一处类型引用").toBeGreaterThan(0);
    for (const l of hits) {
      expect(l.trim(), `值位置的裸 specifier 会被内联：${l.trim()}`).toMatch(
        /^type\s+\w+\s*=\s*import\(\s*["']@lancedb\/lancedb["']\s*\)/,
      );
    }
  });

  it("specifier 装在变量里 + `@vite-ignore`（两者缺一，297MB 就回来了）", () => {
    const src = read(STORE);
    expect(src).toContain('const spec = "@lancedb/lancedb";');
    // 注释被 code() 剥掉了，所以这里必须用原文校验配对关系
    expect(src).toMatch(/await\s+import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*spec\s*\)/);
  });

  it("有可注入的模块加载器，且**注入分支在回退分支之前**（顺序反了等于没注入）", () => {
    const src = code(STORE);
    expect(src).toContain("export function setLancedbModuleLoader");
    const fn = /export function setLancedbModuleLoader[\s\S]*?\n\}/.exec(src);
    expect(fn, "找不到 setLancedbModuleLoader").not.toBeNull();
    expect(fn![0]).toContain("lancedbModuleLoader = fn");

    const body = /async function defaultLanceConnect[\s\S]*?\n\}/.exec(src);
    expect(body, "找不到 defaultLanceConnect").not.toBeNull();
    const text = body![0];
    const injectAt = text.indexOf("await lancedbModuleLoader()");
    const fallbackAt = text.indexOf("await import(");
    expect(injectAt, "注入分支缺失").toBeGreaterThan(-1);
    expect(fallbackAt, "回退分支缺失").toBeGreaterThan(-1);
    expect(injectAt, "注入分支必须先于回退分支").toBeLessThan(fallbackAt);
  });

  it("默认分支仍在（未注入时的单测/CLI 走真实包），不是把能力删掉", () => {
    expect(code(STORE)).toContain("const mod = (await import(");
  });
});

describe("A-1041 ② 桌面端：注入 + 按组件目录加载 + 未就位如实告知", () => {
  it("主进程真的注入了加载器（不注入 = 桌面端向量能力直接没了）", () => {
    expect(code(MAIN)).toContain("setLancedbModuleLoader(");
    expect(code(MAIN)).toContain("requireLancedb()");
  });

  it("🐛 回归红线：`lancedbEnabled: true` 硬编码必须消失 —— 改由组件就位状态决定", () => {
    const src = code(MAIN);
    expect(src).not.toContain("lancedbEnabled: true");
    expect(src).toContain("lancedbEnabled: lancedbComponent().ok");
  });

  it("组件状态可刷新（下载/就位后作废已缓存的 store，否则旧的仍是降级态）", () => {
    const src = code(MAIN);
    expect(src).toContain("export function refreshLancedbComponent");
    // 只刷新状态不清缓存 = 已有 store 仍是旧结论 → 必须一起 clear
    const fn = /export function refreshLancedbComponent[\s\S]*?\n}/.exec(src);
    expect(fn, "找不到 refreshLancedbComponent").not.toBeNull();
    expect(fn![0]).toContain("memoryStores.clear()");
  });

  it("stub 未就位时抛出**带候选目录**的错误（静默失败是精度杀手）", () => {
    const src = code(STUB);
    expect(src).toContain("export function requireLancedb");
    // ⚠️ 必须锁在 **requireLancedb 函数体内**：文件里 `LanceDB 运行时组件未就位` 还出现在
    // `lancedbComponentStatus().error` 上，全文 toContain 会被那处掩蔽（变异 M9 实测仍绿）。
    const fn = /export function requireLancedb\(\)[\s\S]*?\n\}/.exec(src);
    expect(fn, "找不到 requireLancedb").not.toBeNull();
    expect(fn![0], "抛错文案必须点明组件未就位").toContain("LanceDB 运行时组件未就位");
    expect(fn![0], "抛错必须带上候选目录（否则用户不知道放哪）").toContain("lancedbCandidates()");
  });

  it("stub 同时暴露就位状态与候选目录（供界面如实展示）", () => {
    const src = code(STUB);
    expect(src).toContain("export function lancedbComponentStatus");
    expect(src).toContain("export function lancedbCandidates");
    expect(src).toContain("export const LANCEDB_COMPONENT_DIR");
  });

  it("vite 的 alias **两处**都指向桩（顶层 + main 自带，缺一处都可能内联 297MB）", () => {
    const src = code(VITE);
    const mainAt = src.indexOf("main: {");
    expect(mainAt, "找不到 main target").toBeGreaterThan(-1);
    // main target 自带的那份：`resolve` 与 `build` 同级（写成 build.resolve 会被静默忽略）
    expect(
      src.slice(mainAt),
      "main target 必须自带 resolve.alias（顶层 alias 不被 main 的 rollup 继承）",
    ).toContain('resolve: { alias: { "@lancedb/lancedb": LANCEDB_STUB } }');
    // 顶层那份（共享解析阶段用）
    expect(
      src.slice(0, mainAt),
      "顶层 resolve.alias 也必须指向桩",
    ).toContain('"@lancedb/lancedb": LANCEDB_STUB');
  });
});

describe("A-1041 ③ 界面必须如实显示组件状态", () => {
  it("配置契约带 lancedb 就位状态（ok / dir / candidates）", () => {
    const src = code(IPC);
    expect(src).toContain("lancedb: { ok: boolean; dir?: string; error?: string; candidates: string[] }");
    expect(code(MAIN)).toContain("lancedb: lancedbComponent(),");
  });

  it("未就位时界面明确说明降级 + 给出可放置的候选目录", () => {
    const src = code(PANEL);
    expect(src).toContain("向量记忆已降级为 JSON 检索");
    expect(src).toContain("cfg.lancedb.candidates.map");
    expect(src).toContain("prepare-lancedb-component.mjs");
  });
});

describe("A-1041 ④ 打包目标路径 == 运行时候选路径（漂移 = 静默降级）", () => {
  /**
   * 这两处是**两个文件里的两个字符串**，谁改了都不报错：
   * 打进 `resources/foo/lancedb` 而运行时去 `resources/components/lancedb` 找
   * → 组件确实在包里（体积也确实付了），但 `findLancedbComponent()` 永远返回 null
   * → 界面显示"未就位"，用户以为没装，日志干干净净。这是 A-1041 最容易复发的一种静默失效。
   */
  it("完整版配置把组件打到与 LANCEDB_COMPONENT_DIR 逐字一致的目录", () => {
    const conf = JSON.parse(read("gui/electron-builder-full.json")) as {
      extends?: string;
      extraResources?: Array<{ from?: string; to?: string }>;
    };
    expect(conf.extends, "完整版配置必须扩展默认配置（否则两份各自漂移）").toBe("./electron-builder.json");

    const stub = code(STUB);
    const m = /LANCEDB_COMPONENT_DIR\s*=\s*"([^"]+)"/.exec(stub);
    expect(m, "找不到 LANCEDB_COMPONENT_DIR —— 运行时候选目录的唯一出处").not.toBeNull();
    const wanted = m![1];

    const entry = (conf.extraResources ?? []).find((e) => (e.to ?? "").endsWith("lancedb"));
    expect(entry, "完整版配置没有把 lancedb 组件声明进 extraResources").not.toBeUndefined();
    expect(entry!.to, "打包目标必须与运行时候选目录逐字一致").toBe(wanted);
    expect(entry!.from, "组件来源必须是生成脚本的产物目录").toContain("components/lancedb");
  });

  it("默认配置**不**随附组件（293MB 只在完整版里，默认包不许偷偷变回 1GB）", () => {
    const base = JSON.parse(read("gui/electron-builder.json")) as {
      extraResources?: unknown;
      asarUnpack?: string[];
    };
    expect(base.extraResources, "默认包不该声明 extraResources（组件按需下载/生成）").toBeUndefined();
    for (const p of base.asarUnpack ?? []) {
      expect(p, "asarUnpack 里不许再出现 lancedb（A-1041 就是为了删掉它）").not.toContain("lancedb");
    }
  });
});
