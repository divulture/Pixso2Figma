#!/bin/bash
# Двойной клик в Finder открывает Terminal launcher Pixso → Figma.
#
# Окно остаётся открытым всё время работы: launcher сам поднимает bridge,
# показывает активный Figma Receiver и принимает перетащенный файл .pix.
# Миграцию выполняет DirectPix/Cli.js — здесь никакой business logic нет.

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$DIR/Launcher/Terminal.js"
BOOTSTRAP="$DIR/Launcher/BootstrapNode.sh"

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
# Берём первый совместимый Node, а не первый вообще: старый node в PATH
# не должен мешать найти новый Homebrew/Volta/nvm или скачать частный runtime.
node_is_compatible() {
  local candidate="$1" version major minor
  [ -x "$candidate" ] || return 1
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt 23 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 15 ]; }
}

find_compatible_node() {
  local path_node=""
  command -v node >/dev/null 2>&1 && path_node="$(command -v node)"
  local candidate
  for candidate in "$path_node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node
  do
    node_is_compatible "$candidate" && { echo "$candidate"; return 0; }
  done
  return 1
}

if [ ! -f "$LAUNCHER" ]; then
  echo "Не найден $LAUNCHER."
  echo "Запускайте файл из папки проекта Pixso2Figma."
  keep_window_open
  exit 1
fi

NODE="$(find_compatible_node)" || {
  if [ ! -f "$BOOTSTRAP" ]; then
    echo "Не найден $BOOTSTRAP."
    echo "Восстановите полную папку Pixso2Figma."
    keep_window_open
    exit 1
  fi
  NODE="$(/bin/bash "$BOOTSTRAP")" || {
    keep_window_open
    exit 1
  }
}

if ! node_is_compatible "$NODE"; then
  echo "Подготовленный Node.js не прошёл проверку версии."
  keep_window_open
  exit 1
fi

NODE_VERSION="$("$NODE" -v 2>/dev/null)"
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
