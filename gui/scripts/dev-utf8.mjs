#!/usr/bin/env node
/**
 * gui/scripts/dev-utf8.mjs — dev 终端的**编码统一入口**（A-1101）。
 *
 * ## 为什么需要它（用户实测的截图）
 *
 * dev 模式下主进程日志经 **字节管道**（pnpm → electron-vite → 终端）落到 cmd 窗口，
 * 而 cmd 默认代码页是 **CP936（GBK）** —— 收到 UTF-8 字节流就渲染成天书：
 * `[gui:skills] 錦杭濤伐鍵峰凡灝辮…`。**本机实测（cmd //c chcp = 活动代码页 936）：
 * 这就是天书的唯一活跃层** —— python 管道那侧在本机本来就是 UTF-8
 * （系统开了「Beta: UTF-8」，`sys.stdout.encoding = utf-8`）。
 *
 * 之所以还要在 spawn 侧钉 `PYTHONUTF8` / `PYTHONIOENCODING`（见 `gui/src/main/index.ts`
 * startPythonBackend）：那是**部署面加固** —— 未开该设置/换解释器版本的机器上管道默认 cp936，
 * 与 node 的 UTF-8 解码错开就是**双重乱码**。**两层口径各自钉死，才不随环境漂。**
 *
 * ## 做什么
 *
 *   win32：先把当前控制台切到 **65001（UTF-8）**，再拉起 electron-vite（stdio inherit）。
 *   其它平台：直接透传（无 chcp；Linux/macOS 终端本就是 UTF-8）。
 *
 * ⚠️ chcp 对"共享控制台"生效 —— 本脚本由 cmd 里的 pnpm 拉起，与其共用同一控制台，
 *    故子进程里调用即可改到那个窗口（无需管理员）。
 * ⚠️ chcp 失败**不许**中断 dev（编码只是体验，不是功能）—— 打 warn 继续。
 */
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const isWin = platform() === "win32";

if (isWin) {
  const r = spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore" });
  if (r.status !== 0) {
    console.warn("[dev] `chcp 65001` 失败（终端代码页未切换，中文日志可能乱码；不影响功能）");
  }
}

/* `shell` 仅 win32 需要：`.bin/electron-vite` 在 Windows 是 .cmd 垫片，不经 shell 找不到；
   非 Windows 直接 exec（省一层 shell，Ctrl+C 语义也更直接）。 */
const child = spawn("electron-vite", ["dev"], { stdio: "inherit", shell: isWin });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
/* 转发终止信号：electron-vite 收到 SIGINT 会带走它自己的子进程；这里兜底防孤儿。 */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) { child.kill(sig); }
  });
}
