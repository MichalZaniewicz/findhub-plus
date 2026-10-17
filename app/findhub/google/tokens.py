"""Tokeny Google: aas_token (master) -> krótkotrwałe tokeny OAuth dla API Find Hub (Nova) i Spot."""

from __future__ import annotations

import asyncio
import logging
import time

import gpsoauth

from ..secrets_store import SecretsStore

log = logging.getLogger(__name__)

ADM_SCOPE = "android_device_manager"
SPOT_SCOPE = "spot"
# SHA1 certyfikatu podpisu aplikacji Find Hub (com.google.android.apps.adm).
CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788"


class GoogleAuthError(Exception):
    """Google odrzucił token - konto trzeba połączyć ponownie."""


class TokenManager:
    def __init__(self, secrets: SecretsStore):
        self.secrets = secrets
        self._cache: dict[str, tuple[str, float]] = {}
        self._lock = asyncio.Lock()

    def android_id(self) -> int:
        creds = self.secrets.get("fcm_credentials") or {}
        try:
            return int(creds["gcm"]["android_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise GoogleAuthError("Brak rejestracji FCM (android_id)") from exc

    def reset(self) -> None:
        self._cache.clear()

    def invalidate(self, scope: str) -> None:
        self._cache.pop(scope, None)

    async def get(self, scope: str, play_services: bool = False) -> str:
        cached = self._cache.get(scope)
        if cached and cached[1] > time.time() + 120:
            return cached[0]
        async with self._lock:
            cached = self._cache.get(scope)
            if cached and cached[1] > time.time() + 120:
                return cached[0]
            aas_token = self.secrets.get("aas_token")
            if not aas_token:
                raise GoogleAuthError("Konto Google nie jest połączone")
            response = await asyncio.to_thread(
                gpsoauth.perform_oauth,
                self.secrets.username,
                aas_token,
                self.android_id(),
                service="oauth2:https://www.googleapis.com/auth/" + scope,
                app="com.google.android.gms" if play_services else "com.google.android.apps.adm",
                client_sig=CLIENT_SIG,
            )
            token = response.get("Auth")
            if not token:
                error = response.get("Error", "nieznany błąd")
                raise GoogleAuthError(f"Google odrzucił token ({error}) - połącz konto ponownie")
            try:
                expiry = float(response.get("Expiry"))
            except (TypeError, ValueError):
                expiry = time.time() + 3000
            self._cache[scope] = (token, expiry)
            return token


async def exchange_oauth_token(oauth_token: str, email: str, android_id: int) -> tuple[str, str]:
    """Jednorazowy oauth_token z przeglądarki -> trwały aas_token. Zwraca (aas_token, email)."""
    response = await asyncio.to_thread(gpsoauth.exchange_token, email or "", oauth_token, android_id)
    token = response.get("Token")
    if not token:
        raise GoogleAuthError(f"Wymiana tokenu nie powiodła się: {response.get('Error', 'nieznany błąd')}")
    return token, response.get("Email") or email or ""
