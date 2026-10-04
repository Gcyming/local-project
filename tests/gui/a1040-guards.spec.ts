














import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const MAIN = "gui/src/main/index.ts";
const PRELOAD = "gui/src/preload/index.ts";
const IPC = "gui/src/shared/ipc.ts";
const PANEL = "gui/src/renderer/pages/MindHubPanel.tsx";
const STORE = "core-ts/src/memory/store.ts";

describe("A-1040 ① 主进程：记忆位置必须是真实路径，不是字符串模板", () => {
  it("🐛 回归红线：configGet 不再返回字面 `<agentId>` 的假路径", () => {
    const src = code(MAIN);
    
    expect(src).not.toContain('"<agentId>"');
    expect(src).not.toContain('resolve(PROJECT_ROOT, "data", "<agentId>", "lancedb")');
  });

  it("位置推导委托给唯一实现 resolveMemoryPaths（按目标 Agent 推导）", () => {
    const src = code(MAIN);
    expect(src).toContain("resolveMemoryPaths(agentId");
    
    
    expect(src).toMatch(
      /import\s*\{[^}]*\bresolveMemoryPaths\b[^}]*\}\s*from\s*"[^"]*memory\/store\.js"/,
    );
  });

  it("未选到 Agent 时返回 null（而不是编一条路径）", () => {
    const src = code(MAIN);
    
    expect(src).toMatch(/memoryPaths:\s*agentId[\s\S]{0,120}:\s*null,/);
  });

  it("agentId 走白名单校验后才用于拼路径（防路径遍历）", () => {
    expect(code(MAIN)).toContain("/^[A-Za-z0-9_-]{1,64}$/");
  });
});

describe("A-1040 ② 跨进程契约：agentId 必须能传进去", () => {
  it("preload 的 configGet 接受可选 agentId 并透传（实现 + 类型声明两处）", () => {
    const src = code(PRELOAD);
    const hits = src.match(/configGet: \(agentId\?: string\)/g) ?? [];
    expect(hits.length, "实现与类型声明都要有，否则类型化调用点会静默拿不到 agentId").toBe(2);
    expect(src).toContain('ipcRenderer.invoke("slime:mind:configGet", agentId ? { agentId } : undefined)');
  });

  it("ipc.ts 的 memoryPaths 改成真实路径字段，且可空（不再用 knowledge/lance 模板名）", () => {
    const src = code(IPC);
    expect(src).toContain("memoryPaths: { memoryJson: string; lanceDir: string } | null;");
    expect(src).not.toContain("memoryPaths: { knowledge: string; lance: string }");
  });
});

describe("A-1040 ③ 面板：两条路径都跟着存储位置走", () => {
  it("两行分别读 memoryJson / lanceDir（旧字段读法必须消失）", () => {
    const src = code(PANEL);
    expect(src).toContain("cfg?.memoryPaths?.memoryJson");
    expect(src).toContain("cfg?.memoryPaths?.lanceDir");
    expect(src, "旧的 memoryPaths.knowledge 读法").not.toContain("memoryPaths.knowledge");
    expect(src, "旧的 memoryPaths.lance 读法").not.toContain("memoryPaths.lance");
  });

  it("🐛 回归红线：记忆本体那行不能再拿 memoryRoot 顶上（那是「只改一个」的根源观感）", () => {
    const src = code(PANEL);
    expect(src).not.toContain("cfg?.memoryRoot || (cfg?.memoryPaths");
  });

  it("改完存储位置要重新拉取配置（否则第二条路径当场不变）", () => {
    const src = code(PANEL);
    const pick = /async function pickMemoryRoot[\s\S]*?\n  \}/.exec(src);
    expect(pick, "找不到 pickMemoryRoot").not.toBeNull();
    expect(pick![0]).toContain("await reloadConfig(agentId)");
    
    expect(src).toContain("api.mind.configGet(id || undefined)");
  });

  it("目标 Agent 变化 → 路径跟着重算（路径是 per-Agent 的）", () => {
    const src = code(PANEL);
    expect(src).toMatch(/\}, \[agentId\]\);/);
  });

  it("自定义根目录不是单向门：有「恢复默认位置」出口", () => {
    const src = code(PANEL);
    expect(src).toContain("恢复默认位置");
    const fn = /async function resetMemoryRoot[\s\S]*?\n  \}/.exec(src);
    expect(fn, "找不到 resetMemoryRoot").not.toBeNull();
    expect(fn![0]).toContain('configSet({ memoryRoot: "" })');
  });

  it("没有目标 Agent 时**两行都**如实提示先选 Agent（不再显示 `data/<agentId>/…`）", () => {
    
    const hits = code(PANEL).match(/（先选择 Agent）/g) ?? [];
    expect(hits.length, "两行各要一处如实提示").toBe(2);
  });
});

describe("A-1040 ④ core-ts：一个根目录管两处 + 旧库搬迁", () => {
  it("🐛 回归红线：向量库不再被钉死在默认 data/（`LanceDB 保持原位` 必须消失）", () => {
    const src = code(STORE);
    expect(src).not.toContain("LanceDB 保持原位");
    expect(src).toContain("const paths = resolveMemoryPaths(agentId, { dataDir: opts.dataDir, projectRoot: this.projectRoot });");
    expect(src).toContain("this.lancedbUri = opts.lancedbUri ?? paths.lanceDir;");
  });

  it("迁移来源与推导同源（defaultLanceUri），不是写死的 DATA_DIR", () => {
    const src = code(STORE);
    expect(src).toContain("this.defaultLanceUri = resolveMemoryPaths(agentId, { projectRoot: this.projectRoot }).lanceDir;");
    expect(src).toContain("migrateDirIfNeeded(this.defaultLanceUri, uri);");
  });

  it("迁移绝不删数据：跨盘退化为复制并**保留原目录**", () => {
    const src = code(STORE);
    expect(src).toContain("cpSync(oldDir, newDir, { recursive: true })");
    expect(src).toContain("原目录 ${oldDir} 保留，未删除");
    
    expect(src).toContain("向量库迁移失败");
  });

  it("🐛 回归红线：维度探测必须读 `vector` 列（读 `vec` 会每次初始化都重建表 = 向量记忆每次重启就丢）", () => {
    const src = code(STORE);
    expect(src).not.toContain(").vec as");
    expect(src).toContain("(rows[0] as Record<string, unknown>).vector");
  });
});

describe("A-1040 ⑤ 配置写入：不能把自定义根目录静默清空", () => {
  it("🐛 回归红线：configSet 只写**显式给出**的字段（`memoryRoot: undefined` 会让 JSON 丢键 → 读回空）", () => {
    const src = code(MAIN);
    
    expect(src).not.toMatch(/saveMindConfig\(\{\s*vectorTool: payload\.vectorTool/);
    expect(src).toContain('if (typeof payload.memoryRoot === "string")');
    expect(src).toContain("patch.memoryRoot = payload.memoryRoot;");
  });

  it("`\"\"` 是合法值（= 恢复默认位置），不能被当成「没给」过滤掉", () => {
    const src = code(MAIN);
    expect(src).toContain('if (typeof payload.memoryRoot === "string")');
    
    expect(src).not.toContain("if (payload.memoryRoot)");
  });
});
