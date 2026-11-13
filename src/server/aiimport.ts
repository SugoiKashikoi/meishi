/**
 * AI（Codex / Claude Code など、利用者の PC で動く AI）からの直接登録。
 *
 * AI は「AI専用フォーム」（下の AI_FORM_TEMPLATE と同じ形の JSON）を作り、
 * `node dist/server/cli.js ai-add` で保存データへ直接登録する。アプリの画面は通さないが、
 * 保存処理はアプリと同じ Store を使う（PC 間ロック・アトミック書き込み・入力検証・画像のメタデータ除去）。
 * AI が保存データのファイル（cards/*.json）を直接書き換えることはしない。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, StoreError } from './store.js';
import { Inbox, InboxGoneError } from './inbox.js';
import { CATEGORIES, CATEGORY_LABELS, parseCardFields, ValidationError } from './card.js';
import { extractJpegsFromPdf } from './pdf.js';

export const AI_TAG = 'AI入力';

/** AI専用フォーム（1枚の名刺 = 1オブジェクト。複数なら配列） */
export const AI_FORM_TEMPLATE = {
  company: '会社名（会社名か氏名のどちらかは必須）',
  department: '部署',
  title: '役職',
  name: '氏名（姓と名の間は半角スペース）',
  kana: 'ふりがな（ひらがな。名刺に無ければ空）',
  phone: '電話番号',
  mobile: '携帯番号',
  email: 'メールアドレス',
  postalCode: '郵便番号（123-4567）',
  address: '住所（郵便番号を除く）',
  website: 'Webサイト',
  exchangeDate: '名刺交換日（YYYY-MM-DD。分からなければ空）',
  place: '会った場所',
  event: 'イベント名',
  category: '分類（顧客／見込み客／仕入先／協力会社／その他、または空）',
  tags: ['タグ（任意）'],
  memo: 'メモ（話した内容など。名刺から読めない情報は書かない）',
  frontImageFile: '表面の画像ファイルのパス（JPEG または PDF。PDF なら1ページ目＝表、2ページ目＝裏）',
  frontCrop: { left: 0.1, top: 0.2, width: 0.8, height: 0.55 },
  frontRotate: 0,
  backImageFile: '裏面の画像ファイルのパス（任意）',
  backCrop: null,
  backRotate: 0,
};

export interface Crop { left: number; top: number; width: number; height: number }
/** 切り抜き・回転を行う関数（CLI では Electron の画像処理を呼ぶ） */
export type ImageTransform = (jobs: { data: Buffer; crop?: Crop; rotate?: number }[]) => Promise<Buffer[]>;

function parseCrop(v: unknown, label: string): Crop | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const c = v as Record<string, unknown>;
  const n = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : NaN);
  const crop = { left: n('left'), top: n('top'), width: n('width'), height: n('height') };
  const ok = Object.values(crop).every((x) => Number.isFinite(x)) && crop.left >= 0 && crop.top >= 0 && crop.width > 0.05 && crop.height > 0.05
    && crop.left + crop.width <= 1.0001 && crop.top + crop.height <= 1.0001;
  if (!ok) throw new ValidationError(`${label}の切り抜き範囲が不正です（left/top/width/height を 0〜1 の割合で、画像の内側に収まるように指定）。`);
  return crop;
}
function parseRotate(v: unknown, label: string): number | undefined {
  if (v === undefined || v === null || v === '' || v === 0) return undefined;
  if (![90, 180, 270].includes(v as number)) throw new ValidationError(`${label}の回転は 0・90・180・270 のいずれかにしてください（時計回り）。`);
  return v as number;
}

export interface AiImportResult {
  index: number;
  ok: boolean;
  id?: string;
  label?: string;
  error?: string;
  duplicates?: { id: string; company: string; name: string }[];
  movedFromInbox?: number;
  inboxMoveFailed?: string[];
}

const CAT_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(CATEGORY_LABELS).filter(([k]) => k).map(([k, v]) => [v, k]));

async function loadImages(file: string): Promise<Buffer[]> {
  const ext = path.extname(file).toLowerCase();
  const buf = await fs.readFile(file);
  if (ext === '.pdf') return extractJpegsFromPdf(buf, { max: 2 });
  if (ext === '.jpg' || ext === '.jpeg') return [buf];
  throw new ValidationError(`画像は JPEG か PDF にしてください: ${path.basename(file)}`);
}

export async function aiImport(
  store: Store,
  input: unknown,
  opts: { baseDir: string; user: string; inbox?: Inbox; dryRun?: boolean; transform?: ImageTransform; previewDir?: string },
): Promise<AiImportResult[]> {
  const entries = Array.isArray(input) ? input : [input];
  const results: AiImportResult[] = [];
  await store.refresh(true);
  // AIが選んだPDFの原本は、登録成功時まで分割・移動しない。接続失敗も隠さない。
  const inboxItems = opts.inbox ? await opts.inbox.scan({ splitPdfs: false }) : [];
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('フォームの形式が不正です（オブジェクトにしてください）。');
      const e = { ...(raw as Record<string, unknown>) };
      for (const [k, v] of Object.entries(e)) if (v === null) e[k] = '';
      if (typeof e.category === 'string' && !(CATEGORIES as readonly string[]).includes(e.category)) e.category = CAT_BY_LABEL[e.category] ?? '';
      const tags = Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string') : [];
      const fields = parseCardFields({ ...e, tags: [...tags, AI_TAG], frontImage: null, backImage: null });
      const label = `${fields.company} ${fields.name}`.trim();
      // 画像
      const files = (['frontImageFile', 'backImageFile'] as const)
        .map((k) => (typeof e[k] === 'string' && e[k] ? path.resolve(opts.baseDir, e[k] as string) : null));
      let imgs: Buffer[] = [];
      for (const f of files) if (f) imgs.push(...(await loadImages(f)));
      imgs = imgs.slice(0, 2);
      // 名刺部分だけの切り抜き・回転（1枚目＝表、2枚目＝裏）
      const edits = [
        { crop: parseCrop(e.frontCrop, '表面'), rotate: parseRotate(e.frontRotate, '表面') },
        { crop: parseCrop(e.backCrop, '裏面'), rotate: parseRotate(e.backRotate, '裏面') },
      ];
      if (imgs.some((_, n) => edits[n]!.crop || edits[n]!.rotate)) {
        if (!opts.transform) throw new ValidationError('切り抜き・回転を行う画像処理が使えません。');
        imgs = await opts.transform(imgs.map((data, n) => ({ data, crop: edits[n]!.crop, rotate: edits[n]!.rotate })));
      }
      if (opts.previewDir) {
        await fs.mkdir(opts.previewDir, { recursive: true });
        for (let n = 0; n < imgs.length; n++) await fs.writeFile(path.join(opts.previewDir, `${i + 1}-${n === 0 ? 'front' : 'back'}.jpg`), imgs[n]!);
      }
      const dups = store.duplicates(fields).map((c) => ({ id: c.id, company: c.company, name: c.name }));
      // 新着・巨大・置換済みの取り込み画像を一覧から除外されたまま登録しない。
      const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
      if (opts.inbox && files.some((f) => f && samePath(path.dirname(f), opts.inbox!.dir)
        && !inboxItems.some((it) => samePath(path.resolve(opts.inbox!.dir, it.name), f)))) {
        throw new ValidationError('取り込み用の画像が未確定・移動済み・対象外です。保存完了から10秒以上待ち、一覧とファイルを確認して再実行してください。');
      }
      if (opts.dryRun) { results.push({ index: i, ok: true, label, duplicates: dups }); continue; }
      const ids: string[] = [];
      for (const b of imgs) ids.push(await store.putImage(b));
      fields.frontImage = ids[0] ?? null;
      fields.backImage = ids[1] ?? null;
      // 取り込み用フォルダの画像なら、他の PC との二重登録を防いだうえで取り込み済みへ移動
      const inboxIds = opts.inbox
        ? inboxItems.filter((it) => files.some((f) => f && samePath(path.resolve(opts.inbox!.dir, it.name), f))).map((it) => it.id)
        : [];
      if (inboxIds.length && opts.inbox) {
        const r = await opts.inbox.completeWith(inboxIds, 'registered', () => store.create(fields, opts.user));
        results.push({ index: i, ok: true, id: r.value.id, label, duplicates: dups, movedFromInbox: r.moved, inboxMoveFailed: r.failed });
      } else {
        const c = await store.create(fields, opts.user);
        results.push({ index: i, ok: true, id: c.id, label, duplicates: dups });
      }
    } catch (err) {
      const msg = err instanceof ValidationError || err instanceof StoreError || err instanceof InboxGoneError ? err.message
        : (err as NodeJS.ErrnoException).code === 'ENOENT' ? `ファイルが見つかりません: ${(err as NodeJS.ErrnoException).path ?? ''}` : (err as Error).message;
      results.push({ index: i, ok: false, error: msg });
    }
  }
  return results;
}
