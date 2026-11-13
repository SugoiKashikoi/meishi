/**
 * 共有フォルダ上のファイルストア。
 *
 * - 稼働中の書き込みはこのサーバープロセスだけが行う（.lock で二重起動を拒否）。
 * - 1 名刺 = 1 JSON ファイル。一時ファイルに書いて fsync → 同じディレクトリ内で rename（置き換え）
 *   → 読み戻して内容一致を確認。途中で失敗しても旧ファイルか新ファイルのどちらかが残る。
 * - 画像は不変（内容を変えるときは新しい ID）。名刺 JSON より先に書くので、
 *   名刺が存在しない画像を参照する状態は作らない。参照されない古い画像だけを後で掃除する。
 * - 更新はプロセス内で直列化し、version による楽観的排他で古い内容での上書きを拒否する。
 * - 書き込み失敗時は別の場所へ退避せず、明確なエラーを返す。
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Card, CardFields, ID_RE, parseStoredCard, searchText, norm, normPhone, normCompany } from './card.js';
import { TarReader, TarWriter } from './tar.js';
import { sanitizeJpeg } from './jpeg.js';
import { log } from './log.js';

export type StoreErrorCode = 'STORAGE_UNAVAILABLE' | 'CONFLICT' | 'NOT_FOUND' | 'LOCKED' | 'INVALID';

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string, readonly current?: Card) {
    super(message);
  }
}

const MARKER = '.meishi-store';
const LOCK = '.lock';
const RESTORE_MARKER = 'restore-in-progress.json';
const LOCK_STALE_MS = 120_000;
const ORPHAN_IMAGE_AGE_MS = 24 * 3600_000;
export const BACKUP_FORMAT = 'meishi-backup';
const BACKUP_NAME_RE = /^meishi-(\d{8}-\d{6})-(auto|manual|pre-restore)(-\d+)?\.tar$/;

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

export interface StoreOptions { dataDir: string; backupDir: string; instanceLabel?: string }

export class Store {
  readonly dataDir: string;
  readonly backupDir: string;
  private cards = new Map<string, Card>();
  private search = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly instanceId = newId();
  private heartbeat?: NodeJS.Timeout;
  private pinned = new Map<string, number>();
  available = false;
  lastError = '';
  private needsReload = false;
  private lockLost = false;

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.backupDir = opts.backupDir;
  }

  private p(...xs: string[]): string { return path.join(this.dataDir, ...xs); }

  /** 保存先を初期化する（CLI から明示的に実行）。既存データは消さない。 */
  static async init(dataDir: string, backupDir: string, opts: { dev?: boolean } = {}): Promise<void> {
    const parent = path.dirname(dataDir);
    if (!(await exists(parent))) throw new Error(`親フォルダにアクセスできません: ${parent}`);
    await fs.mkdir(dataDir, { recursive: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    for (const d of ['cards', 'images', 'trash', 'tmp']) await fs.mkdir(path.join(dataDir, d), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    const marker = path.join(dataDir, MARKER);
    if (!(await exists(marker))) {
      await atomicWrite(dataDir, MARKER, Buffer.from(JSON.stringify({ format: 'meishi-store', formatVersion: 1, createdAt: new Date().toISOString(), dev: !!opts.dev }, null, 2)));
    }
  }

  async isDevStore(): Promise<boolean> {
    try { return !!JSON.parse(await fs.readFile(this.p(MARKER), 'utf8')).dev; } catch { return false; }
  }

  /** 起動時処理。保存先に接続できない場合は例外。 */
  async open(): Promise<void> {
    await this.checkMarker();
    await this.acquireLock();
    await this.recoverRestore();
    await this.cleanTemp();
    await this.reload();
    this.available = true;
    this.heartbeat = setInterval(() => void this.tick(), 30_000);
    this.heartbeat.unref();
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.chain.catch(() => undefined);
    try {
      const lock = JSON.parse(await fs.readFile(this.p(LOCK), 'utf8'));
      if (lock.instanceId === this.instanceId) await fs.unlink(this.p(LOCK));
    } catch { /* ignore */ }
  }

  private async checkMarker(): Promise<void> {
    try {
      const m = JSON.parse(await fs.readFile(this.p(MARKER), 'utf8'));
      if (m.format !== 'meishi-store') throw new Error();
    } catch {
      throw new StoreError('STORAGE_UNAVAILABLE', `保存先にアクセスできないか、初期化されていません: ${this.dataDir}`);
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      const cur = JSON.parse(await fs.readFile(this.p(LOCK), 'utf8'));
      const age = Date.now() - Date.parse(cur.heartbeat);
      // 同じPCで前回のプロセスが既に終了している場合（異常終了・強制停止）は待たずに引き継ぐ
      let deadLocal = false;
      if (cur.host === os.hostname() && Number.isInteger(cur.pid) && cur.pid !== process.pid) {
        try { process.kill(cur.pid, 0); } catch { deadLocal = true; }
      }
      if (cur.instanceId !== this.instanceId && age < LOCK_STALE_MS && !deadLocal) {
        throw new StoreError('LOCKED', `別のサーバー（${cur.host} / PID ${cur.pid}）がこの保存先を使用中です。二重起動はできません。`);
      }
    } catch (e) {
      if (e instanceof StoreError) throw e;
    }
    await this.writeLock();
  }

  private async writeLock(): Promise<void> {
    const body = { instanceId: this.instanceId, host: os.hostname(), pid: process.pid, heartbeat: new Date().toISOString() };
    await atomicWrite(this.dataDir, LOCK, Buffer.from(JSON.stringify(body)));
  }

  /** 定期処理：ロック更新と接続確認 */
  async tick(): Promise<void> {
    try {
      await this.checkMarker();
      const cur = JSON.parse(await fs.readFile(this.p(LOCK), 'utf8'));
      if (cur.instanceId !== this.instanceId) {
        this.lockLost = true;
        throw new StoreError('LOCKED', '別のサーバーがこの保存先のロックを取得しました。保存を停止しています。');
      }
      await this.writeLock();
      if (this.needsReload) await this.exclusive(() => this.reload());
      if (!this.available) log('info', 'storage reconnected');
      this.available = true;
      this.lastError = '';
    } catch (e) {
      if (this.available) log('warn', 'storage unavailable', { error: (e as Error).message });
      this.available = false;
      this.lastError = e instanceof StoreError ? e.message : '保存先（共有フォルダ）に接続できません。';
    }
  }

  /** 書き込み可能かを実際に確認する */
  async probe(): Promise<boolean> {
    try {
      await atomicWrite(this.p('tmp'), 'probe', Buffer.from(new Date().toISOString()));
      await this.tick();
    } catch (e) {
      this.available = false;
      this.lastError = '保存先（共有フォルダ）に書き込めません。';
      log('warn', 'probe failed', { error: (e as Error).message });
    }
    return this.available;
  }

  private async cleanTemp(): Promise<void> {
    for (const d of ['cards', 'images', 'trash', 'tmp']) {
      for (const f of await fs.readdir(this.p(d))) {
        if (f.startsWith('.tmp-') || d === 'tmp') await fs.rm(this.p(d, f), { recursive: true, force: true });
      }
    }
    if (!fss.existsSync(this.p(RESTORE_MARKER))) {
      for (const f of await fs.readdir(this.dataDir)) {
        if (/^restore-(staging|old)-\d{8}-\d{6}$/.test(f)) await fs.rm(this.p(f), { recursive: true, force: true });
      }
    }
    await fs.mkdir(this.backupDir, { recursive: true });
    for (const f of await fs.readdir(this.backupDir)) {
      if (f.startsWith('.tmp-')) await fs.unlink(path.join(this.backupDir, f)).catch(() => undefined);
    }
  }

  private async reload(): Promise<void> {
    const next = new Map<string, Card>();
    for (const f of await fs.readdir(this.p('cards'))) {
      const m = /^([0-9a-f]{32})\.json$/.exec(f);
      if (!m) continue;
      try {
        const c = parseStoredCard(JSON.parse(await fs.readFile(this.p('cards', f), 'utf8')));
        if (c.id !== m[1]) throw new Error('id mismatch');
        next.set(c.id, c);
      } catch (e) {
        // 壊れたファイルは消さずに別名で残し、管理者が確認できるようにする
        log('error', 'invalid card file', { file: f, error: (e as Error).message });
        await fs.rename(this.p('cards', f), this.p('cards', `${f}.invalid-${Date.now()}`)).catch(() => undefined);
      }
    }
    this.cards = next;
    this.search = new Map([...next].map(([id, c]) => [id, searchText(c)]));
    this.needsReload = false;
  }

  /** 書き込み処理を直列化する */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async guardWrite<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockLost) throw new StoreError('LOCKED', '別のサーバーがこの保存先を使用しているため保存できません。');
    try {
      await this.checkMarker();
      return await fn();
    } catch (e) {
      if (e instanceof StoreError && e.code !== 'STORAGE_UNAVAILABLE') throw e;
      this.available = false;
      this.needsReload = true;
      this.lastError = '保存先（共有フォルダ）に保存できませんでした。';
      log('error', 'write failed', { error: (e as Error).message });
      throw new StoreError('STORAGE_UNAVAILABLE', '保存先（共有フォルダ）に保存できませんでした。接続を確認してから再度保存してください。');
    }
  }

  // ---------- 名刺 ----------

  list(): Card[] { return [...this.cards.values()]; }
  get(id: string): Card | undefined { return this.cards.get(id); }
  searchKey(id: string): string { return this.search.get(id) ?? ''; }

  private async writeCard(c: Card): Promise<void> {
    await atomicWrite(this.p('cards'), `${c.id}.json`, Buffer.from(JSON.stringify(c, null, 2)));
    this.cards.set(c.id, c);
    this.search.set(c.id, searchText(c));
  }

  private async assertImages(f: CardFields): Promise<void> {
    for (const img of [f.frontImage, f.backImage]) {
      if (img && !(await exists(this.p('images', `${img}.jpg`)))) throw new StoreError('INVALID', '指定された画像が見つかりません。画像を再度アップロードしてください。');
    }
  }

  create(fields: CardFields): Promise<Card> {
    return this.exclusive(() => this.guardWrite(async () => {
      await this.assertImages(fields);
      const now = new Date().toISOString();
      const card: Card = { id: newId(), version: 1, createdAt: now, updatedAt: now, ...fields };
      await this.writeCard(card);
      return card;
    }));
  }

  update(id: string, baseVersion: number, fields: CardFields): Promise<Card> {
    return this.exclusive(() => this.guardWrite(async () => {
      const cur = this.cards.get(id);
      if (!cur) throw new StoreError('NOT_FOUND', '名刺が見つかりません（削除された可能性があります）。');
      if (cur.version !== baseVersion) throw new StoreError('CONFLICT', '他の端末で先に更新されています。', cur);
      await this.assertImages(fields);
      const card: Card = { ...cur, ...fields, version: cur.version + 1, updatedAt: new Date().toISOString() };
      await this.writeCard(card);
      return card;
    }));
  }

  /** 削除はゴミ箱（trash）へ移動。画像はゴミ箱からも参照扱いで残す。 */
  remove(id: string, baseVersion: number): Promise<void> {
    return this.exclusive(() => this.guardWrite(async () => {
      const cur = this.cards.get(id);
      if (!cur) throw new StoreError('NOT_FOUND', '名刺が見つかりません。');
      if (cur.version !== baseVersion) throw new StoreError('CONFLICT', '他の端末で更新されています。内容を確認してから削除してください。', cur);
      await atomicWrite(this.p('trash'), `${id}-${Date.now()}.json`, Buffer.from(JSON.stringify({ ...cur, deletedAt: new Date().toISOString() }, null, 2)));
      await fs.unlink(this.p('cards', `${id}.json`));
      this.cards.delete(id);
      this.search.delete(id);
    }));
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
      if (phones.some((p) => cp.includes(p)) && phones.length) return true;
      if (name && norm(c.name) === name && (!company || !c.company || normCompany(c.company) === company)) return true;
      return false;
    }).slice(0, 10);
  }

  // ---------- 画像 ----------

  putImage(data: Buffer): Promise<string> {
    let clean: Buffer;
    try { clean = sanitizeJpeg(data); } catch (e) { return Promise.reject(new StoreError('INVALID', (e as Error).message)); }
    return this.exclusive(() => this.guardWrite(async () => {
      const id = newId();
      await atomicWrite(this.p('images'), `${id}.jpg`, clean);
      return id;
    }));
  }

  imagePath(id: string): string {
    if (!ID_RE.test(id)) throw new StoreError('NOT_FOUND', '画像が見つかりません。');
    return this.p('images', `${id}.jpg`);
  }

  private async referencedImages(): Promise<Set<string>> {
    const refs = new Set<string>();
    for (const c of this.cards.values()) { if (c.frontImage) refs.add(c.frontImage); if (c.backImage) refs.add(c.backImage); }
    for (const f of await fs.readdir(this.p('trash'))) {
      try {
        const t = JSON.parse(await fs.readFile(this.p('trash', f), 'utf8'));
        for (const k of ['frontImage', 'backImage']) if (typeof t[k] === 'string') refs.add(t[k]);
      } catch { /* ignore */ }
    }
    for (const id of this.pinned.keys()) refs.add(id);
    return refs;
  }

  /** 参照されていない古い画像（アップロード後に保存されなかったもの・差し替え前のもの）を削除 */
  gcImages(): Promise<number> {
    return this.exclusive(() => this.guardWrite(async () => {
      const refs = await this.referencedImages();
      let n = 0;
      for (const f of await fs.readdir(this.p('images'))) {
        const m = /^([0-9a-f]{32})\.jpg$/.exec(f);
        if (!m || refs.has(m[1]!)) continue;
        const st = await fs.stat(this.p('images', f));
        if (Date.now() - st.mtimeMs > ORPHAN_IMAGE_AGE_MS) { await fs.unlink(this.p('images', f)); n++; }
      }
      return n;
    }));
  }

  // ---------- バックアップ ----------

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
   * バックアップ作成。名刺 JSON はロック中にメモリからスナップショットを取り、
   * 参照画像は不変なので「ピン留め」して掃除対象から外したうえで書き出す。
   */
  async createBackup(kind: 'auto' | 'manual' | 'pre-restore', inLock = false): Promise<BackupInfo> {
    const snap = async () => this.guardWrite(async () => [...this.cards.values()].map((c) => ({ ...c })));
    const cards = inLock ? await snap() : await this.exclusive(snap);
    const images = new Set<string>();
    for (const c of cards) { if (c.frontImage) images.add(c.frontImage); if (c.backImage) images.add(c.backImage); }
    for (const id of images) this.pinned.set(id, (this.pinned.get(id) ?? 0) + 1);
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
    } finally {
      for (const id of images) {
        const n = (this.pinned.get(id) ?? 1) - 1;
        if (n <= 0) this.pinned.delete(id); else this.pinned.set(id, n);
      }
    }
    const st = await fs.stat(path.join(this.backupDir, name));
    log('info', 'backup created', { name, cards: cards.length, images: images.size });
    return { name, kind, createdAt: st.mtime.toISOString(), size: st.size };
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
      if (m.format !== BACKUP_FORMAT || m.formatVersion !== 1) throw new Error('このアプリのバックアップではありません。');
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

  /**
   * 復元：検証 → 現在のデータを pre-restore バックアップとして退避 → staging へ展開・再検証
   * → マーカーを書いてからディレクトリを入れ替え。途中で止まっても起動時に入れ替えを完了させる。
   */
  restore(file: string): Promise<{ summary: BackupSummary; preRestore: BackupInfo }> {
    return this.exclusive(() => this.guardWrite(async () => {
      const summary = await Store.verifyArchive(file);
      const preRestore = await this.createBackup('pre-restore', true);
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
      await this.reload();
      log('info', 'restore completed', { cards: summary.cardCount, images: summary.imageCount });
      return { summary, preRestore };
    }));
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
    // 旧データは pre-restore バックアップに保存済みなので削除
    await fs.rm(old, { recursive: true, force: true });
    await fs.rm(staging, { recursive: true, force: true });
  }

  private async recoverRestore(): Promise<void> {
    if (!fss.existsSync(this.p(RESTORE_MARKER))) return;
    const { staging, old } = JSON.parse(await fs.readFile(this.p(RESTORE_MARKER), 'utf8'));
    const okPath = (x: unknown) => typeof x === 'string' && path.dirname(x) === this.dataDir && /restore-(staging|old)-\d{8}-\d{6}$/.test(x);
    if (!okPath(staging) || !okPath(old)) throw new StoreError('INVALID', '復元マーカーが不正です。管理者が確認してください。');
    log('warn', 'resuming interrupted restore');
    await this.finishRestore(staging, old);
  }
}
