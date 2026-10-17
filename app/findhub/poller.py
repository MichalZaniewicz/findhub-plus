"""Cykliczne zbieranie lokalizacji - to z tego powstaje historia (Google jej nie przechowuje)."""

from __future__ import annotations

import asyncio
import logging
import time

from .db import Database
from .google.client import FindHubClient
from .google.crypto import Fix
from .google.tokens import GoogleAuthError

log = logging.getLogger(__name__)

MIN_INTERVAL = 60


class Poller:
    def __init__(self, db: Database, client: FindHubClient, interval: int, device_delay: int,
                 locate_timeout: int, retention_days: int):
        self.db = db
        self.client = client
        self.interval = interval
        self.device_delay = device_delay
        self.locate_timeout = locate_timeout
        self.retention_days = retention_days
        self._wake = asyncio.Event()
        self._cycle_lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self.state = "idle"            # idle | running | waiting | not_connected | auth_error | error
        self.current_device: str | None = None
        self.last_cycle_started: float | None = None
        self.last_cycle_finished: float | None = None
        self.next_cycle_at: float | None = None
        self.last_error: str | None = None
        self.last_new_points = 0

    async def start(self) -> None:
        saved = await self.db.get_setting("poll_interval")
        if isinstance(saved, int) and saved >= MIN_INTERVAL:
            self.interval = saved
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def set_interval(self, seconds: int) -> None:
        self.interval = max(MIN_INTERVAL, int(seconds))
        await self.db.set_setting("poll_interval", self.interval)
        self.trigger()

    def trigger(self) -> None:
        self._wake.set()

    def status(self) -> dict:
        return {
            "state": self.state,
            "interval": self.interval,
            "current_device": self.current_device,
            "last_cycle_started": self.last_cycle_started,
            "last_cycle_finished": self.last_cycle_finished,
            "next_cycle_at": self.next_cycle_at,
            "last_error": self.last_error,
            "last_new_points": self.last_new_points,
        }

    # --- pętla ---------------------------------------------------------------------------
    async def _run(self) -> None:
        while True:
            if not self.client.connected:
                self.state = "not_connected"
            else:
                try:
                    await self.cycle()
                    self.state = "waiting"
                    self.last_error = None
                except GoogleAuthError as exc:
                    self.state, self.last_error = "auth_error", str(exc)
                    log.error("Błąd autoryzacji Google: %s", exc)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    self.state, self.last_error = "error", str(exc)
                    log.exception("Cykl odpytywania nie powiódł się")
            self.next_cycle_at = time.time() + self.interval
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self.interval)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    async def cycle(self) -> None:
        async with self._cycle_lock:
            self.state = "running"
            self.last_cycle_started = time.time()
            new_points = 0

            devices = await self.client.list_devices()
            for device in devices:
                await self.db.upsert_device(device.as_row())
                if device.fixes:
                    new_points += await self.db.insert_locations(device.id, device.fixes)

            for device_id, name in await self.db.tracked_device_ids():
                self.current_device = name
                fixes, _ = await self.locate_one(device_id)
                new_points += fixes
                if self.device_delay:
                    await asyncio.sleep(self.device_delay)
            self.current_device = None

            if self.retention_days:
                removed = await self.db.purge_older_than(self.retention_days)
                if removed:
                    log.info("Retencja: usunięto %s starych punktów", removed)

            self.last_new_points = new_points
            self.last_cycle_finished = time.time()
            log.info("Cykl zakończony: %s urządzeń, %s nowych punktów", len(devices), new_points)

    async def locate_one(self, device_id: str) -> tuple[int, str | None]:
        """Zwraca (liczba nowych punktów, błąd). GoogleAuthError przepuszcza dalej."""
        error: str | None = None
        inserted = 0
        try:
            fixes, inserted = await self.client.locate(device_id, timeout=self.locate_timeout)
            if not fixes:
                error = "Google nie zwrócił żadnych raportów lokalizacji"
        except asyncio.TimeoutError:
            error = f"Brak odpowiedzi przez {self.locate_timeout}s (tag poza zasięgiem sieci Find Hub?)"
        except GoogleAuthError:
            await self.db.set_device_poll_result(device_id, "Błąd autoryzacji Google")
            raise
        except Exception as exc:  # noqa: BLE001
            error = str(exc) or exc.__class__.__name__
        await self.db.set_device_poll_result(device_id, error)
        if error:
            log.info("Lokalizacja %s: %s", device_id[:8], error)
        return inserted, error


class FixesSink:
    """Callback dla FindHubClient: zapisuje każdą odszyfrowaną aktualizację (także niezamówioną)."""

    def __init__(self, db: Database):
        self.db = db

    async def __call__(self, device_id: str, fixes: list[Fix]) -> int:
        if not fixes or not await self.db.device_exists(device_id):
            return 0
        inserted = await self.db.insert_locations(device_id, fixes)
        if inserted:
            log.info("Zapisano %s nowych punktów dla %s", inserted, device_id[:8])
        return inserted
