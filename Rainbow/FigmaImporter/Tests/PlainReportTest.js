/**
 * Отчёт не имеет права уронить миграцию: node FigmaImporter/Tests/PlainReportTest.js
 *
 * Регрессия. Весь документ (290 корней, 17496 слоёв) переносился успешно, а
 * последняя задача `DIRECT_PIX_FINISH` падала с
 * «in postMessage: Cannot unwrap symbol»: в итоговый отчёт попадал живой узел
 * Figma, а его structured clone не переживает. Migration объявлялась неудачной
 * из-за отчёта о самой себе.
 */
"use strict";

var assert = require("assert");
var path = require("path");
var Main = require(path.join(__dirname, "..", "Main.js"));

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

var plain = Main.directPlainValue;
ok(typeof plain === "function", "санитайзер экспортирован");

/** Прокси живого узла Figma: свой прототип и бросающие геттеры. */
function fakeFigmaNode(type, id) {
  function SceneNode() {}
  var node = new SceneNode();
  Object.defineProperty(node, "type", { get: function () { return type; }, enumerable: true });
  Object.defineProperty(node, "id", { get: function () { return id; }, enumerable: true });
  Object.defineProperty(node, "parent", { get: function () { throw new Error("Cannot unwrap symbol"); } });
  // У настоящего узла есть методы — именно они (как и прокси движка) не
  // переживают structured clone.
  node.resize = function () {};
  return node;
}

// ---------------------------------------------------------------------------
// 1. Обычный отчёт проходит без изменений
// ---------------------------------------------------------------------------
var report = {
  ok: true,
  totals: { ordinaryNodesCreated: 117, instancesCreated: 4 },
  samples: [{ name: "Кнопка", ms: 12.5 }, { name: "Бейдж", ms: 0 }],
  nothing: null,
};
var clean = plain(report);
assert.deepStrictEqual(clean.value, report, "простые данные не изменились");
checks += 1;
eq(clean.stripped.length, 0, "вырезать было нечего");

// ---------------------------------------------------------------------------
// 2. Живой узел Figma заменяется меткой, а не роняет отчёт
// ---------------------------------------------------------------------------
var withNode = {
  ok: true,
  totals: { instancesCreated: 4 },
  variantSetReport: { verification: [{ groupId: "g1", setNode: fakeFigmaNode("COMPONENT_SET", "12:34") }] },
};
var sanitized = plain(withNode);
eq(sanitized.value.ok, true, "остальной отчёт уцелел");
eq(sanitized.value.totals.instancesCreated, 4, "счётчики уцелели");
eq(sanitized.value.variantSetReport.verification[0].groupId, "g1", "соседние поля уцелели");
ok(String(sanitized.value.variantSetReport.verification[0].setNode).indexOf("не сериализуется") >= 0,
  "узел заменён меткой");
eq(sanitized.stripped.length, 1, "вырезано ровно одно поле");
ok(sanitized.stripped[0].indexOf("variantSetReport.verification[0].setNode") >= 0,
  "путь до виновного поля назван (получено: " + sanitized.stripped[0] + ")");
ok(sanitized.stripped[0].indexOf("COMPONENT_SET") >= 0, "и его тип тоже");

// Главное утверждение: результат переживает structured clone.
if (typeof structuredClone === "function") {
  structuredClone(sanitized.value);
  checks += 1;
  assert.throws(function () { structuredClone(withNode); }, "исходный отчёт клонирование не переживал");
  checks += 1;
}
JSON.stringify(sanitized.value);
checks += 1;

// ---------------------------------------------------------------------------
// 3. Функции, symbol, циклы и бросающие геттеры
// ---------------------------------------------------------------------------
var nasty = { fn: function () {}, sym: Symbol("x"), big: BigInt(7), deep: {} };
nasty.deep.back = nasty;
Object.defineProperty(nasty, "explosive", {
  get: function () { throw new Error("геттер бросил"); }, enumerable: true,
});
var tamed = plain(nasty);
JSON.stringify(tamed.value);
checks += 1;
ok(String(tamed.value.fn).indexOf("функция") >= 0, "функция помечена");
ok(String(tamed.value.sym).indexOf("symbol") >= 0, "symbol помечен");
ok(String(tamed.value.big).indexOf("bigint") >= 0, "bigint помечен");
ok(String(tamed.value.deep.back).indexOf("циклическая") >= 0, "цикл не зациклил обход");
ok(String(tamed.value.explosive).indexOf("чтение бросило") >= 0, "бросающий геттер не уронил отчёт");

// ---------------------------------------------------------------------------
// 4. Точка выхода плагина действительно защищена
// ---------------------------------------------------------------------------
var source = require("fs").readFileSync(path.join(__dirname, "..", "Main.js"), "utf8");
var postIndex = source.indexOf('type: "receiver-task-done"');
ok(postIndex > 0, "точка выхода найдена");
var before = source.slice(Math.max(0, postIndex - 700), postIndex);
ok(before.indexOf("directPlainValue(result)") >= 0,
  "результат задачи санируется ПЕРЕД отправкой в UI");
ok(before.indexOf("unserializableFields") >= 0,
  "вырезанные поля названы в самом отчёте — следующий прогон укажет виновника");

process.stdout.write("PlainReportTest: OK, проверок — " + checks + "\n");
