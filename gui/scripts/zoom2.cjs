const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const OUT = path.join(__dirname, "..", "out", "_zoom2");
function zoom(src, rect, scale, name) {
  const img = nativeImage.createFromPath(src);
  const size = img.getSize();
  const cropped = img.crop({
    x: Math.max(0, rect.x), y: Math.max(0, rect.y),
    width: Math.min(rect.w, size.width - Math.max(0, rect.x)),
    height: Math.min(rect.h, size.height - Math.max(0, rect.y)),
  });
  const big = cropped.resize({ width: Math.round(cropped.getSize().width * scale), height: Math.round(cropped.getSize().height * scale), quality: "best" });
  fs.writeFileSync(path.join(OUT, name + ".png"), big.toPNG());
  console.log(`${name}: 原图 ${size.width}x${size.height} → ${cropped.getSize().width}x${cropped.getSize().height} → ${big.getSize().width}x${big.getSize().height}`);
}
app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const CLIP = "C:/Users/MR/.workbuddy/clipboard-images";
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-067Z-f26f6110.png`, { x: 240, y: 230, w: 120, h: 92 }, 6, "stopbtn");
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-066Z-9d62e4bd.png`, { x: 20, y: 55, w: 230, h: 120 }, 4, "activity");
  zoom(`${CLIP}/clipboard-2026-09-19T11-22-11-066Z-2438ef72.png`, { x: 55, y: 105, w: 320, h: 60 }, 4, "notif");
  app.exit(0);
});
