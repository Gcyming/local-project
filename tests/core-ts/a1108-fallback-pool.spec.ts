/**
 * tests/core-ts/a1108-fallback-pool.spec.ts — A-1108：全局降级池改为**用户自定义**（默认空）。
 *
 * ## 用户原话（这就是要根除的行为）
 *
 * 「我比较关注的是那个全局降级池，我都没设置，是哪来的？如果是编码的时候默认写入的话，
 *   请改一下，改成用户自定义编辑降级池，默认无降级池，放在通用设置里面。」
 *
 * 事实核对：那份池**不是**任何配置文件写进去的，是 `engine.ts` 的 `resolveRouteInternal`
 * 里一段硬编码 —— `const others = Object.entries(this.providers).filter(...)`，把其它所有已配置
 * 供应商的启用模型自动塞进降级链（旧日志 `[engine] 注入全局降级池（N 个候选）`）。
 *
 * ## 本文件锁什么
 *
 * A 组：`sanitizeFallbackPool` —— 坏数据不许炸、不许放大（去重 / 上限 / 裁剪）
 * B 组：`resolveFallbackTargets` —— 每条丢弃规则一个用例（这些正是"配了却不生效"的形态）
 * C 组：读盘 —— 文件缺失 / JSON 损坏 ⇒ **空池**（绝不许"读不到就补一个默认池"）
 * D 组：静态守卫 —— engine 的默认值来源、旧自动池不许回来、IPC 频道两边同值、UI 真接线
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 静态守卫一律**读源码文本**（本目录既有约定：tests/core-ts 不 import gui 源码，
 *    否则会把整个 gui 依赖图拖进根 tsconfig 的程序里）。
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  FALLBACK_POOL_MAX,
  FALLBACK_POOL_FILE,
  sanitizeFallbackPool,
  fallbackPoolPath,
  readFallbackPool,
  writeFallbackPool,
  resolveFallbackTargets,
} from "../../core-ts/src/services/fallbackPool.js";
import { LOCAL_MODELS_KEY } from "../../core-ts/src/local_models.js";

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/** 测试里用的对话能力判据（与 engine 的 isChatCapableModel 同形态，避免把 engine 拖进来） */
const chatCapable = (id: string): boolean => !/(image|video|embedding|tts|whisper)/i.test(id);

const PROVIDERS: Record<string, Record<string, unknown>> = {
  primary: { api_base: "http://mock.primary/v1", api_key: "p", model: "free-a", models: [{ id: "free-a", selected: true }] },
  backup: {
    api_base: "https://mock.backup/v1",
    api_key: "b",
    model: "stable-x",
    api_format: "openai",
    models: [
      { id: "stable-x", selected: true },
      { id: "stable-y", selected: false },
      { id: "pic-image-2", selected: true },
      { id: "tuned-z", selected: true, api_format: "anthropic" },
    ],
  },
};

const resolveTargets = (entries: Array<{ provider: string; model: string }>, primaryKey = "primary") =>
  resolveFallbackTargets({ entries }, PROVIDERS, primaryKey, { isChatCapable: chatCapable });

/* ───────────────────── A 组：白名单重建（坏数据不许炸、不许放大）───────────────────── */

describe("A-1108 A 组 — sanitizeFallbackPool", () => {
  it("A1 空/坏形状一律回空池（不抛）", () => {
    for (const bad of [null, undefined, 0, "", "x", [], {}, { entries: null }, { entries: "x" }, { entries: {} }]) {
      expect(sanitizeFallbackPool(bad), String(bad)).toEqual({ entries: [] });
    }
  });

  it("A2 只收「provider 与 model 都是非空字符串」的条目，其余整条丢弃", () => {
    const out = sanitizeFallbackPool({
      entries: [
        { provider: "a", model: "m1" },
        { provider: "  b  ", model: "  m2  " }, // 两端空白被裁掉
        { provider: "", model: "m3" },
        { provider: "c", model: "" },
        { provider: 7, model: "m4" },
        { provider: "d" },
        null,
        "s",
        { provider: "e", model: "m5" },
      ],
    });
    // ⚠️ 一条坏条目绝不该让整份配置作废 —— 其余好条目必须还在（保序）
    expect(out.entries).toEqual([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
      { provider: "e", model: "m5" },
    ]);
  });

  it("A3 去重保前（同 provider+model 只留第一条）；不按 provider 去重", () => {
    const out = sanitizeFallbackPool({
      entries: [
        { provider: "a", model: "m1" },
        { provider: "a", model: "m1" },
        { provider: "a", model: "m2" },
        { provider: "b", model: "m1" },
      ],
    });
    expect(out.entries).toEqual([
      { provider: "a", model: "m1" },
      { provider: "a", model: "m2" },
      { provider: "b", model: "m1" },
    ]);
  });

  it("A4 截断到上限（降级池是兜底，不是第二条主链）", () => {
    const many = Array.from({ length: FALLBACK_POOL_MAX + 5 }, (_, i) => ({ provider: "p", model: `m${i}` }));
    const out = sanitizeFallbackPool({ entries: many });
    expect(out.entries.length).toBe(FALLBACK_POOL_MAX);
    expect(out.entries[0]).toEqual({ provider: "p", model: "m0" }); // 保前
    expect(out.entries[out.entries.length - 1]).toEqual({ provider: "p", model: `m${FALLBACK_POOL_MAX - 1}` });
  });
});

/* ───────────────────── B 组：解析为可注入目标（每条丢弃规则 = 一种"配了却不生效"）───────────────────── */

describe("A-1108 B 组 — resolveFallbackTargets", () => {
  it("B1 **空池 ⇒ 空目标**（这是 A-1108 的核心：默认不降级）", () => {
    expect(resolveTargets([])).toEqual([]);
    expect(resolveFallbackTargets(null, PROVIDERS, "primary", { isChatCapable: chatCapable })).toEqual([]);
    expect(resolveFallbackTargets(undefined, PROVIDERS, "primary", { isChatCapable: chatCapable })).toEqual([]);
    // providers 表都没有 ⇒ 也必须是空（不许凭空造目标）
    expect(resolveFallbackTargets({ entries: [{ provider: "backup", model: "stable-x" }] }, null, "primary", { isChatCapable: chatCapable })).toEqual([]);
  });

  it("B2 正常条目解析出 base/apiKey/格式（剥末尾 /v1 与尾斜杠，与 engine 同口径）", () => {
    const t = resolveTargets([{ provider: "backup", model: "stable-x" }]);
    expect(t).toEqual([{
      provider: "backup",
      model: "stable-x",
      base: "https://mock.backup",
      apiKey: "b",
      apiFormat: "openai",
    }]);
  });

  it("B3 顺序 = 优先级（先配的先试），并去重", () => {
    const t = resolveTargets([
      { provider: "backup", model: "tuned-z" },
      { provider: "backup", model: "stable-x" },
      { provider: "backup", model: "tuned-z" },
    ]);
    expect(t.map((x) => x.model)).toEqual(["tuned-z", "stable-x"]);
  });

  it("B4 指向**首选自身**的条目被丢弃（首选的多模型由 ① 段注入，重复注入 = 两个产地）", () => {
    expect(resolveTargets([{ provider: "primary", model: "free-a" }])).toEqual([]);
  });

  it("B5 指向**本地模型伪供应商**的条目被丢弃（那是 local: 分支的事）", () => {
    const providers = { ...PROVIDERS, [LOCAL_MODELS_KEY]: { api_base: "http://127.0.0.1:19100/v1", api_key: "x" } };
    expect(resolveFallbackTargets({ entries: [{ provider: LOCAL_MODELS_KEY, model: "qwen3" }] }, providers, "primary", { isChatCapable: chatCapable })).toEqual([]);
  });

  it("B6 供应商不存在（用户删了供应商，池里留了残骸）⇒ 丢弃，不抛", () => {
    expect(resolveTargets([{ provider: "ghost", model: "m" }])).toEqual([]);
  });

  it("B7 baseUrl 不是 http(s) ⇒ 丢弃（避免把空串/相对路径当 URL 发出去）", () => {
    const providers = { ...PROVIDERS, noBase: { api_key: "k", model: "m1" }, rel: { api_base: "/api/v1", api_key: "k" } };
    const run = (provider: string) =>
      resolveFallbackTargets({ entries: [{ provider, model: "m1" }] }, providers, "primary", { isChatCapable: chatCapable });
    expect(run("noBase")).toEqual([]);
    expect(run("rel")).toEqual([]);
  });

  it("B8 非对话模型（image/video/embedding…）⇒ 丢弃（不能让降级链落到它身上）", () => {
    // 这是 A-158 遗留的 isChatCapableModel 过滤规则 —— 迁移后由 engine 把判据传进来
    expect(resolveTargets([{ provider: "backup", model: "pic-image-2" }])).toEqual([]);
  });

  it("B9 被供应商面板**显式关掉**的模型（selected:false）⇒ 丢弃", () => {
    expect(resolveTargets([{ provider: "backup", model: "stable-y" }])).toEqual([]);
  });

  it("B10 但**列表里没有它**的模型一律放行（没探测过模型列表的供应商也得能当降级目标）", () => {
    const t = resolveTargets([{ provider: "backup", model: "hand-typed-model" }]);
    expect(t.map((x) => x.model)).toEqual(["hand-typed-model"]);
  });

  it("B11 api_format：模型级覆盖 > 供应商级", () => {
    expect(resolveTargets([{ provider: "backup", model: "tuned-z" }])[0].apiFormat).toBe("anthropic");
    expect(resolveTargets([{ provider: "backup", model: "stable-x" }])[0].apiFormat).toBe("openai");
  });

  it("B12 用户**显式点名**的 127.0.0.1 供应商不被剔除（与旧自动池的保守规则有意不同）", () => {
    const providers = { ...PROVIDERS, localgw: { api_base: "http://127.0.0.1:8080/v1", api_key: "k" } };
    const t = resolveFallbackTargets({ entries: [{ provider: "localgw", model: "m1" }] }, providers, "primary", { isChatCapable: chatCapable });
    expect(t.map((x) => x.base)).toEqual(["http://127.0.0.1:8080"]);
  });

  it("B13 limit 生效（保前）", () => {
    const entries = [
      { provider: "backup", model: "m1" },
      { provider: "backup", model: "m2" },
      { provider: "backup", model: "m3" },
    ];
    const t = resolveFallbackTargets({ entries }, PROVIDERS, "primary", { isChatCapable: chatCapable, limit: 2 });
    expect(t.map((x) => x.model)).toEqual(["m1", "m2"]);
  });
});

/* ───────────────────── C 组：读盘（缺失/损坏 ⇒ 空池）───────────────────── */

const tmpDirs: string[] = [];
const mkTmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slime-a1108-${tag}-`));
  tmpDirs.push(d);
  return d;
};
afterAll(() => { for (const d of tmpDirs) { rmSync(d, { recursive: true, force: true }); } });

describe("A-1108 C 组 — 读盘语义", () => {
  it("C1 路径 = <root>/config/fallback-pool.json", () => {
    expect(fallbackPoolPath("R")).toBe(join("R", "config", FALLBACK_POOL_FILE));
  });

  it("C2 文件不存在 ⇒ 空池（真实机器上「没配置过」就是这个形态）", () => {
    const d = mkTmp("missing");
    expect(existsSync(fallbackPoolPath(d))).toBe(false);
    expect(readFallbackPool(d)).toEqual({ entries: [] });
  });

  it("C3 JSON 损坏 ⇒ 空池（不抛、更不许沿用别的值）", () => {
    const d = mkTmp("bad");
    writeFallbackPool({ entries: [{ provider: "backup", model: "stable-x" }] }, d);
    writeFileSync(fallbackPoolPath(d), "{ 这不是 JSON", "utf8");
    expect(readFallbackPool(d)).toEqual({ entries: [] });
  });

  it("C4 写入是**整体替换**（不是局部合并）—— 用户删掉一条，重启后不许自己长回来", () => {
    const d = mkTmp("replace");
    writeFallbackPool({ entries: [{ provider: "backup", model: "stable-x" }, { provider: "backup", model: "tuned-z" }] }, d);
    expect(readFallbackPool(d).entries.length).toBe(2);
    const after = writeFallbackPool({ entries: [{ provider: "backup", model: "tuned-z" }] }, d);
    expect(after.entries).toEqual([{ provider: "backup", model: "tuned-z" }]);
    expect(readFallbackPool(d).entries).toEqual([{ provider: "backup", model: "tuned-z" }]);
    // 落盘内容与消毒结果一致，且是易读 JSON（用户可能手改）
    expect(JSON.parse(readFileSync(fallbackPoolPath(d), "utf8"))).toEqual({ entries: [{ provider: "backup", model: "tuned-z" }] });
  });

  it("C5 写坏数据也被消毒后再落盘（磁盘上永远不会出现非法条目）", () => {
    const d = mkTmp("sanitize");
    writeFallbackPool({ entries: [{ provider: "backup", model: "m1" }, { provider: "", model: "" }, { provider: "backup", model: "m1" }] }, d);
    expect(JSON.parse(readFileSync(fallbackPoolPath(d), "utf8"))).toEqual({ entries: [{ provider: "backup", model: "m1" }] });
  });
});

/* ───────────────────── D 组：静态守卫（"只在用户眼里翻车"的那些点）───────────────────── */

describe("A-1108 D 组 — 静态守卫", () => {
  const engine = read("core-ts/src/services/engine.ts");
  const main = read("gui/src/main/index.ts");
  const preload = read("gui/src/preload/index.ts");
  const panel = read("gui/src/renderer/pages/GeneralPanel.tsx");
  const ipc = read("gui/src/shared/ipc.ts");

  /** 从 ipc.ts 文本里取频道常量值（本目录约定：不 import gui 源码） */
  const ipcChannel = (name: string): string => {
    const m = new RegExp(`\\b${name}:\\s*"([^"]+)"`).exec(ipc);
    return m ? m[1] : "";
  };

  it("D1 engine 的降级池来源 = 用户配置（唯一接线：resolveFallbackTargets + currentFallbackPool）", () => {
    expect(engine).toMatch(/resolveFallbackTargets\(this\.currentFallbackPool\(\), this\.providers, key, \{/);
    expect(engine).toMatch(/return this\.fallbackPoolOverride \?\? readFallbackPool\(this\.fallbackPoolRoot \?\? PROJECT_ROOT\);/);
  });

  it("D2 **旧自动池不许回来**（反面断言：没有「遍历其它所有供应商自动注入」那段）", () => {
    // 旧实现的特征字面量：遍历 this.providers 取 others、以及那句误导的日志
    expect(engine).not.toMatch(/const others = Object\.entries\(this\.providers\)/);
    expect(engine).not.toMatch(/注入全局降级池/);
    // 也不许在 engine 里手写「跳过本地模型伪供应商」这第二份规则（判据唯一出处）
    expect(engine).not.toMatch(/import \{[^}]*LOCAL_MODELS_KEY/);
  });

  it("D3 默认值链路：engine 不注入时必须**读盘**（而不是内联一个默认池）", () => {
    // 反面：不许出现 `?? { entries: [` 这种「贴心的默认值」
    expect(engine).not.toMatch(/\?\?\s*\{\s*entries\s*:\s*\[/);
    expect(engine).toMatch(/fallbackPoolOverride \?\? readFallbackPool/);
  });

  it("D4 IPC 频道两边同值（preload 用裸串、常量在 ipc.ts —— 必须钉住不许漂移）", () => {
    expect(ipcChannel("fallback_get")).toBe("slime:fallback:get");
    expect(ipcChannel("fallback_set")).toBe("slime:fallback:set");
    expect(preload).toContain('ipcRenderer.invoke("slime:fallback:get")');
    expect(preload).toContain('ipcRenderer.invoke("slime:fallback:set", { entries })');
  });

  it("D5 主进程两个 handler 都在，且 get 走 readFallbackPool / set 走 writeFallbackPool（不自己造池）", () => {
    expect(main).toMatch(/handleTrusted<void>\("slime:fallback:get", async \(\) => \{\s*return \{ ok: true, entries: readFallbackPool\(\)\.entries, providers: listProviders\(\) \};/);
    expect(main).toMatch(/handleTrusted<\{ entries\?: unknown \}>\("slime:fallback:set"/);
    expect(main).toMatch(/const next = writeFallbackPool\(\{ entries: p\?\.entries \}\);/);
    // 反面：主进程不许内联一份条目数组当默认值
    expect(main).not.toMatch(/entries\s*:\s*\[\s*\{\s*provider\s*:/);
  });

  it("D6 UI 真接线：读、存、增、删四个动作都在 GeneralPanel 上", () => {
    expect(panel).toContain("api.current?.fallback?.get");
    expect(panel).toContain("api.current?.fallback?.set");
    expect(panel).toMatch(/void saveFallbackEntries\(\[\.\.\.fbEntries, \{ provider, model \}\]/);
    expect(panel).toMatch(/fbEntries\.filter\(\(_, i\) => i !== index\)/);
    // 标题必须真的在通用设置里（用户点名「放在通用设置里面」）
    expect(panel).toContain("全局降级池");
  });

  it("D7 界面文案不许把「空池」说成故障，也不许承诺会自动兜底", () => {
    expect(panel).toContain("默认是空的 —— 不配就不跨供应商降级");
    expect(panel).toContain("当前：无降级池（推荐保持）");
    // 反面：不许出现「自动降级/自动兜底」这种与实现相反的承诺
    expect(panel).not.toMatch(/自动降级/);
    expect(panel).not.toMatch(/自动兜底/);
  });

  it("D8 落盘文件名只在 core-ts 模块里定义一次；主进程/preload 不许自己读写那个文件", () => {
    expect(read("core-ts/src/services/fallbackPool.ts")).toContain(`export const FALLBACK_POOL_FILE = "${FALLBACK_POOL_FILE}";`);
    for (const [name, src] of [["main", main], ["preload", preload]] as const) {
      expect(src.includes(FALLBACK_POOL_FILE), `${name} 不应硬编码配置文件名`).toBe(false);
    }
    // 界面上的提示文案必须与常量同源（改名时这条会红，逼着改文案）
    expect(panel).toContain(`config/${FALLBACK_POOL_FILE}`);
  });

  it("D9 core-ts 模块真的在盘上（防「索引指向不存在的实现」）", () => {
    expect(existsSync(resolve(ROOT, "core-ts/src/services/fallbackPool.ts"))).toBe(true);
  });
});
