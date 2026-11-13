/**
 * 名刺管理 デスクトップアプリ（Electron）。
 *
 * - 各 PC で起動し、共有フォルダのデータを直接読み書きする。サーバーやポートは使わない。
 * - 画面とのやり取りはアプリ独自のプロトコル（app://meishi/）で行い、ネットワークには一切公開しない。
 * - 利用者はこの PC の Windows ユーザー。アクセスできる人は共有フォルダの権限で決まる。
 * - 外部への通信はしない（画面側も CSP で 'self' のみ）。
 */
import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHandler, User } from '../server/app.js';
import { Store, StoreError } from '../server/store.js';
import { Inbox } from '../server/inbox.js';
import { log, setLogFile } from '../server/log.js';
import { Settings, SharedDefaults, loadSettings, saveSettings, loadDefaults, Directory } from './settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SCHEME = 'app';
const HOST = 'meishi';

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

// 利用者ID＝Windows ユーザー名（MEISHI_DEV_USER は開発時に1台で複数の PC を再現するためだけのもの）
const userId = (process.env.MEISHI_DEV_USER || os.userInfo().username).toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64) || 'user';

interface Runtime { store: Store; inbox?: Inbox; directory: Directory; handler: http.RequestListener }
let rt: Runtime | null = null;
let setupError = '';
let settings: Settings;
let defaults: SharedDefaults;

function settingsFile(): string { return path.join(app.getPath('userData'), 'settings.json'); }

/** 設定に従って保存先を開く。失敗しても別の場所は使わず、設定画面にエラーを出す */
async function openStore(): Promise<void> {
  rt = null;
  setupError = '';
  if (!settings.dataDir) return;
  const backupDir = settings.backupDir || defaults.backupDir || path.join(settings.dataDir, 'backups');
  const store = new Store({ dataDir: settings.dataDir, backupDir });
  try {
    await store.open();
  } catch (e) {
    setupError = e instanceof StoreError ? e.message : `保存先を開けませんでした: ${(e as Error).message}`;
    log('warn', 'open store failed', { error: (e as Error).message });
    return;
  }
  const directory = new Directory(settings.dataDir);
  const displayName = settings.displayName || os.userInfo().username;
  await directory.register(userId, displayName).catch(() => undefined);
  await directory.load();
  const inboxDir = settings.inboxDir || defaults.inboxDir;
  const inbox = inboxDir ? new Inbox(inboxDir, path.join(settings.dataDir, 'inbox-done'), defaults.inboxRetentionDays ?? 90, (fn) => store.withLock('inbox', fn)) : undefined;
  const user: User = { id: userId, name: displayName };
  const handler = createHandler({
    config: { publicDir: PUBLIC_DIR, maxImageBytes: 8 * 1024 * 1024, maxRestoreBytes: 4 * 1024 * 1024 * 1024 },
    store, user, inbox, displayName: (id) => directory.name(id),
  });
  rt = { store, inbox, directory, handler };
}

// ---------- 設定画面用 API（保存先が未設定でも動く） ----------

async function folderState(dir: string): Promise<{ reachable: boolean; initialized: boolean; empty: boolean }> {
  try {
    const names = await Promise.race([
      fsp.readdir(dir),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)), // 繋がらない共有で固まらないように
    ]);
    return { reachable: true, initialized: await Store.isInitialized(dir), empty: names.length === 0 };
  } catch {
    return { reachable: false, initialized: false, empty: false };
  }
}

async function setupApi(method: string, p: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (p === '/api/setup' && method === 'GET') {
    return { status: 200, json: {
      ready: !!rt, error: setupError, userId, displayName: settings.displayName || os.userInfo().username,
      dataDir: settings.dataDir ?? '', inboxDir: settings.inboxDir ?? '', defaults,
    } };
  }
  if (p === '/api/setup/choose-folder' && method === 'POST') {
    const win = BrowserWindow.getFocusedWindow();
    const r = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory'] }));
    return { status: 200, json: { path: r.canceled ? '' : r.filePaths[0] ?? '' } };
  }
  if (p === '/api/setup/test' && method === 'POST') {
    const dir = str(body.dir);
    if (!dir || !(path.isAbsolute(dir) || path.win32.isAbsolute(dir))) return { status: 400, json: { error: 'フォルダを絶対パス（例: \\\\fileserver\\share\\meishi）で指定してください。' } };
    return { status: 200, json: await folderState(dir) };
  }
  if (p === '/api/setup/save' && method === 'POST') {
    const dataDir = str(body.dataDir);
    const inboxDir = str(body.inboxDir);
    const displayName = str(body.displayName).slice(0, 40);
    if (!dataDir || !(path.isAbsolute(dataDir) || path.win32.isAbsolute(dataDir))) return { status: 400, json: { error: '保存先フォルダを指定してください。' } };
    const st = await folderState(dataDir);
    if (!st.initialized) {
      const parentOk = (await folderState(path.dirname(dataDir))).reachable;
      if (body.initialize !== true) return { status: 409, json: { error: 'NOT_INITIALIZED', reachable: st.reachable, empty: st.empty, parentOk } };
      if (st.reachable && !st.empty) return { status: 400, json: { error: 'このフォルダには既に他のファイルがあります。名刺データ用の空のフォルダ（または新しいフォルダ名）を指定してください。' } };
      try { await Store.init(dataDir, path.join(dataDir, 'backups')); }
      catch (e) { return { status: 400, json: { error: `保存先を作成できませんでした: ${(e as Error).message}` } }; }
      log('info', 'store initialized');
    }
    if (inboxDir && !(await folderState(inboxDir)).reachable) return { status: 400, json: { error: '取り込み用フォルダにアクセスできません。' } };
    settings = { ...settings, dataDir, inboxDir: inboxDir || undefined, displayName: displayName || undefined };
    saveSettings(settingsFile(), settings);
    await openStore();
    return { status: rt ? 200 : 503, json: { ready: !!rt, error: setupError } };
  }
  if (p === '/api/setup/retry' && method === 'POST') {
    await openStore();
    return { status: 200, json: { ready: !!rt, error: setupError } };
  }
  return { status: 404, json: { error: '見つかりません。' } };
}

// ---------- app:// プロトコル → リクエスト処理（ポートを使わずに画面と通信） ----------

class FakeResponse extends PassThrough {
  statusCode = 200;
  headersSent = false;
  private hdrs: Record<string, string> = {};
  private resolveHead!: (r: Response) => void;
  readonly head = new Promise<Response>((r) => { this.resolveHead = r; });
  setHeader(k: string, v: string | number | string[]): this { this.hdrs[k.toLowerCase()] = String(v); return this; }
  getHeader(k: string): string | undefined { return this.hdrs[k.toLowerCase()]; }
  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.hdrs[k.toLowerCase()] = String(v);
    this.headersSent = true;
    const noBody = status === 204 || status === 304;
    this.resolveHead(new Response(noBody ? null : (Readable.toWeb(this) as unknown as ReadableStream), { status, headers: this.hdrs }));
    return this;
  }
}

async function handleProtocol(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  const method = request.method;
  if (url.pathname.startsWith('/api/setup')) {
    let body: Record<string, unknown> = {};
    if (method === 'POST') { try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; } }
    if (method !== 'GET' && request.headers.get('x-meishi-request') !== '1') return Response.json({ error: '不正なリクエストです。' }, { status: 403 });
    const r = await setupApi(method, url.pathname, body);
    return Response.json(r.json, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
  }
  const handler = rt?.handler ?? (url.pathname.startsWith('/api/') ? null : createStaticOnly());
  if (!handler) return Response.json({ error: setupError || '保存先が設定されていません。', code: 'SETUP_REQUIRED' }, { status: 503 });
  const req = (request.body ? Readable.fromWeb(request.body as never) : Readable.from([])) as Readable & Record<string, unknown>;
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  headers.host = HOST;
  Object.assign(req, { method, url: url.pathname + url.search, headers, socket: { remoteAddress: 'local' } });
  const res = new FakeResponse();
  handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  return res.head;
}

let staticOnly: http.RequestListener | null = null;
function createStaticOnly(): http.RequestListener {
  // 保存先が未設定でも画面（静的ファイル）は表示する。API は上で 503 を返す
  if (!staticOnly) {
    const dummy = new Store({ dataDir: path.join(os.tmpdir(), 'meishi-unset'), backupDir: path.join(os.tmpdir(), 'meishi-unset') });
    staticOnly = createHandler({ config: { publicDir: PUBLIC_DIR, maxImageBytes: 0, maxRestoreBytes: 0 }, store: dummy, user: { id: userId, name: '' } });
  }
  return staticOnly;
}

// ---------- 定期処理 ----------

function startJobs(): void {
  setInterval(() => { void rt?.store.probe(); }, 30_000).unref();
  const hourly = async () => {
    if (!rt) return;
    try {
      const ab = defaults.autoBackup ?? { intervalHours: 24, keep: 14 };
      await rt.store.autoBackup(ab.intervalHours, ab.keep);
      await rt.store.gcImages().catch((e) => { if (!(e instanceof StoreError && e.code === 'LOCKED')) throw e; });
      await rt.inbox?.purge();
    } catch (e) {
      log('error', 'scheduled job failed', { error: (e as Error).message });
    }
  };
  setTimeout(() => void hourly(), 90_000).unref();
  setInterval(() => void hourly(), 3600_000).unref();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 380, minHeight: 500, title: '名刺管理', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  // 外部リンク（Webサイト・メール・電話）は既定のアプリで開き、アプリ内では表示しない
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:|tel:)/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${SCHEME}://${HOST}/`)) return;
    e.preventDefault();
    if (/^(https?:|mailto:|tel:)/i.test(url)) void shell.openExternal(url);
  });
  void win.loadURL(`${SCHEME}://${HOST}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  void app.whenReady().then(async () => {
    // アプリ外への通信を遮断（app:// と画面内の blob:/data: のみ許可）
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      cb({ cancel: !/^(app|blob|data|devtools|chrome-extension):/i.test(d.url) });
    });
    // 権限はクリップボードへの書き込み（ChatGPT 用に指示文・画像をコピー）だけ許可。カメラ・マイク・位置情報などは拒否
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'clipboard-sanitized-write');
    protocol.handle(SCHEME, (req) => handleProtocol(req).catch((e) => Response.json({ error: (e as Error).message }, { status: 500 })));
    if (app.isPackaged) setLogFile(path.join(app.getPath('userData'), 'logs', 'meishi.log'));
    defaults = loadDefaults([path.join(path.dirname(app.getPath('exe')), 'meishi-config.json'), path.join(ROOT, 'meishi-config.json')]);
    settings = loadSettings(settingsFile(), defaults);
    await openStore();
    startJobs();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

