'use strict';

/* ================= Basics ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const FA = '۰۱۲۳۴۵۶۷۸۹';
const toFa = (s) => String(s ?? '').replace(/\d/g, (d) => FA[d]);
const normDigits = (s) => String(s ?? '').replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
const emptyRow = (n) => `<tr><td colspan="${n}" class="empty">موردی یافت نشد</td></tr>`;

let REF = null, ME = null, PERMS = {}, CUR = 'dashboard';
// Geographic helpers. Everything is keyed by stable province codes and city IDs from the server.
const geoCities = (provCode) => (REF.geo?.cities || []).filter((c) => c.provinceCode === provCode);
const geoProvinces = () => REF.geo?.provinces || [];
function fillProvinceSelect(sel, selected, filter = '', placeholder = 'انتخاب استان') {
  const list = geoProvinces().filter((p) => !filter || p.name.includes(filter) || p.code === selected);
  return opt(list.map((p) => [p.code, p.name]), selected, placeholder);
}
function fillCitySelect(provCode, selected, filter = '', placeholder = 'انتخاب شهر') {
  if (!provCode) return '<option value="">ابتدا استان را انتخاب کنید</option>';
  const list = geoCities(provCode).filter((c) => !filter || c.name.includes(filter) || c.id === selected);
  return list.length ? opt(list.map((c) => [c.id, c.name]), selected, placeholder) : '<option value="">شهری یافت نشد</option>';
}
const can = (s, a) => !!PERMS[s]?.[a];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2800);
}
function fieldErr(id, msg) {
  const el = document.getElementById(id), e = document.getElementById(id + '-e');
  if (el) el.classList.toggle('invalid', !!msg);
  if (e) e.textContent = msg || '';
  return !msg;
}
function clearErrs(root) {
  $$('.err', root).forEach((e) => { e.textContent = ''; });
  $$('.invalid', root).forEach((e) => e.classList.remove('invalid'));
}
// Maps server field errors to input ids. map: { serverField: 'elementId' }
function applyServerErrors(err, map) {
  let general = err.message;
  for (const [k, msg] of Object.entries(err.fields || {})) {
    if (map[k]) {
      if (map[k].startsWith('#')) { const el = document.getElementById(map[k].slice(1)); if (el) el.textContent = msg; }
      else fieldErr(map[k], msg);
    }
  }
  if (Object.keys(err.fields || {}).length) general = 'لطفاً خطاهای فرم را اصلاح کنید';
  toast(general);
}

/* ================= API ================= */
class ApiError extends Error {
  constructor(message, status, fields) { super(message); this.status = status; this.fields = fields || {}; }
}
// API base comes from public/config.js (empty = same origin). Same origin is required because the session cookie is SameSite=Strict.
const API_BASE = String(window.MISTA_API_BASE || '').replace(/\/$/, '');
async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(API_BASE + url, opts); } catch { throw new ApiError('اتصال به سرور برقرار نشد. اتصال اینترنت یا آدرس API را بررسی کنید.', 0, {}); }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  let data = {};
  if (isJson) { try { data = await res.json(); } catch { data = {}; } }
  if (res.status === 401 && !url.startsWith('/api/login')) {
    showLogin('نشست شما پایان یافته است؛ دوباره وارد شوید');
    throw new ApiError('unauthorized', 401, {});
  }
  if (!isJson && url.startsWith('/api/')) {
    // A static host answers API paths with a non-JSON 404/405. Report it as configuration, not as a server error.
    if (res.status === 404) throw new ApiError(`مسیر API پیدا نشد (۴۰۴) — بک‌اند به این آدرس وصل نیست. تنظیمات انتشار و آدرس API را بررسی کنید (${url}).`, 404, {});
    throw new ApiError(`پاسخ نامعتبر از سرور (${res.status}) برای ${url}. بک‌اند در دسترس نیست یا به‌درستی پیکربندی نشده است.`, res.status, {});
  }
  if (!res.ok) throw new ApiError(data.error || `خطای سرور (${res.status})`, res.status, data.fields);
  return data;
}
// status -1 marks an error already displayed on the form fields.
async function run(fn) {
  try { await fn(); } catch (e) { if (e.status !== 401 && e.status !== -1) toast(e.message); }
}

/* ================= Jalali calendar (client) ================= */
const TEH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
const JF = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const todayISO = () => TEH.format(new Date());
const msOf = (iso) => Date.parse(iso + 'T00:00:00Z');
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => isoOf(msOf(iso) + n * 864e5);
function jparts(ms) {
  const p = JF.formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return [g('year'), g('month'), g('day')];
}
const cmpJ = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function jToMs(y, m, d) {
  let g = Date.UTC(y + 621, 2, 21);
  for (let i = 0; i < 900; i++) {
    const c = cmpJ(jparts(g), [y, m, d]);
    if (!c) return g;
    g += c < 0 ? 864e5 : -864e5;
  }
  return null;
}
function jdim(y, m) {
  if (m <= 6) return 31;
  if (m <= 11) return 30;
  return jToMs(y, 12, 30) === null ? 29 : 30;
}
const MIN_Y = 1350, MAX_Y = 1410;
function parseJ(text) {
  const t = normDigits(text).replace(/-/g, '/');
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < MIN_Y || y > MAX_Y || mo < 1 || mo > 12 || d < 1 || d > jdim(y, mo)) return null;
  const ms = jToMs(y, mo, d);
  return ms === null ? null : isoOf(ms);
}
const fmtJ = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = jparts(msOf(iso));
  return toFa(`${y}/${pad(m)}/${pad(d)}`);
};
const fmtTs = (ts) => {
  const d = new Date(ts);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return fmtJ(TEH.format(d)) + ' ' + toFa(hm);
};

/* date picker */
const DPOPTS = {};
let DP_TARGET = null, DP_Y = 0, DP_M = 0;
function dateField(id, label, o = {}) {
  DPOPTS[id] = { max: o.max || null };
  return `<div class="field"><label for="${id}">${label}</label><div class="dwrap"><input class="input" id="${id}" inputmode="numeric" placeholder="۱۴۰۵/۰۱/۰۱" autocomplete="off"><button type="button" class="btn ghost sm" data-dp="${id}" aria-label="باز کردن تقویم">📅</button></div><div class="err" id="${id}-e"></div></div>`;
}
const setDate = (id, iso) => { $('#' + id).value = iso ? fmtJ(iso) : ''; };
// Returns { ok, iso }. Empty + optional => ok with ''.
function readDate(id, label, o = {}) {
  const v = $('#' + id).value.trim();
  if (!v) { fieldErr(id, o.required ? `${label} را وارد کنید` : ''); return { ok: !o.required, iso: '' }; }
  const iso = parseJ(v);
  if (!iso) { fieldErr(id, 'تاریخ نامعتبر است؛ نمونه: ۱۴۰۵/۰۱/۰۱ (سال از ۱۳۵۰ تا ۱۴۱۰)'); return { ok: false, iso: '' }; }
  if (o.max && iso > o.max) { fieldErr(id, 'تاریخ نمی‌تواند بعد از امروز باشد'); return { ok: false, iso: '' }; }
  fieldErr(id, '');
  return { ok: true, iso };
}
function openDP(id) {
  const input = $('#' + id), dp = $('#dp'), r = input.getBoundingClientRect();
  DP_TARGET = id;
  const base = parseJ(input.value) || DPOPTS[id]?.max || todayISO();
  [DP_Y, DP_M] = jparts(msOf(base));
  dp.classList.remove('hidden');
  dp.style.top = Math.min(r.bottom + 6, window.innerHeight - 380) + 'px';
  dp.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 316)) + 'px';
  renderDP();
}
function closeDP() { $('#dp').classList.add('hidden'); DP_TARGET = null; }
function yearOpts() { let s = ''; for (let y = MIN_Y; y <= MAX_Y; y++) s += `<option value="${y}" ${y === DP_Y ? 'selected' : ''}>${toFa(y)}</option>`; return s; }
function renderDP() {
  const max = DPOPTS[DP_TARGET]?.max || null, sel = parseJ($('#' + DP_TARGET).value), today = todayISO();
  const days = jdim(DP_Y, DP_M), first = jToMs(DP_Y, DP_M, 1), off = (new Date(first).getUTCDay() + 1) % 7;
  let cells = '';
  for (let i = 0; i < off; i++) cells += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const iso = isoOf(first + (d - 1) * 864e5), dis = max && iso > max;
    cells += `<button type="button" class="dday ${iso === sel ? 'on' : ''} ${iso === today ? 'today' : ''}" data-dday="${d}" ${dis ? 'disabled' : ''}>${toFa(d)}</button>`;
  }
  const monthSel = MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === DP_M ? 'selected' : ''}>${m}</option>`).join('');
  $('#dp').innerHTML = `<div class="dhead"><button type="button" class="btn ghost sm" data-dnav="-1">ماه قبل</button>
    <select class="input" id="dpM" aria-label="ماه">${monthSel}</select><select class="input" id="dpY" aria-label="سال">${yearOpts()}</select>
    <button type="button" class="btn ghost sm" data-dnav="1">ماه بعد</button></div>
    <div class="dgrid">${WEEKDAYS.map((w) => `<span class="dwd">${w}</span>`).join('')}${cells}</div>
    <div class="acts"><button type="button" class="btn ghost sm" data-dclear="1">پاک‌کردن</button><button type="button" class="btn ghost sm" data-dtoday="1">امروز</button></div>`;
}
$('#dp').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !DP_TARGET) return;
  if (b.dataset.dnav) {
    DP_M += Number(b.dataset.dnav);
    if (DP_M < 1) { DP_M = 12; DP_Y--; }
    if (DP_M > 12) { DP_M = 1; DP_Y++; }
    renderDP();
  } else if (b.dataset.dday) {
    setDate(DP_TARGET, isoOf(jToMs(DP_Y, DP_M, Number(b.dataset.dday))));
    fieldErr(DP_TARGET, '');
    closeDP();
  } else if (b.dataset.dclear) { $('#' + DP_TARGET).value = ''; closeDP(); }
  else if (b.dataset.dtoday) {
    const t = todayISO(), mx = DPOPTS[DP_TARGET]?.max;
    if (!mx || t <= mx) { setDate(DP_TARGET, t); fieldErr(DP_TARGET, ''); closeDP(); } else toast('امروز بیشتر از حد مجاز است');
  }
});
$('#dp').addEventListener('change', (e) => {
  if (e.target.id === 'dpM') DP_M = Number(e.target.value);
  if (e.target.id === 'dpY') DP_Y = Number(e.target.value);
  renderDP();
});

/* ================= Plate component ================= */
function plateHTML(p, v = {}) {
  return `<div class="field"><label>پلاک خودرو</label>
  <div class="plate" data-plate="${p}" dir="ltr">
    <div class="pf"><span>دو رقم</span><input class="input" id="${p}-a" inputmode="numeric" maxlength="2" value="${toFa(v.a || '')}" placeholder="۲۱"></div>
    <div class="pfix">ایران</div>
    <div class="pf"><span>سه رقم</span><input class="input" id="${p}-b" inputmode="numeric" maxlength="3" value="${toFa(v.b || '')}" placeholder="۴۴۳"></div>
    <div class="pf"><span>حرف</span><select class="input" id="${p}-c"><option value="">انتخاب</option>${REF.plateLetters.map((l) => `<option ${v.c === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="pf"><span>کد منطقه</span><input class="input" id="${p}-d" inputmode="numeric" maxlength="2" value="${toFa(v.d || '')}" placeholder="۸۳"></div>
  </div>
  <div class="note" id="${p}-prev"></div><div class="err" id="${p}-e"></div></div>`;
}
function plateRead(p) {
  const n = (k) => normDigits($('#' + p + '-' + k).value);
  return { a: n('a'), b: n('b'), c: $('#' + p + '-c').value, d: n('d') };
}
function updPlate(p) {
  const pl = plateRead(p), el = $('#' + p + '-prev');
  el.textContent = (pl.a || pl.b || pl.c || pl.d) ? 'پیش‌نمایش: ' + toFa(`${pl.a || '__'} ایران ${pl.b || '___'} ${pl.c || '_'} ${pl.d || '__'}`) : '';
}
document.addEventListener('input', (e) => {
  const t = e.target, box = t.closest && t.closest('[data-plate]');
  if (!box) return;
  const lim = { a: 2, b: 3, d: 2 }[t.id.split('-').pop()];
  if (lim) t.value = toFa(normDigits(t.value).replace(/\D/g, '').slice(0, lim));
  updPlate(box.dataset.plate);
});
document.addEventListener('change', (e) => { const box = e.target.closest && e.target.closest('[data-plate]'); if (box) updPlate(box.dataset.plate); });
// LRI..PDI isolate keeps the plate in logical order (2 digits, ایران, 3 digits, letter, 2 digits) inside RTL text.
const plainPlate = (p) => toFa(`${p.a} ایران ${p.b} ${p.c} ${p.d}`);
const plateStr = (p) => `<span dir="ltr" class="plate-txt">${toFa(`${p.a} ایران ${p.b} ${p.c} ${p.d}`)}</span>`;

/* ================= Modal ================= */
let MODAL_ON_CLOSE = null;
function openModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="card" role="dialog" aria-modal="true"><button type="button" class="modal-x" data-act="close" aria-label="بستن" title="بستن">✕</button>${html}</div>`;
  m.classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal').innerHTML = '';
  const f = MODAL_ON_CLOSE;
  MODAL_ON_CLOSE = null;
  if (f) f();
}
// A click on the dark area does not close a dialog; only the ✕ button does.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDP(); } });
function confirmBox(title, msg, onOk) {
  openModal(`<h3>${title}</h3><p>${msg}</p><div class="acts"><button class="btn danger" id="okDel">تأیید</button><button class="btn ghost" data-act="close">انصراف</button></div>`);
  $('#okDel').onclick = () => { closeModal(); run(onOk); };
}
const opt = (list, sel = '', ph = 'انتخاب کنید') => `<option value="">${ph}</option>` + list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const simple = (arr) => arr.map((x) => [x, x]);

/* ================= Auth & navigation ================= */
function showLogin(msg) {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-e').textContent = msg || '';
}
$('#togglePw').onclick = () => { const p = $('#lp'), show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('#togglePw').textContent = show ? 'پنهان' : 'نمایش'; };
async function attemptLogin() {
  const u = $('#lu').value.trim(), p = $('#lp').value;
  $('#login-e').textContent = '';
  let ok = true;
  ok &= fieldErr('lu', !u ? 'نام کاربری را وارد کنید' : '');
  ok &= fieldErr('lp', !p ? 'رمز عبور را وارد کنید' : '');
  if (!ok) return;
  try {
    const r = await api('POST', '/api/login', { username: u, password: p });
    $('#lp').value = '';
    await enterApp(r);
  } catch (e) {
    $('#login-e').textContent = e.message;
  }
}
$('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); attemptLogin(); });
$('#loginBtn').addEventListener('click', (e) => { e.preventDefault(); attemptLogin(); });
$('#logout').onclick = () => run(async () => {
  await api('POST', '/api/logout');
  ME = null; PERMS = {};
  showLogin('');
});

async function enterApp(r) {
  ME = r.user; PERMS = r.perms;
  if (!REF) REF = await api('GET', '/api/reference');
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#pUser').value = ME.username; $('#pName').value = ME.name;
  $('#pRole').value = ME.root ? 'مدیر اصلی (مدیر سیستم)' : ME.role;
  initFilters();
  applyPermissions();
  await go('dashboard');
}
function applyPermissions() {
  $$('#nav [data-sec]').forEach((b) => b.classList.toggle('hidden', !can(b.dataset.sec, 'view')));
  $$('[data-sec]').filter((el) => !el.closest('#nav') && !el.hasAttribute('data-view'))
    .forEach((el) => el.classList.toggle('hidden', !can(el.dataset.sec, 'view')));
  $$('[data-need]').forEach((b) => { const [s, a] = b.dataset.need.split('.'); b.classList.toggle('hidden', !can(s, a)); });
}
function buildNav() {
  const nav = $('#nav');
  let cur = null, top = null;
  [...nav.children].forEach((el) => {
    if (el.classList.contains('solo')) { cur = null; top = null; return; }
    if (el.classList.contains('grp')) {
      const sub = el.classList.contains('sub');
      const parent = sub && top ? top : nav;
      const wrap = document.createElement('div');
      wrap.className = sub ? 'navgrp navsub' : 'navgrp';
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'grphead';
      h.setAttribute('aria-expanded', 'false');
      h.innerHTML = `<span>${esc(el.textContent)}</span><span class="chev" aria-hidden="true">▾</span>`;
      const body = document.createElement('div'); body.className = 'grpbody';
      const inner = document.createElement('div'); inner.className = 'grpin';
      body.appendChild(inner);
      wrap.append(h, body);
      wrap.classList.add('collapsed');
      wrap._head = h;
      h.addEventListener('click', () => {
        const open = h.getAttribute('aria-expanded') === 'true';
        h.setAttribute('aria-expanded', String(!open));
        wrap.classList.toggle('collapsed', open);
      });
      if (sub) { el.remove(); parent.appendChild(wrap); } else el.replaceWith(wrap);
      if (!sub) top = inner;
      cur = inner;
    } else if (cur) cur.appendChild(el);
  });
}
const PAGE_SEC = { documents: 'documents', vehicledocs: 'documents', drivers: 'drivers', vehicles: 'vehicles', doctypes: 'doctypes' };
async function go(page) {
  mountRefreshControls();
  const sec = $(`#nav [data-page="${page}"]`)?.dataset.sec || PAGE_SEC[page];
  if (sec && !can(sec, 'view')) { toast('دسترسی به این بخش ندارید'); page = 'dashboard'; }
  CUR = page;
  $$('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== page));
  $$('#nav [data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const btn = $(`#nav [data-page="${page}"]`), grp = btn?.closest('.navgrp');
  if (grp && grp.classList.contains('collapsed')) { grp.classList.remove('collapsed'); grp._head.setAttribute('aria-expanded', 'true'); }
  $('#title').textContent = btn?.textContent.trim() || 'داشبورد';
  await run(() => RENDER[page]?.());
}
let NAV_MODE = 'view';
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) { NAV_MODE = b.dataset.mode || 'view'; go(b.dataset.page); } });

/* ================= Theme ================= */
function setTheme(t) {
  document.body.dataset.theme = t;
  $$('[data-theme-btn]').forEach((b) => b.classList.toggle('on', b.dataset.themeBtn === t));
  if (typeof syncBgLabel === 'function') syncBgLabel();
  try { localStorage.setItem('mista-theme', t); } catch { /* storage unavailable */ }
}
$$('[data-theme-btn]').forEach((b) => { b.onclick = () => setTheme(b.dataset.themeBtn); });
// Login-page background button: cycles the existing themes (dark, light, glass) before sign-in.
const BG_ORDER = ['dark', 'light', 'glass'], BG_NAME = { dark: 'تیره', light: 'روشن', glass: 'شیشه‌ای' };
function syncBgLabel() { const el = document.getElementById('bgName'); if (el) el.textContent = BG_NAME[document.body.dataset.theme] || ''; }
if (document.getElementById('bgToggle')) {
  document.getElementById('bgToggle').onclick = () => {
    const i = BG_ORDER.indexOf(document.body.dataset.theme);
    setTheme(BG_ORDER[(i + 1) % BG_ORDER.length]); syncBgLabel();
  };
  syncBgLabel();
}

/* ================= Searchable choice fields =================
   Every select with at least two choices gets a search box inside the field itself.
   Typing shows options that CONTAIN the text anywhere (e.g. "ال" -> البرز, "فر" -> فردیس). */
const normSearch = (v) => normDigits(String(v ?? '')).replace(/\u200c/g, '').replace(/\u064a/g, 'ی').replace(/\u0643/g, 'ک').replace(/\s+/g, ' ').trim().toLowerCase();
function enhanceSelect(sel) {
  if (sel.dataset.enh || sel.closest('.combo')) return;
  if ([...sel.options].filter((o) => o.value !== '').length < 2) return;
  sel.dataset.enh = '1';
  sel.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'input'; inp.autocomplete = 'off';
  // The field's topic is shown inside the box when it is empty.
  const topic = (sel.id && document.querySelector(`label[for="${sel.id}"]`)?.textContent.trim()) || 'جستجو یا انتخاب';
  inp.placeholder = topic;
  inp.setAttribute('aria-label', topic);
  inp.setAttribute('role', 'combobox');
  const list = document.createElement('ul');
  list.className = 'combo-list hidden'; list.setAttribute('role', 'listbox');
  wrap.append(inp, list);
  sel.parentNode.insertBefore(wrap, sel);
  const labelOf = () => (sel.value ? (sel.options[sel.selectedIndex]?.textContent.trim() || '') : '');
  const render = (q) => {
    const nq = normSearch(q);
    const items = [...sel.options].filter((o) => o.value !== '' && (!nq || normSearch(o.textContent).includes(nq)));
    list.innerHTML = items.slice(0, 300).map((o) => `<li role="option" data-v="${esc(o.value)}">${esc(o.textContent.trim())}</li>`).join('')
      || '<li class="none">موردی یافت نشد</li>';
  };
  const close = () => { list.classList.add('hidden'); if (document.activeElement !== inp) inp.value = labelOf(); };
  const pick = (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); inp.value = labelOf(); list.classList.add('hidden'); };
  // Opening always shows the full list again, so the choice can be changed later.
  const openAll = () => { if (sel.disabled) return; inp.select(); render(''); list.classList.remove('hidden'); };
  inp.addEventListener('focus', openAll);
  inp.addEventListener('click', openAll);
  inp.addEventListener('input', () => { if (sel.disabled) return; render(inp.value); list.classList.remove('hidden'); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); inp.blur(); }
    if (e.key === 'Enter') { e.preventDefault(); const first = list.querySelector('li[data-v]'); if (first) pick(first.dataset.v); }
  });
  inp.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-v]'); if (li) { e.preventDefault(); pick(li.dataset.v); } });
  const sync = () => { inp.disabled = sel.disabled; if (document.activeElement !== inp) inp.value = labelOf(); };
  sel.addEventListener('change', sync);
  new MutationObserver(sync).observe(sel, { attributes: true, childList: true, attributeFilter: ['disabled'] });
  sync();
}
function enhanceAllSelects(root = document) { root.querySelectorAll('select').forEach((sel) => enhanceSelect(sel)); }
new MutationObserver(() => enhanceAllSelects()).observe(document.body, { childList: true, subtree: true });

/* ================= Shared helpers ================= */
const rowActs = (sec, id) => {
  let h = '';
  if (can(sec, 'edit')) h += `<button class="btn ghost sm" data-act="edit-${sec}" data-id="${id}">ویرایش</button> `;
  if (can(sec, 'delete')) h += `<button class="btn danger sm" data-act="del-${sec}" data-id="${id}">حذف</button>`;
  return h || '—';
};
const bars = (items) => {
  if (!items || !items.length) return '<div class="empty">داده‌ای برای نمایش وجود ندارد</div>';
  const max = Math.max(...items.map((i) => i.value)) || 1;
  return items.map((i) => `<div class="brow" title="${esc(i.label)}: ${toFa(i.value)}"><span>${esc(i.label)}</span><div class="btrack" role="img" aria-label="${esc(i.label)}"><div class="bfill" style="width:${Math.round(i.value / max * 100)}%"></div></div><b>${toFa(i.value)}</b></div>`).join('');
};

/* ================= Dashboard ================= */
const DASH = { preset: '30' };
function dashRange() {
  const t = todayISO();
  if (DASH.preset === 'today') return [t, t];
  if (DASH.preset === 'custom') {
    const f = parseJ($('#dfFrom').value) || t, to = parseJ($('#dfTo').value) || t;
    return f <= to ? [f, to] : [to, f];
  }
  const n = { 7: 6, 30: 29, 90: 89 }[DASH.preset];
  return [addDays(t, -n), t];
}
async function renderDashboard() {
  const [from, to] = dashRange();
  const d = await api('GET', `/api/dashboard?from=${from}&to=${to}`);
  const kp = [];
  if (d.companies) kp.push(['شرکت‌ها', d.companies.total, d.companies.created]);
  if (d.drivers) kp.push(['رانندگان', d.drivers.total, d.drivers.created]);
  if (d.vehicles) kp.push(['خودروها', d.vehicles.total, d.vehicles.created]);
  if (d.contracts) {
    kp.push(['قراردادها', d.contracts.total, d.contracts.created], ['قراردادهای فعال', d.contracts.active, null],
      ['منقضی‌شده', d.contracts.expired, null], ['نزدیک انقضا (۳۰ روز)', d.contracts.near, null]);
  }
  if (d.documents) kp.push(['مدارک نزدیک انقضا', d.documents.expiringSoon, null], ['مدارک نیازمند بررسی', d.documents.pendingReview, null]);
  if (d.users) kp.push(['کاربران فعال', d.users.active, null]);
  $('#kpis').innerHTML = kp.map(([l, v, r]) => `<div class="card stat"><b>${toFa(v)}</b><span>${l}</span>${r === null || r === undefined ? '' : `<small>ثبت‌شده در بازه: ${toFa(r)}</small>`}</div>`).join('');
  $('#chSeries').innerHTML = d.contracts ? bars(d.contracts.byMonth) : '';
  $('#chStatus').innerHTML = d.contracts ? bars([{ label: 'فعال', value: d.contracts.active - d.contracts.near }, { label: 'نزدیک انقضا', value: d.contracts.near }, { label: 'منقضی', value: d.contracts.expired }]) : '';
  $('#chBrand').innerHTML = d.vehicles ? bars(d.vehicles.byBrand) : '';
  $('#chProv').innerHTML = d.companies ? bars(d.companies.byProvince) : '';
  $('#chUsers').innerHTML = d.activity ? bars(d.activity.byUser) : '';
  $('#recent').innerHTML = d.activity ? (d.activity.recent.map((x) => `<li><b>${esc(x.username)}</b> ${esc(x.description)} <small>${fmtTs(x.ts)}</small></li>`).join('') || '<div class="empty">فعالیتی در این بازه نیست</div>') : '';
  const alerts = [];
  if (d.contracts && d.contracts.expired) alerts.push(`${toFa(d.contracts.expired)} قرارداد منقضی‌شده نیاز به بررسی دارد`);
  if (d.documents && d.documents.expired) alerts.push(`${toFa(d.documents.expired)} مدرک منقضی‌شده دارید`);
  (d.alerts || []).forEach((a) => alerts.push(`قرارداد ${toFa(a.number)} تا ${fmtJ(a.end_date)} منقضی می‌شود`));
  $('#alerts').innerHTML = alerts.map((a) => `<div class="alert">${a}</div>`).join('') || '<div class="empty">هشداری وجود ندارد</div>';
  applyPermissions();
}
$$('[data-act="range"]').forEach(() => {});

/* ================= Companies ================= */
const CO_MAP = { siteId: 'c-site', supervisionUnitId: 'c-sunit', name: 'c-name', code: 'c-code', nationalId: 'c-nid', regNo: 'c-regno', regDate: 'c-regdate', legalType: 'c-type', mobile: 'c-mobile', phone: 'c-phone', econ: 'c-econ', country: 'c-country', province: 'c-prov', city: 'c-city', provinceCode: 'c-prov', cityId: 'c-city', postal: 'c-postal', address: 'c-addr', description: 'c-desc' };
async function renderCompanies() {
  const q = $('#cSearch').value.trim();
  const { items } = await api('GET', `/api/companies?q=${encodeURIComponent(q)}`);
  $('#cBody').innerHTML = items.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc((REF.legal.find(([v]) => v === c.legalType) || [])[1] || '—')}</td><td>${esc(c.province || '—')}</td><td>${esc(c.city || '—')}</td><td>${toFa(c.mobile)}</td><td>${rowActs('companies', c.id)}</td></tr>`).join('') || emptyRow(7);
}
async function openCompany(c = null) {
  const sup = await api('GET', '/api/supervision-options');
  const v = c || {};
  const isIran = !v.country || v.country === 'ایران';
  openModal(`<h3>${c ? 'ویرایش شرکت' : 'شرکت جدید'}</h3>
  <form id="cForm" novalidate>
    <div class="sec">الف) شناسایی شرکت</div>
    <div class="row2">
      <div class="field"><label for="c-name">نام شرکت</label><input class="input" id="c-name" value="${esc(v.name || '')}"><div class="err" id="c-name-e"></div></div>
      <div class="field"><label for="c-code">کد شرکت (انگلیسی، عدد و -)</label><input class="input" id="c-code" value="${esc(v.code || '')}"><div class="err" id="c-code-e"></div></div>
      <div class="field"><label for="c-nid">شناسه ملی (۱۱ رقم، اختیاری)</label><input class="input" id="c-nid" inputmode="numeric" value="${toFa(v.nationalId || '')}"><div class="err" id="c-nid-e"></div></div>
      <div class="field"><label for="c-econ">کد اقتصادی (۱۲ رقم)</label><input class="input" id="c-econ" inputmode="numeric" value="${toFa(v.econ || '')}"><div class="err" id="c-econ-e"></div></div>
      <div class="field"><label for="c-regno">شماره ثبت</label><input class="input" id="c-regno" value="${toFa(v.regNo || '')}"><div class="err" id="c-regno-e"></div></div>
      ${dateField('c-regdate', 'تاریخ ثبت')}
      <div class="field"><label for="c-type">نوع شخصیت حقوقی</label><select class="input" id="c-type">${opt(REF.legal, v.legalType)}</select><div class="err" id="c-type-e"></div></div>
    </div>
    <div class="sec">ب) اطلاعات تماس</div>
    <div class="row2">
      <div class="field"><label for="c-mobile">شماره موبایل</label><input class="input" id="c-mobile" inputmode="tel" value="${toFa(v.mobile || '')}" placeholder="۰۹۱۲…"><div class="err" id="c-mobile-e"></div></div>
      <div class="field"><label for="c-phone">تلفن ثابت (با کد شهر)</label><input class="input" id="c-phone" inputmode="tel" value="${toFa(v.phone || '')}"><div class="err" id="c-phone-e"></div></div>
    </div>
    <div class="sec">ج) موقعیت جغرافیایی</div>
    <div class="row2">
      <div class="field"><label for="c-country">کشور</label><input class="input" id="c-country" value="${esc(v.country || 'ایران')}" disabled><div class="note">کشور شرکت‌های جدید ثابت «ایران» است.</div></div>
      <div class="field"><label for="c-prov">استان</label><select class="input" id="c-prov" ${isIran ? '' : 'disabled'}></select><div class="err" id="c-prov-e"></div></div>
      <div class="field"><label for="c-city">شهر</label><select class="input" id="c-city"></select><div class="err" id="c-city-e"></div></div>
      <div class="field"><label for="c-postal">کد پستی (۱۰ رقم)</label><input class="input" id="c-postal" inputmode="numeric" value="${toFa(v.postal || '')}"><div class="err" id="c-postal-e"></div></div>
    </div>
    <div class="sec">د) نشانی و توضیحات</div>
    <div class="field"><label for="c-addr">آدرس کامل</label><textarea class="input" id="c-addr" rows="3">${esc(v.address || '')}</textarea><div class="err" id="c-addr-e"></div></div>
    <div class="field"><label for="c-desc">توضیحات</label><textarea class="input" id="c-desc" rows="2">${esc(v.description || '')}</textarea><div class="err" id="c-desc-e"></div></div>
    <div class="sec">هـ) واحد نظارت</div>
    <div class="row2">
      <div class="field"><label for="c-site">سایت</label><select class="input" id="c-site"></select><div class="err" id="c-site-e"></div></div>
      <div class="field"><label for="c-sunit">واحد نظارت</label><select class="input" id="c-sunit"></select><div class="err" id="c-sunit-e"></div></div>
    </div>
    <div class="note" id="c-sup-note"></div>
    <div class="acts"><button class="btn" type="submit">ذخیره شرکت</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  setDate('c-regdate', v.regDate || '');
  const fillProv = (filter, sel) => {
    $('#c-prov').innerHTML = fillProvinceSelect('', sel, filter);
  };
  // Cities are always those of the selected province (single source: server reference data).
  const fillCity = (prov, sel, filter = '') => {
    const city = $('#c-city');
    if (!prov) { city.innerHTML = '<option value="">ابتدا استان را انتخاب کنید</option>'; city.disabled = true; return; }
    city.disabled = false;
    city.innerHTML = fillCitySelect(prov, sel, filter, 'انتخاب کنید');
  };
  fillProv('', v.provinceCode || ''); fillCity(v.provinceCode || '', v.cityId || '');
  // Sites and units come from the database. A stored value that is now inactive is still shown, marked as inactive.
  const sites = sup.sites.slice(), units = sup.units.slice();
  if (v.siteId && !sites.some((x) => x.id === v.siteId)) sites.push({ id: v.siteId, name: `${v.siteName || 'سایت'} (غیرفعال)` });
  if (v.supervisionUnitId && !units.some((x) => x.id === v.supervisionUnitId)) units.push({ id: v.supervisionUnitId, name: `${v.supervisionUnitName || 'واحد نظارت'} (غیرفعال)`, siteId: v.siteId });
  const fillSiteUnit = (siteId, unitId) => {
    const sid = Number(siteId) || 0;
    $('#c-site').innerHTML = opt(sites.map((x) => [x.id, x.name]), siteId || '', 'انتخاب سایت');
    const list = units.filter((u) => u.siteId === sid);
    $('#c-sunit').innerHTML = opt(list.map((u) => [u.id, u.name]), unitId || '', sid ? 'انتخاب واحد نظارت' : 'ابتدا سایت را انتخاب کنید');
    $('#c-sunit').disabled = !sid;
    $('#c-sup-note').textContent = !sites.length ? 'ابتدا از بخش خودرو ← واحد نظارت، سایت تعریف کنید.' : (sid && !list.length ? 'برای این سایت واحد نظارت فعالی وجود ندارد.' : '');
  };
  fillSiteUnit(v.siteId || '', v.supervisionUnitId || '');
  $('#c-site').onchange = () => { fillSiteUnit($('#c-site').value, ''); fieldErr('c-site', ''); };
  $('#c-sunit').onchange = () => fieldErr('c-sunit', '');
  $('#c-prov').onchange = () => { fillCity($('#c-prov').value, ''); fieldErr('c-prov', ''); };
  $('#c-city').onchange = () => fieldErr('c-city', '');
  $('#cForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#cForm'));
    const rd = readDate('c-regdate', 'تاریخ ثبت', { required: true });
    if (!rd.ok) return;
    const ir = $('#c-country').value === 'ایران';
    const body = {
      name: $('#c-name').value, code: $('#c-code').value, nationalId: normDigits($('#c-nid').value), regNo: normDigits($('#c-regno').value),
      regDate: rd.iso, legalType: $('#c-type').value, mobile: normDigits($('#c-mobile').value), phone: normDigits($('#c-phone').value),
      econ: normDigits($('#c-econ').value), country: $('#c-country').value, provinceCode: ir ? $('#c-prov').value : '', cityId: ir ? $('#c-city').value : '',
      postal: normDigits($('#c-postal').value), address: $('#c-addr').value, description: $('#c-desc').value,
      siteId: Number($('#c-site').value) || null, supervisionUnitId: Number($('#c-sunit').value) || null,
    };
    run(async () => {
      try {
        if (c) await api('PUT', `/api/companies/${c.id}`, body); else await api('POST', '/api/companies', body);
      } catch (err) { applyServerErrors(err, CO_MAP); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('شرکت ذخیره شد'); await RENDER.companies();
    }).catch(() => {});
  };
}

/* ================= Drivers ================= */
async function renderDrivers() {
  const q = $('#dSearch').value.trim();
  const { items } = await api('GET', `/api/drivers?q=${encodeURIComponent(q)}`);
  $('#dBody').innerHTML = items.map((d) => `<tr><td>${esc(d.name)}</td><td>${toFa(d.nid)}</td><td>${toFa(d.mobile)}</td><td>${esc(d.gender)}</td><td>${fmtJ(d.startDate)}</td><td>${rowActs('drivers', d.id)}</td></tr>`).join('') || emptyRow(6);
}
const DR_MAP = { first: 'd-first', last: 'd-last', nid: 'd-nid', mobile: 'd-mob', gender: 'd-gender', startDate: 'd-start', province: 'd-prov', city: 'd-city', residenceAddress: 'd-addr' };
function openDriver(d = null, onSaved = null, restore = null) {
  const v = d || {};
  if (restore) MODAL_ON_CLOSE = restore;
  openModal(`<h3>${d ? 'ویرایش راننده' : 'راننده جدید'}</h3>
  <form id="dForm" novalidate>
    <div class="row2">
      <div class="field"><label for="d-first">نام</label><input class="input" id="d-first" value="${esc(v.first || '')}"><div class="err" id="d-first-e"></div></div>
      <div class="field"><label for="d-last">نام خانوادگی</label><input class="input" id="d-last" value="${esc(v.last || '')}"><div class="err" id="d-last-e"></div></div>
      <div class="field"><label for="d-nid">کد ملی (۱۰ رقم)</label><input class="input" id="d-nid" inputmode="numeric" value="${toFa(v.nid || '')}"><div class="err" id="d-nid-e"></div></div>
      <div class="field"><label for="d-mob">شماره موبایل</label><input class="input" id="d-mob" inputmode="tel" value="${toFa(v.mobile || '')}" placeholder="۰۹۱۲…"><div class="err" id="d-mob-e"></div></div>
      <div class="field"><label for="d-gender">جنسیت</label><select class="input" id="d-gender">${opt(simple(['زن', 'مرد']), v.gender || 'زن', '—')}</select><div class="err" id="d-gender-e"></div></div>
      ${dateField('d-start', 'تاریخ شروع همکاری (اختیاری؛ می‌تواند گذشته باشد)')}
    </div>
    <div class="sec">محل سکونت (اختیاری)</div>
    <div class="row2">
      <div class="field"><label for="d-prov">استان محل سکونت</label><select class="input" id="d-prov">${fillProvinceSelect('', v.provinceCode || '')}</select><div class="err" id="d-prov-e"></div></div>
      <div class="field"><label for="d-city">شهر محل سکونت</label><select class="input" id="d-city" ${v.provinceCode ? '' : 'disabled'}>${fillCitySelect(v.provinceCode || '', v.cityId || '')}</select><div class="err" id="d-city-e"></div></div>
      <div class="field"><label for="d-addr">آدرس محل سکونت</label><input class="input" id="d-addr" value="${esc(v.residenceAddress || '')}"><div class="err" id="d-addr-e"></div></div>
    </div>
    <p class="note">تاریخ ثبت راننده در سیستم به‌صورت خودکار و از سمت سرور ثبت می‌شود و با تاریخ شروع همکاری یکی نیست.</p>
    <div class="acts"><button class="btn" type="submit">ذخیره راننده</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  setDate('d-start', v.startDate || '');
  $('#d-prov').onchange = () => { $('#d-city').innerHTML = fillCitySelect($('#d-prov').value, ''); $('#d-city').disabled = !$('#d-prov').value; fieldErr('d-prov', ''); };
  $('#dForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#dForm'));
    const sd = readDate('d-start', 'تاریخ شروع همکاری');
    if (!sd.ok) return;
    const body = { first: $('#d-first').value.trim(), last: $('#d-last').value.trim(), nid: normDigits($('#d-nid').value), mobile: normDigits($('#d-mob').value), gender: $('#d-gender').value, startDate: sd.iso, provinceCode: $('#d-prov').value, cityId: $('#d-city').value, residenceAddress: $('#d-addr').value.trim() };
    run(async () => {
      let saved;
      try {
        saved = d ? await api('PUT', `/api/drivers/${d.id}`, body) : await api('POST', '/api/drivers', body);
      } catch (err) { applyServerErrors(err, DR_MAP); throw Object.assign(new Error('handled'), { status: -1 }); }
      MODAL_ON_CLOSE = null; closeModal();
      toast('راننده ثبت شد');
      if (onSaved) onSaved(saved.id); else await RENDER.drivers();
    }).catch(() => {});
  };
}

/* ================= Vehicles ================= */
async function renderVehicles() {
  const q = $('#vSearch').value.trim();
  const { items } = await api('GET', `/api/vehicles?q=${encodeURIComponent(q)}`);
  $('#vBody').innerHTML = items.map((v) => `<tr><td>${plateStr(v.plate)}</td><td>${esc(v.brand)}${v.chassisNo || v.engineNo ? `<div class="note">شاسی: ${esc(v.chassisNo || '—')} — موتور: ${esc(v.engineNo || '—')}</div>` : ''}</td><td>${esc(v.model)}</td><td>${esc(v.category)} / ${esc(v.cls)}</td><td>${toFa(v.year)}</td><td>${toFa(v.capacity)}</td><td>${esc(v.usage)}</td><td>${rowActs('vehicles', v.id)}</td></tr>`).join('') || emptyRow(8);
}
const VE_MAP = { brand: 'v-brand', model: 'v-model', category: 'v-cat', cls: 'v-cls', year: 'v-year', capacity: 'v-cap', usage: 'v-usage', supervisionUnit: 'v-sup', chassisNo: 'v-chassis', engineNo: 'v-engine', plate: '#v-e' };
function openVehicle(v = null, onSaved = null, restore = null) {
  const x = v || {};
  if (restore) MODAL_ON_CLOSE = restore;
  openModal(`<h3>${v ? 'ویرایش خودرو' : 'خودرو جدید'}</h3>
  <form id="vForm" novalidate>
    <div class="row2">
      <div class="field"><label for="v-brand">برند</label><select class="input" id="v-brand">${opt(simple(Object.keys(REF.brands)), x.brand)}</select><div class="err" id="v-brand-e"></div></div>
      <div class="field"><label for="v-model">مدل</label><select class="input" id="v-model"></select><div class="err" id="v-model-e"></div></div>
      <div class="field"><label for="v-cat">دسته‌بندی</label><select class="input" id="v-cat">${opt(simple(Object.keys(REF.categories)), x.category)}</select><div class="err" id="v-cat-e"></div></div>
      <div class="field"><label for="v-cls">کلاس</label><select class="input" id="v-cls"></select><div class="err" id="v-cls-e"></div></div>
      <div class="field"><label for="v-year">سال ساخت (۱۳۶۰ تا ۱۴۰۵)</label><input class="input" id="v-year" inputmode="numeric" value="${toFa(x.year || '')}"><div class="err" id="v-year-e"></div></div>
      <div class="field"><label for="v-cap">ظرفیت سرنشین (۱ تا ۶۰)</label><input class="input" id="v-cap" inputmode="numeric" value="${toFa(x.capacity || '')}"><div class="err" id="v-cap-e"></div></div>
      <div class="field"><label for="v-usage">نوع کاربری</label><select class="input" id="v-usage">${opt(simple(REF.usage), x.usage)}</select><div class="err" id="v-usage-e"></div></div>
      <div class="field"><label for="v-sup">واحد نظارت</label><input class="input" id="v-sup" value="${esc(x.supervisionUnit || '')}"><div class="err" id="v-sup-e"></div></div>
      <div class="field"><label for="v-chassis">شماره شاسی</label><input class="input" id="v-chassis" value="${esc(x.chassisNo || '')}"><div class="err" id="v-chassis-e"></div></div>
      <div class="field"><label for="v-engine">شماره موتور</label><input class="input" id="v-engine" value="${esc(x.engineNo || '')}"><div class="err" id="v-engine-e"></div></div>
    </div>
    ${plateHTML('v', x.plate || {})}
    <div class="acts"><button class="btn" type="submit">ذخیره خودرو</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  const fillModel = (sel) => { $('#v-model').innerHTML = opt(simple(REF.brands[$('#v-brand').value] || []), sel); };
  const fillCls = (sel) => { const isCar = $('#v-cat').value === 'سواری'; $('#v-cls').innerHTML = isCar ? opt(simple(REF.categories['سواری']), sel) : opt([], '', '—'); $('#v-cls').closest('.field').style.display = isCar ? '' : 'none'; };
  fillModel(x.model || ''); fillCls(x.cls || '');
  $('#v-brand').onchange = () => fillModel('');
  $('#v-cat').onchange = () => fillCls('');
  if (x.plate) updPlate('v');
  $('#vForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#vForm'));
    const pl = plateRead('v');
    const body = { brand: $('#v-brand').value, model: $('#v-model').value, category: $('#v-cat').value, cls: $('#v-cls').value,
      year: normDigits($('#v-year').value), capacity: normDigits($('#v-cap').value), usage: $('#v-usage').value, supervisionUnit: $('#v-sup').value.trim(), chassisNo: $('#v-chassis').value.trim(), engineNo: $('#v-engine').value.trim(), plate: pl };
    run(async () => {
      let saved;
      try {
        saved = v ? await api('PUT', `/api/vehicles/${v.id}`, body) : await api('POST', '/api/vehicles', body);
      } catch (err) { applyServerErrors(err, VE_MAP); throw Object.assign(new Error('handled'), { status: -1 }); }
      MODAL_ON_CLOSE = null; closeModal();
      toast('خودرو ثبت شد');
      if (onSaved) onSaved(saved.id); else await RENDER.vehicles();
    }).catch(() => {});
  };
}

/* ================= Contracts ================= */
async function renderContracts() {
  const q = normDigits($('#kSearch').value.trim()).toLowerCase();
  const { items } = await api('GET', '/api/contracts');
  const filtered = items.filter((k) => !q || `${k.number} ${k.driverName} ${plateStr(k.vehiclePlate)}`.toLowerCase().includes(q));
  $('#kBody').innerHTML = filtered.map((k) => `<tr><td>${toFa(k.number)}</td><td>${esc(k.companyName)}</td><td>${esc(k.driverName)}</td><td>${plateStr(k.vehiclePlate)}</td><td>${fmtJ(k.startDate)}</td><td>${fmtJ(k.endDate)}</td><td><span class="pill ${k.status === 'منقضی' ? 'bad' : ''}">${k.status}</span></td><td>${rowActs('contracts', k.id)}</td></tr>`).join('') || emptyRow(8);
}
const KE_MAP = { companyId: 'k-co', driverId: 'k-driver', vehicleId: 'k-vehicle', startDate: 'k-start', siteId: 'k-site', supervisionUnitId: 'k-sunit' };
async function loadPicks() {
  const [c, d, v] = await Promise.all([
    can('companies', 'view') ? api('GET', '/api/companies') : { items: [] },
    can('drivers', 'view') ? api('GET', '/api/drivers') : { items: [] },
    can('vehicles', 'view') ? api('GET', '/api/vehicles') : { items: [] },
  ]);
  return { companies: c.items, drivers: d.items, vehicles: v.items };
}
// '+' next to the vehicle: the vehicle dialog plus an optional new-driver section.
// Saving creates the driver first (only if its fields are filled), then the vehicle; both are selected in the contract.
function openVehicleAndDriver(snap) {
  let newDriverId = null;
  openVehicle(null, (vid) => openContract({ ...snap, vehicleId: String(vid), driverId: String(newDriverId ?? snap.driverId ?? '') }), () => openContract(snap));
  const vf = $('#vForm');
  if (!vf) return;
  vf.querySelector('.acts').insertAdjacentHTML('beforebegin', `
    <div class="sec">راننده جدید (اختیاری؛ اگر پر شود همراه خودرو ثبت می‌شود)</div>
    <div class="row2">
      <div class="field"><label for="nd-first">نام راننده</label><input class="input" id="nd-first"><div class="err" id="nd-first-e"></div></div>
      <div class="field"><label for="nd-last">نام خانوادگی راننده</label><input class="input" id="nd-last"><div class="err" id="nd-last-e"></div></div>
      <div class="field"><label for="nd-nid">کد ملی راننده</label><input class="input" id="nd-nid" inputmode="numeric"><div class="err" id="nd-nid-e"></div></div>
      <div class="field"><label for="nd-mob">موبایل راننده</label><input class="input" id="nd-mob" inputmode="tel" placeholder="۰۹۱۲…"><div class="err" id="nd-mob-e"></div></div>
      <div class="field"><label for="nd-gender">جنسیت راننده</label><select class="input" id="nd-gender">${opt(simple(['زن', 'مرد']), '', '—')}</select><div class="err" id="nd-gender-e"></div></div>
    </div>`);
  const origSubmit = vf.onsubmit;
  vf.onsubmit = (e) => {
    e.preventDefault();
    clearErrs(vf);
    const d = { first: $('#nd-first').value.trim(), last: $('#nd-last').value.trim(), nid: normDigits($('#nd-nid').value), mobile: normDigits($('#nd-mob').value), gender: $('#nd-gender').value };
    const filled = d.first || d.last || d.nid || d.mobile || d.gender;
    if (!filled) { newDriverId = null; return origSubmit(e); }
    run(async () => {
      try {
        const saved = await api('POST', '/api/drivers', { ...d, startDate: '' });
        newDriverId = saved.id;
      } catch (err) {
        applyServerErrors(err, { first: 'nd-first', last: 'nd-last', nid: 'nd-nid', mobile: 'nd-mob', gender: 'nd-gender' });
        throw Object.assign(new Error('handled'), { status: -1 });
      }
      origSubmit(e);
    }).catch(() => {});
  };
}
async function openContract(init = {}, restore = null) {
  const supOpts = await api('GET', '/api/supervision-options').catch(() => ({ sites: [], units: [] }));
  const k = init.id ? await api('GET', '/api/contracts').then((r) => r.items.find((x) => x.id === init.id)) : null;
  const picks = await loadPicks();
  if (restore) MODAL_ON_CLOSE = restore;
  const cur = { companyId: init.companyId ?? (k ? String(k.companyId) : ''), driverId: init.driverId ?? (k ? String(k.driverId) : ''), vehicleId: init.vehicleId ?? (k ? String(k.vehicleId) : '') };
  openModal(`<h3>${k ? 'ویرایش قرارداد' : 'قرارداد جدید'}</h3>
  <form id="kForm" novalidate>
    <div class="sec">اطلاعات قرارداد</div>
    <div class="row2">
      <div class="field"><label>شماره قرارداد</label><input class="input" disabled value="${k ? toFa(k.number) : 'پس از ثبت تولید می‌شود'}"></div>
      <div></div>
      ${dateField('k-start', 'تاریخ شروع')}
    </div>
    <div class="sec">شرکت و راننده</div>
    <div class="field"><label for="k-co">شرکت</label><select class="input" id="k-co">${opt(picks.companies.map((c) => [c.id, c.name]), cur.companyId, 'انتخاب شرکت')}</select><div class="err" id="k-co-e"></div></div>
    <div class="row2">
      <div class="field"><label for="k-driver">راننده</label><select class="input" id="k-driver"></select><div class="err" id="k-driver-e"></div></div>
    </div>
    <div class="sec">خودرو</div>
    <div class="row2">
      <div class="field"><label for="k-vehicle">خودرو</label><div style="display:flex;gap:8px;align-items:stretch"><div style="flex:1"><select class="input" id="k-vehicle"></select></div>${can('vehicles', 'create') || can('drivers', 'create') ? '<button type="button" class="btn ghost" id="k-newveh" title="ثبت خودرو و راننده جدید" style="min-width:44px">+</button>' : ''}</div><div class="err" id="k-vehicle-e"></div></div>
    </div>
    <div class="sec">واحد نظارت</div>
    <div class="row2">
      <div class="field"><label for="k-site">سایت</label><select class="input" id="k-site"></select><div class="err" id="k-site-e"></div></div>
      <div class="field"><label for="k-sunit">واحد نظارت</label><select class="input" id="k-sunit"></select><div class="err" id="k-sunit-e"></div></div>
    </div>
    <div class="note" id="k-sup-note"></div>
    <div class="acts"><button class="btn" type="submit">${k ? 'ذخیره تغییرات' : 'ثبت قرارداد'}</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  if (k) { $('#k-start').value = fmtJ(k.startDate); }
  else { $('#k-start').value = init.start ?? ''; }
  const drvList = (q) => picks.drivers.filter((d) => !q || [d.first, d.last, d.nid, d.mobile].some((x) => x.includes(normDigits(q))));
  const vehList = (q) => picks.vehicles.filter((v) => !q || `${plainPlate(v.plate)} ${v.brand} ${v.model}`.includes(normDigits(q)));
  const drvSel = (sel, q = '') => $('#k-driver').innerHTML = opt(drvList(q).map((d) => [d.id, `${d.name} - ${toFa(d.nid)}`]), sel, 'انتخاب راننده');
  const vehSel = (sel, q = '') => $('#k-vehicle').innerHTML = opt(vehList(q).map((v) => [v.id, `${plainPlate(v.plate)} - ${v.brand} ${v.model}`]), sel, 'انتخاب خودرو');
  drvSel(cur.driverId); vehSel(cur.vehicleId);
  // Site and unit come from the shared supervision data. A unit must belong to the chosen site; a mismatch is cleared.
  const sites = supOpts.sites.slice(), units = supOpts.units.slice();
  if (k && k.siteId && !sites.some((x) => x.id === k.siteId)) sites.push({ id: k.siteId, name: `${k.siteName || 'سایت'} (غیرفعال)` });
  if (k && k.supervisionUnitId && !units.some((x) => x.id === k.supervisionUnitId)) units.push({ id: k.supervisionUnitId, name: `${k.supervisionUnitName || 'واحد نظارت'} (غیرفعال)`, siteId: k.siteId });
  const fillSU = (siteId, unitId) => {
    const sid = Number(siteId) || 0;
    $('#k-site').innerHTML = opt(sites.map((x) => [x.id, x.name]), siteId || '', 'انتخاب سایت');
    const list = units.filter((u) => u.siteId === sid);
    $('#k-sunit').innerHTML = opt(list.map((u) => [u.id, u.name]), unitId || '', sid ? 'انتخاب واحد نظارت' : 'ابتدا سایت را انتخاب کنید');
    $('#k-sunit').disabled = !sid;
    $('#k-sup-note').textContent = !sites.length ? 'هنوز سایتی تعریف نشده است. ابتدا از بخش خودرو ← واحد نظارت، سایت تعریف کنید.' : (sid && !list.length ? 'برای این سایت واحد نظارت فعالی وجود ندارد.' : '');
  };
  fillSU(k ? (k.siteId || '') : '', k ? (k.supervisionUnitId || '') : '');
  $('#k-site').onchange = () => { fillSU($('#k-site').value, ''); fieldErr('k-site', ''); };
  $('#k-sunit').onchange = () => fieldErr('k-sunit', '');
  // Choosing a company offers that company's site and unit as the starting values.
  $('#k-co').onchange = async () => {
    const cid = Number($('#k-co').value);
    const list = await api('GET', '/api/companies').catch(() => ({ items: [] }));
    const c = list.items.find((x) => x.id === cid);
    fillSU(c && c.siteId ? c.siteId : '', c && c.supervisionUnitId ? c.supervisionUnitId : '');
  };
  const snap = () => ({ id: init.id, companyId: $('#k-co').value, driverId: $('#k-driver').value, vehicleId: $('#k-vehicle').value, start: $('#k-start').value });
  const nv = $('#k-newveh');
  if (nv) nv.onclick = () => openVehicleAndDriver(snap());
  $('#kForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#kForm'));
    const s = readDate('k-start', 'تاریخ شروع', { required: true });
    if (!s.ok) return;
    const body = { companyId: Number($('#k-co').value) || null, driverId: Number($('#k-driver').value) || null, vehicleId: Number($('#k-vehicle').value) || null, startDate: s.iso,
      siteId: Number($('#k-site').value) || null, supervisionUnitId: Number($('#k-sunit').value) || null };
    run(async () => {
      try {
        if (k) await api('PUT', `/api/contracts/${k.id}`, body); else await api('POST', '/api/contracts', body);
      } catch (err) { applyServerErrors(err, KE_MAP); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('قرارداد ذخیره شد'); await RENDER.contracts();
    }).catch(() => {});
  };
}

/* ================= Users ================= */
async function renderUsers() {
  const q = $('#uSearch').value.trim().toLowerCase();
  await loadDepts();
  const { items } = await api('GET', '/api/users');
  const rows = items.filter((u) => !q || u.username.toLowerCase().includes(q) || u.name.includes(q));
  $('#uBody').innerHTML = rows.map((u) => {
    const locked = u.root || u.id === ME.id || !can('users', 'edit');
    const roleCell = locked ? `<span class="pill">${esc(u.role)}</span>` : `<select class="input" data-role-id="${u.id}" style="width:auto;min-width:140px" aria-label="نقش">${opt(simple(REF.roles), u.role, '—')}</select>`;
    let btns = '';
    if (can('users', 'edit')) btns += `<button class="btn ghost sm" data-act="edit-user" data-id="${u.id}">ویرایش</button> `;
    if (can('users', 'edit') && !u.root && u.id !== ME.id) btns += `<button class="btn ghost sm" data-act="toggle-user" data-id="${u.id}">${u.active ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button> `;
    if (can('users', 'delete') && !u.root && u.id !== ME.id) btns += `<button class="btn danger sm" data-act="del-user" data-id="${u.id}">حذف</button>`;
    return `<tr><td>${esc(u.username)}${u.root ? ' <span class="pill">مدیر اصلی</span>' : ''}</td><td>${esc(u.name)}</td><td>${esc(u.departmentId ? deptName(u.departmentId) : '—')}</td><td>${roleCell}</td><td><span class="pill ${u.active ? '' : 'bad'}">${u.active ? 'فعال' : 'غیرفعال'}</span></td><td>${btns || '—'}</td></tr>`;
  }).join('') || emptyRow(6);
}
const US_MAP = { username: 'u-un', name: 'u-name', role: 'u-role', password: 'u-pass' };
const PM_ACTS = [['view', 'مشاهده'], ['create', 'ایجاد'], ['edit', 'ویرایش'], ['delete', 'حذف']];
function permMatrix(perms, disabled) {
  return `<div class="tw"><table class="perm"><thead><tr><th>بخش</th>${PM_ACTS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
    ${Object.entries(REF.sections).map(([sec, label]) => `<tr><td>${esc(label)}</td>${PM_ACTS.map(([act]) => `<td><input type="checkbox" data-pm="${sec}.${act}" ${perms?.[sec]?.[act] ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}
function readPermMatrix() {
  const out = {};
  for (const sec of Object.keys(REF.sections)) {
    out[sec] = {};
    for (const [act] of PM_ACTS) out[sec][act] = !!document.querySelector(`[data-pm="${sec}.${act}"]`)?.checked;
  }
  return out;
}
function openEditUser(u) {
  const locked = u.root || u.id === ME.id;
  openModal(`<h3>ویرایش کاربر «${esc(u.username)}»</h3>
  <form id="ueForm" novalidate>
    <div class="row2">
      <div class="field"><label for="ue-name">نام نمایشی</label><input class="input" id="ue-name" value="${esc(u.name)}"><div class="err" id="ue-name-e"></div></div>
      <div class="field"><label for="ue-dept">واحد</label><select class="input" id="ue-dept">${opt(DEPTS.map((d) => [d.id, d.name]), u.departmentId || '', 'بدون واحد')}</select></div>
      <div class="field"><label for="ue-role">نقش</label><select class="input" id="ue-role" ${locked ? 'disabled' : ''}>${opt(simple(REF.roles), u.role, '—')}</select><div class="err" id="ue-role-e"></div></div>
      <div class="field"><label for="ue-pass">رمز عبور جدید (اختیاری، حداقل ۸ کاراکتر)</label><input class="input" id="ue-pass" type="password" autocomplete="new-password"><div class="err" id="ue-pass-e"></div></div>
      <div class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ue-active" ${u.active ? 'checked' : ''} ${locked ? 'disabled' : ''}><label for="ue-active">حساب فعال</label></div>
    </div>
    <div class="sec">دسترسی به بخش‌ها</div>
    <p class="note">با تغییر نقش، دسترسی‌ها به پیش‌فرض همان نقش برمی‌گردد. اگر جدول را تغییر دهید، همان ذخیره می‌شود.</p>
    ${permMatrix(u.perms, locked)}
    ${locked ? '<p class="note">نقش، وضعیت و دسترسی این حساب (مدیر اصلی یا حساب خودتان) قابل تغییر نیست.</p>' : ''}
    <div class="acts"><button class="btn" type="submit">ذخیره تغییرات</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  $('#ueForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#ueForm'));
    const body = { name: $('#ue-name').value.trim(), departmentId: Number($('#ue-dept').value) || null };
    if (!locked) {
      body.role = $('#ue-role').value;
      body.active = $('#ue-active').checked;
      body.perms = readPermMatrix();
    }
    if ($('#ue-pass').value) body.password = $('#ue-pass').value;
    run(async () => {
      try { await api('PUT', `/api/users/${u.id}`, body); }
      catch (err) { applyServerErrors(err, { name: 'ue-name', role: 'ue-role', password: 'ue-pass' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('کاربر به‌روز شد'); await RENDER.users();
    }).catch(() => {});
  };
}
async function openUser() {
  await loadDepts();
  // Driver accounts link to an existing driver record; the list shows drivers.
  const DRIVER_OPTS = (await api('GET', '/api/drivers')).items.map((d) => [d.id, `${d.first} ${d.last} — ${toFa(d.nid)}`]);
  openModal(`<h3>کاربر جدید</h3>
  <form id="uForm" novalidate>
    <div class="row2">
      <div class="field"><label for="u-un">نام کاربری (انگلیسی)</label><input class="input" id="u-un"><div class="err" id="u-un-e"></div></div>
      <div class="field"><label for="u-name">نام نمایشی</label><input class="input" id="u-name"><div class="err" id="u-name-e"></div></div>
      <div class="field"><label for="u-dept">واحد</label><select class="input" id="u-dept">${opt(DEPTS.map((d) => [d.id, d.name]), '', 'بدون واحد')}</select></div>
      <div class="field"><label for="u-role">نقش</label><select class="input" id="u-role">${opt(simple(REF.newUserRoles), 'پرسنل', '—')}</select></div>
      <div class="field" id="u-driver-wrap" style="display:none"><label for="u-driver">راننده (از فهرست رانندگان ثبت‌شده)</label><select class="input" id="u-driver">${opt(DRIVER_OPTS, '', 'انتخاب راننده')}</select><div class="err" id="u-driverId-e"></div></div>
      <div class="field"><label for="u-pass">رمز عبور (حداقل ۸ کاراکتر)</label><input class="input" id="u-pass" type="password" autocomplete="new-password"><div class="err" id="u-pass-e"></div></div>
    </div>
    <div class="acts"><button class="btn" type="submit">ایجاد کاربر</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  const toggleDriver = () => { $('#u-driver-wrap').style.display = $('#u-role').value === 'راننده' ? '' : 'none'; };
  $('#u-role').onchange = toggleDriver;
  toggleDriver();
  $('#uForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#uForm'));
    run(async () => {
      try {
        await api('POST', '/api/users', { username: $('#u-un').value.trim(), name: $('#u-name').value.trim(), role: $('#u-role').value, password: $('#u-pass').value, departmentId: Number($('#u-dept').value) || null, driverId: Number($('#u-driver').value) || null });
      } catch (err) { applyServerErrors(err, US_MAP); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('کاربر ایجاد شد'); await RENDER.users();
    }).catch(() => {});
  };
}

/* ================= Document types ================= */
async function renderDoctypes() {
  const { items } = await api('GET', '/api/doctypes');
  $('#tBody').innerHTML = items.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.categoryLabel)}</td><td>${esc(REF.docOwners.includes(t.ownerType) ? { driver: 'راننده', vehicle: 'خودرو', company: 'شرکت' }[t.ownerType] : t.ownerType)}</td><td>${t.required ? '<span class="pill bad">الزامی</span>' : '<span class="pill">اختیاری</span>'}</td><td>${t.active ? 'بله' : 'خیر'}</td><td>${can('doctypes', 'edit') ? `<button class="btn ghost sm" data-act="edit-doctype" data-id="${t.id}">ویرایش</button>` : '—'}</td></tr>`).join('') || emptyRow(6);
}
const OWNER_LABEL = { driver: 'راننده', vehicle: 'خودرو' };
function openDoctype(t = null) {
  const v = t || {};
  openModal(`<h3>${t ? 'ویرایش نوع مدرک' : 'نوع مدرک جدید'}</h3>
  <form id="tForm" novalidate>
    <div class="field"><label for="t-name">نام نوع مدرک</label><input class="input" id="t-name" value="${esc(v.name || '')}"><div class="err" id="t-name-e"></div></div>
    <div class="row2">
      <div class="field"><label for="t-cat">دسته‌بندی</label><select class="input" id="t-cat">${opt(Object.entries(REF.docCategories), v.category || 'driver', '—')}</select><div class="err" id="t-cat-e"></div></div>
      <div class="field"><label for="t-owner">مالک مدرک</label><select class="input" id="t-owner">${opt(Object.entries(OWNER_LABEL), v.ownerType || 'driver', '—')}</select><div class="err" id="t-owner-e"></div></div>
    </div>
    <div class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="t-req" ${v.required ? 'checked' : ''}><label for="t-req">الزامی برای این مالک (پیش‌فرض: اختیاری)</label></div>
    <div class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="t-active" ${v.active === false ? '' : 'checked'}><label for="t-active">فعال</label></div>
    <div class="acts"><button class="btn" type="submit">ذخیره</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  $('#tForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#tForm'));
    const body = { name: $('#t-name').value.trim(), category: $('#t-cat').value, ownerType: $('#t-owner').value, required: $('#t-req').checked, active: $('#t-active').checked };
    run(async () => {
      try {
        if (t) await api('PUT', `/api/doctypes/${t.id}`, body); else await api('POST', '/api/doctypes', body);
      } catch (err) { applyServerErrors(err, { name: 't-name', category: 't-cat', ownerType: 't-owner' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('نوع مدرک ذخیره شد'); await RENDER.doctypes();
    }).catch(() => {});
  };
}

/* ================= Documents: driver pages and vehicle pages ================= */
const DOC_STATUS = { none: 'بارگذاری نشده', pending: 'نیازمند بررسی', approved: 'تأیید شده', rejected: 'رد شده', expired: 'منقضی شده', na: 'اعمال نمی‌شود' };
const DOC_OWN = {
  driver: { p: 'm', label: 'راننده', url: '/api/drivers', name: (x) => x.name, fields: (x) => [x.name, x.nid, x.mobile] },
  vehicle: { p: 'vd', label: 'خودرو', url: '/api/vehicles', name: (x) => `${plateStr(x.plate)} (${x.brand} ${x.model})`, fields: (x) => [plateStr(x.plate), x.brand, x.model] },
};
const DOC_SEL = { driver: null, vehicle: null };
const DOC_PAGE = { driver: 1, vehicle: 1 };
const DOC_LIST = {};
async function loadOwners(type) { const { items } = await api('GET', DOC_OWN[type].url); DOC_LIST[type] = items; return items; }
const ownerName = (type, id) => (DOC_LIST[type] || []).find((x) => x.id === id) ? DOC_OWN[type].name((DOC_LIST[type] || []).find((x) => x.id === id)) : '';
async function renderOwnerSelect(type) {
  const cfg = DOC_OWN[type], items = await loadOwners(type);
  const list = items;
  $(`#${cfg.p}${type === 'driver' ? 'Drv' : 'Veh'}`).innerHTML = opt(list.map((x) => [x.id, cfg.name(x)]), DOC_SEL[type] || '', 'انتخاب کنید');
}
// Category filter of a document page: only the categories of active document types that belong to this owner type.
async function fillDocCategories(type) {
  const sel = $(`#${DOC_OWN[type].p}Cat`);
  let cats = null;
  try {
    const { items } = await api('GET', '/api/doctypes');
    cats = [...new Set(items.filter((t) => t.active && t.ownerType === type).map((t) => t.category))];
  } catch { cats = []; }
  const key = cats.join('|');
  if (sel.dataset.key === key) return;
  const keep = sel.value;
  sel.dataset.key = key;
  sel.innerHTML = opt(Object.entries(REF.docCategories).filter(([k]) => cats.includes(k)), keep, 'همه دسته‌ها');
}
async function renderDocPage(type) {
  const cfg = DOC_OWN[type], p = cfg.p;
  await fillDocCategories(type);
  await renderOwnerSelect(type);
  $(`#${p}Note`).classList.add('hidden');
  const qs = new URLSearchParams({ ownerType: type, ownerId: DOC_SEL[type] || '', q: $(`#${p}Search`).value.trim(), category: $(`#${p}Cat`).value,
    status: $(`#${p}Status`).value, expiry: $(`#${p}Expiry`).value, page: DOC_PAGE[type], size: 15 });
  const r = await api('GET', `/api/documents?${qs}`);
  $(`#${p}Body`).innerHTML = r.items.map((d) => `<tr><td>${type === 'driver' ? esc(d.ownerLabel) : d.ownerLabel}</td><td>${esc(d.docTypeName)}</td><td>${esc(d.categoryLabel)}</td><td>${d.issueDate ? fmtJ(d.issueDate) : '—'}</td><td>${d.expiryDate ? fmtJ(d.expiryDate) : '—'}</td><td>${d.contractNumber ? toFa(d.contractNumber) : '—'}</td><td><span class="pill ${d.status === 'expired' || d.status === 'rejected' ? 'bad' : ''}">${DOC_STATUS[d.status]}</span></td><td><button class="btn ghost sm" data-act="doc-detail" data-id="${d.id}">جزئیات</button></td></tr>`).join('')
    || `<tr><td colspan="8" class="empty">هنوز مدرکی ثبت نشده است</td></tr>`;
  const pages = Math.max(1, Math.ceil(r.total / r.size));
  $(`#${p}Pager`).innerHTML = r.total ? `<button class="btn ghost sm" data-act="dpage" data-type="${type}" data-v="${DOC_PAGE[type] - 1}" ${DOC_PAGE[type] <= 1 ? 'disabled' : ''}>قبلی</button><span>صفحه ${toFa(DOC_PAGE[type])} از ${toFa(pages)} (${toFa(r.total)} مدرک)</span><button class="btn ghost sm" data-act="dpage" data-type="${type}" data-v="${DOC_PAGE[type] + 1}" ${DOC_PAGE[type] >= pages ? 'disabled' : ''}>بعدی</button>` : '';
}
const renderDriverDocs = () => renderDocPage('driver');
const renderVehicleDocs = () => renderDocPage('vehicle');
async function openDocumentForm(type, doc = null) {
  await loadOwners(type);
  const types = (await api('GET', '/api/doctypes')).items.filter((t) => t.active && t.ownerType === type);
  const v = doc || {};
  const cfg = DOC_OWN[type], isVeh = type === 'vehicle';
  const preOwner = doc ? doc.ownerId : (DOC_SEL[type] || '');
  const DOC_MAP = { ownerId: 'dm-owner', docTypeId: 'dm-type', contractId: 'dm-contract', issueDate: 'dm-issue', expiryDate: 'dm-expiry', notes: 'dm-notes', file: 'dm-file' };
  const title = doc ? 'ویرایش مشخصات مدرک' : (isVeh ? 'بارگذاری مدرک خودرو' : 'بارگذاری مدرک راننده');
  openModal(`<h3>${title}</h3>
  <form id="dmForm" novalidate>
    <div class="field"><label for="dm-owner">${cfg.label}</label><select class="input" id="dm-owner" ${doc ? 'disabled' : ''}>${opt(DOC_LIST[type].map((x) => [x.id, cfg.name(x)]), preOwner, 'انتخاب کنید')}</select><div class="err" id="dm-owner-e"></div></div>
    ${isVeh ? '<div class="field"><label for="dm-contract">قرارداد مرتبط با این خودرو (اختیاری)</label><select class="input" id="dm-contract"></select><div class="err" id="dm-contract-e"></div></div>' : ''}
    <div class="field"><label for="dm-type">نوع مدرک</label><select class="input" id="dm-type" ${doc ? 'disabled' : ''}>${opt(types.map((t) => [t.id, `${t.name}${t.required ? ' (الزامی)' : ' (اختیاری)'}`]), v.docTypeId, 'انتخاب نوع مدرک')}</select><div class="err" id="dm-type-e"></div></div>
    <div class="row2">
      ${dateField('dm-issue', 'تاریخ صدور (اختیاری)')}
      ${dateField('dm-expiry', 'تاریخ انقضا (اختیاری)')}
    </div>
    <div class="field"><label for="dm-notes">توضیحات (اختیاری)</label><textarea class="input" id="dm-notes" rows="2">${esc(v.notes || '')}</textarea><div class="err" id="dm-notes-e"></div></div>
    ${doc ? '' : `<div class="field"><span class="label-like">فایل مدرک (PDF، JPG، JPEG یا PNG تا ${toFa(REF.maxUploadMb)} مگابایت)</span>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="btn ghost" for="dm-file" style="cursor:pointer">انتخاب فایل از دستگاه</label><span class="note" id="dm-fname">هنوز فایلی انتخاب نشده است</span></div>
      <input id="dm-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"><div class="err" id="dm-file-e"></div></div>
    <div class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="dm-na"><label for="dm-na">این مدرک اعمال نمی‌شود (بدون فایل)</label></div>`}
    <div class="acts"><button class="btn" type="submit">${doc ? 'ذخیره تغییرات' : 'بارگذاری و ذخیره مدرک'}</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  setDate('dm-issue', v.issueDate || ''); setDate('dm-expiry', v.expiryDate || '');
  const loadContracts = async (selected = '') => {
    const sel = $('#dm-contract');
    if (!sel) return;
    const owner = Number($('#dm-owner').value) || 0;
    if (!owner) { sel.innerHTML = opt([], '', 'ابتدا خودرو را انتخاب کنید'); return; }
    const list = can('contracts', 'view') ? (await api('GET', '/api/contracts')).items.filter((k) => k.vehicleId === owner) : [];
    sel.innerHTML = opt(list.map((k) => [k.id, `${toFa(k.number)} (${fmtJ(k.startDate)} تا ${fmtJ(k.endDate)})`]), selected, list.length ? 'بدون قرارداد (مدرک خودرو)' : 'این خودرو قراردادی ندارد');
  };
  if (isVeh) { $('#dm-owner').onchange = () => run(() => loadContracts('')); await loadContracts(v.contractId || ''); }
  const fileInput = $('#dm-file');
  if (fileInput) fileInput.onchange = () => { $('#dm-fname').textContent = fileInput.files[0] ? fileInput.files[0].name : 'هنوز فایلی انتخاب نشده است'; };
  $('#dmForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#dmForm'));
    const ownerId = Number($('#dm-owner').value) || 0;
    if (!doc && !ownerId) { fieldErr('dm-owner', `${cfg.label} را انتخاب کنید`); return; }
    if (!doc && !$('#dm-type').value) { fieldErr('dm-type', 'نوع مدرک را انتخاب کنید'); return; }
    const iss = readDate('dm-issue', 'تاریخ صدور'), exp = readDate('dm-expiry', 'تاریخ انقضا');
    if (!iss.ok || !exp.ok) return;
    const file = fileInput ? fileInput.files[0] : null;
    if (!doc && !file && !$('#dm-na').checked) { fieldErr('dm-file', 'فایل را انتخاب کنید یا گزینه «اعمال نمی‌شود» را فعال کنید'); return; }
    run(async () => {
      try {
        if (doc) {
          await api('PUT', `/api/documents/${doc.id}`, { issueDate: iss.iso, expiryDate: exp.iso, notes: $('#dm-notes').value, ...(isVeh ? { contractId: $('#dm-contract').value || null } : {}) });
        } else {
          const fd = new FormData();
          fd.append('docTypeId', $('#dm-type').value);
          fd.append('ownerType', type);
          fd.append('ownerId', String(ownerId));
          fd.append('issueDate', iss.iso);
          fd.append('expiryDate', exp.iso);
          fd.append('notes', $('#dm-notes').value);
          fd.append('notApplicable', $('#dm-na').checked ? 'true' : 'false');
          if (isVeh) fd.append('contractId', $('#dm-contract').value || '');
          if (file) fd.append('file', file);
          await api('POST', '/api/documents', fd);
        }
      } catch (err) { applyServerErrors(err, DOC_MAP); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal();
      toast(doc ? 'مدرک به‌روز شد' : 'مدرک با موفقیت بارگذاری و ذخیره شد');
      if (!doc) { DOC_SEL[type] = ownerId; DOC_PAGE[type] = 1; }
      await renderDocPage(type);
    }).catch(() => {});
  };
}
async function openDocumentDetail(id) {
  const d = await api('GET', `/api/documents/${id}`);
  const canEdit = can('documents', 'edit'), canDel = can('documents', 'delete');
  openModal(`<h3>${esc(d.docTypeName)}</h3>
    <ul class="rl">
      <li>${DOC_OWN[d.ownerType].label}: ${esc(d.ownerLabel)}</li>
      <li>دسته: ${esc(d.categoryLabel)}</li>
      <li>قرارداد مرتبط: ${d.contractNumber ? toFa(d.contractNumber) : '—'}</li>
      <li>تاریخ صدور: ${fmtJ(d.issueDate)}</li>
      <li>تاریخ انقضا: ${fmtJ(d.expiryDate)}</li>
      <li>وضعیت: <span class="pill ${d.status === 'expired' || d.status === 'rejected' ? 'bad' : ''}">${DOC_STATUS[d.status]}</span></li>
      <li>فایل: ${d.hasFile ? esc(d.fileName) : 'بارگذاری نشده'}</li>
      <li>توضیحات: ${esc(d.notes || '—')}</li>
    </ul>
    <p class="note">بارگذاری فایل به‌تنهایی به‌معنی تأیید مدرک نیست. مدرک باید توسط کاربر مجاز بررسی و تأیید شود.</p>
    <div class="acts">
      ${d.hasFile ? `<a class="btn ghost sm" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">مشاهده / دانلود فایل</a>` : ''}
      ${canEdit && d.hasFile && d.status !== 'approved' ? `<button class="btn sm" data-act="doc-approve" data-id="${d.id}">تأیید</button>` : ''}
      ${canEdit && d.hasFile && d.status !== 'rejected' ? `<button class="btn ghost sm" data-act="doc-reject" data-id="${d.id}">رد</button>` : ''}
      ${canEdit ? `<button class="btn ghost sm" data-act="doc-edit" data-id="${d.id}">ویرایش مشخصات</button>` : ''}
      ${canEdit ? `<label class="btn ghost sm" style="cursor:pointer">جایگزینی فایل<input type="file" id="docReplace" hidden accept=".pdf,.jpg,.jpeg,.png"></label>` : ''}
      ${canDel ? `<button class="btn danger sm" data-act="doc-del" data-id="${d.id}">حذف</button>` : ''}
    </div>`);
  const rep = $('#docReplace');
  if (rep) rep.onchange = () => run(async () => {
    const f = rep.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    await api('PUT', `/api/documents/${id}/file`, fd);
    toast('فایل جایگزین شد');
    closeModal(); await RENDER[d.ownerType === 'driver' ? 'documents' : 'vehicledocs']();
  });
}

/* ================= Reports ================= */
const RS = { tab: 'activity', page: 1, size: 10 };
function reportFilterVisibility() {
  $$('#rFilters [data-rf]').forEach((el) => { el.style.display = el.dataset.rf === RS.tab ? '' : 'none'; });
  $('#rDates').style.display = RS.tab === 'activity' ? 'flex' : 'none';
  $('#rCsv').style.display = RS.tab === 'activity' ? '' : 'none';
  $$('#rTabs [data-act="rtab"]').forEach((b) => b.classList.toggle('on', b.dataset.v === RS.tab));
}
function initFilters() {
  $('#dfWrap').innerHTML = dateField('dfFrom', 'از تاریخ') + dateField('dfTo', 'تا تاریخ');
  $('#rDates').innerHTML = dateField('r-from', 'از تاریخ') + dateField('r-to', 'تا تاریخ');
  $('#rSec').innerHTML = opt(Object.entries(REF.sections), '', 'همه بخش‌ها');
}
function activityParams(page) {
  const p = new URLSearchParams({ q: $('#rq').value.trim(), user: $('#rUser').value, section: $('#rSec').value, action: $('#rAct').value, outcome: $('#rOut').value, page, size: RS.size });
  const f = parseJ($('#r-from').value), t = parseJ($('#r-to').value);
  if (f) p.set('from', f);
  if (t) p.set('to', t);
  return p;
}
async function renderExportTab() {
  const isEx = RS.tab === 'exports';
  $('#rExport').style.display = isEx ? '' : 'none';
  const tw = $('#rHead').closest('.tw'); if (tw) tw.style.display = isEx ? 'none' : '';
  if (!isEx) return;
  if (!$('#xpBar').dataset.ready) {
    const kinds = (await api('GET', '/api/reports/kinds')).items;
    $('#xpBar').innerHTML = `<select class="input" id="xpKind">${opt(kinds.map((k) => [k.kind, k.name]), '', 'انتخاب گزارش')}</select>` + dateField('xpFrom', 'از تاریخ') + dateField('xpTo', 'تا تاریخ')
      + '<button class="btn" type="button" data-act="xp-download">دریافت CSV</button>';
    $('#xpBar').dataset.ready = '1';
  }
}
function reportExportDownload() {
  const kind = $('#xpKind').value;
  if (!kind) { toast('گزارش را انتخاب کنید'); return; }
  const f = readDate('xpFrom', 'از تاریخ', { optional: true }), t = readDate('xpTo', 'تا تاریخ', { optional: true });
  if (!f.ok || !t.ok) return;
  const qs = new URLSearchParams({ kind, from: f.iso || '', to: t.iso || '' });
  const a = document.createElement('a');
  a.href = '/api/reports/export?' + qs.toString();
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}
async function renderReports() {
  reportFilterVisibility();
  await renderExportTab();
  if (RS.tab === 'exports') return;
  if (RS.tab === 'activity') {
    if (can('users', 'view') && !$('#rUser').options.length) {
      const { items } = await api('GET', '/api/users');
      $('#rUser').innerHTML = opt(items.map((u) => [u.username, u.username]), '', 'همه کاربران');
    }
    const r = await api('GET', `/api/audit?${activityParams(RS.page)}`);
    $('#rHead').innerHTML = '<tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>بخش</th><th>رکورد</th><th>توضیح</th><th>نتیجه</th><th></th></tr>';
    $('#rBody').innerHTML = r.items.map((x) => `<tr><td>${fmtTs(x.ts)}</td><td>${esc(x.username)}</td><td>${{ create: 'ایجاد', update: 'ویرایش', delete: 'حذف', login: 'ورود', logout: 'خروج', login_failed: 'ورود ناموفق' }[x.action] || esc(x.action)}</td><td>${esc(x.sectionLabel)}</td><td>${esc(x.entity)} ${toFa(x.recordId)}</td><td style="white-space:normal">${esc(x.description)}</td><td><span class="pill ${x.outcome === 'موفق' ? '' : 'bad'}">${x.outcome}</span></td><td><button class="btn ghost sm" data-act="detail" data-id="${x.id}">جزئیات</button></td></tr>`).join('') || emptyRow(8);
    renderReportPager(r.total, r.page, r.size);
    return;
  }
  if (RS.tab === 'companies') {
    const q = $('#rq').value.trim();
    if ($('#rProv').options.length < 2) $('#rProv').innerHTML = opt(geoProvinces().map((p) => [p.code, p.name]), $('#rProv').value, 'همه استان‌ها');
    const prov = $('#rProv').value;
    $('#rCity').innerHTML = prov ? opt(geoCities(prov).map((c) => [c.id, c.name]), $('#rCity').value, 'همه شهرهای استان') : '<option value="">ابتدا استان را انتخاب کنید</option>';
    $('#rCity').disabled = !prov;
    if (!prov) $('#rCity').value = '';
    const { items } = await api('GET', `/api/reports/companies?q=${encodeURIComponent(q)}&province=${encodeURIComponent(prov)}&city=${encodeURIComponent($('#rCity').value)}`);
    $('#rHead').innerHTML = '<tr><th>کد</th><th>نام</th><th>نوع</th><th>استان</th><th>شهر</th><th>موبایل</th><th>شناسه ملی</th><th>تاریخ ثبت</th></tr>';
    $('#rBody').innerHTML = items.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc((REF.legal.find(([v]) => v === c.legalType) || [])[1] || '—')}</td><td>${esc(c.province || '—')}</td><td>${esc(c.city || '—')}</td><td>${toFa(c.mobile)}</td><td>${toFa(c.nationalId || '—')}</td><td>${fmtJ(c.regDate)}</td></tr>`).join('') || emptyRow(8);
  } else if (RS.tab === 'contracts') {
    const q = $('#rq').value.trim();
    const { items } = await api('GET', `/api/reports/contracts?q=${encodeURIComponent(q)}&status=${encodeURIComponent($('#rStatus').value)}`);
    $('#rHead').innerHTML = '<tr><th>شماره</th><th>شرکت</th><th>راننده</th><th>خودرو</th><th>شروع</th><th>پایان</th><th>وضعیت</th></tr>';
    $('#rBody').innerHTML = items.map((k) => `<tr><td>${toFa(k.number)}</td><td>${esc(k.companyName)}</td><td>${esc(k.driverName)}</td><td>${plateStr(k.vehiclePlate)}</td><td>${fmtJ(k.startDate)}</td><td>${fmtJ(k.endDate)}</td><td>${k.status}</td></tr>`).join('') || emptyRow(7);
  } else if (RS.tab === 'users') {
    const { items } = await api('GET', '/api/reports/users');
    $('#rHead').innerHTML = '<tr><th>نام کاربری</th><th>نام</th><th>نقش</th><th>وضعیت</th><th>تاریخ ایجاد</th></tr>';
    $('#rBody').innerHTML = items.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td>${u.active ? 'فعال' : 'غیرفعال'}</td><td>${fmtTs(u.createdAt)}</td></tr>`).join('') || emptyRow(5);
  }
  $('#rPager').innerHTML = '';
}
function renderReportPager(total, page, size) {
  const pages = Math.max(1, Math.ceil(total / size));
  $('#rPager').innerHTML = total ? `<button class="btn ghost sm" data-act="rpage" data-v="${page - 1}" ${page <= 1 ? 'disabled' : ''}>قبلی</button><span>صفحه ${toFa(page)} از ${toFa(pages)} (${toFa(total)} رویداد)</span><button class="btn ghost sm" data-act="rpage" data-v="${page + 1}" ${page >= pages ? 'disabled' : ''}>بعدی</button>` : '';
}
async function openDetail(id) {
  const x = await api('GET', `/api/audit/${id}`);
  const ch = x.changes.length ? `<table><thead><tr><th>فیلد</th><th>مقدار قبلی</th><th>مقدار جدید</th></tr></thead><tbody>${x.changes.map((c) => `<tr><td>${esc(c.field)}</td><td style="white-space:normal">${esc(c.from)}</td><td style="white-space:normal">${esc(c.to)}</td></tr>`).join('')}</tbody></table>` : '<p class="note">تغییر فیلدی ثبت نشده است.</p>';
  openModal(`<h3>جزئیات رویداد</h3>
    <ul class="rl"><li>زمان: ${fmtTs(x.ts)}</li><li>کاربر: ${esc(x.username)} (${esc(x.role)})</li><li>عملیات: ${esc(x.action)}</li><li>بخش: ${esc(x.sectionLabel)}</li><li>رکورد: ${esc(x.entity)} ${toFa(x.recordId)}</li><li>نتیجه: ${x.outcome}</li><li>توضیح: ${esc(x.description)}</li></ul>
    <div class="tw" style="margin-top:12px">${ch}</div>
    <div class="acts"><button class="btn ghost" data-act="close">بستن</button></div>`);
}
async function exportCsv() {
  const rows = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api('GET', `/api/audit?${activityParams(page)}&size=100`);
    rows.push(...r.items);
    if (page * 100 >= r.total) break;
  }
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['زمان', 'کاربر', 'نقش', 'عملیات', 'بخش', 'رکورد', 'توضیح', 'نتیجه', 'تغییرات'];
  const lines = rows.map((x) => [fmtTs(x.ts), x.username, x.role, x.action, x.sectionLabel, `${x.entity} ${x.recordId}`, x.description, x.outcome, x.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(' | ')].map(cell).join(','));
  const csv = '\uFEFF' + [head.map(cell).join(',')].concat(lines).join('\n');
  openModal(`<h3>خروجی CSV (${toFa(rows.length)} رویداد)</h3><p class="note">متن را انتخاب و کپی کنید، سپس در فایلی با پسوند .csv ذخیره کنید.</p><textarea class="input" id="csvOut" rows="12" readonly style="direction:ltr;font-size:.75rem">${esc(csv)}</textarea><div class="acts"><button class="btn" data-act="selcsv">انتخاب متن</button><button class="btn ghost" data-act="close">بستن</button></div>`);
}

/* ================= Dashboard renderer (must be defined before RENDER) ================= */
const RENDER = {
  leave: renderLeave, requests: renderRequests, passengers: renderPassengers, finance: renderFinance,
  personnel: renderPersonnel,
  newservice: () => {}, trips: renderTrips, tripapproval: renderTripApproval, monitor: () => { startMonitorPolling(); return renderMonitor(); },
  vdriver: renderVDriver, vsup: renderVSup, vshifts: renderVShifts, vservices: renderVServices,
  settings: renderSettings, inbox: renderInbox, announcements: renderAnnouncements, tasks: renderTasks, meetings: renderMeetings, archive: renderArchive,
  letters: renderLetters, absences: renderAbsences, departments: renderDepartmentsPage,
  dashboard: renderDashboard, companies: renderCompanies, drivers: renderDrivers, vehicles: renderVehicles,
  contracts: renderContracts, documents: renderDriverDocs, vehicledocs: renderVehicleDocs, doctypes: renderDoctypes, users: renderUsers, reports: renderReports,
  profile: async () => {},
};


/* ================= Departments and internal letters ================= */
let DEPTS = [];
async function loadDepts() { DEPTS = (await api('GET', '/api/departments')).items; return DEPTS; }
const deptName = (id) => (DEPTS.find((d) => d.id === id) || {}).name || '—';

const LSTAT = { sent: 'ارسال‌شده', received: 'دریافت‌شده', in_review: 'در حال بررسی', approved: 'تأییدشده', rejected: 'رد شده', returned: 'بازگردانده برای اصلاح', closed: 'بسته‌شده' };
let LTAB = 'inbox';
async function renderLetters() {
  $$('#ltabs [data-act="ltab"]').forEach((b) => b.classList.toggle('on', b.dataset.v === LTAB));
  const q = $('#lSearch').value.trim();
  const eb = $('#ltabEveryone'); if (eb) eb.style.display = ME.root ? '' : 'none';
  if (!$('#lfStatus').dataset.ready) {
    const meta = await api('GET', `/api/letters?box=${LTAB}`);
    $('#lfStatus').innerHTML = opt(Object.entries(meta.statuses || {}), '', 'همه وضعیت‌ها');
    $('#lfClass').innerHTML = opt((meta.classifications || []).map((x) => [x, x]), '', 'همه طبقه‌ها');
    $('#lfDates').innerHTML = dateField('lfFrom', 'از تاریخ') + dateField('lfTo', 'تا تاریخ');
    $('#lfStatus').dataset.ready = '1';
    $('#lfStatus').onchange = $('#lfClass').onchange = () => renderLetters();
  }
  const fr = readDate('lfFrom', 'از تاریخ', { optional: true }), tr = readDate('lfTo', 'تا تاریخ', { optional: true });
  const qs = new URLSearchParams({ box: LTAB, q, status: $('#lfStatus').value, classification: $('#lfClass').value, sender: $('#lfSender').value.trim(), recipient: $('#lfRecipient').value.trim(), from: fr.iso || '', to: tr.iso || '' });
  const { items } = await api('GET', `/api/letters?${qs.toString()}`);
  $('#lBody').innerHTML = items.map((l) => `<tr><td>${toFa(l.number)}</td><td>${esc(l.subject)}</td><td>${esc(l.senderName)}</td><td>${esc(l.recipient)}</td><td><span class="pill">${LSTAT[l.status] || esc(l.status)}</span></td><td>${fmtTs(l.updatedAt)}</td><td><button class="btn ghost sm" data-act="letter-detail" data-id="${l.id}">مشاهده</button></td></tr>`).join('') || emptyRow(7);
}

function letterReturn(id) {
  openModal(`<h3>بازگرداندن نامه برای اصلاح</h3><form id="lrForm" novalidate>
    <div class="field"><label for="lr-note">توضیح اصلاح (الزامی)</label><textarea class="input" id="lr-note" rows="3"></textarea><div class="err" id="lr-note-e"></div></div>
    <div class="acts"><button class="btn" type="submit">بازگرداندن</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#lrForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#lrForm'));
    run(async () => {
      try { await api('POST', `/api/letters/${id}/action`, { action: 'return', note: $('#lr-note').value.trim() }); }
      catch (err) { applyServerErrors(err, { note: 'lr-note' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('نامه بازگردانده شد'); await renderLetters();
    }).catch(() => {});
  };
}

async function openLetterForm() {
  const rec = await api('GET', '/api/letters/recipients');
  openModal(`<h3>نامه جدید</h3>
  <form id="lForm" novalidate>
    <div class="row2">
      <div class="field"><label for="l-class">طبقه‌بندی</label><select class="input" id="l-class">${opt(simple(['عادی', 'محرمانه', 'خیلی محرمانه', 'سری', 'به‌کلی سری']), 'عادی', '—')}</select></div>
      <div class="field"><label for="l-kind">نوع نامه</label><select class="input" id="l-kind">${opt(simple(['داخلی', 'اطلاعیه', 'وارده', 'صادره']), 'داخلی', '—')}</select></div>
      <div class="field" id="l-ext-wrap" style="display:none"><label for="l-ext">طرف بیرونی (فرستنده وارده یا گیرنده صادره)</label><input class="input" id="l-ext"><div class="err" id="l-externalParty-e"></div></div>
      <div class="field"><label for="l-rid">گیرنده (کاربر)</label><select class="input" id="l-rid">${opt(rec.users.map((u) => [u.id, u.name]), '', 'انتخاب کاربر')}</select><div class="err" id="l-recipient-e"></div></div>
    </div>
    <div class="field"><label for="l-subject">موضوع</label><input class="input" id="l-subject"><div class="err" id="l-subject-e"></div></div>
    <div class="field"><label for="l-body">متن نامه (اختیاری)</label><textarea class="input" id="l-body" rows="4"></textarea><div class="err" id="l-body-e"></div></div>
    <div class="field"><span>پیوست‌ها (هر نوع فایل؛ حداکثر ۱۰ فایل)</span>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="btn ghost" for="l-file" style="cursor:pointer">انتخاب فایل‌ها</label><span class="note" id="l-fname">فایلی انتخاب نشده است</span></div>
      <input id="l-file" type="file" multiple style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"><div class="err" id="l-file-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت نامه</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  $('#l-file').onchange = () => {
    const files = [...$('#l-file').files];
    $('#l-fname').textContent = files.length ? files.map((f) => f.name).join('، ') : 'فایلی انتخاب نشده است';
  };
  const toggleExt = () => { const k = $('#l-kind').value; $('#l-ext-wrap').style.display = (k === 'وارده' || k === 'صادره') ? '' : 'none'; };
  $('#l-kind').onchange = toggleExt; toggleExt();
  $('#lForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#lForm'));
    const fd = new FormData();
    fd.append('kind', $('#l-kind').value);
    fd.append('classification', $('#l-class').value);
    if ($('#l-kind').value === 'صادره' && !$('#l-rid').value) { /* outbound letter to an outside party: no internal recipient */ } else { fd.append('recipientType', 'user'); fd.append('recipientId', $('#l-rid').value); }
    fd.append('externalParty', $('#l-ext') ? $('#l-ext').value.trim() : '');
    fd.append('subject', $('#l-subject').value.trim()); fd.append('body', $('#l-body').value.trim());
    [...$('#l-file').files].forEach((f, i) => fd.append(`file${i + 1}`, f));
    run(async () => {
      try { await api('POST', '/api/letters', fd); }
      catch (err) { applyServerErrors(err, { subject: 'l-subject', body: 'l-body', recipient: 'l-recipient', file: 'l-file' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('نامه ثبت شد'); LTAB = 'outbox'; await RENDER.letters();
      const created = (await api('GET', '/api/letters?box=outbox')).items[0];
      if (created) await openLetterDetail(created.id);
    }).catch(() => {});
  };
}

const ABS_KINDS = ['غیبت', 'مرخصی', 'تأخیر'];
async function renderAbsences() {
  const q = normSearch($('#aSearch').value);
  const { items } = await api('GET', '/api/absences');
  const rows = items.filter((x) => !q || normSearch(`${x.userName} ${x.kind} ${x.note}`).includes(q));
  $('#aBody').innerHTML = rows.map((x) => `<tr><td>${esc(x.userName)}</td><td>${esc(x.kind)}</td><td>${fmtJ(x.fromDate)}</td><td>${x.fromTime ? toFa(x.fromTime) : '—'}</td><td>${fmtJ(x.toDate)}</td><td>${x.toTime ? toFa(x.toTime) : '—'}</td><td style="white-space:normal">${esc(x.note || '—')}</td><td>${can('absences', 'delete') ? `<button class="btn danger sm" data-act="del-absence" data-id="${x.id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(8);
}
async function openAbsence() {
  const rec = await api('GET', '/api/letters/recipients');
  const canOther = can('absences', 'edit');
  const people = [[ME.id, `${ME.name} (خودم)`], ...rec.users.map((u) => [u.id, u.name])];
  openModal(`<h3>ثبت غیبت یا مرخصی</h3>
  <form id="abForm" novalidate>
    <div class="row2">
      ${canOther ? `<div class="field"><label for="ab-user">کاربر</label><select class="input" id="ab-user">${opt(people, ME.id, '—')}</select></div>` : ''}
      <div class="field"><label for="ab-kind">نوع ثبت</label><select class="input" id="ab-kind">${opt(simple(ABS_KINDS), 'مرخصی', '—')}</select><div class="err" id="ab-kind-e"></div></div>
      ${dateField('ab-from', 'از تاریخ')}
      <div class="field"><label for="ab-ftime">ساعت شروع (اختیاری)</label><input class="input" type="time" id="ab-ftime"></div>
      ${dateField('ab-to', 'تا تاریخ')}
      <div class="field"><label for="ab-ttime">ساعت پایان (اختیاری)</label><input class="input" type="time" id="ab-ttime"></div>
    </div>
    <div class="field"><label for="ab-note">توضیحات (اختیاری)</label><textarea class="input" id="ab-note" rows="2"></textarea><div class="err" id="ab-note-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>
  </form>`);
  setDate('ab-from', ''); setDate('ab-to', '');
  $('#abForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#abForm'));
    const f = readDate('ab-from', 'از تاریخ'); const t = readDate('ab-to', 'تا تاریخ');
    if (!f.ok || !t.ok) return;
    const body = { kind: $('#ab-kind').value, fromDate: f.iso, toDate: t.iso, fromTime: $('#ab-ftime').value, toTime: $('#ab-ttime').value, note: $('#ab-note').value.trim() };
    if (canOther) body.userId = Number($('#ab-user').value) || ME.id;
    run(async () => {
      let rec;
      try { rec = await api('POST', '/api/absences', body); }
      catch (err) { applyServerErrors(err, { kind: 'ab-kind', fromDate: 'ab-from', toDate: 'ab-to', fromTime: 'ab-ftime', toTime: 'ab-ttime', note: 'ab-note' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('ثبت شد'); await RENDER.absences();
      openModal(`<h3>خلاصه ثبت</h3><ul class="rl"><li>نوع: ${esc(rec.kind)}</li><li>کاربر: ${esc(rec.userName)}</li><li>از: ${fmtJ(rec.fromDate)}${rec.fromTime ? ' ساعت ' + toFa(rec.fromTime) : ''}</li><li>تا: ${fmtJ(rec.toDate)}${rec.toTime ? ' ساعت ' + toFa(rec.toTime) : ''}</li><li>وضعیت: ثبت‌شده</li></ul><div class="acts"><button class="btn" data-act="close">بستن</button></div>`);
    }).catch(() => {});
  };
}

async function openLetterDetail(id) {
  const l = await api('GET', `/api/letters/${id}`);
  const btns = [];
  if (l.canAct && l.status === 'sent') btns.push(`<button class="btn sm" data-act="lact" data-id="${l.id}" data-v="receive">دریافت نامه</button>`);
  if (l.canAct && l.status === 'received') btns.push(`<button class="btn ghost sm" data-act="lact" data-id="${l.id}" data-v="in_review">علامت «در حال بررسی»</button>`);
  if (l.canAct && l.kind !== 'اطلاعیه') btns.push(`<button class="btn sm" data-act="lact" data-id="${l.id}" data-v="approve">تأیید</button>`);
  if (l.canAct && l.kind !== 'اطلاعیه') btns.push(`<button class="btn danger sm" data-act="lact" data-id="${l.id}" data-v="reject">رد</button>`);
  if (l.canAct && l.status !== 'closed') btns.push(`<button class="btn ghost sm" data-act="lreturn" data-id="${l.id}">بازگرداندن برای اصلاح</button>`);
  if (l.senderId === ME.id && l.status === 'returned') btns.push(`<button class="btn sm" data-act="lact" data-id="${l.id}" data-v="resend">ارسال مجدد پس از اصلاح</button>`);
  if (l.canAct) btns.push(`<button class="btn ghost sm" data-act="lfwd" data-id="${l.id}">ارجاع به کاربر</button>`);
  if ((l.canAct || l.senderId === ME.id) && l.status !== 'closed') btns.push(`<button class="btn danger sm" data-act="lact" data-id="${l.id}" data-v="close">بستن نامه</button>`);
  const atts = l.attachments.map((a) => `<a class="btn ghost sm" href="/api/letters/${l.id}/attachments/${a.id}" download>${esc(a.file_name || 'پیوست')} (${toFa(Math.max(1, Math.round(a.size / 1024)))} کیلوبایت)</a>`).join(' ');
  const events = l.events.map((ev) => `<tr><td>${fmtTs(ev.ts)}</td><td>${esc(ev.actorName)}</td><td>${esc(ev.action)}</td><td>${esc(ev.from || '—')}</td><td>${esc(ev.to || '—')}</td><td>${LSTAT[ev.status] || esc(ev.status)}</td><td style="white-space:normal">${esc(ev.note)}</td></tr>`).join('');
  openModal(`<h3>نامه ${toFa(l.number)}</h3>
    <p class="note" style="white-space:normal">${esc(l.summary || '')}</p>
    <ul class="rl"><li>نوع: ${esc(l.kind || 'داخلی')}</li><li>موضوع: ${esc(l.subject)}</li><li>فرستنده: ${esc(l.senderName)}</li><li>گیرنده فعلی: ${esc(l.recipient)}</li><li>وضعیت: ${esc(l.statusLabel || LSTAT[l.status])}</li></ul>
    <p style="white-space:pre-wrap">${esc(l.body || '')}</p>
    ${atts ? `<div class="acts">${atts}</div>` : ''}
    <div class="acts">${btns.join(' ')}</div>
    <div class="tw" style="margin-top:12px"><table><thead><tr><th>زمان</th><th>انجام‌دهنده</th><th>عملیات</th><th>از</th><th>به</th><th>وضعیت</th><th>یادداشت</th></tr></thead><tbody>${events}</tbody></table></div>
    <div class="acts"><button class="btn ghost" data-act="close">بستن</button></div>`);
}
async function letterAction(id, action) {
  await api('POST', `/api/letters/${id}/action`, { action });
  toast('وضعیت نامه به‌روز شد');
  await RENDER.letters();
  await openLetterDetail(id);
}
async function openForward(id) {
  const rec = await api('GET', '/api/letters/recipients');
  openModal(`<h3>ارجاع نامه</h3><form id="fwForm" novalidate>
    <div class="field"><label for="f-rid">گیرنده (کاربر)</label><select class="input" id="f-rid"></select><div class="err" id="f-recipient-e"></div></div>
    <div class="field"><label for="f-note">یادداشت ارجاع (اختیاری)</label><textarea class="input" id="f-note" rows="2"></textarea></div>
    <div class="acts"><button class="btn" type="submit">ارجاع</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#f-rid').innerHTML = opt(rec.users.map((u) => [u.id, u.name]), '', 'انتخاب کاربر');
  $('#fwForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#fwForm'));
    run(async () => {
      try { await api('POST', `/api/letters/${id}/action`, { action: 'forward', recipientType: 'user', recipientId: Number($('#f-rid').value) || null, note: $('#f-note').value.trim() }); }
      catch (err) { applyServerErrors(err, { recipient: 'f-recipient' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('نامه ارجاع شد'); await RENDER.letters(); await openLetterDetail(id);
    }).catch(() => {});
  };
}
async function renderDepartmentsPage() {
  await loadDepts();
  const q = normSearch($('#depSearch').value);
  const users = (await api('GET', '/api/users')).items;
  const rows = DEPTS.filter((d) => !q || normSearch(d.name).includes(q));
  $('#depBody').innerHTML = rows.map((d) => `<tr><td>${esc(d.name)}</td><td>${toFa(users.filter((u) => u.departmentId === d.id).length)}</td></tr>`).join('') || emptyRow(2);
}

function openDepartment() {
  openModal(`<h3>واحد جدید</h3><form id="dpForm" novalidate>
    <div class="field"><label for="dp-name">نام واحد</label><input class="input" id="dp-name"><div class="err" id="dp-name-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ذخیره</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#dpForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#dpForm'));
    run(async () => {
      try { await api('POST', '/api/departments', { name: $('#dp-name').value.trim() }); }
      catch (err) { applyServerErrors(err, { name: 'dp-name' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('واحد ثبت شد'); await RENDER.departments();
    }).catch(() => {});
  };
}

fetch('/api/health').then((r) => r.json()).then((h) => { const t = document.getElementById('verTag'); if (t && h.version) t.textContent = 'نسخه ' + toFa(h.version); }).catch(() => {});


/* ================= Vehicle detail: main info, driver, services, shifts ================= */
function openServiceForm(vehicleId) {
  openModal(`<h3>ثبت سرویس خودرو</h3><form id="svForm" novalidate>
    ${dateField('sv-date', 'تاریخ سرویس')}
    <div class="field"><label for="sv-kind">نوع سرویس</label><input class="input" id="sv-kind"><div class="err" id="sv-kind-e"></div></div>
    <div class="field"><label for="sv-km">کیلومتر (اختیاری)</label><input class="input" id="sv-km" inputmode="numeric"><div class="err" id="sv-odometer-e"></div></div>
    <div class="field"><label for="sv-note">توضیحات (اختیاری)</label><textarea class="input" id="sv-note" rows="2"></textarea></div>
    <div class="acts"><button class="btn" type="submit">ثبت</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('sv-date', '');
  $('#svForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#svForm'));
    const dt = readDate('sv-date', 'تاریخ سرویس');
    if (!dt.ok) return;
    run(async () => {
      try { await api('POST', `/api/vehicles/${vehicleId}/services`, { serviceDate: dt.iso, kind: $('#sv-kind').value.trim(), odometer: normDigits($('#sv-km').value), note: $('#sv-note').value.trim() }); }
      catch (err) { applyServerErrors(err, { serviceDate: 'sv-date', kind: 'sv-kind', odometer: 'sv-km', note: 'sv-note' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('سرویس ثبت شد'); await RENDER.vservices();
    }).catch(() => {});
  };
}
async function openShiftForm(vehicleId) {
  const { items } = await api('GET', '/api/drivers');
  openModal(`<h3>ثبت شیفت خودرو</h3><form id="shForm" novalidate>
    ${dateField('sh-date', 'تاریخ شیفت')}
    <div class="row2">
      <div class="field"><label for="sh-start">ساعت شروع</label><input class="input" type="time" id="sh-start"></div>
      <div class="field"><label for="sh-end">ساعت پایان</label><input class="input" type="time" id="sh-end"></div>
    </div>
    <div class="field"><label for="sh-driver">راننده (اختیاری)</label><select class="input" id="sh-driver">${opt(items.map((x) => [x.id, `${x.first} ${x.last}`]), '', 'بدون راننده')}</select></div>
    <div class="field"><label for="sh-note">توضیحات (اختیاری)</label><textarea class="input" id="sh-note" rows="2"></textarea></div>
    <div class="acts"><button class="btn" type="submit">ثبت</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('sh-date', '');
  $('#shForm').onsubmit = (e) => {
    e.preventDefault();
    clearErrs($('#shForm'));
    const dt = readDate('sh-date', 'تاریخ شیفت');
    if (!dt.ok) return;
    run(async () => {
      try { await api('POST', `/api/vehicles/${vehicleId}/shifts`, { shiftDate: dt.iso, startTime: $('#sh-start').value, endTime: $('#sh-end').value, driverId: Number($('#sh-driver').value) || null, note: $('#sh-note').value.trim() }); }
      catch (err) { applyServerErrors(err, { shiftDate: 'sh-date', startTime: 'sh-start', endTime: 'sh-end', driverId: 'sh-driver', note: 'sh-note' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('شیفت ثبت شد'); await RENDER.vshifts();
    }).catch(() => {});
  };
}


/* ================= Administrative automation: inbox, notice board, tasks, meetings, archive ================= */
const kpiCard = (label, n) => `<div class="kpi"><div class="kpi-n">${toFa(n)}</div><div class="kpi-l">${esc(label)}</div></div>`;
async function renderInbox() {
  const d = await api('GET', '/api/inbox');
  $('#inboxBody').innerHTML = kpiCard('نامه‌های منتظر دریافت', d.letters.toReceive) + kpiCard('نامه‌های در انتظار تصمیم شما', d.letters.waiting)
    + kpiCard('وظایف باز', d.tasks) + kpiCard('جلسات پیش رو', d.meetings);
}
async function renderAnnouncements() {
  const { items, canManage, canCreate } = await api('GET', '/api/announcements');
  $$('[data-act="add-announcement"]').forEach((x) => { x.style.display = canCreate ? '' : 'none'; });
  $('#annBody').innerHTML = items.map((a) => `<div class="card" style="margin-bottom:10px">
      <div class="sec">${a.pinned ? '📌 ' : ''}${esc(a.title)} <span class="pill">${esc(a.audience)}</span></div>
      <p style="white-space:pre-wrap">${esc(a.body || '')}</p>
      ${a.attachments.map((x) => `<a class="btn ghost sm" href="/api/announcements/${a.id}/attachments/${x.id}/download" download>${esc(x.fileName)}</a>`).join(' ')}
      <div class="note">${esc(a.createdBy)} — ${fmtTs(a.createdAt)} — مشاهده‌کنندگان: ${toFa(a.readCount)} از ${toFa(a.audienceCount)}</div>
      <div class="acts">${a.readByMe ? '<span class="pill">شما مشاهده کرده‌اید</span>' : `<button class="btn sm" data-act="ann-read" data-id="${a.id}">ثبت مشاهده اطلاعیه</button>`}
        ${canManage ? `<button class="btn ghost sm" data-act="ann-readers" data-id="${a.id}">فهرست مشاهده و عدم مشاهده</button><button class="btn danger sm" data-act="del-announcement" data-id="${a.id}">حذف</button>` : ''}</div></div>`).join('') || `<p class="empty">اطلاعیه‌ای برای شما ثبت نشده است.</p>`;
}
async function openAnnouncement() {
  const depts = (await api('GET', '/api/departments')).items || [];
  openModal(`<h3>انتشار اطلاعیه</h3><form id="anForm" novalidate>
    <div class="field"><label for="an-title">عنوان</label><input class="input" id="an-title"><div class="err" id="an-title-e"></div></div>
    <div class="field"><label for="an-dept">مخاطب</label><select class="input" id="an-dept">${opt(depts.map((d) => [d.id, `واحد: ${d.name}`]), '', 'همه کارکنان')}</select><div class="err" id="an-departmentId-e"></div></div>
    <div class="field"><label for="an-body">متن</label><textarea class="input" id="an-body" rows="4"></textarea><div class="err" id="an-body-e"></div></div>
    <div class="field"><label for="an-files">پیوست (حداکثر ۵ فایل PDF، JPG یا PNG)</label><input class="input" id="an-files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png"><div class="err" id="an-file-e"></div></div>
    <div class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="an-pin"><label for="an-pin">سنجاق شود</label></div>
    <div class="acts"><button class="btn" type="submit">انتشار</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#anForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#anForm'));
    const fd = new FormData();
    fd.append('title', $('#an-title').value.trim()); fd.append('body', $('#an-body').value.trim()); fd.append('pinned', $('#an-pin').checked ? 'true' : 'false');
    if ($('#an-dept').value) fd.append('departmentId', $('#an-dept').value);
    [...$('#an-files').files].forEach((f, i) => fd.append('file' + (i + 1), f));
    run(async () => {
      try { await api('POST', '/api/announcements', fd); }
      catch (err) { applyServerErrors(err, { title: 'an-title', body: 'an-body', departmentId: 'an-dept', file: 'an-files' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('اطلاعیه منتشر شد'); await RENDER.announcements();
    }).catch(() => {});
  };
}
async function openReaders(id) {
  const r = await api('GET', `/api/announcements/${id}/readers`);
  openModal(`<h3>مشاهده اطلاعیه</h3>
    <p>مشاهده‌کنندگان: ${toFa(r.read.length)} از ${toFa(r.total)}</p>
    <div class="sec">دیده‌اند</div><ul class="rl">${r.read.map((x) => `<li>${esc(x.name)} — ${fmtTs(x.readAt)}</li>`).join('') || '<li>—</li>'}</ul>
    <div class="sec">هنوز ندیده‌اند</div><ul class="rl">${r.unread.map((x) => `<li>${esc(x.name)}</li>`).join('') || '<li>همه مشاهده کرده‌اند</li>'}</ul>
    <div class="acts"><button class="btn ghost" data-act="close">بستن</button></div>`);
}
const TK_STATUS = { todo: 'انجام نشده', doing: 'در حال انجام', done: 'انجام شده' };
async function renderTasks() {
  const st = $('#tStatus'), pr = $('#tPriority');
  const q = normSearch($('#tSearch').value);
  const d = await api('GET', `/api/tasks?status=${encodeURIComponent(st.value)}${$('#tOverdue').checked ? '&overdue=1' : ''}`);
  if (!st.dataset.ready) { st.innerHTML = opt(Object.entries(d.statuses), '', 'همه وضعیت‌ها'); pr.innerHTML = opt(d.priorities.map((x) => [x, x]), '', 'همه اولویت‌ها'); st.dataset.ready = '1'; st.onchange = pr.onchange = $('#tOverdue').onchange = () => renderTasks(); }
  $$('[data-act="add-task"]').forEach((x) => { x.style.display = d.canCreate ? '' : 'none'; });
  const rows = d.items.filter((t) => (!q || normSearch(t.title).includes(q)) && (!pr.value || t.priority === pr.value));
  $('#tkBody').innerHTML = rows.map((t) => `<tr><td style="white-space:normal">${esc(t.title)}${t.overdue ? ' <span class="pill bad">عقب‌افتاده</span>' : ''}</td><td>${esc(t.assigneeName)}</td><td>${esc(t.assignerName)}</td>
    <td>${t.dueDate ? fmtJ(t.dueDate) : '—'}</td><td>${esc(t.priority)}</td><td><span class="pill">${esc(t.statusLabel)}</span></td>
    <td><button class="btn ghost sm" data-act="view-task" data-id="${t.id}">جزئیات</button></td></tr>`).join('') || emptyRow(7);
}
async function openTask() {
  const rec = await api('GET', '/api/letters/recipients');
  const pri = (await api('GET', '/api/tasks')).priorities;
  openModal(`<h3>واگذاری وظیفه</h3><form id="tkForm" novalidate>
    <div class="field"><label for="tk-title">عنوان وظیفه</label><input class="input" id="tk-title"><div class="err" id="tk-title-e"></div></div>
    <div class="row2">
      <div class="field"><label for="tk-assignee">مسئول انجام</label><select class="input" id="tk-assignee">${opt(rec.users.map((u) => [u.id, u.name]), '', 'انتخاب مسئول')}</select><div class="err" id="tk-assigneeId-e"></div></div>
      <div class="field"><label for="tk-prio">اولویت</label><select class="input" id="tk-prio">${opt(pri.map((x) => [x, x]), 'متوسط', '')}</select><div class="err" id="tk-priority-e"></div></div>
      ${dateField('tk-due', 'مهلت (اختیاری)')}
    </div>
    <div class="field"><label for="tk-desc">شرح کامل وظیفه</label><textarea class="input" id="tk-desc" rows="3"></textarea><div class="err" id="tk-description-e"></div></div>
    <div class="field"><label for="tk-exp">نتیجه مورد انتظار</label><textarea class="input" id="tk-exp" rows="2"></textarea><div class="err" id="tk-expectedResult-e"></div></div>
    <div class="acts"><button class="btn" type="submit">واگذاری</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('tk-due', '');
  $('#tkForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#tkForm'));
    const dd = readDate('tk-due', 'مهلت'); if (!dd.ok) return;
    run(async () => {
      try { await api('POST', '/api/tasks', { title: $('#tk-title').value.trim(), assigneeId: Number($('#tk-assignee').value), priority: $('#tk-prio').value, dueDate: dd.iso, description: $('#tk-desc').value.trim(), expectedResult: $('#tk-exp').value.trim() }); }
      catch (err) { applyServerErrors(err, { title: 'tk-title', assigneeId: 'tk-assignee', priority: 'tk-prio', dueDate: 'tk-due', description: 'tk-desc', expectedResult: 'tk-exp' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('وظیفه واگذار شد'); await RENDER.tasks();
    }).catch(() => {});
  };
}
async function openTaskDetail(id) {
  const t = await api('GET', `/api/tasks/${id}`);
  const ev = t.events.map((x) => `<tr><td>${fmtTs(x.at)}</td><td>${esc(x.action.startsWith('status:') ? 'تغییر وضعیت' : x.action === 'progress' ? 'گزارش پیشرفت' : 'واگذاری')}</td><td>${esc(x.actor)}</td><td style="white-space:pre-wrap">${esc(x.note || '—')}</td></tr>`).join('');
  const files = t.attachments.map((a) => `<li><a href="/api/tasks/${t.id}/attachments/${a.id}/download" download>${esc(a.fileName)}</a></li>`).join('') || '<li>پیوستی ثبت نشده است.</li>';
  const statusBtns = t.isAssignee ? t.nextStatuses.map((s) => `<button class="btn sm" data-act="task-status" data-id="${t.id}" data-v="${s}">تغییر به: ${esc(TK_STATUS[s])}</button>`).join(' ') : '';
  openModal(`<h3>${esc(t.title)}</h3>
    <ul class="rl"><li>واگذارکننده: ${esc(t.assignerName)} — مسئول انجام: ${esc(t.assigneeName)}</li><li>اولویت: ${esc(t.priority)} — مهلت: ${t.dueDate ? fmtJ(t.dueDate) : '—'}${t.overdue ? ' <span class="pill bad">عقب‌افتاده</span>' : ''}</li>
    <li>وضعیت: <span class="pill">${esc(t.statusLabel)}</span></li></ul>
    <div class="sec">شرح کامل</div><p style="white-space:pre-wrap">${esc(t.description || '—')}</p>
    <div class="sec">نتیجه مورد انتظار</div><p style="white-space:pre-wrap">${esc(t.expectedResult || '—')}</p>
    <div class="sec">پیوست‌ها</div><ul>${files}</ul>
    ${t.isAssignee ? `<div class="acts">${statusBtns}</div>
      <div class="field" style="margin-top:10px"><label for="tp-note">گزارش پیشرفت</label><textarea class="input" id="tp-note" rows="2"></textarea><div class="err" id="tp-note-e"></div></div>
      <div class="acts"><button class="btn" data-act="task-progress" data-id="${t.id}">ثبت گزارش پیشرفت</button></div>` : '<p class="note">فقط مسئول انجام می‌تواند وضعیت را تغییر دهد یا گزارش پیشرفت ثبت کند.</p>'}
    <div class="field" style="margin-top:10px"><label for="tk-file">پیوست (PDF، JPG یا PNG)</label><input class="input" id="tk-file" type="file" accept=".pdf,.jpg,.jpeg,.png"><div class="err" id="tk-file-e"></div></div>
    <div class="acts"><button class="btn ghost" data-act="task-attach" data-id="${t.id}">بارگذاری پیوست</button></div>
    <div class="sec">تاریخچه</div><div class="tw"><table><thead><tr><th>زمان</th><th>اقدام</th><th>کاربر</th><th>توضیح</th></tr></thead><tbody>${ev}</tbody></table></div>
    <div class="acts"><button class="btn ghost" data-act="close">بستن</button></div>`);
}
async function renderMeetings() {
  const { items, canManage } = await api('GET', '/api/meetings');
  $('#mtBody').innerHTML = items.map((m) => `<tr><td style="white-space:normal"><b>${esc(m.title)}</b>${m.agenda ? `<div class="note" style="white-space:pre-wrap">${esc(m.agenda)}</div>` : ''}</td>
    <td>${fmtJ(m.meetingDate)}</td><td>${m.startTime ? toFa(m.startTime) : '—'}${m.endTime ? ' تا ' + toFa(m.endTime) : ''}</td><td>${esc(m.location || '—')}</td>
    <td style="white-space:normal">${esc(m.participants.map((p) => p.name).join('، ') || '—')}</td>
    <td>${canManage ? `<button class="btn danger sm" data-act="del-meeting" data-id="${m.id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(6);
}
async function openMeeting() {
  const rec = await api('GET', '/api/letters/recipients');
  openModal(`<h3>جلسه جدید</h3><form id="mtForm" novalidate>
    <div class="field"><label for="mt-title">عنوان جلسه</label><input class="input" id="mt-title"><div class="err" id="mt-title-e"></div></div>
    <div class="row2">
      ${dateField('mt-date', 'تاریخ جلسه')}
      <div class="field"><label for="mt-loc">محل (اختیاری)</label><input class="input" id="mt-loc"><div class="err" id="mt-location-e"></div></div>
      <div class="field"><label for="mt-start">ساعت شروع</label><input class="input" type="time" id="mt-start"><div class="err" id="mt-startTime-e"></div></div>
      <div class="field"><label for="mt-end">ساعت پایان</label><input class="input" type="time" id="mt-end"><div class="err" id="mt-endTime-e"></div></div>
    </div>
    <div class="field"><span>شرکت‌کنندگان</span><div class="chips">${rec.users.map((u) => `<label class="chip"><input type="checkbox" data-mt="${u.id}"> ${esc(u.name)}</label>`).join('') || '<span class="note">کاربری برای دعوت وجود ندارد.</span>'}</div><div class="err" id="mt-participants-e"></div></div>
    <div class="field"><label for="mt-agenda">دستور جلسه (اختیاری)</label><textarea class="input" id="mt-agenda" rows="3"></textarea><div class="err" id="mt-agenda-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت جلسه</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('mt-date', '');
  $('#mtForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#mtForm'));
    const dd = readDate('mt-date', 'تاریخ جلسه'); if (!dd.ok) return;
    const participants = [...document.querySelectorAll('[data-mt]:checked')].map((x) => Number(x.dataset.mt));
    run(async () => {
      try { await api('POST', '/api/meetings', { title: $('#mt-title').value.trim(), meetingDate: dd.iso, startTime: $('#mt-start').value, endTime: $('#mt-end').value, location: $('#mt-loc').value.trim(), agenda: $('#mt-agenda').value.trim(), participants }); }
      catch (err) { applyServerErrors(err, { title: 'mt-title', meetingDate: 'mt-date', location: 'mt-loc', startTime: 'mt-start', endTime: 'mt-end', participants: 'mt-participants', agenda: 'mt-agenda' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('جلسه ثبت شد'); await RENDER.meetings();
    }).catch(() => {});
  };
}
async function renderArchive() {
  const q = normSearch($('#arSearch').value), cat = $('#arCat').value;
  const { items, categories, canDelete } = await api('GET', `/api/archive?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`);
  if (!$('#arCat').dataset.ready) { $('#arCat').innerHTML = opt(simple(categories), cat, 'همه دسته‌ها'); $('#arCat').dataset.ready = '1'; }
  $('#arBody').innerHTML = items.map((d) => `<tr><td style="white-space:normal">${esc(d.title)}</td><td>${esc(d.category)}</td><td>${esc(d.fileName)}</td><td>${toFa(Math.max(1, Math.round(d.size / 1024)))} کیلوبایت</td><td>${esc(d.uploadedBy)}</td><td>${fmtTs(d.createdAt)}</td>
    <td><a class="btn ghost sm" href="/api/archive/${d.id}/download" download>دانلود</a> ${canDelete ? `<button class="btn danger sm" data-act="del-doc" data-id="${d.id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(7);
}
async function openArchiveForm() {
  const { categories } = await api('GET', '/api/archive');
  openModal(`<h3>بایگانی سند</h3><form id="arForm" novalidate>
    <div class="field"><label for="ar-title">عنوان سند</label><input class="input" id="ar-title"><div class="err" id="ar-title-e"></div></div>
    <div class="field"><label for="ar-cat">دسته‌بندی</label><select class="input" id="ar-cat">${opt(simple(categories), '', 'انتخاب دسته')}</select><div class="err" id="ar-category-e"></div></div>
    <div class="field"><span>فایل سند (هر نوع فایل)</span><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="btn ghost" for="ar-file" style="cursor:pointer">انتخاب فایل</label><span class="note" id="ar-fname">فایلی انتخاب نشده است</span></div>
      <input id="ar-file" type="file" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"><div class="err" id="ar-file-e"></div></div>
    <div class="acts"><button class="btn" type="submit">بایگانی</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#ar-file').onchange = () => { const f = $('#ar-file').files[0]; $('#ar-fname').textContent = f ? f.name : 'فایلی انتخاب نشده است'; };
  $('#arForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#arForm'));
    const fd = new FormData(); fd.append('title', $('#ar-title').value.trim()); fd.append('category', $('#ar-cat').value);
    const f = $('#ar-file').files[0]; if (f) fd.append('file1', f);
    run(async () => {
      try { await api('POST', '/api/archive', fd); }
      catch (err) { applyServerErrors(err, { title: 'ar-title', category: 'ar-cat', file: 'ar-file' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('سند بایگانی شد'); await RENDER.archive();
    }).catch(() => {});
  };
}


/* ================= System settings ================= */
async function renderSettings() {
  const d = await api('GET', '/api/settings');
  $('#st-min').value = toFa(d.sessionIdleMinutes);
  $('#st-current').textContent = `مدت فعلی: ${toFa(d.sessionIdleMinutes)} دقیقه (بین ${toFa(d.limits.min)} تا ${toFa(d.limits.max)})`;
}
async function saveSessionTimeout() {
  clearErrs(document.body);
  const minutes = Number(normDigits($('#st-min').value));
  run(async () => {
    try { await api('PUT', '/api/settings/session-timeout', { minutes }); }
    catch (err) { applyServerErrors(err, { minutes: 'st-min' }); throw Object.assign(new Error('handled'), { status: -1 }); }
    toast('مدت بی‌فعالیتی ذخیره شد');
    await renderSettings();
  }).catch(() => {});
}


/* ================= Vehicle section sub-pages ================= */
async function renderVDriver() {
  const q = normSearch($('#vdSearch2').value);
  const { items } = await api('GET', '/api/vehicle-overview');
  const rows = items.filter((v) => !q || normSearch(`${v.plateText} ${v.brand} ${v.model} ${v.currentDriver?.name || ''}`).includes(q));
  $('#vdrvBody').innerHTML = rows.map((v) => `<tr><td>${plateStr(v.plate)}</td><td>${esc(v.brand)} ${esc(v.model)}</td>
    <td>${esc(v.currentDriver?.name || '—')}</td><td>${v.currentDriver ? toFa(v.currentDriver.contractNumber) : '—'}</td>
    <td>${v.currentDriver ? `${fmtJ(v.currentDriver.from)}${v.currentDriver.to ? ' تا ' + fmtJ(v.currentDriver.to) : ' (بدون پایان)'}` : '—'}</td></tr>`).join('') || emptyRow(5);
}
async function renderVSup() {
  const manage = NAV_MODE === 'manage';
  $$('[data-manage]').forEach((x) => { x.style.display = manage ? '' : 'none'; });
  const sq = normSearch($('#supSiteSearch').value);
  const sites = (await api('GET', '/api/sites')).items;
  const canEdit = can('vehicles', 'edit');
  $('#supSitesBody').innerHTML = sites.filter((x) => !sq || normSearch(`${x.code} ${x.name}`).includes(sq)).map((x) => `<tr><td>${esc(x.code || '—')}</td><td>${esc(x.name)}</td>
    <td><span class="pill ${x.active ? '' : 'bad'}">${x.active ? 'فعال' : 'غیرفعال'}</span></td><td>${canEdit ? `<button class="btn ghost sm" data-act="edit-site" data-id="${x.id}">ویرایش</button>` : ''}</td></tr>`).join('') || emptyRow(4);
  const sel = $('#supUnitSite'); const cur = sel.value;
  if (!sel.dataset.ready || sel.dataset.n !== String(sites.length)) { sel.innerHTML = opt(sites.map((x) => [x.id, `${x.code || ''} ${x.name}`]), cur, 'همه سایت‌ها'); sel.dataset.ready = '1'; sel.dataset.n = String(sites.length); }
  sel.onchange = () => renderVSup();
  const uq = normSearch($('#supUnitSearch').value), siteId = sel.value;
  const units = (await api('GET', `/api/supervision-units?siteId=${encodeURIComponent(siteId)}`)).items;
  $('#supUnitsBody').innerHTML = units.filter((x) => !uq || normSearch(`${x.code} ${x.name}`).includes(uq)).map((x) => `<tr><td>${esc(x.code || '—')}</td><td>${esc(x.name)}</td><td>${esc(x.siteCode || '—')}</td><td>${esc(x.siteName)}</td>
    <td><span class="pill ${x.active ? '' : 'bad'}">${x.active ? 'فعال' : 'غیرفعال'}</span></td><td>${canEdit ? `<button class="btn ghost sm" data-act="edit-unit" data-id="${x.id}">ویرایش</button>` : ''}</td></tr>`).join('') || emptyRow(6);
}
function openSiteForm(site = null) {
  const v = site || {};
  openModal(`<h3>${site ? 'ویرایش سایت' : 'سایت جدید'}</h3><form id="stForm" novalidate>
    <div class="row2">
      <div class="field"><label for="st-code">کد سایت</label><input class="input" id="st-code" value="${esc(v.code || '')}"><div class="err" id="st-code-e"></div></div>
      <div class="field"><label for="st-name">نام سایت</label><input class="input" id="st-name" value="${esc(v.name || '')}"><div class="err" id="st-name-e"></div></div>
    </div>
    <div class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="st-active" ${site ? (v.active ? 'checked' : '') : 'checked'}><label for="st-active">فعال</label></div>
    <div class="acts"><button class="btn" type="submit">ذخیره</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#stForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#stForm'));
    run(async () => {
      const body = { code: $('#st-code').value.trim(), name: $('#st-name').value.trim(), active: $('#st-active').checked };
      try { if (site) await api('PUT', `/api/sites/${site.id}`, body); else await api('POST', '/api/sites', body); }
      catch (err) { applyServerErrors(err, { code: 'st-code', name: 'st-name' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('سایت ذخیره شد'); await RENDER.vsup();
    }).catch(() => {});
  };
}
async function openUnitForm(unit = null) {
  const sites = (await api('GET', '/api/sites')).items;
  const v = unit || {};
  const locked = !!unit;
  const existing = sites.filter((x) => x.active).map((x) => [x.id, `${x.code || ''} - ${x.name}`]);
  openModal(`<h3>${unit ? 'ویرایش واحد نظارت' : 'واحد نظارت جدید'}</h3><form id="suForm" novalidate>
    <div class="row2">
      <div class="field"><label for="su-code">کد واحد نظارت</label><input class="input" id="su-code" value="${esc(v.code || '')}"><div class="err" id="su-code-e"></div></div>
      <div class="field"><label for="su-name">نام واحد نظارت</label><input class="input" id="su-name" value="${esc(v.name || '')}"><div class="err" id="su-name-e"></div></div>
    </div>
    <div class="row2">
      <div class="field"><label for="su-status">وضعیت</label><select class="input" id="su-status">${opt([['فعال', 'فعال'], ['غیرفعال', 'غیرفعال']], unit ? (v.active ? 'فعال' : 'غیرفعال') : 'فعال', '—')}</select></div>
      <div class="field"><label for="su-existing">سایت موجود (اختیاری)</label><select class="input" id="su-existing" ${locked ? 'disabled' : ''}>${opt(existing, unit ? (v.siteId || '') : '', 'انتخاب سایت موجود')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label for="su-site-code">کد سایت</label><input class="input" id="su-site-code" value="${esc(v.siteCode || '')}" ${locked ? 'disabled' : ''}><div class="err" id="su-siteCode-e"></div></div>
      <div class="field"><label for="su-site-name">نام سایت</label><input class="input" id="su-site-name" value="${esc(v.siteName || '')}" ${locked ? 'disabled' : ''}><div class="err" id="su-siteName-e"></div></div>
    </div>
    <div class="note">اگر سایت قبلاً ثبت شده، آن را از «سایت موجود» انتخاب کنید یا همان کد و نام را وارد کنید تا سایت تکراری ساخته نشود.</div>
    <div class="acts"><button class="btn" type="submit">ذخیره</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#su-existing').onchange = () => {
    const site = sites.find((x) => x.id === Number($('#su-existing').value));
    if (site) { $('#su-site-code').value = site.code || ''; $('#su-site-name').value = site.name; }
  };
  $('#suForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#suForm'));
    run(async () => {
      const body = { code: $('#su-code').value.trim(), name: $('#su-name').value.trim(), active: $('#su-status').value === 'فعال' };
      if (unit) body.siteId = unit.siteId;
      else if ($('#su-existing').value) { const st = sites.find((x) => x.id === Number($('#su-existing').value)); body.siteCode = st.code || ''; body.siteName = st.name; }
      else { body.siteCode = $('#su-site-code').value.trim(); body.siteName = $('#su-site-name').value.trim(); }
      try { if (unit) await api('PUT', `/api/supervision-units/${unit.id}`, body); else await api('POST', '/api/supervision-units', body); }
      catch (err) { applyServerErrors(err, { code: 'su-code', name: 'su-name', siteCode: 'su-site-code', siteName: 'su-site-name', active: 'su-status', siteId: 'su-existing' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('واحد نظارت ذخیره شد'); await RENDER.vsup();
    }).catch(() => {});
  };
}

async function renderVShifts() {
  const q = normSearch($('#vshSearch').value);
  const { items, canDelete } = await api('GET', '/api/vehicle-shifts');
  const rows = items.filter((s) => !q || normSearch(`${s.vehicle} ${s.driverName}`).includes(q));
  $('#vshBody').innerHTML = rows.map((s) => `<tr><td>${plateTxt(s.vehicle)} <div class="note">${esc(s.brand)}</div></td><td>${fmtJ(s.shiftDate)}</td><td>${s.startTime ? toFa(s.startTime) : '—'}</td><td>${s.endTime ? toFa(s.endTime) : '—'}</td><td>${esc(s.driverName || '—')}</td><td style="white-space:normal">${esc(s.note || '—')}</td>
    <td>${canDelete ? `<button class="btn danger sm" data-act="del-vshift" data-id="${s.id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(7);
}
async function renderVServices() {
  const plans = (await api('GET', '/api/service-plans')).items;
  const calcLabel = { per_service: 'به ازای هر سرویس', fixed_monthly: 'ثابت ماهانه' };
  $('#spBody').innerHTML = plans.map((p) => `<tr><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${fmtJ(p.startDate)}</td><td>${esc(p.siteName)}</td><td>${esc(p.unitName)}</td><td>${esc(p.region)}</td><td>${esc(p.routeType)}</td><td>${esc(p.directionStatus)}</td><td>${toFa(p.allowedMinutes)}</td><td>${esc(p.serviceNumber)}</td><td>${p.routes.length}</td><td>${p.passengers.length}</td>
    <td>${p.vehicleRate ? `${toFa(p.vehicleRate.fee)} تومان` : '—'}</td><td>${p.companyRate ? `${esc(calcLabel[p.companyRate.calcType])}: ${toFa(p.companyRate.amount)}` : '—'}</td><td>${can('vehicles', 'edit') ? `<button class="btn ghost sm" data-act="edit-plan" data-id="${p.id}">ویرایش</button> ` : ''}${can('vehicles', 'delete') ? `<button class="btn danger sm" data-act="del-plan" data-id="${p.id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(15);
  const q = normSearch($('#vsvSearch').value);
  const { items, canDelete } = await api('GET', '/api/vehicle-services');
  const rows = items.filter((s) => !q || normSearch(`${s.vehicle} ${s.kind}`).includes(q));
  $('#vsvBody').innerHTML = rows.map((s) => `<tr><td>${plateTxt(s.vehicle)} <div class="note">${esc(s.brand)}</div></td><td>${fmtJ(s.serviceDate)}</td><td>${esc(s.kind)}</td><td>${s.odometer ? toFa(s.odometer) : '—'}</td><td style="white-space:normal">${esc(s.note || '—')}</td>
    <td>${canDelete ? `<button class="btn danger sm" data-act="del-vservice" data-id="${s.id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(6);
}
const plateTxt = (t) => `<span dir="ltr" class="plate-txt">${esc(t)}</span>`;
async function pickVehicle(then) {
  const { items } = await api('GET', '/api/vehicle-overview');
  openModal(`<h3>انتخاب خودرو</h3><form id="pvForm" novalidate>
    <div class="field"><label for="pv-veh">خودرو</label><select class="input" id="pv-veh">${opt(items.map((v) => [v.id, `${plainPlate(v.plate)} (${v.brand} ${v.model})`]), '', 'انتخاب خودرو')}</select><div class="err" id="pv-veh-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ادامه</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#pvForm').onsubmit = (e) => { e.preventDefault(); const id = Number($('#pv-veh').value); if (!id) { fieldErr('pv-veh', 'خودرو را انتخاب کنید'); return; } closeModal(); then(id); };
}


/* ================= Service plan wizard (six steps) ================= */
const WZ_STEPS = ['اطلاعات اصلی', 'اطلاعات شیفت', 'اطلاعات مسیر', 'لیست مسافران', 'نرخ خودرو', 'نرخ کارفرما'];
let WZ = null;
function wzEmpty() {
  return { step: 0, opts: null, sup: null, vehicles: null,
    f: { code: '', name: '', startDate: '', siteId: '', region: '', routeType: '', gender: '', returnService: '', directionStatus: '', vehicleGroup: '', vehicleClass: '', supervisionUnitId: '', allowedMinutes: '', serviceNumber: '' },
    routes: [{ origin: '', destination: '', description: '', km: '', startTime: '', endTime: '' }], passengers: [], vehicleRate: null, companyRate: null };
}
function shiftLabel() {
  const x = (WZ.shifts || []).find((y) => String(y.id) === String(WZ.shiftId));
  return x ? `${x.vehicle} — ${x.shiftDate}` : '';
}
// Step 0 of "تعریف سرویس جدید": choose the fixed service type first.
function openServiceTypeChoice() {
  openModal(`<h3>نوع سرویس را انتخاب کنید</h3>
    <div class="acts" style="flex-direction:column;gap:10px">
      <button class="btn" type="button" data-act="svc-type" data-v="ایاب و ذهاب سبک پرسنل">ایاب و ذهاب سبک پرسنل</button>
      <button class="btn" type="button" data-act="svc-type" data-v="ایاب و ذهاب سنگین پرسنل">ایاب و ذهاب سنگین پرسنل</button>
      <button class="btn ghost" type="button" data-act="close">انصراف</button>
    </div>`);
}
async function openServicePlanWizard(plan = null, serviceType = '') {
  WZ = wzEmpty();
  WZ.f.serviceType = plan ? plan.serviceType : serviceType;
  if (plan) {
    WZ.editId = plan.id;
    WZ.f = { serviceType: plan.serviceType, code: plan.code, name: plan.name, startDate: plan.startDate, siteId: String(plan.siteId), region: plan.region, routeType: plan.routeType, gender: plan.gender,
      returnService: plan.returnService, directionStatus: plan.directionStatus, vehicleGroup: plan.vehicleGroup, vehicleClass: plan.vehicleClass || '',
      supervisionUnitId: String(plan.supervisionUnitId), allowedMinutes: String(plan.allowedMinutes), serviceNumber: plan.serviceNumber };
    WZ.routes = plan.routes.length ? plan.routes.map((r) => ({ ...r, km: String(r.km) })) : WZ.routes;
    WZ.passengers = plan.passengers;
    WZ.companyRate = plan.companyRate;
    WZ.shiftId = plan.shiftId ? String(plan.shiftId) : '';
    if (plan.vehicleRate) WZ.vehicleRate = { vehicleId: plan.vehicleRate.vehicleId, fee: plan.vehicleRate.fee, notes: plan.vehicleRate.notes || '', info: plan.vehicleRate.snapshot || {} };
  }
  WZ.opts = await api('GET', '/api/service-plan-options');
  WZ.sup = await api('GET', '/api/supervision-options');
  WZ.vehicles = (await api('GET', '/api/vehicle-overview')).items;
  WZ.shifts = (await api('GET', '/api/vehicle-shifts')).items;
  if (!plan) WZ.shiftId = '';
  renderWizard();
}
function wzCollect() {
  const st = WZ.step;
  if (st === 0) {
    WZ.f = { serviceType: WZ.f.serviceType, code: $('#w-code').value.trim(), name: $('#w-name').value.trim(), startDate: readDate('w-start', 'تاریخ شروع').iso || '',
      siteId: $('#w-site').value, region: $('#w-region').value, routeType: $('#w-rtype').value, gender: $('#w-gender').value,
      returnService: $('#w-ret').value, directionStatus: $('#w-dir').value, vehicleGroup: $('#w-group').value, vehicleClass: $('#w-class').value,
      supervisionUnitId: $('#w-unit').value, allowedMinutes: normDigits($('#w-minutes').value), serviceNumber: normDigits($('#w-svc').value).trim() };
  }
  if (st === 1) WZ.shiftId = $('#w-shift') ? $('#w-shift').value : '';
  if (st === 2) {
    WZ.routes = [...document.querySelectorAll('[data-wr]')].map((tr) => ({
      originPoint: (WZ.routes[Number(tr.dataset.wr)] || {}).originPoint || null, destinationPoint: (WZ.routes[Number(tr.dataset.wr)] || {}).destinationPoint || null,
      origin: tr.querySelector('[data-f=origin]').value.trim(), destination: tr.querySelector('[data-f=destination]').value.trim(), description: tr.querySelector('[data-f=description]').value.trim(),
      km: normDigits(tr.querySelector('[data-f=km]').value), startTime: tr.querySelector('[data-f=startTime]').value, endTime: tr.querySelector('[data-f=endTime]').value }));
  }
}
function renderWizard() {
  const st = WZ.step;
  const bar = WZ_STEPS.map((t, i) => `<span class="pill ${i === st ? '' : 'ghost'}" style="margin:2px">${i + 1}. ${t}</span>`).join(' ');
  let body = '';
  if (st === 0) {
    const f = WZ.f, groups = WZ.opts.categories;
    const curGroup = f.vehicleGroup;
    body = `<div class="note">نوع سرویس: <b>${esc(WZ.f.serviceType || '—')}</b></div>
    <div class="row2">
      <div class="field"><label for="w-code">کد</label><input class="input" id="w-code" value="${esc(f.code)}"><div class="err" id="w-code-e"></div></div>
      <div class="field"><label for="w-name">نام</label><input class="input" id="w-name" value="${esc(f.name)}"><div class="err" id="w-name-e"></div></div>
      ${dateField('w-start', 'تاریخ شروع')}
      <div class="field"><label for="w-site">سایت</label><select class="input" id="w-site">${opt(WZ.sup.sites.map((x) => [x.id, x.name]), f.siteId, 'انتخاب سایت')}</select><div class="err" id="w-siteId-e"></div></div>
      <div class="field"><label for="w-unit">واحد نظارت</label><select class="input" id="w-unit"></select><div class="err" id="w-supervisionUnitId-e"></div></div>
      <div class="field"><label for="w-region">ناحیه</label><select class="input" id="w-region">${opt(WZ.opts.regions.map((x) => [x, x]), f.region, 'انتخاب ناحیه')}</select><div class="err" id="w-region-e"></div></div>
      <div class="field"><label for="w-rtype">نوع مسیر</label><select class="input" id="w-rtype">${opt(WZ.opts.routeTypes.map((x) => [x, x]), f.routeType, 'انتخاب نوع مسیر')}</select><div class="err" id="w-routeType-e"></div></div>
      <div class="field"><label for="w-gender">جنسیت</label><select class="input" id="w-gender">${opt(WZ.opts.genders.map((x) => [x, x]), f.gender, 'انتخاب جنسیت')}</select><div class="err" id="w-gender-e"></div></div>
      <div class="field"><label for="w-ret">سرویس برگشت</label><select class="input" id="w-ret">${opt(WZ.opts.returnServices.map((x) => [x, x]), f.returnService, 'انتخاب سرویس برگشت')}</select><div class="err" id="w-returnService-e"></div></div>
      <div class="field"><label for="w-dir">وضعیت رفت و برگشت</label><select class="input" id="w-dir">${opt(WZ.opts.directions.map((x) => [x, x]), f.directionStatus, 'انتخاب وضعیت')}</select><div class="err" id="w-directionStatus-e"></div></div>
      <div class="field"><label for="w-group">گروه خودرو</label><select class="input" id="w-group">${opt(groups.map((g) => [g.value, g.value]), curGroup, 'انتخاب گروه خودرو')}</select><div class="err" id="w-vehicleGroup-e"></div></div>
      <div class="field"><label for="w-class">کلاس خودرو</label><select class="input" id="w-class"></select><div class="err" id="w-vehicleClass-e"></div></div>
      <div class="field"><label for="w-minutes">زمان مجاز (دقیقه)</label><input class="input" id="w-minutes" inputmode="numeric" value="${esc(f.allowedMinutes)}"><div class="err" id="w-allowedMinutes-e"></div></div>
      <div class="field"><label for="w-svc">شماره سرویس</label><input class="input" id="w-svc" value="${esc(f.serviceNumber)}"><div class="err" id="w-serviceNumber-e"></div></div>
    </div>`;
  } else if (st === 1) {
    const shifts = WZ.shifts || [];
    body = `<div class="row2">
        <div class="field"><label for="w-shift">شیفت (از شیفت‌های ثبت‌شده در سامانه)</label><select class="input" id="w-shift">${opt(shifts.map((x) => [x.id, `${x.vehicle} — ${fmtJ(x.shiftDate)} ${x.startTime || ''}${x.endTime ? ' تا ' + x.endTime : ''} — ${x.driverName || 'بدون راننده'}`]), WZ.shiftId || '', shifts.length ? 'انتخاب شیفت' : 'شیفتی در سامانه ثبت نشده است')}</select></div>
        <div class="field"><label for="w-shiftgroup">گروه شیفت</label><input class="input" id="w-shiftgroup" disabled value="در سامانه گروه شیفت تعریف نشده است"></div>
      </div>
      <div class="acts"><button class="btn ghost" type="button" disabled>تعریف شیفت — بزودی</button></div>`;
  } else if (st === 2) {
    body = `<div class="tw"><table><thead><tr><th>مبدأ</th><th>مقصد</th><th>شرح مسیر</th><th>کیلومتر</th><th>ساعت شروع</th><th>ساعت پایان</th><th></th></tr></thead><tbody id="w-routes">
      ${WZ.routes.map((r, i) => `<tr data-wr="${i}">
        <td><input class="input" data-f="origin" value="${esc(r.origin)}"></td><td><input class="input" data-f="destination" value="${esc(r.destination)}"></td>
        <td><input class="input" data-f="description" value="${esc(r.description || '')}"></td>
        <td><input class="input" data-f="km" inputmode="numeric" value="${esc(r.km)}"></td>
        <td><input class="input" type="time" data-f="startTime" value="${esc(r.startTime)}"></td><td><input class="input" type="time" data-f="endTime" value="${esc(r.endTime)}"></td>
        <td><button class="btn ghost sm" type="button" data-act="wz-route-map" data-v="${i}">انتخاب روی نقشه</button> <button class="btn danger sm" type="button" data-act="wz-del-route" data-v="${i}">حذف</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="acts"><button class="btn ghost sm" type="button" data-act="wz-add-route">+ افزودن مسیر</button></div>
    <div class="err" id="w-routes-e"></div>`;
  } else if (st === 3) {
    body = `<div class="acts"><button class="btn sm" type="button" data-act="wz-add-passenger">تعریف مسافران</button></div>
      <div class="tw"><table><thead><tr><th>مسافر</th><th>ایستگاه سوار</th><th>ایستگاه پیاده</th><th>شروع</th><th>پایان</th><th></th></tr></thead><tbody>
      ${WZ.passengers.map((p, i) => `<tr><td>${esc(p.name)}</td><td>${esc(p.boarding)}</td><td>${esc(p.alighting)}</td><td>${fmtJ(p.startDate)} ${esc(p.startTime)}</td><td>${fmtJ(p.endDate)} ${esc(p.endTime)}</td><td><button class="btn danger sm" type="button" data-act="wz-del-passenger" data-v="${i}">حذف</button></td></tr>`).join('') || emptyRow(6)}
      </tbody></table></div><div class="err" id="w-passengers-e"></div>`;
  } else if (st === 4) {
    body = `<div class="acts"><button class="btn sm" type="button" data-act="wz-rate-vehicle">تعریف نرخ خودرو</button></div>
      ${WZ.vehicleRate ? `<div class="row2">${[
        ['راننده', WZ.vehicleRate.info.driverName || '—'], ['کد ملی راننده', WZ.vehicleRate.info.driverNid ? toFa(WZ.vehicleRate.info.driverNid) : '—'],
        ['گروه خودرو', WZ.vehicleRate.info.category || '—'], ['نوع خودرو', `${WZ.vehicleRate.info.brand || ''} ${WZ.vehicleRate.info.model || ''}`.trim()],
        ['کلاس خودرو', WZ.vehicleRate.info.cls || '—'], ['تاریخ شروع قرارداد', WZ.vehicleRate.info.contractStart ? fmtJ(WZ.vehicleRate.info.contractStart) : '—'],
        ['تاریخ پایان قرارداد', WZ.vehicleRate.info.contractEnd ? fmtJ(WZ.vehicleRate.info.contractEnd) : 'بدون پایان'], ['پیمانکار', WZ.vehicleRate.info.contractor || '—'],
        ['پلاک', WZ.vehicleRate.info.plate || '—'], ['ظرفیت سرنشین', WZ.vehicleRate.info.capacity ? toFa(WZ.vehicleRate.info.capacity) : '—'],
        ['توضیحات', WZ.vehicleRate.notes || '—'], ['فی (تومان)', toFa(WZ.vehicleRate.fee)]].map(([l, v]) => `<div class="field"><label>${l}</label><input class="input" disabled value="${esc(String(v))}"></div>`).join('')}</div>` : '<p class="note">نرخی برای خودرو تعریف نشده است (اختیاری).</p>'}`;
  } else if (st === 5) {
    const cr = WZ.companyRate;
    body = `<div class="row2">
      <div class="field"><label for="w-calc">نوع محاسبه</label><select class="input" id="w-calc">${opt(WZ.opts.calcTypes.map((x) => [x.value, x.label]), cr ? cr.calcType : '', 'انتخاب نوع محاسبه')}</select><div class="err" id="w-calc-e"></div></div>
      <div class="field"><label for="w-amount">مبلغ (تومان)</label><input class="input" id="w-amount" inputmode="numeric" value="${esc(cr ? cr.amount : '')}"><div class="err" id="w-amount-e"></div></div>
    </div>
    <div class="acts"><button class="btn sm" type="button" data-act="wz-rate-company">ثبت نرخ کارفرما</button></div>
    ${cr ? `<p class="note">نرخ کارفرما: ${esc(WZ.opts.calcTypes.find((x) => x.value === cr.calcType)?.label || '')} — ${toFa(cr.amount)} تومان</p>` : '<p class="note">نرخ کارفرما هنوز ثبت نشده است.</p>'}`;
  }
  const last = st === WZ_STEPS.length - 1;
  openModal(`<h3>${WZ.editId ? 'ویرایش سرویس' : 'ثبت سرویس جدید'}</h3>
    <div class="chips">${bar}</div>
    <div id="wz-err" class="err"></div>
    <div id="wz-body">${body}</div>
    <div class="acts">
      ${st > 0 ? '<button class="btn ghost" type="button" data-act="wz-prev">مرحله قبل</button>' : ''}
      ${!last ? '<button class="btn" type="button" data-act="wz-next">مرحله بعد</button>' : '<button class="btn" type="button" data-act="wz-save">ثبت سرویس</button>'}
      <button class="btn ghost" type="button" data-act="close">انصراف</button>
    </div>`);
  if (st === 0) {
    setDate('w-start', WZ.f.startDate || '');
    const fillUnits = () => { const sid = Number($('#w-site').value) || 0; const list = WZ.sup.units.filter((u) => u.siteId === sid); $('#w-unit').innerHTML = opt(list.map((u) => [u.id, u.name]), WZ.f.supervisionUnitId, sid ? 'انتخاب واحد نظارت' : 'ابتدا سایت را انتخاب کنید'); $('#w-unit').disabled = !sid; };
    const fillClasses = () => { const g = $('#w-group').value; const cls = WZ.opts.categories.find((c) => c.value === g)?.classes || []; $('#w-class').innerHTML = opt(cls.map((c) => [c, c]), WZ.f.vehicleClass, g === 'سواری' ? 'انتخاب کلاس' : '—'); $('#w-class').disabled = g !== 'سواری'; };
    fillUnits(); fillClasses();
    $('#w-site').onchange = () => { WZ.f.supervisionUnitId = ''; fillUnits(); };
    $('#w-group').onchange = () => { WZ.f.vehicleClass = ''; fillClasses(); };
  }
  if (st === 4 || st === 5) { /* nothing extra */ }
}
function wzGoto(delta) {
  wzCollect();
  if (delta > 0) {
    const errs = wzValidateStep(WZ.step);
    if (errs.length) { $('#wz-err').textContent = errs.join(' — '); return; }
  }
  WZ.step = Math.max(0, Math.min(WZ_STEPS.length - 1, WZ.step + delta));
  renderWizard();
}
function wzValidateStep(st) {
  const e = [];
  if (st === 0) {
    const f = WZ.f;
    if (!f.code) e.push('کد را وارد کنید'); if (!f.name) e.push('نام را وارد کنید'); if (!f.startDate) e.push('تاریخ شروع را وارد کنید');
    if (!f.siteId) e.push('سایت را انتخاب کنید'); if (!f.supervisionUnitId) e.push('واحد نظارت را انتخاب کنید');
    if (!f.region) e.push('ناحیه را انتخاب کنید'); if (!f.routeType) e.push('نوع مسیر را انتخاب کنید'); if (!f.gender) e.push('جنسیت را انتخاب کنید');
    if (!f.returnService) e.push('سرویس برگشت را انتخاب کنید'); if (!f.directionStatus) e.push('وضعیت رفت و برگشت را انتخاب کنید');
    if (!f.vehicleGroup) e.push('گروه خودرو را انتخاب کنید'); if (f.vehicleGroup === 'سواری' && !f.vehicleClass) e.push('کلاس خودرو را انتخاب کنید');
    if (!f.allowedMinutes) e.push('زمان مجاز را وارد کنید'); if (!f.serviceNumber) e.push('شماره سرویس را وارد کنید');
  }
  if (st === 2) {
    if (!WZ.routes.length) e.push('حداقل یک مسیر وارد کنید');
    WZ.routes.forEach((r, i) => { if (!r.origin || !r.destination || !r.km || !r.startTime || !r.endTime) e.push(`مسیر ${i + 1} را کامل کنید`); });
  }
  return e;
}
function wzShowServerErrors(err) {
  const fields = err.fields || {};
  const keys = Object.keys(fields);
  $('#wz-err').textContent = keys.length ? keys.map((k) => fields[k]).join(' — ') : (err.message || 'خطا در ثبت');
  const map = { code: 'w-code', name: 'w-name', startDate: 'w-start', siteId: 'w-site', supervisionUnitId: 'w-unit', region: 'w-region', routeType: 'w-rtype', gender: 'w-gender', returnService: 'w-ret', directionStatus: 'w-dir', vehicleGroup: 'w-group', vehicleClass: 'w-class', allowedMinutes: 'w-minutes', serviceNumber: 'w-svc' };
  keys.forEach((k) => { if (map[k]) fieldErr(map[k], fields[k]); });
}
$('body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act^="wz-"]');
  if (!b || !WZ) return;
  const act = b.dataset.act;
  if (act === 'wz-next') return wzGoto(1);
  if (act === 'wz-prev') return wzGoto(-1);
  if (act === 'wz-add-route') { wzCollect(); WZ.routes.push({ origin: '', destination: '', description: '', km: '', startTime: '', endTime: '' }); return renderWizard(); }
  if (act === 'wz-del-route') { wzCollect(); WZ.routes.splice(Number(b.dataset.v), 1); if (!WZ.routes.length) WZ.routes.push({ origin: '', destination: '', description: '', km: '', startTime: '', endTime: '' }); return renderWizard(); }
  if (act === 'wz-add-passenger') return openPassengerForm();
  if (act === 'wz-route-map') { wzCollect(); return openRouteMap(Number(b.dataset.v)); }
  if (act === 'wz-del-passenger') { WZ.passengers.splice(Number(b.dataset.v), 1); return renderWizard(); }
  if (act === 'wz-rate-vehicle') return openVehicleRateForm();
  if (act === 'wz-rate-company') return saveCompanyRate();
  if (act === 'wz-save') return saveServicePlan();
});
function openPassengerForm() {
  openModal(`<h3>تعریف مسافر</h3><form id="pxForm" novalidate>
    <div class="row2">
      <div class="field"><label for="px-name">نام مسافر</label><input class="input" id="px-name"><div class="err" id="px-name-e"></div></div>
      <div class="field"><label for="px-board">ایستگاه سوار شدن</label><input class="input" id="px-board"><div class="err" id="px-board-e"></div></div>
      <div class="field"><label for="px-alight">ایستگاه پیاده شدن</label><input class="input" id="px-alight"><div class="err" id="px-alight-e"></div></div>
      ${dateField('px-sd', 'تاریخ شروع')}
      <div class="field"><label for="px-st">زمان شروع</label><input class="input" type="time" id="px-st"></div>
      ${dateField('px-ed', 'تاریخ پایان')}
      <div class="field"><label for="px-et">زمان پایان</label><input class="input" type="time" id="px-et"></div>
    </div>
    <div class="err" id="px-err"></div>
    <div class="acts"><button class="btn" type="submit">افزودن مسافر</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('px-sd', ''); setDate('px-ed', '');
  $('#pxForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#pxForm'));
    const sd = readDate('px-sd', 'تاریخ شروع'), ed = readDate('px-ed', 'تاریخ پایان');
    const row = { name: $('#px-name').value.trim(), boarding: $('#px-board').value.trim(), alighting: $('#px-alight').value.trim(), startDate: sd.iso || '', startTime: $('#px-st').value, endDate: ed.iso || '', endTime: $('#px-et').value };
    const miss = [];
    if (row.name.length < 2) miss.push('نام مسافر');
    if (!row.boarding) miss.push('ایستگاه سوار شدن'); if (!row.alighting) miss.push('ایستگاه پیاده شدن');
    if (!row.startDate || !row.startTime) miss.push('تاریخ و زمان شروع'); if (!row.endDate || !row.endTime) miss.push('تاریخ و زمان پایان');
    if (miss.length) { $('#px-err').textContent = 'تکمیل کنید: ' + miss.join('، '); return; }
    WZ.passengers.push(row); closeModal(); renderWizard();
  };
}
async function openVehicleRateForm() {
  const list = WZ.vehicles;
  openModal(`<h3>تعریف نرخ خودرو</h3><form id="vrForm" novalidate>
    <div class="field"><label for="vr-veh">خودرو</label><select class="input" id="vr-veh">${opt(list.map((v) => [v.id, `${plainPlate(v.plate)} - ${v.brand} ${v.model}`]), '', 'انتخاب خودرو')}</select><div class="err" id="vr-veh-e"></div></div>
    <div id="vr-info" class="note"></div>
    <div class="row2">
      <div class="field"><label for="vr-fee">فی (تومان)</label><input class="input" id="vr-fee" inputmode="numeric"><div class="err" id="vr-fee-e"></div></div>
      <div class="field"><label for="vr-notes">توضیحات</label><input class="input" id="vr-notes"><div class="err" id="vr-notes-e"></div></div>
    </div>
    <div class="err" id="vr-err"></div>
    <div class="acts"><button class="btn" type="submit">ثبت نرخ خودرو</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  let info = null;
  $('#vr-veh').onchange = async () => {
    const id = Number($('#vr-veh').value); info = null;
    if (!id) return;
    info = await api('GET', `/api/vehicles/${id}/contract-info`);
    $('#vr-info').textContent = info.driverName ? `راننده: ${info.driverName} — قرارداد از ${fmtJ(info.contractStart)} ${info.contractEnd ? 'تا ' + fmtJ(info.contractEnd) : '(بدون پایان)'}` : 'راننده فعالی برای این خودرو در قراردادها نیست.';
  };
  $('#vrForm').onsubmit = (e) => { e.preventDefault();
    const id = Number($('#vr-veh').value);
    const fee = normDigits($('#vr-fee').value);
    if (!id) { $('#vr-err').textContent = 'خودرو را انتخاب کنید'; return; }
    if (!fee) { $('#vr-err').textContent = 'فی را وارد کنید'; return; }
    WZ.vehicleRate = { vehicleId: id, fee: Number(fee), notes: $('#vr-notes').value.trim(), info: info || {} };
    closeModal(); renderWizard();
  };
}
function saveCompanyRate() {
  const calc = $('#w-calc').value, amount = normDigits($('#w-amount').value);
  clearErrs($('#wz-body'));
  if (!calc) { fieldErr('w-calc', 'نوع محاسبه را انتخاب کنید'); return; }
  if (!amount) { fieldErr('w-amount', 'مبلغ را وارد کنید'); return; }
  WZ.companyRate = { calcType: calc, amount: Number(amount) };
  renderWizard();
}
async function saveServicePlan() {
  wzCollect();
  saveCompanyRateIfFilled();
  for (let i = 0; i < 3; i++) { const errs = wzValidateStep(i); if (errs.length) { WZ.step = i; renderWizard(); $('#wz-err').textContent = errs.join(' — '); return; } }
  const body = { serviceType: WZ.f.serviceType, code: WZ.f.code, name: WZ.f.name, startDate: WZ.f.startDate, siteId: Number(WZ.f.siteId), supervisionUnitId: Number(WZ.f.supervisionUnitId),
    region: WZ.f.region, routeType: WZ.f.routeType, gender: WZ.f.gender, returnService: WZ.f.returnService, directionStatus: WZ.f.directionStatus,
    vehicleGroup: WZ.f.vehicleGroup, vehicleClass: WZ.f.vehicleClass, allowedMinutes: WZ.f.allowedMinutes, serviceNumber: WZ.f.serviceNumber,
    routes: WZ.routes, passengers: WZ.passengers, shiftId: WZ.shiftId ? Number(WZ.shiftId) : null, shiftName: shiftLabel(),
    vehicleRate: WZ.vehicleRate ? { vehicleId: WZ.vehicleRate.vehicleId, fee: WZ.vehicleRate.fee, notes: WZ.vehicleRate.notes || '' } : null,
    companyRate: WZ.companyRate };
  try { if (WZ.editId) await api('PUT', `/api/service-plans/${WZ.editId}`, body); else await api('POST', '/api/service-plans', body); }
  catch (err) { WZ.step = 0; renderWizard(); wzShowServerErrors(err); return; }
  closeModal(); WZ = null; toast('سرویس ذخیره شد'); await RENDER.vservices();
}
function saveCompanyRateIfFilled() { if ($('#w-calc') && $('#w-calc').value && normDigits($('#w-amount').value)) WZ.companyRate = { calcType: $('#w-calc').value, amount: Number(normDigits($('#w-amount').value)) }; }


/* ================= Fixed services: trips, approval, monitoring ================= */
async function renderTrips() {
  const q = normSearch($('#trSearch').value);
  const { items } = await api('GET', '/api/trips');
  const { canApprove } = await api('GET', '/api/trips');
  $('#trBody').innerHTML = items.filter((t) => !q || normSearch(`${t.planName} ${t.planCode}`).includes(q)).map((t) => `<tr><td>${esc(t.planName)}</td><td>${esc(t.planCode)}</td><td>${esc(t.serviceType)}</td><td>${fmtJ(t.tripDate)}</td><td><span class="pill ${t.status === 'rejected' ? 'bad' : ''}">${esc(t.statusLabel)}</span></td>
    <td>${canApprove && t.status === 'approved' ? `<button class="btn sm" data-act="start-trip" data-id="${t.id}">شروع سفر</button>` : ''}${canApprove && t.status === 'started' ? `<button class="btn danger sm" data-act="finish-trip" data-id="${t.id}">پایان سفر</button>` : ''}</td></tr>`).join('') || emptyRow(6);
}
async function renderTripApproval() {
  const { items, canApprove } = await api('GET', '/api/trips?status=pending');
  $('#taBody').innerHTML = items.map((t) => `<tr><td>${esc(t.planName)}</td><td>${esc(t.planCode)}</td><td>${esc(t.serviceType)}</td><td>${fmtJ(t.tripDate)}</td><td>${esc(t.createdBy)}</td>
    <td>${canApprove ? `<button class="btn sm" data-act="approve-trip" data-id="${t.id}">تایید</button> <button class="btn danger sm" data-act="reject-trip" data-id="${t.id}">رد</button>` : ''}</td></tr>`).join('') || emptyRow(6);
}
async function openStartTrip(tripId) {
  const drivers = (await api('GET', '/api/drivers')).items;
  openModal(`<h3>شروع سفر</h3><form id="stForm2" novalidate>
    <div class="field"><label for="st-driver">راننده این سفر</label><select class="input" id="st-driver">${opt(drivers.map((d) => [d.id, `${d.first} ${d.last} — ${toFa(d.nid)}`]), '', 'انتخاب راننده')}</select><div class="err" id="st-driver-e"></div></div>
    <p class="note">با شروع سفر، ارسال موقعیت راننده فعال می‌شود و فقط تا پایان سفر ادامه دارد.</p>
    <div class="acts"><button class="btn" type="submit">شروع سفر</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#stForm2').onsubmit = (e) => { e.preventDefault(); clearErrs($('#stForm2'));
    run(async () => {
      try { await api('PUT', `/api/trips/${tripId}/start`, { driverId: Number($('#st-driver').value) || null }); }
      catch (err) { applyServerErrors(err, { driverId: 'st-driver' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('سفر شروع شد'); await RENDER.trips();
    }).catch(() => {});
  };
}
async function openTripForm() {
  const { items } = await api('GET', '/api/service-plans');
  openModal(`<h3>ثبت سفر</h3><form id="trForm" novalidate>
    <div class="field"><label for="tr-plan">سرویس</label><select class="input" id="tr-plan">${opt(items.map((p) => [p.id, `${p.code} — ${p.name} (${p.serviceType})`]), '', 'انتخاب سرویس')}</select><div class="err" id="tr-plan-e"></div></div>
    ${dateField('tr-date', 'تاریخ سفر')}
    <div class="acts"><button class="btn" type="submit">ثبت سفر</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('tr-date', '');
  $('#trForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#trForm'));
    const dt = readDate('tr-date', 'تاریخ سفر'); if (!dt.ok) return;
    run(async () => {
      try { await api('POST', `/api/service-plans/${$('#tr-plan').value}/trips`, { tripDate: dt.iso }); }
      catch (err) { applyServerErrors(err, { tripDate: 'tr-date' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('سفر ثبت شد'); await RENDER.trips();
    }).catch(() => {});
  };
}
let MAP = null, MAP_LAYERS = null, MAP_LAST = [];
// Neshan map (Neshan's Leaflet SDK). Every failure is reported with its real cause.
function neshanMap(elId, opts) {
  const key = (window.MISTA_MAP_KEY || '').trim();
  if (!key) return { error: 'کلید نقشه نشان تنظیم نشده است. کلید را در فایل public/config.js در MISTA_MAP_KEY بگذارید و صفحه را دوباره بارگذاری کنید.' };
  // Neshan issues two key types: "web." keys display maps; "service." keys call routing and other APIs.
  // A service key in the map setting produces "API Key type not suitable for this service" and error 483.
  if (key.startsWith('service.')) return { error: 'کلید وارد‌شده در MISTA_MAP_KEY از نوع سرویس (service.) است و برای نمایش نقشه کار نمی‌کند. کلید نمایش نقشه باید از نوع web. باشد. کلید سرویس فقط در متغیر NESHAN_API_KEY روی سرور قرار می‌گیرد.' };
  if (window.MISTA_NESHAN_LOAD_FAILED || typeof L === 'undefined') return { error: 'کتابخانه نقشه نشان از static.neshan.org بارگذاری نشد. اتصال اینترنت، فیلترینگ یا دسترسی به این آدرس را بررسی کنید.' };
  const map = new L.Map(elId, Object.assign({ key, maptype: 'dreamy', poi: false, traffic: false, center: [32.5, 53.7], zoom: 5 }, opts || {}));
  // Tile errors usually mean the key is refused or the domain is not allowed for it.
  if (map.on) map.on('tileerror', function (e) { if (!window.__mistaTileErrShown) { window.__mistaTileErrShown = true; toast('بارگذاری کاشی‌های نقشه ناموفق بود؛ کلید یا دامنه مجاز را در پنل نشان بررسی کنید.'); } });
  return { map };
}
function ensureMap() {
  if (MAP) return MAP;
  const r = neshanMap('mnMap', { minZoom: 5, maxBounds: [[25, 44], [40, 64]] });
  if (r.error) { $('#mnNote').textContent = r.error; return null; }
  MAP = r.map;
  MAP_LAYERS = L.layerGroup().addTo(MAP);
  return MAP;
}
async function renderMonitor() {
  const { items } = await api('GET', '/api/locations/latest');
  const drivers = (await api('GET', '/api/drivers')).items;
  $('#mnDriver').innerHTML = opt(drivers.map((d) => [d.id, `${d.first} ${d.last}`]), $('#mnDriver').value, 'انتخاب راننده');
  $('#mnBody').innerHTML = items.map((l) => `<tr><td>${esc(l.driverName)}</td><td dir="ltr">${l.lat.toFixed(5)}</td><td dir="ltr">${l.lng.toFixed(5)}</td><td>${l.accuracy != null ? toFa(Math.round(l.accuracy)) : '—'}</td><td>${fmtTs(l.recordedAt)} ${l.stale ? '<span class="pill bad">قدیمی</span>' : '<span class="pill">زنده</span>'}</td></tr>`).join('') || emptyRow(5);
  const map = ensureMap();
  if (!map) return;
  MAP_LAYERS.clearLayers();
  MAP_LAST = items;
  items.forEach((l) => {
    const color = l.stale ? '#9ca3af' : '#16a34a';
    const m = L.circleMarker([l.lat, l.lng], { radius: 9, color, fillColor: color, fillOpacity: 0.9, weight: 2 }).addTo(MAP_LAYERS);
    m.bindPopup(`<b>${esc(l.driverName)}</b><br>${l.stale ? 'موقعیت قدیمی' : 'زنده'}<br>آخرین ثبت: ${fmtTs(l.recordedAt)}`);
    m.on('click', () => { $('#mnDriver').value = String(l.driverId); });
  });
  const sel = items.find((l) => String(l.driverId) === String($('#mnDriver').value));
  if (sel && $('#mnFollow').checked) map.setView([sel.lat, sel.lng], 15);
  setTimeout(() => map.invalidateSize(), 50);
}
function sendLocation() {
  const driverId = Number($('#mnDriver').value);
  if (!driverId) { toast('ابتدا راننده را انتخاب کنید'); return; }
  if (!navigator.geolocation) { toast('مرورگر این دستگاه موقعیت مکانی را پشتیبانی نمی‌کند'); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await api('POST', '/api/locations', { driverId, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      toast('موقعیت ثبت شد'); await renderMonitor();
    } catch (err) { toast(err.message || 'ثبت موقعیت ناموفق بود'); }
  }, (err) => toast('دسترسی به موقعیت مکانی داده نشد: ' + err.message), { enableHighAccuracy: true, timeout: 15000 });
}


/* ================= Route stations on the map (Neshan) ================= */
function openRouteMap(index) {
  const row = WZ.routes[index] || {};
  openModal(`<h3>انتخاب ایستگاه‌ها روی نقشه</h3>
    <div class="note" id="rm-hint">ابتدا روی ایستگاه سوار شدن و سپس روی ایستگاه پیاده شدن کلیک کنید.</div>
    <div id="rm-map" style="height:380px;border-radius:12px;overflow:hidden"></div>
    <div class="row2">
      <div class="field"><label for="rm-origin">نام ایستگاه سوار شدن</label><input class="input" id="rm-origin" value="${esc(row.origin || '')}"></div>
      <div class="field"><label for="rm-dest">نام ایستگاه پیاده شدن</label><input class="input" id="rm-dest" value="${esc(row.destination || '')}"></div>
    </div>
    <div class="err" id="rm-err"></div>
    <div class="acts"><button class="btn" type="button" data-act="rm-apply" data-v="${index}">ثبت مسیر و محاسبه</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div>`);
  const pts = { origin: row.originPoint || null, destination: row.destinationPoint || null };
  const nm = neshanMap('rm-map', { minZoom: 5, maxBounds: [[25, 44], [40, 64]], center: pts.origin ? [pts.origin.lat, pts.origin.lng] : [32.5, 53.7], zoom: pts.origin ? 11 : 5 });
  if (nm.error) { $('#rm-err').textContent = nm.error + ' می‌توانید نام ایستگاه‌ها را وارد کنید و کیلومتر و زمان را دستی بزنید.'; return; }
  const m = nm.map;
  let markers = [];
  const draw = () => { markers.forEach((x) => m.removeLayer(x)); markers = []; if (pts.origin) markers.push(L.marker([pts.origin.lat, pts.origin.lng]).addTo(m)); if (pts.destination) markers.push(L.marker([pts.destination.lat, pts.destination.lng]).addTo(m)); };
  draw();
  m.on('click', (e) => {
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (!pts.origin || (pts.origin && pts.destination)) { pts.origin = p; pts.destination = null; $('#rm-hint').textContent = 'حالا ایستگاه پیاده شدن را انتخاب کنید.'; }
    else { pts.destination = p; $('#rm-hint').textContent = 'ایستگاه‌ها انتخاب شد. نام‌ها را وارد کنید و ثبت کنید.'; }
    draw();
  });
  setTimeout(() => m.invalidateSize(), 50);
  WZ.routePick = pts;
}
function addMinutes(hhmmStr, minutes) {
  const [h, mi] = hhmmStr.split(':').map(Number);
  const t = h * 60 + mi + minutes;
  if (t >= 24 * 60) return null;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
async function applyRouteMap(index) {
  clearErrs($('#modal'));
  const pts = WZ.routePick || {};
  const origin = $('#rm-origin').value.trim(), destination = $('#rm-dest').value.trim();
  if (!pts.origin || !pts.destination) { $('#rm-err').textContent = 'هر دو ایستگاه را روی نقشه انتخاب کنید.'; return; }
  if (origin.length < 2 || destination.length < 2) { $('#rm-err').textContent = 'نام هر دو ایستگاه را وارد کنید.'; return; }
  let est;
  try { est = await api('POST', '/api/routes/estimate', { origin: pts.origin, destination: pts.destination }); }
  catch (err) { $('#rm-err').textContent = err.message || 'محاسبه مسیر ناموفق بود'; return; }
  const row = WZ.routes[index];
  row.origin = origin; row.destination = destination; row.originPoint = pts.origin; row.destinationPoint = pts.destination;
  row.km = String(est.km);
  if (row.startTime) { const end = addMinutes(row.startTime, est.minutes); if (end) row.endTime = end; }
  closeModal(); renderWizard();
  toast(`کیلومتر: ${est.km} — زمان حدود ${est.minutes} دقیقه`);
}


async function createDriverLink() {
  const driverId = Number($('#mnDriver').value);
  if (!driverId) { toast('ابتدا راننده را انتخاب کنید'); return; }
  const r = await api('POST', `/api/drivers/${driverId}/tracking-link`);
  const url = location.origin + r.url;
  openModal(`<h3>لینک ردیابی ${esc(r.driverName)}</h3>
    <p class="note">${esc(r.note)}</p>
    <div class="field"><label for="dl-url">لینک (روی گوشی راننده باز شود)</label><input class="input" id="dl-url" dir="ltr" readonly value="${esc(url)}"></div>
    <div class="acts"><button class="btn" type="button" id="dl-copy">کپی لینک</button><button class="btn ghost" type="button" data-act="close">بستن</button></div>`);
  $('#dl-copy').onclick = () => { $('#dl-url').select(); if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('لینک کپی شد'), () => toast('لینک را دستی کپی کنید')); else toast('لینک را دستی کپی کنید'); };
}


function showAllVehicles() {
  if (!MAP || !MAP_LAST.length) { toast('موقعیت معتبری برای نمایش وجود ندارد'); return; }
  MAP.fitBounds(MAP_LAST.map((l) => [l.lat, l.lng]), { padding: [40, 40], maxZoom: 15 });
}
// Live refresh: the monitoring page asks for positions every 5 seconds while it is open.
let MON_TIMER = null;
function startMonitorPolling() {
  if (MON_TIMER) return;
  MON_TIMER = setInterval(() => { if (CUR === 'monitor') renderMonitor().catch(() => {}); else { clearInterval(MON_TIMER); MON_TIMER = null; } }, 5000);
}


/* ================= Personnel files (phase 1) ================= */
let PERS_STATUS = null;
async function renderPersonnel() {
  const q = normSearch($('#pSearch').value), st = $('#pStatus').value;
  const d = await api('GET', `/api/personnel?q=${encodeURIComponent(q)}&status=${encodeURIComponent(st)}`);
  if (!PERS_STATUS) PERS_STATUS = d.statuses;
  if (!$('#pStatus').dataset.ready) { $('#pStatus').innerHTML = opt(Object.entries(d.statuses), st, 'همه وضعیت‌ها'); $('#pStatus').dataset.ready = '1'; }
  $('#pStatus').onchange = () => renderPersonnel();
  $('#pOwnNote').style.display = d.ownOnly ? '' : 'none';
  $$('[data-act="add-person"]').forEach((x) => { x.style.display = d.canCreate ? '' : 'none'; });
  $('#pBody').innerHTML = d.items.map((p) => `<tr><td>${esc(p.firstName)} ${esc(p.lastName)}</td><td>${esc(p.personnelCode || '—')}</td><td dir="ltr">${esc(p.nationalId)}</td><td>${esc(p.unitName || '—')}</td><td>${esc(p.position || '—')}</td>
    <td><span class="pill ${p.status === 'dismissed' || p.status === 'inactive' ? 'bad' : ''}">${esc(p.statusLabel)}</span></td>
    <td><button class="btn ghost sm" data-act="view-person" data-id="${p.id}">مشاهده</button></td></tr>`).join('') || emptyRow(7);
}
async function personnelFormData() {
  const [units, companies, people] = await Promise.all([api('GET', '/api/departments'), api('GET', '/api/companies'), api('GET', '/api/personnel')]);
  return { units: units.items || [], companies: companies.items || [], people: people.items || [] };
}
async function openPersonForm(p = null) {
  const x = p || {};
  const { units, companies, people } = await personnelFormData();
  const statuses = Object.entries(PERS_STATUS || { active: 'فعال', inactive: 'غیرفعال', on_assignment: 'مأمور', on_leave: 'مرخصی', dismissed: 'تعدیل‌شده' });
  openModal(`<h3>${p ? 'ویرایش پرونده پرسنلی' : 'پرونده پرسنلی جدید'}</h3><form id="pfForm" novalidate>
    <div class="row2">
      <div class="field"><label for="pf-first">نام</label><input class="input" id="pf-first" value="${esc(x.firstName || '')}"><div class="err" id="pf-first-e"></div></div>
      <div class="field"><label for="pf-last">نام خانوادگی</label><input class="input" id="pf-last" value="${esc(x.lastName || '')}"><div class="err" id="pf-last-e"></div></div>
      <div class="field"><label for="pf-nid">کد ملی</label><input class="input" id="pf-nid" inputmode="numeric" value="${esc(x.nationalId || '')}"><div class="err" id="pf-nid-e"></div></div>
      <div class="field"><label for="pf-code">شماره پرسنلی</label><input class="input" id="pf-code" value="${esc(x.personnelCode || '')}"><div class="err" id="pf-code-e"></div></div>
      <div class="field"><label for="pf-pos">سمت</label><input class="input" id="pf-pos" value="${esc(x.position || '')}"><div class="err" id="pf-pos-e"></div></div>
      <div class="field"><label for="pf-unit">واحد سازمانی</label><select class="input" id="pf-unit">${opt(units.map((u) => [u.id, u.name]), x.unitId || '', 'بدون واحد')}</select><div class="err" id="pf-unit-e"></div></div>
      <div class="field"><label for="pf-mgr">مدیر مستقیم</label><select class="input" id="pf-mgr">${opt(people.filter((q2) => q2.id !== x.id).map((q2) => [q2.id, `${q2.firstName} ${q2.lastName}`]), x.directManagerId || '', 'بدون مدیر مستقیم')}</select><div class="err" id="pf-mgr-e"></div></div>
      <div class="field"><label for="pf-emp">شرکت کارفرما</label><select class="input" id="pf-emp">${opt(companies.map((c) => [c.id, c.name]), x.employerCompanyId || '', 'بدون کارفرما')}</select><div class="err" id="pf-emp-e"></div></div>
      <div class="field"><label for="pf-mob">موبایل</label><input class="input" id="pf-mob" inputmode="tel" value="${esc(x.mobile || '')}"><div class="err" id="pf-mob-e"></div></div>
      <div class="field"><label for="pf-tel">تلفن</label><input class="input" id="pf-tel" value="${esc(x.phone || '')}"><div class="err" id="pf-tel-e"></div></div>
      ${dateField('pf-start', 'تاریخ استخدام')}
      <div class="field"><label for="pf-status">وضعیت</label><select class="input" id="pf-status">${opt(statuses, x.status || 'active', '—')}</select><div class="err" id="pf-status-e"></div></div>
    </div>
    <div class="field"><label for="pf-addr">نشانی</label><input class="input" id="pf-addr" value="${esc(x.address || '')}"><div class="err" id="pf-addr-e"></div></div>
    <div class="field"><label for="pf-notes">یادداشت</label><textarea class="input" id="pf-notes" rows="2">${esc(x.notes || '')}</textarea><div class="err" id="pf-notes-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ذخیره</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('pf-start', x.employmentStart || '');
  $('#pfForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#pfForm'));
    const st = readDate('pf-start', 'تاریخ استخدام'); if (!st.ok) return;
    const body = { firstName: $('#pf-first').value.trim(), lastName: $('#pf-last').value.trim(), nationalId: normDigits($('#pf-nid').value), personnelCode: $('#pf-code').value.trim(),
      position: $('#pf-pos').value.trim(), unitId: Number($('#pf-unit').value) || null, directManagerId: Number($('#pf-mgr').value) || null, employerCompanyId: Number($('#pf-emp').value) || null,
      mobile: normDigits($('#pf-mob').value), phone: $('#pf-tel').value.trim(), employmentStart: st.iso || '', status: $('#pf-status').value, address: $('#pf-addr').value.trim(), notes: $('#pf-notes').value.trim() };
    run(async () => {
      try { if (p) await api('PUT', `/api/personnel/${p.id}`, body); else await api('POST', '/api/personnel', body); }
      catch (err) { applyServerErrors(err, { firstName: 'pf-first', lastName: 'pf-last', nationalId: 'pf-nid', personnelCode: 'pf-code', position: 'pf-pos', unitId: 'pf-unit', directManagerId: 'pf-mgr', employerCompanyId: 'pf-emp', mobile: 'pf-mob', phone: 'pf-tel', employmentStart: 'pf-start', status: 'pf-status', address: 'pf-addr', notes: 'pf-notes' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('پرونده ذخیره شد'); await RENDER.personnel();
    }).catch(() => {});
  };
}
async function openPersonDetail(id) {
  const d = await api('GET', `/api/personnel/${id}`);
  const docs = d.documents.map((x) => `<tr><td>${esc(x.title)}</td><td>${esc(x.docType)}</td><td>${esc(x.fileName)}</td><td>${fmtTs(x.createdAt)}</td>
    <td><a class="btn ghost sm" href="/api/personnel/${id}/documents/${x.id}/download" download>دریافت</a> ${d.canDeleteDoc ? `<button class="btn danger sm" data-act="del-person-doc" data-id="${x.id}" data-v="${id}">حذف</button>` : ''}</td></tr>`).join('') || emptyRow(5);
  openModal(`<h3>${esc(d.firstName)} ${esc(d.lastName)}</h3>
    <ul class="rl">
      <li>کد ملی: <span dir="ltr">${esc(d.nationalId)}</span> — شماره پرسنلی: ${esc(d.personnelCode || '—')}</li>
      <li>وضعیت: <span class="pill">${esc(d.statusLabel)}</span></li>
      <li>واحد: ${esc(d.unitName || '—')} — سمت: ${esc(d.position || '—')}</li>
      <li>مدیر مستقیم: ${esc(d.directManagerName || '—')} — کارفرما: ${esc(d.employerName || '—')}</li>
      <li>موبایل: ${esc(d.mobile || '—')} — تلفن: ${esc(d.phone || '—')}</li>
      <li>تاریخ استخدام: ${d.employmentStart ? fmtJ(d.employmentStart) : '—'}</li>
      <li>نشانی: ${esc(d.address || '—')}</li>
      <li>یادداشت: ${esc(d.notes || '—')}</li>
    </ul>
    <div class="sec">مدارک</div>
    <div class="tw"><table><thead><tr><th>عنوان</th><th>نوع</th><th>فایل</th><th>تاریخ</th><th></th></tr></thead><tbody>${docs}</tbody></table></div>
    ${d.canUpload ? `<form id="pdForm" novalidate style="margin-top:12px">
      <div class="row2">
        <div class="field"><label for="pd-title">عنوان مدرک</label><input class="input" id="pd-title"><div class="err" id="pd-title-e"></div></div>
        <div class="field"><label for="pd-type">نوع مدرک</label><select class="input" id="pd-type">${opt(d.docTypes.map((t) => [t, t]), '', 'انتخاب نوع')}</select><div class="err" id="pd-type-e"></div></div>
      </div>
      <div class="field"><label for="pd-file">فایل (PDF، JPG یا PNG)</label><input class="input" id="pd-file" type="file" accept=".pdf,.jpg,.jpeg,.png"><div class="err" id="pd-file-e"></div></div>
      <div class="acts"><button class="btn" type="submit">بارگذاری مدرک</button></div></form>` : ''}
    <div class="acts">${d.canEdit ? `<button class="btn" type="button" data-act="edit-person" data-id="${id}">ویرایش پرونده</button>` : ''}<button class="btn ghost" type="button" data-act="close">بستن</button></div>`);
  if (d.canUpload) $('#pdForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#pdForm'));
    const fd = new FormData(); fd.append('title', $('#pd-title').value.trim()); fd.append('docType', $('#pd-type').value);
    const f = $('#pd-file').files[0]; if (f) fd.append('file1', f);
    run(async () => {
      try { await api('POST', `/api/personnel/${id}/documents`, fd); }
      catch (err) { applyServerErrors(err, { title: 'pd-title', docType: 'pd-type', file: 'pd-file' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      toast('مدرک بارگذاری شد'); await openPersonDetail(id);
    }).catch(() => {});
  };
}


/* ================= Service requests (کاربرگی) ================= */
async function renderRequests() {
  const d = await api('GET', `/api/requests?q=${encodeURIComponent(normSearch($('#rqSearch').value))}&status=${encodeURIComponent($('#rqStatus').value)}`);
  if (!$('#rqStatus').dataset.ready) { $('#rqStatus').innerHTML = opt(Object.entries(d.statuses), '', 'همه وضعیت‌ها'); $('#rqStatus').dataset.ready = '1'; $('#rqStatus').onchange = () => renderRequests(); }
  $$('[data-act="add-request"]').forEach((x) => { x.style.display = d.canCreate ? '' : 'none'; });
  $('#rqBody').innerHTML = d.items.map((r) => `<tr><td dir="ltr">${esc(r.trackingNo)}</td><td>${esc(r.requester)}</td><td>${esc(r.origin)} ← ${esc(r.destination)}</td><td>${fmtJ(r.requestDate)}</td><td>${toFa(r.passengerCount)}</td>
    <td><span class="pill ${r.status === 'rejected' || r.status === 'cancelled' ? 'bad' : ''}">${esc(r.statusLabel)}</span></td><td><button class="btn ghost sm" data-act="view-request" data-id="${r.id}">جزئیات</button></td></tr>`).join('') || emptyRow(7);
}
function openRequestForm() {
  openModal(`<h3>ثبت درخواست کاربرگی</h3><form id="rqForm" novalidate>
    <div class="row2">
      <div class="field"><label for="rq-who">درخواست‌کننده</label><input class="input" id="rq-who"><div class="err" id="rq-who-e"></div></div>
      ${dateField('rq-date', 'تاریخ درخواست')}
      <div class="field"><label for="rq-from">مبدأ</label><input class="input" id="rq-from"><div class="err" id="rq-from-e"></div></div>
      <div class="field"><label for="rq-to">مقصد</label><input class="input" id="rq-to"><div class="err" id="rq-to-e"></div></div>
      <div class="field"><label for="rq-count">تعداد مسافر</label><input class="input" id="rq-count" inputmode="numeric"><div class="err" id="rq-count-e"></div></div>
    </div>
    <div class="field"><label for="rq-notes">توضیحات</label><textarea class="input" id="rq-notes" rows="2"></textarea><div class="err" id="rq-notes-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت درخواست</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('rq-date', '');
  $('#rqForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#rqForm'));
    const dt = readDate('rq-date', 'تاریخ درخواست'); if (!dt.ok) return;
    run(async () => {
      let res;
      try { res = await api('POST', '/api/requests', { requester: $('#rq-who').value.trim(), requestDate: dt.iso, origin: $('#rq-from').value.trim(), destination: $('#rq-to').value.trim(), passengerCount: Number(normDigits($('#rq-count').value)), notes: $('#rq-notes').value.trim() }); }
      catch (err) { applyServerErrors(err, { requester: 'rq-who', origin: 'rq-from', destination: 'rq-to', passengerCount: 'rq-count', notes: 'rq-notes', requestDate: 'rq-date' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast(`درخواست ثبت شد: ${res.trackingNo}`); await RENDER.requests();
    }).catch(() => {});
  };
}
async function openRequestDetail(id) {
  const r = await api('GET', `/api/requests/${id}`);
  const vehicles = (await api('GET', '/api/vehicle-overview')).items, drivers = (await api('GET', '/api/drivers')).items;
  const events = r.events.map((x) => `<tr><td>${fmtTs(x.at)}</td><td>${esc(x.action)}</td><td>${esc(x.actor)}</td><td>${esc(x.note || '—')}</td></tr>`).join('');
  const actions = r.nextActions.map((a) => a.action === 'assign' ? '' : `<button class="btn ${a.action === 'reject' || a.action === 'cancel' ? 'danger' : ''} sm" data-act="req-action" data-id="${r.id}" data-v="${a.action}">${a.label}</button>`).join(' ');
  openModal(`<h3>درخواست ${esc(r.trackingNo)}</h3>
    <ul class="rl"><li>درخواست‌کننده: ${esc(r.requester)} — واحد: ${esc(r.unitName || '—')}</li><li>مسیر: ${esc(r.origin)} ← ${esc(r.destination)}</li>
    <li>تاریخ: ${fmtJ(r.requestDate)} — مسافر: ${toFa(r.passengerCount)}</li><li>وضعیت: <span class="pill">${esc(r.statusLabel)}</span></li>
    <li>خودرو: ${esc(r.vehicleName || '—')} — راننده: ${esc(r.driverName || '—')}</li><li>توضیحات: ${esc(r.notes || '—')}</li></ul>
    ${r.nextActions.some((a) => a.action === 'assign') ? `<div class="sec">تخصیص خودرو و راننده</div>
      <div class="row2"><div class="field"><label for="rqa-veh">خودرو</label><select class="input" id="rqa-veh">${opt(vehicles.map((v) => [v.id, `${plainPlate(v.plate)} (${v.brand} ${v.model})`]), '', 'انتخاب خودرو')}</select><div class="err" id="rqa-veh-e"></div></div>
      <div class="field"><label for="rqa-drv">راننده</label><select class="input" id="rqa-drv">${opt(drivers.map((d) => [d.id, `${d.first} ${d.last}`]), '', 'انتخاب راننده')}</select><div class="err" id="rqa-drv-e"></div></div></div>
      <div class="acts"><button class="btn" data-act="req-assign" data-id="${r.id}">تخصیص</button></div>` : ''}
    <div class="acts">${actions}</div>
    <div class="sec">تاریخچه</div>
    <div class="tw"><table><thead><tr><th>زمان</th><th>اقدام</th><th>کاربر</th><th>توضیح</th></tr></thead><tbody>${events}</tbody></table></div>
    <div class="acts"><button class="btn ghost" data-act="close">بستن</button></div>`);
}
/* ================= Passengers ================= */
async function renderPassengers() {
  const d = await api('GET', `/api/passengers?q=${encodeURIComponent(normSearch($('#psSearch').value))}`);
  $$('[data-act="add-passenger-rec"]').forEach((x) => { x.style.display = d.canCreate ? '' : 'none'; });
  $('#psBody').innerHTML = d.items.map((p) => `<tr><td>${esc(p.firstName)} ${esc(p.lastName)}</td><td dir="ltr">${esc(p.nationalId || '—')}</td><td dir="ltr">${esc(p.mobile || '—')}</td><td><span class="pill ${p.active ? '' : 'bad'}">${p.active ? 'فعال' : 'غیرفعال'}</span></td>
    <td>${d.canEdit ? `<button class="btn ghost sm" data-act="edit-passenger-rec" data-id="${p.id}">ویرایش</button>` : ''}</td></tr>`).join('') || emptyRow(5);
  const trips = (await api('GET', '/api/trips')).items;
  const sel = $('#tpTrip'), cur = sel.value;
  if (!sel.dataset.n || sel.dataset.n !== String(trips.length)) { sel.innerHTML = opt(trips.map((t) => [t.id, `${t.planName} — ${fmtJ(t.tripDate)} (${t.statusLabel})`]), cur, 'انتخاب سفر'); sel.dataset.n = String(trips.length); }
  sel.onchange = () => renderPassengers();
  if (!sel.value) { $('#tpBody').innerHTML = emptyRow(5); return; }
  const tp = await api('GET', `/api/trips/${sel.value}/passengers`);
  $('#tpBody').innerHTML = tp.items.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.boarding || '—')}</td><td>${esc(x.alighting || '—')}</td>
    <td>${tp.canEdit ? Object.entries(tp.statuses).map(([k, l]) => `<button class="btn ${x.status === k ? '' : 'ghost'} sm" data-act="tp-status" data-id="${x.id}" data-v="${k}">${l}</button>`).join(' ') : esc(x.statusLabel)}</td>
    <td>${tp.canEdit ? `<button class="btn danger sm" data-act="tp-del" data-id="${x.id}">حذف از سفر</button>` : ''}</td></tr>`).join('') || emptyRow(5);
}
function openPassengerRec(p = null) {
  const x = p || {};
  openModal(`<h3>${p ? 'ویرایش مسافر' : 'مسافر جدید'}</h3><form id="psForm" novalidate>
    <div class="row2">
      <div class="field"><label for="ps-first">نام</label><input class="input" id="ps-first" value="${esc(x.firstName || '')}"><div class="err" id="ps-first-e"></div></div>
      <div class="field"><label for="ps-last">نام خانوادگی</label><input class="input" id="ps-last" value="${esc(x.lastName || '')}"><div class="err" id="ps-last-e"></div></div>
      <div class="field"><label for="ps-nid">کد ملی (اختیاری)</label><input class="input" id="ps-nid" inputmode="numeric" value="${esc(x.nationalId || '')}"><div class="err" id="ps-nid-e"></div></div>
      <div class="field"><label for="ps-mob">موبایل (اختیاری)</label><input class="input" id="ps-mob" inputmode="tel" value="${esc(x.mobile || '')}"><div class="err" id="ps-mob-e"></div></div>
      <div class="field"><label for="ps-act">وضعیت</label><select class="input" id="ps-act">${opt([['1', 'فعال'], ['0', 'غیرفعال']], x.active === false ? '0' : '1', '')}</select></div>
    </div>
    <div class="acts"><button class="btn" type="submit">ذخیره</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#psForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#psForm'));
    const body = { firstName: $('#ps-first').value.trim(), lastName: $('#ps-last').value.trim(), nationalId: normDigits($('#ps-nid').value), mobile: normDigits($('#ps-mob').value), active: $('#ps-act').value === '1' };
    run(async () => {
      try { if (p) await api('PUT', `/api/passengers/${p.id}`, body); else await api('POST', '/api/passengers', body); }
      catch (err) { applyServerErrors(err, { firstName: 'ps-first', lastName: 'ps-last', nationalId: 'ps-nid', mobile: 'ps-mob' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('مسافر ذخیره شد'); await RENDER.passengers();
    }).catch(() => {});
  };
}
async function openTripPassenger() {
  const tripId = $('#tpTrip').value;
  if (!tripId) { toast('ابتدا سفر را انتخاب کنید'); return; }
  const list = (await api('GET', '/api/passengers')).items.filter((p) => p.active);
  openModal(`<h3>افزودن مسافر به سفر</h3><form id="tpForm" novalidate>
    <div class="field"><label for="tp-pax">مسافر</label><select class="input" id="tp-pax">${opt(list.map((p) => [p.id, `${p.firstName} ${p.lastName}`]), '', 'انتخاب مسافر')}</select><div class="err" id="tp-pax-e"></div></div>
    <div class="row2"><div class="field"><label for="tp-b">ایستگاه سوار شدن</label><input class="input" id="tp-b"><div class="err" id="tp-b-e"></div></div>
    <div class="field"><label for="tp-a">ایستگاه پیاده شدن</label><input class="input" id="tp-a"><div class="err" id="tp-a-e"></div></div></div>
    <div class="acts"><button class="btn" type="submit">افزودن</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#tpForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#tpForm'));
    run(async () => {
      try { await api('POST', `/api/trips/${tripId}/passengers`, { passengerId: Number($('#tp-pax').value) || null, boarding: $('#tp-b').value.trim(), alighting: $('#tp-a').value.trim() }); }
      catch (err) { applyServerErrors(err, { passengerId: 'tp-pax', boarding: 'tp-b', alighting: 'tp-a' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('مسافر به سفر افزوده شد'); await RENDER.passengers();
    }).catch(() => {});
  };
}
/* ================= Finance ================= */
async function renderFinance() {
  if (!$('#fnRange').dataset.ready) { $('#fnRange').innerHTML = dateField('fnFrom', 'از تاریخ') + dateField('fnTo', 'تا تاریخ'); $('#fnRange').dataset.ready = '1'; }
  const fr = readDate('fnFrom', 'از تاریخ', { optional: true }), tr = readDate('fnTo', 'تا تاریخ', { optional: true });
  const from = fr.iso || '', to = tr.iso || '';
  const kind = $('#fnKind').value, pay = $('#fnPay').value;
  if (!$('#fnKind').dataset.ready) { $('#fnKind').innerHTML = opt([['income', 'درآمد'], ['expense', 'هزینه']], '', 'همه انواع'); $('#fnPay').innerHTML = opt([['unpaid', 'پرداخت‌نشده'], ['paid', 'پرداخت‌شده']], '', 'همه وضعیت‌ها'); $('#fnKind').dataset.ready = '1'; $('#fnKind').onchange = $('#fnPay').onchange = () => renderFinance(); }
  const [s, f, cats] = await Promise.all([api('GET', `/api/finance/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), api('GET', `/api/finance?kind=${kind}&paymentStatus=${pay}`), api('GET', '/api/finance/categories')]);
  const money = (n) => `${toFa(n.toLocaleString('en-US'))} تومان`;
  $('#fnSummary').innerHTML = kpiCard('درآمد', 0).replace(toFa(0), money(s.income)) + kpiCard('هزینه', 0).replace(toFa(0), money(s.expense))
    + kpiCard('مانده', 0).replace(toFa(0), money(s.balance)) + kpiCard('پرداخت‌نشده (درآمد)', 0).replace(toFa(0), money(s.unpaidIncome));
  $('#fnBody').innerHTML = f.items.map((x) => `<tr><td dir="ltr">${esc(x.referenceNo)}</td><td>${esc(x.kindLabel)}</td><td>${esc(x.categoryName)}</td><td>${toFa(x.amount.toLocaleString('en-US'))}</td><td>${fmtJ(x.entryDate)}</td>
    <td><span class="pill ${x.paymentStatus === 'paid' ? '' : 'bad'}">${x.paymentStatus === 'paid' ? 'پرداخت‌شده' : 'پرداخت‌نشده'}</span></td>
    <td>${x.paymentStatus !== 'paid' && f.canEdit ? `<button class="btn sm" data-act="fin-pay" data-id="${x.id}">ثبت پرداخت</button>` : ''}</td></tr>`).join('') || emptyRow(7);
  $$('[data-act="add-fin"]').forEach((x) => { x.style.display = f.canCreate ? '' : 'none'; });
  $('#fcBody').innerHTML = cats.items.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.kind === 'income' ? 'درآمد' : 'هزینه'}</td><td><span class="pill ${c.active ? '' : 'bad'}">${c.active ? 'فعال' : 'غیرفعال'}</span></td>
    <td>${cats.canEdit ? `<button class="btn ghost sm" data-act="fin-cat-toggle" data-id="${c.id}" data-v="${c.active ? '0' : '1'}">${c.active ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button>` : ''}</td></tr>`).join('') || emptyRow(4);
}
async function openFinanceEntry() {
  const cats = (await api('GET', '/api/finance/categories')).items.filter((c) => c.active);
  const [companies, vehicles, plans] = await Promise.all([api('GET', '/api/companies'), api('GET', '/api/vehicle-overview'), api('GET', '/api/service-plans')]);
  openModal(`<h3>ثبت سند مالی</h3><form id="fnForm" novalidate>
    <div class="row2">
      <div class="field"><label for="fn-kind">نوع</label><select class="input" id="fn-kind">${opt([['income', 'درآمد'], ['expense', 'هزینه']], 'expense', '')}</select></div>
      <div class="field"><label for="fn-cat">دسته</label><select class="input" id="fn-cat"></select><div class="err" id="fn-cat-e"></div></div>
      <div class="field"><label for="fn-amt">مبلغ (تومان)</label><input class="input" id="fn-amt" inputmode="numeric"><div class="err" id="fn-amt-e"></div></div>
      ${dateField('fn-date', 'تاریخ سند')}
      <div class="field"><label for="fn-co">شرکت</label><select class="input" id="fn-co">${opt(companies.items.map((c) => [c.id, c.name]), '', 'بدون شرکت')}</select></div>
      <div class="field"><label for="fn-veh">خودرو</label><select class="input" id="fn-veh">${opt(vehicles.items.map((v) => [v.id, `${plainPlate(v.plate)} (${v.brand} ${v.model})`]), '', 'بدون خودرو')}</select></div>
      <div class="field"><label for="fn-plan">سرویس</label><select class="input" id="fn-plan">${opt(plans.items.map((p) => [p.id, `${p.code} — ${p.name}`]), '', 'بدون سرویس')}</select></div>
    </div>
    <div class="field"><label for="fn-desc">توضیحات</label><textarea class="input" id="fn-desc" rows="2"></textarea><div class="err" id="fn-desc-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت سند</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('fn-date', '');
  const fillCats = () => { const k = $('#fn-kind').value; $('#fn-cat').innerHTML = opt(cats.filter((c) => c.kind === k).map((c) => [c.id, c.name]), '', 'انتخاب دسته'); };
  fillCats(); $('#fn-kind').onchange = fillCats;
  $('#fnForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#fnForm'));
    const dt = readDate('fn-date', 'تاریخ سند'); if (!dt.ok) return;
    run(async () => {
      let res;
      try { res = await api('POST', '/api/finance', { kind: $('#fn-kind').value, categoryId: Number($('#fn-cat').value) || null, amount: Number(normDigits($('#fn-amt').value)), entryDate: dt.iso, companyId: Number($('#fn-co').value) || null, vehicleId: Number($('#fn-veh').value) || null, servicePlanId: Number($('#fn-plan').value) || null, description: $('#fn-desc').value.trim() }); }
      catch (err) { applyServerErrors(err, { kind: 'fn-kind', categoryId: 'fn-cat', amount: 'fn-amt', entryDate: 'fn-date', description: 'fn-desc' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast(`سند ثبت شد: ${res.referenceNo}`); await RENDER.finance();
    }).catch(() => {});
  };
}
function openPayment(id) {
  openModal(`<h3>ثبت پرداخت و تسویه</h3><form id="payForm" novalidate>
    ${dateField('pay-date', 'تاریخ پرداخت')}
    <div class="field"><label for="pay-method">روش پرداخت</label><input class="input" id="pay-method" placeholder="مثلاً نقدی، کارت به کارت، چک"><div class="err" id="pay-method-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت پرداخت</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('pay-date', '');
  $('#payForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#payForm'));
    const dt = readDate('pay-date', 'تاریخ پرداخت'); if (!dt.ok) return;
    run(async () => {
      try { await api('POST', `/api/finance/${id}/pay`, { paidAt: dt.iso, method: $('#pay-method').value.trim() }); }
      catch (err) { applyServerErrors(err, { paidAt: 'pay-date', method: 'pay-method' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('پرداخت ثبت شد'); await RENDER.finance();
    }).catch(() => {});
  };
}


/* ================= Leave and missions ================= */
async function renderLeave() {
  const st = await api('GET', '/api/leave/settings').catch(() => null);
  if (st) {
    $('#lvSetNote').textContent = st.initialNote + (st.warnings.length ? ' — ' + st.warnings.join(' ') : '');
    $('#lvSettings').innerHTML = st.canEdit ? `
      <div class="row2"><div class="field"><label for="lvAnnual">سهمیه سالانه مرخصی (روز)</label><input class="input" id="lvAnnual" inputmode="numeric" value="${st.annualDays === null ? '' : esc(String(st.annualDays))}"><div class="err" id="lvAnnual-e"></div></div></div>
      <div class="field"><label for="lvSteps">زنجیره تأیید (هر خط: عنوان | نقش)</label><textarea class="input" id="lvSteps" rows="4">${esc(st.steps.map((x) => `${x.label} | ${x.role}`).join('\n'))}</textarea><div class="err" id="lvSteps-e"></div></div>
      <div class="acts"><button class="btn" data-act="lv-save-settings">ذخیره تنظیمات</button></div>` : `<ul class="rl"><li>سهمیه سالانه: ${st.annualDays === null ? 'تنظیم نشده' : toFa(st.annualDays) + ' روز'}</li>${st.steps.map((x) => `<li>${esc(x.label)} — نقش: ${esc(x.role)}</li>`).join('')}</ul>`;
  }
  const status = $('#lvStatus');
  const d = await api('GET', `/api/leave/requests?status=${encodeURIComponent(status.value)}`);
  if (!status.dataset.ready) { status.innerHTML = opt(Object.entries(d.statuses), '', 'همه وضعیت‌ها'); status.dataset.ready = '1'; status.onchange = () => renderLeave(); }
  $('#lvOwn').style.display = d.ownOnly ? '' : 'none';
  $('#lvBody').innerHTML = d.items.map((r) => `<tr><td>${esc(r.personnelName)}</td><td>${esc(r.kind)}</td><td>${fmtJ(r.startDate)}</td><td>${fmtJ(r.endDate)}</td><td>${toFa(r.days)}</td>
    <td><span class="pill ${r.status === 'rejected' ? 'bad' : ''}">${esc(r.statusLabel)}</span></td><td><button class="btn ghost sm" data-act="view-leave" data-id="${r.id}">جزئیات</button></td></tr>`).join('') || emptyRow(7);
}
async function saveLeaveSettings() {
  clearErrs($('#lvSettings'));
  const annualRaw = normDigits($('#lvAnnual').value).trim();
  const steps = $('#lvSteps').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [label, role] = l.split('|').map((x) => (x || '').trim()); return { label, role }; });
  run(async () => {
    try { await api('PUT', '/api/leave/settings', { annualDays: annualRaw === '' ? null : Number(annualRaw), steps }); }
    catch (err) { applyServerErrors(err, { annualDays: 'lvAnnual', steps: 'lvSteps' }); throw Object.assign(new Error('handled'), { status: -1 }); }
    toast('تنظیمات ذخیره شد'); await renderLeave();
  }).catch(() => {});
}
async function openLeaveForm() {
  const people = (await api('GET', '/api/personnel')).items;
  openModal(`<h3>درخواست مرخصی یا مأموریت</h3><form id="lvForm" novalidate>
    <div class="field"><label for="lv-p">پرسنل</label><select class="input" id="lv-p">${opt(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`]), '', 'انتخاب پرسنل')}</select><div class="err" id="lv-personnelId-e"></div></div>
    <div class="row2"><div class="field"><label for="lv-k">نوع</label><select class="input" id="lv-k">${opt([['مرخصی', 'مرخصی'], ['مأموریت', 'مأموریت']], 'مرخصی', '')}</select><div class="err" id="lv-kind-e"></div></div>
    <div class="field"><label for="lv-dest">مقصد (برای مأموریت)</label><input class="input" id="lv-dest"><div class="err" id="lv-destination-e"></div></div></div>
    <div class="row2">${dateField('lv-start', 'از تاریخ')}${dateField('lv-end', 'تا تاریخ')}</div>
    <div class="field"><label for="lv-reason">توضیحات</label><textarea class="input" id="lv-reason" rows="2"></textarea><div class="err" id="lv-reason-e"></div></div>
    <div class="field"><label for="lv-files">پیوست (گواهی یا نامه، حداکثر ۵ فایل PDF، JPG یا PNG)</label><input class="input" id="lv-files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png"><div class="err" id="lv-file-e"></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت درخواست</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  setDate('lv-start', ''); setDate('lv-end', '');
  $('#lvForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#lvForm'));
    const s = readDate('lv-start', 'از تاریخ'), t = readDate('lv-end', 'تا تاریخ'); if (!s.ok || !t.ok) return;
    const fd = new FormData();
    fd.append('personnelId', $('#lv-p').value); fd.append('kind', $('#lv-k').value); fd.append('startDate', s.iso); fd.append('endDate', t.iso);
    fd.append('destination', $('#lv-dest').value.trim()); fd.append('reason', $('#lv-reason').value.trim());
    [...($('#lv-files').files || [])].forEach((f, i) => fd.append('file' + (i + 1), f));
    run(async () => {
      try { await api('POST', '/api/leave/requests', fd); }
      catch (err) { applyServerErrors(err, { personnelId: 'lv-p', kind: 'lv-k', startDate: 'lv-start', endDate: 'lv-end', destination: 'lv-dest', reason: 'lv-reason', file: 'lv-files' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('درخواست ثبت شد'); await renderLeave();
    }).catch(() => {});
  };
}
async function openLeaveDetail(id) {
  const r = await api('GET', `/api/leave/requests/${id}`);
  const steps = r.steps.map((s) => `<li${s.position === r.currentStep && r.status === 'pending' ? ' style="font-weight:700"' : ''}>${s.position}. ${esc(s.label)} (نقش: ${esc(s.role)})</li>`).join('');
  const events = r.events.map((x) => `<tr><td>${fmtTs(x.at)}</td><td>${esc(x.action)}</td><td>${esc(x.actor)}</td><td>${esc(x.note || '—')}</td></tr>`).join('');
  const files = r.attachments.map((a) => `<li><a href="/api/leave/requests/${r.id}/attachments/${a.id}/download" download>${esc(a.fileName)}</a></li>`).join('') || '<li>پیوستی ثبت نشده است.</li>';
  openModal(`<h3>${esc(r.kind)} — ${esc(r.personnelName)}</h3>
    <ul class="rl"><li>وضعیت: <span class="pill">${esc(r.statusLabel)}</span></li><li>از ${fmtJ(r.startDate)} تا ${fmtJ(r.endDate)} (${toFa(r.days)} روز)</li>
    ${r.destination ? `<li>مقصد: ${esc(r.destination)}</li>` : ''}<li>توضیحات: ${esc(r.reason || '—')}</li><li>مرحله فعلی: ${esc(r.currentStepLabel || '—')}</li></ul>
    <div class="sec">زنجیره تأیید</div><ol>${steps}</ol>
    <div class="sec">پیوست‌ها</div><ul>${files}</ul>
    ${r.canAct ? `<div class="field"><label for="lv-note">توضیح (برای رد یا بازگشت الزامی است)</label><input class="input" id="lv-note"><div class="err" id="lv-note-e"></div></div>
      <div class="acts"><button class="btn" data-act="lv-action" data-id="${r.id}" data-v="approve">تأیید</button><button class="btn danger" data-act="lv-action" data-id="${r.id}" data-v="reject">رد</button><button class="btn ghost" data-act="lv-action" data-id="${r.id}" data-v="return">بازگشت برای اصلاح</button></div>` : ''}
    ${r.canResubmit ? `<div class="acts"><button class="btn" data-act="lv-resubmit" data-id="${r.id}">ارسال مجدد پس از اصلاح</button></div>` : ''}
    <div class="sec">تاریخچه</div><div class="tw"><table><thead><tr><th>زمان</th><th>اقدام</th><th>کاربر</th><th>توضیح</th></tr></thead><tbody>${events}</tbody></table></div>
    <div class="acts"><button class="btn ghost" data-act="close">بستن</button></div>`);
}


/* ================= Shared refresh (manual and every 120 seconds) ================= */
let LAST_REFRESH = null, REFRESH_BUSY = false, AUTO_TIMER = null;
const REFRESH_EVERY = 120000;
function refreshable(page) { return !!RENDER[page] && page !== 'dashboard'; }
function formIsBusy() {
  const m = document.getElementById('modal');
  if (m && !m.classList.contains('hidden') && m.offsetParent !== null) return true;
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && !!a.closest('section') && a.value !== '';
}
function setRefreshStamp(err) {
  const s = document.getElementById('refreshStamp'); if (!s) return;
  s.textContent = err ? 'خطا در بازخوانی: ' + err : (LAST_REFRESH ? 'آخرین بازخوانی: ' + LAST_REFRESH.toLocaleTimeString('fa-IR') : '');
  s.style.color = err ? 'var(--bad, #dc2626)' : '';
}
// One shared routine: fetch the current section's data again without reloading the page; keeps filters and search values.
async function refreshCurrent(manual) {
  if (REFRESH_BUSY) return;
  if (!manual && formIsBusy()) return;
  if (!refreshable(CUR)) return;
  REFRESH_BUSY = true;
  try { await RENDER[CUR](); LAST_REFRESH = new Date(); setRefreshStamp(null); }
  catch (err) { setRefreshStamp(err && err.message ? err.message : 'اتصال برقرار نشد'); }
  finally { REFRESH_BUSY = false; }
}
function mountRefreshControls() {
  const top = document.querySelector('header.top');
  if (!top || document.getElementById('refreshBtn')) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-inline-start:auto';
  wrap.innerHTML = '<button class="btn ghost sm" id="refreshBtn" type="button">بازخوانی</button><span id="refreshStamp" class="note" style="margin:0"></span>';
  top.appendChild(wrap);
  document.getElementById('refreshBtn').onclick = () => refreshCurrent(true);
  if (!AUTO_TIMER) AUTO_TIMER = setInterval(() => refreshCurrent(false), REFRESH_EVERY);
}

/* ================= Event delegation ================= */
document.addEventListener('click', (e) => {
  if (!e.target.closest('#dp') && !e.target.closest('[data-dp]')) closeDP();
  const dpb = e.target.closest('[data-dp]');
  if (dpb) { const id = dpb.dataset.dp; if (DP_TARGET === id) closeDP(); else openDP(id); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.closest('#dp')) return;
  const a = b.dataset.act, id = Number(b.dataset.id);
  const act = (fn) => run(fn);
  switch (a) {
    case 'close': closeModal(); break;
    case 'range': DASH.preset = b.dataset.v; $('#dashCustom').classList.toggle('hidden', DASH.preset !== 'custom'); $$('#dashRanges [data-act="range"]').forEach((x) => x.classList.toggle('on', x === b)); act(renderDashboard); break;
    case 'add-company': case 'qa-company': openCompany(); break;
    case 'edit-companies': act(async () => openCompany((await api('GET', '/api/companies')).items.find((x) => x.id === id) || null)); break;
    case 'del-companies': confirmBox('حذف شرکت', 'این شرکت حذف شود؟', async () => { await api('DELETE', `/api/companies/${id}`); toast('شرکت حذف شد'); await RENDER.companies(); }); break;
    case 'add-driver': case 'qa-driver': openDriver(); break;
    case 'edit-drivers': act(async () => openDriver((await api('GET', '/api/drivers')).items.find((x) => x.id === id) || null)); break;
    case 'del-drivers': confirmBox('حذف راننده', 'این راننده حذف شود؟', async () => { await api('DELETE', `/api/drivers/${id}`); toast('راننده حذف شد'); await RENDER.drivers(); }); break;
    case 'add-vehicle': case 'qa-vehicle': openVehicle(); break;
    case 'edit-vehicles': act(async () => openVehicle((await api('GET', '/api/vehicles')).items.find((x) => x.id === id) || null)); break;
    case 'del-vehicles': confirmBox('حذف خودرو', 'این خودرو حذف شود؟', async () => { await api('DELETE', `/api/vehicles/${id}`); toast('خودرو حذف شد'); await RENDER.vehicles(); }); break;
    case 'add-contract': case 'qa-contract': act(() => { if (CUR !== 'contracts') go('contracts'); return openContract({}); }); break;
    case 'edit-contracts': act(() => openContract({ id })); break;
    case 'del-contracts': confirmBox('حذف قرارداد', 'این قرارداد حذف شود؟', async () => { await api('DELETE', `/api/contracts/${id}`); toast('قرارداد حذف شد'); await RENDER.contracts(); }); break;
    case 'add-document': act(() => openDocumentForm('driver')); break;
    case 'add-vdoc': act(() => openDocumentForm('vehicle')); break;
    case 'doc-detail': act(() => openDocumentDetail(id)); break;
    case 'doc-approve': case 'doc-reject': act(async () => { await api('POST', `/api/documents/${id}/review`, { decision: a === 'doc-approve' ? 'approved' : 'rejected' }); toast('وضعیت مدرک ثبت شد'); closeModal(); await RENDER[CUR === 'vehicledocs' ? 'vehicledocs' : 'documents'](); }); break;
    case 'doc-edit': act(async () => { const d = await api('GET', `/api/documents/${id}`); closeModal(); openDocumentForm(d.ownerType, d); }); break;
    case 'doc-del': confirmBox('حذف مدرک', 'مدرک و فایل آن حذف شوند؟', async () => { const d = await api('GET', `/api/documents/${id}`); await api('DELETE', `/api/documents/${id}`); toast('مدرک حذف شد'); await RENDER[d.ownerType === 'driver' ? 'documents' : 'vehicledocs'](); }); break;
    case 'dpage': DOC_PAGE[b.dataset.type] = Math.max(1, Number(b.dataset.v)); act(() => renderDocPage(b.dataset.type)); break;
    case 'add-doctype': openDoctype(); break;
    case 'edit-doctype': act(async () => openDoctype((await api('GET', '/api/doctypes')).items.find((x) => x.id === id))); break;
    case 'add-user': act(openUser); break;
    case 'add-letter': openLetterForm(); break;
    case 'add-absence': act(openAbsence); break;
    case 'view-task': act(() => openTaskDetail(id)); break;
    case 'task-progress': act(async () => { const note = document.getElementById('tp-note').value.trim(); try { await api('POST', `/api/tasks/${id}/progress`, { note }); } catch (err) { applyServerErrors(err, { note: 'tp-note' }); throw Object.assign(new Error('handled'), { status: -1 }); } toast('گزارش پیشرفت ثبت شد'); await openTaskDetail(id); await RENDER.tasks(); }); break;
    case 'task-attach': act(async () => { const f = document.getElementById('tk-file').files[0]; const fd = new FormData(); if (f) fd.append('file1', f); try { await api('POST', `/api/tasks/${id}/attachments`, fd); } catch (err) { applyServerErrors(err, { file: 'tk-file' }); throw Object.assign(new Error('handled'), { status: -1 }); } toast('پیوست بارگذاری شد'); await openTaskDetail(id); }); break;
    case 'ann-read': act(async () => { await api('POST', `/api/announcements/${id}/read`); toast('مشاهده ثبت شد'); await RENDER.announcements(); }); break;
    case 'ann-readers': act(() => openReaders(id)); break;
    case 'add-request': act(openRequestForm); break;
    case 'add-leave': act(openLeaveForm); break;
    case 'view-leave': act(() => openLeaveDetail(id)); break;
    case 'lv-save-settings': act(saveLeaveSettings); break;
    case 'lv-action': act(async () => { const note = (document.getElementById('lv-note') || { value: '' }).value.trim();
      try { await api('POST', `/api/leave/requests/${id}/action`, { action: b.dataset.v, note }); } catch (err) { applyServerErrors(err, { note: 'lv-note' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      toast('ثبت شد'); await openLeaveDetail(id); await renderLeave(); }); break;
    case 'lv-resubmit': act(async () => { await api('POST', `/api/leave/requests/${id}/resubmit`, {}); toast('دوباره ارسال شد'); await openLeaveDetail(id); await renderLeave(); }); break;
    case 'view-request': act(() => openRequestDetail(id)); break;
    case 'req-action': act(async () => { await api('PUT', `/api/requests/${id}/status`, { action: b.dataset.v }); toast('وضعیت درخواست به‌روز شد'); await openRequestDetail(id); await RENDER.requests(); }); break;
    case 'req-assign': act(async () => { const v = Number(document.querySelector('#rqa-veh').value), d = Number(document.querySelector('#rqa-drv').value); try { await api('PUT', `/api/requests/${id}/status`, { action: 'assign', vehicleId: v || null, driverId: d || null }); } catch (err) { applyServerErrors(err, { vehicleId: 'rqa-veh', driverId: 'rqa-drv' }); throw Object.assign(new Error('handled'), { status: -1 }); } toast('خودرو و راننده تخصیص یافت'); await openRequestDetail(id); await RENDER.requests(); }); break;
    case 'add-passenger-rec': act(() => openPassengerRec()); break;
    case 'edit-passenger-rec': act(async () => { const d = await api('GET', '/api/passengers'); openPassengerRec(d.items.find((x) => x.id === id)); }); break;
    case 'add-trip-passenger': act(openTripPassenger); break;
    case 'tp-status': act(async () => { await api('PUT', `/api/trip-passengers/${id}`, { status: b.dataset.v }); toast('وضعیت حضور ثبت شد'); await RENDER.passengers(); }); break;
    case 'tp-del': confirmBox('حذف از سفر', 'این مسافر از سفر حذف شود؟', async () => { await api('DELETE', `/api/trip-passengers/${id}`); toast('حذف شد'); await RENDER.passengers(); }); break;
    case 'add-fin': act(openFinanceEntry); break;
    case 'fin-pay': act(() => openPayment(id)); break;
    case 'fin-refresh': act(renderFinance); break;
    case 'fin-cat-toggle': act(async () => { await api('PUT', `/api/finance/categories/${id}`, { active: b.dataset.v === '1' }); toast('دسته به‌روز شد'); await RENDER.finance(); }); break;
    case 'add-fin-cat': act(() => openFinCat()); break;
    case 'add-person': act(() => openPersonForm()); break;
    case 'view-person': act(() => openPersonDetail(id)); break;
    case 'edit-person': act(async () => { const d = await api('GET', `/api/personnel/${id}`); openPersonForm(d); }); break;
    case 'del-person-doc': confirmBox('حذف مدرک', 'این مدرک و فایل آن حذف شود؟', async () => { await api('DELETE', `/api/personnel/${b.dataset.v}/documents/${id}`); toast('مدرک حذف شد'); await openPersonDetail(Number(b.dataset.v)); }); break;
    case 'pick-vehicle-shift': act(() => pickVehicle(async (vid) => { await openShiftForm(vid); })); break;
    case 'pick-vehicle-service': openServiceTypeChoice(); break;
    case 'rm-apply': act(() => applyRouteMap(Number(b.dataset.v))); break;
    case 'svc-type': closeModal(); act(() => openServicePlanWizard(null, b.dataset.v)); break;
    case 'add-trip': act(openTripForm); break;
    case 'approve-trip': confirmBox('تایید سفر', 'این سفر تایید شود؟', async () => { await api('PUT', `/api/trips/${id}/status`, { status: 'approved' }); toast('سفر تایید شد'); await RENDER.tripapproval(); }); break;
    case 'reject-trip': confirmBox('رد سفر', 'این سفر رد شود؟', async () => { await api('PUT', `/api/trips/${id}/status`, { status: 'rejected' }); toast('سفر رد شد'); await RENDER.tripapproval(); }); break;
    case 'send-location': act(sendLocation); break;
    case 'start-trip': act(() => openStartTrip(id)); break;
    case 'finish-trip': confirmBox('پایان سفر', 'با پایان سفر، ردیابی راننده متوقف می‌شود. ادامه دهیم؟', async () => { await api('PUT', `/api/trips/${id}/finish`); toast('سفر پایان یافت'); await RENDER.trips(); }); break;
    case 'refresh-monitor': act(renderMonitor); break;
    case 'show-all-vehicles': showAllVehicles(); break;
    case 'driver-link': act(createDriverLink); break;
    case 'add-site': act(() => openSiteForm()); break;
    case 'edit-site': act(async () => { const { items } = await api('GET', '/api/sites'); openSiteForm(items.find((x) => x.id === id)); }); break;
    case 'add-unit': act(() => openUnitForm()); break;
    case 'edit-unit': act(async () => { const { items } = await api('GET', '/api/supervision-units'); openUnitForm(items.find((x) => x.id === id)); }); break;
    case 'del-vshift': confirmBox('حذف شیفت', 'این شیفت حذف شود؟', async () => { const r = await api('GET', '/api/vehicle-shifts'); const row = r.items.find((x) => x.id === id); await api('DELETE', `/api/vehicles/${row.vehicleId}/shifts/${id}`); toast('حذف شد'); await RENDER.vshifts(); }); break;
    case 'del-vservice': confirmBox('حذف سرویس', 'این سرویس حذف شود؟', async () => { const r = await api('GET', '/api/vehicle-services'); const row = r.items.find((x) => x.id === id); await api('DELETE', `/api/vehicles/${row.vehicleId}/services/${id}`); toast('حذف شد'); await RENDER.vservices(); }); break;
    case 'save-session-timeout': act(saveSessionTimeout); break;
    case 'add-announcement': openAnnouncement(); break;
    case 'del-announcement': confirmBox('حذف اعلان', 'این اعلان حذف شود؟', async () => { await api('DELETE', `/api/announcements/${id}`); toast('حذف شد'); await RENDER.announcements(); }); break;
    case 'add-task': act(openTask); break;
    case 'task-status': act(async () => { await api('PUT', `/api/tasks/${id}/status`, { status: b.dataset.v }); toast('وضعیت به‌روز شد'); await RENDER.tasks(); }); break;
    case 'del-task': confirmBox('حذف وظیفه', 'این وظیفه حذف شود؟', async () => { await api('DELETE', `/api/tasks/${id}`); toast('حذف شد'); await RENDER.tasks(); }); break;
    case 'add-meeting': act(openMeeting); break;
    case 'del-meeting': confirmBox('حذف جلسه', 'این جلسه حذف شود؟', async () => { await api('DELETE', `/api/meetings/${id}`); toast('حذف شد'); await RENDER.meetings(); }); break;
    case 'add-doc': act(openArchiveForm); break;
    case 'del-doc': confirmBox('حذف سند', 'سند و فایل آن حذف شوند؟', async () => { await api('DELETE', `/api/archive/${id}`); toast('سند حذف شد'); await RENDER.archive(); }); break;
    case 'add-service': act(() => openServiceForm(Number(b.dataset.id))); break;
    case 'edit-plan': act(async () => { const { items } = await api('GET', '/api/service-plans'); const p = items.find((x) => x.id === id); if (p) openServicePlanWizard(p); }); break;
    case 'del-plan': confirmBox('حذف سرویس', 'این سرویس حذف شود؟', async () => { await api('DELETE', `/api/service-plans/${id}`); toast('سرویس حذف شد'); await RENDER.vservices(); }); break;
    case 'add-shift': act(() => openShiftForm(Number(b.dataset.id))); break;
    case 'del-service': confirmBox('حذف سرویس', 'این سرویس حذف شود؟', async () => { await api('DELETE', `/api/vehicles/${b.dataset.v}/services/${id}`); toast('سرویس حذف شد'); await RENDER.vservices(); }); break;
    case 'del-shift': confirmBox('حذف شیفت', 'این شیفت حذف شود؟', async () => { await api('DELETE', `/api/vehicles/${b.dataset.v}/shifts/${id}`); toast('شیفت حذف شد'); await RENDER.vshifts(); }); break;
    case 'del-absence': confirmBox('حذف ثبت', 'این ثبت حذف شود؟', async () => { await api('DELETE', `/api/absences/${id}`); toast('حذف شد'); await RENDER.absences(); }); break;
    case 'ltab': LTAB = b.dataset.v; act(renderLetters); break;
    case 'letter-detail': act(() => openLetterDetail(id)); break;
    case 'lact': act(() => letterAction(id, b.dataset.v)); break;
    case 'lreturn': letterReturn(id); break;
    case 'lfwd': act(() => openForward(id)); break;
    case 'add-dept': openDepartment(); break;
    case 'edit-user': act(async () => { await loadDepts(); const u = (await api('GET', '/api/users')).items.find((x) => x.id === id); openEditUser(u); }); break;
    case 'toggle-user': act(async () => { const u = (await api('GET', '/api/users')).items.find((x) => x.id === id); await api('PUT', `/api/users/${id}`, { active: !u.active }); toast('وضعیت کاربر به‌روز شد'); await RENDER.users(); }); break;
    case 'del-user': confirmBox('حذف کاربر', 'این کاربر حذف شود؟', async () => { await api('DELETE', `/api/users/${id}`); toast('کاربر حذف شد'); await RENDER.users(); }); break;
    case 'rtab': RS.tab = b.dataset.v; RS.page = 1; act(renderReports); break;
    case 'xp-download': reportExportDownload(); break;
    case 'rpage': RS.page = Number(b.dataset.v); act(renderReports); break;
    case 'detail': act(() => openDetail(id)); break;
    case 'csv': act(exportCsv); break;
    case 'selcsv': { const t = $('#csvOut'); t.focus(); t.select(); toast('متن انتخاب شد؛ کپی کنید'); break; }
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches && e.target.matches('[data-role-id]')) {
    run(async () => {
      await api('PUT', `/api/users/${e.target.dataset.roleId}`, { role: e.target.value });
      toast('نقش کاربر به‌روز شد');
      await RENDER.users();
    });
  }
  if (e.target.closest && e.target.closest('[data-view="reports"]')) { RS.page = 1; run(renderReports); }
});
document.addEventListener('input', (e) => {
  const map = { lfSender: RENDER.letters, lfRecipient: RENDER.letters, lfFrom: RENDER.letters, lfTo: RENDER.letters, psSearch: RENDER.passengers, rqSearch: RENDER.requests, pSearch: RENDER.personnel, pStatus: RENDER.personnel, vdSearch2: RENDER.vdriver, supSiteSearch: RENDER.vsup, supUnitSearch: RENDER.vsup, supUnitSite: RENDER.vsup, vshSearch: RENDER.vshifts, vsvSearch: RENDER.vservices, tSearch: RENDER.tasks, arSearch: RENDER.archive, arCat: RENDER.archive, aSearch: RENDER.absences, depSearch: RENDER.departments, lSearch: RENDER.letters, cSearch: RENDER.companies, dSearch: RENDER.drivers, vSearch: RENDER.vehicles, kSearch: RENDER.contracts, uSearch: RENDER.users,
    mSearch: () => { DOC_PAGE.driver = 1; return renderDocPage('driver'); }, vdSearch: () => { DOC_PAGE.vehicle = 1; return renderDocPage('vehicle'); },
    dfFrom: renderDashboard, dfTo: renderDashboard };
  const fn = map[e.target.id];
  if (fn) { run(fn); return; }
  if (e.target.closest && e.target.closest('[data-view="reports"]')) { RS.page = 1; run(renderReports); }
});
document.addEventListener('change', (e) => {
  if (['mCat', 'mStatus', 'mExpiry'].includes(e.target.id)) { DOC_PAGE.driver = 1; run(() => renderDocPage('driver')); }
  if (['vdCat', 'vdStatus', 'vdExpiry'].includes(e.target.id)) { DOC_PAGE.vehicle = 1; run(() => renderDocPage('vehicle')); }
  if (e.target.id === 'mDrv') { DOC_SEL.driver = Number(e.target.value) || null; DOC_PAGE.driver = 1; run(() => renderDocPage('driver')); }
  if (e.target.id === 'vdVeh') { DOC_SEL.vehicle = Number(e.target.value) || null; DOC_PAGE.vehicle = 1; run(() => renderDocPage('vehicle')); }
  if (e.target.id === 'rProv') { run(renderReports); }
});

/* profile */
$('#pSave').onclick = () => run(async () => {
  const name = $('#pName').value.trim();
  try {
    const r = await api('PUT', '/api/me/profile', { name });
    ME = r.user;
    fieldErr('pName', '');
    toast('پروفایل ذخیره شد');
  } catch (err) {
    fieldErr('pName', err.fields?.name || err.message);
  }
});

/* ================= Boot ================= */
buildNav();
let storedTheme = 'glass';
try { storedTheme = localStorage.getItem('mista-theme') || 'dark'; } catch { /* ignore */ }
setTheme(storedTheme);
run(async () => {
  try {
    const me = await api('GET', '/api/me');
    await enterApp(me);
  } catch (e) {
    if (e.status !== 401) console.error(e);
    showLogin(e.status === 401 ? '' : e.message);
  }
});

function openFinCat() {
  openModal(`<h3>دسته مالی جدید</h3><form id="fcForm" novalidate>
    <div class="row2"><div class="field"><label for="fc-name">نام دسته</label><input class="input" id="fc-name"><div class="err" id="fc-name-e"></div></div>
    <div class="field"><label for="fc-kind">نوع</label><select class="input" id="fc-kind">${opt([['income', 'درآمد'], ['expense', 'هزینه']], 'expense', '')}</select><div class="err" id="fc-kind-e"></div></div></div>
    <div class="acts"><button class="btn" type="submit">ثبت دسته</button><button class="btn ghost" type="button" data-act="close">انصراف</button></div></form>`);
  $('#fcForm').onsubmit = (e) => { e.preventDefault(); clearErrs($('#fcForm'));
    run(async () => {
      try { await api('POST', '/api/finance/categories', { name: $('#fc-name').value.trim(), kind: $('#fc-kind').value }); }
      catch (err) { applyServerErrors(err, { name: 'fc-name', kind: 'fc-kind' }); throw Object.assign(new Error('handled'), { status: -1 }); }
      closeModal(); toast('دسته ثبت شد'); await RENDER.finance();
    }).catch(() => {});
  };
}
