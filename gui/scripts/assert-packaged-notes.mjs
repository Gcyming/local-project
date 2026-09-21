#!/usr/bin/env node
/**
 * gui/scripts/assert-packaged-notes.mjs — 打包产物里**到底有没有**「更新说明结构化渲染」。
 *
 * **为什么需要这个脚本**（v0.0.4 实测的假通过）：
 * 更新说明的显示缺陷有**两层**成因，而且它们的验收方式完全不同 ——
 *   ① 渲染层代码缺陷（A-1037）：源码修好、守卫变红、变异全捕获 —— 全绿；
 *   ② 但**你装的那个包**是修好之前打的（`app.asar` 里根本没有新代码），于是用户照样看到标签源码。
 * 也就是说：源码层的判据再严，也证明不了「这个 .exe 里有这个修复」。
 * 这个脚本补的就是 ② —— 直接对打包出来的 `app.asar` 做内容断言。
 *
 * 用法：
 *   node gui/scripts/assert-packaged-notes.mjs                    # 自动找最新的 release-v* 包
 *   node gui/scripts/assert-packaged-notes.mjs --asar <path>      # 指定 app.asar
 *
 * 退出码：0 = 命中全部标记；1 = 有缺失（把缺的标记逐条打出来，不静默）
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUI = join(ROOT, "gui");

/**
 * 必须出现在打包产物里的中文标记。
 * ⚠️ 选**中文字面量**而不是变量名 / 函数名：压缩器不会改中文，而标识符会被改名。
 * ⚠️ 每条都要是「只有这个修复才会引入」的字面量，否则守卫会锁到别的东西上。
 */
const REQUIRED = [
  { marker: "收起更新说明", why: "A-1037：更新说明改为结构化渲染（折叠开关文案）" },
  { marker: "查看更新说明", why: "A-1037：按需展开的入口文案" },
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** 不带参数时：挑修改时间最新的 release 目录里的 win-unpacked/resources/app.asar */
function autoAsar() {
  const dirs = readdirSync(GUI)
    .filter((d) => d.startsWith("release"))
    .map((d) => join(GUI, d, "win-unpacked", "resources", "app.asar"))
    .filter((p) => existsSync(p));
  if (dirs.length === 0) { return null; }
  return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const asar = arg("asar") ? resolve(ROOT, arg("asar")) : autoAsar();
if (!asar) {
  console.error("[assert-packaged-notes] 找不到 app.asar（先打包，或用 --asar 指定）");
  process.exit(1);
}
if (!existsSync(asar)) {
  console.error(`[assert-packaged-notes] 文件不存在: ${asar}`);
  process.exit(1);
}

const buf = readFileSync(asar);

console.info(`[assert-packaged-notes] 检查 ${asar}`);
console.info(`[assert-packaged-notes] app.asar ${(buf.length / 1048576).toFixed(2)} MB\n`);

/**
 * ⚠️ 必须**按 UTF-8 字节**比对，不能 `buf.toString("latin1")` 之后再 `includes(marker)`。
 * latin1 会把每个字节摊成一个 0–255 的字符，`收` 变成 3 个乱码字符，
 * 于是中文标记**永远匹配不上** —— 这个脚本就会对所有输入一律报"缺失"（假红，
 * 但和假绿一样致命：它会让你以为包有问题，或者反过来让你放松警惕）。
 * 字节比对对二进制安全，且与编码无关。
 */
const has = (marker) => buf.includes(Buffer.from(marker, "utf8"));

const missing = [];
for (const { marker, why } of REQUIRED) {
  if (has(marker)) {
    console.info(`  ✓ ${marker}`);
  } else {
    console.error(`  ✗ 缺 ${marker} —— ${why}`);
    missing.push(marker);
  }
}

console.info("");
if (missing.length > 0) {
  console.error(`[assert-packaged-notes] 这个包里**没有**更新说明结构化渲染（缺 ${missing.length}/${REQUIRED.length}）。`);
  console.error("  说明：源码可能已经修好，但这份打包产物早于修复（源码绿 ≠ 包里有）。");
  console.error("  处理：重新打包，或确认要发布的版本号是否包含该修复。");
  process.exit(1);
}
console.info(`[assert-packaged-notes] 全部 ${REQUIRED.length} 条标记命中 —— 这个包里有更新说明结构化渲染。`);
process.exit(0);
