from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1366,"height":860})
    pg.goto("http://127.0.0.1:4810/"); pg.wait_for_selector("#loginBtn")
    print(pg.evaluate("""()=>{const q=s=>{const e=document.querySelector(s); if(!e) return s+': none'; const r=e.getBoundingClientRect(), c=getComputedStyle(e); return s+' w='+Math.round(r.width)+' disp='+c.display+' maxw='+c.maxWidth+' justify='+c.justifyContent+' pad='+c.padding; };
      return [q('body'),q('#login'),q('.lg-top'),q('.lg-wrap'),q('.lg-hero'),q('.lg-panel'),q('.login-box')].join('\\n');}"""))
    b.close()
