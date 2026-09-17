/**
 * Expressibility — слой решений, а не новый visual-safety gate.
 *
 *   node DirectPix/Tests/ExpressibilityIRInvarianceTest.js
 *
 * Синтетическая сцена собирается дважды: с политикой по замерам и с oracle
 * прежней семантики. После удаления диагностики решений и сворачивания
 * намеренных переводов IR обязан совпасть побайтно. Сцена покрывает каждый
 * вид решения: правки вхождения компонента, цикл Hug + растянутый текст,
 * конечные пробелы текста с авто-шириной и Hug-колонку со смешанными детьми.
 *
 * Фикстура синтетическая: тест не читает ни `.pix`, ни карту возможностей —
 * вердикты заданы здесь явно.
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
var Expressibility = require("../Expressibility");

var checks = 0;
function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  checks += 1;
}
function ok(value, message) { assert.ok(value, message); checks += 1; }

var VERDICTS = {
  "text-single-space-width": "IGNORED",
  "text-trailing-space-width": "IGNORED",
  "text-nbsp-width": "PERSISTED",
  "built-hug-counter-over-stretch-text": "IGNORED",
  "built-hug-counter-over-stretch-mixed": "IGNORED",
  "built-hug-counter-over-stretch-mixed-relayout": "IGNORED",
  "built-hug-counter-over-stretch-mixed-inherit": "PERSISTED",
  "built-hug-counter-over-stretch-mixed-inherit-relayout": "PERSISTED",
  "nested-fills": "PERSISTED",
  "nested-visible": "PERSISTED",
};

// Намеренные отличия от прежней семантики — доказанные замером переводы:
//   TRAILING_SPACE_AS_NBSP — конечные пробелы текста с авто-шириной
//     становятся неразрывными;
//   STRETCH_CHILD_AS_FIXED — растянутый ребёнок Hug-контейнера переносится
//     без растягивания со своей осью FIXED (исходное состояние лежит в
//     `figmaTranslation.stretchChildAsFixed.original`).
// Для сравнения оба сворачиваются обратно и считаются отдельно; любое другое
// отличие остаётся ошибкой.
var translatedTexts = 0;
var translatedStretch = 0;
function restoreStretchTranslation(node, countTranslations) {
  var marker = node.figmaTranslation.stretchChildAsFixed;
  if (countTranslations) translatedStretch += 1;
  var copy = JSON.parse(JSON.stringify(node));
  var original = marker.original || {};
  if (original.layoutAlign) copy.childLayout.layoutAlign = original.layoutAlign;
  ["primaryAxisSizingMode", "counterAxisSizingMode"].forEach(function (key) {
    if (original[key]) copy.autoLayout[key] = original[key];
  });
  if (original.textAutoResize) copy.text.textAutoResize = original.textAutoResize;
  delete copy.figmaTranslation.stretchChildAsFixed;
  if (!Object.keys(copy.figmaTranslation).length) delete copy.figmaTranslation;
  return copy;
}
function withoutDecisionDiagnostics(value, countTranslations) {
  return JSON.parse(JSON.stringify(value, function (key, item) {
    if (item && typeof item === "object" && !Array.isArray(item) && item.figmaTranslation &&
        item.figmaTranslation.stretchChildAsFixed) {
      return restoreStretchTranslation(item, countTranslations);
    }
    if (key === "expressibility" || key === "expressibilityReport") return undefined;
    if (key === "irBuildMs" || key === "parserTimings") return undefined;
    if (key === "trailingSpacesAsNbsp") return undefined;
    if (key === "characters" && typeof item === "string" && / +$/.test(item)) {
      if (countTranslations) translatedTexts += 1;
      return item.replace(/ +$/, function (tail) { return tail.replace(/ /g, " "); });
    }
    return item;
  }));
}

// ---------------------------------------------------------------------------
// Сцена
// ---------------------------------------------------------------------------
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function solid(r) { return { type: "SOLID", color: { r: r, g: 10, b: 10, a: 255 }, visible: true, blendMode: "NORMAL" }; }

var ids = {
  document: "91:1", library: "91:2", page: "91:3", root: "91:10",
  badge: "91:20", badgeLabel: "91:21",
  row: "91:30", rowText: "91:31",
  col: "91:40", wide: "91:41", wideLeaf: "91:42", button: "91:43",
  chip: "91:50", chipBody: "91:51", chipIcon: "91:52", occurrence: "91:53", occurrence2: "91:54",
};
var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

  // Компонент с двумя слоями и два вхождения с правками этих слоёв.
  { guid: guid(ids.chip), type: "SYMBOL", name: "Chip", componentKey: "chip",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 24 },
    stackMode: "HORIZONTAL", stackSpacing: 4, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" },
  { guid: guid(ids.chipBody), type: "RECTANGLE", name: "Body", parentIndex: parent(ids.chip, "a"),
    transform: matrix(), size: { x: 56, y: 24 }, fillPaints: [solid(10)],
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.chipIcon), type: "RECTANGLE", name: "Icon", parentIndex: parent(ids.chip, "b"),
    transform: matrix(), size: { x: 20, y: 24 }, fillPaints: [solid(20)],
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },

  { guid: guid(ids.root), type: "FRAME", name: "Screen", parentIndex: parent(ids.page, "a"),
    transform: matrix(), size: { x: 380, y: 400 },
    stackMode: "VERTICAL", stackSpacing: 16, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED" },

  { guid: guid(ids.occurrence), type: "INSTANCE", name: "Chip", parentIndex: parent(ids.root, "a"),
    transform: matrix(), size: { x: 80, y: 24 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    symbolData: { symbolID: guid(ids.chip), symbolOverrides: [
      { guidPath: { guids: [guid(ids.chipBody)] }, fillPaints: [solid(200)] },
      { guidPath: { guids: [guid(ids.chipIcon)] }, visible: false },
    ] } },
  { guid: guid(ids.occurrence2), type: "INSTANCE", name: "Chip", parentIndex: parent(ids.root, "b"),
    transform: matrix(), size: { x: 80, y: 24 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    symbolData: { symbolID: guid(ids.chip), symbolOverrides: [] } },

  // Текст с авто-шириной и конечным пробелом.
  { guid: guid(ids.badge), type: "FRAME", name: "Badge", parentIndex: parent(ids.root, "c"),
    transform: matrix(), size: { x: 40, y: 20 },
    stackMode: "HORIZONTAL", stackSpacing: 0, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "RESIZE_TO_FIT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.badgeLabel), type: "TEXT", name: "Label", parentIndex: parent(ids.badge, "a"),
    transform: matrix(), size: { x: 40, y: 20 }, textAutoResize: "WIDTH_AND_HEIGHT",
    textData: { characters: "Ok " }, fontSize: 12,
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },

  // Цикл Hug + растянутый текст с HEIGHT.
  { guid: guid(ids.row), type: "FRAME", name: "Row", parentIndex: parent(ids.root, "d"),
    transform: matrix(), size: { x: 380, y: 48 },
    stackMode: "HORIZONTAL", stackSpacing: 0, stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT" },
  { guid: guid(ids.rowText), type: "TEXT", name: "Header", parentIndex: parent(ids.row, "a"),
    transform: matrix(), size: { x: 120, y: 48 }, textAutoResize: "HEIGHT",
    textData: { characters: "Header" }, fontSize: 12,
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT" },

  // Hug-колонка со смешанными детьми.
  { guid: guid(ids.col), type: "FRAME", name: "Col", parentIndex: parent(ids.root, "e"),
    transform: matrix(), size: { x: 380, y: 108 },
    stackMode: "VERTICAL", stackSpacing: 8, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "RESIZE_TO_FIT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.wide), type: "FRAME", name: "Wide", parentIndex: parent(ids.col, "a"),
    transform: matrix(), size: { x: 380, y: 76 },
    stackMode: "VERTICAL", stackSpacing: 4, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT" },
  { guid: guid(ids.wideLeaf), type: "RECTANGLE", name: "Label", parentIndex: parent(ids.wide, "a"),
    transform: matrix(), size: { x: 59, y: 16 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.button), type: "RECTANGLE", name: "Button", parentIndex: parent(ids.col, "b"),
    transform: matrix(), size: { x: 105, y: 24 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-expressibility-ir-"));
try {
  var file = path.join(temp, "scene.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var root = doc.tree.byKey.get(ids.root);
  ok(root, "корень сцены прочитан из фикстуры");

  var legacy = MigrationIR.build(doc, { roots: [root], expressibilityPolicy: Expressibility.createLegacyPolicy() });
  var current = MigrationIR.build(doc, { roots: [root], capabilityVerdicts: VERDICTS });
  eq(withoutDecisionDiagnostics(current, true), withoutDecisionDiagnostics(legacy),
    "policy не меняет дерево, overrides, definitions и visual fallback");

  var currentNodes = current.roots[0].nodes;
  var legacyNodes = legacy.roots[0].nodes;
  function count(list, kind) { return list.filter(function (node) { return node.kind === kind; }).length; }
  eq(count(currentNodes, "INSTANCE"), count(legacyNodes, "INSTANCE"), "число нативных вхождений то же");
  ok(count(currentNodes, "INSTANCE") === 2, "оба вхождения компонента остались нативными");
  eq(current.stats.nativeInstanceFallbacks || 0, legacy.stats.nativeInstanceFallbacks || 0,
    "политика не разворачивает вхождения во фреймы");

  var table = current.expressibilityReport.table;
  ok(table.some(function (row) { return row.reason === "TEXT_TRAILING_SPACE_AS_NBSP"; }), "перевод пробелов назван в отчёте");
  ok(table.some(function (row) { return row.reason === "STRETCH_IN_MIXED_HUG_AS_FIXED"; }), "перевод Hug-колонки назван в отчёте");
  ok(table.some(function (row) { return row.class === "TEXT_HUG_FILL_CYCLE"; }), "цикл Hug + текст получил решение");
  ok(table.some(function (row) { return row.class === "NESTED_LOW_LEVEL_OVERRIDE"; }), "правки вхождения получили решения");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

assert.ok(translatedTexts > 0, "перевод конечных пробелов действительно применён в сцене");
checks += 1;
assert.ok(translatedStretch > 0, "перевод растянутого ребёнка Hug-контейнера применён в сцене");
checks += 1;

console.log("OK: observational expressibility IR — " + checks + " проверок пройдено");
