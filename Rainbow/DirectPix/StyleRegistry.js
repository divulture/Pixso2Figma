/**
 * Реестр общих стилей Pixso → нативные стили Figma.
 *
 * Стиль Pixso — это ОБЫЧНЫЙ узел документа с заполненным `styleType`. Он лежит
 * на служебном полотне, несёт человекочитаемое имя, необязательное описание,
 * свои значения (краски / эффекты / типографику) и общую идентичность
 * `sharedStyleReference = { styleKey, versionHash }`. Узел-потребитель ссылается
 * на него полями `inheritFillStyleID`, `inheritStrokeStyleID`,
 * `inheritEffectStyleID`, `inheritTextStyleID` и при этом ДУБЛИРУЕТ у себя
 * эффективное значение стиля.
 *
 * Отсюда два независимых утверждения, которые нельзя смешивать:
 *
 *   идентичность стиля   — только ссылка `inherit*StyleID` и `styleKey`;
 *   эффективное значение — то, что реально нарисовано на узле.
 *
 * Наличие у узла сырых красок НЕ означает отсутствия стиля, а совпадение сырых
 * значений у двух не связанных узлов НЕ означает общего стиля.
 *
 * ## Чем отождествляется стиль
 *
 * `styleKey` + подпись нормализованного значения. Ни то, ни другое по
 * отдельности не годится, и это измерение, а не осторожность:
 *
 *   — по guid узла-определения. На проверенных документах 728 и 6999 узлов
 *     стилей против 144 и 317 различных `styleKey`: один общий стиль
 *     дизайн-системы разложен по документу десятками копий (`light/bg/surface1`
 *     — 28 узлов). Один стиль Figma на копию — это не дизайн-система, а мусор;
 *   — по одному `styleKey`. Копии одного `styleKey` НЕ всегда одинаковы: на
 *     проверенном документе 14 групп из 118 несут разные значения
 *     (`light/accent/default` существует и как `#0055FF`, и как `#0F5FFE`) —
 *     это снимки стиля разных версий библиотеки. Склейка по одному ключу
 *     перекрасила бы часть узлов;
 *   — по имени. 19 имён на том же документе принадлежат разным `styleKey`
 *     («shadow/bottom/l» — два разных стиля), поэтому имя не участвует
 *     в идентичности вовсе. Оно воспроизводится, а не сравнивается;
 *   — по одному значению. Два несвязанных стиля с одинаковым цветом обязаны
 *     остаться разными стилями, поэтому `styleKey` из ключа не убирается.
 *
 * `versionHash` в ключ не входит намеренно: он различает снимки, визуально
 * одинаковые (199 групп против 153 по значению), и дробил бы стиль без
 * причины.
 *
 * Ни одно решение не принимается по имени слоя, имени страницы, цвету или
 * известному id. Все они — входные данные.
 */
"use strict";

var PixNormalizer = require("./PixNormalizer");

/** Тип стиля Figma, в который переносится `styleType` Pixso. */
var FIGMA_STYLE_TYPE = {
  FILL: "PAINT",
  STROKE: "PAINT",
  TEXT: "TEXT",
  EFFECT: "EFFECT",
};

/**
 * Поля типографики, которые Figma держит В САМОМ `TextStyle`.
 *
 * Выравнивание, авторазмер и заливка сюда не входят: в Figma это свойства
 * УЗЛА, а не текстового стиля. Цвет текста в Pixso тоже отдельный объект —
 * `inheritFillStyleID` рядом с `inheritTextStyleID`, — и смешивать их значило
 * бы потерять половину связей.
 *
 * Список общий с нормализатором: описание стиля и эффективная типографика узла
 * обязаны говорить об одном и том же наборе полей, иначе сравнение при
 * привязке сравнивало бы разные вещи.
 */
var TEXT_STYLE_FIELDS = PixNormalizer.TEXT_STYLE_FIELDS;

/**
 * Ссылки-пустышки: «стиля такого рода нет».
 *
 * Это не промах адресации, а отсутствие ссылки, и считать их вместе нельзя.
 * `0:0` описан обеими спецификациями как нулевой guid и приходит в записях,
 * выписывающих весь блок стилей целиком: на одном из проверенных документов
 * таких ссылок 20 575 при 34 916 настоящих. Счётчик «не нашли стиль», в
 * который попали бы они, перестал бы что-либо означать.
 *
 * `4294967295:4294967295` — тот же нуль, записанный как максимальный uint;
 * он встречается в дельте вхождения.
 */
var NULL_STYLE_KEYS = {
  "0:0": true,
  "4294967295:4294967295": true,
};

/** Почему ссылка на стиль не превратилась в стиль Figma. */
var STYLE_MISS = {
  // Ссылка есть, но её значение не раскладывается в guid.
  INVALID_GUID: "INVALID_GUID",
  // Ссылка корректна, узла с таким guid в документе нет.
  DEFINITION_NOT_FOUND: "DEFINITION_NOT_FOUND",
  // Узел найден, но это не стиль: `styleType` пуст.
  NOT_A_STYLE_NODE: "NOT_A_STYLE_NODE",
  // Узел — стиль другого рода, чем ждёт поле ссылки.
  STYLE_TYPE_MISMATCH: "STYLE_TYPE_MISMATCH",
  // `styleType`, для которого у Figma нет своего объекта стиля (GRID, EXPORT).
  STYLE_TYPE_UNSUPPORTED: "STYLE_TYPE_UNSUPPORTED",
  // Стиль есть, но переносить в нём нечего: значения не отобразились.
  STYLE_EMPTY: "STYLE_EMPTY",
  // Source TEXT style не несёт явного fontSize, а glyphs не дают
  // одного одинакового значения. Стиль не создаём: Figma default
  // изменил бы source semantics.
  TEXT_FONT_SIZE_UNRESOLVED: "TEXT_FONT_SIZE_UNRESOLVED",
};

/** Почему узел со ссылкой на стиль всё же не получил привязку. */
var BIND_SKIP = {
  // Узел показывает НЕ то, что говорит стиль: у него местное значение.
  // Привязка перекрасила бы узел, поэтому выигрывает местное значение.
  LOCAL_VALUE_WINS: "LOCAL_VALUE_WINS",
  // Эффективного значения у узла нет вовсе — привязывать не к чему.
  NO_EFFECTIVE_VALUE: "NO_EFFECTIVE_VALUE",
};

/** 32-битный FNV-1a: короткий детерминированный ключ подписи значения. */
function hash32(text) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(36);
}

/** Стабильная часть общей идентичности стиля: сам `styleKey` либо guid узла. */
function sharedKeyOf(detail, guidKey) {
  var reference = detail && detail.sharedStyleReference;
  var key = reference && reference.styleKey;
  if (typeof key === "string" && key) return key;
  // Стиль без общей идентичности бывает (на проверенных документах — 1 узел из
  // 7897). Его идентичностью остаётся собственный guid: это ровно то, чем он
  // отличим от других, и склейки с чужим стилем не даёт.
  return "guid:" + guidKey;
}

/** Значимые поля типографики стиля — ровно те, что поддерживает Figma. */
function typographyOf(text) {
  if (!text) return null;
  var out = {};
  for (var i = 0; i < TEXT_STYLE_FIELDS.length; i++) {
    var field = TEXT_STYLE_FIELDS[i];
    if (text[field] !== undefined) out[field] = text[field];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Реестр уровня документа/задачи.
 *
 * @param {object} doc          результат `PixDocument.load`
 * @param {object} normalizer   `PixNormalizer.createNormalizer`
 * @param {object} options      `{ shared }`
 *
 * `shared` — состояние уровня job (см. `MigrationIR.createRegistry`). Без него
 * реестр живёт ровно одну сборку. Ни при каком раскладе состояние одной
 * миграции не может попасть в другую: чужой job создаёт своё `shared`.
 */
function createStyleRegistry(doc, normalizer, options) {
  options = options || {};
  var shared = options.shared || {
    styles: new Map(),      // identity → { styleId, ... } уже отправленные
    byGuid: new Map(),      // guidKey → identity | null (кеш разбора узла)
  };
  var known = shared.styles;
  var byGuid = shared.byGuid;

  // Описания, впервые появившиеся в ЭТОЙ сборке: только они уезжают в пакет.
  // Повторная встреча стиля в другом root даёт ссылку, а не второе описание.
  var emitted = new Map();
  // Стили, СОЗДАННЫЕ этой сборкой. Отдельное множество, потому что `known` —
  // реестр всего job: стиль, уехавший с прошлым root, там уже лежит, и без
  // этого различения он уезжал бы заново с каждым следующим корнем.
  var createdHere = new Set();

  var stats = {
    // Сколько РАЗЛИЧНЫХ общих стилей источника найдено, по типу Pixso.
    sourceStylesByType: Object.create(null),
    // Сколько узлов-определений стиля за ними стоит: разница между этими
    // двумя величинами и есть дедупликация копий.
    sourceStyleNodesSeen: 0,
    stylesEmitted: Object.create(null),
    // Ссылки-пустышки: «стиля такого рода нет». Промахом не считаются,
    // но и молча пропасть не имеют права.
    nullReferences: 0,
    // Ссылки, не превратившиеся в стиль, по причине.
    referencesUnresolved: 0,
    unresolvedByReason: Object.create(null),
    // Определения стиля, для которых у Figma нет объекта (GRID, EXPORT).
    definitionsUnsupported: Object.create(null),
    // Привязки, отменённые в пользу местного значения узла.
    bindingsSkipped: 0,
    bindingsSkippedByReason: Object.create(null),
    // Разные общие стили, попавшие в одно человекочитаемое имя. Не ошибка:
    // так устроен источник. Величина нужна, чтобы одинаковые имена в панели
    // Figma не выглядели дефектом переноса.
    nameCollisions: 0,
    textStyleFontSize: {
      topLevel: 0,
      glyphUniform: 0,
      glyphAmbiguous: 0,
    },
  };
  var nameOwners = new Map();
  var missSamples = [];

  function noteMiss(reason, detail) {
    stats.referencesUnresolved += 1;
    stats.unresolvedByReason[reason] = (stats.unresolvedByReason[reason] || 0) + 1;
    if (missSamples.length < 20 && detail) missSamples.push({ reason: reason, detail: String(detail).slice(0, 120) });
  }

  function noteSkip(reason) {
    stats.bindingsSkipped += 1;
    stats.bindingsSkippedByReason[reason] = (stats.bindingsSkippedByReason[reason] || 0) + 1;
  }

  /**
   * Стиль подходит полю ссылки — только тогда он попадает в пакет.
   *
   * Проверка рода обязана стоять ПЕРЕД выпуском описания: `inheritTextStyleID`,
   * указывающий на FILL-стиль, не должен создавать в Figma стиль, который
   * никто не свяжет.
   */
  function accept(entry, guidKey, expected) {
    if (!entry) return null;
    if (entry.figmaType !== expected) {
      noteMiss(STYLE_MISS.STYLE_TYPE_MISMATCH, guidKey + " → " + entry.figmaType);
      return null;
    }
    if (createdHere.has(entry.identity) && !emitted.has(entry.styleId)) {
      emitted.set(entry.styleId, {
        styleId: entry.styleId,
        styleType: entry.figmaType,
        sourceStyleType: entry.sourceStyleType,
        sourceKey: entry.sourceKey,
        sourceGuid: entry.sourceGuid,
        name: entry.name,
        description: entry.description,
        paints: entry.value.paints,
        effects: entry.value.effects,
        text: entry.value.text,
      });
      stats.stylesEmitted[entry.figmaType] = (stats.stylesEmitted[entry.figmaType] || 0) + 1;
    }
    return entry;
  }

  /**
   * Описание стиля по ссылке. Возвращает `null`, если ссылка ни во что не
   * разрешается, — молча этого не происходит ни разу: каждый отказ считается
   * с причиной.
   *
   * @param {*} styleGuid ссылка из `inherit*StyleID`
   * @param {string} expected какого рода стиль ждёт поле: "PAINT" | "TEXT" | "EFFECT"
   */
  function describe(styleGuid, expected) {
    if (!styleGuid) return null;
    var guidKey = doc.guidKey(styleGuid);
    if (!guidKey) { noteMiss(STYLE_MISS.INVALID_GUID, null); return null; }
    if (NULL_STYLE_KEYS[guidKey]) { stats.nullReferences += 1; return null; }

    var cached = byGuid.get(guidKey);
    if (cached !== undefined) {
      if (cached === null) return null;
      return accept(known.get(cached), guidKey, expected);
    }

    var record = doc.tree.byKey.get(guidKey);
    if (!record) { byGuid.set(guidKey, null); noteMiss(STYLE_MISS.DEFINITION_NOT_FOUND, guidKey); return null; }
    var detail = doc.detail(record);
    var pixType = detail.styleType;
    if (!pixType || pixType === "NONE") {
      byGuid.set(guidKey, null);
      noteMiss(STYLE_MISS.NOT_A_STYLE_NODE, guidKey);
      return null;
    }
    stats.sourceStyleNodesSeen += 1;
    var figmaType = FIGMA_STYLE_TYPE[pixType];
    if (!figmaType) {
      // GRID и EXPORT существуют в документе, но объекта стиля такого рода у
      // Figma Plugin API нет. Это не промах адресации, а отсутствие цели:
      // считается отдельно и остаётся видимым в отчёте.
      byGuid.set(guidKey, null);
      stats.definitionsUnsupported[pixType] = (stats.definitionsUnsupported[pixType] || 0) + 1;
      noteMiss(STYLE_MISS.STYLE_TYPE_UNSUPPORTED, pixType);
      return null;
    }

    var value = null;
    if (figmaType === "PAINT") {
      var paints = normalizer.paints(detail.fillPaints, guidKey);
      if (paints && paints.length) value = { paints: paints };
    } else if (figmaType === "EFFECT") {
      var effects = normalizer.effects(detail.effects, guidKey);
      if (effects && effects.length) value = { effects: effects };
    } else {
      var sourceTextDetail = doc.detail(record, { sourceTextStyle: true });
      var typography = typographyOf(normalizer.sourceTextStyle(sourceTextDetail));
      if (Object.prototype.hasOwnProperty.call(sourceTextDetail, "fontSize")) {
        stats.textStyleFontSize.topLevel += 1;
      } else if (typography && typography.fontSize !== undefined) {
        stats.textStyleFontSize.glyphUniform += 1;
      } else {
        stats.textStyleFontSize.glyphAmbiguous += 1;
        byGuid.set(guidKey, null);
        noteMiss(STYLE_MISS.TEXT_FONT_SIZE_UNRESOLVED, guidKey);
        return null;
      }
      if (typography) value = { text: typography };
    }
    if (!value) {
      // Стиль, из которого ничего не отобразилось (незнакомый тип краски,
      // потерянная картинка, пустая типографика). Узел останется со своими
      // сырыми значениями — это и есть fallback, а не пустой стиль в Figma.
      byGuid.set(guidKey, null);
      noteMiss(STYLE_MISS.STYLE_EMPTY, pixType + " " + guidKey);
      return null;
    }

    var sharedKey = sharedKeyOf(detail, guidKey);
    var signature = JSON.stringify(value);
    var identity = figmaType + " " + sharedKey + " " + signature;
    byGuid.set(guidKey, identity);

    var entry = known.get(identity);
    if (entry) return accept(entry, guidKey, expected);

    var name = String(record.name || "").trim();
    if (!name) {
      // Имени нет — имя строится из СТАБИЛЬНОЙ информации источника, а не из
      // знания о конкретном документе.
      name = pixType.toLowerCase() + "/" + String(sharedKey).slice(0, 12);
    }
    var description = detail.styleDescription || detail.description || "";

    entry = {
      identity: identity,
      styleId: "pxs-" + String(sharedKey).replace(/[^0-9a-zA-Z]/g, "").slice(0, 12) +
        "-" + hash32(identity),
      figmaType: figmaType,
      sourceStyleType: pixType,
      sourceKey: sharedKey,
      sourceGuid: guidKey,
      name: name,
      description: typeof description === "string" ? description.slice(0, 500) : "",
      signature: signature,
      value: value,
    };
    known.set(identity, entry);
    createdHere.add(identity);
    stats.sourceStylesByType[pixType] = (stats.sourceStylesByType[pixType] || 0) + 1;

    var nameKey = figmaType + "|" + name;
    var owner = nameOwners.get(nameKey);
    if (owner === undefined) nameOwners.set(nameKey, entry.styleId);
    else if (owner !== entry.styleId) stats.nameCollisions += 1;

    return accept(entry, guidKey, expected);
  }

  /**
   * Привязка узла к стилю по СПИСКУ КРАСОК или ЭФФЕКТОВ.
   *
   * Привязывается только тогда, когда эффективное значение узла совпадает со
   * значением стиля. Это не отождествление по значению — идентичность уже
   * решена ссылкой, — а страховка обратного свойства: назначенный стиль Figma
   * ПЕРЕЗАПИШЕТ краски узла. Если узел показывает своё, а не стиля (на
   * проверенных документах — 82 заливки, 32 обводки, 57 текстов), привязка
   * его перекрасила бы. Местное значение в таком случае выигрывает, а событие
   * считается.
   */
  function bindList(styleGuid, expected, effectiveValue, field) {
    var entry = describe(styleGuid, expected);
    if (!entry) return null;
    if (!effectiveValue || !effectiveValue.length) { noteSkip(BIND_SKIP.NO_EFFECTIVE_VALUE); return null; }
    var candidate = {};
    candidate[field] = effectiveValue;
    if (JSON.stringify(candidate) !== entry.signature) {
      noteSkip(BIND_SKIP.LOCAL_VALUE_WINS);
      return null;
    }
    return entry.styleId;
  }

  function bindPaints(styleGuid, effectivePaints) {
    return bindList(styleGuid, "PAINT", effectivePaints, "paints");
  }

  function bindEffects(styleGuid, effectiveEffects) {
    return bindList(styleGuid, "EFFECT", effectiveEffects, "effects");
  }

  /**
   * Привязка текстового узла к `TextStyle`.
   *
   * Сравниваются только те поля, которые несёт САМ стиль: остальное (цвет,
   * выравнивание, авторазмер) в Figma принадлежит узлу и стилем не
   * управляется. Расхождение хотя бы по одному полю стиля означает, что узел
   * показывает свою типографику, — привязка отменяется.
   */
  function bindText(styleGuid, effectiveText) {
    var entry = describe(styleGuid, "TEXT");
    if (!entry) return null;
    if (!effectiveText) { noteSkip(BIND_SKIP.NO_EFFECTIVE_VALUE); return null; }
    var fields = Object.keys(entry.value.text);
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (JSON.stringify(effectiveText[field]) !== JSON.stringify(entry.value.text[field])) {
        noteSkip(BIND_SKIP.LOCAL_VALUE_WINS);
        return null;
      }
    }
    return entry.styleId;
  }

  return {
    describe: describe,
    bindPaints: bindPaints,
    bindEffects: bindEffects,
    bindText: bindText,
    stats: stats,
    missSamples: missSamples,
    /** Описания, впервые появившиеся в этой сборке. */
    emitted: function () { return Array.from(emitted.values()); },
  };
}

/** Состояние уровня job: один и тот же стиль создаётся один раз на миграцию. */
function createSharedState() {
  return { styles: new Map(), byGuid: new Map() };
}

module.exports = {
  createStyleRegistry: createStyleRegistry,
  createSharedState: createSharedState,
  FIGMA_STYLE_TYPE: FIGMA_STYLE_TYPE,
  TEXT_STYLE_FIELDS: TEXT_STYLE_FIELDS,
  STYLE_MISS: STYLE_MISS,
  BIND_SKIP: BIND_SKIP,
  NULL_STYLE_KEYS: NULL_STYLE_KEYS,
};
