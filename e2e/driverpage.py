import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4462"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    ph=b.new_context(viewport={"width":390,"height":844}).new_page(); ph.on("pageerror", lambda e: R["errors"].append(str(e)))
    ph.goto(B+"/driver.html")
    check("driver page shows login and registration", ph.is_visible("#loginBtn") and ph.is_visible("#regBtn"))
    ph.fill("#fn","علی"); ph.fill("#ln","راننده"); ph.fill("#nid","1000000001"); ph.fill("#mob","09121234567"); ph.select_option("#gen","مرد"); ph.fill("#np","DriverPass1")
    ph.click("#regBtn"); ph.wait_for_timeout(700)
    check("registration reports pending approval", "پس از تایید مدیر" in ph.inner_text("#regErr"), ph.inner_text("#regErr")[:160])
    ph.fill("#u","1000000001"); ph.fill("#p","DriverPass1"); ph.click("#loginBtn"); ph.wait_for_timeout(700)
    check("pending account cannot sign in", "تایید مدیر" in ph.inner_text("#authErr"), ph.inner_text("#authErr")[:160])
    check("driver app section stays hidden", not ph.is_visible("#app"))
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
