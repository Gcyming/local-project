



























export const CHEER_AFTER_MS = 5000;


export const CHEER_ROTATE_MS = 4000;
















export const CHEER_PHRASES: readonly string[] = [
  "稍等一下，我在这条路上跑着呢 🏃",
  "别急，好东西值得多等三秒 🍀",
  "正在卖力干活，给你表演个原地起飞 🚀",
  "脑子正在高速转，风扇都快起飞了 🌀",
  "这条路有点长，但我一步没停 🐾",
  "稳住，我保证不摸鱼 🐟❌",
  "咖啡已经备好，我继续冲 ☕",
  "进度条在走，就是有点磨叽 😤",
  "正在把它啃下来，一口一口的那种 🍖",
  "再等等，我在跟工具搏斗 ⚔️",
  "耐心值 +1，回报值 +99 ✨",
  "看起来简单，做起来真的在干活 💪",
  "我还在线，没有卡死，放心 👀",
  "正在慢慢变强，马上就好 🌱",
  "这一小步有点费劲，但值得 🌟",
  "别眨眼，惊喜常常在最后一下 🎁",
  "认真起来我自己都怕 🔥",
  "稍安勿躁，惊喜正在组装中 🧩",
];








export function shouldCheer(stageMs: number): boolean {
  return Number.isFinite(stageMs) && stageMs >= CHEER_AFTER_MS;
}





export function pickCheer(seed: number): string {
  const n = CHEER_PHRASES.length;
  if (!Number.isFinite(seed)) { return CHEER_PHRASES[0]!; }
  const i = ((Math.trunc(seed) % n) + n) % n;
  return CHEER_PHRASES[i]!;
}
