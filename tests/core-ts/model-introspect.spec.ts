/**
 * tests/core-ts/model-introspect.spec.ts — 本地服务「能力问询」层（计划 S1）回归守卫。
 *
 * ── 这个文件要钉住的核心事实 ──────────────────────────────────
 * ① **两个数字不能混**：`n_ctx`（本次服务的有效窗口，8192）与 `n_ctx_train`（模型训练上限，40960）
 *    必须各自独立存在。A-1018 ③ 的病灶就是拿后者当"可用余量"显示，于是界面说"还剩 480K"、
 *    上游 400 顶回 `exceeds the available context size (8192 tokens)`。
 * ② **上限的唯一来源是服务器自述**，不是家族能力表、也不是我们的配置文件推断。
 * ③ **"加载中"是一等状态**：实测三端点全部 503 + 同一个 `unavailable_error` 信封；
 *    归到 `down` 会让 UI 在加载期显示"未启动"，把用户引向"重试启动"这个错误动作。
 *
 * ── 夹具从哪来 ────────────────────────────────────────────────
 * `tests/fixtures/llama/*.json` 是**真实 llama-server 响应的逐字节副本**（含 HTTP 状态码，
 * 存在同目录 `*.status`）。抓取脚本：`gui/scripts/capture-llama-fixtures.sh`
 * （用法见脚本头；实测环境 llama.cpp b10509 / qwen3-1.7b-q8_0 / `-c 8192`）。
 *
 * ⚠️ 绝不手写"我以为的字段名"当夹具 —— 那正是 A-1018 ③ 的成因（凭推断代替问询）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyLocalServer,
  isUnavailableEnvelope,
  parsePropsPayload,
  parseModelsPayload,
  readLocalCapability,
  resolveWindowCap,
  describeWindowCap,
  emptyCapability,
  type LocalServerCapability,
} from "../../core-ts/src/model_introspect.js";

const FIX = fileURLToPath(new URL("../fixtures/llama", import.meta.url));
const SRC = fileURLToPath(new URL("../../core-ts/src/model_introspect.ts", import.meta.url));

/** 读**真实**夹具：响应体 + 抓取时的 HTTP 状态码（两者必须同批落盘，见抓取脚本的 SNAP） */
function fixture(name: string): { body: unknown; status: number | null } {
  const raw = readFileSync(join(FIX, `${name}.json`), "utf8");
  const statusRaw = readFileSync(join(FIX, `${name}.status`), "utf8").trim();
  const status = statusRaw === "" ? null : Number(statusRaw);
  return { body: JSON.parse(raw), status: Number.isFinite(status) ? status : null };
}

const PROPS_READY = fixture("props.ready");
const MODELS_READY = fixture("models.ready");
const HEALTH_READY = fixture("health.ready");
const PROPS_LOADING = fixture("props.loading");
const MODELS_LOADING = fixture("models.loading");
const HEALTH_LOADING = fixture("health.loading");

// ── 状态判定 ────────────────────────────────────────────────

describe("classifyLocalServer —— 三态判定（loading 不是 down）", () => {
  it("连不上（httpStatus=null）→ down", () => {
    expect(classifyLocalServer(null, undefined)).toBe("down");
    expect(classifyLocalServer(null, { error: "ECONNREFUSED" })).toBe("down");
  });

  it("200 + 就绪体 → ready", () => {
    expect(classifyLocalServer(200, PROPS_READY.body)).toBe("ready");
    expect(classifyLocalServer(200, { status: "ok" })).toBe("ready");
  });

  it("★ 503 + unavailable_error 信封 → loading（**不是** down、也不是 ready）", () => {
    expect(classifyLocalServer(503, PROPS_LOADING.body)).toBe("loading");
    expect(classifyLocalServer(503, MODELS_LOADING.body)).toBe("loading");
    expect(classifyLocalServer(503, HEALTH_LOADING.body)).toBe("loading");
  });

  it("★ 信封先于状态码：200 + 错误信封不得判成 ready", () => {
    // 防御性断言：若某版本"传输成功但内容是否定"，按 200 判 ready 会拿到 null 的 n_ctx
    expect(classifyLocalServer(200, PROPS_LOADING.body)).toBe("loading");
  });

  it("其余状态码（401/404/500）→ down，**不**判 loading（否则 UI 无限转圈）", () => {
    expect(classifyLocalServer(401, { error: "unauthorized" })).toBe("down");
    expect(classifyLocalServer(404, "not found")).toBe("down");
    expect(classifyLocalServer(500, {})).toBe("down");
  });

  it("isUnavailableEnvelope 的判据是 type/code，不看 message 文案（文案会随版本变）", () => {
    expect(isUnavailableEnvelope({ error: { message: "Loading model", type: "unavailable_error", code: 503 } })).toBe(true);
    expect(isUnavailableEnvelope({ error: { message: "Loading model", type: "other", code: 503 } })).toBe(true);
    expect(isUnavailableEnvelope({ error: { message: "Loading model", type: "unavailable_error", code: 200 } })).toBe(true);
    expect(isUnavailableEnvelope({ error: { message: "Loading model", type: "invalid_request_error", code: 400 } })).toBe(false);
    expect(isUnavailableEnvelope({ status: "ok" })).toBe(false);
    expect(isUnavailableEnvelope(null)).toBe(false);
    expect(isUnavailableEnvelope("Loading model")).toBe(false);
  });
});

// ── 真实夹具的形状（防夹具本身被手写替换） ────────────────────

describe("夹具真实性（防止有人手写一个「更好看」的夹具）", () => {
  it("props.ready 是 b10509 的真实响应（含 params.seed=4294967295 / total_slots=4 / build_info）", () => {
    const p = PROPS_READY.body as Record<string, unknown>;
    expect(PROPS_READY.status).toBe(200);
    expect((p.default_generation_settings as Record<string, unknown>)?.n_ctx).toBe(8192);
    expect((p.default_generation_settings as { params?: { seed?: number } }).params?.seed).toBe(4294967295);
    expect(p.total_slots).toBe(4);
    expect(String(p.build_info)).toMatch(/^b\d+-[0-9a-f]+$/);
    expect(p.endpoint_slots).toBe(true);
    /* ⚠️ 反直觉但有据：`/props` **能正常返回 200**，可它的能力开关 `endpoint_props` 却是 `false`。
       说明这个 flag 指的不是"本端点存不存在"（它显然存在），而是**别的**东西（多半是 per-slot 的 props 路由）。
       所以**不能**拿 `endpoint_props` 判断能不能问询 —— 判据只能是"发一次请求看状态码"。
       这里把它断言成 false，是为了防止有人"顺手改成 true"来让语义好看。 */
    expect(p.endpoint_props).toBe(false);
    expect(p.endpoint_metrics).toBe(false);
  });

  it("★ 实测事实：/props **没有** n_ctx_train —— 训练上限只能从 /v1/models 取", () => {
    // 这条断言的作用：若将来某个版本真的把 n_ctx_train 加进 /props，这里会红，
    // 提醒我们"可以简化取数路径了"，而不是让两份来源长期并存互相漂移。
    expect(JSON.stringify(PROPS_READY.body)).not.toContain("n_ctx_train");
  });

  it("models.ready 同时给 models[]（llama.cpp 形状）与 data[]（OpenAI 形状）", () => {
    const m = MODELS_READY.body as { models?: unknown[]; data?: unknown[]; object?: string };
    expect(MODELS_READY.status).toBe(200);
    expect(m.object).toBe("list");
    expect(Array.isArray(m.models)).toBe(true);
    expect(Array.isArray(m.data)).toBe(true);
  });

  it("★ 实测事实：加载中三个端点的信封**完全一致**（/health 不豁免）", () => {
    // 常见假设是 /health 会回 {"status":"loading model"}。实测不是：
    // 它给的就是同一个 unavailable_error 信封 —— 所以"加载中"只能靠这个信封识别。
    expect(PROPS_LOADING.status).toBe(503);
    expect(MODELS_LOADING.status).toBe(503);
    expect(HEALTH_LOADING.status).toBe(503);
    expect(PROPS_LOADING.body).toEqual(MODELS_LOADING.body);
    expect(HEALTH_LOADING.body).toEqual(MODELS_LOADING.body);
    expect((HEALTH_LOADING.body as { error?: { message?: string } }).error?.message).toBe("Loading model");
  });

  it("就绪的 /health 是 200 + {\"status\":\"ok\"}", () => {
    expect(HEALTH_READY.status).toBe(200);
    expect(HEALTH_READY.body).toEqual({ status: "ok" });
  });
});

// ── /props 解析 ─────────────────────────────────────────────

describe("parsePropsPayload —— 就绪态真实夹具", () => {
  const p = parsePropsPayload(PROPS_READY.body);

  it("取出有效窗口 n_ctx = 8192", () => {
    expect(p.effectiveCtx).toBe(8192);
  });

  it("取出别名/路径/量化/槽位/构建号/休眠位", () => {
    expect(p.alias).toMatch(/qwen3-1\.7b-q8_0\.gguf$/);
    expect(p.modelPath).toMatch(/qwen3-1\.7b-q8_0\.gguf$/);
    expect(p.ftype).toBe("Q8_0");
    expect(p.totalSlots).toBe(4);
    expect(p.buildInfo).toMatch(/^b\d+/);
    expect(p.sleeping).toBe(false);
  });

  it("多模态三件套都取到（本模型全 false，但**必须是 false 而不是 null**）", () => {
    expect(p.vision).toBe(false);
    expect(p.audio).toBe(false);
    expect(p.video).toBe(false);
  });

  it("工具能力取自 chat_template_caps（模板真支持才算数）", () => {
    expect(p.supportsTools).toBe(true);
    expect(p.supportsParallelToolCalls).toBe(true);
  });

  it("★ 不臆造 trainCtx（/props 没有这个字段）", () => {
    expect(p.trainCtx).toBeUndefined();
  });

  it("signals 记录了数字的实际来路", () => {
    expect(p.signals?.some((s) => s.includes("props.default_generation_settings.n_ctx=8192"))).toBe(true);
  });

  it("畸形输入不抛：null / 字符串 / 空对象 / 错类型字段", () => {
    for (const bad of [null, undefined, "props", 42, [], { default_generation_settings: "nope" }]) {
      const out = parsePropsPayload(bad);
      expect(out.effectiveCtx ?? null).toBeNull();
    }
    // n_ctx 是字符串 "8192"（某些网关会把数字序列化成字符串）→ 不收，宁可 null
    expect(parsePropsPayload({ default_generation_settings: { n_ctx: "8192" } }).effectiveCtx).toBeUndefined();
  });

  it("★ `0` 不等于有效窗口：n_ctx=0 / 负数 / NaN 一律丢弃并留痕", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = parsePropsPayload({ default_generation_settings: { n_ctx: bad } });
      expect(out.effectiveCtx).toBeUndefined();
      expect(out.signals?.some((s) => s.includes("非正数"))).toBe(true);
    }
  });

  it("supports_tools / supports_tool_calls 任一为 false 即不可用工具", () => {
    expect(parsePropsPayload({ chat_template_caps: { supports_tools: true, supports_tool_calls: false } }).supportsTools).toBe(false);
    expect(parsePropsPayload({ chat_template_caps: { supports_tools: false, supports_tool_calls: true } }).supportsTools).toBe(false);
    expect(parsePropsPayload({ chat_template_caps: { supports_tools: true, supports_tool_calls: true } }).supportsTools).toBe(true);
  });

  it("布尔字段不做 truthy 强转（字符串 \"false\" 不得变成 true）", () => {
    const out = parsePropsPayload({ modalities: { vision: "false" }, is_sleeping: "false" });
    expect(out.vision).toBeNull();
    expect(out.sleeping).toBeNull();
  });
});

// ── /v1/models 解析 ─────────────────────────────────────────

describe("parseModelsPayload —— 就绪态真实夹具", () => {
  const m = parseModelsPayload(MODELS_READY.body);

  it("★ 同一份响应里同时拿到有效窗口 8192 与训练上限 40960", () => {
    expect(m.effectiveCtx).toBe(8192);
    expect(m.trainCtx).toBe(40960);
  });

  it("取出词表/参数量/量化（展示用）", () => {
    expect(m.vocabSize).toBe(151936);
    expect(m.paramCount).toBe(1720574976);
    expect(m.ftype).toBe("Q8_0");
  });

  it("signals 指认**实际命中**的字段名（不能指认没命中的候选）", () => {
    const s = m.signals ?? [];
    expect(s).toContain("models.data[].meta.n_ctx=8192");
    expect(s).toContain("models.data[].meta.n_ctx_train=40960");
    expect(s.some((x) => x.includes("max_model_len"))).toBe(false);
  });

  it("加载态响应体解析不出任何数字（不会把错误信封当成模型条目）", () => {
    const out = parseModelsPayload(MODELS_LOADING.body);
    expect(out.effectiveCtx).toBeUndefined();
    expect(out.trainCtx).toBeUndefined();
  });

  it("只有 models[]（老版本 llama.cpp，无 meta）→ 只捡到名字，不臆造数字", () => {
    const out = parseModelsPayload({ object: "list", models: [{ name: "qwen3-1.7b" }] });
    expect(out.alias).toBe("qwen3-1.7b");
    expect(out.effectiveCtx).toBeUndefined();
    expect(out.signals?.some((s) => s.includes("无几何参数"))).toBe(true);
  });

  it("vLLM 风格的 max_model_len 也能取到（为 S5 删家族表铺路）", () => {
    const out = parseModelsPayload({ object: "list", data: [{ id: "Qwen3-32B", max_model_len: 32768 }] });
    expect(out.effectiveCtx).toBe(32768);
    expect(out.alias).toBe("Qwen3-32B");
  });

  it("别名寻址（S4 预备）：命中就用命中的那条；没命中退回 data[0] 并留痕", () => {
    const body = {
      object: "list",
      data: [
        { id: "a", meta: { n_ctx: 4096, n_ctx_train: 8192 } },
        { id: "b", meta: { n_ctx: 32768, n_ctx_train: 40960 } },
      ],
    };
    const hit = parseModelsPayload(body, "b");
    expect(hit.effectiveCtx).toBe(32768);
    expect(hit.alias).toBe("b");
    expect(hit.signals?.some((s) => s.includes("命中别名 b"))).toBe(true);

    const miss = parseModelsPayload(body, "zzz");
    expect(miss.alias).toBe("a");
    expect(miss.signals?.some((s) => s.includes("无别名 zzz"))).toBe(true);
  });
});

// ── 合并 ────────────────────────────────────────────────────

describe("readLocalCapability —— 合并两端口径", () => {
  it("★ 真实就绪态：state=ready，有效 8192 / 训练 40960（两个数字都在，且不同）", () => {
    const cap = readLocalCapability({
      props: PROPS_READY.body, propsStatus: PROPS_READY.status,
      models: MODELS_READY.body, modelsStatus: MODELS_READY.status,
    });
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBe(8192);
    expect(cap.trainCtx).toBe(40960);
    expect(cap.effectiveCtx).not.toBe(cap.trainCtx);
  });

  it("★ 真实加载态：state=loading 且**所有数字为 null**（不假装知道）", () => {
    const cap = readLocalCapability({
      props: PROPS_LOADING.body, propsStatus: PROPS_LOADING.status,
      models: MODELS_LOADING.body, modelsStatus: MODELS_LOADING.status,
    });
    expect(cap.state).toBe("loading");
    expect(cap.effectiveCtx).toBeNull();
    expect(cap.trainCtx).toBeNull();
    expect(cap.signals[0]).toContain("503");
  });

  it("真实不可达：都不给 → down", () => {
    expect(readLocalCapability({ propsStatus: null, modelsStatus: null }).state).toBe("down");
    expect(readLocalCapability({}).state).toBe("down");
  });

  it("只有 /props 就绪（/v1/models 挂了）→ 仍 ready，有效窗口有值、训练上限为 null", () => {
    const cap = readLocalCapability({ props: PROPS_READY.body, propsStatus: 200, modelsStatus: null });
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBe(8192);
    expect(cap.trainCtx).toBeNull();
  });

  it("★ n_ctx 冲突时以 /props 为准（它是当前生成设置，模型清单可能是缓存）", () => {
    const cap = readLocalCapability({
      props: { default_generation_settings: { n_ctx: 8192 } }, propsStatus: 200,
      models: { object: "list", data: [{ id: "x", meta: { n_ctx: 4096, n_ctx_train: 40960 } }] }, modelsStatus: 200,
    });
    expect(cap.effectiveCtx).toBe(8192);
    expect(cap.signals.some((s) => s.includes("n_ctx 冲突") && s.includes("采用 /props"))).toBe(true);
  });

  it("★ 就绪但解析不出 n_ctx → 显式留痕（版本回归信号，不许静悄悄返回 null）", () => {
    const cap = readLocalCapability({ props: { total_slots: 4 }, propsStatus: 200 });
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBeNull();
    expect(cap.signals.some((s) => s.includes("端点半结构可能变了"))).toBe(true);
  });

  it("非就绪态**清空数字**（加载中残留上一次的 n_ctx 是最坏的错：界面显示能装、其实还不能用）", () => {
    const cap = readLocalCapability({
      props: { default_generation_settings: { n_ctx: 8192 }, total_slots: 4 }, propsStatus: 503,
      models: MODELS_LOADING.body, modelsStatus: 503,
    });
    expect(cap.state).toBe("loading");
    expect(cap.effectiveCtx).toBeNull();
  });

  it("★ 有效窗口 > 训练上限（RoPE 外推配置）→ 留痕，但仍以有效窗口为准", () => {
    const cap = readLocalCapability({
      props: { default_generation_settings: { n_ctx: 65536 } }, propsStatus: 200,
      models: { object: "list", data: [{ id: "x", meta: { n_ctx: 65536, n_ctx_train: 40960 } }] }, modelsStatus: 200,
    });
    expect(cap.effectiveCtx).toBe(65536);
    expect(cap.signals.some((s) => s.includes("超过训练上限"))).toBe(true);
  });

  it("emptyCapability 给的是全 null + 指定状态", () => {
    const e = emptyCapability("down");
    expect(e.state).toBe("down");
    expect(e.effectiveCtx).toBeNull();
    expect(e.signals).toEqual([]);
  });
});

/** 去掉注释后的源码 —— 静态守卫必须盯**代码**而不是**注释**。
 *  A-1019 的实锤教训：守卫若对注释敏感，就会因为我写了一句解释性注释而误红；
 *  更糟的是有人为了让守卫变绿去删注释，而不是改代码。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── 窗口上限决策（S1 的核心：塌缩掉 6 分支级联） ─────────────

describe("resolveWindowCap —— 上限的唯一决策点", () => {
  const S = { effectiveCtx: 8192, trainCtx: 40960 } as Pick<LocalServerCapability, "state" | "effectiveCtx" | "trainCtx">;

  it("优先级：agent > server > planned > provider", () => {
    expect(resolveWindowCap({ agentMaxContext: 4096, serverCtx: 8192, plannedCtx: 32768, providerSpecCtx: 128000 }))
      .toMatchObject({ ctx: 4096, source: "agent" });
    expect(resolveWindowCap({ serverCtx: 8192, plannedCtx: 32768, providerSpecCtx: 128000 }))
      .toMatchObject({ ctx: 8192, source: "server" });
    expect(resolveWindowCap({ plannedCtx: 32768, providerSpecCtx: 128000 }))
      .toMatchObject({ ctx: 32768, source: "planned" });
    expect(resolveWindowCap({ providerSpecCtx: 128000 }))
      .toMatchObject({ ctx: 128000, source: "provider" });
  });

  it("★ 全空 → ctx=undefined / source=none，且**明确写出不许回落家族表**", () => {
    const r = resolveWindowCap({});
    expect(r.ctx).toBeUndefined();
    expect(r.source).toBe("none");
    expect(r.signals.some((s) => s.includes("家族能力表"))).toBe(true);
  });

  it("★ A-1018 ③ 的反例：真实夹具下答案是 8192，而**不是**训练上限 40960", () => {
    // 把两个真实数字喂进去，断言决策函数选的是服务器的有效窗口。
    // 若有人把 trainCtx 接到某条分支上（"反正更大，更宽松"），这里会红。
    const r = resolveWindowCap({ serverCtx: S.effectiveCtx });
    expect(r.ctx).toBe(8192);
    expect(r.ctx).not.toBe(S.trainCtx);
    expect(r.source).toBe("server");
  });

  it("0 / 负数 / 非有限 一律视为「没给」，逐级下沉", () => {
    expect(resolveWindowCap({ agentMaxContext: 0, serverCtx: 8192 })).toMatchObject({ ctx: 8192, source: "server" });
    expect(resolveWindowCap({ agentMaxContext: -5, serverCtx: -1, plannedCtx: 32768 }))
      .toMatchObject({ ctx: 32768, source: "planned" });
    expect(resolveWindowCap({ serverCtx: Number.NaN, plannedCtx: Number.POSITIVE_INFINITY }).source).toBe("none");
  });

  it("planned 兜底时留下「服务端未就绪」的痕迹（可解释性）", () => {
    const r = resolveWindowCap({ plannedCtx: 32768 });
    expect(r.signals.some((s) => s.includes("服务端未就绪"))).toBe(true);
  });

  it("★ 静态守卫：本模块**不得**依赖家族能力表（S5 之后它就是死路）", () => {
    const code = stripComments(readFileSync(SRC, "utf8"));
    // 只看代码（注释里当然要能提"家族能力表"—— 那是在解释为什么不许用它）
    expect(code).not.toContain("model-capabilities");
    expect(code).not.toContain("inferModelCapabilities");
    expect(code).not.toContain("MODEL_CAPABILITIES");
    // 524288 = qwen3 家族训练窗口。它**只能**作为测试里的对照数字出现，不许写进实现。
    expect(code).not.toMatch(/524288|1048576|131072/);
  });
});

// ── 展示 ────────────────────────────────────────────────────

describe("describeWindowCap —— 把「有效 vs 训练」两个数字讲清楚", () => {
  it("有效 ≠ 训练时两个都写出来（正面预防 A-1018 ③ 的误解）", () => {
    const s = describeWindowCap({ state: "ready", effectiveCtx: 8192, trainCtx: 40960 });
    expect(s).toContain("8,192");
    expect(s).toContain("40,960");
    expect(s).toContain("训练上限");
  });

  it("有效 = 训练时只写一个数字（不制造噪音）", () => {
    expect(describeWindowCap({ state: "ready", effectiveCtx: 32768, trainCtx: 32768 })).toBe("本次 32,768");
    expect(describeWindowCap({ state: "ready", effectiveCtx: 32768, trainCtx: null })).toBe("本次 32,768");
  });

  it("加载中 / 未启动有各自文案，且都不显示数字", () => {
    expect(describeWindowCap({ state: "loading", effectiveCtx: null, trainCtx: null })).toBe("模型加载中…");
    expect(describeWindowCap({ state: "down", effectiveCtx: null, trainCtx: null })).toBe("本地服务未启动");
  });

  it("就绪但窗口未知 → 明说未知（不留空、不留 0）", () => {
    expect(describeWindowCap({ state: "ready", effectiveCtx: null, trainCtx: null })).toBe("上下文窗口未知");
  });
});
