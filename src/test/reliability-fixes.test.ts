import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { Store, StoreError } from '../server/store.js';
import { parseCardFields } from '../server/card.js';
import { TarReader } from '../server/tar.js';
import { aiImport } from '../server/aiimport.js';
import { Inbox } from '../server/inbox.js';
import { tempStore, TINY_JPEG, jpegWithExif } from './helpers.js';

test('通常起動中も他PCの保存が成功し、復元は起動時の読み取り完了を待つ', async t => {
  const { store, dataDir, backupDir } = await tempStore();
  const backup = await store.createBackup('manual');
  const second = new Store({ dataDir, backupDir });
  const original = fs.readdir.bind(fs);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  let paused = false;
  const mock = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    if (!paused && args[0] === path.join(dataDir, 'cards')) { paused = true; entered(); await gate; }
    return original(...args);
  });
  const opening = second.open();
  await started;
  let restoring: Promise<unknown> | undefined;
  try {
    await assert.rejects(fs.access(path.join(dataDir, 'locks/maintenance.lock')));
    const card = await store.create(parseCardFields({ company: '架空の同時保存' }));
    await fs.access(path.join(dataDir, 'cards', `${card.id}.json`));
    restoring = store.restore(store.backupPath(backup.name));
    const deadline = Date.now() + 2000;
    while (!(await fs.readdir(path.join(dataDir, 'locks'))).includes('maintenance.lock')) {
      assert.ok(Date.now() < deadline);
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 400));
    await fs.access(path.join(dataDir, 'cards', `${card.id}.json`));
  } finally { release(); await opening; mock.mock.restore(); await restoring; }
  assert.equal(store.list().length, 0);
});

test('破損名刺・孤立画像・ゴミ箱を元バイトで保全してから正常なバックアップへ復元する', async () => {
  const { store, dataDir } = await tempStore();
  const card = await store.create(parseCardFields({ company: '架空の復元対象' }));
  const backup = await store.createBackup('manual');
  const damaged = Buffer.from('{"name":"架空の破損データ",');
  const orphan = await store.putImage(TINY_JPEG);
  await fs.writeFile(path.join(dataDir, 'cards', `${card.id}.json`), damaged);
  await fs.writeFile(path.join(dataDir, 'trash', 'damaged.json'), damaged);
  const result = await store.restore(store.backupPath(backup.name));
  assert.equal(store.get(card.id)?.company, '架空の復元対象');
  assert.equal(store.unreadableCards, 0);
  assert.equal(result.preRestore.kind, 'preservation');
  assert.ok((await store.listBackups()).some(b => b.name === result.preRestore.name));
  const tar = await TarReader.open(store.backupPath(result.preRestore.name));
  try {
    const read = (name: string) => tar.read(tar.entries.find(e => e.name === name)!);
    assert.deepEqual(await read(`cards/${card.id}.json`), damaged);
    assert.deepEqual(await read('trash/damaged.json'), damaged);
    const manifest = JSON.parse((await read('manifest.json')).toString());
    assert.equal(manifest.files[`images/${orphan}.jpg`], crypto.createHash('sha256').update(await read(`images/${orphan}.jpg`)).digest('hex'));
  } finally { await tar.close(); }
  await assert.rejects(Store.verifyArchive(store.backupPath(result.preRestore.name)), /保全用/);
});

test('破損データの保全に失敗したら現在のデータを入れ替えない', async t => {
  const { store, dataDir } = await tempStore();
  const card = await store.create(parseCardFields({ company: '架空' }));
  const backup = await store.createBackup('manual');
  const file = path.join(dataDir, 'cards', `${card.id}.json`);
  await fs.writeFile(file, '{');
  const copy = fs.readFile.bind(fs);
  const mock = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === file && args.length === 1) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return copy(...args);
  });
  await assert.rejects(store.restore(store.backupPath(backup.name)), (e: StoreError) => e.code === 'STORAGE_UNAVAILABLE');
  mock.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), '{');
  assert.ok(!(await fs.readdir(dataDir)).includes('restore-in-progress.json'));
});

test('残留jobsロックはバックアップ停止を通知し、管理者の解除後は再開する', async () => {
  const { store, dataDir } = await tempStore();
  const lock = path.join(dataDir, 'locks/jobs.lock');
  await fs.writeFile(lock, '{}');
  const old = new Date(Date.now() - 60000); await fs.utimes(lock, old, old);
  await assert.rejects(store.autoBackup(24, 14), (e: StoreError) => e.code === 'STALE_LOCK');
  assert.match(store.backupError, /残留ロック/);
  assert.equal(await fs.readFile(lock, 'utf8'), '{}');
  await fs.unlink(lock);
  assert.ok(await store.autoBackup(24, 14));
  assert.equal(store.backupError, '');
});

test('CLI：写真移動失敗を終了コード2で返し、別プロセスで再実行しても二重登録しない', async () => {
  const { store, dataDir, root } = await tempStore();
  const dir = path.join(root, 'inbox'); await fs.mkdir(dir);
  const image = path.join(dir, 'sample.jpg'); await fs.writeFile(image, TINY_JPEG);
  const old = new Date(Date.now() - 60000); await fs.utimes(image, old, old);
  const done = path.join(dataDir, 'inbox-done'); await fs.writeFile(done, 'blocked');
  const form = path.join(root, 'form.json'); await fs.writeFile(form, JSON.stringify({ company: '架空会社のみ', frontImageFile: image }));
  const cli = fileURLToPath(new URL('../server/cli.js', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [cli, 'ai-add', '--data', dataDir, '--inbox', dir, '--json', form]);
  let savedId: string;
  try { await run(); assert.fail('移動失敗を成功扱いしない'); }
  catch (e) {
    const result = e as { code: number; stdout: string };
    assert.equal(result.code, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.registered, 1); assert.equal(report.failed, 1);
    assert.equal(report.results[0].saved, true); assert.equal(report.results[0].ok, false);
    savedId = report.results[0].id;
  }
  await fs.unlink(done);
  const retry = JSON.parse((await run()).stdout);
  assert.equal(retry.registered, 0); assert.equal(retry.alreadyRegistered, 1);
  assert.equal(retry.results[0].id, savedId);
  assert.equal(retry.results[0].movedFromInbox, 1);
  await store.refresh(true); assert.equal(store.list().length, 1);
  const again = JSON.parse((await run()).stdout);
  assert.equal(again.alreadyRegistered, 1, '移動完了後の再実行も既存名刺を返す');
});

test('AI：片面だけ移動失敗しても再起動後に残りの移動だけを再試行する', async t => {
  const { store, dataDir, backupDir, root } = await tempStore();
  const dir = path.join(root, 'inbox'); await fs.mkdir(dir);
  const front = path.join(dir, 'front.jpg'), back = path.join(dir, 'back.jpg');
  const old = new Date(Date.now() - 60000);
  for (const file of [front, back]) { await fs.writeFile(file, file === front ? TINY_JPEG : jpegWithExif()); await fs.utimes(file, old, old); }
  const form = { company: '架空の両面', frontImageFile: front, backImageFile: back };
  const inbox = new Inbox(dir, path.join(dataDir, 'inbox-done'), 90, fn => store.withLock('inbox', fn));
  const copy = fs.copyFile.bind(fs);
  const mock = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    if (args[0] === back) throw new Error('copy failed');
    return copy(...args);
  });
  const [first] = await aiImport(store, form, { baseDir: root, user: 'test', inbox });
  assert.equal(first!.ok, false); assert.equal(first!.movedFromInbox, 1);
  mock.mock.restore();
  const restarted = new Store({ dataDir, backupDir }); await restarted.open();
  const retryInbox = new Inbox(dir, path.join(dataDir, 'inbox-done'), 90, fn => restarted.withLock('inbox', fn));
  const [retry] = await aiImport(restarted, form, { baseDir: root, user: 'test', inbox: retryInbox });
  assert.equal(retry!.ok, true); assert.equal(retry!.alreadyRegistered, true); assert.equal(retry!.id, first!.id);
  assert.equal(retry!.movedFromInbox, 1); assert.equal(restarted.list().length, 1);
  assert.deepEqual(await fs.readdir(dir), []);
  // 記録はバックアップ・復元と通常編集でも失われない。
  await restarted.update(retry!.id!, 1, parseCardFields({ company: '架空の編集後' }));
  const backup = await restarted.createBackup('manual'); await restarted.restore(restarted.backupPath(backup.name));
  assert.equal(restarted.get(retry!.id!)!.aiSources!.length, 2);
});

test('AI：同じ写真を別名で同時登録しても名刺は1件だけ作る', async () => {
  const { store, dataDir, backupDir, root } = await tempStore();
  const second = new Store({ dataDir, backupDir }); await second.open();
  await fs.writeFile(path.join(root, 'a.jpg'), TINY_JPEG); await fs.writeFile(path.join(root, 'b.jpg'), TINY_JPEG);
  const results = await Promise.all([store, second].map((s, i) => aiImport(s, { company: '架空', frontImageFile: i ? 'b.jpg' : 'a.jpg' }, { baseDir: root, user: 'test' })));
  assert.ok(results.every(r => r[0]!.ok));
  assert.equal(results[0]![0]!.id, results[1]![0]!.id);
  await store.refresh(true); assert.equal(store.list().length, 1);
});
