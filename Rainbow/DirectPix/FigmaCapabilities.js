/**
 * Вердикты опытов живой Figma для модуля решений и теста соответствия.
 *
 * Код читает только `DirectPix/FigmaVerdicts.json` — пары «id опыта →
 * вердикт». Файл пишет команда `probe` вместе с подробной картой; подробная
 * карта нужна людям, коду из неё нужны ровно эти пары.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var VERDICTS_FILE = path.join(__dirname, "FigmaVerdicts.json");

/** Вердикты из сводки подробной md-карты: `{ id: verdict }`, без ERROR. */
function parseVerdicts(markdown) {
  var out = Object.create(null);
  String(markdown || "").replace(/^\| `([a-z0-9-]+)` \| .*? \| \*\*([A-Z_]+)\*\*/gm,
    function (_m, id, verdict) { if (verdict !== "ERROR") out[id] = verdict; return _m; });
  return out;
}

/**
 * Содержимое файла вердиктов по результату `probe`. ERROR — опыт не
 * выполнился, замера нет: в файл не попадает. Ключи отсортированы, чтобы
 * повторный прогон с теми же результатами давал тот же файл.
 */
function renderVerdicts(result) {
  var verdicts = {};
  (result && result.experiments || []).map(function (item) { return item; })
    .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
    .forEach(function (item) { if (item.verdict && item.verdict !== "ERROR") verdicts[item.id] = item.verdict; });
  return JSON.stringify({ probeVersion: result && result.probeVersion || null, verdicts: verdicts }, null, 1) + "\n";
}

function readVerdicts(file) {
  var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  var out = Object.create(null);
  Object.keys(parsed && parsed.verdicts || {}).forEach(function (id) { out[id] = parsed.verdicts[id]; });
  return out;
}

/** Вердикты сборки; без файла — пусто, и модуль решений идёт прежним путём. */
function loadDefault() {
  try { return readVerdicts(VERDICTS_FILE); }
  catch (_e) { return Object.create(null); }
}

module.exports = {
  VERDICTS_FILE: VERDICTS_FILE,
  parseVerdicts: parseVerdicts,
  renderVerdicts: renderVerdicts,
  readVerdicts: readVerdicts,
  loadDefault: loadDefault,
};
