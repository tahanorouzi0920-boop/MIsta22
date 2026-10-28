import json, time
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4411"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"])
    admin=b.new_page(viewport={"width":1280,"height":900}); admin.on("pageerror", lambda e: R["errors"].append(str(e)))
    admin.goto(B+"/"); admin.fill("#lu","admin"); admin.fill("#lp","Admin@Test1"); admin.click("#loginBtn"); admin.wait_for_selector("#app:not(.hidden)")
    ids=admin.evaluate("""async()=>{const plans=(await (await fetch('/api/service-plans',{credentials:'same-origin'})).json()).items; const plan=plans.find(p=>p.code==='SMP-P1');
      const drivers=(await (await fetch('/api/drivers',{credentials:'same-origin'})).json()).items; const d=drivers.find(x=>x.nid==='0012345679');
      const t=await fetch('/api/service-plans/'+plan.id+'/trips',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({tripDate:'2026-10-05'})}); const tj=await t.json();
      await fetch('/api/trips/'+tj.id+'/status',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'approved'})});
      const st=await fetch('/api/trips/'+tj.id+'/start',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({driverId:d.id})});
      return {trip:tj.id, driver:d.id, start:st.status, plan:!!plan};}""")
    check("trip created, approved and started", ids["start"]==200 and ids["plan"], ids)
    admin.click("#nav button:has-text('مانیتورینگ سفر')"); admin.wait_for_timeout(700)
    admin.wait_for_timeout(500); admin.select_option("#mnDriver", value=str(ids["driver"]))
    admin.click("[data-act='driver-link']"); admin.wait_for_selector("#dl-url")
    link=admin.input_value("#dl-url")
    phone_ctx=b.new_context(geolocation={"latitude":35.7,"longitude":51.4,"accuracy":10}, permissions=["geolocation"], viewport={"width":390,"height":844})
    phone=phone_ctx.new_page(); phone.on("pageerror", lambda e: R["errors"].append("phone: "+str(e)))
    phone.goto(link); phone.click("#start")
    phone.wait_for_function("document.getElementById('status').textContent.includes('ارسال شد')", timeout=10000)
    check("phone sends during a started trip", True, phone.inner_text("#status"))
    admin.click("#modal [data-act='close']") if admin.is_visible("#modal") else None
    admin.click("#nav button:has-text('لیست سفرها')"); admin.wait_for_timeout(600)
    check("finish button shown for a started trip", admin.locator(f"[data-act='finish-trip'][data-id='{ids['trip']}']").count()==1)
    admin.evaluate(f"async()=>{{await fetch('/api/trips/{ids['trip']}/finish',{{method:'PUT',credentials:'same-origin'}});}}")
    admin.wait_for_timeout(300)
    trip_state=admin.evaluate(f"async()=>{{const t=(await (await fetch('/api/trips',{{credentials:'same-origin'}})).json()).items.find(x=>x.id=={ids['trip']}); return t.status;}}")
    check("finish from the trips list ends the trip", trip_state=="finished", trip_state)
    print("DEBUG trip_state:", trip_state, "| phone:", phone.inner_text("#status"), flush=True)
    phone.wait_for_function("document.getElementById('status').textContent.includes('متوقف')", timeout=40000)
    check("phone stops after the trip ends", True, phone.inner_text("#status"))
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
