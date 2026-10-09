/**
 * tests/core-ts/a1197-contrib-write.spec.ts — ②③ 的验收基线
 *
 * 用户报的两个现象其实是同一个根因：
 *   ②「Agent 刚写完的扩展在扩展栏不能用，重启才好」
 *   ③「怎么总是显示被拒绝」
 *
 * 根因链：
 *   受保护源码目录清单里有 `config`（本意保护源码侧的 config/agents.json 等主配置），
 *   但打包形态下 slime 根 = **运行时数据根**（%APPDATA%\slime-gui\slime-data），
 *   于是 template 里的 `config/skills`（技能）与 `config/plugins`（插件）被一起封死 ——
 *   创造模式的导引明确要求 Agent 往这两个目录写，写入却是 **block 级硬规则**，
 *   任何权限开关/审批档位都放不了，且.LayoutParams模型只拿到一句面向审计的短句，只能原地重试。
 *
 * 本文件的断言分四类：
 *   A. 放行的必须是且仅是「用户自助贡献目录」（含其下全部，不许顺带放开父目录或前缀邻居）
 *   B. 真正要保护的东西一个都不能松（源码目录、主配置、凭据后缀）
 *   C. 拒绝消息必须「可读 + 可执行」（说清硬规则还是可审批，并给出下一步）
 *   D. **执行层**（builtin.ts 的 file_write / file_delete 真正用的那个判定）必须与预检层同口径
 *
 * ## 为什么必须有 D（这一段是本文件曾经最假的地方）
 * 上面三类测的全是**预检层**（hardRuleCheck → classifier）。而用户报的「总是被拒绝」
 * 有一半来自**执行层**：`file_write` 自己还有一份 `isBlockedWritePath`，
 * 它当年只查「一级目录 ∈ 受保护清单」，**不认豁免** ⇒ 审批预检放行了、
 * 执行时仍返回「敏感文件/目录禁止写入」。改坏 builtin.ts 时 A/B/C 全绿。
 * D 直接 import `builtin.ts` 调它导出的 `isBlockedWritePath`，把执行层钉死。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { isProtectedSourcePath } from "../../core-ts/src/tools/classifier.js";
import { hardRuleCheck } from "../../core-ts/src/tools/hard_rules.js";
import { explainDenial } from "../../core-ts/src/tools/policy.js";
import { isBlockedWritePath, PROJECT_ROOT as EXEC_ROOT } from "../../core-ts/src/tools/builtin.js";
import { PROTECTED_PATH_EXEMPTIONS } from "../../shared/gen/security-policy.js";

/** 假的「运行时数据根」——打包形态下 PROJECT_ROOT 就是这个形状。 */
const ROOT = resolve(sep === "\\" ? "C:\\slime-data" : "/slime-data");

const blk = (p: string): boolean => hardRuleCheck({ name: "file_write", riskKind: "write", target: p, projectRoot: ROOT }).blocked;

/** 执行层判定：`ws` 传空 = 走 slime 根基准（与 file_write 在会话未绑定工作区时同一条路）。 */
const execBlk = (absUnderRoot: string): boolean => isBlockedWritePath(join(EXEC_ROOT, absUnderRoot));

describe("A-1197② 贡献目录写入解封（造插件/技能不再被硬规则拦）", () => {
  it("插件目录里的 plugin.json 可以写（这是 Agent 造扩展的第一步）", () => {
    expect(isProtectedSourcePath(join(ROOT, "config", "plugins", "demo-tool", "plugin.json"), ROOT)).toBe(false);
    expect(blk(join(ROOT, "config", "plugins", "demo-tool", "plugin.json"))).toBe(false);
  });

  it("插件自带技能目录里的 SKILL.md 可以写", () => {
    expect(blk(join(ROOT, "config", "plugins", "demo-tool", "skills", "demo", "SKILL.md"))).toBe(false);
  });

  it("技能目录里的 SKILL.md 可以写（创造模式导引里的落点位）", () => {
    expect(blk(join(ROOT, "config", "skills", "demo", "SKILL.md"))).toBe(false);
  });

  it("相对路径同样放行（Agent 常写相对路径，必须与绝对路径同口径）", () => {
    expect(blk("config/plugins/demo-tool/plugin.json")).toBe(false);
    expect(blk("config/skills/demo/SKILL.md")).toBe(false);
  });

  it("大小写不敏感比对不得漏放（Windows 路径常见大写）", () => {
    expect(isProtectedSourcePath(join(ROOT, "Config", "Plugins", "demo", "plugin.json"), ROOT)).toBe(false);
  });

  it("豁免清单本身就写明是「目录」而不是「前缀片段」", () => {
    expect(PROTECTED_PATH_EXEMPTIONS).toContain("config/skills");
    expect(PROTECTED_PATH_EXEMPTIONS).toContain("config/plugins");
    for (const ex of PROTECTED_PATH_EXEMPTIONS) {
      expect(ex.startsWith("config/")).toBe(true);
      expect(ex.split("/").length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("A-1197② 守卫：解封只针对这两个目录，不许外溢", () => {
  it("同一个受保护目录下的其它路径照封（只放目录，不放父级）", () => {
    expect(blk(join(ROOT, "config", "agents.json"))).toBe(true);
    expect(blk(join(ROOT, "config", "providers.enc.json"))).toBe(true);
    expect(blk(join(ROOT, "config", "slime.toml"))).toBe(true);
  });

  it("前缀邻居不许被顺带放行（config/skills-2 不是 config/skills 的子目录）", () => {
    expect(isProtectedSourcePath(join(ROOT, "config", "skills-2", "x.md"), ROOT)).toBe(true);
    expect(isProtectedSourcePath(join(ROOT, "config", "plugins-old", "x.json"), ROOT)).toBe(true);
  });

  it("源码目录一个都没松手", () => {
    for (const d of ["core-ts", "gui", "tools", "shared", "sidecar", "gateway-ts", "runtime", "tests", ".git"]) {
      expect(isProtectedSourcePath(join(ROOT, d, "x.ts"), ROOT), d).toBe(true);
    }
  });

  it("根外同名目录依旧不判保护（不误伤用户工作区）", () => {
    const outside = join(`${ROOT}-other`, "config", "skills", "x", "SKILL.md");
    expect(isProtectedSourcePath(outside, ROOT)).toBe(false);
  });

  it("敏感后缀依旧硬拦（放目录 ≠ 放凭据）", () => {
    expect(blk(join(ROOT, "config", "plugins", "demo", "plugin.json"))).toBe(false);
    expect(blk(join(ROOT, "config", "skills", "demo", "secret.enc"))).toBe(true);
    expect(blk(join(ROOT, "config", "skills", "demo", "a.pfx"))).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * D. 执行层（builtin.ts）——「审批通过了但 file_write 还是报被禁止」的正解法
 *
 * 这里用的是**行为断言**（直接调导出的 isBlockedWritePath），不是形状断言：
 * builtin.ts 虽然拖了很多运行时依赖（doc_text / screen / browser / 子代理目录…），
 * 但 vitest 下 import 得动（本文件末尾有一条「import 成功」的自证），
 * 所以没有任何理由退回 grep 源码那种假断言。
 *
 * ⚠️ 判据取 `EXEC_ROOT`（真实 slime 根，由 builtin.ts 自己导出）而不是字符串拼的假根：
 * `isBlockedWritePath` 内部以 PROJECT_ROOT 为基准问classifier，基准必须与它一致，
 * 否则测的是「另一个根下的判定」，与执行层真实行为无关。
 * ══════════════════════════════════════════════════════════════════════════ */
describe("A-1197③执行层：豁免必须与预检层同口径（改 builtin.ts 会红）", () => {
  it("执行层能真的被 import 并调用（这条是下面所有断言的前提）", () => {
    // builtin.ts 拖了很多运行时依赖（doc_text / screen / browser / 子代理目录…），
    // 「能不能 import」本身就是个会回归的判据，所以显式断言而不是靠上面的用例顺带跑过。
    expect(typeof isBlockedWritePath).toBe("function");
    expect(typeof EXEC_ROOT).toBe("string");
  });

  it("新建插件目录下的 plugin.json：执行层放行（这是 Agent 造扩展的第一步）", () => {
    // 新名字 ⇒ 资产目录不存在 ⇒ classifier §⑤ 判据① ⇒ 放行
    expect(execBlk("config/plugins/a1197-new-tool/plugin.json")).toBe(false);
  });

  it("技能目录下的 SKILL.md：执行层放行", () => {
    expect(execBlk("config/skills/a1197-demo/SKILL.md")).toBe(false);
  });

  it("豁免不是「整目录随便写」：内置保留资产目录在执行层仍被拦", () => {
    // 判据③（永不放行，且**与磁盘状态无关**）—— 选它而不是「某个既有用户技能」当夹具：
    // 后者依赖用户技能库里那个目录恰好没被加上 origin 声明，改天用户加了就假红。
    for (const rv of ["config/plugins/subagent", "config/plugins/browser", "config/plugins/silam"]) {
      expect(execBlk(`${rv}/plugin.json`), rv).toBe(true);
    }
  });

  it("前缀边界：config/skills-2 不是 config/skills 的子目录（执行层必须拦）", () => {
    expect(execBlk("config/skills-2/x.md")).toBe(true);
    expect(execBlk("config/plugins-old/x.json")).toBe(true);
  });

  it("同目录下的主配置：执行层照拦（放目录 ≠ 放主配置）", () => {
    expect(execBlk("config/agents.json")).toBe(true);
    expect(execBlk("config/providers.enc.json")).toBe(true);
  });

  it("源码目录：执行层照拦", () => {
    expect(execBlk("core-ts/x.ts")).toBe(true);
    expect(execBlk("gui/src/x.ts")).toBe(true);
    expect(execBlk("shared/x.ts")).toBe(true);
  });

  it("⚠️ .toml 口径不许丢：slime.toml 改完仍必须被拦（工具锚定写入比预检层更严是故意的）", () => {
    // classifier 的 assessAction 刻意不含 .toml（否则用户项目的 pyproject.toml 也被拦），
    // 但执行层是**锚在 slime 自身配置**上的写入，必须用含 .toml 的 WRITE_BLOCK_SUFFIXES。
    // 这条红了就说明有人把执行层改成复用 classifier 的后缀集 ⇒ 工具层可以直接改主配置了。
    expect(execBlk("slime.toml")).toBe(true);
    expect(execBlk("config/slime.toml")).toBe(true);
    expect(blk(join(ROOT, "slime.toml"))).toBe(true);
  });

  it("凭据后缀在豁免目录里照拦（豁免只放 Markdown + JSON 清单）", () => {
    expect(execBlk("config/skills/a1197-demo/secret.enc")).toBe(true);
    expect(execBlk("config/plugins/a1197-new-tool/a.pfx")).toBe(true);
  });

  it("会话工作区锚在项目根外的目录：那一路仍按「相对工作区取一级目录」，不被豁免误伤", () => {
    // ws 语义回归：ws 非空时以 ws 为基准算一级目录（用户自己的 config/tools 不算 slime 源码）
    const outsideWs = resolve(sep === "\\" ? "C:\\user-proj" : "/user-proj");
    expect(isBlockedWritePath(join(outsideWs, "report.md"), outsideWs)).toBe(false);
    expect(isBlockedWritePath(join(outsideWs, "tools", "x.ts"), outsideWs)).toBe(true);
  });

  it("⚠️ ws 恰好等于 slime 根时（打包形态的常见形态）：豁免必须仍然生效，不能被第二路重新堵死", () => {
    // 这条守的是 sameAsProject 那个短路：ws 与 slime 根相同时两路判的是同一批路径，
    // 若不短路，第二路会按「相对 ws 取一级目录」把 config/skills 重新算成受保护
    // ⇒ 用户的「总是被拒绝」在打包形态下照旧复发，而上面那些 ws="" 的用例**照样全绿**。
    const at = (rel: string) => isBlockedWritePath(join(EXEC_ROOT, rel), EXEC_ROOT);
    expect(at("config/skills/a1197-demo/SKILL.md")).toBe(false);
    expect(at("config/plugins/a1197-new-tool/plugin.json")).toBe(false);
    expect(at("config/skills-2/x.md")).toBe(true);
    expect(at("slime.toml")).toBe(true);
    expect(at("core-ts/x.ts")).toBe(true);
  });
});

describe("A-1197② 守卫：Python 侧（同一政策的第二产地）必须与 TS 同口径", () => {
  /** tools/builtin.py 是 shared/security-policy.yaml 的第二个执行产地。
   *  历史教训：双端各写一份清单 ⇒ 主链路曾长期缺失引擎源码写入保护。
   *  所以这里不测「行为」而是测「它确实读共享豁免 + 做了边界」，
   *  让「改了 yaml / TS 忘了改 Python」这件事在 vitest 这一层就红。 */
  const py = readFileSync(join(process.cwd(), "tools", "builtin.py"), "utf8");

  /* ⚠️⚠️ 下面每条断言的锚点都必须是**真正在执行**的那段代码，且必须**恰好命中一次**。
   *
   * 本文件曾经把判据锚在 `_is_blocked_write_path` 尾部一段
   * `for ex in _WRITE_DIR_EXEMPTIONS: … return False` 上 —— 那是**死代码**：
   * 前面插入了 `asset_rel = _contribution_asset_dir(rel_posix)` 分支后，
   * 凡是那个循环能命中的路径都已在那条分支里 return，循环体永不执行。
   * ⇒ 断言永远绿，守着一个永不执行的分支；而**真正生效**的放行逻辑
   * （_contribution_asset_dir + _RESERVED_ASSETS + _asset_declares_agent_origin）
   * 一条都没被覆盖 —— 典型的「守错了地方」。
   *
   * `count()` 把「命中数」写进断言：锚点漂移 ⇒ 命中 0 ⇒ toBe(1) 直接红，
   * 而不会像 `toMatch` 那样悄悄变成永真（本项目四次前科的共同成因）。*/
  const count = (re: RegExp): number => (py.match(new RegExp(re.source, "g")) ?? []).length;

  it("必须真的从共享源取豁免清单（而不是手写第二份）", () => {
    expect(count(/_load\(mod,\s*"PROTECTED_PATH_EXEMPTIONS",\s*\(\)\)/)).toBe(1);
    // 清单仍被 _contribution_asset_dir 消费（不是遗留的死变量）
    expect(count(/for ex in _WRITE_DIR_EXEMPTIONS:/)).toBe(1);
  });

  it("放行判据必须真的被调用（锚在 _is_blocked_write_path 的执行路径上）", () => {
    expect(count(/asset_rel\s*=\s*_contribution_asset_dir\(rel_posix\)/)).toBe(1);
    expect(count(/if asset_rel is not None:/)).toBe(1);
    expect(count(/return not _asset_declares_agent_origin\(_PROJECT_ROOT\s*\/\s*asset_rel\)/)).toBe(1);
  });

  it("豁免判定必须带目录边界（不是裸前缀）", () => {
    // 生效判据在 _contribution_asset_dir 里：`== ex` 认目录本身，
    // `prefix = ex + "/"` + startswith(prefix) 认其下全部 —— 两条合起来才是「目录及其下全部」；
    // 少了后者就会把 config/skills-2 当成 config/skills 的子孙，属于外溢。
    expect(count(/rel_posix\s*==\s*ex\b/)).toBe(1);
    expect(count(/prefix\s*=\s*ex\s*\+\s*"\/"/)).toBe(1);
    expect(count(/if not rel_posix\.startswith\(prefix\):\s*continue/)).toBe(1);
  });

  it("保留资产目录也必须带 / 边界（内置插件目录及其下全部永不放行）", () => {
    expect(count(/for rv in _RESERVED_ASSETS:/)).toBe(1);
    expect(count(/asset_rel\s*==\s*rv\s+or\s+asset_rel\.startswith\(rv\s*\+\s*"\/"\)/)).toBe(1);
  });

  it("裸前缀形态一律不许重新长出来", () => {
    // `startswith(ex)` / `startswith(ex + 其他)` 这类不带 `/` 边界的写法一旦回流，
    // 前缀邻居（config/skills-2、config/plugins-old）就会被顺带放行。
    expect(py).not.toMatch(/rel_posix\.startswith\(ex\s*\)/);
    expect(py).not.toMatch(/rel_posix\.startswith\(ex\s*\+/);
  });

  it("命中豁免必须立刻放行（return False），而不是继续走父级的禁写判定", () => {
    // 锚在 asset_rel 分支**内部**的那处放行（资产目录不存在 ⇒ 放行「新建」），
    // 而不是全文任意位置的 return False。
    // 另一处放行（自带 agent 来源声明 ⇒ 放行「迭代自己刚建的」）在上面
    // 「放行判据必须真的被调用」里以 return not _asset_declares_agent_origin(...) 锚住。
    expect(count(/if not \(_PROJECT_ROOT\s*\/\s*asset_rel\)\.exists\(\):\s*return False/)).toBe(1);
  });
});

describe("A-1197③ 拒绝消息必须可读且可执行", () => {
  it("受保护源码目录：标为「不可审批」，并明确禁止重试同一目标", () => {
    const a = explainDenial(`受保护源码目录禁止写入：${join(ROOT, "gui", "x.ts")}`);
    expect(a.hard).toBe(true);
    expect(a.advice).toContain("不要");
    expect(a.advice).toMatch(/不要|不要再/);
  });

  it("敏感文件：同样是硬规则，且不许换个写法绕开", () => {
    const a = explainDenial("敏感文件禁止写入：agents.json");
    expect(a.hard).toBe(true);
    expect(a.advice).toContain("绕");
  });

  it("分类器预检拦截：归入硬规则（否则模型会一直重试同一目标）", () => {
    const a = explainDenial("[分类器预检拦截] file_write: 受保护源码目录禁止写入：xxx");
    expect(a.hard).toBe(true);
  });

  it("超出工作目录：不是硬规则，给的是可操作正路（切工作目录 / 写到目录内）", () => {
    const a = explainDenial("目标 'D:/x/y.txt' 超出工作目录范围（需用户确认）");
    expect(a.hard).toBe(false);
    expect(a.advice).toContain("工作目录");
  });

  it("原因缺失时也不许返回空指引（静默失效 = 用户只能看到干巴巴的「被拒绝」）", () => {
    expect(explainDenial("").advice.length).toBeGreaterThan(10);
    expect(explainDenial(undefined as unknown as string).advice.length).toBeGreaterThan(10);
  });
});
