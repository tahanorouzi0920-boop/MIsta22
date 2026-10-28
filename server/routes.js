'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, UPLOAD_DIR } = require('./db');
const REF = require('./reference');
const J = require('./jalali');
const { verifyPassword } = require('./crypto');
const L = require('./lib');

const { fail, audit, diff, str, isPersianName, validNID, todayISO, parsePlate, plateText, can, need, permsOf } = L;
const toFa = J.toFa;

// ---------- Router ----------
const ROUTES = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  ROUTES.push({ method, re, keys, handler, auth: opts.auth !== false, multipart: !!opts.multipart });
}
function match(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return null;
}

const toUser = (r) => ({ id: r.id, username: r.username, name: r.name, role: r.role, root: !!r.is_root, active: !!r.active, perms: L.parsePerms(r.perms), driverId: r.driver_id || null, personnelId: r.personnel_id || null });
const intParam = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// ---------- Auth ----------
route('POST', '/api/login', (ctx) => {
  const ip = ctx.ip;
  L.checkLoginLimit(ip);
  const username = String(ctx.body.username || '').trim();
  const password = String(ctx.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!row || !verifyPassword(password, row.pass_hash)) {
    L.recordLoginFailure(ip);
    audit({ id: null, username: username || '—', role: '—' }, { action: 'login_failed', section: 'auth', entity: 'ورود', description: `تلاش ناموفق ورود با نام کاربری «${username}»`, outcome: 'ناموفق' });
    fail(401, 'نام کاربری یا رمز عبور نادرست است');
  }
  if (!row.active) {
    audit(toUser(row), { action: 'login_failed', section: 'auth', entity: 'ورود', recordId: row.id, description: 'تلاش ورود با حساب غیرفعال', outcome: 'ناموفق' });
    if (row.role === 'راننده') fail(403, 'حساب شما هنوز فعال نشده است. پس از تایید مدیر سامانه وارد شوید.');
    fail(403, 'این حساب غیرفعال شده و امکان ورود ندارد');
  }
  L.clearLoginFailures(ip);
  L.createSession(ctx.res, row.id);
  const user = toUser(row);
  audit(user, { action: 'login', section: 'auth', entity: 'ورود', recordId: row.id, description: 'ورود به سیستم' });
  return { user, perms: permsOf(user), idleMinutes: L.idleMinutes() };
}, { auth: false });

route('POST', '/api/logout', (ctx) => {
  audit(ctx.user, { action: 'logout', section: 'auth', entity: 'خروج', recordId: ctx.user.id, description: 'خروج از سیستم' });
  L.destroySession(ctx.req, ctx.res);
  return { ok: true };
});

route('GET', '/api/me', (ctx) => ({ user: ctx.user, perms: permsOf(ctx.user), idleMinutes: L.idleMinutes() }));

route('PUT', '/api/me/profile', (ctx) => {
  const name = str(ctx.body.name);
  if (!isPersianName(name)) fail(422, 'اطلاعات نامعتبر است', { name: 'فقط حروف (حداقل ۲ کاراکتر)' });
  const old = db.prepare('SELECT name FROM users WHERE id = ?').get(ctx.user.id).name;
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, ctx.user.id);
  audit(ctx.user, { action: 'update', section: 'users', entity: 'پروفایل', recordId: ctx.user.id, description: 'ویرایش نام نمایشی در پروفایل', changes: [{ field: 'نام نمایشی', from: old, to: name }] });
  return { user: { ...ctx.user, name } };
});

route('GET', '/api/reference', () => ({
  legal: REF.LEGAL, countries: REF.COUNTRIES, brands: REF.BRANDS, categories: REF.CATEGORIES, usage: REF.USAGE,
  newUserRoles: REF.NEW_USER_ROLES, provinces: REF.PROVINCES, geo: { status: REF.GEO.status, source: REF.GEO.source, sourceDate: REF.GEO.sourceDate, provinces: REF.GEO.provinces, cities: REF.GEO.cities }, plateLetters: REF.PLATE_LETTERS, roles: REF.ROLE_NAMES, sections: REF.SECTIONS,
  docCategories: REF.DOC_CATEGORIES, docOwners: REF.DOC_OWNERS, docStatusLabels: REF.DOC_STATUS_LABEL,
  maxUploadMb: L.MAX_UPLOAD_MB,
}));

// Health: reports ok only when the database answers a real query. 503 otherwise.
route('GET', '/api/health', () => {
  const version = require('../package.json').version;
  try {
    db.prepare('SELECT 1 AS n').get();
    return { ok: true, version, database: 'ok', time: new Date().toISOString() };
  } catch (err) {
    return [503, { ok: false, version, database: 'error', time: new Date().toISOString() }];
  }
}, { auth: false });

// ---------- Companies ----------

// A company may link to one active site and one active unit that belongs to that site.
function validateSupervisionLink(b) {
  const e = {};
  const siteId = b.siteId ? idOf(b.siteId) : null;
  const unitId = b.supervisionUnitId ? idOf(b.supervisionUnitId) : null;
  if (unitId && !siteId) e.supervisionUnitId = 'ابتدا سایت را انتخاب کنید';
  if (siteId && !db.prepare('SELECT id FROM sites WHERE id = ? AND active = 1').get(siteId)) e.siteId = 'سایت انتخاب‌شده معتبر یا فعال نیست';
  if (unitId) {
    const u = db.prepare('SELECT site_id, active FROM supervision_units WHERE id = ?').get(unitId);
    if (!u || !u.active) e.supervisionUnitId = 'واحد نظارت انتخاب‌شده معتبر یا فعال نیست';
    else if (u.site_id !== siteId) e.supervisionUnitId = 'این واحد نظارت متعلق به سایت انتخاب‌شده نیست';
  }
  return { siteId, unitId, e };
}

const companyOut = (r) => ({
  id: r.id, code: r.code, name: r.name, nationalId: r.national_id || '', regNo: r.reg_no || '', regDate: r.reg_date || '',
  legalType: r.legal_type || '', mobile: r.mobile, phone: r.phone || '', econ: r.econ || '', country: r.country,
  province: r.province || '', city: r.city || '', provinceCode: r.province_code || '', cityId: r.city_id || '',
  region: r.region || '', postal: r.postal || '', address: r.address,
  description: r.description || '', createdAt: r.created_at, updatedAt: r.updated_at,
  siteId: r.site_id || null, siteName: r.site_id ? (db.prepare('SELECT name FROM sites WHERE id = ?').get(r.site_id)?.name || '') : '',
  supervisionUnitId: r.supervision_unit_id || null,
  supervisionUnitName: r.supervision_unit_id ? (db.prepare('SELECT name FROM supervision_units WHERE id = ?').get(r.supervision_unit_id)?.name || '') : '',
});
const companyView = (o) => ({
  ...o, nationalId: o.nationalId || '—', regNo: o.regNo || '—', regDate: J.fmtJ(o.regDate),
  legalType: REF.LEGAL.find(([c]) => c === o.legalType)?.[1] || '—', mobile: toFa(o.mobile),
  phone: toFa(o.phone || '—'), econ: toFa(o.econ || '—'), postal: toFa(o.postal || '—'),
});

// Resolves province and city by stable code/ID. Names are accepted only when no code is sent.
// A city is valid only if it belongs to the resolved province.
function resolveGeo(b) {
  const errors = {};
  const p = b.provinceCode ? REF.GEO.provinceByCode[String(b.provinceCode)] : (b.province ? REF.GEO.provinceByName[String(b.province)] : null);
  if (!p) errors.province = 'استان را انتخاب کنید';
  let c = null;
  if (p) {
    if (b.cityId) {
      c = REF.GEO.cityById[String(b.cityId)] || null;
      if (!c || c.provinceCode !== p.code) errors.city = 'شهر انتخاب‌شده متعلق به این استان نیست';
    } else if (b.city) {
      c = REF.GEO.cityByName[p.code + '|' + String(b.city)] || null;
      if (!c) errors.city = 'شهر انتخاب‌شده متعلق به این استان نیست';
    } else errors.city = 'شهر را انتخاب کنید';
  }
  return { provinceCode: p?.code || '', province: p?.name || '', cityId: c?.id || '', city: c?.name || '', errors };
}

function validateCompany(b, id, existing) {
  const e = {};
  const v = {
    name: String(b.name ?? '').trim(), code: String(b.code ?? '').trim().toUpperCase(), nationalId: str(b.nationalId),
    regNo: str(b.regNo), regDate: String(b.regDate ?? '').trim(), legalType: String(b.legalType ?? ''), mobile: str(b.mobile),
    phone: str(b.phone).replace(/[\s-]/g, ''), econ: str(b.econ), country: existing ? existing.country : 'ایران',
    province: String(b.province ?? '').trim(), city: String(b.city ?? '').trim(), region: String(b.region ?? '').trim(),
    postal: str(b.postal), address: String(b.address ?? '').trim(), description: String(b.description ?? '').trim(),
  };
  if (v.name.length < 2 || v.name.length > 120) e.name = 'نام شرکت الزامی است (حداقل ۲ کاراکتر)';
  if (!/^[A-Z0-9-]{3,20}$/.test(v.code)) e.code = 'کد باید ۳ تا ۲۰ کاراکتر (انگلیسی، عدد یا -) باشد';
  else if (db.prepare('SELECT id FROM companies WHERE code = ? AND id IS NOT ?').get(v.code, id ?? null)) e.code = 'اطلاعات تکراری است: این کد قبلاً ثبت شده است';
  if (v.nationalId) {
    if (!/^\d{11}$/.test(v.nationalId)) e.nationalId = 'شناسه ملی باید ۱۱ رقم باشد';
    else if (db.prepare('SELECT id FROM companies WHERE national_id = ? AND id IS NOT ?').get(v.nationalId, id ?? null)) e.nationalId = 'اطلاعات تکراری است: این شناسه ملی قبلاً ثبت شده است';
  }
  if (v.regNo && !/^[0-9A-Za-z/-]{1,30}$/.test(v.regNo)) e.regNo = 'شماره ثبت نامعتبر است';
  if (!J.isValidISO(v.regDate)) e.regDate = 'تاریخ ثبت معتبر نیست';
  if (!REF.LEGAL.some(([c]) => c === v.legalType)) e.legalType = 'نوع شخصیت حقوقی را انتخاب کنید';
  if (!/^09\d{9}$/.test(v.mobile)) e.mobile = 'شماره موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷)';
  if (v.phone && !/^0\d{2,3}\d{7,8}$/.test(v.phone)) e.phone = 'شماره تلفن ثابت معتبر نیست (با کد شهر)';
  if (v.econ && !/^\d{12}$/.test(v.econ)) e.econ = 'کد اقتصادی باید ۱۲ رقم باشد';
  else if (v.econ && db.prepare('SELECT id FROM companies WHERE econ = ? AND id IS NOT ?').get(v.econ, id ?? null)) e.econ = 'اطلاعات تکراری است: این کد اقتصادی قبلاً ثبت شده';
  if (v.regNo && db.prepare('SELECT id FROM companies WHERE reg_no = ? AND id IS NOT ?').get(v.regNo, id ?? null)) e.regNo = 'اطلاعات تکراری است: این شماره ثبت قبلاً ثبت شده';
  if (!existing && String(b.country ?? 'ایران') !== 'ایران') e.country = 'کشور شرکت جدید فقط ایران است';
  if (!REF.COUNTRIES.includes(v.country)) e.country = 'کشور نامعتبر است';
  const geo = resolveGeo(b);
  if (v.country === 'ایران') {
    if (geo.errors.province) e.province = geo.errors.province;
    if (geo.errors.city) e.city = geo.errors.city;
    Object.assign(v, { provinceCode: geo.provinceCode, province: geo.province, cityId: geo.cityId, city: geo.city });
  } else { Object.assign(v, { provinceCode: '', province: '', cityId: '', city: '' }); }
  if (v.postal && !/^\d{10}$/.test(v.postal)) e.postal = 'کد پستی باید ۱۰ رقم باشد';
  if (v.address.length < 5 || v.address.length > 300) e.address = 'آدرس کامل را وارد کنید (۵ تا ۳۰۰ کاراکتر)';
  if (v.description.length > 500) e.description = 'توضیحات حداکثر ۵۰۰ کاراکتر است';
  return { v, e };
}

route('GET', '/api/companies', (ctx) => {
  need(ctx.user, 'companies', 'view');
  const q = `%${str(ctx.query.get('q') || '')}%`;
  const rows = db.prepare(`SELECT * FROM companies WHERE name LIKE ? OR code LIKE ? OR mobile LIKE ? OR IFNULL(province,'') LIKE ? ORDER BY id DESC LIMIT 1000`).all(q, q, q, q);
  return { items: rows.map(companyOut) };
});

route('POST', '/api/companies', (ctx) => {
  need(ctx.user, 'companies', 'create');
  const { v, e } = validateCompany(ctx.body, null, null);
  const link = validateSupervisionLink(ctx.body);
  Object.assign(e, link.e);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare(`INSERT INTO companies (code,name,national_id,reg_no,reg_date,legal_type,mobile,phone,econ,country,province,city,province_code,city_id,region,postal,address,description,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.code, v.name, v.nationalId || null, v.regNo || null, v.regDate, v.legalType, v.mobile,
    v.phone || null, v.econ || null, v.country, v.province || null, v.city || null, v.provinceCode || null, v.cityId || null, v.region || null, v.postal || null, v.address, v.description || null, now, now);
  db.prepare('UPDATE companies SET site_id = ?, supervision_unit_id = ? WHERE id = ?').run(link.siteId, link.unitId, r.lastInsertRowid);
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(r.lastInsertRowid);
  audit(ctx.user, { action: 'create', section: 'companies', entity: 'شرکت', recordId: row.id, description: `ایجاد شرکت «${row.name}»` });
  return [201, companyOut(row)];
});

route('PUT', '/api/companies/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!old) fail(404, 'شرکت یافت نشد');
  need(ctx.user, 'companies', 'edit');
  const { v, e } = validateCompany(ctx.body, id, old);
  const link = validateSupervisionLink(ctx.body);
  Object.assign(e, link.e);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const before = companyView(companyOut(old));
  db.prepare(`UPDATE companies SET code=?,name=?,national_id=?,reg_no=?,reg_date=?,legal_type=?,mobile=?,phone=?,econ=?,country=?,province=?,city=?,province_code=?,city_id=?,region=?,postal=?,address=?,description=?,updated_at=? WHERE id=?`)
    .run(v.code, v.name, v.nationalId || null, v.regNo || null, v.regDate, v.legalType, v.mobile, v.phone || null, v.econ || null, v.country,
      v.province || null, v.city || null, v.provinceCode || null, v.cityId || null, v.region || null, v.postal || null, v.address, v.description || null, new Date().toISOString(), id);
  db.prepare('UPDATE companies SET site_id = ?, supervision_unit_id = ? WHERE id = ?').run(link.siteId, link.unitId, id);
  const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  const changes = diff(before, companyView(companyOut(updated)), REF.LABELS.company);
  audit(ctx.user, { action: 'update', section: 'companies', entity: 'شرکت', recordId: id, description: `ویرایش شرکت «${updated.name}»`, changes });
  return companyOut(updated);
});

route('DELETE', '/api/companies/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!row) fail(404, 'شرکت یافت نشد');
  need(ctx.user, 'companies', 'delete');
  if (db.prepare('SELECT COUNT(*) n FROM contracts WHERE company_id = ?').get(id).n) fail(409, 'این شرکت در قرارداد استفاده شده و حذف نمی‌شود');
  if (hasDocs('company', id)) fail(409, 'ابتدا مدارک این شرکت را حذف کنید');
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  audit(ctx.user, { action: 'delete', section: 'companies', entity: 'شرکت', recordId: id, description: `حذف شرکت «${row.name}»` });
  return { ok: true };
});

// ---------- Drivers ----------
const driverOut = (r) => ({
  id: r.id, first: r.first_name, last: r.last_name, name: `${r.first_name} ${r.last_name}`, nid: r.nid, mobile: r.mobile,
  gender: r.gender, startDate: r.start_date || '', provinceCode: r.province_code || '', cityId: r.city_id || '',
  province: REF.GEO.provinceByCode[r.province_code]?.name || '', city: REF.GEO.cityById[r.city_id]?.name || '',
  residenceAddress: r.residence_address || '', createdAt: r.created_at, updatedAt: r.updated_at,
});
const driverView = (o) => ({
  name: o.name, nid: toFa(o.nid), mobile: toFa(o.mobile), gender: o.gender, startDate: J.fmtJ(o.startDate),
  province: o.province || '—', city: o.city || '—', residenceAddress: o.residenceAddress || '—',
});

function validateDriver(b, id) {
  const e = {};
  const v = { first: String(b.first ?? '').trim(), last: String(b.last ?? '').trim(), nid: str(b.nid), mobile: str(b.mobile), gender: String(b.gender ?? ''), startDate: String(b.startDate ?? '').trim() };
  if (!isPersianName(v.first)) e.first = 'نام معتبر نیست (فقط حروف)';
  if (!isPersianName(v.last)) e.last = 'نام خانوادگی معتبر نیست (فقط حروف)';
  if (!validNID(v.nid)) e.nid = 'کد ملی معتبر نیست';
  else if (db.prepare('SELECT id FROM drivers WHERE nid = ? AND id IS NOT ?').get(v.nid, id ?? null)) e.nid = 'اطلاعات تکراری است: این کد ملی قبلاً ثبت شده است';
  if (!/^09\d{9}$/.test(v.mobile)) e.mobile = 'شماره موبایل معتبر نیست';
  if (!['زن', 'مرد'].includes(v.gender)) e.gender = 'جنسیت را انتخاب کنید';
  // Residence is optional. If any residence field is sent, province and city must be valid together.
  v.residenceAddress = String(b.residenceAddress ?? '').trim();
  if (v.residenceAddress.length > 300) e.residenceAddress = 'آدرس حداکثر ۳۰۰ کاراکتر است';
  Object.assign(v, { provinceCode: '', province: '', cityId: '', city: '' });
  if (b.provinceCode || b.province || b.cityId || b.city) {
    const geo = resolveGeo(b);
    if (geo.errors.province) e.province = geo.errors.province;
    if (geo.errors.city) e.city = geo.errors.city;
    Object.assign(v, { provinceCode: geo.provinceCode, province: geo.province, cityId: geo.cityId, city: geo.city });
  }
  if (v.startDate) {
    if (!J.isValidISO(v.startDate)) e.startDate = 'تاریخ شروع همکاری معتبر نیست';
  }
  return { v, e };
}

route('GET', '/api/drivers', (ctx) => {
  need(ctx.user, 'drivers', 'view');
  const q = `%${str(ctx.query.get('q') || '')}%`;
  const rows = db.prepare(`SELECT * FROM drivers WHERE first_name||' '||last_name LIKE ? OR nid LIKE ? OR mobile LIKE ? ORDER BY id DESC LIMIT 1000`).all(q, q, q);
  return { items: rows.map(driverOut) };
});

route('POST', '/api/drivers', (ctx) => {
  need(ctx.user, 'drivers', 'create');
  const { v, e } = validateDriver(ctx.body, null);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  // created_at is server-generated and never taken from the client.
  const r = db.prepare('INSERT INTO drivers (first_name,last_name,nid,mobile,gender,start_date,province_code,city_id,residence_address,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(v.first, v.last, v.nid, v.mobile, v.gender, v.startDate || null, v.provinceCode || null, v.cityId || null, v.residenceAddress || null, now, now);
  const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(r.lastInsertRowid);
  audit(ctx.user, { action: 'create', section: 'drivers', entity: 'راننده', recordId: row.id, description: `افزودن راننده «${row.first_name} ${row.last_name}»` });
  return [201, driverOut(row)];
});

route('PUT', '/api/drivers/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!old) fail(404, 'راننده یافت نشد');
  need(ctx.user, 'drivers', 'edit');
  const { v, e } = validateDriver(ctx.body, id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const before = driverView(driverOut(old));
  db.prepare('UPDATE drivers SET first_name=?,last_name=?,nid=?,mobile=?,gender=?,start_date=?,province_code=?,city_id=?,residence_address=?,updated_at=? WHERE id=?')
    .run(v.first, v.last, v.nid, v.mobile, v.gender, v.startDate || null, v.provinceCode || null, v.cityId || null, v.residenceAddress || null, new Date().toISOString(), id);
  const updated = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  audit(ctx.user, { action: 'update', section: 'drivers', entity: 'راننده', recordId: id, description: `ویرایش راننده «${updated.first_name} ${updated.last_name}»`, changes: diff(before, driverView(driverOut(updated)), REF.LABELS.driver) });
  return driverOut(updated);
});

route('DELETE', '/api/drivers/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
  if (!row) fail(404, 'راننده یافت نشد');
  need(ctx.user, 'drivers', 'delete');
  if (db.prepare('SELECT COUNT(*) n FROM contracts WHERE driver_id = ?').get(id).n) fail(409, 'این راننده در قرارداد استفاده شده و حذف نمی‌شود');
  if (hasDocs('driver', id)) fail(409, 'ابتدا مدارک این راننده را حذف کنید');
  db.prepare('DELETE FROM drivers WHERE id = ?').run(id);
  audit(ctx.user, { action: 'delete', section: 'drivers', entity: 'راننده', recordId: id, description: `حذف راننده «${row.first_name} ${row.last_name}»` });
  return { ok: true };
});

// ---------- Vehicles ----------
const vehicleOut = (r) => {
  const plate = { a: r.plate_a, b: r.plate_b, c: r.plate_c, d: r.plate_d };
  return { id: r.id, brand: r.brand, model: r.model, category: r.category, cls: r.cls, year: r.year, capacity: r.capacity, usage: r.usage, supervisionUnit: r.supervision_unit || '', chassisNo: r.chassis_no || '', engineNo: r.engine_no || '', plate, plateText: plateText(plate), createdAt: r.created_at, updatedAt: r.updated_at };
};
const vehicleView = (o) => ({ brand: o.brand, model: o.model, plate: o.plateText, category: o.category, cls: o.cls, year: toFa(o.year), capacity: toFa(o.capacity), usage: o.usage });

function validateVehicle(b, id) {
  const e = {};
  const brand = String(b.brand ?? ''), model = String(b.model ?? ''), category = String(b.category ?? ''), cls = String(b.cls ?? '');
  const usage = String(b.usage ?? '');
  if (!REF.BRANDS[brand]) e.brand = 'برند را انتخاب کنید';
  else if (!REF.BRANDS[brand].includes(model)) e.model = 'مدل متعلق به این برند نیست';
  if (!REF.CATEGORIES[category]) e.category = 'دسته‌بندی را انتخاب کنید';
  else if (category === 'سواری' && !REF.CATEGORIES[category].includes(cls)) e.cls = 'کلاس خودروی سواری را انتخاب کنید';
  const clsFinal = category === 'سواری' ? cls : '';  // classes apply only to passenger cars
  const supervisionUnit = String(b.supervisionUnit ?? '').trim();
  if (supervisionUnit.length > 100) e.supervisionUnit = 'واحد نظارت حداکثر ۱۰۰ نویسه';
  // Chassis and engine numbers are optional; letters, digits, dash and slash are allowed.
  const chassisNo = String(b.chassisNo ?? '').trim(), engineNo = String(b.engineNo ?? '').trim();
  if (chassisNo && !/^[\p{L}\p{N}\-\/ ]{1,40}$/u.test(chassisNo)) e.chassisNo = 'شماره شاسی فقط حروف، عدد، - و / باشد';
  if (engineNo && !/^[\p{L}\p{N}\-\/ ]{1,40}$/u.test(engineNo)) e.engineNo = 'شماره موتور فقط حروف، عدد، - و / باشد';
  const year = Number(str(b.year));
  if (!Number.isInteger(year) || year < 1360 || year > 1405) e.year = 'سال ساخت باید بین ۱۳۶۰ و ۱۴۰۵ باشد';
  const capacity = Number(str(b.capacity));
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 60) e.capacity = 'ظرفیت باید عددی بین ۱ تا ۶۰ باشد';
  if (!REF.USAGE.includes(usage)) e.usage = 'نوع کاربری را انتخاب کنید';
  const { value: plate, error } = parsePlate(b.plate);
  if (error) e.plate = error;
  else if (db.prepare('SELECT id FROM vehicles WHERE plate_a=? AND plate_b=? AND plate_c=? AND plate_d=? AND id IS NOT ?')
    .get(plate.a, plate.b, plate.c, plate.d, id ?? null)) e.plate = 'اطلاعات تکراری است: این پلاک قبلاً برای خودروی دیگری ثبت شده است';
  return { v: { brand, model, category, cls: clsFinal, year, capacity, usage, plate, supervisionUnit, chassisNo, engineNo }, e };
}

route('GET', '/api/vehicles', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const q = `%${str(ctx.query.get('q') || '')}%`;
  const rows = db.prepare(`SELECT * FROM vehicles WHERE brand||' '||model LIKE ? OR plate_a||plate_b||plate_d LIKE ? OR plate_b LIKE ? ORDER BY id DESC LIMIT 1000`).all(q, q, q);
  return { items: rows.map(vehicleOut) };
});

route('POST', '/api/vehicles', (ctx) => {
  need(ctx.user, 'vehicles', 'create');
  const { v, e } = validateVehicle(ctx.body, null);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare(`INSERT INTO vehicles (brand,model,category,cls,year,capacity,usage,plate_a,plate_b,plate_c,plate_d,supervision_unit,chassis_no,engine_no,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(v.brand, v.model, v.category, v.cls, v.year, v.capacity, v.usage, v.plate.a, v.plate.b, v.plate.c, v.plate.d, v.supervisionUnit || null, v.chassisNo || null, v.engineNo || null, now, now);
  const row = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(r.lastInsertRowid);
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'خودرو', recordId: row.id, description: `افزودن خودروی ${plateText(v.plate)}` });
  return [201, vehicleOut(row)];
});

route('PUT', '/api/vehicles/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  if (!old) fail(404, 'خودرو یافت نشد');
  need(ctx.user, 'vehicles', 'edit');
  const { v, e } = validateVehicle(ctx.body, id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const before = vehicleView(vehicleOut(old));
  db.prepare(`UPDATE vehicles SET brand=?,model=?,category=?,cls=?,year=?,capacity=?,usage=?,plate_a=?,plate_b=?,plate_c=?,plate_d=?,supervision_unit=?,chassis_no=?,engine_no=?,updated_at=? WHERE id=?`)
    .run(v.brand, v.model, v.category, v.cls, v.year, v.capacity, v.usage, v.plate.a, v.plate.b, v.plate.c, v.plate.d, v.supervisionUnit || null, v.chassisNo || null, v.engineNo || null, new Date().toISOString(), id);
  const updated = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'خودرو', recordId: id, description: `ویرایش خودروی ${plateText(v.plate)}`, changes: diff(before, vehicleView(vehicleOut(updated)), REF.LABELS.vehicle) });
  return vehicleOut(updated);
});

route('DELETE', '/api/vehicles/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  if (!row) fail(404, 'خودرو یافت نشد');
  need(ctx.user, 'vehicles', 'delete');
  if (db.prepare('SELECT COUNT(*) n FROM contracts WHERE vehicle_id = ?').get(id).n) fail(409, 'این خودرو در قرارداد استفاده شده و حذف نمی‌شود');
  if (hasDocs('vehicle', id)) fail(409, 'ابتدا مدارک این خودرو را حذف کنید');
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
  audit(ctx.user, { action: 'delete', section: 'vehicles', entity: 'خودرو', recordId: id, description: `حذف خودروی ${plateText({ a: row.plate_a, b: row.plate_b, c: row.plate_c, d: row.plate_d })}` });
  return { ok: true };
});

// ---------- Contracts ----------
const CONTRACT_SQL = `SELECT k.*, c.name AS company_name, d.first_name AS df, d.last_name AS dl, v.brand, v.model,
  v.plate_a, v.plate_b, v.plate_c, v.plate_d FROM contracts k
  JOIN companies c ON c.id = k.company_id JOIN drivers d ON d.id = k.driver_id JOIN vehicles v ON v.id = k.vehicle_id`;
function contractStatus(endDate, t) {
  if (!endDate) return 'بدون تاریخ پایان';
  if (endDate < t) return 'منقضی';
  if (endDate <= J.addDays(t, 30)) return 'نزدیک انقضا';
  return 'فعال';
}
const contractOut = (r, t = todayISO()) => {
  const plate = { a: r.plate_a, b: r.plate_b, c: r.plate_c, d: r.plate_d };
  return {
    id: r.id, number: r.number, siteId: r.site_id || null, siteName: r.site_id ? (db.prepare('SELECT name FROM sites WHERE id = ?').get(r.site_id)?.name || '') : '',
    supervisionUnitId: r.supervision_unit_id || null, supervisionUnitName: r.supervision_unit_id ? (db.prepare('SELECT name FROM supervision_units WHERE id = ?').get(r.supervision_unit_id)?.name || '') : '',
    companyId: r.company_id, companyName: r.company_name, driverId: r.driver_id,
    driverName: `${r.df} ${r.dl}`, vehicleId: r.vehicle_id, vehiclePlate: plate, vehicleLabel: `${plateText(plate)} (${r.brand} ${r.model})`,
    startDate: r.start_date, endDate: r.end_date, status: contractStatus(r.end_date, t), createdAt: r.created_at, updatedAt: r.updated_at,
  };
};
const contractView = (o) => ({ company: o.companyName, driver: o.driverName, vehicle: o.vehicleLabel, startDate: J.fmtJ(o.startDate), endDate: o.endDate ? J.fmtJ(o.endDate) : 'بدون تاریخ پایان' });

function validateContract(b, fallbackEnd) {
  const e = {};
  const companyId = idOf(b.companyId), driverId = idOf(b.driverId), vehicleId = idOf(b.vehicleId);
  if (!companyId || !db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId)) e.companyId = 'شرکت را انتخاب کنید';
  if (!driverId || !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverId)) e.driverId = 'راننده را انتخاب کنید';
  if (!vehicleId || !db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicleId)) e.vehicleId = 'خودرو را انتخاب کنید';
  const startDate = String(b.startDate ?? ''), endDate = String(b.endDate ?? '');
  if (!J.isValidISO(startDate)) e.startDate = 'تاریخ شروع معتبر نیست';
  // The end date is optional. Without one the contract is open-ended and is stored as an empty string.
  // On update, a request without endDate keeps the stored value instead of erasing it.
  let finalEnd = endDate;
  if (endDate === '' && fallbackEnd !== undefined) finalEnd = fallbackEnd;
  if (finalEnd && !J.isValidISO(finalEnd)) e.endDate = 'تاریخ پایان معتبر نیست';
  else if (finalEnd && J.isValidISO(startDate) && finalEnd < startDate) e.endDate = 'تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد';
  return { v: { companyId, driverId, vehicleId, startDate, endDate: finalEnd || '' }, e };
}

route('GET', '/api/contracts', (ctx) => {
  need(ctx.user, 'contracts', 'view');
  const t = todayISO();
  return { items: db.prepare(`${CONTRACT_SQL} ORDER BY k.id DESC LIMIT 1000`).all().map((r) => contractOut(r, t)) };
});

route('POST', '/api/contracts', (ctx) => {
  need(ctx.user, 'contracts', 'create');
  const { v, e } = validateContract(ctx.body);
  const link = validateSupervisionLink(ctx.body);
  Object.assign(e, link.e);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  let rowId, number;
  // Contract numbers are allocated inside an immediate transaction, so concurrent requests never share a number.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('contract');
    const seq = db.prepare('SELECT value FROM counters WHERE name = ?').get('contract').value;
    number = `MST-${J.jparts(Date.now())[0]}-${String(seq).padStart(4, '0')}`;
    rowId = db.prepare(`INSERT INTO contracts (number,company_id,driver_id,vehicle_id,start_date,end_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(number, v.companyId, v.driverId, v.vehicleId, v.startDate, v.endDate, now, now).lastInsertRowid;
    db.prepare('UPDATE contracts SET site_id = ?, supervision_unit_id = ? WHERE id = ?').run(link.siteId, link.unitId, rowId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const row = db.prepare(`${CONTRACT_SQL} WHERE k.id = ?`).get(rowId);
  audit(ctx.user, { action: 'create', section: 'contracts', entity: 'قرارداد', recordId: rowId, description: `ایجاد قرارداد ${number}` });
  return [201, contractOut(row)];
});

route('PUT', '/api/contracts/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare(`${CONTRACT_SQL} WHERE k.id = ?`).get(id);
  if (!old) fail(404, 'قرارداد یافت نشد');
  need(ctx.user, 'contracts', 'edit');
  const { v, e } = validateContract(ctx.body, old.end_date);
  const link = validateSupervisionLink(ctx.body);
  Object.assign(e, link.e);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const before = contractView(contractOut(old));
  db.prepare('UPDATE contracts SET company_id=?,driver_id=?,vehicle_id=?,start_date=?,end_date=?,updated_at=? WHERE id=?')
    .run(v.companyId, v.driverId, v.vehicleId, v.startDate, v.endDate, new Date().toISOString(), id);
  db.prepare('UPDATE contracts SET site_id = ?, supervision_unit_id = ? WHERE id = ?').run(link.siteId, link.unitId, id);
  const row = db.prepare(`${CONTRACT_SQL} WHERE k.id = ?`).get(id);
  audit(ctx.user, { action: 'update', section: 'contracts', entity: 'قرارداد', recordId: id, description: `ویرایش قرارداد ${old.number}`, changes: diff(before, contractView(contractOut(row)), REF.LABELS.contract) });
  return contractOut(row);
});

route('DELETE', '/api/contracts/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  if (!row) fail(404, 'قرارداد یافت نشد');
  need(ctx.user, 'contracts', 'delete');
  db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
  audit(ctx.user, { action: 'delete', section: 'contracts', entity: 'قرارداد', recordId: id, description: `حذف قرارداد ${row.number}` });
  return { ok: true };
});

// ---------- Users ----------
// Validates a permission table from the client. Every section is present in the result; unknown sections are rejected.
function normalizePerms(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail(422, 'اطلاعات نامعتبر است', { perms: 'ساختار دسترسی نامعتبر است' });
  for (const sec of Object.keys(p)) if (!REF.SECTIONS[sec]) fail(422, 'اطلاعات نامعتبر است', { perms: `بخش ناشناخته: ${sec}` });
  const out = {};
  for (const sec of Object.keys(REF.SECTIONS)) {
    const v = p[sec] || {};
    out[sec] = { view: v.view === true, create: v.create === true, edit: v.edit === true, delete: v.delete === true };
  }
  return out;
}
const userOut = (r) => ({
  id: r.id, username: r.username, name: r.name, role: r.role, active: !!r.active, root: !!r.is_root, departmentId: r.department_id || null,
  perms: permsOf({ root: !!r.is_root, role: r.role, perms: L.parsePerms(r.perms) }), hasCustomPerms: !!r.perms, createdAt: r.created_at,
});
const departmentExists = (id) => !id || !!db.prepare('SELECT id FROM departments WHERE id = ?').get(id);

route('GET', '/api/users', (ctx) => {
  need(ctx.user, 'users', 'view');
  return { items: db.prepare('SELECT * FROM users ORDER BY id').all().map(userOut) };
});

route('POST', '/api/users', (ctx) => {
  need(ctx.user, 'users', 'create');
  const b = ctx.body, e = {};
  const username = String(b.username ?? '').trim(), name = String(b.name ?? '').trim(), role = String(b.role ?? '');
  const password = String(b.password ?? '');
  if (!/^[A-Za-z0-9_.]{3,30}$/.test(username)) e.username = 'فقط حروف انگلیسی، عدد، نقطه و _ (۳ تا ۳۰ کاراکتر)';
  else if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username)) e.username = 'اطلاعات تکراری است: این نام کاربری قبلاً ثبت شده است';
  if (!isPersianName(name)) e.name = 'نام نمایشی معتبر نیست (فقط حروف)';
  if (!REF.NEW_USER_ROLES.includes(role)) e.role = 'نقش انتخاب‌شده برای کاربر جدید مجاز نیست';
  // A driver account is always linked to one existing driver record that has no account yet.
  const driverRecordId = role === 'راننده' ? idOf(b.driverId) : null;
  const personnelRecordId = b.personnelId ? idOf(b.personnelId) : null;
  if (personnelRecordId) {
    if (!db.prepare('SELECT id FROM personnel WHERE id = ?').get(personnelRecordId)) e.personnelId = 'پرسنل انتخاب‌شده وجود ندارد';
    else if (db.prepare('SELECT id FROM users WHERE personnel_id = ?').get(personnelRecordId)) e.personnelId = 'این پرسنل قبلاً حساب کاربری دارد';
  }
  if (role === 'راننده') {
    if (!driverRecordId || !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverRecordId)) e.driverId = 'راننده را از فهرست انتخاب کنید';
    else if (db.prepare('SELECT id FROM users WHERE driver_id = ?').get(driverRecordId)) e.driverId = 'این راننده قبلاً حساب کاربری دارد';
  }
  if (password.length < 8 || password.length > 128) e.password = 'رمز عبور باید ۸ تا ۱۲۸ کاراکتر باشد';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const hash = require('./crypto').hashPassword(password);
  const deptId = b.departmentId ? idOf(b.departmentId) : null;
  if (b.departmentId && !departmentExists(deptId)) fail(422, 'اطلاعات نامعتبر است', { department: 'واحد انتخاب‌شده وجود ندارد' });
  const r = db.prepare('INSERT INTO users (username,name,pass_hash,role,active,is_root,department_id,created_at,driver_id) VALUES (?,?,?,?,1,0,?,?,?)').run(username, name, hash, role, deptId, new Date().toISOString(), driverRecordId);
  if (personnelRecordId) db.prepare('UPDATE users SET personnel_id = ? WHERE id = ?').run(personnelRecordId, r.lastInsertRowid);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  audit(ctx.user, { action: 'create', section: 'users', entity: 'کاربر', recordId: row.id, description: `ایجاد کاربر «${username}» با نقش ${role}` });
  return [201, userOut(row)];
});

route('PUT', '/api/users/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) fail(404, 'کاربر یافت نشد');
  need(ctx.user, 'users', 'edit');
  const b = ctx.body, changes = [];
  const wantsRole = b.role !== undefined && b.role !== row.role;
  const wantsDeactivate = b.active === false && !!row.active;
  if (row.is_root && (wantsRole || wantsDeactivate)) fail(403, 'مدیر اصلی قابل تغییر نقش یا غیرفعال‌سازی نیست');
  if (row.id === ctx.user.id && (wantsRole || wantsDeactivate)) fail(403, 'تغییر نقش یا وضعیت حساب خودتان مجاز نیست');
  const name = b.name !== undefined ? String(b.name).trim() : row.name;
  if (b.name !== undefined && !isPersianName(name)) fail(422, 'اطلاعات نامعتبر است', { name: 'نام نمایشی معتبر نیست' });
  if (b.role !== undefined && !REF.ROLE_NAMES.includes(b.role)) fail(422, 'اطلاعات نامعتبر است', { role: 'نقش نامعتبر است' });
  let passHash = row.pass_hash;
  if (b.password) {
    if (String(b.password).length < 8) fail(422, 'اطلاعات نامعتبر است', { password: 'رمز عبور حداقل ۸ کاراکتر باشد' });
    passHash = require('./crypto').hashPassword(String(b.password));
    changes.push({ field: 'رمز عبور', from: '••••', to: 'تغییر یافت' });
  }
  const role = b.role !== undefined ? b.role : row.role;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : row.active;
  if (name !== row.name) changes.push({ field: 'نام نمایشی', from: row.name, to: name });
  if (role !== row.role) changes.push({ field: 'نقش', from: row.role, to: role });
  if (active !== row.active) changes.push({ field: 'وضعیت حساب', from: row.active ? 'فعال' : 'غیرفعال', to: active ? 'فعال' : 'غیرفعال' });
  let deptId = row.department_id || null;
  if (b.departmentId !== undefined) {
    const nd = b.departmentId ? idOf(b.departmentId) : null;
    if (b.departmentId && !departmentExists(nd)) fail(422, 'اطلاعات نامعتبر است', { department: 'واحد انتخاب‌شده وجود ندارد' });
    if (nd !== deptId) changes.push({ field: 'واحد', from: deptId ? String(deptId) : '—', to: nd ? String(nd) : '—' });
    deptId = nd;
  }
  let permsJson = row.perms ?? null;
  if (b.perms !== undefined) {
    if (row.is_root) fail(403, 'دسترسی مدیر اصلی قابل تغییر نیست');
    if (row.id === ctx.user.id) fail(403, 'تغییر دسترسی حساب خودتان مجاز نیست');
    permsJson = JSON.stringify(normalizePerms(b.perms));
    changes.push({ field: 'دسترسی‌ها', from: 'قبلی', to: 'به‌روزرسانی شد' });
  } else if (role !== row.role) {
    permsJson = null; // a role change resets the table to the new role's defaults
  }
  db.prepare('UPDATE users SET name=?, role=?, active=?, pass_hash=?, department_id=?, perms=? WHERE id=?').run(name, role, active, passHash, deptId, permsJson, id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  if (changes.length) audit(ctx.user, { action: 'update', section: 'users', entity: 'کاربر', recordId: id, description: `ویرایش کاربر «${row.username}»`, changes });
  return userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
});

route('DELETE', '/api/users/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) fail(404, 'کاربر یافت نشد');
  need(ctx.user, 'users', 'delete');
  if (row.is_root || row.id === ctx.user.id) fail(403, 'این حساب قابل حذف نیست');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(ctx.user, { action: 'delete', section: 'users', entity: 'کاربر', recordId: id, description: `حذف کاربر «${row.username}»` });
  return { ok: true };
});

// ---------- Audit & reports ----------
route('GET', '/api/audit', (ctx) => {
  need(ctx.user, 'reports', 'view');
  const { where, params } = auditFilters(ctx.query);
  const size = intParam(ctx.query.get('size'), 10, 5, 100);
  const page = intParam(ctx.query.get('page'), 1, 1, 100000);
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  return {
    total, page, size,
    items: rows.map((r) => ({ id: r.id, ts: r.ts, username: r.username, role: r.role, action: r.action, section: r.section,
      sectionLabel: REF.SECTIONS[r.section] || 'ورود و خروج', entity: r.entity, recordId: r.record_id, description: r.description,
      changes: JSON.parse(r.changes || '[]'), outcome: r.outcome })),
  };
});

function auditFilters(query) {
  const where = [], params = [];
  const q = str(query.get('q') || '').toLowerCase();
  if (q) { where.push("LOWER(username || ' ' || description || ' ' || entity || ' ' || record_id) LIKE ?"); params.push(`%${q}%`); }
  for (const [key, col] of [['user', 'username'], ['section', 'section'], ['action', 'action'], ['outcome', 'outcome']]) {
    const v = query.get(key);
    if (v) { where.push(`${col} = ?`); params.push(v); }
  }
  const from = query.get('from'), to = query.get('to');
  if (J.isValidISO(from)) { where.push('ts >= ?'); params.push(J.dayStartUTC(from)); }
  if (J.isValidISO(to)) { where.push('ts <= ?'); params.push(J.dayEndUTC(to)); }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

route('GET', '/api/audit/:id', (ctx) => {
  need(ctx.user, 'reports', 'view');
  const r = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(idOf(ctx.params.id));
  if (!r) fail(404, 'رویداد یافت نشد');
  return {
    id: r.id, ts: r.ts, username: r.username, role: r.role, action: r.action, section: r.section,
    sectionLabel: REF.SECTIONS[r.section] || 'ورود و خروج', entity: r.entity, recordId: r.record_id,
    description: r.description, changes: JSON.parse(r.changes || '[]'), outcome: r.outcome,
  };
});

route('GET', '/api/reports/companies', (ctx) => {
  need(ctx.user, 'reports', 'view');
  need(ctx.user, 'companies', 'view');
  const q = `%${str(ctx.query.get('q') || '')}%`, prov = ctx.query.get('province') || '', city = ctx.query.get('city') || '';
  const rows = db.prepare(`SELECT * FROM companies WHERE (name LIKE ? OR code LIKE ?) AND (? = '' OR province_code = ?) AND (? = '' OR city_id = ?) ORDER BY id DESC LIMIT 2000`).all(q, q, prov, prov, city, city);
  return {
    items: rows.map((r) => {
      const o = companyOut(r);
      if (!ctx.user.root && o.nationalId) o.nationalId = `•••••••${o.nationalId.slice(-3)}`;
      return o;
    }),
  };
});

route('GET', '/api/reports/contracts', (ctx) => {
  need(ctx.user, 'reports', 'view');
  need(ctx.user, 'contracts', 'view');
  const t = todayISO(), q = normQ(ctx.query.get('q')), st = ctx.query.get('status') || '';
  const rows = db.prepare(`${CONTRACT_SQL} ORDER BY k.id DESC LIMIT 2000`).all().map((r) => contractOut(r, t));
  return { items: rows.filter((o) => (!q || `${o.number} ${o.driverName} ${o.companyName}`.toLowerCase().includes(q)) && (!st || o.status === st)) };
});

route('GET', '/api/reports/users', (ctx) => {
  need(ctx.user, 'reports', 'view');
  need(ctx.user, 'users', 'view');
  return { items: db.prepare('SELECT * FROM users ORDER BY id').all().map(userOut) };
});

const normQ = (v) => str(v || '').toLowerCase();

// ---------- Dashboard ----------
route('GET', '/api/dashboard', (ctx) => {
  const user = ctx.user, t = todayISO(), near = J.addDays(t, 30);
  let from = ctx.query.get('from'), to = ctx.query.get('to');
  if (!J.isValidISO(from)) from = t;
  if (!J.isValidISO(to)) to = t;
  if (from > to) [from, to] = [to, from];
  const a = J.dayStartUTC(from), z = J.dayEndUTC(to);
  const total = (tbl) => db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n;
  const inRange = (tbl) => db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE created_at BETWEEN ? AND ?`).get(a, z).n;
  const out = { range: { from, to }, today: t };
  if (can(user, 'companies', 'view')) {
    out.companies = { total: total('companies'), created: inRange('companies'),
      byProvince: db.prepare(`SELECT COALESCE(province,'نامشخص') AS label, COUNT(*) AS value FROM companies GROUP BY province ORDER BY value DESC LIMIT 10`).all() };
  }
  if (can(user, 'drivers', 'view')) out.drivers = { total: total('drivers'), created: inRange('drivers') };
  if (can(user, 'vehicles', 'view')) {
    out.vehicles = { total: total('vehicles'), created: inRange('vehicles'),
      byBrand: db.prepare('SELECT brand AS label, COUNT(*) AS value FROM vehicles GROUP BY brand ORDER BY value DESC LIMIT 10').all() };
  }
  if (can(user, 'contracts', 'view')) {
    const all = db.prepare('SELECT end_date FROM contracts').all();
    let expired = 0, nearN = 0;
    for (const r of all) { if (!r.end_date) continue; if (r.end_date < t) expired++; else if (r.end_date <= near) nearN++; }
    const created = db.prepare('SELECT created_at FROM contracts WHERE created_at BETWEEN ? AND ?').all(a, z);
    const byMonth = {};
    for (const c of created) {
      const iso = new Date(Date.parse(c.created_at) + 3.5 * 3600e3).toISOString().slice(0, 10);
      const [y, m] = J.jparts(J.msOf(iso));
      const key = `${y}/${String(m).padStart(2, '0')}`;
      byMonth[key] = (byMonth[key] || 0) + 1;
    }
    out.contracts = {
      total: all.length, active: all.length - expired, expired, near: nearN, created: created.length,
      byMonth: Object.keys(byMonth).sort().map((k) => ({ label: toFa(k), value: byMonth[k] })),
    };
    out.alerts = db.prepare(`SELECT number, end_date FROM contracts WHERE end_date >= ? AND end_date <= ? ORDER BY end_date LIMIT 20`).all(t, near);
  }
  if (can(user, 'documents', 'view')) {
    out.documents = {
      expiringSoon: db.prepare(`SELECT COUNT(*) n FROM documents WHERE owner_type IN ('driver', 'vehicle') AND status != 'na' AND stored_name IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?`).get(t, near).n,
      expired: db.prepare(`SELECT COUNT(*) n FROM documents WHERE owner_type IN ('driver', 'vehicle') AND status != 'na' AND stored_name IS NOT NULL AND expiry_date < ?`).get(t).n,
      pendingReview: db.prepare(`SELECT COUNT(*) n FROM documents WHERE owner_type IN ('driver', 'vehicle') AND status = 'pending'`).get().n,
    };
  }
  if (can(user, 'users', 'view')) out.users = { active: db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n };
  if (can(user, 'reports', 'view')) {
    out.activity = {
      byUser: db.prepare('SELECT username AS label, COUNT(*) AS value FROM audit_log WHERE ts BETWEEN ? AND ? GROUP BY username ORDER BY value DESC LIMIT 10').all(a, z),
      recent: db.prepare('SELECT ts, username, description FROM audit_log WHERE ts BETWEEN ? AND ? ORDER BY id DESC LIMIT 8').all(a, z),
    };
  }
  return out;
});

// ---------- Document types ----------
const docTypeOut = (r) => ({ id: r.id, name: r.name, category: r.category, categoryLabel: REF.DOC_CATEGORIES[r.category], ownerType: r.owner_type, required: !!r.required, active: !!r.active });

route('GET', '/api/doctypes', (ctx) => {
  if (!can(ctx.user, 'documents', 'view') && !can(ctx.user, 'doctypes', 'view')) fail(403, 'دسترسی لازم برای این عملیات را ندارید');
  return { items: db.prepare('SELECT * FROM doc_types ORDER BY category, id').all().map(docTypeOut) };
});

function validateDocType(b) {
  const e = {};
  const name = String(b.name ?? '').trim(), category = String(b.category ?? ''), ownerType = String(b.ownerType ?? '');
  if (name.length < 2 || name.length > 120) e.name = 'نام نوع مدرک را وارد کنید';
  if (!REF.DOC_CATEGORIES[category]) e.category = 'دسته‌بندی نامعتبر است';
  if (!REF.DOC_OWNERS.includes(ownerType)) e.ownerType = 'نوع مالک نامعتبر است';
  return { v: { name, category, ownerType, required: bool(b.required) ? 1 : 0, active: b.active === undefined ? 1 : (bool(b.active) ? 1 : 0) }, e };
}

route('POST', '/api/doctypes', (ctx) => {
  need(ctx.user, 'doctypes', 'create');
  const { v, e } = validateDocType(ctx.body);
  if (!e.name && db.prepare('SELECT id FROM doc_types WHERE name = ?').get(v.name)) e.name = 'این نوع مدرک قبلاً تعریف شده است';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const r = db.prepare('INSERT INTO doc_types (name,category,owner_type,required,active,created_at) VALUES (?,?,?,?,?,?)')
    .run(v.name, v.category, v.ownerType, v.required, v.active, new Date().toISOString());
  audit(ctx.user, { action: 'create', section: 'doctypes', entity: 'نوع مدرک', recordId: r.lastInsertRowid, description: `افزودن نوع مدرک «${v.name}»` });
  return [201, docTypeOut(db.prepare('SELECT * FROM doc_types WHERE id = ?').get(r.lastInsertRowid))];
});

route('PUT', '/api/doctypes/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM doc_types WHERE id = ?').get(id);
  if (!old) fail(404, 'نوع مدرک یافت نشد');
  need(ctx.user, 'doctypes', 'edit');
  const { v, e } = validateDocType({ ...old, ...ctx.body, required: ctx.body.required ?? old.required, active: ctx.body.active ?? old.active, ownerType: ctx.body.ownerType ?? old.owner_type });
  if (!e.name && db.prepare('SELECT id FROM doc_types WHERE name = ? AND id != ?').get(v.name, id)) e.name = 'این نام قبلاً استفاده شده است';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const changes = [];
  if (v.name !== old.name) changes.push({ field: 'نام نوع مدرک', from: old.name, to: v.name });
  if (v.required !== old.required) changes.push({ field: 'الزامی بودن', from: old.required ? 'الزامی' : 'اختیاری', to: v.required ? 'الزامی' : 'اختیاری' });
  if (v.active !== old.active) changes.push({ field: 'فعال', from: old.active ? 'بله' : 'خیر', to: v.active ? 'بله' : 'خیر' });
  db.prepare('UPDATE doc_types SET name=?, category=?, owner_type=?, required=?, active=? WHERE id=?').run(v.name, v.category, v.ownerType, v.required, v.active, id);
  if (changes.length) audit(ctx.user, { action: 'update', section: 'doctypes', entity: 'نوع مدرک', recordId: id, description: `ویرایش نوع مدرک «${v.name}»`, changes });
  return docTypeOut(db.prepare('SELECT * FROM doc_types WHERE id = ?').get(id));
});

// ---------- Documents ----------
const DOC_SELECT = `SELECT d.*, t.name AS type_name, t.category AS category, k.number AS contract_number FROM documents d JOIN doc_types t ON t.id = d.doc_type_id LEFT JOIN contracts k ON k.id = d.contract_id`;

function ownerExists(type, id) {
  if (!id) return false;
  if (type === 'driver') return !!db.prepare('SELECT id FROM drivers WHERE id = ?').get(id);
  if (type === 'vehicle') return !!db.prepare('SELECT id FROM vehicles WHERE id = ?').get(id);
  if (type === 'company') return !!db.prepare('SELECT id FROM companies WHERE id = ?').get(id);
  return false;
}
function ownerLabel(type, id) {
  if (type === 'driver') { const r = db.prepare('SELECT first_name, last_name FROM drivers WHERE id = ?').get(id); return r ? `${r.first_name} ${r.last_name}` : '—'; }
  if (type === 'vehicle') { const r = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id); return r ? plateText({ a: r.plate_a, b: r.plate_b, c: r.plate_c, d: r.plate_d }) : '—'; }
  if (type === 'company') { const r = db.prepare('SELECT name FROM companies WHERE id = ?').get(id); return r ? r.name : '—'; }
  return '—';
}
function hasDocs(type, id) { return !!db.prepare('SELECT id FROM documents WHERE owner_type = ? AND owner_id = ? LIMIT 1').get(type, id); }

function effStatus(r, t) {
  if (r.status === 'na') return 'na';
  if (!r.stored_name) return 'none';
  if (r.expiry_date && r.expiry_date < t) return 'expired';
  return r.status;
}
function docOut(r, t = todayISO()) {
  const eff = effStatus(r, t);
  return {
    id: r.id, docTypeId: r.doc_type_id, docTypeName: r.type_name, category: r.category, categoryLabel: REF.DOC_CATEGORIES[r.category],
    ownerType: r.owner_type, ownerId: r.owner_id, ownerLabel: ownerLabel(r.owner_type, r.owner_id),
    number: r.number || '', issueDate: r.issue_date || '', expiryDate: r.expiry_date || '', issuer: r.issuer || '', notes: r.notes || '',
    status: eff, statusLabel: REF.DOC_STATUS_LABEL[eff], hasFile: !!r.stored_name, fileName: r.file_name || '', size: r.size || 0,
    contractId: r.contract_id || null, contractNumber: r.contract_number || '',
    createdAt: r.created_at, updatedAt: r.updated_at, reviewedAt: r.reviewed_at || '',
  };
}
const docView = (o) => ({ number: o.number || '—', issueDate: J.fmtJ(o.issueDate), expiryDate: J.fmtJ(o.expiryDate), issuer: o.issuer || '—', notes: o.notes || '—', status: o.statusLabel, contract: o.contractNumber || '—' });
const DOC_LABELS = { number: 'شماره مدرک', issueDate: 'تاریخ صدور', expiryDate: 'تاریخ انقضا', issuer: 'صادرکننده', notes: 'توضیحات', status: 'وضعیت', contract: 'قرارداد مرتبط' };

// Optional contract link. Only vehicle documents may reference a contract, and only one of that vehicle.
function checkContractLink(contractId, ownerType, ownerId) {
  if (!contractId) return null;
  const k = db.prepare('SELECT id, vehicle_id FROM contracts WHERE id = ?').get(contractId);
  if (!k) return 'قرارداد یافت نشد';
  if (ownerType !== 'vehicle' || k.vehicle_id !== ownerId) return 'این قرارداد متعلق به این خودرو نیست';
  return null;
}

function docMeta(f, e, typeId) {
  const number = str(f.number).slice(0, 50);
  const issueDate = String(f.issueDate || '').trim(), expiryDate = String(f.expiryDate || '').trim();
  const issuer = String(f.issuer || '').trim().slice(0, 100), notes = String(f.notes || '').trim().slice(0, 500);
  if (issueDate && !J.isValidISO(issueDate)) e.issueDate = 'تاریخ صدور معتبر نیست';
  if (expiryDate && !J.isValidISO(expiryDate)) e.expiryDate = 'تاریخ انقضا معتبر نیست';
  if (issueDate && expiryDate && J.isValidISO(issueDate) && J.isValidISO(expiryDate) && expiryDate < issueDate) e.expiryDate = 'تاریخ انقضا نمی‌تواند قبل از تاریخ صدور باشد';
  return { number, issueDate, expiryDate, issuer, notes, typeId };
}

function checkFile(f) {
  const ext = (require('node:path').extname(f.filename || '').slice(1) || '').toLowerCase();
  const spec = REF.FILE_TYPES[ext];
  if (!spec) fail(415, 'فقط فایل‌های PDF، JPG، JPEG یا PNG مجاز است', { file: 'نوع فایل مجاز نیست' });
  if (!f.data.length) fail(422, 'فایل خالی است', { file: 'فایل خالی است' });
  if (f.data.length > L.MAX_UPLOAD) fail(413, `حجم فایل نباید بیش از ${toFa(L.MAX_UPLOAD_MB)} مگابایت باشد`, { file: 'حجم فایل زیاد است' });
  if (!spec.magic.every((byte, i) => f.data[i] === byte)) fail(415, 'محتوای فایل با نوع آن مطابقت ندارد', { file: 'محتوای فایل معتبر نیست' });
  return { ext, mime: spec.mime, data: f.data, name: String(f.filename).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) };
}

function writeStored(file) {
  const stored = `${crypto.randomUUID()}.${file.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), file.data, { flag: 'wx' });
  return stored;
}
const removeStored = (name) => { if (name) fs.rmSync(path.join(UPLOAD_DIR, path.basename(name)), { force: true }); };

route('GET', '/api/documents', (ctx) => {
  need(ctx.user, 'documents', 'view');
  const t = todayISO(), q = normQ(ctx.query.get('q'));
  const where = ["d.owner_type IN ('driver', 'vehicle')"], params = [];
  const cat = ctx.query.get('category'), ownerType = ctx.query.get('ownerType'), ownerId = idOf(ctx.query.get('ownerId'));
  if (cat) { where.push('t.category = ?'); params.push(cat); }
  if (ownerType) { where.push('d.owner_type = ?'); params.push(ownerType); }
  if (ownerId) { where.push('d.owner_id = ?'); params.push(ownerId); }
  const contractFilter = idOf(ctx.query.get('contractId'));
  if (contractFilter) { where.push('d.contract_id = ?'); params.push(contractFilter); }
  const from = ctx.query.get('from'), to = ctx.query.get('to');
  if (J.isValidISO(from)) { where.push('d.created_at >= ?'); params.push(J.dayStartUTC(from)); }
  if (J.isValidISO(to)) { where.push('d.created_at <= ?'); params.push(J.dayEndUTC(to)); }
  const sql = `${DOC_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 2000`;
  let items = db.prepare(sql).all(...params).map((r) => docOut(r, t));
  if (q) items = items.filter((o) => `${o.docTypeName} ${o.number} ${o.fileName} ${o.ownerLabel}`.toLowerCase().includes(q));
  const st = ctx.query.get('status');
  if (st) items = items.filter((o) => o.status === st);
  const expiry = ctx.query.get('expiry');
  const near = J.addDays(t, 30);
  if (expiry === 'expired') items = items.filter((o) => o.status === 'expired');
  if (expiry === 'soon') items = items.filter((o) => o.expiryDate && o.expiryDate >= t && o.expiryDate <= near && o.status !== 'na');
  const size = intParam(ctx.query.get('size'), 20, 5, 100), page = intParam(ctx.query.get('page'), 1, 1, 100000);
  return { total: items.length, page, size, items: items.slice((page - 1) * size, page * size) };
});

route('GET', '/api/documents/:id', (ctx) => {
  need(ctx.user, 'documents', 'view');
  const row = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(idOf(ctx.params.id));
  if (!row) fail(404, 'مدرک یافت نشد');
  return docOut(row);
});

route('POST', '/api/documents', (ctx) => {
  need(ctx.user, 'documents', 'create');
  const f = ctx.form.fields, e = {};
  const type = db.prepare('SELECT * FROM doc_types WHERE id = ?').get(idOf(f.docTypeId));
  if (!type || !type.active) e.docTypeId = 'نوع مدرک معتبر نیست';
  const ownerType = f.ownerType || '';
  if (!REF.DOC_OWNERS.includes(ownerType)) e.ownerType = 'نوع مالک نامعتبر است';
  else if (type && type.owner_type !== ownerType) e.docTypeId = 'این نوع مدرک برای این مالک قابل استفاده نیست';
  const ownerId = idOf(f.ownerId);
  if (!ownerExists(ownerType, ownerId)) e.ownerId = 'رکورد مرتبط یافت نشد';
  const contractId = idOf(f.contractId);
  if (f.contractId && f.contractId !== '' && !contractId) e.contractId = 'قرارداد نامعتبر است';
  else if (contractId) { const ce = checkContractLink(contractId, ownerType, ownerId); if (ce) e.contractId = ce; }
  const meta = docMeta(f, e, type?.id);
  const upload = ctx.form.files.file;
  let file = null;
  if (upload) file = checkFile(upload);
  const notApplicable = bool(f.notApplicable);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const status = file ? 'pending' : (notApplicable ? 'na' : 'none');
  const now = new Date().toISOString();
  const stored = file ? writeStored(file) : null;
  let id;
  try {
    id = db.prepare(`INSERT INTO documents (doc_type_id,owner_type,owner_id,number,issue_date,expiry_date,issuer,notes,status,file_name,stored_name,mime,size,uploaded_by,created_at,updated_at,contract_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(type.id, ownerType, ownerId, meta.number || null, meta.issueDate || null, meta.expiryDate || null,
      meta.issuer || null, meta.notes || null, status, file ? file.name : null, stored, file ? file.mime : null, file ? file.data.length : null,
      ctx.user.id, now, now, contractId || null).lastInsertRowid;
  } catch (err) {
    removeStored(stored);
    throw err;
  }
  const row = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  const linked = contractId ? ` (قرارداد ${row.contract_number})` : '';
  audit(ctx.user, { action: 'create', section: 'documents', entity: 'مدرک', recordId: id, description: `ثبت مدرک «${type.name}» برای ${ownerLabel(ownerType, ownerId)}${linked}` });
  return [201, docOut(row)];
});

route('PUT', '/api/documents/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  if (!old) fail(404, 'مدرک یافت نشد');
  need(ctx.user, 'documents', 'edit');
  const e = {};
  // Partial update: fields that are not sent keep their stored values.
  const b = ctx.body;
  const merged = {
    number: b.number ?? old.number ?? '', issueDate: b.issueDate ?? old.issue_date ?? '',
    expiryDate: b.expiryDate ?? old.expiry_date ?? '', issuer: b.issuer ?? old.issuer ?? '', notes: b.notes ?? old.notes ?? '',
  };
  const meta = docMeta(merged, e, old.doc_type_id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  let status = old.status;
  if (ctx.body.notApplicable !== undefined) {
    if (bool(ctx.body.notApplicable)) {
      if (old.stored_name) fail(422, 'مدرک دارای فایل را نمی‌توان «اعمال نمی‌شود» کرد', { notApplicable: 'ابتدا فایل را حذف کنید' });
      status = 'na';
    } else if (old.status === 'na') status = 'none';
  }
  let contractId = old.contract_id || null;
  if (ctx.body.contractId !== undefined) {
    contractId = idOf(ctx.body.contractId);
    const ce = checkContractLink(contractId, old.owner_type, old.owner_id);
    if (ce) fail(422, 'اطلاعات نامعتبر است', { contractId: ce });
  }
  const before = docView(docOut(old));
  db.prepare('UPDATE documents SET number=?, issue_date=?, expiry_date=?, issuer=?, notes=?, status=?, contract_id=?, updated_at=? WHERE id=?')
    .run(meta.number || null, meta.issueDate || null, meta.expiryDate || null, meta.issuer || null, meta.notes || null, status, contractId, new Date().toISOString(), id);
  const row = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  audit(ctx.user, { action: 'update', section: 'documents', entity: 'مدرک', recordId: id, description: `ویرایش مشخصات مدرک «${old.type_name}»`, changes: diff(before, docView(docOut(row)), DOC_LABELS) });
  return docOut(row);
});

route('PUT', '/api/documents/:id/file', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  if (!old) fail(404, 'مدرک یافت نشد');
  need(ctx.user, 'documents', 'edit');
  const upload = ctx.form.files.file;
  if (!upload) fail(422, 'فایل را انتخاب کنید', { file: 'فایل الزامی است' });
  const file = checkFile(upload);
  const stored = writeStored(file);
  const now = new Date().toISOString();
  try {
    db.prepare(`UPDATE documents SET stored_name=?, file_name=?, mime=?, size=?, status='pending', reviewed_by=NULL, reviewed_at=NULL, uploaded_by=?, updated_at=? WHERE id=?`)
      .run(stored, file.name, file.mime, file.data.length, ctx.user.id, now, id);
  } catch (err) {
    removeStored(stored);
    throw err;
  }
  removeStored(old.stored_name);
  audit(ctx.user, { action: 'update', section: 'documents', entity: 'مدرک', recordId: id, description: `جایگزینی فایل مدرک «${old.type_name}»`, changes: [{ field: 'فایل', from: old.file_name || '—', to: file.name }] });
  return docOut(db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id));
});

route('POST', '/api/documents/:id/review', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  if (!old) fail(404, 'مدرک یافت نشد');
  need(ctx.user, 'documents', 'edit');
  const decision = ctx.body.decision;
  if (!['approved', 'rejected'].includes(decision)) fail(422, 'تصمیم نامعتبر است');
  if (!old.stored_name) fail(422, 'برای بررسی، ابتدا فایل مدرک را بارگذاری کنید');
  const now = new Date().toISOString();
  db.prepare('UPDATE documents SET status=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?').run(decision, ctx.user.id, now, now, id);
  const label = REF.DOC_STATUS_LABEL[decision];
  audit(ctx.user, { action: 'update', section: 'documents', entity: 'مدرک', recordId: id, description: `${label} شدن مدرک «${old.type_name}»`,
    changes: [{ field: 'وضعیت', from: REF.DOC_STATUS_LABEL[old.status] || old.status, to: label }] });
  return docOut(db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id));
});

route('DELETE', '/api/documents/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  const old = id && db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  if (!old) fail(404, 'مدرک یافت نشد');
  need(ctx.user, 'documents', 'delete');
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  removeStored(old.stored_name);
  audit(ctx.user, { action: 'delete', section: 'documents', entity: 'مدرک', recordId: id, description: `حذف مدرک «${old.type_name}» برای ${ownerLabel(old.owner_type, old.owner_id)}` });
  return { ok: true };
});

route('GET', '/api/documents/:id/file', (ctx) => {
  need(ctx.user, 'documents', 'view');
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'مدرک یافت نشد');
  if (!row.stored_name) fail(404, 'این مدرک فایلی ندارد');
  const full = path.join(UPLOAD_DIR, path.basename(row.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  return {
    raw: fs.readFileSync(full),
    headers: {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.file_name || 'document')}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  };
});

route('GET', '/api/owners/:type/:id/missing', (ctx) => {
  need(ctx.user, 'documents', 'view');
  const type = ctx.params.type, id = idOf(ctx.params.id);
  if (!REF.DOC_OWNERS.includes(type) || !ownerExists(type, id)) fail(404, 'رکورد یافت نشد');
  const required = db.prepare('SELECT * FROM doc_types WHERE owner_type = ? AND required = 1 AND active = 1').all(type);
  const missing = required.filter((t) => !db.prepare(`SELECT id FROM documents WHERE doc_type_id = ? AND owner_type = ? AND owner_id = ? AND status IN ('pending','approved','na') LIMIT 1`).get(t.id, type, id))
    .map((t) => ({ id: t.id, name: t.name }));
  return { missing };
});

// ---------- Multipart route flags ----------
for (const r of ROUTES) {
  if (r.method === 'POST' && r.re.test('/api/documents')) r.multipart = true;
  if (r.method === 'PUT' && r.re.test('/api/documents/1/file')) r.multipart = true;
}

function normBool(v) { return bool(v); }


// ---------- Departments ----------
const deptOut = (r) => ({ id: r.id, name: r.name });
route('GET', '/api/departments', () => ({ items: db.prepare('SELECT * FROM departments ORDER BY name').all().map(deptOut) }));
route('POST', '/api/departments', (ctx) => {
  need(ctx.user, 'users', 'create');
  const name = String(ctx.body.name ?? '').trim();
  if (name.length < 2 || name.length > 80) fail(422, 'اطلاعات نامعتبر است', { name: 'نام واحد ۲ تا ۸۰ کاراکتر باشد' });
  if (db.prepare('SELECT id FROM departments WHERE name = ?').get(name)) fail(422, 'اطلاعات نامعتبر است', { name: 'اطلاعات تکراری است: این واحد قبلاً ثبت شده است' });
  const r = db.prepare('INSERT INTO departments (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
  audit(ctx.user, { action: 'create', section: 'users', entity: 'واحد', recordId: r.lastInsertRowid, description: `ایجاد واحد «${name}»` });
  return [201, deptOut(db.prepare('SELECT * FROM departments WHERE id = ?').get(r.lastInsertRowid))];
});

// ---------- Internal letters ----------
// Visibility: sender, current recipient (user or department of that user), and anyone who has taken part in the letter's history.
function letterVisibleSql(user) {
  const dept = userDeptOf(user.id) ?? -1;
  return `(l.sender_id = ${Number(user.id)} OR l.recipient_user_id = ${Number(user.id)} OR l.recipient_dept_id = ${Number(dept)}
    OR EXISTS (SELECT 1 FROM letter_events e WHERE e.letter_id = l.id AND (e.actor_id = ${Number(user.id)} OR e.from_user_id = ${Number(user.id)} OR e.to_user_id = ${Number(user.id)})))`;
}
const userDeptOf = (id) => db.prepare('SELECT department_id FROM users WHERE id = ?').get(id)?.department_id ?? null;
function letterHolder(letter, user) {
  if (letter.recipient_user_id) return letter.recipient_user_id === user.id;
  return letter.recipient_dept_id === userDeptOf(user.id);
}
function recipientLabel(letter) {
  if (letter.recipient_user_id) { const u = db.prepare('SELECT name FROM users WHERE id = ?').get(letter.recipient_user_id); return u ? u.name : '—'; }
  const d = db.prepare('SELECT name FROM departments WHERE id = ?').get(letter.recipient_dept_id);
  return d ? `واحد ${d.name}` : '—';
}
// Recipients are always individual users. Departments are not valid letter recipients.
function validRecipient(type, id, senderId) {
  if (type !== 'user') return { error: 'گیرنده نامه فقط می‌تواند یک کاربر باشد' };
  const u = id && db.prepare('SELECT id, active FROM users WHERE id = ?').get(id);
  if (!u || !u.active) return { error: 'گیرنده معتبر نیست یا غیرفعال است' };
  if (u.id === senderId) return { error: 'نمی‌توانید نامه را برای خودتان بفرستید' };
  return { user: id, dept: null };
}
const letterOut = (l, actor) => ({
  id: l.id, number: l.number, kind: l.kind, classification: l.classification || 'عادی', externalParty: l.external_party || '', subject: l.subject, senderName: db.prepare('SELECT name FROM users WHERE id = ?').get(l.sender_id)?.name || '—',
  senderId: l.sender_id, recipient: recipientLabel(l), status: l.status, createdAt: l.created_at, updatedAt: l.updated_at,
  canAct: !!actor && l.status !== 'closed' && letterHolder(l, actor),
});
const LETTER_KINDS = ['داخلی', 'اطلاعیه', 'وارده', 'صادره'];
const LETTER_PREFIX = { 'داخلی': 'LTR', 'اطلاعیه': 'ANN', 'وارده': 'IN', 'صادره': 'OUT' };
const isExternalKind = (k) => k === 'وارده' || k === 'صادره';
const CLASSIFICATIONS = ['عادی', 'محرمانه', 'خیلی محرمانه', 'سری', 'به‌کلی سری'];
// Attachments: any file type. Files are stored under random names and always served as downloads.
function checkAnyFile(f) {
  if (!f.data.length) fail(422, 'فایل خالی است', { file: 'فایل خالی است' });
  if (f.data.length > L.MAX_UPLOAD) fail(413, `حجم هر فایل نباید بیش از ${toFa(L.MAX_UPLOAD_MB)} مگابایت باشد`, { file: 'حجم فایل زیاد است' });
  const name = String(f.filename || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160) || 'file';
  const ext = (path.extname(name).slice(1) || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
  return { name, ext, mime: String(f.type || 'application/octet-stream').slice(0, 120), data: f.data };
}
const LETTER_STATUS = { sent: 'ارسال‌شده', received: 'دریافت‌شده', in_review: 'در حال بررسی', approved: 'تأیید شده', rejected: 'رد شده', returned: 'بازگردانده برای اصلاح', closed: 'بسته‌شده' };

function visibleLetter(id, user) {
  return db.prepare(`SELECT l.* FROM letters l WHERE l.id = ? AND ${letterVisibleSql(user)}`).get(id);
}

route('GET', '/api/letters', (ctx) => {
  need(ctx.user, 'letters', 'view');
  const box = ctx.query.get('box') || 'all';
  const kind = ctx.query.get('kind') || '';
  const q = normQ(ctx.query.get('q'));
  if (box === 'everyone' && !ctx.user.root) fail(403, 'فقط مدیر اصلی به همه نامه‌ها دسترسی دارد');
  let rows = box === 'everyone'
    ? db.prepare('SELECT l.* FROM letters l ORDER BY l.id DESC LIMIT 1000').all()
    : db.prepare(`SELECT l.* FROM letters l WHERE ${letterVisibleSql(ctx.user)} ORDER BY l.id DESC LIMIT 1000`).all();
  if (box === 'inbox') rows = rows.filter((l) => letterHolder(l, ctx.user));
  if (box === 'outbox') rows = rows.filter((l) => l.sender_id === ctx.user.id);
  if (kind && LETTER_KINDS.includes(kind)) rows = rows.filter((l) => l.kind === kind);
  const st = ctx.query.get('status') || '', cls = ctx.query.get('classification') || '';
  const from = ctx.query.get('from') || '', to = ctx.query.get('to') || '';
  const sender = normQ(ctx.query.get('sender')), recipient = normQ(ctx.query.get('recipient'));
  if (st && LETTER_STATUS[st]) rows = rows.filter((l) => l.status === st);
  if (cls && CLASSIFICATIONS.includes(cls)) rows = rows.filter((l) => (l.classification || 'عادی') === cls);
  if (from && J.isValidISO(from)) rows = rows.filter((l) => l.created_at.slice(0, 10) >= from);
  if (to && J.isValidISO(to)) rows = rows.filter((l) => l.created_at.slice(0, 10) <= to);
  if (sender) rows = rows.filter((l) => `${db.prepare('SELECT name FROM users WHERE id = ?').get(l.sender_id)?.name || ''} ${l.external_party || ''}`.toLowerCase().includes(sender));
  if (recipient) rows = rows.filter((l) => recipientLabel(l).toLowerCase().includes(recipient));
  if (q) rows = rows.filter((l) => `${l.number} ${l.subject} ${l.external_party || ''}`.toLowerCase().includes(q));
  return { items: rows.map((l) => letterOut(l, ctx.user)), statuses: LETTER_STATUS, kinds: LETTER_KINDS, classifications: CLASSIFICATIONS };
});

route('GET', '/api/letters/recipients', (ctx) => {
  need(ctx.user, 'letters', 'view');
  const users = db.prepare('SELECT id, name, username, department_id FROM users WHERE active = 1 AND id != ? ORDER BY name').all(ctx.user.id)
    .map((u) => ({ id: u.id, name: u.name, departmentId: u.department_id || null }));
  return { users };
});

route('POST', '/api/letters', async (ctx) => {
  need(ctx.user, 'letters', 'create');
  const f = ctx.form ? ctx.form.fields : ctx.body;
  const subject = String(f.subject ?? '').trim();
  const body = String(f.body ?? '').trim();
  const e = {};
  if (subject.length < 2 || subject.length > 200) e.subject = 'موضوع ۲ تا ۲۰۰ نویسه باشد';
  if (body.length > 5000) e.body = 'متن نامه حداکثر ۵۰۰۰ نویسه';
  const kindPre = f.kind === undefined ? 'داخلی' : String(f.kind);
  const outbound = kindPre === 'صادره' && !f.recipientId && !f.recipientType;
  // An outgoing letter to an outside party is held by its sender (the database requires one internal holder); the outside party is stored in external_party.
  const rec = outbound ? { user: ctx.user.id, dept: null } : validRecipient(String(f.recipientType ?? ''), idOf(f.recipientId), ctx.user.id);
  if (rec.error) e.recipient = rec.error;
  const kind = kindPre;
  if (!LETTER_KINDS.includes(kind)) e.kind = 'نوع نامه نامعتبر است';
  const externalParty = String(f.externalParty ?? '').trim();
  if (isExternalKind(kind) && (externalParty.length < 2 || externalParty.length > 150)) e.externalParty = kind === 'وارده' ? 'فرستنده بیرونی را وارد کنید (۲ تا ۱۵۰ نویسه)' : 'گیرنده بیرونی را وارد کنید (۲ تا ۱۵۰ نویسه)';
  if (kind === 'وارده' && !rec.user && !rec.dept && !rec.error) e.recipient = 'گیرنده داخلی نامه وارده را انتخاب کنید';
  const classification = f.classification === undefined ? 'عادی' : String(f.classification);
  if (!CLASSIFICATIONS.includes(classification)) e.classification = 'طبقه‌بندی نامعتبر است';
  const uploads = ctx.form ? ctx.form.fileList.filter((x) => x.field.startsWith('file')) : [];
  if (uploads.length > 10) e.file = 'حداکثر ۱۰ پیوست در هر نامه';
  const files = uploads.length && !e.file ? uploads.map(checkAnyFile) : [];
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  let letterId, number;
  const stored = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Each kind has its own counter, so numbers are unique per kind and per year. The counter is updated inside the transaction.
    const counter = kind === 'داخلی' ? 'letter' : `letter-${LETTER_PREFIX[kind]}`;
    db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').run(counter);
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counter);
    const seq = db.prepare('SELECT value FROM counters WHERE name = ?').get(counter).value;
    number = `${LETTER_PREFIX[kind]}-${J.jparts(Date.now())[0]}-${String(seq).padStart(5, '0')}`;
    letterId = db.prepare(`INSERT INTO letters (number,subject,body,sender_id,recipient_user_id,recipient_dept_id,status,kind,classification,external_party,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(number, subject, body || null, ctx.user.id, rec.user, rec.dept, 'sent', kind, classification, isExternalKind(kind) ? externalParty : null, now, now).lastInsertRowid;
    db.prepare(`INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,to_user_id,to_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(letterId, now, ctx.user.id, 'send', ctx.user.id, rec.user, rec.dept, 'sent', null);
    for (const file of files) {
      const name = writeStored(file);
      stored.push(name);
      db.prepare('INSERT INTO letter_attachments (letter_id,file_name,stored_name,mime,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(letterId, file.name, name, file.mime, file.data.length, ctx.user.id, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    for (const name of stored) removeStored(name);
    throw err;
  }
  audit(ctx.user, { action: 'create', section: 'letters', entity: 'نامه', recordId: letterId, description: `ثبت نامه ${kind} ${number} برای ${recipientLabel(db.prepare('SELECT * FROM letters WHERE id = ?').get(letterId))}` });
  return [201, letterOut(db.prepare('SELECT * FROM letters WHERE id = ?').get(letterId), ctx.user)];
});

route('GET', '/api/letters/:id', (ctx) => {
  need(ctx.user, 'letters', 'view');
  const l = visibleLetter(idOf(ctx.params.id), ctx.user);
  if (!l) fail(404, 'نامه یافت نشد');
  const events = db.prepare('SELECT * FROM letter_events WHERE letter_id = ? ORDER BY id').all(l.id).map((ev) => ({
    id: ev.id, ts: ev.ts, action: ev.action, status: ev.status, note: ev.note || '',
    actorName: db.prepare('SELECT name FROM users WHERE id = ?').get(ev.actor_id)?.name || '—',
    from: ev.from_user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(ev.from_user_id)?.name : (ev.from_dept_id ? 'واحد' : '—'),
    to: ev.to_user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(ev.to_user_id)?.name : (ev.to_dept_id ? `واحد ${db.prepare('SELECT name FROM departments WHERE id = ?').get(ev.to_dept_id)?.name || ''}` : '—'),
  }));
  const attachments = db.prepare('SELECT id, file_name, size, mime, created_at FROM letter_attachments WHERE letter_id = ? ORDER BY id').all(l.id);
  const last = events[events.length - 1];
  const summary = `نامه ${l.number} از ${db.prepare('SELECT name FROM users WHERE id = ?').get(l.sender_id)?.name || '—'} به ${recipientLabel(l)} — وضعیت: ${LETTER_STATUS[l.status]}` + (last ? ` — آخرین اقدام: ${last.actorName} (${last.ts.slice(0, 16).replace('T', ' ')})` : '');
  return { ...letterOut(l, ctx.user), body: l.body || '', events, attachments, statusLabel: LETTER_STATUS[l.status], summary };
});

route('POST', '/api/letters/:id/action', (ctx) => {
  need(ctx.user, 'letters', 'edit');
  const l = visibleLetter(idOf(ctx.params.id), ctx.user);
  if (!l) fail(404, 'نامه یافت نشد');
  const action = String(ctx.body.action ?? '');
  const note = String(ctx.body.note ?? '').trim().slice(0, 500);
  const now = new Date().toISOString();
  const holder = letterHolder(l, ctx.user);
  const fromUser = l.recipient_user_id, fromDept = l.recipient_dept_id;
  if (action === 'receive') {
    if (!holder) fail(403, 'فقط گیرنده نامه می‌تواند آن را دریافت کند');
    if (l.status !== 'sent') fail(422, 'این نامه قبلاً دریافت شده است');
    db.prepare('UPDATE letters SET status=?, updated_at=? WHERE id=?').run('received', now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?)').run(l.id, now, ctx.user.id, 'receive', fromUser, fromDept, 'received', note || null);
  } else if (action === 'in_review') {
    if (!holder) fail(403, 'فقط گیرنده فعلی نامه می‌تواند وضعیت را تغییر دهد');
    if (l.status === 'closed') fail(422, 'نامه بسته شده است');
    db.prepare('UPDATE letters SET status=?, updated_at=? WHERE id=?').run('in_review', now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?)').run(l.id, now, ctx.user.id, 'in_review', fromUser, fromDept, 'in_review', note || null);
  } else if (action === 'approve' || action === 'reject') {
    if (l.kind === 'اطلاعیه') fail(422, 'اطلاعیه قابل تأیید یا رد نیست؛ فقط می‌توان آن را دریافت کرد یا بست');
    if (!holder) fail(403, 'فقط گیرنده فعلی نامه می‌تواند تأیید یا رد کند');
    if (l.status === 'closed') fail(422, 'نامه بسته شده است');
    const status = action === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE letters SET status=?, updated_at=? WHERE id=?').run(status, now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?)').run(l.id, now, ctx.user.id, action, fromUser, fromDept, status, note || null);
  } else if (action === 'return') {
    if (!holder) fail(403, 'فقط گیرنده فعلی می‌تواند نامه را برای اصلاح بازگرداند');
    if (l.status === 'closed') fail(422, 'نامه بسته شده است');
    if (note.length < 2) fail(422, 'اطلاعات نامعتبر است', { note: 'برای بازگرداندن نامه، توضیح لازم است' });
    db.prepare('UPDATE letters SET status=?, updated_at=? WHERE id=?').run('returned', now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?)').run(l.id, now, ctx.user.id, 'return', fromUser, fromDept, 'returned', note);
  } else if (action === 'resend') {
    if (l.sender_id !== ctx.user.id) fail(403, 'فقط فرستنده می‌تواند نامه بازگشتی را دوباره ارسال کند');
    if (l.status !== 'returned') fail(422, 'فقط نامه بازگشتی را می‌توان دوباره ارسال کرد');
    db.prepare('UPDATE letters SET status=?, updated_at=? WHERE id=?').run('sent', now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?)').run(l.id, now, ctx.user.id, 'resend', fromUser, fromDept, 'sent', note || null);
  } else if (action === 'close') {
    if (!holder && l.sender_id !== ctx.user.id) fail(403, 'فقط گیرنده یا فرستنده می‌تواند نامه را ببندد');
    if (l.status === 'closed') fail(422, 'نامه قبلاً بسته شده است');
    db.prepare('UPDATE letters SET status=?, updated_at=? WHERE id=?').run('closed', now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?)').run(l.id, now, ctx.user.id, 'close', fromUser, fromDept, 'closed', note || null);
  } else if (action === 'forward') {
    if (!holder) fail(403, 'فقط گیرنده فعلی می‌تواند نامه را ارجاع دهد');
    if (l.status === 'closed') fail(422, 'نامه بسته شده است و قابل ارجاع نیست');
    const rec = validRecipient(String(ctx.body.recipientType ?? ''), idOf(ctx.body.recipientId), ctx.user.id);
    if (rec.error) fail(422, 'اطلاعات نامعتبر است', { recipient: rec.error });
    if (rec.user === l.recipient_user_id && rec.dept === l.recipient_dept_id) fail(422, 'نامه به همین گیرنده ارجاع داده شده است');
    db.prepare('UPDATE letters SET recipient_user_id=?, recipient_dept_id=?, status=?, updated_at=? WHERE id=?').run(rec.user, rec.dept, 'sent', now, l.id);
    db.prepare('INSERT INTO letter_events (letter_id,ts,actor_id,action,from_user_id,from_dept_id,to_user_id,to_dept_id,status,note) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(l.id, now, ctx.user.id, 'forward', fromUser, fromDept, rec.user, rec.dept, 'sent', note || null);
  } else fail(422, 'عملیات نامعتبر است');
  audit(ctx.user, { action: 'update', section: 'letters', entity: 'نامه', recordId: l.id, description: `عملیات «${action}» روی نامه ${l.number}`, changes: [{ field: 'وضعیت', from: LETTER_STATUS[l.status] || l.status, to: LETTER_STATUS[db.prepare('SELECT status FROM letters WHERE id = ?').get(l.id).status] }] });
  return letterOut(db.prepare('SELECT * FROM letters WHERE id = ?').get(l.id), ctx.user);
});

route('GET', '/api/letters/:id/attachments/:aid', (ctx) => {
  need(ctx.user, 'letters', 'view');
  const l = visibleLetter(idOf(ctx.params.id), ctx.user);
  if (!l) fail(404, 'نامه یافت نشد');
  const a = db.prepare('SELECT * FROM letter_attachments WHERE id = ? AND letter_id = ?').get(idOf(ctx.params.aid), l.id);
  if (!a) fail(404, 'پیوست یافت نشد');
  const full = path.join(UPLOAD_DIR, path.basename(a.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  return { raw: fs.readFileSync(full), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } };
});

// ---------- Absence and leave register ----------
const ABSENCE_KINDS = ['غیبت', 'مرخصی', 'تأخیر'];
const absenceOut = (r) => ({ id: r.id, userId: r.user_id, userName: db.prepare('SELECT name FROM users WHERE id = ?').get(r.user_id)?.name || '—', kind: r.kind, fromDate: r.from_date, toDate: r.to_date, fromTime: r.from_time || '', toTime: r.to_time || '', note: r.note || '', createdAt: r.created_at });
route('GET', '/api/absences', (ctx) => {
  need(ctx.user, 'absences', 'view');
  const canSeeAll = permsOf(ctx.user).absences.edit;
  const rows = canSeeAll
    ? db.prepare('SELECT * FROM absences ORDER BY from_date DESC, id DESC LIMIT 1000').all()
    : db.prepare('SELECT * FROM absences WHERE user_id = ? ORDER BY from_date DESC, id DESC LIMIT 1000').all(ctx.user.id);
  return { items: rows.map(absenceOut), canManageAll: canSeeAll };
});
route('POST', '/api/absences', (ctx) => {
  need(ctx.user, 'absences', 'create');
  const b = ctx.body;
  const kind = String(b.kind ?? '');
  const from = String(b.fromDate ?? '').trim(), to = String(b.toDate ?? '').trim();
  const note = String(b.note ?? '').trim();
  const forOther = b.userId && idOf(b.userId) !== ctx.user.id;
  if (forOther) need(ctx.user, 'absences', 'edit');
  const targetId = forOther ? idOf(b.userId) : ctx.user.id;
  const e = {};
  if (!ABSENCE_KINDS.includes(kind)) e.kind = 'نوع ثبت نامعتبر است';
  if (!J.isValidISO(from)) e.fromDate = 'تاریخ شروع معتبر نیست';
  if (!J.isValidISO(to)) e.toDate = 'تاریخ پایان معتبر نیست';
  if (!e.fromDate && !e.toDate && to < from) e.toDate = 'تاریخ پایان نمی‌تواند قبل از شروع باشد';
  if (note.length > 500) e.note = 'توضیحات حداکثر ۵۰۰ نویسه';
  const fromTime = String(b.fromTime ?? '').trim(), toTime = String(b.toTime ?? '').trim();
  const timeOk = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  if (fromTime && !timeOk(fromTime)) e.fromTime = 'ساعت شروع معتبر نیست';
  if (toTime && !timeOk(toTime)) e.toTime = 'ساعت پایان معتبر نیست';
  if (fromTime && toTime && timeOk(fromTime) && timeOk(toTime) && from === to && toTime <= fromTime) e.toTime = 'ساعت پایان باید بعد از ساعت شروع باشد';
  if (!db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId)) e.userId = 'کاربر معتبر نیست';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const r = db.prepare('INSERT INTO absences (user_id,kind,from_date,to_date,from_time,to_time,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(targetId, kind, from, to, fromTime || null, toTime || null, note || null, ctx.user.id, new Date().toISOString());
  const row = db.prepare('SELECT * FROM absences WHERE id = ?').get(r.lastInsertRowid);
  audit(ctx.user, { action: 'create', section: 'absences', entity: 'ثبت غیبت/مرخصی', recordId: row.id, description: `ثبت ${kind} برای ${absenceOut(row).userName} از ${from} تا ${to}` });
  return [201, absenceOut(row)];
});
route('DELETE', '/api/absences/:id', (ctx) => {
  need(ctx.user, 'absences', 'delete');
  const id = idOf(ctx.params.id);
  const row = id && db.prepare('SELECT * FROM absences WHERE id = ?').get(id);
  if (!row) fail(404, 'ثبت یافت نشد');
  db.prepare('DELETE FROM absences WHERE id = ?').run(id);
  audit(ctx.user, { action: 'delete', section: 'absences', entity: 'ثبت غیبت/مرخصی', recordId: id, description: `حذف ${row.kind} کاربر ${absenceOut(row).userName} (${row.from_date})` });
  return { ok: true };
});

// ---------- Administrative automation ----------
const ownUserName = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || '—';
// Notice board
// Notices: sent to everyone or to one unit; each reader is recorded with the time they read it.
const annAudience = (a) => a.department_id ? db.prepare('SELECT id, name FROM users WHERE active = 1 AND department_id = ? ORDER BY name').all(a.department_id) : db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
const annVisible = (u, a) => can(u, 'announcements', 'edit') || annAudience(a).some((x) => x.id === u.id);
const annOut = (a, u) => {
  const aud = annAudience(a), reads = db.prepare('SELECT user_id, read_at FROM announcement_reads WHERE announcement_id = ?').all(a.id);
  return { id: a.id, title: a.title, body: a.body || '', pinned: !!a.pinned, createdBy: ownUserName(a.created_by), createdAt: a.created_at,
    audience: a.department_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(a.department_id)?.name || '') : 'همه کارکنان',
    departmentId: a.department_id || null, audienceCount: aud.length, readCount: reads.filter((r) => aud.some((x) => x.id === r.user_id)).length,
    readByMe: reads.some((r) => r.user_id === u.id), attachments: db.prepare('SELECT id, file_name, size FROM announcement_attachments WHERE announcement_id = ? ORDER BY id').all(a.id).map((x) => ({ id: x.id, fileName: x.file_name, size: x.size })) };
};
route('GET', '/api/announcements', (ctx) => {
  need(ctx.user, 'announcements', 'view');
  const rows = db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 200').all().filter((a) => annVisible(ctx.user, a));
  return { items: rows.map((a) => annOut(a, ctx.user)), canManage: can(ctx.user, 'announcements', 'edit'), canCreate: can(ctx.user, 'announcements', 'create') };
});
route('POST', '/api/announcements', (ctx) => {
  need(ctx.user, 'announcements', 'create');
  const f = ctx.form ? ctx.form.fields : ctx.body;
  const title = String(f.title ?? '').trim(), body = String(f.body ?? '').trim();
  const pinned = f.pinned === true || f.pinned === 'true' || f.pinned === '1' || f.pinned === 'on';
  const deptId = f.departmentId ? idOf(f.departmentId) : null;
  const e = {};
  if (title.length < 2 || title.length > 150) e.title = 'عنوان ۲ تا ۱۵۰ نویسه';
  if (body.length > 3000) e.body = 'متن حداکثر ۳۰۰۰ نویسه';
  if (f.departmentId && !db.prepare('SELECT id FROM departments WHERE id = ?').get(deptId)) e.departmentId = 'واحد انتخاب‌شده وجود ندارد';
  const uploads = ctx.form ? ctx.form.fileList.filter((x) => x.field.startsWith('file')) : [];
  if (uploads.length > 5) e.file = 'حداکثر ۵ پیوست';
  const files = uploads.map((x) => checkFile(x));
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const stored = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('INSERT INTO announcements (title,body,pinned,created_by,created_at,department_id) VALUES (?,?,?,?,?,?)').run(title, body || null, pinned ? 1 : 0, ctx.user.id, now, deptId);
    for (const file of files) {
      const name = writeStored(file); stored.push(name);
      db.prepare('INSERT INTO announcement_attachments (announcement_id,file_name,stored_name,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, file.name, name, file.mime, file.data.length, now);
    }
    db.exec('COMMIT');
    audit(ctx.user, { action: 'create', section: 'announcements', entity: 'اطلاعیه', recordId: r.lastInsertRowid, description: `ثبت اطلاعیه «${title}»` });
    return [201, { id: r.lastInsertRowid }];
  } catch (err) { db.exec('ROLLBACK'); stored.forEach(removeStored); throw err; }
}, { multipart: true });
route('POST', '/api/announcements/:id/read', (ctx) => {
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(idOf(ctx.params.id));
  if (!a || !annVisible(ctx.user, a)) fail(404, 'اطلاعیه یافت نشد');
  // The read is always recorded for the signed-in user only; the request cannot name another user.
  db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,?,?)').run(a.id, ctx.user.id, new Date().toISOString());
  return { ok: true };
});
route('GET', '/api/announcements/:id/readers', (ctx) => {
  need(ctx.user, 'announcements', 'edit');
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(idOf(ctx.params.id));
  if (!a) fail(404, 'اطلاعیه یافت نشد');
  const reads = db.prepare('SELECT user_id, read_at FROM announcement_reads WHERE announcement_id = ?').all(a.id);
  const aud = annAudience(a);
  return { total: aud.length,
    read: aud.filter((x) => reads.some((r) => r.user_id === x.id)).map((x) => ({ name: x.name, readAt: reads.find((r) => r.user_id === x.id).read_at })),
    unread: aud.filter((x) => !reads.some((r) => r.user_id === x.id)).map((x) => ({ name: x.name })) };
});
route('GET', '/api/announcements/:id/attachments/:aid/download', (ctx) => {
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(idOf(ctx.params.id));
  if (!a || !annVisible(ctx.user, a)) fail(403, 'دسترسی ندارید');
  const at = db.prepare('SELECT * FROM announcement_attachments WHERE id = ? AND announcement_id = ?').get(idOf(ctx.params.aid), a.id);
  if (!at) fail(404, 'پیوست یافت نشد');
  const full = path.join(UPLOAD_DIR, path.basename(at.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  return { raw: fs.readFileSync(full), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(at.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } };
});
route('DELETE', '/api/announcements/:id', (ctx) => {
  need(ctx.user, 'announcements', 'delete');
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'اعلان یافت نشد');
  db.prepare('DELETE FROM announcements WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'announcements', entity: 'اعلان', recordId: row.id, description: `حذف اعلان «${row.title}»` });
  return { ok: true };
});
// Tasks
const TASK_STATUS = { todo: 'انجام نشده', doing: 'در حال انجام', done: 'انجام شده' };
// Tasks: assigner and assignee can follow a task; only the assignee moves its execution status and reports progress.
const TASK_PRIORITY = ['کم', 'متوسط', 'زیاد', 'فوری'];
const taskVisible = (u, t) => u.id === t.assignee_id || u.id === t.created_by || can(u, 'tasks', 'edit');
const taskOut = (t, u) => ({ id: t.id, title: t.title, description: t.description || '', expectedResult: t.expected_result || '', priority: t.priority,
  assigneeId: t.assignee_id, assigneeName: ownUserName(t.assignee_id), assignerId: t.created_by, assignerName: ownUserName(t.created_by),
  status: t.status, statusLabel: TASK_STATUS[t.status], dueDate: t.due_date || '', createdAt: t.created_at, updatedAt: t.updated_at,
  overdue: !!t.due_date && t.status !== 'done' && t.due_date < todayISO(), isAssignee: u.id === t.assignee_id });
route('GET', '/api/tasks', (ctx) => {
  need(ctx.user, 'tasks', 'view');
  const u = ctx.user;
  let rows = can(u, 'tasks', 'edit') ? db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 1000').all()
    : db.prepare('SELECT * FROM tasks WHERE assignee_id = ? OR created_by = ? ORDER BY id DESC LIMIT 1000').all(u.id, u.id);
  const st = ctx.query.get('status') || '', who = ctx.query.get('assignee') || '', by = ctx.query.get('assigner') || '', overdue = ctx.query.get('overdue') === '1';
  if (st && TASK_STATUS[st]) rows = rows.filter((t) => t.status === st);
  if (who) rows = rows.filter((t) => String(t.assignee_id) === who);
  if (by) rows = rows.filter((t) => String(t.created_by) === by);
  if (overdue) rows = rows.filter((t) => t.due_date && t.status !== 'done' && t.due_date < todayISO());
  return { items: rows.map((t) => taskOut(t, u)), statuses: TASK_STATUS, priorities: TASK_PRIORITY, canCreate: can(u, 'tasks', 'create') };
});
route('POST', '/api/tasks', (ctx) => {
  need(ctx.user, 'tasks', 'create');
  const b = ctx.body, e = {};
  const title = String(b.title ?? '').trim(), description = String(b.description ?? '').trim(), expected = String(b.expectedResult ?? '').trim();
  const assignee = idOf(b.assigneeId), dueDate = String(b.dueDate ?? '').trim(), priority = String(b.priority ?? 'متوسط');
  if (title.length < 2 || title.length > 150) e.title = 'عنوان ۲ تا ۱۵۰ نویسه';
  if (!assignee || !db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(assignee)) e.assigneeId = 'مسئول انجام کار را انتخاب کنید';
  if (assignee === ctx.user.id) e.assigneeId = 'وظیفه را به خودتان واگذار نکنید';
  if (dueDate && !J.isValidISO(dueDate)) e.dueDate = 'مهلت معتبر نیست';
  if (!TASK_PRIORITY.includes(priority)) e.priority = 'اولویت نامعتبر است';
  if (description.length > 4000) e.description = 'شرح حداکثر ۴۰۰۰ نویسه';
  if (expected.length > 1000) e.expectedResult = 'نتیجه مورد انتظار حداکثر ۱۰۰۰ نویسه';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO tasks (title,description,expected_result,priority,assignee_id,status,due_date,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(title, description || null, expected || null, priority, assignee, 'todo', dueDate || null, ctx.user.id, now, now);
  db.prepare('INSERT INTO task_events (task_id,action,note,actor_id,created_at) VALUES (?,?,?,?,?)').run(r.lastInsertRowid, 'assigned', null, ctx.user.id, now);
  // Internal notice record: the assignee sees the task in the inbox counters (کارتابل) and in the tasks list.
  audit(ctx.user, { action: 'create', section: 'tasks', entity: 'وظیفه', recordId: r.lastInsertRowid, description: `واگذاری وظیفه «${title}» به ${ownUserName(assignee)}` });
  return [201, { id: r.lastInsertRowid }];
});
route('GET', '/api/tasks/:id', (ctx) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOf(ctx.params.id));
  if (!t || !taskVisible(ctx.user, t)) fail(404, 'وظیفه یافت نشد');
  const events = db.prepare('SELECT e.*, u.name AS actor FROM task_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.task_id = ? ORDER BY e.id').all(t.id)
    .map((x) => ({ action: x.action, note: x.note || '', actor: x.actor || '—', at: x.created_at }));
  const attachments = db.prepare('SELECT id, file_name, size FROM task_attachments WHERE task_id = ? ORDER BY id').all(t.id).map((a) => ({ id: a.id, fileName: a.file_name, size: a.size }));
  return { ...taskOut(t, ctx.user), events, attachments, nextStatuses: ctx.user.id === t.assignee_id ? ['todo', 'doing', 'done'].filter((x) => x !== t.status) : [] };
});
route('PUT', '/api/tasks/:id/status', (ctx) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOf(ctx.params.id));
  if (!t || !taskVisible(ctx.user, t)) fail(404, 'وظیفه یافت نشد');
  if (ctx.user.id !== t.assignee_id) fail(403, 'فقط مسئول انجام می‌تواند وضعیت اجرایی وظیفه را تغییر دهد');
  const status = String(ctx.body.status ?? '');
  if (!TASK_STATUS[status]) fail(422, 'وضعیت نامعتبر است');
  if (status === t.status) fail(422, 'وضعیت تغییری نکرده است');
  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, t.id);
  db.prepare('INSERT INTO task_events (task_id,action,note,actor_id,created_at) VALUES (?,?,?,?,?)').run(t.id, `status:${status}`, `${TASK_STATUS[t.status]} ← ${TASK_STATUS[status]}`, ctx.user.id, now);
  audit(ctx.user, { action: 'update', section: 'tasks', entity: 'وظیفه', recordId: t.id, description: `تغییر وضعیت «${t.title}» به ${TASK_STATUS[status]}`, changes: [{ field: 'وضعیت', from: TASK_STATUS[t.status], to: TASK_STATUS[status] }] });
  return { ok: true };
});
route('POST', '/api/tasks/:id/progress', (ctx) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOf(ctx.params.id));
  if (!t || !taskVisible(ctx.user, t)) fail(404, 'وظیفه یافت نشد');
  if (ctx.user.id !== t.assignee_id) fail(403, 'فقط مسئول انجام می‌تواند گزارش پیشرفت ثبت کند');
  const note = String(ctx.body.note ?? '').trim();
  if (note.length < 2 || note.length > 2000) fail(422, 'اطلاعات نامعتبر است', { note: 'گزارش پیشرفت ۲ تا ۲۰۰۰ نویسه' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO task_events (task_id,action,note,actor_id,created_at) VALUES (?,?,?,?,?)').run(t.id, 'progress', note, ctx.user.id, now);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, t.id);
  audit(ctx.user, { action: 'update', section: 'tasks', entity: 'گزارش پیشرفت', recordId: t.id, description: `گزارش پیشرفت «${t.title}»` });
  return { ok: true };
});
route('GET', '/api/tasks/:id/attachments/:aid/download', (ctx) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOf(ctx.params.id));
  if (!t || !taskVisible(ctx.user, t)) fail(403, 'دسترسی ندارید');
  const a = db.prepare('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?').get(idOf(ctx.params.aid), t.id);
  if (!a) fail(404, 'پیوست یافت نشد');
  const full = path.join(UPLOAD_DIR, path.basename(a.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  return { raw: fs.readFileSync(full), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } };
});
route('POST', '/api/tasks/:id/attachments', (ctx) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOf(ctx.params.id));
  if (!t || !taskVisible(ctx.user, t)) fail(404, 'وظیفه یافت نشد');
  if (ctx.user.id !== t.assignee_id && ctx.user.id !== t.created_by) fail(403, 'فقط واگذارکننده یا مسئول انجام می‌تواند پیوست کند');
  const upload = ctx.form ? ctx.form.fileList.find((x) => x.field.startsWith('file')) : null;
  if (!upload) fail(422, 'اطلاعات نامعتبر است', { file: 'فایل را انتخاب کنید' });
  const file = checkFile(upload);
  const stored = writeStored(file);
  try {
    db.prepare('INSERT INTO task_attachments (task_id,file_name,stored_name,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(t.id, file.name, stored, file.mime, file.data.length, new Date().toISOString());
  } catch (err) { removeStored(stored); throw err; }
  audit(ctx.user, { action: 'create', section: 'tasks', entity: 'پیوست وظیفه', recordId: t.id, description: `پیوست به «${t.title}»` });
  return [201, { ok: true }];
}, { multipart: true });
route('DELETE', '/api/tasks/:id', (ctx) => {
  need(ctx.user, 'tasks', 'delete');
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'وظیفه یافت نشد');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'tasks', entity: 'وظیفه', recordId: row.id, description: `حذف وظیفه «${row.title}»` });
  return { ok: true };
});
// Meetings
const meetingVisible = (m, user) => can(user, 'meetings', 'edit') || m.created_by === user.id || !!db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(m.id, user.id);
route('GET', '/api/meetings', (ctx) => {
  need(ctx.user, 'meetings', 'view');
  const rows = db.prepare('SELECT * FROM meetings ORDER BY meeting_date DESC, id DESC LIMIT 500').all().filter((m) => meetingVisible(m, ctx.user));
  return { items: rows.map((m) => ({ id: m.id, title: m.title, meetingDate: m.meeting_date, startTime: m.start_time || '', endTime: m.end_time || '', location: m.location || '', agenda: m.agenda || '', createdBy: ownUserName(m.created_by), participants: db.prepare('SELECT u.id, u.name FROM meeting_participants p JOIN users u ON u.id = p.user_id WHERE p.meeting_id = ? ORDER BY u.name').all(m.id) })), canManage: can(ctx.user, 'meetings', 'edit') };
});
route('POST', '/api/meetings', (ctx) => {
  need(ctx.user, 'meetings', 'create');
  const b = ctx.body, e = {};
  const title = String(b.title ?? '').trim(), meetingDate = String(b.meetingDate ?? '').trim();
  const startTime = String(b.startTime ?? '').trim(), endTime = String(b.endTime ?? '').trim();
  const location = String(b.location ?? '').trim(), agenda = String(b.agenda ?? '').trim();
  const participants = Array.isArray(b.participants) ? [...new Set(b.participants.map(idOf).filter(Boolean))] : [];
  if (title.length < 2 || title.length > 150) e.title = 'عنوان ۲ تا ۱۵۰ نویسه';
  if (!J.isValidISO(meetingDate)) e.meetingDate = 'تاریخ جلسه معتبر نیست';
  if (startTime && !timeOk(startTime)) e.startTime = 'ساعت شروع معتبر نیست';
  if (endTime && !timeOk(endTime)) e.endTime = 'ساعت پایان معتبر نیست';
  if (startTime && endTime && timeOk(startTime) && timeOk(endTime) && endTime <= startTime) e.endTime = 'ساعت پایان باید بعد از ساعت شروع باشد';
  if (location.length > 150) e.location = 'محل حداکثر ۱۵۰ نویسه';
  if (agenda.length > 3000) e.agenda = 'دستور جلسه حداکثر ۳۰۰۰ نویسه';
  if (participants.some((p) => !db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(p))) e.participants = 'یکی از شرکت‌کنندگان معتبر نیست';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('INSERT INTO meetings (title,meeting_date,start_time,end_time,location,agenda,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(title, meetingDate, startTime || null, endTime || null, location || null, agenda || null, ctx.user.id, new Date().toISOString());
    for (const p of participants) db.prepare('INSERT INTO meeting_participants (meeting_id,user_id) VALUES (?,?)').run(r.lastInsertRowid, p);
    db.exec('COMMIT');
    audit(ctx.user, { action: 'create', section: 'meetings', entity: 'جلسه', recordId: r.lastInsertRowid, description: `ثبت جلسه «${title}» در ${meetingDate}` });
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return [201, { ok: true }];
});
route('DELETE', '/api/meetings/:id', (ctx) => {
  need(ctx.user, 'meetings', 'delete');
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'جلسه یافت نشد');
  db.prepare('DELETE FROM meetings WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'meetings', entity: 'جلسه', recordId: row.id, description: `حذف جلسه «${row.title}»` });
  return { ok: true };
});
// Document archive (general company archive_documents)
const DOC_ARCHIVE_CATEGORIES = ['اداری', 'مالی', 'منابع انسانی', 'فنی', 'ایزو', 'سایر'];
route('GET', '/api/archive', (ctx) => {
  need(ctx.user, 'archive', 'view');
  const q = normQ(ctx.query.get('q')), cat = ctx.query.get('category') || '';
  let rows = db.prepare('SELECT * FROM archive_documents ORDER BY id DESC LIMIT 1000').all();
  if (cat) rows = rows.filter((d) => d.category === cat);
  if (q) rows = rows.filter((d) => `${d.title} ${d.file_name}`.toLowerCase().includes(q));
  return { items: rows.map((d) => ({ id: d.id, title: d.title, category: d.category, fileName: d.file_name, size: d.size, uploadedBy: ownUserName(d.uploaded_by), createdAt: d.created_at })), categories: DOC_ARCHIVE_CATEGORIES, canDelete: can(ctx.user, 'archive', 'delete') };
});
route('POST', '/api/archive', (ctx) => {
  need(ctx.user, 'archive', 'create');
  const f = ctx.form ? ctx.form.fields : ctx.body;
  const title = String(f.title ?? '').trim(), category = String(f.category ?? '');
  const e = {};
  if (title.length < 2 || title.length > 150) e.title = 'عنوان سند ۲ تا ۱۵۰ نویسه';
  if (!DOC_ARCHIVE_CATEGORIES.includes(category)) e.category = 'دسته‌بندی را انتخاب کنید';
  const upload = ctx.form ? ctx.form.fileList.find((x) => x.field.startsWith('file')) : null;
  if (!upload) e.file = 'فایل سند را انتخاب کنید';
  const file = upload ? checkAnyFile(upload) : null;
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const stored = writeStored(file);
  try {
    const r = db.prepare('INSERT INTO archive_documents (title,category,file_name,stored_name,mime,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(title, category, file.name, stored, file.mime, file.data.length, ctx.user.id, new Date().toISOString());
    audit(ctx.user, { action: 'create', section: 'archive', entity: 'سند', recordId: r.lastInsertRowid, description: `بایگانی سند «${title}»` });
  } catch (err) { removeStored(stored); throw err; }
  return [201, { ok: true }];
});
route('GET', '/api/archive/:id/download', (ctx) => {
  need(ctx.user, 'archive', 'view');
  const d = db.prepare('SELECT * FROM archive_documents WHERE id = ?').get(idOf(ctx.params.id));
  if (!d) fail(404, 'سند یافت نشد');
  const full = path.join(UPLOAD_DIR, path.basename(d.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  return { raw: fs.readFileSync(full), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } };
});
route('DELETE', '/api/archive/:id', (ctx) => {
  need(ctx.user, 'archive', 'delete');
  const d = db.prepare('SELECT * FROM archive_documents WHERE id = ?').get(idOf(ctx.params.id));
  if (!d) fail(404, 'سند یافت نشد');
  db.prepare('DELETE FROM archive_documents WHERE id = ?').run(d.id);
  removeStored(d.stored_name);
  audit(ctx.user, { action: 'delete', section: 'archive', entity: 'سند', recordId: d.id, description: `حذف سند «${d.title}»` });
  return { ok: true };
});
// Personal inbox: what is waiting for this user
route('GET', '/api/inbox', (ctx) => {
  const u = ctx.user;
  const toReceive = db.prepare(`SELECT COUNT(*) AS n FROM letters WHERE recipient_user_id = ? AND status = 'sent'`).get(u.id).n;
  const waiting = db.prepare(`SELECT COUNT(*) AS n FROM letters WHERE recipient_user_id = ? AND status IN ('received','in_review') AND kind = 'داخلی'`).get(u.id).n;
  const tasks = can(u, 'tasks', 'view') ? db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status != 'done'`).get(u.id).n : 0;
  const today = todayISO();
  const meetings = can(u, 'meetings', 'view') ? db.prepare(`SELECT COUNT(*) AS n FROM meetings m WHERE m.meeting_date >= ? AND (m.created_by = ? OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = ?))`).get(today, u.id, u.id).n : 0;
  return { letters: { toReceive, waiting }, tasks, meetings };
});

for (const r of ROUTES) {
  if (r.method === 'POST' && (r.re.test('/api/letters') || r.re.test('/api/archive'))) r.multipart = true;
}


// ---------- Vehicle detail: main info, current driver, services, shifts ----------
const vehicleById = (id) => (id ? db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) : null);
const driverName = (id) => { const d = id && db.prepare('SELECT first_name, last_name FROM drivers WHERE id = ?').get(id); return d ? `${d.first_name} ${d.last_name}` : ''; };
const timeOk = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
route('GET', '/api/vehicles/:id/details', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const v = vehicleById(idOf(ctx.params.id));
  if (!v) fail(404, 'خودرو یافت نشد');
  const today = todayISO();
  const cur = db.prepare(`SELECT c.number, c.start_date, c.end_date, c.driver_id FROM contracts c
    WHERE c.vehicle_id = ? AND c.start_date <= ? AND (c.end_date = '' OR c.end_date >= ?) ORDER BY c.start_date DESC, c.id DESC LIMIT 1`).get(v.id, today, today);
  const services = db.prepare('SELECT * FROM vehicle_services WHERE vehicle_id = ? ORDER BY service_date DESC, id DESC LIMIT 200').all(v.id)
    .map((s) => ({ id: s.id, serviceDate: s.service_date, kind: s.kind, odometer: s.odometer || '', note: s.note || '' }));
  const shifts = db.prepare('SELECT * FROM vehicle_shifts WHERE vehicle_id = ? ORDER BY shift_date DESC, id DESC LIMIT 200').all(v.id)
    .map((s) => ({ id: s.id, shiftDate: s.shift_date, startTime: s.start_time || '', endTime: s.end_time || '', driverId: s.driver_id || null, driverName: driverName(s.driver_id), note: s.note || '' }));
  return {
    vehicle: vehicleOut(v),
    supervisionUnit: v.supervision_unit || '',
    currentDriver: cur ? { name: driverName(cur.driver_id), contractNumber: cur.number, from: cur.start_date, to: cur.end_date || '' } : null,
    services, shifts, canEdit: can(ctx.user, 'vehicles', 'edit'), canDelete: can(ctx.user, 'vehicles', 'delete'),
  };
});
route('POST', '/api/vehicles/:id/services', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const v = vehicleById(idOf(ctx.params.id));
  if (!v) fail(404, 'خودرو یافت نشد');
  const b = ctx.body, e = {};
  const serviceDate = String(b.serviceDate ?? '').trim(), kind = String(b.kind ?? '').trim(), odometer = str(b.odometer), note = String(b.note ?? '').trim();
  if (!J.isValidISO(serviceDate)) e.serviceDate = 'تاریخ سرویس معتبر نیست';
  if (kind.length < 2 || kind.length > 100) e.kind = 'نوع سرویس ۲ تا ۱۰۰ نویسه';
  if (odometer && !/^\d{1,9}$/.test(odometer)) e.odometer = 'کیلومتر فقط عدد باشد';
  if (note.length > 500) e.note = 'توضیحات حداکثر ۵۰۰ نویسه';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const r = db.prepare('INSERT INTO vehicle_services (vehicle_id,service_date,kind,odometer,note,created_at) VALUES (?,?,?,?,?,?)').run(v.id, serviceDate, kind, odometer || null, note || null, new Date().toISOString());
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'سرویس خودرو', recordId: r.lastInsertRowid, description: `ثبت سرویس «${kind}» برای ${plateText(vehicleOut(v).plate)}` });
  return [201, { ok: true }];
});
route('DELETE', '/api/vehicles/:id/services/:sid', (ctx) => {
  need(ctx.user, 'vehicles', 'delete');
  const row = db.prepare('SELECT * FROM vehicle_services WHERE id = ? AND vehicle_id = ?').get(idOf(ctx.params.sid), idOf(ctx.params.id));
  if (!row) fail(404, 'سرویس یافت نشد');
  db.prepare('DELETE FROM vehicle_services WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'vehicles', entity: 'سرویس خودرو', recordId: row.id, description: `حذف سرویس «${row.kind}»` });
  return { ok: true };
});
route('POST', '/api/vehicles/:id/shifts', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const v = vehicleById(idOf(ctx.params.id));
  if (!v) fail(404, 'خودرو یافت نشد');
  const b = ctx.body, e = {};
  const shiftDate = String(b.shiftDate ?? '').trim(), startTime = String(b.startTime ?? '').trim(), endTime = String(b.endTime ?? '').trim(), note = String(b.note ?? '').trim();
  const driverId = b.driverId ? idOf(b.driverId) : null;
  if (!J.isValidISO(shiftDate)) e.shiftDate = 'تاریخ شیفت معتبر نیست';
  if (startTime && !timeOk(startTime)) e.startTime = 'ساعت شروع معتبر نیست';
  if (endTime && !timeOk(endTime)) e.endTime = 'ساعت پایان معتبر نیست';
  if (driverId && !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverId)) e.driverId = 'راننده معتبر نیست';
  if (note.length > 500) e.note = 'توضیحات حداکثر ۵۰۰ نویسه';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const r = db.prepare('INSERT INTO vehicle_shifts (vehicle_id,driver_id,shift_date,start_time,end_time,note,created_at) VALUES (?,?,?,?,?,?,?)').run(v.id, driverId, shiftDate, startTime || null, endTime || null, note || null, new Date().toISOString());
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'شیفت خودرو', recordId: r.lastInsertRowid, description: `ثبت شیفت برای ${plateText(vehicleOut(v).plate)} در ${shiftDate}` });
  return [201, { ok: true }];
});
route('DELETE', '/api/vehicles/:id/shifts/:sid', (ctx) => {
  need(ctx.user, 'vehicles', 'delete');
  const row = db.prepare('SELECT * FROM vehicle_shifts WHERE id = ? AND vehicle_id = ?').get(idOf(ctx.params.sid), idOf(ctx.params.id));
  if (!row) fail(404, 'شیفت یافت نشد');
  db.prepare('DELETE FROM vehicle_shifts WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'vehicles', entity: 'شیفت خودرو', recordId: row.id, description: `حذف شیفت ${row.shift_date}` });
  return { ok: true };
});


// ---------- System settings (administrator) ----------
route('GET', '/api/settings', (ctx) => {
  need(ctx.user, 'users', 'edit');
  return { sessionIdleMinutes: L.idleMinutes(), limits: L.SESSION_LIMITS };
});
route('PUT', '/api/settings/session-timeout', (ctx) => {
  need(ctx.user, 'users', 'edit');
  const minutes = Number(ctx.body.minutes);
  const { min, max } = L.SESSION_LIMITS;
  if (!Number.isInteger(minutes) || minutes < min || minutes > max) fail(422, 'اطلاعات نامعتبر است', { minutes: `مدت باید عددی صحیح بین ${min} تا ${max} دقیقه باشد` });
  const before = L.idleMinutes();
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('session_idle_minutes', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(minutes), new Date().toISOString());
  audit(ctx.user, { action: 'update', section: 'users', entity: 'تنظیمات نشست', recordId: null, description: 'تغییر مدت بی‌فعالیتی نشست',
    changes: [{ field: 'مدت بی‌فعالیتی (دقیقه)', from: String(before), to: String(minutes) }] });
  return { sessionIdleMinutes: minutes, limits: L.SESSION_LIMITS };
});


route('PUT', '/api/vehicles/:id/supervision', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const v = vehicleById(idOf(ctx.params.id));
  if (!v) fail(404, 'خودرو یافت نشد');
  const unit = String(ctx.body.supervisionUnit ?? '').trim();
  if (unit.length > 100) fail(422, 'اطلاعات نامعتبر است', { supervisionUnit: 'واحد نظارت حداکثر ۱۰۰ نویسه' });
  const before = v.supervision_unit || '';
  db.prepare('UPDATE vehicles SET supervision_unit = ?, updated_at = ? WHERE id = ?').run(unit || null, new Date().toISOString(), v.id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'واحد نظارت', recordId: v.id, description: `تغییر واحد نظارت ${plateText(vehicleOut(v).plate)}`, changes: [{ field: 'واحد نظارت', from: before || '—', to: unit || '—' }] });
  return { supervisionUnit: unit };
});


// ---------- Vehicle section: overview lists for the sub-pages ----------
route('GET', '/api/vehicle-overview', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const today = todayISO();
  const rows = db.prepare('SELECT * FROM vehicles ORDER BY id DESC LIMIT 1000').all().map((v) => {
    const cur = db.prepare(`SELECT c.number, c.start_date, c.end_date, c.driver_id FROM contracts c
      WHERE c.vehicle_id = ? AND c.start_date <= ? AND (c.end_date = '' OR c.end_date >= ?) ORDER BY c.start_date DESC, c.id DESC LIMIT 1`).get(v.id, today, today);
    return { ...vehicleOut(v), supervisionUnit: v.supervision_unit || '',
      currentDriver: cur ? { name: driverName(cur.driver_id), contractNumber: cur.number, from: cur.start_date, to: cur.end_date || '' } : null };
  });
  return { items: rows, canEdit: can(ctx.user, 'vehicles', 'edit') };
});
route('GET', '/api/vehicle-shifts', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const rows = db.prepare('SELECT s.*, v.plate_a, v.plate_b, v.plate_c, v.plate_d, v.brand, v.model FROM vehicle_shifts s JOIN vehicles v ON v.id = s.vehicle_id ORDER BY s.shift_date DESC, s.id DESC LIMIT 1000').all();
  return { items: rows.map((s) => ({ id: s.id, vehicleId: s.vehicle_id, vehicle: plateText({ a: s.plate_a, b: s.plate_b, c: s.plate_c, d: s.plate_d }), brand: `${s.brand} ${s.model}`, shiftDate: s.shift_date, startTime: s.start_time || '', endTime: s.end_time || '', driverName: driverName(s.driver_id), note: s.note || '' })), canEdit: can(ctx.user, 'vehicles', 'edit'), canDelete: can(ctx.user, 'vehicles', 'delete') };
});
route('GET', '/api/vehicle-services', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const rows = db.prepare('SELECT s.*, v.plate_a, v.plate_b, v.plate_c, v.plate_d, v.brand, v.model FROM vehicle_services s JOIN vehicles v ON v.id = s.vehicle_id ORDER BY s.service_date DESC, s.id DESC LIMIT 1000').all();
  return { items: rows.map((s) => ({ id: s.id, vehicleId: s.vehicle_id, vehicle: plateText({ a: s.plate_a, b: s.plate_b, c: s.plate_c, d: s.plate_d }), brand: `${s.brand} ${s.model}`, serviceDate: s.service_date, kind: s.kind, odometer: s.odometer || '', note: s.note || '' })), canEdit: can(ctx.user, 'vehicles', 'edit'), canDelete: can(ctx.user, 'vehicles', 'delete') };
});


// ---------- Supervision: sites and supervision units ----------
const siteOut = (r) => ({ id: r.id, name: r.name, code: r.code || '', description: r.description || '', active: !!r.active });
const unitOut = (r) => { const site = db.prepare('SELECT name, code FROM sites WHERE id = ?').get(r.site_id) || {}; return { id: r.id, name: r.name, code: r.code || '', siteId: r.site_id, siteName: site.name || '', siteCode: site.code || '', active: !!r.active }; };
function validateSiteFields(b, id) {
  const e = {};
  const name = String(b.name ?? '').trim(), code = String(b.code ?? '').trim();
  const active = b.active === undefined ? true : b.active === true;
  if (name.length < 2 || name.length > 120) e.name = 'نام سایت ۲ تا ۱۲۰ نویسه باشد';
  if (!/^[0-9A-Za-z\-_]{1,20}$/.test(code)) e.code = 'کد سایت را وارد کنید (حرف انگلیسی، عدد، - و _، حداکثر ۲۰ نویسه)';
  if (!e.name && db.prepare('SELECT id FROM sites WHERE name = ? AND id IS NOT ?').get(name, id ?? null)) e.name = 'اطلاعات تکراری است: این سایت قبلاً ثبت شده';
  if (!e.code && db.prepare('SELECT id FROM sites WHERE code = ? AND id IS NOT ?').get(code, id ?? null)) e.code = 'اطلاعات تکراری است: این کد سایت قبلاً ثبت شده';
  return { v: { name, code, description: null, active: active ? 1 : 0 }, e };
}
route('GET', '/api/sites', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const q = normQ(ctx.query.get('q'));
  let rows = db.prepare('SELECT * FROM sites ORDER BY name').all();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  return { items: rows.map(siteOut), canEdit: can(ctx.user, 'vehicles', 'edit') };
});
route('POST', '/api/sites', (ctx) => {
  need(ctx.user, 'vehicles', 'create');
  const { v, e } = validateSiteFields(ctx.body, null);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO sites (name,code,description,active,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(v.name, v.code, v.description, v.active, now, now);
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'سایت', recordId: r.lastInsertRowid, description: `ثبت سایت «${v.name}»` });
  return [201, siteOut(db.prepare('SELECT * FROM sites WHERE id = ?').get(r.lastInsertRowid))];
});
route('PUT', '/api/sites/:id', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  if (!old) fail(404, 'سایت یافت نشد');
  const { v, e } = validateSiteFields(ctx.body, id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare('UPDATE sites SET name=?, code=?, description=?, active=?, updated_at=? WHERE id=?').run(v.name, v.code, v.description, v.active, new Date().toISOString(), id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'سایت', recordId: id, description: `ویرایش سایت «${v.name}»`, changes: [{ field: 'نام سایت', from: old.name, to: v.name }, { field: 'وضعیت', from: old.active ? 'فعال' : 'غیرفعال', to: v.active ? 'فعال' : 'غیرفعال' }] });
  return siteOut(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
});
// Resolves the site of a unit. Existing site (by id, or by code/name) is reused; a new site is only created when none matches.
function resolveUnitSite(b, e) {
  const siteId = idOf(b.siteId);
  if (siteId) {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    if (!site) { e.siteId = 'سایت انتخاب‌شده وجود ندارد'; return null; }
    return { siteId: site.id, site };
  }
  const code = String(b.siteCode ?? '').trim(), name = String(b.siteName ?? '').trim();
  if (!/^[0-9A-Za-z\-_]{1,20}$/.test(code)) e.siteCode = 'کد سایت را وارد کنید (حرف انگلیسی، عدد، - و _)';
  if (name.length < 2 || name.length > 120) e.siteName = 'نام سایت ۲ تا ۱۲۰ نویسه باشد';
  if (e.siteCode || e.siteName) return null;
  const byCode = db.prepare('SELECT * FROM sites WHERE code = ?').get(code);
  const byName = db.prepare('SELECT * FROM sites WHERE name = ?').get(name);
  if (byCode && byName && byCode.id !== byName.id) { e.siteCode = 'این کد و نام متعلق به دو سایت مختلف است'; return null; }
  if (byCode && byCode.name !== name) { e.siteName = `کد سایت متعلق به سایت «${byCode.name}» است`; return null; }
  if (byName && byName.code && byName.code !== code) { e.siteCode = `این سایت قبلاً با کد «${byName.code}» ثبت شده است`; return null; }
  const existing = byCode || byName;
  if (existing) {
    if (!existing.active) { e.siteCode = 'این سایت غیرفعال است و برای واحد جدید قابل استفاده نیست'; return null; }
    return { siteId: existing.id, site: existing };
  }
  return { create: { name, code } };
}
function validateUnitFields(b, id) {
  const e = {};
  const name = String(b.name ?? '').trim(), code = String(b.code ?? '').trim();
  const active = b.active === undefined ? true : (b.active === true || b.active === 'فعال');
  if (name.length < 2 || name.length > 120) e.name = 'نام واحد نظارت ۲ تا ۱۲۰ نویسه باشد';
  if (!/^[0-9A-Za-z\-_]{1,20}$/.test(code)) e.code = 'کد واحد نظارت را وارد کنید (حرف انگلیسی، عدد، - و _، حداکثر ۲۰ نویسه)';
  const site = resolveUnitSite(b, e);
  if (site && site.site && !site.site.active && active) e.siteId = 'سایت انتخاب‌شده غیرفعال است';
  const siteId = site ? (site.siteId ?? null) : null;
  if (!e.name && siteId && db.prepare('SELECT id FROM supervision_units WHERE site_id = ? AND name = ? AND id IS NOT ?').get(siteId, name, id ?? null)) e.name = 'اطلاعات تکراری است: این واحد نظارت برای این سایت قبلاً ثبت شده';
  if (!e.code && siteId && db.prepare('SELECT id FROM supervision_units WHERE site_id = ? AND code = ? AND id IS NOT ?').get(siteId, code, id ?? null)) e.code = 'اطلاعات تکراری است: این کد واحد نظارت برای این سایت قبلاً ثبت شده';
  return { v: { name, code, siteId, create: site && site.create ? site.create : null, description: null, active: active ? 1 : 0 }, e };
}
route('GET', '/api/supervision-units', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const q = normQ(ctx.query.get('q')), siteId = idOf(ctx.query.get('siteId'));
  let rows = db.prepare('SELECT * FROM supervision_units ORDER BY name').all();
  if (siteId) rows = rows.filter((r) => r.site_id === siteId);
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  return { items: rows.map(unitOut), canEdit: can(ctx.user, 'vehicles', 'edit') };
});
route('POST', '/api/supervision-units', (ctx) => {
  need(ctx.user, 'vehicles', 'create');
  const { v, e } = validateUnitFields(ctx.body, null);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const siteId = v.siteId ?? db.prepare('INSERT INTO sites (name,code,description,active,created_at,updated_at) VALUES (?,?,NULL,1,?,?)').run(v.create.name, v.create.code, now, now).lastInsertRowid;
  const r = db.prepare('INSERT INTO supervision_units (name,code,site_id,description,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(v.name, v.code, siteId, null, v.active, now, now);
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'واحد نظارت', recordId: r.lastInsertRowid, description: `ثبت واحد نظارت «${v.name}»` });
  return [201, unitOut(db.prepare('SELECT * FROM supervision_units WHERE id = ?').get(r.lastInsertRowid))];
});
route('PUT', '/api/supervision-units/:id', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM supervision_units WHERE id = ?').get(id);
  if (!old) fail(404, 'واحد نظارت یافت نشد');
  const { v, e } = validateUnitFields(ctx.body, id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const siteId = v.siteId ?? db.prepare('INSERT INTO sites (name,code,description,active,created_at,updated_at) VALUES (?,?,NULL,1,?,?)').run(v.create.name, v.create.code, new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  db.prepare('UPDATE supervision_units SET name=?, code=?, site_id=?, active=?, updated_at=? WHERE id=?').run(v.name, v.code, siteId, v.active, new Date().toISOString(), id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'واحد نظارت', recordId: id, description: `ویرایش واحد نظارت «${v.name}»` });
  return unitOut(db.prepare('SELECT * FROM supervision_units WHERE id = ?').get(id));
});
// Options for the company form: only active sites and active units, read-only
route('GET', '/api/supervision-options', (ctx) => {
  const ok = ['companies', 'contracts'].some((sec) => ['view', 'create', 'edit'].some((a) => can(ctx.user, sec, a)));
  if (!ok) fail(403, 'دسترسی لازم برای این عملیات را ندارید');
  return {
    sites: db.prepare('SELECT id, name FROM sites WHERE active = 1 ORDER BY name').all().map((r) => ({ id: r.id, name: r.name })),
    units: db.prepare('SELECT id, name, site_id FROM supervision_units WHERE active = 1 ORDER BY name').all().map((r) => ({ id: r.id, name: r.name, siteId: r.site_id })),
  };
});


// ---------- Service plans: six-step wizard ----------
const SP = {
  regions: ['تهران', 'کرج'], routeTypes: ['رفت', 'برگشت'], genders: ['مرد', 'زن'],
  returnServices: ['سرویس عادی', 'سرویس ویژه'], directions: ['دوطرفه', 'فقط رفت', 'فقط برگشت'],
  serviceTypes: ['ایاب و ذهاب سبک پرسنل', 'ایاب و ذهاب سنگین پرسنل'],
  calcTypes: { per_service: 'به ازای هر سرویس', fixed_monthly: 'ثابت ماهانه' },
};
// A station point is a Google-free pair of coordinates inside Iran's borders, or null when not set.
function pointOf(p) {
  if (!p) return null;
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < 25 || lat > 40 || lng < 44 || lng > 64) return false;
  return { lat, lng };
}
const hhmm = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const intOr = (v) => (v === '' || v === null || v === undefined ? NaN : Number(String(v).replace(/,/g, '')));
function validateServicePlan(b) {
  const e = {};
  const code = String(b.code ?? '').trim(), name = String(b.name ?? '').trim(), startDate = String(b.startDate ?? '').trim();
  if (!/^[0-9A-Za-z\-_]{1,20}$/.test(code)) e.code = 'کد را وارد کنید (حرف انگلیسی، عدد، - و _)';
  if (name.length < 2 || name.length > 150) e.name = 'نام ۲ تا ۱۵۰ نویسه باشد';
  if (!J.isValidISO(startDate)) e.startDate = 'تاریخ شروع معتبر نیست';
  const siteId = idOf(b.siteId);
  if (!siteId || !db.prepare('SELECT id FROM sites WHERE id = ? AND active = 1').get(siteId)) e.siteId = 'سایت را از فهرست فعال انتخاب کنید';
  const unitId = idOf(b.supervisionUnitId);
  const unit = unitId && db.prepare('SELECT site_id, active FROM supervision_units WHERE id = ?').get(unitId);
  if (!unit || !unit.active) e.supervisionUnitId = 'واحد نظارت را انتخاب کنید';
  else if (unit.site_id !== siteId) e.supervisionUnitId = 'این واحد نظارت متعلق به سایت انتخاب‌شده نیست';
  const region = String(b.region ?? ''), routeType = String(b.routeType ?? ''), gender = String(b.gender ?? '');
  const returnService = String(b.returnService ?? ''), direction = String(b.directionStatus ?? '');
  if (!SP.regions.includes(region)) e.region = 'ناحیه را انتخاب کنید';
  if (!SP.routeTypes.includes(routeType)) e.routeType = 'نوع مسیر را انتخاب کنید';
  if (!SP.genders.includes(gender)) e.gender = 'جنسیت را انتخاب کنید';
  if (!SP.returnServices.includes(returnService)) e.returnService = 'نوع سرویس برگشت را انتخاب کنید';
  if (!SP.directions.includes(direction)) e.directionStatus = 'وضعیت رفت و برگشت را انتخاب کنید';
  const vehicleGroup = String(b.vehicleGroup ?? '');
  if (!REF.CATEGORIES[vehicleGroup]) e.vehicleGroup = 'گروه خودرو را انتخاب کنید';
  let vehicleClass = String(b.vehicleClass ?? '');
  if (vehicleGroup === 'سواری') { if (!REF.CATEGORIES['سواری'].includes(vehicleClass)) e.vehicleClass = 'کلاس خودرو را انتخاب کنید'; }
  else vehicleClass = '';
  const minutes = intOr(b.allowedMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) e.allowedMinutes = 'زمان مجاز بین ۱ تا ۱۴۴۰ دقیقه باشد';
  const serviceType = String(b.serviceType ?? '');
  if (!SP.serviceTypes.includes(serviceType)) e.serviceType = 'نوع سرویس را انتخاب کنید';
  const serviceNumber = String(b.serviceNumber ?? '').trim();
  if (!/^[0-9A-Za-z\-\/]{1,30}$/.test(serviceNumber)) e.serviceNumber = 'شماره سرویس را وارد کنید (حداکثر ۳۰ نویسه)';
  const shiftName = String(b.shiftName ?? '').trim();
  if (shiftName.length > 200) e.shiftName = 'شیفت انتخاب‌شده نامعتبر است';
  const shiftId = b.shiftId ? idOf(b.shiftId) : null;
  if (shiftId && !db.prepare('SELECT id FROM vehicle_shifts WHERE id = ?').get(shiftId)) e.shiftId = 'شیفت انتخاب‌شده در سامانه وجود ندارد';
  // Step 3: routes
  const routes = Array.isArray(b.routes) ? b.routes : [];
  if (!routes.length) e.routes = 'حداقل یک مسیر وارد کنید';
  const routeRows = routes.slice(0, 50).map((r, i) => {
    const row = { origin: String(r.origin ?? '').trim(), destination: String(r.destination ?? '').trim(), description: String(r.description ?? '').trim(), km: intOr(r.km), startTime: String(r.startTime ?? '').trim(), endTime: String(r.endTime ?? '').trim(), originPoint: pointOf(r.originPoint), destinationPoint: pointOf(r.destinationPoint) };
    if (row.originPoint === false || row.destinationPoint === false) e.routes = `مسیر ${i + 1}: موقعیت ایستگاه روی نقشه معتبر نیست`;
    if (row.description.length > 200) e.routes = `مسیر ${i + 1}: شرح مسیر حداکثر ۲۰۰ نویسه`;
    if (row.origin.length < 2 || row.destination.length < 2) e.routes = `مسیر ${i + 1}: مبدأ و مقصد را وارد کنید`;
    if (!Number.isFinite(row.km) || row.km < 0 || row.km > 100000) e.routes = `مسیر ${i + 1}: کیلومتر معتبر نیست`;
    if (!hhmm(row.startTime) || !hhmm(row.endTime)) e.routes = `مسیر ${i + 1}: ساعت شروع و پایان را وارد کنید`;
    else if (row.endTime <= row.startTime) e.routes = `مسیر ${i + 1}: ساعت پایان باید بعد از ساعت شروع باشد`;
    return row;
  });
  // Step 4: passengers (optional)
  const passengers = (Array.isArray(b.passengers) ? b.passengers : []).slice(0, 500).map((p, i) => {
    const row = { name: String(p.name ?? '').trim(), boarding: String(p.boarding ?? '').trim(), alighting: String(p.alighting ?? '').trim(), startDate: String(p.startDate ?? '').trim(), startTime: String(p.startTime ?? '').trim(), endDate: String(p.endDate ?? '').trim(), endTime: String(p.endTime ?? '').trim() };
    if (row.name.length < 2) e.passengers = `مسافر ${i + 1}: نام را وارد کنید`;
    else if (!row.boarding || !row.alighting) e.passengers = `مسافر ${i + 1}: ایستگاه سوار و پیاده شدن را وارد کنید`;
    else if (!J.isValidISO(row.startDate) || !J.isValidISO(row.endDate) || !hhmm(row.startTime) || !hhmm(row.endTime)) e.passengers = `مسافر ${i + 1}: تاریخ و زمان شروع و پایان را وارد کنید`;
    else if (`${row.endDate} ${row.endTime}` < `${row.startDate} ${row.startTime}`) e.passengers = `مسافر ${i + 1}: پایان قبل از شروع است`;
    return row;
  });
  // Step 5: vehicle rate (optional, but if given it must be complete)
  let vehicleRate = null;
  if (b.vehicleRate) {
    const vid = idOf(b.vehicleRate.vehicleId), fee = intOr(b.vehicleRate.fee);
    const rateNotes = String(b.vehicleRate.notes ?? '').trim();
    if (rateNotes.length > 300) e.vehicleRate = 'توضیحات نرخ حداکثر ۳۰۰ نویسه';
    if (!vid || !db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vid)) e.vehicleRate = 'خودرو را از فهرست انتخاب کنید';
    else if (!Number.isInteger(fee) || fee < 0 || fee > 1e12) e.vehicleRate = 'فی را به عدد صحیح (تومان) وارد کنید';
    else vehicleRate = { vehicleId: vid, fee, notes: rateNotes, snapshot: vehicleSnapshot(vid) };
  }
  // Step 6: company rate (optional)
  let companyRate = null;
  if (b.companyRate) {
    const calc = String(b.companyRate.calcType ?? ''), amount = intOr(b.companyRate.amount);
    if (!SP.calcTypes[calc]) e.companyRate = 'نوع محاسبه را انتخاب کنید';
    else if (!Number.isInteger(amount) || amount < 0 || amount > 1e12) e.companyRate = 'مبلغ را به عدد صحیح (تومان) وارد کنید';
    else companyRate = { calcType: calc, amount };
  }
  return { v: { serviceType, code, name, startDate, siteId, supervisionUnitId: unitId, region, routeType, gender, returnService, directionStatus: direction, vehicleGroup, vehicleClass, allowedMinutes: minutes, serviceNumber, shiftId, shiftName: shiftName || null, routes: routeRows, passengers, vehicleRate, companyRate }, e };
}
// Snapshot of the vehicle and its active contract, taken when the rate is saved.
function vehicleSnapshot(vehicleId) {
  const v = vehicleById(vehicleId);
  if (!v) return null;
  const today = todayISO();
  const c = db.prepare(`SELECT c.*, co.name AS company_name FROM contracts c JOIN companies co ON co.id = c.company_id
    WHERE c.vehicle_id = ? AND c.start_date <= ? AND (c.end_date = '' OR c.end_date >= ?) ORDER BY c.start_date DESC, c.id DESC LIMIT 1`).get(v.id, today, today);
  const d = c ? db.prepare('SELECT first_name, last_name, nid FROM drivers WHERE id = ?').get(c.driver_id) : null;
  return {
    plate: plateText(vehicleOut(v).plate), category: v.category, cls: v.cls || '', capacity: v.capacity, brand: v.brand, model: v.model,
    driverName: d ? `${d.first_name} ${d.last_name}` : '', driverNid: d ? d.nid : '',
    contractStart: c ? c.start_date : '', contractEnd: c ? (c.end_date || '') : '', contractor: c ? c.company_name : '',
  };
}
const planOut = (r) => ({
  id: r.id, serviceType: r.service_type, code: r.code, name: r.name, startDate: r.start_date, siteId: r.site_id, supervisionUnitId: r.supervision_unit_id, siteName: db.prepare('SELECT name FROM sites WHERE id = ?').get(r.site_id)?.name || '',
  unitName: db.prepare('SELECT name FROM supervision_units WHERE id = ?').get(r.supervision_unit_id)?.name || '',
  region: r.region, routeType: r.route_type, gender: r.gender, returnService: r.return_service, vehicleGroup: r.vehicle_group, vehicleClass: r.vehicle_class,
  allowedMinutes: r.allowed_minutes, serviceNumber: r.service_number, directionStatus: r.direction_status, shiftName: r.shift_name || '',
  routes: JSON.parse(r.routes_json || '[]'), passengers: JSON.parse(r.passengers_json || '[]'),
  vehicleRate: r.vehicle_rate_json ? JSON.parse(r.vehicle_rate_json) : null, companyRate: r.company_rate_json ? JSON.parse(r.company_rate_json) : null,
  shiftId: r.shift_id || null, createdAt: r.created_at,
});
// Distance and travel time between two station points, from the Neshan routing service.
// The key is read from the server environment (NESHAN_API_KEY); nothing is calculated without it.
// Neshan routing (Routing API, v4, car). Documented: GET {base}/v4/direction?type=car&origin=lat,lng&destination=lat,lng
// with the header "Api-Key". Errors come back as the HTTP status (470 bad coordinates, 480 key, 481 limit, 482 rate, 483 key type, 484/485 scope, 500 generic).
const NESHAN_ERRORS = {
  470: 'مختصات ایستگاه‌ها معتبر نیست', 480: 'کلید نقشه نشان نامعتبر است یا ارسال نشده است', 481: 'سقف استفاده از سرویس نشان تمام شده است',
  482: 'تعداد درخواست در دقیقه از حد مجاز گذشته است', 483: 'کلید نقشه نشان برای این سرویس مناسب نیست', 484: 'این کلید اجازه استفاده از سرویس را ندارد',
  485: 'این کلید برای سرویس مسیریابی تعریف نشده است', 500: 'خطای سرویس نشان',
};
route('POST', '/api/routes/estimate', async (ctx) => {
  need(ctx.user, 'vehicles', 'create');
  const o = pointOf(ctx.body.origin), d = pointOf(ctx.body.destination);
  if (!o || !d) fail(422, 'اطلاعات نامعتبر است', { origin: 'ایستگاه سوار شدن و پیاده شدن را روی نقشه (داخل ایران) مشخص کنید' });
  const key = process.env.NESHAN_API_KEY;
  if (!key) fail(503, 'محاسبه خودکار مسیر فعال نیست: کلید نقشه نشان (NESHAN_API_KEY) روی سرور تنظیم نشده است. مسافت و زمان را دستی وارد کنید.');
  const base = (process.env.NESHAN_BASE_URL || 'https://api.neshan.org').replace(/\/$/, '');
  const url = `${base}/v4/direction?type=car&origin=${o.lat},${o.lng}&destination=${d.lat},${d.lng}`;
  let res;
  try { res = await fetch(url, { headers: { 'Api-Key': key }, signal: AbortSignal.timeout(10000) }); }
  catch { fail(502, 'اتصال به سرویس نقشه نشان برقرار نشد. مسافت و زمان را دستی وارد کنید.'); }
  if (!res.ok) fail(502, NESHAN_ERRORS[res.status] || `سرویس نشان خطا برگرداند (کد ${res.status})`);
  let data;
  try { data = await res.json(); } catch { fail(502, 'پاسخ سرویس نشان قابل خواندن نیست'); }
  const legs = data && Array.isArray(data.routes) && data.routes[0] && Array.isArray(data.routes[0].legs) ? data.routes[0].legs : [];
  const valid = legs.length && legs.every((l) => l && l.distance && Number.isFinite(l.distance.value) && l.duration && Number.isFinite(l.duration.value));
  if (!valid) fail(502, 'مسیری بین این دو ایستگاه پیدا نشد');
  const meters = legs.reduce((sum, l) => sum + l.distance.value, 0), seconds = legs.reduce((sum, l) => sum + l.duration.value, 0);
  return { km: Math.round(meters / 100) / 10, minutes: Math.round(seconds / 60), source: 'neshan' };
});
route('GET', '/api/service-plan-options', () => ({ serviceTypes: SP.serviceTypes, regions: SP.regions, routeTypes: SP.routeTypes, genders: SP.genders, returnServices: SP.returnServices, directions: SP.directions, calcTypes: Object.entries(SP.calcTypes).map(([k, l]) => ({ value: k, label: l })), categories: Object.entries(REF.CATEGORIES).map(([k, cls]) => ({ value: k, classes: cls })) }));
route('GET', '/api/vehicles/:id/contract-info', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const id = idOf(ctx.params.id);
  if (!vehicleById(id)) fail(404, 'خودرو یافت نشد');
  return vehicleSnapshot(id);
});
route('PUT', '/api/service-plans/:id', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const old = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(idOf(ctx.params.id));
  if (!old) fail(404, 'سرویس یافت نشد');
  const { v, e } = validateServicePlan(ctx.body);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare(`UPDATE service_plans SET service_type=?,code=?,name=?,start_date=?,site_id=?,supervision_unit_id=?,region=?,route_type=?,gender=?,return_service=?,vehicle_group=?,vehicle_class=?,allowed_minutes=?,service_number=?,direction_status=?,shift_name=?,shift_id=?,routes_json=?,passengers_json=?,vehicle_rate_json=?,company_rate_json=?,updated_at=? WHERE id=?`)
    .run(v.serviceType, v.code, v.name, v.startDate, v.siteId, v.supervisionUnitId, v.region, v.routeType, v.gender, v.returnService, v.vehicleGroup, v.vehicleClass, v.allowedMinutes, v.serviceNumber, v.directionStatus, v.shiftName, v.shiftId,
      JSON.stringify(v.routes), JSON.stringify(v.passengers), v.vehicleRate ? JSON.stringify(v.vehicleRate) : null, v.companyRate ? JSON.stringify(v.companyRate) : null, new Date().toISOString(), old.id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'سرویس', recordId: old.id, description: `ویرایش سرویس «${v.name}» (${v.code})`, changes: [{ field: 'نام سرویس', from: old.name, to: v.name }] });
  return planOut(db.prepare('SELECT * FROM service_plans WHERE id = ?').get(old.id));
});
route('DELETE', '/api/service-plans/:id', (ctx) => {
  need(ctx.user, 'vehicles', 'delete');
  const row = db.prepare('SELECT * FROM service_plans WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'سرویس یافت نشد');
  db.prepare('DELETE FROM service_plans WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'vehicles', entity: 'سرویس', recordId: row.id, description: `حذف سرویس «${row.name}» (${row.code})` });
  return { ok: true };
});
route('GET', '/api/service-plans', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  return { items: db.prepare('SELECT * FROM service_plans ORDER BY id DESC LIMIT 500').all().map(planOut), canCreate: can(ctx.user, 'vehicles', 'create'), canEdit: can(ctx.user, 'vehicles', 'edit') };
});
route('POST', '/api/service-plans', (ctx) => {
  need(ctx.user, 'vehicles', 'create');
  const { v, e } = validateServicePlan(ctx.body);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare(`INSERT INTO service_plans (service_type,code,name,start_date,site_id,supervision_unit_id,region,route_type,gender,return_service,vehicle_group,vehicle_class,allowed_minutes,service_number,direction_status,shift_name,shift_id,routes_json,passengers_json,vehicle_rate_json,company_rate_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.serviceType, v.code, v.name, v.startDate, v.siteId, v.supervisionUnitId, v.region, v.routeType, v.gender, v.returnService, v.vehicleGroup, v.vehicleClass, v.allowedMinutes, v.serviceNumber, v.directionStatus, v.shiftName, v.shiftId,
    JSON.stringify(v.routes), JSON.stringify(v.passengers), v.vehicleRate ? JSON.stringify(v.vehicleRate) : null, v.companyRate ? JSON.stringify(v.companyRate) : null, ctx.user.id, now, now);
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'سرویس', recordId: r.lastInsertRowid, description: `ثبت سرویس «${v.name}» (${v.code})` });
  return [201, planOut(db.prepare('SELECT * FROM service_plans WHERE id = ?').get(r.lastInsertRowid))];
});


// ---------- Fixed services: trips, approval and driver positions ----------
const TRIP_STATUS = { pending: 'در انتظار تایید', approved: 'تایید شده', rejected: 'رد شده', started: 'در حال سفر', finished: 'پایان یافته' };
const GPS_MIN_INTERVAL_MS = 1000, GPS_STALE_MS = 5 * 60000;
const IRAN = { minLat: 25, maxLat: 40, minLng: 44, maxLng: 64 };
route('GET', '/api/trips', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const status = ctx.query.get('status') || '';
  let rows = db.prepare(`SELECT t.*, p.name AS plan_name, p.code AS plan_code, p.service_type, p.routes_json FROM trips t JOIN service_plans p ON p.id = t.service_plan_id ORDER BY t.trip_date DESC, t.id DESC LIMIT 1000`).all();
  if (status && TRIP_STATUS[status]) rows = rows.filter((t) => t.status === status);
  return { items: rows.map((t) => ({ id: t.id, planId: t.service_plan_id, planName: t.plan_name, planCode: t.plan_code, serviceType: t.service_type, tripDate: t.trip_date, status: t.status, statusLabel: TRIP_STATUS[t.status], createdBy: ownUserName(t.created_by) })), canApprove: can(ctx.user, 'vehicles', 'edit'), canCreate: can(ctx.user, 'vehicles', 'create') };
});
route('POST', '/api/service-plans/:id/trips', (ctx) => {
  need(ctx.user, 'vehicles', 'create');
  const plan = db.prepare('SELECT id FROM service_plans WHERE id = ?').get(idOf(ctx.params.id));
  if (!plan) fail(404, 'سرویس یافت نشد');
  const tripDate = String(ctx.body.tripDate ?? '').trim();
  if (!J.isValidISO(tripDate)) fail(422, 'اطلاعات نامعتبر است', { tripDate: 'تاریخ سفر معتبر نیست' });
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO trips (service_plan_id,trip_date,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(plan.id, tripDate, 'pending', ctx.user.id, now, now);
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'سفر', recordId: r.lastInsertRowid, description: `ثبت سفر ${tripDate} برای سرویس ${plan.id}` });
  return [201, { id: r.lastInsertRowid }];
});
route('PUT', '/api/trips/:id/start', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const t = db.prepare('SELECT * FROM trips WHERE id = ?').get(idOf(ctx.params.id));
  if (!t) fail(404, 'سفر یافت نشد');
  if (t.status !== 'approved') fail(422, 'فقط سفر تاییدشده را می‌توان شروع کرد');
  const driverId = idOf(ctx.body.driverId);
  if (!driverId || !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverId)) fail(422, 'اطلاعات نامعتبر است', { driverId: 'راننده را انتخاب کنید' });
  const now = new Date().toISOString();
  db.prepare("UPDATE trips SET status = 'started', driver_id = ?, started_at = ?, updated_at = ? WHERE id = ?").run(driverId, now, now, t.id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'سفر', recordId: t.id, description: 'شروع سفر و فعال‌شدن ردیابی راننده' });
  return { ok: true };
});
route('PUT', '/api/trips/:id/finish', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const t = db.prepare('SELECT * FROM trips WHERE id = ?').get(idOf(ctx.params.id));
  if (!t) fail(404, 'سفر یافت نشد');
  if (t.status !== 'started') fail(422, 'این سفر در حال انجام نیست');
  const now = new Date().toISOString();
  db.prepare("UPDATE trips SET status = 'finished', ended_at = ?, updated_at = ? WHERE id = ?").run(now, now, t.id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'سفر', recordId: t.id, description: 'پایان سفر و توقف ردیابی راننده' });
  return { ok: true };
});
route('PUT', '/api/trips/:id/status', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const t = db.prepare('SELECT * FROM trips WHERE id = ?').get(idOf(ctx.params.id));
  if (!t) fail(404, 'سفر یافت نشد');
  const status = String(ctx.body.status ?? '');
  if (!['approved', 'rejected'].includes(status)) fail(422, 'وضعیت نامعتبر است', { status: 'فقط تایید یا رد مجاز است' });
  if (t.status !== 'pending') fail(422, 'این سفر قبلاً بررسی شده است');
  db.prepare('UPDATE trips SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), t.id);
  audit(ctx.user, { action: 'update', section: 'vehicles', entity: 'سفر', recordId: t.id, description: `تغییر وضعیت سفر به ${TRIP_STATUS[status]}`, changes: [{ field: 'وضعیت', from: TRIP_STATUS[t.status], to: TRIP_STATUS[status] }] });
  return { ok: true };
});
route('POST', '/api/locations', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const driverId = idOf(ctx.body.driverId);
  const lat = Number(ctx.body.lat), lng = Number(ctx.body.lng), accuracy = ctx.body.accuracy === undefined ? null : Number(ctx.body.accuracy);
  const e = {};
  if (!driverId || !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverId)) e.driverId = 'راننده معتبر نیست';
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) e.lat = 'مختصات معتبر نیست';
  else if (lat < IRAN.minLat || lat > IRAN.maxLat || lng < IRAN.minLng || lng > IRAN.maxLng) e.lat = 'موقعیت خارج از مرز ایران است و ثبت نمی‌شود';
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) e.accuracy = 'دقت نامعتبر است';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare('INSERT INTO driver_locations (driver_id,lat,lng,accuracy,recorded_at) VALUES (?,?,?,?,?)').run(driverId, lat, lng, accuracy, new Date().toISOString());
  return [201, { ok: true }];
});
route('GET', '/api/locations/latest', (ctx) => {
  need(ctx.user, 'vehicles', 'view');
  const rows = db.prepare(`SELECT l.* FROM driver_locations l JOIN (SELECT driver_id, MAX(id) AS mid FROM driver_locations GROUP BY driver_id) m ON m.mid = l.id ORDER BY l.recorded_at DESC LIMIT 500`).all();
  const now = Date.now();
  return { items: rows.map((l) => ({ driverId: l.driver_id, driverName: driverName(l.driver_id), lat: l.lat, lng: l.lng, accuracy: l.accuracy, recordedAt: l.recorded_at, stale: now - Date.parse(l.recorded_at) > GPS_STALE_MS })), bounds: IRAN, staleAfterMinutes: GPS_STALE_MS / 60000 };
});


// ---------- Driver GPS: private tracking link per driver ----------
route('POST', '/api/drivers/:id/tracking-link', (ctx) => {
  need(ctx.user, 'vehicles', 'edit');
  const driver = db.prepare('SELECT id, first_name, last_name FROM drivers WHERE id = ?').get(idOf(ctx.params.id));
  if (!driver) fail(404, 'راننده یافت نشد');
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  db.prepare('UPDATE driver_tracking_tokens SET revoked = 1 WHERE driver_id = ? AND revoked = 0').run(driver.id);
  db.prepare('INSERT INTO driver_tracking_tokens (driver_id, token_hash, created_at, revoked) VALUES (?,?,?,0)').run(driver.id, crypto.createHash('sha256').update(token).digest('hex'), now);
  audit(ctx.user, { action: 'create', section: 'vehicles', entity: 'لینک ردیابی راننده', recordId: driver.id, description: `ایجاد لینک ردیابی برای ${driver.first_name} ${driver.last_name}` });
  return [201, { driverName: `${driver.first_name} ${driver.last_name}`, url: `/track.html#${token}`, note: 'این لینک فقط یک‌بار نمایش داده می‌شود. لینک قبلی این راننده باطل شد.' }];
});
// Public status check for a tracking link: 200 when a trip is started for its driver, 409 otherwise.
route('GET', '/api/driver-track/status', (ctx) => {
  const token = String(ctx.query.get('token') || '');
  if (!/^[A-Za-z0-9_\-]{20,80}$/.test(token)) fail(401, 'لینک ردیابی معتبر نیست');
  const row = db.prepare('SELECT driver_id FROM driver_tracking_tokens WHERE token_hash = ? AND revoked = 0').get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!row) fail(401, 'لینک ردیابی معتبر نیست یا باطل شده است');
  const trip = db.prepare("SELECT id FROM trips WHERE driver_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1").get(row.driver_id);
  if (!trip) fail(409, 'سفر فعالی برای این راننده نیست');
  return { active: true };
}, { auth: false });
route('POST', '/api/driver-track', (ctx) => {
  // Public on purpose: the only credential is the driver's private token. It can record one position and nothing else.
  const token = String(ctx.body.token ?? '');
  if (!/^[A-Za-z0-9_\-]{20,80}$/.test(token)) fail(401, 'لینک ردیابی معتبر نیست');
  const row = db.prepare('SELECT driver_id FROM driver_tracking_tokens WHERE token_hash = ? AND revoked = 0').get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!row) fail(401, 'لینک ردیابی معتبر نیست یا باطل شده است');
  const trip = db.prepare("SELECT id FROM trips WHERE driver_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1").get(row.driver_id);
  if (!trip) fail(409, 'سفر فعالی برای این راننده نیست؛ ارسال موقعیت متوقف است');
  const lat = Number(ctx.body.lat), lng = Number(ctx.body.lng), accuracy = ctx.body.accuracy === undefined ? null : Number(ctx.body.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) fail(422, 'موقعیت دریافت نشد');
  if (lat < IRAN.minLat || lat > IRAN.maxLat || lng < IRAN.minLng || lng > IRAN.maxLng) fail(422, 'موقعیت خارج از مرز ایران است و ثبت نمی‌شود');
  const last = db.prepare('SELECT recorded_at FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(row.driver_id);
  if (last && Date.now() - Date.parse(last.recorded_at) < GPS_MIN_INTERVAL_MS) fail(429, 'موقعیت خیلی زود دوباره ارسال شده است');
  // A position queued while offline keeps its own time, if that time is within the last 24 hours and not in the future.
  const now = Date.now();
  const at = Number(ctx.body.at);
  const recordedMs = Number.isFinite(at) && at <= now && at >= now - 86400000 ? at : now;
  db.prepare('INSERT INTO driver_locations (driver_id,trip_id,lat,lng,accuracy,recorded_at) VALUES (?,?,?,?,?,?)').run(row.driver_id, trip.id, lat, lng, accuracy !== null && Number.isFinite(accuracy) ? accuracy : null, new Date(recordedMs).toISOString());
  return [201, { ok: true }];
}, { auth: false });


// ---------- Driver accounts: self-registration (pending approval), own status, own positions ----------
const activeTripOf = (driverId) => db.prepare(`SELECT t.id, t.started_at, p.name AS plan_name, p.code AS plan_code FROM trips t JOIN service_plans p ON p.id = t.service_plan_id
  WHERE t.driver_id = ? AND t.status = 'started' ORDER BY t.started_at DESC LIMIT 1`).get(driverId);
const needDriver = (ctx) => { if (!ctx.user || !ctx.user.driverId) fail(403, 'این بخش فقط برای حساب راننده است'); return ctx.user.driverId; };
route('POST', '/api/driver-signup', (ctx) => {
  const b = ctx.body, e = {};
  const first = String(b.first ?? '').trim(), last = String(b.last ?? '').trim(), nid = String(b.nid ?? '').trim();
  const mobile = String(b.mobile ?? '').trim(), gender = String(b.gender ?? ''), password = String(b.password ?? '');
  if (!isPersianName(first)) e.first = 'نام را با حروف فارسی وارد کنید';
  if (!isPersianName(last)) e.last = 'نام خانوادگی را با حروف فارسی وارد کنید';
  if (!validNID(nid)) e.nid = 'کد ملی معتبر نیست';
  if (!/^09\d{9}$/.test(mobile)) e.mobile = 'شماره موبایل معتبر نیست (مثلاً 09121234567)';
  if (!['مرد', 'زن'].includes(gender)) e.gender = 'جنسیت را انتخاب کنید';
  if (password.length < 8 || password.length > 100) e.password = 'رمز عبور باید بین ۸ تا ۱۰۰ نویسه باشد';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const taken = 'اطلاعات تکراری است: این کد ملی قبلاً ثبت‌نام کرده است';
  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(nid)) fail(409, taken);
  let driver = db.prepare('SELECT * FROM drivers WHERE nid = ?').get(nid);
  if (driver && db.prepare('SELECT id FROM users WHERE driver_id = ?').get(driver.id)) fail(409, taken);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const driverId = driver ? driver.id : db.prepare('INSERT INTO drivers (first_name,last_name,nid,mobile,gender,start_date,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?)').run(first, last, nid, mobile, gender, now, now).lastInsertRowid;
    db.prepare("INSERT INTO users (username,name,pass_hash,role,active,is_root,department_id,created_at,driver_id) VALUES (?,?,?,?,0,0,NULL,?,?)")
      .run(nid, `${first} ${last}`, require('./crypto').hashPassword(password), 'راننده', now, driverId);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  audit({ id: null, username: nid, role: 'راننده' }, { action: 'create', section: 'users', entity: 'ثبت‌نام راننده', description: `ثبت‌نام راننده ${first} ${last} (در انتظار تایید مدیر)`, outcome: 'موفق' });
  return [201, { pending: true, message: 'ثبت‌نام انجام شد. پس از تایید مدیر سامانه می‌توانید وارد شوید.' }];
}, { auth: false });
route('GET', '/api/driver/me', (ctx) => {
  const id = needDriver(ctx);
  const d = db.prepare('SELECT first_name, last_name FROM drivers WHERE id = ?').get(id);
  const t = activeTripOf(id);
  return { name: d ? `${d.first_name} ${d.last_name}` : '', trip: t ? { id: t.id, planName: t.plan_name, planCode: t.plan_code, startedAt: t.started_at } : null, minIntervalMs: GPS_MIN_INTERVAL_MS };
});
route('POST', '/api/driver/location', (ctx) => {
  const id = needDriver(ctx);
  const trip = activeTripOf(id);
  if (!trip) fail(409, 'سفر فعالی برای شما نیست؛ ارسال موقعیت متوقف است');
  const lat = Number(ctx.body.lat), lng = Number(ctx.body.lng), accuracy = ctx.body.accuracy === undefined ? null : Number(ctx.body.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) fail(422, 'موقعیت دریافت نشد');
  if (lat < IRAN.minLat || lat > IRAN.maxLat || lng < IRAN.minLng || lng > IRAN.maxLng) fail(422, 'موقعیت خارج از مرز ایران است و ثبت نمی‌شود');
  const last = db.prepare('SELECT recorded_at FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(id);
  if (last && Date.now() - Date.parse(last.recorded_at) < GPS_MIN_INTERVAL_MS) fail(429, 'موقعیت خیلی زود دوباره ارسال شده است');
  const now = Date.now(), at = Number(ctx.body.at);
  const recordedMs = Number.isFinite(at) && at <= now && at >= now - 86400000 ? at : now;
  db.prepare('INSERT INTO driver_locations (driver_id,trip_id,lat,lng,accuracy,recorded_at) VALUES (?,?,?,?,?,?)').run(id, trip.id, lat, lng, accuracy !== null && Number.isFinite(accuracy) ? accuracy : null, new Date(recordedMs).toISOString());
  return [201, { ok: true, serverTime: new Date().toISOString() }];
});


// ---------- Personnel files (phase 1) ----------
// Access: a user with personnel.view sees every file; any other user sees only the file linked to their own account.
const personnelVisible = (u, id) => can(u, 'personnel', 'view') || (!!u.personnelId && u.personnelId === id);
const personnelOut = (p) => ({
  id: p.id, firstName: p.first_name, lastName: p.last_name, nationalId: p.national_id || '', personnelCode: p.personnel_code || '',
  position: p.position || '', unitId: p.department_id || null, unitName: p.department_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(p.department_id)?.name || '') : '',
  mobile: p.mobile || '', phone: p.phone || '', address: p.address || '', employmentStart: p.employment_start || '',
  status: p.status, statusLabel: REF.PERSONNEL_STATUS[p.status] || p.status,
  employerCompanyId: p.employer_company_id || null, employerName: p.employer_company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(p.employer_company_id)?.name || '') : '',
  directManagerId: p.direct_manager_id || null, directManagerName: p.direct_manager_id ? (() => { const m = db.prepare('SELECT first_name, last_name FROM personnel WHERE id = ?').get(p.direct_manager_id); return m ? `${m.first_name} ${m.last_name}` : ''; })() : '',
  notes: p.notes || '', createdAt: p.created_at, updatedAt: p.updated_at,
});
function validatePersonnel(b, id) {
  const e = {};
  const firstName = String(b.firstName ?? '').trim(), lastName = String(b.lastName ?? '').trim(), nationalId = String(b.nationalId ?? '').trim();
  const personnelCode = String(b.personnelCode ?? '').trim(), position = String(b.position ?? '').trim(), mobile = String(b.mobile ?? '').trim();
  const phone = String(b.phone ?? '').trim(), address = String(b.address ?? '').trim(), notes = String(b.notes ?? '').trim();
  const employmentStart = String(b.employmentStart ?? '').trim(), status = String(b.status ?? 'active');
  if (!isPersianName(firstName) || firstName.length > 60) e.firstName = 'نام را با حروف فارسی وارد کنید (حداکثر ۶۰ نویسه)';
  if (!isPersianName(lastName) || lastName.length > 60) e.lastName = 'نام خانوادگی را با حروف فارسی وارد کنید (حداکثر ۶۰ نویسه)';
  if (!validNID(nationalId)) e.nationalId = 'کد ملی معتبر نیست';
  else if (db.prepare('SELECT id FROM personnel WHERE national_id = ? AND id IS NOT ?').get(nationalId, id ?? null)) e.nationalId = 'اطلاعات تکراری است: این کد ملی قبلاً ثبت شده';
  if (personnelCode && !/^[0-9A-Za-z\-]{1,20}$/.test(personnelCode)) e.personnelCode = 'شماره پرسنلی فقط حرف انگلیسی، عدد و - (حداکثر ۲۰)';
  else if (personnelCode && db.prepare('SELECT id FROM personnel WHERE personnel_code = ? AND id IS NOT ?').get(personnelCode, id ?? null)) e.personnelCode = 'اطلاعات تکراری است: این شماره پرسنلی قبلاً ثبت شده';
  if (position.length > 100) e.position = 'سمت حداکثر ۱۰۰ نویسه';
  if (mobile && !/^09\d{9}$/.test(mobile)) e.mobile = 'شماره موبایل معتبر نیست (مثلاً 09121234567)';
  if (phone && !/^[0-9\- ]{6,20}$/.test(phone)) e.phone = 'شماره تلفن معتبر نیست';
  if (address.length > 300) e.address = 'نشانی حداکثر ۳۰۰ نویسه';
  if (employmentStart && !J.isValidISO(employmentStart)) e.employmentStart = 'تاریخ استخدام معتبر نیست';
  if (!REF.PERSONNEL_STATUS[status]) e.status = 'وضعیت پرسنل نامعتبر است';
  if (notes.length > 1000) e.notes = 'یادداشت حداکثر ۱۰۰۰ نویسه';
  const unitId = b.unitId ? idOf(b.unitId) : null;
  if (b.unitId && !db.prepare('SELECT id FROM departments WHERE id = ?').get(unitId)) e.unitId = 'واحد انتخاب‌شده وجود ندارد';
  const managerId = b.directManagerId ? idOf(b.directManagerId) : null;
  if (managerId && (managerId === id || !db.prepare('SELECT id FROM personnel WHERE id = ?').get(managerId))) e.directManagerId = 'مدیر مستقیم معتبر نیست';
  const employerId = b.employerCompanyId ? idOf(b.employerCompanyId) : null;
  if (employerId && !db.prepare('SELECT id FROM companies WHERE id = ?').get(employerId)) e.employerCompanyId = 'شرکت کارفرما وجود ندارد';
  return { v: { firstName, lastName, nationalId, personnelCode: personnelCode || null, position: position || null, unitId, mobile: mobile || null, phone: phone || null,
    address: address || null, employmentStart: employmentStart || null, status, notes: notes || null, managerId, employerId }, e };
}
route('GET', '/api/personnel', (ctx) => {
  const u = ctx.user;
  const full = can(u, 'personnel', 'view');
  if (!full && !u.personnelId) return { items: [], ownOnly: true, canCreate: false, canEdit: false, statuses: REF.PERSONNEL_STATUS };
  const q = normQ(ctx.query.get('q')), status = ctx.query.get('status') || '';
  let rows = full ? db.prepare('SELECT * FROM personnel ORDER BY last_name, first_name, id').all() : db.prepare('SELECT * FROM personnel WHERE id = ?').all(u.personnelId);
  if (status && REF.PERSONNEL_STATUS[status]) rows = rows.filter((p) => p.status === status);
  if (q) rows = rows.filter((p) => `${p.first_name} ${p.last_name} ${p.national_id || ''} ${p.personnel_code || ''}`.toLowerCase().includes(q));
  return { items: rows.map(personnelOut), ownOnly: !full, canCreate: can(u, 'personnel', 'create'), canEdit: can(u, 'personnel', 'edit'), statuses: REF.PERSONNEL_STATUS };
});
route('POST', '/api/personnel', (ctx) => {
  need(ctx.user, 'personnel', 'create');
  const { v, e } = validatePersonnel(ctx.body, null);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare(`INSERT INTO personnel (first_name,last_name,national_id,personnel_code,position,department_id,mobile,phone,address,employment_start,status,notes,employer_company_id,direct_manager_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.firstName, v.lastName, v.nationalId, v.personnelCode, v.position, v.unitId, v.mobile, v.phone, v.address, v.employmentStart, v.status, v.notes, v.employerId, v.managerId, now, now);
  audit(ctx.user, { action: 'create', section: 'personnel', entity: 'پرونده پرسنلی', recordId: r.lastInsertRowid, description: `ایجاد پرونده ${v.firstName} ${v.lastName}` });
  return [201, personnelOut(db.prepare('SELECT * FROM personnel WHERE id = ?').get(r.lastInsertRowid))];
});
route('GET', '/api/personnel/:id', (ctx) => {
  const id = idOf(ctx.params.id);
  if (!id || !personnelVisible(ctx.user, id)) fail(403, 'دسترسی به این پرونده ندارید');
  const p = db.prepare('SELECT * FROM personnel WHERE id = ?').get(id);
  if (!p) fail(404, 'پرونده یافت نشد');
  const docs = db.prepare('SELECT id, doc_type, title, file_name, size, created_at FROM personnel_documents WHERE personnel_id = ? ORDER BY id DESC').all(id)
    .map((d) => ({ id: d.id, docType: d.doc_type, title: d.title, fileName: d.file_name, size: d.size, createdAt: d.created_at }));
  return { ...personnelOut(p), documents: docs, canEdit: can(ctx.user, 'personnel', 'edit'), canUpload: can(ctx.user, 'personnel', 'edit'), canDeleteDoc: can(ctx.user, 'personnel', 'delete'), docTypes: REF.PERSONNEL_DOC_TYPES };
});
route('PUT', '/api/personnel/:id', (ctx) => {
  need(ctx.user, 'personnel', 'edit');
  const id = idOf(ctx.params.id);
  const old = id && db.prepare('SELECT * FROM personnel WHERE id = ?').get(id);
  if (!old) fail(404, 'پرونده یافت نشد');
  const { v, e } = validatePersonnel(ctx.body, id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare(`UPDATE personnel SET first_name=?,last_name=?,national_id=?,personnel_code=?,position=?,department_id=?,mobile=?,phone=?,address=?,employment_start=?,status=?,notes=?,employer_company_id=?,direct_manager_id=?,updated_at=? WHERE id=?`)
    .run(v.firstName, v.lastName, v.nationalId, v.personnelCode, v.position, v.unitId, v.mobile, v.phone, v.address, v.employmentStart, v.status, v.notes, v.employerId, v.managerId, new Date().toISOString(), id);
  const changes = [];
  const pairs = [['نام', old.first_name, v.firstName], ['نام خانوادگی', old.last_name, v.lastName], ['کد ملی', old.national_id, v.nationalId], ['وضعیت', REF.PERSONNEL_STATUS[old.status], REF.PERSONNEL_STATUS[v.status]], ['سمت', old.position, v.position]];
  for (const [f, a, b2] of pairs) if (String(a ?? '') !== String(b2 ?? '')) changes.push({ field: f, from: String(a ?? '—'), to: String(b2 ?? '—') });
  audit(ctx.user, { action: 'update', section: 'personnel', entity: 'پرونده پرسنلی', recordId: id, description: `ویرایش پرونده ${v.firstName} ${v.lastName}`, changes });
  return personnelOut(db.prepare('SELECT * FROM personnel WHERE id = ?').get(id));
});
route('POST', '/api/personnel/:id/documents', (ctx) => {
  need(ctx.user, 'personnel', 'edit');
  const id = idOf(ctx.params.id);
  if (!id || !db.prepare('SELECT id FROM personnel WHERE id = ?').get(id)) fail(404, 'پرونده یافت نشد');
  const f = ctx.form ? ctx.form.fields : {};
  const title = String(f.title ?? '').trim(), docType = String(f.docType ?? '');
  const e = {};
  if (title.length < 2 || title.length > 150) e.title = 'عنوان مدرک ۲ تا ۱۵۰ نویسه';
  if (!REF.PERSONNEL_DOC_TYPES.includes(docType)) e.docType = 'نوع مدرک را انتخاب کنید';
  const upload = ctx.form ? ctx.form.fileList.find((x) => x.field.startsWith('file')) : null;
  if (!upload) e.file = 'فایل مدرک را انتخاب کنید';
  const file = upload ? checkFile(upload) : null;
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const stored = writeStored(file);
  try {
    const r = db.prepare('INSERT INTO personnel_documents (personnel_id,doc_type,title,file_name,stored_name,mime,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, docType, title, file.name, stored, file.mime, file.data.length, ctx.user.id, new Date().toISOString());
    audit(ctx.user, { action: 'create', section: 'personnel', entity: 'مدرک پرسنلی', recordId: r.lastInsertRowid, description: `بارگذاری مدرک «${title}» (${docType})` });
  } catch (err) { removeStored(stored); throw err; }
  return [201, { ok: true }];
});
route('GET', '/api/personnel/:id/documents/:docId/download', (ctx) => {
  const id = idOf(ctx.params.id);
  if (!id || !personnelVisible(ctx.user, id)) fail(403, 'دسترسی به این مدرک ندارید');
  const d = db.prepare('SELECT * FROM personnel_documents WHERE id = ? AND personnel_id = ?').get(idOf(ctx.params.docId), id);
  if (!d) fail(404, 'مدرک یافت نشد');
  const full = path.join(UPLOAD_DIR, path.basename(d.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  audit(ctx.user, { action: 'view', section: 'personnel', entity: 'دانلود مدرک پرسنلی', recordId: d.id, description: `دانلود مدرک «${d.title}»` });
  return { raw: fs.readFileSync(full), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } };
});
route('DELETE', '/api/personnel/:id/documents/:docId', (ctx) => {
  need(ctx.user, 'personnel', 'delete');
  const id = idOf(ctx.params.id);
  const d = db.prepare('SELECT * FROM personnel_documents WHERE id = ? AND personnel_id = ?').get(idOf(ctx.params.docId), id);
  if (!d) fail(404, 'مدرک یافت نشد');
  db.prepare('DELETE FROM personnel_documents WHERE id = ?').run(d.id);
  removeStored(d.stored_name);
  audit(ctx.user, { action: 'delete', section: 'personnel', entity: 'مدرک پرسنلی', recordId: d.id, description: `حذف مدرک «${d.title}»` });
  return { ok: true };
});

for (const r of ROUTES) {
  if (r.method === 'POST' && r.re.test('/api/personnel/1/documents')) r.multipart = true;
}


// ---------- Service requests (کاربرگی) ----------
const REQ_STATUS = { submitted: 'ثبت‌شده', approved: 'تأییدشده', assigned: 'تخصیص‌یافته', done: 'انجام‌شده', rejected: 'ردشده', cancelled: 'لغوشده' };
const REQ_NEXT = { submitted: ['approve', 'reject', 'cancel'], approved: ['assign', 'cancel'], assigned: ['done', 'cancel'] };
const REQ_TO = { approve: 'approved', reject: 'rejected', cancel: 'cancelled', assign: 'assigned', done: 'done' };
const reqOut = (r) => ({ id: r.id, trackingNo: r.tracking_no, requester: r.requester, unitId: r.unit_id || null, unitName: r.unit_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(r.unit_id)?.name || '') : '',
  requestDate: r.request_date, origin: r.origin, destination: r.destination, passengerCount: r.passenger_count, notes: r.notes || '',
  status: r.status, statusLabel: REQ_STATUS[r.status], vehicleId: r.vehicle_id || null, vehicleName: r.vehicle_id ? plateText(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(r.vehicle_id)).plate) : '',
  driverId: r.driver_id || null, driverName: driverName(r.driver_id), createdAt: r.created_at, updatedAt: r.updated_at });
route('GET', '/api/requests', (ctx) => {
  need(ctx.user, 'requests', 'view');
  const q = normQ(ctx.query.get('q')), st = ctx.query.get('status') || '';
  let rows = db.prepare('SELECT * FROM service_requests ORDER BY id DESC LIMIT 1000').all();
  if (st && REQ_STATUS[st]) rows = rows.filter((r) => r.status === st);
  if (q) rows = rows.filter((r) => `${r.tracking_no} ${r.requester} ${r.origin} ${r.destination}`.toLowerCase().includes(q));
  return { items: rows.map(reqOut), statuses: REQ_STATUS, canEdit: can(ctx.user, 'requests', 'edit'), canCreate: can(ctx.user, 'requests', 'create') };
});
route('POST', '/api/requests', (ctx) => {
  need(ctx.user, 'requests', 'create');
  const b = ctx.body, e = {};
  const requester = String(b.requester ?? '').trim(), origin = String(b.origin ?? '').trim(), destination = String(b.destination ?? '').trim(), notes = String(b.notes ?? '').trim();
  const requestDate = String(b.requestDate ?? '').trim(), count = Number(b.passengerCount);
  const unitId = b.unitId ? idOf(b.unitId) : null;
  if (requester.length < 2 || requester.length > 100) e.requester = 'نام درخواست‌کننده ۲ تا ۱۰۰ نویسه';
  if (origin.length < 2 || origin.length > 150) e.origin = 'مبدأ ۲ تا ۱۵۰ نویسه';
  if (destination.length < 2 || destination.length > 150) e.destination = 'مقصد ۲ تا ۱۵۰ نویسه';
  if (!J.isValidISO(requestDate)) e.requestDate = 'تاریخ معتبر نیست';
  if (!Number.isInteger(count) || count < 1 || count > 500) e.passengerCount = 'تعداد مسافر بین ۱ تا ۵۰۰';
  if (b.unitId && !db.prepare('SELECT id FROM departments WHERE id = ?').get(unitId)) e.unitId = 'واحد نامعتبر است';
  if (notes.length > 1000) e.notes = 'توضیحات حداکثر ۱۰۰۰ نویسه';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('INSERT INTO service_requests (tracking_no,requester,unit_id,request_date,origin,destination,passenger_count,notes,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('TMP-' + Math.random().toString(36).slice(2), requester, unitId, requestDate, origin, destination, count, notes || null, 'submitted', ctx.user.id, now, now);
    const tracking = `REQ-${new Date().getFullYear()}-${String(r.lastInsertRowid).padStart(6, '0')}`;
    db.prepare('UPDATE service_requests SET tracking_no = ? WHERE id = ?').run(tracking, r.lastInsertRowid);
    db.prepare('INSERT INTO service_request_events (request_id,action,note,actor_id,created_at) VALUES (?,?,?,?,?)').run(r.lastInsertRowid, 'submitted', null, ctx.user.id, now);
    db.exec('COMMIT');
    audit(ctx.user, { action: 'create', section: 'requests', entity: 'درخواست کاربرگی', recordId: r.lastInsertRowid, description: `ثبت درخواست ${tracking}` });
    return [201, reqOut(db.prepare('SELECT * FROM service_requests WHERE id = ?').get(r.lastInsertRowid))];
  } catch (err) { db.exec('ROLLBACK'); throw err; }
});
route('GET', '/api/requests/:id', (ctx) => {
  need(ctx.user, 'requests', 'view');
  const r = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(idOf(ctx.params.id));
  if (!r) fail(404, 'درخواست یافت نشد');
  const events = db.prepare('SELECT e.*, u.name AS actor FROM service_request_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.request_id = ? ORDER BY e.id').all(r.id)
    .map((x) => ({ action: x.action, note: x.note || '', actor: x.actor || '—', at: x.created_at }));
  return { ...reqOut(r), events, nextActions: (REQ_NEXT[r.status] || []).map((a) => ({ action: a, label: { approve: 'تأیید', reject: 'رد', cancel: 'لغو', assign: 'تخصیص خودرو و راننده', done: 'ثبت انجام' }[a] })) };
});
route('PUT', '/api/requests/:id/status', (ctx) => {
  need(ctx.user, 'requests', 'edit');
  const r = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(idOf(ctx.params.id));
  if (!r) fail(404, 'درخواست یافت نشد');
  const action = String(ctx.body.action ?? '');
  if (!(REQ_NEXT[r.status] || []).includes(action)) fail(422, 'این عملیات برای وضعیت فعلی درخواست مجاز نیست');
  const note = String(ctx.body.note ?? '').trim();
  let vehicleId = r.vehicle_id, driverId = r.driver_id;
  if (action === 'assign') {
    vehicleId = idOf(ctx.body.vehicleId); driverId = idOf(ctx.body.driverId);
    const e = {};
    if (!vehicleId || !db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicleId)) e.vehicleId = 'خودرو را انتخاب کنید';
    if (!driverId || !db.prepare('SELECT id FROM drivers WHERE id = ?').get(driverId)) e.driverId = 'راننده را انتخاب کنید';
    if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE service_requests SET status = ?, vehicle_id = ?, driver_id = ?, updated_at = ? WHERE id = ?').run(REQ_TO[action], vehicleId, driverId, now, r.id);
  db.prepare('INSERT INTO service_request_events (request_id,action,note,actor_id,created_at) VALUES (?,?,?,?,?)').run(r.id, REQ_TO[action], note || null, ctx.user.id, now);
  audit(ctx.user, { action: 'update', section: 'requests', entity: 'درخواست کاربرگی', recordId: r.id, description: `${r.tracking_no}: ${REQ_STATUS[REQ_TO[action]]}`, changes: [{ field: 'وضعیت', from: REQ_STATUS[r.status], to: REQ_STATUS[REQ_TO[action]] }] });
  return reqOut(db.prepare('SELECT * FROM service_requests WHERE id = ?').get(r.id));
});
route('GET', '/api/requests-report', (ctx) => {
  need(ctx.user, 'requests', 'view');
  const rows = db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(passenger_count),0) AS pax FROM service_requests GROUP BY status').all();
  return { byStatus: rows.map((x) => ({ status: x.status, label: REQ_STATUS[x.status], count: x.n, passengers: x.pax })), total: rows.reduce((s, x) => s + x.n, 0) };
});

// ---------- Passengers (اطلاعات مسافران) ----------
const TP_STATUS = { booked: 'رزرو شده', present: 'حاضر', absent: 'غایب', cancelled: 'لغو شده' };
route('GET', '/api/passengers', (ctx) => {
  need(ctx.user, 'passengers', 'view');
  const q = normQ(ctx.query.get('q'));
  let rows = db.prepare('SELECT * FROM passengers ORDER BY last_name, first_name, id LIMIT 2000').all();
  if (q) rows = rows.filter((p) => `${p.first_name} ${p.last_name} ${p.national_id || ''}`.toLowerCase().includes(q));
  return { items: rows.map((p) => ({ id: p.id, firstName: p.first_name, lastName: p.last_name, nationalId: p.national_id || '', mobile: p.mobile || '', unitId: p.unit_id || null, active: !!p.active })),
    canEdit: can(ctx.user, 'passengers', 'edit'), canCreate: can(ctx.user, 'passengers', 'create') };
});
function validPassenger(b, id) {
  const e = {};
  const firstName = String(b.firstName ?? '').trim(), lastName = String(b.lastName ?? '').trim(), nationalId = String(b.nationalId ?? '').trim(), mobile = String(b.mobile ?? '').trim();
  if (!isPersianName(firstName) || firstName.length > 60) e.firstName = 'نام را با حروف فارسی وارد کنید';
  if (!isPersianName(lastName) || lastName.length > 60) e.lastName = 'نام خانوادگی را با حروف فارسی وارد کنید';
  if (nationalId && !validNID(nationalId)) e.nationalId = 'کد ملی معتبر نیست';
  else if (nationalId && db.prepare('SELECT id FROM passengers WHERE national_id = ? AND id IS NOT ?').get(nationalId, id ?? null)) e.nationalId = 'اطلاعات تکراری است: این مسافر قبلاً ثبت شده';
  if (mobile && !/^09\d{9}$/.test(mobile)) e.mobile = 'شماره موبایل معتبر نیست';
  const unitId = b.unitId ? idOf(b.unitId) : null;
  if (b.unitId && !db.prepare('SELECT id FROM departments WHERE id = ?').get(unitId)) e.unitId = 'واحد نامعتبر است';
  return { v: { firstName, lastName, nationalId: nationalId || null, mobile: mobile || null, unitId, active: b.active === false ? 0 : 1 }, e };
}
route('POST', '/api/passengers', (ctx) => {
  need(ctx.user, 'passengers', 'create');
  const { v, e } = validPassenger(ctx.body, null);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO passengers (first_name,last_name,national_id,mobile,unit_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(v.firstName, v.lastName, v.nationalId, v.mobile, v.unitId, v.active, now, now);
  audit(ctx.user, { action: 'create', section: 'passengers', entity: 'مسافر', recordId: r.lastInsertRowid, description: `ثبت مسافر ${v.firstName} ${v.lastName}` });
  return [201, { id: r.lastInsertRowid }];
});
route('PUT', '/api/passengers/:id', (ctx) => {
  need(ctx.user, 'passengers', 'edit');
  const id = idOf(ctx.params.id);
  if (!id || !db.prepare('SELECT id FROM passengers WHERE id = ?').get(id)) fail(404, 'مسافر یافت نشد');
  const { v, e } = validPassenger(ctx.body, id);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare('UPDATE passengers SET first_name=?,last_name=?,national_id=?,mobile=?,unit_id=?,active=?,updated_at=? WHERE id=?').run(v.firstName, v.lastName, v.nationalId, v.mobile, v.unitId, v.active, new Date().toISOString(), id);
  audit(ctx.user, { action: 'update', section: 'passengers', entity: 'مسافر', recordId: id, description: `ویرایش مسافر ${v.firstName} ${v.lastName}` });
  return { ok: true };
});
route('GET', '/api/trips/:id/passengers', (ctx) => {
  need(ctx.user, 'passengers', 'view');
  const t = db.prepare('SELECT id FROM trips WHERE id = ?').get(idOf(ctx.params.id));
  if (!t) fail(404, 'سفر یافت نشد');
  const rows = db.prepare(`SELECT tp.*, p.first_name, p.last_name FROM trip_passengers tp JOIN passengers p ON p.id = tp.passenger_id WHERE tp.trip_id = ? ORDER BY p.last_name, p.first_name`).all(t.id);
  return { items: rows.map((x) => ({ id: x.id, passengerId: x.passenger_id, name: `${x.first_name} ${x.last_name}`, boarding: x.boarding_station || '', alighting: x.alighting_station || '', status: x.status, statusLabel: TP_STATUS[x.status] })), statuses: TP_STATUS, canEdit: can(ctx.user, 'passengers', 'edit') };
});
route('POST', '/api/trips/:id/passengers', (ctx) => {
  need(ctx.user, 'passengers', 'edit');
  const t = db.prepare('SELECT id FROM trips WHERE id = ?').get(idOf(ctx.params.id));
  if (!t) fail(404, 'سفر یافت نشد');
  const pid = idOf(ctx.body.passengerId);
  const boarding = String(ctx.body.boarding ?? '').trim(), alighting = String(ctx.body.alighting ?? '').trim();
  const e = {};
  if (!pid || !db.prepare('SELECT id FROM passengers WHERE id = ? AND active = 1').get(pid)) e.passengerId = 'مسافر فعال را انتخاب کنید';
  if (boarding.length > 150) e.boarding = 'ایستگاه سوار شدن حداکثر ۱۵۰ نویسه';
  if (alighting.length > 150) e.alighting = 'ایستگاه پیاده شدن حداکثر ۱۵۰ نویسه';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  if (db.prepare('SELECT id FROM trip_passengers WHERE trip_id = ? AND passenger_id = ?').get(t.id, pid)) fail(422, 'این مسافر قبلاً به این سفر اضافه شده است', { passengerId: 'تکراری است' });
  db.prepare('INSERT INTO trip_passengers (trip_id,passenger_id,boarding_station,alighting_station,status,created_at) VALUES (?,?,?,?,?,?)').run(t.id, pid, boarding || null, alighting || null, 'booked', new Date().toISOString());
  return [201, { ok: true }];
});
route('PUT', '/api/trip-passengers/:id', (ctx) => {
  need(ctx.user, 'passengers', 'edit');
  const row = db.prepare('SELECT * FROM trip_passengers WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'مورد یافت نشد');
  const status = String(ctx.body.status ?? '');
  if (!TP_STATUS[status]) fail(422, 'وضعیت نامعتبر است');
  db.prepare('UPDATE trip_passengers SET status = ? WHERE id = ?').run(status, row.id);
  audit(ctx.user, { action: 'update', section: 'passengers', entity: 'حضور مسافر', recordId: row.id, description: `وضعیت حضور: ${TP_STATUS[status]}`, changes: [{ field: 'وضعیت', from: TP_STATUS[row.status], to: TP_STATUS[status] }] });
  return { ok: true };
});
route('DELETE', '/api/trip-passengers/:id', (ctx) => {
  need(ctx.user, 'passengers', 'delete');
  const row = db.prepare('SELECT * FROM trip_passengers WHERE id = ?').get(idOf(ctx.params.id));
  if (!row) fail(404, 'مورد یافت نشد');
  db.prepare('DELETE FROM trip_passengers WHERE id = ?').run(row.id);
  audit(ctx.user, { action: 'delete', section: 'passengers', entity: 'مسافر سفر', recordId: row.id, description: 'حذف مسافر از سفر' });
  return { ok: true };
});
route('GET', '/api/passengers-report', (ctx) => {
  need(ctx.user, 'passengers', 'view');
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM trip_passengers GROUP BY status').all();
  return { byStatus: rows.map((x) => ({ status: x.status, label: TP_STATUS[x.status], count: x.n })), passengers: db.prepare('SELECT COUNT(*) AS n FROM passengers WHERE active = 1').get().n };
});

// ---------- Finance (simple ledger; categories are settings, not accounting rules) ----------
route('GET', '/api/finance/categories', (ctx) => {
  need(ctx.user, 'finance', 'view');
  return { items: db.prepare('SELECT * FROM finance_categories ORDER BY kind, name').all().map((c) => ({ id: c.id, name: c.name, kind: c.kind, active: !!c.active })), canEdit: can(ctx.user, 'finance', 'edit') };
});
route('POST', '/api/finance/categories', (ctx) => {
  need(ctx.user, 'finance', 'edit');
  const name = String(ctx.body.name ?? '').trim(), kind = String(ctx.body.kind ?? '');
  const e = {};
  if (name.length < 2 || name.length > 80) e.name = 'نام دسته ۲ تا ۸۰ نویسه';
  if (!['income', 'expense'].includes(kind)) e.kind = 'نوع دسته را انتخاب کنید';
  if (!e.name && db.prepare('SELECT id FROM finance_categories WHERE name = ?').get(name)) e.name = 'اطلاعات تکراری است: این دسته قبلاً ثبت شده';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const r = db.prepare('INSERT INTO finance_categories (name, kind, active) VALUES (?,?,1)').run(name, kind);
  audit(ctx.user, { action: 'create', section: 'finance', entity: 'دسته مالی', recordId: r.lastInsertRowid, description: `ثبت دسته ${name}` });
  return [201, { id: r.lastInsertRowid }];
});
route('PUT', '/api/finance/categories/:id', (ctx) => {
  need(ctx.user, 'finance', 'edit');
  const c = db.prepare('SELECT * FROM finance_categories WHERE id = ?').get(idOf(ctx.params.id));
  if (!c) fail(404, 'دسته یافت نشد');
  const name = String(ctx.body.name ?? c.name).trim(), active = ctx.body.active === undefined ? c.active : (ctx.body.active ? 1 : 0);
  if (name.length < 2 || name.length > 80) fail(422, 'اطلاعات نامعتبر است', { name: 'نام دسته ۲ تا ۸۰ نویسه' });
  if (db.prepare('SELECT id FROM finance_categories WHERE name = ? AND id != ?').get(name, c.id)) fail(422, 'اطلاعات تکراری است: این دسته قبلاً ثبت شده', { name: 'تکراری است' });
  db.prepare('UPDATE finance_categories SET name = ?, active = ? WHERE id = ?').run(name, active, c.id);
  audit(ctx.user, { action: 'update', section: 'finance', entity: 'دسته مالی', recordId: c.id, description: `ویرایش دسته ${name}` });
  return { ok: true };
});
const finOut = (f) => ({ id: f.id, kind: f.kind, kindLabel: f.kind === 'income' ? 'درآمد' : 'هزینه', categoryId: f.category_id, categoryName: db.prepare('SELECT name FROM finance_categories WHERE id = ?').get(f.category_id)?.name || '',
  amount: f.amount, entryDate: f.entry_date, referenceNo: f.reference_no, companyId: f.company_id || null, companyName: f.company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(f.company_id)?.name || '') : '',
  vehicleId: f.vehicle_id || null, servicePlanId: f.service_plan_id || null, description: f.description || '', paymentStatus: f.payment_status, paidAt: f.paid_at || '', paymentMethod: f.payment_method || '' });
function validFinance(b) {
  const e = {};
  const kind = String(b.kind ?? ''), categoryId = idOf(b.categoryId), amount = Number(b.amount), entryDate = String(b.entryDate ?? '').trim();
  const companyId = b.companyId ? idOf(b.companyId) : null, vehicleId = b.vehicleId ? idOf(b.vehicleId) : null, servicePlanId = b.servicePlanId ? idOf(b.servicePlanId) : null;
  const description = String(b.description ?? '').trim();
  if (!['income', 'expense'].includes(kind)) e.kind = 'نوع را انتخاب کنید';
  const cat = categoryId && db.prepare('SELECT * FROM finance_categories WHERE id = ? AND active = 1').get(categoryId);
  if (!cat) e.categoryId = 'دسته فعال را انتخاب کنید';
  else if (cat.kind !== kind) e.categoryId = 'دسته با نوع انتخاب‌شده سازگار نیست';
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1e12) e.amount = 'مبلغ باید عدد صحیح و مثبت (تومان) باشد';
  if (!J.isValidISO(entryDate)) e.entryDate = 'تاریخ معتبر نیست';
  if (b.companyId && !db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId)) e.companyId = 'شرکت نامعتبر است';
  if (b.vehicleId && !db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicleId)) e.vehicleId = 'خودرو نامعتبر است';
  if (b.servicePlanId && !db.prepare('SELECT id FROM service_plans WHERE id = ?').get(servicePlanId)) e.servicePlanId = 'سرویس نامعتبر است';
  if (description.length > 500) e.description = 'توضیحات حداکثر ۵۰۰ نویسه';
  return { v: { kind, categoryId, amount, entryDate, companyId, vehicleId, servicePlanId, description: description || null }, e };
}
route('GET', '/api/finance', (ctx) => {
  need(ctx.user, 'finance', 'view');
  const kind = ctx.query.get('kind') || '', pay = ctx.query.get('paymentStatus') || '', from = ctx.query.get('from') || '', to = ctx.query.get('to') || '';
  const cat = idOf(ctx.query.get('categoryId'));
  let rows = db.prepare('SELECT * FROM finance_entries ORDER BY entry_date DESC, id DESC LIMIT 2000').all();
  if (kind) rows = rows.filter((f) => f.kind === kind);
  if (pay) rows = rows.filter((f) => f.payment_status === pay);
  if (cat) rows = rows.filter((f) => f.category_id === cat);
  if (from) rows = rows.filter((f) => f.entry_date >= from);
  if (to) rows = rows.filter((f) => f.entry_date <= to);
  return { items: rows.map(finOut), canEdit: can(ctx.user, 'finance', 'edit'), canCreate: can(ctx.user, 'finance', 'create') };
});
route('POST', '/api/finance', (ctx) => {
  need(ctx.user, 'finance', 'create');
  const { v, e } = validFinance(ctx.body);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('INSERT INTO finance_entries (kind,category_id,amount,entry_date,reference_no,company_id,vehicle_id,service_plan_id,description,payment_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(v.kind, v.categoryId, v.amount, v.entryDate, 'TMP-' + Math.random().toString(36).slice(2), v.companyId, v.vehicleId, v.servicePlanId, v.description, 'unpaid', ctx.user.id, now, now);
    const ref = `FIN-${v.entryDate.slice(0, 4)}-${String(r.lastInsertRowid).padStart(6, '0')}`;
    db.prepare('UPDATE finance_entries SET reference_no = ? WHERE id = ?').run(ref, r.lastInsertRowid);
    db.exec('COMMIT');
    audit(ctx.user, { action: 'create', section: 'finance', entity: 'سند مالی', recordId: r.lastInsertRowid, description: `ثبت ${v.kind === 'income' ? 'درآمد' : 'هزینه'} ${ref}` });
    return [201, { id: r.lastInsertRowid, referenceNo: ref }];
  } catch (err) { db.exec('ROLLBACK'); throw err; }
});
route('PUT', '/api/finance/:id', (ctx) => {
  need(ctx.user, 'finance', 'edit');
  const old = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(idOf(ctx.params.id));
  if (!old) fail(404, 'سند یافت نشد');
  if (old.payment_status === 'paid') fail(422, 'سند پرداخت‌شده قابل ویرایش نیست؛ برای اصلاح، سند جدید ثبت کنید');
  const { v, e } = validFinance(ctx.body);
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare('UPDATE finance_entries SET kind=?,category_id=?,amount=?,entry_date=?,company_id=?,vehicle_id=?,service_plan_id=?,description=?,updated_at=? WHERE id=?')
    .run(v.kind, v.categoryId, v.amount, v.entryDate, v.companyId, v.vehicleId, v.servicePlanId, v.description, new Date().toISOString(), old.id);
  audit(ctx.user, { action: 'update', section: 'finance', entity: 'سند مالی', recordId: old.id, description: `ویرایش سند ${old.reference_no}`, changes: [{ field: 'مبلغ', from: String(old.amount), to: String(v.amount) }] });
  return { ok: true };
});
route('POST', '/api/finance/:id/pay', (ctx) => {
  need(ctx.user, 'finance', 'edit');
  const f = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(idOf(ctx.params.id));
  if (!f) fail(404, 'سند یافت نشد');
  if (f.payment_status === 'paid') fail(422, 'این سند قبلاً تسویه شده است');
  const paidAt = String(ctx.body.paidAt ?? '').trim(), method = String(ctx.body.method ?? '').trim();
  const e = {};
  if (!J.isValidISO(paidAt)) e.paidAt = 'تاریخ پرداخت معتبر نیست';
  if (method.length < 2 || method.length > 60) e.method = 'روش پرداخت ۲ تا ۶۰ نویسه';
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  db.prepare("UPDATE finance_entries SET payment_status = 'paid', paid_at = ?, payment_method = ?, updated_at = ? WHERE id = ?").run(paidAt, method, new Date().toISOString(), f.id);
  audit(ctx.user, { action: 'update', section: 'finance', entity: 'تسویه', recordId: f.id, description: `ثبت پرداخت ${f.reference_no}`, changes: [{ field: 'وضعیت پرداخت', from: 'پرداخت‌نشده', to: 'پرداخت‌شده' }] });
  return { ok: true };
});
route('GET', '/api/finance/summary', (ctx) => {
  need(ctx.user, 'finance', 'view');
  const from = ctx.query.get('from') || '', to = ctx.query.get('to') || '';
  let rows = db.prepare('SELECT f.*, c.name AS cat FROM finance_entries f JOIN finance_categories c ON c.id = f.category_id').all();
  if (from) rows = rows.filter((f) => f.entry_date >= from);
  if (to) rows = rows.filter((f) => f.entry_date <= to);
  const sum = (fn) => rows.filter(fn).reduce((s, f) => s + f.amount, 0);
  const income = sum((f) => f.kind === 'income'), expense = sum((f) => f.kind === 'expense');
  const byCat = {};
  for (const f of rows) { byCat[f.cat] = byCat[f.cat] || { category: f.cat, kind: f.kind, total: 0, count: 0 }; byCat[f.cat].total += f.amount; byCat[f.cat].count += 1; }
  return { income, expense, balance: income - expense,
    unpaidIncome: sum((f) => f.kind === 'income' && f.payment_status !== 'paid'), unpaidExpense: sum((f) => f.kind === 'expense' && f.payment_status !== 'paid'),
    byCategory: Object.values(byCat).sort((a, b2) => b2.total - a.total), count: rows.length };
});


// ---------- Reports: live data from the database, filtered, exported as CSV (opens in Excel) ----------
const csvCell = (v) => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // prevents spreadsheet formula injection
  return '"' + t.replace(/"/g, '""') + '"';
};
const REPORTS = {
  finance: { section: 'finance', name: 'مالی', head: ['شماره سند', 'نوع', 'دسته', 'مبلغ (تومان)', 'تاریخ', 'وضعیت پرداخت', 'تاریخ پرداخت', 'روش پرداخت', 'شرکت'],
    dateIndex: 4,
    rows: (f) => db.prepare('SELECT f.*, c.name AS cat, co.name AS co FROM finance_entries f JOIN finance_categories c ON c.id = f.category_id LEFT JOIN companies co ON co.id = f.company_id ORDER BY f.entry_date, f.id').all()
      .map((x) => [x.reference_no, x.kind === 'income' ? 'درآمد' : 'هزینه', x.cat, x.amount, x.entry_date, x.payment_status === 'paid' ? 'پرداخت‌شده' : 'پرداخت‌نشده', x.paid_at || '', x.payment_method || '', x.co || '']) },
  requests: { section: 'requests', name: 'سرویس‌های کاربرگی', head: ['شماره پیگیری', 'درخواست‌کننده', 'مبدأ', 'مقصد', 'تاریخ', 'تعداد مسافر', 'وضعیت', 'خودرو', 'راننده'],
    dateIndex: 4,
    rows: () => db.prepare('SELECT * FROM service_requests ORDER BY request_date, id').all()
      .map((r) => [r.tracking_no, r.requester, r.origin, r.destination, r.request_date, r.passenger_count, REQ_STATUS[r.status], r.vehicle_id ? plateText(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(r.vehicle_id)).plate) : '', driverName(r.driver_id)]) },
  passengers: { section: 'passengers', name: 'مسافران', head: ['نام', 'نام خانوادگی', 'کد ملی', 'موبایل', 'وضعیت', 'تعداد سفرهای ثبت‌شده'],
    rows: () => db.prepare('SELECT p.*, (SELECT COUNT(*) FROM trip_passengers tp WHERE tp.passenger_id = p.id) AS n FROM passengers p ORDER BY last_name, first_name').all()
      .map((p) => [p.first_name, p.last_name, p.national_id || '', p.mobile || '', p.active ? 'فعال' : 'غیرفعال', p.n]) },
  personnel: { section: 'personnel', name: 'پرسنل', head: ['نام', 'نام خانوادگی', 'کد ملی', 'شماره پرسنلی', 'واحد', 'سمت', 'وضعیت', 'کارفرما', 'تاریخ استخدام'],
    dateIndex: 8,
    rows: () => db.prepare('SELECT * FROM personnel ORDER BY last_name, first_name').all()
      .map((p) => [p.first_name, p.last_name, p.national_id || '', p.personnel_code || '', p.department_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(p.department_id)?.name || '') : '', p.position || '', REF.PERSONNEL_STATUS[p.status] || p.status, p.employer_company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(p.employer_company_id)?.name || '') : '', p.employment_start || '']) },
  contracts: { section: 'contracts', name: 'قراردادها', head: ['شماره قرارداد', 'شرکت', 'راننده', 'خودرو', 'تاریخ شروع', 'تاریخ پایان'],
    dateIndex: 4,
    rows: () => db.prepare('SELECT * FROM contracts ORDER BY start_date, id').all()
      .map((k) => { const c = db.prepare('SELECT name FROM companies WHERE id = ?').get(k.company_id); const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(k.vehicle_id);
        return [k.number, c ? c.name : '', driverName(k.driver_id), v ? plateText(vehicleOut(v).plate) : '', k.start_date, k.end_date || 'بدون پایان']; }) },
  letters: { section: 'letters', name: 'مکاتبات', statusIndex: 7,
    head: ['شماره نامه', 'نوع', 'طبقه‌بندی', 'موضوع', 'فرستنده', 'گیرنده', 'طرف بیرونی', 'وضعیت', 'تاریخ ثبت'], dateIndex: 8,
    rows: (ctx) => db.prepare(`SELECT l.* FROM letters l WHERE ${letterVisibleSql(ctx.user)} ORDER BY l.id`).all()
      .map((l) => [l.number, l.kind, l.classification || 'عادی', l.subject, db.prepare('SELECT name FROM users WHERE id = ?').get(l.sender_id)?.name || '', recipientLabel(l), l.external_party || '', LETTER_STATUS[l.status] || l.status, l.created_at.slice(0, 10)]) },
  leave: { section: 'absences', name: 'مرخصی و مأموریت', statusIndex: 6, unitIndex: 1, dateIndex: 3,
    head: ['پرسنل', 'واحد', 'نوع', 'از تاریخ', 'تا تاریخ', 'روز', 'وضعیت', 'مرحله فعلی'],
    rows: (ctx) => {
      const all = can(ctx.user, 'absences', 'view');
      const rows = all ? db.prepare('SELECT * FROM leave_requests ORDER BY id').all() : (ctx.user.personnelId ? db.prepare('SELECT * FROM leave_requests WHERE personnel_id = ? ORDER BY id').all(ctx.user.personnelId) : []);
      const steps = leaveSteps();
      return rows.map((r) => { const p = db.prepare('SELECT first_name, last_name, department_id FROM personnel WHERE id = ?').get(r.personnel_id);
        return [p ? `${p.first_name} ${p.last_name}` : '', p && p.department_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(p.department_id)?.name || '') : '', r.kind, r.start_date, r.end_date, r.days, LEAVE_STATUS[r.status] || r.status, steps.find((x) => x.position === r.current_step)?.label || '']; }); } },
  announcements: { section: 'announcements', name: 'مشاهده اطلاعیه‌ها', statusIndex: undefined, dateIndex: 2,
    head: ['عنوان', 'مخاطب', 'تاریخ انتشار', 'تعداد مخاطبان', 'مشاهده‌کرده', 'مشاهده‌نکرده'],
    rows: (ctx) => db.prepare('SELECT * FROM announcements ORDER BY id').all().filter((a) => annVisible(ctx.user, a)).map((a) => {
      const aud = annAudience(a), reads = db.prepare('SELECT user_id FROM announcement_reads WHERE announcement_id = ?').all(a.id).map((r) => r.user_id);
      const seen = aud.filter((x) => reads.includes(x.id)).length;
      return [a.title, a.department_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(a.department_id)?.name || '') : 'همه کارکنان', a.created_at.slice(0, 10), aud.length, seen, aud.length - seen]; }) },
  vehicles: { section: 'vehicles', name: 'خودروها', head: ['پلاک', 'برند', 'مدل', 'دسته', 'کلاس', 'سال', 'ظرفیت', 'واحد نظارت', 'شماره شاسی', 'شماره موتور'],
    rows: () => db.prepare('SELECT * FROM vehicles ORDER BY id').all()
      .map((v) => [plateText(vehicleOut(v).plate), v.brand, v.model, v.category, v.cls || '', v.year, v.capacity, v.supervision_unit || '', v.chassis_no || '', v.engine_no || ''] ) },
};
route('GET', '/api/reports/kinds', (ctx) => ({ items: Object.entries(REPORTS).filter(([k, r]) => can(ctx.user, r.section, 'view')).map(([k, r]) => ({ kind: k, name: r.name, hasDates: r.dateIndex !== undefined })) }));
route('GET', '/api/reports/export', (ctx) => {
  const kind = String(ctx.query.get('kind') || '');
  const rep = REPORTS[kind];
  if (!rep) fail(422, 'گزارش نامعتبر است');
  need(ctx.user, rep.section, 'view');
  const from = ctx.query.get('from') || '', to = ctx.query.get('to') || '';
  if ((from && !J.isValidISO(from)) || (to && !J.isValidISO(to))) fail(422, 'تاریخ معتبر نیست');
  let rows = rep.rows(ctx);
  if (rep.dateIndex !== undefined && (from || to)) rows = rows.filter((r) => (!from || String(r[rep.dateIndex]) >= from) && (!to || String(r[rep.dateIndex]) <= to));
  const status = String(ctx.query.get('status') || '').trim(), unit = normQ(ctx.query.get('unit'));
  if (rep.statusIndex !== undefined && status) rows = rows.filter((r) => String(r[rep.statusIndex]).includes(status));
  if (rep.unitIndex !== undefined && unit) rows = rows.filter((r) => String(r[rep.unitIndex]).toLowerCase().includes(unit));
  const lines = [rep.head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  audit(ctx.user, { action: 'view', section: rep.section, entity: 'گزارش', recordId: null, description: `خروجی گزارش ${rep.name} (${rows.length} ردیف)` });
  return { raw: Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8'), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rep.name)}-${from || 'all'}-${to || 'all'}.csv`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } };
});


// ---------- Leave and missions (مرخصی و مأموریت) with a configurable approval chain ----------
const LEAVE_KINDS = ['مرخصی', 'مأموریت'];
const LEAVE_STATUS = { pending: 'در جریان تأیید', approved: 'تأییدشده', rejected: 'ردشده', returned: 'بازگشت برای اصلاح', cancelled: 'لغوشده' };
const leaveVisible = (u, pid) => can(u, 'absences', 'view') || (!!u.personnelId && u.personnelId === pid);
function leaveSteps() { return db.prepare('SELECT position, label, role FROM leave_approval_steps ORDER BY position').all(); }
function leaveAnnualDays() { const r = db.prepare("SELECT value FROM leave_settings WHERE key = 'annual_leave_days'").get(); return r ? Number(r.value) : null; }
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const canActOnStep = (u, step) => !!step && (u.root || u.role === step.role);
route('GET', '/api/leave/settings', (ctx) => {
  need(ctx.user, 'absences', 'view');
  const annual = leaveAnnualDays();
  return { annualDays: annual, steps: leaveSteps(), roles: REF.ROLE_NAMES, canEdit: can(ctx.user, 'users', 'edit'),
    warnings: [annual === null ? 'سهمیه سالانه مرخصی هنوز تنظیم نشده است؛ مانده مرخصی محاسبه نمی‌شود.' : null, leaveSteps().length ? null : 'زنجیره تأیید تنظیم نشده است؛ درخواست جدید ثبت نمی‌شود.'].filter(Boolean),
    initialNote: 'زنجیره تأیید و سهمیه پیش‌فرض، تنظیمات اولیه هستند و قوانین رسمی شرکت نیستند.' };
});
route('PUT', '/api/leave/settings', (ctx) => {
  need(ctx.user, 'users', 'edit');
  const b = ctx.body, e = {};
  let annual = null;
  if (b.annualDays !== null && b.annualDays !== undefined && b.annualDays !== '') {
    annual = Number(b.annualDays);
    if (!Number.isInteger(annual) || annual < 0 || annual > 366) e.annualDays = 'سهمیه سالانه بین ۰ تا ۳۶۶ روز';
  }
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (steps.length > 6) e.steps = 'حداکثر ۶ مرحله';
  const clean = steps.map((x, i) => ({ label: String(x.label ?? '').trim(), role: String(x.role ?? '') }));
  clean.forEach((x, i) => { if (x.label.length < 2 || x.label.length > 60) e.steps = `مرحله ${i + 1}: عنوان ۲ تا ۶۰ نویسه`; if (!REF.ROLE_NAMES.includes(x.role)) e.steps = `مرحله ${i + 1}: نقش نامعتبر است`; });
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM leave_approval_steps').run();
    clean.forEach((x, i) => db.prepare('INSERT INTO leave_approval_steps (position,label,role) VALUES (?,?,?)').run(i + 1, x.label, x.role));
    db.prepare(`INSERT INTO leave_settings (key,value,updated_at) VALUES ('annual_leave_days', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(annual === null ? '' : String(annual), now);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  audit(ctx.user, { action: 'update', section: 'users', entity: 'تنظیمات مرخصی', recordId: null, description: 'به‌روزرسانی سهمیه و زنجیره تأیید مرخصی' });
  return { ok: true };
});
const leaveOut = (r) => ({ id: r.id, personnelId: r.personnel_id, personnelName: (() => { const p = db.prepare('SELECT first_name, last_name FROM personnel WHERE id = ?').get(r.personnel_id); return p ? `${p.first_name} ${p.last_name}` : ''; })(),
  kind: r.kind, startDate: r.start_date, endDate: r.end_date, days: r.days, destination: r.destination || '', reason: r.reason || '',
  status: r.status, statusLabel: LEAVE_STATUS[r.status], currentStep: r.current_step, createdAt: r.created_at });
route('GET', '/api/leave/requests', (ctx) => {
  const u = ctx.user;
  const full = can(u, 'absences', 'view');
  if (!full && !u.personnelId) return { items: [], ownOnly: true };
  let rows = full ? db.prepare('SELECT * FROM leave_requests ORDER BY id DESC LIMIT 1000').all() : db.prepare('SELECT * FROM leave_requests WHERE personnel_id = ? ORDER BY id DESC').all(u.personnelId);
  const st = ctx.query.get('status') || '';
  if (st && LEAVE_STATUS[st]) rows = rows.filter((r) => r.status === st);
  return { items: rows.map(leaveOut), ownOnly: !full, statuses: LEAVE_STATUS, kinds: LEAVE_KINDS, canCreate: can(u, 'absences', 'create') || !!u.personnelId };
});
route('POST', '/api/leave/requests', (ctx) => {
  const u = ctx.user;
  const f = ctx.form ? ctx.form.fields : ctx.body;
  const pid = idOf(f.personnelId);
  if (!pid || !db.prepare('SELECT id FROM personnel WHERE id = ?').get(pid)) fail(422, 'اطلاعات نامعتبر است', { personnelId: 'پرسنل را انتخاب کنید' });
  if (!leaveVisible(u, pid) && !can(u, 'absences', 'create')) fail(403, 'ثبت درخواست برای این پرسنل مجاز نیست');
  const e = {};
  const kind = String(f.kind ?? ''), start = String(f.startDate ?? '').trim(), end = String(f.endDate ?? '').trim();
  const destination = String(f.destination ?? '').trim(), reason = String(f.reason ?? '').trim();
  if (!LEAVE_KINDS.includes(kind)) e.kind = 'نوع درخواست را انتخاب کنید';
  if (!J.isValidISO(start)) e.startDate = 'تاریخ شروع معتبر نیست';
  if (!J.isValidISO(end)) e.endDate = 'تاریخ پایان معتبر نیست';
  else if (J.isValidISO(start) && end < start) e.endDate = 'تاریخ پایان قبل از شروع است';
  if (kind === 'مأموریت' && (destination.length < 2 || destination.length > 150)) e.destination = 'مقصد مأموریت را وارد کنید';
  if (reason.length > 500) e.reason = 'توضیحات حداکثر ۵۰۰ نویسه';
  if (!leaveSteps().length) fail(422, 'زنجیره تأیید تنظیم نشده است. ابتدا از تنظیمات مرخصی مراحل تأیید را تعیین کنید.');
  const upload = ctx.form ? ctx.form.fileList.filter((x) => x.field.startsWith('file')) : [];
  if (upload.length > 5) e.file = 'حداکثر ۵ پیوست';
  const files = upload.map((x) => checkFile(x));
  if (Object.keys(e).length) fail(422, 'اطلاعات نامعتبر است', e);
  const now = new Date().toISOString();
  const stored = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('INSERT INTO leave_requests (personnel_id,kind,start_date,end_date,days,destination,reason,status,current_step,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(pid, kind, start, end, daysBetween(start, end), destination || null, reason || null, 'pending', 1, u.id, now, now);
    db.prepare('INSERT INTO leave_request_events (request_id,action,step,note,actor_id,created_at) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, 'submitted', 1, null, u.id, now);
    for (const file of files) {
      const name = writeStored(file); stored.push(name);
      db.prepare('INSERT INTO leave_attachments (request_id,file_name,stored_name,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, file.name, name, file.mime, file.data.length, now);
    }
    db.exec('COMMIT');
    audit(u, { action: 'create', section: 'absences', entity: `درخواست ${kind}`, recordId: r.lastInsertRowid, description: `ثبت ${kind} از ${start} تا ${end}` });
    return [201, leaveOut(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.lastInsertRowid))];
  } catch (err) { db.exec('ROLLBACK'); stored.forEach(removeStored); throw err; }
}, { multipart: true });
route('GET', '/api/leave/requests/:id', (ctx) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(idOf(ctx.params.id));
  if (!r || !leaveVisible(ctx.user, r.personnel_id)) fail(404, 'درخواست یافت نشد');
  const steps = leaveSteps();
  const step = steps.find((s) => s.position === r.current_step);
  const requesterIsMe = ctx.user.personnelId === r.personnel_id;
  const canAct = r.status === 'pending' && !requesterIsMe && canActOnStep(ctx.user, step);
  const events = db.prepare('SELECT e.*, u.name AS actor FROM leave_request_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.request_id = ? ORDER BY e.id').all(r.id)
    .map((x) => ({ action: x.action, step: x.step, note: x.note || '', actor: x.actor || '—', at: x.created_at }));
  const attachments = db.prepare('SELECT id, file_name, size FROM leave_attachments WHERE request_id = ? ORDER BY id').all(r.id).map((a) => ({ id: a.id, fileName: a.file_name, size: a.size }));
  return { ...leaveOut(r), steps, currentStepLabel: step ? step.label : '', canAct, canResubmit: r.status === 'returned' && (requesterIsMe || can(ctx.user, 'absences', 'edit')), events, attachments };
});
route('POST', '/api/leave/requests/:id/action', (ctx) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(idOf(ctx.params.id));
  if (!r || !leaveVisible(ctx.user, r.personnel_id)) fail(404, 'درخواست یافت نشد');
  if (r.status !== 'pending') fail(422, 'این درخواست دیگر در جریان تأیید نیست');
  if (ctx.user.personnelId === r.personnel_id) fail(403, 'درخواست خودتان را نمی‌توانید تأیید کنید');
  const steps = leaveSteps();
  const step = steps.find((s) => s.position === r.current_step);
  if (!canActOnStep(ctx.user, step)) fail(403, `این مرحله (${step ? step.label : ''}) برای نقش شما نیست`);
  const action = String(ctx.body.action ?? ''), note = String(ctx.body.note ?? '').trim();
  if (!['approve', 'reject', 'return'].includes(action)) fail(422, 'عملیات نامعتبر است');
  if (note.length > 500) fail(422, 'اطلاعات نامعتبر است', { note: 'یادداشت حداکثر ۵۰۰ نویسه' });
  if ((action === 'reject' || action === 'return') && note.length < 2) fail(422, 'برای رد یا بازگشت، توضیح لازم است', { note: 'توضیح را وارد کنید' });
  const now = new Date().toISOString();
  let status = r.status, cur = r.current_step;
  if (action === 'reject') status = 'rejected';
  else if (action === 'return') status = 'returned';
  else if (cur >= steps.length) status = 'approved';
  else cur = cur + 1;
  db.prepare('UPDATE leave_requests SET status = ?, current_step = ?, updated_at = ? WHERE id = ?').run(status, cur, now, r.id);
  db.prepare('INSERT INTO leave_request_events (request_id,action,step,note,actor_id,created_at) VALUES (?,?,?,?,?,?)').run(r.id, action === 'approve' ? (status === 'approved' ? 'approved' : 'forwarded') : action === 'reject' ? 'rejected' : 'returned', r.current_step, note || null, ctx.user.id, now);
  audit(ctx.user, { action: 'update', section: 'absences', entity: 'گردش مرخصی', recordId: r.id, description: `${LEAVE_STATUS[status]} — ${step ? step.label : ''}`, changes: [{ field: 'وضعیت', from: LEAVE_STATUS[r.status], to: LEAVE_STATUS[status] }] });
  return leaveOut(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id));
});
route('POST', '/api/leave/requests/:id/resubmit', (ctx) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(idOf(ctx.params.id));
  if (!r || !leaveVisible(ctx.user, r.personnel_id)) fail(404, 'درخواست یافت نشد');
  if (r.status !== 'returned') fail(422, 'فقط درخواست بازگشت‌داده‌شده را می‌توان دوباره ارسال کرد');
  if (ctx.user.personnelId !== r.personnel_id && !can(ctx.user, 'absences', 'edit')) fail(403, 'فقط درخواست‌کننده می‌تواند اصلاح و ارسال کند');
  const start = String(ctx.body.startDate ?? r.start_date), end = String(ctx.body.endDate ?? r.end_date);
  const reason = String(ctx.body.reason ?? r.reason ?? '').trim();
  if (!J.isValidISO(start) || !J.isValidISO(end) || end < start) fail(422, 'بازه تاریخ معتبر نیست');
  const now = new Date().toISOString();
  db.prepare("UPDATE leave_requests SET status = 'pending', current_step = 1, start_date = ?, end_date = ?, days = ?, reason = ?, updated_at = ? WHERE id = ?").run(start, end, daysBetween(start, end), reason || null, now, r.id);
  db.prepare('INSERT INTO leave_request_events (request_id,action,step,note,actor_id,created_at) VALUES (?,?,?,?,?,?)').run(r.id, 'resubmitted', 1, null, ctx.user.id, now);
  return leaveOut(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id));
});
route('GET', '/api/leave/balance/:personnelId', (ctx) => {
  const pid = idOf(ctx.params.personnelId);
  if (!pid || !leaveVisible(ctx.user, pid)) fail(403, 'دسترسی ندارید');
  const year = String(new Date().getFullYear());
  const used = db.prepare("SELECT COALESCE(SUM(days),0) AS n FROM leave_requests WHERE personnel_id = ? AND kind = 'مرخصی' AND status = 'approved' AND substr(start_date,1,4) = ?").get(pid, year).n;
  const annual = leaveAnnualDays();
  return { year: Number(year), annualDays: annual, usedDays: used, balance: annual === null ? null : annual - used,
    note: annual === null ? 'سهمیه سالانه تنظیم نشده است؛ مانده محاسبه نمی‌شود.' : 'مانده بر اساس سهمیه تنظیم‌شده و مرخصی‌های تأییدشده محاسبه شده است.' };
});
route('GET', '/api/leave/requests/:id/attachments/:aid/download', (ctx) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(idOf(ctx.params.id));
  if (!r || !leaveVisible(ctx.user, r.personnel_id)) fail(403, 'دسترسی ندارید');
  const a = db.prepare('SELECT * FROM leave_attachments WHERE id = ? AND request_id = ?').get(idOf(ctx.params.aid), r.id);
  if (!a) fail(404, 'پیوست یافت نشد');
  const full = path.join(UPLOAD_DIR, path.basename(a.stored_name));
  if (!fs.existsSync(full)) fail(404, 'فایل روی سرور یافت نشد');
  return { raw: fs.readFileSync(full), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } };
});

module.exports = { match, ROUTES, normBool };
