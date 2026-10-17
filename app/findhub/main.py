from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import Database
from .google.client import FindHubClient
from .google_login import LoginManager
from .poller import FixesSink, Poller
from .routes import api, public
from .secrets_store import SecretsStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = Database(settings.database_url)
    await db.connect()
    secrets = SecretsStore(settings.data_dir / "secrets.json")
    client = FindHubClient(secrets, FixesSink(db))
    poller = Poller(db, client, settings.poll_interval, settings.device_delay,
                    settings.locate_timeout, settings.retention_days)

    async def on_connected() -> None:
        poller.trigger()

    login = LoginManager(secrets, client, settings.login_service_url, on_connected)

    app.state.db, app.state.secrets, app.state.client = db, secrets, client
    app.state.poller, app.state.login = poller, login

    await client.start()
    await poller.start()
    try:
        yield
    finally:
        await poller.stop()
        await login.close()
        await client.stop()
        await db.close()


app = FastAPI(title="FindHub+", lifespan=lifespan, docs_url=None, redoc_url=None)
app.include_router(public)
app.include_router(api)
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
