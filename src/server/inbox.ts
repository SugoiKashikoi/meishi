/**
 * 取り込み用フォルダ（共有フォルダ）。各利用者が複合機のスキャンやコピーで名刺画像を置く。
 *
 * - アプリはファイルを「未整理」として一覧表示するだけで、自動で名刺として確定しない。
 * - 利用者が画面で内容を入力して名刺を保存したとき（または破棄したとき）に、
 *   元ファイルを「取り込み済み」フォルダ（既定はデータフォルダ内。利用者からは見えない）へ移動する。
 * - 取り込み用フォルダが別の共有でも動くよう、移動は「コピー → サイズ確認 → 元を削除」で行う。
 * - ファイルの指定は一覧で発行した ID のみ。利用者の入力をパスとして使わない。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StoreError } from './store.js';
import { log } from './log.js';
import { extractJpegsFromPdf, isPdf } from './pdf.js';

export class InboxGoneError extends Error {
  constructor() { super('この画像は既に他の利用者が取り込んだか、移動・削除されています。「未整理」の一覧を更新してください。'); }
}

export const INBOX_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.pdf': 'application/pdf',
};
const MAX_BYTES = 30 * 1024 * 1024;
/** 書き込み途中（複合機が保存中など）のファイルを避けるため、更新から一定時間経ったものだけ扱う */
const SETTLE_MS = 10_000;
const CLAIM_MS = 30 * 60_000;

export interface InboxItem { id: string; name: string; size: number; mtime: string; type: string; claimedBy?: string; error?: string }

export class Inbox {
  private items = new Map<string, InboxItem & { file: string }>();
  private claims = new Map<string, { user: string; at: number }>();
  private pdfErrors = new Map<string, string>();
  lastError = '';

  /**
   * @param lock PC 間の排他（共有フォルダ上のロックファイル）。PDF の分割・取り込み済みへの移動・追加はこの中で行う
   */
  constructor(readonly dir: string, readonly doneDir: string, private retentionDays: number,
    private lock: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> { return this.lock(fn); }

  async scan(): Promise<InboxItem[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      this.lastError = '取り込み用フォルダにアクセスできません。';
      throw new StoreError('STORAGE_UNAVAILABLE', `取り込み用フォルダにアクセスできません: ${this.dir}`);
    }
    if (names.some((n) => n.toLowerCase().endsWith('.pdf'))) {
      if (await this.serial(() => this.splitPdfs(names))) names = await fs.readdir(this.dir).catch(() => names);
    }
    const next = new Map<string, InboxItem & { file: string }>();
    const now = Date.now();
    for (const name of names) {
      const type = INBOX_EXT[path.extname(name).toLowerCase()];
      if (!type || name.startsWith('.') || name.startsWith('~')) continue;
      const file = path.join(this.dir, name);
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES || now - st.mtimeMs < SETTLE_MS) continue;
      const id = crypto.createHash('sha256').update(`${name}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 32);
      next.set(id, { id, name, size: st.size, mtime: st.mtime.toISOString(), type, file, error: this.pdfErrors.get(`${name}\0${st.size}\0${st.mtimeMs}`) });
    }
    this.items = next;
    this.lastError = '';
    for (const [id, c] of this.claims) if (!next.has(id) || now - c.at > CLAIM_MS) this.claims.delete(id);
    return [...next.values()].sort((a, b) => a.mtime.localeCompare(b.mtime)).map(({ file: _f, ...it }) => ({ ...it, claimedBy: this.claims.get(it.id)?.user }));
  }

  get(id: string): (InboxItem & { file: string }) | undefined { return this.items.get(id); }

  /** 作業中の目印（同じ画像を2人が同時に登録するのを防ぐための表示用） */
  claim(id: string, user: string): string | undefined {
    const c = this.claims.get(id);
    if (c && c.user !== user && Date.now() - c.at < CLAIM_MS) return c.user;
    this.claims.set(id, { user, at: Date.now() });
    return undefined;
  }

  /** 取り込み済みフォルダへ移動 */
  /**
   * PDF をページごとの JPEG に分けて取り込み用フォルダに置き、元の PDF は取り込み済みへ移す。
   * 分割後のファイル名は決まった名前（<元の名前>-p01.jpg）で、既にあれば書かないので、途中で止まって再実行しても重複しない。
   */
  private async splitPdfs(names: string[]): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.pdf') || name.startsWith('.') || name.startsWith('~')) continue;
      const file = path.join(this.dir, name);
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      if (!st.isFile() || st.size > MAX_BYTES || now - st.mtimeMs < SETTLE_MS) continue;
      const key = `${name}\0${st.size}\0${st.mtimeMs}`;
      if (this.pdfErrors.has(key)) continue;
      try {
        const buf = await fs.readFile(file);
        if (!isPdf(buf)) throw new Error('PDF ファイルではありません。');
        const pages = extractJpegsFromPdf(buf);
        const base = path.basename(name, path.extname(name)).replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^[.~]+/, '').slice(0, 60) || 'scan';
        const old = new Date(now - SETTLE_MS * 2);
        for (let i = 0; i < pages.length; i++) {
          const out = path.join(this.dir, `${base}-p${String(i + 1).padStart(2, '0')}.jpg`);
          try { await fs.access(out); continue; } catch { /* 未作成 */ }
          const tmp = path.join(this.dir, `.tmp-${crypto.randomBytes(4).toString('hex')}.jpg`);
          await fs.writeFile(tmp, pages[i]!, { flag: 'wx' });
          await fs.utimes(tmp, old, old);
          await fs.rename(tmp, out);
        }
        await this.moveToDone({ name, file }, 'split');
        log('info', 'inbox pdf split', { pages: pages.length });
        changed = true;
      } catch (e) {
        this.pdfErrors.set(key, (e as Error).message);
        log('warn', 'inbox pdf not usable', { error: (e as Error).message });
      }
    }
    return changed;
  }

  /** ブラウザから取り込み用フォルダへファイルを追加（スマホのメモでスキャンした PDF など） */
  addFile(data: Buffer, ext: string, user: string): Promise<string> {
    return this.serial(async () => {
      try { await fs.access(this.dir); } catch {
        throw new StoreError('STORAGE_UNAVAILABLE', `取り込み用フォルダにアクセスできません: ${this.dir}`);
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      const name = `upload-${stamp}-${user}-${crypto.randomBytes(3).toString('hex')}${ext}`;
      const tmp = path.join(this.dir, `.tmp-${name}`);
      try {
        await fs.writeFile(tmp, data, { flag: 'wx' });
        const old = new Date(Date.now() - SETTLE_MS * 2);
        await fs.utimes(tmp, old, old);
        await fs.rename(tmp, path.join(this.dir, name));
      } catch (e) {
        await fs.unlink(tmp).catch(() => undefined);
        log('error', 'inbox add failed', { error: (e as Error).message });
        throw new StoreError('STORAGE_UNAVAILABLE', '取り込み用フォルダに保存できませんでした。接続を確認して再度お試しください。');
      }
      return name;
    });
  }

  private async moveToDone(it: { name: string; file: string }, reason: 'registered' | 'discarded' | 'split'): Promise<void> {
    await fs.mkdir(this.doneDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const safe = it.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-80);
    const tag = reason === 'registered' ? '' : `${reason}-`;
    const dest = path.join(this.doneDir, `${stamp}-${tag}${crypto.randomBytes(3).toString('hex')}-${safe}`);
    await fs.copyFile(it.file, dest, fs.constants.COPYFILE_EXCL);
    const now = new Date();
    await fs.utimes(dest, now, now); // 保持期間は「取り込んだ日」から数える（Windows のコピーは更新日時を引き継ぐため）
    const [a, b] = await Promise.all([fs.stat(it.file), fs.stat(dest)]);
    if (a.size !== b.size) { await fs.unlink(dest).catch(() => undefined); throw new Error('size mismatch'); }
    await fs.unlink(it.file);
  }

  /**
   * 取り込み済みフォルダへ移動する。strict のときは、全ファイルが残っていることを確認してから before（名刺の保存）を実行し、
   * 1つでも無ければ何もせず InboxGoneError（他の PC が先に取り込んだ等）。
   */
  completeWith<T>(ids: string[], reason: 'registered' | 'discarded', before: () => Promise<T>, strict = true): Promise<{ value: T; moved: number; failed: string[] }> {
    return this.serial(async () => {
      const targets: { id: string; it?: InboxItem & { file: string } }[] = [];
      for (const id of ids) {
        const it = this.items.get(id);
        let ok = !!it;
        if (it) { try { await fs.access(it.file); } catch { ok = false; } }
        if (!ok && strict) throw new InboxGoneError();
        targets.push({ id, it: ok ? it : undefined });
      }
      const value = await before();
      let moved = 0;
      const failed: string[] = [];
      for (const { id, it } of targets) {
        if (!it) { failed.push(id); continue; }
        try {
          await this.moveToDone(it, reason);
          this.items.delete(id);
          this.claims.delete(id);
          moved++;
        } catch (e) {
          log('error', 'inbox move failed', { id, error: (e as Error).message });
          failed.push(id);
        }
      }
      return { value, moved, failed };
    });
  }

  async complete(ids: string[], reason: 'registered' | 'discarded'): Promise<{ moved: number; failed: string[] }> {
    const { moved, failed } = await this.completeWith(ids, reason, async () => undefined, false);
    return { moved, failed };
  }

  /** 取り込み済みフォルダの古いファイルを削除（保持日数を過ぎたもの） */
  async purge(): Promise<number> {
    let n = 0;
    let names: string[] = [];
    try { names = await fs.readdir(this.doneDir); } catch { return 0; }
    for (const name of names) {
      const f = path.join(this.doneDir, name);
      try {
        const st = await fs.stat(f);
        if (st.isFile() && Date.now() - st.mtimeMs > this.retentionDays * 86400_000) { await fs.unlink(f); n++; }
      } catch { /* ignore */ }
    }
    return n;
  }
}
