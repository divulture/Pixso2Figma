/**
 * Публичная идентичность свойства компонента Pixso.
 *
 * Важно: сырой `ComponentPropDef.id` НЕ является document-global identity.
 * Один и тот же GUID может повторно использоваться в независимых опубликованных
 * component families. Поэтому реестр хранит определения в формальном namespace
 * владельца (published ComponentSet/component) и разрешает aliases в контексте
 * активного определения.
 */
"use strict";

var PixGuid = require("./PixGuid");

var STATUS = {
  RESOLVED: "RESOLVED",
  MISSING_DEF: "MISSING_DEF",
  DANGLING_PARENT: "DANGLING_PARENT",
  CYCLE: "CYCLE",
  DEPTH_EXCEEDED: "DEPTH_EXCEEDED",
  AMBIGUOUS_DEF: "AMBIGUOUS_DEF",
};

var MAX_DEPTH = 32;

function build(tree) {
  // Legacy global maps are retained only for unambiguous ids/backward
  // compatibility. All migration decisions should prefer scoped accessors.
  var parents = new Map();
  var types = new Map();
  var owners = new Map();
  var definitions = new Map();
  var ambiguousGlobal = new Set();

  // raw def id -> [candidate]
  var candidates = new Map();
  // namespace + raw id -> [candidate]
  var scopedCandidates = new Map();
  var scopedCache = new Map();
  var cache = new Map();

  var stats = {
    definitionsIndexed: 0,
    publicDefinitions: 0,
    localDefinitions: 0,
    nodesDeclaringDefinitions: 0,
    resolutions: 0,
    cacheHits: 0,
    scopedResolutions: 0,
    scopedCacheHits: 0,
    rawIdCollisions: 0,
    rawIdCrossNamespaceCollisions: 0,
    byStatus: Object.create(null),
    maxDepthSeen: 0,
  };

  var records = (tree && tree.records) || [];
  var byKey = (tree && tree.byKey) || new Map();

  function publishIdOf(record) {
    return record && PixGuid.meaningfulGuid(record.publishID);
  }

  /**
   * Formal property namespace. Variant-local definitions belong to their
   * state-group publication, not to a document-global GUID bucket.
   */
  function namespaceOfRecord(record) {
    if (!record) return null;
    var current = record;
    var componentAnchor = null;
    var guard = 0;
    while (current && guard++ < 64) {
      if (current.isStateGroup) {
        var gid = publishIdOf(current);
        if (current.publishFile && gid) return "set:" + current.publishFile + "@" + gid;
        if (current.componentKey) return "set-key:" + current.componentKey + "@" + current.key;
        return "set-local:" + current.key;
      }
      if (!componentAnchor && (current.type === "SYMBOL" || current.componentKey)) componentAnchor = current;
      current = current.parentKey ? byKey.get(current.parentKey) : null;
    }
    var anchor = componentAnchor || record;
    var pid = publishIdOf(anchor);
    if (anchor.publishFile && pid) return "component:" + anchor.publishFile + "@" + pid;
    if (anchor.componentKey) return "component-key:" + anchor.componentKey;
    return "local:" + anchor.key;
  }

  function scopedKey(namespace, id) {
    return (namespace || "") + "\u001f" + id;
  }

  function sameDefinition(a, b) {
    return !!a && !!b && a.id === b.id && a.parentId === b.parentId && a.type === b.type;
  }

  function pushCandidate(map, key, candidate) {
    var list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    list.push(candidate);
  }

  for (var i = 0; i < records.length; i++) {
    var defs = records[i].propDefs;
    if (!defs || !defs.length) continue;
    stats.nodesDeclaringDefinitions += 1;
    var namespace = namespaceOfRecord(records[i]);
    for (var d = 0; d < defs.length; d++) {
      var def = defs[d];
      var id = PixGuid.meaningfulGuid(def.id);
      if (!id) continue;
      var parent = PixGuid.meaningfulGuid(def.parentPropDefId);
      if (parent === id) parent = null;
      var candidate = {
        id: id,
        ownerId: records[i].key,
        namespace: namespace,
        name: def.name === undefined ? "" : String(def.name),
        type: def.type === undefined || def.type === null ? null : def.type,
        parentId: parent || null,
      };
      pushCandidate(candidates, id, candidate);
      pushCandidate(scopedCandidates, scopedKey(namespace, id), candidate);
      stats.definitionsIndexed += 1;
      if (parent) stats.localDefinitions += 1;
      else stats.publicDefinitions += 1;

      if (!definitions.has(id)) {
        definitions.set(id, candidate);
        parents.set(id, candidate.parentId);
        if (candidate.type !== null) types.set(id, candidate.type);
        owners.set(id, candidate.ownerId);
      } else if (!sameDefinition(definitions.get(id), candidate)) {
        ambiguousGlobal.add(id);
      }
    }
  }

  candidates.forEach(function (list) {
    if (list.length <= 1) return;
    var signatures = Object.create(null);
    var namespaces = Object.create(null);
    list.forEach(function (c) {
      signatures[(c.parentId || "") + "|" + (c.type || "")] = true;
      namespaces[c.namespace || ""] = true;
    });
    if (Object.keys(signatures).length > 1) stats.rawIdCollisions += 1;
    if (Object.keys(namespaces).length > 1) stats.rawIdCrossNamespaceCollisions += 1;
  });

  function uniqueScoped(namespace, id) {
    var list = scopedCandidates.get(scopedKey(namespace, id)) || [];
    if (!list.length) return { status: STATUS.MISSING_DEF, candidate: null };
    var first = list[0];
    for (var i = 1; i < list.length; i++) {
      if (!sameDefinition(first, list[i])) return { status: STATUS.AMBIGUOUS_DEF, candidate: null };
    }
    return { status: STATUS.RESOLVED, candidate: first };
  }

  /*
   * Variant-local ComponentPropDef ids are not even unique inside one
   * ComponentSet namespace. Pixso can reuse the same raw alias id on two
   * sibling variants, while one sibling links that alias to the public set
   * property and another sibling carries a stale/root copy of the same id.
   *
   * A componentPropRef belongs to one concrete component definition, so the
   * first hop is formally disambiguated by the definition that owns the ref.
   * Only after that first hop may resolution widen to the set namespace for
   * the public parent. No names/geometry are involved.
   */
  function ownedScoped(namespace, id, ownerId) {
    var list = scopedCandidates.get(scopedKey(namespace, id)) || [];
    if (!list.length) return { status: STATUS.MISSING_DEF, candidate: null };
    if (!ownerId) return uniqueScoped(namespace, id);
    var owned = list.filter(function (candidate) { return candidate.ownerId === ownerId; });
    if (!owned.length) return uniqueScoped(namespace, id);
    var first = owned[0];
    for (var i = 1; i < owned.length; i++) {
      if (!sameDefinition(first, owned[i])) return { status: STATUS.AMBIGUOUS_DEF, candidate: null };
    }
    return { status: STATUS.RESOLVED, candidate: first };
  }

  function publicOfScoped(rawKey, contextOwnerId) {
    var key = PixGuid.meaningfulGuid(rawKey);
    if (!key) return { status: STATUS.MISSING_DEF, publicId: null, depth: 0, namespace: null };
    var context = contextOwnerId ? byKey.get(contextOwnerId) : null;
    var namespace = namespaceOfRecord(context);
    if (!namespace) return publicOf(key);
    // Depth-0 resolution is owner-sensitive: sibling variants may reuse the
    // same raw alias id differently inside one ComponentSet. Cache must carry
    // the concrete owner or one variant would poison another.
    var ck = scopedKey(namespace, key) + "\u001fowner:" + (contextOwnerId || "");
    var cached = scopedCache.get(ck);
    if (cached) { stats.scopedCacheHits += 1; return cached; }
    stats.scopedResolutions += 1;

    var seen = new Set();
    var current = key;
    var depth = 0;
    var result;
    for (;;) {
      // The raw alias at depth 0 is owned by the active component variant.
      // Parent ids live on the ComponentSet/public owner and therefore use
      // namespace-wide uniqueness from depth 1 onward.
      var found = depth === 0 ? ownedScoped(namespace, current, contextOwnerId) : uniqueScoped(namespace, current);
      // Compatibility/fallback for synthetic fixtures and external-library
      // definitions that are not physically nested under the active family:
      // a document-global candidate is usable only when the raw id is itself
      // unambiguous. Cross-family collisions (the D58 bug class) never enter
      // this branch.
      if (found.status === STATUS.MISSING_DEF && !ambiguousGlobal.has(current) && definitions.has(current)) {
        found = { status: STATUS.RESOLVED, candidate: definitions.get(current) };
      }
      if (found.status !== STATUS.RESOLVED || !found.candidate) {
        result = depth === 0
          ? { status: found.status, publicId: null, depth: depth, namespace: namespace }
          : { status: found.status === STATUS.MISSING_DEF ? STATUS.DANGLING_PARENT : found.status,
              publicId: null, depth: depth, namespace: namespace };
        break;
      }
      var parent = found.candidate.parentId;
      if (!parent) {
        result = { status: STATUS.RESOLVED, publicId: current, depth: depth, namespace: namespace };
        if (depth > stats.maxDepthSeen) stats.maxDepthSeen = depth;
        break;
      }
      if (seen.has(parent)) {
        result = { status: STATUS.CYCLE, publicId: null, depth: depth, namespace: namespace };
        break;
      }
      seen.add(current);
      current = parent;
      depth += 1;
      if (depth > MAX_DEPTH) {
        result = { status: STATUS.DEPTH_EXCEEDED, publicId: null, depth: depth, namespace: namespace };
        break;
      }
    }
    stats.byStatus[result.status] = (stats.byStatus[result.status] || 0) + 1;
    scopedCache.set(ck, result);
    return result;
  }

  function definitionOfScoped(rawKey, contextOwnerId) {
    var key = PixGuid.meaningfulGuid(rawKey);
    var context = contextOwnerId ? byKey.get(contextOwnerId) : null;
    var namespace = namespaceOfRecord(context);
    if (!key || !namespace) return definitionOf(key);
    var found = ownedScoped(namespace, key, contextOwnerId);
    return found.status === STATUS.RESOLVED ? found.candidate : null;
  }

  /** Legacy global resolution: only safe when raw id is not ambiguous. */
  function publicOf(rawKey) {
    var key = PixGuid.meaningfulGuid(rawKey);
    if (!key) return { status: STATUS.MISSING_DEF, publicId: null, depth: 0 };
    if (ambiguousGlobal.has(key)) return { status: STATUS.AMBIGUOUS_DEF, publicId: null, depth: 0 };
    var cached = cache.get(key);
    if (cached) { stats.cacheHits += 1; return cached; }
    stats.resolutions += 1;
    var result;
    var seen = null;
    var current = key;
    var depth = 0;
    for (;;) {
      if (ambiguousGlobal.has(current)) {
        result = { status: STATUS.AMBIGUOUS_DEF, publicId: null, depth: depth };
        break;
      }
      if (!parents.has(current)) {
        result = depth === 0
          ? { status: STATUS.MISSING_DEF, publicId: null, depth: depth }
          : { status: STATUS.DANGLING_PARENT, publicId: null, depth: depth };
        break;
      }
      var parent = parents.get(current);
      if (!parent) {
        result = { status: STATUS.RESOLVED, publicId: current, depth: depth };
        if (depth > stats.maxDepthSeen) stats.maxDepthSeen = depth;
        break;
      }
      if (!seen) seen = new Set();
      seen.add(current);
      if (seen.has(parent)) {
        result = { status: STATUS.CYCLE, publicId: null, depth: depth };
        break;
      }
      current = parent;
      depth += 1;
      if (depth > MAX_DEPTH) {
        result = { status: STATUS.DEPTH_EXCEEDED, publicId: null, depth: depth };
        break;
      }
    }
    stats.byStatus[result.status] = (stats.byStatus[result.status] || 0) + 1;
    cache.set(key, result);
    return result;
  }

  function definitionOf(rawKey) {
    var key = PixGuid.meaningfulGuid(rawKey);
    return key && !ambiguousGlobal.has(key) && definitions.has(key) ? definitions.get(key) : null;
  }

  return {
    STATUS: STATUS,
    MAX_DEPTH: MAX_DEPTH,
    publicOf: publicOf,
    publicOfScoped: publicOfScoped,
    namespaceOfOwner: function (ownerId) {
      return namespaceOfRecord(ownerId ? byKey.get(ownerId) : null);
    },
    typeOf: function (rawKey) {
      var meta = definitionOf(rawKey);
      return meta ? meta.type : null;
    },
    typeOfScoped: function (rawKey, contextOwnerId) {
      var meta = definitionOfScoped(rawKey, contextOwnerId);
      return meta ? meta.type : null;
    },
    ownerOf: function (rawKey) {
      var meta = definitionOf(rawKey);
      return meta ? meta.ownerId : null;
    },
    definitionOf: definitionOf,
    definitionOfScoped: definitionOfScoped,
    publicDefinitionOf: function (rawKey) {
      var resolved = publicOf(rawKey);
      return resolved.status === STATUS.RESOLVED && resolved.publicId ? definitionOf(resolved.publicId) : null;
    },
    publicDefinitionOfScoped: function (rawKey, contextOwnerId) {
      var resolved = publicOfScoped(rawKey, contextOwnerId);
      return resolved.status === STATUS.RESOLVED && resolved.publicId
        ? definitionOfScoped(resolved.publicId, contextOwnerId) : null;
    },
    has: function (rawKey) {
      var key = PixGuid.meaningfulGuid(rawKey);
      return !!key && candidates.has(key);
    },
    candidatesOf: function (rawKey) {
      var key = PixGuid.meaningfulGuid(rawKey);
      return key ? (candidates.get(key) || []).slice() : [];
    },
    size: stats.definitionsIndexed,
    stats: stats,
  };
}

module.exports = {
  STATUS: STATUS,
  MAX_DEPTH: MAX_DEPTH,
  build: build,
};
