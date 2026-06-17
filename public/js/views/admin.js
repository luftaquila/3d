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
    <section class="panel" id="smslog-panel"></section>
    <section class="panel" id="quotes-panel"></section>
    <section class="panel" id="members-panel"></section>
  `;

  await Promise.all([
    renderSettings(),
    renderSmsLog(),
    renderQuotesAdmin(),
    renderMembers(),
  ]);
}

function renderTemplateEditor(t, vals, opts = {}) {
  return `
    <div class="sms-tpl" data-tpl="${t.id}">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;">
        <strong class="small">${escapeHtml(t.label)}</strong>
        ${opts.withEnable ? `<label class="muted small" style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="tpl-enable" ${opts.enabled ? 'checked' : ''} style="width:auto;"> 제출 시 자동 발송</label>` : ''}
      </div>
      <textarea class="tpl-content" rows="3" style="font-family:var(--font-mono);font-size:13px;margin-top:4px;">${escapeHtml(vals.content)}</textarea>
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;margin-top:4px;">
        <span class="muted small tpl-count"></span>
        <button class="btn tpl-save" style="padding:4px 12px;font-size:12px;">저장</button>
      </div>
    </div>
  `;
}

async function renderSettings() {
  const host = document.getElementById('settings-panel');
  const res = await api('/api/admin/settings');
  const settings = res.settings;
  const caps = res.capabilities || {};
  const cameraOn = settings.camera_enabled === '1';
  const camStatusOn = settings.camera_status_enabled === '1';
  const homeHtml = settings.home_html ?? '';
  const estWall = settings.est_wall_mm ?? '1.0';
  const estInfill = settings.est_infill_pct ?? '15';
  const estPrice = settings.est_price_per_m ?? '500';
  const submitOn = settings.sms_submit_enabled === '1';
  const tplVals = (t) => ({
    content: settings[t.contentKey] || (t.id === 'quote' ? DEFAULT_QUOTE_TEMPLATE : ''),
  });

  host.innerHTML = `
    <details class="collapse-card">
      <summary>설정</summary>
      <div class="collapse-body">
        <label style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="cam-toggle" ${cameraOn ? 'checked' : ''} style="width:auto;">
          카메라 스트림을 메인 페이지에 표시
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin-top:8px;">
          <input type="checkbox" id="cam-status-toggle" ${camStatusOn ? 'checked' : ''} style="width:auto;">
          카메라 아래에 프린터 상태(진행률·레이어·남은 시간) 표시
        </label>

        <label for="home-html" style="margin-top:20px;">메인 페이지 공지 (HTML)</label>
        <p class="muted small" style="margin:4px 0 8px;">비워두면 메인에 공지 영역이 표시되지 않습니다.</p>
        <textarea id="home-html" style="min-height:220px;font-family:var(--font-mono);font-size:13px;">${escapeHtml(homeHtml)}</textarea>
        <div class="row" style="margin-top:10px;"><button class="btn" id="save-home-html">저장</button></div>

        <div class="settings-section">
          <h3>SMS 메시지 프리셋</h3>
          <p class="muted small" style="margin:0 0 10px;">치환자: <code>{amount}</code> 최종 금액, <code>{name}</code> 고객명, <code>{filament}</code> 필라멘트(m), <code>{cost}</code> 비용, <code>{discount}</code> 할인%, <code>{comment}</code> 견적 코멘트, <code>{link}</code> 내 견적 링크, <code>{eta}</code> 예상 완료 시각.</p>
          ${FIXED_TEMPLATES.map((t) => renderTemplateEditor(t, tplVals(t), { withEnable: t.id === 'submit', enabled: submitOn })).join('')}
          <div style="margin-top:18px;">
            <strong class="small">메시지 템플릿</strong>
            <p class="muted small" style="margin:4px 0 8px;">필요한 만큼 추가/삭제하세요. 제목은 발송 드롭다운에 표시됩니다.</p>
            <div id="done-list"></div>
            <div class="row" style="gap:8px;margin-top:10px;">
              <button class="btn secondary" id="done-add" style="padding:4px 12px;font-size:12px;">+ 템플릿 추가</button>
              <button class="btn" id="done-save" style="padding:4px 12px;font-size:12px;">템플릿 저장</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>알림톡 (Biz Message)</h3>
          <p class="muted small" style="margin:0;">${caps.alimtalk
            ? `발신 채널: <code>${escapeHtml(caps.plusFriendId || '(미설정)')}</code> · 템플릿은 <b>NCP 콘솔</b>에서 등록·검수하며 발송 화면에서 자동으로 불러옵니다(승인된 것만 발송). 본문 변수 <code>{name}</code>/<code>{amount}</code>/<code>{filament}</code>/<code>{cost}</code>/<code>{discount}</code>/<code>{comment}</code>는 발송 시 견적값으로 치환됩니다.`
            : '알림톡 미설정 — 서버 env(BIZ_MESSAGE_SERVICE_ID·KAKAO_PLUS_FRIEND_ID) + SENS 키가 필요합니다.'}</p>
        </div>

        <div class="settings-section">
          <h3>필라멘트 추정 보정</h3>
          <p class="muted small" style="margin:0 0 10px;">표면적 기반 추정 파라미터입니다. 알려진 슬라이서 결과(g·m)와 맞도록 조정하세요. (밀도 1.24 g/cm³·필라멘트 1.75mm 고정)</p>
          <div class="quote-calc-grid">
            <label>벽 두께 (mm)<input type="number" step="0.1" min="0" id="est-wall" value="${escapeAttr(estWall)}"></label>
            <label>충전율 (%)<input type="number" step="1" min="0" id="est-infill" value="${escapeAttr(estInfill)}"></label>
            <label>단가 (원/m)<input type="number" step="1" min="0" id="est-price" value="${escapeAttr(estPrice)}"></label>
          </div>
          <div class="row" style="margin-top:10px;"><button class="btn" id="save-estimate">저장</button></div>
        </div>

        <div class="settings-section">
          <h3>견적 폼 필드</h3>
          <div id="fields-section"></div>
        </div>

        <div class="settings-section">
          <h3>누락 정보 일괄 갱신</h3>
          <p class="muted small" style="margin:0 0 10px;">이전에 업로드되어 썸네일·watertight·부피 정보가 없는 파일을 브라우저에서 재계산해 서버에 업데이트합니다.</p>
          <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;">
            <button class="btn" id="backfill-start">시작</button>
            <label class="muted small" style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal;">
              <input type="checkbox" id="backfill-force" style="width:auto;">기존 썸네일도 다시 생성 (방향 보정)
            </label>
            <span class="muted small" id="backfill-status"></span>
          </div>
        </div>
      </div>
    </details>
  `;

  document.getElementById('cam-toggle').addEventListener('change', async (e) => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { camera_enabled: e.target.checked ? '1' : '0' } });
      toast('설정 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('cam-status-toggle').addEventListener('change', async (e) => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { camera_status_enabled: e.target.checked ? '1' : '0' } });
      toast('설정 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('save-home-html').addEventListener('click', async () => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { home_html: document.getElementById('home-html').value } });
      toast('공지 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('save-estimate').addEventListener('click', async () => {
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: {
          est_wall_mm: document.getElementById('est-wall').value,
          est_infill_pct: document.getElementById('est-infill').value,
          est_price_per_m: document.getElementById('est-price').value,
        },
      });
      toast('추정 파라미터 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  // SMS 템플릿 에디터들 (제목 + 본문 + 카운터 + 저장; 견적 접수는 on/off 포함)
  host.querySelectorAll('.sms-tpl').forEach((el) => {
    const t = FIXED_TEMPLATES.find((x) => x.id === el.dataset.tpl);
    if (!t) return;
    const contentEl = el.querySelector('.tpl-content');
    const countEl = el.querySelector('.tpl-count');
    const enableEl = el.querySelector('.tpl-enable');
    const upd = () => { countEl.textContent = smsCountLabel(contentEl.value); };
    upd();
    contentEl.addEventListener('input', upd);
    el.querySelector('.tpl-save').addEventListener('click', async () => {
      const body = { [t.contentKey]: contentEl.value };
      if (enableEl && t.enableKey) body[t.enableKey] = enableEl.checked ? '1' : '0';
      try {
        await api('/api/admin/settings', { method: 'PUT', body });
        toast(`${t.label} 저장됨`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // 메시지 템플릿: free-form add/delete list, saved as JSON to sms_done_list.
  let doneItems = parseDoneList(settings);
  const doneListEl = document.getElementById('done-list');
  function renderDoneRows() {
    doneListEl.innerHTML = doneItems.length
      ? doneItems.map(renderDoneRow).join('')
      : '<p class="muted small">템플릿이 없습니다. "+ 템플릿 추가"로 만드세요.</p>';
    [...doneListEl.querySelectorAll('.done-row')].forEach((row, idx) => {
      const contentEl = row.querySelector('.done-content');
      const titleEl = row.querySelector('.done-title');
      const countEl = row.querySelector('.done-count');
      const upd = () => { countEl.textContent = smsCountLabel(contentEl.value); };
      upd();
      contentEl.addEventListener('input', () => { doneItems[idx].content = contentEl.value; upd(); });
      titleEl.addEventListener('input', () => { doneItems[idx].title = titleEl.value; });
      row.querySelector('.done-del').addEventListener('click', () => { doneItems.splice(idx, 1); renderDoneRows(); });
    });
  }
  renderDoneRows();
  document.getElementById('done-add').addEventListener('click', () => {
    doneItems.push({ title: '', content: '' });
    renderDoneRows();
  });
  document.getElementById('done-save').addEventListener('click', async () => {
    const list = doneItems.filter((it) => (it.content || '').trim());
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { sms_done_list: JSON.stringify(list) } });
      doneItems = list;
      renderDoneRows();
      toast('메시지 템플릿 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('backfill-start').addEventListener('click', runBackfill);
  renderFieldsAdmin();
}

function renderDoneRow(item) {
  return `
    <div class="done-row">
      <input type="text" class="done-title" placeholder="제목 (예: 일반 / 지연)" value="${escapeAttr(item.title)}" style="width:100%;">
      <textarea class="done-content" rows="3" style="font-family:var(--font-mono);font-size:13px;margin-top:4px;">${escapeHtml(item.content)}</textarea>
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;margin-top:4px;">
        <span class="muted small done-count"></span>
        <button class="btn danger done-del" style="padding:2px 10px;font-size:11px;">삭제</button>
      </div>
    </div>
  `;
}

async function renderSmsLog() {
  const host = document.getElementById('smslog-panel');
  host.innerHTML = `
    <details class="collapse-card">
      <summary>메시지 전송 내역 및 통계</summary>
      <div class="collapse-body" id="smslog-body"><p class="muted small">불러오는 중…</p></div>
    </details>
  `;
  await loadSmsLog();
}

async function loadSmsLog() {
  const body = document.getElementById('smslog-body');
  if (!body) return;
  try {
    const { stats, entries } = await api('/api/admin/sms-log');
    body.innerHTML = `
      <div class="row" style="gap:16px;align-items:center;margin-bottom:10px;">
        <span>총 <strong>${stats.total}</strong></span>
        <span class="success">성공 <strong>${stats.ok}</strong></span>
        <span class="error">실패 <strong>${stats.fail}</strong></span>
        <button class="btn ghost" id="smslog-refresh" style="padding:2px 10px;font-size:11px;">새로고침</button>
      </div>
      ${entries.length === 0 ? '<p class="muted small">전송 내역이 없습니다.</p>' : `
        <div style="overflow-x:auto;">
          <table class="admin-table smslog-table">
            <thead><tr><th>시각</th><th>유형</th><th>결과</th><th>접수자</th><th>번호</th><th>견적#</th><th>본문</th></tr></thead>
            <tbody>${entries.map(renderSmsLogRow).join('')}</tbody>
          </table>
        </div>`}
    `;
    document.getElementById('smslog-refresh')?.addEventListener('click', loadSmsLog);
  } catch (err) {
    body.innerHTML = `<p class="error small">불러오기 실패: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

function renderSmsLogRow(e) {
  return `
    <tr>
      <td style="white-space:nowrap;">${fmtDate(e.createdAt)}</td>
      <td>${escapeHtml(e.msgType || '')}</td>
      <td>${e.ok ? '<span class="success">성공</span>' : '<span class="error">실패</span>'}</td>
      <td>${escapeHtml(e.name || '')}</td>
      <td style="white-space:nowrap;">${escapeHtml(e.phone || '')}</td>
      <td>${e.quoteId ? '#' + escapeHtml(String(e.quoteId).slice(-8)) : ''}</td>
      <td style="white-space:pre-wrap;max-width:280px;">${escapeHtml(e.content || '')}</td>
    </tr>
  `;
}

async function renderMembers() {
  const host = document.getElementById('members-panel');
  host.innerHTML = `
    <details class="collapse-card">
      <summary>회원 목록</summary>
      <div class="collapse-body" id="members-body"><p class="muted small">불러오는 중…</p></div>
    </details>
  `;
  const body = document.getElementById('members-body');
  try {
    const { members } = await api('/api/admin/members');
    body.innerHTML = members.length === 0 ? '<p class="muted small">회원이 없습니다.</p>' : `
      <div style="overflow-x:auto;">
        <table class="admin-table">
          <thead><tr><th>이름</th><th>이메일</th><th>가입일</th><th>견적 수</th><th>매출</th><th>상태</th></tr></thead>
          <tbody>${members.map(renderMemberRow).join('')}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="error small">불러오기 실패: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

function renderMemberRow(m) {
  return `
    <tr>
      <td>${escapeHtml(m.name || '')}</td>
      <td>${escapeHtml(m.email || '')}</td>
      <td style="white-space:nowrap;">${fmtDate(m.createdAt)}</td>
      <td>${m.quoteCount}</td>
      <td style="white-space:nowrap;">${Number(m.revenue || 0).toLocaleString('ko-KR')}원</td>
      <td>${m.withdrawn ? '<span class="tag tag-withdrawn">탈퇴</span>' : '<span class="success">활성</span>'}</td>
    </tr>
  `;
}

async function runBackfill() {
  const button = document.getElementById('backfill-start');
  const status = document.getElementById('backfill-status');
  const force = !!document.getElementById('backfill-force')?.checked;
  button.disabled = true;
  status.textContent = '대상 조회 중...';
  try {
    const all = await api(`/api/admin/backfill/list${force ? '?all=1' : ''}`);
    const files = all.files || [];
    if (files.length === 0) {
      status.textContent = '업데이트할 파일이 없습니다.';
      button.disabled = false;
      return;
    }
    if (force && !confirm(`기존 썸네일 포함 ${files.length}개를 다시 생성합니다. 모델을 모두 내려받아 재계산하므로 시간이 걸릴 수 있어요. 계속할까요?`)) {
      status.textContent = '';
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
  if (!res.ok) throw new Error(`model fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const { dataUrl, isWatertight, boundaryEdges, nonManifoldEdges, volume, surfaceArea } = await generateThumbnail(buf, f.filename);

  const form = new FormData();
  if (f.missingThumb) {
    form.append('thumb', dataUrlToBlob(dataUrl), `${f.filename}.png`);
  }
  if (f.missingWatertight || f.missingVolume || f.missingSurface) {
    const meta = {};
    if (f.missingWatertight) {
      meta.isWatertight = isWatertight;
      meta.boundaryEdges = boundaryEdges;
      meta.nonManifoldEdges = nonManifoldEdges;
    }
    if (f.missingVolume && Number.isFinite(volume)) meta.volume = volume;
    if (f.missingSurface && Number.isFinite(surfaceArea)) meta.surfaceArea = surfaceArea;
    form.append('watertight', JSON.stringify(meta));
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
  const host = document.getElementById('fields-section');
  if (!host) return;
  const { fields } = await api('/api/admin/form-fields');
  host.innerHTML = `
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
  const [{ quotes, users: allUsers }, { fields }, settingsRes, alimRes] = await Promise.all([
    api('/api/admin/quotes'),
    api('/api/form-fields'),
    api('/api/admin/settings'),
    api('/api/admin/alimtalk-templates').catch(() => ({ configured: false, templates: [] })),
  ]);
  const { settings } = settingsRes;
  alimtalkAvailable = !!(alimRes && alimRes.configured);
  loadSmsTemplates(settings);
  loadAlimTemplates(alimRes && alimRes.templates);
  smsSubmitEnabled = settings.sms_submit_enabled === '1';
  estPricePerM = Number(settings.est_price_per_m) || 500;
  const fieldMap = new Map(fields.map((f) => [f.id, f]));

  const users = allUsers.sort((a, b) => a.email.localeCompare(b.email));

  host.innerHTML = `
    <details class="collapse-card" open>
      <summary>견적 접수 내역 <span class="muted small">(${quotes.length}건)</span></summary>
      <div class="collapse-body">
        <div class="filter-row">
          <input type="search" id="q-search" placeholder="검색 (이름 / 전화 / 이메일 / ID)">
          <select id="q-user">
            <option value="">모든 사용자</option>
            ${users.map((u) => `<option value="${escapeAttr(u.email)}">${u.name ? escapeHtml(u.name) + ' ' : ''}(${escapeHtml(u.email)})</option>`).join('')}
          </select>
        </div>
        <div id="quote-list"></div>
      </div>
    </details>
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
    q.isFirst ? '<span class="tag tag-first">첫 견적</span>' : '',
    (q.userEmail && q.userEmail.toLowerCase().endsWith('ac.kr')) ? '<span class="tag tag-student">학생</span>' : '',
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
        <div style="flex:1;min-width:0;">
          <div class="quote-date" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="display:inline-flex;align-items:center;flex-wrap:wrap;gap:8px;">
              <span>${fmtDate(q.createdAt)}</span>
              <span class="quote-id">#${q.id.slice(-8)}</span>
              ${tags}
            </span>
            <button class="btn danger hard-del-quote" data-qid="${q.id}" style="padding:4px 12px;font-size:12px;">완전 삭제</button>
          </div>
          <div class="quote-meta">
            <span>${escapeHtml(q.name)}</span>
            <span>${escapeHtml(q.phone)}</span>
            <span>${q.userName ? escapeHtml(q.userName) + ' ' : ''}(${escapeHtml(q.userEmail)})</span>
            <span>파일 ${q.files.length}개</span>
          </div>
        </div>
      </div>
      ${answersHtml}
      <div class="file-grid" id="files-${q.id}">
        ${q.files.map((f, i) => renderAdminFileCard(q.id, f, i >= 4 && q.files.length >= 5)).join('')}
      </div>
      ${(q.files.length >= 5 || q.files.length >= 2) ? `<div class="row" style="gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap;">
        ${q.files.length >= 5 ? `<button class="btn ghost show-more-admin" data-qid="${q.id}" style="font-size:12px;padding:4px 12px;">+${q.files.length - 4}개 더보기</button>` : ''}
        ${q.files.length >= 2 ? `<button class="btn accent dl-all-admin" data-qid="${q.id}" style="padding:4px 12px;font-size:12px;">전체 다운로드</button>` : ''}
      </div>` : ''}
      ${renderQuoteCalc(q)}
    </div>
  `;
}

function numVal(v) { return v === null || v === undefined ? '' : v; }

function renderQuoteCalc(q) {
  return `
    <div class="quote-calc" data-qid="${q.id}">
      <div class="quote-calc-grid">
        <label>필라멘트 (m)<input type="number" step="0.01" min="0" data-calc="filamentM" value="${numVal(q.filamentM)}"></label>
        <label>비용 (원)<input type="number" step="1" min="0" data-calc="cost" value="${numVal(q.cost)}"></label>
        <label>할인 (%)<input type="number" step="1" min="0" max="100" data-calc="discount" value="${q.discount ?? 0}"></label>
        <label>최종 비용 (원)<input type="number" step="1" min="0" data-calc="finalCost" value="${numVal(q.finalCost)}"></label>
      </div>
      <label class="quote-calc-comment">코멘트<textarea data-calc="comment" rows="2">${escapeHtml(q.comment ?? '')}</textarea></label>
      <div class="row" style="justify-content:flex-end;">
        <button class="btn accent calc-save" data-qid="${q.id}" style="padding:4px 12px;font-size:12px;">견적 저장</button>
      </div>
      <div class="quote-sms">
        <div class="row" style="justify-content:space-between;align-items:center;gap:8px;">
          <strong class="small">메시지 발송</strong>
          <div class="row" style="gap:6px;align-items:center;max-width:70%;">
            <select class="sms-channel" data-qid="${q.id}"></select>
            <select class="sms-tpl-select" data-qid="${q.id}"></select>
          </div>
        </div>
        <textarea class="sms-text" data-qid="${q.id}" rows="5" placeholder="고객에게 보낼 내용" style="margin-top:4px;"></textarea>
        <div class="row" style="justify-content:space-between;align-items:center;gap:8px;">
          <span class="muted small sms-count" data-qid="${q.id}"></span>
          <button class="btn accent sms-send" data-qid="${q.id}" style="padding:4px 12px;font-size:12px;">전송</button>
        </div>
      </div>
    </div>
  `;
}

function renderAdminFileCard(qid, f, hidden) {
  const clickable = f.hasModel && /\.(stl|3mf)$/i.test(f.filename);
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

  wireQuoteCalc(q);
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

// SMS/LMS byte rule: ASCII 1 byte, everything else (Korean etc.) 2 bytes.
function smsByteLength(str) {
  let bytes = 0;
  for (const ch of String(str)) bytes += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return bytes;
}
function fmtWon(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '';
}
function hasNum(v) {
  return v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
}

// SMS message templates (subject + content), stored in settings. The source
// defaults are intentionally generic — real wording/accounts live only in the DB.
// Placeholders (applied to both subject and content): {amount} final/cost in won,
// {name} customer, {link} the /my page.
const FIXED_TEMPLATES = [
  { id: 'submit', label: '견적 접수', contentKey: 'sms_submit_template', enableKey: 'sms_submit_enabled' },
  { id: 'quote', label: '견적 안내', contentKey: 'sms_template' },
];
const DEFAULT_QUOTE_TEMPLATE = '견적: {amount}원\n상세: {link}';
let smsTemplates = {};        // id -> { label, content }
let smsTemplateOrder = [];    // ordered ids for the send dropdown
let smsSubmitEnabled = false; // when auto-send is on, hide 견적 접수 from the manual dropdown
let estPricePerM = 500;       // filament price per meter; loaded from settings
let printEtaText = '';        // in-progress print ETA "DD일 HH:MM" (24h) for {eta}; '' when idle
let alimtalkAvailable = false; // AlimTalk (Biz Message) configured server-side
let alimTemplates = {};        // id -> { label, content, code } — AlimTalk set (separate from SMS)
let alimTemplateOrder = [];

// Message templates are a free-form list (title + content) stored as JSON in
// settings.sms_done_list. Falls back to migrating the legacy fixed slots.
function parseDoneList(settings) {
  try {
    const arr = JSON.parse(settings.sms_done_list || '[]');
    if (Array.isArray(arr)) return arr.map((x) => ({ title: String(x?.title || ''), content: String(x?.content || '') }));
  } catch { /* fall through to legacy migration */ }
  const legacy = [];
  for (let i = 1; i <= 3; i++) {
    const c = settings[`sms_done${i}_template`];
    if (c && c.trim()) legacy.push({ title: `메시지 ${i}`, content: c });
  }
  return legacy;
}

function loadSmsTemplates(settings) {
  smsTemplates = {};
  smsTemplateOrder = [];
  for (const t of FIXED_TEMPLATES) {
    const content = settings[t.contentKey] || (t.id === 'quote' ? DEFAULT_QUOTE_TEMPLATE : '');
    smsTemplates[t.id] = { label: t.label, content };
    smsTemplateOrder.push(t.id);
  }
  parseDoneList(settings).forEach((d, i) => {
    const id = `done${i}`;
    smsTemplates[id] = { label: d.title || `메시지 ${i + 1}`, content: d.content };
    smsTemplateOrder.push(id);
  });
}

// AlimTalk set pulled live from NCP (/api/admin/alimtalk-templates). Content
// uses #{var}; normalize to {var} so substitutePlaceholders fills it. Non-
// approved templates are listed (labelled) but blocked at send.
function loadAlimTemplates(list) {
  alimTemplates = {};
  alimTemplateOrder = [];
  const STAT = { REGISTER: '작성중', REQUEST: '검수요청', ACCEPT: '검수대기', INSPECT: '검수중', REJECT: '반려' };
  (Array.isArray(list) ? list : []).forEach((t, i) => {
    if (!t?.code) return;
    const id = `at${i}`;
    alimTemplates[id] = {
      label: t.approved ? t.name : `${t.name} (${STAT[t.inspectionStatus] || '미승인'})`,
      content: String(t.content || '').replace(/#\{/g, '{'),
      code: t.code,
      buttons: Array.isArray(t.buttons) ? t.buttons : [],
      approved: !!t.approved,
    };
    alimTemplateOrder.push(id);
  });
}

// {eta} fills the in-progress print's estimated finish time as an absolute
// wall-clock; '' when no print is running. Refreshed when a template with {eta}
// is selected (see refreshPrintEta). Format: "DD일 HH:MM" (24-hour, local/KST).
function formatEta(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${day}일 ${hh}:${mm}`;
}
function computeEtaText(status) {
  if (!status?.enabled || !status.available) return '';
  const rem = status.remainingMin;
  if (!Number.isFinite(rem) || rem <= 0) return '';
  return formatEta(new Date(Date.now() + rem * 60000));
}

// Re-read the live ETA when a template containing {eta} is selected, so the
// inserted finish time reflects the printer's current estimate at that moment
// (not page-load time). No-op for templates without {eta}.
async function refreshPrintEta(content) {
  if (!String(content || '').includes('{eta}')) return;
  try {
    printEtaText = computeEtaText(await api('/api/camera/print-status'));
  } catch { /* keep previous value */ }
}

function substitutePlaceholders(text, d) {
  const amount = hasNum(d.finalCost) ? Number(d.finalCost) : (hasNum(d.cost) ? Number(d.cost) : null);
  return String(text || '')
    .split('{amount}').join(amount != null ? fmtWon(amount) : '')
    .split('{name}').join(d.name || '')
    .split('{link}').join(`${location.origin}/my`)
    .split('{comment}').join(d.comment || '')
    .split('{filament}').join(hasNum(d.filamentM) ? String(d.filamentM) : '')
    .split('{cost}').join(hasNum(d.cost) ? fmtWon(Number(d.cost)) : '')
    .split('{discount}').join(hasNum(d.discount) ? String(d.discount) : '')
    .split('{eta}').join(printEtaText);
}

function readCalcInputs(calcEl) {
  const out = {};
  calcEl.querySelectorAll('[data-calc]').forEach((el) => { out[el.dataset.calc] = el.value; });
  return out;
}

function smsCountLabel(value) {
  const bytes = smsByteLength(value);
  return `${bytes} B · ${value.length}자 · ${bytes <= 90 ? 'SMS' : 'LMS'}`;
}

function wireQuoteCalc(q) {
  const calcEl = document.querySelector(`.quote-calc[data-qid="${q.id}"]`);
  if (!calcEl) return;

  const smsText = calcEl.querySelector('.sms-text');
  const channelEl = calcEl.querySelector('.sms-channel');
  const selectEl = calcEl.querySelector('.sms-tpl-select');
  const mEl = calcEl.querySelector('[data-calc="filamentM"]');
  const costEl = calcEl.querySelector('[data-calc="cost"]');
  const discountEl = calcEl.querySelector('[data-calc="discount"]');
  const finalEl = calcEl.querySelector('[data-calc="finalCost"]');
  const floor100 = (n) => Math.max(0, Math.floor(n / 100) * 100);

  // Channel selector: 문자 always; 알림톡 only when Biz Message is configured and
  // at least one approved template is registered. SMS and AlimTalk are separate
  // template sets.
  let channel = 'sms';
  let selectedId = null;
  const channelOpts = [{ v: 'sms', label: '문자' }];
  if (alimtalkAvailable && alimTemplateOrder.length) channelOpts.push({ v: 'alimtalk', label: '알림톡' });
  channelEl.innerHTML = channelOpts.map((c) => `<option value="${c.v}">${c.label}</option>`).join('');
  channelEl.style.display = channelOpts.length > 1 ? '' : 'none';

  const currentSet = () => (channel === 'alimtalk'
    ? { map: alimTemplates, order: alimTemplateOrder }
    : { map: smsTemplates, order: smsTemplateOrder });
  // Populate the template dropdown for the active channel. 견적 접수 is hidden
  // while SMS auto-send is on. Defaults to 견적 안내 when present.
  function populateTemplates() {
    const { map, order } = currentSet();
    const available = order.filter((id) => {
      if (id === 'submit' && smsSubmitEnabled) return false;
      return (map[id]?.content || '').trim();
    });
    selectEl.innerHTML = available.map((id) => `<option value="${id}">${escapeHtml(map[id].label)}</option>`).join('');
    selectedId = available.includes('quote') ? 'quote' : (available[0] || null);
    if (selectedId) selectEl.value = selectedId;
    selectEl.style.display = available.length ? '' : 'none';
  }
  populateTemplates();

  // Pre-rounding cost basis. Filament m sets it to m×단가; a manual cost edit
  // sets it to the typed cost. Final = floor100(basis × (1 − discount%)).
  let rawBasis = hasNum(costEl.value) ? Number(costEl.value)
    : (hasNum(mEl.value) ? Number(mEl.value) * estPricePerM : null);

  // Counter: AlimTalk shows a char count; SMS shows the byte/SMS-LMS label.
  function refreshCount() {
    // AlimTalk body must match the approved template — show it read-only.
    smsText.readOnly = (channel === 'alimtalk');
    const countEl = calcEl.querySelector('.sms-count');
    if (!countEl) return;
    countEl.textContent = channel === 'alimtalk'
      ? `${smsText.value.length}자 · 알림톡`
      : smsCountLabel(smsText.value);
  }

  // Body reflects the selected template, substituted with calc values.
  function refreshSms() {
    const tpl = selectedId ? currentSet().map[selectedId] : null;
    if (tpl) {
      smsText.value = substitutePlaceholders(tpl.content, { name: q.name, ...readCalcInputs(calcEl) });
    }
    refreshCount();
  }
  channelEl.addEventListener('change', async () => {
    channel = channelEl.value;
    populateTemplates();
    await refreshPrintEta(selectedId ? currentSet().map[selectedId]?.content : '');
    refreshSms();
  });
  selectEl.addEventListener('change', async () => {
    selectedId = selectEl.value;
    await refreshPrintEta(currentSet().map[selectedId]?.content);
    refreshSms();
  });
  function applyFinal() {
    if (rawBasis != null) {
      const pct = hasNum(discountEl.value) ? Number(discountEl.value) : 0;
      finalEl.value = String(floor100(rawBasis * (1 - pct / 100)));
    }
    refreshSms();
  }

  // 필라멘트 m 입력 → 비용·최종 자동
  mEl.addEventListener('input', () => {
    rawBasis = hasNum(mEl.value) ? Number(mEl.value) * estPricePerM : null;
    if (rawBasis != null) costEl.value = String(floor100(rawBasis));
    applyFinal();
  });
  // 비용 편집 → 최종 자동 (할인 적용)
  costEl.addEventListener('input', () => {
    rawBasis = hasNum(costEl.value) ? Number(costEl.value) : null;
    applyFinal();
  });
  // 할인율 편집 → 최종 자동
  discountEl.addEventListener('input', applyFinal);
  finalEl.addEventListener('input', refreshSms);
  smsText.addEventListener('input', refreshCount);

  refreshSms(); // initial SMS body from rendered values (don't overwrite stored final)

  calcEl.querySelector('.calc-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api(`/api/admin/quotes/${q.id}`, { method: 'PATCH', body: readCalcInputs(calcEl) });
      toast('견적이 저장되었습니다.', 'success');
    } catch (err) {
      toast(`저장 실패: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  calcEl.querySelector('.sms-send')?.addEventListener('click', async (e) => {
    const tpl = selectedId ? currentSet().map[selectedId] : null;
    const message = smsText.value.trim();
    if (!message) return toast('메시지를 입력해주세요.', 'error');
    if (channel === 'alimtalk' && !(tpl && tpl.code)) return toast('알림톡 템플릿을 선택해주세요.', 'error');
    if (channel === 'alimtalk' && tpl && !tpl.approved) return toast('아직 검수/승인되지 않은 템플릿입니다.', 'error');
    const channelLabel = channel === 'alimtalk' ? '알림톡' : '문자';
    if (!confirm(`${q.phone} 번호로 ${channelLabel}을(를) 전송합니다. 계속할까요?`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api(`/api/admin/quotes/${q.id}/send-sms`, {
        method: 'POST',
        body: {
          message,
          kind: tpl ? tpl.label : '수동',
          channel,
          ...(channel === 'alimtalk' ? { templateCode: tpl.code } : {}),
        },
      });
      toast(`${channelLabel}을(를) 전송했습니다.`, 'success');
    } catch (err) {
      toast(`전송 실패: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
