#!/bin/bash
# Автозапуск bridge через macOS LaunchAgent: стартует при входе в систему,
# перезапускается после падения, работает без окна Терминала.
#
#   ./Bridge/Autostart.sh install
#   ./Bridge/Autostart.sh status
#   ./Bridge/Autostart.sh uninstall
#
# Ставится только в пользовательский домен (~/Library/LaunchAgents),
# root и пароль не нужны.

set -u

LABEL="com.divulture.pixso2figma.bridge"
DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/Server.js"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/pixso2figma-bridge.log"
PORT="${PIXSO_BRIDGE_PORT:-8787}"
TARGET="gui/$(id -u)"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidate
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

unload_agent() {
  # bootout — современный путь; launchctl unload оставлен для старых систем.
  launchctl bootout "$TARGET/$LABEL" 2>/dev/null ||
    launchctl unload -w "$PLIST" 2>/dev/null
  return 0
}

case "${1:-}" in
  install)
    NODE="$(find_node)" || {
      echo "Node.js не найден. Установите его с https://nodejs.org и повторите."
      exit 1
    }
    [ -f "$SERVER" ] || { echo "Не найден $SERVER"; exit 1; }

    mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

    # LaunchAgent наследует минимальный PATH, поэтому путь к node зашивается
    # абсолютным на момент установки. После обновления Node повторите install.
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SERVER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PIXSO_BRIDGE_PORT</key>
    <string>$PORT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

    plutil -lint "$PLIST" >/dev/null || { echo "Некорректный plist"; exit 1; }

    unload_agent
    launchctl bootstrap "$TARGET" "$PLIST" 2>/dev/null ||
      launchctl load -w "$PLIST" || { echo "launchctl не принял агент"; exit 1; }

    sleep 1
    if curl -s --max-time 3 "http://localhost:$PORT/health" >/dev/null 2>&1; then
      echo "Готово. Bridge работает на http://localhost:$PORT и будет"
      echo "подниматься при каждом входе в систему."
    else
      echo "Агент установлен, но bridge пока не отвечает."
      echo "Лог: $LOG"
    fi
    echo "Отключить: $0 uninstall"
    ;;

  uninstall)
    unload_agent
    rm -f "$PLIST"
    echo "Автозапуск отключён, агент удалён."
    echo "Bridge можно по-прежнему запускать вручную: Bridge/Start.command"
    ;;

  status)
    if launchctl print "$TARGET/$LABEL" >/dev/null 2>&1; then
      echo "LaunchAgent:  установлен"
    else
      echo "LaunchAgent:  не установлен"
    fi
    if curl -s --max-time 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then
      echo "Bridge:       отвечает на http://localhost:$PORT"
      curl -s --max-time 2 "http://localhost:$PORT/receiver/status"
      echo
    else
      echo "Bridge:       не отвечает на порту $PORT"
    fi
    if [ -f "$LOG" ]; then echo "Лог:          $LOG"; fi
    ;;

  *)
    echo "Использование: $0 install | status | uninstall"
    exit 1
    ;;
esac
