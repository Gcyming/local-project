










type SlimeAPI = { dialog?: { confirm: (m: string, d?: string) => Promise<{ ok: boolean; confirmed: boolean }>; alert: (m: string, d?: string) => Promise<{ ok: boolean }> } };

function api(): SlimeAPI {
  return (window as unknown as { slimeAPI?: SlimeAPI }).slimeAPI ?? {};
}


export interface DialogRequest {
  kind: "confirm" | "alert";
  message: string;
  detail?: string;
}


type DialogHost = (req: DialogRequest) => Promise<boolean>;

let dialogHost: DialogHost | null = null;


export function registerDialogHost(host: DialogHost | null): void {
  dialogHost = host;
}





export async function confirmAsync(message: string, detail?: string): Promise<boolean> {
  if (dialogHost) {
    try {
      return await dialogHost({ kind: "confirm", message, detail });
    } catch {  }
  }
  const dlg = api().dialog;
  if (dlg?.confirm) {
    try {
      const r = await dlg.confirm(message, detail);
      if (r.ok) { return r.confirmed; }
    } catch {  }
  }
  
  return window.confirm(detail ? `${message}\n\n${detail}` : message);
}


export async function alertAsync(message: string, detail?: string): Promise<void> {
  if (dialogHost) {
    try {
      await dialogHost({ kind: "alert", message, detail });
      return;
    } catch {  }
  }
  const dlg = api().dialog;
  if (dlg?.alert) {
    try {
      await dlg.alert(message, detail);
      return;
    } catch {  }
  }
  window.alert(detail ? `${message}\n\n${detail}` : message);
}