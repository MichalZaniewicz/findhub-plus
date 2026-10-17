"""Wysokopoziomowy klient Find Hub: lista urządzeń, lokalizowanie (odpowiedź przez FCM push), dźwięk."""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from ..secrets_store import SecretsStore
from .api import GoogleApi
from .crypto import E2EE, Fix
from .gfmt import (
    DeviceUpdate_pb2,
    FcmPushClient,
    FcmPushClientConfig,
    FcmPushClientRunState,
    FcmRegisterConfig,
)
from .tokens import TokenManager

log = logging.getLogger(__name__)

FCM_PAYLOAD_KEY = "com.google.android.apps.adm.FCM_PAYLOAD"

# Konfiguracja Firebase aplikacji Find Hub - odpowiedzi na żądania lokalizacji przychodzą jako push.
FCM_CONFIG = FcmRegisterConfig(
    project_id="google.com:api-project-289722593072",
    app_id="1:289722593072:android:3cfcf5bc359f0308",
    api_key="AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc",
    messaging_sender_id="289722593072",
    bundle_id="com.google.android.apps.adm",
    android_package="com.google.android.apps.adm",
    android_cert_sha1="38918a453d07199354f8b19af05ec6562ced5788",
)

SPOT_TYPE_NAMES = {
    v.number: v.name.removeprefix("DEVICE_TYPE_").lower()
    for v in DeviceUpdate_pb2.SpotDeviceType.DESCRIPTOR.values
}


@dataclass
class DeviceInfo:
    id: str
    name: str
    kind: str
    device_type: str | None
    model: str | None
    manufacturer: str | None
    image_url: str | None
    fixes: list[Fix] = field(default_factory=list)
    error: str | None = None

    def as_row(self) -> dict:
        return {
            "id": self.id, "name": self.name, "kind": self.kind, "device_type": self.device_type,
            "model": self.model, "manufacturer": self.manufacturer, "image_url": self.image_url,
        }


def canonic_ids(metadata) -> list[str]:
    ident = metadata.identifierInformation
    if ident.type == DeviceUpdate_pb2.IDENTIFIER_ANDROID:
        ids = ident.phoneInformation.canonicIds.canonicId
    else:
        ids = ident.canonicIds.canonicId
    return [c.id for c in ids if c.id]


FixesCallback = Callable[[str, list[Fix]], Awaitable[int]]


class FindHubClient:
    def __init__(self, secrets: SecretsStore, on_fixes: FixesCallback):
        self.secrets = secrets
        self.tokens = TokenManager(secrets)
        self.api = GoogleApi(self.tokens)
        self.e2ee = E2EE(secrets, self.api)
        self._on_fixes = on_fixes
        self._pending: dict[str, tuple[str, asyncio.Future]] = {}
        self._fcm: FcmPushClient | None = None
        self._fcm_lock = asyncio.Lock()
        self._client_uuid = str(uuid.uuid4())
        self._watchdog: asyncio.Task | None = None
        self.fcm_error: str | None = None

    # --- cykl życia ----------------------------------------------------------------------
    async def start(self) -> None:
        try:
            await self.ensure_fcm()
        except Exception:  # noqa: BLE001
            pass  # watchdog spróbuje ponownie
        self._watchdog = asyncio.create_task(self._fcm_watchdog())

    async def stop(self) -> None:
        if self._watchdog:
            self._watchdog.cancel()
        if self._fcm:
            await self._fcm.stop()
        await self.api.close()

    @property
    def connected(self) -> bool:
        return self.secrets.connected

    @property
    def fcm_running(self) -> bool:
        return bool(self._fcm and self._fcm.is_started())

    @property
    def _fcm_alive(self) -> bool:
        return bool(self._fcm) and self._fcm.run_state not in (
            FcmPushClientRunState.CREATED, FcmPushClientRunState.STOPPING, FcmPushClientRunState.STOPPED)

    def reset_auth(self) -> None:
        self.tokens.reset()
        self.e2ee.reset()

    # --- FCM -----------------------------------------------------------------------------
    async def ensure_fcm(self, restart: bool = False) -> None:
        async with self._fcm_lock:
            if not restart and self._fcm_alive:
                return
            if self._fcm:
                await self._fcm.stop()
            self._fcm = FcmPushClient(
                self._on_notification,
                FCM_CONFIG,
                self.secrets.get("fcm_credentials"),
                self._on_credentials,
                config=FcmPushClientConfig(abort_on_sequential_error_count=None, connection_retry_count=20),
            )
            try:
                await self._fcm.checkin_or_register()
                await self._fcm.start()
                self.fcm_error = None
                log.info("FCM: nasłuch uruchomiony")
            except Exception as exc:  # noqa: BLE001
                self.fcm_error = str(exc)
                log.exception("FCM: rejestracja nie powiodła się")
                raise

    async def _fcm_watchdog(self) -> None:
        while True:
            await asyncio.sleep(60)
            if self._fcm_alive:
                continue
            log.warning("FCM: nasłuch nieaktywny - restart")
            try:
                await self.ensure_fcm(restart=True)
            except Exception:  # noqa: BLE001
                pass

    def _on_credentials(self, credentials: dict) -> None:
        self.secrets.update(fcm_credentials=credentials)

    @property
    def fcm_token(self) -> str:
        return self.secrets.get("fcm_credentials")["fcm"]["registration"]["token"]

    def _on_notification(self, data, _persistent_id, _ctx) -> None:
        if not isinstance(data, dict) or FCM_PAYLOAD_KEY not in data.get("data", {}):
            return
        try:
            raw = base64.b64decode(data["data"][FCM_PAYLOAD_KEY])
            update = DeviceUpdate_pb2.DeviceUpdate()
            update.ParseFromString(raw)
        except Exception:  # noqa: BLE001
            log.exception("FCM: nie można sparsować DeviceUpdate")
            return
        asyncio.get_running_loop().create_task(self._handle_update(update))

    async def _handle_update(self, update) -> None:
        request_uuid = update.fcmMetadata.requestUuid
        pending = self._pending.get(request_uuid)
        ids = canonic_ids(update.deviceMetadata)
        device_id = pending[0] if pending else (ids[0] if ids else None)
        try:
            fixes = await self.e2ee.decrypt_metadata(update.deviceMetadata)
        except Exception as exc:  # noqa: BLE001
            if pending and not pending[1].done():
                pending[1].set_exception(exc)
            else:
                log.warning("FCM: nie udało się odszyfrować aktualizacji %s: %s", device_id, exc)
            return
        inserted = await self._on_fixes(device_id, fixes) if device_id else 0
        if pending and not pending[1].done():
            pending[1].set_result((fixes, inserted))

    # --- operacje ------------------------------------------------------------------------
    async def list_devices(self) -> list[DeviceInfo]:
        request = DeviceUpdate_pb2.DevicesListRequest()
        request.deviceListRequestPayload.type = DeviceUpdate_pb2.DeviceType.SPOT_DEVICE
        request.deviceListRequestPayload.id = str(uuid.uuid4())
        raw = await self.api.nova("nbe_list_devices", request.SerializeToString())
        devices_list = DeviceUpdate_pb2.DevicesList()
        devices_list.ParseFromString(raw)

        result: list[DeviceInfo] = []
        for metadata in devices_list.deviceMetadata:
            ids = canonic_ids(metadata)
            if not ids:
                continue
            registration = metadata.information.deviceRegistration
            is_android = metadata.identifierInformation.type == DeviceUpdate_pb2.IDENTIFIER_ANDROID
            info = DeviceInfo(
                id=ids[0],
                name=metadata.userDefinedDeviceName or ids[0][:8],
                kind="android" if is_android else "tracker",
                device_type=None if is_android else SPOT_TYPE_NAMES.get(
                    registration.deviceTypeInformation.deviceType),
                model=registration.model or None,
                manufacturer=registration.manufacturer or None,
                image_url=metadata.imageInformation.imageUrl or None,
            )
            # Lista urządzeń często zawiera już ostatnie raporty - odszyfrowujemy je od razu.
            try:
                info.fixes = await self.e2ee.decrypt_metadata(metadata)
            except Exception as exc:  # noqa: BLE001
                info.error = str(exc)
            result.append(info)
        return result

    def _action_request(self, device_id: str, request_uuid: str):
        action = DeviceUpdate_pb2.ExecuteActionRequest()
        action.scope.type = DeviceUpdate_pb2.DeviceType.SPOT_DEVICE
        action.scope.device.canonicId.id = device_id
        action.requestMetadata.type = DeviceUpdate_pb2.DeviceType.SPOT_DEVICE
        action.requestMetadata.requestUuid = request_uuid
        action.requestMetadata.fmdClientUuid = self._client_uuid
        action.requestMetadata.gcmRegistrationId.id = self.fcm_token
        action.requestMetadata.unknown = True
        return action

    async def locate(self, device_id: str, timeout: float) -> tuple[list[Fix], int]:
        """Wysyła żądanie lokalizacji; wynik przychodzi przez FCM i jest od razu zapisywany.

        Zwraca (odszyfrowane raporty, liczba nowych punktów w bazie).
        """
        await self.ensure_fcm()
        request_uuid = str(uuid.uuid4())
        action = self._action_request(device_id, request_uuid)
        action.action.locateTracker.lastHighTrafficEnablingTime.seconds = 1732120060
        action.action.locateTracker.contributorType = DeviceUpdate_pb2.SpotContributorType.FMDN_ALL_LOCATIONS

        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_uuid] = (device_id, future)
        try:
            await self.api.nova("nbe_execute_action", action.SerializeToString())
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_uuid, None)

    async def play_sound(self, device_id: str, start: bool = True) -> None:
        await self.ensure_fcm()
        action = self._action_request(device_id, str(uuid.uuid4()))
        component = DeviceUpdate_pb2.DeviceComponent.DEVICE_COMPONENT_UNSPECIFIED
        if start:
            action.action.startSound.component = component
        else:
            action.action.stopSound.component = component
        await self.api.nova("nbe_execute_action", action.SerializeToString())
