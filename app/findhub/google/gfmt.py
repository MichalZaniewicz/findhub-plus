"""Imports low-level parts of GoogleFindMyTools (GPL-3.0, github.com/leonboe1/GoogleFindMyTools).

Only the protobufs, crypto and FCM client are used - none of their interactive flows (input()/exit()).
The code is fetched in the Dockerfile from a pinned commit into GFMT_PATH.
"""

import os
import sys

_GFMT_PATH = os.getenv("GFMT_PATH", "/opt/gfmt")
if _GFMT_PATH not in sys.path:
    sys.path.insert(0, _GFMT_PATH)

from Auth.firebase_messaging import (  # noqa: E402
    FcmPushClient,
    FcmPushClientConfig,
    FcmPushClientRunState,
    FcmRegisterConfig,
)
from FMDNCrypto.foreign_tracker_cryptor import decrypt as decrypt_foreign_report  # noqa: E402
from KeyBackup.cloud_key_decryptor import decrypt_aes_gcm, decrypt_eik, decrypt_owner_key  # noqa: E402
from KeyBackup.response_parser import get_fmdn_shared_key  # noqa: E402
from KeyBackup.shared_key_request import get_security_domain_request_url  # noqa: E402
from ProtoDecoders import Common_pb2, DeviceUpdate_pb2  # noqa: E402
from SpotApi.CreateBleDevice.config import mcu_fast_pair_model_id  # noqa: E402
from SpotApi.CreateBleDevice.util import flip_bits  # noqa: E402
from SpotApi.grpc_parser import GrpcParser  # noqa: E402

__all__ = [
    "Common_pb2",
    "DeviceUpdate_pb2",
    "FcmPushClient",
    "FcmPushClientConfig",
    "FcmPushClientRunState",
    "FcmRegisterConfig",
    "GrpcParser",
    "decrypt_aes_gcm",
    "decrypt_eik",
    "decrypt_foreign_report",
    "decrypt_owner_key",
    "flip_bits",
    "get_fmdn_shared_key",
    "get_security_domain_request_url",
    "mcu_fast_pair_model_id",
]
