"""Events: zone enter/exit, guarded device movement, missing location and reappearance."""

from __future__ import annotations

import logging
from datetime import datetime, time as dtime, timedelta, timezone, tzinfo

from .db import Database
from .geo import MAX_ANALYSIS_ACCURACY, haversine
from .google.crypto import Fix

log = logging.getLogger(__name__)

GUARD_REPEAT = timedelta(minutes=15)
ZONE_EXIT_MARGIN = 25.0


def _parse_hhmm(value: str | None) -> dtime | None:
    if not value:
        return None
    try:
        hh, mm = value.split(":")[:2]
        return dtime(int(hh), int(mm))
    except (ValueError, TypeError):
        return None


def in_window(moment: datetime, start: str | None, end: str | None, tz: tzinfo) -> bool:
    """Whether the moment falls within the local-time window [start, end); the window may span midnight."""
    a, b = _parse_hhmm(start), _parse_hhmm(end)
    if a is None or b is None or a == b:
        return True
    t = moment.astimezone(tz).time()
    return a <= t < b if a < b else (t >= a or t < b)


class AlertEngine:
    def __init__(self, db: Database, tz: tzinfo):
        self.db = db
        self.tz = tz

    async def process(self, device_id: str, fixes: list[Fix]) -> None:
        """Called for a device's newly stored points."""
        geo = sorted((f for f in fixes if f.lat is not None and (f.accuracy or 0) <= MAX_ANALYSIS_ACCURACY),
                     key=lambda f: f.ts)
        device = await self.db.get_device(device_id)
        if device is None:
            return
        name = device["custom_name"] or device["name"]

        if device["lost_alerted_at"] and any(f.lat is not None for f in fixes):
            await self.db.add_event(device_id, "found", f"{name}: seen again", None, _last_geo(fixes),
                                    params={"device": name})
            await self.db.set_device_fields(device_id, {"lost_alerted_at": None})

        if not geo:
            return
        await self._zones(device_id, name, geo)
        await self._guard(device, name, geo)

    async def _zones(self, device_id: str, name: str, geo: list[Fix]) -> None:
        zones = await self.db.list_zones()
        if not zones:
            return
        states = await self.db.zone_states(device_id)
        for fix in geo:
            fix_time = datetime.fromtimestamp(fix.ts, timezone.utc)
            for zone in zones:
                state = states.get(zone["id"])
                if state and state["since"] >= fix_time:
                    continue  # report older than the one that set the state
                d = haversine(fix.lat, fix.lon, zone["lat"], zone["lon"])
                margin = min(fix.accuracy or 0, 200) + ZONE_EXIT_MARGIN
                if d <= zone["radius"]:
                    inside = True
                elif d > zone["radius"] + margin:
                    inside = False
                else:
                    continue  # in the uncertainty band - no change
                if state is None:
                    states[zone["id"]] = {"inside": inside, "since": fix_time}
                    await self.db.set_zone_state(device_id, zone["id"], inside, fix_time)
                    continue
                if state["inside"] != inside:
                    kind = "zone_enter" if inside else "zone_exit"
                    verb = "entered" if inside else "left"
                    await self.db.add_event(device_id, kind, f"{name} {verb} zone \"{zone['name']}\"", zone["id"],
                                            (fix.lat, fix.lon), event_ts=fix_time,
                                            params={"device": name, "zone": zone["name"]})
                states[zone["id"]] = {"inside": inside, "since": fix_time}
                await self.db.set_zone_state(device_id, zone["id"], inside, fix_time)

    async def _guard(self, device: dict, name: str, geo: list[Fix]) -> None:
        if not device["guard_enabled"] or device["guard_lat"] is None:
            return
        armed_at = device["guard_armed_at"]
        last_alert = device["guard_last_alert"]
        for fix in geo:
            fix_time = datetime.fromtimestamp(fix.ts, timezone.utc)
            if armed_at and fix_time <= armed_at:
                continue
            d = haversine(fix.lat, fix.lon, device["guard_lat"], device["guard_lon"])
            if d <= device["guard_radius"] + min(fix.accuracy or 0, 200):
                continue
            if not in_window(fix_time, device["guard_from"], device["guard_to"], self.tz):
                continue
            if last_alert and fix_time - last_alert < GUARD_REPEAT:
                continue
            await self.db.add_event(device["id"], "moved",
                                    f"{name} moved {round(d)} m away from the guarded spot", None,
                                    (fix.lat, fix.lon), event_ts=fix_time,
                                    params={"device": name, "distance": round(d)})
            # New anchor: the next event fires only on further movement.
            last_alert = fix_time
            await self.db.set_device_fields(device["id"], {
                "guard_last_alert": fix_time, "guard_lat": fix.lat, "guard_lon": fix.lon,
            })
            device = {**device, "guard_lat": fix.lat, "guard_lon": fix.lon}

    async def check_lost(self) -> None:
        now = datetime.now(timezone.utc)
        for row in await self.db.lost_candidates():
            hours = row["lost_after_hours"]
            last = row["last_ts"]
            if row["lost_alerted_at"] or not hours:
                continue
            if last is not None and now - last < timedelta(hours=hours):
                continue
            name = row["custom_name"] or row["name"]
            hours_missing = round((now - last).total_seconds() / 3600) if last else None
            since = f"for {_fmt_hours(hours_missing)}" if last else "since tracking started"
            await self.db.add_event(row["id"], "lost", f"{name}: no location {since}", None, None,
                                    params={"device": name, "hours": hours_missing})
            await self.db.set_device_fields(row["id"], {"lost_alerted_at": now})


def _fmt_hours(hours: float) -> str:
    return f"{hours:.0f} h" if hours < 48 else f"{hours / 24:.0f} days"


def _last_geo(fixes: list[Fix]) -> tuple[float, float] | None:
    geo = [f for f in fixes if f.lat is not None]
    if not geo:
        return None
    last = max(geo, key=lambda f: f.ts)
    return last.lat, last.lon
