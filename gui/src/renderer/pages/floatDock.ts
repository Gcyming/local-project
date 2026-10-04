



































export type DockId = "procs" | "subs";


export type DockState = DockId | null;


export const DOCK_ORDER: readonly DockId[] = ["procs", "subs"];


export function toggleDock(current: DockState, id: DockId): DockState {
  return current === id ? null : id;
}








export function closeDock(current: DockState, id: DockId): DockState {
  return current === id ? null : current;
}


export function isDockOpen(current: DockState, id: DockId): boolean {
  return current === id;
}









export function dockSlotClassOf(open: boolean): string {
  return `dock-slot${open ? " is-open" : ""}`;
}
