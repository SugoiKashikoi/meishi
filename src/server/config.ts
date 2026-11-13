import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HttpsConfig {
  /** PFX(PKCS#12) ファイルのパス。社内CAが発行した証明書を想定 */
  pfxPath?: string;
  /** PFX のパスフレーズを読む環境変数名（値そのものは設定ファイルに書かない） */
  pfxPassphraseEnv?: string;
  certPath?: string;
  keyPath?: string;
}

export interface AppConfig {
  /** 名刺データ・画像の保存先（共有フォルダ）。Windows では UNC パス可 */
  dataDir: string;
  /** バックアップの保存先。既定は dataDir 内の backups */
  backupDir: string;
  host: string;
  port: number;
  https?: HttpsConfig;
  autoBackup: { intervalHours: number; keep: number };
  sessionDays: number;
  maxImageBytes: number;
  maxRestoreBytes: number;
  /** config.json / auth.json / sessions.json を置くローカルディレクトリ（共有フォルダに置かない） */
  configDir: string;
  /** 静的ファイル（public）の場所 */
  publicDir: string;
}

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function defaultConfigDir(): string {
  return process.env.MEISHI_CONFIG_DIR ? path.resolve(process.env.MEISHI_CONFIG_DIR) : path.join(APP_ROOT, 'config');
}

function isAbs(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p);
}

export function loadConfig(configDir = defaultConfigDir()): AppConfig {
  const file = path.join(configDir, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error(`設定ファイルがありません: ${file}\nconfig/config.sample.json をコピーして作成してください。`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<AppConfig>;
  return normalizeConfig(raw, configDir);
}

export function normalizeConfig(raw: Partial<AppConfig>, configDir: string): AppConfig {
  if (!raw.dataDir || typeof raw.dataDir !== 'string') throw new Error('config.json に dataDir（保存先）を設定してください。');
  if (!isAbs(raw.dataDir)) throw new Error('dataDir は絶対パス（例: \\\\fileserver\\share\\meishi）で指定してください。');
  const dataDir = path.resolve(raw.dataDir);
  const backupDir = raw.backupDir ? path.resolve(raw.backupDir) : path.join(dataDir, 'backups');
  const port = Number(raw.port ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port が不正です。');
  return {
    dataDir,
    backupDir,
    host: raw.host ?? '0.0.0.0',
    port,
    https: raw.https,
    autoBackup: {
      intervalHours: Math.max(1, Number(raw.autoBackup?.intervalHours ?? 24)),
      keep: Math.max(1, Number(raw.autoBackup?.keep ?? 14)),
    },
    sessionDays: Math.max(1, Number(raw.sessionDays ?? 30)),
    maxImageBytes: Number(raw.maxImageBytes ?? 8 * 1024 * 1024),
    maxRestoreBytes: Number(raw.maxRestoreBytes ?? 4 * 1024 * 1024 * 1024),
    configDir,
    publicDir: raw.publicDir ? path.resolve(raw.publicDir) : path.join(APP_ROOT, 'public'),
  };
}
