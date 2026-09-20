/*
 * 变异测试：A-1020 守卫的**取证**。
 *
 * 打点全部落在"同一 IPC channel 注册两次会让整个 app 打不开"这条根因上。
 * 每条都必须让 tests/core-ts/a1020-guards.spec.ts **变红**；
 * 另有一条是**反假阳**检查（把 channel 名只写进注释 → 守卫必须保持**绿**），
 * 因为守卫扫源码最容易犯的错就是被注释里的示例骗到。
 *
 * 跑完自动还原，并校验还原后的哈希与原文一致。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const MAIN = path.join(ROOT, "gui", "src", "main", "index.ts");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SPEC = "tests/core-ts/a1020-guards.spec.ts";
const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");

const NEW_HANDLER = `  handleTrusted<{ theme: string }>("slime:theme:set", (_event, p) => {
    writePersistedTheme(p.theme);
    mainWindow?.setTitleBarOverlay({ ...titleBarColors(p.theme), height: 40 });
  });`;

const variants = [
  {
    name: "① 复现原病灶：slime:theme:set 二次注册（+1 行）",
    expect: "red",
    from: NEW_HANDLER,
    to: `${NEW_HANDLER}\n  handleTrusted<{ theme: string }>("slime:theme:set", () => {});`,
  },
  {
    name: "② 另一个 channel 重复注册（slime:git:diff，走 ipcMain.handle 形式）",
    expect: "red",
    from: NEW_HANDLER,
    to: `${NEW_HANDLER}\n  ipcMain.handle("slime:git:diff", () => {});`,
  },
  {
    name: "③ 去掉运行期去重（REGISTERED_CHANNELS 的 has 判定）",
    expect: "red",
    from: "  if (REGISTERED_CHANNELS.has(channel)) {",
    to: "  if (false) {",
  },
  {
    name: "④ 去掉 removeHandler（重复时不再摘旧的，直接让 ipcMain 抛）",
    expect: "red",
    from: "      ipcMain.removeHandler(channel);",
    to: "      void 0;",
  },
  {
    name: "⑤ 静默覆盖：去掉重复注册时那条 console.error（catch 块里那个不许顶包）",
    expect: "red",
    from: '    console.error(\n      `[gui:main] ⚠️ IPC channel 重复注册: "${channel}" —— 旧的 handler 已被覆盖。` +',
    to: '    void (\n      `[gui:main] ⚠️ IPC channel 重复注册: "${channel}" —— 旧的 handler 已被覆盖。` +',
  },
  {
    name: "⑥ 去重表被删（守卫②应拦住）",
    expect: "red",
    from: "const REGISTERED_CHANNELS = new Set<string>();",
    to: "const REGISTERED_CHANNELS_PLACEHOLDER = new Set<string>();",
  },
  {
    name: "⑦ 反假阳：channel 名只出现在注释里（守卫必须保持**绿**）",
    expect: "green",
    from: NEW_HANDLER,
    to: `  // 曾经的写法：handleTrusted<{ theme: string }>("slime:theme:set", (_e, p) => {});\n${NEW_HANDLER}`,
  },
];

const before = sha(MAIN);
const results = [];

for (const v of variants) {
  const orig = fs.readFileSync(MAIN, "utf8");
  if (!orig.includes(v.from)) { results.push({ name: v.name, error: "变异锚点未命中（脚本失效）" }); continue; }
  fs.writeFileSync(MAIN, orig.replace(v.from, v.to), "utf8");

  let code = 0;
  let text = "";
  try {
    text = execFileSync(process.execPath, [VITEST, "run", SPEC], { cwd: ROOT, timeout: 180000, encoding: "utf8" });
  } catch (e) {
    code = e.status === undefined ? -1 : e.status;
    text = `${e.stdout || ""}\n${e.stderr || ""}`;
  }

  const isRed = code !== 0;
  const ok = v.expect === "red" ? isRed : !isRed;
  const reason = (text.split("\n").find((l) => l.includes("AssertionError") || l.includes("重复注册的 IPC")) || "").trim().slice(0, 150);
  results.push({ name: v.name, code, ok, reason });

  fs.writeFileSync(MAIN, orig, "utf8");
}

const restored = sha(MAIN) === before;

console.log("\n============ A-1020 变异测试结果 ============");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.ok ? "✓ 符合预期" : "✗ 不符合预期（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ index.ts 哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部符合预期: ${results.every((r) => r.ok) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.ok) && restored ? 0 : 1);
