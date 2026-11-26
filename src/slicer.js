// Background dispatcher for the cluster-internal slicer worker (slicer/).
//
// quote_files.slice_status: NULL (never queued) → 'pending' → 'running' →
// 'done' | 'failed'. One file at a time: the worker slices synchronously and
// answers 409 while busy. Results (JSON) are stored on the row; artifacts
// (sliced projects, candidates, previews) live under <dataDir>/slices/<quote>/<file>/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { request } from 'undici';
import { openDatabase } from './db.js';
import { config } from './config.js';

const POLL_MS = 10_000;
// Explore mode slices up to ~6 candidates × 6 objects plus two final passes;
// a dense mesh can take tens of seconds per pass.
const SLICE_TIMEOUT_MS = 60 * 60 * 1000;

let busy = false;
let started = false;

export function slicerConfigured() {
  return !!config.slicer.url;
}

export function slicesDir(quoteId, fileId) {
  return fileId
    ? path.join(config.dataDir, 'slices', quoteId, fileId)
    : path.join(config.dataDir, 'slices', quoteId);
}

// layout: null for a full automatic run, {arrange, objects:[{index, matrix}]},
// or {choose: {<object index>: <candidate id>}}
// from the web editor to re-slice exactly that placement.
export function enqueueSlices(db, fileIds, layout = null) {
  if (!slicerConfigured() || fileIds.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE quote_files
    SET slice_status = 'pending', slice_requested_at = ?, slice_error = NULL, slice_layout = ?
    WHERE id = ? AND file_path IS NOT NULL AND deleted_at IS NULL
      AND (slice_status IS NULL OR slice_status IN ('done', 'failed'))
  `);
  const now = Date.now();
  const layoutJson = layout ? JSON.stringify(layout) : null;
  let n = 0;
  for (const id of fileIds) n += stmt.run(now, layoutJson, id).changes;
  if (n > 0) setImmediate(tick);
  return n;
}

// Arrange all model files of a quote on shared plate(s) (layout: null for the
// automatic packing, or the layout editor's placement).
export function enqueuePlate(db, quoteId, layout = null) {
  if (!slicerConfigured()) return 0;
  const n = db.prepare(`
    UPDATE quotes SET plate_status = 'pending', plate_requested_at = ?, plate_error = NULL, plate_layout = ?
    WHERE id = ? AND deleted_at IS NULL AND (plate_status IS NULL OR plate_status IN ('done', 'failed'))
  `).run(Date.now(), layout ? JSON.stringify(layout) : null, quoteId).changes;
  if (n > 0) setImmediate(tick);
  return n;
}

export async function removeSlices(quoteId, fileId) {
  const dir = slicesDir(quoteId, fileId);
  const base = path.resolve(config.dataDir, 'slices');
  if (!path.resolve(dir).startsWith(base + path.sep)) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

let log = console;

export function startSliceDispatcher(logger) {
  log = logger;
  if (!slicerConfigured()) {
    log.info('slicer: SLICER_URL not set, auto-slicing disabled');
    return;
  }
  if (started) return;
  started = true;
  // A restart mid-job leaves rows 'running' forever; retry them.
  openDatabase().prepare("UPDATE quote_files SET slice_status = 'pending' WHERE slice_status = 'running'").run();
  openDatabase().prepare("UPDATE quotes SET plate_status = 'pending' WHERE plate_status = 'running'").run();
  setInterval(tick, POLL_MS).unref();
  setImmediate(tick);
}

async function tick() {
  if (busy || !started) return;
  busy = true;
  try {
    while (await runNext()) { /* drain the queue */ }
  } catch (err) {
    log.error({ err }, 'slicer: dispatcher error');
  } finally {
    busy = false;
  }
}

// Labels + values of the quote form, resolved like the admin notification.
function resolveAnswers(db, answersJson) {
  let answers = {};
  try { answers = JSON.parse(answersJson || '{}'); } catch { /* keep empty */ }
  const out = [];
  for (const f of db.prepare('SELECT id, label, type FROM form_fields ORDER BY display_order').all()) {
    const raw = answers[f.id];
    if (raw == null) continue;
    if (f.type === 'checkbox') {
      if (raw === '1') out.push({ label: f.label, value: '예' });
      continue;
    }
    const v = String(raw).trim();
    if (v) out.push({ label: f.label, value: v });
  }
  return out;
}

// A worker restart (deploy, crash, OOM) drops the connection mid-job. That says
// nothing about the file, so the job is queued again for a while before
// it is reported as failed.
const TRANSPORT_RETRIES = 6; // ~1 min at the 10 s poll, enough for a worker restart
const transportFailures = new Map(); // fileId -> count
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED',
]);

// slice_layout holds a manual layout, {choose: {index: candidate}}, or
// {reuse: true} (same placement as last time, e.g. for new settings).
function redo(json) {
  if (!json) return {};
  const saved = JSON.parse(json);
  if (saved.choose) return { choose: saved.choose };
  if (saved.reuse) return { reuse: true };
  return { layout: saved };
}

// Next queued job, oldest request first: a file of a quote, or a quote's
// shared plate (all its files arranged together, see enqueuePlate).
async function runNext() {
  const db = openDatabase();
  const file = db.prepare(`
    SELECT qf.id, qf.quote_id AS quoteId, qf.filename, qf.file_path AS filePath,
           qf.slice_layout AS layoutJson, qf.slice_settings AS settingsJson,
           qf.slice_requested_at AS at, q.answers_json AS answersJson
    FROM quote_files qf JOIN quotes q ON q.id = qf.quote_id
    WHERE qf.slice_status = 'pending' AND qf.file_path IS NOT NULL AND qf.deleted_at IS NULL
    ORDER BY qf.slice_requested_at ASC
    LIMIT 1
  `).get();
  const plate = db.prepare(`
    SELECT id AS quoteId, plate_layout AS layoutJson, plate_settings AS settingsJson, plate_requested_at AS at
    FROM quotes WHERE plate_status = 'pending' AND deleted_at IS NULL
    ORDER BY plate_requested_at ASC LIMIT 1
  `).get();
  if (!file && !plate) return false;
  return plate && (!file || plate.at < file.at) ? runJob(db, plateJob(db, plate)) : runJob(db, fileJob(db, file));
}

function fileJob(db, row) {
  return {
    key: row.id,
    log: { fileId: row.id },
    body: {
      quoteId: row.quoteId,
      fileId: row.id,
      path: row.filePath,
      filename: row.filename,
      answers: resolveAnswers(db, row.answersJson),
      ...redo(row.layoutJson),
      ...(row.settingsJson ? { settings: JSON.parse(row.settingsJson) } : {}),
    },
    setStatus: (status, onlyIfRunning) => db.prepare(
      `UPDATE quote_files SET slice_status = ? WHERE id = ?${onlyIfRunning ? " AND slice_status = 'running'" : ''}`,
    ).run(status, row.id),
    // The file may have been deleted while slicing; don't resurrect its row,
    // and drop the artifacts the worker just wrote for it.
    finish: async (status, resultJson, error) => {
      const upd = db.prepare(`
        UPDATE quote_files SET slice_status = ?, slice_json = ?, slice_error = ?, sliced_at = ?
        WHERE id = ? AND slice_status = 'running' AND deleted_at IS NULL
      `).run(status, resultJson, error, Date.now(), row.id);
      if (upd.changes === 0) await removeSlices(row.quoteId, row.id);
    },
  };
}

function plateJob(db, row) {
  const files = db.prepare(`
    SELECT id AS fileId, file_path AS path, filename FROM quote_files
    WHERE quote_id = ? AND file_path IS NOT NULL AND deleted_at IS NULL
    ORDER BY created_at ASC
  `).all(row.quoteId);
  return {
    key: `plate:${row.quoteId}`,
    log: { quoteId: row.quoteId, plate: true },
    tooFew: files.length < 2,
    body: {
      quoteId: row.quoteId,
      plate: { files },
      ...(row.layoutJson ? { layout: JSON.parse(row.layoutJson) } : {}),
      ...(row.settingsJson ? { settings: JSON.parse(row.settingsJson) } : {}),
    },
    setStatus: (status, onlyIfRunning) => db.prepare(
      `UPDATE quotes SET plate_status = ? WHERE id = ?${onlyIfRunning ? " AND plate_status = 'running'" : ''}`,
    ).run(status, row.quoteId),
    finish: async (status, resultJson, error) => {
      const upd = db.prepare(`
        UPDATE quotes SET plate_status = ?, plate_json = ?, plate_error = ?, plated_at = ?
        WHERE id = ? AND plate_status = 'running' AND deleted_at IS NULL
      `).run(status, resultJson, error, Date.now(), row.quoteId);
      if (upd.changes === 0) await removeSlices(row.quoteId, 'plate');
    },
  };
}

async function runJob(db, job) {
  job.setStatus('running');
  const t0 = Date.now();
  let status = 'failed';
  let resultJson = null;
  let error = null;
  if (job.tooFew) {
    await job.finish('failed', null, '모델 파일이 2개 이상이어야 합칠 수 있습니다.');
    return true;
  }
  try {
    const res = await request(`${config.slicer.url}/slice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job.body),
      headersTimeout: SLICE_TIMEOUT_MS,
      bodyTimeout: SLICE_TIMEOUT_MS,
    });
    if (res.statusCode === 409) {
      // Worker busy (e.g. a manual run): put it back and retry next poll.
      await res.body.dump().catch(() => {});
      job.setStatus('pending', true);
      return false;
    }
    if (res.statusCode !== 200) {
      await res.body.dump().catch(() => {});
      throw new Error(`slicer HTTP ${res.statusCode}`);
    }
    const result = await res.body.json();
    status = result.status === 'done' ? 'done' : 'failed';
    error = result.error ?? null;
    resultJson = JSON.stringify(result);
  } catch (err) {
    error = String(err?.message || err);
    if (TRANSPORT_CODES.has(err?.code)) {
      const n = (transportFailures.get(job.key) || 0) + 1;
      if (n <= TRANSPORT_RETRIES) {
        transportFailures.set(job.key, n);
        job.setStatus('pending', true);
        log.warn({ ...job.log, code: err.code, attempt: n }, 'slicer: connection lost, requeued');
        return false;
      }
      error = `슬라이서 연결이 끊겼습니다 (${err.code}, ${n}회)`;
    }
  }
  transportFailures.delete(job.key);
  await job.finish(status, resultJson, error);
  log.info({ ...job.log, status, ms: Date.now() - t0, error }, 'slicer: job finished');
  return true;
}
