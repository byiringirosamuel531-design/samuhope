import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  AUDIO_DIR,
  db,
  hashPassword,
  logActivity,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from './server/db.ts';
import { dispatchRwandaMessage, getGatewayStatus } from './server/gateway.ts';
import { calculateSmsSegments, parseRwandaPhone } from './src/lib/rwandaPhone.ts';

interface DbUserRow {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  carrier: string;
  password_hash: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  created_at: string;
  last_login_at: string | null;
}

interface DbMessageRow {
  id: string;
  sender_id: string;
  sender_name: string;
  sender_phone: string;
  recipient_phone: string;
  recipient_carrier: string;
  mode: 'sms' | 'voice' | 'both';
  text_body: string;
  sms_segments: number;
  audio_filename: string | null;
  audio_duration_sec: number;
  audio_mime_type: string | null;
  gateway_provider: string;
  gateway_reference: string;
  status: 'delivered_gateway' | 'delivered_relay' | 'queued' | 'failed' | 'cancelled';
  delivery_note: string;
  ivr_code: string;
  created_at: string;
}

interface AuthedRequest extends Request {
  authUser?: DbUserRow;
}

function serializeUser(row: DbUserRow, messageCount?: number) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    carrier: row.carrier,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    ...(typeof messageCount === 'number' ? { messageCount } : {}),
  };
}

function serializeMessage(row: DbMessageRow) {
  return {
    id: row.id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderPhone: row.sender_phone,
    recipientPhone: row.recipient_phone,
    recipientCarrier: row.recipient_carrier,
    mode: row.mode,
    textBody: row.text_body,
    smsSegments: row.sms_segments,
    audioUrl: row.audio_filename ? `/api/audio/${encodeURIComponent(row.audio_filename)}` : null,
    audioDurationSec: row.audio_duration_sec,
    audioMimeType: row.audio_mime_type,
    gatewayProvider: row.gateway_provider,
    gatewayReference: row.gateway_reference,
    status: row.status,
    deliveryNote: row.delivery_note,
    ivrCode: row.ivr_code,
    createdAt: row.created_at,
  };
}

interface DbCallRow {
  id: string;
  caller_id: string;
  caller_name: string;
  caller_phone: string;
  recipient_phone: string;
  recipient_carrier: string;
  target_device: 'feature' | 'smartphone' | 'tablet';
  status: 'ringing' | 'active' | 'ended' | 'declined' | 'missed';
  provider: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number;
}

function serializeCall(row: DbCallRow) {
  return {
    id: row.id,
    callerId: row.caller_id,
    callerName: row.caller_name,
    callerPhone: row.caller_phone,
    recipientPhone: row.recipient_phone,
    recipientCarrier: row.recipient_carrier,
    targetDevice: row.target_device,
    status: row.status,
    provider: row.provider,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
  };
}

interface CallSignalState {
  offer: unknown | null;
  answer: unknown | null;
  callerCandidates: unknown[];
  calleeCandidates: unknown[];
  streams: Set<Response>;
}

const activeCallSignals = new Map<string, CallSignalState>();

function broadcastCallEvent(callId: string, eventName: string, payload: unknown) {
  const signal = activeCallSignals.get(callId);
  if (!signal || signal.streams.size === 0) return;
  const serialized = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of signal.streams) {
    try {
      res.write(serialized);
    } catch {
      signal.streams.delete(res);
    }
  }
}

// SSE clients subscribed to a normalized Rwandan E.164 phone number
const receiverStreams = new Map<string, Set<Response>>();

function broadcastToPhone(phoneE164: string, eventName: string, payload: unknown) {
  const clients = receiverStreams.get(phoneE164);
  if (!clients || clients.size === 0) return;
  const serialized = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(serialized);
    } catch {
      clients.delete(res);
    }
  }
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  const verified = verifySessionToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    return;
  }
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(verified.sub) as
    | DbUserRow
    | undefined;
  if (!user) {
    res.status(401).json({ error: 'Account no longer exists.' });
    return;
  }
  if (user.status !== 'active') {
    res.status(403).json({
      error: 'Your account has been suspended by an administrator.',
    });
    return;
  }
  req.authUser = user;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.authUser || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required.' });
    return;
  }
  next();
}

function getExtensionForMime(mime: string | undefined): string {
  const lower = (mime || '').toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  return 'webm';
}

function getMimeForExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  return 'audio/webm';
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').trim();
  if (!host) {
    return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  }
  const proto =
    forwardedProto === 'https' || req.secure || host.endsWith('.run.app')
      ? 'https'
      : req.protocol || 'http';
  return `${proto}://${host}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.set('trust proxy', true);
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Health & API status endpoints
  app.get('/api', (req, res) => {
    res.json({
      ok: true,
      service: 'KigaliRelay API',
      gateway: getGatewayStatus(getRequestOrigin(req)),
    });
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, gateway: getGatewayStatus(getRequestOrigin(req)) });
  });

  app.get('/api/gateway', (req, res) => {
    res.json({ ok: true, gateway: getGatewayStatus(getRequestOrigin(req)) });
  });

  app.get('/api/gateway/status', (req, res) => {
    res.json({ ok: true, gateway: getGatewayStatus(getRequestOrigin(req)) });
  });

  // Register new user account
  app.post('/api/auth/register', (req, res) => {
    const body = req.body as {
      fullName?: string;
      email?: string;
      phone?: string;
      password?: string;
    };

    const fullName = (body.fullName || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const parsedPhone = parseRwandaPhone(body.phone || '');

    if (fullName.length < 2 || fullName.length > 80) {
      res.status(400).json({ error: 'Full name must be between 2 and 80 characters.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (!parsedPhone.valid || !parsedPhone.carrier) {
      res.status(400).json({ error: parsedPhone.error || 'Invalid Rwandan phone number.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' });
      return;
    }

    const existingEmail = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (existingEmail) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }
    const existingPhone = db.prepare(`SELECT id FROM users WHERE phone = ?`).get(parsedPhone.e164);
    if (existingPhone) {
      res.status(409).json({ error: 'An account with this Rwandan phone number already exists.' });
      return;
    }

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = hashPassword(password);

    db.prepare(
      `INSERT INTO users (id, full_name, email, phone, carrier, password_hash, role, status, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', ?, ?)`
    ).run(userId, fullName, email, parsedPhone.e164, parsedPhone.carrier, passwordHash, now, now);

    const created = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as DbUserRow;

    logActivity({
      userId,
      userName: fullName,
      userEmail: email,
      action: 'USER_REGISTERED',
      targetType: 'user',
      targetId: userId,
      details: `Created account with ${parsedPhone.formatted} (${parsedPhone.carrier})`,
    });

    const token = signSessionToken(userId, 'user');
    res.status(201).json({
      token,
      user: serializeUser(created),
      gateway: getGatewayStatus(getRequestOrigin(req)),
    });
  });

  // Sign in (accepts email OR Rwandan phone number)
  app.post('/api/auth/login', (req, res) => {
    const body = req.body as { identifier?: string; password?: string };
    const identifier = (body.identifier || '').trim();
    const password = body.password || '';

    if (!identifier || !password) {
      res.status(400).json({ error: 'Email or Rwandan phone number and password are required.' });
      return;
    }

    let user: DbUserRow | undefined;
    if (identifier.includes('@')) {
      user = db
        .prepare(`SELECT * FROM users WHERE email = ?`)
        .get(identifier.toLowerCase()) as DbUserRow | undefined;
    } else {
      const parsed = parseRwandaPhone(identifier);
      if (parsed.valid) {
        user = db
          .prepare(`SELECT * FROM users WHERE phone = ?`)
          .get(parsed.e164) as DbUserRow | undefined;
      }
    }

    if (!user) {
      res.status(401).json({
        error: 'No account found for that email or Rwandan phone number. Create an account first.',
      });
      return;
    }

    if (!verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'Incorrect password. Please check your password and try again.' });
      return;
    }

    if (user.status !== 'active') {
      logActivity({
        userId: user.id,
        userName: user.full_name,
        userEmail: user.email,
        action: 'LOGIN_BLOCKED',
        targetType: 'user',
        targetId: user.id,
        details: 'Suspended user attempted sign in',
      });
      res.status(403).json({
        error: 'This account has been suspended by an administrator.',
      });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now, user.id);
    const updatedUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id) as DbUserRow;

    logActivity({
      userId: user.id,
      userName: user.full_name,
      userEmail: user.email,
      action: 'USER_LOGIN',
      targetType: 'user',
      targetId: user.id,
      details: `Signed in (${user.role})`,
    });

    const token = signSessionToken(user.id, user.role);
    res.json({
      token,
      user: serializeUser(updatedUser),
      gateway: getGatewayStatus(getRequestOrigin(req)),
    });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    res.json({ user: serializeUser(user), gateway: getGatewayStatus(getRequestOrigin(req)) });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    logActivity({
      userId: user.id,
      userName: user.full_name,
      userEmail: user.email,
      action: 'USER_LOGOUT',
      targetType: 'user',
      targetId: user.id,
      details: 'Signed out',
    });
    res.json({ ok: true });
  });

  // Send text message and/or recorded audio to a Rwandan phone number
  app.post('/api/messages', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const body = req.body as {
      recipientPhone?: string;
      mode?: 'sms' | 'voice' | 'both';
      textBody?: string;
      audioBase64?: string;
      audioMimeType?: string;
      audioDurationSec?: number;
    };

    const parsedRecipient = parseRwandaPhone(body.recipientPhone || '');
    if (!parsedRecipient.valid || !parsedRecipient.carrier) {
      res.status(400).json({ error: parsedRecipient.error || 'Invalid Rwandan recipient phone number.' });
      return;
    }

    const mode = body.mode;
    if (mode !== 'sms' && mode !== 'voice' && mode !== 'both') {
      res.status(400).json({ error: 'Delivery mode must be sms, voice, or both.' });
      return;
    }

    const textBody = (body.textBody || '').trim();
    if ((mode === 'sms' || mode === 'both') && textBody.length === 0) {
      res.status(400).json({ error: 'Please write a text message before sending.' });
      return;
    }
    if (textBody.length > 960) {
      res.status(400).json({ error: 'Message text cannot exceed 960 characters.' });
      return;
    }

    const hasAudio = Boolean(body.audioBase64 && body.audioBase64.length > 20);
    if ((mode === 'voice' || mode === 'both') && !hasAudio) {
      res.status(400).json({ error: 'Please record an audio message before sending.' });
      return;
    }

    const messageId = crypto.randomUUID();
    let audioFilename: string | null = null;
    const audioDurationSec = Math.max(0, Math.round(Number(body.audioDurationSec || 0)));
    const audioMimeType = body.audioMimeType || null;

    if (hasAudio && body.audioBase64) {
      const cleanedBase64 = body.audioBase64.includes(',')
        ? body.audioBase64.split(',')[1]
        : body.audioBase64;
      const audioBuffer = Buffer.from(cleanedBase64, 'base64');
      if (audioBuffer.length === 0 || audioBuffer.length > 10 * 1024 * 1024) {
        res.status(400).json({ error: 'Recorded audio is empty or exceeds 10 MB limit.' });
        return;
      }
      const ext = getExtensionForMime(audioMimeType || undefined);
      audioFilename = `${messageId}.${ext}`;
      fs.writeFileSync(path.join(AUDIO_DIR, audioFilename), audioBuffer);
    }

    const smsInfo = calculateSmsSegments(textBody);
    const ivrCode = String(crypto.randomInt(1000, 9999));
    const audioUrl = audioFilename ? `/api/audio/${encodeURIComponent(audioFilename)}` : null;

    const dispatch = await dispatchRwandaMessage({
      messageId,
      recipientPhone: parsedRecipient.e164,
      recipientCarrier: parsedRecipient.carrier,
      mode,
      textBody,
      audioUrl,
      ivrCode,
      requestOrigin: getRequestOrigin(req),
    });

    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO messages (
        id, sender_id, recipient_phone, recipient_carrier, mode, text_body, sms_segments,
        audio_filename, audio_duration_sec, audio_mime_type, gateway_provider,
        gateway_reference, status, delivery_note, ivr_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      messageId,
      user.id,
      parsedRecipient.e164,
      parsedRecipient.carrier,
      mode,
      textBody,
      smsInfo.segments,
      audioFilename,
      audioDurationSec,
      audioMimeType,
      dispatch.provider,
      dispatch.reference,
      dispatch.status,
      dispatch.note,
      ivrCode,
      createdAt
    );

    const inserted = db
      .prepare(
        `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`
      )
      .get(messageId) as DbMessageRow;

    const serialized = serializeMessage(inserted);

    logActivity({
      userId: user.id,
      userName: user.full_name,
      userEmail: user.email,
      action: 'MESSAGE_SENT',
      targetType: 'message',
      targetId: messageId,
      details: `Sent ${mode.toUpperCase()} to ${parsedRecipient.formatted} (${parsedRecipient.carrier}) via ${dispatch.provider}`,
    });

    if (dispatch.status !== 'failed') {
      broadcastToPhone(parsedRecipient.e164, 'new_message', serialized);
    }

    res.status(201).json({ message: serialized });
  });

  // Current user's sent messages
  const handleGetMyMessages = (req: AuthedRequest, res: Response) => {
    const user = req.authUser!;
    const rows = db
      .prepare(
        `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.sender_id = ?
         ORDER BY m.created_at DESC
         LIMIT 200`
      )
      .all(user.id) as DbMessageRow[];

    res.json({ messages: rows.map(serializeMessage) });
  };

  app.get('/api/messages/mine', requireAuth, handleGetMyMessages);
  app.get('/api/messages', requireAuth, handleGetMyMessages);

  // Stream recorded audio file with Range support
  app.get('/api/audio/:filename', (req, res) => {
    const raw = req.params.filename || '';
    const safeName = path.basename(raw);
    if (!/^[a-zA-Z0-9_-]+\.(webm|m4a|ogg|wav|mp3)$/.test(safeName)) {
      res.status(400).json({ error: 'Invalid audio identifier.' });
      return;
    }

    const fullPath = path.join(AUDIO_DIR, safeName);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: 'Audio recording not found.' });
      return;
    }

    const stat = fs.statSync(fullPath);
    const total = stat.size;
    const mimeType = getMimeForExtension(safeName);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (Number.isNaN(start) || start >= total || end >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });
      fs.createReadStream(fullPath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(fullPath).pipe(res);
  });

  // Voice XML callback for live Twilio / Africa's Talking outbound phone calls & IVR playback
  const handleVoiceXmlRequest = (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawParam = String(req.params.messageId || req.query.messageId || body.messageId || '').trim();
    const isPlaceholder =
      !rawParam ||
      rawParam === ':messageId' ||
      rawParam === 'latest' ||
      rawParam === 'sample' ||
      rawParam === 'test';

    const ivrCodeInput = String(
      req.query.ivrCode || body.dtmfDigits || body.Digits || ''
    )
      .replace(/\D/g, '')
      .slice(0, 8);

    const rawPhone = String(
      body.destinationNumber ||
        body.To ||
        body.to ||
        req.query.to ||
        req.query.phone ||
        body.callerNumber ||
        ''
    ).trim();
    const parsedPhone = rawPhone ? parseRwandaPhone(rawPhone) : null;

    let msg: DbMessageRow | undefined;

    if (!isPlaceholder) {
      msg = db
        .prepare(
          `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.id = ?`
        )
        .get(rawParam) as DbMessageRow | undefined;
    } else if (ivrCodeInput) {
      msg = db
        .prepare(
          `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.ivr_code = ? AND m.audio_filename IS NOT NULL AND m.status NOT IN ('cancelled', 'failed')
           ORDER BY m.created_at DESC
           LIMIT 1`
        )
        .get(ivrCodeInput) as DbMessageRow | undefined;
    } else if (parsedPhone?.valid) {
      msg = db
        .prepare(
          `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.recipient_phone = ? AND m.audio_filename IS NOT NULL AND m.status NOT IN ('cancelled', 'failed')
           ORDER BY m.created_at DESC
           LIMIT 1`
        )
        .get(parsedPhone.e164) as DbMessageRow | undefined;
    } else {
      msg = db
        .prepare(
          `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.audio_filename IS NOT NULL AND m.status NOT IN ('cancelled', 'failed')
           ORDER BY m.created_at DESC
           LIMIT 1`
        )
        .get() as DbMessageRow | undefined;
    }

    const isAfricasTalking =
      String(req.query.provider || '').toLowerCase() === 'africas_talking' ||
      Boolean(body.sessionId || body.destinationNumber || body.callSessionState);

    const baseUrl = (process.env.APP_URL || getRequestOrigin(req)).replace(/\/$/, '');
    const providerLabel = isAfricasTalking ? "Africa's Talking" : 'Twilio';

    let xml: string;
    let audioAbsoluteUrl: string | null = null;

    if (!msg || !msg.audio_filename) {
      const fallbackMessage = !isPlaceholder
        ? 'This voice message is unavailable or has been removed.'
        : 'KigaliRelay Voice Gateway is active. Record and send a voice message first to test audio playback.';
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say${isAfricasTalking ? ' voice="woman"' : ' voice="alice"'}>${escapeXml(fallbackMessage)}</Say>
</Response>`;
    } else {
      audioAbsoluteUrl = `${baseUrl}/api/audio/${encodeURIComponent(msg.audio_filename)}`;
      const safeSender = escapeXml(msg.sender_name);
      xml = isAfricasTalking
        ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">KigaliRelay voice message from ${safeSender}.</Say>
  <Play url="${escapeXml(audioAbsoluteUrl)}"/>
  <Say voice="woman">End of message. Thank you.</Say>
</Response>`
        : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">KigaliRelay voice message from ${safeSender}.</Say>
  <Play>${escapeXml(audioAbsoluteUrl)}</Play>
  <Say voice="alice">End of message. Thank you.</Say>
</Response>`;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Vary', 'Accept');

    const acceptHeader = String(req.headers.accept || '').toLowerCase();
    const explicitlyWantsXml =
      acceptHeader.includes('application/xml') && !acceptHeader.includes('text/html');
    const isBrowserGet = req.method === 'GET' && !explicitlyWantsXml && acceptHeader.includes('text/html');

    if (req.method === 'GET' && req.query.format === 'xml' && !explicitlyWantsXml) {
      res.status(200).setHeader('Content-Type', 'text/plain; charset=utf-8').send(xml);
      return;
    }

    if (isBrowserGet) {
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KigaliRelay Voice Gateway (${escapeXml(providerLabel)})</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 32px 16px; }
    .card { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(15,23,42,0.06); }
    .status { display: inline-block; font-size: 12px; font-weight: 600; color: #065f46; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 4px 10px; border-radius: 6px; }
    h1 { font-size: 20px; margin: 12px 0 6px; }
    p { font-size: 14px; color: #475569; line-height: 1.5; margin: 0 0 16px; }
    pre { background: #0f172a; color: #6ee7b7; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 12px; line-height: 1.5; }
    audio { width: 100%; margin: 8px 0 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    .btn { text-decoration: none; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-family: inherit; }
    .primary { background: #0f766e; color: #fff; border: 1px solid #0f766e; }
    .secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
  </style>
</head>
<body>
  <div class="card">
    <span class="status">Voice Gateway Active · ${escapeXml(providerLabel)}</span>
    <h1>KigaliRelay Voice XML Endpoint</h1>
    <p>${
      msg
        ? `Ready for outbound voice playback to <strong>${escapeXml(msg.recipient_phone)}</strong> (IVR *180*${escapeXml(msg.ivr_code)}#).`
        : 'No voice recordings are queued yet. Return to KigaliRelay, record an audio message, and send it to a Rwandan number to populate live audio playback here.'
    }</p>
    ${
      audioAbsoluteUrl
        ? `<audio controls src="${escapeXml(audioAbsoluteUrl)}"></audio>`
        : ''
    }
    <pre id="xml-code">${escapeXml(xml)}</pre>
    <div class="actions">
      <a class="btn primary" href="/">Back to KigaliRelay</a>
      <button type="button" class="btn secondary" id="copy-btn">Copy XML</button>
    </div>
  </div>
  <script>
    document.getElementById('copy-btn')?.addEventListener('click', function () {
      var code = document.getElementById('xml-code')?.textContent || '';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code);
        this.textContent = 'Copied!';
        var btn = this;
        setTimeout(function () { btn.textContent = 'Copy XML'; }, 1800);
      }
    });
  </script>
</body>
</html>`);
      return;
    }

    res.status(200).setHeader('Content-Type', 'application/xml; charset=utf-8').send(xml);
  };

  app.all('/api/gateway/voice-xml', handleVoiceXmlRequest);
  app.all('/api/gateway/voice-xml/:messageId', handleVoiceXmlRequest);

  // Delivery Receipt (DLR) & Voice Call Status webhooks for Twilio and Africa's Talking
  const handleGatewayStatusWebhook = (channel: 'sms' | 'voice') => (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const messageIdParam = String(req.query.messageId || body.messageId || '').trim();
    const providerSid = String(
      body.MessageSid || body.CallSid || body.id || body.sessionId || ''
    ).trim();

    let target: DbMessageRow | undefined;
    if (messageIdParam) {
      target = db
        .prepare(
          `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.id = ?`
        )
        .get(messageIdParam) as DbMessageRow | undefined;
    } else if (providerSid) {
      target = db
        .prepare(
          `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.gateway_reference LIKE ?
           ORDER BY m.created_at DESC
           LIMIT 1`
        )
        .get(`%${providerSid}%`) as DbMessageRow | undefined;
    }

    if (!target) {
      res.status(200).json({ ok: true, matched: false });
      return;
    }

    const rawStatus = String(
      body.MessageStatus || body.CallStatus || body.status || body.callSessionState || ''
    )
      .trim()
      .toLowerCase();
    const failureReason = String(body.ErrorMessage || body.failureReason || '').trim();

    let nextStatus: DbMessageRow['status'] = target.status;
    if (['delivered', 'sent', 'success', 'completed', 'answered'].includes(rawStatus)) {
      nextStatus = 'delivered_gateway';
    } else if (
      ['queued', 'accepted', 'ringing', 'initiated', 'in-progress', 'sending', 'submitted', 'buffered'].includes(
        rawStatus
      )
    ) {
      nextStatus = 'queued';
    } else if (['failed', 'undelivered', 'rejected', 'busy', 'no-answer', 'canceled'].includes(rawStatus)) {
      nextStatus = 'failed';
    }

    const detail = `${channel.toUpperCase()} callback: ${rawStatus || 'updated'}${
      failureReason ? ` (${failureReason})` : ''
    }`;
    const nextNote = target.delivery_note ? `${target.delivery_note} · ${detail}` : detail;

    db.prepare(`UPDATE messages SET status = ?, delivery_note = ? WHERE id = ?`).run(
      nextStatus,
      nextNote,
      target.id
    );

    const updated = db
      .prepare(
        `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`
      )
      .get(target.id) as DbMessageRow;

    const serialized = serializeMessage(updated);
    broadcastToPhone(updated.recipient_phone, 'message_updated', serialized);

    logActivity({
      userId: updated.sender_id,
      userName: updated.sender_name,
      userEmail: '',
      action: 'GATEWAY_DLR_UPDATE',
      targetType: 'message',
      targetId: updated.id,
      details: `${updated.recipient_phone} status -> ${nextStatus} (${detail})`,
    });

    res.status(200).json({ ok: true, matched: true, status: nextStatus });
  };

  const handleGatewayStatusRequest = (channel: 'sms' | 'voice') => (req: Request, res: Response) => {
    if (req.method === 'GET' && !req.query.messageId && !req.query.MessageStatus && !req.query.CallStatus) {
      res.status(200).json({
        ok: true,
        channel,
        ready: true,
        gateway: getGatewayStatus(getRequestOrigin(req)),
      });
      return;
    }
    handleGatewayStatusWebhook(channel)(req, res);
  };

  app.all('/api/gateway/sms-status', handleGatewayStatusRequest('sms'));
  app.all('/api/gateway/voice-status', handleGatewayStatusRequest('voice'));

  // Feature-Phone Receiver: lookup messages delivered to a specific Rwandan phone number
  app.get('/api/receiver/messages', (req, res) => {
    const phoneParam = String(req.query.phone || '');
    const parsed = parseRwandaPhone(phoneParam);
    if (!parsed.valid) {
      res.status(400).json({ error: parsed.error || 'Invalid Rwandan phone number.' });
      return;
    }

    const cutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE call_logs SET status = 'missed', ended_at = COALESCE(ended_at, ?)
       WHERE status = 'ringing' AND started_at < ?`
    ).run(new Date().toISOString(), cutoffIso);

    const rows = db
      .prepare(
        `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.recipient_phone = ? AND m.status != 'cancelled' AND m.status != 'failed'
         ORDER BY m.created_at DESC
         LIMIT 50`
      )
      .all(parsed.e164) as DbMessageRow[];

    const activeCallRow = db
      .prepare(
        `SELECT * FROM call_logs
         WHERE recipient_phone = ? AND status = 'ringing'
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(parsed.e164) as DbCallRow | undefined;

    const activeCallSignal = activeCallRow ? activeCallSignals.get(activeCallRow.id) : undefined;

    res.json({
      phone: parsed.e164,
      formatted: parsed.formatted,
      carrier: parsed.carrier,
      messages: rows.map(serializeMessage),
      activeCall: activeCallRow
        ? {
            call: serializeCall(activeCallRow),
            offer: activeCallSignal?.offer || null,
          }
        : null,
    });
  });

  // SSE stream for real-time ringing on Rwandan Feature-Phone Receiver
  app.get('/api/receiver/stream', (req, res) => {
    const phoneParam = String(req.query.phone || '');
    const parsed = parseRwandaPhone(phoneParam);
    if (!parsed.valid) {
      res.status(400).json({ error: 'Valid Rwandan phone number required.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ phone: parsed.e164 })}\n\n`);

    let set = receiverStreams.get(parsed.e164);
    if (!set) {
      set = new Set();
      receiverStreams.set(parsed.e164, set);
    }
    set.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      set?.delete(res);
    });
  });

  app.get('/api/receiver/recent-numbers', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT recipient_phone, recipient_carrier, COUNT(*) AS count, MAX(latest_at) AS latest_at
         FROM (
           SELECT recipient_phone, recipient_carrier, created_at AS latest_at
           FROM messages
           WHERE status != 'cancelled'
           UNION ALL
           SELECT recipient_phone, recipient_carrier, started_at AS latest_at
           FROM call_logs
         )
         GROUP BY recipient_phone, recipient_carrier
         ORDER BY latest_at DESC
         LIMIT 12`
      )
      .all() as Array<{
      recipient_phone: string;
      recipient_carrier: string;
      count: number;
      latest_at: string;
    }>;

    res.json({
      numbers: rows.map((r) => ({
        phone: r.recipient_phone,
        carrier: r.recipient_carrier,
        count: r.count,
        latestAt: r.latest_at,
      })),
    });
  });

  // ---------------- LIVE VOICE CALLING ROUTES ----------------

  app.post('/api/calls', requireAuth, (req: AuthedRequest, res) => {
    const caller = req.authUser!;
    const body = req.body as {
      recipientPhone?: string;
      targetDevice?: 'feature' | 'smartphone' | 'tablet';
      offer?: unknown;
    };

    const parsedRecipient = parseRwandaPhone(body.recipientPhone || '');
    if (!parsedRecipient.valid || !parsedRecipient.carrier) {
      res.status(400).json({ error: parsedRecipient.error || 'Invalid Rwandan recipient phone number.' });
      return;
    }

    const targetDevice =
      body.targetDevice === 'tablet' || body.targetDevice === 'feature'
        ? body.targetDevice
        : 'smartphone';

    const callId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO call_logs (
        id, caller_id, caller_name, caller_phone, recipient_phone, recipient_carrier,
        target_device, status, provider, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ringing', 'webrtc_relay', ?)`
    ).run(
      callId,
      caller.id,
      caller.full_name,
      caller.phone,
      parsedRecipient.e164,
      parsedRecipient.carrier,
      targetDevice,
      startedAt
    );

    activeCallSignals.set(callId, {
      offer: body.offer || null,
      answer: null,
      callerCandidates: [],
      calleeCandidates: [],
      streams: new Set(),
    });

    const row = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as DbCallRow;
    const serialized = serializeCall(row);

    logActivity({
      userId: caller.id,
      userName: caller.full_name,
      userEmail: caller.email,
      action: 'CALL_STARTED',
      targetType: 'call',
      targetId: callId,
      details: `Started live voice call to ${parsedRecipient.formatted} (${targetDevice})`,
    });

    broadcastToPhone(parsedRecipient.e164, 'incoming_call', {
      call: serialized,
      offer: body.offer || null,
    });

    res.status(201).json({ call: serialized });
  });

  app.get('/api/calls/mine', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const rows = db
      .prepare(
        `SELECT * FROM call_logs
         WHERE caller_id = ? OR recipient_phone = ?
         ORDER BY started_at DESC
         LIMIT 50`
      )
      .all(user.id, user.phone) as DbCallRow[];
    res.json({ calls: rows.map(serializeCall) });
  });

  app.get('/api/calls/:id/stream', (req, res) => {
    const callId = String(req.params.id || '').trim();
    const row = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as
      | DbCallRow
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Call session not found.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let signal = activeCallSignals.get(callId);
    if (!signal) {
      signal = {
        offer: null,
        answer: null,
        callerCandidates: [],
        calleeCandidates: [],
        streams: new Set(),
      };
      activeCallSignals.set(callId, signal);
    }
    signal.streams.add(res);

    res.write(
      `event: call_state\ndata: ${JSON.stringify({
        call: serializeCall(row),
        offer: signal.offer,
        answer: signal.answer,
        callerCandidates: signal.callerCandidates,
        calleeCandidates: signal.calleeCandidates,
      })}\n\n`
    );

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      signal?.streams.delete(res);
    });
  });

  app.get('/api/calls/:id', (req, res) => {
    const callId = String(req.params.id || '').trim();
    const row = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as
      | DbCallRow
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Call not found.' });
      return;
    }
    const signal = activeCallSignals.get(callId);
    res.json({
      call: serializeCall(row),
      offer: signal?.offer || null,
      answer: signal?.answer || null,
      callerCandidates: signal?.callerCandidates || [],
      calleeCandidates: signal?.calleeCandidates || [],
    });
  });

  app.post('/api/calls/:id/answer', (req, res) => {
    const callId = String(req.params.id || '').trim();
    const body = req.body as { answer?: unknown };
    const row = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as
      | DbCallRow
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Call not found.' });
      return;
    }

    const answeredAt = row.answered_at || new Date().toISOString();
    db.prepare(`UPDATE call_logs SET status = 'active', answered_at = ? WHERE id = ?`).run(
      answeredAt,
      callId
    );

    const signal = activeCallSignals.get(callId) || {
      offer: null,
      answer: null,
      callerCandidates: [],
      calleeCandidates: [],
      streams: new Set(),
    };
    if (body.answer) {
      signal.answer = body.answer;
    }
    activeCallSignals.set(callId, signal);

    const updated = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as DbCallRow;
    const serialized = serializeCall(updated);
    broadcastCallEvent(callId, 'call_answered', { call: serialized, answer: signal.answer });
    res.json({ call: serialized });
  });

  app.post('/api/calls/:id/ice', (req, res) => {
    const callId = String(req.params.id || '').trim();
    const body = req.body as { role?: 'caller' | 'callee'; candidate?: unknown };
    if (!body.candidate || (body.role !== 'caller' && body.role !== 'callee')) {
      res.status(400).json({ error: 'Valid role and ICE candidate required.' });
      return;
    }

    const signal = activeCallSignals.get(callId);
    if (!signal) {
      res.status(404).json({ error: 'Call signaling session closed.' });
      return;
    }

    if (body.role === 'caller') {
      signal.callerCandidates.push(body.candidate);
    } else {
      signal.calleeCandidates.push(body.candidate);
    }

    broadcastCallEvent(callId, 'call_ice', {
      role: body.role,
      candidate: body.candidate,
    });
    res.json({ ok: true });
  });

  app.post('/api/calls/:id/end', (req, res) => {
    const callId = String(req.params.id || '').trim();
    const body = req.body as { reason?: 'ended' | 'declined' | 'missed' };
    const row = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as
      | DbCallRow
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Call not found.' });
      return;
    }

    const endedAt = new Date().toISOString();
    const nextStatus =
      body.reason === 'declined' || body.reason === 'missed' ? body.reason : 'ended';
    const durationSec = row.answered_at
      ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(row.answered_at)) / 1000))
      : 0;

    db.prepare(
      `UPDATE call_logs SET status = ?, ended_at = ?, duration_sec = ? WHERE id = ?`
    ).run(nextStatus, endedAt, durationSec, callId);

    const updated = db.prepare(`SELECT * FROM call_logs WHERE id = ?`).get(callId) as DbCallRow;
    const serialized = serializeCall(updated);

    broadcastCallEvent(callId, 'call_ended', { call: serialized });
    broadcastToPhone(row.recipient_phone, 'call_ended', { call: serialized });
    activeCallSignals.delete(callId);

    res.json({ call: serialized });
  });

  // ---------------- ADMIN ROUTES ----------------

  app.get('/api/admin/overview', requireAuth, requireAdmin, (req, res) => {
    const userCounts = db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
         FROM users`
      )
      .get() as { total: number; active: number; suspended: number };

    const msgCounts = db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN mode IN ('voice', 'both') THEN 1 ELSE 0 END) AS voice,
          SUM(CASE WHEN mode IN ('sms', 'both') THEN 1 ELSE 0 END) AS sms,
          SUM(CASE WHEN recipient_carrier = 'MTN Rwanda' THEN 1 ELSE 0 END) AS mtn,
          SUM(CASE WHEN recipient_carrier = 'Airtel Rwanda' THEN 1 ELSE 0 END) AS airtel
         FROM messages`
      )
      .get() as {
      total: number;
      voice: number;
      sms: number;
      mtn: number;
      airtel: number;
    };

    res.json({
      overview: {
        totalUsers: userCounts.total || 0,
        activeUsers: userCounts.active || 0,
        suspendedUsers: userCounts.suspended || 0,
        totalMessages: msgCounts.total || 0,
        voiceMessages: msgCounts.voice || 0,
        smsMessages: msgCounts.sms || 0,
        mtnMessages: msgCounts.mtn || 0,
        airtelMessages: msgCounts.airtel || 0,
        gateway: getGatewayStatus(getRequestOrigin(req)),
      },
    });
  });

  app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS message_count
         FROM users u
         ORDER BY u.created_at DESC`
      )
      .all() as Array<DbUserRow & { message_count: number }>;

    res.json({
      users: rows.map((r) => serializeUser(r, r.message_count)),
    });
  });

  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const admin = req.authUser!;
    const targetId = req.params.id;
    const body = req.body as { status?: 'active' | 'suspended'; role?: 'user' | 'admin' };

    const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(targetId) as
      | DbUserRow
      | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (target.id === admin.id && (body.status === 'suspended' || body.role === 'user')) {
      res.status(400).json({ error: 'You cannot suspend or demote your own administrator account.' });
      return;
    }

    const nextStatus =
      body.status === 'active' || body.status === 'suspended' ? body.status : target.status;
    const nextRole = body.role === 'user' || body.role === 'admin' ? body.role : target.role;

    db.prepare(`UPDATE users SET status = ?, role = ? WHERE id = ?`).run(
      nextStatus,
      nextRole,
      target.id
    );

    if (nextStatus !== target.status) {
      logActivity({
        userId: admin.id,
        userName: admin.full_name,
        userEmail: admin.email,
        action: nextStatus === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_ACTIVATED',
        targetType: 'user',
        targetId: target.id,
        details: `${nextStatus === 'suspended' ? 'Suspended' : 'Activated'} ${target.full_name} (${target.phone})`,
      });
    }

    if (nextRole !== target.role) {
      logActivity({
        userId: admin.id,
        userName: admin.full_name,
        userEmail: admin.email,
        action: 'ROLE_UPDATED',
        targetType: 'user',
        targetId: target.id,
        details: `Changed role of ${target.full_name} from ${target.role} to ${nextRole}`,
      });
    }

    const updated = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS message_count
         FROM users u WHERE u.id = ?`
      )
      .get(target.id) as DbUserRow & { message_count: number };

    res.json({ user: serializeUser(updated, updated.message_count) });
  });

  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const admin = req.authUser!;
    const targetId = req.params.id;

    if (targetId === admin.id) {
      res.status(400).json({ error: 'You cannot delete your own administrator account.' });
      return;
    }

    const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(targetId) as
      | DbUserRow
      | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    // Remove user's audio files from disk before cascade delete
    const audioFiles = db
      .prepare(`SELECT audio_filename FROM messages WHERE sender_id = ? AND audio_filename IS NOT NULL`)
      .all(target.id) as Array<{ audio_filename: string }>;
    for (const file of audioFiles) {
      const p = path.join(AUDIO_DIR, path.basename(file.audio_filename));
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }

    db.prepare(`DELETE FROM users WHERE id = ?`).run(target.id);

    logActivity({
      userId: admin.id,
      userName: admin.full_name,
      userEmail: admin.email,
      action: 'USER_DELETED',
      targetType: 'user',
      targetId: target.id,
      details: `Deleted account ${target.full_name} (${target.email})`,
    });

    res.json({ ok: true });
  });

  app.get('/api/admin/messages', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         ORDER BY m.created_at DESC
         LIMIT 300`
      )
      .all() as DbMessageRow[];

    res.json({ messages: rows.map(serializeMessage) });
  });

  app.patch('/api/admin/messages/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const admin = req.authUser!;
    const msgId = req.params.id;
    const body = req.body as { status?: string };
    const allowed = ['delivered_gateway', 'delivered_relay', 'queued', 'failed', 'cancelled'];
    if (!body.status || !allowed.includes(body.status)) {
      res.status(400).json({ error: 'Invalid message status.' });
      return;
    }

    const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msgId) as
      | DbMessageRow
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }

    db.prepare(`UPDATE messages SET status = ? WHERE id = ?`).run(body.status, msgId);

    logActivity({
      userId: admin.id,
      userName: admin.full_name,
      userEmail: admin.email,
      action: 'MESSAGE_STATUS_UPDATED',
      targetType: 'message',
      targetId: msgId,
      details: `Updated message to ${existing.recipient_phone} status to ${body.status}`,
    });

    const updated = db
      .prepare(
        `SELECT m.*, u.full_name AS sender_name, u.phone AS sender_phone
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`
      )
      .get(msgId) as DbMessageRow;

    res.json({ message: serializeMessage(updated) });
  });

  app.delete('/api/admin/messages/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const admin = req.authUser!;
    const msgId = req.params.id;

    const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msgId) as
      | DbMessageRow
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }

    if (existing.audio_filename) {
      const p = path.join(AUDIO_DIR, path.basename(existing.audio_filename));
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }

    db.prepare(`DELETE FROM messages WHERE id = ?`).run(msgId);

    logActivity({
      userId: admin.id,
      userName: admin.full_name,
      userEmail: admin.email,
      action: 'MESSAGE_DELETED',
      targetType: 'message',
      targetId: msgId,
      details: `Deleted message directed to ${existing.recipient_phone}`,
    });

    res.json({ ok: true });
  });

  app.get('/api/admin/activities', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(`SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 300`)
      .all() as Array<{
      id: string;
      user_id: string | null;
      user_name: string;
      user_email: string;
      action: string;
      target_type: string;
      target_id: string;
      details: string;
      created_at: string;
    }>;

    res.json({
      activities: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        userEmail: r.user_email,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details,
        createdAt: r.created_at,
      })),
    });
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Vite middleware for dev, static dist for prod
  const distDir = path.resolve(process.cwd(), 'dist');
  const indexHtml = path.join(distDir, 'index.html');
  if (process.env.NODE_ENV !== 'production' || !fs.existsSync(indexHtml)) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KigaliRelay server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start KigaliRelay server:', err);
  process.exit(1);
});
