import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'SHA256.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new Error('不正な検証対象パス');
    const hash = crypto.createHash('sha256');
    const handle = await fs.open(file, 'r');
    try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
    finally { await handle.close(); }
    if (hash.digest('hex') !== expected) throw new Error(`ファイルが変更または破損しています: ${name}`);
  }
  console.log(`配布ファイルの整合性: OK (${Object.keys(manifest.files).length} files)`);
} catch (e) { console.error(`起動を中止しました: ${e.message}`); process.exitCode = 1; }
