/**
 * 端到端冒烟测试（headless Chrome）：
 *  1. 加载页面，捕获 console 错误与未处理异常；
 *  2. 截图空状态；
 *  3. 页面内导入音频引擎，跑：解码测试 WAV → 裁剪 → 离线渲染 → 校验 WAV/MP3 产物。
 *
 *   node test/smoke.mjs [port]
 * 前置：node server.js <port> 已启动；已安装 puppeteer-core。
 */
import puppeteer from 'puppeteer-core';

const PORT = process.argv[2] || 8090;
const URL = `http://localhost:${PORT}/`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const errors = [];
let exitCode = 0;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 820, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => {
    const u = r.url();
    // 忽略 service worker 在 http 下注册失败之类的非致命请求
    if (!u.includes('sw.js')) errors.push('requestfailed: ' + u + ' ' + (r.failure()?.errorText || ''));
  });

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));

  // 空状态存在
  const hasEmpty = await page.$('.empty-card, .empty .empty-card');
  console.log('空状态渲染：', hasEmpty ? 'OK' : '缺失');
  await page.screenshot({ path: '/tmp/smoke-empty.png' });
  console.log('截图：/tmp/smoke-empty.png');

  // 打开关于对话框，验证无报错
  await page.click('#aboutBtn').catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  await page.keyboard.press('Escape').catch(() => {});
  // 点掉对话框（点"知道了"）
  await page.evaluate(() => {
    const b = document.querySelector('.overlay [data-act="ok"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 150));

  // 引擎端到端
  const result = await page.evaluate(async () => {
    const { AudioEngine, totalDuration, clipDuration } = await import('/js/audio-engine.js');
    const eng = new AudioEngine();
    // 拉取测试 WAV
    const ab = await (await fetch('/test/fixtures/sine.wav')).arrayBuffer();
    const file = new File([ab], 'sine.wav', { type: 'audio/wav' });
    const buf = await eng.decodeFile(file);
    const clip = { buffer: buf, start: 0.5, end: 1.5, gain: 1.2, fadeIn: 0.05, fadeOut: 0.1, name: 'x' };
    const dur = clipDuration(clip);
    const rendered = await eng.renderBuffer([clip], {});
    const wavBlob = eng.encodeWav(rendered);
    const wav = await wavBlob.arrayBuffer();
    const v = new DataView(wav);
    const riff = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
    const wave = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11));
    const numCh = v.getUint16(22, true);
    const sr = v.getUint32(24, true);
    const dataSize = v.getUint32(40, true);
    const wavDur = dataSize / (numCh * 2) / sr;

    // MP3
    let mp3 = null, mp3Err = null;
    try {
      const mp3Blob = await eng.encodeMp3(rendered, 192);
      const mb = await mp3Blob.arrayBuffer();
      const u = new Uint8Array(mb);
      mp3 = { size: mb.byteLength, head: [u[0], u[1]] };
    } catch (e) { mp3Err = e.message; }

    return {
      decodedDur: +buf.duration.toFixed(3),
      trimDur: +dur.toFixed(3),
      renderedLen: rendered.length,
      renderedCh: rendered.numberOfChannels,
      wav: { size: wav.byteLength, riff, wave, numCh, sr, dataSize, dur: +wavDur.toFixed(3) },
      mp3, mp3Err,
    };
  });

  console.log('引擎结果：', JSON.stringify(result, null, 2));

  const r = result;
  function check(cond, msg) {
    console.log((cond ? '✓' : '✗') + ' ' + msg);
    if (!cond) exitCode = 1;
  }
  check(Math.abs(r.decodedDur - 2) < 0.05, `解码时长≈2s（得 ${r.decodedDur}s）`);
  check(Math.abs(r.trimDur - 1) < 0.05, `裁剪后时长≈1s（得 ${r.trimDur}s）`);
  check(Math.abs(r.renderedLen / r.wav.sr - 1) < 200, `渲染长度≈1s（得 ${r.renderedLen} @${r.wav.sr}Hz）`);
  check(r.wav.riff === 'RIFF' && r.wav.wave === 'WAVE', 'WAV 头 RIFF/WAVE');
  check(r.wav.numCh === 1 && (r.wav.sr === 44100 || r.wav.sr === 48000), `WAV 单声道 常规采样率（得 ${r.wav.numCh}ch ${r.wav.sr}Hz）`);
  check(Math.abs(r.wav.dur - 1) < 0.05, `WAV 时长≈1s（得 ${r.wav.dur}s）`);
  check(!!r.mp3 && r.mp3.size > 100, `MP3 产物非空（${r.mp3 ? r.mp3.size + 'B' : '失败'}）`);
  check(!!r.mp3 && r.mp3.head[0] === 0xff, `MP3 帧同步 0xFF（得 0x${r.mp3 ? r.mp3.head[0].toString(16) : '-'}）`);
  if (r.mp3Err) console.log('  MP3 错误：' + r.mp3Err);
} catch (e) {
  console.error('测试异常：', e);
  exitCode = 1;
} finally {
  await browser.close();
}

if (errors.length) {
  console.log('\n页面错误(' + errors.length + ')：');
  errors.forEach((e) => console.log('  ' + e));
  exitCode = 1;
} else {
  console.log('\n无 console/page 错误。');
}

console.log(exitCode === 0 ? '\n✅ 冒烟测试通过' : '\n❌ 冒烟测试失败');
process.exit(exitCode);
