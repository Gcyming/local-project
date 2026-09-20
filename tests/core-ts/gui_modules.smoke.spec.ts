import { describe, it, expect, afterEach } from "vitest";
import { resolveProjectRootFrom } from "../../core-ts/src/paths.js";
import {
  overview, readConfigFile, writeConfigFile, setMcpEnabled, setRootOverrideForTest as setCfgRoot,
} from "../../gui/src/main/config_files.js";
import {
  listProviders, saveProvider, removeProvider, fetchModels, setRootOverrideForTest as setProvRoot,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
} from "../../gui/src/main/providers.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let sandbox: string | null = null;
afterEach(async () => {
  setCfgRoot(null);
  setProvRoot(null);
  if (sandbox) {
    await rm(sandbox, { recursive: true, force: true });
    sandbox = null;
  }
});

async function makeSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slime-gui-smoke-"));
  sandbox = dir;
  setCfgRoot(dir);
  setProvRoot(dir);
  return dir;
}

describe("GUI 主进程模块冒烟（临时验证）", () => {
  it("paths：electron-vite 打包入口也能解析到项目根（PROJECT_ROOT 回归）", async () => {
    const { existsSync } = await import("node:fs");
    // electron-vite 打包后 core-ts 被 bundle 进 gui/out/main，import.meta.url 在 gui/out 之下
    const fromOutMain = resolveProjectRootFrom("file:///D:/pilot%20project/gui/out/main/index.js");
    expect(fromOutMain).toContain("pilot project");
    expect(existsSync(`${fromOutMain}/slime.toml`)).toBe(true);
    // 源码/测试入口（core-ts/src）解析不变
    const fromSrc = resolveProjectRootFrom("file:///D:/pilot%20project/core-ts/src/paths.ts");
    expect(fromSrc).toContain("pilot project");
    expect(existsSync(`${fromSrc}/slime.toml`)).toBe(true);
  });
  it("config_files：overview 扫描 slime.toml / 技能库 / MCP（真实项目根，只读）", () => {
    const ov = overview();
    const toml = ov.files.find((f) => f.name === "slime.toml");
    expect(toml?.exists).toBe(true);
    expect(ov.skills.length).toBeGreaterThan(0);
    const browser = ov.mcpServers.find((m) => m.name === "browser");
    expect(browser?.kind).toBe("stdio");
    expect(browser?.enabled).toBe(true);
  });

  it("config_files：白名单写回（隔离沙箱）与只读保护", async () => {
    const dir = await makeSandbox();
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "slime.toml"), "# test\n[memory]\nenabled = true\n", "utf8");
    await writeFile(join(dir, "config", "agents.json"), "{}", "utf8");

    const r = writeConfigFile("slime.toml", "# test\n[memory]\nenabled = false\n");
    expect(r.ok).toBe(true);
    expect(readConfigFile("slime.toml").content).toContain("enabled = false");

    // agents.json：可读不可写
    expect(readConfigFile("agents.json").ok).toBe(true);
    expect(writeConfigFile("agents.json", "{}").ok).toBe(false);
    // 白名单外拒绝
    expect(readConfigFile("other.toml").ok).toBe(false);
    expect(writeConfigFile("other.toml", "x").ok).toBe(false);
    // 不存在文件
    expect(readConfigFile("global_config.json").ok).toBe(false);
  });

  it("config_files：启用/禁用 MCP 不吞块外注释、不留残留空格（A-980-R28 真事故回归）", async () => {
    const dir = await makeSandbox();
    await mkdir(join(dir, "config"), { recursive: true });
    // 复刻事故现场（与真实 slime.toml 同构）：注释态 server 块 + 块外散文/横幅注释 + 后续配置段
    const src = [
      "[memory]",
      "enabled = true",
      "",
      "# ── 说明横幅 ──",
      "# [[mcp_servers]]",
      '# name = "agent_browser"',
      '# command = "cmd"',
      '# args = ["/c", "npx", "-y", "agent-browser", "mcp"]',
      "# timeout = 60",
      "",
      "# 已删除（A-092-R）：headroom 上下文压缩",
      "# 已删除（A-092-R）：browser-use 浏览器自动化",
      "",
      "# ── Agnes 媒体配置 ──",
      "",
      "[media]",
      'env_key = "X"',
      "",
    ].join("\n");
    await writeFile(join(dir, "slime.toml"), src, "utf8");

    // 启用：只剥 server 块自身，且不留残留前导空格；块外注释必须逐字保留（否则 toml 解析失败）
    expect(setMcpEnabled("agent_browser", true).ok).toBe(true);
    const on = readConfigFile("slime.toml").content ?? "";
    expect(on).toContain('[[mcp_servers]]\nname = "agent_browser"\ncommand = "cmd"');
    expect(on).not.toContain(' [[mcp_servers]]');
    expect(on).not.toContain(' name = "agent_browser"');
    expect(on).toContain("# 已删除（A-092-R）：headroom 上下文压缩");
    expect(on).toContain("# ── Agnes 媒体配置 ──");
    expect(on).toContain("# ── 说明横幅 ──");
    expect(on).toContain("[media]\nenv_key = \"X\"");

    // 禁用：加/减 # 严格互逆 → 逐字节回到原样
    expect(setMcpEnabled("agent_browser", false).ok).toBe(true);
    expect(readConfigFile("slime.toml").content).toBe(src);
    // 未命中名称不写盘
    expect(setMcpEnabled("not-exist", true).ok).toBe(false);
  });

  it("providers：加密保存/列表脱敏/保留 key/删除闭环（隔离沙箱）", async () => {
    await makeSandbox();
    const save = await saveProvider({ key: "demo", api_base: "https://api.demo.com/v1", api_key: "sk-abcdef123456", models: [{ id: "m1", context_window: 8192, max_output: 2048, vision: true }] });
    expect(save.ok).toBe(true);
    const list = listProviders();
    expect(list.length).toBe(1);
    expect(list[0].key).toBe("demo");
    expect(list[0].has_key).toBe(true);
    expect(list[0].key_hint).not.toContain("abcdef123456");
    expect(list[0].key_hint).toContain("***");
    expect(list[0].models[0].vision).toBe(true);
    expect(list[0].models[0].context_window).toBe(8192);
    // 重存不传 key → 保留旧 key
    expect((await saveProvider({ key: "demo", api_base: "https://api.demo.com/v1" })).ok).toBe(true);
    expect(listProviders()[0].has_key).toBe(true);
    expect(listProviders()[0].key_hint).toContain("***");
    // 非法输入
    expect((await saveProvider({ key: "bad key!", api_base: "https://x.com" })).ok).toBe(false);
    expect((await saveProvider({ key: "ok", api_base: "ftp://x.com" })).ok).toBe(false);
    expect((await saveProvider({ key: "ok", api_base: "https://x.com", api_key: "" })).ok).toBe(false);
    // 删除
    expect(removeProvider("demo").ok).toBe(true);
    expect(listProviders().length).toBe(0);
    // 幂等删除
    expect(removeProvider("demo").ok).toBe(true);
    // 沙箱外无副作用（真实项目根不出现 demo）
    expect(listProviders().find((p) => p.key === "demo")).toBeUndefined();
  });

  it("providers：fetchModels 非法输入返回错误", async () => {
    const r = await fetchModels("not a url", "k");
    expect(r.ok).toBe(false);
    const r2 = await fetchModels("", "");
    expect(r2.ok).toBe(false);
  });

  it("A-988 回归：缓存价 0（缓存免费）必须活过读盘往返，不能被 sanitizeModels 抹成「未定价」", async () => {
    /*
     * 事故形态：`sanitizeModels` 里给两个缓存价字段多写了一层 `&& value > 0` 过滤
     * （上下文窗口那种字段加 `> 0` 是对的 —— 0 个 token 的窗口没有意义；
     *   但价格字段的 0 是**合法价**："该网关缓存命中免费"是真实计费口径）。
     *
     * 后果链条（全程静默，界面上「看起来是个数字」）：
     *   用户手填 缓存命中 = 0  →  sanitizeModels 抹成 undefined
     *   → resolveCacheRates 的 stored 分支落空 → 走倍率推导 0.1× 输入价
     *   → 缓存命中的 token 被按 0.1× 输入价收费。本来是免费的，被记成了钱。
     *
     * 而且 sanitizeModels 在 **saveProvider（1592 行）和 listProviders（230 行）两处都跑**，
     * 所以这个 0 连磁盘都进不去 —— 必须两端都保住。
     */
    await makeSandbox();
    const saved = await saveProvider({
      key: "cachefree", api_base: "https://api.cachefree.com/v1", api_key: "sk-aaaaaaaaaaaa",
      models: [{
        id: "deepseek-flash", context_window: 1048576, max_output: 65536, selected: true,
        price_in_usd: 0.3, price_out_usd: 1.2,
        price_cache_read_usd: 0, price_cache_write_usd: 0,
        price_source: "manual",
      }],
    });
    expect(saved.ok).toBe(true);

    const m = listProviders()[0].models[0];
    // 0 必须原样活着 —— 不能变成 undefined（未定价），也不能被当成"空"而回退
    expect(m.price_cache_read_usd).toBe(0);
    expect(m.price_cache_write_usd).toBe(0);
    // 与此同时，真正的 undefined（未定价）不能被这里顺手写成 0 —— 两者语义相反，都别混
    expect(m.price_in_usd).toBe(0.3);
    expect(m.price_source).toBe("manual");
  });

  it("A-988 回归：未定价的缓存价仍是 undefined，不能被 0 顶替", async () => {
    await makeSandbox();
    await saveProvider({
      key: "noprice", api_base: "https://api.noprice.com/v1", api_key: "sk-bbbbbbbbbbbb",
      models: [{ id: "m1", selected: true, price_in_usd: 1, price_out_usd: 2 }],
    });
    const m = listProviders()[0].models[0];
    // 「没填」= undefined，交给 resolveCacheRates 去推导；绝不能悄悄写成 0（那是"免费"）
    expect(m.price_cache_read_usd).toBeUndefined();
    expect(m.price_cache_write_usd).toBeUndefined();
  });

  it("providers：本地模型 保存/列表/删除/扫描/名称冲突 闭环（隔离沙箱）", async () => {
    const dir = await makeSandbox();
    const modelDir = join(dir, "models");
    await mkdir(modelDir, { recursive: true });
    const gguf = join(modelDir, "qwen-3b.gguf");
    const other = join(modelDir, "readme.txt");
    await writeFile(gguf, "GGUF_BYTES", "utf8");
    await writeFile(other, "not a model", "utf8");

    // 扫描：只出 GGUF
    const scan = scanLocalModels(modelDir);
    expect(scan.ok).toBe(true);
    expect(scan.models?.length).toBe(1);
    expect(scan.models?.[0].label).toBe("qwen-3b.gguf");

    // 路径不存在 → 拒绝
    expect(saveLocalModel({ id: "qwen", path: join(dir, "nope.gguf") }).ok).toBe(false);
    // 相对路径 → 拒绝
    expect(saveLocalModel({ id: "qwen", path: "models/qwen.gguf" }).ok).toBe(false);

    // 保存成功 + 参数落地
    const save = saveLocalModel({ id: "qwen", path: gguf, label: "Qwen 3B", ctx_len: 8192, gpu_layers: 99, max_output: 4096, vision: true });
    expect(save.ok).toBe(true);
    const list = listLocalModels();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("qwen");
    expect(list[0].ctx_len).toBe(8192);
    expect(list[0].gpu_layers).toBe(99);
    expect(list[0].max_output).toBe(4096);
    expect(list[0].vision).toBe(true);

    // Bug2 回归：本地模型不串入 API 供应商列表（_local_models 为特殊键，不得作为 provider 出现、也不得显示"无密钥"）
    expect(listProviders().find((p) => p.key === "_local_models")).toBeUndefined();

    // 与 API 供应商 key 冲突 → 拒绝
    expect((await saveProvider({ key: "qwen", api_base: "https://x.com" })).ok).toBe(true);
    expect(saveLocalModel({ id: "qwen", path: gguf }).ok).toBe(false);
    expect(saveLocalModel({ id: "bad name!", path: gguf }).ok).toBe(false);

    // 删除 + 幂等
    expect(removeLocalModel("qwen").ok).toBe(true);
    expect(listLocalModels().length).toBe(0);
    expect(removeLocalModel("qwen").ok).toBe(true);
    // 沙箱外无副作用
    expect(listLocalModels().find((m) => m.id === "qwen")).toBeUndefined();
  });
});
