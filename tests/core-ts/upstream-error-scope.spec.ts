












import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MODEL_LEVEL_ERROR_RE,
  isModelLevelErrorText,
  modelScopeFromUpstreamText,
} from "../../core-ts/src/upstreamErrorScope.js";


function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("modelScopeFromUpstreamText（错误作用域判定，顺序逐字保持旧 client.ts 语义）", () => {
  it("智谱真实事故正文 + 400 → 'model'（降级链据此换模型）", () => {
    const body = '{"error":{"code":"1211","message":"模型不存在，请检查模型代码。"}}';
    expect(modelScopeFromUpstreamText(body, 400)).toBe("model");
  });

  it("401 永远 provider（即便正文含模型级词）", () => {
    expect(modelScopeFromUpstreamText("RegionError: model unavailable", 401)).toBe("provider");
  });

  it("含模型级正文 + 403 → 'model'（区域限制属模型级）", () => {
    expect(modelScopeFromUpstreamText("Model is unavailable in your region", 403)).toBe("model");
  });

  it("纯 403（非空但无模型级特征）→ 'provider'；空正文 403 → undefined；空 400/401 → undefined", () => {
    expect(modelScopeFromUpstreamText("some unrelated upstream error", 403)).toBe("provider");
    expect(modelScopeFromUpstreamText("", 403)).toBeUndefined();
    expect(modelScopeFromUpstreamText("", 400)).toBeUndefined();
    expect(modelScopeFromUpstreamText("", 401)).toBeUndefined();
  });

  it("判定顺序：先 401 再正文再 403（空正文绕过所有）", () => {
    
    expect(modelScopeFromUpstreamText("model not found", 500)).toBe("model");
    expect(modelScopeFromUpstreamText("some other error", 500)).toBeUndefined();
  });
});

describe("模型级特征表：原 8 条英文形态 + 新增英文/中文形态 + 智谱 1211 全部命中", () => {
  
  const originalEn: string[] = [
    "RegionError: not available in your country",
    "Model is not available in your region",
    "Model is unavailable",
    "Model not unavailable",
    "model unavailable",
    "model_not_found",
    "model not found",
    "freeusagelimit",
    "Endpoint is unavailable",
    "invalid model",
  ];
  
  const newEn: string[] = [
    "no such model",
    "unknown model",
    "unsupported model",
    "this model does not exist",
  ];
  
  const newZh: string[] = [
    "模型不存在",
    "模型不可用",
    "不存在的模型",
    "不存在模型",
    "无效的模型",
    "模型已下线",
    "模型下线",
    "请检查模型代码",
  ];
  
  const zhipuCode: string[] = [
    '{"error":{"code":"1211","message":"模型不存在，请检查模型代码。"}}',
  ];

  const allModel = [...originalEn, ...newEn, ...newZh, ...zhipuCode];

  for (const text of allModel) {
    it(`modelScopeFromUpstreamText(${JSON.stringify(text).slice(0, 40)}…, 400) → "model"`, () => {
      expect(modelScopeFromUpstreamText(text, 400)).toBe("model");
    });
    it(`isModelLevelErrorText(${JSON.stringify(text).slice(0, 40)}…) → true`, () => {
      expect(isModelLevelErrorText(text)).toBe(true);
    });
  }

  it("MODEL_LEVEL_ERROR_RE 导出且对中文形态可测（守卫测试引用）；智谱 1211 走独立错误码判据", () => {
    expect(MODEL_LEVEL_ERROR_RE).toBeInstanceOf(RegExp);
    expect(MODEL_LEVEL_ERROR_RE.flags).toContain("i");
    expect(MODEL_LEVEL_ERROR_RE.test("模型不存在")).toBe(true);
    expect(MODEL_LEVEL_ERROR_RE.test("请检查模型代码")).toBe(true);
    
    expect(MODEL_LEVEL_ERROR_RE.test('"code":"1211"')).toBe(false);
    expect(isModelLevelErrorText('{"error":{"code":"1211","message":"模型不存在"}}')).toBe(true);
  });
});

describe("反向要求：不得吞掉无关 400", () => {
  const irrelevant: Array<[string, number]> = [
    
    ['{"error":{"message":"上下文长度超过模型上限"}}', 400],
    
    ['{"error":{"code":"1210","message":"请求参数错误"}}', 400],
    
    ['{"error":{"code":"1301","message":"系统错误"}}', 400],
  ];
  for (const [body, status] of irrelevant) {
    it(`modelScopeFromUpstreamText(${JSON.stringify(body).slice(0, 36)}…, ${status}) → undefined（不误判模型级）`, () => {
      expect(modelScopeFromUpstreamText(body, status)).toBeUndefined();
      expect(isModelLevelErrorText(body)).toBe(false);
    });
  }
  it("空正文 400 / 401 → undefined（不误伤）", () => {
    expect(modelScopeFromUpstreamText("", 400)).toBeUndefined();
    expect(modelScopeFromUpstreamText("", 401)).toBeUndefined();
    expect(isModelLevelErrorText("")).toBe(false);
    expect(isModelLevelErrorText(undefined)).toBe(false);
    expect(isModelLevelErrorText(null)).toBe(false);
  });
});

describe("源码级反向守卫：特征表只剩 upstreamErrorScope.ts 一份", () => {
  const ROOT = new URL("../../", import.meta.url); 
  const read = (rel: string): string => readFileSync(new URL(rel, ROOT), "utf8");

  it("client.ts 不再各自硬编码特征词，且 import 了唯一实现", () => {
    const src = stripComments(read("core-ts/src/llm/client.ts"));
    
    expect(src, "client.ts 不应再含 freeusagelimit").not.toContain("freeusagelimit");
    expect(src, "client.ts 不应再含 regionerror").not.toContain("regionerror");
    
    expect(src, "client.ts 必须 import upstreamErrorScope.js").toContain("upstreamErrorScope.js");
  });

  it("probe-live.ts 不再各自硬编码特征词，且 import 了唯一实现", () => {
    const src = stripComments(read("core-ts/src/probe-live.ts"));
    expect(src, "probe-live.ts 不应再含 regionerror").not.toContain("regionerror");
    expect(src, "probe-live.ts 不应再含 模型不存在（中文文案只剩 upstreamErrorScope.ts 一份）").not.toContain("模型不存在");
    expect(src, "probe-live.ts 必须 import upstreamErrorScope.js").toContain("upstreamErrorScope.js");
  });
});
