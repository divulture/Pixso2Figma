/**
 * Direct PIX CLI — экспериментальный путь миграции прямо из файла `.pix`.
 *
 *   node DirectPix/Cli.js <файл.pix> --analyze
 *   node DirectPix/Cli.js <файл.pix> --list-pages
 *   node DirectPix/Cli.js <файл.pix> --list-roots [--page "Имя"]
 *   node DirectPix/Cli.js <файл.pix> --root <id> --dry-run
 *   node DirectPix/Cli.js <файл.pix> --root <id> --migrate [--bridge http://localhost:8787]
 *   node DirectPix/Cli.js <файл.pix> --migrate-file [--bridge http://localhost:8787]
 *
 * Pixso при этом открывать не нужно: документ читается из файла.
 * Существующие пути миграции (Export JSON, Import JSON, Fast, Full) этот
 * инструмент не затрагивает и ничего в них не меняет.
 */
"use strict";

var fs = require("fs");
var crypto = require("crypto");

var PixContainer = require("./PixContainer");
var PixDocument = require("./PixDocument");
var Analyzer = require("./Analyzer");
var MigrationIR = require("./MigrationIR");
var BridgeClient = require("./BridgeClient");
var Trace = require("./Trace");
var FigmaProbe = require("./FigmaProbe");
var FigmaCapabilities = require("./FigmaCapabilities");
var ScreenCheck = require("./ScreenCheck");
var path = require("path");

var USAGE = [
  "Direct PIX (экспериментально)",
  "",
  "  node DirectPix/Cli.js <файл.pix> --analyze            статистика документа",
  "  node DirectPix/Cli.js <файл.pix> --list-pages         страницы документа",
  "  node DirectPix/Cli.js <файл.pix> --list-roots         корни страниц с id",
  "  node DirectPix/Cli.js <файл.pix> --root <id> --dry-run   собрать IR без отправки",
  "  node DirectPix/Cli.js <файл.pix> --root <id> --trace     сверка PIX → IR → Figma",
  "  node DirectPix/Cli.js <файл.pix> --root <id> --migrate   отправить через bridge",
  "  node DirectPix/Cli.js <файл.pix> --migrate-file         перенести все пользовательские страницы",
  "  node DirectPix/Cli.js --probe-figma                     опыты в живой Figma → FIGMA_CAPABILITIES.md",
  "  node DirectPix/Cli.js --check-screens <набор.json>      сверка эталонных экранов в живой Figma",
  "  node DirectPix/Cli.js --check-screens <набор.json> --headless   та же сверка на двойнике",
  "  node DirectPix/Cli.js --compare-checks <было.json> <стало.json>  что изменилось между прогонами",
  "",
  "Опции:",
  "  --page <имя|id>     ограничить список/выбор одной страницей",
  "  --bridge <url>      адрес bridge (по умолчанию http://localhost:8787)",
  "  --receiver-id <id>  переносить только в этот Receiver (--migrate/--migrate-file/--probe-figma)",
  "  --probe-report <файл>  куда записать карту возможностей (по умолчанию FIGMA_CAPABILITIES.md)",
  "  --probe-verdicts <файл>  куда записать вердикты для кода (по умолчанию DirectPix/FigmaVerdicts.json)",
  "  --probe-only <id,…>  выполнить только перечисленные опыты",
  "  --json              машиночитаемый вывод",
  "  --out <файл>        сохранить отчёт/IR в файл",
  "  --sample <N>        шаг выборки инстансов в --analyze (по умолчанию 1)",
  "  --debug-overrides   добавить ограниченную выборку промахов resolver в отчёт",
  "  --trace-text-overrides  bounded raw → IR → Figma trace только TEXT overrides",
  "  --text-override-trace-limit <N>  лимит trace-образцов (по умолчанию 20)",
  "  --trace             диагностика визуальной точности на headless-приёмнике",
  "  --size-trace <guid,…>  след размера по стадиям для перечисленных узлов",
  "  --no-variant-sets   диагностика: не собирать нативные COMPONENT_SET",
  "  --verify-tree <файл>  диагностика: снимок построенного дерева из Figma в файл",
].join("\n");

function parseArgs(argv) {
  var options = {
    file: null, analyze: false, listPages: false, listRoots: false,
    dryRun: false, migrate: false, migrateFile: false, roots: [], page: null,
    probeFigma: false, probeReport: null, probeVerdicts: null, probeOnly: [],
    bridge: "http://localhost:8787", receiverId: null, json: false, out: null, sample: 1,
    debugOverrides: false, trace: false, traceTextOverrides: false,
    textOverrideTraceLimit: 20, sizeTraceIds: [],
    nativeVariantSets: true, verifyTree: null, verifyDefinitionIds: [],
    checkScreens: null, headless: false, compareChecks: null,
  };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === "--analyze") options.analyze = true;
    else if (arg === "--list-pages") options.listPages = true;
    else if (arg === "--list-roots") options.listRoots = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--migrate") options.migrate = true;
    else if (arg === "--migrate-file") options.migrateFile = true;
    else if (arg === "--probe-figma") options.probeFigma = true;
    else if (arg === "--probe-report" && argv[i + 1]) options.probeReport = String(argv[++i]);
    else if (arg === "--probe-verdicts" && argv[i + 1]) options.probeVerdicts = String(argv[++i]);
    else if (arg === "--probe-only" && argv[i + 1]) {
      String(argv[++i]).split(",").forEach(function (id) {
        var trimmed = id.trim();
        if (trimmed) options.probeOnly.push(trimmed);
      });
    }
    else if (arg === "--debug-overrides") options.debugOverrides = true;
    else if (arg === "--trace-text-overrides") options.traceTextOverrides = true;
    else if (arg === "--text-override-trace-limit" && argv[i + 1]) {
      options.textOverrideTraceLimit = Math.max(1, Number(argv[++i]) || 20);
    }
    else if (arg === "--trace") options.trace = true;
    else if (arg === "--size-trace" && argv[i + 1]) {
      String(argv[++i]).split(",").forEach(function (id) {
        var trimmed = id.trim();
        if (trimmed) options.sizeTraceIds.push(trimmed);
      });
    }
    else if (arg === "--no-variant-sets") options.nativeVariantSets = false;
    else if (arg === "--verify-tree" && argv[i + 1]) options.verifyTree = String(argv[++i]);
    else if (arg === "--check-screens" && argv[i + 1]) options.checkScreens = String(argv[++i]);
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--compare-checks" && argv[i + 1] && argv[i + 2]) {
      options.compareChecks = [String(argv[++i]), String(argv[++i])];
    }
    else if (arg === "--verify-definition" && argv[i + 1]) {
      String(argv[++i]).split(",").forEach(function (id) {
        var trimmed = id.trim();
        if (trimmed) options.verifyDefinitionIds.push(trimmed);
      });
    }
    else if (arg === "--json") options.json = true;
    else if (arg === "--root" && argv[i + 1]) options.roots.push(String(argv[++i]));
    else if (arg === "--page" && argv[i + 1]) options.page = String(argv[++i]);
    else if (arg === "--bridge" && argv[i + 1]) options.bridge = String(argv[++i]);
    else if (arg === "--receiver-id" && argv[i + 1]) options.receiverId = String(argv[++i]);
    else if (arg === "--out" && argv[i + 1]) options.out = String(argv[++i]);
    else if (arg === "--sample" && argv[i + 1]) options.sample = Number(argv[++i]) || 1;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.indexOf("--") === 0) throw new Error("Неизвестная опция " + arg);
    else if (!options.file) options.file = arg;
    else throw new Error("Лишний аргумент: " + arg);
  }
  return options;
}

function pad(value, width) {
  var text = String(value);
  return text.length >= width ? text : text + new Array(width - text.length + 1).join(" ");
}

function printAnalysis(report) {
  var out = [];
  out.push("Файл:        " + report.file.name + "  (" + Math.round(report.file.bytes / 1024) + " КиБ)");
  out.push("Pixso:       " + report.file.appVersion + ", kiwi " + report.file.kiwiVersion +
    ", payload " + report.file.compression + ", запись " + report.file.messageType);
  out.push("");
  out.push("Узлы");
  report.nodesByType.forEach(function (entry) {
    out.push("  " + pad(entry.key, 22) + entry.count);
  });
  if (report.unsupportedNodeTypes.length) {
    out.push("  ── типы, которые Direct PIX не строит:");
    report.unsupportedNodeTypes.forEach(function (entry) {
      out.push("     " + pad(entry.key, 22) + entry.count);
    });
  }
  out.push("");
  var t = report.totals;
  out.push("Компоненты");
  out.push("  SYMBOL всего              " + t.symbols + " (в state group: " + t.symbolsInStateGroups + ")");
  out.push("  групп состояний           " + t.stateGroups);
  out.push("  INSTANCE всего            " + t.instances + " (нерезолвящихся: " + t.unresolvedInstances + ")");
  out.push("  используемых SYMBOL       " + t.usedSymbols);
  out.push("  componentKey всего        " + t.componentFamilies + ", среди используемых: " + t.usedComponentFamilies);
  out.push("  componentKey у >1 SYMBOL  " + report.sharedComponentKeyCount +
    "  ← схлопывание по ключу потеряло бы состояния");
  out.push("");
  out.push("Overrides");
  out.push("  записей symbolOverride    " + t.overrideRecords +
    " (инстансов просмотрено: " + t.instancesScannedForOverrides + ")");
  out.push("  в среднем на инстанс      " +
    (t.instancesScannedForOverrides ? (t.overrideRecords / t.instancesScannedForOverrides).toFixed(2) : "0"));
  out.push("  пустой guidPath           " + t.overridePathsEmpty + " ← адресует сам корень инстанса");
  out.push("  глубина пути              " + report.overridePathDepth.map(function (e) { return e.key + ":" + e.count; }).join("  "));
  out.push("");
  out.push("Ресурсы");
  out.push("  изображений в контейнере  " + t.imageResources + ", из них используются: " + t.imageResourcesReferenced);
  out.push("  изображений не найдено    " + t.imageResourcesMissing);
  out.push("  blob-ов геометрии         " + t.vectorGeometryBlobs + ", не разбираются: " + t.vectorGeometryUndecodable);
  out.push("  blob-ов всего             " + t.blobs);
  out.push("");
  out.push("Топ компонентов по числу вхождений");
  report.topSymbolsByUsage.forEach(function (entry) {
    out.push("  " + pad(entry.instances, 6) + pad(entry.symbolId, 12) + entry.name);
  });
  out.push("");
  out.push("Поля override, которые первая версия не применяет");
  report.unsupportedOverrideFields.slice(0, 15).forEach(function (entry) {
    out.push("  " + pad(entry.field, 34) + entry.count);
  });
  out.push("");
  out.push("Страницы");
  report.pages.forEach(function (page) {
    out.push("  " + pad(page.id, 12) + pad(page.roots + " корн.", 12) + page.name);
  });
  out.push("");
  out.push("Тайминги парсера (мс): " + JSON.stringify(report.timings));
  return out.join("\n");
}

function printRoots(listing) {
  var out = [];
  listing.forEach(function (page) {
    out.push("Страница «" + page.pageName + "» (" + page.pageId + ")");
    if (!page.roots.length) out.push("  — пусто");
    page.roots.forEach(function (root) {
      out.push("  " + pad(root.id, 12) + pad(root.type, 12) + pad(root.nodes + " узл.", 12) +
        pad((root.width || "?") + "×" + (root.height || "?"), 14) + root.name);
    });
  });
  return out.join("\n");
}

function summarizeIR(ir) {
  return {
    protocol: ir.protocol,
    version: ir.version,
    roots: ir.roots.map(function (root) {
      return { rootId: root.rootId, rootName: root.rootName, pageId: root.pageId, pageName: root.pageName, nodes: root.nodes.length };
    }),
    definitions: ir.definitions.length,
    definitionNodes: ir.stats.definitionNodes,
    styles: ir.styles.length,
    styleReport: ir.styleReport,
    assets: ir.assets.length,
    stats: ir.stats,
    expressibilityReport: ir.expressibilityReport,
    unsupported: ir.unsupported,
    unsupportedSamples: ir.unsupportedSamples,
    componentPropertyReport: ir.componentPropertyReport,
    stateGroupReport: ir.stateGroupReport,
    overrideResolution: ir.overrideResolution,
    overrideResolutionSamples: ir.overrideResolutionSamples,
    deepOverrideProvenanceSamples: ir.deepOverrideProvenanceSamples,
    sourceSemanticReport: ir.sourceSemanticReport,
    canonicalResolution: ir.canonicalResolution,
    canonicalResolutionSamples: ir.canonicalResolutionSamples,
    irBuildMs: ir.timings.irBuildMs,
  };
}

/**
 * Отчёт по группам состояний.
 *
 * Две стороны печатаются РЯДОМ и не складываются: отправитель отвечает на
 * вопрос «сложилась ли координата», приёмник — «собрался ли набор». Общая
 * цифра скрыла бы, на каком из двух шагов семейство откатилось.
 */
function printStateGroupReport(sender, receiver) {
  if (!sender && !receiver) return;
  process.stdout.write("\nSTATE GROUP / VARIANT SET REPORT\n");
  if (sender) {
    process.stdout.write("  групп разобрано          " + sender.groupsEvaluated +
      " (безопасно " + sender.groupsSafe + ", откат " + sender.groupsFallback + ")\n");
    process.stdout.write("  участников в источнике   " + sender.membersEvaluated +
      " (в безопасных группах " + sender.membersInSafeGroups + ")\n");
    process.stdout.write("  участников уехало        " + sender.variantMembersEmitted + "\n");
    process.stdout.write("  семейств востребовано    " + (sender.variantFamiliesClosed || 0) +
      " (добавлено " + (sender.variantFamilyMembersPulled || 0) +
      ", отложено " + (sender.variantFamilyMembersDeferred || 0) + ")\n");
    Object.keys(sender.fallbackByReason || {}).sort(function (a, b) {
      return sender.fallbackByReason[b] - sender.fallbackByReason[a];
    }).forEach(function (reason) {
      process.stdout.write("  " + pad(reason, 42) + sender.fallbackByReason[reason] + "\n");
    });
    (sender.samples || []).forEach(function (sample) {
      process.stdout.write("  образец " + sample.status + " " + sample.groupId +
        " «" + sample.groupName + "»: " + sample.detail + "\n");
    });
  }
  if (!receiver) return;
  process.stdout.write("  наборов собрано в Figma  " + receiver.groupsCombined +
    "/" + receiver.groupsSeen + " (участников " + receiver.membersCombined +
    "/" + receiver.membersSeen + ")\n");
  process.stdout.write("  участников потеряно      " + receiver.membersLostAfterCombine +
    ", вошло в готовый набор " + (receiver.membersJoinedLate || 0) + "\n");
  process.stdout.write("  семейство полно при combine " + (receiver.familiesCompleteAtCombine || 0) +
    ", неполно " + (receiver.familiesIncompleteAtCombine || 0) + "\n");
  Object.keys(receiver.fallbackByReason || {}).sort().forEach(function (reason) {
    process.stdout.write("  " + pad(reason, 42) + receiver.fallbackByReason[reason] + "\n");
  });
  (receiver.fallbackSamples || []).forEach(function (sample) {
    process.stdout.write("  образец " + sample.reason + " " + sample.groupId +
      " «" + sample.groupName + "» (" + sample.members + " участников): " + sample.detail + "\n");
  });
  var verification = receiver.verification || { sets: [], instances: [] };
  (verification.sets || []).forEach(function (entry) {
    process.stdout.write("  набор " + entry.groupId + ": type=" + entry.setType +
      ", детей=" + entry.setChildren +
      ", доехало/в источнике=" + entry.membersDelivered + "/" + entry.membersSource +
      ", оси=" + JSON.stringify((entry.propertyDefinitions || []).map(function (definition) {
        return definition.name + ":" + (definition.variantOptions || []).length;
      })) + "\n");
    process.stdout.write("    порядок источника=" + JSON.stringify(entry.sourceOrder) + "\n");
    (entry.members || []).forEach(function (member) {
      process.stdout.write("    участник " + member.definitionId + " type=" + member.type +
        ", в наборе=" + member.parentIsSet +
        ", имя=" + JSON.stringify(member.name) +
        (member.name === member.expectedName ? "" : " (ожидали " + JSON.stringify(member.expectedName) + ")") +
        ", координата=" + JSON.stringify(member.variantProperties) + "\n");
    });
  });
  (verification.instances || []).forEach(function (entry) {
    process.stdout.write("    вхождение " + entry.occurrenceId + " type=" + entry.type +
      ", мастер=" + entry.mainComponentDefinitionId +
      ", ожидали=" + entry.expectedDefinitionId +
      ", совпало=" + entry.mainComponentMatches +
      ", координата=" + JSON.stringify(entry.variantProperties) + "\n");
  });
}

function printExpressibilityReport(report) {
  if (!report) return;
  process.stdout.write("\nEXPRESSIBILITY DECISIONS\n");
  process.stdout.write("  totals                    " + JSON.stringify(report.totals || {}) + "\n");
  process.stdout.write("  requires probe            " +
    (report.requiresProbe === undefined ? report.unmeasured || 0 : report.requiresProbe) + "\n");
  (report.table || []).forEach(function (row) {
    process.stdout.write("  " + pad(row.class, 34) + pad(row.decision, 12) +
      pad(row.reason, 50) + row.count + "\n");
  });
}

function countSubtree(root) {
  var count = 0;
  var stack = [root];
  while (stack.length) {
    var current = stack.pop();
    count += 1;
    for (var i = 0; i < current.children.length; i++) stack.push(current.children[i]);
  }
  return count;
}

/**
 * План full-document режима. Имена не участвуют в фильтрации страниц:
 * служебное библиотечное полотно опознаётся по структурному флагу формата
 * (`internalOnly` записи CANVAS).
 *
 * Пропуск касается только раскладки содержимого. Символы этого полотна
 * остаются доступны как источник определений: определения строятся по
 * требованию от реального пользовательского контента, а не перечислением
 * всей библиотеки.
 */
function createDocumentPlan(doc) {
  var pages = [];
  var skipped = [];
  doc.tree.pages.forEach(function (page) {
    if (PixDocument.isInternalPage(page)) {
      skipped.push({
        pageId: page.key,
        pageName: page.name,
        reason: "INTERNAL_PAGE",
        marker: "CANVAS.internalOnly",
        roots: page.children.length,
      });
      return;
    }
    pages.push({
      pageId: page.key,
      pageName: page.name || "Pixso",
      roots: page.children.slice(),
    });
  });
  return { pages: pages, skipped: skipped };
}

function addCounts(target, source) {
  Object.keys(source || {}).forEach(function (key) {
    target[key] = (target[key] || 0) + (source[key] || 0);
  });
  return target;
}

function selectRoots(doc, options) {
  var wanted = options.roots;
  var found = [];
  var missing = [];
  wanted.forEach(function (id) {
    var record = doc.tree.byKey.get(id);
    if (!record) { missing.push(id); return; }
    found.push(record);
  });
  if (missing.length) {
    throw new Error("Не найдены корни: " + missing.join(", ") + ". Список — `--list-roots`.");
  }
  return found;
}

// ---------------------------------------------------------------------------
// Владение job
// ---------------------------------------------------------------------------

/** Код выхода по сигналу: тот же 128 + номер, что и у обычного процесса. */
var SIGNAL_EXIT_CODE = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
/** Сколько ждём снятия job перед выходом. Меньше, чем launcher ждёт SIGTERM. */
var ABORT_GRACE_MS = 2500;

/**
 * Секрет владения job.
 *
 * Launcher передаёт свой через окружение — так он сможет доказать bridge, что
 * снимает ИМЕННО свою job, не трогая чужую или параллельную. Ручной запуск
 * получает собственный токен: Ctrl+C тогда тоже закрывает job за собой.
 * В командную строку токен не попадает: её видно в `ps`.
 */
function resolveProducerToken() {
  var fromLauncher = process.env.PIXSO2FIGMA_PRODUCER_TOKEN;
  if (fromLauncher) return String(fromLauncher);
  return crypto.randomBytes(24).toString("hex");
}

/** Client активной job: его и снимает обработчик сигнала. */
var jobGuard = { client: null, aborting: false, installed: false };

/**
 * Сообщает родителю (launcher) id только что созданной job и берёт её под
 * охрану сигналов.
 *
 * Канал IPC сразу `unref`: он не имеет права удерживать процесс живым после
 * окончания migration. Если канала нет (ручной запуск) или он уже закрыт,
 * охрана сигналов всё равно остаётся — токен у нас свой.
 */
function guardJob(client) {
  jobGuard.client = client;
  var jobId = client && typeof client.jobId === "function" ? client.jobId() : null;
  if (!jobId || typeof process.send !== "function") return;
  try {
    process.send({ type: "pixso2figma.job", jobId: jobId });
    if (process.channel && process.channel.unref) process.channel.unref();
  } catch (_e) {
    /* родитель уже закрыл канал: launcher снимет job по своему токену */
  }
}

/**
 * Аварийное завершение. SIGINT приходит от терминала, SIGTERM — от launcher
 * при закрытии окна, SIGHUP — при обрыве сессии. Во всех трёх случаях job
 * закрывается ДО выхода: на переиспользованном bridge она иначе навсегда
 * осталась бы `running` и блокировала следующий Receiver и следующую job.
 */
function installSignalGuards() {
  if (jobGuard.installed) return;
  jobGuard.installed = true;
  Object.keys(SIGNAL_EXIT_CODE).forEach(function (signal) {
    process.on(signal, function () {
      // Повторный сигнал не начинает второй цикл отмены.
      if (jobGuard.aborting) return;
      jobGuard.aborting = true;
      var client = jobGuard.client;
      var aborted = client && typeof client.abortJob === "function"
        ? client.abortJob(null, null, "signal:" + signal).then(
            function (result) { return result; },
            function () { return null; }
          )
        : Promise.resolve(null);
      var timeout = new Promise(function (resolve) {
        var timer = setTimeout(function () { resolve(null); }, ABORT_GRACE_MS);
        if (timer.unref) timer.unref();
      });
      Promise.race([aborted, timeout]).then(function () {
        process.stderr.write("\nDirect PIX остановлен по " + signal + ".\n");
        process.exit(SIGNAL_EXIT_CODE[signal]);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Миграция
// ---------------------------------------------------------------------------

async function migrate(doc, ir, options) {
  // Точка подмены транспорта — та же, что у полнодокументного пути: путь
  // малого прогона обязан проверяться тем же способом, что и основной.
  var client = options.client ||
    BridgeClient.createClient({
      bridge: options.bridge,
      expectedReceiverId: options.receiverId || null,
      producerToken: options.producerToken || resolveProducerToken(),
    });
  // Launcher уже показал пользователю цель: закрепляем именно её, иначе
  // повторная проверка внутри нового процесса могла бы молча выбрать другой
  // Receiver.
  var receiver = await client.ensureReceiver(options.receiverId || null);
  process.stdout.write("Receiver: " + (receiver.documentName || "Figma") +
    ", версия " + receiver.receiverVersion + "\n");

  var totalDefinitionNodes = ir.stats.definitionNodes;
  var startedAt = Date.now();
  var figmaTimings = {
    definitionBuildMs: 0, ordinaryBuildMs: 0, instanceCreateMs: 0,
    overrideApplyMs: 0, assetMs: 0, styleBuildMs: 0, totalImportMs: 0,
  };
  var figmaTotals = {
    definitionsCreated: 0, definitionsReused: 0, instancesCreated: 0,
    ordinaryNodesCreated: 0, overridesAttempted: 0, overridesApplied: 0, overridesMissed: 0,
    assetsCreated: 0, unsupported: 0,
    paintStylesCreated: 0, textStylesCreated: 0, effectStylesCreated: 0, stylesReused: 0,
    fillStyleBindings: 0, strokeStyleBindings: 0,
    effectStyleBindings: 0, textStyleBindings: 0,
  };
  var overrideMissReasons = {};
  // Подтверждение доставки определений. Здесь определения уезжают ровно
  // одним проходом до корней, поэтому переотправлять нечего — но ЧТО
  // приёмник признал пригодным, а что нет, обязано быть видно и в этом
  // режиме: иначе малый прогон не может доказать здоровье доставки.
  var definitionDelivery = {
    acknowledged: 0,
    unconfirmed: 0,
    unconfirmedIds: [],
    unacknowledgedReceiver: false,
    failedByReason: {},
    failedSamples: [],
  };

  await client.start({
    fileName: doc.container.fileName,
    appVersion: doc.container.version && doc.container.version.app_version,
    roots: ir.roots.length,
    definitions: ir.definitions.length,
    nodes: ir.roots.reduce(function (sum, root) { return sum + root.nodes.length; }, 0),
  });
  // С этого момента job существует на bridge: её id уезжает родителю, а
  // сигналы обязаны снимать её, а не просто убивать процесс.
  guardJob(client);

  /**
   * Разбирает подтверждение приёмника по одному chunk определений.
   *
   * Отметки «отправлено» здесь нет и быть не может: определения уезжают
   * один раз до всех корней. Но отказ обязан быть НАЗВАН — молчаливое
   * «создано 0» не отличает «нечего создавать» от «не смогли».
   */
  function recordDelivery(batch, result) {
    var acknowledged = Array.isArray(result && result.ready) ? result.ready : null;
    if (!acknowledged) { definitionDelivery.unacknowledgedReceiver = true; return; }
    var ready = Object.create(null);
    for (var a = 0; a < acknowledged.length; a++) ready[acknowledged[a]] = true;
    for (var b = 0; b < batch.length; b++) {
      var id = batch[b].definitionId;
      if (ready[id]) { definitionDelivery.acknowledged += 1; continue; }
      definitionDelivery.unconfirmed += 1;
      if (definitionDelivery.unconfirmedIds.length < 20) definitionDelivery.unconfirmedIds.push(id);
    }
    (result.failed || []).forEach(function (entry) {
      if (!entry || !entry.definitionId) return;
      var reason = entry.reason || "UNKNOWN";
      definitionDelivery.failedByReason[reason] =
        (definitionDelivery.failedByReason[reason] || 0) + 1;
      if (definitionDelivery.failedSamples.length < 20) definitionDelivery.failedSamples.push(entry);
    });
  }

  var failure = null;
  try {
    await client.sendTask(client.DIRECT_TASK.START, {
      protocol: ir.protocol,
      directVersion: ir.version,
      source: {
        fileName: doc.container.fileName,
        appVersion: doc.container.version && doc.container.version.app_version,
      },
      plan: {
        roots: ir.roots.length,
        definitions: ir.definitions.length,
        definitionNodes: totalDefinitionNodes,
        assets: ir.assets.length,
      },
      debugOverrides: options.debugOverrides,
      traceTextOverrides: options.traceTextOverrides,
      textOverrideTraceLimit: options.textOverrideTraceLimit,
      sizeTraceIds: options.sizeTraceIds && options.sizeTraceIds.length
        ? options.sizeTraceIds : undefined,
      // D52. Трасса стадий по умолчанию обрезана до 240 записей. При явном
      // запросе диагностики поднимаем бюджет: без этого нужная запись просто
      // не доезжает до отчёта, и отладка идёт вслепую.
      stageTraceLimit: options.debugOverrides ? 1000 : undefined,
      variantCombine: options.nativeVariantSets !== false,
    });

    // Ассеты: своя job-level таблица Direct PIX. Со self-contained chunk-ами
    // Fast/Full она не пересекается и на них никак не влияет.
    if (ir.assets.length) {
      var assetStartedAt = Date.now();
      var withBytes = ir.assets.map(function (asset) {
        var bytes = doc.container.readResource(asset.assetId);
        return {
          assetId: asset.assetId,
          extension: asset.extension,
          bytesBase64: bytes ? bytes.toString("base64") : null,
        };
      }).filter(function (asset) { return !!asset.bytesBase64; });

      var assetChunks = client.chunked(withBytes, function (asset) { return asset.bytesBase64.length; });
      for (var a = 0; a < assetChunks.length; a++) {
        var assetResult = await client.sendTask(client.DIRECT_TASK.ASSETS, {
          protocol: ir.protocol,
          directVersion: ir.version,
          index: a + 1,
          total: assetChunks.length,
          assets: assetChunks[a],
        });
        figmaTotals.assetsCreated += assetResult.assetsCreated || 0;
        figmaTimings.assetMs += assetResult.assetMs || 0;
      }
      process.stdout.write("Ассеты: " + withBytes.length + " в " + assetChunks.length + " chunk\n");
      void assetStartedAt;
    }

    // Стили: описание общего стиля уезжает один раз на job и ДО определений.
    // Определение компонента уже несёт привязки своих узлов, а связать узел
    // можно только с существующим стилем.
    if (ir.styles.length) {
      var styleChunks = client.chunked(ir.styles, function (style) {
        return JSON.stringify(style).length;
      });
      for (var st = 0; st < styleChunks.length; st++) {
        var styleResult = await client.sendTask(client.DIRECT_TASK.STYLES, {
          protocol: ir.protocol,
          directVersion: ir.version,
          index: st + 1,
          total: styleChunks.length,
          styles: styleChunks[st],
        });
        figmaTotals.paintStylesCreated += styleResult.paintStylesCreated || 0;
        figmaTotals.textStylesCreated += styleResult.textStylesCreated || 0;
        figmaTotals.effectStylesCreated += styleResult.effectStylesCreated || 0;
        figmaTotals.stylesReused += styleResult.stylesReused || 0;
        figmaTimings.styleBuildMs += styleResult.styleBuildMs || 0;
        figmaTotals.unsupported += styleResult.unsupported || 0;
      }
      process.stdout.write("Стили: " + ir.styles.length + " в " + styleChunks.length + " chunk" +
        " (Paint " + figmaTotals.paintStylesCreated +
        ", Text " + figmaTotals.textStylesCreated +
        ", Effect " + figmaTotals.effectStylesCreated + ")\n");
    }

    // Определения: уникальное определение уезжает один раз на job.
    // D36: safe Pixso state-group is one semantic unit. Never split its
    // members across transport chunks: receiver must call combineAsVariants
    // while every member is still definition-only, before any occurrence is
    // created. Dependency order is preserved because the grouped chunker does
    // not reorder definitions; it only delays a cut until the family closes.
    var definitionChunker = typeof client.chunkedKeepingGroups === "function"
      ? client.chunkedKeepingGroups.bind(client)
      : function (items, sizeOf) { return client.chunked(items, sizeOf); };
    var definitionChunks = definitionChunker(ir.definitions, function (definition) {
      return JSON.stringify(definition).length;
    }, function (definition) {
      return definition && definition.variantSet ? definition.variantSet.groupId : null;
    });
    for (var d = 0; d < definitionChunks.length; d++) {
      var definitionResult = await client.sendTask(client.DIRECT_TASK.DEFINITIONS, {
        protocol: ir.protocol,
        directVersion: ir.version,
        index: d + 1,
        total: definitionChunks.length,
        definitions: definitionChunks[d],
      });
      figmaTotals.definitionsCreated += definitionResult.definitionsCreated || 0;
      figmaTotals.definitionsReused += definitionResult.definitionsReused || 0;
      figmaTimings.definitionBuildMs += definitionResult.definitionBuildMs || 0;
      figmaTotals.unsupported += definitionResult.unsupported || 0;
      recordDelivery(definitionChunks[d], definitionResult);
      process.stdout.write("Определения " + (d + 1) + "/" + definitionChunks.length +
        ": создано " + (definitionResult.definitionsCreated || 0) +
        ", переиспользовано " + (definitionResult.definitionsReused || 0) +
        ", " + (definitionResult.definitionBuildMs || 0) + " мс\n");
    }

    for (var r = 0; r < ir.roots.length; r++) {
      var root = ir.roots[r];
      var rootResult = await client.sendTask(client.DIRECT_TASK.ROOT, {
        protocol: ir.protocol,
        directVersion: ir.version,
        index: r + 1,
        total: ir.roots.length,
        pageId: root.pageId,
        pageName: root.pageName,
        rootId: root.rootId,
        rootName: root.rootName,
        nodes: root.nodes,
        deepOverrideProvenanceSamples: ir.deepOverrideProvenanceSamples || [],
        sourceSemanticReport: ir.sourceSemanticReport || null,
        traceTextOverrides: options.traceTextOverrides,
        textOverrideTraceLimit: options.textOverrideTraceLimit,
        verifyTree: !!options.verifyTree,
      });
      if (options.verifyTree && rootResult.treeVerification) {
        // Снимок до объединения кладётся рядом с итоговым: разница между
        // ними — это ровно эффект combineAsVariants и ничего больше.
        fs.writeFileSync(options.verifyTree.replace(/\.json$/, "") + ".preFinish.json",
          JSON.stringify(rootResult.treeVerification, null, 1));
      }
      figmaTotals.instancesCreated += rootResult.instancesCreated || 0;
      figmaTotals.ordinaryNodesCreated += rootResult.ordinaryNodesCreated || 0;
      figmaTotals.overridesApplied += rootResult.overridesApplied || 0;
      figmaTotals.overridesMissed += rootResult.overridesMissed || 0;
      figmaTotals.overridesAttempted += rootResult.overridesAttempted || 0;
      addCounts(overrideMissReasons, rootResult.overrideMissReasons);
      addCounts(figmaTotals, rootResult.styleBindings);
      figmaTotals.unsupported += rootResult.unsupported || 0;
      figmaTimings.ordinaryBuildMs += rootResult.ordinaryBuildMs || 0;
      figmaTimings.instanceCreateMs += rootResult.instanceCreateMs || 0;
      figmaTimings.overrideApplyMs += rootResult.overrideApplyMs || 0;
      process.stdout.write("Корень " + (r + 1) + "/" + ir.roots.length + " «" + root.rootName +
        "»: узлов " + ((rootResult.ordinaryNodesCreated || 0) + (rootResult.instancesCreated || 0)) +
        ", инстансов " + (rootResult.instancesCreated || 0) +
        ", overrides " + (rootResult.overridesApplied || 0) +
        " (промах " + (rootResult.overridesMissed || 0) + ")" +
        ", " + (rootResult.importMs || 0) + " мс\n");
    }

    var finishResult = await client.sendTask(client.DIRECT_TASK.FINISH, {
      protocol: ir.protocol,
      directVersion: ir.version,
      traceTextOverrides: options.traceTextOverrides,
      textOverrideTraceLimit: options.textOverrideTraceLimit,
      verifyTree: !!(options.verifyTree || options.screenCheck),
      verifyStoredState: !!options.screenCheck,
      // Диагностические опции приходят из аргументов CLI, но `migrate`
      // вызывают и тесты со своим объектом опций: отсутствие поля не имеет
      // права ронять миграцию.
      verifyDefinitionIds: (options.verifyDefinitionIds || []).length
        ? options.verifyDefinitionIds : undefined,
    });
    if ((options.verifyDefinitionIds || []).length && finishResult.definitionVerification) {
      fs.writeFileSync((options.verifyTree || "verify") .replace(/\.json$/, "") + ".definitions.json",
        JSON.stringify(finishResult.definitionVerification, null, 1));
      process.stdout.write("Снимок определений из Figma записан\n");
    }
    if (options.verifyTree && finishResult.treeVerification) {
      fs.writeFileSync(options.verifyTree, JSON.stringify(finishResult.treeVerification, null, 1));
      process.stdout.write("Снимок дерева из Figma: " + options.verifyTree +
        " (" + finishResult.treeVerification.nodes + " узлов" +
        (finishResult.treeVerification.truncated ? ", ОБРЕЗАН" : "") + ")\n");
    } else if (options.verifyTree) {
      process.stdout.write("ВНИМАНИЕ: приёмник не прислал снимок дерева\n");
    }
    figmaTimings.totalImportMs = finishResult.totalImportMs || 0;
    await client.finish("done");
    return {
      jobId: client.jobId(),
      figmaTotals: figmaTotals,
      figmaTimings: figmaTimings,
      definitionDelivery: definitionDelivery,
      receiverTotals: finishResult.totals || null,
      receiverUnsupported: finishResult.unsupportedByCode || {},
      definitionLifetime: finishResult.definitionLifetimeReport || null,
      overrideResolutionReport: finishResult.overrideResolutionReport || {
        totalMisses: figmaTotals.overridesMissed,
        reasons: overrideMissReasons,
        samples: [],
      },
      textOverrideReport: finishResult.textOverrideReport || null,
      styleReport: finishResult.styleReport || null,
      variantSetReport: finishResult.variantSetReport || null,
      treeVerification: options.screenCheck ? finishResult.treeVerification || null : undefined,
      receiverVersion: receiver.receiverVersion || null,
      transport: client.transport,
      wallMs: Date.now() - startedAt,
    };
  } catch (error) {
    failure = error;
    // Отказ Direct-задачи закрывает только свою job. Bridge остаётся живым,
    // и следующая Fast/Full миграция стартует как обычно.
    try { await client.finish("failed", error); } catch (_eFinish) { /* уже закрыта */ }
    throw failure;
  }
}

/**
 * Полный документ передаётся page/root-задачами. В памяти одновременно живёт
 * IR только одного root; реестры уже отправленных definitions/assets содержат
 * лишь идентификаторы. Приёмник при этом держит единый registry на весь job.
 */
async function migrateFile(doc, plan, options) {
  // Тесты подставляют тот же контракт транспорта без сокета; production
  // всегда создаёт обычный localhost client.
  var client = options.client ||
    BridgeClient.createClient({
      bridge: options.bridge,
      expectedReceiverId: options.receiverId || null,
      producerToken: options.producerToken || resolveProducerToken(),
    });
  // Launcher уже показал пользователю цель: закрепляем именно её, иначе
  // повторная проверка внутри нового процесса могла бы молча выбрать другой
  // Receiver.
  var receiver = await client.ensureReceiver(options.receiverId || null);
  process.stdout.write("Receiver: " + (receiver.documentName || "Figma") +
    ", версия " + receiver.receiverVersion + "\n");

  var rootsDiscovered = plan.pages.reduce(function (sum, page) { return sum + page.roots.length; }, 0);
  var rootsSkipped = plan.skipped.reduce(function (sum, page) { return sum + (page.roots || 0); }, 0);
  var sourceNodes = plan.pages.reduce(function (sum, page) {
    return sum + page.roots.reduce(function (pageSum, root) { return pageSum + countSubtree(root); }, 0);
  }, 0);
  var sentDefinitions = Object.create(null);
  // Переотправка ограничена одной попыткой на определение. Без границы
  // определение, которое приёмник не может построить в принципе, уезжало бы
  // заново на КАЖДОМ следующем корне: полное дерево в пакете, полная
  // сериализация, и ни одного вхождения взамен. Одна повторная попытка
  // покрывает случайный отказ; вторая уже ничего не проверяет.
  var retransmittedDefinitions = Object.create(null);
  var abandonedDefinitions = Object.create(null);
  var sentAssets = Object.create(null);
  var sentStyles = Object.create(null);
  var irRegistry = MigrationIR.createRegistry();
  // D53. Востребованный состав семейств вариантов считается ОДИН раз по всем
  // корням job-а до первой отправки. Без него участники одного набора уезжают
  // разными чанками, приёмник дособирает COMPONENT_SET уже после создания его
  // вхождений, и живая Figma переразрешает их по умолчаниям мастера. Список
  // строится по тем же корням, которые мигрируются, поэтому лишнего в него
  // попасть не может.
  var familyDemandRoots = [];
  for (var fp = 0; fp < plan.pages.length; fp++) {
    for (var fr = 0; fr < plan.pages[fp].roots.length; fr++) {
      familyDemandRoots.push(plan.pages[fp].roots[fr]);
    }
  }
  try {
    irRegistry.familyDemand = MigrationIR.collectFamilyDemand(doc, familyDemandRoots, { registry: irRegistry });
  } catch (familyDemandError) {
    // Спрос — оптимизация порядка, а не условие переноса. Не посчитался —
    // работаем прежним путём и говорим об этом вслух.
    irRegistry.familyDemand = new Map();
    process.stderr.write("Спрос на семейства вариантов не посчитан: " +
      (familyDemandError && familyDemandError.message || familyDemandError) + "\n");
  }
  var startedAt = Date.now();
  var report = {
    pagesDiscovered: doc.tree.pages.length,
    pagesImported: 0,
    internalPagesSkipped: plan.skipped.length,
    skippedInternalPages: plan.skipped,
    rootsDiscovered: rootsDiscovered + rootsSkipped,
    userRootsDiscovered: rootsDiscovered,
    internalRootsSkipped: rootsSkipped,
    rootsImported: 0,
    rootsFailed: 0,
    rootFailures: [],
    sourceNodes: sourceNodes,
    definitionsBuilt: 0,
    definitionsReused: 0,
    // Группы состояний: вердикт отправителя и сборка приёмника. Рядом и
    // раздельно — это ответы на разные вопросы.
    stateGroups: null,
    variantSets: null,
    // Доставка определений: когда именно `sentDefinitions` считается
    // зафиксированным и что приёмник не подтвердил.
    definitionDelivery: {
      acknowledged: 0,
      unconfirmed: 0,
      retransmissionsScheduled: 0,
      // Определения, отказавшие и на повторной попытке. Их вхождения уедут
      // заглушками, и это обязано быть названо, а не растворяться в
      // бесконечном цикле переотправок.
      abandoned: 0,
      abandonedIds: [],
      unacknowledgedReceiver: false,
      failedByReason: {},
      failedSamples: [],
    },
    instancesCreated: 0,
    ordinaryNodesCreated: 0,
    overridesAttempted: 0,
    overridesApplied: 0,
    overrideMisses: 0,
    unsupportedOverrides: 0,
    assets: 0,
    parserMs: Object.keys(doc.timings).reduce(function (sum, key) { return sum + (doc.timings[key] || 0); }, 0),
    irMs: 0,
    figmaTimings: {
      definitionBuildMs: 0, ordinaryBuildMs: 0, instanceCreateMs: 0,
      overrideApplyMs: 0, assetMs: 0, styleBuildMs: 0, totalImportMs: 0,
    },
    styles: {
      sourceStylesByType: {},
      unresolvedByReason: {},
      definitionsUnsupported: {},
      bindingsSkippedByReason: {},
      nodeBindings: {},
      overrideBindings: {},
      paintStylesCreated: 0, textStylesCreated: 0, effectStylesCreated: 0, stylesReused: 0,
      receiverBindings: {},
    },
    overrideResolution: {},
    overrideResolutionSamples: [],
    // Идентичность свойств компонента, сложенная по всем корням файла.
    componentProperty: {
      assignmentsTotal: 0,
      resolvedRawIdentity: 0,
      resolvedPublicIdentity: 0,
      recoveredByPublicIdentity: 0,
      publicChainFollowed: 0,
      notBound: 0,
      externalDef: 0,
      danglingParent: 0,
      resolutionCycle: 0,
      resolutionDepthExceeded: 0,
      resolvedByType: {},
      recoveredByType: {},
      unresolvedByType: {},
      registry: null,
      recoveredSamples: [],
    },
    receiverOverrideReport: null,
    textOverrideCounters: {},
    textOverrideTraceSamples: [],
    receiverTextOverrideReport: null,
    unsupported: {},
    // Разрешение канонической идентичности вхождений. Отдельно от адресации
    // override: это два разных отказа на двух разных этапах.
    canonical: {
      pixInstancesSeen: 0,
      canonicalResolved: 0,
      canonicalUnresolved: 0,
      resolvedViaSymbolData: 0,
      resolvedViaInternalOnly: 0,
    },
    canonicalResolution: {},
    canonicalResolutionSamples: [],
    // Шлюз визуальной безопасности вокруг нативной реконструкции.
    visualSafety: {
      nativeInstancesConsidered: 0,
      nativeInstancesVisualSafe: 0,
      nativeInstancesUnsafe: 0,
      nativeInstanceFallbacks: 0,
      nativeInstanceFallbacksFailed: 0,
      nativeInstancesWithLostState: 0,
      swapsInferred: 0,
      pathsTranslatedAcrossCopies: 0,
    },
    fallbackByReason: {},
    unsafeByReason: {},
    unsafeSamples: [],
    swapsInferredByEvidence: {},
    expressibility: { totals: { AS_IS: 0, TRANSLATE: 0, FRAMES: 0 },
      requiresProbe: 0, unmeasured: 0, table: [], samples: [] },
  };

  function rememberExpressibility(section) {
    if (!section) return;
    ["AS_IS", "TRANSLATE", "FRAMES"].forEach(function (key) {
      report.expressibility.totals[key] += section.totals && section.totals[key] || 0;
    });
    var probeDebt = section.requiresProbe === undefined ? section.unmeasured || 0 : section.requiresProbe;
    report.expressibility.requiresProbe += probeDebt;
    report.expressibility.unmeasured += probeDebt;
    (section.table || []).forEach(function (row) {
      var existing = report.expressibility.table.filter(function (item) {
        return item.class === row.class && item.decision === row.decision && item.reason === row.reason;
      })[0];
      if (existing) existing.count += row.count;
      else report.expressibility.table.push({ class: row.class, decision: row.decision,
        reason: row.reason, count: row.count });
    });
    report.expressibility.table.sort(function (a, b) {
      var ak = a.class + "\u001f" + a.decision + "\u001f" + a.reason;
      var bk = b.class + "\u001f" + b.decision + "\u001f" + b.reason;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    for (var i = 0; i < (section.samples || []).length && report.expressibility.samples.length < 60; i++) {
      report.expressibility.samples.push(section.samples[i]);
    }
  }

  function rememberCanonical(ir) {
    Object.keys(report.canonical).forEach(function (key) {
      report.canonical[key] += ir.stats[key] || 0;
    });
    addCounts(report.canonicalResolution, ir.canonicalResolution);
    for (var i = 0; i < (ir.canonicalResolutionSamples || []).length &&
      report.canonicalResolutionSamples.length < 20; i++) {
      report.canonicalResolutionSamples.push(ir.canonicalResolutionSamples[i]);
    }
  }

  /**
   * Складывает по корням идентичность свойств компонента.
   *
   * Реестр определений документный, поэтому он не суммируется, а
   * запоминается: сложить его по корням значило бы посчитать одни и те же
   * определения столько раз, сколько корней в файле.
   */
  function rememberComponentProperty(section) {
    if (!section) return;
    var target = report.componentProperty;
    ["assignmentsTotal", "resolvedRawIdentity", "resolvedPublicIdentity",
      "recoveredByPublicIdentity", "publicChainFollowed", "notBound", "externalDef",
      "danglingParent", "resolutionCycle", "resolutionDepthExceeded"].forEach(function (key) {
      target[key] += section[key] || 0;
    });
    addCounts(target.resolvedByType, section.resolvedByType);
    addCounts(target.recoveredByType, section.recoveredByType);
    addCounts(target.unresolvedByType, section.unresolvedByType);
    if (section.registry) target.registry = section.registry;
    for (var i = 0; i < (section.recoveredSamples || []).length &&
      target.recoveredSamples.length < 20; i++) {
      target.recoveredSamples.push(section.recoveredSamples[i]);
    }
  }

  function rememberSamples(list) {
    for (var i = 0; i < (list || []).length && report.overrideResolutionSamples.length < 40; i++) {
      report.overrideResolutionSamples.push(list[i]);
    }
  }

  async function sendAssets(ir) {
    var fresh = ir.assets.filter(function (asset) {
      if (sentAssets[asset.assetId]) return false;
      sentAssets[asset.assetId] = true;
      return true;
    }).map(function (asset) {
      var bytes = doc.container.readResource(asset.assetId);
      return {
        assetId: asset.assetId,
        extension: asset.extension,
        bytesBase64: bytes ? bytes.toString("base64") : null,
      };
    }).filter(function (asset) { return !!asset.bytesBase64; });
    var chunks = client.chunked(fresh, function (asset) { return asset.bytesBase64.length; });
    for (var i = 0; i < chunks.length; i++) {
      var result = await client.sendTask(client.DIRECT_TASK.ASSETS, {
        protocol: ir.protocol, directVersion: ir.version,
        index: i + 1, total: chunks.length, assets: chunks[i],
        debugOverrides: options.debugOverrides,
        traceTextOverrides: options.traceTextOverrides,
        textOverrideTraceLimit: options.textOverrideTraceLimit,
        fullDocument: true,
      });
      report.assets += result.assetsCreated || 0;
      report.figmaTimings.assetMs += result.assetMs || 0;
    }
  }

  /**
   * Стили едут ПЕРЕД определениями и корнем: связать узел можно только с уже
   * существующим стилем. Реестр отправленных — уровня job, как у определений
   * и ассетов, поэтому общий стиль дизайн-системы уезжает один раз на весь
   * документ, а не по разу на страницу.
   */
  async function sendStyles(ir) {
    if (!ir.styles || !ir.styles.length) return;
    var fresh = ir.styles.filter(function (style) {
      if (sentStyles[style.styleId]) return false;
      sentStyles[style.styleId] = true;
      return true;
    });
    if (!fresh.length) return;
    var chunks = client.chunked(fresh, function (style) { return JSON.stringify(style).length; });
    for (var i = 0; i < chunks.length; i++) {
      var result = await client.sendTask(client.DIRECT_TASK.STYLES, {
        protocol: ir.protocol, directVersion: ir.version,
        index: i + 1, total: chunks.length, styles: chunks[i],
        fullDocument: true,
      });
      report.styles.paintStylesCreated += result.paintStylesCreated || 0;
      report.styles.textStylesCreated += result.textStylesCreated || 0;
      report.styles.effectStylesCreated += result.effectStylesCreated || 0;
      report.styles.stylesReused += result.stylesReused || 0;
      report.figmaTimings.styleBuildMs += result.styleBuildMs || 0;
    }
  }

  /**
   * Отправка определений с подтверждением.
   *
   * `sentDefinitions` означает «приёмник подтвердил, что это определение
   * ПРИГОДНО к созданию вхождений», а не «мы отправили пакет». Разница не
   * теоретическая: отметка до подтверждения превращала единичный отказ
   * одного определения в постоянную потерю ВСЕХ его вхождений во всех
   * следующих корнях, потому что второй раз оно уже не уезжало.
   *
   * Не подтверждённое определение снимается ещё и с учёта в IR-реестре:
   * иначе следующая сборка сочла бы его известным и не приложила бы к
   * пакету — отправлять было бы нечего.
   *
   * Старый приёмник списка `ready` не присылает. Для него поведение
   * остаётся прежним, оптимистичным: менять протокол задним числом нельзя.
   */
  async function sendDefinitions(ir) {
    var fresh = [];
    for (var i = 0; i < ir.definitions.length; i++) {
      var definition = ir.definitions[i];
      if (sentDefinitions[definition.definitionId]) {
        report.definitionsReused += 1;
      } else if (abandonedDefinitions[definition.definitionId]) {
        // Повторная попытка уже была и тоже не подтвердилась. Третьей не
        // будет: приёмник назвал причину, и она не лечится повтором.
        continue;
      } else {
        fresh.push(definition);
      }
    }
    var chunks = client.chunked(fresh, function (definition) { return JSON.stringify(definition).length; });
    for (var c = 0; c < chunks.length; c++) {
      var batch = chunks[c];
      var result = await client.sendTask(client.DIRECT_TASK.DEFINITIONS, {
        protocol: ir.protocol, directVersion: ir.version,
        index: c + 1, total: chunks.length, definitions: batch,
        debugOverrides: options.debugOverrides,
        traceTextOverrides: options.traceTextOverrides,
        textOverrideTraceLimit: options.textOverrideTraceLimit,
        fullDocument: true,
      });
      report.definitionsBuilt += result.definitionsCreated || 0;
      report.definitionsReused += result.definitionsReused || 0;
      report.figmaTimings.definitionBuildMs += result.definitionBuildMs || 0;
      commitDelivery(batch, result);
    }
  }

  /** Фиксирует отправленным только то, что приёмник назвал пригодным. */
  function commitDelivery(batch, result) {
    var acknowledged = Array.isArray(result && result.ready) ? result.ready : null;
    if (!acknowledged) {
      // Приёмник без подтверждений: прежняя семантика, но она названа.
      report.definitionDelivery.unacknowledgedReceiver = true;
      for (var o = 0; o < batch.length; o++) sentDefinitions[batch[o].definitionId] = true;
      return;
    }
    var ready = Object.create(null);
    for (var a = 0; a < acknowledged.length; a++) ready[acknowledged[a]] = true;
    var unconfirmed = [];
    for (var b = 0; b < batch.length; b++) {
      var id = batch[b].definitionId;
      if (ready[id]) {
        sentDefinitions[id] = true;
        report.definitionDelivery.acknowledged += 1;
      } else {
        unconfirmed.push(id);
      }
    }
    if (!unconfirmed.length) return;
    report.definitionDelivery.unconfirmed += unconfirmed.length;
    // Причина отказа приезжает от приёмника и сохраняется как есть: своей
    // догадки здесь быть не может.
    (result.failed || []).forEach(function (entry) {
      if (!entry || !entry.definitionId) return;
      report.definitionDelivery.failedByReason[entry.reason || "UNKNOWN"] =
        (report.definitionDelivery.failedByReason[entry.reason || "UNKNOWN"] || 0) + 1;
      if (report.definitionDelivery.failedSamples.length < 20) {
        report.definitionDelivery.failedSamples.push(entry);
      }
    });
    // Снятие с учёта — единственное, что даёт следующему корню шанс
    // приложить это определение снова. Право на этот шанс — одноразовое.
    var retry = [];
    for (var u = 0; u < unconfirmed.length; u++) {
      var pending = unconfirmed[u];
      if (retransmittedDefinitions[pending]) {
        if (!abandonedDefinitions[pending]) {
          abandonedDefinitions[pending] = true;
          report.definitionDelivery.abandoned += 1;
          if (report.definitionDelivery.abandonedIds.length < 20) {
            report.definitionDelivery.abandonedIds.push(pending);
          }
        }
        continue;
      }
      retransmittedDefinitions[pending] = true;
      retry.push(pending);
    }
    if (!retry.length) return;
    report.definitionDelivery.retransmissionsScheduled +=
      MigrationIR.forgetDefinitions(irRegistry, retry);
  }

  await client.start({
    fileName: doc.container.fileName,
    appVersion: doc.container.version && doc.container.version.app_version,
    pages: plan.pages.length,
    roots: rootsDiscovered,
    nodes: sourceNodes,
    fullDocument: true,
  });
  // С этого момента job существует на bridge: её id уезжает родителю, а
  // сигналы обязаны снимать её, а не просто убивать процесс.
  guardJob(client);

  try {
    await client.sendTask(client.DIRECT_TASK.START, {
      protocol: MigrationIR.PROTOCOL,
      directVersion: MigrationIR.PROTOCOL_VERSION,
      source: {
        fileName: doc.container.fileName,
        appVersion: doc.container.version && doc.container.version.app_version,
      },
      plan: {
        fullDocument: true,
        pages: plan.pages.length,
        internalPagesSkipped: plan.skipped.length,
        roots: rootsDiscovered,
        nodes: sourceNodes,
      },
      debugOverrides: options.debugOverrides,
      traceTextOverrides: options.traceTextOverrides,
      textOverrideTraceLimit: options.textOverrideTraceLimit,
      sizeTraceIds: options.sizeTraceIds && options.sizeTraceIds.length
        ? options.sizeTraceIds : undefined,
      // D52. Трасса стадий по умолчанию обрезана до 240 записей. При явном
      // запросе диагностики поднимаем бюджет: без этого нужная запись просто
      // не доезжает до отчёта, и отладка идёт вслепую.
      stageTraceLimit: options.debugOverrides ? 1000 : undefined,
      fullDocument: true,
    });

    for (var p = 0; p < plan.pages.length; p++) {
      var pagePlan = plan.pages[p];
      await client.sendTask(client.DIRECT_TASK.PAGE, {
        protocol: MigrationIR.PROTOCOL,
        directVersion: MigrationIR.PROTOCOL_VERSION,
        pageId: pagePlan.pageId,
        pageName: pagePlan.pageName,
        index: p + 1,
        total: plan.pages.length,
        debugOverrides: options.debugOverrides,
        fullDocument: true,
      });
      report.pagesImported += 1;
      process.stdout.write("Страница " + (p + 1) + "/" + plan.pages.length + " «" + pagePlan.pageName + "»\n");

      for (var r = 0; r < pagePlan.roots.length; r++) {
        var rootRecord = pagePlan.roots[r];
        var ir;
        try {
          ir = MigrationIR.build(doc, {
            roots: [rootRecord],
            debugOverrides: options.debugOverrides,
            traceTextOverrides: options.traceTextOverrides,
            textOverrideTraceLimit: options.textOverrideTraceLimit,
            nativeVariantSets: options.nativeVariantSets,
            registry: irRegistry,
          });
        } catch (buildError) {
          report.rootsFailed += 1;
          report.rootFailures.push({
            pageId: pagePlan.pageId,
            pageName: pagePlan.pageName,
            rootId: rootRecord.key,
            rootName: rootRecord.name,
            stage: "IR_BUILD",
            error: String(buildError && buildError.message || buildError),
          });
          process.stderr.write("  Корень «" + (rootRecord.name || rootRecord.key) + "» не собран: " +
            (buildError && buildError.message || buildError) + "\n");
          continue;
        }

        report.irMs += ir.timings.irBuildMs || 0;
        Object.keys(report.visualSafety).forEach(function (key) {
          report.visualSafety[key] += ir.stats[key] || 0;
        });
        addCounts(report.fallbackByReason, ir.stats.nativeFallbackByReason);
        addCounts(report.unsafeByReason, ir.stats.nativeUnsafeByReason);
        for (var us = 0; us < (ir.stats.nativeUnsafeSamples || []).length &&
          report.unsafeSamples.length < 20; us++) {
          report.unsafeSamples.push(ir.stats.nativeUnsafeSamples[us]);
        }
        addCounts(report.swapsInferredByEvidence, ir.stats.swapsInferredByEvidence);
        report.definitionsReused += ir.stats.definitionsReused || 0;
        addCounts(report.unsupported, ir.unsupported);
        addCounts(report.overrideResolution, ir.overrideResolution);
        rememberComponentProperty(ir.componentPropertyReport);
        // Реестр групп состояний — общий на job, и его отчёт кумулятивен:
        // складывать снимки разных корней значило бы считать одну группу
        // столько раз, сколько корней её задели.
        report.stateGroups = ir.stateGroupReport || report.stateGroups;
        rememberSamples(ir.overrideResolutionSamples);
        rememberCanonical(ir);
        rememberExpressibility(ir.expressibilityReport);
        report.overrideMisses += ir.unsupported.OVERRIDE_TARGET || 0;
        report.overridesAttempted += (ir.stats.overridesAttempted || 0) +
          (ir.stats.overridesDropped || 0);
        report.unsupportedOverrides += (ir.unsupported.OVERRIDE_FIELD || 0) +
          (ir.unsupported.OVERRIDE_SWAP_UNRESOLVED || 0) +
          (ir.unsupported.COMPONENT_PROPERTY_UNBOUND || 0) +
          (ir.unsupported.COMPONENT_PROPERTY_FIELD || 0);

        addCounts(report.styles.sourceStylesByType, ir.styleReport.sourceStylesByType);
        addCounts(report.styles.unresolvedByReason, ir.styleReport.unresolvedByReason);
        addCounts(report.styles.definitionsUnsupported, ir.styleReport.definitionsUnsupported);
        addCounts(report.styles.bindingsSkippedByReason, ir.styleReport.bindingsSkippedByReason);
        addCounts(report.styles.nodeBindings, ir.styleReport.nodeBindings);
        addCounts(report.styles.overrideBindings, ir.styleReport.overrideBindings);

        await sendStyles(ir);
        await sendAssets(ir);
        await sendDefinitions(ir);

        var root = ir.roots[0];
        if (!root) {
          report.rootsFailed += 1;
          report.rootFailures.push({
            pageId: pagePlan.pageId, pageName: pagePlan.pageName,
            rootId: rootRecord.key, rootName: rootRecord.name,
            stage: "IR_EMPTY", error: "Корень не дал переносимого IR",
          });
          continue;
        }
        var rootResult;
        try {
          rootResult = await client.sendTask(client.DIRECT_TASK.ROOT, {
            protocol: ir.protocol,
            directVersion: ir.version,
            pageId: pagePlan.pageId,
            pageName: pagePlan.pageName,
            rootId: root.rootId,
            rootName: root.rootName,
            nodes: root.nodes,
            deepOverrideProvenanceSamples: ir.deepOverrideProvenanceSamples || [],
            sourceSemanticReport: ir.sourceSemanticReport || null,
            debugOverrides: options.debugOverrides,
            traceTextOverrides: options.traceTextOverrides,
            textOverrideTraceLimit: options.textOverrideTraceLimit,
            fullDocument: true,
          });
        } catch (importError) {
          report.rootsFailed += 1;
          report.rootFailures.push({
            pageId: pagePlan.pageId, pageName: pagePlan.pageName,
            rootId: root.rootId, rootName: root.rootName,
            stage: "FIGMA_IMPORT", error: String(importError && importError.message || importError),
          });
          // После частичного Figma import registry может быть несогласован.
          // Явно останавливаем job вместо продолжения с повреждённым state.
          importError.directReport = report;
          throw importError;
        }

        report.rootsImported += 1;
        report.instancesCreated += rootResult.instancesCreated || 0;
        report.ordinaryNodesCreated += rootResult.ordinaryNodesCreated || 0;
        report.overridesApplied += rootResult.overridesApplied || 0;
        report.overrideMisses += rootResult.overridesMissed || 0;
        addCounts(report.overrideResolution, rootResult.overrideMissReasons);
        addCounts(report.textOverrideCounters, rootResult.textOverrideCounters);
        for (var ts = 0; ts < (rootResult.textOverrideTraceSamples || []).length &&
          report.textOverrideTraceSamples.length < (options.textOverrideTraceLimit || 20); ts++) {
          report.textOverrideTraceSamples.push(rootResult.textOverrideTraceSamples[ts]);
        }
        addCounts(report.styles.receiverBindings, rootResult.styleBindings);
        report.figmaTimings.ordinaryBuildMs += rootResult.ordinaryBuildMs || 0;
        report.figmaTimings.instanceCreateMs += rootResult.instanceCreateMs || 0;
        report.figmaTimings.overrideApplyMs += rootResult.overrideApplyMs || 0;
        process.stdout.write("  Корень " + (report.rootsImported + report.rootsFailed) + "/" + rootsDiscovered +
          " «" + root.rootName + "»: инстансов " + (rootResult.instancesCreated || 0) +
          ", overrides " + (rootResult.overridesApplied || 0) +
          ", промахов " + (rootResult.overridesMissed || 0) +
          ", definitions " + report.definitionsBuilt + "/" + report.definitionsReused +
          ", elapsed " + Math.round((Date.now() - startedAt) / 1000) + " s\n");
      }
    }

    var finish = await client.sendTask(client.DIRECT_TASK.FINISH, {
      protocol: MigrationIR.PROTOCOL,
      directVersion: MigrationIR.PROTOCOL_VERSION,
      debugOverrides: options.debugOverrides,
      traceTextOverrides: options.traceTextOverrides,
      textOverrideTraceLimit: options.textOverrideTraceLimit,
      fullDocument: true,
    });
    report.figmaTimings.totalImportMs = finish.totalImportMs || 0;
    report.receiverOverrideReport = finish.overrideResolutionReport || null;
    // Жизненный цикл определений глазами приёмника: чего он ждал, что
    // построил, почему не построил и чем это доказано.
    report.definitionLifetime = finish.definitionLifetimeReport || null;
    report.variantSets = finish.variantSetReport || null;
    report.receiverTextOverrideReport = finish.textOverrideReport || null;
    report.receiverVisualSafetyReport = finish.visualSafetyReport || null;
    report.receiverStyleReport = finish.styleReport || null;
    report.transport = client.transport;
    report.wallMs = Date.now() - startedAt;
    await client.finish(report.rootsFailed ? "partial" : "done");
    return report;
  } catch (error) {
    report.transport = client.transport;
    report.wallMs = Date.now() - startedAt;
    if (!error.directReport) error.directReport = report;
    try { await client.finish("failed", error); } catch (_eFinish) { /* уже закрыта */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

/**
 * Опыты в живой Figma. Документ не читается:
 * Receiver сам строит маленькие компоненты на своей служебной странице.
 */
async function runProbeCommand(options) {
  var client = options.client || BridgeClient.createClient({
    bridge: options.bridge,
    expectedReceiverId: options.receiverId || null,
    producerToken: options.producerToken || resolveProducerToken(),
  });
  var receiver;
  try {
    receiver = await client.ensureReceiver(options.receiverId || null);
  } catch (error) {
    process.stderr.write("Опыты не начаты: " + error.message + "\n");
    return 1;
  }
  process.stdout.write("Receiver: " + (receiver.documentName || "Figma") + ", версия " + receiver.receiverVersion + "\n");
  process.stdout.write("Выполняю опыты в Figma…\n");
  var result;
  try {
    result = await FigmaProbe.runProbe(client, {
      receiverId: options.receiverId || receiver.receiverId || null,
      experiments: options.probeOnly.length ? options.probeOnly : null,
      onJob: guardJob,
    });
  } catch (error) {
    process.stderr.write("Опыты прерваны: " + error.message + "\n");
    return 1;
  }
  process.stdout.write("\n" + FigmaProbe.renderSummary(result) + "\n");
  var reportPath = options.probeReport || path.join(__dirname, "..", "FIGMA_CAPABILITIES.md");
  fs.writeFileSync(reportPath, FigmaProbe.renderMarkdown(result, {
    date: new Date().toISOString(),
    documentName: receiver.documentName || null,
  }));
  process.stdout.write("\nКарта возможностей: " + reportPath + "\n");
  // Код читает только вердикты: подробная карта — для людей.
  var verdictsPath = options.probeVerdicts || FigmaCapabilities.VERDICTS_FILE;
  fs.writeFileSync(verdictsPath, FigmaCapabilities.renderVerdicts(result));
  process.stdout.write("Вердикты для кода: " + verdictsPath + "\n");
  if (options.out) {
    fs.writeFileSync(options.out, JSON.stringify(result, null, 1));
    process.stdout.write("Сырые замеры: " + options.out + "\n");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Эталонные экраны
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Сверка набора эталонных экранов. Набор задаёт `.pix` (путь относительно
 * файла набора) и экраны `{ id, root, name }`; строятся только их корни.
 */
async function runScreenCheck(options) {
  var configPath = path.resolve(options.checkScreens);
  var config;
  try { config = ScreenCheck.validateConfig(readJsonFile(configPath)); }
  catch (error) { process.stderr.write("Набор экранов не прочитан: " + error.message + "\n"); return 2; }
  var pixPath = path.resolve(path.dirname(configPath), config.file);

  var doc;
  try { doc = PixDocument.load(PixContainer.open(pixPath)); }
  catch (error) { process.stderr.write("Не удалось открыть " + pixPath + ": " + error.message + "\n"); return 1; }

  var rootIds = [];
  config.screens.forEach(function (screen) { if (rootIds.indexOf(screen.root) < 0) rootIds.push(screen.root); });
  var records = [];
  for (var i = 0; i < rootIds.length; i++) {
    var record = doc.tree.byKey.get(rootIds[i]);
    if (!record) { process.stderr.write("В документе нет корня " + rootIds[i] + "\n"); return 2; }
    records.push(record);
  }

  var irByRoot = Object.create(null);
  var verification = null;
  var meta = { mode: options.headless ? "headless" : "live" };
  if (options.headless) {
    var registry = MigrationIR.createRegistry();
    var traceInput = records.map(function (item) {
      var ir = MigrationIR.build(doc, { roots: [item], registry: registry });
      irByRoot[item.key] = ir;
      return { record: item, ir: ir };
    });
    var run = await Trace.runReceiver(doc, traceInput, { verifyTree: true, verifyStoredState: true });
    verification = run.finish.treeVerification || null;
  } else {
    var sharedIr = MigrationIR.build(doc, { roots: records, nativeVariantSets: options.nativeVariantSets });
    records.forEach(function (item) { irByRoot[item.key] = sharedIr; });
    try {
      var result = await migrate(doc, sharedIr, {
        bridge: options.bridge, receiverId: options.receiverId, screenCheck: true,
        nativeVariantSets: options.nativeVariantSets,
      });
      verification = result.treeVerification || null;
      meta.receiverVersion = result.receiverVersion;
    } catch (error) {
      process.stderr.write("Прогон в Figma не завершён: " + error.message + "\n");
      return 1;
    }
  }
  if (!verification) {
    process.stderr.write("Приёмник не прислал снимок дерева — сверка невозможна.\n");
    return 1;
  }

  var report = ScreenCheck.buildReport(config, irByRoot, verification, meta);
  process.stdout.write(options.json ? JSON.stringify(report, null, 1) + "\n" : ScreenCheck.format(report));
  var outPath = options.out;
  if (!outPath) {
    var checksDir = path.join(path.dirname(configPath), "ScreenChecks");
    fs.mkdirSync(checksDir, { recursive: true });
    outPath = path.join(checksDir, meta.mode + "-" + report.createdAt.replace(/[:.]/g, "-") + ".json");
  }
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
  process.stdout.write("Отчёт: " + outPath + "\n");
  return 0;
}

function runCompareChecks(options) {
  var before, after;
  try {
    before = readJsonFile(options.compareChecks[0]);
    after = readJsonFile(options.compareChecks[1]);
  } catch (error) {
    process.stderr.write("Отчёт не прочитан: " + error.message + "\n");
    return 2;
  }
  if (before.format !== ScreenCheck.REPORT_FORMAT || after.format !== ScreenCheck.REPORT_FORMAT) {
    process.stderr.write("Оба файла должны быть отчётами --check-screens.\n");
    return 2;
  }
  var diff = ScreenCheck.compare(before, after);
  process.stdout.write(options.json ? JSON.stringify(diff, null, 1) + "\n" : ScreenCheck.formatComparison(diff));
  return 0;
}

async function main(argv) {
  var options;
  try { options = parseArgs(argv); }
  catch (error) { process.stderr.write(error.message + "\n\n" + USAGE + "\n"); return 2; }

  if (options.probeFigma) {
    if (options.file || options.migrate || options.migrateFile || options.dryRun || options.analyze) {
      process.stderr.write("--probe-figma — отдельный режим без .pix-файла и без команд миграции.\n");
      return 2;
    }
    installSignalGuards();
    return runProbeCommand(options);
  }
  if (options.compareChecks) return runCompareChecks(options);
  if (options.checkScreens) {
    if (!options.headless) installSignalGuards();
    return runScreenCheck(options);
  }
  if (options.help || !options.file) { process.stdout.write(USAGE + "\n"); return options.file ? 0 : 2; }
  if (options.receiverId && !options.migrate && !options.migrateFile) {
    process.stderr.write("--receiver-id допустим только вместе с --migrate или --migrate-file.\n");
    return 2;
  }
  if (options.migrateFile && (options.migrate || options.dryRun || options.analyze ||
      options.listPages || options.listRoots || options.roots.length || options.page)) {
    process.stderr.write("--migrate-file — отдельный режим; не сочетайте его с командами анализа, списка, --root, --page, --migrate или --dry-run.\n");
    return 2;
  }

  // Режимы, создающие job на bridge, обязаны уметь её снять: закрытое окно
  // launcher или Ctrl+C не имеют права оставить job навсегда `running`.
  if (options.migrate || options.migrateFile) installSignalGuards();

  var container;
  try { container = PixContainer.open(options.file); }
  catch (error) { process.stderr.write("Не удалось открыть контейнер: " + error.message + "\n"); return 1; }

  var doc;
  try { doc = PixDocument.load(container); }
  catch (error) {
    process.stderr.write("Не удалось разобрать документ: " + error.message + "\n");
    return 1;
  }

  function emit(text, data) {
    var payload = options.json ? JSON.stringify(data, null, 1) : text;
    if (options.out) {
      fs.writeFileSync(options.out, payload + "\n");
      process.stdout.write("Записано: " + options.out + "\n");
    } else {
      process.stdout.write(payload + "\n");
    }
  }

  if (options.listPages) {
    var pages = doc.tree.pages.map(function (page) {
      return {
        id: page.key, name: page.name, roots: page.children.length,
        internal: PixDocument.isInternalPage(page),
      };
    });
    emit(pages.map(function (page) {
      // Служебное полотно видно в списке, но помечено: full-document его
      // содержимое не раскладывает, а символы остаются доступны.
      return pad(page.id, 12) + pad(page.roots + " корн.", 12) +
        (page.internal ? "[служебное] " : "") + page.name;
    }).join("\n"), pages);
    return 0;
  }

  if (options.listRoots) {
    var listing = Analyzer.listRoots(doc, options.page);
    emit(printRoots(listing), listing);
    return 0;
  }

  if (options.analyze || (!options.dryRun && !options.migrate && !options.migrateFile && !options.trace)) {
    var report = Analyzer.analyze(doc, { overrideSampleStep: options.sample });
    emit(printAnalysis(report), report);
    return 0;
  }

  if (options.migrateFile) {
    var documentPlan = createDocumentPlan(doc);
    try {
      var fileResult = await migrateFile(doc, documentPlan, options);
      process.stdout.write("\nDirect PIX Full Document Summary\n");
      process.stdout.write("  страниц найдено          " + fileResult.pagesDiscovered + "\n");
      process.stdout.write("  страниц импортировано    " + fileResult.pagesImported + "\n");
      process.stdout.write("  внутренних пропущено     " + fileResult.internalPagesSkipped +
        (fileResult.internalRootsSkipped ? " (" + fileResult.internalRootsSkipped + " корн. библиотеки)" : "") + "\n");
      process.stdout.write("  корней найдено           " + fileResult.rootsDiscovered + "\n");
      process.stdout.write("  корней пользователя      " + fileResult.userRootsDiscovered + "\n");
      process.stdout.write("  корней импортировано     " + fileResult.rootsImported + "\n");
      process.stdout.write("  корней с ошибкой         " + fileResult.rootsFailed + "\n");
      process.stdout.write("  исходных узлов           " + fileResult.sourceNodes + "\n");
      process.stdout.write("  definitions built/reused " + fileResult.definitionsBuilt + "/" + fileResult.definitionsReused + "\n");
      process.stdout.write("  instances/ordinary       " + fileResult.instancesCreated + "/" + fileResult.ordinaryNodesCreated + "\n");
      process.stdout.write("  overrides try/ok/miss    " + fileResult.overridesAttempted + "/" +
        fileResult.overridesApplied + "/" + fileResult.overrideMisses + "\n");
      process.stdout.write("  TEXT changes/clears/blocked " +
        (fileResult.textOverrideCounters.explicitTextChanges || 0) + "/" +
        (fileResult.textOverrideCounters.explicitTextClears || 0) + "/" +
        (fileResult.textOverrideCounters.blockedImplicitTextClears || 0) + "\n");
      process.stdout.write("  unsupported overrides    " + fileResult.unsupportedOverrides + "\n");
      process.stdout.write("  assets/resources         " + fileResult.assets + "\n");
      process.stdout.write("  нативных стилей          Paint " + fileResult.styles.paintStylesCreated +
        ", Text " + fileResult.styles.textStylesCreated +
        ", Effect " + fileResult.styles.effectStylesCreated +
        " (переиспользовано " + fileResult.styles.stylesReused + ")\n");
      process.stdout.write("  стилей источника найдено " + JSON.stringify(fileResult.styles.sourceStylesByType) + "\n");
      process.stdout.write("  привязок стилей          " + JSON.stringify(fileResult.styles.receiverBindings) + "\n");
      process.stdout.write("  привязок отменено        " + JSON.stringify(fileResult.styles.bindingsSkippedByReason) + "\n");
      process.stdout.write("  ссылок без цели          " + JSON.stringify(fileResult.styles.unresolvedByReason) + "\n");
      process.stdout.write("  parser / IR (мс)         " + fileResult.parserMs + " / " + fileResult.irMs + "\n");
      process.stdout.write("  transport (мс)           post " + fileResult.transport.postMs +
        ", ack " + fileResult.transport.ackMs + ", задач " + fileResult.transport.tasks + "\n");
      process.stdout.write("  Figma (мс)               " + JSON.stringify(fileResult.figmaTimings) + "\n");
      process.stdout.write("  всего (мс)               " + fileResult.wallMs + "\n");
      process.stdout.write("\nCANONICAL IDENTITY REPORT\n");
      process.stdout.write("  вхождений просмотрено    " + fileResult.canonical.pixInstancesSeen + "\n");
      process.stdout.write("  идентичность найдена     " + fileResult.canonical.canonicalResolved +
        " (symbolData " + fileResult.canonical.resolvedViaSymbolData +
        ", служебное полотно " + fileResult.canonical.resolvedViaInternalOnly + ")\n");
      process.stdout.write("  идентичность не найдена  " + fileResult.canonical.canonicalUnresolved + "\n");
      Object.keys(fileResult.canonicalResolution).sort(function (a, b) {
        return fileResult.canonicalResolution[b] - fileResult.canonicalResolution[a];
      }).forEach(function (reason) {
        process.stdout.write("  " + pad(reason, 42) + fileResult.canonicalResolution[reason] + "\n");
      });
      printExpressibilityReport(fileResult.expressibility);
      var cp = fileResult.componentProperty;
      process.stdout.write("\nCOMPONENT PROPERTY IDENTITY REPORT\n");
      process.stdout.write("  назначений всего         " + cp.assignmentsTotal + "\n");
      // Три величины читаются только вместе: сколько совпало бы по сырому
      // defID, сколько совпадает по публичному корню и какова разница между
      // ними. Разница — и есть эффект `publicOf()`.
      process.stdout.write("  сырая идентичность       " + cp.resolvedRawIdentity + "\n");
      process.stdout.write("  публичная идентичность   " + cp.resolvedPublicIdentity + "\n");
      process.stdout.write("  восстановлено публичной  " + cp.recoveredByPublicIdentity +
        " (шагов по цепочке: " + cp.publicChainFollowed + ")\n");
      process.stdout.write("  не привязано             " + cp.notBound + "\n");
      process.stdout.write("  внешнее определение      " + cp.externalDef + "\n");
      process.stdout.write("  оборванный родитель      " + cp.danglingParent +
        ", цикл " + cp.resolutionCycle + ", глубина " + cp.resolutionDepthExceeded + "\n");
      process.stdout.write("  по типам resolved        " + JSON.stringify(cp.resolvedByType) + "\n");
      process.stdout.write("  по типам recovered       " + JSON.stringify(cp.recoveredByType) + "\n");
      process.stdout.write("  по типам unresolved      " + JSON.stringify(cp.unresolvedByType) + "\n");
      if (cp.registry) {
        process.stdout.write("  реестр определений       " + cp.registry.definitionsIndexed +
          " (public " + cp.registry.publicDefinitions +
          ", local " + cp.registry.localDefinitions +
          ", макс. глубина " + cp.registry.maxDepthSeen + ")\n");
      }
      process.stdout.write("\nOVERRIDE RESOLUTION REPORT\n");
      process.stdout.write("  total misses: " + fileResult.overrideMisses + "\n");
      Object.keys(fileResult.overrideResolution).sort(function (a, b) {
        return fileResult.overrideResolution[b] - fileResult.overrideResolution[a];
      }).forEach(function (reason) {
        process.stdout.write("  " + pad(reason, 42) + fileResult.overrideResolution[reason] + "\n");
      });
      printStateGroupReport(fileResult.stateGroups, fileResult.variantSets);

      var lifetime = fileResult.definitionLifetime;
      process.stdout.write("\nDEFINITION LIFETIME REPORT\n");
      if (!lifetime) {
        process.stdout.write("  приёмник этой сборки отчёт не присылает\n");
      } else {
        process.stdout.write("  ожидалось инстансов      " + lifetime.expectedInstances + "\n");
        process.stdout.write("  инстансов создано        " + lifetime.instancesCreated + "\n");
        process.stdout.write("  обычных узлов создано    " + lifetime.ordinaryNodesCreated + "\n");
        process.stdout.write("  определение недоступно   " + lifetime.instanceDefinitionUnavailable + "\n");
        process.stdout.write("  заглушек создано         " + lifetime.placeholderFramesCreated + "\n");
        process.stdout.write("  определений built/reused " + lifetime.definitionsCreated +
          "/" + lifetime.definitionsReused + "\n");
        Object.keys(lifetime.unavailableByReason || {}).sort().forEach(function (reason) {
          process.stdout.write("  " + pad(reason, 42) + lifetime.unavailableByReason[reason] + "\n");
        });
        (lifetime.trace || []).forEach(function (record) {
          process.stdout.write("  след " + record.definitionId +
            " (вхождение " + record.occurrenceId + ")" +
            ": реестр=" + record.registered +
            ", nodeId=" + record.storedNodeId +
            ", ссылка годна=" + record.cachedRefUsable +
            ", removed=" + record.cachedRemoved +
            ", parent=" + record.cachedHasParent +
            ", type=" + record.cachedType +
            ", byId=" + record.asyncLookup + "/" + record.asyncNodeType +
            ", страница определения=" + record.registrationPageId +
            ", текущая страница=" + record.currentPageId +
            ", корней с создания=" + record.rootsSinceCreation +
            ", chunk-ов с создания=" + record.chunksSinceCreation + "\n");
        });
      }
      var delivery = fileResult.definitionDelivery;
      process.stdout.write("\nDEFINITION DELIVERY REPORT\n");
      process.stdout.write("  подтверждено приёмником  " + delivery.acknowledged + "\n");
      process.stdout.write("  не подтверждено          " + delivery.unconfirmed + "\n");
      process.stdout.write("  назначено переотправок   " + delivery.retransmissionsScheduled + "\n");
      process.stdout.write("  брошено после повтора    " + delivery.abandoned +
        (delivery.abandonedIds.length ? " " + delivery.abandonedIds.join(",") : "") + "\n");
      if (delivery.unacknowledgedReceiver) {
        process.stdout.write("  ВНИМАНИЕ: приёмник не присылает подтверждений — доставка оптимистична\n");
      }
      Object.keys(delivery.failedByReason || {}).sort().forEach(function (reason) {
        process.stdout.write("  " + pad(reason, 42) + delivery.failedByReason[reason] + "\n");
      });

      process.stdout.write("\nVISUAL SAFETY REPORT\n");
      var safety = fileResult.visualSafety;
      process.stdout.write("  вхождений рассмотрено    " + safety.nativeInstancesConsidered + "\n");
      process.stdout.write("  нативных, визуально безопасных " + safety.nativeInstancesVisualSafe + "\n");
      process.stdout.write("  нативных, небезопасных " + safety.nativeInstancesUnsafe + "\n");
      process.stdout.write("  визуальных фоллбеков     " + safety.nativeInstanceFallbacks + "\n");
      process.stdout.write("  фоллбек не удался        " + safety.nativeInstanceFallbacksFailed + "\n");
      process.stdout.write("  нативных с потерей       " + safety.nativeInstancesWithLostState +
        "  ← потеря внутри определения: развернуть его нельзя\n");
      process.stdout.write("  подмен восстановлено     " + safety.swapsInferred +
        " " + JSON.stringify(fileResult.swapsInferredByEvidence) + "\n");
      process.stdout.write("  адресов переведено между копиями " + safety.pathsTranslatedAcrossCopies + "\n");
      Object.keys(fileResult.fallbackByReason).sort().forEach(function (reason) {
        process.stdout.write("  " + pad(reason, 42) + fileResult.fallbackByReason[reason] + "\n");
      });
      if (options.out) fs.writeFileSync(options.out, JSON.stringify(fileResult, null, 1));
      return fileResult.rootsFailed ? 1 : 0;
    } catch (error) {
      process.stderr.write("Direct PIX full-document migration остановлена: " + error.message + "\n");
      if (error.directReport && options.out) {
        fs.writeFileSync(options.out, JSON.stringify(error.directReport, null, 1));
      }
      return 1;
    }
  }

  if (options.trace) {
    // Диагностика: корни берутся явные, а без них — все пользовательские.
    var traceRoots = options.roots.length
      ? selectRoots(doc, options)
      : createDocumentPlan(doc).pages.reduce(function (list, page) {
        return list.concat(page.roots);
      }, []);
    if (!traceRoots.length) {
      process.stderr.write("В документе нет пользовательских корней для трассировки.\n");
      return 2;
    }
    var traceReport = await Trace.trace(doc, traceRoots, {
      perCategory: options.sample > 1 ? options.sample : 4,
    });
    if (options.out) fs.writeFileSync(options.out, JSON.stringify(traceReport, null, 1));
    process.stdout.write(options.json
      ? JSON.stringify(traceReport, null, 1) + "\n"
      : Trace.format(traceReport) + "\n");
    return Object.keys(traceReport.mismatchesByGroup).length ? 1 : 0;
  }

  if (!options.roots.length) {
    process.stderr.write("Нужен хотя бы один --root <id>. Список — `--list-roots`.\n");
    return 2;
  }

  var roots;
  try { roots = selectRoots(doc, options); }
  catch (error) { process.stderr.write(error.message + "\n"); return 2; }

  var ir = MigrationIR.build(doc, {
    roots: roots,
    debugOverrides: options.debugOverrides,
    traceTextOverrides: options.traceTextOverrides,
    textOverrideTraceLimit: options.textOverrideTraceLimit,
    nativeVariantSets: options.nativeVariantSets,
  });

  if (options.dryRun) {
    var summary = summarizeIR(ir);
    summary.parserTimings = doc.timings;
    // Для сравнения с существующим FAST: во что тот же корень превращается,
    // если каждое вхождение разворачивать поддеревом.
    summary.expandedNodeEstimate = roots.reduce(function (sum, record) {
      return sum + Analyzer.estimateExpandedNodes(doc, record).nodes;
    }, 0);
    if (options.out) {
      fs.writeFileSync(options.out, JSON.stringify(ir, null, 1));
      process.stdout.write("IR записан: " + options.out + "\n");
      process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
      return 0;
    }
    emit(JSON.stringify(summary, null, 1), summary);
    return 0;
  }

  try {
    var result = await migrate(doc, ir, options);
    process.stdout.write("\nDirect PIX Summary\n");
    process.stdout.write("  исходных узлов Pixso     " + doc.nodeCount + "\n");
    process.stdout.write("  узлов в выбранных корнях " +
      ir.roots.reduce(function (sum, root) { return sum + root.nodes.length; }, 0) + "\n");
    process.stdout.write("  уникальных определений   " + ir.definitions.length +
      " (создано в Figma: " + result.figmaTotals.definitionsCreated +
      ", переиспользовано: " + result.figmaTotals.definitionsReused + ")\n");
    process.stdout.write("  нативных стилей          Paint " + result.figmaTotals.paintStylesCreated +
      ", Text " + result.figmaTotals.textStylesCreated +
      ", Effect " + result.figmaTotals.effectStylesCreated +
      " (переиспользовано " + result.figmaTotals.stylesReused + ")\n");
    process.stdout.write("  привязок стилей          fill " + result.figmaTotals.fillStyleBindings +
      ", stroke " + result.figmaTotals.strokeStyleBindings +
      ", effect " + result.figmaTotals.effectStyleBindings +
      ", text " + result.figmaTotals.textStyleBindings + "\n");
    process.stdout.write("  ссылок на стиль без цели " + ir.styleReport.referencesUnresolved +
      ", привязок отменено местным значением " + ir.styleReport.bindingsSkipped + "\n");
    process.stdout.write("  инстансов создано        " + result.figmaTotals.instancesCreated + "\n");
    process.stdout.write("  обычных узлов создано    " + result.figmaTotals.ordinaryNodesCreated + "\n");
    process.stdout.write("  overrides применено      " + result.figmaTotals.overridesApplied +
      " (промахов: " + result.figmaTotals.overridesMissed + ")\n");
    if (result.textOverrideReport) {
      process.stdout.write("  TEXT changes/clears/blocked " +
        result.textOverrideReport.explicitTextChanges + "/" +
        result.textOverrideReport.explicitTextClears + "/" +
        result.textOverrideReport.blockedImplicitTextClears + "\n");
    }
    printExpressibilityReport(ir.expressibilityReport);
    var singleLifetime = result.definitionLifetime;
    if (singleLifetime) {
      process.stdout.write("\nDEFINITION LIFETIME REPORT\n");
      // Три величины читаются только вместе: сколько вхождений ОЖИДАЛИ
      // инстансами, сколько ими стали и сколько узлов создано помимо них.
      // По отдельности ни одна из них не отличает здоровый прогон от
      // деградировавшего.
      process.stdout.write("  ожидалось инстансов      " + singleLifetime.expectedInstances + "\n");
      process.stdout.write("  инстансов создано        " + singleLifetime.instancesCreated + "\n");
      process.stdout.write("  обычных узлов создано    " + singleLifetime.ordinaryNodesCreated + "\n");
      process.stdout.write("  определений built/reused " + singleLifetime.definitionsCreated +
        "/" + singleLifetime.definitionsReused +
        ", в реестре " + singleLifetime.definitionsRegistered + "\n");
      process.stdout.write("  определение недоступно   " + singleLifetime.instanceDefinitionUnavailable + "\n");
      process.stdout.write("  заглушек создано         " + singleLifetime.placeholderFramesCreated + "\n");
      Object.keys(singleLifetime.unavailableByReason || {}).sort().forEach(function (reason) {
        process.stdout.write("  " + pad(reason, 42) + singleLifetime.unavailableByReason[reason] + "\n");
      });
      (singleLifetime.trace || []).forEach(function (record) {
        process.stdout.write("  след " + record.definitionId +
          " (вхождение " + record.occurrenceId + ")" +
          ": реестр=" + record.registered +
          ", nodeId=" + record.storedNodeId +
          ", ссылка годна=" + record.cachedRefUsable +
          ", removed=" + record.cachedRemoved +
          ", parent=" + record.cachedHasParent +
          ", type=" + record.cachedType +
          ", byId=" + record.asyncLookup + "/" + record.asyncNodeType +
          ", страница определения=" + record.registrationPageId +
          ", текущая страница=" + record.currentPageId +
          ", корней с создания=" + record.rootsSinceCreation +
          ", chunk-ов с создания=" + record.chunksSinceCreation + "\n");
      });
    }
    printStateGroupReport(ir.stateGroupReport, result.variantSetReport);

    var singleDelivery = result.definitionDelivery;
    if (singleDelivery) {
      process.stdout.write("\nDEFINITION DELIVERY REPORT\n");
      process.stdout.write("  подтверждено приёмником  " + singleDelivery.acknowledged + "\n");
      process.stdout.write("  не подтверждено          " + singleDelivery.unconfirmed +
        (singleDelivery.unconfirmedIds.length ? " " + singleDelivery.unconfirmedIds.join(",") : "") + "\n");
      if (singleDelivery.unacknowledgedReceiver) {
        process.stdout.write("  ВНИМАНИЕ: приёмник не присылает подтверждений — доставка оптимистична\n");
      }
      Object.keys(singleDelivery.failedByReason || {}).sort().forEach(function (reason) {
        process.stdout.write("  " + pad(reason, 42) + singleDelivery.failedByReason[reason] + "\n");
      });
    }

    process.stdout.write("\nOVERRIDE RESOLUTION REPORT\n");
    process.stdout.write("  total misses: " + result.figmaTotals.overridesMissed + "\n");
    Object.keys(result.overrideResolutionReport.reasons || {}).sort(function (a, b) {
      return result.overrideResolutionReport.reasons[b] - result.overrideResolutionReport.reasons[a];
    }).forEach(function (reason) {
      process.stdout.write("  " + pad(reason, 42) + result.overrideResolutionReport.reasons[reason] + "\n");
    });
    process.stdout.write("  unsupported при разборе  " +
      Object.keys(ir.unsupported).reduce(function (sum, code) { return sum + ir.unsupported[code]; }, 0) +
      " " + JSON.stringify(ir.unsupported) + "\n");
    process.stdout.write("  unsupported в Figma      " + result.figmaTotals.unsupported +
      " " + JSON.stringify(result.receiverUnsupported) + "\n");
    process.stdout.write("  парсер (мс)              " + JSON.stringify(doc.timings) + "\n");
    process.stdout.write("  IR (мс)                  " + ir.timings.irBuildMs + "\n");
    process.stdout.write("  транспорт (мс)           post " + result.transport.postMs +
      ", ack " + result.transport.ackMs + ", задач " + result.transport.tasks +
      ", байт " + result.transport.bytes + "\n");
    process.stdout.write("  Figma (мс)               " + JSON.stringify(result.figmaTimings) + "\n");
    process.stdout.write("  всего (мс)               " + result.wallMs + "\n");
    if (options.out) fs.writeFileSync(options.out, JSON.stringify({ ir: summarizeIR(ir), result: result }, null, 1));
    return 0;
  } catch (error) {
    process.stderr.write("Direct PIX миграция не завершена: " + error.message + "\n");
    process.stderr.write("Существующие Fast/Full и ручные режимы этим не затронуты.\n");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (error) {
    process.stderr.write("Непредвиденная ошибка: " + (error && error.stack || error) + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs: parseArgs,
  summarizeIR: summarizeIR,
  createDocumentPlan: createDocumentPlan,
  migrate: migrate,
  migrateFile: migrateFile,
  runProbeCommand: runProbeCommand,
  main: main,
};
