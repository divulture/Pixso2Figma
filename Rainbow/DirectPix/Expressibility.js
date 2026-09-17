/**
 * Явная политика выразимости Pixso → Figma.
 *
 * На входе — нормализованная правка и фактическая карта
 * FIGMA_CAPABILITIES.md; на выходе — AS_IS / TRANSLATE / FRAMES.
 * Имена слоёв, GUID и componentKey в решениях не участвуют.
 */
"use strict";

var DECISION = { AS_IS: "AS_IS", TRANSLATE: "TRANSLATE", FRAMES: "FRAMES" };
var REASON = {
  CAPABILITY_UNMEASURED: "CAPABILITY_UNMEASURED",
  LEGACY_PATH_UNMEASURED: "LEGACY_PATH_UNMEASURED",
  // Замер есть, но показал не то поведение, на которое опирается правило:
  // путь прежний, решение за человеком (не «нужен опыт», а «нужна форма»).
  LEGACY_PATH_MEASURED_UNSUPPORTED: "LEGACY_PATH_MEASURED_UNSUPPORTED",
  ROOT_OCCURRENCE_STATE: "ROOT_OCCURRENCE_STATE",
  NESTED_OVERRIDE_SUPPORTED: "NESTED_OVERRIDE_SUPPORTED",
  NESTED_TEXT_CONTENT_PERSISTED: "NESTED_TEXT_CONTENT_PERSISTED",
  NESTED_TEXT_AUTORESIZE_PERSISTED: "NESTED_TEXT_AUTORESIZE_PERSISTED",
  NESTED_FILL_PERSISTED: "NESTED_FILL_PERSISTED",
  SECOND_LEVEL_NESTED_FILL_PERSISTED: "SECOND_LEVEL_NESTED_FILL_PERSISTED",
  NESTED_INSTANCE_SWAP_FILL_PERSISTED: "NESTED_INSTANCE_SWAP_FILL_PERSISTED",
  NATIVE_PROPERTY_FILL_PERSISTED: "NATIVE_PROPERTY_FILL_PERSISTED",
  NESTED_FIXED_SIZE_REPRESENTED_AS_FILL: "NESTED_FIXED_SIZE_REPRESENTED_AS_FILL",
  TEXT_HUG_FILL_REPRESENTED_AS_FIXED: "TEXT_HUG_FILL_REPRESENTED_AS_FIXED",
  NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE: "NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE",
  NESTED_FIXED_TEXT_BOX_UNREPRESENTABLE: "NESTED_FIXED_TEXT_BOX_UNREPRESENTABLE",
  SOURCE_BOX_DIAGNOSTIC_ONLY: "SOURCE_BOX_DIAGNOSTIC_ONLY",
  TEXT_AUTO_WIDTH_WHITESPACE_UNREPRESENTABLE: "TEXT_AUTO_WIDTH_WHITESPACE_UNREPRESENTABLE",
  TEXT_TRAILING_SPACE_AS_NBSP: "TEXT_TRAILING_SPACE_AS_NBSP",
  STRETCH_IN_MIXED_HUG_AS_FIXED: "STRETCH_IN_MIXED_HUG_AS_FIXED",
};

function parseVerdicts(markdown) {
  var out = Object.create(null);
  String(markdown || "").replace(/^\| `([a-z0-9-]+)` \| .*? \| \*\*([A-Z_]+)\*\*/gm,
    function (_m, id, verdict) { out[id] = verdict; return _m; });
  return out;
}

function make(kind, reason, className, evidence, translation, fallback, requiresProbe) {
  var out = { decision: kind, reason: reason, class: className, evidence: evidence || [] };
  if (translation) out.translation = translation;
  if (fallback) out.fallback = fallback;
  if (requiresProbe) out.requiresProbe = true;
  return out;
}

function createLedger(sampleLimit) {
  var counts = Object.create(null), seen = Object.create(null), samples = [];
  var limit = Math.max(0, Number(sampleLimit) || 40), requiresProbe = 0;
  function record(editId, verdict, sourceId) {
    if (!verdict || !DECISION[verdict.decision]) throw new Error("Неизвестное expressibility-решение");
    var unique = String(editId || sourceId || "") + "\u001e" + verdict.class + "\u001e" + verdict.reason;
    if (seen[unique]) return verdict;
    seen[unique] = true;
    var key = [verdict.class, verdict.decision, verdict.reason].join("\u001f");
    counts[key] = (counts[key] || 0) + 1;
    if (verdict.requiresProbe === true) requiresProbe += 1;
    if (sourceId && samples.length < limit) samples.push({ sourceId: sourceId,
      class: verdict.class, decision: verdict.decision, reason: verdict.reason });
    return verdict;
  }
  function report() {
    var table = Object.keys(counts).sort().map(function (key) {
      var parts = key.split("\u001f");
      return { class: parts[0], decision: parts[1], reason: parts[2], count: counts[key] };
    });
    var totals = { AS_IS: 0, TRANSLATE: 0, FRAMES: 0 };
    table.forEach(function (row) { totals[row.decision] += row.count; });
    return { totals: totals, requiresProbe: requiresProbe,
      // Compatibility alias for existing report readers. It counts missing
      // evidence, never a request to change the migration path.
      unmeasured: requiresProbe, table: table, samples: samples.slice() };
  }
  return { record: record, report: report };
}

/**
 * Low-level правка слоя → опыт probe v11, доказывающий, что Figma её держит.
 * Подмену доказывает `swap` (probe v12), а не `nested-swap-width`: тот мерит
 * размер после подмены (он сохраняется прежним), а не саму подмену.
 * `constraints` Figma у слоя инстанса переопределить не даёт (ошибка API
 * «vertical-constraint cannot be overridden»), но ERROR в карте — не вердикт.
 */
var LOW_LEVEL_OP_EXPERIMENTS = {
  visible: "visible",
  fills: "fills",
  fillStyleId: "fill-style",
  name: "name",
  textStyle: "text-style",
  textStyleId: "text-style-id",
  layout: "layout",
  strokes: "strokes",
  strokeWeight: "strokes",
  corners: "corners",
  opacity: "opacity",
  clipsContent: "clips-off",
  effects: "effects",
  constraints: "constraints",
  locked: "locked",
  swapDefinitionId: "swap",
  strokeStyleId: "stroke-style-id",
  strokeStyle: "stroke-props",
  effectStyleId: "effect-style-id",
  aspectRatioLocked: "aspect-lock",
};

/**
 * Размер слоя инстанса измерен раньше, одним уровнем: запись размера и
 * min/max Figma игнорирует (`nested-frame-resize`, `nested-frame-min-max`).
 * Второй уровень не проще первого, поэтому доказательство общее.
 */
var LOW_LEVEL_OP_SHARED_EXPERIMENTS = {
  size: "nested-frame-resize",
  sizeBounds: "nested-frame-min-max",
};

function createPolicy(options) {
  var verdicts = options && options.verdicts || Object.create(null);
  function admit(wanted, result, legacyDecision) {
    var evidence = Object.keys(wanted).map(function (id) {
      return { id: id, expected: wanted[id], actual: verdicts[id] || null };
    });
    if (evidence.every(function (item) { return item.actual === item.expected; })) {
      result.evidence = evidence;
      return result;
    }
    // Missing evidence is not evidence of impossibility. Keep the exact
    // legacy decision (AS_IS or an already-existing translation), expose the
    // gap in the report, and let a later probe replace this temporary reason.
    var decision = legacyDecision || DECISION.AS_IS;
    var measured = evidence.every(function (item) { return item.actual !== null; });
    if (measured) {
      return make(decision, REASON.LEGACY_PATH_MEASURED_UNSUPPORTED,
        result.class, evidence,
        decision === DECISION.TRANSLATE ? result.translation || null : null,
        decision === DECISION.FRAMES ? result.fallback || null : "LEGACY_NATIVE_PATH");
    }
    return make(decision, REASON.LEGACY_PATH_UNMEASURED,
      result.class, evidence,
      decision === DECISION.TRANSLATE ? result.translation || null : null,
      decision === DECISION.FRAMES ? result.fallback || null : "LEGACY_NATIVE_PATH", true);
  }

  function fixedHugAsFill() {
    return admit({ "fixed-root-fill-child": "PERSISTED",
      "pixso-order-hug-then-inherit": "LOST_ON_RECOMPUTE",
      "pixso-order-inherit-then-hug": "LOST_ON_RECOMPUTE" },
    make(DECISION.TRANSLATE, REASON.NESTED_FIXED_SIZE_REPRESENTED_AS_FILL,
      "FIXED_HUG_LAYOUT", [], "FIXED_ROOT_FILL_CHILD"), DECISION.TRANSLATE);
  }
  function nativeProperty() {
    return admit({ "set-properties-keeps-fill": "PERSISTED" },
      make(DECISION.AS_IS, REASON.NATIVE_PROPERTY_FILL_PERSISTED,
        "NATIVE_COMPONENT_PROPERTY", []));
  }
  function classifyOp(entry, op, context) {
    var ops = entry && entry.ops || {}, path = entry && entry.path || [];
    var className = !path.length ? "ROOT_OCCURRENCE_OVERRIDE" : "NESTED_LOW_LEVEL_OVERRIDE";
    if (op === "textBoxWidth") return admit({ "nested-text-fixed-width-resize": "IGNORED" },
      make(DECISION.FRAMES, REASON.NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE,
        "NESTED_TEXT_FIXED_WIDTH", []), DECISION.FRAMES);
    if (!path.length) return admit({ "root-resize-stretch-child": "PERSISTED" },
      make(DECISION.AS_IS, REASON.ROOT_OCCURRENCE_STATE, className, []));
    if (op === "characters") {
      if (typeof ops.characters === "string" && / $/.test(ops.characters) &&
          context && context.textAutoResize === "WIDTH_AND_HEIGHT") {
        return trailingSpaces();
      }
      return admit({ "nested-text-characters-hug": "PERSISTED" },
        make(DECISION.AS_IS, REASON.NESTED_TEXT_CONTENT_PERSISTED, "NESTED_TEXT_CONTENT", []));
    }
    if (op === "textAutoResize") return admit({ "nested-text-autoresize-change": "PERSISTED" },
      make(DECISION.AS_IS, REASON.NESTED_TEXT_AUTORESIZE_PERSISTED,
        "NESTED_TEXT_AUTORESIZE", []));
    if (op === "childLayout" && context && context.secondLevelFill) {
      return admit({ "second-level-nested-fill": "PERSISTED" },
        make(DECISION.AS_IS, REASON.SECOND_LEVEL_NESTED_FILL_PERSISTED,
          "NESTED_INSTANCE_DESCENDANT_OVERRIDE", []));
    }
    if (op === "childLayout") return admit({ "nested-sizing-fill": "PERSISTED" },
      make(DECISION.AS_IS, REASON.NESTED_FILL_PERSISTED, "NESTED_LAYOUT_OVERRIDE", []));
    if (op === "swapDefinitionId" && ops.childLayout) {
      return admit({ "swap-keeps-fill": "PERSISTED" },
        make(DECISION.AS_IS, REASON.NESTED_INSTANCE_SWAP_FILL_PERSISTED,
          "NESTED_INSTANCE_OVERRIDE", []));
    }
    // Правки слоя инстанса, измеренные опытами probe v11
    // (`nested-<опыт>` — слой инстанса, `deep-<опыт>` — второй уровень).
    var sharedExperiment = LOW_LEVEL_OP_SHARED_EXPERIMENTS[op];
    if (sharedExperiment) {
      var sharedWanted = {};
      sharedWanted[sharedExperiment] = "PERSISTED";
      return admit(sharedWanted, make(DECISION.AS_IS, REASON.NESTED_OVERRIDE_SUPPORTED, className, []));
    }
    var measuredOp = LOW_LEVEL_OP_EXPERIMENTS[op];
    if (measuredOp) {
      var experimentId = (path.length > 1 ? "deep-" : "nested-") + measuredOp;
      var wanted = {};
      wanted[experimentId] = "PERSISTED";
      return admit(wanted, make(DECISION.AS_IS, REASON.NESTED_OVERRIDE_SUPPORTED, className, []));
    }
    // До появления policy эти операции шли в тот же low-level replay.
    // Неизмеренность помечает долг по probe, но не меняет
    // нативный путь и не включает visual fallback.
    return make(DECISION.AS_IS, REASON.LEGACY_PATH_UNMEASURED,
      className, [], null, "LEGACY_NATIVE_PATH", true);
  }
  function classifyOverride(entry, context) {
    return Object.keys(entry && entry.ops || {}).sort().map(function (op) {
      var out = classifyOp(entry, op, context || {}); out.op = op; return out;
    });
  }
  function sourceBox(box, targetType, masterSize, context) {
    // This record is an observation of the already-resolved occurrence, not
    // a requested edit. Figma ignoring a nested resize is relevant to an
    // explicit `textBoxWidth` operation, but must not turn every differing
    // diagnostic box into a new visual-loss/fallback trigger.
    return make(DECISION.AS_IS, REASON.SOURCE_BOX_DIAGNOSTIC_ONLY,
      "SOURCE_BOX_AUDIT", [], null, "DIAGNOSTIC_ONLY");
  }
  /**
   * Конечные пробелы текста с авто-шириной. Pixso даёт пробелу ширину (Label
   * « » — 4 px), Figma конечные пробелы в ширину не включает
   * (`text-single-space-width`, `text-trailing-space-width`), а неразрывный
   * пробел включает (`text-nbsp-width`: 4 px). Равнозначная форма —
   * неразрывные пробелы вместо конечных обычных.
   */
  function trailingSpaces() {
    return admit({ "text-single-space-width": "IGNORED", "text-trailing-space-width": "IGNORED",
      "text-nbsp-width": "PERSISTED" },
    make(DECISION.TRANSLATE, REASON.TEXT_TRAILING_SPACE_AS_NBSP,
      "TEXT_AUTO_WIDTH_WHITESPACE", [], "TRAILING_SPACE_AS_NBSP"), DECISION.AS_IS);
  }

  function textHugFill() {
    return admit({ "built-hug-counter-over-stretch-text": "IGNORED" },
      make(DECISION.TRANSLATE, REASON.TEXT_HUG_FILL_REPRESENTED_AS_FIXED,
        "TEXT_HUG_FILL_CYCLE", [], "FIXED_TEXT_AXIS"), DECISION.TRANSLATE);
  }
  /**
   * Hug по контр-оси, где растянут не каждый ребёнок. Pixso обнимает всех,
   * включая растянутых; Figma — только нерастянутых, и растянутые садятся на
   * их размер (`built-hug-counter-over-stretch-mixed`, с пересчётом — тоже
   * IGNORED: 380 → 105). Тот же узел без растягивания держит размер
   * (`…-mixed-inherit`, с пересчётом — PERSISTED). Равнозначная форма —
   * растянутый ребёнок без растягивания, со своим размером из Pixso.
   */
  /**
   * Растянуты ВСЕ дети, и у них есть содержимое уже контейнера. Пустые
   * растянутые прямоугольники Figma держит (`built-hug-counter-over-stretch`),
   * а содержимое после пересчёта она обнимает — перевод только по замеру
   * `…-stretch-content-relayout`; без него путь прежний.
   */
  function allStretchHug() {
    return admit({
      "built-hug-counter-over-stretch-content-relayout": "IGNORED",
      "built-hug-counter-over-stretch-content-inherit-relayout": "PERSISTED",
    }, make(DECISION.TRANSLATE, REASON.STRETCH_IN_MIXED_HUG_AS_FIXED,
      "HUG_ALL_STRETCH_CYCLE", [], "STRETCH_CHILD_AS_FIXED"), DECISION.AS_IS);
  }
  function mixedHugStretch() {
    return admit({
      "built-hug-counter-over-stretch-mixed": "IGNORED",
      "built-hug-counter-over-stretch-mixed-relayout": "IGNORED",
      "built-hug-counter-over-stretch-mixed-inherit": "PERSISTED",
      "built-hug-counter-over-stretch-mixed-inherit-relayout": "PERSISTED",
    }, make(DECISION.TRANSLATE, REASON.STRETCH_IN_MIXED_HUG_AS_FIXED,
      "HUG_MIXED_STRETCH_CYCLE", [], "STRETCH_CHILD_AS_FIXED"), DECISION.AS_IS);
  }
  return { classifyOverride: classifyOverride, fixedHugAsFill: fixedHugAsFill,
    trailingSpaces: trailingSpaces, mixedHugStretch: mixedHugStretch, allStretchHug: allStretchHug,
    nativeProperty: nativeProperty, sourceBox: sourceBox, textHugFill: textHugFill };
}

/**
 * Семантика до модуля решений. Нужна как контрольный oracle:
 * low-level replay не фильтровался policy, fixed-Hug уже переводился,
 * sourceBoxes были данными аудита, а TEXT Hug+Fill исполнялся Receiver-ом.
 * Это не второй production-policy: build принимает его только
 * инъекцией для regression-доказательства.
 */
function createLegacyPolicy() {
  function asIs(className) {
    return make(DECISION.AS_IS, "LEGACY_NATIVE_PATH", className, []);
  }
  return {
    classifyOverride: function (entry) {
      var path = entry && entry.path || [];
      var className = path.length ? "NESTED_LOW_LEVEL_OVERRIDE" : "ROOT_OCCURRENCE_OVERRIDE";
      return Object.keys(entry && entry.ops || {}).sort().map(function (op) {
        var out = asIs(className); out.op = op; return out;
      });
    },
    fixedHugAsFill: function () {
      return make(DECISION.TRANSLATE, "LEGACY_FIXED_HUG_TRANSLATION",
        "FIXED_HUG_LAYOUT", [], "FIXED_ROOT_FILL_CHILD");
    },
    nativeProperty: function () { return asIs("NATIVE_COMPONENT_PROPERTY"); },
    sourceBox: function () {
      return make(DECISION.AS_IS, "LEGACY_SOURCE_BOX_AUDIT",
        "SOURCE_BOX_AUDIT", [], null, "DIAGNOSTIC_ONLY");
    },
    mixedHugStretch: function () { return asIs("HUG_MIXED_STRETCH_CYCLE"); },
    allStretchHug: function () { return asIs("HUG_ALL_STRETCH_CYCLE"); },
    textHugFill: function () {
      return make(DECISION.TRANSLATE, "LEGACY_RECEIVER_TEXT_HUG_FILL",
        "TEXT_HUG_FILL_CYCLE", [], "FIXED_TEXT_AXIS");
    },
  };
}

function fallbackDecision(reasons) {
  return make(DECISION.FRAMES, Object.keys(reasons || {}).sort()[0] || "OCCURRENCE_STATE_UNREPRESENTABLE",
    "OCCURRENCE_VISUAL_FALLBACK", []);
}

function annotateTextHugFillCycles(nodes, policy, ledger) {
  var byId = Object.create(null);
  (nodes || []).forEach(function (node) { if (node && node.id) byId[node.id] = node; });
  (nodes || []).forEach(function (node) {
    if (!node || node.type !== "TEXT" || !node.parent || !node.childLayout || !node.text ||
        node.text.textAutoResize !== "HEIGHT" || node.childLayout.layoutPositioning === "ABSOLUTE") return;
    var parent = byId[node.parent], layout = parent && parent.autoLayout;
    if (!layout || (layout.layoutMode !== "HORIZONTAL" && layout.layoutMode !== "VERTICAL")) return;
    var horizontal = layout.layoutMode === "HORIZONTAL", axes = { width: false, height: false };
    if (layout.primaryAxisSizingMode === "AUTO" && node.childLayout.layoutGrow > 0)
      axes[horizontal ? "width" : "height"] = true;
    if (layout.counterAxisSizingMode === "AUTO" && node.childLayout.layoutAlign === "STRETCH")
      axes[horizontal ? "height" : "width"] = true;
    if (!axes.width && !axes.height) return;
    var out = policy.textHugFill();
    node.expressibility = [out];
    if (out.decision === DECISION.TRANSLATE) node.figmaTranslation = { fixedAxes: axes };
    if (ledger) ledger.record("node:" + node.id + ":TEXT_HUG_FILL", out, node.id);
  });
}

var MIXED_HUG_EPSILON = 0.5;

/** Какую ось ребёнка отдаёт родителю его слот раскладки: `width`, `height` или обе. */
function parentOwnedAxes(node, parent) {
  var out = { width: false, height: false };
  var layout = parent && parent.autoLayout;
  var slot = node && node.childLayout;
  if (!layout || !slot || slot.layoutPositioning === "ABSOLUTE") return out;
  var horizontal = layout.layoutMode === "HORIZONTAL";
  if (layout.layoutMode !== "HORIZONTAL" && layout.layoutMode !== "VERTICAL") return out;
  if (slot.layoutGrow > 0) out[horizontal ? "width" : "height"] = true;
  if (slot.layoutAlign === "STRETCH") out[horizontal ? "height" : "width"] = true;
  return out;
}

/**
 * Форма `STRETCH_CHILD_AS_FIXED` для Hug-контейнера со смешанными детьми по
 * контр-оси. Переводится только то, что доказано данными Pixso:
 *   - контейнер сам обнимает эту ось (не получает её от своего родителя);
 *   - в потоке есть и растянутые, и нерастянутые дети;
 *   - Pixso-размер контейнера больше, чем дали бы одни нерастянутые, —
 *     иначе Figma и так получит тот же размер, переводить нечего;
 *   - каждый растянутый ребёнок в Pixso ровно равен внутренней оси
 *     контейнера — растягивание там ничего не меняет.
 * Не доказано — узел остаётся как есть (fail-closed), решение считается.
 */
function annotateMixedHugStretch(nodes, policy, ledger) {
  if (!policy.mixedHugStretch) return;
  var byId = Object.create(null), children = Object.create(null);
  (nodes || []).forEach(function (node) {
    if (!node || !node.id) return;
    byId[node.id] = node;
    if (node.parent) (children[node.parent] = children[node.parent] || []).push(node);
  });
  (nodes || []).forEach(function (container) {
    var layout = container && container.autoLayout;
    if (!layout || layout.counterAxisSizingMode !== "AUTO" ||
        (layout.layoutMode !== "HORIZONTAL" && layout.layoutMode !== "VERTICAL")) return;
    var horizontal = layout.layoutMode === "HORIZONTAL";
    var cross = horizontal ? "height" : "width";
    if (parentOwnedAxes(container, byId[container.parent])[cross]) return;
    var flow = (children[container.id] || []).filter(function (child) {
      return child.visible !== false && !(child.childLayout && child.childLayout.layoutPositioning === "ABSOLUTE");
    });
    var stretched = flow.filter(function (child) { return child.childLayout && child.childLayout.layoutAlign === "STRETCH"; });
    var fixed = flow.filter(function (child) { return stretched.indexOf(child) < 0; });
    if (!stretched.length || typeof container[cross] !== "number") return;
    // Все растянуты: переводим только когда у растянутых есть своё содержимое,
    // которое Figma станет обнимать (замер `…-stretch-content-relayout`).
    // Пустые растянутые узлы Figma держит — там узел остаётся как есть.
    var allStretched = !fixed.length;
    if (allStretched && !stretched.some(function (child) { return (children[child.id] || []).length > 0; })) return;
    var pad = horizontal ? (layout.paddingTop || 0) + (layout.paddingBottom || 0)
      : (layout.paddingLeft || 0) + (layout.paddingRight || 0);
    var inner = container[cross] - pad;
    var fixedMax = 0;
    for (var f = 0; f < fixed.length; f++) {
      if (typeof fixed[f][cross] !== "number") return;
      fixedMax = Math.max(fixedMax, fixed[f][cross]);
    }
    if (inner <= fixedMax + MIXED_HUG_EPSILON) return;
    var proven = stretched.every(function (child) {
      return typeof child[cross] === "number" && Math.abs(child[cross] - inner) <= MIXED_HUG_EPSILON;
    });
    var className = allStretched ? "HUG_ALL_STRETCH_CYCLE" : "HUG_MIXED_STRETCH_CYCLE";
    var out = !proven ? make(DECISION.AS_IS, "MIXED_HUG_STRETCH_SIZE_UNPROVEN", className, [])
      : allStretched ? (policy.allStretchHug ? policy.allStretchHug() : make(DECISION.AS_IS, "LEGACY_NATIVE_PATH", className, []))
      : policy.mixedHugStretch();
    stretched.forEach(function (child) {
      child.expressibility = (child.expressibility || []).concat([out]);
      if (ledger) ledger.record("node:" + child.id + ":MIXED_HUG_STRETCH", out, child.id);
      if (out.translation !== "STRETCH_CHILD_AS_FIXED") return;
      var original = { layoutAlign: child.childLayout.layoutAlign };
      child.childLayout.layoutAlign = "INHERIT";
      // Своя ось ребёнка по этой стороне обязана держать размер Pixso, а не
      // обнимать собственное содержимое.
      var own = child.autoLayout;
      if (own && (own.layoutMode === "HORIZONTAL" || own.layoutMode === "VERTICAL")) {
        var key = (own.layoutMode === "HORIZONTAL") === (cross === "width")
          ? "primaryAxisSizingMode" : "counterAxisSizingMode";
        if (own[key] === "AUTO") { original[key] = "AUTO"; own[key] = "FIXED"; }
      }
      if (child.type === "TEXT" && child.text) {
        var resize = child.text.textAutoResize;
        var next = cross === "width"
          ? (resize === "WIDTH_AND_HEIGHT" ? "HEIGHT" : resize)
          : (resize === "WIDTH_AND_HEIGHT" || resize === "HEIGHT" ? "NONE" : resize);
        if (next !== resize) { original.textAutoResize = resize; child.text.textAutoResize = next; }
      }
      child.figmaTranslation = child.figmaTranslation || {};
      child.figmaTranslation.stretchChildAsFixed = { axis: cross, original: original };
    });
  });
}

/** Конечные обычные пробелы → неразрывные (форма `TRAILING_SPACE_AS_NBSP`). */
function trailingSpacesAsNbsp(text) {
  return String(text).replace(/ +$/, function (spaces) { return spaces.replace(/ /g, "\u00a0"); });
}

function annotateWhitespaceAutoWidth(nodes, policy, ledger) {
  (nodes || []).forEach(function (node) {
    if (!node || node.type !== "TEXT" || !node.text ||
        node.text.textAutoResize !== "WIDTH_AND_HEIGHT" ||
        typeof node.text.characters !== "string" || !/ $/.test(node.text.characters)) return;
    var out = policy.trailingSpaces ? policy.trailingSpaces()
      : policy.classifyOverride({ path: [{ index: 0 }], ops: { characters: node.text.characters } },
        { textAutoResize: "WIDTH_AND_HEIGHT" })[0];
    node.expressibility = [out];
    if (out.translation === "TRAILING_SPACE_AS_NBSP") node.text.characters = trailingSpacesAsNbsp(node.text.characters);
    if (ledger) ledger.record("node:" + node.id + ":characters", out, node.id);
  });
}

module.exports = { DECISION: DECISION, REASON: REASON, parseVerdicts: parseVerdicts,
  createLedger: createLedger, createPolicy: createPolicy, createLegacyPolicy: createLegacyPolicy,
  fallbackDecision: fallbackDecision,
  annotateTextHugFillCycles: annotateTextHugFillCycles,
  annotateMixedHugStretch: annotateMixedHugStretch,
  annotateWhitespaceAutoWidth: annotateWhitespaceAutoWidth,
  trailingSpacesAsNbsp: trailingSpacesAsNbsp };
