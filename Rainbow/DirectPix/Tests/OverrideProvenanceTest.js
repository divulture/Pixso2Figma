/**
 * Direct PIX: происхождение полей sizing в записи `symbolOverrides`.
 *
 *   node DirectPix/Tests/OverrideProvenanceTest.js
 *
 * Запись override — это полный `PixsoNode`, а не дельта. Поэтому присутствие
 * `stackPrimarySizing` в ней НЕ доказывает, что вхождение действительно
 * сменило владельца оси: часть записей несёт эффективный снимок уже
 * действующего состояния. Проигранный обратно в Figma, такой снимок снимает
 * с оси размер источника и отдаёт её раскладке — квадрат 12×12 приезжает
 * 8×12.
 *
 * Обратное утверждение так же неверно: `RESIZE_TO_FIT` бывает настоящей
 * правкой вхождения, и глушить его целиком запрещено.
 *
 * Тест закрепляет различающее доказательство — РАЗРЕШЁННУЮ геометрию:
 *
 *   ось переключается в HUG, а размер по ней остался равен размеру
 *   определения  → снимок, воспроизводить нельзя;
 *   ось переключается в HUG, и размер по ней от определения отличается
 *                → настоящая правка, воспроизводится;
 *   доказательства нет → UNKNOWN, прежнее поведение сохраняется.
 *
 * Проверяется вся цепочка `.pix` → MigrationIR → узел Figma, построенный
 * НАСТОЯЩИМ кодом приёмника на headless-двойнике, и в обеих ориентациях
 * раскладки: правило про оси, проверенное только в одной, перепутанные оси
 * не ловит.
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
function paint(r, g, b) {
  return { type: "SOLID", color: { r: r, g: g, b: b, a: 255 }, visible: true, blendMode: "NORMAL" };
}
function grey() { return paint(10, 10, 10); }
function red() { return paint(255, 0, 0); }

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

/**
 * Одна и та же сцена в двух ориентациях.
 *
 * `main`/`cross` — оси РАСКЛАДКИ, а не ширина и высота: в `size` они
 * укладываются уже по ориентации.
 */
function scene(prefix, mode) {
  var horizontal = mode === "HORIZONTAL";
  function size(main, cross) { return horizontal ? { x: main, y: cross } : { x: cross, y: main }; }
  function id(name) { return prefix + ":" + name; }

  var ids = {
    document: id("1"), library: id("2"), page: id("3"), root: id("10"),
    square: id("20"), squareLeaf: id("21"),
    pill: id("22"), pillLeaf: id("23"),
    card: id("24"), cardLeaf: id("25"),
    wrapper: id("26"), inner: id("27"), innerLeaf: id("28"),
    empty: id("29"),
    inert: id("40"), genuine: id("41"),
    counterInert: id("42"), counterGenuine: id("43"),
    nestedUnknown: id("44"), nestedInert: id("45"),
    childless: id("46"),
  };

  var nodes = [
    { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
    {
      guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true,
      parentIndex: parent(ids.document, "a"),
    },
    { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },

    // Определение, чей HUG по главной оси КОРОЧЕ его собственного размера:
    // содержимое 8, коробка 12. Ровно так выглядит доказанный разрушительный
    // случай — запись вхождения переключает ось в HUG, и квадрат схлопывается.
    {
      guid: guid(ids.square), type: "SYMBOL", name: "Square", componentKey: prefix + "-square",
      parentIndex: parent(ids.library, "a"), transform: matrix(), size: size(12, 12),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.squareLeaf), type: "RECTANGLE", name: "Square leaf",
      parentIndex: parent(ids.square, "a"), transform: matrix(), size: size(8, 12),
      fillPaints: [grey()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // То же определение по форме, но содержимое ДЛИННЕЕ коробки: HUG даёт 100
    // при объявленных 60. Вхождение размером 100 — настоящая правка.
    {
      guid: guid(ids.pill), type: "SYMBOL", name: "Pill", componentKey: prefix + "-pill",
      parentIndex: parent(ids.library, "b"), transform: matrix(), size: size(60, 24),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.pillLeaf), type: "RECTANGLE", name: "Pill leaf",
      parentIndex: parent(ids.pill, "a"), transform: matrix(), size: size(100, 24),
      fillPaints: [grey()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Контр-ось: содержимое 10, коробка 20.
    {
      guid: guid(ids.card), type: "SYMBOL", name: "Card", componentKey: prefix + "-card",
      parentIndex: parent(ids.library, "c"), transform: matrix(), size: size(40, 20),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.cardLeaf), type: "RECTANGLE", name: "Card leaf",
      parentIndex: parent(ids.card, "a"), transform: matrix(), size: size(40, 10),
      fillPaints: [grey()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Определение с ВЛОЖЕННОЙ целью: запись адресует не сам инстанс, а узел
    // внутри него. Собственной коробки у такой цели вхождение не несёт.
    {
      guid: guid(ids.wrapper), type: "SYMBOL", name: "Wrapper", componentKey: prefix + "-wrapper",
      parentIndex: parent(ids.library, "d"), transform: matrix(), size: size(260, 60),
    },
    {
      guid: guid(ids.inner), type: "FRAME", name: "Inner",
      parentIndex: parent(ids.wrapper, "a"), transform: matrix(), size: size(260, 60),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
    {
      guid: guid(ids.innerLeaf), type: "RECTANGLE", name: "Inner leaf",
      parentIndex: parent(ids.inner, "a"), transform: matrix(), size: size(704, 60),
      fillPaints: [grey()],
      stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
    },

    // Контейнер БЕЗ детей: обнимать ему нечего ни в Pixso, ни в Figma.
    {
      guid: guid(ids.empty), type: "SYMBOL", name: "Empty", componentKey: prefix + "-empty",
      parentIndex: parent(ids.library, "e"), transform: matrix(), size: size(30, 30),
      stackMode: mode, stackSpacing: 0,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },

    // Корень без раскладки: размеры вхождений принадлежат им самим, и ни одна
    // проверка ниже не спорит с родительским потоком.
    {
      guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"),
      transform: matrix(), size: { x: 900, y: 400 },
    },

    // A + C. Смешанная запись доказанного отказа: имя, видимость и заливка —
    // настоящее состояние вхождения, `stackPrimarySizing` — снимок.
    // Записанная коробка вхождения равна коробке определения.
    {
      guid: guid(ids.inert), type: "INSTANCE", name: "Inert use",
      parentIndex: parent(ids.root, "a"), transform: matrix(0, 0), size: size(12, 12),
      symbolData: {
        symbolID: guid(ids.square),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.square)] },
          name: "Inert occurrence",
          visible: false,
          fillPaints: [red()],
          stackPrimarySizing: "RESIZE_TO_FIT",
        }],
      },
    },

    // B. Тот же вид записи, другая разрешённая геометрия: коробка вхождения
    // от коробки определения отличается — правка настоящая.
    {
      guid: guid(ids.genuine), type: "INSTANCE", name: "Genuine use",
      parentIndex: parent(ids.root, "b"), transform: matrix(0, 40), size: size(100, 24),
      symbolData: {
        symbolID: guid(ids.pill),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.pill)] },
          stackPrimarySizing: "RESIZE_TO_FIT",
        }],
      },
    },

    // D. Контр-ось, оба исхода.
    {
      guid: guid(ids.counterInert), type: "INSTANCE", name: "Counter inert",
      parentIndex: parent(ids.root, "c"), transform: matrix(0, 80), size: size(40, 20),
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.card)] },
          stackCounterSizing: "RESIZE_TO_FIT",
        }],
      },
    },
    {
      guid: guid(ids.counterGenuine), type: "INSTANCE", name: "Counter genuine",
      parentIndex: parent(ids.root, "d"), transform: matrix(0, 120), size: size(40, 10),
      symbolData: {
        symbolID: guid(ids.card),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.card)] },
          stackCounterSizing: "RESIZE_TO_FIT",
        }],
      },
    },

    // F. Вложенная цель без единого доказательства геометрии: классификатор
    // обязан сказать UNKNOWN и НЕ выдумывать намерение — прежнее поведение
    // сохраняется, HUG применяется.
    {
      guid: guid(ids.nestedUnknown), type: "INSTANCE", name: "Nested unknown",
      parentIndex: parent(ids.root, "e"), transform: matrix(0, 160), size: size(260, 60),
      symbolData: {
        symbolID: guid(ids.wrapper),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.inner)] },
          stackPrimarySizing: "RESIZE_TO_FIT",
        }],
      },
    },

    // E. Та же вложенная цель и то же присутствующее поле, но с записанной
    // геометрией, равной геометрии определения: снимок.
    {
      guid: guid(ids.nestedInert), type: "INSTANCE", name: "Nested inert",
      parentIndex: parent(ids.root, "f"), transform: matrix(0, 240), size: size(260, 60),
      symbolData: {
        symbolID: guid(ids.wrapper),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.inner)] },
          size: size(260, 60),
          stackPrimarySizing: "RESIZE_TO_FIT",
        }],
      },
    },

    // J. Правка доезжает до приёмника как настоящая (геометрия отличается),
    // но цель — контейнер без содержимого. Обнимать нечего, и Figma села бы
    // на padding вместе со всем поддеревом.
    {
      guid: guid(ids.childless), type: "INSTANCE", name: "Childless use",
      parentIndex: parent(ids.root, "g"), transform: matrix(0, 320), size: size(50, 30),
      symbolData: {
        symbolID: guid(ids.empty),
        symbolOverrides: [{
          guidPath: { guids: [guid(ids.empty)] },
          stackPrimarySizing: "RESIZE_TO_FIT",
        }],
      },
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

async function run(built) {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-provenance-"));
  try {
    var file = path.join(temp, "provenance.pix");
    fs.writeFileSync(file, Fixture.buildContainer({
      build: { nodes: built.nodes, blobs: [], resources: [] },
    }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var rootRecord = doc.tree.byKey.get(built.ids.root);
    var ir = MigrationIR.build(doc, { roots: [rootRecord], visualSafety: false });
    var receiver = await Trace.runReceiver(doc, [{ rootId: built.ids.root, ir: ir }]);

    var rootSpecs = ir.roots[0].nodes;
    var rootNode = null;
    receiver.host.pages().forEach(function (page) {
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

    return { ids: built.ids, ir: ir, specs: rootSpecs, byId: byId, finish: receiver.finish };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Габарит узла в осях РАСКЛАДКИ, а не в ширине/высоте. */
function axes(node, horizontal) {
  return { main: horizontal ? node.width : node.height, cross: horizontal ? node.height : node.width };
}

/** Режим оси РАСКЛАДКИ узла. */
function axisMode(node, which) {
  return which === "main" ? node.primaryAxisSizingMode : node.counterAxisSizingMode;
}

async function check(mode) {
  var built = scene(mode === "HORIZONTAL" ? "31" : "32", mode);
  var out = await run(built);
  var ids = built.ids;
  var horizontal = built.horizontal;
  var tag = mode + ": ";

  // --- A. Доказанный разрушительный случай --------------------------------
  var inert = out.byId[ids.inert];
  ok(inert, tag + "вхождение со снимком sizing построено");
  eq(inert.type, "INSTANCE", tag + "вхождение осталось нативным инстансом");
  near(axes(inert, horizontal).main, 12,
    tag + "снимок sizing не снял с главной оси размер источника");
  near(axes(inert, horizontal).cross, 12, tag + "контр-ось не тронута");
  eq(axisMode(inert, "main"), "FIXED", tag + "главная ось не ушла в HUG по снимку");

  // --- C. Смешанная запись ------------------------------------------------
  eq(inert.visible, false, tag + "видимость из той же записи сохранена");
  // Имя вхождения — корневая правка имени, а не техническая подпись записи
  // (так его показывает панель слоёв Pixso). Классификатор sizing его не трогает.
  eq(inert.name, "Inert occurrence", tag + "корневая правка имени из той же записи сохранена");
  ok(inert.fills && inert.fills.length === 1 && inert.fills[0].color.r > 0.9 &&
    inert.fills[0].color.g < 0.1,
    tag + "заливка из той же записи сохранена");

  // --- B. Настоящая правка выживает ---------------------------------------
  var genuine = out.byId[ids.genuine];
  ok(genuine, tag + "вхождение с настоящей правкой построено");
  eq(axisMode(genuine, "main"), "AUTO", tag + "настоящий HUG не заглушён");
  near(axes(genuine, horizontal).main, 100,
    tag + "настоящий HUG посчитан по содержимому вхождения");

  // --- D. Контр-ось -------------------------------------------------------
  var counterInert = out.byId[ids.counterInert];
  eq(axisMode(counterInert, "cross"), "FIXED", tag + "снимок контр-оси не воспроизведён");
  near(axes(counterInert, horizontal).cross, 20, tag + "контр-ось сохранила размер источника");
  var counterGenuine = out.byId[ids.counterGenuine];
  eq(axisMode(counterGenuine, "cross"), "AUTO", tag + "настоящий HUG контр-оси сохранён");
  near(axes(counterGenuine, horizontal).cross, 10,
    tag + "настоящий HUG контр-оси посчитан по содержимому");

  // --- F. Вложенная цель без доказательства -------------------------------
  var nestedUnknown = out.byId[ids.nestedUnknown];
  ok(nestedUnknown && nestedUnknown.children && nestedUnknown.children.length === 1,
    tag + "вложенная цель построена");
  var unknownInner = nestedUnknown.children[0];
  eq(axisMode(unknownInner, "main"), "AUTO",
    tag + "без доказательства прежнее поведение сохранено");
  near(axes(unknownInner, horizontal).main, 704,
    tag + "вложенный HUG без доказательства посчитан по содержимому");

  // --- E. То же поле, другая разрешённая геометрия ------------------------
  var nestedInert = out.byId[ids.nestedInert];
  var inertInner = nestedInert.children[0];
  eq(axisMode(inertInner, "main"), "FIXED",
    tag + "снимок вложенной цели не воспроизведён");
  near(axes(inertInner, horizontal).main, 260,
    tag + "вложенная цель сохранила размер определения");

  // --- J. Контейнер без детей ---------------------------------------------
  // Приёмник не переводит правку HUG в FIXED, и это не нужно: живая Figma
  // держит размер пустого HUG (FIGMA_CAPABILITIES.md, hug-over-no-children).
  var childless = out.byId[ids.childless];
  eq(axisMode(childless, "main"), "AUTO",
    tag + "правка HUG у вхождения без детей не переведена в FIXED");
  near(axes(childless, horizontal).main, 50,
    tag + "пустой HUG сохранил размер вхождения, а не схлопнулся в padding");

  // --- Причинные счётчики -------------------------------------------------
  var provenance = out.ir.layoutProvenanceReport;
  ok(provenance, tag + "отчёт о происхождении sizing выпущен");
  eq(provenance.candidates, 7, tag + "все поля sizing записей посчитаны");
  eq(provenance.explicitApplied, 3, tag + "настоящих правок ровно три");
  eq(provenance.derivedSuppressed, 3, tag + "снимков ровно три");
  eq(provenance.destructiveSuppressed, 3,
    tag + "все три снимка сняли бы с оси размер источника");
  eq(provenance.baseEchoSuppressed, 0, tag + "чистых эхо базы в фикстуре нет");
  eq(provenance.unknown, 1, tag + "без доказательства — ровно одно поле");

  // --- I. Идемпотентность --------------------------------------------------
  var again = await run(built);
  var repeated = again.ir.layoutProvenanceReport;
  eq(repeated.explicitApplied, provenance.explicitApplied,
    tag + "повторная классификация дала то же число применённых");
  eq(repeated.derivedSuppressed, provenance.derivedSuppressed,
    tag + "повторная классификация дала то же число снимков");
  near(axes(again.byId[ids.inert], horizontal).main, 12,
    tag + "повторная сборка дала ту же геометрию");
}

async function main() {
  await check("HORIZONTAL");
  await check("VERTICAL");
  process.stdout.write("OverrideProvenanceTest: " + checks + " проверок пройдено\n");
}

main().catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  process.exit(1);
});
