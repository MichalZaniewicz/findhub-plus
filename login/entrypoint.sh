#!/bin/sh
set -e

# Wirtualny ekran, na którym startuje Chrome.
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 1

# Serwer VNC tylko lokalnie w kontenerze; na zewnątrz wystawiony jest wyłącznie noVNC (websockify).
# Dostęp do noVNC kontroluje gateway (forward_auth do panelu), więc VNC nie ma osobnego hasła.
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 7900 localhost:5900 >/tmp/websockify.log 2>&1 &

exec python /srv/login_server.py
