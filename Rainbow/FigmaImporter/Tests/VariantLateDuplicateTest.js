/**
 * Поздний дубль варианта, записанный с другим порядком осей:
 *
 *   node FigmaImporter/Tests/VariantLateDuplicateTest.js
 *
 * Координата варианта не зависит от порядка осей, и отправитель шлёт её уже в
 * канонической (отсортированной) форме. Приёмник обязан сравнивать ЖИВОЙ узел
 * в той же форме: `variantProperties` отдаёт оси в порядке набора, имя — в
 * порядке источника. Если формы разойдутся, проверка «такой вариант уже есть»
 * всегда отвечает «нет», и дубль не отклоняется, а дописывается `appendChild`
 * в УЖЕ СОБРАННЫЙ набор.
 *
 * Это не косметика. Живая Figma на каждый append в существующий набор
 * переразрешает ВСЕ его вхождения. Измерено на реальном документе: рассогласование
 * форм дало 12 лишних поздних участников и +170 с ожидания хоста при
 * практически неизменной собственной работе плагина (+2%).
 *
 * Утверждения:
 *
 *   — поздний участник с той же координатой в ДРУГОМ порядке осей отклоняется
 *     как дубль, а не дописывается в набор;
 *   — набор остаётся прежнего состава и не получает конфликтующего варианта;
 *   — поздний участник с ДРУГОЙ координатой по-прежнему принимается: правило
 *     отклоняет дубли, а не поздние присоединения вообще.
 */
"use strict";

var assert = require("assert");
var path = require("path");
var FigmaHost = require("../../DirectPix/FigmaHost");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
var receiver = host.receiver;
var Main = host.main;

// Отправитель канонизирует координату сортировкой пар «ось=значение».
function identity(pairs) { return pairs.slice().sort().join(", "); }

function member(definitionId, groupId, visibleName, pairs, order) {
  return {
    definitionId: definitionId,
    componentKey: "key-" + definitionId,
    variantGroupId: groupId,
    variantSet: {
      groupId: groupId,
      groupName: "Mirrored",
      groupComponentKey: null,
      variantName: visibleName,
      coordinateKey: identity(pairs),
      coordinate: null,
      order: order,
      axisCount: pairs.length,
      memberCountSource: 3,
      memberCountDemanded: 3,
      sourceName: visibleName,
    },
    name: visibleName,
    nodes: [{
      id: definitionId, parent: null, kind: "ORDINARY", type: "COMPONENT",
      name: visibleName, x: 0, y: 0, width: 40, height: 20,
    }],
  };
}

var seq = 0;
function task(type, payload) {
  seq += 1;
  return receiver.handleDirectTask({
    jobId: "late-duplicate-job",
    taskId: "late-duplicate-job-" + seq,
    type: type,
    payload: Object.assign({ protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 }, payload),
  }, {});
}

(async function () {
  await task("DIRECT_PIX_START", { source: { fileName: "late.pix" } });

  // Первый чанк собирает набор.
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [
      member("9:1", "9:100", "type=primary, size=m", ["type=primary", "size=m"], 0),
      member("9:2", "9:100", "type=secondary, size=m", ["type=secondary", "size=m"], 1),
    ],
  });

  // Порядок осей НАБОРА здесь намеренно не совпадает с отсортированным
  // (`type`, затем `size`): именно в этом порядке живая Figma отдаёт
  // `variantProperties`. Если приёмник не приведёт его к той же форме, что
  // прислал отправитель, сравнение разойдётся.
  //
  // Второй чанк: та же координата, что у 9:1, но оси перечислены наоборот —
  // ровно так выглядит второе локальное зеркало одного набора.
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [member("9:3", "9:100", "size=m, type=primary", ["size=m", "type=primary"], 2)],
  });

  var finish = await task("DIRECT_PIX_FINISH", {});

  var sets = [];
  host.pages().forEach(function (page) {
    var stack = [page];
    while (stack.length) {
      var node = stack.pop();
      if (node.type === "COMPONENT_SET") sets.push(node);
      (node.children || []).forEach(function (child) { stack.push(child); });
    }
  });
  eq(sets.length, 1, "семейство собрано в один набор");

  var names = (sets[0].children || []).map(function (child) { return String(child.name); });
  eq(names.length, 2, "поздний дубль в набор не попал");
  var coordinates = names.map(function (name) {
    return name.split(",").map(function (part) { return part.trim(); }).sort().join(", ");
  });
  eq(new Set(coordinates).size, coordinates.length,
    "в наборе нет двух участников с одной координатой — иначе Figma объявит его ошибочным");

  var totals = finish.totals || {};
  ok((totals.variantMembersRejectedAsDuplicate || 0) >= 1,
    "поздний дубль отклонён именно как дубль, а не потерян молча");

  // Обратная сторона: поздний участник с ДРУГОЙ координатой обязан войти.
  await task("DIRECT_PIX_DEFINITIONS", {
    definitions: [member("9:4", "9:100", "size=m, type=tertiary", ["size=m", "type=tertiary"], 3)],
  });
  var second = await task("DIRECT_PIX_FINISH", {});
  var after = (sets[0].children || []).map(function (child) { return String(child.name); });
  ok(after.length >= 3, "поздний участник с новой координатой принят: правило про дубли, а не про опоздания");
  ok(second, "вторая фиксация job прошла");

  console.log("OK: поздний дубль варианта — " + checks + " проверок пройдено");
})().catch(function (error) {
  console.error("VariantLateDuplicateTest: FAIL");
  console.error(error && error.stack || error);
  process.exit(1);
});
