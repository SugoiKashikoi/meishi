import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { createHandler } from '../server/app.js';
import { Store } from '../server/store.js';
import { parseCardFields } from '../server/card.js';
import { Inbox } from '../server/inbox.js';
import { normalizeConfig } from '../server/config.js';
import { tempStore, jpegWithExif, jpegWithSize, makePdf } from './helpers.js';

async function setup(userId = 'taro') {
  const t = await tempStore();
  const publicDir = path.join(t.root, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html>');
  await fs.writeFile(path.join(t.root, 'secret.txt'), 'SECRET');
  const config = normalizeConfig({ dataDir: t.dataDir, publicDir }, path.join(t.root, 'config'));
  const inboxDir = path.join(t.root, 'inbox');
  await fs.mkdir(inboxDir);
  const inbox = new Inbox(inboxDir, path.join(t.dataDir, 'inbox-done'), 90, (fn) => t.store.withLock('inbox', fn));
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  const prevQuiet = process.env.MEISHI_QUIET;
  process.env.MEISHI_QUIET = '0';
  const names: Record<string, string> = { taro: '見本太郎', hanako: '試験花子' };
  const servers: http.Server[] = [];
  const mk = async (store: Store, uid: string) => {
    const server = http.createServer(createHandler({ config, store, user: { id: uid, name: names[uid] ?? uid }, inbox, displayName: (id) => names[id] ?? id }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (method: string, p: string, body?: unknown, opts: { raw?: Buffer; type?: string; noCsrf?: boolean } = {}) => {
      const headers: Record<string, string> = {};
      if (!opts.noCsrf) headers['X-Meishi-Request'] = '1';
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (opts.raw) headers['Content-Type'] = opts.type ?? 'image/jpeg';
      const res = await fetch(base + p, { method, headers, body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
      const buf = Buffer.from(await res.arrayBuffer());
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
      return { status: res.status, json, buf, headers: res.headers };
    };
  };
  const req = await mk(t.store, userId);
  /** 同じ共有フォルダを使う「別の PC」 */
  const otherPc = async (uid: string) => {
    const s2 = new Store({ dataDir: t.dataDir, backupDir: t.backupDir });
    await s2.open();
    return { store: s2, req: await mk(s2, uid) };
  };
  const done = async () => {
    console.log = orig;
    process.env.MEISHI_QUIET = prevQuiet;
    for (const sv of servers) sv.close();
    await t.store.close();
  };
  return { ...t, req, done, logs, inboxDir, otherPc };
}

test('CSRF ヘッダー必須・静的ファイルのパス制限・画像フォルダは静的公開しない', async () => {
  const s = await setup();
  try {
    assert.equal((await s.req('POST', '/api/cards', { name: 'x' }, { noCsrf: true })).status, 403);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/.env', '/index.html%00.js']) {
      const r = await s.req('GET', p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.buf.includes(Buffer.from('SECRET')), p);
    }
    assert.equal((await s.req('GET', '/')).status, 200);
    assert.equal((await s.req('GET', '/images/x.jpg')).status, 404);
    assert.equal((await s.req('GET', '/api/images/..%2f..%2fsecret')).status, 404);
  } finally { await s.done(); }
});

test('登録→検索→編集→競合検出→CSV・ログに個人情報を出さない', async () => {
  const s = await setup();
  try {
    const img = await s.req('POST', '/api/images', undefined, { raw: jpegWithExif() });
    const got = await s.req('GET', `/api/images/${img.json.id}`);
    assert.equal(got.status, 200);
    assert.ok(!got.buf.includes(Buffer.from('GPS')), 'EXIF 除去済み');
    assert.equal(got.headers.get('cache-control'), 'private, no-store');
    assert.equal((await s.req('POST', '/api/images', undefined, { raw: Buffer.from('<svg/>'), type: 'image/jpeg' })).status, 400);
    assert.equal((await s.req('POST', '/api/images', undefined, { raw: Buffer.from('x'), type: 'image/svg+xml' })).status, 415);
    assert.equal((await s.req('POST', '/api/cards', { memo: 'only memo' })).status, 400);
    const c = await s.req('POST', '/api/cards', { company: 'カキュウ商事株式会社', name: '見本 太郎', email: 'mihon@example.invalid', memo: '展示会で新製品の話', tags: ['重要'], event: 'テスト展', category: 'customer', frontImage: img.json.id });
    assert.equal(c.status, 201);
    const id = c.json.id as string;
    const search = async (q: string) => ((await s.req('GET', `/api/cards?q=${encodeURIComponent(q)}`)).json.cards as unknown[]).length;
    assert.equal(await search('かきゅう'), 1, 'カタカナ/ひらがな同一視');
    assert.equal(await search('新製品'), 1, 'メモ検索');
    assert.equal(await search('重要 見本'), 1, 'AND 検索');
    assert.equal(await search('存在しない'), 0);
    assert.equal(((await s.req('GET', '/api/cards?category=supplier')).json.cards as unknown[]).length, 0);
    assert.equal(((await s.req('GET', `/api/cards?event=${encodeURIComponent('テスト展')}`)).json.cards as unknown[]).length, 1);
    const dup = await s.req('POST', '/api/duplicates', { name: '見本太郎', company: 'カキュウ商事' });
    assert.equal((dup.json.cards as unknown[]).length, 1, '重複候補');
    // PC で編集（version 1 → 2）
    const e1 = await s.req('PUT', `/api/cards/${id}`, { ...c.json, memo: 'PCで追記', baseVersion: 1 });
    assert.equal(e1.status, 200);
    // スマホが古い版のまま保存 → 409（無言で上書きしない）
    const e2 = await s.req('PUT', `/api/cards/${id}`, { ...c.json, memo: 'スマホの古い内容', baseVersion: 1 });
    assert.equal(e2.status, 409);
    assert.equal((e2.json.current as { memo: string }).memo, 'PCで追記');
    assert.equal((await s.req('GET', `/api/cards/${id}`)).json.memo, 'PCで追記');
    const csv = await s.req('GET', '/api/export.csv');
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.ok(csv.buf.toString().includes('PCで追記'));
    // 削除は版指定が必要
    assert.equal((await s.req('DELETE', `/api/cards/${id}?baseVersion=1`)).status, 409);
    assert.equal((await s.req('DELETE', `/api/cards/${id}?baseVersion=2`)).status, 200);
    const all = s.logs.join('\n');
    for (const secret of ['見本 ', 'mihon@', '新製品', 'かきゅう', 'カキュウ']) assert.ok(!all.includes(secret), `ログに ${secret} が含まれない`);
    assert.ok(all.includes('"msg":"req"'), 'アクセスログ自体は出ている');
  } finally { await s.done(); }
});

test('共有フォルダ切断時は 503 を返し、成功扱いにしない', async () => {
  const s = await setup();
  try {
    await fs.rename(path.join(s.root, 'share'), path.join(s.root, 'offline'));
    const r = await s.req('POST', '/api/cards', { name: '切断中' });
    assert.equal(r.status, 503);
    assert.match(String(r.json.error), /保存できませんでした/);
    const st = await s.req('GET', '/api/status');
    assert.equal((st.json.storage as { available: boolean }).available, false);
    await fs.rename(path.join(s.root, 'offline'), path.join(s.root, 'share'));
  } finally { await s.done(); }
});

test('復元 API：アップロード→検証→確認入力→適用', async () => {
  const s = await setup();
  try {
    await s.req('POST', '/api/cards', { name: '残す' });
    const b = await s.req('POST', '/api/backups');
    await s.req('POST', '/api/cards', { name: '消える' });
    const tar = await fs.readFile(s.store.backupPath(b.json.name as string));
    const up = await s.req('POST', '/api/restore/upload', undefined, { raw: tar, type: 'application/x-tar' });
    assert.equal(up.status, 200);
    assert.equal((up.json.summary as { cardCount: number }).cardCount, 1);
    assert.equal((await s.req('POST', '/api/restore/apply', { uploadId: up.json.uploadId })).status, 400, '確認入力なしは拒否');
    assert.equal(((await s.req('GET', '/api/cards')).json.cards as unknown[]).length, 2);
    const ap = await s.req('POST', '/api/restore/apply', { uploadId: up.json.uploadId, confirm: '復元' });
    assert.equal(ap.status, 200);
    assert.equal(((await s.req('GET', '/api/cards')).json.cards as unknown[]).length, 1);
    const bad = await s.req('POST', '/api/restore/upload', undefined, { raw: Buffer.from('garbage'), type: 'application/x-tar' });
    assert.equal(bad.status, 400);
  } finally { await s.done(); }
});

test('取り込み用フォルダ：一覧→画像取得→名刺登録で取り込み済みへ移動・破棄・未ログイン拒否', async () => {
  const s = await setup();
  try {
    const old = new Date(Date.now() - 60_000);
    const put = async (name: string, settled = true) => {
      const f = path.join(s.inboxDir, name);
      await fs.writeFile(f, jpegWithExif());
      if (settled) await fs.utimes(f, old, old);
    };
    await put('スキャン_001.jpg');
    await put('scan-002.JPG');
    await put('writing-now.jpg', false); // 書き込み直後のものは対象外
    await fs.writeFile(path.join(s.inboxDir, 'memo.txt'), 'x');
    const list = await s.req('GET', '/api/inbox');
    const items = list.json.items as { id: string; name: string }[];
    assert.deepEqual(items.map((i) => i.name).sort(), ['scan-002.JPG', 'スキャン_001.jpg']);
    const a = items.find((i) => i.name === 'スキャン_001.jpg')!;
    const b = items.find((i) => i.name === 'scan-002.JPG')!;
    const file = await s.req('GET', `/api/inbox/${a.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.equal((await s.req('POST', `/api/inbox/${a.id}/claim`)).json.claimedBy, null);
    // ブラウザで縮小・メタデータ除去した画像をアップロードし、取り込み元を指定して保存
    const img = await s.req('POST', '/api/images', undefined, { raw: jpegWithExif() });
    const c = await s.req('POST', '/api/cards', { company: '架空商事', frontImage: img.json.id, fromInbox: [a.id] });
    assert.equal(c.status, 201);
    assert.deepEqual(c.json.inboxResult, { moved: 1, failed: [] });
    assert.ok(!(await fs.readdir(s.inboxDir)).includes('スキャン_001.jpg'));
    const done = await fs.readdir(path.join(s.dataDir, 'inbox-done'));
    assert.equal(done.length, 1);
    assert.ok(done[0]!.endsWith('スキャン_001.jpg'));
    // 同じ画像での二重登録は拒否
    const dup = await s.req('POST', '/api/cards', { company: '二重', fromInbox: [a.id] });
    assert.equal(dup.status, 409);
    assert.equal(((await s.req('GET', '/api/cards?q=二重')).json.cards as unknown[]).length, 0);
    // 破棄
    const d = await s.req('POST', '/api/inbox/discard', { ids: [b.id] });
    assert.equal(d.json.moved, 1);
    assert.equal((await fs.readdir(path.join(s.dataDir, 'inbox-done'))).filter((x) => x.includes('discarded')).length, 1);
    assert.equal((await s.req('GET', `/api/inbox/${b.id}/file`)).status, 404);
    assert.equal((await s.req('GET', '/api/inbox/..%2f..%2fetc/file')).status, 404);
    // 取り込み用フォルダに接続できないときは明示的なエラー
    await fs.rename(s.inboxDir, `${s.inboxDir}-off`);
    assert.equal((await s.req('GET', '/api/inbox')).status, 503);
    await fs.rename(`${s.inboxDir}-off`, s.inboxDir);
  } finally { await s.done(); }
});

test('PDF：取り込み用フォルダの PDF をページ画像に分割・ブラウザからの追加・登録画面での取り出し', async () => {
  const s = await setup();
  try {
    // 取り込み用フォルダに置かれた2ページの PDF（メモの書類スキャン相当）
    const pdf = makePdf([{ data: jpegWithSize(1200, 700) }, { data: jpegWithSize(1200, 700) }]);
    const f = path.join(s.inboxDir, '名刺スキャン.pdf');
    await fs.writeFile(f, pdf);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(f, old, old);
    await fs.writeFile(path.join(s.inboxDir, 'broken.pdf'), '%PDF-1.4 nothing');
    await fs.utimes(path.join(s.inboxDir, 'broken.pdf'), old, old);
    const items = (await s.req('GET', '/api/inbox')).json.items as { name: string; error?: string; type: string }[];
    assert.equal(items.filter((i) => !i.error).length, 2);
    for (const it of items.filter((i) => !i.error)) assert.match(it.name, /^名刺スキャン-[0-9a-f]{64}-p0[12]\.jpg$/);
    assert.ok(items.find((i) => i.name === 'broken.pdf')?.error, '取り出せない PDF はエラー付きで表示（破棄できる）');
    assert.ok(!(await fs.readdir(s.inboxDir)).includes('名刺スキャン.pdf'), '元の PDF は取り込み済みへ移動');
    assert.equal((await fs.readdir(path.join(s.dataDir, 'inbox-done'))).filter((x) => x.includes('split-')).length, 1);
    // 再スキャンしても重複しない
    assert.equal(((await s.req('GET', '/api/inbox')).json.items as unknown[]).length, 3);
    // ブラウザからの追加（スマホのファイル選択）
    const up = await s.req('POST', '/api/inbox/upload', undefined, { raw: makePdf([{ data: jpegWithSize(900, 600) }]), type: 'application/pdf' });
    assert.equal(up.status, 201);
    assert.equal(((await s.req('GET', '/api/inbox')).json.items as unknown[]).length, 4);
    assert.equal((await s.req('POST', '/api/inbox/upload', undefined, { raw: Buffer.from('<html>'), type: 'application/pdf' })).status, 400, '中身が PDF でない');
    assert.equal((await s.req('POST', '/api/inbox/upload', undefined, { raw: Buffer.from('x'), type: 'text/html' })).status, 415);
    // 登録画面での PDF 取り出し（保存はしない）
    const ex = await s.req('POST', '/api/pdf/extract', undefined, { raw: pdf, type: 'application/pdf' });
    assert.equal(ex.status, 200);
    assert.equal((ex.json.images as string[]).length, 2);
    assert.equal((await s.req('POST', '/api/pdf/extract', undefined, { raw: Buffer.from('%PDF-1.4'), type: 'application/pdf' })).status, 400);
  } finally { await s.done(); }
});

test('別の PC：登録者・更新者の記録、他の PC の変更の反映、PC をまたいだ競合検出', async () => {
  const s = await setup('taro');
  try {
    const pc2 = await s.otherPc('hanako');
    const c = await s.req('POST', '/api/cards', { company: '架空商事', name: '取引先 一郎' });
    assert.equal(c.status, 201);
    // PC2 の一覧・検索に反映される
    const l2 = await pc2.req('GET', `/api/cards?q=${encodeURIComponent('取引先')}`);
    assert.equal((l2.json.cards as unknown[]).length, 1);
    const g = await pc2.req('GET', `/api/cards/${c.json.id}`);
    assert.equal(g.json.createdByName, '見本太郎');
    // PC2 が更新 → PC1 の古い版からの保存は競合
    const u2 = await pc2.req('PUT', `/api/cards/${c.json.id}`, { company: '架空商事', name: '取引先 一郎', memo: 'PC2で追記', baseVersion: 1 });
    assert.equal(u2.status, 200);
    assert.equal(u2.json.updatedBy, 'hanako');
    const u1 = await s.req('PUT', `/api/cards/${c.json.id}`, { company: '架空商事', name: '取引先 一郎', memo: 'PC1の古い内容', baseVersion: 1 });
    assert.equal(u1.status, 409);
    assert.equal((u1.json.current as { memo: string }).memo, 'PC2で追記');
    // PC1 の詳細は最新（PC2 の変更）を表示
    assert.equal((await s.req('GET', `/api/cards/${c.json.id}`)).json.memo, 'PC2で追記');
    // PC2 で削除 → PC1 の一覧から消える
    assert.equal((await pc2.req('DELETE', `/api/cards/${c.json.id}?baseVersion=2`)).status, 200);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(((await s.req('GET', '/api/cards')).json.cards as unknown[]).length, 0);
  } finally { await s.done(); }
});

test('連絡先検索：電話の区切り差・携帯・郵便番号・Webを検索でき、CSVにも他PCの追加を反映する', async () => {
  const s = await setup();
  try {
    await s.req('POST', '/api/cards', { name: '架空連絡先', phone: '03-1234-5678', mobile: '090-2222-3333', postalCode: '100-0001', website: 'https://sample.example.invalid' });
    for (const q of ['0312345678', '03(1234)5678', '０３−１２３４−５６７８', '09022223333', '1000001', 'sample.example.invalid']) {
      // Unicode minus is normalized below separately; test NFKC-compatible fullwidth hyphen.
      const term = q.replace(/−/g, '－');
      const r = await s.req('GET', `/api/cards?q=${encodeURIComponent(term)}`);
      assert.equal((r.json.cards as unknown[]).length, 1, q);
    }
    const pc2 = await s.otherPc('hanako');
    await pc2.store.create(parseCardFields({ name: '他PC追加の架空名刺' }));
    const csv = await s.req('GET', '/api/export.csv');
    assert.ok(csv.buf.toString('utf8').includes('他PC追加の架空名刺'));
    await pc2.store.close();
    for (const body of [null, [], 'invalid']) assert.equal((await s.req('POST', '/api/cards', body)).status, 400);
  } finally { await s.done(); }
});
test('壊れた名刺は状態APIで件数を通知し、内容をログへ出さない', async (t) => {
  const s = await setup();
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.join(' ')); });
  try {
    await fs.writeFile(path.join(s.dataDir, 'cards', `${'e'.repeat(32)}.json`), '{"name":"PRIVATE-NAME","email":"secret@example.invalid",invalid}');
    await s.store.refresh(true);
    const status = await s.req('GET', '/api/status');
    assert.equal((status.json.storage as { unreadableCards: number }).unreadableCards, 1);
    assert.ok(errors.length > 0);
    assert.ok(!errors.join('').includes('PRIVATE-NAME'));
    assert.ok(!errors.join('').includes('secret@example.invalid'));
  } finally { await s.done(); }
});
