#!/usr/bin/env node
/**
 * gui/scripts/mut-a1173-anim-duration-sync.mjs — A-1173 守卫的变异验证。
 *
 * 本轮两个用户现象的共同根因是「**透明度/收工判定**比**几何**先到」，共 4 个产地：
 *   · 左栏 `duration` 落回默认（280 < CSS 500）  ⇒ 文本在最后几帧闪出
 *   · 悬浮窗 `duration` 落回默认（280 < CSS 400） ⇒ 收工时有 36px 未收完就被切成内联
 *   · 左栏 onFrame 没按方向取反（渐出被跑成渐入）
 *   · 切换呈现模式那一帧宿主还没被压到 opacity 0
 * 外加两条**结构性**产物：类/盒模同源（`hostIsFloat`）、右栏退场期贴右缘（`margin-left:auto`）。
 *
 * | # | 变异 | 应被抓住 |
 * |---|---|---|
 * | M1 | `SIDEBAR_WIDTH_MS` 改回 280（不再等于 CSS 500） | ① 时长单源 |
 * | M2 | `FLOAT_TRANSITION(_FULL)` 改回手抄 `0.4s`（时长出现第二产地） | ① 同源拼接 |
 * | M3 | 左栏动画去掉 `duration`（落回默认） | ② |
 * | M4 | 悬浮窗动画去掉 `duration`（落回默认） | ② |
 * | M5 | 各栏 onFrame 不做方向取反（收起跑成渐入） | ③（+ a1189 ③） |
 * | M6 | 收起收工不把 opacity 钉成 0 | ③（+ a1189 ④） |
 * | M7 | `dismissFloat` 去掉「切换前压宿主 opacity」 | ④ |
 * | M8 | 宿主 `className` 改回业务状态 `mainIsFloatLayout` | ④ |
 * | M9 | `.right-sidebar` 去掉 `margin-left: auto` | ⑤ |
 *
 * ⚠️ 快照/还原一律走**字节** + manifest（sha256 校验）；`--restore` **必须无参可用**。
 * ⚠️ 判据 spec 清单从下面的 `SPECS` 读（`_run-mut-batch.sh` 不传参时自动取）。
 *
 * 用法：
 *   node gui/scripts/mut-a1173-anim-duration-sync.mjs --list
 *   node gui/scripts/mut-a1173-anim-duration-sync.mjs --apply 3
 *   node gui/scripts/mut-a1173-anim-duration-sync.mjs --restore
 *   全量：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1173-anim-duration-sync.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1173-anim-duration-sync.spec.ts",
  /* ⚠️ A-1174 的守卫落在自己那份 spec 里（左栏收起窗口 / 进入窗口化的可见性）——
     本脚本的 SPECS 必须**把它一起带上**，否则那几条变异会"假存活"而不报错
     （清单漏一份比没有守卫更危险）。 */
  "tests/core-ts/a1174-leftward-fade-and-enter.spec.ts",
  /* ⚠️ A-1176 的守卫在它自己那份 spec 里（浮层态右栏让位的过渡）——同样必须带上。 */
  "tests/core-ts/a1176-sidebar-sync.spec.ts",
  /* ⚠️ A-1177 的守卫在它自己那份 spec 里（拖左栏时右栏跟随）——同样必须带上。 */
  "tests/core-ts/a1177-drag-gap.spec.ts",
  /* ⚠️ A-1179 的守卫在它自己那份 spec 里（进入窗口化容器贴合内容）——同样必须带上。 */
  "tests/core-ts/a1179-float-enter-blank.spec.ts",
  /* ⚠️ A-1180 的守卫在 a1174 那份 spec 里（进入窗口化要藏 .main）——同样必须带上。 */
  /* ⚠️⚠️ A-1185 的守卫在 a1155 那份 spec 里（右栏收/展的淡入淡出衔接，M32~M35 全靠它）
     —— 漏了它那几条会"假存活"而不报错（清单漏一份比没有守卫更危险）。
     ⚠️⚠️ 别把**已删除的 spec**留在清单里：vitest 会因为找不到文件而报 "no tests" ⇒
       整批被判成"基线异常" ⇒ 后面所有变异都"假存活"却**不报错**（实测踩过：M29~M32 全这样）。
       删 spec 时必须同步删这里。 */
  "tests/core-ts/a1155-float-width-symmetry.spec.ts",
];
const F_APP = "gui/src/renderer/App.tsx";
const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_APP, F_CSS];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1173");

const MUTATIONS = [
  {
    name: "M1 `SIDEBAR_WIDTH_MS` 改回 280（不再等于 CSS 的 500 ⇒ 透明度提前收工、文本闪出）",
    file: F_APP,
    mutate: (t) => sub(t, "export const SIDEBAR_WIDTH_MS = 500;", "export const SIDEBAR_WIDTH_MS = 280;"),
  },
  {
    name: "M2 `FLOAT_TRANSITION` 改回手抄 `0.4s`（时长出现第二产地，单源破缺）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "const FLOAT_TRANSITION = `height ${FLOAT_TRANSITION_MS}ms ${FLOAT_EASE}, width ${FLOAT_TRANSITION_MS}ms ${FLOAT_EASE}`;",
      "const FLOAT_TRANSITION = \"height 0.4s cubic-bezier(0,0,0.2,1), width 0.4s cubic-bezier(0,0,0.2,1)\";",
    ),
  },
  {
    name: "M3 展开分支去掉 `duration`（落回 GEOM_FADE_MS=280 ⇒ 比 CSS 500 短 220ms）",
    file: F_APP,
    /* ⚠️ A-1174 重锚：opts 现在按 `nextOpen` **分成两支**（展开 / 收起各一组），
       锚点必须带上分支前缀 `? `，否则 `sub()` 找不到 ⇒ `--apply` 失败。 */
    mutate: (t) => sub(
      t,
      "? { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_LO, hiRatio: LEFT_FADE_HI, duration: SIDEBAR_WIDTH_MS }",
      "? { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_LO, hiRatio: LEFT_FADE_HI }",
    ),
  },
  {
    name: "M4 悬浮窗动画去掉 `duration`（落回 280 ⇒ 收工还差 36px 就被切成内联）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "{ min: minW, full: floatSizeRef.current.w, duration: FLOAT_TRANSITION_MS },",
      "{ min: minW, full: floatSizeRef.current.w },",
    ),
  },
  {
    /* ⚠️⚠️ A-1189：**本条的锚点现在是"两栏共用的一份语言"** ——
       A-1189 让右栏也按左栏那条写法做方向取反（`String(nextOpen ? p : 1 - p)`），
       于是同一行文本在 `App.tsx` 里有 **3 处**（左栏展开支 + 右栏展开支 + 右栏收起支）。
       ⇒ 按 `_mut-eol.mjs` 的约定显式声明 `all: true` + `subAll`
         （单条 `sub` 只改第一处，核验器判「不唯一（无法确定改的是哪一处）」⇒ 长期报警没人看）。
       ⚠️ 这不是"弱化变异体"：A-1189 之后"按方向取反"**本来就是两栏共有的不变量**，
          删就该整组删。分栏覆盖由两份 spec 各自保证（本脚本的 ③ 锁左栏、`a1189` 的 ③ 锁右栏）。 */
    name: "M5 各栏 onFrame 不做方向取反（收起被跑成渐入 ⇒ 文本先消失再闪出）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(t, "node.style.opacity = String(nextOpen ? p : 1 - p);", "node.style.opacity = String(p);"),
  },
  {
    /* ⚠️⚠️ A-1189：同 M5 —— `done` 按方向复位这句也在两栏、共 3 处 ⇒ 整组替换。 */
    name: "M6 各栏收起收工不把 opacity 钉成 0（最后几 px 宽度里文本仍会露出）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(
      t,
      'if (nextOpen) { node.style.removeProperty("opacity"); } else { node.style.opacity = "0"; }',
      'node.style.removeProperty("opacity");',
    ),
  },
  {
    name: "M7 `dismissFloat` 去掉「切换呈现模式前压宿主 opacity」（切换帧露出 661px 跳变）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'const hostExit = chatHostRef.current;\n      if (hostExit) { hostExit.style.opacity = "0"; }\n      floatClosingRef.current = false;',
      "floatClosingRef.current = false;",
    ),
  },
  {
    name: "M8 宿主 `className` 改回业务状态（与同元素的 style 判据不同源）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'className={hostIsFloat ? "float-window" : "inline-chat-host"}',
      'className={mainIsFloatLayout ? "float-window" : "inline-chat-host"}',
    ),
  },
  {
    name: "M9 `.right-sidebar` 去掉 `margin-left: auto`（退场期右侧露出 135px 空白）",
    file: F_CSS,
    mutate: (t) => sub(t, "  min-width: 260px;\n  margin-left: auto;", "  min-width: 260px;"),
  },

  /* ── A-1174：左栏收起窗口 + 进入窗口化的可见性 ─────────────────── */
  {
    name: "M10 收起方向不再分流（沿用展开那组窗口 ⇒ 渐出被推到「实际宽度只剩几十 px」⇒ 看不见）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      ": { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_COLLAPSE_LO, hiRatio: LEFT_FADE_COLLAPSE_HI, duration: SIDEBAR_WIDTH_MS },",
      ": { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_LO, hiRatio: LEFT_FADE_HI, duration: SIDEBAR_WIDTH_MS },",
    ),
  },
  {
    name: "M11 `LEFT_FADE_COLLAPSE_HI` 改回 0.95（不再「更早」⇒ 渐出又落到接近收尾）",
    file: F_APP,
    mutate: (t) => sub(t, "const LEFT_FADE_COLLAPSE_HI = 0.27;", "const LEFT_FADE_COLLAPSE_HI = 0.95;"),
  },
  {
    name: "M12 `handleToggleFloat` 不再把宿主藏起来（切换帧露出 +286px 的几何跳变）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'if (hostEnter) { hostEnter.style.visibility = "hidden"; }',
      "if (hostEnter) { /* 变异：不藏 */ }",
    ),
  },
  {
    name: "M13 给 `floatBoxStyle` 加 opacity（浮窗半透明 ⇒ 右栏内容透上来叠印，A-1159 的失败）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "  const floatBoxStyle: React.CSSProperties = {\n    position: \"fixed\",",
      "  const floatBoxStyle: React.CSSProperties = {\n    opacity: 0.5,\n    position: \"fixed\",",
    ),
  },

  /* ── A-1175：过渡期变量的摘除点 ─────────────────────────────────── */
  {
    name: "M14 把 `--right-target-w` 的摘除加回 done（同步摘 ⇒ IACVT 帧 ⇒ 一帧 661px 抖动）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "          if (done) {\n            setRightMin0(false);\n            setRightWebviewPin(null);",
      "          if (done) {\n            setRightMin0(false);\n            setRightWebviewPin(null);\n            rightWrapperRef.current?.style.removeProperty(\"--right-target-w\");",
    ),
  },
  {
    name: "M15 提交后的 effect 少摘一个变量（`--right-body-pin` 残留）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    rw.style.removeProperty(\"--right-body-pin\");\n  }, [rightMin0]);",
      "  }, [rightMin0]);",
    ),
  },

  /* ── A-1176：浮层态右栏让位的过渡 ─────────────────────────────── */
  {
    name: "M16 删掉浮层稳态 `rw` 的宽度过渡（右栏又变成「秒让、没动画」）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "body.float-layout .right-wrapper:not(.right-wrapper-anim):not(.right-wrapper-exit) {\n  transition: width 0.5s cubic-bezier(0, 0, 0.2, 1);\n}",
      "",
    ),
  },
  {
    name: "M17 该过渡的时长改成 0.3s（与 `.sidebar` 的 0.5s 不一致 ⇒ 仍是一快一慢）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "body.float-layout .right-wrapper:not(.right-wrapper-anim):not(.right-wrapper-exit) {\n  transition: width 0.5s cubic-bezier(0, 0, 0.2, 1);",
      "body.float-layout .right-wrapper:not(.right-wrapper-anim):not(.right-wrapper-exit) {\n  transition: width 0.3s cubic-bezier(0, 0, 0.2, 1);",
    ),
  },

  /* ── A-1177：拖拽时右栏跟随 ─────────────────────────────────────── */
  {
    name: "M18 `onMove` 不再逐帧同步 `--left-w`（拖拽期间右栏不动 ⇒ 空白带）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      if (floatStateRef.current !== \"none\") {\n        rightWrapperRef.current?.style.setProperty(\"--left-w\", `${lastW}px`);\n      }",
      "",
    ),
  },
  {
    name: "M19 `onUp` 把内联宽清空而不是钉成 `w`（左栏回落 CSS 宽度 ⇒ 与 --left-w 错位）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "if (asideEl) { asideEl.style.width = `${w}px`; }",
      'if (asideEl) { asideEl.style.width = ""; }',
    ),
  },
  {
    name: "M20 RO 的 `sync` 不在拖拽期让位（会覆盖 `onMove` 的真值 ⇒ 一帧错位）",
    file: F_APP,
    mutate: (t) => sub(t, "if (leftDraggingRef.current) { return; }", "/* 变异：拖拽期不让位 */"),
  },
  {
    name: "M21 拖拽期禁过渡那条**丢掉 `:not()`**（特异度不够 ⇒ 被 A-1176 那条盖掉）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "body.slime-dragging .right-wrapper:not(.right-wrapper-anim):not(.right-wrapper-exit) {",
      "body.slime-dragging .right-wrapper-DISABLED {",
    ),
  },
  {
    name: "M22 `leftDraggingRef` 的 `onCancel` 摘漏（拖动中状态永久挂着 ⇒ RO 一直让位）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    const onCancel = (): void => {\n      leftDraggingRef.current = false;",
      "    const onCancel = (): void => {",
    ),
  },

  /* ⚠️ A-1178（"进入窗口化时藏右栏"）已**作废并回退** ——
     那条修复把容器藏起来，而内容还在 0.5s 过渡途中 ⇒ 恢复可见时中间露出 400px 空白
     ⇒ 用户实测「右侧边栏直接屏闪了，每次窗口化会有一帧黑屏」。
     ⇒ 真正的根因与正解见 A-1179（容器贴合内容），变异 M25~M28。
     ⚠️ 这里**不留** M23/M24：它们针对的代码已不存在，留着会变成「锚点失效」的假条目。 */

  /* ── A-1179：进入窗口化容器贴合内容（消除一帧黑屏） ────────────── */
  {
    name: "M25 过渡期又给容器具体宽度（容器硬跳 ⇒ 空白 380px ⇒ 一帧黑屏复现）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      ': (mainIsFloatLayout ? (rightExitAnim ? "var(--right-target-w)" : undefined) : "auto") }}',
      ': (mainIsFloatLayout ? "var(--right-target-w)" : "auto") }}',
    ),
  },
  {
    name: "M26 把退场期例外删掉（`rightExitAnim` 判断消失 ⇒ A-1157-R2 被破坏、退出方向坏）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      ': (mainIsFloatLayout ? (rightExitAnim ? "var(--right-target-w)" : undefined) : "auto") }}',
      ": (mainIsFloatLayout ? undefined : \"auto\") }}",
    ),
  },
  {
    name: "M27 过渡期不再写 `--right-target-w`（内容宽度失去来源 ⇒ 回到 A-1155 死锁）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`);',
      "/* 变异：不写目标宽 */",
    ),
  },
  {
    name: "M28 又用回那套实测无效的方案（`offsetWidth` 强制同步布局）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`);',
      'void el.offsetWidth;\n        el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`);',
    ),
  },

  /* ── A-1180：进入窗口化要藏 .main（它有不透明背景，塌陷那帧可见） ── */
  {
    name: "M29 不藏 `.main`（它塌陷 721px 那一帧可见 ⇒ 窗口化一瞬又抽搐）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'const mainEnter = document.querySelector<HTMLElement>(".main");\n    if (mainEnter) { mainEnter.style.visibility = "hidden"; }',
      "/* 变异：不藏 .main */",
    ),
  },
  {
    name: "M30 `.main` 的 visibility 不恢复（主区持久隐形 ⇒ 对话页整个消失）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'const m = document.querySelector<HTMLElement>(".main");\n      if (m && m.style.visibility === "hidden") { m.style.visibility = ""; }',
      "/* 变异：不恢复 .main */",
    ),
  },
  /* ── A-1185：右栏收/展的淡入淡出衔接 ─────────────────────────── */
  /* ── A-1185：cancel 路径必须补跑收尾帧（否则"动画直接没了"） ── */
  {
    name: "M31 `.main` 改成用 `display:none` 藏（会把 .main 子树一起干掉）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'if (mainEnter) { mainEnter.style.visibility = "hidden"; }',
      'if (mainEnter) { mainEnter.style.display = "none"; }',
    ),
  },

  /* ── A-1181：淡出触发源 = 聊天区盒子宽度变化 ──────────────────── */
  /* ── A-1182：右栏收/展的擦除衔接 ─────────────────────────────── */
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  if (r.status !== 0) { return { ok: false, spawnBlocked: false }; }
  return { ok: true, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    /* 锚点漂移时必须清掉备份目录（否则留下没有 manifest 的 `.orig` ⇒ 下次 apply 不拦 ⇒ 原件被覆盖）。 */
    let next;
    try { next = m.mutate(text); }
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── full 模式 ── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t))]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = () => { for (const [t, buf] of originals) { writeFileSync(abs(t), buf); } };
process.on("SIGINT", () => { restoreAll(); process.exit(1); });
process.on("SIGTERM", () => { restoreAll(); process.exit(1); });

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 请用 --apply/--restore + shell 循环。");
  process.exit(1);
}
if (!base.ok) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

let caught = 0; const missed = [];
try {
  for (const m of MUTATIONS) {
    const src = originals.get(m.file).toString("utf8");
    let next;
    try { next = m.mutate(src); }
    catch (e) { console.error(`⚠️  ${m.name}\n    锚点未命中：${e.message}`); missed.push(m.name); continue; }
    writeFileSync(abs(m.file), next);
    const res = runSpecs();
    writeFileSync(abs(m.file), originals.get(m.file));
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
