"""Smoke test całego stacku z deploy/docker-compose.yml (uruchamiany w GitHub Actions)."""
import asyncio
import json
import sys
import time
import urllib.request

import websockets

BASE = "http://127.0.0.1:47821"
PASSWORD = "zmien-to-haslo"
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail else ""), flush=True)
    if not ok:
        failures.append(name)


def request(path, method="GET", body=None, cookie=None):
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(BASE + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def wait_ready():
    for _ in range(90):
        try:
            if request("/api/auth/me")[0] == 200:
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    return False


async def vnc_handshake(cookie):
    headers = {"Cookie": cookie} if cookie else {}
    try:
        async with websockets.connect("ws://127.0.0.1:47821/novnc/websockify", additional_headers=headers,
                                      subprotocols=["binary"], open_timeout=10) as ws:
            data = await asyncio.wait_for(ws.recv(), 10)
            return True, data[:12]
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def main():
    check("stack ready", wait_ready())
    status, headers, _ = request("/api/auth/login", "POST", {"password": PASSWORD})
    check("panel login", status == 200, str(status))
    cookie = headers["Set-Cookie"].split(";")[0]

    check("status api", request("/api/status", cookie=cookie)[0] == 200)
    check("novnc page", request("/novnc/vnc.html", cookie=cookie)[0] == 200)
    check("novnc page needs auth", request("/novnc/vnc.html")[0] == 401)

    ok, info = asyncio.run(vnc_handshake(None))
    check("vnc websocket needs auth", not ok, str(info))
    ok, info = asyncio.run(vnc_handshake(cookie))
    check("vnc handshake (RFB)", ok and isinstance(info, bytes) and info.startswith(b"RFB"), repr(info))

    # Start logowania: Chrome powinien wystartować i dojść do strony Google
    status, _, body = request("/api/google/login/start", "POST", {}, cookie=cookie)
    print("login start:", status, body[:300], flush=True)
    state = None
    for _ in range(45):
        time.sleep(2)
        st = json.loads(request("/api/google/login/status", cookie=cookie)[2])
        state = st.get("state")
        if state not in ("starting",):
            break
    print("login status:", st, flush=True)
    check("chrome reached google login", state == "waiting_login", str(st))

    ok, info = asyncio.run(vnc_handshake(cookie))
    check("vnc handshake while chrome runs", ok and isinstance(info, bytes) and info.startswith(b"RFB"), repr(info))

    request("/api/google/login/cancel", "POST", {}, cookie=cookie)
    print("FAILURES:", failures or "none", flush=True)
    sys.exit(1 if failures else 0)


main()
