import json, time
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4502"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
def pick(pg, sel, label):
    loc=pg.locator("#"+sel); inp=loc.locator("xpath=preceding-sibling::div[contains(@class,'combo')][1]//input")
    if inp.count()==0: pg.select_option("#"+sel, label=label); return
    inp.click(); inp.fill(label); pg.wait_for_timeout(120)
    loc.locator("xpath=preceding-sibling::div[contains(@class,'combo')][1]//li", has_text=label).first.click(); pg.wait_for_timeout(120)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    pg.click("#nav button:has-text('پرونده پرسنلی')"); pg.wait_for_selector("#pBody", state="attached"); pg.wait_for_timeout(400)
    check("personnel page opens", pg.is_visible("section[data-view='personnel']"))
    code="PN"+str(int(time.time())%100000)
    pg.click("[data-act='add-person']"); pg.wait_for_selector("#pfForm")
    pg.fill("#pf-first","رضا"); pg.fill("#pf-last","کریمی"); pg.fill("#pf-nid","1000000001"); pg.fill("#pf-code",code); pg.fill("#pf-pos","کارشناس")
    pg.fill("#pf-mob","09121234567"); pg.fill("#pf-addr","تهران، خیابان آزمون")
    pg.locator("#pf-start").fill("۱۴۰۵/۰۱/۰۱")
    pg.click("#pfForm button[type=submit]"); pg.wait_for_selector("#modal", state="hidden", timeout=8000); pg.wait_for_timeout(400)
    print("DBG modal:", pg.is_visible("#modal"), "| err:", pg.evaluate("()=>[...document.querySelectorAll('.err')].map(e=>e.textContent).filter(Boolean).join(' / ')"), "| body:", pg.inner_text("#pBody")[:200], flush=True)
    check("personnel saved and listed", code in pg.inner_text("#pBody"), pg.inner_text("#pBody")[:200])
    pg.fill("#pSearch","کریمی"); pg.wait_for_timeout(400)
    check("search finds the person", code in pg.inner_text("#pBody"))
    pg.fill("#pSearch",""); pg.wait_for_timeout(300)
    row=pg.locator(f"tr:has-text('{code}')")
    row.locator("[data-act='view-person']").click(); pg.wait_for_selector("#modal h3")
    pg.set_input_files("#pd-file", "/tmp/doc.pdf")
    pg.fill("#pd-title","شناسنامه اسکن"); pick(pg,"pd-type","شناسنامه")
    pg.click("#pdForm button[type=submit]"); pg.wait_for_timeout(700)
    check("document uploaded and listed", "شناسنامه اسکن" in pg.inner_text("#modal"), pg.inner_text("#modal")[-300:])
    with pg.expect_download() as dl:
        pg.click("#modal a:has-text('دریافت')")
    d=dl.value
    check("document downloads with its name", d.suggested_filename.endswith('.pdf'), d.suggested_filename)
    pg.click("#modal [data-act='close']"); pg.wait_for_timeout(200)
    check("status filter present", pg.locator("#pStatus").count()==1)
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
