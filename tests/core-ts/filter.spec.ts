import { describe, expect, it } from "vitest";
import { OutputFilter, StreamFilter } from "../../core-ts/src/filter.js";

describe("OutputFilter（身份铁律过滤，语义移植自 core/filter.py）", () => {
  const filter = new OutputFilter();

  it("替换模型名暴露（含连字符后缀整体替换，无残片）", () => {
    const r = filter.filter("我是基于 GPT-4o-mini 的模型，使用 Claude 3.5 引擎");
    expect(r.filtered).not.toContain("GPT-4o-mini");
    expect(r.filtered).not.toContain("-mini");
    expect(r.filtered).toContain("slime 平台");
    expect(r.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("替换 Qwen/DeepSeek/Llama 等模型名", () => {
    const r = filter.filter("我是 Qwen 模型，也是 DeepSeek 和 Llama 的兄弟");
    expect(r.filtered).toContain("slime 平台");
    expect(r.filtered).not.toContain("Qwen");
    expect(r.filtered).not.toContain("DeepSeek");
    expect(r.filtered).not.toContain("Llama");
  });

  it("替换中文 AI 身份表述（对齐 Python：只替换'作为+身份词'段）", () => {
    const r = filter.filter("作为一个人工智能语言模型，我可以帮助您");
    expect(r.filtered).toContain("作为 slime 平台");
    expect(r.filtered).not.toContain("作为一个");
    expect(r.filtered).toContain("人工智能语言模型"); // Python 原语义：残词保留
  });

  it("替换英文 AI 身份表述", () => {
    const r = filter.filter("As an AI language model, I can help");
    expect(r.filtered).toContain("As a slime platform agent");
    expect(r.filtered).not.toContain("AI language model");
  });

  it("替换'我是 xxx 模型'表述", () => {
    const r = filter.filter("我是 AI 模型，很高兴为你服务");
    expect(r.filtered).toContain("我是 slime 平台");
  });

  it("拦截底层模型讨论", () => {
    const r = filter.filter("我的底层模型是 transformer 架构");
    expect(r.filtered).not.toContain("底层模型");
  });

  it("拦截模型技术细节（要求'细节词'后 20 字符内跟'模型'，对齐 Python）", () => {
    const hit = filter.filter("我的训练数据来自公开语料构建的模型");
    expect(hit.filtered).not.toContain("训练数据");
    const miss = filter.filter("我的训练数据来自公开语料，上下文窗口为 128K"); // 无"模型"后缀 → 不命中（Python 同）
    expect(miss.filtered).toBe("我的训练数据来自公开语料，上下文窗口为 128K");
  });

  it("拦截 API 提供商暴露", () => {
    const r = filter.filter("本服务调用 OpenAI API 实现");
    expect(r.filtered).not.toContain("OpenAI API");
  });

  it("URL 与 agnes-* 技术标识符不受破坏（A-039 语义）", () => {
    const r = filter.filter(
      "图片地址: https://platform-outputs.agnes-ai.space/v1/img.png，模型标识符 agnes-image-2.1-flash 可用",
    );
    expect(r.filtered).toContain("https://platform-outputs.agnes-ai.space/v1/img.png");
    expect(r.filtered).toContain("agnes-image-2.1-flash");
  });

  it("空文本直接返回", () => {
    expect(filter.filter("").filtered).toBe("");
  });

  it("strict 模式违规即阻断", () => {
    const strict = new OutputFilter(undefined, true);
    const r = strict.filter("我是 GPT-4 模型");
    expect(r.blocked).toBe(true);
    expect(r.filtered).toContain("slime 平台");
  });
});

describe("StreamFilter（跨 chunk 过滤缓冲，_HOLD=32）", () => {
  const filter = new OutputFilter();

  it("跨 chunk 模型名完整匹配", () => {
    const sf = new StreamFilter();
    const parts = ["我是基于 ", "Qw", "en 3B 模型的", "助手，很高兴", "认识你"];
    let out = "";
    for (const p of parts) {
      out += sf.push(p, filter);
    }
    out += sf.flush(filter);
    expect(out).not.toContain("Qwen");
    expect(out).toContain("slime 平台");
    expect(sf.violations).toBeGreaterThan(0);
  });

  it("尾部残留（< hold）在 flush 时处理", () => {
    const sf = new StreamFilter();
    let out = sf.push("你好，我是", filter);
    out += sf.flush(filter);
    expect(out).toBe("你好，我是");
    expect(sf.violations).toBe(0);
  });

  it("单 chunk 超 hold 长度正常过滤", () => {
    const sf = new StreamFilter();
    let out = sf.push("作为人工智能语言模型我很强大" + "x".repeat(60), filter);
    out += sf.flush(filter);
    expect(out).not.toContain("人工智能语言模型");
  });
});
