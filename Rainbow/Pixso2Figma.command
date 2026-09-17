#!/bin/bash
# Двойной клик в Finder открывает Terminal launcher Pixso → Figma.
#
# Окно остаётся открытым всё время работы: launcher сам поднимает bridge,
# показывает активный Figma Receiver и принимает перетащенный файл .pix.
# Миграцию выполняет DirectPix/Cli.js — здесь никакой business logic нет.

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$DIR/Launcher/Terminal.js"

keep_window_open() {
  echo
  read -r -p "Enter — закрыть окно."
}

# Окно терминала существует только ради launcher: когда он вышел, пустое окно
# с «[Процесс завершён]» не нужно. Особенно это видно при вытеснении — новое
# окно закрывает старый launcher, а его окно иначе остаётся висеть.
#
# Закрыть окно может только сам Terminal, поэтому просим его об этом.
# Требования: это Terminal.app, есть osascript, известен собственный tty.
# Любая неудача (в том числе запрет автоматизации) молча оставляет окно
# открытым — ровно как было раньше.
close_own_window() {
  [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0

  local own_tty
  own_tty="$(tty 2>/dev/null)" || return 0
  case "$own_tty" in
    /dev/*) ;;
    *) return 0 ;;
  esac

  # Отвязанный фоновый процесс с паузой: окно закрывается уже ПОСЛЕ выхода
  # оболочки, поэтому Terminal не спрашивает «завершить запущенные процессы?».
  # Закрывается строго своё окно — найденное по собственному tty.
  nohup osascript - "$own_tty" >/dev/null 2>&1 <<'OSA' &
on run argv
  set ownTty to item 1 of argv
  delay 0.5
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if tty of t is ownTty then
            close w
            return
          end if
        end try
      end repeat
    end repeat
  end tell
end run
OSA
  disown 2>/dev/null || true
}

# Finder запускает .command не через логин-шелл, поэтому PATH может быть пустым.
# Порядок поиска тот же, что в Bridge/Start.command.
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
  keep_window_open
  exit 1
}

if [ ! -f "$LAUNCHER" ]; then
  echo "Не найден $LAUNCHER."
  echo "Запускайте файл из папки проекта Pixso2Figma."
  keep_window_open
  exit 1
fi

# Direct PIX распаковывает .pix через zlib.zstdDecompressSync — он появился
# в Node 22.15 и 24. Более старая версия упала бы уже внутри migration.
NODE_VERSION="$("$NODE" -v 2>/dev/null)"
NODE_MAJOR="$(echo "${NODE_VERSION#v}" | cut -d. -f1)"
NODE_MINOR="$(echo "${NODE_VERSION#v}" | cut -d. -f2)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
case "$NODE_MINOR" in
  ''|*[!0-9]*) NODE_MINOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 15 ]; } || [ "$NODE_MAJOR" -eq 23 ]; then
  echo "Нужен Node.js 22.15+ или 24+, установлен $NODE_VERSION."
  echo "Обновите Node.js с https://nodejs.org и запустите файл снова."
  keep_window_open
  exit 1
fi

echo "Node:  $NODE ($NODE_VERSION)"
echo

# Пустой обработчик, а не игнорирование: node остаётся в той же группе
# процессов и получает Ctrl+C сам, а скрипт после этого доигрывает до конца.
trap ':' INT
trap ':' HUP

"$NODE" "$LAUNCHER" "$@"
STATUS=$?

# 0 — обычный выход, 130 — Ctrl+C: окно можно закрывать молча.
# 3 — старое окно закрыть не удалось: launcher всё объяснил сам, добавлять к
# этому «завершился с кодом» незачем, но окно нужно оставить открытым.
# Всё остальное — ошибка старта, и сообщение о ней нужно успеть прочитать.
if [ "$STATUS" -eq 3 ]; then
  keep_window_open
elif [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 130 ]; then
  echo
  echo "Launcher завершился с кодом $STATUS."
  keep_window_open
fi

close_own_window
exit "$STATUS"
