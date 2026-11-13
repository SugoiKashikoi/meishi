import { Card, CATEGORY_LABELS } from './card.js';

const COLUMNS: [string, (c: Card) => string, 'num'?][] = [
  ['ID', (c) => c.id],
  ['会社名', (c) => c.company],
  ['部署', (c) => c.department],
  ['役職', (c) => c.title],
  ['氏名', (c) => c.name],
  ['ふりがな', (c) => c.kana],
  ['電話番号', (c) => c.phone, 'num'],
  ['携帯番号', (c) => c.mobile, 'num'],
  ['メールアドレス', (c) => c.email],
  ['郵便番号', (c) => c.postalCode, 'num'],
  ['住所', (c) => c.address],
  ['Webサイト', (c) => c.website],
  ['名刺交換日', (c) => c.exchangeDate],
  ['会った場所', (c) => c.place],
  ['イベント名', (c) => c.event],
  ['分類', (c) => CATEGORY_LABELS[c.category] ?? ''],
  ['タグ', (c) => c.tags.join(' / ')],
  ['メモ', (c) => c.memo],
  ['画像(表)', (c) => (c.frontImage ? 'あり' : '')],
  ['画像(裏)', (c) => (c.backImage ? 'あり' : '')],
  ['登録日時', (c) => c.createdAt],
  ['更新日時', (c) => c.updatedAt],
];

/**
 * 1 セルを CSV 用に変換する。
 * - 数式として解釈され得る先頭文字（= + - @ タブ CR と全角形）は先頭に ' を付ける
 * - 電話番号・郵便番号で数字と記号だけの値は ="..." 形式にして先頭の 0 を保つ
 *   （中身を [0-9+\-() ] に限定しているので数式注入にはならない）
 */
export function cell(v: string, kind?: 'num'): string {
  let s = v;
  if (kind === 'num' && /^[0-9+\-() ]+$/.test(s) && /^0|^\+/.test(s)) {
    return `"=""${s}"""`;
  }
  if (/^[=+\-@\t\r＝＋－＠]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(cards: Card[]): Buffer {
  const lines = [COLUMNS.map(([h]) => cell(h)).join(',')];
  for (const c of cards) lines.push(COLUMNS.map(([, f, k]) => cell(f(c), k)).join(','));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}
