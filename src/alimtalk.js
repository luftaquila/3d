import crypto from 'node:crypto';
import { config } from './config.js';
import { smsByteLength } from './sens.js';

// Naver Cloud Biz Message — KakaoTalk AlimTalk v2. Same API gateway and HMAC
// signing as SENS SMS (see sens.js); only the path and payload differ. AlimTalk
// can ONLY send Kakao-approved templates: `content` must match the approved
// template body (with #{variables} filled). Optional failover re-sends as
// SMS/LMS via the SENS sender number when AlimTalk delivery fails.
const HOST = 'https://sens.apigw.ntruss.com';
const SMS_MAX_BYTES = 90;

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
// templateCode. When failover is true, NCP falls back to SMS/LMS (chosen by
// byte length) using the SENS sender number on delivery failure.
export async function sendAlimtalk(log, { to, templateCode, content, buttons, failover, failoverContent }) {
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
  if (failover && config.sens.fromNumber) {
    const fb = String(failoverContent ?? body);
    const isLms = smsByteLength(fb) > SMS_MAX_BYTES;
    message.failoverConfig = {
      type: isLms ? 'LMS' : 'SMS',
      from: config.sens.fromNumber,
      content: fb,
    };
    if (isLms) message.failoverConfig.subject = '3D 프린팅 견적';
  }

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
