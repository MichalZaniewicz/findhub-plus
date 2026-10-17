from __future__ import annotations

import asyncio
import csv
import io
import json
import secrets
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from . import auth
from .config import settings
from .geo import daily_stats, detect_stays, zone_for
from .google.tokens import GoogleAuthError
from .secrets_store import normalize_uploaded

public = APIRouter(prefix="/api")
api = APIRouter(prefix="/api", dependencies=[Depends(auth.require_auth)])


def _state(request: Request):
    return request.app.state


# --- panel login -------------------------------------------------------------------------------

class LoginBody(BaseModel):
    password: str


@public.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response):
    if not auth.check_password(body.password):
        await auth.failed_login_delay()
        raise HTTPException(status_code=401, detail="Incorrect password")
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
    """forward_auth for the gateway (noVNC)."""
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
        "events": await st.db.events_summary(),
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


# --- devices ---------------------------------------------------------------------------------

@api.get("/devices")
async def devices(request: Request):
    return await _state(request).db.list_devices()


HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class DevicePatch(BaseModel):
    custom_name: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    tracking: bool | None = None
    hidden: bool | None = None
    lost_after_hours: float | None = Field(default=None, ge=0, le=24 * 365)
    guard_enabled: bool | None = None
    guard_from: str | None = Field(default=None, pattern=HHMM)
    guard_to: str | None = Field(default=None, pattern=HHMM)
    guard_radius: float | None = Field(default=None, ge=20, le=50000)


@api.patch("/devices/{device_id}")
async def patch_device(device_id: str, body: DevicePatch, request: Request):
    db = _state(request).db
    fields = body.model_dump(exclude_unset=True)
    if "custom_name" in fields and not (fields["custom_name"] or "").strip():
        fields["custom_name"] = None
    if fields.get("guard_radius", 0) is None:
        fields.pop("guard_radius")
    if "lost_after_hours" in fields:
        fields["lost_after_hours"] = fields["lost_after_hours"] or None
    if not await db.update_device(device_id, fields):
        raise HTTPException(status_code=404, detail="No such device")
    if "lost_after_hours" in fields:
        await db.set_device_fields(device_id, {"lost_alerted_at": None})
    if fields.get("guard_enabled"):
        if not await db.arm_guard(device_id):
            await db.set_device_fields(device_id, {"guard_enabled": False})
            raise HTTPException(status_code=409, detail="The device has no position yet - nothing to guard")
    return {"ok": True}


@api.delete("/devices/{device_id}")
async def delete_device(device_id: str, request: Request):
    await _state(request).db.delete_device(device_id)
    return {"ok": True}


@api.post("/devices/{device_id}/locate")
async def locate(device_id: str, request: Request):
    st = _state(request)
    if not st.secrets.connected:
        raise HTTPException(status_code=409, detail="Google account is not connected")
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


@api.get("/devices/{device_id}/stays")
async def stays(device_id: str, request: Request, start: datetime | None = None, end: datetime | None = None,
                radius: float = 150, min_minutes: float = 10):
    db = _state(request).db
    start, end = _range(start, end)
    rows = await db.history(device_id, start, end)
    zones = await db.list_zones()
    result = detect_stays(rows, radius=max(30.0, radius), min_minutes=max(1.0, min_minutes))
    for stay in result:
        zone = zone_for(stay["lat"], stay["lon"], zones)
        stay["zone"] = zone["name"] if zone else None
    return result


@api.get("/devices/{device_id}/daily")
async def daily(device_id: str, request: Request, start: datetime | None = None, end: datetime | None = None):
    start, end = _range(start, end)
    rows = await _state(request).db.history(device_id, start, end)
    return daily_stats(rows, settings.tz)


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
        raise HTTPException(status_code=404, detail="Unsupported format")
    return Response(body, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"'})


# --- Google account ----------------------------------------------------------------------------

class LoginStartBody(BaseModel):
    lang: str | None = Field(default=None, pattern=r"^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$")


@api.post("/google/login/start")
async def google_login_start(request: Request, body: LoginStartBody | None = None):
    return await _state(request).login.start(lang=body.lang if body else None)


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
        raise HTTPException(status_code=400, detail=f"Invalid file: {exc}") from exc
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


# --- zones -----------------------------------------------------------------------------------

class ZoneBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius: float = Field(ge=20, le=50000)
    color: str = Field(default="#2563eb", pattern=r"^#[0-9a-fA-F]{6}$")


class ZonePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    radius: float | None = Field(default=None, ge=20, le=50000)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


@api.get("/zones")
async def zones(request: Request):
    db = _state(request).db
    occupancy = await db.zone_occupancy()
    result = []
    for zone in await db.list_zones():
        zone["devices"] = [o["device_id"] for o in occupancy if o["zone_id"] == zone["id"]]
        result.append(zone)
    return result


@api.post("/zones")
async def create_zone(body: ZoneBody, request: Request):
    return await _state(request).db.create_zone(body.name.strip(), body.lat, body.lon, body.radius, body.color)


@api.patch("/zones/{zone_id}")
async def patch_zone(zone_id: int, body: ZonePatch, request: Request):
    if not await _state(request).db.update_zone(zone_id, body.model_dump(exclude_unset=True, exclude_none=True)):
        raise HTTPException(status_code=404, detail="No such zone")
    return {"ok": True}


@api.delete("/zones/{zone_id}")
async def delete_zone(zone_id: int, request: Request):
    await _state(request).db.delete_zone(zone_id)
    return {"ok": True}


# --- events ----------------------------------------------------------------------------------

@api.get("/events")
async def events(request: Request, limit: int = 200, device_id: str | None = None):
    return await _state(request).db.list_events(min(max(limit, 1), 1000), device_id)


@api.post("/events/read")
async def events_read(request: Request):
    await _state(request).db.mark_events_read()
    return {"ok": True}


# --- sharing ---------------------------------------------------------------------------------

class ShareBody(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    device_ids: list[str] = Field(min_length=1, max_length=50)
    expires_hours: float | None = Field(default=24, ge=0, le=24 * 365)


@api.get("/shares")
async def shares(request: Request):
    return await _state(request).db.list_shares()


@api.post("/shares")
async def create_share(body: ShareBody, request: Request):
    expires = (datetime.now(timezone.utc) + timedelta(hours=body.expires_hours)) if body.expires_hours else None
    label = (body.label or "").strip() or None
    return await _state(request).db.create_share(secrets.token_urlsafe(18), label, body.device_ids, expires)


@api.delete("/shares/{token}")
async def delete_share(token: str, request: Request):
    await _state(request).db.delete_share(token)
    return {"ok": True}


@public.get("/public/share/{token}")
async def public_share(token: str, request: Request):
    """Public position view from a share link - no login, selected devices only, read-only."""
    db = _state(request).db
    share = await db.get_active_share(token)
    if not share:
        raise HTTPException(status_code=404, detail="The link has expired or does not exist")
    devices = await db.share_positions(share["device_ids"], trail_hours=6)
    return {"label": share["label"], "expires_at": share["expires_at"], "devices": devices}
