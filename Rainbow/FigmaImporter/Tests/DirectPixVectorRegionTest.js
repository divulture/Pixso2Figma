/**
 * Direct PIX: многоцветный вектор на стороне приёмника Figma.
 *
 *   node FigmaImporter/Tests/DirectPixVectorRegionTest.js
 *
 * Тест гоняет НАСТОЯЩИЙ код приёмника на headless-двойнике хоста
 * (`DirectPix/FigmaHost.js`). Двойник моделирует ровно то свойство Figma,
 * ради которого и задан порядок применения: заливка САМОГО узла VectorNode
 * красит весь вектор и стирает собственные краски регионов. Хост, который бы
 * этого не делал, пропустил бы «цвета уехали и были затёрты» — то есть
 * исходный дефект, от которого страхует этот файл.
 *
 * Утверждения:
 *
 *   — сеть с красками регионов доезжает до узла целиком;
 *   — заливка узла применяется РАНЬШЕ сети и не стирает краски регионов;
 *   — регион без своей краски остаётся на общей заливке узла;
 *   — размещение узла переживает запись сети: сеть пересобирает геометрию;
 *   — отказ хоста оставляет прежний одноцветный результат с геометрией, а не
 *     разрушенный узел, и называет причину.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var FigmaHost = require("../../DirectPix/FigmaHost");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
var receiver = host.receiver;

var DIRECT = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };
var taskSequence = 0;

function task(jobId, type, payload) {
  taskSequence += 1;
  return receiver.handleDirectTask({
    jobId: jobId,
    taskId: jobId + "-" + type + "-" + taskSequence,
    type: "DIRECT_PIX_" + type,
    payload: Object.assign({}, DIRECT, payload || {}),
  }, { createPages: true });
}

function solid(r, g, b) {
  return { type: "SOLID", color: { r: r, g: g, b: b }, opacity: 1, blendMode: "NORMAL" };
}

var GREY = solid(0.5, 0.5, 0.5);
var BLUE = solid(0, 0, 1);
var RED = solid(1, 0, 0);

function findNode(root, sourceId) {
  var stack = [root];
  while (stack.length) {
    var current = stack.pop();
    if (current.getPluginData && current.getPluginData("pixsoDirectSourceId") === sourceId) return current;
    var children = current.children || [];
    for (var i = 0; i < children.length; i++) stack.push(children[i]);
  }
  return null;
}

function pageByName(name) {
  var pages = host.pages();
  for (var i = 0; i < pages.length; i++) if (pages[i].name === name) return pages[i];
  return null;
}

// Три независимых контура одного вектора — так приезжает иллюстрация,
// собранная в Pixso одним куском.
function triangle(offset) {
  return {
    windingRule: "NONZERO",
    data: "M " + offset + " 0 L " + (offset + 10) + " 0 L " + (offset + 10) + " 10 Z",
  };
}

var VERTICES = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
  { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 },
  { x: 40, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 },
];
function segment(start, end) {
  return { start: start, end: end, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } };
}
var SEGMENTS = [
  segment(0, 1), segment(1, 2), segment(2, 0),
  segment(3, 4), segment(4, 5), segment(5, 3),
  segment(6, 7), segment(7, 8), segment(8, 6),
];
function network(regionFills) {
  return {
    vertices: VERTICES,
    segments: SEGMENTS,
    regions: [0, 1, 2].map(function (index) {
      var region = { windingRule: "NONZERO", loops: [[index * 3, index * 3 + 1, index * 3 + 2]] };
      if (hasOwn(regionFills, index)) region.fills = regionFills[index];
      return region;
    }),
  };
}

async function run() {
  var job = "job-vector-regions";
  await task(job, "START", { source: { fileName: "regions.pix" } });
  await task(job, "PAGE", { pageId: "p1", pageName: "Экран" });

  await task(job, "ROOT", {
    pageId: "p1", pageName: "Экран", rootId: "9:100", rootName: "Экран",
    nodes: [
      { id: "9:100", parent: null, kind: "ORDINARY", type: "FRAME", name: "Экран",
        x: 0, y: 0, width: 200, height: 100 },
      { id: "9:101", parent: "9:100", kind: "ORDINARY", type: "VECTOR", name: "Иллюстрация",
        x: 7, y: 11, width: 50, height: 10,
        fills: [GREY],
        vectorPaths: [triangle(0), triangle(20), triangle(40)],
        vectorNetwork: network({ 0: [BLUE], 2: [RED] }) },
      // Тот же вектор без таблицы красок: прежний путь обязан остаться прежним.
      { id: "9:102", parent: "9:100", kind: "ORDINARY", type: "VECTOR", name: "Одноцветная",
        x: 0, y: 40, width: 50, height: 10,
        fills: [GREY], vectorPaths: [triangle(0)] },
    ],
  });

  var page = pageByName("Экран");
  var multi = findNode(page, "9:101");
  ok(multi, "многоцветный вектор построен");
  ok(multi.vectorNetwork, "сеть регионов доехала до узла");
  eq(multi.vectorNetwork.regions.length, 3, "все три региона на месте");
  eq(JSON.stringify(multi.vectorNetwork.regions[0].fills), JSON.stringify([BLUE]),
    "краска первого региона пережила заливку узла: сеть пишется ПОСЛЕ неё");
  eq(JSON.stringify(multi.vectorNetwork.regions[2].fills), JSON.stringify([RED]),
    "краска третьего региона на месте и не перепутана с первым");
  ok(!hasOwn(multi.vectorNetwork.regions[1], "fills"),
    "регион без своей краски остаётся на общей заливке узла");
  eq(JSON.stringify(multi.fills), JSON.stringify([GREY]),
    "общая заливка узла сохранена: ею и красится регион без своей краски");
  eq(multi.vectorNetwork.segments.length, 9, "сегменты сети перенесены целиком");

  eq(multi.x, 7, "запись сети не сдвинула узел по x");
  eq(multi.y, 11, "запись сети не сдвинула узел по y");

  var plain = findNode(page, "9:102");
  ok(plain.vectorPaths, "вектор без таблицы красок строится прежним путём");
  ok(!plain.vectorNetwork, "и сети ему никто не выдумывает");

  // --- отказ хоста ----------------------------------------------------------
  // Узел, который сеть не принимает, обязан остаться рабочим: геометрия из
  // `vectorPaths` и одна заливка — это прежний результат, а не поломка.
  await task(job, "PAGE", { pageId: "p2", pageName: "Отказ" });
  var previousCreate = host.figma.createVector;
  host.figma.createVector = function () {
    var node = previousCreate();
    Object.defineProperty(node, "vectorNetwork", {
      configurable: true,
      get: function () { return null; },
      set: function () { throw new Error("host refuses vector networks"); },
    });
    node.setVectorNetworkAsync = function () { return Promise.reject(new Error("refused")); };
    return node;
  };
  var refused;
  try {
    refused = await task(job, "ROOT", {
      pageId: "p2", pageName: "Отказ", rootId: "9:200", rootName: "Отказ",
      nodes: [
        { id: "9:200", parent: null, kind: "ORDINARY", type: "FRAME", name: "Отказ",
          x: 0, y: 0, width: 200, height: 100 },
        { id: "9:201", parent: "9:200", kind: "ORDINARY", type: "VECTOR", name: "Иллюстрация",
          x: 0, y: 0, width: 50, height: 10,
          fills: [GREY],
          vectorPaths: [triangle(0), triangle(20), triangle(40)],
          vectorNetwork: network({ 0: [BLUE], 2: [RED] }) },
      ],
    });
  } finally {
    host.figma.createVector = previousCreate;
  }

  var refusedNode = findNode(pageByName("Отказ"), "9:201");
  ok(refusedNode, "узел построен несмотря на отказ хоста");
  eq(refusedNode.vectorPaths.length, 3, "геометрия осталась прежней и полной");
  eq(JSON.stringify(refusedNode.fills), JSON.stringify([GREY]),
    "заливка узла осталась: отказ сети не оставляет вектор без краски вовсе");
  var finished = await task(job, "FINISH", {});
  ok(JSON.stringify(finished).indexOf("VECTOR_REGIONS_REJECTED") >= 0,
    "отказ назван причиной в отчёте, а не потерян молча");
  ok(refused.ordinaryNodesCreated >= 1, "отказ сети не сорвал сборку узлов корня");

  console.log("OK: Direct PIX многоцветный вектор — " + checks + " проверок пройдено");
}

run().catch(function (error) {
  console.error("DirectPixVectorRegionTest: FAIL");
  console.error(error);
  process.exit(1);
});
