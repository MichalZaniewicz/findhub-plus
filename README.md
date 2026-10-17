# FindHub+

Google Find Hub na sterydach: samodzielna usługa w Docker Compose, która loguje się Twoim kontem Google,
cyklicznie odpytuje Twoje tagi Bluetooth (Chipolo, Pebblebee, Moto Tag itd.) i telefony z Find Hub,
odszyfrowuje ich lokalizacje (E2EE) i buduje z nich **własną historię lokalizacji** z mapą,
odtwarzaniem trasy i eksportem GPX / CSV / GeoJSON.

> **Uwaga:** Google nie udostępnia publicznego API Find Hub. Projekt korzysta z odtworzonego (reverse-engineered)
> protokołu z [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) (GPL-3.0). Może przestać działać
> bez ostrzeżenia, a korzystanie z niego jest na własne ryzyko (regulamin Google).

## Architektura

```
            ┌──────────── gateway (Caddy, :8080 / HTTPS) ────────────┐
przeglądarka│  /            -> app:8000                               │
            │  /novnc/*     -> login:7900  (tylko po zalogowaniu)     │
            └─────────────────────────────────────────────────────────┘
app    FastAPI: panel, API, poller, nasłuch FCM (push z lokalizacjami), deszyfrowanie E2EE
login  Chrome + Xvfb + noVNC: jednorazowe logowanie kontem Google widoczne w panelu
db     PostgreSQL 16: urządzenia i historia lokalizacji
```

Jak płyną dane: `app` wysyła żądanie lokalizacji do API Find Hub → Google odsyła raporty przez
Firebase Cloud Messaging → `app` odszyfrowuje je kluczami z Twojego konta i zapisuje w Postgresie.
Google **nie przechowuje historii** - historia zaczyna się w momencie uruchomienia FindHub+.

## Uruchomienie

Wymagania: serwer z Dockerem (domowy serwer / NAS / VPS), najlepiej amd64.
Na arm64 zamiast Google Chrome używany jest Chromium.

```bash
cp .env.example .env
# ustaw APP_PASSWORD (hasło do panelu), resztę możesz zostawić
docker compose up -d --build
```

Panel: `http://<adres-serwera>:8080`.

### Z gotowych obrazów (bez budowania)

GitHub Actions buduje obrazy (amd64 + arm64) przy każdym pushu do `main`:
`ghcr.io/michalzaniewicz/findhub-plus-{app,login,gateway}:latest`.

Wystarczy wkleić usługi i wolumeny z [deploy/docker-compose.yml](deploy/docker-compose.yml) do swojego
compose (bez `.env`), zmienić `APP_PASSWORD` i uruchomić. Usługi mają prefiks `findhub-`.
Panel: `http://<ip-serwera>:47821`.

```bash
docker compose pull && docker compose up -d
```

### Połączenie konta Google

1. Zaloguj się do panelu i kliknij **Połącz konto Google**.
2. W oknie pojawi się Chrome działający w kontenerze. Zaloguj się kontem, do którego są przypisane tagi (2FA działa).
3. Google poprosi o **blokadę ekranu telefonu z Androidem** (PIN / wzór / hasło). To odblokowuje klucze
   szyfrowania end-to-end - bez nich lokalizacji tagów nie da się odczytać.
4. Po chwili status zmieni się na „Gotowe” i ruszy pierwszy odczyt.

Wymaganie Google: na telefonie z Androidem musi być włączone Find Hub z lokalizowaniem offline
(„Znajdź urządzenie offline” / „Z siecią we wszystkich obszarach”).

Alternatywnie możesz w Ustawieniach wgrać `secrets.json` wygenerowany przez GoogleFindMyTools lub GoogleFindMy-HA.

**Loguj się z tej samej sieci, w której działa serwer** - Google potrafi unieważnić token, gdy żądania przychodzą
z innego IP niż logowanie. Kontener `login` działa obok `app`, więc to jest spełnione automatycznie.

## Konfiguracja (`.env`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `APP_PASSWORD` | - | hasło do panelu (wymagane) |
| `SITE_ADDRESS` | `:80` | domena dla automatycznego HTTPS (wtedy `HTTP_PORT=80`, `HTTPS_PORT=443`) |
| `HTTP_PORT` / `HTTPS_PORT` | `8080` / `8443` | porty na hoście |
| `POLL_INTERVAL_SECONDS` | `300` | co ile odpytywać (min. 60, można zmienić w panelu) |
| `DEVICE_DELAY_SECONDS` | `5` | przerwa między urządzeniami (limity Google) |
| `LOCATE_TIMEOUT_SECONDS` | `60` | ile czekać na odpowiedź push |
| `RETENTION_DAYS` | `0` | ile dni trzymać historię (0 = bez limitu) |

## Bezpieczeństwo

- `/data/secrets.json` (wolumen `app_data`) zawiera **aas_token** - praktycznie pełny dostęp do konta Google.
  Chroń serwer, rób kopie wolumenu z rozwagą, nie wystawiaj panelu publicznie bez HTTPS.
- Panel chroni jedno hasło (`APP_PASSWORD`); podgląd przeglądarki logowania (noVNC) jest dostępny tylko po zalogowaniu.
- Hasło Google i PIN wpisujesz bezpośrednio na stronach Google w kontenerze; aplikacja ich nie zapisuje.

## Ograniczenia

- Tagi Bluetooth raportują pozycję tylko wtedy, gdy są w pobliżu telefonu z Androidem (Twojego lub obcego,
  w zależności od ustawień sieci Find Hub). W pustym terenie punktów nie będzie.
- Odczyt telefonów z Androidem jest wspierany w miarę możliwości protokołu; głównym celem są tagi.
- Jeśli kiedyś zresetujesz dane E2EE w Find Hub, starsze tagi trzeba sparować ponownie.

## Rozwój

```
app/findhub/google/   klient Find Hub: tokeny, Nova/Spot API, FCM, deszyfrowanie
app/findhub/poller.py cykl odpytywania
app/findhub/routes.py REST API
app/static/           panel (Leaflet, bez builda)
login/                kontener logowania (Chrome + noVNC + mały serwer HTTP)
```

Kod GoogleFindMyTools jest pobierany w trakcie budowania obrazu z przypiętego commita
(`GFMT_COMMIT` w `app/Dockerfile`).

## Licencja

GPL-3.0 - obraz `app` zawiera kod [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) (GPL-3.0).
