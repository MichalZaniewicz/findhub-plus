#!/bin/sh
set -e

# Virtual display that Chrome runs on.
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Wait until the display is ready (`sleep 1` is not enough on a slow server).
DISPLAY_NUM="${DISPLAY#:}"
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
  sleep 0.2
done

# VNC server is local to the container only; only noVNC (websockify) is exposed.
# Access to noVNC is controlled by the gateway (forward_auth to the panel), so VNC has no separate password.
# Loop: if x11vnc crashes, it comes back after a second.
(
  while true; do
    x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 -noipv6 -quiet >>/tmp/x11vnc.log 2>&1 || true
    echo "x11vnc exited - restarting" >>/tmp/x11vnc.log
    sleep 1
  done
) &

# 127.0.0.1 instead of localhost: localhost may resolve to IPv6 (::1), where x11vnc does not listen.
websockify --web /usr/share/novnc 7900 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &

exec python /srv/login_server.py
