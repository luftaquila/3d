import crypto from 'node:crypto';
import { config } from './config.js';

const SENS_HOST = 'https://sens.apigw.ntruss.com';
// Korean SMS carriers bill SMS up to 90 bytes (EUC-KR semantics: ASCII 1 byte,
// everything else 2 bytes). Past that the message must be sent as an LMS.
const SMS_MAX_BYTES = 90;

export function sensConfigured() {
  const { accessKey, secretKey, serviceId, fromNumber } = config.sens;
  return !!(accessKey && secretKey && serviceId && fromNumber);
}

// Byte length under the SMS/LMS rule (non-ASCII codepoints count as 2 bytes).
export function smsByteLength(str) {
  let bytes = 0;
  for (const ch of String(str)) {
    bytes += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  }
  return bytes;
}

function sign(timestamp, path) {
  const message = `POST ${path}\n${timestamp}\n${config.sens.accessKey}`;
  return crypto.createHmac('sha256', config.sens.secretKey).update(message).digest('base64');
}

// Send one message via Naver Cloud Platform SENS v2. Picks SMS vs LMS by byte
// length. Returns { ok, status, data }; never throws on a non-2xx response.
export async function sendSms(log, { to, content, subject }) {
  if (!sensConfigured()) {
    return { ok: false, status: 0, data: 'SENS not configured' };
  }

  const digits = String(to ?? '').replace(/\D/g, '');
  const body = String(content ?? '');
  const isLms = smsByteLength(body) > SMS_MAX_BYTES;
  const path = `/sms/v2/services/${config.sens.serviceId}/messages`;
  const timestamp = String(Date.now());

  const payload = {
    type: isLms ? 'LMS' : 'SMS',
    from: config.sens.fromNumber,
    content: body,
    messages: [{ to: digits }],
  };
  if (isLms) payload.subject = subject || '3D 프린팅 견적';

  try {
    const res = await fetch(`${SENS_HOST}${path}`, {
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
      log.warn({ status: res.status, data }, 'sens send failed');
      return { ok: false, status: res.status, data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    log.warn({ err }, 'sens request error');
    return { ok: false, status: 0, data: err?.message || String(err) };
  }
}
