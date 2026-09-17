/**
 * Pixso2Figma Terminal Launcher.
 *
 *   node Launcher/Terminal.js [--bridge http://localhost:8787]
 *
 * Одно постоянно открытое окно терминала: bridge поднимается сам, активный
 * Figma Receiver виден в статусной строке, перетащенный `.pix` + Enter
 * запускает ровно одну full-document migration.
 *
 * Слой строго orchestration-only:
 *   — содержимое `.pix` здесь не читается и не разбирается;
 *   — весь перенос выполняет существующая точка входа
 *     `DirectPix/Cli.js <файл> --migrate-file --receiver-id <id>`;
 *   — `migrateFile`, `MigrationIR` и `BridgeClient` не дублируются.
 *
 * Процессы запускаются только через `spawn()` с массивом аргументов и
 * `shell: false`: путь пользователя никогда не попадает в командную строку
 * оболочки.
 *
 * Launcher владеет job, которую создал его потомок: он выдаёт ему producer
 * token через окружение, получает по IPC id созданной job и при завершении
 * снимает с bridge ровно её. Поэтому закрытое окно не оставляет зависшую
 * `running` job даже на bridge, который launcher не запускал и не гасит.
 *
 * `require()` этого модуля НЕ запускает main(): ниже он используется тестами.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var readline = require("readline");
var childProcess = require("child_process");
var crypto = require("crypto");
var os = require("os");

var BridgeClient = require("../DirectPix/BridgeClient");

var PROJECT_DIR = path.resolve(__dirname, "..");
var BRIDGE_SERVER_PATH = path.join(PROJECT_DIR, "Bridge", "Server.js");
var DIRECT_CLI_PATH = path.join(PROJECT_DIR, "DirectPix", "Cli.js");
var DEFAULT_BRIDGE_URL = "http://localhost:8787";
/** Команда окна: опыты в живой Figma вместо переноса файла. */
var PROBE_COMMAND = "probe";
/** Команда окна: сверка эталонных экранов. */
var CHECK_COMMAND = "check";
var REFERENCE_SCREENS_FILE = "REFERENCE_SCREENS.json";

/** Сколько ждём health только что запущенного bridge. */
var BRIDGE_STARTUP_TIMEOUT_MS = 15000;
var BRIDGE_PROBE_INTERVAL_MS = 250;
/** Сколько ждём корректного завершения дочернего процесса перед SIGKILL. */
var CHILD_EXIT_GRACE_MS = 4000;
/** Как часто launcher перечитывает активный Receiver в idle. */
var STATUS_POLL_MS = 2000;

/** Код выхода «старое окно не удалось закрыть». Его знает обёртка .command. */
var EXIT_LOCK_BUSY = 3;

var STATE = {
  STARTING: "STARTING",
  IDLE_NO_RECEIVER: "IDLE_NO_RECEIVER",
  IDLE_READY: "IDLE_READY",
  BUSY: "BUSY",
  SHUTTING_DOWN: "SHUTTING_DOWN",
  STOPPED: "STOPPED",
};

/**
 * Допустимые переходы. Запрещены в том числе `BUSY -> BUSY` (второй файл) и
 * любой старт без подтверждённого Receiver.
 */
var TRANSITIONS = {
  STARTING: ["IDLE_NO_RECEIVER", "IDLE_READY", "SHUTTING_DOWN"],
  IDLE_NO_RECEIVER: ["IDLE_READY", "IDLE_NO_RECEIVER", "BUSY", "SHUTTING_DOWN"],
  IDLE_READY: ["IDLE_NO_RECEIVER", "IDLE_READY", "BUSY", "SHUTTING_DOWN"],
  BUSY: ["IDLE_NO_RECEIVER", "IDLE_READY", "SHUTTING_DOWN"],
  SHUTTING_DOWN: ["STOPPED"],
  STOPPED: [],
};

// `IDLE_NO_RECEIVER -> BUSY` в списке есть только потому, что состояние
// пересчитывается непосредственно перед spawn по свежему status: путь из
// IDLE_NO_RECEIVER возможен лишь когда Receiver включили между опросами.

// ---------------------------------------------------------------------------
// Разбор перетащенного пути
// ---------------------------------------------------------------------------

function parseFailure(code, message) {
  return { ok: false, code: code, message: message, paths: [] };
}

/**
 * POSIX-токенизация строки, которую Terminal вставляет при drag & drop.
 *
 * Поддержаны ровно три вещи: экранирование обратной косой чертой, одинарные и
 * двойные кавычки. Подстановки переменных, globbing, `$(...)`, backtick и
 * любые операторы оболочки НЕ выполняются — они остаются обычными символами
 * имени файла.
 */
function tokenizePosix(text) {
  var tokens = [];
  var current = "";
  var started = false;
  var quote = null;

  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);

    if (quote === "'") {
      // Внутри одинарных кавычек экранирования нет вовсе.
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        var escapedInQuotes = text.charAt(i + 1);
        if (i + 1 >= text.length) return parseFailure("INVALID_PATH", "Строка обрывается на обратной косой черте.");
        // Внутри двойных кавычек backslash экранирует только эти символы,
        // в остальных случаях он — обычный символ пути.
        if (escapedInQuotes === '"' || escapedInQuotes === "\\" ||
            escapedInQuotes === "$" || escapedInQuotes === "`") {
          current += escapedInQuotes;
          i += 1;
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"') { quote = null; continue; }
      current += ch;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= text.length) return parseFailure("INVALID_PATH", "Строка обрывается на обратной косой черте.");
      current += text.charAt(i + 1);
      i += 1;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === " " || ch === "\t") {
      if (started) { tokens.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) return parseFailure("INVALID_PATH", "В строке осталась незакрытая кавычка.");
  if (started) tokens.push(current);
  return { ok: true, tokens: tokens };
}

/**
 * Windows-токенизация. Обратная косая черта здесь — разделитель пути, а не
 * экранирование: `C:\Users\Me` обязан остаться собой. Drag & drop в cmd
 * оборачивает путь с пробелами в двойные кавычки, PowerShell — в одинарные.
 */
function tokenizeWindows(text) {
  var first = text.charAt(0);
  var last = text.charAt(text.length - 1);
  if (text.length >= 2 && (first === '"' || first === "'") && last === first) {
    var inner = text.slice(1, -1);
    // Две закавыченные строки подряд — это два файла, а не один путь.
    if (inner.indexOf(first) >= 0) {
      return parseFailure("ONE_FILE_ONLY", "Перетащен не один файл.");
    }
    return { ok: true, tokens: [inner] };
  }
  if (text.indexOf('"') >= 0 || text.indexOf("'") >= 0) {
    return parseFailure("ONE_FILE_ONLY", "Перетащен не один файл.");
  }
  var parts = text.split(/[ \t]+/).filter(function (part) { return part.length > 0; });
  return { ok: true, tokens: parts };
}

/**
 * Чистый разбор строки терминала в список путей.
 *
 * Возвращает `{ ok: true, paths: [путь] }` либо `{ ok: false, code, message }`
 * с кодами `EMPTY`, `INVALID_PATH`, `ONE_FILE_ONLY`.
 */
function parseDroppedPaths(line, platform) {
  var text = line === undefined || line === null ? "" : String(line);
  if (text.indexOf("\u0000") >= 0) {
    return parseFailure("INVALID_PATH", "Путь содержит недопустимый символ NUL.");
  }
  if (/[\n\r]/.test(text)) {
    return parseFailure("INVALID_PATH", "Путь содержит перевод строки.");
  }
  var trimmed = text.trim();
  if (!trimmed) return parseFailure("EMPTY", "Пустая строка.");

  var result = String(platform) === "win32" ? tokenizeWindows(trimmed) : tokenizePosix(trimmed);
  if (!result.ok) return result;

  var tokens = result.tokens.filter(function (token) { return token.length > 0; });
  if (!tokens.length) return parseFailure("EMPTY", "Пустая строка.");
  if (tokens.length > 1) {
    return parseFailure("ONE_FILE_ONLY",
      "Перетащен не один файл (" + tokens.length + "). За раз переносится ровно один .pix.");
  }
  return { ok: true, code: null, message: null, paths: tokens };
}

/**
 * Проверка уже разобранного пути. Симлинк на обычный `.pix` допустим:
 * `statSync` переходит по нему, а исходный файл всё равно только читается.
 */
function validateDroppedFile(rawPath, statSync) {
  var absolute = path.resolve(String(rawPath));
  var stat;
  try {
    stat = statSync(absolute);
  } catch (_error) {
    return { ok: false, code: "NOT_FOUND", message: "Файл не найден: " + absolute };
  }
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) {
    return { ok: false, code: "NOT_A_FILE", message: "Это не обычный файл: " + absolute };
  }
  if (path.extname(absolute).toLowerCase() !== ".pix") {
    return { ok: false, code: "NOT_PIX", message: "Нужен файл .pix, получено: " + path.basename(absolute) };
  }
  return { ok: true, code: null, message: null, path: absolute };
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** Ждёт завершения процесса, запоминая исход один раз. */
function trackChild(child) {
  var record = { child: child, done: false, code: null, signal: null, error: null };
  record.exit = new Promise(function (resolve) {
    child.on("exit", function (code, signal) {
      record.done = true;
      record.code = code;
      record.signal = signal;
      resolve({ code: code, signal: signal, error: null });
    });
    child.on("error", function (error) {
      if (record.done) return;
      record.done = true;
      record.error = error;
      resolve({ code: null, signal: null, error: error });
    });
  });
  return record;
}

/**
 * Путь к файлу блокировки. Ключ — адрес bridge: инвариант «одно окно» живёт
 * не на проект, а на bridge, и `--bridge` с другим портом честно получает
 * собственный lock.
 */
function lockPathFor(bridgeUrl) {
  var key = crypto.createHash("sha256").update(String(bridgeUrl), "utf8").digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "pixso2figma-launcher-" + key + ".lock");
}

/** Жив ли процесс с таким pid. Сигнал 0 ничего не делает — только проверяет. */
function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH — процесса нет. EPERM — есть, но чужой: считаем живым.
    return error && error.code === "EPERM";
  }
}

/**
 * Показывать ли приглашение после того, как строка обработана.
 *
 * Приглашение существует только там, где ввод действительно принимается:
 * `IDLE_READY` и `IDLE_NO_RECEIVER`. Во время BUSY второй Enter отклоняется
 * сообщением, но `>` НЕ перерисовывается — иначе пользователь видел бы
 * приглашение поверх идущей migration и считал бы launcher свободным.
 * Приглашение вернёт тот обработчик, который эту migration и запустил,
 * ровно один раз.
 *
 * `outcome.silent` означает, что строку забрал параллельно идущий submit:
 * рисовать приглашение обязан он, а не этот вызов.
 */
function shouldShowPrompt(state, outcome) {
  if (outcome && outcome.silent) return false;
  return state === STATE.IDLE_READY || state === STATE.IDLE_NO_RECEIVER;
}

/**
 * Обработчик строки терминала. Вынесен из `main()` целиком, чтобы
 * последовательность «Enter → migration → второй Enter → завершение первой»
 * проверялась тестом, а не глазами.
 */
function createLineHandler(launcher, hooks) {
  var options = hooks || {};
  var showPrompt = options.showPrompt || function () {};
  var hidePrompt = options.hidePrompt || function () {};
  var onError = options.onError || function () {};
  return function (line) {
    hidePrompt();
    return launcher.submit(line).then(
      function (outcome) { return outcome; },
      function (error) { onError(error); return { code: "SUBMIT_FAILED" }; }
    ).then(function (outcome) {
      if (shouldShowPrompt(launcher.state(), outcome)) showPrompt();
      return outcome;
    });
  };
}

/**
 * Интерактивный launcher. Всё, что трогает ОС и сеть, приходит через `deps` —
 * тесты подставляют фейки и проверяют аргументы spawn без реальной Figma.
 */
function createLauncher(deps) {
  var options = deps || {};
  var bridgeUrl = String(options.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
  var platform = options.platform || process.platform;
  var execPath = options.execPath || process.execPath;
  var cliPath = options.cliPath || DIRECT_CLI_PATH;
  var bridgeServerPath = options.bridgeServerPath || BRIDGE_SERVER_PATH;
  var projectDir = options.projectDir || PROJECT_DIR;
  var spawn = options.spawn || childProcess.spawn;
  var statSync = options.statSync || fs.statSync;
  var write = options.write || function (text) { process.stdout.write(text + "\n"); };
  var writeStatus = options.writeStatus || write;
  var logEvent = options.log || function () {};
  var probeHealth = options.probeHealth;
  var readStatus = options.readStatus;
  /**
   * Снятие job с bridge. По умолчанию — no-op: тесты, которые job вообще не
   * создают, не обязаны знать про отмену.
   */
  var abortJob = options.abortJob || function () { return Promise.resolve({ status: 0, body: null }); };
  var makeToken = options.makeToken || function () { return crypto.randomBytes(24).toString("hex"); };
  var lockPath = options.lockPath || lockPathFor(bridgeUrl);
  var ownPid = options.pid || process.pid;
  var isProcessAlive = options.isProcessAlive || processAlive;
  var killProcess = options.killProcess || function (pid, signal) { process.kill(pid, signal); };
  /** Сколько ждём, пока старое окно закроется само, прежде чем добивать. */
  var takeoverGraceMs = options.takeoverGraceMs === undefined ? 8000 : options.takeoverGraceMs;
  var lockPollMs = options.lockPollMs || 100;
  /** Как часто закрывающееся окно отмечается в замке, пока ещё живо. */
  var lockHeartbeatMs = options.lockHeartbeatMs || 1000;
  /**
   * Подтверждение вытеснения окна, которое ПРЯМО СЕЙЧАС переносит дизайн.
   * По умолчанию — «нет»: неинтерактивный запуск не имеет права молча убить
   * чужой импорт.
   */
  var confirmTakeover = options.confirmTakeover || function () { return Promise.resolve(false); };
  var startupTimeoutMs = options.startupTimeoutMs || BRIDGE_STARTUP_TIMEOUT_MS;
  var probeIntervalMs = options.probeIntervalMs || BRIDGE_PROBE_INTERVAL_MS;
  var exitGraceMs = options.exitGraceMs === undefined ? CHILD_EXIT_GRACE_MS : options.exitGraceMs;
  var pollMs = options.pollMs || STATUS_POLL_MS;

  var state = STATE.STARTING;
  var ownsBridge = false;
  var bridgeProcess = null;
  var migrationProcess = null;
  /**
   * Job, созданная НАШИМ дочерним процессом: `{ jobId, token }`. `jobId`
   * приходит по IPC от потомка, `token` launcher сгенерировал сам и передал
   * потомку через окружение. Вместе это и есть доказательство владения.
   */
  var activeJob = null;
  /** Идущий запрос отмены: параллельные вызовы делят один и тот же. */
  var releasing = null;
  /** Блокировка «одно окно на bridge» взята ЭТИМ процессом. */
  var lockHeld = false;
  var lockHeartbeatTimer = null;
  var pollTimer = null;
  var submitting = false;
  var shutdownPromise = null;
  /** Receiver, который сейчас показан пользователю. Цель migration — только он. */
  var announcedReceiverId = null;
  var shown = { ready: false, receiverId: null, documentName: null };

  function setState(next) {
    var allowed = TRANSITIONS[state] || [];
    if (allowed.indexOf(next) < 0) {
      throw new Error("Недопустимый переход " + state + " -> " + next);
    }
    state = next;
    return state;
  }

  function fingerprint(receiverId) {
    return receiverId ? String(receiverId).slice(-8) : null;
  }

  /** Порт из адреса bridge; null, если он не задан явно и не стандартный. */
  function bridgePort() {
    try {
      var parsed = new URL(bridgeUrl);
      if (parsed.port) return Number(parsed.port);
      return parsed.protocol === "https:" ? 443 : 80;
    } catch (_error) {
      return null;
    }
  }

  function destinationName(status) {
    return (status && status.documentName) || "Figma";
  }

  // -------------------------------------------------------------------------
  // Bridge lifecycle
  // -------------------------------------------------------------------------

  async function probeBridge() {
    var response;
    try {
      response = await probeHealth();
    } catch (error) {
      return { reachable: false, compatible: false, error: error };
    }
    var body = response && response.body;
    if (!response || response.status !== 200 || !body || body.ok !== true || !body.bridgeVersion) {
      return {
        reachable: true,
        compatible: false,
        reason: "Порт " + bridgeUrl + " занят другим сервисом: это не Pixso2Figma bridge.",
      };
    }
    if (Number(body.protocolVersion) !== BridgeClient.BRIDGE_PROTOCOL_VERSION) {
      return {
        reachable: true,
        compatible: false,
        reason: "Bridge на " + bridgeUrl + " говорит на протоколе " + body.protocolVersion +
          ", launcher — на " + BridgeClient.BRIDGE_PROTOCOL_VERSION +
          ". Остановите старый bridge и запустите launcher снова.",
      };
    }
    return { reachable: true, compatible: true, body: body };
  }

  async function ensureBridge() {
    var probe = await probeBridge();
    if (probe.reachable && probe.compatible) {
      ownsBridge = false;
      logEvent("launcher.bridgeReused", { bridge: bridgeUrl, bridgeVersion: probe.body.bridgeVersion });
      return { ok: true, ownsBridge: false };
    }
    if (probe.reachable && !probe.compatible) {
      // Несовместимый сосед на порту: migration не запускаем и не «чиним».
      return { ok: false, code: "BRIDGE_INCOMPATIBLE", message: probe.reason };
    }

    var child;
    try {
      // Порт берётся из того же адреса, который launcher потом опрашивает:
      // иначе `--bridge` с нестандартным портом поднял бы bridge не туда.
      var bridgeArgs = [bridgeServerPath];
      var port = bridgePort();
      if (port) bridgeArgs.push("--port", String(port));
      child = spawn(execPath, bridgeArgs, {
        cwd: projectDir,
        shell: false,
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch (error) {
      return { ok: false, code: "BRIDGE_SPAWN_FAILED", message: "Не удалось запустить bridge: " + error.message };
    }
    bridgeProcess = trackChild(child);
    ownsBridge = true;

    var deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      if (bridgeProcess.done) {
        ownsBridge = false;
        var failed = bridgeProcess;
        bridgeProcess = null;
        return {
          ok: false,
          code: "BRIDGE_EXITED",
          message: "Bridge завершился при старте" +
            (failed.code !== null && failed.code !== undefined ? " (код " + failed.code + ")" : "") + ".",
        };
      }
      var again = await probeBridge();
      if (again.reachable && again.compatible) {
        logEvent("launcher.bridgeSpawned", { bridge: bridgeUrl, bridgeVersion: again.body.bridgeVersion });
        return { ok: true, ownsBridge: true };
      }
      if (again.reachable && !again.compatible) {
        await stopOwnedBridge();
        return { ok: false, code: "BRIDGE_INCOMPATIBLE", message: again.reason };
      }
      if (Date.now() >= deadline) {
        await stopOwnedBridge();
        return {
          ok: false,
          code: "BRIDGE_TIMEOUT",
          message: "Bridge не ответил на " + bridgeUrl + "/health за " + Math.round(startupTimeoutMs / 1000) + " с.",
        };
      }
      await sleep(probeIntervalMs);
    }
  }

  async function terminateChild(record, label) {
    if (!record || record.done) return;
    try { record.child.kill("SIGTERM"); } catch (_e) { /* уже мёртв */ }
    var finished = await Promise.race([
      record.exit.then(function () { return true; }),
      sleep(exitGraceMs).then(function () { return false; }),
    ]);
    if (finished || record.done) return;
    try { record.child.kill("SIGKILL"); } catch (_e) { /* уже мёртв */ }
    write(label + " не завершился по SIGTERM и был остановлен принудительно.");
  }

  async function stopOwnedBridge() {
    if (!ownsBridge || !bridgeProcess) return;
    var record = bridgeProcess;
    bridgeProcess = null;
    ownsBridge = false;
    await terminateChild(record, "Bridge");
  }

  // -------------------------------------------------------------------------
  // Статус Receiver
  // -------------------------------------------------------------------------

  function statusChanged(status) {
    var ready = !!(status && status.ready && status.receiverId);
    return ready !== shown.ready ||
      (status && status.receiverId ? status.receiverId : null) !== shown.receiverId ||
      (status && status.documentName ? status.documentName : null) !== shown.documentName;
  }

  /** Обновляет строку назначения, не разрушая уже набранный пользователем ввод. */
  function showStatus(status) {
    var ready = !!(status && status.ready && status.receiverId);
    shown = {
      ready: ready,
      receiverId: ready ? status.receiverId : null,
      documentName: status && status.documentName ? status.documentName : null,
    };
    announcedReceiverId = shown.receiverId;
    if (ready) {
      writeStatus("Receiver:  " + destinationName(status) + "\nСтатус:    готов");
    } else {
      writeStatus("Receiver:  не подключён\nОткройте нужный файл Figma и включите Receiver.");
    }
  }

  function applyIdleState(status) {
    var ready = !!(status && status.ready && status.receiverId);
    if (state === STATE.BUSY || state === STATE.SHUTTING_DOWN || state === STATE.STOPPED) return;
    setState(ready ? STATE.IDLE_READY : STATE.IDLE_NO_RECEIVER);
  }

  async function refreshStatus(force) {
    if (state === STATE.BUSY || state === STATE.SHUTTING_DOWN || state === STATE.STOPPED) return null;
    var status = null;
    try {
      status = await readStatus();
    } catch (_error) {
      // Опрос статуса не обязан ломать сессию: следующая попытка через интервал.
      return null;
    }
    if (force || statusChanged(status)) showStatus(status);
    applyIdleState(status);
    return status;
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (state !== STATE.IDLE_READY && state !== STATE.IDLE_NO_RECEIVER) return;
      refreshStatus(false);
    }, pollMs);
    if (pollTimer.unref) pollTimer.unref();
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // -------------------------------------------------------------------------
  // Одно окно на один bridge
  // -------------------------------------------------------------------------

  /**
   * Второе окно launcher — это не «ещё одна копия», а поломанная модель.
   * Оба окна показывают один и тот же Receiver и оба принимают файлы, хотя
   * bridge держит ровно одну job: второй Enter уезжает в `JOB_BUSY`, а
   * пользователь видит два одинаково «готовых» окна и не понимает, какое из
   * них работает. Поэтому окно должно быть ровно одно.
   *
   * Замок — файл с pid, создаваемый атомарно (`wx`). Осиротевший замок (окно
   * убили `SIGKILL`) не блокирует навсегда: если владельца уже нет, замок
   * забирается. Чужой ЖИВОЙ замок не трогается никогда.
   */
  /**
   * Одно окно на один bridge — и выигрывает ПОСЛЕДНЕЕ открытое.
   *
   * Пользователь запускает команду повторно, когда не заметил уже открытого
   * окна. Отказать ему — значит оставить два окна на экране и заставить
   * разбираться, какое из них живое. Поэтому новое окно закрывает старое: оно
   * шлёт владельцу замка `SIGTERM`, тот проходит свой обычный путь завершения
   * (снимает свою job с bridge, гасит свой bridge, снимает замок) и выходит,
   * а его окно закрывается.
   *
   * Осиротевший замок (окно убили `SIGKILL`) забирается сразу. Живого чужого
   * владельца без сигнала не трогаем никогда.
   */
  async function acquireLock() {
    var owner = null;
    var signalled = false;
    var killed = false;
    var confirmed = false;
    var deadline = 0;
    var lastHeartbeat = null;
    // Верхняя граница на всякий случай: цикл не имеет права крутиться вечно,
    // даже если файловая система ведёт себя странно.
    for (var attempt = 0; attempt < 4000; attempt++) {
      try {
        var fd = fs.openSync(lockPath, "wx");
        try {
          fs.writeSync(fd, JSON.stringify({
            pid: ownPid,
            bridge: bridgeUrl,
            startedAt: new Date().toISOString(),
            // Имя переносимого файла, пока идёт migration. По нему новое окно
            // понимает, что вытеснение оборвёт чужую работу.
            busy: null,
            heartbeatAt: new Date().toISOString(),
          }));
        } finally {
          fs.closeSync(fd);
        }
        lockHeld = true;
        if (signalled) {
          write("Старое окно закрыто.");
          logEvent("launcher.takeoverFinished", { pid: owner && owner.pid, forced: killed });
        }
        return {
          ok: true,
          tookOver: signalled,
          forced: killed,
          interrupted: signalled && owner && owner.busy ? owner.busy : null,
        };
      } catch (error) {
        if (!error || error.code !== "EEXIST") {
          // Замок не создать (нет прав, нет каталога) — это не повод молча
          // открыть второе окно: инвариант важнее удобства.
          return {
            ok: false,
            code: "LOCK_FAILED",
            message: "Не удалось взять блокировку launcher (" + lockPath + "): " +
              (error && error.message ? error.message : error),
          };
        }
      }

      var current = readLock();
      if (current) owner = current;
      if (!current && owner && owner.pid && isProcessAlive(owner.pid)) {
        // Замок сейчас переписывают. Живого владельца по одному неудачному
        // чтению не хоронят.
        await sleep(lockPollMs);
        continue;
      }
      if (!owner || !owner.pid || owner.pid === ownPid || !isProcessAlive(owner.pid)) {
        // Владельца нет — замок осиротел. Снимаем и берём заново.
        try { fs.unlinkSync(lockPath); } catch (_e) { /* кто-то успел раньше */ }
        owner = null;
        continue;
      }

      if (!signalled) {
        // Старое окно прямо сейчас переносит дизайн. Молча оборвать чужую
        // многоминутную работу launcher права не имеет — спрашиваем.
        if (owner.busy && !confirmed) {
          var approved = await confirmTakeover({ pid: owner.pid, busy: owner.busy });
          if (!approved) {
            logEvent("launcher.takeoverDeclined", { pid: owner.pid });
            return {
              ok: false,
              code: "OWNER_BUSY_DECLINED",
              pid: owner.pid,
              busy: owner.busy,
              message: "Перенос «" + owner.busy + "» в уже открытом окне продолжается.",
            };
          }
          confirmed = true;
        }
        signalled = true;
        deadline = Date.now() + takeoverGraceMs;
        lastHeartbeat = owner.heartbeatAt || null;
        write("Уже открыто другое окно Pixso → Figma (процесс " + owner.pid + "). Закрываю его…");
        logEvent("launcher.takeoverRequested", { pid: owner.pid, busy: !!owner.busy });
        try {
          killProcess(owner.pid, "SIGTERM");
        } catch (_e) {
          // Процесс исчез между проверкой и сигналом: следующий виток заберёт
          // осиротевший замок.
        }
      } else {
        // Старое окно отмечается в замке, пока закрывается: снимает job с
        // bridge, гасит свой bridge. Это законно долго, и добивать его за то,
        // что оно делает работу, нельзя — дедлайн считается от ПОСЛЕДНЕГО
        // признака жизни, а не от момента сигнала.
        if (owner.heartbeatAt && owner.heartbeatAt !== lastHeartbeat) {
          lastHeartbeat = owner.heartbeatAt;
          deadline = Date.now() + takeoverGraceMs;
        } else if (Date.now() >= deadline) {
          if (killed) {
            return {
              ok: false,
              code: "LOCK_BUSY",
              pid: owner.pid,
              message: "Не удалось закрыть старое окно (процесс " + owner.pid + ").",
            };
          }
          // Признаков жизни нет: окно действительно зависло.
          killed = true;
          deadline = Date.now() + takeoverGraceMs;
          write("Старое окно не отвечает — останавливаю принудительно.");
          try { killProcess(owner.pid, "SIGKILL"); } catch (_e) { /* уже мёртв */ }
        }
      }
      await sleep(lockPollMs);
    }
    return {
      ok: false,
      code: "LOCK_BUSY",
      message: "Не удалось взять блокировку launcher: старое окно всё ещё держит её.",
    };
  }

  function readLock() {
    try {
      return JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch (_error) {
      // Либо замка нет, либо его прямо сейчас переписывают. Отличить одно от
      // другого обязан вызывающий: удалять чужой замок по одному неудачному
      // чтению нельзя.
      return null;
    }
  }

  /**
   * Перезапись замка целиком и атомарно: читатель видит либо старое
   * содержимое, либо новое, но никогда не половину.
   */
  function writeLockAtomic(record) {
    var temporary = lockPath + "." + ownPid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, lockPath);
  }

  /**
   * Отметка «я ещё жив» в собственном замке. По ней новое окно отличает
   * старое, которое честно закрывается, от по-настоящему зависшего.
   */
  function touchLock(extra) {
    if (!lockHeld) return;
    var current = readLock() || {};
    if (current.pid && current.pid !== ownPid) return;
    var record = {
      pid: ownPid,
      bridge: bridgeUrl,
      startedAt: current.startedAt || new Date().toISOString(),
      busy: current.busy === undefined ? null : current.busy,
      heartbeatAt: new Date().toISOString(),
    };
    if (extra && Object.prototype.hasOwnProperty.call(extra, "busy")) record.busy = extra.busy;
    try { writeLockAtomic(record); } catch (_e) { /* замок не критичен для работы */ }
  }

  /** Пока окно закрывается, оно обязано подавать признаки жизни. */
  function startLockHeartbeat() {
    if (lockHeartbeatTimer || !lockHeld) return;
    touchLock();
    lockHeartbeatTimer = setInterval(function () { touchLock(); }, lockHeartbeatMs);
    if (lockHeartbeatTimer.unref) lockHeartbeatTimer.unref();
  }

  function stopLockHeartbeat() {
    if (!lockHeartbeatTimer) return;
    clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = null;
  }

  /** Снимает только СВОЙ замок: чужое живое окно этим закрыть нельзя. */
  function releaseLock() {
    stopLockHeartbeat();
    if (!lockHeld) return;
    lockHeld = false;
    var owner = readLock();
    if (owner && owner.pid && owner.pid !== ownPid) return;
    try { fs.unlinkSync(lockPath); } catch (_e) { /* уже снят */ }
  }

  // -------------------------------------------------------------------------
  // Старт
  // -------------------------------------------------------------------------

  async function start() {
    write("Pixso → Figma");
    write("");
    // Замок берётся ДО bridge: второе окно не должно ни поднимать bridge, ни
    // опрашивать чужой.
    var lock = await acquireLock();
    if (!lock.ok) {
      if (lock.code === "OWNER_BUSY_DECLINED") {
        write(lock.message);
        write("Это окно закрывается — вернитесь в то, где идёт перенос.");
      } else {
        write("✗ " + lock.message);
        if (lock.code === "LOCK_BUSY") {
          write("Закройте лишнее окно Pixso → Figma вручную и запустите команду снова.");
        }
      }
      logEvent("launcher.startRejected", { code: lock.code });
      return lock;
    }
    if (lock.interrupted) {
      // Предупреждение печатало закрытое окно — его пользователь уже не видит.
      write("⚠ Перенос «" + lock.interrupted + "» в том окне прерван.");
      write("В Figma мог остаться частичный импорт: проверьте целевой документ.");
    }
    var bridge = await ensureBridge();
    if (!bridge.ok) {
      write("✗ " + bridge.message);
      return bridge;
    }
    write("Bridge:    " + bridgeUrl + (ownsBridge ? "  (запущен launcher-ом)" : "  (уже работал)"));
    logEvent("launcher.started", { bridge: bridgeUrl, ownsBridge: ownsBridge });

    var status = null;
    try { status = await readStatus(); } catch (_error) { status = null; }
    showStatus(status);
    applyIdleState(status);
    write("");
    write("Перетащите сюда один .pix и нажмите Enter.");
    write("Опыты в живой Figma: введите " + PROBE_COMMAND + " и нажмите Enter.");
    write("Сверка эталонных экранов: введите " + CHECK_COMMAND + " и нажмите Enter.");
    startPolling();
    return {
      ok: true,
      ownsBridge: ownsBridge,
      state: state,
      // Видно снаружи: это окно открылось поверх прежнего.
      tookOver: !!lock.tookOver,
      forced: !!lock.forced,
      interrupted: lock.interrupted || null,
    };
  }

  // -------------------------------------------------------------------------
  // Приём файла
  // -------------------------------------------------------------------------

  /**
   * Id идущей job, если launcher не получил его по IPC (потомок упал сразу
   * после создания job). Снять по нему получится всё равно только свою: без
   * совпадения producer token bridge отвечает отказом.
   */
  async function runningJobId() {
    var status;
    try { status = await readStatus(); } catch (_error) { return null; }
    var job = status && status.job;
    if (!job || job.status !== "running") return null;
    return job.jobId || null;
  }

  /**
   * Снимает с bridge ровно ту job, которую создал наш дочерний процесс.
   *
   * Доказательство владения двойное: `jobId`, пришедший по IPC от собственного
   * потомка, и producer token, который знает только этот launcher и который он
   * передал потомку через окружение. Чужую или параллельную job bridge не
   * отменит даже при ошибке в id — он сверяет токен.
   *
   * Идемпотентно: параллельные вызовы из `runMigration` и `shutdown` делят
   * один запрос, повторные не делают ничего.
   */
  function releaseOwnJob(reason) {
    if (releasing) return releasing;
    var job = activeJob;
    if (!job) return Promise.resolve({ code: "NO_JOB" });
    activeJob = null;
    releasing = (async function () {
      try {
        var jobId = job.jobId || (await runningJobId());
        if (!jobId) return { code: "NO_JOB" };
        var result = await abortJob(jobId, job.token, reason || "launcher-exit");
        var body = result && result.body;
        logEvent("launcher.jobReleased", {
          reason: reason || null,
          status: result ? result.status : null,
          aborted: !!(body && body.aborted),
          declared: !!job.jobId,
        });
        // 403 — job принадлежит не нам: launcher не имеет права её трогать.
        if (result && result.status === 403) return { code: "NOT_OWNED" };
        if (result && result.status === 404) return { code: "NO_JOB" };
        return { code: "OK", aborted: !!(body && body.aborted) };
      } catch (error) {
        write("Не удалось снять migration job с bridge: " +
          (error && error.message ? error.message : error));
        logEvent("launcher.jobReleaseFailed", { reason: reason || null });
        return { code: "ABORT_FAILED" };
      } finally {
        releasing = null;
      }
    })();
    return releasing;
  }

  async function runMigration(filePath, receiverId, documentName, mode) {
    var probe = mode === "probe";
    var check = mode === "check";
    var name = probe ? "опыты Figma" : (check ? "сверка экранов" : path.basename(filePath));
    setState(STATE.BUSY);
    logEvent("launcher.migrationStarted", {
      file: name,
      receiver: fingerprint(receiverId),
      documentName: documentName,
    });

    var args = probe
      ? [cliPath, "--probe-figma", "--receiver-id", receiverId]
      : (check
        ? [cliPath, "--check-screens", path.join(projectDir, REFERENCE_SCREENS_FILE), "--receiver-id", receiverId]
        : [cliPath, filePath, "--migrate-file", "--receiver-id", receiverId]);
    // Токен владения job рождается здесь и уезжает потомку ОКРУЖЕНИЕМ, а не
    // командной строкой: её видно в `ps`.
    var token = makeToken();
    activeJob = { jobId: null, token: token };
    // Новое окно должно видеть, что вытеснение оборвёт именно этот перенос.
    touchLock({ busy: name });
    var child;
    try {
      // Путь уезжает отдельным аргументом массива: оболочки в цепочке нет.
      // stdout/stderr Direct PIX видны в этом же окне; stdin остаётся у
      // readline, иначе дочерний процесс перехватывал бы ввод пользователя.
      // Четвёртый поток — IPC: потомок сообщает id созданной им job, и только
      // её launcher потом имеет право снять.
      child = spawn(execPath, args, {
        cwd: projectDir,
        shell: false,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: Object.assign({}, process.env, { PIXSO2FIGMA_PRODUCER_TOKEN: token }),
      });
    } catch (error) {
      activeJob = null;
      touchLock({ busy: null });
      write("✗ Не удалось запустить Direct PIX: " + error.message);
      logEvent("launcher.migrationFailed", { file: name, reason: "SPAWN_FAILED" });
      await finishMigration();
      return { code: "SPAWN_FAILED" };
    }
    if (child && typeof child.on === "function") {
      child.on("message", function (message) {
        if (!message || message.type !== "pixso2figma.job" || !message.jobId) return;
        // Сообщение от предыдущего потомка не имеет права переписать текущую
        // цель: сверяем токен той job, для которой этот потомок и запускался.
        if (!activeJob || activeJob.token !== token) return;
        activeJob.jobId = String(message.jobId);
        logEvent("launcher.jobPinned", { file: name });
      });
    }
    migrationProcess = trackChild(child);
    var outcome = await migrationProcess.exit;
    migrationProcess = null;
    // Штатный выход Direct PIX закрывает job сам, аварийный — нет. Снимаем
    // безусловно: вызов идемпотентен, а зависшая `running` job заблокировала бы
    // переиспользуемый bridge и для следующего Receiver, и для следующей job.
    await releaseOwnJob(outcome.code === 0 ? "cli-exit" : "cli-aborted");
    touchLock({ busy: null });

    if (state === STATE.SHUTTING_DOWN || state === STATE.STOPPED) {
      return { code: outcome.code === 0 ? "OK" : "FAILED", exitCode: outcome.code, interrupted: true };
    }

    if (outcome.code === 0) {
      if (probe) {
        write("✓ Опыты выполнены в " + documentName + ". Карта возможностей: FIGMA_CAPABILITIES.md");
      } else if (check) {
        write("✓ Сверка экранов выполнена в " + documentName + ". Отчёт — в папке ScreenChecks (путь выше).");
      } else {
        write("✓ " + name + " перенесён в " + documentName);
      }
      write("Можно перетащить следующий .pix и нажать Enter.");
      logEvent("launcher.migrationFinished", {
        file: name,
        receiver: fingerprint(receiverId),
        documentName: documentName,
      });
      await finishMigration();
      return { code: "OK", exitCode: 0 };
    }

    if (probe || check) {
      write("✗ " + (probe ? "Опыты Figma" : "Сверка экранов") +
        " не завершены. Подробности — в выводе выше и в логе bridge.");
    } else {
      write("✗ Migration " + name + " не завершена.");
      write("В Figma мог остаться частичный импорт. Проверьте целевой документ перед повтором.");
    }
    write("Автоматический retry не выполнялся.");
    logEvent("launcher.migrationFailed", {
      file: name,
      receiver: fingerprint(receiverId),
      documentName: documentName,
      exitCode: outcome.code,
      signal: outcome.signal || null,
    });
    await finishMigration();
    return { code: "FAILED", exitCode: outcome.code, signal: outcome.signal || null };
  }

  /** Снимает BUSY ровно один раз и пересчитывает назначение по свежему статусу. */
  async function finishMigration() {
    if (state !== STATE.BUSY) return;
    var status = null;
    try { status = await readStatus(); } catch (_error) { status = null; }
    // Пока читали статус, пользователь мог закрыть launcher: из SHUTTING_DOWN
    // возвращаться в idle нельзя.
    if (state !== STATE.BUSY) return;
    var ready = !!(status && status.ready && status.receiverId);
    setState(ready ? STATE.IDLE_READY : STATE.IDLE_NO_RECEIVER);
    shown = { ready: false, receiverId: null, documentName: null };
    showStatus(status);
  }

  async function submit(line) {
    if (state === STATE.BUSY) {
      write("Migration уже выполняется. Второй файл не поставлен в очередь.");
      return { code: "BUSY_REJECTED" };
    }
    if (state === STATE.SHUTTING_DOWN || state === STATE.STOPPED) return { code: "STOPPED" };
    // Второй Enter в окне между принятием пути и появлением BUSY тоже не
    // создаёт очереди: он просто игнорируется.
    if (submitting) return { code: "BUSY_REJECTED", silent: true };

    submitting = true;
    try {
      // `probe` — опыты в живой Figma. Файл не
      // нужен, но Receiver проверяется тем же путём, что и перед migration.
      var command = String(line || "").trim().toLowerCase();
      var probe = command === PROBE_COMMAND;
      var check = command === CHECK_COMMAND;
      var file = { ok: true, path: null };
      if (!probe && !check) {
        var parsed = parseDroppedPaths(line, platform);
        if (!parsed.ok) {
          if (parsed.code !== "EMPTY") write("✗ " + parsed.message);
          return { code: parsed.code };
        }

        file = validateDroppedFile(parsed.paths[0], statSync);
        if (!file.ok) {
          write("✗ " + file.message);
          return { code: file.code };
        }
      }

      // Активный Receiver перечитывается непосредственно перед запуском.
      var status;
      try {
        status = await readStatus();
      } catch (error) {
        write("✗ Bridge недоступен: " + (error && error.message ? error.message : error));
        write("Файл не поставлен в очередь.");
        return { code: "BRIDGE_UNREACHABLE" };
      }

      if (!status || !status.ready || !status.receiverId) {
        // Путь не запоминается: скрытой очереди и автостарта у launcher нет.
        // Поэтому и подсказка не зовёт «нажать Enter ещё раз» — пустой Enter
        // ничего не запустит, путь нужно передать заново.
        if (statusChanged(status)) showStatus(status);
        applyIdleState(status);
        write(probe || check
          ? "✗ Receiver не подключён. " + (probe ? "Опыты" : "Сверка") + " не начаты."
          : "✗ Receiver не подключён. Файл " + path.basename(file.path) + " не поставлен в очередь.");
        write("Включите Receiver в нужном файле Figma.");
        write("Перетащите файл заново и нажмите Enter.");
        return { code: "NO_RECEIVER" };
      }

      if (announcedReceiverId && announcedReceiverId !== status.receiverId) {
        // Назначение сменилось после того, как его показали: молча отправлять
        // документ в другой файл нельзя. Путь при этом тоже не запоминается,
        // поэтому подсказка просит передать файл заново, а не «нажать Enter».
        showStatus(status);
        applyIdleState(status);
        write("✗ Назначение изменилось: теперь активен «" + destinationName(status) + "».");
        write(probe || check
          ? (probe ? "Опыты" : "Сверка") + " не начаты."
          : "Migration " + path.basename(file.path) + " не начата, файл не поставлен в очередь.");
        write("Перетащите файл заново и нажмите Enter.");
        return { code: "RECEIVER_CHANGED" };
      }

      announcedReceiverId = status.receiverId;
      var documentName = destinationName(status);
      if (probe || check) {
        write("Назначение: " + documentName);
        write(probe ? "Начинаю опыты в Figma…" : "Переношу эталонные экраны и сверяю с Pixso…");
        return await runMigration(null, status.receiverId, documentName, probe ? "probe" : "check");
      }
      write("Файл:       " + path.basename(file.path));
      write("Назначение: " + documentName);
      write("Начинаю migration…");
      return await runMigration(file.path, status.receiverId, documentName);
    } finally {
      submitting = false;
    }
  }

  // -------------------------------------------------------------------------
  // Завершение
  // -------------------------------------------------------------------------

  function shutdown(reason) {
    // Идемпотентность: повторный сигнал не начинает второй цикл и уж точно
    // не запускает следующую migration.
    if (shutdownPromise) return shutdownPromise;
    if (state === STATE.STOPPED) return Promise.resolve({ ok: true, state: state });

    shutdownPromise = (async function () {
      var wasBusy = state === STATE.BUSY;
      setState(STATE.SHUTTING_DOWN);
      stopPolling();
      // Закрытие занимает секунды: снять job с bridge, погасить свой bridge.
      // Пока это идёт, окно обязано отмечаться в замке, иначе новое окно
      // сочтёт его зависшим и добьёт SIGKILL — а тогда bridge осиротеет,
      // а job навсегда останется running.
      startLockHeartbeat();
      if (wasBusy) {
        write("");
        write("⚠ Migration прервана до завершения.");
        write("В Figma мог остаться частичный импорт: проверьте целевой документ.");
      }
      if (migrationProcess) {
        var record = migrationProcess;
        migrationProcess = null;
        await terminateChild(record, "Direct PIX");
      }
      // Job снимается до решения о судьбе bridge и независимо от того, чей он.
      // Именно этот вызов спасает переиспользуемый bridge: launcher уходит, а
      // job не остаётся `running` навсегда.
      var released = await releaseOwnJob("launcher-" + (reason || "exit"));
      if (released && released.code === "OK" && released.aborted) {
        write("Migration job снята с bridge: следующая миграция стартует без его перезапуска.");
      }
      if (ownsBridge) {
        await stopOwnedBridge();
        write("Bridge, запущенный launcher-ом, остановлен.");
      } else {
        write("Bridge оставлен работать: launcher его не запускал.");
      }
      logEvent("launcher.stopped", { reason: reason || "exit", ownsBridge: ownsBridge });
      // Замок снимается последним: пока launcher гасит bridge и job, второе
      // окно стартовать всё ещё не имеет права.
      releaseLock();
      setState(STATE.STOPPED);
      return { ok: true, state: state };
    })();
    return shutdownPromise;
  }

  return {
    STATE: STATE,
    state: function () { return state; },
    ownsBridge: function () { return ownsBridge; },
    announcedReceiverId: function () { return announcedReceiverId; },
    lockPath: function () { return lockPath; },
    holdsLock: function () { return lockHeld; },
    activeJobId: function () { return activeJob ? activeJob.jobId : null; },
    bridgeProcess: function () { return bridgeProcess; },
    migrationProcess: function () { return migrationProcess; },
    ensureBridge: ensureBridge,
    start: start,
    submit: submit,
    refreshStatus: refreshStatus,
    shutdown: shutdown,
  };
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

function parseLauncherArgs(argv) {
  var options = { bridge: DEFAULT_BRIDGE_URL, help: false };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--bridge" && argv[i + 1]) options.bridge = String(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
  }
  return options;
}

var USAGE = [
  "Pixso2Figma Terminal Launcher",
  "",
  "  node Launcher/Terminal.js [--bridge http://localhost:8787]",
  "",
  "Перетащите в окно один файл .pix и нажмите Enter.",
  "Команда probe — опыты в живой Figma (карта FIGMA_CAPABILITIES.md).",
].join("\n");

async function main(argv) {
  var options = parseLauncherArgs(argv || []);
  if (options.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  var client = BridgeClient.createClient({ bridge: options.bridge });
  var output = process.stdout;
  var rl = readline.createInterface({ input: process.stdin, output: output, prompt: "> " });
  var promptActive = false;

  /** Печать над приглашением: уже набранная строка сохраняется. */
  function print(text) {
    if (output.isTTY && promptActive) {
      readline.cursorTo(output, 0);
      readline.clearLine(output, 0);
    }
    output.write(String(text) + "\n");
    // `prompt(true)` перерисовывает приглашение вместе с текущим вводом.
    // После закрытия readline приглашения уже нет: сообщения завершения
    // печатаются просто строками.
    if (!promptActive) return;
    try { rl.prompt(true); } catch (_e) { promptActive = false; }
  }

  var launcher = createLauncher({
    bridgeUrl: options.bridge,
    spawn: childProcess.spawn,
    statSync: fs.statSync,
    write: print,
    probeHealth: function () { return client.health(); },
    readStatus: async function () {
      var response = await client.status();
      if (response.status !== 200 || !response.body) throw new Error("Bridge не отвечает по " + options.bridge);
      return response.body;
    },
    abortJob: function (jobId, token, reason) {
      return client.abortJob(jobId, token, reason);
    },
    confirmTakeover: function (info) {
      return new Promise(function (resolve) {
        print("");
        print("⚠ В уже открытом окне идёт перенос «" + info.busy + "».");
        print("Если прервать его, в Figma может остаться частичный импорт.");
        rl.resume();
        rl.question("Прервать перенос и работать здесь? [y — прервать, Enter — нет] ",
          function (answer) {
            rl.pause();
            // По умолчанию чужая работа не прерывается: Enter означает «нет».
            resolve(/^(y|yes|д|да)$/i.test(String(answer || "").trim()));
          });
      });
    },
    log: function (event, data) {
      client.postLog({ source: "launcher", level: "info", event: event, data: data });
    },
  });

  // Ввод, сделанный до конца старта, не должен теряться: readline держит
  // stdin на паузе, а обработчики уже стоят. Иначе строка, набранная во время
  // запуска bridge, исчезала бы без следа.
  rl.pause();

  var exitCode = 0;
  var finished = new Promise(function (resolve) {
    function stop(reason, code) {
      exitCode = code === undefined ? exitCode : code;
      // Приглашения больше нет: дальше печатаем обычные строки.
      promptActive = false;
      launcher.shutdown(reason).then(function () {
        promptActive = false;
        try { rl.close(); } catch (_e) { /* уже закрыт */ }
        resolve(exitCode);
      });
    }

    // Решение «рисовать ли `>`» живёт в shouldShowPrompt и проверяется тестом:
    // во время BUSY второй Enter получает отказ, но приглашения не получает.
    rl.on("line", createLineHandler(launcher, {
      hidePrompt: function () { promptActive = false; },
      showPrompt: function () {
        promptActive = true;
        rl.prompt();
      },
      onError: function (error) {
        print("✗ Внутренняя ошибка обработки ввода: " + ((error && error.message) || error));
      },
    }));

    rl.on("close", function () {
      if (launcher.state() === STATE.STOPPED || launcher.state() === STATE.SHUTTING_DOWN) return;
      output.write("\n");
      stop("close");
    });

    ["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (signal) {
      process.on(signal, function () {
        output.write("\n");
        stop(signal);
      });
    });
  });

  var started = await launcher.start();
  if (!started.ok) {
    await launcher.shutdown("start-failed");
    try { rl.close(); } catch (_e) { /* уже закрыт */ }
    // Пользователь сам решил не прерывать чужой перенос — это не ошибка:
    // окно просто закрывается, и обёртке нечего добавить.
    if (started.code === "OWNER_BUSY_DECLINED") return 0;
    // Отдельный код: старое окно не удалось закрыть. Launcher объяснил это
    // сам, и обёртке не нужно печатать поверх ещё и «завершился с кодом».
    return started.code === "LOCK_BUSY" ? EXIT_LOCK_BUSY : 1;
  }

  promptActive = true;
  rl.prompt();
  rl.resume();
  return await finished;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }, function (error) {
    process.stderr.write("Launcher не запустился: " + ((error && error.stack) || error) + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  STATE: STATE,
  TRANSITIONS: TRANSITIONS,
  DEFAULT_BRIDGE_URL: DEFAULT_BRIDGE_URL,
  PROBE_COMMAND: PROBE_COMMAND,
  CHECK_COMMAND: CHECK_COMMAND,
  EXIT_LOCK_BUSY: EXIT_LOCK_BUSY,
  PROJECT_DIR: PROJECT_DIR,
  DIRECT_CLI_PATH: DIRECT_CLI_PATH,
  BRIDGE_SERVER_PATH: BRIDGE_SERVER_PATH,
  parseDroppedPaths: parseDroppedPaths,
  validateDroppedFile: validateDroppedFile,
  parseLauncherArgs: parseLauncherArgs,
  lockPathFor: lockPathFor,
  processAlive: processAlive,
  shouldShowPrompt: shouldShowPrompt,
  createLineHandler: createLineHandler,
  createLauncher: createLauncher,
  main: main,
};
