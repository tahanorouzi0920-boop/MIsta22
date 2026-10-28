'use strict';

const { db } = require('./db');
const REF = require('./reference');
const { sha256, randomToken } = require('./crypto');
const J = require('./jalali');

const SESSION_COOKIE = 'mista_sid';
const ENV_IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES) || 30;
// The administrator can change the idle timeout in the system settings; the environment value is the fallback.
const SESSION_LIMITS = { min: 1, max: 1440 };
function idleMinutes() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_idle_minutes'").get();
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n >= SESSION_LIMITS.min && n <= SESSION_LIMITS.max ? n : ENV_IDLE_MIN;
}
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 5;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}
const fail = (status, message, fields) => { throw new HttpError(status, message, fields); };

function sendJSON(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'حجم درخواست بیش از حد مجاز است'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { fail(400, 'قالب درخواست نامعتبر است'); }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- Sessions ----------
// Stored per-user permission table. Returns null when the role default should be used.
function parsePerms(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
const toUser = (r) => ({ id: r.id, username: r.username, name: r.name, role: r.role, root: !!r.is_root, active: !!r.active, perms: parsePerms(r.perms), driverId: r.driver_id || null, personnelId: r.personnel_id || null });

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hash);
  if (!row) return null;
  const now = Date.now();
  if (now - Date.parse(row.last_seen) > idleMinutes() * 60000 || !row.active) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(new Date(now).toISOString(), hash);
  return toUser(row);
}

function createSession(res, userId) {
  const token = randomToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?,?,?,?)').run(sha256(token), userId, now, now);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${idleMinutes() * 60}`);
}

function destroySession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// ---------- Login rate limit (in memory) ----------
const failures = new Map();
function checkLoginLimit(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= 10) fail(429, 'تلاش‌های ناموفق زیاد است؛ چند دقیقه صبر کنید');
}
function recordLoginFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (f.until < Date.now()) { f.count = 0; f.until = Date.now() + 15 * 60000; }
  f.count += 1;
  failures.set(ip, f);
}
const clearLoginFailures = (ip) => failures.delete(ip);

// ---------- Permissions ----------
function permsOf(user) {
  if (user.root) return REF.ROLE_PERMS['مدیر سیستم'];
  if (user.perms) {
    // Stored table: every known section, missing entries are denied.
    return Object.fromEntries(Object.keys(REF.SECTIONS).map((s) => [s, {
      view: !!user.perms[s]?.view, create: !!user.perms[s]?.create, edit: !!user.perms[s]?.edit, delete: !!user.perms[s]?.delete,
    }]));
  }
  return REF.ROLE_PERMS[user.role] || Object.fromEntries(Object.keys(REF.SECTIONS).map((s) => [s, {}]));
}
const can = (user, section, action) => !!permsOf(user)[section]?.[action];
function need(user, section, action) {
  if (!can(user, section, action)) fail(403, 'دسترسی لازم برای این عملیات را ندارید');
}

// ---------- Audit ----------
function audit(user, e) {
  db.prepare(`INSERT INTO audit_log (ts, user_id, username, role, action, section, entity, record_id, description, changes, outcome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(),
    user?.id ?? null,
    user?.username || 'سیستم',
    user?.role || '—',
    e.action,
    e.section || '',
    e.entity || '',
    e.recordId == null ? '' : String(e.recordId),
    e.description,
    JSON.stringify(e.changes || []),
    e.outcome || 'موفق',
  );
}

// Compares two view objects (display values) using a labels map.
function diff(before, after, labels) {
  const out = [];
  for (const k of Object.keys(labels)) {
    const a = before?.[k] ?? '—';
    const b = after?.[k] ?? '—';
    if (String(a) !== String(b)) out.push({ field: labels[k], from: a, to: b });
  }
  return out;
}

// ---------- Validation helpers ----------
function normDigits(v) {
  return String(v ?? '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .trim();
}
const str = (v) => normDigits(v);
const isPersianName = (s) => /^[\u0600-\u06FFa-zA-Z\u200c ]{2,40}$/.test(s);
function validNID(n) {
  if (!/^\d{10}$/.test(n) || /^(\d)\1{9}$/.test(n)) return false;
  const c = Number(n[9]);
  const s = [...n.slice(0, 9)].reduce((a, d, i) => a + Number(d) * (10 - i), 0) % 11;
  return s < 2 ? c === s : c === 11 - s;
}
const todayISO = () => J.todayISO();

// Validates one plate. Returns { value, error }.
function parsePlate(p) {
  const v = { a: str(p?.a), b: str(p?.b), c: String(p?.c ?? '').trim(), d: str(p?.d) };
  if (!/^\d{2}$/.test(v.a) || !/^\d{3}$/.test(v.b) || !REF.PLATE_LETTERS.includes(v.c) || !/^\d{2}$/.test(v.d)) {
    return { value: v, error: 'پلاک کامل نیست: دو رقم، سه رقم، حرف مجاز و کد منطقه دو رقمی لازم است' };
  }
  return { value: v, error: null };
}

// Left-to-right isolate (LRI..PDI): keeps the order 2 digits, ایران, 3 digits, letter, 2 digits in RTL text.
function plateText(p) {
  return '\u2066' + J.toFa(`${p.a} ایران ${p.b} ${p.c} ${p.d}`) + '\u2069';
}

// ---------- Multipart ----------
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) fail(400, 'درخواست فرم نامعتبر است');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  const files = {};
  const fileList = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    const hStart = start + 2;
    const hEnd = buf.indexOf('\r\n\r\n', hStart);
    if (hEnd === -1) break;
    const next = buf.indexOf(boundary, hEnd + 4);
    if (next === -1) break;
    const headers = buf.subarray(hStart, hEnd).toString('utf8');
    const data = buf.subarray(hEnd + 4, next - 2);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const fname = /filename="([^"]*)"/.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (name) {
      if (fname) { const f = { filename: fname, type: type || 'application/octet-stream', data }; files[name] = f; fileList.push({ field: name, ...f }); }
      else fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, files, fileList };
}

module.exports = {
  SESSION_COOKIE, IDLE_MIN: ENV_IDLE_MIN, MAX_UPLOAD, MAX_UPLOAD_MB, HttpError, fail, sendJSON, readBody, readJSON,
  currentUser, createSession, destroySession, checkLoginLimit, recordLoginFailure, clearLoginFailures,
  permsOf, can, need, audit, diff, normDigits, str, isPersianName, validNID, todayISO, parsePlate, plateText,
  parseMultipart, parsePerms, idleMinutes, SESSION_LIMITS,
};
