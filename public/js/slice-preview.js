// Sliced-result preview (like a slicer's preview tab) for a .gcode.3mf.
// The archive is read in the browser (zip central directory + the built-in
// DecompressionStream), the plate's G-code is parsed in a Web Worker, and the
// toolpaths are drawn per feature with a layer range slider.
import { createBedScene } from './slice-scene.js';

// Roughly Bambu Studio's preview palette.
const FEATURE_COLORS = {
  'Outer wall': 0xff7d38,
  'Inner wall': 0xffe7a0,
  'Overhang wall': 0x3b5bff,
  'Sparse infill': 0xb03029,
  'Internal solid infill': 0x9654cc,
  'Top surface': 0xf03c3c,
  'Bottom surface': 0x66a9b9,
  'Bridge': 0x4d80ba,
  'Gap infill': 0xffffff,
  'Support': 0x2fd34a,
  'Support interface': 0x0b8a2a,
  'Support transition': 0x6ad07a,
  'Brim': 0x00876e,
  'Skirt': 0x00876e,
  'Floating vertical shell': 0xffb0b0,
  'Prime tower': 0xb1c6e3,
  'Custom': 0x777777,
  'Travel': 0x3a6fd8,
};
const HIDDEN_BY_DEFAULT = new Set(['Travel', 'Custom']);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : (m ? `${m}분` : `${s}초`);
}

// Minimal zip reader: entries from the central directory.
function zipEntries(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 디렉터리 손상');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    out.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function zipReadText(buf, entry) {
  const dv = new DataView(buf);
  const p = entry.localOffset;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('zip 항목 손상');
  const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
  const data = new Uint8Array(buf, start, entry.compSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error(`지원하지 않는 압축 방식 ${entry.method}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

function parseInWorker(text) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gcode-worker.js', import.meta.url));
    worker.onmessage = (ev) => {
      worker.terminate();
      if (ev.data.ok) resolve(ev.data); else reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => { worker.terminate(); reject(new Error(ev.message || 'worker error')); };
    worker.postMessage({ text });
  });
}

// Mounts the preview into the slice detail view. Everything lives on top of
// the 3D view in els.canvas: layer info + legend (top left) and a vertical
// layer range slider on the right edge, like a slicer. els.plate is a
// <select> for multi-plate results, els.status a message line.
// Returns { dispose }.
export function mountSlicePreview(els, { url }) {
  const info = document.createElement('div');
  info.className = 'ov ov-tl sp-info small';
  info.innerHTML = `
    <div class="sp-layerinfo"></div>
    <details class="sp-legend-wrap">
      <summary>표시 항목</summary>
      <div class="sp-legend"></div>
    </details>`;
  const lv = document.createElement('div');
  lv.className = 'ov lv';
  lv.innerHTML = `
    <button class="lv-btn lv-up" aria-label="한 레이어 위">▲</button>
    <div class="lv-track">
      <div class="lv-fill"></div>
      <div class="lv-handle lv-lo"><span class="lv-tag"></span></div>
      <div class="lv-handle lv-hi"><span class="lv-tag"></span></div>
    </div>
    <button class="lv-btn lv-down" aria-label="한 레이어 아래">▼</button>
    <button class="lv-btn lv-single" title="현재 레이어만 보기">한 층</button>`;
  const status = els.status;
  const sel = els.plate;
  sel.hidden = true;
  sel.innerHTML = '';
  status.textContent = '불러오는 중…';
  const view = createBedScene(els.canvas);
  els.canvas.append(info, lv);
  info.hidden = true;
  lv.hidden = true;
  const { THREE, scene } = view;
  const q = (root, s) => root.querySelector(s);
  const track = q(lv, '.lv-track');
  const hiEl = q(lv, '.lv-hi');
  const loEl = q(lv, '.lv-lo');
  let groups = [];
  let data = null;
  let disposed = false;
  let lo = 0, hi = 0, max = 0, single = false;

  function clearPlate() {
    for (const g of groups) {
      scene.remove(g.lines);
      g.lines.geometry.dispose();
      g.lines.material.dispose();
    }
    groups = [];
  }

  function setRange(nlo, nhi, moved) {
    const clamp = (v) => Math.max(0, Math.min(max, Math.round(v)));
    nlo = clamp(nlo); nhi = clamp(nhi);
    if (single) nlo = nhi;
    else if (nlo > nhi) { if (moved === 'lo') nhi = nlo; else nlo = nhi; }
    lo = nlo; hi = nhi;
    applyRange();
  }

  function applyRange() {
    if (!data) return;
    for (const g of groups) {
      const s = g.layerStart[lo];
      const e = g.layerStart[hi + 1];
      g.lines.geometry.setDrawRange(s * 2, Math.max(0, e - s) * 2);
    }
    const pct = (v) => (max ? (v / max) * 100 : 0);
    hiEl.style.bottom = `${pct(hi)}%`;
    loEl.style.bottom = `${pct(lo)}%`;
    loEl.hidden = single;
    const fill = q(lv, '.lv-fill');
    fill.style.bottom = `${pct(lo)}%`;
    fill.style.top = `${100 - pct(hi)}%`;
    const L = data.layers[hi];
    q(hiEl, '.lv-tag').innerHTML = `<b>${hi + 1}</b> ${L ? `${L.z.toFixed(2)}mm` : ''}`;
    q(loEl, '.lv-tag').innerHTML = `<b>${lo + 1}</b>`;
    q(lv, '.lv-single').classList.toggle('active', single);
    const shown = data.layers.slice(lo, hi + 1).reduce((a, l) => a + l.timeS, 0);
    q(info, '.sp-layerinfo').innerHTML = `
      <div><b>레이어 ${single || lo === 0 ? hi + 1 : `${lo + 1}~${hi + 1}`}</b> <span class="muted">/ ${data.layers.length}</span></div>
      <div>높이 ${L ? L.z.toFixed(2) : '-'}mm</div>
      <div>이 레이어 약 ${fmtDur(L?.timeS)}</div>
      <div class="muted">보이는 구간 약 ${fmtDur(shown)} / 전체 ${fmtDur(data.totalTimeS)}</div>`;
  }

  function renderLegend() {
    const total = data.features.reduce((a, f) => a + (f.name === 'Travel' ? 0 : f.positions.length), 0) || 1;
    q(info, '.sp-legend').innerHTML = groups.map((g, i) => {
      const color = `#${(FEATURE_COLORS[g.name] ?? 0xcccccc).toString(16).padStart(6, '0')}`;
      const share = g.name === 'Travel' ? '' : `<span class="muted">${Math.round((g.count * 6 / total) * 100)}%</span>`;
      return `<label class="sp-feat"><input type="checkbox" data-i="${i}" ${g.lines.visible ? 'checked' : ''}>
        <span class="sp-swatch" style="background:${color}"></span><span class="sp-feat-name">${escapeHtml(g.name)}</span>${share}</label>`;
    }).join('');
    q(info, '.sp-legend').querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => { groups[Number(cb.dataset.i)].lines.visible = cb.checked; });
    });
  }

  async function showPlate(buf, entry) {
    status.textContent = 'G-code 해석 중…';
    const text = await zipReadText(buf, entry);
    const parsed = await parseInWorker(text);
    if (disposed) return;
    data = parsed;
    clearPlate();
    for (const f of data.features) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: FEATURE_COLORS[f.name] ?? 0xcccccc,
        transparent: f.name === 'Travel',
        opacity: f.name === 'Travel' ? 0.35 : 1,
      });
      const lines = new THREE.LineSegments(geom, mat);
      lines.visible = !HIDDEN_BY_DEFAULT.has(f.name);
      scene.add(lines);
      groups.push({ name: f.name, lines, layerStart: f.layerStart, count: f.positions.length / 6 });
    }
    // walls first, travel last in the legend
    groups.sort((a, b) => (a.name === 'Travel') - (b.name === 'Travel') || b.count - a.count);
    max = Math.max(0, data.layers.length - 1);
    info.hidden = false;
    lv.hidden = false;
    renderLegend();
    setRange(0, max);
    status.textContent = '';
  }

  // slider: drag a handle, or tap the track to move the nearer one
  const valueAt = (y) => {
    const r = track.getBoundingClientRect();
    return ((r.bottom - y) / r.height) * max;
  };
  let dragging = null;
  for (const [el, which] of [[hiEl, 'hi'], [loEl, 'lo']]) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      dragging = which;
    });
    el.addEventListener('pointermove', (e) => {
      if (dragging !== which) return;
      const v = valueAt(e.clientY);
      if (which === 'hi') setRange(lo, v, 'hi'); else setRange(v, hi, 'lo');
    });
    const end = () => { dragging = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track && !e.target.classList.contains('lv-fill')) return;
    const v = valueAt(e.clientY);
    if (single || Math.abs(v - hi) <= Math.abs(v - lo)) setRange(lo, v, 'hi');
    else setRange(v, hi, 'lo');
  });
  lv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = e.deltaY < 0 ? 1 : -1;
    setRange(single ? hi + d : lo, hi + d, 'hi');
  }, { passive: false });
  const step = (d) => setRange(single ? hi + d : lo, hi + d, 'hi');
  q(lv, '.lv-up').addEventListener('click', () => step(1));
  q(lv, '.lv-down').addEventListener('click', () => step(-1));
  q(lv, '.lv-single').addEventListener('click', () => { single = !single; setRange(lo, hi, 'hi'); });
  // arrow keys step the top layer like a slicer (not while typing)
  const onKey = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.target.closest?.('input, textarea, select')) return;
    e.preventDefault();
    step(e.key === 'ArrowUp' ? 1 : -1);
  };
  document.addEventListener('keydown', onKey);

  (async () => {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`파일을 불러오지 못했습니다 (${res.status})`);
      const buf = await res.arrayBuffer();
      if (disposed) return;
      const plates = zipEntries(buf)
        .filter((e) => /^Metadata\/plate_\d+\.gcode$/.test(e.name))
        .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
      if (!plates.length) throw new Error('G-code가 없습니다');
      if (plates.length > 1) {
        sel.innerHTML = plates.map((p, i) => `<option value="${i}">판 ${p.name.match(/\d+/)[0]}</option>`).join('');
        sel.hidden = false;
        sel.onchange = () => showPlate(buf, plates[Number(sel.value)]).catch((err) => { status.textContent = err.message; });
      }
      await showPlate(buf, plates[0]);
    } catch (err) {
      if (!disposed) status.textContent = `미리보기 실패: ${err.message || err}`;
    }
  })();

  return {
    dispose() {
      disposed = true;
      document.removeEventListener('keydown', onKey);
      sel.onchange = null;
      sel.hidden = true;
      clearPlate();
      view.dispose();
      info.remove();
      lv.remove();
      status.textContent = '';
    },
  };
}
