#!/usr/bin/env node
/**
 * gui/scripts/mut-a1115.mjs — A-1115（目录卷轴 + 外观专栏）的变异验证。
 *
 * 每条变异都在问同一个问题：**把这条判据改坏，守卫会不会红？**
 * 覆盖的都是**本轮真踩过**的静默失效（括号里是当时的用户症状）：
 *
 *   1  清屏用回卷轴宽 W（"糊成一坨"）
 *   2  描边不再读 shapeAt（"虚化出另外两条浅色的线"）
 *   3  contain:paint 挪到卷轴容器上（气泡一个像素不画）
 *   4  原生滚动条不再隐藏（卷轴与系统条两条并存）
 *   5  衬托过渡带改窄（衔接处出"锐角"）
 *   6  描边调胖（两线糊成一条，"明暗区分越来越小"）
 *   7  刻度位置改成非等距（"分布不均匀"）
 *   8  normalize 不再钳位（越界值直接进渲染）
 *   9  端部残留给 0（端点成精确直线）
 *  10  常态振幅压低（两线糊成一条）
 *  11  md 也做凹陷（用户明确要求 md 不做）
 *  12  对话页参数改用"另一条产地"（设置里调了、界面没变）
 *  13  右栏 md 误用 wave 模式（刻度尺变水波）
 *  14  「通用」页复活主题卡片（主题两个入口）
 *  15  设置里去掉「外观」渲染分支（栏目点了没反应）
 *  16  演示框外层加 overflow:hidden（切掉悬浮气泡）
 *  17  末组不画阶段容器（所有动作平铺成一列 ⇒ 用户的时间线设计失效）
 *  18  resizer 又加回覆盖层（可见效果两个产地 ⇒ 「覆盖在边界线上、臃肿」）
 *  19  分隔线宽度退回 1px（= 没变粗 ⇒ 「拖拽光标太窄了，怎么这么细」）
 *  20  md 找当前条目改用 `u`（刻度是等距铺的，`u` 与内容无关 ⇒ 永远是中间那条亮）
 *  21  滚动驱动与鼠标态**相加**而不是取 max（两者重合时翻倍 ⇒ 看着像跳了一下）
 *  22  滚动隆起的衰减退回绝对像素 `sig`（长文档一次亮 3~5 条 ⇒「看不出是哪条」）
 *  23  滚动位置不阻尼（目标在两刻度间整格跳 ⇒ 隆起硬跳而不是滑过去）
 *  24  阻尼未停稳就判静止（隆起滑到一半就停帧、卡在半路）
 *  25  预览页的 SIG 与真身不一致（手抄第二产地漂移 ⇒ 预览口径假）
 *  26  真身默认参数改了、预览页没跟着改（双向对齐：改真身不改预览也要红）
 *  27  预览页 spanTaper 又发明真身没有的钳位 `* 0.4`（真实漂移过；H≥300 时看不出来）
 *  28  预览页刻度铺排分母写成 n（末条够不到底 ⇒「分布不均匀」回归）
 *  29  删掉 `frame()` 的 alive 挡板（已排队的帧续命 ⇒ 僵尸循环画回旧 mode = 用户看到的「md 页显示波形」）
 *  30  **把挡板挪到 `requestAnimationFrame(frame)` 之后**（照样"含有 alive"，但等于没挡 —— 位置才是判据）
 *  31  删掉 cleanup 的 `alive = false`（令牌从不置位 ⇒ 挡板恒真）
 *  32  删掉 `ensureLoop()` 的 `!alive`（悬停 / 滚动又会把废弃实例叫醒）
 *  33  删掉 `layout()` 的 `!alive`（cleanup 后 ResizeObserver 仍能画一整帧盖掉新实例）
 *  34  外观面板根 `paddingTop` 归零（首版只让左右 ⇒ 页签顶到内容区上沿）
 *  35  右栏滚动容器 `paddingRight` 退回 4（卡片边框压在滚动条上）
 *  36  给 canvas 加 `key={mode}` **冒充修复**（换个 DOM 节点掩盖泄漏：旧闭包仍在废弃节点上烧 60fps）
 *
 * ── A-1119：设置面板留白地板（用户**两次**实例取证：「与边界相交、拥挤」+「顶着标签页」）
 *  37  内容区（共用祖先）的 `paddingLeft` 归零（水平地板整个没了）
 *  38  「通用」页根容器又自己给水平留白（第二产地 ⇒ 与内容区叠加成 32px）
 *  39  外观面板根又加回 `paddingLeft`（A-1118 首版那份没删干净）
 *  40  「后台任务」页根容器恢复 4px 水平留白（"贴线那一族"回归）
 *  41  删掉根容器的 `settings-pane` 类名（**守卫的锚点消失** ⇒ 守卫必须出声，否则它在空转）
 *  42  外观面板根删掉 `paddingBottom`（只给上不给下 ⇒ 底部卡片贴边）
 *  ⚠️ 34 与 41 是"同一处结构、两种破坏方式"：34 破坏**值**、41 破坏**锚点**。
 *     两者都必须被捕获 —— 只锁值不锁锚点的话，有人改个类名就能让守卫静默失效（本仓老毛病）。
 *
 * ── A-1115 预览页 drift 守卫（`tests/gui/a1115-preview-drift.spec.ts`，本轮补上的欠账）
 *    预览页 `docs/A-1115-topic-rail-preview.html` 是**手抄的第二产地** ⇒ 抄错不报错、
 *    只是**用错误的口径说服用户、说服自己**（A-1117 那份早有守卫，这份一直欠着）。
 *    下面这 21 条各锁**一类**常量，覆盖"值漂了"与"结构漂了"两种：
 *  43  预览页 RIGHT_ROOM 写回 5（**本轮真实抓到的漂移**：真身是 6 ⇒ 凹陷夹紧上界差 1px）
 *  44  预览页 LEFT_ROOM 与真身不一致（画布左余量漂了）
 *  45  预览页**滑杆** `sSig` 的 value 与真身默认值不一致（滑杆是**生效值** —— `bind()→sync()` 会覆盖 P）
 *  46  预览页 P 字面量 amp 与真身不一致（初值也不许漂）
 *  47  预览页勾选框 `cFlip` 初始态与真身不一致
 *  48  真身 `DEFAULT_WAVE_PARAMS.tap` 改了、预览页没跟（**双向**：改真身不同步预览也要红）
 *  49  预览页 `.rail { right }` 与真身 `RAIL_INSET` 不一致（卷轴离宿主右缘的距离）
 *  50  预览页 spanTaper 又发明真身没有的 `* 0.4` 钳位（真实漂移过；H≥300 时看不出来）
 *  51  预览页双极位移去掉 `Bp·e^(−T/2)` 中间项（把凹陷吃掉一大半）
 *  52  预览页波形带占比 0.88 → 0.70（波形与刻度位的分界漂了）
 *  53  预览页已读/未读过渡带 0.07H → 0.20H
 *  54  预览页刻度突起影响范围 tA/tB 与真身不一致（"隔着老远就变长"回归）
 *  55  预览页刻度端部 floor 0.35 → 0.12（首尾两条被抹掉 = 读成「少了两条」）
 *  56  预览页刻度层级长度 h1 的 0.90 改掉
 *  57  预览页刻度铺排分母写成 n（末条够不到底 ⇒「分布不均匀」回归）
 *  58  预览页指针跟手强度 0.18 改掉（阻尼手感漂了）
 *  59  预览页亮线颜色改掉（"整条发虚"的病根之一）
 *  60  预览页左侧夹紧 1.4px 改掉
 *  61  预览页刻度跨度起点 `H/6` 改掉
 *  62  预览页双极位移的 T=2.7 改掉
 *  63  删掉预览页的一个 `bind(...)`（**检测器自检**：`it.each` 会静默退化成 0 条用例）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）—— 本文件的 ASCII 引号只用于**代码字面量**。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险（`_mut-eol.mjs`）。
 * ⚠️ **判据 = exit≠0 且输出里真有 `Tests` 汇总行**（只有 exit≠0 时，"vitest 启动失败"会被误当成"被捕获"）。
 *
 * 本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 全量模式跑不了，用 shell 循环：
 *
 *   for i in $(seq 1 63); do
 *     node gui/scripts/mut-a1115.mjs --apply $i || exit 1
 *     node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *       $(node gui/scripts/mut-a1115.mjs --specs $i) --reporter=dot > /tmp/m$i.txt 2>&1
 *     echo "M$i exit=$?"; grep -aE 'Tests +[0-9]' /tmp/m$i.txt
 *     node gui/scripts/mut-a1115.mjs --restore
 *   done
 *
 * ⚠️ `--specs $i` 别省（也别手写 spec 名）：每条变异要跑的守卫文件由脚本自己声明，
 * 手写就会像本轮那样漏掉跨文件的守卫 ⇒ **假存活**。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1115-topic-rail.spec.ts";
/* ⚠️⚠️ **变异脚本必须跑「守卫真正所在」的那个 spec**。
   本轮真实教训：M17（末组不画阶段容器）的守卫住在 `a1095-timeline-groups.spec.ts`、
   M18（resizer 又加回覆盖层）的守卫住在 `a1106-ui-guards.spec.ts`，而默认只跑 a1115 spec
   ⇒ 这两条**假存活**（21 条里报 2 条存活 —— 差点当成"守卫失效"去改守卫）。
   判据：一条变异只要**有任何一条守卫**变红即算捕获；所以要用 `specs` 显式列出它可能触发的守卫文件。 */
const SPEC_TIMELINE = "tests/gui/a1095-timeline-groups.spec.ts";
const SPEC_RESIZER = "tests/gui/a1106-ui-guards.spec.ts";
/* 预览页与真身的**常量对齐**守卫（25~28 用）。预览页是手抄的第二产地 ⇒ 抄错不会报错、
   只会"用错误的口径说服用户"，所以它对真身参数改动**必须有反应**。 */
const SPEC_DRIFT = "tests/gui/a1117-preview-drift.spec.ts";
/* A-1115 预览页的对齐守卫（43~63 用）—— 它是本轮补上的欠账，规格同 A-1117 那份。 */
const SPEC_DRIFT_A1115 = "tests/gui/a1115-preview-drift.spec.ts";

const F_RAIL = "gui/src/renderer/pages/TopicRail.tsx";
const F_PARAMS = "gui/src/renderer/pages/railParams.ts";
const F_CSS = "gui/src/renderer/index.css";
const F_CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const F_GENERAL = "gui/src/renderer/pages/GeneralPanel.tsx";
const F_SETTINGS = "gui/src/renderer/pages/SettingsDialog.tsx";
const F_PANEL = "gui/src/renderer/pages/AppearancePanel.tsx";
const F_PREVIEW = "docs/A-1117-md-scroll-bulge.html";
const F_PREVIEW_A1115 = "docs/A-1115-topic-rail-preview.html";
const F_RESIDENT = "gui/src/renderer/pages/ResidentPanel.tsx";
const TARGETS = [F_RAIL, F_PARAMS, F_CSS, F_CHAT, F_SIDEBAR, F_GENERAL, F_SETTINGS, F_PANEL, F_PREVIEW, F_PREVIEW_A1115, F_RESIDENT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1115");

const MUTATIONS = [
  {
    name: "1 清屏用回卷轴宽 W（加宽那截永远清不掉 ⇒ 糊成一坨）",
    file: F_RAIL,
    mutate: (t) => sub(t, "clearRect(0, 0, R.CW, H)", "clearRect(0, 0, W, H)"),
  },
  {
    name: "2 描边不再读 shapeAt（四条描边形状不一致 ⇒ 像多画了一对线）",
    file: F_RAIL,
    mutate: (t) => sub(t, "const sh = shapeAt(u);",
      "const sh = { cx: band().cx, push: 0, sep: band().baseAmp };"),
  },
  {
    name: "3 contain:paint 挪到卷轴容器上（等价 overflow:clip ⇒ 气泡一个像素不画）",
    file: F_CSS,
    mutate: (t) => sub(t, ".topic-rail {\n  position: absolute;", ".topic-rail {\n  contain: paint;\n  position: absolute;"),
  },
  {
    name: "4 原生滚动条不再隐藏（卷轴与系统条两条并存）",
    file: F_CSS,
    mutate: (t) => sub(t, ".rail-host::-webkit-scrollbar { width: 0; height: 0; }",
      ".rail-host::-webkit-scrollbar { width: 6px; height: 6px; }"),
  },
  {
    name: "5 衬托过渡带改窄（凹陷尾巴与刚恢复的振荡叠在一起 ⇒ 衔接处「锐角」）",
    file: F_RAIL,
    mutate: (t) => sub(t, "const a = p.a, b = a + Math.max(1.4, a * 0.7);",
      "const a = p.a, b = a + Math.max(0.1, a * 0.05);"),
  },
  {
    name: "6 描边调胖（两线糊成一条 ⇒ 用户报「明暗区分越来越小」）",
    file: F_RAIL,
    mutate: (t) => sub(t, "const wMain = i ? W * 0.095 : W * 0.13;",
      "const wMain = i ? W * 0.30 : W * 0.36;"),
  },
  {
    name: "7 刻度位置改成非等距（用户报「分布不均匀」）",
    file: F_PARAMS,
    mutate: (t) => sub(t, "for (let i = 0; i < n; i++) { out.push(top + ((bot - top) * i) / (n - 1)); }",
      "for (let i = 0; i < n; i++) { out.push(top + ((bot - top) * i * i) / ((n - 1) * (n - 1))); }"),
  },
  {
    name: "8 normalize 不再钳位（越界值直接进渲染）",
    file: F_PARAMS,
    mutate: (t) => sub(t, "(out as unknown as Record<string, unknown>)[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;",
      "(out as unknown as Record<string, unknown>)[key] = v;"),
  },
  {
    name: "9 端部残留给 0（端点变成一段精确直线 ⇒ 反而「看得见」）",
    file: F_PARAMS,
    mutate: (t) => sub(t, "tap: 90, efloor: 0.12,", "tap: 90, efloor: 0,"),
  },
  {
    name: "10 常态振幅压低（两线全程糊成一条）",
    file: F_PARAMS,
    mutate: (t) => sub(t, "lam0: 46, lam1: 53, amp: 55,", "lam0: 46, lam1: 53, amp: 30,"),
  },
  {
    name: "11 md 也做凹陷（用户明确要求 md 不做）",
    file: F_PARAMS,
    mutate: (t) => sub(t, "  ...DEFAULT_WAVE_PARAMS,\n  dip: 0,", "  ...DEFAULT_WAVE_PARAMS,\n  dip: 110,"),
  },
  {
    name: "12 对话页参数改用另一条产地（设置里调了、界面没变）",
    file: F_CHAT,
    mutate: (t) => sub(t, 'loadRailParams("wave")', 'defaultRailParams("wave")'),
  },
  {
    name: "13 右栏 md 误用 wave 模式（刻度尺变水波）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, '<TopicRail mode="ticks"', '<TopicRail mode="wave"'),
  },
  {
    name: "14 「通用」页复活主题卡片（主题两个入口 = 两个真相源）",
    file: F_GENERAL,
    mutate: (t) => sub(t, "（主题与界面外观设定已迁到「外观」栏。）", "（界面主题在本页设置。）"),
  },
  {
    name: "15 设置里去掉「外观」渲染分支（栏目点了没反应）",
    file: F_SETTINGS,
    mutate: (t) => sub(t, '{activeTab === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}', ""),
  },
  {
    name: "16 演示框外层加 overflow:hidden（切掉悬浮气泡）",
    file: F_CSS,
    mutate: (t) => sub(t, ".appearance-demo {\n  position: relative;", ".appearance-demo {\n  overflow: hidden;\n  position: relative;"),
  },
  {
    name: "17 末组不画阶段容器（所有动作平铺成一列 ⇒ 用户的时间线设计失效）",
    file: F_CHAT,
    /* 守卫住在 a1095（时间线分组）—— 见文件头 SPEC_TIMELINE 那段记的教训 */
    specs: [SPEC_TIMELINE],
    mutate: (t) => sub(t, "if (!hasShell) { return body; }",
      "if (!hasShell || group.isLast) { return body; }"),
  },
  {
    name: "18 resizer 又加回覆盖层（可见效果变成两个产地 ⇒ 用户说的「覆盖在边界线上、臃肿」）",
    file: F_CSS,
    /* 两处守卫都该响：a1115 ② 查 `.sidebar-resizer` 块里不许出现 background-image，
       a1106 ⑦ 查整体「可见效果唯一产地」。
       ⚠️ 锚点必须**钉住左栏那一段**：早先的锚点（`background: none;` + `opacity` + `transition` + `}`）
       其实命中的是 `.right-sidebar-resizer`（左栏那段 `background: none;` 后面还跟着一行注释，序列不成立）
       ⇒ **变异的不是想变的地方**，于是 a1115 的 ② 看不见它、报"假存活"。 */
    specs: [SPEC, SPEC_RESIZER],
    mutate: (t) => sub(t, "  transition: opacity 0.15s ease;\n  /* ⚠️ 这里**不**声明",
      "  transition: opacity 0.15s ease;\n"
      + "  background-image: linear-gradient(to bottom, transparent, var(--accent), transparent);\n"
      + "  /* ⚠️ 这里**不**声明"),
  },
  {
    name: "19 分隔线宽度退回 1px（等于没变粗 ⇒ 「拖拽光标太窄了，怎么这么细」）",
    file: F_CSS,
    mutate: (t) => sub(t, "border-image: var(--rz-ramp) 0 3 0 0 / 0 3px 0 0 stretch;",
      "border-image: var(--rz-ramp) 0 1 0 0 / 0 1px 0 0 stretch;"),
  },
  {
    name: "20 md 找当前条目改用 u（刻度等距铺 ⇒ 与内容无关 ⇒ 永远中间那条亮）",
    file: F_RAIL,
    mutate: (t) => sub(t, "const dd = Math.abs(R.ticks[k].s - s2);",
      "const dd = Math.abs(R.ticks[k].u - s2);"),
  },
  {
    name: "21 滚动驱动与鼠标态相加而不是取 max（鼠标停在本条目上时翻倍 ⇒ 跳一下）",
    file: F_RAIL,
    mutate: (t) => sub(t, "Math.max(bump(Math.abs(tk.u - R.ptr.uc)) * R.ptr.strength, profCur)",
      "bump(Math.abs(tk.u - R.ptr.uc)) * R.ptr.strength + profCur"),
  },
  {
    name: "22 滚动隆起的衰减退回**绝对像素** sig（长文档一次亮 3~5 条 ⇒「看不出是哪条」）",
    file: F_RAIL,
    // 实测：H=600 时 n=20 的相邻刻度权重 0.99、n=30 时 1.00 —— 与"当前那条"一样亮
    mutate: (t) => sub(t, "0.62 * profBump(Math.abs(tk.u - R.curU) / spacing)",
      "0.62 * bump(Math.abs(tk.u - R.curU))"),
  },
  {
    name: "23 滚动位置不阻尼（目标在两刻度间整格跳 ⇒ 隆起硬跳，而不是滑过去）",
    file: F_RAIL,
    mutate: (t) => sub(t, "R.curU += (R.curUt - R.curU) * kk;",
      "R.curU = R.curUt;"),
  },
  {
    name: "24 阻尼未停稳就判静止（隆起滑到一半就停帧、卡在半路）",
    file: F_RAIL,
    mutate: (t) => sub(t, "const scrollSettled = !withTicks || R.ticks.length === 0 || R.curU === R.curUt;",
      "const scrollSettled = true;"),
  },
  {
    name: "25 预览页 SIG 与真身不一致（手抄第二产地漂移 ⇒ 预览的口径是假的）",
    file: F_PREVIEW,
    specs: [SPEC_DRIFT],
    mutate: (t) => sub(t, "var SIG = 13;", "var SIG = 26;"),
  },
  {
    name: "26 真身 md 默认参数改了、预览页没跟（双向：改真身不同步预览也必须红）",
    file: F_PARAMS,
    specs: [SPEC_DRIFT],
    /* ⚠️ 锚点必须连上 `...DEFAULT_WAVE_PARAMS,` —— 只写 `grow: 55,` 会命中**别处**：
       本仓采过这个坑（等价变异体 ⇒ 假存活）：DEFAULT_WAVE_PARAMS 里也有 `grow: 55`，
       而 DEFAULT_TICKS_PARAMS 用 spread 覆盖它 ⇒ 改 wave 那份对 md 预览**毫无影响**，
       守卫当然不会红 —— 那不是守卫失效，是变异打在等价位置。 */
    mutate: (t) => sub(t,
      "  ...DEFAULT_WAVE_PARAMS,\n  dip: 0,          // md **不做凹陷**（用户明确要求）\n  grow: 55,",
      "  ...DEFAULT_WAVE_PARAMS,\n  dip: 0,          // md **不做凹陷**（用户明确要求）\n  grow: 65,"),
  },
  {
    name: "27 预览页 spanTaper 又发明真身没有的钳位 `* 0.4`（真实漂移过，H≥300 时看不出来）",
    file: F_PREVIEW,
    specs: [SPEC_DRIFT],
    mutate: (t) => sub(t, "      var s = tapNow > 0 ? Math.min(1, Math.max(0, e / tapNow)) : 1;",
      "      var tap = Math.max(0, Math.min(TAP, (bot - top) * 0.4 * 1.5));\n"
      + "      var s = tap > 0 ? Math.min(1, Math.max(0, e / tap)) : 1;"),
  },
  {
    name: "28 预览页刻度铺排分母写成 n（末条够不到底 ⇒「分布不均匀」回归）",
    file: F_PREVIEW,
    specs: [SPEC_DRIFT],
    mutate: (t) => sub(t, "cfg.top + ((cfg.bot - cfg.top) * k) / (cfg.n - 1));",
      "cfg.top + ((cfg.bot - cfg.top) * k) / Math.max(1, cfg.n));"),
  },

  /* ── A-1118：rAF 循环泄漏 + 外观面板留白 ─────────────────────────────────
     ⚠️ 29~33 这**五条都是"同一个修复的不同漏法"**，不是重复：
     令牌机制要成立必须同时满足「挡板在正确位置」+「三个入口都挡」+「cleanup 里真的置位」，
     漏掉任意一个都能让循环复活，而**删掉整套机制**（29）与**挪走挡板**（30）是两种完全不同的错，
     后者尤其危险 —— 它照样含 `alive` 字样，靠 `toContain` 写的守卫会**假绿**。 */
  {
    name: "29 删掉 frame() 的 alive 挡板（已排队的帧续命 ⇒ 僵尸循环）",
    file: F_RAIL,
    mutate: (t) => sub(t, "      if (!alive) { R.running = false; return; }\n      const p = pRef.current;",
      "      const p = pRef.current;"),
  },
  {
    name: "30 把挡板挪到 rAF **之后**（照样含 alive，但等于没挡 —— 位置才是判据）",
    file: F_RAIL,
    /* 两处一起改：入口的挡板删掉、末尾补一个 —— 结果 `!alive` 仍在函数体内，
       只有「必须早于 requestAnimationFrame」这条顺序判据能发现它。 */
    mutate: (t) => sub(
      sub(t,
        "      if (!alive) { R.running = false; return; }\n      const p = pRef.current;",
        "      const p = pRef.current;"),
      "      if (idle) { R.running = false; draw(tms); return; }\n      requestAnimationFrame(frame);",
      "      if (idle) { R.running = false; draw(tms); return; }\n"
      + "      requestAnimationFrame(frame);\n"
      + "      if (!alive) { R.running = false; }"),
  },
  {
    name: "31 删掉 cleanup 的 alive = false（令牌从不置位 ⇒ 挡板恒真）",
    file: F_RAIL,
    mutate: (t) => sub(t, "      alive = false;\n      hit.removeEventListener(\"pointerenter\", onEnter);",
      "      hit.removeEventListener(\"pointerenter\", onEnter);"),
  },
  {
    name: "32 删掉 ensureLoop() 的 !alive（悬停 / 滚动又会被废弃实例叫醒）",
    file: F_RAIL,
    mutate: (t) => sub(t, "if (!alive || R.running || !R.visible) { return; }",
      "if (R.running || !R.visible) { return; }"),
  },
  {
    name: "33 删掉 layout() 的 !alive（cleanup 后仍能画一整帧盖掉新实例）",
    file: F_RAIL,
    mutate: (t) => sub(t, "      if (!alive) { return; }\n      const p = pRef.current;",
      "      const p = pRef.current;"),
  },
  {
    name: "34 外观面板根 paddingTop 归零（首版只让左右 ⇒ 页签顶到内容区上沿、与顶栏分割线相交）",
    file: F_PANEL,
    mutate: (t) => sub(t, "paddingTop: 14, paddingBottom: 14,", "paddingTop: 0, paddingBottom: 14,"),
  },
  {
    name: "35 右栏滚动容器 paddingRight 退回 4（卡片边框压在滚动条上）",
    file: F_PANEL,
    mutate: (t) => sub(t, 'flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 10 }',
      'flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 4 }'),
  },
  {
    name: "36 给 canvas 加 key={mode} 冒充修复（旧闭包仍在废弃节点上烧 60fps = 掩盖而非根治）",
    file: F_RAIL,
    mutate: (t) => sub(t, '<canvas ref={cvRef} className="topic-rail-canvas" />',
      '<canvas key={mode} ref={cvRef} className="topic-rail-canvas" />'),
  },
  {
    name: "37 内容区（共用祖先）的 paddingLeft 归零（水平地板没了 ⇒ 面板全体顶到导航分割线）",
    file: F_SETTINGS,
    mutate: (t) => sub(t, "paddingLeft: 16, paddingRight: 10 }", "paddingLeft: 0, paddingRight: 10 }"),
  },
  {
    name: "38 「通用」页根容器又自己给水平留白（第二产地 ⇒ 与内容区叠加成 32px）",
    file: F_GENERAL,
    mutate: (t) => sub(t, 'padding: "16px 0"', 'padding: "16px"'),
  },
  {
    name: "39 外观面板根又加回 paddingLeft（A-1118 首版那份没删干净 ⇒ 两产地叠加）",
    file: F_PANEL,
    mutate: (t) => sub(t, "paddingTop: 14, paddingBottom: 14,",
      "paddingLeft: 0, paddingTop: 14, paddingBottom: 14,"),
  },
  {
    name: "40 「后台任务」页根容器恢复 4px 水平留白（贴线那一族回归）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, 'padding: "6px 0 16px"', 'padding: "6px 4px 16px"'),
  },
  {
    name: "41 删掉根容器的 settings-pane 类名（守卫的锚点消失 ⇒ 面板不再受地板约束，守卫必须出声）",
    file: F_PANEL,
    mutate: (t) => sub(t, '<div className="settings-pane" style={{',
      '<div style={{'),
  },
  {
    name: "42 外观面板根删掉 paddingBottom（只给上不给下 ⇒ 底部卡片贴边）",
    file: F_PANEL,
    mutate: (t) => sub(t, "paddingTop: 14, paddingBottom: 14,", "paddingTop: 14,"),
  },

  /* ── A-1115 预览页 drift 守卫（43~63）────────────────────────────────────
     预览页 `docs/A-1115-topic-rail-preview.html` 是**手抄的第二产地**，规格同 A-1117 那份。
     ⚠️ 每条只锁**一类**常量：值漂（44/45/46/47/53/54/55/56/58/59/60/61/62）与结构漂
        （50/51/57/63）分开测 —— 只锁值的话，有人把式子换个写法照样"看着对"。 */
  {
    name: "43 预览页 RIGHT_ROOM 写回 5（**本轮真实抓到的漂移**：真身是 6 ⇒ 凹陷夹紧上界差 1px）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "  var RIGHT_ROOM = 6;", "  var RIGHT_ROOM = 5;"),
  },
  {
    name: "44 预览页 LEFT_ROOM 与真身不一致（画布左余量漂了）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "  var LEFT_ROOM = 12;", "  var LEFT_ROOM = 24;"),
  },
  {
    name: "45 预览页滑杆 sSig 的 value 与真身默认值不一致（滑杆才是**生效值**）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, '<input type="range" id="sSig" min="6" max="60" value="13">',
      '<input type="range" id="sSig" min="6" max="60" value="40">'),
  },
  {
    name: "46 预览页 P 字面量 amp 与真身不一致（初值也不许漂）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "amp: 55,", "amp: 30,"),
  },
  {
    name: "47 预览页勾选框 cFlip 初始态与真身不一致",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, '<input type="checkbox" id="cFlip">',
      '<input type="checkbox" id="cFlip" checked>'),
  },
  {
    name: "48 真身 DEFAULT_WAVE_PARAMS.tap 改了、预览页没跟（**双向**：改真身不同步预览也要红）",
    file: F_PARAMS,
    // 两处守卫都该响：a1115 预览页 + a1117 预览页（后者也抄了 tap 默认值）
    specs: [SPEC_DRIFT_A1115, SPEC_DRIFT],
    mutate: (t) => sub(t, "tap: 90, efloor: 0.12,", "tap: 170, efloor: 0.12,"),
  },
  {
    name: "49 预览页 `.rail { right }` 与真身 RAIL_INSET 不一致（卷轴离宿主右缘的距离）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "bottom:16px;right:6px;width:12px", "bottom:16px;right:3px;width:12px"),
  },
  {
    name: "50 预览页 spanTaper 又发明真身没有的 `* 0.4` 钳位（真实漂移过；H≥300 时看不出来）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "      var s = R.TAP > 0 ? Math.min(1, Math.max(0, e / R.TAP)) : 1;",
      "      var tapNow = Math.max(0, Math.min((bot - top) * 0.4, R.H * 0.4));\n"
      + "      var s = tapNow > 0 ? Math.min(1, Math.max(0, e / tapNow)) : 1;"),
  },
  {
    name: "51 预览页双极位移去掉 `Bp·e^(−T/2)` 中间项（隆起越大、凹陷越看不出来）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "      var h = Bp * bump - (Dp + Bp * Math.exp(-T / 2)) * dipTerm;",
      "      var h = Bp * bump - Dp * dipTerm;"),
  },
  {
    name: "52 预览页波形带占比 0.88 → 0.70（波形与刻度位的分界漂了）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "var r = R.OX + R.W * (R.withTicks ? 0.76 : 0.88);",
      "var r = R.OX + R.W * (R.withTicks ? 0.76 : 0.70);"),
  },
  {
    name: "53 预览页已读/未读过渡带 0.07H → 0.20H（硬切换会留可见色块边）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "var Hb = R.H, blend = Math.max(14, Hb * 0.07);",
      "var Hb = R.H, blend = Math.max(14, Hb * 0.20);"),
  },
  {
    name: "54 预览页刻度突起影响范围 tA/tB 与真身不一致（「隔着老远刻度就都变长了」回归）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "        var tA = 1.5, tB = 3.2;", "        var tA = 1.0, tB = 2.0;"),
  },
  {
    name: "55 预览页刻度端部 floor 0.35 → 0.12（首尾两条被抹掉 = 读成「少了两条」）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "var endT = spanTaper(tk.u, R.TOP, R.BOT, 0.35);",
      "var endT = spanTaper(tk.u, R.TOP, R.BOT, 0.12);"),
  },
  {
    name: "56 预览页刻度层级长度 h1 的 0.90 改掉（层级 → 长度映射漂了）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, 'var frac = tk.lvl === "h1" ? 0.90 : (tk.lvl === "h2" ? 0.68 : 0.48);',
      'var frac = tk.lvl === "h1" ? 0.70 : (tk.lvl === "h2" ? 0.68 : 0.48);'),
  },
  {
    name: "57 预览页刻度铺排分母写成 n（末条够不到底 ⇒「分布不均匀」回归）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "        var f = n > 1 ? i / (n - 1) : 0.5;",
      "        var f = n > 1 ? i / Math.max(1, n) : 0.5;"),
  },
  {
    name: "58 预览页指针跟手强度 0.18 改掉（阻尼手感漂了）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "      var k = 1 - Math.pow(1 - 0.18, dt / 16.7);",
      "      var k = 1 - Math.pow(1 - 0.60, dt / 16.7);"),
  },
  {
    name: "59 预览页亮线颜色改掉（「整条发虚」的病根之一 —— 提亮线别抬暗线）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, 'var cr = i ? "59,130,246" : "191,219,254";',
      'var cr = i ? "59,130,246" : "150,180,220";'),
  },
  {
    name: "60 预览页左侧夹紧 1.4px 改掉（左边虽不设限，但「贴着画布缘」仍会硬裁）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "var lo = 1.4 - B.cx, hi = R.CW - 2.0 - B.cx;",
      "var lo = 0.0 - B.cx, hi = R.CW - 2.0 - B.cx;"),
  },
  {
    name: "61 预览页刻度跨度起点 `H/6` 改掉（中间 2/3 的约定漂了）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "      R.TOP = R.H / 6;", "      R.TOP = R.H / 4;"),
  },
  {
    name: "62 预览页双极位移的 T=2.7 改掉（h(0)=Bp、h(±√T)=−Dp 的精确性就没了）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, "      var T = 2.7;", "      var T = 2.0;"),
  },
  {
    name: "63 删掉预览页的一个 bind(...)（**检测器自检**：it.each 会静默退化成 0 条用例）",
    file: F_PREVIEW_A1115,
    specs: [SPEC_DRIFT_A1115],
    mutate: (t) => sub(t, '  bind("sSig", "sig", "vSig");\n', ""),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

function runSpec(specs) {
  const list = specs && specs.length ? specs : [SPEC];
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...list, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1500) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--specs") ? "specs"
    : argv.includes("--restore") ? "restore"
      : argv.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

/** 打印第 i 条变异该跑的守卫文件（shell 循环用；**唯一出处** = 变异自己的 `specs`） */
if (mode === "specs") {
  const idx = Number(argv[argv.indexOf("--specs") + 1]);
  const m = MUTATIONS[idx - 1];
  if (!m) { console.error(`--specs 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
  console.log((m.specs && m.specs.length ? m.specs : [SPEC]).join(" "));
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（EBUSY），全量模式跑不了，请用 --apply/--restore + shell 循环。");
  process.exit(1);
}
if (base.measurementFailed) {
  console.error("⚠️ 测量工具本身坏了（输出里没有 Tests 汇总行）—— 判据不成立，先修工具。");
  console.error(base.out); process.exit(1);
}
if (!base.ok) { console.error("基线未通过 —— 先修好守卫再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1115")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 check-mut-anchors.mjs 查）`);
      missed.push(m.name); continue;
    }
    writeFileSync(path, next);
    const res = runSpec(m.specs);
    writeFileSync(path, src);
    if (res.measurementFailed) {
      console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行），本轮判据不成立，中止。");
      console.error(res.out); missed.push(m.name); break;
    }
    if (res.ok) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
