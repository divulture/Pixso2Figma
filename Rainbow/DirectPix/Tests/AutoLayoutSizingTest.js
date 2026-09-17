/**
 * Direct PIX: семантика sizing внутри auto layout.
 *
 *   node DirectPix/Tests/AutoLayoutSizingTest.js
 *
 * Проверяется цепочка целиком — `.pix` → MigrationIR → узел Figma, построенный
 * НАСТОЯЩИМ кодом приёмника на headless-двойнике, — и проверяется дважды: и
 * режим, и итоговая геометрия. Совпадения одной геометрии недостаточно:
 * ребёнок, приехавший нужной ширины с `layoutGrow = 0` вместо `1`, выглядит
 * правильным ровно до первой правки контейнера.
 *
 * Соответствие источника и Figma, которое здесь закреплено (измерено на трёх
 * настоящих документах, см. DirectPix/README.md):
 *
 *   container stackPrimarySizing=RESIZE_TO_FIT → primaryAxisSizingMode=AUTO
 *   container stackPrimarySizing=FIXED         → primaryAxisSizingMode=FIXED
 *   child     stackChildPrimarySizing=RESIZE_TO_FIT → layoutGrow=1   (FILL)
 *   child     stackChildPrimarySizing=FIXED         → layoutGrow=0   + размер
 *   child     stackChildCounterSizing=RESIZE_TO_FIT → layoutAlign=STRETCH
 *   child     stackChildCounterSizing=FIXED         → layoutAlign=INHERIT + размер
 *   child     autoLayoutAbsolutePos=true            → layoutPositioning=ABSOLUTE
 *
 * Оси считаются от направления раскладки родителя, а не от имён полей,
 * поэтому одна и та же фикстура собрана дважды — HORIZONTAL и VERTICAL. Тест,
 * который проверяет только одну ориентацию, перепутанные оси не ловит.
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
var PixNormalizer = require("../PixNormalizer");
var Trace = require("../Trace");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.01,
    message + " (получено: " + actual + ", ожидалось: " + expected + ")");
  checks += 1;
}
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function solid() { return { type: "SOLID", color: { r: 10, g: 10, b: 10, a: 255 }, visible: true, blendMode: "NORMAL" }; }

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

/**
 * Одна и та же сцена в двух ориентациях.
 *
 * `main` и `cross` — это ШИРИНА и ВЫСОТА в горизонтальном контейнере и
 * ВЫСОТА и ШИРИНА в вертикальном. Размеры здесь задаются в осях раскладки, а
 * в `size` укладываются уже по ориентации: иначе тест повторял бы ту самую
 * ошибку, которую должен ловить.
 */
function scene(prefix, mode) {
  var horizontal = mode === "HORIZONTAL";
  function size(main, cross) { return horizontal ? { x: main, y: cross } : { x: cross, y: main }; }
  var id = function (name) { return prefix + ":" + name; };

  var ids = {
    document: id("1"), library: id("2"), page: id("3"),
    root: id("10"),
    fixedBox: id("11"), fillBox: id("12"), stretchBox: id("13"),
    hugBox: id("14"), hugLeaf: id("15"),
    absoluteBox: id("16"),
    text: id("17"),
    hiddenOnly: id("18"), hiddenLeaf: id("19"),
    bounded: id("20"), boundedLeaf: id("21"),
    plainFrame: id("22"), plainChild: id("23"),
    symbol: id("30"), symbolLeaf: id("31"), instance: id("32"),
    hugSymbol: id("40"), hugSymbolLeaf: id("41"), pinned: id("42"),
    occurrenceSized: id("43"), occurrenceHugs: id("44"),
    undeclared: id("50"),
  };

  // Контейнер: главная ось фиксирована (900), контр-ось фиксирована (100).
  // Поток: fixed(120) + fill + stretch(80) + hug + absolute(вне потока).
  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

    {
      guid: guid(ids.symbol), type: "SYMBOL", name: "Chip", componentKey: prefix + "-chip",
      parentIndex: parent(ids.library, "a"), transform: matrix(), size: size(60, 24),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.symbolLeaf), type: "RECTANGLE", name: "Chip body",
      parentIndex: parent(ids.symbol, "a"), transform: matrix(), size: size(60, 24),
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Мастер, обнимающий содержимое по главной оси. Вхождение ниже отменяет
    // этот HUG собственной записью — ровно так, как это делает реальный
    // документ, и ровно там, где раскладка успевает сбить размер раньше,
    // чем правка вхождения доедет.
    {
      guid: guid(ids.hugSymbol), type: "SYMBOL", name: "Pill", componentKey: prefix + "-pill",
      parentIndex: parent(ids.library, "b"), transform: matrix(), size: size(60, 24),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.hugSymbolLeaf), type: "RECTANGLE", name: "Pill body",
      parentIndex: parent(ids.hugSymbol, "a"), transform: matrix(), size: size(60, 24),
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    {
      guid: guid(ids.root), type: "FRAME", name: "Row", parentIndex: parent(ids.page, "a"),
      transform: matrix(), size: size(900, 100),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.fixedBox), type: "FRAME", name: "Fixed", parentIndex: parent(ids.root, "a"),
      transform: matrix(), size: size(120, 40), fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.fillBox), type: "FRAME", name: "Fill", parentIndex: parent(ids.root, "b"),
      transform: matrix(), size: size(200, 40), fillPaints: [solid()],
      stackChildPrimarySizing: "RESIZE_TO_FIT", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.stretchBox), type: "FRAME", name: "Stretch", parentIndex: parent(ids.root, "c"),
      transform: matrix(), size: size(80, 40), fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
    },
    // Вложенный auto layout, обнимающий содержимое по главной оси.
    {
      guid: guid(ids.hugBox), type: "FRAME", name: "Hug", parentIndex: parent(ids.root, "d"),
      transform: matrix(), size: size(50, 40), fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.hugLeaf), type: "RECTANGLE", name: "Hug leaf", parentIndex: parent(ids.hugBox, "a"),
      transform: matrix(), size: size(50, 30), fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // Абсолютный ребёнок: из потока выключен целиком.
    {
      guid: guid(ids.absoluteBox), type: "RECTANGLE", name: "Badge", parentIndex: parent(ids.root, "e"),
      transform: matrix(800, 4), size: size(64, 16), fillPaints: [solid()],
      autoLayoutAbsolutePos: true,
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.text), type: "TEXT", name: "Caption", parentIndex: parent(ids.root, "f"),
      transform: matrix(), size: size(70, 20),
      textData: { characters: "Caption" }, fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.instance), type: "INSTANCE", name: "Chip use", parentIndex: parent(ids.root, "g"),
      transform: matrix(), size: size(60, 24),
      symbolData: { symbolID: guid(ids.symbol) },
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // Контейнер, обнимающий содержимое, у которого в потоке никого нет.
    {
      guid: guid(ids.hiddenOnly), type: "FRAME", name: "Empty hug", parentIndex: parent(ids.root, "h"),
      transform: matrix(), size: size(44, 44), fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "RESIZE_TO_FIT",
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.hiddenLeaf), type: "RECTANGLE", name: "Hidden", parentIndex: parent(ids.hiddenOnly, "a"),
      transform: matrix(), size: size(44, 44), visible: false, fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // HUG с объявленным минимумом: содержимого меньше, чем размер узла.
    {
      guid: guid(ids.bounded), type: "FRAME", name: "Bounded hug", parentIndex: parent(ids.root, "i"),
      transform: matrix(), size: { x: 90, y: 36 }, fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "RESIZE_TO_FIT",
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
      minSize: { x: 90, y: 36 }, maxSize: { x: 3.4028234663852886e38, y: 3.4028234663852886e38 },
    },
    {
      guid: guid(ids.boundedLeaf), type: "RECTANGLE", name: "Bounded leaf",
      parentIndex: parent(ids.bounded, "a"), transform: matrix(), size: { x: 20, y: 10 },
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // Контейнер, объявивший направление раскладки и НИ ОДНОЙ оси sizing.
    // На трёх настоящих документах этот класс — ровно контейнеры без детей
    // (2971/2971, 842/842, 8006/8006): обнимать там нечего, и размер обязан
    // остаться тем, который записан.
    {
      guid: guid(ids.undeclared), type: "FRAME", name: "Undeclared", parentIndex: parent(ids.root, "k"),
      transform: matrix(), size: size(30, 30), fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Вхождение, у которого СВОЯ главная ось фиксирована, хотя у мастера она
    // обнимает содержимое. Запись адресует сам инстанс: пустой `guidPath`.
    {
      guid: guid(ids.pinned), type: "INSTANCE", name: "Pinned pill", parentIndex: parent(ids.root, "j"),
      transform: matrix(), size: size(140, 24),
      // STRETCH по контр-оси рядом с фиксированной главной: пока оси
      // считаются от направления родителя, восстановление трогает только
      // главную. Перепутанные оси оставят её на HUG-размере мастера.
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
      symbolData: {
        symbolID: guid(ids.hugSymbol),
        symbolOverrides: [{ guidPath: { guids: [] }, stackPrimarySizing: "FIXED" }],
      },
    },

    // Вхождение того же обнимающего мастера, которое НИЧЕГО о своей раскладке
    // не говорит, но записано размером, которого HUG мастера дать не может.
    // Это и есть отдельная семантика: `stackPrimarySizing` у записи нет,
    // наследованный от мастера AUTO — утверждение об ОПРЕДЕЛЕНИИ, а
    // собственная коробка вхождения принадлежит вхождению. На реальном
    // документе такие вхождения есть и без единой правки содержимого
    // (вхождение шириной 20 при мастере 60).
    {
      guid: guid(ids.occurrenceSized), type: "INSTANCE", name: "Sized pill",
      parentIndex: parent(ids.root, "l"), transform: matrix(), size: size(140, 24),
      symbolData: { symbolID: guid(ids.hugSymbol) },
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // Вхождение того же мастера, чья записанная коробка РАВНА его HUG.
    // Обнимать ему ничто не мешает, и ось обязана остаться AUTO: иначе
    // «вернуть источнику его размер» превратилось бы в «заморозить всё».
    {
      guid: guid(ids.occurrenceHugs), type: "INSTANCE", name: "Hugging pill",
      parentIndex: parent(ids.root, "m"), transform: matrix(), size: size(60, 24),
      minSize: size(60, 24),
      symbolData: { symbolID: guid(ids.hugSymbol) },
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Обычный узел вне auto layout: его размеры трогать нельзя.
    {
      guid: guid(ids.plainFrame), type: "FRAME", name: "Plain", parentIndex: parent(ids.page, "b"),
      transform: matrix(0, 400), size: { x: 300, y: 150 }, fillPaints: [solid()],
    },
    {
      guid: guid(ids.plainChild), type: "RECTANGLE", name: "Plain child",
      parentIndex: parent(ids.plainFrame, "a"), transform: matrix(10, 10), size: { x: 111, y: 77 },
      fillPaints: [solid()],
    },
  ];
  return { ids: ids, nodes: nodes, mode: mode, horizontal: horizontal, size: size };
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

function specById(list, id) {
  return list.filter(function (node) { return node.id === id; })[0] || null;
}

/**
 * Поведение узла внутри родителя, каким его объявил IR.
 *
 * Пустой объект вместо `undefined` — сознательно: «поля нет» и «поле равно
 * умолчанию Figma» здесь обязаны различаться сообщением о конкретной оси, а
 * не падением на чтении отсутствующего свойства.
 */
function childLayoutOf(list, id) {
  var spec = specById(list, id);
  return (spec && spec.childLayout) || {};
}

function sizeBoundsOf(list, id) {
  var spec = specById(list, id);
  return (spec && spec.sizeBounds) || {};
}

async function run(built) {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-autolayout-"));
  try {
    var file = path.join(temp, "layout.pix");
    fs.writeFileSync(file, Fixture.buildContainer({
      build: { nodes: built.nodes, blobs: [], resources: [] },
    }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var rootRecord = doc.tree.byKey.get(built.ids.root);
    var plainRecord = doc.tree.byKey.get(built.ids.plainFrame);
    var ir = MigrationIR.build(doc, { roots: [rootRecord, plainRecord], visualSafety: false });
    var run = await Trace.runReceiver(doc, [
      { rootId: built.ids.root, ir: ir },
    ]);
    // Узлы, построенные приёмником, адресуются тем же порядком, которым
    // дерево и собиралось: родитель раньше ребёнка, дети подряд.
    var rootSpecs = ir.roots[0].nodes;
    var rootNode = null;
    run.host.pages().forEach(function (page) {
      (page.children || []).forEach(function (node) {
        if (node.getPluginData("pixsoDirectSourceId") === built.ids.root) rootNode = node;
      });
    });
    ok(rootNode, built.mode + ": корень построен");
    var byId = Object.create(null);
    var counts = Object.create(null);
    rootSpecs.forEach(function (spec) {
      if (!spec.parent) { byId[spec.id] = rootNode; return; }
      var host = byId[spec.parent];
      var index = counts[spec.parent] || 0;
      counts[spec.parent] = index + 1;
      if (host && host.children) byId[spec.id] = host.children[index];
    });
    // Определения живут на служебной странице и опознаются plugin data, а не
    // именем: у пользователя может быть своя страница с тем же названием.
    var definitions = [];
    run.host.pages().forEach(function (page) {
      (page.children || []).forEach(function (node) {
        if (node.getPluginData("pixsoDirectDefinitionId")) definitions.push(node);
      });
    });
    return {
      ids: built.ids, ir: ir, specs: rootSpecs, byId: byId,
      definitions: definitions, host: run.host, finish: run.finish,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Габарит узла в осях РАСКЛАДКИ, а не в ширине/высоте. */
function axes(node, horizontal) {
  return { main: horizontal ? node.width : node.height, cross: horizontal ? node.height : node.width };
}

async function check(mode) {
  var built = scene(mode === "HORIZONTAL" ? "7" : "8", mode);
  var out = await run(built);
  var ids = built.ids;
  var horizontal = built.horizontal;
  var tag = mode + ": ";

  // --- источник → IR -------------------------------------------------------
  var rootSpec = specById(out.specs, ids.root);
  eq(rootSpec.autoLayout.layoutMode, mode, tag + "направление раскладки перенесено");
  eq(rootSpec.autoLayout.primaryAxisSizingMode, "FIXED", tag + "FIXED главной оси контейнера");
  eq(rootSpec.autoLayout.counterAxisSizingMode, "FIXED", tag + "FIXED контр-оси контейнера");

  var hugSpec = specById(out.specs, ids.hugBox);
  eq(hugSpec.autoLayout.primaryAxisSizingMode, "AUTO",
    tag + "RESIZE_TO_FIT главной оси — это HUG");
  eq(hugSpec.autoLayout.counterAxisSizingMode, "FIXED", tag + "FIXED контр-оси вложенного контейнера");

  eq(childLayoutOf(out.specs, ids.fixedBox).layoutGrow, 0,
    tag + "FIXED главной оси ребёнка объявлен явно");
  eq(childLayoutOf(out.specs, ids.fixedBox).layoutAlign, "INHERIT",
    tag + "FIXED контр-оси ребёнка объявлен явно");
  eq(childLayoutOf(out.specs, ids.fillBox).layoutGrow, 1,
    tag + "RESIZE_TO_FIT главной оси ребёнка — это FILL");
  eq(childLayoutOf(out.specs, ids.stretchBox).layoutAlign, "STRETCH",
    tag + "RESIZE_TO_FIT контр-оси ребёнка — это STRETCH");
  eq(childLayoutOf(out.specs, ids.stretchBox).layoutGrow, 0,
    tag + "STRETCH по контр-оси не превращается в FILL по главной");
  eq(childLayoutOf(out.specs, ids.absoluteBox).layoutPositioning, "ABSOLUTE",
    tag + "autoLayoutAbsolutePos — это ABSOLUTE");
  ok(childLayoutOf(out.specs, ids.absoluteBox).layoutGrow === undefined,
    tag + "абсолютный ребёнок не получает grow");
  eq(sizeBoundsOf(out.specs, ids.bounded).minWidth, 90, tag + "минимальная ширина перенесена");
  eq(sizeBoundsOf(out.specs, ids.bounded).minHeight, 36, tag + "минимальная высота перенесена");
  ok(sizeBoundsOf(out.specs, ids.bounded).maxWidth === undefined,
    tag + "максимум по умолчанию — это отсутствие границы, а не граница");

  // --- IR → Figma ----------------------------------------------------------
  var root = out.byId[ids.root];
  eq(root.layoutMode, mode, tag + "layoutMode выставлен");
  eq(root.primaryAxisSizingMode, "FIXED", tag + "главная ось контейнера фиксирована");
  eq(root.counterAxisSizingMode, "FIXED", tag + "контр-ось контейнера фиксирована");
  near(axes(root, horizontal).main, 900, tag + "контейнер сохранил главную ось");
  near(axes(root, horizontal).cross, 100, tag + "контейнер сохранил контр-ось");

  var fixed = out.byId[ids.fixedBox];
  eq(fixed.layoutGrow, 0, tag + "FIXED ребёнок не растёт");
  eq(fixed.layoutAlign, "INHERIT", tag + "FIXED ребёнок не растягивается");
  near(axes(fixed, horizontal).main, 120, tag + "FIXED ребёнок сохранил главную ось");
  near(axes(fixed, horizontal).cross, 40, tag + "FIXED ребёнок сохранил контр-ось");

  var fill = out.byId[ids.fillBox];
  eq(fill.layoutGrow, 1, tag + "FILL ребёнок объявлен растущим");
  eq(fill.layoutAlign, "INHERIT", tag + "FILL по главной оси не трогает контр-ось");
  // Остаток главной оси контейнера после всех НЕрастущих соседей.
  var siblings = [ids.fixedBox, ids.stretchBox, ids.hugBox, ids.text, ids.instance, ids.hiddenOnly,
    ids.bounded, ids.pinned, ids.occurrenceSized, ids.occurrenceHugs, ids.undeclared]
    .reduce(function (sum, id) { return sum + axes(out.byId[id], horizontal).main; }, 0);
  ok(900 - siblings > 0, tag + "в фикстуре есть остаток, который может занять FILL");
  near(axes(fill, horizontal).main, 900 - siblings, tag + "FILL ребёнок занял остаток главной оси");
  near(axes(fill, horizontal).cross, 40, tag + "FILL по главной оси сохранил контр-ось");

  var stretch = out.byId[ids.stretchBox];
  eq(stretch.layoutAlign, "STRETCH", tag + "STRETCH ребёнок объявлен растянутым");
  eq(stretch.layoutGrow, 0, tag + "STRETCH ребёнок не растёт по главной оси");
  near(axes(stretch, horizontal).main, 80, tag + "STRETCH ребёнок сохранил главную ось");
  near(axes(stretch, horizontal).cross, 100, tag + "STRETCH ребёнок занял контр-ось контейнера");

  var hug = out.byId[ids.hugBox];
  eq(hug.primaryAxisSizingMode, "AUTO", tag + "вложенный контейнер остался HUG");
  eq(hug.counterAxisSizingMode, "FIXED", tag + "вложенный контейнер сохранил FIXED контр-ось");
  near(axes(hug, horizontal).main, 50, tag + "HUG контейнер посчитан по содержимому");
  near(axes(hug, horizontal).cross, 40, tag + "HUG контейнер сохранил фиксированную контр-ось");

  var absolute = out.byId[ids.absoluteBox];
  eq(absolute.layoutPositioning, "ABSOLUTE", tag + "абсолютный ребёнок выключен из потока");
  near(absolute.x, 800, tag + "абсолютный ребёнок сохранил x");
  near(absolute.y, 4, tag + "абсолютный ребёнок сохранил y");
  near(axes(absolute, horizontal).main, 64, tag + "абсолютный ребёнок сохранил главную ось");
  near(axes(absolute, horizontal).cross, 16, tag + "абсолютный ребёнок сохранил контр-ось");

  var text = out.byId[ids.text];
  near(axes(text, horizontal).main, 70, tag + "текстовый ребёнок сохранил главную ось");
  near(axes(text, horizontal).cross, 20, tag + "текстовый ребёнок сохранил контр-ось");

  var instance = out.byId[ids.instance];
  eq(instance.type, "INSTANCE", tag + "вхождение осталось нативным инстансом");
  near(axes(instance, horizontal).main, 60, tag + "инстанс сохранил главную ось");
  near(axes(instance, horizontal).cross, 24, tag + "инстанс сохранил контр-ось");

  // Контейнер, у которого в потоке никого нет (единственный ребёнок скрыт).
  // Измерено в живой Figma (FIGMA_CAPABILITIES.md, hug-over-hidden-only):
  // HUG держит прежний размер, как и в Pixso, — фоллбек в FIXED не нужен.
  var empty = out.byId[ids.hiddenOnly];
  eq(empty.primaryAxisSizingMode, "AUTO", tag + "HUG без видимого содержимого остался HUG");
  eq(empty.counterAxisSizingMode, "AUTO", tag + "HUG без видимого содержимого остался HUG по обеим осям");
  near(axes(empty, horizontal).main, 44, tag + "HUG без видимого содержимого сохранил главную ось");
  near(axes(empty, horizontal).cross, 44, tag + "HUG без видимого содержимого сохранил контр-ось");

  // Вхождение, отменившее HUG мастера: правка приезжает ПОСЛЕ раскладки, и
  // без осевого восстановления размер остаётся тем, который посчитал HUG.
  var pinned = out.byId[ids.pinned];
  eq(pinned.type, "INSTANCE", tag + "вхождение с собственной осью осталось инстансом");
  eq(pinned.primaryAxisSizingMode, "FIXED", tag + "вхождение отменило HUG мастера");
  near(axes(pinned, horizontal).main, 140,
    tag + "вхождение вернуло свою главную ось после отмены HUG");
  eq(pinned.layoutAlign, "STRETCH", tag + "вхождение растянуто по контр-оси");
  near(axes(pinned, horizontal).cross, 100,
    tag + "контр-ось вхождения принадлежит родителю, а не источнику");

  // Вхождение, чья записанная коробка НЕ СОШЛАСЬ с обниманием мастера.
  //
  // Разница в пикселях не доказывает смену владельца оси: закрепление HUG по
  // коробке источника (`directReconcileHugToSourceBox`) отключено, ось
  // остаётся обнимающей. Представление таких расхождений выбирает модуль
  // решений (`Expressibility.js`).
  var occurrenceSized = out.byId[ids.occurrenceSized];
  eq(occurrenceSized.type, "INSTANCE", tag + "вхождение со своей коробкой осталось инстансом");
  eq(occurrenceSized.primaryAxisSizingMode, "AUTO",
    tag + "разница коробки с обниманием мастера не сделала ось FIXED");
  near(axes(occurrenceSized, horizontal).cross, 24, tag + "вхождение сохранило контр-ось");
  ok(!(out.finish.unsupportedByCode.HUG_BOX_PINNED_TO_SOURCE >= 1),
    tag + "закрепления HUG по коробке источника не было");

  // Обратная сторона того же правила: вхождение, совпадающее со своим HUG,
  // остаётся обнимающим. Иначе восстановление размера было бы заморозкой.
  var occurrenceHugs = out.byId[ids.occurrenceHugs];
  eq(occurrenceHugs.primaryAxisSizingMode, "AUTO",
    tag + "вхождение, совпавшее с HUG мастера, осталось обнимающим");
  near(axes(occurrenceHugs, horizontal).main, 60,
    tag + "обнимающее вхождение посчитано по содержимому");
  eq(horizontal ? occurrenceHugs.minWidth : occurrenceHugs.minHeight, 60,
    tag + "min bound occurrence по главной оси перенесён на сам INSTANCE");
  eq(horizontal ? occurrenceHugs.minHeight : occurrenceHugs.minWidth, 24,
    tag + "min bound occurrence по контр-оси перенесён на сам INSTANCE");

  // Контейнер без объявленных осей: IR обязан назвать их явно, иначе Figma
  // оставит своё умолчание AUTO и присвоенный размер не удержится.
  eq(specById(out.specs, ids.undeclared).autoLayout.primaryAxisSizingMode, "FIXED",
    tag + "необъявленная главная ось названа явно");
  eq(specById(out.specs, ids.undeclared).autoLayout.counterAxisSizingMode, "FIXED",
    tag + "необъявленная контр-ось названа явно");
  var undeclared = out.byId[ids.undeclared];
  eq(undeclared.primaryAxisSizingMode, "FIXED", tag + "необъявленная ось построена фиксированной");
  near(axes(undeclared, horizontal).main, 30, tag + "контейнер без объявленных осей сохранил размер");
  near(axes(undeclared, horizontal).cross, 30, tag + "контейнер без объявленных осей сохранил контр-ось");

  var bounded = out.byId[ids.bounded];
  eq(bounded.minWidth, 90, tag + "минимальная ширина доехала до узла");
  eq(bounded.minHeight, 36, tag + "минимальная высота доехала до узла");
  near(bounded.width, 90, tag + "HUG не опустился ниже минимальной ширины");
  near(bounded.height, 36, tag + "HUG не опустился ниже минимальной высоты");

  return out;
}

/**
 * Обычные узлы без auto layout. Их размеры не имеет права трогать ничто из
 * добавленного: ни восстановление, ни границы, ни поправка HUG.
 */
async function checkPlain() {
  var built = scene("9", "HORIZONTAL");
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-autolayout-plain-"));
  try {
    var file = path.join(temp, "plain.pix");
    fs.writeFileSync(file, Fixture.buildContainer({
      build: { nodes: built.nodes, blobs: [], resources: [] },
    }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, {
      roots: [doc.tree.byKey.get(built.ids.plainFrame)], visualSafety: false,
    });
    var run = await Trace.runReceiver(doc, [{ rootId: built.ids.plainFrame, ir: ir }]);
    var node = null;
    run.host.pages().forEach(function (page) {
      (page.children || []).forEach(function (candidate) {
        if (candidate.getPluginData("pixsoDirectSourceId") === built.ids.plainFrame) node = candidate;
      });
    });
    ok(node, "обычный контейнер построен");
    near(node.width, 300, "обычный контейнер сохранил ширину");
    near(node.height, 150, "обычный контейнер сохранил высоту");
    eq(node.layoutMode, "NONE", "обычный контейнер не получил auto layout");
    near(node.children[0].width, 111, "обычный ребёнок сохранил ширину");
    near(node.children[0].height, 77, "обычный ребёнок сохранил высоту");
    var specs = ir.roots[0].nodes;
    ok(specs[1].childLayout === undefined,
      "узел вне auto layout не получает childLayout");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Вторая сцена: вырожденный HUG и sizing текста
// ---------------------------------------------------------------------------

/**
 * Сцена про ось, которую считать не по чему.
 *
 * У HUG есть предусловие: по этой оси должен быть хоть один ребёнок, чей
 * размер известен сам по себе. `stackChildPrimarySizing = RESIZE_TO_FIT`
 * (FILL) и `stackChildCounterSizing = RESIZE_TO_FIT` (STRETCH) означают
 * ровно обратное — «мою ось задаёт родитель». Когда так говорят ВСЕ узлы в
 * потоке, ось определена сама через себя, и редакторы расходятся:
 *
 *   Pixso  оставляет контейнеру прежний размер и растягивает детей до него;
 *   Figma  схлопывает ось в padding вместе со всем поддеревом.
 *
 * Схлопнутый текст с `textAutoResize = HEIGHT` переносится тогда по одной
 * букве, квадратная иконка становится полоской нулевой высоты, а контрол,
 * обязанный тянуться на всю строку, приезжает нулевой ширины.
 *
 * Здесь же собраны три класса sizing текста, которые задаёт сам источник
 * полем `textAutoResize`, а не геометрия: фиксированная ширина, FILL по
 * главной оси родителя и полностью автоматический размер.
 *
 * Сцена собрана в осях РАСКЛАДКИ и прогоняется в обеих ориентациях: одна и
 * та же запись источника обязана дать ширину в HORIZONTAL и высоту в
 * VERTICAL.
 */
function selfSizedScene(prefix, mode) {
  var horizontal = mode === "HORIZONTAL";
  function size(main, cross) { return horizontal ? { x: main, y: cross } : { x: cross, y: main }; }
  var id = function (name) { return prefix + ":" + name; };

  var ids = {
    document: id("1"), library: id("2"), page: id("3"),
    root: id("10"),
    // Вырожденный HUG по контр-оси и его содержимое.
    selfSizedCross: id("20"), collapsingText: id("21"), collapsingIcon: id("22"),
    // Вырожденный HUG по главной оси.
    selfSizedMain: id("30"), fillA: id("31"), fillB: id("32"),
    // Тот же HUG, но с якорем: обнимать есть что, и он обязан остаться HUG.
    anchoredHug: id("40"), anchor: id("41"), anchoredStretch: id("42"),
    // Текст: три класса sizing источника.
    textFixed: id("50"), textFill: id("51"), textAuto: id("52"),
    // Определение с текстом внутри и вхождение этого определения.
    labelSymbol: id("60"), labelText: id("61"), labelInstance: id("62"),
    // Квадратный мастер иконки.
    squareSymbol: id("70"), squareBody: id("71"),
    // Мастер, у которого ВСЁ содержимое растянуто, и вхождение, чья правка
    // возвращает контр-оси HUG уже после раскладки.
    overrideSymbol: id("80"), overrideLeafA: id("81"), overrideLeafB: id("82"),
    overrideInstance: id("83"),
    plainFrame: id("90"), plainChild: id("91"),
  };

  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
    { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

    // Квадратный мастер: обе оси у него фиксированы.
    {
      guid: guid(ids.squareSymbol), type: "SYMBOL", name: "Square icon",
      componentKey: prefix + "-square", parentIndex: parent(ids.library, "a"),
      transform: matrix(), size: { x: 48, y: 48 },
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.squareBody), type: "RECTANGLE", name: "Square body",
      parentIndex: parent(ids.squareSymbol, "a"), transform: matrix(), size: { x: 48, y: 48 },
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Определение с текстом, который внутри мастера объявлен FILL.
    {
      guid: guid(ids.labelSymbol), type: "SYMBOL", name: "Label",
      componentKey: prefix + "-label", parentIndex: parent(ids.library, "b"),
      transform: matrix(), size: size(180, 20),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.labelText), type: "TEXT", name: "Label text",
      parentIndex: parent(ids.labelSymbol, "a"), transform: matrix(), size: size(180, 20),
      textData: { characters: "Заголовок" }, textAutoResize: "HEIGHT", fillPaints: [solid()],
      stackChildPrimarySizing: "RESIZE_TO_FIT", stackChildCounterSizing: "FIXED",
    },

    {
      guid: guid(ids.root), type: "FRAME", name: "Screen", parentIndex: parent(ids.page, "a"),
      transform: matrix(), size: size(1400, 400),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },

    // Контр-ось HUG, и ВСЁ содержимое отдало её контейнеру.
    {
      guid: guid(ids.selfSizedCross), type: "FRAME", name: "Self sized cross",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: size(200, 48),
      fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT",
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.collapsingText), type: "TEXT", name: "Header",
      parentIndex: parent(ids.selfSizedCross, "a"), transform: matrix(), size: size(120, 48),
      textData: { characters: "Заголовок" }, textAutoResize: "HEIGHT", fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
    },
    {
      guid: guid(ids.collapsingIcon), type: "INSTANCE", name: "Icon",
      parentIndex: parent(ids.selfSizedCross, "b"), transform: matrix(), size: { x: 48, y: 48 },
      symbolData: { symbolID: guid(ids.squareSymbol) },
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
    },

    // Главная ось HUG, и ВСЁ содержимое отдало её контейнеру.
    {
      guid: guid(ids.selfSizedMain), type: "FRAME", name: "Self sized main",
      parentIndex: parent(ids.root, "b"), transform: matrix(), size: size(160, 40),
      fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.fillA), type: "FRAME", name: "Fill A",
      parentIndex: parent(ids.selfSizedMain, "a"), transform: matrix(), size: size(80, 40),
      fillPaints: [solid()],
      stackChildPrimarySizing: "RESIZE_TO_FIT", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.fillB), type: "FRAME", name: "Fill B",
      parentIndex: parent(ids.selfSizedMain, "b"), transform: matrix(), size: size(80, 40),
      fillPaints: [solid()],
      stackChildPrimarySizing: "RESIZE_TO_FIT", stackChildCounterSizing: "FIXED",
    },

    // Отрицательный контроль: у HUG есть ребёнок со своим размером.
    {
      guid: guid(ids.anchoredHug), type: "FRAME", name: "Anchored hug",
      parentIndex: parent(ids.root, "c"), transform: matrix(), size: size(200, 52),
      fillPaints: [solid()],
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT",
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.anchor), type: "RECTANGLE", name: "Anchor",
      parentIndex: parent(ids.anchoredHug, "a"), transform: matrix(), size: size(60, 52),
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.anchoredStretch), type: "RECTANGLE", name: "Anchored stretch",
      parentIndex: parent(ids.anchoredHug, "b"), transform: matrix(), size: size(60, 20),
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
    },

    // Текст: фиксированная ширина + автовысота.
    {
      guid: guid(ids.textFixed), type: "TEXT", name: "Fixed width text",
      parentIndex: parent(ids.root, "d"), transform: matrix(), size: size(160, 20),
      textData: { characters: "Фиксированная ширина" }, textAutoResize: "HEIGHT",
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // Текст: FILL по главной оси родителя.
    {
      guid: guid(ids.textFill), type: "TEXT", name: "Fill width text",
      parentIndex: parent(ids.root, "e"), transform: matrix(), size: size(100, 20),
      textData: { characters: "Тянется на всю строку" }, textAutoResize: "HEIGHT",
      fillPaints: [solid()],
      stackChildPrimarySizing: "RESIZE_TO_FIT", stackChildCounterSizing: "FIXED",
    },
    // Текст: обе оси принадлежат самому тексту.
    {
      guid: guid(ids.textAuto), type: "TEXT", name: "Auto text",
      parentIndex: parent(ids.root, "f"), transform: matrix(), size: size(64, 20),
      textData: { characters: "Авто" }, textAutoResize: "WIDTH_AND_HEIGHT",
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },
    // Вхождение определения с текстом внутри.
    {
      guid: guid(ids.labelInstance), type: "INSTANCE", name: "Label use",
      parentIndex: parent(ids.root, "g"), transform: matrix(), size: size(180, 20),
      symbolData: { symbolID: guid(ids.labelSymbol) },
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Мастер с фиксированными осями, всё содержимое которого растянуто по
    // контр-оси. Пока ось фиксирована, круга нет.
    {
      guid: guid(ids.overrideSymbol), type: "SYMBOL", name: "Row",
      componentKey: prefix + "-row", parentIndex: parent(ids.library, "c"),
      transform: matrix(), size: size(120, 44),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.overrideLeafA), type: "RECTANGLE", name: "Row cell A",
      parentIndex: parent(ids.overrideSymbol, "a"), transform: matrix(), size: size(60, 44),
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
    },
    {
      guid: guid(ids.overrideLeafB), type: "RECTANGLE", name: "Row cell B",
      parentIndex: parent(ids.overrideSymbol, "b"), transform: matrix(), size: size(60, 44),
      fillPaints: [solid()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
    },
    // Вхождение, чья правка возвращает контр-оси HUG. Правка приезжает ПОСЛЕ
    // раскладки, дети у вхождения свои — от мастера, и в пакете их нет.
    {
      guid: guid(ids.overrideInstance), type: "INSTANCE", name: "Row use",
      parentIndex: parent(ids.root, "h"), transform: matrix(), size: size(120, 44),
      symbolData: {
        symbolID: guid(ids.overrideSymbol),
        symbolOverrides: [{ guidPath: { guids: [] }, stackCounterSizing: "RESIZE_TO_FIT" }],
      },
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    {
      guid: guid(ids.plainFrame), type: "FRAME", name: "Plain", parentIndex: parent(ids.page, "b"),
      transform: matrix(0, 600), size: { x: 300, y: 150 }, fillPaints: [solid()],
    },
    {
      guid: guid(ids.plainChild), type: "RECTANGLE", name: "Plain child",
      parentIndex: parent(ids.plainFrame, "a"), transform: matrix(10, 10), size: { x: 111, y: 77 },
      fillPaints: [solid()],
    },
  ];
  return { ids: ids, nodes: nodes, mode: mode, horizontal: horizontal, size: size };
}

async function checkSelfSized(mode) {
  var built = selfSizedScene(mode === "HORIZONTAL" ? "11" : "12", mode);
  var out = await run(built);
  var ids = built.ids;
  var horizontal = built.horizontal;
  var tag = mode + " self-sized: ";

  // --- источник → IR -------------------------------------------------------
  eq(specById(out.specs, ids.selfSizedCross).autoLayout.counterAxisSizingMode, "AUTO",
    tag + "IR доносит HUG контр-оси как есть, поправку делает приёмник");
  eq(childLayoutOf(out.specs, ids.collapsingText).layoutAlign, "STRETCH",
    tag + "текст отдал контр-ось контейнеру");
  eq(childLayoutOf(out.specs, ids.collapsingIcon).layoutAlign, "STRETCH",
    tag + "иконка отдала контр-ось контейнеру");
  eq(specById(out.specs, ids.textFixed).text.textAutoResize, "HEIGHT",
    tag + "textAutoResize источника доехал до IR");
  eq(specById(out.specs, ids.textAuto).text.textAutoResize, "WIDTH_AND_HEIGHT",
    tag + "WIDTH_AND_HEIGHT источника доехал до IR");

  // --- HUG + FILL по контр-оси --------------------------------------------
  // Ось циклическая: ребёнок берёт counter-size у родителя через STRETCH,
  // а родитель вычисляет его по детям через HUG. Живая Figma такой цикл
  // держит с размерами Pixso (built-hug-counter-over-stretch), поэтому
  // родитель остаётся HUG, а Fill переносится как есть. Исключение — текст:
  // для него цикл не измерен, и его ось по-прежнему FIXED по коробке Pixso.
  var cross = out.byId[ids.selfSizedCross];
  eq(cross.counterAxisSizingMode, "AUTO",
    tag + "циклическая HUG контр-ось родителя сохранена");
  eq(cross.primaryAxisSizingMode, "FIXED", tag + "главная ось контейнера не тронута");
  near(axes(cross, horizontal).cross, 48, tag + "контейнер сохранил контр-ось источника");

  var collapsingText = out.byId[ids.collapsingText];
  eq(collapsingText.layoutAlign, "INHERIT", tag + "цикл разрешён на тексте: контр-ось ему принадлежит");
  near(axes(collapsingText, horizontal).cross, 48, tag + "текст сохранил контр-ось источника");
  eq(collapsingText.textAutoResize, "HEIGHT", tag + "режим авторазмера текста сохранён");
  near(axes(collapsingText, horizontal).main, 120, tag + "текст сохранил свою главную ось");

  var icon = out.byId[ids.collapsingIcon];
  eq(icon.type, "INSTANCE", tag + "иконка осталась нативным инстансом");
  eq(icon.layoutAlign, "STRETCH", tag + "инстанс в цикле сохранил Fill по контр-оси");
  near(axes(icon, horizontal).cross, 48, tag + "растянутая иконка сохранила контр-ось источника");

  // --- HUG + FILL по главной оси ------------------------------------------
  var main = out.byId[ids.selfSizedMain];
  eq(main.primaryAxisSizingMode, "AUTO",
    tag + "циклическая HUG главная ось родителя сохранена");
  eq(main.counterAxisSizingMode, "FIXED", tag + "контр-ось контейнера не тронута");
  near(axes(main, horizontal).main, 160, tag + "контейнер сохранил главную ось источника");
  var fillA = out.byId[ids.fillA];
  var fillB = out.byId[ids.fillB];
  eq(fillA.layoutGrow, 1, tag + "Fill по главной оси в цикле перенесён как есть");
  eq(fillB.layoutGrow, 1, tag + "второй Fill-ребёнок тоже растущий");
  near(axes(fillB, horizontal).main, 80, tag + "второй ребёнок сохранил главную ось источника");
  near(axes(fillA, horizontal).main, 80, tag + "ребёнок сохранил главную ось источника");

  // --- HUG parent + один FILL child ---------------------------------------
  // Наличие intrinsic sibling не разрывает зависимость FILL child от
  // родителя: цикл разрешается и при одном FILL-ребёнке, тоже на ребёнке.
  var anchored = out.byId[ids.anchoredHug];
  eq(anchored.counterAxisSizingMode, "AUTO", tag + "HUG родителя сохранён при одном FILL-ребёнке");
  near(axes(anchored, horizontal).cross, 52, tag + "HUG посчитан по ребёнку со своим размером");
  eq(out.byId[ids.anchoredStretch].layoutAlign, "STRETCH",
    tag + "растянутый ребёнок рядом с ребёнком своего размера сохранил Fill");

  // --- sizing текста -------------------------------------------------------
  var textFixed = out.byId[ids.textFixed];
  eq(textFixed.textAutoResize, "HEIGHT", tag + "фиксированная ширина + автовысота доехали до узла");
  eq(textFixed.layoutGrow, 0, tag + "текст с фиксированной шириной не растёт");
  near(axes(textFixed, horizontal).main, 160, tag + "ширина источника сохранена");
  near(axes(textFixed, horizontal).cross, 20, tag + "высота источника сохранена");

  var textFill = out.byId[ids.textFill];
  eq(textFill.layoutGrow, 1, tag + "FILL-текст объявлен растущим");
  eq(textFill.layoutAlign, "INHERIT", tag + "FILL по главной оси не трогает контр-ось текста");
  eq(textFill.textAutoResize, "HEIGHT",
    tag + "FILL не отменяет режим авторазмера: ширину задаёт раскладка, высоту — текст");
  ok(axes(textFill, horizontal).main > 160,
    tag + "FILL-текст занял остаток строки, а не схлопнулся (получено: " +
      axes(textFill, horizontal).main + ")");

  var textAuto = out.byId[ids.textAuto];
  eq(textAuto.textAutoResize, "WIDTH_AND_HEIGHT", tag + "полностью автоматический текст сохранил режим");
  eq(textAuto.layoutSizingHorizontal, "HUG",
    tag + "WIDTH_AND_HEIGHT TEXT финально показывает W=HUG, а не только внутренний textAutoResize");
  eq(textAuto.layoutSizingVertical, "HUG",
    tag + "WIDTH_AND_HEIGHT TEXT финально показывает H=HUG");

  // Порядок присваиваний. Figma фиксирует ширину в момент, когда назначен
  // режим авторазмера: у пустого узла она нулевая, и `HEIGHT`, выставленный
  // до символов, заморозил бы её на нуле — текст переносился бы по букве.
  ["textFixed", "textFill", "textAuto", "collapsingText"].forEach(function (key) {
    var node = out.byId[ids[key]];
    var order = node.__textWriteOrder || [];
    var chars = order.indexOf("characters");
    var resize = order.lastIndexOf("textAutoResize");
    ok(chars >= 0 && resize >= 0 && chars < resize,
      tag + key + ": режим авторазмера назначен ПОСЛЕ символов (" + order.join(" → ") + ")");
  });

  // --- текст внутри определения и внутри вхождения -------------------------
  var definition = out.definitions[0];
  ok(definition, tag + "определение построено");
  var definitionText = definition.children[0];
  eq(definitionText.type, "TEXT", tag + "в определении построен текст");
  eq(definitionText.layoutGrow, 1, tag + "текст определения объявлен FILL");
  eq(definitionText.textAutoResize, "HEIGHT", tag + "текст определения сохранил режим авторазмера");
  near(axes(definitionText, horizontal).main, 180,
    tag + "текст определения занял ширину мастера, а не минимальную");

  // --- вырожденный HUG, пришедший правкой вхождения ------------------------
  // Второй путь, которым ось становится AUTO: правка приезжает после
  // раскладки, и дети у вхождения свои — их приходится читать с узла.
  var overridden = out.byId[ids.overrideInstance];
  eq(overridden.type, "INSTANCE", tag + "вхождение с правкой раскладки осталось инстансом");
  eq(overridden.counterAxisSizingMode, "FIXED",
    tag + "правка, вернувшая HUG, отменена: обнимать по этой оси нечего");
  near(axes(overridden, horizontal).cross, 44,
    tag + "вхождение сохранило контр-ось, а не схлопнулось после правки");
  near(axes(overridden, horizontal).main, 120, tag + "вхождение сохранило главную ось");
  near(axes(overridden.children[0], horizontal).cross, 44,
    tag + "содержимое вхождения осталось своего размера");

  var instance = out.byId[ids.labelInstance];
  eq(instance.type, "INSTANCE", tag + "вхождение осталось нативным инстансом");
  near(axes(instance, horizontal).main, 180, tag + "вхождение сохранило главную ось");
  near(axes(instance.children[0], horizontal).main, 180,
    tag + "текст внутри вхождения не сжался до минимума");

  return out;
}

(async function () {
  var horizontal = await check("HORIZONTAL");
  var vertical = await check("VERTICAL");

  // Ловушка на перепутанные оси: та же запись источника обязана дать РАЗНЫЕ
  // ширину и высоту в разных ориентациях. Если mapping потеряет ось, обе
  // сцены дадут одинаковый габарит и это условие сломается.
  var hStretch = horizontal.byId[horizontal.ids.stretchBox];
  var vStretch = vertical.byId[vertical.ids.stretchBox];
  near(hStretch.height, 100, "HORIZONTAL: STRETCH растянул ВЫСОТУ");
  near(hStretch.width, 80, "HORIZONTAL: STRETCH не тронул ширину");
  near(vStretch.width, 100, "VERTICAL: тот же STRETCH растянул ШИРИНУ");
  near(vStretch.height, 80, "VERTICAL: STRETCH не тронул высоту");

  await checkPlain();

  // Pixso can retain stale padding that is geometrically impossible on a
  // fixed single-child container. Figma enforces that padding and would grow
  // the 24px box to a 42px minimum. The observed source child box proves the
  // effective margins are 4/4, so those are the only safe values to import.
  var paddingNormalizer = PixNormalizer.createNormalizer();
  var reconciledPadding = paddingNormalizer.autoLayout({
    stackMode: "HORIZONTAL", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    stackPrimaryAlignItems: "CENTER", stackPaddingLeft: 20, stackPaddingRight: 20,
    stackPaddingTop: 0, stackPaddingBottom: 0, size: { x: 24, y: 24 },
  }, { flowChildCount: 1, flowChildBoxes: [{ x: 4, y: 4, width: 16, height: 16 }] });
  eq(reconciledPadding.paddingLeft, 4, "невозможный stale left padding согласован с source geometry");
  eq(reconciledPadding.paddingRight, 4, "невозможный stale right padding согласован с source geometry");

  // Обводка в раскладке объявляется явно в обе стороны: молчание Pixso — это
  // «не входит», и без явного false узел получал бы умолчание Figma.
  var strokeBase = { stackMode: "HORIZONTAL", stackPrimarySizing: "RESIZE_TO_FIT",
    stackCounterSizing: "RESIZE_TO_FIT", size: { x: 248, y: 36 } };
  eq(paddingNormalizer.autoLayout(strokeBase, { flowChildCount: 1 }).strokesIncludedInLayout, false,
    "молчание Pixso об обводке объявлено как false");
  eq(paddingNormalizer.autoLayout(Object.assign({ autoLayoutIncludeBorders: true }, strokeBase),
    { flowChildCount: 1 }).strokesIncludedInLayout, true, "включённая обводка объявлена как true");

  // Вторая сцена: ось HUG, которую считать не по чему, и sizing текста.
  // Обе ориентации обязательны и здесь: `layoutGrow` — это ширина в
  // HORIZONTAL и высота в VERTICAL, и поправка обязана следовать за осью.
  var hSelf = await checkSelfSized("HORIZONTAL");
  var vSelf = await checkSelfSized("VERTICAL");
  eq(hSelf.byId[hSelf.ids.selfSizedCross].counterAxisSizingMode, "AUTO",
    "HORIZONTAL: циклический HUG+FILL не закрепил родителя");
  eq(vSelf.byId[vSelf.ids.selfSizedCross].counterAxisSizingMode, "AUTO",
    "VERTICAL: циклический HUG+FILL не закрепил родителя");
  ok((hSelf.finish.totals.degenerateFillAxesFixed || 0) >= 1,
    "перевод растянутого текста в FIXED посчитан");

  console.log("OK: Direct PIX auto layout sizing — " + checks + " проверок пройдено");
})().catch(function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
