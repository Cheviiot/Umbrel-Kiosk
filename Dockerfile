FROM docker.io/dockurr/umbrel

# Install X11, VNC, noVNC and kiosk dependencies
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    xvfb \
    x11vnc \
    openbox \
    novnc \
    websockify \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    libatspi2.0-0 \
    libsecret-1-0 \
    libgbm1 \
    libasound2 \
    libdrm2 \
    libxkbcommon0 \
    curl \
    wget \
    ca-certificates \
    fuse \
    && rm -rf /var/lib/apt/lists/*

# Environment
ENV DISPLAY=:99
ENV RESOLUTION=1920x1080
ENV VNC_PASSWORD=kiosk
ENV UMBREL_URL=http://localhost:80

# Create kiosk directory
RUN mkdir -p /opt/umbrel-kiosk

# Create startup script
COPY <<'EOF' /start-all.sh
#!/bin/bash
set -e

# Start Xvfb (virtual display)
echo "🖥️  Starting virtual display..."
Xvfb $DISPLAY -screen 0 ${RESOLUTION}x24 &
sleep 2

# Start window manager
openbox &
sleep 1

# Start VNC server
echo "📺 Starting VNC server..."
x11vnc -display $DISPLAY -forever -shared -rfbport 5900 -passwd $VNC_PASSWORD -bg
sleep 1

# Start noVNC (web interface)
echo "🌐 Starting noVNC on port 6080..."
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &

# Start Umbrel in background
echo "☂️  Starting Umbrel..."
/run/entry.sh &
UMBREL_PID=$!

# Wait for Umbrel to be ready
echo "⏳ Waiting for Umbrel..."
for i in {1..60}; do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:80 2>/dev/null | grep -qE "200|302|301"; then
        echo "✅ Umbrel is ready!"
        break
    fi
    sleep 2
done

# Start kiosk
echo "🚀 Starting Kiosk..."
cd /opt/umbrel-kiosk

if [ ! -f "umbrel-kiosk.AppImage" ]; then
    echo "📦 Downloading Kiosk AppImage..."
    LATEST=$(curl -fsSL "https://api.github.com/repos/Cheviiot/Umbrel-Kiosk/releases/latest" 2>/dev/null)
    URL=$(echo "$LATEST" | grep -o '"browser_download_url": "[^"]*\.AppImage"' | head -1 | cut -d'"' -f4)
    if [ -n "$URL" ]; then
        curl -fsSL -o umbrel-kiosk.AppImage "$URL"
        chmod +x umbrel-kiosk.AppImage
    fi
fi

if [ -f "umbrel-kiosk.AppImage" ]; then
    # Extract AppImage (FUSE may not work in container)
    if [ ! -d "squashfs-root" ]; then
        ./umbrel-kiosk.AppImage --appimage-extract > /dev/null 2>&1
    fi
    ./squashfs-root/umbrel-kiosk --no-sandbox --url=$UMBREL_URL \
        --disable-gpu-compositing \
        --disable-software-rasterizer &
fi

echo ""
echo "════════════════════════════════════════════"
echo "  ✅ All services started!"
echo ""
echo "  🌐 Umbrel:     http://localhost:80"
echo "  📺 noVNC:      http://localhost:6080"
echo "  🔑 VNC Pass:   $VNC_PASSWORD"
echo "════════════════════════════════════════════"
echo ""

# Wait for Umbrel process
wait $UMBREL_PID
EOF

RUN chmod +x /start-all.sh

# Expose ports
EXPOSE 80 5900 6080

# Override entrypoint
ENTRYPOINT []
CMD ["/start-all.sh"]
