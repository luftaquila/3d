import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ulid } from 'ulid';
import { requireAuth, requireCsrfHeader } from '../auth.js';
import { openDatabase, recordSmsLog } from '../db.js';
import { config } from '../config.js';
import { validateStl, validate3mf } from '../stl-validate.js';
import { sendQuoteNotification } from '../brevo.js';
import { sendSms, sensConfigured, smsByteLength } from '../sens.js';
import { isUlid, maskEmail, maskPhone } from '../log-utils.js';

const PHONE_RE = /^[0-9+\-() ]{6,24}$/;
const mb = (n) => `${Math.round(n / (1024 * 1024))}MB`;

const MAX_THUMB_BYTES = 512 * 1024;
const MAX_THUMB_DIM = 512;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function validatePng(buf) {
  if (buf.length < 24) return { ok: false, reason: 'too short for PNG' };
  if (!PNG_MAGIC.equals(buf.subarray(0, 8))) return { ok: false, reason: 'not a PNG' };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return { ok: false, reason: 'missing IHDR' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0 || width > MAX_THUMB_DIM || height > MAX_THUMB_DIM) {
    return { ok: false, reason: `invalid dimensions ${width}x${height}` };
  }
  return { ok: true, width, height };
}

async function readThumbBuffer(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_THUMB_BYTES) {
      return { overflow: true, size };
    }
    chunks.push(chunk);
  }
  return { buf: Buffer.concat(chunks), size };
}

export default async function quoteRoutes(app) {
  app.get('/api/my-quotes', { preHandler: requireAuth }, async (req) => {
    const db = openDatabase();
    const quotes = db.prepare(`
      SELECT id, phone, name, status, answers_json AS answersJson, created_at AS createdAt,
             filament_g AS filamentG, filament_m AS filamentM,
             cost, discount, final_cost AS finalCost, comment
      FROM quotes
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(req.auth.userId);
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
      WHERE quote_id IN (${quotes.map(() => '?').join(',') || "''"})
      ORDER BY created_at ASC
    `).all(...quotes.map((q) => q.id));
    return {
      quotes: quotes.map((q) => ({
        id: q.id,
        phone: q.phone,
        name: q.name,
        status: q.status,
        answers: JSON.parse(q.answersJson),
        createdAt: q.createdAt,
        filamentG: q.filamentG,
        filamentM: q.filamentM,
        cost: q.cost,
        discount: q.discount,
        finalCost: q.finalCost,
        comment: q.comment,
        files: files.filter((f) => f.quoteId === q.id).map(fileView),
      })),
    };
  });

  app.post('/api/quotes', {
    preHandler: [requireAuth, requireCsrfHeader],
    config: {
      rateLimit: { max: 5, timeWindow: '1 hour' },
    },
  }, async (req, reply) => {
    const db = openDatabase();

    const quoteId = ulid();
    const uploadsBase = path.join(config.dataDir, 'uploads', quoteId);
    const thumbsBase = path.join(config.dataDir, 'thumbs', quoteId);
    await fs.mkdir(uploadsBase, { recursive: true });
    await fs.mkdir(thumbsBase, { recursive: true });

    let phone = '';
    let name = '';
    let consented = false;
    const answers = {};
    const acceptedFiles = [];
    let totalBytes = 0;
    let fileCount = 0;
    let aborted = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          const key = String(part.fieldname);
          const value = typeof part.value === 'string' ? part.value : '';
          if (key === 'phone') phone = value.trim();
          else if (key === 'name') name = value.trim();
          else if (key === 'consent') consented = value === '1' || value === 'true' || value === 'on';
          else if (key.startsWith('answer.')) answers[key.slice(7)] = value;
          else if (key === 'watertight') attachFileMeta(acceptedFiles, value);
          continue;
        }

        if (part.fieldname === 'thumb') {
          const target = acceptedFiles[acceptedFiles.length - 1];
          if (!target || target.thumbPath || aborted) {
            part.file.resume();
            continue;
          }
          const result = await readThumbBuffer(part.file);
          if (result.overflow) {
            req.log.warn({ fileId: target.id, size: result.size, limit: MAX_THUMB_BYTES }, 'thumb exceeds size limit, discarded');
            continue;
          }
          const check = validatePng(result.buf);
          if (!check.ok) {
            req.log.warn({ fileId: target.id, reason: check.reason }, 'thumb validation failed');
            continue;
          }
          const thumbPath = path.join(thumbsBase, `${target.id}.png`);
          try {
            await fs.writeFile(thumbPath, result.buf);
            target.thumbPath = thumbPath;
          } catch (err) {
            req.log.warn({ err }, 'thumb write failed');
            await safeUnlink(thumbPath);
          }
          continue;
        }
        if (part.fieldname !== 'files') {
          part.file.resume();
          continue;
        }
        fileCount += 1;
        if (fileCount > config.limits.maxFilesPerQuote) {
          aborted = `파일 개수 제한(${config.limits.maxFilesPerQuote}) 초과`;
          part.file.resume();
          continue;
        }
        const origName = String(part.filename || '').toLowerCase();
        const is3mf = origName.endsWith('.3mf');
        if (!origName.endsWith('.stl') && !is3mf) {
          aborted = 'STL 또는 3MF 파일만 허용됩니다.';
          part.file.resume();
          continue;
        }

        const fileId = ulid();
        const filePath = path.join(uploadsBase, `${fileId}.stl`);
        let size = 0;
        const ws = fsSync.createWriteStream(filePath);
        part.file.on('data', (chunk) => {
          size += chunk.length;
        });
        try {
          await pipeline(part.file, ws);
        } catch (err) {
          aborted = '파일 업로드 실패';
          await safeUnlink(filePath);
          continue;
        }
        if (part.file.truncated || size > config.limits.fileSizeBytes) {
          aborted = `파일 하나의 크기가 너무 큽니다 (최대 ${mb(config.limits.fileSizeBytes)}).`;
          await safeUnlink(filePath);
          continue;
        }
        totalBytes += size;
        if (totalBytes > config.limits.totalSizeBytes) {
          aborted = `업로드 총합 크기가 너무 큽니다 (최대 ${mb(config.limits.totalSizeBytes)}).`;
          await safeUnlink(filePath);
          continue;
        }

        const check = is3mf ? await validate3mf(filePath) : await validateStl(filePath);
        if (!check.ok) {
          aborted = `${is3mf ? '3MF' : 'STL'} 형식 검증 실패: ${check.reason}`;
          await safeUnlink(filePath);
          continue;
        }

        acceptedFiles.push({
          id: fileId,
          filename: sanitizeFilename(String(part.filename || `${fileId}.stl`)),
          size,
          triangleCount: check.triangleCount,
          filePath,
          thumbPath: null,
          isWatertight: null,
          boundaryEdges: null,
          nonManifoldEdges: null,
          volumeMm3: null,
          surfaceAreaMm2: null,
        });
      }
    } catch (err) {
      req.log.warn({ err }, 'multipart parsing failed');
      await cleanupUploads(acceptedFiles);
      if (err?.code === 'FST_FILES_LIMIT') {
        return reply.code(413).send({ error: `파일 개수가 너무 많습니다 (최대 ${config.limits.maxFilesPerQuote}개).` });
      }
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: `파일 하나의 크기가 너무 큽니다 (최대 ${mb(config.limits.fileSizeBytes)}).` });
      }
      return reply.code(400).send({ error: '업로드 처리 중 오류가 발생했습니다.' });
    }

    if (aborted) {
      await cleanupUploads(acceptedFiles);
      return reply.code(400).send({ error: aborted });
    }
    if (!phone || !PHONE_RE.test(phone)) {
      await cleanupUploads(acceptedFiles);
      return reply.code(400).send({ error: '전화번호 형식이 올바르지 않습니다.' });
    }
    if (!name) {
      await cleanupUploads(acceptedFiles);
      return reply.code(400).send({ error: '이름 또는 닉네임을 입력해주세요.' });
    }
    if (!consented) {
      await cleanupUploads(acceptedFiles);
      return reply.code(400).send({ error: '개인정보 수집 동의가 필요합니다.' });
    }
    if (acceptedFiles.length === 0) {
      return reply.code(400).send({ error: 'STL 파일을 최소 1개 업로드해주세요.' });
    }

    const validFieldIds = new Set(db.prepare('SELECT id FROM form_fields').all().map((r) => r.id));
    const filteredAnswers = {};
    for (const [k, v] of Object.entries(answers)) {
      if (validFieldIds.has(k)) filteredAnswers[k] = v;
    }

    const now = Date.now();
    const quotaQuery = db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS used
      FROM quote_files
      WHERE deleted_at IS NULL
        AND quote_id IN (SELECT id FROM quotes WHERE user_id = ?)
    `);
    const insertQuote = db.prepare(`
      INSERT INTO quotes (id, user_id, phone, name, status, answers_json, created_at)
      VALUES (?, ?, ?, ?, 'received', ?, ?)
    `);
    const insertFile = db.prepare(`
      INSERT INTO quote_files (id, quote_id, filename, size_bytes, triangle_count, file_path, thumb_path,
                               is_watertight, boundary_edges, non_manifold_edges, volume_mm3, surface_area_mm2, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let quotaExceeded = false;
    const tx = db.transaction(() => {
      const used = quotaQuery.get(req.auth.userId).used;
      if (used + totalBytes > config.limits.userQuotaBytes) {
        quotaExceeded = true;
        return;
      }
      insertQuote.run(quoteId, req.auth.userId, phone, name, JSON.stringify(filteredAnswers), now);
      for (const f of acceptedFiles) {
        insertFile.run(
          f.id, quoteId, f.filename, f.size, f.triangleCount, f.filePath, f.thumbPath ?? null,
          f.isWatertight === null ? null : (f.isWatertight ? 1 : 0),
          f.boundaryEdges,
          f.nonManifoldEdges,
          f.volumeMm3,
          f.surfaceAreaMm2,
          now,
        );
      }
    });
    try {
      tx.immediate();
    } catch (err) {
      await cleanupUploads(acceptedFiles);
      throw err;
    }

    if (quotaExceeded) {
      await cleanupUploads(acceptedFiles);
      return reply.code(413).send({ error: '사용자 업로드 용량 한도를 초과했습니다.' });
    }

    // Resolve form-field labels for the answers and the estimate config so the
    // admin notification carries the full submission, not just a file count.
    const fieldRows = db.prepare('SELECT id, label, type FROM form_fields ORDER BY display_order').all();
    const answerList = [];
    for (const f of fieldRows) {
      const raw = filteredAnswers[f.id];
      if (raw == null) continue;
      if (f.type === 'checkbox') {
        // Checkbox submits '1'/'0'. Show only when checked, and as a readable "예".
        if (raw === '1') answerList.push({ label: f.label, value: '예' });
        continue;
      }
      const v = String(raw).trim();
      if (v) answerList.push({ label: f.label, value: v });
    }
    const estRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('est_wall_mm','est_infill_pct','est_price_per_m')").all();
    const estMap = {};
    for (const r of estRows) estMap[r.key] = Number(r.value);
    const estimateConfig = {
      wallMm: Number.isFinite(estMap.est_wall_mm) ? estMap.est_wall_mm : 1.0,
      infillPct: Number.isFinite(estMap.est_infill_pct) ? estMap.est_infill_pct : 15,
      pricePerM: Number.isFinite(estMap.est_price_per_m) ? estMap.est_price_per_m : 500,
    };

    sendQuoteNotification(req.log, {
      quoteId,
      userEmail: req.auth.email,
      phone,
      name,
      fileCount: acceptedFiles.length,
      createdAt: now,
      files: acceptedFiles.map((f) => ({
        filename: f.filename,
        size: f.size,
        triangleCount: f.triangleCount,
        isWatertight: f.isWatertight,
        volumeMm3: f.volumeMm3,
        surfaceAreaMm2: f.surfaceAreaMm2,
      })),
      answers: answerList,
      estimateConfig,
    }).catch(() => {});

    // Optional auto-SMS to the customer on submit (admin-configurable preset).
    try {
      const enabled = db.prepare("SELECT value FROM settings WHERE key = 'sms_submit_enabled'").get()?.value === '1';
      const tpl = db.prepare("SELECT value FROM settings WHERE key = 'sms_submit_template'").get()?.value || '';
      if (enabled && tpl.trim() && sensConfigured()) {
        sendSms(req.log, { to: phone, content: tpl })
          .then((result) => recordSmsLog(db, {
            quoteId, name, phone, kind: '견적 접수',
            msgType: smsByteLength(tpl) > 90 ? 'LMS' : 'SMS',
            subject: null, content: tpl, ok: result.ok, statusCode: result.status,
          }))
          .catch(() => {});
      }
    } catch (err) {
      req.log.warn({ err }, 'submit sms check failed');
    }

    req.log.info({
      quoteId,
      user: maskEmail(req.auth.email),
      phone: maskPhone(phone),
      fileCount: acceptedFiles.length,
      thumbCount: acceptedFiles.filter((f) => f.thumbPath).length,
    }, 'quote created');

    return { id: quoteId, fileCount: acceptedFiles.length };
  });

  app.get('/uploads/:quoteId/:fileId.stl', { preHandler: requireAuth }, async (req, reply) => {
    const { quoteId, fileId } = req.params;
    if (!isUlid(quoteId) || !isUlid(fileId)) return reply.code(400).send('invalid id');
    const db = openDatabase();
    const row = db.prepare(`
      SELECT qf.file_path AS filePath, qf.filename, qf.deleted_at AS deletedAt,
             q.user_id AS ownerId, q.deleted_at AS quoteDeletedAt
      FROM quote_files qf JOIN quotes q ON qf.quote_id = q.id
      WHERE qf.id = ? AND qf.quote_id = ?
    `).get(fileId, quoteId);
    if (!row) return reply.code(404).send('not found');
    const isOwner = row.ownerId === req.auth.userId;
    if (!isOwner && !req.auth.isAdmin) return reply.code(403).send('forbidden');
    if (row.quoteDeletedAt && !req.auth.isAdmin) return reply.code(410).send('deleted');
    if (row.deletedAt || !row.filePath) return reply.code(410).send('file deleted');
    if (!insideDataDir(row.filePath)) return reply.code(500).send('bad path');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    reply.header('cache-control', 'private, max-age=0, no-store');
    return reply.send(fsSync.createReadStream(row.filePath));
  });

  app.get('/thumbs/:quoteId/:fileId.png', { preHandler: requireAuth }, async (req, reply) => {
    const { quoteId, fileId } = req.params;
    if (!isUlid(quoteId) || !isUlid(fileId)) return reply.code(400).send('invalid id');
    const db = openDatabase();
    const row = db.prepare(`
      SELECT qf.thumb_path AS thumbPath,
             q.user_id AS ownerId, q.deleted_at AS quoteDeletedAt
      FROM quote_files qf JOIN quotes q ON qf.quote_id = q.id
      WHERE qf.id = ? AND qf.quote_id = ?
    `).get(fileId, quoteId);
    if (!row) return reply.code(404).send('not found');
    const isOwner = row.ownerId === req.auth.userId;
    if (!isOwner && !req.auth.isAdmin) return reply.code(403).send('forbidden');
    if (row.quoteDeletedAt && !req.auth.isAdmin) return reply.code(410).send('deleted');
    if (!row.thumbPath || !insideDataDir(row.thumbPath)) return reply.code(404).send('not found');
    try {
      await fs.access(row.thumbPath);
    } catch {
      return reply.code(404).send('not found');
    }
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(fsSync.createReadStream(row.thumbPath));
  });

  app.delete('/api/my-quotes/:id', {
    preHandler: [requireAuth, requireCsrfHeader],
  }, async (req, reply) => {
    const { id } = req.params;
    if (!isUlid(id)) return reply.code(400).send({ error: 'invalid id' });
    const db = openDatabase();
    const res = db.prepare(`
      UPDATE quotes SET deleted_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(Date.now(), id, req.auth.userId);
    if (res.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/me', {
    preHandler: [requireAuth, requireCsrfHeader],
  }, async (req, reply) => {
    const db = openDatabase();
    const userId = req.auth.userId;
    const now = Date.now();
    // Soft-delete: move email aside so the same Google account can sign up fresh
    // while the old row stays visible to admins (with withdrawn_email preserved).
    db.prepare(`
      UPDATE users
      SET withdrawn_at = ?, withdrawn_email = email, email = 'w:' || id
      WHERE id = ? AND withdrawn_at IS NULL
    `).run(now, userId);
    req.session.delete();
    req.log.info({ user: maskEmail(req.auth.email) }, 'account withdrawn');
    return { ok: true };
  });
}

function fileView(f) {
  return {
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
  };
}

function attachFileMeta(acceptedFiles, rawValue) {
  const target = acceptedFiles[acceptedFiles.length - 1];
  if (!target) return;
  try {
    const data = JSON.parse(rawValue);
    if (typeof data.isWatertight === 'boolean') target.isWatertight = data.isWatertight;
    if (Number.isFinite(data.boundaryEdges)) target.boundaryEdges = Math.max(0, Math.trunc(data.boundaryEdges));
    if (Number.isFinite(data.nonManifoldEdges)) target.nonManifoldEdges = Math.max(0, Math.trunc(data.nonManifoldEdges));
    if (Number.isFinite(data.volume) && data.volume >= 0) target.volumeMm3 = data.volume;
    if (Number.isFinite(data.surfaceArea) && data.surfaceArea >= 0) target.surfaceAreaMm2 = data.surfaceArea;
  } catch { /* ignore malformed metadata */ }
}

function sanitizeFilename(name) {
  return name.replace(/[^\p{L}\p{N}._\- ()]/gu, '_').slice(0, 120);
}

function insideDataDir(p) {
  const abs = path.resolve(p);
  const base = path.resolve(config.dataDir);
  return abs === base || abs.startsWith(base + path.sep);
}

async function safeUnlink(p) {
  try { await fs.unlink(p); } catch { /* ignore */ }
}

async function cleanupUploads(files) {
  for (const f of files) {
    if (f.filePath) await safeUnlink(f.filePath);
    if (f.thumbPath) await safeUnlink(f.thumbPath);
  }
}
