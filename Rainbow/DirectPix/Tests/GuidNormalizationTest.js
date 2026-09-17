/**
 * Нормализация идентификаторов Pixso.
 *
 * Проверяется ровно то, что перечислено в PixGuid: формы из приложенных
 * спецификаций PIX/FIG плюс форма, которую отдаёт бинарная схема. Всё
 * остальное обязано давать null, а не «похожий» идентификатор — молчаливое
 * превращение мусора в guid стоило бы дороже честного промаха.
 */
"use strict";

var assert = require("assert");
var PixGuid = require("../PixGuid");

var checks = 0;
function eq(actual, expected, message) {
  checks += 1;
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
}
function deepEq(actual, expected, message) {
  checks += 1;
  assert.deepStrictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
}

function run() {
  // --- Документированные формы ------------------------------------------
  eq(PixGuid.normalizeGuid({ sessionID: 2, localID: 4 }), "2:4",
    "объектная форма бинарной схемы");
  eq(PixGuid.normalizeGuid([15, 1]), "15:1",
    "массив: «pixsoNodes[].guid[]» спецификации PIX, «\"guid\": [15,1]» спецификации FIG");
  eq(PixGuid.normalizeGuid("1:18"), "1:18",
    "строка: форма стиля («styleIdForFill\":\"1:18\") и наш внутренний ключ");
  eq(PixGuid.normalizeGuid({ guid: { sessionID: 0, localID: 1 } }), "0:1",
    "обёртка {guid: …}");
  eq(PixGuid.normalizeGuid([0, 0]), "0:0",
    "«0:0» — валидная форма; смысл «нет значения» проверяется отдельно");

  // Идемпотентность: нормализованный ключ можно нормализовать повторно.
  eq(PixGuid.normalizeGuid(PixGuid.normalizeGuid({ sessionID: 7, localID: 9 })), "7:9",
    "нормализация идемпотентна");

  // --- Отказы вместо догадок --------------------------------------------
  eq(PixGuid.normalizeGuid(null), null, "null не идентификатор");
  eq(PixGuid.normalizeGuid(undefined), null, "undefined не идентификатор");
  eq(PixGuid.normalizeGuid("Button"), null, "имя слоя идентификатором не становится");
  eq(PixGuid.normalizeGuid("1:2:3"), null, "лишний сегмент — это не guid");
  eq(PixGuid.normalizeGuid([1]), null, "массив из одного числа — не guid");
  eq(PixGuid.normalizeGuid([1, 2, 3]), null, "массив из трёх чисел — не guid");
  eq(PixGuid.normalizeGuid([1, "2"]), null, "строка внутри массива не приводится молча");
  eq(PixGuid.normalizeGuid({ sessionID: 1 }), null, "половина пары — не guid");
  eq(PixGuid.normalizeGuid({ sessionID: 1.5, localID: 2 }), null, "дробный индекс — не guid");
  eq(PixGuid.normalizeGuid({ sessionID: -1, localID: 2 }), null, "отрицательный индекс — не guid");
  eq(PixGuid.normalizeGuid(42), null, "число — не guid");

  // --- Пустая ссылка -----------------------------------------------------
  eq(PixGuid.meaningfulGuid({ sessionID: 0, localID: 0 }), null,
    "0:0 — объявленная, но не привязанная ссылка");
  eq(PixGuid.meaningfulGuid({ sessionID: 0, localID: 2 }), "0:2",
    "0:<n> при n≠0 остаётся значением");

  // --- Ссылка вхождения на SYMBOL ---------------------------------------
  // Спецификация PIX называет поле symbolId, спецификация FIG — symbolID.
  // Бинарная схема проверенных .pix содержит symbolID; читаться обязаны обе.
  eq(PixGuid.symbolReference({ symbolID: { sessionID: 2, localID: 4 } }), "2:4",
    "форма спецификации FIG и бинарной схемы");
  eq(PixGuid.symbolReference({ symbolId: { sessionID: 2, localID: 4 } }), "2:4",
    "форма спецификации PIX");
  eq(PixGuid.symbolReference({ symbolId: [2, 4] }), "2:4",
    "имя из PIX плюс массивная форма guid из неё же");
  eq(PixGuid.symbolReference(null), null, "нет symbolData — нет ссылки");
  eq(PixGuid.symbolReference({}), null, "пустой symbolData — нет ссылки");

  // --- Подмена вложенного компонента ------------------------------------
  eq(PixGuid.swapReference({ overriddenSymbolID: { sessionID: 5, localID: 6 } }), "5:6",
    "явная подмена");
  eq(PixGuid.swapReference({ symbolData: { symbolID: { sessionID: 7, localID: 8 } } }), "7:8",
    "подмена через symbolData записи override");
  eq(PixGuid.swapReference({
    overriddenSymbolID: { sessionID: 0, localID: 0 },
    symbolData: { symbolID: { sessionID: 7, localID: 8 } },
  }), "7:8", "пустая явная ссылка уступает место symbolData, а не побеждает");
  eq(PixGuid.swapReference({ overriddenSymbolID: { sessionID: 0, localID: 0 } }), null,
    "единственная ссылка равна 0:0 — подмены нет");
  eq(PixGuid.swapReference({ name: "Icon" }), null,
    "имя слоя подменой не является");

  // --- Цепочки ----------------------------------------------------------
  deepEq(PixGuid.normalizeGuidList([{ sessionID: 0, localID: 1 }, [2, 3], "4:5"]),
    ["0:1", "2:3", "4:5"], "смешанные формы в одной цепочке");
  deepEq(PixGuid.normalizeGuidList([]), [], "пустая цепочка — это пустой путь, а не отказ");
  eq(PixGuid.normalizeGuidList([{ sessionID: 0, localID: 1 }, "мусор"]), null,
    "цепочка с нечитаемым звеном целиком считается нечитаемой");

  process.stdout.write("OK: нормализация guid Pixso — " + checks + " проверок пройдено\n");
}

run();
