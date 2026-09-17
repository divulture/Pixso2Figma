/**
 * Тест state machine потоковой миграции: node Bridge/Tests/PipelineStateTest.js
 *
 * Здесь проверяется не сериализация, а сам конвейер продюсера — тот же цикл,
 * исторической producer state machine:
 *
 *   serialize A → post A → (serialize B ‖ import A) → ACK A → post B → …
 *
 * Сериализатор и приёмник заменены на управляемые заглушки, зато bridge —
 * настоящий: именно он держит очередь длиной 1 и защищает от дублей taskId.
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
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
        });
      }
    );
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/**
 * Lease тестового приёмника. Один глобальный фиктивный id в обход handshake
 * подставлять нельзя: bridge обязан узнавать именно выданный им lease.
 */
var receiverId = null;

async function connectReceiver(documentName) {
  var response = await call("POST", "/receiver/hello", {
    receiverVersion: "test",
    protocolVersion: bridge.PROTOCOL_VERSION,
    documentName: documentName || "Figma",
  });
  receiverId = response.body && response.body.receiverId;
  if (!receiverId) throw new Error("handshake не выдал receiverId");
  return response.body;
}

function receiverTask(wait) {
  return call("GET", "/receiver/task?receiverId=" + encodeURIComponent(receiverId || "") +
    (wait ? "&wait=" + wait : ""));
}

function receiverPost(route, body) {
  var payload = body || {};
  payload.receiverId = receiverId;
  return call("POST", route, payload);
}

// ---------------------------------------------------------------------------
// Заглушка приёмника: импортирует последовательно, может упасть на заданном
// корне, считает, сколько РАЗ реально импортировал каждый taskId.
// ---------------------------------------------------------------------------

function createReceiver(options) {
  var state = {
    imported: [],
    importsByTask: Object.create(null),
    concurrent: 0,
    peakConcurrent: 0,
    trace: [],
  };
  var running = true;

  async function loop() {
    while (running) {
      var next = await receiverTask(5);
      if (!running) return;
      if (next.status !== 200 || !next.body || !next.body.task) continue;
      var task = next.body.task;

      // Идемпотентность приёмника: повторно доставленный task не импортируется.
      if (state.importsByTask[task.taskId]) {
        await receiverPost("/receiver/ack", { jobId: task.jobId, taskId: task.taskId, result: { duplicate: true } });
        continue;
      }

      if (task.type === "ROOT_NODE") {
        state.concurrent += 1;
        state.peakConcurrent = Math.max(state.peakConcurrent, state.concurrent);
        state.trace.push("import.start:" + task.payload.name);
        await sleep(30);
        state.concurrent -= 1;
        state.importsByTask[task.taskId] = (state.importsByTask[task.taskId] || 0) + 1;

        if (options.failOn === task.payload.name) {
          state.trace.push("import.failed:" + task.payload.name);
          await receiverPost("/receiver/error", {
            jobId: task.jobId, taskId: task.taskId,
            code: "IMPORT_FAILED", message: "не удалось собрать «" + task.payload.name + "»", fatal: true,
          });
          continue;
        }
        state.imported.push(task.payload.name);
        state.trace.push("import.done:" + task.payload.name);
      } else {
        state.importsByTask[task.taskId] = 1;
      }

      await receiverPost("/receiver/ack", {
        jobId: task.jobId, taskId: task.taskId, result: { ok: true, importDurationMs: 30 },
      });
      if (task.type === "FINISH_JOB") running = false;
    }
  }

  return { state: state, done: loop(), stop: function () { running = false; } };
}

// ---------------------------------------------------------------------------
// Продюсер: точная копия конвейера из Ui.html на заглушке сериализатора.
// ---------------------------------------------------------------------------

function createProducer(roots, receiverTrace) {
  var pipeline = {
    live: 0,           // сколько chunks существует в памяти прямо сейчас
    peakLive: 0,
    serialized: [],
    posted: [],
    released: 0,
    trace: receiverTrace,
  };

  function serializeAt(index) {
    pipeline.live += 1;
    pipeline.peakLive = Math.max(pipeline.peakLive, pipeline.live);
    pipeline.serialized.push(roots[index]);
    pipeline.trace.push("serialize.start:" + roots[index]);
    var promise = sleep(20).then(function () {
      pipeline.trace.push("serialize.done:" + roots[index]);
      return { name: roots[index], payloadBytes: "x" };
    });
    promise.catch(function () {});
    return promise;
  }

  async function postTask(jobId, sequence, type, payload) {
    var taskId = jobId + "-" + sequence;
    var attempts = 0;
    while (true) {
      try {
        var posted = await call("POST", "/jobs/" + jobId + "/task", { taskId: taskId, type: type, payload: payload });
        if (posted.status !== 202 && posted.status !== 200) throw new Error("bridge " + posted.status);
        return taskId;
      } catch (error) {
        attempts += 1;
        if (attempts >= 4) throw error;
        await sleep(50 * attempts);
      }
    }
  }

  async function awaitAck(jobId, taskId) {
    while (true) {
      var state = await call("GET", "/jobs/" + jobId + "/task/" + taskId + "?wait=5");
      if (state.body.status === "acked") return state.body.result || {};
      if (state.body.status === "error") throw new Error(state.body.error.message);
      if (state.body.status === "unknown") throw new Error("bridge потерял task");
    }
  }

  async function run(jobId) {
    var sequence = 1;
    await awaitAck(jobId, await postTask(jobId, sequence, "START_JOB", {}));

    var prefetched = roots.length ? serializeAt(0) : null;
    try {
      for (var n = 0; n < roots.length; n++) {
        var chunk = await prefetched;
        prefetched = null;

        sequence += 1;
        pipeline.posted.push(chunk.name);
        var taskId = await postTask(jobId, sequence, "ROOT_NODE", chunk);
        chunk = null;
        pipeline.live -= 1;

        if (n + 1 < roots.length) prefetched = serializeAt(n + 1);

        // Ошибка импорта прилетает именно здесь и обязана остановить миграцию,
        // не отправив уже подготовленный следующий chunk.
        await awaitAck(jobId, taskId);
      }
      sequence += 1;
      await awaitAck(jobId, await postTask(jobId, sequence, "FINISH_JOB", {}));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      // Освобождение prefetch — часть контракта: чанк, который уже не уедет,
      // не должен удерживаться конвейером.
      if (prefetched) { pipeline.released += 1; pipeline.live -= 1; }
      prefetched = null;
    }
  }

  return { pipeline: pipeline, run: run, postTask: postTask, awaitAck: awaitAck };
}

async function startJob() {
  var created = await call("POST", "/jobs", {
    // Версия транспорта берётся из самого bridge: захардкоженная 1 больше
    // не является протоколом, а payload Direct PIX здесь ни при чём.
    protocolVersion: bridge.PROTOCOL_VERSION,
    expectedReceiverId: receiverId,
    source: { fileName: "Pipeline" },
  });
  eq(created.status, 201, "bridge создал job");
  return created.body.jobId;
}

// ---------------------------------------------------------------------------

async function testNormalPipeline() {
  var receiver = createReceiver({});
  var jobId = await startJob();
  var producer = createProducer(["A", "B", "C", "D"], receiver.state.trace);
  var outcome = await producer.run(jobId);
  await call("POST", "/jobs/" + jobId + "/finish", { status: "done" });
  await receiver.done;

  var pipeline = producer.pipeline;
  eq(outcome.ok, true, "нормальный конвейер доходит до конца");
  assert.deepStrictEqual(receiver.state.imported, ["A", "B", "C", "D"], "все корни импортированы по порядку");
  checks += 1;
  eq(receiver.state.peakConcurrent, 1, "импорты в Figma остаются строго последовательными");
  ok(pipeline.peakLive <= 2, "в памяти не больше двух chunks: текущий + один prefetched");

  // Каждая сериализация N+1 начинается до завершения импорта N.
  var trace = receiver.state.trace;
  var overlapped = 0;
  ["B", "C", "D"].forEach(function (name, i) {
    var previous = ["A", "B", "C"][i];
    var startIndex = trace.indexOf("serialize.start:" + name);
    var importDone = trace.indexOf("import.done:" + previous);
    if (startIndex >= 0 && importDone >= 0 && startIndex < importDone) overlapped += 1;
  });
  eq(overlapped, 3, "сериализация следующего chunk перекрывается с импортом текущего");

  // Отправка при этом остаётся под backpressure: post N+1 только после ACK N.
  ["B", "C", "D"].forEach(function (name, i) {
    var previous = ["A", "B", "C"][i];
    var importDone = trace.indexOf("import.done:" + previous);
    var importStart = trace.indexOf("import.start:" + name);
    ok(importStart > importDone, "импорт «" + name + "» начался только после «" + previous + "»");
  });
}

async function testImportError() {
  bridge.resetForTests();
  var receiver = createReceiver({ failOn: "B" });
  await connectReceiver("Figma");
  var jobId = await startJob();
  var producer = createProducer(["A", "B", "C", "D"], receiver.state.trace);
  var outcome = await producer.run(jobId);
  receiver.stop();
  await receiver.done;

  var pipeline = producer.pipeline;
  eq(outcome.ok, false, "ошибка импорта останавливает миграцию");
  ok(/не удалось собрать/.test(outcome.message), "продюсер показывает сообщение приёмника");
  assert.deepStrictEqual(receiver.state.imported, ["A"], "после ошибки ничего больше не импортируется");
  checks += 1;
  assert.deepStrictEqual(pipeline.posted, ["A", "B"], "подготовленный C не отправлен");
  checks += 1;
  ok(pipeline.serialized.indexOf("C") >= 0, "C успел сериализоваться как prefetch до ошибки");
  eq(pipeline.released, 1, "prefetched C освобождён");
  eq(pipeline.live, 0, "после остановки в конвейере не осталось удерживаемых chunks");

  var state = await call("GET", "/jobs/" + jobId + "/state");
  eq(state.body.job.status, "failed", "job закрыта как failed");
}

async function testTransportRetry() {
  bridge.resetForTests();
  var receiver = createReceiver({});
  await connectReceiver("Figma");
  var jobId = await startJob();
  var producer = createProducer([], receiver.state.trace);

  await producer.awaitAck(jobId, await producer.postTask(jobId, 1, "START_JOB", {}));

  // Транспортный ретрай: тот же taskId уходит в bridge дважды.
  var taskId = await producer.postTask(jobId, 2, "ROOT_NODE", { name: "A" });
  var retry = await call("POST", "/jobs/" + jobId + "/task", {
    taskId: taskId, type: "ROOT_NODE", payload: { name: "A" },
  });
  ok(retry.status === 200 || retry.status === 202, "повторный POST того же taskId принят без ошибки");
  await producer.awaitAck(jobId, taskId);

  await producer.awaitAck(jobId, await producer.postTask(jobId, 3, "FINISH_JOB", {}));
  await call("POST", "/jobs/" + jobId + "/finish", { status: "done" });
  await receiver.done;

  eq(receiver.state.importsByTask[taskId], 1, "ретрай транспорта не приводит ко второму импорту того же task");
  assert.deepStrictEqual(receiver.state.imported, ["A"], "корень импортирован ровно один раз");
  checks += 1;
}

async function main() {
  var server = bridge.createServer();
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;

  await connectReceiver("Figma");

  await testNormalPipeline();
  await testImportError();
  await testTransportRetry();

  bridge.resetForTests();
  await new Promise(function (resolve) { server.close(resolve); });
  process.stdout.write("PipelineStateTest: OK, проверок — " + checks + "\n");
}

main().catch(function (error) {
  process.stderr.write("PipelineStateTest: FAIL\n" + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
