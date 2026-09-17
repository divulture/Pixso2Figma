/**
 * Перевод значений Pixso в значения, которые понимает Figma Plugin API.
 *
 * Схема Pixso почти повторяет модель Figma, поэтому большая часть перевода —
 * это переименование перечислений и нормализация единиц. Там, где однозначного
 * соответствия нет, значение НЕ подставляется приблизительно: поле пропускается
 * и попадает в счётчик unsupported с кодом причины.
 *
 * Правило модуля: ни одно решение не принимается по имени слоя.
 */
"use strict";

// Коды непокрытых случаев. Список фиксированный: «прочее» без кода — это
// потерянная диагностика, а не экономия.
var UNSUPPORTED = {
  PAINT_TYPE: "PAINT_TYPE",
  PAINT_IMAGE_MISSING: "PAINT_IMAGE_MISSING",
  EFFECT_TYPE: "EFFECT_TYPE",
  STROKE_CAP: "STROKE_CAP",
  CONSTRAINT_TYPE: "CONSTRAINT_TYPE",
  LAYOUT_GRID_MODE: "LAYOUT_GRID_MODE",
  LAYOUT_AXIS_SIZING_ABSENT: "LAYOUT_AXIS_SIZING_ABSENT",
  AUTO_LAYOUT_CHILD_GROW: "AUTO_LAYOUT_CHILD_GROW",
  VECTOR_GEOMETRY: "VECTOR_GEOMETRY",
  VECTOR_WINDING_RULE: "VECTOR_WINDING_RULE",
  NODE_TYPE: "NODE_TYPE",
  TEXT_RANGE_STYLE: "TEXT_RANGE_STYLE",
  ROTATED_TRANSFORM: "ROTATED_TRANSFORM",
  OVERRIDE_FIELD: "OVERRIDE_FIELD",
  OVERRIDE_TARGET: "OVERRIDE_TARGET",
  PROTOTYPE: "PROTOTYPE",
  VARIABLE_BINDING: "VARIABLE_BINDING",
  VECTOR_PAINT_TABLE: "VECTOR_PAINT_TABLE",
  VECTOR_REGION_NETWORK: "VECTOR_REGION_NETWORK",
  VECTOR_REGION_STYLE: "VECTOR_REGION_STYLE",
};

/** Типы узлов Pixso, которые Direct PIX умеет строить в Figma. */
var SUPPORTED_TYPES = {
  FRAME: "FRAME",
  GROUP: "GROUP",
  SECTION: "FRAME",
  RECTANGLE: "RECTANGLE",
  ROUNDED_RECTANGLE: "RECTANGLE",
  ELLIPSE: "ELLIPSE",
  LINE: "LINE",
  TEXT: "TEXT",
  VECTOR: "VECTOR",
  BOOLEAN_OPERATION: "BOOLEAN_OPERATION",
  STAR: "VECTOR",
  REGULAR_POLYGON: "VECTOR",
  SYMBOL: "COMPONENT",
  INSTANCE: "INSTANCE",
};

var BLEND_MODES = {
  PASS_THROUGH: "PASS_THROUGH", NORMAL: "NORMAL", DARKEN: "DARKEN", MULTIPLY: "MULTIPLY",
  LINEAR_BURN: "LINEAR_BURN", COLOR_BURN: "COLOR_BURN", LIGHTEN: "LIGHTEN", SCREEN: "SCREEN",
  LINEAR_DODGE: "LINEAR_DODGE", COLOR_DODGE: "COLOR_DODGE", OVERLAY: "OVERLAY",
  SOFT_LIGHT: "SOFT_LIGHT", HARD_LIGHT: "HARD_LIGHT", DIFFERENCE: "DIFFERENCE",
  EXCLUSION: "EXCLUSION", HUE: "HUE", SATURATION: "SATURATION", COLOR: "COLOR",
  LUMINOSITY: "LUMINOSITY",
};

var GRADIENT_TYPES = {
  GRADIENT_LINEAR: "GRADIENT_LINEAR",
  GRADIENT_RADIAL: "GRADIENT_RADIAL",
  GRADIENT_ANGULAR: "GRADIENT_ANGULAR",
  GRADIENT_DIAMOND: "GRADIENT_DIAMOND",
};

var IMAGE_SCALE_MODES = { STRETCH: "CROP", FIT: "FIT", FILL: "FILL", TILE: "TILE" };
var STROKE_ALIGNS = { CENTER: "CENTER", INSIDE: "INSIDE", OUTSIDE: "OUTSIDE" };
var STROKE_CAPS = {
  NONE: "NONE", ROUND: "ROUND", SQUARE: "SQUARE",
  ARROW_LINES: "ARROW_LINES", ARROW_EQUILATERAL: "ARROW_EQUILATERAL",
};
var STROKE_JOINS = { MITER: "MITER", BEVEL: "BEVEL", ROUND: "ROUND" };
// Порядок фиксирован: он же порядок полей в результате `strokeWeights`.
var BORDER_SIDE_KEYS = ["borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"];
var CONSTRAINTS = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX", STRETCH: "STRETCH", SCALE: "SCALE" };
var LAYOUT_MODES = { NONE: "NONE", HORIZONTAL: "HORIZONTAL", VERTICAL: "VERTICAL" };
var AXIS_SIZING = { FIXED: "FIXED", RESIZE_TO_FIT: "AUTO" };
var PRIMARY_ALIGN = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX", SPACE_EVENLY: "SPACE_BETWEEN" };
var COUNTER_ALIGN = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX" };
var TEXT_ALIGN_H = { LEFT: "LEFT", CENTER: "CENTER", RIGHT: "RIGHT", JUSTIFIED: "JUSTIFIED" };
var TEXT_ALIGN_V = { TOP: "TOP", CENTER: "CENTER", BOTTOM: "BOTTOM" };
var TEXT_AUTO_RESIZE = { NONE: "NONE", WIDTH_AND_HEIGHT: "WIDTH_AND_HEIGHT", HEIGHT: "HEIGHT" };
/**
 * Обрезание текста многоточием. У этого enum в схеме `.pix` ЕСТЬ нулевое
 * значение (`DISABLED = 0`), поэтому отсутствие поля здесь действительно
 * означает `DISABLED`, и переносить нужно только `ENDING`. Сравни с
 * `TEXT_AUTO_RESIZE`, где нуля нет и отсутствие означает обратное.
 */
var TEXT_TRUNCATION = { DISABLED: "DISABLED", ENDING: "ENDING" };
var TEXT_CASE = {
  ORIGINAL: "ORIGINAL", UPPER: "UPPER", LOWER: "LOWER", TITLE: "TITLE",
  SMALL_CAPS: "SMALL_CAPS", SMALL_CAPS_FORCED: "SMALL_CAPS_FORCED",
};
var TEXT_DECORATION = { NONE: "NONE", UNDERLINE: "UNDERLINE", STRIKETHROUGH: "STRIKETHROUGH" };
var LEADING_TRIM = { NONE: "NONE", CAP_HEIGHT: "CAP_HEIGHT" };
/**
 * Поля типографики, которыми в Figma управляет САМ `TextStyle`. Выравнивание,
 * авторазмер и заливка сюда не входят: это свойства узла, а не стиля.
 */
var TEXT_STYLE_FIELDS = [
  "fontName", "fontSize", "lineHeight", "letterSpacing",
  "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "leadingTrim",
];
var WINDING_RULES = { NONZERO: "NONZERO", ODD: "EVENODD" };
var MASK_TYPES = { ALPHA: "ALPHA", OUTLINE: "VECTOR", LUMINANCE: "LUMINANCE" };
var BOOLEAN_OPERATIONS = { UNION: "UNION", SUBTRACT: "SUBTRACT", INTERSECT: "INTERSECT", EXCLUDE: "EXCLUDE" };
var EFFECT_TYPES = {
  DROP_SHADOW: "DROP_SHADOW",
  INNER_SHADOW: "INNER_SHADOW",
  FOREGROUND_BLUR: "LAYER_BLUR",
  BACKGROUND_BLUR: "BACKGROUND_BLUR",
};

/**
 * Команды бинарного пути в blob геометрии.
 * Набор проверен на всех geometry-blob фикстуры: разбор совпал с длиной байт
 * до последнего байта. Незнакомый опкод — это отказ, а не догадка о длине.
 */
var PATH_COMMANDS = { 0: { letter: "Z", args: 0 }, 1: { letter: "M", args: 2 }, 2: { letter: "L", args: 2 }, 4: { letter: "C", args: 6 } };

function finite(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

function round(value) {
  // Пять знаков: путь и координаты не должны раздувать JSON транспорта.
  return Math.round(value * 100000) / 100000;
}

// ---------------------------------------------------------------------------
// Нормализатор
// ---------------------------------------------------------------------------

/**
 * @param {object} doc результат PixDocument.load
 * @param {object} sink приёмник диагностики: { unsupported(code, detail), asset(hash) }
 */
function createNormalizer(doc, sink) {
  function report(code, detail) {
    if (sink && sink.unsupported) sink.unsupported(code, detail);
  }

  /** Цвет Pixso приходит в диапазоне 0..255, Figma ждёт 0..1. */
  function color(value) {
    if (!value) return null;
    return {
      r: round(finite(value.r, 0) / 255),
      g: round(finite(value.g, 0) / 255),
      b: round(finite(value.b, 0) / 255),
    };
  }

  function alpha(value) {
    if (!value || typeof value.a !== "number") return 1;
    return round(Math.min(1, Math.max(0, value.a / 255)));
  }

  function gradientTransform(matrix) {
    if (!matrix) return null;
    return [
      [finite(matrix.m00, 1), finite(matrix.m01, 0), finite(matrix.m02, 0)],
      [finite(matrix.m10, 0), finite(matrix.m11, 1), finite(matrix.m12, 0)],
    ];
  }

  function paint(source, context) {
    if (!source) return null;
    if (source.visible === false) return null;
    var type = source.type;

    if (type === "SOLID") {
      // Прозрачность живёт в двух местах: `opacity` и альфа цвета. Это одно и
      // то же значение, поэтому его нельзя перемножать — только выбрать.
      var opacity = typeof source.opacity === "number" ? source.opacity : alpha(source.color);
      return {
        type: "SOLID",
        color: color(source.color) || { r: 0, g: 0, b: 0 },
        opacity: round(Math.min(1, Math.max(0, finite(opacity, 1)))),
        blendMode: BLEND_MODES[source.blendMode] || "NORMAL",
      };
    }

    if (GRADIENT_TYPES[type]) {
      var stops = (source.stops || []).map(function (stop) {
        var stopColor = color(stop.color) || { r: 0, g: 0, b: 0 };
        stopColor.a = alpha(stop.color);
        return { color: stopColor, position: round(finite(stop.position, 0)) };
      });
      if (!stops.length) return null;
      return {
        type: GRADIENT_TYPES[type],
        gradientStops: stops,
        gradientTransform: gradientTransform(source.transform) || [[1, 0, 0], [0, 1, 0]],
        opacity: round(finite(source.opacity, 1)),
        blendMode: BLEND_MODES[source.blendMode] || "NORMAL",
      };
    }

    if (type === "IMAGE") {
      var hash = source.image && source.image.hash && source.image.hash.length
        ? Buffer.from(source.image.hash).toString("hex")
        : null;
      if (!hash) {
        report(UNSUPPORTED.PAINT_IMAGE_MISSING, context);
        return null;
      }
      var assetId = sink && sink.asset ? sink.asset(hash) : hash;
      if (!assetId) {
        report(UNSUPPORTED.PAINT_IMAGE_MISSING, hash);
        return null;
      }
      var mapped = {
        type: "IMAGE",
        assetId: assetId,
        scaleMode: IMAGE_SCALE_MODES[source.imageScaleMode] || "FILL",
        opacity: round(finite(source.opacity, 1)),
        blendMode: BLEND_MODES[source.blendMode] || "NORMAL",
      };
      if (mapped.scaleMode === "CROP") {
        mapped.imageTransform = gradientTransform(source.transform) || [[1, 0, 0], [0, 1, 0]];
      }
      if (mapped.scaleMode === "TILE") mapped.scalingFactor = round(finite(source.scale, 1));
      if (typeof source.rotation === "number") mapped.rotation = round(source.rotation);
      return mapped;
    }

    report(UNSUPPORTED.PAINT_TYPE, String(type));
    return null;
  }

  function paints(list, context) {
    if (!list) return undefined;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var mapped = paint(list[i], context);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  /**
   * Paint-поле Kiwi сохраняет presence: отсутствующее поле декодируется как
   * `undefined`, а явно записанный пустой repeated field — как `[]`. Поэтому
   * стиль разрешается только при ОТСУТСТВИИ локального paint-поля. Пустой
   * локальный список намеренно очищает стиль и не имеет права к нему откатиться.
   *
   * Это правило верно для ОБЫЧНОГО узла: его запись — полное состояние.
   * Для записи override (дельты) действует другое правило, см.
   * `overrideRepeated` и `overridePaints` ниже.
   */
  function effectivePaints(source, paintField, styleField) {
    if (!source) return undefined;
    if (Object.prototype.hasOwnProperty.call(source, paintField)) return source[paintField];
    return source[styleField] ? styleNodePaints(source[styleField]) : undefined;
  }

  /** То же presence-правило для эффектов. */
  function effectiveEffects(source) {
    if (!source) return undefined;
    if (Object.prototype.hasOwnProperty.call(source, "effects")) return source.effects;
    return source.inheritEffectStyleID ? styleNodeEffects(source.inheritEffectStyleID) : undefined;
  }

  /**
   * Repeated-поле ЗАПИСИ OVERRIDE.
   *
   * У обычного узла запись — полное состояние, и пустой repeated list значил бы
   * «ничего нет». У записи override запись — дельта, и сериализатор Pixso ведёт
   * себя иначе: он выписывает repeated-поле пустым списком как ЗАГЛУШКУ поля,
   * которое вхождение не переопределяет.
   *
   * Это не догадка, а измерение. На двух независимых реальных документах:
   *
   *   обычные узлы  — `fillPaints` либо отсутствует (FRAME/GROUP/SYMBOL: 4900+
   *                   записей), либо непустой (7000+). Пустого списка нет
   *                   НИ ОДНОГО на 12000 узлов каждого файла: «заливки нет»
   *                   Pixso кодирует ОТСУТСТВИЕМ поля;
   *   записи override — `fillPaints` пустой 19599 раз, `vectorPaints` пустой
   *                   14756 раз (100% вхождений поля), `fontVariations` — 8560
   *                   (100%), `prototypeInteractions` — 2295 (100%),
   *                   `toggledOnOTFeatures` — 2568 (100%).
   *
   * Поле, которое ВСЕГДА приходит пустым, не может означать «очистить»: это
   * заглушка сериализатора. А раз у формата нет наблюдаемого представления
   * «очистить заливку» в дельте (её представляет отсутствие поля, как и у
   * обычного узла), пустой список в записи override не несёт операции.
   *
   * Возвращает `undefined` — «поля нет», ровно как при физическом отсутствии.
   */
  function overrideRepeated(source, field) {
    if (!source) return undefined;
    var value = source[field];
    if (!Array.isArray(value) || !value.length) return undefined;
    return value;
  }

  /**
   * Список стиля для записи override. Нулевой GUID (`0:0`) — это объект, а не
   * `undefined`, и приходит он в записях, выписывающих сразу весь блок стилей
   * (`inheritFillStyleID`, `inheritStrokeStyleID`, `inheritEffectStyleID`,
   * `inheritGridStyleID` рядом). Нуль там значит «стиля такого рода нет», а не
   * «сними заливку»: на реальном документе 646 из 712 таких записей адресуют
   * узел с СОБСТВЕННОЙ непустой заливкой. Поэтому неразрешившаяся ссылка не
   * даёт операции вовсе — иначе приёмник получил бы очистку без основания.
   */
  function overrideStyleList(resolved) {
    return Array.isArray(resolved) && resolved.length ? resolved : undefined;
  }

  /**
   * Paint-поле записи override.
   *
   * Узел, привязанный к стилю, ДУБЛИРУЕТ у себя его значение: ссылка
   * `inherit*StyleID` — это идентичность, а список красок рядом — её кэш. Кэш
   * бывает устаревшим, и тогда два поля одной записи говорят разное. Побеждает
   * ссылка, и вот почему это измерено, а не выбрано:
   *
   *   — у ОБЫЧНЫХ узлов проверенного документа расхождения нет вообще:
   *     37016 записей «живой стиль + свои краски» — 37016 совпадений, ноль
   *     расхождений. Их запись — полное состояние, и кэш в ней всегда свеж;
   *   — у записей override расхождений 989 из 40755 (2.4%): дельта переживает
   *     обновление стиля, не переписывая свой кэш;
   *   — у Pixso ЕСТЬ отдельное представление «краска своя, стиля нет»: нулевой
   *     `inherit*StyleID` (121 запись на том же документе). Раз оно есть,
   *     живая ссылка на стиль не может означать «краска рядом важнее» — иначе
   *     нулевая форма была бы не нужна;
   *   — на 26 расхождениях, где автор сам подписал цвет рядом (hex-подпись
   *     в соседнем слое того же вхождения), подпись совпала со СТИЛЕМ 26 раз
   *     из 26 и с сырой краской ни разу.
   *
   * Поэтому: живой и разрешимый стиль записи — это её значение. Нулевая,
   * отсутствующая или неразрешимая ссылка оставляет сырой список, а пустой
   * локальный список остаётся заглушкой и операции не несёт.
   */
  function overridePaints(source, paintField, styleField) {
    if (!source) return undefined;
    var styled = source[styleField]
      ? overrideStyleList(styleNodePaints(source[styleField]))
      : undefined;
    if (styled) return styled;
    return overrideRepeated(source, paintField);
  }

  /** То же для эффектов записи override. */
  function overrideEffects(source) {
    if (!source) return undefined;
    var local = overrideRepeated(source, "effects");
    if (local) return local;
    if (!source.inheritEffectStyleID) return undefined;
    return overrideStyleList(styleNodeEffects(source.inheritEffectStyleID));
  }

  /** Стиль Pixso — это обычный узел документа с заполненным styleType. */
  function styleNodePaints(styleGuid) {
    if (!styleGuid) return null;
    var record = doc.tree.byKey.get(doc.guidKey(styleGuid));
    if (!record) return null;
    var detail = doc.detail(record);
    if (detail.styleType !== "FILL" && detail.styleType !== "STROKE") return null;
    return detail.fillPaints || null;
  }

  function styleNodeEffects(styleGuid) {
    if (!styleGuid) return null;
    var record = doc.tree.byKey.get(doc.guidKey(styleGuid));
    if (!record) return null;
    var detail = doc.detail(record);
    return detail.styleType === "EFFECT" ? detail.effects || null : null;
  }

  /**
   * Типографика текстового стиля Pixso. Тот же приём, что у fill/effect:
   * стиль — обычный узел документа с заполненным `styleType`, поэтому его
   * поля читаются напрямую и переводятся общим отображением.
   */
  function styleNodeText(styleGuid) {
    if (!styleGuid) return null;
    var record = doc.tree.byKey.get(doc.guidKey(styleGuid));
    if (!record) return null;
    var detail = doc.detail(record, { sourceTextStyle: true });
    if (detail.styleType !== "TEXT") return null;
    return sourceTextStyle(detail) || null;
  }

  /** Единый размер глифов узла: то, каким кеглем Pixso текст реально отрисовал. */
  function uniformGlyphFontSize(textData) {
    var glyphs = textData && textData.glyphs;
    if (!Array.isArray(glyphs) || !glyphs.length) return undefined;
    var size;
    for (var i = 0; i < glyphs.length; i++) {
      var current = glyphs[i] && glyphs[i].fontSize;
      if (typeof current !== "number" || !isFinite(current) || current <= 0) return undefined;
      if (size === undefined) size = current;
      else if (Math.abs(size - current) > 0.00001) return undefined;
    }
    return size;
  }

  /**
   * Собственная типографика узла — устаревший кэш, а не местная правка.
   *
   * Узел со стилем может хранить собственный `fontSize`, расходящийся со
   * стилем. Чаще это настоящая местная правка, но не всегда: на двух реальных
   * документах у 26 и у 91 текста собственный размер расходится с
   * глифами — тем, что Pixso отрисовал, — и во ВСЕХ этих случаях глифы
   * совпадают со стилем (случаев «глифы = собственное поле ≠ стиль» среди них
   * нет, без стиля — ни одного). Пример: «Subtitle» Tooltip хранит 12/16, а
   * отрисован стилем web/body/s 14/20 (рамка 51×20).
   *
   * Доказательство только по глифам: читаются они лишь при таком конфликте,
   * иначе разбор узла их пропускает.
   */
  function ownTypographyIsStale(detail, own, styleText) {
    if (typeof own.fontSize !== "number" || typeof styleText.fontSize !== "number") return false;
    if (Math.abs(own.fontSize - styleText.fontSize) < 0.00001) return false;
    var glyphSize = uniformGlyphFontSize(detail.textData);
    if (glyphSize === undefined && detail.guid) {
      var record = doc.tree.byKey.get(doc.guidKey(detail.guid));
      if (record) {
        try { glyphSize = uniformGlyphFontSize(doc.detail(record, { sourceTextStyle: true }).textData); }
        catch (_eGlyphs) { glyphSize = undefined; }
      }
    }
    if (glyphSize === undefined) return false;
    return Math.abs(glyphSize - styleText.fontSize) < 0.00001 &&
      Math.abs(glyphSize - own.fontSize) >= 0.00001;
  }

  /**
   * Типографика ОБЫЧНОГО текстового узла с учётом его текстового стиля.
   *
   * То же presence-правило, что у `effectivePaints`, только по полям: значение
   * стиля служит базой, собственное поле узла её перекрывает. Правило не
   * догадка — на проверенном документе 1186 текстовых узлов из 2949 со ссылкой
   * на TEXT-стиль не несут собственного `fontSize`: размер живёт в стиле, и
   * без наследования такой узел уезжал бы с размером по умолчанию Figma.
   *
   * Выравнивание, авторазмер и заливка сюда не попадают: в Pixso цвет текста —
   * отдельный стиль (`inheritFillStyleID`), а выравнивание — свойство узла.
   */
  function effectiveTypography(detail) {
    var own = overrideText(detail) || {};
    if (!detail.inheritTextStyleID) return own;
    var styleText = styleNodeText(detail.inheritTextStyleID);
    if (!styleText) return own;
    if (ownTypographyIsStale(detail, own, styleText)) {
      if (sink && typeof sink.stat === "function") sink.stat("textOwnTypographyStale");
      own = {};
      Object.keys(overrideText(detail) || {}).forEach(function (field) {
        if (styleText[field] === undefined) own[field] = overrideText(detail)[field];
      });
    }
    var out = {};
    for (var i = 0; i < TEXT_STYLE_FIELDS.length; i++) {
      var field = TEXT_STYLE_FIELDS[i];
      if (styleText[field] !== undefined) out[field] = styleText[field];
    }
    Object.keys(own).forEach(function (field) { out[field] = own[field]; });
    return out;
  }

  function effects(list, context) {
    if (!list) return undefined;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var source = list[i];
      if (!source || source.visible === false) continue;
      var type = EFFECT_TYPES[source.type];
      if (!type) { report(UNSUPPORTED.EFFECT_TYPE, String(source.type)); continue; }
      if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
        out.push({ type: type, radius: round(finite(source.radius, 0)), visible: true });
        continue;
      }
      var shadowColor = color(source.color) || { r: 0, g: 0, b: 0 };
      shadowColor.a = alpha(source.color);
      out.push({
        type: type,
        color: shadowColor,
        offset: {
          x: round(finite(source.offset && source.offset.x, 0)),
          y: round(finite(source.offset && source.offset.y, 0)),
        },
        radius: round(finite(source.radius, 0)),
        spread: round(finite(source.spread, 0)),
        visible: true,
        blendMode: BLEND_MODES[source.blendMode] || "NORMAL",
      });
    }
    return out;
  }

  /**
   * Положение узла. Матрица Pixso — аффинная; поворот вытаскивается из неё
   * только когда он есть, иначе Figma получит лишний rotation и «поедет».
   */
  function placement(detail, context) {
    var matrix = detail.transform;
    var out = { x: 0, y: 0 };
    if (!matrix) return out;
    out.x = round(finite(matrix.m02, 0));
    out.y = round(finite(matrix.m12, 0));
    var m00 = finite(matrix.m00, 1);
    var m01 = finite(matrix.m01, 0);
    var m10 = finite(matrix.m10, 0);
    var m11 = finite(matrix.m11, 1);
    var linearChanged = Math.abs(m00 - 1) > 1e-6 || Math.abs(m01) > 1e-6 ||
      Math.abs(m10) > 1e-6 || Math.abs(m11 - 1) > 1e-6;
    if (linearChanged) {
      var scaleX = Math.sqrt(m00 * m00 + m10 * m10);
      var scaleY = Math.sqrt(m01 * m01 + m11 * m11);
      // Figma relativeTransform keeps unit axes but can represent rotation,
      // reflection and skew. Size/scaling lives in width/height, so a matrix
      // with non-unit axes is the only transform shape we still decline.
      if (Math.abs(scaleX - 1) > 1e-3 || Math.abs(scaleY - 1) > 1e-3) {
        report(UNSUPPORTED.ROTATED_TRANSFORM, context);
      } else {
        out.relativeTransform = [
          [round(m00), round(m01), out.x],
          [round(m10), round(m11), out.y],
        ];
        // Keep the friendly rotation scalar only for a proper orthogonal
        // rotation. Receiver prefers relativeTransform and does not apply both.
        var dot = m00 * m01 + m10 * m11;
        var det = m00 * m11 - m01 * m10;
        if (Math.abs(dot) < 1e-5 && det > 0) {
          out.rotation = round((-Math.atan2(m10, m00) * 180) / Math.PI);
        }
      }
    }
    return out;
  }

  /**
   * Флаг независимых углов у Pixso называется по-разному в разных версиях
   * схемы: спецификация PIX документирует `rectangleCornerRadiiIndependent`,
   * реальные документы (Pixso 3.0.5) пишут ещё и `rectangleCornerToolIndependent`.
   * Оба читаются, но НИ ОДИН из них больше не является условием переноса
   * углов: на проверенном файле 2284 узла несут четыре угловых поля вообще
   * без флага, и 514 из них — с разными значениями (верхние скруглены,
   * нижние прямые). Флаг здесь остаётся диагностикой источника.
   */
  function cornersIndependent(detail) {
    return detail.rectangleCornerRadiiIndependent === true ||
      detail.rectangleCornerToolIndependent === true;
  }

  /** Имена четырёх угловых полей в порядке TL, TR, BR, BL. */
  var CORNER_FIELDS = [
    "rectangleTopLeftCornerRadius",
    "rectangleTopRightCornerRadius",
    "rectangleBottomRightCornerRadius",
    "rectangleBottomLeftCornerRadius",
  ];

  function hasPerCornerRadius(source) {
    for (var i = 0; i < CORNER_FIELDS.length; i++) {
      if (typeof source[CORNER_FIELDS[i]] === "number") return true;
    }
    return false;
  }

  /**
   * Эффективные четыре угла узла.
   *
   * Правило выведено из самого документа, а не из флага:
   *   — есть хотя бы одно поугловое поле → углы задаются ими, отсутствующее
   *     поле означает 0 (kiwi не пишет нулевые скаляры);
   *   — иначе есть `cornerRadius` → все четыре равны ему;
   *   — иначе углов нет.
   *
   * Проверено на реальном файле: узла, у которого присутствуют и
   * `cornerRadius`, и поугловые поля с РАЗНЫМИ значениями, в документе нет,
   * поэтому неоднозначности между двумя источниками не возникает.
   */
  function cornerRadii(source) {
    if (hasPerCornerRadius(source)) {
      return CORNER_FIELDS.map(function (field) {
        return round(finite(source[field], 0));
      });
    }
    if (typeof source.cornerRadius === "number") {
      var uniform = round(source.cornerRadius);
      return [uniform, uniform, uniform, uniform];
    }
    return null;
  }

  /**
   * Углы в терминах приёмника. Равные четыре угла едут одним `cornerRadius`
   * (так их принимает даже узел без поугловых свойств), разные — четырьмя
   * значениями. `radii` присутствует всегда: приёмник по нему восстанавливает
   * результат и на узлах, которые равномерный радиус не поддерживают.
   */
  function cornersFromRadii(radii, source) {
    if (!radii) {
      if (source && typeof source.cornerSmoothing === "number") {
        return { cornerSmoothing: round(source.cornerSmoothing) };
      }
      return undefined;
    }
    var out = {
      topLeftRadius: radii[0],
      topRightRadius: radii[1],
      bottomRightRadius: radii[2],
      bottomLeftRadius: radii[3],
    };
    var uniform = radii[0] === radii[1] && radii[1] === radii[2] && radii[2] === radii[3];
    if (uniform) out.cornerRadius = radii[0];
    else out.independent = true;
    if (source && typeof source.cornerSmoothing === "number") {
      out.cornerSmoothing = round(source.cornerSmoothing);
    }
    return out;
  }

  function corners(detail) {
    return cornersFromRadii(cornerRadii(detail), detail);
  }

  /**
   * Режим оси auto layout контейнера.
   *
   * Значение обязано быть явным. Свежий auto layout Figma приходит с `AUTO`
   * по обеим осям, и присвоенный следом размер такому контейнеру не держится:
   * любая последующая правка содержимого пересчитывает его обратно по
   * контенту. Промолчать здесь — значит отдать решение умолчанию редактора.
   *
   * Отсутствие поля в источнике — не «неизвестная семантика», а измеренный
   * класс: на трёх настоящих документах `stackPrimarySizing` отсутствует
   * ровно у контейнеров БЕЗ детей (2971 из 2971, 842 из 842, 8006 из 8006).
   * Обнимать пустой контейнер не по чему, и единственное представимое в Figma
   * поведение для него — фиксированный размер, который у записи уже есть.
   * Это фоллбек, поэтому он считается отдельным кодом, а не молчит.
   */
  function axisSizing(value, detail) {
    if (AXIS_SIZING[value]) return AXIS_SIZING[value];
    report(UNSUPPORTED.LAYOUT_AXIS_SIZING_ABSENT, String(detail && detail.stackMode));
    return "FIXED";
  }

  function autoLayout(detail, context) {
    var mode = LAYOUT_MODES[detail.stackMode];
    if (detail.stackMode && !mode) {
      report(UNSUPPORTED.LAYOUT_GRID_MODE, String(detail.stackMode));
      return undefined;
    }
    if (!mode || mode === "NONE") return undefined;

    var out = { layoutMode: mode };
    if (typeof detail.stackSpacing === "number") out.itemSpacing = round(detail.stackSpacing);
    if (typeof detail.stackCounterSpacing === "number") out.counterAxisSpacing = round(detail.stackCounterSpacing);

    var left = detail.stackPaddingLeft, right = detail.stackPaddingRight;
    var top = detail.stackPaddingTop, bottom = detail.stackPaddingBottom;
    // Старые документы пишут одно горизонтальное и одно вертикальное поле.
    if (left === undefined && typeof detail.stackHorizontalPadding === "number") left = detail.stackHorizontalPadding;
    if (right === undefined && typeof detail.stackHorizontalPadding === "number") right = detail.stackHorizontalPadding;
    if (top === undefined && typeof detail.stackVerticalPadding === "number") top = detail.stackVerticalPadding;
    if (bottom === undefined && typeof detail.stackVerticalPadding === "number") bottom = detail.stackVerticalPadding;
    // Совсем старое поле: одно значение на обе вертикальные стороны.
    if (top === undefined && typeof detail.stackPadding === "number") top = detail.stackPadding;
    if (bottom === undefined && typeof detail.stackPadding === "number") bottom = detail.stackPadding;
    if (typeof left === "number") out.paddingLeft = round(left);
    if (typeof right === "number") out.paddingRight = round(right);
    if (typeof top === "number") out.paddingTop = round(top);
    if (typeof bottom === "number") out.paddingBottom = round(bottom);

    var primaryAlign = PRIMARY_ALIGN[detail.stackPrimaryAlignItems] || PRIMARY_ALIGN[detail.stackJustify];

    // Pixso sometimes keeps stale stack padding on a FIXED container even
    // though the measured child geometry proves that this padding is not in
    // effect. Figma enforces padding as a hard layout constraint, so a 24px
    // container with a 16px child and stale 20+20 horizontal padding becomes
    // 42px minimum wide. Reconcile only the impossible START-layout case and
    // only from the actual flow-child boxes; centered/distributed layouts are
    // deliberately left untouched because their child position is not a
    // padding measurement.
    var boxes = context && context.flowChildBoxes || [];
    if (((!primaryAlign || primaryAlign === "MIN") || boxes.length === 1) && boxes.length && detail.size) {
      if (mode === "HORIZONTAL" && detail.stackPrimarySizing === "FIXED") {
        var contentWidth = boxes.reduce(function (sum, box) { return sum + finite(box.width, 0); }, 0) +
          Math.max(0, boxes.length - 1) * finite(detail.stackSpacing, 0);
        var declaredHorizontal = finite(left, 0) + finite(right, 0) + contentWidth;
        if (declaredHorizontal > finite(detail.size.x, 0) + 0.01) {
          var firstX = Math.min.apply(Math, boxes.map(function (box) { return finite(box.x, 0); }));
          var lastX = Math.max.apply(Math, boxes.map(function (box) { return finite(box.x, 0) + finite(box.width, 0); }));
          var observedRight = finite(detail.size.x, 0) - lastX;
          if (firstX > 0.01 && observedRight > 0.01) {
            out.paddingLeft = round(Math.max(0, firstX));
            out.paddingRight = round(Math.max(0, observedRight));
          }
        }
      } else if (mode === "VERTICAL" && detail.stackPrimarySizing === "FIXED") {
        var contentHeight = boxes.reduce(function (sum, box) { return sum + finite(box.height, 0); }, 0) +
          Math.max(0, boxes.length - 1) * finite(detail.stackSpacing, 0);
        var declaredVertical = finite(top, 0) + finite(bottom, 0) + contentHeight;
        if (declaredVertical > finite(detail.size.y, 0) + 0.01) {
          var firstY = Math.min.apply(Math, boxes.map(function (box) { return finite(box.y, 0); }));
          var lastY = Math.max.apply(Math, boxes.map(function (box) { return finite(box.y, 0) + finite(box.height, 0); }));
          var observedBottom = finite(detail.size.y, 0) - lastY;
          if (firstY > 0.01 && observedBottom > 0.01) {
            out.paddingTop = round(Math.max(0, firstY));
            out.paddingBottom = round(Math.max(0, observedBottom));
          }
        }
      }
    }
    // Pixso SPACE_EVENLY and Figma SPACE_BETWEEN coincide for 2+ flow
    // children, but differ for a single child: Pixso centers that child while
    // Figma pins it to MIN. Preserve the source geometry instead of merely
    // copying the nearest enum name.
    if (primaryAlign === "SPACE_BETWEEN" && context && context.flowChildCount === 1) {
      primaryAlign = "CENTER";
    }
    if (primaryAlign) out.primaryAxisAlignItems = primaryAlign;
    var counterAlign = COUNTER_ALIGN[detail.stackCounterAlignItems];
    if (counterAlign) out.counterAxisAlignItems = counterAlign;

    out.primaryAxisSizingMode = axisSizing(detail.stackPrimarySizing, detail);
    out.counterAxisSizingMode = axisSizing(detail.stackCounterSizing, detail);
    if (detail.stackWrap === "WRAP") out.layoutWrap = "WRAP";
    if (detail.autoLayoutItemReverseDraw) out.itemReverseZIndex = true;
    // Объявляется всегда, включая false. Запись контейнера — полное состояние:
    // молчание Pixso означает «обводка в раскладку не входит», и коробка
    // источника это подтверждает (SegmentedControl 36 при обводке 1). Без
    // явного false узел получал умолчание Figma и вырастал на толщину обводки
    // (живая сверка 2026-09-17: 36 → 38 и дальше вверх по дереву).
    out.strokesIncludedInLayout = !!detail.autoLayoutIncludeBorders;
    return out;
  }

  /**
   * Поведение узла внутри auto layout родителя.
   *
   * `stackChildPrimarySizing` / `stackChildCounterSizing` — это «как родитель
   * назначает ребёнку размер по своей оси», а не собственный hug ребёнка.
   * Значение `RESIZE_TO_FIT` означает fill, и это измерено на реальном
   * документе, а не выведено из названия:
   *
   *   — по контр-оси размер ребёнка совпал с внутренним размером родителя в
   *     1520 случаях из 1545 (у `FIXED` — 4944 из 8480, то есть совпадение
   *     случайное);
   *   — по главной оси у родителей с фиксированной главной осью дети
   *     заполняли строку без остатка в 1050 случаях из 1077, когда хотя бы
   *     один ребёнок объявлял `RESIZE_TO_FIT`, и лишь в 452 из 1248, когда
   *     не объявлял ни один.
   *
   * `stackCounterAlign` (align-self) в проверенном документе не встречается
   * ни разу, но остаётся поддержанным: STRETCH там значит то же самое.
   * Ребёнок с абсолютным позиционированием из раскладки выключен целиком,
   * поэтому grow/align ему не назначаются.
   */
  function childLayout(detail, parentHasAutoLayout) {
    if (!parentHasAutoLayout) return undefined;
    var out = {};
    if (detail.autoLayoutAbsolutePos) {
      out.layoutPositioning = "ABSOLUTE";
      return out;
    }
    // Обе оси объявляются явно, включая «не заполняет». Умолчание Figma
    // совпадает с ним по значению, но не по смыслу: «поле отсутствует»
    // сейчас означало бы и «источник сказал FIXED», и «источник промолчал»,
    // а приёмнику нужно различать их. Только зная, что ось принадлежит
    // самому ребёнку, он имеет право вернуть ей исходный размер после того,
    // как раскладка Figma его сдвинула.
    out.layoutGrow = detail.stackChildPrimarySizing === "RESIZE_TO_FIT" ? 1 : 0;
    out.layoutAlign = childCounterAlign(detail) || "INHERIT";
    return out;
  }

  /**
   * Границы размера auto layout: `minSize` / `maxSize` записи Pixso.
   *
   * Это не косметика. Именно они удерживают HUG-контейнер на его исходном
   * размере, когда содержимого не хватает: на проверенном документе
   * `table / cell / header / title` обнимает текст высотой 20 и стоит на
   * высоте 24 ровно потому, что у него `minSize.y = 24`. Без них HUG
   * пересчитывается в Figma честно — и приезжает меньше источника.
   *
   * Границы абсолютны по осям: `x` — ширина, `y` — высота, независимо от
   * направления родительской раскладки. Нулевой минимум и «плюс
   * бесконечность» в максимуме — это отсутствие границы, а не граница.
   */
  function sizeBounds(detail) {
    var out = {};
    bound(out, "minWidth", detail.minSize && detail.minSize.x, true);
    bound(out, "minHeight", detail.minSize && detail.minSize.y, true);
    bound(out, "maxWidth", detail.maxSize && detail.maxSize.x, false);
    bound(out, "maxHeight", detail.maxSize && detail.maxSize.y, false);
    return Object.keys(out).length ? out : undefined;
  }

  function bound(out, key, value, isMinimum) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) return;
    // Максимум по умолчанию записан как максимальный float32: это «границы
    // нет», а не «ширина не больше 3.4e38».
    if (!isMinimum && value >= 3.0e38) return;
    out[key] = round(value);
  }

  /**
   * Выравнивание/растяжение ребёнка по контр-оси родителя.
   * Возвращает значение Figma `layoutAlign` либо null, если источник ничего
   * об этом не сказал.
   */
  function childCounterAlign(source) {
    if (source.stackCounterAlign === "STRETCH") return "STRETCH";
    if (source.stackChildCounterSizing === "RESIZE_TO_FIT") return "STRETCH";
    if (COUNTER_ALIGN[source.stackCounterAlign]) return COUNTER_ALIGN[source.stackCounterAlign];
    if (source.stackChildCounterSizing === "FIXED") return "INHERIT";
    return null;
  }

  /**
   * Auto layout ПОВЕРХ уже собранного узла определения.
   *
   * `autoLayout` выше требует `stackMode`: он собирает контейнер с нуля.
   * Запись override приходит частичной — «у этого вхождения другой отступ» —
   * и `stackMode` в ней обычно отсутствует. Поэтому здесь переносятся только
   * фактически присутствующие поля, а режим раскладки остаётся тем, который
   * приёмник уже поставил из определения.
   *
   * Набор полей — документированный: спецификация PIX перечисляет
   * `stackSpacing`, `stackVerticalPadding`, `stackHorizontalPadding`,
   * `stackPaddingRight`, `stackPaddingBottom`, выравнивания и
   * `stackPrimarySizing` / `stackCounterSizing` среди `symbolOverrides[]`.
   * Отображение в имена Figma — то же самое, что у обычного узла.
   */
  function overrideLayout(source, context) {
    var out = {};
    if (source.stackMode !== undefined) {
      var mode = LAYOUT_MODES[source.stackMode];
      if (mode) out.layoutMode = mode;
      else report(UNSUPPORTED.LAYOUT_GRID_MODE, String(source.stackMode));
    }
    if (typeof source.stackSpacing === "number") out.itemSpacing = round(source.stackSpacing);
    if (typeof source.stackCounterSpacing === "number") out.counterAxisSpacing = round(source.stackCounterSpacing);

    var left = source.stackPaddingLeft, right = source.stackPaddingRight;
    var top = source.stackPaddingTop, bottom = source.stackPaddingBottom;
    if (left === undefined && typeof source.stackHorizontalPadding === "number") left = source.stackHorizontalPadding;
    if (right === undefined && typeof source.stackHorizontalPadding === "number") right = source.stackHorizontalPadding;
    if (top === undefined && typeof source.stackVerticalPadding === "number") top = source.stackVerticalPadding;
    if (bottom === undefined && typeof source.stackVerticalPadding === "number") bottom = source.stackVerticalPadding;
    if (typeof left === "number") out.paddingLeft = round(left);
    if (typeof right === "number") out.paddingRight = round(right);
    if (typeof top === "number") out.paddingTop = round(top);
    if (typeof bottom === "number") out.paddingBottom = round(bottom);

    var primaryAlign = PRIMARY_ALIGN[source.stackPrimaryAlignItems] || PRIMARY_ALIGN[source.stackJustify];
    // Override-запись обязана сохранять ту же семантику SPACE_EVENLY, что и
    // базовый autoLayout(): при единственном flow-child Pixso центрирует его,
    // а Figma SPACE_BETWEEN прижимает к MIN. Раньше этот special-case жил
    // только в базовом определении, поэтому occurrence override повторно
    // превращал корректный CENTER в SPACE_BETWEEN.
    if (primaryAlign === "SPACE_BETWEEN" && context && context.flowChildCount === 1) {
      primaryAlign = "CENTER";
    }
    if (primaryAlign) out.primaryAxisAlignItems = primaryAlign;
    var counterAlign = COUNTER_ALIGN[source.stackCounterAlignItems];
    if (counterAlign) out.counterAxisAlignItems = counterAlign;
    if (AXIS_SIZING[source.stackPrimarySizing]) out.primaryAxisSizingMode = AXIS_SIZING[source.stackPrimarySizing];
    if (AXIS_SIZING[source.stackCounterSizing]) out.counterAxisSizingMode = AXIS_SIZING[source.stackCounterSizing];
    if (source.stackWrap === "WRAP") out.layoutWrap = "WRAP";
    if (source.autoLayoutIncludeBorders !== undefined) {
      out.strokesIncludedInLayout = !!source.autoLayoutIncludeBorders;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Поведение вхождения внутри auto layout родителя. Родительский контекст
   * записи override неизвестен, поэтому проверка `parentHasAutoLayout`
   * здесь невозможна: поле просто переносится, а Figma игнорирует его вне
   * auto layout.
   */
  function overrideChildLayout(source) {
    var out = {};
    if (source.autoLayoutAbsolutePos !== undefined) {
      out.layoutPositioning = source.autoLayoutAbsolutePos ? "ABSOLUTE" : "AUTO";
    }
    // В записи override значение «FIXED» — такая же правка, как «RESIZE_TO_FIT»:
    // вхождение может отменять fill, заданный определением, и промолчать
    // здесь значило бы оставить чужой растянутый ребёнок.
    if (source.stackChildPrimarySizing === "RESIZE_TO_FIT") out.layoutGrow = 1;
    else if (source.stackChildPrimarySizing === "FIXED") out.layoutGrow = 0;
    var align = childCounterAlign(source);
    if (align) out.layoutAlign = align;
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Семантика Clip content в бинарном .pix.
   *
   * Публичный Pixso API называет свойство положительно (`clipsContent`),
   * а бинарный формат хранит обратный флаг `frameMaskDisabled`. У Kiwi-поля
   * значение false является default и обычно вообще не сериализуется. Поэтому
   * для собственного FRAME/SECTION/SYMBOL отсутствие `frameMaskDisabled` значит
   * «clipping включён», а не «семантика неизвестна».
   *
   * INSTANCE отличается: отсутствие поля у occurrence означает «не переопределял
   * master», поэтому его оставляем undefined и даём нативному Figma instance
   * унаследовать clipping определения. Явные false/true у occurrence переносятся.
   * GROUP в Pixso содержимое не клипует.
   */
  function clipsContent(source, sourceType) {
    if (!source) return undefined;
    if (sourceType === "GROUP") return false;
    var frameLike = sourceType === "FRAME" || sourceType === "SECTION" ||
      sourceType === "SYMBOL" || sourceType === "INSTANCE";
    if (!frameLike) return undefined;
    var hasFlag = Object.prototype.hasOwnProperty.call(source, "frameMaskDisabled");
    if (hasFlag) return source.frameMaskDisabled !== true;
    if (sourceType === "INSTANCE") return undefined;
    return true;
  }

  /**
   * Эффективные толщины обводки.
   *
   * Pixso держит толщину в двух местах сразу: общий `strokeWeight` и набор
   * `border*Weight` по сторонам. Флаг `borderStrokeWeightsIndependent`,
   * который по названию обязан их различать, в production-документе поднят у
   * 945 узлов из 115 011 и потому не различает ничего: у соседних рамок с
   * одинаковой одной стороной он то есть, то нет (`SideMenu` против
   * `Navigation`). Выбирать по нему — значит выбирать по шуму.
   *
   * Достоверный источник здесь — сам Pixso: рядом он сериализует уже
   * посчитанную им область обводки, `strokePaddingPath`. Замер этой области
   * по 8668 рамочным узлам production-документа даёт ровно три режима:
   *
   *   сторон нет вовсе                    → толщина равна `strokeWeight`;
   *   набор неполон или стороны неравны   → per-side, и ОТСУТСТВУЮЩАЯ
   *                                         сторона означает ноль
   *                                         (`Button/Pressed` — только низ и
   *                                         левый край, `Navigation` — только
   *                                         правый);
   *   все четыре присутствуют и равны     → это зеркало общей толщины, а не
   *                                         независимый режим, и авторитет у
   *                                         `strokeWeight`.
   *
   * Третий режим и терялся. У 506 узлов (`Focus Layer`, `Avatar`) стороны
   * остались от прежней толщины рядом с действующей общей — `4/4/4/4` при
   * `strokeWeight: 5` — и выбор сторон давал рамку не той толщины сразу со
   * ВСЕХ сторон. Замер говорит: нарисовано 5.
   *
   * Режимы взаимоисключающие, поэтому функция возвращает ровно один из двух
   * носителей толщины. Одновременная выдача `uniform` и `sides` означала бы
   * две операции на одну величину, а их порядок на приёмнике решает, какая
   * победит: ровно так `strokeWeight` и прочитывался обратно как
   * `figma.mixed`.
   */
  function strokeWeights(source) {
    if (!source) return { uniform: undefined, sides: undefined };
    var uniform = typeof source.strokeWeight === "number" ? source.strokeWeight : undefined;
    var values = BORDER_SIDE_KEYS.map(function (key) {
      return typeof source[key] === "number" ? source[key] : null;
    });
    var declared = values.filter(function (value) { return value !== null; });
    if (!declared.length) return { uniform: uniform, sides: undefined };

    var mirrorsUniform = declared.length === BORDER_SIDE_KEYS.length &&
      declared.every(function (value) { return Math.abs(value - declared[0]) <= 1e-6; });
    // Полный и равный набор — зеркало. `strokeWeight` главнее, но если его в
    // записи нет, само зеркало и есть единственное измеренное значение.
    if (mirrorsUniform) {
      var effective = uniform === undefined ? declared[0] : uniform;
      return { uniform: effective, sides: undefined };
    }

    return {
      uniform: undefined,
      sides: {
        top: values[0] === null ? 0 : values[0],
        right: values[1] === null ? 0 : values[1],
        bottom: values[2] === null ? 0 : values[2],
        left: values[3] === null ? 0 : values[3],
      },
    };
  }

  /** Независимые толщины по сторонам — только когда режим действительно такой. */
  function borderWeights(source) {
    return strokeWeights(source).sides;
  }

  /**
   * То же для ВХОЖДЕНИЯ, где отсутствие поля значит другое.
   *
   * У собственного узла запись полна: сторона, которой в ней нет, не
   * нарисована, и ноль — её измеренное значение. У вхождения запись это
   * дельта поверх определения, и отсутствующая сторона означает «не
   * переопределял». Ноль на её месте стирает грань, которую вхождение не
   * трогало.
   *
   * Так уже устроены заливки: у ORDINARY пустой список значит «нет заливки»,
   * у INSTANCE — «как в определении». Для обводки это различие не было
   * проведено, и одна запись `borderLeftWeight: 1` превращалась в
   * `0/0/0/1` — три грани рамки исчезали. В прогоне это 25 операций на
   * `Input Container`, у которого определение несёт полную рамку.
   *
   * Полный и равный набор остаётся зеркалом общей толщины: он описывает
   * рамку целиком, и наследовать там нечего.
   */
  function overrideBorderWeights(source) {
    if (!source) return undefined;
    var values = BORDER_SIDE_KEYS.map(function (key) {
      return typeof source[key] === "number" ? source[key] : undefined;
    });
    var declared = values.filter(function (value) { return value !== undefined; });
    if (!declared.length) return undefined;
    var mirrorsUniform = declared.length === BORDER_SIDE_KEYS.length &&
      declared.every(function (value) { return Math.abs(value - declared[0]) <= 1e-6; });
    if (mirrorsUniform) return undefined;
    return { top: values[0], right: values[1], bottom: values[2], left: values[3] };
  }

  /** Оформление обводки, отделённое от самих paint-ов. */
  function overrideStroke(source) {
    var out = {};
    var align = STROKE_ALIGNS[source.strokeAlign];
    if (align) out.strokeAlign = align;
    var join = STROKE_JOINS[source.strokeJoin];
    if (join) out.strokeJoin = join;
    if (source.strokeCap !== undefined) {
      if (STROKE_CAPS[source.strokeCap]) out.strokeCap = STROKE_CAPS[source.strokeCap];
      else report(UNSUPPORTED.STROKE_CAP, String(source.strokeCap));
    }
    if (source.dashPattern && source.dashPattern.length) out.dashPattern = source.dashPattern.slice();
    var weights = overrideBorderWeights(source);
    if (weights) out.borderWeights = weights;
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Типографика вхождения без самого текста: `characters` — отдельная
   * операция, у неё своя загрузка шрифта на приёмнике.
   *
   * Поля документированы спецификацией PIX как `symbolOverrides[].fontSize`,
   * `.font`, `.alignHorizontal`, `.alignVertical`, `.lineHeight`,
   * `.letterSpacing`, `.autoResize`, `.paragraphSpacing`.
   */
  function overrideText(source) {
    var out = {};
    if (source.fontName && source.fontName.family) {
      out.fontName = { family: source.fontName.family, style: source.fontName.style || "Regular" };
    }
    if (typeof source.fontSize === "number") out.fontSize = round(source.fontSize);
    if (TEXT_ALIGN_H[source.textAlignHorizontal]) out.textAlignHorizontal = TEXT_ALIGN_H[source.textAlignHorizontal];
    if (TEXT_ALIGN_V[source.textAlignVertical]) out.textAlignVertical = TEXT_ALIGN_V[source.textAlignVertical];
    if (TEXT_AUTO_RESIZE[source.textAutoResize]) out.textAutoResize = TEXT_AUTO_RESIZE[source.textAutoResize];
    if (TEXT_CASE[source.textCase]) out.textCase = TEXT_CASE[source.textCase];
    if (TEXT_DECORATION[source.textDecoration]) out.textDecoration = TEXT_DECORATION[source.textDecoration];
    if (LEADING_TRIM[source.leadingTrim]) out.leadingTrim = LEADING_TRIM[source.leadingTrim];
    if (typeof source.hangingPunctuation === "boolean") out.hangingPunctuation = source.hangingPunctuation;
    if (typeof source.hangingList === "boolean") out.hangingList = source.hangingList;
    if (typeof source.paragraphSpacing === "number") out.paragraphSpacing = round(source.paragraphSpacing);
    if (typeof source.paragraphIndent === "number") out.paragraphIndent = round(source.paragraphIndent);
    var lineHeight = numberValue(source.lineHeight, true);
    if (lineHeight) out.lineHeight = lineHeight;
    var letterSpacing = numberValue(source.letterSpacing, false);
    if (letterSpacing) out.letterSpacing = letterSpacing;
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Typography самого source TEXT style-definition.
   * Top-level presence всегда выигрывает. Если `fontSize` там нет,
   * принимаем source `textData.glyphs` только при одном одинаковом
   * положительном значении. Consumer TEXT nodes сюда не передаются.
   */
  function sourceTextStyle(source) {
    var out = overrideText(source) || {};
    if (!Object.prototype.hasOwnProperty.call(source, "fontSize")) {
      var glyphs = source && source.textData && source.textData.glyphs;
      var glyphFontSize;
      if (Array.isArray(glyphs) && glyphs.length) {
        for (var i = 0; i < glyphs.length; i++) {
          var current = glyphs[i] && glyphs[i].fontSize;
          if (typeof current !== "number" || !isFinite(current) || current <= 0) {
            glyphFontSize = undefined;
            break;
          }
          if (glyphFontSize === undefined) glyphFontSize = current;
          else if (Math.abs(glyphFontSize - current) > 0.00001) {
            glyphFontSize = undefined;
            break;
          }
        }
      }
      if (glyphFontSize !== undefined) out.fontSize = round(glyphFontSize);
    }
    return Object.keys(out).length ? out : undefined;
  }

  function constraints(detail) {
    var horizontal = detail.horizontalConstraint;
    var vertical = detail.verticalConstraint;
    if (!horizontal && !vertical) return undefined;
    var out = {};
    if (horizontal) {
      if (CONSTRAINTS[horizontal]) out.horizontal = CONSTRAINTS[horizontal];
      else report(UNSUPPORTED.CONSTRAINT_TYPE, String(horizontal));
    }
    if (vertical) {
      if (CONSTRAINTS[vertical]) out.vertical = CONSTRAINTS[vertical];
      else report(UNSUPPORTED.CONSTRAINT_TYPE, String(vertical));
    }
    return out.horizontal || out.vertical
      ? { horizontal: out.horizontal || "MIN", vertical: out.vertical || "MIN" }
      : undefined;
  }

  function numberValue(source, allowAuto) {
    if (!source || typeof source.value !== "number") return undefined;
    if (source.units === "PIXELS") return { value: round(source.value), unit: "PIXELS" };
    if (source.units === "PERCENT") {
      // В бинарном PIX процентные text metrics хранятся коэффициентом:
      // line-height 120% приходит как 1.2, tracking -1% как -0.01. Figma
      // Plugin API, напротив, ждёт процентные пункты (120 / -1). Это видно
      // и на реальном документе, и в публичной модели Pixso, где внешнее
      // представление lineHeight уже записано как value=100 PERCENT.
      //
      // Синтетические/старые JSON-пакеты могли уже содержать процентные
      // пункты. Значения большой величины не масштабируем повторно. Для
      // line-height коэффициент практически всегда положительный ~0.5..3;
      // для tracking внутренний коэффициент лежит в малой окрестности нуля.
      var rawPercent = source.value;
      var looksLikeRatio = allowAuto
        ? rawPercent > 0 && rawPercent <= 10
        : Math.abs(rawPercent) <= 0.25;
      return { value: round(looksLikeRatio ? rawPercent * 100 : rawPercent), unit: "PERCENT" };
    }
    // RAW у Pixso означает «как есть»: для межстрочного это авто-высота Figma,
    // для трекинга однозначного соответствия нет — поле не выставляем.
    if (allowAuto && source.units === "RAW") return { unit: "AUTO" };
    return undefined;
  }

  function text(detail, context) {
    var data = detail.textData || {};
    var out = { characters: typeof data.characters === "string" ? data.characters : "" };
    // Типографика берётся эффективной: собственные поля узла поверх полей его
    // текстового стиля. Отсутствие поля у узла со стилем означает
    // наследование, а не значение по умолчанию Figma.
    var typography = effectiveTypography(detail);
    Object.keys(typography).forEach(function (field) { out[field] = typography[field]; });
    if (TEXT_ALIGN_H[detail.textAlignHorizontal]) out.textAlignHorizontal = TEXT_ALIGN_H[detail.textAlignHorizontal];
    if (TEXT_ALIGN_V[detail.textAlignVertical]) out.textAlignVertical = TEXT_ALIGN_V[detail.textAlignVertical];
    // Авторазмер объявляется ВСЕГДА, даже когда источник о нём промолчал.
    //
    // `TextAutoResize` в схеме `.pix` — enum БЕЗ нулевого значения
    // (`NONE = 1`, `WIDTH_AND_HEIGHT = 2`, `HEIGHT = 3`), а запись опускает
    // поле, равное умолчанию модели. Поэтому «поля нет» здесь означает не
    // «источник промолчал», а `NONE`: обе оси держит сам узел.
    //
    // Это измерено, а не выведено из схемы. На реальном документе поле
    // отсутствует у 497 TEXT из 3211, и группа отсутствия ведёт себя как
    // фиксированная коробка, а не как измеренная:
    //
    //   ширина на символ (медиана)   WIDTH_AND_HEIGHT 7.17   отсутствие 20.0
    //   высота равна межстрочной     WIDTH_AND_HEIGHT 99.95% отсутствие 60%
    //
    // Узел с авто-высотой не может иметь высоту, отличную от межстрочной, на
    // однострочном содержимом. 40% группы её имеют — значит высота у них
    // задана явно, то есть это `NONE`.
    //
    // Пропуск этого значения оставлял узлу умолчание `figma.createText()`, и
    // объявленная источником фиксированная коробка превращалась в текст,
    // который меряет сам себя.
    var sourceTextAutoResize = TEXT_AUTO_RESIZE[detail.textAutoResize] || "NONE";
    out.textAutoResize = sourceTextAutoResize;
    // Обрезание многоточием — часть семантики РАЗМЕРА, а не оформления:
    // строка, которую Pixso обрезает по одной линии, в Figma без него
    // переносится, и вместе с ней растёт высота всего HUG-поддерева.
    if (TEXT_TRUNCATION[detail.textTruncation]) out.textTruncation = TEXT_TRUNCATION[detail.textTruncation];
    if (typeof detail.maxLines === "number" && detail.maxLines > 0) out.maxLines = detail.maxLines;

    // Keep source width ownership exactly. `ENDING` and `maxLines` describe
    // what happens *if* the text meets a width boundary; they do not create
    // that boundary. Turning WIDTH_AND_HEIGHT into HEIGHT freezes the current
    // master width and breaks component text overrides (for example, a HUG
    // label whose master says "Label" but whose occurrence contains a longer
    // caption). A real bounded text node already arrives as NONE/HEIGHT or is
    // placed on a parent-owned FILL axis, so no width has to be invented here.

    var fills = effectivePaints(detail, "fillPaints", "inheritFillStyleID");
    var mappedFills = paints(fills, context);
    if (mappedFills) out.fills = mappedFills;

    var segments = textSegments(data, context);
    if (segments && segments.length) out.segments = segments;
    return out;
  }

  /**
   * Mixed text styles in Pixso are stored as a style table plus one style id
   * per character. Convert the table into contiguous UTF-16 ranges, which is
   * exactly the addressing model used by Figma's setRange* API.
   */
  function textSegments(data, context) {
    if (!data || !Array.isArray(data.styleOverrideTable) || !data.styleOverrideTable.length ||
        !Array.isArray(data.characterStyleIDs) || !data.characterStyleIDs.length) return undefined;
    var byId = Object.create(null);
    for (var i = 0; i < data.styleOverrideTable.length; i++) {
      var source = data.styleOverrideTable[i] || {};
      if (typeof source.styleID !== "number") continue;
      var style = overrideText(source) || {};
      var localFills = effectivePaints(source, "fillPaints", "inheritFillStyleID");
      var mapped = paints(localFills, context);
      if (mapped) style.fills = mapped;
      byId[source.styleID] = style;
    }
    var chars = typeof data.characters === "string" ? data.characters : "";
    var ids = data.characterStyleIDs;
    var boundaries = [0];
    if (ids.length === chars.length) {
      for (var b = 0; b < ids.length; b++) boundaries.push(b + 1);
    } else {
      var offset = 0;
      Array.from(chars).forEach(function (ch) { offset += ch.length; boundaries.push(offset); });
      if (boundaries.length !== ids.length + 1) {
        report(UNSUPPORTED.TEXT_RANGE_STYLE, context);
        return undefined;
      }
    }
    var out = [];
    var start = 0;
    while (start < ids.length) {
      var id = ids[start];
      var end = start + 1;
      while (end < ids.length && ids[end] === id) end += 1;
      if (id && byId[id] && Object.keys(byId[id]).length) {
        out.push(Object.assign({ start: boundaries[start], end: boundaries[end] }, byId[id]));
      }
      start = end;
    }
    return out.length ? out : undefined;
  }

  /**
   * Бинарный blob геометрии → список команд `{ letter, numbers }`.
   *
   * Единственная точка разбора формата пути Pixso. И строка `vectorPaths`,
   * и сеть регионов строятся из одного и того же результата: два независимых
   * читателя одного бинарного формата рано или поздно разошлись бы в углах.
   */
  function commandsFromBlob(bytes) {
    if (!bytes || !bytes.length) return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var offset = 0;
    var commands = [];
    while (offset < bytes.length) {
      var command = PATH_COMMANDS[bytes[offset]];
      if (!command) return null;
      offset += 1;
      if (offset + command.args * 4 > bytes.length) return null;
      var numbers = [];
      for (var i = 0; i < command.args; i++) {
        numbers.push(round(view.getFloat32(offset, true)));
        offset += 4;
      }
      commands.push({ letter: command.letter, numbers: numbers });
    }
    return commands;
  }

  /** Бинарный blob геометрии → строка пути SVG для `vectorPaths`. */
  function pathFromBlob(bytes) {
    var commands = commandsFromBlob(bytes);
    if (!commands) return null;
    var parts = [];
    for (var i = 0; i < commands.length; i++) {
      var command = commands[i];
      parts.push(command.numbers.length
        ? command.letter + " " + command.numbers.join(" ")
        : command.letter);
    }
    return parts.join(" ");
  }

  function vectorPathsFromGeometry(geometry, context) {
    if (!geometry || !geometry.length) return undefined;
    var out = [];
    for (var i = 0; i < geometry.length; i++) {
      var rule = WINDING_RULES[geometry[i].windingRule];
      if (!rule) {
        report(UNSUPPORTED.VECTOR_WINDING_RULE, String(geometry[i].windingRule));
        return undefined;
      }
      var data = pathFromBlob(doc.blob(geometry[i].blobIndex));
      if (!data) {
        report(UNSUPPORTED.VECTOR_GEOMETRY, context);
        return undefined;
      }
      out.push({ windingRule: rule, data: data });
    }
    return out.length ? out : undefined;
  }

  function vectorPaths(detail, context) {
    return vectorPathsFromGeometry(detail.fillGeometry, context);
  }

  /**
   * Замыкание контура: расстояние, ниже которого конечная точка признаётся
   * стартовой. Координаты пути приходят float32 и уже округлены до пяти
   * знаков, поэтому точное равенство здесь неприменимо.
   */
  var LOOP_CLOSE_EPSILON = 1e-4;

  /**
   * Один путь `fillGeometry` → контуры сети (`loops`) Figma.
   *
   * Вершины и сегменты дописываются в общие массивы узла, возвращаются только
   * индексы сегментов по контурам. Пути в Pixso независимы: общих вершин у
   * соседних регионов нет и выдумывать их нельзя — склейка изменила бы форму.
   */
  function appendRegionLoops(commands, vertices, segments) {
    var loops = [];
    var loop = null;

    function vertex(x, y) {
      vertices.push({ x: round(x), y: round(y) });
      return vertices.length - 1;
    }

    function segment(from, to, tangentStart, tangentEnd) {
      segments.push({
        start: from,
        end: to,
        tangentStart: { x: round(tangentStart.x), y: round(tangentStart.y) },
        tangentEnd: { x: round(tangentEnd.x), y: round(tangentEnd.y) },
      });
      loop.segments.push(segments.length - 1);
      loop.last = to;
    }

    function finishLoop() {
      if (!loop) return;
      if (!loop.segments.length) {
        // `M x y Z` — контур без длины. Вершина остаётся висячей и в сети
        // Figma она лишняя: снимаем её, пока она ещё последняя.
        if (loop.start === vertices.length - 1) vertices.pop();
        loop = null;
        return;
      }
      if (loop.last !== loop.start) {
        var start = vertices[loop.start];
        var last = vertices[loop.last];
        if (Math.abs(last.x - start.x) <= LOOP_CLOSE_EPSILON &&
            Math.abs(last.y - start.y) <= LOOP_CLOSE_EPSILON) {
          // Путь пришёл замкнутым явной конечной точкой. Дублирующая вершина
          // в сети — это разрыв контура, а не совпадение: последний сегмент
          // переводится на стартовую вершину, дубль снимается.
          segments[loop.segments[loop.segments.length - 1]].end = loop.start;
          if (loop.last === vertices.length - 1) vertices.pop();
        } else {
          segments.push({
            start: loop.last,
            end: loop.start,
            tangentStart: { x: 0, y: 0 },
            tangentEnd: { x: 0, y: 0 },
          });
          loop.segments.push(segments.length - 1);
        }
      }
      loops.push(loop.segments);
      loop = null;
    }

    for (var i = 0; i < commands.length; i++) {
      var command = commands[i];
      var numbers = command.numbers;
      if (command.letter === "M") {
        finishLoop();
        var moveTo = vertex(numbers[0], numbers[1]);
        loop = { start: moveTo, last: moveTo, segments: [] };
        continue;
      }
      if (command.letter === "Z") {
        finishLoop();
        continue;
      }
      // Сегмент без открытого контура означает испорченный путь: строить по
      // нему регион нельзя, иначе индексы регионов разъедутся с таблицей.
      if (!loop) return null;
      var from = vertices[loop.last];
      if (command.letter === "L") {
        segment(loop.last, vertex(numbers[0], numbers[1]), { x: 0, y: 0 }, { x: 0, y: 0 });
        continue;
      }
      if (command.letter === "C") {
        var to = vertex(numbers[4], numbers[5]);
        segment(loop.last, to,
          { x: numbers[0] - from.x, y: numbers[1] - from.y },
          { x: numbers[2] - vertices[to].x, y: numbers[3] - vertices[to].y });
        continue;
      }
      return null;
    }
    finishLoop();
    return loops.length ? loops : null;
  }

  /**
   * `fillGeometry` → редактируемая сеть Figma, регион на путь.
   *
   * Порядок регионов здесь тот же, что у `fillGeometry`, и это не соглашение
   * этого кода, а свойство формата: `VectorData.vectorNetworkBlob` хранит
   * ровно столько регионов, сколько путей в `fillGeometry`, и `regionId`
   * таблицы `vectorPaints` адресует именно эту позицию. Поэтому регион,
   * построенный из пути N, — это и есть регион N таблицы.
   *
   * Геометрия берётся из `fillGeometry`, а не из сети Pixso: это ровно те
   * пути, которые уже переносятся через `vectorPaths`. Форма от такой замены
   * не меняется — добавляется только адресуемость региона краской.
   */
  function vectorRegionNetwork(detail, context) {
    var geometry = detail && detail.fillGeometry;
    if (!geometry || !geometry.length) return undefined;
    var vertices = [];
    var segments = [];
    var regions = [];
    for (var i = 0; i < geometry.length; i++) {
      var rule = WINDING_RULES[geometry[i].windingRule];
      if (!rule) {
        report(UNSUPPORTED.VECTOR_WINDING_RULE, String(geometry[i].windingRule));
        return undefined;
      }
      var commands = commandsFromBlob(doc.blob(geometry[i].blobIndex));
      if (!commands) {
        report(UNSUPPORTED.VECTOR_GEOMETRY, context);
        return undefined;
      }
      var loops = appendRegionLoops(commands, vertices, segments);
      if (!loops) {
        report(UNSUPPORTED.VECTOR_REGION_NETWORK, context);
        return undefined;
      }
      regions.push({ windingRule: rule, loops: loops });
    }
    if (!segments.length) return undefined;
    return { vertices: vertices, segments: segments, regions: regions };
  }

  /**
   * Таблица `vectorPaints`: краска отдельного региона вектора.
   *
   * Pixso держит её как ПЕРЕКРЫТИЕ над `fillPaints` узла: регион, которого в
   * таблице нет, красится общей заливкой. Поэтому результат намеренно
   * разрежённый — «нет записи» и «пустой список красок» здесь разные вещи.
   *
   * Запись с чужим `regionId` — это рассинхронизация с геометрией, и раскрасить
   * по ней хоть что-нибудь нельзя: индекс региона ничем другим не проверяется.
   * Такая таблица отклоняется целиком (fail-closed), а не частично.
   */
  function vectorRegionPaints(detail, context) {
    var table = detail && detail.vectorPaints;
    if (!table || !table.length) return undefined;
    var regionCount = (detail.fillGeometry || []).length;
    if (!regionCount) {
      report(UNSUPPORTED.VECTOR_PAINT_TABLE, context);
      return undefined;
    }
    var byRegion = {};
    for (var i = 0; i < table.length; i++) {
      var entry = table[i];
      var index = entry && entry.regionId;
      if (typeof index !== "number" || !isFinite(index) ||
          index < 0 || index >= regionCount || Math.floor(index) !== index) {
        report(UNSUPPORTED.VECTOR_PAINT_TABLE, context);
        return undefined;
      }
      if (Object.prototype.hasOwnProperty.call(byRegion, index)) {
        report(UNSUPPORTED.VECTOR_PAINT_TABLE, context);
        return undefined;
      }
      byRegion[index] = paints(entry.paints || [], context) || [];
    }
    return Object.keys(byRegion).length ? byRegion : undefined;
  }

  /**
   * Decode Pixso/Figma editable vector-network data into open SVG centerlines.
   * The blob format is the same little-endian network used by the Kiwi scene
   * graph: 12-byte header, 12 bytes per vertex and 28 bytes per segment.
   * Segment tangents are relative to their endpoint vertices.
   *
   * Unlike strokeGeometry this is the ORIGINAL centerline, so assigning it to
   * a Figma VectorNode keeps stroke width/caps/joins as stroke semantics and
   * does not inflate zero-height lines into filled layout boxes.
   */
  function vectorNetworkPaths(detail, context) {
    var data = detail && detail.vectorData;
    if (!data || data.vectorNetworkBlob === undefined || data.vectorNetworkBlob === null) return undefined;
    var bytes = doc.blob(data.vectorNetworkBlob);
    if (!bytes || bytes.length < 12) return undefined;
    try {
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var vertexCount = view.getUint32(0, true);
      var segmentCount = view.getUint32(4, true);
      if (!vertexCount || !segmentCount || vertexCount > 500000 || segmentCount > 500000) return undefined;
      var required = 12 + vertexCount * 12 + segmentCount * 28;
      if (required > bytes.length) return undefined;

      var targetSize = detail.size || {};
      var normalizedSize = data.normalizedSize || {};
      var sx = normalizedSize.x > 0 && typeof targetSize.x === "number" ? targetSize.x / normalizedSize.x : 1;
      var sy = normalizedSize.y > 0 && typeof targetSize.y === "number" ? targetSize.y / normalizedSize.y : 1;
      if (!isFinite(sx) || sx <= 0) sx = 1;
      if (!isFinite(sy) || sy <= 0) sy = 1;

      var vertices = [];
      var offset = 12;
      for (var vi = 0; vi < vertexCount; vi++, offset += 12) {
        var vx = view.getFloat32(offset + 4, true);
        var vy = view.getFloat32(offset + 8, true);
        if (!isFinite(vx) || !isFinite(vy)) return undefined;
        vertices.push({ x: vx * sx, y: vy * sy });
      }

      var segments = [];
      for (var si = 0; si < segmentCount; si++, offset += 28) {
        var start = view.getUint32(offset + 4, true);
        var sdx = view.getFloat32(offset + 8, true);
        var sdy = view.getFloat32(offset + 12, true);
        var end = view.getUint32(offset + 16, true);
        var edx = view.getFloat32(offset + 20, true);
        var edy = view.getFloat32(offset + 24, true);
        if (start >= vertices.length || end >= vertices.length || start === end) continue;
        segments.push({
          start: start, end: end,
          sdx: (isFinite(sdx) ? sdx : 0) * sx,
          sdy: (isFinite(sdy) ? sdy : 0) * sy,
          edx: (isFinite(edx) ? edx : 0) * sx,
          edy: (isFinite(edy) ? edy : 0) * sy,
        });
      }
      if (!segments.length) return undefined;

      var unused = new Set();
      for (var ui = 0; ui < segments.length; ui++) unused.add(ui);
      var parts = [];
      function point(index) { return vertices[index]; }
      function emitSegment(seg, reversed) {
        var fromIndex = reversed ? seg.end : seg.start;
        var toIndex = reversed ? seg.start : seg.end;
        var from = point(fromIndex), to = point(toIndex);
        var fromDx = reversed ? seg.edx : seg.sdx;
        var fromDy = reversed ? seg.edy : seg.sdy;
        var toDx = reversed ? seg.sdx : seg.edx;
        var toDy = reversed ? seg.sdy : seg.edy;
        var curved = Math.abs(fromDx) > 0.001 || Math.abs(fromDy) > 0.001 ||
          Math.abs(toDx) > 0.001 || Math.abs(toDy) > 0.001;
        if (curved) {
          parts.push("C " + [
            round(from.x + fromDx), round(from.y + fromDy),
            round(to.x + toDx), round(to.y + toDy),
            round(to.x), round(to.y),
          ].join(" "));
        } else {
          parts.push("L " + round(to.x) + " " + round(to.y));
        }
        return toIndex;
      }

      while (unused.size) {
        var firstIndex = unused.values().next().value;
        var first = segments[firstIndex];
        var startVertex = first.start;
        var current = startVertex;
        var startPoint = point(startVertex);
        parts.push("M " + round(startPoint.x) + " " + round(startPoint.y));
        while (true) {
          var found = -1, reversed = false;
          unused.forEach(function (index) {
            if (found >= 0) return;
            var seg = segments[index];
            if (seg.start === current) { found = index; reversed = false; }
            else if (seg.end === current) { found = index; reversed = true; }
          });
          if (found < 0) break;
          unused.delete(found);
          current = emitSegment(segments[found], reversed);
          if (current === startVertex) {
            parts.push("Z");
            break;
          }
        }
      }
      return parts.length ? [{ windingRule: "NONZERO", data: parts.join(" ") }] : undefined;
    } catch (_eNetwork) {
      report(UNSUPPORTED.VECTOR_GEOMETRY, context);
      return undefined;
    }
  }

  /**
   * `strokeGeometry` is an EXPANDED outline, not the original centerline.
   * It is a useful visual fallback only when flattening that outline cannot
   * change the source layout semantics or destroy per-segment styling.
   *
   * In particular, a vector with width=0/height=0 is a real stroked line in
   * Pixso. Turning its expanded stroke into a filled Figma path gives it a
   * non-zero layout box and can grow HUG parents. Likewise a vector network
   * with positive style ids carries segment-level appearance which one flat
   * paint cannot represent. Gradient strokes are also not safe to flatten:
   * the gradient coordinate space belongs to the stroke, not to the filled
   * outline.
   */
  function canOutlineStrokeGeometry(detail) {
    if (!detail || !detail.strokeGeometry || !detail.strokeGeometry.length) return false;
    if (!detail.size || !(detail.size.x > 0.01) || !(detail.size.y > 0.01)) return false;
    var sourcePaints = (detail.strokePaints || []).filter(function (paint) {
      return paint && paint.visible !== false;
    });
    if (!sourcePaints.length || sourcePaints.some(function (paint) { return paint.type !== "SOLID"; })) {
      return false;
    }
    var table = detail.vectorData && detail.vectorData.styleOverrideTable || [];
    if (table.some(function (entry) {
      return entry && typeof entry.styleID === "number" && entry.styleID >= 0;
    })) return false;
    return true;
  }

  return {
    UNSUPPORTED: UNSUPPORTED,
    SUPPORTED_TYPES: SUPPORTED_TYPES,
    color: color,
    alpha: alpha,
    paint: paint,
    paints: paints,
    effectivePaints: effectivePaints,
    overridePaints: overridePaints,
    overrideEffects: overrideEffects,
    overrideRepeated: overrideRepeated,
    effectiveEffects: effectiveEffects,
    effects: effects,
    placement: placement,
    corners: corners,
    autoLayout: autoLayout,
    childLayout: childLayout,
    sizeBounds: sizeBounds,
    overrideLayout: overrideLayout,
    overrideChildLayout: overrideChildLayout,
    borderWeights: borderWeights,
    strokeWeights: strokeWeights,
    overrideBorderWeights: overrideBorderWeights,
    clipsContent: clipsContent,
    overrideStroke: overrideStroke,
    overrideText: overrideText,
    sourceTextStyle: sourceTextStyle,
    cornersIndependent: cornersIndependent,
    cornerRadii: cornerRadii,
    cornersFromRadii: cornersFromRadii,
    hasPerCornerRadius: hasPerCornerRadius,
    childCounterAlign: childCounterAlign,
    constraints: constraints,
    text: text,
    vectorPaths: vectorPaths,
    vectorPathsFromGeometry: vectorPathsFromGeometry,
    vectorRegionNetwork: vectorRegionNetwork,
    vectorRegionPaints: vectorRegionPaints,
    vectorNetworkPaths: vectorNetworkPaths,
    canOutlineStrokeGeometry: canOutlineStrokeGeometry,
    pathFromBlob: pathFromBlob,
    styleNodePaints: styleNodePaints,
    styleNodeEffects: styleNodeEffects,
    styleNodeText: styleNodeText,
    effectiveTypography: effectiveTypography,
    blendMode: function (value) { return BLEND_MODES[value]; },
    strokeAlign: function (value) { return STROKE_ALIGNS[value]; },
    strokeJoin: function (value) { return STROKE_JOINS[value]; },
    strokeCap: function (value) {
      if (value === undefined) return undefined;
      if (STROKE_CAPS[value]) return STROKE_CAPS[value];
      report(UNSUPPORTED.STROKE_CAP, String(value));
      return undefined;
    },
    maskType: function (value) { return MASK_TYPES[value]; },
    booleanOperation: function (value) { return BOOLEAN_OPERATIONS[value]; },
    report: report,
  };
}

module.exports = {
  createNormalizer: createNormalizer,
  UNSUPPORTED: UNSUPPORTED,
  SUPPORTED_TYPES: SUPPORTED_TYPES,
  PATH_COMMANDS: PATH_COMMANDS,
  TEXT_STYLE_FIELDS: TEXT_STYLE_FIELDS,
};
