
































import { describe, expect, it } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTIFY_IMAGE_MAX_BYTES,
  NOTIFY_IMAGE_MAX_DIM,
  checkNotifyImage,
  notifyIconFileName,
} from "../../gui/src/main/notifyIdentity.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const NOTIFY = read("gui/src/main/notify.ts");
const IDENTITY = read("gui/src/main/notifyIdentity.ts");
const BUILDER = read("gui/electron-builder.json");
const MAKER = read("gui/scripts/make-notify-icon.mjs");

const NOTIFY_ICON_PNG = join(ROOT, "gui", "build", "notify-icon.png");
const BIG_ICON_PNG = join(ROOT, "gui", "build", "icon.png");


function pngSize(p: string): { width: number; height: number } {
  const b = readFileSync(p);
  if (b.readUInt32BE(0) !== 0x89504e47) { throw new Error(`${p} 不是 PNG`); }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe("A-1067-A 验收判据（纯逻辑：Windows 通知图片的 1024px / 200 KB 双约束）", () => {
  it("常量就是一手来源里的那两个数（改小无害、改大就是放行一张会被丢弃的图）", () => {
    expect(NOTIFY_IMAGE_MAX_BYTES).toBe(200 * 1024);
    expect(NOTIFY_IMAGE_MAX_DIM).toBe(1024);
  });

  it("合规的图通过", () => {
    expect(checkNotifyImage({ bytes: 60 * 1024, width: 256, height: 256 }).ok).toBe(true);
  });

  it("体积超 200 KB → 不通过（这是 #228 的根因形态：951.7 KB）", () => {
    const v = checkNotifyImage({ bytes: 974547 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("体积");
  });

  it("边界：恰好 200 KB 通过、多 1 字节不通过", () => {
    expect(checkNotifyImage({ bytes: NOTIFY_IMAGE_MAX_BYTES }).ok).toBe(true);
    expect(checkNotifyImage({ bytes: NOTIFY_IMAGE_MAX_BYTES + 1 }).ok).toBe(false);
  });

  it("尺寸超 1024px → 不通过（宽、高各判一次）", () => {
    expect(checkNotifyImage({ bytes: 1024, width: 1025 }).ok).toBe(false);
    expect(checkNotifyImage({ bytes: 1024, height: 1025 }).ok).toBe(false);
    expect(checkNotifyImage({ bytes: 1024, width: 1024, height: 1024 }).ok).toBe(true);
  });

  it("量不到尺寸时只按体积判（不因缺参就放行一张巨图）", () => {
    expect(checkNotifyImage({ bytes: 973824 }).ok).toBe(false);
  });
});

describe("A-1067-B 文件名的唯一出处：通知图标**不是** icon.png", () => {
  it("notifyIconFileName() 返回通知专用名（换成 icon.png 就是 #228 原样复活）", () => {
    expect(notifyIconFileName()).toBe("notify-icon.png");
  });

  it("真·资产：gui/build/notify-icon.png 存在且**实测**符合双约束", () => {
    expect(existsSync(NOTIFY_ICON_PNG), "通知图标资产缺失（跑 gui/scripts/make-notify-icon.mjs 生成）").toBe(true);
    const bytes = statSync(NOTIFY_ICON_PNG).size;
    const { width, height } = pngSize(NOTIFY_ICON_PNG);
    const v = checkNotifyImage({ bytes, width, height });
    expect(v.ok, `notify-icon.png 不合规：${v.reason}`).toBe(true);
  });

  it("[反例] 安装器大图真的是超限的 —— 证明这条守卫拦的是真问题，不是假想", () => {
    
    
    expect(existsSync(BIG_ICON_PNG)).toBe(true);
    const bytes = statSync(BIG_ICON_PNG).size;
    expect(bytes, "build/icon.png 已不再是超限大图 —— 请复查本守卫的前提").toBeGreaterThan(NOTIFY_IMAGE_MAX_BYTES);
  });
});

describe("A-1067-C 接线（源码形态：notify.ts 不许再拿大图当通知图标）", () => {
  





  function iconPathBody(): string {
    const from = NOTIFY.indexOf("export function notificationIconPath()");
    expect(from, "锚点漂移：找不到 notificationIconPath 的定义").toBeGreaterThan(-1);
    const body = NOTIFY.slice(from);
    return strip(body.slice(0, body.indexOf("\n}")));
  }

  it("notificationIconPath() 用的是 notifyIconFileName()，不是写死的 icon.png", () => {
    const body = iconPathBody();
    expect(body, "锚点漂移：找不到 notificationIconPath 的体").toContain("notifyIconFileName()");
    expect(body, "通知图标又指回安装器大图 icon.png → 超限 → 头部静默空白").not.toContain('"icon.png"');
  });

  it("量了体积并按判据决定**不传**（超限时宁可用系统默认图标，也不让整条通知被丢弃）", () => {
    const body = iconPathBody();
    expect(body).toContain("statSync(p).size");
    expect(body).toContain("checkNotifyImage(");
    


    expect(
      /\[notify\] 通知图标不合规[\s\S]{0,200}?return undefined;/.test(body),
      "不合规分支没有「警告 + return undefined」相邻形态 → 超限时会把坏路径传下去",
    ).toBe(true);
  });

  it("缺文件时**出声**（extraFiles 漏配是本项目真实发生过的故障形态）", () => {
    const body = iconPathBody();
    expect(
      /\[notify\] 通知图标缺失[\s\S]{0,200}?return undefined;/.test(body),
      "缺文件分支没有自己的警告 → extraFiles 漏配将永久静默",
    ).toBe(true);
    expect(body, "警告文案里应点出 extraFiles 这条核对线索").toContain("extraFiles");
  });

  it("notify.ts 从 notifyIdentity.ts 引入这两个符号（唯一出处，不许自己拼文件名）", () => {
    expect(NOTIFY).toContain("notifyIconFileName");
    expect(NOTIFY).toContain("checkNotifyImage");
    expect(IDENTITY).toContain("export function notifyIconFileName()");
    expect(IDENTITY).toContain("export function checkNotifyImage(");
  });
});

describe("A-1067-D 随包（打包版没有这张图 = 再次静默无图标）", () => {
  it("electron-builder.json 的 extraFiles 显式列出 notify-icon.png", () => {
    const cfg = JSON.parse(BUILDER) as { extraFiles: Array<{ from: string; to: string }> };
    const entry = cfg.extraFiles.find((e) => e.to === "build/notify-icon.png");
    expect(entry, "extraFiles 漏了 build/notify-icon.png → 打包版 INSTALL_ROOT/build 下没有它").toBeTruthy();
    expect(entry?.from).toBe("build/notify-icon.png");
  });

  it("大图仍然随包（安装器/窗口图标要用，别顺手删掉）", () => {
    const cfg = JSON.parse(BUILDER) as { extraFiles: Array<{ from: string; to: string }> };
    expect(cfg.extraFiles.find((e) => e.to === "build/icon.png")).toBeTruthy();
  });
});

describe("A-1067-E 生成脚本可用（产物必须可复现，不能是手工压出来的一张孤图）", () => {
  it("生成脚本自带验收（不合格就 exit 1，不许静默产出废图）", () => {
    expect(MAKER, "体积验收那一步被拿掉了").toContain("if (out.length > MAX_BYTES)");
    expect(MAKER).toContain("process.exit(1)");
  });

  it("生成脚本用**面积平均**降采样 + 自适应行滤波（不是最近邻/无滤波凑体积）", () => {
    


    expect(MAKER, "降采样调用点漂移").toContain("= downscale(pixels, w, h, channels, size)");
    expect(MAKER, "逐行滤波调用点漂移").toContain("filterLine(cur, prev, channels)");
  });

  it("生成脚本只用内置模块（本机 pip 索引不可用、也无 ImageMagick → 不许引入外部依赖）", () => {
    const imports = [...MAKER.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length, "一条 import 都没扫到 —— 正则或源码形态漂移了").toBeGreaterThan(3);
    for (const m of imports) {
      expect(m.startsWith("node:"), `生成脚本引入了非内置依赖：${m}`).toBe(true);
    }
  });
});
