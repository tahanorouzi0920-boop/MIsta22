import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4810"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    for name,vp in [("desktop",{"width":1366,"height":860}),("mobile",{"width":390,"height":844})]:
        ctx=b.new_context(viewport=vp); ctx.add_init_script("localStorage.setItem('mista-theme','dark')")
        pg=ctx.new_page(); pg.on("pageerror", lambda e: R["errors"].append(str(e)))
        pg.goto(B+"/"); pg.wait_for_selector("#loginBtn"); pg.wait_for_timeout(600)
        pg.screenshot(path=f"/tmp/lp/login_{name}.png", full_page=True)
        check(f"{name}: no horizontal overflow", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth+1"))
        if name=="desktop":
            before=pg.evaluate("document.body.dataset.theme")
            pg.click("#bgToggle"); pg.wait_for_timeout(200)
            after=pg.evaluate("document.body.dataset.theme")
            check("background button changes theme", before!=after, f"{before}->{after}")
            check("background label updates", pg.inner_text("#bgName").strip()!="", pg.inner_text("#bgName"))
            pg.click("#bgToggle"); pg.click("#bgToggle"); pg.wait_for_timeout(100)
            check("background button cycles back to start", pg.evaluate("document.body.dataset.theme")==before)
            pg.click("#loginBtn"); pg.wait_for_timeout(300)
            check("empty submit shows username error", "نام کاربری" in pg.inner_text("#lu-e") or pg.inner_text("#lu-e").strip()!="", pg.inner_text("#lu-e"))
            pg.fill("#lu","admin"); pg.fill("#lp","wrong"); pg.click("#loginBtn"); pg.wait_for_timeout(700)
            check("wrong password keeps login visible with message", pg.is_visible("#login") and pg.inner_text("#login-e").strip()!="")
            pg.fill("#lp","Admin@Test1"); pg.click("#togglePw"); check("show/hide shows password", pg.get_attribute("#lp","type")=="text")
            pg.click("#togglePw"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)", timeout=8000)
            check("correct sign-in opens the app", not pg.is_visible("#login"))
            pg.click("#logout"); pg.wait_for_selector("#login:not(.hidden)", timeout=8000)
            check("sign-out shows login", pg.is_visible("#login"))
        ctx.close()
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
