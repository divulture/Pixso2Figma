/**
 * Direct PIX: порядок на служебной странице.
 *
 *   node FigmaImporter/Tests/DirectPixShelfLayoutTest.js
 *
 * Прогоняется НАСТОЯЩИЙ код приёмника на headless-двойнике хоста
 * (`DirectPix/FigmaHost.js`).
 *
 * Проверяются утверждения, которые счётчиками не доказываются:
 *
 *   — участники набора не лежат друг на друге, а стоят сеткой с шагом 16;
 *   — коробка набора равна коробке его участников плюс поля, то есть набор
 *     не остаётся обрезанным по габариту, который был у него в момент
 *     объединения (а в этот момент участники ещё пустые);
 *   — семейство с одной осью становится столбцом, с двумя — сеткой;
 *   — верхний уровень страницы сгруппирован по семействам, соседи не
 *     перекрываются, и каждое семейство начинается с новой строки.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var MigrationIR = require("../../DirectPix/MigrationIR");
var FigmaHost = require("../../DirectPix/FigmaHost");

var RECEIVER_PATH = path.join(__dirname, "..", "Main.js");

var GAP = 16;
var PADDING = 16;
var SHELF_GAP = 80;

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
    jobId: "shelf-job",
    taskId: "shelf-job-" + sequence,
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

function servicePage() {
  var pages = host.pages().filter(function (page) {
    return page.getPluginData("pixso2figmaRole") === "direct-pix-components";
  });
  return pages.length ? pages[0] : null;
}

function setNamed(name) {
  var found = documentNodes(function (node) { return node.type === "COMPONENT_SET" && node.name === name; });
  return found.length ? found[0] : null;
}

function box(node) { return { x: node.x, y: node.y, w: node.width, h: node.height }; }

function overlaps(left, right) {
  return left.x < right.x + right.w && right.x < left.x + left.w &&
    left.y < right.y + right.h && right.y < left.y + left.h;
}

/** Участник семейства: определение с явным дескриптором и собственным габаритом. */
function member(definitionId, groupId, groupName, variantName, size, order) {
  return {
    definitionId: definitionId,
    componentKey: "shelf-" + definitionId,
    variantGroupId: groupId,
    variantSet: {
      groupId: groupId,
      groupName: groupName,
      groupComponentKey: null,
      variantName: variantName,
      coordinate: null,
      order: order,
      axisCount: variantName.split(",").length,
      memberCountSource: 0,
      memberCountDemanded: 0,
      sourceName: variantName,
      sortKey: [order],
    },
    name: variantName,
    nodes: [{
      id: definitionId, parent: null, kind: "ORDINARY", type: "COMPONENT",
      name: variantName, x: 0, y: 0, width: size.w, height: size.h,
    }],
  };
}

/** Самостоятельное определение: семейства нет, на полку оно идёт в одиночку. */
function standalone(definitionId, name, size) {
  return {
    definitionId: definitionId,
    componentKey: "shelf-" + definitionId,
    name: name,
    nodes: [{
      id: definitionId, parent: null, kind: "ORDINARY", type: "COMPONENT",
      name: name, x: 0, y: 0, width: size.w, height: size.h,
    }],
  };
}

(async function () {
  await task("DIRECT_PIX_START", { source: { fileName: "shelf.pix" } });
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [
      // Две оси и РАЗНЫЕ габариты участников: сетка обязана считать ширину
      // столбца и высоту строки по самому крупному в них, а не по первому.
      member("1:1", "1:100", "Button", "Size=S, State=Default", { w: 80, h: 32 }, 0),
      member("1:2", "1:100", "Button", "Size=S, State=Hover", { w: 80, h: 32 }, 1),
      member("1:3", "1:100", "Button", "Size=M, State=Default", { w: 140, h: 48 }, 2),
      member("1:4", "1:100", "Button", "Size=M, State=Hover", { w: 140, h: 48 }, 3),
      // Одна ось: столбец.
      member("2:1", "2:100", "Icon", "icon=alpha", { w: 24, h: 24 }, 0),
      member("2:2", "2:100", "Icon", "icon=beta", { w: 24, h: 24 }, 1),
      member("2:3", "2:100", "Icon", "icon=gamma", { w: 24, h: 24 }, 2),
      // Самостоятельные определения того же семейства по имени.
      standalone("3:1", "Card / Wide", { w: 300, h: 200 }),
      standalone("3:2", "Card / Narrow", { w: 160, h: 200 }),
      standalone("4:1", "Avatar", { w: 48, h: 48 }),
    ],
  });
  var finish = await task("DIRECT_PIX_FINISH", {});

  // -------------------------------------------------------------------------
  // Набор с двумя осями
  // -------------------------------------------------------------------------
  var buttons = setNamed("Button");
  ok(buttons, "семейство с двумя осями собралось в COMPONENT_SET");
  eq(buttons.children.length, 4, "в наборе все четыре участника");

  var placed = buttons.children.map(box);
  for (var a = 0; a < placed.length; a++) {
    for (var b = a + 1; b < placed.length; b++) {
      ok(!overlaps(placed[a], placed[b]),
        "участники набора не перекрываются: " + buttons.children[a].name + " и " + buttons.children[b].name);
    }
  }

  var xs = placed.map(function (item) { return item.x; }).filter(function (value, index, all) {
    return all.indexOf(value) === index;
  }).sort(function (l, r) { return l - r; });
  var ys = placed.map(function (item) { return item.y; }).filter(function (value, index, all) {
    return all.indexOf(value) === index;
  }).sort(function (l, r) { return l - r; });
  eq(xs.length, 2, "две оси дали два столбца");
  eq(ys.length, 2, "две оси дали две строки");
  eq(xs[0], PADDING, "первый столбец отступает от края набора на поле");
  eq(ys[0], PADDING, "первая строка отступает от края набора на поле");
  eq(xs[1] - xs[0], 140 + GAP, "шаг столбца — самый широкий участник плюс 16");
  eq(ys[1] - ys[0], 32 + GAP, "шаг строки — самый высокий участник строки плюс 16");

  var right = Math.max.apply(null, placed.map(function (item) { return item.x + item.w; }));
  var bottom = Math.max.apply(null, placed.map(function (item) { return item.y + item.h; }));
  eq(buttons.width, right + PADDING, "ширина набора равна ширине участников плюс поле");
  eq(buttons.height, bottom + PADDING, "высота набора равна высоте участников плюс поле");
  ok(buttons.width > 140 && buttons.height > 48,
    "набор не остался обрезанным по габариту, который был у него при объединении");

  // -------------------------------------------------------------------------
  // Набор с одной осью
  // -------------------------------------------------------------------------
  var icons = setNamed("Icon");
  ok(icons, "семейство с одной осью собралось в COMPONENT_SET");
  eq(icons.children.length, 3, "в наборе все три участника");
  var iconBoxes = icons.children.map(box);
  iconBoxes.forEach(function (item) { eq(item.x, PADDING, "одна ось — один столбец"); });
  var sortedY = iconBoxes.map(function (item) { return item.y; }).sort(function (l, r) { return l - r; });
  eq(sortedY[0], PADDING, "первый участник отступает от края набора на поле");
  eq(sortedY[1] - sortedY[0], 24 + GAP, "шаг по вертикали — высота участника плюс 16");
  eq(sortedY[2] - sortedY[1], 24 + GAP, "шаг по вертикали одинаков для всех участников");
  eq(icons.height, sortedY[2] + 24 + PADDING, "высота набора равна высоте столбца плюс поле");

  // -------------------------------------------------------------------------
  // Верхний уровень служебной страницы
  // -------------------------------------------------------------------------
  var page = servicePage();
  ok(page, "служебная страница Direct PIX существует");
  var top = page.children.filter(function (node) {
    return node.type === "COMPONENT" || node.type === "COMPONENT_SET";
  });
  eq(top.length, 5, "на верхнем уровне два набора и три самостоятельных определения");

  var topBoxes = top.map(box);
  for (var i = 0; i < topBoxes.length; i++) {
    for (var j = i + 1; j < topBoxes.length; j++) {
      ok(!overlaps(topBoxes[i], topBoxes[j]),
        "соседи на полке не перекрываются: " + top[i].name + " и " + top[j].name);
    }
  }

  var byName = Object.create(null);
  top.forEach(function (node) { byName[node.name] = node; });
  eq(byName["Card / Narrow"].y, byName["Card / Wide"].y,
    "определения одного семейства стоят в одной строке");
  eq(byName["Card / Narrow"].x, 0, "первое определение семейства начинает строку");
  eq(byName["Card / Wide"].x, 160 + SHELF_GAP, "соседи в строке разделены шагом полки");
  ok(byName["Avatar"].y !== byName["Card / Wide"].y,
    "другое семейство начинается с новой строки");
  ok(byName["Button"].y !== byName["Icon"].y,
    "наборы разных семейств не стоят в одной строке");

  eq(finish.servicePageLayout.items, 5, "отчёт называет число разложенных узлов верхнего уровня");
  eq(finish.servicePageLayout.sets, 2, "отчёт называет число разложенных наборов");
  eq(finish.servicePageLayout.families, 4, "отчёт называет число семейств на полке");

  process.stdout.write("OK: Direct PIX порядок на служебной странице — " + checks + " проверок пройдено\n");
}()).catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  process.exit(1);
});
