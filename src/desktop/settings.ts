import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../server/store.js';

/** この PC・この利用者だけの設定（%APPDATA%\名刺管理\settings.json）。共有フォルダには置かない */
export interface Settings { dataDir?: string; backupDir?: string; inboxDir?: string; displayName?: string }

/**
 * 全 PC 共通の既定値。管理者が exe と同じフォルダに meishi-config.json を置くと、
 * 初回起動時の保存先などがあらかじめ入った状態になる（各 PC での入力を省ける）。
 */
export interface SharedDefaults {
  dataDir?: string; backupDir?: string; inboxDir?: string; inboxRetentionDays?: number;
  autoBackup?: { intervalHours: number; keep: number };
}

export function loadDefaults(candidates: string[]): SharedDefaults {
  for (const f of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) as SharedDefaults;
      const ab = raw.autoBackup;
      return {
        dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : undefined,
        backupDir: typeof raw.backupDir === 'string' ? raw.backupDir : undefined,
        inboxDir: typeof raw.inboxDir === 'string' ? raw.inboxDir : undefined,
        inboxRetentionDays: Math.max(1, Number(raw.inboxRetentionDays ?? 90)),
        autoBackup: { intervalHours: Math.max(1, Number(ab?.intervalHours ?? 24)), keep: Math.max(1, Number(ab?.keep ?? 14)) },
      };
    } catch { /* 次の候補 */ }
  }
  return { inboxRetentionDays: 90, autoBackup: { intervalHours: 24, keep: 14 } };
}

export function loadSettings(file: string, defaults: SharedDefaults): Settings {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings; } catch {
    return { dataDir: defaults.dataDir, inboxDir: defaults.inboxDir };
  }
}

export function saveSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * 利用者の表示名（共有フォルダの users/<WindowsユーザーID>.json）。
 * 各 PC は自分のファイルだけを書くので、PC 間で書き込みが衝突しない。
 */
export class Directory {
  private names = new Map<string, string>();
  private loadedAt = 0;
  constructor(private dataDir: string) {}

  async register(id: string, name: string): Promise<void> {
    const dir = path.join(this.dataDir, 'users');
    await fsp.mkdir(dir, { recursive: true });
    await atomicWrite(dir, `${id}.json`, Buffer.from(JSON.stringify({ id, name, updatedAt: new Date().toISOString() })));
    this.names.set(id, name);
  }

  /** 共有フォルダの users/ を読み込む（起動時は await、以降は1分ごとに裏で更新） */
  async load(): Promise<void> {
    this.loadedAt = Date.now();
    try {
      const dir = path.join(this.dataDir, 'users');
      for (const f of await fsp.readdir(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const u = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          if (typeof u.id === 'string' && typeof u.name === 'string') this.names.set(u.id, u.name.slice(0, 40));
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private reload(): void {
    if (Date.now() - this.loadedAt >= 60_000) void this.load();
  }

  name(id: string): string { this.reload(); return this.names.get(id) ?? id; }
}
