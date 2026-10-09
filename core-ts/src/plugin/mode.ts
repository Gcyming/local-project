/**
 * A-1197 · B3（L4c 阶段机）：「纯用户定义运行模式」的**声明与校验**（设计 §4.3）。
 *
 * ## 三个范式的边界（不能含糊）
 * A. 模型+工具（agent-loop，默认）· B. 多成员协作（brainstorm，既有）·
 * C. **纯用户定义**（本文件——用户写的阶段清单，**并列的第三种分派**）。
 * C 只允许换「**跑什么**」，**不允许**换「**怎么判权限**」——沙箱/硬规则/工具去重/上下文截断/
 * 停止信号/每阶段预算，**一个都不省**（由主循环复用既有链路保证，见 chatRunner/stage 执行侧）。
 *
 * ## fail-closed（照 contributes.ts 同款，且更严一档）
 * 任一项非法 ⇒ **整份清单 rejected**（插件不装载 ⇒ 模式下拉里根本不出现），绝不静默丢弃。
 * `tools` 的存在性校验**分两层**：本文件管**语法**（名字形状 + 去重 + 上限）；「名字真实存在于
 * 当前工具表」由装配侧（有工具表的层）**装载时查一次** + 运行前**每阶段开始重查**
 * （设计兜底表：查不到 ⇒ 阶段不执行并如实写进对话，**不静默跳阶段**）。
 */

export const MODE_KINDS = ["stages"] as const;
export type ModeKind = (typeof MODE_KINDS)[number];

/** 阶段数上限（设计口径 1–8）。 */
export const MAX_STAGES = 8;
/** 单阶段 prompt 上限（**prompt 是要进上下文的，必须有上限**，设计口径 ≤4000）。 */
export const MAX_STAGE_PROMPT = 4000;
/** 单阶段标题上限。 */
export const MAX_STAGE_TITLE = 80;
/** 每阶段 maxRounds 上限（硬上限 ≤500）。 */
export const MAX_STAGE_ROUNDS = 500;
/** 单阶段工具白名单条数上限（防撑爆工具表）。 */
export const MAX_STAGE_TOOLS = 32;

/** 工具名形状：与既有工具注册名同族（如 `file_read` / `plugin__x__y`）。 */
export const MODE_TOOL_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export interface StageDecl {
  id: string;
  title?: string;
  /** 本阶段的指令（进上下文；上限 MAX_STAGE_PROMPT）。 */
  prompt: string;
  /** 本阶段工具白名单（空数组 = 纯固定流程，不装配工具表）。 */
  tools?: string[];
  /** 本阶段轮次上限（1..MAX_STAGE_ROUNDS）。 */
  maxRounds?: number;
  /** 是否允许 steer 注入（缺省 true，与主循环同口径）。 */
  allowSteer?: boolean;
  /** 依赖的**前面**某个阶段（禁止前向引用与环）。 */
  requirePrevious?: string;
}

export interface ModeDecl {
  kind: ModeKind;
  stages: StageDecl[];
  /** 声明侧自报的阶段数上限（≥ stages.length；仅作文档/防呆，不参与执行）。 */
  maxTotalStages?: number;
}

export interface PluginModeDecl extends ModeDecl {
  /** 展示名（下拉里显示；缺省用插件名）。 */
  title?: string;
}

const ALLOWED_STAGE_FIELDS: readonly string[] = [
  "id", "title", "prompt", "tools", "maxRounds", "allowSteer", "requirePrevious",
];
const ALLOWED_MODE_FIELDS: readonly string[] = ["kind", "stages", "maxTotalStages", "title"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 `mode` 声明（纯语法校验；工具存在性见文件头「两层」说明）。
 * `origin` 由调用方传入：`builtin` 时 `mode` 一律拒绝（内置运行器不走插件路径）。
 */
export function parseModeDecl(
  raw: unknown,
  where: string,
  origin?: string,
): { ok: true; mode: PluginModeDecl } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (origin === "builtin") {
    return { ok: false, errors: [`${where}：origin 为 builtin 的插件不得声明 mode（内置运行器不走插件路径）`] };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${where} 必须是对象`] };
  }
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_MODE_FIELDS.includes(field)) {
      errors.push(`${where} 含未知字段：${field}（允许的字段：${ALLOWED_MODE_FIELDS.join("、")}）`);
    }
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !(MODE_KINDS as readonly string[]).includes(kind)) {
    errors.push(`${where}.kind 缺失或不合法（当前只认 ${MODE_KINDS.join(" / ")}）`);
  }

  const stagesRaw = raw.stages;
  const stages: StageDecl[] = [];
  if (!Array.isArray(stagesRaw)) {
    errors.push(`${where}.stages 必须是数组`);
  } else if (stagesRaw.length === 0 || stagesRaw.length > MAX_STAGES) {
    errors.push(`${where}.stages 数量必须在 1..${MAX_STAGES}（收到 ${stagesRaw.length}）`);
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < stagesRaw.length; i++) {
      const sw = `${where}.stages[${i}]`;
      const item = stagesRaw[i];
      if (!isPlainObject(item)) {
        errors.push(`${sw} 必须是对象`);
        continue;
      }
      for (const field of Object.keys(item)) {
        if (!ALLOWED_STAGE_FIELDS.includes(field)) {
          errors.push(`${sw} 含未知字段：${field}（允许的字段：${ALLOWED_STAGE_FIELDS.join("、")}）`);
        }
      }
      const id = item.id;
      if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
        errors.push(`${sw}.id 缺失或不合法（小写字母数字与连字符）`);
      } else if (seen.has(id)) {
        errors.push(`${sw}.id 与前面的阶段重复：${id}`);
      } else {
        seen.add(id);
      }
      const decl: StageDecl = { id: typeof id === "string" ? id : "", prompt: "" };

      const prompt = item.prompt;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        errors.push(`${sw}.prompt 缺失或为空`);
      } else if (prompt.length > MAX_STAGE_PROMPT) {
        errors.push(`${sw}.prompt 过长（${prompt.length} > ${MAX_STAGE_PROMPT}）——prompt 要进上下文，必须有上限`);
      } else {
        decl.prompt = prompt;
      }

      if (item.title !== undefined) {
        if (typeof item.title !== "string" || item.title.trim() === "") {
          errors.push(`${sw}.title 必须是非空字符串`);
        } else if (item.title.length > MAX_STAGE_TITLE) {
          errors.push(`${sw}.title 过长（${item.title.length} > ${MAX_STAGE_TITLE}）`);
        } else {
          decl.title = item.title.trim();
        }
      }

      if (item.tools !== undefined) {
        if (!Array.isArray(item.tools)) {
          errors.push(`${sw}.tools 必须是数组`);
        } else if (item.tools.length > MAX_STAGE_TOOLS) {
          errors.push(`${sw}.tools 超过上限 ${MAX_STAGE_TOOLS} 条：${item.tools.length}`);
        } else {
          const names: string[] = [];
          for (const t of item.tools) {
            if (typeof t !== "string" || !MODE_TOOL_NAME_PATTERN.test(t)) {
              errors.push(`${sw}.tools 含非法工具名：${JSON.stringify(t)}`);
              continue;
            }
            if (names.includes(t)) {
              errors.push(`${sw}.tools 含重复工具名：${t}`);
              continue;
            }
            names.push(t);
          }
          decl.tools = names;
        }
      }

      if (item.maxRounds !== undefined) {
        if (typeof item.maxRounds !== "number" || !Number.isInteger(item.maxRounds) || item.maxRounds < 1 || item.maxRounds > MAX_STAGE_ROUNDS) {
          errors.push(`${sw}.maxRounds 必须是 1..${MAX_STAGE_ROUNDS} 的整数（收到 ${String(item.maxRounds)}）`);
        } else {
          decl.maxRounds = item.maxRounds;
        }
      }

      if (item.allowSteer !== undefined) {
        if (typeof item.allowSteer !== "boolean") {
          errors.push(`${sw}.allowSteer 必须是布尔值`);
        } else {
          decl.allowSteer = item.allowSteer;
        }
      }

      if (item.requirePrevious !== undefined) {
        if (typeof item.requirePrevious !== "string" || item.requirePrevious.trim() === "") {
          errors.push(`${sw}.requirePrevious 必须是非空字符串`);
        } else if (!seen.has(item.requirePrevious) || item.requirePrevious === id) {
          /* 只认**前面的**阶段：前向引用与环（含自引）一律拒。 */
          errors.push(`${sw}.requirePrevious 必须指向**前面的**阶段（禁止前向引用与环）：${item.requirePrevious}`);
        } else {
          decl.requirePrevious = item.requirePrevious;
        }
      }

      stages.push(decl);
    }
  }

  const declOut: PluginModeDecl = { kind: (kind as ModeKind) ?? "stages", stages };
  if (typeof raw.title === "string" && raw.title.trim() !== "") {
    declOut.title = raw.title.trim();
  }
  if (raw.maxTotalStages !== undefined) {
    if (typeof raw.maxTotalStages !== "number" || !Number.isInteger(raw.maxTotalStages) || raw.maxTotalStages < 1 || raw.maxTotalStages > MAX_STAGES) {
      errors.push(`${where}.maxTotalStages 必须是 1..${MAX_STAGES} 的整数`);
    } else if (Array.isArray(stagesRaw) && raw.maxTotalStages < stagesRaw.length) {
      errors.push(`${where}.maxTotalStages（${raw.maxTotalStages}）不得小于 stages 数量（${stagesRaw.length}）`);
    } else {
      declOut.maxTotalStages = raw.maxTotalStages;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, mode: declOut };
}

/** 工具存在性校验（第二层——由**有工具表**的装配侧调用；查不到的名字全量返回）。 */
export function validateModeTools(mode: ModeDecl, hasTool: (name: string) => boolean): string[] {
  const missing: string[] = [];
  for (const s of mode.stages) {
    for (const t of s.tools ?? []) {
      if (!hasTool(t) && !missing.includes(t)) {
        missing.push(t);
      }
    }
  }
  return missing;
}

/** 声明摘要（给 contributions 展示用）。 */
export function describeMode(mode: PluginModeDecl | undefined): string {
  if (!mode) { return "0步"; }
  return `${mode.stages.length}步`;
}
