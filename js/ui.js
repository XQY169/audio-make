/**
 * UI 工具：图标 SVG、时间格式化、toast、确认对话框、导出对话框、全局 loading。
 * 不持有业务状态，纯渲染辅助。
 */

const S = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${p}>`;

export const icons = {
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  plus: S('><path d="M12 5v14M5 12h14"/></svg>'),
  split: S('><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>'),
  scissors: S('><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>'),
  copy: S('><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'),
  trash: S('><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>'),
  download: S('><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>'),
  upload: S('><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>'),
  undo: S('><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>'),
  redo: S('><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/></svg>'),
  info: S('><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'),
  up: S('><path d="M18 15l-6-6-6 6"/></svg>'),
  down: S('><path d="M6 9l6 6 6-6"/></svg>'),
  x: S('><path d="M18 6 6 18M6 6l12 12"/></svg>'),
  music: S('><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'),
  playSmall: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
};

/** m:ss */
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** m:ss.cc（百分秒） */
export function fmtTimeMs(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 简短文件大小 */
export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------------- toast ----------------
export function toast(msg, kind = 'info', ms = 2800) {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="dot"></span><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

// ---------------- 确认对话框 ----------------
export function confirmDialog({ title = '确认', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true">
        <div class="dialog-head">${escapeHtml(title)}</div>
        <div class="dialog-body"><p>${escapeHtml(message)}</p></div>
        <div class="dialog-foot">
          <button class="btn ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'danger' : ''}" ${danger ? 'style="background:linear-gradient(135deg,#ef4444,#b91c1c)"' : ''} data-act="ok">${escapeHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') close(true);
      else if (act === 'cancel' || e.target === ov) close(false);
    });
    ov.querySelector('[data-act="ok"]')?.focus();
  });
}

// ---------------- 全局 loading ----------------
let _veil = null;
export function showLoading(text = '处理中…') {
  hideLoading();
  _veil = document.createElement('div');
  _veil.className = 'loading-veil';
  _veil.innerHTML = `<div class="box"><div class="spinner"></div><div class="label">${escapeHtml(text)}</div></div>`;
  document.body.appendChild(_veil);
}
export function hideLoading() {
  if (_veil) { _veil.remove(); _veil = null; }
}

// ---------------- 导出对话框 ----------------
/**
 * 弹出导出对话框，返回用户选择的导出选项；取消返回 null。
 * @returns Promise<{format:'wav'|'mp3', bitrate:number, filename:string} | null>
 */
export function exportDialog({ defaultName = 'audio', totalDur = 0 } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="dialog">
        <div class="dialog-head">导出音频</div>
        <div class="dialog-body">
          <div class="row"><label>格式</label>
            <select id="exFormat">
              <option value="wav">WAV（无损）</option>
              <option value="mp3">MP3（压缩）</option>
            </select>
          </div>
          <div class="row" id="exBitRow"><label>码率</label>
            <select id="exBitrate">
              <option value="320">320 kbps</option>
              <option value="192" selected>192 kbps</option>
              <option value="128">128 kbps</option>
              <option value="96">96 kbps</option>
            </select>
          </div>
          <div class="row" id="exNameRow"><label>文件名</label>
            <input id="exName" type="text" value="${escapeHtml(defaultName)}" style="max-width:180px;text-align:right" />
          </div>
          <p style="font-size:12px;color:var(--text-3);margin:6px 0 0">时长约 ${fmtTime(totalDur)} · 处理在本地完成，不会上传。</p>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn" data-act="ok">${icons.download} 导出</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const fmtSel = ov.querySelector('#exFormat');
    const bitRow = ov.querySelector('#exBitRow');
    const updateBit = () => { bitRow.style.display = fmtSel.value === 'mp3' ? 'flex' : 'none'; };
    fmtSel.addEventListener('change', updateBit);
    updateBit();

    const close = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') {
        const format = fmtSel.value;
        const bitrate = Number(ov.querySelector('#exBitrate').value);
        let filename = ov.querySelector('#exName').value.trim() || defaultName;
        filename = sanitizeFilename(filename);
        close({ format, bitrate, filename });
      } else if (act === 'cancel' || e.target === ov) {
        close(null);
      }
    });
    ov.querySelector('[data-act="ok"]')?.focus();
  });
}

// ---------------- 关于/帮助 ----------------
export function aboutDialog() {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="dialog">
      <div class="dialog-head">关于 · 帮助</div>
      <div class="dialog-body">
        <p><b>音频工坊</b> 是一个纯本地的音频编辑器：选择多个音频文件后，可<b>裁剪</b>、<b>分割</b>、<b>拼接</b>、<b>重排</b>、<b>淡入淡出</b>与<b>调音量</b>，最后导出为 WAV / MP3 保存到手机。</p>
        <p style="color:var(--text-3);font-size:13px;line-height:1.7">
        • 点时间线片段可选中编辑；<br>
        • 拖动波形上 <span style="color:#22d3ee">青</span>/<span style="color:#a855f7">紫</span> 手柄裁剪；<br>
        • 拖动 <span style="color:#f59e0b">琥珀</span> 分割标记后点"在此分割"；<br>
        • 滑块调音量与淡变；<br>
        • 撤销/重做在顶栏（Ctrl+Z / Ctrl+Y）。</p>
        <p style="color:var(--text-3);font-size:12px">所有处理在浏览器本地完成，不上传任何数据。</p>
      </div>
      <div class="dialog-foot"><button class="btn" data-act="ok">知道了</button></div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="ok"]') || e.target === ov) ov.remove();
  });
}

// ---------------- 小工具 ----------------
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 保存 Blob 到本地：优先 File System Access API 保存选择器，否则下载。 */
export async function saveBlob(blob, filename) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: blob.type || 'file', accept: { [blob.type || 'application/octet-stream']: ['.' + filename.split('.').pop()] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false; // 用户取消
      // 回退到下载
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
