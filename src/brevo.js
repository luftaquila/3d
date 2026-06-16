import { config } from './config.js';
import { estimateFilament, estimateCost } from '../public/js/filament.js';

const lastSendByUser = new Map();
const DEBOUNCE_MS = 60 * 1000;
const MAX_TRACKED_USERS = 1000;

function markSent(userEmail, now) {
  // Opportunistic TTL sweep: entries older than DEBOUNCE_MS serve no purpose.
  for (const [k, t] of [...lastSendByUser]) {
    if (now - t >= DEBOUNCE_MS) lastSendByUser.delete(k);
  }
  // Move/insert this entry to the tail so head is least-recently-sent for LRU.
  lastSendByUser.delete(userEmail);
  lastSendByUser.set(userEmail, now);
  // Hard cap: evict from head (oldest) if over limit.
  while (lastSendByUser.size > MAX_TRACKED_USERS) {
    const oldest = lastSendByUser.keys().next().value;
    if (oldest === undefined) break;
    lastSendByUser.delete(oldest);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Escape then preserve user-entered line breaks for HTML rendering.
function escapeMultiline(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

function fmtVolume(mm3) {
  return Number.isFinite(mm3) && mm3 > 0 ? `${(mm3 / 1000).toFixed(1)} cm³` : '-';
}

function fmtCount(n) {
  return Number.isFinite(n) ? Number(n).toLocaleString('ko-KR') : '-';
}

function fmtWatertight(v) {
  if (v === true) return '정상';
  if (v === false) return '⚠ 비정상';
  return '-';
}

function fmtKst(ms) {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Pure builder for the admin notification email — returns { subject, htmlContent }.
// Kept separate from the send path so it can be previewed/unit-checked offline.
export function renderQuoteEmail({
  quoteId, userEmail, phone, name, fileCount,
  createdAt, files = [], answers = [], estimateConfig = {},
}) {
  const adminUrl = `${config.publicOrigin}/admin`;
  const fileList = Array.isArray(files) ? files : [];
  const answerList = Array.isArray(answers) ? answers : [];
  const count = Number.isFinite(fileCount) ? fileCount : fileList.length;

  // Customer's entries for the configurable quote-form fields (their inquiry
  // details at submission time — not an admin reply).
  const answersHtml = answerList.length
    ? `
      <h3 style="margin:20px 0 6px">문의 내용</h3>
      <table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px">
        ${answerList.map((a) => `
          <tr>
            <td style="vertical-align:top;color:#555;white-space:nowrap;border-bottom:1px solid #eee"><b>${escapeHtml(a.label)}</b></td>
            <td style="vertical-align:top;border-bottom:1px solid #eee">${escapeMultiline(a.value)}</td>
          </tr>`).join('')}
      </table>`
    : '';

  // Per-file geometry table.
  const filesHtml = fileList.length
    ? `
      <h3 style="margin:20px 0 6px">첨부 파일 (${count}개)</h3>
      <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px;border-color:#ddd">
        <tr style="background:#f5f5f5">
          <th align="left">파일명</th><th align="right">크기</th><th align="right">삼각형</th><th align="right">부피</th><th align="center">형상</th>
        </tr>
        ${fileList.map((f) => `
          <tr>
            <td>${escapeHtml(f.filename)}</td>
            <td align="right">${fmtSize(f.size)}</td>
            <td align="right">${fmtCount(f.triangleCount)}</td>
            <td align="right">${fmtVolume(f.volumeMm3)}</td>
            <td align="center">${fmtWatertight(f.isWatertight)}</td>
          </tr>`).join('')}
      </table>`
    : '';

  // Rough filament/cost estimate (same model as the viewer legend) when any
  // file carries geometry. Reference only — admin enters the real quote.
  const wallMm = Number.isFinite(estimateConfig.wallMm) ? estimateConfig.wallMm : undefined;
  const infillPct = Number.isFinite(estimateConfig.infillPct) ? estimateConfig.infillPct : undefined;
  const pricePerM = Number.isFinite(estimateConfig.pricePerM) ? estimateConfig.pricePerM : undefined;
  let totalVol = 0, totalGrams = 0, totalMeters = 0, anyGeom = false;
  for (const f of fileList) {
    if (Number.isFinite(f.volumeMm3) && f.volumeMm3 > 0) {
      anyGeom = true;
      totalVol += f.volumeMm3;
      const est = estimateFilament(f.volumeMm3, f.surfaceAreaMm2, { wallMm, infillPct });
      totalGrams += est.grams;
      totalMeters += est.meters;
    }
  }
  const estimateHtml = anyGeom
    ? `
      <h3 style="margin:20px 0 6px">추정 (참고용)</h3>
      <ul style="margin:0;font-size:14px">
        <li>총 부피: ${fmtVolume(totalVol)}</li>
        <li>예상 필라멘트: 약 ${totalMeters.toFixed(1)} m / ${Math.round(totalGrams).toLocaleString('ko-KR')} g</li>
        <li>예상 비용: 약 ₩${estimateCost(totalMeters, pricePerM).toLocaleString('ko-KR')}</li>
      </ul>
      <p style="color:#888;font-size:12px;margin:4px 0 0">※ 모델 부피로 산정한 단순 예상치라 실제와 크게 다를 수 있습니다.</p>`
    : '';

  const subject = `[3D 견적] ${name} 님의 신규 문의 (파일 ${count}개)`;
  const htmlContent = `
      <div style="font-family:'Apple SD Gothic Neo',-apple-system,'Malgun Gothic',sans-serif;color:#222;max-width:680px">
        <h2 style="margin:0 0 12px">신규 견적 문의</h2>
        <table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px">
          <tr><td style="color:#555"><b>성명</b></td><td>${escapeHtml(name)}</td></tr>
          <tr><td style="color:#555"><b>이메일</b></td><td><a href="mailto:${escapeHtml(userEmail)}">${escapeHtml(userEmail)}</a></td></tr>
          <tr><td style="color:#555"><b>연락처</b></td><td><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></td></tr>
          <tr><td style="color:#555"><b>접수 시각</b></td><td>${fmtKst(createdAt)}</td></tr>
          <tr><td style="color:#555"><b>견적 ID</b></td><td><code>${escapeHtml(quoteId)}</code></td></tr>
        </table>
        ${answersHtml}
        ${filesHtml}
        ${estimateHtml}
        <p style="margin:24px 0 0">
          <a href="${adminUrl}" style="display:inline-block;background:#2d6cdf;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">관리자 페이지에서 견적 보기</a>
        </p>
        <p style="color:#888;font-size:12px;margin-top:8px">이 메일에 회신하면 고객(${escapeHtml(userEmail)})에게 바로 전달됩니다.</p>
      </div>
    `.trim();

  return { subject, htmlContent };
}

export async function sendQuoteNotification(log, opts) {
  const { quoteId, userEmail } = opts;
  if (!config.brevo.apiKey || !config.brevo.fromEmail) {
    log.info({ quoteId }, 'brevo disabled, skipping notification');
    return;
  }

  const now = Date.now();
  const last = lastSendByUser.get(userEmail) ?? 0;
  if (now - last < DEBOUNCE_MS) {
    log.info({ quoteId, userEmail }, 'brevo debounced');
    return;
  }
  markSent(userEmail, now);

  const { subject, htmlContent } = renderQuoteEmail(opts);
  const body = {
    sender: { email: config.brevo.fromEmail, name: config.brevo.fromName },
    to: [{ email: config.adminEmail }],
    replyTo: { email: userEmail },
    subject,
    htmlContent,
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': config.brevo.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ quoteId, status: res.status, text }, 'brevo send failed');
    } else {
      log.info({ quoteId }, 'brevo notification sent');
    }
  } catch (err) {
    log.warn({ quoteId, err }, 'brevo request error');
  }
}
