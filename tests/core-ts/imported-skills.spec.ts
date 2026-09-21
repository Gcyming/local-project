/**
 * tests/core-ts/imported-skills.spec.ts — 第三方技能「导入健全性」守卫（A-1053）。
 *
 * 背景：一次导入 8 个上游技能（6 个来自 mattpocock/skills，MIT；drawio-skill，MIT；
 * web-access，上游无 LICENSE 文件但 SKILL.md 声明 MIT）。它们以 `gui/template/skills/`
 * 为 tracked 正本，随 extraFiles 进安装包，首启播种进 `${SLIME_ROOT}/config/skills`。
 *
 * 盯的三类**静默失败**（都不报错，只是能力悄悄少一块）：
 *  ① **清单解析失败 → 描述断掉**：slime 用的是**自研的 YAML 子集解析器**（`parseMiniYaml`，
 *     不是 js-yaml），它的 docstring 自己记过一次事故：遇到 `description: >` 会把字面量 `">"`
 *     当描述存进去 ——「技能库一条描述都出不来」。导入是批量的、上游清单形态各异，
 *     所以必须**用真实加载器逐个过一遍**，而不是只检查文件在不在。
 *  ② **导了但没随包**：只落 `config/`（被 .gitignore 整目录忽略）→ 换台机器/全新安装就没了。
 *     与 A-1050 同源，对**新导入的技能**再锁一次。
 *  ③ **权限声明与实际能力不符**：带可执行脚本的技能若声明 `terminal: false, network: false`，
 *     今天无害（`skill.py` 执行已被禁用，权限不被消费），但**将来一旦重启脚本执行**，
 *     `checkPermissions` 会因为「全 false 直接跳过」而**静默放行**这些能力 —— 一个埋在未来
 *     某次重构里的越权口子。现在按实声明，等于把这条路径提前堵上。
 *
 * ⚠️ 验收标准是**变异测试**：写完必须逐条把源码/内容改坏、确认它变红。
 *    "通过但锁错对象"比没有守卫更糟 —— 本文件第一版的 D 组就写过一条**假守卫**
 *    （断言二进制「UTF-8 往返无损」，而合法二进制必然有损 → 永远误报）。见 D 组注释。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../../core-ts/src/skills.js";
import { DEFAULT_TOOL_PROFILE } from "../../core-ts/src/services/agentTools.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** tracked 的随包技能正本（extraFiles → 安装根 template/skills）。 */
const SEED_DIR = join(ROOT, "gui", "template", "skills");

/** 本次导入的 8 个技能：目录名 → 来源仓库。 */
const IMPORTED: Record<string, string> = {
  "grill-me": "https://github.com/mattpocock/skills",
  "grill-with-docs": "https://github.com/mattpocock/skills",
  "tdd": "https://github.com/mattpocock/skills",
  "triage": "https://github.com/mattpocock/skills",
  "handoff": "https://github.com/mattpocock/skills",
  "improve-codebase-architecture": "https://github.com/mattpocock/skills",
  "drawio-skill": "https://github.com/Agents365-ai/drawio-skill",
  "web-access": "https://github.com/eze-is/web-access",
};

/** 声明了 terminal/network 的（因为它们在 scripts/ 下真的起进程 / 发请求）。 */
const SCRIPT_BEARING = ["web-access", "drawio-skill"];

/** 目录里的可执行脚本（判定「实际能力」，不靠清单自称）。 */
const SCRIPT_EXT = /\.(py|mjs|cjs|js|sh|bat|ps1)$/i;

/** 块标量头被误当描述的字面量（解析器 docstring 记录的事故形态）。 */
const BLOCK_SCALAR_HEADERS = new Set([">", "|", ">-", "|-", ">+", "|+"]);

function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); } else if (SCRIPT_EXT.test(e)) { out.push(p); }
    }
  };
  walk(dir);
  return out;
}

function manifestText(name: string): string {
  return readFileSync(join(SEED_DIR, name, "manifest.yaml"), "utf8");
}

/**
 * 该文件的字节能否安全当文本处理（UTF-8 往返无损）—— 与变异脚本
 * `gui/scripts/mut-a1053-import.mjs` 里的同名守卫**同一判据**：
 * 它落笔前用这个拒绝把二进制当文本变异，这里用它反查二进制有没有被洗过。
 *
 * ⚠️ 对二进制而言**期望值是 `false`**（合法二进制含非法 UTF-8 字节）。
 *    写成「必须 `true`」就是假守卫，见 D 组注释。
 */
function isLosslessText(buf: Buffer): boolean {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

describe("A-1053 A 组：真实加载器必须吃下全部随包技能", () => {
  let reg: SkillRegistry;
  let loaded: string[] = [];

  beforeAll(async () => {
    // 用**真实注册表**跑一遍：自研 YAML 子集解析器在这里被真正执行
    reg = new SkillRegistry({ skillDir: SEED_DIR });
    loaded = await reg.loadSkills();
  });

  it("随包技能全部加载成功（有目录名却加载不到 = 静默丢失）", () => {
    const dirs = readdirSync(SEED_DIR).filter((e) => {
      if (e.startsWith(".")) { return false; }
      try { return statSync(join(SEED_DIR, e)).isDirectory(); } catch { return false; }
    });
    expect(dirs.length).toBe(18);
    expect([...loaded].sort()).toEqual([...dirs].sort());
  });

  it("每个随包技能的描述都非空，且不是块标量头（`>` / `|`）—— 解析器吃过这个亏", () => {
    const bad: string[] = [];
    for (const name of loaded) {
      const d = (reg.get(name)?.description ?? "").trim();
      if (d === "" || BLOCK_SCALAR_HEADERS.has(d)) { bad.push(`${name}=${JSON.stringify(d)}`); }
    }
    expect(bad, `以下技能描述为空/被解析成块标量头（技能库会一条描述都出不来）：${bad.join("、")}`).toEqual([]);
  });

  it("每个随包技能都读到了正文（指导模式的唯一内容来源）", () => {
    const empty = loaded.filter((n) => ((reg.get(n)?.body ?? "").length === 0));
    expect(empty, `以下技能正文为空：${empty.join("、")}`).toEqual([]);
  });

  it("导入的 8 个技能逐个加载成功（名字与目录名一致）", () => {
    for (const name of Object.keys(IMPORTED)) {
      expect(loaded, `未加载到 ${name}`).toContain(name);
      expect(reg.get(name)?.name).toBe(name);
    }
  });
});

describe("A-1053 B 组：导入的实质不变式", () => {
  let reg: SkillRegistry;

  beforeAll(async () => {
    reg = new SkillRegistry({ skillDir: SEED_DIR });
    await reg.loadSkills();
  });

  it("8 个技能都真的在 tracked 模板目录里（防「只落 config/、换台机器就没了」）", () => {
    const missing = Object.keys(IMPORTED).filter((n) => !existsSync(join(SEED_DIR, n, "SKILL.md")));
    expect(missing, `不在 gui/template/skills/ 里（全新安装会静默失去）：${missing.join("、")}`).toEqual([]);
  });

  it("每个导入的技能都带 manifest.yaml（上游只有 SKILL.md，清单是本仓补的）", () => {
    const missing = Object.keys(IMPORTED).filter((n) => !existsSync(join(SEED_DIR, n, "manifest.yaml")));
    expect(missing).toEqual([]);
  });

  it("**带可执行脚本的技能必须按实声明 terminal/network** —— 否则将来重启脚本执行会静默放行", () => {
    const liars: string[] = [];
    for (const name of SCRIPT_BEARING) {
      const scripts = scriptFiles(join(SEED_DIR, name));
      expect(scripts.length, `${name} 预期含脚本，否则这条守卫空转`).toBeGreaterThan(0);
      // 断言的是**引擎真正消费的那份解析结果**（manifest.permissions），不是文件文本
      const perms = (reg.get(name)?.manifest.permissions ?? {}) as Record<string, boolean>;
      if (perms.terminal !== true || perms.network !== true) {
        liars.push(`${name}(terminal=${perms.terminal},network=${perms.network})`);
      }
    }
    expect(liars, `以下技能有脚本却声明无 terminal/network（越权口子）：${liars.join("、")}`).toEqual([]);
  });

  it("纯指导型技能（无脚本）保持最小权限 read-only", () => {
    const offenders: string[] = [];
    for (const name of Object.keys(IMPORTED).filter((n) => !SCRIPT_BEARING.includes(n))) {
      const scripts = scriptFiles(join(SEED_DIR, name));
      if (scripts.length > 0) { offenders.push(`${name}(意外含脚本)`); continue; }
      const perms = (reg.get(name)?.manifest.permissions ?? {}) as Record<string, boolean>;
      if (perms.terminal === true || perms.network === true) { offenders.push(`${name}(无脚本却声明权限)`); }
    }
    expect(offenders).toEqual([]);
  });

  it("导入的技能不含 skill.py（那是被禁用的 RCE 执行入口，不该被顺手带进来）", () => {
    const hits = Object.keys(IMPORTED).filter((n) => existsSync(join(SEED_DIR, n, "skill.py")));
    expect(hits).toEqual([]);
  });

  it("导入的技能都留了上游溯源（升级/审计时要能回到来源）", () => {
    const missing: string[] = [];
    for (const [name, repo] of Object.entries(IMPORTED)) {
      const m = manifestText(name);
      if (!/^source:\s*\S+/m.test(m) || !m.includes(repo)) { missing.push(name); }
    }
    expect(missing, `以下技能缺 source 溯源：${missing.join("、")}`).toEqual([]);
  });

  it("A-1050 的默认集不因本次导入被破坏（声明的默认技能仍在模板目录里）", () => {
    const missing = DEFAULT_TOOL_PROFILE.skills.filter((n) => !existsSync(join(SEED_DIR, n, "SKILL.md")));
    expect(missing).toEqual([]);
  });
});

describe("A-1053 C 组：变异脚本自身不得破坏技能目录（本次实测踩到的坑）", () => {
  const scriptSrc = readFileSync(join(ROOT, "gui", "scripts", "mut-a1053-import.mjs"), "utf8");
  /** 去掉注释后的代码（注释里**故意**引用了错误写法，不剥会自伤）。 */
  const code = scriptSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("快照必须按**字节**读（readFileSync(p)），不得 readFileSync(p, 'utf8')", () => {
    expect(code, "按 utf8 快照会把二进制（.gz/.png）UTF-8 往返碾碎").not.toMatch(
      /readFileSync\(\s*p\s*,\s*["']utf8["']\s*\)/,
    );
  });

  it("快照 / 还原 / hash 三处都必须走 Buffer 语义", () => {
    expect(code).toMatch(/const snapshot[\s\S]{0,220}readFileSync\(p\)/);
    expect(code).toMatch(/const restore[\s\S]{0,160}writeFileSync\(p,\s*buf\)/);
    expect(code).toMatch(/const sha[\s\S]{0,140}update\(buf\)/);
  });

  it("还原校验必须含**逐文件字节比对** —— 只看整树指纹会用自己的错误数据自证通过", () => {
    expect(code, "缺二进制逐文件复核 → 碾碎二进制后仍会打印「已还原 ✓」").toMatch(/binBroken/);
    expect(code).toMatch(/readFileSync\(p\)\.equals\(b\)/);
  });

  it("变异只允许打在无损 UTF-8 文本上（拒绝把二进制当文本改）", () => {
    expect(code).toMatch(/isLosslessText/);
    expect(code, "缺该检查 → 有人把二进制文件写进 MUTATIONS 就静默报废").toMatch(/拒绝把它当文本变异/);
  });
});

describe("A-1053 D 组：随包技能里不得混入被碾碎的二进制", () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p, out); } else { out.push(p); }
    }
    return out;
  };

  it("所有 .gz 都是合法 gzip（魔数 1f8b）", () => {
    const gz = walk(SEED_DIR).filter((p) => p.toLowerCase().endsWith(".gz"));
    expect(gz.length, "没有 .gz 可查 → 这条守卫会空转").toBeGreaterThan(0);
    const bad: string[] = [];
    for (const p of gz) {
      const buf = readFileSync(p);
      if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
        bad.push(`${relative(SEED_DIR, p)}(魔数 ${buf.subarray(0, 2).toString("hex")})`);
      }
    }
    expect(bad, `以下 .gz 不是合法 gzip（被当文本改写就会变成这样）：${bad.join("、")}`).toEqual([]);
  });

  it(".gz 必须**真的能解开**（魔数对不代表内容没坏 —— 这是「技能还能用」的最终判据）", () => {
    const gz = walk(SEED_DIR).filter((p) => p.toLowerCase().endsWith(".gz"));
    const broken: string[] = [];
    for (const p of gz) {
      try {
        const json = JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
        // 解开只是第一步：内容还得是**非空的索引**，否则技能拿到一份空表也照样「不报错」
        const n = Array.isArray(json) ? json.length : Object.keys(json).length;
        if (n <= 0) { broken.push(`${relative(SEED_DIR, p)}(解出空内容)`); }
      } catch (e) {
        broken.push(`${relative(SEED_DIR, p)}(${(e as Error).message})`);
      }
    }
    expect(broken, `以下 .gz 解不开（典型成因：被当文本读写，UTF-8 往返碾碎）：${broken.join("、")}`).toEqual([]);
  });

  it("二进制必须仍含**原始高位字节** —— 被当文本处理过就会暴露（⚠️ 断言不能写成「UTF-8 往返无损」）", () => {
    // 不变式：合法二进制（gzip 头、压缩后的载荷）本就含**非法 UTF-8 字节**。
    //   `Buffer.from(buf.toString("utf8"), "utf8")` 会把这些字节换成 U+FFFD，
    //   再编码回去必然 !== 原 buffer —— 所以「往返无损」对**任何**合法二进制都是 false，
    //   拿它当"必须成立"的断言就是**假守卫**（第一版正是这么写错的，永远误报）。
    //   反过来才是真正的不变式：二进制**必须**往返有损；一旦有损性消失，
    //   说明它已被当成文本洗过一遍（高位字节 → U+FFFD），恰是碾碎的特征。
    const bins = walk(SEED_DIR).filter((p) => /\.(gz|zip|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|npz|onnx)$/i.test(p));
    expect(bins.length, "没有二进制可查 → 这条守卫空转").toBeGreaterThan(0);
    const scrubbed = bins.filter((p) => isLosslessText(readFileSync(p)));
    expect(
      scrubbed,
      `以下二进制已不含原始高位字节（已被当文本洗过）：${scrubbed.map((p) => relative(SEED_DIR, p)).join("、")}`,
    ).toEqual([]);

    // 反空转：文本文件必须**是**无损的 —— 否则上面那条对「永远返回 false」的实现也成立
    const notes = walk(SEED_DIR).filter((p) => p.toLowerCase().endsWith(".md"));
    expect(notes.length).toBeGreaterThan(0);
    const brokenText = notes.filter((p) => !isLosslessText(readFileSync(p)));
    expect(brokenText, "文本文件不该含非法 UTF-8 字节").toEqual([]);
  });
});
