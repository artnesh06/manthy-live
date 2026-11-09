const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'manthy.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
let db = null;

// S3/R2 external backup (optional — set env vars to enable)
let s3Client = null;
const S3_BUCKET = process.env.BACKUP_S3_BUCKET;
const S3_REGION = process.env.BACKUP_S3_REGION || 'auto';
const S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT; // For R2: https://<account_id>.r2.cloudflarestorage.com
const S3_KEY = process.env.BACKUP_S3_KEY;
const S3_SECRET = process.env.BACKUP_S3_SECRET;

if (S3_BUCKET && S3_KEY && S3_SECRET) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT || undefined,
      credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
      forcePathStyle: true
    });
    console.log('[DB] S3/R2 external backup enabled →', S3_BUCKET);
  } catch(e) {
    console.warn('[DB] S3/R2 backup disabled — @aws-sdk/client-s3 not installed:', e.message);
  }
}

async function uploadBackupToS3(filePath, fileName) {
  if (!s3Client || !S3_BUCKET) return;
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const fileBuffer = fs.readFileSync(filePath);
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `manthy-backups/${fileName}`,
      Body: fileBuffer,
      ContentType: 'application/octet-stream'
    }));
    console.log(`[DB] Backup uploaded to S3/R2: ${fileName}`);
  } catch(e) {
    console.error('[DB] S3/R2 upload failed:', e.message);
  }
}

async function initDB() {
  const SQL = await initSqlJs();
  
  // Create backup dir
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log('[DB] Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database');
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      wallet TEXT PRIMARY KEY,
      mthy_balance REAL DEFAULT 0,
      avatar TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS staked_nfts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      token_id TEXT NOT NULL,
      collection_addr TEXT NOT NULL,
      name TEXT,
      image_url TEXT,
      hp INTEGER DEFAULT 100,
      staked_at TEXT DEFAULT (datetime('now')),
      last_fed TEXT DEFAULT (datetime('now')),
      last_earned TEXT DEFAULT (datetime('now')),
      UNIQUE(token_id, collection_addr)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS museum (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      collection_addr TEXT NOT NULL,
      name TEXT,
      image_url TEXT,
      original_owner TEXT,
      caught_by TEXT,
      reason TEXT,
      caught_at TEXT DEFAULT (datetime('now')),
      earn_rate REAL DEFAULT 16
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS feed_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      token_id TEXT NOT NULL,
      cost REAL DEFAULT 100,
      fed_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS game_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS wallet_nft_cache (
      wallet TEXT PRIMARY KEY,
      nfts TEXT,
      cached_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Winners table — stores the final 20 surviving NFTs
  db.run(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      collection_addr TEXT NOT NULL,
      wallet TEXT NOT NULL,
      name TEXT,
      image_url TEXT,
      hp INTEGER,
      days_survived INTEGER,
      claim_wallet TEXT,
      claim_address TEXT,
      claim_discord TEXT,
      claim_twitter TEXT,
      claimed_at TEXT,
      won_at TEXT DEFAULT (datetime('now')),
      UNIQUE(token_id, collection_addr)
    )
  `);

  // Catch log — recent catches for ticker notification
  db.run(`
    CREATE TABLE IF NOT EXISTS catch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      name TEXT,
      caught_by TEXT,
      original_owner TEXT,
      caught_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Audit log — immutable, append-only record of all game actions
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      wallet TEXT,
      token_id TEXT,
      target_wallet TEXT,
      amount REAL,
      detail TEXT,
      result TEXT DEFAULT 'success',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Default config
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('earn_rate_per_day', '80')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('feed_cost', '100')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('game_start', '" + new Date().toISOString() + "')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('max_survivors', '5')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('game_ended', '0')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('collection_cosmos', 'cosmos1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sf6pa77')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('collection_stars', 'stars1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sla963x')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('trait_bonuses', '[]')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('museum_earn', '16')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('token_name', '$MTHY')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('welcome_bonus', '300')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('catch_threshold', '10')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('min_played_to_end', '15')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('ticker_message', '')");
  db.run("INSERT OR IGNORE INTO game_config (key, value) VALUES ('ticker_expires_at', '')");

  // Migrate: add avatar and display_name columns if missing
  try { db.run("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT ''"); } catch(e) {}
  // Migrate: add traits column to staked_nfts if missing
  try { db.run("ALTER TABLE staked_nfts ADD COLUMN traits TEXT DEFAULT '[]'"); } catch(e) {}
  // Migrate: add welcome_claimed flag (one-time signup bonus, per user)
  try { db.run("ALTER TABLE users ADD COLUMN welcome_claimed INTEGER DEFAULT 0"); } catch(e) {}

  saveDB();
  console.log('[DB] Database initialized');
  return db;
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 30 seconds
setInterval(() => { if(db) saveDB(); }, 30000);

// Auto-backup every 6 hours (keep last 10 backups + upload to S3/R2)
setInterval(() => {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `manthy-${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, fileName);
    fs.writeFileSync(backupPath, buffer);
    
    // Keep only last 10 backups locally
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('manthy-') && f.endsWith('.db'))
      .sort()
      .reverse();
    for (let i = 10; i < files.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
    }
    console.log('[DB] Backup created:', backupPath);

    // Upload to S3/R2 (async, non-blocking)
    uploadBackupToS3(backupPath, fileName);
  } catch (e) {
    console.error('[DB] Backup failed:', e.message);
  }
}, 6 * 60 * 60 * 1000); // 6 hours

// Helper: run query and return changes
function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

// Helper: get one row
function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

// Helper: get all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: get config value with fallback (numeric)
function getConfig(key, fallback) {
  const row = get("SELECT value FROM game_config WHERE key = ?", [key]);
  return row ? Number(row.value) || fallback : fallback;
}

// Helper: get config value as string
function getConfigStr(key, fallback) {
  const row = get("SELECT value FROM game_config WHERE key = ?", [key]);
  return row ? row.value : fallback;
}

// Helper: run multiple operations in a transaction (prevents race conditions)
function transaction(fn) {
  db.run('BEGIN TRANSACTION');
  try {
    const result = fn();
    db.run('COMMIT');
    saveDB();
    return result;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

// Helper: append to immutable audit log (never delete/update these)
function auditLog(action, { wallet, tokenId, targetWallet, amount, detail, result } = {}) {
  try {
    db.run(
      "INSERT INTO audit_log (action, wallet, token_id, target_wallet, amount, detail, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [action, wallet || null, tokenId || null, targetWallet || null, amount || null, detail || null, result || 'success']
    );
    saveDB(); // Persist immediately — audit logs are critical
  } catch(e) {
    console.warn('[AUDIT] Log failed:', e.message);
  }
}

module.exports = { initDB, run, get, all, saveDB, getDB: () => db, getConfig, getConfigStr, transaction, auditLog };
