



























export type LibreOfficeProbe = {
  
  found: boolean;
  
  path: string;
  



  version: string;
  
  hint: string;
};


const CANDIDATES: Record<string, readonly string[]> = {
  win32: [
    






    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice Still\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice 7\\program\\soffice.com",
    

    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files\\LibreOffice Still\\program\\soffice.exe",
    "C:\\Program Files\\LibreOffice 7\\program\\soffice.exe",
  ],
  darwin: [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice.bin",
  ],
  linux: [
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/snap/bin/libreoffice",       
    "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",  
  ],
};






export const LO_PATH_ENV = ["SLIME_LIBREOFFICE_PATH", "LIBREOFFICE_PATH"] as const;


export const LO_DOWNLOAD_HINT = [
  "本机没有找到 LibreOffice，老版 Office 文件（.doc/.xls/.ppt）暂时无法原样预览。",
  "装一个即可（装完重开应用，无需其他配置）：https://www.libreoffice.org/download/download-libreoffice/",
  "现有文件仍可正常阅读与编辑（应用会自动改用文本方式提取内容）。",
].join("");


export function notFound(): LibreOfficeProbe {
  return { found: false, path: "", version: "", hint: LO_DOWNLOAD_HINT };
}



















export function looksLikeSoffice(p: string): boolean {
  const base = (p ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base) { return false; }
  const lower = base.toLowerCase();
  if (lower === "soffice.exe" || lower === "soffice.bin" || lower === "soffice" || lower === "soffice.com") { return true; }
  







  if (lower === "libreoffice.exe") { return true; }
  if (lower === "libreoffice" && !/^[a-z]:\//i.test(p.replace(/\\/g, "/"))) { return true; }
  return false;
}












export function consoleVariantOf(p: string): string | null {
  const s = p ?? "";
  const base = s.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base.toLowerCase() !== "soffice.exe") { return null; }
  


  return s.slice(0, s.length - base.length) + "soffice.com";
}












export function parseVersion(stdout: string): string {
  const m = /LibreOffice\s+([0-9][0-9._]*)/i.exec(stdout ?? "");
  if (!m) { return ""; }
  return m[1].replace(/\.+$/, "");
}


export function candidatesFor(platform: NodeJS.Platform | string): readonly string[] {
  

  return CANDIDATES[platform] ?? [];
}





export function probeSearchList(platform: NodeJS.Platform | string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | undefined): void => {
    const v = (p ?? "").trim();
    if (!v || !looksLikeSoffice(v)) { return; }
    const k = v.toLowerCase();
    if (seen.has(k)) { return; }
    seen.add(k);
    out.push(v);
  };
  for (const name of LO_PATH_ENV) { push(env[name]); }
  for (const p of candidatesFor(platform)) { push(p); }
  return out;
}
