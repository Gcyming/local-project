/**
 * tests/core-ts/product.spec.ts —— 产品身份的**防漂移守卫**。
 *
 * PRODUCT_VERSION 是写死的常量（理由见 core-ts/src/product.ts）。写死就会烂，
 * 所以这里把它和根`package.json` 的 `version` 钉在一起：谁改了其中一个没改另一个，
 * 这条测试立刻红。宁可红在对齐上，也不要红在「线上两个地方报着不同的版本号」。
 *
 * 另外顺带钉住身份**策略**的两条边界，防止以后有人「顺手统一」：
 *   · 申请类 →诚实 `slime/<version>`
 *   · 抓取类 → 完整浏览器 UA，不挂非标准尾巴（半伪装两头不讨好）
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME, PRODUCT_VERSION, productUserAgent } from "../../core-ts/src/product.js";
import { UA as SEARCH_UA } from "../../core-ts/src/search/onlineSearch.js";
import { CRAWLER_UA } from "../../core-ts/src/websearch/crawler.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("产品身份单一产地", () => {
  it("PRODUCT_VERSION 与根 package.json 的 version 逐字一致", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: unknown };
    expect(typeof pkg.version).toBe("string");
    expect(PRODUCT_VERSION).toBe(pkg.version);
  });

  it("gui/package.json 也跟同一个版本（发版三处同源，漏一处就该红）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "gui", "package.json"), "utf8")) as { version?: unknown };
    expect(PRODUCT_VERSION).toBe(pkg.version);
  });

  it("productUserAgent 形如 slime/<version>", () => {
    expect(PRODUCT_NAME).toBe("slime");
    expect(productUserAgent()).toBe(`slime/${PRODUCT_VERSION}`);
  });

  it("身份里不出现本机路径/用户名形态的东西（防把cwd 拼进 UA）", () => {
    const ua = productUserAgent();
    // 正斜杠是合法的 name/version 分隔符，要禁的是**本机路径**形态：
    // 反斜杠（Windows 路径）、盘符冒号、以及多段路径。
    expect(ua).not.toContain("\\");
    expect(ua).not.toMatch(/[A-Za-z]:/);
    expect(ua.split("/")).toHaveLength(2);
    expect(ua.split("/")[0]).toBe(PRODUCT_NAME);
  });
});

describe("身份策略：申请类 vs 抓取类不许混", () => {
  it("抓取类 UA 必须是完整浏览器 UA，不带slime-agent 这类非标准尾巴", () => {
    // 反例长这样：Mozilla/5.0 (Windows NT 10.0; Win64; x64) slime-agent
    //—— 伪装成浏览器却挂私有尾巴：骗不过按 UA 白名单的反爬，又主动暴露身份。
    expect(SEARCH_UA).not.toContain("slime-agent");
    for (const part of ["Mozilla/5.0", "AppleWebKit/537.36", "Chrome/", "Safari/537.36"]) {
      expect(SEARCH_UA).toContain(part);
    }
  });

  it("爬虫 UA 是SlimeMiniBot（robots 里声明的 agent 名要对得上）", () => {
    // crawler.ts 的 robotsAllows() 只会匹配 slimeminibot / *，
    // UA 与这份声明必须同源，否则等于对robots 撒谎。
    expect(CRAWLER_UA.toLowerCase()).toContain("slimeminibot");
  });
});
