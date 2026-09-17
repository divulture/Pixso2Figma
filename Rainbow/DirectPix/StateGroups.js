/**
 * Реестр групп состояний Pixso — источник нативных Figma COMPONENT_SET.
 *
 * В документе Pixso семейство вариантов выглядит так:
 *
 *   FRAME с isStateGroup = true
 *       ├── SYMBOL «size=m, state=default»
 *       ├── SYMBOL «size=m, state=hover»
 *       └── …
 *
 * Схема `.pix` НЕ содержит типа свойства VARIANT: `parentPropDefId` несёт
 * публичную идентичность обычных свойств компонента и координатой варианта не
 * является. Единственный носитель координаты — имя дочернего SYMBOL, а её
 * словарь — поле `stateGroupPropertyValueOrders` самой группы
 * (`PropValueData[]`: property + values в исходном порядке).
 *
 * Поэтому здесь живёт РОВНО ОДИН разбор имени во всём Direct PIX, и его
 * область действия сужена до предела:
 *
 *   разобрать имена прямых SYMBOL-детей узла, у которого структурно
 *   подтверждено isStateGroup = true, и сверить результат со словарём
 *   этой же группы.
 *
 * Имя НЕ используется ни для чего другого: ни для идентичности свойства, ни
 * для сопоставления копий, ни для поиска определения, ни для адресации
 * override, ни для обычной реконструкции компонента. Компонент, названный
 * «State=Hover, Size=Large», но не лежащий в группе состояний, этот модуль
 * не видит вовсе.
 *
 * Группа, которая не разобралась целиком, не чинится и не собирается
 * частично: она получает причину из фиксированного списка и остаётся набором
 * самостоятельных компонентов. Это дешевле любой догадки и, в отличие от
 * догадки, обратимо.
 */
"use strict";

/**
 * Статусы группы. Причина обязана быть причинной: «не удалось» без указания,
 * что именно не сошлось, не позволяет ни починить источник, ни поверить
 * отчёту.
 */
var STATE_GROUP_STATUS = {
  SAFE: "SAFE",
  // У группы нет словаря осей/значений — сверять координату не с чем.
  MISSING_PROPERTY_VALUE_ORDERS: "MISSING_PROPERTY_VALUE_ORDERS",
  NO_VARIANT_MEMBERS: "NO_VARIANT_MEMBERS",
  // Прямой ребёнок группы — не SYMBOL. Вариантом он быть не может.
  NON_SYMBOL_MEMBER: "NON_SYMBOL_MEMBER",
  // Имя участника не раскладывается в пары «ось=значение».
  COORDINATE_PARSE_FAILED: "COORDINATE_PARSE_FAILED",
  UNKNOWN_AXIS: "UNKNOWN_AXIS",
  UNKNOWN_VALUE: "UNKNOWN_VALUE",
  // Участник назвал не все оси группы. Дописать недостающее значение
  // означало бы выдумать состояние, которого в источнике нет.
  MISSING_AXIS: "MISSING_AXIS",
  DUPLICATE_AXIS: "DUPLICATE_AXIS",
  DUPLICATE_COORDINATE: "DUPLICATE_COORDINATE",
  // Ось или значение содержит символ, которым Figma разделяет саму
  // variant-координату (`,` или `=`), либо пусто. Такую координату нативно
  // не выразить — и подменять её транслитерацией нельзя.
  UNSUPPORTED_CHARACTER: "UNSUPPORTED_CHARACTER",
  // Группа состояний внутри группы состояний: в измеренных документах не
  // встречалась, нативного эквивалента не имеет.
  UNSUPPORTED_STRUCTURE: "UNSUPPORTED_STRUCTURE",
};

/** Разделители самой Figma: внутри оси и значения их быть не может. */
var AXIS_SEPARATOR = ",";
var VALUE_SEPARATOR = "=";

/**
 * Разбор имени участника группы состояний.
 *
 * Грамматика выведена из настоящих файлов, а не из соглашения дизайн-системы:
 *
 *   имя      := пара ("," пара)*
 *   пара     := ось "=" значение
 *
 * Обрезается ТОЛЬКО синтаксический пробел вокруг оси и значения: и ось
 * («next/prev month day»), и значение («menu item») в измеренных документах
 * содержат обычные пробелы внутри, и трогать их нельзя. Разделителем пары
 * считается ПЕРВЫЙ `=`: во всех измеренных файлах значений с `=` внутри нет,
 * а если такое встретится, сверка со словарём отклонит группу, а не примет
 * половину имени.
 *
 * Частотный анализ соседей, списки известных значений и любые догадки здесь
 * отсутствуют намеренно.
 */
function parseVariantCoordinate(rawName) {
  var name = String(rawName === undefined || rawName === null ? "" : rawName);
  if (!name.trim()) return { pairs: null, error: STATE_GROUP_STATUS.COORDINATE_PARSE_FAILED };
  var parts = name.split(AXIS_SEPARATOR);
  var pairs = [];
  var seen = Object.create(null);
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    var separator = part.indexOf(VALUE_SEPARATOR);
    if (separator < 0) return { pairs: null, error: STATE_GROUP_STATUS.COORDINATE_PARSE_FAILED };
    var axis = part.slice(0, separator).trim();
    var value = part.slice(separator + 1).trim();
    if (!axis) return { pairs: null, error: STATE_GROUP_STATUS.COORDINATE_PARSE_FAILED };
    if (Object.prototype.hasOwnProperty.call(seen, axis)) {
      return { pairs: null, error: STATE_GROUP_STATUS.DUPLICATE_AXIS };
    }
    seen[axis] = true;
    pairs.push({ axis: axis, value: value });
  }
  if (!pairs.length) return { pairs: null, error: STATE_GROUP_STATUS.COORDINATE_PARSE_FAILED };
  return { pairs: pairs, error: null };
}

/**
 * Строку, которой Figma задаёт variant-координату, можно составить только из
 * фрагментов, не содержащих её собственных разделителей.
 */
function representable(text) {
  var value = String(text === undefined || text === null ? "" : text);
  if (!value.trim()) return false;
  return value.indexOf(AXIS_SEPARATOR) < 0 && value.indexOf(VALUE_SEPARATOR) < 0;
}

/** Каноническое имя варианта: порядок осей — из словаря группы. */
function canonicalVariantName(axes, byAxis) {
  var parts = [];
  for (var i = 0; i < axes.length; i++) {
    parts.push(axes[i].property + VALUE_SEPARATOR + byAxis[axes[i].property]);
  }
  return parts.join(AXIS_SEPARATOR + " ");
}

/**
 * Идентичность координаты варианта, НЕ зависящая от порядка осей.
 *
 * `{size: m, type: primary, state: default}` — это один и тот же вариант,
 * в каком бы порядке источник ни перечислил оси. А объявленный порядок у двух
 * локальных зеркал одного опубликованного набора разный: словарь
 * `stateGroupPropertyValueOrders` у каждого свой.
 *
 * Пока идентичностью было ИМЯ, дедупликация этого не видела, и в один
 * `COMPONENT_SET` попадали два участника с одной координатой:
 *
 *   "size=m, type=primary, state=default"
 *   "type=primary, state=default, size=m"
 *
 * Figma считает такие варианты конфликтующими, помечает набор ошибочным и
 * после этого отказывает `setProperties` у КАЖДОГО его вхождения — молча, с
 * единственным сообщением «Component set has existing errors». На экране это
 * выглядит как «у всех кнопок иконка-умолчание»: не доезжают ни
 * `INSTANCE_SWAP`, ни `BOOLEAN`, ни `TEXT`.
 *
 * Поэтому идентичность считается по отсортированным парам «ось=значение», а
 * порядок остаётся только у ВИДИМОГО имени.
 */
function coordinateIdentity(axes, byAxis) {
  var parts = [];
  for (var i = 0; i < axes.length; i++) {
    parts.push(axes[i].property + VALUE_SEPARATOR + byAxis[axes[i].property]);
  }
  parts.sort();
  return parts.join(AXIS_SEPARATOR + " ");
}

/** Есть ли над записью (не считая её саму) другая группа состояний. */
function insideStateGroup(record) {
  var current = record && record.parent;
  while (current) {
    if (current.isStateGroup) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Словарь группы из `stateGroupPropertyValueOrders`.
 *
 * Возвращает оси В ИСХОДНОМ ПОРЯДКЕ и множества допустимых значений.
 * `aliasProperty`/`aliasValues` не читаются: это отдельная механика Pixso,
 * и подставлять её вместо объявленного имени оси значило бы переименовать
 * ось источника.
 */
function readAxes(detail) {
  var raw = detail && detail.stateGroupPropertyValueOrders;
  if (!raw || !raw.length) return null;
  var axes = [];
  var seen = Object.create(null);
  for (var i = 0; i < raw.length; i++) {
    var property = raw[i] && raw[i].property;
    if (property === undefined || property === null) return null;
    var name = String(property);
    if (Object.prototype.hasOwnProperty.call(seen, name)) return null;
    seen[name] = true;
    var values = Object.create(null);
    var list = (raw[i] && raw[i].values) || [];
    var ordered = [];
    for (var v = 0; v < list.length; v++) {
      var value = String(list[v]);
      if (!Object.prototype.hasOwnProperty.call(values, value)) {
        values[value] = ordered.length;
        ordered.push(value);
      }
    }
    axes.push({ property: name, values: values, order: ordered });
  }
  return axes.length ? axes : null;
}

/**
 * Реестр уровня job.
 *
 * Группа разбирается ЛЕНИВО — когда её участник впервые понадобился сборке
 * определения, — и результат кешируется. Второго обхода документа здесь нет:
 * дорогое чтение (`doc.detail`) выполняется не более одного раза на группу,
 * а групп в измеренных файлах 72–722.
 */

/**
 * Stable family identity for copied Pixso libraries. Local state-group GUIDs
 * change when a design-system component is copied between documents, while
 * componentKey stays stable. We still include a normalized axis schema so two
 * incompatible historical revisions that happen to share componentKey cannot
 * be merged into one Figma ComponentSet. Value order is intentionally ignored
 * for identity: order affects presentation, not parent/child ownership.
 */
function publicationIdentity(group, doc) {
  if (!group) return null;
  var file = group.publishFile ? String(group.publishFile) : "";
  var published = group.publishID ? doc.guidKey(group.publishID) : "";
  if (!file || !published) return null;
  return file + "@" + published;
}

function stableFamilyKey(group, axes, doc) {
  var schema = (axes || []).map(function (axis) {
    return String(axis.property) + "=" + axis.order.slice().sort().join("\u001f");
  }).sort().join("\u001e");
  // D48: the publication tuple is the authoritative cross-local family identity.
  // componentKey remains a fallback for older/private documents that do not
  // carry publication metadata.  The exact axis schema is retained so stale
  // historical revisions cannot be merged merely because they were published
  // under the same library id.
  var published = publicationIdentity(group, doc);
  if (published) return "publish:" + published + "|schema:" + schema;
  var componentKey = group && group.componentKey ? String(group.componentKey) : "";
  if (!componentKey) return "group:" + String(group && group.key || "");
  return "component:" + componentKey + "|schema:" + schema;
}

function createSharedState() {
  return {
    byGroupKey: new Map(),
    stats: {
      groupsEvaluated: 0,
      groupsSafe: 0,
      groupsFallback: 0,
      fallbackByReason: Object.create(null),
      membersEvaluated: 0,
      membersInSafeGroups: 0,
      membersInFallbackGroups: 0,
    },
    samples: [],
    sampleCounts: Object.create(null),
  };
}

function createRegistry(doc, options) {
  options = options || {};
  var sampleLimit = Math.max(0, Number(options.sampleLimit) === 0 ? 0 : (Number(options.sampleLimit) || 8));
  // Состояние уровня job приходит извне ровно так же, как реестры стилей и
  // определений: одна и та же группа обязана быть разобрана один раз на всю
  // миграцию, а не по разу на каждый корень.
  var shared = options.shared || createSharedState();
  var byGroupKey = shared.byGroupKey;
  var stats = shared.stats;
  var samples = shared.samples;
  var sampleCounts = shared.sampleCounts;

  function noteSample(status, group, detail) {
    if (samples.length >= sampleLimit) return;
    var taken = sampleCounts[status] || 0;
    if (taken >= 2) return;
    sampleCounts[status] = taken + 1;
    samples.push({
      status: status,
      groupId: group.key,
      // Имя здесь — только диагностика: ни одно решение по нему не принято.
      groupName: String(group.name || "").slice(0, 80),
      detail: detail === undefined ? null : String(detail).slice(0, 160),
    });
  }

  function reject(group, status, detail) {
    stats.groupsFallback += 1;
    stats.fallbackByReason[status] = (stats.fallbackByReason[status] || 0) + 1;
    stats.membersInFallbackGroups += (group.children || []).length;
    noteSample(status, group, detail);
    var evaluated = {
      groupId: group.key,
      groupName: group.name || "",
      groupComponentKey: group.componentKey || null,
      familyKey: null,
      publicationIdentity: publicationIdentity(group, doc),
      publishFile: group.publishFile || null,
      publishID: group.publishID ? doc.guidKey(group.publishID) : null,
      publishedVersion: group.publishedVersion || null,
      status: status,
      axes: null,
      members: null,
      memberById: null,
    };
    byGroupKey.set(group.key, evaluated);
    return evaluated;
  }

  /**
   * Полная проверка группы. Условия структурные, а не именные, и ни одно из
   * них не «чинится»: несошедшаяся группа получает причину и остаётся
   * набором самостоятельных компонентов.
   */
  function evaluate(group) {
    var cached = byGroupKey.get(group.key);
    if (cached) return cached;
    stats.groupsEvaluated += 1;

    if (group.type !== "FRAME") return reject(group, STATE_GROUP_STATUS.UNSUPPORTED_STRUCTURE, group.type);
    if (insideStateGroup(group)) return reject(group, STATE_GROUP_STATUS.UNSUPPORTED_STRUCTURE, "NESTED_STATE_GROUP");

    var children = group.children || [];
    stats.membersEvaluated += children.length;
    if (!children.length) return reject(group, STATE_GROUP_STATUS.NO_VARIANT_MEMBERS);
    for (var c = 0; c < children.length; c++) {
      if (children[c].type !== "SYMBOL") {
        return reject(group, STATE_GROUP_STATUS.NON_SYMBOL_MEMBER, children[c].type);
      }
      if (children[c].isStateGroup) {
        return reject(group, STATE_GROUP_STATUS.UNSUPPORTED_STRUCTURE, "NESTED_STATE_GROUP");
      }
    }

    var axes = readAxes(doc.detail(group));
    if (!axes) return reject(group, STATE_GROUP_STATUS.MISSING_PROPERTY_VALUE_ORDERS);
    for (var a = 0; a < axes.length; a++) {
      if (!representable(axes[a].property)) {
        return reject(group, STATE_GROUP_STATUS.UNSUPPORTED_CHARACTER, axes[a].property);
      }
      for (var o = 0; o < axes[a].order.length; o++) {
        if (!representable(axes[a].order[o])) {
          return reject(group, STATE_GROUP_STATUS.UNSUPPORTED_CHARACTER,
            axes[a].property + "=" + axes[a].order[o]);
        }
      }
    }

    var members = [];
    var coordinates = Object.create(null);
    for (var m = 0; m < children.length; m++) {
      var member = children[m];
      var parsed = parseVariantCoordinate(member.name);
      if (parsed.error) return reject(group, parsed.error, member.name);

      var byAxis = Object.create(null);
      for (var p = 0; p < parsed.pairs.length; p++) {
        var pair = parsed.pairs[p];
        var axis = null;
        for (var ax = 0; ax < axes.length; ax++) {
          if (axes[ax].property === pair.axis) { axis = axes[ax]; break; }
        }
        if (!axis) return reject(group, STATE_GROUP_STATUS.UNKNOWN_AXIS, member.name + " → " + pair.axis);
        if (!Object.prototype.hasOwnProperty.call(axis.values, pair.value)) {
          return reject(group, STATE_GROUP_STATUS.UNKNOWN_VALUE, member.name + " → " + pair.axis + "=" + pair.value);
        }
        byAxis[pair.axis] = pair.value;
      }
      // Недостающая ось — это не «значение по умолчанию»: в источнике его
      // нет, а Figma без него вариант не разместит.
      if (parsed.pairs.length !== axes.length) {
        return reject(group, STATE_GROUP_STATUS.MISSING_AXIS, member.name);
      }

      var variantName = canonicalVariantName(axes, byAxis);
      // Сверяется ИДЕНТИЧНОСТЬ, а не имя: один и тот же вариант, записанный с
      // другим порядком осей, — это дубль, и внутри одной группы он запрещён.
      var identity = coordinateIdentity(axes, byAxis);
      if (Object.prototype.hasOwnProperty.call(coordinates, identity)) {
        return reject(group, STATE_GROUP_STATUS.DUPLICATE_COORDINATE, variantName);
      }
      coordinates[identity] = true;

      var coordinate = [];
      // Ключ сортировки — позиции значений по осям в исходном порядке.
      // Порядок значений внутри оси задаёт сам источник, а не алфавит.
      var sortKey = [];
      for (var s = 0; s < axes.length; s++) {
        coordinate.push({ axis: axes[s].property, value: byAxis[axes[s].property] });
        sortKey.push(axes[s].values[byAxis[axes[s].property]]);
      }
      members.push({
        definitionId: member.key,
        rawName: String(member.name || ""),
        variantName: variantName,
        coordinateKey: identity,
        coordinate: coordinate,
        sortKey: sortKey,
      });
    }

    members.sort(function (left, right) {
      for (var i = 0; i < left.sortKey.length; i++) {
        if (left.sortKey[i] !== right.sortKey[i]) return left.sortKey[i] - right.sortKey[i];
      }
      return 0;
    });
    var memberById = Object.create(null);
    for (var mm = 0; mm < members.length; mm++) {
      members[mm].order = mm;
      memberById[members[mm].definitionId] = members[mm];
    }

    stats.groupsSafe += 1;
    stats.membersInSafeGroups += members.length;
    var safe = {
      groupId: group.key,
      groupName: group.name || "",
      groupComponentKey: group.componentKey || null,
      // D39: the local state-group is the authoritative parent for materialization.
      // Stable component identity is diagnostic only: copied groups can share it while
      // living in different local GUID spaces used by override paths.
      familyKey: group.key,
      publicationIdentity: publicationIdentity(group, doc),
      publishFile: group.publishFile || null,
      publishID: group.publishID ? doc.guidKey(group.publishID) : null,
      publishedVersion: group.publishedVersion || null,
      stableFamilyKey: stableFamilyKey(group, axes, doc),
      status: STATE_GROUP_STATUS.SAFE,
      axes: axes.map(function (entry) {
        return { property: entry.property, values: entry.order.slice() };
      }),
      members: members,
      memberById: memberById,
    };
    byGroupKey.set(group.key, safe);
    return safe;
  }

  /**
   * Дескриптор нативного варианта для конкретного SYMBOL.
   *
   * Возвращает null для всего, что не является участником безопасной группы
   * состояний: обычный компонент, участник отклонённой группы и любой узел
   * вне групп проходят прежним путём без изменений.
   */
  function memberOf(symbolRecord) {
    if (!symbolRecord || symbolRecord.type !== "SYMBOL") return null;
    var group = symbolRecord.parent;
    if (!group || !group.isStateGroup) return null;
    var evaluated = evaluate(group);
    if (evaluated.status !== STATE_GROUP_STATUS.SAFE) return null;
    var member = evaluated.memberById[symbolRecord.key];
    if (!member) return null;
    return {
      groupId: evaluated.groupId,
      groupName: evaluated.groupName,
      groupComponentKey: evaluated.groupComponentKey,
      familyKey: evaluated.familyKey,
      stableFamilyKey: evaluated.stableFamilyKey || null,
      publicationIdentity: evaluated.publicationIdentity || null,
      publishFile: evaluated.publishFile || null,
      publishID: evaluated.publishID || null,
      publishedVersion: evaluated.publishedVersion || null,
      axisCount: evaluated.axes.length,
      memberCountSource: evaluated.members.length,
      // D42: the receiver can safely decide whether two copied/local state
      // groups are complementary subsets of the same published family only
      // when it knows the COMPLETE source coordinate domain of each local
      // group. This is formal variant data, not a name heuristic.
      familyCoordinates: evaluated.members.map(function (entry) { return entry.coordinateKey; }),
      definitionId: member.definitionId,
      variantName: member.variantName,
      coordinateKey: member.coordinateKey,
      coordinate: member.coordinate,
      order: member.order,
      sortKey: member.sortKey.slice(),
      sourceName: member.rawName,
    };
  }

  /** Статус группы по её узлу — для отчёта о вхождениях вне безопасных групп. */
  function statusOf(groupRecord) {
    if (!groupRecord || !groupRecord.isStateGroup) return null;
    return evaluate(groupRecord).status;
  }

  function report() {
    return {
      groupsEvaluated: stats.groupsEvaluated,
      groupsSafe: stats.groupsSafe,
      groupsFallback: stats.groupsFallback,
      fallbackByReason: stats.fallbackByReason,
      membersEvaluated: stats.membersEvaluated,
      membersInSafeGroups: stats.membersInSafeGroups,
      membersInFallbackGroups: stats.membersInFallbackGroups,
      samples: samples,
    };
  }

  return {
    evaluate: evaluate,
    memberOf: memberOf,
    statusOf: statusOf,
    report: report,
    stats: stats,
  };
}

module.exports = {
  STATE_GROUP_STATUS: STATE_GROUP_STATUS,
  createSharedState: createSharedState,
  parseVariantCoordinate: parseVariantCoordinate,
  canonicalVariantName: canonicalVariantName,
  coordinateIdentity: coordinateIdentity,
  stableFamilyKey: stableFamilyKey,
  createRegistry: createRegistry,
};
