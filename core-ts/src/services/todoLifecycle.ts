



























export type TurnEndReason =
  
  | "done"
  
  | "error"
  
  | "cancelled";

export interface TurnEndInput {
  reason: TurnEndReason;
  






  stillActive: boolean;
}









export function shouldClearTodosOnTurnEnd(ev: TurnEndInput): boolean {
  if (ev.stillActive) { return false; }
  return ev.reason === "done";
}
