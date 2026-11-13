// 配布ZIPの同梱Nodeで実行する。共有フォルダを初期化せず、既存設定だけを使用する。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, form] = process.argv.slice(2);
async function main() {
  const cli = path.join(root, 'dist/server/cli.js');
  let args;
  if (mode === 'template') args = [cli, 'ai-form'];
  else {
    if (!['check', 'dry-run', 'register'].includes(mode)) throw new Error('使い方: ai.cmd check | template | dry-run <form.json> | register <form.json>');
    const config = JSON.parse((await fs.readFile(path.join(root, 'meishi-config.json'), 'utf8')).replace(/^\uFEFF/, ''));
    for (const key of ['dataDir', 'inboxDir']) {
      if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`${key} に絶対パスを設定してください。`);
    }
    if (path.resolve(config.dataDir).toLowerCase() === path.resolve(config.inboxDir).toLowerCase()) throw new Error('保存先と取り込み用フォルダは別にしてください。');
    await fs.access(config.inboxDir);
    const marker = JSON.parse(await fs.readFile(path.join(config.dataDir, '.meishi-store'), 'utf8'));
    if (marker.format !== 'meishi-store') throw new Error('保存先が名刺データフォルダではありません。初期化は行いません。');
    args = [cli, mode === 'check' ? 'check' : 'ai-add', '--data', config.dataDir];
    if (mode !== 'check') {
      if (!form) throw new Error('フォームJSONのパスを指定してください。');
      const json = path.resolve(form); await fs.access(json);
      args.push('--inbox', config.inboxDir, '--json', json);
      if (mode === 'dry-run') args.push('--dry-run', '--preview', path.join(path.dirname(json), 'preview'));
    }
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code, signal) => { if (signal) reject(new Error(`処理が終了しました: ${signal}`)); else { process.exitCode = code ?? 1; resolve(); } });
  });
}
main().catch(e => { console.error(`処理を中止しました: ${e.message}`); process.exitCode = 1; });
