/**
 * Direct PIX: нативные COMPONENT_SET на стороне Figma.
 *
 *   node FigmaImporter/Tests/DirectPixVariantsTest.js
 *
 * Прогоняется НАСТОЯЩИЙ код приёмника на headless-двойнике хоста
 * (`DirectPix/FigmaHost.js`) — от `.pix`-фикстуры до узлов документа.
 *
 * Проверяются утверждения, которые счётчиками не доказываются:
 *
 *   — безопасная группа состояний становится ОДНИМ COMPONENT_SET, а её
 *     участники остаются узлами COMPONENT внутри него;
 *   — вхождение выбирает участника по `symbolData.symbolID`, а не по имени,
 *     и остаётся инстансом ИМЕННО его;
 *   — инстансы, созданные ДО объединения, переживают его;
 *   — участники остаются пригодны и к `createInstance`, и к `swapComponent`;
 *   — несошедшаяся группа откатывается ЦЕЛИКОМ и в одиночку: соседние
 *     семейства собираются, её вхождения остаются нативными, визуал цел;
 *   — семантика Ticket 03 (снимок sizing против настоящей правки) от
 *     объединения не меняется.
 *
 * Двойник заведомо строже редактора в разборе имени участника и заведомо
 * оптимистичнее в переносе overrides (см. комментарий в FigmaHost.js). Он
 * доказывает согласованность отправителя с приёмником, а не поведение Figma:
 * последнее проверяется живым прогоном.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var Fixture = require("../../DirectPix/Tests/Fixture");
var PixContainer = require("../../DirectPix/PixContainer");
var PixDocument = require("../../DirectPix/PixDocument");
var MigrationIR = require("../../DirectPix/MigrationIR");
var FigmaHost = require("../../DirectPix/FigmaHost");

var RECEIVER_PATH = path.join(__dirname, "..", "Main.js");

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
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.51, message + " (получено: " + actual + ", ждали " + expected + ")");
  checks += 1;
}

function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function axis(property, values) { return { property: property, values: values }; }
function propDef(id, name, type, parentId, initialValue) {
  var out = { id: guid(id), name: name, type: type, parentPropDefId: parentId ? guid(parentId) : guid("0:0") };
  if (initialValue !== undefined) out.initialValue = initialValue;
  return out;
}
function propRef(id, field) { return { defID: guid(id), componentPropNodeField: field }; }
function grey() {
  return { type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1, blendMode: "NORMAL", visible: true };
}

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

var ids = {
  document: "5:1", library: "5:2", page: "5:3", root: "5:4",

  iconGroup: "5:10", iconAlpha: "5:11", iconAlphaLeaf: "5:12",
  iconBeta: "5:13", iconBetaLeaf: "5:14",

  buttonGroup: "5:20",
  bSD: "5:21", bSH: "5:22", bLD: "5:23", bLH: "5:24",

  dupGroup: "5:40", dupA: "5:41", dupB: "5:42",

  shapeGroup: "5:50",
  square: "5:51", squareLeaf: "5:52", pill: "5:53", pillLeaf: "5:54",

  occSD: "5:60", occSH: "5:61", occLD: "5:62", occLH: "5:63",
  occSwap: "5:64", occDup: "5:65", occInert: "5:66", occGenuine: "5:67",
  pLabel: "5:200", pVisible: "5:201", pIcon: "5:202",
  lLabel: "5:210", lVisible: "5:211", lIcon: "5:212",
};

/** Участник группы кнопок: HUG-контейнер с текстом и ВЛОЖЕННЫМ инстансом иконки. */
function buttonMember(symbolId, position, name) {
  var text = symbolId + "1";
  var nested = symbolId + "2";
  return [
    {
      guid: guid(symbolId), type: "SYMBOL", name: name, componentKey: "k-button",
      parentIndex: parent(ids.buttonGroup, position), transform: matrix(), size: { x: 120, y: 40 },
      stackMode: "HORIZONTAL", stackSpacing: 8,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
      fillPaints: [grey()],
      componentPropDef: symbolId === ids.bSD ? [
        propDef(ids.lLabel, "label", "TEXT", ids.pLabel),
        propDef(ids.lVisible, "show icon", "BOOL", ids.pVisible),
        propDef(ids.lIcon, "icon", "INSTANCE_SWAP", ids.pIcon),
      ] : undefined,
    },
    {
      guid: guid(text), type: "TEXT", name: "Подпись",
      parentIndex: parent(symbolId, "a"), transform: matrix(), size: { x: 80, y: 20 },
      fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
      textAlignHorizontal: "LEFT", textAutoResize: "WIDTH_AND_HEIGHT",
      textData: { characters: name },
      componentPropRef: symbolId === ids.bSD ? [propRef(ids.lLabel, "TEXT_DATA")] : undefined,
    },
    {
      // N. Вложенное вхождение УЧАСТНИКА ДРУГОГО семейства вариантов.
      guid: guid(nested), type: "INSTANCE", name: "Иконка",
      parentIndex: parent(symbolId, "b"), transform: matrix(90, 10), size: { x: 16, y: 16 },
      // Slot растянут по контр-оси кнопки. swapComponent/setProperties не
      // имеют права превращать отношение ребёнка к его родителю в HUG.
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
      symbolData: { symbolID: guid(ids.iconAlpha) },
      propsAreBubbled: symbolId === ids.bSD ? true : undefined,
      componentPropRef: symbolId === ids.bSD ? [
        propRef(ids.lVisible, "VISIBLE"), propRef(ids.lIcon, "OVERRIDDEN_SYMBOL_ID")
      ] : undefined,
    },
  ];
}

function plainMember(symbolId, groupId, position, name, key, box) {
  return [
    {
      guid: guid(symbolId), type: "SYMBOL", name: name, componentKey: key,
      parentIndex: parent(groupId, position), transform: matrix(),
      size: { x: box.x, y: box.y },
    },
    {
      guid: guid(symbolId + "1"), type: "RECTANGLE", name: "Фон",
      parentIndex: parent(symbolId, "a"), transform: matrix(),
      size: { x: box.x, y: box.y }, fillPaints: [grey()],
    },
  ];
}

function occurrence(id, symbolId, position, box, overrides, rawName) {
  var node = {
    guid: guid(id), type: "INSTANCE", name: rawName || ("occ-" + id),
    parentIndex: parent(ids.root, position), transform: matrix(),
    size: { x: box.x, y: box.y },
    symbolData: { symbolID: guid(symbolId) },
  };
  if (overrides) node.symbolData.symbolOverrides = overrides;
  return node;
}

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a"), internalOnly: true },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
  {
    guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"),
    transform: matrix(), size: { x: 900, y: 500 },
  },

  // Семейство иконок: две координаты по одной оси.
  {
    guid: guid(ids.iconGroup), type: "FRAME", name: "Icon", isStateGroup: true,
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 30 },
    stateGroupPropertyValueOrders: [axis("icon", ["alpha", "beta"])],
  },
]
  .concat(plainMember(ids.iconAlpha, ids.iconGroup, "a", "icon=alpha", "k-icon-a", { x: 16, y: 16 }))
  .concat(plainMember(ids.iconBeta, ids.iconGroup, "b", "icon=beta", "k-icon-b", { x: 16, y: 16 }))

  // Семейство кнопок: две оси, порядок значений НЕ алфавитный.
  .concat([{
    guid: guid(ids.buttonGroup), type: "FRAME", name: "Button", isStateGroup: true,
    parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 400, y: 200 },
    stateGroupPropertyValueOrders: [axis("Size", ["Small", "Large"]), axis("State", ["Default", "Hover"])],
    componentPropDef: [
      propDef(ids.pLabel, "label", "TEXT", null, { textValue: { characters: "Default label" } }),
      propDef(ids.pVisible, "show icon", "BOOL", null, { boolValue: true }),
      propDef(ids.pIcon, "icon", "INSTANCE_SWAP", null, { guidValue: guid(ids.iconAlpha) }),
    ],
  }])
  // Порядок детей в документе намеренно не совпадает с порядком словаря.
  .concat(buttonMember(ids.bLH, "a", "State=Hover, Size=Large"))
  .concat(buttonMember(ids.bSD, "b", "Size=Small, State=Default"))
  .concat(buttonMember(ids.bLD, "c", "Size=Large, State=Default"))
  .concat(buttonMember(ids.bSH, "d", "Size=Small, State=Hover"))

  // G. Две одинаковые координаты — семейство обязано откатиться целиком.
  .concat([{
    guid: guid(ids.dupGroup), type: "FRAME", name: "Duplicate", isStateGroup: true,
    parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 200, y: 100 },
    stateGroupPropertyValueOrders: [axis("state", ["default"])],
  }])
  .concat(plainMember(ids.dupA, ids.dupGroup, "a", "state=default", "k-dup-a", { x: 50, y: 20 }))
  .concat(plainMember(ids.dupB, ids.dupGroup, "b", "state=default", "k-dup-b", { x: 50, y: 20 }))

  // O. Семейство, на котором проверяется происхождение sizing: у одного
  // участника содержимое КОРОЧЕ коробки, у другого — ДЛИННЕЕ.
  .concat([{
    guid: guid(ids.shapeGroup), type: "FRAME", name: "Shape", isStateGroup: true,
    parentIndex: parent(ids.library, "d"), transform: matrix(), size: { x: 200, y: 100 },
    stateGroupPropertyValueOrders: [axis("shape", ["square", "pill"])],
  }])
  .concat([
    {
      guid: guid(ids.square), type: "SYMBOL", name: "shape=square", componentKey: "k-square",
      parentIndex: parent(ids.shapeGroup, "a"), transform: matrix(), size: { x: 12, y: 12 },
      stackMode: "HORIZONTAL", stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.squareLeaf), type: "RECTANGLE", name: "Square leaf",
      parentIndex: parent(ids.square, "a"), transform: matrix(), size: { x: 8, y: 12 },
      fillPaints: [grey()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.pill), type: "SYMBOL", name: "shape=pill", componentKey: "k-pill",
      parentIndex: parent(ids.shapeGroup, "b"), transform: matrix(), size: { x: 60, y: 24 },
      stackMode: "HORIZONTAL", stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.pillLeaf), type: "RECTANGLE", name: "Pill leaf",
      parentIndex: parent(ids.pill, "a"), transform: matrix(), size: { x: 100, y: 24 },
      fillPaints: [grey()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
  ])

  .concat([
    // D. Четыре вхождения — четыре разных участника.
    // Пользовательское имя вхождения Pixso хранит корневой правкой имени;
    // `name` самой записи — техническая подпись.
    occurrence(ids.occSD, ids.bSD, "a", { x: 120, y: 40 }, [{
      guidPath: { guids: [] },
      name: "occ-" + ids.occSD,
      componentPropAssignment: [
        { defID: guid(ids.lLabel), value: { textValue: { characters: "Native label" } } },
        { defID: guid(ids.lVisible), value: { boolValue: false } },
        { defID: guid(ids.lIcon), value: { guidValue: guid(ids.iconBeta) } },
      ],
    }], "Instance 17"),
    occurrence(ids.occSH, ids.bSH, "b", { x: 120, y: 40 }, [
      { guidPath: { guids: [guid(ids.bSH + "2")] }, visible: false },
    ]),
    occurrence(ids.occLD, ids.bLD, "c", { x: 120, y: 40 }),
    occurrence(ids.occLH, ids.bLH, "d", { x: 120, y: 40 }, null, "Instance 299"),

    // F. Вложенная подмена МЕЖДУ участниками другого семейства.
    occurrence(ids.occSwap, ids.bSD, "e", { x: 120, y: 40 }, [
      { guidPath: { guids: [guid(ids.bSD + "2")] }, overriddenSymbolID: guid(ids.iconBeta) },
    ]),

    // G. Вхождение откатившегося семейства остаётся нативным инстансом.
    occurrence(ids.occDup, ids.dupA, "f", { x: 50, y: 20 }),

    // O. Снимок уже действующего состояния: коробка вхождения равна коробке
    // определения — воспроизводить HUG нельзя.
    occurrence(ids.occInert, ids.square, "g", { x: 12, y: 12 }, [
      { guidPath: { guids: [guid(ids.square)] }, stackPrimarySizing: "RESIZE_TO_FIT" },
    ]),

    // O. Настоящая правка: коробка вхождения от коробки определения отличается.
    occurrence(ids.occGenuine, ids.pill, "h", { x: 100, y: 24 }, [
      { guidPath: { guids: [guid(ids.pill)] }, stackPrimarySizing: "RESIZE_TO_FIT" },
    ]),
  ]);

var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pix-receiver-variants-")), "variants.pix");
fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
var doc = PixDocument.load(PixContainer.open(file));
var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)] });

// ---------------------------------------------------------------------------
// Прогон приёмника
// ---------------------------------------------------------------------------

var host = FigmaHost.install(RECEIVER_PATH);
var receiver = host.receiver;
var sequence = 0;

function task(type, payload) {
  sequence += 1;
  return receiver.handleDirectTask({
    jobId: "variants-job",
    taskId: "variants-job-" + sequence,
    type: type,
    payload: Object.assign(
      { protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION },
      payload
    ),
  }, {});
}

function findAll(node, predicate, out) {
  out = out || [];
  if (!node) return out;
  if (predicate(node)) out.push(node);
  var children = node.children || [];
  for (var i = 0; i < children.length; i++) findAll(children[i], predicate, out);
  return out;
}

function documentNodes(predicate) {
  var out = [];
  host.pages().forEach(function (page) { findAll(page, predicate, out); });
  return out;
}

function bySourceId(id) {
  var found = documentNodes(function (node) {
    return typeof node.getPluginData === "function" && node.getPluginData("pixsoDirectSourceId") === id;
  });
  return found.length ? found[0] : null;
}

function definitionComponent(definitionId) {
  var found = documentNodes(function (node) {
    return node.type === "COMPONENT" && typeof node.getPluginData === "function" &&
      node.getPluginData("pixsoDirectDefinitionId") === definitionId;
  });
  return found.length ? found[0] : null;
}

/** Определение-заглушка с явным дескриптором семейства. */
function craftedDefinition(definitionId, groupId, groupName, componentName, variantName, order) {
  return {
    definitionId: definitionId,
    componentKey: "crafted-" + definitionId,
    variantGroupId: groupId,
    variantSet: {
      groupId: groupId,
      groupName: groupName,
      groupComponentKey: null,
      variantName: variantName,
      coordinate: null,
      order: order,
      axisCount: 1,
      memberCountSource: 2,
      memberCountDemanded: 2,
      sourceName: componentName,
    },
    name: componentName,
    nodes: [{
      id: definitionId, parent: null, kind: "ORDINARY", type: "COMPONENT",
      name: componentName, x: 0, y: 0, width: 40, height: 20,
    }],
  };
}


function craftedPropertyDefinition(definitionId, groupId, variantName, propertyId, bindingIdentity, order) {
  var definition = craftedDefinition(definitionId, groupId, "Mirror properties", variantName, variantName, order);
  definition.nativeProperties = [{
    propertyId: propertyId, bindingIdentity: bindingIdentity,
    name: "show slot", type: "BOOLEAN", defaultValue: true,
  }];
  definition.nodes = [
    { id: definitionId, parent: null, kind: "ORDINARY", type: "COMPONENT", name: variantName, x: 0, y: 0, width: 40, height: 20 },
    { id: definitionId + "-slot", parent: definitionId, kind: "ORDINARY", type: "RECTANGLE", name: "slot", x: 0, y: 0, width: 10, height: 10,
      componentPropertyReferences: { visible: propertyId } },
  ];
  return definition;
}

async function runReceiverFallbackJob() {
  var jobSequence = 0;
  function craftedTask(type, payload) {
    jobSequence += 1;
    return receiver.handleDirectTask({
      jobId: "variants-fallback-job",
      taskId: "variants-fallback-job-" + jobSequence,
      type: type,
      payload: Object.assign(
        { protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION },
        payload
      ),
    }, {});
  }

  await craftedTask("DIRECT_PIX_START", { source: { fileName: "fallback.pix" } });
  var delivery = await craftedTask("DIRECT_PIX_DEFINITIONS", {
    definitions: [
      // Две одинаковые координаты: страховка приёмника обязана отклонить
      // семейство целиком, не собрав из него половины.
      craftedDefinition("8:1", "8:100", "Collide", "state=default", "state=default", 0),
      craftedDefinition("8:2", "8:100", "Collide", "state=default", "state=default", 1),
      // Координата, которую хост не разложит в variant-свойства: отказ хоста
      // обязан остаться отказом ОДНОГО семейства.
      craftedDefinition("8:3", "8:200", "Broken", "просто имя", "просто имя", 0),
      craftedDefinition("8:4", "8:200", "Broken", "тоже имя", "тоже имя", 1),
      // Здоровое семейство рядом.
      craftedDefinition("8:5", "8:300", "Healthy", "state=default", "state=default", 0),
      craftedDefinition("8:6", "8:300", "Healthy", "state=hover", "state=hover", 1),
    ],
  });
  eq(delivery.failed.length, 0, "откат сборки набора не мешает доставке определений");
  eq(delivery.ready.length, 6, "все шесть определений подтверждены");

  await craftedTask("DIRECT_PIX_PAGE", { pageId: "8:900", pageName: "Fallback" });
  var rootReport = await craftedTask("DIRECT_PIX_ROOT", {
    pageId: "8:900", pageName: "Fallback", rootId: "8:901", rootName: "Root",
    nodes: [
      { id: "8:901", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", x: 0, y: 0, width: 400, height: 200 },
      { id: "8:902", parent: "8:901", kind: "INSTANCE", type: "INSTANCE", name: "a", definitionId: "8:1", x: 0, y: 0, width: 40, height: 20 },
      { id: "8:903", parent: "8:901", kind: "INSTANCE", type: "INSTANCE", name: "b", definitionId: "8:3", x: 0, y: 30, width: 40, height: 20 },
      { id: "8:904", parent: "8:901", kind: "INSTANCE", type: "INSTANCE", name: "c", definitionId: "8:5", x: 0, y: 60, width: 40, height: 20 },
    ],
  });
  eq(rootReport.instancesCreated, 3, "все три вхождения стали нативными инстансами");
  eq(rootReport.placeholderFramesCreated || 0, 0, "откат не породил ни одного placeholder");

  var craftedFinish = await craftedTask("DIRECT_PIX_FINISH", {});
  var craftedReport = craftedFinish.variantSetReport;
  eq(craftedReport.groupsSeen, 3, "приёмник увидел три семейства");
  eq(craftedReport.groupsCombined, 1, "собралось ровно одно — здоровое");
  eq(craftedReport.groupsFallback, 2, "два семейства откатились");
  eq(craftedReport.membersFallback, 4, "откатились все четыре их участника, а не половина");
  deep(Object.keys(craftedReport.fallbackByReason).sort(),
    ["VARIANT_COMBINE_REJECTED", "VARIANT_DUPLICATE_COORDINATE"],
    "у каждого отката своя причина");
  eq(craftedReport.fallbackSamples.length, 2, "оба отката попали в выборку");

  // Откатившиеся участники остались самостоятельными компонентами, их
  // вхождения — нативными инстансами, и ни один узел не пропал.
  var craftedSets = documentNodes(function (node) {
    return node.type === "COMPONENT_SET" && node.getPluginData("pixsoDirectVariantGroup") === "8:300";
  });
  eq(craftedSets.length, 1, "здоровое семейство рядом с откатами собралось");
  ["8:1", "8:2", "8:3", "8:4"].forEach(function (definitionId) {
    var component = definitionComponent(definitionId);
    ok(component, "участник отката " + definitionId + " остался компонентом");
    eq(component.parent.type, "PAGE", "участник отката " + definitionId + " не попал в набор");
  });
  eq(craftedFinish.definitionLifetimeReport.instanceDefinitionUnavailable, 0,
    "откат сборки набора не сделал ни одного определения недоступным");
}

/**
 * D42: два локальных GUID-space могут содержать непересекающиеся части одного
 * опубликованного variant family. Приёмник обязан собрать один ComponentSet,
 * не схлопывая сами определения и не используя имя как единственное доказательство.
 */
async function runCrossLocalFamilyAggregationJob() {
  var jobSequence = 0;
  function task(type, payload) {
    jobSequence += 1;
    return receiver.handleDirectTask({
      jobId: "variants-cross-local-job",
      taskId: "variants-cross-local-job-" + jobSequence,
      type: type,
      payload: Object.assign(
        { protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION },
        payload
      ),
    }, {});
  }

  function member(definitionId, groupId, variantName, demandedCoordinates, variantKey) {
    var definition = craftedDefinition(
      definitionId, groupId, "Generic / Control", variantName, variantName, 0
    );
    definition.componentKey = variantKey;
    definition.variantSet.groupComponentKey = "published-generic-control";
    definition.variantSet.publicationIdentity = "library-file@900:1";
    definition.variantSet.publishFile = "library-file";
    definition.variantSet.publishID = "900:1";
    definition.variantSet.stableFamilyKey = "publish:library-file@900:1|schema:state=default\u001fhover";
    definition.variantSet.memberCountSource = 2;
    definition.variantSet.memberCountDemanded = demandedCoordinates.length;
    definition.variantSet.demandedCoordinates = demandedCoordinates.slice();
    definition.variantSet.familyCoordinates = ["state=default", "state=hover"];
    definition.variantSet.coordinateKey = variantName;
    definition.variantSet.sortKey = [variantName === "state=default" ? 0 : 1];
    return definition;
  }

  await task("DIRECT_PIX_START", { source: { fileName: "generic-cross-local.pix" } });
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [
      member("42:1", "42:100", "state=default", ["state=default"], "variant-default"),
      member("84:1", "84:100", "state=hover", ["state=hover"], "variant-hover"),
    ],
  });
  await task("DIRECT_PIX_PAGE", { pageId: "42:900", pageName: "CrossLocal" });
  await task("DIRECT_PIX_ROOT", {
    pageId: "42:900", pageName: "CrossLocal", rootId: "42:901", rootName: "Root",
    nodes: [
      { id: "42:901", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", x: 0, y: 0, width: 200, height: 100 },
      { id: "42:902", parent: "42:901", kind: "INSTANCE", type: "INSTANCE", name: "first", definitionId: "42:1", x: 0, y: 0, width: 40, height: 20 },
      { id: "42:903", parent: "42:901", kind: "INSTANCE", type: "INSTANCE", name: "second", definitionId: "84:1", x: 50, y: 0, width: 40, height: 20 },
    ],
  });
  var finish = await task("DIRECT_PIX_FINISH", {});
  var sets = documentNodes(function (node) {
    return node.type === "COMPONENT_SET" && node.name === "Generic / Control";
  });
  eq(sets.length, 1, "D47. непересекающиеся demanded coordinates одной published family собираются в один set");
  eq(sets[0].children.length, 2, "D47. общий set содержит оба локальных варианта");
  ok(definitionComponent("42:1") && definitionComponent("84:1"),
    "D47. обе локальные definition identity сохранены внутри общего set");
  ok(definitionComponent("42:1") !== definitionComponent("84:1"),
    "D47. физическое объединение set не схлопывает разные variant definitions");
  eq(finish.variantSetReport.localGroupsMergedByStableFamily, 1,
    "D47. disjoint local groups объединены только на уровне COMPONENT_SET");
  var manifest = finish.reconstructionManifest && finish.reconstructionManifest.families || [];
  var families = manifest.filter(function (entry) { return entry.componentSetName === "Generic / Control"; });
  eq(families.length, 1, "D47. manifest показывает одну materialized family");
  deep(families[0].componentNameHierarchy, ["Generic", "Control"],
    "D47. slash hierarchy сохранена как official supporting component naming hierarchy");
}

/**
 * Участник, приехавший ПОЗЖЕ собранного набора.
 *
 * Чанкование определений не обязано укладывать всё семейство в один пакет.
 * Опоздавший обязан войти в существующий набор, не тронув ни его прежних
 * участников, ни их вхождения, — и обязан быть посчитан отдельно: в Figma
 * порядок вариантов задаётся порядком детей набора, поэтому опоздавший
 * встаёт в конец, а не на своё место по словарю источника. Это измеренная
 * цена чанкования, и она названа, а не спрятана.
 */
async function runLateMemberJob() {
  var jobSequence = 0;
  function lateTask(type, payload) {
    jobSequence += 1;
    return receiver.handleDirectTask({
      jobId: "variants-late-job",
      taskId: "variants-late-job-" + jobSequence,
      type: type,
      payload: Object.assign(
        { protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION },
        payload
      ),
    }, {});
  }

  await lateTask("DIRECT_PIX_START", { source: { fileName: "late.pix" } });
  await lateTask("DIRECT_PIX_DEFINITIONS", {
    definitions: [craftedDefinition("7:1", "7:100", "Late", "state=default", "state=default", 0)],
  });
  var setsAfterFirst = documentNodes(function (node) {
    return node.type === "COMPONENT_SET" && node.getPluginData("pixsoDirectVariantGroup") === "7:100";
  });
  eq(setsAfterFirst.length, 1, "набор собран уже с одним доехавшим участником");
  eq(setsAfterFirst[0].children.length, 1, "в наборе один участник");

  // Вхождение первого участника создаётся ДО прихода второго.
  await lateTask("DIRECT_PIX_PAGE", { pageId: "7:900", pageName: "Late" });
  await lateTask("DIRECT_PIX_ROOT", {
    pageId: "7:900", pageName: "Late", rootId: "7:901", rootName: "Root",
    nodes: [
      { id: "7:901", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", x: 0, y: 0, width: 200, height: 100 },
      { id: "7:902", parent: "7:901", kind: "INSTANCE", type: "INSTANCE", name: "a", definitionId: "7:1", x: 0, y: 0, width: 40, height: 20 },
    ],
  });
  var early = bySourceId("7:902");
  ok(early, "вхождение первого участника построено");
  var earlyMain = await early.getMainComponentAsync();

  // Второй участник приезжает следующим чанком — уже после этого вхождения.
  await lateTask("DIRECT_PIX_DEFINITIONS", {
    definitions: [craftedDefinition("7:2", "7:100", "Late", "state=hover", "state=hover", 1)],
  });
  var lateFinish = await lateTask("DIRECT_PIX_FINISH", {});
  var lateReport = lateFinish.variantSetReport;
  eq(lateReport.groupsCombined, 1, "семейство осталось одним набором");
  eq(lateReport.membersCombined, 2, "в набор вошли оба участника");
  eq(lateReport.membersJoinedLate, 1, "опоздавший участник посчитан отдельно");
  eq(lateReport.membersLostAfterCombine, 0, "ни один участник не потерян");

  var lateSet = documentNodes(function (node) {
    return node.type === "COMPONENT_SET" && node.getPluginData("pixsoDirectVariantGroup") === "7:100";
  })[0];
  eq(lateSet.children.length, 2, "в наборе оба участника");
  deep(lateSet.children.map(function (child) { return child.name; }),
    ["state=default", "state=hover"], "опоздавший встал в конец набора");
  deep(Object.assign({}, lateSet.componentPropertyDefinitions.state.variantOptions.slice()),
    Object.assign({}, ["default", "hover"]), "значение опоздавшего попало в схему набора");

  // Главное: вхождение, созданное ДО прихода опоздавшего, не тронуто.
  eq(early.removed, false, "прежнее вхождение не удалено");
  eq(early.type, "INSTANCE", "прежнее вхождение осталось инстансом");
  eq((await early.getMainComponentAsync()) === earlyMain, true,
    "мастер прежнего вхождения не подменился приходом опоздавшего");
}


async function runLateDuplicateJob() {
  var seq = 0;
  function t(type, payload) {
    seq += 1;
    return receiver.handleDirectTask({
      jobId: "variants-late-duplicate-job", taskId: "variants-late-duplicate-job-" + seq, type: type,
      payload: Object.assign({ protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION }, payload),
    }, {});
  }
  await t("DIRECT_PIX_START", { source: { fileName: "late-duplicate.pix" } });
  await t("DIRECT_PIX_DEFINITIONS", { definitions: [
    craftedDefinition("9:1", "9:100", "Late duplicate", "state=default", "state=default", 0),
  ] });
  var delivery = await t("DIRECT_PIX_DEFINITIONS", { definitions: [
    craftedDefinition("9:2", "9:100", "Late duplicate", "state=default", "state=default", 1),
  ] });
  eq(delivery.failed.length, 0, "D49. поздний дубль координаты не роняет definition delivery");
  var finish = await t("DIRECT_PIX_FINISH", {});
  eq(finish.variantSetReport.membersRejectedAsDuplicate, 1,
    "D49. поздний дубль координаты отсекается ДО appendChild");
  var set = documentNodes(function (node) {
    return node.type === "COMPONENT_SET" && node.getPluginData("pixsoDirectVariantGroup") === "9:100";
  })[0];
  eq(set.children.length, 1, "D49. ошибочная duplicate-coordinate не попала в живой set");
}

async function runMirrorPropertyIdentityJob() {
  var seq = 0;
  function t(type, payload) {
    seq += 1;
    return receiver.handleDirectTask({
      jobId: "variants-property-mirror-job", taskId: "variants-property-mirror-job-" + seq, type: type,
      payload: Object.assign({ protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION }, payload),
    }, {});
  }
  var beforeAdds = host.calls.addComponentProperty;
  await t("DIRECT_PIX_START", { source: { fileName: "property-mirror.pix" } });
  await t("DIRECT_PIX_DEFINITIONS", { definitions: [
    craftedPropertyDefinition("10:1", "10:100", "state=default", "10:501", "BOOLEAN\u001evisible@published-slot", 0),
  ] });
  await t("DIRECT_PIX_DEFINITIONS", { definitions: [
    craftedPropertyDefinition("10:2", "10:100", "state=hover", "10:777", "BOOLEAN\u001evisible@published-slot", 1),
  ] });
  var finish = await t("DIRECT_PIX_FINISH", {});
  var set = documentNodes(function (node) {
    return node.type === "COMPONENT_SET" && node.getPluginData("pixsoDirectVariantGroup") === "10:100";
  })[0];
  var nativeNames = Object.keys(set.componentPropertyDefinitions).filter(function (name) {
    return set.componentPropertyDefinitions[name].type !== "VARIANT";
  });
  eq(nativeNames.length, 1, "D49. два local property id одного overrideKey-slot дают одну Figma property");
  eq(host.calls.addComponentProperty - beforeAdds, 1,
    "D49. mirror property не объявляется второй раз на готовом set");
  eq(finish.totals.nativePropertyMirrorAliases, 1,
    "D49. reuse разных public ids измеряется отдельно");
  var first = definitionComponent("10:1");
  var second = definitionComponent("10:2");
  var firstSlot = findAll(first, function (node) { return node.name === "slot"; })[0];
  var secondSlot = findAll(second, function (node) { return node.name === "slot"; })[0];
  eq(firstSlot.componentPropertyReferences.visible, nativeNames[0],
    "D49. первый mirror binding указывает в canonical property");
  eq(secondSlot.componentPropertyReferences.visible, nativeNames[0],
    "D49. поздний mirror binding транслирован в ту же canonical property");
}

(async function run() {
  // destructiveOverwriteReport собирается трассой стадий, а она включается
  // только с --debug-overrides (как в CLI).
  await task("DIRECT_PIX_START", { source: { fileName: "variants.pix" }, debugOverrides: true });

  ok(ir.definitions.length > 0, "определения собраны");
  var deliveryA = await task("DIRECT_PIX_DEFINITIONS", { definitions: ir.definitions });
  var combineAfterFirstChunk = host.calls.combineAsVariants;
  eq(deliveryA.failed.length, 0, "все определения подтверждены пригодными");

  // M. Подтверждение выдано на своём чанке: инвариант Ticket 01 не сдвинут —
  // определение объявляется пригодным до и независимо от объединения.
  eq(deliveryA.ready.length, ir.definitions.length,
    "M. каждое определение подтверждено на своём чанке");

  // ГЛАВНЫЙ ИНВАРИАНТ ПОРЯДКА.
  //
  // Набор собирается на чанке определений — ДО первого вхождения. Обратный
  // порядок измеримо портит документ: на живой Figma переселение мастера в
  // набор заставляет хост переразрешить уже существующие вхождения, и
  // выключенные из потока (`visible = false`) поддеревья приезжают
  // разложенными по геометрии определения, а не по применённой дельте.
  ok(combineAfterFirstChunk > 0, "наборы собираются на чанке определений, а не в конце job");
  // Сам инвариант держит двойник: `combineAsVariants` и вход в готовый набор
  // падают, если у переселяемого участника уже есть вхождения. Здесь эти
  // вызовы прошли — значит порядок соблюдён и на вложенных вхождениях внутри
  // соседних определений тоже.
  [ids.bSD, ids.bSH, ids.bLD, ids.bLH, ids.iconAlpha, ids.iconBeta].forEach(function (definitionId) {
    var component = definitionComponent(definitionId);
    ok(component, "участник " + definitionId + " создан");
    eq(component.parent.type, "COMPONENT_SET",
      "участник " + definitionId + " лежит в наборе ДО создания вхождений");
  });

  // P2. Живая Figma может канонизировать generated suffix имени public
  // property уже после addComponentProperty()/combineAsVariants. Эмулируем
  // это между сборкой definition и созданием occurrence: schema и реальные
  // bindings уже носят новое имя, а session всё ещё помнит старое. Receiver
  // обязан восстановить public property по единственному logical name + type.
  var canonicalizedSet = definitionComponent(ids.bSD).parent;
  var canonicalizedDefs = canonicalizedSet.componentPropertyDefinitions;
  var oldSwapProperty = Object.keys(canonicalizedDefs).filter(function (name) {
    return canonicalizedDefs[name] && canonicalizedDefs[name].type === "INSTANCE_SWAP";
  })[0];
  ok(oldSwapProperty, "P2. INSTANCE_SWAP property существует до канонизации");
  var canonicalizedSwapProperty = "icon#figma-canonicalized";
  canonicalizedDefs[canonicalizedSwapProperty] = canonicalizedDefs[oldSwapProperty];
  delete canonicalizedDefs[oldSwapProperty];
  findAll(canonicalizedSet, function () { return true; }).forEach(function (node) {
    var refs = node.componentPropertyReferences || null;
    if (!refs) return;
    Object.keys(refs).forEach(function (field) {
      if (refs[field] === oldSwapProperty) refs[field] = canonicalizedSwapProperty;
    });
  });

  var root = ir.roots[0];
  await task("DIRECT_PIX_PAGE", { pageId: root.pageId, pageName: root.pageName });
  var rootResult = await task("DIRECT_PIX_ROOT", {
    pageId: root.pageId, pageName: root.pageName,
    rootId: root.rootId, rootName: root.rootName, nodes: root.nodes,
  });
  eq(rootResult.placeholderFramesCreated || 0, 0, "ни одного placeholder на корне");
  eq(rootResult.instanceDefinitionUnavailable || 0, 0, "ни одного недоступного определения");

  // E. Вхождения создаются от участников, УЖЕ находящихся в наборе, и
  // переживают дальнейшие изменения набора (вход опоздавших участников,
  // страховочный проход на FINISH).
  var before = {};
  var beforeMain = {};
  var occurrenceIds = [ids.occSD, ids.occSH, ids.occLD, ids.occLH, ids.occSwap, ids.occDup];
  for (var b = 0; b < occurrenceIds.length; b++) {
    var node = bySourceId(occurrenceIds[b]);
    ok(node, "E. вхождение " + occurrenceIds[b] + " построено");
    eq(node.type, "INSTANCE", "E. вхождение " + occurrenceIds[b] + " — нативный инстанс");
    before[occurrenceIds[b]] = node;
    beforeMain[occurrenceIds[b]] = await node.getMainComponentAsync();
  }

  var finish = await task("DIRECT_PIX_FINISH", {});
  var report = finish.variantSetReport;
  ok(finish.destructiveOverwriteReport.visibilitySamples.length > 0,
    "D40. destructive visibility имеет отдельную неэвиктируемую выборку");
  ok(report, "финал отдаёт отчёт по наборам вариантов");

  // -------------------------------------------------------------------------
  // A. Один COMPONENT_SET на безопасное семейство
  // -------------------------------------------------------------------------
  // Отклонённое семейство до приёмника доезжает БЕЗ дескриптора: вердикт
  // выносит отправитель, у которого есть словарь группы. Приёмник поэтому
  // видит три кандидата, а не четыре, — и это ровно то, что нужно: разбирать
  // имена ему нечем и не положено.
  eq(ir.stateGroupReport.groupsFallback, 1, "G. отправитель отклонил одно семейство");
  deep(Object.keys(ir.stateGroupReport.fallbackByReason), ["DUPLICATE_COORDINATE"],
    "G. причина отката названа отправителем");
  eq(report.groupsSeen, 3, "приёмник увидел три семейства-кандидата");
  eq(report.groupsCombined, 3, "все три семейства собраны в наборы");
  eq(report.groupsFallback, 0, "на приёмнике отказов сборки не было");
  eq(report.membersLostAfterCombine, 0, "ни один участник не потерян объединением");
  eq(report.membersJoinedLate, 0, "весь чанк собрался одним вызовом, опоздавших нет");

  var sets = documentNodes(function (node) { return node.type === "COMPONENT_SET"; });
  eq(sets.length, 3, "A. в документе ровно три набора вариантов");

  var buttonSet = null;
  for (var s = 0; s < sets.length; s++) {
    if (sets[s].getPluginData("pixsoDirectVariantGroup") === ids.buttonGroup) buttonSet = sets[s];
  }
  ok(buttonSet, "A. набор семейства кнопок найден по идентичности группы, а не по имени");
  eq(buttonSet.name, "Button", "A. имя набора — имя исходной группы состояний");
  eq(buttonSet.children.length, 4, "A. в наборе четыре участника");
  buttonSet.children.forEach(function (child) {
    eq(child.type, "COMPONENT", "A. участник набора остался COMPONENT");
    eq(child.parent === buttonSet, true, "A. родитель участника — набор");
  });

  // B/C. Порядок участников — порядок осей и значений источника.
  deep(buttonSet.children.map(function (child) { return child.name; }), [
    "Size=Small, State=Default",
    "Size=Small, State=Hover",
    "Size=Large, State=Default",
    "Size=Large, State=Hover",
  ], "B/C. actual Figma variant names остаются каноническими координатами");
  eq(definitionComponent(ids.bLH).getPluginData("pixsoDirectSourceName"), "State=Hover, Size=Large",
    "B/C. исходное Pixso-имя варианта сохранено отдельно от Figma coordinate");

  // Схема набора глазами хоста: оси и порядок значений сохранены.
  deep(Object.keys(buttonSet.componentPropertyDefinitions).filter(function (name) {
    return buttonSet.componentPropertyDefinitions[name].type === "VARIANT";
  }), ["Size", "State"], "B. variant-оси набора в исходном порядке");
  deep(buttonSet.componentPropertyDefinitions.Size.variantOptions, ["Small", "Large"],
    "C. значения оси в исходном порядке, а не по алфавиту");

  // Ticket 05. Нативные свойства живут на COMPONENT_SET рядом с VARIANT,
  // но не подменяют их и используют фактические имена, возвращённые хостом.
  var nativeSchemaNames = Object.keys(buttonSet.componentPropertyDefinitions).filter(function (name) {
    return buttonSet.componentPropertyDefinitions[name].type !== "VARIANT";
  });
  eq(nativeSchemaNames.length, 3, "P. на наборе созданы ровно BOOL/TEXT/INSTANCE_SWAP");
  deep(nativeSchemaNames.map(function (name) { return buttonSet.componentPropertyDefinitions[name].type; }).sort(),
    ["BOOLEAN", "INSTANCE_SWAP", "TEXT"], "P. типы native properties сохранены");
  nativeSchemaNames.forEach(function (name) {
    ok(name.indexOf("#p") > 0 || name === canonicalizedSwapProperty,
      "P. schema использует фактическое имя хоста, включая его позднюю канонизацию");
  });

  var propertyMember = definitionComponent(ids.bSD);
  var propertyText = findAll(propertyMember, function (node) { return node.type === "TEXT"; })[0];
  var propertyIcon = findAll(propertyMember, function (node) { return node.type === "INSTANCE"; })[0];
  ok(propertyText.componentPropertyReferences && propertyText.componentPropertyReferences.characters,
    "P. TEXT layer связан с нативным property");
  ok(propertyIcon.componentPropertyReferences && propertyIcon.componentPropertyReferences.visible,
    "P. visibility слоя связан с BOOLEAN");
  ok(propertyIcon.componentPropertyReferences && propertyIcon.componentPropertyReferences.mainComponent,
    "P. nested instance связан с INSTANCE_SWAP");

  // -------------------------------------------------------------------------
  // D. Вхождение выбирает участника по symbolID
  // -------------------------------------------------------------------------
  var expected = {};
  expected[ids.occSD] = "Size=Small, State=Default";
  expected[ids.occSH] = "Size=Small, State=Hover";
  expected[ids.occLD] = "Size=Large, State=Default";
  expected[ids.occLH] = "Size=Large, State=Hover";
  var chosen = {};
  var keys = Object.keys(expected);
  for (var k = 0; k < keys.length; k++) {
    var instance = bySourceId(keys[k]);
    var main = await instance.getMainComponentAsync();
    ok(main, "D. у вхождения " + keys[k] + " есть мастер");
    eq(main.name, expected[keys[k]], "D. вхождение стало инстансом своего участника");
    eq(main.parent === buttonSet, true, "D. мастер вхождения лежит в наборе");
    deep(instance.variantProperties, main.variantProperties,
      "D. координата вхождения совпала с координатой участника");
    chosen[main.name] = (chosen[main.name] || 0) + 1;
  }
  eq(Object.keys(chosen).length, 4, "D. четыре вхождения выбрали четырёх РАЗНЫХ участников");
  eq(bySourceId(ids.occSD).name, "occ-" + ids.occSD,
    "D40. пользовательское имя occurrence пережило createInstance/setProperties");
  eq(bySourceId(ids.occLH).name, "Button",
    "D40. техническое Pixso Instance N заменено display-именем state-group family");

  var nativeOccurrence = bySourceId(ids.occSD);
  var nativeText = findAll(nativeOccurrence, function (node) { return node.type === "TEXT"; })[0];
  var nativeNested = findAll(nativeOccurrence, function (node) { return node.type === "INSTANCE"; })
    .filter(function (node) { return node !== nativeOccurrence; })[0];
  eq(nativeText.characters, "Native label", "P. instance.setProperties применил TEXT");
  eq(nativeNested.visible, false, "P. instance.setProperties применил BOOLEAN");
  var nativeNestedMain = await nativeNested.getMainComponentAsync();
  eq(nativeNestedMain.name, "icon=beta", "P. INSTANCE_SWAP property выбрал назначенный компонент");
  eq(nativeNested.layoutAlign, "STRETCH",
    "P. native INSTANCE_SWAP сохранил FILL/STRETCH семантику slot относительно родителя");
  ok(host.calls.addComponentProperty >= 3, "P. схема создана через native addComponentProperty");
  ok(host.calls.setProperties >= 3, "P. значения применены через native setProperties");

  // Имя вхождения в выборе не участвует: все четыре названы одинаково «occ-…».
  ok(bySourceId(ids.occLH).getPluginData("pixsoDirectDefinitionId") === ids.bLH,
    "D. отпечаток активного определения — участник, названный symbolID");

  // -------------------------------------------------------------------------
  // E. Инстанс, созданный до объединения, пережил его
  // -------------------------------------------------------------------------
  for (var e = 0; e < occurrenceIds.length; e++) {
    var kept = before[occurrenceIds[e]];
    eq(kept.removed, false, "E. вхождение " + occurrenceIds[e] + " не удалено изменением набора");
    eq(kept.type, "INSTANCE", "E. вхождение " + occurrenceIds[e] + " осталось инстансом");
    var mainAfter = await kept.getMainComponentAsync();
    eq(mainAfter === beforeMain[occurrenceIds[e]], true,
      "E. мастер вхождения " + occurrenceIds[e] + " не подменился изменением набора");
  }

  // -------------------------------------------------------------------------
  // F. Подмена между участниками одного набора
  // -------------------------------------------------------------------------
  var iconSet = null;
  for (var t = 0; t < sets.length; t++) {
    if (sets[t].getPluginData("pixsoDirectVariantGroup") === ids.iconGroup) iconSet = sets[t];
  }
  ok(iconSet, "F. набор иконок собран");
  var swapped = bySourceId(ids.occSwap);
  var nestedSwapped = findAll(swapped, function (node) { return node.type === "INSTANCE"; })
    .filter(function (node) { return node !== swapped; });
  eq(nestedSwapped.length, 1, "F. внутри вхождения ровно один вложенный инстанс");
  var nestedMain = await nestedSwapped[0].getMainComponentAsync();
  eq(nestedMain.name, "icon=beta", "F. существующий путь подмены переключил участника набора");
  eq(nestedMain.parent === iconSet, true, "F. цель подмены лежит в наборе иконок");

  // Подмена работает и ПОСЛЕ объединения: участники остались годными целями.
  var alphaComponent = definitionComponent(ids.iconAlpha);
  ok(alphaComponent, "F. участник icon=alpha доступен после объединения");
  nestedSwapped[0].swapComponent(alphaComponent);
  var afterSwap = await nestedSwapped[0].getMainComponentAsync();
  eq(afterSwap === alphaComponent, true, "F. swapComponent между участниками набора работает после сборки");
  deep(Object.assign({}, nestedSwapped[0].variantProperties), { icon: "alpha" },
    "F. координата вхождения последовала за подменой");

  // -------------------------------------------------------------------------
  // N. Вложенное вхождение внутри определения указывает на нужного участника
  // -------------------------------------------------------------------------
  var buttonDefinition = definitionComponent(ids.bSD);
  ok(buttonDefinition, "N. определение участника доступно");
  eq(buttonDefinition.parent === buttonSet, true, "N. определение живёт внутри набора");
  var nestedInDefinition = findAll(buttonDefinition, function (node) { return node.type === "INSTANCE"; });
  eq(nestedInDefinition.length, 1, "N. в определении ровно одно вложенное вхождение");
  var nestedDefinitionMain = await nestedInDefinition[0].getMainComponentAsync();
  eq(nestedDefinitionMain.name, "icon=alpha", "N. вложенное вхождение указывает на своего участника");
  eq(nestedInDefinition[0].isExposedInstance, true,
    "D50. propsAreBubbled восстановлен как isExposedInstance на primary nested instance");
  eq(buttonDefinition.exposedInstances.length, 1,
    "D50. public exposedInstances read-back видит ровно exposed slot");
  eq(buttonDefinition.exposedInstances[0] === nestedInDefinition[0], true,
    "D50. exposedInstances возвращает именно исходный вложенный slot");
  eq(finish.nativePropertyReport.exposedInstancesRequested, 1,
    "D50. requested exposure измерен");
  eq(finish.nativePropertyReport.exposedInstancesApplied, 1,
    "D50. exposure применён");
  eq(finish.nativePropertyReport.exposedInstancesVerified, 1,
    "D50. exposure подтверждён public read-back");
  eq(finish.nativePropertyReport.exposedInstancesRejected, 0,
    "D50. exposure не был отвергнут хостом");

  // -------------------------------------------------------------------------
  // M. Определения остаются зарегистрированы и пригодны после объединения
  // -------------------------------------------------------------------------
  var lifetime = finish.definitionLifetimeReport;
  eq(lifetime.definitionsRegistered, ir.definitions.length,
    "M. все определения остались в реестре после объединения");
  eq(lifetime.instanceDefinitionUnavailable, 0, "M. ни одно определение не стало недоступным");
  eq(lifetime.placeholderFramesCreated, 0, "M. ни одного placeholder за job");
  eq(finish.instanceNameReport.mismatches, 0,
    "D40. после финального name commit нет расхождений occurrence name");
  eq(finish.finalMainComponentReport.mismatches, 0,
    "D40. final mainComponent соответствует ожидаемому source definition");
  ok(finish.componentIdentityLedger.definitions.length > 0 && finish.componentIdentityLedger.occurrences.length > 0,
    "D40. provenance ledger содержит definitions и occurrences");
  var freshInstance = buttonDefinition.createInstance();
  eq(freshInstance.type, "INSTANCE", "M. участник набора продолжает отдавать вхождения");
  deep(Object.assign({}, freshInstance.variantProperties), { Size: "Small", State: "Default" },
    "M. новое вхождение несёт координату участника");
  freshInstance.remove();

  // -------------------------------------------------------------------------
  // G. Откат погруппный: соседи собраны, визуал цел, причина названа
  // -------------------------------------------------------------------------
  var dupComponentA = definitionComponent(ids.dupA);
  var dupComponentB = definitionComponent(ids.dupB);
  ok(dupComponentA, "G. первый участник откатившейся группы остался компонентом");
  eq(dupComponentA.parent.type, "PAGE", "G. он не попал ни в какой набор");
  eq(dupComponentB, null, "G. второй участник в эту миграцию не приезжал вовсе");
  var dupOccurrence = bySourceId(ids.occDup);
  eq(dupOccurrence.type, "INSTANCE", "G. вхождение откатившейся группы осталось нативным инстансом");
  eq(findAll(dupComponentA, function (node) { return node.type === "RECTANGLE"; }).length, 1,
    "G. визуальное содержимое отката не потеряно");

  // -------------------------------------------------------------------------
  // O. Ticket 03: происхождение sizing от объединения не изменилось
  // -------------------------------------------------------------------------
  var inert = bySourceId(ids.occInert);
  var genuine = bySourceId(ids.occGenuine);
  ok(inert && genuine, "O. оба вхождения семейства форм построены");
  var shapeSet = null;
  for (var sh = 0; sh < sets.length; sh++) {
    if (sets[sh].getPluginData("pixsoDirectVariantGroup") === ids.shapeGroup) shapeSet = sets[sh];
  }
  ok(shapeSet, "O. семейство форм собрано в набор");
  eq(inert.primaryAxisSizingMode, "FIXED", "O. снимок sizing по-прежнему подавлен внутри набора");
  near(inert.width, 12, "O. разрушительное эхо не схлопнуло вхождение");
  eq(genuine.primaryAxisSizingMode, "AUTO", "O. настоящий HUG по-прежнему разрешён внутри набора");
  near(genuine.width, 100, "O. настоящий HUG посчитан по содержимому");

  // Никакой новый класс отказов не появился от одной лишь группировки.
  deep(Object.keys(finish.overrideResolutionReport.reasons), [],
    "O. промахов адресации не появилось");
  eq(finish.totals.instanceDefinitionUnavailable, 0, "O. недоступных определений нет");
  eq(finish.totals.placeholderFramesCreated, 0, "O. placeholder-ов нет");
  eq(finish.totals.nativePropertiesCreated, 3, "P. три public properties созданы нативно один раз на set");
  eq(finish.totals.nativePropertyBindingsApplied, 3, "P. три layer bindings применены");
  eq(finish.totals.nativePropertyValuesApplied, 3, "P. три occurrence values применены через setProperties");
  eq(finish.totals.nativePropertyValuesMissed, 0, "P. native values не потеряны");
  ok((finish.totals.nativePropertyNamesReconciled || 0) >= 1,
    "P2. stale generated property name восстановлен по финальной schema владельца");
  eq(finish.totals.nativePropertyValuesVerified, 3,
    "P. ownership разрешён только после read-back всех трёх native effects");
  eq(finish.totals.nativePropertyValuesUnverified, 0,
    "P. ни один успешный setProperties не остался непроверенным");
  ok(finish.totals.nativeOwnedLowLevelSuppressed >= 2,
    "P. успешные native BOOL/TEXT не переиграны теми же low-level fallback ops");
  eq(finish.totals.nativeOwnedLowLevelFallback, 0,
    "P. при успешном setProperties semantic fallback не понадобился");

  // -------------------------------------------------------------------------
  // Доказательство, прочитанное из документа, а не из счётчика
  // -------------------------------------------------------------------------
  var verification = report.verification;
  eq(verification.sets.length, 3, "выборка доказательств покрывает все три набора");
  verification.sets.forEach(function (entry) {
    eq(entry.setType, "COMPONENT_SET", "прочитанный тип набора — COMPONENT_SET");
    entry.members.forEach(function (member) {
      eq(member.type, "COMPONENT", "прочитанный тип участника — COMPONENT");
      eq(member.parentIsSet, true, "прочитанный родитель участника — его набор");
      eq(member.name, member.expectedName, "Figma сохранила имя участника без нормализации");
    });
  });
  ok(verification.instances.length > 0, "выборка вхождений непуста");
  verification.instances.forEach(function (entry) {
    eq(entry.type, "INSTANCE", "прочитанный тип вхождения — INSTANCE");
    eq(entry.mainComponentMatches, true, "мастер вхождения — участник, названный symbolID");
    ok(entry.variantProperties, "у вхождения есть variant-координата");
  });

  // -------------------------------------------------------------------------
  // Погруппный откат НА ПРИЁМНИКЕ.
  //
  // Отправитель такие пакеты не собирает — его проверка их отсекает. Но
  // страховка приёмника обязана быть проверяемой: она защищает от чужого
  // или более старого отправителя, и её отказ обязан быть погруппным.
  // -------------------------------------------------------------------------
  await runReceiverFallbackJob();
  await runCrossLocalFamilyAggregationJob();
  await runLateMemberJob();
  await runLateDuplicateJob();
  await runMirrorPropertyIdentityJob();

  process.stdout.write("OK: Direct PIX нативные наборы вариантов — " + checks + " проверок пройдено\n");
}()).catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  process.exit(1);
});
