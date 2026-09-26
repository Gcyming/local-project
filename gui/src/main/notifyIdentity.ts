/**
 * gui/src/main/notifyIdentity.ts — 系统通知的**身份与文案**（唯一出处，不依赖 Electron）。
 *
 * ── 为什么必须有这个模块（A-1021 的真实根因）──────────────────────────────
 * 用户截图里通知的**头部那一行**显示的是 `com.slime.gui`，而它**不是** `Notification({title})`：
 *
 *     ┌──────────────────────────────────────────────┐
 *     │ com.slime.gui                          …  ✕  │ ← 应用身份行（AUMID 解析出的名字）
 *     │ test1 已完成                                  │ ← 这才是 Notification({title})
 *     │ Hey there! ...                                │ ← body
 *     └──────────────────────────────────────────────┘
 *
 * Windows 的 toast 是**按应用身份（AUMID）寻址**的，头部那行「应用名」来自系统对该 AUMID 的
 * 品牌信息，取值优先级：
 *   ① 开始菜单里带 `System.AppUserModel.ID = <AUMID>` 的快捷方式（用快捷方式的名字与图标）
 *      —— 这是文档里对**打包/安装版**的常规路径（electron-builder NSIS 会建）。
 *   ② 注册表 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 下的 `DisplayName`（+ `IconUri`）
 *      —— 这是微软给**未打包应用**的路径（`DesktopNotificationManagerCompat::Register` 就是
 *      往这里写 DisplayName/IconUri）。**无需管理员**，且运行时即可写。
 *   ③ 都没有 → Windows 只好把 **AUMID 原文**顶上去 —— 就是用户看到的 `com.slime.gui`。
 *
 * 本机取证（2026-09-19）：
 *   · `HKCU\Software\Classes\AppUserModelId\com.slime.gui` → **不存在**（同根键下 Nutstore
 *     等应用都注册了，所以它们通知里显示的是正常名字）；
 *   · `HKCU\...\Notifications\Settings\com.slime.gui` → **存在**且有 `LastNotificationAddedTime`
 *     → 通知确实以该 AUMID 发出并被系统接收，只是**没有可显示的应用名**。
 *
 * ⚠️ 所以：**改 `Notification({title})` 修不掉头部那行**。曾经把标题写死成程序名是错的 ——
 *   那只会让第二行与头部重复，白白吃掉 toast 里本可用于事件信息的空间。标题就应该是事件
 *   文案（「xxx 已完成」），身份行才该是程序名。两者分工，见 `buildNotificationPayload`。
 *
 * ⚠️ 纯逻辑与 IO 分家的理由：本文件**不 import electron**，所以 `tests/core-ts/a1021-guards.spec.ts`
 *   能直接导入断言。`notify.ts` 顶层 `import { app, Notification } from "electron"` 在 vitest 里
 *   拿到的是 undefined（electron 的 CJS 入口只导出一个**可执行文件路径字符串**），能跑不能跑
 *   全看 bundler interop —— 属"今天绿明天红"的定时炸弹。
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * 应用身份（AUMID）。
 * ⚠️ 必须与 `gui/electron-builder.json` 的 `appId` **完全一致**：装出来的快捷方式、
 *   通知设置项、以及 `app.setAppUserModelId()` 三者不同则通知无法归属（会没有来源标识）。
 */
export const APP_AUMID = "com.slime.gui";

/**
 * 通知头部那行显示的**程序名**（唯一出处）。
 * ⚠️ 与窗口标题 `app.setName("Slime")` 的大小写刻意不同：程序在界面上自称 **slime**，
 *   通知也应一致。改名只改这一处 —— 任何调用点都不许自己拼这个名字。
 */
export const APP_DISPLAY_NAME = "slime";

/** 系统通知的最终载荷（`{ title, body }`） */
export interface NotifyPayload {
  title: string;
  body: string;
}

/**
 * 由事件构造系统通知载荷。**纯函数**（不碰 Electron）。
 *
 * 分工（A-1021 更正）：`title` = **事件标题**（「xxx 已完成」/「… 出错」），`body` = 正文。
 * 标题**不**放程序名 —— 那是身份行的职责（见 `APP_DISPLAY_NAME`），重复填只会挤掉有效信息。
 */
export function buildNotificationPayload(ev: { title?: string; body?: string }): NotifyPayload {
  const title = (ev.title ?? "").trim();
  const body = (ev.body ?? "").trim();
  // 标题与正文相同时只留一处（少数调用点两处传了同一句，重复显示很难看）
  const dedupedBody = title === body ? "" : body;
  return { title: title || APP_DISPLAY_NAME, body: dedupedBody };
}

/**
 * Windows 通知图片的**硬约束**（一手来源：MS Learn「磁贴、Toast 和锁屏提醒通知疑难解答」
 * `dn457490` / `dn457491` 与「Tile and toast visual assets」`hh781198`）：
 *
 *   Images for all notifications must be smaller than 1024 x 1024 pixels and less than
 *   200 KB in size. **If any image in a notification exceeds any of these dimensions,
 *   the notification will be discarded.**
 *
 * ⇒ 超限的后果**不是"图标糊一点"**，而是图标静默不显示（HEAD 那格空白）甚至整条通知被丢弃。
 *   本项目的通知图标资产必须按这两条验收，见 `checkNotifyImage()` + `notifyIconFileName()`。
 */
export const NOTIFY_IMAGE_MAX_BYTES = 200 * 1024;
export const NOTIFY_IMAGE_MAX_DIM = 1024;

/** 验收结果（`ok=false` 时 `reason` 说明差在哪 —— 调用方照实报，不许静默） */
export interface NotifyImageVerdict { ok: boolean; reason: string }

/**
 * 按 Windows 通知约束验收一张位图。**纯函数**（尺寸/体积由调用方量好传进来）。
 *
 * 为什么要有它：`gui/build/icon.png` 是**安装器用的大图**（实测 1024×1024 / 951.7 KB），
 * 直接拿去当 toast 图标会触发上面那条"整条丢弃"。这张图此前被 `notificationIconPath()`
 * 当成通知图标用（A-1055 把口径从数据根改成安装根，方向对了、但**选错了那张图**）——
 * 于是头部那格仍然什么都没有，而代码、类型检查、日志全绿。
 */
export function checkNotifyImage(meta: { bytes: number; width?: number; height?: number }): NotifyImageVerdict {
  if (meta.bytes > NOTIFY_IMAGE_MAX_BYTES) {
    return { ok: false, reason: `体积 ${(meta.bytes / 1024).toFixed(1)} KB 超过上限 ${NOTIFY_IMAGE_MAX_BYTES / 1024} KB` };
  }
  if (meta.width !== undefined && meta.width > NOTIFY_IMAGE_MAX_DIM) {
    return { ok: false, reason: `宽 ${meta.width}px 超过上限 ${NOTIFY_IMAGE_MAX_DIM}px` };
  }
  if (meta.height !== undefined && meta.height > NOTIFY_IMAGE_MAX_DIM) {
    return { ok: false, reason: `高 ${meta.height}px 超过上限 ${NOTIFY_IMAGE_MAX_DIM}px` };
  }
  return { ok: true, reason: "符合 Windows 通知图片约束" };
}

/**
 * 通知图标的**文件名**（唯一出处）。
 *
 * ⚠️ 刻意**不是** `icon.png`：那张是安装器/窗口用的大图（951.7 KB），当 toast 图标会被系统丢弃。
 *   通知用图由 `gui/scripts/make-notify-icon.mjs` 由大图降采样生成（256×256 / ~59 KB），
 *   两条路径不许混用 —— 换成 `icon.png` 就等于把 #228 原样复活。
 */
export function notifyIconFileName(): string {
  return "notify-icon.png";
}

/** 一个待写入的注册表值 */
export interface AumidRegistryValue { name: string; value: string }

/** `applyWindowsNotificationIdentity()` 的结果（便于调用方如实报因，不许静默） */
export interface IdentityApplyResult { ok: boolean; detail: string }

/** 注册表路径（HKCU → 无需管理员）。抽成函数便于单测断言"写的就是这个位置"。 */
export function aumidRegistryKey(aumid: string = APP_AUMID): string {
  return `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`;
}

/**
 * 本地图片路径 → Windows 通知身份可用的 `file://` URI。
 *
 * 为什么要单独做这件事（而不是直接拼 `file://` + 路径）：
 *   · 反斜杠必须转正斜杠（`reg` 里写 `file:///C:\a\b.png` 会被系统当非法 URI → 图标位空白）；
 *   · 路径里可能有**空格/中文/括号**（本项目实机路径就是 `D:\...\pilot project\...`），
 *     空格在 URI 里是非法字符，必须逐段 percent-encode（只编码段，保留 `/` 与盘符冒号）；
 *   · 只接受位图扩展名：toast 的 IconUri 支持 .png/.jpg，**不接受 .ico/.svg**
 *     （写错扩展名不会报错，只会静默显示不出图标 —— 又是一个"静默失败"）。
 *
 * 返回 null = 这个路径不能当通知图标用（调用方据此**不写** IconUri，而不是写一个坏 URI）。
 */
export function pngFileUri(p: string | null | undefined): string | null {
  if (!p) { return null; }
  const norm = p.replace(/\\/g, "/").trim();
  if (!/^[a-zA-Z]:\//.test(norm) && !norm.startsWith("/")) { return null; }
  if (!/\.(png|jpe?g)$/i.test(norm)) { return null; }
  const encoded = norm.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  // 盘符段 `C:` 不该被编码（encodeURIComponent("C:") = "C%3A"），还原它
  return `file:///${encoded.replace(/^([a-zA-Z])%3A\//, "$1:/")}`;
}

/**
 * 需要写入注册表的值（纯数据 → 可单测）。
 *
 * A-1055：**恢复写入 `IconUri`**（此前刻意只写 DisplayName，见下方历史注）。
 * 用户本轮反馈的是「通知弹窗的图标不是 slime 的应用图标」——
 *   · `Notification({icon})` 只影响 toast **正文区**的小图，且本项目此前指向的
 *     `PROJECT_ROOT/build/icon.png` 在打包版**根本不存在**（数据根 ≠ 安装根）→ 退化成 Electron 默认图标；
 *   · toast **头部（应用身份行）**的图标由本 AUMID 的 `IconUri` 决定 —— 不写就永远没有。
 * 两处都指向同一张安装根位图，才谈得上"图标是 slime 的"。URI 由 pngFileUri 严格校验，
 * 不合格就**不写**（宁可没有图标，也不写一个坏 URI）。
 */
export function aumidRegistryValues(displayName: string = APP_DISPLAY_NAME, iconPath?: string | null): AumidRegistryValue[] {
  const values: AumidRegistryValue[] = [{ name: "DisplayName", value: displayName }];
  const uri = pngFileUri(iconPath);
  if (uri) { values.push({ name: "IconUri", value: uri }); }
  return values;
}

/** reg.exe 的绝对路径（不依赖 PATH） */
function regExe(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
}

/** 读取该 AUMID 当前的若干值（name → value）；键/值不存在时对应项为 null */
function currentValues(key: string, names: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const n of names) { out[n] = null; }
  try {
    const res = execFileSync(regExe(), ["query", key], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    for (const n of names) {
      const m = new RegExp(`${n}\\s+REG_SZ\\s+(.+?)\\s*$`, "m").exec(res);
      if (m) { out[n] = m[1]; }
    }
  } catch {
    // reg query 对"键不存在"返回非零 → 全部视为未注册
  }
  return out;
}

/**
 * 注册 Windows 通知的应用身份（**幂等**：全部值已是目标值就直接返回，不动注册表）。
 *
 * ⚠️ 幂等判据必须覆盖**全部**要写的值（A-1055 修正）：此前只比对 DisplayName ——
 *   v0.0.6 已把 DisplayName 写成 "slime"，于是补 IconUri 的那一版会被这条短路直接跳过，
 *   图标永远补不上，而日志还报"已注册，跳过"（典型静默失效）。
 *
 * 非 Windows 平台返回 `{ok:true, detail:"skipped"}`（macOS/Linux 用 Bundle ID / .desktop 名，
 * 不适用这条路径）。任何失败都**如实返回原因**，由调用方决定打印 —— 静默失败是精度杀手。
 *
 * `iconPath`：通知图标位图（安装根 `build/icon.png`）。传入者负责保证它存在
 * （本模块不 import electron，因此**不能**自己去推 INSTALL_ROOT）。
 */
export function applyWindowsNotificationIdentity(iconPath?: string | null): IdentityApplyResult {
  if (process.platform !== "win32") { return { ok: true, detail: "非 Windows，跳过 AUMID 注册" }; }
  const key = aumidRegistryKey();
  const values = aumidRegistryValues(APP_DISPLAY_NAME, iconPath);
  const cur = currentValues(key, values.map((v) => v.name));
  const stale = values.filter((v) => cur[v.name] !== v.value);
  if (stale.length === 0) {
    return { ok: true, detail: `已注册（${values.map((v) => `${v.name}=${v.value}`).join(" / ")}），跳过` };
  }
  try {
    // ⚠️ `reg add` 一条命令**只接受一组** `/v /t /d`（本机实测 2026-09-25：
    //   两组塞一条 → **exit 1** + 打印用法帮助；逐值两条 → **exit 0** 且 reg query 回读两值俱在）。
    //   A-1055 引入 IconUri 后的写法正是把两组塞一条 ⇒ 注册**每次启动都在失败**，
    //   toast 头部一直退回 `com.slime.gui`、图标一直缺席，而这行 warn 天天在响。
    //   ⇒ 逐值写入（每个值一次调用），失败**逐值**如实上报。
    // ⚠️ 失败信息**只报退出码、不透传 reg 的 stderr**：那是控制台代码页文本（本机 936），
    //   在 UTF-8 终端里必然渲染成乱码（用户截图里 `[notify]` 下面那坨天书就是它），
    //   除了吓人没有任何信息量；要复现细节就手动跑注释里的命令（参数全 ASCII，可读）。
    const failures: string[] = [];
    for (const v of values) {
      try {
        execFileSync(regExe(), ["add", key, "/f", "/v", v.name, "/t", "REG_SZ", "/d", v.value], {
          windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (e) {
        const err = e as { status?: number };
        failures.push(`${v.name}（reg add 退出码 ${err.status ?? "未知"}）`);
      }
    }
    if (failures.length > 0) {
      return { ok: false, detail: `写注册表失败：${failures.join("；")}` };
    }
    const got = currentValues(key, values.map((v) => v.name));
    const bad = values.filter((v) => got[v.name] !== v.value);
    return bad.length === 0
      ? { ok: true, detail: `已写入 ${key} → ${values.map((v) => `${v.name}=${v.value}`).join(" / ")}` }
      : { ok: false, detail: `写入后回读不符：${bad.map((v) => `${v.name} 期望 ${v.value} 实际 ${got[v.name] ?? "(读不到)"}`).join("；")}` };
  } catch (e) {
    return { ok: false, detail: `写注册表失败：${(e as Error)?.message ?? String(e)}` };
  }
}
