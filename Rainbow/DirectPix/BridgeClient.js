/**
 * Транспорт Direct PIX через существующий bridge.
 *
 * Bridge остаётся тем же непрозрачным транспортом с очередью размера 1: его
 * протокол (`/jobs`, `/jobs/:id/task`, ACK, `/finish`) не меняется. Direct PIX
 * лишь объявляет себя новым `sourceMode` и присылает задачи своих типов —
 * старые задачи и их семантика не затронуты.
 *
 * Память ограничена намеренно: определения и ассеты режутся на chunk по
 * бюджету байт, корни едут по одному. Одним телом весь документ не уезжает.
 */
"use strict";

var http = require("http");

var DIRECT_TASK = {
  START: "DIRECT_PIX_START",
  ASSETS: "DIRECT_PIX_ASSETS",
  STYLES: "DIRECT_PIX_STYLES",
  DEFINITIONS: "DIRECT_PIX_DEFINITIONS",
  PAGE: "DIRECT_PIX_PAGE",
  ROOT: "DIRECT_PIX_ROOT",
  FINISH: "DIRECT_PIX_FINISH",
  PROBE: "DIRECT_PIX_PROBE",
};

var SOURCE_MODE = "DIRECT_PIX";
/**
 * Версия транспорта bridge (не Direct PIX payload и не IR): с протокола 2
 * каждый запрос приёмника несёт `receiverId`, а продюсер объявляет
 * `expectedReceiverId`.
 */
var BRIDGE_PROTOCOL_VERSION = 2;

/** Бюджет одного chunk. Ниже лимита bridge с большим запасом. */
var CHUNK_BYTES = 4 * 1024 * 1024;

function request(base, method, route, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var url = new URL(base + route);
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    var req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
      },
      function (res) {
        var chunks = [];
        res.on("data", function (chunk) { chunks.push(chunk); });
        res.on("end", function () {
          var text = Buffer.concat(chunks).toString("utf8");
          var parsed = null;
          if (text) { try { parsed = JSON.parse(text); } catch (_e) { parsed = null; } }
          resolve({ status: res.statusCode, body: parsed, text: text });
        });
      }
    );
    // Long-poll ACK держится до 25 секунд на стороне bridge. Короткие
    // read-only проверки launcher передают собственный таймаут.
    req.setTimeout(timeoutMs || 60000, function () { req.destroy(new Error("Таймаут запроса к bridge")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function createClient(options) {
  var base = String(options.bridge || "http://localhost:8787").replace(/\/+$/, "");
  var log = options.log || function () {};
  var jobId = null;
  var sequence = 0;
  var transport = { postMs: 0, ackMs: 0, tasks: 0, bytes: 0 };
  /** Ожидаемая цель: либо передана снаружи (launcher), либо закреплена в `ensureReceiver`. */
  var receiverId = options.expectedReceiverId ? String(options.expectedReceiverId) : null;
  /**
   * Секрет владения job. Объявляется при её создании и требуется, чтобы
   * закрыть её через `/abort`. Bridge хранит только хэш, поэтому доказать
   * владение может ровно тот процесс, который job и создал.
   */
  var producerToken = options.producerToken ? String(options.producerToken) : null;

  /** Read-only проверка живого bridge: launcher не дублирует HTTP-код. */
  async function health(timeoutMs) {
    var response = await request(base, "GET", "/health", undefined, timeoutMs || 4000);
    return { status: response.status, body: response.body };
  }

  /** Read-only снимок приёмника и активной job. */
  async function status(timeoutMs) {
    var response = await request(base, "GET", "/receiver/status", undefined, timeoutMs || 8000);
    return { status: response.status, body: response.body };
  }

  /**
   * Диагностическое событие в общий лог bridge. Лог не критичен: его отказ не
   * имеет права остановить migration.
   */
  async function postLog(entry) {
    try {
      await request(base, "POST", "/log", { entries: [entry] }, 4000);
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Проверяет приёмник и закрепляет его id в client. Явный `expected`
   * (например, тот, что launcher уже показал пользователю) обязан совпасть с
   * активным — иначе migration не начинается вовсе.
   */
  async function ensureReceiver(expected) {
    var wanted = expected === undefined || expected === null ? receiverId : String(expected);
    var response = await request(base, "GET", "/receiver/status", undefined);
    if (response.status !== 200 || !response.body) throw new Error("Bridge не отвечает по " + base);
    if (Number(response.body.protocolVersion) !== BRIDGE_PROTOCOL_VERSION) {
      throw new Error(
        "Bridge использует transport protocolVersion " + response.body.protocolVersion +
        ", Direct PIX — " + BRIDGE_PROTOCOL_VERSION + "."
      );
    }
    if (!response.body.ready) {
      throw new Error("Figma Receiver не подключён. Откройте плагин импорта и нажмите Start receiver.");
    }
    if (wanted && response.body.receiverId !== wanted) {
      throw new Error(
        "Receiver сменился до старта migration: активен «" +
        (response.body.documentName || "другой документ") + "». Задача не отправлена."
      );
    }
    receiverId = response.body.receiverId || null;
    return response.body;
  }

  async function start(source) {
    var created = await request(base, "POST", "/jobs", {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      // Цель объявляется явно: если активным стал другой Receiver, bridge
      // отказывает, а не отправляет документ не туда.
      expectedReceiverId: receiverId,
      // Доказательство владения: только с ним job можно будет отменить.
      producerToken: producerToken,
      // Новый тип источника. Bridge его не разбирает — он попадает в лог и
      // в снимок job, чтобы Direct-задачу было видно и снаружи.
      source: Object.assign({ sourceMode: SOURCE_MODE }, source),
    });
    if (created.status !== 201 || !created.body || !created.body.jobId) {
      var code = created.body && created.body.code;
      if (code === "RECEIVER_CHANGED") {
        // Ретрай здесь запрещён: повтор молча отправил бы документ в чужой файл.
        throw new Error(
          "Receiver сменился: активен «" + ((created.body && created.body.documentName) || "другой документ") +
          "». Migration не начата, повтор автоматически не выполняется."
        );
      }
      if (code === "JOB_BUSY") {
        throw new Error("Bridge уже выполняет другую migration. Дождитесь её завершения.");
      }
      throw new Error((created.body && created.body.message) || ("Bridge не создал job: " + created.status));
    }
    jobId = created.body.jobId;
    return jobId;
  }

  /** Отправляет задачу и дожидается ACK: очередь bridge всё равно равна 1. */
  async function sendTask(type, payload) {
    sequence += 1;
    var taskId = jobId + "-direct-" + sequence;
    var body = {
      taskId: taskId,
      type: type,
      payload: Object.assign({ sourceMode: SOURCE_MODE }, payload),
    };
    var bytes = Buffer.byteLength(JSON.stringify(body));
    transport.bytes += bytes;

    var postStartedAt = Date.now();
    var attempts = 0;
    for (;;) {
      var posted = await request(base, "POST", "/jobs/" + jobId + "/task", body);
      if (posted.status === 202 || posted.status === 200) break;
      attempts += 1;
      if (attempts >= 4) {
        throw new Error((posted.body && posted.body.message) || ("Bridge отверг задачу: " + posted.status));
      }
      await sleep(400 * attempts);
    }
    transport.postMs += Date.now() - postStartedAt;

    var ackStartedAt = Date.now();
    for (;;) {
      var state = await request(base, "GET", "/jobs/" + jobId + "/task/" + taskId + "?wait=25", undefined);
      var status = state.body && state.body.status;
      if (status === "acked") {
        transport.ackMs += Date.now() - ackStartedAt;
        transport.tasks += 1;
        return (state.body && state.body.result) || {};
      }
      if (status === "error") {
        throw new Error((state.body.error && state.body.error.message) || "Receiver вернул ошибку.");
      }
      if (status === "unknown") throw new Error("Bridge потерял задачу " + taskId + ".");
    }
  }

  /**
   * Снимает job, созданную ЭТИМ client, — по её id и producer token.
   *
   * Нужно там, где обычный `/finish` уже не успеет: процесс получил сигнал и
   * должен умереть, а bridge (запущенный отдельно) обязан остаться живым и
   * свободным. Идемпотентно: закрытая или чужая job молча остаётся как есть.
   */
  async function abortJob(targetJobId, token, reason) {
    var id = targetJobId ? String(targetJobId) : jobId;
    var secret = token ? String(token) : producerToken;
    if (!id || !secret) return { status: 0, body: null, code: "NO_JOB" };
    var response = await request(
      base,
      "POST",
      "/jobs/" + encodeURIComponent(id) + "/abort",
      { producerToken: secret, reason: reason || null },
      5000
    );
    return { status: response.status, body: response.body };
  }

  async function finish(status, error) {
    if (!jobId) return;
    await request(base, "POST", "/jobs/" + jobId + "/finish", {
      status: status,
      error: error ? { message: String(error.message || error) } : null,
    });
  }

  /** Режет список на chunk по бюджету байт, но не меньше одного элемента. */
  function chunked(items, sizeOf) {
    var chunks = [];
    var current = [];
    var size = 0;
    for (var i = 0; i < items.length; i++) {
      var itemSize = sizeOf(items[i]);
      if (current.length && size + itemSize > CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(items[i]);
      size += itemSize;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  /**
   * D36: тот же мягкий byte-budget, но граница chunk никогда не режет
   * атомарную source-family. Порядок items не меняется, поэтому dependency
   * ordering определений сохраняется. Если семейство само больше бюджета,
   * chunk намеренно получается больше 4 MiB: целостная variant schema важнее
   * мягкой цели размера, а HTTP/bridge жёсткого лимита здесь не имеют.
   */
  function chunkedKeepingGroups(items, sizeOf, groupOf) {
    var lastByGroup = Object.create(null);
    for (var g = 0; g < items.length; g++) {
      var gid = groupOf(items[g]);
      if (gid) lastByGroup[String(gid)] = g;
    }
    var chunks = [];
    var current = [];
    var size = 0;
    var protectedUntil = -1;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var itemSize = sizeOf(item);
      // Cut only after every group already present in the current chunk has
      // reached its final member. The next item may start a new group.
      if (current.length && size + itemSize > CHUNK_BYTES && (i - 1) >= protectedUntil) {
        chunks.push(current);
        current = [];
        size = 0;
        protectedUntil = -1;
      }
      current.push(item);
      size += itemSize;
      var group = groupOf(item);
      if (group) {
        var last = lastByGroup[String(group)];
        if (last > protectedUntil) protectedUntil = last;
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  return {
    DIRECT_TASK: DIRECT_TASK,
    SOURCE_MODE: SOURCE_MODE,
    base: base,
    health: health,
    status: status,
    postLog: postLog,
    ensureReceiver: ensureReceiver,
    receiverId: function () { return receiverId; },
    start: start,
    sendTask: sendTask,
    finish: finish,
    abortJob: abortJob,
    producerToken: function () { return producerToken; },
    chunked: chunked,
    chunkedKeepingGroups: chunkedKeepingGroups,
    transport: transport,
    jobId: function () { return jobId; },
    log: log,
  };
}

module.exports = {
  createClient: createClient,
  BRIDGE_PROTOCOL_VERSION: BRIDGE_PROTOCOL_VERSION,
  DIRECT_TASK: DIRECT_TASK,
  SOURCE_MODE: SOURCE_MODE,
  CHUNK_BYTES: CHUNK_BYTES,
};
