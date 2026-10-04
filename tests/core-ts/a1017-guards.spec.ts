

















import { describe, expect, it } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";


const knowTmp = mkdtempSync(join(tmpdir(), "slime-know-"));
process.on("exit", () => { try { rmSync(knowTmp, { recursive: true, force: true }); } catch {  } });


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






const HISTORY_INJECTION_EXEMPT: Array<{ key: string; why: string }> = [
  
];

interface CtorSite {
  file: string;
  line: number;
  hasHistory: boolean;
  snippet: string;
}


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
    
    expect(injected + exempted).toBe(sites.length);
    expect(HISTORY_INJECTION_EXEMPT.length).toBe(exempted);
  });

  it("共享内存替身存在，且不落盘（防止有人把它改成写文件）", () => {
    const helperPath = "tests/core-ts/helpers/memoryHistoryStore.ts";
    const helper = readSrc(join(TESTS_DIR, "core-ts/helpers/memoryHistoryStore.ts"));
    expect(helper).toContain("export function memoryHistoryStore");
    expect(helper).toContain("filePath: null");
    
    
    expect(isReferencedInCode(helperPath, helper, "fileHistoryStore")).toBe(false);
  });
});





describe("A-1017 ②：幽灵会话（绑不存在 Agent、删了又复活）不许回来", () => {
  const mainSrc = readSrc(MAIN_INDEX);

  it("孤儿历史迁移必须先确认 Agent 仍存在", () => {
    expect(mainSrc).toContain("if (!names.has(agentId))");
    expect(mainSrc).toContain("跳过孤儿历史的会话迁移");
  });

  it("删除会话要连「没有 session_id 的遗留历史」一起清（否则下次列表又把它建回来）", () => {
    
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





describe("A-1017 ③：「正在加载本地模型」面板由管理器状态广播驱动", () => {
  const modelSrc = readSrc(MODEL_SERVER);
  const mainSrc = readSrc(MAIN_INDEX);

  it("ModelServerManager 提供状态广播，且在每个状态迁移点都发", () => {
    expect(modelSrc).toContain("export interface ChatStateEvent");
    expect(modelSrc).toContain("private notifyChatState(role: string): void");
    
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
    
    expect(panel).toContain("readCollapseDurMs()");
  });
});
