# Etap 1: kod GoogleFindMyTools (protobufy, kryptografia FMDN, klient FCM) z przypiętego commita.
FROM python:3.12-slim-bookworm AS gfmt
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG GFMT_REPO=https://github.com/leonboe1/GoogleFindMyTools.git
ARG GFMT_COMMIT=d46e9528578015b51d3b84dd91bf8f16e9ab850f
RUN git init /gfmt \
 && cd /gfmt \
 && git remote add origin "$GFMT_REPO" \
 && git fetch --depth 1 origin "$GFMT_COMMIT" \
 && git checkout FETCH_HEAD \
 && rm -rf .git ESP32Firmware ZephyrFirmware

# Etap 2: aplikacja.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    GFMT_PATH=/opt/gfmt \
    DATA_DIR=/data
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=gfmt /gfmt /opt/gfmt
COPY findhub ./findhub
COPY static ./static

RUN mkdir -p /data
EXPOSE 8000
CMD ["uvicorn", "findhub.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
