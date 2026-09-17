/**
 * Нормализация идентификаторов Pixso.
 *
 * Один и тот же guid встречается в разных представлениях, и сравнивать их
 * сырыми JSON-значениями нельзя. Документировано и наблюдается:
 *
 *   `{ sessionID, localID }`  бинарная схема Kiwi (`GUID` STRUCT) — ровно то,
 *                             что отдаёт декодер на всех проверенных `.pix`;
 *   `[ sessionID, localID ]`  JSON-представление PIX/FIG из спецификаций
 *                             («pixsoNodes[].guid[]», «"guid": [15,1]»);
 *   `"sessionID:localID"`     строковая форма («styleIdForFill":"1:18"`,
 *                             `ancestorPathBeforeDeletion … = 0:1`) и наш
 *                             собственный внутренний ключ;
 *   `{ guid: … }`             обёртка вокруг любой из форм выше.
 *
 * Внутреннее представление одно — строка `"sessionID:localID"`. Всё, что не
 * разложилось ни в одну из перечисленных форм, возвращает `null`: догадок
 * здесь нет, промах считается вызывающей стороной.
 *
 * Спекулятивных форматов тут нет: каждая форма подтверждена либо
 * приложенными спецификациями PIX/FIG, либо содержимым реального документа.
 */
"use strict";

/** `0:0` — объявленная, но не привязанная ссылка. Значения у неё нет. */
var EMPTY_KEY = "0:0";

function isIndex(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 && Math.floor(value) === value;
}

/**
 * Любая документированная форма guid → стабильная строка `"session:local"`.
 * Возвращает `null`, если значение не является guid ни в одной из них.
 */
function normalizeGuid(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    // Уже нормализованный ключ. Проверяем форму, а не доверяем на слово:
    // случайная строка не имеет права стать идентификатором.
    return /^\d+:\d+$/.test(value) ? value : null;
  }

  if (Array.isArray(value)) {
    if (value.length !== 2 || !isIndex(value[0]) || !isIndex(value[1])) return null;
    return value[0] + ":" + value[1];
  }

  if (typeof value !== "object") return null;

  if (isIndex(value.sessionID) && isIndex(value.localID)) {
    return value.sessionID + ":" + value.localID;
  }
  // Обёртка `{ guid: … }` встречается у ParentIndex и у записей пути.
  if (value.guid !== undefined) return normalizeGuid(value.guid);
  return null;
}

/** Нормализованный guid, у которого есть значение (не `0:0`). */
function meaningfulGuid(value) {
  var key = normalizeGuid(value);
  return key && key !== EMPTY_KEY ? key : null;
}

/**
 * Ссылка вхождения на исходный SYMBOL.
 *
 * Спецификация PIX называет поле `symbolData.symbolId`, спецификация FIG —
 * `symbolData.symbolID`. Бинарная схема всех проверенных `.pix` (Pixso 3.0.5)
 * содержит только `symbolID`, но обе формы документированы, поэтому читаются
 * обе: расхождение регистра между версиями формата не имеет права обнулить
 * компонентную семантику всего документа.
 */
function symbolReference(symbolData) {
  if (!symbolData) return null;
  return normalizeGuid(symbolData.symbolID !== undefined ? symbolData.symbolID : symbolData.symbolId);
}

/**
 * Явная подмена вложенного компонента: `overriddenSymbolID` самой записи либо
 * ссылка на символ внутри её `symbolData`. Обе формы регистра — по той же
 * причине, что и выше.
 */
function swapReference(source) {
  if (!source) return null;
  var explicit = source.overriddenSymbolID !== undefined ? source.overriddenSymbolID : source.overriddenSymbolId;
  var key = meaningfulGuid(explicit);
  if (key) return key;
  return meaningfulGuid(symbolReference(source.symbolData));
}

/** Цепочка guid-ов (`guidPath.guids[]`, `ancestorPathBeforeDeletion`). */
function normalizeGuidList(list) {
  if (!list || !list.length) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var key = normalizeGuid(list[i]);
    if (key === null) return null;
    out.push(key);
  }
  return out;
}

module.exports = {
  EMPTY_KEY: EMPTY_KEY,
  normalizeGuid: normalizeGuid,
  meaningfulGuid: meaningfulGuid,
  symbolReference: symbolReference,
  swapReference: swapReference,
  normalizeGuidList: normalizeGuidList,
};
