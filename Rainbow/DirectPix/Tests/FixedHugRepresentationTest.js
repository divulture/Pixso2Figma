/**
 * Direct PIX: HUG над FIXED-слоями с собственным размером во вхождении.
 *
 *   node DirectPix/Tests/FixedHugRepresentationTest.js
 *
 * Pixso хранит у вложенного слоя вхождения собственный размер, нативный
 * инстанс Figma — нет: при пересчёте слой получает размер мастера, и HUG
 * корня обнимает уже его. Если все дети потока на оси FIXED, HUG по этой оси
 * поведенчески равен FIXED, а FIXED-ребёнок, ровно заполняющий внутреннюю ось,
 * выражается растяжением. Отправитель переводит запись в эту форму — и только
 * при доказательстве по данным источника.
 *
 * Утверждения:
 *
 *   — доказанный случай: корень FIXED, ребёнок STRETCH, перевод посчитан;
 *   — ребёнок не заполняет ось — запись не трогается;
 *   — размер во вхождении равен мастеру — переводить нечего;
 *   — ребёнок сам обнимает ось (HUG) — HUG корня адаптивен и сохраняется.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var Fixture = require("./Fixture");
var PixContainer = require("../PixContainer");
var PixDocument = require("../PixDocument");
var MigrationIR = require("../MigrationIR");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }

function buildIr(nodes, rootId) {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-fixed-hug-"));
  try {
    var file = path.join(temp, "scene.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    return MigrationIR.build(doc, { roots: [doc.tree.byKey.get(rootId)], visualSafety: false });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Аккордеон: вертикальный корень (HUG по высоте, FIXED по ширине), шапка
 * растянута по корню, внутри текст, заполняющий шапку.
 */
function scene(options) {
  var headerOwnWidth = options.headerHugs ? "RESIZE_TO_FIT" : "FIXED";
  return [
    { guid: guid("20:1"), type: "DOCUMENT", name: "Doc" },
    { guid: guid("20:2"), type: "CANVAS", name: "Library", parentIndex: parent("20:1", "a") },
    { guid: guid("20:3"), type: "CANVAS", name: "Screen", parentIndex: parent("20:1", "b") },
    { guid: guid("20:10"), type: "SYMBOL", name: "Accordion", componentKey: "acc",
      parentIndex: parent("20:2", "a"), transform: matrix(), size: { x: 600, y: 36 },
      stackMode: "VERTICAL", stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED" },
    { guid: guid("20:11"), type: "FRAME", name: "Header", parentIndex: parent("20:10", "a"),
      transform: matrix(), size: { x: 600, y: 36 },
      stackMode: "HORIZONTAL", stackPrimarySizing: headerOwnWidth, stackCounterSizing: "RESIZE_TO_FIT",
      stackChildCounterSizing: "RESIZE_TO_FIT" },
    { guid: guid("20:12"), type: "TEXT", name: "Title", parentIndex: parent("20:11", "a"),
      transform: matrix(), size: { x: 600, y: 20 }, textAutoResize: "HEIGHT",
      stackChildPrimarySizing: "RESIZE_TO_FIT", textData: { characters: "Заголовок" } },
    { guid: guid("20:4"), type: "FRAME", name: "Root", parentIndex: parent("20:3", "a"),
      transform: matrix(), size: { x: 800, y: 200 } },
    { guid: guid("20:40"), type: "INSTANCE", name: "Occurrence", parentIndex: parent("20:4", "a"),
      transform: matrix(), size: { x: options.occurrenceWidth, y: 36 },
      symbolData: {
        symbolID: guid("20:10"),
        symbolOverrides: [
          { guidPath: { guids: [] }, stackCounterSizing: "RESIZE_TO_FIT" },
          { guidPath: { guids: [guid("20:11")] }, stackChildCounterSizing: "FIXED" },
        ],
      },
      derivedSymbolData: [
        { guidPath: { guids: [guid("20:11")] }, size: { x: options.headerWidth, y: 36 } },
        { guidPath: { guids: [guid("20:11"), guid("20:12")] }, size: { x: options.headerWidth, y: 20 } },
      ] },
  ];
}

function occurrenceOps(ir) {
  var nodes = ir.roots[0].nodes;
  var occurrence = nodes.filter(function (node) { return node.id === "20:40"; })[0];
  var byPath = {};
  (occurrence.overrides || []).forEach(function (entry) {
    byPath[entry.path.map(function (step) { return step.sourceId; }).join("/")] = entry;
  });
  return byPath;
}

// --- 1. Доказанный случай ----------------------------------------------------
(function proven() {
  var ir = buildIr(scene({ occurrenceWidth: 380, headerWidth: 380 }), "20:4");
  var ops = occurrenceOps(ir);
  eq(ops[""].ops.layout.counterAxisSizingMode, "FIXED", "HUG корня над FIXED-шапкой передан как FIXED");
  eq(ops["20:11"].ops.childLayout.layoutAlign, "STRETCH", "шапка, ровно заполняющая корень, растянута");
  eq(ops["20:11"].present.childLayout, true, "правка слота помечена явной");
  eq(ir.stats.fixedHugRepresentedAsFill, 1, "перевод посчитан");
  ok(ir.unsupported.NESTED_FIXED_SIZE_REPRESENTED_AS_FILL >= 1, "перевод назван кодом в отчёте");
})();

// --- 2. Ребёнок не заполняет ось ---------------------------------------------
(function partialChild() {
  var ir = buildIr(scene({ occurrenceWidth: 380, headerWidth: 300 }), "20:4");
  var ops = occurrenceOps(ir);
  eq(ops[""].ops.layout.counterAxisSizingMode, "AUTO", "без доказательства HUG корня не тронут");
  eq(ops["20:11"].ops.childLayout.layoutAlign, "INHERIT", "слот шапки остался источником");
  eq(ir.stats.fixedHugRepresentedAsFill, 0, "перевода не было");
})();

// --- 3. Размер во вхождении равен мастеру ------------------------------------
(function sameAsMaster() {
  var ir = buildIr(scene({ occurrenceWidth: 600, headerWidth: 600 }), "20:4");
  var ops = occurrenceOps(ir);
  var rootLayout = ops[""] && ops[""].ops.layout;
  ok(!rootLayout || rootLayout.counterAxisSizingMode !== "FIXED", "переводить нечего: мастер держит этот размер сам");
  eq(ir.stats.fixedHugRepresentedAsFill, 0, "перевода не было");
})();

// --- 4. Ребёнок сам обнимает ось ---------------------------------------------
(function huggingChild() {
  var ir = buildIr(scene({ occurrenceWidth: 380, headerWidth: 380, headerHugs: true }), "20:4");
  var ops = occurrenceOps(ir);
  eq(ops[""].ops.layout.counterAxisSizingMode, "AUTO", "HUG над обнимающим ребёнком адаптивен и сохранён");
  eq(ir.stats.fixedHugRepresentedAsFill, 0, "перевода не было");
})();

console.log("OK: Direct PIX HUG над FIXED-слоями — " + checks + " проверок пройдено");
