"""Google account linking: drives the `login` container (Chrome + noVNC) and finalizes the secrets."""

from __future__ import annotations

import asyncio
import logging

import httpx

from .google.client import FindHubClient
from .google.gfmt import get_fmdn_shared_key, get_security_domain_request_url
from .google.tokens import exchange_oauth_token
from .secrets_store import SecretsStore

log = logging.getLogger(__name__)

ACTIVE_STATES = {"starting", "waiting_login", "waiting_account", "waiting_pin", "finalizing"}


class LoginManager:
    def __init__(self, secrets: SecretsStore, client: FindHubClient, login_url: str, on_connected):
        self.secrets = secrets
        self.client = client
        self.login_url = login_url
        self.on_connected = on_connected
        self.state = "idle"
        self.message = ""
        self.error: str | None = None
        self._task: asyncio.Task | None = None
        self._http = httpx.AsyncClient(timeout=15.0)

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
        await self._http.aclose()

    def status(self) -> dict:
        return {"state": self.state, "message": self.message, "error": self.error}

    def _set(self, state: str, message: str = "", error: str | None = None) -> None:
        self.state, self.message, self.error = state, message, error

    async def start(self, lang: str | None = None, width: int | None = None, height: int | None = None) -> dict:
        if self.state in ACTIVE_STATES:
            return self.status()
        self._set("starting", "Preparing the browser…")
        try:
            # The android_id from FCM registration is needed for the token exchange - it must exist before login.
            if not self.secrets.get("fcm_credentials"):
                await self.client.ensure_fcm(restart=True)
            security_url = get_security_domain_request_url().strip()
            response = await self._http.post(f"{self.login_url}/start",
                                             json={"security_url": security_url, "lang": lang,
                                                   "width": width, "height": height})
            response.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            log.exception("Could not start login")
            self._set("error", "Could not start the login browser.", str(exc))
            return self.status()
        self._task = asyncio.create_task(self._watch())
        return self.status()

    async def type_text(self, text: str, key: str | None) -> None:
        """Forwards typed text to the focused field of the sign-in browser."""
        response = await self._http.post(f"{self.login_url}/type", json={"text": text, "key": key})
        if response.status_code != 200:
            try:
                detail = response.json().get("error", "")
            except ValueError:
                detail = response.text
            raise RuntimeError(detail or f"HTTP {response.status_code}")

    async def cancel(self) -> dict:
        try:
            await self._http.post(f"{self.login_url}/cancel")
        except Exception:  # noqa: BLE001
            pass
        if self._task:
            self._task.cancel()
        self._set("cancelled", "Login cancelled.")
        return self.status()

    async def _watch(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.5)
                remote = (await self._http.get(f"{self.login_url}/status")).json()
                state = remote.get("state")
                if state == "done":
                    result = (await self._http.get(f"{self.login_url}/result")).json()
                    await self._finalize(result)
                    return
                if state in ("error", "cancelled", "idle"):
                    self._set(state if state != "idle" else "error", remote.get("message", ""), remote.get("error"))
                    return
                self._set(state, remote.get("message", ""))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("Error during login")
            self._set("error", "Error during login.", str(exc))

    async def _finalize(self, result: dict) -> None:
        self._set("finalizing", "Exchanging the token and fetching encryption keys…")
        try:
            android_id = self.client.tokens.android_id()
            aas_token, email = await exchange_oauth_token(result["oauth_token"], result.get("email") or "", android_id)
            shared_key = get_fmdn_shared_key(result["vault_keys"]).hex()
            self.secrets.update(aas_token=aas_token, username=email, shared_key=shared_key,
                                owner_key=None, owner_key_version=None)
            self.client.reset_auth()
            # End-to-end check: Spot token + owner key decryption.
            await self.client.e2ee.owner_key(force=True)
        except Exception as exc:  # noqa: BLE001
            log.exception("Login finalization failed")
            self._set("error", "Could not finish linking the account.", str(exc))
            return
        self._set("done", f"Connected account {email}.")
        log.info("Connected Google account %s", email)
        await self.on_connected()
