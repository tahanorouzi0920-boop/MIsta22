import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4600"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    for theme in ["dark","light","glass"]:
        for name,vp in [("desktop",{"width":1366,"height":820}),("mobile",{"width":390,"height":844})]:
            ctx=b.new_context(viewport=vp); ctx.add_init_script(f"localStorage.setItem('mista-theme','{theme}')")
            pg=ctx.new_page(); pg.on("pageerror", lambda e: R["errors"].append(str(e)))
            pg.goto(B+"/"); pg.wait_for_selector("#loginBtn")
            pg.wait_for_timeout(900)
            pg.screenshot(path=f"/tmp/shots/login_{theme}_{name}.png", full_page=True)
            check(f"{theme} {name}: login visible", pg.is_visible("#login"))
            check(f"{theme} {name}: no horizontal overflow", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth+1"))
            if theme=="dark" and name=="desktop":
                bg=pg.evaluate("getComputedStyle(document.getElementById('login')).backgroundColor"); check("dark default background is the dark theme colour (#0b1020)", bg=="rgb(11, 16, 32)", bg)
                pg.click("#loginBtn"); pg.wait_for_timeout(300)
                check("empty submit shows field errors", "نام کاربری را وارد کنید" in pg.inner_text("#lu-e") and "رمز عبور را وارد کنید" in pg.inner_text("#lp-e"))
                pg.fill("#lu","admin"); pg.fill("#lp","wrong-pass"); pg.click("#loginBtn"); pg.wait_for_timeout(700)
                check("wrong password is refused and page stays", pg.is_visible("#login") and pg.inner_text("#login-e").strip()!="")
                pg.fill("#lp","Admin@Test1"); pg.click("#togglePw"); pg.wait_for_timeout(100)
                check("show/hide toggles to plain text", pg.get_attribute("#lp","type")=="text")
                pg.click("#togglePw"); check("show/hide toggles back", pg.get_attribute("#lp","type")=="password")
                pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)", timeout=8000)
                check("correct sign-in opens the app and hides login", not pg.is_visible("#login"))
                pg.click("#logout"); pg.wait_for_selector("#login:not(.hidden)", timeout=8000)
                check("sign-out shows login again", pg.is_visible("#login"))
            ctx.close()
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
