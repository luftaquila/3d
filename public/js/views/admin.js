import { api, toast, loginRedirect, fmtBytes, fmtDate } from '../api.js';
import { renderWarningBadge, wireWarningBadges } from '../watertight-badge.js';

export async function renderAdmin(host, state) {
  if (!state.session?.authenticated) {
    host.innerHTML = `
      <section class="panel">
        <h1>관리자</h1>
        <p>관리자 로그인이 필요합니다.</p>
        <button class="btn" id="login-btn">Google 로그인</button>
      </section>
    `;
    document.getElementById('login-btn').onclick = () => loginRedirect('/admin');
    return;
  }
  if (!state.session.isAdmin) {
    host.innerHTML = `
      <section class="panel">
        <h1>관리자</h1>
        <p class="error">관리자 권한이 없습니다.</p>
      </section>
    `;
    return;
  }

  host.innerHTML = `
    <section class="panel" id="settings-panel"></section>
    <section class="panel" id="fields-panel"></section>
    <section class="panel" id="quotes-panel"></section>
  `;

  await Promise.all([
    renderSettings(),
    renderFieldsAdmin(),
    renderQuotesAdmin(),
  ]);
}

async function renderSettings() {
  const host = document.getElementById('settings-panel');
  const { settings } = await api('/api/admin/settings');
  const cameraOn = settings.camera_enabled === '1';
  const homeHtml = settings.home_html ?? '';
  host.innerHTML = `
    <h2>설정</h2>
    <label style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="cam-toggle" ${cameraOn ? 'checked' : ''} style="width:auto;">
      카메라 스트림을 메인 페이지에 표시
    </label>

    <label for="home-html" style="margin-top:20px;">메인 페이지 공지 (HTML)</label>
    <p class="muted small" style="margin:4px 0 8px;">비워두면 메인에 공지 영역이 표시되지 않습니다.</p>
    <textarea id="home-html" style="min-height:220px;font-family:var(--font-mono);font-size:13px;">${escapeHtml(homeHtml)}</textarea>
    <div class="row" style="margin-top:10px;">
      <button class="btn" id="save-home-html">저장</button>
    </div>

    <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--border-light);">
      <h3 style="margin:0 0 4px;">누락 정보 일괄 갱신</h3>
      <p class="muted small" style="margin:0 0 10px;">이전에 업로드되어 썸네일 또는 watertight 분석이 없는 파일을 브라우저에서 재계산해 서버에 업데이트합니다. 파일 개수가 많으면 시간이 걸립니다.</p>
      <div class="row" style="gap:8px;align-items:center;">
        <button class="btn" id="backfill-start">시작</button>
        <span class="muted small" id="backfill-status"></span>
      </div>
    </div>
  `;
  document.getElementById('cam-toggle').addEventListener('change', async (e) => {
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: { camera_enabled: e.target.checked ? '1' : '0' },
      });
      toast('설정 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('save-home-html').addEventListener('click', async () => {
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: { home_html: document.getElementById('home-html').value },
      });
      toast('공지 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('backfill-start').addEventListener('click', runBackfill);
}

async function runBackfill() {
  const button = document.getElementById('backfill-start');
  const status = document.getElementById('backfill-status');
  button.disabled = true;
  status.textContent = '대상 조회 중...';
  try {
    const { files } = await api('/api/admin/backfill/list');
    if (!files || files.length === 0) {
      status.textContent = '업데이트할 파일이 없습니다.';
      button.disabled = false;
      return;
    }
    const { generateThumbnail } = await import('../thumb-gen.js');
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      status.textContent = `${i + 1}/${files.length} · ${f.filename}`;
      try {
        await backfillOne(f, generateThumbnail);
        ok += 1;
      } catch (err) {
        console.warn('backfill failed', f, err);
        fail += 1;
      }
    }
    status.textContent = `완료 · 성공 ${ok} · 실패 ${fail}`;
    toast(`일괄 갱신 완료 (성공 ${ok}, 실패 ${fail})`, fail === 0 ? 'success' : 'error');
  } catch (err) {
    status.textContent = `오류: ${err.message || err}`;
    toast(`실패: ${err.message || err}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function backfillOne(f, generateThumbnail) {
  const res = await fetch(f.stlUrl, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`STL fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const { dataUrl, isWatertight, boundaryEdges, nonManifoldEdges } = await generateThumbnail(buf);

  const form = new FormData();
  if (f.missingThumb) {
    form.append('thumb', dataUrlToBlob(dataUrl), `${f.filename}.png`);
  }
  if (f.missingWatertight) {
    form.append('watertight', JSON.stringify({
      isWatertight,
      boundaryEdges,
      nonManifoldEdges,
    }));
  }
  await api(`/api/admin/backfill/update/${encodeURIComponent(f.quoteId)}/${encodeURIComponent(f.fileId)}`, {
    method: 'POST',
    body: form,
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function renderFieldsAdmin() {
  const host = document.getElementById('fields-panel');
  const { fields } = await api('/api/admin/form-fields');
  host.innerHTML = `
    <h2>견적 폼 필드</h2>
    <div style="overflow-x:auto;">
    <table class="admin-table">
      <thead><tr><th style="width:1%;">순서</th><th style="width:1%;">타입</th><th style="width:1%;">라벨</th><th style="width:1%;text-align:center;">필수</th><th>본문</th><th style="width:1%;text-align:center;"></th></tr></thead>
      <tbody>
        ${fields.map((f) => renderFieldRow(f)).join('')}
        ${renderNewFieldRow()}
      </tbody>
    </table>
    </div>
  `;

  host.querySelectorAll('select[data-field="type"]').forEach((sel) => {
    const syncBody = () => {
      const row = sel.closest('tr');
      const bodyInput = row.querySelector('[data-field="body"]');
      if (bodyInput) bodyInput.style.visibility = sel.value === 'notice' ? 'visible' : 'hidden';
    };
    syncBody();
    sel.addEventListener('change', syncBody);
  });

  host.querySelectorAll('.save-f').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const payload = readFieldRow(row);
    if (!payload.label) return toast('라벨을 입력해주세요.', 'error');
    const body = payload.body;
    delete payload.body;
    payload.options = payload.type === 'notice' && body ? { body } : null;
    try {
      await api(`/api/admin/form-fields/${b.dataset.id}`, { method: 'PUT', body: payload });
      toast('저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  host.querySelectorAll('.del-f').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('필드를 삭제하면 이전 답변은 orphan 됩니다. 계속할까요?')) return;
    try {
      await api(`/api/admin/form-fields/${b.dataset.id}`, { method: 'DELETE' });
      await renderFieldsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  }));
  host.querySelector('.add-f')?.addEventListener('click', async () => {
    const row = host.querySelector('tr.new-row');
    const payload = readFieldRow(row);
    if (!payload.label) return toast('라벨을 입력해주세요.', 'error');
    const body = payload.body;
    delete payload.body;
    payload.options = payload.type === 'notice' && body ? { body } : null;
    try {
      await api('/api/admin/form-fields', { method: 'POST', body: payload });
      await renderFieldsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function renderFieldRow(f) {
  const body = (f.type === 'notice' && f.options?.body) ? f.options.body : '';
  return `
    <tr>
      <td><input type="number" value="${f.displayOrder}" data-field="displayOrder" style="width:30px;"></td>
      <td>
        <select data-field="type">
          ${['text', 'textarea', 'checkbox', 'notice'].map((t) => `<option ${t === f.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" value="${escapeAttr(f.label)}" data-field="label" style="min-width:120px;"></td>
      <td style="text-align:center;"><input type="checkbox" ${f.required ? 'checked' : ''} data-field="required"></td>
      <td><input type="text" value="${escapeAttr(body)}" data-field="body" placeholder="notice 타입일 때 표시" style="min-width:150px;"></td>
      <td style="text-align:center;">
        <div class="row" style="gap:6px;justify-content:center;">
          <button class="btn secondary save-f" data-id="${f.id}" style="padding:2px 8px;font-size:11px;">저장</button>
          <button class="btn danger del-f" data-id="${f.id}" style="padding:2px 8px;font-size:11px;">삭제</button>
        </div>
      </td>
    </tr>
  `;
}

function renderNewFieldRow() {
  return `
    <tr class="new-row">
      <td><input type="number" value="0" data-field="displayOrder" style="width:30px;"></td>
      <td>
        <select data-field="type">
          <option>text</option><option>textarea</option><option>checkbox</option><option>notice</option>
        </select>
      </td>
      <td><input type="text" data-field="label" placeholder="새 필드 라벨" style="min-width:120px;"></td>
      <td style="text-align:center;"><input type="checkbox" data-field="required"></td>
      <td><input type="text" data-field="body" placeholder="notice 타입일 때 표시" style="min-width:150px;"></td>
      <td style="text-align:center;"><button class="btn add-f" style="padding:2px 8px;font-size:11px;">추가</button></td>
    </tr>
  `;
}

function readFieldRow(row) {
  const out = {};
  row.querySelectorAll('[data-field]').forEach((el) => {
    const key = el.dataset.field;
    if (el.type === 'checkbox') out[key] = el.checked;
    else if (el.type === 'number') out[key] = Number(el.value);
    else out[key] = el.value;
  });
  return out;
}

async function renderQuotesAdmin() {
  const host = document.getElementById('quotes-panel');
  const [{ quotes, users: allUsers }, { fields }] = await Promise.all([
    api('/api/admin/quotes'),
    api('/api/form-fields'),
  ]);
  const fieldMap = new Map(fields.map((f) => [f.id, f]));

  const users = allUsers.sort((a, b) => a.email.localeCompare(b.email));

  host.innerHTML = `
    <h2>견적 접수 내역 <span class="muted small">(${quotes.length}건)</span></h2>
    <div class="filter-row">
      <input type="search" id="q-search" placeholder="검색 (이름 / 전화 / 이메일 / ID)">
      <select id="q-user">
        <option value="">모든 사용자</option>
        ${users.map((u) => `<option value="${escapeAttr(u.email)}">${u.name ? escapeHtml(u.name) + ' ' : ''}(${escapeHtml(u.email)})</option>`).join('')}
      </select>
    </div>
    <div id="quote-list"></div>
  `;

  const listEl = document.getElementById('quote-list');
  const searchEl = document.getElementById('q-search');
  const userEl = document.getElementById('q-user');

  function applyFilters() {
    const qs = searchEl.value.trim().toLowerCase();
    const u = userEl.value;
    const filtered = quotes.filter((q) => {
      if (u && q.userEmail !== u) return false;
      if (!qs) return true;
      const hay = `${q.name} ${q.phone} ${q.userEmail} ${q.userName} ${q.id}`.toLowerCase();
      return hay.includes(qs);
    });
    listEl.innerHTML = filtered.length === 0
      ? '<p class="muted small">조건에 맞는 견적이 없습니다.</p>'
      : filtered.map((q) => renderAdminQuote(q, fieldMap)).join('');
    for (const q of filtered) wireAdminQuote(q);
    wireWarningBadges(listEl);
  }

  searchEl.addEventListener('input', applyFilters);
  userEl.addEventListener('change', applyFilters);
  applyFilters();
}

function renderAdminQuote(q, fieldMap) {
  const tags = [
    q.deletedAt ? '<span class="tag tag-deleted">삭제</span>' : '',
    q.userWithdrawnAt ? '<span class="tag tag-withdrawn">탈퇴</span>' : '',
  ].join('');
  const answerEntries = Object.entries(q.answers).filter(([, v]) => v && v !== '0');
  const answersHtml = answerEntries.length > 0 ? `
    <div class="quote-answers">
      ${answerEntries.map(([k, v]) => {
        const field = fieldMap.get(k);
        const label = field ? field.label : `#${k.slice(-6)}`;
        const display = field?.type === 'checkbox' ? (v === '1' ? '예' : '아니오') : escapeHtml(v);
        return `<div><span class="qa-label">${escapeHtml(label)}:</span> ${display}</div>`;
      }).join('')}
    </div>
  ` : '';
  return `
    <div class="quote-row">
      <div class="quote-row-header">
        <div>
          <div class="quote-date">${fmtDate(q.createdAt)} <span class="quote-id">#${q.id.slice(-8)}</span>${tags}</div>
          <div class="quote-meta">
            <span>${escapeHtml(q.name)}</span>
            <span>${escapeHtml(q.phone)}</span>
            <span>${q.userName ? escapeHtml(q.userName) + ' ' : ''}(${escapeHtml(q.userEmail)})</span>
            <span>파일 ${q.files.length}개</span>
          </div>
        </div>
        <div class="row" style="gap:6px;">
          ${q.files.length >= 2 ? `<button class="btn accent dl-all-admin" data-qid="${q.id}" style="padding:4px 12px;font-size:12px;">전체 다운로드</button>` : ''}
          <button class="btn danger hard-del-quote" data-qid="${q.id}" style="padding:4px 12px;font-size:12px;">완전 삭제</button>
        </div>
      </div>
      ${answersHtml}
      <div class="file-grid" id="files-${q.id}">
        ${q.files.map((f, i) => renderAdminFileCard(q.id, f, i >= 4 && q.files.length >= 5)).join('')}
      </div>
      ${q.files.length >= 5 ? `<button class="btn ghost show-more-admin" data-qid="${q.id}" style="margin-top:8px;font-size:12px;padding:4px 12px;">+${q.files.length - 4}개 더보기</button>` : ''}
    </div>
  `;
}

function renderAdminFileCard(qid, f, hidden) {
  const clickable = f.hasModel;
  return `
    <div class="file-card ${clickable ? 'clickable' : ''}" data-qid="${qid}" data-fid="${f.id}" ${clickable ? 'title="클릭하여 미리보기"' : ''} ${hidden ? 'style="display:none;" data-extra' : ''}>
      ${renderWarningBadge(f)}
      ${f.thumbUrl ? `<img src="${f.thumbUrl}" alt="${escapeHtml(f.filename)}">` : '<div style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">썸네일 없음</div>'}
      <div class="fname">${escapeHtml(f.filename)}</div>
      <div class="muted" style="font-size:11px;">
        ${fmtBytes(f.sizeBytes)}
        ${f.hasModel ? '' : ' · <span class="error">원본 삭제됨</span>'}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        ${f.hasModel && f.stlUrl ? `<a class="btn accent" href="${f.stlUrl}" download style="padding:2px 8px;font-size:11px;">다운로드</a>` : ''}
        ${f.hasModel ? `<button class="btn danger del-model" data-qid="${qid}" data-fid="${f.id}" style="padding:2px 8px;font-size:11px;">삭제</button>` : ''}
      </div>
    </div>
  `;
}

function wireAdminQuote(q) {
  document.querySelectorAll(`.dl-all-admin[data-qid="${q.id}"]`).forEach((b) => {
    b.addEventListener('click', () => downloadAllFiles(q.files));
  });

  document.querySelector(`.show-more-admin[data-qid="${q.id}"]`)?.addEventListener('click', (e) => {
    const grid = document.getElementById(`files-${q.id}`);
    const extras = grid.querySelectorAll('[data-extra]');
    const collapsed = extras[0]?.style.display === 'none';
    extras.forEach((el) => { el.style.display = collapsed ? '' : 'none'; });
    e.target.textContent = collapsed ? '접기' : `+${extras.length}개 더보기`;
  });

  document.querySelectorAll(`.file-card.clickable[data-qid="${q.id}"]`).forEach((card) => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('.card-actions')) return;
      const fid = card.dataset.fid;
      const f = q.files.find((x) => x.id === fid);
      if (!f || !f.hasModel || !f.stlUrl) return;
      try {
        const viewer = await import('../viewer.js');
        const { host, close } = viewer.openViewerModal();
        host.innerHTML = '<p class="muted small" style="padding:12px;">미리보기 로딩 중...</p>';
        const res = await fetch(f.stlUrl, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${f.filename} 로드 실패`);
        const buf = await res.arrayBuffer();
        await viewer.mountViewer(host, [{ name: f.filename, buffer: buf }], { onClose: close });
      } catch (err) {
        toast(`미리보기 실패: ${err.message || err}`, 'error');
      }
    });
  });

  document.querySelectorAll(`.del-model[data-qid="${q.id}"]`).forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('원본 STL 파일을 삭제합니다 (썸네일은 유지). 계속할까요?')) return;
      try {
        await api(`/api/admin/quotes/${b.dataset.qid}/files/${b.dataset.fid}/model`, { method: 'DELETE' });
        toast('원본 삭제됨', 'success');
        renderQuotesAdmin();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  document.querySelectorAll(`.hard-del-quote[data-qid="${q.id}"]`).forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('이 견적의 DB 기록과 업로드된 모든 파일을 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다. 계속할까요?')) return;
      try {
        await api(`/api/admin/quotes/${b.dataset.qid}`, { method: 'DELETE' });
        toast('견적이 완전히 삭제되었습니다.', 'success');
        renderQuotesAdmin();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

async function downloadAllFiles(files) {
  const available = files.filter((f) => f.hasModel && f.stlUrl);
  if (available.length === 0) return toast('다운로드할 파일이 없습니다.', 'error');
  toast('파일 준비 중...', 'info');
  try {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    const zip = new JSZip();
    for (const f of available) {
      const res = await fetch(f.stlUrl, { credentials: 'same-origin' });
      if (!res.ok) continue;
      zip.file(f.filename, await res.arrayBuffer());
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'files.zip';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(`다운로드 실패: ${err.message}`, 'error');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
