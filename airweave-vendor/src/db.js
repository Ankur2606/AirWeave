import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'airweave.db');
const db = new Database(dbPath);

// Create table for vouchers
db.exec(`
  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    amount_inr INTEGER NOT NULL, -- stored in paise (cents equivalent)
    nonce INTEGER NOT NULL,
    expiry INTEGER NOT NULL,
    signature TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// Try run schema updates for Phase 1 updates
try {
  db.exec("ALTER TABLE vouchers ADD COLUMN item_name TEXT DEFAULT ''");
} catch (e) {
  // Column already exists
}

try {
  db.exec("ALTER TABLE vouchers ADD COLUMN recipient TEXT DEFAULT ''");
} catch (e) {
  // Column already exists
}

try {
  db.exec("ALTER TABLE vouchers ADD COLUMN tx_hash TEXT");
} catch (e) {
  // Column already exists
}

// Seed initial mock pending voucher if table is empty to facilitate immediate demo settlement
try {
  const countRow = db.prepare("SELECT COUNT(*) as count FROM vouchers").get();
  if (countRow && countRow.count === 0) {
    db.prepare(`
      INSERT INTO vouchers (from_addr, to_addr, amount_inr, nonce, expiry, signature, item_name, recipient, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '0x943076aC8365E42e018377D1ba9c88FCe1a7EDA2',
      '0x264f3D6883F932f273558ab0cF078d473941F2A4',
      8000, // ₹80.00 in Paise
      0,
      Math.floor(Date.now() / 1000) + 86400,
      '0x' + 'b'.repeat(130),
      'Maggie',
      'Eatery',
      'pending'
    );
    console.log('[AirWeave DB] Seeded initial mock pending voucher of ₹80.00 for the demo');
  }
} catch (seedErr) {
  console.warn('[AirWeave DB] Seeding initial voucher failed:', seedErr.message);
}

export function getPendingVouchers() {
  return db.prepare("SELECT * FROM vouchers WHERE status='pending' ORDER BY created_at DESC").all();
}

export function getAllVouchers() {
  return db.prepare("SELECT * FROM vouchers ORDER BY created_at DESC").all();
}

export function checkDuplicateNonce(fromAddr, nonce) {
  const existing = db.prepare(
    'SELECT id FROM vouchers WHERE from_addr = ? AND nonce = ?'
  ).get(fromAddr, nonce);
  return !!existing;
}

export function insertVoucher({ from, to, amountINR, nonce, expiry, signature, itemName = '', recipient = '' }) {
  const info = db.prepare(`
    INSERT INTO vouchers (from_addr, to_addr, amount_inr, nonce, expiry, signature, item_name, recipient)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(from, to, amountINR, nonce, expiry, signature, itemName, recipient);
  return info.lastInsertRowid;
}

export function updateVoucherStatus(id, status) {
  db.prepare('UPDATE vouchers SET status = ? WHERE id = ?').run(status, id);
}

export default db;
