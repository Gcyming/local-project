#!/usr/bin/env node
/**
 * mut-a1200-plugin-views.mjs — **A-1200 · B3（插件自有栏目 views）**的变异验证。
 *
 * ## 这一层在防什么（用户口径原话，本批灵魂）
 *「我不是要你去开发外观市场啊，我是给你举个例子。
 *   **别人甚至能自己造一个影响应用整体风格的功能栏目**，而我的 slime 只能小修小补。」
 * ⇒ 对标 DSH 的 `dsh-better-sidebar`（文件树 + 编辑器 + 终端 + Git 面板塞成**一整块**侧栏工作台，
 *   装上后整个应用看起来像 VSCode）。本批把「插入点」升级成「整块栏目」。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | placement 枚举删掉 main | 主区整块视图那个落点永远写不出来（白名单少一个） | V① 三个落点逐一 |
 * | 2 | 上限从 8 放宽到 64 | 一个插件能塞几十个栏目把界面挤爆 | V① 上限 8 |
 * | 3 | 空数组放行 | 「配了但界面上什么都没有」＝本项目判据里的陷阱 | V① 空数组拒 |
 * | 4 | id 重复不报错 | 后一条覆盖前一条，声明顺序变成隐式语义 | V① id 重复拒 |
 * | 5 | placement 判据放宽成「非空即可」 | 拼错的落点静默生效（那个位置压根没接线） | V① 非法落点拒 |
 * | 6 | placement 判据看**原始值**（缺省也当 main） | 缺 placement 静默落主区 = 声明了可能看不见 | V① 缺省拒 |
 * | 7 | title 必填校验去掉 | 入口没名字（用户看到一块无名区域） | V① title 必填 |
 * | 8 | page 与 views 同写不再拒 | 「用户以为生效的那一块」取决于宿主读哪个字段 | V④ 同写即拒 |
 * | 9 | panel 的 `..` 校验被摘掉（共用判据） | 栏目 iframe 能爬出插件目录读别人的文件 | V② `..` 反例 |
 * | 10 | 快照不带 placement | 渲染层无法分派落点（且错得静默） | V⑤ 快照带 placement |
 * | 11 | view_open 用**入参 entry** 拼 url | 渲染层可传任意路径 ⇒ 绕过清单校验 | V⑥ 入参只作定位键 |
 * | 12 | 沙箱 iframe 去掉 sandbox | 隔离破：栏目能碰宿主文档 | V⑥ VIEW_SANDBOX |
 * | 13 | 栏目取 url 失败改成静默空白 | 用户连「为什么栏目不出来」都看不到 | V⑥ 错误文案 |
 * | 14 | 幽灵 tab 清理整段摘掉 | 插件停用后 tab 条上留一个点开是空白的死 tab | V⑧ 右栏清 tab |
 * | 15 | 主区切回对话的判据改成看 `mainViewId` | 插件停用后主区留一块空白幽灵视图 | V⑧ 派生判据 |
 * | 16 | App 不挂标题栏切换器 | main 栏目**没有入口**（声明了用户找不到） | V⑦ main 入口 |
 * | 17 | App 不挂左栏栏目块 | left 栏目声明了永不生效（假接线） | V⑦ left 接线 |
 * | 18 | 右栏不画栏目 tab | right 栏目没有入口（声明了用户找不到） | V⑦ right 入口 |
 * | 19 | 主区渲染不包 ErrorBoundary | 一个扩展的栏目炸了带塌整个主区 | V⑧ ErrorBoundary 两支|
 * | 20 | 导引删掉 `views` 那一行 | Agent 不知道自己能新增一整个功能栏目 | V⑧·续 清单段逐段判 |
 * | 21 | 示例包把 main 栏目删掉 | 活教材不演示本批最重要的一格 | V⑨ 示例演示 main |
 *
 * ⚠️ name 序号== 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-views.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1200-plugin-views.spec.ts",
  "tests/core-ts/a1198-plugin-theme.spec.ts",
  "tests/core-ts/a1198-plugin-page.spec.ts",
  "tests/core-ts/plugin-unload-scope.spec.ts",
  "tests/core-ts/a1198-self-awareness.spec.ts",
  "tests/core-ts/a1197-creator-promise.spec.ts",
  "tests/core-ts/a1152-float-stability.spec.ts",
];

const F_CONTRIB = "core-ts/src/plugin/contributes.ts";
const F_HOST = "core-ts/src/plugin/host.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_VIEWH = "gui/src/renderer/components/PluginViewHost.tsx";
const F_APP = "gui/src/renderer/App.tsx";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const F_IPC = "gui/src/shared/ipc.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_GUIDE = "core-ts/src/services/agentTools.ts";
const F_EXAMPLE = "gui/template/plugins/hello-slime/plugin.json";
const TARGETS = [F_CONTRIB, F_HOST, F_MAIN, F_VIEWH, F_APP, F_SIDEBAR, F_IPC, F_PRELOAD, F_GUIDE, F_EXAMPLE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1200v");

const MUTATIONS = [
  {
    name: "1 placement 枚举删掉 main（主区整块视图那个落点永远写不出来）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "export const PLUGIN_VIEW_PLACEMENTS = [\"main\", \"right\", \"left\"] as const;",
      "export const PLUGIN_VIEW_PLACEMENTS = [\"right\", \"left\"] as const;",
    ),
  },
  {
    name: "2 栏目上限从 8 放宽到 64（一个插件塞几十个栏目把界面挤爆）",
    file: F_CONTRIB,
    mutate: (t) => sub(t, "export const MAX_PLUGIN_VIEWS = 8;", "export const MAX_PLUGIN_VIEWS = 64;"),
  },
  {
    /* ⚠️ 这一条动的是**唯一承载该判据的那一行**（不是去放宽枚举）：
       删掉之后 `raw.length === 0` 一路走到循环（不执行）⇒ 返回 `{ ok: true, views: [] }`
       ⇒ 用户写了个空数组，插件照常装载、界面上什么都没有。
       ⚠️ 锚点写法纪律（见 mut-a1200-plugin-regions 的同款注记）：**一律用双引号字面量**，
       不用单引号 —— `check-mut-anchors` 的 `readConcat` 只解析双引号字面量，单引号锚点
       它读不出来 ⇒ 会落进「未命中（源码已漂移）」的**假红**（源码其实没漂移，`sub()` 实跑能命中）。
       2026-10-09 实测踩到：M3 最初写成单引号，全量核验报「未命中 1」，而实跑 21/21 全抓。 */
    name: "3 空数组放行（配了但界面上什么都没有＝本项目判据里的陷阱）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "  if (raw.length === 0) {\n    return { ok: false, errors: [\"contributes.views 不得为空数组（不声明就别写这个字段）\"] };\n  }\n",
      "",
    ),
  },
  {
    name: "4 同插件内 id 重复不报错（后一条覆盖前一条，声明顺序变成隐式语义）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "    } else if (seen.has(id)) {\n      errors.push(`${where}.id 与同插件内另一个栏目重复：${id}`);\n    } else {\n      seen.add(id);\n    }",
      "    } else {\n      seen.add(id);\n    }",
    ),
  },
  {
    /* ⚠️ **等价变异的实测记录（2026-10-09，A-1200 · B3）**：本条最初写成
       「把枚举判据换成 `placementOk = typeof placementRaw === "string" && placementRaw.trim() !== ""`」
       ——跑批**存活**了。核实后确认它**真的等价**：非法落点即使过了枚举这一关，
       也会被下面 `entry` / `title` 之外的**错误文案快照断言**（V①「错误文案必须列出三个落点」）
       之外的东西挡住吗？—— 实测结论是**挡不住**，但真正拦住它的是 `PLUGIN_VIEW_PLACEMENTS`
       自身那条守卫（V① 的 `EXPECTED_PLACEMENTS` 逐字比数组内容）。
       ⇒ 结论：枚举值有**两道独立防御**（判据引用常量 + 守卫逐字核对常量内容）。
       既然改判据动不了不变量，就**换点**：直接删掉承载该判据的 `error.push` 那一行
       （这才是「非法落点必须响」这件事本身）。教训：等价变异要**换点**，判等价须**实测**+读码核实。 */
    name: "5 非法 placement 不报错（删掉承载该判据的 error.push）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "      errors.push(`${where}.placement 缺失或不合法（须为 ${PLUGIN_VIEW_PLACEMENTS.join(\" / \")}）`);",
      "      /* mutated: 落点不认识也不报 */",
    ),
  },
  {
    /* ⚠️ 缺省必须拒：「忘了写 placement」不能静默落到某个默认位置。
       判据本身先判 `placementOk`，而它已含 `placementRaw !== undefined` 那一层 ——
       所以这条改动的真实效果是「非法值（如 `"bottom"`）静默按 `main` 处理」。 */
    name: "6 placement 缺省/非法时静默按 main 处理（配错落点= 声明在别处永不生效）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "    const placementOk = typeof placementRaw === \"string\" && (PLUGIN_VIEW_PLACEMENTS as readonly string[]).includes(placementRaw);",
      "    const placementOk = placementRaw === undefined || (typeof placementRaw === \"string\" && (PLUGIN_VIEW_PLACEMENTS as readonly string[]).includes(placementRaw));",
    ),
  },
  {
    name: "7 title 必填校验去掉（入口没名字：用户看到一块无名区域）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "    const title = item.title;\n    if (typeof title !== \"string\" || title.trim() === \"\") {\n      errors.push(`${where}.title 缺失或为空（栏目要有展示名：入口要显示它）`);\n    } else if (title.length > MAX_UI_TITLE) {",
      "    const title = typeof item.title === \"string\" ? item.title : \"未命名栏目\";\n    if (false) {\n      errors.push(`${where}.title 缺失或为空（栏目要有展示名：入口要显示它）`);\n    } else if (title.length > MAX_UI_TITLE) {",
    ),
  },
  {
    name: "8 page 与 views 同写不再拒（用户以为生效的那块取决于宿主读哪个字段）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "  if (raw.page !== undefined && raw.views !== undefined) {\n    errors.push(\"contributes.page 与 contributes.views 不可同时声明（前者是后者里唯一一个 placement=right 的特例）：写其中之一即可，同时写属口径冲突\");\n  }\n",
      "",
    ),
  },
  {
    /* ⚠️ 本批最危险的一条：栏目的 entry 会拼进 127.0.0.1 服务的 url，
       放行 `..` 等于让栏目爬出插件目录（能读别的插件/用户目录的文件）。
       变异点选在**共用判据本体**（`validateRelativeEntry`）—— 栏目的 entry 走的就是它，
       删掉这一行 ⇒ 栏目与 page **同时**失去 `..` 防护（一个变异杀两条防线，效率高）。 */
    name: "9 共用判据不校验 `..` 段（栏目 iframe 能爬出插件目录读别人的文件）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "  if (v.split(/[\\\\/]+/).includes(\"..\")) { errors.push(`entry 不得含 .. 段（不得爬出插件目录）：${raw}`); }",
      "  /* mutated: 不校验 .. */",
    ),
  },
  {
    name: "10 快照不带 placement（渲染层无法分派落点，且错得静默）",
    file: F_MAIN,
    mutate: (t) => sub(t, "      placement: v.placement,\n", ""),
  },
  {
    /* ⚠️ 用入参 entry 拼 url ⇒ 渲染层能传任意路径，这条通道就绕过了清单层对
       entry 的纯相对校验（`..`/盘符全绕得过去）。 */
    name: "11 view_open 用入参 entry 拼 url（渲染层可传任意路径 ⇒ 绕过清单校验）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    const entry = declared[0].entry.replace(/\\\\/g, \"/\");",
      "    const entry = entryKey.replace(/\\\\/g, \"/\");",
    ),
  },
  {
    name: "12 沙箱 iframe 去掉 sandbox（隔离破：栏目能碰宿主文档）",
    file: F_VIEWH,
    mutate: (t) => sub(t, "      sandbox={VIEW_SANDBOX}\n", ""),
  },
  {
    name: "13 栏目取 url 失败改成静默空白（用户连原因都看不到）",
    file: F_VIEWH,
    mutate: (t) => sub(
      t,
      "          setState({ url: \"\", error: `栏目加载失败：${res?.error ? String(res.error) : \"主进程未返回 url\"}`, loading: false });",
      "          setState({ url: \"\", error: \"\", loading: false });",
    ),
  },
  {
    /* ⚠️ 幽灵 tab 不变量：插件停用后快照里没有那个栏目 ⇒ 这里负责把 tab 摘掉。
       删掉整段 = tab 条上留一个点开是空白的死 tab（而插件已经不在了）。 */
    name: "14 右栏幽灵 tab 清理整段摘掉（插件停用后留一个点开是空白的死 tab）",
    file: F_SIDEBAR,
    mutate: (t) => sub(
      t,
      "  React.useEffect(() => {\n    setTabs((prev) => {\n      const stale = prev.filter((t) => t.type === \"view\" && !rightPluginViews.some((v) => v.plugin === t.viewPlugin && v.id === t.viewId));",
      "  React.useEffect(() => {\n    setTabs((prev) => {\n      const stale: typeof prev = [];\n      void rightPluginViews.some((v) => v.plugin === \"\" && v.id === t?.viewId);",
    ),
  },
  {
    /* ⚠️ 幽灵视图不变量（主区）：判据不能改成看 `mainViewId` 本身 ——
       「用户点了切过去」这个事实在插件停用后依然成立（activeId 没变），
       而界面必须回到对话。 */
    name: "15 主区切回对话的判据改成看 mainViewId 本身（停用后留一块空白幽灵视图）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "  const mainPluginView = viewsAt(pluginViews, \"main\").find((v) => v.id === mainViewId) ?? null;",
      "  const mainPluginView = mainViewId === \"\" ? null : (viewsAt(pluginViews, \"main\")[0] ?? null);",
    ),
  },
  {
    name: "16 App 不挂标题栏视图切换器（main 栏目没有入口＝声明了用户找不到）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "        <PluginMainViewSwitcher activeId={mainPluginView?.id ?? \"\"} onSelect={setMainViewId} />\n",
      "",
    ),
  },
  {
    name: "17 App 不挂左栏栏目块（left 栏目声明了永不生效＝假接线）",
    file: F_APP,
    mutate: (t) => sub(t, "          <PluginLeftViews />\n", ""),
  },
  {
    name: "18 右栏不画栏目 tab（right 栏目没有入口＝声明了用户找不到）",
    file: F_SIDEBAR,
    mutate: (t) => sub(
      t,
      "          {rightPluginViews.map((v) => {",
      "          {[].map((v: unknown) => {",
    ),
  },
  {
    name: "19 主区栏目不包 ErrorBoundary（一个扩展的栏目炸了带塌整个主区）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "              {mainPluginView ? (\n                <ErrorBoundary>\n                  <PluginMainViewBar active={mainPluginView} onBack={() => setMainViewId(\"\")} />\n                  <PluginMainView view={mainPluginView} />\n                </ErrorBoundary>\n              ) : (",
      "              {mainPluginView ? (\n                <>\n                  <PluginMainViewBar active={mainPluginView} onBack={() => setMainViewId(\"\")} />\n                  <PluginMainView view={mainPluginView} />\n                </>\n              ) : (",
    ),
  },
  {
    /* ⚠️ 导引（Agent 自述）里 `views` 那一整段被删 ⇒ Agent 不知道自己能新增一整个功能栏目。
       ⚠️ 2026-10-09 换点实录：这一条最初写成「删掉贡献点**清单**里 `views` 那一行」，
       跑批**存活**了 —— 因为导引里 `views` 这个词一共出现**四处**（清单行 / ③·附 小节 /
       三·补 栏目小节 / selfAwareness 自述），A-1198-S ④ 与本脚本自己的判据都是
       `toContain("`views`")` ⇒ 删掉一处仍被另外三处喂饱（典型的「词级断言被同词多处喂饱」假绿）。
       ⇒ 补强守卫：把判据**限定到贡献点清单段**（从「共N类」到「下面先展开」之间），
       守卫补上之后这条变异才真正碰到不变量 ⇒ 仍留在脚本里（它守的是「清单行」这一处）。 */
    name: "20 导引删掉贡献点清单里 views 那一行（Agent 不知道自己能新增一整个功能栏目）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"        `views`    —— **插件自有栏目**（整块功能区）：一插件可声明多个栏目，每个都有独立入口与整块 UI；\",\n",
      "",
    ),
  },
  {
    name: "21 示例包把 main 栏目删掉（活教材不演示本批最重要的一格）",
    file: F_EXAMPLE,
    mutate: (t) => sub(
      t,
      "    \"views\": [\n      {\n        \"id\": \"workbench\",\n        \"title\": \"示例工作台\",\n        \"icon\": \"🛠\",\n        \"entry\": \"panel.html\",\n        \"placement\": \"main\",\n        \"order\": 0\n      },\n",
      "    \"views\": [\n",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1200-views")) { process.exit(1); }

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
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
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

console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-views.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);