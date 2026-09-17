/**
 * Receiver lease: node Bridge/Tests/ReceiverLeaseTest.js
 *
 * Проверяет главное утверждение постоянного launcher: задача физически не
 * может попасть старому или сменившемуся Receiver.
 *
 *   — `hello` выдаёт непрозрачный случайный `receiverId`;
 *   — без него receiver-owned запрос не обслуживается;
 *   — в idle активным становится последний включённый Receiver, а прежний
 *     получает `RECEIVER_SUPERSEDED` и не может ни забрать task, ни отключить
 *     нового;
 *   — job закрепляется за конкретным Receiver, и во время неё цель сменить
 *     нельзя;
 *   — второй producer во время running job получает `JOB_BUSY` и не трогает
 *     состояние первой job;
 *   — снять job может только её создатель, предъявив producer token: чужой
 *     токен, отсутствующий токен и чужой jobId получают отказ;
 *   — приёмник, который строит выданную ему задачу, не «протухает» по TTL
 *     простоя: длинный корень не имеет права стоить ему lease.
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

function call(method, route, body) {
  return new Promise(function (resolve, reject) {
    var data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    var request = http.request(
      base + route,
      {
        method: method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      },
      function (response) {
        var chunks = [];
        response.on("data", function (chunk) { chunks.push(chunk); });
        response.on("end", function () {
          var text = Buffer.concat(chunks).toString("utf8");
          var parsed = null;
          if (text && (response.headers["content-type"] || "").indexOf("application/json") >= 0) {
            parsed = JSON.parse(text);
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

function hello(documentName, receiverId, protocolVersion) {
  var body = {
    receiverVersion: "0.1.0",
    protocolVersion: protocolVersion === undefined ? bridge.PROTOCOL_VERSION : protocolVersion,
    documentName: documentName,
  };
  if (receiverId) body.receiverId = receiverId;
  return call("POST", "/receiver/hello", body);
}

function task(receiverId, wait) {
  return call("GET", "/receiver/task?receiverId=" + encodeURIComponent(receiverId || "") +
    (wait ? "&wait=" + wait : ""));
}

async function main() {
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;

  // -------------------------------------------------------------------------
  // 1. hello A выдаёт случайный непрозрачный id
  // -------------------------------------------------------------------------
  var a = await hello("Документ A");
  eq(a.status, 200, "hello A принят");
  var idA = a.body.receiverId;
  ok(typeof idA === "string" && idA.length >= 32, "receiverId выдан и достаточно длинный");
  ok(/^receiver-[0-9a-f]{32,}$/.test(idA), "receiverId непрозрачный и случайный");
  ok(idA.indexOf("Документ A") < 0, "id не собран из имени документа");
  eq(a.body.protocolVersion, bridge.PROTOCOL_VERSION, "hello отдаёт transport protocolVersion");

  // -------------------------------------------------------------------------
  // 2. Receiver endpoint без id отклоняется
  // -------------------------------------------------------------------------
  var anonymous = await call("GET", "/receiver/task");
  eq(anonymous.status, 400, "task без receiverId отклонён");
  eq(anonymous.body.code, "RECEIVER_ID_REQUIRED", "код RECEIVER_ID_REQUIRED");
  var anonymousAck = await call("POST", "/receiver/ack", { taskId: "t0" });
  eq(anonymousAck.body.code, "RECEIVER_ID_REQUIRED", "ACK без receiverId отклонён");

  // -------------------------------------------------------------------------
  // 13. Несовпадающая версия транспорта
  // -------------------------------------------------------------------------
  var oldClient = await hello("Старый плагин", null, 1);
  eq(oldClient.status, 409, "hello протокола 1 отклонён");
  eq(oldClient.body.code, "PROTOCOL_MISMATCH", "код PROTOCOL_MISMATCH");
  eq(bridge.state.receiver.receiverId, idA, "отказ по версии не тронул активный lease");

  // -------------------------------------------------------------------------
  // 3–4. В idle hello B перебивает A, и ждущий long-poll A просыпается отказом
  // -------------------------------------------------------------------------
  var pendingA = task(idA, 5);
  // Дать long-poll реально встать в очередь ожидания.
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  var b = await hello("Документ B");
  eq(b.status, 200, "hello B принят в idle");
  var idB = b.body.receiverId;
  ok(idB !== idA, "новый lease получил другой id");

  var wokenA = await pendingA;
  eq(wokenA.status, 409, "ожидающий long-poll A разбужен отказом");
  eq(wokenA.body.code, "RECEIVER_SUPERSEDED", "код RECEIVER_SUPERSEDED");
  eq(wokenA.body.documentName, "Документ B", "старый UI получает имя нового активного документа");
  ok(!wokenA.body.task, "старому poll задача не выдана");

  var statusAfterB = await call("GET", "/receiver/status");
  eq(statusAfterB.body.receiverId, idB, "активен последний включённый Receiver");
  eq(statusAfterB.body.documentName, "Документ B", "снимок показывает новый документ");

  // -------------------------------------------------------------------------
  // 12. Повторный hello активной сессии не меняет её id
  // -------------------------------------------------------------------------
  var renewed = await hello("Документ B", idB);
  eq(renewed.status, 200, "повторный handshake активной сессии принят");
  eq(renewed.body.receiverId, idB, "повторный hello не создаёт новый lease");

  var staleRenew = await hello("Документ A", idA);
  eq(staleRenew.status, 409, "hello с устаревшим id не воскрешает сессию");
  eq(staleRenew.body.code, "RECEIVER_SUPERSEDED", "устаревший id получает RECEIVER_SUPERSEDED");
  eq(bridge.state.receiver.receiverId, idB, "активным остался B");

  // -------------------------------------------------------------------------
  // 5. Старый A не может /bye отключить B
  // -------------------------------------------------------------------------
  var byeA = await call("POST", "/receiver/bye", { receiverId: idA });
  eq(byeA.status, 409, "/bye от старого Receiver отклонён");
  eq(byeA.body.code, "RECEIVER_SUPERSEDED", "код отказа RECEIVER_SUPERSEDED");
  var afterBye = await call("GET", "/receiver/status");
  eq(afterBye.body.ready, true, "B остался подключённым");
  eq(afterBye.body.receiverId, idB, "lease B не тронут чужим /bye");

  // -------------------------------------------------------------------------
  // 8. Несовпадающий expectedReceiverId: job не создаётся
  // -------------------------------------------------------------------------
  var wrongTarget = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idA,
    source: { fileName: "design.pix" },
  });
  eq(wrongTarget.status, 409, "job с чужим expectedReceiverId отклонена");
  eq(wrongTarget.body.code, "RECEIVER_CHANGED", "код RECEIVER_CHANGED");
  eq(bridge.state.job, null, "job при этом не создана");

  // -------------------------------------------------------------------------
  // 7. Job создаётся с expectedReceiverId B и запоминает цель
  // -------------------------------------------------------------------------
  var job = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idB,
    source: { sourceMode: "DIRECT_PIX", fileName: "design.pix" },
  });
  eq(job.status, 201, "job для активного Receiver создана");
  var jobId = job.body.jobId;
  eq(job.body.receiverId, idB, "ответ подтверждает закреплённую цель");

  var jobState = await call("GET", "/jobs/" + jobId + "/state");
  eq(jobState.body.job.receiverId, idB, "snapshot job хранит receiverId");
  eq(jobState.body.job.receiverDocumentName, "Документ B", "snapshot job хранит имя документа цели");

  await call("POST", "/jobs/" + jobId + "/task", { taskId: "t1", type: "DIRECT_PIX_START", payload: {} });

  // -------------------------------------------------------------------------
  // 6. Старый A не может забрать, подтвердить или уронить task B
  // -------------------------------------------------------------------------
  var stolen = await task(idA);
  eq(stolen.status, 409, "старый A не получает task");
  eq(stolen.body.code, "RECEIVER_SUPERSEDED", "и видит причину");

  var stolenAck = await call("POST", "/receiver/ack", { receiverId: idA, jobId: jobId, taskId: "t1" });
  eq(stolenAck.status, 409, "старый A не может подтвердить чужой task");
  var stolenError = await call("POST", "/receiver/error", {
    receiverId: idA, jobId: jobId, taskId: "t1", code: "IMPORT_FAILED", message: "чужая ошибка",
  });
  eq(stolenError.status, 409, "старый A не может уронить чужой task");
  eq(bridge.state.job.status, "running", "job осталась живой после чужих запросов");

  // -------------------------------------------------------------------------
  // 9. Во время running job hello C блокируется
  // -------------------------------------------------------------------------
  var blocked = await hello("Документ C");
  eq(blocked.status, 409, "hello во время running job отклонён");
  eq(blocked.body.code, "RECEIVER_SWITCH_BLOCKED", "код RECEIVER_SWITCH_BLOCKED");
  eq(blocked.body.jobId, jobId, "ответ называет удерживающую job");
  eq(blocked.body.documentName, "Документ B", "ответ называет закреплённую цель");
  eq(bridge.state.receiver.receiverId, idB, "активным остаётся B");

  // -------------------------------------------------------------------------
  // 14. Второй POST /jobs во время running job
  // -------------------------------------------------------------------------
  var deliveredFirst = await task(idB);
  eq(deliveredFirst.body.task.taskId, "t1", "B получил свой task");

  var busy = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idB,
    source: { fileName: "second.pix" },
  });
  eq(busy.status, 409, "вторая job во время running отклонена");
  eq(busy.body.code, "JOB_BUSY", "код JOB_BUSY");
  eq(bridge.state.job.jobId, jobId, "первая job не заменена");
  eq(bridge.state.current.task.taskId, "t1", "текущий task не сброшен");
  eq(bridge.state.current.status, "delivered", "статус выданного task не сброшен");

  // -------------------------------------------------------------------------
  // 10. B продолжает работать после отказов C и второго producer
  // -------------------------------------------------------------------------
  var ackedB = await call("POST", "/receiver/ack", {
    receiverId: idB, jobId: jobId, taskId: "t1", result: { ok: true },
  });
  eq(ackedB.status, 200, "ACK от закреплённого Receiver принят");
  ok(bridge.state.processed.t1 && bridge.state.processed.t1.status === "acked", "task зафиксирован как acked");

  await call("POST", "/jobs/" + jobId + "/task", { taskId: "t2", type: "DIRECT_PIX_ROOT", payload: {} });
  var secondDelivered = await task(idB);
  eq(secondDelivered.body.task.taskId, "t2", "B получает следующий task");
  var ackedSecond = await call("POST", "/receiver/ack", { receiverId: idB, jobId: jobId, taskId: "t2" });
  eq(ackedSecond.status, 200, "и подтверждает его");

  var finished = await call("POST", "/jobs/" + jobId + "/finish", { status: "done" });
  eq(finished.body.job.status, "done", "job закрыта штатно");

  // -------------------------------------------------------------------------
  // 11. После финиша активным становится C, B — superseded
  // -------------------------------------------------------------------------
  var c = await hello("Документ C");
  eq(c.status, 200, "после завершения job hello C принят");
  var idC = c.body.receiverId;
  ok(idC !== idB && idC !== idA, "C получил собственный lease");

  var supersededB = await task(idB);
  eq(supersededB.status, 409, "B больше не получает task");
  eq(supersededB.body.code, "RECEIVER_SUPERSEDED", "B видит, что его перебили");
  eq(supersededB.body.documentName, "Документ C", "B видит имя нового активного документа");

  var statusC = await call("GET", "/receiver/status");
  eq(statusC.body.receiverId, idC, "активен C");

  // Закрытая job не имеет права держать цель: новый Receiver обязан спокойно
  // опрашивать bridge ещё до создания следующей job.
  var pollC = await task(idC);
  eq(pollC.status, 204, "C опрашивает bridge без задач и без отказа");
  var jobForC = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idC,
    source: { fileName: "next.pix" },
  });
  eq(jobForC.status, 201, "следующая job создаётся уже для C");
  eq(jobForC.body.receiverId, idC, "и закреплена за C");
  await call("POST", "/jobs/" + jobForC.body.jobId + "/finish", { status: "done" });

  // -------------------------------------------------------------------------
  // 15. Владение job: снять её может только предъявивший producer token
  // -------------------------------------------------------------------------
  var secret = "producer-" + "f".repeat(48);
  var owned = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idC,
    producerToken: secret,
    source: { sourceMode: "DIRECT_PIX", fileName: "owned.pix" },
  });
  eq(owned.status, 201, "job с producer token создана");
  var ownedId = owned.body.jobId;
  ok(!owned.body.producerToken, "bridge не возвращает секрет обратно");

  var ownedSnapshot = await call("GET", "/jobs/" + ownedId + "/state");
  ok(JSON.stringify(ownedSnapshot.body).indexOf(secret) < 0, "секрет не попадает в снимок job");

  await call("POST", "/jobs/" + ownedId + "/task", { taskId: "o1", type: "DIRECT_PIX_START", payload: {} });
  var deliveredOwned = await task(idC);
  eq(deliveredOwned.body.task.taskId, "o1", "task выдан приёмнику и держит ACK-таймер");

  var noToken = await call("POST", "/jobs/" + ownedId + "/abort", {});
  eq(noToken.status, 403, "abort без токена отклонён");
  eq(noToken.body.code, "ABORT_FORBIDDEN", "код ABORT_FORBIDDEN");

  var wrongToken = await call("POST", "/jobs/" + ownedId + "/abort", { producerToken: "не тот секрет" });
  eq(wrongToken.status, 403, "abort с чужим токеном отклонён");
  eq(bridge.state.job.status, "running", "отказ не тронул job");
  eq(bridge.state.current.task.taskId, "o1", "и не сбросил её task");

  var wrongJob = await call("POST", "/jobs/job-которой-нет/abort", { producerToken: secret });
  eq(wrongJob.status, 404, "abort чужого jobId отклонён");
  eq(bridge.state.job.status, "running", "параллельная job не задета");

  var ownerAbort = await call("POST", "/jobs/" + ownedId + "/abort", {
    producerToken: secret, reason: "launcher-SIGTERM",
  });
  eq(ownerAbort.status, 200, "владелец снимает свою job");
  eq(ownerAbort.body.aborted, true, "ответ подтверждает отмену");
  eq(ownerAbort.body.job.status, "aborted", "job переведена в aborted");
  eq(bridge.state.current, null, "task освобождён вместе с ACK-таймером");

  var repeatAbort = await call("POST", "/jobs/" + ownedId + "/abort", { producerToken: secret });
  eq(repeatAbort.status, 200, "повторный abort принят");
  eq(repeatAbort.body.alreadyClosed, true, "и признан идемпотентным");

  // Job прежнего конвейера токена не объявляет — и снаружи не отменяема вовсе.
  var tokenless = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idC,
    source: { fileName: "legacy.pix" },
  });
  eq(tokenless.status, 201, "job без токена создаётся как прежде");
  var tokenlessAbort = await call("POST", "/jobs/" + tokenless.body.jobId + "/abort", {
    producerToken: secret,
  });
  eq(tokenlessAbort.status, 403, "job без producer token снаружи не отменяется");
  eq(bridge.state.job.status, "running", "она продолжает работать");
  await call("POST", "/jobs/" + tokenless.body.jobId + "/finish", { status: "done" });

  // После снятой job и Receiver, и следующая job стартуют без перезапуска.
  var afterAbort = await hello("Документ D");
  eq(afterAbort.status, 200, "следующий Receiver включается после aborted job");

  // Диагностика lease не пишет в лог полный id.
  var tail = await call("GET", "/log/tail?lines=200&format=json");
  var events = tail.body.entries.map(function (entry) { return entry.event; });
  ok(events.indexOf("receiver.activated") >= 0, "активация Receiver попала в лог");
  ok(events.indexOf("receiver.superseded") >= 0, "supersede попал в лог");
  ok(events.indexOf("receiver.switchRejected") >= 0, "блокировка смены попала в лог");
  ok(events.indexOf("receiver.requestRejected") >= 0, "отказ чужому запросу попал в лог");
  ok(events.indexOf("job.receiverPinned") >= 0, "закрепление цели job попало в лог");
  ok(events.indexOf("job.abortRejected") >= 0, "отказ в отмене job попал в лог");
  ok(events.indexOf("job.aborted") >= 0, "снятие job попало в лог");
  var serializedLog = JSON.stringify(tail.body.entries);
  ok(serializedLog.indexOf(idB) < 0, "полный receiverId в лог не пишется");
  ok(serializedLog.indexOf(secret) < 0, "producer token в лог не пишется");

  // -------------------------------------------------------------------------
  // 16. Занятый приёмник не протухает по TTL простоя
  // -------------------------------------------------------------------------
  //
  // Регрессия. Один тяжёлый корень строился 338 секунд. Всё это время плагин к
  // bridge не обращался — ему нечего было сказать. TTL простоя (45 с) истекал,
  // `activeReceiverId()` становился null, и ACK прилетал в отказ
  // `RECEIVER_SUPERSEDED`, хотя никакого другого Receiver не было и в помине.
  var busy = await hello("Занятый документ");
  var idBusy = busy.body.receiverId;
  var busyJob = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: idBusy,
    source: { sourceMode: "DIRECT_PIX", fileName: "heavy.pix" },
  });
  var busyJobId = busyJob.body.jobId;
  await call("POST", "/jobs/" + busyJobId + "/task", {
    taskId: "heavy-root", type: "DIRECT_PIX_ROOT", payload: {},
  });
  var heavy = await task(idBusy);
  eq(heavy.body.task.taskId, "heavy-root", "тяжёлый корень выдан приёмнику");

  // Плагин строит его дольше TTL простоя и к bridge не обращается.
  bridge.state.receiver.lastSeen = Date.now() - (bridge.RECEIVER_TTL_MS + 60000);
  var stillActive = await call("GET", "/receiver/status");
  eq(stillActive.body.ready, true, "занятый приёмник считается живым и после TTL простоя");
  eq(stillActive.body.receiverId, idBusy, "lease за ним сохранён");

  var lateAck = await call("POST", "/receiver/ack", {
    receiverId: idBusy, jobId: busyJobId, taskId: "heavy-root", result: { ok: true },
  });
  eq(lateAck.status, 200, "ACK после долгой сборки принят, а не отвергнут");
  eq(bridge.state.job.status, "running", "job продолжается");

  // А вот ПРАЗДНЫЙ приёмник по TTL протухает ровно как раньше.
  bridge.state.receiver.lastSeen = Date.now() - (bridge.RECEIVER_TTL_MS + 60000);
  var idleNow = await call("GET", "/receiver/status");
  eq(idleNow.body.ready, false, "без выданной задачи TTL простоя действует как прежде");
  await call("POST", "/jobs/" + busyJobId + "/finish", { status: "done" });

  bridge.resetForTests();
  await new Promise(function (resolve) { server.close(resolve); });
  process.stdout.write("ReceiverLeaseTest: OK, проверок — " + checks + "\n");
}

main().catch(function (error) {
  process.stderr.write("ReceiverLeaseTest: FAIL\n" + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
