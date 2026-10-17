from __future__ import annotations

import asyncio
import csv
import io
import json
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from . import auth
from .google.tokens import GoogleAuthError
from .secrets_store import normalize_uploaded

public = APIRouter(prefix="/api")
api = APIRouter(prefix="/api", dependencies=[Depends(auth.require_auth)])


def _state(request: Request):
    return request.app.state


# --- logowanie do panelu ---------------------------------------------------------------------

class LoginBody(BaseModel):
    password: str


@public.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response):
    if not auth.check_password(body.password):
        await auth.failed_login_delay()
        raise HTTPException(status_code=401, detail="Nieprawidłowe hasło")
    auth.set_session(request, response)
    return {"ok": True}


@public.post("/auth/logout")
async def logout(response: Response):
    auth.clear_session(response)
    return {"ok": True}


@public.get("/auth/me")
async def me(request: Request):
    return {"authenticated": auth.is_authenticated(request)}


@public.get("/auth/verify")
async def verify(request: Request):
    """forward_auth dla gatewaya (noVNC)."""
    if not auth.is_authenticated(request):
        raise HTTPException(status_code=401)
    return Response(status_code=200)


# --- status ----------------------------------------------------------------------------------

@api.get("/status")
async def status(request: Request):
    st = _state(request)
    return {
        "google": {
            "connected": st.secrets.connected,
            "email": st.secrets.username,
            "fcm": st.client.fcm_running,
            "fcm_error": st.client.fcm_error,
        },
        "poller": st.poller.status(),
        "login": st.login.status(),
    }


class SettingsBody(BaseModel):
    poll_interval: int = Field(ge=60, le=86400)


@api.put("/settings")
async def update_settings(body: SettingsBody, request: Request):
    await _state(request).poller.set_interval(body.poll_interval)
    return {"ok": True}


@api.post("/poll")
async def poll_now(request: Request):
    _state(request).poller.trigger()
    return {"ok": True}


# --- urządzenia ------------------------------------------------------------------------------

@api.get("/devices")
async def devices(request: Request):
    return await _state(request).db.list_devices()


class DevicePatch(BaseModel):
    custom_name: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    tracking: bool | None = None
    hidden: bool | None = None


@api.patch("/devices/{device_id}")
async def patch_device(device_id: str, body: DevicePatch, request: Request):
    fields = body.model_dump(exclude_unset=True)
    if "custom_name" in fields and not (fields["custom_name"] or "").strip():
        fields["custom_name"] = None
    if not await _state(request).db.update_device(device_id, fields):
        raise HTTPException(status_code=404, detail="Nie ma takiego urządzenia")
    return {"ok": True}


@api.delete("/devices/{device_id}")
async def delete_device(device_id: str, request: Request):
    await _state(request).db.delete_device(device_id)
    return {"ok": True}


@api.post("/devices/{device_id}/locate")
async def locate(device_id: str, request: Request):
    st = _state(request)
    if not st.secrets.connected:
        raise HTTPException(status_code=409, detail="Konto Google nie jest połączone")
    try:
        inserted, error = await st.poller.locate_one(device_id)
    except GoogleAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return {"new_points": inserted, "error": error}


class SoundBody(BaseModel):
    start: bool = True


@api.post("/devices/{device_id}/sound")
async def sound(device_id: str, body: SoundBody, request: Request):
    try:
        await _state(request).client.play_sound(device_id, start=body.start)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True}


def _range(start: datetime | None, end: datetime | None) -> tuple[datetime, datetime]:
    end = end or datetime.now(timezone.utc)
    start = start or end - timedelta(hours=24)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return start, end


@api.get("/devices/{device_id}/history")
async def history(device_id: str, request: Request, start: datetime | None = None, end: datetime | None = None,
                  max_accuracy: float | None = None):
    start, end = _range(start, end)
    return await _state(request).db.history(device_id, start, end, max_accuracy)


@api.get("/devices/{device_id}/export.{fmt}")
async def export(device_id: str, fmt: str, request: Request, start: datetime | None = None,
                 end: datetime | None = None, max_accuracy: float | None = None):
    start, end = _range(start, end)
    rows = [r for r in await _state(request).db.history(device_id, start, end, max_accuracy) if r["lat"] is not None]
    name = f"findhub-{device_id[:8]}-{start:%Y%m%d}-{end:%Y%m%d}"
    if fmt == "gpx":
        points = "".join(
            f'<trkpt lat="{r["lat"]:.7f}" lon="{r["lon"]:.7f}">'
            + (f'<ele>{r["alt"]:.0f}</ele>' if r["alt"] is not None else "")
            + f'<time>{r["ts"].astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}</time>'
            + (f'<hdop>{r["accuracy"]:.0f}</hdop>' if r["accuracy"] else "")
            + "</trkpt>"
            for r in rows
        )
        body = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<gpx version="1.1" creator="FindHub+" xmlns="http://www.topografix.com/GPX/1/1">'
                f"<trk><name>{escape(name)}</name><trkseg>{points}</trkseg></trk></gpx>")
        media = "application/gpx+xml"
    elif fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["time_utc", "lat", "lon", "alt", "accuracy_m", "status", "own_report"])
        for r in rows:
            writer.writerow([r["ts"].astimezone(timezone.utc).isoformat(), r["lat"], r["lon"], r["alt"],
                             r["accuracy"], r["status"], r["is_own_report"]])
        body, media = buf.getvalue(), "text/csv"
    elif fmt == "geojson":
        body = json.dumps({
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "geometry": {"type": "LineString",
                                                 "coordinates": [[r["lon"], r["lat"]] for r in rows]},
                 "properties": {"name": name}},
                *[{"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
                   "properties": {"time": r["ts"].isoformat(), "accuracy": r["accuracy"]}} for r in rows],
            ],
        })
        media = "application/geo+json"
    else:
        raise HTTPException(status_code=404, detail="Nieobsługiwany format")
    return Response(body, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"'})


# --- konto Google ----------------------------------------------------------------------------

@api.post("/google/login/start")
async def google_login_start(request: Request):
    return await _state(request).login.start()


@api.get("/google/login/status")
async def google_login_status(request: Request):
    return _state(request).login.status()


@api.post("/google/login/cancel")
async def google_login_cancel(request: Request):
    return await _state(request).login.cancel()


@api.post("/google/secrets")
async def upload_secrets(request: Request, file: UploadFile = File(...)):
    st = _state(request)
    try:
        data = normalize_uploaded(json.loads(await file.read()))
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Nieprawidłowy plik: {exc}") from exc
    if "fcm_credentials" not in data and st.secrets.get("fcm_credentials"):
        data["fcm_credentials"] = st.secrets.get("fcm_credentials")
    st.secrets.replace(data)
    st.client.reset_auth()
    if "fcm_credentials" in data:
        asyncio.create_task(st.client.ensure_fcm(restart=True))
    st.poller.trigger()
    return {"ok": True, "email": st.secrets.username}


@api.get("/google/secrets")
async def download_secrets(request: Request):
    body = json.dumps(_state(request).secrets.snapshot(), indent=2)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="secrets.json"'})


@api.delete("/google")
async def disconnect(request: Request):
    st = _state(request)
    st.secrets.clear_account()
    st.client.reset_auth()
    return {"ok": True}
