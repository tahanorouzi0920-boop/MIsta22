'use strict';

// Dates are stored as ISO 'YYYY-MM-DD' strings. Jalali conversion uses the
// runtime's Persian calendar (full ICU is included in Node). UTC is used
// internally to avoid off-by-one-day shifts. "Today" follows Asia/Tehran.

const TEH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
const JF = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const FA = '۰۱۲۳۴۵۶۷۸۹';
const MIN_YEAR = 1350;
const MAX_YEAR = 1410;

const toFa = (s) => String(s ?? '').replace(/\d/g, (d) => FA[d]);
const todayISO = () => TEH.format(new Date());
const msOf = (iso) => Date.parse(iso + 'T00:00:00Z');
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => isoOf(msOf(iso) + n * 864e5);

function jparts(ms) {
  const p = JF.formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return [g('year'), g('month'), g('day')];
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function jToMs(y, m, d) {
  let g = Date.UTC(y + 621, 2, 21);
  for (let i = 0; i < 900; i++) {
    const c = cmp(jparts(g), [y, m, d]);
    if (!c) return g;
    g += c < 0 ? 864e5 : -864e5;
  }
  return null;
}

function isValidISO(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const ms = msOf(iso);
  if (Number.isNaN(ms) || isoOf(ms) !== iso) return false;
  const y = jparts(ms)[0];
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

function fmtJ(iso) {
  if (!iso) return '—';
  const [y, m, d] = jparts(msOf(iso));
  return toFa(`${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`);
}

// Tehran day boundaries expressed as UTC ISO strings (Iran has no DST since 2022).
const dayStartUTC = (iso) => new Date(Date.parse(iso + 'T00:00:00+03:30')).toISOString();
const dayEndUTC = (iso) => new Date(Date.parse(iso + 'T23:59:59.999+03:30')).toISOString();

module.exports = {
  todayISO, msOf, isoOf, addDays, jparts, jToMs, isValidISO, fmtJ, toFa,
  dayStartUTC, dayEndUTC, MIN_YEAR, MAX_YEAR,
};
