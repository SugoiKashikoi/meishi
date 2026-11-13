// 架空名刺30枚で、文字認識と項目抽出を別々に評価する。実在の名刺は使わない。
// npm run build 後に実行。Playwright は別途必要（本番アプリには不要）。
// NODE_PATH=<Playwrightのnode_modules> node scripts/benchmark-ocr.mjs <出力フォルダ>
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { parseCardText } from '../public/js/ocr.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createWorker } = require('tesseract.js');
const out = path.resolve(process.argv[2] ?? '.test-data/ocr-benchmark');
await fs.mkdir(out, { recursive: true });
const variants = ['standard', 'columns', 'small', 'gray', 'tilted'];
const people = [
  ['架空商事株式会社', '見本 太郎', 'みほん たろう'],
  ['サンプル工業株式会社', '試験 花子', 'しけん はなこ'],
  ['株式会社架空技術', '山田 一郎', 'やまだ いちろう'],
  ['有限会社テスト企画', '鈴木 次郎', 'すずき じろう'],
  ['合同会社架空設計', '佐藤 美咲', 'さとう みさき'],
  ['株式会社サンプル研究所', '高橋 健一', 'たかはし けんいち'],
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' });
const page = await browser.newPage();
const fixtures = [];
try {
  for (let i = 0; i < people.length; i++) for (const variant of variants) {
    const [company, name, kana] = people[i];
    const expected = { company, name, kana, department: '営業部', title: '部長', phone: `03-0000-${String(1000 + i)}`, mobile: `090-0000-${String(2000 + i)}`, email: `sample${i}@example.invalid`, postalCode: '100-0001', address: '東京都千代田区架空町1-2-3' };
    const bytes = await page.evaluate(({ expected: e, variant }) => {
      const c = document.createElement('canvas'); c.width = 1820; c.height = 1100;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      if (variant === 'tilted') { x.translate(80, -40); x.rotate(4 * Math.PI / 180); }
      x.fillStyle = variant === 'gray' ? '#aaa' : '#111';
      const text = (t, left, top, size) => { x.font = `${size}px "Noto Sans CJK JP", sans-serif`; x.fillText(t, left, top); };
      text(e.company, 100, 150, 58); text('営業部 部長', 100, 270, 44);
      text(e.kana, 100, 365, 32); text(e.name, 100, 475, 96);
      const left = variant === 'columns' ? 950 : 100;
      const top = variant === 'columns' ? 570 : 650;
      text('〒' + e.postalCode, left, top, 36);
      text(e.address, left, top + 75, variant === 'columns' ? 30 : 36);
      text('TEL ' + e.phone, 100, 860, 38);
      text('FAX 03-9999-1111', 920, 860, 38);
      text('携帯 ' + e.mobile, 100, 940, 38);
      text(e.email, 100, 1020, 38);
      if (variant === 'small') {
        const s = document.createElement('canvas'); s.width = 910; s.height = 550;
        s.getContext('2d').drawImage(c, 0, 0, 910, 550); return s.toDataURL('image/jpeg', 0.75).split(',')[1];
      }
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }, { expected, variant });
    const file = path.join(out, `${i}-${variant}.jpg`);
    await fs.writeFile(file, Buffer.from(bytes, 'base64'));
    fixtures.push({ id: `${i}-${variant}`, variant, file, expected });
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(out, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
const canonical = s => (s ?? '').normalize('NFKC').toLowerCase().replace(/[\s・]/g, '');
const langPath = process.env.OCR_LANG_PATH ? path.resolve(process.env.OCR_LANG_PATH) : path.resolve('public/vendor/ocr/lang');
const modes = process.env.OCR_PSMS?.split(',') ?? ['default', '3', '11'];
const result = { langPath, generated: new Date().toISOString(), count: fixtures.length, note: 'Synthetic images only; not a real-card accuracy estimate. Same fixtures and parser for each mode.', modes: [] };
for (const psm of modes) {
  const start = performance.now();
  const worker = await createWorker('jpn+eng', 1, { langPath, cacheMethod: 'none', gzip: true });
  const initializationMs = performance.now() - start;
  if (psm !== 'default') await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: psm === '11' ? '1' : '0' });
  const mode = { psm, initializationMs, totals: {}, cases: [] };
  try {
    for (const f of fixtures) {
      const t = performance.now(); const r = await worker.recognize(f.file); const ms = performance.now() - t;
      const candidates = parseCardText(r.data.text);
      const fields = {};
      for (const [key, value] of Object.entries(f.expected)) {
        const exact = canonical(candidates[key]) === canonical(value);
        const inText = canonical(r.data.text).includes(canonical(value));
        fields[key] = { exact, inText };
        const total = mode.totals[key] ??= { exact: 0, inText: 0, count: 0 };
        total.count++; total.exact += Number(exact); total.inText += Number(inText);
      }
      mode.cases.push({ id: f.id, ms, confidence: r.data.confidence, candidates, fields, text: r.data.text });
      console.log(`PSM ${psm}: ${f.id} ${Math.round(ms)}ms`);
    }
  } finally { await worker.terminate(); }
  result.modes.push(mode);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ psm, totals: mode.totals }));
}
