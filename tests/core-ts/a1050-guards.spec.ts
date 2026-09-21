/**
 * tests/core-ts/a1050-guards.spec.ts — 「随包默认技能」守卫。
 *
 * 盯的病：**默认技能既不随包、也没人发现**。
 * `config/` 被 `.gitignore` 整目录忽略 → 历史上既不进安装包也不被 git 跟踪；`boot.ts`
 * 只引导 `slime.toml`、不播种任何 config 内容 → **全新安装的技能库是空的**。而
 * `DEFAULT_TOOL_PROFILE` 声明的 6 个默认技能在盘上不存在，工具白名单**静默**解析为空
 * （不报错，模型只是「什么技能都没有」——正是最难查的那种失败）。
 *
 * 这一族守卫锁两个层次，缺一层就会重演：
 *  A. **语义层**（`seedDefaultSkills`）：不覆盖 / 不复活 / 幂等 / 容忍缺目录。
 *  B. **契约层**（源码与配置的静态不变式）：代码声明的默认技能必须真的在 tracked 种子目录里，
 *     且必须真的被 electron-builder 挂进安装包、被 boot 在打包分支调用 —— 少任何一环都静默。
 *
 * ⚠️ 验收标准是**变异测试**：写完必须逐条把源码改坏、确认它变红。
 *    "通过但锁错对象"比没有守卫更糟。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDefaultSkills } from "../../gui/src/main/skill_seed.js";
import { DEFAULT_TOOL_PROFILE } from "../../core-ts/src/services/agentTools.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** tracked 的默认技能正本（随 extraFiles 落到安装根 template/skills）。 */
const SEED_DIR = join(ROOT, "gui", "template", "skills");

let sandbox: string | null = null;
let seedDir = "";
let skillsDir = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "slime-skill-seed-"));
  seedDir = join(sandbox, "seed");
  skillsDir = join(sandbox, "user", "config", "skills");
  mkdirSync(seedDir, { recursive: true });
});
afterEach(() => {
  if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = null; }
});

/** 在种子目录里造一个技能：<seed>/<name>/SKILL.md */
function makeSeedSkill(name: string, body = `# ${name}`): void {
  mkdirSync(join(seedDir, name), { recursive: true });
  writeFileSync(join(seedDir, name, "SKILL.md"), body, "utf8");
}

function skillBody(dir: string, name: string): string {
  return readFileSync(join(dir, name, "SKILL.md"), "utf8");
}

describe("A-1050 A. seedDefaultSkills 语义", () => {
  it("首次播种：把种子目录里的技能复制进用户技能库，并返回复制名单", () => {
    makeSeedSkill("alpha", "# alpha default");
    makeSeedSkill("beta", "# beta default");

    const seeded = seedDefaultSkills(seedDir, skillsDir);

    expect(seeded.sort()).toEqual(["alpha", "beta"]);
    expect(skillBody(skillsDir, "alpha")).toBe("# alpha default");
    expect(skillBody(skillsDir, "beta")).toBe("# beta default");
  });

  it("不覆盖：用户已有同名技能时内容原样保留，且不登记为已播种", () => {
    makeSeedSkill("alpha", "# alpha default");
    // ⚠️ 必须有「至少一个真被复制」的技能，台账才会落盘 —— 否则这条用例观察不到
    //    「跳过也记账」的差异（变异 M3 就是这么逃过去的：锁得太浅 = 锁错对象）。
    makeSeedSkill("beta");
    mkdirSync(join(skillsDir, "alpha"), { recursive: true });
    writeFileSync(join(skillsDir, "alpha", "SKILL.md"), "# 用户自己改过的 alpha", "utf8");

    const seeded = seedDefaultSkills(seedDir, skillsDir);
    expect(seeded).toEqual(["beta"]);
    expect(skillBody(skillsDir, "alpha")).toBe("# 用户自己改过的 alpha");
    expect(skillBody(skillsDir, "beta")).toBe("# beta");

    // 用户随后删掉自己那份 → 默认技能应当补上（"没做过的事不许记账"）
    rmSync(join(skillsDir, "alpha"), { recursive: true, force: true });
    expect(seedDefaultSkills(seedDir, skillsDir)).toEqual(["alpha"]);
    expect(skillBody(skillsDir, "alpha")).toBe("# alpha default");
  });

  it("不复活：用户删掉已播种的技能后，再启动不会把它放回来", () => {
    makeSeedSkill("alpha", "# alpha default");
    expect(seedDefaultSkills(seedDir, skillsDir)).toEqual(["alpha"]);

    // 等价于用户「删掉」或经 GUI「停用」（停用是把目录移进 .disabled/）
    rmSync(join(skillsDir, "alpha"), { recursive: true, force: true });

    expect(seedDefaultSkills(seedDir, skillsDir)).toEqual([]);
    expect(existsSync(join(skillsDir, "alpha"))).toBe(false);
  });

  it("幂等：连续两次播种，第二次没有任何新复制", () => {
    makeSeedSkill("alpha");
    expect(seedDefaultSkills(seedDir, skillsDir)).toEqual(["alpha"]);
    expect(seedDefaultSkills(seedDir, skillsDir)).toEqual([]);
  });

  it("种子目录不存在 → 返回空且不抛（播种失败绝不能拦住启动）", () => {
    expect(seedDefaultSkills(join(sandbox as string, "nope"), skillsDir)).toEqual([]);
    expect(existsSync(skillsDir)).toBe(false);
  });

  it("只认目录：隐藏项与普通文件都不被当成技能", () => {
    makeSeedSkill("alpha");
    mkdirSync(join(seedDir, ".disabled"), { recursive: true });
    writeFileSync(join(seedDir, "README.md"), "not a skill", "utf8");

    expect(seedDefaultSkills(seedDir, skillsDir)).toEqual(["alpha"]);
    expect(existsSync(join(skillsDir, ".disabled"))).toBe(false);
    expect(existsSync(join(skillsDir, "README.md"))).toBe(false);
  });

  it("子目录被完整递归复制（scripts/ references/ 一起走）", () => {
    makeSeedSkill("alpha");
    mkdirSync(join(seedDir, "alpha", "scripts"), { recursive: true });
    writeFileSync(join(seedDir, "alpha", "scripts", "run.py"), "print(1)\n", "utf8");

    seedDefaultSkills(seedDir, skillsDir);
    expect(existsSync(join(skillsDir, "alpha", "scripts", "run.py"))).toBe(true);
  });
});

describe("A-1050 B. 契约层：默认技能必须真的随包", () => {
  it("DEFAULT_TOOL_PROFILE 声明的每个技能都存在于 tracked 种子目录且含 SKILL.md", () => {
    const missing = DEFAULT_TOOL_PROFILE.skills.filter(
      (n) => !existsSync(join(SEED_DIR, n, "SKILL.md")),
    );
    expect(missing, `以下默认技能不在 gui/template/skills/ 里（打包版会静默失去它们）：${missing.join("、")}`).toEqual([]);
  });

  it("默认技能集非空（空集会让上面那条断言变成永真）", () => {
    expect(DEFAULT_TOOL_PROFILE.skills.length).toBeGreaterThan(0);
  });

  it("electron-builder extraFiles 把 template/skills 挂进安装包", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "gui", "electron-builder.json"), "utf8")) as {
      extraFiles?: Array<{ from: string; to: string }>;
    };
    const hit = (cfg.extraFiles ?? []).find(
      (e) => e.from === "template/skills" && e.to === "template/skills",
    );
    expect(hit, "extraFiles 里没有 template/skills → 安装包不含默认技能").toBeTruthy();
  });

  it("boot 在**打包分支**内调用播种（开发分支不播种，避免遮蔽打包才能暴露的故障）", () => {
    const src = readFileSync(join(ROOT, "gui", "src", "main", "boot.ts"), "utf8");
    // 换行无关：仓库工作树是 CRLF，写死 \n 会让守卫在换行风格变化时静默失效。
    const packaged = /if \(app\.isPackaged\) \{([\s\S]*?)\r?\n\} else \{/.exec(src);
    expect(packaged, "boot.ts 的 if (app.isPackaged) { … } else { 结构变了，守卫需同步更新").toBeTruthy();
    expect(packaged?.[1]).toContain("bootstrapSkills(");

    const dev = /\r?\n\} else \{([\s\S]*?)\r?\n\}\r?\n/.exec(src);
    expect(dev, "boot.ts 的 else 分支结构变了，守卫需同步更新").toBeTruthy();
    expect(dev?.[1], "开发模式不该播种：PROJECT_ROOT 就是源码树，会把「模板缺失」补上从而遮蔽故障").not.toContain("bootstrapSkills(");
  });
});
