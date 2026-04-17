import { request } from 'undici';
import { openDatabase } from '../db.js';
import { config } from '../config.js';

function cameraEnabled() {
  const db = openDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('camera_enabled');
  return row?.value === '1';
}

function originHost() {
  try { return new URL(config.publicOrigin).host; } catch { return null; }
}

function refererAllowed(req) {
  const refHeader = req.headers.referer;
  if (!refHeader) return true;
  try {
    const ref = new URL(refHeader);
    return ref.host === originHost();
  } catch { return false; }
}

function haConfigured() {
  return Boolean(config.homeassistant.url && config.homeassistant.token && config.homeassistant.cameraEntity);
}

async function proxyToHa(upstreamPath, req, reply, { bodyTimeout }) {
  const url = `${config.homeassistant.url}${upstreamPath}`;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.homeassistant.token}` },
      headersTimeout: 10_000,
      bodyTimeout,
    });
    reply.code(res.statusCode);
    const ct = res.headers['content-type'];
    if (ct) reply.header('content-type', Array.isArray(ct) ? ct[0] : ct);
    reply.header('cache-control', 'no-store');
    return reply.send(res.body);
  } catch (err) {
    req.log.warn({ err: err?.message, path: upstreamPath }, 'HA camera proxy failed');
    return reply.code(502).send('upstream error');
  }
}

export default async function cameraRoutes(app) {
  app.get('/camera/stream', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!cameraEnabled()) return reply.code(404).send('camera disabled');
    if (!haConfigured()) return reply.code(503).send('camera not configured');
    if (!refererAllowed(req)) return reply.code(403).send('referer not allowed');
    return proxyToHa(
      `/api/camera_proxy_stream/${encodeURIComponent(config.homeassistant.cameraEntity)}`,
      req, reply, { bodyTimeout: 0 },
    );
  });

  app.get('/camera/snapshot', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!cameraEnabled()) return reply.code(404).send('camera disabled');
    if (!haConfigured()) return reply.code(503).send('camera not configured');
    if (!refererAllowed(req)) return reply.code(403).send('referer not allowed');
    return proxyToHa(
      `/api/camera_proxy/${encodeURIComponent(config.homeassistant.cameraEntity)}`,
      req, reply, { bodyTimeout: 10_000 },
    );
  });
}
