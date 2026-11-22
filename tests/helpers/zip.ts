import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * A zip read back as anything that opens one reads it: from the directory
 * at its end, each file found by where that says it is and inflated.
 */
export function readZip(file: string): Map<string, Buffer> {
  const zip = readFileSync(file);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`${file} has no zip directory`);
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i -= 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}: not a directory record at ${at}`);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(at + 42);
    const body = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(body, body + packed);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}
