import { describe, expect, it, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools } from "../../core-ts/src/tools/builtin.js";
import { registerBrowserTools } from "../../core-ts/src/tools/browser.js";
import { loadAllSkills } from "../../core-ts/src/skills.js";
import {
  BUILTIN_PLUGIN_GROUPS,
  BUILTIN_TOOL_NAMES,
  auditBuiltinCoverage,
  builtinPluginManifests,
} from "../../core-ts/src/plugin/builtin-plugins.js";
import { parsePluginManifest, PLUGIN_NAME_PATTERN, PLUGIN_CONTRIBUTIONS } from "../../core-ts/src/plugin/manifest.js";
import { PluginHost } from "../../core-ts/src/plugin/host.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function realRegisteredToolNames(): Promise<string[]> {
  resetRegistry();
  const reg = getRegistry();
  registerBuiltinTools(reg);
  registerBrowserTools(reg);
  await loadAllSkills({
    skillDir: path.join(REPO_ROOT, "tests", ".no-such-skill-dir"),
    registry: reg,
  });
  return reg.listToolNames();
}

function toolNamesInSource(rel: string): string[] {
  const src = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const names: string[] = [];
  const re = /new Tool\(\{[\s\S]{0,200}?name:\s*"([a-z0-9_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    names.push(match[1]);
  }
  return names;
}

describe("内置工具清点：以真实运行期注册表为准", () => {
  let names: string[] = [];

  beforeAll(async () => {
    names = await realRegisteredToolNames();
  });

  it("真实注册表恰好是 59 个内置工具", () => {
    expect(names.length).toBe(59);
    expect(names.filter((n) => n.startsWith("skill_")).sort()).toEqual(["skill_lookup", "skill_search"]);
  });

  it("源码实测与运行期注册表一致（builtin 44 + browser 13 + skills 2）", () => {
    expect(toolNamesInSource("core-ts/src/tools/builtin.ts").length).toBe(44);
    expect(toolNamesInSource("core-ts/src/tools/browser.ts").length).toBe(13);
    const fromSource = [...toolNamesInSource("core-ts/src/tools/builtin.ts"), ...toolNamesInSource("core-ts/src/tools/browser.ts"), "skill_search", "skill_lookup"];
    expect([...fromSource].sort()).toEqual([...names].sort());
  });
});

describe("auditBuiltinCoverage：穷尽性自检", () => {
  let names: string[] = [];

  beforeAll(async () => {
    names = await realRegisteredToolNames();
  });

  it("missing 与 extra 均为空 —— 没有内置工具被漏登，也没有多登", () => {
    const report = auditBuiltinCoverage(names);

    expect(report.missing, `未被登记的内置工具：${report.missing.join(", ")}`).toEqual([]);
    expect(report.extra, `登记了但注册表里没有的工具：${report.extra.join(", ")}`).toEqual([]);
    expect(report.covered.length).toBe(59);
  });

  it("登记的 59 个工具名与真实注册表完全相同", () => {
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual([...names].sort());
  });

  it("漏登一个工具会被机械检出（变异验证）", () => {
    const mutated = names.filter((n) => n !== "memory_recall");
    const report = auditBuiltinCoverage(mutated);

    expect(report.missing).toContain("memory_recall");
    expect(report.covered.length).toBe(58);
  });

  it("多登一个注册表里没有的工具会被检出为 extra", () => {
    const report = auditBuiltinCoverage([...names, "totally_made_up"]);

    expect(report.extra).toContain("totally_made_up");
    expect(report.missing).toEqual([]);
  });

  it("MCP 来源的工具不计入 extra（MCP 是工具的来源，不是内置贡献类型）", () => {
    const report = auditBuiltinCoverage([...names, "mcp_res_foo"]);

    expect(report.extra).toEqual([]);
    expect(report.missing).toEqual([]);
  });
});

describe("BuiltinPluginGroup 结构", () => {
  it("族名均为合法 kebab-case", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      expect(PLUGIN_NAME_PATTERN.test(g.name), `族名须匹配 ${PLUGIN_NAME_PATTERN.source}`).toBe(true);
    }
  });

  it("族名唯一", () => {
    const seen = new Set<string>();
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      expect(seen.has(g.name), `族名重复：${g.name}`).toBe(false);
      seen.add(g.name);
    }
  });

  it("系统默认插件一律不可卸载", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      expect(g.unloadable, `${g.name} 应不可卸载`).toBe(false);
    }
  });

  it("description 非空且说明何时用", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      expect(g.description.trim().length, `${g.name} 缺 description`).toBeGreaterThan(0);
    }
  });

  it("中文描述里不出现 ASCII 双引号", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      expect(g.description.includes('"'), `${g.name} 描述含 ASCII 双引号`).toBe(false);
    }
  });

  it("contributions 非空且取值合法", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      expect(g.contributions.length, `${g.name} 缺 contributions`).toBeGreaterThan(0);
      for (const c of g.contributions) {
        expect(PLUGIN_CONTRIBUTIONS).toContain(c);
      }
    }
  });

  it("工具跨族无重复：每个工具恰好属于一个族", () => {
    const owner = new Map<string, string>();
    const dupes: string[] = [];
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      for (const tool of g.tools ?? []) {
        const prev = owner.get(tool);
        if (prev !== undefined) {
          dupes.push(`${tool}（${prev} 与 ${g.name}）`);
        } else {
          owner.set(tool, g.name);
        }
      }
    }
    expect(dupes, `工具跨族重复：${dupes.join(", ")}`).toEqual([]);
  });

  it("列了工具的族必须声明 tools 贡献，且 tools 字段非空", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      const listed = g.tools ?? [];
      if (listed.length > 0) {
        expect(g.contributions, `${g.name} 列了工具却未声明 tools 贡献`).toContain("tools");
      }
      if (g.tools !== undefined) {
        expect(listed.length, `${g.name} 的 tools 字段为空数组`).toBeGreaterThan(0);
      }
    }
  });

  it("既无工具也无 modules 的族不存在", () => {
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      if ((g.tools ?? []).length === 0) {
        expect(g.modules?.length ?? 0, `${g.name} 既无工具也无 modules`).toBeGreaterThan(0);
      }
    }
  });

  it("modules 里标注的源码路径真实存在", () => {
    const bad: string[] = [];
    for (const g of BUILTIN_PLUGIN_GROUPS) {
      for (const mod of g.modules ?? []) {
        if (!existsSync(path.join(REPO_ROOT, mod))) {
          bad.push(`${g.name}:${mod}`);
        }
      }
    }
    expect(bad, `modules 路径不存在：${bad.join(", ")}`).toEqual([]);
  });
});

describe("覆盖 brief 点名的全部能力族与模块", () => {
  const byName = new Map(BUILTIN_PLUGIN_GROUPS.map((g) => [g.name, g]));

  it("brief 列出的能力族都在", () => {
    const expected = [
      "subagent",
      "file-io",
      "doc-authoring",
      "shell-exec",
      "web-access",
      "user-interaction",
      "planning",
      "memory",
      "android-device",
      "http-service",
      "sidebar",
      "screen-control",
      "browser",
      "skill-instructions",
      "doc-parsing",
      "office-render",
      "online-search",
      "mind",
      "silam",
      "local-model",
      "sandbox",
      "terminal-shell",
      "social",
      "multi-agent",
      "guardrails",
      "encryption",
      "observability",
      "model-routing",
      "mcp-bridge",
    ];
    for (const n of expected) {
      expect(byName.has(n), `缺少能力族：${n}`).toBe(true);
    }
  });

  it("brief 点名的模块都被登记", () => {
    const all = new Set(BUILTIN_PLUGIN_GROUPS.flatMap((g) => g.modules ?? []));
    const required = [
      "core-ts/src/doc_text.ts",
      "core-ts/src/pdf_text.ts",
      "core-ts/src/zip.ts",
      "core-ts/src/cfb.ts",
      "core-ts/src/office/docWrite.ts",
      "core-ts/src/office/fileKinds.ts",
      "core-ts/src/office/libreoffice.ts",
      "core-ts/src/office/renderPlan.ts",
      "core-ts/src/search/onlineSearch.ts",
      "core-ts/src/websearch/engine.ts",
      "core-ts/src/websearch/crawler.ts",
      "core-ts/src/memory/store.ts",
      "core-ts/src/memory/three_layer.ts",
      "core-ts/src/memory/retrieve.ts",
      "core-ts/src/memory/recall_gate.ts",
      "core-ts/src/memory/global.ts",
      "core-ts/src/memory/knowledge.ts",
      "core-ts/src/memory/similarity.ts",
      "core-ts/src/memory/fulltext.ts",
      "core-ts/src/mind/emotion.ts",
      "core-ts/src/mind/behavior.ts",
      "core-ts/src/mind/hooks.ts",
      "core-ts/src/model_server.ts",
      "core-ts/src/local_models.ts",
      "core-ts/src/gguf_meta.ts",
      "core-ts/src/model_introspect.ts",
      "core-ts/src/sandbox.ts",
      "core-ts/src/screen/controller.ts",
      "core-ts/src/screen/arbiter.ts",
      "core-ts/src/screen/optimize.ts",
      "core-ts/src/terminal/ansi.ts",
      "core-ts/src/terminal/profiles.ts",
      "core-ts/src/social/wecom.ts",
      "core-ts/src/planning/plan.ts",
      "core-ts/src/observability/trace.ts",
      "core-ts/src/router.ts",
      "core-ts/src/llm/client.ts",
      "core-ts/src/mcp.ts",
      "core-ts/src/skills.ts",
      "core-ts/src/a2a.ts",
      "core-ts/src/services/grouptalk.ts",
      "core-ts/src/services/brainstorm.ts",
      "core-ts/src/claims.ts",
      "core-ts/src/filter.ts",
      "core-ts/src/diff_marker.ts",
      "core-ts/src/encryption.ts",
      "core-ts/src/sidebarMount.ts",
      "core-ts/src/sidebarOpen.ts",
    ];
    for (const r of required) {
      expect(all.has(r), `模块未被任何族登记：${r}`).toBe(true);
    }
  });

  it("MCP 归入工具来源一族，而不是贡献类型", () => {
    const mcp = byName.get("mcp-bridge")!;
    expect(mcp.modules).toContain("core-ts/src/mcp.ts");
    expect(mcp.contributions).toEqual(["tools"]);
  });
});

describe("builtinPluginManifests", () => {
  it("产物数量与族数一致，且全部通过 parsePluginManifest 复校", () => {
    const manifests = builtinPluginManifests();

    expect(manifests.length).toBe(BUILTIN_PLUGIN_GROUPS.length);
    for (const mf of manifests) {
      const parsed = parsePluginManifest(mf);
      expect(parsed.ok, `${mf.name} 复校失败`).toBe(true);
      if (parsed.ok) {
        expect(parsed.manifest.origin).toBe("builtin");
        expect(parsed.manifest.name).toBe(mf.name);
      }
    }
  });

  it("清单名与族名一一对应", () => {
    expect(builtinPluginManifests().map((m) => m.name)).toEqual(BUILTIN_PLUGIN_GROUPS.map((g) => g.name));
  });

  it("全部 builtin 清单装进 PluginHost 后均为 loaded", async () => {
    const h = new PluginHost({
      registerTools: () => [{ label: "builtin 工具", dispose: () => undefined }],
      registerInstructions: () => [{ label: "builtin 指令", dispose: () => undefined }],
    });
    const records = await h.load(builtinPluginManifests());

    const failed = records.filter((r) => r.status === "failed");
    expect(failed.map((f) => `${f.manifest.name}: ${f.error}`)).toEqual([]);
    expect(records.length).toBe(BUILTIN_PLUGIN_GROUPS.length);
    // 加强：内置插件一律不可卸载，且 load 时就已落到 record 上。
    expect(records.every((r) => r.unloadable === false)).toBe(true);
  });

  it("builtin 插件在 host 里一律不可卸载（返回报告，不抛异常，状态不变）", async () => {
    const h = new PluginHost({
      registerTools: () => [{ label: "builtin 工具", dispose: () => undefined }],
      registerInstructions: () => [{ label: "builtin 指令", dispose: () => undefined }],
    });
    const manifests = builtinPluginManifests();
    await h.load(manifests);

    for (const mf of manifests) {
      const r = await h.unload(mf.name);
      expect(r.ok, `${mf.name} 不应卸载成功`).toBe(0);
      expect(r.failed.length, `${mf.name} 应有一条失败记录`).toBe(1);
      expect((r.failed[0].error as Error).message, `${mf.name}`).toMatch(/不可卸载/);
    }
    expect(h.list().every((r) => r.status === "loaded")).toBe(true);
  });
});