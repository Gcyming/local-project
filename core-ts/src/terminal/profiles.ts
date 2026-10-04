
























export type TermProfileKind =
  | "cmd"          
  | "powershell"   
  | "pwsh"         
  | "wsl"          
  | "bash"         
  | "sh"           
  | "vsdevcmd"     
  | "vspwsh";      


export interface TermProfile {
  
  id: string;
  
  label: string;
  kind: TermProfileKind;
  
  file: string;
  
  detail?: string;
  
  distro?: string;
  
  setup?: string;
}


export interface ShellInvocation {
  file: string;
  args: string[];
}








export function shellInvocation(p: TermProfile, cmd: string, cwd?: string): ShellInvocation {
  switch (p.kind) {
    case "cmd":
      

      return { file: p.file, args: ["/d", "/s", "/c", cmd] };
    case "vsdevcmd": {
      

      const full = p.setup ? `call "${p.setup}" >nul && ${cmd}` : cmd;
      return { file: p.file, args: ["/d", "/s", "/c", full] };
    }
    case "powershell":
    case "pwsh":
      

      return { file: p.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd] };
    case "vspwsh": {
      const full = p.setup
        ? `& "${p.setup}" -Arch amd64 -HostArch amd64 | Out-Null; ${cmd}`
        : cmd;
      return { file: p.file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", full] };
    }
    case "bash":
      
      return { file: p.file, args: ["-lc", cmd] };
    case "sh":
      return { file: p.file, args: ["-c", cmd] };
    case "wsl": {
      const args: string[] = [];
      if (p.distro) { args.push("-d", p.distro); }
      if (cwd) { args.push("--cd", cwd); }
      args.push("--", "bash", "-lc", cmd);
      return { file: p.file, args };
    }
  }
}










export function pickDefaultProfile(list: readonly TermProfile[]): TermProfile | null {
  const priority: TermProfileKind[] = ["pwsh", "powershell", "cmd", "bash", "sh", "wsl", "vsdevcmd", "vspwsh"];
  for (const kind of priority) {
    const hit = list.find((p) => p.kind === kind);
    if (hit) { return hit; }
  }
  return list[0] ?? null;
}


export const PROFILE_KIND_ORDER: readonly TermProfileKind[] =
  ["pwsh", "powershell", "cmd", "wsl", "vsdevcmd", "vspwsh", "bash", "sh"];


export function orderProfiles(list: readonly TermProfile[]): TermProfile[] {
  const rank = (k: TermProfileKind): number => {
    const i = PROFILE_KIND_ORDER.indexOf(k);
    return i < 0 ? PROFILE_KIND_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind));
}









export function resolveProfile(list: readonly TermProfile[], id: string | undefined | null): TermProfile | null {
  if (id) {
    const hit = list.find((p) => p.id === id);
    if (hit) { return hit; }
  }
  return pickDefaultProfile(list);
}
























function isWinPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}


export function isAbsoluteTarget(p: string): boolean {
  return isWinPath(p) || p.startsWith("/");
}


export function joinTarget(cwd: string, rel: string): string {
  const sep = isWinPath(cwd) ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}


export function normalizeTarget(p: string): string {
  if (isWinPath(p)) {
    const drive = /^[a-zA-Z]:/.exec(p)?.[0] ?? "";
    const body = p.slice(drive.length);
    const out: string[] = [];
    for (const seg of body.split(/[\\/]+/)) {
      if (!seg || seg === ".") { continue; }
      if (seg === "..") { if (out.length > 0) { out.pop(); } continue; }
      out.push(seg);
    }
    return `${drive}\\${out.join("\\")}`;
  }
  const out: string[] = [];
  for (const seg of p.slice(1).split(/[\\/]+/)) {
    if (!seg || seg === ".") { continue; }
    if (seg === "..") { if (out.length > 0) { out.pop(); } continue; }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}


function cdVerbs(kind: TermProfileKind): readonly string[] {
  if (kind === "cmd" || kind === "vsdevcmd") { return ["cd", "chdir"]; }
  if (kind === "powershell" || kind === "pwsh" || kind === "vspwsh") { return ["cd", "chdir", "set-location", "sl"]; }
  return ["cd"];
}






export function resolveCd(
  raw: string,
  cwd: string | undefined,
  kind: TermProfileKind,
  home?: string,
): { next: string } | null {
  const cmd = String(raw ?? "").trim();
  if (!cmd || !cwd) { return null; }

  
  if (/[&|;<>`\r\n]/.test(cmd)) { return null; }

  const verbs = cdVerbs(kind);
  const verbRe = new RegExp(`^(${verbs.join("|")})\\b\\s*(.*)$`, "i");
  const m = verbRe.exec(cmd);
  if (!m) { return null; }
  let rest = (m[2] ?? "").trim();

  if (rest === "") {
    
    const isWinShell = kind === "cmd" || kind === "vsdevcmd";
    if (isWinShell) { return null; }
    return home ? { next: normalizeTarget(home) } : null;
  }

  
  if ((kind === "cmd" || kind === "vsdevcmd") && /^\/d\s+/i.test(rest)) {
    rest = rest.replace(/^\/d\s+/i, "").trim();
  }

  let p = rest;
  
  const q = p[0];
  if ((q === "\"" || q === "'") && p.length >= 2 && p.endsWith(q)) { p = p.slice(1, -1); }
  if (p === "") { return null; }
  
  if (p.startsWith("-")) { return null; }
  
  if (/[%$!*?]/.test(p)) { return null; }
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    if (!home) { return null; }
    p = home + p.slice(1);
  }
  p = p.replace(/[\\/]+$/, "");
  if (p === "") { return null; }

  return { next: isAbsoluteTarget(p) ? normalizeTarget(p) : normalizeTarget(joinTarget(cwd, p)) };
}
