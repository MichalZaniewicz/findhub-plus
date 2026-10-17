from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterable

import asyncpg

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,               -- canonic id from Find Hub
    name          TEXT NOT NULL,
    custom_name   TEXT,
    kind          TEXT NOT NULL DEFAULT 'tracker', -- tracker | android
    device_type   TEXT,
    model         TEXT,
    manufacturer  TEXT,
    image_url     TEXT,
    color         TEXT,
    tracking      BOOLEAN NOT NULL DEFAULT true,
    hidden        BOOLEAN NOT NULL DEFAULT false,
    first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error    TEXT,
    last_poll_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS locations (
    id             BIGSERIAL PRIMARY KEY,
    device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts             TIMESTAMPTZ NOT NULL,
    lat            DOUBLE PRECISION,
    lon            DOUBLE PRECISION,
    alt            DOUBLE PRECISION,
    accuracy       REAL,
    status         SMALLINT,      -- 0 semantic, 1 last known, 2 crowdsourced, 3 aggregated
    is_own_report  BOOLEAN,
    semantic_name  TEXT,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT locations_dedup UNIQUE NULLS NOT DISTINCT (device_id, ts, lat, lon, semantic_name)
);
CREATE INDEX IF NOT EXISTS locations_device_ts ON locations (device_id, ts DESC);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- per-device alarms
ALTER TABLE devices ADD COLUMN IF NOT EXISTS lost_after_hours REAL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS lost_alerted_at  TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_enabled    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_from       TEXT;   -- 'HH:MM', empty = all day
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_to         TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_radius     REAL NOT NULL DEFAULT 150;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_lat        DOUBLE PRECISION;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_lon        DOUBLE PRECISION;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_armed_at   TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS guard_last_alert TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS zones (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    radius     REAL NOT NULL,
    color      TEXT NOT NULL DEFAULT '#2563eb',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_zone_state (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    zone_id   INT  NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    inside    BOOLEAN NOT NULL,
    since     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, zone_id)
);

CREATE TABLE IF NOT EXISTS events (
    id        BIGSERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_ts  TIMESTAMPTZ,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,   -- zone_enter | zone_exit | moved | lost | found
    zone_id   INT REFERENCES zones(id) ON DELETE SET NULL,
    message   TEXT NOT NULL,
    lat       DOUBLE PRECISION,
    lon       DOUBLE PRECISION,
    read      BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS shares (
    token      TEXT PRIMARY KEY,
    label      TEXT,
    device_ids TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);
"""

DEVICE_PATCH_FIELDS = {
    "custom_name", "color", "tracking", "hidden",
    "lost_after_hours", "guard_enabled", "guard_from", "guard_to", "guard_radius",
}
DEVICE_INTERNAL_FIELDS = {"lost_alerted_at", "guard_lat", "guard_lon", "guard_armed_at", "guard_last_alert"}

PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46a5a5",
           "#f032e6", "#9a6324", "#008080", "#800000", "#808000", "#000075"]


class Database:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=10)
        async with self.pool.acquire() as conn:
            await conn.execute(SCHEMA)

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()

    # --- settings ------------------------------------------------------------------------
    async def get_setting(self, key: str, default: Any = None) -> Any:
        value = await self.pool.fetchval("SELECT value FROM settings WHERE key = $1", key)
        return json.loads(value) if value is not None else default

    async def set_setting(self, key: str, value: Any) -> None:
        await self.pool.execute(
            "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            key, json.dumps(value),
        )

    # --- devices -------------------------------------------------------------------------
    async def upsert_device(self, dev: dict[str, Any]) -> None:
        async with self.pool.acquire() as conn:
            exists = await conn.fetchval("SELECT 1 FROM devices WHERE id = $1", dev["id"])
            if exists:
                await conn.execute(
                    """UPDATE devices SET name=$2, kind=$3, device_type=$4, model=$5, manufacturer=$6,
                       image_url=$7, updated_at=now() WHERE id=$1""",
                    dev["id"], dev["name"], dev["kind"], dev.get("device_type"), dev.get("model"),
                    dev.get("manufacturer"), dev.get("image_url"),
                )
            else:
                count = await conn.fetchval("SELECT count(*) FROM devices")
                await conn.execute(
                    """INSERT INTO devices (id, name, kind, device_type, model, manufacturer, image_url, color)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                    dev["id"], dev["name"], dev["kind"], dev.get("device_type"), dev.get("model"),
                    dev.get("manufacturer"), dev.get("image_url"), PALETTE[count % len(PALETTE)],
                )

    async def device_exists(self, device_id: str) -> bool:
        return bool(await self.pool.fetchval("SELECT 1 FROM devices WHERE id = $1", device_id))

    async def update_device(self, device_id: str, fields: dict[str, Any]) -> bool:
        fields = {k: v for k, v in fields.items() if k in DEVICE_PATCH_FIELDS}
        if not fields:
            return await self.device_exists(device_id)
        return await self.set_device_fields(device_id, fields)

    async def set_device_fields(self, device_id: str, fields: dict[str, Any]) -> bool:
        fields = {k: v for k, v in fields.items() if k in DEVICE_PATCH_FIELDS | DEVICE_INTERNAL_FIELDS}
        if not fields:
            return False
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
        result = await self.pool.execute(
            f"UPDATE devices SET {sets} WHERE id = $1", device_id, *fields.values()
        )
        return result.endswith("1")

    async def get_device(self, device_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT * FROM devices WHERE id = $1", device_id)
        return dict(row) if row else None

    async def arm_guard(self, device_id: str) -> bool:
        """Guard anchor = last known position. Returns False if the device has no position."""
        row = await self.pool.fetchrow(
            "SELECT lat, lon FROM locations WHERE device_id = $1 AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1",
            device_id,
        )
        if not row:
            return False
        await self.pool.execute(
            "UPDATE devices SET guard_lat=$2, guard_lon=$3, guard_armed_at=now(), guard_last_alert=NULL WHERE id=$1",
            device_id, row["lat"], row["lon"],
        )
        return True

    async def lost_candidates(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT d.id, d.name, d.custom_name, d.lost_after_hours, d.lost_alerted_at,
                      (SELECT max(ts) FROM locations l WHERE l.device_id = d.id AND l.lat IS NOT NULL) AS last_ts
               FROM devices d WHERE d.lost_after_hours IS NOT NULL AND d.lost_after_hours > 0"""
        )
        return [dict(r) for r in rows]

    async def set_device_poll_result(self, device_id: str, error: str | None) -> None:
        await self.pool.execute(
            "UPDATE devices SET last_poll_at = now(), last_error = $2 WHERE id = $1", device_id, error
        )

    async def delete_device(self, device_id: str) -> None:
        await self.pool.execute("DELETE FROM devices WHERE id = $1", device_id)

    async def list_devices(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """
            SELECT d.*,
                   g.ts AS loc_ts, g.lat, g.lon, g.alt, g.accuracy, g.status AS loc_status,
                   g.is_own_report,
                   s.ts AS sem_ts, s.semantic_name,
                   (SELECT count(*) FROM locations l WHERE l.device_id = d.id) AS points
            FROM devices d
            LEFT JOIN LATERAL (
                SELECT * FROM locations l WHERE l.device_id = d.id AND l.lat IS NOT NULL
                ORDER BY l.ts DESC LIMIT 1
            ) g ON true
            LEFT JOIN LATERAL (
                SELECT * FROM locations l WHERE l.device_id = d.id AND l.lat IS NULL
                ORDER BY l.ts DESC LIMIT 1
            ) s ON true
            ORDER BY d.hidden, coalesce(d.custom_name, d.name)
            """
        )
        return [dict(r) for r in rows]

    async def tracked_device_ids(self) -> list[tuple[str, str]]:
        rows = await self.pool.fetch(
            "SELECT id, coalesce(custom_name, name) AS name FROM devices WHERE tracking ORDER BY name"
        )
        return [(r["id"], r["name"]) for r in rows]

    # --- locations -----------------------------------------------------------------------
    async def insert_locations(self, device_id: str, fixes: Iterable[Any]) -> int:
        return len(await self.insert_new_locations(device_id, fixes))

    async def insert_new_locations(self, device_id: str, fixes: Iterable[Any]) -> list[Any]:
        """Stores points and returns the ones that were not in the database yet."""
        inserted = []
        async with self.pool.acquire() as conn, conn.transaction():
            for fix in fixes:
                row = await conn.fetchval(
                    """INSERT INTO locations (device_id, ts, lat, lon, alt, accuracy, status,
                                              is_own_report, semantic_name)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                       ON CONFLICT ON CONSTRAINT locations_dedup DO NOTHING RETURNING id""",
                    device_id, datetime.fromtimestamp(fix.ts, tz=timezone.utc), fix.lat, fix.lon, fix.alt,
                    fix.accuracy, fix.status, fix.is_own_report, fix.semantic_name,
                )
                if row:
                    inserted.append(fix)
        return inserted

    async def history(self, device_id: str, start: datetime, end: datetime,
                      max_accuracy: float | None = None, limit: int = 50000) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT ts, lat, lon, alt, accuracy, status, is_own_report, semantic_name
               FROM locations
               WHERE device_id = $1 AND ts >= $2 AND ts <= $3
                 AND ($4::real IS NULL OR lat IS NULL OR accuracy IS NULL OR accuracy <= $4)
               ORDER BY ts LIMIT $5""",
            device_id, start, end, max_accuracy, limit,
        )
        return [dict(r) for r in rows]

    async def purge_older_than(self, days: int) -> int:
        result = await self.pool.execute(
            "DELETE FROM locations WHERE ts < now() - make_interval(days => $1)", days
        )
        return int(result.split()[-1])

    # --- zones ---------------------------------------------------------------------------
    async def list_zones(self) -> list[dict[str, Any]]:
        return [dict(r) for r in await self.pool.fetch("SELECT * FROM zones ORDER BY name")]

    async def create_zone(self, name: str, lat: float, lon: float, radius: float, color: str) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            "INSERT INTO zones (name, lat, lon, radius, color) VALUES ($1,$2,$3,$4,$5) RETURNING *",
            name, lat, lon, radius, color,
        )
        return dict(row)

    async def update_zone(self, zone_id: int, fields: dict[str, Any]) -> bool:
        fields = {k: v for k, v in fields.items() if k in {"name", "lat", "lon", "radius", "color"}}
        if not fields:
            return False
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
        async with self.pool.acquire() as conn, conn.transaction():
            result = await conn.execute(f"UPDATE zones SET {sets} WHERE id = $1", zone_id, *fields.values())
            # Changed geometry = enter/exit state is recomputed from scratch (no false events).
            await conn.execute("DELETE FROM device_zone_state WHERE zone_id = $1", zone_id)
        return result.endswith("1")

    async def delete_zone(self, zone_id: int) -> None:
        await self.pool.execute("DELETE FROM zones WHERE id = $1", zone_id)

    async def zone_states(self, device_id: str) -> dict[int, dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT zone_id, inside, since FROM device_zone_state WHERE device_id = $1", device_id
        )
        return {r["zone_id"]: {"inside": r["inside"], "since": r["since"]} for r in rows}

    async def set_zone_state(self, device_id: str, zone_id: int, inside: bool, since: datetime) -> None:
        await self.pool.execute(
            """INSERT INTO device_zone_state (device_id, zone_id, inside, since) VALUES ($1,$2,$3,$4)
               ON CONFLICT (device_id, zone_id) DO UPDATE SET inside = EXCLUDED.inside, since = EXCLUDED.since""",
            device_id, zone_id, inside, since,
        )

    async def zone_occupancy(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT device_id, zone_id, since FROM device_zone_state WHERE inside"
        )
        return [dict(r) for r in rows]

    # --- events --------------------------------------------------------------------------
    async def add_event(self, device_id: str | None, kind: str, message: str, zone_id: int | None,
                        position: tuple[float, float] | None, event_ts: datetime | None = None,
                        params: dict[str, Any] | None = None) -> None:
        lat, lon = position if position else (None, None)
        await self.pool.execute(
            """INSERT INTO events (device_id, kind, message, zone_id, lat, lon, event_ts, params)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)""",
            device_id, kind, message, zone_id, lat, lon, event_ts, json.dumps(params or {}),
        )

    async def list_events(self, limit: int = 200, device_id: str | None = None) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT * FROM events WHERE ($2::text IS NULL OR device_id = $2)
               ORDER BY id DESC LIMIT $1""",
            limit, device_id,
        )
        out = []
        for r in rows:
            item = dict(r)
            item["params"] = json.loads(item["params"]) if isinstance(item["params"], str) else item["params"]
            out.append(item)
        return out

    async def events_summary(self) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            "SELECT count(*) FILTER (WHERE NOT read) AS unread, coalesce(max(id), 0) AS last_id FROM events"
        )
        return {"unread": row["unread"], "last_id": row["last_id"]}

    async def mark_events_read(self) -> None:
        await self.pool.execute("UPDATE events SET read = true WHERE NOT read")

    # --- sharing -------------------------------------------------------------------------
    async def create_share(self, token: str, label: str | None, device_ids: list[str],
                           expires_at: datetime | None) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            "INSERT INTO shares (token, label, device_ids, expires_at) VALUES ($1,$2,$3,$4) RETURNING *",
            token, label, device_ids, expires_at,
        )
        return dict(row)

    async def list_shares(self) -> list[dict[str, Any]]:
        return [dict(r) for r in await self.pool.fetch("SELECT * FROM shares ORDER BY created_at DESC")]

    async def delete_share(self, token: str) -> None:
        await self.pool.execute("DELETE FROM shares WHERE token = $1", token)

    async def get_active_share(self, token: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM shares WHERE token = $1 AND (expires_at IS NULL OR expires_at > now())", token
        )
        return dict(row) if row else None

    async def share_positions(self, device_ids: list[str], trail_hours: float) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT d.id, coalesce(d.custom_name, d.name) AS name, d.color, d.kind, d.device_type,
                      g.ts, g.lat, g.lon, g.accuracy,
                      (SELECT coalesce(json_agg(json_build_array(t.lat, t.lon) ORDER BY t.ts), '[]'::json)
                         FROM locations t
                        WHERE t.device_id = d.id AND t.lat IS NOT NULL
                          AND t.ts > now() - make_interval(secs => $2)
                          AND (t.accuracy IS NULL OR t.accuracy <= 300)) AS trail
               FROM devices d
               LEFT JOIN LATERAL (
                   SELECT ts, lat, lon, accuracy FROM locations l
                   WHERE l.device_id = d.id AND l.lat IS NOT NULL ORDER BY l.ts DESC LIMIT 1
               ) g ON true
               WHERE d.id = ANY($1::text[])
               ORDER BY name""",
            device_ids, trail_hours * 3600,
        )
        out = []
        for r in rows:
            item = dict(r)
            item["trail"] = json.loads(item["trail"]) if isinstance(item["trail"], str) else item["trail"]
            out.append(item)
        return out
