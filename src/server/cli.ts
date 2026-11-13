// 開発・保守用のコマンド（通常の利用ではアプリの設定画面を使う）
//   node dist/server/cli.js init-store --data <保存先> [--dev]
//   node dist/server/cli.js check --data <保存先>
//   node dist/server/cli.js seed-dev --data <保存先>     … --dev で作った保存先にだけ架空データを投入
//   node dist/server/cli.js ai-form                      … AI専用フォーム（JSON のひな形）を表示
//   node dist/server/cli.js ai-add --data <保存先> --json <フォーム.json> [--inbox <取り込み用フォルダ>] [--dry-run] [--preview <確認用フォルダ>]
//                                                        … AI が作ったフォームで直接登録（docs/AI登録の手順.md）
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Inbox } from './inbox.js';
import { AI_FORM_TEMPLATE, aiImport, ImageTransform } from './aiimport.js';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

/** 画像の切り抜き・回転：Electron（devDependencies）の画像処理を画面なしで呼ぶ */
const electronTransform: ImageTransform = async (jobs) => {
  let electronPath: string;
  try { electronPath = createRequire(import.meta.url)('electron') as unknown as string; }
  catch { throw new Error('画像の切り抜きには Electron が必要です（このフォルダで npm ci を実行してください）。'); }
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'imagetool.js');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'meishi-img-'));
  try {
    const list = await Promise.all(jobs.map(async (j, n) => {
      const inF = path.join(work, `in-${n}.jpg`);
      await fs.writeFile(inF, j.data);
      return { in: inF, out: path.join(work, `out-${n}-${crypto.randomBytes(3).toString('hex')}.jpg`), crop: j.crop, rotate: j.rotate };
    }));
    const jobFile = path.join(work, 'jobs.json');
    await fs.writeFile(jobFile, JSON.stringify(list));
    await new Promise<void>((resolve, reject) => {
      // Linux の root（検証用コンテナ）だけは Chromium の制約で --no-sandbox が必要。Windows では付けない
      const extra = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
      execFile(electronPath, [...extra, tool, jobFile], { timeout: 120_000, windowsHide: true }, (err, _o, stderr) => {
        if (err) reject(new Error(`画像の切り抜きに失敗しました: ${String(stderr).trim() || err.message}`)); else resolve();
      });
    });
    return await Promise.all(list.map((j) => fs.readFile(j.out)));
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
};
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
    const pv = args.indexOf('--preview');
    const previewDir = pv >= 0 && args[pv + 1] ? path.resolve(args[pv + 1]!) : undefined;
    const res = await aiImport(s, input, { baseDir: path.dirname(path.resolve(file)), user, inbox, dryRun: args.includes('--dry-run'), transform: electronTransform, previewDir });
    console.log(JSON.stringify({ dryRun: args.includes('--dry-run'), registered: res.filter((r) => r.ok && r.id).length, failed: res.filter((r) => !r.ok).length, results: res }, null, 2));
    if (res.some((r) => !r.ok)) process.exit(2);
    return;
  }
  throw new Error(`不明なコマンド: ${cmd}`);
}

main().catch((e) => { console.error(`エラー: ${(e as Error).message}`); process.exit(1); });
