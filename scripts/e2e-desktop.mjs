// デスクトップアプリ（Electron）の通し確認（開発用）。
//   xvfb-run -a node scripts/e2e-desktop.mjs <作業フォルダ>
// 作業フォルダの中に「共有フォルダ」役のフォルダを作り、PC1・PC2 役の2つのアプリから同時に使う。
// 架空の名刺画像・PDF をその場で生成して使う（実在の名刺は使わない）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { _electron: electron, chromium } = require('playwright');
const { Store } = await import('../dist/server/store.js');
// executablePath指定時はPlaywrightが自動挿入しない起動ローダーを明示する。
// ready前に接続し、起動直後のページを取り逃がす競合を防ぐ（Playwright 1.65）。
const electronLoader = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js');
const electronPath = process.env.MEISHI_E2E_EXECUTABLE || require('electron'); // プロジェクトの devDependencies の Electron

const work = path.resolve(process.argv[2] ?? 'e2e-work');
fs.rmSync(work, { recursive: true, force: true });
const share = path.join(work, 'share');
const dataDir = path.join(share, 'meishi');
const inboxDir = path.join(share, 'meishi-inbox');
fs.mkdirSync(inboxDir, { recursive: true });
// 架空データは明示的に初期化した開発用ストアだけに保存する。
await Store.init(dataDir, path.join(dataDir, 'backups'), { dev: true });
const shots = path.join(work, 'shots');
fs.mkdirSync(shots, { recursive: true });
const step = (s) => console.log(`- ${s}`);
const external = [];
const launched = [];

// 架空の名刺画像（表・裏）と2ページの PDF
const b = await chromium.launch();
const g = await b.newPage();
const draw = (text) => g.evaluate((t) => {
  const c = document.createElement('canvas'); c.width = 1820; c.height = 1100;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
  x.font = '64px sans-serif'; x.fillText(t[0], 120, 180); x.font = '48px sans-serif'; x.fillText(t[1], 120, 330);
  x.font = 'bold 110px sans-serif'; x.fillText(t[2], 120, 500); x.font = '48px sans-serif';
  x.fillText('〒100-0000 東京都千代田区架空町1-2-3', 120, 760); x.fillText('TEL 03-0000-1234', 120, 850); x.fillText(t[3], 120, 940);
  return c.toDataURL('image/jpeg', 0.92);
}, text);
const front = await draw(['架空商事株式会社', '営業部 部長', '見本 次郎', 'jiro@example.invalid']);
const back = await draw(['KAKUU SHOJI Co., Ltd.', 'Sales Dept.', 'Jiro Mihon', 'https://example.invalid']);
const img = path.join(work, 'fake-card.jpg');
fs.writeFileSync(img, Buffer.from(front.split(',')[1], 'base64'));
await g.setContent(`<style>@page{size:91mm 55mm;margin:0}body{margin:0}img{width:91mm;height:55mm;display:block;page-break-after:always}</style><img src="${front}"><img src="${back}">`);
const pdf = path.join(work, 'fake-scan.pdf');
await g.pdf({ path: pdf, width: '91mm', height: '55mm' });
await b.close();

async function launch(name) {
  const app = await electron.launch({ timeout: 30000, executablePath: electronPath, args: ['-r', electronLoader, '.', `--user-data-dir=${path.join(work, `userdata-${name}`)}`, '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, MEISHI_DEV_USER: name === 'pc2' ? 'hanako' : 'taro' } });
  launched.push(app);
  const win = await app.firstWindow({ timeout: 30000 });
  win.on('request', (r) => { const u = r.url(); if (!/^(app|blob|data):/.test(u)) external.push(u); });
  win.on('dialog', (d) => d.accept());
  // BrowserWindow自体を1200x820で起動する。仮想X上のリサイズ応答には依存しない。
  return { app, win };
}

try {
// ---- PC1：初回設定 → 保存先を初期化 ----
let pc1 = await launch('pc1');
let w = pc1.win;
await w.waitForSelector('#s-data');
await w.fill('#s-data', dataDir);
await w.fill('#s-inbox', inboxDir);
await w.fill('#s-name', '見本太郎');
await w.screenshot({ path: path.join(shots, 'setup.png') });
await w.click('text=この設定で開始');
await w.waitForSelector('text=まだ名刺が登録されていません');
if (!fs.existsSync(path.join(dataDir, '.meishi-store'))) throw new Error('保存先が初期化されていない');
if (!JSON.parse(fs.readFileSync(path.join(dataDir, '.meishi-store'), 'utf8')).dev) throw new Error('開発用保存先ではない');
step('PC1: 初回設定で開発用共有フォルダを指定');

// ---- PC1：画像から登録（OCR 候補 → 確認 → 保存） ----
await w.click('#topnav >> text=＋ 新規登録');
await w.waitForSelector('#f-company');
if (await w.locator('#back-image-slot').isVisible()) throw new Error('新規登録では裏面を隠す');
await w.getByRole('button', { name: '＋ 裏面を追加', exact: true }).click();
if (!await w.locator('#back-image-slot').isVisible()) throw new Error('裏面を追加できない');
await w.getByRole('button', { name: '裏面を閉じる', exact: true }).click();
if (await w.locator('#back-image-slot').isVisible()) throw new Error('空の裏面を閉じられない');
await w.locator('.slot').first().locator('input[type=file]').setInputFiles(img);
await w.waitForSelector('text=アップロード完了', { timeout: 30000 });
if (!await w.locator('text=文字を読み取る').count()) throw new Error('OCR が利用できない');
{
  const t0 = Date.now();
  await w.click('text=文字を読み取る');
  await w.waitForSelector('text=読み取り結果（入力候補）', { timeout: 120000 });
  const vals = await w.locator('.ocr-cands input[type=text]').evaluateAll((els) => els.map((e) => e.value));
  step(`PC1: OCR ${((Date.now() - t0) / 1000).toFixed(1)}秒 候補 ${JSON.stringify(vals)}`);
  const phone = await w.locator('.ocr-cands label').filter({ hasText: '電話番号' }).locator('input[type=text]').inputValue();
  if (phone !== '03-0000-1234') throw new Error('OCR の電話番号候補が一致しない');
  await w.click('text=選択した項目を入力欄に反映');
}
await w.fill('#f-company', '架空商事株式会社');
await w.fill('#f-name', '見本 次郎');
await w.fill('#f-memo', '展示会で新製品の説明を受けた');
await w.click('.savebar button[type=submit]');
await w.waitForSelector('img.thumb');
const cardHash = await w.evaluate(() => location.hash);
if (await w.locator('img.thumb').count() !== 1) throw new Error('表面だけで保存できない');
step('PC1: 表面だけで名刺を保存（共有フォルダに保存）');

// ---- PC1：PDF から表裏を登録 ----
await w.click('#topnav >> text=＋ 新規登録');
await w.locator('.slot').first().locator('input[type=file]').setInputFiles(pdf);
await w.waitForFunction(() => document.querySelectorAll('.st.ok').length === 2, null, { timeout: 30000 });
await w.locator('.slot').nth(1).getByRole('button', { name: '文字を読み取る' }).click();
await w.waitForSelector('text=読み取り結果（入力候補）', { timeout: 120000 });
const backText = await w.locator('.ocr-cands .raw').textContent() ?? '';
if (!/KAKUU/i.test(backText)) throw new Error('裏面の英文OCRが取得できない');
await w.getByRole('button', { name: '閉じる', exact: true }).click();
step('PC1: 裏面もOCRできる');
await w.fill('#f-company', '架空PDF商会');
await w.click('.savebar button[type=submit]');
await w.waitForFunction(() => document.querySelectorAll('img.thumb').length === 2, null, { timeout: 10000 });
step('PC1: PDF（2ページ）から表裏の画像を取り出して保存');
await w.getByRole('link', { name: '編集', exact: true }).click();
await w.waitForSelector('#f-company');
if (!await w.locator('#back-image-slot img').isVisible()) throw new Error('保存済みの裏面を編集できない');
if (await w.getByRole('button', { name: '＋ 裏面を追加', exact: true }).isVisible()) throw new Error('保存済みの裏面を空扱いしている');
await w.locator('#back-image-slot').getByRole('button', { name: '削除', exact: true }).click();
if (await w.locator('#back-image-slot').isVisible()) throw new Error('裏面を削除した後に表面だけの表示にならない');
await w.getByRole('link', { name: '← 戻る', exact: true }).click();
await w.waitForFunction(() => document.querySelectorAll('img.thumb').length === 2);
step('PC1: 保存済みの裏面は編集でき、未保存の削除は原本に影響しない');

// ---- PC2：同じ共有フォルダを指定 → PC1 の名刺が見える・編集 ----
const pc2 = await launch('pc2');
const w2 = pc2.win;
await w2.waitForSelector('#s-data');
await w2.fill('#s-data', dataDir);
await w2.fill('#s-name', '試験花子');
await w2.click('text=この設定で開始');
await w2.fill('#q', '新製品');
await w2.waitForSelector('.cardlist >> text=見本 次郎');
step('PC2: 同じ保存先を指定すると PC1 の名刺をメモの内容で検索できる');
// PC1 は編集画面を開いておく（古い版を持った状態）
await w.evaluate((h) => { location.hash = `${h}/edit`; }, cardHash);
await w.waitForSelector('#f-memo');
await w2.click('.cardlist >> text=見本 次郎');
await w2.waitForSelector('text=登録');
const who = await w2.locator('.detail p.small.muted').last().innerText();
if (!who.includes('見本太郎')) throw new Error(`登録者が表示されない: ${who}`);
await w2.click('text=編集');
await w2.fill('#f-memo', 'PC2で追記した内容');
await w2.click('.savebar button[type=submit]');
await w2.waitForSelector('img.thumb');
step('PC2: 登録者（見本太郎）を表示し、編集して保存');
await w.fill('#f-memo', 'PC1の古い画面からの保存');
await w.click('.savebar button[type=submit]');
await w.waitForSelector('text=他の端末でこの名刺が更新されています。');
await w.screenshot({ path: path.join(shots, 'conflict.png') });
await w.click('text=最新の内容を読み込む（入力は破棄）');
await w.waitForFunction(() => document.querySelector('#f-memo')?.value === 'PC2で追記した内容');
step('PC1: 古い版からの保存は競合として止まり、PC2 の変更を読み込める');

// ---- PC2：取り込み用フォルダ（PDF を追加 → ページごとに登録） ----
await w2.close?.();
await pc2.app.close();
fs.copyFileSync(pdf, path.join(inboxDir, 'scan-001.pdf'));
const old = new Date(Date.now() - 60_000);
fs.utimesSync(path.join(inboxDir, 'scan-001.pdf'), old, old);
await w.click('#topnav >> text=未整理');
await w.waitForFunction(() => document.querySelectorAll('.inbox-item').length === 2, null, { timeout: 15000 });
await w.locator('.inbox-item').nth(0).click();
await w.locator('.inbox-item').nth(1).click();
await w.click('text=選んだ画像で登録');
await w.waitForFunction(() => document.querySelectorAll('.st.ok').length === 2, null, { timeout: 30000 });
await w.fill('#f-company', '取込商事');
await w.fill('#f-name', '取込 三郎');
await w.click('.savebar button[type=submit]');
await w.waitForSelector('img.thumb');
if (fs.readdirSync(inboxDir).length) throw new Error(`取り込み用フォルダに残っている: ${fs.readdirSync(inboxDir)}`);
step('PC1: 取り込み用フォルダの PDF をページ画像に分けて表示 → 表裏で登録 → 元ファイルは取り込み済みへ');

// ---- 一覧（名刺画像つき・月ごと）・バックアップ ----
await w.click('#topnav >> text=一覧');
await w.waitForSelector('.cardlist');
await w.screenshot({ path: path.join(shots, 'list.png') });
await w.click('#topnav >> text=管理');
await w.click('text=今すぐバックアップを作成');
await w.waitForSelector('text=手動');
step('PC1: 一覧（名刺画像つき・交換月ごと）、手動バックアップ');

// ---- 再起動後も読める ----
await pc1.app.close();
pc1 = await launch('pc1');
w = pc1.win;
await w.waitForSelector('.cardlist');
const n = await w.locator('.card-row').count();
if (n !== 3) throw new Error(`再起動後の件数が違う: ${n}`);
step('PC1: アプリ再起動後も保存済みの3件を表示');
await pc1.app.close();

if (external.length) { console.log('外部通信あり:', external); process.exit(1); }
console.log('外部通信: なし');
console.log('E2E(desktop) OK');

} finally {
  await Promise.allSettled(launched.map((app) => app.close()));
}
