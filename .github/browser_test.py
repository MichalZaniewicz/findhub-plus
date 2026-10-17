"""Test w prawdziwej przeglądarce: panel -> Połącz konto Google -> noVNC w iframe. Zapisuje zrzuty ekranu."""
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:47821"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("websocket", lambda ws: logs.append(f"[ws] open {ws.url}"))

    page.goto(BASE)
    page.fill("#login-password", "zmien-to-haslo")
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#app-view:not([hidden])")
    page.click("#btn-settings")
    page.click("#settings-connect")
    page.wait_for_timeout(15000)
    page.screenshot(path="shots/connect-dialog.png")

    frame = page.frame_locator("#vnc-frame")
    status = frame.locator("#noVNC_status").inner_text(timeout=5000) if frame.locator("#noVNC_status").count() else ""
    connected = page.evaluate(
        "() => { const d = document.querySelector('#vnc-frame').contentDocument;"
        " return d && d.documentElement.classList.contains('noVNC_connected'); }"
    )
    print("noVNC status text:", repr(status))
    print("noVNC connected class:", connected)
    print("\n".join(logs))
    browser.close()
    sys.exit(0 if connected else 1)
