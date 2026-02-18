#!/bin/bash
#
# Umbrel Kiosk - Universal Script
# Installation, configuration and removal
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Cheviiot/Umbrel-Kiosk/main/scripts/umbrel-kiosk.sh | sudo bash
#

set -e

# Open /dev/tty for interactive input (required when piped through curl)
exec 3</dev/tty

# ============================================================================
# CONFIGURATION
# ============================================================================

VERSION="1.2.0"
REPO_OWNER="Cheviiot"
REPO_NAME="Umbrel-Kiosk"
INSTALL_DIR="/opt/umbrel-kiosk"
KIOSK_USER="kiosk"
DEFAULT_URL="http://umbrel.local"
DEB_INSTALL_PATH="/usr/lib/umbrel-kiosk"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Read input from fd 3 (/dev/tty)
ask() {
    local prompt="$1"
    local var="$2"
    echo -n "$prompt"
    read $var <&3
}

print_banner() {
    clear
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                                                           ║"
    echo "║              🖥️  Umbrel Kiosk v$VERSION                    ║"
    echo "║                                                           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[→]${NC} ${BOLD}$1${NC}"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Запустите скрипт с правами root: sudo bash $0"
        exit 1
    fi
}

# Get actual user (not root when using sudo)
get_actual_user() {
    ACTUAL_USER="${SUDO_USER:-$USER}"
    ACTUAL_HOME=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)
}

# Check if kiosk is installed
is_installed() {
    [ -d "$INSTALL_DIR" ] || [ -f "/etc/systemd/system/getty@tty1.service.d/autologin.conf" ]
}

# ============================================================================
# MAIN MENU
# ============================================================================

show_menu() {
    print_banner
    
    echo -e "${BOLD}Выберите действие:${NC}"
    echo ""
    
    if is_installed; then
        echo -e "  ${GREEN}●${NC} Umbrel Kiosk установлен"
        echo ""
        echo "  1) 🔄 Переустановить"
        echo "  2) ⚙️  Изменить URL"
        echo "  3) 🔍 Проверить статус"
        echo "  4) 🗑️  Полностью удалить"
        echo "  5) 🔁 Перезагрузить систему"
        echo "  0) ❌ Выход"
    else
        echo -e "  ${YELLOW}○${NC} Umbrel Kiosk не установлен"
        echo ""
        echo "  1) 📥 Установить"
        echo "  0) ❌ Выход"
    fi
    
    echo ""
    ask "Ваш выбор: " choice
    
    if is_installed; then
        case $choice in
            1) install_kiosk ;;
            2) change_url ;;
            3) check_status ;;
            4) uninstall_kiosk ;;
            5) reboot_system ;;
            0) exit 0 ;;
            *) show_menu ;;
        esac
    else
        case $choice in
            1) install_kiosk ;;
            0) exit 0 ;;
            *) show_menu ;;
        esac
    fi
}

# ============================================================================
# DETECT SYSTEM
# ============================================================================

detect_system() {
    log_step "Определение системы..."
    
    # Detect OS
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_NAME="$NAME"
        OS_ID="$ID"
    else
        OS_NAME="Unknown"
        OS_ID="unknown"
    fi
    
    # Detect architecture
    ARCH=$(uname -m)
    
    # Detect package manager
    if command -v apt-get &> /dev/null; then
        PKG_MANAGER="apt"
    elif command -v dnf &> /dev/null; then
        PKG_MANAGER="dnf"
    elif command -v pacman &> /dev/null; then
        PKG_MANAGER="pacman"
    else
        PKG_MANAGER="unknown"
    fi
    
    log_info "OS: $OS_NAME | Arch: $ARCH | Package manager: $PKG_MANAGER"
}

# ============================================================================
# INSTALLATION
# ============================================================================

install_kiosk() {
    print_banner
    echo -e "${BOLD}📥 Установка Umbrel Kiosk (Wayland)${NC}"
    echo ""
    
    # Get URL
    ask "URL Umbrel (Enter = $DEFAULT_URL): " input_url
    UMBREL_URL="${input_url:-$DEFAULT_URL}"
    
    echo ""
    log_step "Начинаем установку..."
    echo ""
    
    detect_system
    install_dependencies
    setup_gpu_drivers
    create_kiosk_user
    download_kiosk
    setup_autologin
    
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ✅ Установка завершена!                      ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  📁 Директория: ${CYAN}$INSTALL_DIR${NC}"
    echo -e "  👤 Пользователь: ${CYAN}$KIOSK_USER${NC}"
    echo -e "  🌐 URL: ${CYAN}$UMBREL_URL${NC}"
    echo -e "  🖥️  Display: ${CYAN}Wayland (Cage)${NC}"
    echo ""
    echo -e "${YELLOW}⚠️  Для запуска киоска нужна перезагрузка!${NC}"
    echo ""
    
    ask "Перезагрузить сейчас? (y/n): " reboot_now
    if [[ "$reboot_now" =~ ^[Yy]$ ]]; then
        reboot
    else
        log_info "Перезагрузите позже: sudo reboot"
        echo ""
        ask "Нажмите Enter для продолжения..." _dummy
        show_menu
    fi
}

install_dependencies() {
    log_step "Установка зависимостей (Wayland + GPU драйверы)..."
    
    case $PKG_MANAGER in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            
            # Electron dependencies
            apt-get install -y -qq \
                curl wget libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
                libatspi2.0-0 libsecret-1-0 libgbm1 libasound2 libdrm2 \
                > /dev/null 2>&1
            
            # Wayland compositor and tools (NO X11!)
            apt-get install -y -qq \
                cage seatd libseat1 wlr-randr wayland-utils \
                > /dev/null 2>&1 || true
            
            # GPU drivers - Mesa DRI/Vulkan
            apt-get install -y -qq \
                mesa-utils \
                libgl1-mesa-dri \
                libegl1-mesa \
                libegl-mesa0 \
                libgles2-mesa \
                libgbm1 \
                libglx-mesa0 \
                mesa-vulkan-drivers \
                > /dev/null 2>&1 || true
            
            # VA-API hardware video acceleration
            apt-get install -y -qq \
                va-driver-all \
                intel-media-va-driver \
                i965-va-driver \
                libva2 libva-drm2 libva-wayland2 \
                > /dev/null 2>&1 || true
            
            # Firmware for Intel/AMD GPUs
            apt-get install -y -qq \
                firmware-misc-nonfree \
                firmware-amd-graphics \
                > /dev/null 2>&1 || true
            
            # Enable seatd for rootless Wayland
            systemctl enable seatd 2>/dev/null || true
            systemctl start seatd 2>/dev/null || true
            ;;
        dnf)
            dnf install -y -q \
                curl wget gtk3 libnotify nss \
                at-spi2-atk libsecret mesa-libgbm alsa-lib \
                cage seatd wlr-randr wayland-utils \
                mesa-dri-drivers mesa-libGL mesa-libEGL mesa-vulkan-drivers \
                libva-intel-driver intel-media-driver libva libva-utils \
                > /dev/null 2>&1 || true
            
            systemctl enable seatd 2>/dev/null || true
            systemctl start seatd 2>/dev/null || true
            ;;
        pacman)
            pacman -Sy --noconfirm --quiet \
                curl wget gtk3 libnotify nss \
                at-spi2-atk libsecret mesa alsa-lib \
                cage seatd wlr-randr wayland-utils \
                mesa vulkan-intel vulkan-radeon intel-media-driver \
                libva libva-utils libva-intel-driver \
                > /dev/null 2>&1 || true
            
            systemctl enable seatd 2>/dev/null || true
            systemctl start seatd 2>/dev/null || true
            ;;
        *)
            log_warn "Неизвестный пакетный менеджер, пропускаем зависимости"
            ;;
    esac
    
    log_info "Зависимости установлены"
}

# ============================================================================
# GPU OPTIMIZATION
# ============================================================================

setup_gpu_drivers() {
    log_step "Оптимизация GPU драйверов..."
    
    # Detect GPU type
    GPU_TYPE="unknown"
    if lspci 2>/dev/null | grep -qi "intel.*graphics\|intel.*gpu"; then
        GPU_TYPE="intel"
    elif lspci 2>/dev/null | grep -qi "amd\|radeon\|ati"; then
        GPU_TYPE="amd"
    elif lspci 2>/dev/null | grep -qi "nvidia"; then
        GPU_TYPE="nvidia"
    fi
    
    log_info "Обнаружен GPU: $GPU_TYPE"
    
    # Create GPU optimization config
    mkdir -p /etc/umbrel-kiosk
    cat > /etc/umbrel-kiosk/gpu.conf << EOF
# Umbrel Kiosk GPU Configuration
GPU_TYPE="$GPU_TYPE"

# Mesa environment
export MESA_GL_VERSION_OVERRIDE=4.5
export MESA_GLSL_VERSION_OVERRIDE=450
export vblank_mode=0

# VA-API (hardware video decode)
export LIBVA_DRIVER_NAME=auto

# Wayland native
export GDK_BACKEND=wayland
export QT_QPA_PLATFORM=wayland
export SDL_VIDEODRIVER=wayland
export CLUTTER_BACKEND=wayland
export MOZ_ENABLE_WAYLAND=1

# EGL instead of GLX
export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
EOF

    # Intel-specific optimizations
    if [ "$GPU_TYPE" = "intel" ]; then
        cat >> /etc/umbrel-kiosk/gpu.conf << 'EOF'

# Intel GPU optimizations
export INTEL_DEBUG=norbc
export LIBVA_DRIVER_NAME=iHD
EOF
    fi
    
    # AMD-specific optimizations
    if [ "$GPU_TYPE" = "amd" ]; then
        cat >> /etc/umbrel-kiosk/gpu.conf << 'EOF'

# AMD GPU optimizations  
export AMD_VULKAN_ICD=RADV
export RADV_PERFTEST=aco
export LIBVA_DRIVER_NAME=radeonsi
EOF
    fi
    
    # Create udev rule for GPU access
    cat > /etc/udev/rules.d/99-umbrel-kiosk-gpu.rules << EOF
# Allow kiosk user to access GPU/DRM
SUBSYSTEM=="drm", GROUP="video", MODE="0660"
KERNEL=="card[0-9]*", GROUP="video", MODE="0660"
KERNEL=="renderD[0-9]*", GROUP="video", MODE="0660"
EOF
    
    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger 2>/dev/null || true
    
    log_info "GPU драйверы настроены"
}

create_kiosk_user() {
    log_step "Создание пользователя $KIOSK_USER..."
    
    if id "$KIOSK_USER" &>/dev/null; then
        log_info "Пользователь уже существует"
    else
        useradd -m -s /bin/bash -G video,audio,seat,render "$KIOSK_USER" 2>/dev/null || \
        useradd -m -s /bin/bash -G video,audio "$KIOSK_USER" 2>/dev/null || true
        log_info "Пользователь создан"
    fi
    
    # Add to seat group for rootless Wayland
    usermod -aG seat "$KIOSK_USER" 2>/dev/null || true
    usermod -aG render "$KIOSK_USER" 2>/dev/null || true
    usermod -aG video "$KIOSK_USER" 2>/dev/null || true
    
    KIOSK_HOME="/home/$KIOSK_USER"
}

download_kiosk() {
    log_step "Скачивание Umbrel Kiosk DEB..."
    
    mkdir -p "$INSTALL_DIR"
    chmod 755 "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    
    # Get latest release info
    LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest" 2>/dev/null || echo "")
    
    if [ -n "$LATEST" ]; then
        DEB_URL=$(echo "$LATEST" | grep -o '"browser_download_url": "[^"]*\.deb"' | head -1 | cut -d'"' -f4)
        
        if [ -n "$DEB_URL" ]; then
            log_info "Скачиваем DEB пакет..."
            if curl -fsSL -o "umbrel-kiosk.deb" "$DEB_URL" 2>/dev/null; then
                log_info "DEB скачан, устанавливаем..."
                dpkg -i "umbrel-kiosk.deb" 2>/dev/null || true
                apt-get install -f -y -qq 2>/dev/null || true
                rm -f "umbrel-kiosk.deb"
                log_info "DEB пакет установлен"
                return
            fi
        fi
    fi
    
    log_warn "DEB недоступен, скачиваем исходники..."
    
    curl -fsSL "https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/main.tar.gz" | tar xz --strip-components=1
    
    # Install Node.js if needed
    if ! command -v node &> /dev/null; then
        log_info "Установка Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
        apt-get install -y -qq nodejs > /dev/null 2>&1
    fi
    
    npm install --production --silent 2>/dev/null
    log_info "Исходники установлены"
}

setup_autologin() {
    log_step "Настройка автозапуска (Wayland/Cage)..."
    
    KIOSK_HOME="/home/$KIOSK_USER"
    
    # Create main start script with GPU optimizations
    cat > "$INSTALL_DIR/start-kiosk.sh" << 'STARTSCRIPT'
#!/bin/bash

# Load GPU configuration
[ -f /etc/umbrel-kiosk/gpu.conf ] && source /etc/umbrel-kiosk/gpu.conf

# Wayland environment
export XDG_SESSION_TYPE=wayland
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_CURRENT_DESKTOP=wlroots
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

# Force Wayland for all toolkits
export QT_QPA_PLATFORM=wayland
export GDK_BACKEND=wayland
export SDL_VIDEODRIVER=wayland
export CLUTTER_BACKEND=wayland
export MOZ_ENABLE_WAYLAND=1
export ELECTRON_OZONE_PLATFORM_HINT=wayland

# GPU/Mesa settings
export MESA_GL_VERSION_OVERRIDE=4.5
export MESA_GLSL_VERSION_OVERRIDE=450
export LIBVA_DRIVER_NAME=auto
export vblank_mode=0

# Hide system cursor (software cursor used instead)
export WLR_NO_HARDWARE_CURSORS=1
export XCURSOR_SIZE=1
export XCURSOR_THEME=default

# Electron Wayland flags (auto-detect best settings)
ELECTRON_FLAGS="--ozone-platform-hint=auto \
    --enable-features=WaylandWindowDecorations,VaapiVideoDecoder \
    --disable-gpu-cursor \
    --ignore-gpu-blocklist \
    --no-sandbox \
    --disable-gpu-sandbox"

STARTSCRIPT

    # Add URL and execution part
    cat >> "$INSTALL_DIR/start-kiosk.sh" << EOF

UMBREL_URL="$UMBREL_URL"
cd $INSTALL_DIR

# Find and run umbrel-kiosk
if [ -x "/usr/lib/umbrel-kiosk/umbrel-kiosk" ]; then
    exec /usr/lib/umbrel-kiosk/umbrel-kiosk \$ELECTRON_FLAGS --url="\$UMBREL_URL"
elif [ -x "/opt/Umbrel Kiosk/umbrel-kiosk" ]; then
    exec "/opt/Umbrel Kiosk/umbrel-kiosk" \$ELECTRON_FLAGS --url="\$UMBREL_URL"
elif [ -f "package.json" ]; then
    exec npm start -- --url="\$UMBREL_URL"
else
    echo "Umbrel Kiosk not found!"
    sleep 10
fi
EOF
    
    chmod +x "$INSTALL_DIR/start-kiosk.sh"
    
    # Create Cage wrapper script (Wayland kiosk compositor for bare metal)
    cat > "$INSTALL_DIR/start-wayland.sh" << 'WAYLANDSCRIPT'
#!/bin/bash

# ============================================================================
# Umbrel Kiosk - Wayland Launcher (Bare Metal)
# Uses Cage compositor for kiosk mode
# ============================================================================

set -e

# Setup XDG runtime directory
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
if [ ! -d "$XDG_RUNTIME_DIR" ]; then
    mkdir -p "$XDG_RUNTIME_DIR"
    chmod 0700 "$XDG_RUNTIME_DIR"
fi

# Load GPU configuration
[ -f /etc/umbrel-kiosk/gpu.conf ] && source /etc/umbrel-kiosk/gpu.conf

# Wayland session
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=wlroots

# Disable screen blanking via DPMS
export WLR_DRM_NO_MODIFIERS=1

# Hide hardware/system cursor completely
export WLR_NO_HARDWARE_CURSORS=1
export XCURSOR_SIZE=1
export XCURSOR_THEME=default

# Try to detect best Wayland compositor
start_compositor() {
    # Cage - minimal Wayland compositor for kiosk
    if command -v cage &> /dev/null; then
        echo "[Umbrel Kiosk] Starting Cage compositor..."
        exec cage -ds -- /opt/umbrel-kiosk/start-kiosk.sh
    fi
    
    # Weston kiosk shell
    if command -v weston &> /dev/null; then
        echo "[Umbrel Kiosk] Starting Weston compositor..."
        exec weston --shell=kiosk-shell.so -- /opt/umbrel-kiosk/start-kiosk.sh
    fi
    
    # Sway (last resort, not ideal for kiosk)
    if command -v sway &> /dev/null; then
        echo "[Umbrel Kiosk] Starting Sway..."
        # Create minimal sway config
        mkdir -p ~/.config/sway
        cat > ~/.config/sway/config << 'SWAYCONF'
# Minimal kiosk config
output * bg #000000 solid_color
exec /opt/umbrel-kiosk/start-kiosk.sh
SWAYCONF
        exec sway
    fi
    
    echo "[Umbrel Kiosk] ERROR: No Wayland compositor found!"
    echo "Install cage: apt install cage"
    sleep 30
    exit 1
}

start_compositor
WAYLANDSCRIPT
    
    chmod +x "$INSTALL_DIR/start-wayland.sh"
    
    # Save URL for later
    echo "$UMBREL_URL" > "$INSTALL_DIR/.url"
    
    # Getty autologin on tty1
    mkdir -p /etc/systemd/system/getty@tty1.service.d/
    cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
Type=idle
EOF
    
    # Create .bash_profile for auto-start
    cat > "$KIOSK_HOME/.bash_profile" << 'BASHPROFILE'
# Umbrel Kiosk auto-start
if [ "$(tty)" = "/dev/tty1" ]; then
    # Setup XDG runtime directory
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null
    chmod 0700 "$XDG_RUNTIME_DIR" 2>/dev/null
    
    # Wait for DRM/GPU to be ready
    sleep 1
    
    # Start Wayland kiosk
    exec /opt/umbrel-kiosk/start-wayland.sh
fi
BASHPROFILE
    
    chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.bash_profile"
    chmod +x "$KIOSK_HOME/.bash_profile"
    
    systemctl daemon-reload
    systemctl enable getty@tty1.service >/dev/null 2>&1
    
    log_info "Автозапуск настроен (Wayland/Cage)"
}

# ============================================================================
# CHANGE URL
# ============================================================================

change_url() {
    print_banner
    echo -e "${BOLD}⚙️  Изменение URL${NC}"
    echo ""
    
    # Get current URL
    if [ -f "$INSTALL_DIR/.url" ]; then
        CURRENT_URL=$(cat "$INSTALL_DIR/.url")
        echo -e "Текущий URL: ${CYAN}$CURRENT_URL${NC}"
    fi
    
    echo ""
    ask "Новый URL: " new_url
    
    if [ -z "$new_url" ]; then
        log_warn "URL не изменён"
        ask "Нажмите Enter..." _dummy
        show_menu
        return
    fi
    
    # Update start script
    sed -i "s|--url=\"[^\"]*\"|--url=\"$new_url\"|g" "$INSTALL_DIR/start-kiosk.sh"
    echo "$new_url" > "$INSTALL_DIR/.url"
    
    log_info "URL изменён на: $new_url"
    echo ""
    echo -e "${YELLOW}Перезагрузите для применения: sudo reboot${NC}"
    echo ""
    
    ask "Нажмите Enter..." _dummy
    show_menu
}

# ============================================================================
# CHECK STATUS
# ============================================================================

check_status() {
    print_banner
    echo -e "${BOLD}🔍 Статус Umbrel Kiosk${NC}"
    echo ""
    
    # Installation
    if [ -d "$INSTALL_DIR" ]; then
        log_info "Директория: $INSTALL_DIR"
        
        if [ -x "/usr/lib/umbrel-kiosk/umbrel-kiosk" ]; then
            log_info "Тип: DEB пакет"
        elif [ -x "/opt/Umbrel Kiosk/umbrel-kiosk" ]; then
            log_info "Тип: DEB пакет (opt)"
        elif [ -f "$INSTALL_DIR/package.json" ]; then
            log_info "Тип: Source"
        fi
    else
        log_error "Не установлен"
    fi
    
    # URL
    if [ -f "$INSTALL_DIR/.url" ]; then
        log_info "URL: $(cat "$INSTALL_DIR/.url")"
    fi
    
    # User
    if id "$KIOSK_USER" &>/dev/null; then
        log_info "Пользователь: $KIOSK_USER существует"
    else
        log_warn "Пользователь: $KIOSK_USER не найден"
    fi
    
    # Autologin
    if [ -f "/etc/systemd/system/getty@tty1.service.d/autologin.conf" ]; then
        log_info "Автологин: настроен"
    else
        log_warn "Автологин: не настроен"
    fi
    
    # X11
    if command -v startx &> /dev/null; then
        log_info "X11: установлен"
    else
        log_warn "X11: не найден"
    fi
    
    # Running processes
    echo ""
    if pgrep -f "umbrel-kiosk" > /dev/null 2>&1; then
        log_info "Процесс: запущен"
    else
        log_warn "Процесс: не запущен"
    fi
    
    echo ""
    ask "Нажмите Enter..." _dummy
    show_menu
}

# ============================================================================
# UNINSTALL
# ============================================================================

uninstall_kiosk() {
    print_banner
    echo -e "${BOLD}🗑️  Удаление Umbrel Kiosk${NC}"
    echo ""
    echo -e "${YELLOW}Будут удалены:${NC}"
    echo "  - Приложение из $INSTALL_DIR"
    echo "  - Конфигурация автологина"
    echo "  - Настройки X11"
    echo ""
    
    ask "Вы уверены? (yes/no): " confirm
    
    if [ "$confirm" != "yes" ]; then
        log_info "Отменено"
        ask "Нажмите Enter..." _dummy
        show_menu
        return
    fi
    
    echo ""
    log_step "Остановка процессов..."
    pkill -f "umbrel-kiosk" 2>/dev/null || true
    pkill -u "$KIOSK_USER" Xorg 2>/dev/null || true
    sleep 1
    
    log_step "Удаление автологина..."
    rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
    rmdir /etc/systemd/system/getty@tty1.service.d 2>/dev/null || true
    systemctl daemon-reload
    
    log_step "Удаление конфигурации пользователя..."
    KIOSK_HOME="/home/$KIOSK_USER"
    
    # Only remove our files
    [ -f "$KIOSK_HOME/.xinitrc" ] && grep -q "umbrel-kiosk" "$KIOSK_HOME/.xinitrc" && rm -f "$KIOSK_HOME/.xinitrc"
    [ -f "$KIOSK_HOME/.bash_profile" ] && grep -q "startx" "$KIOSK_HOME/.bash_profile" && rm -f "$KIOSK_HOME/.bash_profile"
    rm -f "$KIOSK_HOME/.Xauthority"
    rm -rf "$KIOSK_HOME/.config/Umbrel-Kiosk"
    
    log_step "Удаление приложения..."
    rm -rf "$INSTALL_DIR"
    rm -f /usr/share/applications/umbrel-kiosk.desktop
    
    echo ""
    ask "Удалить пользователя $KIOSK_USER? (y/n): " del_user
    if [[ "$del_user" =~ ^[Yy]$ ]]; then
        userdel -r "$KIOSK_USER" 2>/dev/null || true
        log_info "Пользователь удалён"
    fi
    
    echo ""
    ask "Удалить X11 пакеты? (y/n): " del_pkgs
    if [[ "$del_pkgs" =~ ^[Yy]$ ]]; then
        apt-get remove -y xserver-xorg xinit openbox unclutter 2>/dev/null || true
        apt-get autoremove -y 2>/dev/null || true
        log_info "Пакеты удалены"
    fi
    
    systemctl restart getty@tty1.service 2>/dev/null || true
    
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ✅ Удаление завершено!                       ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    ask "Перезагрузить систему? (y/n): " reboot_now
    if [[ "$reboot_now" =~ ^[Yy]$ ]]; then
        reboot
    fi
    
    exit 0
}

# ============================================================================
# REBOOT
# ============================================================================

reboot_system() {
    print_banner
    echo -e "${BOLD}🔁 Перезагрузка системы${NC}"
    echo ""
    
    ask "Перезагрузить сейчас? (y/n): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        reboot
    fi
    
    show_menu
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    check_root
    get_actual_user
    show_menu
}

main
