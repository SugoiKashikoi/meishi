export const CATEGORIES = ['customer', 'prospect', 'supplier', 'partner', 'other'] as const;
export type Category = (typeof CATEGORIES)[number] | '';
export const CATEGORY_LABELS: Record<string, string> = {
  customer: '顧客', prospect: '見込み客', supplier: '仕入先', partner: '協力会社', other: 'その他', '': '',
};

export const TEXT_FIELDS = [
  'company', 'department', 'title', 'name', 'kana', 'phone', 'mobile', 'email',
  'postalCode', 'address', 'website', 'exchangeDate', 'place', 'event', 'memo',
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export interface CardFields extends Record<TextField, string> {
  category: Category;
  tags: string[];
  frontImage: string | null;
  backImage: string | null;
}

export interface Card extends CardFields {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 登録・最終更新した利用者ID */
  createdBy?: string;
  updatedBy?: string;
  /** AI登録の再実行用。フォームからは受け付けず、保存処理だけが付与する。 */
  aiSources?: { file: string; hash: string }[];
}

export const ID_RE = /^[0-9a-f]{32}$/;

export class ValidationError extends Error {}

const MAX_LEN: Partial<Record<TextField, number>> = { memo: 20000, address: 500 };

/** クライアントから来た値を検証・正規化する。未知のキーは捨てる。 */
export function parseCardFields(input: unknown): CardFields {
  if (!input || typeof input !== 'object') throw new ValidationError('入力が不正です。');
  const src = input as Record<string, unknown>;
  const out = {} as CardFields;
  for (const f of TEXT_FIELDS) {
    const v = src[f];
    if (v !== undefined && v !== null && typeof v !== 'string') throw new ValidationError(`${f} が不正です。`);
    const s = (v ?? '').replace(/\r\n?/g, '\n');
    const trimmed = f === 'memo' ? s.trim() : s.replace(/\s+/g, ' ').trim();
    if (trimmed.length > (MAX_LEN[f] ?? 300)) throw new ValidationError(`${f} が長すぎます。`);
    out[f] = trimmed;
  }
  if (out.exchangeDate && !/^\d{4}-\d{2}-\d{2}$/.test(out.exchangeDate)) throw new ValidationError('名刺交換日の形式が不正です。');
  const cat = src.category ?? '';
  if (cat !== '' && !(CATEGORIES as readonly unknown[]).includes(cat)) throw new ValidationError('分類が不正です。');
  out.category = cat as Category;
  const tags = src.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 50) throw new ValidationError('タグが不正です。');
  const seen = new Set<string>();
  out.tags = [];
  for (const t of tags) {
    if (typeof t !== 'string') throw new ValidationError('タグが不正です。');
    const s = t.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s.length > 50) throw new ValidationError('タグが長すぎます。');
    if (!seen.has(s)) { seen.add(s); out.tags.push(s); }
  }
  for (const k of ['frontImage', 'backImage'] as const) {
    const v = src[k] ?? null;
    if (v !== null && (typeof v !== 'string' || !ID_RE.test(v))) throw new ValidationError('画像の指定が不正です。');
    out[k] = v as string | null;
  }
  if (!out.company && !out.name) throw new ValidationError('会社名または氏名のどちらかを入力してください。');
  return out;
}

/** ディスクから読んだカードの構造を検証する（バックアップ検証でも使う） */
export function parseStoredCard(input: unknown): Card {
  if (!input || typeof input !== 'object') throw new ValidationError('カード形式が不正です。');
  const src = input as Record<string, unknown>;
  const fields = parseCardFields(src);
  if (typeof src.id !== 'string' || !ID_RE.test(src.id)) throw new ValidationError('ID が不正です。');
  if (!Number.isInteger(src.version) || (src.version as number) < 1) throw new ValidationError('version が不正です。');
  if (typeof src.createdAt !== 'string' || typeof src.updatedAt !== 'string') throw new ValidationError('日時が不正です。');
  const card: Card = { id: src.id, version: src.version as number, createdAt: src.createdAt, updatedAt: src.updatedAt, ...fields };
  for (const k of ['createdBy', 'updatedBy'] as const) {
    const v = src[k];
    if (v !== undefined) {
      if (typeof v !== 'string' || v.length > 64) throw new ValidationError('登録者が不正です。');
      card[k] = v;
    }
  }
  if (src.aiSources !== undefined) {
    if (!Array.isArray(src.aiSources) || src.aiSources.length < 1 || src.aiSources.length > 2
      || src.aiSources.some(s => !s || typeof s.file !== 'string' || s.file.length > 32768 || typeof s.hash !== 'string' || !/^[a-f0-9]{64}$/.test(s.hash))) {
      throw new ValidationError('AI登録元の記録が不正です。');
    }
    card.aiSources = src.aiSources.map(s => ({ file: s.file, hash: s.hash }));
  }
  return card;
}

/** 検索・重複判定用の正規化：全角半角統一、カタカナ→ひらがな、小文字化、空白除去 */
export function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　]+/g, '');
}

export function normPhone(s: string): string {
  return s.normalize('NFKC').replace(/[^0-9]/g, '');
}

export function normCompany(s: string): string {
  return norm(s).replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|inc\.?|co\.,?ltd\.?|corporation/g, '');
}

export function searchText(c: CardFields): string {
  return norm([
    c.company, c.department, c.title, c.name, c.kana, c.memo, c.tags.join(' '),
    c.event, c.place, c.email, c.address, c.phone, c.mobile, c.postalCode, c.website,
    normPhone(c.phone), normPhone(c.mobile), c.postalCode.replace(/[^0-9]/g, ''), CATEGORY_LABELS[c.category] ?? '',
  ].join('\u0001'));
}
