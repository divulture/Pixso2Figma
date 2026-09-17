/**
 * Плагин не морозит Figma: node FigmaImporter/Tests/MainThreadYieldTest.js
 *
 * Замеры реального прогона (790 с): 502 с в задачах корня, 259 с в сборке
 * определений. При этом во всём пути Direct PIX было ровно ДВЕ точки уступки
 * потока, обе в одной функции, — а `directBuildDefinitions` (66 с на один
 * chunk) и применение оверрайдов не уступали поток ни разу. Отсюда и
 * «подвисает»: Figma не перерисовывается минутами, а UI плагина не успевает
 * даже отправить heartbeat.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Main = require(path.join(__dirname, "..", "Main.js"));

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

var source = fs.readFileSync(path.join(__dirname, "..", "Main.js"), "utf8");

// ---------------------------------------------------------------------------
// 1. Бюджет общий на всю задачу, а не на отдельный цикл
// ---------------------------------------------------------------------------
var session = Main.newDirectSession("job-1", null, {});
ok(session.slice && typeof session.slice.startedAt === "number",
  "у сессии есть общий бюджет непрерывной работы");

// ---------------------------------------------------------------------------
// 2. yieldIfNeeded действительно возвращает управление хосту
// ---------------------------------------------------------------------------
(async function () {
  var fresh = Main.createSlice();
  var before = fresh.startedAt;
  await Main.yieldIfNeeded(fresh);
  eq(fresh.startedAt, before, "внутри бюджета поток не уступается");

  // Бюджет исчерпан: уступка обязана произойти.
  var spent = Main.createSlice();
  spent.startedAt = Date.now() - 5000;

  // Доказательство уступки: таймер, поставленный ДО вызова, успевает сработать.
  var timerFired = false;
  setTimeout(function () { timerFired = true; }, 0);
  eq(timerFired, false, "таймер ещё не срабатывал");
  await Main.yieldIfNeeded(spent);
  eq(timerFired, true, "хост получил такт: отложенный таймер сработал");
  ok(spent.startedAt > Date.now() - 1000, "бюджет отсчитывается заново");

  // Учёт для отчёта ведётся, когда его просят.
  var report = { yieldCount: 0, sliceTotalMs: 0, maxSliceMs: 0 };
  var counted = Main.createSlice(report);
  counted.startedAt = Date.now() - 900;
  await Main.yieldIfNeeded(counted);
  eq(report.yieldCount, 1, "уступка посчитана");
  ok(report.maxSliceMs >= 900, "длина самого долгого куска записана");

  // -------------------------------------------------------------------------
  // 3. Тяжёлые циклы Direct PIX уступают поток
  // -------------------------------------------------------------------------
  /**
   * Уступка ищется внутри тела цикла. Окно задаётся явно: в сборке узлов
   * тело цикла длинное, и уступка стоит в его конце — это нормально.
   */
  function loopYields(functionName, loopHead, window, what) {
    var start = source.indexOf(functionName);
    ok(start > 0, "функция " + functionName + " найдена");
    var loopAt = source.indexOf(loopHead, start);
    ok(loopAt > start, "цикл найден в " + functionName);
    ok(source.slice(loopAt, loopAt + window).indexOf("yieldIfNeeded") >= 0, what);
  }

  loopYields("async function directBuildDefinitions",
    "for (var i = 0; i < phaseDefinitions.length; i++)", 900,
    "сборка определений уступает поток (в замерах — до 66 с на chunk)");

  loopYields("async function directApplyOverrides",
    "for (var p = 0; p < plan.length; p++)", 900,
    "применение оверрайдов уступает поток (десятки тысяч операций на документ)");

  loopYields("async function directBuildNodes",
    "for (var i = 0; i < nodes.length; i++)", 9000,
    "сборка узлов корня уступает поток");

  // -------------------------------------------------------------------------
  // 4. Бюджет именно общий: собственных отсчётов в пути Direct PIX не осталось
  // -------------------------------------------------------------------------
  eq(source.indexOf("Date.now() - slice.startedAt > PROMOTE_SLICE_MS"), -1,
    "локальные копии проверки бюджета заменены общим yieldIfNeeded");
  // Утверждение здесь — «бюджет заводит САМА сессия», то есть поле `slice`
  // её литерала. Аргументы `createSlice` в него не входят намеренно: отчёт об
  // уступках и величина бюджета — отдельные величины, и их появление ничего не
  // говорит о том, общий бюджет или нет. Подстрока остаётся такой же точной:
  // `slice: createSlice(` встречается в приёмнике ровно один раз и ровно в
  // литерале direct-сессии (у legacy-сессии форма другая — `slice = createSlice(`).
  ok(source.indexOf("slice: createSlice(") >= 0, "сессия заводит общий бюджет");
  ok(source.indexOf("var slice = session.slice || createSlice();") >= 0,
    "сборка узлов берёт бюджет сессии, а не заводит свой");
  ok(source.indexOf("directSession.slice.startedAt = Date.now()") >= 0,
    "на входе в задачу бюджет обнуляется: простой между задачами не тратит его");

  process.stdout.write("MainThreadYieldTest: OK, проверок — " + checks + "\n");
})().catch(function (error) {
  process.stderr.write("MainThreadYieldTest: FAIL\n" + (error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
