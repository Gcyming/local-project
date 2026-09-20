/**
 * 构建产物断言：在**真正会被加载的 CSS bundle** 里核对 A-988 那几条规则。
 *
 * 为什么不在源码 index.css 上断言：源码有了 ≠ 产物里有（构建可能没跑、可能被别的规则覆盖）。
 * 用户的 Slime 加载的是 gui/out，所以断言必须打在 gui/out 上。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "out", "renderer", "assets");
const cssFile = readdirSync(assets).find((f) => f.endsWith(".css"));
if (!cssFile) { console.error("找不到 renderer CSS 产物"); process.exit(1); }
const css = readFileSync(join(assets, cssFile), "utf8");

const CHECKS = [
  ["spinner 被关掉（appearance: textfield）",
    /\.provider-model-table input\[type="number"\]\s*\{[^}]*appearance:\s*textfield/],
  ["spinner 的 webkit 内外按钮被移除",
    /provider-model-table[^{]*::-webkit-(?:inner|outer)-spin-button\s*\{[^}]*-webkit-appearance:\s*none/],
  ["单元格垂直居中（否则拨片 22px 与输入框 24px 基线错位）",
    /\.provider-model-table\s+th,\s*\.provider-model-table\s+td\s*\{[^}]*vertical-align:\s*middle/],
  ["价目明细整块铺满（A-1000：改 div 后不再有 td 的 padding）",
    /\.price-detail-block\s*\{[^}]*padding:\s*0/],
  ["价目明细虚线分隔",
    /\.price-detail-block\s*\{[^}]*border-top:\s*1px\s+dashed/],
  /* A-1016-F3：宽度过渡期间钉住 <webview> guest 宽度、只裁切（省掉逐帧跨进程 resize）。
     规则在源码里 ≠ 在产物里；这条同时钉住"必须带 var(--right-pin-w) 兜底"——
     只写类不写变量会让 var() 落空、声明退化为 unset、guest 宽度直接丢。 */
  ["右栏 webview 钉宽规则进了产物（含 var 兜底）",
    /\.right-wrapper-pin\s+webview\s*\{[^}]*width:\s*var\(--right-pin-w/],
  ["钉宽时 guest 不参与 flex 伸缩（flex: 0 0 auto）",
    /\.right-wrapper-pin\s+webview\s*\{[^}]*flex:\s*0\s+0\s+auto/],
];

let failed = 0;
console.log(`产物 CSS: ${cssFile} (${css.length} bytes)`);
for (const [name, re] of CHECKS) {
  const ok = re.test(css);
  if (!ok) { failed++; }
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}`);
}

/* ── 渲染层 JS 产物：TSX 改动是否真的进了 bundle ──
 * 源码改了但忘了 build 是这项目的高频事故（用户跑的是构建产物），
 * 所以这里对**产物**断言，而不是对源码断言。 */
const jsFile = readdirSync(assets).find((f) => f.startsWith("index-") && f.endsWith(".js"));
if (!jsFile) { console.error("找不到 renderer JS 产物"); process.exit(1); }
const js = readFileSync(join(assets, jsFile), "utf8");
const JS_CHECKS = [
  ["列宽方案进了 bundle（上下文K / 输出K 9.5%）", /9\.5%/],
  ["价目明细块进了 bundle（四个费率字段共用一格样式）", /price-detail-block/],
  ["缓存命中 / 缓存写入两个字段名进了 bundle", /price_cache_write_usd/],
  /*
   * A-1000：这条原先断言 `width:"24.5%"` —— 那是 A-988 中途试过的列宽方案，后来定稿改为
   * 「定价来源 26% / 图片 6.5%」，断言却没跟着改，于是**长期假红**。
   * 陈旧守卫比没有守卫更糟：真回归会被这条噪音盖住（本轮就在噪音里查了一圈）。
   * 现在改成两条：正向断言**当前**方案已进产物，反向断言旧值不得复现。
   */
  ["列宽定稿：定价来源 26% 已进 bundle", /26%/],
  ["旧的 24.5% 列宽方案没有残留", /24\.5%/, true],
  /* A-1016-F3：钉宽逻辑（挂类 + 写 --right-pin-w + 结束时摘）必须进产物。
     字符串在 bundle 里出现 = 源码改动真的构建进去了（用户跑的是产物）。 */
  ["右栏 webview 钉宽逻辑进了 bundle（类名 + CSS 变量名）",
    /right-wrapper-pin[\s\S]{0,240}--right-pin-w/],
  /* A-1017：价目明细改为内联在模型行正下方 —— `<td colSpan={6}>` 必须进产物。
     colSpan 6 = 表格 6 列全跨（启用/模型ID/上下文K/输出K/图片/定价来源）。 */
  ["价目明细内联行进了 bundle（td colSpan=6 跨满整行）", /colSpan:\s*6/],
  /* A-1017：展开后居中滚动必须进产物（读全局折叠节拍 + 滚动容器 ref）。 */
  ["价目明细展开后居中逻辑进了 bundle", /scrollTop\s*\+\s*delta/],
];
console.log(`\n产物 JS: ${jsFile} (${js.length} bytes)`);
for (const [name, re, negate] of JS_CHECKS) {
  const hit = re.test(js);
  const ok = negate ? !hit : hit;
  if (!ok) { failed++; }
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}`);
}

if (failed > 0) {
  console.error(`\n${failed} 条断言未命中 —— 产物里缺失，用户界面不会有这个效果`);
  process.exit(1);
}
console.log("\n构建产物断言全部命中（CSS + 渲染层 JS）");
