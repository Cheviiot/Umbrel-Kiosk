#!/bin/bash
#
# Umbrel Kiosk - Universal Installer
# Installation, configuration and removal for Wayland kiosk systems
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Cheviiot/Umbrel-Kiosk/main/scripts/umbrel-kiosk.sh | sudo bash
#

set -e

# Open /dev/tty for interactive input (required when piped through curl)
exec 3</dev/tty 2>/dev/null || exec 3<&0

# ============================================================================
# CONFIGURATION
# ============================================================================

VERSION="1.2.0"
REPO_OWNER="Cheviiot"
REPO_NAME="Umbrel-Kiosk"
INSTALL_DIR="/opt/umbrel-kiosk"
KIOSK_USER="kiosk"
DEFAULT_URL="http://umbrel.local"

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

ask() {
    local prompt="$1"
    local var="$2"
    echo -n "$prompt"
    read "$var" <&3
}

print_banner() {
    clear
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                                                           ║"
    echo "║              🖥️  Umbrel Kiosk v${VERSION}                   ║"
    echo "║                    Wayland Edition                        ║"
    echo "║                                                           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info() { echo -e "${GREEN}[✓]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
log_error() { echo -e "${RED}[✗]${NC} $1"; }
log_step() { echo -e "${BLUE}[→]${NC} ${BOLD}$1${NC}"; }

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Запустите с правами root: sudo bash $0"
        exit 1
    fi
}

is_installed() {
    [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/start-kiosk.sh" ]
}

get_installed_url() {
    [ -f "$INSTALL_DIR/.url" ] && cat "$INSTALL_DIR/.url" || echo "$DEFAULT_URL"
}

# ============================================================================
# SYSTEM DETECTION
# ============================================================================

detect_system() {
    log_step "Определение системы..."
    
    # OS
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_NAME="$NAME"
        OS_ID="$ID"
    else
        OS_NAME="Unknown"
        OS_ID="unknown"
    fi
    
    # Architecture
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  ARCH_DEB="amd64" ;;
        aarch64) ARCH_DEB="arm64" ;;
        armv7l)  ARCH_DEB="armhf" ;;
        *)       ARCH_DEB="$ARCH" ;;
    esac
    
    # Package manager
    if command -v apt-get &>/dev/null; then
        PKG_MANAGER="apt"
    elif command -v dnf &>/dev/null; then
        PKG_MANAGER="dnf"
    elif command -v pacman &>/dev/null; then
        PKG_MANAGER="pacman"
    else
        PKG_MANAGER="unknown"
    fi
    
    # GPU
    GPU_TYPE="unknown"
    if lspci 2>/dev/null | grep -qi "intel.*graphics\|intel.*gpu"; then
        GPU_TYPE="intel"
    elif lspci 2>/dev/null | grep -qi "amd\|radeon"; then
        GPU_TYPE="amd"
    elif lspci 2>/dev/null | grep -qi "nvidia"; then
        GPU_TYPE="nvidia"
    elif grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
        GPU_TYPE="rpi"
    fi
    
    log_info "OS: $OS_NAME ($OS_ID) | Arch: $ARCH | GPU: $GPU_TYPE"
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
        echo -e "  ${CYAN}URL: $(get_installed_url)${NC}"
        echo ""
        echo "  1) 🔄 Переустановить"
        echo "  2) ⚙️  Изменить URL"
        echo "  3) 🔍 Статус"
        echo "  4) 📋 Логи"
        echo "  5) 🗑️  Удалить"
        echo "  6) 🔁 Перезагрузить"
        echo "  0) ❌ Выход"
    else
        echo -e "  ${YELLOW}○${NC} Umbrel Kiosk не установлен"
        echo ""
        echo "  1) 📥 Установить"
        echo "  0) ❌ Выход"
    fi
    
    echo ""
    ask "Выбор: " choice
    
    if is_installed; then
        case $choice in
            1) install_kiosk ;;
            2) change_url ;;
            3) check_status ;;
            4) show_logs ;;
            5) uninstall_kiosk ;;
            6) reboot_system ;;
            0) echo ""; exit 0 ;;
            *) show_menu ;;
        esac
    else
        case $choice in
            1) install_kiosk ;;
            0) echo ""; exit 0 ;;
            *) show_menu ;;
        esac
    fi
}

# ============================================================================
# INSTALLATION
# ============================================================================

install_kiosk() {
    print_banner
    echo -e "${BOLD}📥 Установка Umbrel Kiosk${NC}"
    echo ""
    
    # Get URL
    local current_url=$(get_installed_url)
    ask "URL Umbrel [${current_url}]: " input_url
    UMBREL_URL="${input_url:-$current_url}"
    
    echo ""
    log_step "Начинаем установку..."
    echo ""
    
    detect_system
    install_dependencies
    create_kiosk_user
    download_application
    setup_autostart
    
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ✅ Установка завершена!                      ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  📁 Путь:        ${CYAN}$INSTALL_DIR${NC}"
    echo -e "  👤 Пользователь: ${CYAN}$KIOSK_USER${NC}"
    echo -e "  🌐 URL:         ${CYAN}$UMBREL_URL${NC}"
    echo -e "  🖥️  Compositor:  ${CYAN}Cage (Wayland)${NC}"
    echo ""
    echo -e "${YELLOW}⚠️  Требуется перезагрузка!${NC}"
    echo ""
    
    ask "Перезагрузить сейчас? [y/N]: " reboot_now
    if [[ "$reboot_now" =~ ^[Yy]$ ]]; then
        log_info "Перезагрузка..."
        reboot
    else
        log_info "Перезагрузите позже: sudo reboot"
        echo ""
        ask "Enter для продолжения..." _
        show_menu
    fi
}

install_dependencies() {
    log_step "Установка зависимостей..."
    
    case $PKG_MANAGER in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            
            # Core Wayland + Electron dependencies
            apt-get install -y -qq \
                curl wget \
                cage seatd libseat1 wlr-randr \
                libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
                libatspi2.0-0 libsecret-1-0 libgbm1 libasound2 libdrm2 \
                2>/dev/null || true
            
            # GPU drivers
            apt-get install -y -qq \
                mesa-utils libgl1-mesa-dri libegl1-mesa libgles2-mesa \
                mesa-vulkan-drivers va-driver-all \
                2>/dev/null || true
            
            # Enable seatd
            systemctl enable --now seatd 2>/dev/null || true
            ;;
            
        dnf)
            dnf install -y -q \
                curl wget cage seatd wlr-randr \
                gtk3 libnotify nss at-spi2-atk libsecret mesa-libgbm alsa-lib \
                mesa-dri-drivers mesa-vulkan-drivers libva \
                2>/dev/null || true
            systemctl enable --now seatd 2>/dev/null || true
            ;;
            
        pacman)
            pacman -Sy --noconfirm \
                curl wget cage seatd wlr-randr \
                gtk3 libnotify nss at-spi2-atk libsecret mesa alsa-lib \
                vulkan-intel vulkan-radeon libva \
                2>/dev/null || true
            systemctl enable --now seatd 2>/dev/null || true
            ;;
            
        *)
            log_warn "Неизвестный пакетный менеджер"
            ;;
    esac
    
    log_info "Зависимости установлены"
}

create_kiosk_user() {
    log_step "Настройка пользователя $KIOSK_USER..."
    
    if ! id "$KIOSK_USER" &>/dev/null; then
        useradd -m -s /bin/bash "$KIOSK_USER" 2>/dev/null || true
        log_info "Пользователь создан"
    fi
    
    # Add to required groups
    for group in video audio seat render input; do
        usermod -aG "$group" "$KIOSK_USER" 2>/dev/null || true
    done
    
    KIOSK_HOME="/home/$KIOSK_USER"
    log_info "Пользователь настроен"
}

download_application() {
    log_step "Загрузка Umbrel Kiosk..."
    
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    
    # Try to download DEB package first
    local deb_downloaded=false
    
    LATEST_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest" 2>/dev/null || echo "")
    
    if [ -n "$LATEST_JSON" ]; then
        # Find DEB for our architecture
        DEB_URL=$(echo "$LATEST_JSON" | grep -o "\"browser_download_url\": \"[^\"]*_${ARCH_DEB}\.deb\"" | head -1 | cut -d'"' -f4)
        
        if [ -z "$DEB_URL" ]; then
            # Try generic deb
            DEB_URL=$(echo "$LATEST_JSON" | grep -o "\"browser_download_url\": \"[^\"]*\.deb\"" | head -1 | cut -d'"' -f4)
        fi
        
        if [ -n "$DEB_URL" ]; then
            log_info "Скачиваем DEB: $(basename "$DEB_URL")"
            if curl -fsSL -o "/tmp/umbrel-kiosk.deb" "$DEB_URL"; then
                dpkg -i "/tmp/umbrel-kiosk.deb" 2>/dev/null || true
                apt-get install -f -y -qq 2>/dev/null || true
                rm -f "/tmp/umbrel-kiosk.deb"
                deb_downloaded=true
                log_info "DEB пакет установлен"
            fi
        fi
    fi
    
    if [ "$deb_downloaded" = false ]; then
        log_warn "DEB недоступен, скачиваем исходники..."
        
        curl -fsSL "https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/main.tar.gz" | tar xz --strip-components=1
        
        # Install Node.js if needed
        if ! command -v node &>/dev/null; then
            log_info "Установка Node.js..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
            apt-get install -y -qq nodejs >/dev/null 2>&1
        fi
        
        npm install --production --silent 2>/dev/null || npm install --production
        log_info "Исходники установлены"
    fi
}

setup_autostart() {
    log_step "Настройка автозапуска..."
    
    KIOSK_HOME="/home/$KIOSK_USER"
    
    # Save URL
    echo "$UMBREL_URL" > "$INSTALL_DIR/.url"
    
    # ===== Main start script =====
    cat > "$INSTALL_DIR/start-kiosk.sh" << 'KIOSKSCRIPT'
#!/bin/bash
# Umbrel Kiosk - Application Launcher

# Environment
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

# Wayland for toolkits
export GDK_BACKEND=wayland
export QT_QPA_PLATFORM=wayland
export SDL_VIDEODRIVER=wayland
export MOZ_ENABLE_WAYLAND=1
export ELECTRON_OZONE_PLATFORM_HINT=auto

# GPU/Mesa
export MESA_GL_VERSION_OVERRIDE=4.5
export LIBVA_DRIVER_NAME=auto
export vblank_mode=0

# Electron flags
ELECTRON_FLAGS="--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --ignore-gpu-blocklist --enable-gpu-rasterization --disable-gpu-cursor --no-sandbox --disable-gpu-sandbox"

KIOSKSCRIPT

    # Add URL and execution
    cat >> "$INSTALL_DIR/start-kiosk.sh" << URLPART
UMBREL_URL="$UMBREL_URL"
cd "$INSTALL_DIR"

# Find executable
if [ -x "/usr/lib/umbrel-kiosk/umbrel-kiosk" ]; then
    exec /usr/lib/umbrel-kiosk/umbrel-kiosk \$ELECTRON_FLAGS --url="\$UMBREL_URL"
elif [ -x "/opt/Umbrel Kiosk/umbrel-kiosk" ]; then
    exec "/opt/Umbrel Kiosk/umbrel-kiosk" \$ELECTRON_FLAGS --url="\$UMBREL_URL"
elif [ -f "$INSTALL_DIR/package.json" ]; then
    exec npm start -- --url="\$UMBREL_URL"
else
    echo "ERROR: Umbrel Kiosk not found!"
    sleep 30
    exit 1
fi
URLPART
    chmod +x "$INSTALL_DIR/start-kiosk.sh"
    
    # ===== Cage (Wayland compositor) launcher =====
    cat > "$INSTALL_DIR/start-wayland.sh" << 'WAYLANDSCRIPT'
#!/bin/bash
# Umbrel Kiosk - Wayland Compositor Launcher

set -e

# Setup XDG runtime
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
chmod 0700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=wlroots

# Wait for GPU
sleep 1

# Launch Cage with cursor visible (-m flag)
# -d = enable DRM (direct rendering)
# -s = disable VT switching
# -m = show cursor (IMPORTANT for kiosk!)
if command -v cage &>/dev/null; then
    exec cage -dsm -- /opt/umbrel-kiosk/start-kiosk.sh
elif command -v weston &>/dev/null; then
    exec weston --shell=kiosk-shell.so -- /opt/umbrel-kiosk/start-kiosk.sh
else
    echo "ERROR: No Wayland compositor found! Install: apt install cage"
    sleep 30
    exit 1
fi
WAYLANDSCRIPT
    chmod +x "$INSTALL_DIR/start-wayland.sh"
    
    # ===== Getty autologin =====
    mkdir -p /etc/systemd/system/getty@tty1.service.d/
    cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << GETTYCONF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
Type=idle
StandardInput=tty
StandardOutput=tty
GETTYCONF
    
    # ===== User bash_profile for autostart =====
    cat > "$KIOSK_HOME/.bash_profile" << 'BASHPROFILE'
# Umbrel Kiosk autostart
if [ "$(tty)" = "/dev/tty1" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null
    chmod 0700 "$XDG_RUNTIME_DIR" 2>/dev/null
    
    # Wait for system
    sleep 2
    
    # Start kiosk
    exec /opt/umbrel-kiosk/start-wayland.sh
fi
BASHPROFILE
    chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.bash_profile"
    
    # Reload systemd
    systemctl daemon-reload
    systemctl enable getty@tty1.service >/dev/null 2>&1 || true
    
    log_info "Автозапуск настроен"
}

# ============================================================================
# CHANGE URL
# ============================================================================

change_url() {
    print_banner
    echo -e "${BOLD}⚙️  Изменение URL${NC}"
    echo ""
    
    local current_url=$(get_installed_url)
    echo -e "Текущий: ${CYAN}$current_url${NC}"
    echo ""
    
    ask "Новый URL: " new_url
    
    if [ -z "$new_url" ]; then
        log_warn "URL не изменён"
    else
        # Update in start script
        sed -i "s|UMBREL_URL=\"[^\"]*\"|UMBREL_URL=\"$new_url\"|g" "$INSTALL_DIR/start-kiosk.sh"
        echo "$new_url" > "$INSTALL_DIR/.url"
        log_info "URL изменён: $new_url"
        echo ""
        echo -e "${YELLOW}Перезагрузите для применения: sudo reboot${NC}"
    fi
    
    echo ""
    ask "Enter..." _
    show_menu
}

# ============================================================================
# STATUS & LOGS
# ============================================================================

check_status() {
    print_banner
    echo -e "${BOLD}🔍 Статус${NC}"
    echo ""
    
    # Installation type
    if [ -x "/usr/lib/umbrel-kiosk/umbrel-kiosk" ]; then
        log_info "Тип: DEB пакет (/usr/lib)"
    elif [ -x "/opt/Umbrel Kiosk/umbrel-kiosk" ]; then
        log_info "Тип: DEB пакет (/opt)"
    elif [ -f "$INSTALL_DIR/package.json" ]; then
        log_info "Тип: Source (npm)"
    else
        log_warn "Приложение не найдено"
    fi
    
    # URL
    log_info "URL: $(get_installed_url)"
    
    # User
    if id "$KIOSK_USER" &>/dev/null; then
        local groups=$(id -nG "$KIOSK_USER" 2>/dev/null | tr ' ' ',')
        log_info "Пользователь: $KIOSK_USER ($groups)"
    else
        log_warn "Пользователь $KIOSK_USER не найден"
    fi
    
    # Autologin
    if [ -f "/etc/systemd/system/getty@tty1.service.d/autologin.conf" ]; then
        log_info "Автологин: настроен"
    else
        log_warn "Автологин: не настроен"
    fi
    
    # Cage
    if command -v cage &>/dev/null; then
        log_info "Cage: $(cage --version 2>/dev/null || echo 'установлен')"
    else
        log_warn "Cage: не установлен"
    fi
    
    # Process
    echo ""
    if pgrep -f "umbrel-kiosk" >/dev/null 2>&1; then
        log_info "Процесс: запущен (PID $(pgrep -f 'umbrel-kiosk' | head -1))"
    else
        log_warn "Процесс: не запущен"
    fi
    
    if pgrep -x "cage" >/dev/null 2>&1; then
        log_info "Cage: запущен"
    fi
    
    echo ""
    ask "Enter..." _
    show_menu
}

show_logs() {
    print_banner
    echo -e "${BOLD}📋 Логи${NC}"
    echo ""
    
    # Last boot logs for kiosk user
    if command -v journalctl &>/dev/null; then
        echo -e "${CYAN}=== Системные логи (последние 30 строк) ===${NC}"
        journalctl -b -u "getty@tty1" --no-pager -n 30 2>/dev/null || echo "Нет логов"
        echo ""
    fi
    
    echo -e "${CYAN}=== Логи Cage ===${NC}"
    journalctl -b | grep -i cage | tail -20 2>/dev/null || echo "Нет логов"
    
    echo ""
    ask "Enter..." _
    show_menu
}

# ============================================================================
# UNINSTALL
# ============================================================================

uninstall_kiosk() {
    print_banner
    echo -e "${BOLD}🗑️  Удаление Umbrel Kiosk${NC}"
    echo ""
    echo -e "${YELLOW}Будет удалено:${NC}"
    echo "  - Приложение ($INSTALL_DIR)"
    echo "  - Автологин"
    echo "  - Конфигурация"
    echo ""
    
    ask "Подтвердите (yes): " confirm
    
    if [ "$confirm" != "yes" ]; then
        log_info "Отменено"
        ask "Enter..." _
        show_menu
        return
    fi
    
    echo ""
    
    # Stop processes
    log_step "Остановка процессов..."
    pkill -9 -f "umbrel-kiosk" 2>/dev/null || true
    pkill -9 -f "cage" 2>/dev/null || true
    sleep 1
    
    # Remove autologin
    log_step "Удаление автологина..."
    rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
    rmdir /etc/systemd/system/getty@tty1.service.d 2>/dev/null || true
    systemctl daemon-reload
    
    # Remove user configs
    log_step "Удаление конфигурации..."
    KIOSK_HOME="/home/$KIOSK_USER"
    rm -f "$KIOSK_HOME/.bash_profile"
    rm -rf "$KIOSK_HOME/.config/umbrel-kiosk"
    rm -rf "$KIOSK_HOME/.config/Umbrel-Kiosk"
    
    # Remove application
    log_step "Удаление приложения..."
    rm -rf "$INSTALL_DIR"
    rm -rf /etc/umbrel-kiosk
    
    # Remove DEB if installed
    dpkg -r umbrel-kiosk 2>/dev/null || true
    
    # Ask about user
    echo ""
    ask "Удалить пользователя $KIOSK_USER? [y/N]: " del_user
    if [[ "$del_user" =~ ^[Yy]$ ]]; then
        userdel -r "$KIOSK_USER" 2>/dev/null || true
        log_info "Пользователь удалён"
    fi
    
    # Ask about packages
    ask "Удалить Cage и зависимости? [y/N]: " del_pkgs
    if [[ "$del_pkgs" =~ ^[Yy]$ ]]; then
        apt-get remove -y cage seatd 2>/dev/null || true
        apt-get autoremove -y 2>/dev/null || true
        log_info "Пакеты удалены"
    fi
    
    echo ""
    echo -e "${GREEN}✅ Удаление завершено${NC}"
    echo ""
    
    ask "Перезагрузить? [y/N]: " reboot_now
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
    ask "Перезагрузить систему? [y/N]: " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        log_info "Перезагрузка..."
        reboot
    fi
    show_menu
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    check_root
    show_menu
}

main "$@"
