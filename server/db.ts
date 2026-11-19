import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'kigalirelay.sqlite');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    recipient_carrier TEXT NOT NULL,
    mode TEXT NOT NULL,
    text_body TEXT NOT NULL DEFAULT '',
    sms_segments INTEGER NOT NULL DEFAULT 0,
    audio_filename TEXT,
    audio_duration_sec INTEGER NOT NULL DEFAULT 0,
    audio_mime_type TEXT,
    gateway_provider TEXT NOT NULL,
    gateway_reference TEXT NOT NULL,
    status TEXT NOT NULL,
    delivery_note TEXT NOT NULL,
    ivr_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_phone, created_at DESC);

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    user_name TEXT NOT NULL,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at DESC);

  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    caller_id TEXT NOT NULL,
    caller_name TEXT NOT NULL,
    caller_phone TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    recipient_carrier TEXT NOT NULL,
    target_device TEXT NOT NULL DEFAULT 'smartphone',
    status TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'webrtc_relay',
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_calls_recipient ON call_logs(recipient_phone, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_calls_caller ON call_logs(caller_id, started_at DESC);
`);

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const derivedBuffer = crypto.scryptSync(password, salt, 64);
  if (keyBuffer.length !== derivedBuffer.length) return false;
  return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
}

const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
    ? process.env.SESSION_SECRET
    : crypto.createHash('sha256').update(`kigalirelay-${DB_PATH}`).digest('hex');

export interface TokenPayload {
  sub: string;
  role: 'user' | 'admin';
  exp: number;
}

export function signSessionToken(userId: string, role: 'user' | 'admin'): string {
  const payload: TokenPayload = {
    sub: userId,
    role,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
    if (!parsed.sub || !parsed.exp || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function logActivity(params: {
  userId: string | null;
  userName: string;
  userEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  details: string;
}): void {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO activity_logs (id, user_id, user_name, user_email, action, target_type, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.userId,
    params.userName,
    params.userEmail,
    params.action,
    params.targetType,
    params.targetId,
    params.details,
    createdAt
  );
}

// Seed initial system administrator account if none exists
const ADMIN_DEFAULT_EMAIL = 'byiringirosamuel531@gmail.com';
const ADMIN_DEFAULT_PHONE = '+250795718964';
const ADMIN_DEFAULT_PASSWORD = 'byiringiro@1234';

const existingAdmin = db
  .prepare(`SELECT id, email, phone FROM users WHERE role = 'admin' LIMIT 1`)
  .get() as { id: string; email: string; phone: string } | undefined;

if (!existingAdmin) {
  const adminId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, full_name, email, phone, carrier, password_hash, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', 'active', ?)`
  ).run(
    adminId,
    'System Administrator',
    ADMIN_DEFAULT_EMAIL,
    ADMIN_DEFAULT_PHONE,
    'MTN Rwanda',
    hashPassword(ADMIN_DEFAULT_PASSWORD),
    now
  );

  logActivity({
    userId: adminId,
    userName: 'System Administrator',
    userEmail: ADMIN_DEFAULT_EMAIL,
    action: 'SYSTEM_BOOTSTRAP',
    targetType: 'user',
    targetId: adminId,
    details: `Initialized system administrator account (${ADMIN_DEFAULT_PHONE})`,
  });
} else {
  if (existingAdmin.phone === '+250788000001') {
    const phoneInUse = db
      .prepare(`SELECT id FROM users WHERE phone = ? AND id != ?`)
      .get(ADMIN_DEFAULT_PHONE, existingAdmin.id);
    if (!phoneInUse) {
      db.prepare(`UPDATE users SET phone = ?, carrier = ? WHERE id = ?`).run(
        ADMIN_DEFAULT_PHONE,
        'MTN Rwanda',
        existingAdmin.id
      );
      logActivity({
        userId: existingAdmin.id,
        userName: 'System Administrator',
        userEmail: existingAdmin.email,
        action: 'ADMIN_PHONE_UPDATED',
        targetType: 'user',
        targetId: existingAdmin.id,
        details: `Updated administrator phone number to ${ADMIN_DEFAULT_PHONE} (MTN Rwanda)`,
      });
    }
  }

  if (existingAdmin.email === 'admin@kigalirelay.rw') {
    const emailInUse = db
      .prepare(`SELECT id FROM users WHERE email = ? AND id != ?`)
      .get(ADMIN_DEFAULT_EMAIL, existingAdmin.id);
    if (!emailInUse) {
      db.prepare(`UPDATE users SET email = ?, password_hash = ? WHERE id = ?`).run(
        ADMIN_DEFAULT_EMAIL,
        hashPassword(ADMIN_DEFAULT_PASSWORD),
        existingAdmin.id
      );
      logActivity({
        userId: existingAdmin.id,
        userName: 'System Administrator',
        userEmail: ADMIN_DEFAULT_EMAIL,
        action: 'ADMIN_CREDENTIALS_UPDATED',
        targetType: 'user',
        targetId: existingAdmin.id,
        details: `Updated administrator account email to ${ADMIN_DEFAULT_EMAIL}`,
      });
    }
  }
}
