#!/bin/bash

#===============================================================================
#
#   UmbrelOS Russian Localization Script v1.0
#   
#   Добавляет полноценную поддержку русского языка в UmbrelOS:
#   - Устанавливает файл перевода ru.json
#   - Патчит index bundle для добавления русского в список языков
#
#   Использование: sudo ./umbrel-russify.sh
#
#   Тестировано на: UmbrelOS 1.x (umbreld)
#   Перевод: полный перевод 1145 ключей
#   Репозиторий: https://github.com/Cheviiot/UmbrelOS-Rus
#
#===============================================================================

set -e

# Version
VERSION="1.1.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Russian translation URL
RU_JSON_URL="https://raw.githubusercontent.com/Cheviiot/UmbrelOS-Rus/main/locales/ru.json"

# Paths
UI_PATH=""
LOCALES_PATH=""
ASSETS_PATH=""
INDEX_FILE=""

# Logging
log() { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "${BOLD}${BLUE}==>${NC} $1"; }

print_banner() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}                                                               ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}       ${BOLD}🇷🇺 UmbrelOS Russian Localization v${VERSION} 🇷🇺${NC}        ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}                                                               ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}       Полноценное добавление русского языка в UmbrelOS        ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}                                                               ${CYAN}║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        error "Этот скрипт требует прав root. Запустите: sudo $0"
    fi
}

detect_umbrel() {
    step "Поиск UmbrelOS..."
    
    # Primary path for modern UmbrelOS (umbreld)
    local primary_paths=(
        "/opt/umbreld/ui"
        "/home/umbrel/umbrel/packages/ui/dist"
        "/home/umbrel/umbrel/ui/dist"
        "/opt/umbrel/ui"
    )
    
    for path in "${primary_paths[@]}"; do
        if [[ -d "$path/locales" ]] && [[ -d "$path/assets" ]]; then
            UI_PATH="$path"
            LOCALES_PATH="$path/locales"
            ASSETS_PATH="$path/assets"
            success "UmbrelOS UI найден: $UI_PATH"
            return 0
        fi
    done
    
    # Fallback: search for en.json
    log "Поиск файлов локализации..."
    local found_path=""
    for search_dir in /opt /home /data /mnt; do
        if [[ -d "$search_dir" ]]; then
            found_path=$(find "$search_dir" -maxdepth 8 -name "en.json" -path "*/locales/*" 2>/dev/null | grep -vE "(node_modules|\.npm|backup)" | head -1)
            if [[ -n "$found_path" ]]; then
                LOCALES_PATH=$(dirname "$found_path")
                UI_PATH=$(dirname "$LOCALES_PATH")
                ASSETS_PATH="$UI_PATH/assets"
                success "Найдена локализация: $LOCALES_PATH"
                return 0
            fi
        fi
    done
    
    error "UmbrelOS не найден.

Варианты решения:
  1. Убедитесь, что UmbrelOS установлен
  2. Укажите путь вручную:
     UI_PATH=/path/to/ui sudo $0

Ожидаемая структура:
  /opt/umbreld/ui/
  ├── assets/
  │   └── index-*.js
  └── locales/
      ├── en.json
      └── ru.json (будет создан)"
}

find_index_bundle() {
    step "Поиск index bundle..."
    
    if [[ ! -d "$ASSETS_PATH" ]]; then
        error "Папка assets не найдена: $ASSETS_PATH"
    fi
    
    # Find index-*.js file
    INDEX_FILE=$(find "$ASSETS_PATH" -maxdepth 1 -name "index-*.js" -type f 2>/dev/null | head -1)
    
    if [[ -z "$INDEX_FILE" ]] || [[ ! -f "$INDEX_FILE" ]]; then
        # Try alternative patterns
        INDEX_FILE=$(find "$ASSETS_PATH" -maxdepth 1 -name "main-*.js" -type f 2>/dev/null | head -1)
    fi
    
    if [[ -z "$INDEX_FILE" ]] || [[ ! -f "$INDEX_FILE" ]]; then
        error "Index bundle не найден в $ASSETS_PATH"
    fi
    
    success "Index bundle: $(basename "$INDEX_FILE")"
}

download_russian_locale() {
    step "Загрузка русского перевода..."
    
    local tmp_file="/tmp/ru.json"
    
    # Download
    if command -v curl &> /dev/null; then
        curl -fsSL "$RU_JSON_URL" -o "$tmp_file" 2>/dev/null || error "Не удалось загрузить ru.json"
    elif command -v wget &> /dev/null; then
        wget -q "$RU_JSON_URL" -O "$tmp_file" 2>/dev/null || error "Не удалось загрузить ru.json"
    else
        error "Требуется curl или wget"
    fi
    
    # Verify
    if [[ ! -f "$tmp_file" ]] || [[ ! -s "$tmp_file" ]]; then
        error "Загруженный файл пуст или не существует"
    fi
    
    # Validate JSON
    if command -v python3 &> /dev/null; then
        python3 -m json.tool "$tmp_file" > /dev/null 2>&1 || error "Невалидный JSON"
    elif command -v jq &> /dev/null; then
        jq . "$tmp_file" > /dev/null 2>&1 || error "Невалидный JSON"
    fi
    
    local size=$(wc -c < "$tmp_file")
    local keys=$(grep -c '": "' "$tmp_file" 2>/dev/null || echo "?")
    success "Загружено: $size байт (~$keys ключей)"
    
    # Install
    log "Установка ru.json..."
    mkdir -p "$LOCALES_PATH"
    cp "$tmp_file" "$LOCALES_PATH/ru.json"
    chmod 644 "$LOCALES_PATH/ru.json"
    rm -f "$tmp_file"
    
    success "ru.json установлен в $LOCALES_PATH/"
}

check_russian_exists() {
    # Check if Russian is already in the bundle
    if grep -q '"Русский"' "$INDEX_FILE" 2>/dev/null; then
        return 0  # Already exists
    fi
    return 1  # Not found
}

patch_index_bundle() {
    step "Патч index bundle для добавления русского языка..."
    
    # Check if already patched
    if check_russian_exists; then
        success "Русский язык уже добавлен в index bundle"
        return 0
    fi
    
    # Create backup
    local backup_file="${INDEX_FILE}.backup.$(date +%Y%m%d%H%M%S)"
    cp "$INDEX_FILE" "$backup_file"
    log "Создан бэкап: $(basename "$backup_file")"
    
    # Find the languages array pattern and add Russian
    # The array looks like: [{name:"English",code:"en"},...,{name:"日本語",code:"ja"}]
    # We add Russian after the last language in the array
    
    local patched=false
    
    # Pattern 1: After Japanese (日本語) - most common case
    if grep -q '{name:"日本語",code:"ja"}\]' "$INDEX_FILE" 2>/dev/null; then
        sed -i 's/{name:"日本語",code:"ja"}\]/{name:"日本語",code:"ja"},{name:"Русский",code:"ru"}]/g' "$INDEX_FILE"
        patched=true
        log "Паттерн: после японского языка"
    fi
    
    # Pattern 2: After Korean (한국어)
    if [[ "$patched" == false ]] && grep -q '{name:"한국어",code:"ko"}\]' "$INDEX_FILE" 2>/dev/null; then
        sed -i 's/{name:"한국어",code:"ko"}\]/{name:"한국어",code:"ko"},{name:"Русский",code:"ru"}]/g' "$INDEX_FILE"
        patched=true
        log "Паттерн: после корейского языка"
    fi
    
    # Pattern 3: After Ukrainian (Українська)  
    if [[ "$patched" == false ]] && grep -q '{name:"Українська",code:"uk"}\]' "$INDEX_FILE" 2>/dev/null; then
        sed -i 's/{name:"Українська",code:"uk"}\]/{name:"Українська",code:"uk"},{name:"Русский",code:"ru"}]/g' "$INDEX_FILE"
        patched=true
        log "Паттерн: после украинского языка"
    fi
    
    # Pattern 4: After Turkish (Türkçe)
    if [[ "$patched" == false ]] && grep -q '{name:"Türkçe",code:"tr"}\]' "$INDEX_FILE" 2>/dev/null; then
        sed -i 's/{name:"Türkçe",code:"tr"}\]/{name:"Türkçe",code:"tr"},{name:"Русский",code:"ru"}]/g' "$INDEX_FILE"
        patched=true
        log "Паттерн: после турецкого языка"
    fi
    
    # Verify patch
    if check_russian_exists; then
        success "Index bundle успешно пропатчен"
        
        # Cleanup old backups (keep last 3)
        local backup_dir=$(dirname "$INDEX_FILE")
        ls -t "$backup_dir"/index-*.js.backup.* 2>/dev/null | tail -n +4 | xargs -r rm -f
        
        return 0
    else
        # Restore backup
        warn "Патч не применён, восстанавливаем бэкап..."
        cp "$backup_file" "$INDEX_FILE"
        
        # Show debug info
        echo ""
        warn "Не удалось найти паттерн для патча."
        echo "Текущие языки в файле:"
        grep -oP '\{name:"[^"]+",code:"[a-z]{2}"\}' "$INDEX_FILE" | head -15
        echo ""
        error "Требуется ручной патч. См. README для инструкций."
    fi
}

restart_service() {
    step "Перезапуск UmbrelOS..."
    
    # Try different service names
    local services=("umbrel.service" "umbreld.service" "umbrel")
    local restarted=false
    
    for svc in "${services[@]}"; do
        if systemctl is-active --quiet "$svc" 2>/dev/null || systemctl list-units --type=service | grep -q "$svc"; then
            log "Перезапуск $svc..."
            systemctl restart "$svc" 2>/dev/null && restarted=true && break
        fi
    done
    
    if [[ "$restarted" == true ]]; then
        sleep 3
        success "Служба перезапущена"
    else
        warn "Не удалось найти службу UmbrelOS"
        warn "Перезапустите вручную: sudo systemctl restart umbrel"
    fi
}

verify_installation() {
    step "Проверка установки..."
    
    local errors=0
    
    # Check ru.json
    if [[ -f "$LOCALES_PATH/ru.json" ]]; then
        local size=$(wc -c < "$LOCALES_PATH/ru.json")
        if [[ $size -gt 50000 ]]; then
            success "ru.json: $size байт ✓"
        else
            warn "ru.json слишком маленький: $size байт"
            ((errors++))
        fi
    else
        warn "ru.json не найден"
        ((errors++))
    fi
    
    # Check index bundle
    if check_russian_exists; then
        success "Index bundle: содержит русский язык ✓"
    else
        warn "Index bundle: русский язык не найден"
        ((errors++))
    fi
    
    return $errors
}

print_success() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}                                                               ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}         ${BOLD}✅ Русский язык успешно установлен!${NC}                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                               ${GREEN}║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${BOLD}Следующие шаги:${NC}"
    echo ""
    echo "  1. Откройте http://umbrel.local (или IP вашего Umbrel)"
    echo "  2. Очистите кэш браузера: ${BOLD}Ctrl+Shift+R${NC}"
    echo "     (или откройте в режиме инкогнито)"
    echo "  3. Перейдите в ${BOLD}Settings → Language${NC}"
    echo "  4. Выберите ${BOLD}Русский${NC}"
    echo ""
    echo -e "  ${CYAN}Репозиторий: https://github.com/Cheviiot/Umbrel-Kiosk${NC}"
    echo ""
}

print_failure() {
    echo ""
    echo -e "${RED}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║${NC}                                                               ${RED}║${NC}"
    echo -e "${RED}║${NC}         ${BOLD}❌ Установка завершена с ошибками${NC}                    ${RED}║${NC}"
    echo -e "${RED}║${NC}                                                               ${RED}║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "  Проверьте сообщения выше и попробуйте:"
    echo "  1. Убедитесь, что UmbrelOS запущен"
    echo "  2. Проверьте права доступа: sudo $0"
    echo "  3. Откройте issue: https://github.com/Cheviiot/Umbrel-Kiosk/issues"
    echo ""
}

# Manual path override
if [[ -n "$UI_PATH" ]]; then
    LOCALES_PATH="$UI_PATH/locales"
    ASSETS_PATH="$UI_PATH/assets"
fi

# Main
main() {
    print_banner
    check_root
    
    # Allow manual path override
    if [[ -z "$UI_PATH" ]]; then
        detect_umbrel
    else
        log "Используется путь: $UI_PATH"
        LOCALES_PATH="$UI_PATH/locales"
        ASSETS_PATH="$UI_PATH/assets"
    fi
    
    find_index_bundle
    download_russian_locale
    patch_index_bundle
    restart_service
    
    echo ""
    if verify_installation; then
        print_success
        exit 0
    else
        print_failure
        exit 1
    fi
}

main "$@"
