/**
 * tests/core-ts/a1075-app-icon.spec.ts — Issue 5「任务栏/托盘图标异常」的回归守卫。
 *
 * ## 排查结论（一手证据）
 *
 * 原实现把 **`gui/build/icon.png`（1024×1024、951.7 KB）** 同时喂给三处：
 *   · 托盘 `Tray`（Windows 实际渲染 **16 px**，200% DPI 下 32 px）；
 *   · 窗口 `BrowserWindow.icon`（任务栏 24/32/48 px）；
 *   · electron-builder `win.icon`（exe / 快捷方式图标）。
 *
 * ⇒ 等于每次都让系统把一张 1024² 位图**现场缩**到十几像素：观感糊，且每处都要读近 1 MB。
 * 这与 #228「通知图标」是**同一类**问题（渲染处只有几十像素，却喂它一张 1024²），
 * 所以沿用同一个解法与同一个生成器：**渲染处需要多大，就给它多大**。
 *
 * 修法：`gui/scripts/make-notify-icon.mjs` 追加产出 `build/icon.ico`（逐尺寸预置
 * 16/24/32/48/64/128/256 七张位图，16×16 那张仅 0.75 KB）；Windows 的托盘与任务栏用它
 * ⇒ **全程零缩放**。非 Windows 回落到 PNG（Electron 在 Linux/macOS 上读不了 `.ico`）。
 *
 * ## 为什么需要这个文件
 *
 * "图标换了个格式"这类改动**过 tsc、过构建、过全部逻辑测试**，只在用户桌面上看得见；
 * 而它又是**两个**产地的（托盘 + 窗口）—— 只改一处就会出现"任务栏对了、托盘还是糊的"。
 * 所以这里锁三件事：资产本身合格、两处都走**同一个出处**、配置与 extraFiles 跟上。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const ICO_PATH = join(ROOT, "gui", "build", "icon.ico");
const PNG_PATH = join(ROOT, "gui", "build", "icon.png");
const MAIN_C = strip(read("gui/src/main/index.ts"));
const MAKER = read("gui/scripts/make-notify-icon.mjs");
const CFG = JSON.parse(read("gui/electron-builder.json")) as {
  win?: { icon?: string };
  linux?: { icon?: string };
  extraFiles?: Array<{ from?: string; to?: string }>;
};

/** 读 ICO 目录：每个条目的尺寸与内嵌数据（Vista+ 支持内嵌 PNG）。 */
function icoEntries(): Array<{ size: number; bytes: number; ok: boolean }> {
  const b = readFileSync(ICO_PATH);
  const n = b.readUInt16LE(4);
  const out: Array<{ size: number; bytes: number; ok: boolean }> = [];
  for (let i = 0; i < n; i += 1) {
    const at = 6 + 16 * i;
    const w = b.readUInt8(at);
    const off = b.readUInt32LE(at + 12);
    out.push({ size: w === 0 ? 256 : w, bytes: b.readUInt32LE(at + 8), ok: b.readUInt32BE(off) === 0x89504e47 });
  }
  return out;
}

/** 取一段源码（`from` 起点 → `next` 起点）。 */
function between(src: string, from: string, next: string): string {
  const at = src.indexOf(from);
  expect(at, `锚点漂移：找不到 ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(next, at + from.length);
  expect(end, `锚点漂移：找不到 ${from} 的右界 ${next}`).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("A-1075①：资产 —— icon.ico 逐尺寸预置，渲染处要多大就有多大", () => {
  it("`build/icon.ico` 存在且体积远小于源 PNG（1024² 那张是 951.7 KB）", () => {
    expect(existsSync(ICO_PATH), "icon.ico 缺失（跑 gui/scripts/make-notify-icon.mjs 生成）").toBe(true);
    const icoKb = statSync(ICO_PATH).size / 1024;
    const pngKb = statSync(PNG_PATH).size / 1024;
    /* 这条断言锁的是**问题本身**：给十几像素的位置喂一张近 1 MB 的图。
       ico 里最大的一张是 256²（≈59 KB），加上其余六张一共 ≈91 KB —— 比源图小一个数量级。 */
    expect(icoKb, `icon.ico 反而更大（${icoKb.toFixed(1)} KB）—— 没有起到「按需取用」的作用`).toBeLessThan(pngKb / 4);
  });

  it("ICO 头合法，且**覆盖** Windows 用到的每个尺寸（16/24/32/48/64/128/256）", () => {
    const b = readFileSync(ICO_PATH);
    expect(b.readUInt16LE(0), "reserved 不是 0").toBe(0);
    expect(b.readUInt16LE(2), "type 不是 1（图标）").toBe(1);
    const sizes = icoEntries().map((e) => e.size);
    for (const need of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes, `ICO 里没有 ${need}px 那一张 —— 系统只能自己缩`).toContain(need);
    }
    for (const e of icoEntries()) {
      expect(e.ok, `${e.size}px 那一项内嵌的不是 PNG`).toBe(true);
    }
  });

  it("**托盘实际渲染的那一张**（16×16）极小 —— 这才是「按需取用」的可测判据", () => {
    const e16 = icoEntries().find((x) => x.size === 16);
    expect(e16, "没有 16px 那一张").toBeTruthy();
    /* 0.75 KB 实测。给个宽上界：> 4 KB 说明尺寸/编码不对（尺寸错了会连带把别的尺寸塞进来）。 */
    expect(e16!.bytes, `16px 那张 ${(e16!.bytes / 1024).toFixed(2)} KB —— 不对，托盘只该读几百字节`)
      .toBeLessThan(4096);
  });

  it("生成器里就有 ICO 这一步（不是手工塞进仓库的二进制 —— 那样换图标就漂移）", () => {
    expect(MAKER, "生成脚本没有 ICO 组装函数").toContain("function buildIco(");
    expect(MAKER, "ICO 尺寸清单不在生成脚本里").toContain("const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];");
    expect(MAKER, "生成后没有对 ICO 做自验收（不合格也当成功）").toContain("ICO 生成失败");
  });
});

describe("A-1075②：接线 —— 托盘与任务栏走**同一个出处**，且失败不静默", () => {
  it("存在唯一出处 `resolveAppIcon()`，且按平台选格式（非 Windows 不许用 .ico）", () => {
    const fn = between(MAIN_C, "const resolveAppIcon = (): string => {", "const ensureTray");
    expect(fn, "没有按平台分支 → Linux/macOS 上读 .ico 会得到空图").toContain('process.platform === "win32" ? "icon.ico" : "icon.png"');
    /* 读不出来必须**回落 + 出声**（换格式本身也可能失败：资产缺失/解码不出）——
       否则托盘图标会变成静默空白，比"糊"更难发现。 */
    expect(fn, "图标读不出来时没有回落 → 换格式失败就是静默空白").toContain("isEmpty()");
    expect(fn, "回落时不出声 → 静默失败").toContain("console.warn");
    expect(fn, "回落目标不是 PNG").toContain('join(INSTALL_ROOT, "build", "icon.png")');
  });

  it("托盘用 `resolveAppIcon()`（不许再单独写一份 1024² PNG 的路径）", () => {
    const tray = between(MAIN_C, "const ensureTray = (): void => {", "syncTrayTooltip();\n  } catch");
    expect(tray, "托盘又自己拼了一遍图标路径 → 两处会漂移（改一处只对一半）").not.toContain('"build", "icon.png"');
    expect(tray, "托盘没用唯一出处").toContain("resolveAppIcon()");
    expect(tray, "托盘不再从路径构造图标").toContain("nativeImage.createFromPath(iconPath)");
  });

  it("任务栏（窗口）图标用**同一个**出处", () => {
    expect(MAIN_C, "窗口图标没走唯一出处 → 「任务栏对了托盘还是糊」这类半修").toContain("icon: resolveAppIcon(),");
  });

  it("打包配置：Windows 用 .ico、Linux 仍用 .png，且 ico 随包（缺了就回落）", () => {
    expect(CFG.win?.icon, "win.icon 还是 1024² 的 png（exe/快捷方式图标靠它）").toBe("build/icon.ico");
    expect(CFG.linux?.icon, "Linux 被一起改成 ico 了 —— 那边读不了").toBe("build/icon.png");
    const entry = CFG.extraFiles?.find((e) => e.to === "build/icon.ico");
    expect(entry, "extraFiles 漏了 build/icon.ico → 打包版 INSTALL_ROOT/build 下没有它").toBeTruthy();
    expect(entry?.from).toBe("build/icon.ico");
  });
});
