/**
 * 音频工坊 · 应用入口
 * 状态编排 + 历史栈 + 事件绑定 + 渲染（时间线 / 编辑面板 / 传输栏 / 导出）。
 * 单轨：片段顺序拼接；数据模型用 clips 数组（多轨预留：可包装为 tracks[]）。
 */
import { AudioEngine, totalDuration, clipDuration } from './audio-engine.js';
import { WaveformEditor, drawThumbnail } from './waveform.js';
import {
  icons, fmtTime, fmtTimeMs, toast, confirmDialog, exportDialog,
  aboutDialog, showLoading, hideLoading, saveBlob, escapeHtml,
} from './ui.js';

const COLORS = ['#6366f1', '#06b6d4', '#a855f7', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6', '#f97316'];

// ---------------- 状态 ----------------
const state = { clips: [], selectedId: null };
let engine = null;
let editor = null; // WaveformEditor

const history = { undo: [], redo: [] };

function uid() { return 'c' + Math.random().toString(36).slice(2, 9); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function getClip(id) { return state.clips.find((c) => c.id === id) || null; }
function selected() { return getClip(state.selectedId); }
function totalDur() { return totalDuration(state.clips); }

// ---------------- 历史 ----------------
function snapshot() {
  return { clips: state.clips.map((c) => ({ ...c })), selectedId: state.selectedId };
}
function restore(s) {
  state.clips = s.clips.map((c) => ({ ...c }));
  state.selectedId = s.selectedId;
}
function initHistory() { history.undo = [snapshot()]; history.redo = []; }
function commit() {
  history.undo.push(snapshot());
  if (history.undo.length > 60) history.undo.shift();
  history.redo = [];
  updateHistoryButtons();
}
function canUndo() { return history.undo.length >= 2; }
function canRedo() { return history.redo.length >= 1; }
function undo() {
  if (!canUndo()) return;
  engine.stop();
  history.redo.push(history.undo.pop());
  restore(history.undo[history.undo.length - 1]);
  afterChange();
}
function redo() {
  if (!canRedo()) return;
  engine.stop();
  const s = history.redo.pop();
  history.undo.push(s);
  restore(s);
  afterChange();
}

// ---------------- 初始化 ----------------
function init() {
  engine = new AudioEngine();
  engine.onUpdate = onEngineUpdate;
  initHistory();
  bindGlobal();
  bindScrub();
  renderAll();
  window.addEventListener('resize', () => { if (editor) editor.resize(); renderTimelineKeep(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { if (editor) editor.resize(); }, 300));
}

// 防御：若脚本在 DOMContentLoaded 之后才执行（如被 SW 缓存延迟），仍能立即初始化。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function stopPlayback() { if (engine && engine.state !== 'stopped') engine.stop(); }

// ---------------- 全局事件 ----------------
function bindGlobal() {
  const fi = document.getElementById('fileInput');
  fi.addEventListener('change', (e) => { addFiles(e.target.files).finally(() => { fi.value = ''; }); });
  document.getElementById('addBtn').onclick = () => fi.click();
  document.getElementById('emptyAddBtn').onclick = () => fi.click();
  document.getElementById('exportBtn').onclick = onExport;
  document.getElementById('playBtn').onclick = onPlay;
  document.getElementById('stopBtn').onclick = () => stopPlayback();
  document.getElementById('undoBtn').onclick = undo;
  document.getElementById('redoBtn').onclick = redo;
  document.getElementById('aboutBtn').onclick = aboutDialog;
  document.addEventListener('keydown', onKey);
  // 拖拽添加文件（桌面）
  ['dragover', 'dragenter'].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); }));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
}

function onKey(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); redo(); }
  else if (e.code === 'Space') { e.preventDefault(); onPlay(); }
}

// ---------------- 导入 ----------------
async function addFiles(fileList) {
  const files = Array.from(fileList).filter(
    (f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm|weba|amr|aiff|aif)$/i.test(f.name)
  );
  if (!files.length) { toast('未选择有效的音频文件', 'error'); return; }
  stopPlayback();
  showLoading(`解码音频（0/${files.length}）…`);
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    showLoading(`解码音频（${i}/${files.length}）… ${files[i].name}`);
    try {
      const buf = await engine.decodeFile(files[i]);
      state.clips.push({
        id: uid(),
        name: prettyName(files[i].name),
        buffer: buf,
        start: 0,
        end: buf.duration,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        color: COLORS[state.clips.length % COLORS.length],
      });
      if (!state.selectedId) state.selectedId = state.clips[state.clips.length - 1].id;
      ok++;
    } catch (err) {
      fail++;
      toast(err.message || `解码失败：${files[i].name}`, 'error', 4500);
    }
  }
  hideLoading();
  if (ok) {
    commit();
    renderAll();
    toast(`已添加 ${ok} 个音频${fail ? `，${fail} 个失败` : ''}`, 'success');
  } else {
    renderAll();
  }
}

function prettyName(name) {
  return name.replace(/\.[^.]+$/, '').slice(0, 40);
}

// ---------------- 播放控制 ----------------
function onPlay() {
  if (!state.clips.length) return;
  const st = engine.getStatus();
  if (st.state === 'playing') engine.pause();
  else if (st.state === 'preview') engine.stopPreview();
  else engine.play(state.clips);
}

function bindScrub() {
  const scrub = document.getElementById('scrub');
  let dragging = false;
  const seekFrom = (e) => {
    const rect = scrub.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (engine.state === 'preview') engine.stopPreview();
    engine.seek(state.clips, x * totalDur());
  };
  scrub.addEventListener('pointerdown', (e) => {
    dragging = true; scrub.setPointerCapture(e.pointerId); seekFrom(e);
  });
  scrub.addEventListener('pointermove', (e) => { if (dragging) seekFrom(e); });
  const end = () => { dragging = false; };
  scrub.addEventListener('pointerup', end);
  scrub.addEventListener('pointercancel', end);
  scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -2 : 2;
      engine.seek(state.clips, clamp(engine.getStatus().pos + d, 0, totalDur()));
    }
  });
}

function onEngineUpdate(status) {
  updateTransport(status);
  if (!editor || !state.selectedId) return;
  const sel = selected();
  if (!sel) return;
  if (status.preview) {
    editor.setPlayPos(sel.start + (status.origin || 0) + status.pos);
  } else if (status.state === 'playing') {
    let acc = 0, cur = null, within = 0;
    for (const c of state.clips) {
      const d = clipDuration(c);
      if (status.pos >= acc - 1e-6 && status.pos < acc + d) { cur = c; within = status.pos - acc; break; }
      acc += d;
    }
    editor.setPlayPos(cur && cur.id === state.selectedId ? cur.start + within : null);
  } else {
    // stopped/paused：不清除视觉拖动游标，除非确无
  }
}

// ---------------- 渲染 ----------------
function renderAll() {
  renderTimeline();
  renderEditor();
  updateMeta();
  updateTransport(engine.getStatus());
  updateHistoryButtons();
  updateActionButtons();
}

function afterChange() { renderAll(); }

function updateHistoryButtons() {
  document.getElementById('undoBtn').disabled = !canUndo();
  document.getElementById('redoBtn').disabled = !canRedo();
}

function updateActionButtons() {
  const has = state.clips.length > 0;
  document.getElementById('exportBtn').disabled = !has;
  document.getElementById('playBtn').disabled = !has;
  document.getElementById('stopBtn').disabled = engine.getStatus().state === 'stopped';
}

function updateMeta() {
  document.getElementById('clipMeta').textContent =
    `${state.clips.length} 个片段 · 总时长 ${fmtTime(totalDur())}`;
}

function updateTransport(status) {
  const playBtn = document.getElementById('playBtn');
  const playing = status.state === 'playing' || status.state === 'preview';
  playBtn.innerHTML = playing ? icons.pause : icons.play;
  document.getElementById('stopBtn').disabled = status.state === 'stopped';
  const total = status.total || 0;
  const pct = total > 0 ? clamp((status.pos / total) * 100, 0, 100) : 0;
  document.getElementById('scrubFill').style.width = pct + '%';
  document.getElementById('scrubKnob').style.left = pct + '%';
  document.getElementById('curTime').textContent = fmtTime(status.pos);
  document.getElementById('totTime').textContent = fmtTime(total);
  const scrub = document.getElementById('scrub');
  scrub.setAttribute('aria-valuenow', String(Math.round(status.pos * 10) / 10));
  scrub.setAttribute('aria-valuemax', String(Math.round(total * 10) / 10));
}

// ---- 时间线 ----
function renderTimelineKeep() { renderTimeline(); }

function renderTimeline() {
  const tl = document.getElementById('timeline');
  const scroll = tl.scrollLeft;
  tl.innerHTML = '';
  state.clips.forEach((clip, i) => {
    const card = document.createElement('div');
    card.className = 'clip-card' + (clip.id === state.selectedId ? ' selected' : '');
    card.dataset.id = clip.id;
    card.innerHTML = `
      <div class="order">${i + 1}</div>
      ${clip.gain < 0.01 ? '<div class="muted-flag">静音</div>' : ''}
      <div class="thumb"><canvas></canvas></div>
      <div class="meta-row">
        <span class="name" title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</span>
        <span class="badge">${Math.round(clip.gain * 100)}%</span>
      </div>
      <div class="dur">${fmtTime(clipDuration(clip))} / ${fmtTime(clip.buffer.duration)}</div>
      <div class="reorder">
        <button data-act="up" title="前移" aria-label="前移">${icons.up}</button>
        <button data-act="down" title="后移" aria-label="后移">${icons.down}</button>
      </div>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.reorder')) return;
      selectClip(clip.id);
    });
    card.querySelector('[data-act="up"]').onclick = (e) => { e.stopPropagation(); moveClip(clip.id, -1); };
    card.querySelector('[data-act="down"]').onclick = (e) => { e.stopPropagation(); moveClip(clip.id, 1); };
    tl.appendChild(card);
    requestAnimationFrame(() => drawThumbnail(card.querySelector('canvas'), clip));
  });

  const add = document.createElement('button');
  add.className = 'add-card';
  add.innerHTML = `${icons.plus}<span>添加音频</span>`;
  add.onclick = () => document.getElementById('fileInput').click();
  tl.appendChild(add);
  tl.scrollLeft = scroll;
}

function refreshClipCard(clip) {
  const card = document.querySelector(`.clip-card[data-id="${clip.id}"]`);
  if (!card) return;
  drawThumbnail(card.querySelector('canvas'), clip);
  card.querySelector('.dur').textContent = `${fmtTime(clipDuration(clip))} / ${fmtTime(clip.buffer.duration)}`;
  card.querySelector('.badge').textContent = Math.round(clip.gain * 100) + '%';
  let muted = card.querySelector('.muted-flag');
  if (clip.gain < 0.01 && !muted) {
    muted = document.createElement('div');
    muted.className = 'muted-flag'; muted.textContent = '静音';
    card.appendChild(muted);
  } else if (clip.gain >= 0.01 && muted) {
    muted.remove();
  }
}

// ---- 编辑面板 ----
function renderEditor() {
  const host = document.getElementById('editorHost');
  const sel = selected();
  if (!state.clips.length || !sel) { renderEmpty(host); editor = null; return; }
  const dur = clipDuration(sel);
  host.innerHTML = `
    <div class="editor">
      <div class="panel">
        <div class="panel-head">
          <div class="title">${escapeHtml(sel.name)}
            <small>${fmtTime(dur)} · 源 ${fmtTime(sel.buffer.duration)} · ${sel.buffer.numberOfChannels} 声道 · ${(sel.buffer.sampleRate / 1000).toFixed(1)} kHz</small>
          </div>
          <div class="seg">
            <button class="seg-btn primary" id="btnPreview">${icons.playSmall} 试听</button>
            <button class="seg-btn" id="btnSplit">${icons.scissors} 在此分割</button>
            <button class="seg-btn" id="btnDup">${icons.copy} 复制</button>
            <button class="seg-btn danger" id="btnDel">${icons.trash} 删除</button>
          </div>
        </div>
        <div class="wave-stage">
          <canvas id="waveCanvas"></canvas>
          <div class="hint">拖动 青/紫 手柄裁剪 · 拖动 琥珀 标记后点"在此分割" · 单击波形试听</div>
        </div>
        <div class="params">
          <div class="time-inputs">
            <div class="field">
              <div class="lbl"><span>入点</span><b id="inVal">${fmtTimeMs(sel.start)}</b></div>
              <input type="number" id="inNum" min="0" step="0.1" value="${sel.start.toFixed(3)}">
            </div>
            <div class="field">
              <div class="lbl"><span>出点</span><b id="outVal">${fmtTimeMs(sel.end)}</b></div>
              <input type="number" id="outNum" min="0" step="0.1" value="${sel.end.toFixed(3)}">
            </div>
          </div>
          <div class="field">
            <div class="lbl"><span>音量</span><b id="gainVal">${Math.round(sel.gain * 100)}%</b></div>
            <input type="range" id="gain" min="0" max="200" step="1" value="${Math.round(sel.gain * 100)}">
          </div>
          <div class="field">
            <div class="lbl"><span>淡入</span><b id="fadeInVal">${sel.fadeIn.toFixed(2)}s</b></div>
            <input type="range" id="fadeIn" min="0" max="5" step="0.05" value="${sel.fadeIn}">
          </div>
          <div class="field">
            <div class="lbl"><span>淡出</span><b id="fadeOutVal">${sel.fadeOut.toFixed(2)}s</b></div>
            <input type="range" id="fadeOut" min="0" max="5" step="0.05" value="${sel.fadeOut}">
          </div>
        </div>
      </div>
    </div>`;

  const canvas = document.getElementById('waveCanvas');
  editor = new WaveformEditor(canvas, {
    onLiveUpdate: onEditorLive,
    onCommit: () => commit(),
    onScrub: (srcSec) => { engine.previewClip(selected(), srcSec); },
  });
  editor.setClip(sel);

  // 控件
  document.getElementById('btnPreview').onclick = () => engine.previewClip(sel);
  document.getElementById('btnSplit').onclick = () => splitClip(sel, editor.getSplitPos());
  document.getElementById('btnDup').onclick = () => duplicateClip(sel);
  document.getElementById('btnDel').onclick = () => deleteClip(sel);

  const gain = document.getElementById('gain');
  const fadeIn = document.getElementById('fadeIn');
  const fadeOut = document.getElementById('fadeOut');
  gain.oninput = () => { sel.gain = Number(gain.value) / 100; refreshEditorNumbers(); refreshClipCard(sel); };
  gain.onchange = () => commit();
  fadeIn.oninput = () => { sel.fadeIn = Math.min(Number(fadeIn.value), dur); refreshEditorNumbers(); };
  fadeIn.onchange = () => commit();
  fadeOut.oninput = () => { sel.fadeOut = Math.min(Number(fadeOut.value), dur); refreshEditorNumbers(); };
  fadeOut.onchange = () => commit();

  const inNum = document.getElementById('inNum');
  const outNum = document.getElementById('outNum');
  inNum.onchange = () => {
    sel.start = clamp(parseFloat(inNum.value) || 0, 0, sel.end - 0.05);
    editor.splitPos = clamp(editor.splitPos, sel.start, sel.end);
    commit(); editor.redraw(); refreshClipCard(sel); updateMeta(); updateTransport(engine.getStatus()); refreshEditorNumbers();
  };
  outNum.onchange = () => {
    sel.end = clamp(parseFloat(outNum.value) || 0, sel.start + 0.05, sel.buffer.duration);
    editor.splitPos = clamp(editor.splitPos, sel.start, sel.end);
    commit(); editor.redraw(); refreshClipCard(sel); updateMeta(); updateTransport(engine.getStatus()); refreshEditorNumbers();
  };
}

function renderEmpty(host) {
  host.innerHTML = `
    <div class="empty">
      <div class="empty-card">
        <div class="ico" aria-hidden="true">${icons.music}</div>
        <h3>开始你的音频项目</h3>
        <p>选择多个音频文件，在此剪辑、分割、拼接、淡变与调整音量，全部在本地完成，不上传任何数据。</p>
        <button class="btn" id="emptyAddBtn2">${icons.plus} 添加音频文件</button>
      </div>
    </div>`;
  document.getElementById('emptyAddBtn2').onclick = () => document.getElementById('fileInput').click();
}

function refreshEditorNumbers() {
  const sel = selected();
  if (!sel || !editor) return;
  const inVal = document.getElementById('inVal');
  const outVal = document.getElementById('outVal');
  const gainVal = document.getElementById('gainVal');
  const fadeInVal = document.getElementById('fadeInVal');
  const fadeOutVal = document.getElementById('fadeOutVal');
  if (inVal) inVal.textContent = fmtTimeMs(sel.start);
  if (outVal) outVal.textContent = fmtTimeMs(sel.end);
  if (gainVal) gainVal.textContent = Math.round(sel.gain * 100) + '%';
  if (fadeInVal) fadeInVal.textContent = sel.fadeIn.toFixed(2) + 's';
  if (fadeOutVal) fadeOutVal.textContent = sel.fadeOut.toFixed(2) + 's';
  const inNum = document.getElementById('inNum');
  const outNum = document.getElementById('outNum');
  if (inNum && document.activeElement !== inNum) inNum.value = sel.start.toFixed(3);
  if (outNum && document.activeElement !== outNum) outNum.value = sel.end.toFixed(3);
}

function onEditorLive() {
  const sel = selected();
  if (!sel) return;
  refreshClipCard(sel);
  refreshEditorNumbers();
  updateMeta();
  updateTransport(engine.getStatus());
}

// ---------------- 片段操作 ----------------
function selectClip(id) {
  if (engine.state === 'preview') engine.stopPreview();
  state.selectedId = id;
  document.querySelectorAll('.clip-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  renderEditor();
}

function moveClip(id, dir) {
  const idx = state.clips.findIndex((c) => c.id === id);
  const j = idx + dir;
  if (j < 0 || j >= state.clips.length) return;
  stopPlayback();
  const [c] = state.clips.splice(idx, 1);
  state.clips.splice(j, 0, c);
  commit();
  renderAll();
}

function splitClip(clip, at) {
  at = clamp(at, clip.start + 0.05, clip.end - 0.05);
  const idx = state.clips.indexOf(clip);
  stopPlayback();
  const left = { ...clip, end: at, fadeOut: 0 };
  const right = { ...clip, id: uid(), start: at, fadeIn: 0, name: clip.name };
  state.clips.splice(idx, 1, left, right);
  state.selectedId = left.id;
  commit();
  renderAll();
  toast('已分割', 'success', 1500);
}

function duplicateClip(clip) {
  const idx = state.clips.indexOf(clip);
  stopPlayback();
  const copy = { ...clip, id: uid(), name: clip.name + ' 副本' };
  state.clips.splice(idx + 1, 0, copy);
  state.selectedId = copy.id;
  commit();
  renderAll();
  toast('已复制', 'success', 1500);
}

async function deleteClip(clip) {
  const ok = await confirmDialog({
    title: '删除片段',
    message: `确定删除"${clip.name}"？该操作可撤销。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  stopPlayback();
  const idx = state.clips.indexOf(clip);
  state.clips.splice(idx, 1);
  if (state.selectedId === clip.id) state.selectedId = state.clips[idx]?.id || state.clips[0]?.id || null;
  commit();
  renderAll();
  toast('已删除', 'success', 1500);
}

// ---------------- 导出 ----------------
function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function onExport() {
  if (!state.clips.length) return;
  stopPlayback();
  const opts = await exportDialog({ defaultName: `音频工坊_${dateStamp()}`, totalDur: totalDur() });
  if (!opts) return;
  showLoading('渲染导出中…');
  try {
    const res = await engine.export(state.clips, { format: opts.format, bitrate: opts.bitrate });
    hideLoading();
    const filename = `${opts.filename}.${res.ext}`;
    const saved = await saveBlob(res.blob, filename);
    if (res.fallback) toast('MP3 编码失败，已改存为 WAV', 'error', 4500);
    if (saved) toast('已导出：' + filename, 'success', 3500);
  } catch (e) {
    hideLoading();
    toast(e.message || '导出失败', 'error', 4500);
  }
}
