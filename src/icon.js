'use strict';
/**
 * Minimal dependency-free PNG encoder used to synthesise the tray / window icon.
 * A 4x4 supersampled circle with a DeepSeek-blue ring reads correctly at 16px.
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode straight RGBA bytes (width*height*4) as a PNG buffer. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Draw the app mark: a dark capsule-ball with a blue rim and a whale-tail notch.
 * @param {number} size edge length in pixels
 * @returns {Buffer} PNG bytes
 */
function makeIconPng(size = 256) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.5 - size * 0.03;
  const SS = 4; // supersampling grid
  const ringInner = radius * 0.70;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const d = Math.hypot(px - c - 0.5, py - c - 0.5);
          if (d > radius) continue;
          // vertical gradient body: #1a1a20 -> #08080a
          const t = py / size;
          let cr = mix(0x1a, 0x08, t);
          let cg = mix(0x1a, 0x08, t);
          let cb = mix(0x22, 0x0c, t);
          // DeepSeek blue rim
          if (d > ringInner) {
            const k = (d - ringInner) / (radius - ringInner);
            const w = Math.min(1, k * 1.35);
            cr = mix(cr, 0x4d, w);
            cg = mix(cg, 0x6b, w);
            cb = mix(cb, 0xfe, w);
          }
          // whale-tail notch on the right half
          const nx = (px - c - 0.5) / radius;
          const ny = (py - c - 0.5) / radius;
          if (nx > 0.05 && Math.abs(ny) < 0.30 && nx < 0.72 && Math.abs(ny) > 0.10 - nx * 0.12) {
            cr = mix(cr, 0x4d, 0.9); cg = mix(cg, 0x6b, 0.9); cb = mix(cb, 0xfe, 0.9);
          }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a > 0) {
        const hits = a / 255;
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(g / hits);
        rgba[i + 2] = Math.round(b / hits);
        rgba[i + 3] = Math.round((hits / n) * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}

module.exports = { makeIconPng, encodePng };
