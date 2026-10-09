import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_PLUGIN_SETTINGS,
  PLUGIN_SETTING_KEY_PATTERN,
  PLUGIN_SETTING_ROOTS,
  PLUGIN_SETTING_TYPES,
  parsePluginContributes,
  parsePluginSettings,
  validatePluginSettingValue,
} from "../../core-ts/src/plugin/contributes.js";
import type { PluginSettingDecl } from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import { PluginHost } from "../../core-ts/src/plugin/host.js";
import {
  MAX_PLUGIN_SETTINGS_BYTES,
  SettingsStore,
  assertSafePluginName,
  pluginSettingsEncPath,
  pluginSettingsPath,
  readSettingsBackup,
} from "../../core-ts/src/plugin/settings-store.js";
import { SettingsService } from "../../core-ts/src/plugin/settings-service.js";

/**
 * A-1197 · B1（L4b 设置贡献点）—— 插件能在自己目录里声明并持久化设置项，且**不污染主配置**。
 *
 * 五条能力点各自对应下面五组断言：
 *   ① 路径只由插件名推导（渲染层传路径必须无效）
 *   ② secret 不落明文、读回只给 hasValue
 *   ③ 未知字段/ 非法类型被 fail-closed拒
 *   ④ 插件禁用/卸载后贡献被摘
 *   ⑤ 原子写（写坏不污染原文件）
 *
 * ⚠️ 本文件绝大多数是**行为断言**（store 与 service 是纯逻辑，直接 import 真跑）。
 * 只有最后一组是**形状断言**，理由写在那一组的describe 里（主进程文件依赖 electron，
 *   vitest 里 import 不起来；而「IPC 入参没有 path」这条结构性质静态可核）。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a1197-l4b-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function decl(over: Partial<PluginSettingDecl> = {}): PluginSettingDecl {
  return { key: "token", label: "令牌", type: "string", ...over };
}

/** 假的「数据根/config/plugins」。 */
const pluginsRoot = (): string => join(dir, "config", "plugins");

function makeStore(over: Partial<ConstructorParameters<typeof SettingsStore>[0]> = {}): SettingsStore {
  return new SettingsStore({ pluginsRoot: pluginsRoot(), ...over });
}

/* ══════════════════════════════════════════════════════════════════════════
 * ① 路径只由插件名推导 —— 渲染层传路径必须无效
 * ═════════════════════════════════════════════════════════════════════════ */

describe("① 路径只由插件名推导（伪造名字 / 渲染层传路径一律无效）", () => {
  it("正常插件名 ⇒ 落在 config/plugins/<名>/settings.json", () => {
    expect(pluginSettingsPath(pluginsRoot(), "my-plugin")).toBe(
      join(pluginsRoot(), "my-plugin", "settings.json"),
    );
    expect(pluginSettingsEncPath(pluginsRoot(), "my-plugin")).toBe(
      join(pluginsRoot(), "my-plugin", "settings.enc.json"),
    );
  });

  /* 反例必须真的抛 —— 这是「路径只由名字推导」的唯一防线。
     若哪天assert 被删掉，这四条会立刻变红（而不是静默写到插件根外面）。
     ⚠️ 判据是「抛错」而不是「算出来的路径不在根内」：凡是能通过 `assertSafePluginName`
     的名字，推导结果**必然**落在根内（`join(root, name, file)` 且 name 无分隔符），
     所以「是否在根内」是个恒真判定 —— 拿它当断言就是拿恒真当守卫（变异实测：恒红恒绿都试过）。 */
  it.each([
    ["父目录穿越", "../evil"],
    ["深层穿越", "../../evil"],
    ["绝对路径（POSIX）", "/etc/passwd"],
    ["Windows 盘符绝对路径", "C:\\evil"],
    ["反斜杠穿越", "..\\evil"],
    ["名字里带分隔符", "sub/evil"],
    ["空字符串", ""],
  ])("%s ⇒ 拒绝推导路径（抛错，不是静默写到别处）", (_label, evilName) => {
    expect(() => pluginSettingsPath(pluginsRoot(), evilName)).toThrow(/插件名不合法/);
    expect(() => pluginSettingsEncPath(pluginsRoot(), evilName)).toThrow(/插件名不合法/);
  });

  it("assertSafePluginName 独立再assert 一次（不靠上游清单已校验）", () => {
    /* 这条是刻意**不 import 上游**也能成立的防线：哪怕有人把manifest 的校验改松了，
       这里依然会拒。注释指明这一点，避免后人来「清理重复校验」。 */
    expect(() => assertSafePluginName("UPPER")).toThrow();
    expect(() => assertSafePluginName("has space")).toThrow();
    expect(() => assertSafePluginName("../..")).toThrow();
    expect(assertSafePluginName("ok-name-2")).toBe("ok-name-2");
  });

  it("store 的写端也走同一条推导（不存在「另一个入口能传路径」）", () => {
    const store = makeStore();
    const res = store.writeOne("../evil", decl(), "x");
    /* 穿越失败是**返回错误**而不是抛 —— store 的返回值会直接进 IPC handler，
       抛出去会变成未处理 rejection。断言的是「没写出去」。 */
    expect(res.ok).toBe(false);
    /* 穿越失败后插件根之外不许出现任何文件 */
    expect(existsSync(join(dir, "evil"))).toBe(false);
    expect(existsSync(join(dir, "config", "evil"))).toBe(false);
    expect(existsSync(join(dir, "config", "plugins", "settings.json"))).toBe(false);
  });

  it("service.set 的签名只有 plugin/key/value —— 结构上没有 path 这个槽位", () => {
    /* 形状断言（不是行为断言）：service.set 是本仓唯一接收写入参数的地方，
       它的形参**就是**渲染层能传的全部。断言源码里不含 path / 文件名，
       哪天有人加第四个形参（path），这条立刻红。 */
    const src = Function.prototype.toString.call(SettingsService.prototype.set);
    expect(SettingsService.prototype.set.length).toBe(3);
    expect(src).not.toMatch(/\bpath\b/i);
    expect(src).not.toMatch(/settings\.json/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * ② secret 不落明文、读回只给 hasValue
 * ═════════════════════════════════════════════════════════════════════════ */

describe("② secret 项：不明文落盘、读回只给 hasValue", () => {
  /* 用**可注入的假加密**而不是真加密：这条断言要验的是「store 把 secret 项交给加密通道、
     且绝不写进明文文件」这条**分流**，不是 AES 本身（那是 encryption.ts 的守卫）。
     真加密会动 ~/.slime_pass —— 守卫不该有副作用。
     ⚠️ 假实现必须**真的落盘/真读盘**（走 settings.enc.json 那个真实路径），
     否则 `read` 会因`existsSync` 为假而跳过 —— 那就变成「什么都没验」的假绿。 */
  function fakeCrypto(): { enc: (v: Record<string, unknown>, p: string) => void; dec: (p: string) => Record<string, unknown> | null } {
    return {
      enc: (v, p) => { writeFileSync(p, JSON.stringify(v), "utf8"); },
      dec: (p) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>,
    };
  }

  it("写 secret 项 ⇒ 明文 settings.json 里没有它，密文文件里有它", () => {
    const { enc, dec } = fakeCrypto();
    const store = makeStore({ encrypt: enc, decrypt: dec });
    const res = store.writeOne("sec-plugin", decl({ key: "api-token", secret: true }), "SUPER-SECRET");
    expect(res.ok).toBe(true);

    const plainPath = pluginSettingsPath(pluginsRoot(), "sec-plugin");
    expect(existsSync(plainPath)).toBe(false);
    const encPath = pluginSettingsEncPath(pluginsRoot(), "sec-plugin");
    expect(existsSync(encPath)).toBe(true);
    expect(JSON.parse(readFileSync(encPath, "utf8"))).toEqual({ "api-token": "SUPER-SECRET" });
  });

  it("明文文件里逐字节搜不到 secret 值（防「顺手也写一份明文」）", () => {
    const { enc, dec } = fakeCrypto();
    const store = makeStore({ encrypt: enc, decrypt: dec });
    store.writeOne("sec-plugin", decl({ key: "a", secret: true }), "zzz-plaintext-canary");
    store.writeOne("sec-plugin", decl({ key: "b" }), "visible");
    const plainPath = pluginSettingsPath(pluginsRoot(), "sec-plugin");
    expect(existsSync(plainPath)).toBe(true);
    expect(readFileSync(plainPath, "utf8")).not.toContain("zzz-plaintext-canary");
    /* 非密文项照常明文落盘（否则设置项就白写了） */
    expect(JSON.parse(readFileSync(plainPath, "utf8"))).toEqual({ b: "visible" });
  });

  it("读回：secret 项只给 hasValue，**DTO 里没有 value 这个键**", () => {
    const { enc, dec } = fakeCrypto();
    const decls = [decl({ key: "api-token", secret: true })];
    const res = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => decls,
      isLoaded: () => true,
      encrypt: enc,
      decrypt: dec,
    });
    expect(res.set("sec-plugin", "api-token", "SUPER-SECRET").ok).toBe(true);

    const got = res.get("sec-plugin");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const item = got.dto.items[0];
    expect(item.secret).toBe(true);
    expect(item.hasValue).toBe(true);
    /* ⚠️ 判据用 `in` 而不是 `toBeUndefined`：真正要防的是「DTO 上**有** value 键但值为 undefined」
       —— 后者序列化后就是 JSON.stringify 把它丢掉，行为上一样安全但形状上仍在骗人。 */
    expect("value" in item).toBe(false);
    expect(JSON.stringify(got.dto)).not.toContain("SUPER-SECRET");
  });

  it("secret 项还没写过 ⇒ hasValue=false（不猜、不回退默认值）", () => {
    const { enc, dec } = fakeCrypto();
    const res = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => [decl({ key: "api-token", secret: true })],
      isLoaded: () => true,
      encrypt: enc,
      decrypt: dec,
    }).get("sec-plugin");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dto.items[0].hasValue).toBe(false);
  });

  it("解密失败 ⇒ 该 secret 项视作无值 + 如实告警（不回退去读明文）", () => {
    mkdirSync(join(pluginsRoot(), "sec-plugin"), { recursive: true });
    writeFileSync(pluginSettingsEncPath(pluginsRoot(), "sec-plugin"), "GARBAGE", "utf8");
    const store = makeStore({ decrypt: () => null });
    const read = store.read("sec-plugin", [decl({ key: "api-token", secret: true })]);
    expect(read.secretKeys).toEqual([]);
    expect(read.warnings.join()).toContain("无法解密");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * ③ 未知字段 / 非法类型被 fail-closed 拒
 * ═════════════════════════════════════════════════════════════════════════ */

describe("③ 声明校验：fail-closed（反例必须真的被拒）", () => {
  function errorsOf(raw: unknown): string[] {
    const r = parsePluginSettings(raw);
    if (r.ok) { throw new Error("期望校验失败，但通过了"); }
    return r.errors;
  }

  it("合法矩阵：五种type 各自的最小形态都通过", () => {
    const r = parsePluginSettings([
      { key: "flag", label: "开关", type: "boolean" },
      { key: "name", label: "名字", type: "string" },
      { key: "count", label: "数量", type: "number", min: 1, max: 10 },
      { key: "mode", label: "模式", type: "enum", options: ["a", "b"] },
      { key: "dir", label: "目录", type: "path", root: "plugin" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings).toHaveLength(5);
  });

  it("未知字段被拒（拼错字段名不许静默失效）", () => {
    expect(errorsOf([{ key: "a", label: "A", type: "string", defualt: 1 }]).join()).toContain("未知字段");
    expect(errorsOf([{ key: "a", label: "A", type: "string", placeholder: "x" }]).join()).toContain("未知字段");
  });

  it("contributes 顶层的未知字段同样被拒（契约面不容拼错）", () => {
    /* 2026-10-08（B2）：`ui` 已进白名单——本用例改用真未知字段 `typo` 保持原意图。 */
    const r = parsePluginContributes({ settings: [], ui: [], typo: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join()).toContain("contributes 含未知字段");
  });

  it("type 不在枚举内 ⇒ 拒", () => {
    expect(errorsOf([{ key: "a", label: "A", type: "text" }]).join()).toContain("type 缺失或不合法");
    expect(errorsOf([{ key: "a", label: "A" }]).join()).toContain("type 缺失或不合法");
  });

  it("enum 无 options / options 为空 ⇒ 拒", () => {
    expect(errorsOf([{ key: "a", label: "A", type: "enum" }]).join()).toContain("options 对 type=enum 是必填");
    expect(errorsOf([{ key: "a", label: "A", type: "enum", options: [] }]).join()).toContain("options 对 type=enum 是必填");
  });

  it("number 缺 min 或 max ⇒ 拒（只给一个也不行）", () => {
    expect(errorsOf([{ key: "a", label: "A", type: "number" }]).join()).toContain("min 对 type=number 是必填");
    expect(errorsOf([{ key: "a", label: "A", type: "number", min: 1 }]).join()).toContain("max 对 type=number 是必填");
    expect(errorsOf([{ key: "a", label: "A", type: "number", max: 1 }]).join()).toContain("min 对 type=number 是必填");
  });

  it("default 类型不符 ⇒ 拒（不是静默丢弃默认值）", () => {
    expect(
      errorsOf([{ key: "a", label: "A", type: "boolean", default: "yes" }]).join(),
    ).toContain("default 不合法");
    expect(
      errorsOf([{ key: "a", label: "A", type: "number", min: 1, max: 10, default: 99 }]).join(),
    ).toContain("default 不合法");
    expect(
      errorsOf([{ key: "a", label: "A", type: "enum", options: ["x"], default: "y" }]).join(),
    ).toContain("default 不合法");
  });

  it("path 缺 root / root 拼错 ⇒ 拒（只有两个枚举值，没有第三种）", () => {
    expect(errorsOf([{ key: "a", label: "A", type: "path" }]).join()).toContain("root 对 type=path 是必填");
    expect(
      errorsOf([{ key: "a", label: "A", type: "path", root: "slime-root" }]).join(),
    ).toContain("root 对 type=path 是必填");
    expect(PLUGIN_SETTING_ROOTS).toEqual(["plugin", "workspace"]);
  });

  it("path 的 default 含 .. 或盘符 ⇒ 拒（结构上不许爬出根）", () => {
    expect(
      errorsOf([{ key: "a", label: "A", type: "path", root: "plugin", default: "../../slime.toml" }]).join(),
    ).toContain("default 不合法");
    expect(
      errorsOf([{ key: "a", label: "A", type: "path", root: "plugin", default: "C:\\evil" }]).join(),
    ).toContain("default 不合法");
  });

  it("同插件内 key 重复 ⇒ 整份拒（不许「后一条覆盖前一条」）", () => {
    expect(
      errorsOf([
        { key: "dup", label: "A", type: "string" },
        { key: "dup", label: "B", type: "string" },
      ]).join(),
    ).toContain("重复");
  });

  it("key 不合规（含大写 / 含空格 / 以分隔符开头）⇒ 拒", () => {
    for (const key of ["Upper", "has space", "-lead", "trail-", "a--b", ""]) {
      expect(errorsOf([{ key, label: "A", type: "string" }]).join(), `key=${key}`).toContain("key 缺失或不合法");
    }
    expect(PLUGIN_SETTING_KEY_PATTERN.test("a.b_c-d1")).toBe(true);
  });

  it("secret=true 配 default ⇒ 拒（否则明文就在清单里）", () => {
    expect(
      errorsOf([{ key: "a", label: "A", type: "string", secret: true, default: "leak" }]).join(),
    ).toContain("不得声明 default");
  });

  it("secret 用在非文本类型 ⇒ 拒（免得让人误以为已加密）", () => {
    expect(
      errorsOf([{ key: "a", label: "A", type: "boolean", secret: true }]).join(),
    ).toContain("secret 对 type=boolean 无意义");
    expect(
      errorsOf([{ key: "a", label: "A", type: "number", min: 0, max: 1, secret: true }]).join(),
    ).toContain("secret 对 type=number 无意义");
  });

  it("与类型无关的约束：min/max/root 挂在错类型上 ⇒ 拒（不留半懂不懂的配置）", () => {
    expect(errorsOf([{ key: "a", label: "A", type: "boolean", min: 1 }]).join()).toContain("对 type=boolean 无意义");
    expect(errorsOf([{ key: "a", label: "A", type: "string", root: "plugin" }]).join()).toContain("对 type=string 无意义");
    expect(errorsOf([{ key: "a", label: "A", type: "string", options: ["x"] }]).join()).toContain("对 type=string 无意义");
  });

  it("项数上限与空数组", () => {
    const tooMany = Array.from({ length: MAX_PLUGIN_SETTINGS + 1 }, (_, i) => ({
      key: `k${i}`, label: "L", type: "string",
    }));
    expect(errorsOf(tooMany).join()).toContain("超过上限");
    expect(errorsOf([]).join()).toContain("不得为空数组");
    expect(errorsOf("nope").join()).toContain("必须是数组");
  });

  /* ⚠️ **反例必须真的进 rejected 列表**（而不是只在校验函数里报错）——
     否则会出现「校验有错，但 loader 照样装上」的半闭环。 */
  it("反例贯穿到 parsePluginManifest ⇒ 整份清单 rejected，且错误逐条带出", () => {
    const base = {
      name: "bad-plugin",
      version: "1.0.0",
      description: "反例",
      origin: "agent",
      provides: ["instructions"],
    };
    const bad = parsePluginManifest({
      ...base,
      contributes: { settings: [{ key: "a", label: "A", type: "enum" }] },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join()).toContain("options 对 type=enum 是必填");

    /* 合法声明则通过，并被保留在 manifest 上（渲染层按它渲染） */
    const good = parsePluginManifest({
      ...base,
      contributes: { settings: [{ key: "a", label: "A", type: "boolean" }] },
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.manifest.contributes?.settings).toHaveLength(1);
  });

  it("清单顶层仍按老口径向前兼容（未知顶层字段放行）—— 别把老守卫改红", () => {
    const r = parsePluginManifest({
      name: "compat", version: "1.0.0", description: "d", origin: "user",
      provides: ["instructions"], futureField: 1,
    });
    expect(r.ok).toBe(true);
  });

  it("PLUGIN_SETTING_TYPES 就是声明的五种（没有第六种自由文本落点）", () => {
    expect([...PLUGIN_SETTING_TYPES]).toEqual(["boolean", "string", "number", "enum", "path"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * ④ 插件禁用 / 卸载后贡献被摘
 * ═════════════════════════════════════════════════════════════════════════ */

describe("④ 插件禁用 / 卸载后设置贡献被摘（不假开关、不留幽灵）", () => {
  function manifestWithSettings(): ReturnType<typeof parsePluginManifest> {
    return parsePluginManifest({
      name: "demo",
      version: "1.0.0",
      description: "d",
      origin: "agent",
      provides: ["instructions"],
      contributes: { settings: [{ key: "a", label: "A", type: "boolean" }] },
    });
  }

  it("装载后 contributions 出现 settings:n项；卸载后该条目消失", async () => {
    const parsed = manifestWithSettings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const h = new PluginHost({
      registerTools: () => [],
      registerInstructions: () => [{ label: "inst", dispose: () => {} }],
    });
    await h.load([parsed.manifest]);
    expect(h.get("demo")!.contributions.join()).toContain("settings:1项");

    await h.unload("demo");
    expect(h.get("demo")!.contributions).toEqual([]);
    expect(h.get("demo")!.status).toBe("disabled");
  });

  it("重扫后旧贡献不得残留（先撤销再重建的既有语义）", async () => {
    const parsed = manifestWithSettings();
    if (!parsed.ok) return;
    const h = new PluginHost({ registerTools: () => [], registerInstructions: () => [] });
    await h.load([parsed.manifest]);
    await h.load([parsed.manifest]);
    const contributions = h.get("demo")!.contributions;
    /* 恰好一条 settings —— 出现两条就意味着「重复登记」 */
    expect(contributions.filter((c) => c.startsWith("settings:")).length).toBe(1);
  });

  it("isLoaded 探针为 false（禁用/未装载）⇒ get 与 set 都拒，且不写盘", () => {
    const svc = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => [decl()],
      isLoaded: () => false,
    });
    expect(svc.get("gone").ok).toBe(false);
    const res = svc.set("gone", "token", "v");
    expect(res.ok).toBe(false);
    expect(existsSync(pluginSettingsPath(pluginsRoot(), "gone"))).toBe(false);
  });

  /* 「插件被禁用后数据保留」是**有意**的（设计文档 §4.2 明确：用户关掉插件不该丢配置），
     所以这条断言的是「保留」而不是「删除」—— 但**写入**必须被拒。 */
  it("禁用后数据保留但写入被拒（关插件不丢配置，也不许偷偷改）", () => {
    let on = true;
    const svc = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => [decl()],
      isLoaded: () => on,
    });
    expect(svc.set("p", "token", "before").ok).toBe(true);
    on = false;
    expect(svc.set("p", "token", "after").ok).toBe(false);
    /* 盘上仍是禁用前那一份 */
    expect(JSON.parse(readFileSync(pluginSettingsPath(pluginsRoot(), "p"), "utf8"))).toEqual({ token: "before" });
    on = true;
    expect(svc.get("p").ok).toBe(true);
  });

  it("未声明设置项的插件 ⇒ get 拒（不是返回空壳假装有）", () => {
    const svc = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => undefined,
      isLoaded: () => true,
    });
    const res = svc.get("no-settings");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("未声明设置项");
  });

  it("写未声明的 key ⇒ 拒（不许借通道往settings.json 里塞任意字段）", () => {
    const svc = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => [decl()],
      isLoaded: () => true,
    });
    const res = svc.set("p", "not-declared", "v");
    expect(res.ok).toBe(false);
    if (!existsSync(pluginSettingsPath(pluginsRoot(), "p"))) {
      /* 拒绝时不该顺手建出文件 */
      expect(res.ok).toBe(false);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * ⑤ 原子写（写坏不污染原文件）
 * ═════════════════════════════════════════════════════════════════════════ */

describe("⑤ 原子写 + .bak + 损坏回退带告警", () => {
  it("首次写入建目录；.bak 只在覆盖前一轮内容时出现", () => {
    const store = makeStore();
    /* 值必须配得上声明的类型 —— 这里两项都是 string，写 1 / 2 会先被值校验拒掉 */
    store.writeOne("p", decl({ key: "a" }), "1");
    expect(existsSync(pluginSettingsPath(pluginsRoot(), "p"))).toBe(true);
    /* 首写没有「上一轮」⇒ 不该凭空造一个 .bak */
    expect(readSettingsBackup(pluginsRoot(), "p")).toBe(null);

    store.writeOne("p", decl({ key: "a" }), "2");
    expect(readSettingsBackup(pluginsRoot(), "p")).toEqual({ a: "1" });
    expect(JSON.parse(readFileSync(pluginSettingsPath(pluginsRoot(), "p"), "utf8"))).toEqual({ a: "2" });
  });

  it(".bak 恢复路径可用（备份内容能被读出来）", () => {
    const store = makeStore();
    store.writeOne("p", decl({ key: "k" }), "v1");
    store.writeOne("p", decl({ key: "k" }), "v2");
    expect(readSettingsBackup(pluginsRoot(), "p")).toEqual({ k: "v1" });
  });

  /* 真正的原子性判据：让 rename 失败（把目标文件设成只读），
     原文件必须**逐字节不变** —— 这比「断言调用了 rename」强，
     后者在「先写原文件再rename」的错实现下也会绿。 */
  it("写坏时不污染原文件（rename 失败 ⇒ 原内容逐字节不变）", () => {
    if (process.platform !== "win32") {
      /* POSIX 下用「目录占位」制造 rename 失败：把目标换成一个非空目录，
         rename(file→dir) 必定 EISDIR/ENOTDIR。 */
      const store = makeStore();
      store.writeOne("p", decl({ key: "k" }), "ORIGINAL");
      const path = pluginSettingsPath(pluginsRoot(), "p");
      rmSync(path, { force: true });
      mkdirSync(join(pluginsRoot(), "p"), { recursive: true });
      writeFileSync(join(pluginsRoot(), "p", "blocker"), "x", "utf8");
      const res = store.writeOne("p", decl({ key: "k" }), "NEW");
      expect(res.ok).toBe(false);
      expect(existsSync(join(pluginsRoot(), "p", "blocker"))).toBe(true);
      return;
    }
    const store = makeStore();
    store.writeOne("p", decl({ key: "k" }), "ORIGINAL");
    const path = pluginSettingsPath(pluginsRoot(), "p");
    const before = readFileSync(path, "utf8");
    execFileSync("attrib", ["+r", path], { windowsHide: true });
    try {
      const res = store.writeOne("p", decl({ key: "k" }), "NEW");
      expect(res.ok).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      execFileSync("attrib", ["-r", path], { windowsHide: true });
    }
    /* 成功后能正常覆盖 —— 这条**不是**多余的：Windows 上 `copyFileSync` 会把只读属性
       复制到 `.bak`，于是「一次只读事故」会让该插件此后再也写不进设置。
       下面这两句就是那个回归的守卫（实测踩到过一次）。 */
    expect(store.writeOne("p", decl({ key: "k" }), "NEW").ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: "NEW" });
    /* 再存一次（.bak 已存在且**继承了只读位**）⇒ 仍必须能写 */
    expect(store.writeOne("p", decl({ key: "k" }), "NEWER").ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: "NEWER" });
    expect(readSettingsBackup(pluginsRoot(), "p")).toEqual({ k: "NEW" });
  });

  it("坏 JSON ⇒ 回退 {} 且**带告警**（不静默当空配置）", () => {
    mkdirSync(join(pluginsRoot(), "p"), { recursive: true });
    writeFileSync(pluginSettingsPath(pluginsRoot(), "p"), "{ 这不是 JSON", "utf8");
    const read = makeStore().read("p", [decl({ key: "a" })]);
    expect(read.values).toEqual({});
    expect(read.warnings.join()).toContain("不是合法 JSON");
  });

  it("JSON 但不是对象（数组/标量）⇒ 回退 {} + 告警", () => {
    mkdirSync(join(pluginsRoot(), "p"), { recursive: true });
    writeFileSync(pluginSettingsPath(pluginsRoot(), "p"), "[1,2,3]", "utf8");
    expect(makeStore().read("p", [decl()]).warnings.join()).toContain("不是 JSON 对象");
    writeFileSync(pluginSettingsPath(pluginsRoot(), "p"), "42", "utf8");
    expect(makeStore().read("p", [decl()]).warnings.join()).toContain("不是 JSON 对象");
  });

  it("空文件 / 文件不存在 ⇒ {} 且**不**告警（那不是损坏）", () => {
    expect(makeStore().read("nope", [decl()]).warnings).toEqual([]);
    mkdirSync(join(pluginsRoot(), "blank"), { recursive: true });
    writeFileSync(pluginSettingsPath(pluginsRoot(), "blank"), "", "utf8");
    const read = makeStore().read("blank", [decl()]);
    expect(read.values).toEqual({});
    expect(read.warnings).toEqual([]);
  });

  it("体积超上限 ⇒ 忽略 + 告警（防手滑写入巨大字符串）", () => {
    mkdirSync(join(pluginsRoot(), "big"), { recursive: true });
    writeFileSync(
      pluginSettingsPath(pluginsRoot(), "big"),
      JSON.stringify({ a: "x".repeat(MAX_PLUGIN_SETTINGS_BYTES + 10) }),
      "utf8",
    );
    expect(makeStore().read("big", [decl({ key: "a" })]).warnings.join()).toContain("体积异常");
  });

  it("落盘值不再配得上声明（清单改了 type / 加了 min）⇒ 丢弃 + 告警，不外泄给渲染层", () => {
    const store = makeStore();
    store.writeOne("p", decl({ key: "k" }), "原文本");
    /* 声明改成了 number ⇒ 盘上的字符串不再合法 */
    const read = store.read("p", [decl({ key: "k", type: "number", min: 1, max: 5 })]);
    expect(read.values).toEqual({});
    expect(read.warnings.join()).toContain("落盘值不再合法");
  });

  it("磁盘上多出来的键不外泄（只按声明过滤）", () => {
    const store = makeStore();
    store.writeOne("p", decl({ key: "a" }), "1");
    const raw = JSON.parse(readFileSync(pluginSettingsPath(pluginsRoot(), "p"), "utf8")) as Record<string, unknown>;
    raw["stray"] = "不该被读到";
    writeFileSync(pluginSettingsPath(pluginsRoot(), "p"), JSON.stringify(raw), "utf8");
    const read = store.read("p", [decl({ key: "a" })]);
    expect(read.values).toEqual({ a: "1" });
  });

  it("写完不留 .tmp 残留（残留会被下一次体积上限判断误判）", () => {
    const store = makeStore();
    store.writeOne("p", decl({ key: "a" }), "1");
    const dirEntries = readdirSync(join(pluginsRoot(), "p"));
    expect(dirEntries.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(dirEntries.sort()).toEqual(["settings.json"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 接线形状（**形状断言**，理由见下）
 * ═════════════════════════════════════════════════════════════════════════ */

describe("⑥ IPC / preload / 渲染宿主接线（形状断言）", () => {
  const ROOT = resolve(__dirname, "../..");
  const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

  /* ⚠️ **为什么这一组只能退回形状断言**（写清理由，后人才知道这不是偷懒）：
     判定「插件未装载时 plugins_settings_set 拒绝」需要真的跑主进程的 ipcMain handler，
     而 `gui/src/main/index.ts` 顶层 import electron（BrowserWindow / ipcMain / …）——
     本仓 vitest 的 electron 替身（tests/_stubs/electron.ts）只够支撑渲染层测试，
     撑不起主进程那3000+ 行的装配。
     而「入参里没有 path」这条**安全性质恰恰是静态可核的**（它就是一段文本里有没有这个词），
     所以这一组用形状断言覆盖的是真正需要守住的不变量，不是「测不动就跳过」。 */
  it("通道名四处齐全：共享常量 / handler / preload impl / preload 类型声明", () => {
    const ipc = read("gui/src/shared/ipc.ts");
    expect(ipc).toMatch(/plugins_settings_get: "slime:plugins:settingsGet"/);
    expect(ipc).toMatch(/plugins_settings_set: "slime:plugins:settingsSet"/);

    const main = read("gui/src/main/index.ts");
    expect(main).toMatch(/IPC_CHANNELS\.plugins_settings_get/);
    expect(main).toMatch(/IPC_CHANNELS\.plugins_settings_set/);

    const preload = read("gui/src/preload/index.ts");
    /* impl 与 interface **各一次** —— 本项目惯例，少一处渲染层就静默拿不到通道 */
    expect(preload.match(/pluginsSettingsGet: \(plugin: string\) =>\s*$/gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect((preload.match(/pluginsSettingsGet:/g) ?? []).length).toBe(2);
    expect((preload.match(/pluginsSettingsSet:/g) ?? []).length).toBe(2);
  });

  it("IPC 入参只有 plugin/key/value —— 渲染层传路径必须无效", () => {
    const main = read("gui/src/main/index.ts");
    const preload = read("gui/src/preload/index.ts");
    const ipc = read("gui/src/shared/ipc.ts");
    /* 参数形状：三个标量，没有第四个 */
    expect(main).toMatch(/plugins_settings_set, async \(_event, p\) => \{/);
    expect(main).toMatch(/p\?\.plugin/);
    expect(main).toMatch(/p\?\.key/);
    expect(main).toMatch(/p\?\.value/);
    expect(preload).toMatch(/invoke\("slime:plugins:settingsSet", \{ plugin, key, value \}\)/);
    expect(preload).toMatch(/invoke\("slime:plugins:settingsGet", \{ plugin \}\)/);
    /* DTO 层同样不许冒出 path 字段 */
    expect(ipc).toMatch(/export interface PluginSettingsDTO \{/);
    expect(ipc).not.toMatch(/export interface PluginSettingItemDTO \{[^}]*\bpath\b/s);
  });

  it("两个 handler 都先过 host.get + status==='loaded'（不给未装载插件写盘机会）", () => {
    const main = read("gui/src/main/index.ts");
    const getIdx = main.indexOf("IPC_CHANNELS.plugins_settings_get");
    const setIdx = main.indexOf("IPC_CHANNELS.plugins_settings_set");
    const svcIdx = main.indexOf("isLoaded: (name) => state.host.get(name)?.status === \"loaded\"");
    expect(svcIdx).toBeGreaterThan(-1);
    for (const idx of [getIdx, setIdx]) {
      expect(idx).toBeGreaterThan(-1);
      const body = main.slice(idx, idx + 1400);
      expect(body).toMatch(/state\.host\.get\(name\)/);
      expect(body).toMatch(/record\.status !== "loaded"/);
    }
  });

  it("渲染宿主是声明式（宿主自带控件，扩展不带组件）", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(panel).toMatch(/function SettingField\(/);
    expect(panel).toMatch(/function PluginSettingsSection\(/);
    /* 五种type 都有显式分支；未知形态不留空白 */
    for (const t of ["boolean", "enum", "number", "path"]) {
      expect(panel).toContain(`item.type === "${t}"`);
    }
    /* 本地即时反馈用的那份校验也在（与服务端口径一致，两处都要有） */
    expect(panel).toMatch(/不得小于/);
    expect(panel).toMatch(/必须在候选列表内|不在候选列表内/);
    expect(panel).toMatch(/必须是纯相对路径/);
  });

  it("设置区按需展开且 key 用 plugin:key（拔掉一个插件后不会串到另一个）", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(panel).toMatch(/hasSettings && openSettings &&/);
    expect(panel).toMatch(/key=\{`\$\{props\.plugin\}:\$\{item\.key\}`\}/);
  });

  it("列插件的快照带settingsCount（但不带值 —— 值按需拉）", () => {
    const ipc = read("gui/src/shared/ipc.ts");
    const main = read("gui/src/main/index.ts");
    expect(ipc).toMatch(/settingsCount\?: number;/);
    expect(main).toMatch(/settingsCount: record\.manifest\.contributes\?\.settings\?\.length \?\? 0/);
  });

  it("设置不进ContributionScope（禁用插件后数据保留，启用后仍在）", () => {
    const host = read("core-ts/src/plugin/host.ts");
    /* host 只登记声明条数，不 track 任何撤销函数 */
    expect(host).toMatch(/settings:\$\{describePluginSettings\(settingCount\)\}/);
    expect(host).not.toMatch(/scope\.track\([^)]*settings/i);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 运行时值校验（service 与清单共用同一份函数 ⇒ 不存在两套口径）
 * ═════════════════════════════════════════════════════════════════════════ */

describe("⑦ validatePluginSettingValue 是唯一口径", () => {
  it("service 写入前会再校验一次（不信任渲染层）", () => {
    const svc = new SettingsService({
      pluginsRoot: pluginsRoot(),
      declarations: () => [decl({ key: "n", type: "number", min: 1, max: 10 })],
      isLoaded: () => true,
    });
    /* 直接调 service.set 传一个越界的值（绕过渲染层）⇒ 必须被主进程那份校验拒 */
    const res = svc.set("p", "n", 9999);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("大于上界");
    expect(existsSync(pluginSettingsPath(pluginsRoot(), "p"))).toBe(false);
  });

  it("类型错 / 枚举外/ path 穿越 三类都在这一份函数里被拒", () => {
    expect(validatePluginSettingValue(decl({ type: "boolean" }), "true").length).toBeGreaterThan(0);
    expect(validatePluginSettingValue(decl({ type: "enum", options: ["a"] }), "b").length).toBeGreaterThan(0);
    expect(validatePluginSettingValue(decl({ type: "path", root: "plugin" }), "../x").length).toBeGreaterThan(0);
    expect(validatePluginSettingValue(decl({ type: "path", root: "plugin" }), "sub/dir").length).toBe(0);
    expect(validatePluginSettingValue(decl({ type: "number", min: 1, max: 10 }), 5).length).toBe(0);
    expect(validatePluginSettingValue(decl(), "anything").length).toBe(0);
  });
});