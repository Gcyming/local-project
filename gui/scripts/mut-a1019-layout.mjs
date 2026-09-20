/*
 * 变异测试：A-1019 守卫的**取证**。
 * 每一条打在一个根因上，都必须让对应守卫变红：
 *   · checker=electron → gui/scripts/assert-layout-fit.cjs（真实渲染 + 真实几何）
 *   · checker=vitest   → tests/core-ts/a1019-guards.spec.ts（源码结构关系）
 * 跑完自动还原，并校验还原后的哈希与原文一致。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GUI = "D:/pilot project/gui";
const ROOT = "D:/pilot project";
const CSS = path.join(GUI, "src", "renderer", "index.css");
const MAIN = path.join(GUI, "src", "main", "index.ts");
const APP = path.join(GUI, "src", "renderer", "App.tsx");
const SIDEBAR = path.join(GUI, "src", "renderer", "pages", "RightSidebar.tsx");
const GUARD = path.join(GUI, "scripts", "assert-layout-fit.cjs");
const ELECTRON = path.join(GUI, "node_modules", "electron", "dist", "electron.exe");
const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");

const APP_BLOCK_OK = `.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  min-width: 0;
  overflow-x: auto;
}`;

const variants = [
  {
    name: "① .app 恢复硬地板 1100px（A-1019 原病灶）",
    checker: "electron",
    file: CSS,
    from: APP_BLOCK_OK,
    to: APP_BLOCK_OK.replace("min-width: 0;", "min-width: 1100px;"),
    needsBuild: false,
  },
  {
    name: "② --right-sidebar-w 退回百分比（固有尺寸阶段不可解析）",
    checker: "electron",
    file: CSS,
    from: "--right-sidebar-w: clamp(260px, 21.5vw, 720px);",
    to: "--right-sidebar-w: clamp(260px, 21.5%, 720px);",
    needsBuild: true,
  },
  {
    name: "③ WIN_MIN.width 降到 800（低于三栏地板 880）",
    checker: "electron",
    file: MAIN,
    from: "const WIN_MIN = { width: 900, height: 560 };",
    to: "const WIN_MIN = { width: 800, height: 560 };",
    needsBuild: false,
  },
  {
    name: "④ CSS 比例与 SIDEBAR_RATIO 脱钩（左 17.5 → 20）",
    checker: "vitest",
    file: CSS,
    from: "--sidebar-w: clamp(240px, 17.5vw, 520px);",
    to: "--sidebar-w: clamp(240px, 20vw, 520px);",
    needsBuild: false,
  },
  {
    name: "⑤ TasksTab 第一层可选链去掉（原病灶：整页白屏）",
    checker: "vitest",
    file: SIDEBAR,
    from: "const off1 = api?.chat?.onChunk?.(() => setIsStreaming(true));",
    to: "const off1 = api.chat?.onChunk?.(() => setIsStreaming(true));",
    needsBuild: false,
  },
  {
    name: "⑥ SIDEBAR_RATIO 改动而 CSS 不同步（0.175 → 0.2）",
    checker: "vitest",
    file: APP,
    from: "const SIDEBAR_RATIO = { left: 0.175, right: 0.215 };",
    to: "const SIDEBAR_RATIO = { left: 0.2, right: 0.215 };",
    needsBuild: false,
  },
  {
    name: "⑦ 标题栏 overlay 初值改回写死（启动闪色块）",
    checker: "vitest",
    file: MAIN,
    from: "titleBarOverlay: { ...titleBarColors(readPersistedTheme()), height: 40 },",
    to: 'titleBarOverlay: { color: "#0b101e", symbolColor: "#e6f1ff", height: 40 },',
    needsBuild: false,
  },
];

const before = { css: sha(CSS), main: sha(MAIN), app: sha(APP), sidebar: sha(SIDEBAR) };
const results = [];

function runGuard(checker) {
  const cmd = checker === "electron" ? ELECTRON : process.execPath;
  const args = checker === "electron"
    ? [GUARD]
    : [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "tests/core-ts/a1019-guards.spec.ts"];
  const cwd = checker === "electron" ? GUI : ROOT;
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      timeout: 300000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      encoding: "utf8",
    });
    return { code: 0, text: out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, text: `${e.stdout || ""}\n${e.stderr || ""}` };
  }
}

for (const v of variants) {
  const orig = fs.readFileSync(v.file, "utf8");
  if (!orig.includes(v.from)) { results.push({ name: v.name, error: "变异锚点未命中（脚本失效）" }); continue; }
  fs.writeFileSync(v.file, orig.replace(v.from, v.to), "utf8");

  let buildNote = "";
  if (v.needsBuild) {
    try {
      execFileSync(process.execPath, [path.join(GUI, "node_modules", "electron-vite", "bin", "electron-vite.js"), "build"], {
        cwd: GUI, timeout: 240000, stdio: "pipe",
      });
      buildNote = " [已重建]";
    } catch (e) { buildNote = " [构建失败]"; }
  }

  const r = runGuard(v.checker);
  const reason = (r.text.split("\n").find((l) => l.includes("✗") || l.includes("AssertionError")) || "").trim().slice(0, 160);
  results.push({ name: `${v.name}${buildNote}`, code: r.code, reason, red: r.code !== 0 });

  fs.writeFileSync(v.file, orig, "utf8");
}

const after = { css: sha(CSS), main: sha(MAIN), app: sha(APP), sidebar: sha(SIDEBAR) };
const restored = after.css === before.css && after.main === before.main && after.app === before.app && after.sidebar === before.sidebar;

let rebuildOk = true;
try {
  execFileSync(process.execPath, [path.join(GUI, "node_modules", "electron-vite", "bin", "electron-vite.js"), "build"], {
    cwd: GUI, timeout: 240000, stdio: "pipe",
  });
} catch (e) { rebuildOk = false; }

console.log("\n================ 变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 四文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`还原后重建: ${rebuildOk ? "✓" : "✗ 失败"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
