#!/usr/bin/env node
'use strict';

/*
 * Usage:
 *   node tools/import-geo.js <input.csv> [--dry-run]
 *
 * Input CSV (UTF-8, header required):
 *   province_code,province_name,city_id,city_name
 *   P01,آذربایجان شرقی,P01-001,تبریز
 *
 * Rules:
 *  - Every province must have a code (P01..P31) and a unique name; exactly 31 provinces are required.
 *  - city_id must be unique and must start with its province_code followed by '-'.
 *  - A city name must be unique inside its province.
 *  - Existing IDs in server/geo/geo-data.json are never renumbered. A city that existed before
 *    and is missing from the input is reported and the import is refused unless --allow-removal is given.
 *  - Nothing is written if validation fails.
 */

const fs = require('node:fs');
const path = require('node:path');

// Minimal RFC 4180 parser: quoted cells, doubled quotes inside quotes, commas inside quotes.
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const DATA_FILE = path.join(__dirname, '..', 'server', 'geo', 'geo-data.json');
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const allowRemoval = args.includes('--allow-removal');

function fail(msg) { console.error('خطا: ' + msg); process.exit(1); }

if (!input) fail('مسیر فایل CSV ورودی را وارد کنید.');

const lines = fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
const header = parseCsvLine(lines.shift());
const need = ['province_code', 'province_name', 'city_id', 'city_name'];
if (need.some((h) => !header.includes(h))) fail('ستون‌های لازم: ' + need.join(', '));
const idx = Object.fromEntries(need.map((h) => [h, header.indexOf(h)]));

const provinces = new Map();
const cities = [];
const errors = [];
lines.forEach((line, n) => {
  const cells = parseCsvLine(line);
  const row = { pc: cells[idx.province_code], pn: cells[idx.province_name], cid: cells[idx.city_id], cn: cells[idx.city_name] };
  const where = `سطر ${n + 2}`;
  if (!/^P\d{2}$/.test(row.pc)) { errors.push(`${where}: کد استان نامعتبر است (${row.pc})`); return; }
  if (!row.pn) errors.push(`${where}: نام استان خالی است`);
  if (provinces.has(row.pc) && provinces.get(row.pc) !== row.pn) errors.push(`${where}: کد ${row.pc} با دو نام مختلف آمده است`);
  provinces.set(row.pc, row.pn);
  if (!row.cn) { errors.push(`${where}: نام شهر خالی است`); return; }
  if (!row.cid.startsWith(row.pc + '-')) errors.push(`${where}: شناسه شهر باید با ${row.pc}- شروع شود`);
  cities.push({ id: row.cid, provinceCode: row.pc, name: row.cn, line: n + 2 });
});

if (provinces.size !== 31) errors.push(`تعداد استان‌ها باید ۳۱ باشد؛ شمارش‌شده: ${provinces.size}`);
const names = new Set();
for (const [code, name] of provinces) { if (names.has(name)) errors.push(`نام استان تکراری: ${name} (${code})`); names.add(name); }

const ids = new Map();
for (const c of cities) {
  if (ids.has(c.id)) errors.push(`سطر ${c.line}: شناسه تکراری ${c.id}`);
  ids.set(c.id, c);
}
const perProvince = new Map();
for (const c of cities) {
  const key = c.provinceCode + '|' + c.name;
  if (perProvince.has(key)) errors.push(`سطر ${c.line}: شهر «${c.name}» در استان ${c.provinceCode} تکراری است`);
  perProvince.set(key, true);
}

const current = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const newIds = new Set(cities.map((c) => c.id));
const removed = current.cities.filter((c) => !newIds.has(c.id));
if (removed.length && !allowRemoval) {
  errors.push(`${removed.length} شهر موجود در داده فعلی در فایل ورودی نیست (مثال: ${removed[0].id} ${removed[0].name}). برای حذف عمدی از --allow-removal استفاده کنید.`);
}
for (const old of current.cities) {
  const now = ids.get(old.id);
  if (now && (now.name !== old.name || now.provinceCode !== old.provinceCode)) {
    errors.push(`شناسه ${old.id} برای «${old.name}» ثابت است و در ورودی به «${now.name}» تغییر کرده؛ شناسه‌ها نباید تغییر کنند.`);
  }
}

if (errors.length) {
  console.error(`ورود داده رد شد؛ ${errors.length} مورد نامعتبر (${Math.min(30, errors.length)} مورد اول):`);
  errors.slice(0, 30).forEach((e) => console.error(' - ' + e));
  process.exit(2);
}

const data = {
  schema: 1,
  status: current.status,
  source: `وارد شده از ${path.basename(input)}`,
  sourceDate: new Date().toISOString().slice(0, 10),
  provinces: [...provinces].sort((a, b) => a[0].localeCompare(b[0])).map(([code, name]) => {
    const old = current.provinces.find((p) => p.code === code);
    return { code, name, capital: old?.capital ?? null };
  }),
  cities: cities.map(({ id, provinceCode, name }) => ({ id, provinceCode, name })).sort((a, b) => a.id.localeCompare(b.id)),
};

console.log(`استان‌ها: ${data.provinces.length}، شهرها: ${data.cities.length}، شهرهای حذف‌شده: ${removed.length}`);
if (dryRun) { console.log('حالت آزمایشی: چیزی نوشته نشد.'); process.exit(0); }
fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
console.log('داده جغرافیایی با موفقیت نوشته شد:', DATA_FILE);
