// ログには名刺内容・連絡先・パスワード・検索語を出さない。呼び出し側は ID と件数程度だけを渡すこと。
import fs from 'node:fs';
import path from 'node:path';
const i = process.argv.indexOf('--log');
let logFile = i > 0 ? process.argv[i + 1] : undefined;
if (logFile) fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
/** ログの出力先ファイルを設定（デスクトップアプリでは %APPDATA%\MeishiKanri\logs） */
export function setLogFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  logFile = file;
}
type Level = 'info' | 'warn' | 'error';
export function log(level: Level, msg: string, meta?: Record<string, string | number | boolean | undefined>): void {
  if (process.env.MEISHI_QUIET === '1' && level === 'info') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ログ書き込み失敗で処理を止めない */ }
  } else {
    (level === 'error' ? console.error : console.log)(line);
  }
}
