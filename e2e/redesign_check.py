import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4800"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    for theme,expect in [("light","rgb(248, 250, 252)"),("dark","rgb(11, 16, 32)")]:
        ctx=b.new_context(viewport={"width":1366,"height":860}); ctx.add_init_script(f"localStorage.setItem('mista-theme','{theme}')")
        pg=ctx.new_page(); pg.on("pageerror", lambda e: R["errors"].append(str(e)))
        pg.goto(B+"/"); pg.wait_for_selector("#loginBtn"); pg.wait_for_timeout(500)
        bg=pg.evaluate("getComputedStyle(document.body).backgroundColor")
        check(f"{theme}: body background", bg==expect, bg)
        font=pg.evaluate("getComputedStyle(document.body).fontFamily")
        check(f"{theme}: font stack starts with Vazirmatn", font.startswith("Vazirmatn"), font[:60])
        pg.screenshot(path=f"/tmp/rd/login_{theme}.png")
        pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
        pg.wait_for_timeout(500)
        pg.screenshot(path=f"/tmp/rd/dash_{theme}.png")
        check(f"{theme}: dashboard loads", pg.is_visible("#app"))
        ctx.close()
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
