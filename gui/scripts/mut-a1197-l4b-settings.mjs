#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-l4b-settings.mjs — 「L4b 设置贡献点」的变异验证。
 *
 * ## 这一轮改的是什么
 * 让插件能在自己的目录里**声明并持久化设置项**，且**不污染主配置**：
 * 落点固定 `config/plugins/<插件名>/settings.json`（密文项落 `settings.enc.json`），
 * 路径**只由 `plugin.name` 推导**，渲染层传的一律无效。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 路径推导的 assert 放行任意名字 | 伪造 `../..` / 盘符 ⇒ 设置写到插件根之外 | ① 七个反例逐个抛错 |
 * | 2 | 路径推导绕过插件名校验 | 伪造 `../..` 拼出根外路径 | ① 七个反例逐个抛错 |
 * | 2b | `.bak` 覆盖前不清只读位 | 一次只读事故后该插件再也写不进设置 | ⑤ 只读后连写两次 |
 * | 3 | 声明项校验不再 fail-closed | 非法声明项被静默忽略 ⇒「配了不生效」的假自由度 | ③ 反例矩阵 |
 * | 4 | 清单不挂 `parsePluginContributes` | 声明非法也照样装载（校验形同虚设） | ③ 反例贯穿到 manifest |
 * | 5 | secret 项也写进明文文件 | 「加密」只剩图标，明文仍在盘上 | ② 明文里搜不到 canary |
 * | 6 | 读回时把 secret 项当普通项填value | 明文跨过主进程边界进渲染层 | ② DTO 上没有 value 键 |
 * | 7 | 写入前不再做值校验 | 渲染层传越界值就写进盘 | ⑦ 主进程那份校验 |
 * | 8 | `set` 去掉未装载前置检查 | 已禁用 / 未装载的插件照样能改设置 | ④ 探针为 false 时读写皆拒 |
 * | 9 | host 不再登记 settings 贡献 | 声明了设置项但扩展页看不出它真生效 | ④ contributions 里有 settings |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 锚点三原则：**不跨注释行**（本仓源码被系统性剥离过注释）、**不依赖注释文本**、**锚代码行**。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-l4b-settings.mjs`
 * ⚠️ 注释里**不放反引号**（核验器的 STR 扫描器会被它截断）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-l4b-settings.spec.ts",
];

const STORE = "core-ts/src/plugin/settings-store.ts";
const CONTRIB = "core-ts/src/plugin/contributes.ts";
const MANIFEST = "core-ts/src/plugin/manifest.ts";
const HOST = "core-ts/src/plugin/host.ts";
const SERVICE = "core-ts/src/plugin/settings-service.ts";
const TARGETS = [STORE, CONTRIB, MANIFEST, HOST, SERVICE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-l4b-settings");

const MUTATIONS = [
  /* ── ① 路径只由插件名推导（安全边界）────────────────────────────── */
  {
    name: "1 路径推导的 assert 放行任意名字（伪造 ../.. 写到根外）",
    file: STORE,
    mutate: (t) => sub(
      t,
      "  if (!isPluginName(raw)) {",
      "  if (false) {",
    ),
  },
  {
    /* ⚠️ **这一条换过两次**，两次存活都不是守卫漏了，写清以免下一个人再「发现」一次：
       ① 原版：删掉 `normalized` 那第二重防线 —— **等价变异体**。
          `isPluginName` 的模式 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 在数学上不可能放行含
          `/`、`\`、`..` 的名字（穷举验证：0 个反例通过）⇒ 那段是不可达代码。
       ② 第二版：把「落在插件根之内」判定改成恒真 —— **也是等价变异体**。
          凡是不抛错的名字，`join(root, name, file)` 必然落在根内（name 无分隔符），
          于是「是否在根内」恒真。该恒真判定已连同其函数一起**删除**（它只被测试引用、
          生产侧零引用 —— 留着就是给「恒真当守卫」留机会）。
       ⇒ 现在换成真正承重的一条：**路径推导绕过插件名校验**。 */
    name: "2 路径推导绕过插件名校验（伪造 ../.. 直接拼出根外路径）",
    file: STORE,
    mutate: (t) => sub(
      t,
      "export function pluginSettingsPath(pluginsRoot: string, pluginName: string): string {\n  const safe = assertSafePluginName(pluginName);\n  return join(pluginsRoot, safe, PLUGIN_SETTINGS_FILENAME);\n}",
      "export function pluginSettingsPath(pluginsRoot: string, pluginName: string): string {\n  return join(pluginsRoot, pluginName, PLUGIN_SETTINGS_FILENAME);\n}",
    ),
  },
  {
    name: "2b .bak 覆盖前不清只读位（一次只读事故后该插件再也写不进设置）",
    file: STORE,
    mutate: (t) => sub(
      t,
      "    chmodSync(bak, 0o666);\n    copyFileSync(path, bak);",
      "    copyFileSync(path, bak);",
    ),
  },
  /* ── ② fail-closed 校验 ─────────────────────────────────────────── */
  {
    name: "3 声明校验不再 fail-closed（非法声明项被静默忽略）",
    file: CONTRIB,
    mutate: (t) => sub(
      t,
      "  if (errors.length > 0) {\n    return { ok: false, errors };\n  }\n  return { ok: true, decl };",
      "  if (errors.length > 0) {\n    return { ok: true, decl };\n  }\n  return { ok: true, decl };",
    ),
  },
  {
    name: "4 清单不挂 parsePluginContributes（声明非法也照样装载）",
    file: MANIFEST,
    mutate: (t) => sub(
      t,
      "    const parsedContributes = parsePluginContributes(contributesRaw);",
      "    const parsedContributes = { ok: true, contributes: { settings: [] as never } };",
    ),
  },
  /* ── ③ secret：不明文落盘、读回只给 hasValue ────────────────────── */
  {
    name: "5 secret 项也写进明文文件（加密只剩图标）",
    file: STORE,
    mutate: (t) => sub(
      t,
      "      current[decl.key] = value;\n      try {\n        mkdirSync(dirname(encPath), { recursive: true });",
      "      current[decl.key] = value;\n      const leak = pluginSettingsPath(this.pluginsRoot, pluginName);\n      mkdirSync(dirname(leak), { recursive: true });\n      writeFileSync(leak, JSON.stringify({ [decl.key]: value }), \"utf8\");\n      try {\n        mkdirSync(dirname(encPath), { recursive: true });",
    ),
  },
  {
    name: "6 读回时把 secret 项当普通项处理（明文跨过主进程边界）",
    file: SERVICE,
    mutate: (t) => sub(
      t,
      "    if (decl.secret === true) {\n      item.hasValue = secretSet.has(decl.key);",
      "    if (decl.secret === true) {\n      item.value = secretSet.has(decl.key) ? \"<密文已存在>\" : undefined;\n      item.hasValue = secretSet.has(decl.key);",
    ),
  },
  /* ── ④ 不信任渲染层 / 未装载拒写 ────────────────────────────────── */
  {
    name: "7 写入前不再做值校验（渲染层传越界值就写进盘）",
    file: STORE,
    mutate: (t) => sub(
      t,
      "    const valueErrors = validatePluginSettingValue(decl, value);\n    if (valueErrors.length > 0) {\n      return { ok: false, error: valueErrors.join(\"；\") };\n    }",
      "    const valueErrors: string[] = [];\n    if (valueErrors.length > 0) {\n      return { ok: false, error: valueErrors.join(\"；\") };\n    }",
    ),
  },
  {
    name: "8 set 不再做未装载前置检查（已禁用的插件照样能改设置）",
    file: SERVICE,
    mutate: (t) => sub(
      t,
      "    if (!this.isLoaded(pluginName)) {\n      return { ok: false, error: `插件未装载或已停用：${pluginName}` };\n    }\n    const decls = this.declarations(pluginName) ?? [];",
      "    if (!this.isLoaded(pluginName) && false) {\n      return { ok: false, error: `插件未装载或已停用：${pluginName}` };\n    }\n    const decls = this.declarations(pluginName) ?? [];",
    ),
  },
  /* ── ⑤ 贡献可被看见 ─────────────────────────────────────────────── */
  {
    name: "9 host 不再登记 settings 贡献（声明了却看不出真生效）",
    file: HOST,
    mutate: (t) => sub(
      t,
      "      contributions.push(`settings:${describePluginSettings(settingCount)}`);",
      "      void settingCount;",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1197-l4b-settings")) { process.exit(1); }

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  if (!existsSync(backup)) {
    console.error(`❌ 备份缺失（${backup}）—— 无法自动还原 ${man.file}，请用 git 恢复该文件。`);
    process.exit(1);
  }
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-l4b-settings.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);