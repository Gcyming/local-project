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
 * 见设计 §5.4）——写了就是拒，fail-closed，不装假插座。 */
export const PLUGIN_UI_SLOTS = ["settings_panel", "status_item", "chat_action", "toolbar_item"] as const;
export type PluginUiSlot = (typeof PLUGIN_UI_SLOTS)[number];

/** 单个插件最多声明多少条 UI 槽位（防「一个插件塞一堆条目把界面撑爆」）。 */
export const MAX_PLUGIN_UI_SLOTS = 16;

/** 槽位声明里标题/文案字段的长度上限（声明会回传渲染层，无上限会被撑爆面板）。 */
export const MAX_UI_TITLE = 80;
/** 图标字段（一个名字/短串，渲染层自己决定怎么画）的长度上限。 */
export const MAX_UI_ICON = 64;

/** `status_item` 的刷新方式枚举（其它取值一律拒）。 */
export const PLUGIN_UI_REFRESH = ["manual", "on_event"] as const;
export type PluginUiRefresh = (typeof PLUGIN_UI_REFRESH)[number];

export interface PluginUiContribution {
  slot: PluginUiSlot;
  /** 同插件内唯一；跨插件的槽位冲突留给宿主裁决（见设计 §4.1「失控时怎么兜」）。 */
  id: string;
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
const ALLOWED_CONTRIBUTES_FIELDS: readonly string[] = ["settings", "ui", "scripts", "page"];

/** 单条 UI 槽位声明允许出现的全部字段（出现表外的键即拒绝）。 */
const ALLOWED_UI_FIELDS: readonly string[] = ["slot", "id", "title", "label", "icon", "order", "refresh", "when"];

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
  /* 交叉校验（B5）：`toolbar_item` 的唯一用途就是「打开本插件的 page」——
     有它却没 page ⇒ 点了没东西可开（假按钮）。fail-closed：整份拒。 */
  if ((out.ui ?? []).some((u) => u.slot === "toolbar_item") && out.page === undefined) {
    errors.push("contributes.ui 含 toolbar_item 但缺少 contributes.page：该槽位的唯一用途是打开扩展自己的页面，没有 page 就是假按钮");
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
      slot: (slotOk ? slotRaw : "settings_panel") as PluginUiSlot,
      id: typeof id === "string" ? id : "",
    };

    /* ---- 按槽位分支：settings_panel 用 title；其余槽位用 label ---- */
    if (slotRaw === "settings_panel") {
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

/** UI 槽位声明的摘要（给 `PluginRecord.contributions` 计数用）。 */
export function describePluginUi(ui: PluginUiContribution[] | undefined): string {
  if (!ui || ui.length === 0) { return "0条"; }
  const bySlot = new Map<string, number>();
  for (const item of ui) {
    bySlot.set(item.slot, (bySlot.get(item.slot) ?? 0) + 1);
  }
  return [...bySlot.entries()].map(([slot, n]) => `${slot}×${n}`).join("/");
}

/** 声明项的摘要（给 `PluginRecord.contributions` 计数用，不含任何取值）。 */
export function describePluginSettings(settings: PluginSettingDecl[] | undefined): string {
  return `${settings?.length ?? 0}项`;
}