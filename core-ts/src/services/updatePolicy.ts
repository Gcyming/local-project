/**
 * core-ts/src/services/updatePolicy.ts — 自动更新的**策略判据**（A-1059③）。
 *
 * 纯模块：不读文件、不碰 electron、不知道 TOML 长什么样 —— 只接收"解析后的键值"。
 * 便于单测与变异（项目铁律：判据住纯模块，装配层只接线）。
 *
 * ## 它修的是什么
 *
 * 用户原话：「我叫你换成手动点击更新，你**怎能直接关了**？」
 *
 * 上一轮（A-1055）为治"翻到设置页就偷偷下载 500MB"把 `autoDownload` 关掉了 —— 这是对的一半。
 * 但同时**随包模板 `gui/template/slime.toml` 自己写了 `[update] enabled = false`**，
 * 于是全新安装/升级上来的用户看到的就是「自动检查未开启」：
 * 从用户视角，**这不是"改成了手动更新"，而是"把更新功能关掉了"**。
 *
 * ## 现在的语义（三件事分开，不再耦合）
 *
 * | 行为 | 谁决定 | 默认 |
 * | --- | --- | --- |
 * | **检查**（只读一次 GitHub release 元数据） | `auto_check` | **开** |
 * | **下载**（几百 MB） | 只有用户点「下载更新」 | 永不自动 |
 * | **安装** | 只有用户点「安装并重启」 | 永不自动 |
 *
 * 检查是廉价且只读的，默认开启才能真正服务用户（"有新版本"这件事必须让他知道）；
 * 真正昂贵、有副作用的下载/安装一律**只能由点击触发**（这一条是代码层不变量，不设开关）。
 *
 * ## `enabled = false` 为什么被当成"不是用户意图"
 *
 * 这个值**是我们自己的模板发出去的**（见 `gui/template/slime.toml`），
 * 而同一个模板里的注释却写着"删掉本段 = 打开自动更新" —— 自相矛盾。
 * 所以对**装有旧版的机器**，`enabled=false` 既不能证明用户想关，
 * 也不该让用户永远停在没有更新的版本上：判为 `legacy-shipped-default` → **开**（`reason` 留痕）。
 * 用户真想关，用显式的新键 `auto_check = false`（模板里已给出）。
 */

/** 解析后的原始键值（未给 = undefined，与"给了 false"是两件事） */
export interface RawUpdateKeys {
  /** 新键：启动时自动检查（权威） */
  autoCheck?: boolean;
  /** 旧键：历史上同时表示"启用更新"，实际被模板写成了 false */
  enabled?: boolean;
}

export type UpdatePolicyReason =
  | "explicit-auto-check-on"
  | "explicit-auto-check-off"
  | "legacy-enabled-on"
  | "legacy-shipped-default"
  | "absent-default-on";

export interface UpdatePolicy {
  /** 是否在启动时自动检查（延迟执行，只读元数据） */
  autoCheck: boolean;
  /** 判据来源，用于日志与界面文案（不许吞掉） */
  reason: UpdatePolicyReason;
}

/**
 * 唯一的策略判据。顺序即优先级：
 *
 * 1. 显式 `auto_check` —— 权威，尊重用户
 * 2. 旧键 `enabled = true` —— 明确表达过"要"
 * 3. 旧键 `enabled = false` —— **我们模板发的默认值**，不是用户意图 → 判为 legacy，开启并留痕
 * 4. 都没给 —— 默认开启
 */
export function decideUpdatePolicy(raw: RawUpdateKeys): UpdatePolicy {
  if (raw.autoCheck === true) { return { autoCheck: true, reason: "explicit-auto-check-on" }; }
  if (raw.autoCheck === false) { return { autoCheck: false, reason: "explicit-auto-check-off" }; }
  if (raw.enabled === true) { return { autoCheck: true, reason: "legacy-enabled-on" }; }
  if (raw.enabled === false) { return { autoCheck: true, reason: "legacy-shipped-default" }; }
  return { autoCheck: true, reason: "absent-default-on" };
}

/**
 * 判据来源 → 一句人话。
 *
 * 用处有二：① 主进程日志里说清"为什么这次会/不会检查"，避免又变成静默行为；
 * ② 界面在"未自动检查"时可以如实交代原因（是用户显式关的，还是别的）。
 * ⚠️ 文案里**不许**出现"功能已关闭"这种把"检查"说成"整个更新"的措辞 —— 那正是用户误会的来源。
 */
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
