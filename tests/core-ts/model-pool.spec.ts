/**
 * tests/core-ts/model-pool.spec.ts — 对话模型池过滤（防非对话模型污染降级链）。
 *
 * 背景：AGNES 供应商返回 10 个模型，其中 agnes-image-* / agnes-video-* 共 5 个在
 * /v1/chat/completions 上返回 400（"Model xxx is an image model"）。原实现把这些模型
 * 也注入对话降级池，主模型限流时降级链落到它们身上 → 表现为「模型突然不会调工具」。
 */
import { describe, it, expect } from "vitest";
import { isChatCapableModel } from "../../core-ts/src/services/engine.js";

describe("isChatCapableModel — 非对话模型识别", () => {
  it("AGNES 的对话模型保留", () => {
    for (const id of ["agnes-2.0-flash", "agnes-2.5-flash", "agnes-2.5-pro", "agnes-2.5-pro-alpha", "agnes-2.5-pro-beta"]) {
      expect(isChatCapableModel(id), id).toBe(true);
    }
  });

  it("AGNES 的图片/视频模型剔除（实测在 chat/completions 返回 400）", () => {
    for (const id of ["agnes-image-2.1-flash", "agnes-image-2.5-flash", "agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]) {
      expect(isChatCapableModel(id), id).toBe(false);
    }
  });

  it("其它供应商的常见非对话模型也剔除", () => {
    for (const id of [
      "text-embedding-3-small", "text-embedding-ada-002", "bge-m3", "bge-reranker-v2",
      "dall-e-3", "stable-diffusion-xl", "flux-1.1-pro", "sora-2",
      "whisper-1", "tts-1-hd", "qwen-audio-turbo",
      "glm-4v-image-gen", "some-ocr-model", "omni-moderation-latest",
    ]) {
      expect(isChatCapableModel(id), id).toBe(false);
    }
  });

  it("多模态对话模型不被误伤（vision/vl 仍可用于对话）", () => {
    for (const id of [
      "gpt-4o", "gpt-6-astra", "claude-fable-5-1", "gemini-3.8-flash",
      "deepseek-v4-flash-vision-exp", "qwen-vl-max", "glm-4v-plus",
      "kimi-k2-vision", "muse-spark-1.3", "glm-5.3-flash", "big-pickle", "dots3-note-prev",
    ]) {
      expect(isChatCapableModel(id), id).toBe(true);
    }
  });

  it("边界：空串/纯符号 不当作可用模型", () => {
    expect(isChatCapableModel("")).toBe(false);
  });
});
