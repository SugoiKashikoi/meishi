import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { createHandler } from '../server/app.js';
import { Auth, writePassword } from '../server/auth.js';
import { normalizeConfig } from '../server/config.js';
import { tempStore, jpegWithExif } from './helpers.js';

const PW = 'test-password-1234';

async function setup() {
  const t = await tempStore();
  const configDir = path.join(t.root, 'config');
  writePassword(configDir, PW);
  const publicDir = path.join(t.root, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html>');
  await fs.writeFile(path.join(t.root, 'secret.txt'), 'SECRET');
  const config = normalizeConfig({ dataDir: t.dataDir, publicDir }, configDir);
  const auth = new Auth(configDir, 30);
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  const prevQuiet = process.env.MEISHI_QUIET;
  process.env.MEISHI_QUIET = '0';
  const server = http.createServer(createHandler({ config, store: t.store, auth, secure: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const req = async (method: string, p: string, body?: unknown, opts: { raw?: Buffer; type?: string; noCsrf?: boolean; noCookie?: boolean } = {}) => {
    const headers: Record<string, string> = {};
    if (!opts.noCsrf) headers['X-Meishi-Request'] = '1';
    if (cookie && !opts.noCookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.raw) headers['Content-Type'] = opts.type ?? 'image/jpeg';
    const res = await fetch(base + p, { method, headers, body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0]!;
    const buf = Buffer.from(await res.arrayBuffer());
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
    return { status: res.status, json, buf, headers: res.headers };
  };
  const done = async () => {
    console.log = orig;
    process.env.MEISHI_QUIET = prevQuiet;
    server.close();
    await t.store.close();
  };
  return { ...t, req, done, logs };
}

test('未ログインでは API・画像・CSV・バックアップを取得できない', async () => {
  const s = await setup();
  try {
    // 先にログインして画像を作り、ログアウト後にアクセスできないことを確認
    assert.equal((await s.req('POST', '/api/login', { password: PW })).status, 200);
    const img = await s.req('POST', '/api/images', undefined, { raw: jpegWithExif() });
    assert.equal(img.status, 201);
    const card = await s.req('POST', '/api/cards', { company: '架空商事', name: '見本', frontImage: img.json.id });
    assert.equal(card.status, 201);
    const b = await s.req('POST', '/api/backups');
    assert.equal(b.status, 201);
    for (const p of ['/api/cards', `/api/cards/${card.json.id}`, `/api/images/${img.json.id}`, '/api/export.csv', '/api/backups', `/api/backups/${b.json.name}/download`, '/api/status', '/api/facets']) {
      const r = await s.req('GET', p, undefined, { noCookie: true });
      assert.equal(r.status, 401, p);
      assert.ok(!r.buf.includes(Buffer.from('見本')), p);
    }
    assert.equal((await s.req('POST', '/api/cards', { name: 'x' }, { noCookie: true })).status, 401);
    // ログアウト後は無効
    await s.req('POST', '/api/logout');
    assert.equal((await s.req('GET', '/api/cards')).status, 401);
  } finally { await s.done(); }
});

test('ログイン失敗・CSRF・静的ファイルのパス制限', async () => {
  const s = await setup();
  try {
    assert.equal((await s.req('POST', '/api/login', { password: 'wrong' })).status, 401);
    assert.equal((await s.req('POST', '/api/login', { password: PW }, { noCsrf: true })).status, 403);
    assert.equal((await s.req('POST', '/api/login', { password: PW })).status, 200);
    assert.equal((await s.req('POST', '/api/cards', { name: 'x' }, { noCsrf: true })).status, 403);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/.env', '/index.html%00.js']) {
      const r = await s.req('GET', p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.buf.includes(Buffer.from('SECRET')), p);
    }
    assert.equal((await s.req('GET', '/')).status, 200);
    // 名刺画像の保存ディレクトリは静的公開されていない
    assert.equal((await s.req('GET', '/images/x.jpg')).status, 404);
    assert.equal((await s.req('GET', '/api/images/..%2f..%2fsecret')).status, 404);
    // ログイン試行の制限
    for (let i = 0; i < 5; i++) await s.req('POST', '/api/login', { password: 'wrong' });
    assert.equal((await s.req('POST', '/api/login', { password: PW })).status, 429);
  } finally { await s.done(); }
});

test('登録→検索→編集→競合検出→CSV・ログに個人情報を出さない', async () => {
  const s = await setup();
  try {
    await s.req('POST', '/api/login', { password: PW });
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
    for (const secret of ['見本', 'mihon@', PW, '新製品', 'かきゅう', 'カキュウ']) assert.ok(!all.includes(secret), `ログに ${secret} が含まれない`);
    assert.ok(all.includes('"msg":"req"'), 'アクセスログ自体は出ている');
  } finally { await s.done(); }
});

test('共有フォルダ切断時は 503 を返し、成功扱いにしない', async () => {
  const s = await setup();
  try {
    await s.req('POST', '/api/login', { password: PW });
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
    await s.req('POST', '/api/login', { password: PW });
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
