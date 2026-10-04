/**
 * gui/src/renderer/pages/dropGuard.ts — 「文件被拖到应用上」该怎么处理的**唯一策略产地**。
 *
 * ## 事故（2026-09-28，用户报「重大事故」）
 * 把 `.docx/.pdf/.xlsx` 拖进窗口后：控制台**无休止**刷
 *   `GUEST_VIEW_MANAGER_CALL: Error: ERR_FAILED (-2) loading 'file:///…docx'`，
 * 目标文件夹被反复写出的半成品文件塞满，界面疯狂闪烁。
 *
 * ## 根因（两层，都不在"我们想打开它"上）
 * 1. **Chromium 的默认行为**：把文件拖到页面上 = **导航到该文件的 `file://` URL**。
 *    这是浏览器原生行为，代码里**根本没有** `file:///` 字符串（实测 `grep` 全仓为空）。
 *    旧代码只在 `onDrop` 里对**图片**做了 `preventDefault()`，非图片直接落到默认行为。
 * 2. `.docx` 不是 Chromium 能渲染的类型 ⇒ 导航失败；而 webview 的**重试通道**（导航安全网 /
 *    地址写回）没有"这个地址已判死"的记忆 ⇒ 反复重发同一次注定失败的加载（见 `webviewNav.ts`）。
 *
 * ## 本模块负责的那一层
 * **有文件被拖入 ⇒ 一律 `preventDefault`**（唯一闸门，装在 `index.tsx`），
 * 然后按类型分流：图片进聊天（原行为）、工作文档进文档通道、其余明确拒绝并**给出下一步**。
 * ⚠️ 判据只有一份：类型分类全部来自 `core-ts/src/office/fileKinds.ts`（铁律 11，别在这儿再写一份）。
 *
 * ⚠️ 本模块**不碰 DOM/React**（只吃 `{ name, type }` 结构子集）—— 这样能在 node 环境直接驱动测试，
 *    而不是靠"静态断言证明那行 preventDefault 还在"。
 */
import { classifyFile, nonNavigableReason, type DocKind } from "../../../../core-ts/src/office/fileKinds.js";

/** `File` 的结构子集（真实 `File`/`DataTransferItem` 都兼容；不引 DOM 类型进来） */
export type DroppedFileLike = { name: string; type: string };

/** 被拖动数据里是否含文件 */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

export type DroppedItem = {
  index: number;
  kind: DocKind;
  /** 老版二进制（.doc/.xls/.ppt）或未知类型 ⇒ 不处理，但要**说清为什么** */
  rejected: boolean;
  /** 拒绝的原因（可操作，取自 `nonNavigableReason`）；未拒绝时为空串 */
  reason: string;
};

export type DropPlan = {
  /** 图片：进聊天（既有行为） */
  images: DroppedItem[];
  /** 工作文档 / 纯文本：进文档通道（读取 + 预览） */
  documents: DroppedItem[];
  /** 不支持的：明确拒绝 + 可操作提示 */
  rejected: DroppedItem[];
};

/**
 * 把拖入的文件分流。
 * ⚠️ 图片与文档**不互斥**：混拖时两边都要接住（旧代码只处理图片，文档直接掉进默认导航）。
 */
export function planFileDrop(files: readonly DroppedFileLike[]): DropPlan {
  const plan: DropPlan = { images: [], documents: [], rejected: [] };
  files.forEach((f, index) => {
    const info = classifyFile(f.name);
    const isImage = info.kind === "image" || (f.type ?? "").startsWith("image/");
    if (isImage) {
      plan.images.push({ index, kind: "image", rejected: false, reason: "" });
      return;
    }
    /* ⚠️ 判据是 **`parser === "none"`（真的读不了）**，不是 `legacy`（只是格式老）。
       2026-09-28 的错：把 `.doc/.xls/.ppt` 当成"不可读"拒掉 —— 而仓库的 `cfb.ts` +
       `doc_text.ts::extractOleText` **一直能真读**它们（`file_read` 就在用）。
       「格式老」与「读不了」是两件事，混用会让一整个格式族被误拒（用户当场拍到了）。 */
    if (info.parser === "none") {
      plan.rejected.push({ index, kind: info.kind, rejected: true, reason: nonNavigableReason(f.name) });
      return;
    }
    plan.documents.push({ index, kind: info.kind, rejected: false, reason: "" });
  });
  return plan;
}

/** 拖入事件里有没有**任何**该接住的东西（用于决定「静默忽略」还是「给用户一个交代」） */
export function dropPlanIsEmpty(plan: DropPlan): boolean {
  return plan.images.length === 0 && plan.documents.length === 0 && plan.rejected.length === 0;
}
