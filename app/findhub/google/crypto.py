"""Find Hub location decryption (E2EE).

shared_key (from login) -> owner_key (Spot GetEidInfoForE2eeDevices) -> tag EIK -> location reports.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass

from ..secrets_store import SecretsStore
from .api import GoogleApi
from .gfmt import (
    Common_pb2,
    DeviceUpdate_pb2,
    decrypt_aes_gcm,
    decrypt_eik,
    decrypt_foreign_report,
    decrypt_owner_key,
    flip_bits,
    mcu_fast_pair_model_id,
)

log = logging.getLogger(__name__)

SEMANTIC = Common_pb2.Status.SEMANTIC


class E2EEError(Exception):
    pass


@dataclass
class Fix:
    ts: int
    lat: float | None
    lon: float | None
    alt: float | None
    accuracy: float | None
    status: int
    is_own_report: bool
    semantic_name: str | None


class E2EE:
    def __init__(self, secrets: SecretsStore, api: GoogleApi):
        self.secrets = secrets
        self.api = api
        self._eik_cache: dict[bytes, bytes] = {}
        self._owner_lock = asyncio.Lock()

    def reset(self) -> None:
        self._eik_cache.clear()

    async def get_eid_info(self):
        request = Common_pb2.GetEidInfoForE2eeDevicesRequest()
        request.ownerKeyVersion = -1
        request.hasOwnerKeyVersion = True
        raw = await self.api.spot("GetEidInfoForE2eeDevices", request.SerializeToString())
        info = DeviceUpdate_pb2.GetEidInfoForE2eeDevicesResponse()
        info.ParseFromString(raw)
        return info

    async def owner_key(self, force: bool = False) -> bytes:
        cached = self.secrets.get("owner_key")
        if cached and not force:
            return bytes.fromhex(cached)
        async with self._owner_lock:
            cached = self.secrets.get("owner_key")
            if cached and not force:
                return bytes.fromhex(cached)
            shared_key_hex = self.secrets.get("shared_key")
            if not shared_key_hex:
                raise E2EEError("shared_key missing - connect your Google account")
            info = await self.get_eid_info()
            meta = info.encryptedOwnerKeyAndMetadata
            try:
                owner_key = decrypt_owner_key(bytes.fromhex(shared_key_hex), meta.encryptedOwnerKey)
            except Exception as exc:  # noqa: BLE001
                raise E2EEError(
                    "Could not decrypt the owner key - shared_key is outdated, "
                    "reconnect your account"
                ) from exc
            self.secrets.update(owner_key=owner_key.hex(), owner_key_version=meta.ownerKeyVersion)
            self._eik_cache.clear()
            log.info("Fetched owner key (version %s)", meta.ownerKeyVersion)
            return owner_key

    async def identity_key(self, registration) -> bytes:
        secrets_ = registration.encryptedUserSecrets
        encrypted = bytes(secrets_.encryptedIdentityKey)
        if not encrypted:
            raise E2EEError("The device has no E2EE key (encryptedIdentityKey)")
        cache_key = encrypted + secrets_.ownerKeyVersion.to_bytes(4, "big", signed=True)
        if cache_key in self._eik_cache:
            return self._eik_cache[cache_key]

        is_mcu = registration.fastPairModelId == mcu_fast_pair_model_id
        for refresh in (False, True):
            owner_key = await self.owner_key(force=refresh)
            # Custom (MCU) trackers have inverted bits - try both variants.
            for flip in (is_mcu, not is_mcu):
                try:
                    key = decrypt_eik(owner_key, flip_bits(encrypted, flip))
                except Exception:  # noqa: BLE001
                    continue
                self._eik_cache[cache_key] = key
                return key

        current = self.secrets.get("owner_key_version")
        raise E2EEError(
            f"Could not decrypt the tag key (tag ownerKeyVersion {secrets_.ownerKeyVersion}, "
            f"current {current}). If you reset your E2EE data, remove the tag and pair it again."
        )

    async def decrypt_metadata(self, metadata) -> list[Fix]:
        """All location reports from DeviceMetadata (from the device list or an FCM response)."""
        information = metadata.information
        reports = information.locationInformation.reports.recentLocationAndNetworkLocations

        pairs = list(zip(reports.networkLocations, reports.networkLocationTimestamps))
        if reports.HasField("recentLocation"):
            pairs.append((reports.recentLocation, reports.recentLocationTimestamp))
        if not pairs:
            return []

        registration = information.deviceRegistration
        is_mcu = registration.fastPairModelId == mcu_fast_pair_model_id
        identity_key: bytes | None = None
        if any(_is_geo(report) for report, _ in pairs):
            identity_key = await self.identity_key(registration)

        fixes: list[Fix] = []
        for report, timestamp in pairs:
            if not _is_geo(report):
                fixes.append(Fix(int(timestamp.seconds), None, None, None, None, report.status, True,
                                 report.semanticLocation.locationName or "?"))
                continue
            try:
                fix = await asyncio.to_thread(_decrypt_geo, identity_key, report, int(timestamp.seconds), is_mcu)
            except Exception as exc:  # noqa: BLE001
                log.warning("Could not decrypt report from %s: %s", timestamp.seconds, exc)
                continue
            fixes.append(fix)
        return fixes


def _is_geo(report) -> bool:
    return report.HasField("geoLocation") and report.status != SEMANTIC


def _decrypt_geo(identity_key: bytes, report, ts: int, is_mcu: bool) -> Fix:
    geo = report.geoLocation
    encrypted = bytes(geo.encryptedReport.encryptedLocation)
    public_key_random = bytes(geo.encryptedReport.publicKeyRandom)
    if not public_key_random:
        # Own report (from your phone): AES-GCM with key SHA256(EIK).
        plain = decrypt_aes_gcm(hashlib.sha256(identity_key).digest(), encrypted)
    else:
        # Report from the Find Hub network (other people's phones): ECDH on SECP160r1 + AES-EAX.
        offset = 0 if is_mcu else geo.deviceTimeOffset
        plain = decrypt_foreign_report(identity_key, encrypted, public_key_random, offset)
    location = DeviceUpdate_pb2.Location()
    location.ParseFromString(plain)
    return Fix(
        ts=ts,
        lat=location.latitude / 1e7,
        lon=location.longitude / 1e7,
        alt=float(location.altitude),
        accuracy=float(geo.accuracy) if geo.accuracy else None,
        status=int(report.status),
        is_own_report=bool(geo.encryptedReport.isOwnReport),
        semantic_name=None,
    )
