/**
 * Presence repeated-полей в записях override Pixso.
 *
 * Проверяется не конкретный документ, а общий контракт формата:
 *
 *   у ОБЫЧНОГО узла запись — полное состояние, и «красок нет» Pixso кодирует
 *   ОТСУТСТВИЕМ поля: пустого `fillPaints` у обычного узла не бывает;
 *
 *   у записи OVERRIDE запись — дельта, и repeated-поле выписывается пустым
 *   списком как ЗАГЛУШКА поля, которое вхождение не переопределяет.
 *
 * Измерение, из которого это следует (два независимых реальных документа):
 * пустой `fillPaints` встречается 19599 раз и ТОЛЬКО в записях override, при
 * нуле на 12000 обычных узлов; `vectorPaints`, `fontVariations`,
 * `prototypeInteractions`, `toggledOnOTFeatures` в записях override приходят
 * пустыми в 100% вхождений поля. Поле, которое всегда пустое, не может значить
 * «очистить».
 *
 * Отсюда инвариант, который держат тесты ниже: пустой repeated-список в записи
 * override НЕ ИМЕЕТ ПРАВА снять то, что уже стоит на узле.
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
  document: "40:1", library: "40:2", page: "40:3", style: "40:4", otherStyle: "40:5",
  symbol: "40:10", label: "40:11", root: "40:20",
  absent: "40:30", present: "40:31", styleBacked: "40:32", textOnly: "40:33",
  mixed: "40:34", zeroStyle: "40:35", unsupportedPaint: "40:36",
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
  // Стиль Pixso — обычный узел с заполненным styleType.
  {
    guid: guid(ids.style), type: "RECTANGLE", name: "brand/accent", styleType: "FILL",
    parentIndex: parent(ids.library, "b"), fillPaints: [solid(0, 128, 255)],
  },
  {
    guid: guid(ids.otherStyle), type: "RECTANGLE", name: "brand/muted", styleType: "FILL",
    parentIndex: parent(ids.library, "c"), fillPaints: [solid(200, 200, 200)],
  },
  {
    guid: guid(ids.symbol), type: "SYMBOL", name: "Control", componentKey: "control",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 100, y: 24 },
  },
  {
    guid: guid(ids.label), type: "TEXT", name: "Label", parentIndex: parent(ids.symbol, "a"),
    transform: matrix(), size: { x: 100, y: 24 }, textData: { characters: "Hello" },
    fontSize: 14, fillPaints: [solid(0, 0, 0)], strokePaints: [solid(10, 10, 10)],
    effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 64 }, offset: { x: 0, y: 2 }, radius: 4, visible: true, blendMode: "NORMAL", spread: 0 }],
  },
  { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 400, y: 400 } },

  // A. Repeated-поле сериализовано пустым списком рядом с настоящей правкой.
  occurrence(ids.absent, "a", targetOverride({
    fillPaints: [], strokePaints: [], effects: [], textData: { characters: "Changed" },
  })),
  // B. Repeated-поле сериализовано непустым списком — это правка.
  occurrence(ids.present, "b", targetOverride({ fillPaints: [solid(255, 0, 0)] })),
  // Пустой список рядом со ссылкой на стиль: краска приезжает из стиля.
  occurrence(ids.styleBacked, "c", targetOverride({
    fillPaints: [], inheritFillStyleID: guid(ids.style), textData: { characters: "Styled" },
  })),
  // D. Правка только текста — краски вообще не упомянуты.
  occurrence(ids.textOnly, "d", targetOverride({ textData: { characters: "TextOnly" } })),
  // E. В одной записи одно repeated-поле пустое, другое — заполненное.
  occurrence(ids.mixed, "e", targetOverride({
    fillPaints: [solid(0, 255, 0)], strokePaints: [], effects: [],
  })),
  // Нулевой GUID стиля рядом с пустым списком: снимок блока стилей, не приказ.
  occurrence(ids.zeroStyle, "f", targetOverride({
    fillPaints: [], inheritFillStyleID: { sessionID: 0, localID: 0 },
    textData: { characters: "Zeroed" },
  })),
  // Непустой список, целиком состоящий из неподдерживаемых красок.
  occurrence(ids.unsupportedPaint, "g", targetOverride({
    fillPaints: [{ type: "PATTERN", visible: true }], textData: { characters: "Pattern" },
  })),
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-repeated-presence-"));
try {
  var file = path.join(temp, "repeated.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));

  // --- Слой Kiwi: отсутствие поля и пустой список должны различаться --------
  function raw(id) { return doc.detail(doc.tree.byKey.get(id)).symbolData.symbolOverrides[0]; }
  var rawAbsent = raw(ids.absent);
  ok(hasOwn(rawAbsent, "fillPaints") && rawAbsent.fillPaints.length === 0,
    "decoder сохранил сериализованный пустой repeated-список");
  var rawTextOnly = raw(ids.textOnly);
  ok(!hasOwn(rawTextOnly, "fillPaints"),
    "decoder не материализовал отсутствующее repeated-поле");
  ok(!hasOwn(rawTextOnly, "strokePaints") && !hasOwn(rawTextOnly, "effects"),
    "отсутствие одного repeated-поля не выдумывает соседние");

  // Обычный узел: краски есть, и они не пустые.
  var labelDetail = doc.detail(doc.tree.byKey.get(ids.label));
  eq(labelDetail.fillPaints.length, 1, "у обычного узла краска сериализована непустым списком");

  // visualSafety выключен намеренно: тест про семантику записей override, а не
  // про то, разворачивает ли сборка «небезопасное» вхождение в обычные узлы.
  var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)], visualSafety: false });
  function nodeFor(id) {
    return ir.roots[0].nodes.filter(function (item) { return item.id === id; })[0];
  }
  function entryFor(id) {
    var node = nodeFor(id);
    ok(node && node.overrides && node.overrides.length === 1, "IR содержит override " + id);
    return node.overrides[0];
  }

  // --- A. Пустой repeated-список не несёт операции -------------------------
  var a = entryFor(ids.absent);
  eq(a.ops.characters, "Changed", "настоящая правка из той же записи доехала");
  ok(a.present.characters, "правка текста подтверждена presence");
  ok(!hasOwn(a.ops, "fills") && !a.present.fills, "пустой fillPaints не стал операцией");
  ok(!hasOwn(a.ops, "strokes") && !a.present.strokes, "пустой strokePaints не стал операцией");
  ok(!hasOwn(a.ops, "effects") && !a.present.effects, "пустой effects не стал операцией");

  // --- B. Непустой repeated-список — это правка ----------------------------
  var b = entryFor(ids.present);
  ok(b.present.fills, "непустой fillPaints имеет presence");
  eq(b.ops.fills.length, 1, "непустой fillPaints доехал операцией");
  eq(b.ops.fills[0].color.r, 1, "цвет правки не потерян");

  // --- Пустой список + стиль: краска берётся из стиля ----------------------
  var styled = entryFor(ids.styleBacked);
  ok(styled.present.fills, "ссылка на стиль при пустом списке даёт paint-операцию");
  eq(styled.ops.fills.length, 1, "краска стиля разрешена в конкретную заливку");
  eq(styled.ops.fills[0].color.b, 1, "разрешена именно краска указанного стиля");
  eq(styled.ops.characters, "Styled", "правка текста из той же записи не потеряна");

  // --- D. Текст меняется, краски остаются ----------------------------------
  var textOnly = entryFor(ids.textOnly);
  eq(textOnly.ops.characters, "TextOnly", "правка текста доехала");
  ok(!hasOwn(textOnly.ops, "fills") && !hasOwn(textOnly.ops, "strokes") &&
     !hasOwn(textOnly.ops, "effects"),
    "отсутствующие repeated-поля не превратились в очистку");

  // --- E. Соседнее непустое поле не делает пустое присутствующим -----------
  var mixed = entryFor(ids.mixed);
  ok(mixed.present.fills, "заполненный fillPaints присутствует");
  eq(mixed.ops.fills[0].color.g, 1, "заполненный fillPaints доехал своим значением");
  ok(!hasOwn(mixed.ops, "strokes") && !mixed.present.strokes,
    "пустой strokePaints не стал присутствующим из-за соседа");
  ok(!hasOwn(mixed.ops, "effects") && !mixed.present.effects,
    "пустой effects не стал присутствующим из-за соседа");

  // --- Нулевой GUID стиля не является доказанной очисткой ------------------
  var zeroStyle = entryFor(ids.zeroStyle);
  eq(zeroStyle.ops.characters, "Zeroed", "правка текста доехала");
  ok(!hasOwn(zeroStyle.ops, "fills") && !zeroStyle.present.fills,
    "нулевая ссылка на стиль при пустом списке не даёт очистки");

  // --- Схлопнувшееся отображение — это потеря, а не приказ стереть ---------
  var unsupported = entryFor(ids.unsupportedPaint);
  eq(unsupported.ops.characters, "Pattern", "правка текста доехала");
  ok(!hasOwn(unsupported.ops, "fills") && !unsupported.present.fills,
    "непереносимая краска не превратилась в пустой список-очистку");

  // --- Счётчики ------------------------------------------------------------
  // absent: fill+stroke+effects, styleBacked: -, mixed: stroke+effects,
  // zeroStyle: fill. Заглушек всего шесть, из них paint-овых — четыре.
  eq(ir.stats.emptyRepeatedOverridesIgnored, 6, "все заглушки посчитаны");
  eq(ir.stats.paintDefaultArrayIgnored, 4, "paint-заглушки посчитаны отдельно");
  eq(ir.stats.paintOverridesPresent, 4,
    "paint-операция засчитана там, где запись действительно несла краску");
  eq(ir.stats.paintOverridesApplied, 3, "три paint-операции доехали до ops");
  eq(ir.stats.paintOverridesDropped, 1, "схлопнувшееся отображение посчитано как потеря");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX presence repeated-полей — " + checks + " проверок пройдено\n");
