import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

let db;

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
}
