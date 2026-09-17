/**
 * FAST/FULL приём миграции (сторона Figma):
 *   node FigmaImporter/Tests/FastImportTest.js
 *
 * Проверяет, что режим job:
 *   — приходит в приёмник явно, а не выводится из наличия component-payload;
 *   — в FAST выключает подготовку определений и реконструкцию свойств, но
 *     выполняет лёгкий семантический промоушен: одинаковые развёрнутые
 *     поддеревья сворачиваются в один локальный компонент и его инстансы;
 *   — в FULL оставляет прежнее поведение;
 *   — не протекает между job в одном документе.
 *
 * Фейковый Figma-хост ниже реализует ровно те методы, которые вызывает
 * importPackage: тест обязан ловить лишний вызов, а не молча его проглатывать.
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
// §35: одноразовый отказ хоста — промоушен обязан его пережить.
var failNextComponent = false;

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
    setPluginData: function (key, value) { this.pluginData[key] = String(value); },
    getPluginData: function (key) { return this.pluginData[key] || ""; },
    resizeWithoutConstraints: function (w, h) { this.width = w; this.height = h; },
    remove: function () {
      calls.remove += 1;
      this.removed = true;
      if (this.parent) {
        var index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
      }
    },
    // Глубокий clone: промоушен собирает компонент именно из уже построенного
    // поддерева, и мелкий clone скрыл бы обе главные проверки — вложенность
    // и перенос overrides на инстанс.
    clone: function () {
      calls.clone += 1;
      var copy = makeStubNode(this.type, typeof this.appendChild === "function");
      copy.name = this.name;
      copy.visible = this.visible;
      copy.opacity = this.opacity;
      copy.width = this.width;
      copy.height = this.height;
      if (this.characters !== undefined) copy.characters = this.characters;
      for (var i = 0; i < this.children.length; i++) {
        copy.appendChild(this.children[i].clone());
      }
      return copy;
    },
  };
  if (withChildren) {
    node.appendChild = function (child) {
      if (child.parent) {
        var index = child.parent.children.indexOf(child);
        if (index >= 0) child.parent.children.splice(index, 1);
      }
      child.parent = this;
      this.children.push(child);
    };
    node.insertChild = function (index, child) { node.appendChild(child); };
  }
  return node;
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
    createPage: [],
    createSection: 0,
    createComponentFromNode: 0,
    createInstance: 0,
    combineAsVariants: 0,
    clone: 0,
    remove: 0,
  };
  pages = [];
  var first = makeStubPage("Page 1");
  global.figma = {
    root: { name: "Doc", get children() { return pages; } },
    currentPage: first,
    setCurrentPageAsync: function (page) { global.figma.currentPage = page; return Promise.resolve(); },
    createPage: function () {
      var page = makeStubPage("Page " + (pages.length + 1));
      calls.createPage.push(page);
      return page;
    },
    createSection: function () { calls.createSection += 1; return makeStubNode("SECTION", true); },
    createFrame: function () { return makeStubNode("FRAME", true); },
    createText: function () {
      // TEXT не контейнер: appendChild у него быть не должно.
      var text = makeStubNode("TEXT", false);
      text.characters = "";
      return text;
    },
    createRectangle: function () { return makeStubNode("RECTANGLE", false); },
    createEllipse: function () { return makeStubNode("ELLIPSE", false); },
    createLine: function () { return makeStubNode("LINE", false); },
    createPolygon: function () { return makeStubNode("POLYGON", false); },
    createStar: function () { return makeStubNode("STAR", false); },
    createComponent: function () { return makeStubNode("COMPONENT", true); },
    createNodeFromSvg: function () { return makeStubNode("FRAME", true); },
    createImage: function () { return { hash: "img" }; },
    createComponentFromNode: function (source) {
      if (failNextComponent) { failNextComponent = false; throw new Error("createComponentFromNode отказал"); }
      calls.createComponentFromNode += 1;
      var component = makeStubNode("COMPONENT", true);
      component.width = source.width;
      component.height = source.height;
      component.name = source.name;
      // Реальный createComponentFromNode превращает сам узел в компонент:
      // поддерево переезжает в него, а не исчезает.
      while (source.children.length) component.appendChild(source.children[0]);
      component.createInstance = function () {
        calls.createInstance += 1;
        var instance = makeStubNode("INSTANCE", true);
        instance.mainComponent = component;
        instance.getMainComponentAsync = function () { return Promise.resolve(component); };
        instance.swapComponent = function (next) { instance.mainComponent = next; };
        for (var i = 0; i < component.children.length; i++) {
          instance.appendChild(component.children[i].clone());
        }
        return instance;
      };
      if (source.parent) source.parent.appendChild(component);
      source.remove();
      return component;
    },
    combineAsVariants: function () { calls.combineAsVariants += 1; return makeStubNode("COMPONENT_SET", true); },
    loadFontAsync: function () { return Promise.resolve(); },
    viewport: { scrollAndZoomIntoView: function () {} },
    ui: { postMessage: function () {} },
    notify: function () {},
  };
}

// Модуль загружается ДО появления global.figma: иначе сработает setup() и
// плагин попытается показать UI, которого в Node нет.
var importer = require("../Main.js");
resetFigma();

// Служебная страница опознаётся ТОЛЬКО по plugin data: страница пользователя
// с тем же именем — не она.
function servicePages() {
  return pages.filter(function (page) {
    return page.getPluginData("pixso2figmaRole") === importer.SERVICE_PAGE_ROLE;
  });
}
function fastServicePages() {
  return pages.filter(function (page) {
    return page.getPluginData("pixso2figmaRole") === importer.FAST_SERVICE_PAGE_ROLE;
  });
}
function pagesNamed(name) {
  return pages.filter(function (page) { return page.name === name; });
}

// ---------------------------------------------------------------------------
// Пакет: экран с развёрнутым инстансом (ровно то, что отдаёт FAST-экспорт),
// плюс preset с именем определения — чтобы FULL было что промоутить.
// ---------------------------------------------------------------------------

function screenPackage(withPreset) {
  var pkg = {
    format: "pixso-portable-package",
    transferMode: "VISUAL_SNAPSHOT",
    roots: [{ nodeRef: "node:screen" }],
    nodes: {
      "node:screen": {
        id: "node:screen", type: "FRAME", name: "Экран",
        size: { width: 100, height: 60 }, position: { x: 0, y: 0 },
        children: ["node:card"],
      },
      "node:card": {
        id: "node:card", type: "INSTANCE", name: "карточка",
        size: { width: 80, height: 40 }, position: { x: 4, y: 4 },
        children: ["node:label", "node:hidden"],
      },
      "node:label": {
        id: "node:label", type: "TEXT", name: "подпись",
        size: { width: 40, height: 12 },
        text: { characters: "фактический текст" },
      },
      "node:hidden": {
        id: "node:hidden", type: "FRAME", name: "скрытый", visible: false,
        size: { width: 8, height: 8 },
      },
    },
    instances: {},
    components: {},
    componentSets: {},
    styles: {},
    images: {},
    svgAssets: {},
    variables: {},
    reactions: [],
    dependencies: { order: [] },
  };
  if (withPreset) {
    pkg.instances["node:card"] = { preset: fastIdentity("c-zab", "Zab") };
  }
  return pkg;
}

/**
 * Лёгкая идентичность ровно того вида, который отдаёт FAST-экспорт: устойчивый
 * исходный id, имя как подпись, variant-координата — и ничего из модели свойств.
 */
function fastIdentity(componentId, name, options) {
  options = options || {};
  return {
    availability: "SEMANTIC_ONLY",
    sourceComponentId: componentId,
    sourceComponentSetId: options.setId || "",
    definitionName: name,
    definitionSetName: options.setName || "",
    variantProperties: options.variants || {},
    componentProperties: {},
    overrides: [],
    exposedInstances: [],
  };
}

function definitionPackage() {
  return {
    format: "pixso-portable-package",
    transferMode: "COMPONENT_DEFINITIONS",
    definitionRef: "component:zab",
    roots: [{ nodeRef: "node:def" }],
    nodes: { "node:def": { id: "node:def", type: "COMPONENT", name: "Zab", size: { width: 10, height: 10 } } },
    components: { "component:zab": { portableId: "component:zab", rootNodeRef: "node:def", properties: [] } },
    componentSets: {}, instances: {}, styles: {}, images: {}, svgAssets: {},
    variables: {}, reactions: [], dependencies: { order: ["component:zab"] },
  };
}

var receiverOptions = { promoteComponents: true, createPages: true };

function task(jobId, sequence, type, payload) {
  return { jobId: jobId, taskId: jobId + "-" + sequence, sequence: sequence, type: type, payload: payload };
}

// ---------------------------------------------------------------------------
// 0. Разбор режима и compatibility default
// ---------------------------------------------------------------------------

eq(importer.DEFAULT_MIGRATION_MODE, "FULL",
  "пакет без mode импортируется как раньше: compatibility default — FULL");
eq(importer.normalizeMigrationMode(undefined), "FULL", "отсутствующий режим — это FULL");
eq(importer.normalizeMigrationMode("FAST"), "FAST", "явный FAST распознан");
eq(importer.normalizeMigrationMode("fast"), "FAST", "регистр значения не важен");
eq(importer.normalizeMigrationMode("библиотеки"), "FULL", "неизвестное значение — это FULL");
eq(importer.newSession("j", null, "FAST").migrationMode, "FAST", "сессия помнит режим job");
eq(importer.newSession("j", null).migrationMode, "FULL", "сессия без режима — FULL");

// ---------------------------------------------------------------------------
// 1. FAST job
// ---------------------------------------------------------------------------

async function fastJobChecks() {
  resetFigma();
  var jobId = "job-fast";

  var started = await importer.handleReceiverTask(
    task(jobId, 1, "START_JOB", { migrationMode: "FAST", source: { fileName: "Doc" } }),
    receiverOptions
  );
  eq(started.migrationMode, "FAST", "приёмник подтвердил режим job");

  await importer.handleReceiverTask(
    task(jobId, 2, "PAGE_START", { migrationMode: "FAST", pageName: "Page 1" }),
    receiverOptions
  );

  var rootResult = await importer.handleReceiverTask(
    task(jobId, 3, "ROOT_NODE", {
      migrationMode: "FAST", pageName: "Page 1", rootName: "Экран",
      package: screenPackage(true),
    }),
    receiverOptions
  );

  eq(rootResult.migrationMode, "FAST", "результат корня помечен режимом");
  eq(rootResult.componentPreparationSkipped, true, "подготовка определений пропущена");
  eq(rootResult.nativePromotionSkipped, true,
    "component-aware реконструкция не выполнялась");
  eq(rootResult.fastSemanticPromotion, true,
    "а лёгкий семантический промоушен — выполнялся: это разные фазы");
  eq(rootResult.phases.promoteMs, 0, "инвариант: FULL-фазы промоушена в FAST нет");
  ok(rootResult.phases.fastPromoteMs >= 0, "у FAST своя метрика, а не общая с FULL");
  ok(rootResult.phases.buildMs >= 0, "обычная сборка при этом выполнялась");
  eq(rootResult.promoteCandidates, 1, "развёрнутый инстанс стал кандидатом");
  eq(calls.createComponentFromNode, 1, "локальный компонент собран из визуального снимка");
  eq(calls.combineAsVariants, 0, "одиночный компонент не объединяется в набор");
  eq(rootResult.fastComponentsCreated, 1, "создан ровно один локальный компонент");
  eq(rootResult.fastInstancesCreated, 1, "и одно вхождение стало его инстансом");
  eq(rootResult.fastSnapshotsLeft, 0, "неcвёрнутых snapshot-ов не осталось");

  // §6/§16: подготовка определений FULL не запускается, её страница не нужна.
  // У лёгкого промоушена — своя, тоже опознаваемая только по plugin data.
  eq(servicePages().length, 0, "служебная страница определений FULL не создана");
  eq(pagesNamed("Pixso Components").length, 0, "страница компонентов экрана не создана");
  eq(pagesNamed("Pixso Components (native)").length, 0, "нативной страницы определений нет");
  eq(fastServicePages().length, 1, "страница компонентов FAST создана ровно одна");
  eq(fastServicePages()[0].name, importer.FAST_SERVICE_PAGE_NAME, "и названа своим именем");

  // §10: результат — инстансы локального компонента, а не развёрнутые копии.
  eq(rootResult.created, 4, "собран весь экран: frame + инстанс + текст + скрытый слой");
  var migrationPage = pages.filter(function (page) {
    return page.getPluginData("pixsoMigrationPage") === "Page 1";
  })[0];
  ok(migrationPage, "экран собран на странице миграции");
  var screen = migrationPage.children[0];
  eq(screen.type, "FRAME", "корень — обычный фрейм");
  var card = screen.children[0];
  eq(card.type, "INSTANCE", "вхождение стало инстансом локального компонента");
  eq(card.children.length, 2, "оба ребёнка на месте");
  eq(card.children[0].characters, "фактический текст", "текст сохранён после промоушена");
  eq(card.children[1].visible, false, "скрытый слой остался скрытым");

  // §28: COMPONENT_DEFS в FAST не запускает реконструкцию.
  var defResult = await importer.handleReceiverTask(
    task(jobId, 4, "COMPONENT_DEFS", { migrationMode: "FAST", name: "Zab", package: definitionPackage() }),
    receiverOptions
  );
  eq(defResult.skipped, true, "задача определений в FAST помечена пропущенной");
  eq(defResult.ready.length, 0, "приёмник ничего не подтверждает: ссылаться не на что");
  eq(servicePages().length, 0, "и служебная страница определений по-прежнему не создана");

  var finish = await importer.handleReceiverTask(
    task(jobId, 5, "FINISH_JOB", { migrationMode: "FAST" }),
    receiverOptions
  );
  eq(finish.migrationMode, "FAST", "итог job помечен режимом");
  eq(finish.timing.promoteMs, 0, "суммарный FULL-promoteMs по job равен нулю");
  eq(finish.jobStats.definitionTasksSkipped, 1, "пропущенная задача определений посчитана");
  eq(finish.jobStats.componentPreparationSkippedRoots, 1,
    "корни без подготовки определений посчитаны");
  eq(finish.jobStats.fastSemanticPromotion, true, "job объявляет лёгкий промоушен");
  eq(finish.jobStats.fullComponentPreparation, false, "и не объявляет Full-подготовку");
  eq(finish.totals.fastComponentsCreated, 1, "итог job: один локальный компонент");
  eq(finish.totals.fastInstancesCreated, 1, "и один инстанс");
  eq(servicePages().length, 0, "FINISH_JOB не создал служебную страницу определений");
  eq(fastServicePages().length, 1, "и не продублировал страницу FAST");
  eq(fastServicePages()[0].getPluginData("pixso2figmaState"), "READY",
    "свою страницу FAST помечает готовой");
}

// ---------------------------------------------------------------------------
// 2. FULL job в том же документе: прежнее поведение
// ---------------------------------------------------------------------------

async function fullJobChecks() {
  // Документ тот же, что у FAST-прогона выше: счётчики хоста накопительные,
  // поэтому сравниваем прирост, а не абсолютные значения.
  var componentsBefore = calls.createComponentFromNode;
  var instancesBefore = calls.createInstance;
  var jobId = "job-full";
  await importer.handleReceiverTask(
    task(jobId, 1, "START_JOB", { migrationMode: "FULL", source: { fileName: "Doc" } }),
    receiverOptions
  );
  await importer.handleReceiverTask(
    task(jobId, 2, "PAGE_START", { migrationMode: "FULL", pageName: "Page 2" }),
    receiverOptions
  );
  var rootResult = await importer.handleReceiverTask(
    task(jobId, 3, "ROOT_NODE", {
      migrationMode: "FULL", pageName: "Page 2", rootName: "Экран",
      package: screenPackage(true),
    }),
    receiverOptions
  );

  eq(rootResult.migrationMode, "FULL", "job помечена режимом FULL");
  eq(rootResult.nativePromotionSkipped, false, "в FULL промоушен не пропускается");
  eq(rootResult.fastSemanticPromotion, false, "и это не лёгкий промоушен FAST");
  ok(rootResult.promoteCandidates >= 1, "кандидат промоушена найден");
  eq(calls.createComponentFromNode - componentsBefore, 1, "нативный компонент собран");
  eq(calls.createInstance - instancesBefore, 1, "snapshot заменён нативным инстансом");
  eq(rootResult.fastComponentsCreated, 0, "счётчики FAST в FULL остаются нулями");
  eq(rootResult.fastInstancesCreated, 0, "и не подменяют собой счётчики FULL");
  eq(rootResult.fastSnapshotsLeft, 0, "и не считаются в FULL вовсе");
  eq(servicePages().length, 1, "служебная страница определений создана ровно одна");
  eq(fastServicePages().length, 1, "страница FAST от прошлой job не продублирована");

  var finish = await importer.handleReceiverTask(
    task(jobId, 4, "FINISH_JOB", { migrationMode: "FULL" }),
    receiverOptions
  );
  eq(finish.jobStats.servicePageTouched, true, "FULL помечает свою служебную страницу");
  eq(servicePages()[0].getPluginData("pixso2figmaState"), "READY", "страница помечена готовой");
}

// ---------------------------------------------------------------------------
// 3. FAST после FULL в том же документе: состояние не протекает
// ---------------------------------------------------------------------------

async function modeIsolationChecks() {
  var componentsBefore = calls.createComponentFromNode;
  var servicePagesBefore = servicePages().length;
  var fastPagesBefore = fastServicePages().length;
  eq(servicePagesBefore, 1, "служебная страница осталась от прошлой FULL-миграции");

  var jobId = "job-fast-2";
  await importer.handleReceiverTask(
    task(jobId, 1, "START_JOB", { migrationMode: "FAST", source: { fileName: "Doc" } }),
    receiverOptions
  );
  await importer.handleReceiverTask(
    task(jobId, 2, "PAGE_START", { migrationMode: "FAST", pageName: "Page 3" }),
    receiverOptions
  );
  var rootResult = await importer.handleReceiverTask(
    task(jobId, 3, "ROOT_NODE", {
      migrationMode: "FAST", pageName: "Page 3", rootName: "Экран",
      package: screenPackage(true),
    }),
    receiverOptions
  );
  eq(rootResult.phases.promoteMs, 0, "FAST после FULL не входит в FULL-пайплайн");
  eq(rootResult.componentPreparationSkipped, true, "определения по-прежнему не готовятся");
  // §36: реестр FULL остался в документе, но FAST его не видит и обязан
  // собрать свой компонент заново — в своей ветке реестра.
  eq(rootResult.fastComponentsCreated, 1, "FAST собрал собственный компонент");
  eq(rootResult.fastComponentsReused, 0, "и не переиспользовал определение FULL");
  eq(calls.createComponentFromNode - componentsBefore, 1,
    "ровно один новый компонент — на странице FAST");

  var finish = await importer.handleReceiverTask(
    task(jobId, 4, "FINISH_JOB", { migrationMode: "FAST" }),
    receiverOptions
  );
  eq(finish.jobStats.servicePageTouched, true, "FAST помечает готовой свою страницу");
  eq(servicePages().length, servicePagesBefore,
    "страница определений FULL не удалена и не продублирована");
  eq(fastServicePages().length, fastPagesBefore,
    "страница FAST переиспользована, а не создана заново");
  eq(servicePages()[0].getPluginData("pixso2figmaState"), "READY",
    "состояние чужой страницы FAST не переписывал");
}

// ---------------------------------------------------------------------------
// 4. Старый отправитель без поля mode: прежнее поведение
// ---------------------------------------------------------------------------

async function legacyProducerChecks() {
  resetFigma();
  var jobId = "job-legacy";
  var started = await importer.handleReceiverTask(
    task(jobId, 1, "START_JOB", { source: { fileName: "Doc" } }),
    receiverOptions
  );
  eq(started.migrationMode, "FULL", "job без объявленного режима считается FULL");

  await importer.handleReceiverTask(task(jobId, 2, "PAGE_START", { pageName: "Page 1" }), receiverOptions);
  var rootResult = await importer.handleReceiverTask(
    task(jobId, 3, "ROOT_NODE", { pageName: "Page 1", rootName: "Экран", package: screenPackage(true) }),
    receiverOptions
  );
  eq(rootResult.migrationMode, "FULL", "корень импортирован в прежнем режиме");
  eq(calls.createComponentFromNode, 1, "промоушен старого отправителя не изменился");
}

// ---------------------------------------------------------------------------
// 5. Ручной импорт: без bridge и без режима
// ---------------------------------------------------------------------------

async function manualImportChecks() {
  resetFigma();
  var report = await importer.importPackage(screenPackage(true), { promoteComponents: false });
  eq(report.migrationMode, "FULL", "ручной импорт не переключается в FAST сам по себе");
  eq(report.created, 4, "ручной импорт собрал экран");
  eq(calls.createComponentFromNode, 0, "снятая галочка компонентов по-прежнему отключает промоушен");
  eq(servicePages().length, 0, "ручной импорт без промоушена не создаёт служебную страницу");

  resetFigma();
  var promoted = await importer.importPackage(screenPackage(true), { promoteComponents: true });
  eq(promoted.migrationMode, "FULL", "режим по умолчанию — прежний");
  eq(calls.createComponentFromNode, 1, "включённая галочка по-прежнему собирает компоненты");
}

// ---------------------------------------------------------------------------
// 6. §30: много одинаковых вхождений одного исходного компонента.
//
// Это профиль, ради которого режим и существует: раньше он давал N развёрнутых
// копий. Ожидание — один локальный компонент и N его инстансов.
// ---------------------------------------------------------------------------

function heavyPackage(instanceCount, identityOf) {
  var pkg = screenPackage(false);
  var children = [];
  for (var i = 0; i < instanceCount; i++) {
    var cardId = "node:card-" + i;
    var labelId = "node:label-" + i;
    pkg.nodes[cardId] = {
      id: cardId, type: "INSTANCE", name: "карточка " + i,
      size: { width: 80, height: 40 }, position: { x: 0, y: i * 44 },
      children: [labelId],
    };
    pkg.nodes[labelId] = {
      id: labelId, type: "TEXT", name: "подпись",
      size: { width: 40, height: 12 }, text: { characters: "строка " + i },
    };
    pkg.instances[cardId] = {
      preset: identityOf ? identityOf(i) : fastIdentity("c-zab", "Zab"),
    };
    children.push(cardId);
  }
  // Исходный одиночный инстанс из screenPackage(false) заменяется списком.
  delete pkg.nodes["node:card"];
  delete pkg.nodes["node:label"];
  delete pkg.nodes["node:hidden"];
  pkg.nodes["node:screen"].children = children;
  return pkg;
}

var acceptance = { fast: null, full: null };

async function acceptanceChecks() {
  var INSTANCES = 300;

  resetFigma();
  var fullStartedAt = Date.now();
  var fullReport = await importer.importPackage(heavyPackage(INSTANCES), {
    migrationMode: "FULL", promoteComponents: true, skipViewport: true,
  });
  acceptance.full = {
    createdNodes: fullReport.created,
    promoteCandidates: fullReport.promoteCandidates,
    nativeComponents: fullReport.nativeComponents,
    nativeInstances: fullReport.nativeInstances,
    totalMs: Date.now() - fullStartedAt,
  };
  eq(fullReport.promoteCandidates, INSTANCES, "FULL рассмотрел все инстансы корня");
  eq(calls.createComponentFromNode, 1, "FULL собрал общее определение один раз");
  eq(calls.createInstance, INSTANCES, "и заменил им каждый snapshot");
  eq(servicePages().length, 1, "FULL создал служебную страницу определений");
  eq(fastServicePages().length, 0, "и не создал страницу FAST");

  resetFigma();
  var fastStartedAt = Date.now();
  var fastTimings = {};
  var fastReport = await importer.importPackage(heavyPackage(INSTANCES), {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
    timingsOut: fastTimings,
  });
  acceptance.fast = {
    createdNodes: fastReport.created,
    promoteCandidates: fastReport.promoteCandidates,
    buildMs: fastTimings.buildMs,
    fastPromoteMs: fastTimings.fastPromoteMs,
    components: fastReport.fastComponentsCreated,
    instances: fastReport.fastInstancesCreated,
    snapshotsLeft: fastReport.fastSnapshotsLeft,
    totalMs: Date.now() - fastStartedAt,
  };

  eq(fastReport.created, fullReport.created, "FAST собрал тот же объём слоёв");
  eq(fastTimings.promoteMs, 0, "FULL-фазы промоушена в FAST нет");
  eq(fastReport.promoteCandidates, INSTANCES, "но кандидаты рассмотрены все");
  // Центральное требование патча: не 300 отдельных копий.
  eq(fastReport.fastComponentsCreated, 1, "создан ровно один локальный компонент");
  eq(fastReport.fastInstancesCreated, INSTANCES, "и все вхождения стали его инстансами");
  eq(fastReport.fastSnapshotsLeft, 0, "развёрнутых поддеревьев не осталось");
  eq(calls.createComponentFromNode, 1, "createComponentFromNode вызван один раз");
  eq(calls.createInstance, INSTANCES, "createInstance — по разу на вхождение");
  eq(servicePages().length, 0, "служебная страница определений не создана");
  eq(fastServicePages().length, 1, "а страница компонентов FAST — одна");
  // Свойства Pixso не восстанавливаются ни разу: за это отвечает FULL.
  eq(fastReport.propertiesApplied, 0, "свойства компонентов не применялись");
  eq(fastReport.components, 0, "определения компонентов не собирались");
  // §25/§26: счётчики режимов не смешиваются даже внутри отчёта.
  eq(fastReport.nativeComponents, 0, "«нативных компонентов» в FAST не бывает");
  eq(fastReport.nativeInstances, 0, "и «нативных инстансов» тоже");
  eq(fullReport.fastComponentsCreated, 0, "а FULL не пишет в счётчики FAST");
}

// ---------------------------------------------------------------------------
// 6a. §31: варианты одного исходного сета
// ---------------------------------------------------------------------------

async function variantChecks() {
  resetFigma();
  var states = ["Default", "Hover", "Disabled"];
  var pkg = heavyPackage(9, function (index) {
    var state = states[index % states.length];
    return fastIdentity("c-btn-" + state.toLowerCase(), "Button", {
      setId: "cs-btn", setName: "Button", variants: { State: state },
    });
  });
  var report = await importer.importPackage(pkg, {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  eq(report.fastComponentsCreated, 3, "три исходных варианта — три локальных компонента");
  eq(report.fastInstancesCreated, 9, "все девять вхождений стали инстансами");
  eq(report.fastComponentSets, 1, "варианты объединены в один ComponentSet");
  eq(calls.combineAsVariants, 1, "combineAsVariants вызван ровно один раз");

  // §12: без variant-координаты объединять нечего — лучше отдельные компоненты,
  // чем ComponentSet с одинаковыми именами членов.
  resetFigma();
  var vague = heavyPackage(4, function (index) {
    return fastIdentity("c-vague-" + (index % 2), "Vague", { setId: "cs-vague", setName: "Vague" });
  });
  var vagueReport = await importer.importPackage(vague, {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  eq(vagueReport.fastComponentsCreated, 2, "два разных исходных компонента");
  eq(vagueReport.fastComponentSets, 0, "но в набор они не объединены");
  eq(vagueReport.setsLeftSeparate, 1, "и это учтено, а не пропущено молча");
  eq(calls.combineAsVariants, 0, "combineAsVariants не вызывался");

  // §8: одинаковое видимое имя при разных источниках не сливает компоненты.
  resetFigma();
  var homonyms = heavyPackage(4, function (index) {
    return fastIdentity("c-button-" + (index % 2), "Button");
  });
  var homonymReport = await importer.importPackage(homonyms, {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  eq(homonymReport.fastComponentsCreated, 2,
    "два разных исходных компонента с именем «Button» не слились в один");
}

// ---------------------------------------------------------------------------
// 6b. §32: разные визуальные overrides у одинаковых вхождений
// ---------------------------------------------------------------------------

async function overrideChecks() {
  resetFigma();
  var pkg = screenPackage(false);
  // Два вхождения одного компонента: у A — свой текст, у B — скрытый слой.
  pkg.nodes["node:screen"].children = ["node:a", "node:b"];
  ["a", "b"].forEach(function (key) {
    pkg.nodes["node:" + key] = {
      id: "node:" + key, type: "INSTANCE", name: "карточка " + key,
      size: { width: 80, height: 40 }, position: { x: 0, y: 0 },
      children: ["node:" + key + "-label", "node:" + key + "-mark"],
    };
    pkg.nodes["node:" + key + "-label"] = {
      id: "node:" + key + "-label", type: "TEXT", name: "подпись",
      size: { width: 40, height: 12 },
      text: { characters: key === "a" ? "текст A" : "текст B" },
    };
    pkg.nodes["node:" + key + "-mark"] = {
      id: "node:" + key + "-mark", type: "FRAME", name: "метка",
      size: { width: 8, height: 8 }, visible: key !== "b",
    };
    pkg.instances["node:" + key] = { preset: fastIdentity("c-card", "Card") };
  });
  delete pkg.nodes["node:card"];
  delete pkg.nodes["node:label"];
  delete pkg.nodes["node:hidden"];

  var report = await importer.importPackage(pkg, {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  eq(report.fastComponentsCreated, 1, "оба вхождения делят один локальный компонент");
  eq(report.fastInstancesCreated, 2, "и оба стали инстансами");

  var screen = figma.currentPage.children[0];
  var a = screen.children[0], b = screen.children[1];
  eq(a.type, "INSTANCE", "первое вхождение — инстанс");
  eq(b.type, "INSTANCE", "второе вхождение — инстанс");
  // §13: после промоушена каждое вхождение обязано выглядеть как раньше.
  eq(a.children[0].characters, "текст A", "текстовый override первого вхождения сохранён");
  eq(b.children[0].characters, "текст B", "и второго — тоже, а не текст компонента");
  eq(a.children[1].visible, true, "видимость первого вхождения сохранена");
  eq(b.children[1].visible, false, "override видимости второго вхождения сохранён");
}

// ---------------------------------------------------------------------------
// 6c. §33: вложенные компоненты обрабатываются снизу вверх
// ---------------------------------------------------------------------------

async function nestedChecks() {
  resetFigma();
  var pkg = screenPackage(false);
  pkg.nodes["node:screen"].children = ["node:card-0", "node:card-1"];
  [0, 1].forEach(function (i) {
    pkg.nodes["node:card-" + i] = {
      id: "node:card-" + i, type: "INSTANCE", name: "Card",
      size: { width: 80, height: 40 }, position: { x: 0, y: i * 44 },
      children: ["node:btn-" + i],
    };
    pkg.nodes["node:btn-" + i] = {
      id: "node:btn-" + i, type: "INSTANCE", name: "Button",
      size: { width: 40, height: 16 }, position: { x: 4, y: 4 },
      children: ["node:btn-label-" + i],
    };
    pkg.nodes["node:btn-label-" + i] = {
      id: "node:btn-label-" + i, type: "TEXT", name: "подпись",
      size: { width: 30, height: 10 }, text: { characters: "жми" },
    };
    pkg.instances["node:card-" + i] = { preset: fastIdentity("c-card", "Card") };
    pkg.instances["node:btn-" + i] = { preset: fastIdentity("c-btn", "Button") };
  });
  delete pkg.nodes["node:card"];
  delete pkg.nodes["node:label"];
  delete pkg.nodes["node:hidden"];

  var report = await importer.importPackage(pkg, {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  eq(report.fastComponentsCreated, 2, "Card и Button — два локальных компонента");
  eq(report.fastInstancesCreated, 4, "два вхождения каждого стали инстансами");
  eq(report.fastSnapshotsLeft, 0, "вложенность не помешала свернуть ни одно вхождение");

  var screen = figma.currentPage.children[0];
  eq(screen.children[0].type, "INSTANCE", "Card — инстанс");
  // Снизу вверх: к моменту сборки Card его Button уже был инстансом, поэтому
  // компонент Card содержит вложенный инстанс, а не развёрнутые слои.
  eq(screen.children[0].children[0].type, "INSTANCE",
    "вложенный Button остался инстансом внутри Card, а не развернулся в слои");
}

// ---------------------------------------------------------------------------
// 6d. §34: переиспользование компонента между корнями одной job
// ---------------------------------------------------------------------------

async function streamingReuseChecks() {
  resetFigma();
  var jobId = "job-stream";
  await importer.handleReceiverTask(
    task(jobId, 1, "START_JOB", { migrationMode: "FAST", source: { fileName: "Doc" } }),
    receiverOptions
  );
  await importer.handleReceiverTask(
    task(jobId, 2, "PAGE_START", { migrationMode: "FAST", pageName: "Page 1" }),
    receiverOptions
  );
  var first = await importer.handleReceiverTask(
    task(jobId, 3, "ROOT_NODE", {
      migrationMode: "FAST", pageName: "Page 1", rootName: "Корень 1",
      package: heavyPackage(5),
    }),
    receiverOptions
  );
  eq(first.fastComponentsCreated, 1, "на первом корне компонент создан");
  eq(first.fastInstancesCreated, 5, "и пять вхождений стали инстансами");

  var later = await importer.handleReceiverTask(
    task(jobId, 4, "ROOT_NODE", {
      migrationMode: "FAST", pageName: "Page 1", rootName: "Корень 20",
      package: heavyPackage(10),
    }),
    receiverOptions
  );
  eq(later.fastComponentsCreated, 0, "на следующем корне компонент не пересоздаётся");
  eq(later.fastComponentsReused, 1, "он переиспользован из реестра job");
  eq(later.fastInstancesCreated, 10, "и все десять вхождений стали его инстансами");
  eq(calls.createComponentFromNode, 1, "за всю job — ровно один createComponentFromNode");
  eq(fastServicePages().length, 1, "и ровно одна страница компонентов FAST");

  var finish = await importer.handleReceiverTask(
    task(jobId, 5, "FINISH_JOB", { migrationMode: "FAST" }),
    receiverOptions
  );
  eq(finish.totals.fastComponentsCreated, 1, "итог job: один компонент на 15 вхождений");
  eq(finish.totals.fastInstancesCreated, 15, "итог job: пятнадцать инстансов");
  eq(finish.totals.fastSnapshotsLeft, 0, "и ни одного оставшегося snapshot-а");
}

// ---------------------------------------------------------------------------
// 6e. §21/§35: отказ промоушена — это оставшийся snapshot, а не провал корня
// ---------------------------------------------------------------------------

async function fallbackChecks() {
  resetFigma();
  failNextComponent = true;
  var report = await importer.importPackage(heavyPackage(3), {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  failNextComponent = false;
  eq(report.roots, 1, "корень импортирован, несмотря на отказ хоста");
  eq(report.fastComponentsCreated, 0, "компонент не создан");
  eq(report.fastInstancesCreated, 0, "и инстансы не созданы");
  eq(report.fastSnapshotsLeft, 3, "все три вхождения остались визуальными снимками");
  eq(report.promotionFailures, 1, "отказ учтён, а не проглочен");
  ok(report.warnings.length >= 1, "и о нём предупреждено");

  var screen = figma.currentPage.children[0];
  eq(screen.children.length, 3, "экран на месте целиком");
  eq(screen.children[0].type, "FRAME", "вхождение осталось развёрнутым фреймом");
  eq(screen.children[0].children[0].characters, "строка 0",
    "и его содержимое не испорчено");

  // §21: инстанс без семантической идентичности — тоже штатный snapshot.
  resetFigma();
  var anonymous = heavyPackage(2);
  delete anonymous.instances["node:card-0"];
  delete anonymous.instances["node:card-1"];
  var anonymousReport = await importer.importPackage(anonymous, {
    migrationMode: "FAST", promoteComponents: true, skipViewport: true,
  });
  eq(anonymousReport.fastComponentsCreated, 0, "без идентичности группировать нечего");
  eq(anonymousReport.fastSnapshotsLeft, 2, "оба вхождения остались снимками");
  eq(figma.currentPage.children[0].children.length, 2, "экран при этом собран полностью");
}

// ---------------------------------------------------------------------------
// 7. UI приёмника: один режим, режим job виден в логе, опции сборки зашиты.
// ---------------------------------------------------------------------------

function uiChecks() {
  var fs = require("fs");
  var vm = require("vm");
  var path = require("path");
  var html = fs.readFileSync(path.join(__dirname, "..", "Ui.html"), "utf8");

  var blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  eq(blocks.length, 1, "в панели приёмника один script-блок");
  assert.doesNotThrow(function () {
    new vm.Script(blocks[0].replace(/^<script>/, "").replace(/<\/script>$/, ""), { filename: "Ui.html" });
  }, "скрипт панели приёмника разбирается");
  checks += 1;

  ok(html.indexOf("function taskMode") >= 0, "режим job читается из payload задачи");
  ok(html.indexOf("migrationMode: taskMode(task)") >= 0, "и попадает в диагностику");
  // Панель приёмника единственная: вкладки и ручной импорт JSON из UI убраны,
  // а FAST/FULL по-прежнему объявляет отправитель — выбора режима здесь нет.
  eq(html.indexOf("JSON Import"), -1, "вкладки ручного импорта в панели нет");
  eq(html.indexOf("import-package"), -1, "UI не отправляет пакет из файла");
  // Прежние галочки стали фиксированными значениями: поведение то же,
  // поэтому проверяется именно то, что обе опции остались включёнными.
  ok(/IMPORT_OPTIONS\s*=\s*\{\s*promoteComponents:\s*true,\s*createPages:\s*true\s*\}/.test(html),
    "нативные компоненты и страницы Pixso собираются всегда");
  ok(html.indexOf("options: IMPORT_OPTIONS") >= 0, "и эти опции уходят с каждой задачей");
  ok(/BRIDGE_URL\s*=\s*"http:\/\/localhost:8787"/.test(html),
    "адрес bridge зашит — в manifest разрешён ровно он");
}

uiChecks();

fastJobChecks()
  .then(fullJobChecks)
  .then(modeIsolationChecks)
  .then(legacyProducerChecks)
  .then(manualImportChecks)
  .then(acceptanceChecks)
  .then(variantChecks)
  .then(overrideChecks)
  .then(nestedChecks)
  .then(streamingReuseChecks)
  .then(fallbackChecks)
  .then(function () {
    console.log(
      "  acceptance (300 одинаковых вхождений на корне): слоёв " + acceptance.fast.createdNodes +
      " · FAST — компонентов " + acceptance.fast.components +
      ", инстансов " + acceptance.fast.instances +
      ", snapshot " + acceptance.fast.snapshotsLeft +
      ", fastPromoteMs " + acceptance.fast.fastPromoteMs +
      " · FULL — компонентов " + acceptance.full.nativeComponents +
      ", нативных инстансов " + acceptance.full.nativeInstances
    );
    console.log("OK: FAST/FULL приём миграции (Figma) — " + checks + " проверок пройдено");
  })
  .catch(function (error) {
    console.error(error && error.stack || error);
    process.exit(1);
  });
