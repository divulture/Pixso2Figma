/**
 * Receiver UI и lease: node FigmaImporter/Tests/ReceiverLeaseUiTest.js
 *
 * Скрипт окна приёмника исполняется как есть — в `vm` с минимальными
 * заглушками DOM и `fetch`. Проверяется поведение, а не текст файла:
 *
 *   — `receiverId` из `hello` сохраняется и уезжает в КАЖДОМ receiver-owned
 *     запросе (task, ACK, error, bye);
 *   — `RECEIVER_SUPERSEDED` останавливает poll, возвращает кнопку Start и
 *     показывает имя нового активного документа;
 *   — `RECEIVER_SWITCH_BLOCKED` не переводит UI в рабочее состояние;
 *   — `/bye` без собственного id не отправляется вовсе;
 *   — транспортный сбой не путается с потерей lease;
 *   — счётчик времени замирает на КАЖДОМ конце job, а не только на удачном
 *     `DIRECT_PIX_FINISH`, и итог не затирается словом «Ready»;
 *   — пока плагин строит задачу, приёмник шлёт heartbeat с её taskId;
 *   — потерянный lease не выдаётся за «активирован другой Receiver».
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

var html = fs.readFileSync(path.join(__dirname, "..", "Ui.html"), "utf8");
var scriptSource = (function () {
  var open = html.indexOf("<script>");
  var close = html.lastIndexOf("</script>");
  if (open < 0 || close < 0) throw new Error("В Ui.html не найден script приёмника");
  return html.slice(open + "<script>".length, close);
})();

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/**
 * Пустой ответ long-poll. Настоящий bridge держит такой запрос до 25 секунд,
 * поэтому заглушка тоже обязана отвечать не мгновенно: иначе цикл опроса
 * превратился бы в busy loop, которого в реальности нет.
 */
function idlePoll(ms) {
  return sleep(ms === undefined ? 40 : ms).then(function () { return { status: 204, body: null }; });
}

async function waitFor(condition, what) {
  for (var i = 0; i < 400; i++) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error("Не дождались: " + what);
}

/** Минимальный DOM: ровно те методы, которые вызывает скрипт окна. */
function createElement(id) {
  var classes = [];
  var element = {
    id: id,
    textContent: "",
    className: "",
    disabled: false,
    onclick: null,
    href: "",
    download: "",
    classList: {
      add: function (name) { if (classes.indexOf(name) < 0) classes.push(name); },
      remove: function (name) {
        var index = classes.indexOf(name);
        if (index >= 0) classes.splice(index, 1);
      },
      contains: function (name) { return classes.indexOf(name) >= 0; },
    },
    appendChild: function (child) { this.textContent += (child && child.textContent) || ""; },
    classes: classes,
  };
  // Настоящий `innerHTML = ""` стирает содержимое узла. Без этого заглушка
  // копила все статусы подряд, и проверить, что статус СМЕНИЛСЯ, а не
  // добавился к прежнему, было невозможно.
  Object.defineProperty(element, "innerHTML", {
    get: function () { return element.textContent; },
    set: function (value) { element.textContent = value ? String(value) : ""; },
  });
  return element;
}

function createHarness() {
  var elements = Object.create(null);
  var requests = [];
  var toPlugin = [];
  var routes = Object.create(null);

  function element(id) {
    if (!elements[id]) elements[id] = createElement(id);
    return elements[id];
  }

  function respond(method, route, responder) {
    routes[method + " " + route] = responder;
  }

  function fakeFetch(url, init) {
    var options = init || {};
    var route = String(url).replace("http://localhost:8787", "");
    var pathOnly = route.split("?")[0];
    var query = route.indexOf("?") >= 0 ? route.slice(route.indexOf("?") + 1) : "";
    var body = null;
    if (options.body) { try { body = JSON.parse(options.body); } catch (_e) { body = options.body; } }
    var record = {
      route: route,
      path: pathOnly,
      query: query,
      method: options.method || "GET",
      body: body,
    };
    requests.push(record);

    var responder = routes[record.method + " " + pathOnly];
    if (!responder) return Promise.resolve({ status: 200, text: function () { return Promise.resolve("{}"); } });
    return Promise.resolve(responder(record)).then(function (result) {
      if (result && result.networkError) return Promise.reject(new Error("network"));
      var status = result && result.status !== undefined ? result.status : 200;
      var payload = result && result.body !== undefined ? result.body : null;
      return {
        status: status,
        text: function () { return Promise.resolve(payload === null ? "" : JSON.stringify(payload)); },
      };
    });
  }

  var sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    fetch: fakeFetch,
    Promise: Promise,
    Date: Date,
    JSON: JSON,
    Error: Error,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    Math: Math,
    encodeURIComponent: encodeURIComponent,
    AbortController: typeof AbortController === "function" ? AbortController : function () {
      this.signal = {};
      this.abort = function () {};
    },
    parent: { postMessage: function (message) { toPlugin.push(message.pluginMessage); } },
    document: {
      getElementById: element,
      createElement: function (tag) { return createElement(tag); },
      body: { appendChild: function () {}, removeChild: function () {} },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = function () {};
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  // Боевой heartbeat — раз в 10 секунд; тест столько не ждёт.
  vm.runInContext(
    scriptSource.replace("var TASK_HEARTBEAT_MS = 10000;", "var TASK_HEARTBEAT_MS = 30;"),
    sandbox,
    { filename: "FigmaImporter/Ui.html" }
  );

  return {
    sandbox: sandbox,
    elements: elements,
    requests: requests,
    toPlugin: toPlugin,
    respond: respond,
    element: element,
    statusText: function () { return element("receiver-status").textContent; },
    find: function (method, pathOnly) {
      return requests.filter(function (r) { return r.method === method && r.path === pathOnly; });
    },
    /** Ответ плагина на выданную задачу. */
    answerTask: function (message) {
      sandbox.window.onmessage({ data: { pluginMessage: message } });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Полный цикл: hello → task → ACK → supersede
// ---------------------------------------------------------------------------

async function testLeaseCarriedEverywhere() {
  var h = createHarness();
  var leaseId = "receiver-deadbeefcafe";
  var taskGiven = false;

  h.respond("POST", "/receiver/hello", function (request) {
    ok(!request.body.receiverId, "Start receiver запрашивает новый lease без собственного id");
    return {
      status: 200,
      body: {
        ready: true,
        receiverId: leaseId,
        documentName: "Dashboard — Figma",
        receiverVersion: "0.1.0",
        protocolVersion: 2,
      },
    };
  });
  h.respond("GET", "/receiver/task", function (request) {
    if (!taskGiven) {
      taskGiven = true;
      return {
        status: 200,
        body: {
          task: {
            jobId: "job-1",
            taskId: "task-1",
            type: "DIRECT_PIX_ROOT",
            sequence: 1,
            payload: { rootName: "Экран", index: 1, total: 1 },
          },
        },
      };
    }
    // Второй опрос: активирован другой документ.
    // Настоящий bridge всегда сообщает, есть ли вообще активный приёмник.
    return {
      status: 409,
      body: {
        ok: false, code: "RECEIVER_SUPERSEDED",
        documentName: "Другой — Figma", receiverActive: true,
      },
    };
  });
  h.respond("POST", "/receiver/ack", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  eq(h.sandbox.window.receiver === undefined, true, "внутреннее состояние приёмника не утекает в window");

  await waitFor(function () { return h.toPlugin.some(function (m) { return m && m.type === "receiver-task"; }); },
    "задача ушла в main thread");

  var polls = h.find("GET", "/receiver/task");
  ok(polls.length >= 1, "приёмник опросил bridge");
  ok(polls[0].query.indexOf("receiverId=" + leaseId) >= 0, "poll несёт выданный receiverId");

  h.answerTask({ type: "receiver-task-done", taskId: "task-1", result: { ordinaryNodesCreated: 3 } });

  await waitFor(function () { return h.find("POST", "/receiver/ack").length === 1; }, "ACK отправлен");
  eq(h.find("POST", "/receiver/ack")[0].body.receiverId, leaseId, "ACK несёт receiverId");

  await waitFor(function () { return h.element("receiver-start").classList.contains("hidden") === false; },
    "кнопка Start вернулась после supersede");
  ok(h.statusText().indexOf("Отключён — активирован другой документ: Другой — Figma") >= 0,
    "показан понятный статус superseded с именем нового документа");
  ok(h.element("receiver-stop").classList.contains("hidden"), "кнопка Stop скрыта");

  var pollsAfter = h.find("GET", "/receiver/task").length;
  await sleep(60);
  eq(h.find("GET", "/receiver/task").length, pollsAfter, "после RECEIVER_SUPERSEDED опрос прекращён");

  // Старая сессия больше не имеет lease, поэтому /bye не отправляется вовсе.
  h.element("receiver-stop").onclick();
  await sleep(20);
  eq(h.find("POST", "/receiver/bye").length, 0, "/bye старой сессии не отправляется без её id");
}

// ---------------------------------------------------------------------------
// 2. Ошибка импорта тоже подписана lease
// ---------------------------------------------------------------------------

async function testErrorCarriesLease() {
  var h = createHarness();
  var leaseId = "receiver-0011223344";
  var served = false;

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Цель — Figma", protocolVersion: 2 } };
  });
  h.respond("GET", "/receiver/task", function () {
    if (served) return idlePoll();
    served = true;
    return {
      status: 200,
      body: { task: { jobId: "job-2", taskId: "task-2", type: "DIRECT_PIX_ROOT", sequence: 1, payload: {} } },
    };
  });
  h.respond("POST", "/receiver/error", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/receiver/bye", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return h.toPlugin.some(function (m) { return m && m.type === "receiver-task"; }); },
    "задача ушла в main thread");
  h.answerTask({ type: "receiver-task-failed", taskId: "task-2", code: "IMPORT_FAILED", message: "не собралось" });

  await waitFor(function () { return h.find("POST", "/receiver/error").length === 1; }, "ошибка отправлена");
  eq(h.find("POST", "/receiver/error")[0].body.receiverId, leaseId, "сообщение об ошибке несёт receiverId");

  h.element("receiver-stop").onclick();
  await sleep(20);
  var bye = h.find("POST", "/receiver/bye");
  eq(bye.length, 1, "Stop отправляет /bye собственной сессии");
  eq(bye[0].body.receiverId, leaseId, "/bye несёт собственный receiverId");
}

// ---------------------------------------------------------------------------
// 3. Смена во время migration заблокирована
// ---------------------------------------------------------------------------

async function testSwitchBlocked() {
  var h = createHarness();
  h.respond("POST", "/receiver/hello", function () {
    return {
      status: 409,
      body: {
        ok: false,
        code: "RECEIVER_SWITCH_BLOCKED",
        jobId: "job-9",
        documentName: "Занятый — Figma",
        protocolVersion: 2,
      },
    };
  });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await sleep(30);

  ok(h.statusText().indexOf("Занятый — Figma") >= 0, "показан документ активной migration");
  eq(h.element("receiver-start").disabled, false, "кнопка Start снова доступна");
  ok(h.element("receiver-start").classList.contains("hidden") === false, "UI не вошёл в рабочее состояние");
  eq(h.find("GET", "/receiver/task").length, 0, "polling при блокировке не начинается");
}

// ---------------------------------------------------------------------------
// 4. Несовпадение версии транспорта
// ---------------------------------------------------------------------------

async function testProtocolMismatch() {
  var h = createHarness();
  h.respond("POST", "/receiver/hello", function () {
    return { status: 409, body: { ok: false, code: "PROTOCOL_MISMATCH", protocolVersion: 3 } };
  });
  await h.element("receiver-start").onclick();
  await sleep(20);
  ok(h.statusText().indexOf("протокол") >= 0, "несовпадение версии объяснено пользователю");
  eq(h.find("GET", "/receiver/task").length, 0, "polling не начинается на чужом протоколе");
}

// ---------------------------------------------------------------------------
// 5. Транспортный сбой — это не supersede
// ---------------------------------------------------------------------------

async function testTransportFailureIsNotSuperseded() {
  var h = createHarness();
  var leaseId = "receiver-99887766";
  var attempts = 0;

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Сеть — Figma", protocolVersion: 2 } };
  });
  h.respond("GET", "/receiver/task", function () {
    attempts += 1;
    if (attempts === 1) return { networkError: true };
    return idlePoll();
  });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return attempts >= 1; }, "первый опрос");
  await sleep(50);

  ok(h.element("receiver-start").classList.contains("hidden"), "после сбоя сети Start не возвращается");
  ok(h.statusText().indexOf("Bridge недоступен") >= 0, "сбой показан как проблема транспорта");

  h.element("receiver-stop").onclick();
  await sleep(20);
}

// ---------------------------------------------------------------------------
// 6. Конец job без задачи FINISH останавливает счётчик
// ---------------------------------------------------------------------------

/**
 * Регрессия. Интервал статистики гасился ТОЛЬКО удачным `DIRECT_PIX_FINISH`.
 * Job, снятая продюсером (закрыли окно launcher), упавшая или потерявшая
 * продюсера, задачи FINISH не присылает — и счётчик тикал вечно, а пустой
 * long-poll рисовал поверх него зелёное «Ready». Ровно это и видел
 * пользователь: «Ready» и растущее «Время».
 */
async function testStatsStopWhenJobEndsWithoutFinish() {
  var h = createHarness();
  var leaseId = "receiver-aabbccddeeff";
  var given = 0;

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Цель — Figma", protocolVersion: 2 } };
  });
  h.respond("GET", "/receiver/task", function () {
    given += 1;
    if (given === 1) {
      return { status: 200, body: { task: { jobId: "job-6", taskId: "t-start", type: "DIRECT_PIX_START", sequence: 1, payload: {} } } };
    }
    if (given === 2) {
      return { status: 200, body: { task: { jobId: "job-6", taskId: "t-root", type: "DIRECT_PIX_ROOT", sequence: 2, payload: { index: 1, total: 2 } } } };
    }
    // Дальше продюсера уже нет: задач не будет никогда.
    return idlePoll();
  });
  // Так выглядит снятая job: bridge её закрыл, приёмнику об этом не сообщал.
  h.respond("GET", "/receiver/status", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, job: { jobId: "job-6", status: "aborted" } } };
  });
  h.respond("POST", "/receiver/ack", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/receiver/bye", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return h.toPlugin.some(function (m) { return m && m.type === "receiver-task"; }); },
    "старт ушёл в main thread");
  h.answerTask({ type: "receiver-task-done", taskId: "t-start", result: {} });
  await waitFor(function () { return h.find("POST", "/receiver/ack").length === 1; }, "ACK старта");

  await waitFor(function () { return h.toPlugin.filter(function (m) { return m && m.type === "receiver-task"; }).length === 2; },
    "корень ушёл в main thread");
  h.answerTask({ type: "receiver-task-done", taskId: "t-root", result: { ordinaryNodesCreated: 5, instancesCreated: 2 } });
  await waitFor(function () { return h.find("POST", "/receiver/ack").length === 2; }, "ACK корня");

  // Пустой опрос обязан заметить, что job уже не running.
  await waitFor(function () { return h.find("GET", "/receiver/status").length >= 1; }, "проверка статуса job");
  await waitFor(function () { return h.statusText().indexOf("Migration прервана") >= 0; }, "показан финал снятой job");

  var frozen = h.element("receiver-stats").textContent;
  ok(frozen.indexOf("Слои 7") >= 0, "счётчик слоёв досчитал перенесённое (получено: " + frozen + ")");
  ok(h.statusText().indexOf("Ready") < 0, "зелёное «Ready» поверх оборванной migration не показывается");

  // Главное: интервал действительно снят, а не просто перерисован.
  await sleep(150);
  eq(h.element("receiver-stats").textContent, frozen, "время замерло: интервал статистики остановлен");
  eq(h.statusText().indexOf("Ready") < 0, true, "и «Ready» не вернулось следующим пустым опросом");

  // Статус спрашивается один раз на конец job, а не на каждый пустой опрос.
  eq(h.find("GET", "/receiver/status").length, 1, "конец job выясняется ровно одним запросом");

  h.element("receiver-stop").onclick();
  await sleep(20);
}

// ---------------------------------------------------------------------------
// 7. Итог удачной migration не затирается словом «Ready»
// ---------------------------------------------------------------------------

async function testFinalSummarySurvivesIdlePolls() {
  var h = createHarness();
  var leaseId = "receiver-99887766";
  var given = 0;

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Цель — Figma", protocolVersion: 2 } };
  });
  h.respond("GET", "/receiver/task", function () {
    given += 1;
    if (given === 1) {
      return { status: 200, body: { task: { jobId: "job-7", taskId: "s1", type: "DIRECT_PIX_START", sequence: 1, payload: {} } } };
    }
    if (given === 2) {
      return { status: 200, body: { task: { jobId: "job-7", taskId: "f1", type: "DIRECT_PIX_FINISH", sequence: 2, payload: {} } } };
    }
    return idlePoll();
  });
  h.respond("GET", "/receiver/status", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, job: { jobId: "job-7", status: "done" } } };
  });
  h.respond("POST", "/receiver/ack", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/receiver/bye", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return h.toPlugin.some(function (m) { return m && m.type === "receiver-task"; }); },
    "старт ушёл в main thread");
  h.answerTask({ type: "receiver-task-done", taskId: "s1", result: {} });
  await waitFor(function () { return h.find("POST", "/receiver/ack").length === 1; }, "ACK старта");

  await waitFor(function () { return h.toPlugin.filter(function (m) { return m && m.type === "receiver-task"; }).length === 2; },
    "финальная задача ушла в main thread");
  h.answerTask({
    type: "receiver-task-done",
    taskId: "f1",
    result: { totalImportMs: 4321, totals: { ordinaryNodesCreated: 10, instancesCreated: 4, definitionNodes: 1 } },
  });

  await waitFor(function () { return h.statusText().indexOf("Direct PIX завершён за ") >= 0; }, "показан итог migration");
  var summary = h.statusText();
  var stats = h.element("receiver-stats").textContent;

  // Несколько пустых опросов подряд — итог обязан пережить их все.
  await sleep(150);
  eq(h.statusText(), summary, "итог не затёрт словом «Ready»");
  eq(h.element("receiver-stats").textContent, stats, "и счётчик остался замороженным");
  eq(h.find("GET", "/receiver/status").length, 0,
    "закрытая задачей FINISH job лишних запросов статуса не вызывает");

  h.element("receiver-stop").onclick();
  await sleep(20);
}

// ---------------------------------------------------------------------------
// 8. Занятый приёмник напоминает bridge, что он жив
// ---------------------------------------------------------------------------

/**
 * Регрессия. Пока плагин строит тяжёлый корень, приёмник к bridge не
 * обращается — сказать ему нечего. Один корень строился 338 секунд, lease с
 * TTL 45 с протух, ACK прилетел в отказ, и пользователь увидел «активирован
 * другой Receiver», хотя не трогал ничего.
 */
async function testBusyReceiverSendsHeartbeat() {
  var h = createHarness();
  var leaseId = "receiver-heartbeat01";
  var given = 0;
  var beats = [];

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Цель — Figma", protocolVersion: 2 } };
  });
  h.respond("GET", "/receiver/task", function () {
    given += 1;
    if (given === 1) {
      return { status: 200, body: { task: { jobId: "job-8", taskId: "root-heavy", type: "DIRECT_PIX_ROOT", sequence: 1, payload: {} } } };
    }
    return idlePoll();
  });
  h.respond("GET", "/receiver/status", function (request) {
    beats.push(request.query);
    return { status: 200, body: { ready: true, receiverId: leaseId, job: { jobId: "job-8", status: "running" } } };
  });
  h.respond("POST", "/receiver/ack", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/receiver/bye", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return h.toPlugin.some(function (m) { return m && m.type === "receiver-task"; }); },
    "тяжёлая задача ушла в main thread");

  // Плагин строит корень долго. Интервал heartbeat в тесте ускорен до 30 мс.
  await waitFor(function () { return beats.length >= 2; }, "heartbeat занятого приёмника");
  ok(beats[0].indexOf("role=receiver") >= 0, "heartbeat помечен как receiver-owned");
  ok(beats[0].indexOf("receiverId=" + leaseId) >= 0, "heartbeat несёт собственный lease");
  ok(beats[0].indexOf("taskId=root-heavy") >= 0, "heartbeat называет задачу, которую держит");

  // Задача наконец построена — heartbeat обязан прекратиться.
  h.answerTask({ type: "receiver-task-done", taskId: "root-heavy", result: { ordinaryNodesCreated: 3 } });
  await waitFor(function () { return h.find("POST", "/receiver/ack").length === 1; }, "ACK тяжёлой задачи");
  var afterAck = beats.length;
  await sleep(120);
  eq(beats.length, afterAck, "после ACK heartbeat по задаче прекращён");

  h.element("receiver-stop").onclick();
  await sleep(20);
}

// ---------------------------------------------------------------------------
// 9. Потерянный lease не выдаётся за чужой Receiver
// ---------------------------------------------------------------------------

async function testLostLeaseIsNotCalledAnotherReceiver() {
  var h = createHarness();
  var leaseId = "receiver-lost0001";

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Цель — Figma", protocolVersion: 2 } };
  });
  // Так отвечает bridge, когда активного приёмника нет ВООБЩЕ.
  h.respond("GET", "/receiver/task", function () {
    return {
      status: 409,
      body: {
        ok: false, code: "RECEIVER_SUPERSEDED",
        message: "Этот Receiver больше не активен.",
        documentName: null, receiverActive: false,
      },
    };
  });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return h.element("receiver-start").classList.contains("hidden") === false; },
    "кнопка Start вернулась");

  ok(h.statusText().indexOf("другой Receiver") < 0,
    "не утверждаем, что кто-то включил другой Receiver (получено: " + h.statusText() + ")");
  ok(h.statusText().indexOf("другой документ") < 0, "и про другой документ тоже");
  ok(h.statusText().indexOf("Start receiver") >= 0, "вместо этого сказано, что делать");
}

// ---------------------------------------------------------------------------
// 10. Фатальный отказ задачи останавливает счётчик
// ---------------------------------------------------------------------------

/**
 * Сценарий из жизни: все 290 корней доехали, а упала последняя задача
 * `DIRECT_PIX_FINISH`. Счётчик обязан замереть на ней, а сообщение об ошибке —
 * пережить следующие пустые опросы, а не смениться зелёным «Ready».
 */
async function testFatalTaskFailureStopsStats() {
  var h = createHarness();
  var leaseId = "receiver-finishfail";
  var given = 0;

  h.respond("POST", "/receiver/hello", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, documentName: "Цель — Figma", protocolVersion: 2 } };
  });
  h.respond("GET", "/receiver/task", function () {
    given += 1;
    if (given === 1) {
      return { status: 200, body: { task: { jobId: "job-10", taskId: "s1", type: "DIRECT_PIX_START", sequence: 1, payload: {} } } };
    }
    if (given === 2) {
      return { status: 200, body: { task: { jobId: "job-10", taskId: "f1", type: "DIRECT_PIX_FINISH", sequence: 2, payload: {} } } };
    }
    return idlePoll();
  });
  h.respond("GET", "/receiver/status", function () {
    return { status: 200, body: { ready: true, receiverId: leaseId, job: { jobId: "job-10", status: "failed" } } };
  });
  h.respond("POST", "/receiver/ack", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/receiver/error", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/receiver/bye", function () { return { status: 200, body: { ok: true } }; });
  h.respond("POST", "/log", function () { return { status: 200, body: { ok: true } }; });

  await h.element("receiver-start").onclick();
  await waitFor(function () { return h.toPlugin.some(function (m) { return m && m.type === "receiver-task"; }); },
    "старт ушёл в main thread");
  h.answerTask({ type: "receiver-task-done", taskId: "s1", result: {} });
  await waitFor(function () { return h.find("POST", "/receiver/ack").length === 1; }, "ACK старта");

  await waitFor(function () { return h.toPlugin.filter(function (m) { return m && m.type === "receiver-task"; }).length === 2; },
    "финальная задача ушла в main thread");
  h.answerTask({
    type: "receiver-task-failed", taskId: "f1",
    code: "IMPORT_FAILED", message: "in postMessage: Cannot unwrap symbol",
  });
  await waitFor(function () { return h.find("POST", "/receiver/error").length === 1; }, "отказ отправлен");

  var frozen = h.element("receiver-stats").textContent;
  ok(frozen.indexOf("Время") >= 0, "счётчик показан (получено: " + frozen + ")");
  ok(h.statusText().indexOf("Cannot unwrap symbol") >= 0, "показана настоящая причина отказа");

  // Несколько пустых опросов подряд: ни счётчик, ни сообщение не меняются.
  await sleep(150);
  eq(h.element("receiver-stats").textContent, frozen, "время замерло на моменте отказа");
  ok(h.statusText().indexOf("Cannot unwrap symbol") >= 0, "сообщение об ошибке не затёрто");
  ok(h.statusText().indexOf("Ready") < 0, "и не сменилось зелёным «Ready»");

  h.element("receiver-stop").onclick();
  await sleep(20);
}

async function main() {
  await testLeaseCarriedEverywhere();
  await testErrorCarriesLease();
  await testSwitchBlocked();
  await testProtocolMismatch();
  await testTransportFailureIsNotSuperseded();
  await testStatsStopWhenJobEndsWithoutFinish();
  await testBusyReceiverSendsHeartbeat();
  await testLostLeaseIsNotCalledAnotherReceiver();
  await testFatalTaskFailureStopsStats();
  await testFinalSummarySurvivesIdlePolls();
  process.stdout.write("ReceiverLeaseUiTest: OK, проверок — " + checks + "\n");
  // Активные long-poll заглушки держать процесс не должны.
  process.exit(0);
}

main().catch(function (error) {
  process.stderr.write("ReceiverLeaseUiTest: FAIL\n" + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
