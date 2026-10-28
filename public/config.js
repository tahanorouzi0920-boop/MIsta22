// Runtime configuration for the MISTA frontend.
// Leave empty when the API is on the same origin (Node server serving public/, or a Cloudflare proxy rule for /api/*).
// Do not point this at a different origin: the session cookie is SameSite=Strict and would not be sent.
window.MISTA_API_BASE = '';

// کلید نمایش نقشه نشان (نوع web.). این کلید در مرورگر دیده می‌شود، پس آن را در پنل نشان به دامنه مجاز محدود کنید.
// کلید سرویس مسیریابی (service.) هرگز اینجا گذاشته نمی‌شود؛ فقط در متغیر NESHAN_API_KEY روی سرور است.
window.MISTA_MAP_KEY = window.MISTA_MAP_KEY || 'web.88261abc39fe452da0ec20470bdb3fad';
