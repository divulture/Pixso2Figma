/**
 * Поля записи `symbolOverrides[]`, которые Direct PIX обязан переносить.
 *
 * Состав проверяемого набора взят из приложенных спецификаций PIX/FIG: они
 * перечисляют среди полей override углы, эффекты и `styleIdForEffect`,
 * параметры auto layout, constraints, обводку с независимыми толщинами и
 * типографику. До этого теста половина списка молча падала в счётчик
 * «неизвестное поле», а вхождение оставалось похожим на определение вместо
 * своего фактического вида.
 *
 * Отдельно фиксируется то, что переносить отказались: `stackChild*Sizing`
 * не документирован ни одной спецификацией и не имеет доказуемого
 * соответствия в Figma, поэтому он обязан быть НАЗВАННОЙ причиной, а не
 * общим промахом.
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

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function deepEq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }

var ids = {
  document: "8:1", library: "8:2", page: "8:3", root: "8:4",
  symbol: "8:10", box: "8:11", label: "8:12",
  effectStyle: "8:20", textStyle: "8:21",
  occurrence: "8:30",
};

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  // Служебное полотно: символ и стили живут именно там — ровно так, как это
  // описывают обе спецификации.
  { guid: guid(ids.library), type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },

  {
    guid: guid(ids.effectStyle), type: "FRAME", name: "Shadow style", styleType: "EFFECT",
    parentIndex: parent(ids.library, "a"), transform: matrix(), size: { x: 1, y: 1 },
    effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true }],
  },
  {
    guid: guid(ids.textStyle), type: "TEXT", name: "Caption style", styleType: "TEXT",
    parentIndex: parent(ids.library, "b"), transform: matrix(), size: { x: 1, y: 1 },
    fontSize: 11, textCase: "UPPER", paragraphSpacing: 3,
  },

  {
    guid: guid(ids.symbol), type: "SYMBOL", name: "Card", componentKey: "card",
    parentIndex: parent(ids.library, "c"), transform: matrix(), size: { x: 100, y: 60 },
    // Признак символа служебного полотна из спецификаций: путь до корня
    // документа, из которого символ вынесен.
    ancestorPathBeforeDeletion: [guid(ids.document)],
    stackMode: "VERTICAL", stackSpacing: 4, stackPaddingLeft: 8, stackPaddingRight: 8,
    // Обе оси объявлены, и обе ПРОТИВОПОЛОЖНЫ тому, что говорит запись
    // вхождения ниже. Это условие теста, а не украшение: запись override —
    // полный `PixsoNode`, и её поле sizing переносится только тогда, когда
    // оно доказуемо отличается от состояния определения. Совпадающее
    // значение — эхо, и проверять на нём отображение имён нечего.
    stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT",
  },
  {
    guid: guid(ids.box), type: "RECTANGLE", name: "Box", parentIndex: parent(ids.symbol, "a"),
    transform: matrix(), size: { x: 100, y: 30 }, cornerRadius: 2,
    strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }], strokeWeight: 1,
  },
  {
    guid: guid(ids.label), type: "TEXT", name: "Label", parentIndex: parent(ids.symbol, "b"),
    transform: matrix(0, 30), size: { x: 100, y: 20 },
    textData: { characters: "Card" }, fontSize: 14,
  },

  { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 200 } },
  {
    guid: guid(ids.occurrence), type: "INSTANCE", name: "Card occurrence",
    // Коробка вхождения по главной оси раскладки (у VERTICAL это высота) от
    // коробки определения отличается: HUG в записи — настоящая правка, а не
    // снимок уже действующего состояния.
    parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 100, y: 84 },
    symbolData: {
      symbolID: guid(ids.symbol),
      symbolOverrides: [
        // Корень вхождения: auto layout, constraints, эффект по стилю.
        {
          guidPath: { guids: [] },
          stackSpacing: 12, stackPaddingLeft: 16, stackPaddingRight: 16,
          stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
          stackPrimaryAlignItems: "CENTER",
          horizontalConstraint: "STRETCH", verticalConstraint: "MIN",
          inheritEffectStyleID: guid(ids.effectStyle),
          frameMaskDisabled: true,
        },
        // Прямоугольник: независимые углы и оформление обводки.
        {
          guidPath: { guids: [guid(ids.box)] },
          rectangleCornerToolIndependent: true,
          rectangleTopLeftCornerRadius: 9, rectangleTopRightCornerRadius: 9,
          rectangleBottomLeftCornerRadius: 0, rectangleBottomRightCornerRadius: 0,
          strokeAlign: "OUTSIDE", strokeJoin: "BEVEL",
          // Некоторые PIX-файлы несут сами side weights без отдельного
          // independent-флага. Presence полей должна быть достаточной.
          borderTopWeight: 2, borderRightWeight: 0, borderBottomWeight: 2, borderLeftWeight: 0,
          autoLayoutAbsolutePos: true,
        },
        // Текст: типографика вхождения плюс текстовый стиль.
        {
          guidPath: { guids: [guid(ids.label)] },
          fontSize: 18, textDecoration: "UNDERLINE",
          letterSpacing: { value: 2, units: "PIXELS" },
          inheritTextStyleID: guid(ids.textStyle),
          textData: { characters: "Overridden" },
        },
        // Поле без доказуемого соответствия: обязано считаться поимённо.
        { guidPath: { guids: [guid(ids.box)] }, stackChildPrimarySizing: "RESIZE_TO_FIT" },
      ],
    },
  },
];

function run() {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-fields-"));
  try {
    var file = path.join(temp, "fields.pix");
    fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
    var doc = PixDocument.load(PixContainer.open(file));

    // --- Каноническая идентичность ------------------------------------
    var resolution = doc.symbols.resolveSymbol(doc.tree.byKey.get(ids.occurrence));
    ok(resolution.symbol, "вхождение нашло свой SYMBOL");
    eq(resolution.symbol.key, ids.symbol, "нашло именно тот, на который ссылается symbolData");
    eq(resolution.via, "INTERNAL_ONLY", "и знает, что символ лежит на служебном полотне");
    ok(doc.symbols.symbolsWithAncestorPath.has(ids.symbol),
      "ancestorPathBeforeDeletion прочитан и проиндексирован");
    deepEq(doc.tree.byKey.get(ids.symbol).ancestorPath, [ids.document],
      "путь нормализован в стабильные ключи");

    var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)] });
    eq(ir.stats.pixInstancesSeen, 1, "вхождение просмотрено");
    eq(ir.stats.canonicalResolved, 1, "идентичность разрешена");
    eq(ir.stats.canonicalUnresolved, 0, "промахов идентичности нет");
    eq(ir.stats.resolvedViaInternalOnly, 1, "и это разрешение через служебное полотно");

    var ordinaryRoot = ir.roots[0].nodes.filter(function (node) { return node.id === ids.root; })[0];
    ok(ordinaryRoot, "обычный FRAME попал в IR");
    eq(ordinaryRoot.clipsContent, true,
      "отсутствующий default frameMaskDisabled у собственного FRAME означает clipsContent=true");
    var definitionNode = ir.definitions.filter(function (definition) { return definition.definitionId === ids.symbol; })[0];
    ok(definitionNode, "определение компонента собрано");
    eq(definitionNode.nodes[0].clipsContent, true,
      "SYMBOL без сериализованного false-флага сохраняет Pixso clipping по умолчанию");

    var occurrence = ir.roots[0].nodes.filter(function (node) { return node.id === ids.occurrence; })[0];
    ok(occurrence, "вхождение попало в IR");

    function opsFor(depth, sourceId) {
      var entries = occurrence.overrides.filter(function (entry) {
        if (depth === 0) return entry.path.length === 0;
        return entry.path.length === 1 && entry.path[0].sourceId === sourceId;
      });
      eq(entries.length, 1, "цель адресована ровно одной записью IR: " + (sourceId || "корень"));
      return entries[0].ops;
    }

    // --- Корень вхождения ---------------------------------------------
    var rootOps = opsFor(0);
    ok(rootOps.layout, "auto layout вхождения перенесён");
    eq(rootOps.layout.itemSpacing, 12, "изменённый интервал доехал");
    eq(rootOps.layout.paddingLeft, 16, "и левый отступ");
    eq(rootOps.layout.paddingRight, 16, "и правый");
    eq(rootOps.layout.primaryAxisSizingMode, "AUTO", "RESIZE_TO_FIT главной оси — это AUTO");
    eq(rootOps.layout.counterAxisSizingMode, "FIXED", "FIXED поперечной оси — это FIXED");
    eq(rootOps.layout.primaryAxisAlignItems, "CENTER", "выравнивание по главной оси");
    ok(rootOps.constraints, "constraints вхождения перенесены");
    eq(rootOps.constraints.horizontal, "STRETCH", "горизонтальный constraint");
    eq(rootOps.constraints.vertical, "MIN", "вертикальный constraint");
    ok(rootOps.effects && rootOps.effects.length === 1, "эффект получен из стиля по styleIdForEffect");
    eq(rootOps.effects[0].type, "DROP_SHADOW", "тип эффекта переведён");
    eq(rootOps.clipsContent, false, "frameMaskDisabled → clipsContent = false");

    // --- Прямоугольник -------------------------------------------------
    var boxOps = opsFor(1, ids.box);
    ok(boxOps.corners, "углы перенесены");
    eq(boxOps.corners.independent, true,
      "rectangleCornerToolIndependent распознан как признак независимых углов");
    eq(boxOps.corners.topLeftRadius, 9, "верхний левый радиус");
    eq(boxOps.corners.bottomLeftRadius, 0, "нижний левый радиус");
    ok(boxOps.strokeStyle, "оформление обводки перенесено");
    eq(boxOps.strokeStyle.strokeAlign, "OUTSIDE", "выравнивание обводки");
    eq(boxOps.strokeStyle.strokeJoin, "BEVEL", "соединение обводки");
    ok(boxOps.strokeStyle.borderWeights, "side weights перенесены даже без independent-флага");
    eq(boxOps.strokeStyle.borderWeights.top, 2, "верхняя толщина");
    eq(boxOps.strokeStyle.borderWeights.right, 0, "правая толщина");
    ok(boxOps.childLayout, "поведение внутри auto layout перенесено");
    eq(boxOps.childLayout.layoutPositioning, "ABSOLUTE", "autoLayoutAbsolutePos → ABSOLUTE");

    // --- Текст ----------------------------------------------------------
    var labelOps = opsFor(1, ids.label);
    eq(labelOps.characters, "Overridden", "сам текст остался отдельной операцией");
    ok(labelOps.textStyle, "типографика вхождения перенесена");
    eq(labelOps.textStyle.fontSize, 18,
      "собственное значение вхождения сильнее значения текстового стиля");
    eq(labelOps.textStyle.textDecoration, "UNDERLINE", "подчёркивание");
    deepEq(labelOps.textStyle.letterSpacing, { value: 2, unit: "PIXELS" }, "трекинг с единицами");
    eq(labelOps.textStyle.textCase, "UPPER",
      "поле, которого нет у вхождения, взято из текстового стиля");
    eq(labelOps.textStyle.paragraphSpacing, 3, "и абзацный интервал из него же");

    // --- Sizing ребёнка внутри auto layout ------------------------------
    // `RESIZE_TO_FIT` у ребёнка означает «заполнить контейнер», и это измерено
    // на реальном документе, а не выведено из названия перечисления.
    eq(boxOps.childLayout.layoutGrow, 1,
      "stackChildPrimarySizing=RESIZE_TO_FIT → layoutGrow 1");
    eq(ir.unsupported.AUTO_LAYOUT_CHILD_SIZING, undefined,
      "sizing ребёнка больше не считается непереносимым");
    eq(ir.unsupported.OVERRIDE_FIELD, undefined,
      "в общий счётчик неизвестных полей ничего не свалилось");

    // SPACE_EVENLY — особый Pixso enum: при одном flow-child исходная
    // геометрия центрирует ребёнка. Базовый autoLayout это уже учитывал, а
    // partial override раньше повторно превращал CENTER в SPACE_BETWEEN.
    var normalizer = PixNormalizer.createNormalizer(doc, {});
    eq(normalizer.overrideLayout({ stackPrimaryAlignItems: "SPACE_EVENLY" }, { flowChildCount: 1 }).primaryAxisAlignItems,
      "CENTER", "SPACE_EVENLY override с одним flow-child остаётся центрированным");
    eq(normalizer.overrideLayout({ stackPrimaryAlignItems: "SPACE_EVENLY" }, { flowChildCount: 2 }).primaryAxisAlignItems,
      "SPACE_BETWEEN", "SPACE_EVENLY override с несколькими flow-child остаётся распределённым");

    var explicitSides = normalizer.borderWeights({
      strokeWeight: 1, borderTopWeight: 3, borderBottomWeight: 0,
    });
    eq(explicitSides.top, 3, "явная верхняя граница переносится без independent-флага");
    eq(explicitSides.right, 0, "неуказанная сторона per-side записи остаётся выключенной");
    eq(explicitSides.bottom, 0, "нулевая сторона сохраняется как отключённая");
    eq(explicitSides.left, 0, "вторая неуказанная сторона per-side записи остаётся выключенной");

    var independentUniform = normalizer.strokeWeights({
      borderStrokeWeightsIndependent: true, strokeWeight: 2,
    });
    eq(independentUniform.sides, undefined, "independent без side-полей не создаёт per-side запись");
    eq(independentUniform.uniform, 2, "толщина без сторон остаётся общей");

    // Полный и равный набор сторон — зеркало общей толщины, а не независимый
    // режим: замер `strokePaddingPath` у `Focus Layer` (4/4/4/4 при
    // strokeWeight 5) показывает нарисованные 5.
    var mirrored = normalizer.strokeWeights({
      strokeWeight: 5,
      borderTopWeight: 4, borderRightWeight: 4, borderBottomWeight: 4, borderLeftWeight: 4,
    });
    eq(mirrored.sides, undefined, "равный набор сторон не включает per-side режим");
    eq(mirrored.uniform, 5, "при равных сторонах авторитет у общей толщины");

    var mirrorWithoutUniform = normalizer.strokeWeights({
      borderTopWeight: 0.5, borderRightWeight: 0.5, borderBottomWeight: 0.5, borderLeftWeight: 0.5,
    });
    eq(mirrorWithoutUniform.uniform, 0.5, "без общей толщины равный набор сам её и задаёт");

    // Дельта вхождения против полной записи собственного узла. Один и тот же
    // набор полей значит в них разное: у собственного узла неназванная
    // сторона не нарисована, у вхождения — не переопределена. Пока разницы не
    // было, `Input Container` с определением 1/1/1/1 приезжал как 0/0/0/1:
    // выключенной оказывалась не та грань, а три остальные пропадали.
    var ownRecord = normalizer.borderWeights({ borderRightWeight: 0, borderLeftWeight: 1 });
    eq(ownRecord.top, 0, "у собственного узла неназванная сторона не нарисована");
    eq(ownRecord.right, 0, "явный ноль собственного узла сохраняется");
    eq(ownRecord.left, 1, "явная сторона собственного узла переносится");

    var delta = normalizer.overrideBorderWeights({ borderRightWeight: 0, borderLeftWeight: 1 });
    eq(delta.top, undefined, "у вхождения неназванная сторона наследуется от определения");
    eq(delta.bottom, undefined, "вторая неназванная сторона вхождения тоже наследуется");
    eq(delta.right, 0, "выключенная вхождением сторона переносится как ноль");
    eq(delta.left, 1, "переопределённая вхождением сторона переносится");

    eq(normalizer.overrideBorderWeights({
      borderTopWeight: 1, borderRightWeight: 1, borderBottomWeight: 1, borderLeftWeight: 1,
    }), undefined, "полный и равный набор вхождения остаётся зеркалом общей толщины");

    var partialWithUniform = normalizer.strokeWeights({
      strokeWeight: 1, borderBottomWeight: 1, borderLeftWeight: 1,
    });
    eq(partialWithUniform.uniform, undefined, "в per-side режиме общей толщины не существует");
    eq(partialWithUniform.sides.top, 0, "неуказанная сторона неполного набора выключена");
    eq(partialWithUniform.sides.bottom, 1, "указанная сторона неполного набора переносится");

    process.stdout.write("OK: Direct PIX поля override — " + checks + " проверок пройдено\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run();
