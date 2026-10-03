/* gui/scripts/extract-frames.mjs — 用 Electron 自带的 Chromium（内置 H.264 解码）
 * 从录像里逐帧抽出 PNG，供"过渡帧对比"取证。
 *
 * 用法：
 *   node_modules/electron/dist/electron.exe scripts/extract-frames.mjs <video> <outDir> [startMs] [endMs] [stepMs]
 *
 * ⚠️ 为什么不用 ffmpeg/cv2：本机都没有（pip 装不上）。Electron 是唯一现成能解 H.264 的。
 * ⚠️ 为什么必须落一个**真实 HTML 文件**：用 data: URL 承载页面时，`file://` 的 <video>
 *    会被当成跨源直接拦掉 ⇒ loadedmetadata 永不触发 ⇒ 静默挂死（本机实测）。
 */
import { app, BrowserWindow } from "electron";
import { writeFileSync, mkdirSync, writeFileSync as wf } from "node:fs";
import { join } from "node:path";

const [videoPath, outDir, startMs, endMs, stepMs] = process.argv.slice(2).filter((a) => a !== "--");
if (!videoPath) { console.error("用法: extract-frames.mjs <video> <outDir> [startMs] [endMs] [stepMs]"); process.exit(2); }
const S = Number(startMs || 0), E = Number(endMs || 8000), STEP = Number(stepMs || 40);
mkdirSync(outDir, { recursive: true });

const htmlPath = join(outDir, "_player.html");
const fileUrl = "file:///" + videoPath.replace(/\\/g, "/");
wf(htmlPath, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<video id="v" style="display:none" muted crossorigin="anonymous"></video><canvas id="c"></canvas>
<script>
const v = document.getElementById("v"), c = document.getElementById("c");
window.__meta = new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("metadata timeout (decode failed?)")), 15000);
  v.onerror = () => { clearTimeout(to); rej(new Error("video error code=" + (v.error && v.error.code))); };
  v.onloadedmetadata = () => {
    clearTimeout(to);
    c.width = v.videoWidth; c.height = v.videoHeight;
    res({ d: v.duration, w: v.videoWidth, h: v.videoHeight });
  };
});
window.__seek = (t) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("seek timeout @" + t)), 10000);
  v.onseeked = () => { clearTimeout(to); c.getContext("2d").drawImage(v, 0, 0); res(c.toDataURL("image/png")); };
  v.onerror = () => { clearTimeout(to); rej(new Error("seek error")); };
  v.currentTime = t;
});
v.src = ${JSON.stringify(fileUrl)};
v.load();
</script></body>`, "utf8");

app.commandLine.appendSwitch("allow-file-access-from-files");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { webSecurity: false } });
  await win.loadFile(htmlPath);
  try {
    const info = await win.webContents.executeJavaScript("window.__meta");
    console.log(`META duration=${info.d.toFixed(3)}s size=${info.w}x${info.h}`);
    const times = [];
    for (let t = S / 1000; t <= Math.min(E / 1000, info.d); t += STEP / 1000) { times.push(t); }
    let n = 0;
    for (const t of times) {
      try {
        const dataUrl = await win.webContents.executeJavaScript(`window.__seek(${t})`);
        const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        writeFileSync(join(outDir, `f${String(Math.round(t * 1000)).padStart(6, "0")}.png`), Buffer.from(b64, "base64"));
        n++;
      } catch (e) { console.log(`seek ${t} failed: ${e.message}`); }
    }
    console.log(`OK frames=${n}/${times.length}`);
  } catch (e) {
    console.log("FAIL " + e.message);
  }
  app.exit(0);
});