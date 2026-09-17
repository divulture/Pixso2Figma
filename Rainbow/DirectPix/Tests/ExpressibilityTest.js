/** Три решения выразимости опираются на фактическую probe-карту. */
"use strict";

var assert = require("assert");
var Expressibility = require("../Expressibility");
var Capabilities = require("../FigmaCapabilities");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }

var live = Capabilities.loadDefault();
var policy = Expressibility.createPolicy({ verdicts: live });

var fixedHug = policy.fixedHugAsFill();
eq(fixedHug.decision, "TRANSLATE", "измеренная Fixed+Fill-форма выбрана как перевод");
eq(fixedHug.translation, "FIXED_ROOT_FILL_CHILD", "имя формы явное");
eq(policy.fixedHugAsFill().evidence.length, 3, "у перевода три замера");

var missing = Expressibility.createPolicy({ verdicts: {} }).fixedHugAsFill();
eq(missing.decision, "TRANSLATE", "без карты сохранён прежний fixed-Hug перевод");
eq(missing.reason, "LEGACY_PATH_UNMEASURED", "пробел в замерах назван отдельно");
eq(missing.requiresProbe, true, "отчёт просит probe, не меняя путь");

var textEntry = { path: [{ index: 0 }], ops: { characters: "Header", textBoxWidth: 89 } };
var textDecisions = policy.classifyOverride(textEntry, { textAutoResize: "HEIGHT" });
eq(textDecisions.length, 2, "каждая operation получила своё решение");
eq(textDecisions[0].decision, "AS_IS", "сам текст переносится");
eq(textDecisions[1].decision, "FRAMES", "его фиксированная ширина не переносится");
eq(textDecisions[1].reason, "NESTED_TEXT_LAYOUT_OVERRIDE_UNREPRESENTABLE", "причина стабильна");

var spaceVerdicts = { "text-single-space-width": "IGNORED", "text-trailing-space-width": "IGNORED",
  "text-nbsp-width": "PERSISTED" };
var whitespace = Expressibility.createPolicy({ verdicts: spaceVerdicts })
  .classifyOverride({ path: [{ index: 0 }], ops: { characters: "  " } }, { textAutoResize: "WIDTH_AND_HEIGHT" })[0];
eq(whitespace.decision, "TRANSLATE", "конечные пробелы авто-ширины переводятся, раз замер это доказал");
eq(whitespace.translation, "TRAILING_SPACE_AS_NBSP", "форма перевода названа");
eq(whitespace.evidence.length, 3, "у перевода три замера");
var noNbsp = Expressibility.createPolicy({ verdicts: { "text-single-space-width": "IGNORED",
  "text-trailing-space-width": "IGNORED" } })
  .classifyOverride({ path: [{ index: 0 }], ops: { characters: " " } }, { textAutoResize: "WIDTH_AND_HEIGHT" })[0];
eq(noNbsp.decision, "AS_IS", "без замера неразрывного пробела путь прежний");
eq(Expressibility.trailingSpacesAsNbsp("a b  "), "a b\u00a0\u00a0", "переводятся только конечные пробелы");
eq(Expressibility.trailingSpacesAsNbsp("ab\n"), "ab\n", "перенос строки не трогается");
var fixedWidthSpace = Expressibility.createPolicy({ verdicts: spaceVerdicts })
  .classifyOverride({ path: [{ index: 0 }], ops: { characters: " " } }, { textAutoResize: "HEIGHT" })[0];
eq(fixedWidthSpace.translation, undefined, "текст фиксированной ширины не переводится");

// Операция, для которой опыта нет и не будет: проверка контракта «не измерено».
var unknown = policy.classifyOverride({ path: [{ index: 0 }], ops: { exportSettings: [] } }, {})[0];
eq(unknown.decision, "AS_IS", "generic nested override остался на прежнем replay-пути");
eq(unknown.reason, "LEGACY_PATH_UNMEASURED", "generic nested override не выдаётся за измеренный");
eq(unknown.requiresProbe, true, "generic nested override попадает в probe debt");

var headerBox = policy.sourceBox({ width: 89, height: 16, sizing: { width: "FIXED", height: "HUG" } },
  "TEXT", { x: 80, y: 16 });
eq(headerBox.decision, "AS_IS", "sourceBox — только аудит, он не включает фреймы");
eq(headerBox.reason, "SOURCE_BOX_DIAGNOSTIC_ONLY", "диагностическая природа sourceBox явна");

var nodes = [
  { id: "p", type: "FRAME", autoLayout: { layoutMode: "HORIZONTAL",
    primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" } },
  { id: "t", parent: "p", type: "TEXT", width: 120, height: 48,
    text: { textAutoResize: "HEIGHT", characters: "Header" },
    childLayout: { layoutGrow: 0, layoutAlign: "STRETCH" } },
];
var ledger = Expressibility.createLedger(10);
Expressibility.annotateTextHugFillCycles(nodes, policy, ledger);
eq(nodes[1].figmaTranslation.fixedAxes.height, true, "producer вынес FIXED-ось текста в IR");
eq(nodes[1].expressibility[0].decision, "TRANSLATE", "перевод описан рядом с узлом");
ledger.record("same", unknown, "x");
ledger.record("same", unknown, "x");
var report = ledger.report();
eq(report.unmeasured, 1, "одна неизмеренная правка не считается дважды");
eq(report.requiresProbe, 1, "probe debt выведен отдельно от FRAMES");
eq(report.totals.FRAMES, 0, "неизмеренная правка не включает FRAMES");
ok(report.table.every(function (row) { return row.decision && row.reason && row.class; }),
  "таблица не содержит строк «не проверено»");

// Low-level правки слоя инстанса сопоставлены с опытами probe v11.
function lowLevel(verdicts, path, ops) {
  return Expressibility.createPolicy({ verdicts: verdicts }).classifyOverride({ path: path, ops: ops }, {})[0];
}
var one = [{ index: 0 }], two = [{ index: 0 }, { index: 1 }];
var fillsOk = lowLevel({ "nested-fills": "PERSISTED" }, one, { fills: [] });
eq(fillsOk.decision, "AS_IS", "измеренная правка заливки переносится как есть");
eq(fillsOk.reason, "NESTED_OVERRIDE_SUPPORTED", "причина — замер, а не прежний путь");
eq(fillsOk.evidence[0].id, "nested-fills", "доказательство — опыт слоя инстанса");
eq(lowLevel({ "nested-fills": "PERSISTED" }, two, { fills: [] }).reason, "LEGACY_PATH_UNMEASURED",
  "второй уровень требует своего опыта deep-fills");
eq(lowLevel({ "deep-fills": "PERSISTED" }, two, { fills: [] }).evidence[0].id, "deep-fills",
  "второй уровень доказывается deep-опытом");
var fillsNo = lowLevel({ "nested-fills": "IGNORED" }, one, { fills: [] });
eq(fillsNo.decision, "AS_IS", "опровергнутая правка не меняет путь сама");
eq(fillsNo.reason, "LEGACY_PATH_MEASURED_UNSUPPORTED", "опровержение названо отдельно от «не измерено»");
ok(!fillsNo.requiresProbe, "опровергнутая правка не числится долгом по probe");
eq(lowLevel({ "nested-strokes": "PERSISTED" }, one, { strokeWeight: 2 }).reason, "NESTED_OVERRIDE_SUPPORTED",
  "толщина обводки доказывается опытом обводки");
eq(lowLevel({ "nested-swap-width": "PERSISTED" }, one, { swapDefinitionId: "1:2" }).reason,
  "LEGACY_PATH_UNMEASURED", "размер после подмены — не доказательство самой подмены");
eq(lowLevel({ "nested-swap": "PERSISTED" }, one, { swapDefinitionId: "1:2" }).reason,
  "NESTED_OVERRIDE_SUPPORTED", "подмена доказывается опытом swap");
eq(lowLevel({ "nested-frame-resize": "IGNORED" }, two, { size: { width: 1, height: 1 } }).reason,
  "LEGACY_PATH_MEASURED_UNSUPPORTED", "размер слоя инстанса измерен и не поддерживается на любом уровне");
eq(lowLevel({ "nested-clips-off": "PERSISTED" }, one, { clipsContent: false }).reason,
  "NESTED_OVERRIDE_SUPPORTED", "выключение обрезки доказывается clips-off");

console.log("OK: expressibility policy — " + checks + " проверок пройдено");
