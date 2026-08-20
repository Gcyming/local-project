import { describe, it, expect, afterEach } from "vitest";
import { resolveProjectRootFrom } from "../../core-ts/src/paths.js";
import {
  overview, readConfigFile, writeConfigFile, setRootOverrideForTest as setCfgRoot,
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

  it("providers：加密保存/列表脱敏/保留 key/删除闭环（隔离沙箱）", async () => {
    await makeSandbox();
    const save = saveProvider({ key: "demo", api_base: "https://api.demo.com/v1", api_key: "sk-abcdef123456", models: [{ id: "m1", context_window: 8192, max_output: 2048, vision: true }] });
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
    expect(saveProvider({ key: "demo", api_base: "https://api.demo.com/v1" }).ok).toBe(true);
    expect(listProviders()[0].has_key).toBe(true);
    expect(listProviders()[0].key_hint).toContain("***");
    // 非法输入
    expect(saveProvider({ key: "bad key!", api_base: "https://x.com" }).ok).toBe(false);
    expect(saveProvider({ key: "ok", api_base: "ftp://x.com" }).ok).toBe(false);
    expect(saveProvider({ key: "ok", api_base: "https://x.com", api_key: "" }).ok).toBe(false);
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

    // 与 API 供应商 key 冲突 → 拒绝
    expect(saveProvider({ key: "qwen", api_base: "https://x.com" }).ok).toBe(true);
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
