import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Private file storage seam. Swap for S3/GCS later without touching routes. */
export interface FileStorage {
  put(data: Buffer): Promise<string>; // returns an opaque, unguessable key
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[a-f0-9]{48}$/;

/** Stores files outside any web root, named only by a random key (no extension, no user input). */
export class LocalDiskStorage implements FileStorage {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('Invalid storage key'); // blocks path traversal
    return join(this.dir, key);
  }
  async put(data: Buffer): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const key = randomBytes(24).toString('hex');
    await writeFile(this.path(key), data, { mode: 0o600 });
    return key;
  }
  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

/** Detects the real type from magic bytes; the client-supplied content type is never trusted. */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
