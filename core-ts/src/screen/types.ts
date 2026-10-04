












export type ScreenBackendId = "desktop" | "android";


export interface DisplayInfo {
  backend: ScreenBackendId;
  
  target: string;
  width: number;
  height: number;
  
  label: string;
  
  scale?: number;
  









  originX?: number;
  originY?: number;
}


export interface ScreenCaptureResult {
  ok: boolean;
  
  pngBase64?: string;
  
  dataUrl?: string;
  
  width?: number;
  height?: number;
  





  imageWidth?: number;
  imageHeight?: number;
  




  originX?: number;
  originY?: number;
  
  bytes?: number;
  error?: string;
  






  warning?: string;
  
  annotate?: {
    grid: boolean;
    
    marks: number;
    
    scaleX: number;
    scaleY: number;
  };
}








export type CoordSpace = "image" | "normalized" | "device";


export type ScreenActionKind =
  | "click"          
  | "double_click"   
  | "right_click"    
  | "middle_click"   
  | "long_press"     
  | "mouse_move"     
  | "drag"           
  | "scroll"         
  | "type"           
  | "key"            
  | "tap"            
  | "swipe"          
  | "wait";          






export interface ElementSelector {
  
  index?: number;
  
  id?: string;
  
  text?: string;
  
  desc?: string;
}


export interface ScreenAction {
  kind: ScreenActionKind;
  
  x?: number;
  
  y?: number;
  
  x2?: number;
  
  y2?: number;
  
  text?: string;
  
  key?: string;
  
  delta?: number;
  
  durationMs?: number;
  
  coordSpace?: CoordSpace;
  
  absolute?: boolean;
  
  selector?: ElementSelector;
}


export interface UiElement {
  
  index: number;
  
  className?: string;
  
  text?: string;
  
  id?: string;
  
  desc?: string;
  
  bounds: { x1: number; y1: number; x2: number; y2: number };
  
  center: { x: number; y: number };
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
}








export interface ActionVerify {
  
  hit: boolean;
  
  ratio: number | null;
  
  attempts: number;
  
  note: string;
}


export interface ScreenActionResult {
  ok: boolean;
  
  detail?: string;
  
  capture?: ScreenCaptureResult;
  
  verify?: ActionVerify;
  error?: string;
}


export interface UiDumpOutcome {
  
  ok: boolean;
  elements: UiElement[];
  
  error?: string;
}


export interface ScreenBackend {
  readonly id: ScreenBackendId;
  
  readonly actions: ReadonlySet<ScreenActionKind>;
  
  listTargets(): Promise<DisplayInfo[]>;
  
  displayInfo(target?: string): Promise<DisplayInfo>;
  
  capture(target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult>;
  
  perform(action: ScreenAction, target?: string, info?: DisplayInfo): Promise<ScreenActionResult>;
  










  uiDump?(target?: string): Promise<UiElement[]>;
  



  listWindows?(): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>>;
  
  focusWindow?(title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }>;
  



  captureWindow?(title: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult>;
  










  userIdleMs?(): Promise<number | null>;
  







  residentHost?(): { pid?: number; startedAt: number } | null;
  





  dispose?(): void;
}


export const NORMALIZED_MAX = 1000;










export function imageToDevice(value: number | undefined, imageSize: number, deviceSize: number): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) { return undefined; }
  if (!imageSize || !deviceSize) { return Math.round(value); }
  return Math.round((value / imageSize) * deviceSize);
}








export function toPixel(value: number | undefined, size: number, absolute: boolean): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) { return undefined; }
  if (absolute) { return Math.round(value); }
  const clamped = Math.max(0, Math.min(NORMALIZED_MAX, value));
  return Math.round((clamped / NORMALIZED_MAX) * size);
}








export function coordToDevice(
  space: CoordSpace,
  value: number | undefined,
  imageSize: number,
  deviceSize: number,
): number | undefined {
  return coordToDeviceInRegion(space, value, imageSize, deviceSize, 0);
}






export function coordToDeviceInRegion(
  space: CoordSpace,
  value: number | undefined,
  imageSize: number,
  regionSize: number,
  origin: number,
): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) { return undefined; }
  if (space === "device") { return Math.round(value); }
  if (space === "normalized") {
    const clamped = Math.max(0, Math.min(NORMALIZED_MAX, value));
    return Math.round(origin + (clamped / NORMALIZED_MAX) * regionSize);
  }
  
  if (!imageSize || !regionSize) { return Math.round(origin + value); }
  return Math.round(origin + (value / imageSize) * regionSize);
}
