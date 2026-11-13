import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { AppConfig } from './config.js';
import { Store, StoreError } from './store.js';
import { Auth } from './auth.js';
import { Card, ID_RE, ValidationError, norm, parseCardFields } from './card.js';
import { toCsv } from './csv.js';
import { log } from './log.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.gz': 'application/octet-stream', '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "connect-src 'self'",
  "img-src 'self' blob: data:", "style-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) { super(message); }
}

function send(res: http.ServerResponse, status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}): void {
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': b.length, ...extra });
  res.end(b);
}
function json(res: http.ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'データが大きすぎます。');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON で送信してください。');
  try { return JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, '入力が不正です。');
  }
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function summary(c: Card) {
  return {
    id: c.id, version: c.version, company: c.company, department: c.department, title: c.title, name: c.name, kana: c.kana,
    exchangeDate: c.exchangeDate, event: c.event, category: c.category, tags: c.tags, createdAt: c.createdAt, updatedAt: c.updatedAt,
    hasImage: !!c.frontImage,
  };
}

export interface AppDeps { config: AppConfig; store: Store; auth: Auth; secure: boolean }

export function createHandler({ config, store, auth, secure }: AppDeps): http.RequestListener {
  const COOKIE = secure ? '__Host-meishi_sid' : 'meishi_sid';
  const ocrAvailable = fs.existsSync(path.join(config.publicDir, 'vendor', 'ocr', 'lang', 'jpn.traineddata.gz'));
  const pending = new Map<string, { file: string; at: number }>();

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Bad request'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const segs = rel.split('/').filter(Boolean);
    if (segs.some((s) => s.startsWith('.') || s.includes('\\') || s.includes('\0'))) throw new HttpError(404, 'Not found');
    const file = path.join(config.publicDir, ...segs);
    const ext = path.extname(file);
    if (!file.startsWith(config.publicDir + path.sep) || !MIME[ext]) throw new HttpError(404, 'Not found');
    let st: fs.Stats;
    try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[ext]!, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(fs.createReadStream(file), res);
  }

  async function streamToFile(req: http.IncomingMessage, file: string, limit: number): Promise<void> {
    let n = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        if (n > limit) cb(new HttpError(413, 'ファイルが大きすぎます。')); else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file, { flags: 'wx' }));
    } catch (e) {
      await fsp.unlink(file).catch(() => undefined);
      if (e instanceof HttpError) throw e;
      throw new StoreError('STORAGE_UNAVAILABLE', 'ファイルを受け取れませんでした。通信状態と保存先を確認してください。');
    }
  }

  function listCards(q: URLSearchParams) {
    const terms = (q.get('q') ?? '').split(/[\s　]+/).map(norm).filter(Boolean);
    const cat = q.get('category') ?? '';
    const ev = q.get('event') ?? '';
    const tag = q.get('tag') ?? '';
    const sort = q.get('sort') ?? 'created';
    const all = store.list();
    const hits = all.filter((c) =>
      (!cat || c.category === cat) && (!ev || c.event === ev) && (!tag || c.tags.includes(tag)) &&
      terms.every((t) => store.searchKey(c.id).includes(t)));
    const coll = new Intl.Collator('ja');
    if (sort === 'company') hits.sort((a, b) => coll.compare(a.company || '￿', b.company || '￿') || coll.compare(a.kana || a.name, b.kana || b.name));
    else if (sort === 'exchange') hits.sort((a, b) => (b.exchangeDate || '0').localeCompare(a.exchangeDate || '0') || b.createdAt.localeCompare(a.createdAt));
    else hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { total: all.length, cards: hits.map(summary) };
  }

  function facets() {
    const events = new Map<string, number>();
    const tags = new Map<string, number>();
    for (const c of store.list()) {
      if (c.event) events.set(c.event, (events.get(c.event) ?? 0) + 1);
      for (const t of c.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    }
    const coll = new Intl.Collator('ja');
    const arr = (m: Map<string, number>) => [...m].sort((a, b) => coll.compare(a[0], b[0])).map(([name, count]) => ({ name, count }));
    return { events: arr(events), tags: arr(tags) };
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, token: string | undefined): Promise<void> {
    const m = req.method ?? 'GET';
    const p = url.pathname;

    if (p === '/api/session' && m === 'GET') return json(res, 200, { authenticated: auth.check(token), configured: auth.configured() });
    if (p === '/api/login' && m === 'POST') {
      const body = await readJson(req);
      const r = auth.login(typeof body.password === 'string' ? body.password : '', req.socket.remoteAddress ?? '');
      if (!r.ok) {
        log('warn', 'login failed', { locked: r.locked });
        throw new HttpError(r.locked ? 429 : 401, r.locked ? 'ログインの失敗が続いたため、しばらく待ってから再度お試しください。' : 'パスワードが違います。');
      }
      log('info', 'login ok');
      res.setHeader('Set-Cookie', `${COOKIE}=${r.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${r.maxAge}${secure ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/logout' && m === 'POST') {
      auth.logout(token);
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }

    // ---- ここから下はすべて認証必須 ----
    if (!auth.check(token)) throw new HttpError(401, 'ログインしてください。');

    if (p === '/api/status' && m === 'GET') {
      return json(res, 200, { storage: { available: store.available, error: store.lastError, dataDir: store.dataDir, backupDir: store.backupDir }, ocrAvailable, secure });
    }
    if (p === '/api/cards' && m === 'GET') return json(res, 200, listCards(url.searchParams));
    if (p === '/api/facets' && m === 'GET') return json(res, 200, facets());
    if (p === '/api/cards' && m === 'POST') {
      const card = await store.create(parseCardFields(await readJson(req)));
      log('info', 'card created', { id: card.id });
      return json(res, 201, card);
    }
    if (p === '/api/duplicates' && m === 'POST') {
      const body = await readJson(req);
      const pick = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, 300) : '');
      const exclude = pick('excludeId');
      return json(res, 200, { cards: store.duplicates({ name: pick('name'), company: pick('company'), email: pick('email'), phone: pick('phone'), mobile: pick('mobile') }, exclude).map(summary) });
    }
    let mm = /^\/api\/cards\/([0-9a-f]{32})$/.exec(p);
    if (mm) {
      const id = mm[1]!;
      if (m === 'GET') {
        const c = store.get(id);
        if (!c) throw new HttpError(404, '名刺が見つかりません。');
        return json(res, 200, c);
      }
      if (m === 'PUT') {
        const body = await readJson(req);
        const base = Number(body.baseVersion);
        if (!Number.isInteger(base)) throw new HttpError(400, 'baseVersion が必要です。');
        const card = await store.update(id, base, parseCardFields(body));
        log('info', 'card updated', { id, version: card.version });
        return json(res, 200, card);
      }
      if (m === 'DELETE') {
        const base = Number(url.searchParams.get('baseVersion'));
        await store.remove(id, base);
        log('info', 'card deleted', { id });
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/images' && m === 'POST') {
      if (req.headers['content-type'] !== 'image/jpeg') throw new HttpError(415, 'JPEG 画像を送信してください。');
      const id = await store.putImage(await readBody(req, config.maxImageBytes));
      return json(res, 201, { id });
    }
    mm = /^\/api\/images\/([0-9a-f]{32})$/.exec(p);
    if (mm && m === 'GET') {
      const file = store.imagePath(mm[1]!);
      let st: fs.Stats;
      try { st = await fsp.stat(file); } catch { throw new HttpError(store.available ? 404 : 503, store.available ? '画像が見つかりません。' : '保存先に接続できません。'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'private, no-store' });
      await pipeline(fs.createReadStream(file), res);
      return;
    }
    if (p === '/api/export.csv' && m === 'GET') {
      const cards = store.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const name = `meishi-${new Date().toISOString().slice(0, 10)}.csv`;
      return send(res, 200, toCsv(cards), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
    }
    if (p === '/api/backups' && m === 'GET') return json(res, 200, { backups: await store.listBackups() });
    if (p === '/api/backups' && m === 'POST') {
      const b = await store.createBackup('manual');
      return json(res, 201, b);
    }
    mm = /^\/api\/backups\/([^/]+)\/download$/.exec(p);
    if (mm && m === 'GET') {
      const file = store.backupPath(decodeURIComponent(mm[1]!));
      let st: fs.Stats;
      try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'バックアップが見つかりません。'); }
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
      await pipeline(fs.createReadStream(file), res);
      return;
    }
    if (p === '/api/restore/upload' && m === 'POST') {
      const uid = crypto.randomBytes(16).toString('hex');
      const file = store.tmpPath(`restore-upload-${uid}.tar`);
      await streamToFile(req, file, config.maxRestoreBytes);
      try {
        const s = await Store.verifyArchive(file);
        pending.set(uid, { file, at: Date.now() });
        return json(res, 200, { uploadId: uid, summary: s });
      } catch (e) {
        await fsp.unlink(file).catch(() => undefined);
        throw e;
      }
    }
    if (p === '/api/restore/verify' && m === 'POST') {
      const body = await readJson(req);
      const s = await Store.verifyArchive(store.backupPath(String(body.backupName ?? '')));
      return json(res, 200, { summary: s });
    }
    if (p === '/api/restore/apply' && m === 'POST') {
      const body = await readJson(req);
      if (body.confirm !== '復元') throw new HttpError(400, '確認のため「復元」と入力してください。');
      let file: string;
      if (typeof body.uploadId === 'string') {
        const pend = pending.get(body.uploadId);
        if (!pend) throw new HttpError(404, 'アップロードされたファイルが見つかりません。もう一度アップロードしてください。');
        file = pend.file;
      } else {
        file = store.backupPath(String(body.backupName ?? ''));
      }
      const r = await store.restore(file);
      if (typeof body.uploadId === 'string') { pending.delete(body.uploadId); await fsp.unlink(file).catch(() => undefined); }
      return json(res, 200, r);
    }
    throw new HttpError(404, '見つかりません。');
  }

  return (req, res) => {
    const started = Date.now();
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isApi = url.pathname.startsWith('/api/');
    const run = async () => {
      if (isApi) {
        res.setHeader('Cache-Control', 'no-store');
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          // CSRF 対策: 独自ヘッダー必須（クロスオリジンからは CORS 事前確認なしに送れない）+ Origin 一致
          if (req.headers['x-meishi-request'] !== '1') throw new HttpError(403, '不正なリクエストです。');
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, '不正なリクエストです。');
        }
        await api(req, res, url, cookies(req)[COOKIE]);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    };
    run().catch((e: unknown) => {
      let status = 500;
      let msg = 'サーバーでエラーが発生しました。';
      let extra: Record<string, unknown> = {};
      if (e instanceof HttpError) { status = e.status; msg = e.message; extra = e.extra ?? {}; }
      else if (e instanceof ValidationError) { status = 400; msg = e.message; }
      else if (e instanceof StoreError) {
        status = { STORAGE_UNAVAILABLE: 503, CONFLICT: 409, NOT_FOUND: 404, LOCKED: 503, INVALID: 400 }[e.code];
        msg = e.message;
        if (e.current) extra = { current: e.current };
        extra.code = e.code;
      } else {
        log('error', 'unhandled', { error: (e as Error)?.message });
      }
      if (res.headersSent) { res.destroy(); return; }
      if (isApi) json(res, status, { error: msg, ...extra });
      else send(res, status, msg, 'text/plain; charset=utf-8');
    }).finally(() => {
      // パスのみ記録（クエリ文字列＝検索語は記録しない）
      if (isApi) log('info', 'req', { m: req.method, p: url.pathname.replace(/[0-9a-f]{32}/g, ':id'), s: res.statusCode, ms: Date.now() - started });
    });
  };
}

export function isValidId(id: string): boolean { return ID_RE.test(id); }
