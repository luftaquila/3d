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

function sign(method, path, timestamp) {
  const message = `${method} ${path}\n${timestamp}\n${config.sens.accessKey}`;
  return crypto.createHmac('sha256', config.sens.secretKey).update(message).digest('base64');
}

// Authenticated GET against the SENS API gateway. Returns parsed JSON, or null
// on any error/non-2xx (callers degrade gracefully).
async function ncpGet(log, path) {
  const timestamp = String(Date.now());
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'GET',
      headers: {
        'x-ncp-apigw-timestamp': timestamp,
        'x-ncp-iam-access-key': config.sens.accessKey,
        'x-ncp-apigw-signature-v2': sign('GET', path, timestamp),
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      log.warn({ status: res.status }, 'alimtalk template fetch failed');
      return null;
    }
    try { return JSON.parse(text); } catch { return null; }
  } catch (err) {
    log.warn({ err }, 'alimtalk template request error');
    return null;
  }
}

// List the channel's registered AlimTalk templates with full content + buttons
// + inspection status, combining the list and per-code detail endpoints. The
// list endpoint omits content, so each code is fetched in detail. `approved`
// is derived best-effort from the inspection status (APPROVE).
export async function listAlimtalkTemplates(log) {
  if (!alimtalkConfigured()) return [];
  const channelId = encodeURIComponent(config.bizMessage.plusFriendId);
  const base = `/alimtalk/v2/services/${config.bizMessage.serviceId}/templates`;
  const list = await ncpGet(log, `${base}?channelId=${channelId}`);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    const code = t.templateCode;
    if (!code) continue;
    const detail = await ncpGet(log, `${base}?channelId=${channelId}&templateCode=${encodeURIComponent(code)}`);
    const d = Array.isArray(detail) ? detail[0] : detail;
    const inspectionStatus = d?.templateInspectionStatus || '';
    out.push({
      code,
      name: t.templateName || code,
      content: d?.content || '',
      buttons: Array.isArray(d?.buttons)
        ? d.buttons.map((b) => ({ type: b.type, name: b.name, linkMobile: b.linkMobile, linkPc: b.linkPc }))
        : [],
      inspectionStatus,
      // Sendable only once Kakao approves. The pre-approval pipeline statuses
      // are REGISTER(작성중)/REQUEST(검수요청)/ACCEPT(검수대기)/INSPECT(검수중)/
      // REJECT(반려); anything else (the approved value) is treated as sendable,
      // and NCP still rejects at send if we're wrong.
      approved: !['', 'REGISTER', 'REQUEST', 'ACCEPT', 'INSPECT', 'REJECT'].includes(inspectionStatus),
    });
  }
  return out;
}

// Cached wrapper over listAlimtalkTemplates. The list endpoint is N+1 against
// NCP (one detail fetch per code), so admin page loads, manual sends, and the
// auto-submit notify share a short-lived cache.
let tplCache = { at: 0, list: [] };
const TPL_TTL = 5 * 60 * 1000;
export async function getAlimtalkTemplates(log, force = false) {
  const now = Date.now();
  if (!force && tplCache.list.length && now - tplCache.at < TPL_TTL) return tplCache.list;
  const list = await listAlimtalkTemplates(log);
  if (list.length) tplCache = { at: now, list };
  return list;
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
        'x-ncp-apigw-signature-v2': sign('POST', path, timestamp),
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
