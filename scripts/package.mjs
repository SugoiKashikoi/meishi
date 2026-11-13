// 社内PCへ持ち込むための配布フォルダ release/meishi を作る（実行時の依存パッケージは不要）
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, 'release', 'meishi');
fs.rmSync(out, { recursive: true, force: true });
for (const d of ['dist/server', 'public', 'scripts/windows', 'docs']) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
fs.mkdirSync(path.join(out, 'config'), { recursive: true });
fs.copyFileSync(path.join(root, 'config/config.sample.json'), path.join(out, 'config/config.sample.json'));
for (const f of ['package.json', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
console.log('配布フォルダを作成しました:', out);
