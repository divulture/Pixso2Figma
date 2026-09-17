/**
 * Устаревший кэш краски в записи override:
 *
 *   node DirectPix/Tests/OverrideStalePaintCacheTest.js
 *
 * Узел, привязанный к общему стилю, ДУБЛИРУЕТ у себя его значение: ссылка
 * `inherit*StyleID` — это идентичность, а список красок рядом — её кэш. Дельта
 * вхождения переживает обновление стиля, не переписывая свой кэш, и тогда два
 * поля ОДНОЙ записи говорят разное.
 *
 * Побеждает ссылка, и это измерение, а не вкус:
 *
 *   — у обычных узлов проверенного документа расхождения нет вообще
 *     (37016 записей «живой стиль + свои краски» — 37016 совпадений);
 *   — у записей override расхождений 989 из 40755;
 *   — у Pixso ЕСТЬ отдельное представление «краска своя, стиля нет» — нулевой
 *     `inherit*StyleID`. Раз оно есть, живая ссылка не может означать
 *     «краска рядом важнее»;
 *   — там, где автор подписал цвет рядом, подпись совпала со СТИЛЕМ 26 раз
 *     из 26 и с сырой краской ни разу.
 *
 * Пропуск этого правила красил вхождение устаревшим цветом И отменял привязку
 * к стилю: `bindPaints` выдаёт её только при совпадении значений.
 *
 * Фикстура синтетическая: production-код не знает её id, имён и геометрии.
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
function solid(r, g, b) {
  return { type: "SOLID", color: { r: r, g: g, b: b, a: 255 }, visible: true, blendMode: "NORMAL" };
}
function shared(key) { return { styleKey: key, versionHash: "1:1" }; }
function rgb(p) {
  if (!p || !p.length || !p[0].color) return "(none)";
  function q(v) { return ("0" + Math.round(v * 255).toString(16)).slice(-2); }
  return "#" + q(p[0].color.r) + q(p[0].color.g) + q(p[0].color.b);
}

var ids = {
  document: "9:1", library: "9:2", page: "9:3", root: "9:4",
  styleFresh: "9:10",              // стиль, который потребители и держат
  master: "9:20", masterLeaf: "9:21",
  stale: "9:30", agreeing: "9:31", detached: "9:32", noStyle: "9:33", emptyList: "9:34",
  ordinary: "9:40",
  zeroGuid: "0:0",
};

// Значение стиля СЕЙЧАС. Кэш в записях ниже намеренно отстал от него.
var STYLE_NOW = solid(14, 17, 23);      // #0e1117
var STALE_CACHE = solid(241, 243, 249); // #f1f3f9 — то, чем стиль был раньше
var OWN_COLOUR = solid(255, 0, 0);      // собственная краска автора

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

  { guid: guid(ids.styleFresh), type: "RECTANGLE", name: "light/fg/default", styleType: "FILL",
    parentIndex: parent(ids.library, "a"), sharedStyleReference: shared("key-fg-default"),
    fillPaints: [STYLE_NOW] },

  // Мастер: у листа своя краска, никакого стиля.
  { guid: guid(ids.master), type: "SYMBOL", name: "Swatch", componentKey: "swatch",
    parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 24, y: 24 } },
  { guid: guid(ids.masterLeaf), type: "RECTANGLE", name: "Chip",
    parentIndex: parent(ids.master, "a"), transform: matrix(), size: { x: 24, y: 24 },
    fillPaints: [solid(0, 85, 255)] },

  { guid: guid(ids.root), type: "FRAME", name: "Root",
    parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 200 } },

  // 1. Живой стиль + УСТАРЕВШИЙ кэш краски.
  { guid: guid(ids.stale), type: "INSTANCE", name: "Stale cache",
    parentIndex: parent(ids.root, "a"), transform: matrix(0, 0), size: { x: 24, y: 24 },
    symbolData: { symbolID: guid(ids.master), symbolOverrides: [
      { guidPath: { guids: [guid(ids.masterLeaf)] },
        fillPaints: [STALE_CACHE], inheritFillStyleID: guid(ids.styleFresh) },
    ] } },

  // 2. Живой стиль + кэш, который ещё не отстал.
  { guid: guid(ids.agreeing), type: "INSTANCE", name: "Agreeing cache",
    parentIndex: parent(ids.root, "b"), transform: matrix(0, 30), size: { x: 24, y: 24 },
    symbolData: { symbolID: guid(ids.master), symbolOverrides: [
      { guidPath: { guids: [guid(ids.masterLeaf)] },
        fillPaints: [STYLE_NOW], inheritFillStyleID: guid(ids.styleFresh) },
    ] } },

  // 3. Стиль ЯВНО снят нулевым guid — это и есть «краска своя».
  { guid: guid(ids.detached), type: "INSTANCE", name: "Detached",
    parentIndex: parent(ids.root, "c"), transform: matrix(0, 60), size: { x: 24, y: 24 },
    symbolData: { symbolID: guid(ids.master), symbolOverrides: [
      { guidPath: { guids: [guid(ids.masterLeaf)] },
        fillPaints: [OWN_COLOUR], inheritFillStyleID: guid(ids.zeroGuid) },
    ] } },

  // 4. Поля стиля в записи нет вовсе.
  { guid: guid(ids.noStyle), type: "INSTANCE", name: "No style field",
    parentIndex: parent(ids.root, "d"), transform: matrix(0, 90), size: { x: 24, y: 24 },
    symbolData: { symbolID: guid(ids.master), symbolOverrides: [
      { guidPath: { guids: [guid(ids.masterLeaf)] }, fillPaints: [OWN_COLOUR] },
    ] } },

  // 5. Пустой список красок рядом с живым стилем: список — заглушка.
  { guid: guid(ids.emptyList), type: "INSTANCE", name: "Empty list",
    parentIndex: parent(ids.root, "e"), transform: matrix(0, 120), size: { x: 24, y: 24 },
    symbolData: { symbolID: guid(ids.master), symbolOverrides: [
      { guidPath: { guids: [guid(ids.masterLeaf)] },
        fillPaints: [], inheritFillStyleID: guid(ids.styleFresh) },
    ] } },

  // 6. ОБЫЧНЫЙ узел: его запись — полное состояние, и правило прежнее.
  { guid: guid(ids.ordinary), type: "RECTANGLE", name: "Ordinary",
    parentIndex: parent(ids.root, "f"), transform: matrix(0, 150), size: { x: 24, y: 24 },
    fillPaints: [OWN_COLOUR], inheritFillStyleID: guid(ids.styleFresh) },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-stale-paint-"));
try {
  var file = path.join(temp, "stale.pix");
  fs.writeFileSync(file, Fixture.buildContainer({
    build: { nodes: nodes, blobs: [], resources: [] },
  }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)], visualSafety: true });
  var built = ir.roots[0].nodes;
  function specOf(id) { return built.filter(function (node) { return node.id === id; })[0]; }
  function leafOp(id) {
    var spec = specOf(id);
    var hit = (spec.overrides || []).filter(function (entry) {
      var last = entry.path[entry.path.length - 1];
      return last && last.sourceId === ids.masterLeaf;
    })[0];
    return hit ? hit.ops : null;
  }

  // 1. Устаревший кэш ---------------------------------------------------------
  var stale = leafOp(ids.stale);
  ok(stale, "запись с устаревшим кэшем доехала операцией");
  eq(rgb(stale.fills), "#0e1117", "краской стала величина ЖИВОГО стиля, а не устаревший кэш");
  ok(stale.fillStyleId, "и привязка к стилю выдана, а не отменена расхождением");
  eq(specOf(ids.stale).kind, "INSTANCE", "вхождение осталось нативным");

  // 2. Кэш совпал -------------------------------------------------------------
  var agreeing = leafOp(ids.agreeing);
  eq(rgb(agreeing.fills), "#0e1117", "совпавший кэш даёт ту же краску");
  eq(agreeing.fillStyleId, stale.fillStyleId,
    "и тот же самый стиль: устаревший кэш не создаёт второй");

  // 3. Стиль снят нулевым guid -----------------------------------------------
  var detached = leafOp(ids.detached);
  eq(rgb(detached.fills), "#ff0000",
    "нулевой inheritFillStyleID — это «краска своя»: она и остаётся");
  ok(!detached.fillStyleId, "и привязки к стилю у неё нет");

  // 4. Поля стиля нет ---------------------------------------------------------
  var noStyle = leafOp(ids.noStyle);
  eq(rgb(noStyle.fills), "#ff0000", "без поля стиля запись остаётся сырой краской");
  ok(!noStyle.fillStyleId, "и без привязки");

  // 5. Пустой список ----------------------------------------------------------
  var emptyList = leafOp(ids.emptyList);
  ok(emptyList, "пустой список рядом с живым стилем не отменяет операцию");
  eq(rgb(emptyList.fills), "#0e1117", "заглушка разрешается стилем, как и прежде");
  ok(emptyList.fillStyleId, "привязка на месте");

  // 6. Обычный узел -----------------------------------------------------------
  var ordinary = specOf(ids.ordinary);
  eq(rgb(ordinary.fills), "#ff0000",
    "у ОБЫЧНОГО узла правило прежнее: его запись — полное состояние");
  ok(!ordinary.styles || !ordinary.styles.fill,
    "расхождение со стилем по-прежнему отменяет привязку обычного узла");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("OK: устаревший кэш краски в записи override — " + checks + " проверок пройдено");
