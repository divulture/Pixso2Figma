/**
 * Эталонные экраны: снимок по сохранённому состоянию и сверка с Pixso.
 *
 *   node FigmaImporter/Tests/ScreenCheckTest.js
 *
 * Прогоняется настоящий код приёмника на FigmaHost. Закрепляется:
 *
 *   — снимок FINISH с `verifyStoredState` читает содержимое вхождения с копии
 *     и ловит расхождение, которое чтение сразу после правок скрывает
 *     (форма Accordion: живое чтение 380, сохранённое состояние 600);
 *   — временные копии удаляются, документ не меняется;
 *   — эталон берёт размеры узлов и `sourceBoxes`, скрытое не сверяет;
 *   — сравнение двух отчётов называет новые и исправленные расхождения.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var FigmaHost = require("../../DirectPix/FigmaHost");
var ScreenCheck = require("../../DirectPix/ScreenCheck");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
var receiver = host.receiver;
var DIRECT = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };
var sequence = 0;

function task(type, payload) {
  sequence += 1;
  return receiver.handleDirectTask({
    jobId: "screen-check", taskId: "screen-check-" + sequence, type: "DIRECT_PIX_" + type,
    payload: Object.assign({}, DIRECT, payload || {}),
  }, { createPages: true });
}

function countNodes(node) {
  var total = 1;
  (node.children || []).forEach(function (child) { total += countNodes(child); });
  return total;
}

var definition = {
  definitionId: "70:10", componentKey: null, variantGroupId: null, name: "Accordion",
  nodes: [
    { id: "70:10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Accordion",
      x: 0, y: 0, width: 600, height: 36, definitionPath: [],
      autoLayout: { layoutMode: "VERTICAL", itemSpacing: 0,
        primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" } },
    { id: "70:11", parent: "70:10", kind: "ORDINARY", type: "FRAME", name: "Header",
      x: 0, y: 0, width: 600, height: 36, definitionPath: [0],
      autoLayout: { layoutMode: "HORIZONTAL", itemSpacing: 6,
        primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" },
      childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
    { id: "70:12", parent: "70:11", kind: "ORDINARY", type: "RECTANGLE", name: "Badge",
      x: 0, y: 0, width: 54, height: 36, definitionPath: [0, 0],
      childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } },
  ],
};

var headerStep = { index: 0, sourceId: "70:11", sourceType: "FRAME", targetType: "FRAME",
  definitionId: "70:10", definitionPath: [0], name: "Header" };
var badgeStep = { index: 0, sourceId: "70:12", sourceType: "RECTANGLE", targetType: "RECTANGLE",
  definitionId: "70:10", definitionPath: [0, 0], name: "Badge" };

// Экран: корень → экран → вхождение Accordion шириной 380 в форме Pixso
// (корень Hug, шапка снята со STRETCH) + скрытый прямоугольник.
var rootNodes = [
  { id: "71:1", parent: null, kind: "ORDINARY", type: "FRAME", name: "Page root",
    x: 0, y: 0, width: 1000, height: 400 },
  { id: "71:2", parent: "71:1", kind: "ORDINARY", type: "FRAME", name: "Screen",
    x: 0, y: 0, width: 800, height: 200 },
  { id: "71:3", parent: "71:2", kind: "INSTANCE", type: "INSTANCE", name: "Accordion",
    definitionId: "70:10", x: 0, y: 0, width: 380, height: 36,
    overrides: [
      { path: [], ops: { layout: { primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
        present: { layout: true } },
      { path: [headerStep], ops: { childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } },
        present: { childLayout: true } },
    ],
    sourceBoxes: [
      { path: [headerStep], width: 380, height: 36 },
      { path: [headerStep, badgeStep], width: 54, height: 36 },
    ] },
  { id: "71:4", parent: "71:2", kind: "ORDINARY", type: "RECTANGLE", name: "Hidden",
    x: 500, y: 0, width: 10, height: 10, visible: false },
  { id: "71:5", parent: "71:1", kind: "ORDINARY", type: "RECTANGLE", name: "Outside screen",
    x: 900, y: 0, width: 10, height: 10 },
];

async function run() {
  await task("START", { source: { fileName: "screen-check.pix" } });
  await task("PAGE", { pageId: "p71", pageName: "Screens" });
  await task("DEFINITIONS", { definitions: [definition] });
  await task("ROOT", { pageId: "p71", pageName: "Screens", rootId: "71:1", rootName: "Page root", nodes: rootNodes });

  var page = host.pages().filter(function (item) { return item.name === "Screens"; })[0];
  var nodesBefore = countNodes(page);

  var finish = await task("FINISH", { verifyTree: true, verifyStoredState: true });
  var verification = finish.treeVerification;
  ok(verification && verification.storedState, "снимок снят по сохранённому состоянию");
  eq(verification.clonesRead, 1, "содержимое вхождения прочитано с одной копии");
  eq(verification.cloneFailures, 0, "копия создана без ошибок");
  eq(countNodes(page), nodesBefore, "временные копии удалены, документ не изменился");
  ok(verification.tree.some(function (entry) { return entry.storedState; }),
    "слои вхождения помечены как прочитанные с копии");

  var config = ScreenCheck.validateConfig({
    file: "screen-check.pix", screens: [{ id: "71:2", root: "71:1", name: "Экран" }],
  });
  var ir = { roots: [{ rootId: "71:1", nodes: rootNodes }] };
  var report = ScreenCheck.buildReport(config, { "71:1": ir }, verification, { mode: "headless" });
  var screen = report.screens[0];
  eq(screen.error, null, "экран найден в IR");
  // Экран, вхождение, шапка и бейдж. Скрытый узел и узел вне экрана не сверяются.
  eq(screen.checked, 4, "сверены экран, вхождение и два вложенных слоя");
  ok(!screen.mismatches["71:4"] && !screen.mismatches["71:5"], "скрытое и чужое не сверяются");
  ok(screen.mismatches["71:3#0"], "шапка Accordion расходится с Pixso в сохранённом состоянии");
  eq(screen.mismatches["71:3#0"].dw, 220, "сохранённая ширина шапки — ширина мастера 600");
  eq(screen.mismatched, 1, "остальное совпало");
  ok(/71:3#0/.test(ScreenCheck.format(report)), "худшее расхождение напечатано");

  // Чтение сразу после правок (без копии) то же расхождение прячет.
  var live = await task("FINISH", { verifyTree: true });
  var liveReport = ScreenCheck.buildReport(config, { "71:1": ir }, live.treeVerification, { mode: "headless" });
  ok(!liveReport.screens[0].mismatches["71:3#0"],
    "без сохранённого состояния шапка читается закешированной 380 — поэтому сверка идёт по копии");

  var diff = ScreenCheck.compare(liveReport, report);
  eq(diff.screens[0].appeared.length, 1, "сравнение называет новое расхождение");
  eq(diff.screens[0].appeared[0].key, "71:3#0", "новое расхождение — шапка");
  eq(ScreenCheck.compare(report, liveReport).screens[0].fixed[0].key, "71:3#0",
    "в обратную сторону оно считается исправленным");

  var missing = ScreenCheck.buildReport(ScreenCheck.validateConfig({
    file: "x.pix", screens: [{ id: "99:1", root: "71:1" }],
  }), { "71:1": ir }, verification, { mode: "headless" });
  eq(missing.screens[0].error, "SCREEN_NOT_IN_ROOT", "экран вне корня назван, а не сверен молча");
  assert.throws(function () { ScreenCheck.validateConfig({ file: "x.pix", screens: [{ id: "1:1" }] }); });
  checks += 1;

  // Узлы разворота вхождения: эталон — только размер из снимка Pixso.
  var expansion = ScreenCheck.expectations({ roots: [{ rootId: "72:1", nodes: [
    { id: "72:1", parent: null, width: 500, height: 100 },
    { id: "72:2", parent: "72:1", width: 960, height: 36,
      referenceSize: { source: "DERIVED_SNAPSHOT", width: 1104, height: 36 } },
    { id: "72:3", parent: "72:1", width: 369, height: 36,
      referenceSize: { source: "DEFINITION_GEOMETRY" } },
  ] }] }, { id: "72:1", root: "72:1" });
  var byKey = {};
  expansion.checks.forEach(function (check) { byKey[check.key] = check; });
  eq(byKey["72:2"].width, 1104, "узел разворота сверяется с размером из снимка, а не с геометрией мастера");
  ok(!byKey["72:3"], "узел разворота без снимка не сверяется");
  eq(expansion.unreferencedSnapshotNodes, 1, "узел без эталона посчитан отдельно");

  console.log("OK: эталонные экраны — " + checks + " проверок пройдено");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
