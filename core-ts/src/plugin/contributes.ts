/**
 * A-1197 · B1（L4b 设置贡献点）：插件**声明式设置项**的形状与 fail-closed 校验。
 *
 * ## 为什么单独一个文件、且与 UI 槽位共用（B2 会往这里加槽位）
 * `manifest.ts` 只管「清单有哪些顶层字段」，**声明项的形状**（枚举值、取值范围、
 * 枚举/数值/路径的额外约束）一律在这里 —— 于是「声明」与「校验」只有一个产地，
 * `parsePluginManifest` 与运行期写入校验共用同一份 `validatePluginSettingValue`，
 * 不会出现「清单放行了一个值、写盘时又拒了」的第二套口径。
 *
 * ## fail-closed（与 `parsePluginManifest` 同款，且更严一档）
 * 任一项非法 ⇒ **整份 `contributes.settings` 被拒**（调用方据此把整份清单 rejected），
 * 绝不静默丢弃单个字段 —— 静默丢弃会造出「配了但不生效」的假自由度，
 * 而本项目的判据是「能配但没生效 = 陷阱」。
 * 未知字段同样拒绝：`contributes` 是宿主与扩展之间的**契约**，
 * 放行未知字段等于允许拼错字段名后静默失效。
 */

export const PLUGIN_SETTING_TYPES = ["boolean", "string", "number", "enum", "path"] as const;

export type PluginSettingType = (typeof PLUGIN_SETTING_TYPES)[number];

/** `path` 类设置项的取值根：**只有两个枚举值**，没有第三种（结构上不许扩展借它写主配置）。 */
export const PLUGIN_SETTING_ROOTS = ["plugin", "workspace"] as const;

export type PluginSettingRoot = (typeof PLUGIN_SETTING_ROOTS)[number];

/** 设置项 key：与插件名同族，但额外允许 `_` 与 `.` 作分隔符。 */
export const PLUGIN_SETTING_KEY_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

/** 插件名 / UI 槽位 id 的命名（A-1197 · B2 从 `manifest.ts` 迁到这里 ——
 *  「名字长什么样」只有一个产地；`manifest.ts` 原地 re-export，对外 API 不变）。 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 单个插件最多声明多少设置项（防「一个插件塞 500 项把设置页撑爆」）。 */
export const MAX_PLUGIN_SETTINGS = 32;

/** `string` / `hint` / `label` 的长度上限（声明会回传渲染层，无上限会被撑爆面板）。 */
export const MAX_SETTING_STRING = 4096;
export const MAX_SETTING_LABEL = 80;
export const MAX_SETTING_HINT = 200;

/** `secret` 只对「值本身就是一段文本」的类型有意义（布尔/数字加密没有意义，且会诱使人以为已加密）。 */
export const PLUGIN_SETTING_SECRET_TYPES = ["string", "enum", "path"] as const;

export interface PluginSettingDecl {
  key: string;
  label: string;
  type: PluginSettingType;
  /** 仅 `type: "enum"`：非空候选列表 */
  options?: string[];
  /** 仅 `type: "number"`：闭区间下界（必填） */
  min?: number;
  /** 仅 `type: "number"`：闭区间上界（必填） */
  max?: number;
  /** 仅 `type: "path"`：取值根，**必填**且只能是 `plugin` / `workspace` */
  root?: PluginSettingRoot;
  hint?: string;
  /** 落盘走加密文件；读回只给 `hasValue`，主进程不提供读明文的通道 */
  secret?: boolean;
  /** 缺省值：必须能通过 `validatePluginSettingValue`（类型错就是拒绝，不静默丢弃） */
  default?: unknown;
}

/* ── A-1197 · B2（L4a UI 贡献点）─────────────────────────────────────────────
 * 四个白名单槽位里 B2 先落三个（`settings_panel` / `status_item` / `chat_action`）；
 * **B5** 补上 `toolbar_item`（「打开扩展自己的页面」——必须与 `page` 配对声明，
 * 见下方交叉校验）。`webview` 形态的 page 暂拒（需显式 guest preload/sandbox 配置，
 * 见设计 §5.4）——写了就是拒，fail-closed，不装假插座。
 *
 * ── A-1200 · B1：4 个固定槽位 → **13 个区域注册表**（对标 DSH「任意位置挂按钮」）──
 * 既有 4 个名字**原样保留**（老插件不改一个字照常工作，向后兼容是硬要求），
 * 新增 9 个区域让声明可以落到界面任意位置。
 * ⚠️ **`PLUGIN_UI_SLOTS` 保留为 `PLUGIN_UI_REGIONS` 的别名导出**：一次性改爆所有调用方
 * （渲染层 / 守卫 / 变异脚本都按这个名字打锚点）收益为零、风险全在。
 * 两个名字指向**同一个数组**，所以「别名」不是两份清单漂移的入口。 */
export const PLUGIN_UI_REGIONS = [
  /* ── 既有 4 个（A-1197 · B2/B5 的槽位，名字与语义都不动）── */
  "settings_panel",
  "status_item",
  "chat_action",
  "toolbar_item",
  /* ── A-1200 · B1 新增 9 个 ── */
  "titlebar_start",
  "titlebar_end",
  "chat_input_leading",
  "chat_input_trailing",
  "chat_message_actions",
  "sidebar_section",
  "status_bar",
  "overlay_floating",
  "overlay_fullscreen",
] as const;

export type PluginUiRegion = (typeof PLUGIN_UI_REGIONS)[number];

/** A-1197 起的旧名（A-1200 · B1 起为 `PLUGIN_UI_REGIONS` 的**别名**，同一数组，非副本）。 */
export const PLUGIN_UI_SLOTS = PLUGIN_UI_REGIONS;
export type PluginUiSlot = PluginUiRegion;

/** 单个插件最多声明多少条 UI 槽位（防「一个插件塞一堆条目把界面撑爆」）。 */
export const MAX_PLUGIN_UI_SLOTS = 16;

/* ── A-1200 · B1：两种贡献形态 ────────────────────────────────────────────────
 * `item`（缺省）：宿主渲染的按钮/行 —— 扩展只声明 label/icon，界面由宿主实现（红线不变）。
 * `panel`：扩展自带 HTML，宿主起 `127.0.0.1` 静态服务并用**沙箱 iframe** 挂到任意区域
 * （与 `contributes.page` 同一套底子，panel 是它的泛化：不再只限「右栏一个 tab」）。
 * ⚠️ **绝不把扩展代码注入宿主页面**（不做 DSH 的 `__ModuleLoader__` 路线 —— 理由见
 * `docs/plugin-ui-freedom-design.md` §0/§5：DSH 官方 SAFETY.md 自己承认那不构成安全边界）。 */
export const PLUGIN_UI_KINDS = ["item", "panel"] as const;
export type PluginUiKind = (typeof PLUGIN_UI_KINDS)[number];

/**
 * **形态-区域兼容表（单一产地）** —— 守卫与校验都只认这张表。
 *
 * 为什么要有这张表：`overlay_*` 两个区域在语义上就是「一块自己定位的 UI」，
 * 让 item 形态挂上去只会得到一个**永远不显示**的声明（渲染器按形态分派，
 * 而 overlay 层只渲染 panel）⇒ 「配了但不生效」＝本项目判据里的陷阱，必须在清单层就拒。
 * 另一半方向同样要拒：`settings_panel` 是**既有的整页形态**（宿主渲染标题 + 说明），
 * 改成 panel 会让同一个区域出现两套互斥的渲染路径 ⇒ 结构上不许。
 * 其余区域两种形态都收（item = 宿主渲染的按钮/行；panel = 扩展自己的 UI 块）。
 */
export const PLUGIN_UI_REGION_KINDS: Readonly<Record<PluginUiRegion, readonly PluginUiKind[]>> = {
  settings_panel: ["item"],
  status_item: ["item", "panel"],
  chat_action: ["item", "panel"],
  toolbar_item: ["item", "panel"],
  titlebar_start: ["item", "panel"],
  titlebar_end: ["item", "panel"],
  chat_input_leading: ["item", "panel"],
  chat_input_trailing: ["item", "panel"],
  chat_message_actions: ["item", "panel"],
  sidebar_section: ["item", "panel"],
  status_bar: ["item", "panel"],
  overlay_floating: ["panel"],
  overlay_fullscreen: ["panel"],
};

/** 该区域是否接受给定形态（查表；区域名不认识时返回 false —— 不许静默放行）。 */
export function isPluginUiRegionKind(region: string, kind: PluginUiKind): boolean {
  const allowed = (PLUGIN_UI_REGION_KINDS as Record<string, readonly PluginUiKind[]>)[region];
  return Array.isArray(allowed) && allowed.includes(kind);
}

/** 槽位声明里标题/文案字段的长度上限（声明会回传渲染层，无上限会被撑爆面板）。 */
export const MAX_UI_TITLE = 80;
/** 图标字段（一个名字/短串，渲染层自己决定怎么画）的长度上限。 */
export const MAX_UI_ICON = 64;

/** `status_item` 的刷新方式枚举（其它取值一律拒）。 */
export const PLUGIN_UI_REFRESH = ["manual", "on_event"] as const;
export type PluginUiRefresh = (typeof PLUGIN_UI_REFRESH)[number];

export interface PluginUiContribution {
  /** 落点区域名（13 个白名单之一，见 `PLUGIN_UI_REGIONS`；不认识 ⇒ 整份拒）。 */
  slot: PluginUiRegion;
  /** 同插件内唯一；跨插件的槽位冲突留给宿主裁决（见设计 §4.1「失控时怎么兜」）。 */
  id: string;
  /** A-1200 · B1：贡献形态，**缺省 `item`**（向后兼容：老清单不写这个字段也照常工作）。
   *  · `item`  —— 宿主渲染的按钮/行（本文件以下的 title/label/icon/refresh/when 全是它的字段）；
   *  · `panel` —— 扩展自带 HTML（必须给 `entry`），宿主起静态服务 + 沙箱 iframe 挂到本区域。 */
  kind?: PluginUiKind;
  /** 仅 `kind: "panel"`：**必填**、**纯相对**的 HTML 入口（如 `panel.html`）。
   *  校验口径与 `contributes.page.entry` 同款（`validateRelativeEntry`）。
   *  ⚠️ `kind: "item"` 时**必须不存在** —— 写了就是「声明了但没人用」，一律拒（不静默丢弃）。 */
  entry?: string;
  /** 仅 `settings_panel`：页面标题（必填）。 */
  title?: string;
  /** 其余槽位：条目文案（必填）。 */
  label?: string;
  icon?: string;
  order?: number;
  /** 仅 `status_item`：刷新方式（必填，枚举）。 */
  refresh?: PluginUiRefresh;
  /** 仅 `chat_action`：显示条件的说明文字（可选，纯展示语义）。 */
  when?: string;
}

export interface PluginContributes {
  settings?: PluginSettingDecl[];
  /** A-1197 · B2（L4a UI 贡献点）：进界面的槽位声明（与 settings 并列、判据独立）。 */
  ui?: PluginUiContribution[];
  /** A-1197 · B4（T1 脚本信任）：**可执行脚本**声明 —— 只在用户于扩展页点「信任本插件的
   *  脚本」（`trust.json`）后才会被主进程 `spawn` 装配（设计 §4.4 T1 / §5.1）。 */
  scripts?: PluginScriptDecl[];
  /** A-1197 · B5（L4a page）：扩展**自有页面**（toolbar_item 点击时打开；经 127.0.0.1 静态服务）。 */
  page?: PluginPageDecl;
  /** A-1198 · 主题贡献点（皮肤）：声明一组**白名单设计令牌**，宿主校验后应用到全局 CSS 变量 ——
   *  可开可关（卸载/停用即恢复默认），且**没有任何扩展 CSS 进入宿主样式表**（红线不变，见下方节注）。 */
  theme?: PluginThemeDecl;
  /** A-1200 · B2：一个插件的**多套皮肤**（对标 DSH `dsh-theme-gallery` 一次 12 套）。
   *  `theme` 是本字段长度为 1 的特例，两者**语义等价但不可同写**（同写 ⇒ 整份拒，见
   *  `parsePluginContributes` 的交叉校验：口径冲突不猜「以哪个为准」）。 */
  themes?: PluginThemeDecl[];
  /** A-1198 · 续：CSS 贡献点（用户口径「把CSS 修改权限全面放开，通过插件来进行开关可控的改动」）。
   *  纯 CSS 文本，fail-closed 静态禁令（禁 @import/url()/@font-face/!important/全局选择器/position:fixed），
   *  落地时收进 `@layer slime-plugin`（**低于**宿主层 ⇒ 盖不掉权限弹窗等安全关键 UI），
   *  选择器自动收进 `.slime-plugin-scope` 作用域。停用/卸载即整段撤下（可开可关）。 */
  css?: PluginCssDecl;
  /** A-1200 · B3：**插件自有栏目**（一插件可多个）——
   *  这是本设计最重要的一格（用户口径：「别人甚至能自己造一个影响应用整体风格的功能栏目」）。
   *  与 `ui` 的根本差别：`ui` 是**插入点**（在宿主既有区域里放小组件），`views` 是**整块栏目**
   *  （插件开辟自己的功能区，有独立入口与整块 UI）——用户感受是「这个插件给 slime 加了一整个新功能区」。
   *  `page`（B5）是本字段的**特例**：语义 = `views` 里唯一一个 `placement: "right"` 的栏目。
   *  ⚠️ `page` 与 `views` **不可同写**（口径冲突不猜，见 `parsePluginContributes` 的交叉校验）。 */
  views?: PluginViewDecl[];
}

/* ── A-1197 · B4（T1 脚本信任）──────────────────────────────────────────────
 * 声明形状（`contributes.scripts`）与校验。执行侧的一切（spawn cwd/timeout/stdout 契约）
 * 见主进程的 registerScripts —— 本文件只管「声明长什么样必须合法」。 */
export interface PluginScriptDecl {
  /** 脚本名（工具名会以 `<plugin>__<name>` 前缀注册，避免跨插件撞名）。 */
  name: string;
  /** **纯相对**入口路径（如 `tools/run.mjs`）——不许盘符、不许 `..`、不许以分隔符开头。 */
  entry: string;
  description?: string;
}

/** 单个插件最多声明多少脚本（防「一个插件塞一堆工具把模型工具面撑爆」）。 */
export const MAX_PLUGIN_SCRIPTS = 16;
/** 脚本 description 的长度上限（会进 LLM schema）。 */
export const MAX_SCRIPT_DESCRIPTION = 200;

/** 纯相对路径校验 —— 与 `loader.ts` 对 `entry` 的既有口径同款（导出供 page.entry 共用；
 *  B4 阶段先落在这里，单一产地）。 */
export function validateRelativeEntry(raw: string): string[] {
  const errors: string[] = [];
  const v = raw.trim();
  if (v === "") { errors.push("entry 不能为空"); return errors; }
  if (v.includes("\0")) { errors.push("entry 含 NUL 字符"); }
  if (hasDriveOrUncPrefix(v)) { errors.push(`entry 必须是纯相对路径，不接受绝对路径或盘符：${raw}`); return errors; }
  if (v.startsWith("/") || v.startsWith("\\")) { errors.push(`entry 不许以分隔符开头：${raw}`); }
  if (v.split(/[\\/]+/).includes("..")) { errors.push(`entry 不得含 .. 段（不得爬出插件目录）：${raw}`); }
  return errors;
}

const ALLOWED_SCRIPT_FIELDS: readonly string[] = ["name", "entry", "description"];

export type ParsePluginSettingsResult =
  | { ok: true; settings: PluginSettingDecl[] }
  | { ok: false; errors: string[] };

/** 声明项允许出现的全部字段 —— 出现表外的键即拒绝（fail-closed 的关键一张网）。 */
const ALLOWED_DECL_FIELDS: readonly string[] = [
  "key",
  "label",
  "type",
  "options",
  "min",
  "max",
  "root",
  "hint",
  "secret",
  "default",
];

/** `contributes` 顶层允许出现的字段。 */
const ALLOWED_CONTRIBUTES_FIELDS: readonly string[] = ["settings", "ui", "scripts", "page", "theme", "themes", "css", "views"];

/** 单条 UI 槽位声明允许出现的全部字段（出现表外的键即拒绝）。
 *  A-1200 · B1 起含 `kind` 与 `entry`（panel 形态）。 */
const ALLOWED_UI_FIELDS: readonly string[] = ["slot", "id", "kind", "entry", "title", "label", "icon", "order", "refresh", "when"];

export function isPluginSettingType(value: unknown): value is PluginSettingType {
  return typeof value === "string" && (PLUGIN_SETTING_TYPES as readonly string[]).includes(value);
}

export function isPluginSettingRoot(value: unknown): value is PluginSettingRoot {
  return typeof value === "string" && (PLUGIN_SETTING_ROOTS as readonly string[]).includes(value);
}

export function isPluginSettingKey(value: unknown): boolean {
  return typeof value === "string" && PLUGIN_SETTING_KEY_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Windows 盘符前缀（如 `C:`）与 UNC 开头 —— 两者都意味着「绝对路径」。 */
function hasDriveOrUncPrefix(text: string): boolean {
  return /^[A-Za-z]:/.test(text) || text.startsWith("\\\\");
}

/**
 * `path` 类取值必须是**纯相对路径**：不含盘符、不以 `/` 或 `\` 开头、不含 `..` 段、不含 NUL。
 *
 * 为什么在**值**这一层也查一遍（而不是只在 `root` 上做枚举）：`root` 只说明「相对哪个根」，
 * 而 `../../slime.toml` 这种相对路径照样能爬出根 —— 结构上做不到才是真的做不到。
 */
export function validatePluginSettingPathValue(value: string): string[] {
  const errors: string[] = [];
  const raw = value.trim();
  if (raw === "") {
    errors.push("path 取值不能为空");
    return errors;
  }
  if (raw.includes("\0")) {
    errors.push("path 取值含 NUL 字符");
  }
  if (hasDriveOrUncPrefix(raw)) {
    errors.push(`path 取值必须是纯相对路径，不接受绝对路径或盘符：${value}`);
    return errors;
  }
  if (raw.startsWith("/") || raw.startsWith("\\")) {
    errors.push(`path 取值必须是纯相对路径，不接受以分隔符开头：${value}`);
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.includes("..")) {
    errors.push(`path 取值不得含 .. 段（不得爬出声明的根）：${value}`);
  }
  return errors;
}

/**
 * 运行期写入校验 —— 与清单里 `default` 的校验**同一个函数**。
 *
 * 返回错误列表（空 = 通过）。`decl` 已被清单校验过，所以这里不再重复校验 decl 自身形状，
 * 只校验「这个值配不配得上这条声明」。
 */
export function validatePluginSettingValue(decl: PluginSettingDecl, value: unknown): string[] {
  const errors: string[] = [];
  switch (decl.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`设置项 ${decl.key} 需要布尔值，收到 ${typeof value}`);
      }
      return errors;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`设置项 ${decl.key} 需要有限数值，收到 ${typeof value}`);
        return errors;
      }
      if (decl.min !== undefined && value < decl.min) {
        errors.push(`设置项 ${decl.key} 小于下界 ${decl.min}：${value}`);
      }
      if (decl.max !== undefined && value > decl.max) {
        errors.push(`设置项 ${decl.key} 大于上界 ${decl.max}：${value}`);
      }
      return errors;
    }
    case "enum": {
      if (typeof value !== "string") {
        errors.push(`设置项 ${decl.key} 需要字符串候选值，收到 ${typeof value}`);
        return errors;
      }
      if (!(decl.options ?? []).includes(value)) {
        errors.push(`设置项 ${decl.key} 的值不在候选列表内：${value}`);
      }
      return errors;
    }
    case "path": {
      if (typeof value !== "string") {
        errors.push(`设置项 ${decl.key} 需要路径字符串，收到 ${typeof value}`);
        return errors;
      }
      errors.push(...validatePluginSettingPathValue(value));
      return errors;
    }
    case "string":
    default: {
      if (typeof value !== "string") {
        errors.push(`设置项 ${decl.key} 需要字符串，收到 ${typeof value}`);
        return errors;
      }
      if (value.length > MAX_SETTING_STRING) {
        errors.push(`设置项 ${decl.key} 的值过长（${value.length} > ${MAX_SETTING_STRING}）`);
      }
      return errors;
    }
  }
}

/**
 * 单条声明项的 fail-closed 校验。
 *
 * @param raw 该项的原始值
 * @param where 出错时的定位前缀（形如 `contributes.settings[2]`）
 */
export function parsePluginSettingDecl(raw: unknown, where: string): { ok: true; decl: PluginSettingDecl } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${where} 必须是对象`] };
  }
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_DECL_FIELDS.includes(field)) {
      errors.push(`${where} 含未知字段：${field}（允许的字段：${ALLOWED_DECL_FIELDS.join("、")}）`);
    }
  }

  const key = raw.key;
  if (!isPluginSettingKey(key)) {
    errors.push(`${where}.key 缺失或不合法（须匹配 ${PLUGIN_SETTING_KEY_PATTERN.source}）`);
  }

  const label = raw.label;
  if (typeof label !== "string" || label.trim() === "") {
    errors.push(`${where}.label 缺失或为空`);
  } else if (label.length > MAX_SETTING_LABEL) {
    errors.push(`${where}.label 过长（${label.length} > ${MAX_SETTING_LABEL}）`);
  }

  const type = raw.type;
  if (!isPluginSettingType(type)) {
    errors.push(`${where}.type 缺失或不合法（须为 ${PLUGIN_SETTING_TYPES.join(" / ")}）`);
  }

  const decl: PluginSettingDecl = {
    key: typeof key === "string" ? key : "",
    label: typeof label === "string" ? label.trim() : "",
    type: (isPluginSettingType(type) ? type : "string") as PluginSettingType,
  };

  /* ---- enum：必须给非空 options ---- */
  if (type === "enum") {
    const options = raw.options;
    if (!Array.isArray(options) || options.length === 0) {
      errors.push(`${where}.options 对 type=enum 是必填且不得为空`);
    } else {
      const collected: string[] = [];
      for (const opt of options) {
        if (typeof opt !== "string" || opt.trim() === "") {
          errors.push(`${where}.options 含非法候选值：${JSON.stringify(opt)}`);
          continue;
        }
        if (collected.includes(opt)) {
          errors.push(`${where}.options 含重复候选值：${opt}`);
          continue;
        }
        collected.push(opt);
      }
      if (collected.length > 0) {
        decl.options = collected;
      }
    }
    if (raw.min !== undefined) {
      errors.push(`${where}.min 对 type=enum 无意义（应删掉）`);
    }
    if (raw.max !== undefined) {
      errors.push(`${where}.max 对 type=enum 无意义（应删掉）`);
    }
  }

  /* ---- number：min 与 max 都必填，且 min <= max ---- */
  if (type === "number") {
    const min = raw.min;
    const max = raw.max;
    if (typeof min !== "number" || !Number.isFinite(min)) {
      errors.push(`${where}.min 对 type=number 是必填（须为有限数值）`);
    }
    if (typeof max !== "number" || !Number.isFinite(max)) {
      errors.push(`${where}.max 对 type=number 是必填（须为有限数值）`);
    }
    if (typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max)) {
      if (min > max) {
        errors.push(`${where} 的 min（${min}）不得大于 max（${max}）`);
      }
      decl.min = min;
      decl.max = max;
    }
    if (raw.options !== undefined) {
      errors.push(`${where}.options 对 type=number 无意义（应删掉）`);
    }
  }

  /* ---- path：root 必填，且只有两个枚举值 ---- */
  if (type === "path") {
    if (!isPluginSettingRoot(raw.root)) {
      errors.push(`${where}.root 对 type=path 是必填，且只能是 ${PLUGIN_SETTING_ROOTS.join(" / ")}`);
    } else {
      decl.root = raw.root;
    }
    if (raw.options !== undefined) {
      errors.push(`${where}.options 对 type=path 无意义（应删掉）`);
    }
  }

  if (type === "boolean") {
    for (const field of ["options", "min", "max", "root"] as const) {
      if (raw[field] !== undefined) {
        errors.push(`${where}.${field} 对 type=boolean 无意义（应删掉）`);
      }
    }
  }

  /* `string` 同样不许挂枚举型/数值型/路径型的专属约束 ——
     「留着吧反正不用」正是「配置项写错却不生效」的来源，所以一律拒。 */
  if (type === "string") {
    for (const field of ["options", "min", "max", "root"] as const) {
      if (raw[field] !== undefined) {
        errors.push(`${where}.${field} 对 type=string 无意义（应删掉）`);
      }
    }
  }

  /* ---- secret：只对文本类有意义；且 secret 项不许带 default（否则明文就在清单里） ---- */
  if (raw.secret !== undefined) {
    if (typeof raw.secret !== "boolean") {
      errors.push(`${where}.secret 必须是布尔值`);
    } else if (raw.secret === true) {
      if (isPluginSettingType(type) && !(PLUGIN_SETTING_SECRET_TYPES as readonly string[]).includes(type)) {
        errors.push(`${where}.secret 对 type=${type} 无意义（加密只对文本类有意义）`);
      }
      if (raw.default !== undefined) {
        errors.push(`${where}.secret=true 时不得声明 default（那会让明文直接留在清单里）`);
      }
      decl.secret = true;
    }
  }

  if (raw.hint !== undefined) {
    if (typeof raw.hint !== "string") {
      errors.push(`${where}.hint 必须是字符串`);
    } else if (raw.hint.length > MAX_SETTING_HINT) {
      errors.push(`${where}.hint 过长（${raw.hint.length} > ${MAX_SETTING_HINT}）`);
    } else if (raw.hint.trim() !== "") {
      decl.hint = raw.hint;
    }
  }

  /* ---- default：必须能通过值校验（类型错就是拒绝，不静默丢弃） ---- */
  if (raw.default !== undefined) {
    const valueErrors = validatePluginSettingValue(decl, raw.default);
    if (valueErrors.length > 0) {
      errors.push(`${where}.default 不合法：${valueErrors.join("；")}`);
    } else {
      decl.default = raw.default;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, decl };
}

/**
 * 解析 `contributes.settings`（一份声明数组）。
 *
 * 同插件内 key 重复 ⇒ 直接拒（否则「后一条覆盖前一条」会让声明顺序变成隐式语义）。
 */
export function parsePluginSettings(raw: unknown): ParsePluginSettingsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["contributes.settings 必须是数组"] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ["contributes.settings 不得为空数组（不声明就别写这个字段）"] };
  }
  if (raw.length > MAX_PLUGIN_SETTINGS) {
    return {
      ok: false,
      errors: [`contributes.settings 超过上限 ${MAX_PLUGIN_SETTINGS} 项：${raw.length}`],
    };
  }

  const settings: PluginSettingDecl[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `contributes.settings[${i}]`;
    const parsed = parsePluginSettingDecl(raw[i], where);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    const key = parsed.decl.key;
    if (seen.has(key)) {
      errors.push(`${where}.key 与同插件内另一项重复：${key}`);
      continue;
    }
    seen.add(key);
    settings.push(parsed.decl);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, settings };
}

/**
 * 解析整个 `contributes` 字段（`settings` + B2 的 `ui` 槽位）。
 *
 * 未知顶层键同样拒绝 —— 与清单顶层「向前兼容放行未知字段」的口径**刻意不同**：
 * 清单顶层是历史兼容面，`contributes` 是本批新立的契约面，写错字段名必须响。
 * 两个子字段**各自独立** fail-closed：任一非法的错误全量收集后**整份拒**。
 */
export function parsePluginContributes(raw: unknown): { ok: true; contributes: PluginContributes } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["contributes 必须是对象"] };
  }
  const errors: string[] = [];
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_CONTRIBUTES_FIELDS.includes(field)) {
      errors.push(`contributes 含未知字段：${field}（允许的字段：${ALLOWED_CONTRIBUTES_FIELDS.join("、")}）`);
    }
  }
  const out: PluginContributes = {};
  if (raw.settings !== undefined) {
    const parsed = parsePluginSettings(raw.settings);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.settings = parsed.settings; }
  }
  if (raw.ui !== undefined) {
    const parsed = parsePluginUiSlots(raw.ui);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.ui = parsed.ui; }
  }
  if (raw.scripts !== undefined) {
    const parsed = parsePluginScripts(raw.scripts);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.scripts = parsed.scripts; }
  }
  if (raw.page !== undefined) {
    const parsed = parsePluginPage(raw.page);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.page = parsed.page; }
  }
  if (raw.theme !== undefined) {
    const parsed = parsePluginTheme(raw.theme);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.theme = parsed.theme; }
  }
  if (raw.themes !== undefined) {
    const parsed = parsePluginThemes(raw.themes);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.themes = parsed.themes; }
  }
  if (raw.css !== undefined) {
    const parsed = parsePluginCss(raw.css);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.css = parsed.css; }
  }
  if (raw.views !== undefined) {
    const parsed = parsePluginViews(raw.views);
    if (!parsed.ok) { errors.push(...parsed.errors); } else { out.views = parsed.views; }
  }
  /* 交叉校验（A-1200 · B2）：`theme`（单对象）与 `themes`（数组）**同写即拒**。
     理由：两者语义是「长度 1 与长度 N」的特例关系，同时写会让「用户以为生效的那一套」
     取决于宿主内部读哪个字段 —— 口径冲突不猜（与 settings/ui 同样 fail-closed）。
     换句话说：老清单继续写 `theme`（零改动），新清单写 `themes`（可多套），二选一。 */
  if (raw.theme !== undefined && raw.themes !== undefined) {
    errors.push("contributes.theme 与 contributes.themes 不可同时声明（前者是后者长度为 1 的特例）：写其中之一即可，同时写属口径冲突");
  }
  /* 交叉校验（B5）：`toolbar_item` 的唯一用途就是「打开本插件的页面」——
     有它却没页面 ⇒ 点了没东西可开（假按钮）。fail-closed：整份拒。
     ⚠️ A-1200 · B3：`page` 已被定义为「`views` 里唯一一个 `placement:"right"` 的特例」，
     所以「本插件自己的页面」有两种声明方式：`page`（B5 老写法，零改动）或
     `views` 里带一个 `placement:"right"` 的栏目。**两者都没有**才是假按钮（仍拒）——
     若只认 `page`，「page 是 views 的特例」这句话在实践中就是假的。 */
  const hasOwnPage = out.page !== undefined || (out.views ?? []).some((v) => v.placement === "right");
  if ((out.ui ?? []).some((u) => u.slot === "toolbar_item") && !hasOwnPage) {
    errors.push("contributes.ui 含 toolbar_item 但缺少 contributes.page：该槽位的唯一用途是打开扩展自己的页面，没有 page 就是假按钮（也可改为在 contributes.views 里声明一个 placement=right 的栏目）");
  }
  /* 交叉校验（A-1200 · B3）：`page`（B5 的「一插件一页」）与 `views`（B3 的「一插件多栏目」）
     是**特例与一般**的关系（page ≡ 唯一一个 placement:"right" 的栏目）—— 同时写会让
     「用户以为生效的那一块」取决于宿主内部读哪个字段。口径冲突不猜（与 theme/themes 同款）：
     写其中之一即可。老插件继续写 `page`（零改动照常工作），新插件写 `views`。 */
  if (raw.page !== undefined && raw.views !== undefined) {
    errors.push("contributes.page 与 contributes.views 不可同时声明（前者是后者里唯一一个 placement=right 的特例）：写其中之一即可，同时写属口径冲突");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, contributes: out };
}

/**
 * 解析 `contributes.scripts`（可执行脚本声明数组）——fail-closed 全量校验：
 * name 命名与同插件内去重 / entry 必须**纯相对路径**（与 loader 的 entry 口径同款）/
 * 未知字段拒 / 上限与长度上限。**这里只校验声明**；「装不装」由信任开关决定（见 trust.ts）。
 */
export function parsePluginScripts(raw: unknown): { ok: true; scripts: PluginScriptDecl[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["contributes.scripts 必须是数组"] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ["contributes.scripts 不得为空数组（不声明就别写这个字段）"] };
  }
  if (raw.length > MAX_PLUGIN_SCRIPTS) {
    return { ok: false, errors: [`contributes.scripts 超过上限 ${MAX_PLUGIN_SCRIPTS} 条：${raw.length}`] };
  }

  const scripts: PluginScriptDecl[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `contributes.scripts[${i}]`;
    const item = raw[i];
    if (!isPlainObject(item)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    for (const field of Object.keys(item)) {
      if (!ALLOWED_SCRIPT_FIELDS.includes(field)) {
        errors.push(`${where} 含未知字段：${field}（允许的字段：${ALLOWED_SCRIPT_FIELDS.join("、")}）`);
      }
    }
    const name = item.name;
    if (typeof name !== "string" || !PLUGIN_NAME_PATTERN.test(name)) {
      errors.push(`${where}.name 缺失或不合法（须匹配 ${PLUGIN_NAME_PATTERN.source}）`);
    } else if (seen.has(name)) {
      errors.push(`${where}.name 与同插件内另一条重复：${name}`);
    } else {
      seen.add(name);
    }
    const entryRaw = item.entry;
    if (typeof entryRaw !== "string") {
      errors.push(`${where}.entry 缺失（须为纯相对路径，如 tools/run.mjs）`);
    } else {
      errors.push(...validateRelativeEntry(entryRaw).map((e) => `${where}: ${e}`));
    }
    const decl: PluginScriptDecl = {
      name: typeof name === "string" ? name : "",
      entry: typeof entryRaw === "string" ? entryRaw.trim() : "",
    };
    if (item.description !== undefined) {
      if (typeof item.description !== "string") {
        errors.push(`${where}.description 必须是字符串`);
      } else if (item.description.length > MAX_SCRIPT_DESCRIPTION) {
        errors.push(`${where}.description 过长（${item.description.length} > ${MAX_SCRIPT_DESCRIPTION}）`);
      } else if (item.description.trim() !== "") {
        decl.description = item.description.trim();
      }
    }
    scripts.push(decl);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, scripts };
}

/** 脚本声明的摘要（给 `PluginRecord.contributions` 计数用）。 */
export function describePluginScripts(scripts: PluginScriptDecl[] | undefined): string {
  return `${scripts?.length ?? 0}个`;
}

/* ── A-1197 · B5（L4a page）：扩展**自有页面** ───────────────────────────────
 * 只认 `kind: "html"`：页面经主进程的 `127.0.0.1` 静态服务加载（**绝不 `file://`**，
 * §5.4），渲染层用**沙箱 iframe**承接（跨源 + sandbox ⇒ 碰不到宿主）。
 * `kind: "webview"` 形态**暂拒**（需显式 guest preload/sandbox 配置，见 §5.4）；
 * 写了就是拒 —— 不装假插座。 */
export const PLUGIN_PAGE_KINDS = ["html"] as const;
export type PluginPageKind = (typeof PLUGIN_PAGE_KINDS)[number];

export interface PluginPageDecl {
  kind: PluginPageKind;
  /** **纯相对**入口路径（如 `panel.html`）——不许盘符、不许 `..`、不许以分隔符开头。 */
  entry: string;
}

const ALLOWED_PAGE_FIELDS: readonly string[] = ["kind", "entry"];

/** 解析 `contributes.page`（单对象，非数组）。 */
export function parsePluginPage(raw: unknown): { ok: true; page: PluginPageDecl } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["contributes.page 必须是对象"] };
  }
  const errors: string[] = [];
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_PAGE_FIELDS.includes(field)) {
      errors.push(`contributes.page 含未知字段：${field}（允许的字段：${ALLOWED_PAGE_FIELDS.join("、")}）`);
    }
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(PLUGIN_PAGE_KINDS as readonly string[]).includes(kind)) {
    errors.push(`contributes.page.kind 缺失或不合法（当前只认 ${PLUGIN_PAGE_KINDS.join(" / ")}；webview 形态需显式 guest 配置，暂未开放）`);
  }
  const entryRaw = raw.entry;
  const entryStr = typeof entryRaw === "string" ? entryRaw : "";
  if (typeof entryRaw !== "string") {
    errors.push("contributes.page.entry 缺失（须为纯相对路径，如 panel.html）");
  } else {
    errors.push(...validateRelativeEntry(entryRaw).map((e) => `contributes.page: ${e}`));
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, page: { kind: kind as PluginPageKind, entry: entryStr.trim() } };
}

/* ── A-1200 · B3：**插件自有栏目** `contributes.views` ─────────────────────────
 * 用户口径（本批灵魂，原话）：「我不是要你去开发外观市场啊，我是给你举个例子。
 * **别人甚至能自己造一个影响应用整体风格的功能栏目**，而我的 slime 只能小修小补。」
 * ⇒ 对标 DSH 的 `dsh-better-sidebar`（把文件树 + 编辑器 + 终端 + Git 面板塞成**一整块**侧栏工作台，
 *   装上后整个应用看起来像VSCode）。
 *
 * ## 与 B1 的 `ui` 的根本差别（做偏了就白做）
 *   · `ui`       = **插入点**：在宿主既有区域里放小组件 → 用户感受还是「在别人界面里加东西」。
 *   · `views`    = **整块栏目**：插件开辟自己的功能区，有独立入口与整块 UI → 「加了一整个新功能区」。
 *
 * ## 落点（`placement`，**只认这三个枚举值**，其它值一律拒）
 *   · `main`  —— 主区整块视图（主区可在「对话 / 插件视图」之间切换；切过去整块区域归它）。最接近「影响整体风格」。
 *   · `right` —— 右栏 tab（**泛化既有 `contributes.page`**：从「一插件一页」变成「一插件多 tab」）。
 *   · `left`  —— 左栏栏目块（工作区列表下方的独立栏目，可折叠）。
 *
 * ## 三条硬口径
 *   ① `entry` 的校验**照抄** `parsePluginPage` 的既有口径（`validateRelativeEntry`：纯相对、
 *      不含 `..`、不含盘符、不以分隔符开头）—— 栏目 iframe 的 src 由主进程按此拼 url，
 *      放行 `..` 就等于让栏目爬出插件目录。
 *   ② **fail-closed**：任一栏目非法 ⇒ **整份清单拒**（与本文件既有口径一致，不静默忽略单个字段）。
 *   ③ **向后兼容**：`contributes.page` 保留，语义 = `views` 里唯一一个 `placement:"right"` 的特例；
 *      两者**同写即拒**（口径冲突不猜「以哪个为准」）。既有插件（只用 `page`）零改动照常工作。 */

/** 栏目的落点（**只有三个**，其它值一律拒 —— 不给「随便写个字符串落哪儿」的口子）。 */
export const PLUGIN_VIEW_PLACEMENTS = ["main", "right", "left"] as const;
export type PluginViewPlacement = (typeof PLUGIN_VIEW_PLACEMENTS)[number];

/**
 * 单个插件最多声明多少栏目（防「一个插件塞满整屏 tab，把界面撑到没法用」）。
 * 取 8：够一个「工作站型」插件铺开主区 + 右栏 + 左栏三处，又不至于把 tab 条挤爆。
 */
export const MAX_PLUGIN_VIEWS = 8;

export interface PluginViewDecl {
  /** 同插件内唯一；跨插件冲突由宿主标`conflict`（与 ui 同款裁决）。 */
  id: string;
  /** 栏目展示名（**必填** —— 入口要显示它，留空就是「有栏目没名字」）。 */
  title: string;
  /** **纯相对**入口路径（如 `workbench.html`）—— 校验口径与 `contributes.page.entry` 同款。 */
  entry: string;
  /** 落点：主区整块视图 / 右栏 tab / 左栏栏目块（三选一，其它值拒）。 */
  placement: PluginViewPlacement;
  icon?: string;
  order?: number;
}

const ALLOWED_VIEW_FIELDS: readonly string[] = ["id", "title", "entry", "placement", "icon", "order"];

export type ParsePluginViewsResult =
  | { ok: true; views: PluginViewDecl[] }
  | { ok: false; errors: string[] };

/**
 * 解析 `contributes.views`（**数组**，一插件可多个栏目）—— fail-closed 全量校验：
 * 必须是数组 / 不得为空 / 不得超上限 / id 命名与同插件内去重 / `placement` 三选一 /
 * `title` 必填 / `entry` 走 `validateRelativeEntry`（`..`、盘符、前导分隔符全拒）/ 未知字段拒 / 长度上限。
 * **任意一条非法 ⇒ 整份拒**（绝不静默丢弃那一条 —— 丢弃即「配了但界面上看不见」＝本项目判据里的陷阱）。
 */
export function parsePluginViews(raw: unknown): ParsePluginViewsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["contributes.views 必须是数组（单栏目请用 contributes.page）"] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ["contributes.views 不得为空数组（不声明就别写这个字段）"] };
  }
  if (raw.length > MAX_PLUGIN_VIEWS) {
    return { ok: false, errors: [`contributes.views 超过上限 ${MAX_PLUGIN_VIEWS} 个栏目：${raw.length}`] };
  }

  const views: PluginViewDecl[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `contributes.views[${i}]`;
    const item = raw[i];
    if (!isPlainObject(item)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    for (const field of Object.keys(item)) {
      if (!ALLOWED_VIEW_FIELDS.includes(field)) {
        errors.push(`${where} 含未知字段：${field}（允许的字段：${ALLOWED_VIEW_FIELDS.join("、")}）`);
      }
    }

    const id = item.id;
    if (typeof id !== "string" || !PLUGIN_NAME_PATTERN.test(id)) {
      errors.push(`${where}.id 缺失或不合法（须匹配 ${PLUGIN_NAME_PATTERN.source}）`);
    } else if (seen.has(id)) {
      errors.push(`${where}.id 与同插件内另一个栏目重复：${id}`);
    } else {
      seen.add(id);
    }

    const title = item.title;
    if (typeof title !== "string" || title.trim() === "") {
      errors.push(`${where}.title 缺失或为空（栏目要有展示名：入口要显示它）`);
    } else if (title.length > MAX_UI_TITLE) {
      errors.push(`${where}.title 过长（${title.length} > ${MAX_UI_TITLE}）`);
    }

    /* placement：只认 main / right / left。**没有第四个值**，也没有「缺省落点」
       —— 缺省必须是错（否则「忘了写 placement」会静默落到某个默认位置，
       而那个位置可能压根没接线 ⇒ 声明了看不见）。 */
    const placementRaw = item.placement;
    const placementOk = typeof placementRaw === "string" && (PLUGIN_VIEW_PLACEMENTS as readonly string[]).includes(placementRaw);
    if (!placementOk) {
      errors.push(`${where}.placement 缺失或不合法（须为 ${PLUGIN_VIEW_PLACEMENTS.join(" / ")}）`);
    }

    /* entry：与 `contributes.page.entry` **同一条判据**（validateRelativeEntry）——
       两处不许各写一套（栏目的 src 与 page 一样会拼进 127.0.0.1 服务的 url）。 */
    const entryRaw = item.entry;
    if (typeof entryRaw !== "string") {
      errors.push(`${where}.entry 缺失（须为纯相对路径，如 workbench.html）`);
    } else {
      errors.push(...validateRelativeEntry(entryRaw).map((e) => `${where}: ${e}`));
    }

    const decl: PluginViewDecl = {
      id: typeof id === "string" ? id : "",
      title: typeof title === "string" ? title.trim() : "",
      entry: typeof entryRaw === "string" ? entryRaw.trim() : "",
      placement: (placementOk ? placementRaw : "main") as PluginViewPlacement,
    };

    if (item.icon !== undefined) {
      if (typeof item.icon !== "string" || item.icon.trim() === "") {
        errors.push(`${where}.icon 必须是非空字符串`);
      } else if (item.icon.length > MAX_UI_ICON) {
        errors.push(`${where}.icon 过长（${item.icon.length} > ${MAX_UI_ICON}）`);
      } else {
        decl.icon = item.icon.trim();
      }
    }
    if (item.order !== undefined) {
      if (typeof item.order !== "number" || !Number.isFinite(item.order)) {
        errors.push(`${where}.order 必须是有限数值`);
      } else {
        decl.order = item.order;
      }
    }

    views.push(decl);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, views };
}

/** 栏目声明的摘要（给 `PluginRecord.contributions` 计数用，让扩展页一眼看出「给了几个栏目、落在哪」）。 */
export function describePluginViews(views: PluginViewDecl[] | undefined): string {
  if (!views || views.length === 0) { return "0个"; }
  const byPlacement = new Map<string, number>();
  for (const v of views) {
    byPlacement.set(v.placement, (byPlacement.get(v.placement) ?? 0) + 1);
  }
  return `${views.length}个（${[...byPlacement.entries()].map(([p, n]) => `${p}×${n}`).join("/")}）`;
}

/**
 * A-1200 · B3：**栏目 → 落点** 的登记形状（主进程运行期表与渲染层快照共用这一份）。
 *
 * ## 为什么宿主要维护这张表而不是渲染层现拉清单
 * 渲染层拿不到「插件目录 ↔ 静态服务基址」的映射（那是主进程的越权防护点，见 `pluginCssAssetBases`
 * 的同款理由）。所以：主进程在 `registerViews` 里把**已接线**插件的栏目登记进表，
 * 渲染层只按快照渲染、要 url 时调 `plugins_view_open`（与 `plugins_panel_open` 同款底子）。
 * 被卸载/停用/rejected 的插件不在表里 ⇒ 快照里自然没有它的栏目（不留幽灵）。
 */
export interface PluginViewDTO {
  plugin: string;
  id: string;
  title: string;
  /** **纯相对**入口（清单层已 fail-closed 校验过 `..`/盘符/前导分隔符）。
   *  渲染层**不自己拼 url** —— 调 `plugins_view_open` 由主进程起服务并给出绝对 url。 */
  entry: string;
  placement: PluginViewPlacement;
  icon?: string;
  order?: number;
  /** 跨插件「同 placement 同 id」冲突时标 true（渲染成禁用态，不静默丢弃）。 */
  conflict?: boolean;
}

/**
 * 解析 `contributes.ui`（UI 槽位声明数组）——fail-closed 全量校验：
 * 槽位白名单 / id 命名与同插件内去重 / 按槽位分支校验必填字段（`settings_panel` 要 `title`，
 * 其余要 `label`；`status_item` 还要枚举 `refresh`）/ 槽位专属字段错配（如给 `status_item`
 * 写 `title`）一律拒 / 未知字段拒 / 上限与长度上限。
 */
export function parsePluginUiSlots(raw: unknown): { ok: true; ui: PluginUiContribution[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["contributes.ui 必须是数组"] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ["contributes.ui 不得为空数组（不声明就别写这个字段）"] };
  }
  if (raw.length > MAX_PLUGIN_UI_SLOTS) {
    return { ok: false, errors: [`contributes.ui 超过上限 ${MAX_PLUGIN_UI_SLOTS} 条：${raw.length}`] };
  }

  const ui: PluginUiContribution[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `contributes.ui[${i}]`;
    const item = raw[i];
    if (!isPlainObject(item)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    for (const field of Object.keys(item)) {
      if (!ALLOWED_UI_FIELDS.includes(field)) {
        errors.push(`${where} 含未知字段：${field}（允许的字段：${ALLOWED_UI_FIELDS.join("、")}）`);
      }
    }

    const slotRaw = item.slot;
    const slotOk = typeof slotRaw === "string" && (PLUGIN_UI_SLOTS as readonly string[]).includes(slotRaw);
    if (!slotOk) {
      errors.push(`${where}.slot 缺失或不合法（须为 ${PLUGIN_UI_SLOTS.join(" / ")}）`);
    }

    const id = item.id;
    if (typeof id !== "string" || !PLUGIN_NAME_PATTERN.test(id)) {
      errors.push(`${where}.id 缺失或不合法（须匹配 ${PLUGIN_NAME_PATTERN.source}）`);
    } else if (seen.has(id)) {
      errors.push(`${where}.id 与同插件内另一条重复：${id}`);
    } else {
      seen.add(id);
    }

    const decl: PluginUiContribution = {
      slot: (slotOk ? slotRaw : "settings_panel") as PluginUiRegion,
      id: typeof id === "string" ? id : "",
    };

    /* ---- A-1200 · B1：形态（缺省 item）+ entry 的对称校验 + 形态-区域兼容 ----
       顺序刻意是「先认 kind、再按形态分派字段」：kind 不认识时下面的分支一律按 item 走，
       而 errors 非空 ⇒ 整份拒（fail-closed），所以「猜错分支」不会变成放行。 */
    const kindRaw = item.kind;
    let kind: PluginUiKind = "item";
    if (kindRaw !== undefined) {
      if (typeof kindRaw !== "string" || !(PLUGIN_UI_KINDS as readonly string[]).includes(kindRaw)) {
        errors.push(`${where}.kind 缺失或不合法（须为 ${PLUGIN_UI_KINDS.join(" / ")}）`);
      } else {
        kind = kindRaw as PluginUiKind;
      }
    }
    if (slotOk) {
      /* ⚠️ 判据用**解析后的 kind**（缺省 = item），不是原始 `item.kind`：
         若按原始值判，「不写 kind + 落在只收 panel 的区域」会被整段跳过 ⇒ overlay_* 的
         item 声明就能混过清单（而界面上那个区域只渲染 panel ⇒ 声明了永远看不见）。
         那个洞是本条判据本身要防的东西，不能自己漏。 */
      const allowed = (PLUGIN_UI_REGION_KINDS as Record<string, readonly PluginUiKind[]>)[slotRaw as string] ?? [];
      if (!allowed.includes(kind)) {
        errors.push(`${where}：区域 ${slotRaw} 不接受形态 ${kind}（该区域只接受 ${allowed.join(" / ")}）`);
      }
    }
    if (kind === "panel") {
      decl.kind = "panel";
    }

    /* ---- entry：panel 必填且纯相对；item 必须**不存在**（对称校验） ----
       两个方向都要拒：panel 缺 entry = 起不了服务（假声明）；item 写了 entry = 声明了没人用。 */
    const entryRaw = item.entry;
    if (kind === "panel") {
      if (typeof entryRaw !== "string") {
        errors.push(`${where}.entry 对 kind=panel 是必填（须为纯相对路径，如 panel.html）`);
      } else {
        errors.push(...validateRelativeEntry(entryRaw).map((e) => `${where}: ${e}`));
        decl.entry = entryRaw.trim();
      }
    } else if (entryRaw !== undefined) {
      errors.push(`${where}.entry 只对 kind=panel 有意义（当前形态 ${kind}）`);
    }

    /* ---- 按形态与槽位分支：panel 只要可选文案；item 沿用「settings_panel 用 title、其余用 label」 ---- */
    if (kind === "panel") {
      /* panel 的界面由扩展自己画 ⇒ label/title 都不是必填（但给了就当面板标题用，仍走长度上限）。
         refresh / when 描述的是**宿主行为**（手动刷新、显示条件），panel 一概用不到 ⇒ 拒，
         不做「留着吧反正不用」的静默放行。 */
      for (const field of ["title", "label"] as const) {
        const v = item[field];
        if (v === undefined) { continue; }
        if (typeof v !== "string") {
          errors.push(`${where}.${field} 必须是字符串`);
        } else if (v.length > MAX_UI_TITLE) {
          errors.push(`${where}.${field} 过长（${v.length} > ${MAX_UI_TITLE}）`);
        } else if (v.trim() !== "") {
          decl[field] = v.trim();
        }
      }
      if (item.refresh !== undefined) { errors.push(`${where}.refresh 对 kind=panel 无意义`); }
      if (item.when !== undefined) { errors.push(`${where}.when 对 kind=panel 无意义`); }
    } else if (slotRaw === "settings_panel") {
      const title = item.title;
      if (typeof title !== "string" || title.trim() === "") {
        errors.push(`${where}.title 对 settings_panel 是必填`);
      } else if (title.length > MAX_UI_TITLE) {
        errors.push(`${where}.title 过长（${title.length} > ${MAX_UI_TITLE}）`);
      } else {
        decl.title = title.trim();
      }
      if (item.label !== undefined) { errors.push(`${where}.label 对 settings_panel 无意义（该槽位用 title）`); }
      if (item.refresh !== undefined) { errors.push(`${where}.refresh 对 settings_panel 无意义`); }
    } else {
      const label = item.label;
      if (typeof label !== "string" || label.trim() === "") {
        errors.push(`${where}.label 对 ${String(slotRaw)} 是必填`);
      } else if (label.length > MAX_UI_TITLE) {
        errors.push(`${where}.label 过长（${label.length} > ${MAX_UI_TITLE}）`);
      } else {
        decl.label = label.trim();
      }
      if (item.title !== undefined) { errors.push(`${where}.title 对 ${String(slotRaw)} 无意义（该槽位用 label）`); }

      if (slotRaw === "status_item") {
        if (!(PLUGIN_UI_REFRESH as readonly string[]).includes(String(item.refresh))) {
          errors.push(`${where}.refresh 对 status_item 是必填（须为 ${PLUGIN_UI_REFRESH.join(" / ")}）`);
        } else {
          decl.refresh = item.refresh as PluginUiRefresh;
        }
      } else if (item.refresh !== undefined) {
        errors.push(`${where}.refresh 对 ${String(slotRaw)} 无意义`);
      }

      if (slotRaw === "chat_action") {
        if (item.when !== undefined) {
          if (typeof item.when !== "string") {
            errors.push(`${where}.when 必须是字符串`);
          } else if (item.when.trim() !== "") {
            decl.when = item.when.trim();
          }
        }
      } else if (item.when !== undefined) {
        errors.push(`${where}.when 对 ${String(slotRaw)} 无意义`);
      }
    }

    if (item.icon !== undefined) {
      if (typeof item.icon !== "string" || item.icon.trim() === "") {
        errors.push(`${where}.icon 必须是非空字符串`);
      } else if (item.icon.length > MAX_UI_ICON) {
        errors.push(`${where}.icon 过长（${item.icon.length} > ${MAX_UI_ICON}）`);
      } else {
        decl.icon = item.icon.trim();
      }
    }
    if (item.order !== undefined) {
      if (typeof item.order !== "number" || !Number.isFinite(item.order)) {
        errors.push(`${where}.order 必须是有限数值`);
      } else {
        decl.order = item.order;
      }
    }

    ui.push(decl);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, ui };
}

/** UI 槽位声明的摘要（给 `PluginRecord.contributions` 计数用）。
 *  A-1200 · B1：panel 形态按「区域×2」计数，让扩展页一眼看出「几条是自带 UI 的」。 */
export function describePluginUi(ui: PluginUiContribution[] | undefined): string {
  if (!ui || ui.length === 0) { return "0条"; }
  const bySlot = new Map<string, number>();
  for (const item of ui) {
    const key = item.kind === "panel" ? `${item.slot}(panel)` : item.slot;
    bySlot.set(key, (bySlot.get(key) ?? 0) + 1);
  }
  return [...bySlot.entries()].map(([slot, n]) => `${slot}×${n}`).join("/");
}

/** 声明项的摘要（给 `PluginRecord.contributions` 计数用，不含任何取值）。 */
export function describePluginSettings(settings: PluginSettingDecl[] | undefined): string {
  return `${settings?.length ?? 0}项`;
}

/* ── A-1198 · 主题贡献点（theme）：声明式「皮肤」───────────────────────────────
 * 用户口径：扩展是「外部武装 / 精装」——可开可关、不改程序本身。主题是这套口径在**外观**上的
 * 延伸：插件只**声明一组白名单设计令牌**（design tokens），由宿主校验后应用到全局 CSS 变量；
 * **没有任何扩展 CSS / JSX 进入宿主样式表**（红线不变 —— 设计 §4.4 说「扩展不能贡献 CSS」，
 * 本机制是「宿主渲染器 + 声明」在颜色维度上的等价物：宿主负责落值，插件只报期望）。
 *
 * 令牌是**白名单**且值形态受限（颜色只收 hex、字体与圆角只收枚举）：
 * 拿不到任意 CSS 值，就顺手拿不到「用样式做坏事」的面（外联 url()、表达式、@import 皆不可能）。
 */

/** 色彩令牌 → CSS 变量的**单一产地**（渲染层按它落值；守卫按它核对 index.css 里的真变量名）。 */
export const PLUGIN_THEME_COLOR_VARS = {
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSoft: "--accent-soft",
  bg: "--bg",
  bgSecondary: "--bg-secondary",
  bgCard: "--bg-card",
  bgInput: "--bg-input",
  bgHover: "--bg-hover",
  border: "--border",
  text: "--text",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
} as const;

export type PluginThemeColorToken = keyof typeof PLUGIN_THEME_COLOR_VARS;

/** 字体族令牌（枚举 ⇒ 预置字体栈；不收任意字符串 —— 不收就是最强的注入防护）。 */
export const PLUGIN_THEME_FONT_STACKS = {
  system: "\"Microsoft YaHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  serif: "Georgia, \"Times New Roman\", \"Songti SC\", \"SimSun\", serif",
  mono: "Consolas, \"Cascadia Mono\", \"Cascadia Code\", Menlo, monospace",
} as const;

export type PluginThemeFontToken = keyof typeof PLUGIN_THEME_FONT_STACKS;

/** 圆角令牌（枚举 ⇒ 预置尺度；覆盖 `--radius-*` 四个变量）。 */
export const PLUGIN_THEME_RADIUS_SCALES = {
  default: { lg: "12px", md: "10px", sm: "6px", bubble: "16px" },
  round: { lg: "16px", md: "14px", sm: "10px", bubble: "20px" },
  sharp: { lg: "6px", md: "5px", sm: "3px", bubble: "8px" },
} as const;

export type PluginThemeRadiusToken = keyof typeof PLUGIN_THEME_RADIUS_SCALES;

/** 令牌集：色彩（hex）+ `font` / `radius`（枚举）。 */
export type PluginThemeTokens = Partial<Record<PluginThemeColorToken, string>> & {
  font?: PluginThemeFontToken;
  radius?: PluginThemeRadiusToken;
};

export interface PluginThemeDecl {
  /** 皮肤展示名（「外观」页的可选项）。 */
  name: string;
  tokens: PluginThemeTokens;
}

export const MAX_THEME_NAME = 24;

/** 颜色令牌的合法形态：只收 `#RRGGBB` / `#RRGGBBAA`。 */
export const PLUGIN_THEME_HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

const ALLOWED_THEME_FIELDS: readonly string[] = ["name", "tokens"];

const THEME_TOKEN_KEYS: readonly string[] = [...Object.keys(PLUGIN_THEME_COLOR_VARS), "font", "radius"];

/**
 * A-1200 · B2：单个插件最多声明多少套皮肤（`contributes.themes` 的数组上限）。
 * 取 16 是对标 DSH 的 `dsh-theme-gallery`（一次 12 套）并留一点余量；
 * 同时也是一道防「一个插件塞几百套把外观页撑爆 / 主进程登记表膨胀」的闸。
 */
export const MAX_PLUGIN_THEMES = 16;

/**
 * 解析 `contributes.themes`（**数组**，A-1200 · B2）。
 *
 * ## 判据全部复用 `parsePluginTheme`（不另写一套）
 * 每套皮肤**逐条**交给 `parsePluginTheme` 判 —— 白名单令牌/hex/枚举/未知字段/长度上限
 * 全部同款判据。理由：本项目最忌「声明层与校验层两套口径」，一旦分叉就会出现
 * 「A 处放行、B 处拒绝」的幽灵皮肤。
 *
 * ## 本函数**额外**只管三件数组级的事（单套管不了的）
 *   ① 必须是数组、**不得为空**（不声明就别写这个字段）、**不得超上限**；
 *   ② 同插件内**皮肤名不得重复** —— 否则外观页出现两个同名选项，用户分不清自己选的是哪一套；
 *   ③ **任意一套非法 ⇒ 整份拒**（fail-closed，与 settings/ui/themes 同款：绝不静默丢弃那一套）。
 *
 * ## 为什么不「逐套尽力解析」
 * 静默丢弃一套坏皮肤 = 用户在外观页看到 11 套而不是 12 套，且**没有任何提示** ——
 * 这正是本项目的判据「能配但没生效 = 陷阱」。
 */
export function parsePluginThemes(raw: unknown): { ok: true; themes: PluginThemeDecl[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["contributes.themes 必须是数组（单套皮肤请用 contributes.theme）"] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ["contributes.themes 不得为空数组（不声明就别写这个字段）"] };
  }
  if (raw.length > MAX_PLUGIN_THEMES) {
    return { ok: false, errors: [`contributes.themes 超过上限 ${MAX_PLUGIN_THEMES} 套：${raw.length}`] };
  }
  const themes: PluginThemeDecl[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `contributes.themes[${i}]`;
    const parsed = parsePluginTheme(raw[i]);
    if (!parsed.ok) {
      /* 复用单套判据，但错误前缀改成本数组的下标（否则报错指向 contributes.theme，
         而清单里根本没有那个字段 ⇒ 用户查不到是哪一套坏了）。 */
      for (const e of parsed.errors) { errors.push(`${where}: ${e}`); }
      continue;
    }
    const name = parsed.theme.name;
    if (seen.has(name)) {
      errors.push(`${where}.name 与同插件内另一套皮肤重复：${name}（外观页会出现两个同名选项，用户分不清）`);
      continue;
    }
    seen.add(name);
    themes.push(parsed.theme);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, themes };
}

/**
 * 解析 `contributes.theme`（单对象）。fail-closed 全量校验：
 * 未知字段 / name 缺失或超长 / tokens 非对象或空 / 未知令牌键 / 颜色非 hex / 枚举越界 —— 一律拒。
 */
export function parsePluginTheme(raw: unknown): { ok: true; theme: PluginThemeDecl } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["contributes.theme 必须是对象"] };
  }
  const errors: string[] = [];
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_THEME_FIELDS.includes(field)) {
      errors.push(`contributes.theme 含未知字段：${field}（允许的字段：${ALLOWED_THEME_FIELDS.join("、")}）`);
    }
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    errors.push("contributes.theme.name 缺失或为空（皮肤要有展示名）");
  } else if (name.length > MAX_THEME_NAME) {
    errors.push(`contributes.theme.name 过长（${name.length} > ${MAX_THEME_NAME}）`);
  }

  let tokens: PluginThemeTokens | undefined;
  if (!isPlainObject(raw.tokens)) {
    errors.push("contributes.theme.tokens 必须是对象（至少 1 个令牌）");
  } else {
    const t: Record<string, string> = {};
    const keys = Object.keys(raw.tokens);
    if (keys.length === 0) {
      errors.push("contributes.theme.tokens 不得为空对象（不声明就别写 theme）");
    }
    for (const key of keys) {
      const value = raw.tokens[key];
      if (!THEME_TOKEN_KEYS.includes(key)) {
        errors.push(`contributes.theme.tokens 含未知令牌：${key}（允许：${THEME_TOKEN_KEYS.join("、")}）`);
        continue;
      }
      if (key === "font" || key === "radius") {
        const allowed: readonly string[] = key === "font"
          ? Object.keys(PLUGIN_THEME_FONT_STACKS)
          : Object.keys(PLUGIN_THEME_RADIUS_SCALES);
        if (typeof value !== "string" || !allowed.includes(value)) {
          errors.push(`contributes.theme.tokens.${key} 必须是枚举值 ${allowed.join(" / ")}（收到：${JSON.stringify(value)}）`);
          continue;
        }
        t[key] = value;
        continue;
      }
      /* 颜色令牌：只收 hex（不收 rgb()/var()/命名色/url() —— 白名单外一律拒）。 */
      if (typeof value !== "string" || !PLUGIN_THEME_HEX_RE.test(value)) {
        errors.push(`contributes.theme.tokens.${key} 必须是 #RRGGBB 或 #RRGGBBAA 十六进制色（收到：${JSON.stringify(value)}）`);
        continue;
      }
      t[key] = value;
    }
    if (Object.keys(t).length > 0) {
      tokens = t as PluginThemeTokens;
    }
  }
  if (errors.length > 0 || tokens === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ["contributes.theme.tokens 解析为空"] };
  }
  return { ok: true, theme: { name, tokens } };
}

/**
 * 把声明展开成「CSS 变量 → 值」的落值计划（**纯函数**，单一产地）：
 * 渲染层照此 `setProperty`，守卫照此核对「令牌 ↔ 真变量」。枚举令牌在这里展开成预置值。
 */
export function themeTokenAssignments(theme: PluginThemeDecl): Array<{ variable: string; value: string }> {
  const out: Array<{ variable: string; value: string }> = [];
  for (const [token, value] of Object.entries(theme.tokens)) {
    if (token === "font") {
      out.push({ variable: "--font-ui", value: PLUGIN_THEME_FONT_STACKS[value as PluginThemeFontToken] });
      continue;
    }
    if (token === "radius") {
      const scale = PLUGIN_THEME_RADIUS_SCALES[value as PluginThemeRadiusToken];
      out.push(
        { variable: "--radius-lg", value: scale.lg },
        { variable: "--radius-md", value: scale.md },
        { variable: "--radius-sm", value: scale.sm },
        { variable: "--radius-bubble", value: scale.bubble },
      );
      continue;
    }
    out.push({ variable: PLUGIN_THEME_COLOR_VARS[token as PluginThemeColorToken], value: String(value) });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// A-1198 · 续：CSS 贡献点（contributes.css）—— 用户口径「把CSS 修改权限全面放开，
//通过插件来进行开关可控的改动」。
//
// ## 为什么这次敢放开（与"红线"的关系）
// 之前的禁令针对的是「远程插件包 / 不可信来源」。用户本轮明确：插件是**他自己装、自己开关**的，
// 换配色换布局属于"用插件武装"而不是"改穿程序本身"。⇒ 放开 `contributes.css`，但：
//
// ## 护栏一：@layer（这是技术性必需，不是安全说教）
// slime 有**安全关键的 HTML 渲染 UI**：权限请求弹窗（git commit 门禁、diff 评审、脚本执行确认）
// 走 JSX +宿主页CSS。CSS 全权在层内若直接生效，`#f00{display:none}` 就能把「允许/拒绝」藏掉，
// 让误操作默认通过 —— 那是**功能性失效**，不是难看。
// 解法用 CSS 原生层叠：`@layer slime-host, slime-plugin;` 声明顺序 ⇒ 插件层永远**低于**宿主层，
// 无论插件写多强的选择器都盖不掉宿主的安全关键 UI；其他地方则完全自由。
//
// ## 护栏二：fail-closed 的静态禁令（收窄而非放开）
// 允许「改外观」，但**禁止**这几类能自我扩权或外联的动作 —— 它们不是外观，是侧信道：
//   · `@import` —— 外联 = 把用户数据发出去 / 引入远程代码（外观不需要外联）；
//   · `!important` —— 有了 @layer 也不需要它就能覆盖宿主非关键 UI；留着是**绕过层叠的旁门**；
//   · 全局 `*` / `html` / `body` / `:root` —— 能改根字号/根背景 = 事实上的"接管全站"，
//     且能藏掉宿主自身的安全提示样式；定位作用域改用 `.slime-plugin-scope` 前缀类；
//   · `position: fixed` —— 固定定位能盖住安全关键 UI（不依赖层叠就能视觉遮蔽）。
// 这四条是**列举式**的：没列到的属性随便写（布局、间距、字号、边框、动画、字体…）。
//
// ### `url()` 的口径（A-1200 · B2 起变了；理由见下方 `PLUGIN_ASSET_SCHEME` 节注）
// 原来是「`url(` 一律拒」；B2 起**只放行 `url(plugin-asset:<纯相对路径>)`** 这一种形态
// （皮肤要能有壁纸/背景图，否则外观市场是空的），其余 `url(...)` 形态**仍全拒**——
// 外观不需要外联，放开外联等于开一个数据外泄面。
//
// 作用域约定：宿主渲染层给 <html> 挂 `.slime-plugin-scope` 类（有生效 CSS 时挂上），
// 插件 CSS 里的选择器**自动**被限制在该类之下（见 scopePluginCss）——
// 不强制插件作者每条都写前缀（那样太难用），但也不会波及 iframe 内的扩展页面。
export interface PluginCssDecl {
  /** 展示名（去重/选择器用）。 */
  name: string;
  /** 纯 CSS 文本（已 fail-closed 校验）。 */
  css: string;
}

/** 展示名长度上限（会回传渲染层并进下拉框）。 */
export const MAX_PLUGIN_CSS_NAME = 24;
/** 单份 CSS 字节上限（防「一个插件塞 2MB 样式把渲染层卡死」）。 */
export const MAX_PLUGIN_CSS_BYTES = 128 * 1024;

const ALLOWED_CSS_FIELDS: readonly string[] = ["name", "css"];

/* ── A-1200 · B2：皮肤资源（壁纸 / 背景图）—— `url(plugin-asset:<相对路径>)` ──────
 * ## 为什么放开这一种（且**只有**这一种）
 * 之前的禁令是 `url(` 一律拒（防外联）。但用户口径要的是 DSH 那种「全屏覆盖 + 壁纸」，
 * 而**没有图片的皮肤市场等于没有**（纯色/边框能做的有限）。
 * ⇒ 放开**唯一一种**形态：`url(plugin-asset:bg.png)`。
 *
 * ## `plugin-asset:` 是什么
 * 它是**宿主自造的协议前缀，不是真 URL**：不会去解析、不会去联网络，
 * 宿主在校验通过后把它**改写**成该插件目录经`127.0.0.1` 静态服务后的真实地址
 * （与 `contributes.page` / B1 的 panel 同一套 `httpServer.serve` 机制）。
 * 也就是说：插件写的是「我目录里的这张图」，不是「互联网上那张图」。
 *
 * ## 为什么其余一切 `url(...)` 仍然拒
 * 外观**不需要外联**。一旦放行 `http(s)://` / `//` / `data:` / 裸相对路径，就等于给了插件
 * 一个数据外泄面（用户在对话框里输入的内容、剪贴板，都能被 `url()` 带出去）——
 * 那是**安全面的扩大**，不是外观自由度。所以白名单精确到**一种形态**而不是「图片类 URL」。
 *
 * ## 路径口径
 * 路径必须是**纯相对**（不含 `..` / 不含盘符 / 不以分隔符开头）——照抄
 * `validateRelativeEntry`（`contributes.page.entry` 与 B1 panel 的 entry 共用同一份判据）。
 * 理由同上：改写后的地址若能爬出插件目录，就等于跨插件/跨目录读文件 = 越权。*/

/** 资源协议前缀（宿主自造，非真URL；见上方节注）。 */
export const PLUGIN_ASSET_SCHEME = "plugin-asset";

/**
 * 取出一段 CSS 里的所有 `url(...)` 参数（**纯函数**，守卫与实现同判据）。
 * 只做「原样截取 + 去引号 + trim」，不做任何放行判断（放行判据在 `findPluginCssViolations`）。
 */
export function extractPluginCssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) { out.push(m[2].trim()); }
  return out;
}

/** 判断一段 `url(...)` 取值是不是「合法的插件内资源引用」（纯函数，可单测）。 */
export function isAllowedPluginAssetUrl(value: string): { ok: true; path: string } | { ok: false; why: string } {
  const raw = value.trim();
  if (!raw) { return { ok: false, why: "url() 取值为空" }; }
  const prefix = `${PLUGIN_ASSET_SCHEME}:`;
  if (!raw.toLowerCase().startsWith(prefix)) {
    /* ⚠️ 这里**必须**把「形态不符」与「路径不合法」分开说：前者是「你该用 plugin-asset:」，
       后者是「你的路径会爬出目录」—— 两者的修法完全不同，混成一句话会让用户瞎改。 */
    return {
      ok: false,
      why: `url() 只允许插件目录内的相对资源，形如 url(${prefix}bg.png)（外观不需要外联：http(s)://、//、data:、裸相对路径一律拒）`,
    };
  }
  const path = raw.slice(prefix.length).trim();
  if (path === "") { return { ok: false, why: `url(${prefix}) 缺少资源路径` }; }
  /* ⚠️ 复用 `validateRelativeEntry`（纯相对口径的**单一产地**，page.entry / panel.entry 同款）。
     它的错误文案以 "entry " 开头，这里换成资源语义再返回，避免用户看到「entry」却无处可查。 */
  const errors = validateRelativeEntry(path).map((e) => e.replace(/^entry /, "资源路径 "));
  if (errors.length > 0) { return { ok: false, why: `url(${prefix}${path}) 不合法：${errors.join("；")}` }; }
  return { ok: true, path };
}

/**
 * 静态禁令：命中即**整份拒**（fail-closed，与 theme/settings 同款）。
 * 逐条正则都刻意收紧（选择器部分只允许 `.xxx`/标签名，避免 `a[href^=http]` 这类外联触发器）。
 *
 * ⚠️ A-1200 · B2：`url(` **不再**是静态禁令里的一条（改由 `checkPluginAssetUrls` 判）——
 * 放开的是 `url(plugin-asset:<纯相对>)` 这一种形态，其余 `url(...)` 仍全拒。
 * 为什么单独判而不在这里用一条正则：形态判据需要**逐个参数**校验（取协议前缀、查路径是否纯相对），
 * 一条正则表达不了「只放过一种形态」，而「哪种形态被放过」正是本条不变量本身。
 */
const CSS_FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /@import/i, why: "@import（外联/引入远程样式）" },
  { re: /@charset/i, why: "@charset" },
  { re: /@namespace/i, why: "@namespace" },
  { re: /expression\s*\(/i, why: "expression()（IE 动态表达式）" },
  { re: /-moz-binding/i, why: "-moz-binding（XBL 绑定）" },
  { re: /!\s*important/i, why: "!important（绕过层叠的旁门）" },
  { re: /javascript\s*:/i, why: "javascript: 协议" },
  { re: /behaviou?r\s*:/i, why: "behavior（IE 行为绑定）" },
  { re: /<\/?[a-z]/i, why: "HTML 标签文本（CSS 里出现标签名 = 混入非样式内容）" },
  { re: /position\s*:\s*fixed/i, why: "position:fixed（能盖住安全关键 UI，不依赖层叠就能遮蔽）" },
  { re: /(?:^|[^.\w-])(?:\*|html|body|:root)\s*(?=[,{.#:\[])/im, why: "全局选择器（* / html / body / :root —— 能接管全站并藏掉宿主安全提示）" },
  { re: /@font-face/i, why: "@font-face（自定义字体文件 = 外部资源加载；字体族走 contributes.theme 的枚举令牌）" },
  { re: /@keyframes/i, why: "@keyframes（动画名不是选择器，作用域改写会连引用一起坏掉；外观请用 transition/变量过渡）" },
  { re: /@media/i, why: "@media（媒体查询块的选择器同样会被作用域改写，改写规则尚未覆盖嵌套块）" },
  { re: /@supports/i, why: "@supports（同上：嵌套块的作用域改写未覆盖）" },
];

/**
 * `url(...)` 的逐个参数判据（A-1200 · B2）—— 唯一放行的形态是 `url(plugin-asset:<纯相对>)`。
 * 导出以便渲染层与守卫复用同一判据（不许两套口径）。
 */
export function checkPluginAssetUrls(css: string): string[] {
  const out: string[] = [];
  for (const value of extractPluginCssUrls(css)) {
    const r = isAllowedPluginAssetUrl(value);
    if (!r.ok) { out.push(`url() 被拒：${r.why}`); }
  }
  return [...new Set(out)];
}

/** 判断某段 CSS 是否命中禁令（导出以便渲染层/守卫复用同一判据）。 */
export function findPluginCssViolations(css: string): string[] {
  const out: string[] = [];
  for (const rule of CSS_FORBIDDEN) {
    if (rule.re.test(css)) { out.push(rule.why); }
  }
  out.push(...checkPluginAssetUrls(css));
  return [...new Set(out)];
}

/**
 * 解析 `contributes.css`（单对象）。fail-closed 全量校验：
 * 非对象 / 未知字段 / name 缺失或超长 / css 缺失或非字符串 / 超字节上限 /
 * 命中任一静态禁令⇒ 整份拒。
 */
export function parsePluginCss(raw: unknown): { ok: true; css: PluginCssDecl } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["contributes.css 必须是对象"] };
  }
  const errors: string[] = [];
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_CSS_FIELDS.includes(field)) {
      errors.push(`contributes.css 含未知字段：${field}（允许的字段：${ALLOWED_CSS_FIELDS.join("、")}）`);
    }
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    errors.push("contributes.css.name 缺失或为空（这套外观要有展示名）");
  } else if (name.length > MAX_PLUGIN_CSS_NAME) {
    errors.push(`contributes.css.name 过长（${name.length} > ${MAX_PLUGIN_CSS_NAME}）`);
  }
  const css = typeof raw.css === "string" ? raw.css : "";
  if (!css.trim()) {
    errors.push("contributes.css.css 缺失或为空（不声明就别写 css）");
  } else if (Buffer.byteLength(css, "utf8") > MAX_PLUGIN_CSS_BYTES) {
    errors.push(`contributes.css.css 过大（${Buffer.byteLength(css, "utf8")} > ${MAX_PLUGIN_CSS_BYTES} 字节）`);
  } else {
    for (const why of findPluginCssViolations(css)) {
      errors.push(`contributes.css.css 被拒：${why}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, css: { name, css } };
}

/**
 * A-1200 · B2：**宿主侧**把 `url(plugin-asset:<相对路径>)` 改写成该插件目录的真实服务地址
 *（**纯函数**，可单测；守卫与实现同判据）。
 *
 * ## 为什么必须改写（以及为什么只能在宿主侧）
 * `plugin-asset:` 不是浏览器认识的协议 —— 不改写就是一张**永远 404 的图**，
 * 而「皮肤有图但看不见」比「皮肤没图」更坏（用户查不出原因）。所以宿主在落值前把它换成
 * 该插件目录经 `httpServer.serve({dir, host:"127.0.0.1"})` 得到的真实地址
 * （**与 `contributes.page` / B1 的 panel 同一套机制** —— 同一个静态服务，不新增第二个出口）。
 *
 * ## 边界（两条，都是安全不变量）
 *   ① **只改写本插件自己的资源**：`baseUrl` 由主进程按 `dirs.get(插件名)` 注入，
 *     跨插件读文件 = 越权，主进程那条通道就不给别的目录（守卫钉住「url 来自该插件的 dir」）。
 *   ② **资源文件不存在 ⇒ 如实回退**（返回 `null`）：把该 `url()` **整段删掉**，
 *     宁可少一张图，也不留一个指向 404 的地址（静默留 404 = 又一个"说了不算"）。
 *
 * @param baseUrl 该插件目录静态服务的基址（如 `http://127.0.0.1:52341/`，**必须**已带尾斜杠）
 * @param exists  宿主注入的「该插件目录内是否存在这个文件」判据（测试传替身；生产用 fs.existsSync）
 */
export function rewritePluginAssetUrls(
  css: string,
  baseUrl: string,
  exists: (relativePath: string) => boolean,
): string {
  const prefix = `${PLUGIN_ASSET_SCHEME}:`;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return css.replace(
    /url\s*\(\s*(['"]?)plugin-asset:([^'")]*)\1\s*\)/gi,
    (_whole: string, _quote: string, rawPath: string) => {
      const path = rawPath.trim();
      const judged = isAllowedPluginAssetUrl(`${prefix}${path}`);
      if (!judged.ok) { return ""; }
      /* ⚠️ 文件不存在 ⇒ 整段删掉（而不是留一个 404 的 url）。理由见上方节注②。 */
      if (!exists(judged.path)) { return ""; }
      return `url("${base}${judged.path.replace(/\\/g, "/")}")`;
    },
  );
}

/**
 * 把插件 CSS 收进 `.slime-plugin-scope` 作用域（**纯函数**，单一产地）。
 *
 * 逐条规则改写选择器：`h1` → `.slime-plugin-scope h1`；
 * 逗号分隔的多个选择器逐个加前缀（`.a, .b` → `.slime-plugin-scope .a, .slime-plugin-scope .b`）。
 * 宿主只在「有生效 CSS 时」给 <html> 挂这个类 ⇒ 没有插件 CSS 时宿主 CSS 完全不受影响。
 *
 * @keyframes 不改写（@keyframes 名字不是选择器，改了会连引用一起坏掉）——
 * 所以调用方**还要**拒掉带 @keyframes 的 CSS（见 CSS_FORBIDDEN 的最后一条）。
 */
export function scopePluginCss(css: string, scopeClass = "slime-plugin-scope"): string {
  const out: string[] = [];
  for (const raw of css.split("\n")) {
    const line = raw;
    const m = /^(\s*)([^{}@]+)(\{[\s\S]*)$/.exec(line);
    if (!m) { out.push(line); continue; }
    const [, indent, selectorRaw, rest] = m;
    /* ⚠️ 保留选择器段末尾的空白（`.card {` 里的那个空格）—— 直接 trim 后拼回去会得到
       `.card{`，属��"改写了作者的 CSS 文本"（守卫按字面比对时会假失败）。 */
    const trailingWs = /\s*$/.exec(selectorRaw)?.[0] ?? "";
    const selector = trailingWs ? selectorRaw.slice(0, selectorRaw.length - trailingWs.length) : selectorRaw;
    const scoped = selector
      .split(",")
      .map((one) => {
        const s = one.trim();
        if (!s) { return s; }
        // 已经是作用域自身（`:root`类已被静态禁令拒，这里只防 `.slime-plugin-scope` 自引用）
        if (s === `.${scopeClass}` || s === `.${scopeClass}:root` || s === `.${scopeClass} html` || s === `.${scopeClass} body`) {
          return `.${scopeClass}`;
        }
        if (s.startsWith(`.${scopeClass}`)) { return s; }
        return `.${scopeClass} ${s}`;
      })
      .join(", ");
    out.push(`${indent}${scoped}${trailingWs}${rest}`);
  }
  return out.join("\n");
}

/** CSS 声明的摘要（给 `PluginRecord.contributions` 计数用）。 */
export function describePluginCss(css: PluginCssDecl | undefined): string {
  if (!css) { return "0"; }
  return `1（${css.name}，${Buffer.byteLength(css.css, "utf8")} 字节）`;
}

/** 主题声明的摘要（给 `PluginRecord.contributions` 计数用）。 */
export function describePluginTheme(theme: PluginThemeDecl | undefined): string {
  if (!theme) { return "0"; }
  return `${theme.name}（${Object.keys(theme.tokens).length} 令牌）`;
}

/**
 * A-1200 · B2：`contributes.themes`（多套）的摘要 —— 与 `describePluginTheme` 同款口径，
 * 只是把「一套」换成「几套」。扩展页要能一眼看出「这个插件给了几套皮肤」。
 */
export function describePluginThemes(themes: PluginThemeDecl[] | undefined): string {
  if (!themes || themes.length === 0) { return "0"; }
  return themes.map((t) => `${t.name}（${Object.keys(t.tokens).length} 令牌）`).join("/");
}