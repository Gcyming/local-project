/**
 * tests/core-ts/claims.spec.ts — 幻觉护栏核心测试（A-047 语义移植）。
 * 对照 core/claims.py 的检测语义逐项验证。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { findUnverifiedClaims, PROJECT_ROOT } from "../../core-ts/src/claims.js";

describe("findUnverifiedClaims（幻觉护栏）", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(PROJECT_ROOT, "data", "claim-tmp-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("无声称动词/证据性描述 → 不核验", async () => {
    expect(await findUnverifiedClaims("你好，今天天气不错")).toEqual([]);
    expect(await findUnverifiedClaims("")).toEqual([]);
  });

  it("声称已保存但路径不存在 → 检出编造路径", async () => {
    const fake = join(work, "no-such.md");
    const claims = await findUnverifiedClaims(`已完成，已保存到 ${fake}`);
    expect(claims).toContain(fake);
  });

  it("声称已生成且文件真实存在 → 不报", async () => {
    const real = join(work, "real.md");
    await writeFile(real, "内容", "utf-8");
    expect(await findUnverifiedClaims(`已生成报告并保存到 ${real}`)).toEqual([]);
  });

  it("证据性描述（文件大小/字节）同样触发核验（A-048-R6 规避动词检测）", async () => {
    const fake = join(work, "ev.md");
    const claims = await findUnverifiedClaims(`输出文件：${fake}，文件大小 1,034,594 字节`);
    expect(claims).toContain(fake);
  });

  it("URL 段剔除（不把 https:// 当本地路径）", async () => {
    const claims = await findUnverifiedClaims("请访问 https://example.com/abc.png 查看，已生成完毕");
    expect(claims).toEqual([]);
  });

  it("域名样式残片跳过（A-050-R：模型改写 URL 的残片不算路径）", async () => {
    const claims = await findUnverifiedClaims("已保存，见 平台-ai.cn/videos/123.mp4");
    expect(claims).toEqual([]);
  });

  it("裸文件名先查 data/generated/ 子目录（A-050-R2）", async () => {
    const dir = join(PROJECT_ROOT, "data", "generated");
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(join(dir, "images", "1786793001_4cdfec6f.png"), "x", "utf-8");
    try {
      expect(await findUnverifiedClaims("已生成图片 1786793001_4cdfec6f.png")).toEqual([]);
      expect(await findUnverifiedClaims("已生成图片 999999_none.png")).toEqual(["999999_none.png"]);
    } finally {
      await rm(join(dir, "images", "1786793001_4cdfec6f.png"), { force: true });
    }
  });

  it("假数值拦截：路径存在但声称字节数与真实值偏差 >15% 或 >512B", async () => {
    const real = join(work, "size.md");
    await writeFile(real, "a".repeat(1000), "utf-8");
    const claims = await findUnverifiedClaims(`已保存到 ${real}，文件大小 1,034,594 字节`);
    expect(claims.length).toBe(1);
    expect(claims[0]).toContain("数值不实");
    expect(await findUnverifiedClaims(`已保存到 ${real}，文件大小 1000 字节`)).toEqual([]);
  });

  it("相对路径锚定项目根核验；带 .. 逃逸的相对路径跳过核验", async () => {
    const claims = await findUnverifiedClaims("已保存到 docs/../../secret.md");
    expect(claims).toEqual([]);
    const inside = await findUnverifiedClaims("已保存到 package.json");
    expect(inside).toEqual([]); // 项目根内真实存在
  });

  it("反引号包裹的路径同样检出（A-048-R6 markdown 代码包裹）", async () => {
    const fake = join(work, "bq.md");
    const claims = await findUnverifiedClaims(`已保存到 \`${fake}\``);
    expect(claims).toContain(fake);
  });
});