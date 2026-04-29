import { api } from './api.js';
import { renderHome } from './views/home.js';
import { renderMy } from './views/my.js';
import { renderAdmin } from './views/admin.js';

const state = {
  session: null,
};

async function loadSession() {
  try {
    state.session = await api('/api/me');
  } catch {
    state.session = { authenticated: false };
  }
  updateHeader();
}

const GOOGLE_ICON_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
`;

const LOGOUT_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" x2="9" y1="12" y2="12"/>
  </svg>
`;

const SUN_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
  </svg>
`;

const MOON_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
`;

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch {}
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
}

function initTheme() {
  const saved = (() => {
    try { return localStorage.getItem('theme'); } catch { return null; }
  })();
  applyTheme(saved === 'light' ? 'light' : 'dark');
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

function updateHeader() {
  const sessionArea = document.querySelector('.session-area');
  if (!sessionArea) return;
  sessionArea.innerHTML = '';
  if (state.session?.authenticated) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-icon';
    btn.title = '로그아웃';
    btn.setAttribute('aria-label', '로그아웃');
    btn.innerHTML = LOGOUT_ICON_SVG;
    btn.addEventListener('click', async () => {
      try {
        await fetch('/oauth2/logout', {
          method: 'POST',
          headers: { 'X-Requested-With': 'fetch' },
          credentials: 'same-origin',
          redirect: 'manual',
        });
      } catch { /* ignore network errors, still redirect */ }
      location.href = '/';
    });
    sessionArea.appendChild(btn);
  } else {
    const btn = document.createElement('a');
    btn.href = `/oauth2/login?return_to=${encodeURIComponent(location.pathname + location.hash)}`;
    btn.className = 'google-signin';
    btn.innerHTML = `${GOOGLE_ICON_SVG}<span>Google 로그인</span>`;
    sessionArea.appendChild(btn);
  }
  const adminLink = document.querySelector('.admin-link');
  if (adminLink) adminLink.classList.toggle('hidden', !state.session?.isAdmin);
  document.querySelectorAll('.auth-only').forEach((el) => {
    el.classList.toggle('hidden', !state.session?.authenticated);
  });
  const navs = document.querySelectorAll('nav a[data-nav]');
  const path = location.pathname;
  navs.forEach((a) => {
    const k = a.dataset.nav;
    const match =
      (k === 'home' && path === '/') ||
      (k === 'quote' && path.startsWith('/quote')) ||
      (k === 'my' && path.startsWith('/my')) ||
      (k === 'admin' && path.startsWith('/admin'));
    a.classList.toggle('active', match);
  });
}

function navigate(to, push = true) {
  if (push) history.pushState({}, '', to);
  window.scrollTo(0, 0);
  route();
}

window.addEventListener('popstate', () => route());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  if (a.origin !== location.origin) return;
  if (a.getAttribute('href')?.startsWith('#')) {
    e.preventDefault();
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target) {
      const header = document.querySelector('.site-header');
      const offset = (header?.offsetHeight || 0) + 12;
      const top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
    return;
  }
  if (a.dataset.nav === undefined && !a.dataset.spa) return;
  e.preventDefault();
  navigate(a.pathname + a.search + a.hash);
});

async function route() {
  const host = document.getElementById('app');
  host.innerHTML = '<p class="muted">로딩 중...</p>';
  updateHeader();
  const path = location.pathname;
  try {
    if (path === '/' || path === '' || path.startsWith('/quote') || path.startsWith('/live')) {
      await renderHome(host, state, navigate);
    } else if (path.startsWith('/my')) {
      await renderMy(host, state, navigate);
    } else if (path.startsWith('/admin')) {
      await renderAdmin(host, state, navigate);
    } else {
      host.innerHTML = '<h1>404</h1><p>페이지를 찾을 수 없습니다.</p>';
    }
  } catch (err) {
    console.error(err);
    host.innerHTML = `<p class="error">오류: ${err.message || err}</p>`;
  }
}

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('beforeunload', () => {
  try { sessionStorage.setItem('scroll-y', String(window.scrollY)); } catch {}
});

(async () => {
  initTheme();
  await loadSession();
  await route();
  const saved = sessionStorage.getItem('scroll-y');
  sessionStorage.removeItem('scroll-y');
  // /quote and /live anchor to a specific section; restoring the previous
  // scroll position would override that.
  const isAnchor = location.pathname.startsWith('/quote') || location.pathname.startsWith('/live');
  if (saved && !isAnchor) {
    requestAnimationFrame(() => window.scrollTo({ top: Number(saved), behavior: 'smooth' }));
  }
})();

export { navigate, state };
