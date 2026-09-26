/**
 * gui/scripts/assert-appicon.mjs — 应用图标资产的**导入前 / 产物后**断言（唯一实现，可复现）。
 *
 * ══ 为什么必须有它（A-1103 的真实根因，用户报「原本我设计的图标都显示不出来了」）══════
 * 用户任务栏 / exe 上显示的是 **Electron 默认图标**（灰白文档+蓝方块），而 `gui/build/`
 * 里那张史莱姆图好好的。取证链（全部一手，无推断）：
 *
 *   ① `app.getFileIcon(release-v0.0.7/win-unpacked/Slime.exe)` 取出的位图 = **用户截图里那张默认图**；
 *   ② `release-v0.0.7/win-unpacked/build/` 里 **只有 icon.png** —— `icon.ico` 与
 *      `notify-icon.png` **都不在**；
 *   ③ 用户**已安装**的那一份（`E:\local project\slime\build\`）同样**只有 icon.png**；
 *   ④ `git log -- gui/build/icon.ico` ⇒ 该文件由 **A-1075（9-23）** 引入，而 v0.0.7 打包于
 *      **9-22 00:48** ⇒ **打包那一刻它还不存在**；
 *   ⑤ `electron-builder.json` 的 `win.icon = "build/icon.ico"` 指向一个**当时的空文件**，
 *      而 electron-builder 对此**不报错** —— 静默降级成默认图标。这就是本项目的
 *      「静默失效」家族：过 tsc、过构建、过全部逻辑测试，**只在用户桌面上翻车**。
 *
 * ⚠️ 为什么资产内容没问题也要断言：用户给的兜底素材、各 `release-<版本>` 目录下的
 *   `.icon-ico/icon.ico`、`src/renderer/assets/icon.ico` 全是 148046 B 的**同一张**；
 *   而 `build/icon.ico`（92797 B）
 *   是 `make-notify-icon.mjs` 由 `build/icon.png` 降采样**生成**的。**内容从来没错过，
 *   错的是"打包时它不在"。** ⇒ 断言的对象必须是「**在不在 / 新不新**」，而不是「图对不对」。
 *
 * ⚠️ 为什么不比对 exe 内嵌图标的字节（实测排除的判据）：本机实测
 *   `electron.exe`（图标正常的原版）与两个 `Slime.exe` **都不含** `icon.ico` 里任何一帧的
 *   PNG 字节（含 256²/60 KB 那张）。⇒ electron-builder 嵌图标时**重新编码**了，
 *   字节匹配会**把正常的 exe 判成坏的**（假红）。故本脚本不碰 exe 内部结构；
 *   「exe 图标到底对不对」由 `verify-exe-icon.cjs` 渲染像素后人工/自动验收。
 *
 * 用法（在 `gui/` 下执行）：
 *   node scripts/assert-appicon.mjs                       # 源资产环节（打包**前**）
 *   node scripts/assert-appicon.mjs --bundle <dir>        # 产物环节（打包**后**，<dir> = win-unpacked）
 *   node scripts/assert-appicon.mjs --postbuild           # 产物环节，产物目录自动推导（给 npm script 用）
 *
 * ⚠️ 产物目录**自动推导**而不是写死：`directories.output` 默认 `release-final`，但发布流程会用
 *   `SLIME_OUT_DIR`（见 `scripts/retry-build.mjs`）把它整个换掉（v0.0.7 就落在 `release-v0.0.7`）。
 *   写死一个名字 ⇒ 换目录时断言**静默查了个不存在的路径**（要么全 MISS 噪声、要么假绿）。
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const GUI_DIR = resolve(process.cwd());

/**
 * `build/icon.ico` 里应有的尺寸清单。
 * ⚠️ 与 `make-notify-icon.mjs` 的 `ICO_SIZES` 是**同一份事实的两个产地** ——
 *   守卫 spec（`tests/gui/a1103-appicon-packaging.spec.ts`）会断言两处**逐项一致**，
 *   任何一处漂移都会变红。这里**不复用**它：生成器是顶层脚本（无 export），
 *   用正则去抠它的常量属于"解析别人的源码"，比对手写常量更脆。
 */
const EXPECTED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Windows 通知图片的硬约束（与 `notifyIdentity.ts` 的常量同源；此处只做验收） */
const NOTIFY_MAX_BYTES = 200 * 1024;
const NOTIFY_MAX_DIM = 1024;

let fail = 0;
function ok(label) { console.log("OK   " + label); }
function miss(label, why) { fail++; console.log("MISS " + label + (why ? " —— " + why : "")); }

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG 头里的宽高（IHDR 紧跟 8 字节魔数 + 4 字节长度 + 4 字节类型） */
function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) { return null; }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 解析 ICO 目录：返回 [{ width, height, bytes, isPng }]，坏文件返回 null */
function parseIco(buf) {
  if (buf.length < 6) { return null; }
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) { return null; }
  const count = buf.readUInt16LE(4);
  if (count === 0) { return null; }
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) { return null; }
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    if (off + size > buf.length) { return null; }
    out.push({
      width: buf[o] === 0 ? 256 : buf[o],
      height: buf[o + 1] === 0 ? 256 : buf[o + 1],
      bytes: size,
      isPng: buf.subarray(off, off + 8).equals(PNG_MAGIC),
    });
  }
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const ICON_PNG = join(GUI_DIR, "build", "icon.png");
const ICON_ICO = join(GUI_DIR, "build", "icon.ico");
const NOTIFY_PNG = join(GUI_DIR, "build", "notify-icon.png");

/** 源资产环节：三个文件必须在、必须合规、而且**不许是陈货** */
function assertSource() {
  // ── ① 应用大图（一切的源头；ico 与 notify 都由它派生）──
  if (!existsSync(ICON_PNG)) { miss("build/icon.png 存在", "图标源头缺失，派生物无从生成"); return; }
  const pngBuf = readFileSync(ICON_PNG);
  const size = pngSize(pngBuf);
  if (size === null) { miss("build/icon.png 是合法 PNG"); }
  else if (size.width !== size.height) { miss("build/icon.png 是正方形", size.width + "x" + size.height); }
  else { ok("build/icon.png 存在且为正方形 PNG（" + size.width + "x" + size.height + "）"); }

  // ── ② 多尺寸 ICO（`win.icon` 指向它；exe / 快捷方式 / 任务栏都靠它）──
  if (!existsSync(ICON_ICO)) {
    // 这一条就是 v0.0.7 的事故现场：electron-builder 不报错，直接给默认图标。
    miss("build/icon.ico 存在", "win.icon 指向它 —— 缺了 electron-builder 会**静默**降级成默认图标");
  } else {
    const ico = parseIco(readFileSync(ICON_ICO));
    if (ico === null) { miss("build/icon.ico 是合法 ICO（reserved=0 / type=1 / 目录可解析）"); }
    else {
      const got = ico.map((e) => e.width);
      const want = EXPECTED_ICO_SIZES;
      if (got.length !== want.length || want.some((w, i) => got[i] !== w)) {
        miss("build/icon.ico 尺寸清单 = " + want.join("/"), "实际 " + got.join("/"));
      } else { ok("build/icon.ico 尺寸清单 = " + got.join("/")); }
      if (ico.some((e) => !e.isPng)) { miss("build/icon.ico 每帧都是 PNG（32bpp）"); }
      else { ok("build/icon.ico 每帧都是 PNG"); }
    }
  }

  // ── ③ 通知专用位图（toast 头部那格；超 200 KB 会让**整条通知被丢弃**）──
  if (!existsSync(NOTIFY_PNG)) {
    miss("build/notify-icon.png 存在", "toast 头部图标位会空着（且 extraFiles 会指向空文件）");
  } else {
    const nb = readFileSync(NOTIFY_PNG);
    const ns = pngSize(nb);
    if (ns === null) { miss("build/notify-icon.png 是合法 PNG"); }
    else if (nb.length > NOTIFY_MAX_BYTES) { miss("build/notify-icon.png 体积合规", (nb.length / 1024).toFixed(1) + " KB > " + NOTIFY_MAX_BYTES / 1024 + " KB"); }
    else if (ns.width > NOTIFY_MAX_DIM || ns.height > NOTIFY_MAX_DIM) { miss("build/notify-icon.png 尺寸合规", ns.width + "x" + ns.height); }
    else { ok("build/notify-icon.png 合规（" + ns.width + "x" + ns.height + " / " + (nb.length / 1024).toFixed(1) + " KB）"); }
  }

  // ── ④ 新鲜度：派生物不得**早于**源头（换成陈货 = 改了 icon.png 却没重新生成）──
  //    这是"忘了跑生成脚本"的**直接判据**。相等允许（同一秒内生成完）。
  if (existsSync(ICON_PNG)) {
    const srcMs = statSync(ICON_PNG).mtimeMs;
    for (const [p, name] of [[ICON_ICO, "build/icon.ico"], [NOTIFY_PNG, "build/notify-icon.png"]]) {
      if (!existsSync(p)) { continue; }
      const dMs = statSync(p).mtimeMs;
      if (dMs < srcMs) {
        miss(name + " 不比 build/icon.png 陈旧", "派生物比源头旧 —— 换了图却没重新生成（陈货）");
      } else { ok(name + " 不比 build/icon.png 陈旧"); }
    }
  }
}

/** 产物环节：extraFiles 真的落地了吗？落的是**同一份**吗？ */
function assertBundle(dirArg) {
  const dir = resolve(GUI_DIR, dirArg);
  if (!existsSync(dir)) { miss("产物目录存在", dir); return; }
  for (const [src, rel] of [[ICON_ICO, "icon.ico"], [NOTIFY_PNG, "notify-icon.png"], [ICON_PNG, "icon.png"]]) {
    const dst = join(dir, "build", rel);
    if (!existsSync(dst)) {
      // v0.0.7 的事故形态：win-unpacked/build/ 里只有 icon.png。
      miss("产物 " + rel + " 已落地", "extraFiles 没拷进去 ⇒ 该 exe 的图标必为默认图");
      continue;
    }
    const a = readFileSync(src);
    const b = readFileSync(dst);
    if (sha256(a) !== sha256(b)) { miss("产物 " + rel + " 与源资产同源", "内容不一致（拷了旧的一份？）"); }
    else { ok("产物 " + rel + " 与源资产同源（" + a.length + " B）"); }
  }
  for (const exe of ["Slime.exe", join("..", "Slime.exe")]) {
    const p = join(dir, exe);
    if (existsSync(p)) { ok("产物可执行文件存在：" + exe + "（" + (statSync(p).size / 1048576).toFixed(1) + " MB）"); }
  }
}

/** 按 electron-builder.json 的 `directories.output`（可被 `SLIME_OUT_DIR` 覆盖）推导产物目录 */
function resolveBundleDir() {
  let output = "release-final";
  try {
    const cfg = JSON.parse(readFileSync(join(GUI_DIR, "electron-builder.json"), "utf8"));
    if (cfg.directories && typeof cfg.directories.output === "string") { output = cfg.directories.output; }
  } catch { /* 读不到就用默认名 —— 下面 existsSync 会如实报 MISS */ }
  const overridden = (process.env.SLIME_OUT_DIR || "").trim();
  const base = resolve(GUI_DIR, overridden || output);
  for (const cand of [join(base, "win-unpacked"), join(base, "linux-unpacked"), base]) {
    if (existsSync(join(cand, "build"))) { return cand; }
  }
  return join(base, "win-unpacked"); // 都不在 → 报 MISS（如实说缺，不猜）
}

const bundleIdx = process.argv.indexOf("--bundle");
if (bundleIdx >= 0) {
  const dirArg = process.argv[bundleIdx + 1];
  if (!dirArg) { console.error("--bundle 后面要跟产物目录（如 ../release-final/win-unpacked）"); process.exit(2); }
  console.log("── 产物环节：" + dirArg + " ──");
  assertSource();
  assertBundle(dirArg);
} else if (process.argv.includes("--postbuild")) {
  const dir = resolveBundleDir();
  console.log("── 产物环节（自动推导）：" + dir + " ──");
  assertSource();
  assertBundle(dir);
} else {
  console.log("── 源资产环节：" + GUI_DIR + " ──");
  assertSource();
}

console.log(fail === 0 ? "\nAPPLICATION ICON ASSERTIONS PASSED" : "\n" + fail + " APPLICATION ICON ASSERTION(S) FAILED");
process.exit(fail === 0 ? 0 : 1);
