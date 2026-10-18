"""Google account login service.

Runs Chrome on a virtual display (visible through noVNC) and, in a single browser session:
  1. waits for sign-in at https://accounts.google.com/EmbeddedSetup and captures the `oauth_token` cookie,
  2. opens the E2EE key unlock page (Find Hub) and captures `vaultKeys`
     once the Android phone's screen lock has been entered.

The result (oauth_token, e-mail, vaultKeys) is fetched by the `app` service via GET /result - once only.
The service is not exposed publicly; only `app` talks to it over the Docker network.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

import undetected_chromedriver as uc
from aiohttp import web
from selenium.common.exceptions import NoAlertPresentException, WebDriverException
from selenium.webdriver.common.keys import Keys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("login")

LOGIN_TIMEOUT = 15 * 60
CHROME_LANG = os.getenv("CHROME_LANG", "en")
WIDTH = int(os.getenv("SCREEN_WIDTH", "1280"))
HEIGHT = int(os.getenv("SCREEN_HEIGHT", "860"))
# Chrome refuses windows narrower than ~500 px, so that is the "phone" layout.
MIN_WINDOW_WIDTH = 500
# x11vnc (restarted by entrypoint.sh) exports only this region of the screen.
VNC_CLIP_FILE = "/tmp/vnc_clip"
SPECIAL_KEYS = {"enter": Keys.ENTER, "tab": Keys.TAB, "backspace": Keys.BACKSPACE}


def _set_vnc_clip(width: int, height: int) -> None:
    """Show only the Chrome window in noVNC.

    The running x11vnc is reconfigured through its remote-control interface, so noVNC just gets a
    framebuffer resize and stays connected. The file keeps the setting if x11vnc ever restarts.
    """
    geometry = f"{width}x{height}+0+0"
    try:
        with open(VNC_CLIP_FILE, "w") as fh:
            fh.write(geometry)
        result = subprocess.run(
            ["x11vnc", "-display", os.getenv("DISPLAY", ":99"), "-sync", "-R", f"clip:{geometry}"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            log.warning("x11vnc remote clip failed: %s", (result.stderr or result.stdout).strip()[-200:])
        else:
            log.info("VNC clip set to %s", geometry)
    except Exception:  # noqa: BLE001
        log.warning("Could not apply the VNC clip region")

# The key unlock page calls window.mm.* (the Find Hub Android app interface).
# We redirect those calls to alert(), which Selenium reads.
MM_SCRIPT = """
window.mm = {
  setVaultSharedKeys: function(str, vaultKeys) {
    alert(JSON.stringify({ method: 'setVaultSharedKeys', str: str, vaultKeys: vaultKeys }));
  },
  closeView: function() {
    alert(JSON.stringify({ method: 'closeView' }));
  }
};
"""


class Cancelled(Exception):
    pass


class LoginJob:
    def __init__(self, security_url: str, lang: str | None = None, width: int | None = None,
                 height: int | None = None):
        self.security_url = security_url
        self.lang = lang or CHROME_LANG
        self.width = max(MIN_WINDOW_WIDTH, min(WIDTH, int(width or WIDTH)))
        self.height = max(500, min(HEIGHT, int(height or HEIGHT)))
        self._lock = threading.Lock()  # one WebDriver command at a time (job thread + /type)
        self.state = "starting"
        self.message = "Starting the browser…"
        self.error: str | None = None
        self.result: dict | None = None
        self.started_at = time.time()
        self._cancel = threading.Event()
        self._driver = None
        self._profile_dir = tempfile.mkdtemp(prefix="chrome-profile-")
        self.thread = threading.Thread(target=self._run, daemon=True)

    # --- API -------------------------------------------------------------------------------
    def start(self) -> None:
        self.thread.start()

    def cancel(self) -> None:
        self._cancel.set()
        self._quit()

    def type_text(self, text: str, key: str | None) -> None:
        """Types into the focused field of the sign-in page (helps on phones, where noVNC typing is clumsy)."""
        with self._lock:
            if self._driver is None or self.finished:
                raise RuntimeError("The browser is not running")
            element = self._driver.switch_to.active_element
            if text:
                element.send_keys(text)
            if key:
                element.send_keys(SPECIAL_KEYS[key])

    @property
    def finished(self) -> bool:
        return self.state in ("done", "error", "cancelled")

    def public_status(self) -> dict:
        return {
            "state": self.state,
            "message": self.message,
            "error": self.error,
            "started_at": self.started_at,
            "has_result": self.result is not None,
        }

    # --- login flow ------------------------------------------------------------------------
    def _set(self, state: str, message: str) -> None:
        self.state, self.message = state, message
        log.info("[%s] %s", state, message)

    def _run(self) -> None:
        try:
            _set_vnc_clip(self.width, self.height)
            self._driver = _create_driver(self._profile_dir, self.lang, self.width, self.height)
            driver = self._driver
            # Inject the window.mm interface into every loaded page.
            try:
                driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": MM_SCRIPT})
            except Exception:  # noqa: BLE001
                log.warning("CDP addScriptToEvaluateOnNewDocument unavailable, falling back to execute_script")

            # Step 1: Google account -> oauth_token
            driver.get("https://accounts.google.com/EmbeddedSetup")
            self._set("waiting_login", "Sign in to your Google account in the window below (including 2FA, if enabled).")
            oauth_token = self._wait(lambda: _cookie(driver, "oauth_token"))
            email = _extract_email(driver)
            log.info("Captured oauth_token (e-mail: %s)", email or "unknown")

            # Step 2: session on accounts.google.com (usually already active after step 1)
            self._set("waiting_account", "Confirming the Google session… (if a sign-in page appears, sign in again)")
            driver.get("https://accounts.google.com/")
            self._wait(lambda: "myaccount.google.com" in (driver.current_url or ""))

            # Step 3: unlock the E2EE keys with the phone's screen lock
            self._set(
                "waiting_pin",
                "Enter the screen lock (PIN / pattern / password) of your Android phone - "
                "this unlocks the encryption keys for tag locations.",
            )
            driver.get(self.security_url)
            try:
                driver.execute_script(MM_SCRIPT)
            except Exception:  # noqa: BLE001
                pass
            vault_keys = self._wait_for_vault_keys(driver)

            self.result = {"oauth_token": oauth_token, "email": email, "vault_keys": vault_keys}
            self._set("done", "Done - keys captured.")
        except Cancelled:
            self._set("cancelled", "Login cancelled.")
        except Exception as exc:  # noqa: BLE001
            log.exception("Login failed")
            self.error = str(exc).splitlines()[0][:300] if str(exc) else exc.__class__.__name__
            self._set("error", "Login failed.")
        finally:
            self._quit()
            shutil.rmtree(self._profile_dir, ignore_errors=True)

    def _wait(self, predicate, timeout: float = LOGIN_TIMEOUT):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._cancel.is_set():
                raise Cancelled()
            try:
                with self._lock:
                    value = predicate()
            except WebDriverException as exc:
                if _is_session_lost(exc):
                    raise RuntimeError("The Chrome window was closed.") from exc
                value = None
            if value:
                return value
            time.sleep(0.5)
        raise TimeoutError("Login timed out.")

    def _wait_for_vault_keys(self, driver) -> str:
        deadline = time.time() + LOGIN_TIMEOUT
        while time.time() < deadline:
            if self._cancel.is_set():
                raise Cancelled()
            try:
                with self._lock:
                    alert = driver.switch_to.alert
                    text = alert.text
                    alert.accept()
            except NoAlertPresentException:
                time.sleep(0.5)
                continue
            except WebDriverException as exc:
                if _is_session_lost(exc):
                    raise RuntimeError("The Chrome window was closed.") from exc
                time.sleep(0.5)
                continue
            try:
                data = json.loads(text)
            except (TypeError, json.JSONDecodeError):
                continue
            if data.get("method") == "setVaultSharedKeys" and isinstance(data.get("vaultKeys"), str):
                return data["vaultKeys"]
            if data.get("method") == "closeView":
                raise RuntimeError(
                    "The key page closed without returning the keys. Make sure Find Hub with "
                    "offline finding is enabled on your Android phone."
                )
        raise TimeoutError("Timed out waiting for the keys to be unlocked.")

    def _quit(self) -> None:
        driver, self._driver = self._driver, None
        if driver is not None:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass


# --- Chrome ----------------------------------------------------------------------------------

def _chrome_binary() -> str:
    for candidate in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
        path = shutil.which(candidate)
        if path:
            return path
    raise RuntimeError("Chrome/Chromium not found in the container.")


def _chrome_major(binary: str) -> int | None:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=20).stdout
    except Exception:  # noqa: BLE001
        return None
    match = re.search(r"(\d+)\.\d+\.\d+", out)
    return int(match.group(1)) if match else None


def _create_driver(profile_dir: str, lang: str, width: int, height: int):
    binary = _chrome_binary()
    options = uc.ChromeOptions()
    for arg in (
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        f"--lang={lang}",
        "--window-position=0,0",
        f"--window-size={width},{height}",
        "--disable-features=Translate,TranslateUI",
        "--disable-notifications",
    ):
        options.add_argument(arg)
    options.add_experimental_option("prefs", {
        "intl.accept_languages": lang,
        "translate": {"enabled": False},
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
    })

    kwargs = {
        "options": options,
        "browser_executable_path": binary,
        "user_data_dir": profile_dir,
        "version_main": _chrome_major(binary),
    }
    # Chromium (arm64) ships its own chromedriver package; on amd64 uc downloads a matching one itself.
    # uc patches the driver file in place, so we copy it to the home directory (/usr/bin is read-only).
    system_driver = shutil.which("chromedriver")
    if system_driver and "chromium" in binary:
        local_driver = os.path.expanduser("~/chromedriver")
        shutil.copy2(system_driver, local_driver)
        os.chmod(local_driver, 0o755)
        kwargs["driver_executable_path"] = local_driver
    log.info("Starting Chrome: %s (version %s)", binary, kwargs["version_main"])
    return uc.Chrome(**kwargs)


def _cookie(driver, name: str) -> str | None:
    cookie = driver.get_cookie(name)
    if cookie and isinstance(cookie.get("value"), str) and cookie["value"]:
        return cookie["value"]
    return None


def _extract_email(driver) -> str | None:
    try:
        value = driver.execute_script(
            "var el = document.querySelector('[data-email]') || document.querySelector('#profileIdentifier');"
            "return el ? (el.dataset.email || el.textContent) : null;"
        )
        if isinstance(value, str) and "@" in value:
            return value.strip()
    except Exception:  # noqa: BLE001
        pass
    return None


def _is_session_lost(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(s in text for s in ("no such window", "invalid session id", "target window already closed",
                                   "chrome not reachable", "disconnected"))


# --- HTTP ------------------------------------------------------------------------------------

_job: LoginJob | None = None
_lock = threading.Lock()


async def start(request: web.Request) -> web.Response:
    global _job
    body = await request.json()
    security_url = body.get("security_url")
    if not isinstance(security_url, str) or not security_url.startswith("https://accounts.google.com/"):
        return web.json_response({"error": "invalid security_url"}, status=400)
    with _lock:
        if _job is not None and not _job.finished:
            _job.cancel()
            _job.thread.join(timeout=10)
        lang = body.get("lang")
        if not (isinstance(lang, str) and re.fullmatch(r"[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?", lang)):
            lang = None
        width = body.get("width") if isinstance(body.get("width"), int) else None
        height = body.get("height") if isinstance(body.get("height"), int) else None
        _job = LoginJob(security_url, lang, width, height)
        _job.start()
    return web.json_response(_job.public_status())


async def status(_: web.Request) -> web.Response:
    if _job is None:
        return web.json_response({"state": "idle", "message": "", "error": None, "has_result": False})
    return web.json_response(_job.public_status())


async def result(_: web.Request) -> web.Response:
    # The result is returned once - then it is removed from memory.
    if _job is None or _job.result is None:
        return web.json_response({"error": "no result"}, status=404)
    data, _job.result = _job.result, None
    return web.json_response(data)


async def type_text(request: web.Request) -> web.Response:
    body = await request.json()
    text = body.get("text") or ""
    key = body.get("key")
    if not isinstance(text, str) or len(text) > 500 or (key is not None and key not in SPECIAL_KEYS):
        return web.json_response({"error": "invalid input"}, status=400)
    if _job is None:
        return web.json_response({"error": "no login in progress"}, status=409)
    try:
        await asyncio.to_thread(_job.type_text, text, key)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": str(exc).splitlines()[0][:200]}, status=409)
    return web.json_response({"ok": True})


async def cancel(_: web.Request) -> web.Response:
    if _job is not None and not _job.finished:
        _job.cancel()
    return web.json_response({"ok": True})


async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def main() -> None:
    app = web.Application()
    app.add_routes([
        web.post("/start", start),
        web.get("/status", status),
        web.get("/result", result),
        web.post("/cancel", cancel),
        web.post("/type", type_text),
        web.get("/health", health),
    ])
    web.run_app(app, host="0.0.0.0", port=8001, access_log=None)


if __name__ == "__main__":
    main()
