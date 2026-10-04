




























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const MAIN = stripComments(readSrc("gui/src/main/index.ts"));
const SERVER_RAW = readSrc("slime_server.py");

const SERVER = SERVER_RAW
  .split("\n")
  .filter((l) => !/^[ \t]*#/.test(l))
  .join("\n");
const PKG = JSON.parse(readSrc("gui/package.json")) as { scripts: Record<string, string> };
const DEV_UTF8 = stripComments(readSrc("gui/scripts/dev-utf8.mjs"));



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



describe("A-1101 ② — python 日志统一走 stdout（INFO/WARNING 不许再被标成 err）", () => {
  it("T3 `logging.basicConfig(stream=sys.stdout)` 必须存在，且在**第一处 logging 调用之前**", () => {
    const configuredAt = SERVER_RAW.indexOf("logging.basicConfig(");
    const streamAt = SERVER_RAW.indexOf("stream=sys.stdout");
    expect(configuredAt, "缺 basicConfig —— root logger 走 lastResort（stderr），INFO 全被冠成 :err").toBeGreaterThan(-1);
    expect(streamAt, "basicConfig 存在但没把流指到 stdout —— 等于没修").toBeGreaterThan(-1);
    

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



describe("A-1101 ③ — dev 入口必须自带 `chcp 65001`（cmd 默认 CP936 渲染 UTF-8 = 天书）", () => {
  it("T6 `dev` 脚本必须经 dev-utf8.mjs（不许直接 electron-vite dev）", () => {
    expect(PKG.scripts.dev,
      "dev 直接拉 electron-vite —— 终端代码页没人管，主进程自己的中文日志照样天书（用户截图实测）",
    ).toContain("dev-utf8.mjs");
  });

  it("T7 dev-utf8.mjs 必须在 win32 分支里 `chcp 65001`，且失败只 warn 不中断 dev", () => {
    expect(DEV_UTF8, "缺 win32 判断 —— Linux/macOS 没有 chcp，直接跑会炸").toContain('platform() === "win32"');
    expect(DEV_UTF8, "缺 `chcp 65001` —— 编码没切，等于没修").toContain('"65001"');
    
    expect(DEV_UTF8,
      "chcp 失败必须 console.warn（静默跳过 = 「为什么还乱码」无从排查）",
    ).toMatch(/console\.warn\(/);
    expect(DEV_UTF8, "electron-vite 必须由本脚本拉起（stdio inherit），否则 chcp 白切").toContain(
      'spawn("electron-vite"',
    );
  });
});
