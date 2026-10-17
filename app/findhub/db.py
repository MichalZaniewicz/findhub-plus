from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterable

import asyncpg

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,               -- canonic id z Find Hub
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
"""

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

    # --- ustawienia ----------------------------------------------------------------------
    async def get_setting(self, key: str, default: Any = None) -> Any:
        value = await self.pool.fetchval("SELECT value FROM settings WHERE key = $1", key)
        return json.loads(value) if value is not None else default

    async def set_setting(self, key: str, value: Any) -> None:
        await self.pool.execute(
            "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            key, json.dumps(value),
        )

    # --- urządzenia ----------------------------------------------------------------------
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
        allowed = {"custom_name", "color", "tracking", "hidden"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return False
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
        result = await self.pool.execute(
            f"UPDATE devices SET {sets} WHERE id = $1", device_id, *fields.values()
        )
        return result.endswith("1")

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

    # --- lokalizacje ---------------------------------------------------------------------
    async def insert_locations(self, device_id: str, fixes: Iterable[Any]) -> int:
        inserted = 0
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
                inserted += 1 if row else 0
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
