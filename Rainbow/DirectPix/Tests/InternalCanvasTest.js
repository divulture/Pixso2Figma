/**
 * Служебное библиотечное полотно Pixso.
 *
 * В настоящих документах ровно один CANVAS помечен `internalOnly = true` и
 * держит на себе всю библиотеку символов — в реальном файле это 1254 корня
 * против двух пользовательских. Раскладывать его в Figma как пользовательскую
 * страницу нельзя, но и выбросить его символы нельзя тоже: именно они
 * работают определениями для инстансов на пользовательских страницах.
 *
 * Тест закрывает обе половины этого требования и то, что решение принимается
 * по структурному флагу, а не по имени страницы.
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
var Cli = require("../Cli");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }

var ids = {
  document: "9:1",
  internalCanvas: "9:2", userCanvas: "9:3",
  usedSymbol: "9:10", usedSymbolText: "9:11",
  unusedSymbol: "9:20", unusedSymbolText: "9:21",
  libraryRoot: "9:30",
  userRoot: "9:40", userOccurrence: "9:41",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },

  // Служебное полотно. Имя нарочно взято обычное: решение принимает флаг.
  {
    guid: guid(ids.internalCanvas), type: "CANVAS", name: "Совершенно обычное имя",
    parentIndex: parent(ids.document, "a"), internalOnly: true,
  },
  { guid: guid(ids.userCanvas), type: "CANVAS", name: "Internal Only Canvas", parentIndex: parent(ids.document, "b") },

  // Символ, который понадобится пользовательскому корню.
  {
    guid: guid(ids.usedSymbol), type: "SYMBOL", name: "Используемый", componentKey: "used",
    parentIndex: parent(ids.internalCanvas, "a"), transform: matrix(), size: { x: 40, y: 20 },
  },
  {
    guid: guid(ids.usedSymbolText), type: "TEXT", name: "Подпись",
    parentIndex: parent(ids.usedSymbol, "a"), transform: matrix(), size: { x: 40, y: 20 },
    textData: { characters: "Из библиотеки" },
  },

  // Символ, которым никто не пользуется.
  {
    guid: guid(ids.unusedSymbol), type: "SYMBOL", name: "Неиспользуемый", componentKey: "unused",
    parentIndex: parent(ids.internalCanvas, "b"), transform: matrix(), size: { x: 40, y: 20 },
  },
  {
    guid: guid(ids.unusedSymbolText), type: "TEXT", name: "Подпись",
    parentIndex: parent(ids.unusedSymbol, "a"), transform: matrix(), size: { x: 40, y: 20 },
    textData: { characters: "Никому не нужен" },
  },

  // Обычный корень служебного полотна — техническое содержимое библиотеки.
  {
    guid: guid(ids.libraryRoot), type: "FRAME", name: "Библиотечное полотно",
    parentIndex: parent(ids.internalCanvas, "c"), transform: matrix(), size: { x: 100, y: 100 },
  },

  // Пользовательская страница.
  {
    guid: guid(ids.userRoot), type: "FRAME", name: "Экран",
    parentIndex: parent(ids.userCanvas, "a"), transform: matrix(), size: { x: 200, y: 100 },
  },
  {
    guid: guid(ids.userOccurrence), type: "INSTANCE", name: "Вхождение",
    parentIndex: parent(ids.userRoot, "a"), transform: matrix(), size: { x: 40, y: 20 },
    symbolData: { symbolID: guid(ids.usedSymbol) },
  },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-internal-"));
try {
  var file = path.join(temp, "internal.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));

  // --- Признак internal читается из документа, а не из имени ---------------
  var internal = doc.tree.byKey.get(ids.internalCanvas);
  var user = doc.tree.byKey.get(ids.userCanvas);
  eq(doc.tree.pages.length, 2, "обе страницы найдены в документе");
  ok(PixDocument.isInternalPage(internal), "служебное полотно опознано структурно");
  ok(!PixDocument.isInternalPage(user),
    "страница с именем служебной, но без флага, остаётся пользовательской");
  eq(internal.internal, true, "флаг internalOnly декодирован в индексном проходе");

  // --- План full-document -------------------------------------------------
  var plan = Cli.createDocumentPlan(doc);
  eq(plan.pages.length, 1, "в план попала одна пользовательская страница");
  eq(plan.pages[0].pageId, ids.userCanvas, "это именно пользовательская страница");
  eq(plan.skipped.length, 1, "служебное полотно пропущено");
  eq(plan.skipped[0].pageId, ids.internalCanvas, "пропущено именно оно");
  eq(plan.skipped[0].marker, "CANVAS.internalOnly", "в отчёте назван структурный признак");
  eq(plan.skipped[0].roots, 3, "корни служебного полотна посчитаны, но не запланированы");

  var plannedRoots = plan.pages.reduce(function (sum, page) { return sum + page.roots.length; }, 0);
  eq(plannedRoots, 1, "как содержимое страниц едет только пользовательский корень");
  ok(!plan.pages.some(function (page) {
    return page.roots.some(function (root) { return root.key === ids.libraryRoot; });
  }), "корни служебного полотна не отправляются содержимым страницы");

  // --- Символы полотна остаются источником зависимостей --------------------
  var ir = MigrationIR.build(doc, { roots: [plan.pages[0].roots[0]] });
  var built = ir.definitions.map(function (definition) { return definition.definitionId; });
  ok(built.indexOf(ids.usedSymbol) >= 0,
    "символ служебного полотна собран определением для пользовательского вхождения");
  ok(built.indexOf(ids.unusedSymbol) < 0,
    "неиспользуемый символ библиотеки не собирается заранее");
  eq(ir.stats.definitionsBuilt, 1, "построено ровно одно нужное определение");
  eq(ir.stats.instancesEmitted, 1, "вхождение осталось нативным инстансом");

  var definition = ir.definitions[0];
  eq(definition.nodes.length, 2, "определение приехало собственным деревом");
  eq(definition.nodes[1].text.characters, "Из библиотеки",
    "содержимое библиотечного символа доехало через определение");

  // Корни служебного полотна не попадают в payload ни одним узлом.
  var shipped = ir.roots.reduce(function (all, root) { return all.concat(root.nodes); }, [])
    .concat(ir.definitions.reduce(function (all, item) { return all.concat(item.nodes); }, []));
  ok(!shipped.some(function (node) { return node.id === ids.libraryRoot; }),
    "техническое полотно не приехало ни как страница, ни как узел определения");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX служебное полотно — " + checks + " проверок пройдено\n");
