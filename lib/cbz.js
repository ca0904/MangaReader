'use strict';
// Minimal CBZ reader: ZIP central directory + per-entry inflate, no dependencies.
// Handles the two cases that occur in comic archives: stored (0) and deflate (8).
const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

function open(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66560);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no zip end-of-central-directory in ' + file);

    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOff = tail.readUInt32LE(eocd + 16);
    const cen = Buffer.alloc(cenSize);
    fs.readSync(fd, cen, 0, cenSize, cenOff);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cen.length; i++) {
      if (cen.readUInt32LE(p) !== CEN_SIG) break;
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      entries.push({
        name: cen.toString('utf8', p + 46, p + 46 + nameLen),
        method: cen.readUInt16LE(p + 10),
        compressedSize: cen.readUInt32LE(p + 20),
        localOffset: cen.readUInt32LE(p + 42)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { fd, file, entries };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

// Images only, in natural filename order (page2 before page10). Drops ComicInfo.xml,
// directory records and macOS resource-fork junk.
function pages(zip) {
  return zip.entries
    .filter(e => !e.name.endsWith('/') &&
                 !e.name.startsWith('__MACOSX/') &&
                 !e.name.split('/').pop().startsWith('.') &&
                 IMAGE_RE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

// maxBytes limits how much compressed data we pull; with Z_SYNC_FLUSH a truncated
// deflate stream still yields its prefix, which is all a header probe needs.
function read(zip, entry, maxBytes) {
  const head = Buffer.alloc(30);
  fs.readSync(zip.fd, head, 0, 30, entry.localOffset);
  const start = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const len = Math.min(entry.compressedSize, maxBytes || entry.compressedSize);
  const buf = Buffer.alloc(len);
  fs.readSync(zip.fd, buf, 0, len, start);
  if (entry.method === 0) return buf;
  if (entry.method !== 8) throw new Error('unsupported compression method ' + entry.method);
  return zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

function close(zip) { fs.closeSync(zip.fd); }

module.exports = { open, pages, read, close };
