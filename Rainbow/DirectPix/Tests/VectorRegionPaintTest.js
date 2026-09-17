/**
 * Многоцветный вектор Pixso: node DirectPix/Tests/VectorRegionPaintTest.js
 *
 * Иллюстрация в Pixso — часто ОДИН узел VECTOR, у которого своя заливка
 * задана каждому куску геометрии. Носитель этой связи в `.pix` —
 * `vectorPaints[].regionId`, и адресует он позицию пути в `fillGeometry`:
 * регионов в `VectorData.vectorNetworkBlob` ровно столько же, сколько путей.
 *
 * В Figma такого носителя у `vectorPaths` нет вовсе — цвет там принадлежит
 * региону векторной сети. Поэтому весь рисунок приезжал одной заливкой узла:
 * геометрия правильная, цвета сброшены в один.
 *
 * Фикстура синтетическая: production-код не знает её id, имён и геометрии.
 *
 * Утверждения:
 *
 *   — регион сети строится на КАЖДЫЙ путь `fillGeometry`, в том же порядке;
 *   — краска ложится ровно на тот регион, который назвал `regionId`;
 *   — регион без записи в таблице своей краски не получает: в Pixso он
 *     красится общей заливкой узла, и это правило сохраняется;
 *   — геометрия региона — та же, что у `vectorPaths`: форма не меняется;
 *   — замкнутый контур не удваивает стартовую вершину;
 *   — таблица с чужим `regionId` отклоняется ЦЕЛИКОМ и называет причину:
 *     проверить индекс региона больше нечем, а покрасить не тот кусок хуже,
 *     чем не покрасить ни одного;
 *   — вектор без таблицы остаётся ровно прежним результатом.
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

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function solid(r, g, b) {
  return { type: "SOLID", color: { r: r, g: g, b: b, a: 255 }, visible: true, blendMode: "NORMAL" };
}

var ids = {
  document: "7:1", library: "7:2", page: "7:3", root: "7:4",
  multi: "7:10", broken: "7:11", plain: "7:12",
};

// Три треугольника подряд: три независимых пути одного узла. Замыкание у всех
// трёх явное (`Z`), у последнего конечная точка ещё и повторяет стартовую —
// так пишет настоящий Pixso, и дублировать её в сети нельзя.
var triangleA = Fixture.pathBlob([[1, 0, 0], [2, 10, 0], [2, 10, 10], [0]]);
var triangleB = Fixture.pathBlob([[1, 20, 0], [2, 30, 0], [2, 30, 10], [0]]);
var curvedC = Fixture.pathBlob([
  [1, 40, 0], [4, 45, 0, 50, 5, 50, 10], [2, 40, 10], [2, 40, 0], [0],
]);

var GREY = solid(128, 128, 128);
var BLUE = solid(0, 0, 255);
var RED = solid(255, 0, 0);

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", internalOnly: true, parentIndex: parent(ids.document, "a") },
  { guid: guid(ids.page), type: "CANVAS", name: "Page", parentIndex: parent(ids.document, "b") },
  {
    guid: guid(ids.root), type: "FRAME", name: "Root",
    parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 200, y: 100 },
  },
  {
    guid: guid(ids.multi), type: "VECTOR", name: "Illustration",
    parentIndex: parent(ids.root, "a"), transform: matrix(4, 6), size: { x: 50, y: 10 },
    fillPaints: [GREY],
    fillGeometry: [
      { blobIndex: 0, windingRule: "NONZERO" },
      { blobIndex: 1, windingRule: "NONZERO" },
      { blobIndex: 2, windingRule: "ODD" },
    ],
    // Записи намеренно не по порядку и не на все регионы: адресует их
    // `regionId`, а не позиция в таблице.
    vectorPaints: [
      { regionId: 2, paints: [RED] },
      { regionId: 0, paints: [BLUE] },
    ],
  },
  {
    guid: guid(ids.broken), type: "VECTOR", name: "Broken table",
    parentIndex: parent(ids.root, "b"), transform: matrix(0, 40), size: { x: 10, y: 10 },
    fillPaints: [GREY],
    fillGeometry: [{ blobIndex: 0, windingRule: "NONZERO" }],
    vectorPaints: [{ regionId: 5, paints: [RED] }],
  },
  {
    guid: guid(ids.plain), type: "VECTOR", name: "Plain",
    parentIndex: parent(ids.root, "c"), transform: matrix(0, 60), size: { x: 10, y: 10 },
    fillPaints: [GREY],
    fillGeometry: [{ blobIndex: 0, windingRule: "NONZERO" }],
  },
];

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-vector-regions-"));
try {
  var file = path.join(temp, "regions.pix");
  fs.writeFileSync(file, Fixture.buildContainer({
    build: { nodes: nodes, blobs: [triangleA, triangleB, curvedC], resources: [] },
  }).zip);
  var doc = PixDocument.load(PixContainer.open(file));
  var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)], visualSafety: false });
  var built = ir.roots[0].nodes;
  function specOf(id) {
    return built.filter(function (node) { return node.id === id; })[0];
  }

  // --- многоцветный вектор --------------------------------------------------
  var multi = specOf(ids.multi);
  ok(multi, "многоцветный вектор построен");
  eq(multi.vectorPaths.length, 3, "все три пути источника перенесены");
  ok(multi.vectorNetwork, "у вектора с таблицей красок появилась сеть регионов");
  eq(multi.vectorNetwork.regions.length, multi.vectorPaths.length,
    "регион строится на КАЖДЫЙ путь: иначе regionId адресует не тот кусок");

  var regions = multi.vectorNetwork.regions;
  eq(JSON.stringify(regions[0].fills), JSON.stringify([
    { type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 1, blendMode: "NORMAL" },
  ]), "регион 0 получил свою краску");
  eq(JSON.stringify(regions[2].fills), JSON.stringify([
    { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1, blendMode: "NORMAL" },
  ]), "регион 2 получил свою краску, а не краску соседа");
  ok(!hasOwn(regions[1], "fills"),
    "регион без записи остаётся на общей заливке узла, а не красится пустотой");
  eq(JSON.stringify(multi.fills), JSON.stringify([
    { type: "SOLID", color: { r: 0.50196, g: 0.50196, b: 0.50196 }, opacity: 1, blendMode: "NORMAL" },
  ]), "общая заливка узла остаётся на месте: она и красит регионы без записи");

  eq(regions[0].windingRule, "NONZERO", "правило заполнения берётся у своего пути");
  eq(regions[2].windingRule, "EVENODD", "ODD источника — это EVENODD Figma");

  // --- геометрия сети совпадает с путями ------------------------------------
  var network = multi.vectorNetwork;
  function loopPoints(loop) {
    return loop.map(function (index) {
      var vertex = network.vertices[network.segments[index].start];
      return vertex.x + "," + vertex.y;
    }).join(" ");
  }
  eq(regions[0].loops.length, 1, "треугольник — один контур");
  eq(regions[0].loops[0].length, 3,
    "замкнутый треугольник — три сегмента: замыкающий не удваивается сверх контура");
  eq(loopPoints(regions[0].loops[0]), "0,0 10,0 10,10", "вершины первого пути на месте");
  eq(loopPoints(regions[1].loops[0]), "20,0 30,0 30,10", "второй путь не смешался с первым");

  var curved = regions[2];
  eq(curved.loops[0].length, 3,
    "путь, конечная точка которого повторяет стартовую, замкнут без лишнего сегмента");
  eq(loopPoints(curved.loops[0]), "40,0 50,10 40,10",
    "совпавшая конечная точка свелась к стартовой вершине, а не осталась её дублем");
  eq(network.segments[curved.loops[0][2]].end, network.segments[curved.loops[0][0]].start,
    "последний сегмент контура приходит в ту же вершину, с которой контур начат");
  var curveSegment = network.segments[curved.loops[0][0]];
  eq(curveSegment.tangentStart.x, 5, "касательная кривой отсчитана от начальной вершины");
  eq(curveSegment.tangentEnd.x, 0, "касательная кривой отсчитана от конечной вершины");
  eq(curveSegment.tangentEnd.y, -5, "вторая контрольная точка перенесена, а не потеряна");

  var verticesUsed = {};
  network.segments.forEach(function (segment) {
    verticesUsed[segment.start] = true;
    verticesUsed[segment.end] = true;
  });
  eq(Object.keys(verticesUsed).length, network.vertices.length,
    "висячих вершин в сети не осталось");

  // --- испорченная таблица --------------------------------------------------
  var broken = specOf(ids.broken);
  ok(broken.vectorPaths, "геометрия испорченного узла переносится как прежде");
  ok(!broken.vectorNetwork,
    "чужой regionId отклоняет таблицу целиком: красить наугад нельзя");
  ok(ir.unsupported.VECTOR_PAINT_TABLE >= 1,
    "отклонённая таблица названа вслух, а не потеряна молча");

  // --- вектор без таблицы ---------------------------------------------------
  var plain = specOf(ids.plain);
  ok(plain.vectorPaths, "обычный вектор переносится геометрией");
  ok(!plain.vectorNetwork, "вектору без таблицы красок сеть не выдумывается");

  eq(ir.stats.vectorRegionPaintsApplied, 1, "перекрашенный вектор посчитан");
  eq(ir.stats.vectorRegionsPainted, 2, "посчитаны именно окрашенные регионы, а не все");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("OK: многоцветный вектор Pixso — " + checks + " проверок пройдено");
