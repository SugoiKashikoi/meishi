# AGENTS.md

- 社内専用の名刺管理アプリ。**外部サービス・CDN・外部フォント・解析への通信を追加しないこと**（CSP も `'self'` 限定）。
- サーバーは実行時依存ゼロ（Node.js 標準ライブラリのみ）を維持する。フロントは素の TypeScript（バンドラなし）。
- 保存先は共有フォルダ上のファイルストア（`src/server/store.ts`）。SQLite 等を共有フォルダに置かない。書き込みは `atomicWrite` 経由、更新は `exclusive` で直列化し version で楽観的排他。
- ログに名刺内容・連絡先・パスワード・検索語を出さない（`src/test/http.test.ts` で確認）。
- テストや検証に実在の名刺を使わない。ダミーデータは `init-store --dev` の保存先にのみ投入できる。
- 確認コマンド: `npm run typecheck` / `npm test` / `npm run build`
