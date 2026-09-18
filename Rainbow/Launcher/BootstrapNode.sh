#!/bin/bash
# Downloads a private Node.js runtime when macOS has no compatible system Node.
# Success writes exactly one stdout line: the absolute path to the Node binary.
# Human-readable progress and failures go to stderr so the wrapper can capture
# the path without hiding status from the user.

set -u

NODE_VERSION="24.21.0"
DIST_BASE="https://nodejs.org/download/release/v${NODE_VERSION}"

fail() {
  printf '\nНе удалось подготовить Node.js: %s\n' "$1" >&2
  exit 1
}

runtime_is_valid() {
  [ -x "$1" ] || return 1
  [ "$("$1" -p 'process.versions.node' 2>/dev/null)" = "$NODE_VERSION" ]
}

machine_arch="$(uname -m 2>/dev/null || true)"
# A Terminal launched under Rosetta reports x86_64 although the machine can run
# the native Apple Silicon binary. Prefer the native runtime in that case.
if [ "$machine_arch" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
  machine_arch="arm64"
fi

case "$machine_arch" in
  arm64)
    node_arch="arm64"
    archive_sha256="6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe"
    ;;
  x86_64)
    node_arch="x64"
    archive_sha256="0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299"
    ;;
  *)
    fail "архитектура macOS '$machine_arch' не поддерживается."
    ;;
esac

archive_name="node-v${NODE_VERSION}-darwin-${node_arch}.tar.xz"
archive_url="${DIST_BASE}/${archive_name}"
runtime_base="${PIXSO2FIGMA_RUNTIME_DIR:-$HOME/Library/Application Support/Pixso2Figma/runtime}"
target_dir="${runtime_base}/v${NODE_VERSION}-darwin-${node_arch}"
node_path="${target_dir}/bin/node"
lock_dir="${runtime_base}/.bootstrap-v${NODE_VERSION}-darwin-${node_arch}.lock"
stage_dir=""
have_lock=0

if runtime_is_valid "$node_path"; then
  printf '%s\n' "$node_path"
  exit 0
fi

mkdir -p "$runtime_base" || fail "нельзя создать папку '$runtime_base'."

cleanup() {
  if [ -n "$stage_dir" ] && [ -d "$stage_dir" ]; then
    rm -rf -- "$stage_dir"
  fi
  if [ "$have_lock" -eq 1 ] && [ -d "$lock_dir" ]; then
    rm -rf -- "$lock_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Two double-clicks must not download or unpack the same runtime concurrently.
waited=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  if runtime_is_valid "$node_path"; then
    printf '%s\n' "$node_path"
    exit 0
  fi

  lock_pid=""
  [ -f "$lock_dir/pid" ] && lock_pid="$(sed -n '1p' "$lock_dir/pid" 2>/dev/null || true)"
  case "$lock_pid" in
    ''|*[!0-9]*) lock_pid="" ;;
  esac
  # A just-created lock has a very short window before its pid file appears.
  # Do not mistake that window for a stale lock and remove it under its owner.
  if [ -z "$lock_pid" ]; then
    waited=$((waited + 1))
    [ "$waited" -lt 300 ] || fail "другой запуск не завершил подготовку runtime за 5 минут."
    sleep 1
    continue
  fi
  if ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -rf -- "$lock_dir"
    continue
  fi

  waited=$((waited + 1))
  [ "$waited" -lt 300 ] || fail "другой запуск не завершил подготовку runtime за 5 минут."
  sleep 1
done
have_lock=1
printf '%s\n' "$$" > "$lock_dir/pid"

# The first process may have completed between the initial check and the lock.
if runtime_is_valid "$node_path"; then
  printf '%s\n' "$node_path"
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "в macOS не найден curl."
command -v shasum >/dev/null 2>&1 || fail "в macOS не найден shasum."
command -v tar >/dev/null 2>&1 || fail "в macOS не найден tar."

stage_dir="$(mktemp -d "${runtime_base}/.install.XXXXXX")" || fail "нельзя создать временную папку."
archive_path="${stage_dir}/${archive_name}"

printf 'Подходящий Node.js не найден. Скачиваю runtime Node.js %s (~%s МБ)...\n' \
  "$NODE_VERSION" "$([ "$node_arch" = "arm64" ] && printf '27' || printf '29')" >&2
if ! curl --fail --location --retry 2 --connect-timeout 20 \
  --output "$archive_path" "$archive_url"; then
  fail "загрузка с nodejs.org не удалась. Проверьте интернет и запустите Pixso2Figma снова."
fi

actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
if [ "$actual_sha256" != "$archive_sha256" ]; then
  fail "контрольная сумма загрузки не совпала; файл не будет запущен."
fi

if ! tar -xJf "$archive_path" -C "$stage_dir"; then
  fail "не удалось распаковать официальный архив Node.js."
fi

source_dir="${stage_dir}/node-v${NODE_VERSION}-darwin-${node_arch}"
source_node="${source_dir}/bin/node"
[ -x "$source_node" ] || fail "в архиве Node.js нет ожидаемого bin/node."

# DirectPix and Bridge need only the Node executable. npm, headers and docs are
# deliberately not retained, which keeps the private runtime much smaller.
prepared_dir="${stage_dir}/prepared-runtime"
mkdir -p "$prepared_dir/bin" || fail "не удалось подготовить папку runtime."
cp "$source_node" "$prepared_dir/bin/node" || fail "не удалось сохранить Node.js."
chmod 755 "$prepared_dir/bin/node" || fail "не удалось сделать Node.js исполняемым."
[ ! -f "$source_dir/LICENSE" ] || cp "$source_dir/LICENSE" "$prepared_dir/LICENSE"

if [ -e "$target_dir" ]; then
  rm -rf -- "$target_dir"
fi
mv "$prepared_dir" "$target_dir" || fail "не удалось установить runtime в '$target_dir'."

runtime_is_valid "$node_path" || fail "скачанный Node.js не прошёл проверку запуска."
printf 'Готово. Runtime сохранён в %s\n' "$target_dir" >&2
printf '%s\n' "$node_path"
