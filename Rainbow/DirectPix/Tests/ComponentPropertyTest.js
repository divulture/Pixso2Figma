/**
 * Свойства компонента как источник адресации override.
 *
 * Структура фикстуры повторяет то, что лежит в настоящем `.pix`:
 *
 *   SYMBOL «строка меню»
 *     componentPropDef  icon  : INSTANCE_SWAP
 *     componentPropDef  label : TEXT
 *     componentPropDef  extra : BOOL
 *     INSTANCE иконки  componentPropRef icon  -> OVERRIDDEN_SYMBOL_ID
 *     TEXT подписи     componentPropRef label -> TEXT_DATA
 *     FRAME довеска    componentPropRef extra -> VISIBLE
 *
 * Вхождение присылает `componentPropAssignment`, а следующие записи override
 * адресуют узлы уже ВНУТРИ назначенной свойством иконки. Без разбора этой
 * связки такой путь упирается в чужой символ: на настоящем файле это и была
 * основная причина промахов адресации.
 *
 * Ни одно решение здесь не принимается по имени слоя.
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
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function ref(id, field) { return { defID: guid(id), componentPropNodeField: field }; }

var ids = {
  document: "8:1", library: "8:2", page: "8:3",
  defaultIcon: "8:10", defaultIconVector: "8:11",
  assignedIcon: "8:20", assignedIconVector: "8:21",
  row: "8:30", rowIcon: "8:31", rowLabel: "8:32", rowExtra: "8:33", rowNested: "8:34",
  nested: "8:50", nestedChild: "8:51",
  propIcon: "8:90", propLabel: "8:91", propExtra: "8:92", nestedProp: "8:93",
  root: "8:40", occurrence: "8:41", plain: "8:42", conflict: "8:43", materialized: "8:44",
};

function iconSymbol(symbolId, vectorId, name) {
  return [
    {
      guid: guid(symbolId), type: "SYMBOL", name: name, componentKey: "icon-" + name,
      parentIndex: parent(ids.library, symbolId), transform: matrix(), size: { x: 20, y: 20 },
    },
    {
      guid: guid(vectorId), type: "FRAME", name: "Vector",
      parentIndex: parent(symbolId, "a"), transform: matrix(), size: { x: 20, y: 20 },
    },
  ];
}

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a"), internalOnly: true },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
]
  .concat(iconSymbol(ids.defaultIcon, ids.defaultIconVector, "default"))
  .concat(iconSymbol(ids.assignedIcon, ids.assignedIconVector, "assigned"))
  .concat([
    {
      guid: guid(ids.nested), type: "SYMBOL", name: "Nested control", componentKey: "nested-control",
      parentIndex: parent(ids.library, "y"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropDef: [
        { id: guid(ids.nestedProp), name: "shown", type: "BOOL" },
      ],
    },
    {
      guid: guid(ids.nestedChild), type: "FRAME", name: "Nested child",
      parentIndex: parent(ids.nested, "a"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropRef: [ref(ids.nestedProp, "VISIBLE")],
    },
    {
      guid: guid(ids.row), type: "SYMBOL", name: "Строка меню", componentKey: "row",
      parentIndex: parent(ids.library, "z"), transform: matrix(), size: { x: 200, y: 24 },
      componentPropDef: [
        { id: guid(ids.propIcon), name: "icon", type: "INSTANCE_SWAP" },
        { id: guid(ids.propLabel), name: "label", type: "TEXT" },
        { id: guid(ids.propExtra), name: "extra", type: "BOOL" },
      ],
    },
    {
      guid: guid(ids.rowIcon), type: "INSTANCE", name: "Иконка",
      parentIndex: parent(ids.row, "a"), transform: matrix(), size: { x: 20, y: 20 },
      symbolData: { symbolID: guid(ids.defaultIcon) },
      componentPropRef: [ref(ids.propIcon, "OVERRIDDEN_SYMBOL_ID")],
    },
    {
      guid: guid(ids.rowLabel), type: "TEXT", name: "Подпись",
      parentIndex: parent(ids.row, "b"), transform: matrix(), size: { x: 100, y: 20 },
      textData: { characters: "По умолчанию" },
      componentPropRef: [ref(ids.propLabel, "TEXT_DATA")],
    },
    {
      guid: guid(ids.rowExtra), type: "FRAME", name: "Довесок",
      parentIndex: parent(ids.row, "c"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropRef: [ref(ids.propExtra, "VISIBLE")],
    },
    {
      guid: guid(ids.rowNested), type: "INSTANCE", name: "Nested",
      parentIndex: parent(ids.row, "d"), transform: matrix(), size: { x: 20, y: 20 },
      symbolData: { symbolID: guid(ids.nested) },
    },

    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 400, y: 200 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Строка",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 200, y: 24 },
      symbolData: {
        symbolID: guid(ids.row),
        symbolOverrides: [
          // Значения свойств вхождения: подмена иконки, текст, видимость.
          {
            guidPath: { guids: [] },
            componentPropAssignment: [
              { defID: guid(ids.propIcon), value: { guidValue: guid(ids.assignedIcon) } },
              { defID: guid(ids.propLabel), value: { textValue: { characters: "Из свойства" } } },
              { defID: guid(ids.propExtra), value: { boolValue: false } },
            ],
          },
          // Правка узла ВНУТРИ назначенной свойством иконки. Этот guid живёт
          // в `assignedIcon`, а не в `defaultIcon`, на который смотрит узел.
          { guidPath: { guids: [guid(ids.rowIcon), guid(ids.assignedIconVector)] }, opacity: 0.5 },
        ],
      },
    },
    // Pixso может сериализовать semantic BOOLEAN и raw visibility одного
    // bound-слоя одновременно. По официальной модели componentPropertyReferences
    // поле visible принадлежит component property, поэтому semantic assignment
    // должен быть единственным владельцем этого поля.
    {
      guid: guid(ids.conflict), type: "INSTANCE", name: "Строка с visual conflict",
      parentIndex: parent(ids.root, "b"), transform: matrix(0, 40), size: { x: 200, y: 24 },
      symbolData: {
        symbolID: guid(ids.row),
        symbolOverrides: [
          { guidPath: { guids: [] }, componentPropAssignment: [
            { defID: guid(ids.propExtra), value: { boolValue: true } },
          ] },
          { guidPath: { guids: [guid(ids.rowExtra)] }, visible: false },
        ],
      },
    },
    // D51 A2: Pixso may co-locate a public assignment and the low-level
    // materialized trace of that same assignment in ONE override record. The
    // raw field is fallback-only and must carry native ownership provenance.
    {
      guid: guid(ids.materialized), type: "INSTANCE", name: "Строка с materialized trace",
      parentIndex: parent(ids.root, "c"), transform: matrix(0, 80), size: { x: 200, y: 24 },
      symbolData: {
        symbolID: guid(ids.row),
        symbolOverrides: [
          {
            guidPath: { guids: [guid(ids.rowNested)] },
            componentPropAssignment: [
              { defID: guid(ids.nestedProp), value: { boolValue: false } },
            ],
            visible: false,
            opacity: 0.4,
          },
        ],
      },
    },
    // Вхождение без единого назначения: свойства не должны ничего выдумывать.
    {
      guid: guid(ids.plain), type: "INSTANCE", name: "Строка по умолчанию",
      parentIndex: parent(ids.root, "d"), transform: matrix(0, 120), size: { x: 200, y: 24 },
      symbolData: { symbolID: guid(ids.row) },
    },
  ]);

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-props-"));
try {
  var file = path.join(temp, "props.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)], debugOverrides: true });

  var rootNodes = ir.roots[0].nodes;
  var occurrence = rootNodes.filter(function (node) { return node.id === ids.occurrence; })[0];
  var conflict = rootNodes.filter(function (node) { return node.id === ids.conflict; })[0];
  var plain = rootNodes.filter(function (node) { return node.id === ids.plain; })[0];
  var materialized = rootNodes.filter(function (node) { return node.id === ids.materialized; })[0];
  ok(occurrence && conflict && materialized && plain, "все вхождения попали в IR");

  var swap = occurrence.overrides.filter(function (entry) { return entry.ops.swapDefinitionId; })[0];
  var label = occurrence.overrides.filter(function (entry) { return entry.ops.characters !== undefined; })[0];
  var extra = occurrence.overrides.filter(function (entry) { return entry.ops.visible !== undefined; })[0];
  var deep = occurrence.overrides.filter(function (entry) { return entry.ops.opacity !== undefined; })[0];

  // --- Значения свойств превращаются в адресуемые операции -----------------
  ok(swap, "INSTANCE_SWAP превратился в подмену компонента");
  eq(swap.ops.swapDefinitionId, ids.assignedIcon, "подменяется именно назначенный символ");
  eq(swap.path.length, 1, "цель подмены — узел определения, читающий свойство");
  eq(swap.path[0].sourceId, ids.rowIcon, "адрес взят из componentPropRef, а не из имени слоя");

  ok(label, "TEXT-свойство превратилось в текстовую правку");
  eq(label.ops.characters, "Из свойства", "значение свойства перенесено дословно");
  eq(label.path[0].sourceId, ids.rowLabel, "текст адресован узлу, объявившему чтение свойства");

  ok(extra, "BOOL-свойство превратилось в правку видимости");
  eq(extra.ops.visible, false, "значение false не потеряно");
  eq(extra.path[0].sourceId, ids.rowExtra, "видимость адресована объявившему узлу");

  // --- Главное: путь внутрь символа, назначенного свойством ---------------
  ok(deep, "правка внутри назначенной свойством иконки разрешена");
  eq(deep.path.length, 2, "путь составлен из двух namespace");
  eq(deep.path[0].sourceId, ids.rowIcon, "первый шаг остался в определении строки");
  eq(deep.path[1].sourceId, ids.assignedIconVector,
    "второй шаг взят из символа, назначенного свойством, а не из символа узла");
  ok(deep.diagnostic.nestedComponentSwapEncountered,
    "диагностика фиксирует переключение namespace по свойству");
  ok(!ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION,
    "цель внутри назначенного символа больше не считается отсутствующей");
  ok(!ir.overrideResolution.OCCURRENCE_SWAP_NOT_IN_SOURCE,
    "значение свойства найдено в документе, а не объявлено недоступным");

  // --- Определение назначенной иконки собрано по требованию ---------------
  var definitionIds = ir.definitions.map(function (definition) { return definition.definitionId; });
  ok(definitionIds.indexOf(ids.assignedIcon) >= 0, "назначенный свойством символ собран определением");
  ok(definitionIds.indexOf(ids.defaultIcon) >= 0, "символ по умолчанию тоже нужен: он стоит в самом определении");

  // --- Конфликт semantic BOOLEAN ↔ raw visual visibility -------------------
  var conflictExtra = conflict.overrides.filter(function (entry) {
    return entry.path.length === 1 && entry.path[0].sourceId === ids.rowExtra &&
      entry.ops.visible !== undefined;
  })[0];
  ok(conflict.nativeProperties && conflict.nativeProperties.some(function (property) {
    return property.propertyId === ids.propExtra && property.type === "BOOLEAN" && property.value === true;
  }), "native BOOLEAN сохраняет formal component-property assignment");
  ok(conflictExtra, "raw visibility конфликтующего bound-слоя сохранена");
  eq(conflictExtra.ops.visible, true,
    "bound visibility следует formal BOOLEAN component property");
  ok(conflictExtra.nativeOwners && conflictExtra.nativeOwners.visible,
    "native BOOLEAN владеет bound visibility");

  // --- D51: co-located materialized assignment trace -----------------------
  var materializedEntry = materialized.overrides.filter(function (entry) {
    return entry.path.length === 1 && entry.path[0].sourceId === ids.rowNested;
  })[0];
  ok(materializedEntry, "co-located assignment record emitted its raw fallback entry");
  ok(materializedEntry.nativeOwners && materializedEntry.nativeOwners.visible,
    "co-located visible is owned by the native component property");
  ok(materializedEntry.nativeOwners && materializedEntry.nativeOwners.opacity,
    "co-located opacity is marked as the same assignment materialization");
  eq(materializedEntry.nativeOwners.visible.propertyId, ids.nestedProp,
    "co-located ownership uses the formal property id, not a layer heuristic");
  eq(materializedEntry.nativeOwners.visible.provenance, "COLOCATED_COMPONENT_PROP_ASSIGNMENT",
    "co-located ownership carries explicit provenance");

  // --- Вхождение без назначений ничего не получает -------------------------
  ok(!plain.overrides, "вхождение без назначений не получает выдуманных правок");

  // --- Порядок применения --------------------------------------------------
  var swapIndex = occurrence.overrides.indexOf(swap);
  var deepIndex = occurrence.overrides.indexOf(deep);
  ok(swapIndex < deepIndex, "подмена едет раньше правки внутри подменённого дерева");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX свойства компонента — " + checks + " проверок пройдено\n");
