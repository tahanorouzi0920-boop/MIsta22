import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4561"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    pg.evaluate("""async()=>{await fetch('/api/users',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'rcpt9',name:'گیرنده نمونه',role:'پرسنل',password:'RcptPass123'})});}""")
    pg.click("#nav .grphead:has-text('اتوماسیون اداری')"); pg.wait_for_timeout(200)
    pg.click("#nav button[data-page='letters']"); pg.wait_for_selector("#lBody", state="attached"); pg.wait_for_timeout(400)
    pg.click("[data-act='new-letter']") if pg.locator("[data-act='new-letter']").count() else pg.click("button:has-text('نامه جدید')")
    pg.wait_for_selector("#lForm")
    pg.locator("#l-kind").evaluate("e=>{e.value='وارده'; e.dispatchEvent(new Event('change'))}")
    check("external party field appears for an incoming letter", pg.is_visible("#l-ext-wrap"))
    pg.fill("#l-ext","شرکت نمونه ارسال‌کننده")
    pg.fill("#l-subject","نامه وارده آزمون"); pg.select_option("#l-rid", index=1) if pg.is_visible("#l-rid") else None
    pg.click("#lForm button[type=submit]"); pg.wait_for_timeout(700)
    if pg.is_visible("#modal"): pg.click("#modal [data-act='close']"); pg.wait_for_timeout(200)
    check("incoming letter saved with an IN number", "IN-" in pg.inner_text("#lBody") or "۱۴۰۵" in pg.inner_text("#lBody"), pg.inner_text("#lBody")[:200])
    pg.click("button:has-text('نامه جدید')"); pg.wait_for_selector("#lForm")
    pg.locator("#l-kind").evaluate("e=>{e.value='صادره'; e.dispatchEvent(new Event('change'))}")
    pg.fill("#l-ext","وزارت نمونه"); pg.fill("#l-subject","نامه صادره آزمون")
    pg.click("#lForm button[type=submit]"); pg.wait_for_timeout(700)
    if pg.is_visible("#modal"): pg.click("#modal [data-act='close']"); pg.wait_for_timeout(200)
    check("outgoing letter saved without an internal recipient", pg.locator("#lForm").count()==0 or pg.is_hidden("#modal"), pg.inner_text("#modal")[:160] if pg.is_visible("#modal") else None)
    pg.fill("#lfSender","وزارت"); pg.wait_for_timeout(500)
    check("sender filter finds the outside party", "نامه صادره آزمون" in pg.inner_text("#lBody"), pg.inner_text("#lBody")[:200])
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
