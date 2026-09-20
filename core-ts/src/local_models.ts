/**
 * 本地模型清单 —— **键名与条目形状的唯一来源**（计划 S3：清单单一化）。
 *
 * 为什么单独一个文件：同一个约定此前散落在三处，而且**已经漂移**：
 *   - `core-ts/src/services/engine.ts`：自己写了一份 interface（**缺 `vision`**）+ 硬编码键名 **2 次**
 *   - `gui/src/main/providers.ts`：又写一份 interface + 自己的 `LOCAL_MODELS_KEY` 常量
 *   - `gui/src/shared/ipc.ts`：再写一份（跨进程契约投影）
 *
 * 键名一旦改名，core-ts 那两处会**静默失效** —— 症状是「UI 里明明显示有这个本地模型，
 * 一发消息就报『本地模型「x」未注册』」。不报错、不崩，只是找不到，
 * 与 A-1018/A-1023 是同一类病：**同一事实多个产地，且没有任何一方会抱怨**。
 *
 * 分层约定：core-ts 定义约定（唯一产地），GUI 侧引用。
 * `gui/src/shared/ipc.ts` 因**渲染层不能 import core-ts**，保留一份类型投影，
 * 其字段集合由 `tests/core-ts/a1024-guards.spec.ts` 强制与这里一致。
 */

/** providers 表里的特殊键：本地模型清单。
 *  ⚠️ 它不是供应商 —— 任何"遍历供应商"的地方都必须显式排除它
 *  （引擎的降级池、供应商列表、定价表都踩过这个坑）。 */
export const LOCAL_MODELS_KEY = "_local_models";

/**
 * 本地模型注册条目（`agent.model_choice = "local:<id>"` 的 id 在这张表里解析）。
 *
 * ⚠️ 除 `id` / `path` 外**全部可选**：磁盘上的历史条目可能缺字段 ——
 * `localModelsOf()` 只校验这两个是 string，把 `label` 写成必填是**类型谎言**
 * （会诱导调用方直接 `spec.label.xxx`，在历史数据上运行时炸）。
 */
export interface LocalModelSpec {
  id: string;
  /** 模型文件绝对路径（.gguf） */
  path: string;
  label?: string;
  /** 上下文长度（llama.cpp n_ctx） */
  ctx_len?: number;
  /** GPU 层数 */
  gpu_layers?: number;
  max_output?: number;
  vision?: boolean;
}

/**
 * 从 providers 表里按 id 取本地模型条目 —— **唯一实现**。
 *
 * 刻意**不校验路径存在性**：那是调用方的事（引擎要据此给出"模型文件不存在（具体路径）"
 * 这类可操作的提示，而不是笼统的"未注册"）。
 *
 * @returns 找到则返回条目；表缺该键 / 不是数组 / 无匹配 → `undefined`（不抛）
 */
export function findLocalModelSpec(
  table: Record<string, unknown> | undefined | null,
  id: string,
): LocalModelSpec | undefined {
  const raw = table?.[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return undefined; }
  return (raw as LocalModelSpec[]).find(
    (m) => m && typeof m === "object" && m.id === id,
  );
}

/**
 * 取清单**全部**条目（已过滤掉形状不合法的项）—— **唯一实现**。
 * 过滤判据与 `providers.ts localModelsOf()` 保持一致：只认 `id`/`path` 都是 string 的项。
 *
 * @returns 缺键 / 非数组 → `[]`（不抛）
 */
export function localModelSpecs(
  table: Record<string, unknown> | undefined | null,
): LocalModelSpec[] {
  const raw = table?.[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((m): m is LocalModelSpec =>
    typeof m === "object" && m !== null &&
    typeof (m as LocalModelSpec).id === "string" &&
    typeof (m as LocalModelSpec).path === "string");
}
