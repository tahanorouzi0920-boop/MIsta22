import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4584"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
def open_group(pg, name):
    h=pg.locator(f"#nav .grphead:has-text('{name}')")
    if h.get_attribute("aria-expanded")!="true": h.click(); pg.wait_for_timeout(200)
def login(b, user, pw):
    ctx=b.new_context(viewport={"width":1280,"height":900}); pg=ctx.new_page(); errs=R["errors"]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu",user); pg.fill("#lp",pw); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    return pg
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    admin=login(b,"admin","Admin@Test1")
    setup=admin.evaluate("""async()=>{const j=async(m,u,body)=>{const r=await fetch(u,{method:m,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}); return {s:r.status,j:await r.json().catch(()=>null)};};
      const d=await j('POST','/api/departments',{name:'واحد آزمون '+Date.now()}); const dep=d.j.id;
      const m=await j('POST','/api/users',{username:'memb'+Date.now()%100000,name:'عضو آزمون',role:'پرسنل',password:'MembPass123',departmentId:dep});
      const o=await j('POST','/api/users',{username:'outs'+Date.now()%100000,name:'بیرون آزمون',role:'پرسنل',password:'OutsPass123'});
      const r=await j('POST','/api/users',{username:'rcv'+Date.now()%100000,name:'گیرنده آزمون',role:'پرسنل',password:'RcvPass123'});
      return {dep, member:m.j.username, outsider:o.j.username, receiver:r.j.username, memberId:m.j.id, receiverId:r.j.id};}""")
    check("setup users and unit", setup["dep"] and setup["member"] and setup["receiver"], setup)
    # notice to one unit, read by its member; the outsider does not see it
    open_group(admin, 'اتوماسیون اداری')
    admin.click("#nav button[data-page='announcements']"); admin.wait_for_selector("#annBody", state="attached")
    admin.click("[data-act='add-announcement']"); admin.wait_for_selector("#anForm")
    admin.fill("#an-title","اطلاعیه واحد آزمون"); admin.fill("#an-body","فقط برای واحد آزمون")
    admin.locator("#an-dept").evaluate("(e,v)=>{e.value=v; e.dispatchEvent(new Event('change'))}", str(setup["dep"]))
    admin.set_input_files("#an-files", "/tmp/doc.pdf") if False else None
    admin.click("#anForm button[type=submit]"); admin.wait_for_timeout(800)
    check("notice published to the unit", "اطلاعیه واحد آزمون" in admin.inner_text("#annBody"))
    member=login(b, setup["member"], "MembPass123")
    open_group(member, 'اتوماسیون اداری')
    member.click("#nav button[data-page='announcements']"); member.wait_for_selector("#annBody", state="attached"); member.wait_for_timeout(600)
    check("member sees the unit notice", "اطلاعیه واحد آزمون" in member.inner_text("#annBody"))
    member.click("#annBody [data-act='ann-read']"); member.wait_for_timeout(500)
    check("member read is recorded", "شما مشاهده کرده‌اید" in member.inner_text("#annBody"))
    admin.click("#nav button[data-page='announcements']"); admin.wait_for_timeout(600)
    check("admin sees the viewer count", "مشاهده‌کنندگان: ۱ از ۱" in admin.inner_text("#annBody"), admin.inner_text("#annBody")[:200])
    outsider=login(b, setup["outsider"], "OutsPass123")
    open_group(outsider, 'اتوماسیون اداری')
    outsider.click("#nav button[data-page='announcements']"); outsider.wait_for_selector("#annBody", state="attached"); outsider.wait_for_timeout(600)
    check("outsider does not see the unit notice", "اطلاعیه واحد آزمون" not in outsider.inner_text("#annBody"))
    # letters: admin sends to the receiver; receiver receives, returns; admin resends; receiver approves
    open_group(admin, 'اتوماسیون اداری')
    admin.click("#nav button[data-page='letters']"); admin.wait_for_selector("#lBody", state="attached"); admin.wait_for_timeout(400)
    admin.click("button:has-text('نامه جدید')"); admin.wait_for_selector("#lForm")
    admin.fill("#l-subject","نامه آزمون بازگشت"); admin.select_option("#l-rid", label="گیرنده آزمون") if admin.is_visible("#l-rid") else admin.locator("#l-rid").evaluate("(e,v)=>{e.value=v;e.dispatchEvent(new Event('change'))}", str(setup["receiverId"]))
    admin.click("#lForm button[type=submit]"); admin.wait_for_timeout(700)
    if admin.is_visible("#modal"): admin.click("#modal [data-act='close']")
    rcv=login(b, setup["receiver"], "RcvPass123")
    open_group(rcv, 'اتوماسیون اداری')
    rcv.click("#nav button[data-page='letters']"); rcv.wait_for_selector("#lBody", state="attached"); rcv.wait_for_timeout(500)
    rcv.click("#lBody tr:has-text('نامه آزمون بازگشت') button"); rcv.wait_for_selector("#modal h3")
    rcv.click("#modal [data-v='receive']"); rcv.wait_for_timeout(500)
    rcv.click("#modal [data-act='lreturn']"); rcv.wait_for_selector("#lr-note")
    rcv.fill("#lr-note","لطفاً شماره را اصلاح کنید"); rcv.click("#lrForm button[type=submit]"); rcv.wait_for_timeout(600)
    check("receiver returned the letter for correction", "بازگردانده" in rcv.inner_text("#lBody"), rcv.inner_text("#lBody")[:200])
    admin.click("#nav button[data-page='letters']"); admin.wait_for_timeout(500)
    admin.click("#lBody tr:has-text('نامه آزمون بازگشت') button"); admin.wait_for_selector("#modal h3")
    admin.click("#modal [data-v='resend']"); admin.wait_for_timeout(600)
    check("sender resent the corrected letter", "ارسال‌شده" in admin.inner_text("#lBody") and "بازگردانده" not in admin.inner_text("#lBody"), admin.inner_text("#lBody")[:200])
    rcv.reload(); rcv.wait_for_selector("#app:not(.hidden)")
    open_group(rcv, 'اتوماسیون اداری')
    rcv.click("#nav button[data-page='letters']"); rcv.wait_for_selector("#lBody", state="attached"); rcv.wait_for_timeout(500)
    rcv.click("#lBody tr:has-text('نامه آزمون بازگشت') button"); rcv.wait_for_selector("#modal h3")
    rcv.click("#modal [data-v='approve']"); rcv.wait_for_timeout(600)
    check("receiver approved the resent letter", "تأییدشده" in rcv.inner_text("#lBody"), rcv.inner_text("#lBody")[:200])
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
