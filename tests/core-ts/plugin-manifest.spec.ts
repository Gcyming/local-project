import { describe, expect, it } from "vitest";
import { parsePluginManifest, PLUGIN_NAME_PATTERN } from "../../core-ts/src/plugin/manifest.js";

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "web-access",
    version: "1.0.0",
    description: "需要抓取网页正文时",
    origin: "user",
    provides: ["tools"],
    ...over,
  };
}

function errorsOf(raw: unknown): string[] {
  const r = parsePluginManifest(raw);
  if (r.ok) {
    throw new Error("期望校验失败，但通过了");
  }
  return r.errors;
}

describe("parsePluginManifest：合法清单", () => {
  it("接受最小合法清单", () => {
    const r = parsePluginManifest(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("web-access");
    expect(r.manifest.origin).toBe("user");
    expect(r.manifest.provides).toEqual(["tools"]);
  });

  it("requires 与 entry 被保留", () => {
    const r = parsePluginManifest(base({ requires: ["memory"], entry: "tools.js" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.requires).toEqual(["memory"]);
    expect(r.manifest.entry).toBe("tools.js");
  });

  it("provides 去重但保持首次出现顺序", () => {
    const r = parsePluginManifest(base({ provides: ["tools", "instructions", "tools"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.provides).toEqual(["tools", "instructions"]);
  });

  it("requires 去重", () => {
    const r = parsePluginManifest(base({ requires: ["memory", "memory", "planning"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.requires).toEqual(["memory", "planning"]);
  });

  it("requires 为空数组时不写入该字段", () => {
    const r = parsePluginManifest(base({ requires: [] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("requires" in r.manifest).toBe(false);
  });
});

describe("parsePluginManifest：fail-closed 校验", () => {
  it("name 缺失报错", () => {
    expect(errorsOf(base({ name: undefined })).join()).toMatch(/name/);
  });

  it("name 非法（驼峰 / 空格 / 下划线 / 前后横线）报错", () => {
    for (const bad of ["WebAccess", "web access", "web_access", "-web", "web-", "web--access", ""]) {
      const errs = errorsOf(base({ name: bad }));
      expect(errs.length, `name=${bad} 应当被拒绝`).toBeGreaterThan(0);
    }
  });

  it("name 合法时通过（与导出的正则一致）", () => {
    for (const good of ["a", "web-access", "abc123", "a1-b2-c3"]) {
      expect(PLUGIN_NAME_PATTERN.test(good), `name=${good} 应当被接受`).toBe(true);
      expect(parsePluginManifest(base({ name: good })).ok, `name=${good} 应当被接受`).toBe(true);
    }
  });

  it("version 缺失或空报错", () => {
    expect(errorsOf(base({ version: undefined })).join()).toMatch(/version/);
    expect(errorsOf(base({ version: "" })).join()).toMatch(/version/);
    expect(errorsOf(base({ version: "   " })).join()).toMatch(/version/);
    expect(errorsOf(base({ version: 1 })).join()).toMatch(/version/);
  });

  it("provides 含未知贡献类型报错（不静默丢弃）", () => {
    const errs = errorsOf(base({ provides: ["tools", "ui"] }));
    expect(errs.join()).toMatch(/未知贡献类型/);
    expect(errs.join()).toMatch(/ui/);
  });

  it("provides 为空或非数组报错", () => {
    expect(errorsOf(base({ provides: [] })).join()).toMatch(/provides/);
    expect(errorsOf(base({ provides: undefined })).join()).toMatch(/provides/);
    expect(errorsOf(base({ provides: "tools" })).join()).toMatch(/provides/);
  });

  it("requires 含自身报错", () => {
    const errs = errorsOf(base({ requires: ["web-access"] }));
    expect(errs.join()).toMatch(/自身/);
  });

  it("requires 含非法插件名报错", () => {
    expect(errorsOf(base({ requires: ["Web_Access"] })).join()).toMatch(/requires/);
  });

  it("requires 非数组报错", () => {
    expect(errorsOf(base({ requires: "memory" })).join()).toMatch(/requires/);
  });

  it("origin 缺失或不合法报错", () => {
    expect(errorsOf(base({ origin: undefined })).join()).toMatch(/origin/);
    expect(errorsOf(base({ origin: "unknown" })).join()).toMatch(/origin/);
  });

  it("description 缺失或空报错", () => {
    expect(errorsOf(base({ description: undefined })).join()).toMatch(/description/);
    expect(errorsOf(base({ description: "" })).join()).toMatch(/description/);
  });

  it("非对象输入报错（不抛异常）", () => {
    expect(errorsOf(null).length).toBeGreaterThan(0);
    expect(errorsOf(undefined).length).toBeGreaterThan(0);
    expect(errorsOf("web-access").length).toBeGreaterThan(0);
    expect(errorsOf(42).length).toBeGreaterThan(0);
    expect(errorsOf([]).length).toBeGreaterThan(0);
  });

  it("多个错误一次性全部返回，不短路", () => {
    const errs = errorsOf({ name: "BAD", provides: ["nope"], origin: "user" });
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parsePluginManifest：向前兼容", () => {
  it("未知字段不报错且被忽略", () => {
    const r = parsePluginManifest(base({ futureField: 1, icon: "🧩", nested: { a: 1 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("futureField" in r.manifest).toBe(false);
    expect("icon" in r.manifest).toBe(false);
    expect("nested" in r.manifest).toBe(false);
  });

  it("未知字段存在时，仍会校验已知字段", () => {
    expect(errorsOf(base({ futureField: 1, version: "" })).join()).toMatch(/version/);
  });
});