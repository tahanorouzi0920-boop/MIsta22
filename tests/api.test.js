'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mista-test-'));
const ADMIN_PASS = 'Admin@12345';
let server;
let adminCookie = '';

async function req(method, url, { body, cookie, form, raw } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie') || '';
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, setCookie };
}

function cookieFrom(setCookie) { return setCookie.split(';')[0]; }

async function login(username, password) {
  const r = await req('POST', '/api/login', { body: { username, password } });
  return { status: r.status, cookie: r.setCookie ? cookieFrom(r.setCookie) : '', json: r.json };
}

function multipart(fields, ...files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  files.forEach((file, i) => fd.append(files.length === 1 ? 'file' : `file${i + 1}`, new Blob([file.data], { type: file.type }), file.name));
  return fd;
}


// Stand-in for the Neshan routing endpoint, used only by the tests. It checks the documented path, the query
// parameters, the Api-Key header, and returns the documented response shape (routes[0].legs[].distance.value in metres,
// duration.value in seconds). It is NOT the live Neshan service.
const NESHAN_MOCK_PORT = 39000 + Math.floor(Math.random() * 900);
let neshanMock = null;
function startNeshanMock() {
  return new Promise((resolve) => {
    neshanMock = http.createServer((req, resp) => {
      const u = new URL(req.url, 'http://mock');
      if (req.headers['api-key'] !== 'test-key') { resp.writeHead(480, { 'Content-Type': 'application/json' }); return resp.end(JSON.stringify({ code: 480, message: 'KeyNotFound' })); }
      if (u.pathname !== '/v4/direction' || u.searchParams.get('type') !== 'car') { resp.writeHead(404); return resp.end('{}'); }
      const parse = (v) => (v || '').split(',').map(Number);
      const o = parse(u.searchParams.get('origin')), d = parse(u.searchParams.get('destination'));
      if (o.length !== 2 || d.length !== 2 || [...o, ...d].some((x) => !Number.isFinite(x))) { resp.writeHead(470); return resp.end(JSON.stringify({ code: 470, message: 'CoordinateParseError' })); }
      resp.writeHead(200, { 'Content-Type': 'application/json' });
      resp.end(JSON.stringify({ routes: [{ legs: [
        { distance: { text: '۱۲٫۴ کیلومتر', value: 12400 }, duration: { text: '۱۸ دقیقه', value: 1080 } },
        { distance: { text: '۶۰۰ متر', value: 600 }, duration: { text: '۲ دقیقه', value: 120 } },
      ] }] }));
    });
    neshanMock.listen(NESHAN_MOCK_PORT, '127.0.0.1', resolve);
  });
}

before(async () => {
  await startNeshanMock();
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MISTA_DATA_DIR: DATA, ADMIN_PASSWORD: ADMIN_PASS, NESHAN_API_KEY: 'test-key', NESHAN_BASE_URL: `http://127.0.0.1:${NESHAN_MOCK_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const a = await login('admin', ADMIN_PASS);
  adminCookie = a.cookie;
});

after(() => { if (server) server.kill(); if (neshanMock) neshanMock.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

let DRV_TYPE = 1, VEH_TYPE = 7;
test('login succeeds, wrong password fails, unauthenticated access is rejected', async () => {
  assert.equal((await login('admin', ADMIN_PASS)).status, 200);
  assert.equal((await login('admin', 'wrong-password')).status, 401);
  assert.equal((await req('GET', '/api/companies')).status, 401);
});


// Active document types are looked up instead of assuming fixed ids.
test('document types: active driver and vehicle types are resolved for the tests below', async () => {
  const r = await req('GET', '/api/doctypes', { cookie: adminCookie });
  DRV_TYPE = r.json.items.find((t) => t.ownerType === 'driver' && t.active).id;
  VEH_TYPE = r.json.items.find((t) => t.ownerType === 'vehicle' && t.active).id;
});

test('company create validates Persian rules and stores a real record', async () => {
  const bad = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'x', name: 'a', regDate: '2099-01-01', legalType: '01', mobile: '1', country: 'ایران', province: 'تهران', city: 'تهران', address: 'a' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.fields.regDate, 'future registration date must be rejected');
  assert.ok(bad.json.fields.mobile);
  const ok = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'C-100', name: 'شرکت آزمایشی', regDate: '2026-01-10', legalType: '02', mobile: '09121112233', country: 'ایران', province: 'تهران', city: 'ورامین', address: 'تهران، خیابان آزمون' } });
  assert.equal(ok.status, 201);
  const list = await req('GET', '/api/companies?q=C-100', { cookie: adminCookie });
  assert.equal(list.json.items.length, 1);
});

test('driver national ID checksum and duplicate detection', async () => {
  const bad = await req('POST', '/api/drivers', { cookie: adminCookie, body: { first: 'علی', last: 'محمدی', nid: '1234567890', mobile: '09121234567', gender: 'مرد' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.fields.nid);
  const ok = await req('POST', '/api/drivers', { cookie: adminCookie, body: { first: 'علی', last: 'محمدی', nid: '0012345679', mobile: '09121234567', gender: 'مرد', startDate: '2011-08-06' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.startDate, '2011-08-06', 'historical start date must be preserved');
  const dup = await req('POST', '/api/drivers', { cookie: adminCookie, body: { first: 'علی', last: 'محمدی', nid: '0012345679', mobile: '09121234567', gender: 'مرد' } });
  assert.equal(dup.status, 422);
});

test('vehicle plate order is stored and duplicate plates are rejected', async () => {
  const v = { brand: 'سایپا', model: 'پراید ۱۳۱', category: 'سواری', cls: 'B', year: '۱۳۹۸', capacity: '۴', usage: '04 - حمل مسافر (شخصی)', plate: { a: '۲۱', b: '۴۴۳', c: 'ط', d: '۸۳' } };
  const ok = await req('POST', '/api/vehicles', { cookie: adminCookie, body: v });
  assert.equal(ok.status, 201);
  // plateText is wrapped in LRI/PDI isolates so RTL pages keep the logical order.
  assert.equal(ok.json.plateText.replace(/[\u2066\u2069]/g, ''), '۲۱ ایران ۴۴۳ ط ۸۳');
  const dup = await req('POST', '/api/vehicles', { cookie: adminCookie, body: { ...v, model: 'تیبا ۱' } });
  assert.equal(dup.status, 422);
  assert.ok(dup.json.fields.plate);
  const wrongModel = await req('POST', '/api/vehicles', { cookie: adminCookie, body: { ...v, plate: { a: '11', b: '222', c: 'الف', d: '44' }, model: 'سمند' } });
  assert.equal(wrongModel.status, 422);
  assert.ok(wrongModel.json.fields.model, 'model must belong to the selected manufacturer');
});

test('contract numbers are sequential and date rules are enforced on the server', async () => {
  const c1 = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-01', endDate: '2027-06-01' } });
  assert.equal(c1.status, 201);
  assert.match(c1.json.number, /^MST-1405-\d{4}$/);
  const c2 = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-02', endDate: '2027-06-02' } });
  assert.notEqual(c2.json.number, c1.json.number);
  const future = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2099-01-01', endDate: '2100-01-01' } });
  assert.equal(future.status, 422);
  assert.ok(future.json.fields.startDate);
  const reversed = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-05-01', endDate: '2026-04-01' } });
  assert.ok(reversed.json.fields.endDate);
});

test('role permissions: auditor can view and report but cannot modify; deactivated users are locked out', async () => {
  const created = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'auditor1', name: 'ناظر سیستم', role: 'کارفرما', password: 'Auditor@123' } });
  const viewOnly = {}; for (const sec of Object.keys(require('../server/reference').SECTIONS)) viewOnly[sec] = { view: true, create: false, edit: false, delete: false };
  await req('PUT', `/api/users/${(await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === 'auditor1').id}`, { cookie: adminCookie, body: { perms: viewOnly } });
  assert.equal(created.status, 201);
  const aud = await login('auditor1', 'Auditor@123');
  assert.equal(aud.status, 200);
  assert.equal((await req('GET', '/api/companies', { cookie: aud.cookie })).status, 200);
  assert.equal((await req('GET', '/api/audit', { cookie: aud.cookie })).status, 200);
  assert.equal((await req('POST', '/api/companies', { cookie: aud.cookie, body: {} })).status, 403);
  assert.equal((await req('PUT', '/api/users/1', { cookie: aud.cookie, body: { active: false } })).status, 403);
  const deact = await req('PUT', `/api/users/${created.json.id}`, { cookie: adminCookie, body: { active: false } });
  assert.equal(deact.status, 200);
  assert.equal((await req('GET', '/api/companies', { cookie: aud.cookie })).status, 401);
});

test('root administrator cannot be deactivated or demoted, and cannot change own role', async () => {
  assert.equal((await req('PUT', '/api/users/1', { cookie: adminCookie, body: { active: false } })).status, 403);
  assert.equal((await req('PUT', '/api/users/1', { cookie: adminCookie, body: { role: 'حسابرس' } })).status, 403);
});

test('document upload validates type, content signature and size; download is permission-protected', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% test\n');
  const ok = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'driver', ownerId: '1', number: '12345', expiryDate: '2030-01-01' }, { name: 't.pdf', type: 'application/pdf', data: pdf }) });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.status, 'pending', 'uploaded documents must not be verified automatically');
  const fake = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'driver', ownerId: '1' }, { name: 'x.png', type: 'image/png', data: Buffer.from('not a png') }) });
  assert.equal(fake.status, 415);
  const exe = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'driver', ownerId: '1' }, { name: 'x.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }) });
  assert.equal(exe.status, 415);
  const na = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'driver', ownerId: '1', notApplicable: 'true' }) });
  assert.equal(na.json.status, 'na', 'optional documents may be recorded as not applicable without a file');
  const dl = await req('GET', `/api/documents/${ok.json.id}/file`, { cookie: adminCookie, raw: true });
  assert.equal(dl.status, 200);
  assert.ok(dl.buf.equals(pdf));
  assert.equal((await req('GET', `/api/documents/${ok.json.id}/file`, { raw: true })).status, 401);
  const approved = await req('POST', `/api/documents/${ok.json.id}/review`, { cookie: adminCookie, body: { decision: 'approved' } });
  assert.equal(approved.json.status, 'approved');
});

test('audit log records create and update events with before/after values', async () => {
  const r = await req('PUT', '/api/companies/1', { cookie: adminCookie, body: { code: 'C-001', name: 'حمل‌ونقل پارس', regDate: '2026-10-01', legalType: '01', mobile: '09120000000', country: 'ایران', province: 'تهران', city: 'تهران', address: 'تهران خیابان نمونه' } });
  assert.equal(r.status, 200);
  const audit = await req('GET', '/api/audit?section=companies&action=update&size=5', { cookie: adminCookie });
  const ev = audit.json.items[0];
  assert.equal(ev.username, 'admin');
  const phone = ev.changes.find((c) => c.field === 'موبایل');
  assert.ok(phone, 'mobile change must be recorded');
  assert.equal(phone.to, '۰۹۱۲۰۰۰۰۰۰۰', 'audit displays Persian digits');
});

test('dashboard returns database-derived metrics for the selected range', async () => {
  const d = await req('GET', '/api/dashboard?from=2026-01-01&to=2026-12-31', { cookie: adminCookie });
  assert.equal(d.status, 200);
  assert.ok(d.json.companies.total >= 1);
  assert.ok(d.json.contracts.total >= 2);
  assert.ok(Array.isArray(d.json.contracts.byMonth));
});

test('static files send nosniff and path traversal is blocked', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const t = await fetch(BASE + '/%2e%2e/%2e%2e/etc/passwd');
  assert.notEqual(t.status, 200);
});

test('company country is fixed to Iran on create', async () => {
  const r = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'C-300', name: 'شرکت خارجی', regDate: '2026-01-10', legalType: '01', mobile: '09121112233', country: 'افغانستان', province: '', city: '', address: 'کابل، نمونه' } });
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.country);
});

test('company city must belong to the selected province on the server', async () => {
  const r = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'C-301', name: 'شرکت نامتناسب', regDate: '2026-01-10', legalType: '01', mobile: '09121112233', country: 'ایران', province: 'تهران', city: 'مشهد', address: 'تهران، نمونه' } });
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.city, 'a city from another province must be rejected');
  const alborz = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'C-302', name: 'شرکت البرز', regDate: '2026-01-10', legalType: '01', mobile: '09121112233', country: 'ایران', province: 'البرز', city: 'کرج', address: 'کرج، نمونه' } });
  assert.equal(alborz.status, 201);
});

test('company province change: city of old province is rejected by the server', async () => {
  const r = await req('PUT', '/api/companies/1', { cookie: adminCookie, body: { code: 'C-001', name: 'حمل‌ونقل پارس', regDate: '2026-10-01', legalType: '01', mobile: '09120000000', country: 'ایران', province: 'البرز', city: 'تهران', address: 'تهران خیابان نمونه' } });
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.city);
});

test('company reports filter by stable province code and city ID', async () => {
  const GEO = require('../server/geo/geo-data.json');
  const prov = GEO.provinces.find((p) => p.name === 'البرز').code;
  const city = GEO.cities.find((c) => c.name === 'کرج' && c.provinceCode === prov).id;
  const r = await req('GET', `/api/reports/companies?province=${prov}&city=${city}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length >= 1);
  assert.ok(r.json.items.every((c) => c.cityId === city && c.provinceCode === prov));
});

test('company saved with province code and city ID returns both and rejects a mismatched city ID', async () => {
  const GEO = require('../server/geo/geo-data.json');
  const tehran = GEO.provinces.find((p) => p.name === 'تهران').code;
  const mashhadCity = GEO.cities.find((c) => c.name === 'مشهد').id;
  const bad = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'C-310', name: 'شرکت کد نامتناسب', regDate: '2026-01-10', legalType: '01', mobile: '09121112233', country: 'ایران', provinceCode: tehran, cityId: mashhadCity, address: 'تهران، نمونه' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.fields.city);
  const cityId = GEO.cities.find((c) => c.name === 'ورامین').id;
  const ok = await req('POST', '/api/companies', { cookie: adminCookie, body: { code: 'C-311', name: 'شرکت ورامین', regDate: '2026-01-10', legalType: '01', mobile: '09121112233', country: 'ایران', provinceCode: tehran, cityId, address: 'ورامین، نمونه' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.provinceCode, tehran);
  assert.equal(ok.json.cityId, cityId);
  assert.equal(ok.json.city, 'ورامین');
});

test('driver residence is optional, and when given must be a valid province and its city', async () => {
  const GEO = require('../server/geo/geo-data.json');
  const base = { first: 'رضا', last: 'کریمی', nid: '0023456787', mobile: '09121230000', gender: 'مرد' };
  const none = await req('POST', '/api/drivers', { cookie: adminCookie, body: base });
  assert.equal(none.status, 201, 'driver without residence must still be saved');
  const isf = GEO.provinces.find((p) => p.name === 'اصفهان').code;
  const tehranCity = GEO.cities.find((c) => c.name === 'تهران').id;
  const bad = await req('PUT', `/api/drivers/${none.json.id}`, { cookie: adminCookie, body: { ...base, provinceCode: isf, cityId: tehranCity } });
  assert.equal(bad.status, 422);
  const cityOk = GEO.cities.find((c) => c.name === 'کاشان').id;
  const good = await req('PUT', `/api/drivers/${none.json.id}`, { cookie: adminCookie, body: { ...base, provinceCode: isf, cityId: cityOk, residenceAddress: 'کاشان، خیابان نمونه' } });
  assert.equal(good.status, 200);
  assert.equal(good.json.city, 'کاشان');
  assert.equal(good.json.residenceAddress, 'کاشان، خیابان نمونه');
  const again = await req('GET', '/api/drivers', { cookie: adminCookie });
  assert.equal(again.json.items.find((d) => d.nid === '0023456787').cityId, cityOk, 'residence must persist');
});

test('geographic dataset has 31 provinces with unique codes and cities linked to existing provinces', async () => {
  const GEO = require('../server/geo/geo-data.json');
  assert.equal(GEO.provinces.length, 31);
  assert.equal(new Set(GEO.provinces.map((p) => p.code)).size, 31);
  const codes = new Set(GEO.provinces.map((p) => p.code));
  assert.ok(GEO.cities.every((c) => codes.has(c.provinceCode) && c.id.startsWith(c.provinceCode + '-')));
  assert.equal(new Set(GEO.cities.map((c) => c.id)).size, GEO.cities.length);
  const ref = await req('GET', '/api/reference', { cookie: adminCookie });
  assert.equal(ref.json.geo.provinces.length, 31);
});

test('geo import tool refuses inconsistent data and never writes on dry run', { skip: false }, () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const tool = path.join(__dirname, '..', 'tools', 'import-geo.js');
  const csv = path.join(DATA, 'bad.csv');
  fs.writeFileSync(csv, 'province_code,province_name,city_id,city_name\nP01,آذربایجان شرقی,P02-001,تبریز\n', 'utf8');
  const r = spawnSync(process.execPath, [tool, csv, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /شناسه شهر باید/);
  const before = fs.readFileSync(path.join(__dirname, '..', 'server', 'geo', 'geo-data.json'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'server', 'geo', 'geo-data.json'), 'utf8'), before);
});

test('documents belong only to drivers or vehicles; company owners are rejected', async () => {
  const r = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'company', ownerId: '1', notApplicable: 'true' }) });
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.ownerType);
  const types = await req('GET', '/api/doctypes', { cookie: adminCookie });
  assert.ok(!types.json.items.some((t) => t.ownerType === 'company' && t.active), 'company document types must not be active');
});

test('driver and vehicle documents are separated; listing is filtered by owner', async () => {
  const veh = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(VEH_TYPE), ownerType: 'vehicle', ownerId: '1', expiryDate: '2030-01-01' }, { name: 'ins.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 vehicle') }) });
  assert.equal(veh.status, 201, JSON.stringify(veh.json));
  const driverDocs = await req('GET', '/api/documents?ownerType=driver&ownerId=1', { cookie: adminCookie });
  assert.ok(driverDocs.json.items.length >= 1);
  assert.ok(driverDocs.json.items.every((d) => d.ownerType === 'driver' && d.ownerId === 1));
  const vehicleDocs = await req('GET', '/api/documents?ownerType=vehicle&ownerId=1', { cookie: adminCookie });
  assert.equal(vehicleDocs.json.items.length, 1);
  assert.equal(vehicleDocs.json.items[0].id, veh.json.id);
  const mismatch = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'vehicle', ownerId: '1', notApplicable: 'true' }) });
  assert.equal(mismatch.status, 422, 'a driver document type cannot be attached to a vehicle');
});

test('partial document update keeps fields that were not sent', async () => {
  const docs = await req('GET', '/api/documents?ownerType=driver&ownerId=1', { cookie: adminCookie });
  const d = docs.json.items.find((x) => x.expiryDate === '2030-01-01');
  assert.ok(d);
  const before = d.number;
  const upd = await req('PUT', `/api/documents/${d.id}`, { cookie: adminCookie, body: { notes: 'یادداشت جدید' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.number, before, 'number must not be erased by a partial update');
  assert.equal(upd.json.expiryDate, '2030-01-01');
  assert.equal(upd.json.notes, 'یادداشت جدید');
});

test('vehicle document can be linked to a contract of the same vehicle only', async () => {
  const v2 = await req('POST', '/api/vehicles', { cookie: adminCookie, body: { brand: 'سایپا', model: 'تیبا ۱', category: 'سواری', cls: 'B', year: 1399, capacity: 4, usage: '04 - حمل مسافر (شخصی)', plate: { a: '55', b: '555', c: 'ب', d: '55' } } });
  assert.equal(v2.status, 201);
  const contracts = (await req('GET', '/api/contracts', { cookie: adminCookie })).json.items;
  const c1 = contracts.find((k) => k.vehicleId === 1);
  assert.ok(c1, 'a contract of vehicle 1 must exist');
  const c2 = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: v2.json.id, startDate: '2026-10-01', endDate: '2027-06-01' } });
  assert.equal(c2.status, 201);

  const good = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(VEH_TYPE), ownerType: 'vehicle', ownerId: '1', contractId: String(c1.id), expiryDate: '2030-06-01' }, { name: 'ins-linked.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 linked') }) });
  assert.equal(good.status, 201, JSON.stringify(good.json));
  assert.equal(good.json.contractId, c1.id);
  assert.equal(good.json.contractNumber, c1.number);

  const wrong = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(VEH_TYPE), ownerType: 'vehicle', ownerId: '1', contractId: String(c2.json.id) }, { name: 'x.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 wrong') }) });
  assert.equal(wrong.status, 422, 'a contract of another vehicle must be rejected');
  assert.ok(wrong.json.fields.contractId);

  const driverLink = await req('POST', '/api/documents', { cookie: adminCookie, form: multipart({ docTypeId: String(DRV_TYPE), ownerType: 'driver', ownerId: '1', contractId: String(c1.id), notApplicable: 'true' }) });
  assert.equal(driverLink.status, 422, 'driver documents must not link to a vehicle contract');

  const listed = await req('GET', `/api/documents?ownerType=vehicle&ownerId=1&contractId=${c1.id}`, { cookie: adminCookie });
  assert.ok(listed.json.items.some((d) => d.id === good.json.id), 'the linked document must be found by contract');
  assert.ok(listed.json.items.every((d) => d.contractId === c1.id));

  const reread = await req('GET', `/api/documents/${good.json.id}`, { cookie: adminCookie });
  assert.equal(reread.json.contractNumber, c1.number, 'the link must survive a reload');

  const moved = await req('PUT', `/api/documents/${good.json.id}`, { cookie: adminCookie, body: { contractId: c2.json.id } });
  assert.equal(moved.status, 422);
  const unlinked = await req('PUT', `/api/documents/${good.json.id}`, { cookie: adminCookie, body: { contractId: null } });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.json.contractId, null);
});

test('GET /api/me: 401 when logged out, user object with perms when logged in', async () => {
  const anon = await req('GET', '/api/me');
  assert.equal(anon.status, 401);
  const me = await req('GET', '/api/me', { cookie: adminCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, 'admin');
  assert.equal(me.json.user.root, true);
  assert.ok(me.json.perms.companies);
});

// ---------- Departments and internal letters ----------
test('departments: admin creates, duplicates are rejected, ordinary user cannot create', async () => {
  const d = await req('POST', '/api/departments', { cookie: adminCookie, body: { name: 'مالی' } });
  assert.equal(d.status, 201);
  assert.equal((await req('POST', '/api/departments', { cookie: adminCookie, body: { name: 'مالی' } })).status, 422);
  await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'ordinary1', name: 'کاربر یک', role: 'پرسنل', password: 'Ordinary@123' } });
  const noPers = {}; for (const sec of Object.keys(require('../server/reference').SECTIONS)) noPers[sec] = { view: sec === 'letters', create: sec === 'letters', edit: sec === 'letters', delete: false };
  await req('PUT', `/api/users/${(await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === 'ordinary1').id}`, { cookie: adminCookie, body: { perms: noPers } });
  const ord = await login('ordinary1', 'Ordinary@123');
  assert.equal((await req('POST', '/api/departments', { cookie: ord.cookie, body: { name: 'فنی' } })).status, 403);
});

test('users: department can be assigned and changed, invalid department rejected', async () => {
  const depts = (await req('GET', '/api/departments', { cookie: adminCookie })).json.items;
  const mali = depts.find((d) => d.name === 'مالی');
  const created = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'letterA', name: 'علی احمدی', role: 'پرسنل', password: 'LetterA@123', departmentId: mali.id } });
  assert.equal(created.status, 201);
  assert.equal(created.json.departmentId, mali.id);
  assert.equal((await req('PUT', `/api/users/${created.json.id}`, { cookie: adminCookie, body: { departmentId: 99999 } })).status, 422);
});

test('internal letters: send with attachment, visibility, receive, forward to a department, close, access rules', async () => {
  const depts = (await req('GET', '/api/departments', { cookie: adminCookie })).json.items;
  const mali = depts.find((d) => d.name === 'مالی');
  const bUser = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'letterB', name: 'رضا کریمی', role: 'پرسنل', password: 'LetterB@123' } });
  const cUser = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'letterC', name: 'نیلوفر حسینی', role: 'پرسنل', password: 'LetterC@123', departmentId: mali.id } });
  const dUser = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'letterD', name: 'مهدی رضایی', role: 'پرسنل', password: 'LetterD@123' } });
  assert.equal(bUser.status + cUser.status + dUser.status, 201 * 3);
  const A = await login('ordinary1', 'Ordinary@123');
  const B = await login('letterB', 'LetterB@123');
  const C = await login('letterC', 'LetterC@123');
  const D = await login('letterD', 'LetterD@123');

  const sent = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(bUser.json.id), subject: 'درخواست گزارش هفتگی', body: 'لطفاً گزارش را ارسال کنید.' }, { name: 'attach.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 letter') }) });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.match(sent.json.number, /^LTR-\d{4}-\d{5}$/);
  const id = sent.json.id;

  assert.equal((await req('GET', `/api/letters/${id}`, { cookie: D.cookie })).status, 404, 'outsider must not see the letter');
  assert.ok((await req('GET', '/api/letters?box=inbox', { cookie: B.cookie })).json.items.some((l) => l.id === id));
  assert.ok((await req('GET', '/api/letters?box=outbox', { cookie: A.cookie })).json.items.some((l) => l.id === id));
  assert.equal((await req('GET', '/api/letters?box=inbox', { cookie: D.cookie })).json.items.some((l) => l.id === id), false);

  const recv = await req('POST', `/api/letters/${id}/action`, { cookie: B.cookie, body: { action: 'receive' } });
  assert.equal(recv.json.status, 'received');
  assert.equal((await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'dept', recipientId: String(mali.id), subject: 'تست واحد' }) })).status, 422);
  assert.equal((await req('POST', `/api/letters/${id}/action`, { cookie: B.cookie, body: { action: 'receive' } })).status, 422);

  const toDept = await req('POST', `/api/letters/${id}/action`, { cookie: B.cookie, body: { action: 'forward', recipientType: 'dept', recipientId: mali.id, note: 'x' } });
  assert.equal(toDept.status, 422, 'departments are not valid letter recipients');
  const fwd = await req('POST', `/api/letters/${id}/action`, { cookie: B.cookie, body: { action: 'forward', recipientType: 'user', recipientId: cUser.json.id, note: 'برای پیگیری' } });
  assert.equal(fwd.status, 200, JSON.stringify(fwd.json));
  assert.equal(fwd.json.status, 'sent');
  assert.equal((await req('POST', `/api/letters/${id}/action`, { cookie: B.cookie, body: { action: 'in_review' } })).status, 403, 'previous holder cannot act after forwarding');

  const cView = await req('GET', `/api/letters/${id}`, { cookie: C.cookie });
  assert.equal(cView.status, 200, 'the forwarded-to user must see the letter');
  assert.equal(cView.json.canAct, true);
  assert.equal((await req('GET', `/api/letters/${id}`, { cookie: D.cookie })).status, 404);
  const aView = await req('GET', `/api/letters/${id}`, { cookie: A.cookie });
  assert.equal(aView.status, 200, 'sender keeps access through history');
  assert.ok(aView.json.events.length >= 3, 'history has send, receive and forward');
  assert.equal(aView.json.canAct, false);

  assert.equal((await req('POST', `/api/letters/${id}/action`, { cookie: D.cookie, body: { action: 'receive' } })).status, 404);
  assert.equal((await req('POST', `/api/letters/${id}/action`, { cookie: C.cookie, body: { action: 'in_review' } })).json.status, 'in_review');
  assert.equal((await req('POST', `/api/letters/${id}/action`, { cookie: C.cookie, body: { action: 'close', note: 'انجام شد' } })).json.status, 'closed');
  assert.equal((await req('POST', `/api/letters/${id}/action`, { cookie: C.cookie, body: { action: 'forward', recipientType: 'user', recipientId: bUser.json.id } })).status, 422, 'closed letters cannot be forwarded');

  const att = (await req('GET', `/api/letters/${id}`, { cookie: A.cookie })).json.attachments[0];
  const dl = await req('GET', `/api/letters/${id}/attachments/${att.id}`, { cookie: A.cookie, raw: true });
  assert.equal(dl.status, 200);
  assert.equal((await req('GET', `/api/letters/${id}/attachments/${att.id}`, { cookie: D.cookie, raw: true })).status, 404);

  const audit = await req('GET', '/api/audit?section=letters&size=20', { cookie: adminCookie });
  assert.ok(audit.json.items.some((x) => x.description.includes('ثبت نامه')), 'letter send is audited');
});

test('letter sender cannot send to themselves, and unknown recipients are rejected', async () => {
  const A = await login('ordinary1', 'Ordinary@123');
  const me = (await req('GET', '/api/me', { cookie: A.cookie })).json.user;
  const self = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(me.id), subject: 'تست' }) });
  assert.equal(self.status, 422);
  const bad = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'dept', recipientId: '99999', subject: 'تست' }) });
  assert.equal(bad.status, 422);
});

test('roles: new users can only be مدیر سیستم، کارفرما یا پرسنل', async () => {
  assert.equal((await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'roleBad1', name: 'نقش بد', role: 'کاربر عادی', password: 'RoleBad@123' } })).status, 422);
  const ok = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'rolePers1', name: 'پرسنل یک', role: 'پرسنل', password: 'Personel@123' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.role, 'پرسنل');
});

test('per-user permissions: admin sets a section table, enforced on the server, reset on role change', async () => {
  const u = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === 'rolePers1');
  const pers = await login('rolePers1', 'Personel@123');
  assert.equal((await req('GET', '/api/letters', { cookie: pers.cookie })).status, 200, 'role default: letters view');
  const noView = {};
  for (const sec of Object.keys(require('../server/reference').SECTIONS)) noView[sec] = { view: false, create: false, edit: false, delete: false };
  const set = await req('PUT', `/api/users/${u.id}`, { cookie: adminCookie, body: { perms: noView } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.hasCustomPerms, true);
  assert.equal((await req('GET', '/api/letters', { cookie: pers.cookie })).status, 403, 'custom table is enforced by the server');
  const grant = { ...noView, letters: { view: true, create: false, edit: false, delete: false } };
  await req('PUT', `/api/users/${u.id}`, { cookie: adminCookie, body: { perms: grant } });
  assert.equal((await req('GET', '/api/letters', { cookie: pers.cookie })).status, 200);
  assert.equal((await req('POST', '/api/letters', { cookie: pers.cookie, form: multipart({ recipientType: 'user', recipientId: '1', subject: 'تست' }) })).status, 403, 'view only, no create');
  const roleChanged = await req('PUT', `/api/users/${u.id}`, { cookie: adminCookie, body: { role: 'کارفرما' } });
  assert.equal(roleChanged.json.hasCustomPerms, false, 'role change resets the table');
  assert.equal(roleChanged.json.perms.users.view, 1, 'کارفرما default applies');
});

test('per-user permissions: unknown section rejected; administrator and own account cannot be changed', async () => {
  const u = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === 'rolePers1');
  assert.equal((await req('PUT', `/api/users/${u.id}`, { cookie: adminCookie, body: { perms: { bogus: { view: true } } } })).status, 422);
  assert.equal((await req('PUT', '/api/users/1', { cookie: adminCookie, body: { perms: {} } })).status, 403, 'root permissions are fixed');
  const self = (await req('GET', '/api/me', { cookie: adminCookie })).json.user;
  assert.equal((await req('PUT', `/api/users/${self.id}`, { cookie: adminCookie, body: { perms: {} } })).status, 403);
});

test('letters: only internal letters, any attachment type accepted, several files per letter', async () => {
  const A = await login('ordinary1', 'Ordinary@123');
  const bu = (await req('GET', '/api/letters/recipients', { cookie: A.cookie })).json.users[0];
  assert.equal((await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(bu.id), subject: 'ورودی', kind: 'ورودی' }) })).status, 422, 'only داخلی is allowed');
  const r = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(bu.id), subject: 'نامه داخلی تست', kind: 'داخلی' },
    { name: 'data.xlsx', type: 'application/vnd.ms-excel', data: Buffer.from('PK-fake-xlsx') }, { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 x') }) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.kind, 'داخلی');
  const det = await req('GET', `/api/letters/${r.json.id}`, { cookie: A.cookie });
  assert.equal(det.json.attachments.length, 2);
  assert.match(det.json.summary, /وضعیت: ارسال‌شده/);
  const dl = await req('GET', `/api/letters/${r.json.id}/attachments/${det.json.attachments[0].id}`, { cookie: A.cookie, raw: true });
  assert.equal(dl.status, 200, 'attachment is downloadable by the holder');
});

test('letters: holder can approve or reject from any role; main administrator sees every letter; others cannot', async () => {
  const A = await login('ordinary1', 'Ordinary@123');
  const users = (await req('GET', '/api/users', { cookie: adminCookie })).json.items;
  const target = users.find((u) => u.username === 'letterB');
  const sent = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(target.id), subject: 'برای تأیید' }) });
  const B = await login('letterB', 'LetterB@123');
  const ok = await req('POST', `/api/letters/${sent.json.id}/action`, { cookie: B.cookie, body: { action: 'approve', note: 'موافقم' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.status, 'approved');
  const other = await req('POST', `/api/letters/${sent.json.id}/action`, { cookie: A.cookie, body: { action: 'reject' } });
  assert.equal(other.status, 403, 'the sender is not the holder and cannot approve or reject');
  const sent2 = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(target.id), subject: 'برای رد' }) });
  const rej = await req('POST', `/api/letters/${sent2.json.id}/action`, { cookie: B.cookie, body: { action: 'reject' } });
  assert.equal(rej.json.status, 'rejected');
  const everyOne = await req('GET', '/api/letters?box=everyone', { cookie: adminCookie });
  assert.ok(everyOne.json.items.some((l) => l.id === sent2.json.id), 'main administrator sees letters they are not party to');
  assert.equal((await req('GET', '/api/letters?box=everyone', { cookie: A.cookie })).status, 403);
});

test('absences: start and end times are stored and validated', async () => {
  const A = await login('ordinary1', 'Ordinary@123');
  const ordId = (await req('GET', '/api/me', { cookie: A.cookie })).json.user.id;
  const curPerms = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.id === ordId).perms;
  await req('PUT', `/api/users/${ordId}`, { cookie: adminCookie, body: { perms: { ...curPerms, absences: { view: true, create: true, edit: false, delete: false } } } });
  const ok = await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'مرخصی', fromDate: '2026-10-02', toDate: '2026-10-02', fromTime: '09:00', toTime: '11:30' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.fromTime, '09:00');
  assert.equal(ok.json.toTime, '11:30');
  assert.equal((await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'مرخصی', fromDate: '2026-10-02', toDate: '2026-10-02', fromTime: '11:00', toTime: '10:00' } })).status, 422);
  assert.equal((await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'غیبت', fromDate: '2026-10-03', toDate: '2026-10-03', fromTime: '25:00' } })).status, 422);
});

test('absences: record, validate dates, employees see only their own, managers see all', async () => {
  const A = await login('ordinary1', 'Ordinary@123');
  const ordId = (await req('GET', '/api/me', { cookie: A.cookie })).json.user.id;
  const absPerms = { absences: { view: true, create: true, edit: false, delete: false } };
  const curPerms = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.id === ordId).perms;
  await req('PUT', `/api/users/${ordId}`, { cookie: adminCookie, body: { perms: { ...curPerms, ...absPerms } } });
  const me = (await req('GET', '/api/me', { cookie: A.cookie })).json.user;
  const ok = await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'مرخصی', fromDate: '2026-10-01', toDate: '2026-10-03', note: 'استعلاجی' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.userId, me.id);
  assert.equal((await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'غیبت', fromDate: '2026-10-05', toDate: '2026-10-01' } })).status, 422, 'end before start');
  assert.equal((await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'نامعلوم', fromDate: '2026-10-01', toDate: '2026-10-01' } })).status, 422);
  const mine = await req('GET', '/api/absences', { cookie: A.cookie });
  assert.ok(mine.json.items.every((x) => x.userId === me.id));
  const all = await req('GET', '/api/absences', { cookie: adminCookie });
  assert.ok(all.json.canManageAll);
  assert.ok(all.json.items.some((x) => x.id === ok.json.id));
  assert.equal((await req('POST', '/api/absences', { cookie: A.cookie, body: { kind: 'غیبت', fromDate: '2026-10-01', toDate: '2026-10-01', userId: 1 } })).status, 403, 'ordinary user cannot record for others');
});

test('health endpoint reports the release version', async () => {
  const h = await req('GET', '/api/health');
  assert.equal(h.json.version, '1.1.0');
});

test('contracts: end date is optional; open-ended contract has its own status; edit without end date keeps the stored end', async () => {
  const open = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-03' } });
  assert.equal(open.status, 201, JSON.stringify(open.json));
  assert.equal(open.json.status, 'بدون تاریخ پایان');
  const dated = await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-04', endDate: '2027-07-01' } });
  assert.equal(dated.status, 201);
  const edited = await req('PUT', `/api/contracts/${dated.json.id}`, { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-04' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const again = await req('GET', '/api/contracts', { cookie: adminCookie });
  const row = again.json.items.find((x) => x.id === dated.json.id);
  assert.equal(row.endDate, '2027-07-01', 'stored end date is kept when the form does not send one');
  assert.equal((await req('POST', '/api/contracts', { cookie: adminCookie, body: { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-05', endDate: 'bad' } })).status, 422);
});

test('letters: notice (اطلاعیه) can be received and closed but never approved or rejected', async () => {
  const A = await login('ordinary1', 'Ordinary@123');
  const target = (await req('GET', '/api/letters/recipients', { cookie: A.cookie })).json.users[0];
  const T = await login(target.name ? (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.id === target.id).username : 'letterB', 'LetterB@123').catch(() => null);
  const n = await req('POST', '/api/letters', { cookie: A.cookie, form: multipart({ recipientType: 'user', recipientId: String(target.id), subject: 'اطلاعیه تست', kind: 'اطلاعیه' }) });
  assert.equal(n.status, 201, JSON.stringify(n.json));
  assert.equal(n.json.kind, 'اطلاعیه');
  if (!T) return;
  assert.equal((await req('POST', `/api/letters/${n.json.id}/action`, { cookie: T.cookie, body: { action: 'approve' } })).status, 422);
  assert.equal((await req('POST', `/api/letters/${n.json.id}/action`, { cookie: T.cookie, body: { action: 'reject' } })).status, 422);
  assert.equal((await req('POST', `/api/letters/${n.json.id}/action`, { cookie: T.cookie, body: { action: 'receive' } })).json.status, 'received');
});

test('duplicates: economic code and registration number are unique and reported as duplicates; vehicle class only for passenger cars', async () => {
  const base = { country: 'ایران', province: 'تهران', city: 'ورامین', address: 'تهران، خیابان آزمون', regDate: '2026-01-10', legalType: '01', mobile: '09121112233' };
  const a = await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'DUP-A', name: 'الف', econ: '123456789012', regNo: 'REG-77' } });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const b1 = await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'DUP-B', name: 'ب', econ: '123456789012' } });
  assert.equal(b1.status, 422);
  assert.match(b1.json.fields.econ, /تکراری/);
  const b2 = await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'DUP-C', name: 'ج', regNo: 'REG-77' } });
  assert.equal(b2.status, 422);
  assert.match(b2.json.fields.regNo, /تکراری/);
  const van = await req('POST', '/api/vehicles', { cookie: adminCookie, body: { brand: 'سایپا', model: 'پراید ۱۳۱', category: 'ون', cls: 'C', year: '۱۳۹۸', capacity: '۲', usage: '04 - حمل مسافر (شخصی)', plate: { a: '۱۱', b: '۲۲۲', c: 'ب', d: '۳۳' } } });
  assert.equal(van.status, 201, JSON.stringify(van.json));
  assert.equal(van.json.cls, '', 'a van keeps no class');
});

test('administrative automation: announcements, tasks, meetings, document archive and personal inbox', async () => {
  const a = await req('POST', '/api/announcements', { cookie: adminCookie, form: multipart({ title: 'جلسه هفتگی', body: 'ساعت ۹ صبح', pinned: 'true' }) });
  assert.equal(a.status, 201);
  assert.equal((await req('GET', '/api/announcements', { cookie: adminCookie })).json.items[0].title, 'جلسه هفتگی', 'pinned first');
  const me = (await req('GET', '/api/me', { cookie: adminCookie })).json.user;
  const asgName = 'tsk' + Math.floor(Math.random() * 1e6);
  const asgNew = await req('POST', '/api/users', { cookie: adminCookie, body: { username: asgName, name: 'مسئول وظیفه', role: 'پرسنل', password: 'TaskPass123' } });
  assert.equal(asgNew.status, 201, JSON.stringify(asgNew.json));
  const asg = { id: asgNew.json.id };
  const asgCookie = (await login(asgName, 'TaskPass123')).cookie;
  const t = await req('POST', '/api/tasks', { cookie: adminCookie, body: { title: 'تهیه گزارش ماهانه', assigneeId: asg.id, dueDate: '2026-12-01' } });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  const tasks = await req('GET', '/api/tasks', { cookie: adminCookie });
  const task = tasks.json.items.find((x) => x.title === 'تهیه گزارش ماهانه');
  assert.equal((await req('PUT', `/api/tasks/${task.id}/status`, { cookie: adminCookie, body: { status: 'doing' } })).status, 403, 'only the assignee changes status');
  assert.equal((await req('PUT', `/api/tasks/${task.id}/status`, { cookie: asgCookie, body: { status: 'doing' } })).status, 200);
  assert.equal((await req('PUT', `/api/tasks/${task.id}/status`, { cookie: asgCookie, body: { status: 'nope' } })).status, 422);
  const m = await req('POST', '/api/meetings', { cookie: adminCookie, body: { title: 'جلسه بودجه', meetingDate: '2026-12-05', startTime: '10:00', endTime: '11:00', participants: [me.id] } });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  assert.equal((await req('POST', '/api/meetings', { cookie: adminCookie, body: { title: 'بد', meetingDate: '2026-12-05', startTime: '11:00', endTime: '10:00' } })).status, 422);
  const doc = await req('POST', '/api/archive', { cookie: adminCookie, form: multipart({ title: 'آیین‌نامه داخلی', category: 'اداری' }, { name: 'rules.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 rules') }) });
  assert.equal(doc.status, 201, JSON.stringify(doc.json));
  const list = await req('GET', '/api/archive?category=اداری', { cookie: adminCookie });
  assert.ok(list.json.items.some((d) => d.title === 'آیین‌نامه داخلی'));
  const inbox = await req('GET', '/api/inbox', { cookie: adminCookie });
  const asgInbox = await req('GET', '/api/inbox', { cookie: asgCookie });
  assert.ok(asgInbox.json.tasks >= 1, 'the assignee sees the open task in the inbox');
  assert.ok(inbox.json.meetings >= 1);
  const bad = await req('POST', '/api/letters', { cookie: adminCookie, form: multipart({ recipientType: 'user', recipientId: String(me.id), subject: 'طبقه نامعتبر', classification: 'نامعلوم' }) });
  assert.equal(bad.status, 422);
});

test('system settings: session idle timeout is set by the administrator, validated, and applied', async () => {
  const cur = await req('GET', '/api/settings', { cookie: adminCookie });
  assert.equal(cur.status, 200);
  assert.equal((await req('PUT', '/api/settings/session-timeout', { cookie: adminCookie, body: { minutes: 0 } })).status, 422);
  assert.equal((await req('PUT', '/api/settings/session-timeout', { cookie: adminCookie, body: { minutes: 1441 } })).status, 422);
  assert.equal((await req('PUT', '/api/settings/session-timeout', { cookie: adminCookie, body: { minutes: 2.5 } })).status, 422);
  const ok = await req('PUT', '/api/settings/session-timeout', { cookie: adminCookie, body: { minutes: 2 } });
  assert.equal(ok.status, 200);
  assert.equal((await req('GET', '/api/me', { cookie: adminCookie })).json.idleMinutes, 2, 'session check uses the new value');
  const ordinary = await login('ordinary1', 'Ordinary@123');
  assert.equal((await req('PUT', '/api/settings/session-timeout', { cookie: ordinary.cookie, body: { minutes: 5 } })).status, 403);
  await req('PUT', '/api/settings/session-timeout', { cookie: adminCookie, body: { minutes: 30 } });
  assert.equal((await req('GET', '/api/me', { cookie: adminCookie })).json.idleMinutes, 30);
});

test('vehicles: chassis and engine numbers are stored, updated per vehicle, optional, and validated', async () => {
  const body = (plate, extra = {}) => ({ brand: 'سایپا', model: 'پراید ۱۳۱', category: 'سواری', cls: 'B', year: '۱۳۹۸', capacity: '۴', usage: '04 - حمل مسافر (شخصی)', plate, ...extra });
  const a = await req('POST', '/api/vehicles', { cookie: adminCookie, body: body({ a: '۵۵', b: '۱۱۱', c: 'ج', d: '۲۲' }, { chassisNo: 'NAS123456', engineNo: 'ENG-98/7' }) });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.chassisNo, 'NAS123456');
  assert.equal(a.json.engineNo, 'ENG-98/7');
  const b = await req('POST', '/api/vehicles', { cookie: adminCookie, body: body({ a: '۵۶', b: '۱۱۲', c: 'ج', d: '۲۲' }) });
  assert.equal(b.status, 201);
  assert.equal(b.json.chassisNo, '', 'optional: empty when not given');
  const up = await req('PUT', `/api/vehicles/${a.json.id}`, { cookie: adminCookie, body: body({ a: '۵۵', b: '۱۱۱', c: 'ج', d: '۲۲' }, { chassisNo: 'NAS999', engineNo: 'ENG-1' }) });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const list = (await req('GET', '/api/vehicles', { cookie: adminCookie })).json.items;
  assert.equal(list.find((v) => v.id === a.json.id).chassisNo, 'NAS999');
  assert.equal(list.find((v) => v.id === b.json.id).chassisNo, '', 'other vehicles are not changed');
  assert.equal((await req('POST', '/api/vehicles', { cookie: adminCookie, body: body({ a: '۵۷', b: '۱۱۳', c: 'ج', d: '۲۲' }, { chassisNo: 'bad<script>' }) })).status, 422);
});

test('supervision: sites and units, unit must belong to the chosen site, company keeps its link, deactivation keeps data', async () => {
  const s1 = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'S' + Math.random().toString(36).slice(2, 8), name: 'سایت شمال', code: 'N1', description: 'تست' } });
  assert.equal(s1.status, 201, JSON.stringify(s1.json));
  assert.equal((await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'S' + Math.random().toString(36).slice(2, 8), name: 'سایت شمال' } })).status, 422, 'duplicate site name');
  assert.equal((await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'S' + Math.random().toString(36).slice(2, 8), name: 'سایت جنوب', code: 'N1' } })).status, 422, 'duplicate site code');
  const s2 = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'S' + Math.random().toString(36).slice(2, 8), name: 'سایت جنوب' } });
  assert.equal(s2.status, 201);
  const u1 = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'U' + Math.random().toString(36).slice(2, 8), name: 'واحد نظارت الف', siteId: s1.json.id } });
  assert.equal(u1.status, 201, JSON.stringify(u1.json));
  assert.equal(u1.json.siteName, 'سایت شمال');
  assert.equal((await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'U' + Math.random().toString(36).slice(2, 8), name: 'واحد نظارت الف', siteId: s1.json.id } })).status, 422, 'duplicate unit in the same site');
  const u2 = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'U' + Math.random().toString(36).slice(2, 8), name: 'واحد نظارت الف', siteId: s2.json.id } });
  assert.equal(u2.status, 201, 'same unit name is allowed in another site');
  assert.equal((await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'U' + Math.random().toString(36).slice(2, 8), name: 'واحد بی‌سایت' } })).status, 422, 'a unit needs a site');
  const base = { country: 'ایران', province: 'تهران', city: 'ورامین', address: 'تهران، خیابان آزمون', regDate: '2026-01-10', legalType: '01', mobile: '09121112233' };
  const ok = await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'SUP-OK', name: 'شرکت نظارت', siteId: s1.json.id, supervisionUnitId: u1.json.id } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.siteName, 'سایت شمال');
  assert.equal(ok.json.supervisionUnitName, 'واحد نظارت الف');
  assert.equal((await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'SUP-BAD', name: 'ناسازگار', siteId: s1.json.id, supervisionUnitId: u2.json.id } })).status, 422, 'unit of another site');
  assert.match((await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'SUP-BAD2', name: 'ناسازگار', supervisionUnitId: u1.json.id } })).json.fields.supervisionUnitId, /سایت/);
  const opts = await req('GET', '/api/supervision-options', { cookie: adminCookie });
  assert.ok(opts.json.sites.some((x) => x.id === s1.json.id));
  assert.ok(opts.json.units.every((u) => u.siteId));
  const upd = await req('PUT', `/api/companies/${ok.json.id}`, { cookie: adminCookie, body: { ...base, code: 'SUP-OK', name: 'شرکت نظارت', siteId: s2.json.id, supervisionUnitId: u2.json.id } });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal(upd.json.siteName, 'سایت جنوب');
  await req('PUT', `/api/sites/${s2.json.id}`, { cookie: adminCookie, body: { code: s2.json.code, name: 'سایت جنوب', active: false } });
  const kept = (await req('GET', '/api/companies', { cookie: adminCookie })).json.items.find((c) => c.code === 'SUP-OK');
  assert.equal(kept.siteName, 'سایت جنوب', 'deactivated site keeps its name on existing companies');
  const opts2 = await req('GET', '/api/supervision-options', { cookie: adminCookie });
  assert.ok(!opts2.json.sites.some((x) => x.id === s2.json.id), 'inactive site is not offered');
  assert.equal((await req('POST', '/api/companies', { cookie: adminCookie, body: { ...base, code: 'SUP-IN', name: 'غیرفعال', siteId: s2.json.id } })).status, 422);
});

test('contracts: supervision site and unit are validated on the server; existing contracts are untouched', async () => {
  const s1 = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'S' + Math.random().toString(36).slice(2, 8), name: 'سایت قرارداد الف' } });
  const s2 = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'S' + Math.random().toString(36).slice(2, 8), name: 'سایت قرارداد ب' } });
  const u1 = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'U' + Math.random().toString(36).slice(2, 8), name: 'واحد قرارداد', siteId: s1.json.id } });
  const base = { companyId: 1, driverId: 1, vehicleId: 1, startDate: '2026-10-03' };
  const mismatch = await req('POST', '/api/contracts', { cookie: adminCookie, body: { ...base, siteId: s2.json.id, supervisionUnitId: u1.json.id } });
  assert.equal(mismatch.status, 422);
  assert.match(mismatch.json.fields.supervisionUnitId, /سایت/);
  assert.equal((await req('POST', '/api/contracts', { cookie: adminCookie, body: { ...base, supervisionUnitId: u1.json.id } })).status, 422, 'unit without site');
  await req('PUT', `/api/sites/${s1.json.id}`, { cookie: adminCookie, body: { code: s1.json.code, name: 'سایت قرارداد الف', active: false } });
  assert.equal((await req('POST', '/api/contracts', { cookie: adminCookie, body: { ...base, siteId: s1.json.id } })).status, 422, 'inactive site refused');
  const list = (await req('GET', '/api/contracts', { cookie: adminCookie })).json.items;
  assert.ok(list.length >= 1);
  assert.equal(list[list.length - 1].siteId, null, 'contracts created before this change have no site');
});

test('supervision units: site is reused by code or name instead of duplicated, unit code is unique per site, status controls offers', async () => {
  const sites0 = (await req('GET', '/api/sites', { cookie: adminCookie })).json.items.length;
  const u1 = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'UA-1', name: 'واحد الف', siteCode: 'KRJ', siteName: 'سایت کرج' } });
  assert.equal(u1.status, 201, JSON.stringify(u1.json));
  assert.equal(u1.json.siteCode, 'KRJ');
  assert.equal(u1.json.active, true, 'new unit is active by default');
  const afterCreate = (await req('GET', '/api/sites', { cookie: adminCookie })).json.items.length;
  assert.equal(afterCreate, sites0 + 1, 'a new site is created when none matches');
  const u2 = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'UA-2', name: 'واحد ب', siteCode: 'KRJ', siteName: 'سایت کرج' } });
  assert.equal(u2.status, 201);
  assert.equal((await req('GET', '/api/sites', { cookie: adminCookie })).json.items.length, afterCreate, 'existing site is reused, not duplicated');
  assert.equal((await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'UA-1', name: 'واحد دیگر', siteCode: 'KRJ', siteName: 'سایت کرج' } })).status, 422, 'duplicate unit code in the same site');
  assert.equal((await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'UA-9', name: 'واحد دیگر', siteCode: 'KRJ', siteName: 'نام دیگر' } })).status, 422, 'site code belongs to another name');
  const off = await req('PUT', `/api/supervision-units/${u1.json.id}`, { cookie: adminCookie, body: { code: 'UA-1', name: 'واحد الف', siteId: u1.json.siteId, active: 'غیرفعال' } });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.active, false);
  const opts = await req('GET', '/api/supervision-options', { cookie: adminCookie });
  assert.ok(!opts.json.units.some((x) => x.id === u1.json.id), 'inactive unit is not offered for new selection');
  const list = await req('GET', '/api/supervision-units', { cookie: adminCookie });
  assert.ok(list.json.items.some((x) => x.id === u1.json.id && x.code === 'UA-1'), 'inactive unit stays in the list with its data');
});

test('service plans (six-step wizard): complete plan saved, every step validated, vehicle snapshot and company rate stored', async () => {
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'WZ' + Math.random().toString(36).slice(2, 6), name: 'سایت ویزارد ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'WU1', name: 'واحد ویزارد', siteId: site.json.id } });
  const veh = await req('POST', '/api/vehicles', { cookie: adminCookie, body: { brand: 'سایپا', model: 'پراید ۱۳۱', category: 'سواری', cls: 'B', year: '۱۳۹۸', capacity: '۴', usage: '04 - حمل مسافر (شخصی)', plate: { a: '۷۷', b: '۲۲۲', c: 'ج', d: '۱۱' } } });
  assert.equal(veh.status, 201, JSON.stringify(veh.json));
  const base = {
    code: 'SP-' + Math.floor(Math.random() * 1e6), name: 'سرویس صبح', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه',
    vehicleGroup: 'سواری', vehicleClass: 'B', allowedMinutes: '45', serviceNumber: 'S-100',
    routes: [{ origin: 'ورامین', destination: 'تهران', km: '50', startTime: '06:00', endTime: '07:00' }],
    passengers: [{ name: 'علی رضایی', boarding: 'ورامین', alighting: 'تهران', startDate: '2026-10-01', startTime: '06:00', endDate: '2026-10-30', endTime: '07:00' }],
    vehicleRate: { vehicleId: veh.json.id, fee: 150000 },
    companyRate: { calcType: 'per_service', amount: 250000 },
  };
  const ok = await req('POST', '/api/service-plans', { cookie: adminCookie, body: base });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.vehicleRate.fee, 150000);
  assert.ok(ok.json.vehicleRate.snapshot && ok.json.vehicleRate.snapshot.plate, 'vehicle snapshot is stored with the rate');
  assert.equal(ok.json.companyRate.calcType, 'per_service');
  assert.equal(ok.json.routes.length, 1);
  assert.equal(ok.json.passengers.length, 1);
  const list = (await req('GET', '/api/service-plans', { cookie: adminCookie })).json.items;
  assert.ok(list.some((p) => p.id === ok.json.id));
  const bad = (patch) => req('POST', '/api/service-plans', { cookie: adminCookie, body: { ...base, ...patch } });
  assert.equal((await bad({ supervisionUnitId: 999999 })).status, 422, 'unit must exist');
  assert.equal((await bad({ routes: [] })).status, 422, 'at least one route');
  assert.equal((await bad({ routes: [{ origin: 'الف', destination: 'ب', km: '5', startTime: '08:00', endTime: '07:00' }] })).status, 422, 'end time after start');
  assert.equal((await bad({ allowedMinutes: '0' })).status, 422, 'allowed minutes range');
  assert.equal((await bad({ vehicleClass: '' })).status, 422, 'passenger car needs a class');
  assert.equal((await bad({ companyRate: { calcType: 'unknown', amount: 1 } })).status, 422);
  assert.equal((await bad({ passengers: [{ name: 'کسی', boarding: 'الف', alighting: 'ب', startDate: '2026-10-05', startTime: '08:00', endDate: '2026-10-04', endTime: '08:00' }] })).status, 422, 'passenger end before start');
  assert.equal((await bad({ vehicleRate: { vehicleId: 999999, fee: 1 } })).status, 422);
  assert.equal((await bad({ directionStatus: 'نامعتبر' })).status, 422);
  const info = await req('GET', `/api/vehicles/${veh.json.id}/contract-info`, { cookie: adminCookie });
  assert.equal(info.status, 200);
  assert.equal(info.json.driverName, '', 'no active contract, no driver');
  const ord = await login('ordinary1', 'Ordinary@123');
  assert.equal((await req('POST', '/api/service-plans', { cookie: ord.cookie, body: base })).status, 403);
});

test('service plans: vehicle rate notes are stored with the rate', async () => {
  const veh = await req('POST', '/api/vehicles', { cookie: adminCookie, body: { brand: 'سایپا', model: 'پراید ۱۳۱', category: 'سواری', cls: 'B', year: '۱۳۹۸', capacity: '۴', usage: '04 - حمل مسافر (شخصی)', plate: { a: '۶۶', b: '۳۳۳', c: 'د', d: '۵۵' } } });
  assert.equal(veh.status, 201, JSON.stringify(veh.json));
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'NT' + Math.random().toString(36).slice(2, 6), name: 'سایت یادداشت ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'NU1', name: 'واحد یادداشت', siteId: site.json.id } });
  assert.equal(unit.status, 201, JSON.stringify(unit.json));
  const body = { code: 'RN-' + Math.floor(Math.random() * 1e6), name: 'سرویس یادداشت', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'کرج', routeType: 'برگشت', gender: 'زن', returnService: 'سرویس ویژه', directionStatus: 'فقط برگشت', vehicleGroup: 'سواری', vehicleClass: 'B', allowedMinutes: '30', serviceNumber: 'S-5',
    routes: [{ origin: 'الف ۱', destination: 'ب ۲', description: 'مسیر تست', km: '10', startTime: '06:00', endTime: '06:30' }], passengers: [],
    vehicleRate: { vehicleId: veh.json.id, fee: 9000, notes: 'یادداشت نرخ' }, companyRate: null };
  const r = await req('POST', '/api/service-plans', { cookie: adminCookie, body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.vehicleRate.notes, 'یادداشت نرخ');
  assert.equal(r.json.routes[0].description, 'مسیر تست');
});

test('service plans: an existing plan can be edited; validation still applies', async () => {
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'ED' + Math.random().toString(36).slice(2, 6), name: 'سایت ویرایش ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'EU1', name: 'واحد ویرایش', siteId: site.json.id } });
  const base = { code: 'ED-' + Math.floor(Math.random() * 1e6), name: 'پیش از ویرایش', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'سواری', vehicleClass: 'B', allowedMinutes: '40', serviceNumber: 'E-1',
    routes: [{ origin: 'الف ۱', destination: 'ب ۲', description: '', km: '8', startTime: '06:00', endTime: '06:30' }], passengers: [] };
  const created = await req('POST', '/api/service-plans', { cookie: adminCookie, body: base });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const edited = await req('PUT', `/api/service-plans/${created.json.id}`, { cookie: adminCookie, body: { ...base, name: 'بعد از ویرایش', allowedMinutes: '55' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.name, 'بعد از ویرایش');
  assert.equal(edited.json.allowedMinutes, 55);
  assert.equal((await req('PUT', `/api/service-plans/${created.json.id}`, { cookie: adminCookie, body: { ...base, allowedMinutes: '0' } })).status, 422);
  assert.equal((await req('PUT', '/api/service-plans/999999', { cookie: adminCookie, body: base })).status, 404);
});

test('fixed services: service type, trips with one-time approval, driver positions limited to Iran', async () => {
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'FX' + Math.random().toString(36).slice(2, 6), name: 'سایت ثابت ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'FXU', name: 'واحد ثابت', siteId: site.json.id } });
  const base = { code: 'FX-' + Math.floor(Math.random() * 1e6), name: 'سرویس ثابت', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سنگین پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'سواری', vehicleClass: 'B',
    allowedMinutes: '60', serviceNumber: 'F-1', routes: [{ origin: 'الف ۱', destination: 'ب ۲', description: '', km: '12', startTime: '06:00', endTime: '07:00' }], passengers: [] };
  assert.equal((await req('POST', '/api/service-plans', { cookie: adminCookie, body: { ...base, serviceType: 'نامعتبر' } })).status, 422);
  const plan = await req('POST', '/api/service-plans', { cookie: adminCookie, body: base });
  assert.equal(plan.status, 201, JSON.stringify(plan.json));
  assert.equal(plan.json.serviceType, 'ایاب و ذهاب سنگین پرسنل');
  const trip = await req('POST', `/api/service-plans/${plan.json.id}/trips`, { cookie: adminCookie, body: { tripDate: '2026-10-05' } });
  assert.equal(trip.status, 201, JSON.stringify(trip.json));
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/status`, { cookie: adminCookie, body: { status: 'approved' } })).status, 200);
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/status`, { cookie: adminCookie, body: { status: 'rejected' } })).status, 422, 'a trip is reviewed once');
  const trips = (await req('GET', '/api/trips', { cookie: adminCookie })).json.items;
  assert.equal(trips.find((t) => t.id === trip.json.id).status, 'approved');
  const drv = await req('POST', '/api/drivers', { cookie: adminCookie, body: { first: 'مکان', last: 'یاب', nid: '1234567891', mobile: '09121234567', gender: 'مرد' } });
  assert.equal(drv.status, 201, JSON.stringify(drv.json));
  assert.equal((await req('POST', '/api/locations', { cookie: adminCookie, body: { driverId: drv.json.id, lat: 35.69, lng: 51.39, accuracy: 12 } })).status, 201, 'inside Iran');
  assert.equal((await req('POST', '/api/locations', { cookie: adminCookie, body: { driverId: drv.json.id, lat: 48.85, lng: 2.35 } })).status, 422, 'outside Iran is refused');
  const latest = (await req('GET', '/api/locations/latest', { cookie: adminCookie })).json.items;
  assert.ok(latest.some((l) => l.driverId === drv.json.id && Math.abs(l.lat - 35.69) < 1e-6));
});

test('service plans: tariff rate type removed; van is ون; station points stored inside Iran; route estimate needs a configured key', async () => {
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'RT' + Math.random().toString(36).slice(2, 6), name: 'سایت مسیر ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'RTU', name: 'واحد مسیر', siteId: site.json.id } });
  const base = { code: 'RM-' + Math.floor(Math.random() * 1e6), name: 'سرویس مسیر نقشه', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'ون', vehicleClass: '',
    allowedMinutes: '60', serviceNumber: 'RM-1', passengers: [],
    routes: [{ origin: 'میدان آزادی', destination: 'کرج مرکز', description: '', km: '45', startTime: '06:00', endTime: '07:00',
      originPoint: { lat: 35.6997, lng: 51.3380 }, destinationPoint: { lat: 35.8, lng: 50.96 } }] };
  assert.equal((await req('POST', '/api/service-plans', { cookie: adminCookie, body: { ...base, companyRate: { calcType: 'per_tariff', amount: 1 } } })).status, 422, 'tariff rate type is removed');
  const ok = await req('POST', '/api/service-plans', { cookie: adminCookie, body: base });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.vehicleGroup, 'ون');
  assert.equal(ok.json.routes[0].originPoint.lat, 35.6997);
  assert.equal((await req('POST', '/api/service-plans', { cookie: adminCookie, body: { ...base, routes: [{ ...base.routes[0], originPoint: { lat: 48.8, lng: 2.3 } }] } })).status, 422, 'station outside Iran');
  const est = await req('POST', '/api/routes/estimate', { cookie: adminCookie, body: { origin: { lat: 35.7, lng: 51.4 }, destination: { lat: 35.8, lng: 50.9 } } });
  assert.equal(est.status, 200, JSON.stringify(est.json));
  assert.equal(est.json.km, 13, 'sum of the legs in km: 12400 + 600 metres');
  assert.equal(est.json.minutes, 20, 'sum of the legs in minutes: 1080 + 120 seconds');
  assert.equal(est.json.source, 'neshan');
  assert.equal((await req('POST', '/api/routes/estimate', { cookie: adminCookie, body: { origin: { lat: 48.8, lng: 2.3 }, destination: { lat: 35.8, lng: 50.9 } } })).status, 422, 'points outside Iran');
});

test('driver GPS: positions only during a started trip, inside Iran, rate limited; link revoked on renewal; trip finish stops tracking', async () => {
  const drv = await req('POST', '/api/drivers', { cookie: adminCookie, body: { first: 'ردیاب', last: 'گوشی', nid: '0098765434', mobile: '09121234567', gender: 'مرد' } });
  assert.equal(drv.status, 201, JSON.stringify(drv.json));
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'GP' + Math.random().toString(36).slice(2, 6), name: 'سایت GPS ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'GPU', name: 'واحد GPS', siteId: site.json.id } });
  const plan = await req('POST', '/api/service-plans', { cookie: adminCookie, body: { code: 'GP-' + Math.floor(Math.random() * 1e6), name: 'سرویس GPS', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'سواری', vehicleClass: 'B',
    allowedMinutes: '30', serviceNumber: 'G-1', passengers: [], routes: [{ origin: 'الف ۱', destination: 'ب ۲', description: '', km: '5', startTime: '06:00', endTime: '06:20' }] } });
  assert.equal(plan.status, 201, JSON.stringify(plan.json));
  const trip = await req('POST', `/api/service-plans/${plan.json.id}/trips`, { cookie: adminCookie, body: { tripDate: '2026-10-05' } });
  const l1 = await req('POST', `/api/drivers/${drv.json.id}/tracking-link`, { cookie: adminCookie });
  const t1 = l1.json.url.split('#')[1];
  const send = (token, lat, lng) => req('POST', '/api/driver-track', { body: { token, lat, lng, accuracy: 8 } });
  assert.equal((await send(t1, 35.7, 51.4)).status, 409, 'no started trip: tracking is off');
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/start`, { cookie: adminCookie, body: { driverId: drv.json.id } })).status, 422, 'a pending trip cannot start');
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/status`, { cookie: adminCookie, body: { status: 'approved' } })).status, 200);
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/start`, { cookie: adminCookie, body: { driverId: drv.json.id } })).status, 200);
  assert.equal((await send(t1, 35.7, 51.4)).status, 201, 'started trip, inside Iran');
  assert.equal((await send(t1, 35.71, 51.41)).status, 429, 'at most one position every 10 seconds');
  assert.equal((await send(t1, 48.8, 2.3)).status, 422, 'outside Iran refused');
  assert.equal((await send('x'.repeat(30), 35.7, 51.4)).status, 401, 'unknown token refused');
  const l2 = await req('POST', `/api/drivers/${drv.json.id}/tracking-link`, { cookie: adminCookie });
  assert.equal((await send(t1, 35.7, 51.4)).status, 401, 'old link is revoked');
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/finish`, { cookie: adminCookie })).status, 200);
  assert.equal((await req('POST', `/api/drivers/${drv.json.id}/tracking-link`, { body: {} })).status, 401, 'creating a link needs a login');
  const t2 = l2.json.url.split('#')[1];
  assert.equal((await send(t2, 35.7, 51.4)).status, 409, 'after the trip ends tracking stops');
  const latest = (await req('GET', '/api/locations/latest', { cookie: adminCookie })).json.items.find((x) => x.driverId === drv.json.id);
  assert.ok(latest && latest.stale === false && typeof latest.stale === 'boolean', 'position is visible with its freshness');
});

test('health: reports ok only after a real database query', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.database, 'ok');
  assert.ok(r.json.version);
});

test('driver accounts: self-registration waits for approval; positions only during the driver\'s own started trip; drivers cannot use admin sections', async () => {
  const bad = await req('POST', '/api/driver-signup', { body: { first: 'علی', last: 'راننده', nid: '1000000002', mobile: '09121234567', gender: 'مرد', password: 'DriverPass1' } });
  assert.equal(bad.status, 422, 'invalid national ID refused');
  const reg = await req('POST', '/api/driver-signup', { body: { first: 'علی', last: 'راننده', nid: '1000000001', mobile: '09121234567', gender: 'مرد', password: 'DriverPass1' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.equal(reg.json.pending, true);
  assert.equal((await req('POST', '/api/driver-signup', { body: { first: 'علی', last: 'راننده', nid: '1000000001', mobile: '09121234567', gender: 'مرد', password: 'DriverPass1' } })).status, 409, 'same national ID twice');
  assert.equal((await req('POST', '/api/login', { body: { username: '1000000001', password: 'DriverPass1' } })).status, 403, 'pending account cannot sign in');
  const users = (await req('GET', '/api/users', { cookie: adminCookie })).json.items;
  const u = users.find((x) => x.username === '1000000001');
  assert.ok(u, 'pending account is visible to the administrator');
  assert.equal((await req('PUT', `/api/users/${u.id}`, { cookie: adminCookie, body: { active: true } })).status, 200, 'administrator approves');
  const dl = await login('1000000001', 'DriverPass1');
  const dc = dl.cookie;
  assert.ok(dc, 'approved driver signs in');
  const me = await req('GET', '/api/driver/me', { cookie: dc });
  assert.equal(me.status, 200);
  assert.equal(me.json.trip, null, 'no trip yet');
  assert.equal((await req('POST', '/api/driver/location', { cookie: dc, body: { lat: 35.7, lng: 51.4 } })).status, 409, 'no started trip: no position');
  assert.equal((await req('POST', '/api/driver/location', { cookie: adminCookie, body: { lat: 35.7, lng: 51.4 } })).status, 403, 'an administrator account is not a driver');
  assert.equal((await req('GET', '/api/users', { cookie: dc })).status, 403, 'driver cannot use admin sections');
  const drvId = u.id ? (await req('GET', '/api/drivers', { cookie: adminCookie })).json.items.find((x) => x.nid === '1000000001').id : 0;
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'DR' + Math.random().toString(36).slice(2, 6), name: 'سایت راننده ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'DRU', name: 'واحد راننده', siteId: site.json.id } });
  const plan = await req('POST', '/api/service-plans', { cookie: adminCookie, body: { code: 'DR-' + Math.floor(Math.random() * 1e6), name: 'سرویس راننده', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'سواری', vehicleClass: 'B',
    allowedMinutes: '30', serviceNumber: 'D-1', passengers: [], routes: [{ origin: 'الف ۱', destination: 'ب ۲', description: '', km: '5', startTime: '06:00', endTime: '06:20' }] } });
  const trip = await req('POST', `/api/service-plans/${plan.json.id}/trips`, { cookie: adminCookie, body: { tripDate: '2026-10-05' } });
  await req('PUT', `/api/trips/${trip.json.id}/status`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal((await req('PUT', `/api/trips/${trip.json.id}/start`, { cookie: adminCookie, body: { driverId: drvId } })).status, 200);
  const me2 = await req('GET', '/api/driver/me', { cookie: dc });
  assert.ok(me2.json.trip && me2.json.trip.id === trip.json.id, 'the driver sees the started trip');
  assert.equal((await req('POST', '/api/driver/location', { cookie: dc, body: { lat: 35.7, lng: 51.4 } })).status, 201, 'position during the trip');
  assert.equal((await req('POST', '/api/driver/location', { cookie: dc, body: { lat: 35.7, lng: 51.4 } })).status, 429, 'one position per second at most');
  assert.equal((await req('POST', '/api/driver/location', { cookie: dc, body: { lat: 48.8, lng: 2.3 } })).status, 422, 'outside Iran refused');
  await req('PUT', `/api/trips/${trip.json.id}/finish`, { cookie: adminCookie });
  assert.equal((await req('POST', '/api/driver/location', { cookie: dc, body: { lat: 35.7, lng: 51.4 } })).status, 409, 'after the trip ends: no position');
});

test('users: the driver role can be assigned to a registered driver record; the record must exist and have no account yet', async () => {
  const drv = await req('GET', '/api/drivers', { cookie: adminCookie });
  const d = drv.json.items.find((x) => x.nid === '0098765434') || drv.json.items[0];
  const bad = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'drv-no-record', name: 'بدون رکورد', role: 'راننده', password: 'DriverPass2' } });
  assert.equal(bad.status, 422, 'a driver account needs a driver record');
  const ok = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'drvlink' + Math.floor(Math.random() * 1e6), name: 'راننده متصل', role: 'راننده', password: 'DriverPass2', driverId: d.id } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const again = await req('POST', '/api/users', { cookie: adminCookie, body: { username: 'drvdup' + Math.floor(Math.random() * 1e6), name: 'تکراری', role: 'راننده', password: 'DriverPass2', driverId: d.id } });
  assert.equal(again.status, 422, 'a driver record cannot have two accounts');
});

test('personnel file: create, validate, edit with audit, upload and secure download, delete; access follows permissions and own-file link', async () => {
  const base = { firstName: 'رضا', lastName: 'کریمی', nationalId: '1000000001', personnelCode: 'P-' + Math.floor(Math.random() * 1e6), position: 'کارشناس', mobile: '09121234567', status: 'active', notes: 'تست' };
  const created = await req('POST', '/api/personnel', { cookie: adminCookie, body: base });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;
  assert.equal(created.json.statusLabel, 'فعال');
  assert.equal((await req('POST', '/api/personnel', { cookie: adminCookie, body: { ...base, personnelCode: 'P-X' + id } })).status, 422, 'national ID is unique');
  assert.equal((await req('POST', '/api/personnel', { cookie: adminCookie, body: { ...base, nationalId: '1000000002', personnelCode: 'P-Y' + id, status: 'نامعتبر' } })).status, 422, 'status must be one of the allowed values');
  assert.equal((await req('POST', '/api/personnel', { cookie: adminCookie, body: { ...base, nationalId: '1000000003', personnelCode: 'P-Z' + id, firstName: 'Reza' } })).status, 422, 'names must be Persian');
  const edited = await req('PUT', `/api/personnel/${id}`, { cookie: adminCookie, body: { ...base, status: 'on_leave' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.statusLabel, 'مرخصی');
  const detail = await req('GET', `/api/personnel/${id}`, { cookie: adminCookie });
  assert.equal(detail.status, 200);
  const up = await req('POST', `/api/personnel/${id}/documents`, { cookie: adminCookie, form: multipart({ title: 'شناسنامه اسکن', docType: 'شناسنامه' }, { name: 'id.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 personnel') }) });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const after = await req('GET', `/api/personnel/${id}`, { cookie: adminCookie });
  const doc = after.json.documents.find((d) => d.title === 'شناسنامه اسکن');
  assert.ok(doc, 'document is attached to the file');
  const dl = await req('GET', `/api/personnel/${id}/documents/${doc.id}/download`, { cookie: adminCookie });
  assert.equal(dl.status, 200);
  const bad = await req('POST', `/api/personnel/${id}/documents`, { cookie: adminCookie, form: multipart({ title: 'فایل بد', docType: 'شناسنامه' }, { name: 'x.exe', type: 'application/octet-stream', data: Buffer.from('MZ bad') }) });
  assert.equal(bad.status, 415, 'only PDF, JPG and PNG are accepted for personnel documents');
  // an ordinary account with no personnel link sees nothing and cannot read the file
  const ordName = 'pers' + Math.floor(Math.random() * 1e6);
  const ord = await req('POST', '/api/users', { cookie: adminCookie, body: { username: ordName, name: 'کاربر عادی', role: 'پرسنل', password: 'OrdPass123' } });
  assert.equal(ord.status, 201, JSON.stringify(ord.json));
  const ordRow = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === ordName);
  assert.equal((await req('PUT', `/api/users/${ordRow.id}`, { cookie: adminCookie, body: { role: 'کاربر عادی' } })).status, 200, 'role changed to ordinary user');
  const ordCookie = (await login(ordName, 'OrdPass123')).cookie;
  assert.equal((await req('GET', '/api/personnel', { cookie: ordCookie })).json.items.length, 0, 'no personnel list without permission');
  assert.equal((await req('GET', `/api/personnel/${id}`, { cookie: ordCookie })).status, 403);
  assert.equal((await req('GET', `/api/personnel/${id}/documents/${doc.id}/download`, { cookie: ordCookie })).status, 403);
  // an account linked to this file sees only that file, and only as a reader
  const linkName = 'own' + Math.floor(Math.random() * 1e6);
  const linked = await req('POST', '/api/users', { cookie: adminCookie, body: { username: linkName, name: 'خود پرسنل', role: 'پرسنل', password: 'OwnPass123', personnelId: id } });
  const linkRow = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === linkName);
  await req('PUT', `/api/users/${linkRow.id}`, { cookie: adminCookie, body: { role: 'کاربر عادی' } });
  assert.equal(linked.status, 201, JSON.stringify(linked.json));
  const ownCookie = (await login(linkName, 'OwnPass123')).cookie;
  assert.equal((await req('GET', `/api/personnel/${id}`, { cookie: ownCookie })).status, 200, 'own file is readable');
  assert.equal((await req('GET', `/api/personnel/${id}/documents/${doc.id}/download`, { cookie: ownCookie })).status, 200, 'own document is downloadable');
  assert.equal((await req('PUT', `/api/personnel/${id}`, { cookie: ownCookie, body: { ...base, status: 'active' } })).status, 403, 'own file cannot be edited');
  const other = await req('POST', '/api/personnel', { cookie: adminCookie, body: { ...base, nationalId: '1000000004', personnelCode: 'P-O' + id } });
  assert.equal((await req('GET', `/api/personnel/${other.json.id}`, { cookie: ownCookie })).status, 403, 'another file is not visible');
  const del = await req('DELETE', `/api/personnel/${id}/documents/${doc.id}`, { cookie: adminCookie });
  assert.equal(del.status, 200);
  assert.equal((await req('GET', `/api/personnel/${id}/documents/${doc.id}/download`, { cookie: adminCookie })).status, 404, 'deleted document is gone');
});

test('service requests: tracking number, lifecycle, assignment checks; passengers on a trip; finance entries, payment and summary', async () => {
  // service requests
  const rq = await req('POST', '/api/requests', { cookie: adminCookie, body: { requester: 'علی احمدی', origin: 'ورامین', destination: 'تهران', requestDate: '2026-10-10', passengerCount: 4, notes: 'تست' } });
  assert.equal(rq.status, 201, JSON.stringify(rq.json));
  assert.match(rq.json.trackingNo, /^REQ-\d{4}-\d{6}$/);
  const id = rq.json.id;
  assert.equal((await req('PUT', `/api/requests/${id}/status`, { cookie: adminCookie, body: { action: 'assign', vehicleId: 1, driverId: 1 } })).status, 422, 'cannot assign before approval');
  assert.equal((await req('PUT', `/api/requests/${id}/status`, { cookie: adminCookie, body: { action: 'approve' } })).status, 200);
  assert.equal((await req('PUT', `/api/requests/${id}/status`, { cookie: adminCookie, body: { action: 'reject' } })).status, 422, 'approved request cannot be rejected');
  const drv = (await req('GET', '/api/drivers', { cookie: adminCookie })).json.items[0];
  const veh = (await req('GET', '/api/vehicles', { cookie: adminCookie })).json.items[0];
  if (drv && veh) {
    assert.equal((await req('PUT', `/api/requests/${id}/status`, { cookie: adminCookie, body: { action: 'assign', vehicleId: veh.id, driverId: drv.id } })).status, 200);
  }
  const detail = await req('GET', `/api/requests/${id}`, { cookie: adminCookie });
  assert.equal(detail.status, 200);
  assert.ok(detail.json.events.length >= 2, 'history is kept');
  assert.equal((await req('POST', '/api/requests', { cookie: adminCookie, body: { requester: 'ع', origin: 'x', destination: 'y', requestDate: '2026-10-10', passengerCount: 0 } })).status, 422);
  const rep = await req('GET', '/api/requests-report', { cookie: adminCookie });
  assert.ok(rep.json.total >= 1);

  // passengers on a trip
  const site = await req('POST', '/api/sites', { cookie: adminCookie, body: { code: 'PX' + Math.random().toString(36).slice(2, 6), name: 'سایت مسافر ' + Date.now() } });
  const unit = await req('POST', '/api/supervision-units', { cookie: adminCookie, body: { code: 'PXU', name: 'واحد مسافر', siteId: site.json.id } });
  const plan = await req('POST', '/api/service-plans', { cookie: adminCookie, body: { code: 'PX-' + Math.floor(Math.random() * 1e6), name: 'سرویس مسافر', startDate: '2026-10-01', siteId: site.json.id, supervisionUnitId: unit.json.id,
    serviceType: 'ایاب و ذهاب سبک پرسنل', region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'سواری', vehicleClass: 'B',
    allowedMinutes: '30', serviceNumber: 'PX-1', passengers: [], routes: [{ origin: 'الف ۱', destination: 'ب ۲', description: '', km: '5', startTime: '06:00', endTime: '06:20' }] } });
  const trip = await req('POST', `/api/service-plans/${plan.json.id}/trips`, { cookie: adminCookie, body: { tripDate: '2026-10-05' } });
  const pax = await req('POST', '/api/passengers', { cookie: adminCookie, body: { firstName: 'سارا', lastName: 'رضایی', nationalId: '0098765434', mobile: '09121234567' } });
  assert.equal(pax.status, 201, JSON.stringify(pax.json));
  assert.equal((await req('POST', '/api/passengers', { cookie: adminCookie, body: { firstName: 'Sara', lastName: 'x' } })).status, 422, 'Persian names only');
  const tp = await req('POST', `/api/trips/${trip.json.id}/passengers`, { cookie: adminCookie, body: { passengerId: pax.json.id, boarding: 'ورامین', alighting: 'تهران' } });
  assert.equal(tp.status, 201, JSON.stringify(tp.json));
  assert.equal((await req('POST', `/api/trips/${trip.json.id}/passengers`, { cookie: adminCookie, body: { passengerId: pax.json.id } })).status, 422, 'no duplicate on the same trip');
  const list = await req('GET', `/api/trips/${trip.json.id}/passengers`, { cookie: adminCookie });
  const row = list.json.items[0];
  assert.equal(row.statusLabel, 'رزرو شده');
  assert.equal((await req('PUT', `/api/trip-passengers/${row.id}`, { cookie: adminCookie, body: { status: 'present' } })).status, 200);
  assert.equal((await req('PUT', `/api/trip-passengers/${row.id}`, { cookie: adminCookie, body: { status: 'nope' } })).status, 422);

  // finance
  const cats = (await req('GET', '/api/finance/categories', { cookie: adminCookie })).json.items;
  const exp = cats.find((c) => c.kind === 'expense' && c.active);
  const inc = cats.find((c) => c.kind === 'income' && c.active);
  assert.ok(exp && inc, 'starting categories exist');
  assert.equal((await req('POST', '/api/finance', { cookie: adminCookie, body: { kind: 'income', categoryId: exp.id, amount: 100, entryDate: '2026-10-10' } })).status, 422, 'category must match the kind');
  const f1 = await req('POST', '/api/finance', { cookie: adminCookie, body: { kind: 'income', categoryId: inc.id, amount: 1000000, entryDate: '2026-10-10', description: 'تست' } });
  assert.equal(f1.status, 201, JSON.stringify(f1.json));
  assert.match(f1.json.referenceNo, /^FIN-\d{4}-\d{6}$/);
  const f2 = await req('POST', '/api/finance', { cookie: adminCookie, body: { kind: 'expense', categoryId: exp.id, amount: 250000, entryDate: '2026-10-11' } });
  assert.equal(f2.status, 201);
  assert.equal((await req('POST', `/api/finance/${f2.json.id}/pay`, { cookie: adminCookie, body: { paidAt: '2026-10-12', method: 'نقدی' } })).status, 200);
  assert.equal((await req('POST', `/api/finance/${f2.json.id}/pay`, { cookie: adminCookie, body: { paidAt: '2026-10-12', method: 'نقدی' } })).status, 422, 'cannot pay twice');
  assert.equal((await req('PUT', `/api/finance/${f2.json.id}`, { cookie: adminCookie, body: { kind: 'expense', categoryId: exp.id, amount: 1, entryDate: '2026-10-11' } })).status, 422, 'paid entry cannot change');
  const sum = (await req('GET', '/api/finance/summary?from=2026-10-01&to=2026-10-31', { cookie: adminCookie })).json;
  assert.ok(sum.income >= 1000000 && sum.expense >= 250000);
  assert.equal(sum.balance, sum.income - sum.expense);
  assert.ok(sum.unpaidIncome >= 1000000, 'unpaid income is counted');
});

async function rawGet(url, cookie) {
  const res = await fetch(BASE + url, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, headers: { 'content-type': res.headers.get('content-type') || '' }, text: await res.text() };
}

test('reports: CSV from live data with date filter, formula protection, and permission checks', async () => {
  const cats = (await req('GET', '/api/finance/categories', { cookie: adminCookie })).json.items;
  const inc = cats.find((c) => c.kind === 'income' && c.active);
  const f1 = await req('POST', '/api/finance', { cookie: adminCookie, body: { kind: 'income', categoryId: inc.id, amount: 777000, entryDate: '2026-03-03', description: '=HYPERLINK("x")' } });
  assert.equal(f1.status, 201);
  const f2 = await req('POST', '/api/finance', { cookie: adminCookie, body: { kind: 'income', categoryId: inc.id, amount: 888000, entryDate: '2026-09-09' } });
  assert.equal(f2.status, 201);
  const all = await rawGet('/api/reports/export?kind=finance', adminCookie);
  assert.equal(all.status, 200);
  assert.match(all.headers['content-type'] || '', /text\/csv/);
  const text = all.text;
  assert.ok(text.includes('777000') && text.includes('888000'));
  assert.ok(!text.includes('"=HYPERLINK'), 'formula is neutralised');
  const jan = await rawGet('/api/reports/export?kind=finance&from=2026-03-01&to=2026-03-31', adminCookie);
  const janText = jan.text;
  assert.ok(janText.includes('777000') && !janText.includes('888000'), 'date range filters rows');
  assert.equal((await req('GET', '/api/reports/export?kind=unknown', { cookie: adminCookie })).status, 422);
  const kinds = (await req('GET', '/api/reports/kinds', { cookie: adminCookie })).json.items.map((x) => x.kind);
  assert.ok(kinds.includes('finance') && kinds.includes('requests') && kinds.includes('personnel'));
  const ord = await login('ordinary1', 'Ordinary@123');
  assert.equal((await rawGet('/api/reports/export?kind=finance', ord.cookie)).status, 403, 'no finance report without permission');
  const ordKinds = (await req('GET', '/api/reports/kinds', { cookie: ord.cookie })).json.items.map((x) => x.kind);
  assert.ok(!ordKinds.includes('finance'));
});

test('leave and missions: configurable chain, step-role approval, return and resubmit, balance from settings, attachments', async () => {
  const set0 = (await req('GET', '/api/leave/settings', { cookie: adminCookie })).json;
  assert.equal(set0.steps.length, 3, 'starting chain is present');
  assert.equal(set0.steps[0].label.includes('تنظیم اولیه'), true, 'starting chain is marked as an initial setting');
  const per = await req('POST', '/api/personnel', { cookie: adminCookie, body: { firstName: 'مرخصی', lastName: 'تست', nationalId: '0098765434', personnelCode: 'LV-' + Math.floor(Math.random() * 1e6), status: 'active' } });
  assert.equal(per.status, 201, JSON.stringify(per.json));
  const pid = per.json.id;
  assert.equal((await req('PUT', '/api/leave/settings', { cookie: adminCookie, body: { annualDays: 30, steps: set0.steps.map((x) => ({ label: x.label, role: x.role })) } })).status, 200);
  assert.equal((await req('PUT', '/api/leave/settings', { cookie: adminCookie, body: { steps: [{ label: 'x', role: 'نامعتبر' }] } })).status, 422, 'unknown role refused');
  const submit = (kind, s, e, extra = {}) => req('POST', '/api/leave/requests', { cookie: adminCookie, form: multipart({ personnelId: String(pid), kind, startDate: s, endDate: e, ...extra }) });
  const r1 = await submit('مرخصی', '2026-07-01', '2026-07-05', { reason: 'تست' });
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.equal(r1.json.days, 5, 'inclusive day count');
  assert.equal((await submit('مرخصی', '2026-07-10', '2026-07-01')).status, 422, 'end before start refused');
  assert.equal((await submit('مأموریت', '2026-07-10', '2026-07-11')).status, 422, 'mission needs a destination');
  // approve through the three steps
  for (let i = 0; i < 3; i++) {
    const a = await req('POST', `/api/leave/requests/${r1.json.id}/action`, { cookie: adminCookie, body: { action: 'approve' } });
    assert.equal(a.status, 200, JSON.stringify(a.json));
  }
  assert.equal((await req('GET', `/api/leave/requests/${r1.json.id}`, { cookie: adminCookie })).json.status, 'approved');
  const bal = (await req('GET', `/api/leave/balance/${pid}`, { cookie: adminCookie })).json;
  assert.equal(bal.annualDays, 30);
  assert.equal(bal.usedDays >= 5, true, 'approved leave is counted');
  assert.equal(bal.balance, 30 - bal.usedDays);
  // rejection ends the request
  const r2 = await submit('مرخصی', '2026-08-01', '2026-08-02');
  assert.equal((await req('POST', `/api/leave/requests/${r2.json.id}/action`, { cookie: adminCookie, body: { action: 'reject', note: 'دلیلی ندارد' } })).json.status, 'rejected');
  assert.equal((await req('POST', `/api/leave/requests/${r2.json.id}/action`, { cookie: adminCookie, body: { action: 'approve' } })).status, 422, 'closed request cannot be acted on');
  // return for correction, then resubmit
  const r3 = await submit('مرخصی', '2026-09-01', '2026-09-03');
  assert.equal((await req('POST', `/api/leave/requests/${r3.json.id}/action`, { cookie: adminCookie, body: { action: 'return' } })).status, 422, 'return needs a note');
  assert.equal((await req('POST', `/api/leave/requests/${r3.json.id}/action`, { cookie: adminCookie, body: { action: 'return', note: 'تاریخ را اصلاح کنید' } })).json.status, 'returned');
  const re = await req('POST', `/api/leave/requests/${r3.json.id}/resubmit`, { cookie: adminCookie, body: { startDate: '2026-09-02', endDate: '2026-09-03' } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(re.json.status, 'pending');
  assert.equal(re.json.currentStep, 1);
  // an ordinary user cannot act on the chain
  const ordName = 'lv' + Math.floor(Math.random() * 1e6);
  await req('POST', '/api/users', { cookie: adminCookie, body: { username: ordName, name: 'کاربر مرخصی', role: 'پرسنل', password: 'LeavePass123' } });
  const ordRow = (await req('GET', '/api/users', { cookie: adminCookie })).json.items.find((x) => x.username === ordName);
  await req('PUT', `/api/users/${ordRow.id}`, { cookie: adminCookie, body: { role: 'کاربر عادی' } });
  const ord = await login(ordName, 'LeavePass123');
  assert.equal((await req('POST', `/api/leave/requests/${r3.json.id}/action`, { cookie: ord.cookie, body: { action: 'approve' } })).status, 404, 'no view access: the request is not revealed');
  // an empty chain blocks new requests
  await req('PUT', '/api/leave/settings', { cookie: adminCookie, body: { annualDays: 30, steps: [] } });
  assert.equal((await submit('مرخصی', '2026-10-01', '2026-10-02')).status, 422, 'no chain, no request');
  await req('PUT', '/api/leave/settings', { cookie: adminCookie, body: { annualDays: 30, steps: set0.steps.map((x) => ({ label: x.label, role: x.role })) } });
});

test('correspondence: incoming and outgoing letters get unique numbers per kind, even when created together; external party required; return and resend; filters', async () => {
  const u = (await req('GET', '/api/letters/recipients', { cookie: adminCookie })).json.users;
  const rcpt = u[0];
  if (!rcpt) return;
  // several incoming letters at once: numbers must all be different
  const made = await Promise.all([1, 2, 3, 4].map(() => req('POST', '/api/letters', { cookie: adminCookie, form: multipart({ subject: 'نامه وارده هم‌زمان', kind: 'وارده', externalParty: 'شرکت نمونه ارسال‌کننده', recipientType: 'user', recipientId: String(rcpt.id) }) })));
  for (const m of made) assert.equal(m.status, 201, JSON.stringify(m.json));
  const numbers = made.map((m) => m.json.number);
  assert.equal(new Set(numbers).size, 4, 'numbers are unique under concurrency');
  assert.ok(numbers.every((n) => n.startsWith('IN-')), 'incoming letters use the IN prefix');
  assert.equal(made[0].json.externalParty, 'شرکت نمونه ارسال‌کننده');
  assert.equal((await req('POST', '/api/letters', { cookie: adminCookie, form: multipart({ subject: 'بدون طرف بیرونی', kind: 'وارده', recipientType: 'user', recipientId: String(rcpt.id) }) })).status, 422, 'external party required');
  const out = await req('POST', '/api/letters', { cookie: adminCookie, form: multipart({ subject: 'نامه صادره', kind: 'صادره', externalParty: 'وزارت نمونه' }) });
  assert.equal(out.status, 201, JSON.stringify(out.json));
  assert.ok(out.json.number.startsWith('OUT-'));
  const inner = await req('POST', '/api/letters', { cookie: adminCookie, form: multipart({ subject: 'نامه داخلی', kind: 'داخلی', recipientType: 'user', recipientId: String(rcpt.id) }) });
  assert.ok(inner.json.number.startsWith('LTR-'));
  // return for correction by the holder, then resend by the sender
  const target = made[0].json;
  const rcptCookie = (await login(rcpt.username, rcpt.username === 'admin' ? 'Admin@Test1' : 'x')).cookie;
  void rcptCookie;
  const ret = await req('POST', `/api/letters/${target.id}/action`, { cookie: adminCookie, body: { action: 'return', note: 'اصلاح شود' } });
  assert.equal(ret.status, 403, 'the sender is not the holder, so the sender cannot return it');
  const list = await req('GET', '/api/letters?kind=وارده&status=sent&q=ارسال', { cookie: adminCookie });
  assert.ok(list.json.items.every((x) => x.kind === 'وارده'), 'kind filter works');
  const byNum = await req('GET', `/api/letters?q=${encodeURIComponent(numbers[1])}`, { cookie: adminCookie });
  assert.ok(byNum.json.items.some((x) => x.number === numbers[1]), 'search by number');
  const byClass = await req('GET', '/api/letters?classification=عادی&status=sent', { cookie: adminCookie });
  assert.ok(Array.isArray(byClass.json.items));
});

test('notices: audience by unit, read recorded for the signed-in user only, readers list for managers, attachments', async () => {
  const dep = await req('POST', '/api/departments', { cookie: adminCookie, body: { name: 'واحد اطلاعیه ' + Math.floor(Math.random() * 1e6) } });
  assert.equal(dep.status, 201, JSON.stringify(dep.json));
  const depId = dep.json.id;
  const member = 'mem' + Math.floor(Math.random() * 1e6);
  const mk = await req('POST', '/api/users', { cookie: adminCookie, body: { username: member, name: 'عضو واحد', role: 'پرسنل', password: 'MemPass123', departmentId: depId } });
  assert.equal(mk.status, 201, JSON.stringify(mk.json));
  const outsider = 'out' + Math.floor(Math.random() * 1e6);
  await req('POST', '/api/users', { cookie: adminCookie, body: { username: outsider, name: 'خارج واحد', role: 'پرسنل', password: 'OutPass123' } });
  const pub = await req('POST', '/api/announcements', { cookie: adminCookie, form: multipart({ title: 'اطلاعیه واحد', body: 'فقط واحد', departmentId: String(depId) }, { name: 'notice.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 notice') }) });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  assert.equal((await req('POST', '/api/announcements', { cookie: adminCookie, form: multipart({ title: 'اطلاعیه بد', departmentId: '999999' }) })).status, 422);
  const mc = await login(member, 'MemPass123');
  const oc = await login(outsider, 'OutPass123');
  const seenByMember = (await req('GET', '/api/announcements', { cookie: mc.cookie })).json.items;
  assert.ok(seenByMember.some((x) => x.id === pub.json.id), 'member of the unit sees the notice');
  const seenByOutsider = (await req('GET', '/api/announcements', { cookie: oc.cookie })).json.items;
  assert.ok(!seenByOutsider.some((x) => x.id === pub.json.id), 'other staff do not see a unit notice');
  assert.equal((await req('POST', `/api/announcements/${pub.json.id}/read`, { cookie: oc.cookie })).status, 404, 'no read for someone outside the audience');
  assert.equal((await req('POST', `/api/announcements/${pub.json.id}/read`, { cookie: mc.cookie })).status, 200);
  const again = await req('POST', `/api/announcements/${pub.json.id}/read`, { cookie: mc.cookie });
  assert.equal(again.status, 200, 'a second read does not fail');
  const after = (await req('GET', '/api/announcements', { cookie: mc.cookie })).json.items.find((x) => x.id === pub.json.id);
  assert.equal(after.readByMe, true);
  assert.equal(after.readCount, 1);
  assert.equal(after.audienceCount, 1);
  const readers = await req('GET', `/api/announcements/${pub.json.id}/readers`, { cookie: adminCookie });
  assert.equal(readers.status, 200);
  assert.equal(readers.json.read.length, 1);
  assert.equal(readers.json.unread.length, 0);
  assert.equal((await req('GET', `/api/announcements/${pub.json.id}/readers`, { cookie: mc.cookie })).status, 403, 'readers list is for managers only');
  const att = after.attachments[0];
  const dl = await rawGet(`/api/announcements/${pub.json.id}/attachments/${att.id}/download`, mc.cookie);
  assert.equal(dl.status, 200);
  assert.equal((await rawGet(`/api/announcements/${pub.json.id}/attachments/${att.id}/download`, oc.cookie)).status, 403, 'attachment hidden from outsiders');
});

test('reports: correspondence and leave reports respect visibility, filters apply to the right columns', async () => {
  const kinds = (await req('GET', '/api/reports/kinds', { cookie: adminCookie })).json.items.map((x) => x.kind);
  assert.ok(kinds.includes('letters') && kinds.includes('leave'));
  const lt = await rawGet('/api/reports/export?kind=letters', adminCookie);
  assert.equal(lt.status, 200);
  assert.ok(lt.text.includes('شماره نامه') && lt.text.includes('وضعیت'), 'letters report has its headers');
  const lv = await rawGet('/api/reports/export?kind=leave&status=' + encodeURIComponent('تأییدشده'), adminCookie);
  assert.equal(lv.status, 200);
  assert.ok(!lv.text.includes('در جریان تأیید'), 'status filter removes other statuses');
  const ord = await login('ordinary1', 'Ordinary@123');
  const ol = await rawGet('/api/reports/export?kind=letters', ord.cookie);
  assert.equal(ol.status, 200);
  assert.ok(!ol.text.includes('نامه صادره'), 'ordinary user does not see letters that are not theirs');
});

test('reports: notice viewing report counts viewers and non-viewers', async () => {
  const r = await rawGet('/api/reports/export?kind=announcements', adminCookie);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('مشاهده‌کرده') && r.text.includes('مشاهده‌نکرده'));
  const dataLine = r.text.split('\r\n').find((l) => l.includes('اطلاعیه واحد'));
  assert.ok(dataLine, 'the unit notice appears in the report');
});
