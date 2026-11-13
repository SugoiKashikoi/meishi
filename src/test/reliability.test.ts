import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, StoreError, atomicWrite } from '../server/store.js';
import { parseCardFields } from '../server/card.js';
import { Inbox, InboxGoneError } from '../server/inbox.js';
import { TarWriter, TarReader } from '../server/tar.js';
import type { FileHandle } from 'node:fs/promises';
import { tempStore, makePdf, jpegWithSize, TINY_JPEG } from './helpers.js';

// cards/images の各 rename とマーカー削除の境界をすべて再現。
for (let boundary = 0; boundary <= 4; boundary++) {
  test(`復元：ディレクトリrename ${boundary}回後に停止しても回復する`, async () => {
    const { store, dataDir, backupDir } = await tempStore();
    const c = await store.create(parseCardFields({ name: '旧名刺' }));
    const staging = path.join(dataDir, 'restore-staging-20260101-000000');
    const old = path.join(dataDir, 'restore-old-20260101-000000');
    await fs.mkdir(path.join(staging, 'cards'), { recursive: true });
    await fs.mkdir(path.join(staging, 'images'));
    await fs.mkdir(old);
    await atomicWrite(path.join(staging, 'cards'), `${c.id}.json`, Buffer.from(JSON.stringify({ ...c, name: '新名刺' })));
    const moves = [
      [path.join(dataDir, 'cards'), path.join(old, 'cards')],
      [path.join(staging, 'cards'), path.join(dataDir, 'cards')],
      [path.join(dataDir, 'images'), path.join(old, 'images')],
      [path.join(staging, 'images'), path.join(dataDir, 'images')],
    ];
    await atomicWrite(dataDir, 'restore-in-progress.json', Buffer.from(JSON.stringify({ staging, old })));
    for (const [a, b] of moves.slice(0, boundary)) await fs.rename(a!, b!);
    const restarted = new Store({ dataDir, backupDir });
    await restarted.open();
    assert.equal(restarted.get(c.id)?.name, '新名刺');
    assert.equal((await fs.readdir(dataDir)).includes('restore-in-progress.json'), false);
    await restarted.close();
  });
}

test('ロック：更新停止をスリープと区別できない場合、二重取得を拒否する', async () => {
  const { store, dataDir } = await tempStore();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const pause = new Promise<void>((r) => { release = r; });
  const first = store.withLock('review', async () => { entered(); await pause; });
  await started;
  try {
    const lock = path.join(dataDir, 'locks/review.lock');
    const before = await fs.readFile(lock, 'utf8');
    const old = new Date(Date.now() - 60000);
    await fs.utimes(lock, old, old);
    let called = false;
    await assert.rejects(store.withLock('review', async () => { called = true; }, 0), (e: StoreError) => e.code === 'LOCKED');
    assert.equal(called, false);
    assert.equal(await fs.readFile(lock, 'utf8'), before);
  } finally { release(); await first; }
});

test('復元中の起動は空のcardsを作らず、読み書きも停止する', async () => {
  const { store, dataDir, backupDir } = await tempStore();
  const c = await store.create(parseCardFields({ name: '架空' }));
  await fs.writeFile(path.join(dataDir, 'locks/maintenance.lock'), '{}');
  await fs.rename(path.join(dataDir, 'cards'), path.join(dataDir, 'cards-paused'));
  await assert.rejects(new Store({ dataDir, backupDir }).open(), (e: StoreError) => e.code === 'MAINTENANCE');
  await assert.rejects(store.refresh(), (e: StoreError) => e.code === 'MAINTENANCE');
  await assert.rejects(store.getFresh(c.id), (e: StoreError) => e.code === 'MAINTENANCE');
  await assert.rejects(store.create(parseCardFields({ name: '停止' })), (e: StoreError) => e.code === 'MAINTENANCE');
  await assert.rejects(fs.access(path.join(dataDir, 'cards')));
});

test('壊れた名刺があるとバックアップ・画像の掃除を中止し原本を残す', async () => {
  const { store, dataDir } = await tempStore();
  const image = await store.putImage(TINY_JPEG);
  const imageFile = store.imagePath(image);
  const old = new Date(Date.now() - 48 * 3600000);
  await fs.utimes(imageFile, old, old);
  await fs.writeFile(path.join(dataDir, 'cards', `${'a'.repeat(32)}.json`), '{"name":"PRIVATE-CONTACT",');
  await assert.rejects(store.createBackup('manual'), (e: StoreError) => e.code === 'INVALID');
  await assert.rejects(store.gcImages(), (e: StoreError) => e.code === 'INVALID');
  await fs.access(imageFile);
});

test('PDF：既存名と衝突せず、異なる内容の同名PDFも別画像として取り込む', async () => {
  const { store, dataDir, root } = await tempStore();
  const dir = path.join(root, 'inbox'); await fs.mkdir(dir);
  const inbox = new Inbox(dir, path.join(dataDir, 'inbox-done'), 90, fn => store.withLock('inbox', fn));
  const old = new Date(Date.now() - 20000);
  await fs.writeFile(path.join(dir, 'scan-p01.jpg'), 'unrelated');
  const put = async (width: number) => {
    await fs.writeFile(path.join(dir, 'scan.pdf'), makePdf([{ data: jpegWithSize(width, 300) }]));
    await fs.utimes(path.join(dir, 'scan.pdf'), old, old);
    await inbox.scan();
  };
  await put(400); await put(500);
  const names = await fs.readdir(dir);
  assert.equal(names.filter(n => /^scan-[a-f0-9]{64}-p01.jpg$/.test(n)).length, 2);
  assert.equal(await fs.readFile(path.join(dir, 'scan-p01.jpg'), 'utf8'), 'unrelated');
  assert.ok(!names.includes('scan.pdf'));
});

test('未整理：一覧取得後に同名ファイルが置換されたら登録も移動もしない', async () => {
  const { store, dataDir, root } = await tempStore();
  const dir = path.join(root, 'inbox'); await fs.mkdir(dir);
  const file = path.join(dir, 'card.jpg');
  await fs.writeFile(file, TINY_JPEG);
  const old = new Date(Date.now() - 20000); await fs.utimes(file, old, old);
  const inbox = new Inbox(dir, path.join(dataDir, 'inbox-done'), 90, fn => store.withLock('inbox', fn));
  const [it] = await inbox.scan();
  await fs.writeFile(file, 'replacement');
  let registered = false;
  await assert.rejects(inbox.completeWith([it!.id], 'registered', async () => { registered = true; }), InboxGoneError);
  assert.equal(registered, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement');
});

test('強制再読み込みは同じサイズ・更新日時でも変更を検知する', async () => {
  const { store, dataDir } = await tempStore();
  const c = await store.create(parseCardFields({ name: '架空一郎' }));
  const file = path.join(dataDir, 'cards', `${c.id}.json`);
  const stat = await fs.stat(file);
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('架空一郎', '架空次郎'));
  await fs.utimes(file, stat.atime, stat.mtime);
  await store.refresh(true);
  assert.equal(store.get(c.id)?.name, '架空次郎');
});


test('バックアップI/O：短いwrite/readでも全バイトを保存・復元する', async (t) => {
  const disk = Buffer.alloc(8192);
  let size = 0;
  const handle = {
    write: async (b: Buffer, offset: number, length: number, position: number) => {
      const bytesWritten = Math.min(length, 7);
      b.copy(disk, position, offset, offset + bytesWritten);
      size = Math.max(size, position + bytesWritten);
      return { bytesWritten, buffer: b };
    },
    read: async (b: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.min(length === 512 ? length : 5, size - position, length);
      disk.copy(b, offset, position, position + bytesRead);
      return { bytesRead, buffer: b };
    },
    sync: async () => {}, close: async () => {}, stat: async () => ({ size }),
  } as unknown as FileHandle;
  t.mock.method(fs, 'open', async () => handle);
  const body = Buffer.from('架空のバックアップデータ'.repeat(10));
  const writer = await TarWriter.create('fake');
  await writer.add('fixture.txt', body);
  await writer.finish();
  const reader = await TarReader.open('fake');
  assert.equal(reader.entries.length, 1);
  assert.deepEqual(await reader.read(reader.entries[0]!), body);
  await reader.close();
});

test('復元は進行中の読み取りロックの解放を待つ', async () => {
  const { store, dataDir } = await tempStore();
  const c = await store.create(parseCardFields({ name: '退避済み' }));
  const backup = await store.createBackup('manual');
  await store.update(c.id, 1, parseCardFields({ name: '現在の名刺' }));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const hold = new Promise<void>(r => { release = r; });
  const reading = store.withLock('read-fixture', async () => { entered(); await hold; });
  await started;
  let finished = false;
  const restoring = store.restore(store.backupPath(backup.name)).then(r => { finished = true; return r; });
  try {
    const until = Date.now() + 2000;
    while (true) {
      try { await fs.access(path.join(dataDir, 'locks/maintenance.lock')); break; }
      catch { if (Date.now() > until) throw new Error('復元が開始されない'); await new Promise(r => setTimeout(r, 10)); }
    }
    // waitForWriters の最初のポーリングを超えても読み取り中は入れ替えない。
    await new Promise(r => setTimeout(r, 400));
    assert.equal(finished, false);
    const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'cards', `${c.id}.json`), 'utf8'));
    assert.equal(disk.name, '現在の名刺');
  } finally { release(); await reading; await restoring; }
  assert.equal(store.get(c.id)?.name, '退避済み');
});
