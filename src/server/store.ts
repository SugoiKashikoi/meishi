/**
 * 共有フォルダ上のファイルストア（複数のPCのアプリが直接読み書きする）。
 *
 * - 1 名刺 = 1 JSON ファイル。一時ファイルに書いて fsync → 同じフォルダ内で rename（置き換え）
 *   → 読み戻して内容一致を確認。途中で失敗しても旧ファイルか新ファイルのどちらかが残る。
 * - 書き込みは対象ごとのロックファイル（locks/<名前>.lock、排他作成）で PC 間の排他を取る。
 *   ロックは保持中に10秒ごと更新する。更新が止まっても自動で奪わない（遅延・スリープと終了を区別できない）。
 * - 更新・削除はロックの中でディスク上の最新版を読み、version が違えば競合として拒否する
 *   （古い内容で上書きしない）。
 * - 画像は不変（内容を変えるときは新しい ID）。名刺 JSON より先に書く。
 *   参照されない古い画像の掃除とバックアップは jobs ロックで直列化する。
 * - 復元は maintenance ロックを取り、他の PC の書き込みが終わるのを待ってから入れ替える。
 *   その間、他の PC の保存は「復元作業中」として拒否する。
 * - 他の PC の変更は .changed（書き込みのたびに更新）を見て検知し、変わったファイルだけ読み直す。
 * - 書き込み失敗時は別の場所へ退避せず、明確なエラーを返す。
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Card, CardFields, ID_RE, ValidationError, parseStoredCard, searchText, norm, normPhone, normCompany } from './card.js';
import { TarReader, TarWriter } from './tar.js';
import { sanitizeJpeg } from './jpeg.js';
import { log } from './log.js';

export type StoreErrorCode = 'STORAGE_UNAVAILABLE' | 'CONFLICT' | 'NOT_FOUND' | 'LOCKED' | 'STALE_LOCK' | 'INVALID' | 'MAINTENANCE';

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string, readonly current?: Card) {
    super(message);
  }
}

const MARKER = '.meishi-store';
const RESTORE_MARKER = 'restore-in-progress.json';
const ORPHAN_IMAGE_AGE_MS = 24 * 3600_000;
export const BACKUP_FORMAT = 'meishi-backup';
const BACKUP_NAME_RE = /^meishi-(\d{8}-\d{6})-(auto|manual|pre-restore|preservation)(-\d+)?\.tar$/;

export const newId = (): string => crypto.randomBytes(16).toString('hex');
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 一時ファイル → fsync → rename → 読み戻し確認 */
export async function atomicWrite(dir: string, name: string, data: Buffer): Promise<void> {
  const tmp = path.join(dir, `.tmp-${name}-${crypto.randomBytes(4).toString('hex')}`);
  const final = path.join(dir, name);
  try {
    const fh = await fs.open(tmp, 'wx');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, final);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  const back = await fs.readFile(final);
  if (!back.equals(data)) throw new Error('書き込み後の確認で内容が一致しません。');
}

export interface BackupInfo { name: string; kind: string; createdAt: string; size: number }
export interface BackupSummary { createdAt: string; cardCount: number; imageCount: number }

interface Manifest {
  format: string;
  formatVersion: number;
  createdAt: string;
  cardCount: number;
  imageCount: number;
  files: Record<string, string>;
}

export interface StoreOptions { dataDir: string; backupDir: string }

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const TEMP_STALE_MS = 3600_000;
const REFRESH_MIN_MS = 0; // 一覧のたびに .changed（小さなファイル1つ）だけ確認する
const FULL_SCAN_MS = 60_000;

export class Store {
  readonly dataDir: string;
  readonly backupDir: string;
  private cards = new Map<string, Card>();
  private invalidCards = new Set<string>();
  private search = new Map<string, string>();
  private stats = new Map<string, string>();
  private lastStamp = '';
  private lastRefresh = 0;
  private lastFullScan = 0;
  private refreshing: Promise<void> | null = null;
  available = false;
  lastError = '';
  backupError = '';
  get unreadableCards(): number { return this.invalidCards.size; }

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.backupDir = opts.backupDir;
  }

  private p(...xs: string[]): string { return path.join(this.dataDir, ...xs); }

  /** 保存先を初期化する（設定画面から明示的に実行）。既存データは消さない。 */
  static async init(dataDir: string, backupDir: string, opts: { dev?: boolean } = {}): Promise<void> {
    const parent = path.dirname(dataDir);
    if (!(await exists(parent))) throw new Error(`親フォルダにアクセスできません: ${parent}`);
    await fs.mkdir(dataDir, { recursive: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    for (const d of ['cards', 'images', 'trash', 'tmp', 'locks']) await fs.mkdir(path.join(dataDir, d), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    const marker = path.join(dataDir, MARKER);
    if (!(await exists(marker))) {
      await atomicWrite(dataDir, MARKER, Buffer.from(JSON.stringify({ format: 'meishi-store', formatVersion: 1, createdAt: new Date().toISOString(), dev: !!opts.dev }, null, 2)));
    }
  }

  static async isInitialized(dataDir: string): Promise<boolean> {
    try { return JSON.parse(await fs.readFile(path.join(dataDir, MARKER), 'utf8')).format === 'meishi-store'; } catch { return false; }
  }

  async isDevStore(): Promise<boolean> {
    try { return !!JSON.parse(await fs.readFile(this.p(MARKER), 'utf8')).dev; } catch { return false; }
  }

  async open(): Promise<void> {
    await this.checkMarker();
    await this.assertNoMaintenance();
    if (await exists(this.p(RESTORE_MARKER))) {
      await this.withLock('maintenance', () => this.recoverRestore());
    }
    // 通常起動は他PCの保存を止めない。欠落したcards/imagesを作り直さない。
    await this.read(async () => {
      for (const d of ['cards', 'images', 'trash', 'tmp', 'locks']) await fs.access(this.p(d));
      await fs.mkdir(this.backupDir, { recursive: true });
      await this.cleanTemp();
      await this.doRefresh(true);
      this.available = true;
    });
  }

  async close(): Promise<void> { /* 保持しているロックは各処理の終わりに解放済み */ }

  private async checkMarker(): Promise<void> {
    if (!(await Store.isInitialized(this.dataDir))) {
      throw new StoreError('STORAGE_UNAVAILABLE', `保存先にアクセスできないか、初期化されていません: ${this.dataDir}`);
    }
  }

  // ---------- PC 間のロック ----------

  private lockPath(name: string): string { return this.p('locks', `${name}.lock`); }

  private async lockAge(name: string): Promise<number | null> {
    try { return Date.now() - (await fs.stat(this.lockPath(name))).mtimeMs; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }

  /** ロックを取って fn を実行する。他の PC が保持中なら待ち、待ちきれなければ LOCKED */
  async withLock<T>(name: string, fn: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
    const file = this.lockPath(name);
    const until = Date.now() + waitMs;
    const token = crypto.randomUUID();
    const body = JSON.stringify({ token, host: os.hostname(), pid: process.pid, user: os.userInfo().username, at: new Date().toISOString() });
    for (;;) {
      try {
        const fh = await fs.open(file, 'wx');
        try { await fh.writeFile(body); } finally { await fh.close(); }
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw e;
        const age = await this.lockAge(name);
        if (age !== null && age > LOCK_STALE_MS) throw new StoreError('STALE_LOCK', '更新が止まったロックがあります。全PCのアプリ・登録コマンドを終了し、管理者がロックを確認してください。自動解除はしません。');
        if (Date.now() > until) {
          throw new StoreError('LOCKED', name === 'maintenance' ? '他のPCで復元作業中です。終わってから再度お試しください。' : '他のPCが同じデータを処理中です。少し待ってから再度お試しください。');
        }
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
      }
    }
    const owns = async () => (await fs.readFile(file, 'utf8')) === body;
    const beat = setInterval(() => { const t = new Date(); void owns().then((ok) => ok ? fs.utimes(file, t, t) : undefined).catch(() => undefined); }, 10_000);
    beat.unref();
    try {
      return await fn();
    } finally {
      clearInterval(beat);
      if (await owns().catch(() => false)) await fs.unlink(file).catch(() => undefined);
    }
  }

  private async assertNoMaintenance(): Promise<void> {
    const age = await this.lockAge('maintenance');
    if (age !== null) throw new StoreError('MAINTENANCE', '他のPCで復元作業中のため、保存できません。終わってから再度保存してください。');
  }

  /** 復元の入れ替え前に読み取り完了も待てるよう、処理ごとに登録する。 */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.checkMarker();
    try {
      return await this.withLock(`read-${newId()}`, async () => {
        await this.assertNoMaintenance();
        if (await exists(this.p(RESTORE_MARKER))) throw new StoreError('MAINTENANCE', '復元が中断されています。管理者が復元を再開してください。');
        return fn();
      });
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError('STORAGE_UNAVAILABLE', '保存先から読み込めませんでした。接続を確認してください。');
    }
  }

  /** 書き込み処理：ロック → 復元中でないか確認 → 実行 → 変更の目印を更新 */
  private async write<T>(lock: string, fn: () => Promise<T>): Promise<T> {
    try {
      await this.checkMarker();
      return await this.withLock(lock, async () => {
        await this.assertNoMaintenance();
        if (await exists(this.p(RESTORE_MARKER))) throw new StoreError('MAINTENANCE', '復元が中断されています。管理者が復元を再開してから保存してください。');
        const r = await fn();
        await this.touchChanged();
        return r;
      });
    } catch (e) {
      if (e instanceof StoreError && e.code !== 'STORAGE_UNAVAILABLE') throw e;
      if (e instanceof ValidationError) throw e;
      this.available = false;
      this.lastError = '保存先（共有フォルダ）に保存できませんでした。';
      log('error', 'write failed', { error: (e as Error).message });
      throw new StoreError('STORAGE_UNAVAILABLE', '保存先（共有フォルダ）に保存できませんでした。接続を確認してから再度保存してください。');
    }
  }

  /** 変更の目印を更新（他の PC が同時に書くので読み戻し確認はしない。失敗しても保存自体は成功として扱い、定期の全件確認で拾う） */
  private async touchChanged(): Promise<void> {
    const tmp = this.p(`.tmp-changed-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await fs.writeFile(tmp, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
      await fs.rename(tmp, this.p('.changed'));
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      log('warn', 'touch changed failed', { error: (e as Error).message });
    }
  }

  /** 接続確認 */
  async probe(): Promise<boolean> {
    try {
      await this.checkMarker();
      await atomicWrite(this.p('tmp'), `probe-${os.hostname()}-${process.pid}`, Buffer.from(new Date().toISOString()));
      if (!this.available) log('info', 'storage reconnected');
      this.available = true;
      this.lastError = '';
    } catch (e) {
      if (this.available) log('warn', 'storage unavailable', { error: (e as Error).message });
      this.available = false;
      this.lastError = '保存先（共有フォルダ）に接続できません。';
    }
    return this.available;
  }

  /** 他の PC が書き込み中かもしれないので、古い一時ファイルだけを消す */
  private async cleanTemp(): Promise<void> {
    const old = async (f: string) => { try { return Date.now() - (await fs.stat(f)).mtimeMs > TEMP_STALE_MS; } catch { return false; } };
    for (const d of ['cards', 'images', 'trash', 'tmp']) {
      for (const f of await fs.readdir(this.p(d))) {
        if ((f.startsWith('.tmp-') || d === 'tmp') && (await old(this.p(d, f)))) await fs.rm(this.p(d, f), { recursive: true, force: true });
      }
    }
    for (const f of await fs.readdir(this.dataDir)) {
      if (f.startsWith('.tmp-') && (await old(this.p(f)))) await fs.rm(this.p(f), { force: true });
    }
    if (!fss.existsSync(this.p(RESTORE_MARKER))) {
      for (const f of await fs.readdir(this.dataDir)) {
        if (/^restore-(staging|old)-\d{8}-\d{6}$/.test(f) && (await old(this.p(f)))) await fs.rm(this.p(f), { recursive: true, force: true });
      }
    }
    for (const f of await fs.readdir(this.backupDir)) {
      if (f.startsWith('.tmp-') && (await old(path.join(this.backupDir, f)))) await fs.unlink(path.join(this.backupDir, f)).catch(() => undefined);
    }
  }

  /**
   * 他の PC の変更を取り込む。.changed が前回と同じなら何もしない。
   * 変わっていれば、ファイルの更新日時・サイズが変わったものだけ読み直す。
   */
  async refresh(force = false): Promise<void> {
    return this.read(async () => {
      if (!force && Date.now() - this.lastRefresh < REFRESH_MIN_MS) return;
      while (this.refreshing) {
        await this.refreshing;
        if (!force) return;
      }
      // 強制再走査は、進行中の通常読み取りに置き換えない。
      const refresh = this.doRefresh(force);
      this.refreshing = refresh;
      try { await refresh; }
      finally { if (this.refreshing === refresh) this.refreshing = null; }
    });
  }

  private async doRefresh(force: boolean): Promise<void> {
    let stamp = '';
    try { stamp = await fs.readFile(this.p('.changed'), 'utf8'); } catch { stamp = ''; }
    this.lastRefresh = Date.now();
    const full = force || Date.now() - this.lastFullScan >= FULL_SCAN_MS;
    if (!full && stamp && stamp === this.lastStamp) return;
    if (full) this.lastFullScan = Date.now();
    const names = (await fs.readdir(this.p('cards'))).filter((f) => /^[0-9a-f]{32}\.json$/.test(f));
    const seen = new Set<string>();
    const diskIds = new Set(names.map((name) => name.slice(0, 32)));
    const queue = [...names];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const id = f.slice(0, 32);
        seen.add(id);
        let st;
        try { st = await fs.stat(this.p('cards', f)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new StoreError('STORAGE_UNAVAILABLE', '名刺一覧を読み込めませんでした。'); seen.delete(id); continue; }
        const key = `${st.mtimeMs}:${st.size}`;
        if (!full && this.stats.get(id) === key && this.cards.has(id)) continue;
        try {
          const c = parseStoredCard(JSON.parse(await fs.readFile(this.p('cards', f), 'utf8')));
          if (c.id !== id) throw new Error('id mismatch');
          this.invalidCards.delete(id);
          this.cards.set(id, c);
          this.search.set(id, searchText(c));
          this.stats.set(id, key);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') { seen.delete(id); continue; }
          if (code) throw new StoreError('STORAGE_UNAVAILABLE', '名刺ファイルを読み込めませんでした。');
          this.invalidCards.add(id);
          // 壊れたファイルは消さずに残し、一覧から外してログに記録する
          log('error', 'invalid card file', { file: f, code: code ?? 'INVALID_CARD' });
          seen.delete(id);
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    for (const id of [...this.cards.keys()]) {
      if (!seen.has(id)) { this.cards.delete(id); this.search.delete(id); this.stats.delete(id); }
    }
    for (const id of this.invalidCards) if (!diskIds.has(id)) this.invalidCards.delete(id);
    this.lastStamp = stamp;
  }

  // ---------- 名刺 ----------

  list(): Card[] { return [...this.cards.values()]; }
  get(id: string): Card | undefined { return this.cards.get(id); }
  searchKey(id: string): string { return this.search.get(id) ?? ''; }

  /** ディスクから最新を読む（詳細・編集画面用） */
  async getFresh(id: string): Promise<Card | undefined> {
    return this.read(async () => {
      if (!ID_RE.test(id)) return undefined;
      const file = this.p('cards', `${id}.json`);
      try {
        const [buf, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
        const c = parseStoredCard(JSON.parse(buf));
        this.cards.set(id, c);
        this.search.set(id, searchText(c));
        this.stats.set(id, `${st.mtimeMs}:${st.size}`);
        return c;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') { this.cards.delete(id); this.search.delete(id); return undefined; }
        throw new StoreError('STORAGE_UNAVAILABLE', '名刺を読み込めませんでした。保存先の接続を確認してください。');
      }
    });
  }

  private async readDisk(id: string): Promise<Card | undefined> {
    try { return parseStoredCard(JSON.parse(await fs.readFile(this.p('cards', `${id}.json`), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }

  private async writeCard(c: Card): Promise<void> {
    const buf = Buffer.from(JSON.stringify(c, null, 2));
    await atomicWrite(this.p('cards'), `${c.id}.json`, buf);
    const st = await fs.stat(this.p('cards', `${c.id}.json`));
    this.cards.set(c.id, c);
    this.search.set(c.id, searchText(c));
    this.stats.set(c.id, `${st.mtimeMs}:${st.size}`);
  }

  private async assertImages(f: CardFields): Promise<void> {
    for (const img of [f.frontImage, f.backImage]) {
      if (img && !(await exists(this.p('images', `${img}.jpg`)))) throw new StoreError('INVALID', '指定された画像が見つかりません。画像を再度アップロードしてください。');
    }
  }

  create(fields: CardFields, userId?: string): Promise<Card> {
    const id = newId();
    return this.write(`card-${id}`, async () => {
      await this.assertImages(fields);
      const now = new Date().toISOString();
      const card: Card = { id, version: 1, createdAt: now, updatedAt: now, ...fields, createdBy: userId, updatedBy: userId };
      await this.writeCard(card);
      return card;
    });
  }

  /** 元写真の記録と名刺を同じJSONへ保存し、PC間でも再実行を直列化する。 */
  createFromAi(fields: CardFields, userId: string, sources: NonNullable<Card['aiSources']>, mustExist = false): Promise<{ card: Card; created: boolean }> {
    return this.write('card-ai-import', async () => {
      await this.doRefresh(true);
      if (this.invalidCards.size) throw new StoreError('INVALID', '読めない名刺があるため、AI登録の重複確認ができません。管理者に連絡してください。');
      const hashes = [...new Set(sources.map(s => s.hash))].sort().join(':');
      const existing = [...this.cards.values()].find(c => c.aiSources?.length && [...new Set(c.aiSources.map(s => s.hash))].sort().join(':') === hashes);
      if (existing) return { card: existing, created: false };
      if (mustExist) throw new StoreError('INVALID', '元写真が見つからず、登録済みの名刺も確認できません。再登録を中止しました。');
      await this.assertImages(fields);
      const now = new Date().toISOString();
      const card: Card = { ...fields, id: newId(), version: 1, createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId, aiSources: sources };
      await this.writeCard(card);
      return { card, created: true };
    });
  }

  update(id: string, baseVersion: number, fields: CardFields, userId?: string): Promise<Card> {
    return this.write(`card-${id}`, async () => {
      const cur = await this.readDisk(id);
      if (!cur) throw new StoreError('NOT_FOUND', '名刺が見つかりません（他のPCで削除された可能性があります）。');
      if (cur.version !== baseVersion) throw new StoreError('CONFLICT', '他のPCで先に更新されています。', cur);
      await this.assertImages(fields);
      const card: Card = { ...cur, ...fields, version: cur.version + 1, updatedAt: new Date().toISOString(), updatedBy: userId ?? cur.updatedBy };
      await this.writeCard(card);
      return card;
    });
  }

  /** 削除はゴミ箱（trash）へ移動。画像はゴミ箱からも参照扱いで残す。 */
  remove(id: string, baseVersion: number, userId?: string): Promise<void> {
    return this.write(`card-${id}`, async () => {
      const cur = await this.readDisk(id);
      if (!cur) throw new StoreError('NOT_FOUND', '名刺が見つかりません。');
      if (cur.version !== baseVersion) throw new StoreError('CONFLICT', '他のPCで更新されています。内容を確認してから削除してください。', cur);
      await atomicWrite(this.p('trash'), `${id}-${Date.now()}.json`, Buffer.from(JSON.stringify({ ...cur, deletedAt: new Date().toISOString(), deletedBy: userId }, null, 2)));
      await fs.unlink(this.p('cards', `${id}.json`));
      this.cards.delete(id);
      this.search.delete(id);
      this.stats.delete(id);
    });
  }

  duplicates(f: Partial<CardFields>, excludeId?: string): Card[] {
    const name = norm(f.name ?? '');
    const company = normCompany(f.company ?? '');
    const email = norm(f.email ?? '');
    const phones = [f.phone, f.mobile].map((x) => normPhone(x ?? '')).filter((x) => x.length >= 9);
    return this.list().filter((c) => {
      if (c.id === excludeId) return false;
      if (email && norm(c.email) === email) return true;
      const cp = [c.phone, c.mobile].map(normPhone);
      if (phones.length && phones.some((p) => cp.includes(p))) return true;
      if (name && norm(c.name) === name && (!company || !c.company || normCompany(c.company) === company)) return true;
      return false;
    }).slice(0, 10);
  }

  // ---------- 画像 ----------

  putImage(data: Buffer): Promise<string> {
    let clean: Buffer;
    try { clean = sanitizeJpeg(data); } catch (e) { return Promise.reject(new StoreError('INVALID', (e as Error).message)); }
    const id = newId();
    return this.write(`img-${id}`, async () => {
      await atomicWrite(this.p('images'), `${id}.jpg`, clean);
      return id;
    });
  }

  imagePath(id: string): string {
    if (!ID_RE.test(id)) throw new StoreError('NOT_FOUND', '画像が見つかりません。');
    return this.p('images', `${id}.jpg`);
  }

  private async referencedImages(): Promise<Set<string>> {
    await this.refresh(true);
    if (this.invalidCards.size) throw new StoreError('INVALID', '読めない名刺があるため、画像の掃除を中止しました。');
    const refs = new Set<string>();
    for (const c of this.cards.values()) { if (c.frontImage) refs.add(c.frontImage); if (c.backImage) refs.add(c.backImage); }
    for (const f of await fs.readdir(this.p('trash'))) {
      try {
        const t = parseStoredCard(JSON.parse(await fs.readFile(this.p('trash', f), 'utf8')));
        for (const k of ['frontImage', 'backImage'] as const) if (typeof t[k] === 'string') refs.add(t[k]);
      } catch { throw new StoreError('STORAGE_UNAVAILABLE', 'ゴミ箱の名刺を読み込めないため、画像の掃除を中止しました。'); }
    }
    return refs;
  }

  /** 参照されていない古い画像（アップロード後に保存されなかったもの・差し替え前のもの）を削除 */
  gcImages(): Promise<number> {
    return this.withLock('jobs', async () => {
      await this.assertNoMaintenance();
      const refs = await this.referencedImages();
      let n = 0;
      for (const f of await fs.readdir(this.p('images'))) {
        const m = /^([0-9a-f]{32})\.jpg$/.exec(f);
        if (!m || refs.has(m[1]!)) continue;
        const st = await fs.stat(this.p('images', f));
        if (Date.now() - st.mtimeMs > ORPHAN_IMAGE_AGE_MS) { await fs.unlink(this.p('images', f)); n++; }
      }
      return n;
    }, 0);
  }

  // ---------- バックアップ ----------

  /** 破損データは修正・除外せず退避する。通常の復元には使わない保全用tar。maintenance/jobs保持中のみ呼ぶ。 */
  private async preserveBeforeRestore(): Promise<BackupInfo> {
    let name = `meishi-${stamp()}-preservation.tar`;
    for (let i = 2; await exists(path.join(this.backupDir, name)); i++) name = `meishi-${stamp()}-preservation-${i}.tar`;
    const tmp = path.join(this.backupDir, `.tmp-${name}`);
    let writer: TarWriter | undefined;
    try {
      writer = await TarWriter.create(tmp);
      const files: Record<string, string> = {};
      const addDir = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(this.p(dir), { withFileTypes: true })) {
          const relative = `${dir}/${entry.name}`;
          if (entry.isDirectory()) { await addDir(relative); continue; }
          if (!entry.isFile()) throw new Error('保存先に通常ファイル以外が含まれています。');
          const bytes = await fs.readFile(this.p(relative));
          files[relative] = sha256(bytes);
          await writer!.add(relative, bytes);
        }
      };
      for (const dir of ['cards', 'images', 'trash']) await addDir(dir);
      await writer.add('manifest.json', Buffer.from(JSON.stringify({ format: 'meishi-preservation', formatVersion: 1, files })));
      await writer.finish(); writer = undefined;
      const reader = await TarReader.open(tmp);
      try {
        if (reader.entries.length !== Object.keys(files).length + 1) throw new Error('保全ファイル数が一致しません。');
        const names = new Set<string>();
        for (const entry of reader.entries) {
          if (names.has(entry.name)) throw new Error('保全ファイルが重複しています。');
          names.add(entry.name);
          const bytes = await reader.read(entry);
          if (entry.name === 'manifest.json') {
            const manifest = JSON.parse(bytes.toString('utf8'));
            if (manifest.format !== 'meishi-preservation' || JSON.stringify(manifest.files) !== JSON.stringify(files)) throw new Error('保全情報が一致しません。');
          } else if (sha256(bytes) !== files[entry.name]) throw new Error('保全ファイルのハッシュが一致しません。');
        }
      } finally { await reader.close(); }
      await fs.rename(tmp, path.join(this.backupDir, name));
      const st = await fs.stat(path.join(this.backupDir, name));
      log('warn', 'damaged store preserved before restore', { files: Object.keys(files).length });
      return { name, kind: 'preservation', createdAt: st.mtime.toISOString(), size: st.size };
    } catch {
      await writer?.abort();
      await fs.unlink(tmp).catch(() => undefined);
      throw new StoreError('STORAGE_UNAVAILABLE', '破損データの保全に失敗したため、復元を中止しました。保存先の接続と空き容量を確認してください。');
    }
  }

  async listBackups(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    for (const f of await fs.readdir(this.backupDir)) {
      const m = BACKUP_NAME_RE.exec(f);
      if (!m) continue;
      const st = await fs.stat(path.join(this.backupDir, f));
      out.push({ name: f, kind: m[2]!, createdAt: st.mtime.toISOString(), size: st.size });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }

  backupPath(name: string): string {
    if (!BACKUP_NAME_RE.test(name)) throw new StoreError('NOT_FOUND', 'バックアップが見つかりません。');
    return path.join(this.backupDir, name);
  }

  /**
   * バックアップ作成。jobs ロック中（画像の掃除と排他）に最新の名刺を読み、参照画像とともに書き出す。
   * 画像は不変で、掃除も同じロックで止まっているので、名刺と画像の対応が崩れない。
   */
  async createBackup(kind: 'auto' | 'manual' | 'pre-restore'): Promise<BackupInfo> {
    try { await this.checkMarker(); } catch (e) { throw e; }
    return this.withLock('jobs', async () => {
      if (kind === 'pre-restore') await this.doRefresh(true);
      else { await this.assertNoMaintenance(); await this.refresh(true); }
      if (this.invalidCards.size) {
        if (kind === 'pre-restore') return this.preserveBeforeRestore();
        throw new StoreError('INVALID', '読めない名刺があるため、バックアップを中止しました。元ファイルを確認してください。');
      }
      const cards = [...this.cards.values()].map((c) => ({ ...c }));
      const images = new Set<string>();
      for (const c of cards) { if (c.frontImage) images.add(c.frontImage); if (c.backImage) images.add(c.backImage); }
      let name = `meishi-${stamp()}-${kind}.tar`;
      for (let i = 2; await exists(path.join(this.backupDir, name)); i++) name = `meishi-${stamp()}-${kind}-${i}.tar`;
      const tmp = path.join(this.backupDir, `.tmp-${name}`);
      let w: TarWriter | undefined;
      try {
        w = await TarWriter.create(tmp);
        const files: Record<string, string> = {};
        for (const c of cards) {
          const b = Buffer.from(JSON.stringify(c, null, 2));
          files[`cards/${c.id}.json`] = sha256(b);
          await w.add(`cards/${c.id}.json`, b);
        }
        for (const id of images) {
          const b = await fs.readFile(this.p('images', `${id}.jpg`));
          files[`images/${id}.jpg`] = sha256(b);
          await w.add(`images/${id}.jpg`, b);
        }
        const manifest: Manifest = { format: BACKUP_FORMAT, formatVersion: 1, createdAt: new Date().toISOString(), cardCount: cards.length, imageCount: images.size, files };
        await w.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
        await w.finish();
        w = undefined;
        await Store.verifyArchive(tmp);
        await fs.rename(tmp, path.join(this.backupDir, name));
      } catch (e) {
        await w?.abort();
        await fs.unlink(tmp).catch(() => undefined);
        log('error', 'backup failed', { error: (e as Error).message });
        if (e instanceof StoreError) throw e;
        throw new StoreError('STORAGE_UNAVAILABLE', 'バックアップを作成できませんでした。保存先の接続と空き容量を確認してください。');
      }
      const st = await fs.stat(path.join(this.backupDir, name));
      log('info', 'backup created', { name, cards: cards.length, images: images.size });
      return { name, kind, createdAt: st.mtime.toISOString(), size: st.size };
    }, kind === 'auto' ? 0 : LOCK_WAIT_MS);
  }

  /** 自動バックアップ：前回の自動バックアップから intervalHours 経っていれば作成（どの PC が実行してもよい） */
  async autoBackup(intervalHours: number, keep: number): Promise<BackupInfo | null> {
    const last = (await this.listBackups()).find((b) => b.kind === 'auto');
    if (last && Date.now() - Date.parse(last.createdAt) < intervalHours * 3600_000 - 60_000) return null;
    try {
      const b = await this.createBackup('auto');
      this.backupError = '';
      await this.pruneBackups(keep);
      return b;
    } catch (e) {
      if (e instanceof StoreError && e.code === 'LOCKED') return null; // 他の PC が実行中
      this.backupError = e instanceof StoreError && e.code === 'STALE_LOCK'
        ? '残留ロックにより自動バックアップが停止しています。管理者が導入手順の復旧方法を確認してください。'
        : '自動バックアップに失敗しました。保存先・空き容量・読めない名刺を確認してください。';
      log('error', 'auto backup stopped', { code: e instanceof StoreError ? e.code : 'IO_ERROR' });
      throw e;
    }
  }

  async pruneBackups(keep: number): Promise<void> {
    const autos = (await this.listBackups()).filter((b) => b.kind === 'auto');
    for (const b of autos.slice(keep)) await fs.unlink(path.join(this.backupDir, b.name)).catch(() => undefined);
  }

  /** アーカイブの形式・ハッシュ・名刺データの整合性を検証する */
  static async verifyArchive(file: string): Promise<BackupSummary> {
    let r: TarReader;
    try { r = await TarReader.open(file); } catch (e) { throw new StoreError('INVALID', `バックアップファイルの形式が不正です: ${(e as Error).message}`); }
    try {
      const me = r.entries.find((e) => e.name === 'manifest.json');
      if (!me || me.size > 50 * 1024 * 1024) throw new Error('manifest.json がありません。');
      const m = JSON.parse((await r.read(me)).toString('utf8')) as Manifest;
      if (m.format === 'meishi-preservation') throw new Error('これは破損データの保全用アーカイブです。管理者が展開して確認してください。通常の復元には使えません。');
      if (m.format !== BACKUP_FORMAT || m.formatVersion !== 1) throw new Error('このアプリのバックアップではありません。');
      if (r.entries.filter((e) => e.name === 'manifest.json').length !== 1) throw new Error('manifest.json が重複しています。');
      const names = new Set<string>();
      let cards = 0;
      let imgs = 0;
      const needImages = new Set<string>();
      for (const e of r.entries) {
        if (e.name === 'manifest.json') continue;
        if (names.has(e.name)) throw new Error('同じファイルが重複しています。');
        names.add(e.name);
        const cm = /^cards\/([0-9a-f]{32})\.json$/.exec(e.name);
        const im = /^images\/([0-9a-f]{32})\.jpg$/.exec(e.name);
        if (!cm && !im) throw new Error(`想定外のファイルが含まれています: ${e.name.slice(0, 80)}`);
        if (e.size > 20 * 1024 * 1024) throw new Error('ファイルサイズが大きすぎます。');
        const b = await r.read(e);
        if (m.files[e.name] !== sha256(b)) throw new Error(`ハッシュが一致しません: ${e.name}`);
        if (cm) {
          const c = parseStoredCard(JSON.parse(b.toString('utf8')));
          if (c.id !== cm[1]) throw new Error('名刺 ID が一致しません。');
          if (c.frontImage) needImages.add(c.frontImage);
          if (c.backImage) needImages.add(c.backImage);
          cards++;
        } else {
          sanitizeJpeg(b);
          imgs++;
        }
      }
      if (Object.keys(m.files).length !== names.size) throw new Error('manifest と内容のファイル数が一致しません。');
      for (const id of needImages) if (!names.has(`images/${id}.jpg`)) throw new Error('名刺が参照する画像が含まれていません。');
      if (cards !== m.cardCount || imgs !== m.imageCount) throw new Error('件数が manifest と一致しません。');
      return { createdAt: m.createdAt, cardCount: cards, imageCount: imgs };
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError('INVALID', `バックアップの検証に失敗しました: ${(e as Error).message}`);
    } finally {
      await r.close();
    }
  }

  /** 復元用の一時ディレクトリ（共有フォルダ内 tmp） */
  tmpPath(name: string): string { return this.p('tmp', name); }

  /** 他の PC の読み書き（card-/img-/read- ロック）が終わるのを待つ */
  private async waitForWriters(): Promise<void> {
    const until = Date.now() + LOCK_STALE_MS + 5_000;
    for (;;) {
      const busy = [];
      for (const f of await fs.readdir(this.p('locks'))) {
        if (!/^(card|img|read)-/.test(f)) continue;
        const age = await this.lockAge(f.replace(/\.lock$/, ''));
        if (age !== null) busy.push(f);
      }
      if (!busy.length) return;
      if (Date.now() > until) throw new StoreError('LOCKED', '他のPCの保存処理が終わらないため、復元を中止しました。');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * 復元：maintenance ロック（他の PC の保存を止める）→ 書き込み中の処理を待つ → 検証
   * → 現在のデータを pre-restore バックアップへ退避 → staging へ展開
   * → マーカーを書いてからディレクトリを入れ替え。途中で止まっても次回起動時（どの PC でも）に入れ替えを完了させる。
   */
  restore(file: string): Promise<{ summary: BackupSummary; preRestore: BackupInfo }> {
    return this.withLock('maintenance', async () => {
      await this.checkMarker();
      await this.waitForWriters();
      const summary = await Store.verifyArchive(file);
      const preRestore = await this.createBackup('pre-restore');
      const id = stamp();
      const staging = this.p(`restore-staging-${id}`);
      const old = this.p(`restore-old-${id}`);
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(path.join(staging, 'cards'), { recursive: true });
      await fs.mkdir(path.join(staging, 'images'), { recursive: true });
      const r = await TarReader.open(file);
      try {
        for (const e of r.entries) {
          if (e.name === 'manifest.json') continue;
          const [dir, fname] = e.name.split('/') as [string, string];
          await atomicWrite(path.join(staging, dir), fname, await r.read(e));
        }
      } finally { await r.close(); }
      await fs.mkdir(old, { recursive: true });
      await atomicWrite(this.dataDir, RESTORE_MARKER, Buffer.from(JSON.stringify({ staging, old })));
      await this.finishRestore(staging, old);
      await this.touchChanged();
      this.cards.clear(); this.search.clear(); this.stats.clear();
      await this.doRefresh(true);
      log('info', 'restore completed', { cards: summary.cardCount, images: summary.imageCount });
      return { summary, preRestore };
    });
  }

  private async finishRestore(staging: string, old: string): Promise<void> {
    for (const d of ['cards', 'images']) {
      if (await exists(path.join(staging, d))) {
        if (await exists(this.p(d))) {
          if (await exists(path.join(old, d))) throw new StoreError('INVALID', '復元の再開に失敗しました。管理者が確認してください。');
          await fs.rename(this.p(d), path.join(old, d));
        }
        await fs.rename(path.join(staging, d), this.p(d));
      }
    }
    await fs.unlink(this.p(RESTORE_MARKER));
    await fs.rm(old, { recursive: true, force: true });
    await fs.rm(staging, { recursive: true, force: true });
  }

  /** 復元が途中で止まっていたら完了させる（復元中の PC がまだ動いている間は触らない） */
  private async recoverRestore(): Promise<void> {
    if (!fss.existsSync(this.p(RESTORE_MARKER))) return;
    // 呼び出し元 open() が maintenance を保持している。
    await this.waitForWriters();
    const { staging, old } = JSON.parse(await fs.readFile(this.p(RESTORE_MARKER), 'utf8'));
    const okPath = (x: unknown, prefix: string) => typeof x === 'string' && path.dirname(x) === this.dataDir
      && new RegExp(`^${prefix}-\\d{8}-\\d{6}$`).test(path.basename(x));
    if (!okPath(staging, 'restore-staging') || !okPath(old, 'restore-old')) throw new StoreError('INVALID', '復元マーカーが不正です。管理者が確認してください。');
    log('warn', 'resuming interrupted restore');
    await this.finishRestore(staging, old);
    await this.touchChanged();
  }
}
