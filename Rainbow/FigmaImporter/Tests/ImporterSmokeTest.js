"use strict";
var assert = require("assert");
var importer = require("../Main.js");
var bridge = require("../../Bridge/Server.js");

var pkg = {
  format: "pixso-portable-package",
  roots: [{ nodeRef: "node:screen" }],
  nodes: {
    "node:screen": { id: "node:screen", type: "FRAME", position: { x: -1589, y: -160 }, children: ["node:button"] },
    "node:button": { id: "node:button", type: "INSTANCE" },
    "node:component-a": { id: "node:component-a", type: "COMPONENT", children: ["node:nested"] },
    "node:nested": { id: "node:nested", type: "INSTANCE" },
    "node:component-b": { id: "node:component-b", type: "COMPONENT" },
    "node:unused": { id: "node:unused", type: "COMPONENT" }
  },
  instances: {
    "node:button": { preset: { definitionRef: "component:a" } },
    "node:nested": { preset: { definitionRef: "component:b" } }
  },
  components: {
    "component:a": { portableId: "component:a", rootNodeRef: "node:component-a" },
    "component:b": { portableId: "component:b", rootNodeRef: "node:component-b" },
    "component:unused": { portableId: "component:unused", rootNodeRef: "node:unused" }
  },
  componentSets: {},
  dependencies: { order: ["component:b", "component:a", "component:unused"] }
};

assert.deepStrictEqual(importer.collectRequiredComponents(pkg, false), ["component:b", "component:a"]);
assert.deepStrictEqual(importer.collectRequiredComponents(pkg, true), ["component:b", "component:a", "component:unused"]);
assert.deepStrictEqual(importer.rootOffset(pkg), { x: 1589, y: 160 });

assert.strictEqual(importer.screenNeedsComponentDefinitions(pkg), true);
assert.strictEqual(importer.hasResolvedScreenInstances(pkg), false);

var snapshotPkg = JSON.parse(JSON.stringify(pkg));
snapshotPkg.transferMode = "VISUAL_SNAPSHOT";
snapshotPkg.nodes["node:button"].children = ["node:snapshot-label"];
snapshotPkg.nodes["node:snapshot-label"] = { id: "node:snapshot-label", type: "TEXT", children: [] };
assert.strictEqual(importer.hasResolvedScreenInstances(snapshotPkg), true);
var variantPreset = { definitionSetName: "Button", definitionName: "State=Default, Size=M", variantProperties: { Size: "M", State: "Default" } };
assert.strictEqual(importer.semanticSignature(variantPreset), '{"set":"Button","component":"State=Default, Size=M","variants":{"Size":"M","State":"Default"}}');
assert.strictEqual(importer.variantComponentName(variantPreset), "Size=M, State=Default");

var verticalFillTarget = { parent: { layoutMode: "VERTICAL" }, layoutMode: "NONE" };
importer.applyFigmaChildSizing(verticalFillTarget, { layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" });
assert.strictEqual(verticalFillTarget.layoutAlign, "STRETCH");
assert.strictEqual(verticalFillTarget.layoutGrow, 0);

var horizontalFillFrame = { parent: { layoutMode: "HORIZONTAL" }, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO" };
importer.applyFigmaChildSizing(horizontalFillFrame, { layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" });
assert.strictEqual(horizontalFillFrame.layoutGrow, 1);
assert.strictEqual(horizontalFillFrame.primaryAxisSizingMode, "FIXED");

var constrainedTarget = {};
importer.applyChildConstraints(constrainedTarget, { constraints: { horizontal: "STRETCH", vertical: "CENTER" } });
assert.deepStrictEqual(constrainedTarget.constraints, { horizontal: "STRETCH", vertical: "CENTER" });

assert.strictEqual(importer.isStrokeVectorFallback({
  type: "VECTOR",
  size: { width: 640, height: 1 },
  geometry: { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }
}), true);
assert.strictEqual(importer.isStrokeVectorFallback({
  type: "VECTOR",
  size: { width: 24, height: 24 },
  geometry: { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }
}), false);

var svgWrapper = {
  type: "FRAME",
  fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
  strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
  resizeWithoutConstraints: function (width, height) { this.width = width; this.height = height; },
  getPluginData: function (key) { return key === "pixsoSvgRoot" ? "1" : ""; },
  setPluginData: function () {}
};
assert.strictEqual(importer.isSvgRootNode(svgWrapper), true);
importer.applyCommon(svgWrapper, {
  id: "node:icon",
  type: "ICON",
  name: "Icon/search",
  size: { width: 20, height: 20 },
  geometry: {
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }],
    strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }]
  }
}, {}, { warnings: [] });
assert.deepStrictEqual(svgWrapper.fills, []);
assert.deepStrictEqual(svgWrapper.strokes, []);

assert.deepStrictEqual(importer.sanitizeChildLayout({
  layoutSizingHorizontal: "FILL",
  layoutSizingVertical: "HUG",
  minHeight: 40,
  minWidth: 20,
  maxWidth: 120
}, { width: 68, height: 32 }), {
  layoutSizingHorizontal: "FILL",
  layoutSizingVertical: "HUG",
  minWidth: 20,
  maxWidth: 120
});

// ---------------------------------------------------------------------------
// Receiver mode: сессия без cross-chunk дедупликации ассетов.
// Manual import этих путей не использует.
// ---------------------------------------------------------------------------

// Версия транспорта bridge берётся из самого bridge: захардкоженное число
// здесь снова разошлось бы с протоколом. Версия Direct PIX payload — отдельная
// и не меняется.
assert.strictEqual(importer.PROTOCOL_VERSION, bridge.PROTOCOL_VERSION,
  "приёмник и bridge согласованы по версии транспорта");
assert.strictEqual(importer.DIRECT_PROTOCOL_VERSION, 1,
  "версия Direct PIX payload не связана с транспортом");
assert.ok(importer.RECEIVER_VERSION);

// Дедупликация ассетов удалена целиком: приёмник больше не хранит кеш ассетов
// и не умеет подставлять их в чужой пакет. Каждый пакет самодостаточен.
assert.strictEqual(typeof importer.rehydrateAssets, "undefined",
  "rehydrateAssets удалён вместе с cross-chunk дедупликацией");
assert.strictEqual(typeof importer.rememberAssets, "undefined",
  "rememberAssets удалён вместе с cross-chunk дедупликацией");

var freshSession = importer.newSession("job-1", { fileName: "Doc" });
assert.strictEqual(freshSession.assets, undefined, "в сессии приёмника нет реестра ассетов");
assert.deepStrictEqual(freshSession.processedTasks, {}, "идемпотентность по taskId сохранена");
assert.strictEqual(freshSession.firstPage, null, "первая страница запоминается для финального вьюпорта");
assert.strictEqual(freshSession.timing.importMs, 0, "сессия копит FIGMA_IMPORT_MS");

// ---------------------------------------------------------------------------
// Кеш загрузки шрифтов: один и тот же family/style грузится один раз.
// ---------------------------------------------------------------------------

var fontCalls = [];

// ---------------------------------------------------------------------------
// Страница загружается и активируется один раз, а не на каждый chunk.
// ---------------------------------------------------------------------------

async function pageStateChecks() {
  var loads = 0, switches = 0;
  var pageA = { id: "page-a", loadAsync: function () { loads += 1; return Promise.resolve(); } };
  var pageB = { id: "page-b", loadAsync: function () { loads += 1; return Promise.resolve(); } };
  global.figma = {
    currentPage: pageA,
    setCurrentPageAsync: function (page) { switches += 1; global.figma.currentPage = page; return Promise.resolve(); },
  };

  await importer.ensurePageLoaded(pageA);
  await importer.ensurePageLoaded(pageA);
  await importer.ensurePageLoaded(pageA);
  assert.strictEqual(loads, 1, "уже загруженная страница не грузится повторно");

  await importer.ensureCurrentPage(pageA);
  assert.strictEqual(switches, 0, "переключение на уже активную страницу не выполняется");

  await importer.ensureCurrentPage(pageB);
  assert.strictEqual(switches, 1, "переход на другую страницу выполняется");
  await importer.ensureCurrentPage(pageB);
  assert.strictEqual(switches, 1, "и только один раз");

  await importer.ensurePageLoaded(pageB);
  assert.strictEqual(loads, 2, "новая страница загружается ровно один раз");

  // Отсутствующая страница и страница без loadAsync не должны ронять импорт.
  await importer.ensurePageLoaded(null);
  await importer.ensurePageLoaded({ id: "no-load" });
  await importer.ensureCurrentPage(null);
  assert.strictEqual(loads, 2, "страницы без loadAsync проходят без обращений");
}

async function fontCacheChecks() {
  global.figma = {
    loadFontAsync: function (font) {
      fontCalls.push(font.family + "::" + font.style);
      if (font.family === "Missing") return Promise.reject(Error("нет шрифта"));
      return Promise.resolve();
    }
  };
  await Promise.all([
    importer.loadFontCached({ family: "Inter", style: "Regular" }),
    importer.loadFontCached({ family: "Inter", style: "Regular" }),
  ]);
  await importer.loadFontCached({ family: "Inter", style: "Regular" });
  await importer.loadFontCached({ family: "Inter", style: "Bold" });
  assert.deepStrictEqual(fontCalls, ["Inter::Regular", "Inter::Bold"],
    "повторные запросы шрифта берутся из кеша, параллельные — сходятся в одну загрузку");

  // Неудача не кешируется: недоступный шрифт можно попробовать снова.
  await importer.loadFontCached({ family: "Missing", style: "Regular" }).catch(function () {});
  await importer.loadFontCached({ family: "Missing", style: "Regular" }).catch(function () {});
  assert.strictEqual(fontCalls.filter(function (k) { return k === "Missing::Regular"; }).length, 2,
    "ошибка загрузки шрифта не остаётся в кеше");
}

// Regression: ручной импорт по-прежнему нормализует координаты корней.
assert.deepStrictEqual(importer.rootOffset(pkg), { x: 1589, y: 160 });


// ---------------------------------------------------------------------------
// isAlive: у удалённого узла Figma бросает на ЛЮБОМ обращении к свойству,
// включая .removed. Именно на этом падала миграция при промоушене вложенных
// snapshot-инстансов.
// ---------------------------------------------------------------------------

assert.strictEqual(importer.isAlive(null), false);
assert.strictEqual(importer.isAlive(undefined), false);

var liveNode = { removed: false, parent: { id: "page" }, type: "FRAME" };
assert.strictEqual(importer.isAlive(liveNode), true);

var removedNode = { removed: true, parent: { id: "page" } };
assert.strictEqual(importer.isAlive(removedNode), false);

var detachedNode = { removed: false, parent: null };
assert.strictEqual(importer.isAlive(detachedNode), false);

// Висячая ссылка: обращение к свойству бросает, как в реальном Figma API.
var danglingNode = {};
Object.defineProperty(danglingNode, "removed", {
  get: function () { throw Error('in get_parent: The node with id "3:781" does not exist'); }
});
assert.strictEqual(importer.isAlive(danglingNode), false);

var danglingParent = { removed: false };
Object.defineProperty(danglingParent, "parent", {
  get: function () { throw Error('in get_parent: The node with id "3:781" does not exist'); }
});
assert.strictEqual(importer.isAlive(danglingParent), false);

// Страница живёт без parent-проверки.
assert.strictEqual(importer.isPageAlive({ removed: false }), true);
assert.strictEqual(importer.isPageAlive({ removed: true }), false);
assert.strictEqual(importer.isPageAlive(null), false);
var danglingPage = {};
Object.defineProperty(danglingPage, "removed", {
  get: function () { throw Error("The node with id \"1:1\" does not exist"); }
});
assert.strictEqual(importer.isPageAlive(danglingPage), false);

// ---------------------------------------------------------------------------
// Component-aware импорт: ссылка на определение + публичные свойства.
// Имена компонентов в фикстуре бессмысленны намеренно: поведение не должно
// зависеть от дизайн-системы.
// ---------------------------------------------------------------------------

var freshReport = importer.newReport("screen");
assert.strictEqual(freshReport.fastInstances, 0);
assert.strictEqual(freshReport.propertiesApplied, 0);
assert.strictEqual(freshReport.nestedTargetsMissed, 0);

function fakeInstance(name, children, properties) {
  return {
    type: "INSTANCE",
    name: name,
    children: children || [],
    componentProperties: properties || {},
    applied: [],
    setProperties: function (props) {
      this.applied.push(props);
      Object.keys(props).forEach(function (key) {
        this.componentProperties[key] = { value: props[key] };
      }, this);
    },
  };
}

// Индексный путь: два ребёнка с одинаковым именем адресуются по индексу.
var twinA = { type: "FRAME", name: "same", children: [] };
var twinB = fakeInstance("same", []);
var host = fakeInstance("host", [twinA, twinB]);
assert.strictEqual(
  importer.findByIndexPath(host, [{ name: "same", type: "INSTANCE", index: 1 }]),
  twinB,
  "одноимённые узлы различаются индексом канонического пути"
);
// Индекс уехал, но имя уникально среди детей — безопасный запасной путь.
assert.strictEqual(
  importer.findByIndexPath({ children: [twinA] }, [{ name: "same", index: 3 }]),
  twinA
);
// Имя неуникально и индекс не совпал — это неоднозначность, а не догадка.
assert.strictEqual(
  importer.findByIndexPath(host, [{ name: "same", index: 7 }]),
  null,
  "неоднозначный адрес не разрешается по имени"
);
assert.strictEqual(importer.findByIndexPath(host, [{ name: "нет такого", index: 0 }]), null);

// Разрешение имени свойства: реестр job → сырое имя Pixso → логическое имя.
var propState = { propertyNames: { "property:caption-abc": "Caption#77:1" }, report: importer.newReport("screen") };
var propTarget = fakeInstance("t", [], { "Caption#77:1": { value: "a" }, "Flag#77:2": { value: true } });
assert.strictEqual(
  importer.resolvePropertyName(propTarget, { propertyRef: "property:caption-abc", name: "Caption" }, propState),
  "Caption#77:1"
);
assert.strictEqual(
  importer.resolvePropertyName(propTarget, { propertyRef: "property:missing", rawName: "Flag#77:2", name: "Flag" }, propState),
  "Flag#77:2"
);
assert.strictEqual(
  importer.resolvePropertyName(propTarget, { propertyRef: "property:missing", name: "Flag" }, propState),
  "Flag#77:2",
  "единственное совпадение по логическому имени допустимо"
);
var ambiguous = fakeInstance("t", [], { "Flag#1": { value: true }, "Flag#2": { value: false } });
assert.strictEqual(
  importer.resolvePropertyName(ambiguous, { propertyRef: "property:x", name: "Flag" }, propState),
  null,
  "неоднозначное логическое имя — отказ, а не выбор наугад"
);

/**
 * Точка, в которой падала миграция: инстанс варианта внутри определения
 * компонента. Схема обязана разрешаться через COMPONENT_SET, а недоступная
 * схема — не бросать.
 */
async function variantInstanceChecks() {
  var applied = [];
  var variantInstance = {
    type: "INSTANCE",
    name: "vex use",
    mainComponent: variantComponent,
    setProperties: function (props) { applied.push(props); },
  };
  var state = { report: importer.newReport("definitions"), propertyNames: {} };

  await importer.applyInstanceProperties(variantInstance, {
    componentProperties: { "Label": { type: "TEXT", value: "привет" } },
  }, state);
  assert.deepStrictEqual(applied[0], { "Label#2:1": "привет" },
    "имя свойства варианта разрешено через его COMPONENT_SET");
  assert.strictEqual(state.report.variantSchemaViaSet, 1);

  // Асинхронный геттер main component — тот же путь.
  var asyncApplied = [];
  await importer.applyInstanceProperties({
    type: "INSTANCE",
    name: "vex async",
    getMainComponentAsync: function () { return Promise.resolve(variantComponent); },
    setProperties: function (props) { asyncApplied.push(props); },
  }, { componentProperties: { "Label": { type: "TEXT", value: "x" } } },
    { report: importer.newReport("definitions"), propertyNames: {} });
  assert.deepStrictEqual(asyncApplied[0], { "Label#2:1": "x" });

  // Схема недоступна целиком: не бросаем и не отменяем импорт.
  var orphan = throwsOnPropertyDefinitions({ type: "COMPONENT", name: "lone", parent: null });
  var orphanState = { report: importer.newReport("definitions"), propertyNames: {} };
  await importer.applyInstanceProperties({
    type: "INSTANCE", name: "orphan use", mainComponent: orphan,
    setProperties: function () { throw new Error("Figma отвергла свойство"); },
  }, { componentProperties: { "Label": { type: "TEXT", value: "x" } } }, orphanState);
  assert.strictEqual(orphanState.report.warnings.length, 1,
    "отказ применения свойства — предупреждение, а не остановка импорта");

  // Инстанс без mainComponent вообще.
  await importer.applyInstanceProperties({
    type: "INSTANCE", name: "detached", mainComponent: null,
    setProperties: function () { throw new Error("не должно вызываться при пустых props"); },
  }, { componentProperties: {} }, { report: importer.newReport("definitions"), propertyNames: {} });
}

async function fastInstanceChecks() {
  var deepTarget = fakeInstance("deep", [], { "Deep#4:1": { value: true } });
  var nestedTarget = fakeInstance("nested", [deepTarget], { "mode": { value: "a" }, "Text#3:1": { value: "old" } });
  var rootInstance = fakeInstance("root", [{ type: "FRAME", name: "other", children: [] }, nestedTarget], {
    "Caption#1:1": { value: "old" },
  });
  var state = {
    report: importer.newReport("screen"),
    propertyNames: {},
    registry: { defs: { "component:swap": { id: "1:2", removed: false, parent: {} } } },
  };

  await importer.applyFastInstance(rootInstance, {
    componentRef: "component:root",
    properties: [
      { propertyRef: "p1", rawName: "Caption#1:1", name: "Caption", type: "TEXT", value: "новое" },
      // VARIANT корня не применяется: инстанс уже создан от нужного варианта.
      { propertyRef: "p0", rawName: "mode", name: "mode", type: "VARIANT", value: "b" },
    ],
    nested: [
      {
        // Путь всегда от корня инстанса: глубина 2 — два шага.
        path: [{ name: "nested", type: "INSTANCE", index: 1 }, { name: "deep", index: 0 }],
        depth: 2,
        properties: [{ propertyRef: "p9", rawName: "нет", name: "нет", type: "BOOLEAN", value: false }],
      },
      {
        path: [{ name: "nested", type: "INSTANCE", index: 1 }],
        depth: 1,
        properties: [
          { propertyRef: "p2", rawName: "mode", name: "mode", type: "VARIANT", value: "b" },
          { propertyRef: "p3", rawName: "Text#3:1", name: "Text", type: "TEXT", value: "вложено" },
        ],
      },
    ],
  }, state);

  assert.strictEqual(rootInstance.applied.length, 1, "корню применяются только не-VARIANT свойства");
  assert.deepStrictEqual(rootInstance.applied[0], { "Caption#1:1": "новое" });
  // Глубина 1 обрабатывается раньше глубины 2: смена варианта меняет поддерево.
  assert.deepStrictEqual(nestedTarget.applied[0], { "mode": "b" }, "VARIANT вложенной цели идёт первым");
  assert.deepStrictEqual(nestedTarget.applied[1], { "Text#3:1": "вложено" }, "остальные свойства — после варианта");
  assert.strictEqual(state.report.nestedTargetsMissed, 0);
  // Свойства, которых нет на цели, считаются потерянными, а не подставляются наугад.
  assert.ok(state.report.propertiesMissed >= 1, "непроставленное свойство попадает в диагностику");

  // Недостижимая цель не роняет импорт, но обязана быть посчитана.
  var lonely = fakeInstance("lonely", []);
  var lonelyState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyFastInstance(lonely, {
    nested: [{ path: [{ name: "нет", index: 0 }], depth: 1, properties: [] }],
  }, lonelyState);
  assert.strictEqual(lonelyState.report.nestedTargetsMissed, 1);

  // INSTANCE_SWAP разрешается в id уже созданного нативного компонента.
  var swapTarget = fakeInstance("swap", [], { "Slot#2:4": { value: "" } });
  var swapState = {
    report: importer.newReport("screen"),
    propertyNames: {},
    registry: { defs: { "component:swap": { id: "9:9", removed: false, parent: {} } } },
  };
  await importer.applyFastInstance(swapTarget, {
    properties: [{ propertyRef: "ps", rawName: "Slot#2:4", name: "Slot", type: "INSTANCE_SWAP", swapComponentRef: "component:swap" }],
  }, swapState);
  assert.deepStrictEqual(swapTarget.applied[0], { "Slot#2:4": "9:9" });

  // Определение не доехало — свойство не выдумывается.
  var missingSwap = fakeInstance("swap", [], { "Slot#2:4": { value: "" } });
  var missingState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyFastInstance(missingSwap, {
    properties: [{ propertyRef: "ps", rawName: "Slot#2:4", name: "Slot", type: "INSTANCE_SWAP", swapComponentRef: "component:gone" }],
  }, missingState);
  assert.strictEqual(missingSwap.applied.length, 0);
  assert.strictEqual(missingState.report.propertiesMissed, 1);
}

// ---------------------------------------------------------------------------
// Regression: componentPropertyDefinitions у варианта внутри COMPONENT_SET.
//
// Именно здесь падала миграция на задаче COMPONENT_DEFS:
//   "in get_componentPropertyDefinitions: Can only get component property
//    definitions of a component set or non-variant component"
// ---------------------------------------------------------------------------

function throwsOnPropertyDefinitions(target) {
  Object.defineProperty(target, "componentPropertyDefinitions", {
    configurable: true,
    enumerable: false,
    get: function () {
      throw new Error(
        "in get_componentPropertyDefinitions: Can only get component property " +
        "definitions of a component set or non-variant component"
      );
    },
  });
  return target;
}

var variantSet = {
  type: "COMPONENT_SET",
  name: "Vex",
  componentPropertyDefinitions: {
    "mode": { type: "VARIANT", variantOptions: ["a", "b"] },
    "Label#2:1": { type: "TEXT", defaultValue: "" },
  },
};
var variantComponent = throwsOnPropertyDefinitions({ type: "COMPONENT", name: "mode=b", parent: variantSet });
var standaloneComponent = { type: "COMPONENT", name: "Zorp", parent: null, componentPropertyDefinitions: { "Caption#1:1": { type: "TEXT" } } };

// Фикстура честная: прямое обращение действительно бросает.
assert.throws(function () { return variantComponent.componentPropertyDefinitions; },
  /Can only get component property definitions/);

// (1) Безопасное чтение не бросает.
assert.doesNotThrow(function () { importer.readComponentPropertyDefinitions(variantComponent); });
assert.deepStrictEqual(importer.readComponentPropertyDefinitions(variantComponent), {});
assert.deepStrictEqual(importer.readComponentPropertyDefinitions(null), {});

// (2) Владелец схемы варианта — его COMPONENT_SET.
assert.strictEqual(importer.propertyDefinitionOwner(variantComponent), variantSet);
assert.ok(importer.getComponentPropertyDefinitions(variantComponent)["Label#2:1"]);

// (3) Одиночный компонент читает собственную схему.
assert.strictEqual(importer.propertyDefinitionOwner(standaloneComponent), standaloneComponent);
assert.ok(importer.getComponentPropertyDefinitions(standaloneComponent)["Caption#1:1"]);

// (4) COMPONENT_SET — владелец собственной схемы; нечитаемый сет даёт {}.
assert.strictEqual(importer.propertyDefinitionOwner(variantSet), variantSet);
assert.deepStrictEqual(importer.getComponentPropertyDefinitions(throwsOnPropertyDefinitions({ type: "COMPONENT_SET" })), {});
assert.deepStrictEqual(importer.getComponentPropertyDefinitions(null), {});

// (5) Разрешение через сет попадает в диагностику, а не в лог на каждый инстанс.
var ownerState = { report: importer.newReport("definitions") };
importer.getComponentPropertyDefinitions(variantComponent, ownerState);
importer.getComponentPropertyDefinitions(standaloneComponent, ownerState);
assert.strictEqual(ownerState.report.variantSchemaViaSet, 1);

// Локальный стиль создаётся один раз на job: у style нет parent, поэтому
// проверка живости у него своя.
assert.strictEqual(importer.isStyleAlive({ removed: false }), true);
assert.strictEqual(importer.isStyleAlive({ removed: true }), false);
assert.strictEqual(importer.isStyleAlive(null), false);
var danglingStyle = {};
Object.defineProperty(danglingStyle, "removed", {
  get: function () { throw Error("style does not exist"); }
});
assert.strictEqual(importer.isStyleAlive(danglingStyle), false);

// Реестр определений живёт всю job: иначе каждый chunk пересоздавал бы
// одни и те же компоненты.
var registrySession = importer.newSession("job-defs", null);
assert.deepStrictEqual(registrySession.nativeRegistry.defs, {});
assert.deepStrictEqual(registrySession.nativeRegistry.propertyNames, {});
// Уникальные определения и созданные внутри них узлы — разные метрики.
assert.strictEqual(registrySession.totals.uniqueDefinitionsImported, 0);
assert.strictEqual(registrySession.totals.componentsImported, 0);
assert.strictEqual(registrySession.totals.componentSetsImported, 0);
assert.strictEqual(registrySession.totals.definitionNodesCreated, 0);
assert.strictEqual(registrySession.totals.definitions, undefined,
  "старая двусмысленная метрика definitions убрана");
assert.strictEqual(registrySession.timing.definitionTasks, 0);
assert.strictEqual(registrySession.totals.fastInstances, 0);
assert.strictEqual(typeof importer.importDefinitions, "function");

// ---------------------------------------------------------------------------
// Промоушен: нативный результат component-aware пути не переделывается.
// ---------------------------------------------------------------------------

function promoteState(candidates, created, nodes, pkg) {
  return {
    pkg: pkg, report: Object.assign(importer.newReport("screen"), { created: created }),
    nodes: nodes, promotionCandidates: candidates, slice: null,
  };
}

// §29: корень целиком из нативных инстансов — кандидатов нет, сканировать нечего.
var nativeOnlyPkg = { nodes: {}, instances: {}, roots: [{ nodeRef: "n0" }] };
var nativeNodes = {};
for (var ni = 0; ni < 1000; ni++) {
  var refId = "n" + ni;
  nativeOnlyPkg.nodes[refId] = { id: refId, type: "INSTANCE", name: "x", instanceRef: { componentRef: "c" } };
  nativeOnlyPkg.instances[refId] = { preset: { definitionName: "Zorp", variantProperties: {} } };
  nativeNodes[refId] = { type: "INSTANCE", name: "x", removed: false, parent: {} };
}
var nativeState = promoteState([], 1000, nativeNodes, nativeOnlyPkg);
var nativeGroups = importer.collectSemanticGroups(nativeOnlyPkg, nativeState);
assert.strictEqual(nativeGroups.length, 0, "нативные инстансы не образуют групп промоушена");
assert.strictEqual(nativeState.report.promoteScanNodes, 0, "полный обход дерева не выполняется");
assert.strictEqual(nativeState.report.nodesSkippedFromPromoteScan, 1000, "все 1000 узлов пропущены");

// §31: даже попав в список кандидатов, уже нативный инстанс отсекается.
var doubleState = promoteState(
  [{ ref: "n0", source: nativeOnlyPkg.nodes.n0, depth: 0 }], 1000, nativeNodes, nativeOnlyPkg);
assert.strictEqual(importer.collectSemanticGroups(nativeOnlyPkg, doubleState).length, 0,
  "цель типа INSTANCE — финальный результат, повторному промоушену не подлежит");
assert.strictEqual(doubleState.report.nativeSubtreesPruned, 1, "отсечение посчитано");
assert.strictEqual(doubleState.report.promoteCandidates, 0);

// §30: смешанный корень — рассматриваются только snapshot-кандидаты.
var mixedPkg = { nodes: {}, instances: {}, roots: [{ nodeRef: "m0" }] };
var mixedNodes = {};
[["m0", "INSTANCE"], ["m1", "FRAME"], ["m2", "FRAME"]].forEach(function (pair, index) {
  mixedPkg.nodes[pair[0]] = { id: pair[0], type: "INSTANCE", name: "n" + index };
  mixedPkg.instances[pair[0]] = { preset: { definitionName: index === 2 ? "Blob" : "Zorp", variantProperties: {} } };
  mixedNodes[pair[0]] = { type: pair[1], name: "n" + index, removed: false, parent: {} };
});
var mixedState = promoteState([
  { ref: "m0", source: mixedPkg.nodes.m0, depth: 0 },
  { ref: "m1", source: mixedPkg.nodes.m1, depth: 2 },
  { ref: "m2", source: mixedPkg.nodes.m2, depth: 1 },
], 500, mixedNodes, mixedPkg);
var mixedGroups = importer.collectSemanticGroups(mixedPkg, mixedState);
assert.strictEqual(mixedGroups.length, 2, "две разные сигнатуры — две группы");
assert.strictEqual(mixedState.report.nativeSubtreesPruned, 1, "нативная цель отсечена");
assert.strictEqual(mixedState.report.promoteCandidates, 2, "кандидатов ровно два");
assert.strictEqual(mixedGroups[0].maxDepth, 2, "глубокие группы обрабатываются первыми");

// §32: отдача управления хосту — по бюджету времени, последовательно.
async function yieldChecks() {
  var report = importer.newReport("screen");
  var slice = importer.createSlice(report);
  await importer.yieldIfNeeded(slice);
  assert.strictEqual(report.yieldCount, 0, "короткий кусок работы не даёт отдачи управления");
  slice.startedAt = Date.now() - 500;
  await importer.yieldIfNeeded(slice);
  assert.strictEqual(report.yieldCount, 1, "затянувшийся кусок отдаёт управление");
  assert.ok(report.maxSliceMs >= 500, "длительность куска зафиксирована");
  assert.ok(Date.now() - slice.startedAt < 100, "счётчик куска перезапущен");
}

// ---------------------------------------------------------------------------
// §33: свойства — проверяем конечные значения, а не только счётчики.
// ---------------------------------------------------------------------------

async function propertyFidelityChecks() {
  // Несколько VARIANT + несколько BOOLEAN + TEXT на одной цели.
  var target = fakeInstance("t", [], {
    "size#1": { value: "s" }, "state#2": { value: "default" },
    "label#3": { value: true }, "placeholder#4": { value: true },
    "caption#5": { value: "" },
  });
  var state = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(target, [
    { propertyRef: "a", rawName: "size#1", name: "size", type: "VARIANT", value: "m" },
    { propertyRef: "b", rawName: "state#2", name: "state", type: "VARIANT", value: "hover" },
    { propertyRef: "c", rawName: "label#3", name: "label", type: "BOOLEAN", value: false },
    { propertyRef: "d", rawName: "placeholder#4", name: "placeholder", type: "BOOLEAN", value: true },
    { propertyRef: "e", rawName: "caption#5", name: "caption", type: "TEXT", value: "текст" },
  ], state, { nodeRef: "node:1" });
  assert.deepStrictEqual(target.applied[0], {
    "size#1": "m", "state#2": "hover", "label#3": false, "placeholder#4": true, "caption#5": "текст",
  }, "все значения доехали в своих типах");
  assert.strictEqual(state.report.propertiesApplied, 5);
  assert.strictEqual(state.report.propertiesMissed, 0);

  // Типы: строковое "false" в BOOLEAN становится булевым, а не строкой.
  assert.strictEqual(importer.propertyValue({ type: "BOOLEAN", value: "false" }, state), false);
  assert.strictEqual(importer.propertyValue({ type: "BOOLEAN", value: true }, state), true);
  assert.strictEqual(importer.propertyValue({ type: "BOOLEAN", value: 1 }, state), undefined);
  assert.strictEqual(importer.propertyValue({ type: "VARIANT", value: 2 }, state), "2");
  assert.strictEqual(importer.propertyValue({ type: "TEXT", value: "x" }, state), "x");

  // Свойства нет в схеме цели — причина названа.
  var missState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(fakeInstance("t", [], { "known#1": { value: "a" } }), [
    { propertyRef: "z", rawName: "нет#9", name: "нет", type: "TEXT", value: "x" },
  ], missState, { nodeRef: "node:2" });
  assert.strictEqual(missState.report.propertyMissReasons[importer.MISS.PROPERTY_NOT_IN_SCHEMA], 1);
  assert.strictEqual(missState.report.propertyMissSamples[0].nodeRef, "node:2",
    "выборка позволяет проследить свойство до исходного узла");
  assert.strictEqual(missState.report.propertyMissSamples[0].sourceType, "TEXT");

  // Схемы нет вообще — это другая причина, чем «свойства нет в схеме».
  var emptyState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(fakeInstance("t", [], {}), [
    { propertyRef: "z", rawName: "a#1", name: "a", type: "TEXT", value: "x" },
  ], emptyState, {});
  assert.strictEqual(emptyState.report.propertyMissReasons[importer.MISS.SCHEMA_UNAVAILABLE], 1);

  // Неоднозначное логическое имя — отказ, а не выбор наугад.
  var ambState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(fakeInstance("t", [], { "a#1": { value: 1 }, "a#2": { value: 2 } }), [
    { propertyRef: "z", name: "a", type: "TEXT", value: "x" },
  ], ambState, {});
  assert.strictEqual(ambState.report.propertyMissReasons[importer.MISS.TARGET_AMBIGUOUS], 1);

  // INSTANCE_SWAP без доехавшего определения.
  var swapState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(fakeInstance("t", [], { "slot#1": { value: "" } }), [
    { propertyRef: "z", rawName: "slot#1", name: "slot", type: "INSTANCE_SWAP", swapComponentRef: "component:gone" },
  ], swapState, {});
  assert.strictEqual(swapState.report.propertyMissReasons[importer.MISS.INSTANCE_SWAP_UNRESOLVED], 1);

  // setProperties бросает: одно плохое значение не уносит остальные.
  var partial = {
    type: "INSTANCE", name: "partial", children: [],
    componentProperties: { "good#1": { value: "" }, "bad#2": { value: "" } },
    applied: [],
    setProperties: function (props) {
      if (Object.keys(props).length > 1 || props["bad#2"] !== undefined) throw new Error("Figma отвергла");
      this.applied.push(props);
    },
    getMainComponentAsync: function () {
      return Promise.resolve({ type: "COMPONENT", parent: null,
        componentPropertyDefinitions: { "bad#2": { type: "VARIANT", variantOptions: ["a", "b"] } } });
    },
  };
  var partialState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(partial, [
    { propertyRef: "g", rawName: "good#1", name: "good", type: "TEXT", value: "ок" },
    { propertyRef: "b", rawName: "bad#2", name: "bad", type: "VARIANT", value: "нет-такого" },
  ], partialState, {});
  assert.deepStrictEqual(partial.applied, [{ "good#1": "ок" }], "годное свойство применено");
  assert.strictEqual(partialState.report.propertiesApplied, 1);
  assert.strictEqual(partialState.report.propertyMissReasons[importer.MISS.VARIANT_OPTION_NOT_FOUND], 1,
    "недопустимый вариант опознан по опциям цели, а не по тексту ошибки");

  // setProperties недоступен на цели.
  var noSetter = { type: "INSTANCE", name: "n", children: [], componentProperties: { "a#1": { value: "" } } };
  var noSetterState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  await importer.applyPropertyStage(noSetter, [
    { propertyRef: "z", rawName: "a#1", name: "a", type: "TEXT", value: "x" },
  ], noSetterState, {});
  assert.strictEqual(noSetterState.report.propertyMissReasons[importer.MISS.SET_PROPERTIES_UNAVAILABLE], 1);

  // Выборка ограничена, счётчики — нет.
  var floodState = { report: importer.newReport("screen"), propertyNames: {}, registry: { defs: {} } };
  for (var f = 0; f < 60; f++) {
    await importer.applyPropertyStage(fakeInstance("t", [], { "known#1": { value: "" } }), [
      { propertyRef: "z", rawName: "нет#9", name: "нет", type: "TEXT", value: "x" },
    ], floodState, {});
  }
  assert.strictEqual(floodState.report.propertiesMissed, 60, "счётчик полный");
  assert.strictEqual(floodState.report.propertyMissSamples.length, 40, "выборка ограничена");
}

// ---------------------------------------------------------------------------
// §34: ровно одна служебная страница определений, опознаваемая по plugin data.
// ---------------------------------------------------------------------------

function fakePage(name) {
  var data = {};
  return {
    id: "page-" + name + "-" + Math.random().toString(36).slice(2),
    name: name,
    removed: false,
    loadAsync: function () { return Promise.resolve(); },
    getPluginData: function (key) { return data[key] || ""; },
    setPluginData: function (key, value) { data[key] = value; },
  };
}

async function servicePageChecks() {
  var pages = [];
  var created = 0;
  global.figma = {
    root: { children: pages },
    currentPage: fakePage("Canvas"),
    createPage: function () { created += 1; var page = fakePage("new"); pages.push(page); return page; },
    setCurrentPageAsync: function (page) { global.figma.currentPage = page; return Promise.resolve(); },
  };

  // Нет помеченной страницы — создаётся ровно одна.
  var registry = {};
  var first = await importer.ensureServicePage(registry, "job-1");
  assert.strictEqual(created, 1, "создана ровно одна служебная страница");
  assert.strictEqual(first.name, importer.SERVICE_PAGE_NAME);
  assert.strictEqual(first.getPluginData("pixso2figmaRole"), importer.SERVICE_PAGE_ROLE);
  assert.strictEqual(first.getPluginData("pixso2figmaState"), "BUILDING");
  assert.strictEqual(first.getPluginData("pixso2figmaJobId"), "job-1");
  // Импорт определений и промоушен живут на одной странице.
  assert.strictEqual(registry.definitionPage, first);
  assert.strictEqual(registry.page, first, "промоушен не заводит вторую страницу");

  // Повторный вызов в той же job — та же страница.
  await importer.ensureServicePage(registry, "job-1");
  assert.strictEqual(created, 1, "повторная инициализация не плодит страницы");

  // Новый прогон после оборвавшейся миграции: страница BUILDING переиспользуется.
  var recovered = await importer.ensureServicePage({}, "job-2");
  assert.strictEqual(created, 1, "страница мёртвой job переиспользуется, а не дублируется");
  assert.strictEqual(recovered, first);
  assert.strictEqual(first.getPluginData("pixso2figmaJobId"), "job-2");
  assert.strictEqual(first.getPluginData("pixso2figmaState"), "BUILDING");

  // Завершение job помечает страницу готовой.
  importer.markServicePageReady({ definitionPage: first });
  assert.strictEqual(first.getPluginData("pixso2figmaState"), "READY");
  var afterReady = await importer.ensureServicePage({}, "job-3");
  assert.strictEqual(created, 1, "готовая страница прошлой job тоже переиспользуется");
  assert.strictEqual(afterReady, first);

  // Страница пользователя с тем же видимым именем, но без метки — не наша.
  pages.length = 0;
  var userPage = fakePage(importer.SERVICE_PAGE_NAME);
  pages.push(userPage);
  assert.strictEqual(importer.findServicePage(), null,
    "страница опознаётся по plugin data, а не по видимому имени");
  var ownPage = await importer.ensureServicePage({}, "job-4");
  assert.strictEqual(created, 2, "рядом с пользовательской создана своя служебная");
  assert.notStrictEqual(ownPage, userPage, "пользовательская страница не тронута");
  assert.strictEqual(userPage.getPluginData("pixso2figmaRole"), "", "на неё ничего не записано");
  assert.strictEqual(userPage.removed, false, "и она не удалена");
}

pageStateChecks().then(fontCacheChecks).then(variantInstanceChecks).then(fastInstanceChecks)
  .then(yieldChecks).then(propertyFidelityChecks).then(servicePageChecks).then(function () {
  delete global.figma;
  console.log("OK: Figma importer screen-only dependency + receiver tests passed");
}, function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
