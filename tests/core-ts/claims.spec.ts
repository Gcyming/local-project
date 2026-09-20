/**
 * tests/core-ts/claims.spec.ts — 幻觉护栏核心测试（A-047 语义移植）。
 * 对照 core/claims.py 的检测语义逐项验证。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { findUnverifiedClaims, auditClaims, PROJECT_ROOT } from "../../core-ts/src/claims.js";

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

  // ── A-987：空间路径截断（假指控根因）+ 精度优先改造 ──────────────

  it("含空格的不存在路径必须**整条**报出（A-987：碎片化报告会误导调用方）", async () => {
    // 本用例目录本身就在 `…\pilot project\…` 下，天然含空格
    if (process.platform !== "win32") {
      return; // POSIX 盘符分支不适用（护栏面向 Windows-first 场景），跳过
    }
    const fake = join(work, "sub dir", "report.md");
    const claims = await findUnverifiedClaims(`报告已生成：${fake}`);
    expect(claims).toContain(fake);
  });

  it("同一句里的两个路径不得被拼成一条（惰性收尾到扩展名，A-987）", async () => {
    // 旧版贪婪匹配会把「a.png 和 b.png」吞成一条不存在的路径 → 凭空制造假警报
    const a = join(work, "a.png");
    const b = join(work, "b.png");
    await writeFile(a, "x", "utf-8");
    await writeFile(b, "y", "utf-8");
    expect(await findUnverifiedClaims(`已保存 ${a} 和 ${b}`)).toEqual([]);
  });

  it("被截断的路径碎片绝不指控（A-987 精度优先：宁可漏报也不喊狼来了）", async () => {
    await mkdir(join(work, "pilot project"), { recursive: true });
    expect(await findUnverifiedClaims(`已保存到 ${join(work, "pilot")}`)).toEqual([]);
  });

  it("围栏代码块内的路径不核验（示例代码不是对结果的声称，A-987）", async () => {
    const reply = "已写入 package.json\n参考用法（非本次产出）：\n"
      + "```python\n" + 'open(r"D:\\zz_demo_not_exist_xyz\\output.png", "wb")\n' + "```\n";
    expect(await findUnverifiedClaims(reply)).toEqual([]);
  });

  it("证据性触发要求「数字 + 单位」：英文里的 mb 子串不再误触发（A-987）", async () => {
    // 旧版把 `mb` 当裸子串 → "Remember"/"number" 命中 → 整段无关文本进入核验
    const decoy = "Remember the number of steps: 3. See docs/ghost_never_abc123.md for details.";
    expect(await findUnverifiedClaims(decoy)).toEqual([]);
    // 真正的证据性描述仍必须触发
    const hits = await findUnverifiedClaims("完整路径 docs/ghost_never_abc123.md");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("auditClaims 给出结构化结果（类别 + 「是不是想写 X」建议 + 跳过计数）", async () => {
    await writeFile(join(work, "report_final.md"), "x", "utf-8");
    const audit = await auditClaims(`已生成 ${join(work, "report_fianl.md")}`); // 拼错
    expect(audit.issues.map((i) => i.kind)).toEqual(["missing"]);
    expect(audit.issues[0]!.severity).toBe("high");
    expect(audit.issues[0]!.suggestion).toBe("report_final.md");
    // 兼容接口：旧的字符串返回保持不变
    expect(await findUnverifiedClaims(`已生成 ${join(work, "report_fianl.md")}`))
      .toEqual([join(work, "report_fianl.md")]);
  });

  it("auditClaims 记录被跳过项的原因（护栏是否在喊狼来了必须可归因）", async () => {
    const audit = await auditClaims("已生成\n```\nD:\\x\\y.png\n```\n");
    expect(audit.issues).toEqual([]);
    expect(audit.skipped.fenced_block).toBe(1);
  });
});