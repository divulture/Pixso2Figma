/**
 * Presence-aware Direct PIX overrides.
 *
 * Каждая фикстура проверяет не имя или GUID конкретного дизайна, а
 * общий контракт: absent !== "" !== [] !== false. Значение в `ops`
 * недостаточно без отдельного доказательства `present`.
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
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function solid(r, g, b) {
  return { type: "SOLID", color: { r: r, g: g, b: b, a: 255 }, visible: true };
}

var ids = {
  document: "12:1", library: "12:2", page: "12:3", symbol: "12:10",
  label: "12:11", root: "12:20", fillOnly: "12:30", replace: "12:31",
  clear: "12:32", textOnly: "12:33", hide: "12:34", clearFill: "12:35",
};

function occurrence(id, position, rawOverride) {
  return {
    guid: guid(id), type: "INSTANCE", name: "Occurrence", parentIndex: parent(ids.root, position),
    transform: matrix(), size: { x: 100, y: 24 },
    symbolData: { symbolID: guid(ids.symbol), symbolOverrides: [rawOverride] },
  };
}

function targetOverride(fields) {
  return Object.assign({ guidPath: { guids: [guid(ids.label)] } }, fields);
}

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },
  { guid: guid(ids.symbol), type: "SYMBOL", name: "Control", componentKey: "control", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 100, y: 24 } },
  {
    guid: guid(ids.label), type: "TEXT", name: "Label", parentIndex: parent(ids.symbol, "a"),
    transform: matrix(), size: { x: 100, y: 24 }, textData: { characters: "Hello" },
    fontSize: 14, fillPaints: [solid(0, 0, 0)],
  },
  { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 300, y: 300 } },
  occurrence(ids.fillOnly, "a", targetOverride({ fillPaints: [solid(255, 0, 0)] })),
  occurrence(ids.replace, "b", targetOverride({ textData: { characters: "World" } })),
  occurrence(ids.clear, "c", targetOverride({ textData: { characters: "" } })),
  occurrence(ids.textOnly, "d", targetOverride({ textData: { characters: "Changed" } })),
  occurrence(ids.hide, "e", targetOverride({ visible: false })),
  occurrence(ids.clearFill, "f", targetOverride({ fillPaints: [] })),
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-presence-"));
try {
  var file = path.join(temp, "presence.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));

  var rawFill = doc.detail(doc.tree.byKey.get(ids.fillOnly)).symbolData.symbolOverrides[0];
  ok(hasOwn(rawFill, "fillPaints"), "raw сохранил явную fill-правку");
  ok(!hasOwn(rawFill, "textData"), "raw не материализовал отсутствующий textData");
  ok(!hasOwn(rawFill, "visible"), "raw не материализовал отсутствующую visibility");

  var rawClear = doc.detail(doc.tree.byKey.get(ids.clear)).symbolData.symbolOverrides[0];
  eq(rawClear.textData.characters, "", "явная пустая строка не стала absent");
  var rawHide = doc.detail(doc.tree.byKey.get(ids.hide)).symbolData.symbolOverrides[0];
  eq(rawHide.visible, false, "явный false не потерян Kiwi decoder");
  var rawClearFill = doc.detail(doc.tree.byKey.get(ids.clearFill)).symbolData.symbolOverrides[0];
  ok(hasOwn(rawClearFill, "fillPaints") && rawClearFill.fillPaints.length === 0,
    "Kiwi отличает сериализованный пустой список от отсутствующего поля");

  var ir = MigrationIR.build(doc, {
    roots: [doc.tree.byKey.get(ids.root)], traceTextOverrides: true, textOverrideTraceLimit: 10,
  });
  function entryFor(id) {
    var node = ir.roots[0].nodes.filter(function (item) { return item.id === id; })[0];
    ok(node && node.overrides && node.overrides.length === 1, "IR содержит override " + id);
    return node.overrides[0];
  }

  var fill = entryFor(ids.fillOnly);
  ok(fill.present.fills, "fill имеет явный presence в IR");
  ok(!hasOwn(fill.ops, "characters") && !fill.present.characters,
    "fill-only patch не создал дефолт characters");
  ok(fill.diagnostic.textTrace.rawOverrides[0].presentFields.indexOf("textData") < 0,
    "trace показывает raw absence textData");

  var replace = entryFor(ids.replace);
  eq(replace.ops.characters, "World", "явная замена текста доехала");
  ok(replace.present.characters, "явная замена помечена presence");
  ok(!replace.present.visible && !replace.present.fills && !replace.present.textStyle,
    "текстовый patch не выдумал visibility/paint/style");

  var clear = entryFor(ids.clear);
  eq(clear.ops.characters, "", "явная очистка текста доехала как пустая строка");
  ok(clear.present.characters, "пустая строка отличается от absent по presence");

  var textOnly = entryFor(ids.textOnly);
  ok(!hasOwn(textOnly.ops, "visible"), "missing visibility не превратилась в true/false");
  ok(!hasOwn(textOnly.ops, "fills") && !hasOwn(textOnly.ops, "textStyle"),
    "missing style/paint не превратились в clear");

  var hide = entryFor(ids.hide);
  eq(hide.ops.visible, false, "явная visibility=false доехала");
  ok(hide.present.visible, "visibility=false имеет presence");
  ok(!hasOwn(hide.ops, "characters"), "visibility patch не затронул текст");

  // Пустой repeated-список в записи override — заглушка сериализатора Pixso,
  // а не очистка (доказательство — в `PixNormalizer.overrideRepeated`). Запись,
  // где кроме него ничего нет, не несёт операции вовсе.
  var clearFillNode = ir.roots[0].nodes.filter(function (item) {
    return item.id === ids.clearFill;
  })[0];
  ok(clearFillNode, "вхождение с пустым fillPaints осталось в IR");
  eq((clearFillNode.overrides || []).length, 0,
    "пустой fillPaints не породил операцию очистки");
  eq(ir.stats.paintDefaultArrayIgnored, 1,
    "пустой список распознан как заглушка и посчитан отдельно");

  eq(ir.stats.textOverridesSeen, 3, "счётчик видит три явные текстовые правки");
  eq(ir.stats.explicitTextClears, 1, "счётчик отдельно видит явную очистку");
  eq(ir.stats.visibilityOverridesSeen, 1, "явная visibility посчитана отдельно");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX override presence — " + checks + " проверок пройдено\n");
