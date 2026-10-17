<div align="center">

<img src="docs/logo.svg" width="88" alt="FindHub+ logo">

# FindHub+

**Google Find Hub on steroids.**<br>
Self-hosted location history for your Bluetooth trackers and Android phones.

[![Build](https://github.com/MichalZaniewicz/findhub-plus/actions/workflows/docker.yml/badge.svg)](https://github.com/MichalZaniewicz/findhub-plus/actions/workflows/docker.yml)
[![Smoke test](https://github.com/MichalZaniewicz/findhub-plus/actions/workflows/smoke.yml/badge.svg)](https://github.com/MichalZaniewicz/findhub-plus/actions/workflows/smoke.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Images on ghcr.io](https://img.shields.io/badge/images-ghcr.io-6f42c1?logo=docker&logoColor=white)](https://github.com/MichalZaniewicz?tab=packages&repo_name=findhub-plus)
![amd64 | arm64](https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-555)

<img src="docs/screenshots/overview-dark.jpeg" alt="FindHub+ map with tags, zones and the device list" width="100%">

</div>

Google's Find Hub only shows where your things are **right now**. FindHub+ signs in with your Google account,
asks Find Hub for the location of your tags and phones every few minutes, decrypts the end-to-end encrypted
reports and stores them in **your own database**, so you get a full history: routes, stops, zones, alarms and more.
All of it runs as a small Docker Compose stack on your home server, NAS or VPS.

> [!WARNING]
> Google has **no public Find Hub API**. FindHub+ relies on the reverse-engineered protocol from
> [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools). It can stop working at any time, and using it
> may break Google's terms of service. Use it with your own account and your own devices only, at your own risk.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Connecting your Google account](#connecting-your-google-account)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Limitations](#limitations)
- [Development](#development)
- [Credits](#credits) · [License](#license)

## Features

### Live map and history

<img src="docs/screenshots/history-light.jpeg" alt="Route history with playback" width="100%">

- **Live map** of all your tags and phones. Fresh positions pulse, and accuracy circles show how precise each report is.
- **Location history** for any range (6 h, 24 h, 7 / 30 days or custom) with **route playback**, an accuracy filter and a list of every report.
- **Export** to GPX, CSV or GeoJSON.
- Every report is labelled by its source: your own phone, the crowdsourced Find Hub network, or a named place such as "Home".

### Stops, daily stats and heatmap

<img src="docs/screenshots/stops-dark.jpeg" alt="Automatically detected stops" width="100%">

- **Automatic stop detection**: where a device stayed for at least 10 minutes, for how long, and in which zone.
- **Per-day summary**: points, distance (with GPS jitter filtered out), number of stops, first and last time seen.
- **Heatmap** of where a device spends its time.

### Compare devices on one timeline

<img src="docs/screenshots/compare-dark.jpeg" alt="Several devices on a shared timeline" width="100%">

Pick any devices and scrub or play one shared timeline: every marker shows where that device was at that moment.

### Zones, alarms and events

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/zones-light.jpeg" alt="Drawing a zone on the map"></td>
    <td width="50%"><img src="docs/screenshots/alarms-light.jpeg" alt="Per-device alarms"></td>
  </tr>
  <tr>
    <td><b>Zones</b>: click the map to drop a circle (Home, Work, Gym…). You get an event when a device enters or leaves, and device cards show which zone they are in.</td>
    <td><b>Alarms per device</b>: "not seen for X hours" (plus an event when it shows up again), and <b>guard mode</b>, which alerts when a device moves away from its spot, optionally only at night (e.g. 22:00–06:00 for a bike).</td>
  </tr>
</table>

All alerts go to the **in-app event feed** (bell with an unread counter) and pop up while the panel is open.
Click an event to jump to that spot on the map.

<img src="docs/screenshots/events-dark.jpeg" alt="Event feed" width="100%">

### And also

<img src="docs/screenshots/mobile-dark.jpeg" alt="Mobile layout" width="260" align="right">

- 🔗 **Share links**: a read-only page with the current position (and last 6 hours of route) of selected devices, with an expiry time. Handy for family.
- 📱 **Works on phones**: the device list turns into a bottom sheet.
- 🌗 **Light and dark theme**, following your system (the map goes dark too).
- 🌍 **English, Polski, Deutsch, Español**, switchable in Settings. The Google sign-in page opens in the same language.
- 🔊 **Play sound** on a tag and **locate now** on demand.
- 🔐 **One Chrome sign-in in the browser**: no local Python, Chrome or copying tokens around.
- 🐳 **Prebuilt multi-arch images** (amd64 + arm64) on ghcr.io, tested end-to-end in CI with a real browser.

<br clear="right">

## Quick start

You need a machine with Docker that is **always on** (the history is only collected while FindHub+ runs).

### Option A: prebuilt images (recommended)

Paste these services into your `docker-compose.yml` (or save as a new one), **change `APP_PASSWORD`**, then run
`docker compose up -d`. The panel will be at **`http://<server-ip>:47821`**.

<details open>
<summary><code>docker-compose.yml</code></summary>

```yaml
services:
  findhub-gateway:
    image: ghcr.io/michalzaniewicz/findhub-plus-gateway:latest
    restart: unless-stopped
    depends_on:
      - findhub-app
    environment:
      APP_UPSTREAM: findhub-app:8000
      LOGIN_UPSTREAM: findhub-login:7900
    ports:
      - "47821:80"            # use "127.0.0.1:47821:80" to allow access only from the server itself
    volumes:
      - findhub_caddy_data:/data

  findhub-app:
    image: ghcr.io/michalzaniewicz/findhub-plus-app:latest
    restart: unless-stopped
    depends_on:
      findhub-db:
        condition: service_healthy
    environment:
      APP_PASSWORD: change-me             # panel password
      DATABASE_URL: postgresql://findhub:findhub@findhub-db:5432/findhub
      LOGIN_SERVICE_URL: http://findhub-login:8001
      POLL_INTERVAL_SECONDS: "300"        # how often to poll, can be changed in the panel
      RETENTION_DAYS: "0"                 # 0 = keep history forever
      TZ: Europe/Warsaw
    volumes:
      - findhub_app_data:/data

  findhub-login:
    image: ghcr.io/michalzaniewicz/findhub-plus-login:latest
    restart: unless-stopped
    shm_size: "1gb"
    environment:
      CHROME_LANG: en
      TZ: Europe/Warsaw

  findhub-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: findhub
      POSTGRES_PASSWORD: findhub          # reachable only on the Docker network
      POSTGRES_DB: findhub
    volumes:
      - findhub_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U findhub -d findhub"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  findhub_app_data:
  findhub_pg_data:
  findhub_caddy_data:
```

</details>

The same file lives in [`deploy/docker-compose.yml`](deploy/docker-compose.yml). All services are prefixed with
`findhub-`, so they won't clash with what you already run.

### Option B: build from source

```bash
git clone https://github.com/MichalZaniewicz/findhub-plus.git
cd findhub-plus
cp .env.example .env        # set APP_PASSWORD
docker compose up -d --build
```

The panel will be at `http://<server-ip>:8080`. For automatic HTTPS with Let's Encrypt, set `SITE_ADDRESS` to your
domain and map ports 80/443 (see [Configuration](#configuration)).

## Connecting your Google account

1. Open the panel, log in with `APP_PASSWORD` and click **Connect Google account**.
2. A real Chrome window, running inside the `findhub-login` container, appears in the dialog. Sign in with the
   account your tags belong to. 2FA works as usual.
3. At the end Google asks for your **Android phone's screen lock** (PIN, pattern or password). This unlocks the
   end-to-end encryption keys; without them the tag locations cannot be decrypted.
4. The status changes to **Done** and the first update starts within seconds.

Before you start:

- Find Hub must be set up on an Android phone signed in to the same account, with **offline finding** enabled
  ("Find your offline devices" → "With network in all areas" or "In high-traffic areas").
- Sign in from the **same network** the server runs on. Google may revoke tokens used from a different IP than the
  sign-in. The login container runs next to the app, so this is normally taken care of for you.
- Already using GoogleFindMyTools or GoogleFindMy-HA? You can upload their `secrets.json` in **Settings** instead.

Your Google password and PIN are typed directly into Google's own pages. FindHub+ only keeps the resulting tokens and
keys, in `/data/secrets.json`.

## How it works

```mermaid
flowchart LR
    U([You]) -->|browser :47821| G[gateway<br/>Caddy]
    G -->|panel & API| A[app<br/>FastAPI · poller · decryption]
    G -->|"/novnc (after panel login)"| L[login<br/>Chrome · Xvfb · noVNC]
    L -->|one-time sign-in| ACC[(accounts.google.com)]
    A -->|locate request| FH[(Find Hub API)]
    FH -.->|encrypted reports<br/>via FCM push| A
    A --> DB[(PostgreSQL<br/>history)]
```

1. **Sign-in.** The `login` container drives a real Chrome that you see through noVNC. It captures a one-time
   OAuth token and the encrypted key vault, unlocked by your phone's screen lock.
2. **Polling.** Every few minutes `app` lists your devices and sends a *locate* request for each one, one device at
   a time, to respect Google's rate limits.
3. **Push.** Google answers through Firebase Cloud Messaging. Reports from your own phone and from other people's
   phones in the Find Hub network arrive encrypted.
4. **Decryption.** `app` derives each tracker's key from your account's owner key and decrypts the reports locally.
   Google never sees the coordinates in plain text, and neither does anyone else.
5. **History.** Every new report is stored in Postgres, deduplicated, and checked against your zones and alarms.

## Configuration

Option A sets everything inline in the compose file. When building from source, use `.env`:

| Variable | Default | Description |
|---|---|---|
| `APP_PASSWORD` | – | Panel password (**required**) |
| `POLL_INTERVAL_SECONDS` | `300` | How often to poll devices (min. 60). Also adjustable in the panel |
| `DEVICE_DELAY_SECONDS` | `5` | Pause between devices within one cycle |
| `LOCATE_TIMEOUT_SECONDS` | `60` | How long to wait for a push response |
| `RETENTION_DAYS` | `0` | Delete history older than this (0 = keep forever) |
| `TZ` | `Europe/Warsaw` | Time zone used for daily stats and guard-mode hours |
| `CHROME_LANG` | `en` | Default language of the Google sign-in page |
| `SITE_ADDRESS` | `:80` | Set to a domain (e.g. `findhub.example.com`) for automatic HTTPS |
| `HTTP_PORT` / `HTTPS_PORT` | `8080` / `8443` | Host ports (build-from-source compose only) |
| `SESSION_SECRET` | auto | Cookie signing key; generated and stored in `/data` if empty |

Bluetooth tags only report when they are near an Android phone, so polling more often than every few minutes
rarely brings more points.

## Updating

```bash
docker compose pull && docker compose up -d
```

Your history, account connection and settings live in volumes and are kept. Database migrations run automatically
on start.

## Troubleshooting

<details>
<summary><b>The sign-in window says "Failed to connect to server" or hangs on "Connecting…"</b></summary>

Update to the latest images (`docker compose pull`) and reload the page. Then click **Start over** in the dialog,
which opens a fresh connection. If it still fails, check `docker compose logs findhub-login findhub-gateway`.
</details>

<details>
<summary><b>A tag shows "Google returned no location reports" or "No response"</b></summary>

The tag hasn't been near any Android phone recently, so there is nothing new to report. Points appear as soon as
it passes one. Make sure offline finding is set to **"With network in all areas"** if you want reports from other
people's phones.
</details>

<details>
<summary><b>"Google rejected the token" or "Google is rejecting requests (401)"</b></summary>

Google revoked the session. This usually happens after a password change, a security check, or when the token
was used from another network. Open **Settings → Reconnect**.
</details>

<details>
<summary><b>"Could not decrypt the tag key"</b></summary>

The end-to-end encryption data was reset in Find Hub (for example, after resetting all phones). Remove the tag
from Find Hub and pair it again.
</details>

<details>
<summary><b>The share link doesn't open for my family</b></summary>

Share links work for anyone who can reach your server. If the panel is only reachable on your LAN, so are the
links. Put FindHub+ behind HTTPS (set `SITE_ADDRESS` or use your reverse proxy) to share outside your network.
</details>

## Security

- `/data/secrets.json` (the `findhub_app_data` volume) contains an **aas_token**, which is effectively full access
  to your Google account. Keep the server and its backups safe.
- The panel is protected by a single password. Don't expose it to the internet without HTTPS.
- The noVNC view of the sign-in browser is only reachable after logging in to the panel.
- Share links are random, read-only, limited to the devices you pick, and can expire or be revoked at any time.

## Limitations

- Tags only report when they are near an Android phone. In empty areas there will be gaps.
- Accuracy varies a lot (from ~10 m up to kilometres). Analyses ignore reports worse than 300 m.
- Android phones are supported as far as the protocol allows; trackers are the main focus.
- Only the Google account that owns the devices is supported (shared devices may work, but aren't tested).

## Development

```
app/findhub/            FastAPI app: API, poller, alarms, stats, database
app/findhub/google/     Find Hub client: tokens, Nova/Spot API, FCM, E2EE decryption
app/static/             panel (vanilla JS + Leaflet, no build step), i18n.js has all translations
login/                  sign-in container: Chrome + Xvfb + noVNC + a tiny HTTP API
gateway/                Caddy config (auth for noVNC, optional HTTPS)
.github/                image builds and the end-to-end smoke test (amd64 + arm64, real browser)
```

The GoogleFindMyTools code (protobufs, crypto, FCM client) is pulled from a pinned commit at build time
(`GFMT_COMMIT` in `app/Dockerfile`). Adding a language means adding one more dictionary to
[`app/static/i18n.js`](app/static/i18n.js).

## Credits

- [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) by Leon Böttger, who reverse-engineered the
  Find Hub protocol, crypto and FCM flow that this project builds on.
- [GoogleFindMy-HA](https://github.com/BSkando/GoogleFindMy-HA), whose containerised Chrome + noVNC login inspired ours.
- [Leaflet](https://leafletjs.com), [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat),
  [Lucide](https://lucide.dev) icons and [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.

FindHub+ is not affiliated with or endorsed by Google. "Find Hub" is a trademark of Google LLC.

## License

[GPL-3.0](LICENSE). The `app` image includes code from GoogleFindMyTools, which is GPL-3.0 as well.
