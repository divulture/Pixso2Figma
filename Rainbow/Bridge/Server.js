/**
 * Pixso2Figma Local Bridge.
 *
 * Транспорт для автоматической миграции Pixso → Figma. Единственная новая
 * самостоятельная часть системы.
 *
 * Bridge НЕ понимает формат pixso-portable-package: он переносит непрозрачный
 * payload, статусы, ACK и ошибки. Очередь всегда размером 1 — это и есть
 * backpressure: producer (Pixso) не может отправить следующий task, пока
 * consumer (Figma) не подтвердил предыдущий.
 *
 * Зависимостей нет. Слушает только localhost.
 *
 *   node Bridge/Server.js [--port 8787] [--host 127.0.0.1]
 */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var BRIDGE_VERSION = "0.1.0";
/**
 * Версия ТРАНСПОРТА bridge. Поднята до 2 вместе с receiver lease: с этого
 * момента каждый receiver-owned запрос обязан нести выданный `receiverId`,
 * поэтому старый клиент протокола 1 совместимым не является.
 *
 * Это не версия `pixso-portable-package` и не `DIRECT_PROTOCOL_VERSION`
 * Direct PIX: содержимое payload bridge по-прежнему не разбирает.
 */
var PROTOCOL_VERSION = 2;

var DEFAULT_PORT = 8787;
var DEFAULT_HOST = "127.0.0.1";

/** Приёмник считается живым, пока обращался к bridge не позже этого срока. */
var RECEIVER_TTL_MS = 45000;
/** Максимальное удержание long-poll запроса. Ниже типового HTTP-таймаута UI. */
var MAX_WAIT_MS = 25000;
/**
 * Сколько ждём ACK после выдачи task приёмнику, прежде чем считать его
 * зависшим. Отсчёт перезапускается на каждом heartbeat приёмника по ЭТОЙ
 * задаче: живой плагин, который честно строит тяжёлый корень, в таймаут не
 * упирается, а по-настоящему умерший — упирается ровно как раньше.
 */
var TASK_ACK_TIMEOUT_MS = 300000;
/** Защита от случайного OOM: один chunk не должен быть больше этого. */
var MAX_BODY_BYTES = 96 * 1024 * 1024;

/** Диагностика. Плагины писать на диск не могут, поэтому шлют события сюда. */
var LOG_DIR = path.join(__dirname, "Logs");
var MAX_LOG_ENTRY_CHARS = 8000;
/** Кольцевой буфер в памяти — чтобы GET /log/tail не читал файл. */
var LOG_RING_LIMIT = 2000;
var logRing = [];
var logStream = null;
var logFilePath = null;

// ---------------------------------------------------------------------------
// Диагностический лог
// ---------------------------------------------------------------------------

function logFileFor(date) {
  var stamp =
    date.getFullYear() +
    "-" + ("0" + (date.getMonth() + 1)).slice(-2) +
    "-" + ("0" + date.getDate()).slice(-2);
  return path.join(LOG_DIR, "pixso2figma-" + stamp + ".log");
}

function ensureLogStream() {
  var wanted = logFileFor(new Date());
  if (logStream && logFilePath === wanted) return logStream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (logStream) logStream.end();
    logStream = fs.createWriteStream(wanted, { flags: "a" });
    // Диск может быть недоступен; логирование не должно валить bridge.
    logStream.on("error", function () { logStream = null; });
    logFilePath = wanted;
  } catch (_e) {
    logStream = null;
  }
  return logStream;
}

function truncate(value) {
  if (typeof value !== "string") return value;
  return value.length > MAX_LOG_ENTRY_CHARS
    ? value.slice(0, MAX_LOG_ENTRY_CHARS) + "…[обрезано]"
    : value;
}

/** Одна запись — одна строка JSON. Формат осознанно плоский: grep работает. */
function writeLog(entry) {
  var record = {
    ts: new Date().toISOString(),
    source: String(entry.source || "bridge"),
    level: String(entry.level || "info"),
    event: String(entry.event || "message"),
  };
  if (entry.jobId) record.jobId = String(entry.jobId);
  if (entry.taskId) record.taskId = String(entry.taskId);
  if (entry.message !== undefined) record.message = truncate(String(entry.message));
  if (entry.data !== undefined) {
    // Обрезка ломает JSON посередине, и `JSON.parse` на ней бросает. Раньше
    // catch писал `String(entry.data)` — то есть «[object Object]», и весь
    // ответ задачи пропадал из лога целиком. Ровно так исчезали коды
    // диагностики приёмника. Поэтому обрезанное значение сохраняется СТРОКОЙ,
    // а не подменяется бесполезным приведением объекта.
    var serialized;
    try { serialized = JSON.stringify(entry.data); }
    catch (_eStringify) { serialized = null; }
    if (serialized === null || serialized === undefined) {
      record.data = String(entry.data);
    } else if (serialized.length <= MAX_LOG_ENTRY_CHARS) {
      try { record.data = JSON.parse(serialized); }
      catch (_eParse) { record.data = serialized; }
    } else {
      record.data = { truncated: true, chars: serialized.length, json: truncate(serialized) };
    }
  }

  logRing.push(record);
  if (logRing.length > LOG_RING_LIMIT) logRing.splice(0, logRing.length - LOG_RING_LIMIT);

  var stream = ensureLogStream();
  if (stream) {
    try { stream.write(JSON.stringify(record) + "\n"); } catch (_eWrite) { /* лог не критичен */ }
  }
  return record;
}

function logBridge(level, event, extra) {
  var entry = { source: "bridge", level: level, event: event };
  if (extra) {
    if (extra.jobId) entry.jobId = extra.jobId;
    if (extra.taskId) entry.taskId = extra.taskId;
    if (extra.message) entry.message = extra.message;
    if (extra.data) entry.data = extra.data;
  }
  return writeLog(entry);
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

var state = {
  receiver: null,
  // Активная job. Bridge держит ровно одну.
  job: null,
  // Очередь размером 1: либо null, либо единственный task.
  current: null,
  // Идемпотентность в рамках job: taskId -> { status, result, error }.
  processed: Object.create(null),
  // Ожидающие long-poll ответы.
  waitingReceiver: [],
  waitingProducer: [],
};

function now() {
  return Date.now();
}

/**
 * Приёмник держит выданную ему задачу идущей job и ещё не прислал ACK.
 *
 * Это не молчание «пропавшего» приёмника, а работа: один тяжёлый корень
 * строится минутами, и всё это время плагин к bridge не обращается — ему
 * просто нечего сказать.
 */
function receiverHoldsDeliveredTask() {
  return !!(
    state.receiver &&
    state.job && state.job.status === "running" &&
    state.job.receiverId === state.receiver.receiverId &&
    state.current && state.current.status === "delivered"
  );
}

/**
 * TTL простоя судит только ПРАЗДНЫЙ приёмник. Пока bridge сам ждёт ACK по
 * отданной задаче, объявлять её адресата исчезнувшим он не имеет права: иначе
 * длинный корень «терял lease» на ровном месте, ACK прилетал в отказ
 * `RECEIVER_SUPERSEDED`, и UI сообщал про «другой Receiver», которого никто
 * не включал. Судьбу занятого приёмника решает ACK-таймаут, а не TTL.
 */
function receiverReady() {
  if (!state.receiver) return false;
  if (now() - state.receiver.lastSeen <= RECEIVER_TTL_MS) return true;
  return receiverHoldsDeliveredTask();
}

function touchReceiver() {
  if (state.receiver) state.receiver.lastSeen = now();
}

function makeId(prefix) {
  return (
    prefix +
    "-" +
    now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Идентификатор lease приёмника. Непрозрачный и криптографически случайный:
 * по нему нельзя угадать чужую сессию, а имя документа или время старта в нём
 * не участвуют — два окна одного файла обязаны получать разные id.
 */
function makeReceiverId() {
  return "receiver-" + crypto.randomBytes(24).toString("hex");
}

/** Короткий отпечаток для лога: полный id в диагностику не пишем. */
function fingerprint(receiverId) {
  if (!receiverId) return null;
  return String(receiverId).slice(-8);
}

/**
 * Доказательство владения job.
 *
 * Продюсер объявляет секрет при создании job, bridge хранит только его
 * SHA-256: ни снимок job, ни диагностический лог токен не показывают. Отменить
 * job снаружи может лишь тот, кто предъявит исходный секрет, — поэтому у
 * bridge нет и не должно появиться endpoint «просто закрой текущую job».
 *
 * Job, созданная без токена (прежний конвейер Pixso), не отменяема извне
 * вовсе: доказать владение ей нечем, и молча гасить её никому не разрешено.
 */
function hashProducerToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest();
}

function producerTokenMatches(expectedHash, token) {
  if (!expectedHash || !token) return false;
  var actual = hashProducerToken(token);
  if (actual.length !== expectedHash.length) return false;
  // Сравнение постоянного времени: по скорости отказа секрет не подбирается.
  return crypto.timingSafeEqual(actual, expectedHash);
}

/** Активный lease или null. Просроченный TTL — уже не активный. */
function activeReceiverId() {
  return receiverReady() ? state.receiver.receiverId : null;
}

function activeDocumentName() {
  return receiverReady() ? state.receiver.documentName : null;
}

function jobRunning() {
  return !!(state.job && state.job.status === "running");
}

/**
 * Проверка владельца receiver-owned запроса.
 *
 * Возвращает null, если запрос разрешён, иначе — готовый отказ
 * `{ status, payload }`. Вызывается и перед постановкой long-poll, и повторно
 * после его пробуждения: задачу нельзя отдать ожидающему опросу, чей lease уже
 * перебит новым Receiver.
 */
function receiverAuthProblem(receiverId) {
  if (!receiverId) {
    return {
      status: 400,
      payload: {
        ok: false,
        code: "RECEIVER_ID_REQUIRED",
        message: "Запрос приёмника обязан содержать receiverId, выданный /receiver/hello.",
        protocolVersion: PROTOCOL_VERSION,
      },
    };
  }
  var active = activeReceiverId();
  if (!active || active !== receiverId) {
    return {
      status: 409,
      payload: {
        ok: false,
        code: "RECEIVER_SUPERSEDED",
        message: active
          ? "Активирован другой Receiver."
          : "Этот Receiver больше не активен.",
        // Ограниченная полезная нагрузка: только то, что нужно UI для понятного
        // статуса. Полный id чужой сессии наружу не отдаём.
        documentName: activeDocumentName(),
        receiverActive: !!active,
      },
    };
  }
  // Задача закреплена за приёмником в момент создания job: переключить цель
  // ИДУЩЕЙ job нельзя даже тому, кто сейчас активен. Закрытая job цель больше
  // не удерживает — иначе следующий Receiver не смог бы даже опрашивать bridge.
  if (jobRunning() && state.job.receiverId && state.job.receiverId !== receiverId) {
    return {
      status: 409,
      payload: {
        ok: false,
        code: "RECEIVER_SUPERSEDED",
        message: "Job закреплена за другим Receiver.",
        documentName: state.job.receiverDocumentName || null,
        receiverActive: true,
      },
    };
  }
  return null;
}

/** Единая точка отказа: отвечает клиенту и пишет причину в диагностику. */
function rejectReceiver(res, route, receiverId, problem) {
  logBridge("warn", "receiver.requestRejected", {
    jobId: state.job ? state.job.jobId : null,
    data: {
      route: route,
      code: problem.payload.code,
      receiver: fingerprint(receiverId),
      active: fingerprint(activeReceiverId()),
    },
  });
  sendJson(res, problem.status, problem.payload);
}

function jobSnapshot() {
  if (!state.job) return null;
  return {
    jobId: state.job.jobId,
    status: state.job.status,
    source: state.job.source,
    // Чей это конвейер. Bridge по-прежнему не разбирает payload — он лишь
    // показывает объявленный источник, чтобы Direct PIX было видно снаружи.
    sourceMode: state.job.sourceMode,
    // Цель job фиксируется при её создании и дальше неизменяема.
    receiverId: state.job.receiverId || null,
    receiverDocumentName: state.job.receiverDocumentName || null,
    createdAt: state.job.createdAt,
    sequence: state.job.sequence,
    tasksAcked: state.job.tasksAcked,
    error: state.job.error,
    currentTaskId: state.current ? state.current.task.taskId : null,
    currentStatus: state.current ? state.current.status : null,
  };
}

function receiverSnapshot() {
  var ready = receiverReady();
  return {
    ready: ready,
    receiverId: ready ? state.receiver.receiverId : null,
    receiverVersion: ready ? state.receiver.receiverVersion : null,
    protocolVersion: PROTOCOL_VERSION,
    documentName: ready ? state.receiver.documentName : null,
    bridgeVersion: BRIDGE_VERSION,
    job: jobSnapshot(),
  };
}

// ---------------------------------------------------------------------------
// Long-poll помощники
// ---------------------------------------------------------------------------

function clampWait(raw) {
  var value = Number(raw);
  if (!isFinite(value) || value <= 0) return 0;
  return Math.min(value * 1000, MAX_WAIT_MS);
}

function registerWaiter(list, waitMs, onWake, onTimeout) {
  var entry = { onWake: onWake, done: false };
  entry.timer = setTimeout(function () {
    if (entry.done) return;
    entry.done = true;
    removeWaiter(list, entry);
    onTimeout();
  }, waitMs);
  list.push(entry);
}

function removeWaiter(list, entry) {
  var index = list.indexOf(entry);
  if (index >= 0) list.splice(index, 1);
}

function wakeAll(list) {
  var pending = list.splice(0, list.length);
  for (var i = 0; i < pending.length; i++) {
    var entry = pending[i];
    if (entry.done) continue;
    entry.done = true;
    clearTimeout(entry.timer);
    try {
      entry.onWake();
    } catch (_e) {
      /* ответ уже мог быть отправлен */
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP-утилиты
// ---------------------------------------------------------------------------

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  var body = JSON.stringify(payload === undefined ? {} : payload);
  cors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(body);
}

function sendEmpty(res, status) {
  if (res.writableEnded) return;
  cors(res);
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end();
}

function readBody(req, callback) {
  var chunks = [];
  var size = 0;
  var failed = false;

  req.on("data", function (chunk) {
    if (failed) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      failed = true;
      callback(new Error("Payload больше " + MAX_BODY_BYTES + " байт"), null);
      try {
        req.destroy();
      } catch (_e) {
        /* уже закрыт */
      }
      return;
    }
    chunks.push(chunk);
  });

  req.on("error", function (error) {
    if (failed) return;
    failed = true;
    callback(error, null);
  });

  req.on("end", function () {
    if (failed) return;
    if (!chunks.length) return callback(null, {});
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      callback(new Error("Невалидный JSON в теле запроса"), null);
    }
  });
}

// ---------------------------------------------------------------------------
// Жизненный цикл job/task
// ---------------------------------------------------------------------------

function failCurrentTask(code, message) {
  if (!state.current) return;
  logBridge("error", "task.failed", {
    jobId: state.current.task.jobId,
    taskId: state.current.task.taskId,
    message: message,
    data: { code: code, type: state.current.task.type },
  });
  state.current.status = "error";
  state.current.error = { code: code, message: message };
  state.processed[state.current.task.taskId] = {
    status: "error",
    error: state.current.error,
  };
  wakeAll(state.waitingProducer);
}

function clearAckTimer() {
  if (state.current && state.current.ackTimer) {
    clearTimeout(state.current.ackTimer);
    state.current.ackTimer = null;
  }
}

function armAckTimer() {
  clearAckTimer();
  var task = state.current;
  if (!task) return;
  task.ackTimer = setTimeout(function () {
    if (state.current !== task || task.status !== "delivered") return;
    failCurrentTask("TASK_TIMEOUT", "Receiver не подтвердил task за отведённое время.");
  }, TASK_ACK_TIMEOUT_MS);
}

function finishJob(status, error) {
  if (!state.job) return;
  // Исход закрытой job неизменяем. Прерванный продюсер успевает прислать свой
  // `finish("failed")` уже ПОСЛЕ отмены — и без этой защиты снятая job
  // возвращалась бы в лог как «failed», теряя настоящую причину.
  if (state.job.status !== "running") return;
  logBridge(status === "done" ? "info" : "error", "job.finished", {
    jobId: state.job.jobId,
    message: error && error.message,
    data: {
      status: status,
      tasksAcked: state.job.tasksAcked,
      sequence: state.job.sequence,
      elapsedMs: now() - new Date(state.job.createdAt).getTime(),
    },
  });
  state.job.status = status;
  state.job.error = error || null;
  clearAckTimer();
  state.current = null;
  wakeAll(state.waitingProducer);
  wakeAll(state.waitingReceiver);
}

// ---------------------------------------------------------------------------
// Обработчики маршрутов
// ---------------------------------------------------------------------------

function handleReceiverStatus(req, res, query) {
  // GET /receiver/status — используется и Pixso (handshake), и самим приёмником.
  // Обращение приёмника продлевает его TTL, обращение продюсера — нет.
  // Heartbeat приёмника — такой же receiver-owned вызов: без своего lease он
  // не имеет права продлевать TTL чужой активной сессии.
  if (query.role === "receiver") {
    var problem = receiverAuthProblem(query.receiverId);
    if (problem) return rejectReceiver(res, "/receiver/status", query.receiverId, problem);
    touchReceiver();
    // Heartbeat по конкретной задаче: приёмник сообщает, что ещё строит именно
    // её. Подтвердить так можно только СВОЮ выданную задачу — ни чужую, ни
    // уже закрытую.
    if (query.taskId && state.current && state.current.status === "delivered" &&
        state.current.task.taskId === String(query.taskId)) {
      armAckTimer();
      logBridge("info", "task.heartbeat", {
        jobId: state.job ? state.job.jobId : null,
        taskId: state.current.task.taskId,
        data: { heldMs: state.current.deliveredAt ? now() - state.current.deliveredAt : null },
      });
    }
  }
  sendJson(res, 200, receiverSnapshot());
}

/**
 * POST /receiver/hello.
 *
 * Без `receiverId` — заявка на новый lease («последний включённый Receiver»
 * становится единственной целью). С `receiverId` — повторное рукопожатие уже
 * существующей сессии: оно обновляет metadata и TTL, но НЕ создаёт новый
 * lease и не перебивает само себя.
 */
function handleReceiverHello(req, res, body) {
  if (Number(body.protocolVersion) !== PROTOCOL_VERSION) {
    logBridge("warn", "receiver.requestRejected", {
      data: { route: "/receiver/hello", code: "PROTOCOL_MISMATCH", got: body.protocolVersion },
    });
    return sendJson(res, 409, {
      ok: false,
      code: "PROTOCOL_MISMATCH",
      message: "Bridge использует transport protocolVersion " + PROTOCOL_VERSION + ".",
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  var documentName = body.documentName ? String(body.documentName) : null;
  var receiverVersion = String(body.receiverVersion || "unknown");
  var claimed = body.receiverId ? String(body.receiverId) : null;

  if (claimed) {
    // Повторное рукопожатие активной сессии.
    if (activeReceiverId() !== claimed) {
      // Неизвестный или устаревший id не имеет права молча создать сессию:
      // UI обязан явно начать Receiver заново, уже без id.
      return rejectReceiver(res, "/receiver/hello", claimed, {
        status: 409,
        payload: {
          ok: false,
          code: "RECEIVER_SUPERSEDED",
          message: "Эта сессия Receiver больше не активна. Включите Receiver заново.",
          documentName: activeDocumentName(),
          receiverActive: !!activeReceiverId(),
        },
      });
    }
    state.receiver.receiverVersion = receiverVersion;
    if (documentName) state.receiver.documentName = documentName;
    touchReceiver();
    logBridge("info", "receiver.hello", {
      data: { receiver: fingerprint(claimed), documentName: state.receiver.documentName, renewed: true },
    });
    wakeAll(state.waitingProducer);
    return sendJson(res, 200, receiverSnapshot());
  }

  // Во время running job цель миграции неизменяема: новый Receiver не может
  // перехватить задачу у того, кому она уже отдана.
  if (jobRunning()) {
    logBridge("warn", "receiver.switchRejected", {
      jobId: state.job.jobId,
      data: {
        code: "RECEIVER_SWITCH_BLOCKED",
        pinned: fingerprint(state.job.receiverId),
        documentName: state.job.receiverDocumentName || activeDocumentName(),
      },
    });
    return sendJson(res, 409, {
      ok: false,
      code: "RECEIVER_SWITCH_BLOCKED",
      message: "Идёт migration в другой документ. Дождитесь её завершения и включите Receiver снова.",
      jobId: state.job.jobId,
      documentName: state.job.receiverDocumentName || activeDocumentName(),
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  var superseded = activeReceiverId();
  state.receiver = {
    receiverId: makeReceiverId(),
    receiverVersion: receiverVersion,
    protocolVersion: PROTOCOL_VERSION,
    documentName: documentName,
    lastSeen: now(),
  };
  if (superseded) {
    logBridge("info", "receiver.superseded", {
      data: { previous: fingerprint(superseded), next: fingerprint(state.receiver.receiverId) },
    });
  }
  logBridge("info", "receiver.activated", {
    data: {
      receiver: fingerprint(state.receiver.receiverId),
      receiverVersion: receiverVersion,
      documentName: documentName,
    },
  });
  // Ожидающие long-poll прежнего Receiver обязаны проснуться и получить отказ,
  // а не дождаться следующей задачи и увести её у нового.
  wakeAll(state.waitingReceiver);
  wakeAll(state.waitingProducer);
  sendJson(res, 200, receiverSnapshot());
}

function handleReceiverBye(req, res, body) {
  var receiverId = body && body.receiverId ? String(body.receiverId) : null;
  var problem = receiverAuthProblem(receiverId);
  // Старый Receiver не может своим /bye отключить нового.
  if (problem) return rejectReceiver(res, "/receiver/bye", receiverId, problem);

  logBridge("info", "receiver.bye", { data: { receiver: fingerprint(receiverId) } });
  state.receiver = null;
  if (jobRunning()) {
    failCurrentTask("RECEIVER_GONE", "Receiver mode выключен.");
    finishJob("failed", { code: "RECEIVER_GONE", message: "Receiver mode выключен." });
  }
  wakeAll(state.waitingReceiver);
  wakeAll(state.waitingProducer);
  sendJson(res, 200, { ok: true });
}

function deliverTask(res) {
  logBridge("info", "task.delivered", {
    jobId: state.current.task.jobId,
    taskId: state.current.task.taskId,
    data: { type: state.current.task.type, sequence: state.current.task.sequence },
  });
  state.current.status = "delivered";
  state.current.deliveredAt = now();
  armAckTimer();
  sendJson(res, 200, { task: state.current.task, job: jobSnapshot() });
}

function handleReceiverTask(req, res, query) {
  var receiverId = query.receiverId;
  var problem = receiverAuthProblem(receiverId);
  if (problem) return rejectReceiver(res, "/receiver/task", receiverId, problem);
  touchReceiver();

  function tryDeliver() {
    if (!state.current) return false;
    if (state.current.status !== "pending" && state.current.status !== "delivered") return false;
    // Повторная выдача уже доставленного task допустима: приёмник мог
    // перезапустить polling, не успев прислать ACK. Идемпотентность на
    // стороне приёмника защищает от повторного импорта.
    deliverTask(res);
    return true;
  }

  if (tryDeliver()) return;

  var waitMs = clampWait(query.wait);
  if (!waitMs) return sendEmpty(res, 204);

  registerWaiter(
    state.waitingReceiver,
    waitMs,
    function () {
      // Проверка повторяется ПОСЛЕ пробуждения: пока poll висел, lease мог
      // перейти к другому Receiver, и отдавать ему задачу нельзя.
      var wakeProblem = receiverAuthProblem(receiverId);
      if (wakeProblem) return rejectReceiver(res, "/receiver/task", receiverId, wakeProblem);
      touchReceiver();
      if (!tryDeliver()) sendEmpty(res, 204);
    },
    function () {
      var timeoutProblem = receiverAuthProblem(receiverId);
      if (timeoutProblem) return rejectReceiver(res, "/receiver/task", receiverId, timeoutProblem);
      touchReceiver();
      sendEmpty(res, 204);
    }
  );
}

function validateAckShape(body) {
  if (!state.job) return "Активная job отсутствует.";
  if (body.jobId && body.jobId !== state.job.jobId) return "jobId не совпадает с активной job.";
  if (!body.taskId) return "Не передан taskId.";
  return null;
}

function handleReceiverAck(req, res, body) {
  var receiverId = body && body.receiverId ? String(body.receiverId) : null;
  var authProblem = receiverAuthProblem(receiverId);
  // Чужой ACK не имеет права закрыть задачу активного Receiver.
  if (authProblem) return rejectReceiver(res, "/receiver/ack", receiverId, authProblem);
  touchReceiver();
  var problem = validateAckShape(body);
  if (problem) return sendJson(res, 409, { ok: false, message: problem });

  var known = state.processed[body.taskId];
  if (known && known.status === "acked") {
    // Дубликат ACK — не ошибка, но и не повод менять состояние.
    return sendJson(res, 200, { ok: true, duplicate: true });
  }
  if (!state.current || state.current.task.taskId !== body.taskId) {
    return sendJson(res, 409, { ok: false, message: "taskId не соответствует текущему task." });
  }

  clearAckTimer();
  logBridge("info", "task.acked", {
    jobId: state.job.jobId,
    taskId: body.taskId,
    data: {
      type: state.current.task.type,
      heldMs: state.current.deliveredAt ? now() - state.current.deliveredAt : null,
      result: body.result,
    },
  });
  state.current.status = "acked";
  state.current.result = body.result || null;
  state.processed[body.taskId] = { status: "acked", result: state.current.result };
  state.job.tasksAcked += 1;
  wakeAll(state.waitingProducer);
  sendJson(res, 200, { ok: true });
}

function handleReceiverError(req, res, body) {
  var receiverId = body && body.receiverId ? String(body.receiverId) : null;
  var authProblem = receiverAuthProblem(receiverId);
  if (authProblem) return rejectReceiver(res, "/receiver/error", receiverId, authProblem);
  touchReceiver();
  var problem = validateAckShape(body);
  if (problem) return sendJson(res, 409, { ok: false, message: problem });
  if (!state.current || state.current.task.taskId !== body.taskId) {
    return sendJson(res, 409, { ok: false, message: "taskId не соответствует текущему task." });
  }

  clearAckTimer();
  failCurrentTask(String(body.code || "RECEIVER_ERROR"), String(body.message || "Ошибка импорта."));
  var failure = state.current ? state.current.error : null;
  if (body.fatal !== false) finishJob("failed", failure);
  sendJson(res, 200, { ok: true });
}

/**
 * Тип источника job. Существует ровно для диагностики и для того, чтобы новый
 * экспериментальный конвейер `.pix` → Figma был отличим в логе от штатной
 * миграции Pixso → Figma.
 *
 * Задача без объявленного источника — это прежний отправитель, и его режим
 * остаётся PIXSO_PLUGIN: семантика старого протокола не меняется.
 */
var SOURCE_MODE = { PIXSO_PLUGIN: "PIXSO_PLUGIN", DIRECT_PIX: "DIRECT_PIX" };

function normalizeSourceMode(source) {
  var declared = source && source.sourceMode ? String(source.sourceMode).toUpperCase() : "";
  return SOURCE_MODE[declared] || SOURCE_MODE.PIXSO_PLUGIN;
}

function handleCreateJob(req, res, body) {
  if (!receiverReady()) {
    return sendJson(res, 409, {
      ok: false,
      code: "RECEIVER_NOT_READY",
      message: "Figma Receiver не обнаружен.",
    });
  }
  if (Number(body.protocolVersion) !== PROTOCOL_VERSION) {
    return sendJson(res, 409, {
      ok: false,
      code: "PROTOCOL_MISMATCH",
      message: "Bridge использует protocolVersion " + PROTOCOL_VERSION + ".",
    });
  }
  // Ни одной мутации состояния до этой проверки: вторая job во время running
  // не имеет права сбросить ACK-таймер, очередь или processed первой. Это
  // защита не только от второго ввода в терминале, но и от другого продюсера
  // на том же bridge.
  if (jobRunning()) {
    logBridge("warn", "job.rejected", {
      jobId: state.job.jobId,
      data: { code: "JOB_BUSY", sourceMode: normalizeSourceMode(body.source) },
    });
    return sendJson(res, 409, {
      ok: false,
      code: "JOB_BUSY",
      message: "Migration уже выполняется.",
      jobId: state.job.jobId,
      documentName: state.job.receiverDocumentName || null,
    });
  }
  // Гонка «показали Receiver A → пользователь нажал Enter → активным стал B»
  // обязана закончиться отказом, а не молчаливой отправкой в B.
  var expected = body.expectedReceiverId ? String(body.expectedReceiverId) : null;
  if (expected && expected !== activeReceiverId()) {
    logBridge("warn", "job.rejected", {
      data: {
        code: "RECEIVER_CHANGED",
        expected: fingerprint(expected),
        active: fingerprint(activeReceiverId()),
      },
    });
    return sendJson(res, 409, {
      ok: false,
      code: "RECEIVER_CHANGED",
      message: "Receiver сменился после проверки: задача не отправлена.",
      documentName: activeDocumentName(),
    });
  }

  clearAckTimer();
  state.processed = Object.create(null);
  state.current = null;
  state.job = {
    jobId: makeId("job"),
    status: "running",
    createdAt: new Date().toISOString(),
    source: body.source || null,
    sourceMode: normalizeSourceMode(body.source),
    // Цель фиксируется здесь и атомарно: продюсер без поля тоже привязывается
    // к текущему активному Receiver, а не «к тому, кто окажется активен потом».
    receiverId: activeReceiverId(),
    receiverDocumentName: activeDocumentName(),
    // Сам секрет не хранится нигде: только его хэш и только в памяти bridge.
    producerTokenHash: body.producerToken ? hashProducerToken(String(body.producerToken)) : null,
    sequence: 0,
    tasksAcked: 0,
    error: null,
  };
  logBridge("info", "job.created", {
    jobId: state.job.jobId,
    data: state.job.source,
    message: "sourceMode " + state.job.sourceMode,
  });
  logBridge("info", "job.receiverPinned", {
    jobId: state.job.jobId,
    data: {
      receiver: fingerprint(state.job.receiverId),
      documentName: state.job.receiverDocumentName,
      declared: !!expected,
    },
  });
  wakeAll(state.waitingReceiver);
  sendJson(res, 201, {
    ok: true,
    jobId: state.job.jobId,
    receiverId: state.job.receiverId,
    documentName: state.job.receiverDocumentName,
    protocolVersion: PROTOCOL_VERSION,
  });
}

function handlePostTask(req, res, jobId, body) {
  if (!state.job || state.job.jobId !== jobId) {
    return sendJson(res, 404, { ok: false, code: "JOB_NOT_FOUND", message: "Job не найдена." });
  }
  if (state.job.status !== "running") {
    return sendJson(res, 409, { ok: false, code: "JOB_CLOSED", message: "Job уже завершена." });
  }
  if (!receiverReady()) {
    failCurrentTask("RECEIVER_GONE", "Receiver перестал отвечать.");
    return sendJson(res, 409, { ok: false, code: "RECEIVER_NOT_READY", message: "Receiver недоступен." });
  }
  if (!body.taskId || !body.type) {
    return sendJson(res, 400, { ok: false, message: "Нужны taskId и type." });
  }

  var known = state.processed[body.taskId];
  if (known) {
    // Ретрай транспорта после успешной доставки: не ставим task заново.
    return sendJson(res, 200, { ok: true, duplicate: true, status: known.status });
  }
  if (state.current && state.current.task.taskId === String(body.taskId)) {
    // Тот же taskId, который прямо сейчас в работе. Так выглядит транспортный
    // ретрай: ответ на первый POST не дошёл до продюсера, хотя task уже принят.
    // Ставить его заново нельзя — приёмник импортировал бы один корень дважды.
    return sendJson(res, 200, {
      ok: true,
      duplicate: true,
      status: state.current.status,
      taskId: state.current.task.taskId,
      sequence: state.current.task.sequence,
    });
  }
  // Очередь размером 1.
  if (state.current && state.current.status !== "acked" && state.current.status !== "error") {
    logBridge("warn", "task.rejected", {
      jobId: jobId,
      taskId: String(body.taskId),
      data: { code: "QUEUE_BUSY", currentStatus: state.current.status },
    });
    return sendJson(res, 409, {
      ok: false,
      code: "QUEUE_BUSY",
      message: "Предыдущий task ещё не подтверждён.",
    });
  }

  state.job.sequence += 1;
  logBridge("info", "task.queued", {
    jobId: state.job.jobId,
    taskId: String(body.taskId),
    data: { type: String(body.type), sequence: state.job.sequence },
  });
  state.current = {
    status: "pending",
    result: null,
    error: null,
    queuedAt: now(),
    ackTimer: null,
    task: {
      protocolVersion: PROTOCOL_VERSION,
      jobId: state.job.jobId,
      taskId: String(body.taskId),
      sequence: state.job.sequence,
      type: String(body.type),
      payload: body.payload === undefined ? null : body.payload,
    },
  };
  wakeAll(state.waitingReceiver);
  sendJson(res, 202, { ok: true, taskId: state.current.task.taskId, sequence: state.current.task.sequence });
}

function taskStatusPayload(taskId) {
  if (state.current && state.current.task.taskId === taskId) {
    return {
      taskId: taskId,
      status: state.current.status,
      result: state.current.result,
      error: state.current.error,
      job: jobSnapshot(),
    };
  }
  var known = state.processed[taskId];
  if (known) {
    return {
      taskId: taskId,
      status: known.status,
      result: known.result || null,
      error: known.error || null,
      job: jobSnapshot(),
    };
  }
  return { taskId: taskId, status: "unknown", result: null, error: null, job: jobSnapshot() };
}

function settled(payload) {
  return payload.status === "acked" || payload.status === "error" || payload.status === "unknown";
}

function handleTaskState(req, res, jobId, taskId, query) {
  if (!state.job || state.job.jobId !== jobId) {
    return sendJson(res, 404, { ok: false, code: "JOB_NOT_FOUND", message: "Job не найдена." });
  }

  var payload = taskStatusPayload(taskId);
  if (settled(payload)) return sendJson(res, 200, payload);

  var waitMs = clampWait(query.wait);
  if (!waitMs) return sendJson(res, 200, payload);

  registerWaiter(
    state.waitingProducer,
    waitMs,
    function () {
      sendJson(res, 200, taskStatusPayload(taskId));
    },
    function () {
      sendJson(res, 200, taskStatusPayload(taskId));
    }
  );
}

function handleFinishJob(req, res, jobId, body) {
  if (!state.job || state.job.jobId !== jobId) {
    return sendJson(res, 404, { ok: false, code: "JOB_NOT_FOUND", message: "Job не найдена." });
  }
  if (state.job.status !== "running") {
    // Идемпотентность: job уже закрыта, её исход остаётся прежним.
    return sendJson(res, 200, { ok: true, alreadyClosed: true, job: jobSnapshot() });
  }
  var status = body.status === "failed" || body.status === "aborted" ? body.status : "done";
  finishJob(status, body.error || null);
  sendJson(res, 200, { ok: true, job: jobSnapshot() });
}

/**
 * POST /jobs/:jobId/abort — продюсер снимает СВОЮ job.
 *
 * Существует ровно для одного сценария: окно launcher закрыли во время
 * migration, а bridge был запущен отдельно и обязан пережить launcher. Без
 * этого job навсегда оставалась бы `running`, держала ACK-таймер и блокировала
 * и следующий Receiver (`RECEIVER_SWITCH_BLOCKED`), и следующую job
 * (`JOB_BUSY`).
 *
 * Отмена требует одновременно правильного `jobId` и producer token: чужую или
 * параллельную job так закрыть нельзя. Повторный вызов ничего не меняет.
 */
function handleAbortJob(req, res, jobId, body) {
  var token = body && body.producerToken ? String(body.producerToken) : null;
  if (!state.job || state.job.jobId !== jobId) {
    // Отменять нечего: либо job уже забыта, либо это чужой jobId.
    return sendJson(res, 404, { ok: false, code: "JOB_NOT_FOUND", message: "Job не найдена." });
  }
  if (!state.job.producerTokenHash || !producerTokenMatches(state.job.producerTokenHash, token)) {
    logBridge("warn", "job.abortRejected", {
      jobId: jobId,
      data: { code: "ABORT_FORBIDDEN", tokenDeclared: !!token, jobHasToken: !!state.job.producerTokenHash },
    });
    return sendJson(res, 403, {
      ok: false,
      code: "ABORT_FORBIDDEN",
      message: "Отменить job может только создавший её продюсер.",
    });
  }
  if (state.job.status !== "running") {
    // Идемпотентность: job уже закрыта — это успех, а не ошибка.
    return sendJson(res, 200, { ok: true, aborted: false, alreadyClosed: true, job: jobSnapshot() });
  }

  logBridge("warn", "job.aborted", {
    jobId: jobId,
    data: { reason: body && body.reason ? String(body.reason).slice(0, 200) : null },
  });
  // Сначала освобождается текущий task (ACK-таймер и ждущий продюсер), затем
  // закрывается сама job: ждущие long-poll приёмника просыпаются пустым 204.
  failCurrentTask("JOB_ABORTED", "Продюсер прекратил migration.");
  finishJob("aborted", { code: "JOB_ABORTED", message: "Продюсер прекратил migration." });
  sendJson(res, 200, { ok: true, aborted: true, job: jobSnapshot() });
}

function handlePostLog(req, res, body) {
  var entries = Array.isArray(body.entries) ? body.entries : [body];
  var written = 0;
  for (var i = 0; i < entries.length && i < 500; i++) {
    if (!entries[i]) continue;
    writeLog(entries[i]);
    written += 1;
  }
  sendJson(res, 200, { ok: true, written: written, file: logFilePath });
}

function handleLogTail(req, res, query) {
  var limit = Math.min(Math.max(Number(query.lines) || 200, 1), LOG_RING_LIMIT);
  var slice = logRing.slice(-limit);
  if (query.format === "json") {
    return sendJson(res, 200, { ok: true, file: logFilePath, entries: slice });
  }
  // Человекочитаемый по умолчанию: лог обычно смотрят через curl.
  var text = slice.map(function (r) {
    var head = r.ts + "  " + r.source.padEnd(6) + " " + r.level.padEnd(5) + " " + r.event;
    var tail = [];
    if (r.taskId) tail.push(r.taskId);
    if (r.message) tail.push(r.message);
    if (r.data !== undefined) tail.push(JSON.stringify(r.data));
    return tail.length ? head + "  " + tail.join("  ") : head;
  }).join("\n");
  cors(res);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(text + "\n");
}

function handleJobState(req, res, jobId) {
  if (!state.job || state.job.jobId !== jobId) {
    return sendJson(res, 404, { ok: false, code: "JOB_NOT_FOUND", message: "Job не найдена." });
  }
  sendJson(res, 200, { ok: true, job: jobSnapshot(), receiver: { ready: receiverReady() } });
}

// ---------------------------------------------------------------------------
// Роутер
// ---------------------------------------------------------------------------

function route(req, res) {
  var parsed = new URL(req.url, "http://localhost");
  var path = parsed.pathname.replace(/\/+$/, "") || "/";
  var query = {
    role: parsed.searchParams.get("role"),
    receiverId: parsed.searchParams.get("receiverId"),
    wait: parsed.searchParams.get("wait"),
    taskId: parsed.searchParams.get("taskId"),
    lines: parsed.searchParams.get("lines"),
    format: parsed.searchParams.get("format"),
  };

  if (req.method === "OPTIONS") return sendEmpty(res, 204);

  if (req.method === "GET") {
    if (path === "/health") {
      return sendJson(res, 200, {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      });
    }
    if (path === "/receiver/status") return handleReceiverStatus(req, res, query);
    if (path === "/receiver/task") return handleReceiverTask(req, res, query);

    var taskMatch = /^\/jobs\/([^/]+)\/task\/([^/]+)$/.exec(path);
    if (taskMatch) return handleTaskState(req, res, taskMatch[1], taskMatch[2], query);

    var stateMatch = /^\/jobs\/([^/]+)\/state$/.exec(path);
    if (stateMatch) return handleJobState(req, res, stateMatch[1]);

    if (path === "/log/tail") return handleLogTail(req, res, query);

    return sendJson(res, 404, { ok: false, message: "Неизвестный маршрут " + path });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, message: "Метод не поддерживается" });
  }

  readBody(req, function (error, body) {
    if (error) return sendJson(res, 400, { ok: false, message: error.message });

    try {
      if (path === "/receiver/hello") return handleReceiverHello(req, res, body);
      if (path === "/receiver/bye") return handleReceiverBye(req, res, body);
      if (path === "/receiver/ack") return handleReceiverAck(req, res, body);
      if (path === "/receiver/error") return handleReceiverError(req, res, body);
      if (path === "/jobs") return handleCreateJob(req, res, body);
      if (path === "/log") return handlePostLog(req, res, body);

      var postTask = /^\/jobs\/([^/]+)\/task$/.exec(path);
      if (postTask) return handlePostTask(req, res, postTask[1], body);

      var finish = /^\/jobs\/([^/]+)\/finish$/.exec(path);
      if (finish) return handleFinishJob(req, res, finish[1], body);

      var abort = /^\/jobs\/([^/]+)\/abort$/.exec(path);
      if (abort) return handleAbortJob(req, res, abort[1], body);

      return sendJson(res, 404, { ok: false, message: "Неизвестный маршрут " + path });
    } catch (handlerError) {
      return sendJson(res, 500, {
        ok: false,
        message: handlerError && handlerError.message ? handlerError.message : String(handlerError),
      });
    }
  });
}

function createServer() {
  var server = http.createServer(function (req, res) {
    try {
      route(req, res);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: String(error && error.message) });
    }
  });
  // Long-poll держит соединение дольше дефолта.
  server.headersTimeout = MAX_WAIT_MS + 30000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = MAX_WAIT_MS + 15000;
  return server;
}

function resetForTests() {
  clearAckTimer();
  wakeAll(state.waitingProducer);
  wakeAll(state.waitingReceiver);
  state.receiver = null;
  state.job = null;
  state.current = null;
  state.processed = Object.create(null);
}

function parseArgs(argv) {
  var options = { port: Number(process.env.PIXSO_BRIDGE_PORT) || DEFAULT_PORT, host: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) options.port = Number(argv[i + 1]);
    if (argv[i] === "--host" && argv[i + 1]) options.host = String(argv[i + 1]);
  }
  return options;
}

if (require.main === module) {
  var options = parseArgs(process.argv.slice(2));
  // Манифесты плагинов разрешают только http://localhost:<port>, а localhost
  // на macOS резолвится и в ::1, и в 127.0.0.1 — какой из них выберет редактор,
  // заранее неизвестно. Поэтому по умолчанию слушаем оба loopback-адреса.
  // Явный --host отключает это и слушает ровно один.
  var hosts = options.host ? [options.host] : [DEFAULT_HOST, "::1"];
  var listening = 0;
  var pendingHosts = hosts.length;

  hosts.forEach(function (host) {
    var server = createServer();
    server.listen(options.port, host, function () {
      listening += 1;
      pendingHosts -= 1;
      process.stdout.write(
        "Pixso2Figma bridge " +
          BRIDGE_VERSION +
          " (protocol " +
          PROTOCOL_VERSION +
          ") слушает http://" +
          (host.indexOf(":") >= 0 ? "[" + host + "]" : host) +
          ":" +
          options.port +
          "\n"
      );
      if (!pendingHosts) {
        process.stdout.write("Адрес для плагинов: http://localhost:" + options.port + "\n");
        logBridge("info", "bridge.started", {
          data: { port: options.port, hosts: hosts, bridgeVersion: BRIDGE_VERSION },
        });
        ensureLogStream();
        process.stdout.write("Лог диагностики: " + (logFilePath || "недоступен") + "\n");
      }
    });
    server.on("error", function (error) {
      pendingHosts -= 1;
      if (error && error.code === "EADDRINUSE") {
        process.stderr.write("Порт " + options.port + " занят на " + host + ".\n");
        process.exit(1);
      }
      // IPv6 может быть выключен: одного loopback-адреса достаточно.
      if (!listening && !pendingHosts) {
        process.stderr.write("Не удалось занять порт " + options.port + ": " + error.message + "\n");
        process.exit(1);
      }
    });
  });
}

module.exports = {
  BRIDGE_VERSION: BRIDGE_VERSION,
  SOURCE_MODE: SOURCE_MODE,
  normalizeSourceMode: normalizeSourceMode,
  LOG_DIR: LOG_DIR,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  RECEIVER_TTL_MS: RECEIVER_TTL_MS,
  DEFAULT_PORT: DEFAULT_PORT,
  createServer: createServer,
  resetForTests: resetForTests,
  state: state,
};
