'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'server', 'geo', 'source');
const cities = require(path.join(SRC, 'cities.json'));
const provinces = require(path.join(SRC, 'provinces.json'));
const GEO = require(path.join(ROOT, 'server', 'geo', 'geo-data.json'));
const { convert, SOURCE_PROVINCE, isUrbanDistrict, normName } = require(path.join(ROOT, 'tools', 'convert-geo-json.js'));

test('source files: 1672 records and 31 provinces, every record has a known province', () => {
  assert.equal(cities.length, 1672);
  assert.equal(provinces.length, 31);
  const known = new Set(provinces.map((p) => p.id));
  assert.ok(cities.every((c) => known.has(c.province_id)));
});

test('province names in the source match the mapping used by the converter', () => {
  for (const p of provinces) assert.equal(SOURCE_PROVINCE[p.id], p.name);
});

test('imported dataset: 31 provinces, unique city IDs, every city belongs to an existing province', () => {
  assert.equal(GEO.provinces.length, 31);
  const codes = new Set(GEO.provinces.map((p) => p.code));
  assert.ok(GEO.cities.every((c) => codes.has(c.provinceCode)));
  assert.equal(new Set(GEO.cities.map((c) => c.id)).size, GEO.cities.length);
  assert.equal(GEO.cities.length, 1454);
});

test('every source record is accounted for: cities + urban districts + set-aside duplicates = 1672', () => {
  const res = convert(cities, GEO, { skipDuplicates: true });
  assert.equal(res.cities.length, 1454);
  assert.equal(res.districts.length, 212);
  assert.equal(res.unresolved.length, 6);
  assert.equal(res.cities.length + res.districts.length + res.unresolved.length, 1672);
});

test('no urban district name ends up in the city list', () => {
  assert.ok(GEO.cities.every((c) => !isUrbanDistrict(normName(c.name))));
});

test('no two cities in one province share a name', () => {
  const seen = new Set();
  for (const c of GEO.cities) {
    const k = c.provinceCode + '|' + c.name.replace(/[\u200c ]/g, '');
    assert.ok(!seen.has(k), `duplicate name in province: ${c.name}`);
    seen.add(k);
  }
});
