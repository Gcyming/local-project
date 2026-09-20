/**
 * 用 Electron 的 nativeImage 做无损放大 + 裁剪，用于精确判读截图几何。
 * 为什么不用图像库：本项目未装 sharp/jimp，nativeImage 是随 Electron 现成的、零依赖。
 * 跑法：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/zoom.cjs
 */
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "out", "_zoom");

/** crop+放大：rect 为原图像素坐标，scale 为放大倍数（nearest 保边缘锐利，便于量像素） */
function zoom(src, rect, scale, name) {
  const img = nativeImage.createFromPath(src);
  const size = img.getSize();
  const cropped = img.crop({
    x: Math.max(0, rect.x), y: Math.max(0, rect.y),
    width: Math.min(rect.w, size.width - Math.max(0, rect.x)),
    height: Math.min(rect.h, size.height - Math.max(0, rect.y)),
  });
  const big = cropped.resize({ width: Math.round(cropped.getSize().width * scale), height: Math.round(cropped.getSize().height * scale), quality: "best" });
  const p = path.join(OUT, name + ".png");
  fs.writeFileSync(p, big.toPNG());
  console.log(`${name}: 原图 ${size.width}x${size.height} → 裁剪 ${cropped.getSize().width}x${cropped.getSize().height} → ${big.getSize().width}x${big.getSize().height}  ${p}`);
}

app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const CLIP = "C:/Users/MR/.workbuddy/clipboard-images";
  // 图 065Z：成功/失败徽标区（徽标在 x≈205..305，y≈60..330）
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-065Z-51a49c90.png`, { x: 190, y: 55, w: 130, h: 280 }, 5, "badges");
  // 图 f26f6110：红色停止按钮（在右下角，x≈285..355，y≈285..350）
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-067Z-f26f6110.png`, { x: 275, y: 280, w: 90, h: 80 }, 6, "stopbtn");
  // 图 9d62e4bd：活动记录「完成」行
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-066Z-9d62e4bd.png`, { x: 20, y: 60, w: 220, h: 130 }, 4, "activity");
  // 图 2438ef72：通知标题
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-066Z-2438ef72.png`, { x: 60, y: 110, w: 300, h: 80 }, 4, "notif");
  app.exit(0);
});
