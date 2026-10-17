# Kontener do jednorazowego logowania kontem Google:
# Chrome na wirtualnym ekranie (Xvfb), podgląd przez noVNC, sterowanie przez undetected-chromedriver.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=860 \
    PYTHONUNBUFFERED=1

# Na amd64 oficjalny Google Chrome (zalecany przez GoogleFindMyTools), na arm64 Chromium z Debiana.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      ca-certificates curl gnupg procps \
 && ARCH="$(dpkg --print-architecture)" \
 && if [ "$ARCH" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
           > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends google-chrome-stable ; \
    else \
      apt-get install -y --no-install-recommends chromium chromium-driver ; \
    fi \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /srv/requirements.txt
# setuptools dostarcza distutils, którego wciąż używa undetected-chromedriver.
RUN pip install --no-cache-dir setuptools -r /srv/requirements.txt

RUN useradd --create-home --shell /bin/bash chrome
COPY entrypoint.sh /srv/entrypoint.sh
COPY login_server.py /srv/login_server.py
# Usuwa ewentualne końce linii CRLF (pliki edytowane na Windowsie).
RUN sed -i 's/\r$//' /srv/entrypoint.sh && chmod +x /srv/entrypoint.sh

USER chrome
WORKDIR /home/chrome
EXPOSE 7900 8001
ENTRYPOINT ["/srv/entrypoint.sh"]
