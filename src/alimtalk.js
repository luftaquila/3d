import crypto from 'node:crypto';
import { config } from './config.js';

// Naver Cloud Biz Message — KakaoTalk AlimTalk v2. Same API gateway and HMAC
// signing as SENS SMS (see sens.js); only the path and payload differ. AlimTalk
// can ONLY send Kakao-approved templates: `content` must match the approved
// template body (with #{variables} filled). SMS vs AlimTalk is an explicit
// per-send choice — no failover here; control SMS fallback (if any) in the NCP
// Biz Message console.
const HOST = 'https://sens.apigw.ntruss.com';

export function alimtalkConfigured() {
  const { accessKey, secretKey } = config.sens;
  const { serviceId, plusFriendId } = config.bizMessage;
  return !!(accessKey && secretKey && serviceId && plusFriendId);
}

function sign(timestamp, path) {
  const message = `POST ${path}\n${timestamp}\n${config.sens.accessKey}`;
  return crypto.createHmac('sha256', config.sens.secretKey).update(message).digest('base64');
}

// Send one AlimTalk message. Returns { ok, status, data }; never throws on a
// non-2xx response. content must match the approved template identified by
// templateCode.
export async function sendAlimtalk(log, { to, templateCode, content, buttons }) {
  if (!alimtalkConfigured()) {
    return { ok: false, status: 0, data: 'AlimTalk not configured' };
  }
  if (!templateCode) {
    return { ok: false, status: 0, data: 'templateCode required' };
  }

  const digits = String(to ?? '').replace(/\D/g, '');
  const body = String(content ?? '');
  const path = `/alimtalk/v2/services/${config.bizMessage.serviceId}/messages`;
  const timestamp = String(Date.now());

  const message = { to: digits, content: body };
  if (Array.isArray(buttons) && buttons.length) message.buttons = buttons;

  const payload = {
    plusFriendId: config.bizMessage.plusFriendId,
    templateCode,
    messages: [message],
  };

  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-ncp-apigw-timestamp': timestamp,
        'x-ncp-iam-access-key': config.sens.accessKey,
        'x-ncp-apigw-signature-v2': sign(timestamp, path),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.text().catch(() => '');
    if (!res.ok) {
      log.warn({ status: res.status, data }, 'alimtalk send failed');
      return { ok: false, status: res.status, data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    log.warn({ err }, 'alimtalk request error');
    return { ok: false, status: 0, data: err?.message || String(err) };
  }
}
