"""Serwis logowania kontem Google.

Uruchamia Chrome na wirtualnym ekranie (widocznym przez noVNC) i w jednej sesji przeglądarki:
  1. czeka na zalogowanie w https://accounts.google.com/EmbeddedSetup i przechwytuje cookie `oauth_token`,
  2. otwiera stronę odblokowania kluczy E2EE (Find Hub) i przechwytuje `vaultKeys`
     po podaniu blokady ekranu telefonu z Androidem.

Wynik (oauth_token, e-mail, vaultKeys) odbiera serwis `app` przez GET /result - jednorazowo.
Usługa nie jest wystawiona publicznie; rozmawia z nią tylko `app` w sieci Dockera.
"""

from __future__ import annotations

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("login")

LOGIN_TIMEOUT = 15 * 60
CHROME_LANG = os.getenv("CHROME_LANG", "pl")
WIDTH = int(os.getenv("SCREEN_WIDTH", "1280"))
HEIGHT = int(os.getenv("SCREEN_HEIGHT", "860"))

# Strona odblokowania kluczy woła window.mm.* (interfejs aplikacji Find Hub na Androidzie).
# Przekierowujemy te wywołania na alert(), który odczytuje Selenium.
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
    def __init__(self, security_url: str):
        self.security_url = security_url
        self.state = "starting"
        self.message = "Uruchamiam przeglądarkę…"
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

    # --- przebieg logowania ---------------------------------------------------------------
    def _set(self, state: str, message: str) -> None:
        self.state, self.message = state, message
        log.info("[%s] %s", state, message)

    def _run(self) -> None:
        try:
            self._driver = _create_driver(self._profile_dir)
            driver = self._driver
            # Interfejs window.mm wstrzykiwany do każdej ładowanej strony.
            try:
                driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": MM_SCRIPT})
            except Exception:  # noqa: BLE001
                log.warning("CDP addScriptToEvaluateOnNewDocument niedostępne, użyję execute_script")

            # Krok 1: konto Google -> oauth_token
            driver.get("https://accounts.google.com/EmbeddedSetup")
            self._set("waiting_login", "Zaloguj się na swoje konto Google w oknie poniżej (z 2FA, jeśli masz).")
            oauth_token = self._wait(lambda: _cookie(driver, "oauth_token"))
            email = _extract_email(driver)
            log.info("Przechwycono oauth_token (e-mail: %s)", email or "nieznany")

            # Krok 2: sesja na accounts.google.com (zwykle już aktywna po kroku 1)
            self._set("waiting_account", "Potwierdzam sesję Google… (jeśli pojawi się logowanie, zaloguj się ponownie)")
            driver.get("https://accounts.google.com/")
            self._wait(lambda: "myaccount.google.com" in (driver.current_url or ""))

            # Krok 3: odblokowanie kluczy E2EE blokadą ekranu telefonu
            self._set(
                "waiting_pin",
                "Podaj blokadę ekranu (PIN / wzór / hasło) swojego telefonu z Androidem - "
                "to odblokowuje klucze szyfrowania lokalizacji tagów.",
            )
            driver.get(self.security_url)
            try:
                driver.execute_script(MM_SCRIPT)
            except Exception:  # noqa: BLE001
                pass
            vault_keys = self._wait_for_vault_keys(driver)

            self.result = {"oauth_token": oauth_token, "email": email, "vault_keys": vault_keys}
            self._set("done", "Gotowe - klucze przechwycone.")
        except Cancelled:
            self._set("cancelled", "Logowanie anulowane.")
        except Exception as exc:  # noqa: BLE001
            log.exception("Logowanie nie powiodło się")
            self.error = str(exc).splitlines()[0][:300] if str(exc) else exc.__class__.__name__
            self._set("error", "Logowanie nie powiodło się.")
        finally:
            self._quit()
            shutil.rmtree(self._profile_dir, ignore_errors=True)

    def _wait(self, predicate, timeout: float = LOGIN_TIMEOUT):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._cancel.is_set():
                raise Cancelled()
            try:
                value = predicate()
            except WebDriverException as exc:
                if _is_session_lost(exc):
                    raise RuntimeError("Okno Chrome zostało zamknięte.") from exc
                value = None
            if value:
                return value
            time.sleep(0.5)
        raise TimeoutError("Upłynął limit czasu logowania.")

    def _wait_for_vault_keys(self, driver) -> str:
        deadline = time.time() + LOGIN_TIMEOUT
        while time.time() < deadline:
            if self._cancel.is_set():
                raise Cancelled()
            try:
                alert = driver.switch_to.alert
                text = alert.text
                alert.accept()
            except NoAlertPresentException:
                time.sleep(0.5)
                continue
            except WebDriverException as exc:
                if _is_session_lost(exc):
                    raise RuntimeError("Okno Chrome zostało zamknięte.") from exc
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
                    "Strona kluczy zamknęła się bez przekazania kluczy. Upewnij się, że na telefonie "
                    "z Androidem jest włączone Find Hub z opcją lokalizowania offline."
                )
        raise TimeoutError("Upłynął limit czasu na odblokowanie kluczy.")

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
    raise RuntimeError("Nie znaleziono Chrome/Chromium w kontenerze.")


def _chrome_major(binary: str) -> int | None:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=20).stdout
    except Exception:  # noqa: BLE001
        return None
    match = re.search(r"(\d+)\.\d+\.\d+", out)
    return int(match.group(1)) if match else None


def _create_driver(profile_dir: str):
    binary = _chrome_binary()
    options = uc.ChromeOptions()
    for arg in (
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        f"--lang={CHROME_LANG}",
        "--window-position=0,0",
        f"--window-size={WIDTH},{HEIGHT}",
    ):
        options.add_argument(arg)
    options.add_experimental_option("prefs", {"intl.accept_languages": CHROME_LANG})

    kwargs = {
        "options": options,
        "browser_executable_path": binary,
        "user_data_dir": profile_dir,
        "version_main": _chrome_major(binary),
    }
    # Chromium (arm64) ma własny chromedriver z pakietu; na amd64 uc pobiera pasujący sam.
    system_driver = shutil.which("chromedriver")
    if system_driver and "chromium" in binary:
        kwargs["driver_executable_path"] = system_driver
    log.info("Start Chrome: %s (wersja %s)", binary, kwargs["version_main"])
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
        _job = LoginJob(security_url)
        _job.start()
    return web.json_response(_job.public_status())


async def status(_: web.Request) -> web.Response:
    if _job is None:
        return web.json_response({"state": "idle", "message": "", "error": None, "has_result": False})
    return web.json_response(_job.public_status())


async def result(_: web.Request) -> web.Response:
    # Wynik oddawany jednorazowo - potem znika z pamięci.
    if _job is None or _job.result is None:
        return web.json_response({"error": "no result"}, status=404)
    data, _job.result = _job.result, None
    return web.json_response(data)


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
        web.get("/health", health),
    ])
    web.run_app(app, host="0.0.0.0", port=8001, access_log=None)


if __name__ == "__main__":
    main()
