// 開発・保守用のコマンド（通常の利用ではアプリの設定画面を使う）
//   node dist/server/cli.js init-store --data <保存先> [--dev]
//   node dist/server/cli.js check --data <保存先>
//   node dist/server/cli.js seed-dev --data <保存先>     … --dev で作った保存先にだけ架空データを投入
import path from 'node:path';
import { Store } from './store.js';
import { parseCardFields } from './card.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const i = args.indexOf('--data');
  const dataDir = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]!) : '';
  if (!cmd || !dataDir) {
    console.log('使い方: node dist/server/cli.js <init-store [--dev] | check | seed-dev> --data <保存先フォルダ>');
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
  throw new Error(`不明なコマンド: ${cmd}`);
}

main().catch((e) => { console.error(`エラー: ${(e as Error).message}`); process.exit(1); });
