// 開発・保守用のコマンド（通常の利用ではアプリの設定画面を使う）
//   node dist/server/cli.js init-store --data <保存先> [--dev]
//   node dist/server/cli.js check --data <保存先>
//   node dist/server/cli.js seed-dev --data <保存先>     … --dev で作った保存先にだけ架空データを投入
//   node dist/server/cli.js ai-form                      … AI専用フォーム（JSON のひな形）を表示
//   node dist/server/cli.js ai-add --data <保存先> --json <フォーム.json> [--inbox <取り込み用フォルダ>] [--dry-run]
//                                                        … AI が作ったフォームで直接登録（docs/AI登録の手順.md）
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Inbox } from './inbox.js';
import { AI_FORM_TEMPLATE, aiImport } from './aiimport.js';
import { Store } from './store.js';
import { parseCardFields } from './card.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'ai-form') { console.log(JSON.stringify([AI_FORM_TEMPLATE], null, 2)); return; }
  const i = args.indexOf('--data');
  const dataDir = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]!) : '';
  if (!cmd || !dataDir) {
    console.log('使い方: node dist/server/cli.js <init-store [--dev] | check | seed-dev | ai-add --json <フォーム.json>> --data <保存先フォルダ>\n       node dist/server/cli.js ai-form');
    process.exit(cmd ? 1 : 0);
  }
  const backupDir = path.join(dataDir, 'backups');
  if (cmd === 'init-store') {
    await Store.init(dataDir, backupDir, { dev: args.includes('--dev') });
    console.log(`保存先を初期化しました: ${dataDir}`);
    return;
  }
  const s = new Store({ dataDir, backupDir });
  if (cmd === 'check') {
    await s.open();
    const ok = await s.probe();
    console.log(`保存先: ${dataDir}\n名刺件数: ${s.list().length}\n書き込み確認: ${ok ? 'OK' : '失敗 ' + s.lastError}`);
    if (!ok) process.exit(1);
    return;
  }
  if (cmd === 'seed-dev') {
    if (!(await s.isDevStore())) throw new Error('この保存先は開発用（init-store --dev）ではないため、ダミーデータを投入できません。');
    await s.open();
    const samples = [
      { company: '架空商事株式会社', name: '見本 太郎', kana: 'みほん たろう', department: '営業部', title: '課長', phone: '03-0000-0000', email: 'taro@example.invalid', exchangeDate: '2026-04-10', event: 'テスト展示会2026', place: 'テスト会場', category: 'prospect', tags: ['展示会'], memo: '架空のダミーデータです。' },
      { company: 'サンプル工業有限会社', name: '試験 花子', kana: 'しけん はなこ', department: '購買課', title: '主任', mobile: '090-0000-0000', exchangeDate: '2026-05-20', category: 'supplier', tags: ['部品'], memo: 'ダミー。紹介者: 見本さん' },
    ];
    for (const x of samples) await s.create(parseCardFields(x), 'seed');
    console.log(`ダミーデータを ${samples.length} 件投入しました。`);
    return;
  }
  if (cmd === 'ai-add') {
    const j = args.indexOf('--json');
    const file = j >= 0 ? args[j + 1] : undefined;
    if (!file) throw new Error('--json <フォーム.json> を指定してください。');
    const k = args.indexOf('--inbox');
    await s.open();
    const inbox = k >= 0 && args[k + 1] ? new Inbox(path.resolve(args[k + 1]!), path.join(dataDir, 'inbox-done'), 90, (fn) => s.withLock('inbox', fn)) : undefined;
    let input: unknown;
    try { input = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error(`フォームの JSON を読めませんでした: ${(e as Error).message}`); }
    const user = os.userInfo().username.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    const res = await aiImport(s, input, { baseDir: path.dirname(path.resolve(file)), user, inbox, dryRun: args.includes('--dry-run') });
    console.log(JSON.stringify({ dryRun: args.includes('--dry-run'), registered: res.filter((r) => r.ok && r.id).length, failed: res.filter((r) => !r.ok).length, results: res }, null, 2));
    if (res.some((r) => !r.ok)) process.exit(2);
    return;
  }
  throw new Error(`不明なコマンド: ${cmd}`);
}

main().catch((e) => { console.error(`エラー: ${(e as Error).message}`); process.exit(1); });
