




































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

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


const DIST_SCRIPTS = ["dist:win", "dist:win:publish", "dist:linux", "dist:linux:publish"] as const;



describe("A-1103 ① — 生成时机：每条 dist 链路都必须在**打包前**生成图标（v0.0.7 的病灶）", () => {
  it("T1 4 条 dist 链路**全部**含 `preicons`（只加一条 ⇒ 那条链路照样产出默认图标）", () => {
    const missing = DIST_SCRIPTS.filter((k) => !(PKG.scripts[k] ?? "").includes("preicons"));
    expect(missing, `以下链路缺少 preicons：${missing.join(", ")}`).toEqual([]);
  });

  it("T2 `preicons` 必须在打包命令**之前**（顺序反了就等于没生成）", () => {
    for (const k of DIST_SCRIPTS) {
      const s = PKG.scripts[k] ?? "";
      const gen = s.indexOf("preicons");
      
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



describe("A-1103 ③ — 守门会中止：判据存在且方向正确（假绿比假红危险）", () => {
  it("T7 断言器必须真计数并 `process.exit(非 0)`（读不到就当通过 = 假绿）", () => {
    expect(ASSERT).toContain("fail++");
    expect(ASSERT).toMatch(/process\.exit\(fail === 0 \? 0 : 1\)/);
  });

  it("T8 缺 `build/icon.ico` 必须**报 MISS**（这条就是 v0.0.7 的事故现场）", () => {
    
    
    
    expect(ASSERT).toContain('miss("build/icon.ico 存在"');
    
    expect(ASSERT).not.toContain("!existsSync(ICON_ICO)) { ok(");
  });

  it("T9 新鲜度判据方向必须正确：**派生物早于源头**才报错（`dMs < srcMs`，不是 `>`）", () => {
    expect(ASSERT).toContain("dMs < srcMs");
    expect(ASSERT, "方向写反 = 把正常的判成陈货").not.toContain("dMs > srcMs");
  });

  it("T10 产物断言必须比对**内容同源**（只查存在会让「拷了旧的一份」溜过去）", () => {
    
    
    expect(ASSERT).toContain("sha256(a) !== sha256(b)");
    
    
    expect(ASSERT).toContain('"产物 " + rel + " 已落地"');
  });
});



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
