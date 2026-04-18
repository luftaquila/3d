import { api, toast, loginRedirect, fmtBytes } from '../api.js';
import * as Draft from '../draft.js';
import { generateThumbnail } from '../thumb-gen.js';
import { renderWarningBadge, wireWarningBadges } from '../watertight-badge.js';

// Camera stream self-healing.
//   - visibilitychange: drop the stream when the tab is hidden so the server's
//     fan-out broadcaster can release the HA upstream. Reissue a fresh token
//     on return (the old one may have expired).
//   - <img> 'error' on the stream element: expired token, IP change (mobile
//     roam), or server-side forced disconnect. Fetch a new token and retry.
// A module-level cooldown prevents tight reconnect loops when the upstream is
// persistently broken (HA down etc.).
const CAMERA_REFRESH_MIN_INTERVAL_MS = 5000;
let lastCameraRefresh = 0;

async function refreshCameraStream(img) {
  const now = Date.now();
  if (now - lastCameraRefresh < CAMERA_REFRESH_MIN_INTERVAL_MS) return;
  lastCameraRefresh = now;
  try {
    const fresh = await api('/api/camera/status');
    if (document.hidden || !img.isConnected) return;
    if (!fresh.enabled) {
      img.removeAttribute('src');
      document.getElementById('camera-panel')?.classList.add('hidden');
      return;
    }
    if (fresh.streamUrl) img.src = fresh.streamUrl;
  } catch { /* server unreachable; next error will retry after cooldown */ }
}

function wireCameraStream(img) {
  if (!img) return;
  img.addEventListener('error', () => {
    if (document.hidden || !img.isConnected) return;
    refreshCameraStream(img);
  });
}

document.addEventListener('visibilitychange', () => {
  const img = document.getElementById('camera-stream');
  if (!img) return;
  if (document.hidden) {
    img.removeAttribute('src');
    return;
  }
  refreshCameraStream(img);
});

const GOOGLE_ICON_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px;">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
`;

function formatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 11);
  if (d.length < 4) return d;
  if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}
function validPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return /^01[016789]\d{7,8}$/.test(d);
}

export async function renderHome(host, state, navigate) {
  const [homeData, cam, { fields }] = await Promise.all([
    api('/api/home'),
    api('/api/camera/status'),
    api('/api/form-fields'),
  ]);
  const { html, place, mapsClientId } = homeData;

  const authed = !!state.session?.authenticated;
  const submitLabel = authed
    ? '문의 제출'
    : `${GOOGLE_ICON_SVG}<span>Google 로그인 후 제출</span>`;
  const submitClass = 'btn';

  host.innerHTML = `
    ${html ? `<section class="panel"><div class="announcement-body">${html}</div></section>` : ''}

    <section class="panel" id="quote-form-panel">
      <h2>✏️ 견적 문의</h2>

      <label for="f-name">💖 이름 또는 닉네임 <span style="color:var(--danger)">*</span></label>
      <input id="f-name" type="text" required autocomplete="name" />

      <label for="f-phone">☎️ 연락처 <span style="color:var(--danger)">*</span></label>
      <input id="f-phone" type="tel" required autocomplete="tel" placeholder="010-0000-0000" inputmode="numeric" />

      <div id="dynamic-fields"></div>

      <label>📂 STL 파일 업로드 <span style="color:var(--danger)">*</span></label>
      <input id="f-files" type="file" accept=".stl" multiple />
      <p class="muted small" style="margin:4px 0 10px;">모델은 제출 전까지 서버로 전송되지 않습니다.<br>파일 카드를 클릭하면 3D 뷰어가 열립니다.</p>
      <div id="file-preview-list" class="file-grid"></div>

      <div class="panel panel-2 consent-box" id="consent-box" style="margin-top:18px;">
        <h3>개인정보 수집·이용 동의 (필수)</h3>
        <p class="small">
          수집 항목: 이메일, 이름 또는 닉네임, 전화번호<br>
          수집 목적: 3D 프린팅 견적<br>
          보유 기간: 회원 탈퇴 시까지
        </p>
        <div class="consent-toggle">
          <input type="checkbox" id="f-consent">
          위 내용에 동의합니다.
        </div>
      </div>

      <div class="row" style="margin-top:14px;">
        <button class="${submitClass}" id="submit-btn">${submitLabel}</button>
        <button class="btn ghost" id="reset-btn">입력 초기화</button>
      </div>
      <p id="submit-status" class="muted small" style="margin-top:8px;"></p>
    </section>

    ${renderPlaceCard(place)}

    <section id="camera-panel" class="panel camera-card ${cam.enabled ? '' : 'hidden'}">
      <h2>📹 실시간 프린터 카메라</h2>
      ${cam.enabled && cam.streamUrl ? `<img id="camera-stream" src="${cam.streamUrl}" alt="실시간 프린터 카메라">` : ''}
    </section>
  `;

  renderDynamicFields(fields);
  wireCameraStream(document.getElementById('camera-stream'));
  const control = wireQuoteForm(fields, state, navigate);

  mountNaverMap(place, mapsClientId).catch((err) => console.warn('naver map mount failed', err));

  const restored = await restoreDraft(fields, control);
  const autoSubmit = sessionStorage.getItem('quote-auto-submit') === '1';
  sessionStorage.removeItem('quote-auto-submit');

  if (location.pathname.startsWith('/quote')) {
    document.getElementById('quote-form-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (restored && authed && autoSubmit) {
    setTimeout(() => document.getElementById('submit-btn')?.click(), 400);
  }
}

const NAVER_ICON = '<img src="/icons/naver.jpg" alt="" width="24" height="24">';
const KAKAO_ICON = '<img src="/icons/kakao.jpg" alt="" width="24" height="24">';
const TMAP_ICON = '<img src="/icons/tmap.jpg" alt="" width="24" height="24">';

function renderPlaceCard(place) {
  if (!place) return '';
  const href = place.url || '#';
  const nameEnc = encodeURIComponent(place.name);
  const naverDir = href;
  const kakaoDir = `https://map.kakao.com/link/to/${nameEnc},${place.lat},${place.lng}`;
  const tmapDir = `tmap://route?goalname=${nameEnc}&goalx=${place.lng}&goaly=${place.lat}`;
  return `
    <section class="panel">
      <h2>📍 수령 위치</h2>
      <div class="se-map-card">
        <div id="naver-map" class="se-map-image"></div>
        <a class="se-map-info" href="${escapeAttr(href)}" target="_blank" rel="noopener">
          <strong class="se-map-title">${escapeHtml(place.name)}</strong>
          ${place.address ? `<p class="se-map-address">${escapeHtml(place.address)}</p>` : ''}
        </a>
        <div class="map-actions">
          <a class="map-btn" href="${escapeAttr(naverDir)}" rel="noopener">${NAVER_ICON}<span>네이버 지도</span></a>
          <a class="map-btn" href="${escapeAttr(kakaoDir)}" target="_blank" rel="noopener">${KAKAO_ICON}<span>카카오맵</span></a>
          <a class="map-btn" href="${escapeAttr(tmapDir)}" rel="noopener">${TMAP_ICON}<span>티맵</span></a>
        </div>
      </div>
    </section>
  `;
}

let naverSdkPromise = null;
function loadNaverMapsSdk(clientId) {
  if (naverSdkPromise) return naverSdkPromise;
  if (window.naver?.maps) return (naverSdkPromise = Promise.resolve());
  naverSdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}`;
    s.defer = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return naverSdkPromise;
}

async function mountNaverMap(place, clientId) {
  if (!place || !clientId) return;
  try {
    await loadNaverMapsSdk(clientId);
  } catch (err) {
    console.warn('naver maps sdk load failed', err);
    return;
  }
  const el = document.getElementById('naver-map');
  if (!el || !window.naver?.maps) return;
  const pos = new naver.maps.LatLng(place.lat, place.lng);
  const map = new naver.maps.Map(el, {
    center: pos,
    zoom: 15,
    mapTypeControl: false,
    scaleControl: false,
    logoControl: true,
    zoomControl: true,
    zoomControlOptions: { position: naver.maps.Position.TOP_RIGHT, style: naver.maps.ZoomControlStyle.SMALL },
  });
  new naver.maps.Marker({ position: pos, map, title: place.name });
}

function renderDynamicFields(fields) {
  const host = document.getElementById('dynamic-fields');
  host.innerHTML = '';
  for (const f of fields) {
    const id = `f-${f.id}`;
    const labelText = f.required ? `${escapeHtml(f.label)} <span style="color:var(--danger)">*</span>` : escapeHtml(f.label);
    if (f.type === 'notice') {
      host.insertAdjacentHTML('beforeend', `
        <div class="panel panel-2" style="margin-top:12px;">
          <strong>${escapeHtml(f.label)}</strong>
          <div class="muted small" style="margin-top:4px;">${escapeHtml(f.options?.body || '')}</div>
        </div>
      `);
    } else if (f.type === 'checkbox') {
      host.insertAdjacentHTML('beforeend', `
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
          ${labelText}
          <input type="checkbox" id="${id}" style="width:auto;">
        </label>
      `);
    } else if (f.type === 'textarea') {
      host.insertAdjacentHTML('beforeend', `
        <label for="${id}">${labelText}</label>
        <textarea id="${id}"></textarea>
      `);
    } else {
      host.insertAdjacentHTML('beforeend', `
        <label for="${id}">${labelText}</label>
        <input type="text" id="${id}">
      `);
    }
  }
}

function collectFieldValues(fields) {
  const values = {
    name: document.getElementById('f-name').value,
    phone: document.getElementById('f-phone').value,
    consent: document.getElementById('f-consent').checked,
    answers: {},
  };
  for (const f of fields) {
    const el = document.getElementById(`f-${f.id}`);
    if (!el) continue;
    if (f.type === 'checkbox') values.answers[f.id] = el.checked ? '1' : '0';
    else if (f.type === 'notice') continue;
    else values.answers[f.id] = el.value;
  }
  return values;
}

function applyFieldValues(fields, values) {
  if (!values) return;
  const name = document.getElementById('f-name');
  const phone = document.getElementById('f-phone');
  if (name && typeof values.name === 'string') name.value = values.name;
  if (phone && typeof values.phone === 'string') phone.value = formatPhone(values.phone);
  for (const f of fields) {
    const el = document.getElementById(`f-${f.id}`);
    if (!el) continue;
    const v = values.answers?.[f.id];
    if (v === undefined) continue;
    if (f.type === 'checkbox') el.checked = v === '1';
    else if (f.type === 'notice') continue;
    else el.value = v;
  }
}

function wireQuoteForm(fields, state, navigate) {
  const filesInput = document.getElementById('f-files');
  const previewList = document.getElementById('file-preview-list');
  const submitBtn = document.getElementById('submit-btn');
  const resetBtn = document.getElementById('reset-btn');
  const phoneInput = document.getElementById('f-phone');

  phoneInput.addEventListener('input', () => {
    phoneInput.value = formatPhone(phoneInput.value);
  });

  const consentBox = document.getElementById('consent-box');
  const consentCheckbox = document.getElementById('f-consent');
  consentBox?.addEventListener('click', (e) => {
    if (e.target === consentCheckbox) return;
    consentCheckbox.checked = !consentCheckbox.checked;
    consentCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
  });

  let files = [];
  const entries = new Map();
  const bufferCache = new Map();
  let thumbPromise = Promise.resolve();

  function renderCards() {
    previewList.innerHTML = files.map((f, i) => {
      const e = entries.get(f.name) ?? {};
      let thumbContent;
      if (e.thumb) {
        thumbContent = `<img src="${e.thumb}" alt="${escapeAttr(f.name)}">`;
      } else if (e.error) {
        thumbContent = `<div style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:var(--danger);font-size:11px;text-align:center;padding:6px;">썸네일 실패</div>`;
      } else {
        thumbContent = `<div style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">생성 중…</div>`;
      }
      return `
        <div class="file-card clickable" data-index="${i}" title="클릭하여 미리보기">
          <button type="button" class="card-close" data-remove="${i}" title="제거" aria-label="제거">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
          ${renderWarningBadge(e)}
          ${thumbContent}
          <div class="fname">${escapeHtml(f.name)}</div>
          <div class="muted" style="font-size:11px;">${fmtBytes(f.size)}</div>
        </div>
      `;
    }).join('');
    wireWarningBadges(previewList);
  }

  previewList.addEventListener('click', async (e) => {
    const closeBtn = e.target.closest('.card-close');
    if (closeBtn) {
      e.stopPropagation();
      const idx = Number(closeBtn.dataset.remove);
      const newFiles = files.filter((_, i) => i !== idx);
      filesInput.value = '';
      setFiles(newFiles);
      return;
    }
    const card = e.target.closest('.file-card');
    if (!card) return;
    const idx = Number(card.dataset.index);
    const f = files[idx];
    if (!f) return;
    const ent = entries.get(f.name);
    if (ent?.error) {
      toast(`미리보기 실패: ${ent.error}`, 'error');
      return;
    }
    await openViewer([f]);
  });

  async function readBuffer(f) {
    if (bufferCache.has(f.name)) return bufferCache.get(f.name);
    const buf = await f.arrayBuffer();
    bufferCache.set(f.name, buf);
    return buf;
  }

  async function openViewer(selected) {
    try {
      const viewer = await import('../viewer.js');
      const { host, close } = viewer.openViewerModal();
      host.innerHTML = '<p class="muted small" style="padding:12px;">미리보기 로딩 중...</p>';
      const buffers = await Promise.all(selected.map((f) => readBuffer(f)));
      await viewer.mountViewer(host, buffers.map((buf, i) => ({ name: selected[i].name, buffer: buf })), { onClose: close });
    } catch (err) {
      toast(`미리보기 실패: ${err.message || err}`, 'error');
    }
  }

  async function generateThumbsFor(newFiles) {
    for (const f of newFiles) {
      if (entries.has(f.name) && entries.get(f.name).thumb) continue;
      entries.set(f.name, {});
      renderCards();
      try {
        const buf = await readBuffer(f);
        const { dataUrl, triangleCount, isWatertight, boundaryEdges, nonManifoldEdges } = await generateThumbnail(buf);
        entries.set(f.name, {
          thumb: dataUrl,
          tris: triangleCount,
          isWatertight,
          boundaryEdges,
          nonManifoldEdges,
        });
      } catch (err) {
        console.warn('thumbnail failed', f.name, err);
        entries.set(f.name, { error: err.message || String(err) });
      }
      renderCards();
    }
  }

  function setFiles(newFiles) {
    files = newFiles;
    for (const key of Array.from(entries.keys())) {
      if (!files.find((f) => f.name === key)) { entries.delete(key); bufferCache.delete(key); }
    }
    renderCards();
    Draft.saveFiles(files);
    thumbPromise = generateThumbsFor(files).catch(() => {});
  }

  filesInput.addEventListener('change', () => {
    const chosen = Array.from(filesInput.files || []).filter((f) => f.name.toLowerCase().endsWith('.stl'));
    setFiles(chosen);
  });

  const autoSave = debounce(() => {
    Draft.saveFields(collectFieldValues(fields));
  }, 400);

  ['f-name', 'f-phone', 'f-consent'].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', autoSave);
    el?.addEventListener('change', autoSave);
  });
  for (const f of fields) {
    const el = document.getElementById(`f-${f.id}`);
    el?.addEventListener('input', autoSave);
    el?.addEventListener('change', autoSave);
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    resetBtn.disabled = busy;
  }

  resetBtn.addEventListener('click', async () => {
    if (!confirm('입력하신 내용을 모두 지우시겠습니까?')) return;
    document.getElementById('f-name').value = '';
    document.getElementById('f-phone').value = '';
    document.getElementById('f-consent').checked = false;
    for (const f of fields) {
      const el = document.getElementById(`f-${f.id}`);
      if (!el) continue;
      if (f.type === 'checkbox') el.checked = false;
      else if (f.type !== 'notice') el.value = '';
    }
    filesInput.value = '';
    setFiles([]);
    await Draft.clearDraft();
    toast('입력 내용을 초기화했습니다.', 'success');
  });

  submitBtn.addEventListener('click', async () => {
    if (submitBtn.disabled) return;
    const vals = collectFieldValues(fields);
    const status = document.getElementById('submit-status');

    if (!vals.name) return toast('이름 또는 닉네임을 입력해주세요.', 'error');
    if (!vals.phone) return toast('연락처를 입력해주세요.', 'error');
    if (!validPhone(vals.phone)) return toast('전화번호 형식이 올바르지 않습니다. (예: 010-1234-5678)', 'error');
    if (!vals.consent) return toast('개인정보 수집 동의가 필요합니다.', 'error');
    if (files.length === 0) return toast('STL 파일을 업로드해주세요.', 'error');
    for (const f of fields) {
      const v = vals.answers[f.id];
      if (f.required && f.type !== 'checkbox' && f.type !== 'notice' && !v) {
        return toast(`${f.label}을(를) 입력해주세요.`, 'error');
      }
      if (f.required && f.type === 'checkbox' && v !== '1') {
        return toast(`${f.label}을(를) 확인해주세요.`, 'error');
      }
    }

    if (!state.session?.authenticated) {
      Draft.saveFields(vals);
      await Draft.saveFiles(files);
      sessionStorage.setItem('quote-auto-submit', '1');
      toast('로그인 후 자동으로 제출됩니다.', 'info');
      loginRedirect('/');
      return;
    }

    setBusy(true);
    status.textContent = '썸네일 준비 중...';
    try {
      await thumbPromise;
    } catch { /* thumbs are best-effort */ }

    const form = new FormData();
    form.append('name', vals.name);
    form.append('phone', vals.phone);
    form.append('consent', '1');
    for (const [k, v] of Object.entries(vals.answers)) form.append(`answer.${k}`, v);
    for (const f of files) {
      form.append('files', f, f.name);
      const ent = entries.get(f.name);
      if (ent?.thumb) {
        try {
          form.append('thumb', dataUrlToBlob(ent.thumb), `${f.name}.png`);
        } catch { /* ignore, skip thumb */ }
      }
      if (ent && typeof ent.isWatertight === 'boolean') {
        form.append('watertight', JSON.stringify({
          isWatertight: ent.isWatertight,
          boundaryEdges: ent.boundaryEdges ?? 0,
          nonManifoldEdges: ent.nonManifoldEdges ?? 0,
        }));
      }
    }

    status.textContent = '업로드 중...';
    try {
      await api('/api/quotes', { method: 'POST', body: form });
      toast('견적 문의가 접수되었습니다.', 'success');
      await Draft.clearDraft();
      navigate('/my');
    } catch (err) {
      status.textContent = '';
      toast(`실패: ${err.message}`, 'error');
      setBusy(false);
    }
  });

  return { setFiles };
}

function draftIsEmpty(vals, files) {
  if (files && files.length > 0) return false;
  if (!vals) return true;
  if (typeof vals.name === 'string' && vals.name.trim()) return false;
  if (typeof vals.phone === 'string' && vals.phone.trim()) return false;
  if (vals.answers && typeof vals.answers === 'object') {
    for (const v of Object.values(vals.answers)) {
      if (v === true) return false;
      if (typeof v === 'string' && v.trim() && v !== '0') return false;
    }
  }
  return true;
}

async function restoreDraft(fields, control) {
  const vals = Draft.loadFields();
  const savedFiles = await Draft.loadFiles();
  if (draftIsEmpty(vals, savedFiles)) {
    if (vals) Draft.saveFields(null);
    return false;
  }

  applyFieldValues(fields, vals);
  if (savedFiles.length > 0) {
    const filesInput = document.getElementById('f-files');
    try {
      const dt = new DataTransfer();
      for (const f of savedFiles) dt.items.add(f);
      filesInput.files = dt.files;
    } catch {}
    control.setFiles(savedFiles);
  }
  toast('이전 입력 내용이 복원되었습니다.', 'success');
  return true;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
