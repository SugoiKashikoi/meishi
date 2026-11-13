// 開発・自動テスト専用：アプリと同じ処理を 127.0.0.1 だけで待ち受けてブラウザから確認する。
// 配布版（デスクトップアプリ）には含めず、利用者の PC では使わない。
//   node dist/server/devserver.js --data <保存先> [--inbox <取り込み用フォルダ>] [--port 18080] [--user taro]
import http from 'node:http';
import path from 'node:path';
import { createHandler } from './app.js';
import { Store } from './store.js';
import { Inbox } from './inbox.js';
import { APP_ROOT } from './config.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = path.resolve(opt('--data') ?? '');
const store = new Store({ dataDir, backupDir: path.join(dataDir, 'backups') });
await store.open();
const inboxDir = opt('--inbox');
const inbox = inboxDir ? new Inbox(path.resolve(inboxDir), path.join(dataDir, 'inbox-done'), 90, (fn) => store.withLock('inbox', fn)) : undefined;
const userId = opt('--user') ?? 'dev';
const handler = createHandler({ config: { publicDir: path.join(APP_ROOT, 'public'), maxImageBytes: 8 << 20, maxRestoreBytes: 1 << 30 }, store, inbox, user: { id: userId, name: userId } });
const port = Number(opt('--port') ?? 18080);
http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`dev server http://127.0.0.1:${port}/ (user=${userId})`));
