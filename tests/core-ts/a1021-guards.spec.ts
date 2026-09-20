/**
 * tests/core-ts/a1021-guards.spec.ts — A-1021 的**结构/不变量守卫**。
 *
 * 这一轮四件事，共同点都是"改回去**不报错**、跑起来也不崩，只有用户放大截图才看得出来"：
 *  ① 工具卡状态徽标（成功/失败）**字不在胶囊中心** —— 旧实现用 `text-align: right` 对齐，
 *     那是"贴右边缘"不是居中（实测左空 ~43px / 右空 ~20px）。断言已在 a1018 ⑥ 同轮更新。
 *  ② 系统通知的**头部那行应用名**显示成 `com.slime.gui`（= AUMID / electron-builder 的 appId）。
 *     ⚠️ 它**不是** `Notification({title})` —— 那是第二行。头部那行来自系统对该 AUMID 的
 *     品牌信息（开始菜单快捷方式，或 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 的
 *     DisplayName）；两者都没有时 Windows 只能把 AUMID 原文顶上去。本机取证见
 *     `gui/src/main/notifyIdentity.ts` 的文件头。
 *  ③ 活动记录里冒出文字徽标「完成」→ 换成 `D:\下载\完成.svg` 转出的图标。
 *  ④ 终止按钮的图形"特别小 + 不在正中间"→ 换成无外环的圆角方块并放大到圆底的 ~51%。
 *
 * ⚠️ 每条守卫都**必须过变异测试**（改坏被锁的结构 → 红），否则会"通过但锁错对象"。
 *     A-1019 实锤过两次这类假绿（正则命中文件开头 `body, #root, .app {` 块；`indexOf` 取到
 *     同名行的第一处）。本文件的做法：**对正则只允许在单条规则块内匹配**（用 `[^}]*` 卡住
 *     不跨 `}`），对"取第 N 处"的场合一律改用**数量守恒 + 具名断言**而不是位置偏移。
 *
 * ⚠️ ②这条能做**行为断言**，是因为纯逻辑已从 `notify.ts` 分家到 `notifyPayload.ts`：
 *     `notify.ts` 顶层 `import { app, Notification } from "electron"`，在 vitest 里导入它
 *     拿到的 `app`/`Notification` 是 undefined（electron 的 CJS 入口只导出一个**可执行文件
 *     路径字符串**），能跑不能跑全看 bundler interop —— 属于"今天绿明天红"的定时炸弹。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_AUMID, APP_DISPLAY_NAME, aumidRegistryKey, aumidRegistryValues, buildNotificationPayload } from "../../gui/src/main/notifyIdentity.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ICON_TSX = join(ROOT, "gui/src/renderer/components/Icon.tsx");
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");
const RIGHT_SIDEBAR = join(ROOT, "gui/src/renderer/pages/RightSidebar.tsx");
const NOTIFY_TS = join(ROOT, "gui/src/main/notify.ts");
const BUILD_CFG = join(ROOT, "gui/electron-builder.json");
const MAIN_DIR = join(ROOT, "gui/src/main");

const read = (p: string): string => readFileSync(p, "utf8");

/** 递归收集目录下所有 .ts（不含 .tsx/d.ts）源码 */
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

  it("注册位置与值：HKCU\\Software\\Classes\\AppUserModelId\\<AUMID> → DisplayName", () => {
    // 未打包应用的正规路径（微软 DesktopNotificationManagerCompat::Register 同一位置）
    expect(aumidRegistryKey("com.example.app")).toBe("HKCU\\Software\\Classes\\AppUserModelId\\com.example.app");
    const vals = aumidRegistryValues("slime");
    expect(vals).toEqual([{ name: "DisplayName", value: "slime" }]);
    // 默认实参也要对（调用点不传参时用的就是默认值）
    expect(aumidRegistryKey()).toContain(`AppUserModelId\\${APP_AUMID}`);
    expect(aumidRegistryValues()[0].value).toBe(APP_DISPLAY_NAME);
    // ⚠️ 故意不写 IconUri：本轮只修"名字不对"，加图标会引入新失败面（见源码注释）
    expect(aumidRegistryValues().map((v) => v.name)).not.toContain("IconUri");
  });

  it("标题是**事件文案**，不许被程序名顶掉（顶掉会让第二行与头部重复、白占 toast 空间）", () => {
    expect(buildNotificationPayload({ title: "test1 已完成", body: "Hey" }))
      .toEqual({ title: "test1 已完成", body: "Hey" });
    expect(buildNotificationPayload({ title: "  X  " })).toEqual({ title: "X", body: "" });
    // 标题与正文相同 → 只留一处
    expect(buildNotificationPayload({ title: "X", body: "X" })).toEqual({ title: "X", body: "" });
    // 无标题时兜底用程序名（此时头部身份行可能还没被系统刷新，别留空标题）
    expect(buildNotificationPayload({ body: "B" })).toEqual({ title: "slime", body: "B" });
  });

  it("唯一实现：main 里 `new Notification(` 只有一处；身份注册挂在 initNotify 路径上", () => {
    const hits = walkTs(MAIN_DIR).flatMap((f) =>
      f.src.split("\n").map((l, i) => ({ f, l, n: i + 1 })).filter((x) => x.l.includes("new Notification(")));
    expect(hits.map((h) => `${h.f.path}:${h.n}`), "通知必须只有一个构造点（多处构造 = 各处都要记得改）")
      .toHaveLength(1);
    const notifySrc = read(NOTIFY_TS);
    // 身份注册必须在 initNotify 里被调用 —— 否则 DisplayName 永远写不进去，
    // 而通知依然会弹（头部还是包名），这种"能跑但错"的状态没有任何测试拦得住。
    expect(notifySrc).toMatch(/export function initNotify\([\s\S]{0,200}?ensureNotificationIdentity\(\);/);
    // AUMID 只能用常量，不许再出现硬编码字面量（两处各写一遍迟早漂移）
    expect(notifySrc).not.toContain('setAppUserModelId("com.slime.gui")');
    expect(notifySrc).toContain("app.setAppUserModelId(APP_AUMID)");
    // 身份注册失败不许静默（静默失败 = 下一个人只能靠用户截图才发现）
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
    // 只取本函数体（到下一个 export function 为止），避免读到邻居的 path
    const next = iconSrc.indexOf("export function ", at + 10);
    const body = iconSrc.slice(at, next > 0 ? next : undefined);
    expect(body, "停止图标不许有外环（圆底已经承担了'圆'的语义，套环 = 圈里套圈 + 方块被挤小）")
      .not.toContain("<circle");
    const paths = [...body.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths, "StopIcon 应当只有一条 path").toHaveLength(1);
    // 几何：跨 [250,774] → 中心 (512,512)；半径 64 的圆角
    expect(paths[0]).toContain("M314 250h396a64 64 0 0 1 64 64v396");
    expect(paths[0]).toContain("H314a64 64 0 0 1-64-64V314a64 64 0 0 1 64-64z");
  });

  it("终止按钮用 StopIcon（不再用带环的 TerminateIcon），比例由常量派生而非手填数字", () => {
    expect(chatSrc, "圆形按钮里再用带外环的图标 = 圈里套圈").not.toContain("TerminateIcon");
    // A-1021b：尺寸改成符号常量。此前这条锁的是 `size={数字}` 且要求 ≥30 —— 那正是用户
    // 反馈"你这个也太大了"的那版（方块占圆底 51%），**守卫把 bug 锁住了**。现在改成锁关系。
    expect(chatSrc, "终止按钮的图标尺寸必须是符号常量，不允许再手填数字")
      .toContain("<StopIcon size={STOP_ICON_SIZE} />");
    expect(chatSrc).not.toMatch(/<StopIcon size=\{\d+\}/);

    // ① 圆底直径唯一出处：按钮的 width/height 都必须引用它，不许再出现字面量
    expect(chatSrc).toMatch(/width: STOP_BTN_SIZE, height: STOP_BTN_SIZE, borderRadius: "50%"/);

    // ② 目标比例（方块占圆底）从源码里解析出来，与"当前值"无关地做区间断言
    const btn = /const STOP_BTN_SIZE = (\d+);/.exec(chatSrc);
    expect(btn, "取不到 STOP_BTN_SIZE → 这条守卫自己失效了").toBeTruthy();
    const icon = /const STOP_ICON_SIZE = Math\.round\(\(STOP_BTN_SIZE \* ([\d.]+)\) \/ ([\d.]+)\);/.exec(chatSrc);
    expect(icon, "取不到 STOP_ICON_SIZE 的派生式 → 这条守卫自己失效了").toBeTruthy();
    const targetRatio = Number(icon![1]);

    // ③ 派生式里的除数 `0.512` 必须真的等于图标自己的方块占比（跨文件漂移检测）：
    //    改动 Icon.tsx 的方块尺寸却忘了改这里 → 实际比例会静默偏离，只有用户放大截图才看得出来。
    //    ⚠️ 不要用"抓所有数字取 min/max"来求边长：圆的 path 里还有圆弧标志位（0/1）与半径，
    //    那样 min 会落到 1 上（实测把 0.512 算成 0.306，守卫自己先错）。只解构方块那两段：
    //      M<X> <Y>h<W>a<R>…v<H>…  →  边长 = W + 2R（左右各一个圆角），高 = H + 2R。
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

    // ④ 区间：Material FAB / YouTube 播控的方块约占圆底 38%~42%。
    //    51%（旧值 36）="太大了"，26%（更旧的 18）="特别小" —— 两端都要拦住。
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
    // A-1028：此前 done 走的是旁路（`.task-badge-icon` 透明底 + 13px + 不挂 .task-badge），
    // 于是同一列里它更大、还自带实心色块 —— 与上下行不是一个语言。
    expect(sideSrc).toContain("const RowIcon = (ev.tool ? resolveToolLabel(ev.tool).Icon : null) ?? b.Icon ?? null;");
    expect(sideSrc).not.toContain("const BadgeIcon = b.Icon ?? null;"); // 旁路已删
    // 唯一的图标分支：同一个 class + 同一份 color/bg（改一处即两处同时生效）
    const m = /<span className="task-badge task-badge-icon" title=\{rowTitle\}([\s\S]*?)<\/span>/.exec(sideSrc);
    expect(m, "取不到统一图标槽位 → 这条守卫自己失效了").toBeTruthy();
    expect(m![0]).toContain("style={{ color: b.color, background: b.bg }}");
    // 未挂图标的行仍然保留文字胶囊分支（工具/思考/进度/失败）
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
