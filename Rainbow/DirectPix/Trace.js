/**
 * Диагностика визуальной точности Direct PIX.
 *
 * Отвечает на вопрос, на который счётчики отчёта ответить не могут:
 *
 *   Pixso говорит, что у этого прямоугольника TL=12, TR=12, BR=0, BL=0.
 *   Что прочитал парсер? Что сложил IR? Что присвоил приёмник узлу Figma?
 *
 * Для этого каждая проверяемая величина проходит три стадии и печатается
 * тремя колонками:
 *
 *   PIX    сырые поля записи `.pix`, как их отдал kiwi-декодер;
 *   IR     значение в MigrationIR — результат нормализации;
 *   FIGMA  значение, СЧИТАННОЕ ОБРАТНО с узла, который построил настоящий код
 *          приёмника на headless-двойнике хоста (`DirectPix/FigmaHost.js`).
 *
 * Третья колонка — не предсказание, а результат прогона. Но двойник заведомо
 * оптимистичнее реального редактора (см. комментарий в FigmaHost.js), поэтому
 * совпадение здесь означает «отправитель и приёмник согласованы между собой»,
 * а не «в Figma всё сойдётся». Расхождение же означает дефект всегда.
 *
 * Вывод ограничен по построению: выборка на категорию плюс все найденные
 * расхождения до предела. Дамп документа целиком диагностикой не является.
 *
 * Ни одно решение здесь не принимается по имени слоя: имена печатаются как
 * подпись к образцу и никуда больше не идут.
 */
"use strict";

var path = require("path");

var MigrationIR = require("./MigrationIR");
var FigmaHost = require("./FigmaHost");

var RECEIVER_PATH = path.join(__dirname, "..", "FigmaImporter", "Main.js");

/** Классы узлов, по которым группируется выборка. */
var CATEGORY = {
  VECTOR: "VECTOR",
  TEXT: "TEXT",
  CORNERS: "CORNERS",
  AUTOLAYOUT: "AUTOLAYOUT",
  CHILD_SIZING: "CHILD_SIZING",
  STROKE: "STROKE",
  INSTANCE: "INSTANCE",
};

/** Группы расхождений в итоговом отчёте (см. раздел VISUAL FIDELITY). */
var MISMATCH_GROUP = {
  fills: "paint", strokes: "stroke", strokeWeight: "stroke", strokeAlign: "stroke",
  cornerRadii: "corner",
  layoutMode: "layout", itemSpacing: "layout", padding: "layout",
  primaryAxisSizingMode: "layout", counterAxisSizingMode: "layout",
  layoutGrow: "layout", layoutAlign: "layout", layoutPositioning: "layout",
  characters: "text", fontName: "text", fontSize: "text", lineHeight: "text",
  letterSpacing: "text", textAlignHorizontal: "text", textCase: "text",
  textDecoration: "text", textAutoResize: "text",
  effects: "effect", opacity: "effect", blendMode: "effect",
  width: "geometry", height: "geometry", x: "geometry", y: "geometry",
  rotation: "geometry", visible: "geometry", clipsContent: "geometry",
  vectorPaths: "geometry",
  vectorNetwork: "geometry",
};

// ---------------------------------------------------------------------------
// Форматирование значений
// ---------------------------------------------------------------------------

function round(value) {
  return typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
}

function channel(value) {
  var hex = Math.max(0, Math.min(255, Math.round(value))).toString(16);
  return hex.length === 1 ? "0" + hex : hex;
}

/** Заливка Pixso в сыром виде: канал 0..255. */
function rawPaints(list) {
  if (!Array.isArray(list)) return list === undefined ? "—" : String(list);
  if (!list.length) return "[]";
  return list.map(function (paint) {
    if (!paint) return "?";
    if (paint.visible === false) return "hidden";
    if (paint.type !== "SOLID") return String(paint.type);
    var color = paint.color || {};
    var opacity = typeof paint.opacity === "number"
      ? paint.opacity
      : (typeof color.a === "number" ? color.a / 255 : 1);
    return "#" + channel(color.r) + channel(color.g) + channel(color.b) + "@" + round(opacity);
  }).join(" ");
}

/** Заливка в форме Figma: канал 0..1. */
function figmaPaints(list) {
  if (!Array.isArray(list)) return list === undefined ? "—" : String(list);
  if (!list.length) return "[]";
  return list.map(function (paint) {
    if (!paint) return "?";
    if (paint.type !== "SOLID") return String(paint.type);
    var color = paint.color || {};
    return "#" + channel(color.r * 255) + channel(color.g * 255) + channel(color.b * 255) +
      "@" + round(typeof paint.opacity === "number" ? paint.opacity : 1);
  }).join(" ");
}

function show(value) {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function cornerText(radii) {
  if (!radii) return "—";
  return radii.map(function (value) {
    return value === undefined ? "—" : round(value);
  }).join("/");
}

// ---------------------------------------------------------------------------
// Чтение значений по стадиям
// ---------------------------------------------------------------------------

/** Эффективные четыре угла узла Figma, прочитанные обратно. */
function figmaCorners(node) {
  if (!node) return null;
  var per = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
  if (per.some(function (value) { return typeof value === "number"; })) return per.map(round);
  if (typeof node.cornerRadius === "number") {
    var uniform = round(node.cornerRadius);
    return [uniform, uniform, uniform, uniform];
  }
  return null;
}

function irCorners(spec) {
  var corners = spec && spec.corners;
  if (!corners) return null;
  if (typeof corners.topLeftRadius === "number") {
    return [corners.topLeftRadius, corners.topRightRadius,
      corners.bottomRightRadius, corners.bottomLeftRadius].map(round);
  }
  if (typeof corners.cornerRadius === "number") {
    var uniform = round(corners.cornerRadius);
    return [uniform, uniform, uniform, uniform];
  }
  return null;
}

function rawCorners(detail, normalizer) {
  var radii = normalizer.cornerRadii(detail);
  return radii ? radii.map(round) : null;
}

/** Строки сравнения одной величины по трём стадиям. */
function sideText(sides) {
  if (!sides) return "—";
  return [sides.top, sides.right, sides.bottom, sides.left]
    .map(function (value) { return value === undefined ? "—" : round(value); }).join("/");
}

function rawSides(detail) {
  var keys = ["borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"];
  if (!keys.some(function (key) { return typeof detail[key] === "number"; })) return null;
  return { top: detail[keys[0]], right: detail[keys[1]], bottom: detail[keys[2]], left: detail[keys[3]] };
}

/** Что отправитель РЕАЛЬНО просит нарисовать: стороны либо общая толщина. */
function specSides(spec) {
  if (spec.borderWeights) return spec.borderWeights;
  if (typeof spec.strokeWeight !== "number") return null;
  return { top: spec.strokeWeight, right: spec.strokeWeight, bottom: spec.strokeWeight, left: spec.strokeWeight };
}

function nodeSides(node) {
  if (!node) return null;
  var top = node.strokeTopWeight, right = node.strokeRightWeight;
  var bottom = node.strokeBottomWeight, left = node.strokeLeftWeight;
  if (top === undefined && right === undefined && bottom === undefined && left === undefined) {
    if (typeof node.strokeWeight !== "number") return null;
    return { top: node.strokeWeight, right: node.strokeWeight, bottom: node.strokeWeight, left: node.strokeWeight };
  }
  return { top: top, right: right, bottom: bottom, left: left };
}

function row(name, pix, ir, figma, matches) {
  return {
    name: name,
    pix: pix,
    ir: ir,
    figma: figma,
    match: matches !== false,
    group: MISMATCH_GROUP[name] || "other",
  };
}

function sameNumber(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return a === b;
  return Math.abs(a - b) < 0.01;
}

// ---------------------------------------------------------------------------
// Прогон приёмника на headless-хосте
// ---------------------------------------------------------------------------

/**
 * Прогоняет IR корней через настоящий код приёмника и возвращает построенные
 * деревья. Транспорт не участвует: задачи протокола отдаются напрямую.
 */
async function runReceiver(doc, irByRoot, finishPayload) {
  var host = FigmaHost.install(RECEIVER_PATH);
  var receiver = host.receiver;
  var jobId = "trace-job";
  var sequence = 0;
  var sentDefinitions = Object.create(null);
  var sentAssets = Object.create(null);
  var sentStyles = Object.create(null);
  var rootResults = [];

  function task(type, payload) {
    sequence += 1;
    return receiver.handleDirectTask({
      jobId: jobId,
      taskId: jobId + "-" + sequence,
      type: type,
      payload: Object.assign({ protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION }, payload),
    }, {});
  }

  await task("DIRECT_PIX_START", { source: { fileName: doc.container.fileName }, debugOverrides: true });

  for (var i = 0; i < irByRoot.length; i++) {
    var ir = irByRoot[i].ir;
    var root = ir.roots[0];
    if (!root) continue;

    var assets = ir.assets.filter(function (asset) {
      if (sentAssets[asset.assetId]) return false;
      sentAssets[asset.assetId] = true;
      return true;
    }).map(function (asset) {
      var bytes = doc.container.readResource(asset.assetId);
      return {
        assetId: asset.assetId,
        extension: asset.extension,
        bytesBase64: bytes ? bytes.toString("base64") : null,
      };
    }).filter(function (asset) { return !!asset.bytesBase64; });
    if (assets.length) await task("DIRECT_PIX_ASSETS", { assets: assets });

    // Стили — до определений: связать узел определения можно только с уже
    // созданным стилем.
    var styles = (ir.styles || []).filter(function (style) {
      if (sentStyles[style.styleId]) return false;
      sentStyles[style.styleId] = true;
      return true;
    });
    if (styles.length) await task("DIRECT_PIX_STYLES", { styles: styles });

    var definitions = ir.definitions.filter(function (definition) {
      if (sentDefinitions[definition.definitionId]) return false;
      sentDefinitions[definition.definitionId] = true;
      return true;
    });
    if (definitions.length) await task("DIRECT_PIX_DEFINITIONS", { definitions: definitions });

    await task("DIRECT_PIX_PAGE", { pageId: root.pageId, pageName: root.pageName });
    var result = await task("DIRECT_PIX_ROOT", {
      pageId: root.pageId, pageName: root.pageName,
      rootId: root.rootId, rootName: root.rootName, nodes: root.nodes,
      debugOverrides: true,
    });
    rootResults.push({ rootId: root.rootId, result: result });
  }

  var finish = await task("DIRECT_PIX_FINISH", finishPayload || {});
  // Сверка идёт по сохранённому состоянию инстансов, а не по геометрии сразу
  // после правок: живая Figma показывает второе закешированным, и сверка по
  // нему пропускала вхождения, которые после пересчёта уезжают к размерам
  // мастера.
  if (typeof host.materializeStoredState === "function") host.materializeStoredState();
  return { host: host, finish: finish, rootResults: rootResults };
}

/**
 * Соответствие «узел IR → узел Figma» внутри одного плоского списка.
 *
 * Строится не поиском по guid — внутри инстансов один и тот же guid
 * встречается многократно, — а тем же порядком, которым дерево и собиралось:
 * родитель в списке всегда раньше ребёнка, дети добавляются подряд. Поэтому
 * позиция ребёнка у родителя известна точно. Совпадение plugin data
 * проверяется поверх и попадает в отчёт отдельной величиной.
 */
function matchNodes(specs, rootNode) {
  var byId = new Map();
  var childCounts = Object.create(null);
  var mismatchedPluginData = 0;
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    if (!spec.parent) { byId.set(spec.id, rootNode); continue; }
    var parent = byId.get(spec.parent);
    var index = childCounts[spec.parent] || 0;
    childCounts[spec.parent] = index + 1;
    if (!parent || !parent.children) continue;
    var node = parent.children[index];
    if (!node) continue;
    if (node.getPluginData && node.getPluginData("pixsoDirectSourceId") !== spec.id) {
      mismatchedPluginData += 1;
      continue;
    }
    byId.set(spec.id, node);
  }
  return { byId: byId, mismatchedPluginData: mismatchedPluginData };
}

/** Корневые узлы, построенные приёмником: страницы и служебные компоненты. */
function collectRoots(pages) {
  var rootsBySourceId = new Map();
  var definitionsById = new Map();
  pages.forEach(function (page) {
    (page.children || []).forEach(function (node) {
      var definitionId = node.getPluginData ? node.getPluginData("pixsoDirectDefinitionId") : "";
      if (definitionId) { definitionsById.set(definitionId, node); return; }
      var sourceId = node.getPluginData ? node.getPluginData("pixsoDirectSourceId") : "";
      if (sourceId) rootsBySourceId.set(sourceId, node);
    });
  });
  return { rootsBySourceId: rootsBySourceId, definitionsById: definitionsById };
}

// ---------------------------------------------------------------------------
// Сравнение стадий
// ---------------------------------------------------------------------------

function categorize(record, spec) {
  var categories = [];
  if (spec.kind === "INSTANCE") categories.push(CATEGORY.INSTANCE);
  if (spec.type === "VECTOR" || spec.type === "LINE") categories.push(CATEGORY.VECTOR);
  if (spec.type === "TEXT") categories.push(CATEGORY.TEXT);
  if (spec.corners) categories.push(CATEGORY.CORNERS);
  if (spec.autoLayout) categories.push(CATEGORY.AUTOLAYOUT);
  if (spec.childLayout) categories.push(CATEGORY.CHILD_SIZING);
  if (spec.strokes && spec.strokes.length) categories.push(CATEGORY.STROKE);
  return categories;
}

/**
 * Три стадии одного узла. `detail` — сырая запись Pixso, `spec` — узел IR,
 * `node` — узел, построенный приёмником.
 */
/**
 * Строка режима оси контейнера с учётом объявленного фоллбека.
 *
 * Фоллбеков два, и относятся они к строке по-разному.
 *
 *   `"FLOW"`        — в потоке никого. У Figma и Pixso тут разные, но обе
 *                     защитимые трактовки, поэтому AUTO и FIXED допустимы
 *                     оба, и строка лишь помечается.
 *   `"SELF_SIZED"`  — по этой оси всё содержимое ждёт размера от самого
 *                     контейнера. Оставленный AUTO схлопывает в Figma и
 *                     контейнер, и всё его поддерево, поэтому FIXED здесь
 *                     не «допустим», а ОБЯЗАТЕЛЕН: AUTO — это расхождение.
 */
function sizingModeRow(name, pixValue, irValue, figmaValue, node, hugFallback) {
  var required = hugFallback === "SELF_SIZED";
  var fallbackApplied = !!hugFallback && irValue === "AUTO" && figmaValue === "FIXED";
  var reason = required
    ? "  (fallback: содержимое ждёт размера от контейнера)"
    : "  (fallback: обнимать нечего)";
  var missing = required && irValue === "AUTO" && figmaValue !== "FIXED";
  return row(name, show(pixValue), show(irValue),
    show(figmaValue) + (fallbackApplied ? reason : "") +
      (missing ? "  ← HUG не по чему считать: ось схлопнется" : ""),
    !node || (!missing && (irValue === undefined || irValue === figmaValue || fallbackApplied)));
}

/**
 * Строка габарита одной оси.
 *
 * Ось, принадлежащая источнику, обязана совпасть до сотой. Ось, которую
 * считает раскладка, сверяется только на то, что она вообще посчитана
 * (положительное число), — её точное значение принадлежит движку редактора.
 */
function sizeRow(name, ownership, pixValue, specValue, node) {
  var actual = node ? round(name === "width" ? node.width : node.height) : undefined;
  var figmaText = show(actual) + (ownership === "source" ? "" : "  (" + ownership + ")");
  if (!node || specValue === undefined) return row(name, show(round(pixValue)), show(round(specValue)), figmaText, true);
  if (ownership !== "source") {
    // Точное число на оси HUG или FILL принадлежит раскладке, и «должно
    // совпасть до сотой» здесь неверно. Но и «любое конечное число годится»
    // неверно тоже: именно это скрывало схлопнутые оси — отчёт говорил «0
    // расхождений» на дереве, где вхождение приехало вдвое ниже источника.
    // Поэтому отклонение от источника считается ОТДЕЛЬНОЙ величиной: не
    // mismatch, но и не молчание.
    var drifted = typeof actual === "number" && isFinite(actual) &&
      typeof pixValue === "number" && !sameNumber(round(pixValue), actual);
    var driftRow = row(name, show(round(pixValue)), show(round(specValue)),
      figmaText + (drifted ? "  ← раскладка дала не размер источника" : ""),
      typeof actual === "number" && isFinite(actual));
    if (drifted) {
      driftRow.drift = { axis: name, ownership: ownership, source: round(pixValue), actual: actual };
    }
    return driftRow;
  }
  return row(name, show(round(pixValue)), show(round(specValue)), figmaText,
    sameNumber(round(Math.max(0.01, specValue)), actual));
}

/**
 * Хозяин каждой оси узла. Та же логика, по которой приёмник решает, чей
 * размер возвращать, — и она же определяет, что здесь вообще сравнимо.
 *
 * Число на оси HUG или FILL считает раскладка, а раскладка двойника — не
 * раскладка Figma: она не измеряет текст. Сравнивать там ширину значило бы
 * объявлять дефектом инстанс, у которого переопределённая подпись длиннее
 * исходной. Поэтому на таких осях сверяется РЕЖИМ, а не пиксели, и колонка
 * FIGMA честно помечена «hug»/«fill».
 */
/**
 * Режимы осей вхождения — те же, что считает приёмник.
 *
 * Прочитанные с инстанса `primaryAxisSizingMode` / `counterAxisSizingMode`
 * наследованы от МАСТЕРА: это утверждение об определении, а не о вхождении.
 * Собственное вхождение объявляет их правкой своего корневого пути; молчание
 * означает его собственную записанную коробку.
 */
function occurrenceModes(spec, node) {
  var live = {
    layoutMode: node.layoutMode,
    primaryAxisSizingMode: node.primaryAxisSizingMode,
    counterAxisSizingMode: node.counterAxisSizingMode,
  };
  if (spec.kind !== "INSTANCE") return live;
  var declared = null;
  var overrides = spec.overrides || [];
  for (var i = 0; i < overrides.length; i++) {
    if (overrides[i].path && overrides[i].path.length) continue;
    if (overrides[i].ops && overrides[i].ops.layout) { declared = overrides[i].ops.layout; break; }
  }
  return {
    layoutMode: (declared && declared.layoutMode) || live.layoutMode,
    primaryAxisSizingMode: declared && declared.primaryAxisSizingMode !== undefined
      ? declared.primaryAxisSizingMode : "FIXED",
    counterAxisSizingMode: declared && declared.counterAxisSizingMode !== undefined
      ? declared.counterAxisSizingMode : "FIXED",
  };
}

function axisOwner(spec, parentLayoutMode, node) {
  // Режимы читаются с построенного узла: у вхождения их в пакете нет, они
  // наследованы от мастера, и без этого HUG-инстанс выглядел бы узлом,
  // обязанным сохранить исходный размер.
  var own = spec.autoLayout || (node ? occurrenceModes(spec, node) : null);
  var laidOut = !!own && (own.layoutMode === "HORIZONTAL" || own.layoutMode === "VERTICAL");
  var ownHorizontal = laidOut && own.layoutMode === "HORIZONTAL";
  var ownWidthAuto = laidOut && (ownHorizontal ? own.primaryAxisSizingMode : own.counterAxisSizingMode) === "AUTO";
  var ownHeightAuto = laidOut && (ownHorizontal ? own.counterAxisSizingMode : own.primaryAxisSizingMode) === "AUTO";
  var child = spec.childLayout;
  var absolute = !!child && child.layoutPositioning === "ABSOLUTE";
  var parentHorizontal = parentLayoutMode === "HORIZONTAL";
  var filledMain = !absolute && !!child && child.layoutGrow > 0;
  var filledCross = !absolute && !!child && child.layoutAlign === "STRETCH";
  var parentOwnsWidth = !!parentLayoutMode && (parentHorizontal ? filledMain : filledCross);
  var parentOwnsHeight = !!parentLayoutMode && (parentHorizontal ? filledCross : filledMain);
  return {
    width: parentOwnsWidth ? "fill" : (ownWidthAuto ? "hug" : "source"),
    height: parentOwnsHeight ? "fill" : (ownHeightAuto ? "hug" : "source"),
  };
}

function compareNode(detail, spec, node, normalizer, parentLayoutMode, hasFlowContent, degenerateHug) {
  var rows = [];
  var effective = spec.kind === "INSTANCE";
  var owner = axisOwner(spec, parentLayoutMode || null, node);

  // Figma не принимает нулевой габарит, и приёмник поднимает его до 0.01.
  // Это не расхождение, а документированное ограничение хоста.
  rows.push(sizeRow("width", owner.width, detail.size && detail.size.x, spec.width, node));
  rows.push(sizeRow("height", owner.height, detail.size && detail.size.y, spec.height, node));
  rows.push(row("visible", show(detail.visible), show(spec.visible),
    show(node ? node.visible : undefined),
    !node || (spec.visible === false ? node.visible === false : node.visible !== false)));

  if (!effective) {
    // У вхождения заливки и обводки приходят из определения: сравнивать их с
    // сырой записью вхождения бессмысленно, там их просто нет.
    rows.push(row("fills", rawPaints(detail.fillPaints), figmaPaints(spec.fills),
      figmaPaints(node && node.fills),
      !node || figmaPaints(spec.fills || []) === figmaPaints(node.fills || [])));
    rows.push(row("strokes", rawPaints(detail.strokePaints), figmaPaints(spec.strokes),
      figmaPaints(node && node.strokes),
      !node || figmaPaints(spec.strokes || []) === figmaPaints(node.strokes || [])));
    if ((spec.strokes && spec.strokes.length) || (node && node.strokes && node.strokes.length)) {
      rows.push(row("strokeWeight", show(detail.strokeWeight), show(spec.strokeWeight),
        show(node && node.strokeWeight),
        !node || spec.strokeWeight === undefined || sameNumber(spec.strokeWeight, node.strokeWeight)));
      rows.push(row("strokeAlign", show(detail.strokeAlign), show(spec.strokeAlign),
        show(node && node.strokeAlign),
        !node || spec.strokeAlign === undefined || spec.strokeAlign === node.strokeAlign));
      // Толщина по сторонам. Без этой строки одна общая `strokeWeight`
      // показывала «—/—/—» у рамки, которая на самом деле приехала
      // односторонней: расхождение целиком жило в стороннем представлении.
      rows.push(row("borderWeights T/R/B/L", sideText(rawSides(detail)),
        sideText(specSides(spec, normalizer)), sideText(nodeSides(node)),
        !node || sideText(specSides(spec, normalizer)) === "—" ||
          sideText(specSides(spec, normalizer)) === sideText(nodeSides(node))));
    }

    var pixRadii = rawCorners(detail, normalizer);
    var specRadii = irCorners(spec);
    var nodeRadii = node ? figmaCorners(node) : null;
    if (pixRadii || specRadii || nodeRadii) {
      rows.push(row("cornerRadii", cornerText(pixRadii), cornerText(specRadii), cornerText(nodeRadii),
        !node || cornerText(specRadii) === cornerText(nodeRadii)));
    }

    if (spec.effects || detail.effects) {
      rows.push(row("effects", show((detail.effects || []).length), show((spec.effects || []).length),
        show(node && (node.effects || []).length),
        !node || (spec.effects || []).length === (node.effects || []).length));
    }
  }

  if (spec.autoLayout || detail.stackMode) {
    var layout = spec.autoLayout || {};
    rows.push(row("layoutMode", show(detail.stackMode), show(layout.layoutMode),
      show(node && node.layoutMode),
      !node || layout.layoutMode === undefined || layout.layoutMode === node.layoutMode));
    rows.push(row("itemSpacing", show(detail.stackSpacing), show(layout.itemSpacing),
      show(node && node.itemSpacing),
      !node || layout.itemSpacing === undefined || sameNumber(layout.itemSpacing, node.itemSpacing)));
    rows.push(row("padding",
      [detail.stackPaddingTop, detail.stackPaddingRight, detail.stackPaddingBottom, detail.stackPaddingLeft].map(show).join("/"),
      [layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft].map(show).join("/"),
      node ? [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(show).join("/") : "—",
      !node || [layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft]
        .every(function (value, index) {
          var actual = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft][index];
          return value === undefined || sameNumber(value, actual);
        })));
    // Приёмник имеет право отступить от IR ровно в одном месте: контейнеру
    // без единого узла в потоке обнимать нечего, и HUG там становится FIXED.
    // Это объявленный фоллбек с собственным счётчиком, а не расхождение,
    // поэтому он и печатается пометкой, а не «WRONG».
    var hugFallback = hasFlowContent === false;
    var degenerate = degenerateHug || {};
    rows.push(sizingModeRow("primaryAxisSizingMode", detail.stackPrimarySizing,
      layout.primaryAxisSizingMode, node && node.primaryAxisSizingMode, node,
      hugFallback || (degenerate.primary ? "SELF_SIZED" : false)));
    rows.push(sizingModeRow("counterAxisSizingMode", detail.stackCounterSizing,
      layout.counterAxisSizingMode, node && node.counterAxisSizingMode, node,
      hugFallback || (degenerate.counter ? "SELF_SIZED" : false)));
  }

  if (spec.childLayout || detail.stackChildPrimarySizing || detail.stackChildCounterSizing) {
    var childLayout = spec.childLayout || {};
    rows.push(row("layoutGrow", show(detail.stackChildPrimarySizing), show(childLayout.layoutGrow),
      show(node && node.layoutGrow),
      !node || childLayout.layoutGrow === undefined || childLayout.layoutGrow === node.layoutGrow));
    rows.push(row("layoutAlign", show(detail.stackChildCounterSizing), show(childLayout.layoutAlign),
      show(node && node.layoutAlign),
      !node || childLayout.layoutAlign === undefined || childLayout.layoutAlign === node.layoutAlign));
    rows.push(row("layoutPositioning", show(detail.autoLayoutAbsolutePos), show(childLayout.layoutPositioning),
      show(node && node.layoutPositioning),
      !node || childLayout.layoutPositioning === undefined ||
        childLayout.layoutPositioning === node.layoutPositioning));
    // Ось, а не поле: `layoutGrow` — это ширина в HORIZONTAL родителе и
    // высота в VERTICAL. Без этой строки перепутанные оси в отчёте выглядят
    // одинаково правильными.
    rows.push(row("sizing width/height",
      show(detail.stackChildPrimarySizing) + " main / " + show(detail.stackChildCounterSizing) + " cross",
      owner.width + " / " + owner.height,
      "parent " + show(parentLayoutMode), true));
  }

  if (spec.sizeBounds || detail.minSize || detail.maxSize) {
    var bounds = spec.sizeBounds || {};
    ["minWidth", "maxWidth", "minHeight", "maxHeight"].forEach(function (key) {
      var sourceKey = key.indexOf("min") === 0 ? "minSize" : "maxSize";
      var axis = key.indexOf("Width") > 0 ? "x" : "y";
      rows.push(row(key, show(detail[sourceKey] && round(detail[sourceKey][axis])),
        show(bounds[key]), show(node && node[key]),
        !node || bounds[key] === undefined || sameNumber(bounds[key], node[key])));
    });
  }

  if (spec.type === "TEXT") {
    var text = spec.text || {};
    rows.push(row("characters", show(detail.textData && detail.textData.characters),
      show(text.characters), show(node && node.characters),
      !node || text.characters === undefined || text.characters === node.characters));
    rows.push(row("fontName", show(detail.fontName), show(text.fontName),
      show(node && node.fontName),
      !node || text.fontName === undefined || show(text.fontName) === show(node.fontName)));
    rows.push(row("fontSize", show(detail.fontSize), show(text.fontSize), show(node && node.fontSize),
      !node || text.fontSize === undefined || sameNumber(text.fontSize, node.fontSize)));
    rows.push(row("lineHeight", show(detail.lineHeight), show(text.lineHeight), show(node && node.lineHeight),
      !node || text.lineHeight === undefined || show(text.lineHeight) === show(node.lineHeight)));
    rows.push(row("letterSpacing", show(detail.letterSpacing), show(text.letterSpacing),
      show(node && node.letterSpacing),
      !node || text.letterSpacing === undefined || show(text.letterSpacing) === show(node.letterSpacing)));
    rows.push(row("textAlignHorizontal", show(detail.textAlignHorizontal), show(text.textAlignHorizontal),
      show(node && node.textAlignHorizontal),
      !node || text.textAlignHorizontal === undefined ||
        text.textAlignHorizontal === node.textAlignHorizontal));
    rows.push(row("textCase", show(detail.textCase), show(text.textCase), show(node && node.textCase),
      !node || text.textCase === undefined || text.textCase === node.textCase));
    rows.push(row("textDecoration", show(detail.textDecoration), show(text.textDecoration),
      show(node && node.textDecoration),
      !node || text.textDecoration === undefined || text.textDecoration === node.textDecoration));
    rows.push(row("textAutoResize", show(detail.textAutoResize), show(text.textAutoResize),
      show(node && node.textAutoResize),
      !node || text.textAutoResize === undefined || text.textAutoResize === node.textAutoResize));
  }

  if (spec.type === "VECTOR" || spec.type === "LINE") {
    rows.push(row("vectorPaths", show(detail.fillGeometry && detail.fillGeometry.length),
      show(spec.vectorPaths && spec.vectorPaths.length),
      show(node && node.vectorPaths && node.vectorPaths.length),
      !node || spec.vectorPaths === undefined ||
        (node.vectorPaths || []).length === spec.vectorPaths.length));
    // Краска регионов: сверяется ЧИСЛО окрашенных регионов, а не их порядок.
    // Источник хранит перекрытие над общей заливкой, поэтому «регион без
    // своей краски» — это законное состояние, а не пропажа.
    if ((detail.vectorPaints && detail.vectorPaints.length) || spec.vectorNetwork) {
      var specPaintedRegions = spec.vectorNetwork
        ? spec.vectorNetwork.regions.filter(function (region) { return !!region.fills; }).length
        : undefined;
      var nodePaintedRegions = null;
      if (node) {
        var nodeNetwork = null;
        try { nodeNetwork = node.vectorNetwork; } catch (_eNetwork) { nodeNetwork = null; }
        nodePaintedRegions = nodeNetwork && nodeNetwork.regions
          ? nodeNetwork.regions.filter(function (region) { return !!region.fills; }).length
          : 0;
      }
      rows.push(row("vectorRegionFills", show((detail.vectorPaints || []).length),
        show(specPaintedRegions), show(nodePaintedRegions),
        !node || specPaintedRegions === undefined || nodePaintedRegions === specPaintedRegions));
    }
  }

  if (spec.kind === "INSTANCE") {
    // Активное определение читается из отпечатка plugin data, который ставит
    // сам приёмник, — ровно как это делает он. Синхронный `mainComponent`
    // здесь непригоден: манифест приёмника объявляет
    // `documentAccess: "dynamic-page"`, и двойник, как и настоящая Figma, на
    // его чтении БРОСАЕТ. Через него сверка падала на любом корне
    // с вхождениями.
    var active = node && typeof node.getPluginData === "function"
      ? (node.getPluginData("pixsoDirectDefinitionId") || undefined) : undefined;
    rows.push(row("activeComponent", show(spec.definitionId), show(spec.definitionId), show(active),
      !node || !active || active === spec.definitionId));
    rows.push(row("overrideEntries", "—", show((spec.overrides || []).length), "—", true));
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

/**
 * @param {object} doc результат PixDocument.load
 * @param {Array} roots записи корней
 * @param {object} options { perCategory, maxMismatches }
 */
async function trace(doc, roots, options) {
  options = options || {};
  var perCategory = options.perCategory || 4;
  var maxMismatches = options.maxMismatches || 40;

  var registry = MigrationIR.createRegistry();
  var irByRoot = roots.map(function (record) {
    return { record: record, ir: MigrationIR.build(doc, { roots: [record], registry: registry, debugOverrides: true }) };
  });

  var run = await runReceiver(doc, irByRoot);
  var trees = collectRoots(run.host.pages());
  var pluginDataMismatches = 0;

  var samplesByCategory = Object.create(null);
  var mismatches = [];
  var mismatchesByGroup = Object.create(null);
  // Оси, которые считает раскладка. Их точное число ей и принадлежит, поэтому
  // расхождением они не являются, — но и молчать о них нельзя: схлопнутая
  // HUG-ось выглядит в отчёте ровно как здоровая, пока её никто не считает.
  var layoutDrift = [];
  var layoutDriftByClass = Object.create(null);
  var comparedNodes = 0;
  var unmatchedNodes = 0;
  var normalizer = null;
  var PixNormalizer = require("./PixNormalizer");
  normalizer = PixNormalizer.createNormalizer(doc, { unsupported: function () {}, asset: function (hash) { return hash; } });

  var built = new Map();
  // spec.id ребёнка → направление раскладки его родителя. Заполняется тем же
  // проходом, что и сравнение: родитель в списке всегда раньше ребёнка.
  var parentLayoutModes = new Map();
  var layoutModeById = new Map();
  var flowContent = new Set();
  var degenerateHugById = new Map();
  var invisibleSpecs = new Set();

  function indexInvisible(specs) {
    invisibleSpecs = new Set();
    specs.forEach(function (spec) {
      if (spec.visible === false || (spec.parent && invisibleSpecs.has(spec.parent))) {
        invisibleSpecs.add(spec.id);
      }
    });
  }

  function indexLayoutModes(specs) {
    parentLayoutModes = new Map();
    layoutModeById = new Map();
    flowContent = new Set();
    degenerateHugById = new Map();
    var deferrals = new Map();
    var specById = new Map();
    specs.forEach(function (spec) {
      specById.set(spec.id, spec);
      if (spec.autoLayout && spec.autoLayout.layoutMode) layoutModeById.set(spec.id, spec.autoLayout.layoutMode);
      if (spec.parent && layoutModeById.has(spec.parent)) {
        parentLayoutModes.set(spec.id, layoutModeById.get(spec.parent));
      }
      // Тот же признак, что считает приёмник, но посчитанный здесь заново:
      // сверка не должна опираться на слово проверяемого кода.
      if (spec.parent && spec.visible !== false &&
          !(spec.childLayout && spec.childLayout.layoutPositioning === "ABSOLUTE")) {
        flowContent.add(spec.parent);
        var counts = deferrals.get(spec.parent) || { flow: 0, main: 0, cross: 0 };
        counts.flow += 1;
        if (spec.childLayout && spec.childLayout.layoutGrow > 0) counts.main += 1;
        if (spec.childLayout && spec.childLayout.layoutAlign === "STRETCH") counts.cross += 1;
        deferrals.set(spec.parent, counts);
      }
    });
    // Вырожденный HUG: ось, по которой ВСЁ содержимое ждёт размера от самого
    // контейнера. Считается здесь заново по тем же полям IR, что и в
    // приёмнике: сверка не имеет права спрашивать проверяемый код.
    specs.forEach(function (spec) {
      var layout = spec.autoLayout;
      var counts = deferrals.get(spec.id);
      if (!layout || !counts || !counts.flow) return;
      var child = spec.childLayout;
      var parentMode = parentLayoutModes.get(spec.id) || null;
      var absolute = !!child && child.layoutPositioning === "ABSOLUTE";
      var filledMain = !absolute && !!child && !!parentMode && child.layoutGrow > 0;
      var filledCross = !absolute && !!child && !!parentMode && child.layoutAlign === "STRETCH";
      var same = parentMode === layout.layoutMode;
      degenerateHugById.set(spec.id, {
        primary: counts.main === counts.flow && !(same ? filledMain : filledCross),
        counter: counts.cross === counts.flow && !(same ? filledCross : filledMain),
      });
    });
  }

  function consider(spec) {
    var record = doc.tree.byKey.get(spec.id);
    if (!record) return;
    var node = built.get(spec.id) || null;
    if (!node) { unmatchedNodes += 1; return; }
    var detail;
    try { detail = doc.detail(record); } catch (_e) { return; }
    comparedNodes += 1;
    var rows = compareNode(detail, spec, node, normalizer,
      parentLayoutModes.get(spec.id) || null, flowContent.has(spec.id),
      degenerateHugById.get(spec.id) || null);
    var bad = rows.filter(function (item) { return !item.match; });
    rows.forEach(function (item) {
      if (!item.drift) return;
      // Невидимый узел из потока выключен обоими редакторами, и размера ему
      // раскладка не назначает вовсе: Pixso хранит последний посчитанный,
      // Figma — тот, с которым узел построили. Это не расхождение.
      if (invisibleSpecs.has(spec.id)) return;
      var key = item.drift.axis + " " + item.drift.ownership;
      layoutDriftByClass[key] = (layoutDriftByClass[key] || 0) + 1;
      if (layoutDrift.length < maxMismatches) {
        layoutDrift.push({
          sourceId: spec.id, sourceType: record.type, kind: spec.kind,
          diagnosticName: String(record.name || "").slice(0, 40),
          axis: item.drift.axis, ownership: item.drift.ownership,
          source: item.drift.source, actual: item.drift.actual,
        });
      }
    });
    var sample = {
      category: null,
      sourceId: spec.id,
      sourceType: record.type,
      // Имя — подпись к образцу. Ни одно решение по нему не принимается.
      diagnosticName: String(record.name || "").slice(0, 60),
      definitionId: spec.definitionId || null,
      rows: rows,
    };
    if (bad.length && mismatches.length < maxMismatches) {
      var flagged = Object.assign({}, sample, { category: "MISMATCH", rows: bad });
      mismatches.push(flagged);
    }
    bad.forEach(function (item) {
      mismatchesByGroup[item.group] = (mismatchesByGroup[item.group] || 0) + 1;
    });
    categorize(record, spec).forEach(function (category) {
      var list = samplesByCategory[category] || (samplesByCategory[category] = []);
      if (list.length < perCategory) list.push(Object.assign({}, sample, { category: category }));
    });
  }

  irByRoot.forEach(function (entry) {
    var root = entry.ir.roots[0];
    if (root) {
      var matched = matchNodes(root.nodes, trees.rootsBySourceId.get(root.rootId));
      pluginDataMismatches += matched.mismatchedPluginData;
      built = matched.byId;
      indexLayoutModes(root.nodes);
      indexInvisible(root.nodes);
      root.nodes.forEach(consider);
    }
    entry.ir.definitions.forEach(function (definition) {
      var component = trees.definitionsById.get(definition.definitionId);
      var matchedDefinition = matchNodes(definition.nodes, component);
      pluginDataMismatches += matchedDefinition.mismatchedPluginData;
      built = matchedDefinition.byId;
      indexLayoutModes(definition.nodes);
      indexInvisible(definition.nodes);
      definition.nodes.forEach(consider);
    });
  });

  var stats = irByRoot.reduce(function (out, entry) {
    Object.keys(entry.ir.stats).forEach(function (key) {
      var value = entry.ir.stats[key];
      if (typeof value === "number") out[key] = (out[key] || 0) + value;
    });
    return out;
  }, Object.create(null));

  return {
    comparedNodes: comparedNodes,
    unmatchedNodes: unmatchedNodes,
    pluginDataMismatches: pluginDataMismatches,
    mismatchesByGroup: mismatchesByGroup,
    mismatches: mismatches,
    layoutDrift: layoutDrift,
    layoutDriftByClass: layoutDriftByClass,
    samplesByCategory: samplesByCategory,
    irStats: stats,
    receiver: run.finish,
    hostCalls: run.host.calls,
  };
}

/** Печатная форма отчёта: три колонки на величину. */
function format(report) {
  var out = [];
  out.push("VISUAL FIDELITY TRACE");
  out.push("  узлов сопоставлено       " + report.comparedNodes);
  out.push("  узлов не найдено в Figma " + report.unmatchedNodes +
    "  ← приёмник не построил узел на ожидаемом месте");
  out.push("  plugin data не совпала    " + report.pluginDataMismatches +
    "  ← позиция построена, но sourceId на ней другой");
  out.push("");
  out.push("VISUAL FIDELITY");
  var groups = Object.keys(report.mismatchesByGroup).sort();
  if (!groups.length) out.push("  расхождений не найдено");
  groups.forEach(function (group) {
    out.push("  " + group + " mismatches: " + report.mismatchesByGroup[group]);
  });

  var driftClasses = Object.keys(report.layoutDriftByClass || {}).sort();
  out.push("");
  out.push("РАЗМЕР, ПОСЧИТАННЫЙ РАСКЛАДКОЙ (не совпал с источником)");
  if (!driftClasses.length) out.push("  все оси HUG/FILL сошлись с источником");
  driftClasses.forEach(function (key) {
    out.push("  " + key + ": " + report.layoutDriftByClass[key]);
  });
  (report.layoutDrift || []).slice(0, 12).forEach(function (item) {
    out.push("    " + item.sourceId + " " + item.sourceType + " " +
      JSON.stringify(item.diagnosticName) + "  " + item.axis + " " +
      item.source + " → " + item.actual + "  (" + item.ownership + ")");
  });

  function printSample(sample) {
    out.push("");
    out.push("Sample: " + sample.category + "  " + sample.sourceType);
    out.push("  source guid: " + sample.sourceId +
      (sample.definitionId ? "   component: " + sample.definitionId : ""));
    out.push("  " + pad("PROPERTY", 22) + pad("PIX", 26) + pad("IR", 26) + "FIGMA");
    sample.rows.forEach(function (item) {
      out.push("  " + pad(item.name, 22) + pad(item.pix, 26) + pad(item.ir, 26) +
        item.figma + (item.match ? "" : "   <-- WRONG"));
    });
  }

  if (report.mismatches.length) {
    out.push("");
    out.push("=== РАСХОЖДЕНИЯ ===");
    report.mismatches.forEach(printSample);
  }

  out.push("");
  out.push("=== ОБРАЗЦЫ ПО КЛАССАМ УЗЛОВ ===");
  Object.keys(report.samplesByCategory).sort().forEach(function (category) {
    report.samplesByCategory[category].forEach(printSample);
  });
  return out.join("\n");
}

function pad(value, width) {
  var text = String(value === undefined ? "" : value);
  if (text.length >= width) return text.slice(0, width - 1) + " ";
  return text + new Array(width - text.length + 1).join(" ");
}

module.exports = { trace: trace, format: format, CATEGORY: CATEGORY, runReceiver: runReceiver };
