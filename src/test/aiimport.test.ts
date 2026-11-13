import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aiImport, AI_TAG } from '../server/aiimport.js';
import { Inbox } from '../server/inbox.js';
import { tempStore, jpegWithExif, jpegWithSize, makePdf } from './helpers.js';

test('AI専用フォームから直接登録：画像（JPEG/PDF）・分類の日本語名・AI入力タグ・取り込み用フォルダからの移動', async () => {
  const { store, root, dataDir } = await tempStore();
  const inboxDir = path.join(root, 'inbox');
  await fs.mkdir(inboxDir);
  const inbox = new Inbox(inboxDir, path.join(dataDir, 'inbox-done'), 90, (fn) => store.withLock('inbox', fn));
  const old = new Date(Date.now() - 60_000);
  await fs.writeFile(path.join(inboxDir, 'scan-1.jpg'), jpegWithExif());
  await fs.utimes(path.join(inboxDir, 'scan-1.jpg'), old, old);
  const formDir = path.join(root, 'ai');
  await fs.mkdir(formDir);
  await fs.writeFile(path.join(formDir, 'card2.pdf'), makePdf([{ data: jpegWithSize(1200, 700) }, { data: jpegWithSize(1200, 700) }]));
  const forms = [
    { company: '架空商事株式会社', name: '見本 次郎', kana: 'みほん じろう', category: '顧客', tags: ['展示会'], frontImageFile: path.join(inboxDir, 'scan-1.jpg') },
    { company: '架空PDF商会', frontImageFile: 'card2.pdf', phone: null },
    { memo: '会社名も氏名も無い' },
    { company: '画像違い', frontImageFile: 'missing.png' },
  ];
  // 試し実行は何も書かない
  const dry = await aiImport(store, forms.slice(0, 2), { baseDir: formDir, user: 'etokyo37', inbox, dryRun: true });
  assert.ok(dry.every((r) => r.ok && !r.id));
  assert.equal(store.list().length, 0);
  const res = await aiImport(store, forms, { baseDir: formDir, user: 'etokyo37', inbox });
  assert.equal(res[0]!.ok, true);
  assert.equal(res[0]!.movedFromInbox, 1);
  assert.equal(res[1]!.ok, true);
  assert.equal(res[2]!.ok, false);
  assert.match(res[2]!.error!, /会社名または氏名/);
  assert.equal(res[3]!.ok, false);
  const c1 = store.get(res[0]!.id!)!;
  assert.equal(c1.category, 'customer');
  assert.deepEqual(c1.tags, ['展示会', AI_TAG]);
  assert.equal(c1.createdBy, 'etokyo37');
  assert.ok(c1.frontImage);
  const img = await fs.readFile(store.imagePath(c1.frontImage!));
  assert.ok(!img.includes(Buffer.from('GPS')), 'メタデータ除去');
  const c2 = store.get(res[1]!.id!)!;
  assert.ok(c2.frontImage && c2.backImage, 'PDF の2ページ目が裏面');
  assert.deepEqual(await fs.readdir(inboxDir), [], '取り込み用フォルダから移動済み');
  // 同じ名刺をもう一度 → 登録はするが重複候補を返す
  const again = await aiImport(store, { company: '架空商事', name: '見本 次郎' }, { baseDir: formDir, user: 'etokyo37' });
  assert.equal(again[0]!.duplicates!.length, 1);
  await store.close();
});

test('切り抜き・回転：範囲の検証、表裏それぞれに指定、試し実行で確認用画像を書き出す', async () => {
  const { store, root } = await tempStore();
  const formDir = path.join(root, 'ai');
  await fs.mkdir(formDir);
  await fs.writeFile(path.join(formDir, 'photo.jpg'), jpegWithSize(3000, 2000));
  const calls: unknown[] = [];
  const transform = async (jobs: { data: Buffer; crop?: unknown; rotate?: number }[]) => { calls.push(jobs.map((j) => ({ crop: j.crop, rotate: j.rotate }))); return jobs.map(() => jpegWithSize(1600, 1000)); };
  const base = { company: '架空商事', frontImageFile: 'photo.jpg', backImageFile: 'photo.jpg' };
  const bad = await aiImport(store, [
    { ...base, frontCrop: { left: 0.5, top: 0, width: 0.8, height: 0.5 } },
    { ...base, frontRotate: 45 },
    { ...base, frontCrop: { left: 0.1, top: 0.1, width: 0.5 } },
  ], { baseDir: formDir, user: 'u', transform, dryRun: true });
  assert.ok(bad.every((r) => !r.ok));
  const preview = path.join(root, 'preview');
  const ok = await aiImport(store, { ...base, frontCrop: { left: 0.1, top: 0.2, width: 0.8, height: 0.6 }, frontRotate: 90 },
    { baseDir: formDir, user: 'u', transform, dryRun: true, previewDir: preview });
  assert.equal(ok[0]!.ok, true);
  assert.deepEqual(calls.at(-1), [{ crop: { left: 0.1, top: 0.2, width: 0.8, height: 0.6 }, rotate: 90 }, { crop: undefined, rotate: undefined }]);
  assert.deepEqual((await fs.readdir(preview)).sort(), ['1-back.jpg', '1-front.jpg']);
  assert.equal(store.list().length, 0, '試し実行では登録しない');
  const none = await aiImport(store, { ...base, frontRotate: 180 }, { baseDir: formDir, user: 'u' });
  assert.match(none[0]!.error!, /画像処理/);
  await store.close();
});
