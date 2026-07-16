#!/usr/bin/env node
/**
 * 生成 PWA 图标（192 / 512，含 maskable 安全区）。
 * 零依赖：用 Node 内置 zlib 手写极简 PNG 编码器，绘制渐变底 + 居中均衡器条。
 *
 *   node tools/make-icons.js
 *
 * 产物写入 icons/icon-192.png 与 icons/icon-512.png。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- 极简 PNG 编码器（RGBA, 8-bit） ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowSize = width * 4;
  const raw = Buffer.alloc((rowSize + 1) * height);
  for (let y = 0; y < height; y++) {
    const ro = y * (rowSize + 1);
    raw[ro] = 0; // filter: none
    rgba.copy(raw, ro + 1, y * rowSize, y * rowSize + rowSize);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制 ----------
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function drawIcon(size) {
  const w = size, h = size;
  const rgba = Buffer.alloc(w * h * 4);
  const c1 = [79, 70, 229];   // indigo-600
  const c2 = [6, 182, 212];   // cyan-500
  const c3 = [168, 85, 247];  // purple-500（点缀，让渐变更丰富）

  // 对角渐变底（全出血，maskable 友好）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      let r, g, b;
      if (t < 0.5) {
        const k = t / 0.5;
        r = lerp(c1[0], c3[0], k);
        g = lerp(c1[1], c3[1], k);
        b = lerp(c1[2], c3[2], k);
      } else {
        const k = (t - 0.5) / 0.5;
        r = lerp(c3[0], c2[0], k);
        g = lerp(c3[1], c2[1], k);
        b = lerp(c3[2], c2[2], k);
      }
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }

  // 居中均衡器条（限制在 maskable 安全区 ≈ 半径 0.4*size 内）
  const bars = [0.5, 0.85, 1.0, 0.85, 0.5];
  const n = bars.length;
  const barW = Math.round(w * 0.075);
  const gap = Math.round(w * 0.05);
  const totalW = n * barW + (n - 1) * gap;
  const startX = Math.round((w - totalW) / 2);
  const centerY = Math.round(h / 2);
  const maxBarH = Math.round(h * 0.3); // ≤ 0.4*h，安全区内
  const fill = [245, 247, 255];

  function fillRect(x0, y0, x1, y1) {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = (y * w + x) * 4;
        rgba[i] = fill[0];
        rgba[i + 1] = fill[1];
        rgba[i + 2] = fill[2];
        rgba[i + 3] = 255;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const bh = Math.round(bars[i] * maxBarH);
    const x0 = startX + i * (barW + gap);
    // 圆角顶/底（在较大尺寸上轻微圆角，提升质感）
    const r = Math.max(2, Math.round(barW * 0.3));
    const x1 = x0 + barW;
    const yTop = centerY - bh;
    const yBot = centerY + bh;
    fillRect(x0, yTop + r, x1, yBot - r);
    fillRect(x0 + r, yTop, x1 - r, yBot);
  }

  return encodePng(w, h, rgba);
}

function main() {
  const outDir = path.resolve(__dirname, '..', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [192, 512]) {
    const buf = drawIcon(size);
    const file = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(file, buf);
    // 校验签名
    const sig = buf.subarray(0, 8);
    const ok = sig[0] === 137 && sig[1] === 80 && sig[2] === 78 && sig[3] === 71;
    if (!ok) throw new Error(`PNG 签名校验失败：${file}`);
    console.log(`✓ ${file} (${buf.length} bytes, ${size}×${size})`);
  }
}

main();
