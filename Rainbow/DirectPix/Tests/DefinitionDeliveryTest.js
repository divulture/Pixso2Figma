/**
 * Direct PIX: доставка определений с подтверждением.
 *
 *   node DirectPix/Tests/DefinitionDeliveryTest.js
 *
 * Проверяется одно утверждение:
 *
 *   определение считается отправленным только тогда, когда приёмник
 *   подтвердил его ПРИГОДНЫМ, — и не раньше.
 *
 * Раньше отметка «отправлено» ставилась в момент сборки пакета, до всякого
 * ответа. Одного отказа приёмника хватало, чтобы определение исчезло из
 * job навсегда: следующий корень считал его уже отправленным и уезжал
 * ссылкой в пустоту, а все его вхождения становились заглушками.
 *
 * Вторая половина того же дефекта — общий IR-реестр: ключ попадал в него в
 * момент сборки, и упавшая посередине сборка корня оставляла определения,
 * которые уже никто никогда не приложит к пакету.
 */
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
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

/**
 * Приёмник, отказывающий в подтверждении первой доставке.
 *
 * `refuseFirst` — сколько первых задач DEFINITIONS отвечают `ok`, но с
 * пустым `ready`: ровно так ведёт себя настоящий приёмник, когда служебная
 * страница отказала в appendChild.
 */
function fakeClient(options) {
  options = options || {};
  var refusalsLeft = options.refuseFirst || 0;
  var tasks = [];
  var deliveries = [];
  return {
    DIRECT_TASK: BridgeClient.DIRECT_TASK,
    transport: { postMs: 1, ackMs: 2, tasks: 0, bytes: 0 },
    tasks: tasks,
    deliveries: deliveries,
    ensureReceiver: function () {
      return Promise.resolve({ documentName: "Fake", receiverVersion: "test" });
    },
    start: function () { return Promise.resolve("fake-job"); },
    finish: function () { return Promise.resolve(); },
    jobId: function () { return "fake-job"; },
    chunked: function (items) { return items.length ? [items] : []; },
    sendTask: function (type, payload) {
      tasks.push({ type: type, payload: payload });
      this.transport.tasks += 1;
      if (type === BridgeClient.DIRECT_TASK.DEFINITIONS) {
        var ids = payload.definitions.map(function (d) { return d.definitionId; });
        deliveries.push(ids);
        if (refusalsLeft > 0) {
          refusalsLeft -= 1;
          // Отказ одного определения не роняет job: ответ остаётся `ok`.
          return Promise.resolve({
            definitionsCreated: 0, definitionsReused: 0, definitionBuildMs: 1,
            ready: [],
            failed: ids.map(function (id) {
              return { definitionId: id, reason: "DEFINITION_PAGE_REJECTED" };
            }),
          });
        }
        return Promise.resolve({
          definitionsCreated: ids.length, definitionsReused: 0, definitionBuildMs: 1,
          ready: ids, failed: [],
        });
      }
      if (type === BridgeClient.DIRECT_TASK.ROOT) {
        return Promise.resolve({
          ordinaryNodesCreated: payload.nodes.length, instancesCreated: 0,
          overridesAttempted: 0, overridesApplied: 0, overridesMissed: 0,
          overrideMissReasons: {},
        });
      }
      if (type === BridgeClient.DIRECT_TASK.FINISH) {
        return Promise.resolve({
          totalImportMs: 3,
          overrideResolutionReport: { totalMisses: 0, reasons: {}, samples: [] },
        });
      }
      return Promise.resolve({});
    },
  };
}

function manyRootPlan(doc, rootKey, count) {
  var root = doc.tree.byKey.get(rootKey);
  var pages = [];
  for (var i = 0; i < count; i++) {
    pages.push({ pageId: "page:" + i, pageName: "Стр " + (i + 1), roots: [root] });
  }
  return { pages: pages, skipped: [] };
}

function twoRootPlan(doc, rootKey) {
  var root = doc.tree.byKey.get(rootKey);
  return {
    pages: [
      { pageId: "page:a", pageName: "Первая", roots: [root] },
      { pageId: "page:b", pageName: "Вторая", roots: [root] },
    ],
    skipped: [],
  };
}

async function run() {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-direct-delivery-"));
  try {
    var file = path.join(temp, "scene.pix");
    var built = Fixture.buildContainer();
    fs.writeFileSync(file, built.zip);
    var doc = PixDocument.load(PixContainer.open(file));

    // -----------------------------------------------------------------------
    // 9. Подтверждённая доставка фиксирует отправленное состояние
    // -----------------------------------------------------------------------
    var good = fakeClient({});
    var okReport = await Cli.migrateFile(doc, twoRootPlan(doc, built.scene.ids.screenRoot), {
      bridge: "http://unused", client: good,
    });
    eq(good.deliveries.length, 1, "подтверждённое определение уезжает ровно один раз");
    ok(okReport.definitionDelivery.acknowledged > 0, "подтверждения посчитаны");
    eq(okReport.definitionDelivery.unconfirmed, 0, "неподтверждённых нет");
    eq(okReport.definitionDelivery.retransmissionsScheduled, 0, "переотправлять нечего");
    eq(okReport.definitionDelivery.unacknowledgedReceiver, false,
      "приёмник этой сборки умеет подтверждать");
    eq(okReport.rootsImported, 2, "оба корня импортированы");

    // -----------------------------------------------------------------------
    // 10 и 11. Отказ не фиксируется отправленным и даёт ровно одну переотправку
    // -----------------------------------------------------------------------
    var doc2 = PixDocument.load(PixContainer.open(file));
    var flaky = fakeClient({ refuseFirst: 1 });
    var retryReport = await Cli.migrateFile(doc2, twoRootPlan(doc2, built.scene.ids.screenRoot), {
      bridge: "http://unused", client: flaky,
    });
    eq(flaky.deliveries.length, 2, "неподтверждённое определение уехало второй раз");
    eq(retryReport.rootsImported, 2, "отказ определения не остановил job");
    ok(retryReport.definitionDelivery.unconfirmed > 0, "неподтверждённые названы");
    ok(retryReport.definitionDelivery.retransmissionsScheduled > 0,
      "переотправка запланирована, а не забыта");
    eq(retryReport.definitionDelivery.failedByReason.DEFINITION_PAGE_REJECTED,
      flaky.deliveries[0].length, "причина отказа сохранена как есть, без догадок");

    var first = flaky.deliveries[0].slice().sort();
    var second = flaky.deliveries[1].slice().sort();
    assert.deepStrictEqual(second, first,
      "повторно уехали ровно те же определения — ни больше, ни меньше");
    checks += 1;
    // Канонический компонент не дублируется: второй пакет — та же
    // идентичность, а дедупликацию на своей стороне держит приёмник.
    eq(new Set(second).size, second.length, "в повторном пакете нет дублей");

    // -----------------------------------------------------------------------
    // Право на переотправку одноразовое
    // -----------------------------------------------------------------------
    // Приёмник, который не может построить определение В ПРИНЦИПЕ, отвечает
    // отказом каждый раз. Без границы такое определение уезжало бы полным
    // деревом на КАЖДОМ следующем корне: сериализация, трафик и время — а
    // вхождений взамен по-прежнему ноль. Одна повторная попытка покрывает
    // случайный отказ; вторая уже ничего не проверяет.
    var docLoop = PixDocument.load(PixContainer.open(file));
    var stubborn = fakeClient({ refuseFirst: 99 });
    var loopReport = await Cli.migrateFile(docLoop, manyRootPlan(docLoop, built.scene.ids.screenRoot, 4), {
      bridge: "http://unused", client: stubborn,
    });
    eq(stubborn.deliveries.length, 2,
      "первая доставка плюс ровно одна переотправка — и ни одной сверх");
    eq(loopReport.rootsImported, 4, "отказ определения по-прежнему не роняет job");
    ok(loopReport.definitionDelivery.abandoned > 0,
      "брошенное после повтора определение НАЗВАНО, а не растворилось в цикле");
    eq(loopReport.definitionDelivery.abandoned, stubborn.deliveries[0].length,
      "брошены ровно те определения, что отказали дважды");
    eq(loopReport.definitionDelivery.retransmissionsScheduled, stubborn.deliveries[0].length,
      "переотправка назначалась ровно один раз на определение");
    ok(loopReport.definitionDelivery.abandonedIds.length > 0,
      "брошенные названы поимённо, а не одним числом");

    // -----------------------------------------------------------------------
    // Малый прогон (--root): подтверждение видно и здесь
    // -----------------------------------------------------------------------
    // В этом режиме определения уезжают одним проходом до корней, и
    // переотправлять нечего. Но отказ обязан быть НАЗВАН: иначе малый прогон
    // не может доказать здоровье доставки, а именно им её и проверяют.
    var docProbe = PixDocument.load(PixContainer.open(file));
    var probeRoot = docProbe.tree.byKey.get(built.scene.ids.screenRoot);
    var probeIr = MigrationIR.build(docProbe, { roots: [probeRoot] });
    var probeClient = fakeClient({});
    var probeResult = await Cli.migrate(docProbe, probeIr, {
      bridge: "http://unused", client: probeClient,
    });
    ok(probeResult.definitionDelivery, "малый прогон отдаёт отчёт о доставке");
    eq(probeResult.definitionDelivery.acknowledged, probeIr.definitions.length,
      "подтверждены все отправленные определения");
    eq(probeResult.definitionDelivery.unconfirmed, 0, "неподтверждённых нет");
    eq(probeResult.definitionDelivery.unacknowledgedReceiver, false,
      "приёмник подтверждения присылает");

    var docProbeBad = PixDocument.load(PixContainer.open(file));
    var probeBadRoot = docProbeBad.tree.byKey.get(built.scene.ids.screenRoot);
    var probeBadIr = MigrationIR.build(docProbeBad, { roots: [probeBadRoot] });
    var probeBad = await Cli.migrate(docProbeBad, probeBadIr, {
      bridge: "http://unused", client: fakeClient({ refuseFirst: 99 }),
    });
    eq(probeBad.definitionDelivery.acknowledged, 0, "отказ не выдан за подтверждение");
    eq(probeBad.definitionDelivery.unconfirmed, probeBadIr.definitions.length,
      "неподтверждённые посчитаны все");
    eq(probeBad.definitionDelivery.failedByReason.DEFINITION_PAGE_REJECTED,
      probeBadIr.definitions.length, "причина отказа названа приёмником и сохранена");
    ok(probeBad.definitionDelivery.unconfirmedIds.length > 0,
      "неподтверждённые названы поимённо");

    // -----------------------------------------------------------------------
    // Старый приёмник без подтверждений: прежняя семантика, но названная
    // -----------------------------------------------------------------------
    var doc3 = PixDocument.load(PixContainer.open(file));
    var legacy = fakeClient({});
    legacy.sendTask = (function (inner) {
      return function (type, payload) {
        return inner.call(legacy, type, payload).then(function (result) {
          if (type === BridgeClient.DIRECT_TASK.DEFINITIONS) {
            delete result.ready;
            delete result.failed;
          }
          return result;
        });
      };
    })(legacy.sendTask);
    var legacyReport = await Cli.migrateFile(doc3, twoRootPlan(doc3, built.scene.ids.screenRoot), {
      bridge: "http://unused", client: legacy,
    });
    eq(legacy.deliveries.length, 1, "старому приёмнику определения едут по-прежнему один раз");
    eq(legacyReport.definitionDelivery.unacknowledgedReceiver, true,
      "отсутствие подтверждений названо, а не выдано за подтверждение");
    eq(legacyReport.rootsImported, 2, "совместимость со старым приёмником сохранена");

    // -----------------------------------------------------------------------
    // Общий IR-реестр фиксируется только успешной сборкой
    // -----------------------------------------------------------------------
    var doc4 = PixDocument.load(PixContainer.open(file));
    var registry = MigrationIR.createRegistry();
    var rootRecord = doc4.tree.byKey.get(built.scene.ids.screenRoot);
    var firstIr = MigrationIR.build(doc4, { roots: [rootRecord], registry: registry });
    ok(firstIr.definitions.length > 0, "первая сборка приложила определения");
    var known = firstIr.definitions.map(function (d) { return d.definitionId; });
    var secondIr = MigrationIR.build(doc4, { roots: [rootRecord], registry: registry });
    eq(secondIr.definitions.length, 0, "известное определение второй раз не прикладывается");

    var removed = MigrationIR.forgetDefinitions(registry, known);
    eq(removed, known.length, "снятие с учёта вернуло число снятых определений");
    var thirdIr = MigrationIR.build(doc4, { roots: [rootRecord], registry: registry });
    eq(thirdIr.definitions.length, known.length,
      "снятое с учёта определение прикладывается снова — переотправка возможна");

    // Упавшая сборка не имеет права оставить в общем реестре определения,
    // которых никто не отправит.
    var freshRegistry = MigrationIR.createRegistry();
    var poisoned = Object.create(Object.getPrototypeOf(rootRecord));
    Object.assign(poisoned, rootRecord);
    Object.defineProperty(poisoned, "children", {
      get: function () { throw new Error("synthetic build failure"); },
    });
    assert.throws(function () {
      MigrationIR.build(doc4, { roots: [poisoned], registry: freshRegistry });
    }, /synthetic build failure/, "сборка действительно упала");
    checks += 1;
    eq(freshRegistry.definitions.size, 0,
      "упавшая сборка не оставила в общем реестре ни одного определения");

    console.log("OK: Direct PIX доставка определений — " + checks + " проверок пройдено");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch(function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
