/**
 * tests/core-ts/a1200-plugin-seed-upgrade.spec.ts — A-1200 · B4「随包示例的版本感知升级」守卫。
 *
 * ## 缺陷现场（用户实测截图发现，是「改了但用户看不见」的静默失效）
 * 官方示例扩展加了贡献点（多皮肤 / CSS 外观 / 栏目），但**界面上一律看不见** ——
 * 因为数据根里的示例还是旧版，而 `seedDefaultDirs` **从不比对内容**
 * （只看「台账有名字」或「目录已存在」就跳过）⇒ 随包示例改版后老用户永远停在旧版。
 *
 * ## 本组守卫钉住的四条不变量（少任一条都会退回原缺陷或造成数据事故）
 *   ① **能升级**：目录在 + 模板版本更高 ⇒ 内容更新（否则新能力永远到不了用户）；
 *   ② **保用户数据**：升级只覆盖模板里有的文件，`settings.json` / `trust.json` 等原样保留
 *      （丢了就是数据事故）；
 *   ③ **fail-closed**：备份失败 ⇒ 不升级（宁可停旧版，也不做不可逆覆盖）；
 *   ④ **既有语义不许破坏**：不覆盖用户自建目录、用户删过的不复活、同版本幂等。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { comparePluginVersions, seedDefaultDirs, seedOrUpgradeDirs } from "../../gui/src/main/skill_seed.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let sandbox: string | null = null;
let seedDir = "";
let pluginsDir = "";
let backupRoot = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "slime-plugin-seed-"));
  seedDir = join(sandbox, "template", "plugins");
  pluginsDir = join(sandbox, "config", "plugins");
  backupRoot = join(sandbox, "config", "plugins-backup");
  mkdirSync(seedDir, { recursive: true });
});
afterEach(() => {
  if (sandbox !== null) { rmSync(sandbox, { recursive: true, force: true }); sandbox = null; }
});

/* ── 夹具：一个「插件」（含 plugin.json 版本 + 一个内容文件）─────────────── */
function writePlugin(base: string, name: string, version: string, body = ""): void {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), `${JSON.stringify({ name, version }, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "content.txt"), `${body || `v${version} 的内容`}\n`, "utf8");
}
function readContent(base: string, name: string): string {
  return readFileSync(join(base, name, "content.txt"), "utf8");
}
function setManifest(entries: unknown): void {
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, ".seed-manifest.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

describe("A-1200 · B4 ① 版本感知升级：让老用户拿到新版（正面能力）", () => {
  it("目录在 + 模板版本更高 ⇒ 内容被更新到新版，且返回升级记录", () => {
    writePlugin(seedDir, "demo", "1.1.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest(["demo"]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(readContent(pluginsDir, "demo")).toContain("v1.1.0");
    expect(res.upgraded).toHaveLength(1);
    expect(res.upgraded[0]).toMatchObject({ name: "demo", from: "1.0.0", to: "1.1.0" });
  });

  it("⚠️ 语义化比较：1.10.0 > 1.9.0（字符串比较会把新版本判成更旧）", () => {
    /* 直接钉比较函数本身 —— 这是「新版本永远升不上去」的根因位。 */
    expect(comparePluginVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(comparePluginVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(comparePluginVersions("1.0.0", "1.0.0")).toBe(0);

    /* 端到端也跑一遍：1.9.0 → 1.10.0 必须真的升上去。 */
    writePlugin(seedDir, "demo", "1.10.0");
    writePlugin(pluginsDir, "demo", "1.9.0");
    setManifest([{ name: "demo", version: "1.9.0" }]);
    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });
    expect(res.upgraded.map((u) => u.to)).toEqual(["1.10.0"]);
    expect(readContent(pluginsDir, "demo")).toContain("v1.10.0");
  });

  it("⚠️ 只升不降：模板版本更低或相同 ⇒ 一个字节都不动", () => {
    writePlugin(seedDir, "demo", "1.0.0");
    writePlugin(pluginsDir, "demo", "1.2.0", "用户手上的新版本");
    setManifest([{ name: "demo", version: "1.2.0" }]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.upgraded).toEqual([]);
    expect(readContent(pluginsDir, "demo")).toBe("用户手上的新版本\n");
  });
});

describe("A-1200 · B4 ② 保用户数据：升级不碰模板没有的文件", () => {
  it("settings.json / trust.json 在升级后原样保留（内容与存在性）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    /* 用户数据：模板里没有的文件 */
    writeFileSync(join(pluginsDir, "demo", "settings.json"), '{"greeting":"你好"}\n', "utf8");
    writeFileSync(join(pluginsDir, "demo", "trust.json"), '{"trusted":true}\n', "utf8");
    writeFileSync(join(pluginsDir, "demo", "settings.json.bak"), '{"greeting":"旧"}\n', "utf8");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(readFileSync(join(pluginsDir, "demo", "settings.json"), "utf8")).toBe('{"greeting":"你好"}\n');
    expect(readFileSync(join(pluginsDir, "demo", "trust.json"), "utf8")).toBe('{"trusted":true}\n');
    expect(readFileSync(join(pluginsDir, "demo", "settings.json.bak"), "utf8")).toBe('{"greeting":"旧"}\n');
    /* 同时确认升级真的发生了（否则"保留"是空谈） */
    expect(readContent(pluginsDir, "demo")).toContain("v2.0.0");
  });

  it("模板里**没有**的文件不受升级影响（即使名字不在任何白名单里）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    writeFileSync(join(pluginsDir, "demo", "用户自己加的笔记.md"), "别删我\n", "utf8");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(readFileSync(join(pluginsDir, "demo", "用户自己加的笔记.md"), "utf8")).toBe("别删我\n");
  });

  it("模板的**子目录**也会更新，且子目录里的用户数据同样保留", () => {
    const seedSub = join(seedDir, "demo", "skills", "guide");
    mkdirSync(seedSub, { recursive: true });
    writeFileSync(join(seedSub, "SKILL.md"), "新版正文\n", "utf8");
    writePlugin(seedDir, "demo", "2.0.0");

    const userSub = join(pluginsDir, "demo", "skills", "guide");
    mkdirSync(userSub, { recursive: true });
    writeFileSync(join(userSub, "SKILL.md"), "旧版正文\n", "utf8");
    writeFileSync(join(userSub, "用户批注.md"), "我的批注\n", "utf8");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(readFileSync(join(userSub, "SKILL.md"), "utf8")).toBe("新版正文\n");
    expect(readFileSync(join(userSub, "用户批注.md"), "utf8")).toBe("我的批注\n");
  });
});

describe("A-1200 · B4 ③ fail-closed：备份是升级的前置条件", () => {
  it("升级前一定留下备份（备份目录里是**旧版**内容）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.upgraded).toHaveLength(1);
    const backup = res.upgraded[0]!.backup;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(join(backup, "content.txt"), "utf8")).toContain("v1.0.0");   // 备份里是旧版
    expect(readdirSync(backupRoot).length).toBeGreaterThan(0);
  });

  it("⚠️ 未给备份根 ⇒ **不升级**（没有回滚点的覆盖是禁止项）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir);      // 不传 backupRoot

    expect(res.upgraded).toEqual([]);
    expect(readContent(pluginsDir, "demo")).toContain("v1.0.0");   // 原样
  });

  it("⚠️ 备份根不可写 ⇒ 不升级（内容保持旧版，一处都没动）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);
    /* 把"备份根"做成一个**文件**：mkdirSync 必然失败 ⇒ 备份失败 ⇒ 必须放弃升级。 */
    writeFileSync(backupRoot, "我不是目录\n", "utf8");

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.upgraded).toEqual([]);
    expect(readContent(pluginsDir, "demo")).toContain("v1.0.0");
  });
});

describe("A-1200 · B4 ④ 既有语义不许被破坏（不覆盖 / 不复活 / 幂等 / 向后兼容）", () => {
  it("用户自建同名目录（台账没有 + 目录在）⇒ 永不认领、永不升级", () => {
    writePlugin(seedDir, "demo", "9.9.9");
    writePlugin(pluginsDir, "demo", "0.0.1", "用户自己写的");
    setManifest([]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.seeded).toEqual([]);
    expect(res.upgraded).toEqual([]);
    expect(readContent(pluginsDir, "demo")).toBe("用户自己写的\n");
  });

  it("用户删过的（台账有 + 目录无）⇒ 不复活（连播种都不做）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.seeded).toEqual([]);
    expect(res.upgraded).toEqual([]);
    expect(existsSync(join(pluginsDir, "demo"))).toBe(false);
  });

  it("同版本幂等：连跑两次，第二次没有任何变化", () => {
    writePlugin(seedDir, "demo", "1.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    expect(seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot }).upgraded).toEqual([]);
    expect(seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot }).upgraded).toEqual([]);
  });

  it("⚠️ 向后兼容：老台账格式（字符串数组）能读且**仍能升级** —— 这正是老用户的情形", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest(["demo"]);            // 老格式：只有名字，没有版本

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    /* ⚠️ 老台账**不该**挡住升级：已装版本从目标目录的 plugin.json 读（那才是真相源），
       不是从台账读。老用户机器上正是「台账 ["hello-slime"] + plugin.json 1.0.0」——
       若这里判「版本未知 ⇒ 不升级」，本次修复对老用户就整个失效了。 */
    expect(res.upgraded.map((u) => [u.from, u.to])).toEqual([["1.0.0", "2.0.0"]]);
    expect(readContent(pluginsDir, "demo")).toContain("v2.0.0");
  });

  it("⚠️ 版本真读不到（目标目录没有版本字段）⇒ 不升级（没有依据就别动用户目录）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    /* 目标目录的 plugin.json 缺 version 字段 */
    mkdirSync(join(pluginsDir, "demo"), { recursive: true });
    writeFileSync(join(pluginsDir, "demo", "plugin.json"), '{ "name": "demo" }\n', "utf8");
    writeFileSync(join(pluginsDir, "demo", "content.txt"), "旧\n", "utf8");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.upgraded).toEqual([]);
    expect(readFileSync(join(pluginsDir, "demo", "content.txt"), "utf8")).toBe("旧\n");
  });

  it("首次播种照旧：台账无 + 目录无 ⇒ 复制整目录并返回名字", () => {
    writePlugin(seedDir, "demo", "1.0.0");

    const res = seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    expect(res.seeded).toEqual(["demo"]);
    expect(res.upgraded).toEqual([]);
    expect(readContent(pluginsDir, "demo")).toContain("v1.0.0");
  });

  it("seedDefaultDirs 仍是「只返回名字」的窄接口（技能播种的调用点不受影响）", () => {
    writePlugin(seedDir, "demo", "1.0.0");
    expect(seedDefaultDirs(seedDir, pluginsDir, { backupRoot })).toEqual(["demo"]);
  });

  it("升级后台账记下**新版本**（否则下次启动会重复升级）", () => {
    writePlugin(seedDir, "demo", "2.0.0");
    writePlugin(pluginsDir, "demo", "1.0.0");
    setManifest([{ name: "demo", version: "1.0.0" }]);

    seedOrUpgradeDirs(seedDir, pluginsDir, { backupRoot });

    const manifest = JSON.parse(readFileSync(join(pluginsDir, ".seed-manifest.json"), "utf8")) as Array<{ name: string; version: string }>;
    expect(manifest).toEqual([{ name: "demo", version: "2.0.0" }]);
  });
});

describe("A-1200 · B4 ⑤ 接线锁：主进程真的接上了（行为正确但没接线 = 用户还是看不见）", () => {
  const MAIN = readFileSync(join(ROOT, "gui/src/main/index.ts"), "utf8");
  const BOOT = readFileSync(join(ROOT, "gui/src/main/boot.ts"), "utf8");

  it("启动播种走的是**升级版**接口，且**同一次调用里**带备份根", () => {
    /* ⚠️ 判据要**咬在同一次调用上**：只断言 BOOT 里出现过 backupRoot 是不够的 ——
       函数上方那行 `const backupRoot = join(...)` 就能把它喂饱，
       而真正的调用若退化成 `seedOrUpgradeDirs(seedDir, target)`（不带备份根），
       升级会被 skill_seed 的 fail-closed 直接跳过 ⇒ 老用户永远升不上去（本批整体失效）。
       变异实测（M12 首轮存活）就是这么暴露出来的。 */
    expect(BOOT).toMatch(/seedOrUpgradeDirs\(\s*seedDir,\s*target,\s*\{\s*backupRoot\s*\}\s*\)/);
    /* 升级结果要能传到界面（不许静默升级） */
    expect(BOOT).toMatch(/takeSeedUpgrades/);
  });

  it("扩展页「安装示例扩展」按钮已存在时走升级路径（不再直接报「不覆盖」）", () => {
    const seg = /plugins_install_example[\s\S]*?\n  \}\);/.exec(MAIN);
    expect(seg).not.toBeNull();
    /* ⚠️ 两条都要咬死（M13 首轮存活暴露的缺口）：
       ① 调用了升级实现；② **没有**「已存在就早退」的旧分支 ——
       只断言 ① 的话，那个早退分支还在（用户点按钮照样吃「不覆盖」），
       而 `seedOrUpgradeDirs(` 仍出现在它下面的死代码里 ⇒ 判据被喂饱、假绿。 */
    expect(seg![0]).toMatch(/seedOrUpgradeDirs\(/);
    expect(seg![0]).not.toMatch(/已存在同名扩展目录，不覆盖/);
    /* 必须复用同一套实现（不许在主进程里另写一份覆盖逻辑） */
    expect(seg![0]).not.toMatch(/cpSync\(/);
  });

  it("快照带出升级记录与版本对照（扩展页据此如实告知 + 按钮文案）", () => {
    expect(MAIN).toMatch(/takeSeedUpgrades\(\)/);
    expect(MAIN).toMatch(/examplePluginStatus\(\)/);
    expect(MAIN).toMatch(/canUpgrade:/);
  });

  it("⚠️ 模板版本必须高于已装版本，否则本次修复对老用户无效", () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, "gui/template/plugins/hello-slime/plugin.json"), "utf8")) as { version: string };
    /* 老用户机器上是 1.0.0（B1/B2/B3 之前播种的）⇒ 模板必须严格更高才会触发升级。 */
    expect(comparePluginVersions(tpl.version, "1.0.0")).toBeGreaterThan(0);
  });
});
