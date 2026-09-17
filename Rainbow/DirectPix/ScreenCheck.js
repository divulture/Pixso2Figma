/**
 * Эталонные экраны: сверка итоговой геометрии Figma с Pixso.
 *
 *   node DirectPix/Cli.js --check-screens <набор.json> [--headless] [--out отчёт.json]
 *   node DirectPix/Cli.js --compare-checks было.json стало.json
 *
 * Эталон — размеры из Pixso, уже собранные в IR:
 *   — у обычных узлов и у самих вхождений — их собственные `width`/`height`;
 *   — у вложенных слоёв вхождения — `sourceBoxes`, итоговые коробки из
 *     `derivedSymbolData` с индексным путём приёмника.
 *
 * Факт — снимок дерева, который приёмник снимает на FINISH по сохранённому
 * состоянию (`verifyTree` + `verifyStoredState`): содержимое вхождения
 * читается с его копии, потому что только копия показывает, что Figma
 * сохранила. Тот же снимок снимается и на headless-двойнике, поэтому оба
 * режима дают отчёт одного формата и сравниваются одной командой.
 *
 * Скрытые узлы и всё под ними не сверяются: их геометрию не видно.
 * Ни одно решение не принимается по имени слоя — имена только подписи.
 */
"use strict";

var REPORT_FORMAT = "pixso2figma-screen-check";
var REPORT_VERSION = 1;
var TOLERANCE = 1;
var WORST_LIMIT = 12;

// ---------------------------------------------------------------------------
// Эталон
// ---------------------------------------------------------------------------

/**
 * Эталон одного экрана: плоский список проверок.
 *
 * `key` — устойчивый адрес проверки между прогонами: `sourceId` узла или
 * `sourceId вхождения#индексный.путь` вложенного слоя.
 */
function expectations(ir, screen) {
  var root = ir.roots.filter(function (item) { return item.rootId === screen.root; })[0];
  if (!root) return { error: "ROOT_NOT_IN_IR", checks: [] };
  var byId = Object.create(null);
  root.nodes.forEach(function (node) { byId[node.id] = node; });
  if (!byId[screen.id]) return { error: "SCREEN_NOT_IN_ROOT", checks: [] };

  function inScreen(node) {
    var current = node;
    var guard = 0;
    while (current && guard++ < 4096) {
      if (current.visible === false) return false;
      if (current.id === screen.id) return true;
      current = current.parent ? byId[current.parent] : null;
    }
    return false;
  }

  var checks = [];
  var unreferencedSnapshotNodes = 0;
  root.nodes.forEach(function (node) {
    if (!inScreen(node)) return;
    // Узел разворота вхождения: его width/height — геометрия определения.
    // Эталоном служит только размер из снимка Pixso; без него узел не сверяется.
    var reference = node.referenceSize || null;
    var width = reference ? reference.width : node.width;
    var height = reference ? reference.height : node.height;
    if (reference && reference.source !== "DERIVED_SNAPSHOT") {
      unreferencedSnapshotNodes += 1;
    } else if (typeof width === "number" && typeof height === "number") {
      checks.push({
        key: node.id, sourceId: node.id, nested: null,
        name: node.name || "", type: node.type,
        width: width, height: height,
      });
    }
    (node.sourceBoxes || []).forEach(function (box) {
      var indexes = (box.path || []).map(function (step) { return step.index; });
      if (!indexes.length) return;
      var last = box.path[box.path.length - 1] || {};
      checks.push({
        key: node.id + "#" + indexes.join("."), sourceId: node.id, nested: indexes,
        name: last.name || "", type: last.targetType || last.sourceType || "",
        width: box.width, height: box.height,
      });
    });
  });
  return { error: null, checks: checks, unreferencedSnapshotNodes: unreferencedSnapshotNodes };
}

// ---------------------------------------------------------------------------
// Сверка
// ---------------------------------------------------------------------------

/** Индекс снимка: узлы по `sourceId` и по дереву путей. */
function indexSnapshot(tree) {
  var bySource = Object.create(null);
  var byPath = Object.create(null);
  (tree || []).forEach(function (entry) {
    byPath[entry.path] = entry;
    // Вложенные слои инстанса несут plugin data мастера: адресом служит
    // только узел, построенный самим приёмником, — первый по обходу.
    if (entry.sourceId && !entry.storedState && !bySource[entry.sourceId]) bySource[entry.sourceId] = entry;
  });
  return { bySource: bySource, byPath: byPath };
}

function hiddenOnPath(index, path) {
  var parts = path.split("/");
  for (var i = parts.length; i > 0; i--) {
    var entry = index.byPath[parts.slice(0, i).join("/")];
    if (entry && entry.visible === false) return true;
  }
  return false;
}

function round(value) { return Math.round(value * 100) / 100; }

function checkScreen(expected, tree) {
  var index = indexSnapshot(tree);
  var result = {
    checked: 0, matched: 0, mismatched: 0, missing: 0, hiddenInFigma: 0,
    byType: Object.create(null), mismatches: Object.create(null), worst: [],
  };
  var all = [];
  expected.checks.forEach(function (check) {
    var owner = index.bySource[check.sourceId];
    var actual = null;
    if (owner) {
      actual = check.nested ? index.byPath[owner.path + "/" + check.nested.join("/")] : owner;
    }
    var type = check.type || "?";
    var bucket = result.byType[type] || (result.byType[type] = { checked: 0, mismatched: 0, missing: 0 });
    if (!actual || typeof actual.width !== "number" || typeof actual.height !== "number") {
      result.missing += 1;
      bucket.missing += 1;
      return;
    }
    if (hiddenOnPath(index, actual.path)) {
      result.hiddenInFigma += 1;
      return;
    }
    result.checked += 1;
    bucket.checked += 1;
    var dw = round(actual.width - check.width);
    var dh = round(actual.height - check.height);
    if (Math.abs(dw) <= TOLERANCE && Math.abs(dh) <= TOLERANCE) {
      result.matched += 1;
      return;
    }
    result.mismatched += 1;
    bucket.mismatched += 1;
    result.mismatches[check.key] = { dw: dw, dh: dh };
    all.push({
      key: check.key, name: check.name, type: type,
      expected: round(check.width) + "×" + round(check.height),
      actual: round(actual.width) + "×" + round(actual.height),
      delta: Math.max(Math.abs(dw), Math.abs(dh)),
    });
  });
  all.sort(function (a, b) { return b.delta - a.delta || (a.key < b.key ? -1 : 1); });
  result.worst = all.slice(0, WORST_LIMIT);
  result.score = result.checked ? Math.round(result.matched / result.checked * 1000) / 10 : null;
  return result;
}

/**
 * Отчёт по набору экранов. `irByRoot` — IR каждого корня, `tree` — снимок
 * дерева приёмника на FINISH.
 */
function buildReport(config, irByRoot, verification, meta) {
  var tree = verification && verification.tree || [];
  var screens = config.screens.map(function (screen) {
    var ir = irByRoot[screen.root];
    var expected = ir ? expectations(ir, screen) : { error: "ROOT_NOT_BUILT", checks: [] };
    var out = { id: screen.id, root: screen.root, name: screen.name || screen.id, error: expected.error };
    if (expected.error) return out;
    out.unreferencedSnapshotNodes = expected.unreferencedSnapshotNodes || 0;
    var result = checkScreen(expected, tree);
    Object.keys(result).forEach(function (key) { out[key] = result[key]; });
    return out;
  });
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    createdAt: new Date().toISOString(),
    mode: meta && meta.mode || null,
    file: config.file,
    receiverVersion: meta && meta.receiverVersion || null,
    tolerance: TOLERANCE,
    snapshot: verification ? {
      nodes: verification.nodes, truncated: !!verification.truncated,
      storedState: !!verification.storedState, clonesRead: verification.clonesRead || 0,
      cloneFailures: verification.cloneFailures || 0,
    } : null,
    screens: screens,
  };
}

// ---------------------------------------------------------------------------
// Вывод и сравнение
// ---------------------------------------------------------------------------

function pad(value, width) {
  value = String(value);
  return value.length >= width ? value + " " : value + new Array(width - value.length + 1).join(" ");
}

function format(report) {
  var lines = [];
  lines.push("ЭТАЛОННЫЕ ЭКРАНЫ (" + (report.mode || "?") + ", допуск " + report.tolerance + " px)");
  if (report.snapshot) {
    lines.push("  снимок: узлов " + report.snapshot.nodes +
      (report.snapshot.truncated ? " (ОБРЕЗАН)" : "") +
      ", копий инстансов " + report.snapshot.clonesRead +
      (report.snapshot.cloneFailures ? ", не скопировано " + report.snapshot.cloneFailures : ""));
  }
  report.screens.forEach(function (screen) {
    lines.push("");
    if (screen.error) {
      lines.push("«" + screen.name + "» " + screen.id + ": не сверен — " + screen.error);
      return;
    }
    lines.push("«" + screen.name + "» " + screen.id + ": совпало " + screen.matched + " из " + screen.checked +
      " (" + (screen.score === null ? "—" : screen.score + "%") + ")" +
      ", расхождений " + screen.mismatched +
      (screen.missing ? ", не найдено в Figma " + screen.missing : "") +
      (screen.hiddenInFigma ? ", скрыто в Figma " + screen.hiddenInFigma : "") +
      (screen.unreferencedSnapshotNodes ? ", без эталона (разворот) " + screen.unreferencedSnapshotNodes : ""));
    Object.keys(screen.byType).sort().forEach(function (type) {
      var bucket = screen.byType[type];
      if (!bucket.mismatched && !bucket.missing) return;
      lines.push("    " + pad(type, 12) + "расхождений " + bucket.mismatched + " из " + bucket.checked +
        (bucket.missing ? ", не найдено " + bucket.missing : ""));
    });
    screen.worst.forEach(function (item) {
      lines.push("    " + pad(item.key, 34) + pad(item.type, 10) + item.expected + " → " + item.actual +
        "  «" + item.name + "»");
    });
  });
  return lines.join("\n") + "\n";
}

/** Было → стало по каждому экрану; новые и исправленные расхождения отдельно. */
function compare(before, after) {
  var beforeById = Object.create(null);
  (before.screens || []).forEach(function (screen) { beforeById[screen.id] = screen; });
  var screens = (after.screens || []).map(function (screen) {
    var old = beforeById[screen.id] || null;
    var oldMismatches = old && old.mismatches || {};
    var newMismatches = screen.mismatches || {};
    var appeared = Object.keys(newMismatches).filter(function (key) { return !oldMismatches[key]; }).sort();
    var fixed = Object.keys(oldMismatches).filter(function (key) { return !newMismatches[key]; }).sort();
    return {
      id: screen.id, name: screen.name,
      scoreBefore: old ? old.score : null, scoreAfter: screen.score,
      mismatchedBefore: old ? old.mismatched : null, mismatchedAfter: screen.mismatched,
      appeared: appeared.map(function (key) { return { key: key, delta: newMismatches[key] }; }),
      fixed: fixed.map(function (key) { return { key: key, delta: oldMismatches[key] }; }),
    };
  });
  return { before: before.createdAt, after: after.createdAt, screens: screens };
}

function formatComparison(diff) {
  var lines = ["СРАВНЕНИЕ ПРОГОНОВ: " + diff.before + " → " + diff.after];
  diff.screens.forEach(function (screen) {
    lines.push("");
    lines.push("«" + screen.name + "» " + screen.id + ": " +
      (screen.scoreBefore === null ? "—" : screen.scoreBefore + "%") + " → " +
      (screen.scoreAfter === null ? "—" : screen.scoreAfter + "%") +
      ", расхождений " + (screen.mismatchedBefore === null ? "—" : screen.mismatchedBefore) +
      " → " + (screen.mismatchedAfter === null ? "—" : screen.mismatchedAfter));
    if (screen.appeared.length) {
      lines.push("    новые (" + screen.appeared.length + "):");
      screen.appeared.slice(0, WORST_LIMIT).forEach(function (item) {
        lines.push("      " + pad(item.key, 34) + "Δ " + item.delta.dw + "×" + item.delta.dh);
      });
    }
    if (screen.fixed.length) {
      lines.push("    исправлены (" + screen.fixed.length + "):");
      screen.fixed.slice(0, WORST_LIMIT).forEach(function (item) {
        lines.push("      " + pad(item.key, 34) + "было Δ " + item.delta.dw + "×" + item.delta.dh);
      });
    }
  });
  return lines.join("\n") + "\n";
}

/** Набор экранов из файла: `{ file, screens: [{ id, root, name }] }`. */
function validateConfig(config) {
  if (!config || typeof config.file !== "string" || !Array.isArray(config.screens) || !config.screens.length) {
    throw new Error("набор экранов: нужны поля file и screens[]");
  }
  config.screens.forEach(function (screen, index) {
    if (!screen || !screen.id || !screen.root) {
      throw new Error("набор экранов: у экрана " + (index + 1) + " нет id или root");
    }
  });
  return config;
}

module.exports = {
  REPORT_FORMAT: REPORT_FORMAT,
  TOLERANCE: TOLERANCE,
  expectations: expectations,
  checkScreen: checkScreen,
  buildReport: buildReport,
  format: format,
  compare: compare,
  formatComparison: formatComparison,
  validateConfig: validateConfig,
};
