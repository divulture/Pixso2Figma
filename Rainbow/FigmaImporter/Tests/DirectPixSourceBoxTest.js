/**
 * Direct PIX: итоговые коробки вложенных узлов вхождения (`sourceBoxes`).
 *
 *   node FigmaImporter/Tests/DirectPixSourceBoxTest.js
 *
 * Тест закрепляет то, что измерено в живой Figma (FIGMA_CAPABILITIES.md) и
 * воспроизводится двойником, приведённым к замерам:
 *
 *   — правки Accordion в форме Pixso (корень Hug, шапка снята со STRETCH)
 *     нативный инстанс не держит: в сохранённом состоянии (`clone()`) шапка
 *     получает размер мастера;
 *   — чтение сразу после правок показывает закешированные 380, поэтому
 *     `sourceBoxes` считает коробку совпавшей, а запись размера вложенному
 *     слою Figma всё равно игнорирует. `sourceBoxes` — диагностика, не
 *     исправление;
 *   — форма «корень Fixed + растянутая шапка» (`representFixedHugAsFill`)
 *     держит размер вхождения;
 *   — путь без доказанной идентичности пропускается и считается.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var FigmaHost = require("../../DirectPix/FigmaHost");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
var receiver = host.receiver;

var DIRECT = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };
var taskSequence = 0;

function task(jobId, type, payload) {
  taskSequence += 1;
  return receiver.handleDirectTask({
    jobId: jobId,
    taskId: jobId + "-" + type + "-" + taskSequence,
    type: "DIRECT_PIX_" + type,
    payload: Object.assign({}, DIRECT, payload || {}),
  }, { createPages: true });
}

function pageByName(name) {
  var pages = host.pages();
  for (var i = 0; i < pages.length; i++) if (pages[i].name === name) return pages[i];
  return null;
}

function findNode(root, sourceId) {
  var stack = [root];
  while (stack.length) {
    var current = stack.pop();
    if (current.getPluginData && current.getPluginData("pixsoDirectSourceId") === sourceId) return current;
    var children = current.children || [];
    for (var i = 0; i < children.length; i++) stack.push(children[i]);
  }
  return null;
}

/**
 * Аккордеон: вертикальный корень FIXED по ширине, внутри шапка —
 * горизонтальный FIXED-контейнер, растянутый по корню (STRETCH), в шапке
 * текст, заполняющий её (grow = 1), и HUG-бейдж.
 */
function accordionDefinition(id) {
  return {
    definitionId: id + ":10", componentKey: null, variantGroupId: null, name: "Accordion " + id,
    nodes: [
      { id: id + ":10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Accordion",
        x: 0, y: 0, width: 600, height: 36, definitionPath: [],
        autoLayout: { layoutMode: "VERTICAL", itemSpacing: 0,
          primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" } },
      { id: id + ":11", parent: id + ":10", kind: "ORDINARY", type: "FRAME", name: "Header",
        x: 0, y: 0, width: 600, height: 36, definitionPath: [0],
        autoLayout: { layoutMode: "HORIZONTAL", itemSpacing: 6, paddingTop: 8, paddingBottom: 8,
          primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" },
        childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
      { id: id + ":12", parent: id + ":11", kind: "ORDINARY", type: "TEXT", name: "Title",
        x: 0, y: 8, width: 540, height: 20, definitionPath: [0, 0],
        text: { characters: "Заголовок", fontName: { family: "Inter", style: "Regular" }, textAutoResize: "HEIGHT" },
        childLayout: { layoutGrow: 1, layoutAlign: "INHERIT" } },
      { id: id + ":13", parent: id + ":11", kind: "ORDINARY", type: "FRAME", name: "Badge",
        x: 546, y: 8, width: 54, height: 20, definitionPath: [0, 1],
        autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" },
        childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } },
      { id: id + ":14", parent: id + ":13", kind: "ORDINARY", type: "RECTANGLE", name: "Dot",
        x: 0, y: 0, width: 54, height: 20, definitionPath: [0, 1, 0] },
    ],
  };
}

function step(id, local, indexPath, type) {
  return { index: indexPath[indexPath.length - 1], sourceId: id + ":" + local, sourceType: type,
    targetType: type, definitionId: id + ":10", definitionPath: indexPath };
}

/**
 * Вхождение шириной 380: корень переключён в HUG, шапка снята со STRETCH.
 * Ровно эти две правки в этом порядке и дают цикл на промежуточном шаге.
 */
function occurrence(id, occurrenceId, x, sourceBoxes) {
  var header = step(id, 11, [0], "FRAME");
  var node = {
    id: occurrenceId, parent: id + ":100", kind: "INSTANCE", type: "INSTANCE", name: "Accordion",
    definitionId: id + ":10", x: x, y: 0, width: 380, height: 36,
    overrides: [
      { path: [], ops: { layout: { primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
        present: { layout: true } },
      { path: [header], ops: { childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } },
        present: { childLayout: true } },
    ],
  };
  if (sourceBoxes) node.sourceBoxes = sourceBoxes;
  return node;
}

async function buildScreen(job, id, pageName, sourceBoxes) {
  await task(job, "PAGE", { pageId: "p" + id, pageName: pageName });
  await task(job, "DEFINITIONS", { definitions: [accordionDefinition(id)] });
  var result = await task(job, "ROOT", {
    pageId: "p" + id, pageName: pageName, rootId: id + ":100", rootName: pageName,
    nodes: [
      { id: id + ":100", parent: null, kind: "ORDINARY", type: "FRAME", name: pageName,
        x: 0, y: 0, width: 800, height: 200 },
      occurrence(id, id + ":101", 0, sourceBoxes),
    ],
  });
  var instance = findNode(pageByName(pageName), id + ":101");
  ok(instance && instance.type === "INSTANCE", pageName + ": вхождение осталось нативным инстансом");
  return { result: result, instance: instance, header: instance.children[0] };
}

async function run() {
  var job = "job-source-boxes";
  await task(job, "START", { source: { fileName: "source-boxes.pix" } });

  // --- 1. Форма Pixso нативным инстансом не держится --------------------------
  var legacy = await buildScreen(job, "41", "Форма Pixso");
  var legacyStored = legacy.instance.clone();
  eq(legacyStored.children[0].width, 600,
    "в сохранённом состоянии шапка получила размер мастера, а не 380 из Pixso");

  // --- 2. Коробки источника: запись размера вложенному слою игнорируется ------
  var boxed = await buildScreen(job, "42", "С коробками", [
    { path: [step("42", 11, [0], "FRAME")], width: 380, height: 36 },
    { path: [step("42", 11, [0], "FRAME"), step("42", 13, [0, 1], "FRAME")], width: 90, height: 20 },
  ]);
  var boxedStored = boxed.instance.clone();
  eq(boxedStored.children[0].width, 600, "коробка источника не изменила сохранённый размер вложенного слоя");
  var badge = boxed.header.children[1];
  eq(badge.primaryAxisSizingMode, "AUTO", "HUG-бейдж не закреплён в FIXED");

  var finished = await task(job, "FINISH", {});
  var report = JSON.stringify(finished);
  // sourceBoxes теперь чистая диагностика: probe доказал, что запись
  // размера вложенному слою игнорируется. Приёмник не делает ни одной
  // попытки resize/min-max и только считает фактическое расхождение.
  ok(/"sourceBoxesAlreadyMatching":[1-9]/.test(report),
    "совпавшие коробки считаются без записи");
  ok(!/"sourceBoxWidthsRestored":[1-9]/.test(report),
    "восстановление ширины вложенного слоя не выдаётся за состоявшееся");
  ok(report.indexOf("sourceBoxProbeWon") < 0 && report.indexOf("sourceBoxProbeAllIgnored") < 0,
    "диагностика не пробует мутирующие API");

  // --- 2b. Форма representFixedHugAsFill держит размер вхождения --------------
  var jobForm = "job-source-boxes-form";
  await task(jobForm, "START", { source: { fileName: "source-boxes-form.pix" } });
  await task(jobForm, "PAGE", { pageId: "p44", pageName: "Форма Figma" });
  await task(jobForm, "DEFINITIONS", { definitions: [accordionDefinition("44")] });
  await task(jobForm, "ROOT", {
    pageId: "p44", pageName: "Форма Figma", rootId: "44:100", rootName: "Форма Figma",
    nodes: [
      { id: "44:100", parent: null, kind: "ORDINARY", type: "FRAME", name: "Форма Figma",
        x: 0, y: 0, width: 800, height: 200 },
      { id: "44:101", parent: "44:100", kind: "INSTANCE", type: "INSTANCE", name: "Accordion",
        definitionId: "44:10", x: 0, y: 0, width: 380, height: 36,
        overrides: [
          { path: [], ops: { layout: { primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" } },
            present: { layout: true } },
          { path: [step("44", 11, [0], "FRAME")], ops: { childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
            present: { childLayout: true } },
        ] },
    ],
  });
  var formInstance = findNode(pageByName("Форма Figma"), "44:101");
  var formStored = formInstance.clone();
  eq(formStored.width, 380, "корень Fixed держит ширину вхождения в сохранённом состоянии");
  eq(formStored.children[0].width, 380, "растянутая шапка держит 380 в сохранённом состоянии");
  await task(jobForm, "FINISH", {});

  // --- 3. Недоказанный путь ------------------------------------
  var job2 = "job-source-boxes-unproven";
  await task(job2, "START", { source: { fileName: "source-boxes-2.pix" } });
  var foreign = step("43", 11, [0], "FRAME");
  foreign.sourceId = "43:999";
  var unproven = await buildScreen(job2, "43", "Чужой адрес", [
    { path: [foreign], width: 380, height: 36 },
  ]);
  var finished2 = JSON.stringify(await task(job2, "FINISH", {}));
  ok(finished2.indexOf("sourceBoxesUnresolved") >= 0, "недоказанный адрес посчитан, а не угадан");

  console.log("OK: Direct PIX коробки источника — " + checks + " проверок пройдено");
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
