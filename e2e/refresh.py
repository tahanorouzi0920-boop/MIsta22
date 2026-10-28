import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4584"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    pg.evaluate("window.__marker = 'same-document'")
    pg.click("#nav .grphead:has-text('اتوماسیون اداری')") if pg.get_attribute("#nav .grphead:has-text('اتوماسیون اداری')","aria-expanded")!="true" else None
    pg.click("#nav button:has-text('کارها و وظایف')"); pg.wait_for_selector("#tSearch"); pg.wait_for_timeout(300)
    check("refresh button in the top bar", pg.is_visible("#refreshBtn"))
    pg.fill("#tSearch","گزارش")
    pg.click("#refreshBtn"); pg.wait_for_timeout(700)
    check("page is not reloaded (same document)", pg.evaluate("window.__marker")=="same-document")
    check("typed search survives refresh", pg.input_value("#tSearch")=="گزارش", pg.input_value("#tSearch"))
    check("refresh timestamp is shown", "آخرین بازخوانی" in pg.inner_text("#refreshStamp"), pg.inner_text("#refreshStamp"))
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
