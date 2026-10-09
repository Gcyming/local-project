/**
 * gui/src/main/dataRoot.ts — 运行时数据根的单一来源。
 *
 * ## 为什么要有这个文件（用户实测缺陷）
 * 用户报：「skill 等一堆数据还是在 C 盘（%APPDATA%\\slime-gui），我在安装时和设置里都定义过了」。
 * 排查结论是两件事叠在一起：
 *   ① **数据根不可配置**：boot.ts 把数据根写死成 `join(app.getPath("userData"), "slime-data")`，
 *      用户在任何地方选的路径都不会被用到 —— 选了也是白选；
 *   ② **运行时状态散落在安装目录**：crashGuard / watchdog / 子代理台账 / 定时任务等都往
 *      `<安装目录>/data`、`<安装目录>/config` 写，于是用户的 D:\\…\\slimecode 下凭空长出
 *      `data\\run.lock`、`config\\requests.json`。安装目录在 Program Files 下经常不可写，
 *      升级时还会被整个替换 —— 这些文件本来就该住在数据根里。
 *
 * ## 口径（三条，改动前先自问）
 *   · 数据根的**选择记录**只能放在 app.getPath("userData") —— 它不能放在数据根自己里面，
 *     否则「换目录」这件事在读之前就要先知道目录，鸡生蛋。
 *   · 迁移只做**复制**（不许移动/删除来源）：原始数据原地保留，失败了也不丢。
 *   · 切换**必须重启**才彻底生效：core-ts 的 PROJECT_ROOT 是模块级常量，
 *     在进程启动时求值一次；这里只负责决定它等于什么。
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 数据根选择记录的落点（必须在 app 数据目录，而不是数据根自己里面）。 */
export function dataRootPointerPath(): string {
  return join(app.getPath("userData"), "slime-data-root.json");
}

/** 出厂默认：%APPDATA%\\<app>\\slime-data（开发模式走另一条，避免污染仓库）。 */
export function defaultDataRoot(): string {
  return app.isPackaged
    ? join(app.getPath("userData"), "slime-data")
    : join(app.getPath("userData"), "slime-data-dev");
}

export interface DataRootPointer {
  root: string;
}

/** 读取用户选择的数据根；没选过 / 记录损坏 / 目标不可用 ⇒ 返回 null（调用方回落默认）。 */
export function readDataRootPointer(): string | null {
  try {
    const raw = readFileSync(dataRootPointerPath(), "utf8").trim();
    if (!raw) { return null; }
    const parsed = JSON.parse(raw) as DataRootPointer;
    const root = typeof parsed?.root === "string" ? parsed.root.trim() : "";
    if (!root) { return null; }
    return resolve(root);
  } catch {
    return null;
  }
}

/** 写入选择记录（**不创建目录**，也**不迁移**——这两件事由数据根切换流程显式发起）。 */
export function writeDataRootPointer(root: string): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(dataRootPointerPath(), JSON.stringify({ root: resolve(root) }, null, 2), "utf8");
  } catch (e) {
    throw new Error(`数据根记录写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 回到出厂默认（清除选择记录，不清数据本身）。 */
export function clearDataRootPointer(): void {
  try {
    writeFileSync(dataRootPointerPath(), JSON.stringify({ root: "" }, null, 2), "utf8");
  } catch {
    // 清不掉也不影响：下次启动读到空值会自己回落默认
  }
}

function pickWritableRoot(): string {
  const picked = readDataRootPointer();
  if (picked) {
    try {
      mkdirSync(picked, { recursive: true });
      return picked;
    } catch {
      // 选过的目录不可写（U 盘拔了 / 权限变了）⇒ 回落默认，启动不能因此失败
      console.warn(`[gui:dataRoot] 已选数据根不可用（${picked}），本次回落到默认位置`);
    }
  }
  return defaultDataRoot();
}

/** 本次进程真正生效的数据根（模块级常量 —— 进程生命周期内不变，改它必须重启进程）。 */
export const RUNTIME_DATA_DIR = pickWritableRoot();

/** 运行时可写状态的根目录（crash 日志 / 任务台账 / 生成物等），随数据根走。 */
export function runtimeStateDir(): string {
  const dir = join(RUNTIME_DATA_DIR, "runtime");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // 建不出来时调用方会拿到具体错误；这里也必须出声（项目铁律：静默失效必须出声）——
    // 否则「运行时状态目录建不出来」这件事只有后来写文件报错时才现形，根因无从追。
    console.warn(`[gui:dataRoot] 运行时状态目录创建失败（${dir}）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return dir;
}

/** 当前数据根是否来自用户的显式选择（用于 UI 上标明「自定义 / 默认」）。 */
export function isCustomDataRoot(): boolean {
  return readDataRootPointer() !== null;
}

export function dataRootExists(dir: string): boolean {
  try {
    return existsSync(dir);
  } catch {
    return false;
  }
}
