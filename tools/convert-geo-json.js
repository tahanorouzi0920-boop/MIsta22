#!/usr/bin/env node
'use strict';

/*
 * Usage:
 *   node tools/convert-geo-json.js <source.json> <out-cities.csv> [--districts <out-districts.csv>]
 *
 * Source: JSON array of records with fields id, name, slug, province_id, county_id, district_id.
 * Output: CSV in the format read by tools/import-geo.js (then run that tool to validate and write).
 *
 * Rules:
 *  - province_id is mapped to a province by its official name (see SOURCE_PROVINCE). Unknown ids are errors.
 *  - Names are normalised (whitespace collapsed, Arabic ي/ك to Persian ی/ک). Matching ignores ZWNJ and spaces.
 *  - Names that end with a number, or contain '_' (e.g. "تبریز 9", "یزد_منطقه تاریخی"), are urban
 *    districts (نواحی شهری) and are NOT cities. They are written to the districts file, never to the cities list.
 *  - Existing city IDs (server/geo/geo-data.json) are kept for cities that match by province and name.
 *    New cities get the next free sequence number in their province, ordered by source id (deterministic).
 *  - Two records with the same name in the same province are an error. Nothing is written in that case.
 */

const fs = require('node:fs');
const path = require('node:path');

const GEO_FILE = path.join(__dirname, '..', 'server', 'geo', 'geo-data.json');

// Source province_id -> official province name (as used in geo-data.json).
const SOURCE_PROVINCE = {
  100: 'مرکزی', 101: 'گیلان', 102: 'مازندران', 103: 'آذربایجان شرقی', 104: 'آذربایجان غربی',
  105: 'کرمانشاه', 106: 'خوزستان', 107: 'فارس', 108: 'کرمان', 109: 'خراسان رضوی', 110: 'اصفهان',
  111: 'سیستان و بلوچستان', 112: 'کردستان', 113: 'همدان', 114: 'چهارمحال و بختیاری', 115: 'لرستان',
  116: 'ایلام', 117: 'کهگیلویه و بویراحمد', 118: 'بوشهر', 119: 'زنجان', 120: 'سمنان', 121: 'یزد',
  122: 'هرمزگان', 123: 'تهران', 124: 'اردبیل', 125: 'قم', 126: 'قزوین', 127: 'گلستان',
  128: 'خراسان شمالی', 129: 'خراسان جنوبی', 130: 'البرز',
};

const normName = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/\u064a/g, 'ی').replace(/\u0643/g, 'ک');
const matchKey = (s) => normName(s).replace(/[\u200c\u200f\u200e ]/g, '');
const isUrbanDistrict = (name) => /\d\s*$/.test(name) || name.includes('_');
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function fail(msg, code = 2) { console.error('خطا: ' + msg); process.exit(code); }

function convert(records, geo, opts = {}) {
  const provByName = Object.fromEntries(geo.provinces.map((p) => [p.name, p.code]));
  const existing = new Map();
  for (const c of geo.cities) existing.set(c.provinceCode + '|' + matchKey(c.name), c);
  const seq = {};
  for (const c of geo.cities) {
    const n = Number(c.id.split('-')[1]);
    seq[c.provinceCode] = Math.max(seq[c.provinceCode] || 0, n);
  }
  const errors = [], cities = [], districts = [], seen = new Map(), unresolved = [];
  const dupKeys = new Set();
  const sorted = [...records].sort((a, b) => Number(a.id) - Number(b.id));
  for (const r of sorted) {
    const pn = SOURCE_PROVINCE[r.province_id];
    if (!pn || !provByName[pn]) { errors.push(`province_id ناشناخته در رکورد ${r.id}: ${r.province_id}`); continue; }
    const pc = provByName[pn];
    const name = normName(r.name || '');
    if (!name) { errors.push(`نام خالی در رکورد ${r.id}`); continue; }
    if (isUrbanDistrict(name)) { districts.push({ sourceId: r.id, provinceCode: pc, name }); continue; }
    const key = pc + '|' + matchKey(name);
    if (seen.has(key) || dupKeys.has(key)) {
      if (opts.skipDuplicates) { if (!dupKeys.has(key)) { dupKeys.add(key); } unresolved.push({ sourceId: r.id, provinceName: pn, name, reason: 'نام تکراری در همان استان' }); continue; }
      errors.push(`نام تکراری در استان ${pn}: «${name}» (رکوردهای ${seen.get(key)} و ${r.id})`); continue;
    }
    seen.set(key, r.id);
    const old = existing.get(key);
    let id;
    if (old) id = old.id;
    else { seq[pc] = (seq[pc] || 0) + 1; id = `${pc}-${String(seq[pc]).padStart(3, '0')}`; }
    cities.push({ id, provinceCode: pc, provinceName: pn, name: old ? old.name : name, sourceId: r.id });
  }
  if (opts.skipDuplicates && dupKeys.size) {
    // The first occurrence was already accepted; set it aside too, so neither record is attached to the wrong place.
    for (const key of dupKeys) {
      const firstSource = seen.get(key);
      const idx = cities.findIndex((c) => c.sourceId === firstSource);
      if (idx >= 0) {
        const c = cities[idx];
        unresolved.push({ sourceId: c.sourceId, provinceName: c.provinceName, name: c.name, reason: 'نام تکراری در همان استان' });
        cities.splice(idx, 1);
      }
    }
  }
  const sourceNames = new Set(cities.map((c) => c.id));
  const missingExisting = geo.cities.filter((c) => !sourceNames.has(c.id));
  return { cities, districts, errors, missingExisting, unresolved };
}

function main() {
  const args = process.argv.slice(2);
  const dIdx = args.indexOf('--districts');
  const districtsOut = dIdx >= 0 ? args[dIdx + 1] : null;
  const uIdx = args.indexOf('--unresolved');
  const pos = args.filter((a, i) => !a.startsWith('--') && (dIdx < 0 || i !== dIdx + 1) && (uIdx < 0 || i !== uIdx + 1));
  const [src, out] = pos;
  if (!src || !out) fail('استفاده: node tools/convert-geo-json.js <source.json> <out.csv> [--districts <out.csv>]');

  let records;
  try { records = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { fail('فایل JSON خوانده نشد: ' + e.message); }
  if (!Array.isArray(records)) fail('ریشه فایل باید یک آرایه باشد.');
  const geo = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8'));
  const res = convert(records, geo, { skipDuplicates: args.includes('--skip-duplicates') });

  if (res.errors.length) {
    console.error(`تبدیل متوقف شد؛ ${res.errors.length} مورد نیاز به تصمیم دارد:`);
    res.errors.forEach((e) => console.error(' - ' + e));
    process.exit(2);
  }
  const lines = ['province_code,province_name,city_id,city_name,source_id'];
  for (const c of res.cities) lines.push([c.provinceCode, c.provinceName, c.id, c.name, c.sourceId].map(csvCell).join(','));
  fs.writeFileSync(out, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
  if (districtsOut) {
    const dl = ['source_id,province_code,name'];
    for (const d of res.districts) dl.push([d.sourceId, d.provinceCode, d.name].map(csvCell).join(','));
    fs.writeFileSync(districtsOut, '\uFEFF' + dl.join('\n') + '\n', 'utf8');
  }
  const ur = args.indexOf('--unresolved');
  if (ur >= 0 && args[ur + 1]) {
    const ul = ['source_id,province,name,reason'];
    for (const u of res.unresolved) ul.push([u.sourceId, u.provinceName, u.name, u.reason].map(csvCell).join(','));
    fs.writeFileSync(args[ur + 1], '\uFEFF' + ul.join('\n') + '\n', 'utf8');
  }
  console.log(`موارد تکراری کنار گذاشته‌شده: ${res.unresolved.length}`);
  const provinces = new Set(res.cities.map((c) => c.provinceCode));
  console.log(`شهرها: ${res.cities.length}؛ استان‌های دارای شهر: ${provinces.size}؛ نواحی شهری جداشده: ${res.districts.length}`);
  if (res.missingExisting.length) {
    console.log(`هشدار: ${res.missingExisting.length} شهر فعلی در فایل منبع پیدا نشد (مثال: ${res.missingExisting[0].id} ${res.missingExisting[0].name}). import-geo بدون --allow-removal آن‌ها را نمی‌پذیرد.`);
  }
  console.log('فایل CSV نوشته شد:', out);
}

module.exports = { convert, SOURCE_PROVINCE, normName, matchKey, isUrbanDistrict };

if (require.main === module) main();
