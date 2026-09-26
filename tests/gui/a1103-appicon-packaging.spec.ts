/**
 * tests/gui/a1103-appicon-packaging.spec.ts — A-1103：应用图标「打包时不在」的守卫。
 *
 * 用户原话：「这个里面的这个图标就是 slime 现在的图标，原本我设计的图标都显示不出来了，
 * 你修复一下。实在不行重新上一下这个图 [icon.ico]」。
 *
 * ⚠️ 先把事实说清（一手取证，没有推断）：
 *   · 用户给的那张 `icon.ico`（148046 B）**在仓库里到处都有**：`gui/src/renderer/assets/icon.ico`、
 *     各 `release-<版本>/.icon-ico/icon.ico`、`gui/out/renderer/assets/icon-BqplF1DB.ico` —— 全是同一张。
 *   · 而 `gui/build/icon.ico`（92797 B）是**另一张**：它由 `make-notify-icon.mjs` 把
 *     `build/icon.png` 降采样后**生成**。
 *   · `app.getFileIcon(release-v0.0.7/win-unpacked/Slime.exe)` 取出的位图 = **用户截图里那张
 *     Electron 默认图**（灰白文档 + 蓝方块）。
 *   · `release-v0.0.7/win-unpacked/build/` 里**只有 icon.png**；用户**已安装**那一份
 *     （`E:\local project\slime\build\`）同样只有 icon.png。
 *   · `git log -- gui/build/icon.ico` ⇒ 由 **A-1075（9-23）** 引入，而 v0.0.7 打包于 **9-22 00:48**。
 *
 * ⇒ 根因**不是"图被换掉了"**，而是 **打包那一刻 `build/icon.ico` 还不存在**：
 *   `electron-builder.json` 的 `win.icon` 指向一个空文件，而 electron-builder **不报错**，
 *   静默降级成默认图标 —— 又与「静默失效」家族同宗：过 tsc、过构建、过全部逻辑测试，
 *   只在用户桌面上翻车。
 *
 * 修法（**必须三件套齐，缺一件照样翻车**）：
 *   ① **生成时机**：4 条 `dist:*` 链路在**打包前**显式跑 `preicons`（生成 + 断言）；
 *   ② **产物断言**：打包**后**断言 `win-unpacked/build/` 下三项资产已落地且与源同源；
 *   ③ **守门会中止**：`preicons` 任何一步失败 ⇒ `&&` 链掐断 ⇒ **宁可不打包，也不产出图标坏掉的包**。
 *
 * 判据一句话：
 *   · **图标资产必须在打包那一刻存在**（时机，不是内容）；
 *   · **断言必须查"在不在/新不新"，不许查"图好不好看"**（内容从没错过）；
 *   · **两条 dist 链路缺一不可**（只加生成不加断言 = 打包完没人验收；只加断言不加生成 = 照样缺）。
 *
 * ✅ 已手工实测（本 spec 之外，因为 spec 里不能真删文件）：
 *     移走 `build/icon.png` → `npm run preicons` **EXIT=1 中止**；还原 → EXIT=0。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会故意写旧写法/病灶描述，不剥就是假红） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const PKG = JSON.parse(readSrc("gui/package.json")) as { scripts: Record<string, string> };
const CFG = JSON.parse(readSrc("gui/electron-builder.json")) as {
  win?: { icon?: string };
  linux?: { icon?: string };
  extraFiles?: Array<{ from?: string; to?: string }>;
};
const ASSERT_RAW = readSrc("gui/scripts/assert-appicon.mjs");
const ASSERT = stripComments(ASSERT_RAW);
const MAKER = stripComments(readSrc("gui/scripts/make-notify-icon.mjs"));

/** 4 条能产出安装包的链路 —— 少一条，那条链路产出的包图标就是默认图 */
const DIST_SCRIPTS = ["dist:win", "dist:win:publish", "dist:linux", "dist:linux:publish"] as const;

/* ───────────── ① 生成时机：打包前必须生成图标资产 ───────────── */

describe("A-1103 ① — 生成时机：每条 dist 链路都必须在**打包前**生成图标（v0.0.7 的病灶）", () => {
  it("T1 4 条 dist 链路**全部**含 `preicons`（只加一条 ⇒ 那条链路照样产出默认图标）", () => {
    const missing = DIST_SCRIPTS.filter((k) => !(PKG.scripts[k] ?? "").includes("preicons"));
    expect(missing, `以下链路缺少 preicons：${missing.join(", ")}`).toEqual([]);
  });

  it("T2 `preicons` 必须在打包命令**之前**（顺序反了就等于没生成）", () => {
    for (const k of DIST_SCRIPTS) {
      const s = PKG.scripts[k] ?? "";
      const gen = s.indexOf("preicons");
      // 打包命令：win 走 retry-build，linux 走 electron-builder
      const pack = Math.max(s.indexOf("retry-build"), s.indexOf("electron-builder"));
      expect(gen, `${k}: preicons 未出现`).toBeGreaterThanOrEqual(0);
      expect(pack, `${k}: 未找到打包命令`).toBeGreaterThanOrEqual(0);
      expect(gen, `${k}: preicons 必须在打包命令之前`).toBeLessThan(pack);
    }
  });

  it("T3 `preicons` 必须**先生成、再断言**（只生成不断言 = 打了包没人验收）", () => {
    const s = PKG.scripts.preicons ?? "";
    const make = s.indexOf("make-notify-icon.mjs");
    const assert = s.indexOf("assert-appicon.mjs");
    expect(make, "preicons 未调用生成器").toBeGreaterThanOrEqual(0);
    expect(assert, "preicons 未调用断言器").toBeGreaterThanOrEqual(0);
    expect(make, "preicons 里生成器必须排在断言器之前").toBeLessThan(assert);
  });
});

/* ───────────── ② 产物断言：打包后必须验收落地 ───────────── */

describe("A-1103 ② — 产物断言：打包后必须验收 extraFiles 真的落地了", () => {
  it("T4 4 条 dist 链路**全部**在打包后调 `assert-appicon.mjs`（win 用 --postbuild）", () => {
    const missing = DIST_SCRIPTS.filter((k) => !(PKG.scripts[k] ?? "").includes("assert-appicon.mjs"));
    expect(missing, `以下链路缺少产物断言：${missing.join(", ")}`).toEqual([]);
  });

  it("T5 win 链路用 `--postbuild`（自动推导产物目录，不写死 release-final）", () => {
    for (const k of ["dist:win", "dist:win:publish"]) {
      expect(PKG.scripts[k] ?? "", `${k} 必须用 --postbuild`).toContain("--postbuild");
    }
  });

  it("T6 断言器必须读 `SLIME_OUT_DIR`（发布流程会用它把整个输出目录换掉）", () => {
    expect(ASSERT).toContain("SLIME_OUT_DIR");
    expect(ASSERT).toContain("directories");
  });
});

/* ───────────── ③ 守门会中止：断言失败必须红 ───────────── */

describe("A-1103 ③ — 守门会中止：判据存在且方向正确（假绿比假红危险）", () => {
  it("T7 断言器必须真计数并 `process.exit(非 0)`（读不到就当通过 = 假绿）", () => {
    expect(ASSERT).toContain("fail++");
    expect(ASSERT).toMatch(/process\.exit\(fail === 0 \? 0 : 1\)/);
  });

  it("T8 缺 `build/icon.ico` 必须**报 MISS**（这条就是 v0.0.7 的事故现场）", () => {
    // ⚠️ 判据必须锁到「**缺**文件时走 `miss`」这一步，只查标签字串在不在是**不够**的：
    //    `ok("build/icon.ico 存在")` 同样含那个字串，于是「把 MISS 改成 OK」的变异能溜过去
    //    （实测：本条的初版就被这条等价变异体骗过一次）。
    expect(ASSERT).toContain('miss("build/icon.ico 存在"');
    // 反向判据：不许写成「有就报错」
    expect(ASSERT).not.toContain("!existsSync(ICON_ICO)) { ok(");
  });

  it("T9 新鲜度判据方向必须正确：**派生物早于源头**才报错（`dMs < srcMs`，不是 `>`）", () => {
    expect(ASSERT).toContain("dMs < srcMs");
    expect(ASSERT, "方向写反 = 把正常的判成陈货").not.toContain("dMs > srcMs");
  });

  it("T10 产物断言必须比对**内容同源**（只查存在会让「拷了旧的一份」溜过去）", () => {
    // ⚠️ 判据是**比对语句本身**（`sha256(a) !== sha256(b)`），不是「文件里出现过 sha256 这个词」——
    //    只声明 `const sha256 = …` 而把比对整段删掉，文件里**仍然含**那个字串（变异能溜过去）。
    expect(ASSERT).toContain("sha256(a) !== sha256(b)");
    // ⚠️ 断言的是源码里的**拼接形态**：运行时文案由 `"产物 " + rel + " 已落地"` 拼出，
    //    直接找「产物 icon.ico 已落地」必然落空（守卫锁错对象 = 一次误判）。
    expect(ASSERT).toContain('"产物 " + rel + " 已落地"');
  });
});

/* ───────────── ④ 配置与常量：两个产地不许漂移 ───────────── */

describe("A-1103 ④ — 配置与常量一致性：两处产地漂移就静默失效", () => {
  it("T11 `win.icon` 必须指向 `build/icon.ico`（退回 1024² PNG 会让 exe/快捷方式图标糊）", () => {
    expect(CFG.win?.icon).toBe("build/icon.ico");
  });

  it("T12 `extraFiles` 必须显式列出三张图标资产（buildResources 不会自动随包）", () => {
    const froms = (CFG.extraFiles ?? []).map((e) => e.from);
    for (const f of ["build/icon.png", "build/icon.ico", "build/notify-icon.png"]) {
      expect(froms, `extraFiles 缺少 ${f}`).toContain(f);
    }
  });

  it("T13 断言器的 `EXPECTED_ICO_SIZES` 必须与生成器的 `ICO_SIZES` **逐项一致**", () => {
    const grab = (src: string, name: string): number[] => {
      const m = new RegExp(`const ${name} = \\[([^\\]]+)\\]`).exec(src);
      expect(m, `未找到 ${name}`).not.toBeNull();
      return (m as RegExpExecArray)[1].split(",").map((x) => Number.parseInt(x.trim(), 10));
    };
    const maker = grab(MAKER, "ICO_SIZES");
    const asserter = grab(ASSERT, "EXPECTED_ICO_SIZES");
    expect(asserter, "两处尺寸清单漂移 —— 生成 7 档而只验收 4 档（或反之）").toEqual(maker);
  });

  it("T14 通知图的体积上限必须是 200 KB（超限的后果是**整条通知被丢弃**，不是图标小一点）", () => {
    expect(ASSERT).toContain("200 * 1024");
  });
});
