/**
 * Документ Pixso поверх декодера Kiwi.
 *
 * Разбор двухпроходный, и это осознанно:
 *
 *  1. Индексный проход читает у каждого узла полтора десятка лёгких полей и
 *     запоминает его байтовое смещение. Дерево, страницы, реестр символов и
 *     статистика строятся отсюда.
 *  2. Детальный проход читает узел целиком, но только когда он действительно
 *     понадобился — по сохранённому смещению.
 *
 * Полный разбор документа одним куском давал бы сотни мегабайт объектов на
 * ровном месте: `derivedSymbolData` (развёрнутое содержимое инстансов) и глифы
 * текста весят больше, чем всё остальное вместе взятое, и Direct PIX они не
 * нужны — в этом весь смысл эксперимента.
 */
"use strict";

var Kiwi = require("./KiwiDecoder");
var PixGuid = require("./PixGuid");
var ComponentProperties = require("./ComponentProperties");

/** Поля узла, достаточные для построения дерева и статистики. */
var INDEX_FIELDS = {
  PixsoNode: new Set([
    "guid", "parentIndex", "type", "name", "phase", "visible",
    "componentKey", "symbolData", "isStateGroup", "size", "overrideKey",
    "publishFile", "publishID", "publishedVersion", "version", "propsAreBubbled",
    "componentPropDef", "componentPropAssignment", "vectorData",
    // `internalOnly` — собственный флаг формата у служебного canvas Pixso.
    // На настоящих документах он стоит ровно у одного CANVAS (библиотечное
    // полотно) и отсутствует у пользовательских страниц. Соседние имена
    // читаются только если присутствуют в schema конкретного файла: разные
    // версии Pixso помечали служебные записи по-разному.
    "internalOnly", "isInternal", "isSystem", "isSoftDeleted",
    "fillGeometry", "strokeGeometry", "fillPaints", "strokePaints",
    // Обе спецификации описывают `ancestorPathBeforeDeletion` как признак
    // символа, живущего на служебном полотне (Internal Only Canvas): путь
    // ведёт к корню документа, из которого символ был вынесен. Поле редкое
    // (на проверенном файле — 104 записи из 4592 SYMBOL) и скалярное, поэтому
    // читается сразу: без него нельзя отличить библиотечный символ от
    // пользовательского, а значит нельзя и честно назвать причину промаха.
    "ancestorPathBeforeDeletion",
  ]),
  // Внутри индексного прохода symbolData нужен только ссылкой на символ:
  // symbolOverrides — это отдельные PixsoNode, и на этом этапе они лишние.
  // Регистр имени поля различается между спецификациями PIX и FIG, поэтому
  // в whitelist стоят обе формы: схема конкретного файла оставит свою.
  SymbolData: new Set(["symbolID", "symbolId"]),
  // `parentPropDefId` — единственный носитель публичной идентичности свойства:
  // локальные определения вариантов сходятся к публичному именно через него.
  // Поле скалярное (GUID) и присутствует у тех же записей, что уже читаются,
  // поэтому индексному проходу оно стоит одного guid на определение.
  ComponentPropDef: new Set(["id", "name", "type", "parentPropDefId"]),
  ComponentPropAssignment: new Set(["defID"]),
  VectorData: new Set(["vectorNetworkBlob", "normalizedSize"]),
  Path: new Set(["blobIndex", "windingRule"]),
  Paint: new Set(["type", "visible", "image"]),
  ImageMessage: new Set(["hash", "dataBlob"]),
};

/** Заведомо тяжёлые поля, которые Direct PIX не использует никогда. */
var DETAIL_SKIP = {
  // derivedSymbolData — это ровно то развёрнутое поддерево, ради отказа от
  // которого затевался Direct PIX. Читать его здесь означало бы вернуть
  // расходы, которые эксперимент и должен убрать.
  PixsoNode: new Set(["derivedSymbolData"]),
  TextData: new Set(["glyphs", "baselines", "glyphPoses", "fontMetaData", "decorations"]),
};

/** Тот же detail-pass, но с glyphs для source TEXT style-definition. */
var TEXT_STYLE_DETAIL_SKIP = {
  PixsoNode: new Set(["derivedSymbolData"]),
  TextData: new Set(["baselines", "glyphPoses", "fontMetaData", "decorations"]),
};

var PAGE_TYPE = "CANVAS";
var DOCUMENT_TYPE = "DOCUMENT";

/**
 * Единственная точка превращения guid в ключ. Формы перечислены в PixGuid:
 * сравнивать сырые представления между собой нельзя.
 */
function guidKey(guid) {
  return PixGuid.normalizeGuid(guid);
}

/**
 * Порядок детей задаётся дробным индексом `parentIndex.position` — это строка,
 * сравниваемая побайтово. Совпадение позиций (в реальных документах бывает)
 * разрешается по localID, чтобы порядок был воспроизводимым.
 */
function compareSiblings(a, b) {
  var left = a.position || "";
  var right = b.position || "";
  if (left < right) return -1;
  if (left > right) return 1;
  if (a.guid.sessionID !== b.guid.sessionID) return a.guid.sessionID - b.guid.sessionID;
  return a.guid.localID - b.guid.localID;
}

/**
 * Читает PixsoMsg: заголовочные поля, индекс узлов и смещения blob-ов.
 * Массив узлов не материализуется — по нему идём с сохранением offset-ов.
 */
function indexDocument(buffer, schema, codec) {
  var messageDefinition = schema.require("PixsoMsg");
  var nodeDefinition = schema.require("PixsoNode");
  var blobDefinition = schema.require("Blob");
  var reader = new Kiwi.ByteReader(buffer, 0);

  var header = {};
  var nodes = [];
  var offsets = [];
  var blobOffsets = [];

  for (;;) {
    var id = reader.varUint();
    if (id === 0) break;
    var field = messageDefinition.byId[id];
    if (!field) throw new Error("PixsoMsg: поле " + id + " отсутствует в схеме документа");

    if (field.name === "pixsoNodes") {
      var count = reader.varUint();
      nodes = new Array(count);
      offsets = new Array(count);
      for (var i = 0; i < count; i++) {
        offsets[i] = reader.index;
        nodes[i] = codec.readMessage(reader, nodeDefinition, { only: INDEX_FIELDS });
      }
      continue;
    }
    if (field.name === "blobs") {
      var blobCount = reader.varUint();
      for (var b = 0; b < blobCount; b++) {
        blobOffsets.push(reader.index);
        codec.skipMessage(reader, blobDefinition);
      }
      continue;
    }
    header[field.name] = codec.readField(reader, field, {});
  }

  return { header: header, nodes: nodes, offsets: offsets, blobOffsets: blobOffsets };
}

/**
 * Строит дерево: родитель, отсортированные дети, страницы и корни.
 * Узел, чей родитель не найден, не выбрасывается — он попадает в orphans и
 * виден в отчёте. Молча терять узлы нельзя.
 */
function buildTree(rawNodes) {
  var byKey = new Map();
  var records = new Array(rawNodes.length);

  for (var i = 0; i < rawNodes.length; i++) {
    var raw = rawNodes[i];
    var key = guidKey(raw.guid);
    var parentIndex = raw.parentIndex || null;
    var record = {
      index: i,
      key: key,
      guid: raw.guid || { sessionID: 0, localID: 0 },
      parentKey: parentIndex ? guidKey(parentIndex.guid) : null,
      position: parentIndex ? parentIndex.position || "" : "",
      type: raw.type || "NONE",
      name: raw.name === undefined ? "" : raw.name,
      phase: raw.phase,
      internal: raw.internalOnly === true || raw.isInternal === true || raw.isSystem === true,
      softDeleted: raw.isSoftDeleted === true,
      visible: raw.visible,
      componentKey: raw.componentKey || null,
      overrideKey: raw.overrideKey || null,
      publishFile: raw.publishFile || null,
      publishID: raw.publishID || null,
      publishedVersion: raw.publishedVersion || null,
      version: raw.version || null,
      symbolId: PixGuid.symbolReference(raw.symbolData),
      // Ссылка на символ была объявлена, но не разложилась в guid. Хранится
      // флагом, а не значением: сырое значение нужно только для того, чтобы
      // отличить «ссылки нет» от «ссылка нечитаема», и держать его на каждом
      // узле документа было бы расточительством.
      symbolRefDeclared: !!(raw.symbolData &&
        (raw.symbolData.symbolID !== undefined || raw.symbolData.symbolId !== undefined)),
      // null — поля не было; [] — оно есть и пустое; список — путь до корня,
      // из которого символ вынесен на служебное полотно.
      ancestorPath: raw.ancestorPathBeforeDeletion
        ? PixGuid.normalizeGuidList(raw.ancestorPathBeforeDeletion)
        : null,
      isStateGroup: !!raw.isStateGroup,
      size: raw.size || null,
      propDefs: raw.componentPropDef || null,
      propAssignments: raw.componentPropAssignment || null,
      vectorBlob: raw.vectorData && raw.vectorData.vectorNetworkBlob,
      fillGeometry: raw.fillGeometry || null,
      strokeGeometry: raw.strokeGeometry || null,
      imageHashes: collectImageHashes(raw),
      children: [],
      parent: null,
      depth: 0,
    };
    records[i] = record;
    if (key !== null) byKey.set(key, record);
  }

  var orphans = [];
  var documentRecord = null;
  for (var j = 0; j < records.length; j++) {
    var node = records[j];
    if (node.type === DOCUMENT_TYPE && !documentRecord) documentRecord = node;
    if (!node.parentKey) continue;
    var parent = byKey.get(node.parentKey);
    if (!parent) { orphans.push(node); continue; }
    node.parent = parent;
    parent.children.push(node);
  }

  for (var k = 0; k < records.length; k++) records[k].children.sort(compareSiblings);

  // Глубина считается итеративно: рекурсия на документе в десятки тысяч узлов
  // упирается в стек.
  var stack = documentRecord ? [documentRecord] : records.filter(function (r) { return !r.parent; });
  var visited = 0;
  while (stack.length) {
    var current = stack.pop();
    visited += 1;
    for (var c = 0; c < current.children.length; c++) {
      current.children[c].depth = current.depth + 1;
      stack.push(current.children[c]);
    }
  }

  var pages = records.filter(function (record) { return record.type === PAGE_TYPE; });

  return {
    records: records,
    byKey: byKey,
    document: documentRecord,
    pages: pages,
    orphans: orphans,
    reachable: visited,
  };
}

/**
 * Консервативный фильтр full-document migration.
 *
 * Признак структурный: у служебного библиотечного полотна Pixso поле
 * `internalOnly` записи CANVAS равно true, у пользовательских страниц оно
 * отсутствует. Проверено на трёх настоящих документах — в каждом ровно один
 * такой canvas, и именно он держит библиотеку символов.
 *
 * Имя страницы не участвует: одноимённая пользовательская страница без флага
 * импортируется как обычная, а служебная с любым именем — пропускается.
 */
function isInternalPage(record) {
  return !!(record && record.type === PAGE_TYPE && record.internal === true);
}

function collectImageHashes(raw) {
  var hashes = null;
  var lists = [raw.fillPaints, raw.strokePaints];
  for (var l = 0; l < lists.length; l++) {
    var paints = lists[l];
    if (!paints) continue;
    for (var i = 0; i < paints.length; i++) {
      var image = paints[i] && paints[i].image;
      if (!image || !image.hash || !image.hash.length) continue;
      if (!hashes) hashes = [];
      var hex = Buffer.from(image.hash).toString("hex");
      if (hashes.indexOf(hex) < 0) hashes.push(hex);
    }
  }
  return hashes;
}

/**
 * Причины, по которым INSTANCE не удалось связать с исходным SYMBOL.
 * Общий счётчик «не резолвится» ничего не чинит: каждая причина требует
 * разного действия, и смешивать их в отчёте нельзя.
 */
var CANONICAL_MISS = {
  // В `symbolData` нет ссылки на символ вовсе.
  CANONICAL_ID_MISSING: "CANONICAL_ID_MISSING",
  // Ссылка есть, но её значение не раскладывается ни в одну документированную
  // форму guid.
  INVALID_GUID_FORMAT: "INVALID_GUID_FORMAT",
  // Ссылка корректна, но SYMBOL с таким guid в документе отсутствует.
  SYMBOL_NOT_FOUND: "SYMBOL_NOT_FOUND",
  // SYMBOL отсутствует, и служебного полотна в документе тоже нет: искать
  // библиотечный символ негде.
  INTERNAL_ONLY_SYMBOL_NOT_INDEXED: "INTERNAL_ONLY_SYMBOL_NOT_INDEXED",
};

/** Как именно вхождение нашло свой SYMBOL. */
var CANONICAL_VIA = {
  SYMBOL_DATA: "SYMBOL_DATA",
  INTERNAL_ONLY: "INTERNAL_ONLY",
};

/** Лежит ли запись под служебным полотном Pixso. */
function onInternalCanvas(record) {
  var current = record;
  while (current) {
    if (current.type === PAGE_TYPE) return current.internal === true;
    current = current.parent;
  }
  return false;
}

/**
 * Реестр символов. Идентичность конкретного определения — это guid исходного
 * SYMBOL, а не componentKey: под одним componentKey живут разные варианты
 * (состояния) компонента, и схлопывать их в один Figma-компонент нельзя.
 * componentKey остаётся признаком семейства и попадает в отчёт.
 *
 * Обе приложенные спецификации описывают связь вхождения с определением
 * одинаково: `INSTANCE.symbolData.symbolID` равен `guid` записи `SYMBOL`,
 * которая лежит на служебном полотне (`CANVAS` с `internalOnly: true`) и
 * помечена `ancestorPathBeforeDeletion`. Это ровно то, что делает поиск по
 * `symbolsById`, — полотно отдельным индексом не является. Отдельный индекс
 * здесь нужен не для поиска, а для отчёта: он позволяет назвать, где именно
 * найден символ и почему он не найден, когда его нет.
 */
function buildSymbolRegistry(tree) {
  var symbolsById = new Map();
  var familiesByKey = new Map();
  var internalOnlySymbols = new Set();
  var symbolsWithAncestorPath = new Set();
  var instances = [];
  var unresolvedInstances = [];
  var hasInternalCanvas = false;

  for (var p = 0; p < tree.pages.length; p++) {
    if (tree.pages[p].internal === true) { hasInternalCanvas = true; break; }
  }

  tree.records.forEach(function (record) {
    if (record.type !== "SYMBOL") return;
    symbolsById.set(record.key, record);
    if (onInternalCanvas(record)) internalOnlySymbols.add(record.key);
    if (record.ancestorPath && record.ancestorPath.length) symbolsWithAncestorPath.add(record.key);
    var family = record.componentKey || null;
    if (!family) return;
    if (!familiesByKey.has(family)) familiesByKey.set(family, []);
    familiesByKey.get(family).push(record);
  });

  /**
   * Канонический источник вхождения плюс доказуемое «как нашли» и «почему
   * не нашли». Имя слоя в решении не участвует ни на одном шаге.
   */
  function resolveSymbol(record) {
    if (!record || record.type !== "INSTANCE") {
      return { symbol: null, via: null, reason: CANONICAL_MISS.CANONICAL_ID_MISSING };
    }
    if (!record.symbolId) {
      // Отличаем «ссылки не было» от «ссылка есть, но нечитаемая»: у первой
      // причина в источнике, у второй — в нашем разборе.
      return {
        symbol: null,
        via: null,
        reason: record.symbolRefDeclared
          ? CANONICAL_MISS.INVALID_GUID_FORMAT
          : CANONICAL_MISS.CANONICAL_ID_MISSING,
      };
    }
    var symbol = symbolsById.get(record.symbolId);
    if (symbol) {
      return {
        symbol: symbol,
        via: internalOnlySymbols.has(symbol.key) ? CANONICAL_VIA.INTERNAL_ONLY : CANONICAL_VIA.SYMBOL_DATA,
        reason: null,
      };
    }
    return {
      symbol: null,
      via: null,
      reason: hasInternalCanvas
        ? CANONICAL_MISS.SYMBOL_NOT_FOUND
        : CANONICAL_MISS.INTERNAL_ONLY_SYMBOL_NOT_INDEXED,
    };
  }

  tree.records.forEach(function (record) {
    if (record.type !== "INSTANCE") return;
    instances.push(record);
    if (!resolveSymbol(record).symbol) unresolvedInstances.push(record);
  });

  return {
    symbolsById: symbolsById,
    familiesByKey: familiesByKey,
    internalOnlySymbols: internalOnlySymbols,
    symbolsWithAncestorPath: symbolsWithAncestorPath,
    hasInternalCanvas: hasInternalCanvas,
    instances: instances,
    unresolvedInstances: unresolvedInstances,
    resolveSymbol: resolveSymbol,
  };
}

/**
 * Открывает документ из уже прочитанного контейнера.
 * Возвращает объект с деревом, реестром символов и доступом к деталям узла.
 */
function load(container) {
  var timings = {
    containerOpenMs: container.timings.containerOpenMs,
    decompressMs: container.timings.decompressMs,
    schemaMs: 0,
    kiwiDecodeMs: 0,
    normalizeMs: 0,
  };

  var schemaStartedAt = Date.now();
  var schema = Kiwi.decodeSchema(container.schemaBuffer);
  var codec = new Kiwi.Codec(schema);
  timings.schemaMs = Date.now() - schemaStartedAt;

  var decodeStartedAt = Date.now();
  var indexed = indexDocument(container.documentBuffer, schema, codec);
  timings.kiwiDecodeMs = Date.now() - decodeStartedAt;

  var normalizeStartedAt = Date.now();
  var tree = buildTree(indexed.nodes);
  var symbols = buildSymbolRegistry(tree);
  // Реестр публичной идентичности свойств компонента. Документного охвата:
  // цепочка `parentPropDefId` уходит из варианта в объявившую его группу
  // состояний, то есть за пределы любого отдельного определения.
  var componentProperties = ComponentProperties.build(tree);
  timings.normalizeMs = Date.now() - normalizeStartedAt;

  var nodeDefinition = schema.require("PixsoNode");
  var blobDefinition = schema.require("Blob");
  var buffer = container.documentBuffer;
  var derivedGuidPathCache = new Map();

  /**
   * Структурное чтение `derivedSymbolData` одного вхождения: только
   * `guidPath` и `visible`. Всё остальное поддерево Kiwi пропускает, не
   * материализуя, — ради этого Direct PIX и существует. Результат
   * кэшируется на вхождение: повторные обращения не перечитывают узел.
   */
  function readDerived(record) {
    var empty = { paths: [], geometry: new Map() };
    if (!record || record.type !== "INSTANCE") return empty;
    if (derivedGuidPathCache.has(record.index)) return derivedGuidPathCache.get(record.index);
    var reader = new Kiwi.ByteReader(buffer, indexed.offsets[record.index]);
    var raw = codec.readMessage(reader, nodeDefinition, {
      only: { PixsoNode: new Set(["derivedSymbolData", "guidPath", "size", "transform"]) },
    });
    var entries = raw.derivedSymbolData || [];
    var paths = [];
    var geometry = new Map();
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var guids = entry && entry.guidPath && entry.guidPath.guids;
      if (!guids || !guids.length) continue;
      var path = [];
      var valid = true;
      for (var g = 0; g < guids.length; g++) {
        var key = guidKey(guids[g]);
        if (!key) { valid = false; break; }
        path.push(key);
      }
      if (!valid || !path.length) continue;
      paths.push(path);
      if (entry.size || entry.transform) {
        geometry.set(path.join("/"), { size: entry.size || null, transform: entry.transform || null });
      }
    }
    var result = { paths: paths, geometry: geometry };
    derivedGuidPathCache.set(record.index, result);
    return result;
  }

  return {
    container: container,
    schema: schema,
    codec: codec,
    header: indexed.header,
    tree: tree,
    symbols: symbols,
    componentProperties: componentProperties,
    nodeCount: indexed.nodes.length,
    blobCount: indexed.blobOffsets.length,
    timings: timings,

    /** Полный разбор узла по его индексу — с пропуском заведомо тяжёлых полей. */
    detail: function (record, options) {
      var reader = new Kiwi.ByteReader(buffer, indexed.offsets[record.index]);
      return codec.readMessage(reader, nodeDefinition, {
        skip: options && options.sourceTextStyle ? TEXT_STYLE_DETAIL_SKIP : DETAIL_SKIP,
      });
    },

    /**
     * Лёгкий индекс фактических путей развёрнутого INSTANCE.
     *
     * `derivedSymbolData` целиком Direct PIX намеренно не материализует: там
     * находится snapshot всего поддерева. Для разрешения старого guidPath
     * нужны только сами `guidPath` его записей. Kiwi позволяет структурно
     * пропустить остальные поля, поэтому этот read не возвращает geometry,
     * paints, text, glyphs и прочий тяжёлый payload. Результат кэшируется на
     * occurrence: повторные override-записи не перечитывают один узел.
     */
    derivedGuidPaths: function (record) {
      return readDerived(record).paths;
    },


    /**
     * Геометрия узлов развёрнутого вхождения — по снимку источника.
     *
     * Замерено на этом документе (70 023 записи у 1200 вхождений): снимок
     * `derivedSymbolData` НЕ является полным состоянием вхождения. В нём
     * всегда есть `guidPath` (100%), иногда `size` (23.1%), `textData`
     * (10.7%) и `transform` (5.6%) — и НЕТ ни `visible`, ни красок, ни
     * клиппинга, ни полей раскладки. Строить на нём визуальный oracle целиком
     * нельзя; доказывать им можно ровно то, что в нём лежит.
     *
     * Возвращает `Map` из `guidPath.join("/")` в `{ size, transform }` для
     * тех записей, где источник эту геометрию зафиксировал.
     */
    derivedGeometry: function (record) {
      return readDerived(record).geometry;
    },

    /** Байты blob по индексу из `vectorNetworkBlob` / `Path.blobIndex`. */
    blob: function (index) {
      if (index === undefined || index === null) return null;
      if (index < 0 || index >= indexed.blobOffsets.length) return null;
      var reader = new Kiwi.ByteReader(buffer, indexed.blobOffsets[index]);
      var blob = codec.readMessage(reader, blobDefinition, {});
      return blob.bytes || null;
    },

    guidKey: guidKey,
  };
}

module.exports = {
  load: load,
  guidKey: guidKey,
  compareSiblings: compareSiblings,
  buildTree: buildTree,
  buildSymbolRegistry: buildSymbolRegistry,
  indexDocument: indexDocument,
  INDEX_FIELDS: INDEX_FIELDS,
  DETAIL_SKIP: DETAIL_SKIP,
  isInternalPage: isInternalPage,
  onInternalCanvas: onInternalCanvas,
  CANONICAL_MISS: CANONICAL_MISS,
  CANONICAL_VIA: CANONICAL_VIA,
  ComponentProperties: ComponentProperties,
};
