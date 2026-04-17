export async function api(path, opts = {}) {
  const init = { ...opts };
  init.headers = new Headers(opts.headers || {});
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers.set('X-Requested-With', 'fetch');
  }
  if (init.body && !(init.body instanceof FormData) && typeof init.body !== 'string') {
    init.headers.set('content-type', 'application/json');
    init.body = JSON.stringify(init.body);
  }
  init.credentials = 'same-origin';
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') || '';
  let body = null;
  if (ct.includes('application/json')) {
    body = await res.json().catch(() => null);
  } else {
    body = await res.text().catch(() => null);
  }
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText || '요청 실패';
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function loginRedirect(returnTo = location.pathname) {
  location.href = `/oauth2/login?return_to=${encodeURIComponent(returnTo)}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ko-KR');
}
