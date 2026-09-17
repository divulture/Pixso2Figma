/**
 * Direct PIX: восстановление общих стилей Pixso нативными стилями Figma.
 *
 *   node DirectPix/Tests/StyleReconstructionTest.js
 *
 * Проверяется сторона отправителя: что попадает в IR и по каким правилам.
 * Ни одного байта настоящего документа здесь нет — сцена собирается в память
 * вместе со схемой Kiwi, как и в остальных тестах Direct PIX.
 *
 * Утверждения, которые тест обязан удержать:
 *
 *   1. два узла с одной ссылкой на TEXT-стиль → один TextStyle и две привязки;
 *   2. одинаковая типографика при РАЗНОЙ идентичности источника → два стиля;
 *   3. TEXT- и FILL-стиль на одном текстовом узле остаются разными связями;
 *   4. два узла с одной ссылкой на FILL-стиль → один PaintStyle;
 *   5. EFFECT-стиль переиспользуется так же;
 *   6. ссылка в никуда → сырой fallback и счётчик, без падения;
 *   7. стиль, из которого ничего не отобразилось → fallback и счётчик;
 *   8. местное значение узла, расходящееся со стилем, ОТМЕНЯЕТ привязку;
 *   9. узел со стилем и без собственных красок не остаётся невидимым;
 *  10. копии одного стиля с разными guid дают ОДИН стиль Figma;
 *  11. одинаковые имена у разных `styleKey` не склеиваются;
 *  12. реестр одной миграции не протекает в другую.
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
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var guid = Fixture.guid;

function transform(x, y) { return { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y }; }
function color(r, g, b, a) { return { r: r, g: g, b: b, a: a === undefined ? 255 : a }; }
function solid(r, g, b) { return { type: "SOLID", color: color(r, g, b), visible: true, blendMode: "NORMAL" }; }
function shared(key, version) { return { styleKey: key, versionHash: version || "1:1" }; }

/**
 * Сцена стилей.
 *
 * Библиотечное полотно держит определения стилей ровно так же, как настоящий
 * документ: обычные узлы с заполненным `styleType` и `sharedStyleReference`.
 * Экран держит потребителей.
 */
function buildStyleScene() {
  var nodes = [];
  function node(spec) { nodes.push(spec); return spec; }

  node({ guid: guid("2:1"), type: "DOCUMENT", name: "Документ" });
  node({ guid: guid("2:2"), type: "CANVAS", name: "Библиотека", internalOnly: true,
    parentIndex: { guid: guid("2:1"), position: "a" } });
  node({ guid: guid("2:3"), type: "CANVAS", name: "Экран",
    parentIndex: { guid: guid("2:1"), position: "b" } });

  // --- определения стилей -------------------------------------------------
  // FILL «accent», две копии с РАЗНЫМИ guid и одним styleKey: так устроен
  // настоящий документ, и обе копии обязаны дать один стиль Figma.
  node({ guid: guid("2:10"), type: "RECTANGLE", name: "brand/accent", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "a" },
    sharedStyleReference: shared("key-accent", "3:1"), fillPaints: [solid(0, 85, 255)] });
  node({ guid: guid("2:11"), type: "RECTANGLE", name: "brand/accent", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "b" },
    sharedStyleReference: shared("key-accent", "9:7"), fillPaints: [solid(0, 85, 255)] });

  // FILL с ТЕМ ЖЕ именем, но другой идентичностью источника: склейка по имени
  // потеряла бы один из двух стилей.
  node({ guid: guid("2:12"), type: "RECTANGLE", name: "brand/accent", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "c" },
    sharedStyleReference: shared("key-accent-legacy"), fillPaints: [solid(10, 90, 250)] });

  node({ guid: guid("2:13"), type: "RECTANGLE", name: "brand/surface", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "d" },
    sharedStyleReference: shared("key-surface"), fillPaints: [solid(250, 250, 250)] });

  // Стиль, из которого ничего не отображается: единственная краска скрыта.
  node({ guid: guid("2:14"), type: "RECTANGLE", name: "brand/hidden", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "e" },
    sharedStyleReference: shared("key-hidden"),
    fillPaints: [{ type: "SOLID", color: color(1, 2, 3), visible: false, blendMode: "NORMAL" }] });

  // TEXT-стили: два разных styleKey с ОДИНАКОВОЙ типографикой.
  node({ guid: guid("2:20"), type: "TEXT", name: "web/body/m", styleType: "TEXT",
    parentIndex: { guid: guid("2:2"), position: "f" },
    sharedStyleReference: shared("key-body-m"), styleDescription: "Основной текст",
    fontName: { family: "Inter", style: "Medium" },
    textData: { characters: "Aa", characterStyleIDs: [0, 0], styleOverrideTable: [],
      glyphs: [{ styleID: 0, fontSize: 16, firstCharacter: 0 },
        { styleID: 0, fontSize: 16, firstCharacter: 1 }] },
    lineHeight: { value: 24, units: "PIXELS" } });
  node({ guid: guid("2:21"), type: "TEXT", name: "print/body/m", styleType: "TEXT",
    parentIndex: { guid: guid("2:2"), position: "g" },
    sharedStyleReference: shared("key-body-m-print"),
    fontName: { family: "Inter", style: "Medium" }, fontSize: 16,
    textData: { characters: "Aa", characterStyleIDs: [0, 0], styleOverrideTable: [],
      glyphs: [{ styleID: 0, fontSize: 12, firstCharacter: 0 },
        { styleID: 0, fontSize: 12, firstCharacter: 1 }] },
    lineHeight: { value: 24, units: "PIXELS" } });

  // Неоднозначные glyphs не имеют права создать TextStyle с default Figma.
  node({ guid: guid("2:22"), type: "TEXT", name: "web/body/mixed", styleType: "TEXT",
    parentIndex: { guid: guid("2:2"), position: "ga" },
    sharedStyleReference: shared("key-body-mixed"),
    fontName: { family: "Inter", style: "Medium" },
    textData: { characters: "Aa", characterStyleIDs: [0, 0], styleOverrideTable: [],
      glyphs: [{ styleID: 0, fontSize: 14, firstCharacter: 0 },
        { styleID: 0, fontSize: 16, firstCharacter: 1 }] },
    lineHeight: { value: 24, units: "PIXELS" } });

  // EFFECT-стиль.
  node({ guid: guid("2:30"), type: "RECTANGLE", name: "shadow/m", styleType: "EFFECT",
    parentIndex: { guid: guid("2:2"), position: "h" },
    sharedStyleReference: shared("key-shadow-m"),
    effects: [{ type: "DROP_SHADOW", color: color(0, 0, 0, 64), offset: { x: 0, y: 4 },
      radius: 8, visible: true, blendMode: "NORMAL", spread: 0 }] });

  // GRID-стиль: объекта такого рода у Figma нет. Он обязан быть посчитан, а не
  // молча пропущен, и не имеет права задержать остальные.
  node({ guid: guid("2:31"), type: "FRAME", name: "Icon Grid", styleType: "GRID",
    parentIndex: { guid: guid("2:2"), position: "i" },
    sharedStyleReference: shared("key-grid") });

  // --- потребители --------------------------------------------------------
  node({ guid: guid("2:100"), type: "FRAME", name: "Экран",
    parentIndex: { guid: guid("2:3"), position: "a" },
    transform: transform(0, 0), size: { x: 400, y: 400 } });

  // (1) и (4): две карточки на одном FILL-стиле — но через РАЗНЫЕ узлы-копии.
  node({ guid: guid("2:101"), type: "RECTANGLE", name: "Карточка A",
    parentIndex: { guid: guid("2:100"), position: "a" },
    transform: transform(0, 0), size: { x: 100, y: 40 },
    fillPaints: [solid(0, 85, 255)], inheritFillStyleID: guid("2:10") });
  node({ guid: guid("2:102"), type: "RECTANGLE", name: "Карточка B",
    parentIndex: { guid: guid("2:100"), position: "b" },
    transform: transform(0, 50), size: { x: 100, y: 40 },
    fillPaints: [solid(0, 85, 255)], inheritFillStyleID: guid("2:11") });

  // (11) третья карточка на одноимённом, но другом стиле.
  node({ guid: guid("2:103"), type: "RECTANGLE", name: "Карточка legacy",
    parentIndex: { guid: guid("2:100"), position: "c" },
    transform: transform(0, 100), size: { x: 100, y: 40 },
    fillPaints: [solid(10, 90, 250)], inheritFillStyleID: guid("2:12") });

  // (3) текст с ОБЕИМИ ссылками: типографика и цвет — разные объекты.
  node({ guid: guid("2:104"), type: "TEXT", name: "Заголовок",
    parentIndex: { guid: guid("2:100"), position: "d" },
    transform: transform(0, 150), size: { x: 200, y: 24 },
    textData: { characters: "Привет" },
    fontName: { family: "Inter", style: "Medium" }, fontSize: 16,
    lineHeight: { value: 24, units: "PIXELS" },
    fillPaints: [solid(250, 250, 250)],
    inheritTextStyleID: guid("2:20"), inheritFillStyleID: guid("2:13") });

  // (1) второй текст того же стиля, БЕЗ собственного fontSize: размер обязан
  // прийти из стиля, а привязка — состояться.
  node({ guid: guid("2:105"), type: "TEXT", name: "Подзаголовок",
    parentIndex: { guid: guid("2:100"), position: "e" },
    transform: transform(0, 180), size: { x: 200, y: 24 },
    textData: { characters: "Мир" },
    fontName: { family: "Inter", style: "Medium" },
    lineHeight: { value: 24, units: "PIXELS" },
    inheritTextStyleID: guid("2:20") });

  // (2) текст с той же типографикой, но другой идентичностью источника.
  node({ guid: guid("2:106"), type: "TEXT", name: "Печатный",
    parentIndex: { guid: guid("2:100"), position: "f" },
    transform: transform(0, 210), size: { x: 200, y: 24 },
    textData: { characters: "Печать" },
    fontName: { family: "Inter", style: "Medium" }, fontSize: 16,
    lineHeight: { value: 24, units: "PIXELS" },
    inheritTextStyleID: guid("2:21") });

  // (8) текст того же стиля, но со СВОИМ размером: привязка обязана
  // отмениться, иначе стиль перебил бы 11.2 на 16.
  node({ guid: guid("2:107"), type: "TEXT", name: "Отступивший",
    parentIndex: { guid: guid("2:100"), position: "g" },
    transform: transform(0, 240), size: { x: 200, y: 24 },
    textData: { characters: "Мельче" },
    fontName: { family: "Inter", style: "Medium" }, fontSize: 11.2,
    lineHeight: { value: 24, units: "PIXELS" },
    inheritTextStyleID: guid("2:20") });

  // (5) две плашки на одном EFFECT-стиле.
  node({ guid: guid("2:108"), type: "RECTANGLE", name: "Тень A",
    parentIndex: { guid: guid("2:100"), position: "h" },
    transform: transform(0, 270), size: { x: 100, y: 40 },
    inheritEffectStyleID: guid("2:30"),
    effects: [{ type: "DROP_SHADOW", color: color(0, 0, 0, 64), offset: { x: 0, y: 4 },
      radius: 8, visible: true, blendMode: "NORMAL", spread: 0 }] });
  // (9) та же тень, но БЕЗ собственного списка эффектов: значение целиком
  // живёт в стиле. Пустым (невидимым) узел стать не имеет права.
  node({ guid: guid("2:109"), type: "RECTANGLE", name: "Тень B",
    parentIndex: { guid: guid("2:100"), position: "i" },
    transform: transform(0, 320), size: { x: 100, y: 40 },
    inheritEffectStyleID: guid("2:30") });

  // (6) ссылка в никуда: такого узла в документе нет.
  node({ guid: guid("2:110"), type: "RECTANGLE", name: "Осиротевшая",
    parentIndex: { guid: guid("2:100"), position: "j" },
    transform: transform(120, 0), size: { x: 100, y: 40 },
    fillPaints: [solid(7, 7, 7)], inheritFillStyleID: guid("2:999") });

  // (7) ссылка на стиль, из которого ничего не отобразилось.
  node({ guid: guid("2:111"), type: "RECTANGLE", name: "Пустой стиль",
    parentIndex: { guid: guid("2:100"), position: "k" },
    transform: transform(120, 50), size: { x: 100, y: 40 },
    fillPaints: [solid(8, 8, 8)], inheritFillStyleID: guid("2:14") });

  // (8) заливка, расходящаяся со своим стилем: местное значение выигрывает.
  node({ guid: guid("2:112"), type: "RECTANGLE", name: "Перекрашенная",
    parentIndex: { guid: guid("2:100"), position: "l" },
    transform: transform(120, 100), size: { x: 100, y: 40 },
    fillPaints: [solid(200, 0, 0)], inheritFillStyleID: guid("2:10") });

  // GRID-стиль на потребителе.
  node({ guid: guid("2:113"), type: "FRAME", name: "Сетка",
    parentIndex: { guid: guid("2:100"), position: "m" },
    transform: transform(120, 150), size: { x: 100, y: 40 },
    inheritGridStyleID: guid("2:31") });

  node({ guid: guid("2:114"), type: "TEXT", name: "Неоднозначный style fallback",
    parentIndex: { guid: guid("2:100"), position: "n" },
    transform: transform(120, 200), size: { x: 100, y: 24 },
    textData: { characters: "Raw" },
    fontName: { family: "Inter", style: "Medium" }, fontSize: 17,
    lineHeight: { value: 24, units: "PIXELS" }, inheritTextStyleID: guid("2:22") });

  // (10) собственный размер расходится со стилем, но глифы — то, что Pixso
  // отрисовал, — совпадают со стилем: собственные поля устарели.
  node({ guid: guid("2:115"), type: "TEXT", name: "Устаревший кэш",
    parentIndex: { guid: guid("2:100"), position: "o" },
    transform: transform(240, 0), size: { x: 60, y: 24 },
    textData: { characters: "Aa", characterStyleIDs: [0, 0], styleOverrideTable: [],
      glyphs: [{ styleID: 0, fontSize: 16, firstCharacter: 0 },
        { styleID: 0, fontSize: 16, firstCharacter: 1 }] },
    fontName: { family: "Inter", style: "Medium" }, fontSize: 12,
    lineHeight: { value: 16, units: "PIXELS" }, inheritTextStyleID: guid("2:20") });
  // (11) то же расхождение, но глифы совпадают с собственным размером:
  // настоящая местная правка.
  node({ guid: guid("2:116"), type: "TEXT", name: "Местная правка по глифам",
    parentIndex: { guid: guid("2:100"), position: "p" },
    transform: transform(240, 40), size: { x: 60, y: 16 },
    textData: { characters: "Aa", characterStyleIDs: [0, 0], styleOverrideTable: [],
      glyphs: [{ styleID: 0, fontSize: 12, firstCharacter: 0 },
        { styleID: 0, fontSize: 12, firstCharacter: 1 }] },
    fontName: { family: "Inter", style: "Medium" }, fontSize: 12,
    lineHeight: { value: 16, units: "PIXELS" }, inheritTextStyleID: guid("2:20") });

  return { nodes: nodes, blobs: [], resources: [], ids: { screenRoot: "2:100" } };
}

/** Собирает контейнер во временном файле: `PixContainer` читает с диска. */
function loadScene(build) {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-styles-"));
  try {
    var file = path.join(temp, "scene.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: build || buildStyleScene() }).zip);
    return PixDocument.load(PixContainer.open(file));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function buildIR(doc, options) {
  var root = doc.tree.byKey.get("2:100");
  return MigrationIR.build(doc, Object.assign({ roots: [root] }, options || {}));
}

function nodeById(ir, id) {
  var nodes = ir.roots[0].nodes;
  for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
  return null;
}

function styleById(ir, styleId) {
  for (var i = 0; i < ir.styles.length; i++) if (ir.styles[i].styleId === styleId) return ir.styles[i];
  return null;
}

// ---------------------------------------------------------------------------

var doc = loadScene();
var ir = buildIR(doc);

// --- (4) и (10): одна идентичность источника — один PaintStyle -------------
var cardA = nodeById(ir, "2:101");
var cardB = nodeById(ir, "2:102");
ok(cardA && cardA.styles && cardA.styles.fill, "карточка A привязана к PaintStyle");
ok(cardB && cardB.styles && cardB.styles.fill, "карточка B привязана к PaintStyle");
eq(cardB.styles.fill, cardA.styles.fill,
  "две КОПИИ одного стиля источника (разные guid, один styleKey) дают один стиль Figma");
eq(styleById(ir, cardA.styles.fill).name, "brand/accent", "имя стиля взято из источника");

// --- (11) одинаковое имя, другая идентичность → другой стиль ---------------
var legacy = nodeById(ir, "2:103");
ok(legacy.styles && legacy.styles.fill, "legacy-карточка тоже привязана");
ok(legacy.styles.fill !== cardA.styles.fill,
  "одноимённые стили с разными styleKey НЕ склеиваются");
eq(styleById(ir, legacy.styles.fill).name, "brand/accent", "имя воспроизводится как есть");
eq(ir.styleReport.nameCollisions, 1, "коллизия имён посчитана, а не спрятана");

// --- (1) и (3): TEXT и FILL на одном узле — разные связи -------------------
var heading = nodeById(ir, "2:104");
ok(heading.styles && heading.styles.text, "заголовок привязан к TextStyle");
ok(heading.styles && heading.styles.fill, "заголовок привязан к PaintStyle заливки");
ok(heading.styles.text !== heading.styles.fill, "типографика и цвет — разные стили");
eq(styleById(ir, heading.styles.text).styleType, "TEXT", "TextStyle отдан текстовым типом");
eq(styleById(ir, heading.styles.fill).styleType, "PAINT", "заливка отдана PaintStyle");
eq(styleById(ir, heading.styles.text).description, "Основной текст",
  "описание стиля источника перенесено");

var subheading = nodeById(ir, "2:105");
eq(subheading.styles.text, heading.styles.text,
  "два узла на одном TEXT-стиле дают один TextStyle");

// TextStyle несёт только то, чем в Figma управляет сам стиль.
var textStyle = styleById(ir, heading.styles.text);
eq(JSON.stringify(Object.keys(textStyle.text).sort()),
  JSON.stringify(["fontName", "fontSize", "lineHeight"]),
  "TextStyle не забирает выравнивание, авторазмер и заливку");
eq(textStyle.text.fontSize, 16,
  "absent top-level fontSize восстановлен из одинаковых source glyphs");

// --- (9) значение целиком из стиля: узел не остаётся без него --------------
eq(subheading.text.fontSize, 16,
  "размер унаследован из TEXT-стиля: отсутствие поля — не значение по умолчанию");
var shadowB = nodeById(ir, "2:109");
ok(shadowB.effects && shadowB.effects.length === 1,
  "узел без собственных эффектов получает их из стиля, а не остаётся пустым");
eq(shadowB.styles.effect, nodeById(ir, "2:108").styles.effect,
  "(5) один EFFECT-стиль на два узла");

// --- (2) одинаковая типографика при разной идентичности → разные стили -----
var printed = nodeById(ir, "2:106");
ok(printed.styles && printed.styles.text, "печатный текст привязан");
ok(printed.styles.text !== heading.styles.text,
  "совпадение значений НЕ склеивает стили с разной идентичностью источника");
eq(styleById(ir, printed.styles.text).text.fontSize, 16,
  "явный top-level fontSize выиграл у противоречащих glyphs");

var staleCache = nodeById(ir, "2:115");
eq(staleCache.text.fontSize, 16, "(10) глифы доказали стиль: устаревший собственный размер не перенесён");
eq(staleCache.text.lineHeight.value, 24, "(10) межстрочный интервал тоже взят из стиля");
eq(staleCache.styles && staleCache.styles.text, heading.styles.text, "(10) узел привязан к своему стилю");
eq(ir.stats.textOwnTypographyStale, 1, "(10) устаревшая типографика посчитана");
var glyphLocal = nodeById(ir, "2:116");
eq(glyphLocal.text.fontSize, 12, "(11) глифы подтвердили местный размер");
ok(!glyphLocal.styles || !glyphLocal.styles.text, "(11) местная правка по глифам не привязана к стилю");

var ambiguous = nodeById(ir, "2:114");
eq(ambiguous.text.fontSize, 17,
  "mixed glyph style оставил raw fontSize consumer нетронутым");
ok(!ambiguous.styles || !ambiguous.styles.text,
  "mixed glyph style не привязан к TextStyle с default Figma");
eq(ir.styleReport.unresolvedByReason.TEXT_FONT_SIZE_UNRESOLVED, 1,
  "mixed glyph fontSize посчитан как unresolved");
eq(ir.styleReport.textStyleFontSize.glyphUniform, 1,
  "uniform glyph fallback посчитан");
eq(ir.styleReport.textStyleFontSize.topLevel, 1,
  "top-level fontSize посчитан");
eq(ir.styleReport.textStyleFontSize.glyphAmbiguous, 1,
  "ambiguous glyph fontSize посчитан");

// --- (8) местное значение выигрывает у стиля ------------------------------
var smaller = nodeById(ir, "2:107");
eq(smaller.text.fontSize, 11.2, "собственный размер узла сохранён");
ok(!smaller.styles || !smaller.styles.text,
  "узел со своей типографикой к TextStyle не привязан: привязка перебила бы размер");
var repainted = nodeById(ir, "2:112");
eq(JSON.stringify(repainted.fills[0].color), JSON.stringify({ r: 0.78431, g: 0, b: 0 }),
  "собственная заливка узла сохранена");
ok(!repainted.styles || !repainted.styles.fill,
  "узел со своей заливкой к PaintStyle не привязан");
eq(ir.styleReport.bindingsSkippedByReason.LOCAL_VALUE_WINS, 3,
  "все три отменённые привязки (8, заливка, 11) посчитаны с причиной");

// --- (6) и (7) ссылка без цели и пустой стиль ------------------------------
var orphan = nodeById(ir, "2:110");
ok(orphan, "узел с недостижимой ссылкой на стиль всё равно построен");
eq(JSON.stringify(orphan.fills[0].color), JSON.stringify({ r: 0.02745, g: 0.02745, b: 0.02745 }),
  "у него остались собственные краски — fallback, а не потеря");
ok(!orphan.styles, "привязки у него нет");
eq(ir.styleReport.unresolvedByReason.DEFINITION_NOT_FOUND, 1,
  "недостижимая ссылка посчитана отдельной причиной");

var emptyStyled = nodeById(ir, "2:111");
ok(!emptyStyled.styles, "стиль без отображаемого значения привязки не даёт");
ok(emptyStyled.fills && emptyStyled.fills.length === 1, "сырые краски узла на месте");
eq(ir.styleReport.unresolvedByReason.STYLE_EMPTY, 1, "пустой стиль посчитан своей причиной");

// --- GRID: считается, но стиля не создаёт ---------------------------------
eq(ir.styleReport.definitionsUnsupported.GRID, 1,
  "GRID-стиль посчитан как определение без цели в Figma");
ir.styles.forEach(function (style) {
  ok(style.styleType !== "GRID", "GRID в пакет стилей не попадает");
});

// --- сводка ---------------------------------------------------------------
eq(ir.styles.length, 6,
  "шесть нативных стилей: accent, accent-legacy, surface, body/m, body/m-print, shadow/m — " +
  "ни одного лишнего и ни одного потерянного");

function countEmitted(type) {
  return ir.styles.filter(function (style) { return style.styleType === type; }).length;
}
eq(countEmitted("PAINT"), 3, "три PaintStyle");
eq(countEmitted("TEXT"), 2, "два TextStyle");
eq(countEmitted("EFFECT"), 1, "один EffectStyle");

eq(ir.styleReport.nodeBindings.fill, 4, "четыре привязки заливки");
eq(ir.styleReport.nodeBindings.text, 4, "четыре привязки типографики, включая (10)");
eq(ir.styleReport.nodeBindings.effect, 2, "две привязки эффекта");

// Дедупликация видна в самих счётчиках: узлов-определений больше, чем стилей.
ok(ir.styleReport.sourceStyleNodesSeen > ir.styles.length,
  "узлов-определений стиля больше, чем созданных стилей: копии схлопнуты");

// --- (12) изоляция реестров между миграциями ------------------------------
var registryA = MigrationIR.createRegistry();
var docA = loadScene();
var firstA = MigrationIR.build(docA, { roots: [docA.tree.byKey.get("2:100")], registry: registryA });
var secondA = MigrationIR.build(docA, { roots: [docA.tree.byKey.get("2:100")], registry: registryA });
ok(firstA.styles.length > 0, "первая сборка job везёт описания стилей");
eq(secondA.styles.length, 0,
  "вторая сборка ТОГО ЖЕ job описаний не дублирует: стиль уезжает один раз");
eq(nodeById(secondA, "2:101").styles.fill, nodeById(firstA, "2:101").styles.fill,
  "но привязка на тот же стиль сохраняется");

var registryB = MigrationIR.createRegistry();
var docB = loadScene();
var firstB = MigrationIR.build(docB, { roots: [docB.tree.byKey.get("2:100")], registry: registryB });
eq(firstB.styles.length, firstA.styles.length,
  "чужая миграция везёт свои описания целиком: реестр не протёк");

// Разные документы с ОДИНАКОВЫМ содержимым дают одинаковые styleId. Это не
// склейка через реестр, а свойство детерминированной идентичности: id
// вычисляется из источника, а не из счётчика сессии.
eq(nodeById(firstB, "2:101").styles.fill, nodeById(firstA, "2:101").styles.fill,
  "styleId детерминирован и воспроизводим");

// ---------------------------------------------------------------------------
// Привязки на записях override
// ---------------------------------------------------------------------------

/**
 * Сцена с компонентом: вхождение переопределяет заливку своего текста —
 * один раз ссылкой на стиль, другой раз собственной краской.
 */
function buildOverrideScene() {
  var nodes = [];
  function node(spec) { nodes.push(spec); return spec; }

  node({ guid: guid("2:1"), type: "DOCUMENT", name: "Документ" });
  node({ guid: guid("2:2"), type: "CANVAS", name: "Библиотека", internalOnly: true,
    parentIndex: { guid: guid("2:1"), position: "a" } });
  node({ guid: guid("2:3"), type: "CANVAS", name: "Экран",
    parentIndex: { guid: guid("2:1"), position: "b" } });

  node({ guid: guid("2:10"), type: "RECTANGLE", name: "brand/accent", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "a" },
    sharedStyleReference: shared("key-accent"), fillPaints: [solid(0, 85, 255)] });
  node({ guid: guid("2:11"), type: "RECTANGLE", name: "brand/danger", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "b" },
    sharedStyleReference: shared("key-danger"), fillPaints: [solid(255, 0, 0)] });

  node({ guid: guid("2:20"), type: "SYMBOL", name: "Кнопка", componentKey: "key-button",
    parentIndex: { guid: guid("2:2"), position: "c" },
    transform: transform(0, 0), size: { x: 120, y: 40 } });
  node({ guid: guid("2:21"), type: "RECTANGLE", name: "Фон",
    parentIndex: { guid: guid("2:20"), position: "a" },
    transform: transform(0, 0), size: { x: 120, y: 40 },
    fillPaints: [solid(0, 85, 255)], inheritFillStyleID: guid("2:10") });

  node({ guid: guid("2:100"), type: "FRAME", name: "Экран",
    parentIndex: { guid: guid("2:3"), position: "a" },
    transform: transform(0, 0), size: { x: 400, y: 200 } });

  // Вхождение переопределяет фон ссылкой на ДРУГОЙ стиль.
  node({ guid: guid("2:101"), type: "INSTANCE", name: "Кнопка опасная",
    parentIndex: { guid: guid("2:100"), position: "a" },
    transform: transform(0, 0), size: { x: 120, y: 40 },
    symbolData: { symbolID: guid("2:20"), symbolOverrides: [
      { guidPath: { guids: [guid("2:21")] }, inheritFillStyleID: guid("2:11") },
    ] } });

  // Вхождение переопределяет фон СОБСТВЕННОЙ краской, не совпадающей ни с
  // одним стилем: привязка обязана не появиться.
  node({ guid: guid("2:102"), type: "INSTANCE", name: "Кнопка своя",
    parentIndex: { guid: guid("2:100"), position: "b" },
    transform: transform(0, 60), size: { x: 120, y: 40 },
    symbolData: { symbolID: guid("2:20"), symbolOverrides: [
      { guidPath: { guids: [guid("2:21")] }, fillPaints: [solid(30, 30, 30)] },
    ] } });

  // Вхождение с пустым `fillPaints` — заглушкой сериализатора Pixso. Она НЕ
  // означает «снять заливку» и не имеет права снять привязку определения.
  node({ guid: guid("2:103"), type: "INSTANCE", name: "Кнопка обычная",
    parentIndex: { guid: guid("2:100"), position: "c" },
    transform: transform(0, 120), size: { x: 120, y: 40 },
    symbolData: { symbolID: guid("2:20"), symbolOverrides: [
      { guidPath: { guids: [guid("2:21")] }, fillPaints: [] },
    ] } });

  return { nodes: nodes, blobs: [], resources: [], ids: { screenRoot: "2:100" } };
}

var overrideDoc = loadScene(buildOverrideScene());
var overrideIr = buildIR(overrideDoc);

var definition = overrideIr.definitions[0];
ok(definition, "определение кнопки собрано");
var definitionBackground = definition.nodes.filter(function (node) { return node.id === "2:21"; })[0];
ok(definitionBackground.styles && definitionBackground.styles.fill,
  "узел ВНУТРИ определения тоже привязан к стилю");

function occurrenceOps(id) {
  var occurrence = nodeById(overrideIr, id);
  var entries = occurrence.overrides || [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].ops && Object.keys(entries[i].ops).length) return entries[i];
  }
  return null;
}

var dangerous = occurrenceOps("2:101");
ok(dangerous, "правка со ссылкой на другой стиль доехала до IR");
ok(dangerous.ops.fills && dangerous.ops.fills.length,
  "краски правки взяты из стиля: у записи своих красок нет");
ok(dangerous.ops.fillStyleId, "правка несёт и привязку к нативному стилю");
eq(dangerous.present.fillStyleId, true, "привязка снабжена доказательством присутствия");
ok(dangerous.ops.fillStyleId !== definitionBackground.styles.fill,
  "правка привязывает к ДРУГОМУ стилю, чем определение");

var own = occurrenceOps("2:102");
ok(own && own.ops.fills, "собственная краска вхождения доехала");
ok(!own.ops.fillStyleId,
  "собственная краска вхождения привязку не получает: стиль стёр бы её");

var plain = occurrenceOps("2:103");
ok(!plain || !plain.ops.fills,
  "пустой repeated-список остаётся заглушкой и операции не создаёт");
ok(!plain || !plain.ops.fillStyleId,
  "и привязки на пустой заглушке тоже нет: узел остаётся со стилем определения");
eq(overrideIr.stats.paintDefaultArrayIgnored, 1,
  "заглушка распознана и посчитана, а не применена");

eq(overrideIr.styleReport.overrideBindings.fill, 1, "ровно одна привязка от записи override");

process.stdout.write("StyleReconstructionTest: " + checks + " проверок пройдено\n");
