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

export const INBOX_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif',
};
const MAX_BYTES = 30 * 1024 * 1024;
/** 書き込み途中（複合機が保存中など）のファイルを避けるため、更新から一定時間経ったものだけ扱う */
const SETTLE_MS = 10_000;
const CLAIM_MS = 30 * 60_000;

export interface InboxItem { id: string; name: string; size: number; mtime: string; type: string; claimedBy?: string }

export class Inbox {
  private items = new Map<string, InboxItem & { file: string }>();
  private claims = new Map<string, { user: string; at: number }>();
  private chain: Promise<unknown> = Promise.resolve();
  lastError = '';

  constructor(readonly dir: string, readonly doneDir: string, private retentionDays: number) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async scan(): Promise<InboxItem[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      this.lastError = '取り込み用フォルダにアクセスできません。';
      throw new StoreError('STORAGE_UNAVAILABLE', `取り込み用フォルダにアクセスできません: ${this.dir}`);
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
      next.set(id, { id, name, size: st.size, mtime: st.mtime.toISOString(), type, file });
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
  complete(ids: string[], reason: 'registered' | 'discarded'): Promise<{ moved: number; failed: string[] }> {
    return this.serial(async () => {
      let moved = 0;
      const failed: string[] = [];
      for (const id of ids) {
        const it = this.items.get(id);
        if (!it) { failed.push(id); continue; }
        try {
          await fs.mkdir(this.doneDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
          const safe = it.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-80);
          const dest = path.join(this.doneDir, `${stamp}-${reason === 'discarded' ? 'discarded-' : ''}${crypto.randomBytes(3).toString('hex')}-${safe}`);
          await fs.copyFile(it.file, dest, fs.constants.COPYFILE_EXCL);
          const now = new Date();
          await fs.utimes(dest, now, now); // 保持期間は「取り込んだ日」から数える（Windows のコピーは更新日時を引き継ぐため）
          const [a, b] = await Promise.all([fs.stat(it.file), fs.stat(dest)]);
          if (a.size !== b.size) { await fs.unlink(dest).catch(() => undefined); throw new Error('size mismatch'); }
          await fs.unlink(it.file);
          this.items.delete(id);
          this.claims.delete(id);
          moved++;
        } catch (e) {
          log('error', 'inbox move failed', { id, error: (e as Error).message });
          failed.push(id);
        }
      }
      return { moved, failed };
    });
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
