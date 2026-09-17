/**
 * Лаборатория живой Figma: отправка DIRECT_PIX_PROBE и карта возможностей.
 *
 * Опыты выполняет Receiver в настоящей Figma (`runFigmaProbe` в
 * `FigmaImporter/Main.js`). Здесь — только транспорт через тот же bridge и
 * превращение ответа в md-таблицу, на которую опираются тестовый двойник и
 * решения DirectPix.
 */
"use strict";

var MigrationIR = require("./MigrationIR");
var FigmaCapabilities = require("./FigmaCapabilities");

var PROBE_TASK = "DIRECT_PIX_PROBE";

var VERDICT_TEXT = {
  PERSISTED: "сохраняется",
  IGNORED: "игнорируется",
  LOST_ON_RECOMPUTE: "теряется при пересчёте",
  DEFERRED: "применяется с задержкой",
  MIXED: "непостоянно",
  ERROR: "ошибка API",
};

/**
 * Запускает опыты через bridge и возвращает ответ Receiver.
 * `client` — BridgeClient; `experiments` — необязательный список id.
 */
async function runProbe(client, options) {
  var opts = options || {};
  await client.ensureReceiver(opts.receiverId || null);
  await client.start({ fileName: "figma-probe", probe: true });
  if (typeof opts.onJob === "function") opts.onJob(client);
  try {
    var result = await client.sendTask(PROBE_TASK, {
      protocol: MigrationIR.PROTOCOL,
      directVersion: MigrationIR.PROTOCOL_VERSION,
      experiments: opts.experiments || null,
    });
    await client.finish("done");
    return result;
  } catch (error) {
    try { await client.finish("failed", error); } catch (_eFinish) {}
    throw error;
  }
}

function formatValues(values) {
  if (!values) return "—";
  return Object.keys(values).filter(function (key) {
    return values[key] !== null && values[key] !== undefined;
  }).map(function (key) { return key + "=" + values[key]; }).join(", ");
}

function formatExpect(item) {
  var parts = [];
  Object.keys(item.expect || {}).forEach(function (key) { parts.push(key + "=" + item.expect[key]); });
  Object.keys(item.expectRatio || {}).forEach(function (key) { parts.push(key + " > мастер × " + item.expectRatio[key]); });
  return parts.join(", ") || "—";
}

function cell(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Карта возможностей в markdown. */
function renderMarkdown(result, meta) {
  var info = meta || {};
  var lines = [];
  lines.push("# Карта возможностей живой Figma");
  lines.push("");
  lines.push("Сгенерировано командой `node DirectPix/Cli.js --probe-figma`.");
  lines.push("Не редактировать вручную: файл перезаписывается при каждом прогоне.");
  lines.push("");
  lines.push("- Дата прогона: " + (info.date || new Date().toISOString()));
  lines.push("- Документ Figma: " + (info.documentName || "—"));
  lines.push("- Receiver: " + (result.receiverVersion || "—") + ", probe v" + (result.probeVersion || "—") +
    ", editor " + (result.editorType || "—") + ", API " + (result.apiVersion || "—"));
  lines.push("- Время опытов: " + (result.elapsedMs || 0) + " мс");
  lines.push("");
  lines.push("Каждый опыт: свой компонент, одно действие над инстансом, четыре чтения —");
  lines.push("сразу (`immediate`), после паузы (`afterTick`), на копии инстанса (`clone`),");
  lines.push("после пересчёта инстанса мастером (`recompute`).");
  lines.push("");
  lines.push("| Вердикт | Значение |");
  lines.push("|---|---|");
  Object.keys(VERDICT_TEXT).forEach(function (key) {
    lines.push("| `" + key + "` | " + VERDICT_TEXT[key] + " |");
  });
  lines.push("");
  lines.push("## Сводка");
  lines.push("");
  lines.push("| Опыт | Действие | Вердикт |");
  lines.push("|---|---|---|");
  (result.experiments || []).forEach(function (item) {
    lines.push("| `" + item.id + "` | " + cell(item.question) + " | **" + item.verdict + "** — " +
      (VERDICT_TEXT[item.verdict] || "") + " |");
  });
  lines.push("");
  lines.push("## Замеры");
  (result.experiments || []).forEach(function (item) {
    lines.push("");
    lines.push("### `" + item.id + "` — " + item.verdict);
    lines.push("");
    lines.push(item.question);
    lines.push("");
    if (item.error) {
      lines.push("Ошибка: `" + cell(item.error) + "`");
      return;
    }
    lines.push("| Чтение | Значения |");
    lines.push("|---|---|");
    lines.push("| ожидалось | " + cell(formatExpect(item)) + " |");
    lines.push("| мастер | " + cell(formatValues(item.master)) + " |");
    lines.push("| до действия | " + cell(formatValues(item.before)) + " |");
    var reads = item.reads || {};
    ["immediate", "afterTick", "clone", "recompute"].forEach(function (key) {
      lines.push("| " + key + " | " + cell(formatValues(reads[key])) + " |");
    });
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Вердикты из сводки карты возможностей: `{ id: verdict }`. Карта — источник
 * истины о живой Figma; тест соответствия сверяет с ней двойник.
 */
function parseVerdicts(markdown) {
  return FigmaCapabilities.parseVerdicts(markdown);
}

/** Короткая таблица для терминала. */
function renderSummary(result) {
  var lines = [];
  (result.experiments || []).forEach(function (item) {
    var id = item.id + new Array(Math.max(1, 42 - item.id.length)).join(" ");
    lines.push("  " + id + item.verdict + (item.error ? "  (" + item.error + ")" : ""));
  });
  lines.push("");
  lines.push("  итого: " + JSON.stringify(result.verdicts || {}) + ", " + (result.elapsedMs || 0) + " мс");
  return lines.join("\n");
}

module.exports = {
  PROBE_TASK: PROBE_TASK,
  VERDICT_TEXT: VERDICT_TEXT,
  runProbe: runProbe,
  renderMarkdown: renderMarkdown,
  renderSummary: renderSummary,
  parseVerdicts: parseVerdicts,
};
