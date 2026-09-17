/**
 * Direct Migration IR.
 *
 * Отдельное представление миграции, а не переодетый `pixso-portable-package`.
 * Смысл эксперимента в том, чтобы НЕ разворачивать инстанс в поддерево:
 *
 *   определение компонента собирается один раз
 *   → вхождение едет ссылкой на определение
 *   → сверху накладывается дельта Pixso
 *
 * Идентичность определения — guid исходного SYMBOL. Не componentKey: под одним
 * componentKey в документе живут разные варианты (состояния), и схлопывать их
 * в один Figma-компонент значит потерять состояния. componentKey сохраняется
 * как признак семейства и виден в отчёте.
 *
 * Ни одно решение не принимается по имени слоя.
 */
"use strict";

var PixNormalizer = require("./PixNormalizer");
var PixGuid = require("./PixGuid");
var ComponentProperties = require("./ComponentProperties");
var StyleRegistry = require("./StyleRegistry");
var StateGroups = require("./StateGroups");
var Expressibility = require("./Expressibility");
var FigmaCapabilities = require("./FigmaCapabilities");

var PROTOCOL = "PIXSO2FIGMA_DIRECT_PIX";
var PROTOCOL_VERSION = 1;

/** Дополнительные коды, специфичные для сборки IR. */
var IR_UNSUPPORTED = {
  UNRESOLVED_SYMBOL: "UNRESOLVED_SYMBOL",
  // Осознанный перевод: HUG над FIXED-слоями с размером, отличным от мастера,
  // передан как FIXED-корень с растянутыми слоями (см. representFixedHugAsFill).
  NESTED_FIXED_SIZE_REPRESENTED_AS_FILL: "NESTED_FIXED_SIZE_REPRESENTED_AS_FILL",
  FLATTENED_CHILDREN: "FLATTENED_CHILDREN",
  CYCLIC_DEFINITION: "CYCLIC_DEFINITION",
  NODE_TYPE: "NODE_TYPE",
  OVERRIDE_FIELD: "OVERRIDE_FIELD",
  OVERRIDE_TARGET: "OVERRIDE_TARGET",
  OVERRIDE_SWAP_UNRESOLVED: "OVERRIDE_SWAP_UNRESOLVED",
  COMPONENT_PROPERTY_UNBOUND: "COMPONENT_PROPERTY_UNBOUND",
  COMPONENT_PROPERTY_FIELD: "COMPONENT_PROPERTY_FIELD",
  VISUAL_SEMANTIC_UNVERIFIED: "VISUAL_SEMANTIC_UNVERIFIED",
  // Поле sizing записи override, происхождение которого доказать нечем.
  // Не потеря: прежнее поведение сохраняется — но молчать об этом нельзя,
  // иначе «мы не знаем» неотличимо от «мы проверили».
  LAYOUT_SIZING_PROVENANCE_UNKNOWN: "LAYOUT_SIZING_PROVENANCE_UNKNOWN",
};

/** Детерминированные причины, по которым guidPath нельзя превратить в адрес. */
var OVERRIDE_RESOLUTION = {
  TARGET_GUID_NOT_IN_DEFINITION: "TARGET_GUID_NOT_IN_DEFINITION",
  // GUID отсутствует во всём доступном дереве .pix. Это stale override от
  // прежней версии библиотечного компонента: Pixso уже не имеет цели, к
  // которой запись могла бы примениться. Не объявляем это визуальной потерей.
  STALE_TARGET_GUID_NOT_IN_DOCUMENT: "STALE_TARGET_GUID_NOT_IN_DOCUMENT",
  NESTED_INSTANCE_CONTEXT_MISSING: "NESTED_INSTANCE_CONTEXT_MISSING",
  NESTED_SYMBOL_UNRESOLVED: "NESTED_SYMBOL_UNRESOLVED",
  PATH_CHANGED_AFTER_COMPONENT_SWAP: "PATH_CHANGED_AFTER_COMPONENT_SWAP",
  UNSUPPORTED_OVERRIDE_TARGET: "UNSUPPORTED_OVERRIDE_TARGET",
  // Запись без единого поддерживаемого поля. Это не отказ адресации: цель
  // найдена, переносить нечего. Считать её промахом resolver — враньё.
  NO_SUPPORTED_OVERRIDE_FIELD: "NO_SUPPORTED_OVERRIDE_FIELD",
  // Свойство компонента назначено, но в активном определении нет узла,
  // который бы его читал (`componentPropRef`). Идентичность при этом
  // разрешена: это настоящий семантический промах, а не сбой разрешения.
  COMPONENT_PROPERTY_NOT_BOUND: "COMPONENT_PROPERTY_NOT_BOUND",
  // Назначенного определения свойства в документе нет вовсе. Так выглядит
  // свойство внешней библиотеки: его цепочка `parentPropDefId` лежит в чужом
  // файле, и восстановить публичную идентичность здесь нечем.
  COMPONENT_PROPERTY_EXTERNAL_DEF: "COMPONENT_PROPERTY_EXTERNAL_DEF",
  // Определение есть, но объявленный им `parentPropDefId` в документе
  // отсутствует: цепочка оборвана, публичного корня у неё нет.
  COMPONENT_PROPERTY_PUBLIC_DEF_DANGLING: "COMPONENT_PROPERTY_PUBLIC_DEF_DANGLING",
  // Цепочка родителей замкнулась. Данные испорчены; догадываться нельзя.
  COMPONENT_PROPERTY_RESOLUTION_CYCLE: "COMPONENT_PROPERTY_RESOLUTION_CYCLE",
  // Цепочка длиннее потолка обхода.
  COMPONENT_PROPERTY_RESOLUTION_DEPTH_EXCEEDED: "COMPONENT_PROPERTY_RESOLUTION_DEPTH_EXCEEDED",
  // Цель лежит в чужом символе, а вхождение перед ней читает свой SYMBOL из
  // свойства компонента, значение которого в документе не записано ни явной
  // подменой, ни назначением. Фактический символ этого вхождения известен
  // только развёрнутому `derivedSymbolData`, который Direct PIX не читает по
  // построению. Это граница эксперимента, а не сбой адресации.
  OCCURRENCE_SWAP_NOT_IN_SOURCE: "OCCURRENCE_SWAP_NOT_IN_SOURCE",
  // Цель лежит в другом экземпляре ТОГО ЖЕ библиотечного компонента
  // (совпадает componentKey, но это отдельная копия документа с собственной
  // структурой). Перенести адрес между копиями нельзя: деревья различаются,
  // и любое сопоставление было бы догадкой.
  TARGET_IN_OTHER_COMPONENT_COPY: "TARGET_IN_OTHER_COMPONENT_COPY",
  // Адрес был разрешён в определении, которое это вхождение больше не
  // показывает: структурная операция (подмена компонента) сменила активное
  // определение узла уже ПОСЛЕ того, как путь был посчитан. Такой адрес
  // указывает в дерево чужого определения, где он либо не найдётся, либо —
  // что хуже — случайно совпадёт по индексу с посторонним узлом.
  OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP: "OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP",
  // Инвариант «путь разрешён в активном определении узла» не выполнен, и
  // причина не сводится к известной подмене. Запись не отправляется: молча
  // применить её значит применить дельту в чужом семантическом контексте.
  WRONG_ACTIVE_DEFINITION_CONTEXT: "WRONG_ACTIVE_DEFINITION_CONTEXT",
};

/**
 * Поля узла, которыми управляют свойства компонента Pixso.
 *
 * Узел внутри SYMBOL объявляет в `componentPropRef`, какое из его полей
 * читается из свойства с данным `defID`; вхождение присылает значение в
 * `componentPropAssignment`. Именно так Pixso хранит подмену иконки, текст
 * ярлыка и включение декоративных слоёв — без этой связки цель более
 * глубокого override оказывается в чужом символе.
 */
var COMPONENT_PROPERTY_FIELDS = {
  OVERRIDDEN_SYMBOL_ID: "swap",
  TEXT_DATA: "characters",
  VISIBLE: "visible",
};

// Поля Figma `componentPropertyReferences`. Pixso называет операцию
// OVERRIDDEN_SYMBOL_ID, а Figma привязывает INSTANCE_SWAP к `mainComponent`.
// Остальные два имени совпадают с API Figma буквально.
var FIGMA_COMPONENT_PROPERTY_FIELDS = {
  swap: "mainComponent",
  characters: "characters",
  visible: "visible",
};

/**
 * Поля override, которые первая версия умеет применять доказуемо.
 * Всё остальное считается и попадает в отчёт: молча приблизить — запрещено.
 */
var OVERRIDE_FIELDS = {
  name: "name",
  visible: "visible",
  opacity: "opacity",
  blendMode: "blendMode",
  transform: "placement",
  mask: "mask",
  maskType: "mask",
  locked: "locked",
  size: "size",
  fillPaints: "fills",
  strokePaints: "strokes",
  strokeWeight: "strokeWeight",
  textData: "characters",
  symbolData: "swap",
  overriddenSymbolID: "swap",
  overriddenSymbolId: "swap",
  inheritFillStyleID: "fills",
  inheritStrokeStyleID: "strokes",
  cornerRadius: "corners",
  rectangleTopLeftCornerRadius: "corners",
  rectangleTopRightCornerRadius: "corners",
  rectangleBottomLeftCornerRadius: "corners",
  rectangleBottomRightCornerRadius: "corners",
  rectangleCornerRadiiIndependent: "corners",
  // Второе имя того же флага в схеме Pixso 3.0.5. Именно оно стоит в записях
  // override реального документа (1001 запись на проверенном файле), тогда
  // как спецификация документирует первое. Без него независимые углы
  // схлопывались в один равномерный радиус.
  rectangleCornerToolIndependent: "corners",

  // Эффекты вхождения. `symbolOverrides[].effects[]` и `styleIdForEffect`
  // (в схеме — `inheritEffectStyleID`) документированы обеими спецификациями.
  effects: "effects",
  inheritEffectStyleID: "effects",

  // Auto layout самого вхождения. Спецификация PIX перечисляет
  // `stackSpacing`, `stackVerticalPadding`, `stackHorizontalPadding`,
  // `stackPaddingRight`, `stackPaddingBottom`, выравнивания и обе оси
  // sizing среди полей `symbolOverrides[]`.
  stackMode: "layout",
  stackSpacing: "layout",
  stackCounterSpacing: "layout",
  stackPaddingLeft: "layout",
  stackPaddingRight: "layout",
  stackPaddingTop: "layout",
  stackPaddingBottom: "layout",
  stackHorizontalPadding: "layout",
  stackVerticalPadding: "layout",
  stackPrimaryAlignItems: "layout",
  stackCounterAlignItems: "layout",
  stackJustify: "layout",
  stackPrimarySizing: "layout",
  stackCounterSizing: "layout",
  stackWrap: "layout",
  autoLayoutIncludeBorders: "layout",

  // Поведение вхождения внутри auto layout родителя. Обе оси sizing ребёнка
  // означают fill (доказано измерением на реальном документе, см.
  // PixNormalizer.childLayout), поэтому они переносятся, а не считаются.
  autoLayoutAbsolutePos: "childLayout",
  stackCounterAlign: "childLayout",
  stackChildPrimarySizing: "childLayout",
  stackChildCounterSizing: "childLayout",

  // Границы размера auto layout. Вхождение вправе объявить свои: у одной
  // ячейки таблицы минимальная высота 24, у другой — нет.
  minSize: "sizeBounds",
  maxSize: "sizeBounds",

  // Constraints документированы для узла (`horizontalConstraint`,
  // `verticalConstraint`) и приходят в записях override без изменений.
  horizontalConstraint: "constraints",
  verticalConstraint: "constraints",

  // Оформление обводки и её независимые толщины по сторонам.
  strokeAlign: "strokeStyle",
  strokeJoin: "strokeStyle",
  strokeCap: "strokeStyle",
  dashPattern: "strokeStyle",
  borderStrokeWeightsIndependent: "strokeStyle",
  borderTopWeight: "strokeStyle",
  borderRightWeight: "strokeStyle",
  borderBottomWeight: "strokeStyle",
  borderLeftWeight: "strokeStyle",

  // Типографика вхождения. Сам текст едет отдельной операцией `characters`.
  fontName: "textStyle",
  fontSize: "textStyle",
  textAlignHorizontal: "textStyle",
  textAlignVertical: "textStyle",
  textAutoResize: "textStyle",
  textCase: "textStyle",
  textDecoration: "textStyle",
  paragraphSpacing: "textStyle",
  paragraphIndent: "textStyle",
  lineHeight: "textStyle",
  letterSpacing: "textStyle",
  inheritTextStyleID: "textStyle",
  leadingTrim: "textStyle",
  hangingPunctuation: "textStyle",
  hangingList: "textStyle",

  proportionsConstrained: "aspectRatio",

  frameMaskDisabled: "clipsContent",
};

/**
 * Поля, которые считаются отдельной причиной, а не сваливаются в общий
 * «неизвестное поле override».
 */
var OVERRIDE_DECLINED = {
  vectorPaints: "VECTOR_PAINT_TABLE",
  vectorStyles: "VECTOR_PAINT_TABLE",
  layoutGrids: "LAYOUT_GRID",
  inheritGridStyleID: "LAYOUT_GRID",
  prototypeInteractions: "PROTOTYPE",
  variableConsumptionMap: "VARIABLE_BINDING",
  variableModeBySetMap: "VARIABLE_BINDING",
};

/**
 * Пустое значение поля — это не потеря.
 *
 * Реальный документ пишет `vectorPaints: []` в 5172 записях override рядом с
 * настоящим `fillPaints`. Считать такую запись «неподдержанной таблицей
 * заливок вектора» — это выдуманная диагностика: переносить там нечего, и
 * ноль потерь выглядел бы как 5172 потери.
 */
function emptyValue(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

/** Поля override, которые меняют итоговый вид и не могут быть тихо потеряны. */
var APPEARANCE_OVERRIDE_FIELDS = {
  fillGeometry: true, strokeGeometry: true, vectorData: true,
  vectorPaints: true, vectorStyles: true,
  backgroundColor: true, backgroundPaints: true,
  rotation: true, transform: true, blendMode: true,
  mask: true, maskType: true,
  effects: true, inheritEffectStyleID: true,
  fillPaints: true, inheritFillStyleID: true,
  strokePaints: true, inheritStrokeStyleID: true,
  textData: true, visible: true, opacity: true, size: true,
  stackMode: true, stackSpacing: true, stackCounterSpacing: true,
  stackPaddingLeft: true, stackPaddingRight: true,
  stackPaddingTop: true, stackPaddingBottom: true,
  stackHorizontalPadding: true, stackVerticalPadding: true,
  stackPrimaryAlignItems: true, stackCounterAlignItems: true,
  stackPrimarySizing: true, stackCounterSizing: true,
  stackChildPrimarySizing: true, stackChildCounterSizing: true,
  autoLayoutAbsolutePos: true, minSize: true, maxSize: true,
  horizontalConstraint: true,
  verticalConstraint: true, frameMaskDisabled: true,
  cornerRadius: true, rectangleTopLeftCornerRadius: true,
  rectangleTopRightCornerRadius: true, rectangleBottomLeftCornerRadius: true,
  rectangleBottomRightCornerRadius: true,
};

/**
 * Типы Figma, которые могут держать детей. BOOLEAN_OPERATION сохраняется как
 * редактируемый контейнер с исходными operands: flatten в fillGeometry точен
 * визуально, но уничтожает семантику UNION/SUBTRACT/INTERSECT/EXCLUDE.
 */
var CONTAINER_TYPES = { FRAME: true, GROUP: true, COMPONENT: true, SECTION: true, BOOLEAN_OPERATION: true };

/**
 * Служебные поля override-записи, которые сами по себе ничего не переносят.
 * `componentPropAssignment` разбирается отдельной фазой: значение свойства
 * адресуется не самой записи, а узлу определения, который это свойство
 * читает, — как обычное поле его тут трактовать нельзя.
 */
var OVERRIDE_IGNORED = {
  guidPath: true, guid: true, overrideKey: true, phase: true, overrideLevel: true,
  componentPropAssignment: true,
};

/**
 * Причины, при которых состояние вхождения ДЕЙСТВИТЕЛЬНО теряется, а значит
 * нативный инстанс покажет не то, что показывает Pixso.
 *
 * Сюда не входят:
 *   NO_SUPPORTED_OVERRIDE_FIELD    — переносить нечего;
 *   COMPONENT_PROPERTY_NOT_BOUND   — свойство назначено, но ни один узел
 *                                    активного определения его не читает,
 *                                    то есть в самом Pixso оно ничего
 *                                    не меняет;
 *   TARGET_IN_OTHER_COMPONENT_COPY — цель лежит в другой копии того же
 *                                    библиотечного компонента, а показывается
 *                                    объявленная копия. Такая запись
 *                                    недействующая и в источнике: проверено на
 *                                    реальном файле, где обе копии несут один
 *                                    componentKey и одно имя варианта, но
 *                                    разное содержимое (1 ребёнок против 3).
 */
var VISUAL_LOSS_REASONS = {
  TARGET_GUID_NOT_IN_DEFINITION: true,
  NESTED_INSTANCE_CONTEXT_MISSING: true,
  NESTED_SYMBOL_UNRESOLVED: true,
  PATH_CHANGED_AFTER_COMPONENT_SWAP: true,
  OCCURRENCE_SWAP_NOT_IN_SOURCE: true,
  UNSUPPORTED_OVERRIDE_TARGET: true,
};

/**
 * Операции, значение которых вхождение несёт своей собственной записью.
 * Заливок, обводок и углов здесь нет намеренно: их вхождение наследует от
 * определения, и дельта для них — единственный источник.
 *
 * Имени здесь нет тоже: `name` записи вхождения — техническая подпись
 * хранения («Instance 243»), а отображаемое имя несёт корневая правка имени.
 * Проверено в панели слоёв Pixso: вхождение с записью «Instance 243» и
 * корневой правкой «side menu / bottom» показано как «side menu / bottom».
 */
var OCCURRENCE_OWN_OPS = {
  size: true, visible: true, opacity: true,
  constraints: true, placement: true,
  blendMode: true, mask: true,
};

/**
 * Поведение внутри auto layout собирается сразу из нескольких полей записи,
 * поэтому пропускать его целиком по одному совпавшему полю нельзя: запись
 * может нести и `autoLayoutAbsolutePos`, которого у вхождения нет, и
 * `stackChildPrimarySizing`, который у него есть. Соответствие «результат →
 * исходные поля» разбирает этот случай по одному значению.
 */
var CHILD_LAYOUT_SOURCES = {
  layoutPositioning: ["autoLayoutAbsolutePos"],
  layoutAlign: ["stackCounterAlign", "stackChildCounterSizing"],
  layoutGrow: ["stackChildPrimarySizing"],
};

/**
 * Происхождение ОДНОГО поля sizing внутри записи `symbolOverrides`.
 *
 * Запись override — это полный `PixsoNode`, а не дельта: двоичного признака
 * «поле изменено автором» в формате нет. Поэтому присутствие
 * `stackPrimarySizing` в записи ничего не доказывает само по себе, и на
 * реальном документе один и тот же класс записей несёт и настоящую правку
 * вхождения, и эффективный снимок уже действующего состояния.
 *
 *   EXPLICIT_SYMBOL_OVERRIDE — разрешённая геометрия вхождения по этой оси
 *     от геометрии определения ОТЛИЧАЕТСЯ: владелец оси действительно
 *     сменился, операция выпускается;
 *   DERIVED_EFFECTIVE — ось переключается в HUG, а разрешённый размер по ней
 *     равен размеру определения: в самом Pixso поле ничего не изменило, а в
 *     Figma отдало бы ось раскладке и сняло бы с неё размер источника;
 *   BASE_DEFINITION — значение записи совпадает со значением определения:
 *     эхо, переносить нечего;
 *   UNKNOWN — доказательства нет (ось поля неизвестна, цель не читается,
 *     разрешённой геометрии в источнике нет). Намерение не выдумывается:
 *     сохраняется прежнее поведение.
 */
var LAYOUT_PROVENANCE = {
  EXPLICIT_SYMBOL_OVERRIDE: "EXPLICIT_SYMBOL_OVERRIDE",
  DERIVED_EFFECTIVE: "DERIVED_EFFECTIVE",
  BASE_DEFINITION: "BASE_DEFINITION",
  UNKNOWN: "UNKNOWN",
};

/**
 * Поля sizing, для которых смешанное происхождение доказано измерением.
 * Список закрыт намеренно: расширять его без доказательства запрещено —
 * «выглядит похоже» не является основанием заглушить правку вхождения.
 * `layoutGrow`/`layoutAlign` сюда не входят: они принадлежат раскладке
 * РОДИТЕЛЯ и в доказанном отказе не участвуют.
 */
var LAYOUT_SIZING_FIELDS = [
  { field: "stackPrimarySizing", op: "primaryAxisSizingMode", primary: true },
  { field: "stackCounterSizing", op: "counterAxisSizingMode", primary: false },
];

/** Значения sizing источника в терминах Figma. Те же, что у нормализатора. */
var AXIS_SIZING = { FIXED: "FIXED", RESIZE_TO_FIT: "AUTO" };

/** Направления раскладки, в которых ось поля вообще определена. */
var SOURCE_LAYOUT_MODES = { HORIZONTAL: "HORIZONTAL", VERTICAL: "VERTICAL" };

var MAX_SAMPLES = 40;
var SAMPLES_PER_REASON = 8;

/**
 * Слияние частичных операций одного вхождения. Auto layout, обводка и
 * типографика приходят несколькими записями override подряд, и перезапись
 * потеряла бы всё, кроме последней.
 */
function merge(target, extra) {
  var out = target || {};
  var keys = Object.keys(extra);
  for (var i = 0; i < keys.length; i++) out[keys[i]] = extra[keys[i]];
  return out;
}

function build(doc, options) {
  options = options || {};
  var sharedRegistry = options.registry || null;
  // Шлюз визуальной безопасности включён по умолчанию. Выключается только
  // явно и только для диагностики: «как выглядел бы результат без страховки».
  var visualSafety = options.visualSafety !== false;
  // Проверка происхождения полей sizing — тоже шлюз, и выключается он на тех
  // же правах: явно и только для диагностики «как выглядел бы результат, если
  // воспроизводить каждое поле записи».
  var layoutProvenance = options.layoutProvenance !== false;
  // Нативные наборы вариантов — тоже шлюз, и выключается он на тех же
  // правах, что визуальная безопасность и происхождение sizing: явно и
  // только для диагностики «как выглядел бы результат без объединения».
  var nativeVariantSets = options.nativeVariantSets !== false;
  var traceTextOverrides = !!options.traceTextOverrides;
  var textOverrideTraceLimit = Math.max(1, Number(options.textOverrideTraceLimit) || 20);
  var textOverrideTraceEntries = 0;
  var timings = { irBuildMs: 0 };
  var startedAt = Date.now();
  var expressibility = Expressibility.createLedger(60);
  var expressibilityPolicy = options.expressibilityPolicy || Expressibility.createPolicy({
    verdicts: options.capabilityVerdicts || FigmaCapabilities.loadDefault(),
  });

  var unsupported = Object.create(null);
  var samples = [];
  var overrideResolution = Object.create(null);
  var overrideResolutionSamples = [];
  // D27: always-on bounded source provenance for the rare resolver failures
  // that make a native occurrence visually unsafe. Unlike --debug-overrides
  // this survives the normal automatic migration path and is small by design.
  var deepOverrideProvenanceSamples = [];
  var sourceSemanticAudit = {
    counts: Object.create(null), samples: [], componentPropertySamples: [],
    sampleLimit: 80, componentSampleLimit: 120, nodesAudited: 0, overridesAudited: 0
  };
  var assets = new Map();
  var knownAssets = sharedRegistry ? sharedRegistry.assets : null;

  function note(code, detail) {
    unsupported[code] = (unsupported[code] || 0) + 1;
    if (samples.length < MAX_SAMPLES && detail) {
      samples.push({ code: code, detail: String(detail).slice(0, 120) });
    }
  }

  // Выборка держится по каждой причине отдельно: массовая категория иначе
  // вытесняет из отчёта именно те редкие случаи, ради которых он и нужен.
  var overrideResolutionSampleCounts = Object.create(null);

  function noteOverrideResolution(reason, detail) {
    overrideResolution[reason] = (overrideResolution[reason] || 0) + 1;
    if (!options.debugOverrides || !detail) return;
    var taken = overrideResolutionSampleCounts[reason] || 0;
    if (taken >= SAMPLES_PER_REASON) return;
    overrideResolutionSampleCounts[reason] = taken + 1;
    overrideResolutionSamples.push({ reason: reason, detail: detail });
  }

  function sourceSemanticNote(field, record, expected, actual, stage, extra) {
    sourceSemanticAudit.counts[field] = (sourceSemanticAudit.counts[field] || 0) + 1;
    if (sourceSemanticAudit.samples.length >= sourceSemanticAudit.sampleLimit) return;
    var sample = { field: field, sourceId: record && record.key || null,
      sourceType: record && record.type || null, stage: stage || "source-to-ir",
      expected: expected, actual: actual };
    if (extra) Object.keys(extra).forEach(function (key) { sample[key] = extra[key]; });
    sourceSemanticAudit.samples.push(sample);
  }

  function sourceSemanticEqual(left, right) {
    if (left === right) return true;
    if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= 0.0005;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch (_e) { return false; }
  }

  function auditOrdinarySource(record, detail, node, mappedFills, mappedStrokes) {
    sourceSemanticAudit.nodesAudited += 1;
    var sourceVisible = detail.visible !== false;
    if (sourceVisible !== (node.visible !== false)) sourceSemanticNote("VISIBLE", record, sourceVisible, node.visible !== false);
    var sourceClipsContent = normalizer.clipsContent(detail, record.type);
    if (typeof sourceClipsContent === "boolean" && sourceClipsContent !== node.clipsContent) {
      sourceSemanticNote("CLIPS_CONTENT", record, sourceClipsContent, node.clipsContent);
    }
    if (detail.size) {
      if (!sourceSemanticEqual(detail.size.x, node.width)) sourceSemanticNote("WIDTH", record, detail.size.x, node.width);
      if (!sourceSemanticEqual(detail.size.y, node.height)) sourceSemanticNote("HEIGHT", record, detail.size.y, node.height);
    }
    if (record.type === "TEXT" && detail.textData && typeof detail.textData.characters === "string") {
      var irText = node.text && node.text.characters;
      if (detail.textData.characters !== irText) sourceSemanticNote("CHARACTERS", record, detail.textData.characters, irText);
    }
    // Reuse the already-normalized paint values from ordinaryNode. Calling
    // normalizer.paints() again would repeat asset/style diagnostics and make
    // this read-only audit change counters.
    var sourceFills = mappedFills || [];
    if (!sourceSemanticEqual(sourceFills, node.fills || [])) sourceSemanticNote("FILLS", record, sourceFills, node.fills || []);
    var sourceStrokes = mappedStrokes || [];
    if (!sourceSemanticEqual(sourceStrokes, node.strokes || [])) sourceSemanticNote("STROKES", record, sourceStrokes, node.strokes || []);
    if (sourceStrokes.length) {
      var sourceBorders = normalizer.borderWeights(detail);
      if (sourceBorders && !sourceSemanticEqual(sourceBorders, node.borderWeights)) sourceSemanticNote("BORDER_WEIGHTS", record, sourceBorders, node.borderWeights || null);
    }
  }

  function registerAsset(hash) {
    if (assets.has(hash)) return hash;
    if (knownAssets && knownAssets.has(hash)) return hash;
    var info = doc.container.resourceInfo(hash);
    if (!info) return null;
    assets.set(hash, { assetId: hash, name: info.name, extension: info.extension, size: info.size });
    if (knownAssets) knownAssets.add(hash);
    return hash;
  }

  var normalizer = PixNormalizer.createNormalizer(doc, {
    unsupported: note,
    asset: registerAsset,
    stat: function (name) { stats[name] = (stats[name] || 0) + 1; },
  });

  // Реестр общих стилей. Состояние уровня job приходит извне ровно так же,
  // как реестры определений и ассетов: один и тот же стиль источника обязан
  // стать одним стилем Figma на всю миграцию и не имеет права протечь
  // в чужую.
  var styleRegistry = StyleRegistry.createStyleRegistry(doc, normalizer, {
    shared: sharedRegistry ? sharedRegistry.styles : null,
  });

  // Реестр групп состояний. Тоже уровня job: группа разбирается один раз на
  // всю миграцию, а её вердикт одинаков для всех корней, которые её задели.
  // Разбор ленивый — он случается, только когда участник группы впервые
  // понадобился сборке определения, и второго обхода документа не добавляет.
  var stateGroups = StateGroups.createRegistry(doc, {
    shared: sharedRegistry ? sharedRegistry.stateGroups : null,
  });

  /**
   * Привязки узла к нативным стилям Figma.
   *
   * Собираются ПОСЛЕ того, как посчитаны эффективные значения узла: привязка
   * выдаётся только тогда, когда стиль и узел говорят одно и то же (см.
   * `StyleRegistry.bindPaints`). Это и есть правило «явное местное значение
   * важнее стиля» на стороне отправителя.
   */
  function styleBindings(detail, node) {
    var bindings = {};
    var fill = styleRegistry.bindPaints(detail.inheritFillStyleID, node.fills);
    if (fill) { bindings.fill = fill; stats.styleBindings.fill += 1; }
    var stroke = styleRegistry.bindPaints(detail.inheritStrokeStyleID, node.strokes);
    if (stroke) { bindings.stroke = stroke; stats.styleBindings.stroke += 1; }
    var effect = styleRegistry.bindEffects(detail.inheritEffectStyleID, node.effects);
    if (effect) { bindings.effect = effect; stats.styleBindings.effect += 1; }
    if (node.type === "TEXT") {
      var text = styleRegistry.bindText(detail.inheritTextStyleID, node.text);
      if (text) { bindings.text = text; stats.styleBindings.text += 1; }
    }
    // Стиль сетки объекта в Figma Plugin API не имеет. Ссылка всё равно
    // разрешается — ради счётчика: «стиль такого рода в документе есть и
    // не перенесён» обязано быть видно, а не выглядеть его отсутствием.
    // Отдельной ветки для GRID здесь нет: тип решает общая таблица.
    if (detail.inheritGridStyleID) styleRegistry.describe(detail.inheritGridStyleID, "PAINT");
    return Object.keys(bindings).length ? bindings : undefined;
  }

  function markVisualLoss(sink, reason) {
    if (!sink || !reason) return;
    sink[reason] = (sink[reason] || 0) + 1;
  }

  function visibleSourceCount(list) {
    if (!list) return 0;
    return list.reduce(function (count, item) {
      return count + (item && item.visible !== false ? 1 : 0);
    }, 0);
  }

  function mergeLosses(target, source) {
    if (!target || !source) return target;
    Object.keys(source).forEach(function (reason) {
      target[reason] = (target[reason] || 0) + source[reason];
    });
    return target;
  }

  function transformIsUnsupported(matrix) {
    if (!matrix) return false;
    var a = typeof matrix.m00 === "number" ? matrix.m00 : 1;
    var b = typeof matrix.m10 === "number" ? matrix.m10 : 0;
    var c = typeof matrix.m01 === "number" ? matrix.m01 : 0;
    var d = typeof matrix.m11 === "number" ? matrix.m11 : 1;
    var sx = Math.sqrt(a * a + b * b);
    var sy = Math.sqrt(c * c + d * d);
    return Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3;
  }

  // -------------------------------------------------------------------------
  // Узел IR
  // -------------------------------------------------------------------------

  function ordinaryNode(record, parentId, parentHasAutoLayout, lossSink) {
    var figmaType = PixNormalizer.SUPPORTED_TYPES[record.type];
    if (!figmaType) {
      note(IR_UNSUPPORTED.NODE_TYPE, record.type);
      return null;
    }
    var detail = doc.detail(record);
    rememberPropertyRefs(record, detail);
    var node = {
      id: record.key,
      parent: parentId,
      kind: "ORDINARY",
      type: figmaType,
      sourceType: record.type,
      name: record.name || record.type,
      // Stable node identity across local mirrors of one published Pixso master.
      // This is metadata only; raw override fields are still reconstructed from
      // their formal records below.
      sourceOverrideKey: record.overrideKey ? doc.guidKey(record.overrideKey) : null,
    };

    var place = normalizer.placement(detail, record.key);
    node.x = place.x;
    node.y = place.y;
    if (place.relativeTransform) node.relativeTransform = place.relativeTransform;
    else if (place.rotation) node.rotation = place.rotation;
    if (transformIsUnsupported(detail.transform)) markVisualLoss(lossSink, "TRANSFORM_UNSUPPORTED");
    if (detail.size) {
      node.width = detail.size.x;
      node.height = detail.size.y;
    }

    if (detail.visible === false) node.visible = false;
    if (typeof detail.opacity === "number" && detail.opacity !== 1) node.opacity = detail.opacity;
    if (detail.locked) node.locked = true;
    var blend = normalizer.blendMode(detail.blendMode);
    if (blend && blend !== "PASS_THROUGH" && blend !== "NORMAL") node.blendMode = blend;
    if (detail.mask) {
      node.isMask = true;
      stats.masksNative = (stats.masksNative || 0) + 1;
      var maskType = normalizer.maskType(detail.maskType);
      if (maskType) node.maskType = maskType;
    }
    if (record.type === "BOOLEAN_OPERATION") {
      var booleanOperation = normalizer.booleanOperation(detail.booleanOperation);
      if (booleanOperation) {
        node.booleanOperation = booleanOperation;
        stats.booleanOperationsNative = (stats.booleanOperationsNative || 0) + 1;
      } else {
        markVisualLoss(lossSink, "BOOLEAN_OPERATION_UNSUPPORTED");
      }
    }
    // Binary PIX stores the inverse `frameMaskDisabled` bit.  The default
    // false is omitted by Kiwi, so ordinary frame-like containers need an
    // explicit positive clipsContent=true in IR as well.  GROUP remains false.
    var ownClipsContent = normalizer.clipsContent(detail, record.type);
    if (typeof ownClipsContent === "boolean") node.clipsContent = ownClipsContent;

    var fillSource = normalizer.effectivePaints(detail, "fillPaints", "inheritFillStyleID");
    var fills = normalizer.paints(fillSource, record.key);
    if (fills) node.fills = fills;
    if (visibleSourceCount(fillSource) > (fills ? fills.length : 0)) {
      markVisualLoss(lossSink, "PAINT_UNSUPPORTED");
    }

    var strokeSource = normalizer.effectivePaints(detail, "strokePaints", "inheritStrokeStyleID");
    var strokes = normalizer.paints(strokeSource, record.key);
    if (strokes && strokes.length) {
      node.strokes = strokes;
      // Общая толщина и стороны — одна величина в двух представлениях.
      // Нормализатор выбирает носитель по замеренной семантике Pixso и
      // отдаёт ровно один; выдать оба значило бы отправить на приёмник две
      // операции на одно свойство.
      var weights = normalizer.strokeWeights(detail);
      if (typeof weights.uniform === "number") node.strokeWeight = weights.uniform;
      var align = normalizer.strokeAlign(detail.strokeAlign);
      if (align) node.strokeAlign = align;
      var join = normalizer.strokeJoin(detail.strokeJoin);
      if (join) node.strokeJoin = join;
      var cap = normalizer.strokeCap(detail.strokeCap);
      if (cap) node.strokeCap = cap;
      if (detail.dashPattern && detail.dashPattern.length) node.dashPattern = detail.dashPattern;
      if (weights.sides) node.borderWeights = weights.sides;
    } else if (strokes) {
      node.strokes = [];
    }
    if (visibleSourceCount(strokeSource) > (strokes ? strokes.length : 0)) {
      markVisualLoss(lossSink, "PAINT_UNSUPPORTED");
    }

    var effectSource = normalizer.effectiveEffects(detail);
    var mappedEffects = normalizer.effects(effectSource, record.key);
    if (mappedEffects) node.effects = mappedEffects;
    if (visibleSourceCount(effectSource) > (mappedEffects ? mappedEffects.length : 0)) {
      markVisualLoss(lossSink, "EFFECT_UNSUPPORTED");
    }

    var cornerValues = normalizer.corners(detail);
    if (cornerValues) node.corners = cornerValues;
    // Figma and Pixso use the same ArcData model for ELLIPSE: radians for
    // start/end angles and a 0..1 inner-radius ratio. Without this field a
    // preloader/donut arc silently becomes a full circle.
    if (record.type === "ELLIPSE" && detail.arcData &&
        typeof detail.arcData.startingAngle === "number" &&
        typeof detail.arcData.endingAngle === "number" &&
        typeof detail.arcData.innerRadius === "number") {
      node.arcData = {
        startingAngle: detail.arcData.startingAngle,
        endingAngle: detail.arcData.endingAngle,
        innerRadius: detail.arcData.innerRadius,
      };
    }

    var flowChildBoxes = [];
    var flowChildCount = (record.children || []).reduce(function (count, child) {
      if (!child) return count;
      var childDetail = doc.detail(child) || {};
      if (child.visible === false || childDetail.visible === false || childDetail.autoLayoutAbsolutePos) return count;
      var childPlacementForLayout = normalizer.placement(childDetail, child.key);
      if (childDetail.size) {
        flowChildBoxes.push({
          x: childPlacementForLayout.x, y: childPlacementForLayout.y,
          width: childDetail.size.x, height: childDetail.size.y,
        });
      }
      return count + 1;
    }, 0);
    var layout = normalizer.autoLayout(detail, {
      flowChildCount: flowChildCount,
      flowChildBoxes: flowChildBoxes,
    });
    if (layout) node.autoLayout = layout;
    if (detail.stackMode && detail.stackMode !== "NONE" && !layout) {
      markVisualLoss(lossSink, "LAYOUT_UNSUPPORTED");
    }

    var childPlacement = normalizer.childLayout(detail, parentHasAutoLayout);
    if (childPlacement) node.childLayout = childPlacement;

    // Границы размера принадлежат самому узлу, а не его месту в раскладке:
    // их несёт и контейнер, который обнимает содержимое, и ребёнок внутри
    // чужого auto layout. Поэтому они лежат рядом с размером, а не внутри
    // childLayout.
    var bounds = normalizer.sizeBounds(detail);
    if (bounds) node.sizeBounds = bounds;

    var nodeConstraints = normalizer.constraints(detail);
    if (nodeConstraints) node.constraints = nodeConstraints;
    if (detail.proportionsConstrained === true) node.aspectRatioLocked = true;
    if ((detail.horizontalConstraint || detail.verticalConstraint) && !nodeConstraints) {
      markVisualLoss(lossSink, "CONSTRAINT_UNSUPPORTED");
    }

    if (figmaType === "TEXT") node.text = normalizer.text(detail, record.key);
    var outlinedStrokeFallback = false;
    var centerlineStrokeFallback = false;
    var vectorRegionsApplied = false;
    if (figmaType === "VECTOR" || figmaType === "LINE") {
      var paths = normalizer.vectorPaths(detail, record.key);
      if (paths) node.vectorPaths = paths;
      // Многоцветный вектор Pixso — это ОДИН узел, у которого своя краска у
      // каждого куска геометрии (`vectorPaints[].regionId` → путь
      // `fillGeometry`). В Figma цвет такого рисунка принадлежит региону
      // векторной сети, а не пути: `vectorPaths` носителя цвета не имеет
      // вовсе, поэтому весь рисунок приезжал одной заливкой узла.
      //
      // Сеть строится из тех же путей `fillGeometry`, что уже переносятся
      // через `vectorPaths`: форма остаётся прежней, добавляется только
      // адресуемость региона краской. Разбиение вектора на несколько узлов
      // здесь неприменимо — это изменило бы дерево слоёв источника.
      if (paths && figmaType === "VECTOR") {
        var regionPaints = normalizer.vectorRegionPaints(detail, record.key);
        var regionNetwork = regionPaints
          ? normalizer.vectorRegionNetwork(detail, record.key)
          : undefined;
        if (regionNetwork && regionNetwork.regions.length === paths.length) {
          var painted = 0;
          regionNetwork.regions.forEach(function (region, index) {
            if (!hasOwn(regionPaints, index)) return;
            // Регион без своей записи краску не получает: в Pixso он
            // красится общей заливкой узла, и это же правило действует в
            // Figma для региона без собственного `fills`.
            region.fills = regionPaints[index];
            painted += 1;
          });
          if (painted) {
            node.vectorNetwork = regionNetwork;
            vectorRegionsApplied = true;
            stats.vectorRegionPaintsApplied = (stats.vectorRegionPaintsApplied || 0) + 1;
            stats.vectorRegionsPainted = (stats.vectorRegionsPainted || 0) + painted;
          }
        } else if (regionPaints) {
          // Сеть не построилась или разошлась с путями по числу регионов:
          // адресовать краску нечем. Узел остаётся прежним одноцветным
          // результатом, а расхождение называется вслух.
          stats.vectorRegionNetworkRejected = (stats.vectorRegionNetworkRejected || 0) + 1;
        }
      }
      if (detail.fillGeometry && detail.fillGeometry.length && !paths) {
        markVisualLoss(lossSink, "VECTOR_GEOMETRY");
      }
      // Stroke-only Pixso vectors have no fillGeometry at all, but DO carry
      // an exact already-expanded strokeGeometry. Previously createVector()
      // stayed empty, so groups of hand-drawn illustrations arrived only
      // partially. Use the expanded stroke outline as an editable Figma
      // vector path and paint that outline with the source stroke paint.
      // This is a visual fallback, not a guessed centerline: strokeGeometry
      // is authored by Pixso itself and all of its path blobs must decode.
      if (!paths && (!detail.fillGeometry || !detail.fillGeometry.length) &&
          detail.strokeGeometry && detail.strokeGeometry.length && strokes && strokes.length) {
        // Prefer the editable vector-network centerline. strokeGeometry is an
        // expanded outline and is NOT interchangeable with it: flattening the
        // outline made zero-height guide lines acquire height and changed HUG
        // parents; complex radial diagrams also changed their intrinsic box.
        var centerlinePaths = normalizer.vectorNetworkPaths(detail, record.key);
        if (centerlinePaths && centerlinePaths.length) {
          node.vectorPaths = centerlinePaths;
          // No fillGeometry exists, so a fill paint cannot be attached to this
          // centerline without inventing a region. Keep only true stroke paint.
          node.fills = [];
          centerlineStrokeFallback = true;
          stats.strokeOnlyVectorsNetworkDecoded = (stats.strokeOnlyVectorsNetworkDecoded || 0) + 1;
        } else if (normalizer.canOutlineStrokeGeometry(detail)) {
          // Last-resort visual fallback for simple solid, non-degenerate paths
          // whose editable network cannot be decoded. This branch is now much
          // narrower than D38 and never handles line-like or multi-style data.
          var outlinePaths = normalizer.vectorPathsFromGeometry(detail.strokeGeometry, record.key);
          if (outlinePaths && outlinePaths.length) {
            node.vectorPaths = outlinePaths;
            node.fills = strokes;
            node.strokes = [];
            delete node.strokeWeight;
            delete node.strokeAlign;
            delete node.strokeJoin;
            delete node.strokeCap;
            delete node.dashPattern;
            delete node.borderWeights;
            outlinedStrokeFallback = true;
            stats.strokeOnlyVectorsOutlined = (stats.strokeOnlyVectorsOutlined || 0) + 1;
          } else {
            markVisualLoss(lossSink, "VECTOR_GEOMETRY");
          }
        } else {
          stats.strokeOnlyVectorsOutlineUnsafe = (stats.strokeOnlyVectorsOutlineUnsafe || 0) + 1;
          if (detail.size && (!(detail.size.x > 0.01) || !(detail.size.y > 0.01))) {
            stats.strokeOnlyVectorsDegenerate = (stats.strokeOnlyVectorsDegenerate || 0) + 1;
          }
          markVisualLoss(lossSink, "VECTOR_STROKE_NETWORK");
        }
      }
    }
    // Пустая таблица заливок вектора — это отсутствие таблицы, а не потеря.
    // Перенесённая таблица — тем более: краска регионов уехала сетью.
    if (!vectorRegionsApplied &&
        (!emptyValue(detail.vectorPaints) || !emptyValue(detail.vectorStyles))) {
      note(PixNormalizer.UNSUPPORTED.VECTOR_PAINT_TABLE, record.key);
      markVisualLoss(lossSink, "VECTOR_PAINT_TABLE");
    }
    // Привязка региона к общему стилю краски — отдельная возможность от самой
    // краски. Разрешённое значение стиля уже лежит в `vectorPaints` и уехало
    // вместе с регионом, поэтому вид узла полон, а не потерян: теряется связь
    // региона со стилем, и молчать об этом нельзя.
    if (vectorRegionsApplied && !emptyValue(detail.vectorStyles)) {
      note(PixNormalizer.UNSUPPORTED.VECTOR_REGION_STYLE, record.key);
      stats.vectorRegionStylesUnbound =
        (stats.vectorRegionStylesUnbound || 0) + detail.vectorStyles.length;
    }
    if (!emptyValue(detail.prototypeInteractions)) {
      note(PixNormalizer.UNSUPPORTED.PROTOTYPE, record.key);
    }
    if (!emptyValue(detail.variableConsumptionMap)) {
      // Direct PIX serializes the node's already-resolved visual values
      // (paints, text style, opacity, geometry) into the snapshot. What is not
      // reconstructed is the *live variable binding* itself. Losing that
      // binding changes future theme/variable switching semantics, but it does
      // not make the current imported appearance unverified. Keep the explicit
      // unsupported diagnostic without routing otherwise-correct occurrences
      // into visual fallback / unsafe accounting.
      note(PixNormalizer.UNSUPPORTED.VARIABLE_BINDING, record.key);
      stats.variableBindingsUnbound = (stats.variableBindingsUnbound || 0) + 1;
    }

    // Привязки — последними: они считаются по УЖЕ посчитанным эффективным
    // значениям узла.
    var bindings = styleBindings(detail, node);
    if (bindings) {
      // Geometry fallbacks change which paint channel is meaningful.
      // - outlined stroke: stroke became fill geometry -> do not rebind stroke
      // - decoded centerline: there is no fill region -> do not rebind fill
      if (outlinedStrokeFallback && bindings.stroke) delete bindings.stroke;
      if (outlinedStrokeFallback && bindings.fill) delete bindings.fill;
      if (centerlineStrokeFallback && bindings.fill) delete bindings.fill;
      if (Object.keys(bindings).length) node.styles = bindings;
    }
    auditOrdinarySource(record, detail, node, fills, strokes);
    return node;
  }

  // -------------------------------------------------------------------------
  // Определения компонентов
  // -------------------------------------------------------------------------

  // В streaming full-document режиме registry хранит только identity и
  // компактные path maps между roots. Глубокое дерево определения остаётся
  // только в IR того root, где встретилось впервые.
  var definitions = new Map();      // новые определения этого build
  var knownDefinitions = sharedRegistry ? sharedRegistry.definitions : new Set();
  // D53. Востребованный состав каждой безопасной группы состояний на весь job:
  // `groupId -> [ключи SYMBOL]`. Считает отправитель по тем же корням, которые
  // мигрирует, поэтому ничего сверх спроса сюда попасть не может. Пусто —
  // прежнее поведение: семейство доезжает по мере надобности.
  var familyDemand = (options.familyDemand && typeof options.familyDemand.get === "function")
    ? options.familyDemand
    : (sharedRegistry && sharedRegistry.familyDemand && typeof sharedRegistry.familyDemand.get === "function"
      ? sharedRegistry.familyDemand : null);
  // Ключи, собранные ЭТОЙ сборкой. В общий реестр они переносятся одним
  // шагом в самом конце `build`, когда IR действительно построен.
  var committedDefinitions = [];
  var definitionPaths = sharedRegistry ? sharedRegistry.definitionPaths : new Map();
  // Тот же путь, но адресуемый последовательностью индексов. Нужен ровно для
  // одного: сопоставить узел одной копии библиотечного компонента узлу другой
  // его копии. Копии несут один componentKey и одинаковое дерево, но разные
  // guid-ы, и guid одной копии в другой не встречается.
  var definitionIndexPaths = sharedRegistry ? sharedRegistry.definitionIndexPaths : new Map();
  // Структурная подпись определения: набор «индексный путь + тип узла». Две
  // копии одного библиотечного компонента переводимы друг в друга только при
  // полном совпадении подписи. Совпадения одного узла недостаточно: у двух
  // копий разных версий библиотеки первый ребёнок может совпасть по типу и
  // при этом быть совсем другим слоем.
  var definitionShapes = sharedRegistry ? sharedRegistry.definitionShapes : new Map();
  var definitionVisualLosses = sharedRegistry ? sharedRegistry.definitionVisualLosses : new Map();
  var definitionDependencies = sharedRegistry ? sharedRegistry.definitionDependencies : new Map();
  /**
   * Подмены компонента, объявленные вхождением ВНУТРИ мастера.
   *
   * Вхождение внутри определения — такой же инстанс со своими
   * `symbolOverrides`, и оно имеет право подменить вложенный компонент. Такая
   * подмена принадлежит содержимому мастера, а не какому-то одному его
   * вхождению: её видят все вхождения сразу.
   *
   * Без неё адресация правок вхождения считает активным ОБЪЯВЛЕННЫЙ symbolId
   * подменённого узла, путь уходит в дерево неподменённого компонента и запись
   * падает как `TARGET_GUID_NOT_IN_DEFINITION` — а за ней и всё вхождение
   * уходит в визуальный фоллбек: компонент приезжает «разобранным» на обычные
   * фреймы, да ещё и с состоянием мастера вместо своего.
   *
   * Ключ — guid объявившего вхождения плюс его собственный guid-путь записи
   * (`N/rel/rel`). Определение в ключе не участвует намеренно: guid узла
   * уникален в документе, а объявление принадлежит самому узлу, а не тому,
   * через какое определение до него дошли. Реестр общий на job, как
   * `definitionPaths`: содержимое определения разбирается один раз.
   */
  var declaredInternalSwaps = sharedRegistry
    ? sharedRegistry.declaredInternalSwaps
    : new Map();
  var reusedDefinitionsThisBuild = new Set();
  var building = new Set();
  var expanding = new Set();
  // Only the occurrence that triggered visual safety is expanded. Nested
  // instances inside that snapshot stay native, as promised by the snapshot
  // contract; recursively expanding them would both over-broaden the fallback
  // and reuse canonical descendant ids in multiple occurrence snapshots.
  var snapshotExpansionDepth = 0;
  // Связка «свойство компонента → поле узла», объявленная самим узлом.
  // Собирается на лету при сборке узла: detail там уже прочитан, второй
  // проход по документу ради тех же байт не нужен.
  var propertyRefsByNode = new Map();
  var translatedPathsSeen = new Set();
  var overrideKeyResolvedStepsSeen = new Set();
  // На определение: propDefId → список адресуемых им узлов. Реестр общий на
  // job, как definitionPaths, иначе повторно встреченное определение теряло
  // бы свои свойства.
  var definitionPropertyBindings = sharedRegistry
    ? sharedRegistry.definitionPropertyBindings
    : new Map();
  // Реестр публичной идентичности свойств. Живёт на документе, а не на job:
  // цепочка `parentPropDefId` уходит из варианта в объявившую его группу
  // состояний, то есть за границы любого отдельного определения.
  var componentProperties = doc.componentProperties || null;
  var publicPropertyDetailCache = new Map();

  function propertyDefKey(id) {
    return id ? doc.guidKey(id) : null;
  }

  /**
   * Публичная идентичность свойства компонента.
   *
   * `componentPropRef.defID` и `componentPropAssignment.defID` — это часто
   * ЛОКАЛЬНЫЕ псевдонимы одного и того же публичного свойства, заведённые
   * разными вариантами одной группы состояний. Сравнивать их между собой
   * сырыми значениями нельзя: на настоящем документе такое сравнение
   * промахивается в трёх случаях из четырёх. Идентичность — корень цепочки
   * `parentPropDefId`, и считает его реестр документа.
   *
   * Возвращает `{ rawKey, key, status, depth }`. `key` — тот ключ, под
   * которым свойство живёт в индексе привязок: публичный корень, если он
   * найден, иначе сырой guid. Откат на сырой guid — это ровно прежнее
   * поведение, а не догадка: он сохраняет уже работавшие совпадения там, где
   * публичного корня в документе нет (внешняя библиотека). Отката на ИМЯ
   * свойства нет ни здесь, ни где-либо ещё.
   */
  function publicPropertyKey(id, contextDefinitionId) {
    var rawKey = propertyDefKey(id);
    // `0:0` — объявленная, но не привязанная ссылка: значения у неё нет.
    if (!rawKey || rawKey === PixGuid.EMPTY_KEY) {
      return { rawKey: null, key: null, status: null, depth: 0 };
    }
    if (!componentProperties) {
      return { rawKey: rawKey, key: rawKey, status: null, depth: 0 };
    }
    var resolved = contextDefinitionId && typeof componentProperties.publicOfScoped === "function"
      ? componentProperties.publicOfScoped(rawKey, contextDefinitionId)
      : componentProperties.publicOf(rawKey);
    return {
      rawKey: rawKey,
      key: resolved.status === ComponentProperties.STATUS.RESOLVED ? resolved.publicId : rawKey,
      status: resolved.status,
      depth: resolved.depth,
      contextDefinitionId: contextDefinitionId || null,
    };
  }

  /** Запоминает объявленные узлом чтения свойств компонента. */
  function rememberPropertyRefs(record, detail) {
    var refs = detail && detail.componentPropRef;
    if (!refs || !refs.length) return;
    var bound = null;
    for (var i = 0; i < refs.length; i++) {
      var field = COMPONENT_PROPERTY_FIELDS[refs[i].componentPropNodeField];
      var rawPropertyId = propertyDefKey(refs[i].defID);
      if (!field || !rawPropertyId) continue;
      if (!bound) bound = [];
      // D58. Raw ComponentPropDef ids are not document-global: the same GUID
      // can be reused by unrelated published families. Resolve the public root
      // only when the enclosing component definition is known (indexBindings).
      bound.push({ rawPropertyId: rawPropertyId, field: field });
    }
    if (bound) propertyRefsByNode.set(record.key, bound);
  }

  /** Полное публичное определение свойства — лениво, по его владельцу. */
  function publicPropertyDetail(publicId, contextDefinitionId) {
    if (!componentProperties || !publicId) return null;
    var cacheKey = (contextDefinitionId || "") + "\u001f" + publicId;
    if (publicPropertyDetailCache.has(cacheKey)) return publicPropertyDetailCache.get(cacheKey);
    var meta = contextDefinitionId && typeof componentProperties.definitionOfScoped === "function"
      ? componentProperties.definitionOfScoped(publicId, contextDefinitionId)
      : componentProperties.definitionOf(publicId);
    var owner = meta && meta.ownerId ? doc.tree.byKey.get(meta.ownerId) : null;
    var found = null;
    if (owner) {
      var detail = doc.detail(owner);
      var defs = detail.componentPropDef || [];
      for (var i = 0; i < defs.length; i++) {
        if (propertyDefKey(defs[i].id) === publicId) { found = defs[i]; break; }
      }
    }
    publicPropertyDetailCache.set(cacheKey, found);
    return found;
  }

  function nativePropertyType(type) {
    if (type === "BOOL") return "BOOLEAN";
    if (type === "TEXT") return "TEXT";
    if (type === "INSTANCE_SWAP") return "INSTANCE_SWAP";
    return null;
  }

  function nativePropertyDefault(definition, type) {
    var value = definition && definition.initialValue || {};
    if (type === "BOOLEAN") return !!value.boolValue;
    if (type === "TEXT") {
      var text = value.textValue;
      // Отсутствующий textValue — это отсутствие доказанного default, а не
      // пустая строка. Синтез "" здесь стирал содержимое bound TEXT уже в
      // Figma native property schema. Явный characters:"" по-прежнему
      // остаётся корректным explicit clear.
      return text && typeof text.characters === "string" ? text.characters : undefined;
    }
    if (type === "INSTANCE_SWAP") {
      var guid = value.guidValue;
      var key = guid ? propertyDefKey(guid) : null;
      return key && key !== PixGuid.EMPTY_KEY ? key : null;
    }
    return null;
  }

  /** Публичная схема, которую реально читает хотя бы один узел определения. */
  function nativePropertiesForBindings(bindings, contextDefinitionId) {
    if (!bindings || !bindings.byPublic || !componentProperties) return [];
    var out = [];
    bindings.byPublic.forEach(function (_targets, publicId) {
      var meta = contextDefinitionId && typeof componentProperties.definitionOfScoped === "function"
        ? componentProperties.definitionOfScoped(publicId, contextDefinitionId)
        : componentProperties.definitionOf(publicId);
      if (!meta || !meta.name || !_targets || !_targets.length) return;
      var declaredType = nativePropertyType(meta.type);
      var bindingTypes = Object.create(null);
      _targets.forEach(function (target) {
        if (!target) return;
        var bindingType = target.field === "visible" ? "BOOLEAN" :
          (target.field === "characters" ? "TEXT" : (target.field === "swap" ? "INSTANCE_SWAP" : null));
        if (bindingType) bindingTypes[bindingType] = true;
      });
      var bindingTypeKeys = Object.keys(bindingTypes);
      // The consumer field is the strongest local evidence of property type.
      // Some copied Pixso libraries retain stale public metadata (for example
      // INSTANCE_SWAP) while every local componentPropRef reads VISIBLE. When
      // all consumers agree, reconstruct the native type from those refs; when
      // consumers disagree, fail closed and keep only low-level replay.
      var type = bindingTypeKeys.length === 1 ? bindingTypeKeys[0] : declaredType;
      if (!type || bindingTypeKeys.length > 1) return;
      if (declaredType && declaredType !== type) {
        stats.componentPropertyTypeRecoveredFromBinding = (stats.componentPropertyTypeRecoveredFromBinding || 0) + 1;
      }
      var expectedField = type === "BOOLEAN" ? "visible" :
        (type === "TEXT" ? "characters" : "swap");
      if (_targets.some(function (target) { return !target || target.field !== expectedField; })) return;
      var full = publicPropertyDetail(publicId, contextDefinitionId);
      var defaultValue = nativePropertyDefault(full, type);
      if (type === "BOOLEAN") {
        var booleanDefaults = Object.create(null);
        (_targets || []).forEach(function (target) {
          if (!target || target.field !== "visible") return;
          var boundRecord = doc.tree.byKey.get(target.nodeKey);
          if (!boundRecord) return;
          var boundDetail = doc.detail(boundRecord) || {};
          var visible = boundRecord.visible;
          if (visible === undefined) visible = boundDetail.visible;
          if (visible === undefined) visible = true;
          booleanDefaults[String(!!visible)] = !!visible;
        });
        var booleanDefaultKeys = Object.keys(booleanDefaults);
        if (booleanDefaultKeys.length === 1) {
          // The bound layer is the property consumer and therefore the
          // authoritative base state. Library copies can retain stale public
          // initialValue=true while the actual bound icon is hidden.
          defaultValue = booleanDefaults[booleanDefaultKeys[0]];
        } else if (booleanDefaultKeys.length > 1) {
          // One Figma BOOLEAN default cannot represent conflicting aliases.
          // Keep proven low-level visibility instead of guessing.
          return;
        }
      }
      // INSTANCE_SWAP в Figma ссылается на конкретный ComponentNode. В IR
      // поэтому едет не сырой guid Pixso, а та же каноническая identity
      // определения, которой пользуются обычные INSTANCE/swap overrides.
      // Так dependency closure гарантирует доставку default-компонента до
      // объявления свойства. Цикл безопасно отсекается `building`.
      if (type === "TEXT" && defaultValue === undefined) {
        var textDefaults = Object.create(null);
        (_targets || []).forEach(function (target) {
          if (!target || target.field !== "characters") return;
          var boundRecord = doc.tree.byKey.get(target.nodeKey);
          var boundDetail = boundRecord ? doc.detail(boundRecord) : null;
          var characters = boundDetail && boundDetail.textData && boundDetail.textData.characters;
          if (typeof characters === "string") textDefaults[characters] = true;
        });
        var textDefaultValues = Object.keys(textDefaults);
        // Один доказанный base value можно безопасно сделать native default.
        // Разные значения у aliases означают неоднозначную схему: тогда
        // нативное свойство лучше не объявлять, low-level replay сохранится.
        if (textDefaultValues.length === 1) defaultValue = textDefaultValues[0];
        else return;
      }
      if (type === "INSTANCE_SWAP") {
        var defaultSymbol = defaultValue ? doc.symbols.symbolsById.get(defaultValue) : null;
        // У публичного корня Pixso default guid нередко пустой, а конкретный
        // variant alias получает default из самого bound INSTANCE. Это не
        // эвристика по имени: componentPropRef уже доказал, какой слой читает
        // свойство, а symbolData.symbolID — его текущий нативный master.
        if (!defaultSymbol) {
          var candidates = Object.create(null);
          (_targets || []).forEach(function (target) {
            if (!target || target.field !== "swap") return;
            var boundRecord = doc.tree.byKey.get(target.nodeKey);
            var boundDetail = boundRecord ? doc.detail(boundRecord) : null;
            var boundSymbolId = PixGuid.meaningfulGuid(boundDetail && boundDetail.symbolData && boundDetail.symbolData.symbolID);
            if (boundSymbolId) candidates[boundSymbolId] = true;
          });
          var candidateIds = Object.keys(candidates);
          if (candidateIds.length === 1) defaultSymbol = doc.symbols.symbolsById.get(candidateIds[0]) || null;
        }
        defaultValue = defaultSymbol ? ensureDefinition(defaultSymbol) : null;
      }
      var bindingIdentity = (_targets || []).map(function (target) {
        if (!target) return null;
        var boundRecord = doc.tree.byKey.get(target.nodeKey);
        var stableNodeKey = boundRecord && boundRecord.overrideKey ? doc.guidKey(boundRecord.overrideKey) : null;
        if (!stableNodeKey) return null;
        return String(target.field || "") + "@" + stableNodeKey;
      }).filter(Boolean).sort().join("\u001f");
      // D49: copied local mirrors may carry different public property GUIDs for
      // the same published slot. The consumer's overrideKey is stable across
      // mirrors and already forms the proven GUID-translation layer. Forward a
      // property identity built only from formal type + stable bound slots; an
      // incomplete binding has no cross-local identity and remains local.
      out.push({
        propertyId: publicId,
        bindingIdentity: bindingIdentity ? (type + "\u001e" + bindingIdentity) : null,
        name: meta.name,
        type: type,
        defaultValue: defaultValue,
      });
    });
    return out;
  }
  var stats = {
    definitionsBuilt: 0,
    definitionsReused: 0,
    // Определения, уехавшие участниками нативного COMPONENT_SET.
    variantMembersEmitted: 0,
    // D36: referenced variant pulls its entire safe source family into the
    // same IR build. Partial component sets are semantically incomplete.
    variantFamiliesClosed: 0,
    variantFamilyMembersPulled: 0,
    variantFamilyMembersDeferred: 0,
    definitionNodes: 0,
    instancesEmitted: 0,
    ordinaryNodesEmitted: 0,
    overridesApplied: 0,
    overridesDropped: 0,
    // Назначение свойства разошлось с сырой правкой того же поля; выиграло
    // назначение (так рисует Pixso).
    propertyConflictsBoolean: 0,
    propertyConflictsText: 0,
    // Собственная типографика текста расходилась со стилем, а глифы доказали
    // стиль: собственные поля — устаревший кэш (PixNormalizer.ownTypographyIsStale).
    textOwnTypographyStale: 0,
    overridesAttempted: 0,
    textOverridesSeen: 0,
    explicitTextChanges: 0,
    explicitTextClears: 0,
    visibilityOverridesSeen: 0,
    paintOverridesSeen: 0,
    // Presence repeated-полей: сколько paint-операций запись действительно
    // несла, сколько доехало до ops и сколько пустых списков-заглушек было
    // распознано и проигнорировано вместо очистки.
    paintOverridesPresent: 0,
    paintOverridesApplied: 0,
    paintOverridesDropped: 0,
    paintDefaultArrayIgnored: 0,
    emptyRepeatedOverridesIgnored: 0,
    textStyleOverridesSeen: 0,
    // Идентичность свойств компонента. Величины держатся врозь намеренно:
    // «совпало по сырому defID», «совпало по публичному корню» и
    // «восстановлено публичной идентичностью» — три разных утверждения, и
    // именно третье доказывает, что цепочка `parentPropDefId` читается.
    componentPropertyAssignmentsTotal: 0,
    componentPropertyResolvedRawIdentity: 0,
    componentPropertyResolvedPublicIdentity: 0,
    componentPropertyRecoveredByPublicIdentity: 0,
    // Назначения, чья идентичность потребовала хотя бы одного шага по
    // `parentPropDefId`. Отделено от восстановления: пройти цепочку и
    // получить совпадение, которого не было, — не одно и то же.
    componentPropertyPublicChainFollowed: 0,
    componentPropertyNotBound: 0,
    componentPropertyExternalDef: 0,
    componentPropertyDanglingParent: 0,
    componentPropertyResolutionCycle: 0,
    componentPropertyResolutionDepthExceeded: 0,
    componentPropertyResolvedByType: Object.create(null),
    componentPropertyRecoveredByType: Object.create(null),
    componentPropertyUnresolvedByType: Object.create(null),
    symbolsInlined: 0,
    instanceFallbacks: 0,
    // Разрешение канонической идентичности вхождения. Считается отдельно от
    // построения определений: «вхождение видели» и «определение собрали» —
    // разные утверждения, и общий счётчик скрывал бы, какое из них не верно.
    pixInstancesSeen: 0,
    canonicalResolved: 0,
    canonicalUnresolved: 0,
    resolvedViaSymbolData: 0,
    resolvedViaInternalOnly: 0,
    // Подмены вложенного компонента, восстановленные по владельцу целевого
    // guid. Отдельный счётчик: «применили подмену, которой в записи не было» —
    // это утверждение, которое обязано быть видно в отчёте.
    swapsInferred: 0,
    swapsInferredByEvidence: Object.create(null),
    // Адреса, переведённые между двумя копиями одного библиотечного
    // компонента. Это не промах и не подмена — это перевод, и он тоже обязан
    // быть виден отдельной величиной.
    pathsTranslatedAcrossCopies: 0,
    // D51: exact publishFile+publishID mirror hop recovered by overrideKey.
    overrideStepsResolvedByOverrideKey: 0,
    // D52: сколько root-only заглушек публикации наполнено содержимым
    // единственного заполненного близнеца той же публикации.
    definitionsHydratedFromPublicationTwin: 0,
    // Разрешение старых guidPath через лёгкий индекс `derivedSymbolData`.
    // Читаются только адреса фактического occurrence-дерева; snapshot payload
    // не материализуется. Неоднозначность никогда не выбирается наугад.
    derivedPathLookups: 0,
    derivedPathResolved: 0,
    derivedPathRemapped: 0,
    derivedSameSymbolRemaps: 0,
    derivedImplicitSwaps: 0,
    derivedPathAmbiguous: 0,
    derivedPathMissing: 0,
    fixedHugRepresentedAsFill: 0,
    // Итоговые коробки вложенных узлов вхождения (`derivedSymbolData.size`).
    sourceBoxesSeen: 0,
    sourceBoxesEmitted: 0,
    sourceBoxesUnresolved: 0,
    sourceBoxesSkippedType: 0,
    sourceBoxesAmbiguous: 0,
    sourceBoxesUnreadable: 0,
    // Derived-definition namespace transitions. Some Pixso library revisions
    // keep an INSTANCE's declared symbolId on an older variant while the
    // occurrence provenance (derivedSymbolData) is entirely rooted in another
    // live definition. We only accept the namespace proof when every candidate
    // at the unresolved hop belongs to one and the same definition.
    derivedDefinitionNamespaceTransitions: 0,
    derivedDefinitionNamespaceAmbiguousNoOps: 0,
    // Deep-lineage reconstruction. Pixso library revisions can leave a
    // guidPath that skips one or more semantic INSTANCE boundaries.  We only
    // reconstruct such a boundary when the target's owning definition is
    // reachable through exactly one chain of nested INSTANCE slots.
    lineageReconstructions: 0,
    lineageReconstructedHops: 0,
    lineageReconstructionAmbiguous: 0,
    lineageReconstructionMissing: 0,
    // Шлюз визуальной безопасности.
    nativeInstancesConsidered: 0,
    nativeInstancesVisualSafe: 0,
    nativeInstancesUnsafe: 0,
    nativeInstanceFallbacks: 0,
    nativeInstanceFallbacksFailed: 0,
    nativeInstancesWithLostState: 0,
    nativeFallbackByReason: Object.create(null),
    nativeUnsafeByReason: Object.create(null),
    nativeUnsafeSamples: [],
    // Записи, снятые с узла из-за смены его активного определения. Отдельная
    // величина: «правку не отправили» и «правку отправили не туда» — разные
    // утверждения, и второе обязано быть невозможным, а первое — измеримым.
    overrideContextInvalidated: 0,
    overrideContextMismatched: 0,
    // Операции дельты определения, перекрытые дельтой вхождения на том же
    // адресе. Не промах: так и должно быть — но величина обязана быть видна,
    // иначе «две записи на один адрес» снова станет незаметным.
    overrideDefinitionOpsOverridden: 0,
    // Происхождение полей sizing записи override. Величины держатся врозь
    // намеренно: «эхо базы», «эффективный снимок» и «снимок, который снял бы
    // с оси размер источника» — три разных утверждения, и объявлять каждое
    // подавленное поле разрушительным нельзя.
    layoutOverrideCandidates: 0,
    layoutOverrideExplicitApplied: 0,
    layoutOverrideDerivedSuppressed: 0,
    layoutOverrideBaseEchoSuppressed: 0,
    layoutOverrideDestructiveSuppressed: 0,
    layoutOverrideUnknown: 0,
    // Привязки узлов к нативным стилям Figma, по роду ссылки. Считается
    // отдельно от числа самих стилей: «стилей создано 111» и «узлов связано
    // 6828» — разные утверждения, и оба обязаны быть видны.
    styleBindings: { fill: 0, stroke: 0, effect: 0, text: 0 },
    styleOverrideBindings: { fill: 0, stroke: 0, effect: 0, text: 0 },
  };

  /**
   * Ограниченная выборка назначений, восстановленных публичной идентичностью.
   * Отчёт обязан уметь показать конкретную тройку «локальный def назначения /
   * локальный def привязки / общий публичный def», иначе величина
   * восстановления недоказуема.
   */
  var recoveredPropertySamples = [];

  /** Ограниченная выборка вхождений без канонической идентичности. */
  var canonicalMissSamples = [];
  var canonicalMissReasons = Object.create(null);

  function noteCanonicalMiss(record, reason) {
    stats.canonicalUnresolved += 1;
    canonicalMissReasons[reason] = (canonicalMissReasons[reason] || 0) + 1;
    if (canonicalMissSamples.length >= 20) return;
    canonicalMissSamples.push({
      reason: reason,
      occurrenceId: record.key,
      // Имя здесь — только диагностика: ни одно решение по нему не принимается.
      occurrenceName: String(record.name || "").slice(0, 80),
      rawSymbolReference: record.symbolRefDeclared ? "declared" : null,
      normalizedSymbolId: record.symbolId || null,
      ancestorPath: record.ancestorPath || null,
    });
  }

  function markDefinitionReused(key) {
    var stack = [key];
    while (stack.length) {
      var current = stack.pop();
      if (reusedDefinitionsThisBuild.has(current)) continue;
      reusedDefinitionsThisBuild.add(current);
      stats.definitionsReused += 1;
      var dependencies = definitionDependencies.get(current) || [];
      for (var i = 0; i < dependencies.length; i++) stack.push(dependencies[i]);
    }
  }

  /**
   * Собирает определение по исходному SYMBOL. Один раз на job: повторное
   * обращение отдаёт уже собранное. Возвращает id определения либо null.
   */
  function ensureDefinition(symbolRecord) {
    var key = symbolRecord.key;
    // D39: never canonicalize variant definitions across local state-groups.
    // Same componentKey/coordinate can exist in multiple copied GUID spaces, and
    // their nested override paths are not interchangeable.
    var variantMember = nativeVariantSets ? stateGroups.memberOf(symbolRecord) : null;
    if (definitions.has(key)) return key;
    if (knownDefinitions.has(key)) {
      markDefinitionReused(key);
      return key;
    }
    if (building.has(key)) {
      // Символ, который прямо или косвенно содержит инстанс самого себя.
      note(IR_UNSUPPORTED.CYCLIC_DEFINITION, key);
      return null;
    }
    building.add(key);

    var nodes = [];
    var paths = new Map();
    var indexPaths = new Map();
    // Две карты одного и того же набора привязок: по публичной идентичности
    // (по ней и идёт поиск) и по сырому defID (только для измерения).
    var bindings = { byPublic: new Map(), byRaw: new Map() };
    var definitionLosses = Object.create(null);
    paths.set(key, []);
    indexPaths.set("", []);

    // Узел определения, читающий свойство, попадает в его индекс. Свойство
    // может читаться несколькими узлами сразу (один булев переключатель на
    // группу слоёв), поэтому значение — список.
    function indexBindings(nodeKey) {
      var refs = propertyRefsByNode.get(nodeKey);
      if (!refs) return;
      for (var r = 0; r < refs.length; r++) {
        var resolvedRef = publicPropertyKey(refs[r].rawPropertyId, key);
        if (!resolvedRef.key) continue;
        var entry = { nodeKey: nodeKey, field: refs[r].field, rawPropertyId: refs[r].rawPropertyId };
        var list = bindings.byPublic.get(resolvedRef.key);
        if (!list) { list = []; bindings.byPublic.set(resolvedRef.key, list); }
        list.push(entry);
        // Сырой индекс не участвует в поиске. Он существует ровно затем,
        // чтобы отчёт мог отделить «совпало и раньше» от «восстановлено
        // публичной идентичностью»: без него величина восстановления была бы
        // не измерена, а объявлена.
        var rawList = bindings.byRaw.get(refs[r].rawPropertyId);
        if (!rawList) { rawList = []; bindings.byRaw.set(refs[r].rawPropertyId, rawList); }
        rawList.push(entry);
      }
    }

    var rootNode = ordinaryNode(symbolRecord, null, false, definitionLosses);
    if (!rootNode) { building.delete(key); return null; }
    rootNode.type = "COMPONENT";
    // Участник безопасной группы состояний. Единственное, что меняется у
    // такого определения, — ИМЯ корневого узла: Figma выводит нативную
    // variant-координату из имени члена набора, и подать ей исходное имя
    // Pixso значило бы отдать координату на откуп его форматированию.
    // Всё остальное — визуальная сборка, идентичность, свойства, overrides —
    // остаётся прежним путём без единой развилки.
    if (variantMember) {
      rootNode.name = variantMember.variantName;
      stats.variantMembersEmitted += 1;
    }
    // Определение живёт на служебной странице: его собственные координаты
    // внутри исходного документа значения не имеют.
    rootNode.x = 0;
    rootNode.y = 0;
    rootNode.definitionPath = [];
    nodes.push(rootNode);
    indexBindings(key);

    // D52. Заглушка публикации наполняется содержимым своего близнеца.
    //
    // Локальное зеркало библиотечного компонента может быть root-only: узел
    // есть, детей нет, содержимое живёт только в опубликованном мастере. На
    // измеренном файле таких востребованных определений 11, и среди них
    // `table / cell / elements [type=icon]` — ячейка колонки «Иконка». Пустое
    // определение уезжало пустым компонентом, и swap на него не давал
    // содержимого: в Figma оставался прежний `type=text` с наложенной сверху
    // иконкой.
    //
    // Идентичность определения остаётся за заглушкой: её `definitionId`,
    // имя и variant-координата не меняются. Меняется только источник детей.
    // Это законно ровно потому, что обе копии — один и тот же опубликованный
    // компонент (`publishFile + publishID`), а адреса внутри совпадают по
    // `overrideKey`: именно ими Pixso и адресует правки в заглушку.
    // Двусмысленность закрывается отказом: два разных заполненных близнеца —
    // это не доказательство, и определение остаётся пустым, как раньше.
    var contentRecord = symbolRecord;
    if (!(symbolRecord.children && symbolRecord.children.length)) {
      var contentTwin = publishedContentTwin(symbolRecord);
      if (contentTwin) {
        contentRecord = contentTwin;
        stats.definitionsHydratedFromPublicationTwin += 1;
      }
    }

    var stack = [{ record: contentRecord, parentId: key, path: [], parentAutoLayout: !!rootNode.autoLayout }];
    while (stack.length) {
      var frame = stack.pop();
      var children = frame.record.children;
      // Индекс в пути — это позиция среди УСПЕШНО собранных детей, а не среди
      // исходных: пропущенный узел сдвинул бы адресацию всех соседей справа.
      var emittedIndex = 0;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        // Подмены, объявленные самим вхождением внутри мастера, собираются
        // здесь же: содержимое определения адресуется всеми его вхождениями,
        // и подменённый вложенный компонент обязан быть виден им всем.
        var childSwaps = child.type === "INSTANCE" ? Object.create(null) : null;
        var emitted = emitNode(child, frame.parentId, frame.parentAutoLayout, nodes, definitionLosses, childSwaps);
        if (!emitted) {
          markVisualLoss(definitionLosses, "UNSUPPORTED_DEFINITION_NODE");
          continue;
        }
        // Имя в пути берётся у собранного узла IR, а не у исходной записи:
        // приёмник сверяет найденный по индексу узел именно с ним, и любое
        // расхождение здесь превращается в тихую потерю правки.
        var childPath = frame.path.concat([{
          index: emittedIndex,
          // sourceId — основная проверка адреса на приёмнике. Имя остаётся
          // только диагностикой и никогда не используется как identity.
          sourceId: child.key,
          sourceOverrideKey: child.overrideKey ? doc.guidKey(child.overrideKey) : null,
          sourceType: child.type,
          targetType: emitted.type,
          definitionId: key,
          name: emitted.name,
        }]);
        childPath[childPath.length - 1].definitionPath = childPath
          .map(function (step) { return step.index; });
        emittedIndex += 1;
        emitted.definitionPath = childPath.map(function (step) { return step.index; });
        paths.set(child.key, childPath);
        indexPaths.set(indexKeyOf(childPath), childPath);
        indexBindings(child.key);
        if (childSwaps) registerInternalSwaps(child.key, childSwaps);
        if (emitted.kind === "ORDINARY" && child.children.length) {
          if (!CONTAINER_TYPES[emitted.type]) {
            note(IR_UNSUPPORTED.FLATTENED_CHILDREN, child.type);
          } else {
            stack.push({
              record: child,
              parentId: child.key,
              path: childPath,
              parentAutoLayout: !!emitted.autoLayout,
            });
          }
        }
      }
    }

    building.delete(key);
    var nativeProperties = nativePropertiesForBindings(bindings, key);
    var nativePropertyIds = Object.create(null);
    for (var np = 0; np < nativeProperties.length; np++) {
      nativePropertyIds[nativeProperties[np].propertyId] = true;
    }
    // Привязки Figma едут на самих узлах определения. Идентичность — только
    // публичный propertyId; фактическое имя (`Name#123`) появляется уже после
    // `addComponentProperty` на стороне Figma и там же подставляется.
    // Конфликт type↔field, отклонённый выше, не должен оставлять «висячую»
    // ссылку на property, которого приёмник намеренно не объявит.
    for (var nb = 0; nb < nodes.length; nb++) {
      var refsForNode = propertyRefsByNode.get(nodes[nb].id);
      if (!refsForNode || !refsForNode.length) continue;
      var nativeRefs = {};
      for (var nr = 0; nr < refsForNode.length; nr++) {
        var resolvedNodeRef = publicPropertyKey(refsForNode[nr].rawPropertyId, key);
        if (!resolvedNodeRef.key || !nativePropertyIds[resolvedNodeRef.key]) continue;
        var figmaField = FIGMA_COMPONENT_PROPERTY_FIELDS[refsForNode[nr].field];
        if (figmaField) nativeRefs[figmaField] = resolvedNodeRef.key;
      }
      if (Object.keys(nativeRefs).length) nodes[nb].componentPropertyReferences = nativeRefs;
    }
    var definition = {
      definitionId: key,
      componentKey: symbolRecord.componentKey || null,
      publicationIdentity: symbolRecord.publishFile && symbolRecord.publishID
        ? String(symbolRecord.publishFile) + "@" + doc.guidKey(symbolRecord.publishID) : null,
      publishFile: symbolRecord.publishFile || null,
      publishID: symbolRecord.publishID ? doc.guidKey(symbolRecord.publishID) : null,
      publishedVersion: symbolRecord.publishedVersion || null,
      variantGroupId: symbolRecord.parent && symbolRecord.parent.isStateGroup ? symbolRecord.parent.key : null,
      variantGroupName: symbolRecord.parent && symbolRecord.parent.isStateGroup ? symbolRecord.parent.name : null,
      // Нативная принадлежность к COMPONENT_SET. Поле есть ТОЛЬКО у участника
      // группы, прошедшей строгую проверку целиком: `variantGroupId` рядом
      // остаётся признаком «лежал в группе состояний» и о нативной сборке
      // ничего не утверждает. Приёмник имён не разбирает — координата и
      // порядок приезжают уже проверенными.
      variantSet: variantMember ? {
        groupId: variantMember.groupId,
        groupName: variantMember.groupName,
        groupComponentKey: variantMember.groupComponentKey,
        familyKey: variantMember.groupId,
        stableFamilyKey: variantMember.stableFamilyKey || null,
        publicationIdentity: variantMember.publicationIdentity || null,
        publishFile: variantMember.publishFile || null,
        publishID: variantMember.publishID || null,
        publishedVersion: variantMember.publishedVersion || null,
        variantName: variantMember.variantName,
        coordinateKey: variantMember.coordinateKey,
        coordinate: variantMember.coordinate,
        order: variantMember.order,
        sortKey: (variantMember.sortKey || []).slice(),
        axisCount: variantMember.axisCount,
        memberCountSource: variantMember.memberCountSource,
        familyCoordinates: (variantMember.familyCoordinates || []).slice(),
        // Исходное имя Pixso — supporting slash-separated component naming evidence only;
        // native membership still comes from the verified state group.
        // на проверенной координате, а не на нём.
        sourceName: variantMember.sourceName,
      } : null,
      name: symbolRecord.name || "Component",
      nativeProperties: nativeProperties,
      nodes: nodes,
    };
    definitions.set(key, definition);
    // В ОБЩИЙ реестр ключ попадает только вместе с успешно вернувшейся
    // сборкой. Сборка, упавшая посередине, оставляла бы здесь определения,
    // которые никто никогда не отправит: следующий корень считал бы их уже
    // известными и уехал бы ссылкой на несуществующий компонент.
    committedDefinitions.push(key);
    definitionDependencies.set(key, nodes.reduce(function (out, node) {
      if (node.kind === "INSTANCE" && node.definitionId && out.indexOf(node.definitionId) < 0) {
        out.push(node.definitionId);
      }
      (node.nativeProperties || []).forEach(function (entry) {
        var dependency = entry && entry.swapDefinitionId;
        if (dependency && out.indexOf(dependency) < 0) out.push(dependency);
      });
      (node.overrides || []).forEach(function (entry) {
        var dependency = entry.ops && entry.ops.swapDefinitionId;
        if (dependency && out.indexOf(dependency) < 0) out.push(dependency);
      });
      (definition.nativeProperties || []).forEach(function (property) {
        var defaultDependency = property && property.type === "INSTANCE_SWAP" ? property.defaultValue : null;
        if (defaultDependency && out.indexOf(defaultDependency) < 0) out.push(defaultDependency);
      });
      return out;
    }, []));
    definitionPaths.set(key, paths);
    definitionIndexPaths.set(key, indexPaths);
    definitionShapes.set(key, shapeOf(indexPaths));
    definitionVisualLosses.set(key, definitionLosses);
    definitionPropertyBindings.set(key, bindings);
    stats.definitionsBuilt += 1;
    stats.definitionNodes += nodes.length;

    // D53. Семейство вариантов доезжает целиком до первого своего вхождения.
    //
    // Измерено на настоящем файле: у 28 семейств из 135 участники приходят
    // РАЗНЫМИ корнями, и во всех 28 случаях вхождения создаются раньше, чем
    // доедет последний участник. Приёмник в этот момент делает `appendChild`
    // в уже собранный COMPONENT_SET и заново объявляет схему свойств на нём.
    // Живая Figma при этом переразрешает УЖЕ СУЩЕСТВУЮЩИЕ вхождения этого
    // набора — и слои, чья видимость привязана к свойству набора, возвращаются
    // к умолчанию мастера. Отсюда и наблюдаемое «первый раз боковое меню
    // правильное, на следующих проходах нужные слои скрываются, а ненужные
    // показываются».
    //
    // Лечится это не подпоркой в приёмнике, а порядком: все ВОСТРЕБОВАННЫЕ
    // участники семейства эмитируются одним чанком вместе с первым из них.
    // Объём работы тот же — эти определения всё равно уехали бы, только позже
    // и уже после создания вхождений. Ничего неиспользуемого не тянется:
    // список спроса считает отправитель по тем же корням, что и мигрирует.
    if (variantMember && familyDemand) {
      var demandedSiblings = familyDemand.get(variantMember.groupId);
      if (demandedSiblings) {
        for (var ds = 0; ds < demandedSiblings.length; ds++) {
          var siblingKey = demandedSiblings[ds];
          if (siblingKey === key) continue;
          if (definitions.has(siblingKey) || knownDefinitions.has(siblingKey)) continue;
          if (building.has(siblingKey)) continue;
          var siblingRecord = doc.symbols.symbolsById.get(siblingKey);
          if (!siblingRecord) continue;
          if (ensureDefinition(siblingRecord)) stats.variantFamilyMembersPulled += 1;
        }
      }
    }
    return key;
  }

  /**
   * Общий эмиттер: инстанс становится вхождением определения, всё остальное —
   * обычным узлом. Возвращает добавленный узел IR или null.
   */
  /**
   * Подмены одного вхождения внутри мастера — в адреса определения.
   *
   * Вхождение адресует подмену своим guid-путём ОТ СЕБЯ. Определение
   * адресуется guid-путём от собственного корня, поэтому ключ склеивается из
   * пути до самого вхождения и пути записи. Обе части — исходные guid-ы
   * Pixso: ни имён, ни индексов здесь нет.
   */
  function registerInternalSwaps(nodeKey, swaps) {
    var prefixes = swaps ? Object.keys(swaps) : [];
    if (!nodeKey || !prefixes.length) return;
    for (var i = 0; i < prefixes.length; i++) {
      var full = nodeKey + "/" + prefixes[i];
      // Узел один, его записи одни и те же: повторная регистрация того же
      // адреса — это тот же ответ, а не второе мнение.
      if (declaredInternalSwaps.has(full)) continue;
      declaredInternalSwaps.set(full, swaps[prefixes[i]]);
      stats.definitionInternalSwapsIndexed = (stats.definitionInternalSwapsIndexed || 0) + 1;
    }
  }

  function emitNode(record, parentId, parentAutoLayout, nodes, definitionLossSink, swapSink) {
    if (record.type === "INSTANCE") {
      var instanceNode = instanceOccurrence(record, parentId, parentAutoLayout, swapSink);
      if (instanceNode) {
        var losses = instanceNode.visualLosses;
        if (losses && definitionLossSink) mergeLosses(definitionLossSink, losses);
        delete instanceNode.visualLosses;
        var visualFallbackEligible = instanceNode.visualFallbackEligible === true;
        delete instanceNode.visualFallbackEligible;
        var symbolOfOccurrence = instanceNode.sourceSymbol;
        delete instanceNode.sourceSymbol;
        stats.nativeInstancesConsidered += 1;

        // Шлюз визуальной безопасности. Нативный инстанс создаётся только
        // тогда, когда всё состояние вхождения доехало до цели. Иначе
        // сохраняется визуально верное поддерево: правильные пиксели важнее
        // нативной компонентной чистоты, и отказ обязан быть явным, а не
        // молчаливым.
        // Внутри определения разворот запрещён. Определение — это мастер
        // компонента, и его дерево служит системой координат для адресов
        // ВСЕХ его вхождений: развёрнутое поддерево сместило бы эту систему,
        // и правки поехали бы мимо у каждого вхождения сразу. Потеря внутри
        // определения честно считается и остаётся видимой в отчёте.
        var canExpand = visualSafety && visualFallbackEligible && building.size === 0 &&
          (!symbolOfOccurrence || !expanding.has(symbolOfOccurrence.key));
        if (losses && canExpand) {
          instanceNode.expressibility = Expressibility.fallbackDecision(losses);
          expressibility.record("occurrence:" + record.key, instanceNode.expressibility, record.key);
          instanceNode.visualLosses = losses;
          instanceNode.sourceSymbol = symbolOfOccurrence;
          var expandedAt = nodes.length;
          var expanded = expandOccurrence(record, instanceNode, parentId, parentAutoLayout, nodes);
          if (expanded) {
            stats.nativeInstanceFallbacks += 1;
            Object.keys(losses).forEach(function (reason) {
              stats.nativeFallbackByReason[reason] =
                (stats.nativeFallbackByReason[reason] || 0) + 1;
            });
            return expanded;
          }
          // Развернуть не удалось: возвращаемся к нативному инстансу и
          // считаем это отдельно — «страховка не сработала» и «страховка не
          // понадобилась» не одно и то же.
          nodes.length = expandedAt;
          delete instanceNode.visualLosses;
          delete instanceNode.sourceSymbol;
          stats.nativeInstanceFallbacksFailed += 1;
        }
        if (losses) {
          if (!instanceNode.expressibility) {
            instanceNode.expressibility = Expressibility.fallbackDecision(losses);
            expressibility.record("occurrence:" + record.key, instanceNode.expressibility, record.key);
          }
          stats.nativeInstancesWithLostState += 1;
          stats.nativeInstancesUnsafe += 1;
          Object.keys(losses).forEach(function (reason) {
            stats.nativeUnsafeByReason[reason] =
              (stats.nativeUnsafeByReason[reason] || 0) + 1;
          });
          if (stats.nativeUnsafeSamples.length < 20) {
            stats.nativeUnsafeSamples.push({
              occurrenceId: record.key,
              definitionId: instanceNode.definitionId,
              reasons: Object.keys(losses).sort(),
            });
          }
          var sourceSafety = instanceNode.visualSafety || {};
          instanceNode.visualSafety = {
            safe: false,
            reasons: Object.keys(losses).sort(),
            directReasons: sourceSafety.directReasons || [],
            inheritedReasons: sourceSafety.inheritedReasons || [],
          };
        }
        else stats.nativeInstancesVisualSafe += 1;

        nodes.push(instanceNode);
        stats.instancesEmitted += 1;
        return instanceNode;
      }
      // Инстанс без пригодного определения не исчезает: он уходит обычным
      // узлом-контейнером и обязательно попадает в счётчик.
      stats.instanceFallbacks += 1;
      markVisualLoss(definitionLossSink, "UNRESOLVED_SYMBOL");
      var fallback = ordinaryNode(record, parentId, parentAutoLayout, definitionLossSink);
      if (fallback) {
        fallback.type = "FRAME";
        fallback.directPixFallback = true;
        nodes.push(fallback);
        stats.ordinaryNodesEmitted += 1;
      }
      return fallback;
    }

    var node = ordinaryNode(record, parentId, parentAutoLayout, definitionLossSink);
    if (!node) return null;
    if (record.type === "SYMBOL") stats.symbolsInlined += 1;
    nodes.push(node);
    stats.ordinaryNodesEmitted += 1;
    return node;
  }

  // -------------------------------------------------------------------------
  // Вхождения и overrides
  // -------------------------------------------------------------------------

  /**
   * Pixso stores a technical auto-generated raw name (usually `Instance N`)
   * on many component occurrences while the editor tree displays the logical
   * component family name.  That raw storage name is not user intent and must
   * not leak into Figma.  A genuinely user-authored occurrence name remains
   * authoritative.
   *
   * For variants, the display family is the containing state group; the child
   * SYMBOL name is the variant coordinate and belongs to component-set
   * mechanics, not to the occurrence layer name.  For a standalone component
   * the SYMBOL name is the best source display name.
   */
  function occurrenceDisplayName(record, symbolRecord) {
    var raw = String(record && record.name || "").trim();

    // The serialized occurrence name is not a reliable display-name source.
    // Pixso localizes its generated instance labels (for example the same
    // technical label is different in different editor locales), so trying to
    // recognize `Instance N` by spelling is inherently incomplete.
    //
    // Component identity is locale-independent: a variant occurrence is named
    // from its containing state-group family, and a standalone occurrence from
    // its SYMBOL. A real user rename is represented by the root-level name
    // override and is applied below after buildOverrides(). Therefore the raw
    // storage label is diagnostic only; it never decides the visible name.
    var family = symbolRecord && symbolRecord.parent && symbolRecord.parent.isStateGroup
      ? String(symbolRecord.parent.name || "").trim() : "";
    var component = symbolRecord ? String(symbolRecord.name || "").trim() : "";
    var display = family || component || raw || "Instance";
    return { name: display, rawName: raw || null, source: family ? "STATE_GROUP" : "COMPONENT" };
  }

  function instanceOccurrence(record, parentId, parentAutoLayout, swapSink) {
    stats.pixInstancesSeen += 1;
    // Каноническая идентичность вхождения. Связь описана обеими
    // спецификациями одинаково: `symbolData.symbolID` вхождения равен `guid`
    // записи SYMBOL, которая лежит на служебном полотне.
    var resolution = doc.symbols.resolveSymbol(record);
    var symbolRecord = resolution.symbol;
    if (!symbolRecord) {
      noteCanonicalMiss(record, resolution.reason);
      note(IR_UNSUPPORTED.UNRESOLVED_SYMBOL, record.symbolId || record.key);
      return null;
    }
    stats.canonicalResolved += 1;
    if (resolution.via === "INTERNAL_ONLY") stats.resolvedViaInternalOnly += 1;
    else stats.resolvedViaSymbolData += 1;

    // Определение не собирается ровно в одном случае: символ прямо или
    // косвенно содержит вхождение самого себя. Развернуть его содержимое
    // здесь нельзя — это и есть бесконечность, а произвольная глубина была бы
    // выдумкой. Вхождение уходит помеченным пустым фреймом и считается.
    var definitionId = ensureDefinition(symbolRecord);
    if (!definitionId) return null;

    var detail = doc.detail(record);
    rememberPropertyRefs(record, detail);
    var losses = Object.create(null);
    var inheritedDefinitionLosses = definitionVisualLosses.get(definitionId);
    mergeLosses(losses, inheritedDefinitionLosses);
    var occurrenceLosses = Object.create(null);
    var occurrenceName = occurrenceDisplayName(record, symbolRecord);
    var node = {
      id: record.key,
      parent: parentId,
      kind: "INSTANCE",
      type: "INSTANCE",
      definitionId: definitionId,
      name: occurrenceName.name,
      sourceOccurrenceName: occurrenceName.name,
      rawSourceOccurrenceName: occurrenceName.rawName,
      occurrenceNameSource: occurrenceName.source,
      sourceOverrideKey: record.overrideKey ? doc.guidKey(record.overrideKey) : null,
      // Pixso `propsAreBubbled` is definition semantics: the primary nested
      // INSTANCE exposes its own component controls through the containing
      // component. Figma represents the same relationship with
      // `InstanceNode.isExposedInstance`.
      isExposedInstance: detail.propsAreBubbled === true,
    };

    var place = normalizer.placement(detail, record.key);
    node.x = place.x;
    node.y = place.y;
    if (place.relativeTransform) node.relativeTransform = place.relativeTransform;
    else if (place.rotation) node.rotation = place.rotation;
    if (transformIsUnsupported(detail.transform)) markVisualLoss(losses, "TRANSFORM_UNSUPPORTED");
    if (detail.size) { node.width = detail.size.x; node.height = detail.size.y; }
    // Pixso stores visual scaling of a component occurrence separately from
    // its transform/size. Resizing a native Figma instance only changes its
    // outer box according to constraints; it does not reproduce Pixso's
    // uniform scale of vector/text/stroke geometry. Preserve the explicit
    // factor so the receiver can use SceneNode.rescale().
    if (detail.symbolData && typeof detail.symbolData.uniformScaleFactor === "number" &&
        isFinite(detail.symbolData.uniformScaleFactor) && detail.symbolData.uniformScaleFactor > 0 &&
        Math.abs(detail.symbolData.uniformScaleFactor - 1) > 1e-4) {
      node.uniformScaleFactor = detail.symbolData.uniformScaleFactor;
    }
    if (detail.visible === false) node.visible = false;
    if (typeof detail.opacity === "number" && detail.opacity !== 1) node.opacity = detail.opacity;
    if (detail.locked) node.locked = true;
    var occurrenceBlend = normalizer.blendMode(detail.blendMode);
    if (occurrenceBlend && occurrenceBlend !== "PASS_THROUGH" && occurrenceBlend !== "NORMAL") {
      node.blendMode = occurrenceBlend;
    }
    if (detail.mask) {
      node.isMask = true;
      var occurrenceMaskType = normalizer.maskType(detail.maskType);
      if (occurrenceMaskType) node.maskType = occurrenceMaskType;
    }
    // An occurrence with no frameMaskDisabled field inherits its master.
    // Explicit false/true is an actual clipping override and must travel.
    var occurrenceClipsContent = normalizer.clipsContent(detail, record.type);
    if (typeof occurrenceClipsContent === "boolean") node.clipsContent = occurrenceClipsContent;

    var occurrenceFillSource = normalizer.effectivePaints(detail, "fillPaints", "inheritFillStyleID");
    var occurrenceFills = normalizer.paints(occurrenceFillSource, record.key);
    if (occurrenceFills) node.fills = occurrenceFills;
    if (visibleSourceCount(occurrenceFillSource) > (occurrenceFills ? occurrenceFills.length : 0)) {
      markVisualLoss(losses, "PAINT_UNSUPPORTED");
    }
    var occurrenceStrokeSource = normalizer.effectivePaints(detail, "strokePaints", "inheritStrokeStyleID");
    var occurrenceStrokes = normalizer.paints(occurrenceStrokeSource, record.key);
    if (occurrenceStrokes) node.strokes = occurrenceStrokes;
    if (visibleSourceCount(occurrenceStrokeSource) > (occurrenceStrokes ? occurrenceStrokes.length : 0)) {
      markVisualLoss(losses, "PAINT_UNSUPPORTED");
    }
    var occurrenceEffectSource = normalizer.effectiveEffects(detail);
    var occurrenceEffects = normalizer.effects(occurrenceEffectSource, record.key);
    if (occurrenceEffects) node.effects = occurrenceEffects;
    if (visibleSourceCount(occurrenceEffectSource) > (occurrenceEffects ? occurrenceEffects.length : 0)) {
      markVisualLoss(losses, "EFFECT_UNSUPPORTED");
    }
    var occurrenceCorners = normalizer.corners(detail);
    if (occurrenceCorners) node.corners = occurrenceCorners;

    var childPlacement = normalizer.childLayout(detail, parentAutoLayout);
    if (childPlacement) node.childLayout = childPlacement;
    // min/max принадлежат самой коробке occurrence. Определение может иметь
    // те же bounds, но Figma instance их не обязана наследовать как свойство
    // узла. Без явного переноса HUG-вхождение схлопывается ниже Pixso
    // (реальный класс: table/cell 40 → 32 при minHeight=40).
    var occurrenceBounds = normalizer.sizeBounds(detail);
    if (occurrenceBounds) node.sizeBounds = occurrenceBounds;
    var nodeConstraints = normalizer.constraints(detail);
    if (nodeConstraints) node.constraints = nodeConstraints;
    if (detail.proportionsConstrained === true) node.aspectRatioLocked = true;

    var occurrenceBindings = styleBindings(detail, node);
    if (occurrenceBindings) node.styles = occurrenceBindings;

    var nativeProperties = [];
    var sourceBoxes = [];
    var overrides = buildOverrides(detail, definitionId, record, occurrenceLosses, nativeProperties, swapSink, sourceBoxes);
    mergeLosses(losses, occurrenceLosses);
    if (overrides.length) node.overrides = overrides;
    if (sourceBoxes.length) node.sourceBoxes = sourceBoxes;
    // A root-level explicit name override is the occurrence layer name that
    // Pixso actually displays. It is stronger than both the technical raw
    // `Instance N` storage name and the family fallback. Nested name overrides
    // remain content overrides and do not rename the outer occurrence.
    for (var occurrenceNameIndex = 0; occurrenceNameIndex < overrides.length; occurrenceNameIndex++) {
      var occurrenceNameOverride = overrides[occurrenceNameIndex];
      if (!occurrenceNameOverride || (occurrenceNameOverride.path && occurrenceNameOverride.path.length)) continue;
      if (occurrenceNameOverride.ops && typeof occurrenceNameOverride.ops.name === "string" &&
          occurrenceNameOverride.ops.name.trim()) {
        node.name = occurrenceNameOverride.ops.name;
        node.sourceOccurrenceName = occurrenceNameOverride.ops.name;
        node.occurrenceNameSource = "ROOT_OVERRIDE";
      }
    }
    if (nativeProperties.length) node.nativeProperties = nativeProperties;
    if (Object.keys(losses).length) {
      // Нативный инстанс этого вхождения показал бы не то, что показывает
      // Pixso: часть его состояния до цели не доехала. Решение принимает
      // вызывающий — здесь только диагноз.
      node.visualLosses = losses;
      node.visualFallbackEligible = Object.keys(occurrenceLosses).length > 0;
      node.visualSafety = {
        safe: false,
        reasons: Object.keys(losses).sort(),
        directReasons: Object.keys(occurrenceLosses).sort(),
        inheritedReasons: inheritedDefinitionLosses
          ? Object.keys(inheritedDefinitionLosses).sort() : [],
      };
    }
    node.sourceSymbol = symbolRecord;
    return node;
  }

  /**
   * Развёрнутое поддерево вхождения — страховка на случай, когда нативный
   * инстанс заведомо неверен.
   *
   * Собирается тем же кодом, что и определение: корнем берётся сам символ,
   * поверх ложатся собственные геометрия и видимость вхождения, а затем — его
   * дельта, разложенная по тем же индексным путям. Вложенные инстансы внутри
   * остаются нативными: разворачивается ровно то вхождение, которое иначе
   * приехало бы сломанным.
   *
   * Возвращает корневой узел разворота либо null, если развернуть не удалось —
   * тогда вызывающий оставляет нативный инстанс и честно это считает.
   */
  /**
   * Эталонный размер узлов разворота — только диагностика сверки
   * (`DirectPix/ScreenCheck.js`), приёмник его не читает.
   *
   * Потомки разворота строятся из геометрии определения, поэтому их
   * `width/height` — размеры мастера, а не то, что Pixso нарисовал во
   * вхождении: шапка, растянутая родителем до 1104, записана 960. Настоящий
   * размер есть только там, где его сохранил снимок `derivedSymbolData`
   * (`sourceBoxes` вхождения). Для остальных эталона нет, и сверка обязана
   * их пропустить, а не считать расхождением.
   */
  function markExpansionReferenceSizes(occurrence, byIndexPath) {
    var boxes = Object.create(null);
    (occurrence.sourceBoxes || []).forEach(function (box) {
      var key = (box.path || []).map(function (step) { return step.index; }).join(".");
      if (key) boxes[key] = box;
    });
    byIndexPath.forEach(function (emitted, key) {
      if (!key || !emitted) return;
      var box = boxes[key];
      emitted.referenceSize = box
        ? { source: "DERIVED_SNAPSHOT", width: box.width, height: box.height }
        : { source: "DEFINITION_GEOMETRY" };
    });
  }

  function expandOccurrence(record, occurrence, parentId, parentAutoLayout, nodes) {
    var symbolRecord = occurrence.sourceSymbol;
    if (!symbolRecord) return null;
    if (expanding.has(symbolRecord.key)) return null;
    var root = ordinaryNode(symbolRecord, parentId, parentAutoLayout);
    if (!root) return null;
    var nestedSnapshotExpansion = snapshotExpansionDepth > 0;
    expanding.add(symbolRecord.key);
    // Идентичность и место в дереве — от вхождения, содержимое — от символа.
    // Top-level fallback keeps the occurrence id. A fallback nested inside
    // another snapshot must be namespaced by its already-scoped parent,
    // otherwise two outer occurrences of the same definition generate the
    // same nested occurrence/descendant ids.
    root.id = nestedSnapshotExpansion
      ? parentId + ";snapshot-occ:" + record.key
      : record.key;
    if (nestedSnapshotExpansion) root.directPixFallbackSourceId = record.key;
    snapshotExpansionDepth += 1;
    root.type = CONTAINER_TYPES[root.type] ? "FRAME" : root.type;
    root.name = occurrence.name;
    root.x = occurrence.x;
    root.y = occurrence.y;
    if (occurrence.rotation !== undefined) root.rotation = occurrence.rotation;
    if (occurrence.width !== undefined) root.width = occurrence.width;
    if (occurrence.height !== undefined) root.height = occurrence.height;
    if (occurrence.visible === false) root.visible = false;
    if (occurrence.opacity !== undefined) root.opacity = occurrence.opacity;
    if (occurrence.childLayout) root.childLayout = occurrence.childLayout;
    if (occurrence.constraints) root.constraints = occurrence.constraints;
    root.directPixVisualFallback = Object.keys(occurrence.visualLosses || {}).sort().join(",");
    if (occurrence.expressibility) root.expressibility = occurrence.expressibility;
    nodes.push(root);
    stats.ordinaryNodesEmitted += 1;

    // Тело разворота строится ровно как тело определения, поэтому индексные
    // пути дельты совпадают шаг в шаг.
    var byIndexPath = new Map();
    byIndexPath.set("", root);
    // The snapshot root may be namespaced when this fallback is itself nested
    // inside another fallback. Descendants must attach to the ACTUAL emitted
    // root id, not the canonical occurrence guid, otherwise the receiver cannot
    // find their parent and silently drops deep nested instances.
    var stack = [{ record: symbolRecord, parentId: root.id, path: [], parentAutoLayout: !!root.autoLayout }];
    while (stack.length) {
      var frame = stack.pop();
      var children = frame.record.children;
      var emittedIndex = 0;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var emitted = emitNode(child, frame.parentId, frame.parentAutoLayout, nodes);
        if (!emitted) continue;
        var childPath = frame.path.concat([emittedIndex]);
        emittedIndex += 1;
        // Several unsafe occurrences of the same definition may be expanded
        // inside one migrated root. Definition GUIDs are therefore not valid
        // node identities for snapshot descendants: every expansion would
        // otherwise emit the same ids and the receiver's byId map would bind
        // later children to an earlier occurrence. Keep the canonical source
        // guid only as diagnostic data and namespace the actual IR identity by
        // occurrence + definition-relative index path.
        var canonicalFallbackSourceId = child.key;
        // `emitNode` may itself have expanded an unsafe nested INSTANCE. Such
        // a root is already scoped by `expandOccurrence`; ordinary definition
        // descendants still carry their canonical guid and are scoped here.
        if (emitted.id === canonicalFallbackSourceId) {
          emitted.id = root.id + ";snapshot:" + childPath.join(".") + ";" + canonicalFallbackSourceId;
          emitted.directPixFallbackSourceId = canonicalFallbackSourceId;
        }
        byIndexPath.set(childPath.join("."), emitted);
        if (emitted.kind === "ORDINARY" && child.children.length && CONTAINER_TYPES[emitted.type]) {
          stack.push({
            record: child,
            parentId: emitted.id,
            path: childPath,
            parentAutoLayout: !!emitted.autoLayout,
          });
        }
      }
    }

    var entries = occurrence.overrides || [];
    for (var e = 0; e < entries.length; e++) applyEntryToExpansion(entries[e], byIndexPath);
    markExpansionReferenceSizes(occurrence, byIndexPath);
    snapshotExpansionDepth -= 1;
    expanding.delete(symbolRecord.key);
    return root;
  }

  /**
   * Кладёт одну запись дельты на развёрнутое дерево.
   *
   * Путь, уходящий внутрь вложенного инстанса, на развёрнутом дереве не
   * раскрывается: он остаётся дельтой этого инстанса — с укороченным на
   * пройденную часть адресом.
   */
  function applyEntryToExpansion(entry, byIndexPath) {
    var path = entry.path || [];
    for (var depth = path.length; depth >= 0; depth--) {
      var key = path.slice(0, depth).map(function (step) { return step.index; }).join(".");
      var node = byIndexPath.get(key);
      if (!node) continue;
      if (depth === path.length) {
        mergeOpsIntoNode(node, entry.ops, entry.present);
        return;
      }
      if (node.kind !== "INSTANCE") return;
      // Дальше начинается чужое поддерево — адрес отдаётся его инстансу.
      applyOccurrenceEntry(node, {
        path: path.slice(depth),
        ops: entry.ops,
        present: entry.present,
        diagnostic: entry.diagnostic,
      });
      return;
    }
  }

  /** Совпадают ли два адреса шаг в шаг: и по узлу, и по определению. */
  function samePathContext(left, right) {
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i].index !== right[i].index) return false;
      if (left[i].sourceId !== right[i].sourceId) return false;
      if (left[i].definitionId !== right[i].definitionId) return false;
    }
    return true;
  }

  /**
   * Кладёт дельту ВНЕШНЕГО вхождения на вложенный инстанс развёрнутого
   * поддерева.
   *
   * У такого узла уже есть своя дельта — то, как он выглядит внутри
   * определения. Дельта вхождения ей не соседка: она ложится ПОВЕРХ, ровно
   * так же, как в Pixso вхождение патчит состояние компонента. Две записи на
   * один адрес — это два разных семантических контекста на одном узле, и
   * приёмник применял бы их в порядке массива: на настоящем файле именно так
   * дельта определения затирала текст вхождения.
   *
   * Контексты сравниваются целиком. Совпали — дельта вхождения перекрывает
   * свои ключи и не трогает остальные. Не совпали — вхождение показывает
   * здесь другое определение (подмена), и адрес прежней записи ведёт в чужое
   * дерево: она снимается с типизированной причиной.
   */
  function applyOccurrenceEntry(node, entry) {
    var list = node.overrides || [];
    var key = indexKeyOf(entry.path);
    for (var i = 0; i < list.length; i++) {
      var existing = list[i];
      if (indexKeyOf(existing.path) !== key) continue;
      if (samePathContext(existing.path, entry.path)) {
        var fields = Object.keys(entry.ops || {});
        for (var f = 0; f < fields.length; f++) {
          var field = fields[f];
          if (Object.prototype.hasOwnProperty.call(existing.ops, field)) {
            // Перекрытая операция определения не уезжает: счётчик
            // отправленного обязан это показывать.
            stats.overridesAttempted -= 1;
            stats.overridesApplied -= 1;
            stats.overrideDefinitionOpsOverridden += 1;
          }
          existing.ops[field] = entry.ops[field];
          if (entry.present && entry.present[field] !== undefined) {
            existing.present[field] = entry.present[field];
          }
        }
        if (entry.diagnostic) existing.diagnostic = entry.diagnostic;
        return;
      }
      // Тот же адрес по индексам, но посчитанный в другом определении.
      // Побеждает дельта вхождения: именно она знает, что здесь показано.
      var count = Object.keys(existing.ops || {}).length;
      stats.overridesAttempted -= count;
      stats.overridesApplied -= count;
      stats.overridesDropped += count;
      stats.overrideContextInvalidated += count;
      var existingDiagnostic = existing.diagnostic || {};
      noteOverrideResolution(OVERRIDE_RESOLUTION.OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP, {
        instanceSourceId: existingDiagnostic.instanceSourceId || node.id,
        sourceSymbolId: existingDiagnostic.sourceSymbolId || null,
        canonicalDefinitionId: existing.path.length ? existing.path[0].definitionId : null,
        componentKey: existingDiagnostic.componentKey || null,
        overrideFields: Object.keys(existing.ops || {}),
        guidPath: existingDiagnostic.guidPath || [],
        expectedTargetGuid: existing.path.length
          ? existing.path[existing.path.length - 1].sourceId : null,
        expectedTargetType: existing.path.length
          ? existing.path[existing.path.length - 1].targetType : null,
        deepestResolvedSegment: existing.path.length,
        activeSymbolBefore: existing.path.length ? existing.path[0].definitionId : null,
        activeSymbolAfter: entry.path.length ? entry.path[0].definitionId : null,
      });
      list[i] = entry;
      return;
    }
    list.push(entry);
    list.sort(function (a, b) { return a.path.length - b.path.length; });
    node.overrides = list;
  }

  /**
   * Контекст разрешения одной записи override — определение, В ДЕРЕВЕ
   * КОТОРОГО посчитан её адрес.
   *
   * Каждый шаг пути несёт `definitionId`; первый шаг называет определение,
   * относительно которого путь начинается. Пустой путь адресует сам узел и от
   * определения не зависит.
   */
  function overrideEntryContext(entry) {
    var first = entry && entry.path && entry.path.length ? entry.path[0] : null;
    return first && first.definitionId ? first.definitionId : null;
  }

  /**
   * Снимает с узла записи, разрешённые в определении, которое узел больше не
   * показывает.
   *
   * Адрес override — это адрес В КОНКРЕТНОМ определении, а не в узле вообще.
   * Структурная операция (подмена компонента) меняет активное определение
   * узла уже после того, как путь посчитан, и все ранее разрешённые под ним
   * адреса становятся адресами чужого дерева. Оставить их нельзя: в лучшем
   * случае они не найдутся, в худшем — совпадут по индексу с посторонним
   * узлом и запишут туда чужой текст. Именно так собственная дельта
   * определения («Column Header») оказывалась поверх подменённого компонента.
   *
   * Совпадение типов и имён здесь не рассматривается: доказательством
   * является только совпадение определения.
   */
  function dropForeignContextOverrides(node, reason, previousDefinitionId) {
    if (!node || !node.overrides || !node.overrides.length) return;
    var kept = [];
    for (var i = 0; i < node.overrides.length; i++) {
      var entry = node.overrides[i];
      var context = overrideEntryContext(entry);
      if (!context || context === node.definitionId) { kept.push(entry); continue; }
      var count = Object.keys(entry.ops || {}).length;
      // Запись не уезжает: счётчики отправленного обязаны это показывать,
      // иначе «применено» перестаёт быть проверяемым утверждением.
      stats.overridesAttempted -= count;
      stats.overridesApplied -= count;
      stats.overridesDropped += count;
      if (reason === OVERRIDE_RESOLUTION.OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP) {
        stats.overrideContextInvalidated += count;
      } else {
        stats.overrideContextMismatched += count;
      }
      var diagnostic = entry.diagnostic || {};
      noteOverrideResolution(reason, {
        instanceSourceId: diagnostic.instanceSourceId || node.id,
        sourceSymbolId: diagnostic.sourceSymbolId || null,
        canonicalDefinitionId: previousDefinitionId || context,
        componentKey: diagnostic.componentKey || null,
        overrideFields: Object.keys(entry.ops || {}),
        guidPath: diagnostic.guidPath || [],
        expectedTargetGuid: entry.path.length
          ? entry.path[entry.path.length - 1].sourceId : null,
        expectedTargetType: entry.path.length
          ? entry.path[entry.path.length - 1].targetType : null,
        deepestResolvedSegment: entry.path.length,
        activeSymbolBefore: context,
        activeSymbolAfter: node.definitionId,
      });
    }
    if (kept.length) node.overrides = kept;
    else delete node.overrides;
  }

  /**
   * Финальная проверка инварианта: у каждого вхождения путь каждой записи
   * начинается в том определении, которое вхождение показывает.
   *
   * Проверка держится не на знании о конкретных путях сборки, а на самом
   * инварианте: любой будущий код, который сменит определение узла и забудет
   * про его адреса, упрётся сюда, а не в тихую правку чужого дерева.
   */
  function enforceOverrideContexts(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.kind !== "INSTANCE" || !node.overrides) continue;
      dropForeignContextOverrides(
        node, OVERRIDE_RESOLUTION.WRONG_ACTIVE_DEFINITION_CONTEXT, null
      );
      if (node.overrides) dropPreSwapDescendantOverrides(node);
    }
  }

  /** Явно ли запись объявляет операцию. Зеркалит правило приёмника. */
  function overrideOpExplicit(entry, key) {
    if (!entry || !entry.ops) return false;
    if (!entry.present) return Object.prototype.hasOwnProperty.call(entry.ops, key);
    return entry.present[key] === true;
  }

  /**
   * Снимает потомков ВЛОЖЕННОЙ подмены, посчитанных в старом определении.
   *
   * `dropForeignContextOverrides` проверяет только нулевой шаг — определение
   * самого вхождения. Подмена же может стоять на вложенном адресе, и тогда
   * контекст меняется НЕ у вхождения, а у узла в середине пути. Потомки под
   * этим узлом делятся на две группы, и различает их только определение на
   * шаге подмены:
   *
   *   шаг == новое определение → адрес посчитан уже после подмены, остаётся;
   *   шаг == прежнее           → адрес ведёт в дерево, которого здесь больше
   *                              нет, и уезжать он не имеет права.
   *
   * Приёмник ловит такую запись как `WRONG_NESTED_SWAP_CONTEXT` — и делает
   * это правильно. Но защита приёмника не повод отправлять заведомо
   * недействительный адрес: снять его дешевле и честнее на отправителе.
   * Пересчитывать операцию в новое определение здесь запрещено: она
   * принадлежит старому, и «похожий» адрес в новом дереве — это догадка.
   */
  function dropPreSwapDescendantOverrides(node) {
    var list = node.overrides || [];
    var swaps = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry.path || !entry.path.length) continue;
      if (!overrideOpExplicit(entry, "swapDefinitionId")) continue;
      swaps.push({ path: entry.path, definitionId: entry.ops.swapDefinitionId });
    }
    if (!swaps.length) return;

    var kept = [];
    for (var j = 0; j < list.length; j++) {
      var candidate = list[j];
      var foreignSwap = null;
      for (var k = 0; k < swaps.length && !foreignSwap; k++) {
        var swap = swaps[k];
        var depth = swap.path.length;
        if (!candidate.path || candidate.path.length <= depth) continue;
        if (candidate.path === swap.path) continue;
        if (!samePathContext(candidate.path.slice(0, depth), swap.path)) continue;
        var context = candidate.path[depth] && candidate.path[depth].definitionId;
        // Недоказанный контекст не улика: без definitionId на этом шаге
        // сказать, из какого дерева адрес, нечем.
        if (!context || context === swap.definitionId) continue;
        foreignSwap = swap;
      }
      if (!foreignSwap) { kept.push(candidate); continue; }

      var count = Object.keys(candidate.ops || {}).length;
      stats.overridesAttempted -= count;
      stats.overridesApplied -= count;
      stats.overridesDropped += count;
      stats.overrideContextInvalidated += count;
      var diagnostic = candidate.diagnostic || {};
      noteOverrideResolution(OVERRIDE_RESOLUTION.OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP, {
        instanceSourceId: diagnostic.instanceSourceId || node.id,
        sourceSymbolId: diagnostic.sourceSymbolId || null,
        canonicalDefinitionId: candidate.path[foreignSwap.path.length].definitionId,
        componentKey: diagnostic.componentKey || null,
        overrideFields: Object.keys(candidate.ops || {}),
        guidPath: diagnostic.guidPath || [],
        expectedTargetGuid: candidate.path[candidate.path.length - 1].sourceId || null,
        expectedTargetType: candidate.path[candidate.path.length - 1].targetType || null,
        deepestResolvedSegment: foreignSwap.path.length,
        activeSymbolBefore: candidate.path[foreignSwap.path.length].definitionId,
        activeSymbolAfter: foreignSwap.definitionId,
      });
    }
    if (kept.length) node.overrides = kept;
    else delete node.overrides;
  }

  /** Операции дельты, положенные прямо в спецификацию узла. */
  function mergeOpsIntoNode(node, ops, present) {
    var keys = Object.keys(ops || {});
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (present && present[key] !== true) continue;
      var value = ops[key];
      switch (key) {
        case "size":
          node.width = value.width;
          node.height = value.height;
          break;
        case "placement":
          if (value.x !== undefined) node.x = value.x;
          if (value.y !== undefined) node.y = value.y;
          if (value.rotation !== undefined) node.rotation = value.rotation;
          break;
        case "isMask":
          node.isMask = value;
          break;
        case "maskType":
          node.maskType = value;
          break;
        case "characters":
          if (typeof value === "string") node.text = merge(node.text || {}, { characters: value });
          break;
        case "textBoxWidth":
          if (node.type === "TEXT" && typeof value === "number" && isFinite(value) && value > 0.01) {
            node.width = value;
          }
          break;
        case "textStyle":
          if (value && typeof value === "object") node.text = merge(node.text || {}, value);
          break;
        case "visible":
          if (typeof value === "boolean") node.visible = value;
          break;
        case "fills":
        case "strokes":
        case "effects":
          if (Array.isArray(value)) {
            node[key] = value;
            // A TEXT spec carries its uniform paint twice on purpose: the
            // scene-level `fills` field participates in generic style binding,
            // while `text.fills` is what the receiver applies when it rebuilds
            // TextNode typography. Snapshot fallback materializes occurrence
            // overrides directly into that ordinary TEXT node, so updating only
            // the generic field leaves two contradictory resolved values. Keep
            // the text payload in lock-step; mixed range fills, if any, remain
            // authoritative for their own ranges and are applied later.
            if (key === "fills" && node.type === "TEXT") {
              node.text = merge(node.text || {}, { fills: value });
            }
          }
          break;
        case "fillStyleId":
        case "strokeStyleId":
        case "effectStyleId":
        case "textStyleId": {
          // Snapshot fallback materializes an occurrence override directly into
          // an ordinary node. Style identity is part of that resolved visual
          // state too: leaving the definition's base style attached lets the
          // receiver re-apply it AFTER the override paints and silently restore
          // the wrong colour/effect. `applyPaintOverride` / text/effect binding
          // only emit these ids after proving the resolved local value equals
          // the referenced style, so replacing the base binding is lossless.
          var styleChannel = key === "fillStyleId" ? "fill" :
            (key === "strokeStyleId" ? "stroke" :
              (key === "effectStyleId" ? "effect" : "text"));
          node.styles = merge(node.styles || {}, (function () {
            var out = {}; out[styleChannel] = value; return out;
          })());
          break;
        }
        case "layout":
          node.autoLayout = merge(node.autoLayout || {}, value);
          break;
        case "childLayout":
          node.childLayout = merge(node.childLayout || {}, value);
          break;
        case "sizeBounds":
          node.sizeBounds = merge(node.sizeBounds || {}, value);
          break;
        case "strokeStyle":
          if (value.strokeAlign !== undefined) node.strokeAlign = value.strokeAlign;
          if (value.strokeJoin !== undefined) node.strokeJoin = value.strokeJoin;
          if (value.strokeCap !== undefined) node.strokeCap = value.strokeCap;
          if (value.dashPattern !== undefined) node.dashPattern = value.dashPattern;
          if (value.borderWeights) {
            // Дельта вхождения может нести не все стороны. Накладывается она
            // поверх базы узла, а не вместо неё: сторона, которой в дельте
            // нет, остаётся такой, какой её задало определение.
            var base = node.borderWeights || (typeof node.strokeWeight === "number"
              ? { top: node.strokeWeight, right: node.strokeWeight, bottom: node.strokeWeight, left: node.strokeWeight }
              : { top: 0, right: 0, bottom: 0, left: 0 });
            var merged = { top: base.top, right: base.right, bottom: base.bottom, left: base.left };
            ["top", "right", "bottom", "left"].forEach(function (side) {
              if (typeof value.borderWeights[side] === "number") merged[side] = value.borderWeights[side];
            });
            node.borderWeights = merged;
            // Стороны описывают толщину целиком. Унаследованная от базы общая
            // толщина осталась бы вторым носителем той же величины.
            delete node.strokeWeight;
          }
          break;
        case "strokeWeight":
          node.strokeWeight = value;
          delete node.borderWeights;
          break;
        case "swapDefinitionId":
          if (node.kind === "INSTANCE" && node.definitionId !== value) {
            // Подмена — структурная операция: она меняет дерево, в котором
            // считались адреса уже разрешённых записей этого узла. Их
            // контекст с этого момента чужой, и они снимаются с типизированной
            // причиной, а не переносятся вслепую на новое определение.
            var previousDefinitionId = node.definitionId;
            node.definitionId = value;
            dropForeignContextOverrides(
              node, OVERRIDE_RESOLUTION.OVERRIDE_CONTEXT_INVALIDATED_BY_SWAP,
              previousDefinitionId
            );
          }
          break;
        default:
          node[key] = value;
      }
    }
  }
  /**
   * Индексный путь до цели override.
   *
   * `guidPath` — цепочка guid-ов вниз по дереву исходного символа. Пока
   * очередной guid находится в текущем определении, путь просто уточняется;
   * как только guid из него выпал, предыдущий узел обязан быть вложенным
   * инстансом, и разбор продолжается только в его исходном SYMBOL либо в
   * SYMBOL, доказуемо назначенном этому вхождению: явным `overriddenSymbolID`
   * или свойством компонента типа `OVERRIDDEN_SYMBOL_ID`.
   *
   * Пустой путь — не ошибка: он адресует сам инстанс. Ровно так же приёмник
   * трактует пустой индексный путь, и запись `guidPath = [guid символа]`
   * означает то же самое.
   *
   * Не сошлось — это отказ, а не выбор наугад: имена слоёв в адресации не
   * участвуют, они лишь проверяют уже найденный по индексу узел на приёмнике.
   */
  /**
   * Unique semantic route between component definitions.
   *
   * A Pixso override may survive a library revision with one or more INSTANCE
   * guids removed from `guidPath`.  The final target guid still proves its
   * owning SYMBOL, so the missing boundary can be restored without names or
   * visual similarity iff that SYMBOL is reachable from the active definition
   * through EXACTLY ONE chain of nested INSTANCE slots.
   *
   * Each hop contains the full definition-relative index path to the nested
   * INSTANCE and the definition that this slot opens.  Search is bounded and
   * cycle-safe. Two routes are ambiguity, not a tie to break.
   */
  function uniqueDefinitionLineage(fromDefinitionId, toDefinitionId) {
    if (!fromDefinitionId || !toDefinitionId || fromDefinitionId === toDefinitionId) {
      return { hops: [] };
    }
    var maxDepth = 12;
    var routes = [];

    function nestedEdges(definitionId) {
      var paths = definitionPaths.get(definitionId);
      if (!paths) return [];
      var out = [];
      paths.forEach(function (path, nodeKey) {
        var record = doc.tree.byKey.get(nodeKey);
        if (!record || record.type !== "INSTANCE" || !record.symbolId || !path || !path.length) return;
        var symbol = doc.symbols.symbolsById.get(record.symbolId);
        var nestedDefinitionId = symbol ? ensureDefinition(symbol) : null;
        if (!nestedDefinitionId) return;
        out.push({
          slotSourceId: nodeKey,
          definitionId: definitionId,
          nestedDefinitionId: nestedDefinitionId,
          path: path,
          componentKey: symbol.componentKey || null,
        });
      });
      // Stable order is diagnostic only; it must never choose between routes.
      out.sort(function (a, b) {
        var ak = a.path.map(function (step) { return step.index; }).join(".");
        var bk = b.path.map(function (step) { return step.index; }).join(".");
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      });
      return out;
    }

    function walk(definitionId, hops, seen) {
      if (routes.length > 1 || hops.length >= maxDepth) return;
      var edges = nestedEdges(definitionId);
      for (var i = 0; i < edges.length; i++) {
        var edge = edges[i];
        if (seen[edge.nestedDefinitionId]) continue;
        var nextHops = hops.concat([edge]);
        if (edge.nestedDefinitionId === toDefinitionId) {
          routes.push(nextHops);
          if (routes.length > 1) return;
          continue;
        }
        var nextSeen = Object.assign({}, seen);
        nextSeen[edge.nestedDefinitionId] = true;
        walk(edge.nestedDefinitionId, nextHops, nextSeen);
        if (routes.length > 1) return;
      }
    }

    var initialSeen = Object.create(null);
    initialSeen[fromDefinitionId] = true;
    walk(fromDefinitionId, [], initialSeen);
    if (routes.length === 1) return { hops: routes[0] };
    if (routes.length > 1) return { ambiguous: true };
    return null;
  }

  function lineageDiagnostic(hops) {
    return (hops || []).map(function (hop) {
      return {
        definitionId: hop.definitionId,
        slotSourceId: hop.slotSourceId,
        nestedDefinitionId: hop.nestedDefinitionId,
        componentKey: hop.componentKey || null,
        definitionPath: (hop.path || []).map(function (step) { return step.index; }),
      };
    });
  }

  function deepFailureProvenance(record, effectivePrefix, sourceKey, previous, currentDefinition, swapByPrefix, keys, step) {
    var paths = [];
    try { paths = record && typeof doc.derivedGuidPaths === "function" ? (doc.derivedGuidPaths(record) || []) : []; }
    catch (_) { paths = []; }
    var depth = effectivePrefix.length + 1;
    var candidates = Object.create(null);
    for (var p = 0; p < paths.length; p++) {
      var path = paths[p];
      if (!path || path.length !== depth) continue;
      var same = true;
      for (var j = 0; j < effectivePrefix.length; j++) {
        if (path[j] !== effectivePrefix[j]) { same = false; break; }
      }
      if (!same) continue;
      var candidateKey = path[path.length - 1];
      if (!candidateKey || candidateKey === sourceKey) continue;
      candidates[candidateKey] = true;
    }
    var candidateList = Object.keys(candidates).slice(0, 12).map(function (candidateKey) {
      var owner = owningSymbol(candidateKey);
      return {
        sourceId: candidateKey,
        nodeType: (doc.tree.byKey.get(candidateKey) || {}).type || null,
        ownerDefinitionId: owner ? ensureDefinition(owner) : null,
        ownerComponentKey: owner ? owner.componentKey || null : null,
      };
    });
    var target = doc.tree.byKey.get(sourceKey) || null;
    var targetOwner = target ? owningSymbol(sourceKey) : null;
    var prefix = keys.slice(0, step).join("/");
    return {
      targetExistsInDocument: !!target,
      targetNodeType: target ? target.type : null,
      targetOwnerDefinitionId: targetOwner ? ensureDefinition(targetOwner) : null,
      targetOwnerComponentKey: targetOwner ? targetOwner.componentKey || null : null,
      currentDefinitionId: currentDefinition || null,
      previousSourceId: previous ? previous.key : null,
      previousNodeType: previous ? previous.type : null,
      previousDeclaredSymbolId: previous ? previous.symbolId || null : null,
      previousReadsSwapProperty: !!(previous && readsSwapProperty(previous.key)),
      rawPrefix: keys.slice(0, step),
      effectivePrefix: effectivePrefix.slice(),
      explicitSwapId: swapByPrefix[prefix] || null,
      derivedCandidateCount: Object.keys(candidates).length,
      derivedCandidates: candidateList,
      derivedCandidatesTruncated: Math.max(0, Object.keys(candidates).length - candidateList.length),
    };
  }

  /**
   * Provenance for an unresolved derived suffix.
   *
   * This does NOT pick a child.  It only proves that every live candidate at
   * the first unresolved hop belongs to one definition namespace, then returns
   * all effective endpoints at the same total depth as the raw override path.
   * That is enough for two safe operations:
   *   1) record a derived-definition namespace transition;
   *   2) prove an ambiguous historical override is already a no-op when every
   *      possible live endpoint already has the requested value.
   *
   * The namespace may also be the CURRENT definition: the stale child guid was
   * renamed inside the same symbol and several live children remain at that
   * depth. That is not a transition (`sameDefinition`), but the endpoint set is
   * still complete, so the no-op proof applies to it unchanged.
   */
  function derivedNamespaceEvidence(record, effectivePrefix, keys, step, currentDefinition) {
    if (!record || typeof doc.derivedGuidPaths !== "function") return null;
    var paths;
    try { paths = doc.derivedGuidPaths(record) || []; }
    catch (_) { return null; }
    var nextDepth = effectivePrefix.length + 1;
    var immediate = Object.create(null);
    var endpoints = Object.create(null);
    var endpointPaths = [];
    for (var p = 0; p < paths.length; p++) {
      var path = paths[p];
      if (!path || path.length < nextDepth) continue;
      var same = true;
      for (var j = 0; j < effectivePrefix.length; j++) {
        if (path[j] !== effectivePrefix[j]) { same = false; break; }
      }
      if (!same) continue;
      var nextKey = path[effectivePrefix.length];
      if (nextKey) immediate[nextKey] = true;
      if (path.length === keys.length && path[path.length - 1]) {
        endpoints[path[path.length - 1]] = true;
        endpointPaths.push(path);
      }
    }
    var immediateKeys = Object.keys(immediate);
    if (!immediateKeys.length) return null;
    var definitions = Object.create(null);
    var componentKeys = Object.create(null);
    for (var i = 0; i < immediateKeys.length; i++) {
      var owner = owningSymbol(immediateKeys[i]);
      var definitionId = owner ? ensureDefinition(owner) : null;
      if (!definitionId) return null;
      definitions[definitionId] = true;
      if (owner.componentKey) componentKeys[owner.componentKey] = true;
    }
    var definitionIds = Object.keys(definitions);
    if (definitionIds.length !== 1) return { ambiguous: true };
    var namespaceDefinitionId = definitionIds[0];
    return {
      definitionId: namespaceDefinitionId,
      sameDefinition: namespaceDefinitionId === currentDefinition,
      componentKey: Object.keys(componentKeys).length === 1 ? Object.keys(componentKeys)[0] : null,
      immediateKeys: immediateKeys,
      endpointKeys: Object.keys(endpoints),
      endpointPaths: endpointPaths,
      rawFailureStep: step
    };
  }

  /**
   * Поля раскладки ребёнка. Их значение в Figma — не сырое значение Pixso, а
   * результат перевода: «поле не записано» и `FIXED` дают одно и то же
   * `layoutAlign = INHERIT`. Поэтому для них равенство проверяется после того
   * же перевода, которым правка была бы применена.
   */
  var CHILD_LAYOUT_FIELDS = {
    autoLayoutAbsolutePos: true,
    stackChildPrimarySizing: true,
    stackChildCounterSizing: true,
    stackCounterAlign: true,
  };

  /**
   * Правка раскладки ребёнка ничего не меняет в Figma: каждая операция,
   * которую дал бы `overrideChildLayout`, уже совпадает с состоянием узла по
   * `childLayout`. Узел вне auto layout сюда не попадает: без контекста
   * родителя сравнивается раскладка так, будто он в auto layout, — строже.
   * Абсолютному ребёнку `childLayout` grow/align не назначает, поэтому у него
   * в Figma остаются значения по умолчанию — с ними и сравнивается правка.
   */
  function childLayoutOverrideIsNoOp(source, detail) {
    var ops = normalizer.overrideChildLayout(source);
    if (!ops) return true;
    var state = normalizer.childLayout(detail, true) || {};
    if (state.layoutPositioning === undefined) state.layoutPositioning = "AUTO";
    if (state.layoutGrow === undefined) state.layoutGrow = 0;
    if (state.layoutAlign === undefined) state.layoutAlign = "INHERIT";
    return Object.keys(ops).every(function (key) { return state[key] === ops[key]; });
  }

  /**
   * Собственные правки узла на пути вхождения: записи самого вхождения и
   * каждого INSTANCE на пути, чей guid-путь оканчивается этим узлом. Сравнение
   * с мастером верно, только если никто из них не задал полю ДРУГОГО значения:
   * правка того же значения оставляет живое значение равным проверяемому.
   */
  function endpointHasConflictingOverride(occurrenceRecord, path, source, fields) {
    var holders = [occurrenceRecord];
    for (var j = 0; j < path.length - 1; j++) {
      var hop = doc.tree.byKey.get(path[j]);
      if (hop && hop.type === "INSTANCE") holders.push(hop);
    }
    var endpointKey = path[path.length - 1];
    for (var h = 0; h < holders.length; h++) {
      var detail;
      try { detail = doc.detail(holders[h]); } catch (_) { return true; }
      var records = detail && detail.symbolData && detail.symbolData.symbolOverrides || [];
      for (var r = 0; r < records.length; r++) {
        var keys = overrideKeys(records[r]);
        if (!keys.length || keys[keys.length - 1] !== endpointKey) continue;
        for (var f = 0; f < fields.length; f++) {
          var own = records[r][fields[f]];
          if (own === undefined || rawEqual(own, source[fields[f]])) continue;
          if (!CHILD_LAYOUT_FIELDS[fields[f]]) return true;
          var ownOps = normalizer.overrideChildLayout(pickFields(records[r], [fields[f]]));
          var sourceOps = normalizer.overrideChildLayout(pickFields(source, [fields[f]]));
          if (JSON.stringify(ownOps || null) !== JSON.stringify(sourceOps || null)) return true;
        }
      }
    }
    return false;
  }

  function pickFields(source, fields) {
    var out = {};
    fields.forEach(function (field) { out[field] = source[field]; });
    return out;
  }

  function rawEqual(a, b) {
    if (a === b) return true;
    if (a === undefined || b === undefined || a === null || b === null) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch (_) { return false; }
  }

  function ambiguousDerivedOverrideIsVerifiedNoOp(resolved, source, occurrenceRecord) {
    var evidence = resolved && resolved.derivedNamespaceEvidence;
    if (!evidence || !evidence.definitionId || !evidence.endpointKeys || !evidence.endpointKeys.length || !source) return false;
    var fields = Object.keys(source).filter(function (field) {
      return !OVERRIDE_IGNORED[field] && !emptyValue(source[field]);
    });
    if (!fields.length) return false;
    // Exact raw equality, except child-layout fields, which are compared after
    // the same translation the override would get.  Any other field that needs
    // normalization (paints, styles, text ranges, etc.) and differs
    // byte-for-byte refuses the proof: the override stays unsafe rather than
    // guessing a target.
    for (var e = 0; e < evidence.endpointKeys.length; e++) {
      var record = doc.tree.byKey.get(evidence.endpointKeys[e]);
      if (!record) return false;
      var detail;
      try { detail = doc.detail(record); } catch (_) { return false; }
      var translated = false;
      for (var f = 0; f < fields.length; f++) {
        var field = fields[f];
        if (rawEqual(source[field], detail[field])) continue;
        if (!CHILD_LAYOUT_FIELDS[field]) return false;
        translated = true;
      }
      if (translated && !childLayoutOverrideIsNoOp(source, detail)) return false;
    }
    // The master value is the live value only when nothing on the way to the
    // endpoint overrides the same field.
    if (occurrenceRecord) {
      for (var p = 0; p < evidence.endpointPaths.length; p++) {
        if (endpointHasConflictingOverride(occurrenceRecord, evidence.endpointPaths[p], source, fields)) return false;
      }
    }
    return true;
  }

  /**
   * Активный SYMBOL узла по подмене, объявленной СОДЕРЖИМЫМ определения.
   *
   * Ищется по всем определениям, через которые уже прошёл путь, от внешнего к
   * внутреннему: подмена, объявленная ближе к вхождению, перекрывает
   * объявленную глубже — тот же порядок вложенности, по которому правка
   * самого вхождения перекрывает содержимое мастера.
   *
   * Совпадение здесь точное и только по guid-пути. Ни имён, ни индексов, ни
   * «похожих» узлов: адрес либо объявлен в определении дословно, либо нет.
   */
  function definitionDeclaredSwap(keys, step) {
    if (!keys || !step || !declaredInternalSwaps.size) return null;
    // Объявивших вхождений на пути может быть несколько. Побеждает самое
    // ВНЕШНЕЕ — то же правило вложенности, по которому правка вхождения
    // перекрывает содержимое мастера: оно ближе к вхождению, чем остальные.
    for (var j = 0; j < step; j++) {
      var hit = declaredInternalSwaps.get(keys.slice(j, step).join("/"));
      if (hit) return hit;
    }
    return null;
  }

  function resolveOverridePath(definitionId, keys, swapByPrefix, inferredSwaps, occurrenceRecord) {
    var currentDefinition = definitionId;
    var committed = [];
    var candidate = [];
    var lastKey = definitionId;
    var nestedSwap = false;
    var activeBefore = definitionId;
    var activeAfter = definitionId;
    var lineage = [];
    // Фактический guid-prefix occurrence. Он совпадает с source guidPath, пока
    // Pixso не оставил stale identity после component swap. После доказанного
    // remap здесь живут уже effective guid-ы из derivedSymbolData.
    var effectivePrefix = [];

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === lastKey) continue;
      var paths = definitionPaths.get(currentDefinition);
      var segment = paths ? paths.get(key) : null;
      var derivedAmbiguousAtStep = false;

      // D51 A1. A published local mirror may be only a root stub while a
      // richer mirror of the exact same publishFile+publishID is already
      // materialized in this job. Translate the missing hop by Pixso's stable
      // overrideKey, accepting only a unique node-type-compatible address.
      if (!segment) {
        var publishedStubTranslation = translatePublishedStubByOverrideKey(currentDefinition, key);
        if (publishedStubTranslation) {
          var translatedHit = publishedStubTranslation.hit;
          candidate = publishedStubTranslation.path || translatedHit.path;
          lastKey = translatedHit.nodeKey;
          effectivePrefix.push(translatedHit.nodeKey);
          var overrideKeyStepToken = (occurrenceRecord && occurrenceRecord.key || "") + "|" +
            currentDefinition + "|" + key + "|" +
            (translatedHit && translatedHit.nodeKey || "");
          if (!overrideKeyResolvedStepsSeen.has(overrideKeyStepToken)) {
            overrideKeyResolvedStepsSeen.add(overrideKeyStepToken);
            stats.overrideStepsResolvedByOverrideKey += 1;
          }
          continue;
        }
      }
      if (segment) {
        candidate = segment;
        lastKey = key;
        effectivePrefix.push(key);
        continue;
      }

      // Pixso can keep a stale child GUID even when no component boundary is
      // crossed at this step. The effective occurrence tree is carried by
      // derivedSymbolData. Resolve that provenance BEFORE requiring the
      // previous source node to be an INSTANCE: otherwise an ordinary parent
      // followed by a renamed/revisioned child is misclassified as missing
      // nested context. The remap is accepted only when the derived child is
      // owned by the SAME active definition, so this cannot jump to another
      // component or sibling namespace.
      if (occurrenceRecord && typeof doc.derivedGuidPaths === "function") {
        var localDerivedMatch = derivedTargetAt(occurrenceRecord, effectivePrefix, key);
        if (localDerivedMatch && localDerivedMatch.ambiguous) derivedAmbiguousAtStep = true;
        if (localDerivedMatch && localDerivedMatch.key) {
          var localDerivedOwner = owningSymbol(localDerivedMatch.key);
          var localDerivedDefinition = localDerivedOwner ? ensureDefinition(localDerivedOwner) : null;
          if (localDerivedDefinition === currentDefinition) {
            var localDerivedPaths = definitionPaths.get(currentDefinition);
            var localDerivedSegment = localDerivedPaths ? localDerivedPaths.get(localDerivedMatch.key) : null;
            if (localDerivedSegment) {
              stats.derivedPathResolved += 1;
              stats.derivedPathRemapped += 1;
              stats.derivedSameSymbolRemaps += 1;
              candidate = localDerivedSegment;
              lastKey = localDerivedMatch.key;
              effectivePrefix.push(localDerivedMatch.key);
              continue;
            }
          }
        }
      }

      var previous = doc.tree.byKey.get(lastKey);

      // The source guidPath can omit semantic INSTANCE boundaries after a
      // library/master revision.  The target guid itself still identifies its
      // owning SYMBOL. Before declaring the previous source node "not an
      // instance", reconstruct a missing boundary only when there is exactly
      // one component-definition route from the active namespace to that
      // owner. This is stronger evidence than sibling/index similarity: every
      // hop is an actual INSTANCE → SYMBOL edge from the Pixso document.
      var targetOwnerForLineage = owningSymbol(key);
      var targetDefinitionForLineage = targetOwnerForLineage
        ? ensureDefinition(targetOwnerForLineage) : null;
      if ((!previous || previous.type !== "INSTANCE") && targetDefinitionForLineage &&
          targetDefinitionForLineage !== currentDefinition) {
        var reconstructedLineage = uniqueDefinitionLineage(currentDefinition, targetDefinitionForLineage);
        if (reconstructedLineage && reconstructedLineage.hops && reconstructedLineage.hops.length) {
          var reconstructedCommitted = [];
          for (var lh = 0; lh < reconstructedLineage.hops.length; lh++) {
            var lineageHop = reconstructedLineage.hops[lh];
            reconstructedCommitted = reconstructedCommitted.concat(lineageHop.path);
            lineage.push(lineageHop);
          }
          committed = committed.concat(reconstructedCommitted);
          currentDefinition = targetDefinitionForLineage;
          activeAfter = currentDefinition;
          candidate = [];
          lastKey = currentDefinition;
          var reconstructedPaths = definitionPaths.get(currentDefinition);
          var reconstructedSegment = reconstructedPaths ? reconstructedPaths.get(key) : null;
          if (reconstructedSegment) {
            stats.lineageReconstructions += 1;
            stats.lineageReconstructedHops += reconstructedLineage.hops.length;
            candidate = reconstructedSegment;
            lastKey = key;
            effectivePrefix.push(key);
            continue;
          }
        } else if (reconstructedLineage && reconstructedLineage.ambiguous) {
          stats.lineageReconstructionAmbiguous += 1;
        } else {
          stats.lineageReconstructionMissing += 1;
        }
      }

      // Библиотечные компоненты Pixso сохраняют override-записи и после
      // обновления master. Если первый же GUID больше не существует нигде в
      // текущем .pix, у записи нет живой цели и в самом источнике. Раньше мы
      // принимали это за потерянный nested context и размножали один stale
      // override на сотни unsafe occurrences родительского definition.
      if (building.size > 0 && i === 0 && (!previous || previous.type !== "INSTANCE") && !doc.tree.byKey.get(key)) {
        return {
          ok: false,
          reason: OVERRIDE_RESOLUTION.STALE_TARGET_GUID_NOT_IN_DOCUMENT,
          deepest: i,
          expectedTargetGuid: key,
          activeSymbolBefore: currentDefinition,
          activeSymbolAfter: currentDefinition,
          lineage: lineageDiagnostic(lineage),
        };
      }
      if (!previous || previous.type !== "INSTANCE") {
        return {
          ok: false,
          reason: OVERRIDE_RESOLUTION.NESTED_INSTANCE_CONTEXT_MISSING,
          deepest: i,
          expectedTargetGuid: key,
          activeSymbolBefore: currentDefinition,
          lineage: lineageDiagnostic(lineage),
          sourceProvenance: deepFailureProvenance(occurrenceRecord, effectivePrefix, key, previous, currentDefinition, swapByPrefix, keys, i),
        };
      }

      // Namespace нового поддерева выбирается только из доказуемой связи:
      // назначенный этому вхождению SYMBOL либо его собственный main SYMBOL.
      // Владельца произвольного target GUID брать нельзя — так можно было
      // незаметно перепрыгнуть в любой компонент документа.
      var prefix = keys.slice(0, i).join("/");
      var swappedId = swapByPrefix[prefix] || null;
      // Порядок источников активного символа задан вложенностью, а не
      // удобством: правка самого вхождения перекрывает содержимое мастера,
      // содержимое мастера перекрывает объявленный symbolId узла.
      var declaredSwapId = swappedId ? null : definitionDeclaredSwap(keys, i);
      if (declaredSwapId) stats.definitionInternalSwapsApplied = (stats.definitionInternalSwapsApplied || 0) + 1;
      var effectiveId = swappedId || declaredSwapId || previous.symbolId;
      var owner = effectiveId ? doc.symbols.symbolsById.get(effectiveId) : null;
      var nestedDefinition = owner ? ensureDefinition(owner) : null;
      if (!nestedDefinition) {
        return {
          ok: false,
          reason: OVERRIDE_RESOLUTION.NESTED_SYMBOL_UNRESOLVED,
          deepest: i,
          expectedTargetGuid: key,
          activeSymbolBefore: currentDefinition,
          activeSymbolAfter: effectiveId,
          lineage: lineageDiagnostic(lineage),
        };
      }
      committed = committed.concat(candidate);
      nestedSwap = nestedSwap || !!swappedId;
      activeBefore = currentDefinition;
      activeAfter = nestedDefinition;
      lineage.push({
        definitionId: currentDefinition,
        slotSourceId: previous.key,
        nestedDefinitionId: nestedDefinition,
        componentKey: owner && owner.componentKey || null,
        path: candidate.slice(),
      });
      currentDefinition = nestedDefinition;
      candidate = [];
      lastKey = nestedDefinition;
      var nestedPaths = definitionPaths.get(currentDefinition);
      segment = nestedPaths ? nestedPaths.get(key) : null;

      // `symbolOverrides` может хранить persistent guid старой версии
      // вложенного компонента, тогда как occurrence уже показывает другой
      // SYMBOL. Pixso оставляет фактический адрес в `derivedSymbolData`. Мы не
      // читаем его snapshot: `PixDocument.derivedGuidPaths()` структурно
      // извлекает только guidPath. Принимается исключительно ОДИН ребёнок на
      // том же уже доказанном effective-prefix и той же глубине.
      if (!segment && occurrenceRecord && typeof doc.derivedGuidPaths === "function") {
        var derivedMatch = derivedTargetAt(occurrenceRecord, effectivePrefix, key);
        if (derivedMatch && derivedMatch.ambiguous) derivedAmbiguousAtStep = true;
        if (derivedMatch && derivedMatch.key) {
          var derivedOwner = owningSymbol(derivedMatch.key);
          var derivedDefinition = derivedOwner ? ensureDefinition(derivedOwner) : null;
          var targetDefinition = derivedDefinition || currentDefinition;
          var targetPaths = definitionPaths.get(targetDefinition);
          var derivedSegment = targetPaths ? targetPaths.get(derivedMatch.key) : null;

          // Two different provenance classes are safe:
          //
          // 1. Same active nested symbol: Pixso persisted an old child GUID
          //    after a library/component update.  No INSTANCE_SWAP property is
          //    needed for this case — the derived path merely translates the
          //    stale child identity inside the already-proven symbol.
          //
          // 2. Different symbol: this is an implicit component swap and is
          //    accepted only when the nested instance explicitly reads its
          //    symbol from an INSTANCE_SWAP property (the previous D23 rule).
          //
          // Anything else stays unsafe; derived data is never allowed to jump
          // between arbitrary component definitions.
          var sameActiveDefinition = !!derivedDefinition && derivedDefinition === currentDefinition;
          var mayInferSwap = !swappedId && readsSwapProperty(previous.key) &&
            !!derivedDefinition && derivedDefinition !== currentDefinition;
          var mayRemapCurrent = !swappedId && sameActiveDefinition;
          var mayRemapAfterExplicitSwap = !!swappedId && sameActiveDefinition;
          if (derivedSegment && (mayRemapCurrent || mayRemapAfterExplicitSwap || mayInferSwap)) {
            stats.derivedPathResolved += 1;
            if (mayInferSwap) {
              swapByPrefix[prefix] = derivedOwner.key;
              if (inferredSwaps && !inferredSwaps[prefix]) {
                inferredSwaps[prefix] = {
                  keys: keys.slice(0, i),
                  symbolId: derivedOwner.key,
                  evidence: "DERIVED_GUID_PATH",
                };
              }
              stats.derivedImplicitSwaps += 1;
              nestedSwap = true;
              activeAfter = derivedDefinition;
              currentDefinition = derivedDefinition;
            } else {
              stats.derivedPathRemapped += 1;
              if (mayRemapCurrent) stats.derivedSameSymbolRemaps += 1;
            }
            candidate = derivedSegment;
            lastKey = derivedMatch.key;
            effectivePrefix.push(derivedMatch.key);
            continue;
          }
        }
      }

      // A guidPath may cross one proven INSTANCE boundary and then omit
      // another one introduced by a newer library revision. At this point the
      // first boundary is already committed and `currentDefinition` is the
      // live nested namespace. Reconstruct the remaining semantic hops by the
      // same exact graph proof as above before interpreting the target owner as
      // an INSTANCE_SWAP.
      if (!segment) {
        var deepTargetOwner = owningSymbol(key);
        var deepTargetDefinition = deepTargetOwner ? ensureDefinition(deepTargetOwner) : null;
        if (deepTargetDefinition && deepTargetDefinition !== currentDefinition) {
          var deepLineage = uniqueDefinitionLineage(currentDefinition, deepTargetDefinition);
          if (deepLineage && deepLineage.hops && deepLineage.hops.length) {
            for (var dlh = 0; dlh < deepLineage.hops.length; dlh++) {
              committed = committed.concat(deepLineage.hops[dlh].path);
              lineage.push(deepLineage.hops[dlh]);
            }
            currentDefinition = deepTargetDefinition;
            activeAfter = currentDefinition;
            var deepPaths = definitionPaths.get(currentDefinition);
            var deepSegment = deepPaths ? deepPaths.get(key) : null;
            if (deepSegment) {
              stats.lineageReconstructions += 1;
              stats.lineageReconstructedHops += deepLineage.hops.length;
              candidate = deepSegment;
              lastKey = key;
              effectivePrefix.push(key);
              continue;
            }
          } else if (deepLineage && deepLineage.ambiguous) {
            stats.lineageReconstructionAmbiguous += 1;
          } else {
            stats.lineageReconstructionMissing += 1;
          }
        }
      }

      // Цели нет в объявленном символе. Прежде чем отказаться, проверяется
      // ДОКАЗУЕМАЯ подмена: символ, которому цель принадлежит на самом деле.
      // Это не поиск «похожего» узла — target guid лежит ровно в одном
      // символе документа, и принимается он только при одном из двух
      // доказательств (см. inferActiveSymbol). Найденная подмена
      // запоминается: приёмник обязан выполнить её раньше, чем пойдёт вглубь.
      if (!segment) {
        var inferred = inferActiveSymbol(previous, key, swappedId);
        if (inferred && inferred.evidence === "SAME_COMPONENT_FAMILY") {
          // Копия того же библиотечного компонента. Показывается всё-таки
          // объявленная копия, а путь записан по соседней: подменять компонент
          // не нужно, нужно перевести адрес. Перевод идёт по индексам —
          // структура копий одна и та же по построению, — и принимается только
          // если тип узла на найденном месте совпал. Имена в переводе не
          // участвуют.
          var translated = translateAcrossCopies(inferred.symbol, key, currentDefinition);
          if (translated) {
            var translatedKey = currentDefinition + "|" + inferred.symbol.key + "|" + key;
            if (!translatedPathsSeen.has(translatedKey)) {
              translatedPathsSeen.add(translatedKey);
              stats.pathsTranslatedAcrossCopies += 1;
            }
            candidate = translated;
            lastKey = translated[translated.length - 1]
              ? translated[translated.length - 1].sourceId : key;
            continue;
          }
        } else if (inferred) {
          // Символ вхождения читается из свойства компонента, а значение
          // свойства в документе не записано. Единственная запись о нём — сам
          // путь override. Это настоящая подмена, и приёмник обязан её
          // выполнить.
          var inferredDefinition = ensureDefinition(inferred.symbol);
          var inferredPaths = inferredDefinition ? definitionPaths.get(inferredDefinition) : null;
          var inferredSegment = inferredPaths ? inferredPaths.get(key) : null;
          if (inferredSegment) {
            swapByPrefix[prefix] = inferred.symbol.key;
            if (inferredSwaps && !inferredSwaps[prefix]) {
              inferredSwaps[prefix] = {
                keys: keys.slice(0, i),
                symbolId: inferred.symbol.key,
                evidence: inferred.evidence,
              };
            }
            nestedSwap = true;
            activeAfter = inferredDefinition;
            currentDefinition = inferredDefinition;
            candidate = inferredSegment;
            lastKey = key;
            continue;
          }
        }
      }

      if (!segment && !nestedSwap && !derivedAmbiguousAtStep && !doc.tree.byKey.get(key)) {
        // The target guid no longer exists anywhere in the current document.
        // This is the deep equivalent of the stale-root case above: after
        // derivedSymbolData, explicit/inferred swaps and same-family remaps
        // have all failed, there is no live structural target to which this
        // historical override could apply. Treat it as stale source metadata,
        // not as a visual loss. This rule is intentionally identity-only:
        // no names, sibling positions or component-specific ids participate.
        return {
          ok: false,
          reason: OVERRIDE_RESOLUTION.STALE_TARGET_GUID_NOT_IN_DOCUMENT,
          deepest: i,
          expectedTargetGuid: key,
          nestedComponentSwapEncountered: nestedSwap,
          activeSymbolBefore: activeBefore,
          activeSymbolAfter: currentDefinition,
          lineage: lineageDiagnostic(lineage),
        };
      }

      if (!segment) {
        var derivedNamespace = derivedNamespaceEvidence(occurrenceRecord, effectivePrefix, keys, i, currentDefinition);
        if (derivedNamespace && !derivedNamespace.ambiguous && !derivedNamespace.sameDefinition) {
          stats.derivedDefinitionNamespaceTransitions += 1;
        }
        var originalOwner = previous.symbolId ? doc.symbols.symbolsById.get(previous.symbolId) : null;
        var originalPaths = originalOwner && definitionPaths.get(ensureDefinition(originalOwner));
        var reason;
        if (swappedId && originalPaths && originalPaths.get(key)) {
          reason = OVERRIDE_RESOLUTION.PATH_CHANGED_AFTER_COMPONENT_SWAP;
        } else if (!swappedId && readsSwapProperty(previous.key)) {
          reason = OVERRIDE_RESOLUTION.OCCURRENCE_SWAP_NOT_IN_SOURCE;
        } else if (sameComponentFamily(currentDefinition, key)) {
          reason = OVERRIDE_RESOLUTION.TARGET_IN_OTHER_COMPONENT_COPY;
        } else {
          reason = OVERRIDE_RESOLUTION.TARGET_GUID_NOT_IN_DEFINITION;
        }
        return {
          ok: false,
          reason: reason,
          deepest: i,
          expectedTargetGuid: key,
          nestedComponentSwapEncountered: nestedSwap,
          activeSymbolBefore: activeBefore,
          activeSymbolAfter: activeAfter,
          lineage: lineageDiagnostic(lineage),
          derivedNamespaceEvidence: derivedNamespace && !derivedNamespace.ambiguous ? derivedNamespace : null,
          sourceProvenance: deepFailureProvenance(occurrenceRecord, effectivePrefix, key, previous, currentDefinition, swapByPrefix, keys, i),
        };
      }
      candidate = segment;
      lastKey = key;
      effectivePrefix.push(key);
    }
    return {
      ok: true,
      path: committed.concat(candidate),
      deepest: keys.length,
      expectedTargetGuid: keys.length ? keys[keys.length - 1] : definitionId,
      nestedComponentSwapEncountered: nestedSwap,
      activeSymbolBefore: activeBefore,
      activeSymbolAfter: activeAfter,
      lineage: lineageDiagnostic(lineage),
    };
  }

  /**
   * Единственный effective target на следующем уровне occurrence path.
   *
   * Никакой похожести, имени или порядка sibling-ов: уже разрешённый prefix
   * должен совпасть дословно, глубина — тоже. Если derived snapshot содержит
   * два разных child guid под тем же prefix, результат намеренно ambiguous.
   */
  function derivedTargetAt(record, effectivePrefix, sourceKey) {
    stats.derivedPathLookups += 1;
    var paths;
    try { paths = doc.derivedGuidPaths(record) || []; }
    catch (_) { stats.derivedPathMissing += 1; return null; }
    var depth = effectivePrefix.length + 1;
    var candidates = Object.create(null);
    for (var p = 0; p < paths.length; p++) {
      var path = paths[p];
      if (!path || path.length !== depth) continue;
      var same = true;
      for (var i = 0; i < effectivePrefix.length; i++) {
        if (path[i] !== effectivePrefix[i]) { same = false; break; }
      }
      if (!same) continue;
      var key = path[path.length - 1];
      if (!key || key === sourceKey) continue;
      candidates[key] = true;
    }
    var keys = Object.keys(candidates);
    if (keys.length === 1) return { key: keys[0] };
    if (keys.length > 1) {
      stats.derivedPathAmbiguous += 1;
      return { ambiguous: true };
    }
    stats.derivedPathMissing += 1;
    return null;
  }

  /**
   * Символ, который вхождение показывает на самом деле, когда объявленный
   * символ цели не содержит.
   *
   * Догадкой это не является: `key` — конкретный guid документа, и владеющий
   * им SYMBOL ровно один. Принимается такой владелец только при одном из двух
   * доказательств:
   *
   *   SAME_COMPONENT_FAMILY — владелец и объявленный символ несут один
   *     `componentKey`, то есть это две копии ОДНОГО библиотечного компонента
   *     в документе. Дерево у копий своё, и адрес между ними не переносится,
   *     но подменить копию на ту, в которой цель действительно лежит, —
   *     операция без выбора: другой кандидат отсутствует.
   *
   *   COMPONENT_PROPERTY_SWAP — узел объявляет, что читает свой SYMBOL из
   *     свойства компонента (`componentPropRef` с `OVERRIDDEN_SYMBOL_ID`), а
   *     значение свойства в документе не записано. Тогда единственная запись
   *     о фактическом символе вхождения — это сам путь override, который в
   *     него и указывает.
   *
   * Ни имя слоя, ни похожесть деревьев в решении не участвуют.
   */
  function inferActiveSymbol(previous, targetKey, declaredSwapId) {
    if (!previous || previous.type !== "INSTANCE") return null;
    var owner = owningSymbol(targetKey);
    if (!owner) return null;
    var declaredId = declaredSwapId || previous.symbolId;
    if (declaredId && owner.key === declaredId) return null;
    var declared = declaredId ? doc.symbols.symbolsById.get(declaredId) : null;
    if (declared && declared.componentKey && declared.componentKey === owner.componentKey) {
      return { symbol: owner, evidence: "SAME_COMPONENT_FAMILY" };
    }
    if (!declaredSwapId && readsSwapProperty(previous.key)) {
      return { symbol: owner, evidence: "COMPONENT_PROPERTY_SWAP" };
    }
    return null;
  }

  /**
   * Адрес узла `targetKey`, записанный по одной копии библиотечного
   * компонента, — в терминах другой его копии.
   *
   * Обе копии несут один `componentKey`: это один и тот же компонент,
   * вставленный в документ дважды, поэтому их деревья совпадают по структуре,
   * а guid-ы — нет. Соответствие берётся по последовательности индексов и
   * принимается только при совпадении типа узла. Не сошлось — перевода нет.
   */
  var publishedOverrideKeyPathCache = new Map();

  function symbolPublicationIdentity(symbol) {
    if (!symbol || !symbol.publishFile || !symbol.publishID) return null;
    return String(symbol.publishFile) + "@" + doc.guidKey(symbol.publishID);
  }

  /**
   * D51: exact node address inside one already materialized SYMBOL, keyed by
   * Pixso overrideKey. Missing keys are ignored; duplicate keys make only that
   * key ambiguous. This is an address index, not an equivalence heuristic.
   */
  function definitionOverrideKeyPaths(definitionId) {
    var paths = definitionPaths.get(definitionId);
    if (!paths) return null;
    // D52. Определение может достраиваться после первого обращения. Кеш,
    // снятый с недостроенной карты путей, молча отвечал бы «адреса нет» и
    // дальше. Поэтому он действителен только для того же размера карты.
    var cachedIndex = publishedOverrideKeyPathCache.get(definitionId);
    if (cachedIndex && cachedIndex.size === paths.size) return cachedIndex;
    var byKey = Object.create(null);
    var duplicates = Object.create(null);
    paths.forEach(function (path, nodeKey) {
      if (!path || !path.length) return;
      var node = doc.tree.byKey.get(nodeKey);
      if (!node || !node.overrideKey) return;
      var key = doc.guidKey(node.overrideKey);
      if (!key) return;
      if (byKey[key]) { duplicates[key] = true; return; }
      byKey[key] = { path: path, nodeKey: nodeKey, type: node.type || null };
    });
    Object.keys(duplicates).forEach(function (key) { delete byKey[key]; });
    var result = { byKey: byKey, duplicates: duplicates, size: paths.size };
    publishedOverrideKeyPathCache.set(definitionId, result);
    return result;
  }

  /**
   * Resolve one hop authored against a richer local mirror while the active
   * published mirror is a root-only stub. Candidate family identity is exact
   * publishFile+publishID; the hop itself is exact overrideKey+node type.
   *
   * No names, geometry, componentKey-only matching or sibling similarity. If
   * more than one already materialized rich mirror supplies a DIFFERENT
   * address for the same stable key, fail closed. Equivalent addresses across
   * identical mirrors collapse to one proof.
   */
  /**
   * D52. Символы одной публикации, у которых есть содержимое.
   *
   * Индекс строится один раз на сборку: перебор всех символов документа на
   * каждом промахнувшемся шаге стоил бы столько же, сколько сам разбор.
   */
  var publishedRichSymbolsByIdentity = null;
  function publishedRichSymbolIndex() {
    if (publishedRichSymbolsByIdentity) return publishedRichSymbolsByIdentity;
    publishedRichSymbolsByIdentity = new Map();
    doc.symbols.symbolsById.forEach(function (symbol) {
      if (!symbol || !symbol.children || !symbol.children.length) return;
      var identity = symbolPublicationIdentity(symbol);
      if (!identity) return;
      var bucket = publishedRichSymbolsByIdentity.get(identity);
      if (!bucket) { bucket = []; publishedRichSymbolsByIdentity.set(identity, bucket); }
      bucket.push(symbol);
    });
    return publishedRichSymbolsByIdentity;
  }

  /**
   * D52. Единственный заполненный близнец той же публикации — источник
   * содержимого для root-only заглушки. Идентичность определения при этом не
   * меняется: близнец даёт только детей. Ноль или больше одного кандидата —
   * отказ, заглушка остаётся пустой.
   */
  function publishedContentTwin(symbolRecord) {
    var publication = symbolPublicationIdentity(symbolRecord);
    if (!publication) return null;
    var bucket = publishedRichSymbolIndex().get(publication);
    if (!bucket || !bucket.length) return null;
    var chosen = null;
    for (var i = 0; i < bucket.length; i++) {
      if (bucket[i].key === symbolRecord.key) continue;
      if (chosen) return null;
      chosen = bucket[i];
    }
    return chosen;
  }

  /**
   * Единственный заполненный близнец той же публикации, в котором этот
   * `overrideKey` адресуется однозначно. Два близнеца, дающие РАЗНЫЕ адреса
   * для одного ключа, — это неоднозначность, и она закрывается отказом.
   * Одинаковый адрес у нескольких идентичных копий доказательство не портит.
   */
  function publishedStubTwin(activeDefinition, publication, overrideKey) {
    if (!publication || !overrideKey) return null;
    var bucket = publishedRichSymbolIndex().get(publication);
    if (!bucket || !bucket.length) return null;
    var chosen = null;
    for (var i = 0; i < bucket.length; i++) {
      var symbol = bucket[i];
      if (symbol.key === activeDefinition) continue;
      var twinDefinition = ensureDefinition(symbol);
      if (!twinDefinition) continue;
      var twinPaths = definitionPaths.get(twinDefinition);
      if (!twinPaths || twinPaths.size <= 1) continue;
      var index = definitionOverrideKeyPaths(twinDefinition);
      var hit = index && index.byKey[overrideKey];
      if (!hit) continue;
      if (!chosen) { chosen = { definitionId: twinDefinition, hit: hit }; continue; }
      var sameAddress = chosen.hit.path.length === hit.path.length &&
        chosen.hit.path.every(function (step, at) { return step.index === hit.path[at].index; }) &&
        chosen.hit.type === hit.type;
      if (!sameAddress) return null;
    }
    return chosen;
  }

  function translatePublishedStubByOverrideKey(activeDefinition, targetKey) {
    var activeSymbol = doc.symbols.symbolsById.get(activeDefinition);
    // During ensureDefinition(activeDefinition) the path map is not committed
    // yet, so source topology is the authoritative emptiness check.
    if (!activeSymbol || (activeSymbol.children && activeSymbol.children.length)) return null;
    var publication = symbolPublicationIdentity(activeSymbol);
    if (!publication) return null;

    // Pixso записывает шаг пути в заглушку публикации двумя способами, и оба
    // встречаются на настоящих файлах:
    //
    //   1. guid узла ДРУГОГО локального зеркала той же публикации — тогда его
    //      стабильный адрес читается прямо с найденного узла;
    //   2. сам `overrideKey` узла опубликованного мастера — тогда в документе
    //      такого guid-а нет вовсе, и шаг УЖЕ является стабильным адресом.
    //
    // D52. Прежняя редакция знала только первый способ: она искала шаг в
    // карте guid-ов и выходила, если не нашла. На измеренном файле у заглушек
    // встречается ровно второй способ (шаги `42:565253`, `87:186688`,
    // `4343:114851` — это overrideKey узлов богатого зеркала), поэтому ветка
    // не срабатывала ни разу, а её счётчик показывал ноль при живой причине.
    //
    // Оба способа сводятся к одному стабильному ключу. Владелец-близнец
    // выбирается по точной паре publishFile+publishID, адрес внутри него — по
    // этому ключу и совпадению типа узла. Ни имён, ни геометрии, ни позиции
    // среди соседей.
    var target = doc.tree.byKey.get(targetKey) || null;
    var overrideKey = target && target.overrideKey ? doc.guidKey(target.overrideKey) : targetKey;
    if (!overrideKey) return null;
    if (target) {
      var targetOwner = owningSymbol(targetKey);
      // Найденный guid обязан принадлежать другому зеркалу ТОЙ ЖЕ публикации:
      // иначе это адрес чужого компонента, и переводить его нельзя.
      if (!targetOwner || targetOwner.key === activeDefinition ||
          symbolPublicationIdentity(targetOwner) !== publication) return null;
    }
    var twin = publishedStubTwin(activeDefinition, publication, overrideKey);
    if (!twin) return null;
    var twinDefinition = twin.definitionId;
    var hit = twin.hit;
    if (target && target.type && hit.type && target.type !== hit.type) return null;
    var translatedPath = (hit.path || []).map(function (step) {
      var clone = {};
      Object.keys(step || {}).forEach(function (key) { clone[key] = step[key]; });
      // The occurrence still declares the root-only local mirror. Preserve that
      // namespace in the emitted path so context validation remains correct;
      // sourceOverrideKey carries the exact cross-mirror address proof to the
      // receiver, where a canonical rich master can translate it again.
      clone.definitionId = activeDefinition;
      return clone;
    });
    return { definitionId: twinDefinition, hit: hit, path: translatedPath };
  }

  function translateAcrossCopies(foreignSymbol, targetKey, activeDefinition) {
    var foreignDefinition = ensureDefinition(foreignSymbol);
    if (!foreignDefinition) return null;
    // Единственное допустимое доказательство — полное совпадение структуры.
    // Копии, приехавшие из разных версий библиотеки, различаются содержимым, и
    // адрес между ними перенести нельзя: индекс совпал бы, а слой оказался бы
    // другим. Ровно такой перевод и был бы догадкой.
    var foreignShape = definitionShapes.get(foreignDefinition);
    var activeShape = definitionShapes.get(activeDefinition);
    if (!foreignShape || foreignShape !== activeShape) return null;
    var foreignPaths = definitionPaths.get(foreignDefinition);
    var foreignSegment = foreignPaths ? foreignPaths.get(targetKey) : null;
    if (!foreignSegment || !foreignSegment.length) return null;
    var activeIndexPaths = definitionIndexPaths.get(activeDefinition);
    return activeIndexPaths ? activeIndexPaths.get(indexKeyOf(foreignSegment)) || null : null;
  }

  /**
   * Читает ли узел свой SYMBOL из свойства компонента. Если да, а значение
   * свойства нигде не назначено, фактический символ вхождения в доступных
   * Direct PIX полях просто не записан.
   */
  function readsSwapProperty(nodeKey) {
    var refs = propertyRefsByNode.get(nodeKey);
    if (!refs) return false;
    for (var i = 0; i < refs.length; i++) {
      if (refs[i].field === "swap") return true;
    }
    return false;
  }

  /** SYMBOL, которому принадлежит узел. */
  function owningSymbol(nodeKey) {
    var record = doc.tree.byKey.get(nodeKey);
    while (record && record.type !== "SYMBOL") record = record.parent;
    return record || null;
  }

  /**
   * Живёт ли цель в другой копии того же библиотечного компонента.
   * componentKey — признак семейства: две копии одного компонента в документе
   * несут его одинаковым, оставаясь при этом разными деревьями.
   */
  function sameComponentFamily(definitionKey, targetKey) {
    var definitionSymbol = doc.tree.byKey.get(definitionKey);
    var targetSymbol = owningSymbol(targetKey);
    if (!definitionSymbol || !targetSymbol) return false;
    if (definitionSymbol.key === targetSymbol.key) return false;
    return !!definitionSymbol.componentKey && definitionSymbol.componentKey === targetSymbol.componentKey;
  }

  /** Есть ли в записи хоть одно поле, которое Direct PIX умеет переносить. */
  /**
   * Счётчик заглушек. Пустой repeated-список в записи override — не операция,
   * но и не тишина: он должен быть виден в отчёте отдельной строкой, иначе
   * возврат старой семантики нечем будет заметить.
   */
  function countEmptyRepeatedOverride(source, field) {
    if (!Array.isArray(source[field]) || source[field].length) return;
    if (!OVERRIDE_FIELDS[field]) return;
    stats.emptyRepeatedOverridesIgnored += 1;
    if (field === "fillPaints" || field === "strokePaints") stats.paintDefaultArrayIgnored += 1;
  }

  function hasSupportedField(source) {
    var fields = Object.keys(source);
    for (var i = 0; i < fields.length; i++) {
      if (OVERRIDE_IGNORED[fields[i]]) continue;
      if (!OVERRIDE_FIELDS[fields[i]]) continue;
      // Пустой repeated-массив в записи override — заглушка сериализатора
      // Pixso, а не операция очистки: разбор доказательств в
      // `PixNormalizer.overrideRepeated`. Исключений для paint/effect здесь
      // больше нет — раньше именно они и превращали дельту в стирание.
      if (source[fields[i]] !== null && emptyValue(source[fields[i]])) continue;
      return true;
    }
    return false;
  }

  function overrideKeys(source) {
    var guids = source.guidPath && source.guidPath.guids;
    if (!guids || !guids.length) return [];
    return guids.map(doc.guidKey);
  }

  /**
   * Определение, внутрь которого смотрит вхождение, адресованное `keys`.
   *
   * Свойства компонента объявлены не там, где лежит вхождение, а в символе,
   * который это вхождение показывает. Пустой путь означает сам разбираемый
   * инстанс, поэтому его определение и возвращается.
   */
  function instanceDefinitionAt(definitionId, keys, swapByPrefix, inferredSwaps, occurrenceRecord) {
    if (!keys.length) return definitionId;
    var resolved = resolveOverridePath(definitionId, keys, swapByPrefix, inferredSwaps, occurrenceRecord);
    if (!resolved.ok) return null;
    var lastKey = keys[keys.length - 1];
    var record = doc.tree.byKey.get(lastKey);
    if (!record) return null;
    var symbolId = swapByPrefix[keys.join("/")] ||
      definitionDeclaredSwap(keys, keys.length) ||
      (record.type === "SYMBOL" ? record.key : record.symbolId);
    var symbolRecord = symbolId ? doc.symbols.symbolsById.get(symbolId) : null;
    return symbolRecord ? ensureDefinition(symbolRecord) : null;
  }

  /**
   * Узлы активного определения, читающие назначенное свойство.
   *
   * Поиск идёт по ПУБЛИЧНОЙ идентичности: и назначение, и объявление узла
   * называют свои локальные псевдонимы, и совпадают они только в корне
   * цепочки. Сырой индекс опрашивается тем же вызовом, но не как запасной
   * путь поиска, а как измерение: он отвечает на вопрос «нашлось бы это
   * совпадение и без публичной идентичности».
   *
   * Возвращает `{ list, rawWouldMatch }`. `list` пуст, если ни один узел
   * активного определения этого свойства не читает.
   */
  function propertyBindings(activeDefinition, resolved) {
    var bindings = activeDefinition ? definitionPropertyBindings.get(activeDefinition) : null;
    if (!bindings || !resolved || !resolved.key) return { list: null, rawWouldMatch: false };
    var rawList = resolved.rawKey ? bindings.byRaw.get(resolved.rawKey) : null;
    var list = bindings.byPublic.get(resolved.key) || null;
    // Публичный корень не найден — ключом осталась сырая идентичность, и
    // публичный индекс уже содержит её под тем же ключом. Отдельной ветки
    // «искать по сырому» здесь нет: она была бы вторым правилом поиска.
    return { list: list, rawWouldMatch: !!(rawList && rawList.length) };
  }

  /**
   * Причина, по которой назначение не нашло привязки.
   *
   * Причинные классы держатся врозь: «свойство внешней библиотеки», «цепочка
   * оборвана» и «свойство разрешено, но его никто не читает» требуют разных
   * действий, и общий счётчик скрыл бы, какое из них случилось.
   */
  function propertyUnresolvedReason(resolved) {
    var S = ComponentProperties.STATUS;
    if (!resolved || !resolved.status) return OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_NOT_BOUND;
    if (resolved.status === S.MISSING_DEF) return OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_EXTERNAL_DEF;
    if (resolved.status === S.DANGLING_PARENT) return OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_PUBLIC_DEF_DANGLING;
    if (resolved.status === S.CYCLE) return OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_RESOLUTION_CYCLE;
    if (resolved.status === S.DEPTH_EXCEEDED) return OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_RESOLUTION_DEPTH_EXCEEDED;
    return OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_NOT_BOUND;
  }

  /** Тип свойства для разбивки в отчёте. Решений по нему не принимается. */
  function propertyTypeOf(resolved, bindingList) {
    if (bindingList && bindingList.length) {
      var inferred = null;
      for (var bi = 0; bi < bindingList.length; bi++) {
        var field = bindingList[bi] && bindingList[bi].field;
        var next = field === "swap" ? "INSTANCE_SWAP" :
          (field === "characters" ? "TEXT" : (field === "visible" ? "BOOL" : null));
        if (!next) continue;
        if (inferred && inferred !== next) { inferred = null; break; }
        inferred = next;
      }
      if (inferred) return inferred;
    }
    var declared = componentProperties && resolved && resolved.rawKey
      ? (resolved.contextDefinitionId && typeof componentProperties.typeOfScoped === "function"
          ? componentProperties.typeOfScoped(resolved.rawKey, resolved.contextDefinitionId)
          : componentProperties.typeOf(resolved.rawKey)) : null;
    return declared ? String(declared) : "UNKNOWN";
  }

  function countPropertyType(bucket, type) {
    stats[bucket][type] = (stats[bucket][type] || 0) + 1;
  }

  function assignmentSymbolKey(assignment) {
    return PixGuid.meaningfulGuid(assignment.value && assignment.value.guidValue);
  }

  /**
   * Дельта одного вхождения.
   *
   * Разбор двухфазный, и это обязательно: сначала фиксируются ВСЕ подмены
   * вложенных компонентов, потом считаются адреса. Подмена приходит либо
   * явным `overriddenSymbolID`, либо назначением свойства компонента — и во
   * втором случае адрес подменяемого узла известен только после того, как
   * разобран путь до самого вхождения. Поэтому подмены обрабатываются от
   * коротких путей к длинным: подмена на глубине видна лишь после подмены
   * выше по дереву.
   */
  /**
   * Уже собранное определение символа — без побочных эффектов.
   *
   * `ensureDefinition` здесь недопустим: он подтягивает в job новые
   * определения и считает переиспользования. Коробки источника — геометрия
   * уже доказанного дерева, и расширять ради них спрос на компоненты нельзя.
   */
  function builtDefinitionId(symbolRecord) {
    if (!symbolRecord) return null;
    var key = symbolRecord.key;
    return definitions.has(key) || knownDefinitions.has(key) ? key : null;
  }

  /**
   * Адрес записи `derivedSymbolData` в терминах индексного пути приёмника.
   *
   * Guid-путь снимка устроен как guid-путь override: промежуточные guid —
   * вхождения, последний — цель. Но в отличие от `resolveOverridePath` этот
   * разбор строгий и ничего не меняет вокруг себя: активный символ вложенного
   * вхождения берётся только из уже доказанных подмен этого вхождения
   * (явных, выведенных, объявленных содержимым мастера) либо из собственного
   * symbolId; цель обязана дословно лежать в карте путей этого определения.
   * Новых подмен, новых определений, ремапов по снимку и переводов между
   * копиями здесь нет — любой такой случай просто не даёт адреса.
   */
  function resolveSourceBoxPath(definitionId, keys, swapByPrefix, inferredSwaps) {
    var currentDefinition = definitionId;
    var committed = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (i > 0) {
        var previous = doc.tree.byKey.get(keys[i - 1]);
        if (!previous || previous.type !== "INSTANCE") return null;
        var prefix = keys.slice(0, i).join("/");
        var inferred = inferredSwaps[prefix];
        var effectiveId = swapByPrefix[prefix] || (inferred && inferred.symbolId) ||
          definitionDeclaredSwap(keys, i) || previous.symbolId;
        var nestedDefinition = builtDefinitionId(effectiveId ? doc.symbols.symbolsById.get(effectiveId) : null);
        if (!nestedDefinition) return null;
        currentDefinition = nestedDefinition;
      }
      var paths = definitionPaths.get(currentDefinition);
      var segment = paths ? paths.get(key) : null;
      if (!segment || !segment.length) return null;
      committed = committed.concat(segment);
    }
    return committed;
  }

  /** Узлы, чей габарит в обоих редакторах выводится из детей, а не хранится. */
  var SOURCE_BOX_DERIVED_TYPES = { GROUP: true, BOOLEAN_OPERATION: true };

  /**
   * Итоговые коробки вложенных узлов вхождения из `derivedSymbolData`.
   *
   * Запись override хранит итоговое СОСТОЯНИЕ, а приёмник вынужден
   * воспроизводить его ЦЕПОЧКОЙ присваиваний. Промежуточный шаг такой цепочки
   * может быть циклом раскладки, которого в источнике не было ни в один
   * момент (родитель уже HUG, ребёнок ещё STRETCH): Figma схлопывает ось, а
   * фиксированный размер ребёнка после этого восстановить не из чего. Pixso
   * же записывает, какой размер у каждого узла вхождения получился. Эти
   * числа уезжают как данные; решать, какой оси они принадлежат, будет
   * приёмник по живому узлу — число не является владением.
   */
  /**
   * Семантика осей цели в итоговом состоянии вхождения: собственные режимы
   * узла определения и его слот в родителе, поверх — правки этого же адреса.
   *
   * Живая Figma переписывает эти поля сама, пока правки применяются по одной:
   * ребёнок со STRETCH внутри корня, который уже стал HUG, теряет STRETCH;
   * контейнер может потерять FIXED. К концу применения живое дерево тогда не
   * совпадает с источником ни по семантике, ни по размеру, и решать «чья это
   * ось» по нему нельзя. Приёмнику нужно исходное намерение.
   */
  function sourceBoxSizing(target, entry) {
    var detail = null;
    try { detail = doc.detail(target); } catch (_eSizingDetail) { return null; }
    if (!detail) return null;
    var out = {};
    // Собственные режимы переносятся только у обычного контейнера: его запись
    // — полное состояние, а молчание измерено как FIXED. Запись вложенного
    // ВХОЖДЕНИЯ — снимок, в котором правка и эхо мастера неотличимы; владение
    // его осями уже решает путь вхождения, и перебивать его здесь нельзя.
    var ownMode = target.type === "INSTANCE" ? null : (SOURCE_LAYOUT_MODES[detail.stackMode] || null);
    if (ownMode) {
      out.layoutMode = ownMode;
      out.primaryAxisSizingMode = AXIS_SIZING[detail.stackPrimarySizing] || "FIXED";
      out.counterAxisSizingMode = AXIS_SIZING[detail.stackCounterSizing] || "FIXED";
    }
    var parent = target.parentKey ? doc.tree.byKey.get(target.parentKey) : null;
    var parentDetail = null;
    try { parentDetail = parent ? doc.detail(parent) : null; } catch (_eParentDetail) { parentDetail = null; }
    if (parentDetail && SOURCE_LAYOUT_MODES[parentDetail.stackMode]) {
      var slot = normalizer.childLayout(detail, true);
      if (slot) {
        ["layoutGrow", "layoutAlign", "layoutPositioning"].forEach(function (field) {
          if (slot[field] !== undefined) out[field] = slot[field];
        });
      }
    }
    var ops = entry && entry.ops;
    if (ops && ops.layout) {
      ["layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode"].forEach(function (field) {
        if (ops.layout[field] !== undefined) out[field] = ops.layout[field];
      });
    }
    if (ops && ops.childLayout) {
      ["layoutGrow", "layoutAlign", "layoutPositioning"].forEach(function (field) {
        if (ops.childLayout[field] !== undefined) out[field] = ops.childLayout[field];
      });
    }
    // Producer нужно владение конкретными width/height: сами по себе
    // primary/counter без направления родителя его не доказывают. Для
    // вложенного INSTANCE ось без формального FILL остаётся unknown:
    // его sizing-запись — снимок, а не доказанная правка.
    var widthOwnership = target.type === "INSTANCE" ? null : "FIXED";
    var heightOwnership = target.type === "INSTANCE" ? null : "FIXED";
    if (target.type === "TEXT") {
      var textAuto = ops && ops.textAutoResize !== undefined
        ? ops.textAutoResize : (detail.textAutoResize || "NONE");
      if (textAuto === "WIDTH_AND_HEIGHT") { widthOwnership = "HUG"; heightOwnership = "HUG"; }
      else if (textAuto === "HEIGHT") { widthOwnership = "FIXED"; heightOwnership = "HUG"; }
    } else if (out.layoutMode === "HORIZONTAL" || out.layoutMode === "VERTICAL") {
      var ownHorizontal = out.layoutMode === "HORIZONTAL";
      var primaryOwnership = out.primaryAxisSizingMode === "AUTO" ? "HUG" : "FIXED";
      var counterOwnership = out.counterAxisSizingMode === "AUTO" ? "HUG" : "FIXED";
      widthOwnership = ownHorizontal ? primaryOwnership : counterOwnership;
      heightOwnership = ownHorizontal ? counterOwnership : primaryOwnership;
    }
    var parentMode = parentDetail && SOURCE_LAYOUT_MODES[parentDetail.stackMode] || null;
    if (parentMode && out.layoutPositioning !== "ABSOLUTE") {
      var parentHorizontal = parentMode === "HORIZONTAL";
      if (out.layoutGrow > 0) {
        if (parentHorizontal) widthOwnership = "FILL"; else heightOwnership = "FILL";
      }
      if (out.layoutAlign === "STRETCH") {
        if (parentHorizontal) heightOwnership = "FILL"; else widthOwnership = "FILL";
      }
    }
    if (widthOwnership) out.width = widthOwnership;
    if (heightOwnership) out.height = heightOwnership;
    return Object.keys(out).length ? out : null;
  }

  function collectSourceBoxes(record, definitionId, swapByPrefix, inferredSwaps, sink, merged, lossSink) {
    var geometry = null;
    try {
      geometry = typeof doc.derivedGeometry === "function" ? doc.derivedGeometry(record) : null;
    } catch (_eDerivedGeometry) {
      stats.sourceBoxesUnreadable += 1;
      return;
    }
    if (!geometry || !geometry.size) return;
    var seen = Object.create(null);
    geometry.forEach(function (value, guidPath) {
      var size = value && value.size;
      if (!size || !(size.x >= 0) || !(size.y >= 0) || !isFinite(size.x) || !isFinite(size.y)) return;
      stats.sourceBoxesSeen += 1;
      var keys = guidPath.split("/");
      var target = doc.tree.byKey.get(keys[keys.length - 1]);
      if (!target || SOURCE_BOX_DERIVED_TYPES[target.type]) {
        stats.sourceBoxesSkippedType += 1;
        return;
      }
      var path = resolveSourceBoxPath(definitionId, keys, swapByPrefix, inferredSwaps);
      if (!path) {
        stats.sourceBoxesUnresolved += 1;
        return;
      }
      var indexKey = path.map(function (step) { return step.index; }).join(".");
      if (seen[indexKey]) {
        stats.sourceBoxesAmbiguous += 1;
        seen[indexKey].ambiguous = true;
        return;
      }
      var box = { path: path, width: size.x, height: size.y };
      var sizing = sourceBoxSizing(target, merged ? merged.get(indexKey) : null);
      if (sizing) box.sizing = sizing;
      var targetDetail = baseDetail(target);
      var boxDecision = expressibilityPolicy.sourceBox(
        box, target.type, targetDetail && targetDetail.size || null, {
          textAutoResize: targetDetail && targetDetail.textAutoResize || null,
          insideNestedInstance: path.some(function (step) {
            return step && step.definitionId && step.definitionId !== definitionId;
          }),
        }
      );
      box.expressibility = boxDecision;
      expressibility.record("source-box:" + record.key + ":" + indexKey,
        boxDecision, record.key);
      // sourceBoxes are an audit of resolved occurrence geometry. They are
      // not an edit and therefore cannot make a previously safe native
      // occurrence unsafe. Actual unrepresentable edits (for example
      // textBoxWidth) already mark their own loss while overrides are built.
      seen[indexKey] = box;
      sink.push(box);
    });
    // Две записи на один адрес — противоречие источника: не выбираем.
    for (var i = sink.length - 1; i >= 0; i--) {
      if (sink[i].ambiguous) sink.splice(i, 1);
    }
    // Предки раньше потомков: resize предка перекладывает детей по
    // constraints, и их собственные коробки обязаны лечь поверх.
    sink.sort(function (a, b) { return a.path.length - b.path.length; });
    stats.sourceBoxesEmitted += sink.length;
  }

  function buildOverrides(detail, definitionId, record, lossSink, nativePropertySink, swapSink, sourceBoxSink) {
    var records = (detail.symbolData && detail.symbolData.symbolOverrides) || [];
    var merged = new Map();
    var swapByPrefix = Object.create(null);
    // Подмены, восстановленные по владельцу целевого guid. Их обязан
    // выполнить приёмник, иначе адрес, посчитанный по подменённому дереву,
    // попадёт в дерево объявленного символа.
    var inferredSwaps = Object.create(null);
    var derived = [];
    var nativeAssignments = new Map();

    function nativeAssignmentValue(assignment, type) {
      var value = assignment && assignment.value || {};
      if (type === "BOOL") return { type: "BOOLEAN", value: !!value.boolValue };
      if (type === "TEXT") {
        var text = value.textValue;
        if (!text || typeof text.characters !== "string") return null;
        return { type: "TEXT", value: text.characters };
      }
      if (type === "INSTANCE_SWAP") {
        var symbolKey = assignmentSymbolKey(assignment);
        var symbolRecord = symbolKey ? doc.symbols.symbolsById.get(symbolKey) : null;
        var targetDefinition = symbolRecord ? ensureDefinition(symbolRecord) : null;
        return targetDefinition ? { type: "INSTANCE_SWAP", swapDefinitionId: targetDefinition } : null;
      }
      return null;
    }

    function rememberNativeAssignment(source, resolved, type, assignment) {
      if (!nativePropertySink || !resolved || !resolved.key) return;
      var mapped = nativeAssignmentValue(assignment, type);
      if (!mapped) return;
      var targetPath = [];
      if (source.keys && source.keys.length) {
        var targetResolution = resolveOverridePath(definitionId, source.keys, swapByPrefix, inferredSwaps, record);
        if (!targetResolution.ok) return;
        targetPath = targetResolution.path;
      }
      var entry = {
        path: targetPath,
        propertyId: resolved.key,
        type: mapped.type,
      };
      if (mapped.type === "INSTANCE_SWAP") entry.swapDefinitionId = mapped.swapDefinitionId;
      else entry.value = mapped.value;
      var key = targetPath.map(function (step) { return step.index; }).join(".") + "|" + resolved.key;
      // Последнее назначение того же свойства на той же цели побеждает — это
      // тот же порядок, в котором ниже схлопываются обычные ops.
      nativeAssignments.set(key, entry);
    }

    // --- Фаза 1. Источники подмены ---------------------------------------
    var swapSources = [];
    if (detail.componentPropAssignment && detail.componentPropAssignment.length) {
      swapSources.push({
        keys: [], assignments: detail.componentPropAssignment,
        rawSource: { componentPropAssignment: detail.componentPropAssignment },
      });
    }
    for (var s = 0; s < records.length; s++) {
      var swapSource = records[s];
      var swapKeys = overrideKeys(swapSource);
      var explicit = PixGuid.swapReference(swapSource);
      if (explicit && swapKeys.length) {
        swapByPrefix[swapKeys.join("/")] = explicit;
      }
      if (swapSource.componentPropAssignment && swapSource.componentPropAssignment.length) {
        swapSources.push({
          keys: swapKeys, assignments: swapSource.componentPropAssignment, rawSource: swapSource,
        });
      }
    }
    swapSources.sort(function (a, b) { return a.keys.length - b.keys.length; });

    swapSources.forEach(function (source) {
      var activeDefinition = instanceDefinitionAt(definitionId, source.keys, swapByPrefix, inferredSwaps, record);
      source.activeDefinition = activeDefinition;
      if (!activeDefinition) return;
      source.assignments.forEach(function (assignment) {
        var resolved = publicPropertyKey(assignment.defID, activeDefinition);
        if (!resolved.key) return;
        var found = propertyBindings(activeDefinition, resolved);
        if (!found.list) return;
        var symbolKey = assignmentSymbolKey(assignment);
        if (!symbolKey) return;
        found.list.forEach(function (binding) {
          if (binding.field !== "swap") return;
          swapByPrefix[source.keys.concat([binding.nodeKey]).join("/")] = symbolKey;
        });
      });
    });

    // --- Фаза 1b. Разведка подмен ----------------------------------------
    //
    // `resolveOverridePath` доказывает подмену вложенного компонента ПО ХОДУ
    // разбора. Адрес, посчитанный до этого доказательства, лежит в дереве
    // объявленного символа и после подмены на приёмнике указывает в пустоту.
    // Поэтому сначала выполняется проход, который ничего не переносит и ничего
    // не считает, а только доводит карту подмен до неподвижной точки.
    function discoverSwaps(keyLists) {
      for (var pass = 0; pass < 4; pass++) {
        var before = Object.keys(inferredSwaps).length;
        for (var k = 0; k < keyLists.length; k++) {
          resolveOverridePath(definitionId, keyLists[k], swapByPrefix, inferredSwaps, record);
        }
        if (Object.keys(inferredSwaps).length === before) return;
      }
    }

    var recordKeyLists = [];
    for (var rk = 0; rk < records.length; rk++) recordKeyLists.push(overrideKeys(records[rk]));
    discoverSwaps(recordKeyLists);

    // --- Фаза 2. Значения свойств превращаются в обычные операции ---------
    swapSources.forEach(function (source) {
      // Активное определение пересчитывается: подмена, зафиксированная в
      // первой фазе на более коротком префиксе, могла сменить namespace.
      var activeDefinition = instanceDefinitionAt(definitionId, source.keys, swapByPrefix, inferredSwaps, record);
      if (!activeDefinition) {
        source.assignments.forEach(function () {
          stats.componentPropertyAssignmentsTotal += 1;
          note(IR_UNSUPPORTED.COMPONENT_PROPERTY_UNBOUND, record.key);
          stats.overridesDropped += 1;
        });
        return;
      }
      source.assignments.forEach(function (assignment) {
        stats.componentPropertyAssignmentsTotal += 1;
        var resolved = publicPropertyKey(assignment.defID, activeDefinition);
        var found = resolved.key
          ? propertyBindings(activeDefinition, resolved)
          : { list: null, rawWouldMatch: false };
        // Величины считаются ДО ветвления: «нашлось бы и по сырому defID» —
        // это факт о записи, а не о том, чем кончился разбор.
        if (found.rawWouldMatch) stats.componentPropertyResolvedRawIdentity += 1;
        var type = propertyTypeOf(resolved, found.list);
        if (resolved.status === ComponentProperties.STATUS.RESOLVED && resolved.depth > 0) {
          stats.componentPropertyPublicChainFollowed += 1;
        }
        if (!found.list) {
          // Свойство назначено, но ни один узел определения его не читает —
          // либо идентичность вообще не разрешилась. Причины разные, и код
          // причины обязан их различать.
          var reason = propertyUnresolvedReason(resolved);
          if (reason === OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_NOT_BOUND) {
            stats.componentPropertyNotBound += 1;
          } else if (reason === OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_EXTERNAL_DEF) {
            stats.componentPropertyExternalDef += 1;
          } else if (reason === OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_PUBLIC_DEF_DANGLING) {
            stats.componentPropertyDanglingParent += 1;
          } else if (reason === OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_RESOLUTION_CYCLE) {
            stats.componentPropertyResolutionCycle += 1;
          } else if (reason === OVERRIDE_RESOLUTION.COMPONENT_PROPERTY_RESOLUTION_DEPTH_EXCEEDED) {
            stats.componentPropertyResolutionDepthExceeded += 1;
          }
          countPropertyType("componentPropertyUnresolvedByType", type);
          note(IR_UNSUPPORTED.COMPONENT_PROPERTY_UNBOUND, resolved.key || record.key);
          noteOverrideResolution(reason, {
            instanceSourceId: record.key,
            sourceSymbolId: record.symbolId,
            canonicalDefinitionId: definitionId,
            propertyId: resolved.key,
            rawPropertyId: resolved.rawKey,
            publicIdentityStatus: resolved.status,
            guidPath: source.keys,
            activeSymbolBefore: activeDefinition,
            activeSymbolAfter: activeDefinition,
          });
          stats.overridesDropped += 1;
          return;
        }
        stats.componentPropertyResolvedPublicIdentity += 1;
        countPropertyType("componentPropertyResolvedByType", type);
        if (sourceSemanticAudit.componentPropertySamples.length < sourceSemanticAudit.componentSampleLimit) {
          var sourceValue = assignment && assignment.value || {};
          sourceSemanticAudit.componentPropertySamples.push({
            instanceSourceId: record.key, canonicalDefinitionId: definitionId, activeDefinition: activeDefinition,
            pathKeys: source.keys ? source.keys.slice() : [], propertyId: resolved.key,
            rawPropertyId: resolved.rawKey, propertyType: nativePropertyType(type),
            value: type === "BOOL" ? !!sourceValue.boolValue :
              (type === "TEXT" && sourceValue.textValue ? sourceValue.textValue.characters : null),
            swapSourceId: type === "INSTANCE_SWAP" ? assignmentSymbolKey(assignment) : null,
            targetNodeIds: found.list.map(function (b) { return b.nodeKey; }),
            targetFields: found.list.map(function (b) { return b.field; })
          });
        }
        rememberNativeAssignment(source, resolved, type, assignment);
        if (!found.rawWouldMatch) {
          // Ровно та величина, ради которой заведена публичная идентичность:
          // сырой defID не совпал бы, а публичный корень — совпал.
          stats.componentPropertyRecoveredByPublicIdentity += 1;
          countPropertyType("componentPropertyRecoveredByType", type);
          if (recoveredPropertySamples.length < 20) {
            recoveredPropertySamples.push({
              instanceSourceId: record.key,
              canonicalDefinitionId: definitionId,
              activeDefinition: activeDefinition,
              assignmentDefId: resolved.rawKey,
              publicDefId: resolved.key,
              chainDepth: resolved.depth,
              bindingDefIds: found.list.map(function (b) { return b.rawPropertyId; }),
              targetNodeIds: found.list.map(function (b) { return b.nodeKey; }),
              fields: found.list.map(function (b) { return b.field; }),
              propertyType: type,
            });
          }
        }
        found.list.forEach(function (binding) {
          derived.push({
            keys: source.keys.concat([binding.nodeKey]), binding: binding,
            assignment: assignment, rawSource: source.rawSource,
            // Low-level операция остаётся visual fallback, но теперь знает,
            // каким публичным native property она семантически владеется.
            // Receiver подавляет её ТОЛЬКО если setProperties этого же
            // property на owner-instance реально успешно выполнился.
            nativeOwner: {
              pathKeys: source.keys.slice(),
              propertyId: resolved.key,
              propertyType: nativePropertyType(type),
            },
          });
        });
      });
    });

    // Свойства компонента добавили собственные адреса — карта подмен снова
    // доводится до неподвижной точки, теперь уже вместе с ними.
    discoverSwaps(recordKeyLists.concat(derived.map(function (item) { return item.keys; })));

    // --- Фаза 3. Обычные записи override ---------------------------------
    function entryFor(resolved, keys, source) {
      var pathKey = resolved.path.map(function (step) { return step.index; }).join(".");
      var entry = merged.get(pathKey);
      if (entry) return entry;
      var targetRecord = doc.tree.byKey.get(resolved.expectedTargetGuid);
      var symbolRecord = doc.symbols.symbolsById.get(definitionId);
      entry = {
        path: resolved.path,
        ops: {},
        // Presence едет отдельно от значения: "", [], false и null
        // не равны отсутствующему полю. Приёмник использует эту карту
        // как доказательство того, что operation пришла из raw Kiwi.
        present: {},
        diagnostic: (options.debugOverrides || traceTextOverrides) ? {
          instanceSourceId: record.key,
          sourceSymbolId: record.symbolId,
          canonicalDefinitionId: definitionId,
          componentKey: symbolRecord ? symbolRecord.componentKey || null : null,
          guidPath: keys,
          expectedTargetGuid: resolved.expectedTargetGuid,
          sourceNodeType: targetRecord ? targetRecord.type : null,
          sourceNodeName: targetRecord ? targetRecord.name : null,
          nestedComponentSwapEncountered: !!resolved.nestedComponentSwapEncountered,
          overriddenSymbolId: source && source.overriddenSymbolID
            ? doc.guidKey(source.overriddenSymbolID) : null,
          activeSymbolBefore: resolved.activeSymbolBefore,
          activeSymbolAfter: resolved.activeSymbolAfter,
          lineage: resolved.lineage || [],
        } : undefined,
      };
      merged.set(pathKey, entry);
      return entry;
    }

    function traceValue(value, depth) {
      if (typeof value === "bigint") return String(value) + "n";
      if (value === null || value === undefined || typeof value !== "object") return value;
      if (depth >= 5) return "[depth-limit]";
      if (Array.isArray(value)) {
        var list = value.slice(0, 40).map(function (item) { return traceValue(item, depth + 1); });
        if (value.length > 40) list.push("[" + (value.length - 40) + " more]");
        return list;
      }
      if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(value)) {
        return { bufferBytes: value.length, hexPrefix: value.subarray(0, 32).toString("hex") };
      }
      var out = {};
      Object.keys(value).slice(0, 40).forEach(function (key) {
        out[key] = traceValue(value[key], depth + 1);
      });
      if (Object.keys(value).length > 40) out.$truncatedFields = Object.keys(value).length - 40;
      return out;
    }

    function rememberRawTextOverride(entry, source, targetRecord, keys) {
      if (!traceTextOverrides || !source || !targetRecord || targetRecord.type !== "TEXT") return;
      if (!entry.diagnostic.textTrace) {
        if (textOverrideTraceEntries >= textOverrideTraceLimit) return;
        textOverrideTraceEntries += 1;
        entry.diagnostic.textTrace = {
          targetGuid: targetRecord.key,
          targetRelativePath: keys.slice(),
          rawOverrides: [],
        };
      }
      var fields = Object.keys(source).filter(function (field) {
        return field !== "guidPath" && field !== "guid" && field !== "overrideKey" &&
          field !== "phase" && field !== "overrideLevel";
      });
      var values = {};
      fields.forEach(function (field) { values[field] = traceValue(source[field], 0); });
      entry.diagnostic.textTrace.rawOverrides.push({
        rawOverrideType: source.type === undefined ? null : source.type,
        presentFields: fields,
        values: values,
      });
    }

    function reportUnresolved(resolved, keys, source) {
      if (ambiguousDerivedOverrideIsVerifiedNoOp(resolved, source, record)) {
        stats.derivedDefinitionNamespaceAmbiguousNoOps += 1;
        return;
      }
      note(IR_UNSUPPORTED.OVERRIDE_TARGET, keys.join("/"));
      var fields = source
        ? Object.keys(source).filter(function (field) { return !OVERRIDE_IGNORED[field]; })
        : [];
      if (lossSink && VISUAL_LOSS_REASONS[resolved.reason]) {
        lossSink[resolved.reason] = (lossSink[resolved.reason] || 0) + 1;
      }
      noteOverrideResolution(resolved.reason, {
        instanceSourceId: record.key,
        sourceSymbolId: record.symbolId,
        canonicalDefinitionId: definitionId,
        componentKey: (doc.symbols.symbolsById.get(definitionId) || {}).componentKey || null,
        overrideFields: fields,
        overrideTypes: fields.reduce(function (out, field) {
          var value = source[field];
          out[field] = Array.isArray(value) ? "array" : typeof value;
          return out;
        }, {}),
        guidPath: keys,
        expectedTargetGuid: resolved.expectedTargetGuid || (keys.length ? keys[keys.length - 1] : null),
        deepestResolvedSegment: resolved.deepest || 0,
        nestedComponentSwapEncountered: !!resolved.nestedComponentSwapEncountered,
        overriddenSymbolId: source && source.overriddenSymbolID
          ? doc.guidKey(source.overriddenSymbolID) : null,
        activeSymbolBefore: resolved.activeSymbolBefore || definitionId,
        activeSymbolAfter: resolved.activeSymbolAfter || definitionId,
        lineage: resolved.lineage || [],
        failureHop: resolved.deepest || 0,
        sourceProvenance: resolved.sourceProvenance || null,
        derivedNamespaceEvidence: resolved.derivedNamespaceEvidence || null,
      });
      if (VISUAL_LOSS_REASONS[resolved.reason] && deepOverrideProvenanceSamples.length < 24) {
        deepOverrideProvenanceSamples.push({
          reason: resolved.reason,
          instanceSourceId: record.key,
          canonicalDefinitionId: definitionId,
          sourceSymbolId: record.symbolId || null,
          guidPath: keys.slice(),
          overrideFields: fields.slice(0, 16),
          expectedTargetGuid: resolved.expectedTargetGuid || null,
          failureHop: resolved.deepest || 0,
          lineage: resolved.lineage || [],
          sourceProvenance: resolved.sourceProvenance || null,
          derivedNamespaceEvidence: resolved.derivedNamespaceEvidence || null,
        });
      }
      stats.overridesDropped += 1;
    }

    // D52. Путь записи уже разрешён вызывающим кодом и передаётся сюда.
    // Прежняя редакция вызывала `resolveOverridePath` второй раз для той же
    // записи — самая дорогая операция сборки IR, повторённая на каждой записи
    // с `componentPropAssignment`. Результат был побайтово тот же.
    /**
     * D52. Одна запись может нести НЕСКОЛЬКО присваиваний, и это норма.
     *
     * Прежнее правило «владелец есть только если присваивание ровно одно»
     * молчаливо отключало подавление на каждой такой записи. На измеренном
     * файле это 197 записей из 676, и 129 из них несут `overriddenSymbolID` —
     * то есть материализованный след `INSTANCE_SWAP`, который потом
     * проигрывался как самостоятельный swap и переключал вариант. Ровно так
     * таб свёрнутого рейла SideMenu уезжал с `collapsed=true` на
     * `collapsed=false`.
     *
     * Неоднозначности здесь нет там, где её нет: материализованное поле
     * однозначно соответствует ТИПУ свойства (`overriddenSymbolID` —
     * INSTANCE_SWAP, `visible` — BOOLEAN, `characters` — TEXT). Поэтому
     * владелец ищется по типу, и отказ остаётся только там, где два
     * присваивания одного и того же типа претендуют на одно поле.
     *
     * Поля без собственного типа свойства (paint, opacity, sizing) берут
     * прежнее консервативное правило: единственный владелец на запись.
     */
    function coLocatedAssignmentOwners(source, ownerResolution) {
      if (!source || !source.componentPropAssignment || !source.componentPropAssignment.length) return null;
      if (!ownerResolution || !ownerResolution.ok) return null;
      var pathKey = ownerResolution.path.map(function (step) { return step.index; }).join(".");
      var owners = [];
      var byId = Object.create(null);
      for (var ai = 0; ai < source.componentPropAssignment.length; ai++) {
        var assignment = source.componentPropAssignment[ai];
        var resolvedProperty = publicPropertyKey(assignment.defID, ownerResolution.activeSymbolAfter || definitionId);
        if (!resolvedProperty.key || byId[resolvedProperty.key]) continue;
        var nativeEntry = nativeAssignments.get(pathKey + "|" + resolvedProperty.key);
        if (!nativeEntry) continue;
        var owner = {
          path: nativeEntry.path || ownerResolution.path,
          propertyId: resolvedProperty.key,
          propertyType: nativeEntry.type || null,
        };
        byId[resolvedProperty.key] = owner;
        owners.push(owner);
      }
      if (!owners.length) return null;
      var byType = Object.create(null);
      var ambiguousType = Object.create(null);
      for (var oi = 0; oi < owners.length; oi++) {
        var type = owners[oi].propertyType;
        if (!type) continue;
        if (byType[type]) { ambiguousType[type] = true; continue; }
        byType[type] = owners[oi];
      }
      Object.keys(ambiguousType).forEach(function (type) { delete byType[type]; });
      return { byType: byType, single: owners.length === 1 ? owners[0] : null };
    }

    /**
     * Тип свойства, который ДОКАЗАННО владеет этим материализованным полем.
     * `null` означает, что поле само по себе владельца не называет и может
     * быть отнесено только к единственному присваиванию записи.
     */
    var MATERIALIZED_OP_OWNER_TYPE = {
      swapDefinitionId: "INSTANCE_SWAP",
      visible: "BOOLEAN",
      characters: "TEXT",
    };

    function coLocatedOwnerForOp(owners, opKey) {
      if (!owners) return null;
      var type = MATERIALIZED_OP_OWNER_TYPE[opKey] || null;
      if (type && owners.byType[type]) return owners.byType[type];
      return owners.single;
    }

    function materializedAssignmentOps(source) {
      var out = Object.create(null);
      if (!source) return out;
      if (source.visible !== undefined) out.visible = true;
      // D55. `overriddenSymbolID` НЕ считается подавляемым следом присваивания.
      //
      // Формально он им является: Pixso пишет и присваивание, и его результат.
      // Но результат записан в пространстве ДРУГОГО локального зеркала
      // публикации, и правки потомков адресованы уже внутри этого зеркала.
      // Подавив swap, мы оставляем узел на своём зеркале, а адреса потомков
      // повисают: путь ждёт детей одного определения, в документе дети другого.
      //
      // Измерено на живом файле: `guidPath [585:511892, 585:511960, 16:51463]`
      // ждёт определение `16:51462`, активным остаётся `585:511976`.
      // Подавление дало `WRONG_NESTED_SWAP_CONTEXT` 0 → 1098 и
      // `overridesApplied` 15 558 → 13 655 при неизменном остальном.
      //
      // Видимость, текст, краски и sizing подавляются по-прежнему: у них нет
      // собственного пространства адресации, и потомков они за собой не ведут.
      if (source.opacity !== undefined) out.opacity = true;
      if (source.fillPaints !== undefined || source.inheritFillStyleID !== undefined) {
        out.fills = true; out.fillStyleId = true;
      }
      // Pixso materializes component-property state into auto-layout sizing.
      // Suppress only the sizing subset explicitly evidenced by co-location;
      // spacing/alignment remain ordinary occurrence overrides.
      if (source.stackPrimarySizing !== undefined || source.stackCounterSizing !== undefined) out.layout = true;
      if (source.stackChildPrimarySizing !== undefined || source.stackChildCounterSizing !== undefined) out.childLayout = true;
      return out;
    }

    for (var i = 0; i < records.length; i++) {
      var source = records[i];
      var keys = overrideKeys(source);
      if (!hasSupportedField(source)) {
        // Переносить нечего. Гонять такую запись через resolver значит
        // записать в отчёт промах адресации там, где адрес не понадобился бы
        // и при полном успехе. Считаем её тем, чем она является.
        Object.keys(source).forEach(function (field) {
          if (OVERRIDE_IGNORED[field]) return;
          // Пустой массив/объект ничего не несёт: это не потеря.
          if (emptyValue(source[field])) {
            countEmptyRepeatedOverride(source, field);
            return;
          }
          note(OVERRIDE_DECLINED[field] || IR_UNSUPPORTED.OVERRIDE_FIELD, field);
          if (APPEARANCE_OVERRIDE_FIELDS[field]) {
            markVisualLoss(lossSink, OVERRIDE_DECLINED[field] || "APPEARANCE_OVERRIDE_UNSUPPORTED");
          }
          stats.overridesDropped += 1;
        });
        noteOverrideResolution(OVERRIDE_RESOLUTION.NO_SUPPORTED_OVERRIDE_FIELD, {
          instanceSourceId: record.key,
          sourceSymbolId: record.symbolId,
          canonicalDefinitionId: definitionId,
          guidPath: keys,
          overrideFields: Object.keys(source).filter(function (field) { return !OVERRIDE_IGNORED[field]; }),
        });
        continue;
      }
      var resolved = resolveOverridePath(definitionId, keys, swapByPrefix, inferredSwaps, record);
      if (!resolved.ok) { reportUnresolved(resolved, keys, source); continue; }
      var entry = entryFor(resolved, keys, source);
      var overrideTargetRecord = doc.tree.byKey.get(resolved.expectedTargetGuid) || null;
      rememberRawTextOverride(entry, source, overrideTargetRecord, keys);
      var declaredSwapGuid = PixGuid.swapReference(source);
      if (declaredSwapGuid && entry.diagnostic) {
        var declaredSwapId = declaredSwapGuid;
        var swapTargetRecord = doc.tree.byKey.get(resolved.expectedTargetGuid);
        entry.diagnostic.overriddenSymbolId = declaredSwapId;
        entry.diagnostic.activeSymbolBefore = swapTargetRecord && swapTargetRecord.symbolId ||
          entry.diagnostic.activeSymbolBefore;
        entry.diagnostic.activeSymbolAfter = declaredSwapId;
      }
      // Пустой разрешённый путь означает, что запись адресует сам инстанс —
      // независимо от того, пришла она с пустым `guidPath` или с guid-ом
      // собственного символа.
      var beforeRawOps = Object.create(null);
      Object.keys(entry.ops).forEach(function (opKey) { beforeRawOps[opKey] = true; });
      applyOverrideRecord(source, entry.ops, entry.present, record, overrideTargetRecord,
        !resolved.path.length, detail, lossSink);

      // D51 A2. When Pixso stores componentPropAssignment in the SAME raw
      // override record as its materialized visibility/swap/paint/sizing
      // effects, those low-level fields are a fallback representation of the
      // assignment, not an independent edit. Mark only freshly emitted ops,
      // only when exactly one native assignment owns the record. The receiver
      // suppresses them iff that property was actually applied+verified.
      var coLocatedOwners = coLocatedAssignmentOwners(source, resolved);
      if (coLocatedOwners) {
        var derivedOps = materializedAssignmentOps(source);
        Object.keys(derivedOps).forEach(function (opKey) {
          if (beforeRawOps[opKey] || entry.ops[opKey] === undefined) return;
          var coLocatedOwner = coLocatedOwnerForOp(coLocatedOwners, opKey);
          if (!coLocatedOwner) return;
          if (!entry.nativeOwners) entry.nativeOwners = {};
          entry.nativeOwners[opKey] = {
            path: coLocatedOwner.path,
            propertyId: coLocatedOwner.propertyId,
            propertyType: coLocatedOwner.propertyType,
            provenance: "COLOCATED_COMPONENT_PROP_ASSIGNMENT",
          };
        });
      }

      // Pixso can switch a nested text override from intrinsic
      // WIDTH_AND_HEIGHT to HEIGHT without serializing a size on that TEXT.
      // In that representation the resolved occurrence root box carries the
      // width delta instead. Figma needs an explicit textbox width for HEIGHT;
      // otherwise the native instance keeps the canonical definition width
      // and long labels wrap one or two letters per line.
      //
      // Infer only the structurally proven direct-child case: horizontal HUG
      // component root, direct TEXT child, explicit HEIGHT override, no TEXT
      // size in the raw override, and an occurrence root width different from
      // its canonical root. The delta is propagated to the canonical text
      // width; no names or design-system ids participate.
      if (overrideTargetRecord && overrideTargetRecord.type === "TEXT" &&
          resolved.path.length === 1 && source.textAutoResize === "HEIGHT" &&
          source.size === undefined && source.textData &&
          typeof source.textData.characters === "string" && detail.size) {
        var rootRecordForTextWidth = doc.symbols.symbolsById.get(definitionId);
        if (rootRecordForTextWidth && overrideTargetRecord.parentKey === rootRecordForTextWidth.key) {
          var rootDetailForTextWidth = doc.detail(rootRecordForTextWidth);
          if (rootDetailForTextWidth && rootDetailForTextWidth.stackMode === "HORIZONTAL" &&
              rootDetailForTextWidth.stackPrimarySizing === "RESIZE_TO_FIT" &&
              rootDetailForTextWidth.size && typeof rootDetailForTextWidth.size.x === "number" &&
              typeof detail.size.x === "number") {
            var widthDelta = detail.size.x - rootDetailForTextWidth.size.x;
            if (Math.abs(widthDelta) > 0.01) {
              var textDetailForWidth = doc.detail(overrideTargetRecord);
              if (textDetailForWidth && textDetailForWidth.size &&
                  typeof textDetailForWidth.size.x === "number") {
                var inferredTextWidth = textDetailForWidth.size.x + widthDelta;
                if (isFinite(inferredTextWidth) && inferredTextWidth > 0.01) {
                  entry.ops.textBoxWidth = inferredTextWidth;
                  entry.present.textBoxWidth = true;
                  // A native Figma instance can expose TEXT characters, but
                  // it cannot express an arbitrary per-occurrence width of a
                  // nested text layer through component properties. Keeping
                  // this occurrence native would therefore preserve the
                  // canonical 31px textbox and wrap the replacement label by
                  // individual letters. The existing visual-safety contract
                  // says such proven state loss must use the exact snapshot.
                  markVisualLoss(lossSink, "NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE");
                }
              }
            }
          }
        }
      }
    }

    // --- Фаза 4. Операции из свойств ложатся поверх обычных --------------
    // Снимок raw visibility делается ДО первого semantic assignment: несколько
    // aliases одного public property могут адресовать тот же слой, и без
    // отдельного snapshot следующий assignment уже увидит результат
    // предыдущего, а не фактический symbolOverride Pixso.
    var rawVisibleByEntry = new Map();
    var rawCharactersByEntry = new Map();
    merged.forEach(function (entry) {
      if (entry && entry.present && entry.present.visible === true &&
          typeof entry.ops.visible === "boolean") {
        rawVisibleByEntry.set(entry, entry.ops.visible);
      }
      if (entry && entry.present && entry.present.characters === true &&
          typeof entry.ops.characters === "string") {
        rawCharactersByEntry.set(entry, entry.ops.characters);
      }
    });
    derived.forEach(function (item) {
      var resolved = resolveOverridePath(definitionId, item.keys, swapByPrefix, inferredSwaps, record);
      if (!resolved.ok) { reportUnresolved(resolved, item.keys, null); return; }
      var entry = entryFor(resolved, item.keys, null);
      rememberRawTextOverride(
        entry, item.rawSource,
        doc.tree.byKey.get(resolved.expectedTargetGuid) || null, item.keys
      );
      // Official Pixso/Figma component-property semantics are authoritative
      // for fields that are bound through componentPropertyReferences. A raw
      // symbolOverride may coexist in the serialized source, but once the
      // layer declares that `visible`, `characters` or `mainComponent` is
      // controlled by a public component property, the occurrence value must
      // be replayed through that property rather than by a competing late
      // low-level write. This keeps source property state and canvas state in
      // one ownership lane and avoids stale pre-variant/pre-swap residues.
      var rawVisiblePresent = item.binding.field === "visible" && rawVisibleByEntry.has(entry);
      var rawVisibleValue = rawVisiblePresent ? rawVisibleByEntry.get(entry) : undefined;
      var rawCharactersPresent = item.binding.field === "characters" && rawCharactersByEntry.has(entry);
      var rawCharactersValue = rawCharactersPresent ? rawCharactersByEntry.get(entry) : undefined;
      applyPropertyAssignment(item.binding, item.assignment, entry.ops, entry.present, record, lossSink);
      var booleanVisualConflict = rawVisiblePresent &&
        typeof rawVisibleValue === "boolean" &&
        typeof entry.ops.visible === "boolean" &&
        rawVisibleValue !== entry.ops.visible;
      var textVisualConflict = rawCharactersPresent &&
        typeof rawCharactersValue === "string" &&
        typeof entry.ops.characters === "string" &&
        rawCharactersValue !== entry.ops.characters;
      // Конфликт назначения свойства и сырой правки того же поля. Pixso рисует
      // назначение: проверено по снимку `derivedSymbolData` на двух реальных
      // документах — текст по числу глифов (9 из 9), видимость по HUG-ширине
      // родителя (31 из 31), противоречащих случаев нет. Сырая правка в
      // конфликте — устаревший остаток (например, заглушка «Название таба»
      // при назначенном «Поиск»), и в Figma она не переносится.
      if (booleanVisualConflict) stats.propertyConflictsBoolean += 1;
      if (textVisualConflict) stats.propertyConflictsText += 1;

      if (item.nativeOwner && item.nativeOwner.propertyId && item.nativeOwner.propertyType) {
        var ownerPath = resolveOverridePath(
          definitionId, item.nativeOwner.pathKeys || [], swapByPrefix, inferredSwaps, record
        );
        // applyPropertyAssignment имеет ровно три поддержанных semantic поля.
        // Совпадающая native operation владеет low-level replay.
        var ownedOp = item.binding.field === "swap" ? "swapDefinitionId" :
          (item.binding.field === "characters" ? "characters" :
            (item.binding.field === "visible" ? "visible" : null));
        if (ownerPath.ok && ownedOp && entry.ops[ownedOp] !== undefined) {
          // Назначение свойства авторитетно и при конфликте с сырой правкой:
          // поле принадлежит native property, low-level replay его не пишет.
          if (!entry.nativeOwners) entry.nativeOwners = {};
          entry.nativeOwners[ownedOp] = {
            path: ownerPath.path,
            propertyId: item.nativeOwner.propertyId,
            propertyType: item.nativeOwner.propertyType,
          };
        }
      }
    });

    // --- Фаза 5. Выведенные подмены становятся операциями ----------------
    // Разбор путей мог добавить новые выводы, поэтому очередь проходится до
    // стабилизации, но ограниченное число раз: цикл в данных не имеет права
    // повесить сборку.
    var emittedInferred = Object.create(null);
    for (var pass = 0; pass < 8; pass++) {
      var pending = Object.keys(inferredSwaps).filter(function (prefix) {
        return !emittedInferred[prefix];
      });
      if (!pending.length) break;
      pending.forEach(function (prefix) {
        emittedInferred[prefix] = true;
        var item = inferredSwaps[prefix];
        var symbolRecord = doc.symbols.symbolsById.get(item.symbolId);
        var swapDefinition = symbolRecord ? ensureDefinition(symbolRecord) : null;
        if (!swapDefinition) {
          note(IR_UNSUPPORTED.OVERRIDE_SWAP_UNRESOLVED, item.symbolId);
          stats.overridesDropped += 1;
          return;
        }
        var resolvedPrefix = resolveOverridePath(definitionId, item.keys, swapByPrefix, inferredSwaps, record);
        if (!resolvedPrefix.ok) { reportUnresolved(resolvedPrefix, item.keys, null); return; }
        var prefixEntry = entryFor(resolvedPrefix, item.keys, null);
        if (prefixEntry.ops.swapDefinitionId === undefined) {
          prefixEntry.ops.swapDefinitionId = swapDefinition;
          prefixEntry.present.swapDefinitionId = true;
          stats.swapsInferred += 1;
          stats.swapsInferredByEvidence[item.evidence] =
            (stats.swapsInferredByEvidence[item.evidence] || 0) + 1;
        }
      });
    }

    representFixedHugAsFill();

    if (sourceBoxSink) {
      collectSourceBoxes(record, definitionId, swapByPrefix, inferredSwaps, sourceBoxSink, merged, lossSink);
    }

    /**
     * HUG поверх одних только FIXED-детей, чьи размеры во вхождении отличаются
     * от мастера.
     *
     * Pixso хранит у вложенного слоя вхождения собственный размер. Нативный
     * инстанс Figma такой правки не держит: запись размера вложенному слою
     * живая Figma молча игнорирует (измерено на live-логе всеми публичными
     * способами), а при пересчёте возвращает размер мастера. HUG над таким
     * слоем тогда обнимает размер мастера, и вхождение уезжает шире источника.
     *
     * Но HUG, у которого все дети на оси FIXED, по этой оси поведенчески и
     * есть FIXED: содержимое его размер не меняет. А FIXED-ребёнок, ровно
     * заполняющий внутреннюю ось родителя, в Figma выражается растяжением —
     * это форма, которую нативный инстанс держит. Правило применяется только
     * при доказательстве по данным источника для КАЖДОГО ребёнка потока;
     * любая неизвестность (вложенное вхождение, отсутствующий снимок,
     * нативное владение полем) оставляет запись как есть.
     */
    function representFixedHugAsFill() {
      var geometry = null;
      try { geometry = typeof doc.derivedGeometry === "function" ? doc.derivedGeometry(record) : null; }
      catch (_eHugGeometry) { geometry = null; }
      if (!geometry || !geometry.size) return;
      var definitionMap = definitionPaths.get(definitionId);
      var symbolRecord = doc.symbols.symbolsById.get(definitionId);
      if (!definitionMap || !symbolRecord) return;

      merged.forEach(function (entry) {
        var layout = entry.ops && entry.ops.layout;
        if (!layout) return;
        var wantsPrimaryHug = layout.primaryAxisSizingMode === "AUTO";
        var wantsCounterHug = layout.counterAxisSizingMode === "AUTO";
        if (!wantsPrimaryHug && !wantsCounterHug) return;
        if (entry.nativeOwners && entry.nativeOwners.layout) return;
        // Только цели внутри самого определения вхождения: без пересечения
        // вложенных инстансов карта путей и снимок адресуются одинаково.
        for (var s = 0; s < entry.path.length; s++) {
          if (entry.path[s].definitionId && entry.path[s].definitionId !== definitionId) return;
        }
        var targetRecord = entry.path.length
          ? doc.tree.byKey.get(entry.path[entry.path.length - 1].sourceId) : symbolRecord;
        if (!targetRecord || targetRecord.type === "INSTANCE") return;
        var targetDetail = null;
        try { targetDetail = doc.detail(targetRecord); } catch (_eTargetDetail) { return; }
        var resolvedSize = entry.path.length
          ? (geometry.get(targetRecord.key) || {}).size : detail.size;
        if (!targetDetail || !resolvedSize) return;
        var mode = layout.layoutMode || SOURCE_LAYOUT_MODES[targetDetail.stackMode];
        if (mode !== "HORIZONTAL" && mode !== "VERTICAL") return;
        var horizontal = mode === "HORIZONTAL";
        var base = normalizer.autoLayout(targetDetail) || {};
        function pad(field) {
          var value = layout[field] !== undefined ? layout[field] : base[field];
          return typeof value === "number" ? value : 0;
        }

        var flow = [];
        var children = targetRecord.children || [];
        for (var c = 0; c < children.length; c++) {
          var child = children[c];
          var childPath = definitionMap.get(child.key);
          if (!childPath) return;
          var childKey = childPath.map(function (step) { return step.index; }).join(".");
          var childEntry = merged.get(childKey) || null;
          var childDetail = null;
          try { childDetail = doc.detail(child); } catch (_eChildDetail) { return; }
          if (!childDetail) return;
          var visible = childDetail.visible !== false;
          if (childEntry && childEntry.ops.visible !== undefined) visible = childEntry.ops.visible !== false;
          var nativeVisibility = nativeVisibilityOf(child.key);
          if (nativeVisibility === undefined) return;
          if (nativeVisibility !== null) visible = nativeVisibility;
          if (!visible) continue;
          var slot = normalizer.childLayout(childDetail, true) || {};
          var slotOps = childEntry && childEntry.ops.childLayout || {};
          var positioning = slotOps.layoutPositioning || slot.layoutPositioning;
          if (positioning === "ABSOLUTE") continue;
          flow.push({ record: child, detail: childDetail, path: childPath, key: childKey, entry: childEntry,
            grow: slotOps.layoutGrow !== undefined ? slotOps.layoutGrow : slot.layoutGrow,
            align: slotOps.layoutAlign !== undefined ? slotOps.layoutAlign : slot.layoutAlign });
        }
        if (!flow.length) return;

        var changes = [];
        function axisPlan(isPrimary) {
          var widthAxis = isPrimary === horizontal;
          var outer = widthAxis ? resolvedSize.x : resolvedSize.y;
          var inner = outer - (widthAxis ? pad("paddingLeft") + pad("paddingRight") : pad("paddingTop") + pad("paddingBottom"));
          if (isPrimary && flow.length !== 1) return null;
          var needsOverride = false;
          for (var f = 0; f < flow.length; f++) {
            var item = flow[f];
            if (isPrimary ? item.grow > 0 : item.align === "STRETCH") return null;
            if (item.entry && item.entry.nativeOwners && item.entry.nativeOwners.childLayout) return null;
            var sizing = childAxisSizing(item, widthAxis);
            if (sizing !== "FIXED") return null;
            var snapshot = geometry.get(item.record.key);
            var own = snapshot && snapshot.size;
            var master = item.detail.size;
            if (!own || !master) return null;
            var ownValue = widthAxis ? own.x : own.y;
            var masterValue = widthAxis ? master.x : master.y;
            if (Math.abs(ownValue - inner) > 0.5) return null;
            if (Math.abs(ownValue - masterValue) > 0.5) needsOverride = true;
          }
          return needsOverride ? { isPrimary: isPrimary } : null;
        }
        if (wantsPrimaryHug) { var primaryPlan = axisPlan(true); if (primaryPlan) changes.push(primaryPlan); }
        if (wantsCounterHug) { var counterPlan = axisPlan(false); if (counterPlan) changes.push(counterPlan); }
        if (!changes.length) return;

        changes.forEach(function (change) {
          var translationDecision = expressibilityPolicy.fixedHugAsFill();
          layout[change.isPrimary ? "primaryAxisSizingMode" : "counterAxisSizingMode"] = "FIXED";
          entry.expressibility = [translationDecision];
          flow.forEach(function (item) {
            var childEntry = item.entry;
            if (!childEntry) {
              childEntry = { path: item.path, ops: {}, present: {} };
              merged.set(item.key, childEntry);
              item.entry = childEntry;
            }
            var slotPatch = change.isPrimary ? { layoutGrow: 1 } : { layoutAlign: "STRETCH" };
            childEntry.ops.childLayout = merge(childEntry.ops.childLayout || {}, slotPatch);
            childEntry.present.childLayout = true;
            childEntry.expressibility = [translationDecision];
          });
          stats.fixedHugRepresentedAsFill += 1;
          note(IR_UNSUPPORTED.NESTED_FIXED_SIZE_REPRESENTED_AS_FILL, record.key);
        });
        entry.present.layout = true;
      });
    }

    /** Режим оси ребёнка по источнику: FIXED, HUG или null, если не доказан. */
    function childAxisSizing(item, widthAxis) {
      var type = item.record.type;
      if (type === "INSTANCE" || type === "GROUP" || type === "BOOLEAN_OPERATION") return null;
      if (type === "TEXT") {
        if (item.entry && item.entry.ops.textAutoResize !== undefined) return null;
        var auto = item.detail.textAutoResize || "NONE";
        if (auto === "WIDTH_AND_HEIGHT") return "HUG";
        if (auto === "HEIGHT") return widthAxis ? "FIXED" : "HUG";
        return "FIXED";
      }
      var childMode = SOURCE_LAYOUT_MODES[item.detail.stackMode] || null;
      var childLayout = item.entry && item.entry.ops.layout || {};
      if (childLayout.layoutMode) childMode = childLayout.layoutMode;
      if (!childMode) return "FIXED";
      var primaryIsWidth = childMode === "HORIZONTAL";
      var field = widthAxis === primaryIsWidth ? "primaryAxisSizingMode" : "counterAxisSizingMode";
      var sourceField = widthAxis === primaryIsWidth ? "stackPrimarySizing" : "stackCounterSizing";
      var value = childLayout[field] !== undefined ? childLayout[field] : (AXIS_SIZING[item.detail[sourceField]] || "FIXED");
      return value === "AUTO" ? "HUG" : "FIXED";
    }

    /**
     * Видимость прямого ребёнка корня, заданная нативным BOOLEAN этого
     * вхождения: true/false, null — свойство её не задаёт, undefined — две
     * записи противоречат друг другу.
     */
    function nativeVisibilityOf(nodeKey) {
      var result = null;
      var conflict = false;
      nativeAssignments.forEach(function (assignment) {
        if (assignment.type !== "BOOLEAN" || (assignment.path && assignment.path.length)) return;
        var found = propertyBindings(definitionId, { key: assignment.propertyId });
        (found.list || []).forEach(function (binding) {
          if (binding.nodeKey !== nodeKey || binding.field !== "visible") return;
          if (result !== null && result !== !!assignment.value) conflict = true;
          result = !!assignment.value;
        });
      });
      return conflict ? undefined : result;
    }

    var out = [];
    merged.forEach(function (entry) {
      if (!Object.keys(entry.ops).length) {
        // Цель найдена, но переносить нечего: все поля записи вне модели
        // Direct PIX. Это неподдержанная запись, а не промах адресации.
        noteOverrideResolution(OVERRIDE_RESOLUTION.NO_SUPPORTED_OVERRIDE_FIELD, {
          instanceSourceId: record.key,
          canonicalDefinitionId: definitionId,
          guidPath: entry.diagnostic ? entry.diagnostic.guidPath : [],
        });
        return;
      }
      if (entry.diagnostic) {
        entry.diagnostic.overrideFields = Object.keys(entry.ops);
        entry.diagnostic.overrideTypes = entry.diagnostic.overrideFields.reduce(function (out, field) {
          var value = entry.ops[field];
          out[field] = Array.isArray(value) ? "array" : typeof value;
          return out;
        }, {});
        if (entry.diagnostic.textTrace) {
          entry.diagnostic.textTrace.normalizedFields = Object.keys(entry.ops);
          entry.diagnostic.textTrace.normalizedPresent = Object.assign({}, entry.present);
          entry.diagnostic.textTrace.normalizedValues = Object.assign({}, entry.ops);
        }
      }
      stats.overridesAttempted += Object.keys(entry.ops).length;
      stats.overridesApplied += Object.keys(entry.ops).length;
      if (!entry.expressibility) {
        var expressibilityTarget = entry.path && entry.path.length
          ? doc.tree.byKey.get(entry.path[entry.path.length - 1].sourceId) : null;
        var expressibilityDetail = expressibilityTarget ? baseDetail(expressibilityTarget) : null;
        entry.expressibility = expressibilityPolicy.classifyOverride(entry, {
          targetType: expressibilityTarget && expressibilityTarget.type || null,
          textAutoResize: expressibilityDetail && expressibilityDetail.textAutoResize || null,
          secondLevelFill: entry.path.some(function (step) {
            return step && step.definitionId && step.definitionId !== definitionId;
          }),
        });
      }
      entry.expressibility.forEach(function (verdict) {
        if (verdict.op === "characters" && verdict.translation === "TRAILING_SPACE_AS_NBSP" &&
            typeof entry.ops.characters === "string") {
          entry.ops.characters = Expressibility.trailingSpacesAsNbsp(entry.ops.characters);
          stats.trailingSpacesAsNbsp = (stats.trailingSpacesAsNbsp || 0) + 1;
        }
      });
      entry.expressibility.forEach(function (verdict, verdictIndex) {
        expressibility.record("override:" + record.key + ":" +
          entry.path.map(function (step) { return step.index; }).join(".") + ":" +
          (verdict.op || verdictIndex), verdict,
        entry.diagnostic && entry.diagnostic.instanceSourceId || record.key);
      });
      out.push(entry);
    });
    // Сначала мелкие пути, потом глубокие: подмена вложенного компонента
    // обязана примениться раньше, чем override внутри подменённого дерева.
    out.sort(function (a, b) { return a.path.length - b.path.length; });
    if (nativePropertySink && nativeAssignments.size) {
      nativeAssignments.forEach(function (entry) {
        var nativeDecision = expressibilityPolicy.nativeProperty();
        entry.expressibility = [nativeDecision];
        expressibility.record("native:" + record.key + ":" + entry.propertyId,
          nativeDecision, record.key);
        nativePropertySink.push(entry);
      });
      nativePropertySink.sort(function (a, b) { return a.path.length - b.path.length; });
    }
    // Карта подмен этого вхождения отдаётся наружу целиком: явные
    // `overriddenSymbolID`, подмены из назначений свойств и доказанные по ходу
    // разбора. Вхождению внутри мастера она принадлежит не как его личное
    // состояние, а как содержимое определения — см. `definitionInternalSwaps`.
    if (swapSink) {
      Object.keys(swapByPrefix).forEach(function (prefix) {
        if (!prefix) return;
        swapSink[prefix] = swapByPrefix[prefix];
      });
    }
    return out;
  }

  /**
   * Эффективные углы цели override.
   *
   * Pixso пишет в запись только изменённые угловые поля. Базой служит сам узел
   * определения: без неё «поменяли верхний левый» превращалось бы в «обнулили
   * остальные три». Если базы нет (цель не читается), переносится то, что
   * записано, — но всё равно как четыре значения, а не как обрывок.
   */
  function effectiveCorners(source, targetRecord) {
    var base = null;
    if (targetRecord) {
      try { base = normalizer.cornerRadii(doc.detail(targetRecord)); }
      catch (_eDetail) { base = null; }
    }
    var hasOwnCorner = normalizer.hasPerCornerRadius(source) ||
      typeof source.cornerRadius === "number";
    if (!hasOwnCorner) return normalizer.cornersFromRadii(base, source) || {};

    var radii = normalizer.cornerRadii(source);
    if (normalizer.hasPerCornerRadius(source) && base) {
      // Отсутствующее в записи поугловое поле означает 0 только тогда, когда
      // запись задаёт углы целиком. Частичная запись поверх известной базы
      // сохраняет неупомянутые углы.
      var fields = ["rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius",
        "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius"];
      radii = fields.map(function (field, index) {
        return typeof source[field] === "number" ? source[field] : base[index];
      });
    }
    return normalizer.cornersFromRadii(radii, source) || {};
  }

  // -------------------------------------------------------------------------
  // Происхождение полей sizing в записи override
  // -------------------------------------------------------------------------

  /**
   * Полный узел определения по его записи индекса.
   *
   * Кеш здесь не оптимизация, а условие применимости: одна цель override
   * адресуется несколькими записями подряд, а `doc.detail` каждый раз заново
   * разбирает узел из байтов. Кеш живёт ровно столько же, сколько сборка
   * одного корня, и ограничен: документ целиком в память класться не должен.
   */
  var baseDetailCache = new Map();
  var BASE_DETAIL_CACHE_LIMIT = 4096;

  function baseDetail(targetRecord) {
    if (!targetRecord) return null;
    if (baseDetailCache.has(targetRecord.key)) return baseDetailCache.get(targetRecord.key);
    var detail = null;
    try { detail = doc.detail(targetRecord); }
    catch (_eDetail) { detail = null; }
    if (baseDetailCache.size < BASE_DETAIL_CACHE_LIMIT) baseDetailCache.set(targetRecord.key, detail);
    return detail;
  }

  function axisSize(vector, widthAxis) {
    if (!vector) return null;
    var value = widthAxis ? vector.x : vector.y;
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  /**
   * Происхождение одного поля sizing.
   *
   * Решение принимается только по обобщённым величинам источника: объявленное
   * значение, значение определения, направление раскладки цели и разрешённая
   * геометрия. Имена слоёв, componentKey, id и конкретные числа фикстур в
   * решении не участвуют — иначе классификатор был бы настроен на один файл.
   */
  function sizingProvenance(entry, declared, base, resolvedSize, mode) {
    if (!base || !SOURCE_LAYOUT_MODES[mode]) return { provenance: LAYOUT_PROVENANCE.UNKNOWN };
    // Отсутствие поля у контейнера измерено как FIXED (см. README, раздел
    // «Что означает каждое значение»), но «объявлено FIXED» и «поля нет» —
    // разные факты, и второй ниже отделяет вырожденный случай от настоящего.
    var baseDeclared = AXIS_SIZING[base[entry.field]] || null;
    if (declared === (baseDeclared || "FIXED")) {
      return { provenance: LAYOUT_PROVENANCE.BASE_DEFINITION };
    }
    // Тикет трогает ровно одно направление — переключение оси в HUG. Обратное
    // (`FIXED` поверх обнимающего мастера) размер источника не снимает, а
    // возвращает, и глушить его нельзя.
    if (declared !== "AUTO") return { provenance: LAYOUT_PROVENANCE.EXPLICIT_SYMBOL_OVERRIDE };

    var widthAxis = entry.primary === (mode === "HORIZONTAL");
    var baseValue = axisSize(base.size, widthAxis);
    var resolvedValue = axisSize(resolvedSize, widthAxis);
    if (baseValue === null || resolvedValue === null || !(baseValue > 0)) {
      return { provenance: LAYOUT_PROVENANCE.UNKNOWN };
    }
    if (Math.abs(resolvedValue - baseValue) > 0.01) {
      return { provenance: LAYOUT_PROVENANCE.EXPLICIT_SYMBOL_OVERRIDE };
    }
    // Ось переключена в HUG, а разрешённый размер по ней не изменился: в
    // самом Pixso поле ничего не сделало. В Figma оно сняло бы с оси конечный
    // ненулевой размер источника и отдало бы её раскладке — это и есть
    // доказанный разрушительный класс, ради которого заведена проверка.
    return { provenance: LAYOUT_PROVENANCE.DERIVED_EFFECTIVE, destructive: true };
  }

  /**
   * Снимает с операции раскладки те поля sizing, для которых доказано, что
   * они являются эффективным снимком, а не правкой вхождения.
   *
   * Остальные поля записи — отступы, выравнивания, направление — не трогаются:
   * запись доказанно смешанная, и подавление целой операции потеряло бы
   * настоящее состояние вместе со снимком.
   */
  function classifyOverrideSizing(source, layout, targetRecord, selfTargeted, ownDetail) {
    var base = null;
    var resolvedSize = null;
    var mode = null;
    for (var i = 0; i < LAYOUT_SIZING_FIELDS.length; i++) {
      var entry = LAYOUT_SIZING_FIELDS[i];
      var declared = AXIS_SIZING[source[entry.field]];
      if (!declared || layout[entry.op] === undefined) continue;
      if (!base) {
        base = baseDetail(targetRecord);
        // Направление раскладки ЦЕЛИ: если запись несёт своё — оно и
        // действует, иначе остаётся то, которое приёмник поставил из
        // определения.
        mode = SOURCE_LAYOUT_MODES[source.stackMode] ||
          (base ? SOURCE_LAYOUT_MODES[base.stackMode] : null) || null;
        // Разрешённая геометрия цели. Для записи, адресующей САМ инстанс, это
        // его собственная коробка — она и есть результат Pixso. Для вложенной
        // цели собственной коробки у вхождения нет, и единственная запись о
        // геометрии — размер самой записи override.
        resolvedSize = selfTargeted
          ? (ownDetail ? ownDetail.size : null)
          : source.size;
      }
      stats.layoutOverrideCandidates += 1;
      var verdict = sizingProvenance(entry, declared, base, resolvedSize, mode);
      switch (verdict.provenance) {
        case LAYOUT_PROVENANCE.EXPLICIT_SYMBOL_OVERRIDE:
          stats.layoutOverrideExplicitApplied += 1;
          break;
        case LAYOUT_PROVENANCE.BASE_DEFINITION:
          stats.layoutOverrideBaseEchoSuppressed += 1;
          delete layout[entry.op];
          break;
        case LAYOUT_PROVENANCE.DERIVED_EFFECTIVE:
          stats.layoutOverrideDerivedSuppressed += 1;
          if (verdict.destructive) stats.layoutOverrideDestructiveSuppressed += 1;
          delete layout[entry.op];
          break;
        default:
          stats.layoutOverrideUnknown += 1;
          note(IR_UNSUPPORTED.LAYOUT_SIZING_PROVENANCE_UNKNOWN, entry.field);
      }
    }
    return Object.keys(layout).length ? layout : null;
  }

  /** Значение свойства компонента в терминах операций Direct PIX. */
  function applyPropertyAssignment(binding, assignment, ops, present, record, lossSink) {
    var value = assignment.value || {};
    switch (binding.field) {
      case "swap": {
        var symbolKey = assignmentSymbolKey(assignment);
        var symbolRecord = symbolKey ? doc.symbols.symbolsById.get(symbolKey) : null;
        if (!symbolRecord) {
          note(IR_UNSUPPORTED.OVERRIDE_SWAP_UNRESOLVED, symbolKey || record.key);
          markVisualLoss(lossSink, "COMPONENT_SWAP_UNRESOLVED");
          stats.overridesDropped += 1;
          return;
        }
        var swapDefinition = ensureDefinition(symbolRecord);
        if (!swapDefinition) { markVisualLoss(lossSink, "COMPONENT_SWAP_UNRESOLVED"); stats.overridesDropped += 1; return; }
        ops.swapDefinitionId = swapDefinition;
        present.swapDefinitionId = true;
        return;
      }
      case "characters": {
        var text = value.textValue;
        if (!text || typeof text.characters !== "string") {
          note(IR_UNSUPPORTED.COMPONENT_PROPERTY_FIELD, "TEXT_DATA");
          markVisualLoss(lossSink, "COMPONENT_PROPERTY_VALUE_UNSUPPORTED");
          stats.overridesDropped += 1;
          return;
        }
        ops.characters = text.characters;
        present.characters = true;
        stats.textOverridesSeen += 1;
        stats.explicitTextChanges += 1;
        if (text.characters === "") stats.explicitTextClears += 1;
        return;
      }
      case "visible":
        if (typeof value.boolValue !== "boolean") {
          note(IR_UNSUPPORTED.COMPONENT_PROPERTY_FIELD, "VISIBLE");
          markVisualLoss(lossSink, "COMPONENT_PROPERTY_VALUE_UNSUPPORTED");
          stats.overridesDropped += 1;
          return;
        }
        ops.visible = value.boolValue;
        present.visible = true;
        stats.visibilityOverridesSeen += 1;
        return;
      default:
        note(IR_UNSUPPORTED.COMPONENT_PROPERTY_FIELD, binding.field);
        markVisualLoss(lossSink, "COMPONENT_PROPERTY_VALUE_UNSUPPORTED");
        stats.overridesDropped += 1;
    }
  }

  /**
   * Paint-операция записи override — общая для заливок и обводок.
   *
   * Ровно три исхода, и каждый обязан быть доказан содержимым записи:
   *
   *   поле не сериализовано или сериализовано пустым списком-заглушкой
   *     → операции нет, база сохраняется (`present` остаётся пустым);
   *   поле сериализовано непустым списком или ссылкой на стиль с красками
   *     → операция есть, красим;
   *   доказанного представления «очистить краски» у дельты Pixso нет
   *     → очистка не выпускается никогда.
   *
   * Отдельный, но такой же опасный случай: непустой список, из которого
   * отображение выбросило ВСЕ краски (неизвестный тип, потерянная картинка).
   * Результат — пустой массив, который в приёмнике неотличим от очистки.
   * Такой список тоже не выпускается: потеря краски регистрируется как потеря,
   * а не как приказ стереть то, что уже стоит на узле.
   */
  function applyPaintOverride(source, ops, present, record, lossSink, handled, opKey, paintField, styleField) {
    // Одну операцию адресуют два поля записи (`fillPaints` и
    // `inheritFillStyleID`), а разрешает их `overridePaints` вместе. Второй
    // заход ничего не менял бы, но задваивал бы счётчики.
    if (handled[opKey]) return;
    handled[opKey] = true;
    var paintSource = normalizer.overridePaints(source, paintField, styleField);
    if (!paintSource) {
      if (Array.isArray(source[paintField]) && !source[paintField].length) {
        stats.emptyRepeatedOverridesIgnored += 1;
        stats.paintDefaultArrayIgnored += 1;
      }
      return;
    }
    stats.paintOverridesPresent += 1;
    var mapped = normalizer.paints(paintSource, record.key);
    if (mapped && mapped.length) {
      ops[opKey] = mapped;
      present[opKey] = true;
      stats.paintOverridesSeen += 1;
      stats.paintOverridesApplied += 1;
      // Запись override тоже несёт идентичность стиля. Привязка выдаётся по
      // тому же правилу, что и у обычного узла: только если краски записи и
      // краски стиля совпали. Местная краска вхождения выигрывает у стиля —
      // иначе привязка стёрла бы легитимный override.
      var styleOpKey = opKey === "fills" ? "fillStyleId" : "strokeStyleId";
      var boundStyle = styleRegistry.bindPaints(source[styleField], mapped);
      if (boundStyle) {
        ops[styleOpKey] = boundStyle;
        present[styleOpKey] = true;
        stats.styleOverrideBindings[opKey === "fills" ? "fill" : "stroke"] += 1;
      }
    } else {
      stats.paintOverridesDropped += 1;
    }
    if (visibleSourceCount(paintSource) > (mapped ? mapped.length : 0)) {
      markVisualLoss(lossSink, "PAINT_UNSUPPORTED");
    }
  }

  function applyOverrideRecord(source, ops, present, record, targetRecord, selfTargeted, ownDetail, lossSink) {
    sourceSemanticAudit.overridesAudited += 1;
    var handled = Object.create(null);
    Object.keys(source).forEach(function (field) {
      if (OVERRIDE_IGNORED[field]) return;
      var supported = OVERRIDE_FIELDS[field];
      // Запись override, адресующая сам инстанс, — это дельта относительно
      // мастера. Часть таких полей вхождение уже несёт своей собственной
      // записью, и она является РАЗРЕШЁННЫМ состоянием: приёмник берёт оттуда
      // геометрию, видимость, имя и поведение внутри auto layout. На реальном
      // документе дельта этим полям противоречит — сама запись вхождения
      // говорит `stackChildCounterSizing: RESIZE_TO_FIT`, `visible: false`,
      // `size: 81×28`, а дельта — `FIXED`, `true`, `97×28`. Применить дельту
      // значит снять растяжение со строки таблицы, вернуть скрытый слой и
      // раздуть вхождение.
      //
      // Поэтому поле пропускается ровно тогда, когда выполнены оба условия:
      // операция принадлежит самому вхождению И его запись это поле несёт.
      // Если запись поля не содержит (так бывает с constraints), дельта —
      // единственный источник, и она переносится как обычно.
      if (selfTargeted && ownDetail) {
        var occurrenceOwnField = OCCURRENCE_OWN_OPS[supported] && ownDetail[field] !== undefined;
        // Visibility bound through `componentPropRef` is already a resolved
        // occurrence field. Pixso omits `visible` when that resolved value is
        // the default true, but can retain an older self-targeted
        // symbolOverride `visible:false`. Replaying that stale delta hides a
        // layer that is visibly present in Pixso. Only property-bound root
        // visibility gets this default-value rule; an ordinary self-targeted
        // visibility override remains a valid explicit delta.
        if (supported === "visible" && ownDetail.visible === undefined &&
            Array.isArray(ownDetail.componentPropRef) && ownDetail.componentPropRef.some(function (ref) {
              return ref && ref.componentPropNodeField === "VISIBLE";
            })) occurrenceOwnField = true;
        // Pixso writes a complete resolved appearance on the INSTANCE record
        // itself and can simultaneously retain a stale root symbolOverride.
        // This is especially common for fill/stroke color overrides: the
        // occurrence says its root fill is hidden while guidPath=[] still
        // carries a visible shared color intended by an older component
        // state. Applying the latter paints the whole Figma Instance.
        //
        // Same rule as size/visibility above, but paints have two source
        // fields (local paints + inherited style), so either root paint field
        // yields to an explicitly serialized occurrence paint list.
        if (supported === "fills" && ownDetail.fillPaints !== undefined) occurrenceOwnField = true;
        if (supported === "strokes" && ownDetail.strokePaints !== undefined) occurrenceOwnField = true;
        if (occurrenceOwnField) return;
      }
      if (!supported) {
        if (emptyValue(source[field])) return;
        // Причина по существу там, где она известна: «поле такое-то не
        // переносится потому-то» полезнее, чем общий счётчик промахов.
        note(OVERRIDE_DECLINED[field] || IR_UNSUPPORTED.OVERRIDE_FIELD, field);
        if (APPEARANCE_OVERRIDE_FIELDS[field]) {
          markVisualLoss(lossSink, OVERRIDE_DECLINED[field] || "APPEARANCE_OVERRIDE_UNSUPPORTED");
        }
        stats.overridesDropped += 1;
        return;
      }
      switch (supported) {
        case "name":
          ops.name = source.name;
          present.name = true;
          return;
        case "visible":
          ops.visible = source.visible;
          present.visible = true;
          stats.visibilityOverridesSeen += 1;
          return;
        case "opacity":
          ops.opacity = source.opacity;
          present.opacity = true;
          return;
        case "blendMode": {
          var blendMode = normalizer.blendMode(source.blendMode);
          if (blendMode) { ops.blendMode = blendMode; present.blendMode = true; }
          else markVisualLoss(lossSink, "BLEND_MODE_UNSUPPORTED");
          return;
        }
        case "placement":
          if (source.transform) { ops.placement = normalizer.placement(source, record.key); present.placement = true; }
          else markVisualLoss(lossSink, "TRANSFORM_UNSUPPORTED");
          return;
        case "mask":
          if (source.mask !== undefined) { ops.isMask = !!source.mask; present.isMask = true; }
          if (source.maskType !== undefined) {
            var maskType = normalizer.maskType(source.maskType);
            if (maskType) { ops.maskType = maskType; present.maskType = true; }
            else markVisualLoss(lossSink, "MASK_TYPE_UNSUPPORTED");
          }
          return;
        case "size":
          if (source.size) { ops.size = { width: source.size.x, height: source.size.y }; present.size = true; }
          return;
        case "strokeWeight":
          // Носитель толщины выбирается по той же нормализации, что и у
          // собственного узла. В per-side режиме общей толщины нет вовсе:
          // стороны приедут в `strokeStyle` и опишут её полностью. Выдать
          // здесь сырой `strokeWeight` значило бы послать вторую операцию на
          // то же свойство, и победила бы та, что легла последней.
          var uniformWeight = normalizer.strokeWeights(source).uniform;
          if (typeof uniformWeight === "number") {
            ops.strokeWeight = uniformWeight;
            present.strokeWeight = true;
          }
          return;
        case "fills":
          applyPaintOverride(source, ops, present, record, lossSink, handled,
            "fills", "fillPaints", "inheritFillStyleID");
          return;
        case "strokes":
          applyPaintOverride(source, ops, present, record, lossSink, handled,
            "strokes", "strokePaints", "inheritStrokeStyleID");
          return;
        case "characters":
          if (source.textData === null ||
              (source.textData && hasOwn(source.textData, "characters"))) {
            ops.characters = source.textData === null ? null : source.textData.characters;
            present.characters = true;
            stats.textOverridesSeen += 1;
            if (typeof ops.characters === "string") {
              stats.explicitTextChanges += 1;
              if (ops.characters === "") stats.explicitTextClears += 1;
            }
          }
          return;
        case "corners": {
          // Запись override приходит частичной: «у этого вхождения другой
          // левый верхний угол». Приёмнику нужен ЭФФЕКТИВНЫЙ результат по всем
          // четырём углам, иначе три оставшихся угла молча уедут в ноль.
          // Основой служит сам узел определения, поверх него ложатся поля
          // записи — ровно тем же правилом, что и у обычного узла.
          ops.corners = effectiveCorners(source, targetRecord);
          present.corners = true;
          return;
        }
        case "locked":
          ops.locked = source.locked === true;
          present.locked = true;
          return;
        case "clipsContent":
          ops.clipsContent = !source.frameMaskDisabled;
          present.clipsContent = true;
          return;
        case "effects": {
          // Тот же случай, что у заливок: пустой `effects[]` в записи override —
          // заглушка сериализатора, а не «снять тени». Разбор — в
          // `PixNormalizer.overrideRepeated`.
          if (handled.effects) return;
          handled.effects = true;
          var effectSource = normalizer.overrideEffects(source);
          if (!effectSource) {
            if (Array.isArray(source.effects) && !source.effects.length) {
              stats.emptyRepeatedOverridesIgnored += 1;
            }
            return;
          }
          var mappedEffects = normalizer.effects(effectSource, record.key);
          // Отображение, схлопнувшее непустой список в пустой, — это потеря
          // эффекта, а не приказ его снять: операция не выпускается.
          if (mappedEffects && mappedEffects.length) {
            ops.effects = mappedEffects;
            present.effects = true;
            var boundEffectStyle = styleRegistry.bindEffects(source.inheritEffectStyleID, mappedEffects);
            if (boundEffectStyle) {
              ops.effectStyleId = boundEffectStyle;
              present.effectStyleId = true;
              stats.styleOverrideBindings.effect += 1;
            }
          }
          if (visibleSourceCount(effectSource) > (mappedEffects ? mappedEffects.length : 0)) {
            markVisualLoss(lossSink, "EFFECT_UNSUPPORTED");
          }
          return;
        }
        case "layout": {
          // Поля auto layout приходят россыпью по нескольким записям, поэтому
          // операция накапливается, а не перезаписывается.
          var targetFlowChildCount = targetRecord && (targetRecord.children || []).reduce(function (count, child) {
            if (!child) return count;
            var childDetail = doc.detail(child) || {};
            if (child.visible === false || childDetail.visible === false || childDetail.autoLayoutAbsolutePos) return count;
            return count + 1;
          }, 0);
          var layout = normalizer.overrideLayout(source, { flowChildCount: targetFlowChildCount });
          // Поля sizing внутри записи проверяются на происхождение: часть из
          // них — эффективный снимок, и воспроизведение снимает с оси размер
          // источника. Остальные поля записи это не трогает.
          if (layout && layoutProvenance) {
            layout = classifyOverrideSizing(source, layout, targetRecord, selfTargeted, ownDetail);
          }
          if (layout) { ops.layout = merge(ops.layout, layout); present.layout = true; }
          return;
        }
        case "childLayout": {
          var childLayout = normalizer.overrideChildLayout(source);
          if (!childLayout) return;
          if (selfTargeted && ownDetail) {
            Object.keys(CHILD_LAYOUT_SOURCES).forEach(function (key) {
              var carried = CHILD_LAYOUT_SOURCES[key].some(function (name) {
                return ownDetail[name] !== undefined;
              });
              if (carried) delete childLayout[key];
            });
          }
          if (Object.keys(childLayout).length) {
            ops.childLayout = merge(ops.childLayout, childLayout);
            present.childLayout = true;
          }
          return;
        }
        case "sizeBounds": {
          var overrideBounds = normalizer.sizeBounds(source);
          if (overrideBounds) { ops.sizeBounds = merge(ops.sizeBounds, overrideBounds); present.sizeBounds = true; }
          return;
        }
        case "constraints": {
          var overrideConstraints = normalizer.constraints(source);
          if (overrideConstraints) { ops.constraints = overrideConstraints; present.constraints = true; }
          return;
        }
        case "aspectRatio":
          if (typeof source.proportionsConstrained === "boolean") {
            ops.aspectRatioLocked = source.proportionsConstrained;
            present.aspectRatioLocked = true;
          }
          return;
        case "strokeStyle": {
          var strokeStyle = normalizer.overrideStroke(source);
          if (strokeStyle) { ops.strokeStyle = merge(ops.strokeStyle, strokeStyle); present.strokeStyle = true; }
          return;
        }
        case "textStyle": {
          var textStyle = normalizer.overrideText(source);
          if (source.inheritTextStyleID) {
            // Стиль Pixso — обычный узел документа: его типографика читается
            // ровно тем же способом, что и у fill/effect-стилей.
            var styleText = normalizer.styleNodeText(source.inheritTextStyleID);
            if (styleText) textStyle = merge(styleText, textStyle || {});
            else note(IR_UNSUPPORTED.OVERRIDE_FIELD, "inheritTextStyleID");
          }
          if (textStyle && Object.keys(textStyle).length) {
            ops.textStyle = merge(ops.textStyle, textStyle);
            present.textStyle = true;
            stats.textStyleOverridesSeen += 1;
            // Привязка к TextStyle выпускается только для текстовой цели:
            // на нетекстовом узле приёмник её всё равно отвергнет, а лишний
            // отказ удвоил бы один и тот же дефект в отчёте.
            var boundTextStyle = targetRecord && targetRecord.type === "TEXT"
              ? styleRegistry.bindText(source.inheritTextStyleID, ops.textStyle)
              : null;
            if (boundTextStyle) {
              ops.textStyleId = boundTextStyle;
              present.textStyleId = true;
              stats.styleOverrideBindings.text += 1;
            }
          }
          return;
        }
        case "swap": {
          // Подмена вложенного компонента: она допустима только при
          // однозначной ссылке на другой SYMBOL документа.
          var swapId = PixGuid.swapReference(source);
          var swapRecord = swapId ? doc.symbols.symbolsById.get(swapId) : null;
          if (!swapRecord) {
            note(IR_UNSUPPORTED.OVERRIDE_SWAP_UNRESOLVED, swapId || "нет ссылки");
            markVisualLoss(lossSink, "COMPONENT_SWAP_UNRESOLVED");
            stats.overridesDropped += 1;
            return;
          }
          var swapDefinition = ensureDefinition(swapRecord);
          if (!swapDefinition) { markVisualLoss(lossSink, "COMPONENT_SWAP_UNRESOLVED"); stats.overridesDropped += 1; return; }
          ops.swapDefinitionId = swapDefinition;
          present.swapDefinitionId = true;
          return;
        }
        default:
          note(IR_UNSUPPORTED.OVERRIDE_FIELD, field);
          if (APPEARANCE_OVERRIDE_FIELDS[field]) markVisualLoss(lossSink, "APPEARANCE_OVERRIDE_UNSUPPORTED");
          stats.overridesDropped += 1;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Корни
  // -------------------------------------------------------------------------

  /** Собирает один корень страницы в плоский список узлов IR. */
  function buildRoot(rootRecord) {
    var nodes = [];
    var rootNode = emitNode(rootRecord, null, false, nodes);
    if (!rootNode) return null;
    if (rootNode.kind === "ORDINARY" && rootRecord.children.length && !CONTAINER_TYPES[rootNode.type]) {
      note(IR_UNSUPPORTED.FLATTENED_CHILDREN, rootRecord.type);
    } else if (rootNode.kind === "ORDINARY" && rootRecord.children.length) {
      var stack = [{ record: rootRecord, parentId: rootRecord.key, parentAutoLayout: !!rootNode.autoLayout }];
      while (stack.length) {
        var frame = stack.pop();
        var children = frame.record.children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          var emitted = emitNode(child, frame.parentId, frame.parentAutoLayout, nodes);
          if (!emitted) continue;
          if (emitted.kind === "ORDINARY" && child.children.length) {
            if (!CONTAINER_TYPES[emitted.type]) note(IR_UNSUPPORTED.FLATTENED_CHILDREN, child.type);
            else stack.push({ record: child, parentId: child.key, parentAutoLayout: !!emitted.autoLayout });
          }
        }
      }
    }
    var page = rootRecord.parent;
    return {
      rootId: rootRecord.key,
      rootName: rootRecord.name || "Root",
      pageId: page ? page.key : null,
      pageName: page ? page.name || "Pixso" : "Pixso",
      nodes: nodes,
    };
  }

  /**
   * Определения обязаны ехать в порядке зависимостей: приёмник создаёт
   * вложенное вхождение и применяет подмену компонента сразу при сборке, а
   * значит адресат к этому моменту уже должен существовать.
   *
   * Порядок построения почти совпадает с нужным (вложенное собирается раньше
   * внешнего), но определения, впервые понадобившиеся при разборе override,
   * дописываются в конец. Сортировка это чинит; цикл, если он вдруг найдётся,
   * не роняет сборку — оставшиеся определения уезжают в исходном порядке, а
   * недостижимая подмена честно считается на приёмнике.
   */
  function sortDefinitionsByDependency(list) {
    var byId = new Map();
    list.forEach(function (definition) { byId.set(definition.definitionId, definition); });

    var dependencies = new Map();
    list.forEach(function (definition) {
      var needs = [];
      definition.nodes.forEach(function (node) {
        if (node.kind === "INSTANCE" && node.definitionId) needs.push(node.definitionId);
        (node.overrides || []).forEach(function (entry) {
          if (entry.ops && entry.ops.swapDefinitionId) needs.push(entry.ops.swapDefinitionId);
        });
      });
      dependencies.set(definition.definitionId, needs);
    });

    var ordered = [];
    var state = new Map();
    list.forEach(function (definition) {
      // Итеративный обход: рекурсия по документу с тысячами определений
      // упирается в стек.
      var stack = [{ id: definition.definitionId, index: 0 }];
      while (stack.length) {
        var frame = stack[stack.length - 1];
        if (state.get(frame.id) === "done") { stack.pop(); continue; }
        state.set(frame.id, "visiting");
        var needs = dependencies.get(frame.id) || [];
        var advanced = false;
        while (frame.index < needs.length) {
          var next = needs[frame.index++];
          if (!byId.has(next) || state.get(next) === "done" || state.get(next) === "visiting") continue;
          stack.push({ id: next, index: 0 });
          advanced = true;
          break;
        }
        if (advanced) continue;
        state.set(frame.id, "done");
        ordered.push(byId.get(frame.id));
        stack.pop();
      }
    });
    return ordered;
  }

  var roots = (options.roots || []).map(buildRoot).filter(Boolean);

  /**
   * D46: FULL Direct PIX keeps formal ComponentSet metadata complete, but
   * transports only the definition dependency closure demanded by the current
   * file/root. The source state-group remains authoritative for:
   *   - set identity and exact set name;
   *   - full source member count and coordinate catalog;
   *   - each transported member's canonical variant coordinate.
   *
   * This deliberately does NOT pull unused sibling variants into the job.
   * Figma supports `combineAsVariants()` with any non-empty component list, so
   * even one demanded member can still be materialized under a real
   * ComponentSet carrying the source set name. Additional demanded members can
   * be appended later, before their first occurrence is created.
   *
   * Full-library materialization is a separate export feature and must not be
   * coupled to ordinary file import.
   */
  var demandedVariantCounts = Object.create(null);
  var demandedVariantCoordinates = Object.create(null);
  var demandedVariantSourceCounts = Object.create(null);
  definitions.forEach(function (definition) {
    var descriptor = definition && definition.variantSet;
    if (!descriptor || !descriptor.groupId) return;
    demandedVariantCounts[descriptor.groupId] = (demandedVariantCounts[descriptor.groupId] || 0) + 1;
    demandedVariantSourceCounts[descriptor.groupId] = Math.max(
      demandedVariantSourceCounts[descriptor.groupId] || 0,
      descriptor.memberCountSource || 0
    );
    var coordinateList = demandedVariantCoordinates[descriptor.groupId] ||
      (demandedVariantCoordinates[descriptor.groupId] = []);
    var coordinate = descriptor.coordinateKey || descriptor.variantName;
    if (coordinate && coordinateList.indexOf(coordinate) < 0) coordinateList.push(coordinate);
  });
  Object.keys(demandedVariantSourceCounts).forEach(function (groupId) {
    var sourceCount = demandedVariantSourceCounts[groupId] || 0;
    var demandedCount = demandedVariantCounts[groupId] || 0;
    if (sourceCount > demandedCount) {
      stats.variantFamilyMembersDeferred += sourceCount - demandedCount;
    }
  });
  definitions.forEach(function (definition) {
    var descriptor = definition && definition.variantSet;
    if (!descriptor || !descriptor.groupId) return;
    descriptor.memberCountDemanded = demandedVariantCounts[descriptor.groupId] || 1;
    descriptor.demandedCoordinates = (demandedVariantCoordinates[descriptor.groupId] || []).slice();
  });

  // D47: when several local Pixso copies describe the same published variant,
  // process the richest dependency lineage first. This gives the receiver a
  // coherent canonical master tree instead of whichever local copy happened to
  // be discovered first. Richness is diagnostic/ordering evidence only; formal
  // family + exact coordinate remain the identity guards.
  var definitionRichnessMemo = Object.create(null);
  function definitionTransitiveRichness(definitionId, visiting) {
    if (definitionRichnessMemo[definitionId] !== undefined) return definitionRichnessMemo[definitionId];
    visiting = visiting || Object.create(null);
    if (visiting[definitionId]) return 0;
    visiting[definitionId] = true;
    var definition = definitions.get(definitionId);
    if (!definition) return 0;
    var score = Array.isArray(definition.nodes) ? definition.nodes.length : 0;
    var needs = definitionDependencies.get(definitionId) || [];
    for (var ri = 0; ri < needs.length; ri++) {
      score += definitionTransitiveRichness(needs[ri], visiting);
    }
    delete visiting[definitionId];
    definitionRichnessMemo[definitionId] = score;
    return score;
  }
  var definitionsForOrdering = Array.from(definitions.values());
  definitionsForOrdering.forEach(function (definition) {
    var score = definitionTransitiveRichness(definition.definitionId);
    definition.canonicalRichness = score;
    if (definition.variantSet) definition.variantSet.canonicalRichness = score;
  });
  definitionsForOrdering.sort(function (left, right) {
    var ls = left && left.variantSet && left.variantSet.stableFamilyKey || "";
    var rs = right && right.variantSet && right.variantSet.stableFamilyKey || "";
    var lc = left && left.variantSet && left.variantSet.coordinateKey || "";
    var rc = right && right.variantSet && right.variantSet.coordinateKey || "";
    if (ls && ls === rs && lc && lc === rc) {
      var delta = (right.canonicalRichness || 0) - (left.canonicalRichness || 0);
      if (delta) return delta;
    }
    return 0;
  });
  var orderedDefinitions = sortDefinitionsByDependency(definitionsForOrdering);
  roots.forEach(function (root) { enforceOverrideContexts(root.nodes); });
  orderedDefinitions.forEach(function (definition) { enforceOverrideContexts(definition.nodes); });
  // Смешанный Hug разбирается раньше текстового цикла: растянутый текст,
  // переведённый в нерастянутый, текстовым циклом Hug+Fill уже не является.
  roots.forEach(function (root) {
    Expressibility.annotateMixedHugStretch(root.nodes, expressibilityPolicy, expressibility);
  });
  orderedDefinitions.forEach(function (definition) {
    Expressibility.annotateMixedHugStretch(definition.nodes, expressibilityPolicy, expressibility);
  });
  roots.forEach(function (root) {
    Expressibility.annotateTextHugFillCycles(root.nodes, expressibilityPolicy, expressibility);
  });
  orderedDefinitions.forEach(function (definition) {
    Expressibility.annotateTextHugFillCycles(definition.nodes, expressibilityPolicy, expressibility);
  });
  roots.forEach(function (root) {
    Expressibility.annotateWhitespaceAutoWidth(root.nodes, expressibilityPolicy, expressibility);
  });
  orderedDefinitions.forEach(function (definition) {
    Expressibility.annotateWhitespaceAutoWidth(definition.nodes, expressibilityPolicy, expressibility);
  });
  timings.irBuildMs = Date.now() - startedAt;
  // Единственная точка фиксации: до сюда сборка могла упасть, и тогда общий
  // реестр обязан остаться таким, каким был.
  for (var cd = 0; cd < committedDefinitions.length; cd++) {
    knownDefinitions.add(committedDefinitions[cd]);
  }

  return {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    roots: roots,
    definitions: orderedDefinitions,
    // Описания стилей, впервые понадобившиеся в этой сборке. Повторно
    // встреченный стиль уезжает ссылкой, а не вторым описанием — ровно как
    // определение компонента и ассет.
    styles: styleRegistry.emitted(),
    assets: Array.from(assets.values()),
    stats: stats,
    expressibilityReport: expressibility.report(),
    styleReport: {
      sourceStylesByType: styleRegistry.stats.sourceStylesByType,
      sourceStyleNodesSeen: styleRegistry.stats.sourceStyleNodesSeen,
      nullReferences: styleRegistry.stats.nullReferences,
      stylesEmitted: styleRegistry.stats.stylesEmitted,
      referencesUnresolved: styleRegistry.stats.referencesUnresolved,
      unresolvedByReason: styleRegistry.stats.unresolvedByReason,
      definitionsUnsupported: styleRegistry.stats.definitionsUnsupported,
      bindingsSkipped: styleRegistry.stats.bindingsSkipped,
      bindingsSkippedByReason: styleRegistry.stats.bindingsSkippedByReason,
      nameCollisions: styleRegistry.stats.nameCollisions,
      textStyleFontSize: styleRegistry.stats.textStyleFontSize,
      nodeBindings: stats.styleBindings,
      overrideBindings: stats.styleOverrideBindings,
      samples: styleRegistry.missSamples,
    },
    unsupported: unsupported,
    unsupportedSamples: samples,
    // Группы состояний отдельным разделом: он отвечает на вопрос «сложилось
    // ли семейство вариантов в нативный набор», и отказ здесь не является
    // ни потерей визуала, ни промахом адресации.
    stateGroupReport: Object.assign(stateGroups.report(), {
      variantMembersEmitted: stats.variantMembersEmitted,
      variantFamiliesClosed: stats.variantFamiliesClosed,
      variantFamilyMembersPulled: stats.variantFamilyMembersPulled,
      variantFamilyMembersDeferred: stats.variantFamilyMembersDeferred,
    }),
    // Идентичность свойств компонента отдельным разделом: она отвечает не на
    // вопрос «дошёл ли адрес», а на вопрос «то ли это свойство».
    componentPropertyReport: {
      assignmentsTotal: stats.componentPropertyAssignmentsTotal,
      resolvedRawIdentity: stats.componentPropertyResolvedRawIdentity,
      resolvedPublicIdentity: stats.componentPropertyResolvedPublicIdentity,
      recoveredByPublicIdentity: stats.componentPropertyRecoveredByPublicIdentity,
      publicChainFollowed: stats.componentPropertyPublicChainFollowed,
      notBound: stats.componentPropertyNotBound,
      externalDef: stats.componentPropertyExternalDef,
      danglingParent: stats.componentPropertyDanglingParent,
      resolutionCycle: stats.componentPropertyResolutionCycle,
      resolutionDepthExceeded: stats.componentPropertyResolutionDepthExceeded,
      resolvedByType: stats.componentPropertyResolvedByType,
      recoveredByType: stats.componentPropertyRecoveredByType,
      unresolvedByType: stats.componentPropertyUnresolvedByType,
      registry: componentProperties ? {
        definitionsIndexed: componentProperties.stats.definitionsIndexed,
        publicDefinitions: componentProperties.stats.publicDefinitions,
        localDefinitions: componentProperties.stats.localDefinitions,
        resolutions: componentProperties.stats.resolutions,
        cacheHits: componentProperties.stats.cacheHits,
        byStatus: componentProperties.stats.byStatus,
        maxDepthSeen: componentProperties.stats.maxDepthSeen,
      } : null,
      recoveredSamples: recoveredPropertySamples,
    },
    // Происхождение полей sizing записи override отдельным разделом: оно
    // отвечает не на вопрос «дошёл ли адрес» и не «то ли это свойство», а на
    // вопрос «правка это или снимок уже действующего состояния».
    layoutProvenanceReport: {
      candidates: stats.layoutOverrideCandidates,
      explicitApplied: stats.layoutOverrideExplicitApplied,
      derivedSuppressed: stats.layoutOverrideDerivedSuppressed,
      baseEchoSuppressed: stats.layoutOverrideBaseEchoSuppressed,
      // Подмножество `derivedSuppressed`: снимок, который снял бы с оси
      // конечный ненулевой размер источника. Подавленное эхо базы сюда НЕ
      // входит: там воспроизведение не изменило бы ничего, и объявлять его
      // предотвращённым разрушением было бы приписыванием заслуги.
      destructiveSuppressed: stats.layoutOverrideDestructiveSuppressed,
      unknown: stats.layoutOverrideUnknown,
    },
    overrideResolution: overrideResolution,
    overrideResolutionSamples: overrideResolutionSamples,
    deepOverrideProvenanceSamples: deepOverrideProvenanceSamples,
    sourceSemanticReport: sourceSemanticAudit,
    // Промахи канонической идентичности отделены от промахов адресации
    // override: это разные отказы на разных этапах, и общий счётчик не
    // позволил бы понять, какой из них случился.
    canonicalResolution: canonicalMissReasons,
    canonicalResolutionSamples: canonicalMissSamples,
    timings: timings,
  };
}

function indexKeyOf(path) {
  return path.map(function (step) { return step.index; }).join(".");
}

/** Структурная подпись определения: индексные пути всех узлов плюс их типы. */
function shapeOf(indexPaths) {
  var parts = [];
  indexPaths.forEach(function (path, indexKey) {
    if (!path.length) return;
    parts.push(indexKey + ":" + path[path.length - 1].sourceType);
  });
  parts.sort();
  return parts.join("|");
}

/**
 * Снимает определения с учёта в общем реестре.
 *
 * Нужно ровно одному случаю: приёмник не подтвердил определение пригодным.
 * Пока ключ числится известным, ни один следующий корень его не приложит —
 * и все его вхождения уедут ссылкой в пустоту. Здесь снимается ТОЛЬКО
 * членство: пути, формы и привязки остаются и будут перезаписаны повторной
 * сборкой того же определения.
 */
function forgetDefinitions(registry, definitionIds) {
  if (!registry || !registry.definitions || !definitionIds) return 0;
  var removed = 0;
  var forgotten = Object.create(null);
  for (var i = 0; i < definitionIds.length; i++) {
    forgotten[String(definitionIds[i])] = true;
    if (registry.definitions.delete(definitionIds[i])) removed += 1;
  }
  return removed;
}

function createRegistry() {
  return {
    styles: StyleRegistry.createSharedState(),
    stateGroups: StateGroups.createSharedState(),
    definitions: new Set(),
    definitionPaths: new Map(),
    definitionIndexPaths: new Map(),
    definitionShapes: new Map(),
    definitionVisualLosses: new Map(),
    definitionPropertyBindings: new Map(),
    definitionDependencies: new Map(),
    declaredInternalSwaps: new Map(),
    assets: new Set(),
    // D53. Востребованный состав семейств вариантов на весь job. Заполняет
    // отправитель до первой отправки; пусто — прежнее поведение.
    familyDemand: new Map(),
  };
}

/**
 * D53. Спрос на участников групп состояний по набору корней.
 *
 * Возвращает `groupId -> [ключи SYMBOL]` — ровно те участники, которые
 * понадобятся этим корням, и ни одного сверх. Обход тот же, что и у сборки
 * IR: от инстансов корня к их символам и далее внутрь символов.
 */
function collectFamilyDemand(doc, rootRecords, options) {
  var stateGroups = StateGroups.createRegistry(doc, {
    sampleLimit: 0,
    shared: options && options.registry ? options.registry.stateGroups : undefined,
  });
  var resolve = doc.symbols.resolveSymbol;
  var seen = new Set();
  var queue = [];
  var demand = new Map();

  function walk(node) {
    var stack = [node];
    while (stack.length) {
      var current = stack.pop();
      if (current.type === "INSTANCE") {
        var resolved = resolve(current);
        if (resolved.symbol && !seen.has(resolved.symbol.key)) {
          seen.add(resolved.symbol.key);
          queue.push(resolved.symbol);
        }
      }
      var children = current.children || [];
      for (var i = 0; i < children.length; i++) stack.push(children[i]);
    }
  }

  for (var r = 0; r < (rootRecords || []).length; r++) walk(rootRecords[r]);
  for (var q = 0; q < queue.length; q++) {
    walk(queue[q]);
    var member = stateGroups.memberOf(queue[q]);
    if (!member || !member.groupId) continue;
    var list = demand.get(member.groupId);
    if (!list) { list = []; demand.set(member.groupId, list); }
    if (list.indexOf(queue[q].key) < 0) list.push(queue[q].key);
  }
  return demand;
}

module.exports = {
  PROTOCOL: PROTOCOL,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  IR_UNSUPPORTED: IR_UNSUPPORTED,
  OVERRIDE_RESOLUTION: OVERRIDE_RESOLUTION,
  OVERRIDE_FIELDS: OVERRIDE_FIELDS,
  OVERRIDE_IGNORED: OVERRIDE_IGNORED,
  OVERRIDE_DECLINED: OVERRIDE_DECLINED,
  createRegistry: createRegistry,
  collectFamilyDemand: collectFamilyDemand,
  forgetDefinitions: forgetDefinitions,
  build: build,
};
