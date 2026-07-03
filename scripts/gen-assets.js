'use strict';

// Generates the app icon + menu-bar tray icons with zero dependencies.
// A tiny PNG encoder (deflate + CRC) plus a supersampled vector renderer so the
// shapes come out anti-aliased. Run with `npm run assets`.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- minimal PNG encoder (8-bit RGBA) --------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolour + alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- supersampled vector renderer ------------------------------------------
// sceneFn(x, y) works in a normalized [0,1] space and returns { r, g, b, a }
// with a in [0,1]. We average 4x4 sub-samples per pixel for anti-aliasing.

function render(size, sceneFn) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (px + (sx + 0.5) / SS) / size;
          const ny = (py + (sy + 0.5) / SS) / size;
          const c = sceneFn(nx, ny);
          r += c.r * c.a;
          g += c.g * c.a;
          b += c.b * c.a;
          a += c.a;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (py * size + px) * 4;
      if (alpha > 0) {
        rgba[idx] = Math.round(r / n / alpha);
        rgba[idx + 1] = Math.round(g / n / alpha);
        rgba[idx + 2] = Math.round(b / n / alpha);
      }
      rgba[idx + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// --- geometry --------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function inRect(x, y, x0, x1, y0, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inRoundRect(x, y, x0, y0, x1, y1, rad) {
  const qx = Math.max(x0 + rad - x, 0, x - (x1 - rad));
  const qy = Math.max(y0 + rad - y, 0, y - (y1 - rad));
  return Math.hypot(qx, qy) <= rad;
}

function segDist(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// A pair of beamed eighth notes.
function inNote(x, y) {
  if (inEllipse(x, y, 0.36, 0.72, 0.115, 0.09)) return true; // left head
  if (inEllipse(x, y, 0.66, 0.64, 0.115, 0.09)) return true; // right head
  if (inRect(x, y, 0.455, 0.485, 0.3, 0.73)) return true; // left stem
  if (inRect(x, y, 0.755, 0.785, 0.22, 0.65)) return true; // right stem
  if (segDist(x, y, 0.47, 0.3, 0.77, 0.22) <= 0.05) return true; // beam
  return false;
}

// --- scenes ----------------------------------------------------------------

function iconScene(x, y) {
  if (!inRoundRect(x, y, 0, 0, 1, 1, 0.235)) return { r: 0, g: 0, b: 0, a: 0 };
  if (inNote(x, y)) return { r: 255, g: 255, b: 255, a: 1 };
  return {
    r: Math.round(lerp(255, 193, y)),
    g: Math.round(lerp(45, 18, y)),
    b: Math.round(lerp(45, 28, y)),
    a: 1,
  };
}

// Template image: black shape on transparent; macOS recolors it for the menubar.
function trayScene(x, y) {
  return inNote(x, y) ? { r: 0, g: 0, b: 0, a: 1 } : { r: 0, g: 0, b: 0, a: 0 };
}

// --- write -----------------------------------------------------------------

function write(file, size, scene) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(size, render(size, scene)));
  console.log(`  ${path.relative(process.cwd(), file)}  (${size}x${size})`);
}

const root = path.join(__dirname, '..');
console.log('Generating assets:');
write(path.join(root, 'build', 'icon.png'), 1024, iconScene);
write(path.join(root, 'assets', 'trayTemplate.png'), 16, trayScene);
write(path.join(root, 'assets', 'trayTemplate@2x.png'), 32, trayScene);
console.log('Done.');
