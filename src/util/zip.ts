import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { YanError } from './error.js';

/**
 * A zip archive written with what Node has, so `yan pack` needs no `zip` on
 * the machine, which Windows has none of: each file deflated, or stored
 * when deflating gains nothing, names in UTF-8 with forward slashes. No
 * zip64, so a file or an archive of 4 GB or more, or more than 65535
 * files, is refused rather than written wrong.
 */

export interface ZipEntry {
  /** The name in the archive, forward slashes, no leading one. */
  readonly name: string;
  /** The file on disk it is read from, or what it holds. */
  readonly from: string | Buffer;
}

const LIMIT = 0xffffffff;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib has a crc32 of its own only from Node 20.15, past what yan asks for. */
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A time as zip keeps it, local and to two seconds: the time and the date, 16 bits each. */
function dosTime(d: Date): [number, number] {
  const year = Math.max(1980, d.getFullYear());
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

/**
 * Write `entries` to the zip at `file`, in the order given, replacing one
 * already there only once the new one is whole.
 *
 * @returns how many bytes the archive is.
 * @throws YanError `zip_too_large` past what a zip without zip64 holds.
 */
export function writeZip(file: string, entries: readonly ZipEntry[], at: Date = new Date()): number {
  if (entries.length > 0xffff) throw new YanError('zip_too_large', `${entries.length} files are more than a zip holds (65535)`);
  const [time, date] = dosTime(at);
  const partial = `${file}.part`;
  const fd = openSync(partial, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  const put = (chunk: Buffer): void => {
    writeSync(fd, chunk);
    offset += chunk.length;
  };
  try {
    for (const entry of entries) {
      const raw = typeof entry.from === 'string' ? readFileSync(entry.from) : entry.from;
      const deflated = deflateRawSync(raw);
      const stored = deflated.length >= raw.length;
      const body = stored ? raw : deflated;
      const name = Buffer.from(entry.name, 'utf8');
      if (raw.length >= LIMIT || offset + body.length >= LIMIT) throw new YanError('zip_too_large', `${entry.name} takes the archive past 4 GB, more than a zip holds`);

      // What the local header and the central directory say alike: version 2.0, names in UTF-8 (bit 11), the method, when, the checksum and the sizes.
      const common = Buffer.alloc(26);
      common.writeUInt16LE(20, 0);
      common.writeUInt16LE(0x0800, 2);
      common.writeUInt16LE(stored ? 0 : 8, 4);
      common.writeUInt16LE(time, 6);
      common.writeUInt16LE(date, 8);
      common.writeUInt32LE(crc32(raw), 10);
      common.writeUInt32LE(body.length, 14);
      common.writeUInt32LE(raw.length, 18);
      common.writeUInt16LE(name.length, 22);
      common.writeUInt16LE(0, 24);

      // The central directory's record: made on "unix" (3), so the mode is read, a plain file's, rw-r--r--, and where its local header is.
      const head = Buffer.alloc(6);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE((3 << 8) | 20, 4);
      const tail = Buffer.alloc(14);
      tail.writeUInt32LE((0o100644 << 16) >>> 0, 6);
      tail.writeUInt32LE(offset, 10);
      central.push(Buffer.concat([head, common, tail, name]));

      const local = Buffer.alloc(4);
      local.writeUInt32LE(0x04034b50, 0);
      put(Buffer.concat([local, common, name]));
      put(body);
    }
    const start = offset;
    for (const record of central) put(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    put(end);
  } catch (err) {
    closeSync(fd);
    rmSync(partial, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(partial, file);
  return offset;
}
