/**
 * A-1041：LanceDB 的**构建期桩 / 运行期转发器**。
 *
 * 背景（这是 1GB 安装包的元凶）：
 *   · 真实 `@lancedb/lancedb` 带一个 297MB 的原生子包（`@lancedb/lancedb-win32-x64-msvc`）。
 *   · 它**无法**进 rollup bundle（A-966：清缓存全量构建必现 `\0` 解析错），所以 A-966 加了 alias
 *     指向本文件；但 `store.ts` 里那个 `/* @vite-ignore *\/` 让 vite **跳过 alias**，
 *     于是真包连同 297MB native 一起被打进 `out/main/chunks/lancedb.win32-x64-msvc-*.node`。
 *   · 结果：体积白付了，而 `electron-builder.json` 的 `files` 里**根本没有 node_modules** ——
 *     这份 native 只存在于 bundle 里，既不好管理、也没法按需裁剪。
 *
 * 现在的设计（能力不砍，只是换个承载方式）：
 *   · **构建期**：vite 只把本文件（几 KB）打进产物 → 安装包不再含 297MB。
 *   · **运行期**：本文件按候选目录找**真实 lancedb** 并 require —— 它成了 slime 的
 *     「内嵌组件」：可以随完整版分发，也可以在应用内下载就位，未就位时明确降级（不静默）。
 *
 * 候选目录（按顺序）：
 *   ① `resources/components/lancedb`   —— 完整版安装包随附（extraResources）
 *   ② `<userData>/components/lancedb`  —— 应用内下载 / 手动就位
 *   ③ 项目 `node_modules`              —— 开发环境（npm i 后即开箱可用）
 *
 * 目录布局要求：`<dir>/node_modules/@lancedb/lancedb` + `<dir>/node_modules/@lancedb/lancedb-win32-x64-msvc`
 * （主包内部按 node 规则向上找 node_modules，平铺两包即可，不需要完整 node_modules 树）。
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

/** CJS 产物里是 `__filename`，ESM 下 fallback 到 import.meta.url */
const req = typeof __filename !== "undefined"
  ? createRequire(__filename)
  : createRequire(import.meta.url);

/** 主包入口（相对组件目录） */
const PKG_ENTRY = join("node_modules", "@lancedb", "lancedb", "dist", "index.js");

/** 组件目录名（resources / userData 下同名） */
export const LANCEDB_COMPONENT_DIR = "components/lancedb";

function userDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = req("electron") as { app?: { getPath: (n: string) => string } };
    if (app?.getPath) return app.getPath("userData");
  } catch {
    /* 非 Electron 环境（单测等）→ 忽略 */
  }
  return "";
}

/** 真实 lancedb 的候选目录（按顺序；不存在的也返回，供界面如实展示"可以放哪"） */
export function lancedbCandidates(): string[] {
  const out: string[] = [];
  const res = typeof process !== "undefined" ? (process as { resourcesPath?: string }).resourcesPath : "";
  const ud = userDataDir();
  if (res) {
    // 打包环境：`resources/components/lancedb`（完整版随附）
    out.push(resolvePath(res, LANCEDB_COMPONENT_DIR));
    if (ud) out.push(resolvePath(ud, LANCEDB_COMPONENT_DIR)); // 应用内下载 / 手动放置
    return out;
  }
  // 非打包环境（dev / 单测）：项目根的 node_modules 里就是现成的
  // ⚠️ 候选值必须是"含 node_modules 的那一层根"，因为 PKG_ENTRY 里已经带了 node_modules/@lancedb/…
  if (ud) out.push(resolvePath(ud, LANCEDB_COMPONENT_DIR));
  out.push(process.cwd());
  return out;
}

/** 找到**已就位**的组件目录（含真实 lancedb 入口）；没有则返回 null */
export function findLancedbComponent(): string | null {
  for (const dir of lancedbCandidates()) {
    const entry = join(dir, PKG_ENTRY);
    try {
      if (existsSync(entry) && statSync(entry).isFile()) return dir;
    } catch {
      /* 权限/路径异常 → 当不存在 */
    }
  }
  return null;
}

/** 组件就位状态（供界面与"是否启用向量层"决策读取） */
export interface LancedbComponentStatus {
  ok: boolean;
  /** 已就位时的组件目录 */
  dir?: string;
  /** 未就位时的候选目录清单（界面如实告诉用户可以放哪） */
  candidates: string[];
  error?: string;
}

export function lancedbComponentStatus(): LancedbComponentStatus {
  const candidates = lancedbCandidates();
  const dir = findLancedbComponent();
  if (dir) return { ok: true, dir, candidates };
  return {
    ok: false,
    candidates,
    error: "LanceDB 运行时组件未就位（向量记忆将降级为 JSON 检索；可在心智中枢下载或手动放置）",
  };
}

/** 加载真实 lancedb；未就位时抛出**带明确原因**的错误（绝不静默降级） */
export function requireLancedb(): unknown {
  const dir = findLancedbComponent();
  if (!dir) {
    throw new Error(
      `LanceDB 运行时组件未就位。候选目录：${lancedbCandidates().join(" / ")}；` +
      `期望布局 <dir>/${PKG_ENTRY}`,
    );
  }
  return req(join(dir, PKG_ENTRY));
}

/** store.ts 走的是 `mod.connect(uri)` —— 这里转发到真实包 */
export async function connect(uri: string): Promise<unknown> {
  const mod = requireLancedb() as { connect: (u: string) => Promise<unknown> };
  return mod.connect(uri);
}

export type Table = unknown;
