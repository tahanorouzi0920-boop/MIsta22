import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4830"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1366,"height":860})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    pg.click("#nav .grphead:has-text('اتوماسیون اداری')") if pg.get_attribute("#nav .grphead:has-text('اتوماسیون اداری')","aria-expanded")!="true" else None
    pg.click("#nav button[data-page='personnel']"); pg.wait_for_selector("#pBody", state="attached"); pg.wait_for_timeout(300)
    pg.click("[data-act='add-person']"); pg.wait_for_selector("#pfForm"); pg.wait_for_timeout(200)
    pg.mouse.click(10,10); pg.wait_for_timeout(200)
    check("click outside the dialog keeps it open", pg.is_visible("#modal"))
    pg.click("#pf-first"); pg.wait_for_timeout(100)
    check("click inside the dialog keeps it open", pg.is_visible("#modal"))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check("Escape keeps the dialog open", pg.is_visible("#modal"))
    check("✕ button is shown", pg.is_visible("#modal .modal-x"))
    pg.click("#modal .modal-x"); pg.wait_for_timeout(200)
    check("✕ closes the dialog", not pg.is_visible("#modal"))
    pg.click("[data-act='add-person']"); pg.wait_for_selector("#pfForm"); pg.click("#modal [data-act='close']")
    check("Cancel button still closes the dialog", not pg.is_visible("#modal"))
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
