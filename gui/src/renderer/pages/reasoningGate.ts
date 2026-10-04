

































export interface ReasoningDataShape {
  
  reasoning?: string;
  stages?: {
    
    timeline?: unknown[];
    
    tools?: unknown[];
    
    reads?: unknown[];
    
    urls?: unknown[];
  };
}








export function hasReasoningData(m: ReasoningDataShape): boolean {
  return (m.reasoning ?? "").length > 0
    || (m.stages?.timeline?.length ?? 0) > 0
    || (m.stages?.tools?.length ?? 0) > 0
    || (m.stages?.reads?.length ?? 0) > 0
    || (m.stages?.urls?.length ?? 0) > 0;
}








export function shouldMountBody(open: boolean, everMounted: boolean): boolean {
  return open || everMounted;
}









export function isOpenClass(open: boolean, readyToOpen: boolean): boolean {
  return open && readyToOpen;
}


export interface ReasoningFrame {
  everMounted: boolean;
  readyToOpen: boolean;
}












export function advanceReasoningFrame(open: boolean, everMounted: boolean, readyToOpen: boolean): ReasoningFrame {
  if (!open) { return { everMounted, readyToOpen }; }
  if (!everMounted) { return { everMounted: true, readyToOpen: false }; } 
  if (!readyToOpen) { return { everMounted: true, readyToOpen: true }; }  
  return { everMounted: true, readyToOpen: true };                        
}
