/**
 * Hug по контр-оси со смешанными детьми — форма STRETCH_CHILD_AS_FIXED.
 *
 *   node DirectPix/Tests/MixedHugStretchTest.js
 *
 * Регрессия полного цикла реального документа (2026-09-17): вертикальная колонка Hug с
 * растянутым широким ребёнком (380) и узким обычным (FunctionButton 105,
 * Switch 170) приезжала узкой — Figma обнимает только нерастянутых
 * (`built-hug-counter-over-stretch-mixed` — IGNORED), Pixso — всех.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var Fixture = require("./Fixture");
var Expressibility = require("../Expressibility");
var PixContainer = require("../PixContainer");
var PixDocument = require("../PixDocument");
var MigrationIR = require("../MigrationIR");
var Trace = require("../Trace");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var MEASURED = {
  "built-hug-counter-over-stretch-mixed": "IGNORED",
  "built-hug-counter-over-stretch-mixed-relayout": "IGNORED",
  "built-hug-counter-over-stretch-mixed-inherit": "PERSISTED",
  "built-hug-counter-over-stretch-mixed-inherit-relayout": "PERSISTED",
};
var policy = Expressibility.createPolicy({ verdicts: MEASURED });

function column(options) {
  options = options || {};
  return [
    { id: "c", type: "FRAME", width: options.width || 380, height: 108,
      autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO",
        paddingLeft: 0, paddingRight: 0 },
      childLayout: options.columnSlot || { layoutGrow: 0, layoutAlign: "INHERIT" },
      parent: options.parent ? "p" : undefined },
    { id: "w", parent: "c", type: "FRAME", width: options.wideWidth || 380, height: 76,
      autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" },
      childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
    { id: "b", parent: "c", type: "INSTANCE", width: options.buttonWidth || 105, height: 24,
      childLayout: { layoutGrow: 0, layoutAlign: options.allStretched ? "STRETCH" : "INHERIT" } },
  ].concat(options.parent ? [{ id: "p", type: "FRAME", width: 380, height: 300,
    autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" } }] : []);
}
function byId(nodes, id) { return nodes.filter(function (node) { return node.id === id; })[0]; }

// ---------------------------------------------------------------------------
// 1. Доказанный случай переводится
// ---------------------------------------------------------------------------
var nodes = column();
var ledger = Expressibility.createLedger(10);
Expressibility.annotateMixedHugStretch(nodes, policy, ledger);
var wide = byId(nodes, "w");
eq(wide.childLayout.layoutAlign, "INHERIT", "растянутый ребёнок снят с растягивания");
eq(wide.autoLayout.counterAxisSizingMode, "FIXED", "его своя ширина держит размер Pixso, а не обнимает");
eq(wide.expressibility[0].reason, "STRETCH_IN_MIXED_HUG_AS_FIXED", "перевод назван");
eq(wide.expressibility[0].evidence.length, 4, "перевод опирается на четыре замера");
eq(wide.figmaTranslation.stretchChildAsFixed.original.layoutAlign, "STRETCH", "исходное состояние сохранено для аудита");
eq(byId(nodes, "b").childLayout.layoutAlign, "INHERIT", "нерастянутый ребёнок не тронут");
eq(ledger.report().totals.TRANSLATE, 1, "решение попало в отчёт");

// ---------------------------------------------------------------------------
// 2. Где переводить нечего или нечем доказать — узел как есть
// ---------------------------------------------------------------------------
var allStretched = column({ allStretched: true });
Expressibility.annotateMixedHugStretch(allStretched, policy, null);
eq(byId(allStretched, "w").childLayout.layoutAlign, "STRETCH",
  "растянуты все — Figma держит размер (built-hug-counter-over-stretch), перевода нет");

var narrow = column({ width: 105, wideWidth: 105 });
Expressibility.annotateMixedHugStretch(narrow, policy, null);
eq(byId(narrow, "w").childLayout.layoutAlign, "STRETCH",
  "Pixso-размер колонки равен узкому ребёнку — Figma даст то же самое");

var unproven = column({ wideWidth: 300 });
Expressibility.annotateMixedHugStretch(unproven, policy, null);
eq(byId(unproven, "w").childLayout.layoutAlign, "STRETCH", "растянутый не равен внутренней оси — не угадываем");
eq(byId(unproven, "w").expressibility[0].reason, "MIXED_HUG_STRETCH_SIZE_UNPROVEN", "причина отказа названа");

var owned = column({ parent: true, columnSlot: { layoutGrow: 0, layoutAlign: "STRETCH" } });
Expressibility.annotateMixedHugStretch(owned, policy, null);
eq(byId(owned, "w").childLayout.layoutAlign, "STRETCH", "ширину колонки задаёт её родитель — цикла нет");

var unmeasured = column();
Expressibility.annotateMixedHugStretch(unmeasured, Expressibility.createPolicy({ verdicts: {} }), null);
eq(byId(unmeasured, "w").childLayout.layoutAlign, "STRETCH", "без замера путь прежний");

var text = [
  { id: "c", type: "FRAME", width: 380, height: 40,
    autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
  { id: "t", parent: "c", type: "TEXT", width: 380, height: 16, text: { textAutoResize: "WIDTH_AND_HEIGHT" },
    childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
  { id: "b", parent: "c", type: "FRAME", width: 105, height: 24, childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } },
];
Expressibility.annotateMixedHugStretch(text, policy, null);
eq(byId(text, "t").text.textAutoResize, "HEIGHT", "растянутый текст держит ширину, а не обнимает строку");

// ---------------------------------------------------------------------------
// 2a. Растянуты все — перевод только по замеру содержимого
// ---------------------------------------------------------------------------
function allStretchColumn(withContent) {
  var out = [
    { id: "c", type: "FRAME", width: 380, height: 108,
      autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
    { id: "i", parent: "c", type: "INSTANCE", width: 380, height: 56, childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
    { id: "l", parent: "c", type: "FRAME", width: 380, height: 44,
      autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" },
      childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
  ];
  if (withContent) out.push({ id: "s", parent: "l", type: "INSTANCE", width: 170, height: 20,
    childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } });
  return out;
}
var CONTENT_MEASURED = Object.assign({}, MEASURED, {
  "built-hug-counter-over-stretch-content-relayout": "IGNORED",
  "built-hug-counter-over-stretch-content-inherit-relayout": "PERSISTED",
});
var listColumn = allStretchColumn(true);
Expressibility.annotateMixedHugStretch(listColumn, Expressibility.createPolicy({ verdicts: CONTENT_MEASURED }), null);
eq(byId(listColumn, "i").childLayout.layoutAlign, "INHERIT", "Input рядом с растянутым списком переведён по замеру");
eq(byId(listColumn, "l").childLayout.layoutAlign, "INHERIT", "и сам список");
eq(byId(listColumn, "i").expressibility[0].class, "HUG_ALL_STRETCH_CYCLE", "класс «растянуты все» назван отдельно");

var listUnmeasured = allStretchColumn(true);
Expressibility.annotateMixedHugStretch(listUnmeasured, policy, null);
eq(byId(listUnmeasured, "i").childLayout.layoutAlign, "STRETCH", "без замера содержимого путь прежний");
eq(byId(listUnmeasured, "i").expressibility[0].reason, "LEGACY_PATH_UNMEASURED", "долг по probe назван");

var emptyStretch = allStretchColumn(false);
Expressibility.annotateMixedHugStretch(emptyStretch, Expressibility.createPolicy({ verdicts: CONTENT_MEASURED }), null);
eq(byId(emptyStretch, "l").childLayout.layoutAlign, "STRETCH",
  "растянутые без содержимого Figma держит (built-hug-counter-over-stretch) — не трогаем");

// ---------------------------------------------------------------------------
// 3. Сцена формы реального документа на двойнике: `.pix` → IR → приёмник
// ---------------------------------------------------------------------------
// Синтетическая фикстура повторяет форму колонок реального документа: Hug-колонка 380 с
// растянутым широким ребёнком и узкой кнопкой 105 (смешанная) и колонка, где
// растянуты оба ребёнка, а у второго есть содержимое уже 380 (растянуты все).
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }

var ids = {
  document: "81:1", page: "81:2", root: "81:10",
  mixedCol: "81:20", wide: "81:21", wideLeaf: "81:22", button: "81:23",
  allCol: "81:30", input: "81:31", list: "81:32", item: "81:33",
};
var sceneNodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.root), type: "FRAME", name: "Content", parentIndex: parent(ids.page, "a"),
    transform: matrix(), size: { x: 380, y: 400 },
    stackMode: "VERTICAL", stackSpacing: 16, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED" },

  { guid: guid(ids.mixedCol), type: "FRAME", name: "Col", parentIndex: parent(ids.root, "a"),
    transform: matrix(), size: { x: 380, y: 108 },
    stackMode: "VERTICAL", stackSpacing: 8, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "RESIZE_TO_FIT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.wide), type: "FRAME", name: "Wide", parentIndex: parent(ids.mixedCol, "a"),
    transform: matrix(), size: { x: 380, y: 76 },
    stackMode: "VERTICAL", stackSpacing: 4, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT" },
  { guid: guid(ids.wideLeaf), type: "RECTANGLE", name: "Label", parentIndex: parent(ids.wide, "a"),
    transform: matrix(), size: { x: 59, y: 16 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.button), type: "RECTANGLE", name: "Button", parentIndex: parent(ids.mixedCol, "b"),
    transform: matrix(), size: { x: 105, y: 24 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },

  { guid: guid(ids.allCol), type: "FRAME", name: "Col", parentIndex: parent(ids.root, "b"),
    transform: matrix(), size: { x: 380, y: 108 },
    stackMode: "VERTICAL", stackSpacing: 8, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "RESIZE_TO_FIT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
  { guid: guid(ids.input), type: "RECTANGLE", name: "Input", parentIndex: parent(ids.allCol, "a"),
    transform: matrix(), size: { x: 380, y: 56 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT" },
  { guid: guid(ids.list), type: "FRAME", name: "ChoicesList", parentIndex: parent(ids.allCol, "b"),
    transform: matrix(), size: { x: 380, y: 44 },
    stackMode: "VERTICAL", stackSpacing: 4, stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT" },
  { guid: guid(ids.item), type: "RECTANGLE", name: "Switch", parentIndex: parent(ids.list, "a"),
    transform: matrix(), size: { x: 170, y: 20 },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED" },
];

var ALL_MEASURED = Object.assign({}, CONTENT_MEASURED);

async function scene() {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-mixed-hug-"));
  try {
    var file = path.join(temp, "scene.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: sceneNodes, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var record = doc.tree.byKey.get(ids.root);
    ok(record, "корень сцены прочитан из фикстуры");

    async function widths(expressibilityPolicy) {
      var ir = MigrationIR.build(doc, { roots: [record], visualSafety: false, expressibilityPolicy: expressibilityPolicy });
      var run = await Trace.runReceiver(doc, [{ rootId: ids.root, ir: ir }], { verifyTree: true, verifyStoredState: true });
      var tree = run.finish.treeVerification.tree;
      var out = {};
      [ids.mixedCol, ids.wide, ids.allCol, ids.input, ids.list].forEach(function (id) {
        var entry = tree.filter(function (item) { return item.sourceId === id; })[0];
        out[id] = entry ? entry.width : null;
      });
      return out;
    }

    var legacy = await widths(Expressibility.createLegacyPolicy());
    ok(typeof legacy[ids.mixedCol] === "number" && legacy[ids.mixedCol] < 300,
      "двойник воспроизводит регресс смешанной колонки без формы (получено " + legacy[ids.mixedCol] + ")");
    var current = await widths(Expressibility.createPolicy({ verdicts: ALL_MEASURED }));
    eq(current[ids.mixedCol], 380, "смешанная колонка с формой держит 380");
    eq(current[ids.wide], 380, "и её широкий ребёнок");
    eq(current[ids.allCol], 380, "колонка «растянуты все» с формой держит 380");
    eq(current[ids.input], 380, "Input в ней во всю ширину");
    eq(current[ids.list], 380, "и список тоже");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

scene().then(function () {
  process.stdout.write("OK: смешанный Hug по контр-оси — " + checks + " проверок пройдено\n");
}).catch(function (error) {
  console.error(error);
  process.exit(1);
});
