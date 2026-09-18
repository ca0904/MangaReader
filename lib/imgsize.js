'use strict';
// Pulls pixel dimensions out of an image header. Exact page heights are what let the
// reader virtualize without the scrollbar jumping as images load.

function jpeg(b) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xFF) { p++; continue; }
    const marker = b[p + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { w: b.readUInt16BE(p + 7), h: b.readUInt16BE(p + 5) };
    }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
    p += 2 + b.readUInt16BE(p + 2);
  }
  return null;
}

function webp(b) {
  const tag = b.toString('ascii', 12, 16);
  if (tag === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3FFF, h: b.readUInt16LE(28) & 0x3FFF };
  if (tag === 'VP8L') {
    const bits = b.readUInt32LE(22);
    return { w: (bits & 0x3FFF) + 1, h: ((bits >> 14) & 0x3FFF) + 1 };
  }
  if (tag === 'VP8X') {
    return {
      w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    };
  }
  return null;
}

function size(b) {
  if (b.length < 32) return null;
  if (b[0] === 0xFF && b[1] === 0xD8) return jpeg(b);
  if (b.readUInt32BE(0) === 0x89504E47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return webp(b);
  if (b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return null;
}

module.exports = { size };
