


















export type RenderKind =
  | "pptx-preview"   
  | "docx-preview"   
  | "sheetjs"        
  | "pdf-viewer"     
  | "html-native"    
  | "text-html"      
  | "none";          

export type RenderPlan = {
  render: RenderKind;
  
  faithful: boolean;
  
  needs?: "libreoffice";
  







  fallback?: RenderKind;
};


function extOf(nameOrPath: string): string {
  const base = (nameOrPath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) { return ""; }
  return base.slice(dot + 1).toLowerCase();
}

const PPTX_OOXML = ["pptx", "pptm", "potx"];
const DOCX_OOXML = ["docx", "docm", "dotx"];
const XLSX_OOXML = ["xlsx", "xlsm", "xltx"];

const PPT_LEGACY = ["ppt", "pot", "pps"];
const DOC_LEGACY = ["doc", "dot"];
const XLS_LEGACY = ["xls", "xlt"];






export function planRender(nameOrPath: string): RenderPlan {
  const ext = extOf(nameOrPath);
  if (ext === "pdf") { return { render: "pdf-viewer", faithful: true }; }
  if (PPTX_OOXML.includes(ext)) { return { render: "pptx-preview", faithful: true }; }
  if (DOCX_OOXML.includes(ext)) { return { render: "docx-preview", faithful: true }; }
  if (XLSX_OOXML.includes(ext)) { return { render: "sheetjs", faithful: true }; }
  if (XLS_LEGACY.includes(ext)) {
    



    return { render: "pdf-viewer", faithful: true, needs: "libreoffice", fallback: "sheetjs" };
  }
  if (PPT_LEGACY.includes(ext) || DOC_LEGACY.includes(ext)) {
    

    return { render: "pdf-viewer", faithful: true, needs: "libreoffice" };
  }
  



  if (ext === "html" || ext === "htm" || ext === "xhtml") { return { render: "html-native", faithful: true }; }
  if (ext) { return { render: "text-html", faithful: false }; }
  return { render: "none", faithful: false };
}


export function needsLibreOffice(nameOrPath: string): boolean {
  return planRender(nameOrPath).needs === "libreoffice";
}





export function fallbackRender(nameOrPath: string): RenderKind | null {
  return planRender(nameOrPath).fallback ?? null;
}





export function canFaithfullyRender(nameOrPath: string): boolean {
  const p = planRender(nameOrPath);
  return p.faithful && !p.needs;
}
