/**
 * Direct PIX: приём миграции на стороне Figma.
 *
 *   node FigmaImporter/Tests/DirectPixReceiverTest.js
 *
 * Проверяет главное утверждение эксперимента и его изоляцию:
 *   — определение компонента создаётся один раз на job и переиспользуется;
 *   — вхождение становится нативным инстансом через createInstance(), а не
 *     развёрнутой копией поддерева;
 *   — поддерживаемая дельта применяется, неподдерживаемая считается;
 *   — Direct-задача не читает и не пишет состояние Fast/Full, не трогает их
 *     служебные страницы, а её отказ не мешает следующей обычной миграции.
 *
 * Фейковый Figma-хост реализует ровно те методы, которые вызывает приёмник:
 * лишний вызов обязан упасть, а не молча пройти.
 */
"use strict";

var assert = require("assert");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

// ---------------------------------------------------------------------------
// Фейковый Figma
// ---------------------------------------------------------------------------

var calls = null;
var pages = null;
var nodeSeq = 0;

/**
 * Инстанс хоста. `mainComponent` — свойство с getter-ом, потому что под
 * `documentAccess: "dynamic-page"` настоящая Figma на СИНХРОННОМ чтении этого
 * поля бросает. Флаг воспроизводит именно это: код, который выводит активное
 * определение через `mainComponent`, обязан в таком режиме перестать работать,
 * а не тихо получать null и выключать свою проверку.
 */
function attachMainComponent(node, component) {
  var current = component;
  Object.defineProperty(node, "mainComponent", {
    configurable: true,
    get: function () {
      if (globalThis.figma && globalThis.figma.__dynamicPageMainComponent) {
        throw new Error("mainComponent недоступен под documentAccess: dynamic-page");
      }
      return current;
    },
    set: function (value) {
      current = value;
      // Figma's direct `mainComponent = ...` is a clean nested-instance
      // swap: it clears old overrides and reflects the new master subtree.
      // Model that here so Direct PIX low-level swap tests can distinguish it
      // from swapComponent()'s override-preservation heuristics.
      if (node.type === "INSTANCE" && value && Array.isArray(value.children)) {
        while (node.children && node.children.length) node.children[0].remove();
        for (var i = 0; i < value.children.length; i++) node.appendChild(value.children[i].clone());
        node.width = value.width;
        node.height = value.height;
      }
    },
  });
  node.getMainComponentAsync = function () { return Promise.resolve(current); };
}

function makeStubNode(type, withChildren) {
  var node = {
    id: "n" + (nodeSeq += 1),
    type: type,
    name: "",
    removed: false,
    parent: null,
    children: [],
    pluginData: {},
    width: 10,
    height: 10,
    fills: undefined,
    setPluginData: function (key, value) { this.pluginData[key] = String(value); },
    getPluginData: function (key) {
      // Подслои инстанса в Figma отдают plugin data не в любом контексте.
      // Флаг воспроизводит именно это, не трогая запись.
      if (globalThis.figma && globalThis.figma.__blindPluginData &&
          key === "pixsoDirectSourceId") return "";
      return this.pluginData[key] || "";
    },
    resizeWithoutConstraints: function (w, h) {
      this.width = w; this.height = h;
      // Live Figma can rematerialize occurrence descendants during a later
      // resize/layout reconciliation. Test-only hook for D59: simulate a deep
      // Text override being reset AFTER it was successfully applied.
      if (globalThis.figma && globalThis.figma.__resetDescendantTextOnResize && this.type === "INSTANCE") {
        var stack = (this.children || []).slice();
        while (stack.length) {
          var child = stack.pop();
          if (child.type === "TEXT") {
            child.characters = "stale text";
            if (globalThis.figma.__resetDescendantTextOverflowOnResize) {
              child.textTruncation = "DISABLED";
              child.maxLines = null;
            }
          }
          (child.children || []).forEach(function (nested) { stack.push(nested); });
        }
      }
    },
    remove: function () {
      this.removed = true;
      if (this.parent) {
        var index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
      }
    },
    clone: function () {
      var copy = makeStubNode(this.type, typeof this.appendChild === "function");
      copy.name = this.name;
      copy.width = this.width;
      copy.height = this.height;
      copy.fills = this.fills;
      copy.strokes = this.strokes;
      copy.effects = this.effects;
      copy.x = this.x;
      copy.y = this.y;
      ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
        "cornerRadius", "layoutPositioning", "layoutMode", "itemSpacing",
        "primaryAxisSizingMode", "counterAxisSizingMode", "fontSize", "textStyleId",
        "fillStyleId", "visible", "opacity", "blendMode", "textAutoResize",
        "textTruncation", "maxLines"].forEach(function (key) {
        if (node[key] !== undefined) copy[key] = node[key];
      });
      copy.pluginData = Object.assign({}, this.pluginData);
      if (this.characters !== undefined) copy.characters = this.characters;
      if (this.fontName !== undefined) copy.fontName = this.fontName;
      if (this.vectorPaths !== undefined) copy.vectorPaths = this.vectorPaths;
      if (this.type === "INSTANCE") {
        var wasDynamic = globalThis.figma && globalThis.figma.__dynamicPageMainComponent;
        if (wasDynamic) globalThis.figma.__dynamicPageMainComponent = false;
        attachMainComponent(copy, this.mainComponent);
        if (wasDynamic) globalThis.figma.__dynamicPageMainComponent = true;
        copy.resetOverrides = function () { calls.resetOverrides += 1; };
        copy.swapComponent = function (next) {
          calls.swapComponent += 1;
          var preserved = globalThis.figma && globalThis.figma.__preserveSwapOverrides
            ? copy.children.map(function (child) { return child.clone(); }) : [];
          copy.mainComponent = next;
          while (copy.children.length) copy.children[0].remove();
          for (var n = 0; n < next.children.length; n++) copy.appendChild(next.children[n].clone());
          for (var p = 0; p < preserved.length; p++) copy.appendChild(preserved[p]);
          // Настоящая Figma переводит коробку на размер нового master.
          copy.width = next.width;
          copy.height = next.height;
        };
      }
      for (var i = 0; i < this.children.length; i++) copy.appendChild(this.children[i].clone());
      return copy;
    },
  };

  // Live Figma rejects some constraint writes below a native INSTANCE.
  // The flag is opt-in so ordinary tests keep the permissive host.
  var constraintValue = undefined;
  Object.defineProperty(node, "constraints", {
    configurable: true,
    get: function () { return constraintValue; },
    set: function (value) {
      if (globalThis.figma && globalThis.figma.__rejectNestedInstanceConstraints &&
          this.type === "INSTANCE" && this.parent) {
        var ancestor = this.parent;
        while (ancestor) {
          if (ancestor.type === "INSTANCE") {
            throw new Error("constraints are immutable below instance");
          }
          ancestor = ancestor.parent;
        }
      }
      constraintValue = value;
    },
  });

  // Figma represents a child-owned FILL axis as FIXED on the child's own
  // auto-layout sizing mode. The opt-in flag reproduces the documented
  // `layoutGrow = 1` + own AUTO incompatibility used by D33 parity tests.
  var layoutGrowValue = 0;
  Object.defineProperty(node, "layoutGrow", {
    configurable: true,
    get: function () { return layoutGrowValue; },
    set: function (value) {
      layoutGrowValue = value;
      if (!(globalThis.figma && globalThis.figma.__simulateFillChildOwnAxisFixed)) return;
      if (!(value > 0) || !this.parent) return;
      var parentMode = this.parent.layoutMode;
      var ownMode = this.layoutMode;
      if (parentMode === "HORIZONTAL") {
        if (ownMode === "HORIZONTAL") this.primaryAxisSizingMode = "FIXED";
        else if (ownMode === "VERTICAL") this.counterAxisSizingMode = "FIXED";
      } else if (parentMode === "VERTICAL") {
        if (ownMode === "VERTICAL") this.primaryAxisSizingMode = "FIXED";
        else if (ownMode === "HORIZONTAL") this.counterAxisSizingMode = "FIXED";
      }
    },
  });

  // Live Figma can re-run ABSOLUTE constraints when a parent receives its
  // final semantic HUG/FILL sizing.  The opt-in test flag reproduces that
  // late mutation so the receiver must restore source placement afterwards.
  var semanticWidth = undefined;
  Object.defineProperty(node, "layoutSizingHorizontal", {
    configurable: true,
    get: function () { return semanticWidth; },
    set: function (value) {
      semanticWidth = value;
      if (!(globalThis.figma && globalThis.figma.__simulateAbsoluteConstraintDrift)) return;
      if (!(this.layoutMode === "HORIZONTAL" || this.layoutMode === "VERTICAL")) return;
      for (var d = 0; d < this.children.length; d++) {
        var child = this.children[d];
        if (child.layoutPositioning === "ABSOLUTE" && typeof child.x === "number") {
          child.x = child.x - (Number(child.width) || 1);
        }
      }
    },
  });

  if (withChildren) {
    node.appendChild = function (child) {
      if (child.parent) {
        var index = child.parent.children.indexOf(child);
        if (index >= 0) child.parent.children.splice(index, 1);
      }
      child.parent = this;
      this.children.push(child);
    };
  }
  return node;
}

function makeStubComponent() {
  var component = makeStubNode("COMPONENT", true);
  calls.createComponent += 1;
  component.createInstance = function () {
    calls.createInstance += 1;
    var instance = makeStubNode("INSTANCE", true);
    attachMainComponent(instance, component);
    instance.name = component.name;
    instance.width = component.width;
    instance.height = component.height;
    instance.fills = component.fills;
    instance.strokes = component.strokes;
    instance.effects = component.effects;
    // Инстанс наследует раскладку мастера. Без этого нельзя проверить
    // главное свойство частичной правки auto layout: она меняет только свои
    // поля и не имеет права затирать layoutMode определения.
    instance.layoutMode = component.layoutMode;
    instance.itemSpacing = component.itemSpacing;
    instance.primaryAxisSizingMode = component.primaryAxisSizingMode;
    instance.counterAxisSizingMode = component.counterAxisSizingMode;
    instance.layoutGrow = component.layoutGrow;
    instance.layoutAlign = component.layoutAlign;
    instance.resetOverrides = function () { calls.resetOverrides += 1; };
    instance.swapComponent = function (next) {
      calls.swapComponent += 1;
      var widthBeforeSwap = instance.width;
      var preserved = globalThis.figma && globalThis.figma.__preserveSwapOverrides
        ? instance.children.map(function (child) { return child.clone(); }) : [];
      instance.mainComponent = next;
      while (instance.children.length) instance.children[0].remove();
      for (var n = 0; n < next.children.length; n++) instance.appendChild(next.children[n].clone());
      for (var p = 0; p < preserved.length; p++) instance.appendChild(preserved[p]);
      // Figma swapComponent сначала принимает геометрию нового master; уже
      // importer решает, какие оси occurrence обязан вернуть.
      instance.width = next.width;
      instance.height = next.height;
      // Живая Figma после подмены ПЕРЕСЧИТЫВАЕТ HUG-ось: если вхождение уже
      // зажато по второй оси, текст внутри переносится и высота уходит вверх.
      // Измерено на настоящем файле: 32 → 252 у таба бокового меню. Флаг
      // включает эту часть поведения ровно в том тесте, который её проверяет.
      if (globalThis.figma && globalThis.figma.__rehugAfterSwap &&
          instance.counterAxisSizingMode === "AUTO" && widthBeforeSwap < next.width) {
        instance.width = widthBeforeSwap;
        instance.height = next.height * 8;
      }
    };
    for (var i = 0; i < component.children.length; i++) {
      instance.appendChild(component.children[i].clone());
    }
    return instance;
  };
  return component;
}

function makeStubPage(name) {
  var page = makeStubNode("PAGE", true);
  page.name = name;
  page.selection = [];
  page.loadAsync = function () { return Promise.resolve(); };
  pages.push(page);
  return page;
}

function resetFigma() {
  calls = {
    createComponent: 0, createInstance: 0, createFrame: 0, createText: 0,
    createVector: 0, createBooleanOperation: 0, createImage: 0, swapComponent: 0, resetOverrides: 0, createPage: 0,
  };
  pages = [];
  var first = makeStubPage("Page 1");
  global.figma = {
    mixed: Symbol("mixed"),
    root: { name: "Doc", get children() { return pages; } },
    currentPage: first,
    setCurrentPageAsync: function (page) { global.figma.currentPage = page; return Promise.resolve(); },
    createPage: function () {
      calls.createPage += 1;
      return makeStubPage("Page " + (pages.length + 1));
    },
    createFrame: function () { calls.createFrame += 1; return makeStubNode("FRAME", true); },
    createSection: function () { return makeStubNode("SECTION", true); },
    createText: function () {
      calls.createText += 1;
      var text = makeStubNode("TEXT", false);
      text.characters = "";
      text.fontName = { family: "Inter", style: "Regular" };
      return text;
    },
    createRectangle: function () { return makeStubNode("RECTANGLE", false); },
    createEllipse: function () { return makeStubNode("ELLIPSE", false); },
    createLine: function () { return makeStubNode("LINE", false); },
    createPolygon: function () { return makeStubNode("POLYGON", false); },
    createStar: function () { return makeStubNode("STAR", false); },
    createVector: function () { calls.createVector += 1; return makeStubNode("VECTOR", false); },
    createBooleanOperation: function () {
      calls.createBooleanOperation += 1;
      var node = makeStubNode("BOOLEAN_OPERATION", true);
      node.booleanOperation = "UNION";
      return node;
    },
    createComponent: makeStubComponent,
    createNodeFromSvg: function () { return makeStubNode("FRAME", true); },
    createComponentFromNode: function (source) {
      var component = makeStubComponent();
      component.width = source.width;
      component.height = source.height;
      component.name = source.name;
      while (source.children.length) component.appendChild(source.children[0]);
      if (source.parent) source.parent.appendChild(component);
      source.remove();
      return component;
    },
    combineAsVariants: function () { return makeStubNode("COMPONENT_SET", true); },
    createImage: function (bytes) {
      calls.createImage += 1;
      return { hash: "img-" + bytes.length };
    },
    loadFontAsync: function () { return Promise.resolve(); },
    viewport: { scrollAndZoomIntoView: function () {} },
    ui: { postMessage: function () {} },
    notify: function () {},
  };
}

// Модуль загружается ДО появления global.figma: иначе сработает setup().
var importer = require("../Main.js");

// Verified native INSTANCE_SWAP may move the same structural subtree to a
// different direct-child slot. The relocation helper must use only complete
// structural provenance, never names/geometry, and must fail on ambiguity.
(function verifiedSwapRelocationRegression() {
  var session = {
    definitionStructuralMaps: {
      oldDef: {
        "0": { sourceId: "old:slot", targetType: "FRAME", nestedDefinitionId: null },
        "0.0": { sourceId: "old:text", targetType: "TEXT", nestedDefinitionId: null },
      },
      newDef: {
        "0": { sourceId: "new:decor", targetType: "RECTANGLE", nestedDefinitionId: null },
        "1": { sourceId: "new:slot", targetType: "FRAME", nestedDefinitionId: null },
        "1.0": { sourceId: "new:text", targetType: "TEXT", nestedDefinitionId: null },
      },
    },
    definitionComponentKeys: {},
    definitionVariantIdentities: {},
  };
  var step = { definitionId: "oldDef", definitionPath: [0], targetType: "FRAME" };
  assert.deepStrictEqual(importer.directFindVerifiedSwapRelocation(step, "newDef", session), [1],
    "verified swap relocates one proven subtree to its unique live child slot");
  checks += 1;

  session.definitionStructuralMaps.newDef["2"] =
    { sourceId: "new:slot2", targetType: "FRAME", nestedDefinitionId: null };
  session.definitionStructuralMaps.newDef["2.0"] =
    { sourceId: "new:text2", targetType: "TEXT", nestedDefinitionId: null };
  eq(importer.directFindVerifiedSwapRelocation(step, "newDef", session), null,
    "ambiguous equal subtrees are never guessed during swap relocation");
})();
resetFigma();

(function sideStrokeParityRegression() {
  var node = makeStubNode("FRAME", true);
  node.strokeWeight = global.figma.mixed;
  node.strokeTopWeight = 0;
  node.strokeRightWeight = 0;
  node.strokeBottomWeight = 0;
  node.strokeLeftWeight = 1;
  var session = { visualParity: { counts: {}, samples: [], limit: 20 } };
  importer.directAuditVisualNode(node, {
    id: "source:side-border", kind: "ORDINARY", type: "FRAME",
    strokeWeight: 1, borderWeights: { top: 0, right: 0, bottom: 0, left: 1 },
  }, {}, session);
  eq(Object.keys(session.visualParity.counts).length, 0,
    "side-specific Pixso border does not fail parity only because aggregate strokeWeight is figma.mixed");
})();

(function strokeWeightIsOneOperationRegression() {
  // Толщина обводки живёт в Figma в двух представлениях, и раньше источник
  // слал оба: общий `strokeWeight` и четыре стороны ехали отдельными
  // операциями на одно свойство. Что победит, решал порядок ключей, а
  // readback возвращал `figma.mixed` — рамка оставалась чужой толщины.
  var inherited = makeStubNode("FRAME", true);
  inherited.strokeTopWeight = 4;
  inherited.strokeRightWeight = 4;
  inherited.strokeBottomWeight = 4;
  inherited.strokeLeftWeight = 4;
  // Цель override, унаследовавшая независимый режим: общий сеттер его не
  // снимает, поэтому толщина дублируется во второе представление.
  var reads = 0;
  Object.defineProperty(inherited, "strokeWeight", {
    get: function () { reads += 1; return global.figma.mixed; },
    set: function () {},
    configurable: true,
  });
  ok(importer.directApplyStrokeWeights(inherited, 5, undefined, true),
    "общая толщина применяется и к цели, унаследовавшей независимый режим");
  eq(inherited.strokeTopWeight, 5, "толщина дублируется в верхнюю сторону");
  eq(inherited.strokeLeftWeight, 5, "толщина дублируется в левую сторону");
  eq(reads, 0,
    "узел не читается после записи: чтение форсирует пересчёт всего документа");

  var fresh = makeStubNode("FRAME", true);
  fresh.strokeTopWeight = 1;
  ok(importer.directApplyStrokeWeights(fresh, 5, undefined),
    "свежесозданному узлу хватает одной записи общей толщины");
  eq(fresh.strokeWeight, 5, "общая толщина назначена");
  eq(fresh.strokeTopWeight, 1,
    "стороны свежего узла не переписываются: независимому режиму взяться неоткуда");

  var perSide = makeStubNode("FRAME", true);
  perSide.strokeWeight = 3;
  ok(importer.directApplyStrokeWeights(perSide, 3, { top: 0, right: 0, bottom: 1, left: 1 }),
    "per-side толщина применяется одной операцией");
  eq(perSide.strokeTopWeight, 0, "выключенная сторона остаётся выключенной");
  eq(perSide.strokeBottomWeight, 1, "включённая сторона переносится");
  eq(perSide.strokeWeight, 3,
    "стороны назначаются без второго присваивания общей толщины поверх них");
})();
resetFigma();

(function nativeSwapPropertyValueReadbackRegression() {
  var expected = makeStubComponent();
  var other = makeStubComponent();
  var occurrence = makeStubNode("INSTANCE", true);
  occurrence.componentProperties = {
    "Icon#1:2": { type: "INSTANCE_SWAP", value: expected.id },
  };
  var session = { definitions: { expectedDef: expected, otherDef: other } };
  eq(importer.directInstanceSwapPropertyDefinition(occurrence, "Icon#1:2", session), "expectedDef",
    "INSTANCE_SWAP parity maps public componentProperties value back to source definition");
  occurrence.componentProperties["Icon#1:2"].value = other.id;
  eq(importer.directInstanceSwapPropertyDefinition(occurrence, "Icon#1:2", session), "otherDef",
    "INSTANCE_SWAP readback reports a genuinely different materialized property value");
})();
resetFigma();

function pagesWithRole(role) {
  return pages.filter(function (page) { return page.getPluginData("pixso2figmaRole") === role; });
}

// ---------------------------------------------------------------------------
// Материал Direct PIX
// ---------------------------------------------------------------------------

var DIRECT = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };

function directTask(jobId, type, payload) {
  return {
    jobId: jobId,
    taskId: jobId + "-" + type + "-" + (nodeSeq += 1),
    type: "DIRECT_PIX_" + type,
    payload: Object.assign({}, DIRECT, payload || {}),
  };
}

/** Определение кнопки: корень, текст и вложенный инстанс иконки. */
function buttonDefinition() {
  return {
    definitionId: "2:31",
    componentKey: "key-button",
    variantGroupId: "2:30",
    name: "state=normal",
    nodes: [
      {
        id: "2:31", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "state=normal",
        x: 0, y: 0, width: 120, height: 40,
        fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1, blendMode: "NORMAL" }],
        corners: { cornerRadius: 8 },
        autoLayout: { layoutMode: "HORIZONTAL", itemSpacing: 8, paddingLeft: 12 },
      },
      {
        id: "2:32", parent: "2:31", kind: "ORDINARY", type: "TEXT", name: "Подпись",
        x: 12, y: 10, width: 60, height: 20,
        text: { characters: "Кнопка", fontName: { family: "Inter", style: "Regular" }, fontSize: 14 },
        childLayout: { layoutAlign: "STRETCH" },
      },
      {
        id: "2:33", parent: "2:31", kind: "INSTANCE", type: "INSTANCE", name: "Иконка",
        definitionId: "2:20", x: 80, y: 12, width: 16, height: 16,
      },
    ],
  };
}

function iconDefinition() {
  return {
    definitionId: "2:20",
    componentKey: "key-icon",
    variantGroupId: null,
    name: "Иконка",
    nodes: [
      { id: "2:20", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Иконка", x: 0, y: 0, width: 16, height: 16 },
      {
        id: "2:21", parent: "2:20", kind: "ORDINARY", type: "VECTOR", name: "Контур",
        x: 0, y: 0, width: 16, height: 16,
        vectorPaths: [{ windingRule: "NONZERO", data: "M 0 0 L 10 0 L 10 10 Z" }],
      },
    ],
  };
}

function screenNodes() {
  return [
    {
      id: "2:100", parent: null, kind: "ORDINARY", type: "FRAME", name: "Экран",
      x: 0, y: 0, width: 400, height: 300,
      autoLayout: { layoutMode: "VERTICAL", itemSpacing: 12 },
    },
    {
      id: "2:101", parent: "2:100", kind: "INSTANCE", type: "INSTANCE", name: "Кнопка",
      definitionId: "2:31", x: 16, y: 16, width: 120, height: 40,
    },
    {
      id: "2:102", parent: "2:100", kind: "INSTANCE", type: "INSTANCE", name: "Кнопка изменённая",
      definitionId: "2:31", x: 16, y: 68, width: 160, height: 40,
      overrides: [
        { path: [], ops: { fills: [{ type: "SOLID", color: { r: 0, g: 0.47, b: 1 }, opacity: 1, blendMode: "NORMAL" }] } },
        { path: [{ index: 0, name: "Подпись" }], ops: { characters: "Отправить" } },
        // Цель, которой в определении нет: обязана быть посчитана промахом.
        { path: [{ index: 7, name: "Нет такого" }], ops: { visible: false } },
      ],
    },
    {
      id: "2:103", parent: "2:100", kind: "INSTANCE", type: "INSTANCE", name: "Без определения",
      definitionId: "2:999", x: 16, y: 120, width: 40, height: 40,
    },
  ];
}

// ---------------------------------------------------------------------------
// 1. Чужой протокол и чужая версия не принимаются
// ---------------------------------------------------------------------------

async function run() {
  await assert.rejects(
    importer.handleDirectTask({ jobId: "j0", taskId: "t0", type: "DIRECT_PIX_START", payload: { protocol: "SOMETHING_ELSE" } }, {}),
    /чужой протокол/,
    "задача чужого протокола отвергается"
  );
  checks += 1;
  await assert.rejects(
    importer.handleDirectTask({ jobId: "j0", taskId: "t1", type: "DIRECT_PIX_START", payload: { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 99 } }, {}),
    /версия протокола/,
    "задача из будущей версии протокола отвергается явно"
  );
  checks += 1;

  ok(importer.isDirectTask("DIRECT_PIX_ROOT"), "задача Direct опознаётся по префиксу");
  ok(!importer.isDirectTask("ROOT_NODE"), "задача старого протокола не считается Direct");

  // -------------------------------------------------------------------------
  // 2. Полный прогон Direct PIX
  // -------------------------------------------------------------------------

  var start = await importer.handleDirectTask(directTask("jd", "START", { source: { fileName: "Файл.pix" } }), {});
  eq(start.sourceMode, "DIRECT_PIX", "приёмник подтвердил тип источника");
  eq(start.protocol, importer.DIRECT_PROTOCOL, "приёмник подтвердил протокол");

  var assets = await importer.handleDirectTask(
    directTask("jd", "ASSETS", { assets: [{ assetId: "abcdef", extension: "png", bytesBase64: "iVBORw==" }] }), {});
  eq(assets.assetsCreated, 1, "ассет создан один раз");
  eq(assets.unsupported, 0, "у задачи ассетов отчёт о потерях — приростом, а не накопленным итогом");
  eq(calls.createImage, 1, "createImage вызван ровно на новый ассет");

  // Regression: корректный raster может быть отвергнут Figma из-за host-limit
  // размера. В этом случае importer просит UI уменьшить изображение и
  // повторяет createImage, не превращая визуально восстановимый ресурс в
  // ASSET_REJECTED.
  var originalCreateImage = global.figma.createImage;
  var originalPostMessage = global.figma.ui.postMessage;
  var imageAttempt = 0;
  global.figma.createImage = function (bytes) {
    calls.createImage += 1;
    imageAttempt += 1;
    if (imageAttempt === 1) throw Error("Image is too large");
    return { hash: "img-fallback-" + bytes.length };
  };
  global.figma.ui.postMessage = function (message) {
    if (message.type !== "image-downsample-request") return;
    setTimeout(function () {
      importer.directResolveImageDownsample({
        type: "image-downsample-result", requestId: message.requestId,
        bytesBase64: "iVBORw==", width: 4096, height: 2304,
      });
    }, 0);
  };
  var largeAsset = await importer.handleDirectTask(
    directTask("jd", "ASSETS", { assets: [{ assetId: "oversized", extension: "png", bytesBase64: "iVBORw0KGgo=" }] }), {});
  eq(largeAsset.assetsCreated, 1, "отвергнутый host-ом raster восстановлен через UI fallback");
  eq(largeAsset.assetsDownsampled, 1, "fallback явно посчитан как downsampled asset");
  eq(largeAsset.unsupported, 0, "успешный downsample не считается потерянным ассетом");
  global.figma.createImage = originalCreateImage;
  global.figma.ui.postMessage = originalPostMessage;

  var componentsBefore = calls.createComponent;
  var definitions = await importer.handleDirectTask(
    directTask("jd", "DEFINITIONS", { definitions: [iconDefinition(), buttonDefinition()] }), {});
  eq(definitions.definitionsCreated, 2, "оба определения собраны");
  ok(definitions.definitionNodes > 0, "definition task возвращает число созданных слоёв для UI-счётчика");
  eq(calls.createComponent - componentsBefore, 2, "по одному компоненту на определение");
  ok(definitions.definitionBuildMs >= 0, "время сборки определений измерено");

  // Определение внутри определения — уже нативный инстанс.
  eq(calls.createInstance, 1, "вложенное вхождение создано через createInstance");
  eq(calls.createVector, 1, "вектор построен геометрией, а не растром");

  // Нативная boolean-структура: parent-first сборщик создаёт контейнер,
  // сохраняет формулу и затем кладёт в него исходные operands. Маска рядом
  // проверяет, что source isMask/maskType доезжают без эвристики по имени.
  var booleanRoot = await importer.handleDirectTask(directTask("jd", "ROOT", {
    pageName: "Boolean", rootId: "2:200", rootName: "Boolean and mask", nodes: [
      { id: "2:200", parent: null, kind: "ORDINARY", type: "FRAME", name: "Boolean and mask", width: 100, height: 100 },
      { id: "2:201", parent: "2:200", kind: "ORDINARY", type: "BOOLEAN_OPERATION", name: "Subtract", x: 40, y: 30, width: 20, height: 20,
        booleanOperation: "SUBTRACT", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1, blendMode: "NORMAL" }] },
      // Pixso stores these transforms against the immediate BOOLEAN parent.
      // Figma exposes them against the nearest container parent instead, so
      // importer must compose (40,30) with these local offsets. Negative
      // operands are typical for SUBTRACT and used to expose the real bug.
      { id: "2:202", parent: "2:201", kind: "ORDINARY", type: "RECTANGLE", name: "Base", x: -10, y: -20, width: 20, height: 20 },
      { id: "2:203", parent: "2:201", kind: "ORDINARY", type: "ELLIPSE", name: "Hole", x: 5, y: 5, width: 10, height: 10 },
      { id: "2:204", parent: "2:200", kind: "ORDINARY", type: "VECTOR", name: "Mask", width: 20, height: 20,
        isMask: true, maskType: "VECTOR", vectorPaths: [{ windingRule: "NONZERO", data: "M 0 0 L 20 0 L 20 20 Z" }] },
    ]
  }), { createPages: true });
  eq(booleanRoot.ordinaryNodesCreated, 5, "boolean/mask tree imported without flattening operands");
  eq(calls.createBooleanOperation, 1, "BOOLEAN_OPERATION created as native Figma boolean container");
  var booleanPage = pages.filter(function (page) { return page.name === "Boolean"; })[0];
  var booleanPageRoot = booleanPage.children.filter(function (node) { return node.name === "Boolean and mask"; })[0];
  var booleanNode = booleanPageRoot.children[0];
  eq(booleanNode.type, "BOOLEAN_OPERATION", "boolean node stays editable");
  eq(booleanNode.booleanOperation, "SUBTRACT", "boolean formula preserved");
  eq(booleanNode.children.length, 2, "boolean operands preserved as children");
  eq(booleanNode.children[0].relativeTransform[0][2], 30,
    "boolean operand X is composed into nearest-container coordinates");
  eq(booleanNode.children[0].relativeTransform[1][2], 10,
    "boolean operand Y is composed into nearest-container coordinates");
  eq(booleanNode.children[1].relativeTransform[0][2], 45,
    "second boolean operand keeps its source-local offset after composition");
  eq(booleanNode.children[1].relativeTransform[1][2], 35,
    "second boolean operand Y keeps its source-local offset after composition");
  var maskNode = booleanPageRoot.children[1];
  eq(maskNode.isMask, true, "mask flag applied to native node");
  eq(maskNode.maskType, "VECTOR", "mask type applied to native node");

  // Повтор того же определения в другом chunk не создаёт второе дерево.
  var repeated = await importer.handleDirectTask(
    directTask("jd", "DEFINITIONS", { definitions: [buttonDefinition()] }), {});
  eq(repeated.definitionsCreated, 0, "повторное определение не собирается заново");
  eq(repeated.definitionsReused, 1, "повторная встреча даёт ссылку на уже собранное");

  var directPages = pagesWithRole(importer.DIRECT_SERVICE_PAGE.role);
  eq(directPages.length, 1, "у Direct PIX своя служебная страница");
  eq(pagesWithRole(importer.SERVICE_PAGE_ROLE).length, 0, "страница определений FULL не создана");
  eq(pagesWithRole(importer.FAST_SERVICE_PAGE_ROLE).length, 0, "страница FAST не создана");
  eq(directPages[0].children.length, 2, "оба определения лежат на служебной странице");

  var instancesBefore = calls.createInstance;
  var framesBefore = calls.createFrame;
  var root = await importer.handleDirectTask(
    directTask("jd", "ROOT", { pageName: "Экран", rootId: "2:100", rootName: "Экран", nodes: screenNodes() }),
    { createPages: true }
  );
  eq(root.instancesCreated, 2, "оба вхождения стали нативными инстансами");
  eq(calls.createInstance - instancesBefore, 2, "createInstance вызван ровно на вхождения");
  // Заглушка больше НЕ считается обычным узлом: причинный счётчик и счётчик
  // адресации — разные утверждения, и смешивать их значит врать в отчёте.
  eq(root.ordinaryNodesCreated, 1, "обычным узлом посчитан только корень");
  eq(root.expectedInstances, 3, "ожидались три вхождения");
  eq(root.instanceDefinitionUnavailable, 1, "ровно одно определение недоступно");
  eq(root.placeholderFramesCreated, 1, "ровно одна заглушка");
  eq(calls.createFrame - framesBefore, 2, "лишних фреймов не создано");
  eq(root.overridesApplied, 2, "применены доказуемые правки: заливка и текст");
  eq(root.overridesMissed, 1, "недостижимая цель посчитана промахом, а не применена наугад");
  ok(root.importMs >= 0 && root.instanceCreateMs >= 0, "тайминги корня измерены");

  var screenPage = pages.filter(function (page) { return page.name === "Экран"; })[0];
  ok(screenPage, "страница экрана создана по имени из документа");
  eq(screenPage.children.length, 1, "на странице ровно один корень");
  var screenFrame = screenPage.children[0];
  eq(screenFrame.children.length, 3, "все дети корня на месте");
  eq(screenFrame.children[0].type, "INSTANCE", "вхождение — инстанс, а не развёрнутая копия");
  eq(screenFrame.children[1].children[0].characters, "Отправить", "текстовая правка применена внутрь инстанса");
  eq(screenFrame.children[0].children[0].characters, "Кнопка", "правка не протекла в соседний инстанс");
  eq(screenFrame.children[2].getPluginData("pixsoDirectFallback"), "INSTANCE_DEFINITION_UNAVAILABLE",
    "вхождение без определения помечено, а не выдумано");
  eq(screenFrame.children[2].getPluginData("pixsoDirectFallbackReason"),
    importer.DEFINITION_UNAVAILABLE.NOT_REGISTERED,
    "заглушка несёт ПРИЧИНУ деградации, а не только сам факт");
  eq(screenFrame.children[2].getPluginData("pixsoDirectDefinitionId"), "2:999",
    "заглушка помнит, какого определения не хватило");

  var finish = await importer.handleDirectTask(directTask("jd", "FINISH", {}), {});
  eq(finish.totals.definitionsCreated, 2, "итог по определениям");
  eq(finish.totals.instancesCreated, 3, "итог по инстансам, включая вложенный");
  eq(finish.totals.overridesApplied, 2, "итог по применённым правкам");
  ok(finish.totals.unsupported > 0, "непокрытые случаи посчитаны, а не спрятаны");
  ok(finish.unsupportedByCode.INSTANCE_DEFINITION_UNAVAILABLE >= 1,
    "у каждой потери есть причинный код");
  eq(finish.definitionLifetimeReport.unavailableByReason[
    importer.DEFINITION_UNAVAILABLE.NOT_REGISTERED], 1,
    "причина недоступности названа, а не свалена в общий счётчик");
  // 3 вхождения экрана плюс вложенная иконка внутри определения кнопки.
  eq(finish.definitionLifetimeReport.expectedInstances, 4, "ожидание источника в итоге");
  eq(finish.definitionLifetimeReport.instancesCreated, 3, "созданные инстансы в итоге");
  eq(finish.definitionLifetimeReport.placeholderFramesCreated, 1, "заглушки в итоге");
  var reconciliation = finish.definitionLifetimeReport.instanceReconciliation;
  ok(reconciliation, "FINISH содержит source-id reconciliation инстансов");
  eq(reconciliation.expectedUnique, 4, "reconciliation знает все ожидаемые instance ids");
  eq(reconciliation.createdUnique, 3, "reconciliation знает все реально созданные native ids");
  eq(reconciliation.missingUnique, 1, "reconciliation выделяет ровно потерянное вхождение");
  eq(reconciliation.missingByReason.INSTANCE_DEFINITION_UNAVAILABLE, 1,
    "потерянное вхождение имеет причинный класс, а не голую разницу счётчиков");
  eq(reconciliation.missingSamples[0].occurrenceId, "2:103",
    "bounded sample называет source id проблемного occurrence");
  ok(finish.definitionLifetimeReport.trace.length >= 1, "след жизни определения собран");
  eq(finish.definitionLifetimeReport.trace[0].definitionId, "2:999", "след указывает на нужное определение");
  eq(finish.definitionLifetimeReport.trace[0].registered, false, "в реестре записи не было");
  eq(pagesWithRole(importer.DIRECT_SERVICE_PAGE.role)[0].getPluginData("pixso2figmaState"), "READY",
    "служебная страница Direct помечена готовой");

  // Идемпотентность: повторная доставка той же задачи не импортирует дважды.
  var repeatTask = directTask("jd", "ROOT", { pageName: "Экран", rootId: "2:100", nodes: screenNodes() });
  var firstResult = await importer.handleDirectTask(repeatTask, { createPages: true });
  var instancesAfterFirst = calls.createInstance;
  var secondResult = await importer.handleDirectTask(repeatTask, { createPages: true });
  eq(calls.createInstance, instancesAfterFirst, "повтор taskId не создаёт узлы второй раз");
  eq(secondResult.instancesCreated, firstResult.instancesCreated, "повтор возвращает тот же результат");

  // -------------------------------------------------------------------------
  // 3. Изоляция от Fast/Full
  // -------------------------------------------------------------------------

  resetFigma();

  var fastPackage = {
    format: "pixso-portable-package",
    transferMode: "VISUAL_SNAPSHOT",
    roots: [{ nodeRef: "node:screen" }],
    nodes: {
      "node:screen": {
        id: "node:screen", type: "FRAME", name: "Экран",
        size: { width: 100, height: 100 }, position: { x: 0, y: 0 }, children: [],
      },
    },
    images: {}, styles: {},
  };

  // Обычная задача FAST до Direct.
  await importer.handleReceiverTask({ jobId: "jf", taskId: "jf-1", type: "START_JOB", payload: { migrationMode: "FAST" } }, {});
  var fastRoot = await importer.handleReceiverTask(
    { jobId: "jf", taskId: "jf-2", type: "ROOT_NODE", payload: { migrationMode: "FAST", pageName: "Pixso", package: fastPackage } },
    { createPages: true }
  );
  eq(fastRoot.migrationMode, "FAST", "старая задача по-прежнему объявляет свой режим");

  // Direct-задача посреди живой FAST job.
  await importer.handleDirectTask(directTask("jd2", "START", {}), {});
  await importer.handleDirectTask(directTask("jd2", "DEFINITIONS", { definitions: [iconDefinition()] }), {});

  // FAST job обязана продолжиться со своими счётчиками.
  var fastFinish = await importer.handleReceiverTask(
    { jobId: "jf", taskId: "jf-3", type: "FINISH_JOB", payload: { migrationMode: "FAST" } }, {});
  eq(fastFinish.migrationMode, "FAST", "режим FAST job не изменился после Direct-задачи");
  eq(fastFinish.totals.roots, 1, "счётчики FAST job не тронуты Direct-задачей");
  eq(fastFinish.totals.instancesCreated, undefined, "в итогах FAST нет счётчиков Direct");
  eq(fastFinish.jobStats.migrationMode, "FAST", "объявленный режим сохранён");

  eq(pagesWithRole(importer.DIRECT_SERVICE_PAGE.role).length, 1, "Direct создал только свою страницу");
  eq(pagesWithRole(importer.SERVICE_PAGE_ROLE).length, 0, "страница FULL не появилась из-за Direct");

  // -------------------------------------------------------------------------
  // 4. Отказ Direct-задачи не мешает следующей обычной миграции
  // -------------------------------------------------------------------------

  await assert.rejects(
    importer.handleDirectTask({ jobId: "jd3", taskId: "jd3-1", type: "DIRECT_PIX_ROOT", payload: { protocol: "ПОРЧА" } }, {}),
    /чужой протокол/,
    "испорченная Direct-задача падает"
  );
  checks += 1;

  await importer.handleReceiverTask({ jobId: "jf2", taskId: "jf2-1", type: "START_JOB", payload: { migrationMode: "FULL" } }, {});
  var afterFailure = await importer.handleReceiverTask(
    { jobId: "jf2", taskId: "jf2-2", type: "ROOT_NODE", payload: { migrationMode: "FULL", pageName: "Pixso", package: fastPackage } },
    { createPages: true }
  );
  eq(afterFailure.ok, true, "после отказа Direct обычная миграция запускается");
  eq(afterFailure.migrationMode, "FULL", "и в своём режиме");

  // -------------------------------------------------------------------------
  // 5. Два nested swaps меняют namespace до content overrides
  // -------------------------------------------------------------------------

  resetFigma();
  await importer.handleDirectTask(directTask("nested", "START", { debugOverrides: true }), {});
  function componentDef(id, name, children) {
    return {
      definitionId: id, componentKey: "key-" + id, name: name,
      nodes: [{ id: id, parent: null, kind: "ORDINARY", type: "COMPONENT", name: name, width: 40, height: 40 }].concat(children || []),
    };
  }
  var nestedDefinitions = [
    componentDef("7:10", "Leaf A", [
      { id: "7:11", parent: "7:10", kind: "ORDINARY", type: "TEXT", name: "Duplicate", width: 20, height: 10, text: { characters: "A", fontName: { family: "Inter", style: "Regular" } } },
    ]),
    componentDef("7:20", "Leaf B", [
      { id: "7:21", parent: "7:20", kind: "ORDINARY", type: "TEXT", name: "Duplicate", width: 20, height: 10, text: { characters: "B", fontName: { family: "Inter", style: "Regular" } } },
    ]),
    componentDef("7:30", "Middle A", [
      { id: "7:31", parent: "7:30", kind: "INSTANCE", type: "INSTANCE", name: "Leaf", definitionId: "7:10", width: 20, height: 20 },
    ]),
    componentDef("7:40", "Middle B", [
      { id: "7:41", parent: "7:40", kind: "INSTANCE", type: "INSTANCE", name: "Leaf", definitionId: "7:20", width: 20, height: 20 },
    ]),
    componentDef("7:50", "Wrapper", [
      { id: "7:51", parent: "7:50", kind: "INSTANCE", type: "INSTANCE", name: "Middle", definitionId: "7:30", width: 24, height: 24 },
    ]),
  ];
  await importer.handleDirectTask(directTask("nested", "DEFINITIONS", { definitions: nestedDefinitions }), {});
  var nestedRoot = await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "7:3", pageName: "Nested", rootId: "7:4", rootName: "Root",
    nodes: [
      { id: "7:4", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 100, height: 100 },
      {
        id: "7:5", parent: "7:4", kind: "INSTANCE", type: "INSTANCE", name: "Occurrence", definitionId: "7:50", width: 40, height: 40,
        overrides: [
          { path: [{ index: 0, sourceId: "7:51", name: "Middle" }], ops: { swapDefinitionId: "7:40" } },
          { path: [{ index: 0, sourceId: "7:51", name: "Middle" }, { index: 0, sourceId: "7:41", name: "Leaf" }], ops: { swapDefinitionId: "7:10" } },
          { path: [{ index: 0, sourceId: "7:51", name: "Middle" }, { index: 0, sourceId: "7:41", name: "Leaf" }, { index: 0, sourceId: "7:11", name: "Duplicate" }], ops: { characters: "After swaps", visible: false } },
          // Уникальное имя совпало бы, но source GUID неверен: fallback по имени запрещён.
          { path: [{ index: 0, sourceId: "7:51", name: "Middle" }, { index: 0, sourceId: "7:41", name: "Leaf" }, { index: 0, sourceId: "7:999", name: "Duplicate" }], ops: { opacity: 0.5 } },
        ],
      },
    ],
  }), { createPages: true });
  eq(nestedRoot.overridesAttempted, 5, "все swap/content операции посчитаны как попытки");
  eq(nestedRoot.overridesApplied, 4, "два swaps, текст и visibility применены");
  eq(nestedRoot.overridesMissed, 1, "invalid source GUID остался miss");
  eq(nestedRoot.overrideMissReasons.TARGET_GUID_NOT_IN_FIGMA_SUBTREE, 1, "miss классифицирован без name fallback");
  var nestedPage = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "7:3"; })[0];
  var nestedText = nestedPage.children[0].children[0].children[0].children[0].children[0];
  eq(nestedText.characters, "After swaps", "text override применился в namespace после двух swaps");
  eq(nestedText.visible, false, "visibility override применился после swaps");

  // D57. Low-level Pixso swap is authoritative serialization, not an editor
  // gesture. Figma swapComponent() preserves old overrides heuristically; the
  // Direct PIX lane must instead perform a clean mainComponent assignment and
  // then replay explicit source overrides. The fake host intentionally keeps
  // the old Text child when swapComponent() is used, so this test regresses if
  // importer goes back to that API.
  figma.__preserveSwapOverrides = true;
  await importer.handleDirectTask(directTask("nested", "DEFINITIONS", { definitions: [
    componentDef("17:10", "Text cell", [
      { id: "17:11", parent: "17:10", kind: "ORDINARY", type: "TEXT", name: "cell text", width: 30, height: 10, text: { characters: "cell text", fontName: { family: "Inter", style: "Regular" } } },
    ]),
    componentDef("17:20", "Icon cell", [
      { id: "17:21", parent: "17:20", kind: "ORDINARY", type: "FRAME", name: "Icon", width: 16, height: 16 },
    ]),
    componentDef("17:30", "Cell wrapper", [
      { id: "17:31", parent: "17:30", kind: "INSTANCE", type: "INSTANCE", name: "Elements", definitionId: "17:10", width: 30, height: 16 },
    ]),
  ] }), {});
  var cleanSwapRoot = await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "17:1", pageName: "Clean swap", rootId: "17:40", rootName: "Root", nodes: [
      { id: "17:40", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 100, height: 40 },
      { id: "17:41", parent: "17:40", kind: "INSTANCE", type: "INSTANCE", name: "Cell", definitionId: "17:30", width: 40, height: 20, overrides: [
        { path: [{ index: 0, sourceId: "17:31", definitionId: "17:30", targetType: "INSTANCE", name: "Elements" }],
          ops: { swapDefinitionId: "17:20" }, present: { swapDefinitionId: true } },
      ] },
    ],
  }), { createPages: true });
  figma.__preserveSwapOverrides = false;
  var cleanSwapPage = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "17:1"; })[0];
  var cleanSlot = cleanSwapPage.children[0].children[0].children[0];
  eq(cleanSlot.children.length, 1, "D57. clean low-level swap не сохраняет stale child старого master");
  eq(cleanSlot.children[0].name, "Icon", "D57. text->icon swap оставляет только subtree нового master");
  ok(calls.resetOverrides > 0, "D60. перед low-level master swap очищаются старые direct overrides nested instance");

  // D59. A later live-host resize may rematerialize the nested occurrence and
  // restore the master's stale Text value after the ordinary override pass.
  // The final explicit-text commit must resolve the source path again and put
  // the serialized Pixso value back. A single space is intentional here: real
  // Pixso table/icon cells encode their visually blank label this way.
  figma.__resetDescendantTextOnResize = true;
  figma.__resetDescendantTextOverflowOnResize = true;
  await importer.handleDirectTask(directTask("nested", "DEFINITIONS", { definitions: [
    componentDef("19:10", "Badge", [
      { id: "19:11", parent: "19:10", kind: "ORDINARY", type: "TEXT", name: "Label", width: 30, height: 10,
        text: { characters: "text", fontName: { family: "Inter", style: "Regular" },
          textAutoResize: "NONE", textTruncation: "ENDING", maxLines: 1 } },
    ]),
    componentDef("19:20", "Cell", [
      { id: "19:21", parent: "19:20", kind: "INSTANCE", type: "INSTANCE", name: "Badge", definitionId: "19:10", width: 30, height: 16 },
    ]),
  ] }), {});
  var finalTextRoot = await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "19:1", pageName: "Final text", rootId: "19:30", rootName: "Root", nodes: [
      { id: "19:30", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 100, height: 40 },
      { id: "19:31", parent: "19:30", kind: "INSTANCE", type: "INSTANCE", name: "Cell", definitionId: "19:20", width: 40, height: 20,
        overrides: [
          { path: [
              { index: 0, sourceId: "19:21", definitionId: "19:20", definitionPath: [0], targetType: "INSTANCE", name: "Badge" },
              { index: 0, sourceId: "19:11", definitionId: "19:10", definitionPath: [0], targetType: "TEXT", name: "Label" }
            ], ops: { characters: " " }, present: { characters: true } },
        ] },
    ],
  }), { createPages: true });
  figma.__resetDescendantTextOnResize = false;
  figma.__resetDescendantTextOverflowOnResize = false;
  var finalTextPage = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "19:1"; })[0];
  var finalText = finalTextPage.children[0].children[0].children[0].children[0];
  eq(finalText.characters, " ", "D59. explicit blank text повторно зафиксирован после поздней rematerialization");
  eq(finalText.textTruncation, "ENDING",
    "D61. точный definition path восстановил ENDING после rematerialization");
  eq(finalText.maxLines, 1,
    "D61. тот же definition path восстановил доказанный maxLines");
  eq(finalTextRoot.textOverflowSemanticsReasserted, 1,
    "D61. overflow-replay пишет ровно один доказанно повреждённый TEXT, а уже верные узлы не трогает");


  // D57. Explicit visible=false below a proven swap namespace must survive.
  // This mirrors SideMenu: the occurrence selects another variant, then the
  // source stream intentionally hides a Text descendant in that new variant.
  function variantDefinition(id, variantName, child) {
    var expanded = variantName.indexOf("false") >= 0;
    return {
      definitionId: id, componentKey: "rail-tab", variantGroupId: "18:1", name: variantName,
      variantSet: {
        groupId: "18:1", groupName: "Tabs", groupComponentKey: "rail-tab-set",
        variantName: variantName, coordinate: { collapsed: expanded ? "false" : "true" },
        order: expanded ? 1 : 0, axisCount: 1, memberCountSource: 2, memberCountDemanded: 2, sourceName: variantName,
      },
      nodes: [
        { id: id, parent: null, kind: "ORDINARY", type: "COMPONENT", name: variantName, width: expanded ? 232 : 32, height: 32 },
      ].concat(child || []),
    };
  }
  await importer.handleDirectTask(directTask("nested", "DEFINITIONS", { definitions: [
    variantDefinition("18:10", "collapsed=true", [
      { id: "18:11", parent: "18:10", kind: "ORDINARY", type: "FRAME", name: "Icon", width: 20, height: 20 },
    ]),
    variantDefinition("18:20", "collapsed=false", [
      { id: "18:21", parent: "18:20", kind: "ORDINARY", type: "FRAME", name: "Icon", width: 20, height: 20 },
      { id: "18:22", parent: "18:20", kind: "ORDINARY", type: "TEXT", name: "tab name", width: 192, height: 20,
        text: { characters: "Главная", fontName: { family: "Inter", style: "Regular" } } },
    ]),
    componentDef("18:30", "Rail", [
      { id: "18:31", parent: "18:30", kind: "INSTANCE", type: "INSTANCE", name: "Tab", definitionId: "18:10", width: 32, height: 32 },
    ]),
  ] }), {});
  var exactVisibleRoot = await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "18:2", pageName: "Exact visibility", rootId: "18:40", rootName: "Root", nodes: [
      { id: "18:40", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 260, height: 50 },
      { id: "18:41", parent: "18:40", kind: "INSTANCE", type: "INSTANCE", name: "Rail occurrence", definitionId: "18:30", width: 56, height: 40, overrides: [
        { path: [{ index: 0, sourceId: "18:31", definitionId: "18:30", targetType: "INSTANCE", name: "Tab" }],
          ops: { swapDefinitionId: "18:20" }, present: { swapDefinitionId: true } },
        { path: [
            { index: 0, sourceId: "18:31", definitionId: "18:30", targetType: "INSTANCE", name: "Tab" },
            { index: 1, sourceId: "18:22", definitionId: "18:20", targetType: "TEXT", name: "tab name" }
          ], ops: { visible: false }, present: { visible: true } },
      ] },
    ],
  }), { createPages: true });
  var exactVisiblePage = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "18:2"; })[0];
  var exactVisibleTab = exactVisiblePage.children[0].children[0].children[0];
  var exactVisibleText = exactVisibleTab.children.filter(function (child) { return child.getPluginData("pixsoDirectSourceId") === "18:22"; })[0];
  ok(exactVisibleText, "D57. descendant нового variant адресован точным source GUID");
  eq(exactVisibleText.visible, false, "D57. explicit visible=false не подавляется после доказанного variant swap");
  eq(exactVisibleRoot.overridesMissed, 0, "D57. swap+visibility применились без fallback");
  // -------------------------------------------------------------------------
  // 6. Full-document page tasks: identity по page id, не по имени
  // -------------------------------------------------------------------------

  var firstPageTask = await importer.handleDirectTask(directTask("nested", "PAGE", { pageId: "p:a", pageName: "Same" }), { createPages: true });
  var secondPageTask = await importer.handleDirectTask(directTask("nested", "PAGE", { pageId: "p:b", pageName: "Same" }), { createPages: true });
  eq(firstPageTask.page, "Same", "первая страница создана с исходным именем");
  eq(secondPageTask.page, "Same", "вторая одноимённая страница сохраняет имя");
  eq(pages.filter(function (page) { return page.name === "Same"; }).length, 2, "одноимённые source pages не склеены");

  await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "p:a", pageName: "Same", rootId: "r:1", rootName: "One",
    nodes: [{ id: "r:1", parent: null, kind: "ORDINARY", type: "FRAME", name: "One", width: 10, height: 10 }],
  }), { createPages: true });
  await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "p:a", pageName: "Same", rootId: "r:2", rootName: "Two",
    deepOverrideProvenanceSamples: [{
      reason: "TARGET_GUID_NOT_IN_DEFINITION",
      instanceSourceId: "src:1", canonicalDefinitionId: "def:1",
      sourceProvenance: { derivedCandidateCount: 2 },
    }],
    sourceSemanticReport: {
      counts: { VISIBLE: 1 }, nodesAudited: 3, overridesAudited: 2,
      samples: [{ field: "VISIBLE", sourceId: "src:visible", expected: true, actual: false }],
      componentPropertySamples: [{ instanceSourceId: "src:1", propertyId: "prop:1", propertyType: "BOOLEAN", value: true,
        targetNodeIds: ["def:child"], targetFields: ["visible"] }],
    },
    nodes: [{ id: "r:2", parent: null, kind: "ORDINARY", type: "FRAME", name: "Two", width: 10, height: 10 }],
  }), { createPages: true });
  var pageA = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "p:a"; })[0];
  eq(pageA.children.map(function (node) { return node.name; }).join(","), "One,Two", "порядок нескольких roots на странице сохранён");

  var componentsBeforeCrossPage = calls.createComponent;
  var reusedAcrossPages = await importer.handleDirectTask(
    directTask("nested", "DEFINITIONS", { definitions: [nestedDefinitions[0]] }), {});
  eq(reusedAcrossPages.definitionsReused, 1, "definition со второй страницы переиспользована job-level registry");
  eq(calls.createComponent, componentsBeforeCrossPage, "definition между страницами не построена второй раз");
  await importer.handleDirectTask(directTask("nested", "ROOT", {
    pageId: "p:b", pageName: "Same", rootId: "r:3", rootName: "Uses shared definition",
    nodes: [
      { id: "r:3", parent: null, kind: "ORDINARY", type: "FRAME", name: "Uses shared definition", width: 20, height: 20 },
      { id: "r:4", parent: "r:3", kind: "INSTANCE", type: "INSTANCE", name: "Shared", definitionId: "7:10", width: 20, height: 20 },
    ],
  }), { createPages: true });
  var pageB = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "p:b"; })[0];
  eq(pageB.children[0].children[0].type, "INSTANCE", "definition на другой странице создаёт native instance");

  var nestedFinish = await importer.handleDirectTask(directTask("nested", "FINISH", {}), {});
  eq(nestedFinish.totals.pages, 2, "явно объявленные страницы посчитаны");
  eq(nestedFinish.overrideResolutionReport.totalMisses, 1, "итоговый override report не маскирует miss");
  eq(nestedFinish.overrideResolutionReport.samples.length, 1, "debug report содержит ограниченный sample");
  eq(nestedFinish.deepOverrideProvenanceReport.samples.length, 1,
    "source provenance переживает transport и попадает в FINISH report");
  eq(nestedFinish.deepOverrideProvenanceReport.samples[0].sourceProvenance.derivedCandidateCount, 2,
    "FINISH report сохраняет hop-level derived ambiguity");
  eq(nestedFinish.sourceSemanticReport.counts.VISIBLE, 1,
    "source→IR semantic audit переживает transport и агрегируется в FINISH");
  eq(nestedFinish.sourceSemanticReport.nodesAudited, 3,
    "source→IR report сохраняет число проверенных source nodes");
  eq(nestedFinish.sourceSemanticReport.componentPropertySamples[0].targetFields[0], "visible",
    "source→IR report сохраняет BOOLEAN target provenance");

  // Новый START сбрасывает counters/diagnostics, не наследуя прошлый job.
  await importer.handleDirectTask(directTask("fresh", "START", {}), {});
  var freshFinish = await importer.handleDirectTask(directTask("fresh", "FINISH", {}), {});
  eq(freshFinish.totals.overridesMissed, 0, "новый Direct job не наследует misses предыдущего");
  eq(freshFinish.overrideResolutionReport.samples.length, 0, "debug samples не протекают между jobs");
  eq(freshFinish.deepOverrideProvenanceReport.samples.length, 0,
    "source provenance не протекает между Direct jobs");
  eq(freshFinish.sourceSemanticReport.samples.length, 0,
    "source→IR semantic samples не протекают между Direct jobs");

  // Full-document command обязана воспроизводить страницы независимо от
  // локальной галочки Receiver, которая остаётся настройкой старых/single-root jobs.
  resetFigma();
  await importer.handleDirectTask(directTask("file-a", "START", {
    source: { fileName: "A.pix" }, fullDocument: true,
  }), { createPages: false });
  await importer.handleDirectTask(directTask("file-a", "PAGE", {
    pageId: "same-id", pageName: "Page A", fullDocument: true,
  }), { createPages: false });
  ok(pages.some(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "same-id"; }),
    "full-document PAGE создаётся даже при выключенной галочке старого Receiver path");

  var pagesBeforeOtherFile = pages.length;
  await importer.handleDirectTask(directTask("file-b", "START", {
    source: { fileName: "B.pix" }, fullDocument: true,
  }), { createPages: false });
  await importer.handleDirectTask(directTask("file-b", "PAGE", {
    pageId: "same-id", pageName: "Page B", fullDocument: true,
  }), { createPages: false });
  eq(pages.length, pagesBeforeOtherFile + 1, "одинаковый page id другого source file не захватывает прежнюю страницу");

  // -------------------------------------------------------------------------
  // 8. plugin data недоступна — индексный адрес остаётся действительным
  //
  // Внутри инстанса подслои зеркалят master component, и plugin data читается
  // там не в каждом контексте. Трактовать «sourceId не прочитался» как «цели
  // нет» нельзя: индексный путь приёмник построил сам по тому же дереву
  // определения. Отсутствие подтверждения — не опровержение, но и не полная
  // уверенность, поэтому такой шаг обязан попадать в отдельный счётчик.
  // -------------------------------------------------------------------------

  resetFigma();
  await importer.handleDirectTask(directTask("blind", "START", { debugOverrides: true }), {});
  await importer.handleDirectTask(directTask("blind", "DEFINITIONS", {
    definitions: [{
      definitionId: "9:10", componentKey: "k", name: "Card",
      nodes: [
        { id: "9:10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Card", width: 40, height: 40 },
        { id: "9:11", parent: "9:10", kind: "ORDINARY", type: "FRAME", name: "Body", width: 40, height: 20 },
        { id: "9:12", parent: "9:11", kind: "ORDINARY", type: "TEXT", name: "Заголовок", width: 40, height: 10, text: { characters: "До", fontName: { family: "Inter", style: "Regular" } } },
      ],
    }],
  }), {});

  // Плагин data «слепнет» ровно так, как это выглядит на подслоях инстанса.
  var blindNodes = 0;
  figma.__blindPluginData = true;
  var blindRoot = await importer.handleDirectTask(directTask("blind", "ROOT", {
    pageId: "9:1", pageName: "Blind", rootId: "9:2", rootName: "Root",
    nodes: [
      { id: "9:2", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 100, height: 100 },
      {
        id: "9:3", parent: "9:2", kind: "INSTANCE", type: "INSTANCE", name: "Card", definitionId: "9:10", width: 40, height: 40,
        overrides: [
          { path: [{ index: 0, sourceId: "9:11", name: "Body" }, { index: 0, sourceId: "9:12", name: "Заголовок" }], ops: { characters: "После" } },
          // Индекса нет вовсе — это по-прежнему честный промах.
          { path: [{ index: 0, sourceId: "9:11", name: "Body" }, { index: 7, sourceId: "9:99", name: "Нет такого" }], ops: { opacity: 0.5 } },
        ],
      },
    ],
  }), { createPages: true });
  figma.__blindPluginData = false;
  blindNodes += 1;

  eq(blindRoot.overridesApplied, 1, "адрес по индексу применён, хотя sourceId не читался");
  eq(blindRoot.overridesMissed, 1, "отсутствующий индекс остался промахом");
  // Индекс вне диапазона и несовпадение guid при живом индексе — разные
  // поломки: первая означает, что приёмник построил меньше детей, чем
  // насчитал отправитель. Общий код на оба случая не позволял их различить.
  eq(blindRoot.overrideMissReasons.TARGET_INDEX_OUT_OF_RANGE, 1,
    "индекс вне диапазона классифицирован отдельным кодом");
  eq(blindRoot.overrideMissReasons.TARGET_GUID_NOT_IN_FIGMA_SUBTREE, undefined,
    "несовпадения guid здесь не было");
  eq(blindRoot.overrideMissSamples.length, 1,
    "образец промаха собран без --debug-overrides");
  eq(blindRoot.overrideMissSamples[0].childCountAtDeepest, 1,
    "в образце видно, сколько детей реально нашлось");
  eq(blindRoot.overrideMissSamples[0].wantedIndexAtDeepest, 7,
    "и какой индекс был нужен");
  eq(blindRoot.overrideStepsUnverified, 2,
    "шаги, принятые без подтверждения sourceId, посчитаны отдельно");
  var blindPage = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "9:1"; })[0];
  eq(blindPage.children[0].children[0].children[0].children[0].characters, "После",
    "правка доехала до нужного узла");

  // -------------------------------------------------------------------------
  // Новые операции дельты: auto layout, constraints, эффекты, обводка,
  // типографика. Каждая из них документирована спецификациями как поле
  // `symbolOverrides[]`, и раньше приёмник просто не умел их применять.
  // -------------------------------------------------------------------------

  await importer.handleDirectTask(directTask("ops", "START", { source: { fileName: "Ops.pix" } }), {});
  await importer.handleDirectTask(directTask("ops", "DEFINITIONS", {
    definitions: [{
      definitionId: "5:10", componentKey: "key-ops", variantGroupId: null, name: "Панель",
      nodes: [
        { id: "5:10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Панель", width: 80, height: 40,
          autoLayout: { layoutMode: "HORIZONTAL", itemSpacing: 4 } },
        { id: "5:11", parent: "5:10", kind: "ORDINARY", type: "RECTANGLE", name: "Фон", width: 80, height: 20 },
        { id: "5:12", parent: "5:10", kind: "ORDINARY", type: "TEXT", name: "Подпись", width: 80, height: 20,
          // Compatibility payload from the short-lived producer that encoded
          // source WIDTH_AND_HEIGHT as HEIGHT plus provenance. Receiver must
          // restore HUG even when a partial override adds ENDING/maxLines.
          text: { characters: "До", fontName: { family: "Inter", style: "Regular" },
            textAutoResize: "HEIGHT", sourceTextAutoResize: "WIDTH_AND_HEIGHT" } },
      ],
    }],
  }), {});

  var opsRoot = await importer.handleDirectTask(directTask("ops", "ROOT", {
    pageId: "5:1", pageName: "Ops", rootId: "5:2", rootName: "Root",
    nodes: [
      { id: "5:2", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 200, height: 200, clipsContent: true },
      {
        id: "5:3", parent: "5:2", kind: "INSTANCE", type: "INSTANCE", name: "Панель",
        definitionId: "5:10", width: 80, height: 40,
        overrides: [
          {
            path: [],
            ops: {
              layout: { itemSpacing: 12, paddingLeft: 16, primaryAxisSizingMode: "AUTO" },
              constraints: { horizontal: "STRETCH", vertical: "MIN" },
              effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true }],
              clipsContent: false,
              locked: true,
            },
          },
          {
            path: [{ index: 0, sourceId: "5:11", name: "Фон" }],
            ops: {
              corners: { independent: true, topLeftRadius: 9, topRightRadius: 9, bottomLeftRadius: 0, bottomRightRadius: 0 },
              strokeStyle: { strokeAlign: "OUTSIDE", strokeJoin: "BEVEL", borderWeights: { top: 2, right: 0, bottom: 2, left: 0 } },
              childLayout: { layoutPositioning: "ABSOLUTE" },
            },
          },
          {
            path: [{ index: 1, sourceId: "5:12", name: "Подпись" }],
            ops: { textStyle: {
              fontSize: 18, textDecoration: "UNDERLINE", letterSpacing: { value: 2, unit: "PIXELS" },
              textTruncation: "ENDING", maxLines: 1,
            } },
          },
        ],
      },
    ],
  }), { createPages: true });

  eq(opsRoot.overridesMissed, 0, "все новые операции нашли свою цель");
  var opsPage = pages.filter(function (page) { return page.getPluginData("pixsoDirectSourcePageId") === "5:1"; })[0];
  var opsFrame = opsPage.children[0];
  eq(opsFrame.clipsContent, true, "положительный clipsContent применён к обычному FRAME");
  var panel = opsFrame.children[0];
  eq(panel.itemSpacing, 12, "интервал auto layout применён поверх определения");
  eq(panel.paddingLeft, 16, "отступ применён");
  eq(panel.primaryAxisSizingMode, "AUTO", "режим главной оси применён");
  eq(panel.layoutMode, "HORIZONTAL", "режим раскладки из определения НЕ затёрт частичной правкой");
  eq(panel.constraints.horizontal, "STRETCH", "constraints применены");
  eq(panel.effects.length, 1, "эффект применён");
  eq(panel.clipsContent, false, "clipsContent применён");
  eq(panel.locked, true, "locked применён");
  var background = panel.children[0];
  eq(background.topLeftRadius, 9, "независимые углы применены поимённо");
  eq(background.bottomLeftRadius, 0, "и нижний радиус тоже");
  eq(background.strokeAlign, "OUTSIDE", "выравнивание обводки применено");
  eq(background.strokeTopWeight, 2, "верхняя толщина обводки применена");
  eq(background.strokeRightWeight, 0, "правая толщина применена");
  eq(background.layoutPositioning, "ABSOLUTE", "поведение внутри auto layout применено");
  var caption = panel.children[1];
  eq(caption.fontSize, 18, "размер шрифта применён");
  eq(caption.textDecoration, "UNDERLINE", "подчёркивание применено");
  eq(caption.letterSpacing.value, 2, "трекинг применён");
  eq(caption.textAutoResize, "WIDTH_AND_HEIGHT",
    "частичный ENDING override не отменяет унаследованную автоширину");
  eq(caption.textTruncation, "ENDING", "обрезание применено после режима размера");
  eq(caption.maxLines, 1, "предел строк применён после textTruncation");

  // A nested INSTANCE can be visually correct even when live Figma refuses
  // to mutate its constraints. That is a future-resize semantic limitation,
  // not a current visual-fidelity failure.
  resetFigma();
  figma.__rejectNestedInstanceConstraints = true;
  await importer.handleDirectTask(directTask("nested-constraints", "START", {}), {});
  await importer.handleDirectTask(directTask("nested-constraints", "DEFINITIONS", {
    definitions: [
      {
        definitionId: "5:20", componentKey: "leaf", name: "Leaf",
        nodes: [{ id: "5:20", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Leaf", width: 20, height: 20 }],
      },
      {
        definitionId: "5:30", componentKey: "wrapper", name: "Wrapper",
        nodes: [
          { id: "5:30", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Wrapper", width: 40, height: 40 },
          { id: "5:31", parent: "5:30", kind: "INSTANCE", type: "INSTANCE", name: "Nested", definitionId: "5:20", width: 20, height: 20 },
        ],
      },
    ],
  }), {});
  var nestedConstraintRoot = await importer.handleDirectTask(directTask("nested-constraints", "ROOT", {
    pageId: "5:40", pageName: "Nested constraints", rootId: "5:41", rootName: "Root",
    nodes: [
      { id: "5:41", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 100, height: 100 },
      {
        id: "5:42", parent: "5:41", kind: "INSTANCE", type: "INSTANCE", name: "Wrapper",
        definitionId: "5:30", width: 40, height: 40,
        overrides: [{
          path: [{ index: 0, sourceId: "5:31", name: "Nested" }],
          ops: { constraints: { horizontal: "CENTER", vertical: "CENTER" } },
          present: { constraints: true },
        }],
      },
    ],
  }), { createPages: true });
  figma.__rejectNestedInstanceConstraints = false;
  eq(nestedConstraintRoot.overridesMissed, 1,
    "rejected nested constraint remains an explicit semantic miss");
  eq(nestedConstraintRoot.overrideMissReasons.OVERRIDE_CONSTRAINTS_UNSUPPORTED, 1,
    "nested constraint rejection has a dedicated reason");
  eq(nestedConstraintRoot.nativeInstancesUnsafe, 0,
    "nested constraint rejection does not mark current appearance unsafe");

  // -------------------------------------------------------------------------
  // 10. Обобщённая visual fidelity: presence paints, fixed root, absolute
  // child и definition-relative proof без plugin data подслоёв instance.
  // -------------------------------------------------------------------------

  resetFigma();
  await importer.handleDirectTask(directTask("visual", "START", { debugOverrides: true }), {});
  await importer.handleDirectTask(directTask("visual", "DEFINITIONS", {
    definitions: [{
      definitionId: "10:10", componentKey: "visual", name: "Visual",
      nodes: [
        {
          id: "10:10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Visual",
          width: 120, height: 40, definitionPath: [],
          fills: [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 }, opacity: 1 }],
        },
        {
          id: "10:11", parent: "10:10", kind: "ORDINARY", type: "TEXT", name: "Label",
          width: 80, height: 20, definitionPath: [0],
          text: { characters: "Before", fontName: { family: "Inter", style: "Regular" } },
        },
      ],
    }],
  }), {});

  figma.__blindPluginData = true;
  figma.__simulateFillChildOwnAxisFixed = true;
  var visualRoot = await importer.handleDirectTask(directTask("visual", "ROOT", {
    pageId: "10:1", pageName: "Visual", rootId: "10:2", rootName: "Screen",
    nodes: [
      {
        id: "10:2", parent: null, kind: "ORDINARY", type: "FRAME", name: "Screen",
        width: 333, height: 111,
        autoLayout: {
          layoutMode: "HORIZONTAL", itemSpacing: 17,
          primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "MAX",
          primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
        },
      },
      {
        id: "10:3", parent: "10:2", kind: "INSTANCE", type: "INSTANCE", name: "Occurrence",
        definitionId: "10:10", width: 120, height: 40,
        fills: [], strokes: [], effects: [],
        corners: {
          independent: true, topLeftRadius: 1, topRightRadius: 2,
          bottomRightRadius: 3, bottomLeftRadius: 4,
        },
        overrides: [{
          path: [{
            index: 0, sourceId: "10:11", sourceType: "TEXT", targetType: "TEXT",
            definitionId: "10:10", definitionPath: [0], name: "Label",
          }],
          ops: { characters: "After" },
        }],
      },
      {
        id: "10:4", parent: "10:2", kind: "ORDINARY", type: "RECTANGLE", name: "Overlay",
        x: 77, y: 29, width: 13, height: 17, fills: [], strokes: [],
        childLayout: { layoutPositioning: "ABSOLUTE" },
      },
      {
        id: "10:5", parent: "10:2", kind: "ORDINARY", type: "FRAME", name: "Fill child",
        width: 80, height: 20,
        autoLayout: {
          layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
        },
        childLayout: { layoutGrow: 1, layoutAlign: "INHERIT" },
      },
    ],
  }), { createPages: true });
  figma.__blindPluginData = false;
  figma.__simulateFillChildOwnAxisFixed = false;

  var visualPage = pages.filter(function (page) {
    return page.getPluginData("pixsoDirectSourcePageId") === "10:1";
  })[0];
  var fixedScreen = visualPage.children[0];
  var visualOccurrence = fixedScreen.children[0];
  var overlay = fixedScreen.children[1];
  var fillChild = fixedScreen.children[2];
  var visualService = pagesWithRole(importer.DIRECT_SERVICE_PAGE.role)[0];
  var visualMaster = visualService.children[0];

  eq(fixedScreen.width, 333, "explicit fixed root width survives auto layout");
  eq(fixedScreen.height, 111, "explicit fixed root height survives auto layout");
  eq(fixedScreen.layoutMode, "HORIZONTAL", "pagination-like direction is generic");
  eq(fixedScreen.itemSpacing, 17, "pagination-like spacing is generic");
  eq(fixedScreen.primaryAxisAlignItems, "CENTER", "primary alignment is preserved");
  eq(fixedScreen.counterAxisAlignItems, "MAX", "counter alignment is preserved");
  eq(overlay.layoutPositioning, "ABSOLUTE", "absolute child is excluded from flow");
  eq(overlay.x, 77, "absolute child x is restored after layout activation");
  eq(overlay.y, 29, "absolute child y is restored after layout activation");
  eq(overlay.width, 13, "absolute child width is restored");
  eq(overlay.height, 17, "absolute child height is restored");
  eq(fillChild.layoutGrow, 1, "fill child keeps parent-owned main-axis sizing");
  eq(fillChild.primaryAxisSizingMode, "FIXED",
    "host represents parent-owned FILL as FIXED on the child's own axis");
  eq(visualMaster.fills.length, 1, "canonical master keeps its paint");
  eq(visualOccurrence.fills.length, 0, "explicit empty occurrence paint clears master");
  eq(visualOccurrence.strokes.length, 0, "explicit empty occurrence stroke clears master");
  eq(visualOccurrence.effects.length, 0, "explicit empty occurrence effects clear master");
  eq(visualOccurrence.topLeftRadius, 1, "independent occurrence top-left radius survives");
  eq(visualOccurrence.bottomLeftRadius, 4, "independent occurrence bottom-left radius survives");
  eq(visualOccurrence.children[0].characters, "After",
    "override resolves by strict definition-relative structure when plugin data is hidden");
  eq(visualRoot.structuralStepsVerified, 1, "receiver measures structurally verified addressing");
  eq(visualRoot.overrideStepsUnverified, 0, "structural proof removes optimistic unverified steps");
  eq(visualRoot.nativeInstancesVisualSafe, 1, "safe is counted only after receiver verification");
  eq(visualRoot.nativeInstancesUnsafe, 0, "verified occurrence is not marked unsafe");

  var visualFinish = await importer.handleDirectTask(directTask("visual", "FINISH", {}), {});
  eq(visualFinish.visualSafetyReport.safe, 1, "finish exposes evidence-based safe count");
  eq(visualFinish.visualSafetyReport.unsafe, 0, "finish exposes evidence-based unsafe count");
  eq(visualFinish.visualSafetyReport.structuralStepsVerified, 1,
    "finish exposes structural proof count");
  eq(typeof visualFinish.receiverBuild.receiverVersion, "string",
    "finish fingerprint names the receiver version");
  eq(typeof visualFinish.receiverBuild.probeVersion, "number",
    "finish fingerprint names the probe catalogue version");
  ok(Object.keys(visualFinish.receiverBuild).every(function (key) {
    var value = visualFinish.receiverBuild[key];
    return /Version$/.test(key) || value === true;
  }), "every feature flag measures a function that exists in this build");
  ok(visualFinish.visualParityReport && visualFinish.visualParityReport.mismatchesByField,
    "finish exposes bounded visual parity diagnostics");
  eq(visualFinish.visualParityReport.mismatchesByField.materializedDefinition || 0, 0,
    "correct native occurrence keeps its expected materialized definition");
  eq(visualFinish.layoutTextParityReport.mismatchesByField.primaryAxisSizingMode || 0, 0,
    "parent-owned FILL does not create a false AUTO→FIXED parity mismatch");

  // Parent semantic HUG is a later mutation than the ordinary child-layout
  // pass. Live Figma can reapply ABSOLUTE constraints at that point; source
  // placement must therefore be the final mutating commit before parity.
  resetFigma();
  figma.__simulateAbsoluteConstraintDrift = true;
  await importer.handleDirectTask(directTask("absolute-final", "START", {}), {});
  await importer.handleDirectTask(directTask("absolute-final", "ROOT", {
    pageId: "10:20", pageName: "Absolute final", rootId: "10:21", rootName: "Root",
    nodes: [
      {
        id: "10:21", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root",
        width: 176, height: 60,
        autoLayout: {
          layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
        },
      },
      {
        id: "10:22", parent: "10:21", kind: "ORDINARY", type: "RECTANGLE", name: "Flow",
        width: 16, height: 16,
      },
      {
        id: "10:23", parent: "10:21", kind: "ORDINARY", type: "RECTANGLE", name: "Absolute",
        x: 15, y: 39, width: 146, height: 25,
        childLayout: { layoutPositioning: "ABSOLUTE" },
        constraints: { horizontal: "STRETCH", vertical: "MAX" },
      },
    ],
  }), { createPages: true });
  figma.__simulateAbsoluteConstraintDrift = false;
  var absolutePage = pages.filter(function (page) {
    return page.getPluginData("pixsoDirectSourcePageId") === "10:20";
  })[0];
  var absoluteChild = absolutePage.children[0].children[1];
  eq(absoluteChild.x, 15, "absolute x is restored after final parent semantic sizing");
  eq(absoluteChild.y, 39, "absolute y survives final parent semantic sizing");
  eq(absoluteChild.relativeTransform[0][0], 1,
    "axis-aligned absolute child gets canonical identity x basis");
  eq(absoluteChild.relativeTransform[1][1], 1,
    "axis-aligned absolute child gets canonical identity y basis");

  // -------------------------------------------------------------------------
  // 11. Destructive override guard: operation без raw-presence не
  // имеет права очищать уже построенный TEXT.
  // -------------------------------------------------------------------------

  resetFigma();
  await importer.handleDirectTask(directTask("presence", "START", {
    traceTextOverrides: true, textOverrideTraceLimit: 4,
  }), {});
  await importer.handleDirectTask(directTask("presence", "DEFINITIONS", {
    definitions: [{
      definitionId: "11:10", componentKey: "presence", name: "Control",
      nodes: [
        { id: "11:10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Control", width: 100, height: 24 },
        {
          id: "11:11", parent: "11:10", kind: "ORDINARY", type: "TEXT", name: "Label",
          width: 100, height: 24,
          text: {
            characters: "Hello", fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
            fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
          },
        },
      ],
    }],
  }), {});

  function presenceInstance(id, x, entry) {
    return {
      id: id, parent: "11:20", kind: "INSTANCE", type: "INSTANCE", name: "Control",
      definitionId: "11:10", x: x, width: 100, height: 24, overrides: [entry],
    };
  }
  function labelEntry(ops, present, raw) {
    return {
      path: [{ index: 0, sourceId: "11:11", sourceType: "TEXT", targetType: "TEXT", definitionId: "11:10", definitionPath: [0], name: "Label" }],
      ops: ops,
      present: present,
      diagnostic: {
        expectedTargetGuid: "11:11",
        textTrace: {
          targetGuid: "11:11", targetRelativePath: ["11:11"],
          rawOverrides: raw || [],
        },
      },
    };
  }

  var presenceRoot = await importer.handleDirectTask(directTask("presence", "ROOT", {
    pageId: "11:1", pageName: "Presence", rootId: "11:20", rootName: "Root",
    nodes: [
      { id: "11:20", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 700, height: 100 },
      // Симулируем ошибочный default между normalizer и IR: значение
      // появилось в ops, но raw-presence его не подтверждает.
      presenceInstance("11:21", 0, labelEntry(
        { characters: "", fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }] },
        { fills: true },
        [{ rawOverrideType: null, presentFields: ["fillPaints"], values: { fillPaints: ["red"] } }]
      )),
      presenceInstance("11:22", 110, labelEntry({ characters: "World" }, { characters: true })),
      presenceInstance("11:23", 220, labelEntry({ characters: "" }, { characters: true })),
      presenceInstance("11:24", 330, labelEntry({ characters: "Changed" }, { characters: true })),
      presenceInstance("11:25", 440, labelEntry({ visible: false }, { visible: true })),
      // Пакет от старого отправителя (или из snapshot-fallback): пустой список
      // с presence. У дельты Pixso нет доказанного представления «очистить
      // краски», поэтому приёмник обязан отказать, а не стереть базу.
      presenceInstance("11:26", 550, labelEntry({ fills: [] }, { fills: true })),
    ],
  }), { createPages: true });

  var presencePage = pages.filter(function (page) {
    return page.getPluginData("pixsoDirectSourcePageId") === "11:1";
  })[0];
  var occurrences = presencePage.children[0].children;
  eq(occurrences[0].children[0].characters, "Hello",
    "implicit empty text заблокирован, base characters сохранены");
  eq(occurrences[0].children[0].fills[0].color.r, 1,
    "независимая явная fill-правка из той же записи применена");
  eq(occurrences[1].children[0].characters, "World", "explicit text replacement применён");
  eq(occurrences[2].children[0].characters, "", "explicit empty text по-прежнему разрешён");
  eq(occurrences[3].children[0].characters, "Changed", "text-only patch применён");
  eq(occurrences[3].children[0].fills.length, 1, "missing paint не очистил base fills");
  eq(occurrences[3].children[0].fontSize, 14, "missing style не очистил base typography");
  eq(occurrences[4].children[0].characters, "Hello", "visibility patch не затронул characters");
  eq(occurrences[4].children[0].visible, false, "explicit visibility=false применен");
  eq(occurrences[5].children[0].characters, "Hello", "paint clear не затронул characters");
  eq(occurrences[5].children[0].fills.length, 1, "пустой список не стёр непустые base fills");
  eq(occurrences[5].children[0].fills[0].color.r, 0, "base fill остался тем же самым");

  eq(presenceRoot.overridesApplied, 5, "пять явных field-patches применены независимо");
  eq(presenceRoot.overridesMissed, 2, "implicit destructive field и пустой paint отклонены");
  eq(presenceRoot.overrideMissReasons.OVERRIDE_FIELD_NOT_EXPLICIT, 1,
    "причина блокировки названа обобщённым кодом");
  eq(presenceRoot.textOverrideCounters.textOverridesSeen, 4, "все text operations увидены");
  eq(presenceRoot.textOverrideCounters.textOverridesApplied, 3, "только presence-confirmed text operations применены");
  eq(presenceRoot.textOverrideCounters.explicitTextChanges, 3, "фактические текстовые изменения посчитаны");
  eq(presenceRoot.textOverrideCounters.explicitTextClears, 1, "явная очистка посчитана");
  eq(presenceRoot.textOverrideCounters.blockedImplicitTextClears, 1, "неявная очистка заблокирована и посчитана");
  eq(presenceRoot.textOverrideCounters.visibilityChanges, 1, "явная смена visibility посчитана");
  eq(presenceRoot.textOverrideCounters.paintClearsExplicit, 0, "очистка краски больше не выпускается");
  eq(presenceRoot.textOverrideCounters.paintOverridePresent, 2, "обе paint-операции дошли до приёмника");
  eq(presenceRoot.textOverrideCounters.paintOverrideApplied, 1, "применена только непустая");
  eq(presenceRoot.textOverrideCounters.paintClearRefused, 1, "пустой список отклонён и посчитан");
  eq(presenceRoot.textOverrideTraceSamples.length, 4, "TEXT trace ограничен заданным cap");
  eq(presenceRoot.textOverrideTraceSamples[0].before.characters, "Hello", "trace содержит BEFORE");
  eq(presenceRoot.textOverrideTraceSamples[0].after.characters, "Hello", "trace содержит AFTER после guard");
  ok(!presenceRoot.textOverrideTraceSamples[0].normalized.present.characters,
    "trace показывает, что destructive default не имел presence");

  var presenceFinish = await importer.handleDirectTask(directTask("presence", "FINISH", {}), {});
  eq(presenceFinish.textOverrideReport.blockedImplicitTextClears, 1,
    "finish возвращает destructive-guard counters");
  eq(presenceFinish.textOverrideReport.samples.length, 4,
    "finish возвращает bounded before/raw/IR/after samples");

  // -------------------------------------------------------------------------
  // 12. Активное определение под documentAccess: dynamic-page
  // -------------------------------------------------------------------------
  //
  // Запись, разрешённая в ЧУЖОМ определении, не имеет права примениться даже
  // тогда, когда индекс и тип узла на этом месте совпали. Ровно так чужой
  // текст и попадал внутрь подменённого компонента: несовпадение ловилось
  // случайной разницей типов, а шлюз контекста молчал, потому что читал
  // активное определение через синхронный `mainComponent`, который под
  // dynamic-page бросает.
  await importer.handleDirectTask(directTask("context", "START", { debugOverrides: true }), {});
  figma.__dynamicPageMainComponent = true;
  try {
    var contextDefinitions = [
      componentDef("8:10", "Text A", [
        { id: "8:11", parent: "8:10", kind: "ORDINARY", type: "TEXT", name: "Line", width: 20, height: 10, text: { characters: "A", fontName: { family: "Inter", style: "Regular" } } },
      ]),
      // Структурный близнец: тот же индекс, тот же тип, другое определение.
      componentDef("8:20", "Text B", [
        { id: "8:21", parent: "8:20", kind: "ORDINARY", type: "TEXT", name: "Line", width: 20, height: 10, text: { characters: "B", fontName: { family: "Inter", style: "Regular" } } },
      ]),
    ];
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", { definitions: contextDefinitions }), {});
    var contextRoot = await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:4", rootName: "Root",
      debugOverrides: true,
      nodes: [
        { id: "8:4", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", width: 100, height: 100 },
        {
          id: "8:5", parent: "8:4", kind: "INSTANCE", type: "INSTANCE", name: "Own context",
          definitionId: "8:20", width: 40, height: 40,
          overrides: [
            // Адрес разрешён в Text A, а вхождение показывает Text B.
            { path: [{ index: 0, sourceId: "8:11", definitionId: "8:10", targetType: "TEXT", name: "Line" }], ops: { characters: "Foreign" }, present: { characters: true } },
            // Адрес разрешён в активном определении — применяется.
            { path: [{ index: 0, sourceId: "8:21", definitionId: "8:20", targetType: "TEXT", name: "Line" }], ops: { characters: "Own" }, present: { characters: true } },
          ],
        },
      ],
    }), { createPages: true });

    eq(contextRoot.overrideMissReasons.WRONG_CANONICAL_DEFINITION, 1,
      "правка чужого определения отвергнута названной причиной");
    ok(!contextRoot.overrideMissReasons.TARGET_STRUCTURAL_TYPE_MISMATCH,
      "промах не свалился в несовпадение типа: типы здесь совпадают");
    var contextPage = pages.filter(function (page) {
      return page.getPluginData("pixsoDirectSourcePageId") === "8:3";
    })[0];
    var contextText = contextPage.children[0].children[0].children[0];
    eq(contextText.characters, "Own",
      "применена только правка активного определения");
    var contextSample = (contextRoot.overrideMissSamples || []).filter(function (sample) {
      return sample.reason === "WRONG_CANONICAL_DEFINITION";
    })[0];
    ok(contextSample, "у промаха контекста есть образец");
    eq(contextSample.expectedDefinitionId, "8:10", "образец называет ожидаемое определение");
    eq(contextSample.activeDefinitionId, "8:20",
      "образец называет активное определение, а не null: getter mainComponent для этого непригоден");

    // Две документные копии одного опубликованного компонента имеют разные
    // GUID, но общий componentKey. Адрес из соседней копии допустим только
    // при полном совпадении структурной сигнатуры; имя в доказательстве не
    // участвует. Это реальный library-update case Direct PIX.
    var copyA = componentDef("8:70", "Published copy A", [
      { id: "8:71", parent: "8:70", kind: "ORDINARY", type: "TEXT", name: "Old name", width: 20, height: 10, text: { characters: "A", fontName: { family: "Inter", style: "Regular" } } },
    ]);
    var copyB = componentDef("8:80", "Published copy B", [
      { id: "8:81", parent: "8:80", kind: "ORDINARY", type: "TEXT", name: "New name", width: 20, height: 10, text: { characters: "B", fontName: { family: "Inter", style: "Regular" } } },
    ]);
    copyA.componentKey = copyB.componentKey = "published-library-key";
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", { definitions: [copyA, copyB] }), {});
    var copyRoot = await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:82", rootName: "Equivalent copies",
      debugOverrides: true,
      nodes: [
        { id: "8:82", parent: null, kind: "ORDINARY", type: "FRAME", name: "Equivalent copies", width: 100, height: 100 },
        { id: "8:83", parent: "8:82", kind: "INSTANCE", type: "INSTANCE", name: "Copy B occurrence", definitionId: "8:80", width: 40, height: 40,
          overrides: [
            { path: [{ index: 0, sourceId: "8:71", definitionId: "8:70", definitionPath: [0], targetType: "TEXT", name: "Ignored" }], ops: { characters: "Translated" }, present: { characters: true } },
          ] },
      ],
    }), { createPages: true });
    ok(!copyRoot.overrideMissReasons.WRONG_CANONICAL_DEFINITION,
      "структурно тождественная копия одного componentKey не считается чужим определением");
    var copyText = contextPage.children[1].children[0].children[0];
    eq(copyText.characters, "Translated",
      "override соседней доказанно тождественной копии применяется по индексному адресу");

    // Физически доказанно тождественная published-копия может быть
    // алиасом ранее собранного Component. Но семантика корня всё равно
    // принадлежит каждому definitionId. До D61 root spec записывался
    // только в ветке физического создания: occurrence алиаса
    // получал сохранённую ширину 81 вместо HUG и обрезал длинный label.
    var hugAliasA = {
      definitionId: "8:140", componentKey: "published-hug-copy", name: "HUG copy A", nodes: [
        { id: "8:140", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "HUG copy A", width: 81, height: 28,
          autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
        { id: "8:141", parent: "8:140", kind: "ORDINARY", type: "TEXT", name: "Label", width: 81, height: 20,
          text: { characters: "Short", fontName: { family: "Inter", style: "Regular" }, textAutoResize: "WIDTH_AND_HEIGHT" },
          layout: { horizontalSizing: "HUG", verticalSizing: "HUG" } },
      ],
    };
    var hugAliasB = {
      definitionId: "8:150", componentKey: "published-hug-copy", name: "HUG copy B", nodes: [
        { id: "8:150", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "HUG copy B", width: 81, height: 28,
          autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
        { id: "8:151", parent: "8:150", kind: "ORDINARY", type: "TEXT", name: "Label", width: 81, height: 20,
          text: { characters: "Short", fontName: { family: "Inter", style: "Regular" }, textAutoResize: "WIDTH_AND_HEIGHT" },
          layout: { horizontalSizing: "HUG", verticalSizing: "HUG" } },
      ],
    };
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", {
      definitions: [hugAliasA, hugAliasB],
    }), {});
    await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:162", rootName: "Aliased HUG semantics", nodes: [
        { id: "8:162", parent: null, kind: "ORDINARY", type: "FRAME", name: "Aliased HUG semantics", width: 200, height: 80 },
        { id: "8:163", parent: "8:162", kind: "INSTANCE", type: "INSTANCE", name: "Aliased HUG occurrence",
          definitionId: "8:150", width: 81, height: 28 },
      ],
    }), { createPages: true });
    var hugAliasRoot = contextPage.children.filter(function (node) {
      return node.name === "Aliased HUG semantics";
    })[0];
    // Сохранение HUG у вхождения алиаса (D61) проверяется в
    // DirectPixDefinitionDedupTest на FigmaHost: заглушка этого файла не
    // переводит HUG в FIXED при resize(), и регресс здесь невидим.
    ok(hugAliasRoot && hugAliasRoot.children[0] && hugAliasRoot.children[0].type === "INSTANCE",
      "occurrence алиаса построено инстансом");

    // Одинаковый componentKey и одинаковые ТИПЫ дерева недостаточны, если
    // внутри копий разные nested components. Иначе stale library copy может
    // перенести override между повторяющимися menu/tab slots и подсветить
    // соседнюю иконку. Nested lineage входит в canonical-copy identity.
    var nestedLeafA = componentDef("8:100", "Nested leaf A", [
      { id: "8:101", parent: "8:100", kind: "ORDINARY", type: "TEXT", name: "Glyph", width: 20, height: 10, text: { characters: "A", fontName: { family: "Inter", style: "Regular" } } },
    ]);
    var nestedLeafB = componentDef("8:110", "Nested leaf B", [
      { id: "8:111", parent: "8:110", kind: "ORDINARY", type: "TEXT", name: "Glyph", width: 20, height: 10, text: { characters: "B", fontName: { family: "Inter", style: "Regular" } } },
    ]);
    nestedLeafA.componentKey = "nested-leaf-A";
    nestedLeafB.componentKey = "nested-leaf-B";
    var lineageCopyA = componentDef("8:120", "Lineage copy A", [
      { id: "8:121", parent: "8:120", kind: "INSTANCE", type: "INSTANCE", name: "Slot", definitionId: "8:100", width: 20, height: 20 },
    ]);
    var lineageCopyB = componentDef("8:130", "Lineage copy B", [
      { id: "8:131", parent: "8:130", kind: "INSTANCE", type: "INSTANCE", name: "Slot", definitionId: "8:110", width: 20, height: 20 },
    ]);
    lineageCopyA.componentKey = lineageCopyB.componentKey = "published-lineage-key";
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", { definitions: [nestedLeafA, nestedLeafB, lineageCopyA, lineageCopyB] }), {});
    var lineageRoot = await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:132", rootName: "Lineage copies",
      debugOverrides: true,
      nodes: [
        { id: "8:132", parent: null, kind: "ORDINARY", type: "FRAME", name: "Lineage copies", width: 100, height: 100 },
        { id: "8:133", parent: "8:132", kind: "INSTANCE", type: "INSTANCE", name: "Copy B occurrence", definitionId: "8:130", width: 40, height: 40,
          overrides: [
            { path: [{ index: 0, sourceId: "8:121", definitionId: "8:120", definitionPath: [0], targetType: "INSTANCE", name: "Slot" }],
              ops: { opacity: 0.25 }, present: { opacity: true } },
          ] },
      ],
    }), { createPages: true });
    eq(lineageRoot.overrideMissReasons.WRONG_CANONICAL_DEFINITION, 1,
      "копии с разным nested component lineage не считаются одним override namespace");

    // Одинаковые componentKey + структура НЕ дают права пересекать variant
    // coordinate. В реальном меню default/selected имеют одинаковое дерево,
    // но отличаются paint/visibility: разрешение такого пути подсвечивало
    // соседнюю иконку (bell) как выбранную.
    var variantA = componentDef("8:90", "state=default", [
      { id: "8:91", parent: "8:90", kind: "ORDINARY", type: "TEXT", name: "Glyph", width: 20, height: 10, text: { characters: "Default", fontName: { family: "Inter", style: "Regular" } } },
    ]);
    var variantB = componentDef("8:92", "state=selected", [
      { id: "8:93", parent: "8:92", kind: "ORDINARY", type: "TEXT", name: "Glyph", width: 20, height: 10, text: { characters: "Selected", fontName: { family: "Inter", style: "Regular" } } },
    ]);
    variantA.componentKey = variantB.componentKey = "published-variant-key";
    variantA.variantSet = { groupId: "8:89", variantName: "state=default", coordinate: { state: "default" } };
    variantB.variantSet = { groupId: "8:89", variantName: "state=selected", coordinate: { state: "selected" } };
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", { definitions: [variantA, variantB] }), {});
    var variantIdentityRoot = await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:94", rootName: "Variant identity",
      debugOverrides: true,
      nodes: [
        { id: "8:94", parent: null, kind: "ORDINARY", type: "FRAME", name: "Variant identity", width: 100, height: 100 },
        { id: "8:95", parent: "8:94", kind: "INSTANCE", type: "INSTANCE", name: "Selected occurrence", definitionId: "8:92", width: 40, height: 40,
          overrides: [
            { path: [{ index: 0, sourceId: "8:91", definitionId: "8:90", definitionPath: [0], targetType: "TEXT", name: "Glyph" }], ops: { characters: "WRONG" }, present: { characters: true } },
          ] },
      ],
    }), { createPages: true });
    eq(variantIdentityRoot.overrideMissReasons.WRONG_CANONICAL_DEFINITION, 1,
      "структурно одинаковый соседний variant не считается эквивалентной canonical copy");

    // Подмена переводит узел на другое определение, и адреса, посчитанные по
    // нему, обязаны пройти — иначе шлюз контекста ломал бы законные правки.
    var swapRoot = await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:6", rootName: "Swapped",
      debugOverrides: true,
      nodes: [
        { id: "8:6", parent: null, kind: "ORDINARY", type: "FRAME", name: "Swapped", width: 100, height: 100 },
        {
          id: "8:7", parent: "8:6", kind: "INSTANCE", type: "INSTANCE", name: "Swapped occurrence",
          definitionId: "8:10", width: 40, height: 40,
          overrides: [
            { path: [], ops: { swapDefinitionId: "8:20" }, present: { swapDefinitionId: true } },
            { path: [{ index: 0, sourceId: "8:21", definitionId: "8:20", targetType: "TEXT", name: "Line" }], ops: { characters: "After swap" }, present: { characters: true } },
          ],
        },
      ],
    }), { createPages: true });
    eq(swapRoot.overridesMissed, 0, "после подмены адрес активного определения не считается чужим");
    var swappedText = contextPage.children.filter(function (node) {
      return node.name === "Swapped";
    })[0].children[0].children[0];
    eq(swappedText.characters, "After swap", "правка после подмены применилась");

    // HUG-ось вложенного instance не принадлежит старому master. До фикса
    // directApplyOps безусловно возвращал 89 после swap и новый HUG master
    // шириной 109 становился искусственно узким (текст внутри переносился).
    var hugDefinitions = [
      {
        definitionId: "8:30", componentKey: "hug-old", name: "Old HUG", nodes: [
          { id: "8:30", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Old HUG", width: 89, height: 24,
            autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
          { id: "8:31", parent: "8:30", kind: "ORDINARY", type: "FRAME", name: "Old content", width: 89, height: 24 },
        ],
      },
      {
        definitionId: "8:40", componentKey: "hug-new", name: "New HUG", nodes: [
          { id: "8:40", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "New HUG", width: 109, height: 24,
            autoLayout: { layoutMode: "VERTICAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" } },
          { id: "8:41", parent: "8:40", kind: "ORDINARY", type: "FRAME", name: "New content", width: 109, height: 24 },
        ],
      },
      {
        definitionId: "8:50", componentKey: "holder", name: "Holder", nodes: [
          { id: "8:50", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Holder", width: 160, height: 40 },
          { id: "8:51", parent: "8:50", kind: "INSTANCE", type: "INSTANCE", name: "Slot", definitionId: "8:30", width: 89, height: 24 },
        ],
      },
    ];
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", { definitions: hugDefinitions }), {});
    await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "8:60", rootName: "HUG swap", nodes: [
        { id: "8:60", parent: null, kind: "ORDINARY", type: "FRAME", name: "HUG swap", width: 200, height: 80 },
        { id: "8:61", parent: "8:60", kind: "INSTANCE", type: "INSTANCE", name: "Holder occurrence", definitionId: "8:50", width: 160, height: 40,
          overrides: [
            { path: [{ index: 0, sourceId: "8:51", definitionId: "8:50", targetType: "INSTANCE", name: "Slot" }],
              ops: { swapDefinitionId: "8:40" }, present: { swapDefinitionId: true } },
          ] },
      ],
    }), { createPages: true });
    var hugRoot = contextPage.children.filter(function (node) { return node.name === "HUG swap"; })[0];
    var hugNested = hugRoot.children[0].children[0];
    eq(hugNested.width, 109, "HUG-ширина вложенного swap принимает размер нового master, а не старые 89");
    eq(hugNested.height, 24, "FIXED-высота вложенного swap остаётся стабильной");

    // D56. Обратный случай той же оси: слот узкий, новый master ШИРЕ и
    // объявляет `primaryAxisSizingMode: FIXED`. Figma после подмены переносит
    // текст по зажатой ширине и пересчитывает HUG-высоту вверх. Брать надо
    // натуральную высоту нового master, а не результат этого пересчёта.
    // Живой случай: таб бокового меню — слот 32×32, новый master 232×32,
    // без правила высота уходила на 252 и подпись вставала по одной букве.
    var narrowDefinitions = [
      {
        definitionId: "9:30", componentKey: "narrow-old", name: "Collapsed", nodes: [
          { id: "9:30", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Collapsed", width: 32, height: 32,
            autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
          { id: "9:31", parent: "9:30", kind: "ORDINARY", type: "FRAME", name: "Icon", width: 20, height: 20 },
        ],
      },
      {
        definitionId: "9:40", componentKey: "narrow-new", name: "Expanded", nodes: [
          { id: "9:40", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Expanded", width: 232, height: 32,
            autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" } },
          { id: "9:41", parent: "9:40", kind: "ORDINARY", type: "FRAME", name: "Icon", width: 20, height: 20 },
          { id: "9:42", parent: "9:40", kind: "ORDINARY", type: "TEXT", name: "Label", width: 192, height: 20,
            text: { characters: "Главная", fontName: { family: "Inter", style: "Regular" }, fontSize: 14 } },
        ],
      },
      {
        definitionId: "9:50", componentKey: "rail", name: "Rail", nodes: [
          { id: "9:50", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Rail", width: 56, height: 180 },
          { id: "9:51", parent: "9:50", kind: "INSTANCE", type: "INSTANCE", name: "Tab", definitionId: "9:30", width: 32, height: 32 },
        ],
      },
    ];
    figma.__rehugAfterSwap = true;
    await importer.handleDirectTask(directTask("context", "DEFINITIONS", { definitions: narrowDefinitions }), {});
    await importer.handleDirectTask(directTask("context", "ROOT", {
      pageId: "8:3", pageName: "Context", rootId: "9:60", rootName: "Narrow swap", nodes: [
        { id: "9:60", parent: null, kind: "ORDINARY", type: "FRAME", name: "Narrow swap", width: 56, height: 200 },
        { id: "9:61", parent: "9:60", kind: "INSTANCE", type: "INSTANCE", name: "Rail occurrence", definitionId: "9:50", width: 56, height: 180,
          overrides: [
            { path: [{ index: 0, sourceId: "9:51", definitionId: "9:50", targetType: "INSTANCE", name: "Tab" }],
              ops: { swapDefinitionId: "9:40" }, present: { swapDefinitionId: true } },
          ] },
      ],
    }), { createPages: true });
    var narrowRoot = contextPage.children.filter(function (node) { return node.name === "Narrow swap"; })[0];
    var narrowNested = narrowRoot.children[0].children[0];
    figma.__rehugAfterSwap = false;
    // Оговорка: фейковый хост не пересчитывает auto layout, поэтому здесь
    // фиксируется ОЖИДАЕМОЕ значение, а не ловится пересчёт. Само правило
    // выведено из замера живой Figma (32 → 252 на табе бокового меню) и
    // описано в `directRestoreOwnedSwapSize`.
    eq(narrowNested.height, 32,
      "HUG-высота после подмены берётся у нового master, а не пересчитывается по зажатой ширине");
    eq(narrowNested.width, 232,
      "ось, объявленную новым master как FIXED, восстановление коробки не трогает");
  } finally {
    figma.__dynamicPageMainComponent = false;
  }

  // -------------------------------------------------------------------------
  // D54. Владелец component property не ищется по индексу и по именам.
  //
  // Шаг пути — канонический СЛОТ, а не «любой потомок с таким же свойством».
  // Если строгий адрес не сошёлся, свойство обязано стать честным промахом:
  // переназначение на соседний слот переносит правку не туда и пересобирает
  // его поддерево. На живом файле такая правка дала 54 цели мимо и
  // `overridesMissed` 41 → 1077.
  // -------------------------------------------------------------------------
  resetFigma();
  var slotDefinition = {
    definitionId: "p:10", componentKey: "key-slot", name: "Slot",
    nativeProperties: [{ propertyId: "prop:vis", name: "show", type: "BOOLEAN", defaultValue: true }],
    nodes: [
      { id: "p:10", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Slot", width: 40, height: 20 },
      { id: "p:11", parent: "p:10", kind: "ORDINARY", type: "TEXT", name: "Подпись", width: 40, height: 20,
        text: { characters: "текст", fontName: { family: "Inter", style: "Regular" }, fontSize: 12 },
        componentPropertyReferences: { visible: "prop:vis" } },
    ],
  };
  var wrapperDefinition = {
    definitionId: "p:20", componentKey: "key-wrapper", name: "Wrapper",
    nodes: [
      { id: "p:20", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Wrapper", width: 40, height: 40 },
      { id: "p:21", parent: "p:20", kind: "INSTANCE", type: "INSTANCE", name: "Слот 1", definitionId: "p:10", width: 40, height: 20 },
      { id: "p:22", parent: "p:20", kind: "INSTANCE", type: "INSTANCE", name: "Слот 2", definitionId: "p:10", width: 40, height: 20 },
    ],
  };

  await importer.handleDirectTask(directTask("jp", "START", { source: { fileName: "Props.pix" } }), {});
  await importer.handleDirectTask(
    directTask("jp", "DEFINITIONS", { definitions: [slotDefinition, wrapperDefinition] }), {});
  var propsRoot = await importer.handleDirectTask(directTask("jp", "ROOT", {
    pageId: "p:1", pageName: "Props", rootId: "p:30", rootName: "Экран", nodes: [
      { id: "p:30", parent: null, kind: "ORDINARY", type: "FRAME", name: "Экран", width: 80, height: 60 },
      {
        id: "p:31", parent: "p:30", kind: "INSTANCE", type: "INSTANCE", name: "Обёртка",
        definitionId: "p:20", width: 40, height: 40,
        // Адрес не сходится: такого sourceId в определении нет. Индекс 0 при
        // этом указывал бы на живой соседний слот `p:21` — именно туда и
        // уводило удалённое переназначение.
        nativeProperties: [{
          path: [{ index: 0, sourceId: "p:99", definitionId: "p:20", targetType: "INSTANCE", name: "Слот 1" }],
          propertyId: "prop:vis", type: "BOOLEAN", value: false,
        }],
      },
    ],
  }), { createPages: true });

  var propsFinish = await importer.handleDirectTask(directTask("jp", "FINISH", {}), {});
  eq(propsFinish.nativePropertyReport.valuesApplied, 0,
    "несошедшийся адрес свойства не применяется ни к какому слоту");
  ok((propsFinish.nativePropertyReport.valuesMissed || 0) >= 1,
    "несошедшийся адрес свойства посчитан промахом, а не тихо переназначен");
  eq(propsFinish.nativePropertyReport.targetsReboundByIndex, undefined,
    "счётчика переназначения по индексу больше нет: путь удалён вместе с ним");

  var propsPage = pages.filter(function (page) { return page.name === "Props"; })[0];
  var wrapperOccurrence = propsPage.children[0].children[0];
  eq(wrapperOccurrence.children.length, 2, "оба слота обёртки построены");
  wrapperOccurrence.children.forEach(function (slot, index) {
    var label = slot.children[0];
    ok(label && label.visible !== false,
      "слот " + (index + 1) + " не скрыт: правка не переехала на соседний слот");
  });

  process.stdout.write("OK: Direct PIX приём миграции (Figma) — " + checks + " проверок пройдено\n");
}

run().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
});
