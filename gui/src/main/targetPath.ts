/**
 * targetPath.ts — A-980-R32：把「聊天 / 产物卡里点到的一个路径串」解析成候选绝对路径。
 *
 * 为什么单独成模块：这段逻辑的输入是**野生字符串**（工具参数、模型输出、markdown 链接），
 * 形态五花八门；输出错一位的表现就是"明明存在的文件报不存在"。而它在主进程 handler 里
 * 与 electron 运行时耦合、跑不了单测，所以把纯逻辑拿出来（同 core-ts 的 paths/todoStore 做法）。
 *
 * 覆盖的真实形态（都来自本次排查）：
 *   · 相对会话工作目录：`docs/api.md`
 *   · 相对项目根（会话未绑定工作目录时工具的 cwd）：`gui/src/main/index.ts`
 *   · 带项目名前缀：`pilot project/docs/api.md`（首段与根目录名相同 → 去首段重试）
 *   · 带行号后缀：`src/a.ts:42`、`docs/x.md#L10-L20`（markdown 链接常见）
 *   · 带引号 / 反斜杠 / 末尾斜杠：`"D:\a\b\"`
 *   · 相对某个父目录：`main/index.ts`（会话工作目录是 `gui/` 时命中 dirname(root)）
 *   · 本来就是绝对路径：`D:/pilot project/docs/api.md`
 */

/** 归一化野生路径串：去引号/空白 → 统一斜杠 → 剥定位后缀/末尾斜杠 */
export function normalizeTargetPath(raw: string): string {
  return (raw ?? "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/#L\d+(?:-L?\d+)?$/i, "") // markdown 行锚点：`#L10` / `#L10-L20` / `#L10-20`
    .replace(/:\d+(:\d+)?$/, "")     // `路径:行[:列]`（注意 Windows 盘符不会被误伤：`D:` 后面是斜杠而非数字）
    .replace(/\/+$/, "");
}

/** 是否是绝对路径（含 Windows 盘符、UNC、POSIX） */
export function isAbsoluteTarget(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("//") || p.startsWith("/");
}

export interface TargetRoots {
  /** 渲染层手里的工作目录（可能尚未加载完 / 压根没绑定 → 空串） */
  root?: string;
  /** 会话级权威工作目录（主进程从 sessions.json 查得） */
  sessionWorkspace?: string | null;
  /** 项目根（工具的默认 cwd） */
  projectRoot?: string;
}

export interface CandidateResult {
  /** 去重后的候选绝对路径，按可能性从高到低 */
  candidates: string[];
  /** 解析用到的基准目录（调试/展示用） */
  roots: string[];
}

/**
 * 生成候选绝对路径。
 *
 * @param rel 原始路径串（会被归一化）
 * @param roots 解析基准
 * @param join 路径拼接函数（注入以便单测；主进程传 node:path 的 resolve）
 * @param basename / dirname 同上
 */
export function buildTargetCandidates(
  rel: string,
  roots: TargetRoots,
  join: (...parts: string[]) => string,
  basename: (p: string) => string,
  dirname: (p: string) => string,
): CandidateResult {
  const clean = normalizeTargetPath(rel);
  const candidates: string[] = [];
  const usedRoots: string[] = [];
  const push = (v: string): void => {
    const n = (v ?? "").trim();
    if (n && !candidates.includes(n)) { candidates.push(n); }
  };
  if (!clean) { return { candidates, roots: usedRoots }; }

  const abs = isAbsoluteTarget(clean);
  // 先看首段是否就是某个基准目录的名字（工具爱回传"带项目名"的路径）
  const segs = clean.replace(/^\.\//, "").split("/").filter((s) => s.length > 0);

  const addRoot = (r?: string | null): void => {
    const v = (r ?? "").trim();
    if (v && !usedRoots.includes(v)) { usedRoots.push(v); }
  };
  addRoot(roots.root);
  addRoot(roots.sessionWorkspace);
  addRoot(roots.projectRoot);

  if (abs) { push(join(clean)); return { candidates, roots: usedRoots }; }

  for (const r of usedRoots) {
    push(join(r, ...segs));
    // 路径首段 == 基准目录名 → 去掉首段再试（`pilot project/docs/a.md` 而基准是 `D:/pilot project`）
    if (segs.length > 1 && basename(r).toLowerCase() === segs[0].toLowerCase()) {
      push(join(r, ...segs.slice(1)));
    }
    // 反向：rel 只是"某子目录下的相对路径"（如 `main/index.ts`），基准应上溯一层
    push(join(dirname(r), ...segs));
  }
  return { candidates, roots: usedRoots };
}
