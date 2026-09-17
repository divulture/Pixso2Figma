/**
 * D53. Семейство вариантов доезжает целиком до первого своего вхождения.
 *
 *   node DirectPix/Tests/VariantFamilyDemandTest.js
 *
 * Утверждение одно и оно про ПОРЯДОК, а не про объём:
 *
 *   если два корня job-а используют разные варианты одной группы состояний,
 *   оба определения обязаны уехать тем же чанком, что и первый из них.
 *
 * Почему это важно. Приёмник собирает `COMPONENT_SET` сразу после чанка
 * определений и дособирает опоздавших через `appendChild`. Живая Figma при
 * изменении набора переразрешает УЖЕ СОЗДАННЫЕ вхождения, и слои, чья
 * видимость привязана к свойству набора, возвращаются к умолчанию мастера.
 * Симптом на настоящем файле: первый экран собран верно, на следующих у того
 * же компонента нужные слои скрываются, а ненужные показываются.
 *
 * Границы:
 *   - спрос считается по тем же корням, которые мигрируются, поэтому
 *     неиспользуемые sibling-варианты не подтягиваются;
 *   - без карты спроса поведение прежнее, ленивое.
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

var ids = {
  document: "9:1", library: "9:2", page: "9:3",
  group: "9:10", variantA: "9:11", variantAChild: "9:12", variantB: "9:13", variantBChild: "9:14",
  unusedVariant: "9:15", unusedChild: "9:16",
  rootOne: "9:20", occurrenceA: "9:21",
  rootTwo: "9:30", occurrenceB: "9:31",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Screens", parentIndex: parent(ids.document, "b") },

  {
    guid: guid(ids.group), type: "FRAME", name: "Toggle", isStateGroup: true,
    componentKey: "toggle-family", parentIndex: parent(ids.library, "a"),
    transform: matrix(), size: { x: 40, y: 40 },
    stateGroupPropertyValueOrders: [{ property: "state", values: ["off", "on", "spare"] }],
  },
  { guid: guid(ids.variantA), type: "SYMBOL", name: "state=off", componentKey: "toggle-off",
    parentIndex: parent(ids.group, "a"), transform: matrix(), size: { x: 40, y: 20 } },
  { guid: guid(ids.variantAChild), type: "TEXT", name: "Label", parentIndex: parent(ids.variantA, "a"),
    transform: matrix(), size: { x: 40, y: 20 }, textData: { characters: "off" } },
  { guid: guid(ids.variantB), type: "SYMBOL", name: "state=on", componentKey: "toggle-on",
    parentIndex: parent(ids.group, "b"), transform: matrix(), size: { x: 40, y: 20 } },
  { guid: guid(ids.variantBChild), type: "TEXT", name: "Label", parentIndex: parent(ids.variantB, "a"),
    transform: matrix(), size: { x: 40, y: 20 }, textData: { characters: "on" } },
  // Третий вариант не используется ни одним корнем и подтягиваться не должен.
  { guid: guid(ids.unusedVariant), type: "SYMBOL", name: "state=spare", componentKey: "toggle-spare",
    parentIndex: parent(ids.group, "c"), transform: matrix(), size: { x: 40, y: 20 } },
  { guid: guid(ids.unusedChild), type: "TEXT", name: "Label", parentIndex: parent(ids.unusedVariant, "a"),
    transform: matrix(), size: { x: 40, y: 20 }, textData: { characters: "spare" } },

  { guid: guid(ids.rootOne), type: "FRAME", name: "Screen 1", parentIndex: parent(ids.page, "a"),
    transform: matrix(), size: { x: 100, y: 60 } },
  { guid: guid(ids.occurrenceA), type: "INSTANCE", name: "Toggle off", parentIndex: parent(ids.rootOne, "a"),
    transform: matrix(), size: { x: 40, y: 20 }, symbolData: { symbolID: guid(ids.variantA) } },

  { guid: guid(ids.rootTwo), type: "FRAME", name: "Screen 2", parentIndex: parent(ids.page, "b"),
    transform: matrix(), size: { x: 100, y: 60 } },
  { guid: guid(ids.occurrenceB), type: "INSTANCE", name: "Toggle on", parentIndex: parent(ids.rootTwo, "a"),
    transform: matrix(), size: { x: 40, y: 20 }, symbolData: { symbolID: guid(ids.variantB) } },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-family-demand-"));
try {
  var file = path.join(temp, "family.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var rootOne = doc.tree.byKey.get(ids.rootOne);
  var rootTwo = doc.tree.byKey.get(ids.rootTwo);
  ok(rootOne && rootTwo, "оба корня найдены");

  function definitionIdsPerChunk(registry) {
    var chunks = [];
    [rootOne, rootTwo].forEach(function (root) {
      var ir = MigrationIR.build(doc, { roots: [root], registry: registry });
      chunks.push((ir.definitions || []).map(function (d) { return d.definitionId; }));
    });
    return chunks;
  }

  // --- прежнее, ленивое поведение -----------------------------------------
  var lazyChunks = definitionIdsPerChunk(MigrationIR.createRegistry());
  ok(lazyChunks[0].indexOf(ids.variantA) >= 0, "первый корень везёт свой вариант");
  eq(lazyChunks[0].indexOf(ids.variantB), -1,
    "без карты спроса второй вариант в первом чанке не едет — это и есть прежнее поведение");
  ok(lazyChunks[1].indexOf(ids.variantB) >= 0, "второй вариант доезжает только со вторым корнем");

  // --- D53: спрос посчитан по обоим корням --------------------------------
  var registry = MigrationIR.createRegistry();
  var demand = MigrationIR.collectFamilyDemand(doc, [rootOne, rootTwo], { registry: registry });
  eq(demand.size, 1, "спрос посчитан ровно по одной группе состояний");
  var demanded = demand.get(ids.group) || [];
  eq(demanded.length, 2, "востребованы ровно два варианта из трёх");
  eq(demanded.indexOf(ids.unusedVariant), -1,
    "неиспользуемый sibling в спрос не попал: ленивая политика сохранена");

  registry.familyDemand = demand;
  var eagerChunks = definitionIdsPerChunk(registry);
  ok(eagerChunks[0].indexOf(ids.variantA) >= 0 && eagerChunks[0].indexOf(ids.variantB) >= 0,
    "оба востребованных варианта уехали ОДНИМ чанком, до первого вхождения");
  eq(eagerChunks[0].indexOf(ids.unusedVariant), -1,
    "неиспользуемый вариант не материализован");
  eq(eagerChunks[1].length, 0,
    "второму корню досылать нечего: семейство уже собрано целиком");

  // Объём работы не изменился — изменился только порядок.
  var lazyTotal = lazyChunks[0].length + lazyChunks[1].length;
  var eagerTotal = eagerChunks[0].length + eagerChunks[1].length;
  eq(eagerTotal, lazyTotal, "тот же набор определений, только раньше");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX variant family demand — " + checks + " проверок пройдено\n");
