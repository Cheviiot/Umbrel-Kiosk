#!/bin/bash
set -e

echo "=========================================="
echo "  Umbrel Kiosk Test Environment"
echo "=========================================="

# Environment
export HOME=/home/kiosk
export DISPLAY=:0
export WLR_NO_HARDWARE_CURSORS=1
export XCURSOR_SIZE=1
export XDG_RUNTIME_DIR=/tmp/runtime-kiosk
mkdir -p $XDG_RUNTIME_DIR
chmod 700 $XDG_RUNTIME_DIR

# Start Xvfb (virtual framebuffer)
echo "[1/4] Starting Xvfb..."
Xvfb :0 -screen 0 1920x1080x24 &
sleep 2

# Start fluxbox (minimal window manager)
echo "[2/4] Starting Fluxbox..."
DISPLAY=:0 fluxbox &
sleep 1

# Start VNC server
echo "[3/4] Starting VNC server on :5900..."
x11vnc -display :0 -forever -shared -rfbport 5900 -bg -nopw -xkb

# Start noVNC
echo "[4/4] Starting noVNC on :6080..."
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &
sleep 2

echo ""
echo "============================================"
echo "  noVNC: http://localhost:6080/vnc.html"
echo "============================================"
echo ""

# Wait for Umbrel
UMBREL_URL="${UMBREL_URL:-http://umbrel.local}"
echo "Waiting for Umbrel at $UMBREL_URL..."
for i in $(seq 1 60); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$UMBREL_URL" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "✅ Umbrel is ready!"
        break
    fi
    echo "  Attempt $i/60... (HTTP: $HTTP_CODE)"
    sleep 2
done

# Start Kiosk
echo ""
echo "Starting Umbrel Kiosk..."
cd /app
# Run electron with --no-sandbox for Docker environment
exec su kiosk -c "DISPLAY=:0 npx electron . --url=$UMBREL_URL --no-sandbox --disable-gpu-sandbox"
