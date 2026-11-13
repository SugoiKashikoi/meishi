import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { createHandler } from './app.js';
import { log } from './log.js';
import { Inbox } from './inbox.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const auth = new Auth(config.configDir, config.sessionDays);
  if (!auth.configured()) throw new Error('利用者が未登録です。先に「node dist/server/cli.js user add <ID> --admin」を実行してください。');
  const store = new Store({ dataDir: config.dataDir, backupDir: config.backupDir });

  // 共有フォルダに接続できるまで起動を待つ（PC 起動直後はネットワークが未接続のことがある）。
  // 接続できない間は別の場所に保存せず、待機し続ける。
  for (let i = 0; ; i++) {
    try { await store.open(); break; } catch (e) {
      const msg = (e as Error).message;
      log('warn', 'storage not ready, retrying in 15s', { attempt: i + 1, error: msg });
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  const inbox = config.inboxDir ? new Inbox(config.inboxDir, config.inboxDoneDir, config.inboxRetentionDays) : undefined;
  if (inbox) await inbox.scan().catch(() => log('warn', 'inbox folder not accessible'));

  let server: http.Server;
  const h = config.https;
  if (h && (h.pfxPath || (h.certPath && h.keyPath))) {
    const opts: https.ServerOptions = h.pfxPath
      ? { pfx: fs.readFileSync(h.pfxPath), passphrase: h.pfxPassphraseEnv ? process.env[h.pfxPassphraseEnv] : undefined }
      : { cert: fs.readFileSync(h.certPath!), key: fs.readFileSync(h.keyPath!) };
    server = https.createServer(opts, createHandler({ config, store, auth, secure: true, inbox }));
  } else {
    server = http.createServer(createHandler({ config, store, auth, secure: false, inbox }));
  }
  server.requestTimeout = 30 * 60_000;
  server.listen(config.port, config.host, () => {
    log('info', 'server started', { host: config.host, port: config.port, https: server instanceof https.Server });
  });

  // 自動バックアップ（世代管理）と不要画像の掃除
  const backupJob = async () => {
    try {
      const last = (await store.listBackups()).find((b) => b.kind === 'auto');
      if (!last || Date.now() - Date.parse(last.createdAt) >= config.autoBackup.intervalHours * 3600_000 - 60_000) {
        await store.createBackup('auto');
        await store.pruneBackups(config.autoBackup.keep);
      }
      await store.gcImages();
      if (inbox) await inbox.purge();
    } catch (e) {
      log('error', 'scheduled job failed', { error: (e as Error).message });
    }
  };
  setTimeout(() => void backupJob(), 60_000).unref();
  setInterval(() => void backupJob(), 3600_000).unref();

  const stop = async (sig: string) => {
    log('info', 'shutting down', { sig });
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e) => {
  console.error(`起動できませんでした: ${(e as Error).message}`);
  process.exit(1);
});
