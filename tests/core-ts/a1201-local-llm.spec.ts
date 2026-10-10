/**
 * tests/core-ts/a1201-local-llm.spec.ts — A-1201「本地 LLM 真能用」守卫。
 *
 * ## 缺陷现场（用户口径）
 * 「slime 内的 llama 网关无法使用……我加载了一个小参数的 LLM 模型尝试，结果根本无法使用」
 *
 * ## 三个各自独立的根因（都已取证）
 * ① **思考模式被硬编码强制打开**：`engine.reasoningParamsForModel` 对 `kind === "local"`
 *    无条件下发 `chat_template_kwargs.enable_thinking = true`。混合推理模型（qwen3 等）
 *    于是先吐一大段思维链，`max_tokens` 被吃光 ⇒ `content` 是**空字符串**。
 *    实测（qwen3-1.7b，max_tokens=64）：开思考 ⇒ `content=""`；
 *    关思考 ⇒ `content="你好呀"`；中间态还会把**截断的思维链泄漏成正文**
 *    （实测拿到 `"接下来，我要考虑用户可能的身份。"` —— 那不是回答）。
 * ② **模型名不许带小数点**：`qwen3-1.7b`（照抄文件名）被 `KEY_RE` 拒 ⇒ 加不进模型
 *    （记档：用户配置里 `_local_models` 为空）。
 * ③ **服务没有任何控制面**：起没起、在哪个端口、为什么失败全看不见 ⇒ 只能猜。
 *
 * ## 本组守卫钉住的不变量
 *   A. 思考参数决策表（4 种组合）+ 默认必须"保证有正文"
 *   B. 本地模型名允许小数点（但仍有边界）
 *   C. 自检与真聊**参数同源**（自检假绿比没有自检更坏）
 *   D. 服务控制面接线（status/start/stop/logs/test）
 *   E. 配置页不退回"晦涩"（本地参数不用 K）与"配了不生效"
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  localThinkingParams,
  normalizeThinkingMode,
  isHybridReasoningModel,
  LOCAL_THINKING_MODES,
} from "../../core-ts/src/local_models.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("A-1201 A — 思考参数决策表（本地模型「不说话」的根因位）", () => {
  it("① auto + 混合推理家族 ⇒ **下发 false**（它们模板默认开 ⇒ 必须显式关，这是修复的核心）", () => {
    expect(localThinkingParams("auto", "qwen3-1.7b")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(localThinkingParams("auto", "DeepSeek-R1-Distill")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("② auto + 非推理家族 ⇒ 不下发（非推理模型收到未知 kwarg 虽无害，但不下发更干净）", () => {
    expect(localThinkingParams("auto", "llama-3-8b")).toEqual({});
    expect(localThinkingParams("auto", "qwen2.5-7b")).toEqual({});
  });

  it("③ on / off 是用户显式选择 ⇒ 一律照办（不被家族判据拦）", () => {
    expect(localThinkingParams("on", "llama-3-8b")).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(localThinkingParams("off", "qwen3-1.7b")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("④ ⚠️ 缺省（老数据 / 脏值）必须等价于 auto —— 绝不退化成「强制开思考」", () => {
    for (const dirty of [undefined, null, "", "bogus", 1, {}]) {
      expect(localThinkingParams(dirty, "qwen3-1.7b"))
        .toEqual({ chat_template_kwargs: { enable_thinking: false } });
      expect(normalizeThinkingMode(dirty)).toBe("auto");
    }
  });

  it("⑤ ⚠️ 源码锁：引擎对本地模型**不许**再出现硬编码 `enable_thinking: true`", () => {
    const eng = read("core-ts/src/services/engine.ts");
    /* 旧缺陷的确切形状：`if (kind === "local") { return { ... enable_thinking: true }; }` */
    const localBranch = /if \(kind === "local"\) \{[\s\S]{0,200}?\n    \}/.exec(eng);
    expect(localBranch, "engine 里找不到 kind === \"local\" 分支（判据需同步）").not.toBeNull();
    /* ① 这一支不许再出现硬编码的 enable_thinking（旧缺陷的确切形状） */
    expect(localBranch![0]).not.toMatch(/enable_thinking/);
    /* ② 它必须委托给本地参数方法，而那个方法必须走单一产地 localThinkingParams */
    expect(localBranch![0]).toMatch(/localReasoningParams\(/);
    expect(eng).toMatch(/localThinkingParams\(this\.findLocalModel\(modelId\)\?\.thinking, modelId\)/);
  });

  it("⑥ 取值集合只有一个产地（UI 的下拉与这里同源）", () => {
    expect([...LOCAL_THINKING_MODES]).toEqual(["auto", "on", "off"]);
  });

  it("⑦ 家族判据：命中已知推理家族；空串/无关名字不得误判", () => {
    expect(isHybridReasoningModel("qwen3")).toBe(true);
    expect(isHybridReasoningModel("QWEN3-32B")).toBe(true);
    expect(isHybridReasoningModel("qwq-32b")).toBe(true);
    expect(isHybridReasoningModel("glm-4.5")).toBe(true);
    expect(isHybridReasoningModel("")).toBe(false);
    expect(isHybridReasoningModel("llama-3-8b")).toBe(false);
  });
});

describe("A-1201 B — 本地模型名允许小数点（「加不进模型」的根因位）", () => {
  const PROV = read("gui/src/main/providers.ts");

  it("本地走放宽后的字符集，API 供应商仍用严格 KEY_RE（两条路不许混）", () => {
    expect(PROV).toMatch(/const LOCAL_MODEL_ID_RE = \/\^\[a-zA-Z0-9_\.\\-\\u4e00-\\u9fa5\]\{1,64\}\$\/;/);
    /* API 供应商那条必须**保持**不含小数点（它参与 api:<key>:<model> 冒号分段解析）。 */
    const keyRe = /const KEY_RE = (\/\^\[[^\n]+);/.exec(PROV);
    expect(keyRe, "找不到 KEY_RE").not.toBeNull();
    expect(keyRe![1]).not.toContain("_\\.");
  });

  it("validateLocalId 用的是 LOCAL_MODEL_ID_RE（不是 KEY_RE）", () => {
    const i = PROV.indexOf("function validateLocalId(");
    expect(i, "找不到 validateLocalId").toBeGreaterThan(-1);
    const seg = PROV.slice(i, i + 600);
    expect(seg).toMatch(/LOCAL_MODEL_ID_RE\.test\(id\)/);
    expect(seg).not.toMatch(/KEY_RE\.test\(id\)/);
  });

  it("thinking 会被归一后落盘（脏值不进配置）", () => {
    const seg = /export function saveLocalModel\([\s\S]*?\n\}/.exec(PROV);
    expect(seg).not.toBeNull();
    expect(seg![0]).toMatch(/thinking:\s*normalizeThinkingMode\(input\.thinking\)/);
  });
});

describe("A-1201 C — 自检与真聊**参数同源**（自检假绿比没有自检更坏）", () => {
  const PROBE = read("core-ts/src/local_model_probe.ts");

  it("探测模块用的是 localThinkingParams（不是自己拼参数）", () => {
    expect(PROBE).toMatch(/localThinkingParams\(spec\.thinking, spec\.id\)/);
    /* 反面：不许自己写 enable_thinking 字面量（那就是第二产地） */
    expect(PROBE).not.toMatch(/enable_thinking:\s*(true|false)/);
  });

  it("空正文必须被**点名**（否则用户只看到「自检失败」不知道往哪改）", () => {
    expect(PROBE).toMatch(/空正文/);
    expect(PROBE).toMatch(/思考模式/);
  });

  it("⚠️ 主进程不许自建 client（铁律 a1106 D2）—— 自检逻辑必须留在 core-ts", () => {
    const main = read("gui/src/main/index.ts");
    for (const cls of ["ChatClient", "AnthropicClient", "ResponsesClient", "GoogleClient"]) {
      expect(main, `main 里自建了 ${cls}`).not.toContain(`new ${cls}(`);
    }
    expect(main).toMatch(/probeLocalModel\(/);
  });
});

describe("A-1201 D — 服务控制面接线（用户要的「可控网关」）", () => {
  const MAIN = read("gui/src/main/index.ts");
  const IPC = read("gui/src/shared/ipc.ts");
  const PRELOAD = read("gui/src/preload/index.ts");

  it("五个通道在 ipc / main / preload 三层都接上（少一层 = 界面调不到）", () => {
    for (const ch of ["modelServer_status", "modelServer_start", "modelServer_stop", "modelServer_logs", "modelServer_test"]) {
      expect(IPC, `ipc 缺 ${ch}`).toContain(ch);
    }
    for (const h of ["modelServer:status", "modelServer:start", "modelServer:stop", "modelServer:logs", "modelServer:test"]) {
      expect(MAIN, `main 缺 slime:${h} 的处理`).toContain(`IPC_CHANNELS.${h.replace(":", "_")}`);
    }
    for (const m of ["modelServerStatus", "modelServerStart", "modelServerStop", "modelServerLogs", "modelServerTest"]) {
      expect(PRELOAD, `preload 缺 ${m}`).toContain(m);
    }
  });

  it("日志取自真实后端输出（不许编内容）", () => {
    expect(read("core-ts/src/model_server.ts")).toMatch(/outputTailOf\(role: string\): string \{[\s\S]{0,120}?this\.backends\[role\]\?\.output/);
  });

  it("「停止」走既有 shutdown（不引第二套进程管理）", () => {
    const i = MAIN.indexOf("IPC_CHANNELS.modelServer_stop");
    expect(i, "找不到 stop 处理").toBeGreaterThan(-1);
    expect(MAIN.slice(i, i + 400)).toMatch(/mgr\.shutdown\(\)/);
  });
});

describe("A-1201 E — 配置页不再晦涩（用户口径）", () => {
  const PANEL = read("gui/src/renderer/pages/ProvidersPanel.tsx");

  it("① 本地参数不再用 K（单位直写 tokens）", () => {
    expect(PANEL).not.toMatch(/tokensToKInput\(edit\./);
    /* 只查**渲染出来的文案**：注释里提到旧名（用来解释为什么改）是允许的。 */
    expect(PANEL).not.toMatch(/>\s*上下文 ctx_len \(K\)\s*</);
  });

  it('② 「99」不再是用户可见的魔法数字 —— 换成「全部层放显卡」的人话勾选', () => {
    expect(PANEL).toContain("全部层放显卡（最快）");
    expect(PANEL).not.toMatch(/placeholder="auto（默认 99）"/);
  });

  it("③ 思考模式有下拉且写清了三档的含义（用户要知道该选哪个）", () => {
    expect(PANEL).toContain("思考模式");
    for (const v of ['value="auto"', 'value="off"', 'value="on"']) { expect(PANEL).toContain(v); }
    expect(PANEL).toMatch(/保证有正文/);
  });

  it("④ 每个参数都有一句人话说明（不许只给一个裸输入框）", () => {
    expect(PANEL).toMatch(/模型一次能记住多少内容/);
    expect(PANEL).toMatch(/全部层交给显卡跑/);
    expect(PANEL).toMatch(/限制一次回复的长度/);
  });

  it("⑤ 服务状态卡在页面上（状态 + 日志 + 停止释放显存）", () => {
    expect(PANEL).toContain("推理服务（llama-server）");
    expect(PANEL).toMatch(/停止并释放显存/);
    expect(PANEL).toMatch(/查看日志/);
  });

  it("⑥ 模型卡上的「自检」是真调后端（不是空按钮）", () => {
    const i = PANEL.indexOf("const handleTestModel");
    expect(i, "找不到 handleTestModel").toBeGreaterThan(-1);
    expect(PANEL.slice(i, i + 900)).toMatch(/modelServerTest/);
  });
});
