#!/usr/bin/env node
'use strict';

/*
 * SAMPLE DATA for testing only. Creates one sample record for each section the wizard needs:
 * site, supervision unit, company, driver, vehicle, contract, vehicle shift, vehicle service and a service plan.
 * Everything is created through the running server's API, so the same rules apply.
 * Records that already exist (by code or national ID or plate) are skipped, so the script can be run again.
 *
 * Usage (server must be running):
 *   ADMIN_PASSWORD=<admin password> node tools/seed-sample.js [http://127.0.0.1:3000]
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('ADMIN_PASSWORD را تنظیم کنید.'); process.exit(2); }

let cookie = '';
async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc && !cookie) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${data.error || ''} ${JSON.stringify(data.fields || {})}`), { status: res.status });
  return data;
}
const log = (msg) => console.log('• ' + msg);

(async () => {
  await api('POST', '/api/login', { username: USER, password: PASS });
  log('ورود انجام شد');

  let site = (await api('GET', '/api/sites')).items.find((x) => x.code === 'SMP-S1');
  if (!site) site = await api('POST', '/api/sites', { code: 'SMP-S1', name: 'سایت نمونه تهران' });
  log(`سایت: ${site.name} (${site.code})`);

  let unit = (await api('GET', `/api/supervision-units?siteId=${site.id}`)).items.find((x) => x.code === 'SMP-U1');
  if (!unit) unit = await api('POST', '/api/supervision-units', { code: 'SMP-U1', name: 'واحد نظارت نمونه', siteId: site.id });
  log(`واحد نظارت: ${unit.name} (${unit.code})`);

  let company = (await api('GET', '/api/companies')).items.find((x) => x.code === 'SMP-C1');
  if (!company) company = await api('POST', '/api/companies', { code: 'SMP-C1', name: 'شرکت نمونه حمل‌ونقل', regDate: '2025-01-10', legalType: '01', mobile: '09121112233', country: 'ایران', province: 'تهران', city: 'ورامین', address: 'تهران، خیابان نمونه', siteId: site.id, supervisionUnitId: unit.id });
  log(`شرکت: ${company.name} (${company.code})`);

  let driver = (await api('GET', '/api/drivers')).items.find((x) => x.nid === '0012345679');
  if (!driver) driver = await api('POST', '/api/drivers', { first: 'علی', last: 'نمونه', nid: '0012345679', mobile: '09121234567', gender: 'مرد' });
  log(`راننده: ${driver.name || driver.first + ' ' + driver.last} (کد ملی ${driver.nid})`);

  const overview = (await api('GET', '/api/vehicle-overview')).items;
  let vehicle = overview.find((v) => v.plate && v.plate.a === '21' && v.plate.b === '443' && v.plate.c === 'ط' && v.plate.d === '83');
  if (!vehicle) vehicle = await api('POST', '/api/vehicles', { brand: 'سایپا', model: 'پراید ۱۳۱', category: 'سواری', cls: 'B', year: '۱۳۹۸', capacity: '۴', usage: '04 - حمل مسافر (شخصی)', supervisionUnit: 'واحد نظارت نمونه', plate: { a: '۲۱', b: '۴۴۳', c: 'ط', d: '۸۳' } });
  log(`خودرو: ${vehicle.plateText || '21 ایران 443 ط 83'} (${vehicle.brand} ${vehicle.model})`);

  const contracts = (await api('GET', '/api/contracts')).items;
  let contract = contracts.find((c) => c.vehicleId === vehicle.id);
  if (!contract) contract = await api('POST', '/api/contracts', { companyId: company.id, driverId: driver.id, vehicleId: vehicle.id, startDate: '2025-01-01', siteId: site.id, supervisionUnitId: unit.id });
  log(`قرارداد: ${contract.number}`);

  const shifts = (await api('GET', '/api/vehicle-shifts')).items;
  let shift = shifts.find((s) => s.vehicleId === vehicle.id);
  if (!shift) { await api('POST', `/api/vehicles/${vehicle.id}/shifts`, { shiftDate: '2026-10-01', startTime: '06:00', endTime: '14:00', driverId: driver.id, note: 'شیفت نمونه' }); shift = (await api('GET', '/api/vehicle-shifts')).items.find((s) => s.vehicleId === vehicle.id); }
  log(`شیفت خودرو: ${shift.shiftDate} ${shift.startTime}-${shift.endTime}`);

  const services = (await api('GET', '/api/vehicle-services')).items;
  if (!services.some((s) => s.vehicleId === vehicle.id)) await api('POST', `/api/vehicles/${vehicle.id}/services`, { serviceDate: '2026-10-01', kind: 'تعویض روغن', odometer: '45000', note: 'سرویس نمونه' });
  log('سرویس خودرو: تعویض روغن (نمونه)');

  const plans = (await api('GET', '/api/service-plans')).items;
  if (!plans.some((p) => p.code === 'SMP-P1')) {
    await api('POST', '/api/service-plans', {
      code: 'SMP-P1', name: 'سرویس نمونه صبح', serviceType: 'ایاب و ذهاب سبک پرسنل', startDate: '2026-10-01', siteId: site.id, supervisionUnitId: unit.id,
      region: 'تهران', routeType: 'رفت', gender: 'مرد', returnService: 'سرویس عادی', directionStatus: 'دوطرفه', vehicleGroup: 'سواری', vehicleClass: 'B',
      allowedMinutes: '45', serviceNumber: 'S-1001', shiftId: shift.id,
      routes: [{ origin: 'ورامین', destination: 'تهران', description: 'مسیر نمونه', km: '50', startTime: '06:00', endTime: '07:00' }],
      passengers: [{ name: 'مسافر نمونه', boarding: 'ورامین', alighting: 'تهران', startDate: '2026-10-01', startTime: '06:00', endDate: '2026-10-30', endTime: '07:00' }],
      vehicleRate: { vehicleId: vehicle.id, fee: 150000, notes: 'نرخ نمونه' },
      companyRate: { calcType: 'per_service', amount: 250000 },
    });
  }
  log('سرویس نمونه (SMP-P1) ثبت شد یا از قبل وجود داشت');
  console.log('\nپایان. این داده‌ها فقط برای آزمایش هستند و می‌توانید آن‌ها را از همان صفحات حذف کنید.');
})().catch((err) => { console.error('خطا:', err.message); process.exit(1); });
