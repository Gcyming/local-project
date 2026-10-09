#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-creator-promise.mjs — A-1197④「创造模式导引教 Agent 瞎承诺工具能力」的变异验证。
 *
 * ## 这一轮改的是什么
 * creatorGuide() 的 provides 字段要点原文是：
 *   「本模式写 ["instructions"]；将来要贡献工具再加 tools」
 * 而事实（取证）：gui/src/main/index.ts 的 createPluginHost 里 `registerTools: () => []`（空实现），
 * 插件宿主对「工具贡献」这条根本没有任何登记 ⇒ Agent 就算写了 provides: ["tools"]，
 * **也不会真的多出任何工具**，host.contribute 只会如实记 WIRING_PENDING（「尚未接线」，host.ts:36/263/267）。
 * 导引却把它说成「将来加 tools 就有工具」⇒ 教它做出**无法兑现的承诺**（与 A-1196 同一个病根：能力边界不清）。
 *
 * 修法（与 selfAwarenessGuide 同口径）：如实说现状 + 明说不要宣称多了工具 + 给正确做法（如实告诉用户去哪调）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 把正确表述改回原来的错误承诺 | 导引又教它「将来加 tools 就有工具」 | A 旧承诺已移除 + 源码形状「将来要贡献工具再加」 |
 * | 2 | 换个说法糊弄（以后…就有） | 同上，绕过逐字判据 | A 的正则族 + `not.toContain("将来")` |
 * | 3 | 删掉「不会真的多出任何工具」 | 只说未接线、不说后果 ⇒ Agent 仍可能以为能拿到工具 | B 整句断言 |
 * | 4 | 删掉「不要宣称自己多了工具能力」 | 瞎承诺的禁令消失 | C |
 * | 5 | 删掉「如实告诉用户…」正确做法 | 只破不许立 ⇒ Agent 不知道该怎么办，转而去吹 | D |
 * | 6 | 反向吹牛：说工具「已经接线」 | 比缺失更坏：错的承诺 | B 的反向守卫（已/已经/均已接线） |
 * | 7 | 砍掉 origin=agent 的字段要点行 | 既有安全约束被改坏 | E origin 三处 |
 * | 8 | 砍掉自验第 2 步 skill_search | 既有关键约束被改坏 | E 自验四步 |
 * | 9 | 砍掉 loop_config 的不越权声称 | 既有「如实转述、不吹」口径被改坏 | E loop_config |
 *
 * ## 第二段（10~18）：B1「设置贡献点」同步进导引后的回归
 * 缺陷（若回归）：B1 已落地（插件可在 plugin.json 里用 contributes.settings 声明设置项，
 * 宿主在扩展页渲染、落到插件自己目录），而导引一个字不提 ⇒ Agent 被问「你能给插件加设置项吗」
 * 会答「不能」—— 与 A-1196 同一个病根。
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 10 | 删掉整段 contributes 的字段要点 | Agent 不知道有这能力 ⇒ 答「不能」 | F-1 |
 * | 11 | 把五种 type 里的 boolean 删掉 | 导引说「五种」却数不出五种 | F-1 |
 * | 12 | 删掉 number 的 min 与 max 都必填 | 照着写必被清单拒 | F-2 |
 * | 13 | 删掉 path 的 root 只有两个枚举值 | 以为 path 能指到任意目录 | F-2 |
 * | 14 | 删掉「插件自己的目录」落点 | 以为设置会进主配置 | G |
 * | 15 | 删掉「根本没有路径这个参数」 | 以为能指定落盘位置 | G |
 * | 16 | 删掉「加密落盘 / 不回显明文」 | secret 项被说成明文存取 | H |
 * | 17 | 把 fail-closed 改成「会被忽略」 | 拼错字段静默失效 ⇒ 踩「配了没生效」的陷阱 | I |
 * | 18 | 删掉「不等于插件能改 slime 的配置」 | 反向吹牛：宣称能改主配置 | J |
 *
 * ## 第三段（19~24）：A-1198（B2–B6 落地后）能力同步的回归
 * 缺陷（若回归）：UI 槽位 / 脚本工具 / 自有页面 / 运行模式四项新能力在导引里被删或写残，
 * 或 `provides` 合法值退回「三个」⇒ Agent 又「不知道自己有能力」（A-1196 复发）+ 写出必被拒的清单。
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 19 | 删掉 ④ 运行模式整节（含阶段示例与规则） | 阶段机能力等于不存在；数字同源断言也断 | a1198-self-awareness ②/C |
 * | 20 | 脚本工具删掉信任门（trust.json 一句） | Agent 以为写完脚本就有工具（无法兑现） | a1198-self-awareness ② |
 * | 21 | 自有页面删掉 127.0.0.1 / 沙箱 iframe 说明 | 以为页面能 file:// 打开、能碰宿主 | a1198-self-awareness ② |
 * | 22 | UI 槽位删掉 toolbar_item⇔page 交叉约束 | 写出没有 page 的假按钮（必被拒） | a1198-self-awareness ② |
 * | 23 | 自述七项清单删掉「运行模式」（三种模式一起瞎） | 用户不问就永远不知道有阶段机 | a1198-self-awareness ① |
 * | 24 | `provides` 合法值改回「三个」（mode 不告而别） | 写了 mode 却不知道自己漏了宣告 | a1197-creator-promise B + silam E2 |
 * | 25 | 自定义模式的自述换成「默认模式」文案 | 标签失真（自定义模式是另一个可选模式） | a1198-self-awareness ① |
 * | 26 | 自述里复活「开发者模式」改主干承诺 | D1 口径回潮（用户明确否决：扩展=外部武装） | a1198-self-awareness ① |
 * | 27 | sandbox 残留 dev-mode 放行文案 | 「改程序本身」的通路回潮 | a1198-self-awareness ① |
 * | 28 | 扩展页文案复活「开发者模式」 | 界面口径回潮（用户以为能改程序） | a1198-self-awareness ① |
 *
 * ⚠️ 2026-10-08 锚点重打（A-1198 同步）：1/2/5/10 四条锚点所在的行文本随本轮改写而变
 * （`provides` 段补 `mode`、工具能力改「两条真路径」、`contributes` 段从「只有 settings」扩到四类）。
 * 变异**意图一字未变**，只同步锚点；下面每条都注了「新锚点」以区别于旧轮记录。
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-creator-promise.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）——本文件表格里的 provides 用纯文本表述。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-creator-promise.spec.ts",
  /* 同族自述守卫一并列入：导引文案改动会同时落到「能做什么」的清单上，
     只跑自己那份会漏判（判据清单漏一份 ⇒ 变异「假存活」却不报错）。 */
  "tests/core-ts/a1196-self-awareness.spec.ts",
  /* A-1198（2026-10-08）：B2–B6 能力同步的自述/导引守卫 —— 本脚本的变异（19~24）
     直接打的就是它，必须列入判据清单。 */
  "tests/core-ts/a1198-self-awareness.spec.ts",
];

const F_GUIDE = "core-ts/src/services/agentTools.ts";
/* 2026-10-09 反回归（用户口径「扩展 = 外部武装，不改程序本身」）：
   M27/M28 分别打 sandbox 与扩展页 —— 那两处是「改主干」通路曾出现过的地方。 */
const F_SANDBOX = "core-ts/src/sandbox.ts";
const F_PANEL = "gui/src/renderer/pages/PluginsPanel.tsx";
const TARGETS = [F_GUIDE, F_SANDBOX, F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197");

const MUTATIONS = [
  /* ── ①② 改回错误承诺（逐字 + 换说法两种形态）────────────────────── */
  /* ⚠️ 2026-10-07 重打锚点：①② 的 from 里那句「桌面端的插件宿主还没接线，」已被改写为
     「桌面端目前不接受外部插件贡献工具（宿主钩子返回空），」⇒ 原锚点 count=0。
     这是**文案改写导致锚点漂移**（不是邻接关系被打破），意图仍完全可实现：
     两条变异改的都是「如实说明不生效」这一段，把它变回「错误承诺」⇒ 守卫必须变红。
     只需把 from 里的那一行同步成当前文案，to（错误承诺本体）一字不改。
     下方第 3~6 条锚点位于**未被改写**的相邻行，实测仍命中 ⇒ 印证不是核验器问题。 */
  /*⚠️ 锚点一律写成**单个双引号字面量 + \\n**，不用 [...].join("\\n")：
     后者 check-mut-anchors 的 readConcat 读不出来 ⇒ 这条锚点会落进「未核验」，
     而「未核验 = 没人核验 = 没有保护」（见 check-mut-anchors 文件头 §「未核验的底线」）。 */
  {
    name: "1 把 provides 说明改回原来的错误承诺（将来加 tools 就有工具）",
    file: F_GUIDE,
    /* ⚠️ 2026-10-08 锚点重打（新锚点）：原 from 那五行已被 A-1198 改写
       （合法值扩到四个、工具能力改「两条真路径」）。变异意图不变：
       抹掉「不要宣称多了工具」的禁令 + 「插件加不了工具」的纠偏句，换回一句空头承诺。 */
    mutate: (t) => sub(
      t,
      "    \"      **不要因为清单里写了某个字段，就宣称自己多了工具能力** —— 那是无法兑现的承诺。\",\n"
      + "    \"      ⚠️ 但别把它读成「插件加不了工具」—— 加**工具能力**另有真路径：`contributes.scripts`（见本节「二·补 ②」），\",",
      "    \"      确实需要工具时：以后要贡献工具再加 `tools`，加了就有工具可用。\",",
    ),
  },
  {
    name: "2 换个说法糊弄（以后要加工具再加 tools 就生效）",
    file: F_GUIDE,
    /* ⚠️ 2026-10-08 锚点重打（新锚点）：行内多了「`provides` 这条路，」限定词（B4 同步）。 */
    mutate: (t) => sub(
      t,
      "    \"      写 `tools` 或 `prompt` **不会被拒绝，但也不会生效** —— `provides` 这条路，桌面端目前不接受外部插件贡献工具（宿主钩子返回空），\",",
      "    \"      以后要贡献工具再加 `tools`，加了就生效。\",",
    ),
  },
  /* ── ③ 只说未接线、不说后果 ─────────────────────────────────────── */
  {
    name: "3 删掉「不会真的多出任何工具」这个后果句",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      装载后插件清单里那一项只会显示「尚未接线」，**不会真的多出任何工具**。\",",
      "    \"      装载后插件清单里那一项只会显示「尚未接线」。\",",
    ),
  },
  /* ── ④ 禁令消失 ─────────────────────────────────────────────────── */
  {
    name: "4 删掉「不要因为写了字段就宣称自己多了工具能力」",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      **不要因为清单里写了某个字段，就宣称自己多了工具能力** —— 那是无法兑现的承诺。\",",
      "",
    ),
  },
  /* ── ⑤ 只破不许立 ───────────────────────────────────────────────── */
  {
    name: "5 删掉「如实告诉用户去哪调整」的正确做法",
    file: F_GUIDE,
    /* ⚠️ 2026-10-08 锚点重打（新锚点）：正确做法从一句扩成「两条真路径」三行
       （①脚本工具 ②调整工具配置/MCP），本变异整块删除 —— 只破不许立。 */
    mutate: (t) => sub(
      t,
      "    \"      确实需要新工具时，如实告诉用户两条路（由用户来开，不要假装已具备）：\",\n"
      + "    \"        ① 走 `contributes.scripts` 自带脚本（装完**提醒用户去「扩展」页点「信任脚本」**，否则工具不存在）；\",\n"
      + "    \"        ② 或在 设置 → Agent 管理 里调整工具配置 / 接入 MCP。\",",
      "",
    ),
  },
  /* ── ⑥ 反向吹牛 ─────────────────────────────────────────────────── */
  {
    name: "6 反向吹牛：把「未接线」说成工具贡献「已经接线」",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      装载后插件清单里那一项只会显示「尚未接线」，**不会真的多出任何工具**。\",",
      "    \"      装载后插件清单里那一项会显示已接线，**会真的多出可用工具**。\",",
    ),
  },
  /* ── ⑦⑧⑨ 回归保护：既有约束不许被改坏 ─────────────────────────── */
  {
    name: "7 砍掉 origin=agent 的字段要点行（既有安全约束被改坏）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"  · `origin`：如实写 `agent`。**绝不能写 `builtin`** —— 那是系统保留值，磁盘清单写 builtin 会被直接拒绝\",",
      "",
    ),
  },
  {
    name: "8 砍掉自验第 2 步 skill_search（既有关键约束被改坏）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"  2. `skill_search` 复核技能能被检索到 —— 注意这一步只证明「存在」，**不证明「可用」**\",",
      "",
    ),
  },
  {
    name: "9 砍掉 loop_config 的「不要越权声称」（既有的不吹口径被改坏）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"### 六、Agent-Loop 的节奏可按 Agent 定制（如实转述，不要越权声称）\",",
      "    \"### 六、Agent-Loop 的节奏可按 Agent 定制\",",
    ),
  },
  /* ── ⑩~⑱ B1「设置贡献点」：导引里那整段被删改 ─────────────────────── */
  /* ⚠️ 锚点写法：一律写成**单个双引号字面量 + \n**，不用 [...].join("\n")
     （后者 check-mut-anchors 的readConcat 读不出来 ⇒ 落进「未核验」＝没人核验）。
     每条锚点都锚**代码行**（数组元素那一行本身），不跨注释行。 */
  {
    name: "10 删掉整段 contributes 的字段要点（Agent 不知道有这能力）",
    file: F_GUIDE,
    /* ⚠️ 2026-10-08 锚点重打（新锚点）：contributes 段从「只有 settings」扩到四类
       （settings/ui/scripts/page），intro 四行同步改写。
       ⚠️ 2026-10-09 再重打：加入主题皮肤后「共四类」→「共五类」（M10 只删 intro，词数变化必须同步）。 */
    mutate: (t) => sub(
      t,
      "    \"  · `contributes`：可选，**进界面 / 进工具表**的声明（与上面 `provides` 的「进上下文」是两回事：\",\n"
      + "    \"      `provides` 是无 UI 的资产贡献，`contributes.*` 是**由宿主渲染成 UI 或装配成工具**的贡献点）。\",\n"
      + "    \"      共五类、**都已落地可用**（各自的声明示例见本节「二·补」）：\",\n"
      + "    \"        `settings` —— 宿主在「扩展」页渲染一组设置项，值只落该插件自己的目录；\",\n",
      "",
    ),
  },
  {
    name: "11 五种 type 里删掉 boolean（说五种却数不出五种）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"        `boolean` 开关 —— 无专属字段\",\n",
      "",
    ),
  },
  {
    name: "12 删掉 number 的 min 与 max 都必填（照着写必被清单拒）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"        `number`  数值框 —— `min` 与 `max` **都必填**（闭区间，且 min ≤ max）\",",
      "    \"        `number`  数值框 —— 无专属字段\",",
    ),
  },
  {
    name: "13 删掉 path 的 root 只有两个枚举值（以为 path 能指到任意目录）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"        `path`    路径文本框 —— `root` 必填，且**只能**是 `plugin`（相对插件目录）或 `workspace`（相对会话工作目录）\",",
      "    \"        `path`    路径文本框 —— `root` 可选，缺省相对插件目录\",",
    ),
  },
  {
    name: "14 删掉「插件自己的目录」这个落点（以为设置会进主配置）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      落点：值存在**这个插件自己的目录**里（插件目录下的 settings.json；`secret` 项落 settings.enc.json），\",\n"
      + "    \"      **不进** slime 主配置，也不影响别的插件。\",",
      "    \"      落点：由宿主决定，你不用关心。\",",
    ),
  },
  {
    name: "15 删掉「根本没有路径这个参数」（以为能指定落盘位置）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      路径**只由插件名推导**：写设置的入口只收「插件名 + 设置项 key + 值」，**根本没有「路径」这个参数** ——\",\n"
      + "    \"      所以「让界面或调用方指定落盘位置」在结构上就不成立，不靠事后校验拦。\",",
      "    \"      路径由插件名推导。\",",
    ),
  },
  {
    name: "16 删掉「加密落盘 / 不回显明文」（secret 项被说成明文存取）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      令牌 / 密码这类加 `\\\"secret\\\": true`：只对 `string` / `enum` / `path` 有意义，**加密落盘**、\",\n"
      + "    \"      读回来只告知「是否已有值」，**不回显明文**；`secret: true` 时**不许**写 `default`（那等于把明文留在清单里）。\",",
      "    \"      令牌 / 密码这类可以加 `\\\"secret\\\": true`，读回来会显示明文方便你核对。\",",
    ),
  },
  {
    name: "17 把 fail-closed 改成「会被忽略」（拼错字段静默失效）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      校验是 **fail-closed**：字段名拼错、`type` 不在五种之内、出现未知字段、专属字段挂到错的 type 上，\",\n"
      + "    \"      ⇒ **整份 plugin.json 被拒**（插件不会装载），而不是「配了但没生效」。写完务必用 `plugin_status` 复核。\",",
      "    \"      校验比较宽松：字段名拼错或出现未知字段会被忽略，其余照常生效。\",",
    ),
  },
  {
    name: "18 删掉「不等于插件能改 slime 的配置」（反向吹牛）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"      ⚠️ 边界：设置项**只影响该插件自己**。它**不等于**「插件能改 slime 的配置」——\",\n"
      + "    \"      想让用户改主配置或塞凭据进来，没有这条声明式路径，请如实告诉用户手动改。\",",
      "    \"      有了设置项你就能引导用户改主配置里的对应项。\",",
    ),
  },

  /* ── ⑲~㉔ A-1198（B2–B6 能力同步）：四类贡献点与六项自述的删残 ─────────
     ⚠️ 这批变异打的是**新守卫** tests/core-ts/a1198-self-awareness.spec.ts
        （已列入本脚本 SPECS；缺了它这些变异会「假存活」）。 */
  {
    name: "19 删掉 ④ 运行模式整节（阶段机能力等于不存在）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"**④ 运行模式（阶段机）** `provides: [\\\"mode\\\"]` + 顶层 `mode` 字段 —— 用户可在会话顶「运行模式」下拉选中：\",\n"
      + "    '  \"mode\": { \"kind\": \"stages\", \"stages\": [',\n"
      + "    '    { \"id\": \"survey\", \"title\": \"调研\", \"prompt\": \"只读调研…\", \"tools\": [\"file_read\"], \"maxRounds\": 8 },',\n"
      + "    '    { \"id\": \"plan\",   \"title\": \"方案\", \"prompt\": \"产出方案…\", \"requirePrevious\": \"survey\" } ] }',\n"
      + "    \"  规则：阶段 1–8 个；`prompt` ≤4000 字；`requirePrevious` 只能指**前面**的阶段；`maxRounds` 1–500；\",\n"
      + "    \"  `tools` 里的名字必须**真实存在**于当前工具表：**装载时查一次**（查不到 ⇒ 该插件被拒绝装载），\",\n"
      + "    \"  运行前每阶段还会重查（工具被停用 ⇒ 该阶段不执行，并在对话里如实说明 —— 不静默跳过）。\",\n"
      + "    \"  选中后：按阶段逐段执行、阶段间只带上一阶段结论（上下文自动裁剪）、进度在对话里逐段显示；\",\n"
      + "    \"  用户切模式要确认（会丢弃当前阶段上下文）；扩展被停用 ⇒ 会话自动回落默认模式（如实播报）。\",",
      "    \"**④ 运行模式（阶段机）** 已完成（变异：整节被删）。\",",
    ),
  },
  {
    name: "20 脚本工具删掉信任门（trust.json 一句）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"  ⚠️⚠️ **必须由用户**在「扩展」页该插件卡片上点「**信任脚本**」（落 trust.json）**才会装配**——\",",
      "    \"  写完脚本就会被装配（变异：信任门被删）——\",",
    ),
  },
  {
    name: "21 自有页面删掉 127.0.0.1 / 沙箱 iframe 说明",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"  页面经 127.0.0.1 静态服务加载（**不是** file://），在**沙箱 iframe** 里显示——\",\n"
      + "    \"  页面里可以跑你自己的 JS 与 fetch 同服务的资源，但**碰不到宿主**（跨源隔离）。\",",
      "    \"  页面直接打开（变异：服务与隔离说明被删）。\",",
    ),
  },
  {
    name: "22 UI 槽位删掉 toolbar_item⇔page 交叉约束",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"  **`toolbar_item` 必须同时声明 `contributes.page`**（它的唯一用途就是打开你的页面，没有 page 就是假按钮）。\",",
      "    \"  规则里 toolbar_item 与 page 的关联略（变异）。\",",
    ),
  },
  {
    name: "23 自述七项清单删掉「运行模式」（三种模式一起瞎）",
    file: F_GUIDE,
    /* ⚠️ 2026-10-09 锚点重打：该行尾从「。」改「；」（后面接了「主题皮肤」条目）。 */
    mutate: (t) => sub(
      t,
      "    \"      · 运行模式 —— 阶段机：用户在会话顶选中后，按声明的阶段清单逐段执行（每段可限工具白名单与轮次）；\",\n",
      "",
    ),
  },
  {
    name: "24 provides 合法值改回「三个」（mode 不告而别）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "    \"  · `provides`：合法值只有 `instructions` / `tools` / `prompt` / `mode` 四个；**只贡献指令时只写 `instructions`**，\",",
      "    \"  · `provides`：合法值只有 `instructions` / `tools` / `prompt` 三个；**只贡献指令时只写 `instructions`**，\",",
    ),
  },
  {
    name: "25 自定义模式的自述被换成「默认模式」文案（标签失真）",
    file: F_GUIDE,
    mutate: (t) => sub(
      t,
      "        ? \"你当前处于**自定义模式**（技能 / MCP 清单由用户在 Agent 管理里定制）：同样不能为自己新建插件；也无法通过自建技能扩展自己。\" +",
      "        ? \"你当前处于**默认模式**：不能为自己新建插件；也无法通过自建技能扩展自己（自建技能仅在创造模式下对你可见）。\" +",
    ),
  },
  {
    name: "26 自述里复活「开发者模式」改主干承诺（D1 口径回潮）",
    file: F_GUIDE,
    /* ⚠️ 2026-10-09 锚点重打（设计更正）：原 M26 打的是 dev-mode 会话寿命文案 —— 该段已随 D1 撤除。
       新意图：把「外部武装」口径换成「可以改主干」的 D1 承诺 ⇒ 反回归守卫必须红。 */
    mutate: (t) => sub(
      t,
      "    \"  落在**外部插件目录**里。不要把「高自由度」说成改程序 —— 如实告诉用户「能力以可开可关的外部插件形态提供」。\",",
      "    \"  用户可在「扩展」页开开发者模式，随后你在 slime 的 worktree 里改主干源码（每次启动需确认）。\",",
    ),
  },
  {
    name: "27 sandbox 残留 dev-mode 放行文案（改主干通路回潮）",
    file: F_SANDBOX,
    mutate: (t) => sub(
      t,
      "      return { allowed: false, reason: `目标 '${target}' 超出工作目录范围（需用户确认）`, level, anomalyDetected: false, anomalyAlerts: [] };",
      "      return { allowed: false, reason: `devModeWriteAllowed：目标 '${target}' 超出工作目录范围（需用户确认）`, level, anomalyDetected: false, anomalyAlerts: [] };",
    ),
  },
  {
    name: "28 扩展页文案复活「开发者模式」（界面口径回潮）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "        扩展一律是<b>外部</b>能力（可开可关、卸下即恢复原样）——<b>不改动应用本身</b>。",
      "        扩展一律是可开可关的外部能力；如需改应用本身请走开发者模式（见下方开关）。",
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
if (reportEolProblems(eolFound, "mut-a1197")) { process.exit(1); }

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

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-creator-promise.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 1) { process.exit(1); }
process.exit(1);