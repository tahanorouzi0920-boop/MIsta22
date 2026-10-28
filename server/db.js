'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const REF = require('./reference');
const { hashPassword } = require('./crypto');

const DATA_DIR = process.env.MISTA_DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'mista.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');

// Each entry is one schema version. Never edit an applied migration; append a new one.
const MIGRATIONS = [`
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  is_root INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  national_id TEXT UNIQUE,
  reg_no TEXT,
  reg_date TEXT,
  legal_type TEXT,
  mobile TEXT NOT NULL,
  phone TEXT,
  econ TEXT,
  country TEXT NOT NULL DEFAULT 'ایران',
  province TEXT,
  city TEXT,
  region TEXT,
  postal TEXT,
  address TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  nid TEXT NOT NULL UNIQUE,
  mobile TEXT NOT NULL,
  gender TEXT NOT NULL,
  start_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  category TEXT NOT NULL,
  cls TEXT NOT NULL,
  year INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  usage TEXT NOT NULL,
  plate_a TEXT NOT NULL,
  plate_b TEXT NOT NULL,
  plate_c TEXT NOT NULL,
  plate_d TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plate_a, plate_b, plate_c, plate_d)
);
CREATE TABLE contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL,
  role TEXT,
  action TEXT NOT NULL,
  section TEXT,
  entity TEXT,
  record_id TEXT,
  description TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT 'موفق'
);
CREATE INDEX audit_ts ON audit_log(ts);
CREATE TABLE doc_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type_id INTEGER NOT NULL REFERENCES doc_types(id),
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  number TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  issuer TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  file_name TEXT,
  stored_name TEXT,
  mime TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX documents_owner ON documents(owner_type, owner_id);
`,
// Migration 2: company document types are retired. Existing records are kept; the types are only deactivated.
`UPDATE doc_types SET active = 0 WHERE owner_type = 'company';
`,
// Migration 3: stable province codes and city IDs. Existing name columns are kept unchanged.
`ALTER TABLE companies ADD COLUMN province_code TEXT;
ALTER TABLE companies ADD COLUMN city_id TEXT;
ALTER TABLE drivers ADD COLUMN province_code TEXT;
ALTER TABLE drivers ADD COLUMN city_id TEXT;
ALTER TABLE drivers ADD COLUMN residence_address TEXT;
`,
// Migration 4: optional link from a document to a contract (vehicle documents only; checked by the server).
`ALTER TABLE documents ADD COLUMN contract_id INTEGER REFERENCES contracts(id);
`,
// Migration 5: administrative section (departments, personnel) and internal letters.
`CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id);
CREATE TABLE personnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  national_id TEXT UNIQUE,
  personnel_code TEXT UNIQUE,
  position TEXT,
  department_id INTEGER REFERENCES departments(id),
  mobile TEXT,
  employment_start TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  body TEXT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_user_id INTEGER REFERENCES users(id),
  recipient_dept_id INTEGER REFERENCES departments(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((recipient_user_id IS NULL) != (recipient_dept_id IS NULL))
);
CREATE TABLE letter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  from_user_id INTEGER REFERENCES users(id),
  from_dept_id INTEGER REFERENCES departments(id),
  to_user_id INTEGER REFERENCES users(id),
  to_dept_id INTEGER REFERENCES departments(id),
  status TEXT NOT NULL,
  note TEXT
);
CREATE INDEX letter_events_letter ON letter_events(letter_id);
CREATE TABLE letter_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
`,
// Migration 6: per-user permission table (NULL = use the role's default permissions).
`ALTER TABLE users ADD COLUMN perms TEXT;
`,
// Migration 7: letter direction (incoming/outgoing/internal) and the absence register.
`ALTER TABLE letters ADD COLUMN kind TEXT NOT NULL DEFAULT 'داخلی';
CREATE TABLE absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX absences_user ON absences(user_id);
`,
// Migration 8: optional start and end times for absence and leave records.
`ALTER TABLE absences ADD COLUMN from_time TEXT;
ALTER TABLE absences ADD COLUMN to_time TEXT;
`,
// Migration 9: vehicle document catalog. New types are added; old vehicle types are deactivated, not deleted,
// so existing documents keep their type.
`INSERT OR IGNORE INTO doc_types (name, category, owner_type, required, active, created_at)
  VALUES ('سند مالکیت','vehicle','vehicle',0,1,datetime('now')),
         ('کارت خودرو','vehicle','vehicle',0,1,datetime('now')),
         ('معاینه فنی','vehicle','vehicle',0,1,datetime('now')),
         ('کارت سوخت','vehicle','vehicle',0,1,datetime('now')),
         ('چشمی','vehicle','vehicle',0,1,datetime('now')),
         ('مخزن گاز','vehicle','vehicle',0,1,datetime('now')),
         ('هیدرواستاتیک','vehicle','vehicle',0,1,datetime('now')),
         ('بیمه شخص ثالث','vehicle','vehicle',0,1,datetime('now')),
         ('بیمه بدنه','vehicle','vehicle',0,1,datetime('now')),
         ('کپسول آتش‌نشانی','vehicle','vehicle',0,1,datetime('now'));
UPDATE doc_types SET active = 0 WHERE owner_type = 'vehicle' AND name NOT IN ('سند مالکیت', 'کارت خودرو', 'معاینه فنی', 'کارت سوخت', 'چشمی', 'مخزن گاز', 'هیدرواستاتیک', 'بیمه شخص ثالث', 'بیمه بدنه', 'کپسول آتش‌نشانی');
`,
// Migration 10: supervision unit on vehicles, vehicle services and shifts.
`ALTER TABLE vehicles ADD COLUMN supervision_unit TEXT;
CREATE TABLE vehicle_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  service_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  odometer TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE vehicle_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  driver_id INTEGER REFERENCES drivers(id),
  shift_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
`,
// Migration 11: administrative automation (announcements, tasks, meetings, document archive) and letter classification.
`ALTER TABLE letters ADD COLUMN classification TEXT NOT NULL DEFAULT 'عادی';
CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'todo',
  due_date TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  meeting_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  agenda TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE meeting_participants (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (meeting_id, user_id)
);
CREATE TABLE archive_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
`,
// Migration 12: system settings (editable from the admin panel).
`CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
// Migration 13: chassis and engine numbers on vehicles (optional; existing rows stay empty).
`ALTER TABLE vehicles ADD COLUMN chassis_no TEXT;
ALTER TABLE vehicles ADD COLUMN engine_no TEXT;
`,
// Migration 14: sites and supervision units. Each unit belongs to exactly one site; companies link to one site and one unit.
`CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE supervision_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, name)
);
ALTER TABLE companies ADD COLUMN site_id INTEGER REFERENCES sites(id);
ALTER TABLE companies ADD COLUMN supervision_unit_id INTEGER REFERENCES supervision_units(id);
`,
// Migration 15: supervision site and unit on each contract (optional; existing contracts stay empty).
`ALTER TABLE contracts ADD COLUMN site_id INTEGER REFERENCES sites(id);
ALTER TABLE contracts ADD COLUMN supervision_unit_id INTEGER REFERENCES supervision_units(id);
`,
// Migration 16: code for supervision units (unique within a site). Existing units keep an empty code.
`ALTER TABLE supervision_units ADD COLUMN code TEXT;
CREATE UNIQUE INDEX supervision_units_site_code ON supervision_units(site_id, code);
`,
// Migration 17: service plans created by the six-step wizard.
`CREATE TABLE service_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  supervision_unit_id INTEGER NOT NULL REFERENCES supervision_units(id),
  region TEXT NOT NULL,
  route_type TEXT NOT NULL,
  gender TEXT NOT NULL,
  return_service TEXT NOT NULL,
  vehicle_group TEXT NOT NULL,
  vehicle_class TEXT NOT NULL DEFAULT '',
  allowed_minutes INTEGER NOT NULL,
  service_number TEXT NOT NULL,
  direction_status TEXT NOT NULL,
  shift_name TEXT,
  routes_json TEXT NOT NULL DEFAULT '[]',
  passengers_json TEXT NOT NULL DEFAULT '[]',
  vehicle_rate_json TEXT,
  company_rate_json TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
// Migration 18: service plans keep the id of the chosen shift.
`ALTER TABLE service_plans ADD COLUMN shift_id INTEGER REFERENCES vehicle_shifts(id);
`,
// Migration 19: fixed services (service type), trips created from a service plan, and driver GPS positions.
`ALTER TABLE service_plans ADD COLUMN service_type TEXT NOT NULL DEFAULT 'ایاب و ذهاب سبک پرسنل';
CREATE TABLE trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_plan_id INTEGER NOT NULL REFERENCES service_plans(id),
  trip_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE driver_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX driver_locations_driver ON driver_locations(driver_id, recorded_at);
`,
// Migration 20: the van category is named ون. Existing rows are renamed; nothing else changes.
`UPDATE vehicles SET category = 'ون' WHERE category = 'وانت';
UPDATE service_plans SET vehicle_group = 'ون' WHERE vehicle_group = 'وانت';
`,
// Migration 21: private tracking links for drivers (only the hash of the token is stored).
`CREATE TABLE driver_tracking_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
`,
// Migration 22: a trip is started and finished by staff for one driver; GPS positions are tied to the trip.
`ALTER TABLE trips ADD COLUMN driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE trips ADD COLUMN started_at TEXT;
ALTER TABLE trips ADD COLUMN ended_at TEXT;
ALTER TABLE driver_locations ADD COLUMN trip_id INTEGER REFERENCES trips(id);
`,
// Migration 23: a driver's user account is linked to its driver record.
`ALTER TABLE users ADD COLUMN driver_id INTEGER REFERENCES drivers(id);
`,
// Migration 24 (phase 1, personnel file): extra personnel fields, a link from user accounts to a personnel record,
// and a documents table for personnel files. Existing personnel rows and their values are kept.
`ALTER TABLE personnel ADD COLUMN address TEXT;
ALTER TABLE personnel ADD COLUMN phone TEXT;
ALTER TABLE personnel ADD COLUMN employer_company_id INTEGER REFERENCES companies(id);
ALTER TABLE personnel ADD COLUMN direct_manager_id INTEGER REFERENCES personnel(id);
ALTER TABLE users ADD COLUMN personnel_id INTEGER REFERENCES personnel(id);
CREATE TABLE personnel_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id),
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX personnel_documents_person ON personnel_documents(personnel_id);
`,
// Migration 25: service requests (کاربرگی), passengers and trip attendance, and a simple finance ledger.
// Finance categories are starting settings, not company accounting rules; the administrator can change them.
`CREATE TABLE service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_no TEXT NOT NULL UNIQUE,
  requester TEXT NOT NULL,
  unit_id INTEGER REFERENCES departments(id),
  request_date TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  passenger_count INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  vehicle_id INTEGER REFERENCES vehicles(id),
  driver_id INTEGER REFERENCES drivers(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE service_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES service_requests(id),
  action TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE passengers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  national_id TEXT UNIQUE,
  mobile TEXT,
  unit_id INTEGER REFERENCES departments(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE trip_passengers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  passenger_id INTEGER NOT NULL REFERENCES passengers(id),
  boarding_station TEXT,
  alighting_station TEXT,
  status TEXT NOT NULL DEFAULT 'booked',
  created_at TEXT NOT NULL,
  UNIQUE (trip_id, passenger_id)
);
CREATE TABLE finance_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO finance_categories (name, kind, active) VALUES
  ('درآمد سرویس', 'income', 1),
  ('سوخت', 'expense', 1),
  ('تعمیر و نگهداری', 'expense', 1),
  ('قطعات', 'expense', 1),
  ('سایر هزینه‌ها', 'expense', 1);
CREATE TABLE finance_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES finance_categories(id),
  amount INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  reference_no TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  service_plan_id INTEGER REFERENCES service_plans(id),
  description TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TEXT,
  payment_method TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
// Migration 26: leave and mission requests with a configurable approval chain and settings.
// The approval chain and the annual allowance are settings; the starting chain is marked as an initial setting.
`CREATE TABLE leave_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE leave_approval_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  role TEXT NOT NULL
);
INSERT INTO leave_approval_steps (position, label, role) VALUES
  (1, 'سرپرست (تنظیم اولیه)', 'مدیر'),
  (2, 'مدیر واحد (تنظیم اولیه)', 'مدیر'),
  (3, 'منابع انسانی (تنظیم اولیه)', 'پرسنل');
CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id),
  kind TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  destination TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  current_step INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE leave_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES leave_requests(id),
  action TEXT NOT NULL,
  step INTEGER,
  note TEXT,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE leave_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES leave_requests(id),
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
// Migration 27: incoming and outgoing letters carry the external party's name.
`ALTER TABLE letters ADD COLUMN external_party TEXT;
`,
// Migration 28: notices can target a unit, carry attachments, and record who read them and when.
`ALTER TABLE announcements ADD COLUMN department_id INTEGER REFERENCES departments(id);
CREATE TABLE announcement_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);
`,
// Migration 29: tasks gain an expected result, priority and a full detail record; progress and history are kept.
`ALTER TABLE tasks ADD COLUMN expected_result TEXT;
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'متوسط';
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Links existing company names to stable codes. Only exact matches are linked; nothing else is changed.
function backfillGeo() {
  const byName = new Map(REF.GEO.provinces.map((p) => [p.name, p.code]));
  const byCity = new Map(REF.GEO.cities.map((c) => [c.provinceCode + '|' + c.name, c.id]));
  const rows = db.prepare('SELECT id, province, city FROM companies WHERE province_code IS NULL AND province IS NOT NULL AND province != \'\'').all();
  const upd = db.prepare('UPDATE companies SET province_code = ?, city_id = ? WHERE id = ?');
  let linkedCity = 0, unlinkedCity = 0;
  for (const r of rows) {
    const pc = byName.get(r.province);
    if (!pc) { unlinkedCity++; continue; }
    const cid = byCity.get(pc + '|' + r.city) || null;
    if (cid) linkedCity++; else unlinkedCity++;
    upd.run(pc, cid, r.id);
  }
  if (rows.length) console.warn(`[MISTA] پیوند کد جغرافیایی: ${linkedCity} شهر پیوند شد؛ ${unlinkedCity} مورد نیاز به بررسی دستی دارد (نام‌ها تغییر نکرده‌اند).`);
}

function seed() {
  const now = new Date().toISOString();
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (!hasUsers) {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
    db.prepare('INSERT INTO users (username, name, pass_hash, role, active, is_root, created_at) VALUES (?,?,?,?,1,1,?)')
      .run(username, 'مدیر اصلی', hashPassword(password), 'مدیر سیستم', now);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[MISTA] رمز پیش‌فرض مدیر اصلی استفاده شد (Admin@12345). پس از اولین ورود آن را تغییر دهید یا ADMIN_PASSWORD را تنظیم کنید.');
    }
  }
  // Idempotent: every catalog item missing by name is added. Existing items keep their current active state.
  const ins = db.prepare('INSERT OR IGNORE INTO doc_types (name, category, owner_type, required, active, created_at) VALUES (?,?,?,0,1,?)');
  for (const t of REF.DOC_CATALOG) ins.run(t.name, t.category, t.owner_type, now);
  db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').run('contract');
  db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').run('letter');
}

migrate();
// Retention: GPS positions older than 30 days are removed when the server starts.
db.prepare("DELETE FROM driver_locations WHERE recorded_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
backfillGeo();
seed();

module.exports = { db, DATA_DIR, UPLOAD_DIR };
