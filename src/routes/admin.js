import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { requireAdmin, requireCsrfHeader } from '../auth.js';
import { openDatabase } from '../db.js';
import { config } from '../config.js';
import { isUlid } from '../log-utils.js';

const FIELD_TYPES = new Set(['text', 'textarea', 'checkbox', 'notice']);

const BACKFILL_THUMB_MAX = 512 * 1024;
const BACKFILL_THUMB_DIM = 512;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function backfillValidatePng(buf) {
  if (buf.length < 24) return false;
  if (!PNG_MAGIC.equals(buf.subarray(0, 8))) return false;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return false;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 && width <= BACKFILL_THUMB_DIM && height <= BACKFILL_THUMB_DIM;
}

export default async function adminRoutes(app) {
  app.get('/api/admin/quotes', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const rows = db.prepare(`
      SELECT q.id, q.phone, q.name, q.status, q.answers_json AS answersJson,
             q.created_at AS createdAt, q.deleted_at AS deletedAt,
             COALESCE(u.withdrawn_email, u.email) AS userEmail,
             u.name AS userName,
             u.withdrawn_at AS userWithdrawnAt
      FROM quotes q JOIN users u ON q.user_id = u.id
      ORDER BY q.created_at DESC
      LIMIT 500
    `).all();
    const files = db.prepare(`
      SELECT id, quote_id AS quoteId, filename, size_bytes AS sizeBytes,
             triangle_count AS triangleCount, file_path AS filePath,
             thumb_path AS thumbPath, deleted_at AS deletedAt,
             is_watertight AS isWatertight,
             boundary_edges AS boundaryEdges,
             non_manifold_edges AS nonManifoldEdges
      FROM quote_files
      WHERE quote_id IN (${rows.map(() => '?').join(',') || "''"})
      ORDER BY created_at ASC
    `).all(...rows.map((q) => q.id));

    const allUsers = db.prepare(`
      SELECT COALESCE(withdrawn_email, email) AS email, name
      FROM users ORDER BY email ASC
    `).all();

    return {
      users: allUsers.map((u) => ({ email: u.email, name: u.name ?? '' })),
      quotes: rows.map((q) => ({
        id: q.id,
        userEmail: q.userEmail,
        userName: q.userName ?? '',
        phone: q.phone,
        name: q.name,
        status: q.status,
        answers: JSON.parse(q.answersJson),
        createdAt: q.createdAt,
        deletedAt: q.deletedAt,
        userWithdrawnAt: q.userWithdrawnAt,
        files: files.filter((f) => f.quoteId === q.id).map((f) => ({
          id: f.id,
          filename: f.filename,
          sizeBytes: f.sizeBytes,
          triangleCount: f.triangleCount,
          hasModel: !!f.filePath && !f.deletedAt,
          deletedAt: f.deletedAt,
          stlUrl: f.filePath && !f.deletedAt ? `/uploads/${f.quoteId}/${f.id}.stl` : null,
          thumbUrl: f.thumbPath ? `/thumbs/${f.quoteId}/${f.id}.png` : null,
          isWatertight: f.isWatertight === null || f.isWatertight === undefined ? null : !!f.isWatertight,
          boundaryEdges: f.boundaryEdges ?? null,
          nonManifoldEdges: f.nonManifoldEdges ?? null,
        })),
      })),
    };
  });

  app.delete('/api/admin/quotes/:id', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { id } = req.params;
    if (!isUlid(id)) return reply.code(400).send({ error: 'invalid id' });
    const db = openDatabase();
    const files = db.prepare('SELECT file_path, thumb_path FROM quote_files WHERE quote_id = ?').all(id);
    const res = db.prepare('DELETE FROM quotes WHERE id = ?').run(id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not found' });
    for (const f of files) {
      if (f.file_path && insideDataDir(f.file_path)) { try { await fs.unlink(f.file_path); } catch {} }
      if (f.thumb_path && insideDataDir(f.thumb_path)) { try { await fs.unlink(f.thumb_path); } catch {} }
    }
    for (const sub of ['uploads', 'thumbs']) {
      const d = path.join(config.dataDir, sub, id);
      if (insideDataDir(d)) { try { await fs.rmdir(d); } catch {} }
    }
    return { ok: true };
  });

  app.get('/api/admin/backfill/list', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const rows = db.prepare(`
      SELECT qf.id, qf.quote_id AS quoteId, qf.filename,
             qf.file_path AS filePath,
             qf.thumb_path AS thumbPath,
             qf.is_watertight AS isWatertight
      FROM quote_files qf
      JOIN quotes q ON q.id = qf.quote_id
      WHERE qf.deleted_at IS NULL
        AND qf.file_path IS NOT NULL
        AND q.deleted_at IS NULL
        AND (qf.thumb_path IS NULL OR qf.is_watertight IS NULL)
      ORDER BY qf.created_at ASC
    `).all();
    return {
      files: rows.map((r) => ({
        quoteId: r.quoteId,
        fileId: r.id,
        filename: r.filename,
        stlUrl: `/uploads/${r.quoteId}/${r.id}.stl`,
        missingThumb: !r.thumbPath,
        missingWatertight: r.isWatertight === null || r.isWatertight === undefined,
      })),
    };
  });

  app.post('/api/admin/backfill/update/:quoteId/:fileId', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { quoteId, fileId } = req.params;
    if (!isUlid(quoteId) || !isUlid(fileId)) return reply.code(400).send({ error: 'invalid id' });
    const db = openDatabase();
    const existing = db.prepare(`
      SELECT file_path AS filePath
      FROM quote_files
      WHERE id = ? AND quote_id = ? AND deleted_at IS NULL
    `).get(fileId, quoteId);
    if (!existing || !existing.filePath) return reply.code(404).send({ error: 'not found' });

    let newThumbPath = null;
    let watertight = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field' && part.fieldname === 'watertight') {
          const value = typeof part.value === 'string' ? part.value : '';
          try {
            const data = JSON.parse(value);
            watertight = {
              isWatertight: typeof data.isWatertight === 'boolean' ? data.isWatertight : null,
              boundaryEdges: Number.isFinite(data.boundaryEdges) ? Math.max(0, Math.trunc(data.boundaryEdges)) : 0,
              nonManifoldEdges: Number.isFinite(data.nonManifoldEdges) ? Math.max(0, Math.trunc(data.nonManifoldEdges)) : 0,
            };
          } catch { /* ignore malformed */ }
          continue;
        }
        if (part.fieldname === 'thumb') {
          const chunks = [];
          let size = 0;
          let overflow = false;
          for await (const chunk of part.file) {
            size += chunk.length;
            if (size > BACKFILL_THUMB_MAX) { overflow = true; break; }
            chunks.push(chunk);
          }
          if (overflow) {
            req.log.warn({ fileId, size }, 'backfill thumb too large, discarded');
            continue;
          }
          const buf = Buffer.concat(chunks);
          if (!backfillValidatePng(buf)) {
            req.log.warn({ fileId }, 'backfill thumb validation failed');
            continue;
          }
          const thumbsBase = path.join(config.dataDir, 'thumbs', quoteId);
          await fs.mkdir(thumbsBase, { recursive: true });
          const target = path.join(thumbsBase, `${fileId}.png`);
          await fs.writeFile(target, buf);
          newThumbPath = target;
          continue;
        }
        part.file?.resume();
      }
    } catch (err) {
      req.log.warn({ err }, 'backfill multipart parsing failed');
      return reply.code(400).send({ error: 'upload error' });
    }

    if (!newThumbPath && !watertight) {
      return reply.code(400).send({ error: 'nothing to update' });
    }

    const tx = db.transaction(() => {
      if (newThumbPath) {
        db.prepare('UPDATE quote_files SET thumb_path = ? WHERE id = ? AND quote_id = ?')
          .run(newThumbPath, fileId, quoteId);
      }
      if (watertight) {
        db.prepare(`
          UPDATE quote_files
          SET is_watertight = ?, boundary_edges = ?, non_manifold_edges = ?
          WHERE id = ? AND quote_id = ?
        `).run(
          watertight.isWatertight === null ? null : (watertight.isWatertight ? 1 : 0),
          watertight.boundaryEdges,
          watertight.nonManifoldEdges,
          fileId, quoteId,
        );
      }
    });
    tx();

    return { ok: true, updated: { thumb: !!newThumbPath, watertight: !!watertight } };
  });

  app.delete('/api/admin/quotes/:id/files/:fileId/model', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { id, fileId } = req.params;
    if (!isUlid(id) || !isUlid(fileId)) return reply.code(400).send({ error: 'invalid id' });
    const db = openDatabase();
    const row = db.prepare(`
      SELECT file_path, thumb_path FROM quote_files WHERE id = ? AND quote_id = ?
    `).get(fileId, id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.file_path && insideDataDir(row.file_path)) {
      try { await fs.unlink(row.file_path); } catch { /* ignore */ }
    }
    if (row.thumb_path && insideDataDir(row.thumb_path)) {
      try { await fs.unlink(row.thumb_path); } catch { /* ignore */ }
    }
    db.prepare(`
      UPDATE quote_files SET file_path = NULL, thumb_path = NULL, deleted_at = ? WHERE id = ?
    `).run(Date.now(), fileId);
    return { ok: true };
  });

  app.get('/api/admin/form-fields', { preHandler: requireAdmin }, async () => {
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

  app.post('/api/admin/form-fields', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { type, label, required, displayOrder, options } = req.body ?? {};
    if (!FIELD_TYPES.has(type)) return reply.code(400).send({ error: 'invalid type' });
    if (!label) return reply.code(400).send({ error: 'label required' });
    const db = openDatabase();
    const id = ulid();
    db.prepare(`
      INSERT INTO form_fields (id, display_order, type, label, required, options_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      Number(displayOrder ?? 0),
      String(type),
      String(label),
      required ? 1 : 0,
      options ? JSON.stringify(options) : null,
    );
    return { id };
  });

  app.put('/api/admin/form-fields/:id', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { id } = req.params;
    if (!isUlid(id)) return reply.code(400).send({ error: 'invalid id' });
    const { type, label, required, displayOrder, options } = req.body ?? {};
    if (type !== undefined && !FIELD_TYPES.has(type)) {
      return reply.code(400).send({ error: 'invalid type' });
    }
    const db = openDatabase();
    const res = db.prepare(`
      UPDATE form_fields
      SET display_order = ?, type = ?, label = ?, required = ?, options_json = ?
      WHERE id = ?
    `).run(
      Number(displayOrder ?? 0),
      String(type ?? 'text'),
      String(label ?? ''),
      required ? 1 : 0,
      options ? JSON.stringify(options) : null,
      id,
    );
    if (res.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/admin/form-fields/:id', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { id } = req.params;
    if (!isUlid(id)) return reply.code(400).send({ error: 'invalid id' });
    const db = openDatabase();
    const res = db.prepare('DELETE FROM form_fields WHERE id = ?').run(id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return { settings: out };
  });

  app.put('/api/admin/settings', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req) => {
    const db = openDatabase();
    const body = req.body ?? {};
    const allowed = new Set(['camera_enabled', 'home_html']);
    const upsert = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = db.transaction(() => {
      for (const [k, v] of Object.entries(body)) {
        if (!allowed.has(k)) continue;
        upsert.run(k, String(v));
      }
    });
    tx();
    return { ok: true };
  });
}

function insideDataDir(p) {
  const abs = path.resolve(p);
  const base = path.resolve(config.dataDir);
  return abs === base || abs.startsWith(base + path.sep);
}
