// ブラウザでの通し確認（開発用）。Playwright が入っている環境で実行:
//   node scripts/e2e-check.mjs http://127.0.0.1:18080 <スマホ利用者ID:パスワード> <PC利用者ID:パスワード> <出力先> [取り込み用フォルダ]
// 架空の名刺画像をその場で生成して使う（実在の名刺は使わない）。
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
import path from 'node:path';

const [base, spCred, pcCred, outDir = '.', inboxDir] = process.argv.slice(2);
const origin = new URL(base).origin;
const external = [];
const browser = await chromium.launch();
const watch = (ctx) => ctx.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u); });
const step = (s) => console.log(`- ${s}`);

// 架空の名刺画像を生成
const gen = await browser.newPage();
const dataUrl = await gen.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1820; c.height = 1100;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
  g.font = '64px sans-serif'; g.fillText('架空商事株式会社', 120, 180);
  g.font = '48px sans-serif'; g.fillText('営業部 部長', 120, 330);
  g.font = 'bold 110px sans-serif'; g.fillText('見本 次郎', 120, 500);
  g.font = '48px sans-serif'; g.fillText('〒100-0000 東京都千代田区架空町1-2-3', 120, 760);
  g.fillText('TEL 03-0000-1234', 120, 850); g.fillText('jiro@example.invalid', 120, 940);
  return c.toDataURL('image/jpeg', 0.92);
});
const img = path.join(outDir, 'fake-card.jpg');
fs.writeFileSync(img, Buffer.from(dataUrl.split(',')[1], 'base64'));
await gen.close();

async function login(page, cred) {
  const [uid, password] = cred.split(':');
  await page.goto(base + '/#/login');
  await page.fill('#uid', uid);
  await page.fill('#pw', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('#q');
}

// スマホ（iPhone 相当の画面・UA）
const sp = await browser.newContext({ ...devices['iPhone 13'] });
watch(sp);
const m = await sp.newPage();
m.on('dialog', (d) => d.accept());
await login(m, spCred);
await m.screenshot({ path: path.join(outDir, 'sp-list.png') });
step('スマホ: ログイン・一覧表示');
await m.click('.bottombar a.primary');
await m.waitForSelector('#f-company');
await m.locator('.slot').first().locator('input[capture]').setInputFiles(img);
await m.waitForSelector('text=アップロード完了', { timeout: 30000 });
step('スマホ: 撮影入力から画像アップロード完了');
let ocrUsed = false;
if (await m.locator('text=文字を読み取る').count()) {
  const before = (await (await m.request.get(base + '/api/cards')).json()).cards.length;
  const t0 = Date.now();
  await m.click('text=文字を読み取る');
  await m.waitForSelector('text=読み取り結果（入力候補）', { timeout: 180000 });
  const cands = await m.locator('.ocr-cands label').allInnerTexts();
  step(`スマホ: OCR ${((Date.now() - t0) / 1000).toFixed(1)}秒 候補 ${cands.length} 件`);
  console.log('  候補値:', JSON.stringify(await m.locator('.ocr-cands input[type=text]').evaluateAll((els) => els.map((e) => e.value))));
  const after = (await (await m.request.get(base + '/api/cards')).json()).cards.length;
  if (after !== before) throw new Error('OCR 後に自動保存されている');
  await m.click('text=選択した項目を入力欄に反映');
  ocrUsed = true;
}
await m.fill('#f-company', '架空商事株式会社');
await m.fill('#f-name', '見本 次郎');
await m.fill('#f-memo', 'E2E: 展示会で新製品の説明を受けた');
await m.fill('#f-event', 'E2Eテスト展');
await m.screenshot({ path: path.join(outDir, 'sp-edit.png'), fullPage: true });
await m.click('.savebar button[type=submit]');
await m.waitForURL(/#\/card\/[0-9a-f]{32}$/);
const cardUrl = m.url();
await m.waitForSelector('img.thumb');
step('スマホ: 保存 → 詳細表示（画像あり）');
await m.screenshot({ path: path.join(outDir, 'sp-detail.png'), fullPage: true });

// PC
const pc = await browser.newContext({ viewport: { width: 1280, height: 800 } });
watch(pc);
const p = await pc.newPage();
p.on('dialog', (d) => d.accept());
await login(p, pcCred);
await p.fill('#q', '新製品');
await p.waitForSelector('table.list >> text=見本 次郎');
await p.screenshot({ path: path.join(outDir, 'pc-list.png') });
step('PC: メモ内容で検索ヒット');
await p.click('table.list >> text=見本 次郎');
await p.waitForSelector('img.thumb');
// スマホ側は先に編集画面を開いておく（古い版を持った状態）
await m.goto(cardUrl + '/edit');
await m.waitForSelector('#f-memo');
await p.click('text=編集');
await p.fill('#f-memo', 'PCで追記した内容');
await p.click('.savebar button[type=submit]');
await p.waitForURL(/#\/card\/[0-9a-f]{32}$/);
step('PC: 編集して保存');
await m.fill('#f-memo', 'スマホの古い画面からの保存');
await m.click('.savebar button[type=submit]');
await m.waitForSelector('text=他の端末でこの名刺が更新されています。');
await m.screenshot({ path: path.join(outDir, 'sp-conflict.png'), fullPage: true });
step('スマホ: 古い版からの保存は競合として止まる（上書きしない）');
await m.click('text=最新の内容を読み込む（入力は破棄）');
await m.waitForFunction(() => document.querySelector('#f-memo')?.value === 'PCで追記した内容');
step('スマホ: PCの変更を確認');

// 取り込み用フォルダ経由の登録（PC）
if (inboxDir) {
  const f = path.join(inboxDir, `scan-${Date.now()}.jpg`);
  fs.copyFileSync(img, f);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(f, old, old);
  await p.goto(base + '/#/inbox');
  await p.waitForSelector('.inbox-item');
  await p.screenshot({ path: path.join(outDir, 'pc-inbox.png') });
  await p.click('.inbox-item');
  await p.click('text=選んだ画像で登録');
  await p.waitForSelector('text=アップロード完了', { timeout: 30000 });
  await p.fill('#f-company', '架空物産株式会社');
  await p.fill('#f-name', '取込 三郎');
  await p.click('.savebar button[type=submit]');
  await p.waitForURL(/#\/card\/[0-9a-f]{32}$/);
  await p.waitForSelector('img.thumb');
  if (fs.existsSync(f)) throw new Error('取り込み用フォルダに元画像が残っている');
  step('PC: 取り込み用フォルダの画像から登録 → 元画像は取り込み済みへ移動');
  // スマホ（別の利用者）から検索して確認
  await m.goto(base + '/#/');
  await m.fill('#q', '取込');
  await m.waitForSelector('.cards >> text=取込 三郎');
  step('スマホ: 他の利用者が登録した名刺を検索で確認');
}

// 未ログインでの画像取得
const anon = await browser.newContext();
const imgSrc = await p.locator('img.thumb').first().getAttribute('src');
const r = await anon.request.get(base + imgSrc);
if (r.status() !== 401) throw new Error('未ログインで画像が取得できてしまう');
step('未ログイン: 画像は 401');

await browser.close();
if (external.length) { console.log('外部通信あり:', external); process.exit(1); }
console.log(`外部通信: なし（OCR ${ocrUsed ? '使用' : '未使用'}）`);
console.log('E2E OK');
