










































export type CompressStage = "prep" | "summarize" | "done" | "trunc" | "skip" | "overflow" | null | undefined;







export function isCompressWindow(stage: CompressStage): boolean {
  return stage === "prep" || stage === "summarize" || stage === "trunc" || stage === "skip" || stage === "overflow";
}










export function steerPlaceholder(): string {
  return "输入要补充的话（回车加入待发，本轮结束后发出；要立刻插进正在跑的这轮，点待发卡片上的「现在插入」）";
}


export function steerSubmitTitle(): string {
  return "加入待发：本条排在本轮之后发出。要立刻插进正在跑的这轮，点待发卡片上的「现在插入」";
}








export function insertNowTitle(): string {
  return "引导（现在插入）：把这条注进正在跑的这轮（不打断它）——在下一个工具调用之后的轮次边界生效；"
    + "本轮没有工具调用就顺延到下一轮发出。想立刻停掉请用「停止」";
}








export function canSubmitSteer(text: string, images: number): boolean {
  if (images > 0) { return true; }
  return text.trim().length > 0;
}
