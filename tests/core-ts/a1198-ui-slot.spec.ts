/**
 * A-1197 · B2（L4a）：UI 槽位的**接线形状**与**全量重算**判据。
 *
 * 渲染层没有组件测试环境（项目惯例：形状断言 + 变异），所以这里锁死三类事实：
 *   ① 「plugins_changed 一到就**重拉全量**」+ 三元组 key —— 卸载不彻底的历史缺陷高发区
 *      （A-1195 修过一次泄漏，本包不许倒退）；
 *   ② 三处挂载点真的接了（SettingsDialog 动态页 / StatusPanel 行组 / ChatPanel 输入栏）；
 *   ③ 主进程汇总的**唯一数据源**与**冲突标记**（不静默丢弃、不静默覆盖）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const SLOT_HOST = "gui/src/renderer/components/UiSlotHost.tsx";
const SETTINGS = "gui/src/renderer/pages/SettingsDialog.tsx";
const MAIN = "gui/src/main/index.ts";

describe("A-1198-UI ① 全量重算与三元组 key（卸载不彻底的高发区）", () => {
  const src = read(SLOT_HOST);

  it("订阅 `plugins_changed` 并**重拉全量**（setSlots 整体替换，不做增量 diff）", () => {
    expect(src).toMatch(/pluginsOnChanged\?\.\(\(\) => \{ void pull\(\); \}\)/);
    // 全量替换：以主进程返回为准整表 set（增量 add-only 会漏摘被卸载的槽位）
    expect(src).toMatch(/setSlots\(Array\.isArray\(res\?\.slots\) \?/);
  });

  it("React key 用 `plugin::slot::id` 三元组（插件卸载后旧槽位不可能残留）", () => {
    expect(src).toMatch(/const slotKey = \(s: PluginUiSlotDTO\): string => `\$\{s\.plugin\}::\$\{s\.slot\}::\$\{s\.id\}`/);
    expect(src.match(/key=\{slotKey\(s\)\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("每个槽位外面包 `ErrorBoundary`（一个扩展的槽位炸了不带塌整页）", () => {
    expect(src).toContain("import ErrorBoundary from \"../ErrorBoundary.js\"");
    expect(src).toMatch(/<ErrorBoundary>/);
  });

  it("未知槽位渲染成「本槽位尚未接线」而不是空白（不静默）", () => {
    /* ⚠️ A-1200 · B1 起未知区域的文案是「本区域尚未接线（…）」/`本区域尚未接线：…`
       —— 槽位升级成区域后「槽」这个字不再准确（守卫按字面比对，不靠 includes 糊过去）。 */
    expect(src).toContain("本区域尚未接线");
  });

  it("冲突项渲染成**禁用态**（不静默丢弃、不静默覆盖）", () => {
    expect(src).toMatch(/disabled=\{s\.conflict === true\}/);
    expect(src).toContain("冲突");
  });
});

describe("A-1198-UI ② 三处挂载点真的接了", () => {
  it("SettingsDialog：`ui:` 类型 + 动态 SECTIONS 合并 + `ui:` 前缀分支渲染 UiSlotPanel", () => {
    const src = read(SETTINGS);
    expect(src).toContain("`ui:${string}`");
    expect(src).toMatch(/const allSections = React\.useMemo<SectionDef\[\]>\(\(\) => \[\.\.\.SECTIONS, \.\.\.uiSections\], \[uiSections\]\)/);
    expect(src).toMatch(/activeTab\.startsWith\("ui:"\) && <UiSlotPanel slotKey=\{activeTab\} \/>/);
    // 动态页随声明全量重算（plugins_changed 重拉）
    expect(src).toMatch(/pluginsOnChanged\?\.\(\(\) => \{ void pull\(\); \}\)/);
  });

  it("StatusPanel：底部挂载 PluginStatusItems", () => {
    const src = read("gui/src/renderer/pages/StatusPanel.tsx");
    /* ⚠️ A-1200 · B1 起这条 import 多了 `PluginStatusBarItems`（status_bar 区域）⇒ 只认组件名。 */
    expect(src).toMatch(/import \{[^}]*PluginStatusItems[^}]*\} from "\.\.\/components\/UiSlotHost\.js"/);
    expect(src).toMatch(/<PluginStatusItems \/>/);
  });

  it("ChatPanel：输入栏动作区挂载 PluginChatActions（插文本）与 PluginToolbarItems（B5 开页面）", () => {
    const src = read("gui/src/renderer/pages/ChatPanel.tsx");
    /* ⚠️ A-1200 · B1 起这条 import变长了（多了输入栏两端与消息动作区）⇒ 锚点不能写死整行，
       只认「从 UiSlotHost 导入了 PluginChatActions」这件事本身。 */
    expect(src).toMatch(/import \{[^}]*PluginChatActions[^}]*\} from "\.\.\/components\/UiSlotHost\.js"/);
    expect(src).toMatch(/<PluginChatActions onInsert=\{\(t\) => setInput\(\(v\) => \(v \? `\$\{v\} \$\{t\}` : t\)\)\} \/>/);
    /* A-1197 · B5：toolbar_item 挂载（点击在右栏打开扩展自有页面）。 */
    expect(src).toMatch(/<PluginToolbarItems \/>/);
  });
});

describe("A-1198-UI ③ 主进程汇总：唯一数据源 / 冲突标记 / 卸载移表", () => {
  const src = read(MAIN);

  it("`pluginUiDecls` 是唯一数据源；activate 写入、dispose 按插件名精确移除（防重装误删新表）", () => {
    expect(src).toMatch(/const pluginUiDecls = new Map<string, PluginUiContribution\[\]>\(\)/);
    expect(src).toMatch(/pluginUiDecls\.set\(manifest\.name, ui\)/);
    expect(src).toMatch(/if \(pluginUiDecls\.get\(manifest\.name\) === ui\) \{\s*pluginUiDecls\.delete\(manifest\.name\);/);
  });

  it("冲突裁决：同 slot 同 id 按 order→插件名排序取第一个，其余标 `conflict: true`", () => {
    /* ⚠️ 2026-10-09 判据收窄（A-1200 · B3实测顶出来的守卫退化）：
       `{ ...r, conflict: true }` 这个 token 在 B3 之后**出现在两处**（slots 的冲突裁决 +
       栏目 views 的冲突裁决，同款机制）⇒ 原来的 `toMatch` 会被另一处喂饱。
       实测后果：`mut-a1198-ui-slot` M3（把**slots** 那处的 `forEach` 改成不标 conflict）
       跑批**存活**了 —— 守卫绿着，而缺陷是真的。
       ⇒ 判据必须**锁定在 slots 那一段**（`byKey` 分组 + `out.push`），不是全文 grep。
       这里按「`const byKey = ` 到 `const out: PluginUiSlotDTO[]` 之间」切段。 */
    const seg = /const byKey = new Map<string, PluginUiSlotDTO\[\]>\(\);[\s\S]*?const out: PluginUiSlotDTO\[\] = \[\];[\s\S]*?\n  \}/.exec(src);
    expect(seg, "main/index.ts 里找不到 slots 的冲突裁决段（byKey 分组 → out 汇总）").not.toBeNull();
    expect(seg![0], "slots 的冲突裁决必须标 conflict: true").toMatch(/\{ \.\.\.r, conflict: true \}/);
    /* 精确到**代码形态**（注释里也出现过 `conflict: true` 字样 —— 宽断言会被注释喂饱，实测踩过）。 */
    expect(seg![0]).toMatch(/const sorted = \[\.\.\.list\]\.sort\(/);
  });

  it("`plugins_ui` 通道已注册（handler 直接回汇总快照）", () => {
    expect(src).toMatch(/IPC_CHANNELS\.plugins_ui/);
    expect(src).toMatch(/pluginUiSnapshot\(\)/);
  });

  it("列表接口只给 `uiCount` 计数（明细按需拉，不塞爆 plugins_list）", () => {
    expect(src).toMatch(/uiCount: record\.manifest\.contributes\?\.ui\?\.length \?\? 0/);
  });
});
