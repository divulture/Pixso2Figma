/**
 * Direct PIX: семантика РАЗМЕРА текста.
 *
 *   node DirectPix/Tests/TextSizingTest.js
 *
 * Проверяются два поля, которыми источник объявляет, кто держит коробку
 * текста, и оба они раньше терялись целиком:
 *
 *   textAutoResize   кто задаёт ширину и высоту — узел или содержимое;
 *   textTruncation   что происходит со строкой, которая в коробку не влезла.
 *
 * Оба поля объявляются в `.pix` enum-ами, но с разной нумерацией, и от неё
 * зависит смысл ОТСУТСТВИЯ поля в записи:
 *
 *   TextAutoResize   NONE=1 WIDTH_AND_HEIGHT=2 HEIGHT=3   нуля нет
 *   TextTruncation   DISABLED=0 ENDING=1                  ноль есть
 *
 * Поэтому отсутствие `textAutoResize` — это `NONE` (обе оси держит узел), а
 * отсутствие `textTruncation` — действительно `DISABLED`. Раньше первое
 * трактовалось как «источник промолчал», узлу не присваивалось ничего, и он
 * оставался с умолчанием `figma.createText()`: объявленная источником
 * фиксированная коробка превращалась в текст, который меряет сам себя.
 *
 * Второе не переносилось вовсе, а `maxLines` при этом присваивался — в
 * Figma он действует только при включённом `textTruncation`, то есть был
 * записью в никуда. Строка, которую Pixso обрезает по одной линии, в Figma
 * переносилась, и вместе с ней росла высота всего HUG-поддерева.
 *
 * Двойник хоста текст НЕ меряет, поэтому здесь проверяются семантика и
 * порядок присваиваний, а не пиксели переноса: порядок — это и есть то, что
 * в настоящем редакторе даёт или не даёт нужную геометрию.
 *
 * Фикстура синтетическая: production-код не знает её id, имён и текста.
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
function solid() { return { type: "SOLID", color: { r: 10, g: 10, b: 10, a: 255 }, visible: true, blendMode: "NORMAL" }; }

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

var ids = {
  document: "9:1", library: "9:2", page: "9:3",
  fillStyle: "9:4", textStyle: "9:5",
  root: "9:10",
  silent: "9:11",        // textAutoResize не записан вовсе
  autoBox: "9:12",       // WIDTH_AND_HEIGHT
  fixedWidth: "9:13",    // HEIGHT
  truncated: "9:14",     // ENDING + maxLines, ширину держит узел
  silentFill: "9:15",    // textAutoResize не записан, ширину задаёт родитель
  mixed: "9:16",         // mixed-range typography
  autoTruncated: "9:17", // ENDING/maxLines не меняют исходный width HUG
  autoTruncatedBox: "9:18", // без maxLines тот же инвариант
};

/**
 * Коробки заданы так, чтобы их нельзя было получить измерением: 200×40 при
 * межстрочном 20 — это две строки высоты на однострочном тексте. Ровно этим
 * группа «поля нет» отличается на настоящих документах от групп HEIGHT и
 * WIDTH_AND_HEIGHT, у которых высота совпадает с межстрочной в 99.9 %.
 */
var NODES = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },
  { guid: guid(ids.fillStyle), type: "RECTANGLE", name: "text/base-fill", styleType: "FILL",
    parentIndex: parent(ids.library, "aa"), sharedStyleReference: { styleKey: "mixed-base-fill", versionHash: "1:1" },
    fillPaints: [solid()] },
  { guid: guid(ids.textStyle), type: "TEXT", name: "text/base", styleType: "TEXT",
    parentIndex: parent(ids.library, "ab"), sharedStyleReference: { styleKey: "mixed-base-text", versionHash: "1:1" },
    fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
    lineHeight: { value: 20, units: "PIXELS" },
    textData: { characters: "Aa", characterStyleIDs: [0, 0], styleOverrideTable: [] } },

  {
    guid: guid(ids.root), type: "FRAME", name: "Column", parentIndex: parent(ids.page, "a"),
    transform: matrix(), size: { x: 300, y: 400 },
    stackMode: "VERTICAL", stackSpacing: 0,
    stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
  },

  // Источник не записал `textAutoResize`: коробка принадлежит узлу целиком.
  {
    guid: guid(ids.silent), type: "TEXT", name: "Avatar letter",
    parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 200, y: 40 },
    textData: { characters: "A" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 20, units: "PIXELS" },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
  // Ширину и высоту считает содержимое.
  {
    guid: guid(ids.autoBox), type: "TEXT", name: "Auto",
    parentIndex: parent(ids.root, "b"), transform: matrix(), size: { x: 64, y: 20 },
    textData: { characters: "Auto" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 1.2, units: "PERCENT" },
    letterSpacing: { value: -0.01, units: "PERCENT" },
    textAutoResize: "WIDTH_AND_HEIGHT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
  // Ширину держит узел, высоту считает содержимое.
  {
    guid: guid(ids.fixedWidth), type: "TEXT", name: "Wrapped",
    parentIndex: parent(ids.root, "c"), transform: matrix(), size: { x: 120, y: 20 },
    textData: { characters: "Wrapped" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 20, units: "PIXELS" },
    textAutoResize: "HEIGHT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
  // Одна строка с многоточием: коробка узкая нарочно.
  {
    guid: guid(ids.truncated), type: "TEXT", name: "Ellipsis",
    parentIndex: parent(ids.root, "d"), transform: matrix(), size: { x: 60, y: 20 },
    textData: { characters: "Согласование" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 20, units: "PIXELS" },
    textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 1,
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
  // Поля нет, но ширину узел отдал родителю: объявленный `NONE` не имеет
  // права отнять ось у раскладки.
  {
    guid: guid(ids.silentFill), type: "TEXT", name: "Stretched",
    parentIndex: parent(ids.root, "e"), transform: matrix(), size: { x: 80, y: 20 },
    textData: { characters: "Stretched" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 20, units: "PIXELS" },
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "RESIZE_TO_FIT",
  },
  {
    guid: guid(ids.autoTruncated), type: "TEXT", name: "Auto ellipsis",
    parentIndex: parent(ids.root, "ea"), transform: matrix(), size: { x: 60, y: 20 },
    textData: { characters: "Очень длинная строка" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 20, units: "PIXELS" },
    textAutoResize: "WIDTH_AND_HEIGHT", textTruncation: "ENDING", maxLines: 1,
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
  {
    guid: guid(ids.autoTruncatedBox), type: "TEXT", name: "Auto ellipsis box",
    parentIndex: parent(ids.root, "eb"), transform: matrix(), size: { x: 60, y: 40 },
    textData: { characters: "Длинный текст в фиксированной коробке" }, fillPaints: [solid()],
    fontSize: 14, lineHeight: { value: 20, units: "PIXELS" },
    textAutoResize: "WIDTH_AND_HEIGHT", textTruncation: "ENDING",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
  {
    guid: guid(ids.mixed), type: "TEXT", name: "Mixed",
    parentIndex: parent(ids.root, "f"), transform: matrix(), size: { x: 180, y: 20 },
    textData: {
      characters: "ABCD",
      characterStyleIDs: [1, 1, 0, 2],
      styleOverrideTable: [
        { styleID: 1, fontSize: 20, fillPaints: [{ type: "SOLID", color: { r: 255, g: 0, b: 0, a: 255 }, visible: true, blendMode: "NORMAL" }] },
        { styleID: 2, fontSize: 12, textDecoration: "UNDERLINE", letterSpacing: { value: 0.05, units: "PERCENT" } },
      ],
    },
    fillPaints: [solid()], inheritFillStyleID: guid(ids.fillStyle),
    fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
    lineHeight: { value: 20, units: "PIXELS" }, inheritTextStyleID: guid(ids.textStyle),
    leadingTrim: "CAP_HEIGHT",
    stackChildPrimarySizing: "FIXED", stackChildCounterSizing: "FIXED",
  },
];

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

function specById(list, id) {
  return list.filter(function (node) { return node.id === id; })[0] || null;
}

async function run() {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-textsizing-"));
  try {
    var file = path.join(temp, "text.pix");
    fs.writeFileSync(file, Fixture.buildContainer({
      build: { nodes: NODES, blobs: [], resources: [] },
    }).zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var ir = MigrationIR.build(doc, {
      roots: [doc.tree.byKey.get(ids.root)], visualSafety: false,
    });
    var out = await Trace.runReceiver(doc, [{ rootId: ids.root, ir: ir }]);

    var rootNode = null;
    out.host.pages().forEach(function (page) {
      (page.children || []).forEach(function (node) {
        if (node.getPluginData("pixsoDirectSourceId") === ids.root) rootNode = node;
      });
    });
    var specs = ir.roots[0].nodes;
    var byId = Object.create(null);
    var counts = Object.create(null);
    specs.forEach(function (spec) {
      if (!spec.parent) { byId[spec.id] = rootNode; return; }
      var host = byId[spec.parent];
      var index = counts[spec.parent] || 0;
      counts[spec.parent] = index + 1;
      if (host && host.children) byId[spec.id] = host.children[index];
    });
    return { ir: ir, specs: specs, byId: byId, node: rootNode };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Позиция поля в журнале присваиваний двойника. -1 — не присваивалось. */
function writeIndex(node, field) {
  var order = node.__textWriteOrder || [];
  return order.indexOf(field);
}

async function check() {
  var out = await run();

  // --- источник → IR -------------------------------------------------------

  eq(specById(out.specs, ids.silent).text.textAutoResize, "NONE",
    "отсутствие textAutoResize в источнике — это NONE, а не молчание");
  eq(specById(out.specs, ids.silentFill).text.textAutoResize, "NONE",
    "отсутствие textAutoResize объявляется и у ребёнка, чью ось держит родитель");
  eq(specById(out.specs, ids.autoBox).text.textAutoResize, "WIDTH_AND_HEIGHT",
    "WIDTH_AND_HEIGHT источника перенесён");
  eq(specById(out.specs, ids.autoBox).text.lineHeight.value, 120,
    "бинарный ratio lineHeight=1.2 нормализован в Figma 120%");
  eq(specById(out.specs, ids.autoBox).text.lineHeight.unit, "PERCENT",
    "процентный lineHeight сохраняет единицу");
  eq(specById(out.specs, ids.autoBox).text.letterSpacing.value, -1,
    "бинарный ratio tracking=-0.01 нормализован в Figma -1%");
  eq(specById(out.specs, ids.fixedWidth).text.textAutoResize, "HEIGHT",
    "HEIGHT источника перенесён");

  eq(specById(out.specs, ids.truncated).text.textTruncation, "ENDING",
    "обрезание многоточием перенесено");
  eq(specById(out.specs, ids.truncated).text.maxLines, 1,
    "предел строк перенесён вместе с обрезанием");
  ok(specById(out.specs, ids.autoTruncated).text.sourceTextAutoResize === undefined,
    "producer не создаёт второй режим размера");
  eq(specById(out.specs, ids.autoTruncated).text.textAutoResize, "WIDTH_AND_HEIGHT",
    "ENDING + maxLines не отняли у текста width HUG");
  eq(specById(out.specs, ids.autoTruncatedBox).text.textAutoResize, "WIDTH_AND_HEIGHT",
    "ENDING без maxLines не выдумывает фиксированную ширину");
  ok(specById(out.specs, ids.fixedWidth).text.textTruncation === undefined,
    "отсутствие textTruncation остаётся отсутствием: у этого enum ноль есть");
  ok(specById(out.specs, ids.silent).text.maxLines === undefined,
    "предел строк не выдумывается");

  var mixedSpec = specById(out.specs, ids.mixed);
  eq(mixedSpec.text.leadingTrim, "CAP_HEIGHT", "leading trim перенесён");
  eq(mixedSpec.text.segments.length, 2, "mixed typography собрана в два диапазона");
  eq(mixedSpec.text.segments[0].start, 0, "первый диапазон начинается с первого символа");
  eq(mixedSpec.text.segments[0].end, 2, "одинаковые style id объединены в диапазон");
  eq(mixedSpec.text.segments[0].fontSize, 20, "размер шрифта диапазона перенесён");
  eq(mixedSpec.text.segments[1].textDecoration, "UNDERLINE", "декорация второго диапазона перенесена");
  eq(mixedSpec.text.segments[1].letterSpacing.value, 5,
    "range tracking ratio=0.05 нормализован в Figma 5%");

  // --- IR → Figma ----------------------------------------------------------

  var silent = out.byId[ids.silent];
  eq(silent.type, "TEXT", "узел построен текстом");
  eq(silent.textAutoResize, "NONE", "узлу присвоен NONE, а не оставлено умолчание хоста");
  eq(silent.characters, "A", "содержимое на месте");
  near(silent.width, 200, "коробка источника сохранена по ширине");
  near(silent.height, 40, "коробка источника сохранена по высоте");

  var auto = out.byId[ids.autoBox];
  eq(auto.textAutoResize, "WIDTH_AND_HEIGHT", "авторазмер по обеим осям выставлен");

  var wrapped = out.byId[ids.fixedWidth];
  eq(wrapped.textAutoResize, "HEIGHT", "авторазмер по высоте выставлен");
  near(wrapped.width, 120, "ширину держит узел");

  var ellipsis = out.byId[ids.truncated];
  eq(ellipsis.textTruncation, "ENDING", "обрезание выставлено на узле");
  eq(ellipsis.maxLines, 1, "предел строк выставлен на узле");
  near(ellipsis.width, 60, "узкая коробка обрезаемой строки сохранена");
  near(ellipsis.height, 20, "обрезаемая строка осталась одной строкой по источнику");

  var autoEllipsis = out.byId[ids.autoTruncated];
  eq(autoEllipsis.textAutoResize, "WIDTH_AND_HEIGHT",
    "overflow metadata не превратила HUG в физическую ширину");
  eq(autoEllipsis.textTruncation, "ENDING", "ENDING остался на ноде");
  eq(autoEllipsis.maxLines, 1, "maxLines остался на ноде");
  eq(autoEllipsis.layoutSizingHorizontal, "HUG",
    "ось текста осталась HUG и может вырасти после character override");

  var autoEllipsisBox = out.byId[ids.autoTruncatedBox];
  eq(autoEllipsisBox.textAutoResize, "WIDTH_AND_HEIGHT",
    "без maxLines автоширина осталась семантикой источника");
  eq(autoEllipsisBox.layoutSizingHorizontal, "HUG",
    "недоказанное обрезание не сжало подпись в исходную коробку");

  // Ось, отданную родителю, объявленный NONE не отнимает.
  var stretched = out.byId[ids.silentFill];
  eq(stretched.textAutoResize, "NONE", "NONE объявлен и здесь");
  eq(stretched.layoutAlign, "STRETCH", "ось по-прежнему принадлежит родителю");
  near(stretched.width, 300, "родитель задал ширину, а не источник");

  var mixed = out.byId[ids.mixed];
  eq(mixed.leadingTrim, "CAP_HEIGHT", "Figma получает leadingTrim");
  ok(!!mixed.fillStyleId, "mixed TEXT сначала получил base fill style");
  ok(!!mixed.textStyleId, "mixed TEXT сначала получил base text style");
  ok(Array.isArray(mixed.__rangeStyles) && mixed.__rangeStyles.length >= 4,
    "mixed typography пережила destructive base-style binding и применена последней");
  ok(mixed.__rangeStyles.some(function (item) { return item.field === "fontSize" && item.start === 0 && item.end === 2 && item.value === 20; }),
    "первый range fontSize применён к точному диапазону");
  ok(mixed.__rangeStyles.some(function (item) { return item.field === "textDecoration" && item.start === 3 && item.end === 4 && item.value === "UNDERLINE"; }),
    "второй range decoration применён к точному диапазону");
  ok(mixed.__rangeStyles.some(function (item) { return item.field === "fills" && item.start === 0 && item.end === 2; }),
    "range fill применён ПОСЛЕ node-level fill style и не затёрт им");

  // --- порядок присваиваний ------------------------------------------------
  //
  // Это и есть механизм: в Figma `textAutoResize` фиксирует ТЕКУЩИЙ габарит
  // узла, а `maxLines` действует только при включённом `textTruncation`.
  // Перестановка любого из двух шагов даёт другой результат в редакторе, и
  // проверить её можно только по журналу присваиваний — измерять текст
  // двойник не умеет.
  ok(writeIndex(ellipsis, "characters") >= 0, "символы присвоены");
  ok(writeIndex(ellipsis, "characters") < writeIndex(ellipsis, "textAutoResize"),
    "режим авторазмера назначен ПОСЛЕ символов");
  ok(writeIndex(ellipsis, "textTruncation") >= 0, "обрезание присвоено");
  ok(writeIndex(ellipsis, "characters") < writeIndex(ellipsis, "textTruncation"),
    "обрезание назначено ПОСЛЕ символов");
  ok(writeIndex(ellipsis, "textTruncation") < writeIndex(ellipsis, "maxLines"),
    "предел строк назначен ПОСЛЕ обрезания: раньше него он не действует");
  ok(writeIndex(silent, "textAutoResize") >= 0,
    "узел без поля в источнике всё равно получает явный режим");
}

check().then(function () {
  process.stdout.write("OK: Direct PIX семантика размера текста — " + checks + " проверок пройдено\n");
}).catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  process.exit(1);
});
