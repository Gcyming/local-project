/**
 * tests/gui/a1101-backend-console.spec.ts — A-1101：后端控制台「看不懂」的守卫。
 *
 * 用户原话（截图 = cmd 窗口）：「我不是发你了吗？就这个 cmd 窗口，你看看上一轮解决了吗」。
 *
 * ⚠️ 先把事实说清：**上一轮（A-1100）修的是渲染层 DevTools 的 `Uncaught (in promise)`，
 *    不是这个窗口** —— 这是两条不同的链路（渲染层 ⇄ 主进程 IPC vs 主进程转发后端 stdout/stderr）。
 *    这个窗口里**没有一条真正的 error**，它「看起来全是报错」是三层因素叠出来的
 *    （⚠️ 按本机实测**分层定责**，不把三层混为一谈）：
 *
 * | 层 | 事实（本机实测） | 是不是本机乱码/误读的**活跃层** |
 * |---|---|---|
 * | ① 管道编码 | venv 解释器(3.12.9) `sys.stdout.encoding = utf-8`（系统开了「Beta: UTF-8」）—— **本机本来就是 UTF-8** | ✗（但未开该设置/换版本的机器上默认 cp936 ⇒ 写解错开 = 双重乱码，属**部署面加固**） |
 * | ② 流向 | root logger 不配 handler 走 lastResort（**stderr**）、uvicorn 默认 log config 也写 **stderr**，GUI 把 stderr 一律冠 `[slime-server:err]` | ✓ **误读的根因**：`[slime-server:err] INFO: Application startup complete.` —— 启动成功被标成错误 |
 * | ③ 终端渲染 | `chcp` 实测 **CP936**；node 把正确的 UTF-8 字节写进这个窗口 | ✓ **天书的根因**：`[gui:skills] 錦杭濤伐鍵…`、`[slime-server:err] WARNING:root …` 全是天书 |
 *
 * 修法（与层一一对应，**缺一层照样翻车**）：
 *   ① spawn 侧 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`（把写侧钉死，与 `data.toString()` 的 UTF-8 **成对**）；
 *   ② `slime_server.py` 顶部 `logging.basicConfig(stream=sys.stdout)` + `uvicorn.run(log_config=None)`
 *      —— stderr 只剩真正的 traceback，`:err` 前缀重新名副其实；
 *   ③ `gui/scripts/dev-utf8.mjs` 先 `chcp 65001` 再拉 electron-vite（dev 入口自带，不靠"记得手动敲"）。
 *
 * 判据一句话：
 *   · **写与解必须同口径**（python 写 UTF-8 ⇄ node 解 UTF-8 —— 只改一侧 = 更彻底的乱码）；
 *   · **`[slime-server:err]` 只许承载真正的错误**（INFO/WARNING 必须走 stdout）；
 *   · **编码层不许依赖"记得手动 chcp"**（dev 入口脚本必须自带）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会故意写旧写法/变量名，不剥就是假红/假绿） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const MAIN = stripComments(readSrc("gui/src/main/index.ts"));
const SERVER_RAW = readSrc("slime_server.py");
/** python 的 # 注释也剥掉（注释里写着旧写法） */
const SERVER = SERVER_RAW
  .split("\n")
  .filter((l) => !/^[ \t]*#/.test(l))
  .join("\n");
const PKG = JSON.parse(readSrc("gui/package.json")) as { scripts: Record<string, string> };
const DEV_UTF8 = stripComments(readSrc("gui/scripts/dev-utf8.mjs"));

/* ───────────── ① 写与解同口径：python 管道必须是 UTF-8 ───────────── */

describe("A-1101 ① — python 管道编码：写（PYTHONUTF8/PYTHONIOENCODING）与解（toString）必须成对（部署面加固）", () => {
  it("T1 spawn env 必须同时带 `PYTHONUTF8: \"1\"` 与 `PYTHONIOENCODING`（防写解两侧随环境漂开）", () => {
    expect(MAIN,
      "缺 `PYTHONUTF8=1` —— 管道编码就跟着解释器版本与系统设置走"
      + "（未开「Beta: UTF-8」的 Windows 上 locale.getpreferredencoding = cp936），"
      + "一旦与 `data.toString()` 的 UTF-8 解码错开 = 双重乱码且极难归因"
      + "（⚠️ 本机实测已是 utf-8，故这一条是**加固**而非本机乱码的根因 —— 别拿它当万灵药）",
    ).toContain('PYTHONUTF8: "1"');
    expect(MAIN,
      "缺 `PYTHONIOENCODING` —— 它显式钉住 std* 管道编码，"
      + "是 PYTHONUTF8 覆盖不到的场景（旧版解释器/特殊环境）的兜底",
    ).toContain("PYTHONIOENCODING:");
  });

  it("T2 `PYTHONIOENCODING` 的值必须是 utf-8（写成 gbk/cp936 = 把乱码钉死）", () => {
    expect(MAIN, "PYTHONIOENCODING 必须显式给值（缺省=跟本地走）").toMatch(/PYTHONIOENCODING:\s*"utf-8"/);
    expect(MAIN, "把 PYTHONIOENCODING 配成 GBK 系 = 与 toString() 的 UTF-8 解码对着干").not.toMatch(
      /PYTHONIOENCODING:\s*"(gbk|cp936|gb2312)"/i,
    );
  });
});

/* ───────────── ② `[slime-server:err]` 只许承载真正的错误 ───────────── */

describe("A-1101 ② — python 日志统一走 stdout（INFO/WARNING 不许再被标成 err）", () => {
  it("T3 `logging.basicConfig(stream=sys.stdout)` 必须存在，且在**第一处 logging 调用之前**", () => {
    const configuredAt = SERVER_RAW.indexOf("logging.basicConfig(");
    const streamAt = SERVER_RAW.indexOf("stream=sys.stdout");
    expect(configuredAt, "缺 basicConfig —— root logger 走 lastResort（stderr），INFO 全被冠成 :err").toBeGreaterThan(-1);
    expect(streamAt, "basicConfig 存在但没把流指到 stdout —— 等于没修").toBeGreaterThan(-1);
    /* ⚠️ basicConfig 在 root 已有 handler 时是 no-op —— 所以「位置」不是风格问题，是功能问题：
       必须抢在任何 logging.* 调用之前。 */
    const firstLogCall = SERVER_RAW.indexOf("logging.warning(") >= 0
      ? Math.min(...["logging.warning(", "logging.info(", "logging.debug(", "logging.error("]
          .map((k) => SERVER_RAW.indexOf(k))
          .filter((i) => i >= 0))
      : -1;
    expect(firstLogCall,
      "slime_server.py 里居然没有 logging 调用（锚点失效）").toBeGreaterThan(-1);
    expect(configuredAt,
      "basicConfig 必须在第一处 logging 调用**之前** —— 晚了就是 no-op，等于没修",
    ).toBeLessThan(firstLogCall);
  });

  it("T4 `import sys` 必须存在（stream=sys.stdout 依赖它，缺了直接 NameError）", () => {
    expect(SERVER, "缺 `import sys` —— stream=sys.stdout 会 NameError，后端起不来").toMatch(
      /^import sys$/m,
    );
  });

  it("T5 `uvicorn.run` 必须带 `log_config=None`（否则 uvicorn 自装 stderr handler，INFO 又回 err 通道）", () => {
    const run = SERVER_RAW.indexOf("uvicorn.run(");
    expect(run, "找不到 uvicorn.run（锚点失效）").toBeGreaterThan(-1);
    const runBody = SERVER_RAW.slice(run, SERVER_RAW.indexOf(")", run) + 1);
    expect(runBody,
      "uvicorn.run 缺 `log_config=None` —— 它默认的 log config 把 INFO 写进 stderr，"
      + "GUI 又冠以 [slime-server:err] ⇒ 用户把「Application startup complete」当报错（用户截图实测）",
    ).toContain("log_config=None");
  });
});

/* ───────────── ③ dev 终端：编码不许依赖「记得手动 chcp」 ───────────── */

describe("A-1101 ③ — dev 入口必须自带 `chcp 65001`（cmd 默认 CP936 渲染 UTF-8 = 天书）", () => {
  it("T6 `dev` 脚本必须经 dev-utf8.mjs（不许直接 electron-vite dev）", () => {
    expect(PKG.scripts.dev,
      "dev 直接拉 electron-vite —— 终端代码页没人管，主进程自己的中文日志照样天书（用户截图实测）",
    ).toContain("dev-utf8.mjs");
  });

  it("T7 dev-utf8.mjs 必须在 win32 分支里 `chcp 65001`，且失败只 warn 不中断 dev", () => {
    expect(DEV_UTF8, "缺 win32 判断 —— Linux/macOS 没有 chcp，直接跑会炸").toContain('platform() === "win32"');
    expect(DEV_UTF8, "缺 `chcp 65001` —— 编码没切，等于没修").toContain('"65001"');
    /* 失败必须出声但不许挡 dev：编码是体验不是功能（`continue`/`return` 静默跳过 = 又一个静默失效）。 */
    expect(DEV_UTF8,
      "chcp 失败必须 console.warn（静默跳过 = 「为什么还乱码」无从排查）",
    ).toMatch(/console\.warn\(/);
    expect(DEV_UTF8, "electron-vite 必须由本脚本拉起（stdio inherit），否则 chcp 白切").toContain(
      'spawn("electron-vite"',
    );
  });
});
