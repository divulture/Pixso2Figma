/**
 * Подмена, объявленная ВНУТРИ мастера:
 *
 *   node DirectPix/Tests/DefinitionInternalSwapTest.js
 *
 * Вхождение внутри определения — такой же инстанс со своими
 * `symbolOverrides`, и оно имеет право подменить вложенный компонент. Эта
 * подмена принадлежит содержимому мастера: её видят ВСЕ его вхождения сразу,
 * и ни в одной записи самого вхождения она не повторяется.
 *
 * Раньше адресация правок вхождения её не знала: активным символом считался
 * объявленный `symbolId` подменённого узла, путь уходил в дерево
 * НЕподменённого компонента и запись падала как
 * `TARGET_GUID_NOT_IN_DEFINITION`. Одного мёртвого адреса достаточно, чтобы
 * вхождение было признано визуально небезопасным, а шлюз безопасности
 * разворачивает такое вхождение в обычные фреймы. Наблюдалось это как
 * «компонент приезжает разобранным, да ещё и с состоянием мастера вместо
 * своего».
 *
 * Фикстура синтетическая: production-код не знает её id, имён и геометрии.
 *
 * Утверждения:
 *
 *   — вхождение остаётся НАТИВНЫМ инстансом, а не разворачивается во фреймы;
 *   — правка, адресованная внутрь подменённого поддерева, доезжает;
 *   — адрес считается в подменённом определении, а не в объявленном;
 *   — подмена видна вхождению, которое о ней нигде не писало;
 *   — собственная подмена вхождения ПЕРЕКРЫВАЕТ объявленную мастером:
 *     она ближе к вхождению;
 *   — guid, которого нет ни в объявленном, ни в подменённом дереве, по-прежнему
 *     отклоняется с названной причиной: правило не стало догадкой.
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

var ids = {
  document: "8:1", library: "8:2", page: "8:3", root: "8:4",
  // Три варианта одного вложенного компонента.
  leafDeclared: "8:10", leafDeclaredText: "8:11",
  leafByMaster: "8:20", leafByMasterText: "8:21",
  leafByOccurrence: "8:30", leafByOccurrenceText: "8:31",
  // Промежуточный компонент, внутри которого живёт подменяемый узел.
  inner: "8:40", innerSlot: "8:41",
  // Мастер. Его содержимое и объявляет подмену.
  master: "8:50", masterWrapper: "8:51", masterInnerSlot: "8:52",
  // Вхождения мастера.
  occurrence: "8:60", occurrenceOwnSwap: "8:61", occurrenceBadTarget: "8:62",
  unrelated: "8:70",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

  // --- три взаимозаменяемых варианта вложенного компонента ------------------
  { guid: guid(ids.leafDeclared), type: "SYMBOL", name: "Leaf declared", componentKey: "leaf-declared",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 40, y: 10 } },
  { guid: guid(ids.leafDeclaredText), type: "TEXT", name: "Declared text",
    parentIndex: parent(ids.leafDeclared, "a"), transform: matrix(), size: { x: 40, y: 10 },
    textData: { characters: "declared" } },

  { guid: guid(ids.leafByMaster), type: "SYMBOL", name: "Leaf by master", componentKey: "leaf-by-master",
    parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 40, y: 10 } },
  { guid: guid(ids.leafByMasterText), type: "TEXT", name: "Master text",
    parentIndex: parent(ids.leafByMaster, "a"), transform: matrix(), size: { x: 40, y: 10 },
    textData: { characters: "by master" } },

  { guid: guid(ids.leafByOccurrence), type: "SYMBOL", name: "Leaf by occurrence", componentKey: "leaf-by-occurrence",
    parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 40, y: 10 } },
  { guid: guid(ids.leafByOccurrenceText), type: "TEXT", name: "Occurrence text",
    parentIndex: parent(ids.leafByOccurrence, "a"), transform: matrix(), size: { x: 40, y: 10 },
    textData: { characters: "by occurrence" } },

  // --- промежуточный компонент ---------------------------------------------
  { guid: guid(ids.inner), type: "SYMBOL", name: "Inner", componentKey: "inner",
    parentIndex: parent(ids.library, "d"), transform: matrix(), size: { x: 40, y: 10 } },
  { guid: guid(ids.innerSlot), type: "INSTANCE", name: "Slot",
    parentIndex: parent(ids.inner, "a"), transform: matrix(), size: { x: 40, y: 10 },
    symbolData: { symbolID: guid(ids.leafDeclared) } },

  // --- мастер ---------------------------------------------------------------
  // Подменяющее вхождение лежит НЕ прямым ребёнком мастера, а внутри обычного
  // контейнера: guid-путь записи override такие контейнеры не перечисляет, и
  // адрес подмены обязан сходиться всё равно.
  { guid: guid(ids.master), type: "SYMBOL", name: "Master", componentKey: "master",
    parentIndex: parent(ids.library, "e"), transform: matrix(), size: { x: 40, y: 10 } },
  { guid: guid(ids.masterWrapper), type: "FRAME", name: "Wrapper",
    parentIndex: parent(ids.master, "a"), transform: matrix(), size: { x: 40, y: 10 } },
  { guid: guid(ids.masterInnerSlot), type: "INSTANCE", name: "Inner slot",
    parentIndex: parent(ids.masterWrapper, "a"), transform: matrix(), size: { x: 40, y: 10 },
    symbolData: {
      symbolID: guid(ids.inner),
      // Вот она: содержимое мастера подменяет вложенный компонент.
      symbolOverrides: [
        { guidPath: { guids: [guid(ids.innerSlot)] }, overriddenSymbolID: guid(ids.leafByMaster) },
      ],
    } },

  { guid: guid(ids.root), type: "FRAME", name: "Root",
    parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 200 } },

  // --- вхождение, которое о подмене нигде не писало -------------------------
  { guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
    parentIndex: parent(ids.root, "a"), transform: matrix(0, 0), size: { x: 40, y: 10 },
    symbolData: {
      symbolID: guid(ids.master),
      symbolOverrides: [
        // Адрес внутри ПОДМЕНЁННОГО поддерева. Узла с этим guid в объявленном
        // `Leaf declared` нет вовсе.
        { guidPath: { guids: [guid(ids.masterInnerSlot), guid(ids.innerSlot), guid(ids.leafByMasterText)] },
          textData: { characters: "reached the swapped leaf" } },
      ],
    } },

  // --- вхождение со своей подменой ------------------------------------------
  { guid: guid(ids.occurrenceOwnSwap), type: "INSTANCE", name: "Occurrence own swap",
    parentIndex: parent(ids.root, "b"), transform: matrix(0, 20), size: { x: 40, y: 10 },
    symbolData: {
      symbolID: guid(ids.master),
      symbolOverrides: [
        { guidPath: { guids: [guid(ids.masterInnerSlot), guid(ids.innerSlot)] },
          overriddenSymbolID: guid(ids.leafByOccurrence) },
        { guidPath: { guids: [guid(ids.masterInnerSlot), guid(ids.innerSlot), guid(ids.leafByOccurrenceText)] },
          textData: { characters: "occurrence wins" } },
      ],
    } },

  // --- вхождение с заведомо чужим адресом -----------------------------------
  { guid: guid(ids.occurrenceBadTarget), type: "INSTANCE", name: "Occurrence bad target",
    parentIndex: parent(ids.root, "c"), transform: matrix(0, 40), size: { x: 40, y: 10 },
    symbolData: {
      symbolID: guid(ids.master),
      symbolOverrides: [
        // Этот узел не лежит ни в объявленном, ни в подменённом поддереве.
        { guidPath: { guids: [guid(ids.masterInnerSlot), guid(ids.innerSlot), guid(ids.unrelated)] },
          visible: false },
      ],
    } },

  // Узел-чужак: существует в документе, но к подменяемому слоту отношения
  // не имеет. Нужен, чтобы отказ был отказом адресации, а не «нет в документе».
  { guid: guid(ids.unrelated), type: "RECTANGLE", name: "Unrelated",
    parentIndex: parent(ids.root, "d"), transform: matrix(0, 60), size: { x: 10, y: 10 },
    fillPaints: [solid(1, 2, 3)] },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-internal-swap-"));
try {
  var file = path.join(temp, "internal-swap.pix");
  fs.writeFileSync(file, Fixture.buildContainer({
    build: { nodes: nodes, blobs: [], resources: [] },
  }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var ir = MigrationIR.build(doc, {
    roots: [doc.tree.byKey.get(ids.root)], visualSafety: true, debugOverrides: true,
  });
  var built = ir.roots[0].nodes;
  function specOf(id) { return built.filter(function (node) { return node.id === id; })[0]; }
  function overrideAt(spec, sourceId) {
    return (spec.overrides || []).filter(function (entry) {
      var last = entry.path[entry.path.length - 1];
      return last && last.sourceId === sourceId;
    })[0];
  }

  // --- вхождение, которое о подмене не писало -------------------------------
  var occurrence = specOf(ids.occurrence);
  ok(occurrence, "вхождение мастера построено");
  eq(occurrence.kind, "INSTANCE",
    "вхождение осталось нативным инстансом, а не развернулось в обычные фреймы");
  eq(occurrence.definitionId, ids.master, "и это инстанс своего мастера");

  var reached = overrideAt(occurrence, ids.leafByMasterText);
  ok(reached, "правка внутрь подменённого мастером поддерева доехала");
  eq(reached.ops.characters, "reached the swapped leaf", "и принесла своё значение");
  eq(reached.path[reached.path.length - 1].definitionId, ids.leafByMaster,
    "адрес посчитан в ПОДМЕНЁННОМ определении, а не в объявленном");
  ok(!ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION ||
     ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION === 1,
    "единственный оставшийся отказ адресации — намеренно чужой адрес");
  ok(ir.stats.definitionInternalSwapsIndexed >= 1, "подмена из содержимого мастера проиндексирована");
  ok(ir.stats.definitionInternalSwapsApplied >= 1, "и была применена при разборе адреса");

  // --- своя подмена вхождения перекрывает объявленную мастером --------------
  var ownSwap = specOf(ids.occurrenceOwnSwap);
  eq(ownSwap.kind, "INSTANCE", "вхождение со своей подменой тоже осталось нативным");
  var ownReached = overrideAt(ownSwap, ids.leafByOccurrenceText);
  ok(ownReached, "правка внутрь собственного подменённого поддерева доехала");
  eq(ownReached.ops.characters, "occurrence wins", "и принесла своё значение");
  eq(ownReached.path[ownReached.path.length - 1].definitionId, ids.leafByOccurrence,
    "собственная подмена вхождения перекрыла объявленную мастером");
  ok(!overrideAt(ownSwap, ids.leafByMasterText),
    "адрес в перекрытом поддереве мастера у этого вхождения не появился");

  // --- чужой адрес по-прежнему отклоняется ----------------------------------
  var badTarget = specOf(ids.occurrenceBadTarget);
  ok(badTarget, "вхождение с чужим адресом построено");
  ok(!overrideAt(badTarget, ids.unrelated),
    "чужой guid не притянут ни к объявленному, ни к подменённому дереву");
  eq(ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION, 1,
    "отказ адресации назван вслух: правило осталось точным, а не стало догадкой");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("OK: подмена внутри мастера — " + checks + " проверок пройдено");
