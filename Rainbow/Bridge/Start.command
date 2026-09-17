#!/bin/bash
# Двойной клик в Finder запускает bridge в окне Терминала.
# Окно нужно держать открытым; закрытие окна останавливает bridge.
# Для постоянной работы без окна см. Bridge/Autostart.sh install

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/Server.js"
PORT="${PIXSO_BRIDGE_PORT:-8787}"

# Finder запускает .command не через логин-шелл, поэтому PATH может быть пустым.
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

NODE="$(find_node)" || {
  echo "Node.js не найден."
  echo "Установите его с https://nodejs.org и запустите файл снова."
  echo
  read -r -p "Enter — закрыть окно."
  exit 1
}

# Уже запущен? Тогда просто сообщаем и выходим: второй экземпляр не нужен.
if curl -s --max-time 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "Bridge уже работает на http://localhost:$PORT"
  echo "Открывать второе окно не нужно."
  echo
  read -r -p "Enter — закрыть окно."
  exit 0
fi

echo "Pixso2Figma bridge"
echo "Node:  $NODE"
echo "Порт:  $PORT"
echo
echo "Оставьте это окно открытым на время миграции."
echo "Остановить: Ctrl+C или закрыть окно."
echo "--------------------------------------------------"

"$NODE" "$SERVER"

STATUS=$?
echo "--------------------------------------------------"
if [ $STATUS -ne 0 ]; then
  echo "Bridge завершился с кодом $STATUS."
else
  echo "Bridge остановлен."
fi
echo
read -r -p "Enter — закрыть окно."
