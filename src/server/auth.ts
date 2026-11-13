import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 利用者とセッションはアプリサーバーのローカル config ディレクトリに保存する
 * （共有フォルダ・Git・バックアップに含めない）。
 * 利用者の追加・削除・パスワード変更は CLI で users.json を書き換える。
 * サーバーは users.json の更新を検知し、削除された利用者やパスワード変更前のセッションを無効にする。
 */
export type Role = 'admin' | 'member';
export interface UserRecord {
  id: string; name: string; role: Role;
  N: number; r: number; p: number; salt: string; hash: string;
  passwordChangedAt: number;
}
export interface User { id: string; name: string; role: Role }
interface Session { h: string; user: string; created: number; expires: number }

export const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SCRYPT = { N: 32768, r: 8, p: 1 };

function scrypt(pw: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return crypto.scryptSync(pw.normalize('NFC'), salt, 64, { N, r, p, maxmem: 128 * N * r * 2 });
}

const usersFile = (dir: string) => path.join(dir, 'users.json');

export function readUsers(configDir: string): UserRecord[] {
  const f = usersFile(configDir);
  if (fs.existsSync(f)) return (JSON.parse(fs.readFileSync(f, 'utf8')) as { users: UserRecord[] }).users;
  // 旧形式（1人用 auth.json）からの移行：管理者 admin として扱う
  const legacy = path.join(configDir, 'auth.json');
  if (fs.existsSync(legacy)) {
    const a = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    return [{ id: 'admin', name: '管理者', role: 'admin', N: a.N, r: a.r, p: a.p, salt: a.salt, hash: a.hash, passwordChangedAt: 0 }];
  }
  return [];
}

function writeUsers(configDir: string, users: UserRecord[]): void {
  fs.mkdirSync(configDir, { recursive: true });
  const f = usersFile(configDir);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
  fs.rmSync(path.join(configDir, 'auth.json'), { force: true });
}

function hashPassword(password: string): Pick<UserRecord, 'N' | 'r' | 'p' | 'salt' | 'hash' | 'passwordChangedAt'> {
  if (password.length < 10) throw new Error('パスワードは10文字以上にしてください。');
  const salt = crypto.randomBytes(16);
  return { ...SCRYPT, salt: salt.toString('base64'), hash: scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p).toString('base64'), passwordChangedAt: Date.now() };
}

export function addUser(configDir: string, id: string, name: string, role: Role, password: string): void {
  if (!USER_ID_RE.test(id)) throw new Error('利用者IDは半角英小文字・数字・. _ - の32文字以内にしてください。');
  const users = readUsers(configDir);
  if (users.some((u) => u.id === id)) throw new Error(`利用者 ${id} は既に存在します。`);
  users.push({ id, name: name || id, role, ...hashPassword(password) });
  writeUsers(configDir, users);
}

export function setPassword(configDir: string, id: string, password: string): void {
  const users = readUsers(configDir);
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error(`利用者 ${id} が見つかりません。`);
  Object.assign(u, hashPassword(password));
  writeUsers(configDir, users);
}

export function removeUser(configDir: string, id: string): void {
  const users = readUsers(configDir);
  const rest = users.filter((u) => u.id !== id);
  if (rest.length === users.length) throw new Error(`利用者 ${id} が見つかりません。`);
  if (!rest.some((u) => u.role === 'admin')) throw new Error('管理者が1人もいなくなるため削除できません。');
  writeUsers(configDir, rest);
}

export class Auth {
  private sessions: Session[] = [];
  private users = new Map<string, UserRecord>();
  private usersMtime = -1;
  private fails = new Map<string, { n: number; until: number }>();
  private globalFails: number[] = [];
  private readonly sessFile: string;

  constructor(private configDir: string, private sessionDays: number) {
    this.sessFile = path.join(configDir, 'sessions.json');
    try { this.sessions = JSON.parse(fs.readFileSync(this.sessFile, 'utf8')); } catch { this.sessions = []; }
    this.sessions = this.sessions.filter((s) => typeof s.user === 'string');
    this.reloadUsers();
  }

  /** users.json が CLI で更新されていたら読み直す */
  private reloadUsers(): void {
    let m = 0;
    try { m = fs.statSync(usersFile(this.configDir)).mtimeMs; } catch { m = 0; }
    if (m === this.usersMtime && this.users.size) return;
    this.usersMtime = m;
    try { this.users = new Map(readUsers(this.configDir).map((u) => [u.id, u])); } catch { this.users = new Map(); }
  }

  configured(): boolean { this.reloadUsers(); return this.users.size > 0; }

  private persist(): void {
    const tmp = `${this.sessFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sessions), { mode: 0o600 });
    fs.renameSync(tmp, this.sessFile);
  }

  private static hashToken(t: string): string { return crypto.createHash('sha256').update(t).digest('hex'); }

  private failKey(k: string, now: number): boolean {
    const f = this.fails.get(k);
    return !!f && f.until > now;
  }
  private recordFail(k: string, now: number): void {
    const n = (this.fails.get(k)?.n ?? 0) + 1;
    this.fails.set(k, { n, until: n >= 5 ? now + 5 * 60_000 * Math.min(6, n - 4) : 0 });
  }

  /** ログイン。同一IP・同一利用者IDで5回失敗するとロック。全体でも15分30回まで */
  login(userId: string, password: string, ip: string): { ok: true; token: string; maxAge: number; user: User } | { ok: false; locked: boolean } {
    this.reloadUsers();
    const now = Date.now();
    const id = userId.trim().toLowerCase();
    const ipKey = `ip:${ip}`;
    const userKey = `user:${id}`;
    this.globalFails = this.globalFails.filter((t) => now - t < 15 * 60_000);
    if (this.failKey(ipKey, now) || this.failKey(userKey, now) || this.globalFails.length >= 30) return { ok: false, locked: true };
    const u = this.users.get(id);
    // 利用者が存在しない場合もダミー計算して応答時間を揃える
    const rec = u ?? { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: '' };
    const got = scrypt(password, Buffer.from(rec.salt, 'base64'), rec.N, rec.r, rec.p);
    const want = Buffer.from(rec.hash, 'base64');
    const ok = !!u && got.length === want.length && crypto.timingSafeEqual(got, want);
    if (!ok || !u) {
      this.recordFail(ipKey, now); this.recordFail(userKey, now); this.globalFails.push(now);
      return { ok: false, locked: false };
    }
    this.fails.delete(ipKey); this.fails.delete(userKey);
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = this.sessionDays * 86400;
    this.sessions = this.sessions.filter((s) => s.expires > now);
    this.sessions.push({ h: Auth.hashToken(token), user: u.id, created: now, expires: now + maxAge * 1000 });
    this.persist();
    return { ok: true, token, maxAge, user: { id: u.id, name: u.name, role: u.role } };
  }

  /** セッションを確認し、利用者を返す。削除された利用者・パスワード変更前のセッションは無効 */
  check(token: string | undefined): User | null {
    if (!token) return null;
    this.reloadUsers();
    const h = Auth.hashToken(token);
    const s = this.sessions.find((x) => x.h === h && x.expires > Date.now());
    if (!s) return null;
    const u = this.users.get(s.user);
    if (!u || s.created < u.passwordChangedAt) return null;
    return { id: u.id, name: u.name, role: u.role };
  }

  displayName(id: string): string { this.reloadUsers(); return this.users.get(id)?.name ?? id; }

  logout(token: string | undefined): void {
    if (!token) return;
    const h = Auth.hashToken(token);
    this.sessions = this.sessions.filter((s) => s.h !== h);
    this.persist();
  }
}
