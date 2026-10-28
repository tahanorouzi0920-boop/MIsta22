import json
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:4531"; R={"checks":{},"errors":[]}
def check(n,c,d=None): R["checks"][n]={"ok":bool(c),"detail":d}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.on("pageerror", lambda e: R["errors"].append(str(e)))
    pg.goto(B+"/"); pg.fill("#lu","admin"); pg.fill("#lp","Admin@Test1"); pg.click("#loginBtn"); pg.wait_for_selector("#app:not(.hidden)")
    ids=pg.evaluate("""async()=>{const cats=(await (await fetch('/api/finance/categories',{credentials:'same-origin'})).json()).items; const inc=cats.find(c=>c.kind==='income'&&c.active); const exp=cats.find(c=>c.kind==='expense'&&c.active);
      const rows=[[inc,500000,'2026-03-03'],[inc,700000,'2026-04-04'],[exp,120000,'2026-03-05']];
      for(const [c,a,d] of rows){await fetch('/api/finance',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:c.kind,categoryId:c.id,amount:a,entryDate:d})});}
      return rows.length;}""")
    check("three finance records created", ids==3)
    pg.click("#nav button[data-page='reports']"); pg.wait_for_timeout(500)
    pg.click("#rTabs [data-v='exports']"); pg.wait_for_timeout(500)
    check("export panel shown and table hidden", pg.is_visible("#rExport") and not pg.is_visible("#rHead"))
    pg.locator("#xpKind").evaluate("e=>{e.value='finance'; e.dispatchEvent(new Event('change'))}")
    # unfiltered download: all three rows
    with pg.expect_download() as dl:
        pg.click("[data-act='xp-download']")
    text=open(dl.value.path(),encoding='utf-8-sig').read()
    check("unfiltered CSV contains all three amounts", all(x in text for x in ['500000','700000','120000']), text)
    check("CSV has Persian headers", 'شماره سند' in text and 'مبلغ' in text)
    # filtered download: from 1405/01/01 (2026-03-21) keeps only the April entry
    pg.locator("#xpFrom").fill("۱۴۰۵/۰۱/۰۱")
    with pg.expect_download() as dl2:
        pg.click("[data-act='xp-download']")
    t2=open(dl2.value.path(),encoding='utf-8-sig').read()
    check("date filter removes earlier rows", '700000' in t2 and '500000' not in t2 and '120000' not in t2, t2)
    b.close()
print(json.dumps(R,ensure_ascii=False,indent=1))
