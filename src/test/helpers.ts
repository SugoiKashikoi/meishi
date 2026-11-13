import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.js';

process.env.MEISHI_QUIET = '1';
export const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
export function jpegWithExif(): Buffer {
  const payload = Buffer.from('Exif\0\0GPS-LATITUDE-35.6812-SECRET');
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([TINY_JPEG.subarray(0, 2), seg, TINY_JPEG.subarray(2)]);
}

export async function tempStore(): Promise<{ root: string; store: Store; dataDir: string; backupDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meishi-test-'));
  const dataDir = path.join(root, 'share', 'meishi');
  const backupDir = path.join(dataDir, 'backups');
  await fs.mkdir(path.join(root, 'share'));
  await Store.init(dataDir, backupDir, { dev: true });
  const store = new Store({ dataDir, backupDir });
  await store.open();
  return { root, store, dataDir, backupDir };
}


/** SOF の幅・高さだけを書き換えた JPEG（構造検証用。デコードはしない） */
export function jpegWithSize(w: number, h: number): Buffer {
  const b = Buffer.from(TINY_JPEG);
  const i = b.indexOf(Buffer.from([0xff, 0xc2]));
  b.writeUInt16BE(h, i + 5);
  b.writeUInt16BE(w, i + 7);
  return b;
}

/** 画像を埋め込んだ最小限の PDF を作る（1ページ1画像） */
export function makePdf(images: { data: Buffer; indirectLength?: boolean; flate?: boolean; w?: number; h?: number }[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let n = 3;
  const kids: string[] = [];
  const objs: Buffer[] = [];
  for (const im of images) {
    const page = n++, img = n++, len = n++;
    kids.push(`${page} 0 R`);
    let data = im.data;
    if (im.flate) data = zlibDeflate(data);
    const filter = im.flate ? '[/FlateDecode /DCTDecode]' : '/DCTDecode';
    const lenRef = im.indirectLength ? `${len} 0 R` : String(data.length);
    objs.push(Buffer.from(`${page} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /XObject << /Im${img} ${img} 0 R >> >> >>\nendobj\n`, 'latin1'));
    objs.push(Buffer.concat([
      Buffer.from(`${img} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.w ?? 400} /Height ${im.h ?? 300} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /DecodeParms << /K 0 >> /Length ${lenRef} >>\nstream\n`, 'latin1'),
      data, Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]));
    objs.push(Buffer.from(`${len} 0 obj\n${data.length}\nendobj\n`, 'latin1'));
  }
  parts.push(Buffer.from(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>\nendobj\n`, 'latin1'));
  parts.push(...objs, Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}
import zlib from 'node:zlib';
const zlibDeflate = (b: Buffer) => zlib.deflateSync(b);
