'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CONVERT = path.join(ROOT, 'tools', 'convert-geo-json.js');
const IMPORT = path.join(ROOT, 'tools', 'import-geo.js');
const GEO = require(path.join(ROOT, 'server', 'geo', 'geo-data.json'));
const SAMPLE = path.join(__dirname, 'fixtures', 'geo-sample.json');
const DUP = path.join(__dirname, 'fixtures', 'geo-duplicate.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-conv-'));

const { convert, isUrbanDistrict, matchKey } = require(CONVERT);
const readCsv = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').trim().split('\n').map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));

test('urban districts are recognised and never become cities', () => {
  assert.equal(isUrbanDistrict('اراک 1'), true);
  assert.equal(isUrbanDistrict('یزد_منطقه تاریخی'), true);
  assert.equal(isUrbanDistrict('تهران'), false);
});

test('matching ignores ZWNJ, spaces and Arabic letter variants', () => {
  assert.equal(matchKey('خرم‌آباد'), matchKey('خرم آباد'));
  assert.equal(matchKey('كرج'), matchKey('کرج'));
});

test('sample conversion: 9 cities, 1 urban district, existing IDs kept', () => {
  const out = path.join(tmp, 'cities.csv'), dist = path.join(tmp, 'districts.csv');
  const r = spawnSync(process.execPath, [CONVERT, SAMPLE, out, '--districts', dist], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = readCsv(out);
  assert.equal(rows.length - 1, 9, 'urban district must not be counted as a city');
  assert.ok(!rows.some((x) => x[3] === 'اراک 1'));
  const dRows = readCsv(dist);
  assert.equal(dRows.length - 1, 1);
  assert.equal(dRows[1][2], 'اراک 1');
  const tehranExisting = GEO.cities.find((c) => c.name === 'تهران' && c.provinceCode === 'P08');
  const tehranRow = rows.find((x) => x[3] === 'تهران');
  assert.equal(tehranRow[2], tehranExisting.id, 'existing city ID must be preserved');
});

test('new cities get IDs in their own province, never reusing existing IDs', () => {
  const out = path.join(tmp, 'cities2.csv');
  spawnSync(process.execPath, [CONVERT, SAMPLE, out], { encoding: 'utf8' });
  const ids = readCsv(out).slice(1).map((x) => x[2]);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  const existingIds = new Set(GEO.cities.map((c) => c.id));
  const newOnes = ids.filter((id) => !existingIds.has(id));
  newOnes.forEach((id) => assert.match(id, /^P\d{2}-\d{3}$/));
});

test('same name twice in one province is refused and nothing is written', () => {
  const out = path.join(tmp, 'dup.csv');
  const r = spawnSync(process.execPath, [CONVERT, DUP, out], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /نام تکراری/);
  assert.equal(fs.existsSync(out), false);
});

test('import tool refuses a partial sample that would remove existing cities', () => {
  const out = path.join(tmp, 'partial.csv');
  spawnSync(process.execPath, [CONVERT, SAMPLE, out], { encoding: 'utf8' });
  const before = fs.readFileSync(path.join(ROOT, 'server', 'geo', 'geo-data.json'), 'utf8');
  const r = spawnSync(process.execPath, [IMPORT, out, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(path.join(ROOT, 'server', 'geo', 'geo-data.json'), 'utf8'), before);
});
