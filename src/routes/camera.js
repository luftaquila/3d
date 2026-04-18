import crypto from 'node:crypto';
import { request } from 'undici';
import { openDatabase } from '../db.js';
import { config } from '../config.js';

const TOKEN_TTL_SECONDS = 60 * 60;
const MAX_STREAMS_PER_IP = 5;
const UPSTREAM_IDLE_GRACE_MS = 5000;
const CLIENT_WRITE_HIGH_WATER = 512 * 1024;
const CLIENT_MAX_CONSECUTIVE_DROPS = 240;

function cameraEnabled() {
  const row = openDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('camera_enabled');
  return row?.value === '1';
}

function originHost() {
  try { return new URL(config.publicOrigin).host; } catch { return null; }
}

function sameOriginOnly(req) {
  const expected = originHost();
  if (!expected) return false;
  for (const h of [req.headers.origin, req.headers.referer]) {
    if (!h) continue;
    try { if (new URL(h).host === expected) return true; } catch { /* ignore */ }
  }
  return false;
}

function haConfigured() {
  return Boolean(config.homeassistant.url && config.homeassistant.token && config.homeassistant.cameraEntity);
}

function signToken(exp, ip) {
  return crypto.createHmac('sha256', config.cameraStreamKey)
    .update(`${exp}:${ip}`).digest('hex').slice(0, 32);
}

function issueStreamUrl(ip, pathname = '/camera/stream') {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const s = signToken(exp, ip);
  return `${pathname}?e=${exp}&s=${s}`;
}

function verifyToken(req) {
  const e = Number(req.query?.e);
  const s = String(req.query?.s ?? '');
  if (!Number.isFinite(e) || !s || s.length !== 32) return false;
  if (Math.floor(Date.now() / 1000) > e) return false;
  const want = signToken(e, req.ip);
  const a = Buffer.from(s, 'hex');
  const b = Buffer.from(want, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const activeByIp = new Map();

function tryAcquireIpSlot(ip) {
  const n = activeByIp.get(ip) ?? 0;
  if (n >= MAX_STREAMS_PER_IP) return false;
  activeByIp.set(ip, n + 1);
  return true;
}

function releaseIpSlot(ip) {
  const n = (activeByIp.get(ip) ?? 1) - 1;
  if (n <= 0) activeByIp.delete(ip); else activeByIp.set(ip, n);
}

class MjpegBroadcaster {
  constructor({ url, token, log }) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.clients = new Set();
    this.upstream = null;
    this.startPromise = null;
    this.idleTimer = null;
  }

  async add(reply) {
    if (!this.upstream) {
      if (!this.startPromise) {
        this.startPromise = this._start()
          .catch((err) => { this.upstream = null; throw err; })
          .finally(() => { this.startPromise = null; });
      }
      await this.startPromise;
    }
    if (!this.upstream) throw new Error('upstream lost before client attach');
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

    // Client may have disconnected while _start was in flight.
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      if (this.clients.size === 0) this._scheduleStop();
      return;
    }

    reply.hijack();
    try {
      reply.raw.writeHead(200, {
        'Content-Type': this.upstream.contentType,
        'Cache-Control': 'no-store',
        'Connection': 'close',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
      });
    } catch (err) {
      if (this.clients.size === 0) this._scheduleStop();
      throw err;
    }

    const client = { res: reply.raw, aligned: false, dropped: 0, consecutiveDrops: 0 };
    this.clients.add(client);

    await new Promise((resolve) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return resolve();
      reply.raw.once('close', resolve);
    });

    this.clients.delete(client);
    if (this.clients.size === 0) this._scheduleStop();
  }

  async _start() {
    const ac = new AbortController();
    let res;
    try {
      res = await request(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: ac.signal,
        headersTimeout: 10_000,
        bodyTimeout: 0,
      });
    } catch (err) {
      ac.abort();
      throw err;
    }
    if (res.statusCode !== 200) {
      try { res.body.destroy(); } catch { /* ignore */ }
      ac.abort();
      throw new Error(`upstream ${res.statusCode}`);
    }

    const ctRaw = res.headers['content-type'];
    const ct = Array.isArray(ctRaw) ? ctRaw[0] : ctRaw;
    const m = /boundary=([^;]+)/.exec(ct || '');
    if (!m) {
      try { res.body.destroy(); } catch { /* ignore */ }
      ac.abort();
      throw new Error('upstream missing multipart boundary');
    }
    const boundary = m[1].replace(/^"|"$/g, '').trim();
    if (!boundary) {
      try { res.body.destroy(); } catch { /* ignore */ }
      ac.abort();
      throw new Error('upstream empty multipart boundary');
    }
    const boundaryMarker = Buffer.from(`\r\n--${boundary}`);

    this.upstream = { ac, contentType: ct, boundaryMarker };
    this._pump(res).catch((err) => {
      this.log.warn({ err: err?.message }, 'mjpeg pump threw');
    });
  }

  async _pump(res) {
    const upstream = this.upstream;
    try {
      for await (const chunk of res.body) {
        if (this.clients.size === 0) continue;
        const { boundaryMarker } = this.upstream;
        for (const c of [...this.clients]) {
          if (c.res.destroyed || c.res.writableEnded) {
            this.clients.delete(c);
            continue;
          }
          if (!c.aligned) {
            const idx = chunk.indexOf(boundaryMarker);
            if (idx === -1) continue;
            c.aligned = true;
            c.res.write(chunk.subarray(idx));
            c.consecutiveDrops = 0;
            continue;
          }
          if (c.res.writableLength > CLIENT_WRITE_HIGH_WATER) {
            c.dropped += 1;
            c.consecutiveDrops += 1;
            if (c.consecutiveDrops >= CLIENT_MAX_CONSECUTIVE_DROPS) {
              // destroy (not end) so browser's <img> receives a network error
              // event and can trigger a reconnect, instead of a graceful EOF
              // that renders as "frozen frame".
              try { c.res.destroy(); } catch { /* ignore */ }
              this.clients.delete(c);
            }
            continue;
          }
          c.res.write(chunk);
          c.consecutiveDrops = 0;
        }
      }
    } catch (err) {
      if (upstream?.intentionalAbort) {
        this.log.info('mjpeg upstream closed on idle grace');
      } else {
        this.log.warn({ err: err?.message }, 'mjpeg upstream errored');
      }
    } finally {
      // destroy so viewers' <img> fires 'error' and can reconnect via onerror.
      for (const c of this.clients) { try { c.res.destroy(); } catch { /* ignore */ } }
      this.clients.clear();
      this.upstream = null;
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }
  }

  _scheduleStop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0 && this.upstream) {
        this.upstream.intentionalAbort = true;
        try { this.upstream.ac.abort(); } catch { /* ignore */ }
      }
    }, UPSTREAM_IDLE_GRACE_MS);
  }
}

export { issueStreamUrl };

export default async function cameraRoutes(app) {
  const broadcaster = new MjpegBroadcaster({
    url: `${config.homeassistant.url}/api/camera_proxy_stream/${encodeURIComponent(config.homeassistant.cameraEntity)}`,
    token: config.homeassistant.token,
    log: app.log,
  });

  app.get('/camera/stream', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!cameraEnabled()) return reply.code(404).send('camera disabled');
    if (!haConfigured()) return reply.code(503).send('camera not configured');
    if (!sameOriginOnly(req)) return reply.code(403).send('bad origin');
    if (!verifyToken(req)) return reply.code(403).send('bad token');
    if (!tryAcquireIpSlot(req.ip)) return reply.code(429).send('too many streams');

    try {
      await broadcaster.add(reply);
    } catch (err) {
      req.log.warn({ err: err?.message }, 'mjpeg broadcaster rejected client');
      if (reply.raw.headersSent) {
        try { reply.raw.end(); } catch { /* ignore */ }
      } else if (reply.sent) {
        // hijacked before writeHead completed (or writeHead itself threw)
        try { reply.raw.destroy(); } catch { /* ignore */ }
      } else {
        return reply.code(502).send('upstream error');
      }
    } finally {
      releaseIpSlot(req.ip);
    }
  });

  app.get('/camera/snapshot', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!cameraEnabled()) return reply.code(404).send('camera disabled');
    if (!haConfigured()) return reply.code(503).send('camera not configured');
    if (!sameOriginOnly(req)) return reply.code(403).send('bad origin');
    if (!verifyToken(req)) return reply.code(403).send('bad token');

    const url = `${config.homeassistant.url}/api/camera_proxy/${encodeURIComponent(config.homeassistant.cameraEntity)}`;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.homeassistant.token}` },
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      reply.code(res.statusCode);
      const ct = res.headers['content-type'];
      if (ct) reply.header('content-type', Array.isArray(ct) ? ct[0] : ct);
      reply.header('cache-control', 'no-store');
      return reply.send(res.body);
    } catch (err) {
      req.log.warn({ err: err?.message }, 'HA snapshot proxy failed');
      return reply.code(502).send('upstream error');
    }
  });
}
