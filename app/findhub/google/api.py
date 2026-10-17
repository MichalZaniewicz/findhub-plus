"""Surowe wywołania API: Nova (android.googleapis.com/nova) i Spot (gRPC)."""

from __future__ import annotations

import re

import httpx

from .gfmt import GrpcParser
from .tokens import ADM_SCOPE, SPOT_SCOPE, GoogleAuthError, TokenManager

NOVA_URL = "https://android.googleapis.com/nova/"
SPOT_URL = "https://spot-pa.googleapis.com/google.internal.spot.v1.SpotService/"


class GoogleApiError(Exception):
    pass


def _error_text(response: httpx.Response) -> str:
    text = re.sub(r"<[^>]+>", " ", response.text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return f"HTTP {response.status_code}: {text[:200]}"


class GoogleApi:
    def __init__(self, tokens: TokenManager):
        self.tokens = tokens
        self._nova = httpx.AsyncClient(timeout=30.0)
        self._spot = httpx.AsyncClient(http2=True, timeout=30.0)

    async def close(self) -> None:
        await self._nova.aclose()
        await self._spot.aclose()

    async def nova(self, scope: str, payload: bytes) -> bytes:
        for attempt in range(2):
            token = await self.tokens.get(ADM_SCOPE)
            response = await self._nova.post(
                NOVA_URL + scope,
                content=payload,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Authorization": "Bearer " + token,
                    "Accept-Language": "en-US",
                    "User-Agent": "fmd/20006320; gzip",
                },
            )
            if response.status_code == 200:
                return response.content
            if response.status_code == 401 and attempt == 0:
                self.tokens.invalidate(ADM_SCOPE)
                continue
            if response.status_code == 401:
                raise GoogleAuthError("Google odrzuca żądania (401) - połącz konto ponownie")
            raise GoogleApiError(_error_text(response))
        raise GoogleApiError("unreachable")

    async def spot(self, method: str, payload: bytes) -> bytes:
        for attempt in range(2):
            token = await self.tokens.get(SPOT_SCOPE, play_services=True)
            response = await self._spot.post(
                SPOT_URL + method,
                content=GrpcParser.construct_grpc(payload),
                headers={
                    "User-Agent": "com.google.android.gms/244433022 grpc-java-cronet/1.69.0-SNAPSHOT",
                    "Content-Type": "application/grpc",
                    "Te": "trailers",
                    "Authorization": "Bearer " + token,
                    "Grpc-Accept-Encoding": "gzip",
                },
            )
            if response.status_code == 200 and len(response.content) >= 5:
                return GrpcParser.extract_grpc_payload(response.content)
            if response.status_code == 401 and attempt == 0:
                self.tokens.invalidate(SPOT_SCOPE)
                continue
            grpc_message = response.headers.get("grpc-message", "")
            raise GoogleApiError(f"Spot {method}: {_error_text(response)} {grpc_message}".strip())
        raise GoogleApiError("unreachable")
