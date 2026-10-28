'use strict';

const LEGAL = [
  ['01', '01 - سهامی خاص'], ['02', '02 - سهامی عام'], ['03', '03 - با مسئولیت محدود'],
];

const COUNTRIES = ['ایران', 'افغانستان', 'عراق', 'ترکیه', 'امارات متحده عربی', 'سایر'];

// Each model belongs to exactly one manufacturer. Verify against official lists before production.
const BRANDS = {
  'ایران خودرو': ['پژو ۲۰۶', 'پژو ۲۰۷', 'پژو ۴۰۵', 'پژو پارس', 'سمند', 'دنا', 'رانا', 'تارا', 'سورن پلاس'],
  'سایپا': ['پراید ۱۱۱', 'پراید ۱۳۱', 'پراید ۱۳۲', 'تیبا ۱', 'تیبا ۲', 'تیبا هاچبک', 'ساینا', 'کوئیک', 'شاهین'],
  'ام وی ام': ['X22', 'X33', '530', '315', '110', 'X55'],
  'کیا': ['ریو', 'پیکانتو', 'سراتو', 'اسپورتیج', 'سورنتو', 'کارنیوال'],
  'هیوندای': ['النترا', 'سوناتا', 'توسان', 'آکسنت', 'H1', 'کانتی'],
  'چری': ['تیگو ۲', 'تیگو ۵', 'تیگو ۸', 'آریزو ۵', 'آریزو ۶'],
  'جک': ['J7', 'J4', 'S5', 'S3', 'T6'],
  'برلیانس': ['H220', 'H230', 'H320', 'H330', 'H530'],
  'تویوتا': ['کرولا', 'کمری', 'لندکروزر', 'هایلکس', 'پرادو'],
  'مرسدس بنز': ['اسپرینتر', 'ویتو'],
  'ایران خودرو دیزل': ['دیزل ۲۵۰', 'دیزل ۳۰۰', 'دیزل بین‌شهری'],
  'ماشین‌سازی تبریز': ['ماشین‌سازی تبریز سرنشین', 'ماشین‌سازی تبریز مینی‌بوس'],
};

const CATEGORIES = { 'سواری': ['A', 'B'], 'ون': ['C'], 'مینی‌بوس': ['D'], 'اتوبوس': ['E'] };
const USAGE = ['03 - حمل مسافر (عمومی)', '04 - حمل مسافر (شخصی)'];

// Geographic data is loaded from server/geo/geo-data.json (single source of truth).
// Province codes (P01..P31) and city IDs (P01-001, ...) are stable and must never be renumbered.
const GEO_DATA = require('./geo/geo-data.json');
const GEO = {
  status: GEO_DATA.status, source: GEO_DATA.source, sourceDate: GEO_DATA.sourceDate,
  provinces: GEO_DATA.provinces, cities: GEO_DATA.cities,
  provinceByCode: Object.fromEntries(GEO_DATA.provinces.map((p) => [p.code, p])),
  provinceByName: Object.fromEntries(GEO_DATA.provinces.map((p) => [p.name, p])),
  cityById: Object.fromEntries(GEO_DATA.cities.map((c) => [c.id, c])),
  cityByName: Object.fromEntries(GEO_DATA.cities.map((c) => [c.provinceCode + '|' + c.name, c])),
};
// Name-keyed view kept for compatibility: province name -> city names.
const PROVINCES = Object.fromEntries(GEO.provinces.map((p) => [p.name, GEO.cities.filter((c) => c.provinceCode === p.code).map((c) => c.name)]));

const PLATE_LETTERS = ['الف', 'ب', 'ت', 'ث', 'ج', 'د', 'س', 'ص', 'ط', 'ع', 'ق', 'ل', 'م', 'ن', 'و', 'ه', 'ی'];

const ROLE_NAMES = ['مدیر سیستم', 'مدیر', 'کاربر عادی', 'حسابرس', 'کارفرما', 'پرسنل', 'راننده'];
// Roles that can be chosen when creating a new user.
const NEW_USER_ROLES = ['مدیر سیستم', 'کارفرما', 'پرسنل', 'راننده'];

const SECTIONS = {
  companies: 'شرکت‌ها', drivers: 'رانندگان', vehicles: 'خودروها', contracts: 'قراردادها',
  users: 'کاربران', reports: 'گزارش‌ها', documents: 'مدارک', doctypes: 'انواع مدارک',
  letters: 'نامه‌ها', absences: 'غیبت و مرخصی', announcements: 'تابلو اعلانات', tasks: 'کارها و وظایف', meetings: 'جلسات', archive: 'مستندات', personnel: 'پرسنل', requests: 'درخواست‌های کاربرگی', passengers: 'اطلاعات مسافران', finance: 'مالی',
};

function build(fn) {
  return Object.fromEntries(Object.keys(SECTIONS).map((s) => [s, fn(s)]));
}

const BASIC = ['companies', 'drivers', 'vehicles', 'contracts', 'documents'];

// Single source of truth for role permissions. Enforced on the server for every request.
const ROLE_PERMS = {
  'مدیر سیستم': build(() => ({ view: 1, create: 1, edit: 1, delete: 1 })),
  'مدیر': build((s) => ({ view: 1, create: 1, edit: 1, delete: s === 'users' ? 0 : 1 })),
  'کاربر عادی': build((s) => ({
    view: BASIC.includes(s) || s === 'doctypes' ? 1 : 0,
    create: BASIC.includes(s) ? 1 : 0,
    edit: BASIC.includes(s) ? 1 : 0,
    delete: 0,
  })),
  'حسابرس': build((s) => ({
    view: [...BASIC, 'reports', 'doctypes'].includes(s) ? 1 : 0,
    create: 0, edit: 0, delete: 0,
  })),
};

// Documents belong only to drivers or vehicles. Company documents are no longer supported.
const DOC_OWNERS = ['driver', 'vehicle'];
const DOC_CATEGORIES = { driver: 'راننده', ohs: 'سلامت و ایمنی', vehicle: 'خودرو', company: 'شرکت (قدیمی)' };

// Initial catalog. Every item is optional by default (required = 0). Administrators can change this.
const DOC_CATALOG = [
  { name: 'گواهینامه رانندگی', category: 'driver', owner_type: 'driver' },
  { name: 'سایر مدارک راننده', category: 'driver', owner_type: 'driver' },
  { name: 'گواهی معاینه پزشکی یا سلامت شغلی', category: 'ohs', owner_type: 'driver' },
  { name: 'مدارک معاینات دوره‌ای', category: 'ohs', owner_type: 'driver' },
  { name: 'گواهی آموزش ایمنی و بهداشت', category: 'ohs', owner_type: 'driver' },
  { name: 'گواهی صلاحیت حرفه‌ای', category: 'ohs', owner_type: 'driver' },
  { name: 'سند مالکیت', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'کارت خودرو', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'معاینه فنی', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'کارت سوخت', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'چشمی', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'مخزن گاز', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'هیدرواستاتیک', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'بیمه شخص ثالث', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'بیمه بدنه', category: 'vehicle', owner_type: 'vehicle' },
  { name: 'کپسول آتش‌نشانی', category: 'vehicle', owner_type: 'vehicle' },
];

const DOC_STATUS_LABEL = {
  none: 'بارگذاری نشده', pending: 'نیازمند بررسی', approved: 'تأیید شده',
  rejected: 'رد شده', expired: 'منقضی شده', na: 'اعمال نمی‌شود',
};

const FILE_TYPES = {
  pdf: { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
};

const LABELS = {
  company: {
    name: 'نام شرکت', code: 'کد شرکت', nationalId: 'شناسه ملی', regNo: 'شماره ثبت', regDate: 'تاریخ ثبت',
    legalType: 'نوع شخصیت حقوقی', mobile: 'موبایل', phone: 'تلفن ثابت', econ: 'کد اقتصادی', country: 'کشور',
    province: 'استان', city: 'شهر', region: 'منطقه', postal: 'کد پستی', address: 'آدرس', description: 'توضیحات',
  },
  driver: { name: 'نام', nid: 'کد ملی', mobile: 'موبایل', gender: 'جنسیت', startDate: 'تاریخ شروع همکاری', province: 'استان محل سکونت', city: 'شهر محل سکونت', residenceAddress: 'آدرس محل سکونت' },
  vehicle: {
    brand: 'برند', model: 'مدل', plate: 'پلاک', category: 'دسته‌بندی', cls: 'کلاس',
    year: 'سال ساخت', capacity: 'ظرفیت', usage: 'نوع کاربری',
  },
  contract: { company: 'شرکت', driver: 'راننده', vehicle: 'خودرو', startDate: 'تاریخ شروع', endDate: 'تاریخ پایان' },
};

// Administrative section: the generic builder above applies to every section; these two rows are the explicit exceptions.
// Ordinary users can send and receive internal letters.
ROLE_PERMS['کاربر عادی'].letters = { view: 1, create: 1, edit: 1, delete: 0 };
// Drivers sign in to the driver page only. They have no permission in the admin sections.
ROLE_PERMS['راننده'] = build(() => false);

// New roles. Permissions are an assumption until confirmed by the business owner; per-user tables can override them.
ROLE_PERMS['کارفرما'] = build((sec) => (sec === 'users'
  ? { view: 1, create: 0, edit: 0, delete: 0 }
  : { view: 1, create: 1, edit: 1, delete: 0 }));
ROLE_PERMS['حسابرس'].letters = { view: 1, create: 0, edit: 1, delete: 0 };

ROLE_PERMS['پرسنل'] = build((sec) => (sec === 'letters' || sec === 'absences'
  ? { view: 1, create: 1, edit: 1, delete: 0 }
  : { view: 0, create: 0, edit: 0, delete: 0 }));
// Ordinary users read the notice board and the meetings they are invited to; they manage their own tasks.
ROLE_PERMS['کاربر عادی'].announcements = { view: 1, create: 0, edit: 0, delete: 0 };
ROLE_PERMS['کاربر عادی'].tasks = { view: 1, create: 1, edit: 1, delete: 0 };
ROLE_PERMS['کاربر عادی'].meetings = { view: 1, create: 0, edit: 0, delete: 0 };
ROLE_PERMS['کاربر عادی'].archive = { view: 1, create: 0, edit: 0, delete: 0 };
ROLE_PERMS['پرسنل'].tasks = { view: 1, create: 1, edit: 1, delete: 0 };
ROLE_PERMS['پرسنل'].meetings = { view: 1, create: 1, edit: 1, delete: 0 };
ROLE_PERMS['پرسنل'].announcements = { view: 1, create: 0, edit: 0, delete: 0 };
ROLE_PERMS['پرسنل'].archive = { view: 1, create: 1, edit: 0, delete: 0 };

// Personnel files: HR can view, create and edit; the employer can only view. Other roles see only their own file (checked on the server).
ROLE_PERMS['پرسنل'].personnel = { view: 1, create: 1, edit: 1, delete: 0 };
ROLE_PERMS['کارفرما'].personnel = { view: 1, create: 0, edit: 0, delete: 0 };
const PERSONNEL_STATUS = { active: 'فعال', inactive: 'غیرفعال', on_assignment: 'مأمور', on_leave: 'مرخصی', dismissed: 'تعدیل‌شده' };
const PERSONNEL_DOC_TYPES = ['شناسنامه', 'کارت ملی', 'مدرک تحصیلی', 'گواهینامه', 'مدرک طب کار', 'سوءپیشینه', 'قرارداد', 'سایر'];

// Service requests, passengers and finance: starting access by role. HR roles and the employer see what their work needs.
ROLE_PERMS['کاربر عادی'].requests = { view: 1, create: 1, edit: 0, delete: 0 };
ROLE_PERMS['کارفرما'].requests = { view: 1, create: 1, edit: 0, delete: 0 };
ROLE_PERMS['کارفرما'].passengers = { view: 1, create: 0, edit: 0, delete: 0 };
ROLE_PERMS['کارفرما'].finance = { view: 1, create: 0, edit: 0, delete: 0 };
ROLE_PERMS['پرسنل'].requests = { view: 1, create: 1, edit: 1, delete: 0 };
ROLE_PERMS['پرسنل'].passengers = { view: 1, create: 1, edit: 1, delete: 0 };
ROLE_PERMS['پرسنل'].finance = { view: 0, create: 0, edit: 0, delete: 0 };
module.exports = {
  LEGAL, COUNTRIES, BRANDS, CATEGORIES, USAGE, PROVINCES, GEO, PLATE_LETTERS, ROLE_NAMES, NEW_USER_ROLES,
  SECTIONS, ROLE_PERMS, DOC_OWNERS, DOC_CATEGORIES, DOC_CATALOG, DOC_STATUS_LABEL,
  FILE_TYPES, LABELS, PERSONNEL_STATUS, PERSONNEL_DOC_TYPES,
};
