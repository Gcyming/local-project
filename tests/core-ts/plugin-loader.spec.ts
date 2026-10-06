import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVISIBLE_UNICODE_REJECTION,
  findInvisibleUnicode,
  loadPluginsFromDisk,
} from "../../core-ts/src/plugin/loader.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-loader-"));
  roots.push(root);
  return root;
}

const ZW = String.fromCharCode(0x200b);

function writePlugin(root: string, dirName: string, over: Record<string, unknown> = {}): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: dirName,
    version: "1.0.0",
    description: "何时用：需要一个样例插件时。",
    origin: "agent",
    provides: ["instructions"],
    ...over,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

function names(manifests: Array<{ manifest: { name: string } }>): string[] {
  return manifests.map((m) => m.manifest.name);
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("loadPluginsFromDisk：合法清单", () => {
  it("装载 origin=agent 与 origin=user 两类来源，并给出绝对来源目录", async () => {
    const root = makeRoot();
    const agentDir = writePlugin(root, "agent-made");
    const userDir = writePlugin(root, "user-made", { origin: "user" });

    const res = await loadPluginsFromDisk(root);

    expect(res.rejected).toEqual([]);
    expect(names(res.manifests).sort()).toEqual(["agent-made", "user-made"]);
    const agent = res.manifests.find((m) => m.manifest.name === "agent-made")!;
    expect(agent.dir).toBe(agentDir);
    expect(agent.manifest.origin).toBe("agent");
    expect(res.manifests.find((m) => m.manifest.name === "user-made")!.dir).toBe(userDir);
  });

  it("根目录不存在时返回空结果而非抛错", async () => {
    const root = makeRoot();
    const res = await loadPluginsFromDisk(join(root, "not-here"));
    expect(res.manifests).toEqual([]);
    expect(res.rejected).toEqual([]);
  });

  it("entry 指向的文件不存在时只记 warning，仍照常装载", async () => {
    const root = makeRoot();
    writePlugin(root, "with-entry", { entry: "tools.js" });

    const res = await loadPluginsFromDisk(root);

    expect(res.rejected).toEqual([]);
    expect(res.manifests).toHaveLength(1);
    expect(res.manifests[0].warnings.join()).toContain("entry 指向的文件不存在：tools.js");
  });

  it("entry 指向真实文件时不产生 warning", async () => {
    const root = makeRoot();
    const dir = writePlugin(root, "real-entry", { entry: "tools.js" });
    writeFileSync(join(dir, "tools.js"), "export default {};");

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests[0].warnings).toEqual([]);
  });
});

describe("loadPluginsFromDisk：fail-closed 拒绝", () => {
  it("无 plugin.json 的普通目录只跳过并记 warning，不进 rejected", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "not-a-plugin"), { recursive: true });
    writePlugin(root, "good-one");

    const res = await loadPluginsFromDisk(root);

    expect(res.rejected).toEqual([]);
    expect(names(res.manifests)).toEqual(["good-one"]);
    expect(res.warnings.join()).toContain("not-a-plugin");
  });

  it("name 与目录名不一致时 rejected（防「声明一套、目录一套」）", async () => {
    const root = makeRoot();
    writePlugin(root, "dir-name", { name: "declared-name" });

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].errors.join()).toContain("必须与目录名");
  });

  it("description 含零宽字符时 rejected，错误信息注明投毒风险", async () => {
    const root = makeRoot();
    writePlugin(root, "zero-width", { description: `何时用：正常说明里藏了零宽字符${ZW}` });

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].errors[0]).toBe(INVISIBLE_UNICODE_REJECTION);
    expect(res.rejected[0].errors.join()).toContain("U+200B");
    expect(res.rejected[0].errors.join()).toContain("description");
  });

  it("entry 含不可见 Unicode 同样 rejected", async () => {
    const root = makeRoot();
    writePlugin(root, "zw-entry", { entry: `tools${ZW}.js` });

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].errors[0]).toBe(INVISIBLE_UNICODE_REJECTION);
    expect(res.rejected[0].errors.join()).toContain("entry");
  });

  it("name 含不可见 Unicode 时先被清单校验拦下（kebab-case 不容纳零宽）", async () => {
    const root = makeRoot();
    writePlugin(root, `bad${ZW}name`);

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].errors.join()).toContain("name 缺失或不合法");
  });

  it("origin=builtin 的磁盘清单一律拒绝（不得伪造系统默认插件）", async () => {
    const root = makeRoot();
    writePlugin(root, "fake-builtin", { origin: "builtin" });

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].errors.join()).toContain("builtin 是系统保留值");
  });

  it("清单非法时 rejected 带上 parsePluginManifest 的全部 errors，且不阻断其他目录", async () => {
    const root = makeRoot();
    writePlugin(root, "broken", { version: "", description: "", origin: "", provides: [] });
    writePlugin(root, "healthy");

    const res = await loadPluginsFromDisk(root);

    expect(names(res.manifests)).toEqual(["healthy"]);
    expect(res.rejected).toHaveLength(1);
    const errors = res.rejected[0].errors.join("；");
    expect(errors).toContain("version 缺失或为空");
    expect(errors).toContain("description 缺失或为空");
    expect(errors).toContain("origin 缺失或不合法");
    expect(errors).toContain("provides 缺失或为空");
  });

  it("plugin.json 不是合法 JSON 时 rejected", async () => {
    const root = makeRoot();
    const dir = join(root, "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{ 这不是 JSON");

    const res = await loadPluginsFromDisk(root);

    expect(res.manifests).toEqual([]);
    expect(res.rejected[0].errors.join()).toContain("不是合法 JSON");
  });
});

describe("loadPluginsFromDisk：来源过滤", () => {
  it("opts.origins 给定时只保留指定来源，其余按跳过记 warning", async () => {
    const root = makeRoot();
    writePlugin(root, "a-agent");
    writePlugin(root, "b-user", { origin: "user" });
    writePlugin(root, "c-market", { origin: "market" });

    const res = await loadPluginsFromDisk(root, { origins: ["agent"] });

    expect(names(res.manifests)).toEqual(["a-agent"]);
    expect(res.rejected).toEqual([]);
    expect(res.warnings.join()).toContain("origin=user");
  });

  it("origins 未给出时 agent / user / market 三类来源全部保留", async () => {
    const root = makeRoot();
    writePlugin(root, "a-agent");
    writePlugin(root, "b-user", { origin: "user" });
    writePlugin(root, "c-market", { origin: "market" });

    const res = await loadPluginsFromDisk(root);

    expect(names(res.manifests).sort()).toEqual(["a-agent", "b-user", "c-market"]);
  });
});

describe("findInvisibleUnicode", () => {
  it("命中五种不可见字符，正常文本不误报", () => {
    const text = ["a", "b", "c", "d", "e", "f"]
      .map((ch, i) => `${ch}${String.fromCharCode([0x200b, 0x200c, 0x200d, 0xfeff, 0x2060][i])}`)
      .join("");
    expect(findInvisibleUnicode(text)).toHaveLength(5);
    expect(findInvisibleUnicode("正常说明")).toEqual([]);
  });
});