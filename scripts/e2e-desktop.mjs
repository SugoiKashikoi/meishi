// デスクトップアプリ（Electron）の通し確認（開発用）。
//   xvfb-run -a node scripts/e2e-desktop.mjs <作業フォルダ>
// 作業フォルダの中に「共有フォルダ」役のフォルダを作り、PC1・PC2 役の2つのアプリから同時に使う。
// 架空の名刺画像・PDF をその場で生成して使う（実在の名刺は使わない）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { _electron: electron, chromium } = require('playwright');
const electronPath = require('electron'); // プロジェクトの devDependencies の Electron

const work = path.resolve(process.argv[2] ?? 'e2e-work');
fs.rmSync(work, { recursive: true, force: true });
const share = path.join(work, 'share');
const dataDir = path.join(share, 'meishi');
const inboxDir = path.join(share, 'meishi-inbox');
fs.mkdirSync(inboxDir, { recursive: true });
const shots = path.join(work, 'shots');
fs.mkdirSync(shots, { recursive: true });
const step = (s) => console.log(`- ${s}`);
const external = [];

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
  const app = await electron.launch({ executablePath: electronPath, args: ['.', `--user-data-dir=${path.join(work, `userdata-${name}`)}`, '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, MEISHI_DEV_USER: name === 'pc2' ? 'hanako' : 'taro' } });
  const win = await app.firstWindow();
  win.on('request', (r) => { const u = r.url(); if (!/^(app|blob|data):/.test(u)) external.push(u); });
  win.on('dialog', (d) => d.accept());
  await win.setViewportSize({ width: 1200, height: 820 }).catch(() => undefined);
  return { app, win };
}

// ---- PC1：初回設定 → 保存先を初期化 ----
let pc1 = await launch('pc1');
let w = pc1.win;
await w.waitForSelector('#s-data');
await w.fill('#s-data', dataDir);
await w.fill('#s-inbox', inboxDir);
await w.fill('#s-name', '見本太郎');
await w.screenshot({ path: path.join(shots, 'setup.png') });
await w.click('text=この設定で開始');
await w.click('text=フォルダを作成して初期化する');
await w.waitForSelector('text=まだ名刺が登録されていません');
if (!fs.existsSync(path.join(dataDir, '.meishi-store'))) throw new Error('保存先が初期化されていない');
step('PC1: 初回設定で共有フォルダを保存先として初期化');

// ---- PC1：画像から登録（OCR 候補 → 確認 → 保存） ----
await w.click('#topnav >> text=＋ 新規登録');
await w.locator('.slot').first().locator('input[type=file]').setInputFiles(img);
await w.waitForSelector('text=アップロード完了', { timeout: 30000 });
if (await w.locator('text=文字を読み取る').count()) {
  const t0 = Date.now();
  await w.click('text=文字を読み取る');
  await w.waitForSelector('text=読み取り結果（入力候補）', { timeout: 120000 });
  const vals = await w.locator('.ocr-cands input[type=text]').evaluateAll((els) => els.map((e) => e.value));
  step(`PC1: OCR ${((Date.now() - t0) / 1000).toFixed(1)}秒 候補 ${JSON.stringify(vals)}`);
  await w.click('text=選択した項目を入力欄に反映');
}
// ChatGPT 読み取り（コピー＆ペースト）：指示文・画像がクリップボードに入り、回答の JSON を貼ると候補になる
await w.click('text=ChatGPTで読み取る');
await w.click('text=指示文をコピー');
await w.waitForTimeout(300);
const clipText = await pc1.app.evaluate(({ clipboard }) => clipboard.readText());
if (!clipText.includes('"company"')) throw new Error('指示文がコピーされていない');
await w.click('text=表面の画像をコピー');
await w.waitForTimeout(800);
const clipImg = await pc1.app.evaluate(({ clipboard }) => clipboard.readImage().getSize());
if (!clipImg.width) throw new Error('画像がコピーされていない');
await w.fill('.ai-read textarea', '読み取り結果です。\n```json\n{"company":"架空商事株式会社","department":"営業部","title":"部長","name":"見本 次郎","kana":"みほん じろう","email":"jiro@example.invalid","phone":"03-0000-1234"}\n```');
await w.click('text=回答を読み込んで候補を表示');
await w.waitForSelector('text=読み取り結果（入力候補）');
await w.click('text=選択した項目を入力欄に反映');
if ((await w.inputValue('#f-kana')) !== 'みほん じろう') throw new Error('ChatGPT の回答が反映されていない');
step(`PC1: ChatGPT 用に指示文・画像（${clipImg.width}x${clipImg.height}）をコピー → 回答を貼り付けて候補を反映`);
await w.fill('#f-company', '架空商事株式会社');
await w.fill('#f-name', '見本 次郎');
await w.fill('#f-memo', '展示会で新製品の説明を受けた');
await w.click('.savebar button[type=submit]');
await w.waitForSelector('img.thumb');
const cardHash = await w.evaluate(() => location.hash);
step('PC1: 名刺を保存（共有フォルダに保存）');

// ---- PC1：PDF から表裏を登録 ----
await w.click('#topnav >> text=＋ 新規登録');
await w.locator('.slot').first().locator('input[type=file]').setInputFiles(pdf);
await w.waitForFunction(() => document.querySelectorAll('.st.ok').length === 2, null, { timeout: 30000 });
await w.fill('#f-company', '架空PDF商会');
await w.click('.savebar button[type=submit]');
await w.waitForFunction(() => document.querySelectorAll('img.thumb').length === 2, null, { timeout: 10000 });
step('PC1: PDF（2ページ）から表裏の画像を取り出して保存');

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
