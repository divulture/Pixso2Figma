/**
 * Редкий дефект не остаётся без доказательств:
 *   node FigmaImporter/Tests/SampleQuotaTest.js
 *
 * Регрессия расследования. На реальном прогоне отчёт показал 58 стёртых
 * обводок (`STROKES_NONEMPTY_TO_EMPTY`) — и НИ ОДНОГО образца по ним: общий
 * пул из 120 мест целиком забрали 2041 очищенная привязка стиля и 1633
 * очищенных текстовых стиля. Счётчик проблему называл, а найти её было нечем.
 *
 * Правило: место в выборке делится по кодам, а не по скорости прихода.
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

var admit = Main.directAdmitSample;
ok(typeof admit === "function", "общий помощник квоты экспортирован");

// ---------------------------------------------------------------------------
// 1. Частый код не вытесняет редкий — цифры взяты из реального прогона
// ---------------------------------------------------------------------------
var pool = { samples: [], limit: 120, perCodeLimit: 12 };
function flood(code, times) {
  var taken = 0;
  for (var i = 0; i < times; i++) {
    if (admit(pool, [code])) { pool.samples.push({ code: code }); taken += 1; }
  }
  return taken;
}
var fillStyle = flood("FILLSTYLEID_CLEARED", 2041);
var textStyle = flood("TEXTSTYLEID_CLEARED", 1633);
var strokes = flood("STROKES_NONEMPTY_TO_EMPTY", 58);

eq(fillStyle, 12, "частый код берёт ровно свою квоту");
eq(textStyle, 12, "второй частый — тоже");
ok(strokes > 0, "редкий код получил образцы, придя ПОСЛЕ потока частых");
eq(strokes, 12, "и получил полную квоту");
eq(pool.perCode.STROKES_NONEMPTY_TO_EMPTY, 12, "учёт по коду ведётся");
ok(pool.samples.length <= pool.limit, "общий потолок отчёта соблюдён");

// Старое поведение для сравнения: первые 120 забрали бы всё.
var oldStyle = { samples: [], limit: 120 };
var oldTaken = 0;
for (var o = 0; o < 2041; o++) {
  if (oldStyle.samples.length < oldStyle.limit) { oldStyle.samples.push(1); oldTaken += 1; }
}
eq(oldTaken, 120, "без квоты первый же частый код забирал весь пул");

// ---------------------------------------------------------------------------
// 2. Общий потолок всё равно ограничивает отчёт
// ---------------------------------------------------------------------------
var tiny = { samples: [], limit: 3, perCodeLimit: 10 };
var admitted = 0;
for (var t = 0; t < 50; t++) {
  if (admit(tiny, ["CODE_" + t])) { tiny.samples.push(1); admitted += 1; }
}
eq(admitted, 3, "потолок пула сильнее квоты: отчёт не растёт бесконечно");

// ---------------------------------------------------------------------------
// 3. Запись с несколькими причинами тратит квоту каждой
// ---------------------------------------------------------------------------
var multi = { samples: [], limit: 50, perCodeLimit: 2 };
ok(admit(multi, ["A", "B"]), "запись с двумя причинами принята");
multi.samples.push(1);
ok(admit(multi, ["A", "B"]), "вторая тоже");
multi.samples.push(1);
eq(admit(multi, ["A", "B"]), false, "третья отклонена: обе квоты исчерпаны");
ok(admit(multi, ["A", "C"]), "но свежая причина открывает запись заново");
eq(multi.perCode.A, 3, "исчерпанная причина всё равно считается");

// ---------------------------------------------------------------------------
// 4. Вырожденные входы не роняют сбор диагностики
// ---------------------------------------------------------------------------
eq(admit(null, ["X"]), false, "нет пула — нет образца");
eq(admit({ samples: [], limit: 5 }, []), false, "нет причин — нет образца");
eq(admit({ limit: 5 }, ["X"]), false, "пул без массива образцов безопасен");
var noQuota = { samples: [], limit: 100 };
ok(admit(noQuota, ["X"]), "квота по умолчанию выводится из потолка");
eq(noQuota.perCode.X, 1, "и учитывается");

// ---------------------------------------------------------------------------
// 5. Оба пула диагностики переведены на квоту, и бюджет виден в отчёте
// ---------------------------------------------------------------------------
var source = fs.readFileSync(path.join(__dirname, "..", "Main.js"), "utf8");
eq(source.indexOf("if (report.samples.length >= report.limit) return;"), -1,
  "деструктивные перезаписи больше не отбираются по скорости прихода");
eq(source.indexOf("var sampleLimit = session.debugOverrides ? 40 : 20;"), -1,
  "промахи оверрайдов — тоже");
ok(source.indexOf("directAdmitSample(report, reasons)") >= 0,
  "деструктивный пул использует общую квоту");
ok(source.indexOf("directAdmitSample(session.overrideMissPool, [code])") >= 0,
  "пул промахов оверрайдов использует ту же квоту");
ok(source.indexOf("directAdmitSample(report, [field])") >= 0,
  "визуальные расхождения — тоже: без этого не найти редкие поля обводки");
ok(source.indexOf("samplesByField: session.visualParity.perCode") >= 0,
  "и по ним бюджет виден в отчёте");
ok(source.indexOf("samplesByReason: session.destructiveOverwriteReport.perCode") >= 0,
  "в отчёте видно, как потрачен бюджет образцов");
ok(source.indexOf("samplesByReason: session.overrideMissPool.perCode") >= 0,
  "и по промахам оверрайдов тоже");

// ---------------------------------------------------------------------------
// 6. Сверка раскладки и текста: частое поле не вытесняет редкое
// ---------------------------------------------------------------------------
var paritySession = Main.newDirectSession("job-parity", null, {});
var frameSpec = { id: "1:1", kind: "NODE", type: "FRAME" };
var textSpec = { id: "1:2", kind: "NODE", type: "TEXT" };
for (var w = 0; w < 500; w++) {
  Main.directParityMismatch(paritySession, frameSpec, "final", "widthSizing", "HUG", "FIXED");
}
for (var m = 0; m < 5; m++) {
  Main.directParityMismatch(paritySession, textSpec, "final", "maxLines", 1, 2);
}
var parity = paritySession.layoutTextParity;
eq(parity.counts.widthSizing, 500, "частое поле посчитано целиком");
ok(parity.samples.some(function (sample) { return sample.field === "maxLines"; }),
  "редкое поле получило образец, придя после потока частого");
ok(parity.samples.length <= parity.limit, "потолок выборки соблюдён");
eq(parity.textSamples.length, 5, "текстовая выборка ведётся отдельно");
Main.directParityMismatch(paritySession, frameSpec, "final", "itemSpacing", 8, 8.0001);
eq(parity.counts.itemSpacing, undefined, "числа сравниваются с допуском");

// Один массив под двумя именами, а не две копии.
var session = Main.newDirectSession("job-1", null, {});
ok(session.overrideMissSamples === session.overrideMissPool.samples,
  "пул и отчёт смотрят в один массив");
eq(session.overrideMissPool.limit, 20, "обычный прогон — обычный потолок");
var debug = Main.newDirectSession("job-2", null, { debugOverrides: true });
eq(debug.overrideMissPool.limit, 40, "--debug-overrides расширяет выборку, как и раньше");

process.stdout.write("SampleQuotaTest: OK, проверок — " + checks + "\n");
