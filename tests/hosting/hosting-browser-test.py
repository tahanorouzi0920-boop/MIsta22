import json
from playwright.sync_api import sync_playwright
EXE="/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
out={}
def login(base):
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path=EXE,args=["--no-sandbox"]); pg=b.new_page()
        resp=[]; pg.on("response", lambda r: resp.append((r.status, r.url.split(base)[-1])) if "/api/" in r.url else None)
        pg.goto(base+"/"); pg.wait_for_timeout(500)
        pg.fill("#lu","admin"); pg.fill("#lp","Secret@123"); pg.click("#loginBtn"); pg.wait_for_timeout(1200)
        app_visible=pg.is_visible("#app"); msg=pg.inner_text("#login-e")
        if app_visible:
            pg.reload(); pg.wait_for_timeout(1200)
            me_after_reload=pg.is_visible("#app")
        else: me_after_reload=None
        b.close()
        return {"logged_in":app_visible,"login_message":msg,"api_responses":resp[:6],"still_logged_in_after_reload":me_after_reload}
out["A_same_origin_backend_4061"]=login("http://127.0.0.1:4061")
out["B_static_only_4070"]=login("http://127.0.0.1:4070")
out["C_proxy_rule_4071"]=login("http://127.0.0.1:4071")
print(json.dumps(out,ensure_ascii=False,indent=1))
