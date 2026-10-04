
















const KEY = "slime_network_enabled";


export function readNetworkEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}


export function writeNetworkEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {  }
}


export const NETWORK_TOGGLE_KEY = KEY;
