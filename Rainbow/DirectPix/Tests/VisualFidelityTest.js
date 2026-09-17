/**
 * Обобщённые visual-fidelity правила Direct PIX.
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
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function solid(r, g, b) {
  return { type: "SOLID", color: { r: r, g: g, b: b, a: 255 }, visible: true, blendMode: "NORMAL" };
}

var ids = {
  document: "6:1", library: "6:2", page: "6:3", root: "6:4",
  base: "6:10", baseChild: "6:11", absolute: "6:12",
  occurrence: "6:20",
  copyA: "6:30", copyAChild: "6:31", copyB: "6:40", copyBChild: "6:41",
  copyDifferent: "6:50", copyDifferentChild: "6:51", copyDifferentExtra: "6:52",
  wrapper: "6:60", wrapperNested: "6:61",
  translated: "6:70", refused: "6:71", skewed: "6:72", lockedRatio: "6:73",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

  {
    guid: guid(ids.base), type: "SYMBOL", name: "Base", componentKey: "base",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 160, y: 48 },
    fillPaints: [solid(210, 210, 210)], strokePaints: [solid(10, 10, 10)],
    stackMode: "HORIZONTAL", stackSpacing: 8,
    stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    stackPrimaryAlignItems: "CENTER", stackCounterAlignItems: "CENTER",
  },
  {
    guid: guid(ids.baseChild), type: "RECTANGLE", name: "Body",
    parentIndex: parent(ids.base, "a"), transform: matrix(8, 8), size: { x: 80, y: 32 },
    fillPaints: [solid(240, 240, 240)], strokePaints: [solid(30, 30, 30)],
    rectangleTopLeftCornerRadius: 1, rectangleTopRightCornerRadius: 2,
    rectangleBottomRightCornerRadius: 3, rectangleBottomLeftCornerRadius: 4,
  },
  {
    guid: guid(ids.absolute), type: "RECTANGLE", name: "Overlay",
    parentIndex: parent(ids.base, "b"), transform: matrix(113, 7), size: { x: 19, y: 13 },
    autoLayoutAbsolutePos: true, fillPaints: [], strokePaints: [],
  },

  { guid: guid(ids.copyA), type: "SYMBOL", name: "Copy A", componentKey: "shared", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.copyAChild), type: "RECTANGLE", name: "Leaf", parentIndex: parent(ids.copyA, "a"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.copyB), type: "SYMBOL", name: "Copy B", componentKey: "shared", parentIndex: parent(ids.library, "d"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.copyBChild), type: "RECTANGLE", name: "Leaf", parentIndex: parent(ids.copyB, "a"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.copyDifferent), type: "SYMBOL", name: "Different", componentKey: "shared", parentIndex: parent(ids.library, "e"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.copyDifferentChild), type: "RECTANGLE", name: "Leaf", parentIndex: parent(ids.copyDifferent, "a"), transform: matrix(), size: { x: 20, y: 10 } },
  { guid: guid(ids.copyDifferentExtra), type: "TEXT", name: "Extra", parentIndex: parent(ids.copyDifferent, "b"), transform: matrix(0, 10), size: { x: 20, y: 10 }, textData: { characters: "x" } },
  { guid: guid(ids.wrapper), type: "SYMBOL", name: "Wrapper", componentKey: "wrapper", parentIndex: parent(ids.library, "f"), transform: matrix(), size: { x: 20, y: 20 } },
  { guid: guid(ids.wrapperNested), type: "INSTANCE", name: "Nested", parentIndex: parent(ids.wrapper, "a"), transform: matrix(), size: { x: 20, y: 20 }, symbolData: { symbolID: guid(ids.copyA) } },

  { guid: guid(ids.root), type: "FRAME", name: "Screen", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 1440, y: 900 }, stackMode: "VERTICAL", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" },
  {
    guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence", parentIndex: parent(ids.root, "a"),
    transform: matrix(12, 16), size: { x: 160, y: 48 }, fillPaints: [], strokePaints: [], effects: [],
    symbolData: {
      symbolID: guid(ids.base),
      symbolOverrides: [{
        guidPath: { guids: [guid(ids.baseChild)] },
        fillPaints: [], strokePaints: [],
        rectangleTopLeftCornerRadius: 9, rectangleTopRightCornerRadius: 8,
        rectangleBottomRightCornerRadius: 7, rectangleBottomLeftCornerRadius: 6,
      }],
    },
  },
  {
    guid: guid(ids.translated), type: "INSTANCE", name: "Translated", parentIndex: parent(ids.root, "b"),
    transform: matrix(0, 100), size: { x: 20, y: 20 },
    symbolData: { symbolID: guid(ids.wrapper), symbolOverrides: [{
      guidPath: { guids: [guid(ids.wrapperNested), guid(ids.copyBChild)] }, opacity: 0.25,
    }] },
  },
  {
    guid: guid(ids.refused), type: "INSTANCE", name: "Refused", parentIndex: parent(ids.root, "c"),
    transform: matrix(0, 140), size: { x: 20, y: 20 },
    symbolData: { symbolID: guid(ids.wrapper), symbolOverrides: [{
      guidPath: { guids: [guid(ids.wrapperNested), guid(ids.copyDifferentChild)] }, opacity: 0.5,
    }] },
  },
  {
    guid: guid(ids.skewed), type: "RECTANGLE", name: "Skewed", parentIndex: parent(ids.root, "d"),
    transform: { m00: 1, m01: 0.2, m02: 40, m10: 0, m11: Math.sqrt(0.96), m12: 180 },
    size: { x: 40, y: 20 }, fillPaints: [solid(1, 2, 3)],
  },
  {
    guid: guid(ids.lockedRatio), type: "RECTANGLE", name: "Locked ratio", parentIndex: parent(ids.root, "e"),
    transform: matrix(100, 180), size: { x: 40, y: 20 }, proportionsConstrained: true, fillPaints: [solid(1, 2, 3)],
  },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-visual-fidelity-"));
try {
  var file = path.join(temp, "visual.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)], debugOverrides: true, visualSafety: false });
  var rootNodes = ir.roots[0].nodes;
  var occurrence = rootNodes.filter(function (node) { return node.id === ids.occurrence; })[0];
  var definition = ir.definitions.filter(function (item) { return item.definitionId === ids.base; })[0];
  var master = definition.nodes[0];
  var masterChild = definition.nodes.filter(function (node) { return node.id === ids.baseChild; })[0];
  var absolute = definition.nodes.filter(function (node) { return node.id === ids.absolute; })[0];

  eq(ir.roots[0].nodes[0].width, 1440, "explicit root width remains source-defined");
  eq(ir.roots[0].nodes[0].height, 900, "explicit root height remains source-defined");
  eq(master.fills.length, 1, "canonical master keeps canonical fill");
  eq(occurrence.fills.length, 0, "explicit empty occurrence fill clears master fill");
  eq(occurrence.strokes.length, 0, "explicit empty occurrence stroke clears master stroke");
  eq(occurrence.effects.length, 0, "explicit empty occurrence effects clear master effects");
  eq(masterChild.fills.length, 1, "occurrence paint does not contaminate canonical child");

  var childOverride = occurrence.overrides.filter(function (entry) {
    return entry.path.length === 1 && entry.path[0].sourceId === ids.baseChild;
  })[0];
  ok(childOverride, "child override is emitted");
  // Пустой repeated-список в записи override — заглушка сериализатора Pixso,
  // а не очистка: запись меняет только углы, краски мастера остаются.
  // Разбор доказательств — в `PixNormalizer.overrideRepeated`.
  ok(!hasOwn(childOverride.ops, "fills") && !childOverride.present.fills,
    "empty override fill list carries no paint operation");
  ok(!hasOwn(childOverride.ops, "strokes") && !childOverride.present.strokes,
    "empty override stroke list carries no paint operation");
  eq(childOverride.ops.corners.topLeftRadius, 9, "independent top-left radius survives");
  eq(childOverride.ops.corners.bottomLeftRadius, 6, "independent bottom-left radius survives");

  eq(absolute.childLayout.layoutPositioning, "ABSOLUTE", "absolute child is excluded from flow");
  eq(absolute.x, 113, "absolute child keeps local x");
  eq(absolute.y, 7, "absolute child keeps local y");
  eq(master.autoLayout.layoutMode, "HORIZONTAL", "generic horizontal auto layout is preserved");
  eq(master.autoLayout.itemSpacing, 8, "generic horizontal spacing is preserved");
  eq(master.autoLayout.primaryAxisAlignItems, "CENTER", "generic primary alignment is preserved");
  eq(master.autoLayout.counterAxisAlignItems, "CENTER", "generic counter alignment is preserved");

  var skewed = rootNodes.filter(function (node) { return node.id === ids.skewed; })[0];
  ok(Array.isArray(skewed.relativeTransform), "unit-axis skew is preserved as relativeTransform");
  eq(skewed.relativeTransform[0][2], 40, "relativeTransform keeps x translation");
  eq(skewed.relativeTransform[1][2], 180, "relativeTransform keeps y translation");
  var lockedRatio = rootNodes.filter(function (node) { return node.id === ids.lockedRatio; })[0];
  eq(lockedRatio.aspectRatioLocked, true, "proportionsConstrained becomes native aspect-ratio lock intent");

  var translated = rootNodes.filter(function (node) { return node.id === ids.translated; })[0];
  var translatedOpacity = translated.overrides.filter(function (entry) { return entry.ops.opacity !== undefined; })[0];
  ok(translatedOpacity, "strictly identical copy gets a translated path");
  eq(translatedOpacity.path[1].sourceId, ids.copyAChild, "translation targets active copy source id");
  eq(ir.stats.pathsTranslatedAcrossCopies, 1, "cross-copy translation is measured");
  eq(translatedOpacity.path[1].definitionId, ids.copyA, "path carries active definition context");
  eq(translatedOpacity.path[1].definitionPath.join("."), "0", "path carries definition-relative index");

  ok(ir.overrideResolution.TARGET_IN_OTHER_COMPONENT_COPY >= 1,
    "structurally different copy is refused instead of guessed");
  ok(!master.directPixVisualFallback, "canonical master is never built from occurrence fallback");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("OK: Direct PIX visual fidelity — " + checks + " проверок пройдено\n");
