import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 認証情報はアプリサーバーのローカル config ディレクトリに保存（共有フォルダ・Git・バックアップに含めない） */
interface AuthFile { algo: 'scrypt'; N: number; r: number; p: number; salt: string; hash: string }
interface Session { h: string; created: number; expires: number }

const SCRYPT = { N: 32768, r: 8, p: 1 };

function scrypt(pw: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return crypto.scryptSync(pw.normalize('NFC'), salt, 64, { N, r, p, maxmem: 128 * N * r * 2 });
}

export function writePassword(configDir: string, password: string): void {
  if (password.length < 10) throw new Error('パスワードは10文字以上にしてください。');
  const salt = crypto.randomBytes(16);
  const body: AuthFile = { algo: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p).toString('base64') };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(body), { mode: 0o600 });
  // パスワード変更時は既存セッションをすべて無効化
  fs.rmSync(path.join(configDir, 'sessions.json'), { force: true });
}

export class Auth {
  private sessions: Session[] = [];
  private fails = new Map<string, { n: number; until: number }>();
  private globalFails: number[] = [];
  private readonly authFile: string;
  private readonly sessFile: string;

  constructor(private configDir: string, private sessionDays: number) {
    this.authFile = path.join(configDir, 'auth.json');
    this.sessFile = path.join(configDir, 'sessions.json');
    try { this.sessions = JSON.parse(fs.readFileSync(this.sessFile, 'utf8')); } catch { this.sessions = []; }
    this.prune();
  }

  configured(): boolean { return fs.existsSync(this.authFile); }

  private persist(): void {
    const tmp = `${this.sessFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sessions), { mode: 0o600 });
    fs.renameSync(tmp, this.sessFile);
  }

  private prune(): void {
    const now = Date.now();
    this.sessions = this.sessions.filter((s) => s.expires > now);
  }

  private static hashToken(t: string): string { return crypto.createHash('sha256').update(t).digest('hex'); }

  /** ログイン試行。ロック中は 'locked' を返す */
  login(password: string, ip: string): { ok: true; token: string; maxAge: number } | { ok: false; locked: boolean } {
    const now = Date.now();
    const f = this.fails.get(ip);
    this.globalFails = this.globalFails.filter((t) => now - t < 15 * 60_000);
    if ((f && f.until > now) || this.globalFails.length >= 30) return { ok: false, locked: true };
    let ok = false;
    try {
      const a = JSON.parse(fs.readFileSync(this.authFile, 'utf8')) as AuthFile;
      const got = scrypt(password, Buffer.from(a.salt, 'base64'), a.N, a.r, a.p);
      const want = Buffer.from(a.hash, 'base64');
      ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    } catch { ok = false; }
    if (!ok) {
      const n = (f?.n ?? 0) + 1;
      this.fails.set(ip, { n, until: n >= 5 ? now + 5 * 60_000 * Math.min(6, n - 4) : 0 });
      this.globalFails.push(now);
      return { ok: false, locked: false };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = this.sessionDays * 86400;
    this.prune();
    this.sessions.push({ h: Auth.hashToken(token), created: now, expires: now + maxAge * 1000 });
    this.persist();
    return { ok: true, token, maxAge };
  }

  check(token: string | undefined): boolean {
    if (!token) return false;
    const h = Auth.hashToken(token);
    return this.sessions.some((s) => s.h === h && s.expires > Date.now());
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const h = Auth.hashToken(token);
    this.sessions = this.sessions.filter((s) => s.h !== h);
    this.persist();
  }
}
