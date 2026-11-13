/**
 * PDF に埋め込まれた JPEG 画像（/DCTDecode）を取り出す。外部ライブラリは使わない。
 * iPhone「メモ」の「書類をスキャン」などのスキャン PDF は、各ページを JPEG 画像として持つため、
 * ページの描画（ラスタライズ）をせずに元の画像をそのまま取り出せる。
 * 対応外の形式（JPEG 以外で圧縮された画像、暗号化 PDF など）は取り出せない。
 */
import zlib from 'node:zlib';
import { sanitizeJpeg } from './jpeg.js';

export class PdfError extends Error {}

export function isPdf(b: Buffer): boolean {
  return b.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** JPEG の幅・高さ（SOF から） */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = b.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: b.readUInt16BE(pos + 5), w: b.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

const DICT_STREAM = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream\r?\n/g;

export function extractJpegsFromPdf(pdf: Buffer, opts: { max?: number; minSide?: number } = {}): Buffer[] {
  const max = opts.max ?? 50;
  const minSide = opts.minSide ?? 100;
  if (!isPdf(pdf)) throw new PdfError('PDF ファイルではありません。');
  const s = pdf.toString('latin1');
  if (/\/Encrypt\s/.test(s.slice(Math.max(0, s.length - 4096))) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) {
    throw new PdfError('パスワード付き（暗号化）の PDF は取り込めません。');
  }
  const out: Buffer[] = [];
  const re = new RegExp(DICT_STREAM.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && out.length < max) {
    const dict = m[1] ?? '';
    const start = m.index + m[0].length;
    // ストリームの長さ：直接値、または間接参照（N 0 R）を解決。分からなければ endstream を探す
    let len: number | undefined;
    const lm = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
    if (lm && lm[2] === undefined) len = Number(lm[1]);
    else if (lm) {
      const om = new RegExp(`(?:^|[^0-9])${lm[1]}\\s+${lm[2]}\\s+obj\\s*(\\d+)`).exec(s);
      if (om) len = Number(om[1]);
    }
    let end = len !== undefined && start + len <= pdf.length ? start + len : -1;
    if (end < 0) {
      end = s.indexOf('endstream', start);
      if (end < 0) break;
      while (end > start && (pdf[end - 1] === 0x0a || pdf[end - 1] === 0x0d)) end--;
    }
    re.lastIndex = end; // 画像データ（バイナリ）の中は探さない
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const filters: string[] = (/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '').match(/\/\w+/g) ?? [];
    const dct = filters.indexOf('/DCTDecode');
    if (dct < 0) continue;
    let data: Buffer = pdf.subarray(start, end);
    try {
      for (const f of filters.slice(0, dct)) {
        if (f === '/FlateDecode' || f === '/Fl') data = zlib.inflateSync(data, { maxOutputLength: 30 * 1024 * 1024 });
        else throw new Error('unsupported filter');
      }
      const clean = sanitizeJpeg(data);
      const size = jpegSize(clean);
      if (!size || Math.min(size.w, size.h) < minSide) continue; // サムネイル・マスク等は除外
      out.push(clean);
    } catch {
      continue;
    }
  }
  if (!out.length) throw new PdfError('この PDF から名刺画像を取り出せませんでした（スキャンした PDF のみ対応しています）。');
  return out;
}
