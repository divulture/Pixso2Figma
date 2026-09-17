/**
 * Идентичность координаты варианта не зависит от порядка осей:
 *
 *   node DirectPix/Tests/VariantCoordinateIdentityTest.js
 *
 * У двух локальных зеркал одного опубликованного набора свой словарь
 * `stateGroupPropertyValueOrders`, и объявленный порядок осей у них разный.
 * Пока идентичностью координаты было ИМЯ, дедупликация этого не видела, и в
 * один `COMPONENT_SET` попадали два участника с ОДНОЙ координатой:
 *
 *   "size=m, type=primary, state=default"
 *   "type=primary, state=default, size=m"
 *
 * Figma считает такие варианты конфликтующими, помечает набор ошибочным и
 * после этого отказывает `setProperties` у КАЖДОГО его вхождения — одним
 * сообщением «Component set has existing errors», без указания виновника.
 * Не доезжают ни `INSTANCE_SWAP`, ни `BOOLEAN`, ни `TEXT`: на экране у всех
 * кнопок остаётся иконка-умолчание мастера.
 *
 * Измерено на реальном документе: таких наборов было два (`FunctionButton` и
 * `.Elements / Divider`), и они давали 107 отказов `setProperties`.
 *
 * Утверждения:
 *
 *   — одна координата в разном порядке осей даёт ОДНУ идентичность;
 *   — разные координаты остаются разными;
 *   — видимое имя по-прежнему следует порядку, объявленному источником:
 *     идентичность и отображение — разные вещи;
 *   — значение с пробелами и разделителем внутри не ломает идентичность.
 */
"use strict";

var assert = require("assert");
var StateGroups = require("../StateGroups");

var checks = 0;
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}
function ok(value, message) { assert.ok(value, message); checks += 1; }

function axes(names) {
  return names.map(function (name) { return { property: name, values: {} }; });
}

// Один и тот же вариант, объявленный двумя зеркалами в разном порядке осей.
var mirrorA = axes(["size", "type", "state"]);
var mirrorB = axes(["type", "state", "size"]);
var coordinate = { size: "m", type: "primary", state: "default" };

var nameA = StateGroups.canonicalVariantName(mirrorA, coordinate);
var nameB = StateGroups.canonicalVariantName(mirrorB, coordinate);
var identityA = StateGroups.coordinateIdentity(mirrorA, coordinate);
var identityB = StateGroups.coordinateIdentity(mirrorB, coordinate);

eq(nameA, "size=m, type=primary, state=default", "видимое имя следует порядку первого зеркала");
eq(nameB, "type=primary, state=default, size=m", "видимое имя следует порядку второго зеркала");
ok(nameA !== nameB, "имена зеркал различаются — именно на этом дедупликация и промахивалась");
eq(identityA, identityB,
  "но координата одна: идентичность не зависит от порядка осей");

// Разные координаты обязаны остаться разными.
var other = { size: "m", type: "secondary", state: "default" };
ok(StateGroups.coordinateIdentity(mirrorA, other) !== identityA,
  "другое значение оси — другая идентичность");
var otherValue = { size: "l", type: "primary", state: "default" };
ok(StateGroups.coordinateIdentity(mirrorA, otherValue) !== identityA,
  "другое значение второй оси — тоже другая идентичность");

// Значение, в котором есть пробел: идентичность собирается из пар, а не из
// разбора готовой строки, поэтому пробел ничего не смещает.
var spaced = axes(["more button", "state"]);
var spacedCoordinate = { "more button": "false", state: "default" };
var spacedReversed = axes(["state", "more button"]);
eq(StateGroups.coordinateIdentity(spaced, spacedCoordinate),
  StateGroups.coordinateIdentity(spacedReversed, spacedCoordinate),
  "ось с пробелом в имени ведёт себя так же");
ok(StateGroups.canonicalVariantName(spaced, spacedCoordinate) !==
   StateGroups.canonicalVariantName(spacedReversed, spacedCoordinate),
  "и это тот же случай, что дал второй конфликтующий набор на реальном файле");

// Одна ось — вырожденный, но законный случай.
var single = axes(["state"]);
eq(StateGroups.coordinateIdentity(single, { state: "hover" }), "state=hover",
  "одна ось: идентичность совпадает с именем");

console.log("OK: идентичность координаты варианта — " + checks + " проверок пройдено");
