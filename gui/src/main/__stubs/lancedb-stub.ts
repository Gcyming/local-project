























import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";


const req = typeof __filename !== "undefined"
  ? createRequire(__filename)
  : createRequire(import.meta.url);


const PKG_ENTRY = join("node_modules", "@lancedb", "lancedb", "dist", "index.js");


export const LANCEDB_COMPONENT_DIR = "components/lancedb";

function userDataDir(): string {
  try {
    
    const { app } = req("electron") as { app?: { getPath: (n: string) => string } };
    if (app?.getPath) return app.getPath("userData");
  } catch {
    
  }
  return "";
}


export function lancedbCandidates(): string[] {
  const out: string[] = [];
  const res = typeof process !== "undefined" ? (process as { resourcesPath?: string }).resourcesPath : "";
  const ud = userDataDir();
  if (res) {
    
    out.push(resolvePath(res, LANCEDB_COMPONENT_DIR));
    if (ud) out.push(resolvePath(ud, LANCEDB_COMPONENT_DIR)); 
    return out;
  }
  
  
  if (ud) out.push(resolvePath(ud, LANCEDB_COMPONENT_DIR));
  out.push(process.cwd());
  return out;
}


export function findLancedbComponent(): string | null {
  for (const dir of lancedbCandidates()) {
    const entry = join(dir, PKG_ENTRY);
    try {
      if (existsSync(entry) && statSync(entry).isFile()) return dir;
    } catch {
      
    }
  }
  return null;
}


export interface LancedbComponentStatus {
  ok: boolean;
  
  dir?: string;
  
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


export async function connect(uri: string): Promise<unknown> {
  const mod = requireLancedb() as { connect: (u: string) => Promise<unknown> };
  return mod.connect(uri);
}

export type Table = unknown;
