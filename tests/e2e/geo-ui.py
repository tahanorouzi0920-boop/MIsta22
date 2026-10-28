import sys, json, time, urllib.request
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]
import os
EXE = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
R = {"checks": {}, "errors": []}
def check(name, cond, detail=None):
    R["checks"][name] = {"ok": bool(cond), "detail": detail}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.on("pageerror", lambda e: R["errors"].append("pageerror: " + str(e)))
    pg.on("response", lambda r: R["errors"].append("HTTP %d %s" % (r.status, r.url.replace(BASE, ""))) if r.status >= 400 else None)
    pg.goto(BASE + "/")
    pg.fill("#lu", "admin"); pg.fill("#lp", "Secret@123"); pg.click("#loginBtn")
    pg.wait_for_selector("#app:not(.hidden)", timeout=8000)

    # A: company create, provinces and dependent cities
    pg.click("#nav [data-page='companies']"); pg.wait_for_selector("#cBody")
    pg.click("[data-act='add-company']"); pg.wait_for_selector("#c-prov")
    provs = pg.eval_on_selector_all("#c-prov option", "els => els.map(e => e.value)")
    check("A1 31 provinces listed", len([v for v in provs if v]) == 31, len(provs))
    check("A2 city disabled before province", pg.is_disabled("#c-city"))
    pg.select_option("#c-prov", label="البرز"); pg.wait_for_timeout(150)
    cities = pg.eval_on_selector_all("#c-city option", "els => els.map(e => e.textContent.trim())")
    need = ["کرج", "فردیس", "هشتگرد", "نظرآباد"]
    check("A3 Alborz cities include کرج/فردیس/هشتگرد/نظرآباد", all(n in cities for n in need), {n: n in cities for n in need})
    check("A4 no Tehran city under Alborz", "ورامین" not in cities and "تهران" not in cities, cities[:8])
    check("A5 city enabled after province", not pg.is_disabled("#c-city"))
    pg.fill("#c-csearch", "هشت"); pg.wait_for_timeout(120)
    filtered = pg.eval_on_selector_all("#c-city option", "els => els.map(e => e.textContent.trim())")
    check("A6 city search filters list", "هشتگرد" in filtered and "کرج" not in filtered, filtered)
    pg.fill("#c-csearch", "")
    pg.select_option("#c-city", label="کرج")
    code = "GEO" + str(int(time.time()) % 100000)
    pg.fill("#c-name", "شرکت آزمون استان"); pg.fill("#c-code", code)
    pg.fill("#c-regdate", "۱۴۰۵/۰۱/۰۱"); pg.select_option("#c-type", "01")
    pg.fill("#c-mobile", "۰۹۱۲۱۱۱۲۲۳۳"); pg.fill("#c-addr", "کرج، خیابان آزمون")
    pg.click("#cForm button[type=submit]"); pg.wait_for_timeout(700)
    check("A7 company saved (modal closed)", pg.is_hidden("#modal"), None if pg.is_hidden("#modal") else pg.inner_text("#modal")[:200])

    # C: list shows saved province and city
    row = pg.inner_text("#cBody")
    check("C1 list row shows البرز and کرج", "البرز" in row and "کرج" in row, row[:160])

    # D: reopen for edit, selects restored
    pg.click("#cBody tr:has-text('شرکت آزمون استان') [data-act='edit-companies']"); pg.wait_for_selector("#c-prov")
    sp = pg.eval_on_selector("#c-prov", "e => e.options[e.selectedIndex] ? e.options[e.selectedIndex].textContent : ''")
    sc = pg.eval_on_selector("#c-city", "e => e.options[e.selectedIndex] ? e.options[e.selectedIndex].textContent : ''")
    check("D1 edit restores province البرز", sp == "البرز", sp)
    check("D2 edit restores city کرج", sc == "کرج", sc)

    # E: province change clears incompatible city
    pg.select_option("#c-prov", label="تهران"); pg.wait_for_timeout(150)
    tc = pg.eval_on_selector_all("#c-city option", "els => els.map(e => e.textContent.trim())")
    check("E1 Tehran cities offered, Alborz city not", "ورامین" in tc and "کرج" not in tc, tc[:6])
    cv = pg.eval_on_selector("#c-city", "e => e.value")
    check("E2 incompatible city cleared", cv == "", cv)
    pg.click("#modal [data-act='close']"); pg.wait_for_timeout(150)

    # F: driver residence form, from the dashboard shortcut
    pg.click("#nav [data-page='dashboard']"); pg.wait_for_selector("#kpis")
    pg.click("[data-act='qa-driver']"); pg.wait_for_selector("#d-prov")
    dprov = pg.eval_on_selector_all("#d-prov option", "els => els.map(e => e.value)")
    check("F1 driver province list has 31", len([v for v in dprov if v]) == 31, len(dprov))
    check("F2 driver city disabled until province", pg.is_disabled("#d-city"))
    pg.select_option("#d-prov", label="اصفهان"); pg.wait_for_timeout(150)
    dc = pg.eval_on_selector_all("#d-city option", "els => els.map(e => e.textContent.trim())")
    check("F3 driver cities are اصفهان's", "کاشان" in dc and "تهران" not in dc, dc[:6])
    pg.select_option("#d-city", label="کاشان")
    pg.fill("#d-first", "رضا"); pg.fill("#d-last", "کریمی"); pg.fill("#d-nid", "۰۰۹۸۷۶۵۴۳۴")
    pg.fill("#d-mob", "۰۹۱۲۱۲۳۰۰۰۰"); pg.fill("#d-addr", "کاشان، خیابان آزمون")
    pg.click("#dForm button[type=submit]"); pg.wait_for_timeout(700)
    check("F4 driver saved", pg.is_hidden("#modal"), None if pg.is_hidden("#modal") else pg.inner_text("#modal")[:200])

    # F5: edit form restores province/city for a saved driver (opened through the same form function)
    drv = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/api/drivers", headers={"Cookie": ""})).read().decode()) if False else None
    pg.evaluate("""async () => { const r = await fetch('/api/drivers', {credentials:'same-origin'}); const d = (await r.json()).items.find(x => x.nid === '0098765434'); openDriver(d); }""")
    pg.wait_for_selector("#d-prov")
    dp = pg.eval_on_selector("#d-prov", "e => e.options[e.selectedIndex] ? e.options[e.selectedIndex].textContent : ''")
    dcy = pg.eval_on_selector("#d-city", "e => e.options[e.selectedIndex] ? e.options[e.selectedIndex].textContent : ''")
    check("F5 driver edit restores اصفهان / کاشان", dp == "اصفهان" and dcy == "کاشان", [dp, dcy])
    pg.click("#modal [data-act='close']")

    # G: reports companies province and city filter
    pg.click("#nav [data-page='reports']"); pg.wait_for_selector("#rTabs")
    pg.click("#rTabs [data-v='companies']"); pg.wait_for_timeout(300)
    pg.select_option("#rProv", label="البرز"); pg.wait_for_timeout(200)
    rc = pg.eval_on_selector_all("#rCity option", "els => els.map(e => e.textContent.trim())")
    check("G1 report city list follows province", "کرج" in rc and "ورامین" not in rc, rc[:6])
    pg.select_option("#rCity", label="کرج"); pg.wait_for_timeout(300)
    body = pg.inner_text("#rBody")
    check("G2 report filtered by city shows saved company", "شرکت آزمون استان" in body, body[:160])

    b.close()
print(json.dumps(R, ensure_ascii=False, indent=1))
