import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4510"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    check("dark theme on first load", pg.evaluate("()=>document.body.dataset.theme")=="dark", pg.evaluate("()=>document.body.dataset.theme"))
    order=pg.evaluate("""()=>[...document.querySelectorAll('#nav > button, #nav > .navgrp > .grphead')].map(x=>x.textContent.replace('▾','').trim())""")
    print("ORDER:", order)
    want=['داشبورد','پروفایل','اتوماسیون اداری','مدیریت سیستم','اطلاعات پایه','ترابری و اداری رانندگان','ایمنی و بهداشت','سرویس‌های ثابت','گزارشات']
    check("sidebar order", [x for x in order if x in want]==want, order)
    opened=pg.evaluate("()=>[...document.querySelectorAll('#nav .navgrp .grphead')].map(h=>h.getAttribute('aria-expanded'))")
    check("all groups closed on first load", all(v=='false' for v in opened), opened)
    pg.click("#nav .grphead:has-text('اطلاعات پایه')"); pg.wait_for_timeout(300)
    check("clicking a group opens it", pg.get_attribute("#nav .grphead:has-text('اطلاعات پایه')","aria-expanded")=="true")
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
