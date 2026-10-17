#!/bin/sh
set -e

# Wirtualny ekran, na którym startuje Chrome.
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Czekamy, aż ekran będzie gotowy (na wolnym serwerze `sleep 1` nie wystarcza).
DISPLAY_NUM="${DISPLAY#:}"
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
  sleep 0.2
done

# Serwer VNC tylko lokalnie w kontenerze; na zewnątrz wystawiony jest wyłącznie noVNC (websockify).
# Dostęp do noVNC kontroluje gateway (forward_auth do panelu), więc VNC nie ma osobnego hasła.
# Pętla: jeśli x11vnc się wywróci, wraca po sekundzie.
(
  while true; do
    x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 -noipv6 -quiet >>/tmp/x11vnc.log 2>&1 || true
    echo "x11vnc zakończył działanie - restart" >>/tmp/x11vnc.log
    sleep 1
  done
) &

# 127.0.0.1 zamiast localhost: localhost może wskazywać na IPv6 (::1), gdzie x11vnc nie nasłuchuje.
websockify --web /usr/share/novnc 7900 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &

exec python /srv/login_server.py
