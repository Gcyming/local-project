

















export function normalizeTargetPath(raw: string): string {
  return (raw ?? "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/#L\d+(?:-L?\d+)?$/i, "") 
    .replace(/:\d+(:\d+)?$/, "")     
    .replace(/\/+$/, "");
}


export function isAbsoluteTarget(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("//") || p.startsWith("/");
}

export interface TargetRoots {
  
  root?: string;
  
  sessionWorkspace?: string | null;
  
  projectRoot?: string;
}

export interface CandidateResult {
  
  candidates: string[];
  
  roots: string[];
}









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
    
    if (segs.length > 1 && basename(r).toLowerCase() === segs[0].toLowerCase()) {
      push(join(r, ...segs.slice(1)));
    }
    
    push(join(dirname(r), ...segs));
  }
  return { candidates, roots: usedRoots };
}
