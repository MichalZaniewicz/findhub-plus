"""Geometry and history analysis: distances, stop detection, daily stats."""

from __future__ import annotations

import math
from collections import OrderedDict
from datetime import datetime, tzinfo
from typing import Any, Iterable

EARTH_RADIUS_M = 6371000.0
# Find Hub network reports can be very inaccurate - only reasonable ones are used for analysis.
MAX_ANALYSIS_ACCURACY = 300.0


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    rad = math.pi / 180
    d_lat = (lat2 - lat1) * rad
    d_lon = (lon2 - lon1) * rad
    h = math.sin(d_lat / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(d_lon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def _ts(p: dict) -> float:
    ts = p["ts"]
    return ts.timestamp() if isinstance(ts, datetime) else float(ts)


def usable_points(points: Iterable[dict], max_accuracy: float = MAX_ANALYSIS_ACCURACY) -> list[dict]:
    return [p for p in points
            if p.get("lat") is not None and (p.get("accuracy") is None or p["accuracy"] <= max_accuracy)]


def segment_distance(a: dict, b: dict) -> float:
    """Distance between points, ignoring "jitter" that falls within the measurement inaccuracy."""
    d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
    noise = max(30.0, ((a.get("accuracy") or 0) + (b.get("accuracy") or 0)) / 2)
    return d if d > noise else 0.0


def track_distance(points: list[dict]) -> float:
    pts = usable_points(points)
    return sum(segment_distance(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def detect_stays(points: list[dict], radius: float = 150.0, min_minutes: float = 10.0) -> list[dict[str, Any]]:
    """Groups consecutive points within `radius` of the cluster centre; returns stops >= min_minutes."""
    pts = sorted(usable_points(points), key=_ts)
    stays: list[dict[str, Any]] = []
    cluster: list[dict] = []

    def centroid(c: list[dict]) -> tuple[float, float]:
        return sum(p["lat"] for p in c) / len(c), sum(p["lon"] for p in c) / len(c)

    def flush() -> None:
        if len(cluster) < 2:
            return
        start, end = _ts(cluster[0]), _ts(cluster[-1])
        if end - start < min_minutes * 60:
            return
        lat, lon = centroid(cluster)
        stays.append({
            "lat": lat, "lon": lon,
            "start": cluster[0]["ts"], "end": cluster[-1]["ts"],
            "duration_s": int(end - start), "points": len(cluster),
        })

    for p in pts:
        if cluster:
            lat, lon = centroid(cluster)
            if haversine(lat, lon, p["lat"], p["lon"]) <= radius:
                cluster.append(p)
                continue
            flush()
        cluster = [p]
    flush()
    return stays


def zone_for(lat: float, lon: float, zones: list[dict]) -> dict | None:
    best = None
    for z in zones:
        d = haversine(lat, lon, z["lat"], z["lon"])
        if d <= z["radius"] and (best is None or d < best[0]):
            best = (d, z)
    return best[1] if best else None


def daily_stats(points: list[dict], tz: tzinfo) -> list[dict[str, Any]]:
    days: OrderedDict[str, list[dict]] = OrderedDict()
    for p in sorted(points, key=_ts):
        ts = p["ts"] if isinstance(p["ts"], datetime) else datetime.fromtimestamp(p["ts"], tz)
        days.setdefault(ts.astimezone(tz).date().isoformat(), []).append(p)
    result = []
    for day, pts in days.items():
        geo = [p for p in pts if p.get("lat") is not None]
        result.append({
            "date": day,
            "points": len(geo),
            "semantic": len(pts) - len(geo),
            "distance_m": round(track_distance(geo)),
            "first": pts[0]["ts"],
            "last": pts[-1]["ts"],
            "stays": len(detect_stays(geo)),
        })
    return result
