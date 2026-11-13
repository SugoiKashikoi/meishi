// OCR エンジンと言語データを node_modules から public/vendor/ocr にコピーする（実行時に外部から取得しないため）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'public', 'vendor', 'ocr');
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
if (!fs.existsSync(path.join(nm, 'tesseract.js'))) { console.log('tesseract.js が無いため OCR は無効になります（手入力は利用可）'); process.exit(0); }
fs.rmSync(out, { recursive: true, force: true });
cp(path.join(nm, 'tesseract.js/dist/tesseract.esm.min.js'), path.join(out, 'tesseract.esm.min.js'));
cp(path.join(nm, 'tesseract.js/dist/worker.min.js'), path.join(out, 'worker.min.js'));
for (const f of fs.readdirSync(path.join(nm, 'tesseract.js-core'))) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) cp(path.join(nm, 'tesseract.js-core', f), path.join(out, 'core', f));
}
for (const l of ['jpn', 'eng']) cp(path.join(nm, `@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`), path.join(out, 'lang', `${l}.traineddata.gz`));
for (const [f, n] of [['tesseract.js/LICENSE.md', 'LICENSE-tesseract.js.txt'], ['tesseract.js-core/LICENSE', 'LICENSE-tesseract.js-core.txt']]) {
  if (fs.existsSync(path.join(nm, f))) cp(path.join(nm, f), path.join(out, n));
}
console.log('OCR ファイルをコピーしました:', out);
