// 最小限の ustar 形式の読み書き（外部ライブラリ不要。Windows 10 以降の tar.exe や 7-Zip でも展開可能）
import fs from 'node:fs/promises';

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number): Buffer {
  const b = Buffer.alloc(512, 0);
  if (Buffer.byteLength(name) > 100) throw new Error('tar entry name too long');
  b.write(name, 0, 100, 'utf8');
  b.write(octal(0o644, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124);
  b.write(octal(Math.floor(mtime / 1000), 12), 136);
  b.write('        ', 148);
  b.write('0', 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

export class TarWriter {
  private pos = 0;
  private constructor(private fh: fs.FileHandle) {}
  static async create(file: string): Promise<TarWriter> {
    return new TarWriter(await fs.open(file, 'wx'));
  }
  async add(name: string, data: Buffer): Promise<void> {
    await this.write(header(name, data.length, Date.now()));
    await this.write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) await this.write(Buffer.alloc(pad));
  }
  private async write(b: Buffer): Promise<void> {
    let offset = 0;
    while (offset < b.length) {
      const { bytesWritten } = await this.fh.write(b, offset, b.length - offset, this.pos + offset);
      if (!bytesWritten) throw new Error('tar の書き込みが進みませんでした。');
      offset += bytesWritten;
    }
    this.pos += b.length;
  }
  async finish(): Promise<void> {
    try {
      await this.write(Buffer.alloc(1024));
      await this.fh.sync();
    } finally {
      await this.fh.close();
    }
  }
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }
}

export interface TarEntry { name: string; size: number; offset: number }

export class TarReader {
  private constructor(private fh: fs.FileHandle, readonly entries: TarEntry[]) {}
  static async open(file: string, maxEntries = 200000): Promise<TarReader> {
    const fh = await fs.open(file, 'r');
    try {
      const { size: total } = await fh.stat();
      const entries: TarEntry[] = [];
      let pos = 0;
      const h = Buffer.alloc(512);
      while (pos + 512 <= total) {
        const { bytesRead } = await fh.read(h, 0, 512, pos);
        if (bytesRead < 512) throw new Error('tar が途中で切れています。');
        if (h.every((x) => x === 0)) break;
        const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
        const sizeStr = h.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
        const type = String.fromCharCode(h[156] ?? 0);
        if (!/^[0-7]+$/.test(sizeStr)) throw new Error('tar ヘッダーが不正です。');
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
        const stored = parseInt(h.subarray(148, 156).toString('ascii').replace(/[\0 ]/g, ''), 8);
        if (sum !== stored) throw new Error('tar ヘッダーのチェックサムが一致しません。');
        const size = parseInt(sizeStr, 8);
        if (pos + 512 + size > total) throw new Error('tar が途中で切れています。');
        if (type === '0' || type === '\0') {
          entries.push({ name: prefix ? `${prefix}/${name}` : name, size, offset: pos + 512 });
          if (entries.length > maxEntries) throw new Error('ファイル数が多すぎます。');
        } else if (type !== '5') {
          throw new Error('想定外の種類のファイルが含まれています。');
        }
        pos += 512 + Math.ceil(size / 512) * 512;
      }
      return new TarReader(fh, entries);
    } catch (e) {
      await fh.close();
      throw e;
    }
  }
  async read(e: TarEntry): Promise<Buffer> {
    const b = Buffer.alloc(e.size);
    let offset = 0;
    while (offset < e.size) {
      const { bytesRead } = await this.fh.read(b, offset, e.size - offset, e.offset + offset);
      if (!bytesRead) throw new Error('tar の読み込みに失敗しました。');
      offset += bytesRead;
    }
    return b;
  }
  async close(): Promise<void> {
    await this.fh.close();
  }
}
