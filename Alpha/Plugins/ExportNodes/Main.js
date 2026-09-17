/**
 * Portable Exporter — Pixso plugin.
 *
 * Экспортирует выбранные узлы (компонент, Component Set, инстанс, фрейм, экран,
 * множественное выделение) в переносимый JSON-пакет "pixso-portable-package":
 * дерево узлов, определения компонентов, пресеты инстансов, стили, переменные,
 * изображения, ссылки на иконки, шрифты, реакции прототипа, fingerprints и
 * граф зависимостей.
 *
 * Только экспорт. Весь опциональный Pixso API определяется в рантайме
 * (feature detection); отсутствие любой возможности фиксируется диагностикой,
 * а не ошибкой.
 */
(function () {
  "use strict";

  // =========================================================================
  // 1. Константы
  // =========================================================================

  var PLUGIN_NAME = "portable-exporter";
  var PLUGIN_VERSION = "1.0.0";
  var PACKAGE_FORMAT = "pixso-portable-package";
  var SCHEMA_VERSION = "1.0.0";

  var ICON_NAME_PATTERN = /^icons?\s*\//i;
  var MAX_TEXT_OVERRIDES_PER_INSTANCE = 300;
  var MAX_SVG_JOBS = 500;

  var DIAG = {
    MAIN_COMPONENT_UNAVAILABLE: "MAIN_COMPONENT_UNAVAILABLE",
    COMPONENT_SET_UNAVAILABLE: "COMPONENT_SET_UNAVAILABLE",
    PROPERTY_BINDING_LOST: "PROPERTY_BINDING_LOST",
    INSTANCE_OVERRIDE_PARTIAL: "INSTANCE_OVERRIDE_PARTIAL",
    VARIABLE_BINDING_LOST: "VARIABLE_BINDING_LOST",
    VARIABLES_API_UNAVAILABLE: "VARIABLES_API_UNAVAILABLE",
    STYLE_RESOLVED_TO_RAW_VALUE: "STYLE_RESOLVED_TO_RAW_VALUE",
    FONT_UNAVAILABLE: "FONT_UNAVAILABLE",
    REACTION_TARGET_UNRESOLVED: "REACTION_TARGET_UNRESOLVED",
    IMAGE_DATA_UNAVAILABLE: "IMAGE_DATA_UNAVAILABLE",
    UNSUPPORTED_NODE_TYPE: "UNSUPPORTED_NODE_TYPE",
    SNAPSHOT_FALLBACK_USED: "SNAPSHOT_FALLBACK_USED",
    SVG_EXPORT_FAILED: "SVG_EXPORT_FAILED",
    SVG_JOBS_LIMIT: "SVG_JOBS_LIMIT",
    DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
    ICON_ASSET_UNAVAILABLE: "ICON_ASSET_UNAVAILABLE",
    MIXED_VALUE_SKIPPED: "MIXED_VALUE_SKIPPED",
  };

  var DEFAULT_OPTIONS = {
    includeComponentDependencies: true,
    includeStyles: true,
    includeVariables: true,
    includeImages: true,
    includeReactions: true,
    // Нужны для точного визуального переноса в Figma. Выключать можно только
    // для облегчённого технического экспорта библиотеки.
    includeInstanceSubtrees: false,
    visualSnapshotMode: false,
    includeVectorSvg: true,
    includeIconSnapshots: false,
    includePluginData: false,
    prettyJson: true,
  };

  // =========================================================================
  // 2. Базовые утилиты
  // =========================================================================

  function safe(fn, fallback) {
    try {
      var value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch (_error) {
      return fallback;
    }
  }

  function isMixedValue(value) {
    return typeof value === "symbol";
  }

  function numberOr(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  function round2(value) {
    return typeof value === "number" ? Math.round(value * 100) / 100 : value;
  }

  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function assign(target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
        target[key] = source[key];
      }
    }
    return target;
  }

  /** Promise с таймаутом: зависший вызов API не должен вешать весь экспорт. */
  function withTimeout(promise, ms, label) {
    if (typeof setTimeout !== "function") return promise;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          reject(new Error("Timeout " + ms + "ms: " + label));
        }
      }, ms);
      function clear() {
        if (typeof clearTimeout === "function") clearTimeout(timer);
      }
      Promise.resolve(promise).then(
        function (value) {
          if (!done) {
            done = true;
            clear();
            resolve(value);
          }
        },
        function (error) {
          if (!done) {
            done = true;
            clear();
            reject(error);
          }
        }
      );
    });
  }

  /** Глубокая JSON-безопасная копия с ограничением глубины. */
  function sanitizeForJson(value, depth) {
    if (depth === undefined) depth = 5;
    if (value === null || value === undefined) return undefined;
    var t = typeof value;
    if (t === "number") return isFinite(value) ? value : undefined;
    if (t === "string" || t === "boolean") return value;
    if (t === "function" || t === "symbol") return undefined;
    if (depth <= 0) return undefined;
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) {
        var item = sanitizeForJson(value[i], depth - 1);
        if (item !== undefined) arr.push(item);
      }
      return arr;
    }
    if (t === "object") {
      var out = {};
      var keys;
      try {
        keys = Object.keys(value);
      } catch (_e) {
        return undefined;
      }
      for (var k = 0; k < keys.length; k++) {
        var clean = sanitizeForJson(value[keys[k]], depth - 1);
        if (clean !== undefined) out[keys[k]] = clean;
      }
      return out;
    }
    return undefined;
  }

  // =========================================================================
  // 3. Хэши: UTF-8, SHA-256, base64, канонический JSON
  // =========================================================================

  function utf8Bytes(input) {
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var code = input.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        var low = input.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          i += 1;
        }
      }
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return out;
  }

  function utf8FromBytes(bytes) {
    var result = "";
    var i = 0;
    while (i < bytes.length) {
      var b0 = bytes[i];
      var code;
      if (b0 < 0x80) {
        code = b0;
        i += 1;
      } else if (b0 < 0xe0) {
        code = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        i += 2;
      } else if (b0 < 0xf0) {
        code = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
        i += 3;
      } else {
        code =
          ((b0 & 0x07) << 18) |
          ((bytes[i + 1] & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f);
        i += 4;
      }
      if (code > 0xffff) {
        code -= 0x10000;
        result += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
      } else {
        result += String.fromCharCode(code);
      }
    }
    return result;
  }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Hex(input) {
    var data = typeof input === "string" ? utf8Bytes(input) : input;
    var len = data.length;
    var bitLenHi = Math.floor((len * 8) / 0x100000000);
    var bitLenLo = (len * 8) >>> 0;
    var paddedLen = ((((len + 8) >> 6) + 1) << 6);
    var bytes = new Array(paddedLen);
    var i;
    for (i = 0; i < paddedLen; i++) bytes[i] = 0;
    for (i = 0; i < len; i++) bytes[i] = data[i] & 0xff;
    bytes[len] = 0x80;
    bytes[paddedLen - 8] = (bitLenHi >>> 24) & 0xff;
    bytes[paddedLen - 7] = (bitLenHi >>> 16) & 0xff;
    bytes[paddedLen - 6] = (bitLenHi >>> 8) & 0xff;
    bytes[paddedLen - 5] = bitLenHi & 0xff;
    bytes[paddedLen - 4] = (bitLenLo >>> 24) & 0xff;
    bytes[paddedLen - 3] = (bitLenLo >>> 16) & 0xff;
    bytes[paddedLen - 2] = (bitLenLo >>> 8) & 0xff;
    bytes[paddedLen - 1] = bitLenLo & 0xff;

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);

    for (var offset = 0; offset < paddedLen; offset += 64) {
      for (i = 0; i < 16; i++) {
        var j = offset + i * 4;
        w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
      }
      for (i = 16; i < 64; i++) {
        var w15 = w[i - 15];
        var w2 = w[i - 2];
        var s0w = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
        var s1w = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0w + w[i - 7] + s1w) >>> 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var s1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
        var s0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var temp2 = (s0 + maj) >>> 0;
        hh = g; g = f; f = e;
        e = (d + temp1) >>> 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }

    var hex = "";
    for (i = 0; i < 8; i++) {
      var word = h[i];
      for (var shift = 28; shift >= 0; shift -= 4) {
        hex += ((word >>> shift) & 0xf).toString(16);
      }
    }
    return hex;
  }

  function shortHash(input, length) {
    return sha256Hex(String(input)).slice(0, length || 8);
  }

  var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64FromBytes(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64_ALPHABET[b0 >> 2];
      out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
      out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : "=";
    }
    return out;
  }

  function normalizeNumber(value) {
    if (typeof value !== "number" || !isFinite(value)) return 0;
    var rounded = Math.round(value * 10000) / 10000;
    return rounded === 0 ? 0 : rounded;
  }

  /**
   * Детерминированная сериализация: ключи объектов сортируются, числа
   * нормализуются, undefined выбрасывается. Порядок массивов сохраняется.
   */
  function canonicalStringify(value) {
    if (value === null || value === undefined) return "null";
    var t = typeof value;
    if (t === "number") return JSON.stringify(normalizeNumber(value));
    if (t === "string" || t === "boolean") return JSON.stringify(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) parts.push(canonicalStringify(value[i]));
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      var keys = [];
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) keys.push(key);
      }
      keys.sort();
      var out = [];
      for (var k = 0; k < keys.length; k++) {
        out.push(JSON.stringify(keys[k]) + ":" + canonicalStringify(value[keys[k]]));
      }
      return "{" + out.join(",") + "}";
    }
    return "null";
  }

  function hashCanonical(value) {
    return "sha256:" + sha256Hex(canonicalStringify(value));
  }

  // =========================================================================
  // 4. Имена
  // =========================================================================

  function slugify(value) {
    var slug = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "node";
  }

  /** "Icon / Arrow_Left.svg" → "arrow-left" */
  function normalizeIconName(rawName) {
    var name = String(rawName || "").trim();
    name = name.replace(ICON_NAME_PATTERN, "");
    name = name.replace(/\.svg$/i, "");
    name = name.toLowerCase();
    name = name.replace(/[\s_]+/g, "-");
    name = name.replace(/\/+/g, "-");
    name = name.replace(/-+/g, "-");
    name = name.replace(/^-+|-+$/g, "");
    return name;
  }

  /** "Label#12:34" → "Label" (суффикс Pixso нестабилен между файлами). */
  function stripPropertySuffix(rawName) {
    return String(rawName || "").replace(/#\d+:\d+$/, "");
  }

  /** "State=Hover, Size=M" → { State: "Hover", Size: "M" } */
  function parseVariantName(name) {
    var result = {};
    var parts = String(name || "").split(",");
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq > 0) {
        var key = parts[i].slice(0, eq).trim();
        var value = parts[i].slice(eq + 1).trim();
        if (key) result[key] = value;
      }
    }
    return result;
  }

  // =========================================================================
  // 5. Диагностика
  // =========================================================================

  function createDiagnostics(target) {
    var items = target || [];
    var seen = {};

    function add(code, severity, stage, message, extra) {
      var entry = {
        code: code,
        severity: severity,
        stage: stage,
        message: message,
      };
      if (extra) {
        if (extra.portableId) entry.portableId = extra.portableId;
        if (extra.nodeName) entry.nodeName = extra.nodeName;
        if (extra.fallback) entry.fallback = extra.fallback;
      }
      var key = [code, severity, stage, entry.portableId || "", entry.nodeName || "", message].join("|");
      if (seen[key]) return;
      seen[key] = true;
      items.push(entry);
    }

    return {
      items: items,
      add: add,
      info: function (code, stage, message, extra) { add(code, "INFO", stage, message, extra); },
      warn: function (code, stage, message, extra) { add(code, "WARNING", stage, message, extra); },
      error: function (code, stage, message, extra) { add(code, "ERROR", stage, message, extra); },
    };
  }

  // =========================================================================
  // 6. Контекст экспорта, portable ID, рёбра графа
  // =========================================================================

  function detectFeatures(api) {
    var variables = api && api.variables;
    return {
      selectionChangeEvent: !!(api && typeof api.on === "function"),
      getNodeById: !!(api && typeof api.getNodeById === "function"),
      getStyleById: !!(api && typeof api.getStyleById === "function"),
      localPaintStyles: !!(api && typeof api.getLocalPaintStyles === "function"),
      localTextStyles: !!(api && typeof api.getLocalTextStyles === "function"),
      localEffectStyles: !!(api && typeof api.getLocalEffectStyles === "function"),
      imageBytes: !!(api && typeof api.getImageByHash === "function"),
      variablesApi: !!(
        variables &&
        (typeof variables.getVariableById === "function" ||
          typeof variables.getVariableByIdAsync === "function")
      ),
      notify: !!(api && typeof api.notify === "function"),
    };
  }

  function buildLocalStyleIndex(api) {
    var index = {};
    var lists = [
      safe(function () { return typeof api.getLocalPaintStyles === "function" ? api.getLocalPaintStyles() : []; }, []),
      safe(function () { return typeof api.getLocalTextStyles === "function" ? api.getLocalTextStyles() : []; }, []),
      safe(function () { return typeof api.getLocalEffectStyles === "function" ? api.getLocalEffectStyles() : []; }, []),
    ];
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i] || [];
      for (var s = 0; s < list.length; s++) {
        if (list[s] && list[s].id) index[list[s].id] = list[s];
      }
    }
    return index;
  }

  function createEmptyPackage() {
    return {
      format: PACKAGE_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportMode: "FULL",
      createdAt: new Date().toISOString(),
      source: { pluginVersion: PLUGIN_VERSION },
      roots: [],
      nodes: {},
      components: {},
      componentSets: {},
      instances: {},
      styles: {},
      variableCollections: {},
      variables: {},
      images: {},
      svgAssets: {},
      iconDependencies: {},
      fonts: [],
      reactions: [],
      dependencies: { edges: [], order: [] },
      fingerprints: {},
      diagnostics: [],
    };
  }

  function createExportContext(api, options, collectBinary) {
    var pkg = createEmptyPackage();
    var resolved = assign(assign({}, DEFAULT_OPTIONS), options || {});
    var fileKey = safe(function () { return api.fileKey; }, null) ||
      safe(function () { return api.root.id; }, null) || "local-file";

    pkg.source.fileKey = fileKey;
    pkg.source.fileName = safe(function () { return api.root.name; }, "Untitled");
    pkg.source.pageName = safe(function () { return api.currentPage.name; }, undefined);
    pkg.source.pixsoApiVersion = safe(function () { return api.apiVersion; }, undefined);

    return {
      api: api,
      features: detectFeatures(api),
      options: resolved,
      collectBinary: collectBinary !== false,
      pkg: pkg,
      diag: createDiagnostics(pkg.diagnostics),
      fileKey: fileKey,
      localStyleIndex: buildLocalStyleIndex(api),
      nodeIds: {},
      componentIds: {},
      componentSetIds: {},
      styleIds: {},
      variableIds: {},
      collectionIds: {},
      imageIds: {},
      svgHashToAsset: {},
      usedPortableIds: {},
      entityStack: [],
      propertyMapStack: [],
      componentStack: {},
      pendingReactions: [],
      pendingImages: [],
      pendingVariables: [],
      svgJobs: [],
      svgJobsCapped: false,
      svgFormatPreference: null,
      fontUsage: {},
      edgeSeen: {},
      onProgress: null,
    };
  }

  function reportProgress(ctx, stage) {
    if (typeof ctx.onProgress === "function") {
      try {
        ctx.onProgress(stage);
      } catch (_e) { /* ignore */ }
    }
  }

  function makePortableId(ctx, prefix, name, pixsoId) {
    var base = prefix + ":" + slugify(name) + "-" + shortHash(ctx.fileKey + "|" + String(pixsoId), 8);
    var id = base;
    var counter = 2;
    while (ctx.usedPortableIds[id] && ctx.usedPortableIds[id] !== String(pixsoId)) {
      id = base + "-" + counter;
      counter += 1;
    }
    ctx.usedPortableIds[id] = String(pixsoId);
    return id;
  }

  /** Ранее импортированные плагином узлы сохраняют свой portableId. */
  function reusablePortableId(node, prefix) {
    var stored = safe(function () {
      return typeof node.getPluginData === "function" ? node.getPluginData("portableComponentId") : "";
    }, "");
    if (stored && stored.indexOf(prefix + ":") === 0) return stored;
    return null;
  }

  function currentEntity(ctx) {
    return ctx.entityStack.length ? ctx.entityStack[ctx.entityStack.length - 1] : null;
  }

  function addEdge(ctx, from, to, relation) {
    if (!from || !to || from === to) return;
    var key = from + ">" + to + ">" + relation;
    if (ctx.edgeSeen[key]) return;
    ctx.edgeSeen[key] = true;
    ctx.pkg.dependencies.edges.push({ from: from, to: to, relation: relation });
  }

  // =========================================================================
  // 7. Заливки, эффекты, геометрия
  // =========================================================================

  function serializeColor(color) {
    if (!isObject(color)) return undefined;
    var out = {
      r: round2(numberOr(color.r, 0)),
      g: round2(numberOr(color.g, 0)),
      b: round2(numberOr(color.b, 0)),
    };
    if (typeof color.a === "number") out.a = round2(color.a);
    return out;
  }

  function serializePaint(paint, ctx) {
    if (!isObject(paint) || typeof paint.type !== "string") return null;
    var out = { type: paint.type };
    if (paint.visible === false) out.visible = false;
    if (typeof paint.opacity === "number" && paint.opacity !== 1) out.opacity = round2(paint.opacity);
    if (typeof paint.blendMode === "string" && paint.blendMode !== "NORMAL") out.blendMode = paint.blendMode;

    if (paint.type === "SOLID") {
      out.color = serializeColor(paint.color) || { r: 0, g: 0, b: 0 };
      return out;
    }
    if (paint.type.indexOf("GRADIENT_") === 0) {
      var stops = [];
      var rawStops = safe(function () { return paint.gradientStops; }, []) || [];
      for (var i = 0; i < rawStops.length; i++) {
        stops.push({
          position: round2(numberOr(rawStops[i].position, 0)),
          color: serializeColor(rawStops[i].color) || { r: 0, g: 0, b: 0, a: 1 },
        });
      }
      out.gradientStops = stops;
      var transform = sanitizeForJson(safe(function () { return paint.gradientTransform; }, undefined), 3);
      if (transform) out.gradientTransform = transform;
      return out;
    }
    if (paint.type === "IMAGE") {
      var hash = safe(function () { return paint.imageHash; }, null);
      if (hash && ctx) out.imageRef = ensureImage(ctx, hash);
      if (typeof paint.scaleMode === "string") out.scaleMode = paint.scaleMode;
      if (typeof paint.scalingFactor === "number") out.scalingFactor = round2(paint.scalingFactor);
      if (typeof paint.rotation === "number" && paint.rotation !== 0) out.rotation = round2(paint.rotation);
      var imageTransform = sanitizeForJson(safe(function () { return paint.imageTransform; }, undefined), 3);
      if (imageTransform) out.imageTransform = imageTransform;
      return out;
    }
    if (paint.type === "VIDEO") {
      out.type = "UNSUPPORTED";
      out.originalType = "VIDEO";
      return out;
    }
    return out;
  }

  function serializePaintList(paints, ctx) {
    if (isMixedValue(paints)) return undefined;
    if (!paints) return undefined;
    // Пустой массив — значимое значение: узел прозрачен. Нельзя смешивать его
    // с «API не вернул поле», иначе Figma оставляет дефолтную белую заливку.
    if (!paints.length) return [];
    var out = [];
    for (var i = 0; i < paints.length; i++) {
      var paint = serializePaint(paints[i], ctx);
      if (paint) out.push(paint);
    }
    return out;
  }

  function serializeEffects(effects) {
    if (!effects || !effects.length) return undefined;
    var out = [];
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      if (!isObject(effect) || typeof effect.type !== "string") continue;
      var entry = { type: effect.type };
      if (effect.visible === false) entry.visible = false;
      if (typeof effect.radius === "number") entry.radius = round2(effect.radius);
      if (typeof effect.spread === "number" && effect.spread !== 0) entry.spread = round2(effect.spread);
      var color = serializeColor(effect.color);
      if (color) entry.color = color;
      if (isObject(effect.offset)) {
        entry.offset = { x: round2(numberOr(effect.offset.x, 0)), y: round2(numberOr(effect.offset.y, 0)) };
      }
      if (typeof effect.blendMode === "string" && effect.blendMode !== "NORMAL") entry.blendMode = effect.blendMode;
      if (typeof effect.showShadowBehindNode === "boolean") entry.showShadowBehindNode = effect.showShadowBehindNode;
      out.push(entry);
    }
    return out.length ? out : undefined;
  }

  function readGeometry(node, ctx) {
    var geometry = {};
    var fillsRaw = safe(function () { return node.fills; }, undefined);
    if (isMixedValue(fillsRaw)) {
      ctx.diag.info(DIAG.MIXED_VALUE_SKIPPED, "serialize", "Смешанные заливки пропущены: " + node.name, { nodeName: node.name });
    } else {
      var fills = serializePaintList(fillsRaw, ctx);
      if (fills !== undefined) geometry.fills = fills;
    }
    var strokesRaw = safe(function () { return node.strokes; }, undefined);
    var strokes = serializePaintList(strokesRaw, ctx);
    if (strokes !== undefined) geometry.strokes = strokes;

    var strokeWeight = safe(function () { return node.strokeWeight; }, undefined);
    // 0 тоже значим, если stroke paint есть: иначе Figma
    // оставит дефолтную толщину 1px и покажет лишнюю обводку.
    var hasStrokePaint = !!(strokesRaw && typeof strokesRaw.length === "number" && strokesRaw.length);
    if (typeof strokeWeight === "number" && (strokeWeight !== 0 || hasStrokePaint)) {
      geometry.strokeWeight = round2(strokeWeight);
    }
    var individualStrokeKeys = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
    for (var sw = 0; sw < individualStrokeKeys.length; sw++) {
      var individualWeight = safe(function () { return node[individualStrokeKeys[sw]]; }, undefined);
      if (typeof individualWeight === "number") geometry[individualStrokeKeys[sw]] = round2(individualWeight);
    }
    var strokeAlign = safe(function () { return node.strokeAlign; }, undefined);
    if (typeof strokeAlign === "string") geometry.strokeAlign = strokeAlign;
    var strokeCap = safe(function () { return node.strokeCap; }, undefined);
    if (typeof strokeCap === "string" && strokeCap !== "NONE") geometry.strokeCap = strokeCap;
    var strokeJoin = safe(function () { return node.strokeJoin; }, undefined);
    if (typeof strokeJoin === "string" && strokeJoin !== "MITER") geometry.strokeJoin = strokeJoin;
    var strokeMiterLimit = safe(function () { return node.strokeMiterLimit; }, undefined);
    if (typeof strokeMiterLimit === "number") geometry.strokeMiterLimit = round2(strokeMiterLimit);
    var dashPattern = safe(function () { return node.dashPattern; }, undefined);
    if (dashPattern && dashPattern.length) geometry.dashPattern = sanitizeForJson(dashPattern, 2);

    return Object.keys(geometry).length ? geometry : undefined;
  }

  function readCorners(node) {
    var corners = {};
    var cornerRadius = safe(function () { return node.cornerRadius; }, undefined);
    if (typeof cornerRadius === "number" && cornerRadius !== 0) corners.cornerRadius = round2(cornerRadius);
    var radiusKeys = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
    var radiusValues = {}, hasIndividualRadius = false;
    for (var i = 0; i < radiusKeys.length; i++) {
      var radiusValue = safe(function () { return node[radiusKeys[i]]; }, undefined);
      if (typeof radiusValue === "number") {
        radiusValues[radiusKeys[i]] = round2(radiusValue);
        if (radiusValue !== 0) hasIndividualRadius = true;
      }
    }
    if (hasIndividualRadius) {
      for (var r = 0; r < radiusKeys.length; r++) {
        if (radiusValues[radiusKeys[r]] !== undefined) corners[radiusKeys[r]] = radiusValues[radiusKeys[r]];
      }
    }
    var cornerSmoothing = safe(function () { return node.cornerSmoothing; }, undefined);
    if (typeof cornerSmoothing === "number" && cornerSmoothing !== 0) corners.cornerSmoothing = round2(cornerSmoothing);
    // Если все радиусы равны cornerRadius, индивидуальные не дублируем
    if (
      corners.cornerRadius !== undefined &&
      corners.topLeftRadius === corners.cornerRadius &&
      corners.topRightRadius === corners.cornerRadius &&
      corners.bottomLeftRadius === corners.cornerRadius &&
      corners.bottomRightRadius === corners.cornerRadius
    ) {
      delete corners.topLeftRadius;
      delete corners.topRightRadius;
      delete corners.bottomLeftRadius;
      delete corners.bottomRightRadius;
    }
    return Object.keys(corners).length ? corners : undefined;
  }

  // =========================================================================
  // 8. Стили, переменные, изображения
  // =========================================================================

  function ensureStyle(ctx, styleId, kind) {
    if (!ctx.options.includeStyles) return undefined;
    if (!styleId || typeof styleId !== "string") return undefined;
    if (ctx.styleIds[styleId]) return ctx.styleIds[styleId];

    var style = ctx.localStyleIndex[styleId] ||
      safe(function () {
        return typeof ctx.api.getStyleById === "function" ? ctx.api.getStyleById(styleId) : null;
      }, null);

    if (!style) {
      ctx.diag.info(
        DIAG.STYLE_RESOLVED_TO_RAW_VALUE,
        "styles",
        "Стиль " + styleId + " не удалось прочитать; значения сохранены на узле",
        { fallback: "raw values on node" }
      );
      return undefined;
    }

    var portableId = makePortableId(ctx, "style", style.name, styleId);
    ctx.styleIds[styleId] = portableId;

    var entry = {
      portableId: portableId,
      styleType: String(style.type || kind || "PAINT"),
      name: String(style.name || "style"),
    };
    var description = safe(function () { return style.description; }, "");
    if (description) entry.description = description;
    var key = safe(function () { return style.key; }, undefined);
    if (key) entry.key = key;
    if (safe(function () { return style.remote; }, false) === true) entry.remote = true;

    var paints = serializePaintList(safe(function () { return style.paints; }, undefined), ctx);
    if (paints) entry.paints = paints;
    var effects = serializeEffects(safe(function () { return style.effects; }, undefined));
    if (effects) entry.effects = effects;

    var fontName = safe(function () { return style.fontName; }, undefined);
    if (isObject(fontName) || typeof style.fontSize === "number") {
      var textProps = {};
      if (isObject(fontName)) textProps.fontName = { family: fontName.family, style: fontName.style };
      if (typeof style.fontSize === "number") textProps.fontSize = round2(style.fontSize);
      var letterSpacing = sanitizeForJson(safe(function () { return style.letterSpacing; }, undefined), 2);
      if (letterSpacing !== undefined) textProps.letterSpacing = letterSpacing;
      var lineHeight = sanitizeForJson(safe(function () { return style.lineHeight; }, undefined), 2);
      if (lineHeight !== undefined) textProps.lineHeight = lineHeight;
      var textCase = safe(function () { return style.textCase; }, undefined);
      if (typeof textCase === "string" && textCase !== "ORIGINAL") textProps.textCase = textCase;
      var textDecoration = safe(function () { return style.textDecoration; }, undefined);
      if (typeof textDecoration === "string" && textDecoration !== "NONE") textProps.textDecoration = textDecoration;
      if (typeof style.paragraphSpacing === "number" && style.paragraphSpacing !== 0) {
        textProps.paragraphSpacing = round2(style.paragraphSpacing);
      }
      if (Object.keys(textProps).length) entry.textProps = textProps;
    }

    ctx.pkg.styles[portableId] = entry;
    var entity = currentEntity(ctx);
    if (entity) addEdge(ctx, entity, portableId, "USES_STYLE");
    return portableId;
  }

  function readStyleRefs(node, ctx) {
    var refs = {};
    var fillStyleId = safe(function () { return node.fillStyleId; }, undefined);
    if (typeof fillStyleId === "string" && fillStyleId) {
      var fillRef = ensureStyle(ctx, fillStyleId, "PAINT");
      if (fillRef) refs.fill = fillRef;
    }
    var strokeStyleId = safe(function () { return node.strokeStyleId; }, undefined);
    if (typeof strokeStyleId === "string" && strokeStyleId) {
      var strokeRef = ensureStyle(ctx, strokeStyleId, "PAINT");
      if (strokeRef) refs.stroke = strokeRef;
    }
    var effectStyleId = safe(function () { return node.effectStyleId; }, undefined);
    if (typeof effectStyleId === "string" && effectStyleId) {
      var effectRef = ensureStyle(ctx, effectStyleId, "EFFECT");
      if (effectRef) refs.effect = effectRef;
    }
    var textStyleId = safe(function () { return node.textStyleId; }, undefined);
    if (typeof textStyleId === "string" && textStyleId) {
      var textRef = ensureStyle(ctx, textStyleId, "TEXT");
      if (textRef) refs.text = textRef;
    }
    return Object.keys(refs).length ? refs : undefined;
  }

  function ensureImage(ctx, imageHash) {
    if (ctx.imageIds[imageHash]) return ctx.imageIds[imageHash];
    var portableId = "image:" + shortHash(imageHash, 10);
    ctx.imageIds[imageHash] = portableId;
    ctx.pkg.images[portableId] = {
      portableId: portableId,
      sourcePixsoHash: imageHash,
      contentHash: "pixso:" + imageHash,
    };
    ctx.pendingImages.push(imageHash);
    var entity = currentEntity(ctx);
    if (entity) addEdge(ctx, entity, portableId, "USES_IMAGE");
    return portableId;
  }

  function ensureVariable(ctx, variableId) {
    if (!variableId) return undefined;
    if (ctx.variableIds[variableId]) return ctx.variableIds[variableId];
    var portableId = "variable:" + shortHash(String(variableId), 10);
    ctx.variableIds[variableId] = portableId;
    ctx.pkg.variables[portableId] = {
      portableId: portableId,
      sourcePixsoId: String(variableId),
    };
    ctx.pendingVariables.push(String(variableId));
    var entity = currentEntity(ctx);
    if (entity) addEdge(ctx, entity, portableId, "USES_VARIABLE");
    return portableId;
  }

  function collectBoundVariables(node, ctx) {
    if (!ctx.options.includeVariables) return undefined;
    var bound = safe(function () { return node.boundVariables; }, undefined);
    if (!isObject(bound)) return undefined;
    var out = {};
    for (var field in bound) {
      if (!Object.prototype.hasOwnProperty.call(bound, field)) continue;
      var value = bound[field];
      if (Array.isArray(value)) {
        var refs = [];
        for (var i = 0; i < value.length; i++) {
          var aliasId = isObject(value[i]) ? value[i].id : undefined;
          var ref = ensureVariable(ctx, aliasId);
          if (ref) refs.push(ref);
        }
        if (refs.length) out[field] = refs;
      } else if (isObject(value)) {
        var singleRef = ensureVariable(ctx, value.id);
        if (singleRef) out[field] = singleRef;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  // =========================================================================
  // 9. Layout и общие свойства узла
  // =========================================================================

  function readAutoLayout(node) {
    var layoutMode = safe(function () { return node.layoutMode; }, undefined);
    if (layoutMode !== "HORIZONTAL" && layoutMode !== "VERTICAL") return undefined;
    var out = { layoutMode: layoutMode };
    var stringKeys = ["layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems"];
    for (var i = 0; i < stringKeys.length; i++) {
      var sv = safe(function () { return node[stringKeys[i]]; }, undefined);
      if (typeof sv === "string") out[stringKeys[i]] = sv;
    }
    var numberKeys = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing", "counterAxisSpacing"];
    for (var n = 0; n < numberKeys.length; n++) {
      var nv = safe(function () { return node[numberKeys[n]]; }, undefined);
      if (typeof nv === "number" && nv !== 0) out[numberKeys[n]] = round2(nv);
    }
    var boolKeys = ["itemReverseZIndex", "strokesIncludedInLayout"];
    for (var b = 0; b < boolKeys.length; b++) {
      var bv = safe(function () { return node[boolKeys[b]]; }, undefined);
      if (bv === true) out[boolKeys[b]] = true;
    }
    return out;
  }

  function readChildLayout(node) {
    var out = {};
    var layoutAlign = safe(function () { return node.layoutAlign; }, undefined);
    if (typeof layoutAlign === "string" && layoutAlign !== "INHERIT") out.layoutAlign = layoutAlign;
    var layoutGrow = safe(function () { return node.layoutGrow; }, undefined);
    if (typeof layoutGrow === "number" && layoutGrow !== 0) out.layoutGrow = layoutGrow;
    var layoutPositioning = safe(function () { return node.layoutPositioning; }, undefined);
    if (typeof layoutPositioning === "string" && layoutPositioning !== "AUTO") out.layoutPositioning = layoutPositioning;
    var sizingH = safe(function () { return node.layoutSizingHorizontal; }, undefined);
    if (typeof sizingH === "string") out.layoutSizingHorizontal = sizingH;
    var sizingV = safe(function () { return node.layoutSizingVertical; }, undefined);
    if (typeof sizingV === "string") out.layoutSizingVertical = sizingV;
    var boundsKeys = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
    for (var i = 0; i < boundsKeys.length; i++) {
      var value = safe(function () { return node[boundsKeys[i]]; }, undefined);
      if (typeof value === "number") out[boundsKeys[i]] = round2(value);
    }
    // Resolved instance в Pixso иногда оставляет унаследованный min/max,
    // который противоречит уже отрисованному size. Перенос такого bound
    // в Figma меняет snapshot-геометрию (32px становится min 40px).
    var width = safe(function () { return node.width; }, undefined);
    var height = safe(function () { return node.height; }, undefined);
    var epsilon = 0.05;
    if (typeof width === "number") {
      if (typeof out.minWidth === "number" && out.minWidth > width + epsilon) delete out.minWidth;
      if (typeof out.maxWidth === "number" && out.maxWidth < width - epsilon) delete out.maxWidth;
    }
    if (typeof height === "number") {
      if (typeof out.minHeight === "number" && out.minHeight > height + epsilon) delete out.minHeight;
      if (typeof out.maxHeight === "number" && out.maxHeight < height - epsilon) delete out.maxHeight;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function readConstraints(node) {
    var constraints = safe(function () { return node.constraints; }, undefined);
    if (isObject(constraints) && (constraints.horizontal || constraints.vertical)) {
      var out = {};
      if (typeof constraints.horizontal === "string") out.horizontal = constraints.horizontal;
      if (typeof constraints.vertical === "string") out.vertical = constraints.vertical;
      return out;
    }
    var h = safe(function () { return node.constraintHorizontal; }, undefined);
    var v = safe(function () { return node.constraintVertical; }, undefined);
    if (typeof h === "string" || typeof v === "string") {
      var alt = {};
      if (typeof h === "string") alt.horizontal = h;
      if (typeof v === "string") alt.vertical = v;
      return alt;
    }
    return undefined;
  }

  function readPluginData(node) {
    var keys = safe(function () {
      return typeof node.getPluginDataKeys === "function" ? node.getPluginDataKeys() : [];
    }, []);
    if (!keys || !keys.length) return undefined;
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var value = safe(function () {
        return node.getPluginData(keys[i]);
      }, "");
      if (value) out[keys[i]] = value;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Общие свойства любого SceneNode. Регистрирует узел в pkg.nodes и вернёт
   * portable-объект; тип и специфику дозаполняет вызывающий сериализатор.
   */
  function buildBaseNode(node, ctx, type) {
    var portableId = makePortableId(ctx, "node", node.name, node.id);
    ctx.nodeIds[node.id] = portableId;

    var portable = {
      id: portableId,
      type: type || node.type,
      name: String(node.name || ""),
    };

    if (safe(function () { return node.visible; }, true) === false) portable.visible = false;
    if (safe(function () { return node.locked; }, false) === true) portable.locked = true;
    var opacity = safe(function () { return node.opacity; }, undefined);
    if (typeof opacity === "number" && opacity !== 1) portable.opacity = round2(opacity);
    var blendMode = safe(function () { return node.blendMode; }, undefined);
    if (typeof blendMode === "string" && blendMode !== "NORMAL" && blendMode !== "PASS_THROUGH") {
      portable.blendMode = blendMode;
    }
    var rotation = safe(function () { return node.rotation; }, undefined);
    if (typeof rotation === "number" && rotation !== 0) portable.rotation = round2(rotation);
    if (safe(function () { return node.isMask; }, false) === true) portable.isMask = true;

    var x = safe(function () { return node.x; }, undefined);
    var y = safe(function () { return node.y; }, undefined);
    if (typeof x === "number" || typeof y === "number") {
      portable.position = { x: round2(numberOr(x, 0)), y: round2(numberOr(y, 0)) };
    }
    var width = safe(function () { return node.width; }, undefined);
    var height = safe(function () { return node.height; }, undefined);
    if (typeof width === "number" || typeof height === "number") {
      portable.size = { width: round2(numberOr(width, 0)), height: round2(numberOr(height, 0)) };
    }

    var constraints = readConstraints(node);
    if (constraints) portable.constraints = constraints;
    var autoLayout = readAutoLayout(node);
    if (autoLayout) portable.autoLayout = autoLayout;
    var childLayout = readChildLayout(node);
    if (childLayout) portable.childLayout = childLayout;
    var clipsContent = safe(function () { return node.clipsContent; }, undefined);
    if (typeof clipsContent === "boolean") portable.clipsContent = clipsContent;

    var geometry = readGeometry(node, ctx);
    if (geometry) portable.geometry = geometry;
    var corners = readCorners(node);
    if (corners) portable.corners = corners;
    var effects = serializeEffects(safe(function () { return node.effects; }, undefined));
    if (effects) portable.effects = effects;
    var styleRefs = readStyleRefs(node, ctx);
    if (styleRefs) portable.styleRefs = styleRefs;
    var boundVariables = collectBoundVariables(node, ctx);
    if (boundVariables) portable.boundVariables = boundVariables;

    // Привязки свойств компонента к полям узла (внутри определения компонента)
    if (ctx.propertyMapStack.length) {
      var references = safe(function () { return node.componentPropertyReferences; }, undefined);
      if (isObject(references)) {
        var mapped = {};
        for (var field in references) {
          if (!Object.prototype.hasOwnProperty.call(references, field)) continue;
          var rawName = references[field];
          var propertyRef = lookupPropertyRef(ctx, rawName);
          if (propertyRef) {
            mapped[field] = propertyRef;
          } else {
            mapped[field] = "unresolved:" + rawName;
            ctx.diag.info(
              DIAG.PROPERTY_BINDING_LOST,
              "components",
              "Привязка свойства \"" + rawName + "\" вне экспортируемых определений (" + node.name + ")",
              { nodeName: node.name }
            );
          }
        }
        if (Object.keys(mapped).length) portable.componentPropertyReferences = mapped;
      }
    }
    if (safe(function () { return node.isExposedInstance; }, false) === true) {
      portable.isExposedInstance = true;
    }

    if (ctx.options.includePluginData) {
      var pluginData = readPluginData(node);
      if (pluginData) portable.pluginData = pluginData;
    }

    if (ctx.options.includeReactions) {
      var reactions = safe(function () { return node.reactions; }, undefined);
      if (reactions && reactions.length) {
        ctx.pendingReactions.push({ node: node, portableId: portableId });
      }
    }

    portable.source = { pixsoNodeId: String(node.id), fileKey: ctx.fileKey };

    ctx.pkg.nodes[portableId] = portable;
    return portable;
  }

  function lookupPropertyRef(ctx, rawName) {
    for (var i = ctx.propertyMapStack.length - 1; i >= 0; i--) {
      var map = ctx.propertyMapStack[i];
      if (map && map[rawName]) return map[rawName];
    }
    return null;
  }

  // =========================================================================
  // 10. Иконки
  // =========================================================================

  var ICONABLE_TYPES = {
    VECTOR: true,
    BOOLEAN_OPERATION: true,
    FRAME: true,
    GROUP: true,
    COMPONENT: true,
    INSTANCE: true,
  };

  var MAX_ICON_CONTAINER_SIZE = 128;

  /** Контейнер с "Icon/..." в имени считается иконкой только при иконном размере,
   *  чтобы большой фрейм "Icons/Overview" не схлопнулся в одну ссылку. */
  function hasIconSize(node) {
    var width = safe(function () { return node.width; }, 0);
    var height = safe(function () { return node.height; }, 0);
    if (typeof width !== "number" || typeof height !== "number") return true;
    return width <= MAX_ICON_CONTAINER_SIZE && height <= MAX_ICON_CONTAINER_SIZE;
  }

  function detectIcon(node) {
    if (!node || !ICONABLE_TYPES[node.type]) return null;
    var pluginAssetType = safe(function () {
      return typeof node.getPluginData === "function" ? node.getPluginData("assetType") : "";
    }, "");
    var pluginIconName = safe(function () {
      return typeof node.getPluginData === "function" ? node.getPluginData("iconName") : "";
    }, "");
    if (pluginAssetType === "icon" || pluginIconName) {
      var fromPlugin = pluginIconName || node.name;
      return { name: String(node.name || fromPlugin), normalizedName: normalizeIconName(fromPlugin), via: "pluginData" };
    }
    var sizeOk = node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION" || hasIconSize(node);
    if (sizeOk && ICON_NAME_PATTERN.test(String(node.name || ""))) {
      return { name: String(node.name), normalizedName: normalizeIconName(node.name), via: "namePrefix" };
    }
    // Инстанс компонента-иконки: имя main-компонента начинается с "Icon/"
    if (node.type === "INSTANCE" && sizeOk) {
      var mainName = safe(function () { return node.mainComponent && node.mainComponent.name; }, "");
      if (mainName && ICON_NAME_PATTERN.test(String(mainName))) {
        return { name: String(mainName), normalizedName: normalizeIconName(mainName), via: "mainComponentName" };
      }
    }
    return null;
  }

  function findFirstSolidPaint(node, field, depth) {
    if (depth <= 0 || !node) return undefined;
    var paints = safe(function () { return node[field]; }, undefined);
    if (!isMixedValue(paints) && paints && paints.length) {
      for (var i = 0; i < paints.length; i++) {
        if (paints[i] && paints[i].type === "SOLID" && paints[i].visible !== false) {
          return serializePaint(paints[i], null);
        }
      }
    }
    var children = safe(function () { return node.children; }, undefined);
    if (children && children.length) {
      for (var c = 0; c < children.length; c++) {
        var found = findFirstSolidPaint(children[c], field, depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  /** SVG уместен вне resolved-поддеревьев инстансов: определения компонентов
   *  уже несут свои вектора, дублировать их в каждом инстансе бессмысленно.
   *  Исключение — snapshot-поддерево (mainComponent недоступен). */
  function svgAllowedForFlags(flags) {
    return !flags || !flags.insideInstance || flags.snapshotSubtree === true;
  }

  function serializeIconNode(node, ctx, detected, flags) {
    var portable = buildBaseNode(node, ctx, "ICON");

    var icon = {
      name: detected.name,
      normalizedName: detected.normalizedName,
      detectedVia: detected.via,
    };
    if (node.type === "INSTANCE") {
      icon.asInstance = true;
      var rawProps = safe(function () { return node.componentProperties; }, undefined);
      if (isObject(rawProps)) {
        var instanceProps = {};
        for (var rawName in rawProps) {
          if (!Object.prototype.hasOwnProperty.call(rawProps, rawName)) continue;
          var entry = rawProps[rawName];
          var value = sanitizeForJson(isObject(entry) ? entry.value : entry, 2);
          if (value !== undefined) instanceProps[stripPropertySuffix(rawName)] = value;
        }
        if (Object.keys(instanceProps).length) icon.instanceProperties = instanceProps;
      }
    }
    var fillOverride = findFirstSolidPaint(node, "fills", 3);
    if (fillOverride) icon.fillOverride = fillOverride;
    var strokeOverride = findFirstSolidPaint(node, "strokes", 3);
    if (strokeOverride) icon.strokeOverride = strokeOverride;

    portable.icon = icon;

    var dependency = ctx.pkg.iconDependencies[detected.normalizedName];
    if (!dependency) {
      dependency = {
        name: detected.name,
        normalizedName: detected.normalizedName,
        usageCount: 0,
      };
      ctx.pkg.iconDependencies[detected.normalizedName] = dependency;
    }
    dependency.usageCount += 1;

    var entity = currentEntity(ctx);
    if (entity) addEdge(ctx, entity, "icon:" + detected.normalizedName, "USES_ICON");

    if (ctx.options.includeIconSnapshots && ctx.collectBinary && svgAllowedForFlags(flags)) {
      scheduleSvgJob(ctx, { node: node, portable: portable, isIcon: true, normalizedName: detected.normalizedName });
    }

    return portable;
  }

  // =========================================================================
  // 11. Текст
  // =========================================================================

  function registerFont(ctx, fontName) {
    if (!isObject(fontName) || typeof fontName.family !== "string") return;
    var key = fontName.family + "||" + String(fontName.style || "Regular");
    ctx.fontUsage[key] = (ctx.fontUsage[key] || 0) + 1;
  }

  function serializeTextData(node, ctx) {
    var text = {
      characters: String(safe(function () { return node.characters; }, "")),
    };

    var fontName = safe(function () { return node.fontName; }, undefined);
    if (isObject(fontName) && !isMixedValue(fontName)) {
      text.fontName = { family: fontName.family, style: fontName.style };
      registerFont(ctx, fontName);
    }
    var fontSize = safe(function () { return node.fontSize; }, undefined);
    if (typeof fontSize === "number") text.fontSize = round2(fontSize);

    var stringKeys = ["textAlignHorizontal", "textAlignVertical", "textAutoResize", "textTruncation", "textDirection"];
    for (var i = 0; i < stringKeys.length; i++) {
      var sv = safe(function () { return node[stringKeys[i]]; }, undefined);
      if (typeof sv === "string") text[stringKeys[i]] = sv;
    }
    var textCase = safe(function () { return node.textCase; }, undefined);
    if (typeof textCase === "string" && textCase !== "ORIGINAL") text.textCase = textCase;
    var textDecoration = safe(function () { return node.textDecoration; }, undefined);
    if (typeof textDecoration === "string" && textDecoration !== "NONE") text.textDecoration = textDecoration;

    var paragraphSpacing = safe(function () { return node.paragraphSpacing; }, undefined);
    if (typeof paragraphSpacing === "number" && paragraphSpacing !== 0) text.paragraphSpacing = round2(paragraphSpacing);
    var paragraphIndent = safe(function () { return node.paragraphIndent; }, undefined);
    if (typeof paragraphIndent === "number" && paragraphIndent !== 0) text.paragraphIndent = round2(paragraphIndent);

    var letterSpacing = sanitizeForJson(safe(function () { return node.letterSpacing; }, undefined), 2);
    if (letterSpacing !== undefined) text.letterSpacing = letterSpacing;
    var lineHeight = sanitizeForJson(safe(function () { return node.lineHeight; }, undefined), 2);
    if (lineHeight !== undefined) text.lineHeight = lineHeight;
    var maxLines = safe(function () { return node.maxLines; }, undefined);
    if (typeof maxLines === "number") text.maxLines = maxLines;

    // Rich text: диапазоны с разными стилями
    var segments = safe(function () {
      if (typeof node.getStyledTextSegments !== "function") return null;
      return node.getStyledTextSegments([
        "fontName",
        "fontSize",
        "fills",
        "textCase",
        "textDecoration",
        "letterSpacing",
        "lineHeight",
        "textStyleId",
      ]);
    }, null);

    if (segments && segments.length > 1) {
      var portableSegments = [];
      for (var s = 0; s < segments.length; s++) {
        var segment = segments[s];
        if (!isObject(segment)) continue;
        var out = {
          start: numberOr(segment.start, 0),
          end: numberOr(segment.end, 0),
        };
        if (isObject(segment.fontName)) {
          out.fontName = { family: segment.fontName.family, style: segment.fontName.style };
          registerFont(ctx, segment.fontName);
        }
        if (typeof segment.fontSize === "number") out.fontSize = round2(segment.fontSize);
        var segmentFills = serializePaintList(segment.fills, ctx);
        if (segmentFills) out.fills = segmentFills;
        if (typeof segment.textCase === "string" && segment.textCase !== "ORIGINAL") out.textCase = segment.textCase;
        if (typeof segment.textDecoration === "string" && segment.textDecoration !== "NONE") {
          out.textDecoration = segment.textDecoration;
        }
        var segLetterSpacing = sanitizeForJson(segment.letterSpacing, 2);
        if (segLetterSpacing !== undefined) out.letterSpacing = segLetterSpacing;
        var segLineHeight = sanitizeForJson(segment.lineHeight, 2);
        if (segLineHeight !== undefined) out.lineHeight = segLineHeight;
        if (typeof segment.textStyleId === "string" && segment.textStyleId) {
          var styleRef = ensureStyle(ctx, segment.textStyleId, "TEXT");
          if (styleRef) out.textStyleRef = styleRef;
        }
        portableSegments.push(out);
      }
      if (portableSegments.length) text.segments = portableSegments;
    }

    return text;
  }

  // =========================================================================
  // 12. Компоненты, Component Set, инстансы
  // =========================================================================

  function buildNodePath(node, ancestor) {
    var steps = [];
    var current = node;
    var guard = 0;
    while (current && current !== ancestor && guard < 100) {
      var parent = safe(function () { return current.parent; }, null);
      var index = 0;
      if (parent) {
        var siblings = safe(function () { return parent.children; }, []) || [];
        for (var i = 0; i < siblings.length; i++) {
          if (siblings[i] === current) {
            index = i;
            break;
          }
        }
      }
      steps.unshift({ name: String(current.name || ""), type: String(current.type || ""), index: index });
      current = parent;
      guard += 1;
    }
    return current === ancestor ? steps : null;
  }

  function isDescendantOf(node, ancestor) {
    var current = safe(function () { return node.parent; }, null);
    var guard = 0;
    while (current && guard < 100) {
      if (current === ancestor) return true;
      current = safe(function () { return current.parent; }, null);
      guard += 1;
    }
    return false;
  }

  /**
   * Определения свойств компонента/сета → переносимые записи + карта
   * "raw имя → portable id" для восстановления привязок.
   */
  function readComponentProperties(defNode, ctx, ownerPortableId) {
    var raw = safe(function () { return defNode.componentPropertyDefinitions; }, undefined);
    var list = [];
    var rawMap = {};
    if (isObject(raw)) {
      for (var rawName in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, rawName)) continue;
        var def = raw[rawName];
        if (!isObject(def)) continue;
        var logical = stripPropertySuffix(rawName);
        var portableId = "property:" + slugify(logical) + "-" + shortHash(ownerPortableId + "|" + rawName, 6);
        var entry = {
          portableId: portableId,
          rawPixsoPropertyName: rawName,
          logicalPropertyName: logical,
          propertyType: String(def.type || "TEXT"),
        };
        var defaultValue = sanitizeForJson(def.defaultValue, 2);
        if (defaultValue !== undefined) entry.defaultValue = defaultValue;
        if (def.variantOptions && def.variantOptions.length) {
          entry.variantOptions = sanitizeForJson(def.variantOptions, 2);
        }
        if (entry.propertyType === "INSTANCE_SWAP") {
          // Значение по умолчанию для swap — id компонента: пробуем выгрузить зависимость
          var swapRef = resolveSwapValue(String(def.defaultValue || ""), ctx);
          if (swapRef.componentRef) entry.defaultSwapComponentRef = swapRef.componentRef;
          if (swapRef.componentName) entry.defaultSwapComponentName = swapRef.componentName;
          var preferred = safe(function () { return def.preferredValues; }, undefined);
          if (preferred && preferred.length) entry.preferredValues = sanitizeForJson(preferred, 2);
        }
        list.push(entry);
        rawMap[rawName] = portableId;
      }
    }
    return { list: list, rawMap: rawMap };
  }

  /** Значение INSTANCE_SWAP — это id компонента в исходном файле. */
  function resolveSwapValue(componentId, ctx) {
    var result = {};
    if (!componentId) return result;
    var target = safe(function () {
      return typeof ctx.api.getNodeById === "function" ? ctx.api.getNodeById(componentId) : null;
    }, null);
    if (target && (target.type === "COMPONENT" || target.type === "COMPONENT_SET")) {
      result.componentName = String(target.name || "");
      if (ctx.options.includeComponentDependencies) {
        var ref = target.type === "COMPONENT"
          ? exportComponentEntity(target, ctx, {})
          : exportComponentSetEntity(target, ctx);
        if (ref) {
          result.componentRef = ref;
          var entity = currentEntity(ctx);
          if (entity) addEdge(ctx, entity, ref, "USES_COMPONENT");
        }
      }
    } else if (componentId) {
      result.componentName = componentId;
    }
    return result;
  }

  /** componentProperties инстанса → переносимые значения по логическим именам. */
  function mapComponentPropertyValues(rawProps, ctx) {
    if (!isObject(rawProps)) return {};
    var out = {};
    for (var rawName in rawProps) {
      if (!Object.prototype.hasOwnProperty.call(rawProps, rawName)) continue;
      var entry = rawProps[rawName];
      var type = isObject(entry) && typeof entry.type === "string" ? entry.type : "TEXT";
      var value = isObject(entry) ? entry.value : entry;
      var portable = { type: type };
      if (type === "INSTANCE_SWAP") {
        var swap = resolveSwapValue(String(value || ""), ctx);
        if (swap.componentRef) portable.swapComponentRef = swap.componentRef;
        if (swap.componentName) portable.swapComponentName = swap.componentName;
        portable.value = sanitizeForJson(value, 1);
      } else {
        portable.value = sanitizeForJson(value, 2);
      }
      out[stripPropertySuffix(rawName)] = portable;
    }
    return out;
  }

  /**
   * Экспорт определения компонента. Возвращает portableId компонента.
   * flags: { viaSet, propertyRawMap, setPortableId, skipParentCheck }
   */
  function exportComponentEntity(compNode, ctx, flags) {
    flags = flags || {};
    if (!compNode || compNode.type !== "COMPONENT") return null;
    if (ctx.componentIds[compNode.id]) return ctx.componentIds[compNode.id];

    // Компонент внутри Component Set экспортируется вместе со всем сетом
    if (!flags.viaSet && !flags.skipParentCheck) {
      var parent = safe(function () { return compNode.parent; }, null);
      if (parent && parent.type === "COMPONENT_SET") {
        exportComponentSetEntity(parent, ctx);
        return ctx.componentIds[compNode.id] || null;
      }
    }

    if (ctx.componentStack[compNode.id]) return null; // защита от циклов
    ctx.componentStack[compNode.id] = true;

    var portableId = reusablePortableId(compNode, "component") ||
      makePortableId(ctx, "component", compNode.name, compNode.id);
    ctx.componentIds[compNode.id] = portableId;

    var entity = {
      portableId: portableId,
      name: String(compNode.name || ""),
      availability: "FULL",
      properties: [],
    };
    var description = safe(function () { return compNode.description; }, "");
    if (description) entity.description = description;
    var docLinks = safe(function () { return compNode.documentationLinks; }, undefined);
    if (docLinks && docLinks.length) {
      var uris = [];
      for (var d = 0; d < docLinks.length; d++) {
        if (docLinks[d] && docLinks[d].uri) uris.push(String(docLinks[d].uri));
      }
      if (uris.length) entity.documentationLinks = uris;
    }
    if (safe(function () { return compNode.remote; }, false) === true) entity.remote = true;
    var key = safe(function () { return compNode.key; }, undefined);
    if (key) entity.libraryKey = key;
    entity.source = { pixsoNodeId: String(compNode.id), fileKey: ctx.fileKey };

    if (flags.viaSet) {
      entity.componentSetRef = flags.setPortableId;
      var variantProps = safe(function () { return compNode.variantProperties; }, undefined);
      if (!isObject(variantProps)) variantProps = parseVariantName(compNode.name);
      if (Object.keys(variantProps).length) entity.variantProperties = sanitizeForJson(variantProps, 2);
    } else {
      var props = readComponentProperties(compNode, ctx, portableId);
      entity.properties = props.list;
      flags.propertyRawMap = props.rawMap;
    }

    ctx.pkg.components[portableId] = entity;

    // Дерево определения
    ctx.entityStack.push(portableId);
    if (flags.propertyRawMap) ctx.propertyMapStack.push(flags.propertyRawMap);
    var rootNodeRef = serializeNodeTree(compNode, ctx, { asDefinitionRoot: true });
    if (flags.propertyRawMap) ctx.propertyMapStack.pop();
    ctx.entityStack.pop();

    if (rootNodeRef) entity.rootNodeRef = rootNodeRef;

    delete ctx.componentStack[compNode.id];
    return portableId;
  }

  /** Экспорт Component Set со всеми вариантами. Возвращает portableId сета. */
  function exportComponentSetEntity(setNode, ctx) {
    if (!setNode || setNode.type !== "COMPONENT_SET") return null;
    if (ctx.componentSetIds[setNode.id]) return ctx.componentSetIds[setNode.id];

    var portableId = reusablePortableId(setNode, "set") ||
      makePortableId(ctx, "set", setNode.name, setNode.id);
    ctx.componentSetIds[setNode.id] = portableId;

    var entity = {
      portableId: portableId,
      name: String(setNode.name || ""),
      availability: "FULL",
      variantGroupProperties: {},
      properties: [],
      componentRefs: [],
    };
    var description = safe(function () { return setNode.description; }, "");
    if (description) entity.description = description;
    if (safe(function () { return setNode.remote; }, false) === true) entity.remote = true;
    var key = safe(function () { return setNode.key; }, undefined);
    if (key) entity.libraryKey = key;
    entity.source = { pixsoNodeId: String(setNode.id), fileKey: ctx.fileKey };

    ctx.pkg.componentSets[portableId] = entity;

    // Свойства уровня сета (VARIANT/BOOLEAN/TEXT/INSTANCE_SWAP)
    var props = readComponentProperties(setNode, ctx, portableId);
    entity.properties = props.list;

    // Группы вариантов
    var groups = safe(function () { return setNode.variantGroupProperties; }, undefined);
    var members = safe(function () { return setNode.children; }, []) || [];
    if (isObject(groups)) {
      entity.variantGroupProperties = sanitizeForJson(groups, 3) || {};
    } else {
      // Восстановление из имён вариантов "Prop=Value, Prop2=Value2"
      var derived = {};
      for (var m = 0; m < members.length; m++) {
        var parsed = parseVariantName(members[m] && members[m].name);
        for (var groupName in parsed) {
          if (!Object.prototype.hasOwnProperty.call(parsed, groupName)) continue;
          if (!derived[groupName]) derived[groupName] = { values: [] };
          if (derived[groupName].values.indexOf(parsed[groupName]) < 0) {
            derived[groupName].values.push(parsed[groupName]);
          }
        }
      }
      entity.variantGroupProperties = derived;
    }

    // Узел сета + варианты
    ctx.entityStack.push(portableId);
    ctx.propertyMapStack.push(props.rawMap);

    var setPortableNode = buildBaseNode(setNode, ctx, "COMPONENT_SET");
    var childRefs = [];
    for (var i = 0; i < members.length; i++) {
      var member = members[i];
      if (!member || member.type !== "COMPONENT") continue;
      var memberId = exportComponentEntity(member, ctx, {
        viaSet: true,
        setPortableId: portableId,
        propertyRawMap: props.rawMap,
      });
      if (memberId) {
        entity.componentRefs.push(memberId);
        addEdge(ctx, portableId, memberId, "HAS_VARIANT");
        var memberEntity = ctx.pkg.components[memberId];
        if (memberEntity && memberEntity.rootNodeRef) childRefs.push(memberEntity.rootNodeRef);
      }
    }
    setPortableNode.children = childRefs;

    ctx.propertyMapStack.pop();
    ctx.entityStack.pop();

    var defaultVariant = safe(function () { return setNode.defaultVariant; }, undefined);
    if (defaultVariant && ctx.componentIds[defaultVariant.id]) {
      entity.defaultVariantRef = ctx.componentIds[defaultVariant.id];
    }

    entity.rootNodeRef = setPortableNode.id;
    return portableId;
  }

  var OVERRIDE_FIELD_READERS = {
    characters: function (target) {
      var value = safe(function () { return target.characters; }, undefined);
      return typeof value === "string" ? value : undefined;
    },
    visible: function (target) {
      var value = safe(function () { return target.visible; }, undefined);
      return typeof value === "boolean" ? value : undefined;
    },
    opacity: function (target) {
      var value = safe(function () { return target.opacity; }, undefined);
      return typeof value === "number" ? round2(value) : undefined;
    },
    cornerRadius: function (target) {
      var value = safe(function () { return target.cornerRadius; }, undefined);
      return typeof value === "number" ? round2(value) : undefined;
    },
    strokeWeight: function (target) {
      var value = safe(function () { return target.strokeWeight; }, undefined);
      return typeof value === "number" ? round2(value) : undefined;
    },
  };

  function readInstanceOverrides(instanceNode, ctx, instancePortableId) {
    var rawOverrides = safe(function () { return instanceNode.overrides; }, undefined);
    if (!rawOverrides || !rawOverrides.length) return [];
    if (typeof ctx.api.getNodeById !== "function") {
      ctx.diag.info(
        DIAG.INSTANCE_OVERRIDE_PARTIAL,
        "instances",
        "overrides без getNodeById: сохранены только имена полей (" + instanceNode.name + ")",
        { portableId: instancePortableId, nodeName: instanceNode.name }
      );
      return sanitizeForJson(rawOverrides, 3) || [];
    }

    var result = [];
    var partialFields = [];

    for (var i = 0; i < rawOverrides.length; i++) {
      var entry = rawOverrides[i];
      if (!isObject(entry) || !entry.id) continue;
      var target = safe(function () { return ctx.api.getNodeById(entry.id); }, null);
      if (!target) continue;
      var isSelf = target === instanceNode || String(entry.id) === String(instanceNode.id);
      if (!isSelf && !isDescendantOf(target, instanceNode)) continue;

      var path = isSelf ? [] : buildNodePath(target, instanceNode) || [];
      var changes = {};
      var fields = entry.overriddenFields || [];

      for (var f = 0; f < fields.length; f++) {
        var field = String(fields[f]);
        if (OVERRIDE_FIELD_READERS[field]) {
          var value = OVERRIDE_FIELD_READERS[field](target);
          if (value !== undefined) changes[field] = value;
        } else if (field === "fills" || field === "strokes") {
          var paints = serializePaintList(safe(function () { return target[field]; }, undefined), ctx);
          if (paints) changes[field] = paints;
        } else if (field === "componentProperties") {
          var mappedProps = mapComponentPropertyValues(
            safe(function () { return target.componentProperties; }, undefined),
            ctx
          );
          if (Object.keys(mappedProps).length) changes.componentProperties = mappedProps;
        } else if (field === "mainComponent") {
          var swappedMain = safe(function () { return target.mainComponent; }, null);
          if (swappedMain) {
            var swapChange = { name: String(swappedMain.name || "") };
            if (ctx.options.includeComponentDependencies) {
              var swapRef = exportComponentEntity(swappedMain, ctx, {});
              if (!swapRef && swappedMain.parent && swappedMain.parent.type === "COMPONENT_SET") {
                swapRef = ctx.componentIds[swappedMain.id];
              }
              if (swapRef) swapChange.componentRef = swapRef;
            }
            changes.swapTo = swapChange;
          }
        } else if (field === "stuckNodes" || field === "componentPropertyReferences") {
          continue; // служебные поля не переносим
        } else {
          if (partialFields.indexOf(field) < 0) partialFields.push(field);
        }
      }

      if (Object.keys(changes).length || path.length) {
        var override = { targetPath: path, changes: changes };
        var targetPortableRef = ctx.nodeIds[String(entry.id)];
        if (targetPortableRef) override.targetNodeRef = targetPortableRef;
        result.push(override);
      }
    }

    if (partialFields.length) {
      ctx.diag.info(
        DIAG.INSTANCE_OVERRIDE_PARTIAL,
        "instances",
        "Часть переопределений сохранена только по имени поля: " + partialFields.join(", ") + " (" + instanceNode.name + ")",
        { portableId: instancePortableId, nodeName: instanceNode.name }
      );
    }

    return result;
  }

  function collectTextOverrides(instanceNode, ctx) {
    var found = [];

    function walk(node) {
      if (found.length >= MAX_TEXT_OVERRIDES_PER_INSTANCE) return;
      var children = safe(function () { return node.children; }, []) || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (!child) continue;
        if (child.type === "TEXT") {
          var characters = safe(function () { return child.characters; }, undefined);
          var path = buildNodePath(child, instanceNode);
          if (typeof characters === "string" && path) {
            found.push({ path: path, characters: characters });
          }
        }
        walk(child);
        if (found.length >= MAX_TEXT_OVERRIDES_PER_INSTANCE) return;
      }
    }

    walk(instanceNode);
    return found;
  }

  function serializeInstance(node, ctx, flags) {
    // В visual snapshot режиме переносим фактическое дерево instance и не
    // смешиваем его с деревом source-component. Иначе одинаковые исходные
    // узлы конкурируют в общем реестре и экран становится неполным.
    var visualSnapshot = !!(flags && flags.forceInstanceSubtrees) || !!ctx.options.visualSnapshotMode;
    var portable = buildBaseNode(node, ctx, "INSTANCE");
    var preset = {
      availability: "FULL",
      variantProperties: {},
      componentProperties: {},
      overrides: [],
      exposedInstances: [],
    };

    var main = safe(function () { return node.mainComponent; }, null);

    if (!main) {
      preset.availability = "SNAPSHOT_ONLY";
      ctx.diag.warn(
        DIAG.MAIN_COMPONENT_UNAVAILABLE,
        "instances",
        "mainComponent недоступен для \"" + node.name + "\": сохранён визуальный snapshot",
        { portableId: portable.id, nodeName: node.name, fallback: "SNAPSHOT_ONLY" }
      );
      ctx.diag.info(
        DIAG.SNAPSHOT_FALLBACK_USED,
        "instances",
        "Snapshot-поддерево сохранено для \"" + node.name + "\"",
        { portableId: portable.id }
      );
    } else {
      var mainParent = safe(function () { return main.parent; }, null);
      var inSet = mainParent && mainParent.type === "COMPONENT_SET";
      preset.definitionName = String(main.name || "");
      if (inSet) preset.definitionSetName = String(mainParent.name || "");

      if (visualSnapshot) {
        preset.availability = "SNAPSHOT_ONLY";
      } else if (ctx.options.includeComponentDependencies) {
        if (inSet) {
          var setRef = exportComponentSetEntity(mainParent, ctx);
          if (setRef) preset.definitionSetRef = setRef;
          var mainRef = ctx.componentIds[main.id];
          if (mainRef) preset.definitionRef = mainRef;
          if (!setRef) {
            ctx.diag.warn(
              DIAG.COMPONENT_SET_UNAVAILABLE,
              "instances",
              "Component Set недоступен для \"" + node.name + "\"",
              { portableId: portable.id, nodeName: node.name }
            );
          }
        } else {
          var componentRef = exportComponentEntity(main, ctx, {});
          if (componentRef) preset.definitionRef = componentRef;
        }
        if (!preset.definitionRef && !preset.definitionSetRef) {
          preset.availability = "PARTIAL";
        }
        var entity = currentEntity(ctx);
        var dependencyRef = preset.definitionSetRef || preset.definitionRef;
        if (entity && dependencyRef) addEdge(ctx, entity, dependencyRef, "INSTANCE_OF");
      } else {
        preset.availability = "PARTIAL";
      }

      var variantProps = safe(function () { return node.variantProperties; }, undefined);
      if (isObject(variantProps)) {
        preset.variantProperties = sanitizeForJson(variantProps, 2) || {};
      }
    }

    var rawProps = safe(function () { return node.componentProperties; }, undefined);
    preset.componentProperties = mapComponentPropertyValues(rawProps, ctx);

    // VARIANT-значения из componentProperties дополняют variantProperties
    for (var logical in preset.componentProperties) {
      if (!Object.prototype.hasOwnProperty.call(preset.componentProperties, logical)) continue;
      var propEntry = preset.componentProperties[logical];
      if (propEntry.type === "VARIANT" && preset.variantProperties[logical] === undefined) {
        preset.variantProperties[logical] = String(propEntry.value);
      }
    }

    preset.overrides = readInstanceOverrides(node, ctx, portable.id);

    var exposed = safe(function () { return node.exposedInstances; }, undefined);
    if (exposed && exposed.length) {
      for (var e = 0; e < exposed.length; e++) {
        var exposedNode = exposed[e];
        if (!exposedNode) continue;
        var exposedPath = buildNodePath(exposedNode, node);
        if (!exposedPath) continue;
        preset.exposedInstances.push({
          path: exposedPath,
          componentProperties: mapComponentPropertyValues(
            safe(function () { return exposedNode.componentProperties; }, undefined),
            ctx
          ),
        });
        // Определение exposed-инстанса — тоже зависимость
        var exposedMain = safe(function () { return exposedNode.mainComponent; }, null);
        if (exposedMain && ctx.options.includeComponentDependencies && !visualSnapshot) {
          var exposedParent = safe(function () { return exposedMain.parent; }, null);
          if (exposedParent && exposedParent.type === "COMPONENT_SET") {
            exportComponentSetEntity(exposedParent, ctx);
          } else {
            exportComponentEntity(exposedMain, ctx, {});
          }
        }
      }
    }

    var textOverrides = collectTextOverrides(node, ctx);
    if (textOverrides.length) preset.textOverrides = textOverrides;

    portable.presetRef = portable.id;
    if (preset.definitionRef) portable.definitionRef = preset.definitionRef;
    if (preset.definitionSetRef) portable.definitionSetRef = preset.definitionSetRef;

    ctx.pkg.instances[portable.id] = {
      portableId: portable.id,
      nodeRef: portable.id,
      preset: preset,
    };

    // Дети: snapshot всегда при SNAPSHOT_ONLY. Для переноса полного экрана
    // разворачиваем instance в его фактическое дерево: именно оно содержит
    // применённые overrides и выбранные variants, а не default-компонент.
    var needSubtree = preset.availability === "SNAPSHOT_ONLY" ||
      ctx.options.includeInstanceSubtrees || visualSnapshot;
    if (needSubtree) {
      var children = safe(function () { return node.children; }, []) || [];
      var childIds = [];
      for (var c = 0; c < children.length; c++) {
        var childRef = serializeNodeTree(children[c], ctx, {
          insideInstance: true,
          // Для snapshot-фоллбека SVG нужен: это единственный источник данных
          snapshotSubtree: visualSnapshot || preset.availability === "SNAPSHOT_ONLY",
          forceInstanceSubtrees: !!(flags && flags.forceInstanceSubtrees),
        });
        if (childRef) childIds.push(childRef);
      }
      if (childIds.length) portable.children = childIds;
    }

    return portable;
  }

  // =========================================================================
  // 13. Диспетчер узлов
  // =========================================================================

  var CONTAINER_TYPES = { FRAME: true, SECTION: true, GROUP: true };
  var SIMPLE_SHAPE_TYPES = { RECTANGLE: true, ELLIPSE: true, LINE: true, POLYGON: true, STAR: true };
  var VECTOR_TYPES = { VECTOR: true, BOOLEAN_OPERATION: true };

  function serializeChildren(node, ctx, flags) {
    var children = safe(function () { return node.children; }, []) || [];
    var childFlags = {
      insideInstance: !!(flags && flags.insideInstance),
      snapshotSubtree: !!(flags && flags.snapshotSubtree),
      forceInstanceSubtrees: !!(flags && flags.forceInstanceSubtrees),
    };
    var refs = [];
    for (var i = 0; i < children.length; i++) {
      var childRef = serializeNodeTree(children[i], ctx, childFlags);
      if (childRef) refs.push(childRef);
    }
    return refs;
  }

  /**
   * Сериализация узла и его поддерева. Возвращает portable id узла или null.
   * flags: { asDefinitionRoot, insideInstance }
   */
  function serializeNodeTree(node, ctx, flags) {
    flags = flags || {};
    if (!node || !node.type) return null;
    if (ctx.nodeIds[node.id]) return ctx.nodeIds[node.id];

    // Иконка — лист-ссылка (кроме случая, когда узел сам является корнем определения)
    if (!flags.asDefinitionRoot) {
      var detected = detectIcon(node);
      if (detected && detected.normalizedName) {
        return serializeIconNode(node, ctx, detected, flags).id;
      }
    }

    var type = String(node.type);

    if (type === "COMPONENT" && !flags.asDefinitionRoot) {
      var componentRef = exportComponentEntity(node, ctx, {});
      if (componentRef) {
        var compEntity = ctx.pkg.components[componentRef];
        return compEntity && compEntity.rootNodeRef ? compEntity.rootNodeRef : null;
      }
      return ctx.nodeIds[node.id] || null;
    }

    if (type === "COMPONENT_SET" && !flags.asDefinitionRoot) {
      var setRef = exportComponentSetEntity(node, ctx);
      if (setRef) {
        var setEntity = ctx.pkg.componentSets[setRef];
        return setEntity && setEntity.rootNodeRef ? setEntity.rootNodeRef : null;
      }
      return ctx.nodeIds[node.id] || null;
    }

    if (type === "INSTANCE") {
      return serializeInstance(node, ctx, flags).id;
    }

    if (type === "TEXT") {
      var textPortable = buildBaseNode(node, ctx, "TEXT");
      textPortable.text = serializeTextData(node, ctx);
      return textPortable.id;
    }

    if (SIMPLE_SHAPE_TYPES[type]) {
      var shapePortable = buildBaseNode(node, ctx, type);
      var pointCount = safe(function () { return node.pointCount; }, undefined);
      if (typeof pointCount === "number") shapePortable.pointCount = pointCount;
      var innerRadius = safe(function () { return node.innerRadius; }, undefined);
      if (typeof innerRadius === "number") shapePortable.innerRadius = round2(innerRadius);
      var arcData = sanitizeForJson(safe(function () { return node.arcData; }, undefined), 2);
      if (arcData) shapePortable.arcData = arcData;
      return shapePortable.id;
    }

    if (VECTOR_TYPES[type]) {
      var vectorPortable = buildBaseNode(node, ctx, type);
      var booleanOperation = safe(function () { return node.booleanOperation; }, undefined);
      if (typeof booleanOperation === "string") vectorPortable.booleanOperation = booleanOperation;
      if (ctx.options.includeVectorSvg && ctx.collectBinary && svgAllowedForFlags(flags)) {
        scheduleSvgJob(ctx, { node: node, portable: vectorPortable, isIcon: false });
      }
      return vectorPortable.id;
    }

    if (type === "SLICE") {
      var slicePortable = buildBaseNode(node, ctx, "SLICE");
      return slicePortable.id;
    }

    if (CONTAINER_TYPES[type] || flags.asDefinitionRoot) {
      var containerPortable = buildBaseNode(node, ctx, type);
      containerPortable.children = serializeChildren(node, ctx, flags);
      return containerPortable.id;
    }

    // Неизвестный тип: сохраняем что можем; детей — рекурсивно
    ctx.diag.info(
      DIAG.UNSUPPORTED_NODE_TYPE,
      "serialize",
      "Тип узла " + type + " не поддерживается напрямую; сохранены базовые свойства (" + node.name + ")",
      { nodeName: node.name }
    );
    var fallbackPortable = buildBaseNode(node, ctx, "UNSUPPORTED");
    fallbackPortable.originalType = type;
    var fallbackChildren = serializeChildren(node, ctx, flags);
    if (fallbackChildren.length) fallbackPortable.children = fallbackChildren;
    return fallbackPortable.id;
  }

  // =========================================================================
  // 14. Финализация: SVG, изображения, переменные, реакции, шрифты,
  //     fingerprints, граф зависимостей
  // =========================================================================

  function normalizeSvgMarkup(svg) {
    return String(svg || "")
      .replace(/<\?xml[^>]*\?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/>\s+</g, "><")
      .trim();
  }

  function registerSvgAsset(ctx, svgMarkup) {
    var normalized = normalizeSvgMarkup(svgMarkup);
    var fullHash = sha256Hex(normalized);
    var assetId = "svg:" + fullHash.slice(0, 10);
    if (!ctx.pkg.svgAssets[assetId]) ctx.pkg.svgAssets[assetId] = normalized;
    return { assetId: assetId, hash: "sha256:" + fullHash };
  }

  var SVG_EXPORT_TIMEOUT_MS = 15000;

  /**
   * Pixso принимает только format: "SVG" (валидные значения JPG/PNG/SVG/PDF),
   * Figma-совместимые среды понимают "SVG_STRING". Пробуем "SVG" первым и
   * кэшируем сработавший формат на весь прогон, чтобы не сыпать сотни
   * ошибок валидации в консоль хоста.
   */
  async function exportNodeSvg(node, ctx) {
    if (typeof node.exportAsync !== "function") return null;
    var formats = ctx && ctx.svgFormatPreference ? [ctx.svgFormatPreference] : ["SVG", "SVG_STRING"];
    for (var i = 0; i < formats.length; i++) {
      try {
        var result = await withTimeout(
          node.exportAsync({ format: formats[i] }),
          SVG_EXPORT_TIMEOUT_MS,
          "exportAsync " + formats[i]
        );
        var svg = null;
        if (typeof result === "string" && result) {
          svg = result;
        } else if (result && result.length) {
          svg = utf8FromBytes(result);
        }
        if (svg && svg.indexOf("<") >= 0) {
          if (ctx) ctx.svgFormatPreference = formats[i];
          return svg;
        }
      } catch (_e) { /* следующий формат */ }
    }
    return null;
  }

  function scheduleSvgJob(ctx, job) {
    if (ctx.svgJobs.length >= MAX_SVG_JOBS) {
      ctx.svgJobsCapped = true;
      return false;
    }
    ctx.svgJobs.push(job);
    return true;
  }

  async function runSvgJobs(ctx) {
    if (!ctx.svgJobs.length) return;
    var total = ctx.svgJobs.length;
    reportProgress(ctx, "Экспорт SVG 0/" + total);
    var iconSvgCache = {};
    // В visual snapshot одна и та же иконка может иметь разные
    // resolved fill/stroke overrides. Кеш только по имени склеивал их
    // в один SVG. registerSvgAsset сам дедуплицирует реально одинаковую разметку.
    var useLogicalIconCache = ctx.pkg.transferMode !== "VISUAL_SNAPSHOT";

    for (var i = 0; i < ctx.svgJobs.length; i++) {
      if (i % 20 === 0 && i > 0) {
        reportProgress(ctx, "Экспорт SVG " + i + "/" + total);
      }
      var job = ctx.svgJobs[i];
      var svg = null;

      if (useLogicalIconCache && job.isIcon && job.normalizedName && iconSvgCache[job.normalizedName]) {
        var cached = iconSvgCache[job.normalizedName];
        job.portable.svgRef = cached.assetId;
        if (job.portable.icon) job.portable.icon.sourceHash = cached.hash;
        continue;
      }

      svg = await exportNodeSvg(job.node, ctx);

      if (!svg) {
        var code = job.isIcon ? DIAG.ICON_ASSET_UNAVAILABLE : DIAG.SVG_EXPORT_FAILED;
        ctx.diag.warn(
          code,
          "svg",
          "Не удалось экспортировать SVG для \"" + job.node.name + "\"",
          { nodeName: job.node.name, portableId: job.portable.id }
        );
        continue;
      }

      var asset = registerSvgAsset(ctx, svg);
      job.portable.svgRef = asset.assetId;

      if (job.isIcon) {
        if (job.portable.icon) job.portable.icon.sourceHash = asset.hash;
        var dependency = ctx.pkg.iconDependencies[job.normalizedName];
        if (dependency) {
          dependency.sourceHash = asset.hash;
          dependency.fallbackSnapshotRef = asset.assetId;
        }
        if (useLogicalIconCache) iconSvgCache[job.normalizedName] = asset;
      }
    }

    if (ctx.svgJobsCapped) {
      ctx.diag.warn(
        DIAG.SVG_JOBS_LIMIT,
        "svg",
        "Векторов больше лимита " + MAX_SVG_JOBS + ": часть узлов сохранена без SVG",
        { fallback: "geometry-only nodes" }
      );
    }
  }

  function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return undefined;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (
      bytes.length > 11 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "image/webp";
    return undefined;
  }

  async function resolveImages(ctx) {
    if (!ctx.pendingImages.length || !ctx.collectBinary) return;
    if (!ctx.options.includeImages) return;
    reportProgress(ctx, "Изображения (" + ctx.pendingImages.length + ")");

    var done = {};
    for (var i = 0; i < ctx.pendingImages.length; i++) {
      var hash = ctx.pendingImages[i];
      if (done[hash]) continue;
      done[hash] = true;

      var portableId = ctx.imageIds[hash];
      var entity = ctx.pkg.images[portableId];
      if (!entity) continue;

      if (typeof ctx.api.getImageByHash !== "function") {
        ctx.diag.warn(
          DIAG.IMAGE_DATA_UNAVAILABLE,
          "images",
          "getImageByHash недоступен: изображение " + hash + " сохранено только ссылкой",
          { portableId: portableId, fallback: "reference only" }
        );
        continue;
      }

      var bytes = null;
      try {
        var handle = ctx.api.getImageByHash(hash);
        if (handle && typeof handle.getBytesAsync === "function") {
          bytes = await withTimeout(handle.getBytesAsync(), 20000, "getBytesAsync " + hash);
        }
      } catch (_e) {
        bytes = null;
      }

      if (!bytes || !bytes.length) {
        ctx.diag.warn(
          DIAG.IMAGE_DATA_UNAVAILABLE,
          "images",
          "Данные изображения " + hash + " недоступны",
          { portableId: portableId, fallback: "reference only" }
        );
        continue;
      }

      entity.contentHash = "sha256:" + sha256Hex(bytes);
      entity.bytesBase64 = base64FromBytes(bytes);
      entity.sizeBytes = bytes.length;
      var mime = detectImageMime(bytes);
      if (mime) entity.mimeType = mime;
    }
  }

  async function resolveVariables(ctx) {
    if (!ctx.pendingVariables.length) return;
    var variablesApi = ctx.api.variables;

    if (!ctx.features.variablesApi) {
      ctx.diag.warn(
        DIAG.VARIABLES_API_UNAVAILABLE,
        "variables",
        "Variables API недоступен: сохранены только ссылки на " + ctx.pendingVariables.length + " переменных",
        { fallback: "id references only" }
      );
      return;
    }

    reportProgress(ctx, "Переменные (" + ctx.pendingVariables.length + ")");
    var queue = ctx.pendingVariables.slice();
    var processed = {};

    async function readVariable(variableId) {
      if (typeof variablesApi.getVariableById === "function") {
        var sync = safe(function () { return variablesApi.getVariableById(variableId); }, null);
        if (sync) return sync;
      }
      if (typeof variablesApi.getVariableByIdAsync === "function") {
        try {
          return await variablesApi.getVariableByIdAsync(variableId);
        } catch (_e) {
          return null;
        }
      }
      return null;
    }

    async function readCollection(collectionId) {
      if (typeof variablesApi.getVariableCollectionById === "function") {
        var sync = safe(function () { return variablesApi.getVariableCollectionById(collectionId); }, null);
        if (sync) return sync;
      }
      if (typeof variablesApi.getVariableCollectionByIdAsync === "function") {
        try {
          return await variablesApi.getVariableCollectionByIdAsync(collectionId);
        } catch (_e) {
          return null;
        }
      }
      return null;
    }

    while (queue.length) {
      var variableId = queue.shift();
      if (processed[variableId]) continue;
      processed[variableId] = true;

      var portableId = ctx.variableIds[variableId];
      var entity = ctx.pkg.variables[portableId];
      if (!entity) continue;

      var variable = await readVariable(variableId);
      if (!variable) {
        ctx.diag.warn(
          DIAG.VARIABLE_BINDING_LOST,
          "variables",
          "Переменная " + variableId + " не прочитана; сохранена только ссылка",
          { portableId: portableId, fallback: "id reference" }
        );
        continue;
      }

      entity.name = String(variable.name || "");
      if (variable.resolvedType) entity.resolvedType = String(variable.resolvedType);
      var description = safe(function () { return variable.description; }, "");
      if (description) entity.description = description;
      if (safe(function () { return variable.remote; }, false) === true) entity.remote = true;
      var key = safe(function () { return variable.key; }, undefined);
      if (key) entity.key = key;

      // Коллекция и режимы
      var collectionId = safe(function () { return variable.variableCollectionId; }, undefined);
      var modeNames = {};
      if (collectionId) {
        var collectionPortableId = ctx.collectionIds[collectionId];
        if (!collectionPortableId) {
          collectionPortableId = "collection:" + shortHash(String(collectionId), 8);
          ctx.collectionIds[collectionId] = collectionPortableId;
          var collection = await readCollection(collectionId);
          var collectionEntity = {
            portableId: collectionPortableId,
            sourcePixsoId: String(collectionId),
          };
          if (collection) {
            collectionEntity.name = String(collection.name || "");
            var modes = safe(function () { return collection.modes; }, []) || [];
            var portableModes = [];
            for (var m = 0; m < modes.length; m++) {
              portableModes.push({ name: String(modes[m].name || modes[m].modeId) });
              modeNames[modes[m].modeId] = String(modes[m].name || modes[m].modeId);
            }
            collectionEntity.modes = portableModes;
            var defaultModeId = safe(function () { return collection.defaultModeId; }, undefined);
            if (defaultModeId && modeNames[defaultModeId]) {
              collectionEntity.defaultModeName = modeNames[defaultModeId];
            }
            if (safe(function () { return collection.remote; }, false) === true) collectionEntity.remote = true;
            var collectionKey = safe(function () { return collection.key; }, undefined);
            if (collectionKey) collectionEntity.key = collectionKey;
          }
          ctx.pkg.variableCollections[collectionPortableId] = collectionEntity;
        } else {
          var existing = ctx.pkg.variableCollections[collectionPortableId];
          if (existing && existing.modes) {
            // восстановим карту имён режимов из уже прочитанной коллекции
            var storedCollection = await readCollection(collectionId);
            var storedModes = storedCollection ? safe(function () { return storedCollection.modes; }, []) || [] : [];
            for (var sm = 0; sm < storedModes.length; sm++) {
              modeNames[storedModes[sm].modeId] = String(storedModes[sm].name || storedModes[sm].modeId);
            }
          }
        }
        entity.collectionRef = collectionPortableId;
        addEdge(ctx, portableId, collectionPortableId, "IN_COLLECTION");
      }

      // Значения по режимам
      var valuesByMode = safe(function () { return variable.valuesByMode; }, undefined);
      if (isObject(valuesByMode)) {
        var valuesByModeName = {};
        for (var modeId in valuesByMode) {
          if (!Object.prototype.hasOwnProperty.call(valuesByMode, modeId)) continue;
          var modeName = modeNames[modeId] || modeId;
          var value = valuesByMode[modeId];
          if (isObject(value) && value.type === "VARIABLE_ALIAS" && value.id) {
            var aliasRef = ensureVariable(ctx, String(value.id));
            queue.push(String(value.id));
            valuesByModeName[modeName] = { aliasRef: aliasRef };
            addEdge(ctx, portableId, aliasRef, "ALIAS_OF");
          } else {
            valuesByModeName[modeName] = sanitizeForJson(value, 3);
          }
        }
        entity.valuesByModeName = valuesByModeName;
      }
    }
  }

  function resolveReactions(ctx) {
    if (!ctx.pendingReactions.length) return;
    for (var i = 0; i < ctx.pendingReactions.length; i++) {
      var pending = ctx.pendingReactions[i];
      var reactions = safe(function () { return pending.node.reactions; }, []) || [];
      for (var r = 0; r < reactions.length; r++) {
        var reaction = reactions[r];
        if (!isObject(reaction)) continue;
        var actions = [];
        if (reaction.actions && reaction.actions.length) {
          actions = reaction.actions;
        } else if (isObject(reaction.action)) {
          actions = [reaction.action];
        }
        if (!actions.length) actions = [null];

        for (var a = 0; a < actions.length; a++) {
          var action = actions[a];
          var entry = {
            sourceNodeRef: pending.portableId,
          };
          var trigger = sanitizeForJson(safe(function () { return reaction.trigger; }, undefined), 3);
          if (trigger !== undefined) entry.trigger = trigger;
          if (isObject(action)) {
            if (typeof action.type === "string") entry.actionType = action.type;
            var destinationId = safe(function () { return action.destinationId; }, undefined);
            if (destinationId) {
              var destinationRef = ctx.nodeIds[String(destinationId)];
              if (destinationRef) {
                entry.destinationRef = destinationRef;
              } else {
                var destinationNode = safe(function () {
                  return typeof ctx.api.getNodeById === "function" ? ctx.api.getNodeById(String(destinationId)) : null;
                }, null);
                if (destinationNode) entry.destinationName = String(destinationNode.name || "");
                ctx.diag.info(
                  DIAG.REACTION_TARGET_UNRESOLVED,
                  "reactions",
                  "Цель реакции вне выделения: " + (entry.destinationName || destinationId),
                  { portableId: pending.portableId }
                );
              }
            }
            var transition = sanitizeForJson(safe(function () { return action.transition; }, undefined), 3);
            if (transition !== undefined) entry.transition = transition;
          }
          var rawCopy = sanitizeForJson({ trigger: reaction.trigger, action: action }, 4);
          if (rawCopy !== undefined) entry.raw = rawCopy;
          ctx.pkg.reactions.push(entry);
        }
      }
    }
  }

  function buildFonts(ctx) {
    var fonts = [];
    for (var key in ctx.fontUsage) {
      if (!Object.prototype.hasOwnProperty.call(ctx.fontUsage, key)) continue;
      var parts = key.split("||");
      fonts.push({ family: parts[0], style: parts[1] || "Regular", usageCount: ctx.fontUsage[key] });
    }
    fonts.sort(function (a, b) { return b.usageCount - a.usageCount; });
    ctx.pkg.fonts = fonts;
  }

  // --- Fingerprints -------------------------------------------------------

  /** Нормализованное дерево для structuralHash: без ID, позиций на канвасе и нестабильных суффиксов. */
  function buildStructuralPayload(nodeRef, pkg, insideRoot) {
    var node = pkg.nodes[nodeRef];
    if (!node) return null;

    var payload = {
      type: node.type,
      name: node.name,
    };
    if (node.autoLayout) payload.autoLayout = node.autoLayout;
    if (node.childLayout) payload.childLayout = node.childLayout;
    if (node.constraints) payload.constraints = node.constraints;
    if (node.size) payload.size = { w: normalizeNumber(node.size.width), h: normalizeNumber(node.size.height) };
    // позиция включается только для вложенных узлов (взаимное расположение),
    // корень определения/экрана может лежать где угодно на канвасе
    if (insideRoot && node.position) {
      payload.position = { x: normalizeNumber(node.position.x), y: normalizeNumber(node.position.y) };
    }
    if (node.geometry) {
      payload.geometry = normalizeGeometryForHash(node.geometry, pkg);
    }
    if (node.corners) payload.corners = node.corners;
    if (node.effects) payload.effects = node.effects;
    if (node.styleRefs) payload.styleNames = resolveStyleNames(node.styleRefs, pkg);
    if (node.opacity !== undefined) payload.opacity = node.opacity;
    if (node.visible === false) payload.hidden = true;
    if (node.clipsContent !== undefined) payload.clipsContent = node.clipsContent;

    if (node.text) {
      payload.text = {
        characters: node.text.characters,
        fontName: node.text.fontName,
        fontSize: node.text.fontSize,
      };
    }
    if (node.icon) {
      payload.icon = { name: node.icon.normalizedName, hash: node.icon.sourceHash };
    }
    if (node.type === "INSTANCE") {
      var instance = pkg.instances[node.id];
      if (instance) {
        payload.instanceOf = instance.preset.definitionName || instance.preset.definitionRef;
        payload.variantProperties = instance.preset.variantProperties;
      }
    }
    if (node.componentPropertyReferences) {
      payload.propertyBindings = node.componentPropertyReferences;
    }

    if (node.children && node.children.length) {
      var children = [];
      for (var i = 0; i < node.children.length; i++) {
        var child = buildStructuralPayload(node.children[i], pkg, true);
        if (child) children.push(child);
      }
      payload.children = children;
    }
    return payload;
  }

  function normalizeGeometryForHash(geometry, pkg) {
    var out = sanitizeForJson(geometry, 5) || {};
    // Ссылки на изображения заменяем на content hash — одинаковые картинки
    // в разных файлах дают одинаковый отпечаток
    var lists = [out.fills, out.strokes];
    for (var l = 0; l < lists.length; l++) {
      var paints = lists[l];
      if (!paints || !paints.length) continue;
      for (var p = 0; p < paints.length; p++) {
        if (paints[p] && paints[p].imageRef && pkg.images[paints[p].imageRef]) {
          paints[p].imageContentHash = pkg.images[paints[p].imageRef].contentHash;
          delete paints[p].imageRef;
        }
      }
    }
    return out;
  }

  function resolveStyleNames(styleRefs, pkg) {
    var out = {};
    for (var slot in styleRefs) {
      if (!Object.prototype.hasOwnProperty.call(styleRefs, slot)) continue;
      var style = pkg.styles[styleRefs[slot]];
      out[slot] = style ? style.name : styleRefs[slot];
    }
    return out;
  }

  /** Контракт компонента: имя, свойства, варианты — без деталей отрисовки. */
  function buildContractPayload(entity, pkg, kind) {
    var properties = [];
    var propertyList = entity.properties || [];
    for (var i = 0; i < propertyList.length; i++) {
      var property = propertyList[i];
      properties.push({
        name: property.logicalPropertyName,
        type: property.propertyType,
        defaultValue: property.defaultValue,
        variantOptions: property.variantOptions ? property.variantOptions.slice().sort() : undefined,
      });
    }
    properties.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

    var payload = {
      kind: kind,
      name: entity.name,
      properties: properties,
    };
    if (kind === "COMPONENT_SET") {
      var groups = {};
      var groupSource = entity.variantGroupProperties || {};
      var groupNames = [];
      for (var groupName in groupSource) {
        if (Object.prototype.hasOwnProperty.call(groupSource, groupName)) groupNames.push(groupName);
      }
      groupNames.sort();
      for (var g = 0; g < groupNames.length; g++) {
        var values = (groupSource[groupNames[g]] && groupSource[groupNames[g]].values) || [];
        groups[groupNames[g]] = values.slice().sort();
      }
      payload.variantGroups = groups;

      var memberVariants = [];
      for (var c = 0; c < (entity.componentRefs || []).length; c++) {
        var member = pkg.components[entity.componentRefs[c]];
        if (member && member.variantProperties) memberVariants.push(member.variantProperties);
      }
      payload.memberVariants = memberVariants;
    }
    if (kind === "COMPONENT" && entity.variantProperties) {
      payload.variantProperties = entity.variantProperties;
    }
    return payload;
  }

  function computeFingerprints(pkg) {
    var id;
    for (id in pkg.components) {
      if (!Object.prototype.hasOwnProperty.call(pkg.components, id)) continue;
      var component = pkg.components[id];
      var contract = buildContractPayload(component, pkg, "COMPONENT");
      var tree = component.rootNodeRef ? buildStructuralPayload(component.rootNodeRef, pkg, false) : null;
      pkg.fingerprints[id] = {
        contractHash: hashCanonical(contract),
        structuralHash: hashCanonical({ contract: contract, tree: tree }),
      };
    }
    for (id in pkg.componentSets) {
      if (!Object.prototype.hasOwnProperty.call(pkg.componentSets, id)) continue;
      var set = pkg.componentSets[id];
      var setContract = buildContractPayload(set, pkg, "COMPONENT_SET");
      var setTree = set.rootNodeRef ? buildStructuralPayload(set.rootNodeRef, pkg, false) : null;
      pkg.fingerprints[id] = {
        contractHash: hashCanonical(setContract),
        structuralHash: hashCanonical({ contract: setContract, tree: setTree }),
      };
    }
    for (var r = 0; r < pkg.roots.length; r++) {
      var rootRef = pkg.roots[r].nodeRef;
      if (pkg.fingerprints[rootRef]) continue;
      var rootTree = buildStructuralPayload(rootRef, pkg, false);
      pkg.fingerprints[rootRef] = { structuralHash: hashCanonical(rootTree) };
    }
  }

  // --- Граф зависимостей ---------------------------------------------------

  function buildDependencyOrder(pkg, diag) {
    var edges = pkg.dependencies.edges;
    var nodes = {};
    var id;

    function addNode(nodeId) {
      if (nodeId && !nodes[nodeId]) nodes[nodeId] = true;
    }

    for (id in pkg.components) addNode(id);
    for (id in pkg.componentSets) addNode(id);
    for (id in pkg.styles) addNode(id);
    for (id in pkg.variables) addNode(id);
    for (id in pkg.variableCollections) addNode(id);
    for (id in pkg.images) addNode(id);
    for (id in pkg.iconDependencies) addNode("icon:" + id);
    for (var e = 0; e < edges.length; e++) {
      addNode(edges[e].from);
      addNode(edges[e].to);
    }

    // Kahn: сначала зависимости, потом зависящие
    var indegree = {};
    var unlocks = {};
    for (id in nodes) {
      indegree[id] = 0;
      unlocks[id] = [];
    }
    for (var k = 0; k < edges.length; k++) {
      var from = edges[k].from;
      var to = edges[k].to;
      if (from === to) continue;
      indegree[from] += 1;
      unlocks[to].push(from);
    }

    var queue = [];
    for (id in nodes) {
      if (indegree[id] === 0) queue.push(id);
    }
    queue.sort();

    var order = [];
    while (queue.length) {
      var current = queue.shift();
      order.push(current);
      var dependents = unlocks[current] || [];
      for (var d = 0; d < dependents.length; d++) {
        indegree[dependents[d]] -= 1;
        if (indegree[dependents[d]] === 0) queue.push(dependents[d]);
      }
    }

    var remaining = [];
    for (id in nodes) {
      if (order.indexOf(id) < 0) remaining.push(id);
    }
    if (remaining.length) {
      remaining.sort();
      for (var m = 0; m < remaining.length; m++) order.push(remaining[m]);
      diag.warn(
        DIAG.DEPENDENCY_CYCLE,
        "graph",
        "Обнаружен цикл зависимостей: " + remaining.join(", "),
        { fallback: "appended after topological order" }
      );
    }

    pkg.dependencies.order = order;
  }

  // =========================================================================
  // 15. Оркестратор экспорта и анализ выделения
  // =========================================================================

  function validateSelection(api) {
    var selection = safe(function () { return api.currentPage.selection; }, []) || [];
    if (!selection.length) {
      throw new Error("Выделите хотя бы один узел: компонент, инстанс, фрейм или экран.");
    }
    return selection;
  }

  /** Корни всей текущей страницы. PAGE сам не сериализуется: переносим именно
   * его canvas-детей, сохраняя порядок и абсолютные координаты. */
  function getCurrentPageRoots(api) {
    var page = safe(function () { return api.currentPage; }, null);
    var children = page && safe(function () { return page.children; }, []) || [];
    if (!children.length) throw new Error("Текущая страница не содержит переносимых узлов.");
    return children;
  }

  async function exportFullPackage(api, options, hooks) {
    hooks = hooks || {};
    var selection = hooks.rootsOverride || hooks.selectionOverride || validateSelection(api);
    var ctx = createExportContext(api, options, hooks.collectBinary);
    if (ctx.options.visualSnapshotMode || hooks.snapshotScreenInstances) {
      ctx.pkg.transferMode = "VISUAL_SNAPSHOT";
      // Экранный snapshot самодостаточен: component definitions намеренно не
      // используются как источник визуального дерева.
      ctx.options.includeComponentDependencies = false;
      ctx.options.includeInstanceSubtrees = true;
    }
    if (hooks.onProgress) ctx.onProgress = hooks.onProgress;

    reportProgress(ctx, "Сериализация узлов");

    for (var i = 0; i < selection.length; i++) {
      var root = selection[i];
      if (!root) continue;

      // Рёбра зависимостей узлов корневого дерева вешаются на сам корень.
      // makePortableId идемпотентен, поэтому предвычисление даёт тот же id,
      // который получит узел при сериализации.
      var rootEntityId = makePortableId(ctx, "node", root.name, root.id);
      ctx.entityStack.push(rootEntityId);
      var rootPortableId = serializeNodeTree(root, ctx, {
        // Экспорт страницы предназначен для визуального переноса, поэтому
        // instance нельзя оставлять ссылкой на библиотечное определение.
        forceInstanceSubtrees: ctx.pkg.transferMode === "VISUAL_SNAPSHOT",
      });
      ctx.entityStack.pop();
      if (!rootPortableId) continue;

      var absolute = safe(function () { return root.absoluteTransform; }, undefined);
      var absoluteX = absolute && absolute[0] ? numberOr(absolute[0][2], undefined) : undefined;
      var absoluteY = absolute && absolute[1] ? numberOr(absolute[1][2], undefined) : undefined;
      if (absoluteX === undefined) absoluteX = numberOr(safe(function () { return root.x; }, 0), 0);
      if (absoluteY === undefined) absoluteY = numberOr(safe(function () { return root.y; }, 0), 0);

      var zIndex = i;
      var parent = safe(function () { return root.parent; }, null);
      if (parent) {
        var siblings = safe(function () { return parent.children; }, []) || [];
        for (var s = 0; s < siblings.length; s++) {
          if (siblings[s] === root) {
            zIndex = s;
            break;
          }
        }
      }

      ctx.pkg.roots.push({
        nodeRef: rootPortableId,
        absolutePosition: { x: round2(absoluteX), y: round2(absoluteY) },
        zIndex: zIndex,
        pageName: safe(function () { return api.currentPage.name; }, undefined),
      });
    }

    if (!ctx.pkg.roots.length) {
      throw new Error("Не удалось сериализовать выделенные узлы.");
    }

    await runSvgJobs(ctx);
    await resolveImages(ctx);
    await resolveVariables(ctx);
    reportProgress(ctx, "Реакции и шрифты");
    resolveReactions(ctx);
    buildFonts(ctx);
    reportProgress(ctx, "Fingerprints");
    computeFingerprints(ctx.pkg);
    buildDependencyOrder(ctx.pkg, ctx.diag);

    return ctx.pkg;
  }

  function countNodesByType(pkg) {
    var counts = {};
    for (var id in pkg.nodes) {
      if (!Object.prototype.hasOwnProperty.call(pkg.nodes, id)) continue;
      var type = pkg.nodes[id].type;
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  async function analyzeSelection(api, options) {
    var pkg = await exportFullPackage(api, options, { collectBinary: false });
    var byType = countNodesByType(pkg);

    var iconUsage = 0;
    var iconUnique = 0;
    for (var iconName in pkg.iconDependencies) {
      if (!Object.prototype.hasOwnProperty.call(pkg.iconDependencies, iconName)) continue;
      iconUnique += 1;
      iconUsage += pkg.iconDependencies[iconName].usageCount;
    }

    var roots = [];
    for (var r = 0; r < pkg.roots.length; r++) {
      var rootNode = pkg.nodes[pkg.roots[r].nodeRef];
      if (rootNode) roots.push({ name: rootNode.name, type: rootNode.type });
    }

    var warnings = [];
    for (var d = 0; d < pkg.diagnostics.length; d++) {
      if (pkg.diagnostics[d].severity !== "INFO") warnings.push(pkg.diagnostics[d]);
    }

    var json = JSON.stringify(pkg);

    return {
      roots: roots,
      counts: {
        nodesTotal: Object.keys(pkg.nodes).length,
        byType: byType,
        components: Object.keys(pkg.components).length,
        componentSets: Object.keys(pkg.componentSets).length,
        instances: Object.keys(pkg.instances).length,
        styles: Object.keys(pkg.styles).length,
        variables: Object.keys(pkg.variables).length,
        images: Object.keys(pkg.images).length,
        iconsUnique: iconUnique,
        iconsUsage: iconUsage,
        fonts: pkg.fonts.length,
        reactions: pkg.reactions.length,
      },
      warnings: warnings,
      diagnosticsTotal: pkg.diagnostics.length,
      estimatedSizeBytes: json.length,
    };
  }

  // =========================================================================
  // 16. UI-мост и bootstrap
  // =========================================================================

  function post(api, payload) {
    if (api && api.ui && typeof api.ui.postMessage === "function") {
      api.ui.postMessage(payload);
    }
  }

  function notify(api, message) {
    if (api && typeof api.notify === "function" && message) {
      api.notify(message);
    }
  }

  function buildSelectionSummary(api) {
    var selection = safe(function () { return api.currentPage.selection; }, []) || [];
    var items = [];
    for (var i = 0; i < selection.length && i < 10; i++) {
      items.push({
        name: String(selection[i].name || ""),
        type: String(selection[i].type || ""),
      });
    }
    return { count: selection.length, items: items };
  }

  function buildExportFileName(api) {
    var selection = safe(function () { return api.currentPage.selection; }, []) || [];
    var base = selection.length === 1
      ? slugify(selection[0].name)
      : "selection-" + selection.length;
    var now = new Date();
    var stamp =
      String(now.getFullYear()) +
      ("0" + (now.getMonth() + 1)).slice(-2) +
      ("0" + now.getDate()).slice(-2) +
      "-" +
      ("0" + now.getHours()).slice(-2) +
      ("0" + now.getMinutes()).slice(-2);
    return base + "-full-" + stamp + ".json";
  }

  function setupPlugin(api) {
    if (!api || typeof api.showUI !== "function") {
      return;
    }

    api.showUI(__html__, {
      width: 520,
      height: 760,
      title: "Portable Exporter",
    });

    function sendInit() {
      post(api, {
        type: "init",
        pluginVersion: PLUGIN_VERSION,
        fileName: safe(function () { return api.root.name; }, "Untitled"),
        pageName: safe(function () { return api.currentPage.name; }, ""),
        selection: buildSelectionSummary(api),
        features: detectFeatures(api),
      });
    }

    if (typeof api.on === "function") {
      try {
        api.on("selectionchange", function () {
          post(api, { type: "selection-changed", selection: buildSelectionSummary(api) });
        });
      } catch (_e) { /* событие недоступно */ }
    }

    api.ui.onmessage = async function (rawMessage) {
      var message = rawMessage && rawMessage.pluginMessage ? rawMessage.pluginMessage : rawMessage;
      if (!message || !message.type) return;

      if (message.type === "ui-ready") {
        sendInit();
        return;
      }

      if (message.type === "analyze-selection") {
        try {
          var analysis = await analyzeSelection(api, message.options || {});
          post(api, { type: "analysis-result", analysis: analysis });
        } catch (error) {
          post(api, {
            type: "export-error",
            stage: "analyze",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message.type === "export-full") {
        try {
          var options = message.options || {};
          var pkg = await exportFullPackage(api, options, {
            rootsOverride: message.scope === "CURRENT_PAGE" ? getCurrentPageRoots(api) : undefined,
            // В режиме страницы отдаём готовое визуальное дерево. Это больше
            // по размеру, но позволяет Figma собрать именно экран, а не набор
            // дефолтных вариантов компонентов.
            snapshotScreenInstances: message.scope === "CURRENT_PAGE",
            onProgress: function (stage) {
              post(api, { type: "export-progress", stage: stage });
            },
          });
          var json = options.prettyJson === false
            ? JSON.stringify(pkg)
            : JSON.stringify(pkg, null, 2);
          post(api, {
            type: "export-success",
            json: json,
            fileName: buildExportFileName(api),
            sizeBytes: json.length,
            diagnostics: pkg.diagnostics,
          });
          notify(api, "Portable JSON готов");
        } catch (error) {
          post(api, {
            type: "export-error",
            stage: "export",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message.type === "notify") {
        notify(api, String(message.message || ""));
        return;
      }

      if (message.type === "close" && typeof api.closePlugin === "function") {
        api.closePlugin();
      }
    };
  }

  if (typeof pixso !== "undefined") {
    setupPlugin(pixso);
  } else if (typeof figma !== "undefined") {
    setupPlugin(figma);
  }

  // =========================================================================
  // 17. Экспорт для тестов
  // =========================================================================

  var exported = {
    PLUGIN_VERSION: PLUGIN_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    PACKAGE_FORMAT: PACKAGE_FORMAT,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    DIAG: DIAG,
    safe: safe,
    sha256Hex: sha256Hex,
    utf8FromBytes: utf8FromBytes,
    base64FromBytes: base64FromBytes,
    canonicalStringify: canonicalStringify,
    hashCanonical: hashCanonical,
    slugify: slugify,
    normalizeIconName: normalizeIconName,
    stripPropertySuffix: stripPropertySuffix,
    parseVariantName: parseVariantName,
    sanitizeForJson: sanitizeForJson,
    detectFeatures: detectFeatures,
    detectIcon: detectIcon,
    createExportContext: createExportContext,
    serializeNodeTree: serializeNodeTree,
    exportComponentEntity: exportComponentEntity,
    exportComponentSetEntity: exportComponentSetEntity,
    buildStructuralPayload: buildStructuralPayload,
    buildContractPayload: buildContractPayload,
    computeFingerprints: computeFingerprints,
    buildDependencyOrder: buildDependencyOrder,
    exportFullPackage: exportFullPackage,
    analyzeSelection: analyzeSelection,
    validateSelection: validateSelection,
    getCurrentPageRoots: getCurrentPageRoots,
    buildExportFileName: buildExportFileName,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})();
