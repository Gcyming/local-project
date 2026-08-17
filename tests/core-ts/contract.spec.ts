import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as S from "../../shared/gen/schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, "../fixtures_contract.json"), "utf-8")) as {
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>;
};

describe("契约层双端互验（zod 侧；同一 fixtures 供 pydantic 侧复验）", () => {
  for (const [name, data] of Object.entries(fixtures.valid)) {
    it(`valid/${name} 通过 schema 校验`, () => {
      const key = name.replace("Batch", "") as keyof typeof S;
      const schema = S[key] as { safeParse: (x: unknown) => { success: boolean } };
      const result = schema.safeParse(data);
      expect(result.success, `${name}: ${JSON.stringify(result).slice(0, 200)}`).toBe(true);
    });
  }
  for (const [name, data] of Object.entries(fixtures.invalid)) {
    it(`invalid/${name} 被 schema 拒绝`, () => {
      const key = name.replace(/_(bad|missing)_?.*$/, "");
      const schema = S[key as keyof typeof S] as { safeParse: (x: unknown) => { success: boolean } };
      const result = schema.safeParse(data);
      expect(result.success, `${name} 应当被拒绝`).toBe(false);
    });
  }
  it("契约类集合与 openapi.yaml 顶层 schema 对齐（生成物完整性）", () => {
    const expected = [
      "ChatMessage", "ChatRequest", "ChatResponse", "ChatCompletionChunk",
      "EmbeddingsRequest", "EmbeddingsResponse", "RetrieveRequest", "RetrieveResponse",
      "HealthResponse", "StatsResponse", "ModelLoadRequest", "ModelLoadResponse", "ModelUnloadResponse",
    ];
    for (const name of expected) {
      expect(S[name as keyof typeof S], `缺少契约类 ${name}`).toBeDefined();
    }
    expect(Object.keys(S).filter((k) => k.endsWith("Response") || k.endsWith("Request") || k.endsWith("Message") || k.endsWith("Chunk")).length).toBeGreaterThanOrEqual(13);
  });
});
