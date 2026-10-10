/**
 * core-ts/src/local_model_probe.ts — **本地模型一键自检**（A-1201）。
 *
 * ## 为什么单独一个模块
 * 自检要**真发一次聊天请求**，而项目的铁律是
 * 「主进程不许自己 `new` 任何 client 类」（`a1106-guards` D2）—— 因为自建 client
 * 会绕过 `createRouteClient` 里的限流器，是历史上反复踩过的坑。
 * 所以探测逻辑落在 core-ts 侧（这里本来就用 client），主进程只做转发。
 *
 * ## 为什么要自检（用户口径：「根本无法使用」）
 * 本地模型最典型的失败形态是**服务起来了、状态是绿的、但模型不说话**：
 *   · 思考模式把输出预算吃光 ⇒ `content` 为空字符串（`finish_reason: length`）；
 *   · 模型文件损坏 / 模板不兼容 ⇒ 空回复或报错。
 * 光看"进程在不在"完全发现不了这些，所以自检必须**看正文有没有内容**。
 *
 * ## 与真聊的参数**同源**
 * 请求体里的思考参数由 `localThinkingParams` 生成 —— 与 `SlimeEngine` 发聊天请求时
 * 用的是**同一个函数**。若自检另写一套参数，就会出现"自检通过但真聊不出话"，
 * 那比没有自检更坏（用户会据此以为环境没问题）。
 */

import { ChatClient } from "./llm/client.js";
import { localThinkingParams, type LocalModelSpec } from "./local_models.js";

export interface LocalProbeResult {
  ok: boolean;
  /** 端到端耗时（ms）。 */
  ms: number;
  /** 模型返回的正文样本（截断到 300 字）。 */
  sample?: string;
  /** 失败原因 —— **必须可读**，且空正文要被点名。 */
  error?: string;
}

/** 自检用的最小提问。刻意短，避免把时间花在生成上。 */
const PROBE_PROMPT = "请用一句话回答：你好";
const PROBE_MAX_TOKENS = 128;
const SAMPLE_CAP = 300;

/**
 * 对某个已就绪的端点发一次最小请求，如实回报结果。
 *
 * @param baseUrl 形如 `http://127.0.0.1:18082`（调用方负责先确保服务已就绪）
 * @param spec    模型规格（思考模式从这里取 —— 与真聊同一来源）
 */
export async function probeLocalModel(
  baseUrl: string,
  spec: Pick<LocalModelSpec, "id" | "thinking">,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<LocalProbeResult> {
  const t0 = Date.now();
  const client = new ChatClient({ baseUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  let text = "";
  try {
    await client.chatStream(
      {
        model: spec.id,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        /* ⚠️ 与真聊**同源**：换掉这个调用就会退化成"自检说的和真跑的不是一回事"。 */
        ...localThinkingParams(spec.thinking, spec.id),
      } as never,
      (d) => { text += d; },
    );
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: `请求失败：${e instanceof Error ? e.message : String(e)}` };
  }

  const sample = text.trim();
  if (!sample) {
    /* 空正文必须**点名**并给出下一步 —— 否则用户只看到"自检失败"，不知道往哪改。 */
    return {
      ok: false,
      ms: Date.now() - t0,
      error: "服务通了，但模型返回了空正文（常见原因：思考模式占满输出预算）。"
        + "可在该模型的编辑页把「思考模式」设为「关」后重试。",
    };
  }
  return { ok: true, ms: Date.now() - t0, sample: sample.slice(0, SAMPLE_CAP) };
}
