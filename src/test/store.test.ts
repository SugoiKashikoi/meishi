import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, StoreError, atomicWrite } from '../server/store.js';
import { parseCardFields, ValidationError } from '../server/card.js';
import { sanitizeJpeg } from '../server/jpeg.js';
import { toCsv, cell } from '../server/csv.js';
import { TarReader } from '../server/tar.js';

import { tempStore, jpegWithExif, TINY_JPEG } from './helpers.js';

const f = (x: Record<string, unknown>) => parseCardFields(x);

test('入力検証：会社名か氏名が必須・不正値を拒否', () => {
  assert.throws(() => f({ memo: 'x' }), ValidationError);
  assert.throws(() => f({ name: 'a', category: 'boss' }), ValidationError);
  assert.throws(() => f({ name: 'a', frontImage: '../../etc/passwd' }), ValidationError);
  assert.throws(() => f({ name: 'a', exchangeDate: '2026/1/1' }), ValidationError);
  const ok = f({ company: ' 架空商事 ', tags: ['a', 'a', ' b '], unknown: 'x' });
  assert.equal(ok.company, '架空商事');
  assert.deepEqual(ok.tags, ['a', 'b']);
  assert.equal((ok as unknown as Record<string, unknown>).unknown, undefined);
});

test('作成・更新・再起動後の読み出し・楽観的排他', async () => {
  const { store, dataDir, backupDir } = await tempStore();
  const c = await store.create(f({ company: '架空商事', name: '見本 太郎', memo: '展示会で会った' }));
  const u = await store.update(c.id, 1, f({ company: '架空商事', name: '見本 太郎', memo: '更新' }));
  assert.equal(u.version, 2);
  await assert.rejects(store.update(c.id, 1, f({ name: '古い内容' })), (e: StoreError) => e.code === 'CONFLICT' && e.current?.version === 2);
  await assert.rejects(store.remove(c.id, 1), (e: StoreError) => e.code === 'CONFLICT');
  await store.close();
  const s2 = new Store({ dataDir, backupDir });
  await s2.open();
  assert.equal(s2.get(c.id)?.memo, '更新');
  await s2.remove(c.id, 2);
  assert.equal(s2.get(c.id), undefined);
  assert.equal((await fs.readdir(path.join(dataDir, 'trash'))).length, 1, 'ゴミ箱に移動');
  await s2.close();
});

test('同時保存：同じ版からの並行更新は1件だけ成功し、他は競合になる', async () => {
  const { store } = await tempStore();
  const c = await store.create(f({ name: '並行' }));
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => store.update(c.id, 1, f({ name: `並行${i}` }))));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(rs.filter((r) => r.status === 'rejected' && (r.reason as StoreError).code === 'CONFLICT').length, 4);
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => store.create(f({ name: `n${i}` }))));
  assert.equal(new Set(many.map((m) => m.id)).size, 20);
  await store.close();
});

test('複数の PC：同じ版からの同時更新は PC をまたいでも1件だけ成功', async () => {
  const { store, dataDir, backupDir } = await tempStore();
  const pc2 = new Store({ dataDir, backupDir });
  await pc2.open();
  const c = await store.create(f({ name: '共有' }));
  const rs = await Promise.allSettled([
    ...[1, 2, 3].map((i) => store.update(c.id, 1, f({ name: `PC1-${i}` }))),
    ...[1, 2, 3].map((i) => pc2.update(c.id, 1, f({ name: `PC2-${i}` }))),
  ]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => ['CONFLICT', 'LOCKED'].includes(((r as PromiseRejectedResult).reason as StoreError).code)));
  await pc2.refresh(true);
  assert.equal(pc2.get(c.id)?.version, 2);
  // 更新が止まっても他PCの処理は自動で奪わない
  const lock = path.join(dataDir, 'locks', `card-${c.id}.lock`);
  await fs.writeFile(lock, '{}');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lock, old, old);
  await assert.rejects(store.update(c.id, 2, f({ name: '引き継ぎ' })), (e: StoreError) => e.code === 'LOCKED');
  await fs.unlink(lock); // 全PC停止を確認した管理者の解除を模擬
  assert.equal((await store.update(c.id, 2, f({ name: '引き継ぎ' }))).version, 3);
  await pc2.close();
  await store.close();
});

test('復元中は他の PC の保存を止める', async () => {
  const { store, dataDir, backupDir } = await tempStore();
  const pc2 = new Store({ dataDir, backupDir });
  await pc2.open();
  const c = await store.create(f({ name: '復元前' }));
  const b = await store.createBackup('manual');
  await fs.writeFile(path.join(dataDir, 'locks', 'maintenance.lock'), '{}');
  await assert.rejects(pc2.update(c.id, 1, f({ name: '復元中' })), (e: StoreError) => e.code === 'MAINTENANCE');
  await assert.rejects(pc2.create(f({ name: '復元中' })), (e: StoreError) => e.code === 'MAINTENANCE');
  await fs.unlink(path.join(dataDir, 'locks', 'maintenance.lock'));
  await pc2.create(f({ name: '追加' }));
  await store.restore(store.backupPath(b.name));
  await pc2.refresh(true);
  assert.deepEqual(pc2.list().map((x) => x.name), ['復元前'], '他の PC も復元後の内容を読む');
  await pc2.close();
  await store.close();
});

test('共有フォルダ切断：保存失敗を返し、元の場所に黙って作り直さない', async () => {
  const { store, dataDir, root } = await tempStore();
  const c = await store.create(f({ name: '切断前' }));
  const moved = path.join(root, 'offline');
  await fs.rename(path.join(root, 'share'), moved); // 共有が見えなくなった状態
  await assert.rejects(store.create(f({ name: '切断中' })), (e: StoreError) => e.code === 'STORAGE_UNAVAILABLE');
  await assert.rejects(store.update(c.id, 1, f({ name: '切断中' })), (e: StoreError) => e.code === 'STORAGE_UNAVAILABLE');
  await assert.rejects(store.putImage(TINY_JPEG), (e: StoreError) => e.code === 'STORAGE_UNAVAILABLE');
  assert.equal(fss.existsSync(dataDir), false, '別の場所（ローカル）にフォルダを作っていない');
  assert.equal(store.available, false);
  assert.equal(store.get(c.id)?.name, '切断前', 'メモリ上の内容は変わっていない');
  await fs.rename(moved, path.join(root, 'share'));
  await store.probe();
  assert.equal(store.available, true);
  const again = await store.update(c.id, 1, f({ name: '再接続後' }));
  assert.equal(again.version, 2);
  await store.close();
});

test('古い一時ファイルは起動時に掃除され、壊れたファイルは一覧から除外（削除しない）', async () => {
  const { store, dataDir, backupDir } = await tempStore();
  const c = await store.create(f({ name: '原本' }));
  await store.close();
  await fs.writeFile(path.join(dataDir, 'cards', `.tmp-${c.id}.json-dead`), '{"broken":');
  const old = new Date(Date.now() - 2 * 3600_000);
  await fs.utimes(path.join(dataDir, 'cards', `.tmp-${c.id}.json-dead`), old, old);
  await fs.writeFile(path.join(dataDir, 'cards', '.tmp-writing-now'), '{"other pc":');
  await fs.writeFile(path.join(dataDir, 'cards', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), '{"broken":');
  const s2 = new Store({ dataDir, backupDir });
  await s2.open();
  assert.equal(s2.get(c.id)?.name, '原本');
  assert.equal(s2.list().length, 1);
  const files = await fs.readdir(path.join(dataDir, 'cards'));
  assert.ok(!files.includes(`.tmp-${c.id}.json-dead`), '古い一時ファイルは掃除');
  assert.ok(files.includes('.tmp-writing-now'), '他の PC が書き込み中かもしれない新しい一時ファイルは残す');
  assert.ok(files.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), '壊れたファイルは削除せず残す（一覧からは除外）');
  await s2.close();
});

test('JPEG のメタデータ（EXIF/GPS）を除去・非JPEGを拒否', () => {
  const clean = sanitizeJpeg(jpegWithExif());
  assert.ok(!clean.includes(Buffer.from('GPS')));
  assert.ok(!clean.includes(Buffer.from('Exif')));
  assert.throws(() => sanitizeJpeg(Buffer.from('<svg></svg>')));
  assert.throws(() => sanitizeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
});

test('バックアップと復元（画像込み）・改ざん検出・復元前退避', async () => {
  const { store, dataDir, root } = await tempStore();
  const img = await store.putImage(jpegWithExif());
  const a = await store.create(f({ company: '架空商事', name: '見本', frontImage: img }));
  const b1 = await store.createBackup('manual');
  const r = await TarReader.open(store.backupPath(b1.name));
  assert.deepEqual(r.entries.map((e) => e.name).sort(), [`cards/${a.id}.json`, `images/${img}.jpg`, 'manifest.json'].sort());
  await r.close();
  // バックアップ後に変更・追加
  await store.update(a.id, 1, f({ company: '架空商事', name: '変更後' }));
  await store.create(f({ name: '後から追加' }));
  const res = await store.restore(store.backupPath(b1.name));
  assert.equal(res.summary.cardCount, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(a.id)?.name, '見本');
  assert.ok(fss.existsSync(path.join(dataDir, 'images', `${img}.jpg`)));
  assert.equal(res.preRestore.kind, 'pre-restore');
  const pre = await Store.verifyArchive(store.backupPath(res.preRestore.name));
  assert.equal(pre.cardCount, 2, '復元前のデータが退避されている');
  // 改ざんしたファイルは拒否し、現在のデータは変わらない
  const bad = path.join(root, 'bad.tar');
  const buf = await fs.readFile(store.backupPath(b1.name));
  const i = buf.indexOf(Buffer.from('見本'));
  buf.write('偽物', i);
  await fs.writeFile(bad, buf);
  await assert.rejects(store.restore(bad), (e: StoreError) => e.code === 'INVALID');
  await fs.writeFile(bad, 'not a tar at all');
  await assert.rejects(store.restore(bad), (e: StoreError) => e.code === 'INVALID');
  assert.equal(store.get(a.id)?.name, '見本');
  // 世代管理
  for (let k = 0; k < 3; k++) await store.createBackup('auto');
  await store.pruneBackups(2);
  assert.equal((await store.listBackups()).filter((x) => x.kind === 'auto').length, 2);
  assert.throws(() => store.backupPath('../../etc/passwd'));
  await store.close();
});

test('復元の途中で停止しても、次回起動時に入れ替えを完了する', async () => {
  const { store, dataDir, backupDir } = await tempStore();
  const a = await store.create(f({ name: '旧データ' }));
  await store.close();
  // staging に新データを用意し、cards だけ入れ替わった状態を作る
  const id = '20260101-000000';
  const staging = path.join(dataDir, `restore-staging-${id}`);
  const old = path.join(dataDir, `restore-old-${id}`);
  await fs.mkdir(path.join(staging, 'images'), { recursive: true });
  await fs.mkdir(old, { recursive: true });
  await fs.rename(path.join(dataDir, 'cards'), path.join(old, 'cards'));
  await fs.mkdir(path.join(dataDir, 'cards'));
  const newCard = { ...a, name: '新データ', version: 5 };
  await atomicWrite(path.join(dataDir, 'cards'), `${a.id}.json`, Buffer.from(JSON.stringify(newCard)));
  await atomicWrite(dataDir, 'restore-in-progress.json', Buffer.from(JSON.stringify({ staging, old })));
  const s2 = new Store({ dataDir, backupDir });
  await s2.open();
  assert.equal(s2.get(a.id)?.name, '新データ');
  assert.ok(!fss.existsSync(path.join(dataDir, 'restore-in-progress.json')));
  assert.ok(!fss.existsSync(staging) && !fss.existsSync(old));
  await s2.close();
});

test('CSV：BOM・カンマ・改行・先頭0・数式対策', () => {
  const now = new Date().toISOString();
  const card = { id: 'a'.repeat(32), version: 1, createdAt: now, updatedAt: now, ...f({ company: '架空,商事"', name: '=HYPERLINK("x")', phone: '0312345678', mobile: '+81-90-0000-0000', memo: '1行目\n2行目', tags: ['@tag'] }) };
  const csv = toCsv([card]);
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const s = csv.toString('utf8');
  assert.ok(s.includes('"架空,商事"""'));
  assert.ok(s.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(s.includes('"=""0312345678"""'));
  assert.ok(s.includes('"1行目\n2行目"'));
  assert.ok(s.includes(`"'@tag"`));
  assert.equal(cell('-1+1'), `"'-1+1"`);
  assert.equal(cell('03-1234=SUM(A1)', 'num'), `"03-1234=SUM(A1)"`);
});
