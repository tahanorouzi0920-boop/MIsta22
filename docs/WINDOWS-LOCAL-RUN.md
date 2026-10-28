# اجرای آزمایشی MISTA روی ویندوز و دسترسی از طریق دامنه با Cloudflare Tunnel

این راهنما برای آزمایش است، نه بهره‌برداری عمومی. لپ‌تاپ باید روشن و متصل به اینترنت باشد.

## ۱. پیش‌نیازها
- **Node.js نسخه ۲۲.۱۳ یا بالاتر** از nodejs.org نصب شود. بررسی: `node -v`
- **پوشه پروژه** (مثلاً `D:\mista`) که فایل‌های `server` و `public` در آن است.
- **دامنه `.ir`** خریداری‌شده و **حساب Cloudflare** (رایگان). دامنه باید به Cloudflare منتقل شود (تغییر nameserver توسط ثبت‌کننده دامنه). این مرحله را خودتان و با ثبت‌کننده انجام دهید؛ اگر ثبت‌کننده `.ir` اجازهٔ آن را ندهد، این روش کار نمی‌کند.
- **cloudflared**: از صفحه رسمی Cloudflare برای ویندوز دانلود کنید و فایل را مثلاً در `C:\cloudflared\cloudflared.exe` قرار دهید.

## ۲. داده‌ها را در مسیر پایدار قرار دهید
داده‌ها (دیتابیس و فایل‌های آپلودی) نباید داخل پوشه کد باشند تا با به‌روزرسانی کد از بین نروند:
```bat
mkdir D:\mista-data
```

## ۳. اجرای MISTA
در پوشهٔ پروژه، پنجرهٔ PowerShell یا Command Prompt را باز کنید:
```bat
set MISTA_DATA_DIR=D:\mista-data
set HOST=127.0.0.1
set PORT=3000
set ADMIN_PASSWORD=یک-رمز-قوی-و-جدید
set NESHAN_API_KEY=کلید-service-شما
npm start
```
- `ADMIN_PASSWORD` را حتماً تنظیم کنید؛ در غیر این صورت رمز پیش‌فرض فعال می‌شود.
- `NESHAN_API_KEY` کلید **سرویس** (`service.`) است و فقط روی همین سیستم می‌ماند.
- برای تست: در مرورگر `http://127.0.0.1:3000/api/health` را باز کنید. پاسخ باید `"ok":true` و `"database":"ok"` باشد.

## ۴. کلید نقشه در مرورگر
در فایل `public\config.js` مقدار `MISTA_MAP_KEY` را با کلید **نمایش نقشه** (`web.`) قرار دهید، نه کلید سرویس. در پنل نشان، این کلید را فقط برای دامنهٔ اختصاصی خود (مثلاً `https://mista.example.ir`) مجاز کنید.

## ۵. ساخت تونل Cloudflare
پنجرهٔ دوم PowerShell را باز کنید:
```bat
cd C:\cloudflared
cloudflared tunnel login
cloudflared tunnel create mista
cloudflared tunnel route dns mista mista.example.ir
```
فایل `C:\Users\<نام-کاربری>\.cloudflared\config.yml` را با این محتوا بسازید (شناسهٔ تونل را از خروجی `tunnel create` بردارید):
```yaml
tunnel: <TUNNEL-ID>
credentials-file: C:\Users\<نام-کاربری>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: mista.example.ir
    service: http://127.0.0.1:3000
  - service: http_status:404
```
سپس تونل را اجرا کنید:
```bat
cloudflared tunnel run mista
```
(نام دامنه `mista.example.ir` را با دامنهٔ خودتان جایگزین کنید.)

## ۶. توقف و اجرای مجدد
- **توقف MISTA:** در پنجرهٔ `npm start` کلید `Ctrl+C` را بزنید.
- **توقف تونل:** در پنجرهٔ `cloudflared` کلید `Ctrl+C` را بزنید.
- **اجرای تونل به‌صورت سرویس ویندوز** (اختیاری، پس از تست):
  ```bat
  cloudflared service install
  ```
  برای حذف: `cloudflared service uninstall`

## ۷. عیب‌یابی
| مشکل | بررسی |
|---|---|
| `/api/health` پاسخ نمی‌دهد | آیا `npm start` در حال اجرا است؟ پورت ۳۰۰۰ دیگر برنامه‌ای را اشغال نکرده باشد؟ (`netstat -ano \| findstr :3000`) |
| `database: error` | پوشهٔ `MISTA_DATA_DIR` وجود داشته باشد و دسترسی نوشتن داشته باشد. |
| دامنه باز نمی‌شود | `cloudflared tunnel run` در حال اجرا باشد؛ رکورد DNS در Cloudflare ساخته شده باشد؛ نام دامنه در `config.yml` درست باشد. |
| نقشه نمایش داده نمی‌شود | کلید `web.` در `config.js` باشد؛ دامنهٔ مجاز در پنل نشان با آدرسی که باز کرده‌اید یکی باشد. خطا را در Console (F12) بخوانید. |
| «API Key type not suitable» | کلید `service.` را به جای `web.` در `config.js` گذاشته‌اید. |
| GPS در گوشی کار نمی‌کند | صفحه باید با `https://` باز شود؛ مجوز موقعیت مکانی را در مرورگر گوشی بدهید؛ مکان‌یابی گوشی روشن باشد. |

## ۸. محدودیت‌ها
- این روش به لپ‌تاپ روشن و اینترنت پایدار وابسته است؛ برای استفادهٔ واقعی با ۲۵۰۰ راننده مناسب نیست.
- تونل و دامنه در این راهنما روی سیستم واقعی شما آزمایش نشده‌اند؛ مراحل را گام‌به‌گام انجام دهید و خطای دقیق را گزارش کنید.
