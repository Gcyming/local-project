#!/usr/bin/env node
/**
 * mut-a1198-ui-slot.mjs — A-1197 · B2（L4a UI 贡献点）的变异验证。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | M1 | 登记被删（set 不落表） | 声明了槽位却永远「尚未接线」（假自由度） | a1198-ui-slot ③ |
 * | M2 | 渲染层改成增量合并（只加不减） | 插件卸载后旧槽位残留（A-1195 泄漏形态复活） | a1198-ui-slot ① |
 * | M3 | 冲突项不标 `conflict` | 跨插件冲突被静默当正常渲染（用户看到两个同名项） | a1198-ui-slot ③ |
 * | M4 | 撤销不再移表（dispose 空实现） | 卸载后槽位仍在表里 ⇒ 幽灵槽位 | a1198-ui-slot ③ / plugin-host 用例 |
 * | M5 | toolbar_item 从白名单被删 | B5 槽位声明被拒（按钮永远出不来） | a1198-contributes 反例 |
 * | M6 | 沙箱 iframe 去掉 sandbox | 隔离破：扩展页能碰宿主文档 | a1198-plugin-page ② |
 * | M7 | 交叉校验被删（toolbar 无 page 放行） | 假按钮：点了没东西可开 | a1198-contributes/plugin-page ③ |
 * | M8 | 卸载不 stop 页面服务 | http 服务泄漏 | a1198-plugin-page ① |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-ui-slot.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1198-contributes.spec.ts",
  "tests/core-ts/a1198-ui-slot.spec.ts",
  "tests/core-ts/a1198-plugin-page.spec.ts",
  "tests/core-ts/plugin-host.spec.ts",
];

const F_SLOT_HOST = "gui/src/renderer/components/UiSlotHost.tsx";
const F_MAIN = "gui/src/main/index.ts";
const F_CONTRIBUTES = "core-ts/src/plugin/contributes.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const TARGETS = [F_SLOT_HOST, F_MAIN, F_CONTRIBUTES, F_SIDEBAR];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198");

const MUTATIONS = [
  {
    name: "M1 登记被删（声明了槽位却永远「尚未接线」——假自由度）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      pluginUiDecls.set(manifest.name, ui);",
      "      /* 忘记登记：声明永远进不了表 */",
    ),
  },
  {
    name: "M2 渲染层改成增量合并（只加不减：卸载后旧槽位残留）",
    file: F_SLOT_HOST,
    mutate: (t) => sub(
      t,
      "      if (alive) { setSlots(Array.isArray(res?.slots) ? (res as { slots: PluginUiSlotDTO[] }).slots : []); }",
      "      if (alive) {\n        const incoming = Array.isArray(res?.slots) ? (res as { slots: PluginUiSlotDTO[] }).slots : [];\n        setSlots((prev) => {\n          const have = new Set(prev.map((s) => `${s.plugin}::${s.slot}::${s.id}`));\n          return [...prev, ...incoming.filter((s) => !have.has(`${s.plugin}::${s.slot}::${s.id}`))];\n        });\n      }",
    ),
  },
  {
    name: "M3 冲突项不标 conflict（跨插件冲突被静默当正常渲染）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    sorted.forEach((r, i) => { out.push(i === 0 ? r : { ...r, conflict: true }); });",
      "    sorted.forEach((r) => { out.push(r); });",
    ),
  },
  {
    name: "M4 撤销不再移表（卸载后槽位仍在表里 ⇒ 幽灵槽位）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "          dispose: () => {\n            if (pluginUiDecls.get(manifest.name) === ui) {\n              pluginUiDecls.delete(manifest.name);\n            }\n          },",
      "          dispose: () => {\n            void ui;\n          },",
    ),
  },
  {
    name: "M5 toolbar_item 从白名单被删（B5 槽位声明被拒 ⇒ 按钮永远出不来）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "export const PLUGIN_UI_SLOTS = [\"settings_panel\", \"status_item\", \"chat_action\", \"toolbar_item\"] as const;",
      "export const PLUGIN_UI_SLOTS = [\"settings_panel\", \"status_item\", \"chat_action\"] as const;",
    ),
  },
  /* ── 2026-10-08 · B5：page / toolbar_item ───────────────────────── */
  {
    name: "M6 沙箱 iframe 去掉 sandbox 属性（隔离破：扩展页能碰宿主文档）",
    file: F_SIDEBAR,
    mutate: (t) => sub(
      t,
      "        sandbox=\"allow-scripts allow-same-origin allow-forms\"\n",
      "",
    ),
  },
  {
    name: "M7 交叉校验被删：toolbar_item 无 page 也放行（假按钮）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "  if ((out.ui ?? []).some((u) => u.slot === \"toolbar_item\") && out.page === undefined) {\n    errors.push(\"contributes.ui 含 toolbar_item 但缺少 contributes.page：该槽位的唯一用途是打开扩展自己的页面，没有 page 就是假按钮\");\n  }\n",
      "",
    ),
  },
  {
    name: "M8 卸载不 stop 页面服务（http 服务泄漏）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "                  const r = await httpServer.stop(e.id);\n                  if (!r.ok) {\n                    console.error(`[gui:plugins] 插件页面服务 stop 失败（${manifest.name} / ${e.id}）：${r.error ?? \"未知原因\"}`);\n                  }",
      "                  void e;",
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
if (reportEolProblems(eolFound, "mut-a1198-ui-slot")) { process.exit(1); }

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

console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-ui-slot.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);
