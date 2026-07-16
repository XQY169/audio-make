/**
 * 波形模块 —— 峰值计算与缓存、绘制、编辑器交互（裁剪手柄 / 分割标记 / 拖动定位）。
 * 用 Pointer Events 统一鼠标与触摸。
 */
export { computePeaks, drawThumbnail, WaveformEditor };

const BIN_COUNT = 2400; // 全源峰值分辨率（足够覆盖缩略图与编辑器）

/** 计算全源峰值（min/max，按 BIN_COUNT 分箱），按 buffer 缓存。 */
const _peakCache = new WeakMap();
function computePeaks(buffer, bins = BIN_COUNT) {
  const cached = _peakCache.get(buffer);
  if (cached && cached.bins === bins) return cached;
  const data = buffer.getChannelData(0);
  const n = data.length;
  const per = Math.max(1, Math.floor(n / bins));
  const mins = new Float32Array(bins);
  const maxs = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let mn = Infinity, mx = -Infinity;
    const s = b * per;
    const e = Math.min(n, s + per);
    for (let i = s; i < e; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    mins[b] = Number.isFinite(mn) ? mn : 0;
    maxs[b] = Number.isFinite(mx) ? mx : 0;
  }
  const peaks = { mins, maxs, bins, duration: buffer.duration, length: n };
  _peakCache.set(buffer, peaks);
  return peaks;
}

/** 用峰值在 [srcStart, srcEnd] 区间绘制竖条波形。 */
function paintBars(ctx, peaks, { x, y, w, h, srcStart, srcEnd, color, midColor }) {
  const dur = peaks.duration || 1;
  const s0 = Math.max(0, srcStart) / dur;
  const s1 = Math.min(1, srcEnd) / dur;
  const mid = y + h / 2;
  const half = h / 2;
  ctx.fillStyle = color;
  const step = Math.max(1, Math.floor(w / 240)); // 采样间隔，避免每像素一条
  for (let px = 0; px < w; px += step) {
    const t = s0 + (s1 - s0) * (px / w);
    const bin = Math.min(peaks.bins - 1, Math.floor(t * peaks.bins));
    const mn = peaks.mins[bin];
    const mx = peaks.maxs[bin];
    const top = mid - Math.max(Math.abs(mn), Math.abs(mx)) * half;
    const bot = mid + Math.max(Math.abs(mn), Math.abs(mx)) * half;
    ctx.fillRect(x + px, top, step, Math.max(1, bot - top));
  }
}

/** 绘制片段缩略图（仅显示裁剪区域）。 */
function drawThumbnail(canvas, clip) {
  if (!clip || !clip.buffer) return;
  const peaks = computePeaks(clip.buffer);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  paintBars(ctx, peaks, { x: 0, y: 4, w, h: h - 8, srcStart: clip.start, srcEnd: clip.end, color: clip.color || '#6366f1' });
}

/** DPR 适配并返回 2d 上下文与逻辑尺寸。 */
function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * 大波形编辑器：显示全源波形 + 裁剪手柄 + 分割标记 + 播放头。
 * 通过回调与外部状态交互：
 *   onLiveUpdate()  拖动中持续调用（仅刷新 UI，不入历史）
 *   onCommit()      拖动结束调用（入历史快照）
 *   onScrub(srcSec) 在波形主体拖动定位（试听）
 */
class WaveformEditor {
  constructor(canvas, { onLiveUpdate, onCommit, onScrub } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.clip = null;
    this.peaks = null;
    this.playPos = null;       // 源内秒
    this.splitPos = null;      // 源内秒
    this.onLiveUpdate = onLiveUpdate || (() => {});
    this.onCommit = onCommit || (() => {});
    this.onScrub = onScrub || (() => {});
    this._drag = null;         // 'in' | 'out' | 'split' | 'body' | null
    this._bind();
  }

  setClip(clip) {
    this.clip = clip;
    this.peaks = clip && clip.buffer ? computePeaks(clip.buffer) : null;
    if (clip && this.splitPos == null) this.splitPos = clip.start + (clip.end - clip.start) / 2;
    this.playPos = null;
    this.redraw();
  }

  setPlayPos(sec) { this.playPos = sec; this.redraw(); }
  setSplitPos(sec) { this.splitPos = sec; this.redraw(); }
  getSplitPos() { return this.splitPos; }

  resize() { this.redraw(); }

  // ---- 坐标换算 ----
  _dur() { return this.peaks ? this.peaks.duration : 1; }
  _xToSec(x) {
    const w = this.canvas.clientWidth || 1;
    return Math.max(0, Math.min(this._dur(), (x / w) * this._dur()));
  }
  _secToX(sec) {
    const w = this.canvas.clientWidth || 1;
    return (sec / this._dur()) * w;
  }

  // ---- 命中测试 ----
  _hit(sec) {
    if (!this.clip) return null;
    const d = this._dur();
    const tol = Math.max(0.04, (12 / (this.canvas.clientWidth || 1)) * d); // ~12px
    if (this.splitPos != null && Math.abs(sec - this.splitPos) < tol) return 'split';
    if (Math.abs(sec - this.clip.start) < tol) return 'in';
    if (Math.abs(sec - this.clip.end) < tol) return 'out';
    return 'body';
  }

  _bind() {
    this.canvas.addEventListener('pointerdown', (e) => this._down(e));
    this.canvas.addEventListener('pointermove', (e) => this._move(e));
    this.canvas.addEventListener('pointerup', (e) => this._up(e));
    this.canvas.addEventListener('pointercancel', (e) => this._up(e));
  }

  _down(e) {
    if (!this.clip) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const rect = this.canvas.getBoundingClientRect();
    const sec = this._xToSec(e.clientX - rect.left);
    this._drag = this._hit(sec);
    this._downSec = sec;
    this._moved = false;
    if (this._drag === 'body') {
      // 主体：先记录，拖动视觉定位，单击则试听
    } else {
      this._applyDrag(sec, false);
    }
  }

  _move(e) {
    if (!this.clip || !this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const sec = this._xToSec(e.clientX - rect.left);
    if (Math.abs(sec - this._downSec) > 0.001) this._moved = true;
    if (this._drag === 'body') {
      this.playPos = sec;
      this.redraw();
    } else {
      this._applyDrag(sec, false);
    }
  }

  _up(e) {
    if (!this.clip) return;
    const drag = this._drag;
    this._drag = null;
    if (drag && drag !== 'body') {
      this._applyDrag(this._lastSec || 0, true);
      this.onCommit();
    } else if (drag === 'body' && !this._moved) {
      // 单击主体：从该源位置试听
      this.onScrub(this._downSec);
    }
  }

  _applyDrag(sec, commit) {
    this._lastSec = sec;
    const minDur = 0.05;
    if (this._drag === 'in') {
      this.clip.start = Math.max(0, Math.min(sec, this.clip.end - minDur));
      this.splitPos = Math.max(this.clip.start, Math.min(this.splitPos || 0, this.clip.end));
    } else if (this._drag === 'out') {
      this.clip.end = Math.max(this.clip.start + minDur, Math.min(sec, this._dur()));
      this.splitPos = Math.max(this.clip.start, Math.min(this.splitPos || this.clip.end, this.clip.end));
    } else if (this._drag === 'split') {
      this.splitPos = Math.max(this.clip.start, Math.min(sec, this.clip.end));
    }
    this.redraw();
    this.onLiveUpdate();
  }

  redraw() {
    const prep = prepCanvas(this.canvas);
    if (!prep || !this.clip || !this.peaks) return;
    const { ctx, w, h } = prep;
    const dur = this._dur();
    ctx.clearRect(0, 0, w, h);

    const pad = { top: 6, bottom: 14, side: 6 };
    const gw = w - pad.side * 2;
    const gh = h - pad.top - pad.bottom;
    const gy = pad.top;

    // 裁剪外区域：暗淡
    paintBars(ctx, this.peaks, { x: pad.side, y: gy, w: gw, h: gh, srcStart: 0, srcEnd: this.clip.start, color: 'rgba(120,130,160,0.22)' });
    paintBars(ctx, this.peaks, { x: pad.side, y: gy, w: gw, h: gh, srcStart: this.clip.end, srcEnd: dur, color: 'rgba(120,130,160,0.22)' });
    // 裁剪内区域：高亮
    paintBars(ctx, this.peaks, { x: pad.side, y: gy, w: gw, h: gh, srcStart: this.clip.start, srcEnd: this.clip.end, color: this.clip.color || '#6366f1' });

    // 中线
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(pad.side, gy + gh / 2);
    ctx.lineTo(pad.side + gw, gy + gh / 2);
    ctx.stroke();

    // 入/出手柄
    this._drawHandle(ctx, this._secToX(this.clip.start), gy, gh, '#22d3ee');
    this._drawHandle(ctx, this._secToX(this.clip.end), gy, gh, '#a855f7');

    // 分割标记
    if (this.splitPos != null) {
      const sx = pad.side + this._secToX(this.splitPos);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, gy - 2);
      ctx.lineTo(sx, gy + gh + 2);
      ctx.stroke();
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(sx - 5, gy - 6); ctx.lineTo(sx + 5, gy - 6); ctx.lineTo(sx, gy); ctx.closePath();
      ctx.fill();
    }

    // 播放头
    if (this.playPos != null) {
      const px = pad.side + this._secToX(this.playPos);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, gy - 4);
      ctx.lineTo(px, gy + gh + 4);
      ctx.stroke();
    }

    // 时间标签
    ctx.fillStyle = 'rgba(168,180,204,0.9)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmt(this.clip.start), 6, h - 12);
    ctx.textAlign = 'right';
    ctx.fillText(fmt(this.clip.end), w - 6, h - 12);
  }

  _drawHandle(ctx, x, y, h, color) {
    ctx.fillStyle = color;
    const bw = 4;
    ctx.fillRect(x - bw / 2, y, bw, h);
    // 抓握圆点
    ctx.beginPath();
    ctx.arc(x, y + h / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = 'rgba(11,15,26,0.85)';
    ctx.fillRect(x - 1, y + h / 2 - 5, 2, 10);
  }
}

function fmt(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
