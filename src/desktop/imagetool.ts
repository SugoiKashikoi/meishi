/**
 * 画像の切り抜き・回転（AI 登録用の補助ツール。画面は表示しない）。
 *   electron dist/desktop/imagetool.js <ジョブ.json>
 * ジョブ.json: [{ "in": "入力JPEGのパス", "out": "出力パス", "crop": {left,top,width,height}（0〜1の割合・省略可）, "rotate": 0|90|180|270 }]
 * 非表示のウィンドウの canvas で処理し、長辺2000pxまでに縮小した JPEG を書き出す（メタデータは含まれない）。
 * 外部とは通信しない。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';

interface Job { in: string; out: string; crop?: { left: number; top: number; width: number; height: number }; rotate?: number }

const script = `async (b64, crop, rotate) => {
  const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
  const img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c0 = crop || { left: 0, top: 0, width: 1, height: 1 };
  const sx = Math.round(c0.left * img.width), sy = Math.round(c0.top * img.height);
  const sw = Math.max(1, Math.round(c0.width * img.width)), sh = Math.max(1, Math.round(c0.height * img.height));
  const scale = Math.min(1, 2000 / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const r = ((rotate || 0) % 360 + 360) % 360;
  const cv = document.createElement('canvas');
  cv.width = r % 180 ? h : w; cv.height = r % 180 ? w : h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.translate(cv.width / 2, cv.height / 2); g.rotate(r * Math.PI / 180);
  g.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  return cv.toDataURL('image/jpeg', 0.9).split(',')[1];
}`;

app.commandLine.appendSwitch('disable-gpu');
void app.whenReady().then(async () => {
  let code = 0;
  try {
    const jobs = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1]!, 'utf8')) as Job[];
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL('about:blank');
    for (const j of jobs) {
      const c = j.crop;
      if (c && !(c.left >= 0 && c.top >= 0 && c.width > 0 && c.height > 0 && c.left + c.width <= 1.0001 && c.top + c.height <= 1.0001)) {
        throw new Error('切り抜き範囲は 0〜1 の割合で、画像の内側に収まるように指定してください。');
      }
      const b64 = fs.readFileSync(j.in).toString('base64');
      const out = (await win.webContents.executeJavaScript(`(${script})(${JSON.stringify(b64)}, ${JSON.stringify(c ?? null)}, ${Number(j.rotate ?? 0)})`)) as string;
      fs.writeFileSync(j.out, Buffer.from(out, 'base64'));
    }
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    code = 1;
  }
  app.exit(code);
});
