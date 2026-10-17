"""Logowanie do panelu: jedno hasło z .env, sesja w podpisanym cookie."""

from __future__ import annotations

import asyncio
import hmac

from fastapi import HTTPException, Request, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import settings

COOKIE_NAME = "fh_session"
MAX_AGE = 30 * 24 * 3600

_serializer = URLSafeTimedSerializer(settings.session_secret, salt="findhub-session")


def check_password(password: str) -> bool:
    return hmac.compare_digest(password.encode(), settings.app_password.encode())


def is_authenticated(request: Request) -> bool:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return False
    try:
        _serializer.loads(token, max_age=MAX_AGE)
        return True
    except BadSignature:
        return False


def set_session(request: Request, response: Response) -> None:
    response.set_cookie(
        COOKIE_NAME,
        _serializer.dumps({"user": "owner"}),
        max_age=MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


async def require_auth(request: Request) -> None:
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Wymagane logowanie")


async def failed_login_delay() -> None:
    # Spowalnia zgadywanie hasła.
    await asyncio.sleep(1.5)
