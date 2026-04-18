import { openDatabase } from '../db.js';
import { currentSession } from '../auth.js';
import { config } from '../config.js';
import { issueStreamUrl } from './camera.js';

export default async function publicRoutes(app) {
  app.get('/api/me', async (req) => {
    const s = currentSession(req);
    if (!s) return { authenticated: false };
    return { authenticated: true, email: s.email, isAdmin: s.isAdmin };
  });

  app.get('/api/home', async () => {
    const db = openDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('home_html');
    const p = config.naverPlace;
    const place = (p.lat && p.lng && p.name) ? {
      lat: Number(p.lat), lng: Number(p.lng), name: p.name, address: p.address, url: p.url,
    } : null;
    return { html: row?.value ?? '', place, mapsClientId: p.mapsClientId || null };
  });

  app.get('/api/form-fields', async () => {
    const db = openDatabase();
    const rows = db.prepare(`
      SELECT id, display_order AS displayOrder, type, label, required, options_json AS optionsJson
      FROM form_fields
      ORDER BY display_order ASC
    `).all().map((r) => ({
      ...r,
      required: !!r.required,
      options: r.optionsJson ? JSON.parse(r.optionsJson) : null,
    }));
    return { fields: rows };
  });

  app.get('/api/camera/status', async (req, reply) => {
    const db = openDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('camera_enabled');
    const enabled = row?.value === '1';
    reply.header('cache-control', 'no-store');
    if (!enabled) return { enabled: false };
    return { enabled: true, streamUrl: issueStreamUrl(req.ip) };
  });
}
