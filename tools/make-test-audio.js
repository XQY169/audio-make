#!/usr/bin/env node
/**
 * 生成一段正弦波 WAV，用于端到端冒烟测试（解码→裁剪→导出）。
 *   node tools/make-test-audio.js            # 默认 2s / 440Hz / 44.1kHz 单声道 → test/fixtures/sine.wav
 *   node tools/make-test-audio.js 3 220 stereo # 3s / 220Hz / 立体声
 */
const fs = require('fs');
const path = require('path');

const dur = Number(process.argv[2] || 2);     // 秒
const freq = Number(process.argv[3] || 440);  // Hz
const mode = process.argv[4] || 'mono';       // mono | stereo
const sr = 44100;
const ch = mode === 'stereo' ? 2 : 1;
const numFrames = Math.round(dur * sr);

const dataSize = numFrames * ch * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * ch * 2, 28);
buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);

for (let i = 0; i < numFrames; i++) {
  const t = i / sr;
  // 440Hz 正弦 + 轻微二次谐波，幅度 0.8
  const s = 0.8 * Math.sin(2 * Math.PI * freq * t) + 0.1 * Math.sin(2 * Math.PI * freq * 2 * t);
  const v = Math.max(-1, Math.min(1, s));
  const int = v < 0 ? v * 0x8000 : v * 0x7fff;
  for (let c = 0; c < ch; c++) {
    buf.writeInt16LE(int | 0, 44 + (i * ch + c) * 2);
  }
}

const outDir = path.resolve(__dirname, '..', 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'sine.wav');
fs.writeFileSync(out, buf);
console.log(`✓ ${out} (${buf.length} bytes, ${dur}s ${freq}Hz ${ch === 2 ? 'stereo' : 'mono'} ${sr}Hz)`);
