























import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_AUMID, APP_DISPLAY_NAME, aumidRegistryKey, aumidRegistryValues, buildNotificationPayload, pngFileUri } from "../../gui/src/main/notifyIdentity.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ICON_TSX = join(ROOT, "gui/src/renderer/components/Icon.tsx");
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");
const RIGHT_SIDEBAR = join(ROOT, "gui/src/renderer/pages/RightSidebar.tsx");
const NOTIFY_TS = join(ROOT, "gui/src/main/notify.ts");
const BUILD_CFG = join(ROOT, "gui/electron-builder.json");
const MAIN_DIR = join(ROOT, "gui/src/main");

const read = (p: string): string => readFileSync(p, "utf8");


function walkTs(dir: string): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push({ path: p, src: read(p) });
  }
  return out;
}

describe("A-1021 ①：通知头部那行应用名 = 程序名（靠 AUMID 注册，不是靠 Notification.title）", () => {
  it("AUMID 必须与 electron-builder 的 appId 一致（不一致 → 通知归不到本应用）", () => {
    const appId = JSON.parse(read(BUILD_CFG)).appId as string;
    expect(appId, "取不到 appId → 这条守卫自己失效了").toBeTruthy();
    expect(APP_AUMID).toBe(appId);
  });

  it("展示名 = 程序名，且**不是** AUMID（AUMID 被显示出来就是用户截图里那个症状）", () => {
    expect(APP_DISPLAY_NAME).toBe("slime");
    expect(APP_DISPLAY_NAME).not.toBe(APP_AUMID);
    expect(APP_DISPLAY_NAME).not.toContain("com.slime");
  });

  it("注册位置与值：HKCU\\Software\\Classes\\AppUserModelId\\<AUMID> → DisplayName（有合法图标时追加 IconUri）", () => {
    
    expect(aumidRegistryKey("com.example.app")).toBe("HKCU\\Software\\Classes\\AppUserModelId\\com.example.app");
    const vals = aumidRegistryValues("slime");
    expect(vals).toEqual([{ name: "DisplayName", value: "slime" }]);
    
    expect(aumidRegistryKey()).toContain(`AppUserModelId\\${APP_AUMID}`);
    expect(aumidRegistryValues()[0].value).toBe(APP_DISPLAY_NAME);

    




    expect(aumidRegistryValues().map((v) => v.name), "无 iconPath → 不写 IconUri（旧口径，仍须成立）")
      .not.toContain("IconUri");
    expect(aumidRegistryValues("slime", "D:\\tool\\AI\\slime\\build\\icon.png")).toEqual([
      { name: "DisplayName", value: "slime" },
      { name: "IconUri", value: "file:///D:/tool/AI/slime/build/icon.png" },
    ]);
    
    for (const bad of ["build/icon.png", "C:\\a\\icon.ico", "C:\\a\\icon.svg", null, undefined, ""]) {
      expect(aumidRegistryValues("slime", bad).map((v) => v.name), `不合格的图标路径却被写进了注册表：${bad}`)
        .not.toContain("IconUri");
    }
  });

  it("pngFileUri：反斜杠转正斜杠 + 逐段 percent-encode + 盘符冒号还原 + 只认位图扩展名", () => {
    
    expect(pngFileUri("D:\\tool\\AI\\slime\\build\\icon.png")).toBe("file:///D:/tool/AI/slime/build/icon.png");
    
    expect(pngFileUri("D:\\pilot project\\build\\icon.png")).toBe("file:///D:/pilot%20project/build/icon.png");
    
    expect(pngFileUri("D:\\中文 目录\\icon.png"))
      .toBe("file:///D:/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/icon.png");
    
    expect(pngFileUri("C:\\a\\b.jpg")).toBe("file:///C:/a/b.jpg");
    expect(pngFileUri("C:\\a\\b.JPEG")).toBe("file:///C:/a/b.JPEG");
    
    
    for (const bad of [null, undefined, "", "build/icon.png", "icon.png", "C:\\a\\icon.ico", "C:\\a\\icon.svg", "C:\\a\\icon.png.bak"]) {
      expect(pngFileUri(bad), `这个路径不该被当成合法通知图标：${JSON.stringify(bad)}`).toBe(null);
    }
  });

  it("标题是**事件文案**，不许被程序名顶掉（顶掉会让第二行与头部重复、白占 toast 空间）", () => {
    expect(buildNotificationPayload({ title: "test1 已完成", body: "Hey" }))
      .toEqual({ title: "test1 已完成", body: "Hey" });
    expect(buildNotificationPayload({ title: "  X  " })).toEqual({ title: "X", body: "" });
    
    expect(buildNotificationPayload({ title: "X", body: "X" })).toEqual({ title: "X", body: "" });
    
    expect(buildNotificationPayload({ body: "B" })).toEqual({ title: "slime", body: "B" });
  });

  it("唯一实现：main 里 `new Notification(` 只有一处；身份注册挂在 initNotify 路径上", () => {
    const hits = walkTs(MAIN_DIR).flatMap((f) =>
      f.src.split("\n").map((l, i) => ({ f, l, n: i + 1 })).filter((x) => x.l.includes("new Notification(")));
    expect(hits.map((h) => `${h.f.path}:${h.n}`), "通知必须只有一个构造点（多处构造 = 各处都要记得改）")
      .toHaveLength(1);
    const notifySrc = read(NOTIFY_TS);
    
    
    expect(notifySrc).toMatch(/export function initNotify\([\s\S]{0,200}?ensureNotificationIdentity\(\);/);
    
    expect(notifySrc).not.toContain('setAppUserModelId("com.slime.gui")');
    expect(notifySrc).toContain("app.setAppUserModelId(APP_AUMID)");
    
    expect(notifySrc).toMatch(/if \(!r\.ok\)[\s\S]{0,120}?console\.warn/);
  });
});

describe("A-1021 ②：图标定义唯一 + 停止键无外环、几何居中、尺寸够大", () => {
  const iconSrc = read(ICON_TSX);
  const chatSrc = read(CHAT_PANEL);

  it("Icon.tsx 里每个图标函数名唯一（本轮真的把 StopIcon 定义了两遍）", () => {
    const names = [...iconSrc.matchAll(/export function (\w*Icon\w*)\s*\(/g)].map((m) => m[1]);
    expect(names.length, "一个图标都没扫到 → 正则失效了").toBeGreaterThan(50);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    expect([...new Set(dup)], "同名图标重复定义：tsc 报 TS2300，但 vitest 那条路径上没有任何东西拦得住")
      .toEqual([]);
  });

  it("StopIcon = 单个圆角方块（无外环）且中心精确落在 512/512", () => {
    const at = iconSrc.indexOf("export function StopIcon");
    expect(at).toBeGreaterThan(-1);
    
    const next = iconSrc.indexOf("export function ", at + 10);
    const body = iconSrc.slice(at, next > 0 ? next : undefined);
    expect(body, "停止图标不许有外环（圆底已经承担了'圆'的语义，套环 = 圈里套圈 + 方块被挤小）")
      .not.toContain("<circle");
    const paths = [...body.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths, "StopIcon 应当只有一条 path").toHaveLength(1);
    
    expect(paths[0]).toContain("M314 250h396a64 64 0 0 1 64 64v396");
    expect(paths[0]).toContain("H314a64 64 0 0 1-64-64V314a64 64 0 0 1 64-64z");
  });

  it("终止按钮用 StopIcon（不再用带环的 TerminateIcon），比例由常量派生而非手填数字", () => {
    expect(chatSrc, "圆形按钮里再用带外环的图标 = 圈里套圈").not.toContain("TerminateIcon");
    
    
    expect(chatSrc, "终止按钮的图标尺寸必须是符号常量，不允许再手填数字")
      .toContain("<StopIcon size={STOP_ICON_SIZE} />");
    expect(chatSrc).not.toMatch(/<StopIcon size=\{\d+\}/);

    
    expect(chatSrc).toMatch(/width: STOP_BTN_SIZE, height: STOP_BTN_SIZE, borderRadius: "50%"/);

    
    const btn = /const STOP_BTN_SIZE = (\d+);/.exec(chatSrc);
    expect(btn, "取不到 STOP_BTN_SIZE → 这条守卫自己失效了").toBeTruthy();
    const icon = /const STOP_ICON_SIZE = Math\.round\(\(STOP_BTN_SIZE \* ([\d.]+)\) \/ ([\d.]+)\);/.exec(chatSrc);
    expect(icon, "取不到 STOP_ICON_SIZE 的派生式 → 这条守卫自己失效了").toBeTruthy();
    const targetRatio = Number(icon![1]);

    
    
    
    
    
    const stopAt = iconSrc.indexOf("export function StopIcon");
    const stopNext = iconSrc.indexOf("export function ", stopAt + 10);
    const stopBody = iconSrc.slice(stopAt, stopNext > 0 ? stopNext : undefined);
    const d = /<path d="([^"]+)"/.exec(stopBody);
    expect(d, "取不到 StopIcon 的 path").toBeTruthy();
    const geo = /M(\d+) (\d+)h(\d+)a(\d+) \d+ 0 0 1 \d+ \d+v(\d+)a/.exec(d![1]);
    expect(geo, "StopIcon 的 path 形状变了（已经不是'圆角方块'的 M/h/v/a 结构）").toBeTruthy();
    const [, , , w, r, h] = geo!;
    const edge = (Number(w) + 2 * Number(r)) / 1024;
    expect(Number(h), "方块宽高不一致 → 不再是正方形").toBe(Number(w));
    expect(edge, `StopIcon 方块占比漂到了 ${edge.toFixed(3)}`).toBeCloseTo(Number(icon![2]), 2);

    
    
    expect(targetRatio, `方块占圆底 ${(targetRatio * 100).toFixed(0)}%，超出常规区间`).toBeGreaterThanOrEqual(0.36);
    expect(targetRatio, `方块占圆底 ${(targetRatio * 100).toFixed(0)}%，超出常规区间`).toBeLessThanOrEqual(0.44);
    expect(Number(btn![1])).toBeGreaterThan(0);
    expect(chatSrc).toContain("{stopping ? <LoadingCircleIcon size={20} /> : <StopIcon");
  });
});

describe("A-1021 ③：活动记录的「完成」用图标，不再是文字胶囊（A-1028 收口：单色 + 单一槽位）", () => {
  const sideSrc = read(RIGHT_SIDEBAR);

  it("done 徽标带 Icon: DoneIcon，且 DoneIcon 已导入", () => {
    expect(sideSrc, "DoneIcon 没导入 → 类型检查会红，但这条守着'别再退回文字'")
      .toMatch(/import\s*\{[\s\S]{0,400}?DoneIcon/);
    expect(sideSrc).toMatch(/case "done":\s*return \{[^}]*Icon: DoneIcon/);
  });

  it("行首符号槽位只有一条实现：工具图标与 done 图标共用 .task-badge .task-badge-icon + 行内配色", () => {
    
    
    expect(sideSrc).toContain("const RowIcon = (ev.tool ? resolveToolLabel(ev.tool).Icon : null) ?? b.Icon ?? null;");
    expect(sideSrc).not.toContain("const BadgeIcon = b.Icon ?? null;"); 
    
    const m = /<span className="task-badge task-badge-icon" title=\{rowTitle\}([\s\S]*?)<\/span>/.exec(sideSrc);
    expect(m, "取不到统一图标槽位 → 这条守卫自己失效了").toBeTruthy();
    expect(m![0]).toContain("style={{ color: b.color, background: b.bg }}");
    
    expect(sideSrc).toContain('<span className="task-badge" style={{ color: b.color, background: b.bg }}>{b.text}</span>');
  });

  it("完成后不再出现「✓」——勾由图标表达，文字只留「回复完成」", () => {
    expect(sideSrc).toContain('pushEvent("done", m?.interrupted ? "⏹ 已中断" : "回复完成")');
    expect(sideSrc).not.toContain("✓ 回复完成");
  });

  it("DoneIcon 是单色图标（圆改环 + currentColor），不许再有白勾/写死底色", () => {
    const iconSrc = read(ICON_TSX);
    const m = /export function DoneIcon\([\s\S]*?\n\}/.exec(iconSrc);
    expect(m, "取不到 DoneIcon 定义 → 守卫失效").toBeTruthy();
    const body = m![0];
    expect(body, "勾必须跟随 currentColor").not.toContain("#fff");
    expect(body, "不再接受 accent 参数（那只服务于写死底色的双色版本）").not.toContain("accent");
    expect(body, '圆底必须是环（fill="none" + stroke=currentColor）').toMatch(/<circle[^>]*fill="none"[^>]*stroke="currentColor"/);
  });
});
