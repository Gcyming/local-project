#!/usr/bin/env node
/**
 * hello-slime 示例脚本工具。
 *
 * 契约（宿主保证，平台唯一能安全跑扩展代码的形态）：
 *   · 一次性子进程：cwd = 本扩展目录；30s 超时；stdout 上限 256KB；
 *   · 输入：stdin 的 JSON（{ prompt }）；输出：stdout 作为工具结果；
 *   · 拿不到任何宿主对象（不注入 registry / fs 桥 / ipcMain）——沙箱是结构性的。
 *
 * ⚠️ 本文件只在用户于「扩展」页点过「信任脚本」之后才会被装配为工具（默认拒绝）。
 */
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
}

let prompt = "";
try {
  const input = JSON.parse(raw || "{}");
  prompt = typeof input?.prompt === "string" ? input.prompt : "";
} catch {
  prompt = "";
}

const now = new Date().toLocaleString();
console.log(`[hello-slime] 现在是 ${now}。`);
console.log(`你说：「${prompt || "（空）"}」—— 收到。`);
console.log("（本结果来自扩展自带脚本：cwd 限定在扩展目录、30s 超时、无任何宿主对象。关掉信任开关即消失。）");
