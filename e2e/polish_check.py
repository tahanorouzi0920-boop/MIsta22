import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4821"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); ctx=b.new_context(viewport={"width":1366,"height":860}); ctx.add_init_script("localStorage.setItem('mista-theme','light')")
    pg=ctx.new_page(); pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    h=pg.evaluate("()=>{const b=[...document.querySelectorAll('#app .btn')].find(x=>x.offsetParent!==null); return b? Math.round(b.getBoundingClientRect().height):0}")
    check("buttons are compact (<=40px tall on desktop)", 0<h<=40, h)
    pg.click("#nav .grphead:has-text('اتوماسیون اداری')") if pg.get_attribute("#nav .grphead:has-text('اتوماسیون اداری')","aria-expanded")!="true" else None
    pg.click("#nav button[data-page='personnel']"); pg.wait_for_selector("#pBody", state="attached"); pg.wait_for_timeout(500)
    pg.screenshot(path="/tmp/pl/personnel.png")
    check("table cells are denser", pg.evaluate("()=>{const td=document.querySelector('table td'); return td? parseInt(getComputedStyle(td).paddingTop)<=8 : true}"))
    pg.click("[data-act='add-person']"); pg.wait_for_selector("#pfForm"); pg.wait_for_timeout(300)
    mw=pg.evaluate("()=>Math.round(document.querySelector('#modal .card').getBoundingClientRect().width)")
    check("dialog is no wider than 560px", mw<=560, mw)
    pg.screenshot(path="/tmp/pl/dialog.png")
    check("dialog fits viewport height", pg.evaluate("()=>document.querySelector('#modal .card').getBoundingClientRect().bottom<=window.innerHeight+1"))
    pg.click("#modal [data-act='close']")
    check("close button still closes dialog", not pg.is_visible("#modal"))
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
