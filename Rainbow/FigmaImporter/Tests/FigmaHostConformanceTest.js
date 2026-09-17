/**
 * Соответствие headless-двойника живой Figma.
 *
 *   node FigmaImporter/Tests/FigmaHostConformanceTest.js
 *
 * `DirectPix/FigmaVerdicts.json` — вердикты опытов, снятых командой `probe` в
 * настоящей Figma. Двойник (`DirectPix/FigmaHost.js`) обязан на тех же опытах давать те же
 * вердикты: иначе тесты приёмника «доказывают» поведение, которого у Figma
 * нет. Если Figma изменилась, сначала
 * перезапускается `probe`, затем правится двойник — не наоборот.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var FigmaHost = require("../../DirectPix/FigmaHost");
var FigmaCapabilities = require("../../DirectPix/FigmaCapabilities");

var checks = 0;

async function run() {
  assert.ok(fs.existsSync(FigmaCapabilities.VERDICTS_FILE),
    "нет DirectPix/FigmaVerdicts.json: сначала выполните probe в живой Figma");
  var live = FigmaCapabilities.readVerdicts(FigmaCapabilities.VERDICTS_FILE);
  // ERROR в карте — опыт не выполнился в живой Figma, замера нет. Это белое
  // пятно, а не поведение, с которым двойник обязан совпасть.
  Object.keys(live).forEach(function (id) { if (live[id] === "ERROR") delete live[id]; });
  var liveIds = Object.keys(live);
  assert.ok(liveIds.length > 0, "в карте возможностей нет ни одного вердикта");
  checks += 1;

  var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
  var result = await host.receiver.handleDirectTask({
    jobId: "conformance", taskId: "conformance-1", type: "DIRECT_PIX_PROBE",
    payload: { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 },
  }, {});

  var byId = {};
  result.experiments.forEach(function (item) { byId[item.id] = item; });
  var mismatches = [];
  var removed = [];
  liveIds.forEach(function (id) {
    var item = byId[id];
    // Опыт убран из каталога или переименован: старый замер больше ничего не
    // доказывает. Это не расхождение с Figma, а повод перезапустить probe.
    if (!item) { removed.push(id); return; }
    if (item.verdict !== live[id]) {
      mismatches.push(id + ": живая Figma " + live[id] + ", двойник " + item.verdict +
        " " + JSON.stringify(item.reads || item.error));
    }
    checks += 1;
  });
  // Опыт, ещё не измеренный в живой Figma, — не расхождение, а белое пятно:
  // о нём предупреждаем, но тест не роняем, пока не выполнен probe.
  var unmeasured = result.experiments.filter(function (item) { return !live[item.id]; })
    .map(function (item) { return item.id + " (двойник: " + item.verdict + ")"; });
  assert.ok(!mismatches.length, "двойник расходится с живой Figma:\n  " + mismatches.join("\n  "));
  if (removed.length) {
    console.log("ВНИМАНИЕ: в карте есть опыты, которых нет в каталоге, перезапустите probe:\n  " +
      removed.join("\n  "));
  }
  if (unmeasured.length) {
    console.log("ВНИМАНИЕ: не измерено в живой Figma, выполните probe:\n  " + unmeasured.join("\n  "));
  }
  console.log("OK: двойник соответствует живой Figma — " + checks + " проверок пройдено");
}

run().catch(function (error) {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
