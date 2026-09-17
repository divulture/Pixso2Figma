/**
 * Direct PIX: жизненный цикл определения компонента на стороне Figma.
 *
 *   node FigmaImporter/Tests/DefinitionLifetimeTest.js
 *
 * Проверяется одно утверждение и его причинность:
 *
 *   вхождение, не ставшее инстансом, обязано называть ПРИЧИНУ, по которой
 *   определение оказалось недоступно, — и эта причина обязана пережить
 *   деградацию, а не превратиться в производный симптом адресации.
 *
 * Прежний путь давал один общий код `DEFINITION_MISSING`, клал заглушку в
 * счётчик обычных узлов и отправлял правки гулять по пустому поддереву, где
 * они становились `TARGET_INDEX_OUT_OF_RANGE`. Три разных факта — «записи
 * нет», «узел мёртв», «узел не того типа» — считались одинаково, а отчёт
 * показывал проблему адресации там, где её не было.
 *
 * Фейковый Figma-хост реализует ровно те методы, которые вызывает приёмник.
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
var byId = null;
var nodeSeq = 0;
/** Имитация отказа хоста на appendChild служебной страницы. */
var rejectAppendOnPage = false;

function makeNode(type, withChildren) {
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
      this.removed = true;
      if (this.parent) {
        var index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
      }
      this.parent = null;
    },
    clone: function () {
      var copy = makeNode(this.type, typeof this.appendChild === "function");
      copy.name = this.name;
      copy.width = this.width;
      copy.height = this.height;
      copy.pluginData = Object.assign({}, this.pluginData);
      if (this.characters !== undefined) copy.characters = this.characters;
      if (this.fontName !== undefined) copy.fontName = this.fontName;
      for (var i = 0; i < this.children.length; i++) copy.appendChild(this.children[i].clone());
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
  }
  byId[node.id] = node;
  return node;
}

function makeComponent() {
  var component = makeNode("COMPONENT", true);
  calls.createComponent += 1;
  component.createInstance = function () {
    calls.createInstance += 1;
    var instance = makeNode("INSTANCE", true);
    instance.name = component.name;
    instance.width = component.width;
    instance.height = component.height;
    for (var i = 0; i < component.children.length; i++) {
      instance.appendChild(component.children[i].clone());
    }
    return instance;
  };
  return component;
}

function makePage(name) {
  var page = makeNode("PAGE", true);
  page.name = name;
  page.selection = [];
  page.loadAsync = function () { return Promise.resolve(); };
  var append = page.appendChild;
  page.appendChild = function (child) {
    // Отказ хоста на служебной странице: приёмник обязан ответить `ok` и
    // назвать определение НЕподтверждённым, а не молча продолжить.
    if (rejectAppendOnPage && page.getPluginData("pixso2figmaRole")) {
      throw new Error("страница отказала в appendChild");
    }
    return append.call(page, child);
  };
  pages.push(page);
  return page;
}

function resetFigma() {
  calls = { createComponent: 0, createInstance: 0, createFrame: 0, createPage: 0 };
  pages = [];
  byId = Object.create(null);
  rejectAppendOnPage = false;
  var first = makePage("Page 1");
  global.figma = {
    mixed: Symbol("mixed"),
    root: { name: "Doc", get children() { return pages; } },
    currentPage: first,
    setCurrentPageAsync: function (page) { global.figma.currentPage = page; return Promise.resolve(); },
    // Стабильный поиск по id — то, чем инструментальный след отличает
    // «мёртвая ССЫЛКА» от «узла действительно нет».
    getNodeByIdAsync: function (id) { return Promise.resolve(byId[id] || null); },
    createPage: function () { calls.createPage += 1; return makePage("Page " + (pages.length + 1)); },
    createFrame: function () { calls.createFrame += 1; return makeNode("FRAME", true); },
    createText: function () {
      var text = makeNode("TEXT", false);
      text.characters = "";
      text.fontName = { family: "Inter", style: "Regular" };
      return text;
    },
    createRectangle: function () { return makeNode("RECTANGLE", false); },
    createVector: function () { return makeNode("VECTOR", false); },
    createComponent: makeComponent,
    createImage: function (bytes) { return { hash: "img-" + bytes.length }; },
    loadFontAsync: function () { return Promise.resolve(); },
    viewport: { scrollAndZoomIntoView: function () {} },
    ui: { postMessage: function () {} },
    notify: function () {},
  };
}

// Модуль загружается ДО появления global.figma: иначе сработает setup().
var importer = require("../Main.js");
var UNAVAILABLE = importer.DEFINITION_UNAVAILABLE;
resetFigma();

// ---------------------------------------------------------------------------
// Материал
// ---------------------------------------------------------------------------

var DIRECT = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };
var jobSeq = 0;

function task(jobId, type, payload) {
  return {
    jobId: jobId,
    taskId: jobId + "-" + type + "-" + (nodeSeq += 1),
    type: "DIRECT_PIX_" + type,
    payload: Object.assign({}, DIRECT, payload || {}),
  };
}

function iconDefinition() {
  return {
    definitionId: "2:20", componentKey: "key-icon", name: "Иконка",
    nodes: [
      { id: "2:20", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Иконка", x: 0, y: 0, width: 16, height: 16 },
      { id: "2:21", parent: "2:20", kind: "ORDINARY", type: "RECTANGLE", name: "Контур", x: 0, y: 0, width: 16, height: 16 },
    ],
  };
}

function buttonDefinition() {
  return {
    definitionId: "2:31", componentKey: "key-button", name: "Кнопка",
    nodes: [
      { id: "2:31", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Кнопка", x: 0, y: 0, width: 120, height: 40 },
      {
        id: "2:32", parent: "2:31", kind: "ORDINARY", type: "TEXT", name: "Подпись",
        x: 0, y: 0, width: 60, height: 20,
        text: { characters: "Кнопка", fontName: { family: "Inter", style: "Regular" }, fontSize: 14 },
      },
      {
        id: "2:33", parent: "2:31", kind: "INSTANCE", type: "INSTANCE", name: "Иконка",
        definitionId: "2:20", x: 80, y: 12, width: 16, height: 16,
      },
    ],
  };
}

/** Корень с одним вхождением заданного определения и правками под ним. */
function rootWithOccurrence(definitionId, overrides) {
  return [
    { id: "3:1", parent: null, kind: "ORDINARY", type: "FRAME", name: "Экран", x: 0, y: 0, width: 400, height: 300 },
    {
      id: "3:2", parent: "3:1", kind: "INSTANCE", type: "INSTANCE", name: "Вхождение",
      definitionId: definitionId, x: 0, y: 0, width: 120, height: 40,
      overrides: overrides || [],
    },
  ];
}

function servicePage() {
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].getPluginData("pixso2figmaRole") === importer.DIRECT_SERVICE_PAGE.role) return pages[i];
  }
  return null;
}

function definitionComponent(definitionId) {
  var page = servicePage();
  if (!page) return null;
  for (var i = 0; i < page.children.length; i++) {
    if (page.children[i].getPluginData("pixsoDirectDefinitionId") === definitionId) return page.children[i];
  }
  return null;
}

/** Заводит job с доставленными определениями и отдаёт его id. */
async function startJobWithDefinitions(definitions) {
  var jobId = "job" + (jobSeq += 1);
  await importer.handleDirectTask(task(jobId, "START", { source: { fileName: "f.pix" } }), {});
  var result = await importer.handleDirectTask(
    task(jobId, "DEFINITIONS", { definitions: definitions }), {}
  );
  return { jobId: jobId, definitions: result };
}

async function run() {
  // -------------------------------------------------------------------------
  // 9. Подтверждение доставки: `ready` называет пригодные определения
  // -------------------------------------------------------------------------
  resetFigma();
  var jobA = await startJobWithDefinitions([iconDefinition(), buttonDefinition()]);
  eq(jobA.definitions.ok, true, "доставка определений отвечает ok");
  eq(jobA.definitions.ready.length, 2, "оба определения подтверждены пригодными");
  eq(jobA.definitions.ready.indexOf("2:31") >= 0, true, "кнопка в списке подтверждённых");
  eq(jobA.definitions.failed.length, 0, "отказов нет");
  eq(jobA.definitions.definitionsCreated, 2, "созданы оба определения");

  // -------------------------------------------------------------------------
  // 11. Повтор доставки не плодит второй канонический компонент
  // -------------------------------------------------------------------------
  var componentsAfterFirst = calls.createComponent;
  var repeat = await importer.handleDirectTask(
    task(jobA.jobId, "DEFINITIONS", { definitions: [buttonDefinition()] }), {}
  );
  eq(calls.createComponent, componentsAfterFirst, "повторная доставка не создала второй компонент");
  eq(repeat.definitionsCreated, 0, "повтор ничего не создал");
  eq(repeat.definitionsReused, 1, "повтор посчитан переиспользованием");
  eq(repeat.ready.indexOf("2:31") >= 0, true, "уже живое определение подтверждается снова");

  // -------------------------------------------------------------------------
  // 10. Неудавшаяся доставка НЕ подтверждается
  // -------------------------------------------------------------------------
  resetFigma();
  var jobId = "jobReject";
  await importer.handleDirectTask(task(jobId, "START", { source: { fileName: "f.pix" } }), {});
  rejectAppendOnPage = true;
  var rejected = await importer.handleDirectTask(
    task(jobId, "DEFINITIONS", { definitions: [iconDefinition()] }), {}
  );
  rejectAppendOnPage = false;
  eq(rejected.ok, true, "отказ одного определения не роняет job");
  eq(rejected.ready.length, 0, "непостроенное определение не подтверждено");
  eq(rejected.failed.length, 1, "отказ назван поимённо");
  eq(rejected.failed[0].definitionId, "2:20", "назван именно отказавший definitionId");
  eq(rejected.failed[0].reason, "DEFINITION_PAGE_REJECTED", "у отказа есть типизированная причина");

  // -------------------------------------------------------------------------
  // 1. Ожидался INSTANCE, записи в реестре нет
  // -------------------------------------------------------------------------
  resetFigma();
  var jobB = await startJobWithDefinitions([iconDefinition()]);
  var missing = await importer.handleDirectTask(
    task(jobB.jobId, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:999") }),
    { createPages: true }
  );
  eq(missing.expectedInstances, 1, "вхождение ожидалось инстансом");
  eq(missing.instancesCreated, 0, "инстанс не создан");
  eq(missing.instanceDefinitionUnavailable, 1, "причина посчитана причинным счётчиком");
  eq(missing.placeholderFramesCreated, 1, "создана ровно одна заглушка");
  eq(missing.ordinaryNodesCreated, 1, "обычным узлом посчитан только корень, а не заглушка");

  // -------------------------------------------------------------------------
  // 3. Заглушка несёт причинную метку деградации
  // -------------------------------------------------------------------------
  var screen = pages.filter(function (page) { return page.name === "Экран"; })[0];
  var placeholder = screen.children[0].children[0];
  eq(placeholder.type, "FRAME", "вхождение выродилось в помеченный контейнер");
  eq(placeholder.getPluginData("pixsoDirectFallback"), "INSTANCE_DEFINITION_UNAVAILABLE",
    "деградация названа причинным кодом");
  eq(placeholder.getPluginData("pixsoDirectFallbackReason"), UNAVAILABLE.NOT_REGISTERED,
    "подпричина: записи в реестре не было");
  eq(placeholder.getPluginData("pixsoDirectDefinitionId"), "2:999",
    "заглушка помнит, какого определения не хватило");

  var finishB = await importer.handleDirectTask(task(jobB.jobId, "FINISH", {}), {});
  eq(finishB.definitionLifetimeReport.unavailableByReason[UNAVAILABLE.NOT_REGISTERED], 1,
    "итог называет подпричину, а не общий факт");
  var traceB = finishB.definitionLifetimeReport.trace[0];
  eq(traceB.definitionId, "2:999", "след указывает на запрошенное определение");
  eq(traceB.registered, false, "след честно говорит, что записи не было");
  eq(traceB.asyncLookup, "NO_STORED_NODE_ID", "искать по id нечего — и это сказано прямо");

  // -------------------------------------------------------------------------
  // 2 и 7. Запись есть, узел мёртв. H1 против H3 различает поиск по id
  // -------------------------------------------------------------------------
  resetFigma();
  var jobC = await startJobWithDefinitions([iconDefinition()]);
  var iconComponent = definitionComponent("2:20");
  ok(iconComponent, "определение легло на служебную страницу");
  var iconNodeId = iconComponent.id;
  // Ссылка в кеше мертва, но САМ узел по стабильному id жив: ровно этим
  // «потерялась ссылка» отличается от «компонент удалён».
  iconComponent.parent.children.splice(iconComponent.parent.children.indexOf(iconComponent), 1);
  iconComponent.parent = null;

  var dead = await importer.handleDirectTask(
    task(jobC.jobId, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:20") }),
    { createPages: true }
  );
  eq(dead.instancesCreated, 0, "мёртвая ссылка не даёт инстанса");
  eq(dead.instanceDefinitionUnavailable, 1, "потеря посчитана причинным счётчиком");
  var deadPlaceholder = pages.filter(function (p) { return p.name === "Экран"; })[0]
    .children[0].children[0];
  eq(deadPlaceholder.getPluginData("pixsoDirectFallbackReason"), UNAVAILABLE.NODE_DETACHED,
    "подпричина: узел отцеплен, а не «его нет»");

  var finishC = await importer.handleDirectTask(task(jobC.jobId, "FINISH", {}), {});
  var traceC = finishC.definitionLifetimeReport.trace[0];
  eq(traceC.registered, true, "след подтверждает: запись в реестре была");
  eq(traceC.storedNodeId, iconNodeId, "реестр сохранил стабильный id узла Figma");
  eq(traceC.asyncLookup, "FOUND", "по сохранённому id узел находится");
  eq(traceC.asyncNodeType, "COMPONENT", "найденный узел — тот самый канонический компонент");
  ok(traceC.registrationPageId, "след помнит страницу регистрации");
  eq(traceC.rootsSinceCreation >= 0, true, "след измеряет дистанцию от создания в корнях");

  // Настоящее удаление остаётся отдельным типизированным отказом.
  resetFigma();
  var jobD = await startJobWithDefinitions([iconDefinition()]);
  definitionComponent("2:20").remove();
  var removed = await importer.handleDirectTask(
    task(jobD.jobId, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:20") }),
    { createPages: true }
  );
  eq(removed.instanceDefinitionUnavailable, 1, "удалённое определение — тоже причинный отказ");
  eq(pages.filter(function (p) { return p.name === "Экран"; })[0]
    .children[0].children[0].getPluginData("pixsoDirectFallbackReason"),
    UNAVAILABLE.NODE_REMOVED, "удаление названо удалением, а не «нет записи»");

  // -------------------------------------------------------------------------
  // 8. Узел не того типа отвергается, а не используется наугад
  // -------------------------------------------------------------------------
  resetFigma();
  var jobE = await startJobWithDefinitions([iconDefinition()]);
  var swapped = definitionComponent("2:20");
  swapped.type = "FRAME";
  var wrongType = await importer.handleDirectTask(
    task(jobE.jobId, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:20") }),
    { createPages: true }
  );
  eq(wrongType.instancesCreated, 0, "чужой тип узла не годится в определение");
  eq(pages.filter(function (p) { return p.name === "Экран"; })[0]
    .children[0].children[0].getPluginData("pixsoDirectFallbackReason"),
    UNAVAILABLE.WRONG_NODE_TYPE, "тип назван причиной отказа");

  // -------------------------------------------------------------------------
  // 4. Правки под заглушкой НЕ становятся промахами адресации
  // -------------------------------------------------------------------------
  resetFigma();
  var jobF = await startJobWithDefinitions([iconDefinition()]);
  var overrides = [
    { path: [{ index: 0, sourceId: "2:32", definitionId: "2:999" }], ops: { characters: "Текст" },
      present: { characters: true } },
    { path: [{ index: 1, sourceId: "2:33", definitionId: "2:999" }], ops: { visible: false },
      present: { visible: true } },
  ];
  var degraded = await importer.handleDirectTask(
    task(jobF.jobId, "ROOT", {
      pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:999", overrides),
    }),
    { createPages: true }
  );
  eq(degraded.overridesMissed, 2, "правки посчитаны потерянными");
  eq(degraded.overrideMissReasons.OVERRIDE_SKIPPED_DEFINITION_UNAVAILABLE, 2,
    "у потерь причина деградации, а не адресации");
  eq(degraded.overrideMissReasons.TARGET_INDEX_OUT_OF_RANGE, undefined,
    "производный симптом пустого поддерева больше не появляется");
  eq(degraded.overrideMissReasons.TARGET_NOT_EXPOSED_IN_INSTANCE_SUBTREE, undefined,
    "и второй производный симптом тоже");
  var sample = degraded.overrideMissSamples[0];
  eq(sample.reason, "OVERRIDE_SKIPPED_DEFINITION_UNAVAILABLE", "образец несёт причинный код");
  eq(sample.definitionUnavailableReason, UNAVAILABLE.NOT_REGISTERED,
    "образец сохраняет ПОДпричину деградации");
  eq(sample.expectedDefinitionId, "2:999", "образец называет недостающее определение");

  // -------------------------------------------------------------------------
  // 14. Приёмник по-прежнему ловит правку чужого вложенного определения
  // -------------------------------------------------------------------------
  resetFigma();
  var jobG = await startJobWithDefinitions([iconDefinition(), buttonDefinition()]);
  var foreign = [
    {
      // Второй шаг объявлен в определении, которого вложенный узел НЕ
      // показывает: это и есть чужой контекст подмены.
      path: [
        { index: 1, sourceId: "2:33", definitionId: "2:31" },
        { index: 0, sourceId: "2:21", definitionId: "9:999" },
      ],
      ops: { visible: false }, present: { visible: true },
    },
  ];
  var guarded = await importer.handleDirectTask(
    task(jobG.jobId, "ROOT", {
      pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:31", foreign),
    }),
    { createPages: true }
  );
  // Вложенная иконка приезжает КЛОНОМ внутри инстанса кнопки: своим
  // createInstance она была создана один раз — при сборке определения.
  eq(guarded.instancesCreated, 1, "вхождение стало нативным инстансом");
  eq(guarded.overrideMissReasons.WRONG_NESTED_SWAP_CONTEXT, 1,
    "сторож чужого вложенного контекста продолжает работать");

  // -------------------------------------------------------------------------
  // 15. H3-различитель: узла нет и по стабильному id
  // -------------------------------------------------------------------------
  // Удаление и «мёртвая ссылка при живом узле» дают ОДИН и тот же симптом на
  // кеше. Разводит их только поиск по сохранённому id, и его ответ обязан
  // попасть в след: без него H1 и H3 неразличимы, а лечатся они по-разному.
  resetFigma();
  var jobH = await startJobWithDefinitions([iconDefinition()]);
  var doomed = definitionComponent("2:20");
  var doomedId = doomed.id;
  doomed.remove();
  delete byId[doomedId];               // узла нет и в документе, не только в кеше
  await importer.handleDirectTask(
    task(jobH.jobId, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:20") }),
    { createPages: true }
  );
  var finishH = await importer.handleDirectTask(task(jobH.jobId, "FINISH", {}), {});
  var traceH = finishH.definitionLifetimeReport.trace[0];
  eq(traceH.storedNodeId, doomedId, "след помнит id, по которому искали");
  eq(traceH.asyncLookup, "NULL", "по стабильному id узла нет — это H3, а не H1");
  eq(traceH.asyncNodeType, null, "у ненайденного узла нет типа");
  eq(traceH.cachedRefUsable, false, "ссылка в кеше названа непригодной прямо");
  eq(traceH.occurrenceId, "3:2", "след называет вхождение, на котором это вскрылось");

  // -------------------------------------------------------------------------
  // 16. dynamic-page: чтение свойства БРОСАЕТ — это не «узел удалён»
  // -------------------------------------------------------------------------
  // Под `documentAccess: "dynamic-page"` часть геттеров бросает на узле
  // выгруженной страницы. Одно общее try/catch назвало бы это удалением и
  // отправило бы искать несуществующего удалятеля.
  resetFigma();
  var jobI = await startJobWithDefinitions([iconDefinition()]);
  var unloaded = definitionComponent("2:20");
  var unloadedId = unloaded.id;
  Object.defineProperty(unloaded, "removed", {
    configurable: true,
    get: function () { throw new Error("page not loaded"); },
  });
  var inaccessible = await importer.handleDirectTask(
    task(jobI.jobId, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:20") }),
    { createPages: true }
  );
  eq(inaccessible.instancesCreated, 0, "недоступное определение инстанса не даёт");
  eq(inaccessible.instanceDefinitionUnavailable, 1, "потеря посчитана причинным счётчиком");
  eq(pages.filter(function (p) { return p.name === "Экран"; })[0]
    .children[0].children[0].getPluginData("pixsoDirectFallbackReason"),
    UNAVAILABLE.NODE_INACCESSIBLE,
    "бросивший геттер — это «недоступен», а не «удалён»");
  var finishI = await importer.handleDirectTask(task(jobI.jobId, "FINISH", {}), {});
  eq(finishI.definitionLifetimeReport.unavailableByReason[UNAVAILABLE.NODE_REMOVED], undefined,
    "удаления здесь не было, и оно не приписано");
  var traceI = finishI.definitionLifetimeReport.trace[0];
  eq(traceI.cachedRemoved, null, "непрочитанное осталось непрочитанным, а не false");
  eq(traceI.storedNodeId, unloadedId, "id узла сохранён и доказуем");
  eq(traceI.asyncLookup, "FOUND", "сам узел на месте — блокирует доступ, а не смерть");

  // -------------------------------------------------------------------------
  // 17. Подмена компонента: недоступное определение — своя причина
  // -------------------------------------------------------------------------
  // Прежде такой отказ попадал в общий `OVERRIDE_OPERATION_REJECTED` вместе
  // с отказами хоста: причина жизненного цикла снова читалась как отказ
  // применения правки.
  resetFigma();
  var jobJ = await startJobWithDefinitions([iconDefinition(), buttonDefinition()]);
  var swapOverrides = [
    {
      path: [{ index: 1, sourceId: "2:33", definitionId: "2:31" }],
      ops: { swapDefinitionId: "9:404" }, present: { swapDefinitionId: true },
    },
  ];
  var swapped2 = await importer.handleDirectTask(
    task(jobJ.jobId, "ROOT", {
      pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:31", swapOverrides),
    }),
    { createPages: true }
  );
  eq(swapped2.instancesCreated, 1, "само вхождение осталось нативным инстансом");
  eq(swapped2.overrideMissReasons.OVERRIDE_SWAP_DEFINITION_UNAVAILABLE, 1,
    "подмена названа отказом по недоступному определению");
  eq(swapped2.overrideMissReasons.OVERRIDE_OPERATION_REJECTED, undefined,
    "и больше не прячется в общем отказе применения");
  eq(swapped2.instanceDefinitionUnavailable, 1,
    "недоступное определение подмены посчитано тем же причинным счётчиком");
  var finishJ = await importer.handleDirectTask(task(jobJ.jobId, "FINISH", {}), {});
  eq(finishJ.definitionLifetimeReport.unavailableByReason[UNAVAILABLE.NOT_REGISTERED], 1,
    "подпричина подмены названа так же, как у вхождения");

  // -------------------------------------------------------------------------
  // 18. Отказавшая доставка не оставляет за собой канонический компонент
  // -------------------------------------------------------------------------
  // Неудачная сборка успевает создать узел. Оставленный, он становится вторым
  // каноническим определением того же definitionId, как только отправитель
  // пришлёт определение повторно.
  resetFigma();
  var jobK = "jobRetry";
  await importer.handleDirectTask(task(jobK, "START", { source: { fileName: "f.pix" } }), {});
  rejectAppendOnPage = true;
  var failedDelivery = await importer.handleDirectTask(
    task(jobK, "DEFINITIONS", { definitions: [iconDefinition()] }), {}
  );
  rejectAppendOnPage = false;
  eq(failedDelivery.ready.length, 0, "отказавшая доставка не подтверждена");
  eq(definitionComponent("2:20"), null, "на служебной странице ничего не осело");
  var orphans = Object.keys(byId).filter(function (id) {
    return byId[id].type === "COMPONENT" &&
      byId[id].getPluginData("pixsoDirectDefinitionId") === "2:20" && !byId[id].removed;
  });
  eq(orphans.length, 0, "и живого осиротевшего компонента тоже не осталось");

  // Переотправка: ровно один канонический компонент, а не два.
  var retried = await importer.handleDirectTask(
    task(jobK, "DEFINITIONS", { definitions: [iconDefinition()] }), {}
  );
  eq(retried.ready.indexOf("2:20") >= 0, true, "повторная доставка подтверждена");
  eq(retried.definitionsCreated, 1, "определение собрано ровно один раз");
  eq(retried.definitionsReused, 0, "и это сборка, а не переиспользование мусора");
  var canonical = servicePage().children.filter(function (child) {
    return child.getPluginData("pixsoDirectDefinitionId") === "2:20";
  });
  eq(canonical.length, 1, "после повтора канонический компонент ровно один");
  var alive = Object.keys(byId).filter(function (id) {
    return byId[id].type === "COMPONENT" &&
      byId[id].getPluginData("pixsoDirectDefinitionId") === "2:20" && !byId[id].removed;
  });
  eq(alive.length, 1, "дубликата канонического определения в документе нет");

  // Вхождение после повтора становится настоящим инстансом.
  var afterRetry = await importer.handleDirectTask(
    task(jobK, "ROOT", { pageName: "Экран", rootId: "3:1", nodes: rootWithOccurrence("2:20") }),
    { createPages: true }
  );
  eq(afterRetry.instancesCreated, 1, "переотправленное определение даёт инстанс");
  eq(afterRetry.instanceDefinitionUnavailable, 0, "и ни одной причинной потери");

  // -------------------------------------------------------------------------
  // 19. Отпечаток сборки доказывает, что загружен приёмник С инструментовкой
  // -------------------------------------------------------------------------
  var finishK = await importer.handleDirectTask(task(jobK, "FINISH", {}), {});
  eq(finishK.receiverBuild.definitionLifetime, true,
    "приёмник объявляет наличие инструментовки жизненного цикла");

  console.log("OK: Direct PIX жизненный цикл определения — " + checks + " проверок пройдено");
}

run().catch(function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
