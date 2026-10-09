/**
 * tests/core-ts/a1197-silam-template.spec.ts —「silam 下线必须覆盖**干净安装**」+ 本轮 P1/P2 的守卫
 *
 * ## P0-2：上一轮的「下线」只做了本机一半，干净安装上全是假的
 *   上一轮把 `[silam]` 置为关闭，改的是**仓库根的本机 `slime.toml`**。
 * 但那份文件**被 gitignore**（不入库）；真正会随包发出去的是
 * `gui/template/slime.toml`（受版本控制，`gui/electron-builder.json:23` 收录 files、
 *   `:86` 明确 `{ "from": "template/slime.toml", "to": "slime.toml" }`）。
 *   而 `gui/src/main/boot.ts` 的 `bootstrapToml`（约107-172 行）只 applyKey 三个键
 *   （`llama_bin` / `model_path` / `models_dir`，调用点见 152/156/157 行），**不碰 `[silam]`**
 *   ⇒ 新用户装包后 `readSilamConfig()`（`core-ts/src/services/silam_brain.ts:163-206`）
 *   在模板里读出 `enabled=true` / `as_brain=true` ⇒ 引擎仍会调真实 SILAM ⇒ 输出乱码。
 *
 * ## 断言分五组
 *   A.模板 `[silam]` 开关已断（且**整段保留**，不许删段当占位）
 *   B. 模板确实会随包发出去（electron-builder 的 from/to 映射钉死，附送files 收录）
 *   C. `boot.ts` 的bootstrapToml 不许把 `[silam]` 改回去（它只applyKey 三个键）
 *   D. 本轮 P1/P2：dataRoot / dataRootSet 的形状
 *   E. 本轮 P2-3：agentTools 归因文案（四点语义一字不许丢）
 *
 * ⚠️ 词边界（本项目四次前科，见 a1197-silam-off.spec.ts 文件头，这里再列一遍）：
 *   ① **代码形状断言必须先剥注释**（stripCode）—— 注释里解释历史缺陷的原文会被当成代码命中。
 *   ② 判「旧文案已消失」必须用**带边界的正则 + 整族语义**，不能只搜那一句原文。
 *   ③ 前科 `markPluginDisabled` 被 `unmarkPluginDisabled` 假命中 ⇒ 标识符后面必须跟词边界。
 *   ④ 前科 `SilamBrain` 被 `SilamBrainRemovedByMutation` 假命中 ⇒ 名字后必须**紧跟** `{`。
 *   ⑤ 前科：锚点以 `(` 结尾后跟词字符 ⇒ 右边界必然失配 ⇒ **计数恒 0、断言永远绿**。
 *      本文件所有「命中计数」类断言在写完后都**实测过计数不为 0**（见各处注释）。
 *   ⑥ 前科：左边界里加 `.` 同理（`.` 会吃掉 `SilamBrain` 的 `S`，`(?<!\.)` 形同虚设）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 统一行尾，避免 CRLF 影响跨行正则。 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

/**
 * 剥掉注释，只留代码 —— 代码形状断言必须用它（见文件头①）。
 * 块注释与行注释都真配平剥离（`\/\*` … `\*\/`、`//` 到行尾），不做偷懒式replace。
 */
function stripCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

const TEMPLATE = read("gui/template/slime.toml");
const LOCAL_TOML = read("slime.toml");
const BUILDER = read("gui/electron-builder.json");
const BOOT_RAW = read("gui/src/main/boot.ts");
const BOOT = stripCode(BOOT_RAW);
const DATAROOT_RAW = read("gui/src/main/dataRoot.ts");
const DATAROOT = stripCode(DATAROOT_RAW);
const MAIN_RAW = read("gui/src/main/index.ts");
const MAIN = stripCode(MAIN_RAW);
const AGENTTOOLS_RAW = read("core-ts/src/services/agentTools.ts");
const AGENTTOOLS = stripCode(AGENTTOOLS_RAW);

/**
 * 取出某个 toml 的 [silam] 段正文（到下一个段头为止）。
 *
 * ⚠️ **不许用 `(?=^\[|\Z)`**（照抄 a1197-silam-off.spec.ts 的那个写法在JS 里有个坑）：
 *   JS 正则**没有 `\Z`**（那是 Python 语法），它会当成字面量 `Z` 去匹配，
 *   于是「[silam] 是文件最后一个段」（本仓模板正是如此）时整条正则匹配不到任何东西
 *   ⇒ 断言恒假红（实测踩到）。
 * ⇒ 改成逐行推进：`[silam]` 段头之后，凡是**不以 `[` 开头**的行都算段内。
 */
function sahamSection(toml: string): string {
  const m = toml.match(/^\[silam\][^\n]*(?:\n(?!\[)[^\n]*)*/m);
  return m ? m[0] : "";
}

/** 取出 bootstrapToml 的函数体（到下一个顶层 `export function` / 顶层 `}` 之前）。 */
function bootstrapTomlBody(): string {
  const m = BOOT.match(/function bootstrapToml\([\s\S]*?\n\}/);
  return m ? m[0] : "";
}

/** 取出 dataRootSet 的 handler 体（从 handleTrusted 到下一个 handleTrusted）。 */
function dataRootSetHandler(): string {
  const m = MAIN.match(/handleTrusted<\{ dir: string; migrate: boolean \}>\("slime:dataRoot:set"[\s\S]*?\n  \}\);/);
  return m ? m[0] : "";
}

describe("A-1197 P0-2 A 模板 [silam]：开关已断，但整段与占位保留", () => {
  it("A1 模板的 [silam] 段 enabled 与 as_brain 都必须是 false", () => {
    const sec = sahamSection(TEMPLATE);
    expect(sec, "模板里找不到 [silam] 段（整段被删了？）").not.toBe("");
    expect(sec).toMatch(/^enabled\s*=\s*false\s*(#.*)?$/m);
    /*⚠️ 两个键都要钉死：只判 enabled 的话，把 as_brain 改回 true（重新启用无模型兜底）
       而enabled 仍为 false 时断言照样绿 —— 而那正是要拆掉的路径。 */
    expect(sec).toMatch(/^as_brain\s*=\s*false\s*(#.*)?$/m);
  });

  it("A2 模板的 [silam] 整段不许被删（占位键与说明都在）", () => {
    const sec = sahamSection(TEMPLATE);
    expect(sec).toContain("agent_id");
    expect(sec).toMatch(/^agent_id\s*=\s*"silam-default"\s*$/m);
    /* ⚠️ [silam] 在模板里**就是最后一个段**（实测：段头序列以它收尾），
     * 所以「段后还有别的段」这条判据不成立、也不该写 ——
     * 写了就是一条恒假的假红。真正的判据是：段体不止开关两行（占位键还在），
     * 且段前有整段保留的说明（见 A3），两者合起来才等价于「整段保留作占位」。 */
    expect(sec.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length)
      .toBeGreaterThanOrEqual(3);
  });

  it("A3 模板里必须写清「为何关闭」且照本机口径（乱码 + 硬截断 + 资产保留占位）", () => {
    const idx = TEMPLATE.indexOf("[silam]");
    expect(idx).toBeGreaterThan(-1);
    // 说明写在段前（注释）或段内，都算；这里取 [silam] 之前的引导注释
    const lead = TEMPLATE.slice(Math.max(0, idx - 800), idx);
    expect(lead).toMatch(/下线|关闭/);
    /* ⚠️ 归因必须含**具体病症**，不能只说「暂时下线」—— 否则后人以为回一个 true 就能开。 */
    expect(lead).toMatch(/乱码/);
    expect(lead).toMatch(/截断/);
    expect(lead).toMatch(/占位/);
    // 不吹「即将支持」这一族（占位不许被读成「快好了」）
    expect(lead + sahamSection(TEMPLATE)).not.toMatch(/(即将|敬请期待|马上就好|很快就)/);
  });

  it("A4 本机 slime.toml 同样保持关闭（本轮未改它，但要钉住现状不被回退）", () => {
    const sec = sahamSection(LOCAL_TOML);
    expect(sec).not.toBe("");
    expect(sec).toMatch(/^enabled\s*=\s*false\s*(#.*)?$/m);
    expect(sec).toMatch(/^as_brain\s*=\s*false\s*(#.*)?$/m);
    expect(sec).toContain("backbone_path");
  });
});

describe("A-1197 P0-2 B 模板确实会随包发出去（改了模板才等于改了干净安装）", () => {
  it("B1 electron-builder 必须把 template/slime.toml 映射为安装根 slime.toml", () => {
    /* ⚠️ 这一条是本组的**前提**：模板改了但没进包 ⇒ 新用户拿到的仍是旧模板，
       守卫会一片绿而缺陷原样存在。from/to 两段都必须钉死，且用对象字面量形态匹配
      （electron-builder.json:86 就是这个形态）。 */
    /* ⚠️ 词边界（前科：`SlameBrain` 那类一个字母之差就会漏）：
 * 判「不许把模板映射到第二个目的地」时，键名必须**逐字比对**——
 * 上面 `template\/[^"]*slame[^"]*` 里的 `slame` 是手滑（应为 `slam`），
 * 而这种拼错的表现恰好是「匹配到 0 个 ⇒ 断言看着绿、其实什么都没判」。
 * ⇒ 这里的判据改成**穷举计数**：整个文件里 `"template/slime.toml"` 恰好出现 2 次
 *（files 白名单 1 + extraFiles 映射 1），任何「映射到别处 / 少一处」都会破。
 * 另配一条正向断言把目的地写死，避免只靠计数。 */
    expect(BUILDER).toMatch(
      /\{\s*"from"\s*:\s*"template\/slime\.toml"\s*,\s*"to"\s*:\s*"slime\.toml"\s*\}/,
    );
    // 整个 builder 里凡是把模板目录里的东西映射出去的，只允许 slime.toml 这一条
    const froms = [...BUILDER.matchAll(/"from"\s*:\s*"(template\/[^"]*\.toml)"/g)].map((m) => m[1]);
    expect(froms).toEqual(["template/slime.toml"]);
  });

  it("B2 模板必须仍被 files 白名单收录（打包时被排除就等于没改）", () => {
    expect(BUILDER).toMatch(/"template\/slime\.toml"/);
    // 收录项出现的总次数应恰好 2（files 白名单 1 + extraFiles 映射 1）；多了说明有第二份映射
    expect((BUILDER.match(/"template\/slime\.toml"/g) ?? []).length).toBe(2);
  });

  it("B3 仓库根 slime.toml 被 gitignore ⇒ 模板才是唯一入库产地（前提事实）", () => {
    const gi = read(".gitignore").replace(/\r\n/g, "\n");
    expect(gi, "仓库根 slime.toml 若已不再被忽略，本组的「只改模板」结论要重新评估")
      .toMatch(/^\s*slime\.toml\s*$/m);
  });
});

describe("A-1197 P0-2 C 干净安装路径：bootstrapToml 不会把 [silam] 改回去", () => {
  it("C1 bootstrapToml 只 applyKey 三个键（llama_bin / model_path / models_dir）", () => {
    const body = bootstrapTomlBody();
    expect(body, "找不到 bootstrapToml 函数体").not.toBe("");
    /* ⚠️ 这里用**键名计数**（实测计数为 3，不是 0 —— 见文件头⑤的前科）：
       applyKey 的调用点集合就是「boot 会改写的键」的唯一产地，
       一旦第四个键（尤其是 silam 相关）被加进来，计数会变 4 而这条断言仍绿
     ⇒ 所以同时钉死键名集合与总数。 */
    const keys = [...body.matchAll(/applyKey\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["llama_bin", "model_path", "models_dir"]);
    expect(keys.length, "applyKey 键数实测（若为 0 说明正则没匹配上，断言会假绿）").toBe(3);
  });

  it("C2 bootstrapToml 的写回路径里不得出现 siliam 段/enabled/as_brain", () => {
    const body = bootstrapTomlBody();
    /* ⚠️ 代码形状断言走剥注释后的 BOOT（文件头①）：注释里可以解释「本函数不碰 [silam]」，
       但代码里一次都不许出现。`[silam]` 里的方括号已转义，`as_brain` 用词边界防假命中。 */
    expect(body).not.toMatch(/\[silam\]/);
    expect(body).not.toMatch(/(?<![A-Za-z0-9_])as_brain(?![A-Za-z0-9_])/);
    // applyKey 的正则只认带引号的值（字符串键），silam 的开关是裸 true/false ⇒ 结构上本就改不到；
    // 这条断言把「它没有第三种改写机制」也钉住：全文只有 applyKey 一处改写入口。
    expect((body.match(/text\s*=\s*text\.replace\(/g) ?? []).length).toBe(1);
  });

  it("C3 首次安装（!existed）时以模板为基准写盘，模板的关闭状态因此直达用户数据根", () => {
    const body = bootstrapTomlBody();
    // base = existed ? target : src  —— 干净安装走 src（即随包那份 slime.toml）
    expect(body).toMatch(/const\s+base\s*=\s*existed\s*\?\s*target\s*:\s*src\s*;/);
    expect(body).toMatch(/const\s+existed\s*=\s*existsSync\(target\)\s*;/);
    // src 优先取 extraFiles 落地的那份（安装根），回落 asar
    expect(body).toMatch(/const\s+src\s*=\s*existsSync\(extraToml\)\s*\?\s*extraToml\s*:/);
    expect(body).toMatch(/join\(BUNDLE_ROOT,\s*"slime\.toml"\)/);
  });

  it("C4 已有旧配置时以磁盘为基准（用户的既有 [silam] 不被覆盖，属预期行为）", () => {
    const body = bootstrapTomlBody();
    /* ⚠️ 这条是**有意保留**的行为：existed === true 时 base = target，
     * boot 只改三个键、[silam] 保持磁盘原样 —— 升级不许覆盖用户既有配置。
     * 钉住它是为了防止有人日后「顺手在 boot 里也刷一遍 [silam]」，
     * 那会把老用户自己开过的配置强改掉。 */
    expect(body).toMatch(/const\s+base\s*=\s*existed\s*\?\s*target\s*:\s*src\s*;/);
    expect(body).toMatch(/if\s*\(text\s*!==\s*original\s*\|\|\s*!existed\)/);
  });
});

describe("A-1197 P1 D dataRoot / dataRootSet：单一产地 + 不许静默失效", () => {
  it("D1 runtimeStateDir 的 catch 必须出声（项目铁律：静默失效必须出声）", () => {
    const m = DATAROOT.match(/export function runtimeStateDir\(\)\s*:\s*string\s*\{[\s\S]*?\n\}/);
    expect(m, "找不到 runtimeStateDir 函数体").not.toBeNull();
    const body = m![0];
    // 只写注释不算出声：必须有 console.warn（与本文件其它 catch / boot.ts 同风格）
    expect(body).toMatch(/catch[\s\S]*?console\.warn/);
    expect(body).toMatch(/console\.warn\(`\[gui:dataRoot\]/);
    /* ⚠️ 词边界（前科见文件头③）：`console.warn` 是 `console.warnOnce` 之类
       的子串，但那不构成「没出声」⇒ 反过来判「不许只剩注释」时必须排除这种情况，
       所以这里钉的是**具体前缀 + 模板串**，不是裸 console。 */
    expect((body.match(/console\.warn\(/g) ?? []).length).toBe(1);
  });

  it("D2 runtimeStateDir 仍然返回那个目录（出声不等于改语义）", () => {
    const m = DATAROOT.match(/export function runtimeStateDir\(\)\s*:\s*string\s*\{[\s\S]*?\n\}/);
    const body = m![0];
    // 目录路径口径没变
    expect(body).toMatch(/const\s+dir\s*=\s*join\(RUNTIME_DATA_DIR,\s*"runtime"\)\s*;/);
    expect(body).toMatch(/return\s+dir\s*;/);
    // 且不得 throw（出声用 warn，不能把「建不出目录」升级成启动失败）
    expect(body).not.toMatch(/throw\s/);
  });

  it("D3 dataRootExists 的静默 false 是「查不到」，语义可接受，不许被误改成抛错", () => {
    const m = DATAROOT.match(/export function dataRootExists\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/catch\s*\{\s*return false;\s*\}/);
    expect(m![0]).not.toMatch(/console\.warn|throw\s/);
  });

  it("D4 dataRootSet 返回的 root 必须走 resolve（与 dataRootInfo 同一产地）", () => {
    const h = dataRootSetHandler();
    expect(h, "找不到 slime:dataRoot:set 的 handler 体").not.toBe("");
    /* ⚠️ 判据必须**同时**钉住「返回值里有 resolve」与「原始入参不再直接回传」：
       只判前者的话，把 return 写成 `{ ok: true, root: resolve(dir), migrated: dir }` 之类
       形状不对的写法也可能混过去；只判后者则会把别处的变量改名绕过去。 */
    expect(h).toMatch(/return\s*\{\s*ok:\s*true\s*,\s*migrated\s*,\s*root:\s*resolve\(dir\)\s*,\s*needRestart:\s*true\s*\}\s*;/);
    // 成功分支的回传不许再出现裸 dir
    expect(h).not.toMatch(/root:\s*dir\b/);
    // resolve 必须来自 node:path（不是自己写的字符串拼接）
    expect(MAIN_RAW).toMatch(/import\s*\{[^}]*\bresolve\b[^}]*\}\s*from\s*"node:path"/);
  });

  it("D5 dataRootInfo 仍以已 resolve 的 RUNTIME_DATA_DIR 为产地（没被顺手改坏）", () => {
    /* ⚠️ **不许用「函数头 + 惰性到第一个 `\n\}`」的取法**（实测踩到，两次）：
     · `function dataRootInfo()\s*:\s*\{[\s\S]*?\n\}` 会停在**返回类型那个花括号**
      （`function dataRootInfo(): {` 本身就以 `{\n  root: string; ...\n}` 结束）
       ⇒ 取到的是签名片段，函数体根本没进断言；
     · 改成「下一行不是 `}`」也一样停在同一处。
     ⇒ 正确取法是**锚在函数体的特征内容上**（从签名一路吃到 return 那句），
      这样即使前面有再多花括号，取到的也一定是真函数体。 */
    const m = MAIN.match(
      /function dataRootInfo\(\)\s*:[^{]*\{[\s\S]*?const\s+root\s*=\s*RUNTIME_DATA_DIR\s*;[\s\S]*?return\s*\{\s*root,[\s\S]*?dataRootExists\(root\)\s*\}\s*;/,
    );
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/const\s+root\s*=\s*RUNTIME_DATA_DIR\s*;/);
    expect(m![0]).toMatch(/return\s*\{\s*root,\s*custom:\s*isCustomDataRoot\(\)/);
    // RUNTIME_DATA_DIR 的定义本身必须来自已 resolve 的取值路径
    expect(DATAROOT).toMatch(/export const RUNTIME_DATA_DIR = pickWritableRoot\(\)\s*;/);
    expect(DATAROOT).toMatch(/function pickWritableRoot\(\)\s*:\s*string\s*\{[\s\S]*?return\s+defaultDataRoot\(\)\s*;/);
  });

  it("D6 模块级常量那条注释不得再带编辑残留（改oirs 之类）", () => {
    /* ⚠️ 这条断言看的是**注释**（须用原文 DATAROOT_RAW）：残留字符在注释里，
     * 剥掉注释后就查不到了。
     * ⚠️ 判据必须**定位到注释本体那几行**（实测 RUNTIME_DATA_DIR 那一行是纯代码，
     * 注释在它的上一行）—— 只判「整个文件里没有 3 字母以上英文单词」会被
     * import 语句、RUNTIME_DATA_DIR 标识符本身一并打挂（假红）。 */
    const rawLines = DATAROOT_RAW.split("\n");
    const i = rawLines.findIndex((l) => l.includes("RUNTIME_DATA_DIR = pickWritableRoot"));
    expect(i, "找不到 RUNTIME_DATA_DIR 的声明行").toBeGreaterThan(-1);
    // 注释在声明行或其上一行（docblock 形态）
    const ctx = rawLines.slice(Math.max(0, i - 2), i + 1).join("\n");
    expect(ctx).toMatch(/模块级常量/);
    expect(ctx).toMatch(/进程生命周期内不变/);
    /* 词边界（前科见文件头⑥）：判的是**注释行内**不许残留英文标识符碎片
     * （改oirs / cfg 之类），用整族正则覆盖，而不是只搜原文那一个词。
     * 逐行判（而不是整段判）：dataRoot.ts 的文件头注释里有 RUNTIME_DATA_DIR 等
     * 合法英文标识符，整段判会假红。 */
    const commentLines = rawLines
      .slice(Math.max(0, i - 2), i + 1)
      .filter((l) => l.includes("模块级常量"));
    expect(commentLines.length, "注释行定位失败（这条断言会假绿）").toBeGreaterThan(0);
    for (const l of commentLines) {
      const c = l.replace(/^\s*(\/\*+|\*\/|\*|\/\/)/, "").replace(/\*+\/\s*$/, "");
      expect(c, `注释里残留编辑字符：${l.trim()}`).not.toMatch(/[A-Za-z]{3,}/);
    }
  });
});

describe("A-1197 P2-3 E agentTools 归因文案：结论对，归因也要对", () => {
  it("E1 归因必须说清「钩子返回空」，不得再说「宿主还没接线」", () => {
    /* ⚠️ 前科（见 a1197-creator-promise.spec.ts 的 A 组）：这句文案被既有守卫逐字锚住，
     * 所以改它必须同步那份守卫的口径 —— 本条判「旧归因消失」，
     * 用带边界的短词而不是整句（整句换标点就绕过去了）。
     * 判的是**源码原文**（它是拼进导引的字符串字面量，剥注释不会伤到它，
     * 但为保守仍走 AGENTTOOLS_RAW）。 */
    expect(AGENTTOOLS_RAW).not.toMatch(/插件宿主还没接线/);
    expect(AGENTTOOLS_RAW).not.toMatch(/桌面端的插件宿主/);
    // 新归因要点：接了线但钩子返回空（两个要素都要在）
    expect(AGENTTOOLS_RAW).toMatch(/不接受外部插件贡献工具/);
    expect(AGENTTOOLS_RAW).toMatch(/宿主钩子返回空/);
    /* ⚠️ A-1198 补充（B4 落地后）：这句话必须**限定在 `provides` 这条路**上 ——
       否则会变成「插件整体加不了工具」的过期结论（`contributes.scripts` 是真路径）。
       限定词是与 `contributes.scripts` 那句配套的，两者缺一即误导。 */
    expect(AGENTTOOLS_RAW).toContain("`provides` 这条路，桌面端目前不接受外部插件贡献工具");
  });

  it("E2 四点语义一字不许丢（合法取值 / 不生效 / 不许吹 / 正确做法）", () => {
    /* ⚠️ A-1198 同步（2026-10-08）：合法值从三个扩到四个（B3 的 `mode`）；
       「插件目前只能贡献指令」在 B4 落地后不成立（脚本工具是真路径）——
       两处判据按新事实迁移，其余三条语义（不生效 / 不许吹 / 正确做法）原样保留。 */
    // ① 合法取值四个（含 mode）+ 保守写法：只贡献指令只写 instructions
    expect(AGENTTOOLS).toMatch(/合法值只有\s*`instructions`\s*\/\s*`tools`\s*\/\s*`prompt`\s*\/\s*`mode`\s*四个/);
    expect(AGENTTOOLS).toContain("**只贡献指令时只写 `instructions`**");
    // ② 明说不会生效 + 清单显示「尚未接线」+ 不多出工具
    expect(AGENTTOOLS).toMatch(/写 `tools` 或 `prompt` \*\*不会被拒绝，但也不会生效\*\*/);
    expect(AGENTTOOLS).toContain("装载后插件清单里那一项只会显示「尚未接线」，**不会真的多出任何工具**。");
    // ③ 禁止因写了字段就宣称多了工具能力
    expect(AGENTTOOLS).toContain("**不要因为清单里写了某个字段，就宣称自己多了工具能力**");
    expect(AGENTTOOLS).toContain("那是无法兑现的承诺");
    // ④ 给出正确做法（两条真路径；旧口径「只能贡献指令」不许回潮）
    expect(AGENTTOOLS).toContain("如实告诉用户两条路");
    expect(AGENTTOOLS).toContain("contributes.scripts");
    expect(AGENTTOOLS).toContain("设置 → Agent 管理");
    expect(AGENTTOOLS).toContain("不要假装已具备");
    expect(AGENTTOOLS).not.toContain("插件目前只能贡献指令");
  });

  it("E3 归因改写后仍不许反向吹「已经接线」，也不许把未接线说成临时维护", () => {
    /* ⚠️ 反向断言用**整族正则**（项目前科：短词「未接线」是「尚未接线」的子串，
     * 只判短词等于没判）。这里判的是「不得出现任何已接线式的吹牛」。 */
    expect(AGENTTOOLS).not.toMatch(/(已经|已|均已)接线|接线完成|接好了/);
    expect(AGENTTOOLS).not.toMatch(/将来要贡献工具再加/);
    expect(AGENTTOOLS).not.toMatch(/(将来|以后|后续)[^。\n]{0,24}(tools|工具)[^。\n]{0,16}(生效|可用|能用|注册|就有)/);
  });

  it("E4 文案本体确实落在 creatorGuide 里（不是改在别处/只改注释）", () => {
    const gi = AGENTTOOLS.indexOf("export function creatorGuide");
    const idx = AGENTTOOLS_RAW.indexOf("不接受外部插件贡献工具");
    expect(gi).toBeGreaterThan(-1);
    expect(idx, "源码里找不到归因新句").toBeGreaterThan(gi);
    // creatorGuide 在本文件里只有一处（双产地漂移的粗判据）
    expect((AGENTTOOLS_RAW.match(/export function creatorGuide/g) ?? []).length).toBe(1);
  });
});