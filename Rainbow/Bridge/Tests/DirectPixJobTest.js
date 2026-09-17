/**
 * Bridge и Direct PIX: node Bridge/Tests/DirectPixJobTest.js
 *
 * Проверяет ровно то, ради чего bridge вообще трогали:
 *   — job объявляет новый тип источника, и это видно в снимке;
 *   — задача без объявленного источника остаётся прежней (PIXSO_PLUGIN);
 *   — семантика протокола (очередь размера 1, ACK, ошибки) не изменилась;
 *   — отказ Direct-задачи закрывает свою job и не ломает bridge: следующая
 *     обычная миграция стартует как раньше;
 *   — прерванный продюсер снимает СВОЮ job своим producer token, и bridge
 *     остаётся свободен для следующей.
 */
"use strict";

var assert = require("assert");
var http = require("http");
var path = require("path");

var bridge = require(path.join(__dirname, "..", "Server.js"));
var DirectBridgeClient = require(path.join(__dirname, "..", "..", "DirectPix", "BridgeClient.js"));

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

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

/** Lease тестового приёмника: подставляется во все receiver-owned вызовы. */
var receiverId = null;

async function hello() {
  var response = await call("POST", "/receiver/hello", {
    receiverVersion: "0.1.0",
    protocolVersion: bridge.PROTOCOL_VERSION,
    documentName: "Target Figma",
  });
  receiverId = response.body && response.body.receiverId;
  return response;
}

function receiverTask() {
  return call("GET", "/receiver/task?receiverId=" + encodeURIComponent(receiverId || ""));
}

function receiverPost(route, body) {
  var payload = body || {};
  payload.receiverId = receiverId;
  return call("POST", route, payload);
}

async function main() {
  // D36. Transport byte chunking must never split one variant family. The
  // synthetic family deliberately exceeds the soft 4 MiB budget and has an
  // unrelated dependency-shaped item between its members; order stays intact
  // and the cut is delayed until the family closes.
  var directClient = DirectBridgeClient.createClient({ bridge: "http://127.0.0.1:1" });
  var grouped = directClient.chunkedKeepingGroups([
    { id: "a1", group: "A" }, { id: "dep", group: null },
    { id: "a2", group: "A" }, { id: "tail", group: null }
  ], function () { return 2 * 1024 * 1024; }, function (item) { return item.group; });
  eq(grouped.length, 2, "D36. atomic variant-family may exceed the soft byte budget but is not split");
  eq(grouped[0].length, 3, "D36. both family members and in-between dependency stay in one chunk");
  eq(grouped[0][0].id + "," + grouped[0][1].id + "," + grouped[0][2].id, "a1,dep,a2",
    "D36. grouped chunker preserves dependency order");

  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;

  // Классификация источника — чистая функция, её проверяем отдельно.
  eq(bridge.normalizeSourceMode(null), "PIXSO_PLUGIN", "источник по умолчанию — прежний конвейер");
  eq(bridge.normalizeSourceMode({ sourceMode: "DIRECT_PIX" }), "DIRECT_PIX", "Direct PIX объявляется явно");
  eq(bridge.normalizeSourceMode({ sourceMode: "что-то ещё" }), "PIXSO_PLUGIN",
    "неизвестный источник трактуется как прежний, а не как Direct");

  var handshake = await hello();
  ok(handshake.body.receiverId, "handshake выдал lease приёмника");
  eq(handshake.body.protocolVersion, bridge.PROTOCOL_VERSION, "транспорт объявляет свою версию");

  // -------------------------------------------------------------------------
  // 1. Direct-задача проходит прежним протоколом
  // -------------------------------------------------------------------------

  var created = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
    source: { sourceMode: "DIRECT_PIX", fileName: "Файл.pix" },
  });
  eq(created.status, 201, "job Direct PIX создана");
  var jobId = created.body.jobId;

  var status = await call("GET", "/receiver/status", undefined);
  eq(status.body.job.sourceMode, "DIRECT_PIX", "тип источника виден в снимке job");

  var posted = await call("POST", "/jobs/" + jobId + "/task", {
    taskId: "d1",
    type: "DIRECT_PIX_START",
    payload: { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 },
  });
  eq(posted.status, 202, "Direct-задача принята в очередь");

  // Очередь размера 1 действует и для нового типа задач.
  var second = await call("POST", "/jobs/" + jobId + "/task", { taskId: "d2", type: "DIRECT_PIX_ROOT", payload: {} });
  eq(second.status, 409, "вторая задача до ACK отклонена — backpressure не изменился");
  eq(second.body.code, "QUEUE_BUSY", "код отказа прежний");

  var delivered = await receiverTask();
  eq(delivered.status, 200, "задача выдана приёмнику");
  eq(delivered.body.task.type, "DIRECT_PIX_START", "тип задачи доехал без изменений");
  eq(delivered.body.task.payload.protocol, "PIXSO2FIGMA_DIRECT_PIX",
    "bridge переносит payload непрозрачно и в него не заглядывает");

  var acked = await receiverPost("/receiver/ack", { jobId: jobId, taskId: "d1", result: { ok: true } });
  eq(acked.status, 200, "ACK принят");

  var pagePosted = await call("POST", "/jobs/" + jobId + "/task", {
    taskId: "d-page",
    type: "DIRECT_PIX_PAGE",
    payload: { pageId: "2:2", pageName: "Экран" },
  });
  eq(pagePosted.status, 202, "page task full-document режима принята");
  var pageDelivered = await receiverTask();
  eq(pageDelivered.body.task.type, "DIRECT_PIX_PAGE", "page task передана непрозрачно");
  eq(pageDelivered.body.task.payload.pageId, "2:2", "source page id не изменён bridge");
  await receiverPost("/receiver/ack", { jobId: jobId, taskId: "d-page", result: { ok: true } });

  // -------------------------------------------------------------------------
  // 2. Отказ Direct-задачи закрывает свою job и не роняет bridge
  // -------------------------------------------------------------------------

  await call("POST", "/jobs/" + jobId + "/task", { taskId: "d3", type: "DIRECT_PIX_ROOT", payload: {} });
  await receiverTask();
  var failed = await receiverPost("/receiver/error", {
    jobId: jobId, taskId: "d3", code: "IMPORT_FAILED", message: "разбор не удался", fatal: true,
  });
  eq(failed.status, 200, "ошибка Direct-задачи принята");

  var afterFailure = await call("GET", "/jobs/" + jobId + "/state", undefined);
  eq(afterFailure.body.job.status, "failed", "job Direct помечена неудачной");

  var health = await call("GET", "/health");
  eq(health.status, 200, "bridge жив после отказа Direct-задачи");

  // -------------------------------------------------------------------------
  // 3. После неудачной Direct-задачи обычная миграция стартует как раньше
  // -------------------------------------------------------------------------

  var plain = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
    source: { fileName: "Документ Pixso", pages: 1, totalRoots: 1 },
  });
  eq(plain.status, 201, "обычная job создаётся после неудачной Direct");
  var plainStatus = await call("GET", "/receiver/status", undefined);
  eq(plainStatus.body.job.sourceMode, "PIXSO_PLUGIN",
    "отправитель без объявленного источника остаётся прежним конвейером");

  var plainTask = await call("POST", "/jobs/" + plain.body.jobId + "/task", {
    taskId: "p1", type: "START_JOB", payload: { migrationMode: "FAST" },
  });
  eq(plainTask.status, 202, "старая задача принимается прежним протоколом");
  var plainDelivered = await receiverTask();
  eq(plainDelivered.body.task.payload.migrationMode, "FAST", "режим старого протокола не тронут");
  await receiverPost("/receiver/ack", { jobId: plain.body.jobId, taskId: "p1", result: { ok: true } });
  var finished = await call("POST", "/jobs/" + plain.body.jobId + "/finish", { status: "done" });
  eq(finished.body.job.status, "done", "обычная job завершается штатно");

  // -------------------------------------------------------------------------
  // 3.5. Heartbeat занятого приёмника отодвигает ACK-таймаут
  // -------------------------------------------------------------------------
  //
  // Регрессия. Корень, который строится дольше пяти минут, раньше гарантированно
  // получал `TASK_TIMEOUT`: таймер взводился один раз в момент выдачи. Теперь
  // каждый heartbeat по ЭТОЙ задаче отсчёт перезапускает.
  var beatJob = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
    source: { sourceMode: "DIRECT_PIX", fileName: "heavy.pix" },
  });
  await call("POST", "/jobs/" + beatJob.body.jobId + "/task", {
    taskId: "beat-1", type: "DIRECT_PIX_ROOT", payload: {},
  });
  await receiverTask();
  // Таймеры сравниваем только по тождеству: сериализовать их нельзя —
  // структура циклическая.
  var firstTimer = bridge.state.current.ackTimer;
  ok(firstTimer, "ACK-таймер взведён при выдаче");

  var beat = await call("GET", "/receiver/status?role=receiver&taskId=beat-1&receiverId=" +
    encodeURIComponent(receiverId));
  eq(beat.status, 200, "heartbeat принят");
  ok(bridge.state.current.ackTimer !== firstTimer, "heartbeat перезавёл ACK-таймер");
  eq(bridge.state.current.status, "delivered", "и не тронул статус задачи");

  // Heartbeat по чужой задаче таймер не трогает.
  var stale = bridge.state.current.ackTimer;
  await call("GET", "/receiver/status?role=receiver&taskId=не-та-задача&receiverId=" +
    encodeURIComponent(receiverId));
  ok(bridge.state.current.ackTimer === stale, "heartbeat по чужому taskId ничего не перезаводит");

  await receiverPost("/receiver/ack", { jobId: beatJob.body.jobId, taskId: "beat-1", result: { ok: true } });
  await call("POST", "/jobs/" + beatJob.body.jobId + "/finish", { status: "done" });

  // -------------------------------------------------------------------------
  // 4. Прерванный Direct-продюсер снимает свою job через BridgeClient
  // -------------------------------------------------------------------------

  var live = DirectBridgeClient.createClient({
    bridge: base,
    expectedReceiverId: receiverId,
    producerToken: "direct-producer-secret-token",
  });
  await live.ensureReceiver(receiverId);
  var liveJobId = await live.start({ fileName: "interrupted.pix" });
  eq(bridge.state.job.status, "running", "Direct-продюсер открыл job");

  // Так выглядит закрытое окно launcher: `finish` уже не будет.
  var abortedByOwner = await live.abortJob(null, null, "signal:SIGTERM");
  eq(abortedByOwner.status, 200, "продюсер снял свою job");
  eq(abortedByOwner.body.aborted, true, "bridge подтвердил отмену");
  eq(bridge.state.job.status, "aborted", "job помечена aborted, а не осталась running");
  eq(bridge.state.current, null, "очередь освобождена");

  // Прерванный продюсер успевает прислать свой `finish("failed")` уже ПОСЛЕ
  // отмены. Исход закрытой job он переписать не имеет права: иначе снятая job
  // возвращалась бы в диагностику как «failed» и теряла настоящую причину.
  var lateFinish = await call("POST", "/jobs/" + liveJobId + "/finish", {
    status: "failed", error: { message: "поздний finish умирающего продюсера" },
  });
  eq(lateFinish.status, 200, "поздний finish принят без ошибки");
  eq(lateFinish.body.alreadyClosed, true, "но признан идемпотентным");
  eq(bridge.state.job.status, "aborted", "исход снятой job остался aborted");

  var afterAbort = await call("POST", "/jobs", {
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
    source: { sourceMode: "DIRECT_PIX", fileName: "after-abort.pix" },
  });
  eq(afterAbort.status, 201, "следующая job стартует без перезапуска bridge");
  await call("POST", "/jobs/" + afterAbort.body.jobId + "/finish", { status: "done" });

  var staleAbort = await live.abortJob(liveJobId, null, "repeat");
  eq(staleAbort.status, 404, "снятая и забытая job повторно не трогается");

  bridge.resetForTests();
  await new Promise(function (resolve) { server.close(resolve); });
  process.stdout.write("DirectPixJobTest: OK, проверок — " + checks + "\n");
}

main().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
});
