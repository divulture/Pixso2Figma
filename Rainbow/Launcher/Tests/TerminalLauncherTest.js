/**
 * Terminal launcher: node Launcher/Tests/TerminalLauncherTest.js
 *
 * Всё внешнее подменено фейками: ни Figma, ни bridge, ни настоящий Node-процесс
 * здесь не нужны. Проверяется ровно то, ради чего launcher вообще существует:
 *
 *   — перетащенный путь разбирается, а не исполняется;
 *   — за раз принимается ровно один `.pix`;
 *   — миграция запускается существующей точкой входа Direct PIX с id того
 *     Receiver, который был показан пользователю;
 *   — во время migration второй файл не ставится в очередь, и приглашение
 *     во время BUSY не появляется;
 *   — отсутствие/смена Receiver не оставляет скрытой отложенной задачи, а
 *     подсказка просит передать файл заново, а не «нажать Enter ещё раз»;
 *   — launcher гасит только тот bridge, который сам и поднял, но свою Direct
 *     PIX job снимает с ЛЮБОГО bridge, включая переиспользуемый;
 *   — одновременно работает ровно одно окно: новое закрывает старое и только
 *     потом поднимает bridge.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var http = require("http");
var path = require("path");
var EventEmitter = require("events").EventEmitter;

var BridgeServer = require(path.join(__dirname, "..", "..", "Bridge", "Server.js"));
var BridgeClient = require(path.join(__dirname, "..", "..", "DirectPix", "BridgeClient.js"));

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

// Требование: require() модуля не запускает main() и не вешает обработчики.
var sigintBefore = process.listenerCount("SIGINT");
var Terminal = require(path.join(__dirname, "..", "Terminal.js"));
eq(process.listenerCount("SIGINT"), sigintBefore, "require() не запускает main() и не ставит обработчики сигналов");
ok(typeof Terminal.main === "function", "main экспортирован для обёрток");
ok(
  fs.readFileSync(path.join(__dirname, "..", "Terminal.js"), "utf8").indexOf("require.main === module") >= 0,
  "точка входа защищена проверкой require.main"
);

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-launcher-"));
var pixFile = path.join(tmpDir, "design.pix");
var jsonFile = path.join(tmpDir, "design.json");
var subDir = path.join(tmpDir, "Каталог.pix");
var weirdFile = path.join(tmpDir, "drop $(whoami);rm -rf `id`.pix");
fs.writeFileSync(pixFile, "not a real pix");
fs.writeFileSync(jsonFile, "{}");
fs.mkdirSync(subDir);
fs.writeFileSync(weirdFile, "not a real pix");

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* уборка не критична */ }
}

/** Экранирование, которое Terminal.app вставляет при drag & drop. */
function posixEscape(value) {
  return value.replace(/([ \t"'\\$`;&|<>()*?#~!])/g, "\\$1");
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/** Прямой вызов bridge: нужен там, где тест играет роль Receiver и продюсера. */
function httpCall(base, method, route, body) {
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

async function waitFor(condition, what) {
  for (var i = 0; i < 400; i++) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error("Не дождались: " + what);
}

// ---------------------------------------------------------------------------
// 1. Разбор перетащенного пути (чистая функция)
// ---------------------------------------------------------------------------

function parsed(line, platform) {
  return Terminal.parseDroppedPaths(line, platform || "darwin");
}

function testParsing() {
  var plain = parsed("/Users/me/Desktop/design.pix");
  eq(plain.ok, true, "обычный POSIX-путь разобран");
  eq(plain.paths[0], "/Users/me/Desktop/design.pix", "путь не изменён");

  var escaped = parsed("/Users/me/My\\ Design/design.pix");
  eq(escaped.paths[0], "/Users/me/My Design/design.pix", "escaped пробел развёрнут");

  var single = parsed("'/Users/me/My Design/design.pix'");
  eq(single.paths[0], "/Users/me/My Design/design.pix", "путь в одинарных кавычках разобран");

  var double = parsed('"/Users/me/My Design/design.pix"');
  eq(double.paths[0], "/Users/me/My Design/design.pix", "путь в двойных кавычках разобран");

  var backslash = parsed("/Users/me/A\\\\B/design.pix");
  eq(backslash.paths[0], "/Users/me/A\\B/design.pix", "экранированный backslash остаётся одним символом пути");

  var windows = parsed('"C:\\Users\\Me\\My Design\\design.pix"', "win32");
  eq(windows.paths[0], "C:\\Users\\Me\\My Design\\design.pix",
    "на Windows обратная косая черта не считается экранированием");
  var windowsBare = parsed("C:\\Users\\Me\\design.pix", "win32");
  eq(windowsBare.paths[0], "C:\\Users\\Me\\design.pix", "обычный Windows-путь разобран");
  var windowsPowerShell = parsed("'C:\\Users\\Me\\My Design\\design.pix'", "win32");
  eq(windowsPowerShell.paths[0], "C:\\Users\\Me\\My Design\\design.pix",
    "путь в одинарных кавычках PowerShell разобран");

  eq(parsed("").code, "EMPTY", "пустая строка не запускает migration");
  eq(parsed("   ").code, "EMPTY", "строка из пробелов не запускает migration");
  eq(parsed("/a/one.pix /b/two.pix").code, "ONE_FILE_ONLY", "два файла отклоняются отдельным кодом");
  eq(parsed('"C:\\a\\one.pix" "C:\\b\\two.pix"', "win32").code, "ONE_FILE_ONLY",
    "два закавыченных файла на Windows тоже отклоняются");
  eq(parsed("/a/de\u0000sign.pix").code, "INVALID_PATH", "NUL в пути запрещён");
  eq(parsed("/a/design.pix\nrm -rf /").code, "INVALID_PATH", "embedded newline запрещён");
  eq(parsed("'/a/design.pix").code, "INVALID_PATH", "незакрытая кавычка — ошибка, а не догадка");

  // Метасимволы остаются символами имени файла: никакой подстановки.
  var meta = parsed("'/Users/me/$(whoami);rm -rf ~/`id`.pix'");
  eq(meta.ok, true, "путь с shell-метасимволами разобран");
  eq(meta.paths[0], "/Users/me/$(whoami);rm -rf ~/`id`.pix", "метасимволы не раскрыты и не выполнены");
  var metaEscaped = parsed(posixEscape("/Users/me/$(whoami).pix"));
  eq(metaEscaped.paths[0], "/Users/me/$(whoami).pix", "escaped метасимволы дают исходное имя");
  var glob = parsed("/Users/me/*.pix");
  eq(glob.paths[0], "/Users/me/*.pix", "globbing не выполняется");
  var tilde = parsed("~/design.pix");
  eq(tilde.paths[0], "~/design.pix", "тильда не раскрывается launcher-ом");
}

function testFileValidation() {
  var good = Terminal.validateDroppedFile(pixFile, fs.statSync);
  eq(good.ok, true, "существующий .pix принят");
  eq(good.path, pixFile, "путь приведён к абсолютному");

  eq(Terminal.validateDroppedFile(path.join(tmpDir, "нет.pix"), fs.statSync).code, "NOT_FOUND",
    "несуществующий файл отклонён");
  eq(Terminal.validateDroppedFile(subDir, fs.statSync).code, "NOT_A_FILE", "каталог отклонён");
  eq(Terminal.validateDroppedFile(jsonFile, fs.statSync).code, "NOT_PIX", "не .pix отклонён");

  var upper = path.join(tmpDir, "DESIGN.PIX");
  fs.writeFileSync(upper, "x");
  eq(Terminal.validateDroppedFile(upper, fs.statSync).ok, true, "расширение сверяется без учёта регистра");

  var link = path.join(tmpDir, "link.pix");
  try {
    fs.symlinkSync(pixFile, link);
    eq(Terminal.validateDroppedFile(link, fs.statSync).ok, true, "симлинк на обычный .pix допустим");
  } catch (_e) {
    // На системах без права создавать симлинки проверку пропускаем.
  }
}

// ---------------------------------------------------------------------------
// 2. Фейковое окружение launcher
// ---------------------------------------------------------------------------

function fakeChild() {
  var child = new EventEmitter();
  child.killSignals = [];
  child.kill = function (signal) {
    child.killSignals.push(signal);
    setImmediate(function () { child.emit("exit", null, signal); });
    return true;
  };
  return child;
}

var lockSeq = 0;

function createHarness(options) {
  var settings = options || {};
  var harness = {
    spawns: [],
    output: [],
    events: [],
    bridgeUp: settings.bridgeAlreadyRunning === true,
    status: settings.status || { ready: true, receiverId: "receiver-a", documentName: "Dashboard — Figma", protocolVersion: 2 },
    statusError: null,
  };

  harness.lockPath = settings.lockPath || path.join(tmpDir, "lock-" + (lockSeq += 1) + ".lock");
  harness.launcher = Terminal.createLauncher({
    bridgeUrl: "http://localhost:8787",
    lockPath: harness.lockPath,
    pid: settings.pid || 1000 + lockSeq,
    isProcessAlive: settings.isProcessAlive || function () { return true; },
    killProcess: settings.killProcess || function () {},
    confirmTakeover: settings.confirmTakeover,
    lockHeartbeatMs: settings.lockHeartbeatMs || 20,
    takeoverGraceMs: settings.takeoverGraceMs === undefined ? 200 : settings.takeoverGraceMs,
    lockPollMs: settings.lockPollMs || 5,
    platform: settings.platform || "darwin",
    execPath: "/fake/node",
    cliPath: "/project/DirectPix/Cli.js",
    bridgeServerPath: "/project/Bridge/Server.js",
    projectDir: "/project",
    statSync: fs.statSync,
    startupTimeoutMs: 400,
    probeIntervalMs: 5,
    exitGraceMs: 60,
    // Фоновый опрос в тестах не нужен: статус читается явно.
    pollMs: 3600000,
    spawn: function (file, args, opts) {
      var child = fakeChild();
      harness.spawns.push({ file: file, args: args, options: opts, child: child });
      if (args[0] === "/project/Bridge/Server.js") harness.bridgeUp = true;
      return child;
    },
    write: function (text) { harness.output.push(String(text)); },
    log: function (event, data) { harness.events.push({ event: event, data: data }); },
    probeHealth: function () {
      if (!harness.bridgeUp) return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8787"));
      return Promise.resolve({
        status: 200,
        body: { ok: true, bridgeVersion: "0.1.0", protocolVersion: settings.bridgeProtocolVersion || 2 },
      });
    },
    readStatus: function () {
      if (harness.statusError) return Promise.reject(harness.statusError);
      return Promise.resolve(harness.status);
    },
  });

  harness.text = function () { return harness.output.join("\n"); };
  harness.migrationSpawns = function () {
    return harness.spawns.filter(function (entry) { return entry.args[0] === "/project/DirectPix/Cli.js"; });
  };
  harness.bridgeSpawns = function () {
    return harness.spawns.filter(function (entry) { return entry.args[0] === "/project/Bridge/Server.js"; });
  };
  return harness;
}

// ---------------------------------------------------------------------------
// 3. Bridge lifecycle
// ---------------------------------------------------------------------------

async function testReusedBridge() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  var started = await harness.launcher.start();
  eq(started.ok, true, "launcher стартует на уже работающем bridge");
  eq(harness.launcher.ownsBridge(), false, "чужой bridge не считается своим");
  eq(harness.bridgeSpawns().length, 0, "второй экземпляр bridge не поднимается");

  await harness.launcher.shutdown("test");
  eq(harness.launcher.state(), "STOPPED", "launcher остановлен");
  eq(harness.bridgeSpawns().length, 0, "чужой bridge launcher не убивает");
  ok(harness.text().indexOf("Bridge оставлен работать") >= 0, "пользователю сказано, что bridge остался жив");
}

async function testOwnedBridge() {
  var harness = createHarness({ bridgeAlreadyRunning: false });
  var started = await harness.launcher.start();
  eq(started.ok, true, "launcher поднимает bridge сам");
  eq(harness.launcher.ownsBridge(), true, "поднятый bridge принадлежит launcher");
  eq(harness.bridgeSpawns().length, 1, "bridge запущен ровно один раз");
  var bridgeSpawn = harness.bridgeSpawns()[0];
  eq(bridgeSpawn.file, "/fake/node", "bridge запускается через process.execPath");
  eq(bridgeSpawn.options.shell, false, "bridge запускается без оболочки");
  ok(harness.events.some(function (e) { return e.event === "launcher.bridgeSpawned"; }),
    "поднятие bridge попало в диагностику");

  await harness.launcher.shutdown("test");
  assert.deepStrictEqual(bridgeSpawn.child.killSignals, ["SIGTERM"], "свой bridge останавливается корректно");
  checks += 1;
  eq(harness.launcher.state(), "STOPPED", "launcher дошёл до STOPPED");

  // Идемпотентность: второй вызов ничего не запускает заново.
  await harness.launcher.shutdown("test");
  eq(harness.spawns.length, 1, "повторный shutdown не создаёт процессов");
}

async function testIncompatibleBridge() {
  var harness = createHarness({ bridgeAlreadyRunning: true, bridgeProtocolVersion: 1 });
  var started = await harness.launcher.start();
  eq(started.ok, false, "несовместимый протокол bridge останавливает старт");
  eq(started.code, "BRIDGE_INCOMPATIBLE", "причина названа точно");
  eq(harness.migrationSpawns().length, 0, "migration при этом не запускается");
}

// ---------------------------------------------------------------------------
// 4. Приём файла
// ---------------------------------------------------------------------------

async function testHappyPath() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();
  eq(harness.launcher.state(), "IDLE_READY", "готовый Receiver даёт IDLE_READY");

  var running = harness.launcher.submit(posixEscape(pixFile));
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn Direct PIX");
  eq(harness.launcher.state(), "BUSY", "во время migration launcher в BUSY");

  var call = harness.migrationSpawns()[0];
  eq(call.file, "/fake/node", "используется process.execPath");
  eq(call.args[0], "/project/DirectPix/Cli.js", "вызывается существующая точка входа Direct PIX");
  eq(call.args[1], pixFile, "путь уезжает отдельным абсолютным аргументом");
  ok(path.isAbsolute(call.args[1]), "путь абсолютный");
  eq(call.args[2], "--migrate-file", "переносится весь файл");
  eq(call.args[3], "--receiver-id", "цель объявлена явно");
  eq(call.args[4], "receiver-a", "передан id именно показанного Receiver");
  eq(call.args.length, 5, "лишних аргументов нет");
  eq(call.options.shell, false, "оболочка не используется");
  eq(call.options.stdio[1], "inherit", "stdout Direct PIX виден в том же терминале");
  eq(call.options.stdio[2], "inherit", "stderr Direct PIX виден в том же терминале");
  eq(call.options.stdio[3], "ipc", "есть канал IPC: потомок сообщает id созданной job");
  ok(call.options.env && call.options.env.PIXSO2FIGMA_PRODUCER_TOKEN,
    "producer token передан потомку");
  ok(call.args.indexOf(call.options.env.PIXSO2FIGMA_PRODUCER_TOKEN) < 0,
    "токен уехал окружением, а не командной строкой (её видно в ps)");

  // Второй Enter во время migration отклоняется и не ставится в очередь.
  var second = await harness.launcher.submit(posixEscape(pixFile));
  eq(second.code, "BUSY_REJECTED", "второй файл во время migration отклонён");
  ok(harness.text().indexOf("Migration уже выполняется") >= 0, "пользователь видит причину отказа");
  eq(harness.migrationSpawns().length, 1, "второй процесс не запущен");

  call.child.emit("exit", 0, null);
  var outcome = await running;
  eq(outcome.code, "OK", "нулевой код завершения — успех");
  eq(harness.launcher.state(), "IDLE_READY", "prompt снова доступен");
  eq(harness.migrationSpawns().length, 1, "после успеха отложенный файл не стартует");
  ok(harness.text().indexOf("✓ design.pix перенесён в Dashboard — Figma") >= 0, "показан точный результат");
  ok(harness.events.some(function (e) { return e.event === "launcher.migrationStarted"; }), "старт записан в диагностику");
  ok(harness.events.some(function (e) { return e.event === "launcher.migrationFinished"; }), "финал записан в диагностику");
  var startedEvent = harness.events.filter(function (e) { return e.event === "launcher.migrationStarted"; })[0];
  eq(startedEvent.data.file, "design.pix", "в лог уходит только basename");
  ok(JSON.stringify(harness.events).indexOf(tmpDir) < 0, "полный локальный путь в диагностику не пишется");

  await harness.launcher.shutdown("test");
}

async function testProbeCommand() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();
  ok(harness.text().indexOf("введите probe") >= 0, "команда опытов видна при старте");

  var running = harness.launcher.submit("  PROBE ");
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn опытов Figma");
  var call = harness.migrationSpawns()[0];
  eq(call.args[0], "/project/DirectPix/Cli.js", "опыты идут через ту же точку входа Direct PIX");
  eq(call.args[1], "--probe-figma", "режим опытов, без файла");
  eq(call.args[2], "--receiver-id", "цель объявлена явно");
  eq(call.args[3], "receiver-a", "передан id показанного Receiver");
  eq(call.args.length, 4, "лишних аргументов нет");
  eq(call.options.shell, false, "оболочка не используется");
  eq(harness.launcher.state(), "BUSY", "во время опытов launcher в BUSY");

  call.child.emit("exit", 0, null);
  var outcome = await running;
  eq(outcome.code, "OK", "опыты завершились успешно");
  ok(harness.text().indexOf("Карта возможностей: FIGMA_CAPABILITIES.md") >= 0, "пользователь видит, где карта");
  await harness.launcher.shutdown("test");
}

async function testCheckCommand() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();
  ok(harness.text().indexOf("введите check") >= 0, "команда сверки видна при старте");

  var running = harness.launcher.submit(" Check ");
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn сверки экранов");
  var call = harness.migrationSpawns()[0];
  eq(call.args[0], "/project/DirectPix/Cli.js", "сверка идёт через ту же точку входа Direct PIX");
  eq(call.args[1], "--check-screens", "режим сверки экранов");
  eq(call.args[2], "/project/REFERENCE_SCREENS.json", "набор экранов из корня сборки");
  eq(call.args[3], "--receiver-id", "цель объявлена явно");
  eq(call.args[4], "receiver-a", "передан id показанного Receiver");
  eq(call.args.length, 5, "лишних аргументов нет");

  call.child.emit("exit", 0, null);
  var outcome = await running;
  eq(outcome.code, "OK", "сверка завершилась успешно");
  ok(harness.text().indexOf("Сверка экранов выполнена") >= 0, "пользователь видит итог сверки");
  await harness.launcher.shutdown("test");
}

async function testProbeWithoutReceiver() {
  var harness = createHarness({ bridgeAlreadyRunning: true,
    status: { ready: false, receiverId: null, documentName: null, protocolVersion: 2 } });
  await harness.launcher.start();
  var outcome = await harness.launcher.submit("probe");
  eq(outcome.code, "NO_RECEIVER", "без Receiver опыты не начинаются");
  eq(harness.migrationSpawns().length, 0, "процесс опытов не запущен");
  ok(harness.text().indexOf("Опыты не начаты") >= 0, "причина названа");
  await harness.launcher.shutdown("test");
}

async function testFailedMigration() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();
  var running = harness.launcher.submit(posixEscape(pixFile));
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn Direct PIX");
  harness.migrationSpawns()[0].child.emit("exit", 1, null);
  var outcome = await running;

  eq(outcome.code, "FAILED", "ненулевой код завершения — неудача");
  eq(harness.launcher.state(), "IDLE_READY", "prompt снова доступен и после ошибки");
  ok(harness.text().indexOf("не завершена") >= 0, "показана неудача именно этого файла");
  ok(harness.text().indexOf("частичный импорт") >= 0, "предупреждение о частичном импорте показано");
  ok(harness.text().indexOf("retry не выполнялся") >= 0, "сказано, что автоповтора не было");
  eq(harness.migrationSpawns().length, 1, "автоматический retry не запускается");
  ok(harness.events.some(function (e) { return e.event === "launcher.migrationFailed"; }), "неудача записана в диагностику");

  await harness.launcher.shutdown("test");
}

async function testNoReceiver() {
  var harness = createHarness({
    bridgeAlreadyRunning: true,
    status: { ready: false, receiverId: null, documentName: null, protocolVersion: 2 },
  });
  await harness.launcher.start();
  eq(harness.launcher.state(), "IDLE_NO_RECEIVER", "без Receiver launcher в IDLE_NO_RECEIVER");

  var outcome = await harness.launcher.submit(posixEscape(pixFile));
  eq(outcome.code, "NO_RECEIVER", "без Receiver файл не принимается");
  eq(harness.migrationSpawns().length, 0, "migration не запускается");
  ok(harness.text().indexOf("не поставлен в очередь") >= 0, "сказано, что очереди нет");
  // Путь не сохранён, поэтому пустой Enter ничего не запустит: подсказка
  // обязана просить именно передать файл заново.
  ok(harness.text().indexOf("Перетащите файл заново и нажмите Enter.") >= 0,
    "подсказка просит перетащить файл заново");
  ok(harness.text().indexOf("Enter ещё раз") < 0,
    "подсказка не предлагает бесполезный повторный Enter");

  // Включение Receiver не должно ничего запускать само: скрытого pending нет.
  harness.status = { ready: true, receiverId: "receiver-later", documentName: "Позже — Figma", protocolVersion: 2 };
  await harness.launcher.refreshStatus(false);
  await sleep(30);
  eq(harness.migrationSpawns().length, 0, "появившийся Receiver не запускает отложенный файл");
  eq(harness.launcher.state(), "IDLE_READY", "launcher просто снова готов");

  await harness.launcher.shutdown("test");
}

async function testReceiverChangedBeforeSpawn() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();
  eq(harness.launcher.announcedReceiverId(), "receiver-a", "показан Receiver A");

  // Между показом назначения и Enter активным стал другой документ.
  harness.status = { ready: true, receiverId: "receiver-b", documentName: "Другой — Figma", protocolVersion: 2 };
  var outcome = await harness.launcher.submit(posixEscape(pixFile));
  eq(outcome.code, "RECEIVER_CHANGED", "несовпадение id не начинает migration");
  eq(harness.migrationSpawns().length, 0, "процесс Direct PIX не запускался");
  ok(harness.text().indexOf("Назначение изменилось") >= 0, "новая цель показана пользователю");
  eq(harness.launcher.announcedReceiverId(), "receiver-b", "показанной целью стала новая");
  // Путь отброшен и здесь: скрытой очереди нет ни в одной из двух веток.
  ok(harness.text().indexOf("не поставлен в очередь") >= 0, "сказано, что файл не сохранён");
  ok(harness.text().indexOf("Перетащите файл заново и нажмите Enter.") >= 0,
    "и здесь подсказка просит перетащить файл заново");
  ok(harness.text().indexOf("Enter ещё раз") < 0,
    "подсказка не называет повторную передачу пути «повторным Enter»");

  // Файл перетащен заново — уже с подтверждённой новой целью.
  var running = harness.launcher.submit(posixEscape(pixFile));
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn Direct PIX");
  eq(harness.migrationSpawns()[0].args[4], "receiver-b", "id перепроверен и закреплён непосредственно перед spawn");
  harness.migrationSpawns()[0].child.emit("exit", 0, null);
  await running;

  await harness.launcher.shutdown("test");
}

async function testRejectedInput() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();

  eq((await harness.launcher.submit("")).code, "EMPTY", "пустая строка ничего не запускает");
  eq((await harness.launcher.submit(posixEscape(pixFile) + " " + posixEscape(jsonFile))).code, "ONE_FILE_ONLY",
    "два перетащенных файла отклонены");
  eq((await harness.launcher.submit(posixEscape(jsonFile))).code, "NOT_PIX", "не .pix отклонён");
  eq((await harness.launcher.submit(posixEscape(subDir))).code, "NOT_A_FILE", "каталог отклонён");
  eq((await harness.launcher.submit(posixEscape(path.join(tmpDir, "нет.pix")))).code, "NOT_FOUND",
    "несуществующий файл отклонён");
  eq(harness.migrationSpawns().length, 0, "ни один отказ не запустил Direct PIX");

  // Имя файла с shell-метасимволами — валидное имя, но не команда.
  var running = harness.launcher.submit(posixEscape(weirdFile));
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn Direct PIX");
  var call = harness.migrationSpawns()[0];
  eq(call.args[1], weirdFile, "метасимволы доехали как часть имени файла");
  eq(call.options.shell, false, "и не могли быть выполнены: оболочки нет");
  call.child.emit("exit", 0, null);
  await running;

  await harness.launcher.shutdown("test");
}

async function testShutdownDuringMigration() {
  var harness = createHarness({ bridgeAlreadyRunning: false });
  await harness.launcher.start();
  var running = harness.launcher.submit(posixEscape(pixFile));
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn Direct PIX");

  await harness.launcher.shutdown("SIGINT");
  await running;
  eq(harness.launcher.state(), "STOPPED", "launcher остановлен во время migration");
  assert.deepStrictEqual(harness.migrationSpawns()[0].child.killSignals, ["SIGTERM"],
    "дочерний Direct PIX не остаётся detached");
  checks += 1;
  ok(harness.text().indexOf("частичный импорт") >= 0, "о возможном частичном импорте предупреждено");
  assert.deepStrictEqual(harness.bridgeSpawns()[0].child.killSignals, ["SIGTERM"],
    "свой bridge остановлен вместе с launcher");
  checks += 1;
  eq(harness.migrationSpawns().length, 1, "после остановки ничего не стартует");
}

// ---------------------------------------------------------------------------
// 5. Приглашение показывается только там, где ввод принимается
// ---------------------------------------------------------------------------

function testPromptPolicy() {
  eq(Terminal.shouldShowPrompt("IDLE_READY"), true, "в IDLE_READY приглашение показывается");
  eq(Terminal.shouldShowPrompt("IDLE_NO_RECEIVER"), true, "в IDLE_NO_RECEIVER — тоже: ввод принимается");
  eq(Terminal.shouldShowPrompt("BUSY"), false, "во время migration приглашения нет");
  eq(Terminal.shouldShowPrompt("STARTING"), false, "до старта приглашения нет");
  eq(Terminal.shouldShowPrompt("SHUTTING_DOWN"), false, "при завершении приглашения нет");
  eq(Terminal.shouldShowPrompt("STOPPED"), false, "после остановки приглашения нет");
  eq(Terminal.shouldShowPrompt("IDLE_READY", { code: "BUSY_REJECTED", silent: true }), false,
    "строку забрал параллельный submit: приглашение рисует он");
}

/**
 * Последовательность, ради которой prompt и вынесен в отдельное решение:
 * первая migration идёт → второй Enter отклонён → приглашения нет → первая
 * migration завершилась → приглашение появилось ровно один раз.
 */
async function testPromptSequenceDuringMigration() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  await harness.launcher.start();

  var prompts = 0;
  var hidden = 0;
  var handleLine = Terminal.createLineHandler(harness.launcher, {
    showPrompt: function () { prompts += 1; },
    hidePrompt: function () { hidden += 1; },
  });

  var first = handleLine(posixEscape(pixFile));
  await waitFor(function () { return harness.migrationSpawns().length === 1; }, "spawn Direct PIX");
  eq(harness.launcher.state(), "BUSY", "первая migration идёт");
  eq(prompts, 0, "пока migration не закончилась, приглашения не было");

  var second = await handleLine(posixEscape(pixFile));
  eq(second.code, "BUSY_REJECTED", "второй Enter во время migration отклонён");
  ok(harness.text().indexOf("Migration уже выполняется") >= 0, "отказ объяснён сообщением");
  eq(prompts, 0, "после BUSY_REJECTED приглашение не показано");
  eq(harness.launcher.state(), "BUSY", "первая migration продолжается");
  eq(harness.migrationSpawns().length, 1, "второй путь не создал ни процесса, ни очереди");

  harness.migrationSpawns()[0].child.emit("exit", 0, null);
  await first;
  eq(harness.launcher.state(), "IDLE_READY", "первая migration завершилась");
  eq(prompts, 1, "после её завершения приглашение показано ровно один раз");

  // Пустая строка в idle — приглашение возвращается, и снова ровно одно.
  await handleLine("");
  eq(prompts, 2, "в idle каждая строка возвращает приглашение");

  await harness.launcher.shutdown("test");
  await handleLine(posixEscape(pixFile));
  eq(prompts, 2, "после остановки launcher приглашение не рисуется");
}

// ---------------------------------------------------------------------------
// 6. Закрытие launcher во время migration на ПЕРЕИСПОЛЬЗУЕМОМ bridge
// ---------------------------------------------------------------------------

/**
 * Регрессия. Раньше SIGTERM убивал Direct PIX, а job на чужом bridge
 * оставалась `running` навсегда: она держала ACK-таймер, блокировала
 * следующий Receiver (`RECEIVER_SWITCH_BLOCKED`) и следующую job
 * (`JOB_BUSY`). Лечилось только перезапуском bridge.
 *
 * Здесь bridge настоящий и запущен ДО launcher — launcher обязан его пережить,
 * но свою job снять. Дочерний Direct PIX подменён: он делает ровно то же, что
 * настоящий (создаёт job своим producer token из окружения и сообщает её id
 * по IPC), но ничего не импортирует.
 */
async function testReusedBridgeSurvivesShutdownWithoutHungJob() {
  BridgeServer.resetForTests();
  var server = BridgeServer.createServer();
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  var base = "http://127.0.0.1:" + server.address().port;
  var client = BridgeClient.createClient({ bridge: base });

  try {
    var firstHello = await httpCall(base, "POST", "/receiver/hello", {
      receiverVersion: "0.1.0",
      protocolVersion: BridgeServer.PROTOCOL_VERSION,
      documentName: "Целевой — Figma",
    });
    eq(firstHello.status, 200, "Receiver подключился к уже работающему bridge");
    var receiverOne = firstHello.body.receiverId;

    var spawns = [];
    var output = [];
    var childToken = null;
    var createdJobId = null;
    var pendingProducer = null;

    var launcher = Terminal.createLauncher({
      bridgeUrl: base,
      platform: "darwin",
      lockPath: path.join(tmpDir, "lock-reused-bridge.lock"),
      isProcessAlive: function () { return true; },
      execPath: "/fake/node",
      cliPath: "/project/DirectPix/Cli.js",
      bridgeServerPath: "/project/Bridge/Server.js",
      projectDir: "/project",
      statSync: fs.statSync,
      exitGraceMs: 200,
      pollMs: 3600000,
      write: function (text) { output.push(String(text)); },
      spawn: function (file, args, opts) {
        var child = fakeChild();
        spawns.push({ file: file, args: args, options: opts, child: child });
        childToken = opts.env.PIXSO2FIGMA_PRODUCER_TOKEN;
        // Поведение настоящего Direct PIX до первого ACK: job создана, задача
        // выдана приёмнику, продюсер висит на её ожидании.
        (async function () {
          var created = await httpCall(base, "POST", "/jobs", {
            protocolVersion: BridgeServer.PROTOCOL_VERSION,
            expectedReceiverId: receiverOne,
            producerToken: childToken,
            source: { sourceMode: "DIRECT_PIX", fileName: "design.pix" },
          });
          createdJobId = created.body.jobId;
          await httpCall(base, "POST", "/jobs/" + createdJobId + "/task", {
            taskId: "direct-1", type: "DIRECT_PIX_START", payload: {},
          });
          await httpCall(base, "GET",
            "/receiver/task?receiverId=" + encodeURIComponent(receiverOne));
          // Ждущий ACK продюсер: abort обязан разбудить и его.
          pendingProducer = httpCall(base, "GET",
            "/jobs/" + createdJobId + "/task/direct-1?wait=25");
          child.emit("message", { type: "pixso2figma.job", jobId: createdJobId });
        })();
        return child;
      },
      probeHealth: function () { return client.health(); },
      readStatus: async function () {
        var response = await client.status();
        if (response.status !== 200 || !response.body) throw new Error("Bridge не отвечает");
        return response.body;
      },
      abortJob: function (jobId, token, reason) { return client.abortJob(jobId, token, reason); },
    });

    var started = await launcher.start();
    eq(started.ok, true, "launcher поднялся на уже работающем bridge");
    eq(launcher.ownsBridge(), false, "bridge переиспользован, а не запущен launcher-ом");

    var running = launcher.submit(posixEscape(pixFile));
    await waitFor(function () { return launcher.activeJobId() !== null; }, "id job по IPC от потомка");
    eq(launcher.activeJobId(), createdJobId, "launcher знает id ИМЕННО своей job");
    eq(BridgeServer.state.job.status, "running", "на bridge идёт job");
    eq(BridgeServer.state.current.status, "delivered", "task выдан приёмнику");
    ok(BridgeServer.state.current.ackTimer, "ACK-таймер взведён");

    // Закрытие окна Terminal: SIGTERM всему, что launcher запустил.
    await launcher.shutdown("SIGTERM");
    await running;
    eq(launcher.state(), "STOPPED", "launcher остановлен");
    assert.deepStrictEqual(spawns[0].child.killSignals, ["SIGTERM"], "потомок Direct PIX остановлен");
    checks += 1;

    // 1. Переиспользуемый bridge жив.
    var health = await httpCall(base, "GET", "/health");
    eq(health.status, 200, "переиспользуемый bridge пережил launcher");
    ok(output.join("\n").indexOf("Bridge оставлен работать") >= 0,
      "launcher сказал, что чужой bridge не трогал");

    // 2. Старая job больше не running.
    var aborted = await httpCall(base, "GET", "/jobs/" + createdJobId + "/state");
    eq(aborted.body.job.status, "aborted", "job переведена в aborted");
    eq(aborted.body.job.currentTaskId, null, "task освобождён");
    eq(BridgeServer.state.current, null, "очередь bridge пуста");

    // 3. Ждущий ACK продюсер разбужен, а не забыт.
    var woken = await pendingProducer;
    eq(woken.body.status, "error", "ожидающий long-poll продюсера разбужен отказом");
    eq(woken.body.error.code, "JOB_ABORTED", "и видит причину");

    // 4. Идемпотентность: повторное снятие ничего не меняет.
    var again = await client.abortJob(createdJobId, childToken, "repeat");
    eq(again.status, 200, "повторный abort принят");
    eq(again.body.alreadyClosed, true, "и признан уже закрытым");
    await launcher.shutdown("SIGTERM");
    eq(launcher.state(), "STOPPED", "повторный shutdown идемпотентен");

    // 5. Следующий Receiver и следующая job стартуют без перезапуска bridge.
    var secondHello = await httpCall(base, "POST", "/receiver/hello", {
      receiverVersion: "0.1.0",
      protocolVersion: BridgeServer.PROTOCOL_VERSION,
      documentName: "Следующий — Figma",
    });
    eq(secondHello.status, 200, "следующий Receiver включается без перезапуска bridge");
    var receiverTwo = secondHello.body.receiverId;
    ok(receiverTwo !== receiverOne, "у него собственный lease");

    var nextJob = await httpCall(base, "POST", "/jobs", {
      protocolVersion: BridgeServer.PROTOCOL_VERSION,
      expectedReceiverId: receiverTwo,
      source: { sourceMode: "DIRECT_PIX", fileName: "next.pix" },
    });
    eq(nextJob.status, 201, "следующая job создаётся на том же bridge");

    // 6. Чужую и параллельную job старым токеном закрыть нельзя.
    var foreign = await client.abortJob(nextJob.body.jobId, childToken, "wrong-owner");
    eq(foreign.status, 403, "чужая job старым producer token не снимается");
    eq(BridgeServer.state.job.status, "running", "и остаётся running");
    await httpCall(base, "POST", "/jobs/" + nextJob.body.jobId + "/finish", { status: "done" });
  } finally {
    BridgeServer.resetForTests();
    await new Promise(function (resolve) { server.close(resolve); });
  }
}

// ---------------------------------------------------------------------------
// 7. Одно окно на один bridge
// ---------------------------------------------------------------------------

/**
 * Два окна launcher — это поломанная модель, а не «ещё одна копия»: оба
 * показывают один и тот же Receiver и оба принимают файлы, хотя bridge держит
 * ровно одну job. Выигрывает ПОСЛЕДНЕЕ открытое окно: пользователь запускает
 * команду повторно именно потому, что не заметил прежнего окна, и отказ
 * оставил бы на экране два окна вместо одного.
 */
async function testNewWindowClosesOldOne() {
  var lockPath = path.join(tmpDir, "takeover.lock");
  try { fs.unlinkSync(lockPath); } catch (_e) { /* первого запуска ещё не было */ }

  var first = createHarness({ bridgeAlreadyRunning: true, lockPath: lockPath, pid: 4242 });
  var started = await first.launcher.start();
  eq(started.ok, true, "первое окно стартует");
  eq(first.launcher.holdsLock(), true, "и держит блокировку");
  eq(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 4242, "в замке записан pid владельца");

  // Второе окно: владелец жив, поэтому его закрывают сигналом.
  var signals = [];
  var firstAlive = true;
  var second = createHarness({
    bridgeAlreadyRunning: true,
    lockPath: lockPath,
    pid: 4243,
    takeoverGraceMs: 2000,
    lockPollMs: 5,
    isProcessAlive: function (pid) { return pid === 4242 ? firstAlive : true; },
    killProcess: function (pid, signal) {
      signals.push({ pid: pid, signal: signal });
      // Настоящее окно на SIGTERM проходит свой обычный путь завершения.
      if (signal === "SIGTERM") {
        first.launcher.shutdown("SIGTERM").then(function () { firstAlive = false; });
      }
    },
  });

  var takeover = await second.launcher.start();
  eq(takeover.ok, true, "новое окно стартует");
  eq(takeover.tookOver, true, "и делает это через вытеснение старого");
  eq(takeover.forced, false, "старое окно закрылось само, добивать не пришлось");
  assert.deepStrictEqual(signals, [{ pid: 4242, signal: "SIGTERM" }],
    "старому окну послан ровно один SIGTERM и ничего больше");
  checks += 1;
  eq(first.launcher.state(), "STOPPED", "старое окно действительно закрылось");
  eq(first.launcher.holdsLock(), false, "и отдало замок");
  eq(second.launcher.holdsLock(), true, "замок перешёл новому окну");
  eq(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 4243, "владельцем записано новое окно");
  ok(second.text().indexOf("Закрываю его…") >= 0, "пользователю сказано, что старое окно закрывается");
  ok(second.text().indexOf("Старое окно закрыто.") >= 0, "и что оно закрылось");
  ok(second.text().indexOf("Перетащите сюда один .pix") >= 0, "новое окно готово к работе");

  await second.launcher.shutdown("test");
  eq(fs.existsSync(lockPath), false, "последнее окно снимает замок за собой");
}

/**
 * Старое окно переносит дизайн. Многоминутную чужую работу нельзя оборвать
 * молча: новое окно обязано спросить, и «ничего не делать» — ответ по
 * умолчанию.
 */
async function testBusyOwnerIsNotInterruptedSilently() {
  var lockPath = path.join(tmpDir, "busy-owner.lock");
  try { fs.unlinkSync(lockPath); } catch (_e) { /* первого запуска ещё не было */ }

  var first = createHarness({ bridgeAlreadyRunning: true, lockPath: lockPath, pid: 6001 });
  await first.launcher.start();
  var migration = first.launcher.submit(posixEscape(pixFile));
  await waitFor(function () { return first.migrationSpawns().length === 1; }, "spawn Direct PIX");
  eq(JSON.parse(fs.readFileSync(lockPath, "utf8")).busy, "design.pix",
    "в замке видно, какой файл переносится прямо сейчас");

  // 1. Отказ: чужой перенос продолжается, сигналов никто не шлёт.
  var asked = [];
  var signals = [];
  var declining = createHarness({
    bridgeAlreadyRunning: true,
    lockPath: lockPath,
    pid: 6002,
    isProcessAlive: function () { return true; },
    killProcess: function (pid, signal) { signals.push(signal); },
    confirmTakeover: function (info) { asked.push(info); return Promise.resolve(false); },
  });
  var declined = await declining.launcher.start();
  eq(declined.ok, false, "новое окно не стартует без разрешения");
  eq(declined.code, "OWNER_BUSY_DECLINED", "и называет причину");
  eq(asked.length, 1, "вопрос задан ровно один раз");
  eq(asked[0].busy, "design.pix", "в вопросе назван переносимый файл");
  eq(signals.length, 0, "старому окну не послано ни одного сигнала");
  eq(first.launcher.state(), "BUSY", "перенос в старом окне продолжается");
  ok(declining.text().indexOf("Это окно закрывается") >= 0, "лишнее окно закрывается само");

  // 2. Согласие: перенос прерывается, и новое окно говорит об этом вслух.
  var firstAlive = true;
  var accepting = createHarness({
    bridgeAlreadyRunning: true,
    lockPath: lockPath,
    pid: 6003,
    takeoverGraceMs: 2000,
    isProcessAlive: function (pid) { return pid === 6001 ? firstAlive : true; },
    killProcess: function (pid, signal) {
      if (signal === "SIGTERM") first.launcher.shutdown("SIGTERM").then(function () { firstAlive = false; });
    },
    confirmTakeover: function () { return Promise.resolve(true); },
  });
  var accepted = await accepting.launcher.start();
  await migration;
  eq(accepted.ok, true, "с разрешения новое окно стартует");
  eq(accepted.interrupted, "design.pix", "оно знает, какой перенос оборвало");
  ok(accepting.text().indexOf("Перенос «design.pix» в том окне прерван") >= 0,
    "новое окно предупреждает вместо закрытого старого");
  ok(accepting.text().indexOf("частичный импорт") >= 0, "и про возможный частичный импорт тоже");
  eq(first.launcher.state(), "STOPPED", "старое окно закрылось");

  await accepting.launcher.shutdown("test");
}

/**
 * Регрессия. Закрытие занятого окна законно долгое: снять job с bridge,
 * погасить свой bridge. Раньше новое окно считало дедлайн от момента сигнала
 * и добивало старое SIGKILL прямо посреди этой работы — bridge оставался
 * сиротой, а его job навсегда висела `running`.
 */
async function testSlowButLiveShutdownIsNotKilled() {
  var lockPath = path.join(tmpDir, "slow-shutdown.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 7001, bridge: "http://localhost:8787", busy: null,
    heartbeatAt: new Date().toISOString(),
  }));

  // Владелец закрывается дольше дедлайна, но исправно отмечается в замке.
  var alive = true;
  var beats = 0;
  var signals = [];
  var beating = setInterval(function () {
    if (!alive) return;
    beats += 1;
    var record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    record.heartbeatAt = new Date(Date.now() + beats).toISOString();
    fs.writeFileSync(lockPath + ".tmp", JSON.stringify(record));
    fs.renameSync(lockPath + ".tmp", lockPath);
    // Закрывается втрое дольше дедлайна и только потом отпускает замок.
    if (beats >= 12) {
      alive = false;
      clearInterval(beating);
      try { fs.unlinkSync(lockPath); } catch (_e) { /* уже снят */ }
    }
  }, 10);

  var harness = createHarness({
    bridgeAlreadyRunning: true,
    lockPath: lockPath,
    pid: 7002,
    takeoverGraceMs: 40,
    lockPollMs: 5,
    isProcessAlive: function (pid) { return pid === 7001 ? alive : true; },
    killProcess: function (pid, signal) { signals.push(signal); },
  });
  var started = await harness.launcher.start();
  clearInterval(beating);

  eq(started.ok, true, "новое окно дождалось честно закрывающегося старого");
  eq(started.forced, false, "и не добивало его");
  assert.deepStrictEqual(signals, ["SIGTERM"], "послан ровно один SIGTERM, без SIGKILL");
  checks += 1;
  ok(beats >= 5, "старое окно закрывалось заметно дольше дедлайна (тактов: " + beats + ")");
  await harness.launcher.shutdown("test");
}

/** Старое окно зависло и не отвечает на SIGTERM: пользователь просил одно окно. */
async function testStuckOldWindowIsForced() {
  var lockPath = path.join(tmpDir, "takeover-stuck.lock");
  // Зависшее окно не отмечается в замке вовсе: heartbeat остаётся прежним.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 7777, bridge: "http://localhost:8787", busy: null,
    heartbeatAt: new Date().toISOString(),
  }));

  var signals = [];
  var stuckAlive = true;
  var harness = createHarness({
    bridgeAlreadyRunning: true,
    lockPath: lockPath,
    pid: 8888,
    takeoverGraceMs: 40,
    lockPollMs: 5,
    isProcessAlive: function (pid) { return pid === 7777 ? stuckAlive : true; },
    killProcess: function (pid, signal) {
      signals.push(signal);
      // На SIGTERM не реагирует вовсе; SIGKILL не игнорируется никем.
      if (signal === "SIGKILL") stuckAlive = false;
    },
  });

  var takeover = await harness.launcher.start();
  eq(takeover.ok, true, "зависшее окно не мешает открыть новое");
  eq(takeover.forced, true, "и было остановлено принудительно");
  assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"], "сначала мягко, и только потом жёстко");
  checks += 1;
  ok(harness.text().indexOf("не отвечает — останавливаю принудительно") >= 0,
    "пользователь видит, что окно именно зависло");
  eq(harness.launcher.holdsLock(), true, "замок забран");
  await harness.launcher.shutdown("test");
}

/**
 * Окно убили `SIGKILL`: замок остался, владельца нет. Блокировать следующий
 * запуск навсегда он не имеет права — и сигналов никому слать не нужно.
 */
async function testStaleLockIsTakenOver() {
  var lockPath = path.join(tmpDir, "stale.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, bridge: "http://localhost:8787" }));

  var signals = [];
  var harness = createHarness({
    bridgeAlreadyRunning: true,
    lockPath: lockPath,
    pid: 5151,
    isProcessAlive: function (pid) { return pid === 5151; },
    killProcess: function (pid, signal) { signals.push(signal); },
  });
  var started = await harness.launcher.start();
  eq(started.ok, true, "осиротевший замок не блокирует запуск");
  eq(started.tookOver, false, "мёртвого владельца никто не вытесняет");
  eq(signals.length, 0, "и сигналов ему не шлют");
  eq(harness.launcher.holdsLock(), true, "новое окно забрало замок");
  eq(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 5151, "владельцем записан живой процесс");
  await harness.launcher.shutdown("test");
  eq(fs.existsSync(lockPath), false, "и снят за собой");
}

function testLockPathIsPerBridge() {
  var one = Terminal.lockPathFor("http://localhost:8787");
  var two = Terminal.lockPathFor("http://localhost:9000");
  ok(one !== two, "у другого адреса bridge собственный замок");
  eq(one, Terminal.lockPathFor("http://localhost:8787"), "для одного адреса путь стабилен");
  ok(one.indexOf("pixso2figma-launcher-") >= 0, "имя замка узнаваемо");
  eq(Terminal.processAlive(process.pid), true, "текущий процесс считается живым");
  eq(Terminal.processAlive(0), false, "нулевой pid владельцем не считается");
  eq(Terminal.EXIT_LOCK_BUSY, 3, "код выхода «старое окно не закрылось» известен обёрткам");
}

async function testStateMachine() {
  var harness = createHarness({ bridgeAlreadyRunning: true });
  eq(harness.launcher.state(), "STARTING", "launcher начинает со STARTING");
  await harness.launcher.start();
  await harness.launcher.shutdown("test");
  eq(harness.launcher.state(), "STOPPED", "после shutdown состояние STOPPED");
  var afterStop = await harness.launcher.submit(posixEscape(pixFile));
  eq(afterStop.code, "STOPPED", "остановленный launcher файлы не принимает");
  eq(harness.migrationSpawns().length, 0, "и ничего не запускает");
  assert.deepStrictEqual(Terminal.TRANSITIONS.BUSY.indexOf("BUSY"), -1, "BUSY -> BUSY запрещён схемой");
  checks += 1;
}

async function main() {
  testParsing();
  testFileValidation();
  await testReusedBridge();
  await testOwnedBridge();
  await testIncompatibleBridge();
  await testHappyPath();
  await testProbeCommand();
  await testCheckCommand();
  await testProbeWithoutReceiver();
  await testFailedMigration();
  await testNoReceiver();
  await testReceiverChangedBeforeSpawn();
  await testRejectedInput();
  await testShutdownDuringMigration();
  testPromptPolicy();
  await testPromptSequenceDuringMigration();
  await testReusedBridgeSurvivesShutdownWithoutHungJob();
  testLockPathIsPerBridge();
  await testNewWindowClosesOldOne();
  await testBusyOwnerIsNotInterruptedSilently();
  await testSlowButLiveShutdownIsNotKilled();
  await testStuckOldWindowIsForced();
  await testStaleLockIsTakenOver();
  await testStateMachine();
  cleanup();
  process.stdout.write("TerminalLauncherTest: OK, проверок — " + checks + "\n");
}

main().catch(function (error) {
  cleanup();
  process.stderr.write("TerminalLauncherTest: FAIL\n" + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
