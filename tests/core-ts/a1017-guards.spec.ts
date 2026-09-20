/**
 * tests/core-ts/a1017-guards.spec.ts — A-1017 三条事故的**结构守卫**。
 *
 * 这一轮修的不是"某个函数写错了"，而是三类**静默失败**，共同点是：改回去不会报错、测试也不会红。
 * 所以只能用结构守卫钉住，每条都能做变异测试验红（删掉被锁的结构 → 红）。
 *
 *  ① **测试污染真实数据**：`ChatService` 的 `history` 缺省值是 `fileHistoryStore`（直写真实
 *     `config/history.jsonl`）。测试漏传就会把夹具当用户数据写进去 —— 实测累计 76 条
 *     `agent_id="agent_test1"`，进而被"孤儿历史惰性迁移"建出一个**幽灵会话**（模型一个都选不了、
 *     删掉又复活）。守卫：所有构造点必须显式注入 history，**数量守恒**（总数 − 具名豁免）。
 *  ② **幽灵会话的两道闸门**：迁移必须校验 Agent 仍存在；删除会话必须能清掉"无 session_id"的遗留记录。
 *  ③ **加载面板的判据只能有一个来源**：`ModelServerManager` 广播状态。一旦有人把"调用方自己算
 *     就绪没有"写回来，就会重新退化成"模型已就绪却每轮弹一次全屏加载面板"。
 *  ④ **价目明细内联在对应模型行下方**（不是底部固定区块、不是浮窗），且展开后居中。
 *
 * 断言的是**结构**而不是文案措辞：注释里提到某个标识符不算"代码引用"（见 isReferencedInCode），
 * 所以正常改注释不会误红。
 */
import { describe, expect, it } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// A-1035：知识/技能落盘根挪到临时目录（后处理链路会生成技能，不能写进仓库 Knowledge/）
const knowTmp = mkdtempSync(join(tmpdir(), "slime-know-"));
process.on("exit", () => { try { rmSync(knowTmp, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });


const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTS_DIR = join(ROOT, "tests");
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const MODEL_SERVER = join(ROOT, "core-ts/src/model_server.ts");
const HISTORY_SRC = join(ROOT, "core-ts/src/services/history.ts");
const PROVIDERS_PANEL = join(ROOT, "gui/src/renderer/pages/ProvidersPanel.tsx");

function readSrc(p: string): string {
  return readFileSync(p, "utf8");
}

function listFilesRecursive(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listFilesRecursive(full, suffix));
    } else if (e.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

function parse(src: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** 标识符是否在**代码**里被引用（注释与字符串里的出现不算）。
 *  用 TS 解析器而不是「正则剥注释」：后者会被字符串里的 `//`（http://…）带偏、吞掉同行后面的真代码，
 *  于是守卫假绿 —— 而假绿比没有守卫更糟。 */
function isReferencedInCode(fileName: string, src: string, ident: string): boolean {
  const sf = parse(src, fileName);
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) { return; }
    if (ts.isIdentifier(n) && n.text === ident) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

// ────────────────────────────────────────────────────────────
// ① 测试不得写真实 config：所有 ChatService 构造点必须注入 history
// ────────────────────────────────────────────────────────────

/** 已知豁免（**每条都要写清理由**）。数量守恒 = 总数 − 具名豁免，不许写成"≥N 处"。 */
const HISTORY_INJECTION_EXEMPT: Array<{ key: string; why: string }> = [
  // 目前没有豁免。要加请用 `tests/core-ts/xxx.spec.ts:123` 作为 key，并在 why 里写清为什么必须碰真实 store。
];

interface CtorSite {
  file: string;
  line: number;
  hasHistory: boolean;
  snippet: string;
}

/** 用 AST 找 `new ChatService({ dataDir: knowTmp,...})`，并检查首个实参里有没有 `history` 属性。 */
function chatServiceCtorSites(): CtorSite[] {
  const sites: CtorSite[] = [];
  for (const file of listFilesRecursive(TESTS_DIR, ".spec.ts")) {
    const src = readSrc(file);
    const sf = parse(src, file);
    const walk = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "ChatService") {
        const first = (n.arguments ?? [])[0];
        const hasHistory = !!first && ts.isObjectLiteralExpression(first) && first.properties.some((p) => {
          const name = (p as ts.PropertyAssignment | ts.ShorthandPropertyAssignment).name;
          return !!name && name.getText(sf).replace(/["']/g, "") === "history";
        });
        sites.push({
          file: file.slice(ROOT.length).replace(/\\/g, "/"),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          hasHistory,
          snippet: n.getText(sf).replace(/\s+/g, " ").slice(0, 110),
        });
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return sites;
}

describe("A-1017 ①：测试不得把夹具写进真实 config/history.jsonl", () => {
  const sites = chatServiceCtorSites();

  it("构造点可被枚举（一个都找不到 = 扫描失效，守卫本身不许假绿）", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("数量守恒：每个构造点要么注入了 history，要么被具名豁免", () => {
    const exemptKeys = new Set(HISTORY_INJECTION_EXEMPT.map((e) => e.key));
    const sitesWithExempt = sites.map((s) => ({ ...s, key: `${s.file}:${s.line}` }));
    const exempted = sitesWithExempt.filter((s) => exemptKeys.has(s.key)).length;
    const injected = sitesWithExempt.filter((s) => s.hasHistory).length;
    const offenders = sitesWithExempt.filter((s) => !s.hasHistory && !exemptKeys.has(s.key));

    expect(
      offenders.map((s) => `${s.key} → ${s.snippet}`),
      "ChatService 的 history 缺省值是 fileHistoryStore（直写真实 config/history.jsonl）。"
        + "测试漏传就会污染用户真实历史，并被会话列表的孤儿迁移建出幽灵会话。"
        + "请注入 tests/core-ts/helpers/memoryHistoryStore.ts（或已有的内存替身）。",
    ).toEqual([]);
    // 守恒式：注入了 + 具名豁免了 = 总数（不存在"消失的"构造点，也没有写成 ≥N 的模糊断言）
    expect(injected + exempted).toBe(sites.length);
    expect(HISTORY_INJECTION_EXEMPT.length).toBe(exempted);
  });

  it("共享内存替身存在，且不落盘（防止有人把它改成写文件）", () => {
    const helperPath = "tests/core-ts/helpers/memoryHistoryStore.ts";
    const helper = readSrc(join(TESTS_DIR, "core-ts/helpers/memoryHistoryStore.ts"));
    expect(helper).toContain("export function memoryHistoryStore");
    expect(helper).toContain("filePath: null");
    // ⚠️ 不能写 `not.toContain("fileHistoryStore")` —— 该文件的注释里正当地提到了它（解释缺省值）。
    // 要判的是「代码里有没有真的用它」，所以走 AST。本文件第一版就踩了这个坑（自测时红了）。
    expect(isReferencedInCode(helperPath, helper, "fileHistoryStore")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// ② 幽灵会话的两道闸门
// ────────────────────────────────────────────────────────────

describe("A-1017 ②：幽灵会话（绑不存在 Agent、删了又复活）不许回来", () => {
  const mainSrc = readSrc(MAIN_INDEX);

  it("孤儿历史迁移必须先确认 Agent 仍存在", () => {
    expect(mainSrc).toContain("if (!names.has(agentId))");
    expect(mainSrc).toContain("跳过孤儿历史的会话迁移");
  });

  it("删除会话要连「没有 session_id 的遗留历史」一起清（否则下次列表又把它建回来）", () => {
    // 两个删除入口口径必须一致：单会话删除 + 工作文件夹删除
    const calls = mainSrc.split("clearLegacySessionHistory(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(mainSrc).toContain("clearLegacySessionHistory");
  });

  it("清理函数在 history.ts 真实存在，且按「无 session_id」判据过滤", () => {
    const hist = readSrc(HISTORY_SRC);
    expect(hist).toContain("export async function clearLegacySessionHistory");
    expect(hist).toMatch(/r\.agent_id === agentId && !r\.session_id/);
  });
});

// ────────────────────────────────────────────────────────────
// ③ 本地模型加载面板：判据只有一个来源
// ────────────────────────────────────────────────────────────

describe("A-1017 ③：「正在加载本地模型」面板由管理器状态广播驱动", () => {
  const modelSrc = readSrc(MODEL_SERVER);
  const mainSrc = readSrc(MAIN_INDEX);

  it("ModelServerManager 提供状态广播，且在每个状态迁移点都发", () => {
    expect(modelSrc).toContain("export interface ChatStateEvent");
    expect(modelSrc).toContain("private notifyChatState(role: string): void");
    // 失败 / 真正开始加载 / 取消 / 就绪 / 超时 / 卸载 —— 少一个就会有面板收不掉的路径
    const calls = modelSrc.split("this.notifyChatState(role)").length - 1;
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  it("主进程订阅广播决定面板显隐（真的接线，不是只有回调定义）", () => {
    expect(mainSrc).toContain("onChatState:");
    expect(mainSrc).toContain("本地模型开始加载");
  });

  it("调用方自查就绪的旧判据不许回来（代码里不得再引用）", () => {
    expect(
      isReferencedInCode("gui/src/main/index.ts", mainSrc, "isLocalModelReady"),
      "isLocalModelReady 会重新引入「调用方自己判就绪」：它另读一份 providers 表拿路径，"
        + "与管理器实际加载的 model_path 一有出入就永久判否 → 模型已就绪也每轮弹一次加载面板。",
    ).toBe(false);
    expect(isReferencedInCode("core-ts/src/model_server.ts", modelSrc, "isChatReady")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// ④ 价目明细内联在对应模型行下方
// ────────────────────────────────────────────────────────────

describe("A-1017 ④：价目明细在模型行正下方展开（不是底部固定区块、不是浮窗）", () => {
  const panel = readSrc(PROVIDERS_PANEL);

  it("明细行插在 tbody 内（colSpan 跨满整行），且排在 </tbody> 之前", () => {
    const colSpanAt = panel.indexOf("colSpan={6}");
    const tbodyEnd = panel.indexOf("</tbody>");
    expect(colSpanAt, "找不到 colSpan={6}：明细行可能又被挪出表格了").toBeGreaterThan(-1);
    expect(tbodyEnd).toBeGreaterThan(-1);
    expect(colSpanAt).toBeLessThan(tbodyEnd);
  });

  it("旧的「底部固定区块」结构已移除（否则会同时存在两份明细）", () => {
    expect(panel).not.toContain("价目明细固定区块 —— 点「定价来源」徽标展开");
    expect(panel.split("<PriceDetailRow").length - 1, "PriceDetailRow 只应内联渲染一份").toBe(1);
  });

  it("展开后会把明细滚到滚动容器中央（用户：不会追踪到展开的最中心）", () => {
    expect(panel).toContain("modalScrollRef");
    expect(panel).toContain("scrollTo({ top: box.scrollTop + delta");
    // 节拍必须读全局变量，不许写死 450
    expect(panel).toContain("readCollapseDurMs()");
  });
});
