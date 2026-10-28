import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4540"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    pg.evaluate("""async()=>{await fetch('/api/personnel',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstName:'رضا',lastName:'کریمی',nationalId:'0098765434',personnelCode:'LVB1',status:'active'})});}""")
    pg.click("#nav .grphead:has-text('اتوماسیون اداری')"); pg.wait_for_timeout(200)
    pg.click("#nav button[data-page='leave']"); pg.wait_for_selector("#lvBody", state="attached"); pg.wait_for_timeout(500)
    check("settings card shows the starting chain", pg.locator("#lvSteps").count()==1 and "تنظیم اولیه" in pg.input_value("#lvSteps"))
    pg.fill("#lvAnnual","30"); pg.click("[data-act='lv-save-settings']"); pg.wait_for_timeout(500)
    check("annual allowance saved", pg.input_value("#lvAnnual")=="30")
    pg.click("[data-act='add-leave']"); pg.wait_for_selector("#lvForm")
    pg.select_option("#lv-p", index=1) if pg.is_visible("#lv-p") else None
    pg.locator("#lv-start").fill("۱۴۰۵/۰۷/۱۰"); pg.locator("#lv-end").fill("۱۴۰۵/۰۷/۱۲"); pg.fill("#lv-reason","تست")
    pg.click("#lvForm button[type=submit]"); pg.wait_for_timeout(700)
    check("request listed as in progress", "در جریان تأیید" in pg.inner_text("#lvBody"), pg.inner_text("#lvBody")[:200])
    for i in range(3):
        pg.click("#lvBody [data-act='view-leave']"); pg.wait_for_selector("#modal h3")
        pg.click("#modal [data-act='lv-action'][data-v='approve']"); pg.wait_for_timeout(600)
        if pg.is_visible("#modal"): pg.click("#modal [data-act='close']")
        pg.wait_for_timeout(200)
    check("request approved after three steps", "تأییدشده" in pg.inner_text("#lvBody"), pg.inner_text("#lvBody")[:200])
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
