"""Real-browser test: panel -> Connect Google account -> noVNC in an iframe, on desktop and on a phone.

Saves screenshots to shots/ (uploaded as a CI artifact).
"""
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:47821"
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail else ""), flush=True)
    if not ok:
        failures.append(name)


def open_connect_dialog(page):
    page.goto(BASE)
    page.fill("#login-password", "change-me")
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#app-view:not([hidden])")
    page.click("#btn-settings")
    page.click("#settings-connect")
    page.wait_for_timeout(15000)


def vnc_state(page):
    return page.evaluate(
        """() => {
            const d = document.querySelector('#vnc-frame').contentDocument;
            const canvas = d && d.querySelector('#noVNC_container canvas');
            return {
                connected: !!d && d.documentElement.classList.contains('noVNC_connected'),
                fb: canvas ? [canvas.width, canvas.height] : null,
            };
        }"""
    )


with sync_playwright() as p:
    browser = p.chromium.launch()

    # --- desktop -------------------------------------------------------------------------------
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    open_connect_dialog(page)
    page.screenshot(path="shots/connect-desktop.png")
    st = vnc_state(page)
    check("desktop: noVNC connected", st["connected"], str(st))
    check("desktop: full-width login window", bool(st["fb"]) and st["fb"][0] >= 1200, str(st["fb"]))
    page.close()

    # --- phone ---------------------------------------------------------------------------------
    phone = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                is_mobile=True, has_touch=True)
    page = phone.new_page()
    open_connect_dialog(page)
    st = vnc_state(page)
    check("phone: noVNC connected", st["connected"], str(st))
    check("phone: narrow login window (VNC clipped to Chrome)", bool(st["fb"]) and st["fb"][0] <= 520, str(st["fb"]))
    # The Google e-mail field has focus on load; type into it through the server-side typing bar.
    status = page.evaluate(
        """async () => (await fetch('/api/google/login/type', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text: 'findhub.smoke@example.com'})})).status"""
    )
    check("phone: typing endpoint", status == 200, str(status))
    page.wait_for_timeout(2500)
    page.screenshot(path="shots/connect-phone.png")
    page.close()

    print("\n".join(logs[-20:]))
    browser.close()

print("BROWSER FAILURES:", failures or "none")
sys.exit(1 if failures else 0)
