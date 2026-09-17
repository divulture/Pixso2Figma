"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var Fixture = require("./Fixture");
var PixContainer = require("../PixContainer");
var PixDocument = require("../PixDocument");
var MigrationIR = require("../MigrationIR");
var Cli = require("../Cli");
var BridgeClient = require("../BridgeClient");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }

var single = Cli.parseArgs(["file.pix", "--root", "2:46399", "--migrate"]);
eq(single.migrate, true, "старый --root --migrate сохранил semantics");
eq(single.migrateFile, false, "single-root режим не превращается в full document");
eq(single.roots[0], "2:46399", "root id разбирается без изменений");

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-pages-"));
assert.throws(function () { Cli.parseArgs(["file.pix", "--all-pages"]); }, /Неизвестная опция/,
  "не документированный alias не меняет CLI");
checks += 1;

var full = Cli.parseArgs(["file.pix", "--migrate-file", "--debug-overrides"]);
eq(full.migrateFile, true, "canonical full-document flag распознан");
eq(full.debugOverrides, true, "debug override report включается отдельно");
eq(full.roots.length, 0, "full-document режим не подменяет --root");

var textTrace = Cli.parseArgs([
  "file.pix", "--migrate-file", "--trace-text-overrides", "--text-override-trace-limit", "7",
]);
eq(textTrace.traceTextOverrides, true, "bounded TEXT override trace включается отдельно");
eq(textTrace.textOverrideTraceLimit, 7, "лимит TEXT trace разбирается из CLI");

try {
  var file = path.join(temp, "pages.pix");
  var built = Fixture.buildContainer();
  fs.writeFileSync(file, built.zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var plan = Cli.createDocumentPlan(doc);
  eq(plan.pages.length, 2, "две пользовательские Pixso pages попали в план");
  eq(plan.pages[0].pageId, built.scene.ids.libraryCanvas, "page identity основана на source id");
  eq(plan.pages[1].pageId, built.scene.ids.screenCanvas, "вторая page сохраняет source id");
  eq(plan.pages[1].roots[0].key, built.scene.ids.screenRoot, "порядок roots страницы сохранён");

  // Фильтр не смотрит на имя: одноимённая с системной страница остаётся,
  // а явно помеченная internal — пропускается независимо от имени.
  doc.tree.pages[0].internal = true;
  doc.tree.pages[0].name = "Ordinary visible name";
  doc.tree.pages[1].name = "Internal";
  plan = Cli.createDocumentPlan(doc);
  eq(plan.pages.length, 1, "явно internal page пропущена");
  eq(plan.pages[0].pageId, built.scene.ids.screenCanvas, "страница с подозрительным именем не фильтруется");
  eq(plan.skipped.length, 1, "пропуск internal page попал в отчёт");
  eq(plan.skipped[0].reason, "INTERNAL_PAGE", "причина пропуска фиксирована");

  var root = plan.pages[0].roots[0];
  var ir = MigrationIR.build(doc, { roots: [root] });
  eq(ir.roots[0].pageId, built.scene.ids.screenCanvas, "page id едет в root payload");
  eq(ir.roots[0].pageName, "Internal", "page name сохраняется без name-based filtering");
  ok(ir.definitions.length > 0, "definitions для пользовательского root остаются demand-driven");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function fakeClient(failRootId) {
  var tasks = [];
  var id = "fake-job";
  return {
    DIRECT_TASK: BridgeClient.DIRECT_TASK,
    transport: { postMs: 1, ackMs: 2, tasks: 0, bytes: 0 },
    tasks: tasks,
    ensureReceiver: function () { return Promise.resolve({ documentName: "Fake", receiverVersion: "test" }); },
    start: function () { return Promise.resolve(id); },
    finish: function () { return Promise.resolve(); },
    jobId: function () { return id; },
    chunked: function (items) { return items.length ? [items] : []; },
    sendTask: function (type, payload) {
      tasks.push({ type: type, payload: payload });
      this.transport.tasks += 1;
      if (type === BridgeClient.DIRECT_TASK.ROOT && payload.rootId === failRootId) {
        return Promise.reject(new Error("synthetic root failure"));
      }
      if (type === BridgeClient.DIRECT_TASK.DEFINITIONS) {
        return Promise.resolve({ definitionsCreated: payload.definitions.length, definitionsReused: 0, definitionBuildMs: 1 });
      }
      if (type === BridgeClient.DIRECT_TASK.ROOT) {
        return Promise.resolve({ ordinaryNodesCreated: payload.nodes.length, instancesCreated: 0, overridesAttempted: 0, overridesApplied: 0, overridesMissed: 0, overrideMissReasons: {} });
      }
      if (type === BridgeClient.DIRECT_TASK.FINISH) {
        return Promise.resolve({ totalImportMs: 3, overrideResolutionReport: { totalMisses: 0, reasons: {}, samples: [] } });
      }
      return Promise.resolve({});
    },
  };
}

async function runTransportTests() {
  var transportTemp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-stream-"));
  try {
    var file = path.join(transportTemp, "stream.pix");
    var built = Fixture.buildContainer();
    fs.writeFileSync(file, built.zip);
    var doc = PixDocument.load(PixContainer.open(file));
    var root = doc.tree.byKey.get(built.scene.ids.screenRoot);
    var client = fakeClient(null);
    var streamPlan = {
      pages: [
        { pageId: "page:a", pageName: "Same", roots: [root] },
        { pageId: "page:b", pageName: "Same", roots: [root] },
      ],
      skipped: [],
    };
    var report = await Cli.migrateFile(doc, streamPlan, {
      bridge: "http://unused", client: client, debugOverrides: true,
    });
    eq(report.pagesImported, 2, "full-document transport объявил обе страницы");
    eq(report.rootsImported, 2, "roots обеих страниц отправлены последовательно");
    eq(report.definitionsBuilt, 2, "общие definitions построены один раз");
    eq(report.definitionsReused, 2, "те же definitions переиспользованы на второй странице");
    // Каноническая идентичность агрегируется по всей job, а не по корню:
    // один и тот же компонент в разных корнях не должен считаться заново
    // «не найденным» и не должен теряться из отчёта.
    ok(report.canonical, "отчёт несёт счётчики канонической идентичности");
    ok(report.canonical.pixInstancesSeen > 0, "вхождения обоих корней просмотрены");
    eq(report.canonical.canonicalResolved + report.canonical.canonicalUnresolved,
      report.canonical.pixInstancesSeen, "каждое просмотренное вхождение попало ровно в один исход");
    eq(report.canonical.canonicalUnresolved, 0, "промахов идентичности на фикстуре нет");
    eq(report.canonical.resolvedViaInternalOnly + report.canonical.resolvedViaSymbolData,
      report.canonical.canonicalResolved, "каждое разрешение отнесено к своему источнику");
    var pageTasks = client.tasks.filter(function (task) { return task.type === BridgeClient.DIRECT_TASK.PAGE; });
    var rootTasks = client.tasks.filter(function (task) { return task.type === BridgeClient.DIRECT_TASK.ROOT; });
    eq(pageTasks.length, 2, "на каждую страницу есть отдельная PAGE task");
    eq(rootTasks[0].payload.pageId, "page:a", "первый root направлен на явную target page");
    eq(rootTasks[1].payload.pageId, "page:b", "второй root не зависит от figma.currentPage");
    eq(client.tasks.filter(function (task) { return task.type === BridgeClient.DIRECT_TASK.DEFINITIONS; }).length, 1,
      "definition payload не сериализуется в bridge второй раз");

    var failing = fakeClient(root.key);
    var failure = null;
    try {
      await Cli.migrateFile(doc, { pages: [{ pageId: "page:fail", pageName: "Fail", roots: [root] }], skipped: [] }, {
        bridge: "http://unused", client: failing, debugOverrides: false,
      });
    } catch (error) { failure = error; }
    ok(failure, "ошибка импорта root останавливает job явно");
    eq(failure.directReport.rootsFailed, 1, "failed root посчитан");
    eq(failure.directReport.rootFailures[0].stage, "FIGMA_IMPORT", "в отчёте названа стадия отказа");
  } finally {
    fs.rmSync(transportTemp, { recursive: true, force: true });
  }
}

runTransportTests().then(function () {
  process.stdout.write("OK: Direct PIX full-document plan — " + checks + " проверок пройдено\n");
}).catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
});
