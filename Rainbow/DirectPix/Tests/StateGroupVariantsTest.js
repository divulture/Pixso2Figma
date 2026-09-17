/**
 * Группы состояний Pixso → нативные Figma COMPONENT_SET: сторона отправителя.
 *
 *   node DirectPix/Tests/StateGroupVariantsTest.js
 *
 * Проверяется ровно одно утверждение и его границы:
 *
 *   variant-координата берётся ТОЛЬКО из имени прямого SYMBOL-ребёнка узла,
 *   у которого структурно подтверждено `isStateGroup = true`, и только после
 *   сверки со словарём `stateGroupPropertyValueOrders` этой же группы.
 *
 * Всё остальное имя в Direct PIX по-прежнему не значит ничего. Поэтому в
 * фикстуре есть компонент, названный «State=Hover, Size=Large» и лежащий ВНЕ
 * группы состояний: он обязан остаться обычным самостоятельным компонентом.
 *
 * Несошедшаяся группа не чинится и не собирается наполовину: она получает
 * причину из фиксированного списка и целиком остаётся набором отдельных
 * компонентов. Ни один визуальный узел при этом не теряется.
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
var StateGroups = require("../StateGroups");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function deep(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function axis(property, values) { return { property: property, values: values }; }

var S = StateGroups.STATE_GROUP_STATUS;

// ---------------------------------------------------------------------------
// 1. Парсер координаты — грамматика и её отказы
// ---------------------------------------------------------------------------

(function parserGrammar() {
  var simple = StateGroups.parseVariantCoordinate("Size=Small, State=Default");
  eq(simple.error, null, "две пары разбираются");
  deep(simple.pairs, [{ axis: "Size", value: "Small" }, { axis: "State", value: "Default" }],
    "пары читаются в порядке имени");

  // Пробел внутри значения и внутри оси — не разделитель: в настоящих файлах
  // встречаются и «type=menu item», и ось «next/prev month day».
  var spaces = StateGroups.parseVariantCoordinate("type=menu item, next/prev month day=false");
  eq(spaces.error, null, "значение с пробелом разбирается");
  deep(spaces.pairs, [
    { axis: "type", value: "menu item" },
    { axis: "next/prev month day", value: "false" },
  ], "пробелы внутри оси и значения сохранены");

  // Обрезается только синтаксический пробел вокруг пары.
  var padded = StateGroups.parseVariantCoordinate("  size = m ,  state = hover  ");
  deep(padded.pairs, [{ axis: "size", value: "m" }, { axis: "state", value: "hover" }],
    "внешние пробелы пары обрезаны");

  eq(StateGroups.parseVariantCoordinate("Кнопка").error, S.COORDINATE_PARSE_FAILED,
    "имя без «=» координатой не является");
  eq(StateGroups.parseVariantCoordinate("").error, S.COORDINATE_PARSE_FAILED,
    "пустое имя координатой не является");
  eq(StateGroups.parseVariantCoordinate("=m").error, S.COORDINATE_PARSE_FAILED,
    "пара без имени оси отклоняется");
  eq(StateGroups.parseVariantCoordinate("size=m, size=l").error, S.DUPLICATE_AXIS,
    "повторная ось отклоняется");

  // Разделителем пары считается ПЕРВЫЙ «=»: остальное уходит в значение и
  // будет отклонено сверкой со словарём, а не принято половиной.
  deep(StateGroups.parseVariantCoordinate("size=a=b").pairs, [{ axis: "size", value: "a=b" }],
    "второй «=» остаётся частью значения");
}());

// ---------------------------------------------------------------------------
// 2. Документ-фикстура
// ---------------------------------------------------------------------------

var ids = {
  document: "7:1", library: "7:2", page: "7:3", root: "7:4",

  // A. Две оси × два значения — эталонная безопасная группа.
  buttonGroup: "7:10",
  buttonSD: "7:11", buttonSH: "7:12", buttonLD: "7:13", buttonLH: "7:14",

  // K. Вторая независимая группа с ТЕМИ ЖЕ строками осей и значений.
  chipGroup: "7:20", chipSD: "7:21", chipSH: "7:22",

  // G. Две одинаковые координаты.
  dupGroup: "7:30", dupA: "7:31", dupB: "7:32",

  // H. Значение вне словаря.
  unknownGroup: "7:40", unknownA: "7:41", unknownB: "7:42",

  // I. Ось названа не у всех участников.
  raggedGroup: "7:50", raggedA: "7:51", raggedB: "7:52",

  // Словаря нет вовсе.
  bareGroup: "7:60", bareA: "7:61",

  // J/P. Обычный компонент вне групп, названный как variant-координата.
  loneComponent: "7:70",

  // Вхождения.
  occSD: "7:80", occSH: "7:81", occLD: "7:82", occLH: "7:83",
  occChip: "7:84", occDup: "7:85", occUnknown: "7:86", occRagged: "7:87",
  occBare: "7:88", occLone: "7:89",
};

/** SYMBOL-участник группы: корень плюс один видимый прямоугольник. */
function member(symbolId, groupId, position, name, key) {
  return [
    {
      guid: guid(symbolId), type: "SYMBOL", name: name, componentKey: key,
      parentIndex: parent(groupId, position), transform: matrix(), size: { x: 100, y: 30 },
    },
    {
      guid: guid(symbolId + "9"), type: "RECTANGLE", name: "Фон",
      parentIndex: parent(symbolId, "a"), transform: matrix(), size: { x: 100, y: 30 },
    },
  ];
}

function occurrence(id, symbolId, position) {
  return {
    guid: guid(id), type: "INSTANCE", name: "вхождение " + id,
    parentIndex: parent(ids.root, position), transform: matrix(), size: { x: 100, y: 30 },
    symbolData: { symbolID: guid(symbolId) },
  };
}

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a"), internalOnly: true },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
  { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 600, y: 400 } },

  // --- A/B/C. Порядок осей в словаре НЕ алфавитный и НЕ совпадает с порядком
  // в исходных именах: только он имеет право задавать каноническое имя.
  {
    guid: guid(ids.buttonGroup), type: "FRAME", name: "Button", isStateGroup: true, componentKey: "shared-group-key",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 400, y: 100 },
    stateGroupPropertyValueOrders: [axis("Size", ["Small", "Large"]), axis("State", ["Default", "Hover"])],
  },
]
  // Порядок детей в документе намеренно перемешан относительно словаря.
  .concat(member(ids.buttonLH, ids.buttonGroup, "a", "State=Hover, Size=Large", "k-button"))
  .concat(member(ids.buttonSD, ids.buttonGroup, "b", "Size=Small, State=Default", "k-button"))
  .concat(member(ids.buttonLD, ids.buttonGroup, "c", "Size=Large, State=Default", "k-button"))
  .concat(member(ids.buttonSH, ids.buttonGroup, "d", "Size=Small, State=Hover", "k-button"))

  // --- K. Другая группа с теми же строками. Склеиться они не имеют права.
  .concat([{
    guid: guid(ids.chipGroup), type: "FRAME", name: "Chip", isStateGroup: true, componentKey: "shared-group-key",
    parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 400, y: 100 },
    stateGroupPropertyValueOrders: [axis("Size", ["Small", "Large"]), axis("State", ["Default", "Hover"])],
  }])
  .concat(member(ids.chipSD, ids.chipGroup, "a", "Size=Small, State=Default", "k-chip"))
  .concat(member(ids.chipSH, ids.chipGroup, "b", "Size=Small, State=Hover", "k-chip"))

  // --- G. Две одинаковые координаты.
  .concat([{
    guid: guid(ids.dupGroup), type: "FRAME", name: "Duplicate", isStateGroup: true,
    parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 200, y: 100 },
    stateGroupPropertyValueOrders: [axis("state", ["default"])],
  }])
  .concat(member(ids.dupA, ids.dupGroup, "a", "state=default", "k-dup-a"))
  .concat(member(ids.dupB, ids.dupGroup, "b", "state=default", "k-dup-b"))

  // --- H. Значение вне словаря.
  .concat([{
    guid: guid(ids.unknownGroup), type: "FRAME", name: "Unknown", isStateGroup: true,
    parentIndex: parent(ids.library, "d"), transform: matrix(), size: { x: 200, y: 100 },
    stateGroupPropertyValueOrders: [axis("state", ["default", "hover"])],
  }])
  .concat(member(ids.unknownA, ids.unknownGroup, "a", "state=default", "k-unknown-a"))
  .concat(member(ids.unknownB, ids.unknownGroup, "b", "state=pressed", "k-unknown-b"))

  // --- I. Один из участников не назвал вторую ось.
  .concat([{
    guid: guid(ids.raggedGroup), type: "FRAME", name: "Ragged", isStateGroup: true,
    parentIndex: parent(ids.library, "e"), transform: matrix(), size: { x: 200, y: 100 },
    stateGroupPropertyValueOrders: [axis("size", ["s", "m"]), axis("state", ["default"])],
  }])
  .concat(member(ids.raggedA, ids.raggedGroup, "a", "size=s, state=default", "k-ragged-a"))
  .concat(member(ids.raggedB, ids.raggedGroup, "b", "size=m", "k-ragged-b"))

  // --- Словаря нет: сверять координату не с чем.
  .concat([{
    guid: guid(ids.bareGroup), type: "FRAME", name: "Bare", isStateGroup: true,
    parentIndex: parent(ids.library, "f"), transform: matrix(), size: { x: 200, y: 100 },
  }])
  .concat(member(ids.bareA, ids.bareGroup, "a", "state=default", "k-bare"))

  // --- J/P. Компонент ВНЕ групп состояний с именем-координатой.
  .concat(member(ids.loneComponent, ids.library, "g", "State=Hover, Size=Large", "k-lone"))

  .concat([
    occurrence(ids.occSD, ids.buttonSD, "a"),
    occurrence(ids.occSH, ids.buttonSH, "b"),
    occurrence(ids.occLD, ids.buttonLD, "c"),
    occurrence(ids.occLH, ids.buttonLH, "d"),
    occurrence(ids.occChip, ids.chipSD, "e"),
    occurrence(ids.occDup, ids.dupA, "f"),
    occurrence(ids.occUnknown, ids.unknownA, "g"),
    occurrence(ids.occRagged, ids.raggedA, "h"),
    occurrence(ids.occBare, ids.bareA, "i"),
    occurrence(ids.occLone, ids.loneComponent, "j"),
  ]);

var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pix-variants-")), "variants.pix");
fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
var doc = PixDocument.load(PixContainer.open(file));

// ---------------------------------------------------------------------------
// 3. Реестр групп: вердикты структурные, причины — причинные
// ---------------------------------------------------------------------------

var registry = StateGroups.createRegistry(doc);
function record(id) { return doc.tree.byKey.get(id); }

var button = registry.evaluate(record(ids.buttonGroup));
eq(button.status, S.SAFE, "A. группа с полным набором координат безопасна");
eq(button.members.length, 4, "A. четыре участника");

// B. Порядок осей — из словаря, а не из имени участника и не по алфавиту.
deep(button.axes.map(function (entry) { return entry.property; }), ["Size", "State"],
  "B. порядок осей взят из stateGroupPropertyValueOrders");
deep(button.members.map(function (entry) { return entry.variantName; }), [
  "Size=Small, State=Default",
  "Size=Small, State=Hover",
  "Size=Large, State=Default",
  "Size=Large, State=Hover",
], "B/C. каноническое имя для combine и порядок участников следуют словарю источника");

// C. Порядок значений — исходный («Small» раньше «Large»), а не алфавитный.
ok(button.members[0].variantName.indexOf("Small") >= 0 &&
   button.members[3].variantName.indexOf("Large") >= 0,
  "C. значение из начала словаря идёт раньше");

// Исходное имя сохранено следом и не участвует в координате.
eq(button.memberById[ids.buttonLH].rawName, "State=Hover, Size=Large",
  "исходное имя Pixso сохранено как след");
eq(button.memberById[ids.buttonLH].variantName, "Size=Large, State=Hover",
  "имя для combine канонизировано");
eq(button.memberById[ids.buttonLH].rawName, "State=Hover, Size=Large",
  "точное имя Pixso хранится отдельно для post-combine restore");
eq(button.memberById[ids.buttonLH].coordinateKey, "Size=Large, State=Hover",
  "каноническая координата хранится отдельно от display-name");

// K. Одинаковые строки в двух группах — это две разные группы.
var chip = registry.evaluate(record(ids.chipGroup));
eq(chip.status, S.SAFE, "K. вторая группа тоже безопасна");
ok(chip.groupId !== button.groupId, "K. группы различаются идентичностью, а не именем");
eq(registry.memberOf(record(ids.chipSD)).groupId, ids.chipGroup,
  "K. участник второй группы принадлежит именно ей");
eq(registry.memberOf(record(ids.buttonSD)).groupId, ids.buttonGroup,
  "K. одинаковая координата не переносит участника в чужую группу");
eq(registry.memberOf(record(ids.buttonSD)).familyKey, ids.buttonGroup,
  "D39. materialization family остаётся в локальном GUID-space родителя");
eq(registry.memberOf(record(ids.chipSD)).familyKey, ids.chipGroup,
  "D39. второй локальный родитель не склеивается даже при том же componentKey/schema");
eq(registry.memberOf(record(ids.buttonSD)).stableFamilyKey, registry.memberOf(record(ids.chipSD)).stableFamilyKey,
  "D39. стабильное DS-родство сохраняется только как диагностика");

// D38. Локальный guid родителя не является identity семейства. Две копии
// одной DS с тем же componentKey и той же схемой получают один stable key;
// несовместимая ревизия с другим словарём значений — другой key.
var familyA = StateGroups.stableFamilyKey({ key: "1:1", componentKey: "stable-family" }, [
  { property: "state", order: ["default", "hover"] },
  { property: "size", order: ["s", "m"] },
]);
var familyB = StateGroups.stableFamilyKey({ key: "9:9", componentKey: "stable-family" }, [
  { property: "size", order: ["m", "s"] },
  { property: "state", order: ["hover", "default"] },
]);
var familyRevision = StateGroups.stableFamilyKey({ key: "9:10", componentKey: "stable-family" }, [
  { property: "size", order: ["s", "m", "l"] },
  { property: "state", order: ["default", "hover"] },
]);
eq(familyA, familyB, "D38. копии одной family сходятся по componentKey + совместимой schema");
ok(familyA !== familyRevision, "D38. несовместимая ревизия не склеивается по одному componentKey");

eq(registry.evaluate(record(ids.dupGroup)).status, S.DUPLICATE_COORDINATE,
  "G. две одинаковые координаты отклоняют группу целиком");
eq(registry.evaluate(record(ids.unknownGroup)).status, S.UNKNOWN_VALUE,
  "H. значение вне словаря отклоняет группу");
eq(registry.evaluate(record(ids.raggedGroup)).status, S.MISSING_AXIS,
  "I. неназванная ось отклоняет группу; значение не выдумывается");
eq(registry.evaluate(record(ids.bareGroup)).status, S.MISSING_PROPERTY_VALUE_ORDERS,
  "без словаря группа отклоняется");

// P. Имя-координата вне группы состояний не видно реестру вовсе.
eq(registry.memberOf(record(ids.loneComponent)), null,
  "P. компонент вне группы состояний вариантом не становится");
eq(registry.statusOf(record(ids.loneComponent)), null,
  "P. обычный компонент группой состояний не является");

// Участники отклонённых групп вариантами не считаются.
eq(registry.memberOf(record(ids.dupA)), null, "G. участник отклонённой группы вариантом не становится");
eq(registry.memberOf(record(ids.unknownB)), null, "H. участник отклонённой группы вариантом не становится");
eq(registry.memberOf(record(ids.raggedB)), null, "I. участник отклонённой группы вариантом не становится");

// ---------------------------------------------------------------------------
// 4. IR: что уезжает приёмнику
// ---------------------------------------------------------------------------

var ir = MigrationIR.build(doc, { roots: [record(ids.root)] });
var definitionById = Object.create(null);
ir.definitions.forEach(function (definition) { definitionById[definition.definitionId] = definition; });

function variantSetOf(id) {
  var definition = definitionById[id];
  ok(definition, "определение " + id + " собрано");
  return definition.variantSet;
}

// A. Все четыре участника безопасной группы уехали как члены одного семейства.
var families = {};
[ids.buttonSD, ids.buttonSH, ids.buttonLD, ids.buttonLH].forEach(function (id) {
  var descriptor = variantSetOf(id);
  ok(descriptor, "A. участник " + id + " несёт дескриптор семейства");
  families[descriptor.groupId] = (families[descriptor.groupId] || 0) + 1;
});
deep(Object.keys(families), [ids.buttonGroup], "A. все четыре участника в одном семействе");
eq(families[ids.buttonGroup], 4, "A. четыре члена семейства");

// B/C. Порядок в дескрипторе — исходный порядок осей и значений.
deep([ids.buttonSD, ids.buttonSH, ids.buttonLD, ids.buttonLH].map(function (id) {
  return variantSetOf(id).order;
}), [0, 1, 2, 3], "B/C. порядок членов задан словарём источника");

// Имя корневого узла определения сохраняет исходное Pixso-написание. Figma
// по-прежнему читает те же axis=value пары независимо от их порядка.
eq(definitionById[ids.buttonLH].nodes[0].name, "Size=Large, State=Hover",
  "до combine имя корня определения каноническое");
eq(variantSetOf(ids.buttonLH).coordinateKey, "Size=Large, State=Hover",
  "каноническая координата едет отдельно для identity/dedupe");
eq(variantSetOf(ids.buttonLH).sourceName, "State=Hover, Size=Large",
  "исходное имя Pixso уехало отдельным следом");

// J/P. Обычный компонент — без дескриптора, имя не тронуто.
eq(variantSetOf(ids.loneComponent), null, "J/P. обычный компонент семейством не обзавёлся");
eq(definitionById[ids.loneComponent].nodes[0].name, "State=Hover, Size=Large",
  "J/P. имя обычного компонента не переписано");

// Участники отклонённых групп: дескриптора нет, определение на месте, имя цело.
[[ids.dupA, "G"], [ids.unknownA, "H"], [ids.raggedA, "I"], [ids.bareA, "без словаря"]].forEach(function (pair) {
  eq(variantSetOf(pair[0]), null, pair[1] + ". участник отклонённой группы едет без дескриптора");
  ok(definitionById[pair[0]].nodes.length >= 2,
    pair[1] + ". визуальное содержимое отклонённой группы не потеряно");
});

// L. Данные Ticket 02 на месте: реестр публичной идентичности не тронут.
ok(ir.componentPropertyReport, "L. отчёт публичной идентичности свойств сохранён");
eq(ir.componentPropertyReport.registry ? typeof ir.componentPropertyReport.registry.definitionsIndexed : "number",
  "number", "L. реестр Ticket 02 продолжает работать");

// Отчёт по группам: причины причинные и погруппные.
var report = ir.stateGroupReport;
ok(report, "IR отдаёт отчёт по группам состояний");
eq(report.groupsSafe, 2, "безопасных групп две");
eq(report.groupsFallback, 4, "откатившихся групп четыре");
// D46. FULL знает полную formal Pixso state-group, но физически везёт только
// востребованный dependency closure текущего файла. Даже singleton-demand
// остаётся настоящим ComponentSet на стороне Figma: combineAsVariants принимает
// непустой список из одного ComponentNode.
eq(report.variantMembersEmitted, 5, "уехали только пять реально востребованных вариантов");
eq(report.membersInSafeGroups, 6, "source catalog по-прежнему знает все шесть участников safe groups");
eq(report.variantFamiliesClosed, 0, "обычный импорт не закрывает formal family целиком");
eq(report.variantFamilyMembersPulled, 0, "неиспользуемые sibling-варианты не подтягиваются");
eq(report.variantFamilyMembersDeferred, 1, "один неиспользуемый sibling остаётся только source metadata");
eq(definitionById[ids.chipSH], undefined, "D46. неиспользуемый Chip-вариант физически не материализован");
eq(variantSetOf(ids.chipSD).memberCountSource, 2, "дескриптор сохраняет полный размер source family");
eq(variantSetOf(ids.chipSD).memberCountDemanded, 1, "transported subset Chip содержит только востребованный variant");
eq(variantSetOf(ids.buttonSD).memberCountSource, 4, "второй дескриптор называет полный source размер");
eq(variantSetOf(ids.buttonSD).memberCountDemanded, 4, "для Button действительно востребованы все четыре варианта");
deep(Object.keys(report.fallbackByReason).sort(), [
  S.DUPLICATE_COORDINATE, S.MISSING_AXIS, S.MISSING_PROPERTY_VALUE_ORDERS, S.UNKNOWN_VALUE,
].sort(), "каждая откатившаяся группа названа своей причиной");

// Вхождения по-прежнему выбираются по symbolData.symbolID.
var occurrenceNodes = ir.roots[0].nodes.filter(function (node) { return node.kind === "INSTANCE"; });
eq(occurrenceNodes.length, 10, "все десять вхождений уехали нативными");
var chosen = Object.create(null);
occurrenceNodes.forEach(function (node) { chosen[node.id] = node.definitionId; });
eq(chosen[ids.occLH], ids.buttonLH, "D. вхождение выбрало участника по symbolID, а не по имени");
eq(chosen[ids.occSD], ids.buttonSD, "D. второе вхождение выбрало своего участника");
eq(chosen[ids.occChip], ids.chipSD, "K. вхождение чужого семейства не перепутано");
eq(chosen[ids.occDup], ids.dupA, "G. вхождение откатившейся группы осталось нативным");

process.stdout.write("OK: группы состояний → нативные варианты (отправитель) — " + checks + " проверок пройдено\n");
