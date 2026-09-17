/**
 * Smoke-тест bridge: node Bridge/Tests/BridgeSmokeTest.js
 * Без зависимостей: поднимает сервер на случайном порту и гоняет протокол.
 */
"use strict";

var assert = require("assert");
var http = require("http");
var path = require("path");

var bridge = require(path.join(__dirname, "..", "Server.js"));

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

var server = bridge.createServer();
var base = null;
/** Lease текущего тестового приёмника: его несёт каждый receiver-owned вызов. */
var receiverId = null;

function receiverTask(query) {
  return call("GET", "/receiver/task?receiverId=" + encodeURIComponent(receiverId || "") +
    (query ? "&" + query : ""));
}

function receiverPost(route, body) {
  var payload = body || {};
  payload.receiverId = receiverId;
  return call("POST", route, payload);
}

function call(method, route, body) {
  return new Promise(function (resolve, reject) {
    var data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    var request = http.request(
      base + route,
      {
        method: method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {},
      },
      function (response) {
        var chunks = [];
        response.on("data", function (chunk) { chunks.push(chunk); });
        response.on("end", function () {
          var text = Buffer.concat(chunks).toString("utf8");
          var type = response.headers["content-type"] || "";
          var parsed = null;
          if (text) {
            if (type.indexOf("application/json") >= 0) parsed = JSON.parse(text);
            else parsed = text;
          }
          resolve({ status: response.statusCode, body: parsed });
        });
      }
    );
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;

  // 1. Health и отсутствие приёмника
  var health = await call("GET", "/health");
  eq(health.status, 200, "health отвечает");
  eq(health.body.protocolVersion, bridge.PROTOCOL_VERSION, "health отдаёт protocolVersion");

  var cold = await call("GET", "/receiver/status");
  eq(cold.body.ready, false, "без приёмника ready=false");

  // 2. Job нельзя создать без приёмника — Pixso должен показать подсказку
  var rejected = await call("POST", "/jobs", { protocolVersion: bridge.PROTOCOL_VERSION });
  eq(rejected.status, 409, "job без приёмника отклоняется");
  eq(rejected.body.code, "RECEIVER_NOT_READY", "код отказа RECEIVER_NOT_READY");

  // 3. Handshake
  var hello = await call("POST", "/receiver/hello", {
    receiverVersion: "0.1.0",
    protocolVersion: bridge.PROTOCOL_VERSION,
    documentName: "Target Figma",
  });
  eq(hello.body.ready, true, "после hello ready=true");
  eq(hello.body.documentName, "Target Figma", "documentName проброшен в handshake");
  receiverId = hello.body.receiverId;
  ok(receiverId, "handshake выдал lease приёмника");

  // 4. Несовместимый protocolVersion
  var mismatch = await call("POST", "/jobs", { protocolVersion: 999 });
  eq(mismatch.body.code, "PROTOCOL_MISMATCH", "чужой protocolVersion отклоняется");

  // 5. Создание job
  var job = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
    source: { fileName: "Design", pages: 2 },
  });
  eq(job.status, 201, "job создана");
  var jobId = job.body.jobId;
  ok(jobId, "jobId выдан");

  // 6. Long-poll приёмника просыпается на новом task
  var pending = receiverTask("wait=5");
  var posted = await call("POST", "/jobs/" + jobId + "/task", {
    taskId: "t1",
    type: "START_JOB",
    payload: { hello: 1 },
  });
  eq(posted.status, 202, "task принят");
  var delivered = await pending;
  eq(delivered.status, 200, "long-poll вернул task");
  eq(delivered.body.task.taskId, "t1", "доставлен именно t1");
  eq(delivered.body.task.sequence, 1, "sequence начинается с 1");

  // 7. Очередь размером 1: второй task до ACK отклоняется
  var busy = await call("POST", "/jobs/" + jobId + "/task", { taskId: "t2", type: "ROOT_NODE" });
  eq(busy.status, 409, "второй task до ACK отклоняется");
  eq(busy.body.code, "QUEUE_BUSY", "код QUEUE_BUSY");

  // 8. Продюсер ждёт ACK через long-poll
  var waitingAck = call("GET", "/jobs/" + jobId + "/task/t1?wait=5");
  await receiverPost("/receiver/ack", { jobId: jobId, taskId: "t1", result: { created: 12 } });
  var acked = await waitingAck;
  eq(acked.body.status, "acked", "продюсер увидел ACK");
  eq(acked.body.result.created, 12, "результат ACK доставлен продюсеру");

  // 9. Идемпотентность: повторная отправка того же taskId не создаёт task
  var duplicate = await call("POST", "/jobs/" + jobId + "/task", { taskId: "t1", type: "START_JOB" });
  eq(duplicate.body.duplicate, true, "повторный taskId распознан как дубликат");
  var duplicateAck = await receiverPost("/receiver/ack", { jobId: jobId, taskId: "t1" });
  eq(duplicateAck.body.duplicate, true, "повторный ACK распознан как дубликат");

  // 10. После ACK очередь снова свободна
  var second = await call("POST", "/jobs/" + jobId + "/task", { taskId: "t2", type: "ROOT_NODE" });
  eq(second.status, 202, "после ACK принимается следующий task");
  eq(second.body.sequence, 2, "sequence инкрементируется");

  // 11. Structured error от приёмника валит job
  await receiverTask("wait=1");
  await receiverPost("/receiver/error", {
    jobId: jobId,
    taskId: "t2",
    code: "IMPORT_FAILED",
    message: "Не удалось создать слой",
  });
  var failed = await call("GET", "/jobs/" + jobId + "/state");
  eq(failed.body.job.status, "failed", "job помечена failed");
  eq(failed.body.job.error.code, "IMPORT_FAILED", "structured error сохранён");

  // 12. В закрытую job писать нельзя
  var closed = await call("POST", "/jobs/" + jobId + "/task", { taskId: "t3", type: "ROOT_NODE" });
  eq(closed.body.code, "JOB_CLOSED", "закрытая job не принимает task");

  // 13. Новая job переиспользует bridge и очищает processedTasks
  var job2 = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
  });
  eq(job2.status, 201, "вторая job создаётся");
  var reuse = await call("POST", "/jobs/" + job2.body.jobId + "/task", { taskId: "t1", type: "START_JOB" });
  eq(reuse.status, 202, "taskId из прошлой job больше не считается дубликатом");

  // 14. Отключение приёмника валит активную job
  await receiverPost("/receiver/bye", {});
  var afterBye = await call("GET", "/receiver/status");
  eq(afterBye.body.ready, false, "после bye ready=false");
  eq(afterBye.body.job.status, "failed", "активная job помечена failed при уходе приёмника");

  // 15. Диагностический лог: плагины не пишут на диск, поэтому шлют события сюда
  var logged = await call("POST", "/log", {
    entries: [
      { source: "pixso", level: "info", event: "phase", message: "Изображения 2/3", data: { sincePrevMs: 8123 } },
      { source: "figma", level: "error", event: "task.importFailed", taskId: "t-9", message: "boom" },
    ],
  });
  eq(logged.status, 200, "лог принят");
  eq(logged.body.written, 2, "записаны обе строки");
  ok(logged.body.file, "лог указывает файл на диске");

  var tailJson = await call("GET", "/log/tail?lines=50&format=json");
  eq(tailJson.status, 200, "tail отвечает");
  var events = tailJson.body.entries.map(function (e) { return e.event; });
  ok(events.indexOf("phase") >= 0, "событие плагина попало в лог");
  ok(events.indexOf("task.importFailed") >= 0, "ошибка приёмника попала в лог");
  ok(events.indexOf("job.created") >= 0, "bridge пишет и собственные события");
  ok(events.indexOf("task.acked") >= 0, "ACK фиксируется в логе");

  var failure = tailJson.body.entries.filter(function (e) { return e.event === "task.importFailed"; })[0];
  eq(failure.source, "figma", "источник сохранён");
  eq(failure.taskId, "t-9", "taskId сохранён");
  eq(failure.level, "error", "уровень сохранён");
  ok(failure.ts, "у записи есть отметка времени");

  // Одиночная запись без обёртки entries тоже принимается
  var single = await call("POST", "/log", { source: "pixso", event: "plugin.silent", level: "error" });
  eq(single.body.written, 1, "одиночная запись принята");

  // Слишком длинное сообщение обрезается, а не раздувает лог
  var huge = "x".repeat(20000);
  await call("POST", "/log", { source: "pixso", event: "big", message: huge });
  var afterHuge = await call("GET", "/log/tail?lines=1&format=json");
  ok(afterHuge.body.entries[0].message.length < 9000, "длинное сообщение обрезано");

  var tailText = await call("GET", "/log/tail?lines=5");
  eq(tailText.status, 200, "текстовый tail отвечает");

  bridge.resetForTests();
  await new Promise(function (resolve) { server.close(resolve); });
  process.stdout.write("BridgeSmokeTest: OK, проверок — " + checks + "\n");
}

main().catch(function (error) {
  process.stderr.write("BridgeSmokeTest: FAIL\n" + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
