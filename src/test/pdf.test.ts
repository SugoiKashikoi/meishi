import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJpegsFromPdf, jpegSize, PdfError } from '../server/pdf.js';
import { jpegWithSize, makePdf, jpegWithExif } from './helpers.js';

test('PDF から JPEG を取り出す（直接長さ・間接参照・Flate＋DCT）、小さい画像は除外', () => {
  const a = jpegWithSize(1200, 700);
  const b = jpegWithSize(700, 1200);
  const pdf = makePdf([{ data: a }, { data: b, indirectLength: true }, { data: jpegWithSize(800, 500), flate: true }, { data: jpegWithSize(40, 40) }]);
  const out = extractJpegsFromPdf(pdf);
  assert.equal(out.length, 3);
  assert.deepEqual(jpegSize(out[0]!), { w: 1200, h: 700 });
  assert.deepEqual(jpegSize(out[1]!), { w: 700, h: 1200 });
  assert.deepEqual(jpegSize(out[2]!), { w: 800, h: 500 });
});

test('取り出した画像からメタデータを除去・不正な PDF は明確なエラー', () => {
  const exif = jpegWithExif();
  const big = jpegWithSize(1000, 600);
  const withExif = Buffer.concat([big.subarray(0, 2), exif.subarray(2, exif.indexOf(Buffer.from([0xff, 0xdb]))), big.subarray(2)]);
  const out = extractJpegsFromPdf(makePdf([{ data: withExif }]));
  assert.ok(!out[0]!.includes(Buffer.from('GPS')));
  assert.throws(() => extractJpegsFromPdf(Buffer.from('not a pdf')), PdfError);
  assert.throws(() => extractJpegsFromPdf(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF')), PdfError);
  assert.throws(() => extractJpegsFromPdf(Buffer.from('%PDF-1.4\n1 0 obj << /Filter /Standard >> endobj\ntrailer << /Encrypt 1 0 R >>\n%%EOF')), /暗号化/);
});
