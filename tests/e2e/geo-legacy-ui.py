import sys
from playwright.sync_api import sync_playwright
BASE=sys.argv[1]; res={}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    pg=b.new_page(); bad=[]; errs=[]
    pg.on("response", lambda r: bad.append((r.status, r.url.replace(BASE,''))) if r.status>=400 else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Secret@123"); pg.click("#loginBtn")
    pg.wait_for_selector("#app:not(.hidden)")
    pg.click("#nav [data-page='companies']"); pg.wait_for_selector("#cBody")
    pg.click("#cBody tr:has-text('شرکت قدیمی') [data-act='edit-companies']"); pg.wait_for_selector("#c-prov")
    res["legacy_province"]=pg.eval_on_selector("#c-prov","e=>e.options[e.selectedIndex]?e.options[e.selectedIndex].textContent:''")
    res["legacy_city"]=pg.eval_on_selector("#c-city","e=>e.options[e.selectedIndex]?e.options[e.selectedIndex].textContent:''")
    res["http_errors"]=bad; res["page_errors"]=errs
    b.close()
print(res)
