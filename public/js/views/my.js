import { api, toast, loginRedirect, fmtBytes, fmtDate } from '../api.js';
import { renderWarningBadge, wireWarningBadges } from '../watertight-badge.js';

export async function renderMy(host, state) {
  if (!state.session?.authenticated) {
    host.innerHTML = `
      <section class="panel">
        <h1>내 견적</h1>
        <p>이전 견적을 보려면 Google 로그인이 필요합니다.</p>
        <button class="btn" id="login-btn">Google 로그인</button>
      </section>
    `;
    document.getElementById('login-btn').onclick = () => loginRedirect('/my');
    return;
  }

  const [{ quotes }, { fields }] = await Promise.all([
    api('/api/my-quotes'),
    api('/api/form-fields'),
  ]);
  const fieldMap = new Map(fields.map((f) => [f.id, f]));

  host.innerHTML = `
    <section class="panel">
      <h1>내 견적</h1>
      <p class="muted small" style="margin:0;">${escapeHtml(state.session.email)}</p>
    </section>

    <section class="panel">
      ${quotes.length === 0 ? '<p class="muted">제출한 견적이 없습니다.</p>' : ''}
      ${quotes.map((q) => renderQuote(q, fieldMap)).join('')}
    </section>

    <section class="panel" style="text-align:center;">
      <p class="muted small" style="margin-bottom:24px;">회원 탈퇴 시 모든 견적 기록과 업로드한 파일, 개인정보가 삭제됩니다.</p>
      <button class="btn danger" id="withdraw-btn">탈퇴</button>
    </section>
  `;

  for (const q of quotes) wireQuote(q);
  wireWarningBadges(host);

  document.getElementById('withdraw-btn')?.addEventListener('click', async () => {
    if (!confirm('모든 견적 기록 및 개인정보를 삭제하고 탈퇴합니다. 이 작업은 되돌릴 수 없습니다. 계속할까요?')) return;
    try {
      await api('/api/me', { method: 'DELETE' });
      toast('탈퇴가 완료되었습니다.', 'success');
      setTimeout(() => { location.href = '/'; }, 500);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function wireQuote(q) {
  const del = document.getElementById(`del-btn-${q.id}`);

  document.getElementById(`dl-all-${q.id}`)?.addEventListener('click', () => downloadAllFiles(q.files));

  document.querySelector(`.show-more[data-qid="${q.id}"]`)?.addEventListener('click', (e) => {
    const grid = document.getElementById(`files-${q.id}`);
    const extras = grid.querySelectorAll('[data-extra]');
    const collapsed = extras[0]?.style.display === 'none';
    extras.forEach((el) => { el.style.display = collapsed ? '' : 'none'; });
    e.target.textContent = collapsed ? '접기' : `+${extras.length}개 더보기`;
  });

  del?.addEventListener('click', async () => {
    if (!confirm('이 견적과 파일을 모두 삭제할까요?')) return;
    try {
      await api(`/api/my-quotes/${q.id}`, { method: 'DELETE' });
      toast('삭제되었습니다.', 'success');
      location.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.querySelectorAll(`.file-card.clickable[data-qid="${q.id}"]`).forEach((card) => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('.card-actions')) return;
      const fid = card.dataset.fid;
      const f = q.files.find((x) => x.id === fid);
      if (!f || !f.hasModel || !f.stlUrl) {
        toast('원본 파일이 삭제되어 미리보기를 열 수 없습니다.', 'error');
        return;
      }
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
}

function renderAnswers(answers, fieldMap) {
  const entries = Object.entries(answers).filter(([, v]) => v && v !== '0');
  if (entries.length === 0) return '';
  return `
    <div class="quote-answers">
      ${entries.map(([k, v]) => {
        const field = fieldMap.get(k);
        const label = field ? field.label : `#${k.slice(-6)}`;
        const display = field?.type === 'checkbox' ? (v === '1' ? '예' : '아니오') : escapeHtml(v);
        return `<div><span class="qa-label">${escapeHtml(label)}:</span> ${display}</div>`;
      }).join('')}
    </div>
  `;
}

function renderQuote(q, fieldMap) {
  const fileCount = q.files.length;
  return `
    <div class="quote-row">
      <div class="quote-row-header">
        <div>
          <div class="quote-date">${fmtDate(q.createdAt)} <span class="quote-id">#${q.id.slice(-8)}</span></div>
          <div class="quote-meta">
            <span>${escapeHtml(q.name)}</span>
            <span>${escapeHtml(q.phone)}</span>
            <span>파일 ${fileCount}개</span>
          </div>
        </div>
        <div class="row" style="gap:6px;">
          ${fileCount >= 2 ? `<button class="btn accent" id="dl-all-${q.id}" style="padding:4px 12px;font-size:12px;">전체 다운로드</button>` : ''}
          <button class="btn danger" id="del-btn-${q.id}" style="padding:4px 12px;font-size:12px;">삭제</button>
        </div>
      </div>
      ${renderAnswers(q.answers, fieldMap)}
      <div class="file-grid" id="files-${q.id}">
        ${q.files.map((f, i) => renderFileCard(q.id, f, i >= 4 && q.files.length >= 5)).join('')}
      </div>
      ${q.files.length >= 5 ? `<button class="btn ghost show-more" data-qid="${q.id}" style="margin-top:8px;font-size:12px;padding:4px 12px;">+${q.files.length - 4}개 더보기</button>` : ''}
    </div>
  `;
}

function renderFileCard(qid, f, hidden) {
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
      ${f.hasModel && f.stlUrl ? `<div class="card-actions" onclick="event.stopPropagation()"><a class="btn accent" href="${f.stlUrl}" download style="padding:2px 8px;font-size:11px;">다운로드</a></div>` : ''}
    </div>
  `;
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
    a.download = `files.zip`;
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
