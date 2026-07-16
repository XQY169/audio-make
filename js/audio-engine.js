/**
 * 音频引擎 —— 解码 / 播放 / 离线渲染 / 编码（WAV & MP3）。
 * 单轨编排：片段按顺序拼接；数据模型已用 tracks 结构预留多轨扩展。
 *
 * 引擎只负责"音频操作"，不持有项目状态（片段列表由 app.js 持有并传入）。
 */
export { AudioEngine, totalDuration, clipDuration };

/** 单个片段可播放时长（秒）。 */
function clipDuration(clip) {
  return Math.max(0, clip.end - clip.start);
}

/** 编排总时长（秒）= 各片段时长之和。 */
function totalDuration(clips) {
  let s = 0;
  for (const c of clips) s += clipDuration(c);
  return s;
}

/**
 * 在给定 context 上为单个片段构建"源→增益(含淡变)→目标"链并调度。
 * @param ctx        AudioContext | OfflineAudioContext
 * @param destination 目标节点
 * @param clip        片段
 * @param arrStart    该片段在编排时间线上的起点（秒）
 * @param playFrom    本次播放的编排起点（秒），导出时传 0
 * @param now         调度的基准 context 时间（秒）
 * @returns {{src,g}} | null（片段完全在 playFrom 之前）
 */
function buildClipChain(ctx, destination, clip, arrStart, playFrom, now) {
  const dur = clipDuration(clip);
  if (dur <= 0) return null;
  const arrEnd = arrStart + dur;
  const overlapStart = Math.max(playFrom, arrStart);
  if (overlapStart >= arrEnd) return null; // 已过该片段

  const intoClip = overlapStart - arrStart;     // 进入片段的秒数
  const played = arrEnd - overlapStart;        // 本次播放该片段的秒数
  const when = now + Math.max(0, overlapStart - playFrom);
  const offset = clip.start + intoClip;

  const src = ctx.createBufferSource();
  src.buffer = clip.buffer;

  const g = ctx.createGain();
  const base = isFinite(clip.gain) && clip.gain >= 0 ? clip.gain : 1;
  const fadeIn = Math.max(0, Math.min(+clip.fadeIn || 0, dur));
  const fadeOut = Math.max(0, Math.min(+clip.fadeOut || 0, dur));

  // 起始值（若已进入淡入区，按比例）
  let v0 = base;
  if (fadeIn > 0 && intoClip < fadeIn) v0 = base * (intoClip / fadeIn);
  g.gain.setValueAtTime(Math.max(0.0001, v0), when);

  // 淡入斜坡
  if (fadeIn > 0 && intoClip < fadeIn) {
    g.gain.linearRampToValueAtTime(Math.max(0.0001, base), when + (fadeIn - intoClip));
  }

  // 淡出斜坡
  const foStartInto = dur - fadeOut; // 进入淡出的"片段内秒数"
  if (fadeOut > 0) {
    if (intoClip < foStartInto) {
      const foCtx = when + (foStartInto - intoClip);
      g.gain.setValueAtTime(Math.max(0.0001, base), foCtx);
      g.gain.linearRampToValueAtTime(0.0001, when + played);
    } else {
      const elapsed = intoClip - foStartInto;
      g.gain.setValueAtTime(Math.max(0.0001, base * (1 - elapsed / fadeOut)), when);
      g.gain.linearRampToValueAtTime(0.0001, when + played);
    }
  }

  src.connect(g).connect(destination);
  try { src.start(when, offset, played); } catch (e) { /* 已结束或参数越界，忽略 */ }
  return { src, g };
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.state = 'stopped';          // stopped | paused | playing | preview
    this.offset = 0;                  // 暂停/停止时的编排游标（秒）
    this.startedAt = 0;              // 起播时 context 时间
    this._total = 0;                 // 当前编排总时长
    this._active = [];               // 正在播放的 {src,g}
    this._endTimer = null;
    this._raf = null;
    this.onUpdate = null;            // 外部回调 (status) => void

    // 单段试听
    this._preview = null;            // { dur, startedAt } | null
    this._previewTimer = null;
  }

  async ensureCtx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : (window.AudioContext ? 44100 : 44100); }

  /** 解码文件为 AudioBuffer。 */
  async decodeFile(file) {
    await this.ensureCtx();
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      throw new Error('无法读取文件：' + file.name);
    }
    try {
      // 部分旧浏览器仅支持回调式
      if (this.ctx.decodeAudioData.length === 1) {
        return await this.ctx.decodeAudioData(buf);
      } else {
        return await new Promise((res, rej) =>
          this.ctx.decodeAudioData(buf, res, rej));
      }
    } catch (e) {
      throw new Error('解码失败（可能为不支持的格式）：' + file.name);
    }
  }

  // ---------------- 播放控制 ----------------
  _now() { return this.ctx ? this.ctx.currentTime : 0; }

  _currentArrPos() {
    if (this.state === 'playing') {
      return Math.min(this._total, this.offset + (this._now() - this.startedAt));
    }
    return this.offset; // paused / stopped
  }

  getStatus() {
    if (this.state === 'preview' && this._preview) {
      const pos = Math.min(this._preview.dur, this._now() - this._preview.startedAt);
      return { state: 'preview', pos, total: this._preview.dur, preview: true, origin: this._preview.originArr || 0 };
    }
    return { state: this.state, pos: this._currentArrPos(), total: this._total, preview: false };
  }

  async play(clips, fromSec) {
    await this.ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stopSources();
    this.stopPreview();

    this._total = totalDuration(clips);
    let start = fromSec == null ? this.offset : fromSec;
    if (start >= this._total - 0.001) start = 0;
    start = Math.max(0, start);
    this.offset = start;
    this.state = 'playing';
    this.startedAt = this._now();
    const now = this._now() + 0.03;

    let arrStart = 0;
    for (const clip of clips) {
      const chain = buildClipChain(this.ctx, this.master, clip, arrStart, start, now);
      if (chain) this._active.push(chain);
      arrStart += clipDuration(clip);
    }

    const remain = this._total - start;
    if (remain > 0) {
      this._endTimer = setTimeout(() => this._onNaturalEnd(), remain * 1000 + 60);
    } else {
      this._onNaturalEnd();
    }
    this._startTick();
    this._emit();
  }

  pause() {
    if (this.state !== 'playing') return;
    const pos = this._currentArrPos();
    this.stopSources();
    this.offset = pos;
    this.state = 'paused';
    this._emit();
  }

  stop() {
    this.stopSources();
    this.stopPreview();
    this.offset = 0;
    this.state = 'stopped';
    this._emit();
  }

  seek(clips, pos) {
    pos = Math.max(0, Math.min(totalDuration(clips), pos));
    this._total = totalDuration(clips);
    if (this.state === 'playing') {
      this.play(clips, pos);
    } else {
      this.offset = pos;
      this._emit();
    }
  }

  /** 单段试听：只播放该片段的裁剪区域。fromSrcSec 可指定从源内某秒开始。 */
  async previewClip(clip, fromSrcSec) {
    await this.ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stopSources();
    this.stopPreview();

    const dur = clipDuration(clip);
    if (dur <= 0) return;
    const originArr = fromSrcSec != null ? Math.max(0, Math.min(dur, fromSrcSec - clip.start)) : 0;
    const playDur = dur - originArr;
    if (playDur <= 0) return;
    const now = this._now() + 0.03;
    const chain = buildClipChain(this.ctx, this.master, clip, 0, originArr, now);
    if (chain) this._active.push(chain);

    this._preview = { dur: playDur, startedAt: now, originArr };
    this.state = 'preview';
    this._previewTimer = setTimeout(() => this._onPreviewEnd(), playDur * 1000 + 60);
    this._startTick();
    this._emit();
  }

  stopPreview() {
    if (this._previewTimer) { clearTimeout(this._previewTimer); this._previewTimer = null; }
    if (this.state === 'preview') {
      this.state = 'stopped';
      this.offset = 0;
      this._preview = null;
      this.stopSources();
      this._emit();
    } else {
      this._preview = null;
    }
  }

  _onNaturalEnd() {
    this.stopSources();
    this.offset = this._total;
    this.state = 'stopped';
    this._emit();
  }

  _onPreviewEnd() {
    this._previewTimer = null;
    this._preview = null;
    this.stopSources();
    this.state = 'stopped';
    this.offset = 0;
    this._emit();
  }

  stopSources() {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    for (const { src, g } of this._active) {
      try { src.onended = null; src.stop(); } catch (e) {}
      try { src.disconnect(); } catch (e) {}
      try { g.disconnect(); } catch (e) {}
    }
    this._active = [];
    this._stopTick();
  }

  // ---------------- 游标推送 ----------------
  _startTick() {
    if (this._raf) return;
    const tick = () => {
      this._raf = null;
      this._emit();
      if (this.state === 'playing' || this.state === 'preview') {
        this._raf = requestAnimationFrame(tick);
      }
    };
    this._raf = requestAnimationFrame(tick);
  }
  _stopTick() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
  _emit() {
    if (this.onUpdate) this.onUpdate(this.getStatus());
  }

  // ---------------- 离线渲染 ----------------
  /**
   * 渲染编排为 AudioBuffer。
   * @param clips 片段
   * @param {{sampleRate?:number}} opts
   */
  async renderBuffer(clips, opts = {}) {
    await this.ensureCtx();
    const total = totalDuration(clips);
    if (total <= 0) throw new Error('没有可导出的内容（请先添加并保留片段）');
    const sr = opts.sampleRate || this.ctx.sampleRate;
    const channels = Math.max(1, Math.min(2, clips.reduce((m, c) => Math.max(m, c.buffer.numberOfChannels), 1)));
    const length = Math.ceil(total * sr);
    const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(channels, length, sr);

    let arrStart = 0;
    for (const clip of clips) {
      buildClipChain(off, off.destination, clip, arrStart, 0, 0);
      arrStart += clipDuration(clip);
    }
    const rendered = await off.startRendering();
    return rendered;
  }

  /** 导出为 Blob。format: 'wav' | 'mp3' */
  async export(clips, { format = 'wav', sampleRate, bitrate = 192 } = {}) {
    const buf = await this.renderBuffer(clips, { sampleRate });
    if (format === 'mp3') {
      try {
        return { blob: await this.encodeMp3(buf, bitrate), ext: 'mp3', mime: 'audio/mpeg' };
      } catch (e) {
        // MP3 失败则回退 WAV
        return { blob: this.encodeWav(buf), ext: 'wav', mime: 'audio/wav', fallback: true, reason: e.message };
      }
    }
    return { blob: this.encodeWav(buf), ext: 'wav', mime: 'audio/wav' };
  }

  // ---------------- WAV 编码（16-bit PCM 交错） ----------------
  encodeWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);

    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(off, s | 0, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ---------------- MP3 编码（lamejs，懒加载） ----------------
  async encodeMp3(buffer, bitrate = 192) {
    const lamejs = await loadLamejs();
    const numCh = Math.min(2, buffer.numberOfChannels);
    const sr = buffer.sampleRate;
    const enc = new lamejs.Mp3Encoder(numCh, sr, bitrate);
    const blockSize = 1152;
    const left = floatTo16(buffer.getChannelData(0));
    const right = numCh > 1 ? floatTo16(buffer.getChannelData(1)) : left;
    const chunks = [];
    for (let i = 0; i < left.length; i += blockSize) {
      const l = left.subarray(i, i + blockSize);
      const r = right.subarray(i, i + blockSize);
      const mp3buf = numCh > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
      if (mp3buf.length) chunks.push(mp3buf);
    }
    const end = enc.flush();
    if (end.length) chunks.push(end);
    return new Blob(chunks, { type: 'audio/mpeg' });
  }
}

/** Float32 [-1,1] → Int16 PCM。 */
function floatTo16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
  }
  return out;
}

/** 懒加载 lamejs（经典脚本，注册全局 lamejs）。 */
let _lamePromise = null;
function loadLamejs() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (_lamePromise) return _lamePromise;
  _lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'lib/lame.min.js';
    s.onload = () => {
      if (window.lamejs && window.lamejs.Mp3Encoder) resolve(window.lamejs);
      else reject(new Error('lamejs 加载成功但缺少 Mp3Encoder'));
    };
    s.onerror = () => reject(new Error('无法加载 MP3 编码器'));
    document.head.appendChild(s);
  });
  return _lamePromise;
}
