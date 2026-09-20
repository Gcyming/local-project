/**
 * tests/gui/target-path.spec.ts — A-980-R32：点击路径的多基准候选解析。
 *
 * 这一层出错的表现是「明明存在的文件报不存在」（用户实测的原始症状），
 * 而输入全是野生字符串，所以用真实形态逐条锁住：相对工作目录 / 相对项目根 /
 * 带项目名前缀 / 带行号锚点 / 带引号反斜杠 / 相对某个父目录 / 本来就是绝对路径。
 */
import { describe, it, expect } from "vitest";
import { resolve, basename, dirname } from "node:path";
import { buildTargetCandidates, normalizeTargetPath, isAbsoluteTarget } from "../../gui/src/main/targetPath.js";

/** Windows 下用 win32 语义跑（本仓库目标平台）；用 posix 风格基准保证断言稳定 */
function cands(rel: string, roots: { root?: string; sessionWorkspace?: string | null; projectRoot?: string }): string[] {
  return buildTargetCandidates(rel, roots, resolve, basename, dirname).candidates;
}

const PROJ = "D:/pilot project";
const WS = "D:/pilot project/gui";

describe("normalizeTargetPath（野生串归一）", () => {
  it("去引号 / 统一斜杠 / 剥末尾斜杠", () => {
    expect(normalizeTargetPath('  "D:\\pilot project\\docs\\"  ')).toBe("D:/pilot project/docs");
    expect(normalizeTargetPath("'./docs/api.md'")).toBe("./docs/api.md");
  });

  it("剥掉行锚点与 `:行:列` 后缀（编辑器/markdown 链接的常见尾巴）", () => {
    expect(normalizeTargetPath("docs/api.md#L10-L20")).toBe("docs/api.md");
    expect(normalizeTargetPath("src/main/index.ts:42")).toBe("src/main/index.ts");
    expect(normalizeTargetPath("src/main/index.ts:42:7")).toBe("src/main/index.ts");
  });

  it("⚠️ Windows 盘符不被行号规则误伤（`D:` 后面是斜杠不是数字）", () => {
    expect(normalizeTargetPath("D:/pilot project/README.md")).toBe("D:/pilot project/README.md");
    expect(isAbsoluteTarget("D:/pilot project/README.md")).toBe(true);
    expect(isAbsoluteTarget("docs/api.md")).toBe(false);
  });
});

describe("buildTargetCandidates", () => {
  it("相对会话工作目录：候选首位就是它", () => {
    const c = cands("docs/api.md", { root: WS, sessionWorkspace: WS, projectRoot: PROJ });
    expect(c[0]).toBe(resolve(WS, "docs/api.md"));
  });

  it("渲染层 workspace 为空（未加载完/未绑定）→ 仍能用会话工作目录或项目根解析出来", () => {
    const onlySession = cands("docs/api.md", { root: "", sessionWorkspace: WS, projectRoot: PROJ });
    expect(onlySession).toContain(resolve(WS, "docs/api.md"));
    const onlyProject = cands("docs/api.md", { root: "", sessionWorkspace: null, projectRoot: PROJ });
    expect(onlyProject[0]).toBe(resolve(PROJ, "docs/api.md"));
  });

  it("带项目名前缀（`pilot project/docs/a.md`）→ 去掉首段后命中", () => {
    const c = cands("pilot project/docs/api.md", { root: PROJ, projectRoot: PROJ });
    expect(c).toContain(resolve(PROJ, "docs/api.md"));
  });

  it("相对某个父目录（`main/index.ts` 而工作目录是 `.../gui`）→ 上溯一层后命中", () => {
    const c = cands("main/index.ts", { root: WS, projectRoot: PROJ });
    expect(c).toContain(resolve(dirname(WS), "main/index.ts"));
  });

  it("本来就是绝对路径 → 只给一个候选（不做基准拼接，避免把绝对路径又接到工作目录后面）", () => {
    const c = cands("D:/pilot project/README.md", { root: WS, projectRoot: PROJ });
    expect(c).toHaveLength(1);
    expect(c[0]).toBe(resolve("D:/pilot project/README.md"));
  });

  it("去重：多个基准指向同一路径时不留重复候选", () => {
    const c = cands("docs/api.md", { root: PROJ, sessionWorkspace: PROJ, projectRoot: PROJ });
    expect(new Set(c).size).toBe(c.length);
  });

  it("空串 / 纯引号 → 无候选（调用方据此报「缺少文件路径」而不是乱试）", () => {
    expect(cands("   ", { root: WS })).toHaveLength(0);
    expect(cands('""', { root: WS })).toHaveLength(0);
  });

  it("末位兜底：候选里不出现空段拼出的怪路径（`./` 前缀会被吃掉）", () => {
    const c = cands("./docs/api.md", { root: WS });
    expect(c[0]).toBe(resolve(WS, "docs/api.md"));
    expect(c.every((x) => !x.includes("/./"))).toBe(true);
  });
});
