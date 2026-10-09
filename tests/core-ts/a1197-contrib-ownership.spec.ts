/**
 * tests/core-ts/a1197-contrib-ownership.spec.ts — 「本次新建 vs 改既有」的归属守卫
 *
 * ## 这一轮堵的是哪个口子
 * A-1197 上一轮把 `config/skills`、`config/plugins` 从受保护目录清单里**整目录豁免**了
 * （那是为了修「Agent 造不了插件 / 总是被拒绝」）。但整目录豁免的含义是
 * **任何 Agent 都能写这两个目录下的任何一个插件/技能目录** —— 包括改别人的、
 * 以及在 config/plugins 下**新建一个与内置插件同名的目录**（同名清单重复 ⇒ 装载失败，
 * 等于变相把内置能力下线）。
 *
 * ## 判据（单一真相源在 shared/security-policy.yaml §⑤，本文件只断言它被实现）
 * 判在**资产目录**层（config/plugins/<名字>、config/skills/<名字>），三条：
 *   ① 资产目录**不存在** ⇒ 放行（这就是「新建」）；
 *   ② 已存在、但自带来源声明 origin=agent ⇒ 放行（这就是「迭代自己刚建的」）；
 *   ③ 命中内置保留资产目录（contribution_reserved_assets）⇒ 拦，且**与来源标记无关**。
 * 其余（既有、无声明、或声明不是 agent）⇒ 拦 ⇒ 「改别人的 / 改内置的」仍有保护。
 *
 * ## 为什么必须用**真磁盘**写夹具，而不是照 a1197-contrib-write 那样只传路径字符串
 * 归属判据**要读磁盘**（目录是否存在、标记文件里写了什么）⇒ 用字符串断言等于没断言。
 * 而 a1197-contrib-write 用的是不存在的假根（C:\slime-data），在判据①下**全部算新建**，
 * 所以它对「改既有」零覆盖 —— 这正是本文件存在的理由，两者互补而不是重复。
 *
 * ⚠️ 夹具一律建在系统临时目录，**不许碰仓库里真实的 config/skills**（那是用户的技能库）。
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isProtectedSourcePath } from "../../core-ts/src/tools/classifier.js";
import { hardRuleCheck } from "../../core-ts/src/tools/hard_rules.js";
import {
  CONTRIBUTION_OWNER_FIELD,
  CONTRIBUTION_OWNER_VALUE,
  CONTRIBUTION_OWNER_MARKERS,
  CONTRIBUTION_RESERVED_ASSETS,
} from "../../shared/gen/security-policy.js";

/** 假的「运行时数据根」：判据要读磁盘，所以这个目录**必须真的被建出来**。 */
let ROOT = "";

const P = (...seg: string[]): string => join(ROOT, ...seg);

/** blocked = 这条写入会被硬规则拦住。 */
const blk = (abs: string): boolean =>
  hardRuleCheck({ name: "file_write", riskKind: "write", target: abs, projectRoot: ROOT }).blocked;

function put(relPath: string, content: string): void {
  const abs = join(ROOT, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const AGENT_PLUGIN = JSON.stringify(
  { name: "demo-tool", version: "1.0.0", description: "d", origin: "agent", provides: ["instructions"] },
  null, 2,
);

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "a1197-ownership-"));

  /* ── 既有**别人/内置**的资产（无 agent 来源声明）⇒ 必须拦 ── */
  put("config/plugins/other-tool/plugin.json", JSON.stringify({
    name: "other-tool", version: "1.0.0", description: "d", origin: "user", provides: ["instructions"],
  }));
  put("config/skills/builtin-skill/manifest.yaml", "name: builtin-skill\nversion: '1.0'\ndescription: d\n");
  put("config/skills/builtin-skill/SKILL.md", "---\nname: builtin-skill\ndescription: d\n---\n\n正文\n");
  // 声明存在但取值不是 agent（market / user / 乱写都归这一类）
  put("config/plugins/market-tool/plugin.json", JSON.stringify({
    name: "market-tool", version: "1.0.0", description: "d", origin: "market", provides: ["instructions"],
  }));
  // 既有目录但**完全没有标记文件**（读不到来源 ⇒ fail-closed 拦住）
  put("config/plugins/bare-tool/README.md", "无清单无来源声明\n");

  /* ── 既有**自己建的**资产（origin=agent）⇒ 迭代必须放行 ── */
  put("config/plugins/my-own-tool/plugin.json", AGENT_PLUGIN);
  put("config/plugins/my-own-tool/SKILL.md", "---\nname: my-own-tool\ndescription: d\n---\n\n正文\n");
  put("config/skills/my-own-skill/manifest.yaml", "name: my-own-skill\nversion: '1.0'\ndescription: d\norigin: agent\n");
  put("config/skills/my-own-skill/SKILL.md", "---\nname: my-own-skill\ndescription: d\n---\n\n正文\n");
  // 来源声明只写在 SKILL.md 的 frontmatter 里（无 manifest.yaml）也要认
  put("config/skills/fm-only-skill/SKILL.md", "---\nname: fm-only-skill\ndescription: d\norigin: agent\n---\n\n正文\n");

  /* ── 内置插件同名目录：即便自称 origin=agent 也永不放行 ── */
  put("config/plugins/subagent/plugin.json", JSON.stringify({
    name: "subagent", version: "9.9.9", description: "冒充内置", origin: "agent", provides: ["instructions"],
  }));

  /* ── 全新资产（磁盘上不存在）—— 合理的新建路径 ── */
  // config/plugins/brand-new/ 与 config/skills/brand-new/ 故意**不建目录**
});

afterAll(() => {
  if (ROOT) { rmSync(ROOT, { recursive: true, force: true }); }
});

describe("A-1197 归属①：新建与「迭代自己刚建的」必须放行（不许把刚修好的能力又封死）", () => {
  it("磁盘上不存在的插件/技能目录：新建放行", () => {
    expect(blk(P("config", "plugins", "brand-new", "plugin.json"))).toBe(false);
    expect(blk(P("config", "plugins", "brand-new", "SKILL.md"))).toBe(false);
    expect(blk(P("config", "skills", "brand-new", "SKILL.md"))).toBe(false);
    // 新建插件时连带写自己的 skills/ 子目录
    expect(blk(P("config", "plugins", "brand-new", "skills", "sub", "SKILL.md"))).toBe(false);
  });

  it("迭代自己刚建的插件：改 plugin.json 与改自己的 SKILL.md 都放行", () => {
    expect(blk(P("config", "plugins", "my-own-tool", "plugin.json"))).toBe(false);
    expect(blk(P("config", "plugins", "my-own-tool", "SKILL.md"))).toBe(false);
  });

  it("迭代自己刚建的技能：manifest.yaml 与 SKILL.md 都放行", () => {
    expect(blk(P("config", "skills", "my-own-skill", "manifest.yaml"))).toBe(false);
    expect(blk(P("config", "skills", "my-own-skill", "SKILL.md"))).toBe(false);
  });

  it("来源声明只写在 SKILL.md frontmatter 里也算数（不逼 Agent 多写一个文件）", () => {
    expect(blk(P("config", "skills", "fm-only-skill", "SKILL.md"))).toBe(false);
  });

  it("自己建的插件，其 skills/ 下的技能目录同样放行（判的是插件目录，不是最深目录）", () => {
    expect(blk(P("config", "plugins", "my-own-tool", "skills", "sub", "SKILL.md"))).toBe(false);
  });
});

describe("A-1197 归属②：改既有的他人/内置资产必须仍然拦（这才是本轮要堵的口子）", () => {
  it("改别人的插件：拦", () => {
    expect(blk(P("config", "plugins", "other-tool", "plugin.json"))).toBe(true);
    expect(blk(P("config", "plugins", "other-tool", "SKILL.md"))).toBe(true);
  });

  it("改别人插件 skills/ 下的技能：同样拦（不许因路径更深而放行）", () => {
    expect(blk(P("config", "plugins", "other-tool", "skills", "sub", "SKILL.md"))).toBe(true);
  });

  it("改内置技能目录：拦", () => {
    expect(blk(P("config", "skills", "builtin-skill", "SKILL.md"))).toBe(true);
    expect(blk(P("config", "skills", "builtin-skill", "manifest.yaml"))).toBe(true);
  });

  it("来源声明不是 agent（market/user）：拦", () => {
    expect(blk(P("config", "plugins", "market-tool", "plugin.json"))).toBe(true);
  });

  it("既有目录但读不到任何来源声明：拦（fail-closed，不给「读不到就放行」）", () => {
    expect(blk(P("config", "plugins", "bare-tool", "README.md"))).toBe(true);
  });

  it("内置插件同名目录即便自称 origin=agent 也不许写（冒名顶替内置能力）", () => {
    expect(blk(P("config", "plugins", "subagent", "plugin.json"))).toBe(true);
    expect(blk(P("config", "plugins", "subagent", "SKILL.md"))).toBe(true);
  });

  it("保留清单覆盖了全部内置插件名（新增内置插件时忘了登记 ⇒ 这里红）", () => {
    // 只判形状不判内容：真正的清单一致性由 shared 单一真相源 + 生成器保证
    expect(CONTRIBUTION_RESERVED_ASSETS.length).toBeGreaterThan(20);
    for (const r of CONTRIBUTION_RESERVED_ASSETS) {
      expect(r.startsWith("config/plugins/")).toBe(true);
      // 带 / 边界：config/plugins/subagent-x 不是 config/plugins/subagent 的子孙
      expect(r.split("/").length).toBe(3);
    }
    expect(CONTRIBUTION_RESERVED_ASSETS).toContain("config/plugins/subagent");
  });

  it("保留判定的 / 边界要真的生效：subagent-x 不是 subagent（不许被误当内置而收紧）", () => {
    // 判**行为**而不是判清单形状：裸前缀匹配会把 config/plugins/subagent-x
    // 误认成内置插件 ⇒ 用户自己新建的合法插件被拦（过度收紧，同样是缺陷）。
    put("config/plugins/subagent-x/plugin.json", JSON.stringify({
      name: "subagent-x", version: "1.0.0", description: "我自己的", origin: "agent", provides: ["instructions"],
    }));
    expect(blk(P("config", "plugins", "subagent-x", "plugin.json"))).toBe(false);
    // 而真正的内置同名目录仍然拦（边界另一侧）
    expect(blk(P("config", "plugins", "subagent", "plugin.json"))).toBe(true);
  });
});

describe("A-1197 归属③：判据不许外溢到豁免目录之外", () => {
  it("config/ 下的主配置依旧照封（豁免目录的父级不受归属判据影响）", () => {
    expect(blk(P("config", "agents.json"))).toBe(true);
    expect(blk(P("config", "providers.enc.json"))).toBe(true);
    expect(blk(P("config", "slime.toml"))).toBe(true);
  });

  it("前缀邻居（config/plugins-old、config/skills-2）依旧是受保护目录", () => {
    expect(isProtectedSourcePath(P("config", "plugins-old", "x.json"), ROOT)).toBe(true);
    expect(isProtectedSourcePath(P("config", "skills-2", "x.md"), ROOT)).toBe(true);
  });

  it("根外同名目录依旧不判保护（不误伤用户工作区）", () => {
    expect(isProtectedSourcePath(join(`${ROOT}-other`, "config", "skills", "x", "SKILL.md"), ROOT)).toBe(false);
  });

  it("敏感后缀在贡献目录里依旧硬拦（放行归属 ≠ 放凭据）", () => {
    expect(blk(P("config", "skills", "my-own-skill", "secret.enc"))).toBe(true);
    expect(blk(P("config", "plugins", "my-own-tool", "a.pfx"))).toBe(true);
  });

  it("直接写豁免根本身（不是某个资产目录）：仍按豁免放行，不因归属判据而收紧", () => {
    // 判据只判「某个资产目录」；config/skills 本身没有资产名，落回 §④ 的整目录豁免
    expect(blk(P("config", "skills", "README.md"))).toBe(false);
    expect(blk(P("config", "plugins", "README.md"))).toBe(false);
  });
});

describe("A-1197 归属守卫：来源标记的字段/取值/文件名必须来自单一真相源", () => {
  it("字段与取值是标量常量（不是逐字符迭代出来的数组 —— 那是最难查的静默漂移）", () => {
    expect(typeof CONTRIBUTION_OWNER_FIELD).toBe("string");
    expect(typeof CONTRIBUTION_OWNER_VALUE).toBe("string");
    expect(CONTRIBUTION_OWNER_FIELD).toBe("origin");
    expect(CONTRIBUTION_OWNER_VALUE).toBe("agent");
  });

  it("标记文件名清单覆盖两类资产的四种实际载体", () => {
    expect(CONTRIBUTION_OWNER_MARKERS).toContain("plugin.json");
    expect(CONTRIBUTION_OWNER_MARKERS).toContain("manifest.yaml");
    expect(CONTRIBUTION_OWNER_MARKERS).toContain("manifest.json");
    expect(CONTRIBUTION_OWNER_MARKERS).toContain("SKILL.md");
  });

  it("TS 侧确实从生成物取这四组常量（不许在 classifier 里手写第二份）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(process.cwd(), "core-ts", "src", "tools", "classifier.ts"), "utf8");
    for (const name of [
      "CONTRIBUTION_RESERVED_ASSETS",
      "CONTRIBUTION_OWNER_MARKERS",
      "CONTRIBUTION_OWNER_FIELD",
      "CONTRIBUTION_OWNER_VALUE",
    ]) {
      expect(src, name).toContain(name);
    }
  });
});

describe("A-1197 归属守卫：Python 侧（第二产地）必须与 TS 同口径", () => {
  /** tools/builtin.py 是 shared/security-policy.yaml 的第二个执行产地。
   *  历史教训：双端各写一份清单 ⇒ 主链路曾长期缺失引擎源码写入保护。
   *  这里不测行为（Python 侧跑在项目根上、无法在夹具里复现同一形态）而测**形状**，
   *  让「改了 yaml / TS 忘了改 Python」在 vitest 这一层就红。 */
  const py = (): string => readFileSync(join(process.cwd(), "tools", "builtin.py"), "utf8");

  it("必须真的从共享源取 §⑤ 的四组常量（而不是手写第二份）", () => {
    const src = py();
    expect(src).toContain("CONTRIBUTION_RESERVED_ASSETS");
    expect(src).toContain("CONTRIBUTION_OWNER_MARKERS");
    expect(src).toContain("CONTRIBUTION_OWNER_FIELD");
    expect(src).toContain("CONTRIBUTION_OWNER_VALUE");
  });

  it("三条判据在 Python 侧都要在（不存在⇒放行 / 自带声明⇒放行 / 保留目录⇒拦）", () => {
    const src = py();
    // ① 不存在 ⇒ 放行
    expect(src).toMatch(/if not \(_PROJECT_ROOT \/ asset_rel\)\.exists\(\):\s*\r?\n\s*return False/);
    // ② 自带 agent 声明 ⇒ 放行（取反后返回「不拦」）
    expect(src).toMatch(/return not _asset_declares_agent_origin/);
    // ③ 保留资产目录 ⇒ 拦。⚠️ 断言必须**同时**盯住 `for rv in _RESERVED_ASSETS:` 这一行 ——
    //   只断言 `startswith` 那行的话，把循环体改成遍历空元组的漂移**照样通过**
    //   （实测：这么写的第一版守卫让 mut M7 存活，见 skill《mutation-harness》）。
    expect(src).toMatch(/for rv in _RESERVED_ASSETS:/);
    expect(src).toMatch(/asset_rel\.startswith\(rv \+ "\/"\)/);
  });

  it("资产目录只认一层（不许取最深目录，否则改别人插件里的技能会被误放行）", () => {
    const src = py();
    expect(src).toContain("_contribution_asset_dir");
    expect(src).toMatch(/segs\[0\]/);
  });

  it("JSON 与 YAML 两种解析口径都要在（plugin.json 走 JSON，manifest.yaml/SKILL.md 走顶层字段）", () => {
    const src = py();
    expect(src).toContain("_asset_declares_agent_origin");
    expect(src).toMatch(/marker\.endswith\("\.json"\)/);
    expect(src).toMatch(/\^%s\\s\*:\\s\*\(\.\+\?\)\\s\*\$/);
  });

  it("fail-closed：读不到标记一律判「不是自己建的」（末行 return False）", () => {
    const src = py();
    const body = src.slice(src.indexOf("def _asset_declares_agent_origin"));
    expect(body).toMatch(/return False\s*$/m);
  });
});

describe("A-1197 归属守卫：生成器不得把标量键逐字符迭代（静默漂移）", () => {
  /** §⑤ 有两个**标量**键（contribution_owner_field/value）。
   *  旧生成器一律 `for i in (data.get(key) or [])` —— 标量字符串会被**逐字符**迭代，
   *  `origin` 生成成 ["o","r","i","g","i","n"]：不报错、不炸，只是双端拿着错清单判错。
   *  这里断言的是**生成器源码的形状**（把生成物断言成「已生成」是无效的：
   *  变异后重跑生成器它照样是自洽的，只有生成器本身判错才是缺陷）。 */
  const gen = (): string => readFileSync(join(process.cwd(), "scripts", "gen_security_policy.py"), "utf8");

  it("标量键必须被显式登记，且渲染分支与列表分支分开", () => {
    const src = gen();
    expect(src).toContain("SCALAR_KEYS");
    expect(src).toContain("def _is_scalar_key");
    // 标量键必须真的出现在登记表里（漏登记 ⇒ 逐字符迭代）
    expect(src).toMatch(/SCALAR_KEYS\s*=\s*\([\s\S]*?"contribution_owner_field"/);
    expect(src).toMatch(/SCALAR_KEYS\s*=\s*\([\s\S]*?"contribution_owner_value"/);
    // 渲染时必须走标量分支
    expect(src).toMatch(/if _is_scalar_key\(key\):/);
  });

  it("生成器必须对键类型做校验（类型写错时宁可炸掉，也不静默逐字符迭代）", () => {
    const src = gen();
    expect(src).toMatch(/isinstance\(value, str\)/);
    // ⚠️ 列表键这一条必须**只认 list**：写成 `isinstance(value, (list, str))` 就等于
    //   标量键在列表分支里也能通过 ⇒ 类型墙被拆、逐字符迭代重新可达（实测：这么写的一条存活了）。
    expect(src).toMatch(/elif not isinstance\(value, list\):/);
    expect(src).not.toMatch(/elif not isinstance\(value, \(list, str\)\)/);
  });
});
