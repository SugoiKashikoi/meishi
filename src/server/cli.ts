import readline from 'node:readline';
import { loadConfig, defaultConfigDir } from './config.js';
import { Store, atomicWrite } from './store.js';
import { writePassword } from './auth.js';
import { parseCardFields } from './card.js';

function askHidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    out._writeToOutput = (s: string) => { if (!asked) { process.stdout.write(s); asked = true; } };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'set-password') {
    const configDir = defaultConfigDir();
    let pw = process.env.MEISHI_NEW_PASSWORD;
    if (!pw) {
      pw = await askHidden('新しいパスワード（10文字以上）: ');
      const pw2 = await askHidden('もう一度入力: ');
      if (pw !== pw2) throw new Error('パスワードが一致しません。');
    }
    writePassword(configDir, pw);
    console.log('パスワードを設定しました（既存のログインはすべて無効になりました）。');
    return;
  }
  const config = loadConfig();
  if (cmd === 'init-store') {
    await Store.init(config.dataDir, config.backupDir, { dev: args.includes('--dev') });
    console.log(`保存先を初期化しました: ${config.dataDir}`);
    return;
  }
  if (cmd === 'check') {
    const s = new Store({ dataDir: config.dataDir, backupDir: config.backupDir });
    await s.open();
    const ok = await s.probe();
    console.log(`保存先: ${config.dataDir}\nバックアップ先: ${config.backupDir}\n名刺件数: ${s.list().length}\n書き込み確認: ${ok ? 'OK' : '失敗 ' + s.lastError}`);
    await s.close();
    if (!ok) process.exit(1);
    return;
  }
  if (cmd === 'seed-dev') {
    // 架空のダミーデータ。--dev で初期化した保存先にだけ投入できる（本番データと混ざらないように）
    const s = new Store({ dataDir: config.dataDir, backupDir: config.backupDir });
    if (!(await s.isDevStore())) throw new Error('この保存先は開発用（init-store --dev）ではないため、ダミーデータを投入できません。');
    await s.open();
    const samples = [
      { company: '架空商事株式会社', name: '見本 太郎', kana: 'みほん たろう', department: '営業部', title: '課長', phone: '03-0000-0000', email: 'taro@example.invalid', exchangeDate: '2026-04-10', event: 'テスト展示会2026', place: 'テスト会場', category: 'prospect', tags: ['展示会'], memo: '架空のダミーデータです。' },
      { company: 'サンプル工業有限会社', name: '試験 花子', kana: 'しけん はなこ', department: '購買課', title: '主任', mobile: '090-0000-0000', exchangeDate: '2026-05-20', category: 'supplier', tags: ['部品'], memo: 'ダミー。紹介者: 見本さん' },
    ];
    for (const x of samples) await s.create(parseCardFields(x));
    await s.close();
    console.log(`ダミーデータを ${samples.length} 件投入しました。`);
    return;
  }
  if (cmd === 'unlock') {
    // サーバーが異常終了して .lock が残り、起動を拒否される場合に使う（2分経過すれば自動で無視される）
    await atomicWrite(config.dataDir, '.lock', Buffer.from('{}'));
    console.log('ロックを解除しました。');
    return;
  }
  console.log('使い方: node dist/server/cli.js <set-password|init-store [--dev]|check|seed-dev|unlock>');
}

main().catch((e) => { console.error(`エラー: ${(e as Error).message}`); process.exit(1); });
