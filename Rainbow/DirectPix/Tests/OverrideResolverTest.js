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
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }

var ids = {
  document: "7:1", library: "7:2", page: "7:3", root: "7:4", occurrence: "7:5",
  leafA: "7:10", leafAText: "7:11", leafB: "7:20", leafBText: "7:21",
  middleA: "7:30", middleALeaf: "7:31", middleB: "7:40", middleBLeaf: "7:41",
  wrapper: "7:50", wrapperMiddle: "7:51", invalid: "7:999",
  mirrorRich: "7:60", mirrorRichChild: "7:61", mirrorStub: "7:70",
  mirrorRichOccurrence: "7:80", mirrorStubOccurrence: "7:81",
  publishId: "900:1", overrideKeyChild: "900:2",
  // Вторая опубликованная пара: шаг пути записан САМИМ overrideKey, а узла с
  // таким guid в документе нет. Именно так адресует заглушку настоящий
  // `.pix` (шаги 42:565253 / 87:186688 / 4343:114851 у table / cell).
  keyedRich: "7:90", keyedRichChild: "7:91", keyedStub: "7:92",
  keyedRichOccurrence: "7:93", keyedStubOccurrence: "7:94",
  keyedPublishId: "901:1", keyedOverrideKeyChild: "901:2",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },

  { guid: guid(ids.leafA), type: "SYMBOL", name: "Leaf A", componentKey: "leaf-a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.leafAText), type: "TEXT", name: "Same name", parentIndex: parent(ids.leafA, "a"), transform: matrix(), size: { x: 20, y: 10 }, textData: { characters: "A" } },
  { guid: guid(ids.leafB), type: "SYMBOL", name: "Leaf B", componentKey: "leaf-b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.leafBText), type: "TEXT", name: "Same name", parentIndex: parent(ids.leafB, "a"), transform: matrix(), size: { x: 20, y: 10 }, textData: { characters: "B" } },

  { guid: guid(ids.middleA), type: "SYMBOL", name: "Middle A", componentKey: "middle-a", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 24, y: 24 } },
  { guid: guid(ids.middleALeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.middleA, "a"), transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.leafA) } },
  { guid: guid(ids.middleB), type: "SYMBOL", name: "Middle B", componentKey: "middle-b", parentIndex: parent(ids.library, "d"), transform: matrix(), size: { x: 24, y: 24 } },
  { guid: guid(ids.middleBLeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.middleB, "a"), transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.leafB) } },


  // D51 A1: two local mirrors of one exact published component. The active
  // mirror is a root-only stub, while the already-demanded rich mirror carries
  // the stable overrideKey of the child addressed by the occurrence override.
  { guid: guid(ids.mirrorRich), type: "SYMBOL", name: "Published mirror rich", componentKey: "mirror-key",
    publishFile: "file-published", publishID: guid(ids.publishId), parentIndex: parent(ids.library, "f"),
    transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.mirrorRichChild), overrideKey: guid(ids.overrideKeyChild), type: "FRAME", name: "Child",
    parentIndex: parent(ids.mirrorRich, "a"), transform: matrix(), size: { x: 10, y: 10 } },
  { guid: guid(ids.mirrorStub), type: "SYMBOL", name: "Published mirror stub", componentKey: "mirror-key",
    publishFile: "file-published", publishID: guid(ids.publishId), parentIndex: parent(ids.library, "g"),
    transform: matrix(), size: { x: 20, y: 20 } },
  // D52: та же публикация, но шаг пути — сам overrideKey, а не guid узла.
  { guid: guid(ids.keyedRich), type: "SYMBOL", name: "Keyed mirror rich", componentKey: "keyed-key",
    publishFile: "file-keyed", publishID: guid(ids.keyedPublishId), parentIndex: parent(ids.library, "h"),
    transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.keyedRichChild), overrideKey: guid(ids.keyedOverrideKeyChild), type: "FRAME", name: "Keyed child",
    parentIndex: parent(ids.keyedRich, "a"), transform: matrix(), size: { x: 10, y: 10 } },
  { guid: guid(ids.keyedStub), type: "SYMBOL", name: "Keyed mirror stub", componentKey: "keyed-key",
    publishFile: "file-keyed", publishID: guid(ids.keyedPublishId), parentIndex: parent(ids.library, "i"),
    transform: matrix(), size: { x: 20, y: 20 } },

  { guid: guid(ids.wrapper), type: "SYMBOL", name: "Wrapper", componentKey: "wrapper", parentIndex: parent(ids.library, "e"), transform: matrix(), size: { x: 30, y: 30 } },
  { guid: guid(ids.wrapperMiddle), type: "INSTANCE", name: "Middle", parentIndex: parent(ids.wrapper, "a"), transform: matrix(), size: { x: 24, y: 24 }, symbolData: { symbolID: guid(ids.middleA) } },

  { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
  { guid: guid(ids.mirrorRichOccurrence), type: "INSTANCE", name: "Rich first", parentIndex: parent(ids.root, "a0"),
    transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.mirrorRich) } },
  { guid: guid(ids.mirrorStubOccurrence), type: "INSTANCE", name: "Stub with rich-address override", parentIndex: parent(ids.root, "a1"),
    transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.mirrorStub), symbolOverrides: [
      { guidPath: { guids: [guid(ids.mirrorRichChild)] }, visible: false }
    ] } },
  { guid: guid(ids.keyedRichOccurrence), type: "INSTANCE", name: "Keyed rich first", parentIndex: parent(ids.root, "a2"),
    transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.keyedRich) } },
  // Шаг — overrideKey узла богатого зеркала. Узла с таким guid нет.
  { guid: guid(ids.keyedStubOccurrence), type: "INSTANCE", name: "Stub addressed by overrideKey", parentIndex: parent(ids.root, "a3"),
    transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.keyedStub), symbolOverrides: [
      { guidPath: { guids: [guid(ids.keyedOverrideKeyChild)] }, visible: false }
    ] } },
  {
    guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
    parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 30, y: 30 },
    symbolData: {
      symbolID: guid(ids.wrapper),
      symbolOverrides: [
        // Swap внешнего nested instance.
        { guidPath: { guids: [guid(ids.wrapperMiddle)] }, overriddenSymbolID: guid(ids.middleB) },
        // Второй swap адресуется уже внутри effective namespace Middle B.
        { guidPath: { guids: [guid(ids.wrapperMiddle), guid(ids.middleBLeaf)] }, overriddenSymbolID: guid(ids.leafA) },
        // Контент адресуется внутри effective namespace Leaf A.
        { guidPath: { guids: [guid(ids.wrapperMiddle), guid(ids.middleBLeaf), guid(ids.leafAText)] }, textData: { characters: "After two swaps" } },
        { guidPath: { guids: [guid(ids.wrapperMiddle), guid(ids.middleBLeaf), guid(ids.leafAText)] }, visible: false },
        // То же видимое имя есть в Leaf B, но invalid GUID нельзя угадывать по имени.
        { guidPath: { guids: [guid(ids.wrapperMiddle), guid(ids.middleBLeaf), guid(ids.invalid)] }, visible: false, name: "Same name" },
      ],
    },
  },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-override-"));
try {
  var file = path.join(temp, "nested.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  // Шлюз визуальной безопасности здесь выключен намеренно: проверяется сам
  // resolver. Его срабатывание на этом же материале проверяется ниже.
  var ir = MigrationIR.build(doc, {
    roots: [doc.tree.byKey.get(ids.root)], debugOverrides: true, visualSafety: false,
  });
  var occurrence = ir.roots[0].nodes.filter(function (node) { return node.id === ids.occurrence; })[0];
  ok(occurrence, "тестовый инстанс попал в IR");
  eq(occurrence.kind, "INSTANCE", "без шлюза вхождение осталось нативным инстансом");
  var stubOccurrence = ir.roots[0].nodes.filter(function (node) { return node.id === ids.mirrorStubOccurrence; })[0];
  ok(stubOccurrence && stubOccurrence.overrides && stubOccurrence.overrides.length === 1,
    "root-only published mirror resolved one override through the rich twin");
  eq(stubOccurrence.overrides[0].path[0].sourceOverrideKey, ids.overrideKeyChild,
    "translated hop retains the exact stable overrideKey evidence");
  eq(stubOccurrence.overrides[0].ops.visible, false,
    "translated published-mirror override keeps its low-level value");
  // D52: тот же перевод, но шаг записан самим overrideKey — узла с таким guid
  // в документе нет. Это форма адреса из настоящего `.pix`, и до D52 она не
  // разрешалась вовсе.
  var keyedStubOccurrence = ir.roots[0].nodes.filter(function (node) { return node.id === ids.keyedStubOccurrence; })[0];
  ok(keyedStubOccurrence && keyedStubOccurrence.overrides && keyedStubOccurrence.overrides.length === 1,
    "шаг, записанный самим overrideKey, разрешён через богатого близнеца публикации");
  eq(keyedStubOccurrence.overrides[0].path[0].sourceOverrideKey, ids.keyedOverrideKeyChild,
    "переведённый шаг несёт тот же стабильный overrideKey");
  eq(keyedStubOccurrence.overrides[0].ops.visible, false,
    "значение низкоуровневой правки сохранено при переводе");
  // D52: заглушка публикации теперь наполняется содержимым единственного
  // заполненного близнеца ещё на сборке определения. Обе формы адреса после
  // этого разрешаются обычным путём, и перевод по overrideKey остаётся только
  // страховкой для случаев, где наполнить нечем. Поэтому здесь проверяется
  // не число переводов, а то, что обе правки доехали до своих целей.
  eq(ir.stats.definitionsHydratedFromPublicationTwin, 2,
    "обе заглушки публикации наполнены содержимым своего близнеца");
  ok(ir.stats.overrideStepsResolvedByOverrideKey <= 2,
    "перевод по overrideKey не выдумывает лишних шагов");
  eq(occurrence.overrides.length, 3, "два swaps и две content-правки сгруппированы по трём точным целям");

  var outerSwap = occurrence.overrides.filter(function (entry) { return entry.ops.swapDefinitionId === ids.middleB; })[0];
  var innerSwap = occurrence.overrides.filter(function (entry) { return entry.ops.swapDefinitionId === ids.leafA; })[0];
  var content = occurrence.overrides.filter(function (entry) { return entry.ops.characters; })[0];
  ok(outerSwap && innerSwap && content, "все зависимые фазы представлены явно");
  eq(outerSwap.path[0].sourceId, ids.wrapperMiddle, "первый swap адресован stable source GUID");
  eq(innerSwap.path.length, 2, "второй swap прошёл переключение namespace");
  eq(innerSwap.path[1].sourceId, ids.middleBLeaf, "цель второго swap взята из Middle B, а не Middle A");
  eq(content.path.length, 3, "контент после двух swaps получил полный составной путь");
  eq(content.path[2].sourceId, ids.leafAText, "текст найден в effective Leaf A namespace");
  eq(content.ops.characters, "After two swaps", "текстовая правка сохранена после swaps");
  eq(content.ops.visible, false, "visibility после swaps объединена с той же целью");
  ok(content.diagnostic.nestedComponentSwapEncountered, "диагностика фиксирует namespace switch");

  eq(ir.unsupported.OVERRIDE_TARGET, 1, "invalid guidPath остался miss");
  eq(ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION, 1, "miss получил системную причину");
  eq(ir.overrideResolutionSamples[0].detail.expectedTargetGuid, ids.invalid, "в sample есть ожидаемый GUID");
  ok(!occurrence.overrides.some(function (entry) { return entry.diagnostic.expectedTargetGuid === ids.invalid; }),
    "resolver не использовал name fallback для invalid GUID");
  eq(ir.stats.overridesAttempted, 6,
    "в IR посчитаны шесть реально отправляемых операций, включая обе формы адреса stub-близнеца");
  eq(ir.stats.nativeInstancesWithLostState, 1,
    "вхождение с недоехавшим состоянием посчитано отдельно");

  // --- Шлюз визуальной безопасности ------------------------------------
  // Та же сборка с включённым шлюзом обязана предпочесть визуально верное
  // поддерево нативному инстансу, у которого часть состояния потеряна.
  var safe = MigrationIR.build(doc, {
    roots: [doc.tree.byKey.get(ids.root)], debugOverrides: true,
  });
  var safeOccurrence = safe.roots[0].nodes.filter(function (node) { return node.id === ids.occurrence; })[0];
  ok(safeOccurrence, "вхождение осталось в дереве и после отказа от нативного инстанса");
  eq(safeOccurrence.kind, "ORDINARY", "вхождение приехало развёрнутым поддеревом");
  eq(safe.stats.nativeInstanceFallbacks, 1, "фоллбек посчитан");
  eq(safe.stats.nativeFallbackByReason.TARGET_GUID_NOT_IN_DEFINITION, 1,
    "причина фоллбека названа, а не свалена в общий счётчик");
  ok(safeOccurrence.directPixVisualFallback, "узел помечен причиной фоллбека");
  ok(safe.roots[0].nodes.some(function (node) { return node.parent === ids.occurrence; }),
    "содержимое вхождения действительно построено, а не потеряно");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX override resolver — " + checks + " проверок пройдено\n");
