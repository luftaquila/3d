import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { requireAdmin, requireCsrfHeader } from '../auth.js';
import { openDatabase, recordSmsLog } from '../db.js';
import { config } from '../config.js';
import { isUlid, maskPhone } from '../log-utils.js';
import { sendSms, sensConfigured, smsByteLength } from '../sens.js';
import { sendAlimtalk, alimtalkConfigured, getAlimtalkTemplates } from '../alimtalk.js';

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

async function readPngWidth(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead < 24) return null;
    if (!PNG_MAGIC.equals(buf.subarray(0, 8))) return null;
    if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    return buf.readUInt32BE(16);
  } catch { return null; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

export default async function adminRoutes(app) {
  app.get('/api/admin/quotes', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const rows = db.prepare(`
      SELECT q.id, q.phone, q.name, q.status, q.answers_json AS answersJson,
             q.created_at AS createdAt, q.deleted_at AS deletedAt,
             q.filament_g AS filamentG, q.filament_m AS filamentM,
             q.cost, q.discount, q.final_cost AS finalCost, q.comment,
             NOT EXISTS (SELECT 1 FROM quotes q2 WHERE q2.user_id = q.user_id AND q2.created_at < q.created_at) AS isFirst,
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
             non_manifold_edges AS nonManifoldEdges,
             volume_mm3 AS volumeMm3,
             surface_area_mm2 AS surfaceAreaMm2
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
        isFirst: !!q.isFirst,
        filamentG: q.filamentG,
        filamentM: q.filamentM,
        cost: q.cost,
        discount: q.discount,
        finalCost: q.finalCost,
        comment: q.comment,
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
          volumeMm3: f.volumeMm3 ?? null,
          surfaceAreaMm2: f.surfaceAreaMm2 ?? null,
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

  // Admin-entered quote calculation. Full replace of the six fields; an empty
  // or missing value clears the column. Numbers must be non-negative finite.
  app.patch('/api/admin/quotes/:id', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const { id } = req.params;
    if (!isUlid(id)) return reply.code(400).send({ error: 'invalid id' });
    const body = req.body ?? {};

    const parseNum = (v, int) => {
      if (v === null || v === undefined || v === '') return { ok: true, value: null };
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { ok: false };
      return { ok: true, value: int ? Math.round(n) : n };
    };
    const filamentG = parseNum(body.filamentG, false);
    const filamentM = parseNum(body.filamentM, false);
    const cost = parseNum(body.cost, true);
    const discount = parseNum(body.discount, true);
    const finalCost = parseNum(body.finalCost, true);
    if ([filamentG, filamentM, cost, discount, finalCost].some((r) => !r.ok)) {
      return reply.code(400).send({ error: '숫자 값이 올바르지 않습니다.' });
    }
    if (discount.value !== null && discount.value > 100) {
      return reply.code(400).send({ error: '할인율은 0~100% 범위여야 합니다.' });
    }
    let comment = body.comment;
    if (comment === undefined || comment === null || comment === '') comment = null;
    else {
      comment = String(comment);
      if (comment.length > 2000) return reply.code(400).send({ error: '코멘트가 너무 깁니다.' });
    }

    const db = openDatabase();
    const res = db.prepare(`
      UPDATE quotes
      SET filament_g = ?, filament_m = ?, cost = ?, discount = ?, final_cost = ?, comment = ?
      WHERE id = ?
    `).run(filamentG.value, filamentM.value, cost.value, discount.value, finalCost.value, comment, id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // Send an admin-composed SMS to the quote's contact number via Naver SENS.
  app.post('/api/admin/quotes/:id/send-sms', {
    preHandler: [requireAdmin, requireCsrfHeader],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { id } = req.params;
    if (!isUlid(id)) return reply.code(400).send({ error: 'invalid id' });

    const channel = req.body?.channel === 'alimtalk' ? 'alimtalk' : 'sms';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return reply.code(400).send({ error: '메시지를 입력해주세요.' });
    if (smsByteLength(message) > 2000) {
      return reply.code(400).send({ error: '메시지가 너무 깁니다 (LMS 2000바이트 초과).' });
    }
    const kind = typeof req.body?.kind === 'string' ? req.body.kind.slice(0, 40) : '수동';

    const db = openDatabase();
    const quote = db.prepare('SELECT phone, name FROM quotes WHERE id = ?').get(id);
    if (!quote) return reply.code(404).send({ error: 'not found' });
    const digits = String(quote.phone || '').replace(/\D/g, '');
    if (digits.length < 9) return reply.code(400).send({ error: '전화번호가 올바르지 않습니다.' });

    let result;
    let msgType;
    if (channel === 'alimtalk') {
      if (!alimtalkConfigured()) return reply.code(400).send({ error: '알림톡이 설정되지 않았습니다.' });
      const templateCode = typeof req.body?.templateCode === 'string' ? req.body.templateCode.trim() : '';
      if (!templateCode) return reply.code(400).send({ error: '알림톡 템플릿을 선택해주세요.' });
      // Buttons come from the NCP-registered template (fixed links), never the client.
      const tpls = await getAlimtalkTemplates(req.log);
      const tpl = tpls.find((t) => t.code === templateCode);
      result = await sendAlimtalk(req.log, { to: digits, templateCode, content: message, buttons: tpl?.buttons || [] });
      msgType = '알림톡';
    } else {
      if (!sensConfigured()) return reply.code(400).send({ error: 'SMS가 설정되지 않았습니다.' });
      result = await sendSms(req.log, { to: digits, content: message });
      msgType = smsByteLength(message) > 90 ? 'LMS' : 'SMS';
    }
    recordSmsLog(db, {
      quoteId: id, name: quote.name, phone: quote.phone, kind,
      msgType, subject: null, content: message, ok: result.ok, statusCode: result.status,
    });
    if (!result.ok) {
      req.log.warn({ quoteId: id, phone: maskPhone(quote.phone), channel, status: result.status }, 'admin message send failed');
      return reply.code(502).send({ error: `${channel === 'alimtalk' ? '알림톡' : 'SMS'} 전송 실패 (${result.status || 'network'})` });
    }
    req.log.info({ quoteId: id, phone: maskPhone(quote.phone), channel }, 'admin message sent');
    return { ok: true };
  });

  // Admin SMS send log + simple stats (admin-only; stores full detail).
  app.get('/api/admin/sms-log', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const entries = db.prepare(`
      SELECT id, quote_id AS quoteId, name, phone, kind, msg_type AS msgType,
             subject, content, ok, status_code AS statusCode, created_at AS createdAt
      FROM sms_log ORDER BY created_at DESC LIMIT 200
    `).all().map((r) => ({ ...r, ok: !!r.ok }));
    const agg = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok FROM sms_log').get();
    const total = agg.total ?? 0;
    const ok = agg.ok ?? 0;
    return { stats: { total, ok, fail: total - ok }, entries };
  });

  // Member list with per-user stats (signup, quote count, revenue from final_cost).
  app.get('/api/admin/members', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const rows = db.prepare(`
      SELECT u.id, COALESCE(u.withdrawn_email, u.email) AS email, u.name,
             u.created_at AS createdAt, u.withdrawn_at AS withdrawnAt,
             (SELECT COUNT(*) FROM quotes q WHERE q.user_id = u.id AND q.deleted_at IS NULL) AS quoteCount,
             (SELECT COALESCE(SUM(final_cost), 0) FROM quotes q WHERE q.user_id = u.id AND q.deleted_at IS NULL) AS revenue
      FROM users u
      ORDER BY u.created_at DESC
    `).all();
    return {
      members: rows.map((m) => ({
        email: m.email,
        name: m.name ?? '',
        createdAt: m.createdAt,
        withdrawn: !!m.withdrawnAt,
        quoteCount: m.quoteCount,
        revenue: m.revenue,
      })),
    };
  });

  app.get('/api/admin/backfill/list', { preHandler: requireAdmin }, async (req) => {
    // ?all=1 forces thumbnail regeneration for every model (e.g. re-render after
    // an orientation change), not just files missing a thumbnail.
    const force = req.query?.all === '1';
    const db = openDatabase();
    const rows = db.prepare(`
      SELECT qf.id, qf.quote_id AS quoteId, qf.filename,
             qf.file_path AS filePath,
             qf.thumb_path AS thumbPath,
             qf.is_watertight AS isWatertight,
             qf.volume_mm3 AS volumeMm3,
             qf.surface_area_mm2 AS surfaceAreaMm2
      FROM quote_files qf
      JOIN quotes q ON q.id = qf.quote_id
      WHERE qf.deleted_at IS NULL
        AND qf.file_path IS NOT NULL
        AND q.deleted_at IS NULL
      ORDER BY qf.created_at ASC
    `).all();

    const files = [];
    for (const r of rows) {
      let thumbStale = false;
      if (r.thumbPath) {
        const w = await readPngWidth(r.thumbPath);
        thumbStale = w !== null && w < BACKFILL_THUMB_DIM;
      }
      const missingThumb = !r.thumbPath || thumbStale;
      const missingWatertight = r.isWatertight === null || r.isWatertight === undefined;
      const missingVolume = r.volumeMm3 === null || r.volumeMm3 === undefined;
      const missingSurface = r.surfaceAreaMm2 === null || r.surfaceAreaMm2 === undefined;
      if (!force && !missingThumb && !missingWatertight && !missingVolume && !missingSurface) continue;
      files.push({
        quoteId: r.quoteId,
        fileId: r.id,
        filename: r.filename,
        stlUrl: `/uploads/${r.quoteId}/${r.id}.stl`,
        missingThumb: force || missingThumb,
        missingWatertight,
        missingVolume,
        missingSurface,
      });
    }
    return { files };
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
    let volumeMm3 = null;
    let surfaceAreaMm2 = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field' && part.fieldname === 'watertight') {
          const value = typeof part.value === 'string' ? part.value : '';
          try {
            const data = JSON.parse(value);
            if (typeof data.isWatertight === 'boolean') {
              watertight = {
                isWatertight: data.isWatertight,
                boundaryEdges: Number.isFinite(data.boundaryEdges) ? Math.max(0, Math.trunc(data.boundaryEdges)) : 0,
                nonManifoldEdges: Number.isFinite(data.nonManifoldEdges) ? Math.max(0, Math.trunc(data.nonManifoldEdges)) : 0,
              };
            }
            if (Number.isFinite(data.volume) && data.volume >= 0) volumeMm3 = data.volume;
            if (Number.isFinite(data.surfaceArea) && data.surfaceArea >= 0) surfaceAreaMm2 = data.surfaceArea;
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

    if (!newThumbPath && !watertight && volumeMm3 === null && surfaceAreaMm2 === null) {
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
          watertight.isWatertight ? 1 : 0,
          watertight.boundaryEdges,
          watertight.nonManifoldEdges,
          fileId, quoteId,
        );
      }
      if (volumeMm3 !== null) {
        db.prepare('UPDATE quote_files SET volume_mm3 = ? WHERE id = ? AND quote_id = ?')
          .run(volumeMm3, fileId, quoteId);
      }
      if (surfaceAreaMm2 !== null) {
        db.prepare('UPDATE quote_files SET surface_area_mm2 = ? WHERE id = ? AND quote_id = ?')
          .run(surfaceAreaMm2, fileId, quoteId);
      }
    });
    tx();

    return { ok: true, updated: { thumb: !!newThumbPath, watertight: !!watertight, volume: volumeMm3 !== null, surface: surfaceAreaMm2 !== null } };
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

  // Live AlimTalk templates from NCP (code, name, content, buttons, status).
  app.get('/api/admin/alimtalk-templates', { preHandler: requireAdmin }, async (req) => {
    if (!alimtalkConfigured()) return { configured: false, templates: [] };
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const templates = await getAlimtalkTemplates(req.log, refresh);
    return { configured: true, templates };
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    const db = openDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return {
      settings: out,
      capabilities: {
        sms: sensConfigured(),
        alimtalk: alimtalkConfigured(),
        plusFriendId: config.bizMessage.plusFriendId || '',
      },
    };
  });

  app.put('/api/admin/settings', {
    preHandler: [requireAdmin, requireCsrfHeader],
  }, async (req, reply) => {
    const db = openDatabase();
    const body = req.body ?? {};
    const allowed = new Set([
      'camera_enabled', 'camera_status_enabled', 'home_html', 'est_wall_mm', 'est_infill_pct', 'est_price_per_m',
      'message_channel', 'sms_template', 'sms_submit_enabled', 'sms_submit_template', 'sms_done_list',
      'alimtalk_submit_code',
    ]);
    const numericKeys = new Set(['est_wall_mm', 'est_infill_pct', 'est_price_per_m']);
    for (const [k, v] of Object.entries(body)) {
      if (numericKeys.has(k)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: `잘못된 값: ${k}` });
      }
    }
    // System-wide messaging channel: customer notifications go out as SMS or
    // AlimTalk (one or the other, see message_channel in the admin settings UI).
    if (body.message_channel !== undefined && !['sms', 'alimtalk'].includes(body.message_channel)) {
      return reply.code(400).send({ error: '잘못된 발송 방식입니다.' });
    }
    if (body.sms_done_list !== undefined) {
      try {
        const arr = JSON.parse(body.sms_done_list);
        if (!Array.isArray(arr) || arr.length > 20) throw new Error('bad');
        for (const it of arr) {
          if (!it || typeof it !== 'object') throw new Error('bad');
          if (String(it.title ?? '').length > 100 || String(it.content ?? '').length > 2000) throw new Error('bad');
        }
      } catch {
        return reply.code(400).send({ error: '메시지 템플릿 형식이 올바르지 않습니다.' });
      }
    }
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
