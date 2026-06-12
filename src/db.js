import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { ulid } from 'ulid';
import { config } from './config.js';

let db;

// Append a row to sms_log. Best-effort: a logging failure must never break a send.
export function recordSmsLog(db, { quoteId, name, phone, kind, msgType, subject, content, ok, statusCode }) {
  try {
    db.prepare(`
      INSERT INTO sms_log (id, quote_id, name, phone, kind, msg_type, subject, content, ok, status_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ulid(), quoteId ?? null, name ?? null, phone ?? null, kind ?? null,
      msgType ?? null, subject ?? null, content ?? null, ok ? 1 : 0, statusCode ?? null, Date.now(),
    );
  } catch { /* ignore */ }
}

export function openDatabase() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'db.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      answers_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_user ON quotes(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at DESC);

    CREATE TABLE IF NOT EXISTS quote_files (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      triangle_count INTEGER,
      file_path TEXT,
      thumb_path TEXT,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_quote ON quote_files(quote_id);

    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS form_fields (
      id TEXT PRIMARY KEY,
      display_order INTEGER NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      options_json TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id TEXT PRIMARY KEY,
      quote_id TEXT,
      name TEXT,
      phone TEXT,
      kind TEXT,
      msg_type TEXT,
      subject TEXT,
      content TEXT,
      ok INTEGER NOT NULL,
      status_code INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_smslog_created ON sms_log(created_at DESC);
  `);

  const existing = db.prepare('SELECT COUNT(*) AS c FROM settings').get();
  if (existing.c === 0) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('camera_enabled', '0');
  }

  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.find((c) => c.name === 'withdrawn_at')) {
    db.exec('ALTER TABLE users ADD COLUMN withdrawn_at INTEGER');
  }
  if (!userCols.find((c) => c.name === 'withdrawn_email')) {
    db.exec('ALTER TABLE users ADD COLUMN withdrawn_email TEXT');
  }
  const quoteCols = db.prepare('PRAGMA table_info(quotes)').all();
  if (!quoteCols.find((c) => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE quotes ADD COLUMN deleted_at INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_quotes_deleted ON quotes(deleted_at)');
  }
  // Admin-entered quote calculation: filament usage (g/m), pricing (KRW), comment.
  // All nullable — existing quotes read back as NULL and render as blank.
  if (!quoteCols.find((c) => c.name === 'filament_g')) {
    db.exec('ALTER TABLE quotes ADD COLUMN filament_g REAL');
  }
  if (!quoteCols.find((c) => c.name === 'filament_m')) {
    db.exec('ALTER TABLE quotes ADD COLUMN filament_m REAL');
  }
  if (!quoteCols.find((c) => c.name === 'cost')) {
    db.exec('ALTER TABLE quotes ADD COLUMN cost INTEGER');
  }
  if (!quoteCols.find((c) => c.name === 'discount')) {
    db.exec('ALTER TABLE quotes ADD COLUMN discount INTEGER');
  }
  if (!quoteCols.find((c) => c.name === 'final_cost')) {
    db.exec('ALTER TABLE quotes ADD COLUMN final_cost INTEGER');
  }
  if (!quoteCols.find((c) => c.name === 'comment')) {
    db.exec('ALTER TABLE quotes ADD COLUMN comment TEXT');
  }
  const fileCols = db.prepare('PRAGMA table_info(quote_files)').all();
  if (!fileCols.find((c) => c.name === 'is_watertight')) {
    db.exec('ALTER TABLE quote_files ADD COLUMN is_watertight INTEGER');
  }
  if (!fileCols.find((c) => c.name === 'boundary_edges')) {
    db.exec('ALTER TABLE quote_files ADD COLUMN boundary_edges INTEGER');
  }
  if (!fileCols.find((c) => c.name === 'non_manifold_edges')) {
    db.exec('ALTER TABLE quote_files ADD COLUMN non_manifold_edges INTEGER');
  }
  // STL volume (mm³) and surface area (mm²) from the client WASM parser —
  // basis for the surface-area filament estimate.
  if (!fileCols.find((c) => c.name === 'volume_mm3')) {
    db.exec('ALTER TABLE quote_files ADD COLUMN volume_mm3 REAL');
  }
  if (!fileCols.find((c) => c.name === 'surface_area_mm2')) {
    db.exec('ALTER TABLE quote_files ADD COLUMN surface_area_mm2 REAL');
  }
}
