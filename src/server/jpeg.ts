/**
 * JPEG を検証し、APP1〜APP15（EXIF・GPS・XMP など）と COM セグメントを取り除く。
 * クライアントでも再エンコードで除去しているが、サーバー側でも必ず実施する。
 */
export function sanitizeJpeg(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new Error('JPEG 画像ではありません。');
  const parts: Buffer[] = [input.subarray(0, 2)];
  let pos = 2;
  let sawFrame = false;
  while (pos < input.length) {
    if (input[pos] !== 0xff) throw new Error('JPEG の構造が不正です。');
    let marker = input[pos + 1] ?? 0;
    while (marker === 0xff) { pos++; marker = input[pos + 1] ?? 0; }
    if (marker === 0xd9) { parts.push(input.subarray(pos, pos + 2)); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(input.subarray(pos, pos + 2)); pos += 2; continue; }
    const len = input.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > input.length) throw new Error('JPEG の構造が不正です。');
    const seg = input.subarray(pos, pos + 2 + len);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = seg.readUInt16BE(5);
      const w = seg.readUInt16BE(7);
      if (!w || !h || w > 12000 || h > 12000) throw new Error('画像サイズが不正です。');
      sawFrame = true;
    }
    const strip = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!strip) parts.push(seg);
    pos += 2 + len;
    if (marker === 0xda) {
      // スキャンデータ以降（EOI まで）はそのまま
      parts.push(input.subarray(pos));
      break;
    }
  }
  if (!sawFrame) throw new Error('JPEG の画像情報がありません。');
  return Buffer.concat(parts);
}
