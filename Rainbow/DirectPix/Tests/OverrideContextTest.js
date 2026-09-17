/**
 * Direct PIX: семантический контекст записи override.
 *
 *   node DirectPix/Tests/OverrideContextTest.js
 *
 * Проверяется одно утверждение и обе его стороны:
 *
 *   к каждому вхождению применяются ровно те правки, которые адресованы его
 *   ЭФФЕКТИВНОМУ определению, — ни одной чужой и ни одной потерянной.
 *
 * Адрес override — это адрес в конкретном определении, а не в узле вообще.
 * Структурная операция (подмена компонента) меняет определение, которое узел
 * показывает, и все ранее разрешённые под ним адреса становятся адресами
 * чужого дерева. Ни один тест здесь не опирается на имя слоя, имя компонента
 * или конкретный текст дизайн-системы: сценарии синтетические.
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

/** Собирает IR по списку узлов и возвращает вместе с документом. */
function buildIr(nodes, rootId, options) {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-context-"));
  try {
    var file = path.join(temp, "scene.pix");
    fs.writeFileSync(file, Fixture.buildContainer({
      build: { nodes: nodes, blobs: [], resources: [] },
    }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, Object.assign({
      roots: [doc.tree.byKey.get(rootId)], debugOverrides: true,
    }, options || {}));
    return { doc: doc, ir: ir };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function nodeById(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function snapshotNodeBySourceId(list, sourceId) {
  for (var i = 0; i < list.length; i++) {
    var node = list[i];
    if (node.directPixFallbackSourceId === sourceId) return node;
    if (node.id && String(node.id).slice(-(String(sourceId).length + 1)) === ";" + sourceId) return node;
  }
  return null;
}

function textOps(node) {
  return (node && node.overrides || []).filter(function (entry) {
    return typeof entry.ops.characters === "string";
  });
}

/** Все записи override любого вхождения дерева — вместе с их контекстом. */
function allEntries(ir) {
  var out = [];
  function collect(where, nodes) {
    nodes.forEach(function (node) {
      (node.overrides || []).forEach(function (entry) {
        out.push({ where: where, node: node, entry: entry });
      });
    });
  }
  ir.roots.forEach(function (root) { collect("root", root.nodes); });
  ir.definitions.forEach(function (definition) { collect("definition", definition.nodes); });
  return out;
}

// ---------------------------------------------------------------------------
// 1. Текстовая правка обычного вхождения
// ---------------------------------------------------------------------------
(function plainInstanceText() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    button: "9:10", buttonLabel: "9:11", occurrence: "9:20",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.button), type: "SYMBOL", name: "Button", componentKey: "button", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 32 } },
    { guid: guid(ids.buttonLabel), type: "TEXT", name: "Label", parentIndex: parent(ids.button, "a"), transform: matrix(), size: { x: 80, y: 16 }, textData: { characters: "Button" } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 80, y: 32 },
      symbolData: {
        symbolID: guid(ids.button),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.buttonLabel)] }, textData: { characters: "Save" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root);
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(occurrence, "вхождение попало в IR");
  eq(occurrence.kind, "INSTANCE", "вхождение осталось нативным инстансом");
  var text = textOps(occurrence);
  eq(text.length, 1, "ровно одна текстовая правка");
  eq(text[0].ops.characters, "Save", "текст вхождения доехал");
  eq(text[0].path[0].definitionId, occurrence.definitionId,
    "путь правки разрешён в активном определении вхождения");
  eq(text[0].path[0].sourceId, ids.buttonLabel, "цель адресована stable source GUID");
})();

// ---------------------------------------------------------------------------
// 2. Текст внутри вложенного инстанса
// ---------------------------------------------------------------------------
(function nestedInstanceText() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    label: "9:10", labelText: "9:11",
    card: "9:20", cardLabel: "9:21",
    occurrence: "9:30",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.label), type: "SYMBOL", name: "Label", componentKey: "label", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelText), type: "TEXT", name: "Text", parentIndex: parent(ids.label, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "Label" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 40 } },
    { guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 16 }, symbolData: { symbolID: guid(ids.label) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelText)] }, textData: { characters: "Nested" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root);
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  var text = textOps(occurrence);
  eq(text.length, 1, "правка вложенного текста доехала");
  eq(text[0].ops.characters, "Nested", "текст вложенного инстанса сохранён");
  eq(text[0].path.length, 2, "адрес прошёл через вложенное вхождение");
  eq(text[0].path[0].definitionId, ids.card, "первый шаг разрешён в определении вхождения");
  eq(text[0].path[1].definitionId, ids.label, "второй шаг разрешён в определении вложенного символа");
})();

// ---------------------------------------------------------------------------
// 3. Подмена вложенного компонента, затем текст в активном определении
// ---------------------------------------------------------------------------
(function swapThenText() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    labelA: "9:10", labelAText: "9:11",
    labelB: "9:20", labelBText: "9:21",
    card: "9:30", cardLabel: "9:31",
    occurrence: "9:40",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.labelA), type: "SYMBOL", name: "Label A", componentKey: "label-a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelAText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelA, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "A" } },
    { guid: guid(ids.labelB), type: "SYMBOL", name: "Label B", componentKey: "label-b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelBText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelB, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "B" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 40 } },
    { guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 16 }, symbolData: { symbolID: guid(ids.labelA) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardLabel)] }, overriddenSymbolID: guid(ids.labelB) },
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelBText)] }, textData: { characters: "Swapped" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  var swap = (occurrence.overrides || []).filter(function (entry) {
    return entry.ops.swapDefinitionId !== undefined;
  })[0];
  ok(swap, "подмена вложенного компонента доехала отдельной операцией");
  eq(swap.ops.swapDefinitionId, ids.labelB, "подмена указывает на активное определение");
  var text = textOps(occurrence);
  eq(text.length, 1, "текст после подмены доехал");
  eq(text[0].ops.characters, "Swapped", "текст взят из записи вхождения");
  eq(text[0].path[1].definitionId, ids.labelB,
    "второй шаг разрешён в АКТИВНОМ определении, а не в объявленном");
  eq(text[0].path[1].sourceId, ids.labelBText, "цель взята из дерева Label B");
  ok(swap.path.length < text[0].path.length,
    "подмена уезжает раньше правки внутри подменённого дерева");
})();

// ---------------------------------------------------------------------------
// 4. Подмена не имеет права утащить с собой дельту предыдущего определения
// ---------------------------------------------------------------------------
//
// У определения `Card` есть собственная дельта вложенного вхождения: текст
// «Design time». Вхождение подменяет это вложенное вхождение на другой
// компонент. Дельта, посчитанная в дереве Label A, к дереву Label B
// отношения не имеет: её обязана снять типизированная причина, а не
// случайное несовпадение индекса.
(function swapInvalidatesPreviousDelta() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    labelA: "9:10", labelAText: "9:11",
    labelB: "9:20", labelBText: "9:21",
    card: "9:30", cardLabel: "9:31",
    occurrence: "9:40", broken: "9:50",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.labelA), type: "SYMBOL", name: "Label A", componentKey: "label-a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelAText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelA, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "A" } },
    { guid: guid(ids.labelB), type: "SYMBOL", name: "Label B", componentKey: "label-b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelBText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelB, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "B" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 40 } },
    {
      guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label",
      parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 16 },
      symbolData: {
        symbolID: guid(ids.labelA),
        // Собственная дельта определения: так компонент выглядит по умолчанию.
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.labelAText)] }, textData: { characters: "Design time" } },
        ],
      },
    },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          // Промах адресации роняет вхождение в развёрнутое поддерево — тот
          // самый путь, на котором подмена и меняла определение уже
          // построенного узла.
          { guidPath: { guids: [guid(ids.broken)] }, visible: false },
          { guidPath: { guids: [guid(ids.cardLabel)] }, overriddenSymbolID: guid(ids.labelB) },
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelBText)] }, textData: { characters: "Occurrence" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root);
  var expanded = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(expanded, "вхождение осталось в дереве");
  eq(expanded.kind, "ORDINARY", "вхождение приехало развёрнутым поддеревом");

  var nested = snapshotNodeBySourceId(built.ir.roots[0].nodes, ids.cardLabel);
  ok(nested, "вложенное вхождение построено внутри разворота");
  eq(nested.definitionId, ids.labelB, "подмена сменила активное определение вложенного узла");

  var stale = (nested.overrides || []).filter(function (entry) {
    return entry.ops.characters === "Design time";
  });
  eq(stale.length, 0, "дельта предыдущего определения снята, а не перенесена вслепую");

  var kept = textOps(nested);
  eq(kept.length, 1, "правка вхождения после подмены сохранена");
  eq(kept[0].ops.characters, "Occurrence", "текст вхождения дошёл до активного определения");
  eq(kept[0].path[0].definitionId, ids.labelB, "адрес разрешён в активном определении");

  eq(built.ir.overrideResolution.OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP, 1,
    "снятая запись получила типизированную причину, а не общий промах");
  ok(built.ir.stats.overrideContextInvalidated >= 1,
    "снятые операции посчитаны отдельной величиной");
  var sample = built.ir.overrideResolutionSamples.filter(function (item) {
    return item.reason === "OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP";
  })[0];
  ok(sample, "у причины есть образец");
  eq(sample.detail.activeSymbolBefore, ids.labelA, "образец называет прежнее определение");
  eq(sample.detail.activeSymbolAfter, ids.labelB, "образец называет активное определение");
  eq(sample.detail.expectedTargetType, "TEXT", "образец называет ожидаемый тип цели");
})();

// ---------------------------------------------------------------------------
// 4b. Дельта вхождения ложится ПОВЕРХ дельты определения, а не рядом с ней
// ---------------------------------------------------------------------------
//
// У вложенного вхождения внутри определения есть собственный текст. Внешнее
// вхождение правит тот же самый узел. Это одна цель и один адрес: две записи
// на нём означали бы, что приёмник применит их в порядке массива — на
// настоящем файле так и получалось, и порядок был единственной защитой
// текста вхождения.
(function occurrenceDeltaWinsOverDefinitionDelta() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    label: "9:10", labelText: "9:11", labelIcon: "9:12",
    card: "9:20", cardLabel: "9:21",
    occurrence: "9:30", broken: "9:40",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.label), type: "SYMBOL", name: "Label", componentKey: "label", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 32 } },
    { guid: guid(ids.labelText), type: "TEXT", name: "Text", parentIndex: parent(ids.label, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "Master" } },
    { guid: guid(ids.labelIcon), type: "RECTANGLE", name: "Icon", parentIndex: parent(ids.label, "b"), transform: matrix(), size: { x: 16, y: 16 } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 40 } },
    {
      guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label",
      parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 32 },
      symbolData: {
        symbolID: guid(ids.label),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.labelText)] }, textData: { characters: "Design time" } },
          // Правка, которой у вхождения нет: она обязана уцелеть.
          { guidPath: { guids: [guid(ids.labelIcon)] }, visible: false },
        ],
      },
    },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          // Промах роняет вхождение в развёрнутое поддерево.
          { guidPath: { guids: [guid(ids.broken)] }, visible: false },
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelText)] }, textData: { characters: "Occurrence" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root);
  var nested = snapshotNodeBySourceId(built.ir.roots[0].nodes, ids.cardLabel);
  ok(nested, "вложенное вхождение построено внутри разворота");
  eq(nested.definitionId, ids.label, "определение вложенного узла не менялось");

  var byIndexPath = Object.create(null);
  (nested.overrides || []).forEach(function (entry) {
    var key = entry.path.map(function (step) { return step.index; }).join(".");
    byIndexPath[key] = (byIndexPath[key] || 0) + 1;
  });
  Object.keys(byIndexPath).forEach(function (key) {
    eq(byIndexPath[key], 1, "на адрес " + key + " приходится ровно одна запись");
  });

  var text = textOps(nested);
  eq(text.length, 1, "текст цели описан одной записью");
  eq(text[0].ops.characters, "Occurrence",
    "дельта вхождения перекрыла дельту определения на том же адресе");
  ok(built.ir.stats.overrideDefinitionOpsOverridden >= 1,
    "перекрытые операции определения посчитаны отдельной величиной");

  var icon = (nested.overrides || []).filter(function (entry) {
    return entry.path.length === 1 && entry.path[0].sourceId === ids.labelIcon;
  })[0];
  ok(icon, "правка определения, которой вхождение не касалось, сохранена");
  eq(icon.ops.visible, false, "её значение не изменилось");
})();

// ---------------------------------------------------------------------------
// 5. Инвариант держится на всём дереве, а не только на пути разворота
// ---------------------------------------------------------------------------
//
// Ни одна запись ни одного вхождения не имеет права начинаться в определении,
// которого это вхождение не показывает. Проверка структурная: похожесть
// соседнего определения в ней не участвует.
(function contextInvariantHoldsEverywhere() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    labelA: "9:10", labelAText: "9:11",
    labelB: "9:20", labelBText: "9:21",
    card: "9:30", cardLabel: "9:31",
    occurrence: "9:40", broken: "9:50",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.labelA), type: "SYMBOL", name: "Label", componentKey: "label-a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelAText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelA, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "A" } },
    // Структурный близнец: тот же порядок и типы детей, другой componentKey.
    { guid: guid(ids.labelB), type: "SYMBOL", name: "Label", componentKey: "label-b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelBText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelB, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "B" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 40 } },
    {
      guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label",
      parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 16 },
      symbolData: {
        symbolID: guid(ids.labelA),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.labelAText)] }, textData: { characters: "Design time" } },
        ],
      },
    },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.broken)] }, visible: false },
          { guidPath: { guids: [guid(ids.cardLabel)] }, overriddenSymbolID: guid(ids.labelB) },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root);
  var violations = allEntries(built.ir).filter(function (item) {
    if (item.node.kind !== "INSTANCE") return false;
    var first = item.entry.path.length ? item.entry.path[0] : null;
    return !!(first && first.definitionId && first.definitionId !== item.node.definitionId);
  });
  eq(violations.length, 0,
    "ни одна запись не адресует определение, которого её вхождение не показывает");

  var nested = snapshotNodeBySourceId(built.ir.roots[0].nodes, ids.cardLabel);
  ok(nested, "структурный близнец построен");
  eq(nested.definitionId, ids.labelB, "активное определение — подменённое");
  eq(textOps(nested).length, 0,
    "чужой текст не перенесён на структурно похожего соседа");
})();

// ---------------------------------------------------------------------------
// 6. Несовпадение структурного типа остаётся типизированным промахом
// ---------------------------------------------------------------------------
//
// Запись адресует guid, которого в активном определении нет. Ни один
// «похожий» узел на его месте не выбирается: это промах с названной причиной,
// а не мутация наугад.
(function structuralMismatchStaysMiss() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    card: "9:10", cardFrame: "9:11", cardText: "9:12",
    other: "9:20", otherText: "9:21",
    occurrence: "9:30",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 100, y: 40 } },
    { guid: guid(ids.cardFrame), type: "FRAME", name: "Slot", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 100, y: 20 } },
    { guid: guid(ids.cardText), type: "TEXT", name: "Text", parentIndex: parent(ids.card, "b"), transform: matrix(), size: { x: 100, y: 20 }, textData: { characters: "Card" } },
    { guid: guid(ids.other), type: "SYMBOL", name: "Other", componentKey: "other", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 40 } },
    { guid: guid(ids.otherText), type: "TEXT", name: "Text", parentIndex: parent(ids.other, "a"), transform: matrix(), size: { x: 100, y: 20 }, textData: { characters: "Other" } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          // Цель — TEXT из ЧУЖОГО определения. В дереве Card на её месте
          // стоит FRAME, и подставлять его вместо неё нельзя.
          { guidPath: { guids: [guid(ids.otherText)] }, textData: { characters: "Wrong" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  eq(textOps(occurrence).length, 0, "чужая цель не подменена структурно похожим узлом");
  eq(built.ir.overrideResolution.NESTED_INSTANCE_CONTEXT_MISSING, 1,
    "промах получил причину, а не был применён силой");
  var slot = nodeById(built.ir.definitions.filter(function (definition) {
    return definition.definitionId === ids.card;
  })[0].nodes, ids.cardFrame);
  ok(slot && !slot.text, "FRAME на том же индексе не получил чужой текст");
})();

// ---------------------------------------------------------------------------
// 7. Несколько вхождений одного компонента не делятся правками
// ---------------------------------------------------------------------------
(function noCrossOccurrenceLeak() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    button: "9:10", buttonLabel: "9:11",
    first: "9:20", second: "9:21", third: "9:22",
  };
  function occurrence(id, position, characters) {
    var node = {
      guid: guid(id), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, position), transform: matrix(), size: { x: 80, y: 32 },
      symbolData: { symbolID: guid(ids.button) },
    };
    if (characters !== null) {
      node.symbolData.symbolOverrides = [
        { guidPath: { guids: [guid(ids.buttonLabel)] }, textData: { characters: characters } },
      ];
    }
    return node;
  }
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.button), type: "SYMBOL", name: "Button", componentKey: "button", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 32 } },
    { guid: guid(ids.buttonLabel), type: "TEXT", name: "Label", parentIndex: parent(ids.button, "a"), transform: matrix(), size: { x: 80, y: 16 }, textData: { characters: "Button" } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    occurrence(ids.first, "a", "Save"),
    occurrence(ids.second, "b", "Cancel"),
    occurrence(ids.third, "c", null),
  ];
  var built = buildIr(nodes, ids.root);
  var first = nodeById(built.ir.roots[0].nodes, ids.first);
  var second = nodeById(built.ir.roots[0].nodes, ids.second);
  var third = nodeById(built.ir.roots[0].nodes, ids.third);
  eq(textOps(first)[0].ops.characters, "Save", "первое вхождение получило свой текст");
  eq(textOps(second)[0].ops.characters, "Cancel", "второе вхождение получило свой текст");
  eq(textOps(first).length, 1, "первому вхождению не досталась чужая правка");
  eq(textOps(second).length, 1, "второму вхождению не досталась чужая правка");
  eq((third.overrides || []).length, 0, "вхождение без своей дельты осталось чистым");
  eq(built.ir.definitions.filter(function (definition) {
    return definition.definitionId === ids.button;
  }).length, 1, "определение собрано один раз на три вхождения");
})();

// ---------------------------------------------------------------------------
// N. Потомок ВЛОЖЕННОЙ подмены, посчитанный до неё, не уезжает к приёмнику
// ---------------------------------------------------------------------------
//
// Подмена стоит на вложенном адресе и меняет определение НЕ у самого
// вхождения, а у узла в середине пути. Потомки под этим узлом делятся на
// два разных класса, и различает их только определение на шаге подмены:
// запись, посчитанная в прежнем дереве, ведёт туда, где этого дерева уже
// нет. Приёмник ловит такую запись как `WRONG_NESTED_SWAP_CONTEXT` — но
// отправлять заведомо недействительный адрес всё равно нельзя.
(function preSwapDescendantDroppedBeforeReceiver() {
  var ids = {
    document: "9:1", library: "9:2", page: "9:3", root: "9:4",
    labelA: "9:10", labelAText: "9:11",
    labelB: "9:20", labelBText: "9:21",
    card: "9:30", cardLabel: "9:31",
    occurrence: "9:40",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.labelA), type: "SYMBOL", name: "Label A", componentKey: "label-a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelAText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelA, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "A" } },
    { guid: guid(ids.labelB), type: "SYMBOL", name: "Label B", componentKey: "label-b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelBText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelB, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "B" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 40 } },
    { guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 16 }, symbolData: { symbolID: guid(ids.labelA) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          // Посчитано в дереве Label A — до подмены.
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelAText)] }, textData: { characters: "Pre-swap" } },
          { guidPath: { guids: [guid(ids.cardLabel)] }, overriddenSymbolID: guid(ids.labelB) },
          // Посчитано уже в дереве Label B — после подмены.
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelBText)] }, textData: { characters: "Post-swap" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  eq(occurrence.kind, "INSTANCE", "вхождение осталось нативным инстансом");

  var swap = (occurrence.overrides || []).filter(function (entry) {
    return entry.ops.swapDefinitionId !== undefined;
  })[0];
  ok(swap, "подмена вложенного компонента уехала отдельной операцией");
  eq(swap.ops.swapDefinitionId, ids.labelB, "подмена называет новое определение");
  eq(swap.path.length, 1, "подмена стоит на вложенном адресе, а не на самом вхождении");

  var text = textOps(occurrence);
  eq(text.length, 1, "к приёмнику уехала ровно одна текстовая правка");
  eq(text[0].ops.characters, "Post-swap", "уцелела правка ПОСЛЕ подмены");
  eq(text[0].path[1].definitionId, ids.labelB,
    "её шаг разрешён в новом определении подменённого узла");

  // Ни одной записи с контекстом прежнего определения на шаге подмены.
  var stale = (occurrence.overrides || []).filter(function (entry) {
    if (entry.path.length <= swap.path.length) return false;
    var context = entry.path[swap.path.length].definitionId;
    return context && context !== swap.ops.swapDefinitionId;
  });
  eq(stale.length, 0, "запись прежнего контекста снята ОТПРАВИТЕЛЕМ, а не оставлена приёмнику");
  ok(built.ir.stats.overridesDropped >= 1, "снятая запись посчитана, а не пропала молча");
  ok(Object.keys(built.ir.overrideResolution).length >= 1,
    "у снятия есть типизированная причина, а не молчание");
})();


// ---------------------------------------------------------------------------
// O. Stale guid nested swap разрешается только фактическим derived guidPath
// ---------------------------------------------------------------------------
(function derivedGuidPathRepairsPersistentSwapIdentity() {
  var ids = {
    document: "10:1", library: "10:2", page: "10:3", root: "10:4",
    propSwap: "10:5",
    labelA: "10:10", labelAText: "10:11",
    labelB: "10:20", labelBText: "10:21",
    card: "10:30", cardLabel: "10:31",
    occurrence: "10:40", staleText: "99:999",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.labelA), type: "SYMBOL", name: "A", componentKey: "a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelAText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelA, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "A" } },
    { guid: guid(ids.labelB), type: "SYMBOL", name: "B", componentKey: "b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelBText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelB, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "B" } },
    {
      guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card",
      parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 40 },
      componentPropDef: [{ id: guid(ids.propSwap), name: "Nested", type: "INSTANCE_SWAP" }],
    },
    {
      guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label", parentIndex: parent(ids.card, "a"),
      transform: matrix(), size: { x: 60, y: 16 }, symbolData: { symbolID: guid(ids.labelA) },
      componentPropRef: [{ defID: guid(ids.propSwap), componentPropNodeField: "OVERRIDDEN_SYMBOL_ID" }],
    },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: {
        symbolID: guid(ids.card),
        // Persistent identity указывает на уже отсутствующий child старой
        // версии B. Обычное дерево документа не может доказать его owner.
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardLabel), guid(ids.staleText)] }, textData: { characters: "Derived" } },
        ],
      },
      // Pixso при этом знает фактический effective path occurrence.
      derivedSymbolData: [
        { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelBText)] } },
      ],
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(occurrence, "derived fixture occurrence попало в IR");
  var swap = (occurrence.overrides || []).filter(function (entry) {
    return entry.ops.swapDefinitionId !== undefined;
  })[0];
  ok(swap, "derived path восстановил структурную подмену nested instance");
  eq(swap.ops.swapDefinitionId, ids.labelB, "подмена указывает на owner фактического derived target");
  var text = textOps(occurrence);
  eq(text.length, 1, "stale target не потерял текстовую правку");
  eq(text[0].ops.characters, "Derived", "значение override сохранилось");
  eq(text[0].path[1].sourceId, ids.labelBText, "адрес заменён на фактический guid из derived snapshot");
  ok(built.ir.stats.derivedPathResolved >= 1, "derived разрешение измерено");
  ok(built.ir.stats.derivedImplicitSwaps >= 1, "derived component swap измерен отдельно");
})();

// ---------------------------------------------------------------------------
// P. Два derived child под одним prefix — отказ, а не выбор наугад
// ---------------------------------------------------------------------------
(function derivedGuidPathAmbiguityStaysUnsafe() {
  var ids = {
    document: "11:1", library: "11:2", page: "11:3", root: "11:4",
    propSwap: "11:5",
    labelA: "11:10", labelAText: "11:11",
    labelB: "11:20", labelBText: "11:21", labelBIcon: "11:22",
    card: "11:30", cardLabel: "11:31",
    occurrence: "11:40", staleTarget: "99:998",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.labelA), type: "SYMBOL", name: "A", componentKey: "a", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelAText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelA, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "A" } },
    { guid: guid(ids.labelB), type: "SYMBOL", name: "B", componentKey: "b", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 60, y: 16 } },
    { guid: guid(ids.labelBText), type: "TEXT", name: "Text", parentIndex: parent(ids.labelB, "a"), transform: matrix(), size: { x: 60, y: 16 }, textData: { characters: "B" } },
    { guid: guid(ids.labelBIcon), type: "RECTANGLE", name: "Icon", parentIndex: parent(ids.labelB, "b"), transform: matrix(), size: { x: 16, y: 16 } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 40 }, componentPropDef: [{ id: guid(ids.propSwap), name: "Nested", type: "INSTANCE_SWAP" }] },
    { guid: guid(ids.cardLabel), type: "INSTANCE", name: "Label", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 60, y: 16 }, symbolData: { symbolID: guid(ids.labelA) }, componentPropRef: [{ defID: guid(ids.propSwap), componentPropNodeField: "OVERRIDDEN_SYMBOL_ID" }] },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence", parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 40 },
      symbolData: { symbolID: guid(ids.card), symbolOverrides: [
        { guidPath: { guids: [guid(ids.cardLabel), guid(ids.staleTarget)] }, visible: false },
      ] },
      derivedSymbolData: [
        { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelBText)] } },
        { guidPath: { guids: [guid(ids.cardLabel), guid(ids.labelBIcon)] } },
      ],
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(occurrence, "ambiguous derived occurrence попало в IR");
  eq((occurrence.overrides || []).length, 0, "неоднозначный target не выбран наугад");
  ok(built.ir.stats.derivedPathAmbiguous >= 1, "неоднозначность derived path измерена");
  ok((built.ir.stats.nativeUnsafeByReason.OCCURRENCE_SWAP_NOT_IN_SOURCE || 0) >= 1,
    "неразрешённый swap остаётся visual-unsafe");
})();


// ---------------------------------------------------------------------------
// Q. Stale child GUID внутри ТОГО ЖЕ nested symbol не требует INSTANCE_SWAP
// ---------------------------------------------------------------------------
(function derivedGuidPathRepairsSameSymbolChildIdentity() {
  var ids = {
    document: "12:1", library: "12:2", page: "12:3", root: "12:4",
    field: "12:10", oldLabel: "99:997", liveLabel: "12:11",
    card: "12:20", cardField: "12:21", occurrence: "12:30",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.field), type: "SYMBOL", name: "Field", componentKey: "field", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 120, y: 32 } },
    { guid: guid(ids.liveLabel), type: "TEXT", name: "Label", parentIndex: parent(ids.field, "a"), transform: matrix(), size: { x: 100, y: 16 }, textData: { characters: "Live" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 140, y: 48 } },
    { guid: guid(ids.cardField), type: "INSTANCE", name: "Field", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 120, y: 32 }, symbolData: { symbolID: guid(ids.field) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 140, y: 48 },
      symbolData: {
        symbolID: guid(ids.card),
        // Старый child GUID уже исчез из Field, но сам nested instance не
        // менял component: это обычное обновление внутреннего дерева master.
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardField), guid(ids.oldLabel)] }, textData: { characters: "Updated" } },
        ],
      },
      derivedSymbolData: [
        { guidPath: { guids: [guid(ids.cardField), guid(ids.liveLabel)] } },
      ],
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(occurrence, "same-symbol derived fixture попало в IR");
  var swaps = (occurrence.overrides || []).filter(function (entry) {
    return entry.ops.swapDefinitionId !== undefined;
  });
  eq(swaps.length, 0, "stale child того же symbol не превращён в component swap");
  var text = textOps(occurrence);
  eq(text.length, 1, "same-symbol stale child сохранил текстовый override");
  eq(text[0].ops.characters, "Updated", "значение same-symbol override сохранено");
  eq(text[0].path[1].sourceId, ids.liveLabel,
    "stale child GUID переведён на единственный effective child того же active symbol");
  ok(built.ir.stats.derivedSameSymbolRemaps >= 1,
    "same-symbol derived remap измеряется отдельно от component swap");
})();


// ---------------------------------------------------------------------------
// R. Stale child GUID под ОБЫЧНЫМ контейнером того же definition
// ---------------------------------------------------------------------------
(function derivedGuidPathRepairsSameDefinitionOrdinaryParent() {
  var ids = {
    document: "13:1", library: "13:2", page: "13:3", root: "13:4",
    card: "13:10", wrapper: "13:11", oldLabel: "99:996", liveLabel: "13:12",
    occurrence: "13:20",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 140, y: 48 } },
    { guid: guid(ids.wrapper), type: "FRAME", name: "Wrapper", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 120, y: 32 } },
    { guid: guid(ids.liveLabel), type: "TEXT", name: "Label", parentIndex: parent(ids.wrapper, "a"), transform: matrix(), size: { x: 100, y: 16 }, textData: { characters: "Live" } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 140, y: 48 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.wrapper), guid(ids.oldLabel)] }, textData: { characters: "Updated" } },
        ],
      },
      derivedSymbolData: [
        { guidPath: { guids: [guid(ids.wrapper), guid(ids.liveLabel)] } },
      ],
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(occurrence, "same-definition ordinary-parent fixture попало в IR");
  var text = textOps(occurrence);
  eq(text.length, 1, "stale child под ordinary parent не принят за missing nested context");
  eq(text[0].ops.characters, "Updated", "override под ordinary parent сохранён");
  eq(text[0].path[1].sourceId, ids.liveLabel,
    "stale child под ordinary parent переведён на effective child того же definition");
  eq(built.ir.overrideResolution.NESTED_INSTANCE_CONTEXT_MISSING || 0, 0,
    "same-definition remap не создаёт ложный NESTED_INSTANCE_CONTEXT_MISSING");
})();


// ---------------------------------------------------------------------------
// S. Deep stale target, absent from the whole document, is historical metadata
// ---------------------------------------------------------------------------
(function deepMissingGuidIsStaleAfterLineageChecks() {
  var ids = {
    document: "14:1", library: "14:2", page: "14:3", root: "14:4",
    field: "14:10", label: "14:11",
    card: "14:20", cardField: "14:21", occurrence: "14:30",
    stale: "99:995",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.field), type: "SYMBOL", name: "Field", componentKey: "field", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 120, y: 32 } },
    { guid: guid(ids.label), type: "TEXT", name: "Label", parentIndex: parent(ids.field, "a"), transform: matrix(), size: { x: 100, y: 16 }, textData: { characters: "Live" } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 140, y: 48 } },
    { guid: guid(ids.cardField), type: "INSTANCE", name: "Field", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 120, y: 32 }, symbolData: { symbolID: guid(ids.field) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 140, y: 48 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardField), guid(ids.stale)] }, stackChildCounterSizing: "FIXED" },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  ok(occurrence, "deep-stale fixture occurrence попало в IR");
  eq((occurrence.overrides || []).length, 0, "override без живой цели не переносится наугад");
  eq(built.ir.overrideResolution.STALE_TARGET_GUID_NOT_IN_DOCUMENT || 0, 1,
    "отсутствующий deep target классифицирован как stale metadata");
  eq(built.ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "deep stale target не превращён в visual-loss TARGET_GUID");
  eq(built.ir.stats.nativeUnsafeByReason.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "исторический deep override не делает нативный instance visual-unsafe");
})();


// ---------------------------------------------------------------------------
// T. Missing deep INSTANCE boundaries are reconstructed by unique lineage
// ---------------------------------------------------------------------------
(function omittedNestedBoundariesUseUniqueDefinitionLineage() {
  var ids = {
    document: "15:1", library: "15:2", page: "15:3", root: "15:4",
    leaf: "15:10", leafText: "15:11",
    mid: "15:20", midLeaf: "15:21",
    card: "15:30", wrapper: "15:31", cardMid: "15:32",
    occurrence: "15:40",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.leaf), type: "SYMBOL", name: "Leaf", componentKey: "leaf", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 20 } },
    { guid: guid(ids.leafText), type: "TEXT", name: "Text", parentIndex: parent(ids.leaf, "a"), transform: matrix(), size: { x: 80, y: 20 }, textData: { characters: "Base" } },
    { guid: guid(ids.mid), type: "SYMBOL", name: "Mid", componentKey: "mid", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 30 } },
    { guid: guid(ids.midLeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.mid, "a"), transform: matrix(), size: { x: 80, y: 20 }, symbolData: { symbolID: guid(ids.leaf) } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 140, y: 48 } },
    { guid: guid(ids.wrapper), type: "FRAME", name: "Wrapper", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 120, y: 36 } },
    { guid: guid(ids.cardMid), type: "INSTANCE", name: "Mid", parentIndex: parent(ids.wrapper, "a"), transform: matrix(), size: { x: 100, y: 30 }, symbolData: { symbolID: guid(ids.mid) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 140, y: 48 },
      symbolData: {
        symbolID: guid(ids.card),
        // Library revision lost both semantic INSTANCE guids from the path.
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.wrapper), guid(ids.leafText)] }, textData: { characters: "Deep" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false, debugOverrides: true });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  var text = textOps(occurrence);
  eq(text.length, 1, "override с пропущенными nested boundaries восстановлен");
  eq(text[0].ops.characters, "Deep", "deep text сохранился после lineage reconstruction");
  eq(text[0].path[text[0].path.length - 1].sourceId, ids.leafText,
    "конечная цель осталась точным source guid");
  eq(text[0].diagnostic.lineage.length, 2,
    "IR хранит оба доказанных INSTANCE-hop explicit lineage");
  eq(text[0].diagnostic.lineage[0].slotSourceId, ids.cardMid,
    "первый lineage-hop указывает на фактический nested INSTANCE Card→Mid");
  eq(text[0].diagnostic.lineage[1].slotSourceId, ids.midLeaf,
    "второй lineage-hop указывает на фактический nested INSTANCE Mid→Leaf");
  ok(built.ir.stats.lineageReconstructions >= 1,
    "reconstruction измерена отдельно");
  ok(built.ir.stats.lineageReconstructedHops >= 2,
    "измерено число восстановленных semantic hops");
  eq(built.ir.overrideResolution.NESTED_INSTANCE_CONTEXT_MISSING || 0, 0,
    "unique lineage не оставляет ложный missing-context miss");
})();

// ---------------------------------------------------------------------------
// U. Two semantic routes are ambiguity and are never guessed
// ---------------------------------------------------------------------------
(function ambiguousDefinitionLineageFailsClosed() {
  var ids = {
    document: "16:1", library: "16:2", page: "16:3", root: "16:4",
    leaf: "16:10", leafText: "16:11",
    mid: "16:20", midLeaf: "16:21",
    card: "16:30", left: "16:31", right: "16:32", occurrence: "16:40",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.leaf), type: "SYMBOL", name: "Leaf", componentKey: "leaf", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 20 } },
    { guid: guid(ids.leafText), type: "TEXT", name: "Text", parentIndex: parent(ids.leaf, "a"), transform: matrix(), size: { x: 80, y: 20 }, textData: { characters: "Base" } },
    { guid: guid(ids.mid), type: "SYMBOL", name: "Mid", componentKey: "mid", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 30 } },
    { guid: guid(ids.midLeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.mid, "a"), transform: matrix(), size: { x: 80, y: 20 }, symbolData: { symbolID: guid(ids.leaf) } },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 240, y: 48 } },
    { guid: guid(ids.left), type: "INSTANCE", name: "Left", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 100, y: 30 }, symbolData: { symbolID: guid(ids.mid) } },
    { guid: guid(ids.right), type: "INSTANCE", name: "Right", parentIndex: parent(ids.card, "b"), transform: matrix(), size: { x: 100, y: 30 }, symbolData: { symbolID: guid(ids.mid) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 260, y: 100 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 240, y: 48 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.leafText)] }, textData: { characters: "Must not guess" } },
        ],
      },
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  eq(textOps(occurrence).length, 0, "ambiguous lineage не выбирает один из двух одинаковых slots");
  ok(built.ir.stats.lineageReconstructionAmbiguous > 0,
    "неоднозначная component-lineage измерена отдельным счётчиком");
  eq(built.ir.overrideResolution.NESTED_INSTANCE_CONTEXT_MISSING || 0, 1,
    "ambiguous lineage остаётся честным unresolved context");
})();


// ---------------------------------------------------------------------------
// V. Ambiguous derived hop emits bounded source provenance in normal mode
// ---------------------------------------------------------------------------
(function ambiguousDerivedHopCarriesSourceProvenance() {
  var ids = {
    document: "17:1", library: "17:2", page: "17:3", root: "17:4",
    leaf: "17:10", childA: "17:11", childB: "17:12",
    card: "17:20", cardLeaf: "17:21", occurrence: "17:30", stale: "99:999",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.leaf), type: "SYMBOL", name: "Leaf", componentKey: "leaf", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 20 } },
    { guid: guid(ids.childA), type: "FRAME", name: "A", parentIndex: parent(ids.leaf, "a"), transform: matrix(), size: { x: 20, y: 20 } },
    // B is stretched: an override FIXED would change it, so choosing between A
    // and B matters and the miss cannot be proven a no-op.
    { guid: guid(ids.childB), type: "FRAME", name: "B", parentIndex: parent(ids.leaf, "b"), transform: matrix(), size: { x: 20, y: 20 }, stackChildCounterSizing: "RESIZE_TO_FIT" },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 30 } },
    { guid: guid(ids.cardLeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 80, y: 20 }, symbolData: { symbolID: guid(ids.leaf) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 120, y: 50 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 30 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.stale)] }, stackChildCounterSizing: "FIXED" },
        ],
      },
      derivedSymbolData: [
        { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.childA)] } },
        { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.childB)] } },
      ],
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  eq(built.ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 1,
    "ambiguous derived target remains unresolved rather than guessed");
  ok((built.ir.deepOverrideProvenanceSamples || []).length >= 1,
    "normal build carries a bounded source-provenance sample without debugOverrides");
  var sample = built.ir.deepOverrideProvenanceSamples[0];
  eq(sample.sourceProvenance.derivedCandidateCount, 2,
    "provenance records all candidates at the failing derived hop");
  eq(sample.sourceProvenance.targetExistsInDocument, false,
    "provenance distinguishes a stale source guid from a live foreign guid");
  eq(sample.sourceProvenance.previousSourceId, ids.cardLeaf,
    "provenance records the exact nested INSTANCE before the failed hop");
})();


// ---------------------------------------------------------------------------
// W. Proven derived definition + ambiguous endpoints can verify an exact no-op
// ---------------------------------------------------------------------------
(function derivedDefinitionNamespaceCanProveAmbiguousNoOp() {
  var ids = {
    document: "18:1", library: "18:2", page: "18:3", root: "18:4",
    oldLeaf: "18:10", oldChild: "18:11",
    newLeaf: "18:20", newA: "18:21", newB: "18:22",
    card: "18:30", cardLeaf: "18:31", occurrence: "18:40", stale: "99:1001",
  };
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
    { guid: guid(ids.oldLeaf), type: "SYMBOL", name: "Old", componentKey: "old-family", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 20 } },
    { guid: guid(ids.oldChild), type: "FRAME", name: "Old child", parentIndex: parent(ids.oldLeaf, "a"), transform: matrix(), size: { x: 20, y: 20 }, stackChildCounterSizing: "FIXED" },
    { guid: guid(ids.newLeaf), type: "SYMBOL", name: "New", componentKey: "new-family", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 80, y: 20 } },
    { guid: guid(ids.newA), type: "FRAME", name: "A", parentIndex: parent(ids.newLeaf, "a"), transform: matrix(), size: { x: 20, y: 20 }, stackChildCounterSizing: "FIXED" },
    { guid: guid(ids.newB), type: "FRAME", name: "B", parentIndex: parent(ids.newLeaf, "b"), transform: matrix(), size: { x: 20, y: 20 }, stackChildCounterSizing: "FIXED" },
    { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 30 } },
    { guid: guid(ids.cardLeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 80, y: 20 }, symbolData: { symbolID: guid(ids.oldLeaf) } },
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 120, y: 50 } },
    {
      guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 30 },
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [
          { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.stale)] }, stackChildCounterSizing: "FIXED" },
        ],
      },
      // The declared nested symbol is oldLeaf, but every live provenance
      // candidate at this hop is owned by one different definition, newLeaf.
      derivedSymbolData: [
        { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.newA)] } },
        { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.newB)] } },
      ],
    },
  ];
  var built = buildIr(nodes, ids.root, { visualSafety: false });
  var occurrence = nodeById(built.ir.roots[0].nodes, ids.occurrence);
  eq((occurrence.overrides || []).length, 0,
    "ambiguous historical target is not applied to an arbitrary derived child");
  ok(built.ir.stats.derivedDefinitionNamespaceTransitions > 0,
    "all derived candidates in one foreign definition prove a namespace transition");
  ok(built.ir.stats.derivedDefinitionNamespaceAmbiguousNoOps > 0,
    "exact value on every possible endpoint proves the ambiguous override is already a no-op");
  eq(built.ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "verified derived-namespace no-op does not remain a visual-loss TARGET_GUID miss");
  eq(built.ir.stats.nativeUnsafeByReason.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "verified no-op does not make the native instance unsafe");
})();

// ---------------------------------------------------------------------------
// X. Stale child guid inside the SAME definition: the no-op proof compares
//    child-layout fields after Figma translation and respects own overrides
// ---------------------------------------------------------------------------
(function sameDefinitionAmbiguousChildLayoutNoOp() {
  function build(childOverride, extraOccurrenceOverrides) {
    var ids = {
      document: "19:1", library: "19:2", page: "19:3", root: "19:4",
      leaf: "19:10", childA: "19:11", childB: "19:12", childC: "19:13",
      card: "19:20", cardLeaf: "19:21", occurrence: "19:30", stale: "99:2001",
    };
    var nodes = [
      { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
      { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a") },
      { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
      { guid: guid(ids.leaf), type: "SYMBOL", name: "Leaf", componentKey: "leaf", parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 80, y: 20 }, stackMode: "HORIZONTAL" },
      // Field not written: Figma state is the same as FIXED (layoutAlign INHERIT).
      { guid: guid(ids.childA), type: "FRAME", name: "A", parentIndex: parent(ids.leaf, "a"), transform: matrix(), size: { x: 20, y: 20 } },
      { guid: guid(ids.childB), type: "FRAME", name: "B", parentIndex: parent(ids.leaf, "b"), transform: matrix(), size: { x: 20, y: 20 }, stackChildCounterSizing: "FIXED" },
      // Absolute child: grow/align are never assigned, Figma keeps defaults.
      { guid: guid(ids.childC), type: "VECTOR", name: "C", parentIndex: parent(ids.leaf, "c"), transform: matrix(), size: { x: 20, y: 20 }, autoLayoutAbsolutePos: true },
      { guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: "card", parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 100, y: 30 } },
      { guid: guid(ids.cardLeaf), type: "INSTANCE", name: "Leaf", parentIndex: parent(ids.card, "a"), transform: matrix(), size: { x: 80, y: 20 }, symbolData: { symbolID: guid(ids.leaf) } },
      { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 120, y: 50 } },
      {
        guid: guid(ids.occurrence), type: "INSTANCE", name: "Occurrence",
        parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 30 },
        symbolData: {
          symbolID: guid(ids.card),
          symbolOverrides: [
            { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.stale)] }, stackChildCounterSizing: childOverride },
          ].concat((extraOccurrenceOverrides || []).map(function (entry) {
            return Object.assign({ guidPath: { guids: [guid(ids.cardLeaf), guid(ids[entry.target])] } }, entry.fields);
          })),
        },
        // Every live candidate is owned by the declared nested symbol itself.
        derivedSymbolData: [
          { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.childA)] } },
          { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.childB)] } },
          { guidPath: { guids: [guid(ids.cardLeaf), guid(ids.childC)] } },
        ],
      },
    ];
    return buildIr(nodes, ids.root, { visualSafety: false }).ir;
  }

  var proven = build("FIXED");
  eq(proven.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "FIXED on every same-definition candidate (absent, FIXED, absolute) is a verified no-op");
  ok(proven.stats.derivedDefinitionNamespaceAmbiguousNoOps > 0,
    "same-definition ambiguity is counted as a verified no-op");
  eq(proven.stats.derivedDefinitionNamespaceTransitions, 0,
    "the current definition is not reported as a namespace transition");
  eq(proven.stats.nativeUnsafeByReason.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "verified same-definition no-op keeps the occurrence native");

  var stretching = build("RESIZE_TO_FIT");
  eq(stretching.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 1,
    "an override that would stretch a candidate is not a no-op and stays unresolved");

  var sameOwn = build("FIXED", [{ target: "childA", fields: { stackChildCounterSizing: "FIXED" } }]);
  eq(sameOwn.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 0,
    "an own override of the same value keeps the live value equal to the proof");

  var conflictingOwn = build("FIXED", [{ target: "childA", fields: { stackChildCounterSizing: "RESIZE_TO_FIT" } }]);
  eq(conflictingOwn.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION || 0, 1,
    "an own override with a different value makes the master comparison unsound");
})();

process.stdout.write("OK: Direct PIX override context — " + checks + " проверок пройдено\n");
