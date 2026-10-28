import json, time
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4584"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
def open_group(pg, name):
    h=pg.locator(f"#nav .grphead:has-text('{name}')")
    if h.get_attribute("aria-expanded")!="true": h.click(); pg.wait_for_timeout(200)
def login(b, user, pw):
    ctx=b.new_context(viewport={"width":1280,"height":900}); pg=ctx.new_page()
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu",user); pg.fill("#lp",pw); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    return pg
def go(pg, group, item):
    if pg.is_visible("#modal"): pg.click("#modal [data-act='close']"); pg.wait_for_timeout(200)
    open_group(pg, group); pg.click(f"#nav button:has-text('{item}')"); pg.wait_for_timeout(400)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    admin=login(b,"admin","Admin@Test1")
    u=admin.evaluate("""async()=>{const j=async(m,url,body)=>{const r=await fetch(url,{method:m,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}); return {s:r.status,j:await r.json().catch(()=>null)};};
      const t=Date.now()%100000; const a=await j('POST','/api/users',{username:'asg'+t,name:'مسئول وظیفه',role:'پرسنل',password:'AsgPass123'});
      const c=await j('POST','/api/users',{username:'rjc'+t,name:'گیرنده رد',role:'پرسنل',password:'RjcPass123'});
      return {asg:'asg'+t, asgId:a.j.id, rjc:'rjc'+t, rjcId:c.j.id};}""")
    # ---- tasks: assign, assignee changes status, reports progress, assigner sees it but cannot change status
    admin.evaluate("""async()=>{await fetch('/api/tasks',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'تهیه گزارش آزمون',description:'شرح کامل کار آزمون',expectedResult:'فایل گزارش آماده شود',priority:'زیاد',assigneeId:%d,dueDate:'2026-01-01'})});}""" % u["asgId"])
    go(admin,"اتوماسیون اداری","کارها و وظایف")
    admin.wait_for_selector("#tkBody", state="attached"); admin.wait_for_timeout(400)
    check("task listed for the assigner with overdue mark", "تهیه گزارش آزمون" in admin.inner_text("#tkBody") and "عقب‌افتاده" in admin.inner_text("#tkBody"), admin.inner_text("#tkBody")[:200])
    admin.click("#tkBody tr:has-text('تهیه گزارش آزمون') [data-act='view-task']"); admin.wait_for_selector("#modal h3")
    check("assigner sees full detail text", "شرح کامل کار آزمون" in admin.inner_text("#modal") and "فایل گزارش آماده شود" in admin.inner_text("#modal"))
    check("assigner has no status buttons", admin.locator("#modal [data-act='task-status']").count()==0)
    admin.click("#modal [data-act='close']")
    asg=login(b,u["asg"],"AsgPass123")
    go(asg,"اتوماسیون اداری","کارها و وظایف"); asg.wait_for_selector("#tkBody", state="attached"); asg.wait_for_timeout(400)
    asg.click("#tkBody tr:has-text('تهیه گزارش آزمون') [data-act='view-task']"); asg.wait_for_selector("#modal h3")
    asg.click("#modal [data-act='task-status'][data-v='doing']"); asg.wait_for_timeout(500)
    check("assignee changes status to doing", "در حال انجام" in asg.inner_text("#modal"), asg.inner_text("#modal")[:200])
    asg.fill("#tp-note","گزارش نیمه‌کاره آماده شد"); asg.click("[data-act='task-progress']"); asg.wait_for_timeout(500)
    check("progress report saved and shown", "گزارش نیمه‌کاره آماده شد" in asg.inner_text("#modal"))
    asg.click("#modal [data-act='close']")
    admin.click("#tkBody tr:has-text('تهیه گزارش آزمون') [data-act='view-task']"); admin.wait_for_selector("#modal h3")
    check("assigner sees the progress report", "گزارش نیمه‌کاره آماده شد" in admin.inner_text("#modal"))
    # ---- notice with an attachment, read by a second user
    go(admin,"اتوماسیون اداری","تابلو اعلانات"); admin.wait_for_selector("#annBody", state="attached")
    admin.click("[data-act='add-announcement']"); admin.wait_for_selector("#anForm")
    admin.fill("#an-title","اطلاعیه با پیوست"); admin.fill("#an-body","متن اطلاعیه")
    open('/tmp/notice.pdf','wb').write(b'%PDF-1.4 notice')
    admin.set_input_files("#an-files", "/tmp/notice.pdf")
    admin.click("#anForm button[type=submit]"); admin.wait_for_timeout(800)
    check("notice with attachment published", "اطلاعیه با پیوست" in admin.inner_text("#annBody") and "notice.pdf" in admin.inner_text("#annBody"), admin.inner_text("#annBody")[:200])
    # ---- letter rejected by the receiver
    go(admin,"اتوماسیون اداری","نامه‌ها"); admin.wait_for_selector("#lBody", state="attached")
    admin.click("button:has-text('نامه جدید')"); admin.wait_for_selector("#lForm")
    admin.fill("#l-subject","نامه رد شدنی"); admin.locator("#l-rid").evaluate("(e,v)=>{e.value=v;e.dispatchEvent(new Event('change'))}", str(u["rjcId"]))
    admin.click("#lForm button[type=submit]"); admin.wait_for_timeout(700)
    if admin.is_visible("#modal"): admin.click("#modal [data-act='close']")
    rjc=login(b,u["rjc"],"RjcPass123")
    go(rjc,"اتوماسیون اداری","نامه‌ها"); rjc.wait_for_selector("#lBody", state="attached"); rjc.wait_for_timeout(400)
    rjc.click("#lBody tr:has-text('نامه رد شدنی') button"); rjc.wait_for_selector("#modal h3")
    rjc.click("#modal [data-v='receive']"); rjc.wait_for_timeout(400)
    rjc.click("#modal [data-act='lact'][data-v='reject']"); rjc.wait_for_timeout(500)
    check("letter rejected by receiver", "رد شده" in rjc.inner_text("#lBody"), rjc.inner_text("#lBody")[:200])
    # ---- mission request through the leave page
    go(admin,"اتوماسیون اداری","مرخصی و مأموریت")
    admin.evaluate("""async()=>{const p=await (await fetch('/api/personnel',{credentials:'same-origin'})).json(); if(!p.items.length) await fetch('/api/personnel',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstName:'مأموریت',lastName:'تست',nationalId:'0098765434',personnelCode:'MS'+Date.now()%100000,status:'active'})});}""")
    admin.click("[data-act='add-leave']"); admin.wait_for_selector("#lvForm")
    admin.locator("#lv-k").evaluate("(e)=>{e.value='مأموریت'; e.dispatchEvent(new Event('change'))}")
    admin.fill("#lv-dest","ورامین"); admin.locator("#lv-p").evaluate("(e)=>{e.selectedIndex=1; e.dispatchEvent(new Event('change'))}")
    admin.locator("#lv-start").fill("۱۴۰۵/۰۷/۱۰"); admin.locator("#lv-end").fill("۱۴۰۵/۰۷/۱۱")
    admin.click("#lvForm button[type=submit]"); admin.wait_for_timeout(700)
    check("mission request listed with its type", "مأموریت" in admin.inner_text("#lvBody"), admin.inner_text("#lvBody")[:200])
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
