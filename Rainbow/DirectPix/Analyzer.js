/**
 * Анализатор `.pix`.
 *
 * Считает документ, ничего не импортируя. Это первый и обязательный шаг
 * эксперимента: прежде чем что-то переносить, нужно знать, из чего документ
 * состоит и какая доля его содержимого вообще поддаётся Direct PIX.
 *
 * Все величины здесь измеренные. Подставленных нулей быть не должно: ноль,
 * который никто не считал, врёт хуже отсутствующего поля.
 */
"use strict";

var PixNormalizer = require("./PixNormalizer");
var PixDocument = require("./PixDocument");

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function topEntries(map, limit) {
  return Object.keys(map)
    .map(function (key) { return { key: key, count: map[key] }; })
    .sort(function (a, b) { return b.count - a.count || (a.key < b.key ? -1 : 1); })
    .slice(0, limit);
}

function analyze(doc, options) {
  options = options || {};
  var startedAt = Date.now();

  var nodesByType = Object.create(null);
  var instancesBySymbol = Object.create(null);
  var overrideFields = Object.create(null);
  var overridePathDepth = Object.create(null);
  var unsupportedNodeTypes = Object.create(null);

  var vectorBlobs = new Set();
  var imageHashes = new Set();
  var missingResources = new Set();

  var totals = {
    nodes: doc.nodeCount,
    blobs: doc.blobCount,
    pages: doc.tree.pages.length,
    orphanNodes: doc.tree.orphans.length,
    symbols: doc.symbols.symbolsById.size,
    instances: doc.symbols.instances.length,
    unresolvedInstances: doc.symbols.unresolvedInstances.length,
    usedSymbols: 0,
    componentFamilies: doc.symbols.familiesByKey.size,
    usedComponentFamilies: 0,
    stateGroups: 0,
    symbolsInStateGroups: 0,
    overrideRecords: 0,
    overridePathsEmpty: 0,
    instancesScannedForOverrides: 0,
    imageResources: doc.container.resourceIds.length,
    imageResourcesReferenced: 0,
    imageResourcesMissing: 0,
    vectorGeometryBlobs: 0,
    vectorGeometryUndecodable: 0,
  };

  doc.tree.records.forEach(function (record) {
    increment(nodesByType, record.type);
    if (!PixNormalizer.SUPPORTED_TYPES[record.type]) increment(unsupportedNodeTypes, record.type);
    if (record.isStateGroup) totals.stateGroups += 1;
    if (record.type === "SYMBOL" && record.parent && record.parent.isStateGroup) {
      totals.symbolsInStateGroups += 1;
    }
    (record.fillGeometry || []).forEach(function (path) { vectorBlobs.add(path.blobIndex); });
    (record.strokeGeometry || []).forEach(function (path) { vectorBlobs.add(path.blobIndex); });
    if (record.imageHashes) record.imageHashes.forEach(function (hash) { imageHashes.add(hash); });
  });

  doc.symbols.instances.forEach(function (instance) {
    if (instance.symbolId) increment(instancesBySymbol, instance.symbolId);
  });
  totals.usedSymbols = Object.keys(instancesBySymbol).length;

  var usedFamilies = new Set();
  Object.keys(instancesBySymbol).forEach(function (symbolId) {
    var symbol = doc.symbols.symbolsById.get(symbolId);
    if (symbol && symbol.componentKey) usedFamilies.add(symbol.componentKey);
  });
  totals.usedComponentFamilies = usedFamilies.size;

  // Символы, делящие один componentKey: это ровно те случаи, где схлопывание
  // «по ключу» потеряло бы состояния компонента.
  var sharedFamilies = [];
  doc.symbols.familiesByKey.forEach(function (symbols, key) {
    if (symbols.length > 1) sharedFamilies.push({ componentKey: key, symbols: symbols.length });
  });
  sharedFamilies.sort(function (a, b) { return b.symbols - a.symbols; });

  // Проход по overrides: он требует полного разбора инстансов, поэтому его
  // можно ограничить выборкой на очень больших документах.
  var step = Math.max(1, Number(options.overrideSampleStep) || 1);
  for (var i = 0; i < doc.symbols.instances.length; i += step) {
    var detail = doc.detail(doc.symbols.instances[i]);
    totals.instancesScannedForOverrides += 1;
    var records = (detail.symbolData && detail.symbolData.symbolOverrides) || [];
    totals.overrideRecords += records.length;
    for (var r = 0; r < records.length; r++) {
      var guids = records[r].guidPath && records[r].guidPath.guids;
      var depth = guids ? guids.length : 0;
      if (!depth) totals.overridePathsEmpty += 1;
      increment(overridePathDepth, String(depth));
      var keys = Object.keys(records[r]);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] === "guidPath") continue;
        increment(overrideFields, keys[k]);
      }
    }
  }

  imageHashes.forEach(function (hash) {
    if (doc.container.hasResource(hash)) totals.imageResourcesReferenced += 1;
    else missingResources.add(hash);
  });
  totals.imageResourcesMissing = missingResources.size;

  // Геометрия: проверяем, что бинарный путь вообще разбирается. Это и есть
  // граница «поддерживается / явно не поддерживается» для векторов.
  var normalizer = PixNormalizer.createNormalizer(doc, { unsupported: function () {}, asset: function (h) { return h; } });
  vectorBlobs.forEach(function (index) {
    totals.vectorGeometryBlobs += 1;
    if (!normalizer.pathFromBlob(doc.blob(index))) totals.vectorGeometryUndecodable += 1;
  });

  var topSymbols = topEntries(instancesBySymbol, 15).map(function (entry) {
    var symbol = doc.symbols.symbolsById.get(entry.key);
    return {
      symbolId: entry.key,
      instances: entry.count,
      componentKey: symbol ? symbol.componentKey : null,
      name: symbol ? symbol.name : "(символ не найден)",
    };
  });

  var migrationIR = require("./MigrationIR");
  var supportedOverrideFields = migrationIR.OVERRIDE_FIELDS;
  var ignoredOverrideFields = migrationIR.OVERRIDE_IGNORED;
  var unsupportedOverrideFields = Object.keys(overrideFields)
    .filter(function (field) { return !supportedOverrideFields[field] && !ignoredOverrideFields[field]; })
    .map(function (field) { return { field: field, count: overrideFields[field] }; })
    .sort(function (a, b) { return b.count - a.count; });

  return {
    file: {
      name: doc.container.fileName,
      bytes: doc.container.fileSize,
      appVersion: doc.container.version && doc.container.version.app_version,
      kiwiVersion: doc.container.version && doc.container.version.kiwi_version,
      payload: doc.container.payloadName,
      compression: doc.container.payloadHeader.tag,
      entries: doc.container.entries.length,
      messageType: doc.header.type,
    },
    totals: totals,
    nodesByType: topEntries(nodesByType, 40),
    unsupportedNodeTypes: topEntries(unsupportedNodeTypes, 20),
    topSymbolsByUsage: topSymbols,
    sharedComponentKeys: sharedFamilies.slice(0, 15),
    sharedComponentKeyCount: sharedFamilies.length,
    overrideFields: topEntries(overrideFields, 30),
    unsupportedOverrideFields: unsupportedOverrideFields.slice(0, 25),
    overridePathDepth: topEntries(overridePathDepth, 12),
    pages: doc.tree.pages.map(function (page) {
      return {
        id: page.key,
        name: page.name,
        roots: page.children.length,
        internal: PixDocument.isInternalPage(page),
      };
    }),
    timings: {
      containerOpenMs: doc.timings.containerOpenMs,
      decompressMs: doc.timings.decompressMs,
      schemaMs: doc.timings.schemaMs,
      kiwiDecodeMs: doc.timings.kiwiDecodeMs,
      normalizeMs: doc.timings.normalizeMs,
      analyzeMs: Date.now() - startedAt,
    },
  };
}

/** Список корней страницы — для выбора того, что именно мигрировать. */
function listRoots(doc, pageFilter) {
  return doc.tree.pages
    .filter(function (page) { return !pageFilter || page.name === pageFilter || page.key === pageFilter; })
    .map(function (page) {
      return {
        pageId: page.key,
        pageName: page.name,
        roots: page.children.map(function (root) {
          var count = 0;
          var stack = [root];
          while (stack.length) {
            var node = stack.pop();
            count += 1;
            for (var i = 0; i < node.children.length; i++) stack.push(node.children[i]);
          }
          return {
            id: root.key,
            name: root.name,
            type: root.type,
            nodes: count,
            width: root.size ? Math.round(root.size.x) : null,
            height: root.size ? Math.round(root.size.y) : null,
          };
        }),
      };
    });
}

/**
 * Сколько узлов получилось бы, если разворачивать каждое вхождение поддеревом
 * его символа — то есть во что превращается тот же корень в существующем
 * FAST/FULL конвейере, где инстанс уезжает фактическим содержимым.
 *
 * Это оценка объёма работы, а не замер времени: она считается по документу и
 * ни Pixso, ни Figma для неё не нужны. Рекурсия символа в себя обрывается и
 * попадает в `cycles`, чтобы оценка не уходила в бесконечность.
 */
function estimateExpandedNodes(doc, rootRecord) {
  var sizeBySymbol = new Map();
  var visiting = new Set();
  var cycles = 0;

  function expandedSize(record) {
    var total = 1;
    var stack = [record];
    while (stack.length) {
      var node = stack.pop();
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        total += 1;
        if (child.type === "INSTANCE") {
          total += symbolSize(child.symbolId) - 1;
          continue;
        }
        stack.push(child);
      }
    }
    return total;
  }

  function symbolSize(symbolId) {
    if (!symbolId) return 1;
    if (sizeBySymbol.has(symbolId)) return sizeBySymbol.get(symbolId);
    if (visiting.has(symbolId)) { cycles += 1; return 1; }
    var symbol = doc.symbols.symbolsById.get(symbolId);
    if (!symbol) return 1;
    visiting.add(symbolId);
    var size = expandedSize(symbol);
    visiting.delete(symbolId);
    sizeBySymbol.set(symbolId, size);
    return size;
  }

  return { nodes: expandedSize(rootRecord), cycles: cycles };
}

module.exports = { analyze: analyze, listRoots: listRoots, estimateExpandedNodes: estimateExpandedNodes };
