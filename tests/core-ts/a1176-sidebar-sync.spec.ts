



























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));


const ruleBody = (re: RegExp): string | null => {
  const m = re.exec(CSS_CODE);
  return m ? m[1] : null;
};
const durOf = (s: string): string | null => {
  const m = /transition:\s*width\s+([0-9.]+m?s)/.exec(s);
  return m ? m[1] : null;
};

describe("A-1176 浮层态「展开左栏」右栏必须同步让位（不许秒让）", () => {
  it("存在**浮层稳态**的 `rw` 宽度过渡规则（且排除过渡期与退场期）", () => {
    

    const body = ruleBody(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s*\{([^}]*)\}/);
    expect(body, "找不到浮层稳态的 `.right-wrapper` 规则 ⇒ 右栏会「秒让」（用户现象）").toBeTruthy();
    expect(body, "这条规则里没有 `transition: width` ⇒ 右栏宽度仍然一帧到位").toMatch(/transition:\s*width\s/);
  });

  it("这条过渡的时长/缓动与 `.sidebar` 的 `transition: width` **逐字一致**（否则仍是一快一慢）", () => {
    const rwBody = ruleBody(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s*\{([^}]*)\}/);
    const sbBody = ruleBody(/(?:^|\n)\.sidebar\s*\{([^}]*)\}/);
    expect(rwBody, "找不到 rw 的浮层稳态规则").toBeTruthy();
    expect(sbBody, "找不到顶层 `.sidebar { … }` 规则").toBeTruthy();
    const rwDur = durOf(rwBody!);
    const sbDur = durOf(sbBody!);
    expect(rwDur, "rw 那条没写 `transition: width <时长>`").toBeTruthy();
    expect(sbDur, "`.sidebar` 没写 `transition: width <时长>`（守卫自己失效了）").toBeTruthy();
    expect(rwDur, `右栏让位时长 ${rwDur} 与左栏 ${sbDur} 不等 ⇒ 仍然不协调`).toBe(sbDur);
    const rwEase = /transition:\s*width\s+[0-9.]+m?s\s+([^;]+)/.exec(rwBody!);
    const sbEase = /transition:\s*width\s+[0-9.]+m?s\s+([^;]+)/.exec(sbBody!);
    expect((rwEase && rwEase[1].trim()) || "", "两者的缓动函数也必须一致（否则节奏不同）")
      .toBe((sbEase && sbEase[1].trim()) || "");
  });

  it("**不许**给普通态（非浮层）的 `.right-wrapper` 加宽度过渡（`auto` 不可插值）", () => {
    


    const all = [...CSS_CODE.matchAll(/(?:^|\n)([^{\n]*\.right-wrapper[^{\n]*)\{([^}]*)\}/g)];
    for (const m of all) {
      const sel = m[1].trim();
      const body = m[2];
      if (!/transition:\s*width/.test(body)) { continue; }
      expect(sel, `\`${sel}\` 给普通态的 .right-wrapper 加了宽度过渡 ⇒ \`auto\` 不可插值、过渡不会启动（A-1157 的坑）`)
        .toContain("float-layout");
    }
  });
});
