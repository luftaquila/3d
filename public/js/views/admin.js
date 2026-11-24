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
  const channel = settings.message_channel === 'alimtalk' ? 'alimtalk' : 'sms';
  const tplVals = (t) => ({
    content: settings[t.contentKey] || (t.id === 'quote' ? DEFAULT_QUOTE_TEMPLATE : ''),
  });
  // For the AlimTalk auto-submit picker: pull the channel's approved templates.
  let alimSubmitOpts = '';
  if (caps.alimtalk && channel === 'alimtalk') {
    try {
      const alimTpls = (await api('/api/admin/alimtalk-templates'))?.templates || [];
      alimSubmitOpts = alimTpls.filter((t) => t.approved).map((t) =>
        `<option value="${escapeAttr(t.code)}" ${settings.alimtalk_submit_code === t.code ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
      ).join('');
    } catch { /* NCP 일시 오류 — 선택지 비움 */ }
  }

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
          <h3>메시지 발송</h3>
          <p class="muted small" style="margin:0 0 10px;">고객 알림(견적 접수·안내)의 기본 발송 방식입니다. 견적건별 발송 시 이 방식이 기본 선택되며, 견적 접수 자동 발송도 이 방식으로 나갑니다.</p>
          <div class="row" style="gap:18px;align-items:center;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;margin:0;">
              <input type="radio" name="msg-channel" value="sms" ${channel === 'sms' ? 'checked' : ''} style="width:auto;"> 문자
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;margin:0;${caps.alimtalk ? '' : 'opacity:0.55;'}">
              <input type="radio" name="msg-channel" value="alimtalk" ${channel === 'alimtalk' ? 'checked' : ''} ${caps.alimtalk ? '' : 'disabled'} style="width:auto;"> 알림톡${caps.alimtalk ? '' : ' <span class="muted">(미설정)</span>'}
            </label>
          </div>

          <label style="display:flex;align-items:center;gap:8px;margin-top:14px;">
            <input type="checkbox" id="submit-auto-toggle" ${submitOn ? 'checked' : ''} style="width:auto;">
            견적 접수 시 고객에게 자동 발송
          </label>
          ${channel === 'alimtalk' ? `
            <label for="alim-submit-code" style="margin-top:12px;">접수 자동 발송 알림톡 템플릿</label>
            <p class="muted small" style="margin:4px 0 6px;">자동 발송에 사용할 승인된 템플릿을 선택하세요. 접수 시점엔 견적값이 없으므로 본문 변수는 <code>{name}</code>(고객명)만 채워집니다.</p>
            <select id="alim-submit-code">
              <option value="">— 선택 안 함 —</option>
              ${alimSubmitOpts}
            </select>
          ` : ''}

          <details class="sub-collapse" style="margin-top:16px;">
            <summary>메시지 템플릿</summary>
            <div style="margin-top:12px;">
              ${channel === 'alimtalk'
                ? `<p class="muted small" style="margin:0;">발신 채널: <code>${escapeHtml(caps.plusFriendId || '(미설정)')}</code> · 알림톡 템플릿은 <b>NCP 콘솔</b>에서 등록·검수하며 발송 화면에서 자동으로 불러옵니다(승인된 것만 발송). 본문 변수 <code>{name}</code>/<code>{amount}</code>/<code>{filament}</code>/<code>{cost}</code>/<code>{discount}</code>/<code>{comment}</code>는 발송 시 견적값으로 치환됩니다.</p>`
                : `
                  <p class="muted small" style="margin:0 0 10px;">치환자: <code>{amount}</code> 최종 금액, <code>{name}</code> 고객명, <code>{filament}</code> 필라멘트(m), <code>{cost}</code> 비용, <code>{discount}</code> 할인%, <code>{comment}</code> 견적 코멘트, <code>{link}</code> 내 견적 링크, <code>{eta}</code> 예상 완료 시각.</p>
                  ${FIXED_TEMPLATES.map((t) => renderTemplateEditor(t, tplVals(t))).join('')}
                  <div style="margin-top:18px;">
                    <strong class="small">추가 메시지 템플릿</strong>
                    <p class="muted small" style="margin:4px 0 8px;">필요한 만큼 추가/삭제하세요. 제목은 발송 드롭다운에 표시됩니다.</p>
                    <div id="done-list"></div>
                    <div class="row" style="gap:8px;margin-top:10px;">
                      <button class="btn secondary" id="done-add" style="padding:4px 12px;font-size:12px;">+ 템플릿 추가</button>
                      <button class="btn" id="done-save" style="padding:4px 12px;font-size:12px;">템플릿 저장</button>
                    </div>
                  </div>
                `}
            </div>
          </details>
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

  // 시스템 기본 발송 방식(문자/알림톡). 변경 시 템플릿 편집 영역과 접수 템플릿
  // 선택지가 달라지므로 설정 패널을 다시 그린다.
  host.querySelectorAll('input[name="msg-channel"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      try {
        await api('/api/admin/settings', { method: 'PUT', body: { message_channel: e.target.value } });
        toast('발송 방식 저장됨', 'success');
        renderSettings();    // swap template editors + 접수 템플릿 선택지
        renderQuotesAdmin(); // apply the new default to each quote's send dropdown
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.getElementById('submit-auto-toggle')?.addEventListener('change', async (e) => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { sms_submit_enabled: e.target.checked ? '1' : '0' } });
      toast('설정 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('alim-submit-code')?.addEventListener('change', async (e) => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { alimtalk_submit_code: e.target.value } });
      toast('접수 알림톡 템플릿 저장됨', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  // SMS 본문 템플릿 편집은 문자 채널일 때만 노출되므로 그때만 와이어링한다.
  if (channel === 'sms') {
  // SMS 템플릿 에디터들 (제목 + 본문 + 카운터 + 저장)
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
  } // end if (channel === 'sms')

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
  // AlimTalk 템플릿은 외부 NCP API(템플릿당 추가 호출, N+1)라 느리고 간헐적이다.
  // 견적 목록 렌더를 여기에 묶지 말 것 — 빠른 로컬 데이터만 기다려 먼저 그리고,
  // 알림톡은 백그라운드로 받아 채널 옵션을 나중에 끼워 넣는다.
  const [{ quotes, users: allUsers, slicerEnabled: slicerOn, printerEnabled: printerOn }, { fields }, settingsRes] = await Promise.all([
    api('/api/admin/quotes'),
    api('/api/form-fields'),
    api('/api/admin/settings'),
  ]);
  const { settings } = settingsRes;
  alimtalkAvailable = false;
  loadAlimTemplates([]);
  loadSmsTemplates(settings);
  messageChannel = settings.message_channel === 'alimtalk' ? 'alimtalk' : 'sms';
  smsSubmitEnabled = settings.sms_submit_enabled === '1';
  estPricePerM = Number(settings.est_price_per_m) || 500;
  slicerEnabled = !!slicerOn;
  printerEnabled = !!printerOn;
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
  slicePollQuotes = quotes;
  startSlicePoll();

  // 느린 외부(NCP) 호출은 목록을 다 그린 뒤 백그라운드로. 도착하면 이미 그려진
  // 각 행의 채널 셀렉터에 알림톡 옵션을 끼워 넣고(편집 중인 입력은 건드리지 않음),
  // 시스템 기본이 알림톡이면 그 행들을 알림톡으로 전환한다.
  // 이후 검색/필터로 다시 그려지는 행은 wireQuoteCalc가 전역값을 읽어 자동 포함.
  api('/api/admin/alimtalk-templates').then((alimRes) => {
    alimtalkAvailable = !!(alimRes && alimRes.configured);
    loadAlimTemplates(alimRes && alimRes.templates);
    enableAlimtalkChannel();
  }).catch(() => { /* 알림톡 미구성/일시 오류 — 문자만으로 동작 */ });
}

// 백그라운드로 알림톡 템플릿이 도착했을 때, 이미 렌더된 채널 셀렉터에 알림톡
// 옵션을 추가하고 노출한다. 전체 재렌더 대신 surgical 추가라 진행 중 편집 보존.
// 시스템 기본 채널이 알림톡이면(초기 렌더 땐 알림톡 미로딩이라 문자로 떨어졌던)
// 셀렉터를 알림톡으로 전환하고 change를 발생시켜 본문/템플릿을 다시 채운다.
function enableAlimtalkChannel() {
  if (!alimtalkAvailable || !alimTemplateOrder.length) return;
  document.querySelectorAll('.quote-sms .sms-channel').forEach((sel) => {
    if (![...sel.options].some((o) => o.value === 'alimtalk')) {
      const opt = document.createElement('option');
      opt.value = 'alimtalk';
      opt.textContent = '알림톡';
      sel.appendChild(opt);
    }
    sel.style.display = '';
    if (messageChannel === 'alimtalk' && sel.value !== 'alimtalk') {
      sel.value = 'alimtalk';
      sel.dispatchEvent(new Event('change'));
    }
  });
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
      ${renderSliceTotals(q)}
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
      ${renderSliceLine(qid, f)}
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

  wireSlice(q);
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
let messageChannel = 'sms';   // system-wide default channel; pre-selects each quote's send dropdown
let estPricePerM = 500;       // filament price per meter; loaded from settings
let printEtaText = '';        // in-progress print ETA "DD일 HH:MM" (24h) for {eta}; '' when idle
let alimtalkAvailable = false; // AlimTalk (Biz Message) configured server-side
let alimTemplates = {};        // id -> { label, content, code } — AlimTalk set (separate from SMS)
let alimTemplateOrder = [];
let slicerEnabled = false;    // auto-slicing worker configured server-side (SLICER_URL)
let printerEnabled = false;   // sending to the printer (slicer worker + Home Assistant)

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
  const commentEl = calcEl.querySelector('[data-calc="comment"]');
  const floor100 = (n) => Math.max(0, Math.floor(n / 100) * 100);

  // Channel selector: 문자 always; 알림톡 only when Biz Message is configured and
  // at least one approved template is registered. SMS and AlimTalk are separate
  // template sets. Defaults to the system-wide messageChannel when that channel
  // is selectable (알림톡 loads in the background — see enableAlimtalkChannel).
  const alimSelectable = alimtalkAvailable && alimTemplateOrder.length;
  let channel = (messageChannel === 'alimtalk' && alimSelectable) ? 'alimtalk' : 'sms';
  let selectedId = null;
  const channelOpts = [{ v: 'sms', label: '문자' }];
  if (alimSelectable) channelOpts.push({ v: 'alimtalk', label: '알림톡' });
  channelEl.innerHTML = channelOpts.map((c) => `<option value="${c.v}">${c.label}</option>`).join('');
  channelEl.value = channel;
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
  // 코멘트 편집 → 본문 {comment} 라이브 재치환. 알림톡은 본문이 read-only라 이
  // 재치환이 유일한 반영 경로(예: 출력 불가 사유). 없으면 사유가 빈칸으로 발송됨.
  commentEl?.addEventListener('input', refreshSms);
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

// ── Auto-slicing (slicer worker) ────────────────────────────────────────────

const SLICE_PROFILES = ['0.20', '0.08'];

// Estimated cost from sliced filament length, the same way the quote form
// derives 비용 from 필라멘트 (m): meters × price per meter, floored to 100 won.
function sliceCost(meters) {
  const m = Number(meters);
  if (meters == null || !Number.isFinite(m)) return null;
  return Math.max(0, Math.floor((m * estPricePerM) / 100) * 100);
}
const wonText = (v) => (v == null ? '-' : `${fmtWon(v)}원`);

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

function renderSliceLine(qid, f) {
  const s = f.slice;
  const btn = (cls, label) => `<button class="btn ghost ${cls}" data-qid="${qid}" data-fid="${f.id}" style="padding:1px 6px;font-size:11px;">${label}</button>`;
  if (!s) {
    return slicerEnabled && f.hasModel
      ? `<div class="slice-line" onclick="event.stopPropagation()">${btn('slice-run', '슬라이싱')}</div>`
      : '';
  }
  let body;
  if (s.status === 'pending') body = '<span class="muted">슬라이싱 대기</span>';
  else if (s.status === 'running') body = '<span class="muted">슬라이싱 중…</span>';
  else if (s.status === 'failed') body = `<span class="error" title="${escapeAttr(s.error || '')}">슬라이싱 실패</span>`;
  else {
    const prof = s.result?.profiles || {};
    const objs = s.result?.objects || [];
    const how = objs.some((o) => o.chosen_by === 'manual') ? '수동 배치'
      : objs.some((o) => o.chosen_by === 'admin') ? '직접 선택'
        : objs.some((o) => o.chosen_by === 'llm') ? 'LLM 선택' : '';
    // one aligned row per profile: name, time, cost (no run-on lists)
    body = `<div class="sl-grid">${SLICE_PROFILES.map((k) => {
      const p = prof[k];
      return `<span class="sl-k">${k}</span><span>${p ? fmtDur(p.time_s) : '-'}</span><span>${p ? wonText(sliceCost(p.meters)) : ''}</span>`;
    }).join('')}</div>`
      + (how ? `<div class="muted">방향: ${how}</div>` : '');
  }
  if (f.printDecision) {
    body += `<div><span class="tag ${f.printDecision === 'approved' ? 'tag-approved' : 'tag-hold'}" title="${escapeAttr(f.printNote || '')}">${f.printDecision === 'approved' ? '출력 승인' : '출력 보류'}</span></div>`;
  }
  const actions = [];
  if (s.status === 'done' || s.status === 'failed') {
    if (s.result) actions.push(btn('slice-detail', '상세'));
    if (slicerEnabled && f.hasModel) actions.push(btn('slice-run', '재실행'));
  }
  return `<div class="slice-line" onclick="event.stopPropagation()">${body}${actions.length ? `<div class="row" style="gap:4px;margin-top:2px;">${actions.join('')}</div>` : ''}</div>`;
}

function renderSliceTotals(q) {
  const withSlice = q.files.filter((f) => f.slice);
  if (!withSlice.length) return '';
  const done = withSlice.filter((f) => f.slice.status === 'done' && f.slice.result?.profiles);
  const notDone = q.files.filter((f) => f.hasModel).length - done.length;
  const rows = SLICE_PROFILES.map((k) => {
    const ps = done.map((f) => f.slice.result.profiles[k]).filter(Boolean);
    if (!ps.length) return '';
    const sum = (key) => ps.reduce((a, p) => a + (Number(p[key]) || 0), 0);
    const meters = Math.round(sum('meters') * 100) / 100;
    return `<span class="sl-k">${k}</span><span>${fmtDur(sum('time_s'))}</span><span>${sum('grams').toFixed(1)}g</span><span>${meters}m</span><span class="sl-cost">${wonText(sliceCost(meters))}</span>
      <button class="btn ghost slice-apply" data-qid="${q.id}" data-m="${meters}">m 적용</button>`;
  }).join('');
  return `<div class="slice-totals small">
    <strong>슬라이싱 합계</strong>${notDone > 0 ? ` <span class="muted">(${notDone}개 파일 미완료)</span>` : ''}
    ${rows ? `<div class="st-grid">${rows}</div>` : '<div class="muted">완료된 결과 없음</div>'}
    ${renderPlateBlock(q)}
  </div>`;
}

// "한 판으로 합치기": all model files of the quote arranged on shared plate(s),
// each in the orientation its own slicing chose.
function renderPlateBlock(q) {
  const models = q.files.filter((f) => f.hasModel);
  if (!slicerEnabled || models.length < 2) return '';
  const p = q.plate;
  const btn = (cls, label) => `<button class="btn ghost ${cls}" data-qid="${q.id}">${label}</button>`;
  let body = '';
  const actions = [];
  if (!p) {
    body = '<span class="muted">파일들을 한 판에 배치해 한 번에 출력할 수 있습니다.</span>';
    actions.push(btn('plate-run', '한 판으로 합치기'));
  } else if (p.status === 'pending') body = '<span class="muted">합치기 대기</span>';
  else if (p.status === 'running') body = '<span class="muted">합치는 중…</span>';
  else {
    if (p.status === 'failed') body = `<span class="error" title="${escapeAttr(p.error || '')}">합치기 실패</span>`;
    const prof = p.result?.profiles || {};
    const rows = SLICE_PROFILES.filter((k) => prof[k]).map((k) => {
      const x = prof[k];
      return `<span class="sl-k">${k}</span><span>${fmtDur(x.time_s)}</span><span>${Number(x.grams).toFixed(1)}g</span><span>${x.plates > 1 ? `${x.plates}판` : '1판'}</span><span class="sl-cost">${wonText(sliceCost(x.meters))}</span><span></span>`;
    }).join('');
    if (rows) body += `<div class="st-grid">${rows}</div>`;
    // a file re-sliced after the plate was made may have a new orientation
    const stale = models.some((f) => f.slice?.slicedAt && p.slicedAt && f.slice.slicedAt > p.slicedAt);
    if (stale) body += '<div class="muted">파일 방향이 바뀌었습니다. 다시 합치면 반영됩니다.</div>';
    if (p.result) actions.push(btn('plate-detail', '상세'));
    actions.push(btn('plate-run', '다시 합치기'));
  }
  return `<div class="plate-block"><strong>한 판으로 합치기</strong> ${body}
    ${actions.length ? `<div class="row" style="gap:4px;">${actions.join('')}</div>` : ''}</div>`;
}

function plateTarget(q) {
  const models = q.files.filter((f) => f.hasModel);
  return {
    kind: 'plate',
    id: 'plate',
    filename: `한 판 (파일 ${models.length}개)`,
    hasModel: true,
    slice: q.plate,
    printDecision: models.every((f) => f.printDecision === 'approved') ? 'approved' : null,
    printSent: q.plate?.printSent || null,
  };
}

function markPlateQueued(q) {
  q.plate = { ...(q.plate || {}), status: 'pending', error: null };
  refreshSliceUi(q, null);
  startSlicePoll();
}

// While any file is queued or running, poll its state and update just that
// card (and the quote's totals) in place, so edits elsewhere are kept.
const SLICE_POLL_MS = 5000;
let slicePollQuotes = [];
let slicePollTimer = null;
const SLICE_ACTIVE = new Set(['pending', 'running']);

function startSlicePoll() {
  if (!slicePollTimer) slicePollTimer = setInterval(pollSlices, SLICE_POLL_MS);
}

function stopSlicePoll() {
  clearInterval(slicePollTimer);
  slicePollTimer = null;
}

async function pollSlices() {
  if (!document.getElementById('quotes-panel')) { stopSlicePoll(); return; }
  if (document.hidden) return;
  const active = slicePollQuotes.flatMap((q) => q.files
    .filter((f) => SLICE_ACTIVE.has(f.slice?.status))
    .map((f) => ({ q, f })));
  const plates = slicePollQuotes.filter((q) => SLICE_ACTIVE.has(q.plate?.status));
  if (!active.length && !plates.length) { stopSlicePoll(); return; }
  let res;
  try {
    res = await api(`/api/admin/slices?ids=${active.map((a) => a.f.id).join(',')}&quotes=${plates.map((q) => q.id).join(',')}`);
  } catch { return; } // try again next tick
  for (const row of res.plates || []) {
    const q = plates.find((x) => x.id === row.quoteId);
    if (!q || !row.plate || row.plate.status === q.plate.status) continue;
    q.plate = row.plate;
    refreshSliceUi(q, null);
    if (row.plate.status === 'done') toast('한 판 합치기 완료', 'success');
    else if (row.plate.status === 'failed') toast('한 판 합치기 실패', 'error');
  }
  for (const row of res.files) {
    const a = active.find((x) => x.f.id === row.id);
    if (!a || !row.slice) continue;
    if (row.slice.status === a.f.slice.status && row.slice.slicedAt === a.f.slice.slicedAt) continue;
    a.f.slice = row.slice;
    refreshSliceUi(a.q, a.f);
    if (row.slice.status === 'done') toast(`슬라이싱 완료: ${a.f.filename}`, 'success');
    else if (row.slice.status === 'failed') toast(`슬라이싱 실패: ${a.f.filename}`, 'error');
  }
}

function refreshSliceUi(q, f) {
  const card = f && document.querySelector(`.file-card[data-fid="${f.id}"]`);
  if (card) {
    const html = renderSliceLine(q.id, f);
    const line = card.querySelector('.slice-line');
    if (line) line.outerHTML = html;
    else card.querySelector('.card-actions')?.insertAdjacentHTML('beforebegin', html);
  }
  const calc = document.querySelector(`.quote-calc[data-qid="${q.id}"]`);
  if (calc) {
    const html = renderSliceTotals(q);
    const totals = calc.querySelector('.slice-totals');
    if (totals) totals.outerHTML = html;
    else if (html) calc.insertAdjacentHTML('afterbegin', html);
  }
  wireSlice(q);
}

function markSliceQueued(q, f) {
  f.slice = { ...(f.slice || {}), status: 'pending', error: null };
  refreshSliceUi(q, f);
  startSlicePoll();
}

// Safe to call again after a partial re-render: each button is wired once.
function wireSlice(q) {
  const once = (b) => (b.dataset.wired ? false : (b.dataset.wired = '1'));
  document.querySelectorAll(`.slice-run[data-qid="${q.id}"]`).forEach((b) => {
    if (!once(b)) return;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const f = q.files.find((x) => x.id === b.dataset.fid);
      try {
        await api(`/api/admin/quotes/${q.id}/files/${b.dataset.fid}/slice`, { method: 'POST' });
        toast('슬라이싱 대기열에 추가했습니다. 끝나면 자동으로 표시됩니다.', 'success');
        if (f) markSliceQueued(q, f); else renderQuotesAdmin();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll(`.slice-detail[data-qid="${q.id}"]`).forEach((b) => {
    if (!once(b)) return;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const f = q.files.find((x) => x.id === b.dataset.fid);
      if (!f?.slice?.result) return;
      openSliceDetail(q, f);
    });
  });
  document.querySelectorAll(`.plate-run[data-qid="${q.id}"]`).forEach((b) => {
    if (!once(b)) return;
    b.addEventListener('click', async () => {
      try {
        await api(`/api/admin/quotes/${q.id}/plate`, { method: 'POST', body: {} });
        toast('파일들을 한 판으로 합칩니다. 끝나면 자동으로 표시됩니다.', 'success');
        markPlateQueued(q);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll(`.plate-detail[data-qid="${q.id}"]`).forEach((b) => {
    if (!once(b)) return;
    b.addEventListener('click', () => { if (q.plate?.result) openSliceDetail(q, plateTarget(q)); });
  });
  const calcEl = document.querySelector(`.quote-calc[data-qid="${q.id}"]`);
  calcEl?.querySelectorAll('.slice-apply').forEach((b) => {
    if (!once(b)) return;
    b.addEventListener('click', () => {
      const mEl = calcEl.querySelector('[data-calc="filamentM"]');
      if (!mEl) return;
      mEl.value = b.dataset.m;
      mEl.dispatchEvent(new Event('input', { bubbles: true }));
      toast('필라멘트(m)에 적용했습니다. 견적 저장을 눌러 저장하세요.', 'info');
    });
  });
}

// Slice detail: one screen with the 3D view (0.20 / 0.08 preview, an
// explored candidate, or the layout editor) and a side panel with the
// numbers, candidates and the print decision.
// f is a quote file, or plateTarget(q) for the quote's shared plate.
async function openSliceDetail(q, f) {
  const viewer = await import('../viewer.js');
  const { host, close } = viewer.openViewerModal();
  const r = f.slice.result;
  const isPlate = f.kind === 'plate';
  const base = `/slices/${q.id}/${f.id}`;
  const apiBase = isPlate ? `/api/admin/quotes/${q.id}/plate` : `/api/admin/quotes/${q.id}/files/${f.id}`;
  const queued = () => (isPlate ? markPlateQueued(q) : markSliceQueued(q, f));
  const canEdit = slicerEnabled && f.hasModel && (r.objects || []).length > 0
    && (r.objects || []).every((o) => o.preview);
  const profiles = SLICE_PROFILES.filter((k) => r.profiles?.[k]?.file);
  const tabs = [
    ...profiles.map((k) => ({ id: `p:${k}`, label: `${k}mm` })),
    ...(canEdit ? [{ id: 'layout', label: '배치 편집' }] : []),
  ];
  host.innerHTML = `
    <div class="sd-root">
      <div class="sd-head">
        <strong class="sd-title" title="${escapeAttr(f.filename)}">${escapeHtml(f.filename)}</strong>
        <div class="seg sd-tabs">
          ${tabs.map((t) => `<button class="sd-tab" data-view="${t.id}">${t.label}</button>`).join('')}
          <button class="sd-cand-tab active" hidden></button>
        </div>
        <select class="sd-plate" hidden></select>
        <button class="btn ghost sd-close">닫기</button>
      </div>
      <div class="sd-main">
        <div class="sd-canvas">
          <div class="ov sd-status small"></div>
        </div>
        <aside class="sd-panel"><div class="sd-dock"></div>${renderSliceDetail(f, base)}</aside>
      </div>
    </div>`;
  const $ = (sel) => host.querySelector(sel);
  const els = { canvas: $('.sd-canvas'), status: $('.sd-status'), plate: $('.sd-plate'), dock: $('.sd-dock') };
  let mounted = null;
  let token = 0;
  $('.sd-close').addEventListener('click', close);

  let viewedProfile = profiles[0] || '0.20';
  async function show(viewId) {
    const my = ++token;
    if (viewId.startsWith('p:')) { viewedProfile = viewId.slice(2); printUi?.setProfile(viewedProfile); }
    mounted?.dispose();
    mounted = null;
    els.status.textContent = '';
    host.querySelectorAll('.sd-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));
    const candTab = $('.sd-cand-tab');
    const cand = viewId.startsWith('c:') ? viewId.slice(2).split(':') : null;
    candTab.hidden = !cand;
    if (cand) candTab.textContent = `#${cand[0]} 후보 ${cand[1]}`;
    host.querySelectorAll('.sd-cand').forEach((tr) => tr.classList.toggle('sd-cand-active', `c:${tr.dataset.obj}:${tr.dataset.cand}` === viewId));
    viewedCand = cand;
    renderChoice();

    if (viewId === 'layout') {
      const { mountLayoutEditor } = await import('../layout-editor.js');
      if (my !== token) return;
      $('.sd-panel').scrollTop = 0; // phones dock the editor card at the top
      mounted = mountLayoutEditor(els, {
        base,
        result: r,
        onSave: async (layout) => {
          try {
            if (isPlate) await api(apiBase, { method: 'POST', body: { layout } });
            else await api(`${apiBase}/layout`, { method: 'POST', body: layout });
            toast('이 배치로 다시 슬라이싱합니다. 끝나면 자동으로 표시됩니다.', 'success');
            close();
            queued();
          } catch (err) { toast(err.message, 'error'); }
        },
      });
      return;
    }
    let file = null;
    if (viewId.startsWith('p:')) file = r.profiles?.[viewId.slice(2)]?.file;
    else if (cand) {
      const o = (r.objects || []).find((x) => String(x.index) === cand[0]);
      file = o?.candidates?.find((c) => c.id === cand[1])?.file;
    }
    if (!file) {
      els.status.textContent = '미리볼 결과가 없습니다.';
      return;
    }
    const { mountSlicePreview } = await import('../slice-preview.js');
    if (my !== token) return;
    mounted = mountSlicePreview(els, { url: `${base}/${file.split('/').map(encodeURIComponent).join('/')}` });
  }

  host.querySelectorAll('.sd-tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  host.querySelectorAll('.sd-cand').forEach((tr) => tr.addEventListener('click', () => show(`c:${tr.dataset.obj}:${tr.dataset.cand}`)));
  // Candidate choices are collected per object and sent together, so a file
  // with several objects is re-sliced once after all of them are decided.
  const staged = {}; // object index -> candidate id
  let viewedCand = null;
  function renderChoice() {
    host.querySelectorAll('.sd-use-cand').forEach((b) => {
      const o = (r.objects || []).find((x) => String(x.index) === b.dataset.obj);
      const shown = viewedCand && viewedCand[0] === b.dataset.obj ? viewedCand[1] : null;
      const current = o && o.chosen_by !== 'manual' && shown === o.chosen && staged[b.dataset.obj] == null;
      b.hidden = !shown || current;
      if (b.hidden) return;
      b.dataset.cand = shown;
      b.textContent = staged[b.dataset.obj] === shown ? `후보 ${shown} 선택 취소` : `후보 ${shown}로 바꾸기`;
    });
    host.querySelectorAll('.sd-cand').forEach((tr) => {
      tr.classList.toggle('sd-cand-staged', staged[tr.dataset.obj] === tr.dataset.cand);
    });
    const bar = $('.sd-choose-bar');
    if (!bar) return;
    const keys = Object.keys(staged);
    bar.hidden = !keys.length;
    bar.querySelector('.sd-choose-list').textContent = keys.map((k) => `#${k} → 후보 ${staged[k]}`).join(', ');
  }
  host.querySelectorAll('.sd-use-cand').forEach((b) => b.addEventListener('click', () => {
    const o = (r.objects || []).find((x) => String(x.index) === b.dataset.obj);
    if (staged[b.dataset.obj] === b.dataset.cand) delete staged[b.dataset.obj];
    else if (o && o.chosen_by !== 'manual' && o.chosen === b.dataset.cand) delete staged[b.dataset.obj];
    else staged[b.dataset.obj] = b.dataset.cand;
    renderChoice();
  }));
  $('.sd-choose-cancel')?.addEventListener('click', () => {
    for (const k of Object.keys(staged)) delete staged[k];
    renderChoice();
  });
  $('.sd-choose-go')?.addEventListener('click', async () => {
    try {
      await api(`${apiBase}/choose`, { method: 'POST', body: { objects: { ...staged } } });
      toast('선택한 방향으로 다시 슬라이싱합니다. 끝나면 자동으로 표시됩니다.', 'success');
      close();
      queued();
    } catch (err) { toast(err.message, 'error'); }
  });
  host.querySelector('.sd-decision-save')?.addEventListener('click', async () => {
    const decision = host.querySelector('input[name="sd-decision"]:checked')?.value || null;
    const note = host.querySelector('.sd-note').value;
    try {
      await api(`/api/admin/quotes/${q.id}/files/${f.id}/decision`, { method: 'PUT', body: { decision, note } });
      f.printDecision = decision;
      f.printNote = note;
      f.decidedAt = decision ? Date.now() : null;
      toast('출력 결정을 저장했습니다.', 'success');
      refreshSliceUi(q, f);
      printUi?.render();
    } catch (err) { toast(err.message, 'error'); }
  });
  const printUi = $('.sd-print') ? wirePrintSection($('.sd-print .sd-print-body'), q, f, () => viewedProfile, apiBase) : null;
  host._dispose = () => { mounted?.dispose(); mounted = null; printUi?.dispose(); };
  show(tabs[0]?.id ?? 'none');
}

// "프린터로 보내기": printer state, profile / plate / filament slot, then upload
// + start through the server. Enabled only for approved files on an idle printer.
function wirePrintSection(el, q, f, currentProfile, apiBase) {
  const r = f.slice.result;
  const profiles = SLICE_PROFILES.filter((k) => r.profiles?.[k]?.file);
  let status = null;
  let profile = currentProfile();
  let busy = false;
  let timer = null;
  const STATE_KO = {
    idle: '대기 중', finish: '출력 완료 (베드 확인 필요)', failed: '출력 실패 (베드 확인 필요)',
    running: '출력 중', pause: '일시 정지', prepare: '준비 중', slicing: '슬라이싱 중', init: '초기화 중', offline: '오프라인',
  };

  async function load() {
    try { status = await api('/api/admin/printer'); } catch (err) { status = { error: err.message }; }
    render();
  }

  function defaultTray() {
    const pla = (status?.trays || []).filter((t) => /^PLA/i.test(t.type));
    return (pla.find((t) => t.active) || pla[0])?.index;
  }

  function render() {
    if (!status) return;
    if (status.error || !status.configured) {
      el.innerHTML = `<span class="error">${escapeHtml(status.error || '프린터 연동이 설정되지 않았습니다')}</span>`;
      return;
    }
    const p = r.profiles[profile] || r.profiles[profiles[0]];
    if (!r.profiles[profile]) profile = profiles[0];
    const stateText = !status.online ? '오프라인'
      : `${STATE_KO[status.state] || status.state || '알 수 없음'}${status.state === 'running' || status.state === 'pause'
        ? ` ${status.progress}%${status.remainingMin != null ? `, 남은 ${fmtDur(status.remainingMin * 60)}` : ''}` : ''}`;
    const prevTray = el.querySelector('input[name="sd-tray"]:checked')?.value;
    const trays = status.trays || [];
    const sel = prevTray != null && trays.some((t) => String(t.index) === prevTray) ? Number(prevTray) : defaultTray();
    const approved = f.printDecision === 'approved';
    // The send runs on the server: closing this dialog doesn't stop it, and a
    // reopened dialog sees it through status.sending.
    const sendingElsewhere = !busy && status.sending;
    const up = status.upload;
    const sendingText = up && up.total
      ? `프린터로 올리는 중 ${Math.round((up.sent / up.total) * 100)}% (${(up.sent / 1048576).toFixed(0)}/${(up.total / 1048576).toFixed(0)}MB)`
      : '보내는 중…';
    const reason = !approved ? (f.kind === 'plate' ? '모든 파일을 출력 승인해야 보낼 수 있습니다.' : '출력 승인을 저장해야 보낼 수 있습니다.')
      : sendingElsewhere ? `프린터로 보내는 중입니다 (${status.sending}). 창을 닫아도 계속 진행됩니다.`
      : status.justStarted ? '방금 출력을 시작했습니다. 프린터 상태가 바뀌면 다시 보낼 수 있습니다.'
      : !status.startable ? '프린터가 대기 중일 때 보낼 수 있습니다.'
        : sel == null ? 'PLA가 들어 있는 슬롯이 없습니다.' : '';
    el.className = 'sd-print-body small';
    el.innerHTML = `
      <dl class="sd-kv">
        <dt>프린터</dt><dd>${escapeHtml(stateText)}${status.task && status.state !== 'idle' ? `<div class="muted">${escapeHtml(status.task)}</div>` : ''}</dd>
        ${f.printSent ? `<dt>보낸 기록</dt><dd>${fmtDate(f.printSent.at)}<div class="muted">${escapeHtml(f.printSent.profile || '')}mm, 판 ${f.printSent.plate ?? 1}</div></dd>` : ''}
      </dl>
      <div class="sd-print-grid">
        <span class="muted">프로필</span>
        <div class="seg">${profiles.map((k) => `<button class="sd-print-prof ${k === profile ? 'active' : ''}" data-k="${k}">${k}mm</button>`).join('')}</div>
        ${(Number(p.plates) || 1) > 1 ? `<span class="muted">판</span>
          <select class="sd-print-plate">${Array.from({ length: Number(p.plates) }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select>` : ''}
      </div>
      <div class="sd-trays">${trays.map((t) => {
        const pla = /^PLA/i.test(t.type);
        // HA reports #RRGGBBAA; alpha 00 is a clear/translucent spool
        const clear = !t.color || /00$/i.test(t.color);
        return `<label class="sd-tray ${pla ? '' : 'sd-tray-off'}" title="${escapeAttr(t.color || '')}">
          <input type="radio" name="sd-tray" value="${t.index}" ${t.index === sel ? 'checked' : ''} ${pla ? '' : 'disabled'}>
          <span class="sd-swatch ${clear ? 'sd-swatch-clear' : ''}" style="${clear ? '' : `background:${escapeAttr(t.color.slice(0, 7))}`}"></span>
          <span class="sd-tray-text"><b>${escapeHtml(t.label)}</b> ${escapeHtml(t.name)}${pla ? '' : ' <span class="muted">(PLA 아님)</span>'}</span>
          <span class="muted">${t.remain != null ? `${t.remain}%` : ''}${t.active ? ' 사용 중' : ''}</span>
        </label>`;
      }).join('')}</div>
      <label class="le-check"><input type="checkbox" class="sd-print-level" checked> 출력 전 베드 레벨링</label>
      <label class="le-check"><input type="checkbox" class="sd-print-timelapse"> 타임랩스 녹화</label>
      <button class="btn accent sd-print-send" ${reason || busy ? 'disabled' : ''}>${busy || sendingElsewhere ? sendingText : `${profile}mm 출력 시작 (${fmtDur(p.time_s)})`}</button>
      ${reason ? `<div class="muted">${reason}</div>` : ''}`;
    el.querySelectorAll('.sd-print-prof').forEach((b) => b.addEventListener('click', () => { profile = b.dataset.k; render(); }));
    el.querySelector('.sd-print-send').addEventListener('click', send);
  }

  async function send() {
    const p = r.profiles[profile];
    const plate = Number(el.querySelector('.sd-print-plate')?.value || 1);
    const trayInput = el.querySelector('input[name="sd-tray"]:checked');
    if (!trayInput) return toast('필라멘트 슬롯을 고르세요.', 'error');
    const tray = Number(trayInput.value);
    const trayText = trayInput.closest('.sd-tray').querySelector('.sd-tray-text').textContent.replace(/\s+/g, ' ').trim();
    const ok = confirm(`베드를 비우고 출력할 판을 올려 두었나요?\n\n${f.filename}\n${profile}mm, 판 ${plate}, 예상 ${fmtDur(p.time_s)}\n필라멘트: ${trayText}\n\n프린터에서 바로 출력이 시작됩니다.`);
    if (!ok) return;
    busy = true;
    render();
    setTimeout(load, 2000); // show the upload progress soon
    try {
      const res = await api(`${apiBase}/print`, {
        method: 'POST',
        body: {
          profile, plate, tray,
          bedLeveling: el.querySelector('.sd-print-level').checked,
          timelapse: el.querySelector('.sd-print-timelapse').checked,
        },
      });
      f.printSent = { at: Date.now(), profile: res.profile, plate: res.plate, tray: res.tray, name: res.name };
      if (f.kind === 'plate' && q.plate) q.plate.printSent = f.printSent;
      // shown even if the dialog was closed meanwhile (the send kept going)
      toast(`${f.filename}: 프린터로 보냈습니다. 출력 시작을 확인하세요.`, 'success');
    } catch (err) {
      toast(`${f.filename}: ${err.message}`, 'error');
    } finally {
      busy = false;
      load();
    }
  }

  load();
  // faster while an upload runs, to show its progress
  const tick = () => {
    if (!document.hidden) load();
    timer = setTimeout(tick, busy || status?.sending ? 2_000 : 10_000);
  };
  timer = setTimeout(tick, 10_000);
  return {
    render,
    setProfile(k) { if (r.profiles?.[k]?.file) { profile = k; render(); } },
    dispose() { clearTimeout(timer); },
  };
}

function renderSliceDetail(f, base) {
  const r = f.slice.result;
  const isPlate = f.kind === 'plate';
  const fmtNum = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
  const opt = (value, label) => `<label><input type="radio" name="sd-decision" value="${value}" ${(f.printDecision || '') === value ? 'checked' : ''}>${label}</label>`;
  const decision = `
    <section class="sd-sec">
      <h4>출력 결정</h4>
      <div class="seg sd-decision-opts">${opt('approved', '승인')}${opt('hold', '보류')}${opt('', '미정')}</div>
      <textarea class="sd-note" rows="2" maxlength="1000" placeholder="메모 (선택)">${escapeHtml(f.printNote || '')}</textarea>
      <div class="sd-row">
        <button class="btn accent sd-decision-save">저장</button>
        ${f.decidedAt ? `<span class="muted small">${fmtDate(f.decidedAt)} 저장됨</span>` : ''}
      </div>
    </section>`;

  const profiles = SLICE_PROFILES.filter((k) => r.profiles?.[k]).map((k) => {
    const p = r.profiles[k];
    const stat = (label, value) => `<div><div class="sd-stat-k">${label}</div><div class="sd-stat-v">${value}</div></div>`;
    return `<div class="sd-profile">
      <div class="sd-row"><b>${k}mm</b><span class="sd-cost">${wonText(sliceCost(p.meters))}</span>${p.plates > 1 ? `<span class="muted small">${p.plates}판</span>` : ''}${p.file ? `<a class="btn ghost sd-dl" href="${base}/${encodeURIComponent(p.file)}">다운로드</a>` : ''}</div>
      <div class="sd-stats">
        ${stat('시간', fmtDur(p.time_s))}${stat('무게', `${Number(p.grams).toFixed(1)}g`)}
        ${stat('길이', p.meters != null ? `${p.meters}m` : '-')}${stat('서포트', fmtDur(p.support_s))}
      </div>
    </div>`;
  }).join('');
  const kv = [
    ['상태', r.status === 'done' ? '완료' : '<span class="error">실패</span>'],
    ['방향 결정', isPlate ? '파일별로 정한 방향' : r.mode === 'auto' ? 'Bambu 자동 방향' : '후보 탐색'],
    ['소요', `${fmtNum(r.elapsed_s)}초`],
    ['완료 시각', f.slice.slicedAt ? fmtDate(f.slice.slicedAt) : '-'],
  ];
  const meta = `<dl class="sd-kv small">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const result = `
    <section class="sd-sec">
      <h4>슬라이싱 결과</h4>
      ${meta}
      ${r.error ? `<div class="error small">${escapeHtml(r.error)}</div>` : ''}
      ${(r.warnings || []).map((w) => `<div class="small muted">⚠ ${escapeHtml(w)}</div>`).join('')}
      ${profiles}
    </section>`;

  const objects = (r.objects || []).map((o) => {
    // only candidates that were sliced can be previewed; pruned ones are not listed
    const cands = (o.candidates || []).filter((c) => c.file).map((c) => {
      const m = c.metrics || {};
      const chosen = o.chosen_by !== 'manual' && c.id === o.chosen;
      return `<tr class="sd-cand" data-obj="${o.index}" data-cand="${c.id}">
        <td><b>${c.id}</b>${chosen ? ' ✓' : ''}</td>
        <td>${fmtDur(m.time_s)}</td><td>${fmtNum(m.grams, 0)}g</td>
        <td>${wonText(sliceCost(m.meters))}</td>
        <td>${fmtDur(m.support_s)}</td><td>${fmtNum(m.height_mm)}mm</td></tr>`;
    }).join('');
    const how = isPlate
      ? { manual: '수동 배치', llm: 'LLM 선택', admin: '직접 선택', score: '자동 점수', upload: '업로드 방향' }[o.orientation] || ''
      : o.chosen_by === 'manual' ? '수동 배치'
        : o.chosen ? `후보 ${o.chosen} (${{ llm: 'LLM 선택', admin: '직접 선택' }[o.chosen_by] || '자동 점수'})` : '';
    return `<div class="sd-obj">
      <div class="sd-row"><b class="sd-ellipsis">#${o.index} ${escapeHtml(o.name)}</b></div>
      <dl class="sd-kv small">
        <dt>크기</dt><dd>${(o.extents_mm || []).join(' × ')} mm</dd>
        ${how ? `<dt>방향</dt><dd>${how}</dd>` : ''}
      </dl>
      ${[
        o.watertight ? '' : '<span class="tag tag-hold">열린 메쉬</span>',
        (o.flags || []).includes('scaled_m_to_mm') ? '<span class="tag tag-hold">m 단위로 보여 ×1000 확대</span>' : '',
        o.supports === 'everywhere' ? '<span class="tag">서포트 전체 허용</span>' : '',
      ].filter(Boolean).join(' ') || ''}
      ${o.error ? `<div class="error small">${escapeHtml(o.error)}</div>` : ''}
      ${o.reason ? `<div class="small">${escapeHtml(o.reason)}</div>` : ''}
      ${o.concerns ? `<div class="small error">${escapeHtml(o.concerns)}</div>` : ''}
      ${cands ? `<table class="sd-cands small">
        <thead><tr><th>후보</th><th>시간</th><th>무게</th><th>비용</th><th>서포트</th><th>높이</th></tr></thead>
        <tbody>${cands}</tbody></table>
        ${slicerEnabled ? `<button class="btn accent sd-use-cand" data-obj="${o.index}" hidden></button>` : ''}` : ''}
    </div>`;
  }).join('');
  const hasCands = (r.objects || []).some((o) => (o.candidates || []).some((c) => c.file));
  const llmInfo = r.llm?.used
    ? (r.llm.overridden
      ? `<div class="small muted">LLM이 고른 방향을 직접 바꿨습니다. (이전 LLM 판단: ${escapeHtml(r.llm.summary || '')})</div>`
      : `<div class="small">LLM: ${escapeHtml(r.llm.summary || '')}</div>`)
    : (r.llm?.error ? `<div class="small muted">LLM 미사용 (${escapeHtml(r.llm.error)})</div>` : '');
  const chooseBar = hasCands && slicerEnabled ? `
      <div class="sd-choose-bar" hidden>
        <div class="small">바꿀 방향: <b class="sd-choose-list"></b></div>
        <div class="sd-row">
          <button class="btn accent sd-choose-go">선택한 방향으로 다시 슬라이싱</button>
          <button class="btn ghost sd-choose-cancel">취소</button>
        </div>
      </div>` : '';
  const orient = objects ? `
    <section class="sd-sec">
      <h4>${isPlate ? '객체' : '방향'}</h4>
      ${isPlate ? '<div class="muted small">각 파일의 슬라이싱에서 정한 방향으로 한 판에 배치했습니다. 방향은 파일 상세에서 바꾸고 다시 합치세요.</div>' : ''}
      ${hasCands ? '<div class="muted small">후보를 누르면 그 방향으로 0.20mm 슬라이싱한 결과가 보입니다. 객체마다 바꿀 후보를 고른 뒤 한 번에 다시 슬라이싱합니다.</div>' : ''}
      ${chooseBar}
      ${objects}
      ${llmInfo}
    </section>` : '';
  const print = printerEnabled && Object.keys(r.profiles || {}).length
    ? '<section class="sd-sec sd-print"><h4>프린터로 보내기</h4><div class="sd-print-body muted small">프린터 상태 확인 중…</div></section>'
    : '';
  return (isPlate ? '' : decision) + print + result + orient;
}
