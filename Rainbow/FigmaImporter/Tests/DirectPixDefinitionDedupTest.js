/**
 * Direct PIX: дедупликация определений по доказательству.
 *
 *   node FigmaImporter/Tests/DirectPixDefinitionDedupTest.js
 *
 * Прогоняется НАСТОЯЩИЙ код приёмника на headless-двойнике хоста
 * (`DirectPix/FigmaHost.js`).
 *
 * Идентичность определения — guid символа в исходнике, поэтому копия одного
 * опубликованного компонента приезжает вторым definitionId. Проверяется, что
 * такие копии становятся ОДНИМ физическим компонентом, и — не менее важно —
 * что недоказанные пары им НЕ становятся:
 *
 *   — одна публикация и одна overrideKey-подпись при РАЗНЫХ componentKey
 *     схлопываются (ветка, которую раньше запирало требование непустой
 *     variant-координаты);
 *   — один componentKey и одна структура без публикации схлопываются
 *     запасной веткой;
 *   — одинаковый componentKey при РАЗНОЙ структуре не схлопывается;
 *   — участник семейства вариантов общим правилом не трогается и остаётся
 *     внутри своего COMPONENT_SET;
 *   — вхождения обеих копий указывают на один и тот же мастер;
 *   — отчёт FINISH называет число схлопнутых копий и ветку доказательства.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var MigrationIR = require("../../DirectPix/MigrationIR");
var FigmaHost = require("../../DirectPix/FigmaHost");

var RECEIVER_PATH = path.join(__dirname, "..", "Main.js");
var UNIT = String.fromCharCode(31);

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var host = FigmaHost.install(RECEIVER_PATH);
var receiver = host.receiver;
var sequence = 0;

function task(type, payload) {
  sequence += 1;
  return receiver.handleDirectTask({
    jobId: "dedup-job",
    taskId: "dedup-job-" + sequence,
    type: type,
    payload: Object.assign(
      { protocol: MigrationIR.PROTOCOL, directVersion: MigrationIR.PROTOCOL_VERSION },
      payload
    ),
  }, {});
}

function findAll(node, predicate, out) {
  out = out || [];
  if (!node) return out;
  if (predicate(node)) out.push(node);
  var children = node.children || [];
  for (var i = 0; i < children.length; i++) findAll(children[i], predicate, out);
  return out;
}
function documentNodes(predicate) {
  var out = [];
  host.pages().forEach(function (page) { findAll(page, predicate, out); });
  return out;
}
function instanceOf(sourceId) {
  var found = documentNodes(function (node) {
    return node.type === "INSTANCE" && typeof node.getPluginData === "function" &&
      node.getPluginData("pixsoDirectSourceId") === sourceId;
  });
  return found.length ? found[0] : null;
}

/**
 * Определение из двух узлов со стабильными overrideKey. Ключи у копий
 * ОДИНАКОВЫЕ, у разных компонентов — разные: подпись строится именно по ним,
 * а не по локальным id.
 */
function definition(id, options) {
  var nodes = [
    {
      id: id, parent: null, kind: "ORDINARY", type: "COMPONENT", name: options.name,
      x: 0, y: 0, width: 60, height: 24, sourceOverrideKey: options.keys[0],
    },
    {
      id: id + "-bg", parent: id, kind: "ORDINARY", type: "RECTANGLE", name: "bg",
      x: 0, y: 0, width: 60, height: 24, sourceOverrideKey: options.keys[1],
    },
  ];
  if (options.extraChild) {
    nodes.push({
      id: id + "-extra", parent: id, kind: "ORDINARY", type: "ELLIPSE", name: "extra",
      x: 0, y: 0, width: 8, height: 8, sourceOverrideKey: options.keys[2],
    });
  }
  var out = {
    definitionId: id,
    componentKey: options.componentKey,
    name: options.name,
    nodes: nodes,
  };
  if (options.publication) {
    out.publicationIdentity = options.publication;
    out.publishFile = "lib";
    out.publishID = options.publication.split("@")[1];
  }
  return out;
}

function variantMember(id, coordinate, order) {
  var out = definition(id, {
    name: coordinate, componentKey: "shared-key-with-standalone",
    publication: "lib@300:1", keys: ["vk-root", "vk-bg"],
  });
  out.variantGroupId = "grp:1";
  out.variantSet = {
    groupId: "grp:1", groupName: "Toggle", groupComponentKey: null,
    variantName: coordinate, coordinateKey: coordinate, coordinate: null,
    order: order, sortKey: [order], axisCount: 1,
    memberCountSource: 2, memberCountDemanded: 2,
    demandedCoordinates: ["state=default", "state=hover"],
    stableFamilyKey: "publish:lib@300:1|schema:state=default" + UNIT + "hover",
    publicationIdentity: "lib@300:1", publishFile: "lib", publishID: "300:1",
    sourceName: coordinate,
  };
  return out;
}

function occurrence(id, definitionId, x) {
  return {
    id: id, parent: "root:1", kind: "INSTANCE", type: "INSTANCE",
    name: "occ-" + id, definitionId: definitionId,
    x: x, y: 0, width: 60, height: 24,
  };
}

(async function () {
  await task("DIRECT_PIX_START", { source: { fileName: "dedup.pix" } });
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [
      // Одна публикация, одна overrideKey-подпись, РАЗНЫЕ componentKey.
      // Доказать такую пару может только ветка публикации: запасная требует
      // совпадения componentKey.
      definition("pub:a", { name: "Badge", componentKey: "local-a", publication: "lib@100:1", keys: ["pk-root", "pk-bg"] }),
      definition("pub:b", { name: "Badge", componentKey: "local-b", publication: "lib@100:1", keys: ["pk-root", "pk-bg"] }),
      // Публикации нет — остаётся componentKey плюс структурная подпись.
      definition("key:a", { name: "Chip", componentKey: "k-chip", keys: ["ck-root", "ck-bg"] }),
      definition("key:b", { name: "Chip", componentKey: "k-chip", keys: ["ck-root", "ck-bg"] }),
      // Тот же componentKey, но дерево другое: доказательства нет.
      definition("diff:a", { name: "Card", componentKey: "k-card", keys: ["dk-root", "dk-bg", "dk-extra"] }),
      definition("diff:b", { name: "Card", componentKey: "k-card", keys: ["dk-root", "dk-bg", "dk-extra"], extraChild: true }),
      // Участники семейства вариантов: их общее правило не касается.
      variantMember("var:default", "state=default", 0),
      variantMember("var:hover", "state=hover", 1),
      // Самостоятельное определение с тем же componentKey, что у участников.
      definition("solo:variantkey", {
        name: "Solo", componentKey: "shared-key-with-standalone",
        publication: "lib@300:1", keys: ["vk-root", "vk-bg"],
      }),
    ],
  });
  await task("DIRECT_PIX_PAGE", { pageId: "page:1", pageName: "Screen" });
  await task("DIRECT_PIX_ROOT", {
    pageId: "page:1", pageName: "Screen", rootId: "root:1", rootName: "Root",
    nodes: [
      { id: "root:1", parent: null, kind: "ORDINARY", type: "FRAME", name: "Root", x: 0, y: 0, width: 600, height: 200 },
      occurrence("occ:pub-a", "pub:a", 0),
      occurrence("occ:pub-b", "pub:b", 80),
      occurrence("occ:key-a", "key:a", 160),
      occurrence("occ:key-b", "key:b", 240),
      occurrence("occ:diff-a", "diff:a", 320),
      occurrence("occ:diff-b", "diff:b", 400),
    ],
  });
  var finish = await task("DIRECT_PIX_FINISH", {});

  // -------------------------------------------------------------------------
  // Копии схлопнуты
  // -------------------------------------------------------------------------
  var pubA = instanceOf("occ:pub-a"), pubB = instanceOf("occ:pub-b");
  ok(pubA && pubB, "оба вхождения копий одной публикации созданы");
  eq(pubA.type, "INSTANCE", "вхождение копии осталось нативным инстансом");
  eq(pubB.type, "INSTANCE", "вхождение второй копии осталось нативным инстансом");
  ok(pubA.__mainComponent === pubB.__mainComponent,
    "копии одной публикации с разными componentKey схлопнуты в один мастер");

  var keyA = instanceOf("occ:key-a"), keyB = instanceOf("occ:key-b");
  ok(keyA && keyB, "оба вхождения копий по componentKey созданы");
  ok(keyA.__mainComponent === keyB.__mainComponent,
    "копии с одним componentKey и одной структурой схлопнуты в один мастер");

  // -------------------------------------------------------------------------
  // Недоказанное НЕ схлопнуто
  // -------------------------------------------------------------------------
  var diffA = instanceOf("occ:diff-a"), diffB = instanceOf("occ:diff-b");
  ok(diffA && diffB, "оба вхождения расходящихся определений созданы");
  ok(diffA.__mainComponent !== diffB.__mainComponent,
    "одинаковый componentKey при разной структуре не схлопывается");

  // -------------------------------------------------------------------------
  // Семейство вариантов общим правилом не тронуто
  // -------------------------------------------------------------------------
  var sets = documentNodes(function (node) { return node.type === "COMPONENT_SET"; });
  eq(sets.length, 1, "семейство вариантов собрано в один COMPONENT_SET");
  eq(sets[0].children.filter(function (c) { return c.type === "COMPONENT"; }).length, 2,
    "оба участника остались внутри своего набора");
  var solo = documentNodes(function (node) {
    return node.type === "COMPONENT" && typeof node.getPluginData === "function" &&
      node.getPluginData("pixsoDirectDefinitionId") === "solo:variantkey";
  });
  eq(solo.length, 1, "самостоятельное определение с тем же componentKey осталось отдельным компонентом");
  ok(solo[0].parent.type !== "COMPONENT_SET",
    "общее правило не переселило самостоятельное определение в чужой набор");

  // -------------------------------------------------------------------------
  // Отчёт
  // -------------------------------------------------------------------------
  var report = finish.definitionDedupReport;
  ok(report, "FINISH отдаёт отчёт о дедупликации");
  eq(report.aliasedByProof, 2, "отчёт называет обе схлопнутые копии");
  var byFrom = Object.create(null);
  report.samples.forEach(function (sample) { byFrom[sample.from] = sample; });
  ok(byFrom["pub:b"], "в выборке есть копия, доказанная публикацией");
  eq(byFrom["pub:b"].to, "pub:a", "копия переиспользовала первую доехавшую");
  eq(byFrom["pub:b"].via, "PUBLICATION_OVERRIDE_KEY",
    "публикация и overrideKey-подпись доказывают копию без совпадения componentKey");
  ok(byFrom["key:b"], "в выборке есть копия, доказанная componentKey и структурой");
  eq(byFrom["key:b"].via, "COMPONENT_KEY_SHAPE",
    "без публикации доказательство идёт запасной веткой");
  eq(finish.totals.definitionsCreated, 7,
    "физических определений создано на две меньше, чем приехало");

  // -------------------------------------------------------------------------
  // D61: семантика корня принадлежит каждому definitionId, в том числе алиасу
  // -------------------------------------------------------------------------
  // Схлопнутая копия не строит свой компонент, но её root spec обязан попасть
  // в реестр. Без него вхождение алиаса считается FIXED: приёмник пишет ему
  // размер, живая Figma (и двойник) переводит HUG в FIXED, и длинная подпись
  // обрезается шириной мастера.
  function hugDefinition(id, name) {
    return {
      definitionId: id, componentKey: "published-hug-copy", name: name,
      nodes: [
        { id: id, parent: null, kind: "ORDINARY", type: "COMPONENT", name: name,
          x: 0, y: 0, width: 81, height: 28, sourceOverrideKey: "hk-root",
          autoLayout: { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" } },
        { id: id + "-label", parent: id, kind: "ORDINARY", type: "TEXT", name: "Label",
          x: 0, y: 0, width: 81, height: 20, sourceOverrideKey: "hk-label",
          text: { characters: "Short", fontName: { family: "Inter", style: "Regular" }, textAutoResize: "WIDTH_AND_HEIGHT" },
          childLayout: { layoutGrow: 0, layoutAlign: "INHERIT" } },
      ],
    };
  }
  await task("DIRECT_PIX_START", { source: { fileName: "dedup-hug-alias.pix" } });
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [hugDefinition("hug:a", "HUG copy A"), hugDefinition("hug:b", "HUG copy B")],
  });
  await task("DIRECT_PIX_PAGE", { pageId: "page:2", pageName: "Aliased HUG" });
  await task("DIRECT_PIX_ROOT", {
    pageId: "page:2", pageName: "Aliased HUG", rootId: "root:2", rootName: "Aliased HUG",
    nodes: [
      { id: "root:2", parent: null, kind: "ORDINARY", type: "FRAME", name: "Aliased HUG",
        x: 0, y: 0, width: 400, height: 100 },
      { id: "occ:hug-b", parent: "root:2", kind: "INSTANCE", type: "INSTANCE", name: "occ-hug-b",
        definitionId: "hug:b", x: 0, y: 0, width: 81, height: 28,
        overrides: [{
          path: [{ index: 0, sourceId: "hug:b-label", definitionId: "hug:b", definitionPath: [0], targetType: "TEXT" }],
          ops: { characters: "A label much longer than the master" }, present: { characters: true },
        }] },
    ],
  });
  var hugFinish = await task("DIRECT_PIX_FINISH", {});
  eq(hugFinish.totals.definitionsAliasedByProof, 1, "HUG-копия схлопнута в алиас");
  var hugOccurrence = instanceOf("occ:hug-b");
  ok(hugOccurrence, "вхождение алиаса построено инстансом");
  var hugStored = hugOccurrence.clone();
  eq(hugStored.primaryAxisSizingMode, "AUTO",
    "вхождение алиаса сохраняет HUG по главной оси, а не физическую ширину мастера");
  eq(hugStored.counterAxisSizingMode, "AUTO", "вторая HUG-ось алиаса тоже сохранена");
  ok(hugStored.width > 81, "длинная подпись расширила вхождение, а не обрезана шириной мастера");

  process.stdout.write("OK: Direct PIX дедупликация определений — " + checks + " проверок пройдено\n");
}()).catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  process.exit(1);
});
