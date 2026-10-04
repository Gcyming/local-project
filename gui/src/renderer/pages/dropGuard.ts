






















import { classifyFile, nonNavigableReason, type DocKind } from "../../../../core-ts/src/office/fileKinds.js";


export type DroppedFileLike = { name: string; type: string };


export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

export type DroppedItem = {
  index: number;
  kind: DocKind;
  
  rejected: boolean;
  
  reason: string;
};

export type DropPlan = {
  
  images: DroppedItem[];
  
  documents: DroppedItem[];
  
  rejected: DroppedItem[];
};





export function planFileDrop(files: readonly DroppedFileLike[]): DropPlan {
  const plan: DropPlan = { images: [], documents: [], rejected: [] };
  files.forEach((f, index) => {
    const info = classifyFile(f.name);
    const isImage = info.kind === "image" || (f.type ?? "").startsWith("image/");
    if (isImage) {
      plan.images.push({ index, kind: "image", rejected: false, reason: "" });
      return;
    }
    



    if (info.parser === "none") {
      plan.rejected.push({ index, kind: info.kind, rejected: true, reason: nonNavigableReason(f.name) });
      return;
    }
    plan.documents.push({ index, kind: info.kind, rejected: false, reason: "" });
  });
  return plan;
}


export function dropPlanIsEmpty(plan: DropPlan): boolean {
  return plan.images.length === 0 && plan.documents.length === 0 && plan.rejected.length === 0;
}
