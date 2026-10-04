





















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const IDENTITY_RAW = readSrc("gui/src/main/notifyIdentity.ts");
const IDENTITY = stripComments(IDENTITY_RAW);


function applyBody(): string {
  const at = IDENTITY.indexOf("export function applyWindowsNotificationIdentity(");
  expect(at, "找不到 applyWindowsNotificationIdentity（锚点失效）").toBeGreaterThan(-1);
  const next = IDENTITY.indexOf("\nexport ", at + 10);
  return IDENTITY.slice(at, next < 0 ? undefined : next);
}

describe("A-1102 — reg add 一条命令只许一组 `/v /t /d`（两组塞一条 = 注册每次启动都失败）", () => {
  it("T1 【根因】逐值写入：单值参数数组恰好一组 /v /t /d，且不许再有 args.push 拼接形态", () => {
    const body = applyBody();
    expect(body,
      "找不到「单值」reg add 参数数组 —— 写入逻辑可能被重排了，守卫需要跟着迁（不许删）",
    ).toContain('["add", key, "/f", "/v", v.name, "/t", "REG_SZ", "/d", v.value]');
    expect(body,
      "出现了 `args.push(` 拼接形态 —— 那正是 A-1055 引入 IconUri 后"
      + "「两组 /v /t /d 塞一条 reg add」的旧写法（真机实测 exit 1，注册从未成功过）",
    ).not.toContain("args.push(");
  });

  it("T2 失败必须逐值上报且带退出码（静默吞掉 = 头部退回包名却没人知道为什么）", () => {
    const body = applyBody();
    expect(body,
      "失败收集不见了 —— reg add 一旦失败，toast 头部退回包名/无图标而日志无声（静默失效）",
    ).toContain("failures.push(");
    expect(body,
      "失败信息必须带 `reg add 退出码` —— 只有一句「写注册表失败」无法归因（哪一项？什么错？）",
    ).toContain("退出码");
    expect(body,
      "失败必须让 applyWindowsNotificationIdentity 返回 ok:false（调用方据此打 warn）",
    ).toMatch(/failures\.length > 0/);
  });

  it("T3 失败信息不许透传 reg 的 stderr（控制台代码页文本在 UTF-8 终端必然乱码）", () => {
    const body = applyBody();
    

    expect(body,
      "把原始异常 message / stderr（含 reg 的 GBK 用法帮助）透传给了调用方 —— 在 UTF-8 终端里必然乱码",
    ).not.toMatch(/failures\.push\([^)]*\.(message|stderr)/);
    expect(body,
      "失败信息里没有退出码 —— 用户将无法区分「语法错/权限错/键错」",
    ).toMatch(/err\.status/);
  });

  it("T4 回读校验必须还在（写完不回读 = 写没写进去都不知道，又是静默失效）", () => {
    const body = applyBody();
    expect(body,
      "回读比对不见了 —— 写完不查，写没写进去全凭信仰",
    ).toContain("got[v.name] !== v.value");
    expect(body,
      "回读不符的分支不见了（「写入后回读不符」）",
    ).toContain("写入后回读不符");
  });
});
