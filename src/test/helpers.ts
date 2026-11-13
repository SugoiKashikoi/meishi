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

