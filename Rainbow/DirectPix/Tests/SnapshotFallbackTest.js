/**
 * Отказ семантики не имеет права уронить корень.
 *
 * Два разных отказа, и они обязаны различаться в отчёте:
 *
 *   1. Символ вхождения в документе отсутствует. Каноническая идентичность
 *      не разрешена, содержимое взять неоткуда — вхождение становится
 *      помеченным пустым фреймом. Выдумывать здесь нечего, и попытка
 *      «похожего» символа была бы хуже дырки.
 *   2. Символ найден, но его определение построить нельзя: он прямо или
 *      косвенно содержит вхождение самого себя. Развернуть такое содержимое
 *      нельзя по построению — это и есть бесконечность, а выбор произвольной
 *      глубины был бы выдумкой. Пустой помеченный фрейм ставится ВНУТРИ
 *      определения, само определение остаётся годным, и внешнее вхождение
 *      остаётся нативным инстансом.
 *
 * Тест фиксирует и то, что во втором случае id узлов определения остаются
 * уникальными: дублирующийся id ломает адресацию override на приёмнике.
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

var ids = {
  document: "9:1", library: "9:2", page: "9:3", root: "9:4",
  recursive: "9:10", recursiveBody: "9:11", recursiveLabel: "9:12", recursiveSelf: "9:13",
  occurrence: "9:20",
  orphan: "9:30",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },

  {
    guid: guid(ids.recursive), type: "SYMBOL", name: "Recursive", componentKey: "recursive",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 100, y: 60 },
  },
  {
    guid: guid(ids.recursiveBody), type: "FRAME", name: "Body",
    parentIndex: parent(ids.recursive, "a"), transform: matrix(), size: { x: 100, y: 30 },
  },
  {
    guid: guid(ids.recursiveLabel), type: "TEXT", name: "Label",
    parentIndex: parent(ids.recursiveBody, "a"), transform: matrix(), size: { x: 100, y: 20 },
    textData: { characters: "Внутри" },
  },
  {
    guid: guid(ids.recursiveSelf), type: "INSTANCE", name: "Self",
    parentIndex: parent(ids.recursive, "b"), transform: matrix(0, 30), size: { x: 100, y: 30 },
    symbolData: { symbolID: guid(ids.recursive) },
  },

  { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 300, y: 300 } },
  {
    guid: guid(ids.occurrence), type: "INSTANCE", name: "Recursive occurrence",
    parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 60 },
    symbolData: {
      symbolID: guid(ids.recursive),
      symbolOverrides: [
        { guidPath: { guids: [guid(ids.recursiveBody), guid(ids.recursiveLabel)] }, textData: { characters: "Снаружи" } },
      ],
    },
  },
  {
    guid: guid(ids.orphan), type: "INSTANCE", name: "Orphan occurrence",
    parentIndex: parent(ids.root, "b"), transform: matrix(0, 100), size: { x: 50, y: 50 },
    symbolData: { symbolID: guid("9:777") },
  },
];

function runRecursiveFallback() {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-snapshot-"));
  try {
    var file = path.join(temp, "snapshot.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)] });
    var rootNodes = ir.roots[0].nodes;
    function byId(list, id) {
      return list.filter(function (node) { return node.id === id; })[0];
    }

    // --- Корень не падает --------------------------------------------------
    ok(ir.roots.length === 1, "корень собран, несмотря на оба отказа");
    eq(rootNodes.length, 3, "в дереве корня остались все три узла");

    // --- Счётчики канонической идентичности --------------------------------
    // Вхождений три: два в корне плюс рекурсивное внутри определения.
    eq(ir.stats.pixInstancesSeen, 3, "просмотрены все вхождения, включая вложенное");
    eq(ir.stats.canonicalResolved, 2, "идентичность найдена там, где символ есть");
    eq(ir.stats.canonicalUnresolved, 1, "и не найдена там, где символа нет");
    eq(ir.stats.resolvedViaInternalOnly, 2, "оба символа найдены на служебном полотне");
    eq(ir.canonicalResolution.SYMBOL_NOT_FOUND, 1, "у промаха системная причина, а не общий счётчик");
    eq(ir.canonicalResolutionSamples.length, 1, "промах попал в ограниченную выборку");
    eq(ir.canonicalResolutionSamples[0].occurrenceId, ids.orphan, "в выборке именно тот узел");
    eq(ir.canonicalResolutionSamples[0].normalizedSymbolId, "9:777",
      "и нормализованная ссылка, по которой искали");

    // --- Отказ 1: символа нет ----------------------------------------------
    var orphan = byId(rootNodes, ids.orphan);
    ok(orphan, "вхождение без символа осталось в дереве, а не исчезло");
    eq(orphan.kind, "ORDINARY", "оно стало обычным узлом");
    eq(orphan.directPixFallback, true, "и помечено фоллбеком");
    eq(rootNodes.filter(function (node) { return node.parent === ids.orphan; }).length, 0,
      "содержимого у него нет и взять его неоткуда — «похожий» символ подставлять нельзя");

    // --- Отказ 2: рекурсивный символ ---------------------------------------
    var occurrence = byId(rootNodes, ids.occurrence);
    ok(occurrence, "рекурсивное вхождение осталось в дереве");
    eq(occurrence.kind, "INSTANCE", "и осталось нативным вхождением: его определение годно");
    eq(occurrence.definitionId, ids.recursive, "оно указывает на своё определение");
    ok(occurrence.overrides && occurrence.overrides.length === 1,
      "дельта вхождения посчитана по дереву определения");
    eq(occurrence.overrides[0].ops.characters, "Снаружи", "и текстовая правка в ней сохранена");

    var definition = ir.definitions.filter(function (entry) {
      return entry.definitionId === ids.recursive;
    })[0];
    ok(definition, "определение рекурсивного символа собрано");

    // Главное: id внутри определения уникальны. Дубликат сломал бы и карту
    // узлов приёмника, и адресацию override по sourceId.
    var seen = Object.create(null);
    var duplicates = definition.nodes.filter(function (node) {
      if (seen[node.id]) return true;
      seen[node.id] = true;
      return false;
    });
    eq(duplicates.length, 0, "в определении нет повторяющихся id узлов");

    var self = byId(definition.nodes, ids.recursiveSelf);
    ok(self, "вхождение символа в самого себя осталось в определении");
    eq(self.kind, "ORDINARY", "но не как вхождение: развернуть его нельзя по построению");
    eq(self.directPixFallback, true, "оно помечено фоллбеком");
    eq(definition.nodes.filter(function (node) { return node.parent === ids.recursiveSelf; }).length, 0,
      "и содержимого внутрь него не подставлено");
    ok(ir.unsupported.CYCLIC_DEFINITION >= 1, "цикл посчитан, а не потерян");
    eq(ir.stats.instanceFallbacks, 2, "оба фоллбека посчитаны");

    // Настоящее содержимое символа при этом на месте — в самом определении.
    var label = byId(definition.nodes, ids.recursiveLabel);
    ok(label, "текст символа лежит в определении");
    eq(label.text.characters, "Внутри", "с содержимым определения, а правка едет дельтой вхождения");

    process.stdout.write("OK: Direct PIX отказ семантики не роняет корень — " + checks + " проверок пройдено\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}



function runNestedTextLayoutFallback() {
  var local = {
    document: "19:1", library: "19:2", page: "19:3", root: "19:4",
    symbol: "19:10", label: "19:11", occurrenceA: "19:20", occurrenceB: "19:21",
  };
  var scene = [
    { guid: guid(local.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(local.library), type: "CANVAS", name: "Library", internalOnly: true,
      parentIndex: parent(local.document, "a") },
    { guid: guid(local.page), type: "CANVAS", name: "Screen", parentIndex: parent(local.document, "b") },
    {
      guid: guid(local.symbol), type: "SYMBOL", name: "Intrinsic label", componentKey: "intrinsic-label",
      parentIndex: parent(local.library, "a"), transform: matrix(), size: { x: 31, y: 20 },
      stackMode: "HORIZONTAL", stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(local.label), type: "TEXT", name: "Label",
      parentIndex: parent(local.symbol, "a"), transform: matrix(), size: { x: 31, y: 20 },
      textData: { characters: "Base" }, textAutoResize: "WIDTH_AND_HEIGHT",
    },
    {
      guid: guid(local.root), type: "FRAME", name: "Root", parentIndex: parent(local.page, "a"),
      transform: matrix(), size: { x: 600, y: 300 },
    },
    {
      guid: guid(local.occurrenceA), type: "INSTANCE", name: "Long A",
      parentIndex: parent(local.root, "a"), transform: matrix(), size: { x: 187, y: 20 },
      symbolData: {
        symbolID: guid(local.symbol),
        symbolOverrides: [{
          guidPath: { guids: [guid(local.label)] },
          textData: { characters: "Образец файла для скачивания" },
          textAutoResize: "HEIGHT",
        }],
      },
    },
    {
      guid: guid(local.occurrenceB), type: "INSTANCE", name: "Long B",
      parentIndex: parent(local.root, "b"), transform: matrix(0, 60), size: { x: 250, y: 20 },
      symbolData: {
        symbolID: guid(local.symbol),
        symbolOverrides: [{
          guidPath: { guids: [guid(local.label)] },
          textData: { characters: "Другой длинный текст" },
          textAutoResize: "HEIGHT",
        }],
      },
    },
  ];

  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-text-layout-fallback-"));
  try {
    var file = path.join(temp, "text-layout.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: scene, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(local.root)] });
    var rootNodes = ir.roots[0].nodes;
    var a = rootNodes.filter(function (node) { return node.id === local.occurrenceA; })[0];
    var b = rootNodes.filter(function (node) { return node.id === local.occurrenceB; })[0];
    ok(a && b, "оба occurrence остались в корне");
    eq(a.kind, "ORDINARY", "nested text width, невыразимый native INSTANCE, развёрнут snapshot-ом");
    eq(b.kind, "ORDINARY", "второй occurrence того же определения тоже развёрнут snapshot-ом");
    ok(String(a.directPixVisualFallback).indexOf("NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE") >= 0,
      "snapshot называет причинный класс потери");
    eq(ir.stats.nativeFallbackByReason.NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE, 2,
      "оба доказанных непредставимых occurrence посчитаны");

    var aText = rootNodes.filter(function (node) {
      return node.parent === local.occurrenceA && node.type === "TEXT";
    })[0];
    var bText = rootNodes.filter(function (node) {
      return node.parent === local.occurrenceB && node.type === "TEXT";
    })[0];
    ok(aText && bText, "оба snapshot содержат свой TEXT descendant");
    eq(aText.width, 187, "первый snapshot материализовал inferred textbox width");
    eq(bText.width, 250, "второй snapshot материализовал собственный inferred textbox width");
    eq(aText.text.characters, "Образец файла для скачивания", "первый текст не потерян");
    eq(bText.text.characters, "Другой длинный текст", "второй текст не потерян");
    eq(aText.text.textAutoResize, "HEIGHT", "первый TEXT сохранил HEIGHT semantics");
    eq(bText.text.textAutoResize, "HEIGHT", "второй TEXT сохранил HEIGHT semantics");
    ok(aText.id !== bText.id, "два snapshot одного definition получили разные IR ids");
    eq(aText.directPixFallbackSourceId, local.label, "канонический source id сохранён отдельно");
    eq(bText.directPixFallbackSourceId, local.label, "source id второго snapshot тоже сохранён");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}


function runNestedSnapshotParentRebase() {
  var local = {
    document: "20:1", library: "20:2", page: "20:3", root: "20:4",
    inner: "20:10", innerText: "20:11",
    outer: "20:20", nested: "20:21", occurrence: "20:30", decoy: "20:99",
  };
  var scene = [
    { guid: guid(local.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(local.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(local.document, "a") },
    { guid: guid(local.page), type: "CANVAS", name: "Screen", parentIndex: parent(local.document, "b") },
    { guid: guid(local.decoy), type: "RECTANGLE", name: "Unrelated", parentIndex: parent(local.library, "z"), transform: matrix(), size: { x: 1, y: 1 } },
    { guid: guid(local.inner), type: "SYMBOL", name: "Inner", componentKey: "inner", parentIndex: parent(local.library, "a"), transform: matrix(), size: { x: 80, y: 24 } },
    { guid: guid(local.innerText), type: "TEXT", name: "Text", parentIndex: parent(local.inner, "a"), transform: matrix(), size: { x: 80, y: 24 }, textData: { characters: "Inner" } },
    { guid: guid(local.outer), type: "SYMBOL", name: "Outer", componentKey: "outer", parentIndex: parent(local.library, "b"), transform: matrix(), size: { x: 100, y: 40 } },
    {
      guid: guid(local.nested), type: "INSTANCE", name: "Nested", parentIndex: parent(local.outer, "a"), transform: matrix(), size: { x: 80, y: 24 },
      symbolData: { symbolID: guid(local.inner), symbolOverrides: [
        { guidPath: { guids: [guid(local.decoy)] }, visible: false },
      ] },
    },
    { guid: guid(local.root), type: "FRAME", name: "Root", parentIndex: parent(local.page, "a"), transform: matrix(), size: { x: 300, y: 200 } },
    {
      guid: guid(local.occurrence), type: "INSTANCE", name: "Outer occurrence", parentIndex: parent(local.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: { symbolID: guid(local.outer), symbolOverrides: [
        { guidPath: { guids: [guid(local.decoy)] }, visible: false },
      ] },
    },
  ];

  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-nested-snapshot-"));
  try {
    var file = path.join(temp, "nested-snapshot.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: scene, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(local.root)] });
    var rootNodes = ir.roots[0].nodes;
    var outerFallback = rootNodes.filter(function (node) { return node.id === local.occurrence; })[0];
    ok(outerFallback && outerFallback.kind === "ORDINARY", "outer unsafe occurrence развёрнут snapshot-ом");
    var nestedFallback = rootNodes.filter(function (node) {
      return node.directPixFallbackSourceId === local.nested && node.kind === "ORDINARY";
    })[0];
    ok(nestedFallback, "unsafe nested occurrence тоже развёрнут внутри outer snapshot");
    ok(nestedFallback.id.indexOf(local.occurrence + ";snapshot-occ:" + local.nested) === 0,
      "nested fallback получил namespace внешнего occurrence");
    var nestedText = rootNodes.filter(function (node) {
      return node.directPixFallbackSourceId === local.innerText;
    })[0];
    ok(nestedText, "descendant вложенного fallback материализован");
    eq(nestedText.parent, nestedFallback.id,
      "descendant ссылается на фактически эмитированный namespaced fallback root");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}



function runSnapshotStyleOverrideBinding() {
  var local = {
    document: "31:1", library: "31:2", page: "31:3", root: "31:4",
    baseStyle: "31:5", overrideStyle: "31:6",
    symbol: "31:10", label: "31:11", occurrence: "31:20",
  };
  var basePaint = [{ type: "SOLID", color: { r: 68, g: 83, b: 113, a: 255 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  var overridePaint = [{ type: "SOLID", color: { r: 133, g: 143, b: 163, a: 255 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  var scene = [
    { guid: guid(local.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(local.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(local.document, "a") },
    { guid: guid(local.page), type: "CANVAS", name: "Screen", parentIndex: parent(local.document, "b") },
    {
      guid: guid(local.baseStyle), type: "RECTANGLE", name: "base/fg", parentIndex: parent(local.library, "a"),
      styleType: "FILL", key: "base-style-key", sharedStyleReference: { styleKey: "base-style-key", versionHash: "1" },
      fillPaints: basePaint,
    },
    {
      guid: guid(local.overrideStyle), type: "RECTANGLE", name: "override/fg", parentIndex: parent(local.library, "b"),
      styleType: "FILL", key: "override-style-key", sharedStyleReference: { styleKey: "override-style-key", versionHash: "1" },
      fillPaints: overridePaint,
    },
    {
      guid: guid(local.symbol), type: "SYMBOL", name: "Styled label", componentKey: "styled-label",
      parentIndex: parent(local.library, "c"), transform: matrix(), size: { x: 80, y: 20 },
      stackMode: "HORIZONTAL", stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(local.label), type: "TEXT", name: "Label", parentIndex: parent(local.symbol, "a"),
      transform: matrix(), size: { x: 80, y: 20 }, textData: { characters: "Base" },
      textAutoResize: "WIDTH_AND_HEIGHT", fillPaints: basePaint, inheritFillStyleID: guid(local.baseStyle),
    },
    { guid: guid(local.root), type: "FRAME", name: "Root", parentIndex: parent(local.page, "a"), transform: matrix(), size: { x: 300, y: 200 } },
    {
      guid: guid(local.occurrence), type: "INSTANCE", name: "Styled occurrence", parentIndex: parent(local.root, "a"),
      transform: matrix(), size: { x: 180, y: 20 }, symbolData: {
        symbolID: guid(local.symbol),
        symbolOverrides: [{
          guidPath: { guids: [guid(local.label)] },
          textData: { characters: "Override" }, textAutoResize: "HEIGHT",
          // Pixso commonly serializes an empty local paint array together with
          // a non-empty style reference. The style is the effective override.
          fillPaints: [], inheritFillStyleID: guid(local.overrideStyle),
        }],
      },
    },
  ];

  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-snapshot-style-"));
  try {
    var file = path.join(temp, "snapshot-style.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: scene, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(local.root)] });
    var snapshotText = ir.roots[0].nodes.filter(function (node) {
      return node.directPixFallbackSourceId === local.label;
    })[0];
    ok(snapshotText, "style override test materialized TEXT inside snapshot fallback");
    eq(snapshotText.kind, "ORDINARY", "snapshot TEXT remains ordinary editable node");
    ok(snapshotText.styles && snapshotText.styles.fill,
      "snapshot materializes the occurrence fill-style binding, not only resolved paints");
    var bound = ir.styles.filter(function (style) { return style.styleId === snapshotText.styles.fill; })[0];
    ok(bound, "snapshot style binding points at a serialized native style");
    eq(bound.sourceGuid, local.overrideStyle,
      "occurrence override style replaces the definition base style in snapshot fallback");
    eq(snapshotText.fills[0].color.r, 0.52157,
      "snapshot resolved paint matches the override style visual value");
    eq(snapshotText.text.fills[0].color.r, 0.52157,
      "snapshot TEXT payload receives the same resolved occurrence fill");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

runRecursiveFallback();
runNestedTextLayoutFallback();
runNestedSnapshotParentRebase();
runSnapshotStyleOverrideBinding();
