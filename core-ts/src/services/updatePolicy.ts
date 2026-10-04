



































export interface RawUpdateKeys {
  
  autoCheck?: boolean;
  
  enabled?: boolean;
}

export type UpdatePolicyReason =
  | "explicit-auto-check-on"
  | "explicit-auto-check-off"
  | "legacy-enabled-on"
  | "legacy-shipped-default"
  | "absent-default-on";

export interface UpdatePolicy {
  
  autoCheck: boolean;
  
  reason: UpdatePolicyReason;
}









export function decideUpdatePolicy(raw: RawUpdateKeys): UpdatePolicy {
  if (raw.autoCheck === true) { return { autoCheck: true, reason: "explicit-auto-check-on" }; }
  if (raw.autoCheck === false) { return { autoCheck: false, reason: "explicit-auto-check-off" }; }
  if (raw.enabled === true) { return { autoCheck: true, reason: "legacy-enabled-on" }; }
  if (raw.enabled === false) { return { autoCheck: true, reason: "legacy-shipped-default" }; }
  return { autoCheck: true, reason: "absent-default-on" };
}








export function describeUpdatePolicy(p: UpdatePolicy): string {
  switch (p.reason) {
    case "explicit-auto-check-off": return "已按你的设置关闭启动时自动检查（仍可随时手动检查）";
    case "explicit-auto-check-on": return "启动时会自动检查更新（只检查，不会自动下载）";
    case "legacy-enabled-on": return "启动时会自动检查更新";
    case "legacy-shipped-default":
      return "旧版随包默认曾把更新关掉；已按「仅自动检查、绝不自动下载」开启";
    case "absent-default-on": return "启动时会自动检查更新（只检查，不会自动下载）";
  }
}
