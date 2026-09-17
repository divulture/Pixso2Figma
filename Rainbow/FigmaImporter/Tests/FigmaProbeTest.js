/**
 * Лаборатория живой Figma (DIRECT_PIX_PROBE) на headless-двойнике.
 *
 *   node FigmaImporter/Tests/FigmaProbeTest.js
 *
 * Тест НЕ проверяет вердикты: их смысл — в живой Figma, и двойник в ряде
 * опытов может отвечать иначе. Проверяется
 * контракт: опыты выполняются без ошибок API, у каждого четыре чтения и
 * вердикт, прошлая страница опытов заменяется, документ не трогается, а CLI
 * пишет карту возможностей из ответа Receiver.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var FigmaHost = require("../../DirectPix/FigmaHost");
var FigmaProbe = require("../../DirectPix/FigmaProbe");
var FigmaCapabilities = require("../../DirectPix/FigmaCapabilities");
var Cli = require("../../DirectPix/Cli");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
var receiver = host.receiver;
var PROTOCOL = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };

function probeTask(extra) {
  return receiver.handleDirectTask({
    jobId: "probe", taskId: "probe-1", type: "DIRECT_PIX_PROBE",
    payload: Object.assign({}, PROTOCOL, extra || {}),
  }, {});
}

function probePages() {
  return host.pages().filter(function (page) {
    return !page.removed && page.getPluginData && page.getPluginData("pixso2figmaRole") === "figma-probe";
  });
}

async function run() {
  var userPage = host.pages()[0];
  var userChildrenBefore = userPage.children.length;

  var result = await probeTask();
  eq(result.ok, true, "опыты выполнены");
  eq(result.experiments.length, receiver.PROBE_EXPERIMENTS.length, "выполнен каждый опыт каталога");
  result.experiments.forEach(function (item) {
    ok(item.verdict !== "ERROR", item.id + ": опыт выполнился без ошибки API (" + (item.error || "") + ")");
    ok(item.reads && item.reads.immediate && item.reads.afterTick && item.reads.clone && item.reads.recompute,
      item.id + ": есть все четыре чтения");
    ok(FigmaProbe.VERDICT_TEXT[item.verdict], item.id + ": вердикт из известного списка");
    ok(item.master && item.before, item.id + ": записаны мастер и состояние до действия");
  });
  eq(probePages().length, 1, "опыты живут на одной служебной странице");
  eq(userPage.children.length, userChildrenBefore, "страница пользователя не тронута");

  var again = await probeTask({ experiments: ["nested-frame-resize", "fixed-root-fill-child"] });
  eq(again.experiments.length, 2, "можно выполнить только выбранные опыты");
  eq(probePages().length, 1, "повторный прогон заменяет страницу опытов, а не плодит новые");

  var bad = await probeTask({ experiments: ["no-such-experiment"] });
  eq(bad.experiments.length, 0, "неизвестный опыт просто не выполняется");

  // --- CLI: транспорт подменён, Receiver — тот же двойник --------------------
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-figma-probe-"));
  try {
    var calls = [];
    var client = {
      ensureReceiver: function () {
        calls.push("ensureReceiver");
        return Promise.resolve({ receiverId: "r1", receiverVersion: "0.1.0", documentName: "Probe doc" });
      },
      start: function () { calls.push("start"); return Promise.resolve("job-1"); },
      jobId: function () { return "job-1"; },
      sendTask: function (type, payload) {
        calls.push(type);
        return receiver.handleDirectTask({ jobId: "job-1", taskId: "t", type: type, payload: payload }, {});
      },
      finish: function (status) { calls.push("finish:" + status); return Promise.resolve(); },
    };
    var report = path.join(temp, "FIGMA_CAPABILITIES.md");
    var raw = path.join(temp, "probe.json");
    var verdictsFile = path.join(temp, "FigmaVerdicts.json");
    var originalWrite = process.stdout.write;
    process.stdout.write = function () { return true; };
    var code;
    try {
      code = await Cli.runProbeCommand({
        client: client, probeReport: report, probeVerdicts: verdictsFile, out: raw,
        probeOnly: ["nested-rect-resize"], receiverId: null,
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    eq(code, 0, "CLI завершает опыты успешно");
    assert.deepStrictEqual(calls, ["ensureReceiver", "ensureReceiver", "start", "DIRECT_PIX_PROBE", "finish:done"],
      "порядок транспорта: проверка Receiver, job, задача опытов, закрытие job");
    checks += 1;
    var markdown = fs.readFileSync(report, "utf8");
    ok(markdown.indexOf("# Карта возможностей живой Figma") === 0, "карта записана в md");
    ok(markdown.indexOf("`nested-rect-resize`") >= 0, "в карте есть выполненный опыт");
    ok(markdown.indexOf("Probe doc") >= 0, "в карте указан документ Figma");
    ok(JSON.parse(fs.readFileSync(raw, "utf8")).experiments.length === 1, "сырые замеры записаны в json");
    var written = FigmaCapabilities.readVerdicts(verdictsFile);
    eq(Object.keys(written).join(","), "nested-rect-resize", "вердикты для кода записаны вместе с картой");
    eq(written["nested-rect-resize"], FigmaCapabilities.parseVerdicts(markdown)["nested-rect-resize"],
      "вердикт в файле для кода совпадает с картой");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log("OK: лаборатория живой Figma — " + checks + " проверок пройдено");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
