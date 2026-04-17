import { config } from './config.js';

const lastSendByUser = new Map();
const DEBOUNCE_MS = 60 * 1000;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function sendQuoteNotification(log, { quoteId, userEmail, phone, name, fileCount }) {
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
  lastSendByUser.set(userEmail, now);

  const adminUrl = `${config.publicOrigin}/admin`;
  const body = {
    sender: { email: config.brevo.fromEmail, name: config.brevo.fromName },
    to: [{ email: config.adminEmail }],
    replyTo: { email: userEmail },
    subject: `[3D 견적] ${name} 님의 신규 문의`,
    htmlContent: `
      <h2>신규 견적 문의</h2>
      <ul>
        <li>견적 ID: <code>${escapeHtml(quoteId)}</code></li>
        <li>고객 이메일: ${escapeHtml(userEmail)}</li>
        <li>고객 성명: ${escapeHtml(name)}</li>
        <li>연락처: ${escapeHtml(phone)}</li>
        <li>첨부 파일 수: ${fileCount}</li>
      </ul>
      <p><a href="${adminUrl}">관리자 페이지 열기</a></p>
    `.trim(),
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
