/* Pixso → Figma Importer. Deliberately dependency-free for Figma dev-plugin use. */
(function () {
  "use strict";
  var FORMAT = "pixso-portable-package";

  /**
   * Режим миграции. Приходит явно в payload каждой задачи, а не выводится из
   * наличия component-payload.
   *
   * FAST — приёмник собирает пришедшее визуальное дерево обычными узлами и
   * ничего не реконструирует: ни определений, ни служебной страницы, ни
   * промоушена snapshot-ов в компоненты.
   * FULL — существующий component-aware путь целиком.
   *
   * Compatibility default — FULL: пакет от старого отправителя, в котором поля
   * mode нет, обязан импортироваться ровно как раньше.
   */
  var MIGRATION_MODE = { FAST: "FAST", FULL: "FULL" };
  var DEFAULT_MIGRATION_MODE = MIGRATION_MODE.FULL;

  function normalizeMigrationMode(value) {
    var raw = String(value === undefined || value === null ? "" : value).toUpperCase();
    if (raw === MIGRATION_MODE.FAST) return MIGRATION_MODE.FAST;
    if (raw === MIGRATION_MODE.FULL) return MIGRATION_MODE.FULL;
    return DEFAULT_MIGRATION_MODE;
  }

  function warn(report, message) { report.warnings.push(message); }
  function finite(value, fallback) { return typeof value === "number" && isFinite(value) ? value : fallback; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function bytesFromBase64(value) {
    var binary = atob(value || ""), out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  function isContainer(type) { return /^(FRAME|SECTION|GROUP|COMPONENT|COMPONENT_SET|INSTANCE|UNSUPPORTED)$/.test(type); }
  function canHaveChildren(node) { return node && typeof node.appendChild === "function"; }
  /** Любое обращение к свойству удалённого узла бросает "in get_parent: The node
   * with id ... does not exist", поэтому живость проверяется только так. */
  // ===========================================================================
  // Кеш загрузки шрифтов.
  //
  // figma.loadFontAsync для одной и той же пары family/style вызывался заново
  // на каждом текстовом узле каждого chunk. Кешируем сам Promise: параллельные
  // запросы одного шрифта сходятся в одну загрузку. Неудачная загрузка из кеша
  // вычищается — недоступный шрифт может появиться позже, а ошибку в кеше
  // ручной импорт унёс бы в следующую сессию.
  // ===========================================================================
  var fontLoadCache = Object.create(null);
  var fontLoadStats = { requests: 0, loads: 0, ms: 0 };

  function resetFontStats() { fontLoadStats = { requests: 0, loads: 0, ms: 0 }; }

  function loadFontCached(fontName) {
    if (!fontName || !fontName.family) return Promise.reject(Error("fontName пуст"));
    var key = String(fontName.family) + "::" + String(fontName.style);
    fontLoadStats.requests += 1;
    var pending = fontLoadCache[key];
    if (pending) return pending;
    var startedAt = Date.now();
    var promise = Promise.resolve()
      .then(function () { return figma.loadFontAsync(fontName); })
      .then(
        function (value) {
          fontLoadStats.loads += 1;
          fontLoadStats.ms += Date.now() - startedAt;
          return value;
        },
        function (error) { delete fontLoadCache[key]; throw error; }
      );
    fontLoadCache[key] = promise;
    return promise;
  }

  function isAlive(node) {
    if (!node) return false;
    try { return !node.removed && !!node.parent; } catch (_e) { return false; }
  }
  function isPageAlive(page) {
    if (!page) return false;
    try { return !page.removed; } catch (_e) { return false; }
  }

  function setValue(node, key, value) { try { if (value !== undefined) node[key] = value; } catch (_e) {} }

  // ===========================================================================
  // Схема свойств компонента.
  //
  // Вариант внутри COMPONENT_SET не отдаёт componentPropertyDefinitions:
  // getter бросает "Can only get component property definitions of a component
  // set or non-variant component". Публичная схема варианта живёт на его сете.
  // Идентичность варианта и владелец его схемы — разные вещи.
  // Правило структурное: ни имён компонентов, ни списков известных библиотек.
  // ===========================================================================

  // ===========================================================================
  // Происхождение узла и кооперативная отдача управления хосту.
  //
  // FAST_NATIVE — инстанс создан component-aware путём по ссылке на
  // определение. Это финальный результат: legacy-промоушен его не трогает.
  // SNAPSHOT_FALLBACK — развёрнутое дерево инстанса, единственный кандидат
  // на промоушен. Остальные узлы промоушен вообще не рассматривает.
  // FAST_PROMOTED / PROMOTED — инстанс, полученный промоушеном уже собранного
  // визуального дерева. Различать их важно: у первого нет и не должно быть
  // свойств Pixso, у второго они восстановлены component-aware путём.
  // ===========================================================================

  var ORIGIN_FAST_NATIVE = "FAST_NATIVE";
  var ORIGIN_SNAPSHOT_FALLBACK = "SNAPSHOT_FALLBACK";
  var ORIGIN_LEGACY = "LEGACY";
  var ORIGIN_FAST_PROMOTED = "FAST_PROMOTED";
  var ORIGIN_PROMOTED = "PROMOTED";

  // Мягкий бюджет непрерывной работы. Больше него — отдаём управление Figma,
  // иначе плагин на тяжёлом экране выглядит зависшим.
  var PROMOTE_SLICE_MS = 12;
  /**
   * Бюджет полнодокументного импорта. Он длится минутами, и цена самого
   * `setTimeout` умножается на число уступок: 12 мс здесь означало бы десятки
   * тысяч переключений. 50 мс — 20 кадров в секунду, интерфейс жив.
   */
  var DIRECT_SLICE_MS = 50;

  function hostYield() {
    if (typeof setTimeout !== "function") return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  /**
   * Бюджет непрерывной работы. `budgetMs` задаётся отдельно, потому что у
   * промоушена он подобран под короткие серии (12 мс), а у полнодокументного
   * импорта серия длится минутами: уступать поток каждые 12 мс там значит
   * платить за сам `setTimeout` десятки тысяч раз. 50 мс — это всё ещё 20
   * кадров в секунду, то есть живой интерфейс, но в четыре раза меньше
   * переключений.
   */
  function createSlice(report, budgetMs) {
    return { startedAt: Date.now(), report: report, budgetMs: budgetMs || PROMOTE_SLICE_MS };
  }

  /** Отдаёт управление хосту, когда текущий непрерывный кусок работы затянулся. */
  async function yieldIfNeeded(slice) {
    if (!slice) return;
    var elapsed = Date.now() - slice.startedAt;
    if (elapsed < (slice.budgetMs || PROMOTE_SLICE_MS)) return;
    var report = slice.report;
    if (report) {
      report.yieldCount += 1;
      report.sliceTotalMs += elapsed;
      if (elapsed > report.maxSliceMs) report.maxSliceMs = elapsed;
    }
    var yieldStartedAt = Date.now();
    await hostYield();
    // Сколько стоит сама уступка. Без этого замера «стало медленнее» —
    // ощущение, а не факт, и спорить с ним нечем.
    if (report) report.yieldWaitMs += Date.now() - yieldStartedAt;
    slice.startedAt = Date.now();
  }

  /**
   * Приведение результата задачи к виду, который переживёт `postMessage`.
   *
   * `figma.ui.postMessage` сериализует structured clone. Живой узел Figma —
   * не данные, а прокси движка, и попытка его передать валит ВЕСЬ вызов с
   * «in postMessage: Cannot unwrap symbol». Один такой случайно попавший в
   * отчёт узел убивал финальную задачу целиком: весь документ уже перенесён,
   * а migration объявлялась неудачной из-за отчёта о ней.
   *
   * Поэтому наружу уходят только простые данные. Всё, что клонированию не
   * поддаётся, заменяется меткой, а путь до него записывается: следующий
   * прогон назовёт виновное поле, а не просто упадёт.
   *
   * Геттеры узлов умеют бросать, поэтому каждое чтение защищено.
   */
  var PLAIN_MAX_DEPTH = 24;
  var PLAIN_MAX_NODES = 400000;

  function isPlainObject(value) {
    var proto;
    try { proto = Object.getPrototypeOf(value); } catch (_e) { return false; }
    return proto === Object.prototype || proto === null;
  }

  function directPlainValue(input) {
    var stripped = [];
    var seen = typeof Set === "function" ? new Set() : null;
    var budget = { left: PLAIN_MAX_NODES };

    function mark(path, what) {
      if (stripped.length < 40) stripped.push((path || "<корень>") + ": " + what);
      return "[не сериализуется: " + what + "]";
    }

    function walk(value, path, depth) {
      if (value === null) return null;
      var type = typeof value;
      if (type === "string" || type === "number" || type === "boolean") {
        return type === "number" && !isFinite(value) ? null : value;
      }
      if (type === "undefined") return undefined;
      if (type === "function") return mark(path, "функция");
      if (type === "symbol") return mark(path, "symbol");
      if (type === "bigint") return mark(path, "bigint");
      if (type !== "object") return mark(path, type);

      if (budget.left-- <= 0) return mark(path, "превышен бюджет отчёта");
      if (depth > PLAIN_MAX_DEPTH) return mark(path, "слишком глубокая структура");
      if (seen) {
        if (seen.has(value)) return mark(path, "циклическая ссылка");
        seen.add(value);
      }

      var result;
      if (Array.isArray(value)) {
        result = [];
        for (var i = 0; i < value.length; i++) {
          var item;
          try { item = value[i]; } catch (_eItem) { result.push(mark(path + "[" + i + "]", "чтение бросило")); continue; }
          var walked = walk(item, path + "[" + i + "]", depth + 1);
          result.push(walked === undefined ? null : walked);
        }
      } else if (isPlainObject(value)) {
        result = {};
        var keys;
        try { keys = Object.keys(value); } catch (_eKeys) { keys = []; }
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          var child;
          try { child = value[key]; } catch (_eRead) { result[key] = mark(path ? path + "." + key : key, "чтение бросило"); continue; }
          var next = walk(child, path ? path + "." + key : key, depth + 1);
          if (next !== undefined) result[key] = next;
        }
      } else {
        // Прокси узла Figma, Map, Set, Date и прочее, что не является
        // простыми данными. Тип читаем осторожно — геттер умеет бросать.
        var label = "объект";
        try {
          if (value && typeof value.type === "string" && typeof value.id === "string") {
            label = "узел Figma " + value.type;
          } else if (value.constructor && value.constructor.name) {
            label = value.constructor.name;
          }
        } catch (_eLabel) { /* метка не обязана читаться */ }
        result = mark(path, label);
      }
      if (seen) seen.delete(value);
      return result;
    }

    return { value: walk(input, "", 0), stripped: stripped };
  }

  function nodeType(node) {
    try { return node && node.type ? node.type : null; } catch (_e) { return null; }
  }

  function readComponentPropertyDefinitions(node) {
    if (!node || typeof node !== "object") return {};
    try {
      var definitions = node.componentPropertyDefinitions;
      return definitions && typeof definitions === "object" ? definitions : {};
    } catch (_e) {
      // Недоступная схема — это факт о документе, а не повод падать.
      return {};
    }
  }

  /** Владелец схемы: сам компонент либо его COMPONENT_SET. */
  function propertyDefinitionOwner(component) {
    if (!component || typeof component !== "object") return null;
    var parent = null;
    try { parent = component.parent && typeof component.parent === "object" ? component.parent : null; } catch (_e) { parent = null; }
    if (nodeType(component) === "COMPONENT" && parent && nodeType(parent) === "COMPONENT_SET") return parent;
    return component;
  }

  function getComponentPropertyDefinitions(component, state) {
    var owner = propertyDefinitionOwner(component);
    if (state && state.report && owner && owner !== component) {
      state.report.variantSchemaViaSet += 1;
    }
    return readComponentPropertyDefinitions(owner);
  }
  function applyChildConstraints(target, source) {
    if (!target || !source || !source.constraints) return;
    setValue(target, "constraints", clone(source.constraints));
  }
  function sanitizeChildLayout(layout, size) {
    var out = clone(layout || {});
    var width = size && finite(size.width, null);
    var height = size && finite(size.height, null);
    var epsilon = 0.05;

    // Pixso resolved-instance может отдать унаследованный min/max,
    // который уже не действует на его фактическую snapshot-геометрию.
    // Figma, напротив, сразу применяет этот bound и раздувает слой.
    // Противоречащий bound отбрасываем, фактический size — source of truth.
    if (width !== null) {
      if (typeof out.minWidth === "number" && out.minWidth > width + epsilon) delete out.minWidth;
      if (typeof out.maxWidth === "number" && out.maxWidth < width - epsilon) delete out.maxWidth;
    }
    if (height !== null) {
      if (typeof out.minHeight === "number" && out.minHeight > height + epsilon) delete out.minHeight;
      if (typeof out.maxHeight === "number" && out.maxHeight < height - epsilon) delete out.maxHeight;
    }
    return out;
  }
  function applyFigmaChildSizing(target, layout, parentSource) {
    if (!target || !layout) return;
    var parentMode = parentSource && parentSource.autoLayout && parentSource.autoLayout.layoutMode;
    if (parentMode !== "HORIZONTAL" && parentMode !== "VERTICAL") {
      try { parentMode = target.parent && target.parent.layoutMode; } catch (_eParentMode) {}
    }
    if (parentMode !== "HORIZONTAL" && parentMode !== "VERTICAL") return;

    var mainSizing = parentMode === "HORIZONTAL" ? layout.layoutSizingHorizontal : layout.layoutSizingVertical;
    var crossSizing = parentMode === "HORIZONTAL" ? layout.layoutSizingVertical : layout.layoutSizingHorizontal;

    function fixOwnAxis(axis) {
      var ownMode;
      try { ownMode = target.layoutMode; } catch (_eOwnMode) {}
      if (ownMode !== "HORIZONTAL" && ownMode !== "VERTICAL") return;
      setValue(target, ownMode === axis ? "primaryAxisSizingMode" : "counterAxisSizingMode", "FIXED");
    }

    // Pixso и Figma используют одинаковые слова HUG/FILL, но во многих
    // версиях Plugin API layoutSizing* не записывается. Надёжный
    // эквивалент: grow по главной оси и stretch по поперечной.
    if (mainSizing === "FILL") {
      fixOwnAxis(parentMode);
      setValue(target, "layoutGrow", 1);
    }
    else if (mainSizing === "FIXED" || mainSizing === "HUG") setValue(target, "layoutGrow", 0);

    if (crossSizing === "FILL") {
      fixOwnAxis(parentMode === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL");
      setValue(target, "layoutAlign", "STRETCH");
    }
    else if (crossSizing === "FIXED" || crossSizing === "HUG") setValue(target, "layoutAlign", "INHERIT");
  }
  function setPluginData(node, key, value) {
    if (!node || typeof node.setPluginData !== "function" || value === undefined || value === null) return;
    try {
      var serialized = typeof value === "string" ? value : JSON.stringify(value);
      // Не раздуваем document metadata и не упираемся в лимиты host API.
      if (serialized.length <= 20000) node.setPluginData(key, serialized);
    } catch (_e) {}
  }
  function isSvgRootNode(node) {
    try { return !!(node && typeof node.getPluginData === "function" && node.getPluginData("pixsoSvgRoot") === "1"); }
    catch (_e) { return false; }
  }
  function compactComponentProperties(properties) {
    var out = {};
    Object.keys(properties || {}).forEach(function (name) {
      var entry = properties[name];
      if (!entry) return;
      out[name] = { type: entry.type, value: entry.value };
    });
    return out;
  }
  function attachInstanceMetadata(node, src, state, isSnapshot, origin) {
    if (!src || src.type !== "INSTANCE") return;
    var instance = state.pkg.instances && state.pkg.instances[src.id];
    var preset = instance && instance.preset;
    if (!preset) return;
    // Происхождение узла: по нему промоушен отличает финальный нативный
    // результат от snapshot-дерева, не заглядывая в имена слоёв.
    if (origin) setPluginData(node, "pixsoImportOrigin", origin);
    setPluginData(node, "pixsoSemanticType", isSnapshot ? "INSTANCE_SNAPSHOT" : "INSTANCE");
    setPluginData(node, "pixsoDefinitionName", preset.definitionName || "");
    setPluginData(node, "pixsoDefinitionSetName", preset.definitionSetName || "");
    setPluginData(node, "pixsoInstancePreset", {
      definitionName: preset.definitionName,
      definitionSetName: preset.definitionSetName,
      variantProperties: preset.variantProperties || {},
      componentProperties: compactComponentProperties(preset.componentProperties),
    });
    if (isSnapshot) state.report.semanticSnapshots += 1;
  }
  function mapPaint(paint, images, report) {
    if (!paint || paint.visible === false || paint.type === "UNSUPPORTED") return null;
    var out = clone(paint);
    delete out.imageRef; delete out.imageContentHash;
    if (out.type === "SOLID" && out.color && typeof out.color.a === "number") {
      out.opacity = (typeof out.opacity === "number" ? out.opacity : 1) * out.color.a;
      delete out.color.a;
    }
    if (paint.type === "IMAGE") {
      var image = images[paint.imageRef];
      if (!image) { warn(report, "Изображение без данных: " + (paint.imageRef || "unknown")); return null; }
      out.imageHash = image.hash;
    }
    return out;
  }
  function applyPaints(node, field, paints, images, report) {
    if (!paints) return;
    if (!paints.length) { setValue(node, field, []); return; }
    var result = [];
    for (var i = 0; i < paints.length; i++) { var paint = mapPaint(paints[i], images, report); if (paint) result.push(paint); }
    // Если все paints скрыты/неподдержаны, явно очищаем поле.
    // Иначе LineNode и некоторые shapes оставляют чёрный default stroke.
    setValue(node, field, result);
  }
  /** Style — не scene node: у него нет parent, и isAlive тут неприменим. */
  function isStyleAlive(style) {
    if (!style) return false;
    try { return !style.removed; } catch (_e) { return false; }
  }

  async function createLocalStyles(state) {
    var entries = state.pkg.styles || {};
    var ids = Object.keys(entries);
    // Один локальный стиль на job, а не по копии на каждый chunk. Это реестр
    // СОЗДАННЫХ узлов Figma, а не дедупликация ассетов: пакет по-прежнему
    // приезжает самодостаточным и несёт полные данные своих стилей.
    var jobStyles = (state.registry && state.registry.styles) || null;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], source = entries[id], style = null;
      if (jobStyles && isStyleAlive(jobStyles[id])) {
        state.styles[id] = jobStyles[id];
        continue;
      }
      try {
        if (source.styleType === "PAINT" && typeof figma.createPaintStyle === "function") {
          var paints = [];
          (source.paints || []).forEach(function (paint) {
            var mapped = mapPaint(paint, state.images, state.report);
            if (mapped) paints.push(mapped);
          });
          if (!paints.length) continue;
          style = figma.createPaintStyle();
          style.paints = paints;
        } else if (source.styleType === "TEXT" && typeof figma.createTextStyle === "function") {
          style = figma.createTextStyle();
          var textProps = source.textProps || {};
          if (textProps.fontName) {
            try { await loadFontCached(textProps.fontName); style.fontName = textProps.fontName; }
            catch (_eFont) { warn(state.report, "Шрифт text style недоступен: " + textProps.fontName.family); }
          }
          ["fontSize", "letterSpacing", "lineHeight", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent"].forEach(function (key) {
            setValue(style, key, textProps[key]);
          });
        } else if (source.styleType === "EFFECT" && typeof figma.createEffectStyle === "function") {
          style = figma.createEffectStyle();
          style.effects = clone(source.effects || []);
        }
        if (!style) continue;
        style.name = source.name || id;
        if (source.description) style.description = source.description;
        setPluginData(style, "pixsoPortableStyleId", id);
        state.styles[id] = style;
        if (jobStyles) jobStyles[id] = style;
        state.report.stylesCreated += 1;
      } catch (_eStyle) {
        warn(state.report, "Не удалось создать Figma style «" + (source.name || id) + "»");
      }
    }
  }
  async function applyStyleBindings(node, src, state) {
    var refs = src.styleRefs || {};
    var fill = refs.fill && state.styles[refs.fill];
    var stroke = refs.stroke && state.styles[refs.stroke];
    var effect = refs.effect && state.styles[refs.effect];
    var text = refs.text && state.styles[refs.text];
    // createNodeFromSvg возвращает frame-wrapper. Paint style на wrapper
    // закрашивает весь bounding box и превращает иконку в квадрат.
    var svgRoot = isSvgRootNode(node);
    try { if (!svgRoot && fill && typeof node.setFillStyleIdAsync === "function") await node.setFillStyleIdAsync(fill.id); } catch (_eFillStyle) {}
    try { if (!svgRoot && stroke && typeof node.setStrokeStyleIdAsync === "function") await node.setStrokeStyleIdAsync(stroke.id); } catch (_eStrokeStyle) {}
    try { if (effect && typeof node.setEffectStyleIdAsync === "function") await node.setEffectStyleIdAsync(effect.id); } catch (_eEffectStyle) {}
    try { if (text && node.type === "TEXT" && typeof node.setTextStyleIdAsync === "function") await node.setTextStyleIdAsync(text.id); } catch (_eTextStyle) {}
  }
  function applyCommon(node, src, images, report) {
    node.name = src.name || src.id || src.type;
    if (src.size && typeof node.resizeWithoutConstraints === "function") {
      try { node.resizeWithoutConstraints(Math.max(0.01, finite(src.size.width, 1)), Math.max(0.01, finite(src.size.height, 1))); } catch (_e) {}
    }
    if (src.position) { setValue(node, "x", finite(src.position.x, 0)); setValue(node, "y", finite(src.position.y, 0)); }
    ["visible", "locked", "opacity", "rotation", "blendMode", "isMask", "clipsContent", "constraints", "effects"].forEach(function (key) { setValue(node, key, src[key]); });
    var svgRoot = isSvgRootNode(node);
    if (src.geometry && !svgRoot) {
      applyPaints(node, "fills", src.geometry.fills, images, report);
      applyPaints(node, "strokes", src.geometry.strokes, images, report);
      ["strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern"].forEach(function (key) { setValue(node, key, src.geometry[key]); });
    }
    if (svgRoot) {
      // Цвета уже запечены в развёрнутом SVG. Внешний frame нужен
      // только для size/layout и должен оставаться прозрачным.
      setValue(node, "fills", []);
      setValue(node, "strokes", []);
    }
    var transparentContainer = /^(FRAME|SECTION|GROUP|COMPONENT|COMPONENT_SET|INSTANCE|UNSUPPORTED)$/.test(src.type);
    if (transparentContainer && (!src.geometry || src.geometry.fills === undefined) && !(src.styleRefs && src.styleRefs.fill)) {
      // createFrame() имеет белую заливку по умолчанию, тогда как большинство
      // структурных Pixso-контейнеров прозрачны.
      setValue(node, "fills", []);
    }
    if (src.corners) Object.keys(src.corners).forEach(function (key) { setValue(node, key, src.corners[key]); });
    if (src.autoLayout) {
      Object.keys(src.autoLayout).forEach(function (key) { setValue(node, key, src.autoLayout[key]); });
    }
    var safeChildLayout = sanitizeChildLayout(src.childLayout, src.size);
    Object.keys(safeChildLayout).forEach(function (key) { setValue(node, key, safeChildLayout[key]); });
    if (typeof node.setPluginData === "function") node.setPluginData("pixsoPortableId", src.id);
  }
  async function applyText(node, data, images, report) {
    data = data || {};
    if (data.fontName && data.fontName.family) {
      try { await loadFontCached(data.fontName); node.fontName = data.fontName; }
      catch (_e) { warn(report, "Шрифт недоступен: " + data.fontName.family + " — оставлен шрифт Figma"); }
    }
    ["fontSize", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textTruncation", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent", "letterSpacing", "lineHeight", "maxLines"].forEach(function (key) { setValue(node, key, data[key]); });
    node.characters = data.characters || "";
    applyPaints(node, "fills", data.fills, images, report);
    if (data.segments && data.segments.length) {
      for (var i = 0; i < data.segments.length; i++) {
        var s = data.segments[i];
        if (s.fontName) { try { await loadFontCached(s.fontName); node.setRangeFontName(s.start, s.end, s.fontName); } catch (_e) {} }
        if (s.fontSize) try { node.setRangeFontSize(s.start, s.end, s.fontSize); } catch (_e2) {}
        if (s.fills) try { var fills=[]; s.fills.forEach(function(p){var mapped=mapPaint(p,images,report);if(mapped)fills.push(mapped);}); node.setRangeFills(s.start,s.end,fills); } catch (_e3) {}
      }
    }
  }
  function makeNode(src, svgAssets, report) {
    if (src.type === "TEXT") return figma.createText();
    if ((src.type === "VECTOR" || src.type === "BOOLEAN_OPERATION" || src.type === "ICON") && src.svgRef && svgAssets[src.svgRef]) {
      try {
        var svgNode = figma.createNodeFromSvg(svgAssets[src.svgRef].svg || svgAssets[src.svgRef]);
        setPluginData(svgNode, "pixsoSvgRoot", "1");
        report.svgNodesCreated += 1;
        return svgNode;
      } catch (_e) { warn(report, "SVG не импортирован: " + src.name); }
    }
    if (src.type === "RECTANGLE") return figma.createRectangle();
    if (src.type === "ELLIPSE") return figma.createEllipse();
    if (src.type === "LINE") return figma.createLine();
    if (src.type === "POLYGON") return figma.createPolygon();
    if (src.type === "STAR") return figma.createStar();
    if (src.type === "COMPONENT") return figma.createComponent();
    if (isStrokeVectorFallback(src)) {
      report.vectorLineFallbacks += 1;
      return figma.createLine();
    }
    return figma.createFrame();
  }
  function isStrokeVectorFallback(src) {
    if (!src || (src.type !== "VECTOR" && src.type !== "BOOLEAN_OPERATION")) return false;
    if (src.children && src.children.length) return false;
    var geometry = src.geometry || {};
    var hasStroke = !!(src.styleRefs && src.styleRefs.stroke) || (geometry.strokes || []).some(function (paint) {
      return paint && paint.visible !== false && paint.type !== "UNSUPPORTED";
    });
    if (!hasStroke || !src.size) return false;
    var width = Math.abs(finite(src.size.width, 0));
    var height = Math.abs(finite(src.size.height, 0));
    return (height <= 1.5 && width >= 4) || (width <= 1.5 && height >= 4);
  }
  function styleImages(pkg, report) {
    var result = {};
    Object.keys(pkg.images || {}).forEach(function (id) {
      var source = pkg.images[id];
      if (!source.bytesBase64) { warn(report, "Байт-данные изображения отсутствуют: " + id); return; }
      try { result[id] = figma.createImage(bytesFromBase64(source.bytesBase64)); } catch (_e) { warn(report, "Нельзя создать изображение: " + id); }
    });
    return result;
  }
  // =========================================================================
  // Нативные инстансы из component-aware миграции.
  //
  // Экспортёр присылает ссылку на определение и публичные свойства вместо
  // развёрнутого поддерева. Ничего не выводится из имён компонентов: имя слоя
  // используется только как проверка уже найденного по индексному пути узла.
  // =========================================================================

  function nodeChildren(node) {
    try { return node && node.children ? node.children : []; } catch (_e) { return []; }
  }

  /**
   * Адрес узла внутри инстанса: индексный путь из канонического дерева
   * определения, проверенный именем. Имя в одиночку целью не является —
   * оно не уникально; неоднозначность означает отказ, а не догадку.
   */
  function findByIndexPath(root, path) {
    var current = root;
    for (var i = 0; i < (path || []).length; i++) {
      var step = path[i] || {};
      var children = nodeChildren(current);
      var candidate = children[step.index];
      if (!candidate || (step.name !== undefined && candidate.name !== step.name)) {
        var matches = children.filter(function (child) {
          return child && child.name === step.name;
        });
        candidate = matches.length === 1 ? matches[0] : null;
      }
      if (!candidate) return null;
      current = candidate;
    }
    return current;
  }

  function instancePropertyKeys(target) {
    try { return Object.keys(target.componentProperties || {}); } catch (_e) { return []; }
  }

  // Обобщённые причины потери свойства. Ни одна из них не привязана к
  // конкретной дизайн-системе: это состояния схемы и API, а не имена.
  var MISS = {
    PROPERTY_NOT_IN_SCHEMA: "PROPERTY_NOT_IN_SCHEMA",
    SCHEMA_UNAVAILABLE: "SCHEMA_UNAVAILABLE",
    TARGET_AMBIGUOUS: "TARGET_AMBIGUOUS",
    TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
    VALUE_TYPE_UNSUPPORTED: "VALUE_TYPE_UNSUPPORTED",
    VARIANT_OPTION_NOT_FOUND: "VARIANT_OPTION_NOT_FOUND",
    INSTANCE_SWAP_UNRESOLVED: "INSTANCE_SWAP_UNRESOLVED",
    SET_PROPERTIES_UNAVAILABLE: "SET_PROPERTIES_UNAVAILABLE",
    SET_PROPERTIES_THROW: "SET_PROPERTIES_THROW",
  };

  var MAX_PROPERTY_MISS_SAMPLES = 40;

  function safeNodeName(node) {
    try { return String(node && node.name || ""); } catch (_e) { return ""; }
  }

  /**
   * Потерянное свойство перестаёт быть безымянным счётчиком: причина обобщённая,
   * выборка подробностей ограничена, чтобы не давить на память.
   */
  function recordPropertyMiss(state, entry, target, reason, context, error, options) {
    var report = state.report;
    report.propertiesMissed += 1;
    report.propertyMissReasons[reason] = (report.propertyMissReasons[reason] || 0) + 1;
    if (report.propertyMissSamples.length >= MAX_PROPERTY_MISS_SAMPLES) return;
    var sample = {
      reason: reason,
      nodeRef: (context && context.nodeRef) || null,
      componentRef: (context && context.componentRef) || null,
      definitionRef: (context && context.definitionRef) || null,
      depth: (context && context.depth) || 0,
      propertyRef: entry.propertyRef || null,
      sourceName: entry.name || null,
      rawName: entry.rawName || null,
      sourceType: entry.type || null,
      requestedValue: entry.type === "INSTANCE_SWAP" ? (entry.swapComponentRef || null) : entry.value,
      targetName: safeNodeName(target),
      targetProperties: instancePropertyKeys(target).slice(0, 12),
    };
    if (options) sample.variantOptions = options.slice(0, 12);
    if (error) sample.error = error.message || String(error);
    report.propertyMissSamples.push(sample);
  }

  /**
   * Фактическое имя свойства в Figma. Порядок: id свойства из реестра job →
   * сырое имя Pixso → единственное совпадение по логическому имени.
   * Неоднозначность — отказ с названной причиной, а не выбор наугад.
   */
  function resolvePropertyBinding(target, entry, state) {
    var keys = instancePropertyKeys(target);
    if (!keys.length) return { name: null, reason: MISS.SCHEMA_UNAVAILABLE };
    var registryName = state.propertyNames && state.propertyNames[entry.propertyRef];
    if (registryName && keys.indexOf(registryName) >= 0) return { name: registryName };
    if (entry.rawName && keys.indexOf(entry.rawName) >= 0) return { name: entry.rawName };
    var logical = entry.name;
    if (!logical) return { name: null, reason: MISS.PROPERTY_NOT_IN_SCHEMA };
    var matches = keys.filter(function (key) {
      return key === logical || key.indexOf(logical + "#") === 0;
    });
    if (matches.length === 1) return { name: matches[0] };
    return { name: null, reason: matches.length ? MISS.TARGET_AMBIGUOUS : MISS.PROPERTY_NOT_IN_SCHEMA };
  }

  function resolvePropertyName(target, entry, state) {
    return resolvePropertyBinding(target, entry, state).name;
  }

  /**
   * Значение под тип свойства. Строковое "false" не должно приезжать в
   * BOOLEAN, а число — в VARIANT: Figma отвергает такой вызов целиком.
   */
  function propertyValue(entry, state) {
    if (entry.type === "INSTANCE_SWAP") {
      var component = state.registry && state.registry.defs && state.registry.defs[entry.swapComponentRef];
      if (!isAlive(component)) return undefined;
      try { return component.id; } catch (_e) { return undefined; }
    }
    var value = entry.value;
    if (entry.type === "BOOLEAN") {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return undefined;
    }
    if (entry.type === "VARIANT" || entry.type === "TEXT") {
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return undefined;
    }
    return value === undefined || value === null ? undefined : value;
  }

  async function targetPropertyDefinitions(target, state) {
    var main = null;
    try {
      main = typeof target.getMainComponentAsync === "function"
        ? await target.getMainComponentAsync()
        : target.mainComponent;
    } catch (_e) { main = null; }
    return getComponentPropertyDefinitions(main, state);
  }

  /**
   * Пакет отвергнут целиком — применяем по одному: одно негодное значение не
   * должно уносить остальные, а причина отказа должна быть названа поимённо.
   */
  async function applyPropertiesOneByOne(target, accepted, state, context) {
    var definitions = null;
    for (var i = 0; i < accepted.length; i++) {
      var single = {};
      single[accepted[i].name] = accepted[i].value;
      try {
        target.setProperties(single);
        state.report.propertiesApplied += 1;
      } catch (error) {
        if (definitions === null) definitions = await targetPropertyDefinitions(target, state);
        var definition = definitions[accepted[i].name];
        var options = definition && definition.variantOptions;
        var reason = options && options.indexOf(accepted[i].value) < 0
          ? MISS.VARIANT_OPTION_NOT_FOUND
          : MISS.SET_PROPERTIES_THROW;
        recordPropertyMiss(state, accepted[i].entry, target, reason, context, error, options);
      }
    }
  }

  async function applyPropertyStage(target, entries, state, context) {
    if (!entries || !entries.length) return;
    var props = {};
    var accepted = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var binding = resolvePropertyBinding(target, entry, state);
      if (!binding.name) {
        recordPropertyMiss(state, entry, target, binding.reason, context);
        continue;
      }
      var value = propertyValue(entry, state);
      if (value === undefined) {
        recordPropertyMiss(state, entry, target,
          entry.type === "INSTANCE_SWAP" ? MISS.INSTANCE_SWAP_UNRESOLVED : MISS.VALUE_TYPE_UNSUPPORTED,
          context);
        continue;
      }
      props[binding.name] = value;
      accepted.push({ entry: entry, name: binding.name, value: value });
    }
    if (!accepted.length) return;
    if (typeof target.setProperties !== "function") {
      for (var u = 0; u < accepted.length; u++) {
        recordPropertyMiss(state, accepted[u].entry, target, MISS.SET_PROPERTIES_UNAVAILABLE, context);
      }
      return;
    }
    try {
      target.setProperties(props);
      state.report.propertiesApplied += accepted.length;
      return;
    } catch (_batchError) { /* виновника ищем поимённо ниже */ }
    await applyPropertiesOneByOne(target, accepted, state, context);
  }

  /**
   * Свойства применяются стадиями. VARIANT меняет фактическое поддерево, а
   * значит и адреса вложенных целей, поэтому цель каждой следующей стадии
   * ищется заново — уже после применения предыдущей.
   */
  async function applyFastInstance(instance, ref, state, nodeRef) {
    if (!instance || nodeType(instance) !== "INSTANCE") return;
    var context = {
      nodeRef: nodeRef || null,
      componentRef: ref.componentRef || null,
      definitionRef: ref.definitionRef || null,
      depth: 0,
    };
    var rootEntries = (ref.properties || []).filter(function (entry) {
      // Вариант выбран самим определением: инстанс создан от нужного варианта.
      return entry.type !== "VARIANT";
    });
    await applyPropertyStage(instance, rootEntries, state, context);

    var nested = (ref.nested || []).slice().sort(function (a, b) {
      return (a.depth || 0) - (b.depth || 0);
    });
    for (var i = 0; i < nested.length; i++) {
      var nestedContext = {
        nodeRef: nodeRef || null,
        componentRef: nested[i].componentRef || null,
        definitionRef: nested[i].definitionRef || null,
        depth: nested[i].depth || 0,
      };
      var target = findByIndexPath(instance, nested[i].path);
      if (!target || nodeType(target) !== "INSTANCE") {
        state.report.nestedTargetsMissed += 1;
        for (var m = 0; m < (nested[i].properties || []).length; m++) {
          recordPropertyMiss(state, nested[i].properties[m], instance, MISS.TARGET_NOT_FOUND, nestedContext);
        }
        warn(state.report, "Вложенная цель свойств не найдена в «" + safeNodeName(instance) + "»");
        continue;
      }
      var entries = nested[i].properties || [];
      var variantEntries = entries.filter(function (entry) { return entry.type === "VARIANT"; });
      var otherEntries = entries.filter(function (entry) { return entry.type !== "VARIANT"; });
      if (variantEntries.length) {
        await applyPropertyStage(target, variantEntries, state, nestedContext);
        // Смена варианта пересобирает поддерево и может сменить сам набор
        // свойств цели: и адрес, и схему берём заново, а не из кеша.
        target = findByIndexPath(instance, nested[i].path);
        if (!target || nodeType(target) !== "INSTANCE") {
          state.report.nestedTargetsMissed += 1;
          for (var t = 0; t < otherEntries.length; t++) {
            recordPropertyMiss(state, otherEntries[t], instance, MISS.TARGET_NOT_FOUND, nestedContext);
          }
          continue;
        }
      }
      if (otherEntries.length) await applyPropertyStage(target, otherEntries, state, nestedContext);
    }
  }

  async function buildTree(id, parent, state, mode, positionOffset, depth) {
    var src = state.pkg.nodes[id];
    if (!src) { warn(state.report, "Не найден узел " + id); return null; }
    var node;
    // Развёрнутый instance из экранного экспорта — источник истины для
    // визуального переноса. Не заменяем его definition-компонентом: в таком
    // случае теряются overrides и Figma собирает дефолтный вариант.
    var resolvedScreenInstance = src.type === "INSTANCE" && mode === "screen" && src.children && src.children.length;
    // Ссылка на нативное определение: поддерева нет, есть componentRef и свойства.
    var fastRef = src.type === "INSTANCE" && src.instanceRef ? src.instanceRef : null;
    var fastComponent = null;
    if (fastRef) {
      var registryDefs = (state.registry && state.registry.defs) || {};
      fastComponent = registryDefs[fastRef.componentRef] || state.components[fastRef.componentRef] || null;
      if (!isAlive(fastComponent)) fastComponent = null;
      else {
        try { if (fastComponent.type !== "COMPONENT") fastComponent = null; } catch (_eFastType) { fastComponent = null; }
      }
    }
    if (fastRef && fastComponent) {
      node = fastComponent.createInstance();
      state.report.fastInstances += 1;
    } else if (fastRef) {
      // Определение не доехало: экран важнее, но потеря должна быть видна.
      node = figma.createFrame();
      state.report.fastInstanceMisses += 1;
      warn(state.report, "Определение компонента не найдено для «" + src.name + "»");
    } else if (resolvedScreenInstance) {
      node = figma.createFrame();
      state.report.resolvedInstances += 1;
    } else if (src.type === "INSTANCE" && mode !== "snapshot") {
      var preset = state.pkg.instances[id] && state.pkg.instances[id].preset;
      var component = preset && state.components[preset.definitionRef];
      if (component) {
        node = component.createInstance();
        if (mode === "screen" && typeof node.detachInstance === "function") {
          await applyInstanceProperties(node, preset, state);
          node = node.detachInstance();
          state.report.detachedInstances += 1;
        }
      }
      else { node = figma.createFrame(); warn(state.report, "Instance «" + src.name + "» импортирован snapshot-ом"); }
    } else node = makeNode(src, state.pkg.svgAssets || {}, state.report);
    applyCommon(node, src, state.images, state.report);
    attachInstanceMetadata(node, src, state, !!resolvedScreenInstance,
      fastRef && fastComponent ? ORIGIN_FAST_NATIVE
        : resolvedScreenInstance ? ORIGIN_SNAPSHOT_FALLBACK
        : ORIGIN_LEGACY);
    if (positionOffset && src.position) {
      setValue(node, "x", finite(src.position.x, 0) + positionOffset.x);
      setValue(node, "y", finite(src.position.y, 0) + positionOffset.y);
    }
    if (src.type === "TEXT") await applyText(node, src.text, state.images, state.report);
    await applyStyleBindings(node, src, state);
    if (parent && canHaveChildren(parent)) parent.appendChild(node);
    // Constraints в Figma валидны только относительно уже назначенного
    // frame-parent. До appendChild хост может молча отклонить STRETCH.
    if (parent) applyChildConstraints(node, src);
    // layoutGrow/layoutAlign/layoutSizing* валидны только после помещения
    // узла в auto-layout parent. Повторяем их после appendChild.
    if (parent && src.childLayout) {
      var appendedLayout = sanitizeChildLayout(src.childLayout, src.size);
      Object.keys(appendedLayout).forEach(function (key) { setValue(node, key, appendedLayout[key]); });
    }
    state.nodes[id] = node; state.report.created += 1;
    // Кандидаты промоушена собираются здесь, на этапе сборки: второй обход
    // всего дерева ради того же результата не нужен.
    if (resolvedScreenInstance && state.promotionCandidates) {
      state.promotionCandidates.push({ ref: id, source: src, depth: depth || 0 });
    }
    if (mode === "screen" && state.report.created % 250 === 0) {
      try { figma.ui.postMessage({ type: "import-progress", created: state.report.created }); } catch (_eProgress) {}
    }
    if (fastRef && fastComponent) await applyFastInstance(node, fastRef, state, id);
    else if (src.type === "INSTANCE" && state.pkg.instances[id] && !resolvedScreenInstance) await applyInstancePreset(node, state.pkg.instances[id].preset, state);
    if (src.children && src.children.length && canHaveChildren(node)) {
      for (var i = 0; i < src.children.length; i++) {
        await buildTree(src.children[i], node, state, mode, null, (depth || 0) + 1);
      }
    }
    return node;
  }
  function finalizeTree(ref, state, isRoot, parentSource) {
    var source = state.pkg.nodes[ref], target = state.nodes[ref];
    if (!source || !target) return;
    (source.children || []).forEach(function (childRef) {
      finalizeTree(childRef, state, false, source);
    });

    // Добавление детей и загрузка текста могут повторно изменить HUG/FILL.
    // Возвращаем параметры контейнера после того, как subtree уже готово.
    if (source.autoLayout) {
      Object.keys(source.autoLayout).forEach(function (key) { setValue(target, key, source.autoLayout[key]); });
    }

    var layout = sanitizeChildLayout(source.childLayout, source.size);
    var parentHasAutoLayout = !!(parentSource && parentSource.autoLayout);
    var absolute = layout.layoutPositioning === "ABSOLUTE";
    if (source.size && typeof target.resizeWithoutConstraints === "function") {
      var exactWidth = isRoot || !parentHasAutoLayout || absolute || layout.layoutSizingHorizontal === "FIXED";
      var exactHeight = isRoot || !parentHasAutoLayout || absolute || layout.layoutSizingVertical === "FIXED";
      if (exactWidth || exactHeight) {
        try {
          target.resizeWithoutConstraints(
            exactWidth ? Math.max(0.01, finite(source.size.width, 1)) : target.width,
            exactHeight ? Math.max(0.01, finite(source.size.height, 1)) : target.height
          );
        } catch (_eResize) {}
      }
    }

    Object.keys(layout).forEach(function (key) { setValue(target, key, layout[key]); });
    applyFigmaChildSizing(target, layout, parentSource);
    applyChildConstraints(target, source);
    if (source.position && (!parentHasAutoLayout || absolute)) {
      setValue(target, "x", finite(source.position.x, 0));
      setValue(target, "y", finite(source.position.y, 0));
    }
  }
  function sortedObject(value) {
    var out = {};
    Object.keys(value || {}).sort().forEach(function (key) { out[key] = value[key]; });
    return out;
  }
  /**
   * Семантическая идентичность инстанса: по ней одинаковые occurrences
   * получают один локальный компонент.
   *
   * Устойчивые исходные id сильнее видимых имён и имеют приоритет: два разных
   * компонента с именем «Button» не сливаются. Имена остаются фоллбеком для
   * пакетов, в которых id нет (FULL и старый ручной экспорт), — их подпись
   * при этом побайтно та же, что и раньше.
   */
  function semanticSignature(preset) {
    if (!preset) return "";
    var componentId = preset.sourceComponentId || "";
    var setId = preset.sourceComponentSetId || "";
    if (componentId || setId) {
      return JSON.stringify({
        componentId: componentId,
        setId: setId,
        variants: sortedObject(preset.variantProperties || {}),
      });
    }
    if (!preset.definitionName && !preset.definitionSetName) return "";
    return JSON.stringify({
      set: preset.definitionSetName || "",
      component: preset.definitionName || "",
      variants: sortedObject(preset.variantProperties || {}),
    });
  }
  /**
   * Ключ набора вариантов. Тоже сначала исходный id: объединять компоненты в
   * ComponentSet по совпадению видимого имени — это угадывание, а по общему
   * COMPONENT_SET источника — факт. Пакеты без id сохраняют прежний ключ.
   */
  function variantSetKey(preset) {
    if (!preset) return "";
    if (preset.sourceComponentSetId) return "id:" + preset.sourceComponentSetId;
    if (preset.sourceComponentId) return "";
    return preset.definitionSetName ? "name:" + preset.definitionSetName : "";
  }
  function variantSetName(preset) {
    return (preset && preset.definitionSetName) || "Pixso Component Set";
  }
  function variantComponentName(preset) {
    var variants = preset && preset.variantProperties || {};
    var names = Object.keys(variants).sort();
    if (names.length) return names.map(function (name) { return name + "=" + variants[name]; }).join(", ");
    return preset && preset.definitionName || "Pixso Component";
  }
  /**
   * Группы кандидатов промоушена.
   *
   * Кандидаты собраны на этапе сборки дерева, поэтому второго обхода всего
   * импортированного дерева здесь нет. Нативный инстанс, созданный
   * component-aware путём, кандидатом не является по построению: у него нет
   * развёрнутого поддерева, а его цель в Figma — INSTANCE, а не FRAME.
   */
  function collectSemanticGroups(pkg, state) {
    var groups = {};
    var candidates = state.promotionCandidates || [];
    var report = state.report;
    report.promoteScanNodes = candidates.length;
    report.nodesSkippedFromPromoteScan = Math.max(0, report.created - candidates.length);

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var source = candidate.source || (pkg.nodes && pkg.nodes[candidate.ref]);
      if (!source) continue;
      var entity = pkg.instances && pkg.instances[source.id];
      var preset = entity && entity.preset;
      var signature = semanticSignature(preset);
      if (!signature) continue;
      var target = state.nodes[source.id];
      var targetType = null;
      try { targetType = target && !target.removed ? target.type : null; } catch (_eType) { targetType = null; }
      // Уже нативный результат промоушен не пересобирает.
      if (targetType !== "FRAME") {
        report.nativeSubtreesPruned += 1;
        continue;
      }
      if (!groups[signature]) {
        groups[signature] = { signature: signature, preset: preset, candidates: [], maxDepth: candidate.depth };
      }
      groups[signature].candidates.push(candidate);
      groups[signature].maxDepth = Math.max(groups[signature].maxDepth, candidate.depth);
    }

    var list = [];
    for (var key in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, key)) list.push(groups[key]);
    }
    report.promoteCandidates = candidates.length - report.nativeSubtreesPruned;
    return list.sort(function (a, b) { return b.maxDepth - a.maxDepth; });
  }
  function matchingChildren(source, target) {
    var sourceChildren = source && source.children || [];
    var targetChildren = target && target.children || [];
    var used = {};
    return sourceChildren.map(function (sourceChild, sourceIndex) {
      var direct = targetChildren[sourceIndex];
      if (direct && direct.name === sourceChild.name) { used[sourceIndex] = true; return [sourceChild, direct]; }
      for (var i = 0; i < targetChildren.length; i++) {
        if (!used[i] && targetChildren[i].name === sourceChild.name) { used[i] = true; return [sourceChild, targetChildren[i]]; }
      }
      return [sourceChild, direct || null];
    });
  }
  async function copySnapshotOverrides(source, target, state) {
    if (!source || !target) return;
    if (source.type === "TEXT" && target.type === "TEXT" && source.characters !== target.characters) {
      try { target.characters = source.characters; state.report.textOverridesRestored += 1; }
      catch (_eText) { warn(state.report, "Текстовый override не восстановлен: " + source.name); }
    }
    if (source.visible !== target.visible) setValue(target, "visible", source.visible);
    if (source.opacity !== target.opacity) setValue(target, "opacity", source.opacity);
    try { if (source.constraints) target.constraints = clone(source.constraints); } catch (_eConstraints) {}
    ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerSmoothing"].forEach(function (key) {
      try { if (typeof source[key] === "number" && source[key] !== target[key]) target[key] = source[key]; } catch (_eCorner) {}
    });
    ["strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern"].forEach(function (key) {
      try {
        var sourceValue = source[key];
        if (sourceValue !== undefined) {
          target[key] = Array.isArray(sourceValue) ? sourceValue.slice() : sourceValue;
          state.report.strokeOverridesRestored += 1;
        }
      } catch (_eStroke) {}
    });
    ["fills", "strokes", "effects"].forEach(function (key) {
      try { if (Array.isArray(source[key])) target[key] = clone(source[key]); } catch (_eVisualOverride) {}
    });
    var stylePairs = [
      ["fillStyleId", "setFillStyleIdAsync"],
      ["strokeStyleId", "setStrokeStyleIdAsync"],
      ["effectStyleId", "setEffectStyleIdAsync"],
      ["textStyleId", "setTextStyleIdAsync"],
    ];
    for (var styleIndex = 0; styleIndex < stylePairs.length; styleIndex++) {
      try {
        var sourceStyleId = source[stylePairs[styleIndex][0]];
        var targetStyleId = target[stylePairs[styleIndex][0]];
        var setter = target[stylePairs[styleIndex][1]];
        if (typeof sourceStyleId === "string" && sourceStyleId && sourceStyleId !== targetStyleId && typeof setter === "function") {
          await setter.call(target, sourceStyleId);
          state.report.styleOverridesRestored += 1;
        }
      } catch (_eStyleOverride) {}
    }

    if (source.type === "INSTANCE" && target.type === "INSTANCE" && typeof target.swapComponent === "function") {
      try {
        var sourceMain = typeof source.getMainComponentAsync === "function" ? await source.getMainComponentAsync() : source.mainComponent;
        var targetMain = typeof target.getMainComponentAsync === "function" ? await target.getMainComponentAsync() : target.mainComponent;
        if (sourceMain && (!targetMain || sourceMain.id !== targetMain.id)) {
          target.swapComponent(sourceMain);
          state.report.nestedSwapsRestored += 1;
        }
      } catch (_eSwap) {}
    }

    state.report.overrideNodesVisited += 1;
    await yieldIfNeeded(state.slice);
    var pairs = matchingChildren(source, target);
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i][1]) await copySnapshotOverrides(pairs[i][0], pairs[i][1], state);
    }
  }
  async function replaceSnapshotWithInstance(candidate, component, state) {
    var target = state.nodes[candidate.ref];
    if (!isAlive(target)) return null;
    var parent = target.parent;
    var index = parent.children ? parent.children.indexOf(target) : -1;
    var instanceStartedAt = Date.now();
    var instance = component.createInstance();
    if (index >= 0 && typeof parent.insertChild === "function") parent.insertChild(index, instance);
    else if (canHaveChildren(parent)) parent.appendChild(instance);
    applyCommon(instance, candidate.source, state.images, state.report);
    attachInstanceMetadata(instance, candidate.source, state, false,
      state.promotion && state.promotion.fast ? ORIGIN_FAST_PROMOTED : ORIGIN_PROMOTED);
    if (candidate.source.childLayout) {
      var instanceLayout = sanitizeChildLayout(candidate.source.childLayout, candidate.source.size);
      Object.keys(instanceLayout).forEach(function (key) { setValue(instance, key, instanceLayout[key]); });
      applyFigmaChildSizing(instance, instanceLayout, null);
    }
    state.report.instanceCreateMs += Date.now() - instanceStartedAt;
    var overrideStartedAt = Date.now();
    await copySnapshotOverrides(target, instance, state);
    state.report.overrideCopyMs += Date.now() - overrideStartedAt;
    var cleanupStartedAt = Date.now();
    try { target.remove(); } catch (_eRemove) {}
    state.report.cleanupMs += Date.now() - cleanupStartedAt;
    state.nodes[candidate.ref] = instance;
    // Счётчики режимов раздельные: «нативных инстансов» в FAST не бывает по
    // определению, и показывать их там было бы ложью.
    if (state.promotion && state.promotion.instanceCounter) state.report[state.promotion.instanceCounter] += 1;
    else state.report.nativeInstances += 1;
    return instance;
  }

  // ===========================================================================
  // Промоушен snapshot-ов в локальные компоненты.
  //
  // Алгоритм — исходный, из первой версии Pixso2Figma: успешно собранное
  // визуальное дерево является источником истины, а компонентная структура
  // дёшево восстанавливается уже поверх него. Первое вхождение подписи
  // становится локальным COMPONENT, остальные — его инстансами.
  //
  // Оба режима используют этот алгоритм, но НЕ делят состояние:
  //
  //   FAST — лёгкий семантический промоушен. Модель свойств Pixso не
  //          реконструируется вовсе; идентичность приходит из пакета готовой.
  //   FULL — тот же хвост поверх component-aware реконструкции, со своим
  //          реестром определений и своей служебной страницей.
  //
  // Разные профили ниже — это и есть граница между ними: ни реестр, ни
  // служебная страница, ни счётчики одного режима не видны другому.
  // ===========================================================================

  function fullPromotionProfile() {
    return {
      fast: false,
      servicePage: SERVICE_PAGES.definitions,
      // Реестр промоушена FULL исторически лежит прямо в nativeRegistry
      // рядом с определениями; трогать эту раскладку задача не должна.
      store: function (registry) { return registry; },
      componentCounter: null,
      reuseCounter: null,
      instanceCounter: null,
      setCounter: null,
      // FULL объединяет варианты по прежнему правилу.
      canCombine: function () { return true; },
    };
  }

  function fastPromotionProfile() {
    return {
      fast: true,
      servicePage: SERVICE_PAGES.fast,
      // Отдельная ветка реестра: FAST не видит определений FULL и не может
      // их переиспользовать, даже если обе job шли в одном документе.
      store: function (registry) {
        if (!registry.fast) {
          registry.fast = { components: {}, sets: {}, combined: {}, nextX: 0, nextY: 0, rowHeight: 0 };
        }
        return registry.fast;
      },
      componentCounter: "fastComponentsCreated",
      reuseCounter: "fastComponentsReused",
      instanceCounter: "fastInstancesCreated",
      setCounter: "fastComponentSets",
      // Вариант без variant-координаты объединять не с чем: combineAsVariants
      // построил бы набор с одинаковыми именами членов. Лучше оставить
      // отдельные компоненты, чем собрать заведомо сломанный ComponentSet.
      canCombine: function (members) {
        for (var i = 0; i < members.length; i++) {
          if (!members[i].variantCount) return false;
        }
        return true;
      },
    };
  }

  async function runSnapshotPromotion(state, profile) {
    // Кандидаты известны с этапа сборки. Ноль кандидатов — работать не над чем,
    // и обходить дерево ради этого вывода не нужно.
    var collected = state.promotionCandidates || [];
    if (!collected.length) {
      state.report.promoteSkipped = true;
      state.report.nodesSkippedFromPromoteScan = state.report.created;
      return;
    }
    if (typeof figma.createComponentFromNode !== "function") {
      state.report.promoteSkipped = true;
      warn(state.report, "Эта версия Figma не поддерживает createComponentFromNode; оставлены snapshot-фреймы.");
      return;
    }
    var scanStartedAt = Date.now();
    var groups = collectSemanticGroups(state.pkg, state);
    state.report.promoteScanMs = Date.now() - scanStartedAt;
    if (!groups.length) {
      state.report.promoteSkipped = true;
      warn(state.report, "В snapshot не найдено узлов с component metadata.");
      return;
    }
    // Общий счётчик непрерывной работы: по нему промоушен отдаёт управление
    // хосту, вместо того чтобы держать Figma секундами в одном цикле.
    state.slice = createSlice(state.report);
    state.promotion = profile;

    // В receiver-режиме importPackage вызывается на каждый chunk. Без общего
    // реестра каждый chunk создавал бы свою страницу и свои копии одних и тех же
    // компонентов. Для ручного импорта реестр пустой и всё работает как раньше.
    var registry = state.registry || { page: null, components: {}, sets: {}, combined: {} };
    var store = profile.store(registry);
    if (!store.components) store.components = {};
    if (!store.sets) store.sets = {};
    if (!store.combined) store.combined = {};
    // Служебная страница режима: у FULL — та же, что у импорта определений,
    // у FAST — своя. Обе опознаются по plugin data, а не по видимому имени.
    var componentPage = await ensureServicePage(registry, state.jobId, profile.servicePage);
    var bySet = store.sets;
    var nextX = store.nextX || 0, nextY = store.nextY || 0, rowHeight = store.rowHeight || 0;

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var representative = null;
      for (var c = 0; c < group.candidates.length; c++) {
        var possible = state.nodes[group.candidates[c].ref];
        if (!isAlive(possible)) continue;
        var possibleType = null;
        try { possibleType = possible.type; } catch (_ePossible) { continue; }
        if (possibleType === "FRAME") { representative = possible; break; }
      }
      if (!representative) continue;
      try {
        // Реестр живёт всю job: компонент, созданный на корне N, повторно
        // используется корнем N+5, а не пересоздаётся на каждый chunk.
        var component = store.components[group.signature];
        if (isAlive(component)) {
          if (profile.reuseCounter) state.report[profile.reuseCounter] += 1;
        } else {
          var componentStartedAt = Date.now();
          var clone = representative.clone();
          componentPage.appendChild(clone);
          clone.x = nextX; clone.y = nextY;
          component = figma.createComponentFromNode(clone);
          component.name = variantComponentName(group.preset);
          setPluginData(component, "pixsoSemanticSignature", group.signature);
          setPluginData(component, "pixsoDefinitionName", group.preset.definitionName || "");
          setPluginData(component, "pixsoDefinitionSetName", group.preset.definitionSetName || "");
          store.components[group.signature] = component;
          if (profile.componentCounter) state.report[profile.componentCounter] += 1;
          else state.report.nativeComponents += 1;

          rowHeight = Math.max(rowHeight, component.height);
          nextX += component.width + 80;
          if (nextX > 4000) { nextX = 0; nextY += rowHeight + 120; rowHeight = 0; }

          var setKey = variantSetKey(group.preset);
          if (setKey) {
            if (!bySet[setKey]) bySet[setKey] = { name: variantSetName(group.preset), members: [] };
            bySet[setKey].members.push({
              node: component,
              variantCount: Object.keys(group.preset.variantProperties || {}).length,
            });
          }
          state.report.componentCreateMs += Date.now() - componentStartedAt;
        }
        for (var r = 0; r < group.candidates.length; r++) {
          await replaceSnapshotWithInstance(group.candidates[r], component, state);
          // Между кандидатами — единственная безопасная точка отдать управление:
          // один кандидат обрабатывается целиком, порядок сохраняется.
          await yieldIfNeeded(state.slice);
          // Обработанный кандидат больше не нужен: не держим ссылку на узел.
          group.candidates[r].source = null;
        }
        if (i % 20 === 0) {
          try { figma.ui.postMessage({ type: "component-progress", current: i + 1, total: groups.length }); } catch (_eProgress) {}
        }
      } catch (_eComponent) {
        // Неудача одной группы — это оставшийся визуальный snapshot, а не
        // провал корня: остальные группы продолжают обрабатываться.
        state.report.promotionFailures += 1;
        warn(state.report, "Не удалось создать Figma-компонент «" + (group.preset.definitionName || "без имени") + "»");
      }
    }

    store.nextX = nextX; store.nextY = nextY; store.rowHeight = rowHeight;

    var combineStartedAt = Date.now();
    Object.keys(bySet).forEach(function (setKey) {
      if (store.combined[setKey]) return;
      var entry = bySet[setKey];
      var alive = entry.members.filter(function (member) {
        if (!isAlive(member.node)) return false;
        try { return member.node.type === "COMPONENT"; } catch (_eKind) { return false; }
      });
      if (alive.length < 2) return;
      if (!profile.canCombine(alive)) {
        state.report.setsLeftSeparate += 1;
        return;
      }
      try {
        var set = figma.combineAsVariants(alive.map(function (member) { return member.node; }), componentPage);
        set.name = entry.name;
        store.combined[setKey] = true;
        if (profile.setCounter) state.report[profile.setCounter] += 1;
        else state.report.nativeComponentSets += 1;
      } catch (_eSet) { warn(state.report, "Не удалось объединить варианты «" + entry.name + "»"); }
    });
    state.report.combineMs += Date.now() - combineStartedAt;
    // Кандидаты обработаны: освобождаем список, чтобы он не жил до конца корня.
    state.promotionCandidates = [];
    state.slice = null;
    state.promotion = null;
  }

  /** FULL: хвост component-aware реконструкции. Поведение не менялось. */
  async function promoteSnapshotsToComponents(state) {
    return runSnapshotPromotion(state, fullPromotionProfile());
  }

  /**
   * FAST: лёгкий семантический промоушен.
   *
   * Ничего из модели свойств Pixso здесь не восстанавливается и не требуется:
   * идентичность пришла в пакете, визуальное состояние берётся из уже
   * собранного поддерева. Кандидат, который не удалось свернуть, остаётся
   * визуальным snapshot-ом — это штатный результат, а не отказ.
   */
  async function promoteFastSnapshotsToComponents(state) {
    var considered = (state.promotionCandidates || []).length;
    try {
      await runSnapshotPromotion(state, fastPromotionProfile());
    } finally {
      // Всё, что не стало инстансом локального компонента, осталось
      // развёрнутым деревом. Эту величину нельзя выводить из «промоушен
      // отработал»: она и есть цена лёгкого режима, и её видно в UI.
      // Считается и на пути отказа — иначе цена молча исчезла бы.
      state.report.fastSnapshotsLeft +=
        Math.max(0, considered - state.report.fastInstancesCreated);
    }
  }

  /** Возвращает только замыкание component-зависимостей выбранных roots.
   * Полный граф допустим лишь в явном library-режиме. */
  function collectRequiredComponents(pkg, includeLibrary) {
    var required = {}, queued = {}, queue = [];
    function enqueue(ref) {
      if (ref && pkg.components && pkg.components[ref] && !queued[ref]) { queued[ref] = true; queue.push(ref); }
    }
    function inspectTree(nodeRef) {
      var node = pkg.nodes && pkg.nodes[nodeRef];
      if (!node) return;
      if (node.type === "INSTANCE") {
        var preset = pkg.instances && pkg.instances[node.id] && pkg.instances[node.id].preset;
        if (preset) {
          enqueue(preset.definitionRef);
          if (!preset.definitionRef && preset.definitionSetRef) {
            var set = pkg.componentSets && pkg.componentSets[preset.definitionSetRef];
            enqueue(set && (set.defaultVariantRef || (set.componentRefs || [])[0]));
          }
        }
      }
      (node.children || []).forEach(inspectTree);
    }
    if (includeLibrary) Object.keys(pkg.components || {}).forEach(enqueue);
    else (pkg.roots || []).forEach(function (root) { inspectTree(root.nodeRef); });
    while (queue.length) {
      var ref = queue.shift();
      if (required[ref]) continue;
      required[ref] = true;
      var entity = pkg.components[ref];
      if (entity && entity.rootNodeRef) inspectTree(entity.rootNodeRef);
    }
    var ordered = (pkg.dependencies && pkg.dependencies.order || []).filter(function (ref) { return required[ref]; });
    Object.keys(required).forEach(function (ref) { if (ordered.indexOf(ref) < 0) ordered.push(ref); });
    return ordered;
  }
  async function buildComponents(state, componentShelf, componentIds, includeLibrary) {
    var entries = state.pkg.components || {};
    var ids = componentIds || [];
    for (var i = 0; i < ids.length; i++) {
      var entity = entries[ids[i]];
      if (!entity.rootNodeRef) continue;
      var root = await buildTree(entity.rootNodeRef, componentShelf, state, "definition");
      if (root && root.type === "COMPONENT") {
        state.components[entity.portableId] = root; root.name = entity.name || root.name;
        createComponentProperties(root, entity.properties || [], state);
        applyComponentBindings(entity.rootNodeRef, state);
      }
      else warn(state.report, "Компонент «" + entity.name + "» не создан нативно");
    }
    if (!includeLibrary) return;
    var sets = state.pkg.componentSets || {};
    Object.keys(sets).forEach(function (id) {
      var set = sets[id], allRefs = set.componentRefs || [], variants = allRefs.map(function (ref) { return state.components[ref]; }).filter(Boolean);
      if (variants.length > 1 && variants.length === allRefs.length) {
        try { var group = figma.combineAsVariants(variants, componentShelf); group.name = set.name || group.name; state.componentSets[id] = group; }
        catch (_e) { warn(state.report, "Не удалось собрать Component Set «" + set.name + "»"); }
      }
    });
  }
  function createComponentProperties(component, properties, state) {
    properties.forEach(function (property) {
      if (!property || !property.logicalPropertyName || typeof component.addComponentProperty !== "function") return;
      var type = property.propertyType === "INSTANCE_SWAP" ? "INSTANCE_SWAP" : property.propertyType;
      var defaultValue = property.defaultValue;
      try {
        if (type === "VARIANT") {
          // Figma создаёт variant-свойства сама при объединении вариантов;
          // их имя — имя группы. Запоминаем, чтобы инстансы нашли свойство.
          state.propertyNames[property.portableId] = property.logicalPropertyName;
          return;
        }
        var actualName = component.addComponentProperty(property.logicalPropertyName, type, defaultValue);
        if (actualName) state.propertyNames[property.portableId] = actualName;
      } catch (_e) { warn(state.report, "Свойство компонента не перенесено: " + property.logicalPropertyName); }
    });
  }
  function applyComponentBindings(rootRef, state) {
    function walk(ref) {
      var source = state.pkg.nodes[ref], target = state.nodes[ref];
      if (!source || !target) return;
      if (source.componentPropertyReferences) {
        var bindings = {};
        Object.keys(source.componentPropertyReferences).forEach(function (field) {
          var actual = state.propertyNames[source.componentPropertyReferences[field]];
          if (actual) bindings[field] = actual;
        });
        if (Object.keys(bindings).length) setValue(target, "componentPropertyReferences", bindings);
      }
      (source.children || []).forEach(walk);
    }
    walk(rootRef);
  }
  function findPath(root, path) {
    var current = root;
    for (var i = 0; current && i < (path || []).length; i++) {
      var step = path[i], same = (current.children || []).filter(function (child) { return child.name === step.name && child.type === step.type; });
      current = same[step.index || 0] || null;
    }
    return current;
  }
  async function applyInstanceProperties(node, preset, state) {
    if (!preset || nodeType(node) !== "INSTANCE") return;
    var props = {};
    var main = null;
    try { main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : node.mainComponent; } catch (_e0) {}
    // Прямое чтение у варианта бросает: схему отдаёт его COMPONENT_SET.
    var definitions = getComponentPropertyDefinitions(main, state);
    Object.keys(preset.componentProperties || {}).forEach(function (logical) {
      var entry = preset.componentProperties[logical];
      if (!entry || entry.type === "INSTANCE_SWAP") return;
      var exact = Object.keys(definitions).filter(function (name) { return name === logical || name.indexOf(logical + "#") === 0; })[0] || logical;
      props[exact] = entry.value;
    });
    var names = Object.keys(props);
    if (!names.length) return;
    try {
      node.setProperties(props);
      state.report.propertiesApplied += names.length;
    } catch (error) {
      state.report.propertiesMissed += names.length;
      state.report.propertyMissReasons[MISS.SET_PROPERTIES_THROW] =
        (state.report.propertyMissReasons[MISS.SET_PROPERTIES_THROW] || 0) + names.length;
      warn(state.report, "Часть properties не применена к instance «" + safeNodeName(node) + "»");
    }
  }
  async function applyInstancePreset(node, preset, state) {
    if (!preset) return;
    await applyInstanceProperties(node, preset, state);
    (preset.textOverrides || []).forEach(function (override) {
      var target = findPath(node, override.path);
      if (target && target.type === "TEXT") { try { target.characters = override.characters; } catch (_e2) { warn(state.report, "Текстовый override не применён: " + node.name); } }
    });
    (preset.overrides || []).forEach(function (override) {
      var target = findPath(node, override.targetPath);
      if (!target) return;
      Object.keys(override.changes || {}).forEach(function (key) { try { target[key] = override.changes[key]; } catch (_e3) {} });
    });
  }
  function newReport(mode) {
    return {
      created: 0, warnings: [], roots: 0, components: 0, detachedInstances: 0,
      resolvedInstances: 0, semanticSnapshots: 0, nativeComponents: 0, nativeInstances: 0,
      nativeComponentSets: 0, textOverridesRestored: 0, nestedSwapsRestored: 0,
      styleOverridesRestored: 0, strokeOverridesRestored: 0, vectorLineFallbacks: 0,
      svgNodesCreated: 0, stylesCreated: 0,
      // Component-aware миграция.
      fastInstances: 0, fastInstanceMisses: 0,
      propertiesApplied: 0, propertiesMissed: 0, nestedTargetsMissed: 0,
      // Сколько раз схема варианта была прочитана через его COMPONENT_SET
      // и сколько определений не удалось собрать нативно.
      variantSchemaViaSet: 0, definitionsFailed: 0,
      // Режим job и явно пропущенные фазы: без этого «промоушен не шёл»
      // неотличимо от «промоушен отработал за 0 мс».
      migrationMode: DEFAULT_MIGRATION_MODE,
      nativePromotionSkipped: false, fastSemanticPromotion: false,
      componentPreparationSkipped: false,
      // Промоушен: что он вообще рассматривал и во что ушло время.
      promoteSkipped: false, promoteScanNodes: 0, promoteCandidates: 0,
      nativeSubtreesPruned: 0, nodesSkippedFromPromoteScan: 0, overrideNodesVisited: 0,
      promoteScanMs: 0, componentCreateMs: 0, instanceCreateMs: 0,
      overrideCopyMs: 0, cleanupMs: 0, combineMs: 0,
      // Лёгкий семантический промоушен FAST. Счётчики режимов не смешиваются:
      // «компонентов создано» в FAST и в FULL — величины разной природы.
      visualInstancesBuilt: 0,
      fastComponentsCreated: 0, fastComponentsReused: 0,
      fastInstancesCreated: 0, fastSnapshotsLeft: 0, fastComponentSets: 0,
      fastPromoteMs: 0,
      // Группы, которые остались отдельными компонентами вместо ComponentSet,
      // и группы, промоушен которых не удался.
      setsLeftSeparate: 0, promotionFailures: 0,
      yieldCount: 0, maxSliceMs: 0, sliceTotalMs: 0,
      // Потерянные свойства по обобщённым причинам + ограниченная выборка.
      propertyMissReasons: {}, propertyMissSamples: [],
      mode: mode,
    };
  }

  /**
   * Импорт уникальных определений компонентов. Отдельный вход в те же
   * buildTree/createComponentProperties: экран здесь не собирается, создаются
   * только нативные COMPONENT и COMPONENT_SET, живущие всю job.
   */
  async function importDefinitions(pkg, options) {
    validate(pkg);
    options = options || {};
    var timings = options.timingsOut || {};
    var startedAt = Date.now();
    var registry = options.nativeRegistry || {};
    if (!registry.defs) registry.defs = {};
    if (!registry.setNodes) registry.setNodes = {};
    if (!registry.propertyNames) registry.propertyNames = {};

    var report = newReport("definitions");
    var state = {
      pkg: pkg, report: report, nodes: {}, components: {}, componentSets: {},
      // Имена свойств живут всю job: их читают инстансы из следующих chunk.
      propertyNames: registry.propertyNames, styles: {},
      images: styleImages(pkg, report), registry: registry,
      // Определения промоушена не требуют: они и так нативные.
      promotionCandidates: null, slice: null,
    };
    // Определения из предыдущих chunk — доступные зависимости, а не повод
    // собирать их заново.
    Object.keys(registry.defs).forEach(function (ref) {
      if (isAlive(registry.defs[ref])) state.components[ref] = registry.defs[ref];
    });
    await createLocalStyles(state);

    var previousPage = figma.currentPage;
    var page = await ensureServicePage(registry, options.jobId);
    await ensureCurrentPage(page);
    var shelf = registry.definitionShelf;
    if (!isAlive(shelf)) {
      shelf = figma.createSection ? figma.createSection() : figma.createFrame();
      shelf.name = "Pixso component definitions";
      page.appendChild(shelf);
      registry.definitionShelf = shelf;
    }

    var created = [];
    var sets = [];
    var order = collectRequiredComponents(pkg, true);
    for (var i = 0; i < order.length; i++) {
      var entity = pkg.components[order[i]];
      // Заглушка внешней ссылки: определение уже создано в прошлом chunk.
      if (!entity || entity.external || !entity.rootNodeRef) continue;
      if (isAlive(registry.defs[entity.portableId])) {
        state.components[entity.portableId] = registry.defs[entity.portableId];
        continue;
      }
      // Одно нерабочее определение не должно уносить с собой остальные:
      // его инстансы просто уедут прежним snapshot-ом.
      var root = null;
      try {
        root = await buildTree(entity.rootNodeRef, shelf, state, "definition");
      } catch (buildError) {
        report.definitionsFailed += 1;
        warn(report, "Компонент «" + entity.name + "» не собран: " + (buildError && buildError.message || buildError));
        continue;
      }
      if (nodeType(root) !== "COMPONENT") {
        report.definitionsFailed += 1;
        warn(report, "Компонент «" + entity.name + "» не создан нативно");
        continue;
      }
      root.name = entity.name || root.name;
      setPluginData(root, "portableComponentId", entity.portableId);
      state.components[entity.portableId] = root;
      registry.defs[entity.portableId] = root;
      try {
        createComponentProperties(root, entity.properties || [], state);
        applyComponentBindings(entity.rootNodeRef, state);
      } catch (propertyError) {
        // Компонент уже создан и пригоден: без части свойств, но пригоден.
        warn(report, "Свойства компонента «" + entity.name + "» перенесены частично: " +
          (propertyError && propertyError.message || propertyError));
      }
      report.nativeComponents += 1;
      created.push(entity.portableId);
    }

    // Сет собирается после своих вариантов: сначала объединение, затем
    // публичные свойства сета, и только потом привязки полей внутри вариантов.
    var setIds = Object.keys(pkg.componentSets || {});
    for (var s = 0; s < setIds.length; s++) {
      var setEntity = pkg.componentSets[setIds[s]];
      if (!setEntity || setEntity.external) continue;
      if (isAlive(registry.setNodes[setEntity.portableId])) continue;
      var refs = setEntity.componentRefs || [];
      var variants = refs.map(function (ref) { return registry.defs[ref]; }).filter(isAlive);
      if (variants.length < 2 || variants.length !== refs.length) {
        if (refs.length) warn(report, "Component Set «" + setEntity.name + "» без объединения вариантов");
        continue;
      }
      var group = null;
      try { group = figma.combineAsVariants(variants, shelf); }
      catch (_eSet) { warn(report, "Не удалось собрать Component Set «" + setEntity.name + "»"); continue; }
      group.name = setEntity.name || group.name;
      setPluginData(group, "portableComponentId", setEntity.portableId);
      registry.setNodes[setEntity.portableId] = group;
      state.componentSets[setEntity.portableId] = group;
      report.nativeComponentSets += 1;
      sets.push(setEntity.portableId);
      // Свойства сета и привязки полей внутри вариантов: их отказ не отменяет
      // уже собранный сет.
      try {
        createComponentProperties(group, setEntity.properties || [], state);
        for (var v = 0; v < refs.length; v++) {
          var variantEntity = pkg.components[refs[v]];
          if (variantEntity && variantEntity.rootNodeRef) applyComponentBindings(variantEntity.rootNodeRef, state);
        }
      } catch (setPropertyError) {
        warn(report, "Свойства сета «" + setEntity.name + "» перенесены частично: " +
          (setPropertyError && setPropertyError.message || setPropertyError));
      }
    }

    await ensureCurrentPage(previousPage);
    timings.totalMs = Date.now() - startedAt;
    return { created: created, sets: sets, report: report };
  }

  function validate(pkg) {
    if (!pkg || pkg.format !== FORMAT) throw Error("Ожидается JSON формата " + FORMAT);
    if (!pkg.nodes || !pkg.roots) throw Error("В пакете отсутствуют nodes или roots");
  }
  function rootOffset(pkg) {
    var minX = 0, minY = 0, hasRoot = false;
    (pkg.roots || []).forEach(function (root) {
      var node = pkg.nodes[root.nodeRef], position = node && node.position;
      if (!position) return;
      if (!hasRoot) { minX = position.x || 0; minY = position.y || 0; hasRoot = true; }
      else { minX = Math.min(minX, position.x || 0); minY = Math.min(minY, position.y || 0); }
    });
    return { x: -minX, y: -minY };
  }
  function screenNeedsComponentDefinitions(pkg) {
    var needs = false;
    function walk(ref) {
      var node = pkg.nodes && pkg.nodes[ref];
      if (!node || needs) return;
      if (node.type === "INSTANCE" && !(node.children && node.children.length)) { needs = true; return; }
      (node.children || []).forEach(walk);
    }
    (pkg.roots || []).forEach(function (root) { walk(root.nodeRef); });
    return needs;
  }
  function hasResolvedScreenInstances(pkg) {
    if (pkg.transferMode === "VISUAL_SNAPSHOT") return true;
    var found = false;
    function walk(ref) {
      var node = pkg.nodes && pkg.nodes[ref];
      if (!node || found) return;
      if (node.type === "INSTANCE" && node.children && node.children.length) { found = true; return; }
      (node.children || []).forEach(walk);
    }
    (pkg.roots || []).forEach(function (root) { walk(root.nodeRef); });
    return found;
  }
  // ===========================================================================
  // Служебная страница определений.
  //
  // Раньше её создавали два независимых пути — импорт определений и промоушен
  // snapshot-ов — и в документе появлялись две страницы с одинаковым видимым
  // именем. Опознаётся страница только по plugin data: страницу пользователя
  // с тем же именем плагин не трогает никогда.
  // ===========================================================================

  var SERVICE_PAGE_ROLE = "component-definitions";
  var SERVICE_PAGE_NAME = "Pixso Components (native)";
  var FAST_SERVICE_PAGE_ROLE = "fast-components";
  var FAST_SERVICE_PAGE_NAME = "Pixso Components (Fast)";

  /**
   * Служебные страницы плагина. У режимов они разные: страница FULL хранит
   * реконструированные определения, страница FAST — компоненты, собранные из
   * визуальных снимков. Смешивать их нельзя, иначе прогон в одном режиме
   * начал бы переиспользовать результат другого.
   *
   * slot — поле в реестре job, в котором страница живёт между chunk.
   */
  var SERVICE_PAGES = {
    definitions: { role: SERVICE_PAGE_ROLE, name: SERVICE_PAGE_NAME, slot: "definitionPage" },
    fast: { role: FAST_SERVICE_PAGE_ROLE, name: FAST_SERVICE_PAGE_NAME, slot: "fastPage" },
    // Третья роль — экспериментального Direct PIX. Своя страница, свой
    // реестр; страницы FAST и FULL этот путь не ищет и не помечает.
    direct: { role: "direct-pix-components", name: "Pixso Direct Components", slot: "directPage" },
  };

  function servicePageRole(page) {
    try { return page.getPluginData("pixso2figmaRole"); } catch (_e) { return ""; }
  }

  function findServicePage(role) {
    var wanted = role || SERVICE_PAGE_ROLE;
    var pages = [];
    try { pages = figma.root.children || []; } catch (_eRoot) { return null; }
    for (var i = 0; i < pages.length; i++) {
      if (servicePageRole(pages[i]) === wanted) return pages[i];
    }
    return null;
  }

  /**
   * Ровно одна служебная страница каждой роли после инициализации. Страница,
   * оставшаяся от прошлого — в том числе оборвавшегося — прогона,
   * переиспользуется: незакрытая job не повод плодить дубликаты. Опознаётся
   * страница только по plugin data: страницу пользователя с тем же видимым
   * именем плагин не трогает никогда.
   */
  async function ensureServicePage(registry, jobId, descriptor) {
    var spec = descriptor || SERVICE_PAGES.definitions;
    var page = registry[spec.slot];
    if (!isPageAlive(page)) page = findServicePage(spec.role);
    if (!isPageAlive(page)) {
      page = figma.createPage();
      page.name = spec.name;
      setPluginData(page, "pixso2figmaRole", spec.role);
      setPluginData(page, "pixso2figmaVersion", RECEIVER_VERSION);
    }
    setPluginData(page, "pixso2figmaJobId", String(jobId || ""));
    setPluginData(page, "pixso2figmaState", "BUILDING");
    registry[spec.slot] = page;
    // Обе стороны FULL — определения и промоушен — живут на одной странице.
    if (spec.role === SERVICE_PAGE_ROLE) registry.page = page;
    await ensurePageLoaded(page);
    return page;
  }

  /** Возвращает true, только если страница этой роли действительно есть. */
  function markServicePageReady(registry, descriptor) {
    var spec = descriptor || SERVICE_PAGES.definitions;
    var page = registry && registry[spec.slot];
    if (!isPageAlive(page)) page = findServicePage(spec.role);
    if (!isPageAlive(page)) return false;
    setPluginData(page, "pixso2figmaState", "READY");
    return true;
  }

  async function switchToPage(page) {
    if (typeof figma.setCurrentPageAsync === "function") return figma.setCurrentPageAsync(page);
    figma.currentPage = page;
  }

  // Страница, однажды загруженная в этой сессии плагина, остаётся загруженной,
  // а переключение на уже активную страницу — чистый расход. Раньше и то и
  // другое повторялось на каждый chunk.
  var loadedPages = Object.create(null);

  function pageId(page) {
    try { return page && page.id ? String(page.id) : null; } catch (_e) { return null; }
  }

  async function ensurePageLoaded(page) {
    if (!page || typeof page.loadAsync !== "function") return;
    var key = pageId(page);
    if (key && loadedPages[key]) return;
    await page.loadAsync();
    if (key) loadedPages[key] = true;
  }

  async function ensureCurrentPage(page) {
    if (!page) return;
    var current = null;
    try { current = figma.currentPage; } catch (_e) { current = null; }
    if (current && pageId(current) && pageId(current) === pageId(page)) return;
    await switchToPage(page);
  }
  async function importPackage(pkg, options) {
    validate(pkg);
    options = options || {};
    // FIGMA_IMPORT_MS и его разбивка. Объект передаётся вызывающим; ручной
    // импорт его не передаёт и ничего не платит.
    var timings = options.timingsOut || {};
    var importStartedAt = Date.now();
    var fontsBefore = fontLoadStats.ms;
    var phaseStartedAt = Date.now();
    // documentAccess: dynamic-page требует явной загрузки page до appendChild.
    await ensurePageLoaded(figma.currentPage);
    timings.pageMs = Date.now() - phaseStartedAt;
    var report = newReport(options.includeLibrary ? "library" : "screen");
    // --- Единственный шлюз режима на стороне Figma.
    var fastMode = normalizeMigrationMode(options.migrationMode) === MIGRATION_MODE.FAST;
    // Развёрнутое поддерево — промежуточное представление, а не конечный
    // результат: и в FAST, и в FULL поверх него восстанавливается локальная
    // компонентная структура. Различается то, ЧЕМ она восстанавливается.
    var wantsPromotion = options.promoteComponents !== false;
    report.migrationMode = fastMode ? MIGRATION_MODE.FAST : MIGRATION_MODE.FULL;
    // FAST не готовит определения и не реконструирует свойства Pixso, но
    // лёгкий семантический промоушен выполняет: это разные фазы.
    report.nativePromotionSkipped = fastMode;
    report.fastSemanticPromotion = fastMode && wantsPromotion;
    report.componentPreparationSkipped = fastMode;
    var state = {
      pkg: pkg, report: report, nodes: {}, components: {}, componentSets: {},
      propertyNames: {}, styles: {}, images: styleImages(pkg, report),
      registry: options.nativeRegistry || null,
      jobId: options.jobId || null,
      // Кандидаты промоушена собираются при сборке дерева, а не вторым обходом.
      promotionCandidates: wantsPromotion ? [] : null, slice: null, promotion: null,
    };
    phaseStartedAt = Date.now();
    await createLocalStyles(state);
    timings.stylesMs = Date.now() - phaseStartedAt;
    if (Object.keys(pkg.variables || {}).length) warn(report, "Variables применены как значения; semantic bindings пока не переносятся.");
    if ((pkg.reactions || []).length) warn(report, "Prototype reactions сохранены в JSON, но пока не применяются.");
    // Если пакет уже содержит хотя бы одно resolved-поддерево, это экранный
    // snapshot. В screen-only режиме не строим библиотечные definitions:
    // именно их сборка раньше обрывала импорт до создания корневого экрана.
    var visualSnapshot = !options.includeLibrary && hasResolvedScreenInstances(pkg);
    // FAST не собирает определения ни при каких условиях: инстанс, который
    // не удалось представить развёрнутым деревом, остаётся визуальным
    // фоллбеком. Незаметное переключение в Full сделало бы время FAST
    // непредсказуемым — ровно то, ради чего режим и существует.
    var needComponentDefinitions = fastMode
      ? false
      : (!!options.includeLibrary || (!visualSnapshot && screenNeedsComponentDefinitions(pkg)));
    if (fastMode && !visualSnapshot) {
      warn(report, "FAST: в пакете нет развёрнутых инстансов — узлы собраны визуальным фоллбеком без реконструкции компонентов.");
    }
    var componentIds = needComponentDefinitions ? collectRequiredComponents(pkg, !!options.includeLibrary) : [];
    var screenPage = figma.currentPage;
    if (componentIds.length) {
      var componentPage = figma.createPage(); componentPage.name = "Pixso Components";
      await ensurePageLoaded(componentPage);
      var shelf = figma.createSection ? figma.createSection() : figma.createFrame();
      shelf.name = options.includeLibrary ? "Imported library (Pixso)" : "Components required by screen (Pixso)";
      componentPage.appendChild(shelf);
      await buildComponents(state, shelf, componentIds, !!options.includeLibrary);
    }
    report.components = componentIds.length;
    if (visualSnapshot) {
      warn(report, "Экран собран из развёрнутых Pixso-инстансов — без создания отдельной библиотеки компонентов.");
    } else if (!options.includeLibrary) {
      warn(report, "В JSON есть неразвёрнутые инстансы: для них использованы component definitions. Для точного переноса переэкспортируйте экран в режиме «Вся текущая страница».");
    }
    // В dynamic-page режиме currentPage read-only; переход возможен только async API.
    await ensureCurrentPage(screenPage);
    phaseStartedAt = Date.now();
    setReceiverPhase("build");
    // Ссылки на снятые с обработки узлы дальше не нужны.
    var offset = options.preserveAbsolutePosition ? { x: 0, y: 0 } : rootOffset(pkg), roots = [];
    for (var i = 0; i < pkg.roots.length; i++) {
      var root = await buildTree(pkg.roots[i].nodeRef, null, state, "screen", offset);
      if (root) {
        // Не полагаемся на implicit parent у create* API: после создания
        // component page Figma может оставить иной currentPage.
        screenPage.appendChild(root);
        if (!root.parent || root.parent.id !== screenPage.id) {
          throw Error("Корневой экран не добавлен на целевую страницу Figma.");
        }
        finalizeTree(pkg.roots[i].nodeRef, state, true, null);
        var sourceRoot = pkg.nodes[pkg.roots[i].nodeRef];
        if (sourceRoot && sourceRoot.position) {
          setValue(root, "x", finite(sourceRoot.position.x, 0) + offset.x);
          setValue(root, "y", finite(sourceRoot.position.y, 0) + offset.y);
        }
        roots.push(root);
      }
    }
    if (!roots.length) throw Error("В пакете не найден ни один корневой экран.");
    timings.buildMs = Date.now() - phaseStartedAt;
    report.roots = roots.length;
    report.visualInstancesBuilt = report.resolvedInstances;
    phaseStartedAt = Date.now();
    // Визуальный импорт уже удался — компонентная структура достраивается
    // поверх него. Отказ этой фазы не отменяет экран, который создан и лежит
    // на странице: кандидат просто остаётся визуальным snapshot-ом.
    if (fastMode) {
      if (wantsPromotion && visualSnapshot) {
        setReceiverPhase("promote", { created: report.created });
        try { await promoteFastSnapshotsToComponents(state); }
        catch (promoteError) {
          warn(report, "Лёгкий промоушен FAST прерван: " + (promoteError && promoteError.message || promoteError));
        }
      }
      // Метрика FAST отделена от FULL намеренно: одна величина под двумя
      // разными пайплайнами скрывала бы, что именно заняло время.
      timings.fastPromoteMs = Date.now() - phaseStartedAt;
      timings.promoteMs = 0;
      report.fastPromoteMs = timings.fastPromoteMs;
    } else {
      if (wantsPromotion && options.promoteComponents && visualSnapshot) {
        setReceiverPhase("promote", { created: report.created });
        try { await promoteSnapshotsToComponents(state); }
        catch (promoteError) {
          warn(report, "Промоушен в нативные компоненты прерван: " + (promoteError && promoteError.message || promoteError));
        }
      }
      timings.promoteMs = Date.now() - phaseStartedAt;
      timings.fastPromoteMs = 0;
    }
    timings.promoteScanMs = report.promoteScanMs;
    timings.componentCreateMs = report.componentCreateMs;
    timings.instanceCreateMs = report.instanceCreateMs;
    timings.overrideCopyMs = report.overrideCopyMs;
    timings.combineMs = report.combineMs;
    timings.cleanupMs = report.cleanupMs;
    timings.otherPromoteMs = Math.max(0, timings.promoteMs - report.promoteScanMs - report.componentCreateMs -
      report.instanceCreateMs - report.overrideCopyMs - report.combineMs - report.cleanupMs);
    timings.yieldCount = report.yieldCount;
    timings.maxSliceMs = report.maxSliceMs;
    setReceiverPhase("finalize");
    await ensureCurrentPage(screenPage);
    // Промоушен заменяет snapshot-инстансы, включая корневой, на новые ноды:
    // ссылки в roots становятся висячими. Берём актуальные из state.nodes.
    var liveRoots = [];
    for (var lr = 0; lr < pkg.roots.length; lr++) {
      var liveRoot = state.nodes[pkg.roots[lr].nodeRef];
      if (isAlive(liveRoot)) liveRoots.push(liveRoot);
    }
    // Выделение и зум — косметика; они не могут быть причиной провала импорта.
    // В Receiver mode это делать на каждый root нельзя: scrollAndZoomIntoView
    // заставляет Figma пересчитывать вьюпорт после каждого экрана. Приёмник
    // передаёт skipViewport и обновляет вид один раз после FINISH_JOB.
    phaseStartedAt = Date.now();
    if (!options.skipViewport) {
      try {
        if (liveRoots.length) {
          figma.currentPage.selection = liveRoots;
          figma.viewport.scrollAndZoomIntoView(liveRoots);
        }
      } catch (_eSelection) { /* страница могла смениться */ }
    }
    timings.viewportMs = Date.now() - phaseStartedAt;
    timings.fontMs = fontLoadStats.ms - fontsBefore;
    timings.totalMs = Date.now() - importStartedAt;
    return report;
  }
  // =========================================================================
  // Receiver mode. Второй вход в тот же importPackage: вместо выбранного
  // вручную файла пакет приходит по одному chunk из bridge. Ручной импорт
  // ниже не затрагивается и работает без bridge.
  // =========================================================================
  // Что именно делал приёмник в момент отказа. Без этого «лог обрывается на
  // PAGE_START» не диагностируется вообще.
  var receiverPhase = { taskType: null, taskId: null, sequence: null, page: null, root: null, stage: "idle", created: 0 };

  function setReceiverPhase(stage, extra) {
    receiverPhase.stage = stage;
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) receiverPhase[key] = extra[key];
      }
    }
  }

  var RECEIVER_VERSION = "0.1.0";
  // Транспорт bridge (receiver lease). НЕ версия Direct PIX payload —
  // DIRECT_PROTOCOL_VERSION ниже остаётся прежней.
  var PROTOCOL_VERSION = 2;
  var session = null;

  function newSession(jobId, source, mode) {
    return {
      jobId: jobId,
      source: source || null,
      // Режим объявлен продюсером и действует на всю job целиком.
      migrationMode: normalizeMigrationMode(mode),
      // Идемпотентность: один taskId импортируется ровно один раз.
      processedTasks: {},
      pages: {},
      currentPage: null,
      // Первая страница миграции: на неё один раз наводится вьюпорт в FINISH_JOB.
      firstPage: null,
      // Одна страница нативных компонентов и один набор компонентов на всю job:
      // иначе каждый chunk создавал бы свои копии одних и тех же компонентов.
      // page/components/sets/combined — реестр промоушена snapshot-ов.
      // defs/setNodes/propertyNames — реестр определений component-aware
      // миграции: portable id → нативный узел Figma, один на всю job.
      nativeRegistry: {
        page: null, components: {}, sets: {}, combined: {},
        defs: {}, setNodes: {}, propertyNames: {}, styles: {},
        definitionPage: null, definitionShelf: null,
        // Реестр лёгкого промоушена FAST: своя ветка, своя страница.
        // Компонент, созданный на первом корне, переиспользуется дальше.
        fast: null, fastPage: null,
      },
      totals: {
        pages: 0, roots: 0, nodes: 0, warnings: 0,
        fastInstances: 0, fastInstanceMisses: 0,
        // Итог лёгкого промоушена по всей job.
        visualInstancesBuilt: 0, fastComponentsCreated: 0, fastComponentsReused: 0,
        fastInstancesCreated: 0, fastSnapshotsLeft: 0, fastComponentSets: 0,
        // Уникальные определения, а не созданные внутри них узлы: путать эти
        // величины нельзя, разница между ними — тысячи.
        componentsImported: 0, componentSetsImported: 0,
        uniqueDefinitionsImported: 0, definitionNodesCreated: 0,
        propertiesApplied: 0, propertiesMissed: 0,
      },
      // Суммарные тайминги job: их producer забирает в FINISH_JOB.
      // Инструментовка job: доказательство обхода, а не подставленные нули.
      jobStats: {
        migrationMode: normalizeMigrationMode(mode),
        // FAST: подготовка определений пропущена, семантический промоушен —
        // нет. Одним флагом эти две вещи описывать нельзя.
        fastSemanticPromotion: normalizeMigrationMode(mode) === MIGRATION_MODE.FAST,
        fullComponentPreparation: normalizeMigrationMode(mode) === MIGRATION_MODE.FULL,
        definitionTasksSkipped: 0,
        componentPreparationSkippedRoots: 0,
        servicePageTouched: false,
      },
      timing: {
        importMs: 0, pageMs: 0, stylesMs: 0, buildMs: 0, promoteMs: 0, fastPromoteMs: 0, fontMs: 0,
        viewportMs: 0, roots: 0, definitionMs: 0, definitionTasks: 0,
        promoteScanMs: 0, componentCreateMs: 0, instanceCreateMs: 0, overrideCopyMs: 0,
        combineMs: 0, yieldCount: 0, maxSliceMs: 0, promoteSkippedRoots: 0,
      },
      propertyMissReasons: {},
    };
  }

  function findMigrationPage(key) {
    var pages = [];
    try { pages = figma.root.children || []; } catch (_eRoot) { return null; }
    for (var i = 0; i < pages.length; i++) {
      try {
        if (pages[i].getPluginData("pixsoMigrationPage") === key) return pages[i];
      } catch (_ePage) { /* страница может быть недоступна */ }
    }
    return null;
  }
  async function ensureReceiverPage(name, session, options) {
    if (!options.createPages) {
      if (!session.currentPage) session.currentPage = figma.currentPage;
      await ensureCurrentPage(session.currentPage);
      if (!isPageAlive(session.firstPage)) session.firstPage = session.currentPage;
      return session.currentPage;
    }
    var key = String(name || "Pixso");
    if (!isPageAlive(session.pages[key])) {
      // Страницы помечаются plugin data, чтобы продолжение прерванной миграции
      // дописывало их, а не плодило дубликаты. Чужие страницы не трогаем:
      // метку ставит только приёмник.
      var existing = findMigrationPage(key);
      if (existing) {
        session.pages[key] = existing;
      } else {
        var page = figma.createPage();
        page.name = key;
        setPluginData(page, "pixsoMigrationPage", key);
        session.pages[key] = page;
        session.totals.pages += 1;
      }
    }
    var target = session.pages[key];
    // Тридцать chunks подряд в одну страницу больше не дают тридцати
    // loadAsync и тридцати переключений: и то и другое идемпотентно.
    await ensurePageLoaded(target);
    await ensureCurrentPage(target);
    session.currentPage = target;
    if (!isPageAlive(session.firstPage)) session.firstPage = target;
    return target;
  }

  /**
   * Единственное обновление вьюпорта за всю миграцию: после FINISH_JOB
   * показываем первую собранную страницу целиком. Раньше сюда уходил
   * scrollAndZoomIntoView после каждого корневого экрана.
   */
  async function focusMigrationResult(session) {
    try {
      var page = session && session.firstPage;
      if (!isPageAlive(page)) return;
      await ensureCurrentPage(page);
      var children = (page.children || []).filter(isAlive);
      if (children.length) figma.viewport.scrollAndZoomIntoView(children.slice(0, 100));
    } catch (_eFocus) { /* косметика не может ломать финал миграции */ }
  }

  async function handleReceiverTask(task, options) {
    var type = String(task.type || "");
    setReceiverPhase("task.start", {
      taskType: type,
      taskId: task.taskId || null,
      sequence: task.sequence === undefined ? null : task.sequence,
      page: (task.payload && task.payload.pageName) || null,
      root: (task.payload && task.payload.rootName) || (task.payload && task.payload.name) || null,
      created: 0,
    });

    // Direct PIX — отдельная ветка протокола. Она уходит в свой обработчик до
    // того, как здесь будет прочитано или изменено хоть что-то из состояния
    // Fast/Full: сессия, реестры и служебная страница у них разные.
    if (isDirectTask(type)) return handleDirectTask(task, options || {});

    var declaredMode = task.payload && task.payload.migrationMode;

    if (type === "START_JOB") {
      session = newSession(task.jobId, task.payload && task.payload.source, declaredMode);
      resetFontStats();
      return { ok: true, receiverVersion: RECEIVER_VERSION, migrationMode: session.migrationMode };
    }
    if (!session || session.jobId !== task.jobId) {
      // Producer стартовал job, которую этот приёмник не видел (перезапуск UI).
      session = newSession(task.jobId, null, declaredMode);
    }
    // Режим едет в каждой задаче: приёмник, подключившийся после START_JOB,
    // не должен молча собирать чужую job в другом режиме. Отсутствие поля —
    // это старый продюсер, и для него сохраняется прежний FULL.
    if (declaredMode) {
      session.migrationMode = normalizeMigrationMode(declaredMode);
      session.jobStats.migrationMode = session.migrationMode;
    }
    var fastJob = session.migrationMode === MIGRATION_MODE.FAST;
    if (session.processedTasks[task.taskId]) {
      return session.processedTasks[task.taskId];
    }

    var result;
    if (type === "PAGE_START") {
      var page = await ensureReceiverPage(task.payload && task.payload.pageName, session, options);
      result = { ok: true, page: page.name };
    } else if (type === "PAGE_END") {
      result = { ok: true };
    } else if (type === "COMPONENT_DEFS" && fastJob) {
      // В FAST продюсер эту задачу не отправляет. Если она всё же пришла —
      // это рассинхрон, а не повод начать реконструкцию: служебная страница
      // не создаётся, определения не собираются, инстансы едут деревом.
      session.jobStats.definitionTasksSkipped += 1;
      result = {
        ok: true,
        skipped: true,
        migrationMode: session.migrationMode,
        definitionRef: (task.payload && task.payload.definitionRef) || null,
        ready: [], components: 0, sets: 0, definitionNodesCreated: 0, failed: 0,
        warnings: ["FAST: определения компонентов не импортируются."],
        importDurationMs: 0,
      };
    } else if (type === "COMPONENT_DEFS") {
      // Определения едут до инстансов, которые на них ссылаются.
      var definitionPayload = task.payload || {};
      var definitionPackage = definitionPayload.package;
      validate(definitionPackage);
      var definitionStartedAt = Date.now();
      var definitionResult = null;
      var definitionFailure = null;
      try {
        definitionResult = await importDefinitions(definitionPackage, {
          nativeRegistry: session.nativeRegistry,
          jobId: session.jobId,
        });
      } catch (definitionError) {
        // Определение — оптимизация, а не обязательное условие. Ни одно из них
        // не имеет права уронить всю миграцию: неподтверждённое определение
        // означает лишь, что его инстансы уедут прежним snapshot-ом.
        definitionFailure = definitionError && definitionError.message || String(definitionError);
      }
      var definitionMs = Date.now() - definitionStartedAt;
      session.timing.definitionMs += definitionMs;
      session.timing.definitionTasks += 1;
      if (definitionResult) {
        session.totals.componentsImported += definitionResult.created.length;
        session.totals.componentSetsImported += definitionResult.sets.length;
        session.totals.uniqueDefinitionsImported +=
          definitionResult.created.length + definitionResult.sets.length;
        session.totals.definitionNodesCreated += definitionResult.report.created;
        session.totals.warnings += definitionResult.report.warnings.length;
      }
      result = {
        ok: true,
        definitionRef: definitionPayload.definitionRef || definitionPackage.definitionRef || null,
        // Приёмник подтверждает, на что уже можно ссылаться из инстансов.
        ready: definitionResult ? definitionResult.created.concat(definitionResult.sets) : [],
        components: definitionResult ? definitionResult.created.length : 0,
        sets: definitionResult ? definitionResult.sets.length : 0,
        definitionNodesCreated: definitionResult ? definitionResult.report.created : 0,
        failed: definitionResult ? definitionResult.report.definitionsFailed : 1,
        warnings: definitionResult
          ? definitionResult.report.warnings.slice(0, 8)
          : ["Определение не импортировано: " + definitionFailure],
        message: definitionFailure,
        importDurationMs: definitionMs,
      };
    } else if (type === "ROOT_NODE") {
      var payload = task.payload || {};
      // Пакет самодостаточен по определению: ассеты приходят вместе с ним,
      // никакой cross-chunk подстановки из кеша приёмника больше нет.
      var pkg = payload.package;
      validate(pkg);
      var rootStartedAt = Date.now();
      setReceiverPhase("root.page");
      await ensureReceiverPage(payload.pageName, session, options);
      var timings = {};
      var report = await importPackage(pkg, {
        includeLibrary: false,
        jobId: session.jobId,
        migrationMode: session.migrationMode,
        // Галочка приёмника управляет сборкой компонентов в обоих режимах.
        // Что именно она включает, определяет режим job: в FULL — хвост
        // component-aware реконструкции, в FAST — лёгкий семантический
        // промоушен поверх уже собранного визуального дерева.
        promoteComponents: options.promoteComponents !== false,
        preserveAbsolutePosition: true,
        nativeRegistry: session.nativeRegistry,
        // Вьюпорт двигается один раз на всю миграцию, в FINISH_JOB.
        skipViewport: true,
        timingsOut: timings,
      });
      var importDurationMs = Date.now() - rootStartedAt;
      session.totals.roots += report.roots;
      session.totals.nodes += report.created;
      session.totals.warnings += report.warnings.length;
      session.totals.fastInstances += report.fastInstances;
      session.totals.fastInstanceMisses += report.fastInstanceMisses;
      session.totals.propertiesApplied += report.propertiesApplied;
      session.totals.propertiesMissed += report.propertiesMissed;
      ["promoteScanMs", "componentCreateMs", "instanceCreateMs", "overrideCopyMs", "combineMs", "yieldCount"]
        .forEach(function (key) { session.timing[key] += report[key] || 0; });
      ["fastComponentsCreated", "fastComponentsReused", "fastInstancesCreated",
        "fastSnapshotsLeft", "fastComponentSets", "visualInstancesBuilt"]
        .forEach(function (key) { session.totals[key] += report[key] || 0; });
      if (report.maxSliceMs > session.timing.maxSliceMs) session.timing.maxSliceMs = report.maxSliceMs;
      if (report.promoteSkipped) session.timing.promoteSkippedRoots += 1;
      // В FAST реконструкция определений пропущена по режиму — но не
      // семантический промоушен. Считаем именно то, что пропущено.
      if (fastJob) session.jobStats.componentPreparationSkippedRoots += 1;
      for (var missReason in report.propertyMissReasons) {
        if (!Object.prototype.hasOwnProperty.call(report.propertyMissReasons, missReason)) continue;
        session.propertyMissReasons[missReason] =
          (session.propertyMissReasons[missReason] || 0) + report.propertyMissReasons[missReason];
      }
      session.timing.roots += 1;
      session.timing.importMs += importDurationMs;
      ["pageMs", "stylesMs", "buildMs", "promoteMs", "fastPromoteMs", "fontMs", "viewportMs"]
        .forEach(function (key) { session.timing[key] += timings[key] || 0; });
      result = {
        ok: true,
        migrationMode: session.migrationMode,
        nativePromotionSkipped: report.nativePromotionSkipped,
        fastSemanticPromotion: report.fastSemanticPromotion,
        componentPreparationSkipped: report.componentPreparationSkipped,
        roots: report.roots,
        created: report.created,
        // Счётчики лёгкого промоушена: сколько развёрнутых инстансов пришло,
        // во что они свернулись и сколько осталось snapshot-ами.
        visualInstancesBuilt: report.visualInstancesBuilt,
        fastComponentsCreated: report.fastComponentsCreated,
        fastComponentsReused: report.fastComponentsReused,
        fastInstancesCreated: report.fastInstancesCreated,
        fastSnapshotsLeft: report.fastSnapshotsLeft,
        fastComponentSets: report.fastComponentSets,
        fastPromoteMs: report.fastPromoteMs,
        promotionFailures: report.promotionFailures,
        fastInstances: report.fastInstances,
        fastInstanceMisses: report.fastInstanceMisses,
        propertiesApplied: report.propertiesApplied,
        propertiesMissed: report.propertiesMissed,
        propertyMissReasons: report.propertyMissReasons,
        propertyMissSamples: report.propertyMissSamples.slice(0, 5),
        nestedTargetsMissed: report.nestedTargetsMissed,
        // Что промоушен вообще рассматривал и сколько узлов не тронул.
        promoteSkipped: report.promoteSkipped,
        promoteScanNodes: report.promoteScanNodes,
        promoteCandidates: report.promoteCandidates,
        nodesSkippedFromPromoteScan: report.nodesSkippedFromPromoteScan,
        yieldCount: report.yieldCount,
        maxSliceMs: report.maxSliceMs,
        averageSliceMs: report.yieldCount ? Math.round(report.sliceTotalMs / report.yieldCount) : 0,
        warnings: report.warnings.slice(0, 8),
        totals: session.totals,
        // FIGMA_IMPORT_MS: позволяет продюсеру отделить импорт от транспорта.
        importDurationMs: importDurationMs,
        phases: timings,
      };
    } else if (type === "FINISH_JOB") {
      // У каждого режима своя служебная страница. FAST помечает готовой свою
      // и не касается страницы определений FULL — чужую страницу плагин не
      // переписывает и, разумеется, не удаляет: это документ пользователя.
      session.jobStats.servicePageTouched = markServicePageReady(
        session.nativeRegistry,
        fastJob ? SERVICE_PAGES.fast : SERVICE_PAGES.definitions
      );
      var viewportStartedAt = Date.now();
      await focusMigrationResult(session);
      session.timing.finalViewportMs = Date.now() - viewportStartedAt;
      session.timing.fonts = { requests: fontLoadStats.requests, loads: fontLoadStats.loads, ms: fontLoadStats.ms };
      result = {
        ok: true,
        migrationMode: session.migrationMode,
        jobStats: session.jobStats,
        totals: session.totals,
        timing: session.timing,
        propertyMissReasons: session.propertyMissReasons,
      };
    } else {
      // Неизвестный тип из более новой версии producer: не роняем миграцию.
      result = { ok: true, skipped: true, type: type };
    }

    session.processedTasks[task.taskId] = result;
    return result;
  }

  // =========================================================================
  // Direct PIX receiver [ЭКСПЕРИМЕНТАЛЬНО]
  //
  // Третий, отдельный вход в приёмник. Он не пересекается ни с ручным
  // импортом, ни с Fast/Full: у него свой протокол задач (`DIRECT_PIX_*`),
  // своя сессия, свои реестры и своя служебная страница. Удаление всего этого
  // блока обязано оставить прежние режимы работоспособными.
  //
  // Смысл ветки — проверить гипотезу: определение компонента строится один
  // раз, вхождение создаётся через createInstance(), сверху накладывается
  // дельта Pixso. Ни развёрнутых snapshot-деревьев, ни промоушена.
  //
  // Всё, что не удалось применить доказуемо, считается и уезжает в отчёт.
  // Молча приблизить и объявить успехом — запрещено.
  // =========================================================================

  var DIRECT_PROTOCOL = "PIXSO2FIGMA_DIRECT_PIX";
  var DIRECT_PROTOCOL_VERSION = 1;
  var DIRECT_TASK_PREFIX = "DIRECT_PIX_";
  // Описание служебной страницы живёт в одном месте — в реестре SERVICE_PAGES.
  var DIRECT_SERVICE_PAGE = SERVICE_PAGES.direct;
  /** Раскладка определений на служебной странице. */
  var DIRECT_SHELF_GAP = 80;
  var DIRECT_SHELF_WIDTH = 4000;
  // Шаг между участниками внутри набора вариантов и поля набора вокруг них.
  // Величина косметическая, но фиксированная: набор обязан читаться одинаково
  // независимо от того, каким чанком приехал его участник.
  var DIRECT_VARIANT_GAP = 16;
  var DIRECT_VARIANT_PADDING = 16;
  // Зазор между семействами на служебной странице. Он заметно больше
  // внутреннего шага: границу между семействами должно быть видно, не читая имён.
  var DIRECT_FAMILY_GAP = 160;

  var directSession = null;

  function isDirectTask(type) {
    return String(type || "").indexOf(DIRECT_TASK_PREFIX) === 0;
  }

  function newDirectSession(jobId, source, options) {
    options = options || {};
    // Тот же массив виден и как `overrideMissSamples` (его читает отчёт), и
    // как пул с квотой: два имени на одни данные, а не две копии.
    var missSamples = [];
    // Учёт уступок потока: сколько раз, сколько работы между ними и сколько
    // стоило само переключение.
    var sliceReport = { yieldCount: 0, sliceTotalMs: 0, maxSliceMs: 0, yieldWaitMs: 0 };
    return {
      jobId: jobId,
      source: source || null,
      processedTasks: {},
      // Реестры уровня job: определение, ассет и страница создаются один раз
      // и переиспользуются всеми chunk-ами этой задачи.
      registry: { directPage: null },
      // Бюджет непрерывной работы на всю задачу, а не на отдельный цикл.
      // Пока он общий, плагин физически не может занять поток дольше
      // одного бюджета подряд — где бы работа ни шла.
      slice: createSlice(sliceReport, DIRECT_SLICE_MS),
      sliceReport: sliceReport,
      definitions: Object.create(null),
      definitionStructuralMaps: Object.create(null),
      definitionStructuralSignatures: Object.create(null),
      definitionComponentKeys: Object.create(null),
      // D48 publication identity (`publishFile + publishID`) is the formal
      // cross-local family identity for copied library mirrors.
      definitionPublicationIdentities: Object.create(null),
      // D52. Два производных индекса поверх `definitionStructuralMaps`.
      // Оба отвечают на вопросы, которые раньше решались линейным сканом на
      // КАЖДОМ шаге override-пути, и именно этот скан стоил кратного времени
      // импорта на больших определениях (table / cell и её вложенные сеты).
      // Индексы строятся один раз на определение и снимаются вместе с самой
      // структурной картой: производный кеш не имеет права пережить источник.
      definitionOverrideKeyIndexes: Object.create(null),
      definitionPublicationGroups: Object.create(null),
      // D52. Эквивалентность пары определений — чистая функция от уже
      // построенных структурных карт, но считается она двумя сортировками
      // всех путей и полным их сравнением. В разборе override-путей этот
      // вопрос задаётся на каждом межопределенческом шаге, причём дважды
      // подряд с теми же аргументами. Ответ кешируется на пару и сбрасывается
      // вместе с любой структурной картой.
      definitionEquivalenceCache: Object.create(null),
      // Slash-separated component naming hierarchy is an official Pixso/Figma
      // organization signal. It supports disambiguation but never creates
      // identity without formal component/property evidence.
      definitionComponentNameHierarchies: Object.create(null),
      definitionNodeCounts: Object.create(null),
      definitionCanonicalRichness: Object.create(null),
      // Variant coordinate is part of canonical identity. Two variants can
      // share a published componentKey and the same node-type shape while
      // carrying different visual defaults (selected/hover/etc.). Treating
      // them as interchangeable applies overrides to the wrong state.
      definitionVariantIdentities: Object.create(null),
      variantAliasSamples: [],
      // Определение, переиспользовавшее ЧУЖОЙ физический компонент по
      // доказательству эквивалентности: definitionId → definitionId канона.
      // Своя идентичность у него сохраняется — адресация overrides идёт по
      // его собственному дереву, и доказательство гарантирует, что пути в
      // каноне те же.
      definitionAliases: Object.create(null),
      // Кандидаты на сравнение, сгруппированные по узкому признаку
      // идентичности. Без него пришлось бы сравнивать каждое определение с
      // каждым; с ним в корзине лежат только копии ОДНОЙ публикации либо
      // одного componentKey.
      definitionsByIdentityBucket: Object.create(null),
      definitionAliasSamples: [],
      definitionAliasSampleLimit: 40,
      // Реестр жизненного цикла определения: стабильный id узла Figma рядом
      // с закешированной ссылкой. Ссылка живёт ровно столько, сколько её
      // держит хост; id не устаревает и потому годится в доказательство.
      definitionRegistry: Object.create(null),
      definitionChunks: 0,
      definitionUnavailableByReason: Object.create(null),
      definitionUnavailableSamples: [],
      // Семейства вариантов: groupId → участники, пришедшие в этой job.
      // Реестр уровня job, как определения: набор собирается один раз и
      // только из тех участников, которые действительно доехали.
      variantGroups: Object.create(null),
      // D42: compatible copied/local groups may be complementary source
      // subsets of one published family. Keep a separate aggregation index so
      // we can form one physical Figma set without collapsing local component
      // definitions or their GUID namespaces.
      variantAggregateByLocalGroup: Object.create(null),
      variantGroupsByStableFamily: Object.create(null),
      // definitionId → groupId. Прямая карта: без неё пришлось бы искать
      // участника перебором семейств на каждом созданном вхождении.
      variantGroupByDefinition: Object.create(null),
      // Stable family + verified coordinate -> one physical Figma variant.
      // Local Pixso definition ids remain valid aliases, but only after the
      // complete definition-identity proof in directEquivalentDefinition.
      variantCanonicalByStableCoordinate: Object.create(null),
      variantCanonicalAliases: Object.create(null),
      variantFallbackByReason: Object.create(null),
      variantFallbackSamples: [],
      variantInstanceSamples: [],
      // Ticket 05: фактические имена component properties, созданные Figma.
      // Ключ верхнего уровня — id владельца схемы (COMPONENT или
      // COMPONENT_SET), внутри — публичный propertyId Pixso.
      nativePropertyNames: Object.create(null),
      nativePropertySchemas: Object.create(null),
      // D49: owner-local logical schema. Cross-local mirrors can assign
      // different Pixso public property ids to the same published slot; the
      // stable binding identity (field + overrideKey) lets both ids reuse one
      // Figma property without duplicate declarations.
      nativePropertyNamesByBinding: Object.create(null),
      nativePropertySchemasByBinding: Object.create(null),
      // Ticket 05 live diagnostics: Figma может отвергнуть отдельное
      // setProperties без объяснения в агрегированном счётчике. Храним
      // только короткую bounded-выборку идентификаторов и текста ошибки.
      nativePropertyRejectSamples: [],
      // D51 A3: bounded reasons for host-side exposed-instance rejection and
      // read-back loss. Exposure is semantic state, so a bare aggregate count
      // is not sufficient diagnostics.
      exposedInstanceRejectSamples: [],
      // Bounded read-back базовых layout/text semantics: в отчёт попадают
      // только несовпадения ожидаемого IR и фактического узла Figma.
      layoutTextParity: { counts: Object.create(null), samples: [], limit: 80, textSamples: [], textLimit: 40 },
      degenerateFillFixed: Object.create(null),
      // D29: bounded final visual read-back for fields that can be accepted by
      // the host and still be rewritten later by style/component/layout
      // materialization.  This is diagnostic-only and never mutates nodes.
      visualParity: {
        counts: Object.create(null), samples: [], limit: 120,
        perCode: Object.create(null), perCodeLimit: 10,
      },
      // D34: source-side audit is aggregated from ROOT payloads. It answers a
      // different question than Figma parity: did Pixso semantics survive IR
      // construction before the receiver ever saw the node?
      sourceSemanticReport: {
        counts: Object.create(null), samples: [], componentPropertySamples: [],
        sampleLimit: 160, componentSampleLimit: 240, nodesAudited: 0, overridesAudited: 0
      },
      // D34: stage-aware effect trace for native BOOL/TEXT/SWAP properties.
      // Records the bound descendant state immediately after setProperties and
      // again after all low-level/style/layout passes.
      semanticEffectTrace: { samples: [], limit: 320, dropped: 0 },
      // D36: bounded ledger of destructive later writes. It answers the user's
      // concrete suspicion that an early correct state is overwritten by a
      // subsequent pass: visible true→false, non-empty text→empty, paints or
      // native style identity cleared, clipping enabled, or definition changed.
      destructiveOverwriteReport: {
        counts: Object.create(null), byStage: Object.create(null), samples: [], limit: 120,
        // Квота на код: 58 стёртых обводок больше не могут остаться без
        // единого образца рядом с 2041 очищенной привязкой стиля.
        perCode: Object.create(null), perCodeLimit: 12,
        // Visibility gets a dedicated destructive-only lane so an early flood
        // of paint/text destruction cannot evict the event we actually need.
        visibilitySamples: [], visibilityLimit: 160
      },
      // D40: source/component identity is diagnostic provenance, not a merge
      // key. Local Pixso GUID spaces stay authoritative for materialization.
      componentIdentityLedger: { definitions: [], occurrences: [], limit: 240 },
      instanceNameParity: { mismatches: 0, restored: 0, samples: [], limit: 80 },
      finalMainComponentParity: { mismatches: 0, samples: [], limit: 80 },
      // D17: bounded causal read-back for the remaining semantic sizing tail.
      // Unlike parity this records the setter applicability/result, so a live
      // log distinguishes a host rejection from a later mutation.
      semanticSizingTrace: { samples: [], limit: 80 },
      // Диагностический шлюз: участники семейств записываются и
      // переименовываются как обычно, но объединение не выполняется. Нужен
      // ровно для одного — сравнить результат с объединением и без него на
      // ОДНОМ и том же материале.
      variantCombine: options.variantCombine !== false,
      // sourceId импортированных корней. Нужны ровно одному — диагностической
      // сверке дерева, которую включает явный флаг.
      importedRootIds: [],
      // Вхождения, выродившиеся в placeholder: nodeId → причина. Дальнейшие
      // промахи под ними обязаны сохранить причину и не попасть в счётчики
      // обычной адресации.
      degradedInstances: Object.create(null),
      definitionTrace: {
        records: [], seen: Object.create(null),
        limit: Math.max(1, Number(options.definitionTraceLimit) || 12),
      },
      assets: Object.create(null),
      // Нативные стили этой миграции: styleId пакета → объект стиля Figma.
      // Реестр живёт в сессии job, как определения и ассеты: чужая миграция
      // заводит свою сессию и не может подхватить эти стили.
      styles: Object.create(null),
      pages: Object.create(null),
      firstPage: null,
      shelf: { x: 0, y: 0, rowHeight: 0 },
      // Диагностика размера по стадиям. `null` — выключено, и тогда на
      // горячем пути стоит ровно одна проверка на null.
      sizeTrace: directNewSizeTrace(options.sizeTraceIds, options.sizeTraceLimit),
      // Автоматический bounded trace стадий occurrence pipeline. В отличие от
      // sizeTrace не требует заранее знать guid: фиксирует только реальные
      // изменения между swaps → native properties → low-level overrides →
      // final restore и потому пригоден для live-диагностики неизвестного бага.
      stageTrace: (options.debugOverrides || Number(options.stageTraceLimit) > 0)
        ? directNewStageTrace(options.stageTraceLimit) : null,
      // Exact source-id reconciliation for instance creation. This is bounded
      // only at the reporting layer: the maps are one small string entry per
      // planned instance and let FINISH explain expected-created deltas instead
      // of leaving a bare counter difference.
      instanceReconciliation: {
        expected: Object.create(null),
        created: Object.create(null),
        failures: Object.create(null),
        sampleLimit: 40,
      },
      // D27 source-side hop provenance forwarded by the Direct PIX sender.
      // It is bounded before transport and bounded again here so even a huge
      // file cannot bloat the receiver log.
      deepOverrideProvenanceSamples: [],
      deepOverrideProvenanceLimit: 40,
      totals: {
        definitionsCreated: 0, definitionsReused: 0, definitionNodes: 0,
        // Копии, схлопнутые в один физический компонент по доказательству
        // эквивалентности. Подмножество definitionsReused: величина отвечает
        // на вопрос «сколько дубликатов исходник привёз», а не «сколько раз
        // мы встретили тот же definitionId».
        definitionsAliasedByProof: 0,
        instancesCreated: 0, ordinaryNodesCreated: 0,
        // Сколько вхождений IR ОЖИДАЛ увидеть инстансами, сколько ими стало
        // и сколько выродилось в placeholder. Без первой величины две
        // остальные ни о чём не говорят.
        expectedInstances: 0,
        instanceDefinitionUnavailable: 0, placeholderFramesCreated: 0,
        overridesApplied: 0, overridesMissed: 0,
        overridesAttempted: 0, overrideStepsUnverified: 0,
        // Перевод шага по overrideKey на стороне ресивера считается
        // `overrideKeyTranslationSteps` и увеличивается тем самым кодом,
        // который его выполняет. Отдельного нуля здесь быть не должно:
        // неувеличиваемый счётчик — это подставленный ноль, а не измеренный.
        textOverridesSeen: 0, textOverridesApplied: 0, textOverridesNoOp: 0,
        textClearsExplicit: 0, textClearsBlocked: 0,
        textVisibilityChanges: 0,
        textStyleClearsExplicit: 0, textStyleClearsBlocked: 0,
        explicitTextChanges: 0, explicitTextClears: 0,
        blockedImplicitTextClears: 0, visibilityChanges: 0, styleClears: 0,
        paintClearsExplicit: 0, paintClearsBlocked: 0,
        paintOverridePresent: 0, paintOverrideApplied: 0,
        paintDefaultArrayIgnored: 0, paintClearRefused: 0,
        structuralStepsVerified: 0,
        nativeInstancesConsidered: 0, nativeInstancesVisualSafe: 0,
        nativeInstancesUnsafe: 0,
        // Нативные наборы вариантов. «Увидели», «собрали» и «откатили»
        // держатся врозь: группа, оставшаяся набором самостоятельных
        // компонентов, — это не потеря визуала, и складывать её с отказом
        // определения нельзя.
        variantGroupsSeen: 0, variantGroupsCombined: 0, variantGroupsFallback: 0,
        variantMembersSeen: 0, variantMembersCombined: 0, variantMembersFallback: 0,
        variantMembersLostAfterCombine: 0,
        // Участники, вошедшие в УЖЕ собранный набор. Порядок вариантов в
        // Figma задаётся порядком детей набора, поэтому опоздавший участник
        // встаёт в конец, а не на своё место по словарю источника. Величина
        // измеряется, а не замалчивается: это и есть цена чанкования.
        variantMembersJoinedLate: 0,
        variantMembersRejectedAsDuplicate: 0,
        variantSetsHealthChecked: 0, variantSetsInErrorState: 0,
        variantFamiliesCompleteAtCombine: 0,
        variantFamilyMembersDeferred: 0,
        variantLazySingletonFamilies: 0,
        variantFamiliesIncompleteAtCombine: 0,
        nativePropertiesDeclared: 0, nativePropertiesCreated: 0,
        nativePropertyBindingsApplied: 0, nativePropertyBindingsMissed: 0,
        nativePropertyValuesApplied: 0, nativePropertyValuesMissed: 0,
        nativePropertyValuesVerified: 0, nativePropertyValuesUnverified: 0,
        nativeOwnedLowLevelSuppressed: 0, nativeOwnedLowLevelFallback: 0,
        nativeSwapChildLayoutRestored: 0,
        exposedInstancesRequested: 0, exposedInstancesApplied: 0, exposedInstancesVerified: 0,
        exposedInstancesVerificationMissed: 0,
        exposedInstancesRejected: 0, exposedInstancesNonPrimarySkipped: 0,
        assetsCreated: 0, assetsDownsampled: 0, unsupported: 0, pages: 0, roots: 0, rootsFailed: 0,
        // Нативные стили. «Создан» и «переиспользован» считаются раздельно:
        // главное утверждение этой ветки — один стиль источника даёт один
        // стиль Figma, и подтвердить его может только вторая величина.
        paintStylesCreated: 0, paintStylesReused: 0,
        textStylesCreated: 0, textStylesReused: 0,
        effectStylesCreated: 0, effectStylesReused: 0,
        stylesUnsupported: 0, styleFontFallbacks: 0,
        fillStyleBindings: 0, strokeStyleBindings: 0,
        effectStyleBindings: 0, textStyleBindings: 0,
        styleBindingsFailed: 0, styleBindingsMissingStyle: 0,
      },
      timings: {
        definitionBuildMs: 0, ordinaryBuildMs: 0, instanceCreateMs: 0,
        overrideApplyMs: 0, assetMs: 0, totalImportMs: 0, fontMs: 0,
        styleBuildMs: 0,
        // Сборка наборов вариантов мерится отдельно от сборки определений:
        // одно имя на две разные фазы скрывает, чем именно занято время.
        variantCombineMs: 0,
      },
      unsupported: Object.create(null),
      debugOverrides: !!options.debugOverrides,
      traceTextOverrides: !!options.traceTextOverrides,
      textOverrideTraceLimit: Math.max(1, Number(options.textOverrideTraceLimit) || 20),
      textOverrideTraceSamples: [],
      fullDocument: !!options.fullDocument,
      overrideMissReasons: Object.create(null),
      overrideMissSamples: missSamples,
      overrideMissPool: {
        samples: missSamples,
        limit: options.debugOverrides ? 40 : 20,
        perCodeLimit: options.debugOverrides ? 8 : 4,
      },
      nativeUnsafeByReason: Object.create(null),
      nativeUnsafeDirectByReason: Object.create(null),
      nativeUnsafeInheritedByReason: Object.create(null),
      // Inherited visual-safety reasons fan out through every occurrence of a
      // broken definition. Keep the root definition in the report so a single
      // source defect is not mistaken for hundreds of unrelated occurrences.
      nativeUnsafeInheritedByDefinition: Object.create(null),
      nativeUnsafeSamples: [],
      currentInstanceAudit: null,
      // Узлы, у которых подмена компонента сменила активное определение.
      // Запись plugin data на подслое инстанса хостом не гарантирована,
      // поэтому результат подмены держится ещё и здесь.
      swappedDefinitions: Object.create(null),
      // Per-instance swap provenance. Unlike swappedDefinitions this keeps the
      // pre-swap identity, so stale descendant state can be distinguished from
      // a legitimate explicit override after an unrelated component swap.
      swapProvenance: Object.create(null),
      // Успешно применённые native property values этой сессии. Ключ —
      // instance host-id + public property id. Нужен только для ownership:
      // low-level операция, порождённая ТЕМ ЖЕ Pixso property, подавляется
      // лишь после подтверждённого setProperties; при любом reject остаётся
      // прежним visual fallback.
      nativePropertyApplied: Object.create(null),
      // D42: public component-property ownership survives local GUID-space
      // changes. Keyed by root occurrence host-id + Pixso public property id;
      // value is the live INSTANCE that actually accepted/verified setProperties.
      // This is not a name lookup and never chooses a component by DS-specific
      // strings: it is populated only after schema-backed property resolution.
      nativePropertyAppliedOwners: Object.create(null),
      // Bounded universal reconstruction diagnostics. Visible names are stored
      // as evidence only; production decisions still require formal identity,
      // property schema or an unambiguous live route.
      reconstructionManifest: { families: [], propertyRoutes: [], limit: 160 },
      // Bound descendant fields whose effect was verified immediately after
      // native setProperties. Late low-level replay is not allowed to overwrite
      // these fields merely because source-side ownership metadata was stale.
      nativeEffectOwners: Object.create(null),
      // Исходный root-spec каждого canonical definition. Нужен, чтобы у
      // occurrence отличать настоящую собственную коробку от простого
      // наследования HUG-оси мастера: молчание override само по себе не
      // доказывает FIXED.
      definitionRootSpecs: Object.create(null),
    };
  }

  /**
   * Присваивание, которое честно отвечает, получилось ли. Счётчик
   * применённых overrides обязан считать факт, а не попытку: `setValue`
   * общего импортёра глотает отказ молча и для диагностики Direct PIX
   * не годится.
   */
  function directSet(node, key, value) {
    if (value === undefined) return false;
    try { node[key] = value; return true; } catch (_e) { return false; }
  }

  var DIRECT_STROKE_SIDE_KEYS = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];

  /**
   * Единственная точка, где узлу назначается толщина обводки.
   *
   * У Figma это свойство с двумя представлениями: общий `strokeWeight` и
   * четыре стороны. Присвоение одного молча перетирает другое, поэтому два
   * независимых присваивания на одну величину — гонка, а не два шага: какая
   * толщина останется, решает порядок, а не источник. Источник и так отдаёт
   * ровно один носитель, но приёмник не имеет права на это полагаться.
   *
   * Общий сеттер, кроме того, не всегда снимает независимый режим: цель
   * override, унаследовавшая от определения разные стороны, после
   * `strokeWeight = 1` продолжает читаться как `figma.mixed` и сохраняет
   * прежнюю рамку. Для таких целей значение дублируется во второе
   * представление — вслепую, флагом `assertSides`, а не по результату чтения.
   *
   * Читать узел здесь нельзя. Чтение свойства сразу после записи заставляет
   * Figma пересчитать уже построенную часть документа, и цена такого чтения
   * растёт вместе с документом: замер на корне `6:307142` показал 18,7 с до
   * и 485 с после — при том же составе узлов. Свежесозданному узлу
   * дублирование и не нужно: независимого режима у него взяться неоткуда.
   */
  function directApplyStrokeWeights(node, uniform, sides, assertSides) {
    var applied = false;
    if (sides) {
      applied = directSet(node, "strokeTopWeight", sides.top) || applied;
      applied = directSet(node, "strokeRightWeight", sides.right) || applied;
      applied = directSet(node, "strokeBottomWeight", sides.bottom) || applied;
      applied = directSet(node, "strokeLeftWeight", sides.left) || applied;
      return applied;
    }
    if (typeof uniform !== "number") return false;
    applied = directSet(node, "strokeWeight", uniform);
    if (assertSides) {
      for (var i = 0; i < DIRECT_STROKE_SIDE_KEYS.length; i++) {
        applied = directSet(node, DIRECT_STROKE_SIDE_KEYS[i], uniform) || applied;
      }
    }
    return applied;
  }

  /**
   * Годится ли узел в родители. Отдельная проверка, потому что `isAlive`
   * рассчитан на scene node и требует наличия родителя — у страницы его в
   * этом смысле нет, и корень дерева на ней бы не появился.
   */
  function directCanHoldChildren(node) {
    if (!node) return false;
    try { if (node.removed) return false; } catch (_e) { return false; }
    return typeof node.appendChild === "function";
  }

  /**
   * Отпечаток загруженной сборки приёмника.
   *
   * Отвечает на вопрос, на который `RECEIVER_VERSION` ответить не может:
   * какой именно код сейчас исполняется в Figma. Поэтому флаги здесь только
   * те, что ИЗМЕРЯЮТ сборку — наличие функций. Прописанный `true` одинаков у
   * любой сборки и ничего не отличает; прежние такие флаги удалены, контракты,
   * которые они называли, закреплены тестами. `probeVersion` отличает каталог
   * опытов, протоколы — совместимость с отправителем.
   */
  function directBuildFingerprint() {
    return {
      receiverVersion: RECEIVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      directProtocolVersion: DIRECT_PROTOCOL_VERSION,
      probeVersion: PROBE_VERSION,
      occurrenceAxisPatch: typeof directOwnLayoutModes === "function" &&
        typeof directPinRestoredAxes === "function",
      sizeTrace: typeof directSizeStage === "function",
      // Без этого флага пустой `definitionLifetimeReport` неотличим от
      // «плагин не перезапускали».
      definitionLifetime: typeof directDefinitionState === "function" &&
        typeof directDiscardDefinition === "function" &&
        typeof directTraceDefinition === "function",
      sourceTextWidthOwnershipPreserved: typeof directEffectiveTextAutoResize === "function",
      idempotentTextOverflowReplay: typeof directReassertTextOverflow === "function",
      occurrenceStageTrace: typeof directStageRecord === "function",
      sourceBoxesDiagnosticOnly: typeof directAuditSourceBoxes === "function",
    };
  }

  /** Список guid, за которыми следит диагностика. Пустой список — выключено. */
  function directNewSizeTrace(ids, limit) {
    if (!ids || !ids.length) return null;
    var map = Object.create(null);
    for (var i = 0; i < ids.length; i++) if (ids[i]) map[String(ids[i])] = true;
    if (!Object.keys(map).length) return null;
    return { ids: map, records: [], limit: limit > 0 ? limit : 400 };
  }

  function directSizeNumber(value) {
    return typeof value === "number" && isFinite(value)
      ? Math.round(value * 100) / 100 : null;
  }

  /**
   * Снимок ОДНОГО узла: габарит, габарит родителя и всё состояние sizing.
   * Читается через try/catch поштучно: у части типов узлов части свойств
   * просто нет, и падать на диагностике нельзя.
   */
  function directSizeSnapshot(node) {
    var out = {};
    try { out.w = directSizeNumber(node.width); out.h = directSizeNumber(node.height); } catch (_eBox) {}
    try {
      var parent = node.parent;
      if (parent) {
        out.pw = directSizeNumber(parent.width);
        out.ph = directSizeNumber(parent.height);
        out.pMode = parent.layoutMode || null;
      }
    } catch (_eParent) {}
    ["layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode",
      "layoutGrow", "layoutAlign", "layoutPositioning", "textAutoResize"].forEach(function (key) {
      try {
        var value = node[key];
        if (value !== undefined && value !== null) out[key] = value;
      } catch (_eField) {}
    });
    return out;
  }

  /**
   * Одна стадия жизни отслеживаемого узла.
   *
   * `op` — конкретная операция, которая привела к этой стадии. Именно она
   * является ответом на вопрос «что изменило размер»: стадии без неё
   * показывают состояние, стадия с ней — виновника.
   */
  function directSizeStage(session, id, stage, node, op) {
    var trace = session && session.sizeTrace;
    if (!trace || !id || !trace.ids[id]) return;
    if (trace.records.length >= trace.limit) return;
    if (!node) { trace.records.push({ id: id, stage: stage, op: op || null, gone: true }); return; }
    var record = directSizeSnapshot(node);
    record.id = id;
    record.stage = stage;
    if (op) record.op = op;
    trace.records.push(record);
  }

  /** Следим ли мы за этим spec вообще — чтобы не собирать снимок впустую. */
  function directSizeTraced(session, id) {
    return !!(session && session.sizeTrace && id && session.sizeTrace.ids[id]);
  }

  /**
   * Автоматическая трассировка стадий. Она всегда включена, но bounded:
   * сохраняются только операции, которые ФАКТИЧЕСКИ изменили наблюдаемое
   * состояние узла, плюс короткие записи native setProperties. Поэтому лог
   * остаётся конечным даже на больших документах и не требует заранее знать
   * id проблемного компонента.
   */
  function directNewStageTrace(limit) {
    var parsed = Number(limit);
    return {
      records: [],
      limit: parsed > 0 ? Math.min(1000, parsed) : 240,
      dropped: 0,
      summary: {
        records: 0, nativeSetCalls: 0, nativeSetRejected: 0,
        lowLevelMutations: 0, rootStageMutations: 0, finalRestoreMutations: 0,
        byField: Object.create(null), byStage: Object.create(null),
      },
    };
  }

  function directStageValue(value) {
    if (typeof value === "number") return directSizeNumber(value);
    if (typeof value === "string") return value.length > 120 ? value.slice(0, 117) + "..." : value;
    if (typeof value === "boolean" || value === null) return value;
    return value;
  }

  function directStageSnapshot(node) {
    if (!node) return null;
    var out = { type: nodeType(node), sourceId: directSourceId(node) || null };
    try { out.nodeId = nodeIdentity(node) || null; } catch (_eId) {}
    ["x", "y", "width", "height", "visible", "opacity", "clipsContent", "layoutMode",
      "primaryAxisSizingMode", "counterAxisSizingMode", "layoutGrow",
      "layoutAlign", "layoutPositioning", "textAutoResize",
      "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"].forEach(function (key) {
      try {
        var value = node[key];
        if (value !== undefined && value !== null) out[key] = directStageValue(value);
      } catch (_eField) {}
    });
    try {
      var stageFills = node.fills;
      if (Array.isArray(stageFills)) out.fillsCount = stageFills.length;
    } catch (_eFills) {}
    try {
      var stageStrokes = node.strokes;
      if (Array.isArray(stageStrokes)) out.strokesCount = stageStrokes.length;
    } catch (_eStrokes) {}
    if (out.type === "TEXT") {
      try { out.characters = directStageValue(node.characters); } catch (_eText) {}
    }
    if (out.type === "INSTANCE") {
      try { out.definitionId = getPluginData(node, "pixsoDirectDefinitionId") || null; } catch (_eDef) {}
      try {
        var vp = node.variantProperties;
        if (vp) out.variantProperties = clone(vp);
      } catch (_eVariant) {}
    }
    return out;
  }

  function directStageEqual(left, right) {
    if (left === right) return true;
    if (left === null || right === null || left === undefined || right === undefined) return false;
    if (typeof left !== "object" || typeof right !== "object") return false;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch (_eJson) { return false; }
  }

  function directStageDiff(before, after) {
    var changed = Object.create(null);
    if (!before || !after) return changed;
    var keys = Object.create(null);
    Object.keys(before).forEach(function (key) { keys[key] = true; });
    Object.keys(after).forEach(function (key) { keys[key] = true; });
    Object.keys(keys).forEach(function (key) {
      if (key === "nodeId" || key === "sourceId" || key === "type") return;
      if (!directStageEqual(before[key], after[key])) {
        changed[key] = { before: before[key], after: after[key] };
      }
    });
    return changed;
  }

  /**
   * Квота образцов НА КОД, а не общий пул.
   *
   * Общий пул выигрывает тот, кого больше. На реальном прогоне 2041 очищенная
   * привязка стиля забрала все 120 мест, и 58 стёртых обводок не получили НИ
   * ОДНОГО образца: счётчик проблему показывал, а доказательств по ней не было
   * вовсе — расследовать нечем. Ровно ради этого для видимости когда-то
   * вырезали отдельную полосу; здесь то же правило сделано общим для всех
   * кодов, чтобы следующий редкий дефект не пришлось спасать руками.
   *
   * Общий потолок пула остаётся: отчёт обязан быть ограничен по объёму.
   */
  function directAdmitSample(pool, codes) {
    if (!pool || !pool.samples || !codes || !codes.length) return false;
    if (pool.samples.length >= pool.limit) return false;
    if (!pool.perCode) pool.perCode = Object.create(null);
    var quota = pool.perCodeLimit || Math.max(1, Math.floor(pool.limit / 10));
    var admitted = false;
    for (var i = 0; i < codes.length; i++) {
      if ((pool.perCode[codes[i]] || 0) < quota) { admitted = true; break; }
    }
    if (!admitted) return false;
    for (var j = 0; j < codes.length; j++) {
      pool.perCode[codes[j]] = (pool.perCode[codes[j]] || 0) + 1;
    }
    return true;
  }

  function directRecordDestructiveOverwrite(session, stage, before, after, changed, meta) {
    var report = session && session.destructiveOverwriteReport;
    if (!report || !before || !after) return;
    var reasons = [];
    function add(code) { if (reasons.indexOf(code) < 0) reasons.push(code); }
    if (before.visible === true && after.visible === false) add("VISIBLE_TRUE_TO_FALSE");
    if (typeof before.characters === "string" && before.characters.length && after.characters === "") add("TEXT_NONEMPTY_TO_EMPTY");
    if (typeof before.fillsCount === "number" && before.fillsCount > 0 && after.fillsCount === 0) add("FILLS_NONEMPTY_TO_EMPTY");
    if (typeof before.strokesCount === "number" && before.strokesCount > 0 && after.strokesCount === 0) add("STROKES_NONEMPTY_TO_EMPTY");
    ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"].forEach(function (field) {
      if (typeof before[field] === "string" && before[field] && (!after[field] || after[field] === "")) {
        add(field.toUpperCase() + "_CLEARED");
      }
    });
    if (before.clipsContent === false && after.clipsContent === true) add("CLIP_CONTENT_ENABLED");
    if (before.definitionId && after.definitionId && before.definitionId !== after.definitionId) add("INSTANCE_DEFINITION_CHANGED");
    if (!reasons.length) return;
    for (var r = 0; r < reasons.length; r++) {
      report.counts[reasons[r]] = (report.counts[reasons[r]] || 0) + 1;
      report.byStage[stage] = (report.byStage[stage] || 0) + 1;
    }
    if (reasons.indexOf("VISIBLE_TRUE_TO_FALSE") >= 0 &&
        report.visibilitySamples && report.visibilitySamples.length < report.visibilityLimit) {
      report.visibilitySamples.push({
        stage: stage,
        instanceSourceId: session.currentInstanceAudit && session.currentInstanceAudit.spec
          ? session.currentInstanceAudit.spec.id : null,
        targetSourceId: after.sourceId || before.sourceId || null,
        targetType: after.type || before.type || null,
        before: before.visible, after: after.visible,
        op: meta && (meta.op || meta.lowLevelOp) || null,
        explicit: meta && meta.explicit !== undefined ? meta.explicit : null,
        propertyId: meta && meta.propertyId || null,
        propertyType: meta && meta.propertyType || null,
        nativeOwner: directNativeEffectOwner(meta && meta.target || null, "visible", session),
        ancestors: directAncestorVisibility(meta && meta.target || null),
        path: meta && meta.path || []
      });
    }
    if (!directAdmitSample(report, reasons)) return;
    report.samples.push({
      stage: stage,
      instanceSourceId: session.currentInstanceAudit && session.currentInstanceAudit.spec
        ? session.currentInstanceAudit.spec.id : null,
      targetSourceId: after.sourceId || before.sourceId || null,
      targetType: after.type || before.type || null,
      reasons: reasons, changed: changed,
      propertyId: meta && meta.propertyId || null,
      propertyType: meta && meta.propertyType || null,
      op: meta && meta.op || null,
      path: meta && meta.path || []
    });
  }

  function directAncestorVisibility(node) {
    var out = [];
    var current = null;
    try { current = node && node.parent; } catch (_eParent) { current = null; }
    var guard = 0;
    while (current && guard++ < 12) {
      var entry = { type: nodeType(current), sourceId: directSourceId(current) || null, visible: null };
      try { entry.visible = current.visible; } catch (_eVisible) {}
      out.push(entry);
      try { current = current.parent; } catch (_eNext) { current = null; }
    }
    return out;
  }

  function directNativeEffectOwner(node, field, session) {
    var identity = nodeIdentity(node);
    var owner = identity && session && session.nativeEffectOwners
      ? session.nativeEffectOwners[identity] : null;
    return owner && owner[field] ? clone(owner[field]) : null;
  }

  function directStageRecord(session, stage, target, before, meta, force) {
    var trace = session && session.stageTrace;
    if (!trace) return;
    var after = directStageSnapshot(target);
    var changed = directStageDiff(before, after);
    var fields = Object.keys(changed);
    var destructiveMeta = meta ? Object.assign({}, meta) : {};
    destructiveMeta.target = target;
    directRecordDestructiveOverwrite(session, stage, before, after, changed, destructiveMeta);
    if (!fields.length && !force) return;
    trace.summary.records += 1;
    trace.summary.byStage[stage] = (trace.summary.byStage[stage] || 0) + 1;
    fields.forEach(function (field) {
      trace.summary.byField[field] = (trace.summary.byField[field] || 0) + 1;
    });
    if (stage === "native-setProperties") trace.summary.nativeSetCalls += 1;
    if (stage.indexOf("low-level-") === 0 && fields.length) trace.summary.lowLevelMutations += 1;
    if (stage.indexOf("root-") === 0 && fields.length) trace.summary.rootStageMutations += 1;
    if (stage === "final-restore" && fields.length) trace.summary.finalRestoreMutations += 1;
    if (trace.records.length >= trace.limit) { trace.dropped += 1; return; }
    var record = {
      stage: stage,
      instanceSourceId: session.currentInstanceAudit && session.currentInstanceAudit.spec
        ? session.currentInstanceAudit.spec.id : null,
      targetSourceId: after && after.sourceId || before && before.sourceId || null,
      targetType: after && after.type || before && before.type || null,
      changed: changed,
    };
    if (meta) Object.keys(meta).forEach(function (key) { record[key] = meta[key]; });
    trace.records.push(record);
  }

  function directNote(session, code) {
    session.unsupported[code] = (session.unsupported[code] || 0) + 1;
    session.totals.unsupported += 1;
  }

  function directValidate(payload) {
    if (!payload || payload.protocol !== DIRECT_PROTOCOL) {
      throw new Error("Direct PIX: чужой протокол в задаче.");
    }
    if (Number(payload.directVersion) !== DIRECT_PROTOCOL_VERSION) {
      throw new Error(
        "Direct PIX: версия протокола " + payload.directVersion +
        ", приёмник понимает " + DIRECT_PROTOCOL_VERSION + "."
      );
    }
  }

  // -------------------------------------------------------------------------
  // Значения
  // -------------------------------------------------------------------------

  /**
   * Заливки приезжают уже в форме Figma — кроме изображений: у них вместо
   * данных ссылка на job-level таблицу ассетов Direct PIX. С самодостаточными
   * chunk-ами Fast/Full эта таблица никак не связана и на них не влияет.
   */
  function directPaint(paint, session) {
    if (!paint) return null;
    if (paint.type !== "IMAGE") return paint;
    var image = session.assets[paint.assetId];
    if (!image) { directNote(session, "ASSET_MISSING"); return null; }
    var out = {
      type: "IMAGE",
      imageHash: image,
      scaleMode: paint.scaleMode || "FILL",
      opacity: typeof paint.opacity === "number" ? paint.opacity : 1,
      blendMode: paint.blendMode || "NORMAL",
    };
    if (paint.imageTransform) out.imageTransform = paint.imageTransform;
    if (typeof paint.scalingFactor === "number") out.scalingFactor = paint.scalingFactor;
    if (typeof paint.rotation === "number") out.rotation = paint.rotation;
    return out;
  }

  function directPaints(list, session) {
    if (!list) return undefined;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var paint = directPaint(list[i], session);
      if (paint) out.push(paint);
    }
    return out;
  }

  /**
   * Paint-операция override у приёмника — последний рубеж.
   *
   * Отправитель уже не выпускает пустых списков: у дельты Pixso нет доказанного
   * представления «очистить краски» (см. `PixNormalizer.overrideRepeated`).
   * Но пакет мог приехать от старого отправителя или из snapshot-fallback,
   * а отображение краски здесь может схлопнуть список ещё раз — на своих
   * причинах (шрифт картинки не доехал, тип не поддержан).
   *
   * Поэтому правило приёмника отдельное и не зависит от отправителя: пустой
   * список не имеет права стереть НЕПУСТЫЕ краски, которые уже стоят на узле
   * после базового прохода. Узлу без красок такой список ничего не меняет —
   * это но-оп, а не отказ.
   */
  function directApplyPaintOp(session, target, key, list) {
    var mapped = directPaints(list, session);
    if (!mapped) return false;
    session.totals.paintOverridePresent += 1;
    if (mapped.length) {
      var ok = directSet(target, key, mapped);
      if (ok) session.totals.paintOverrideApplied += 1;
      return ok;
    }
    var before = null;
    try { before = target[key]; } catch (_e) { before = null; }
    if (Array.isArray(before) && before.length) {
      session.totals.paintClearRefused += 1;
      directNote(session, "OVERRIDE_PAINT_CLEAR_REFUSED");
      return false;
    }
    session.totals.paintDefaultArrayIgnored += 1;
    return true;
  }

  // -------------------------------------------------------------------------
  // Нативные стили
  // -------------------------------------------------------------------------

  /**
   * Создаёт нативные стили Figma по описаниям пакета.
   *
   * Одно описание — один стиль на job. Дедупликация уже произошла на
   * отправителе (общая идентичность стиля Pixso, а не значение и не имя),
   * поэтому здесь достаточно реестра по `styleId`: повторная встреча даёт
   * ссылку, а не второй стиль.
   *
   * Имена не сравниваются нигде: в источнике два РАЗНЫХ общих стиля могут
   * называться одинаково, и склейка по имени потеряла бы один из них.
   */
  async function directBuildStyles(styles, session) {
    var startedAt = Date.now();
    for (var i = 0; i < styles.length; i++) {
      var source = styles[i] || {};
      var id = source.styleId;
      if (!id) { directNote(session, "STYLE_WITHOUT_ID"); continue; }
      if (isStyleAlive(session.styles[id])) {
        if (source.styleType === "TEXT") session.totals.textStylesReused += 1;
        else if (source.styleType === "EFFECT") session.totals.effectStylesReused += 1;
        else session.totals.paintStylesReused += 1;
        continue;
      }
      var style = null;
      try {
        if (source.styleType === "PAINT" && typeof figma.createPaintStyle === "function") {
          var paints = directPaints(source.paints, session);
          // Стиль без красок в Figma не создаётся: узлы останутся со своими
          // сырыми значениями, а событие честно считается.
          if (!paints || !paints.length) { session.totals.stylesUnsupported += 1; directNote(session, "STYLE_PAINTS_EMPTY"); continue; }
          style = figma.createPaintStyle();
          style.paints = paints;
          session.totals.paintStylesCreated += 1;
        } else if (source.styleType === "EFFECT" && typeof figma.createEffectStyle === "function") {
          if (!Array.isArray(source.effects) || !source.effects.length) {
            session.totals.stylesUnsupported += 1;
            directNote(session, "STYLE_EFFECTS_EMPTY");
            continue;
          }
          style = figma.createEffectStyle();
          style.effects = source.effects;
          session.totals.effectStylesCreated += 1;
        } else if (source.styleType === "TEXT" && typeof figma.createTextStyle === "function") {
          var text = source.text || {};
          style = figma.createTextStyle();
          // Шрифт грузится ДО присваивания: Figma отвергает типографику
          // незагруженного шрифта. Недоступный шрифт роняет только сам шрифт —
          // размер, трекинг и межстрочное того же стиля переносятся как обычно
          // и попадают в счётчик fallback, а не подменяются похожим шрифтом.
          if (text.fontName && text.fontName.family) {
            var fontStartedAt = Date.now();
            try { await loadFontCached(text.fontName); setValue(style, "fontName", text.fontName); }
            catch (_eStyleFont) {
              session.totals.styleFontFallbacks += 1;
              directNote(session, "STYLE_FONT_UNAVAILABLE");
            }
            session.timings.fontMs += Date.now() - fontStartedAt;
          }
          ["fontSize", "lineHeight", "letterSpacing", "paragraphSpacing",
            "paragraphIndent", "textCase", "textDecoration", "leadingTrim"].forEach(function (key) {
            setValue(style, key, text[key]);
          });
          session.totals.textStylesCreated += 1;
        }
      } catch (_eStyle) {
        style = null;
      }
      if (!style) {
        session.totals.stylesUnsupported += 1;
        directNote(session, "STYLE_TYPE_UNSUPPORTED");
        continue;
      }
      setValue(style, "name", source.name || id);
      if (source.description) setValue(style, "description", source.description);
      // Отпечаток источника: по нему стиль опознаётся в документе, а не по
      // видимому имени — одинаковые имена в источнике законны.
      setPluginData(style, "pixsoDirectStyleId", id);
      if (source.sourceKey) setPluginData(style, "pixsoDirectStyleKey", String(source.sourceKey));
      session.styles[id] = style;
    }
    session.timings.styleBuildMs += Date.now() - startedAt;
  }

  /**
   * Привязка одного узла к нативному стилю.
   *
   * Порядок здесь критичен и задан вызывающим: присваивание сырых красок или
   * типографики ПОСЛЕ привязки отцепило бы стиль от узла. Поэтому привязки
   * всегда идут последними — и в базовой сборке узла, и в применении дельты.
   */
  async function directBindStyle(node, styleId, session, setterName, counterKey) {
    if (!styleId) return;
    var style = session.styles[styleId];
    if (!isStyleAlive(style)) {
      session.totals.styleBindingsMissingStyle += 1;
      directNote(session, "STYLE_BINDING_MISSING_STYLE");
      return;
    }
    if (typeof node[setterName] !== "function") {
      session.totals.styleBindingsFailed += 1;
      directNote(session, "STYLE_BINDING_UNSUPPORTED");
      return;
    }
    try { await node[setterName](style.id); session.totals[counterKey] += 1; }
    catch (_eBind) {
      session.totals.styleBindingsFailed += 1;
      directNote(session, "STYLE_BINDING_REJECTED");
    }
  }

  /** Все привязки узла из его собственной записи IR. */
  async function directApplyStyleBindings(node, styles, session) {
    if (!styles) return;
    await directBindStyle(node, styles.fill, session, "setFillStyleIdAsync", "fillStyleBindings");
    await directBindStyle(node, styles.stroke, session, "setStrokeStyleIdAsync", "strokeStyleBindings");
    await directBindStyle(node, styles.effect, session, "setEffectStyleIdAsync", "effectStyleBindings");
    if (node.type === "TEXT") {
      await directBindStyle(node, styles.text, session, "setTextStyleIdAsync", "textStyleBindings");
    }
  }

  function directCreateNode(spec) {
    switch (spec.type) {
      case "TEXT": return figma.createText();
      case "RECTANGLE": return figma.createRectangle();
      case "ELLIPSE": return figma.createEllipse();
      case "LINE": return figma.createLine();
      case "VECTOR": return figma.createVector();
      case "BOOLEAN_OPERATION": return figma.createBooleanOperation();
      case "COMPONENT": return figma.createComponent();
      default: return figma.createFrame();
    }
  }

  /** Шрифт узла, готовый к правке текста. `figma.mixed` — не имя шрифта. */
  async function directLoadNodeFont(node) {
    var fontName = null;
    try { fontName = node.fontName; } catch (_e) { fontName = null; }
    if (!fontName || fontName === figma.mixed) {
      try { fontName = node.getRangeFontName(0, Math.max(1, node.characters.length)); }
      catch (_eRange) { fontName = null; }
    }
    if (!fontName || fontName === figma.mixed) return false;
    try { await loadFontCached(fontName); return true; }
    catch (_eLoad) { return false; }
  }

  async function directApplyTextSegments(node, segments, session) {
    if (!Array.isArray(segments) || !segments.length || node.type !== "TEXT") return;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i] || {};
      var start = Math.max(0, Number(segment.start) || 0);
      var end = Math.min(node.characters.length, Number(segment.end) || 0);
      if (!(end > start)) continue;
      if (segment.fontName && segment.fontName.family) {
        try { await loadFontCached(segment.fontName); node.setRangeFontName(start, end, segment.fontName); }
        catch (_eRangeFont) { directNote(session, "TEXT_RANGE_FONT_UNAVAILABLE"); }
      }
      var setters = [
        ["fontSize", "setRangeFontSize"], ["textCase", "setRangeTextCase"],
        ["textDecoration", "setRangeTextDecoration"], ["letterSpacing", "setRangeLetterSpacing"],
        ["lineHeight", "setRangeLineHeight"], ["paragraphIndent", "setRangeParagraphIndent"],
        ["paragraphSpacing", "setRangeParagraphSpacing"]
      ];
      for (var j = 0; j < setters.length; j++) {
        var field = setters[j][0], method = setters[j][1];
        if (segment[field] === undefined || typeof node[method] !== "function") continue;
        try { node[method](start, end, segment[field]); }
        catch (_eRangeStyle) { directNote(session, "TEXT_RANGE_STYLE_REJECTED"); }
      }
      if (segment.fills && typeof node.setRangeFills === "function") {
        try {
          var fills = directPaints(segment.fills, session);
          if (fills) node.setRangeFills(start, end, fills);
        } catch (_eRangeFill) { directNote(session, "TEXT_RANGE_FILL_REJECTED"); }
      }
    }
  }

  /**
   * Effective Figma text-box sizing with exact source width ownership.
   * Overflow fields describe behavior at a boundary; they never authorize
   * turning a width-HUG text node into a fixed-width node.
   */
  function directEffectiveTextAutoResize(text) {
    if (!text) return undefined;
    // `sourceTextAutoResize` existed briefly as provenance for a producer
    // conversion from WIDTH_AND_HEIGHT to HEIGHT. That conversion was wrong:
    // overflow metadata is not ownership of a physical width. Prefer the
    // original value when reading one of those already-produced packages, and
    // otherwise preserve the canonical source value verbatim.
    if (text.sourceTextAutoResize === "WIDTH_AND_HEIGHT") return "WIDTH_AND_HEIGHT";
    return text.textAutoResize;
  }

  /**
   * Overflow is a separate text-box contract from width ownership. Native
   * instance materialization and later layout writes can preserve characters
   * while losing ENDING/maxLines. Re-commit the pair in its API order and
   * verify the public getters; no geometry is guessed here.
   */
  function directReassertTextOverflow(node, text, session) {
    if (!node || !text || text.textTruncation === undefined) return false;
    // These setters are not cheap no-ops in the live host. On a descendant of
    // a native instance Figma may rematerialize/reflow the occurrence even when
    // the assigned value equals the current value. Read first and mutate only
    // a proven mismatch; this keeps the repair proportional to damaged nodes,
    // not to every TextNode/override in the root.
    var actualTruncation = directVisualRead(node, "textTruncation");
    var actualMaxLines = directVisualRead(node, "maxLines");
    var truncationMismatch = actualTruncation !== text.textTruncation;
    var maxLinesMismatch = text.maxLines !== undefined && actualMaxLines !== text.maxLines;
    if (!truncationMismatch && !maxLinesMismatch) return true;

    var applied = false;
    if (truncationMismatch) {
      applied = directSet(node, "textTruncation", text.textTruncation) || applied;
    }
    // When truncation itself had to be enabled, replay the source bound after
    // it even if the pre-write getter happened to expose the desired value.
    // Figma documents maxLines as meaningful only with truncation enabled.
    if (text.maxLines !== undefined && (truncationMismatch || maxLinesMismatch)) {
      applied = directSet(node, "maxLines", text.maxLines) || applied;
    }
    actualTruncation = directVisualRead(node, "textTruncation");
    actualMaxLines = directVisualRead(node, "maxLines");
    var verified = actualTruncation === text.textTruncation &&
      (text.maxLines === undefined || actualMaxLines === text.maxLines);
    if (applied) {
      session.totals.textOverflowSemanticsReasserted =
        (session.totals.textOverflowSemanticsReasserted || 0) + 1;
    }
    if (!verified) directNote(session, "TEXT_OVERFLOW_SEMANTICS_REJECTED");
    return verified;
  }

  async function directApplyText(node, text, session) {
    if (!text) return;
    if (text.fontName && text.fontName.family) {
      try { await loadFontCached(text.fontName); node.fontName = text.fontName; }
      catch (_eFont) { directNote(session, "FONT_UNAVAILABLE"); }
    }
    ["fontSize", "textAlignHorizontal", "textAlignVertical",
      "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent",
      "letterSpacing", "lineHeight", "leadingTrim", "hangingPunctuation",
      "hangingList"].forEach(function (key) {
      setValue(node, key, text[key]);
    });
    // Символы ставятся после типографики: смена шрифта после ввода текста
    // сбрасывает посимвольные настройки, а не наоборот.
    try { node.characters = text.characters || ""; }
    catch (_eCharacters) { directNote(session, "TEXT_CHARACTERS"); }
    // Range styles применяются НЕ здесь. Node-level fill/text style binding
    // выполняется ниже, после геометрии, и в настоящей Figma такая привязка
    // перезаписывает соответствующие диапазоны. Mixed text поэтому должен
    // получить свои setRange* самым последним шагом после всех base styles.
    // Иначе первый цветной/типографический span визуально схлопывается в
    // базовый стиль всего TextNode (production case: mixed headline blocks).
    //
    // Сами символы при этом обязаны быть записаны ДО range API: диапазоны
    // адресуются по UTF-16 индексам уже существующей строки.
    // А режим авторазмера — ПОСЛЕ символов, и это не косметика порядка.
    // `HEIGHT` и `NONE` означают «ширину держит сам узел», и Figma фиксирует
    // ТЕКУЩУЮ ширину в момент присваивания. У пустого узла она нулевая:
    // выставленный раньше режим заморозил бы её на нуле, и следом введённый
    // текст переносился бы по одной букве. Ширину источника узел получает
    // отдельным `resize` ниже — но уже поверх осмысленного режима, а не
    // поверх схлопнутого.
    var effectiveTextAutoResize = directEffectiveTextAutoResize(text);
    setValue(node, "textAutoResize", effectiveTextAutoResize);
    if (text.sourceTextAutoResize === "WIDTH_AND_HEIGHT" &&
        effectiveTextAutoResize !== text.sourceTextAutoResize) {
      session.totals.textTruncationWidthsConstrained =
        (session.totals.textTruncationWidthsConstrained || 0) + 1;
    }
    // Обрезание — следом за режимом и тоже поверх содержимого, и порядок
    // внутри пары обязателен: в Figma `maxLines` действует только при
    // включённом `textTruncation`, поэтому раньше него он был записью в
    // никуда. Обрезание к тому же считается по фактическому тексту: у
    // пустого узла обрезать нечего, и до символов оно так же бессмысленно,
    // как и режим авторазмера.
    setValue(node, "textTruncation", text.textTruncation);
    setValue(node, "maxLines", text.maxLines);
    var fills = directPaints(text.fills, session);
    if (fills) setValue(node, "fills", fills);
  }

  function directSpecTransform(spec) {
    if (!spec) return [[1, 0, 0], [0, 1, 0]];
    if (spec.relativeTransform && spec.relativeTransform.length === 2) return spec.relativeTransform;
    return [[1, 0, Number(spec.x) || 0], [0, 1, Number(spec.y) || 0]];
  }

  function directMultiplyTransforms(a, b) {
    return [
      [
        a[0][0] * b[0][0] + a[0][1] * b[1][0],
        a[0][0] * b[0][1] + a[0][1] * b[1][1],
        a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
      ],
      [
        a[1][0] * b[0][0] + a[1][1] * b[1][0],
        a[1][0] * b[0][1] + a[1][1] * b[1][1],
        a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
      ],
    ];
  }

  /**
   * Figma has a non-obvious coordinate rule for BooleanOperationNode: the
   * relativeTransform of its CHILDREN is expressed against the nearest
   * container parent (frame/component/instance/page), not against the boolean
   * itself. Pixso stores the child transform locally against the immediate
   * BOOLEAN_OPERATION parent. Feeding that local value directly to Figma is
   * therefore wrong whenever the boolean is translated/rotated; SUBTRACT is
   * especially visible because its operands often start at negative offsets.
   *
   * Compose every skipped boolean ancestor into the child's transform. The
   * boolean node is then allowed to fit itself from correctly positioned
   * operands, as Figma's API requires. This is structural and independent of
   * names, operation kind and the particular PIX file.
   */
  function directBooleanAwarePlacement(spec, specById) {
    if (!spec || !spec.parent || !specById) return null;
    var transform = directSpecTransform(spec);
    var parentSpec = specById[spec.parent];
    var crossedBoolean = false;
    while (parentSpec && parentSpec.type === "BOOLEAN_OPERATION") {
      crossedBoolean = true;
      transform = directMultiplyTransforms(directSpecTransform(parentSpec), transform);
      parentSpec = parentSpec.parent ? specById[parentSpec.parent] : null;
    }
    return crossedBoolean ? transform : null;
  }

  async function directApplyNode(node, spec, session, placementOverride) {
    setValue(node, "name", spec.name || spec.type);

    if (spec.type === "TEXT") {
      await directApplyText(node, spec.text, session);
    } else if (spec.vectorPaths && node.type === "VECTOR") {
      try { node.vectorPaths = spec.vectorPaths; }
      catch (_ePaths) { directNote(session, "VECTOR_PATHS_REJECTED"); }
    }

    // vectorPaths задаёт геометрию path, но не является владельцем размера
    // source-node. В Pixso размер VECTOR и tight bounds его path могут
    // отличаться (типичный случай — иконки с внутренними полями/viewBox).
    // Поэтому semantic width/height источника всё равно нужно применить к
    // VectorNode. Иначе Figma оставляет tight geometry bounds и визуальный
    // размер иконки расходится с Pixso.
    var sizedByGeometry = false;
    var sizedByBooleanChildren = node.type === "BOOLEAN_OPERATION";
    // A Pixso INSTANCE may carry an explicit uniformScaleFactor. This is not
    // equivalent to resizing its outer box: native instance resize follows
    // constraints while Pixso scales the complete rendered subtree (vectors,
    // strokes, text and radii). Use Figma's semantic rescale primitive when
    // available and do not immediately overwrite it with resize().
    var sizedByOccurrenceScale = false;
    // IMPORTANT: Pixso occurrences normally carry BOTH the final semantic
    // width/height and symbolData.uniformScaleFactor. The size is already the
    // post-scale box. Applying SceneNode.rescale() as well scales it a second
    // time (24 * 0.8 => 19.2), which is exactly what happens to 24px icon
    // instances. Only use uniformScaleFactor for legacy/incomplete records
    // that do not have an explicit semantic box.
    var hasExplicitOccurrenceSize = typeof spec.width === "number" && isFinite(spec.width) &&
      typeof spec.height === "number" && isFinite(spec.height);
    if (spec.kind === "INSTANCE" && !hasExplicitOccurrenceSize &&
        typeof spec.uniformScaleFactor === "number" &&
        isFinite(spec.uniformScaleFactor) && spec.uniformScaleFactor > 0 &&
        Math.abs(spec.uniformScaleFactor - 1) > 1e-4 && typeof node.rescale === "function") {
      try {
        node.rescale(spec.uniformScaleFactor);
        sizedByOccurrenceScale = true;
        session.totals.instanceUniformScalesApplied =
          (session.totals.instanceUniformScalesApplied || 0) + 1;
      } catch (_eScale) {
        directNote(session, "INSTANCE_UNIFORM_SCALE_REJECTED");
      }
    }
    if (!sizedByGeometry && !sizedByBooleanChildren && !sizedByOccurrenceScale &&
        typeof spec.width === "number" && typeof spec.height === "number") {
      if (!directResizePreservingTextSizing(node, spec.width, spec.height, session)) {
        directNote(session, "RESIZE_REJECTED");
      }
    }
    if (spec.aspectRatioLocked !== undefined) {
      try {
        if (spec.aspectRatioLocked && typeof node.lockAspectRatio === "function") node.lockAspectRatio();
        else if (!spec.aspectRatioLocked && typeof node.unlockAspectRatio === "function") node.unlockAspectRatio();
        else setValue(node, "constrainProportions", !!spec.aspectRatioLocked);
      } catch (_eAspect) { directNote(session, "ASPECT_RATIO_REJECTED"); }
    }
    // TextNode — особый случай: resize в настоящей Figma может перевести
    // авторазмер текста в режим фиксированной коробки. Поэтому семантика
    // источника должна быть ПОСЛЕДНЕЙ записью после геометрии. Особенно это
    // важно для WIDTH_AND_HEIGHT: иначе последующий characters override у
    // nested component остаётся в ширине дефолтной надписи и переносит badge
    // на две строки. Для HEIGHT повторная запись фиксирует уже source-width,
    // для NONE она просто подтверждает полностью фиксированную коробку.
    if (spec.type === "TEXT" && spec.text && spec.text.textAutoResize !== undefined) {
      setValue(node, "textAutoResize", directEffectiveTextAutoResize(spec.text));
    }
    if (placementOverride) {
      setValue(node, "relativeTransform", placementOverride);
    } else if (spec.relativeTransform) setValue(node, "relativeTransform", spec.relativeTransform);
    else {
      setValue(node, "x", spec.x);
      setValue(node, "y", spec.y);
      if (typeof spec.rotation === "number") setValue(node, "rotation", spec.rotation);
    }
    if (spec.visible === false) setValue(node, "visible", false);
    if (typeof spec.opacity === "number") setValue(node, "opacity", spec.opacity);
    if (spec.locked) setValue(node, "locked", true);
    if (spec.blendMode) setValue(node, "blendMode", spec.blendMode);
    if (spec.type === "BOOLEAN_OPERATION" && spec.booleanOperation) {
      setValue(node, "booleanOperation", spec.booleanOperation);
    }
    if (spec.type === "ELLIPSE" && spec.arcData) {
      if (!directSet(node, "arcData", spec.arcData)) directNote(session, "ELLIPSE_ARC_REJECTED");
    }
    if (spec.isMask) {
      setValue(node, "isMask", true);
      if (spec.maskType) setValue(node, "maskType", spec.maskType);
    }
    // Clip content is positive semantics, not only a "disable clipping" patch.
    // Direct PIX can explicitly carry both true and false; applying only false
    // made overflowing children cover a parent's stroke even though the border
    // itself was imported correctly.
    if (typeof spec.clipsContent === "boolean") setValue(node, "clipsContent", spec.clipsContent);

    // Свежесозданный узел Figma приходит со СВОИМИ значениями по умолчанию:
    // у прямоугольника, эллипса и вектора это серая заливка #D9D9D9, у линии —
    // чёрная обводка. Пропустить присваивание значит оставить эти значения
    // видимыми в результате. Инварианты обратные и оба обязательные:
    //
    //   нет заливки в источнике  → нет заливки в Figma
    //   нет обводки в источнике  → нет обводки в Figma
    //
    // Только у ORDINARY: у вхождения отсутствие поля означает «как в
    // определении», и пустой массив стёр бы заливку мастера.
    var ordinarySpec = spec.kind !== "INSTANCE";
    if (spec.type === "TEXT") {
      // Заливки текста уже применены вместе с остальными его свойствами.
    } else {
      var fills = directPaints(spec.fills, session);
      if (fills) setValue(node, "fills", fills);
      else if (ordinarySpec) setValue(node, "fills", []);
    }

    var strokes = directPaints(spec.strokes, session);
    if (strokes || ordinarySpec) {
      setValue(node, "strokes", strokes || []);
      directApplyStrokeWeights(node, spec.strokeWeight, spec.borderWeights);
      setValue(node, "strokeAlign", spec.strokeAlign);
      setValue(node, "strokeJoin", spec.strokeJoin);
      setValue(node, "strokeCap", spec.strokeCap);
      if (spec.dashPattern) setValue(node, "dashPattern", spec.dashPattern);
    }

    if (spec.corners) directApplyCorners(node, spec.corners);
    if (spec.sizeBounds) directApplySizeBounds(node, spec.sizeBounds, session, false);
    if (spec.effects) setValue(node, "effects", spec.effects);
    if (spec.constraints) setValue(node, "constraints", spec.constraints);

    setPluginData(node, "pixsoDirectSourceId", spec.id);
    if (spec.directPixFallback) setPluginData(node, "pixsoDirectFallback", "INSTANCE_WITHOUT_DEFINITION");

    // Сначала base styles: их назначение перезаписывает соответствующие
    // node-level значения. Для обычного узла это и есть финальный шаг.
    await directApplyStyleBindings(node, spec.styles, session);

    // Для mixed TEXT диапазоны являются БОЛЕЕ СПЕЦИФИЧНЫМИ, чем base style
    // всего узла, поэтому обязаны применяться после него. Это сохраняет
    // визуальную семантику Pixso `characterStyleIDs/styleOverrideTable` и
    // одновременно оставляет неизменённые участки связанными с base style.
    // В Figma результат закономерно становится mixed там, где диапазоны
    // отличаются — это корректнее, чем сохранять ложную единую style link и
    // терять цвет/font/size отдельных span-ов.
    if (spec.type === "TEXT" && spec.text && spec.text.segments) {
      await directApplyTextSegments(node, spec.text.segments, session);
      session.totals.textRangeSegmentsAfterBaseStyles =
        (session.totals.textRangeSegmentsAfterBaseStyles || 0) + spec.text.segments.length;
    }
    // Style binding and range writes may rematerialize text state. Overflow
    // therefore gets a final base-node commit after styles, not only before
    // geometry and binding.
    if (spec.type === "TEXT" && spec.text) {
      directReassertTextOverflow(node, spec.text, session);
    }

    // Краска регионов — САМАЯ последняя запись вектора. `fills` и привязка к
    // стилю у VectorNode действуют на весь узел и стирают собственные краски
    // регионов: применить их раньше означало бы применить их впустую.
    if (spec.vectorNetwork) await directApplyVectorRegions(node, spec.vectorNetwork, session);
  }

  /**
   * Многоцветный вектор одним узлом.
   *
   * У `VectorNode` цвет принадлежит региону сети, а не пути: `vectorPaths`
   * носителя цвета не имеет вовсе, поэтому иллюстрация, у которой в Pixso своя
   * заливка у каждого куска, приезжала целиком одной краской узла. Сеть
   * отправителя несёт те же самые пути плюс `fills` тех регионов, у которых в
   * источнике своя краска; регион без `fills` остаётся на общей заливке узла —
   * это и есть правило Pixso, где таблица красок является перекрытием над
   * `fillPaints`.
   *
   * Отказ хоста не разрушает уже собранный узел: у него остаётся прежняя
   * правильная геометрия из `vectorPaths` и прежняя одноцветная заливка.
   */
  async function directApplyVectorRegions(node, network, session) {
    if (!network || !network.regions || !network.regions.length) return false;
    if (node.type !== "VECTOR") {
      directNote(session, "VECTOR_REGIONS_WRONG_NODE_TYPE");
      return false;
    }
    var regions = [];
    var painted = 0;
    for (var i = 0; i < network.regions.length; i++) {
      var source = network.regions[i];
      var region = { windingRule: source.windingRule, loops: source.loops };
      if (source.fills) {
        // Пустой список краски региона — это «не рисовать», а не «как узел»:
        // источник различает отсутствие записи и пустую запись.
        region.fills = directPaints(source.fills, session) || [];
        painted += 1;
      }
      regions.push(region);
    }
    var value = { vertices: network.vertices, segments: network.segments, regions: regions };
    // Запись сети пересобирает геометрию узла, а с ней его габарит и
    // положение. Размещение к этому моменту уже применено, поэтому оно
    // снимается до записи и возвращается после: сдвинутая иллюстрация — такой
    // же дефект, как её цвет.
    var placement = null;
    try { placement = node.relativeTransform; } catch (_eRead) { placement = null; }
    var applied = false;
    if (typeof node.setVectorNetworkAsync === "function") {
      try { await node.setVectorNetworkAsync(value); applied = true; }
      catch (_eAsync) { applied = false; }
    }
    if (!applied) {
      // Хост без асинхронного сеттера (или отвергнувший его) — не повод терять
      // цвет: синхронное свойство описывает ровно ту же сеть.
      try { node.vectorNetwork = value; applied = true; }
      catch (_eSync) { applied = false; }
    }
    if (!applied) {
      session.totals.vectorRegionNodesRejected =
        (session.totals.vectorRegionNodesRejected || 0) + 1;
      directNote(session, "VECTOR_REGIONS_REJECTED");
      return false;
    }
    if (placement) {
      try { node.relativeTransform = placement; } catch (_eRestore) {}
    }
    session.totals.vectorRegionNodesPainted =
      (session.totals.vectorRegionNodesPainted || 0) + 1;
    session.totals.vectorRegionsPainted =
      (session.totals.vectorRegionsPainted || 0) + painted;
    return true;
  }

  /**
   * Углы узла.
   *
   * Отправитель присылает эффективный результат по всем четырём углам и, если
   * они равны, дополнительно равномерный `cornerRadius`. Порядок попыток
   * важен: четыре поугловых свойства есть не у каждого типа узла (у вектора и
   * эллипса их нет), а равномерный радиус есть почти у всех. Поэтому
   * поугловое присваивание пробуется первым, а равномерное остаётся
   * страховкой, а не альтернативой.
   */
  function directApplyCorners(node, corners) {
    var applied = false;
    var perCorner = false;
    if (typeof corners.topLeftRadius === "number" ||
        typeof corners.topRightRadius === "number" ||
        typeof corners.bottomLeftRadius === "number" ||
        typeof corners.bottomRightRadius === "number") {
      perCorner = directSet(node, "topLeftRadius", corners.topLeftRadius) || perCorner;
      perCorner = directSet(node, "topRightRadius", corners.topRightRadius) || perCorner;
      perCorner = directSet(node, "bottomLeftRadius", corners.bottomLeftRadius) || perCorner;
      perCorner = directSet(node, "bottomRightRadius", corners.bottomRightRadius) || perCorner;
      applied = perCorner || applied;
    }
    if (!perCorner && typeof corners.cornerRadius === "number") {
      applied = directSet(node, "cornerRadius", corners.cornerRadius) || applied;
    }
    if (typeof corners.cornerSmoothing === "number") {
      applied = directSet(node, "cornerSmoothing", corners.cornerSmoothing) || applied;
    }
    return applied;
  }

  /**
   * Поведение узла внутри auto layout родителя. `layoutGrow` и `layoutAlign` —
   * это «заполнить контейнер» по главной и по контр-оси; без них ребёнок,
   * который в Pixso растягивается, приезжает своей исходной шириной, и вся
   * строка расходится.
   */
  function directApplyChildLayout(node, childLayout) {
    if (!childLayout) return false;
    var applied = false;
    if (childLayout.layoutPositioning !== undefined) {
      applied = directSet(node, "layoutPositioning", childLayout.layoutPositioning) || applied;
    }
    if (childLayout.layoutAlign !== undefined) {
      applied = directSet(node, "layoutAlign", childLayout.layoutAlign) || applied;
    }
    if (childLayout.layoutGrow !== undefined) {
      applied = directSet(node, "layoutGrow", childLayout.layoutGrow) || applied;
    }
    return applied;
  }

  /**
   * Границы размера auto layout. Ставятся до раскладки: HUG-контейнер,
   * которому источник задал минимум, обязан обнять содержимое уже с ним.
   * Узел вне auto layout эти свойства не принимает — это факт хоста, а не
   * ошибка пакета, поэтому отказ считается отдельным кодом.
   */
  function directApplySizeBounds(node, bounds, session, reportRejected) {
    if (!bounds) return false;
    var attempted = false;
    var applied = false;
    ["minWidth", "maxWidth", "minHeight", "maxHeight"].forEach(function (key) {
      if (bounds[key] === undefined) return;
      attempted = true;
      if (directSet(node, key, bounds[key])) applied = true;
    });
    // Before parent auto-layout is committed Figma legitimately rejects
    // min/max on an ordinary child.  Those writes are speculative and are
    // retried after layoutQueue/childQueue; do not turn the expected first
    // refusal into a permanent diagnostic.  Only an authoritative post-layout
    // attempt is allowed to report SIZE_BOUNDS_REJECTED.
    if (attempted && !applied && reportRejected !== false) {
      directNote(session, "SIZE_BOUNDS_REJECTED");
    }
    return applied;
  }

  /**
   * Хозяин каждой оси узла внутри раскладки.
   *
   * Ось принадлежит ровно одному из троих, и только третий случай означает,
   * что размер обязан вернуть приёмник:
   *
   *   РОДИТЕЛЬ — ребёнок объявлен FILL (`layoutGrow`) по главной оси или
   *              STRETCH (`layoutAlign`) по контр-оси родителя;
   *   САМ УЗЕЛ — он auto layout контейнер и по этой оси у него HUG (`AUTO`);
   *   ИСТОЧНИК — во всех остальных случаях.
   *
   * Оси считаются от направления раскладки, а не от имён полей: у
   * HORIZONTAL главная ось — ширина, у VERTICAL — высота. Одна и та же
   * запись `layoutGrow` означает поэтому ширину в одном родителе и высоту
   * в другом.
   */
  function directSizeOwnedBySource(node, spec, parentLayoutMode, ownModes, session) {
    var own = ownModes || directOwnLayoutModes(node, spec, session);
    var ownHorizontal = own.layoutMode === "HORIZONTAL";
    var laidOut = own.layoutMode === "HORIZONTAL" || own.layoutMode === "VERTICAL";
    var ownWidthAuto = laidOut &&
      (ownHorizontal ? own.primaryAxisSizingMode : own.counterAxisSizingMode) === "AUTO";
    var ownHeightAuto = laidOut &&
      (ownHorizontal ? own.counterAxisSizingMode : own.primaryAxisSizingMode) === "AUTO";

    var child = spec.childLayout;
    var absolute = !!child && child.layoutPositioning === "ABSOLUTE";
    var parentHorizontal = parentLayoutMode === "HORIZONTAL";
    var filledMain = !absolute && !!child && child.layoutGrow > 0;
    var filledCross = !absolute && !!child && child.layoutAlign === "STRETCH";
    var parentOwnsWidth = !!parentLayoutMode && (parentHorizontal ? filledMain : filledCross);
    var parentOwnsHeight = !!parentLayoutMode && (parentHorizontal ? filledCross : filledMain);

    var widthOwned = !parentOwnsWidth && !ownWidthAuto;
    var heightOwned = !parentOwnsHeight && !ownHeightAuto;

    // D14: numeric source bounds are observations, never axis ownership.
    // This guard must run even when `ownModes` was supplied by the occurrence
    // path. D13 skipped it in that case, so an inherited HUG/FILL descendant
    // could still reach resizeWithoutConstraints() using its measured box.
    // Only semantic FIXED is allowed to own source pixels.
    var expectedWidth = directAxisSizingFromSpec(spec, parentLayoutMode, "width", session);
    var expectedHeight = directAxisSizingFromSpec(spec, parentLayoutMode, "height", session);
    var effectiveHorizontal = own.layoutMode === "HORIZONTAL";
    var compatibilityOwnsWidth = !!(ownModes &&
      (effectiveHorizontal ? ownModes.compatibilityFixedPrimary : ownModes.compatibilityFixedCounter));
    var compatibilityOwnsHeight = !!(ownModes &&
      (effectiveHorizontal ? ownModes.compatibilityFixedCounter : ownModes.compatibilityFixedPrimary));
    if (expectedWidth !== "FIXED" && !compatibilityOwnsWidth) widthOwned = false;
    if (expectedHeight !== "FIXED" && !compatibilityOwnsHeight) heightOwned = false;

    return {
      width: widthOwned,
      height: heightOwned,
    };
  }

  /**
   * Режимы осей САМОГО узла — то есть те, которые объявил ИСТОЧНИК этого узла.
   *
   * У обычного узла это одно и то же: прочитанное обратно значение поставил
   * приёмник из его же пакета. У ВХОЖДЕНИЯ — нет. Прочитанные с инстанса
   * `primaryAxisSizingMode` / `counterAxisSizingMode` наследованы от мастера,
   * и это утверждение об ОПРЕДЕЛЕНИИ, а не о вхождении: определение обнимает
   * своё содержимое, вхождение же несёт собственную записанную коробку.
   *
   * Что эти вещи разные — измерено на источнике, а не выведено. На реальном
   * документе есть вхождения БЕЗ единой правки содержимого, размер
   * которых по оси, объявленной мастером HUG, от мастера отличается: 3 по
   * ширине (`2:50156` 20 против 60 у `2:50536`) и 2 по высоте (`2:70777` 90
   * против 126 у `2:54357`). Обнимание одного и того же содержимого не может
   * дать два разных числа — значит ось принадлежит вхождению.
   *
   * Поэтому наследованный AUTO снимает ось с источника только тогда, когда об
   * этом сказало САМО вхождение — правкой своей раскладки. Молчание вхождения
   * означает его собственную коробку, а не hug определения.
   */
  function directOwnLayoutModes(node, spec, session) {
    var live = readLayoutModes(node);
    if (!spec || spec.kind !== "INSTANCE") return live;
    var declared = directOccurrenceLayoutModes(spec);
    if (declared) {
      return {
        layoutMode: declared.layoutMode || live.layoutMode,
        primaryAxisSizingMode: declared.primaryAxisSizingMode !== undefined
          ? declared.primaryAxisSizingMode : live.primaryAxisSizingMode,
        counterAxisSizingMode: declared.counterAxisSizingMode !== undefined
          ? declared.counterAxisSizingMode : live.counterAxisSizingMode,
      };
    }

    // Само отличие записанного width/height от canonical definition НЕ всегда
    // доказывает FIXED: HUG-инстанс закономерно меняет размер после TEXT,
    // BOOLEAN и INSTANCE_SWAP свойств. Именно такие occurrence раньше массово
    // замораживались поздним restore после того, как native property уже
    // пересчитала HUG.
    //
    // Если occurrence содержит семантические правки содержимого, размерное
    // отличие двусмысленно — сохраняем live HUG/FIXED мастера и доверяем
    // раскладке после применения правок. Для occurrence БЕЗ правок остаётся
    // старое доказательство: отличающийся source box при том же содержимом не
    // мог появиться от HUG и означает собственную фиксированную ось.
    // D13: occurrence width/height are measured geometry, not sizing intent.
    // A HUG/FILL instance legitimately has concrete pixel bounds in the source
    // snapshot; comparing those bounds with the canonical definition must never
    // manufacture FIXED.  Only an explicit root layout override may change the
    // occurrence's semantic axis ownership.  Without one, inherit the live
    // definition semantics and let Figma recompute the measured box.
    return live;
  }

  /**
   * Раскладка, объявленная САМИМ вхождением: правка его корневого пути.
   * Правки под вложенными путями адресуют содержимое, а не коробку инстанса,
   * и владельцем его осей не являются.
   */
  function directOccurrenceLayoutModes(spec) {
    var overrides = spec.overrides;
    if (!overrides || !overrides.length) return null;
    for (var i = 0; i < overrides.length; i++) {
      var entry = overrides[i];
      if (entry.path && entry.path.length) continue;
      if (entry.ops && entry.ops.layout) return entry.ops.layout;
    }
    return null;
  }

  /**
   * Ось, на которую приёмник сейчас вернёт размер источника, не имеет права
   * остаться AUTO: раскладка Figma пересчитает её обратно, и `resize` уйдёт
   * в никуда. Это ровно то, что делает пользователь, меняя размер инстанса
   * поверх обнимающего мастера, — ось становится собственной.
   *
   * Трогаются только те оси, которые ДЕЙСТВИТЕЛЬНО меняются: вхождение,
   * совпадающее с мастером, остаётся обнимающим.
   */
  function directPinRestoredAxes(node, owned, width, height, session, spec, parentLayoutMode) {
    var live = readLayoutModes(node);
    var horizontal = live.layoutMode === "HORIZONTAL";
    if (!horizontal && live.layoutMode !== "VERTICAL") return;
    // D13: pinning is legal only when the semantic source explicitly says
    // FIXED. Concrete occurrence bounds alone are observations, never proof.
    // D14: preserve the real parent layout context. Passing null here (D13)
    // erased FILL evidence from childLayout: the same node was correctly
    // classified as FILL by the final semantic commit, but as FIXED by the
    // pinning path a few lines earlier. That contradiction explains why the
    // Figma panel showed concrete widths on descendants despite FILL parents.
    var semanticWidth = spec ? directAxisSizingFromSpec(spec, parentLayoutMode, "width", session) : "FIXED";
    var semanticHeight = spec ? directAxisSizingFromSpec(spec, parentLayoutMode, "height", session) : "FIXED";
    var changingWidth = owned.width && semanticWidth === "FIXED" && width !== node.width;
    var changingHeight = owned.height && semanticHeight === "FIXED" && height !== node.height;
    var pinPrimary = horizontal ? changingWidth : changingHeight;
    var pinCounter = horizontal ? changingHeight : changingWidth;
    var pinned = false;
    if (pinPrimary && live.primaryAxisSizingMode === "AUTO") {
      pinned = directSet(node, "primaryAxisSizingMode", "FIXED") || pinned;
    }
    if (pinCounter && live.counterAxisSizingMode === "AUTO") {
      pinned = directSet(node, "counterAxisSizingMode", "FIXED") || pinned;
    }
    if (pinned) {
      directNote(session, "OCCURRENCE_AXIS_PINNED_OVER_DEFINITION_HUG");
      if (spec) {
        directSizeStage(session, spec.id, "after-pin", node,
          "ось закреплена в FIXED: primary=" + (pinPrimary && live.primaryAxisSizingMode === "AUTO") +
          " counter=" + (pinCounter && live.counterAxisSizingMode === "AUTO"));
      }
    }
  }

  /** Режимы раскладки, прочитанные с самого узла. */
  function readLayoutModes(node) {
    var out = { layoutMode: "NONE", primaryAxisSizingMode: null, counterAxisSizingMode: null };
    try {
      out.layoutMode = node.layoutMode || "NONE";
      out.primaryAxisSizingMode = node.primaryAxisSizingMode;
      out.counterAxisSizingMode = node.counterAxisSizingMode;
    } catch (_e) {}
    return out;
  }

  /**
   * Возвращает узлу тот размер, который объявил источник, — по тем осям, где
   * его не задаёт ни родительская раскладка, ни собственный HUG.
   *
   * Каждое из присваиваний `layoutMode`, `primaryAxisSizingMode`,
   * `layoutGrow`, `layoutAlign`, `layoutPositioning` и `swapComponent`
   * перекладывает содержимое, и размер, выставленный до раскладки, её не
   * переживает. Возвращать его можно только там, где он и есть источник
   * истины: ось HUG или FILL считает редактор, и подменять её пиксели
   * значило бы получить нужный снимок с неверной семантикой.
   */
  /**
   * Любой resize TextNode в настоящей Figma может незаметно перевести
   * WIDTH_AND_HEIGHT в HEIGHT/NONE. Это особенно разрушительно для HUG:
   * после позднего restore текст сохраняет пиксельную коробку, но теряет
   * семантику и при следующем изменении компонента начинает переноситься.
   *
   * Поэтому resize и восстановление textAutoResize — одна атомарная операция.
   * Для не-текста helper эквивалентен обычному resizeWithoutConstraints.
   */
  function directResizePreservingTextSizing(node, width, height, session) {
    if (!node) return false;
    var textSizing = null;
    var isText = nodeType(node) === "TEXT";
    if (isText) {
      try { textSizing = node.textAutoResize; } catch (_eTextSizing) { textSizing = null; }
    }
    // Figma distinguishes resize() from resizeWithoutConstraints(): the former
    // applies children constraints, the latter explicitly does not. A fixed
    // occurrence/container is a structural resize, so its descendants must
    // follow constraints/auto-layout; using resizeWithoutConstraints here was
    // leaving nested content at canonical-master geometry after the root box
    // changed (e.g. 280px master -> 56px occurrence).
    var targetWidth = Math.max(0.01, width);
    var targetHeight = Math.max(0.01, height);

    // resize() in Figma is structural: even an equal-size call can re-run
    // constraints for the whole descendant subtree. Definitions call this
    // path for hundreds/thousands of nodes, so redundant resizes turn an
    // otherwise linear import into minutes of host work. Keep source geometry
    // authoritative, but skip the mutation when the semantic box is already
    // correct. This is safe for VECTOR too: its source width/height was applied
    // earlier when vectorPaths produced different tight bounds.
    var currentWidth = null, currentHeight = null;
    try { currentWidth = node.width; currentHeight = node.height; } catch (_eCurrentBox) {}
    if (typeof currentWidth === "number" && typeof currentHeight === "number" &&
        Math.abs(currentWidth - targetWidth) <= 1e-4 &&
        Math.abs(currentHeight - targetHeight) <= 1e-4) {
      return true;
    }

    var resize = node.type === "VECTOR" && typeof node.resizeWithoutConstraints === "function"
      ? node.resizeWithoutConstraints.bind(node)
      : (!isText && typeof node.resize === "function"
        ? node.resize.bind(node)
        : (typeof node.resizeWithoutConstraints === "function"
          ? node.resizeWithoutConstraints.bind(node) : null));
    if (!resize) return false;
    try { resize(targetWidth, targetHeight); }
    catch (_eResize) { directNote(session, "EXPLICIT_SIZE_RESTORE_REJECTED"); return false; }
    if (textSizing === "WIDTH_AND_HEIGHT" || textSizing === "HEIGHT" || textSizing === "NONE") {
      if (!directSet(node, "textAutoResize", textSizing)) {
        directNote(session, "TEXT_AUTO_RESIZE_RESTORE_REJECTED");
      }
    }
    return true;
  }

  function directRestoreLayoutSize(node, spec, parentLayoutMode, session, ownModes) {
    if (!spec || typeof spec.width !== "number" || typeof spec.height !== "number") return;
    if (typeof node.resizeWithoutConstraints !== "function") return;
    var owned = directSizeOwnedBySource(node, spec, parentLayoutMode, ownModes, session);
    var traced = directSizeTraced(session, spec.id);
    if (!owned.width && !owned.height) {
      if (traced) {
        directSizeStage(session, spec.id, "restore-skipped", node,
          "оси у источника нет: w=" + owned.width + " h=" + owned.height);
      }
      return;
    }
    var width = owned.width ? spec.width : node.width;
    var height = owned.height ? spec.height : node.height;
    if (width === node.width && height === node.height) {
      if (traced) directSizeStage(session, spec.id, "restore-noop", node, "размер уже совпадает");
      return;
    }
    if (traced) {
      directSizeStage(session, spec.id, "restore-decided", node,
        "owned w=" + owned.width + " h=" + owned.height +
        " → " + width + "x" + height +
        " (ownModes=" + (ownModes ? "передан" : "прочитан с узла") + ")");
    }
    directPinRestoredAxes(node, owned, width, height, session, spec, parentLayoutMode);
    directResizePreservingTextSizing(node, width, height, session);
    if (traced) directSizeStage(session, spec.id, "after-resize", node, "resizeWithoutConstraints");
  }

  /**
   * Auto layout контейнера. Режим размера Pixso переносится дословно.
   *
   * HUG без детей в потоке, как и HUG над одними растянутыми детьми, живая
   * Figma держит с прежним размером (`hug-over-hidden-only`,
   * `hug-over-no-children`, `built-hug-counter-over-stretch` — PERSISTED),
   * поэтому такие оси на FIXED не подменяются.
   */
  function directApplyAutoLayout(node, layout) {
    setValue(node, "layoutMode", layout.layoutMode);
    var primary = layout.primaryAxisSizingMode;
    var counter = layout.counterAxisSizingMode;

    // Preserve Pixso sizing semantics verbatim. AUTO means HUG on the node's
    // own axis in both APIs. A HUG parent + FILL child can be a dependency
    // cycle, but resolving that incompatibility by changing the PARENT to
    // FIXED destroys the source contract and makes adaptive components show
    // physical W/H in Figma. Cycle handling belongs to the dependent child,
    // never to the HUG owner.
    ["itemSpacing", "counterAxisSpacing", "paddingLeft", "paddingRight", "paddingTop",
      "paddingBottom", "primaryAxisAlignItems", "counterAxisAlignItems",
      "layoutWrap", "itemReverseZIndex", "strokesIncludedInLayout"].forEach(function (key) {
      setValue(node, key, layout[key]);
    });
    setValue(node, "primaryAxisSizingMode", primary);
    setValue(node, "counterAxisSizingMode", counter);
    return {
      layoutMode: layout.layoutMode,
      primaryAxisSizingMode: primary,
      counterAxisSizingMode: counter,
      compatibilityFixedPrimary: false,
      compatibilityFixedCounter: false,
    };
  }

  /**
   * Restores the source placement of an absolute auto-layout child.
   *
   * This must be safe both for ordinary children and for operands nested under
   * BooleanOperationNode.  Figma exposes boolean operand transforms in the
   * nearest-container coordinate space, so reuse the same conversion as the
   * initial node build instead of blindly writing immediate-parent x/y.
   *
   * Prefer relativeTransform when the source has one: x/y alone loses the
   * linear part (rotation / reflection / skew).  Plain x/y stays as the
   * compatibility fallback for records that do not carry a matrix.
   */
  function directRestoreAbsoluteChild(node, spec, specById, session) {
    if (!spec || !spec.childLayout || spec.childLayout.layoutPositioning !== "ABSOLUTE") return;
    var booleanPlacement = directBooleanAwarePlacement(spec, specById);
    if (booleanPlacement) {
      directSet(node, "relativeTransform", booleanPlacement);
      return;
    }

    if (spec.relativeTransform && spec.relativeTransform.length === 2) {
      // A source matrix is authoritative in full: preserving only x/y here can
      // lose reflection/rotation/skew and move the visible box even though the
      // translation numerically looks correct.
      directSet(node, "relativeTransform", spec.relativeTransform);
      return;
    }

    var sx = Number(spec.x);
    var sy = Number(spec.y);
    if (!isFinite(sx)) sx = 0;
    if (!isFinite(sy)) sy = 0;

    if (typeof spec.rotation === "number" && Math.abs(spec.rotation) > 1e-7) {
      directSet(node, "x", sx);
      directSet(node, "y", sy);
      directSet(node, "rotation", spec.rotation);
      return;
    }

    // No source matrix/rotation means an axis-aligned identity transform.
    // On live Figma, ABSOLUTE + STRETCH/MAX can leave a stale linear transform
    // after parent HUG/FILL resolution. Reassigning x/y does not necessarily
    // clear that state: the visible box may end up exactly one own width to the
    // left/right while its origin still looks plausible. Canonicalize the full
    // affine basis first, then write x/y as a host-compatible fallback/readback
    // anchor. This is source semantics, not a case-specific correction.
    directSet(node, "relativeTransform", [[1, 0, sx], [0, 1, sy]]);
    directSet(node, "x", sx);
    directSet(node, "y", sy);

    var finalX = NaN;
    var finalY = NaN;
    try { finalX = Number(node.x); } catch (_eFinalAbsX) {}
    try { finalY = Number(node.y); } catch (_eFinalAbsY) {}
    if (session && ((isFinite(finalX) && Math.abs(finalX - sx) > 0.05) ||
        (isFinite(finalY) && Math.abs(finalY - sy) > 0.05))) {
      directNote(session, "ABSOLUTE_POSITION_READBACK_MISMATCH");
    }
  }

  function directFinalizeInstanceAudit(session, audit) {
    var reasons = audit.reasons;
    var sourceSafety = audit.spec && audit.spec.visualSafety;
    if (sourceSafety && sourceSafety.safe === false) {
      (sourceSafety.reasons || ["SOURCE_VISUAL_STATE_UNVERIFIED"]).forEach(function (reason) {
        reasons[reason] = (reasons[reason] || 0) + 1;
      });
      (sourceSafety.directReasons || []).forEach(function (reason) {
        session.nativeUnsafeDirectByReason[reason] =
          (session.nativeUnsafeDirectByReason[reason] || 0) + 1;
      });
      (sourceSafety.inheritedReasons || []).forEach(function (reason) {
        session.nativeUnsafeInheritedByReason[reason] =
          (session.nativeUnsafeInheritedByReason[reason] || 0) + 1;
        var definitionId = audit.spec && audit.spec.definitionId || "<unknown>";
        var bucket = session.nativeUnsafeInheritedByDefinition[definitionId];
        if (!bucket) {
          bucket = session.nativeUnsafeInheritedByDefinition[definitionId] = {
            occurrences: 0, reasons: Object.create(null), samples: []
          };
        }
        // Count occurrences once per definition even when several inherited
        // reasons are attached to the same occurrence.
        if (!bucket._lastOccurrence || bucket._lastOccurrence !== (audit.spec && audit.spec.id)) {
          bucket.occurrences += 1;
          bucket._lastOccurrence = audit.spec && audit.spec.id || null;
          if (bucket.samples.length < 3) bucket.samples.push(bucket._lastOccurrence);
        }
        bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1;
      });
    }
    var codes = Object.keys(reasons);
    if (!codes.length) {
      session.totals.nativeInstancesVisualSafe += 1;
      return;
    }
    session.totals.nativeInstancesUnsafe += 1;
    codes.forEach(function (reason) {
      session.nativeUnsafeByReason[reason] = (session.nativeUnsafeByReason[reason] || 0) + 1;
    });
    if (session.nativeUnsafeSamples.length < 20) {
      session.nativeUnsafeSamples.push({
        occurrenceId: audit.spec && audit.spec.id || null,
        definitionId: audit.spec && audit.spec.definitionId || null,
        reasons: codes.sort(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Сборка дерева
  // -------------------------------------------------------------------------

  /**
   * Строит плоский список узлов IR. Родитель в списке всегда стоит раньше
   * ребёнка, поэтому один проход достаточен; auto layout и поведение внутри
   * него применяются отдельными проходами — иначе Figma перекладывает детей
   * раньше, чем они появились.
   */
  /** Владелец нативной схемы Direct PIX: компонент либо его COMPONENT_SET. */
  function directNativePropertyOwner(component) {
    return propertyDefinitionOwner(component);
  }

  /**
   * Объявляет только BOOL/TEXT/INSTANCE_SWAP, которые доказанно существуют
   * в Pixso componentPropDef и реально читаются узлами определения.
   * VARIANT здесь намеренно отсутствует: его уже создаёт combineAsVariants.
   */
  function directEnsureNativeProperties(definition, component, session) {
    var properties = definition && definition.nativeProperties || [];
    if (!properties.length) return Object.create(null);
    var owner = directNativePropertyOwner(component);
    var ownerId = nodeIdentity(owner);
    if (!owner || !ownerId) {
      session.totals.nativePropertiesDeclared += properties.length;
      session.totals.nativePropertyBindingsMissed += properties.length;
      directNote(session, "NATIVE_PROPERTY_OWNER_UNAVAILABLE");
      return Object.create(null);
    }
    var names = session.nativePropertyNames[ownerId] ||
      (session.nativePropertyNames[ownerId] = Object.create(null));
    var schemas = session.nativePropertySchemas[ownerId] ||
      (session.nativePropertySchemas[ownerId] = Object.create(null));
    var bindingNames = session.nativePropertyNamesByBinding[ownerId] ||
      (session.nativePropertyNamesByBinding[ownerId] = Object.create(null));
    var bindingSchemas = session.nativePropertySchemasByBinding[ownerId] ||
      (session.nativePropertySchemasByBinding[ownerId] = Object.create(null));
    for (var i = 0; i < properties.length; i++) {
      var property = properties[i];
      if (!property || !property.propertyId || !property.name || !property.type) continue;
      if (!schemas[property.propertyId]) {
        schemas[property.propertyId] = { name: String(property.name), type: String(property.type) };
      }
      var bindingIdentity = property.bindingIdentity ? String(property.bindingIdentity) : null;
      if (bindingIdentity && bindingNames[bindingIdentity]) {
        // Same proven published slot, different local Pixso property id. Reuse
        // the already-declared Figma property instead of poisoning the set with
        // a second logical definition. Both ids remain valid lookup aliases.
        names[property.propertyId] = bindingNames[bindingIdentity];
        session.totals.nativePropertyMirrorAliases =
          (session.totals.nativePropertyMirrorAliases || 0) + 1;
        continue;
      }
      if (names[property.propertyId]) continue;
      session.totals.nativePropertiesDeclared += 1;
      if (typeof owner.addComponentProperty !== "function") {
        directNote(session, "NATIVE_PROPERTY_API_UNAVAILABLE");
        continue;
      }
      var defaultValue = property.defaultValue;
      if (property.type === "INSTANCE_SWAP") {
        var defaultComponent = defaultValue ? session.definitions[defaultValue] : null;
        if (!isAlive(defaultComponent) || nodeType(defaultComponent) !== "COMPONENT") {
          directNote(session, "NATIVE_PROPERTY_DEFAULT_SWAP_UNAVAILABLE");
          continue;
        }
        try { defaultValue = defaultComponent.id; }
        catch (_eDefaultId) {
          directNote(session, "NATIVE_PROPERTY_DEFAULT_SWAP_UNAVAILABLE");
          continue;
        }
      }
      try {
        var actualName = owner.addComponentProperty(property.name, property.type, defaultValue);
        if (!actualName) {
          directNote(session, "NATIVE_PROPERTY_CREATE_REJECTED");
          continue;
        }
        names[property.propertyId] = actualName;
        if (bindingIdentity) {
          bindingNames[bindingIdentity] = actualName;
          bindingSchemas[bindingIdentity] = {
            name: String(property.name), type: String(property.type),
            propertyId: String(property.propertyId), defaultValue: property.defaultValue
          };
        }
        session.totals.nativePropertiesCreated += 1;
      } catch (_eProperty) {
        directNote(session, "NATIVE_PROPERTY_CREATE_REJECTED");
      }
    }
    return names;
  }

  /** Переводит public property ids из IR в фактические имена, выданные Figma. */
  function directResolveNativeBindings(nodes, propertyNames, session) {
    for (var i = 0; i < (nodes || []).length; i++) {
      var spec = nodes[i];
      var refs = spec && spec.componentPropertyReferences;
      if (!refs) continue;
      var resolved = {};
      var fields = Object.keys(refs);
      for (var f = 0; f < fields.length; f++) {
        var actual = propertyNames && propertyNames[refs[fields[f]]];
        if (actual) resolved[fields[f]] = actual;
        else session.totals.nativePropertyBindingsMissed += 1;
      }
      if (Object.keys(resolved).length) spec.figmaComponentPropertyReferences = resolved;
    }
  }

  function directApplyNativeBindings(node, spec, session) {
    var refs = spec && spec.figmaComponentPropertyReferences;
    if (!refs || !Object.keys(refs).length) return;
    try {
      node.componentPropertyReferences = clone(refs);
      session.totals.nativePropertyBindingsApplied += Object.keys(refs).length;
    } catch (_eBinding) {
      session.totals.nativePropertyBindingsMissed += Object.keys(refs).length;
      directNote(session, "NATIVE_PROPERTY_BINDING_REJECTED");
    }
  }

  async function directNativePropertyNamesForInstance(instance, session) {
    if (!instance || nodeType(instance) !== "INSTANCE") return null;
    var main = null;
    try {
      main = typeof instance.getMainComponentAsync === "function"
        ? await instance.getMainComponentAsync() : instance.mainComponent;
    } catch (_eMain) { main = null; }
    var owner = directNativePropertyOwner(main);
    var ownerId = nodeIdentity(owner);
    if (!ownerId) return null;
    var names = session.nativePropertyNames[ownerId] || null;
    var schemas = session.nativePropertySchemas[ownerId] || null;
    if (!names || !schemas) return names;

    // Live Figma can canonicalize component-property names while a variant
    // family is assembled. addComponentProperty() returns the name that was
    // valid at declaration time, but a later instance may expose the same
    // property under another generated suffix. Never guess from the visible
    // component name: reconcile only against the FINAL owner's schema, using
    // the Pixso public property id -> logical name/type declaration and accept
    // exactly one matching Figma property definition.
    var definitions = null;
    try { definitions = owner.componentPropertyDefinitions || null; } catch (_eDefs) { definitions = null; }
    if (!definitions) return names;
    var definitionNames = Object.keys(definitions);
    var propertyIds = Object.keys(schemas);
    for (var pi = 0; pi < propertyIds.length; pi++) {
      var propertyId = propertyIds[pi];
      var current = names[propertyId] || null;
      if (current && definitions[current]) continue;
      var schema = schemas[propertyId] || {};
      var logical = schema.name || "";
      if (!logical) continue;
      var matches = definitionNames.filter(function (candidate) {
        var def = definitions[candidate] || {};
        var sameLogical = candidate === logical || candidate.indexOf(logical + "#") === 0;
        return sameLogical && (!schema.type || !def.type || String(def.type) === String(schema.type));
      });
      if (matches.length === 1) {
        names[propertyId] = matches[0];
        session.totals.nativePropertyNamesReconciled =
          (session.totals.nativePropertyNamesReconciled || 0) + 1;
      } else if (matches.length > 1) {
        directNote(session, "NATIVE_PROPERTY_NAME_AMBIGUOUS");
      }
    }
    return names;
  }

  /**
   * Native properties идут ДО low-level override replay. setProperties может
   * перестроить поддерево (особенно INSTANCE_SWAP); затем старый proven путь
   * дельт заново разрешает адреса и остаётся визуальным oracle/fallback.
   */
  /**
   * INSTANCE_SWAP component property меняет master не у внешнего instance,
   * а у bound nested instance(s). Low-level swap path ставит свой отпечаток
   * сам; native setProperties — нет. После успешного native swap находим
   * ровно те слои, чья componentPropertyReferences.mainComponent указывает
   * на это фактическое имя, и синхронизируем доказанный active definition.
   */
  /**
   * Кто на самом деле владеет схемой свойств отвергнутого вхождения.
   *
   * Отказ `setProperties` приходит на вхождение, но причина у него бывает
   * общая — сам COMPONENT_SET. Образец обязан назвать этот набор и состав его
   * вариантов, иначе по логу видно только симптом.
   */
  async function directNativePropertyOwnerIdentity(target) {
    var out = { name: null, type: null, definitionId: null, variantNames: null };
    var main = null;
    // Под `documentAccess: "dynamic-page"` геттер `mainComponent` объявлен
    // документацией Figma WRITE-ONLY и на чтении бросает. Читать можно только
    // `getMainComponentAsync()` — прежняя синхронная попытка молча давала
    // пустой образец.
    if (target && typeof target.getMainComponentAsync === "function") {
      try { main = await target.getMainComponentAsync(); } catch (_eMainAsync) { main = null; }
    }
    if (!main) return out;
    var owner = main;
    try { if (main.parent && nodeType(main.parent) === "COMPONENT_SET") owner = main.parent; }
    catch (_eOwner) { owner = main; }
    try { out.name = owner.name || null; } catch (_eName) {}
    out.type = nodeType(owner) || null;
    try { out.definitionId = owner.getPluginData && owner.getPluginData("pixsoDirectDefinitionId") || null; }
    catch (_ePlugin) {}
    if (out.type === "COMPONENT_SET") {
      var names = [];
      try {
        var kids = owner.children || [];
        for (var i = 0; i < kids.length && names.length < 8; i++) names.push(String(kids[i].name || ""));
        out.variantNames = names.concat(kids.length > names.length ? ["…+" + (kids.length - names.length)] : []);
      } catch (_eKids) { out.variantNames = null; }
    }
    return out;
  }

  function directStampNativeSwapBindings(root, actualName, definitionId, entry, session) {
    var bound = directNativeBoundNodes(root, actualName, "mainComponent", entry, session);
    var stamped = 0;
    for (var i = 0; i < bound.length; i++) {
      var node = bound[i];
      if (nodeType(node) !== "INSTANCE") continue;
      setPluginData(node, "pixsoDirectDefinitionId", definitionId);
      var identity = nodeIdentity(node);
      if (identity) session.swappedDefinitions[identity] = definitionId;
      stamped += 1;
    }
    if (!stamped) directNote(session, "NATIVE_PROPERTY_SWAP_BINDING_NOT_EXPOSED");
    return stamped;
  }

  // A successful setProperties(INSTANCE_SWAP) is stronger provenance than the
  // stale descendant definition ids carried by Pixso symbolOverrides. Pixso
  // can keep a paint/text override addressed inside the PRE-swap component
  // while the public component property names the effective replacement. Mark
  // only bindings whose native effect was read back successfully; target
  // resolution may then rebase descendants by the same structural index path.
  function directMarkVerifiedNativeSwapBindings(root, actualName, definitionId, entry, session) {
    var bound = directNativeBoundNodes(root, actualName, "mainComponent", entry, session);
    var marked = 0;
    for (var i = 0; i < bound.length; i++) {
      var node = bound[i];
      var active = directDefinitionId(node, session);
      if (!active || active !== definitionId) continue;
      setPluginData(node, "pixsoDirectVerifiedNativeSwapDefinitionId", definitionId);
      marked += 1;
    }
    return marked;
  }

  function directNativeAppliedKey(target, propertyId) {
    var identity = nodeIdentity(target);
    return identity && propertyId ? identity + "|" + propertyId : null;
  }

  function directMarkNativePropertyApplied(target, propertyId, session) {
    var key = directNativeAppliedKey(target, propertyId);
    if (key) session.nativePropertyApplied[key] = true;
  }

  function directWasNativePropertyApplied(target, propertyId, session) {
    var key = directNativeAppliedKey(target, propertyId);
    return !!(key && session.nativePropertyApplied[key]);
  }

  /**
   * D42 component naming hierarchy parser.
   *
   * `/` is preserved as author-authored hierarchy/evidence, but never grants
   * component identity by itself. We normalize only syntactic whitespace and
   * the leading dot commonly used by libraries for hidden/internal entries.
   * No known design-system words or file-specific names are present here.
   */
  function directComponentNameHierarchySegments(value) {
    var raw = String(value === undefined || value === null ? "" : value);
    return raw.split("/").map(function (part, index) {
      var normalized = String(part || "").trim().replace(/\s+/g, " ");
      if (index === 0) normalized = normalized.replace(/^\.+/, "").trim();
      return normalized;
    }).filter(function (part) { return !!part; });
  }

  function directComponentNameHierarchyKey(value) {
    return directComponentNameHierarchySegments(value).join(" / ").toLowerCase();
  }

  function directNativeAppliedOwnerKey(root, propertyId) {
    var rootId = nodeIdentity(root);
    return rootId && propertyId ? rootId + "|" + propertyId : null;
  }

  function directMarkNativePropertyAppliedOwner(root, target, propertyId, session) {
    var key = directNativeAppliedOwnerKey(root, propertyId);
    if (key && target) session.nativePropertyAppliedOwners[key] = target;
  }

  function directNativePropertyAppliedOwner(root, propertyId, session) {
    var key = directNativeAppliedOwnerKey(root, propertyId);
    var target = key ? session.nativePropertyAppliedOwners[key] : null;
    return isAlive(target) ? target : null;
  }

  // D54. `directLivePathNames`, `directNameHierarchySuffixScore` и
  // `directNativeRouteScore` удалены: они разрешали неоднозначность владельца
  // свойства по ИЕРАРХИИ ИМЁН компонентов. Имя в Direct PIX — диагностика, а
  // не identity; неоднозначность обязана закрываться отказом.

  function directManifestPropertyRoute(session, entry, method, candidates, target) {
    var manifest = session && session.reconstructionManifest;
    if (!manifest || manifest.propertyRoutes.length >= manifest.limit) return;
    manifest.propertyRoutes.push({
      propertyId: entry && entry.propertyId || null,
      propertyType: entry && entry.type || null,
      method: method,
      candidateCount: candidates || 0,
      sourcePath: (entry && entry.path || []).map(function (step) {
        return { index: step && step.index, name: step && step.name || null };
      }),
      targetSourceId: directSourceId(target) || null,
      targetComponentNameHierarchy: target ? directComponentNameHierarchyKey((function () {
        try { return target.name || ""; } catch (_e) { return ""; }
      })()) : null
    });
  }

  /**
   * Владелец публичного component property во ФАКТИЧЕСКОМ дереве.
   *
   * Доказательство ровно одно: строгий путь плюс наличие того же публичного
   * Pixso-id в живой схеме найденного INSTANCE. Не сошлось — честный промах.
   *
   * D54. Здесь были ещё два пути, и оба удалены как запрещённые правилами
   * проекта:
   *
   *   - «тот же маршрут по индексам ребёнка» (`directNodeAtLooseSourcePath`);
   *   - полный обход поддерева с разрешением неоднозначности по ИЕРАРХИИ
   *     ИМЁН компонентов (`directNativeRouteScore`).
   *
   * `AGENTS.md`: «Группировка вхождений держится на устойчивых исходных id.
   * Склейка по одному лишь видимому имени … запрещена: лучше отдельные
   * компоненты, чем неверный.» Шаг пути — это КАНОНИЧЕСКИЙ СЛОТ, а не «любой
   * потомок с таким же свойством»: переназначение на соседа переносит правку
   * между повторяющимися слотами меню/таблицы.
   *
   * Измерено на живом файле (логи 10:32 → 11:48, оба в свежий документ):
   * все 54 цели, переназначенные по индексу, попали не туда — ровно 54
   * записи `visualParity.native.target`. Одна неверная цель `setProperties`
   * пересобирает поддерево вхождения, после чего в него не адресуется уже
   * тысяча override-путей: `WRONG_NESTED_SWAP_CONTEXT` 0 → 1024,
   * `overridesMissed` 41 → 1077, `overridesApplied` −1903.
   */
  async function directResolveNativePropertyTarget(root, entry, session) {
    // D61. Native component-property values are value replay, not structural
    // mutation. A published/copy-equivalent component can legitimately use a
    // different local definition namespace while exposing the same public
    // property id. The generic override resolver already has a fail-closed
    // proof for exactly this case (`directPublishedEquivalentForValueReplay`),
    // but native properties previously called it without enabling that proof.
    // Result: the public TEXT/BOOLEAN/INSTANCE_SWAP property existed and was
    // uniquely addressable, yet the value was dropped as a nested-context
    // miss. Reuse the same formal published-identity proof here; no names,
    // geometry, sibling guessing, or loose index routing are introduced.
    var strict = directResolveTarget(root, entry.path || [], session, {
      allowPublishedEquivalent: true,
      allowShapeDifference: false
    });
    if (strict.target && nodeType(strict.target) === "INSTANCE") {
      var strictNames = await directNativePropertyNamesForInstance(strict.target, session);
      if (strictNames && strictNames[entry.propertyId]) {
        directManifestPropertyRoute(session, entry, "STRICT_PATH", 1, strict.target);
        return { target: strict.target, names: strictNames, actualName: strictNames[entry.propertyId], resolution: strict };
      }
    }
    return { target: null, names: null, actualName: null, resolution: strict };
  }

  function directMarkVerifiedNativeEffectOwners(root, actualName, entry, session) {
    if (!entry || !session || !session.nativeEffectOwners) return 0;
    var field = entry.type === "BOOLEAN" ? "visible" :
      (entry.type === "TEXT" ? "characters" :
      (entry.type === "INSTANCE_SWAP" ? "mainComponent" : null));
    if (!field) return 0;
    // D54б. Здесь fallback разрешён: функция пишет только в session-память
    // (`nativeEffectOwners`), которой пользуется подавление материализованного
    // следа. Провенанс узла она не трогает, поэтому адресацию путей испортить
    // не может — в отличие от штампующих `directStampNativeSwapBindings` и
    // `directMarkVerifiedNativeSwapBindings`.
    var bound = directNativeBoundNodes(root, actualName, field, entry, session, true);
    var marked = 0;
    for (var i = 0; i < bound.length; i++) {
      var identity = nodeIdentity(bound[i]);
      if (!identity) continue;
      var owner = session.nativeEffectOwners[identity] || (session.nativeEffectOwners[identity] = Object.create(null));
      owner[field] = { propertyId: entry.propertyId || null, propertyType: entry.type || null };
      marked += 1;
    }
    return marked;
  }

  function directFilterVerifiedNativeEffectOps(target, ops, session, entry) {
    if (!target || !ops || !session || !session.nativeEffectOwners) return ops;
    var identity = nodeIdentity(target);
    var owner = identity ? session.nativeEffectOwners[identity] : null;
    if (!owner) return ops;
    var out = {};
    Object.keys(ops).forEach(function (key) {
      var field = key === "visible" ? "visible" : (key === "characters" ? "characters" : null);
      // Suppression is legal only when THIS override entry says the native
      // property owns the same field. A node can be bound to a public BOOLEAN
      // property and still have an explicit occurrence-level visibility state
      // in Pixso. Global node ownership must not erase that later resolved
      // state. MigrationIR deliberately withholds nativeOwners.visible on a
      // proven conflict, so the explicit low-level value wins last.
      var entryNativeOwner = entry && entry.nativeOwners && entry.nativeOwners[field];
      if (field && owner[field] && entryNativeOwner) {
        session.totals.nativeEffectLowLevelSuppressed =
          (session.totals.nativeEffectLowLevelSuppressed || 0) + 1;
        directStageRecord(session, "low-level-verified-native-effect-suppressed", target, null, {
          propertyId: owner[field].propertyId, propertyType: owner[field].propertyType, lowLevelOp: key
        }, false);
        return;
      }
      out[key] = ops[key];
    });
    return out;
  }

  /**
   * Узлы, реально читающие одно native property внутри instance.
   *
   * Figma считает успешным сам вызов `setProperties`, даже если нужный nested
   * слой в конкретном варианте сейчас не экспонирован. Для визуального
   * ownership этого недостаточно: подавлять proven low-level fallback можно
   * только после read-back эффекта на bound layer.
   */
  function directNativeBoundNodes(root, actualName, field, entry, session, allowSourceBindingFallback) {
    var out = [];
    var seen = Object.create(null);
    var stack = [root];
    while (stack.length) {
      var node = stack.pop();
      if (!node) continue;
      var refs = null;
      try { refs = node.componentPropertyReferences || null; } catch (_eRefs) { refs = null; }
      if (refs && refs[field] === actualName) {
        var liveIdentity = nodeIdentity(node) || ("source:" + String(directSourceId(node) || ""));
        if (!seen[liveIdentity]) { seen[liveIdentity] = true; out.push(node); }
      }
      var children = nodeChildren(node);
      for (var i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }

    // Публичное свойство Figma может быть корректным, а `setProperties`
    // отработать, при этом живой read-back у потомков не отдаёт
    // `componentPropertyReferences`. Тогда привязку берём из формальной
    // привязки активного определения по точному индексному пути ВНУТРИ него.
    // Ни имён, ни геометрии, ни нечёткого совпадения.
    //
    // D54б. Этот fallback разрешён ТОЛЬКО потребителям, которые читают.
    //
    // Раньше он раздавался всем, включая `directStampNativeSwapBindings` и
    // `directMarkVerifiedNativeSwapBindings` — а они ПИШУТ на узел plugin data
    // `pixsoDirectDefinitionId`. Узел, доказанный лишь косвенной привязкой,
    // получал чужое активное определение, и дальше резолвер override-путей
    // видел `activeDefinitionId`, не совпадающий с шагом пути, и закрывался
    // отказом. Измерено: `WRONG_NESTED_SWAP_CONTEXT` 0 → 185,
    // `overridesApplied` −1903 при неизменном остальном.
    //
    // Верификации эффекта и снимку для отчёта этот путь по-прежнему нужен:
    // без него свойство считается неподтверждённым, и подавление
    // материализованного следа не срабатывает.
    if (allowSourceBindingFallback && !out.length && entry && entry.propertyId && session) {
      var definitionId = directDefinitionId(root, session);
      var map = definitionId && session.definitionStructuralMaps
        ? session.definitionStructuralMaps[definitionId] : null;
      if (map) {
        var pathKeys = Object.keys(map);
        for (var p = 0; p < pathKeys.length; p++) {
          var structural = map[pathKeys[p]] || {};
          var sourceRefs = structural.componentPropertyReferences || null;
          if (!sourceRefs || sourceRefs[field] !== entry.propertyId) continue;
          var path = pathKeys[p] ? pathKeys[p].split(".").map(function (part) { return Number(part); }) : [];
          var proven = directNodeAtIndexPath(root, path);
          if (!proven || (structural.targetType && nodeType(proven) !== structural.targetType)) continue;
          var provenIdentity = nodeIdentity(proven) || ("source:" + String(directSourceId(proven) || ""));
          if (seen[provenIdentity]) continue;
          seen[provenIdentity] = true;
          out.push(proven);
          session.totals.nativePropertyEffectsResolvedBySourceBinding =
            (session.totals.nativePropertyEffectsResolvedBySourceBinding || 0) + 1;
        }
      }
    }
    return out;
  }

  function directChildSlotSnapshot(node) {
    if (!node) return null;
    var out = {};
    try { out.layoutGrow = node.layoutGrow; } catch (_eGrow) {}
    try { out.layoutAlign = node.layoutAlign; } catch (_eAlign) {}
    try { out.layoutPositioning = node.layoutPositioning; } catch (_ePositioning) {}
    return out;
  }

  function directRestoreChildSlot(node, before, session) {
    if (!node || !before) return false;
    var changed = false;
    ["layoutPositioning", "layoutAlign", "layoutGrow"].forEach(function (key) {
      if (before[key] === undefined) return;
      var live;
      try { live = node[key]; } catch (_eRead) { live = undefined; }
      if (live === before[key]) return;
      if (directSet(node, key, before[key])) changed = true;
    });
    if (changed) {
      session.totals.nativeSwapChildLayoutRestored =
        (session.totals.nativeSwapChildLayoutRestored || 0) + 1;
      directNote(session, "NATIVE_SWAP_CHILD_LAYOUT_RESTORED");
    }
    return changed;
  }

  async function directLiveMainDefinitionId(node, session) {
    if (!node || nodeType(node) !== "INSTANCE") return null;
    var main = null;
    try {
      if (typeof node.getMainComponentAsync === "function") main = await node.getMainComponentAsync();
      else main = node.mainComponent || null;
    } catch (_eMain) { main = null; }
    if (!main) return null;
    var mainId = nodeIdentity(main);
    var ids = Object.keys(session.definitions || {});
    for (var i = 0; i < ids.length; i++) {
      var component = session.definitions[ids[i]];
      if (component && nodeIdentity(component) === mainId) return ids[i];
    }
    return null;
  }

  function directDefinitionIdFromFigmaComponentId(figmaComponentId, session) {
    if (!figmaComponentId) return null;
    var ids = Object.keys(session.definitions || {});
    for (var i = 0; i < ids.length; i++) {
      var component = session.definitions[ids[i]];
      if (component && nodeIdentity(component) === String(figmaComponentId)) return ids[i];
    }
    return null;
  }

  function directInstanceSwapPropertyDefinition(target, actualName, session) {
    if (!target || nodeType(target) !== "INSTANCE") return null;
    var properties = null;
    try { properties = target.componentProperties || null; } catch (_eProperties) { properties = null; }
    var current = properties && properties[actualName];
    if (!current || current.type !== "INSTANCE_SWAP" || !current.value) return null;
    return directDefinitionIdFromFigmaComponentId(current.value, session);
  }

  async function directVerifyNativePropertyAsync(target, actualName, entry, session) {
    if (!entry || entry.type !== "INSTANCE_SWAP") return directVerifyNativeProperty(target, actualName, entry, session);

    // Official Figma API exposes the authoritative INSTANCE_SWAP value on the
    // occurrence itself via `componentProperties`. Descendant
    // componentPropertyReferences are useful provenance when Figma exposes the
    // nested layer, but they are not guaranteed to be discoverable by walking
    // the materialized occurrence subtree. Verify the public property value
    // first, mapping its Figma component id back to our source definition id.
    var propertyDefinition = directInstanceSwapPropertyDefinition(target, actualName, session);
    if (propertyDefinition) {
      if (propertyDefinition === entry.swapDefinitionId ||
          directEquivalentDefinition(entry.swapDefinitionId, propertyDefinition, session)) return true;
      return false;
    }

    // Conservative fallback for hosts/stubs that do not expose
    // componentProperties: if the bound nested layer is visible to the plugin,
    // verify its live main component with getMainComponentAsync().
    var bound = directNativeBoundNodes(target, actualName, "mainComponent", entry, session, true);
    if (!bound.length) { directNote(session, "NATIVE_PROPERTY_EFFECT_NOT_EXPOSED"); return false; }
    for (var i = 0; i < bound.length; i++) {
      var active = await directLiveMainDefinitionId(bound[i], session);
      if (!active || (active !== entry.swapDefinitionId && !directEquivalentDefinition(entry.swapDefinitionId, active, session))) return false;
    }
    return true;
  }

  function directVerifyNativeProperty(target, actualName, entry, session) {
    var field = entry.type === "BOOLEAN" ? "visible" :
      (entry.type === "TEXT" ? "characters" :
        (entry.type === "INSTANCE_SWAP" ? "mainComponent" : null));
    if (!field) return false;
    var bound = directNativeBoundNodes(target, actualName, field, entry, session, true);
    if (!bound.length) {
      directNote(session, "NATIVE_PROPERTY_EFFECT_NOT_EXPOSED");
      return false;
    }
    var expected = entry.value;
    for (var i = 0; i < bound.length; i++) {
      var node = bound[i];
      if (entry.type === "BOOLEAN") {
        var visible = null;
        try { visible = node.visible; } catch (_eVisible) {}
        if (visible !== !!expected) return false;
      } else if (entry.type === "TEXT") {
        var characters = null;
        try { characters = node.characters; } catch (_eCharacters) {}
        if (characters !== String(expected === undefined || expected === null ? "" : expected)) return false;
      } else if (entry.type === "INSTANCE_SWAP") {
        var active = directDefinitionId(node, session);
        if (active !== entry.swapDefinitionId) return false;
      }
    }
    return true;
  }

  async function directApplyNativePropertyValues(instance, entries, session) {
    if (!entries || !entries.length || nodeType(instance) !== "INSTANCE") return;

    // Deep nested component properties are topology-dependent.  A swap at
    // depth N can materialize a completely new subtree and therefore changes
    // the address space for every property below it.  Do not merely sort by
    // depth: that still lets non-topology values at shallow levels run before
    // a deeper swap.  First stabilize the whole INSTANCE_SWAP topology from
    // shallow to deep, re-resolving every target from the live root each time;
    // only then replay visual/value properties against the final tree.
    var ordered = entries.slice().sort(function (a, b) {
      var at = a && a.type === "INSTANCE_SWAP" ? 0 : 1;
      var bt = b && b.type === "INSTANCE_SWAP" ? 0 : 1;
      if (at !== bt) return at - bt;
      var ad = a && a.path ? a.path.length : 0;
      var bd = b && b.path ? b.path.length : 0;
      return ad - bd;
    });
    for (var i = 0; i < ordered.length; i++) {
      var entry = ordered[i] || {};
      // D42: resolve property ownership against the LIVE post-swap tree. A
      // copied library master can legitimately have a different local GUID
      // namespace while exposing the same public property schema.
      var routed = await directResolveNativePropertyTarget(instance, entry, session);
      var resolution = routed.resolution || {};
      var target = routed.target;
      if (!target || nodeType(target) !== "INSTANCE") {
        session.totals.nativePropertyValuesMissed += 1;
        directNote(session, target ? "NATIVE_PROPERTY_TARGET_NOT_INSTANCE" :
          (resolution.reason || "NATIVE_PROPERTY_TARGET_MISSING"));
        continue;
      }
      var names = routed.names || await directNativePropertyNamesForInstance(target, session);
      var actualName = routed.actualName || (names && names[entry.propertyId]);
      if (!actualName || typeof target.setProperties !== "function") {
        session.totals.nativePropertyValuesMissed += 1;
        directNote(session, actualName ? "NATIVE_PROPERTY_SET_UNAVAILABLE" : "NATIVE_PROPERTY_NAME_UNRESOLVED");
        continue;
      }
      var value = entry.value;
      if (entry.type === "INSTANCE_SWAP") {
        var swap = entry.swapDefinitionId ? session.definitions[entry.swapDefinitionId] : null;
        if (!isAlive(swap) || nodeType(swap) !== "COMPONENT") {
          session.totals.nativePropertyValuesMissed += 1;
          directNote(session, "NATIVE_PROPERTY_SWAP_UNAVAILABLE");
          continue;
        }
        try { value = swap.id; }
        catch (_eSwapId) { value = undefined; }
      }
      if (value === undefined || value === null) {
        session.totals.nativePropertyValuesMissed += 1;
        directNote(session, "NATIVE_PROPERTY_VALUE_INVALID");
        continue;
      }
      var one = {};
      one[actualName] = value;
      var nativeBefore = session.stageTrace ? directStageSnapshot(target) : null;

      // setProperties() owns component-property state, but it does NOT own the
      // target instance's slot in its parent auto-layout. In live Figma a
      // nested setProperties() may rematerialize the instance and reset its
      // layoutGrow/layoutAlign/layoutPositioning to the master/default slot.
      // That is exactly the wrong owner: Pixso serializes this relationship on
      // the occurrence (childLayout), independently of BOOLEAN/TEXT/SWAP
      // component properties. Preserve the target slot across every native
      // property write, not only INSTANCE_SWAP.
      var targetSlotBefore = directChildSlotSnapshot(target);
      var swapSlotsBefore = null;
      if (entry.type === "INSTANCE_SWAP") {
        swapSlotsBefore = directNativeBoundNodes(target, actualName, "mainComponent", entry, session).map(function (node) {
          return { sourceId: directSourceId(node), slot: directChildSlotSnapshot(node) };
        });
      }
      try {
        target.setProperties(one);
        directRestoreChildSlot(target, targetSlotBefore, session);
        if (entry.type === "INSTANCE_SWAP") {
          var swapSlotsAfter = directNativeBoundNodes(target, actualName, "mainComponent", entry, session);
          for (var sb = 0; sb < swapSlotsBefore.length; sb++) {
            var beforeSlot = swapSlotsBefore[sb];
            var restoredTarget = null;
            for (var sa = 0; sa < swapSlotsAfter.length; sa++) {
              if (beforeSlot.sourceId && directSourceId(swapSlotsAfter[sa]) === beforeSlot.sourceId) {
                restoredTarget = swapSlotsAfter[sa];
                break;
              }
            }
            if (!restoredTarget && swapSlotsAfter.length === swapSlotsBefore.length) restoredTarget = swapSlotsAfter[sb];
            if (restoredTarget) directRestoreChildSlot(restoredTarget, beforeSlot.slot, session);
          }
        }
        var verified = await directVerifyNativePropertyAsync(target, actualName, entry, session);
        if (verified) {
          directMarkNativePropertyApplied(target, entry.propertyId, session);
          directMarkNativePropertyAppliedOwner(instance, target, entry.propertyId, session);
          directMarkVerifiedNativeEffectOwners(target, actualName, entry, session);
          if (entry.type === "INSTANCE_SWAP") {
            directStampNativeSwapBindings(target, actualName, entry.swapDefinitionId, entry, session);
            directMarkVerifiedNativeSwapBindings(target, actualName, entry.swapDefinitionId, entry, session);
          }
          session.totals.nativePropertyValuesVerified =
            (session.totals.nativePropertyValuesVerified || 0) + 1;
        } else {
          session.totals.nativePropertyValuesUnverified =
            (session.totals.nativePropertyValuesUnverified || 0) + 1;
          directNote(session, "NATIVE_PROPERTY_EFFECT_UNVERIFIED");
        }
        session.totals.nativePropertyValuesApplied += 1;
        directStageRecord(session, "native-setProperties", target, nativeBefore, {
          path: entry.path || [], propertyId: entry.propertyId || null,
          propertyType: entry.type || null, actualName: actualName || null,
          value: entry.type === "INSTANCE_SWAP" ? null : directStageValue(value),
          swapDefinitionId: entry.swapDefinitionId || null, applied: true, verified: verified,
        }, true);
        await directSemanticEffectRecord(session, "after-native-setProperties", target, actualName, entry, verified);
      } catch (_eSet) {
        session.totals.nativePropertyValuesMissed += 1;
        directNote(session, "NATIVE_PROPERTY_SET_REJECTED");
        if (session.stageTrace) session.stageTrace.summary.nativeSetRejected += 1;
        directStageRecord(session, "native-setProperties", target, nativeBefore, {
          path: entry.path || [], propertyId: entry.propertyId || null,
          propertyType: entry.type || null, actualName: actualName || null,
          swapDefinitionId: entry.swapDefinitionId || null, applied: false,
          error: String(_eSet && _eSet.message || _eSet || "setProperties rejected").slice(0, 240),
        }, true);
        if (session.nativePropertyRejectSamples.length < 12) {
          // «Component set has existing errors» — это отказ НАБОРА, а не
          // свойства: Figma перестаёт принимать `setProperties` у ВСЕХ
          // вхождений такого набора сразу, и на экране это выглядит как
          // «везде иконка-умолчание». Без имени самого набора образец
          // называет симптом и молчит о больном — поэтому владелец схемы
          // записывается рядом.
          var rejectedOwner = await directNativePropertyOwnerIdentity(target);
          session.nativePropertyRejectSamples.push({
            targetSourceId: directSourceId(target),
            propertyId: entry.propertyId || null,
            type: entry.type || null,
            actualName: actualName || null,
            swapDefinitionId: entry.swapDefinitionId || null,
            value: entry.type === "INSTANCE_SWAP" ? null : value,
            ownerName: rejectedOwner.name,
            ownerType: rejectedOwner.type,
            ownerDefinitionId: rejectedOwner.definitionId,
            ownerVariantNames: rejectedOwner.variantNames,
            message: String(_eSet && _eSet.message || _eSet || "setProperties rejected").slice(0, 240),
          });
        }
      }
    }
  }

  async function directSemanticEffectRecord(session, stage, owner, actualName, entry, verified) {
    var trace = session && session.semanticEffectTrace;
    if (!trace || !entry || (entry.type !== "BOOLEAN" && entry.type !== "TEXT" && entry.type !== "INSTANCE_SWAP")) return;
    if (trace.samples.length >= trace.limit) { trace.dropped += 1; return; }
    trace.samples.push({
      stage: stage,
      instanceSourceId: session.currentInstanceAudit && session.currentInstanceAudit.spec
        ? session.currentInstanceAudit.spec.id : directSourceId(owner),
      ownerSourceId: directSourceId(owner),
      path: entry.path || [], propertyId: entry.propertyId || null,
      propertyType: entry.type || null, actualName: actualName || null,
      expected: entry.type === "INSTANCE_SWAP" ? entry.swapDefinitionId : entry.value,
      verified: verified,
      bound: await directNativeEffectSnapshot(owner, actualName, entry, session)
    });
  }

  function directEffectiveOwnLayout(spec, session) {
    if (!spec) return null;
    var layout = spec.autoLayout || null;
    if (spec.kind !== "INSTANCE") return layout;
    var occurrenceLayout = directOccurrenceLayoutModes(spec);
    var definitionLayout = null;
    if (session && session.definitionRootSpecs) {
      var definitionRoot = session.definitionRootSpecs[spec.definitionId];
      if (definitionRoot && definitionRoot.autoLayout) definitionLayout = definitionRoot.autoLayout;
    }
    if (!definitionLayout && !occurrenceLayout) return layout;
    var merged = {};
    var sourceLayout = definitionLayout || {};
    Object.keys(sourceLayout).forEach(function (key) { merged[key] = sourceLayout[key]; });
    var patchLayout = occurrenceLayout || {};
    Object.keys(patchLayout).forEach(function (key) {
      if (patchLayout[key] !== undefined) merged[key] = patchLayout[key];
    });
    return merged;
  }

  // Pixso can serialize a circular axis: parent HUGs its children while the
  // child FILLs that same parent axis.
  //
  // Измерено в живой Figma (FIGMA_CAPABILITIES.md, built-hug-counter-over-stretch,
  // built-hug-main-over-grow): узел, собранный в порядке приёмника, держит и
  // Hug родителя, и Fill детей с размерами Pixso — в копии и после пересчёта.
  // Перевод ребёнка в FIXED для фреймов, прямоугольников и инстансов не нужен
  // и только терял Fill. Текст измерен отдельно
  // (`built-hug-counter-over-stretch-text`): растянутый текст с HEIGHT Figma
  // переводит в textAutoResize = NONE, поэтому для текста перевод в FIXED
  // остаётся. Решение принимает DirectPix (`Expressibility.textHugFill`) и
  // присылает в `figmaTranslation`; ветка ниже — для старых payload.
  function directDegenerateFillFixedAxes(spec, parentLayoutMode, session) {
    var out = { width: false, height: false };
    // Новый sender присылает уже принятое по probe решение; Receiver его
    // исполняет. Ветка без поля сохраняет поведение старых payload.
    if (spec && spec.figmaTranslation && spec.figmaTranslation.fixedAxes) {
      out.width = spec.figmaTranslation.fixedAxes.width === true;
      out.height = spec.figmaTranslation.fixedAxes.height === true;
      return out;
    }
    if (!spec || !spec.parent || !spec.childLayout || !session || !session.specById) return out;
    if (spec.type !== "TEXT") return out;
    if (spec.childLayout.layoutPositioning === "ABSOLUTE") return out;
    var parentSpec = session.specById[spec.parent];
    var parentLayout = directEffectiveOwnLayout(parentSpec, session);
    if (!parentLayout || (parentLayout.layoutMode !== "HORIZONTAL" && parentLayout.layoutMode !== "VERTICAL")) return out;
    var horizontal = parentLayout.layoutMode === "HORIZONTAL";
    var mainAxis = horizontal ? "width" : "height";
    var crossAxis = horizontal ? "height" : "width";
    var mainHug = parentLayout.primaryAxisSizingMode === "AUTO";
    var crossHug = parentLayout.counterAxisSizingMode === "AUTO";
    if (mainHug && spec.childLayout.layoutGrow > 0) out[mainAxis] = true;
    if (crossHug && spec.childLayout.layoutAlign === "STRETCH") out[crossAxis] = true;
    return out;
  }

  function directEffectiveChildLayout(spec, parentLayoutMode, session) {
    if (!spec || !spec.childLayout) return null;
    var child = {};
    Object.keys(spec.childLayout).forEach(function (key) { child[key] = spec.childLayout[key]; });
    var fixed = directDegenerateFillFixedAxes(spec, parentLayoutMode, session);
    var parentHorizontal = parentLayoutMode === "HORIZONTAL";
    var parentVertical = parentLayoutMode === "VERTICAL";
    if (parentHorizontal || parentVertical) {
      var mainAxis = parentHorizontal ? "width" : "height";
      var crossAxis = parentHorizontal ? "height" : "width";
      if (fixed[mainAxis] && child.layoutGrow > 0) child.layoutGrow = 0;
      if (fixed[crossAxis] && child.layoutAlign === "STRETCH") child.layoutAlign = "INHERIT";
    }
    return child;
  }

  function directAxisSizingFromSpec(spec, parentLayoutMode, axis, session) {
    var child = spec && spec.childLayout || {};
    var parentHorizontal = parentLayoutMode === "HORIZONTAL";
    var parentVertical = parentLayoutMode === "VERTICAL";
    if ((parentHorizontal || parentVertical) && child.layoutPositioning !== "ABSOLUTE") {
      var mainAxis = parentHorizontal ? "width" : "height";
      var crossAxis = parentHorizontal ? "height" : "width";
      if (axis === mainAxis && child.layoutGrow > 0) return "FILL";
      if (axis === crossAxis && child.layoutAlign === "STRETCH") return "FILL";
    }
    var compatibilityFixed = directDegenerateFillFixedAxes(spec, parentLayoutMode, session);
    if (compatibilityFixed[axis]) return "FIXED";
    var layout = directEffectiveOwnLayout(spec, session);
    if (layout && (layout.layoutMode === "HORIZONTAL" || layout.layoutMode === "VERTICAL")) {
      var horizontal = layout.layoutMode === "HORIZONTAL";
      var ownMode = axis === (horizontal ? "width" : "height")
        ? layout.primaryAxisSizingMode : layout.counterAxisSizingMode;
      return ownMode === "AUTO" ? "HUG" : "FIXED";
    }
    if (spec && spec.type === "TEXT" && spec.text) {
      var effectiveTextAutoResize = directEffectiveTextAutoResize(spec.text);
      if (effectiveTextAutoResize === "WIDTH_AND_HEIGHT") return "HUG";
      if (effectiveTextAutoResize === "HEIGHT") return axis === "height" ? "HUG" : "FIXED";
    }
    return "FIXED";
  }

  function directAxisSizingFromNode(node, parentLayoutMode, axis) {
    var parentHorizontal = parentLayoutMode === "HORIZONTAL";
    var parentVertical = parentLayoutMode === "VERTICAL";
    if (parentHorizontal || parentVertical) {
      var mainAxis = parentHorizontal ? "width" : "height";
      var crossAxis = parentHorizontal ? "height" : "width";
      var grow = 0, align = null, positioning = null;
      try { grow = node.layoutGrow; } catch (_eGrow) {}
      try { align = node.layoutAlign; } catch (_eAlign) {}
      try { positioning = node.layoutPositioning; } catch (_ePositioning) {}
      if (positioning !== "ABSOLUTE") {
        if (axis === mainAxis && grow > 0) return "FILL";
        if (axis === crossAxis && align === "STRETCH") return "FILL";
      }
    }

    // TextNode is the one exception where live Figma can accept a
    // layoutSizing*=HUG assignment yet immediately read it back as FIXED,
    // while textAutoResize still carries the actual text sizing semantics.
    // We already resolved parent-owned FILL above, so for text use
    // textAutoResize as the authoritative owner of the remaining axes.
    // This avoids treating a healthy WIDTH_AND_HEIGHT/HEIGHT text node as a
    // semantic failure just because the shorthand getter reports FIXED.
    if (nodeType(node) === "TEXT") {
      var auto = null;
      try { auto = node.textAutoResize; } catch (_eTextAuto) {}
      if (auto === "WIDTH_AND_HEIGHT") return "HUG";
      if (auto === "HEIGHT") return axis === "height" ? "HUG" : "FIXED";
      if (auto === "TRUNCATE" || auto === "NONE") return "FIXED";
    }

    // For non-text nodes the documented layoutSizing* getter is the direct
    // W/H sizing dropdown read-back and remains authoritative.
    var explicit = null;
    try { explicit = axis === "width" ? node.layoutSizingHorizontal : node.layoutSizingVertical; } catch (_eExplicit) {}
    if (explicit === "FILL" || explicit === "HUG" || explicit === "FIXED") return explicit;

    var mode = null, primary = null, counter = null;
    try { mode = node.layoutMode; primary = node.primaryAxisSizingMode; counter = node.counterAxisSizingMode; } catch (_eLayout) {}
    if (mode === "HORIZONTAL" || mode === "VERTICAL") {
      var horizontal = mode === "HORIZONTAL";
      var own = axis === (horizontal ? "width" : "height") ? primary : counter;
      return own === "AUTO" ? "HUG" : "FIXED";
    }
    return "FIXED";
  }


  // Figma exposes the final resizing semantics directly.  The older importer
  // reconstructed them only indirectly through layoutGrow/layoutAlign and
  // primary/counterAxisSizingMode.  That is insufficient on live Figma:
  // component mutations and TextNode measurement can leave the UI in FIXED
  // even when those lower-level fields look correct.  Prefer the semantic
  // setters when the host supports them; all existing lower-level writes stay
  // as the compatibility fallback.
  /**
   * Сверка hug-оси с коробкой, записанной источником.
   *
   * Ось, отданная обниманию, считается по СОДЕРЖИМОМУ, и это разные функции у
   * Pixso и у Figma: поворот ребёнка, метрики шрифта, округление отступов. На
   * проверенном документе после применения всех правок и свойств 268 вхождений
   * из 305 расходились с записанной коробкой именно по hug-оси — `divider`
   * приезжал 24×24 вместо 1×24 и разносил обнимающего родителя следом.
   *
   * Записанная коробка — это то, что Pixso рисует, поэтому при расхождении
   * выигрывает она: ось закрепляется и размер возвращается. Ровно так же
   * поступает человек, растягивающий инстанс поверх обнимающего мастера.
   *
   * Возражение D13 («отличие размера САМО ПО СЕБЕ не доказывает FIXED: hug
   * законно меняется после TEXT/BOOLEAN/INSTANCE_SWAP») этим не нарушается, а
   * соблюдается: проверка стоит ПОСЛЕ всех правок и нативных свойств и
   * срабатывает только там, где обнимание УЖЕ дало наблюдаемо другой результат.
   * Выдумать FIXED там, где hug сошёлся, она не может.
   *
   * Не трогает: FILL-оси (их владелец — родитель), TEXT и ЛЮБОЙ узел, чьё
   * обнимание считается по тексту, и узлы, приехавшие фоллбеком без
   * содержимого.
   *
   * Про текст отдельно, потому что это и есть граница правила. Ширина строки
   * зависит от метрик шрифта, а шрифт подменяется (`FONT_UNAVAILABLE` — 103
   * штуки на проверенном документе). Обнимание вокруг подменённого шрифта
   * законно даёт другое число, и это НЕ доказательство собственной оси — это
   * другой шрифт. Закрепить там коробку Pixso значит обрезать подпись: ровно
   * так подпись хлебной крошки приезжала зажатой в 81×28. Поэтому текстовая
   * ветка обнимания из правила исключена целиком, а не только сам TEXT-узел.
   */
  /**
   * Считается ли обнимание этого узла по тексту.
   *
   * Достаточно одного TEXT в потоке поддерева: его ширина меряется шрифтом, а
   * шрифт может быть подменён. Поиск идёт только по узлам, реально
   * участвующим в раскладке — скрытые и абсолютные на обнимание не влияют.
   */
  /** Есть ли у узла хоть один ребёнок, участвующий в потоке раскладки. */
  function directHasFlowContent(node) {
    var children = null;
    try { children = node.children; } catch (_eFlow) { return false; }
    if (!children || !children.length) return false;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var hidden = false, absolute = false;
      try { hidden = child.visible === false; } catch (_eVisible) {}
      try { absolute = child.layoutPositioning === "ABSOLUTE"; } catch (_eAbs) {}
      if (!hidden && !absolute) return true;
    }
    return false;
  }

  function directReassertSemanticSizing(node, spec, parentLayoutMode, session) {
    if (!node || !spec) return;
    var width = directAxisSizingFromSpec(spec, parentLayoutMode, "width", session);
    var height = directAxisSizingFromSpec(spec, parentLayoutMode, "height", session);
    var isText = nodeType(node) === "TEXT";

    // One-owner semantic commit.
    //
    // Figma documents layoutSizingHorizontal/Vertical as SHORTHANDS: assigning
    // either can rewrite layoutGrow/layoutAlign and primary/counterAxisSizingMode.
    // Those are exactly the independent Pixso source fields we need to preserve,
    // so the final commit must never write the shorthand.  Commit each owner via
    // its native low-level property instead:
    //   text box       -> textAutoResize
    //   own auto layout-> primary/counterAxisSizingMode
    //   parent slot    -> layoutGrow/layoutAlign/layoutPositioning
    // FIXED pixel geometry was already restored before this semantic phase; no
    // resize is allowed here because Figma also documents that resize inside an
    // auto-layout parent causes parent re-layout.
    var fixedCycle = directDegenerateFillFixedAxes(spec, parentLayoutMode, session);
    if ((fixedCycle.width || fixedCycle.height) && typeof spec.width === "number" && typeof spec.height === "number") {
      var targetW = fixedCycle.width ? spec.width : node.width;
      var targetH = fixedCycle.height ? spec.height : node.height;
      if (directResizePreservingTextSizing(node, targetW, targetH, session)) {
        session.totals.degenerateFillAxesFixed = (session.totals.degenerateFillAxesFixed || 0) +
          (fixedCycle.width ? 1 : 0) + (fixedCycle.height ? 1 : 0);
      }
    }
    if (isText) {
      if (spec.text && spec.text.textAutoResize !== undefined) {
        directSet(node, "textAutoResize", directEffectiveTextAutoResize(spec.text));
      }
    } else {
      var own = directEffectiveOwnLayout(spec, session);
      if (own) {
        if (own.layoutMode) directSet(node, "layoutMode", own.layoutMode);
        if (own.primaryAxisSizingMode !== undefined) directSet(node, "primaryAxisSizingMode", own.primaryAxisSizingMode);
        if (own.counterAxisSizingMode !== undefined) directSet(node, "counterAxisSizingMode", own.counterAxisSizingMode);
      }
    }

    // Parent-owned slot is deliberately LAST: own auto-layout writes and text
    // sizing are allowed to change internals, but not the relationship of this
    // node to its immediate Pixso auto-layout parent.
    if (spec.childLayout) directApplyChildLayout(node, directEffectiveChildLayout(spec, parentLayoutMode, session));

    var widthActual = directAxisSizingFromNode(node, parentLayoutMode, "width");
    var heightActual = directAxisSizingFromNode(node, parentLayoutMode, "height");
    if (widthActual !== width || heightActual !== height) {
      directNote(session, "SEMANTIC_SIZING_COMMIT_MISMATCH");
      if (session.semanticSizingTrace && session.semanticSizingTrace.samples.length < session.semanticSizingTrace.limit) {
        session.semanticSizingTrace.samples.push({
          sourceId: spec.id || null,
          kind: spec.kind || null,
          type: spec.type || nodeType(node),
          parentLayoutMode: parentLayoutMode || null,
          expectedWidth: width,
          actualWidth: widthActual,
          expectedHeight: height,
          actualHeight: heightActual,
          textAutoResize: isText && spec.text ? directEffectiveTextAutoResize(spec.text) : null,
          sourceWidth: typeof spec.width === "number" ? spec.width : null,
          sourceHeight: typeof spec.height === "number" ? spec.height : null,
          definitionId: spec.definitionId || null
        });
      }
    }
  }


  // Re-apply only parent-owned FILL axes after HUG/source-box reconciliation.
  //
  // Why this is a separate pass: pinning a divergent HUG parent to Pixso's
  // resolved box changes the parent's final inner size. Figma can preserve a
  // child's pre-pin pixel width instead of re-resolving its FILL ownership,
  // especially inside native instances/components. The result is the classic
  // narrow/tall cascade: parent is corrected (e.g. 324px), while a content
  // child stays at its old 42px width and its HUG height explodes from text
  // wrapping.
  //
  // This pass never touches HUG or FIXED. It only restores axes whose owner is
  // the parent according to the source layout model, so it cannot undo a HUG
  // axis already settled by the producer's explicit expressibility decision. No names,
  // component types or dimensions are special-cased.
  function directReassertParentOwnedFill(node, spec, parentLayoutMode, session) {
    if (!node || !spec || !spec.childLayout) return false;
    var width = directAxisSizingFromSpec(spec, parentLayoutMode, "width", session);
    var height = directAxisSizingFromSpec(spec, parentLayoutMode, "height", session);
    if (width !== "FILL" && height !== "FILL") return false;

    var actualParentMode = null;
    try { actualParentMode = node.parent && node.parent.layoutMode; } catch (_eParentMode) {}
    if (actualParentMode !== "HORIZONTAL" && actualParentMode !== "VERTICAL") return false;
    var positioning = null;
    try { positioning = node.layoutPositioning; } catch (_ePositioning) {}
    if (positioning === "ABSOLUTE") return false;

    // Do not use layoutSizing*=FILL here. It is a documented shorthand and can
    // rewrite the child's own sizing state. Pixso already gives the canonical
    // parent-slot fields, so re-commit exactly those fields instead.
    var changed = directApplyChildLayout(node, directEffectiveChildLayout(spec, parentLayoutMode, session));
    if (changed) session.totals.postHugFillAxesReasserted =
      (session.totals.postHugFillAxesReasserted || 0) + (width === "FILL" ? 1 : 0) + (height === "FILL" ? 1 : 0);
    return changed;
  }


  function directParityMismatch(session, spec, stage, field, expected, actual) {
    if (typeof expected === "number" && typeof actual === "number" && isFinite(expected) && isFinite(actual)) {
      if (Math.abs(expected - actual) <= 0.0005) return;
    } else if (expected === actual) return;
    var report = session.layoutTextParity;
    report.counts[field] = (report.counts[field] || 0) + 1;
    var sample = {
      stage: stage, sourceId: spec && spec.id || null, kind: spec && spec.kind || null,
      type: spec && spec.type || null, definitionId: spec && spec.definitionId || null,
      field: field, expected: directStageValue(expected), actual: directStageValue(actual),
    };
    // Квота на поле, как у визуальной сверки: частое расхождение одного поля
    // не вытесняет образцы редких. У текста — своя выборка поверх общей.
    if (directAdmitSample(report, [field])) report.samples.push(sample);
    if (spec && spec.type === "TEXT" && report.textSamples.length < report.textLimit) report.textSamples.push(sample);
  }

  function directAuditLayoutTextNode(node, spec, parentLayoutMode, session, stage, effectiveModes) {
    if (!node || !spec || !session.layoutTextParity) return;
    var expectedWidthSizing = directAxisSizingFromSpec(spec, parentLayoutMode, "width", session);
    var expectedHeightSizing = directAxisSizingFromSpec(spec, parentLayoutMode, "height", session);
    // HUG+FILL and empty-HUG are deliberate compatibility translations. The
    // imported node is intentionally FIXED on exactly the axis marked by
    // directApplyAutoLayout; comparing it against the raw Pixso HUG here
    // produced a permanent false mismatch even though the visual fix was
    // working. Keep the source event in unsupportedByCode, but parity must
    // compare against the effective Figma representation.
    if (effectiveModes && spec.autoLayout) {
      var horizontal = effectiveModes.layoutMode === "HORIZONTAL";
      var widthCompat = horizontal
        ? effectiveModes.compatibilityFixedPrimary : effectiveModes.compatibilityFixedCounter;
      var heightCompat = horizontal
        ? effectiveModes.compatibilityFixedCounter : effectiveModes.compatibilityFixedPrimary;
      if (widthCompat && expectedWidthSizing === "HUG") expectedWidthSizing = "FIXED";
      if (heightCompat && expectedHeightSizing === "HUG") expectedHeightSizing = "FIXED";
    }
    directParityMismatch(session, spec, stage, "widthSizing",
      expectedWidthSizing, directAxisSizingFromNode(node, parentLayoutMode, "width"));
    directParityMismatch(session, spec, stage, "heightSizing",
      expectedHeightSizing, directAxisSizingFromNode(node, parentLayoutMode, "height"));
    var child = spec.childLayout || {};
    ["layoutGrow", "layoutAlign", "layoutPositioning"].forEach(function (field) {
      if (child[field] === undefined) return;
      var actual; try { actual = node[field]; } catch (_eChild) { actual = undefined; }
      directParityMismatch(session, spec, stage, field, child[field], actual);
    });
    var layout = spec.autoLayout || {};
    ["layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode",
      "primaryAxisAlignItems", "counterAxisAlignItems", "itemSpacing",
      "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "layoutWrap"].forEach(function (field) {
      if (layout[field] === undefined) return;
      var expected = layout[field];
      if (effectiveModes && field === "primaryAxisSizingMode" &&
          effectiveModes.compatibilityFixedPrimary && expected === "AUTO") expected = "FIXED";
      if (effectiveModes && field === "counterAxisSizingMode" &&
          effectiveModes.compatibilityFixedCounter && expected === "AUTO") expected = "FIXED";
      // Figma explicitly forbids AUTO on an axis whose size is owned by the
      // parent through layoutGrow=1 / STRETCH. In that state the documented
      // representation is FIXED on the frame's own axis plus FILL semantics as
      // an auto-layout child. Pixso can serialize both facts independently, so
      // normalize only the parity expectation — the visual sizing owner remains
      // `layoutGrow`/`layoutAlign` and directAxisSizingFromSpec above.
      if (expected === "AUTO" && (field === "primaryAxisSizingMode" || field === "counterAxisSizingMode")) {
        var ownHorizontal = layout.layoutMode === "HORIZONTAL";
        var axisSizing = field === "primaryAxisSizingMode"
          ? (ownHorizontal ? expectedWidthSizing : expectedHeightSizing)
          : (ownHorizontal ? expectedHeightSizing : expectedWidthSizing);
        if (axisSizing === "FILL") expected = "FIXED";
      }
      var actual; try { actual = node[field]; } catch (_eLayoutField) { actual = undefined; }
      directParityMismatch(session, spec, stage, field, expected, actual);
    });
    var bounds = spec.sizeBounds || {};
    ["minWidth", "maxWidth", "minHeight", "maxHeight"].forEach(function (field) {
      if (bounds[field] === undefined) return;
      var actual; try { actual = node[field]; } catch (_eBound) { actual = undefined; }
      directParityMismatch(session, spec, stage, field, bounds[field], actual);
    });
    if (spec.type === "TEXT" && spec.text) {
      var characters = null, auto = null, truncation = null, maxLines = null;
      try { characters = node.characters; } catch (_eCharacters) {}
      try { auto = node.textAutoResize; } catch (_eTextAuto) {}
      try { truncation = node.textTruncation; } catch (_eTextTruncation) {}
      try { maxLines = node.maxLines; } catch (_eMaxLines) {}
      directParityMismatch(session, spec, stage, "characters", spec.text.characters, characters);
      if (spec.text.textAutoResize !== undefined) {
        directParityMismatch(session, spec, stage, "textAutoResize",
          directEffectiveTextAutoResize(spec.text), auto);
      }
      if (spec.text.textTruncation !== undefined) {
        directParityMismatch(session, spec, stage, "textTruncation",
          spec.text.textTruncation, truncation);
      }
      if (spec.text.maxLines !== undefined) {
        directParityMismatch(session, spec, stage, "maxLines", spec.text.maxLines, maxLines);
      }
    }
  }


  function directVisualComparable(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === "number") {
      if (!isFinite(value)) return String(value);
      return Math.round(value * 10000) / 10000;
    }
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(directVisualComparable);
    if (typeof value === "object") {
      var out = {};
      Object.keys(value).sort().forEach(function (key) {
        // imageHash is stable enough for equality; Figma plugin objects may
        // expose host-only methods/non-data keys, which must not poison the
        // comparison.
        var child = value[key];
        if (typeof child === "function" || child === undefined) return;
        out[key] = directVisualComparable(child);
      });
      return out;
    }
    return String(value);
  }

  function directVisualEqual(expected, actual) {
    var e = directVisualComparable(expected);
    var a = directVisualComparable(actual);
    try { return JSON.stringify(e) === JSON.stringify(a); }
    catch (_e) { return e === a; }
  }

  // D30 semantic paint comparison. Figma read-back enriches paints with
  // host/default metadata (`visible:true`, `boundVariables:{}`, default image
  // filters/transform fields). Those fields are not a visual difference and
  // made D29 report thousands of false mismatches. Compare the visual contract
  // carried by the source paint instead of object identity.
  function directVisualColorEqual(expected, actual) {
    if (!expected || !actual) return expected === actual;
    var colorTolerance = (0.5 / 255) + 0.00001;
    return directVisualNumberEqual(Number(expected.r), Number(actual.r), colorTolerance) &&
      directVisualNumberEqual(Number(expected.g), Number(actual.g), colorTolerance) &&
      directVisualNumberEqual(Number(expected.b), Number(actual.b), colorTolerance) &&
      (expected.a === undefined || directVisualNumberEqual(Number(expected.a), Number(actual.a), colorTolerance));
  }

  function directVisualMatrixEqual(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    for (var r = 0; r < expected.length; r++) {
      if (!Array.isArray(expected[r]) || !Array.isArray(actual[r]) || expected[r].length !== actual[r].length) return false;
      for (var c = 0; c < expected[r].length; c++) {
        if (!directVisualNumberEqual(Number(expected[r][c]), Number(actual[r][c]), 0.0005)) return false;
      }
    }
    return true;
  }

  function directVisualPaintEqual(expected, actual) {
    if (!expected || !actual) return expected === actual;
    if (expected.type !== actual.type) return false;
    if ((expected.visible !== false) !== (actual.visible !== false)) return false;
    if (!directVisualNumberEqual(
      typeof expected.opacity === "number" ? expected.opacity : 1,
      typeof actual.opacity === "number" ? actual.opacity : 1, 0.0005)) return false;
    if ((expected.blendMode || "NORMAL") !== (actual.blendMode || "NORMAL")) return false;

    if (expected.type === "SOLID") return directVisualColorEqual(expected.color, actual.color);

    if (String(expected.type || "").indexOf("GRADIENT_") === 0) {
      if (expected.gradientTransform && !directVisualMatrixEqual(expected.gradientTransform, actual.gradientTransform)) return false;
      var es = expected.gradientStops || [], as = actual.gradientStops || [];
      if (es.length !== as.length) return false;
      for (var gi = 0; gi < es.length; gi++) {
        if (!directVisualNumberEqual(Number(es[gi].position), Number(as[gi].position), 0.0005) ||
            !directVisualColorEqual(es[gi].color, as[gi].color)) return false;
      }
      return true;
    }

    if (expected.type === "IMAGE") {
      if (expected.imageHash && expected.imageHash !== actual.imageHash) return false;
      if ((expected.scaleMode || "FILL") !== (actual.scaleMode || "FILL")) return false;
      // An explicit source crop/transform is visual state and must survive. A
      // host-generated transform is ignored only when the source did not carry
      // one, because Figma may expose an equivalent default matrix.
      if (expected.imageTransform && !directVisualMatrixEqual(expected.imageTransform, actual.imageTransform)) return false;
      if (typeof expected.scalingFactor === "number" &&
          !directVisualNumberEqual(expected.scalingFactor, actual.scalingFactor, 0.0005)) return false;
      if (typeof expected.rotation === "number" &&
          !directVisualNumberEqual(expected.rotation, actual.rotation || 0, 0.0005)) return false;
      return true;
    }

    return directVisualEqual(expected, actual);
  }

  function directVisualPaintsEqual(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return expected === actual;
    if (expected.length !== actual.length) return false;
    for (var i = 0; i < expected.length; i++) {
      if (!directVisualPaintEqual(expected[i], actual[i])) return false;
    }
    return true;
  }

  function directVisualNumberEqual(expected, actual, tolerance) {
    if (typeof expected !== "number" || typeof actual !== "number") return expected === actual;
    return Math.abs(expected - actual) <= (tolerance === undefined ? 0.25 : tolerance);
  }

  function directVisualRead(node, key) {
    try { return node[key]; } catch (_e) { return undefined; }
  }

  function directVisualMismatch(session, spec, field, expected, actual, detail) {
    if (!session || !session.visualParity) return;
    var report = session.visualParity;
    report.counts[field] = (report.counts[field] || 0) + 1;
    // Квота на поле. Без неё частое расхождение (в замерах — 50 по
    // `native.INSTANCE_SWAP.effect`) вытесняло редкое, а именно редкие и
    // нужны: 8 расхождений по `override.strokeWeight` и 10 по `dashPattern`
    // — это и есть «бордеры приходят неправильно».
    if (!directAdmitSample(report, [field])) return;
    report.samples.push({
      sourceId: spec && spec.id || null,
      kind: spec && spec.kind || null,
      type: spec && spec.type || null,
      definitionId: spec && spec.definitionId || null,
      parentId: spec && spec.parent || null,
      field: field,
      expected: directStageValue(directVisualComparable(expected)),
      actual: directStageValue(directVisualComparable(actual)),
      detail: detail || undefined,
    });
  }

  /**
   * D29 final visual-parity audit.
   *
   * The receiver already verifies semantic sizing.  This pass covers the
   * remaining user-visible families that often survive an API assignment but
   * get rewritten later: visibility, strokes, text, opacity and absolute
   * placement.  It runs after ALL layout/native/override commits in a chunk,
   * so a mismatch points at the final document state rather than an
   * intermediate setter result.
   */
  function directExpectedStyleHostId(sourceStyleId, session) {
    if (!sourceStyleId || !session || !session.styles) return null;
    var style = session.styles[sourceStyleId];
    if (!isStyleAlive(style)) return null;
    try { return style.id || null; } catch (_eStyleId) { return null; }
  }

  function directAuditStyleIdentity(node, spec, session) {
    if (!node || !spec || !spec.styles) return;
    [
      ["fill", "fillStyleId"],
      ["stroke", "strokeStyleId"],
      ["effect", "effectStyleId"],
      ["text", "textStyleId"]
    ].forEach(function (pair) {
      var sourceStyleId = spec.styles[pair[0]];
      if (!sourceStyleId) return;
      var expectedHostId = directExpectedStyleHostId(sourceStyleId, session);
      if (!expectedHostId) return;
      var actualHostId = directVisualRead(node, pair[1]);
      if (actualHostId !== expectedHostId) {
        directVisualMismatch(session, spec, pair[1] + ".binding",
          { sourceStyleId: sourceStyleId, figmaStyleId: expectedHostId },
          { figmaStyleId: actualHostId || null });
      }
    });
  }

  function directAuditVisualNode(node, spec, specById, session) {
    if (!node || !spec || !session.visualParity) return;

    if (typeof spec.visible === "boolean") {
      var visible = directVisualRead(node, "visible");
      if (visible !== spec.visible) directVisualMismatch(session, spec, "visible", spec.visible, visible);
    }
    if (typeof spec.opacity === "number") {
      var opacity = directVisualRead(node, "opacity");
      if (!directVisualNumberEqual(spec.opacity, opacity, 0.0005)) {
        directVisualMismatch(session, spec, "opacity", spec.opacity, opacity);
      }
    }
    if (typeof spec.clipsContent === "boolean") {
      var clipsContent = directVisualRead(node, "clipsContent");
      if (clipsContent !== spec.clipsContent) {
        directVisualMismatch(session, spec, "clipsContent", spec.clipsContent, clipsContent);
      }
    }

    if (spec.fills !== undefined) {
      var expectedFills = directPaints(spec.fills, session);
      var actualFills = directVisualRead(node, "fills");
      if (expectedFills && !directVisualPaintsEqual(expectedFills, actualFills)) {
        directVisualMismatch(session, spec, "fills", expectedFills, actualFills, {
          fillStyleId: directVisualRead(node, "fillStyleId") || null,
        });
      }
    }

    // Border/stroke parity.  Compare both paint payload and side weights: a
    // successful style binding can still wipe a local side override.
    if (spec.strokes !== undefined) {
      var expectedStrokes = directPaints(spec.strokes, session);
      var actualStrokes = directVisualRead(node, "strokes");
      if (expectedStrokes && !directVisualPaintsEqual(expectedStrokes, actualStrokes)) {
        directVisualMismatch(session, spec, "strokes", expectedStrokes, actualStrokes, {
          strokeStyleId: directVisualRead(node, "strokeStyleId") || null,
        });
      }
    }
    ["strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern"].forEach(function (field) {
      if (spec[field] === undefined) return;
      var actual = directVisualRead(node, field);
      var same = typeof spec[field] === "number"
        ? directVisualNumberEqual(spec[field], actual, 0.0005)
        : directVisualEqual(spec[field], actual);
      if (field === "strokeWeight" && spec.borderWeights) {
        // Pixso may serialize a base strokeWeight together with explicit
        // per-side weights. In Figma that necessarily reads as figma.mixed;
        // the four side values below are the authoritative visual semantics.
        // Do not flag the aggregate helper property as a mismatch.
        same = true;
      } else if (field === "strokeWeight" && typeof spec[field] === "number" && actual === figma.mixed) {
        same = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"].every(function (side) {
          return directVisualNumberEqual(spec[field], directVisualRead(node, side), 0.0005);
        });
      }
      if (!same) directVisualMismatch(session, spec, field, spec[field], actual, field === "strokeWeight" ? {
        top: directVisualRead(node, "strokeTopWeight"), right: directVisualRead(node, "strokeRightWeight"),
        bottom: directVisualRead(node, "strokeBottomWeight"), left: directVisualRead(node, "strokeLeftWeight")
      } : undefined);
    });
    if (spec.borderWeights) {
      [
        ["strokeTopWeight", "top"], ["strokeRightWeight", "right"],
        ["strokeBottomWeight", "bottom"], ["strokeLeftWeight", "left"]
      ].forEach(function (pair) {
        var expected = spec.borderWeights[pair[1]];
        if (expected === undefined) return;
        var actual = directVisualRead(node, pair[0]);
        if (!directVisualNumberEqual(expected, actual, 0.0005)) {
          directVisualMismatch(session, spec, pair[0], expected, actual, {
            strokeStyleId: directVisualRead(node, "strokeStyleId") || null,
          });
        }
      });
    }

    directAuditStyleIdentity(node, spec, session);

    if (spec.type === "TEXT" && spec.text) {
      var characters = directVisualRead(node, "characters");
      if (spec.text.characters !== undefined && characters !== spec.text.characters) {
        directVisualMismatch(session, spec, "characters", spec.text.characters, characters);
      }
      // Text can be present but visually disappear through fill/opacity.
      if (spec.text.fills !== undefined) {
        var expectedTextFills = directPaints(spec.text.fills, session);
        var actualTextFills = directVisualRead(node, "fills");
        if (expectedTextFills && !directVisualPaintsEqual(expectedTextFills, actualTextFills)) {
          directVisualMismatch(session, spec, "textFills", expectedTextFills, actualTextFills, {
            textStyleId: directVisualRead(node, "textStyleId") || null,
          });
        }
      }
    }

    // Tooltips/floating controls are commonly ABSOLUTE.  Position is audited
    // only after the existing final absolute-position commit, so this never
    // reopens the already-fixed general placement logic.
    if (spec.childLayout && spec.childLayout.layoutPositioning === "ABSOLUTE") {
      var expectedTransform = directBooleanAwarePlacement(spec, specById) || directSpecTransform(spec);
      var actualTransform = directVisualRead(node, "relativeTransform");
      if (Array.isArray(expectedTransform) && Array.isArray(actualTransform) &&
          expectedTransform.length === 2 && actualTransform.length === 2) {
        var ex = expectedTransform[0][2], ey = expectedTransform[1][2];
        var ax = actualTransform[0][2], ay = actualTransform[1][2];
        if (!directVisualNumberEqual(ex, ax, 0.25) || !directVisualNumberEqual(ey, ay, 0.25)) {
          directVisualMismatch(session, spec, "absolutePosition", { x: ex, y: ey }, { x: ax, y: ay }, {
            parentType: spec.parent && specById[spec.parent] ? specById[spec.parent].type || null : null,
            constraints: spec.constraints || null,
          });
        }
      }
    }
  }

  function directReconcileExpectedInstance(session, spec) {
    if (!session || !session.instanceReconciliation || !spec || !spec.id) return;
    session.instanceReconciliation.expected[String(spec.id)] = {
      definitionId: spec.definitionId || null,
      parentId: spec.parent || null,
    };
  }

  function directReconcileCreatedInstance(session, spec) {
    if (!session || !session.instanceReconciliation || !spec || !spec.id) return;
    session.instanceReconciliation.created[String(spec.id)] = true;
    delete session.instanceReconciliation.failures[String(spec.id)];
  }

  function directReconcileFailedInstance(session, spec, reason, detail) {
    if (!session || !session.instanceReconciliation || !spec || !spec.id) return;
    session.instanceReconciliation.failures[String(spec.id)] = {
      reason: reason || "UNKNOWN",
      definitionId: spec.definitionId || null,
      parentId: spec.parent || null,
      detail: detail || null,
    };
  }

  function directInstanceReconciliationReport(session) {
    var reconciliation = session && session.instanceReconciliation;
    if (!reconciliation) return null;
    var expectedIds = Object.keys(reconciliation.expected);
    var createdIds = Object.keys(reconciliation.created);
    var missing = [];
    var byReason = Object.create(null);
    for (var i = 0; i < expectedIds.length; i++) {
      var id = expectedIds[i];
      if (reconciliation.created[id]) continue;
      var failure = reconciliation.failures[id] || {
        reason: "NO_CREATION_RECORD",
        definitionId: reconciliation.expected[id].definitionId || null,
        parentId: reconciliation.expected[id].parentId || null,
        detail: null,
      };
      byReason[failure.reason] = (byReason[failure.reason] || 0) + 1;
      if (missing.length < reconciliation.sampleLimit) {
        missing.push({
          occurrenceId: id,
          definitionId: failure.definitionId || null,
          parentId: failure.parentId || null,
          reason: failure.reason,
          detail: failure.detail || undefined,
        });
      }
    }
    return {
      expectedUnique: expectedIds.length,
      createdUnique: createdIds.length,
      missingUnique: expectedIds.length - createdIds.length,
      missingByReason: byReason,
      missingSamples: missing,
      sampleLimit: reconciliation.sampleLimit,
    };
  }

  async function directBuildNodes(nodes, session, options) {
    var byId = Object.create(null);
    // Source-spec lookup is needed for Figma's special boolean coordinate
    // system: children of BooleanOperationNode are positioned relative to the
    // nearest container parent, while Pixso stores immediate-parent coords.
    var specById = Object.create(null);
    for (var sm = 0; sm < nodes.length; sm++) specById[nodes[sm].id] = nodes[sm];
    session.specById = specById;
    var layoutQueue = [];
    var childQueue = [];
    // spec.id ребёнка → направление раскладки его родителя. Без него
    // `layoutGrow` нельзя перевести в ось: одна и та же запись означает
    // ширину в HORIZONTAL и высоту в VERTICAL.
    var parentLayoutModes = Object.create(null);
    var childLayoutModeOfParent = Object.create(null);
    // spec.id контейнера → режимы осей, которые приёмник ДЕЙСТВИТЕЛЬНО
    // выставил (объявленные плюс поправка «обнимать нечего»).
    var effectiveModes = Object.create(null);
    var instanceQueue = [];
    var exposureQueue = [];
    var booleanQueue = [];
    var instanceAudits = [];
    // Бюджет общий с остальной задачей: собственный отсчёт здесь означал бы,
    // что цикл имеет право занять поток заново, сразу после чужой долгой работы.
    var slice = session.slice || createSlice();
    var ordinaryStartedAt = Date.now();

    for (var i = 0; i < nodes.length; i++) {
      var spec = nodes[i];
      var node = null;
      // Ожидание источника фиксируется ДО любого отказа: инстансом это
      // вхождение должно было стать независимо от того, чем оно стало.
      if (spec.kind === "INSTANCE") {
        session.totals.expectedInstances += 1;
        directReconcileExpectedInstance(session, spec);
      }
      // Родитель в списке всегда раньше ребёнка, поэтому направление его
      // раскладки уже известно к моменту, когда очередь доходит до детей.
      if (spec.autoLayout && spec.autoLayout.layoutMode) {
        childLayoutModeOfParent[spec.id] = spec.autoLayout.layoutMode;
      }
      if (spec.parent && childLayoutModeOfParent[spec.parent]) {
        parentLayoutModes[spec.id] = childLayoutModeOfParent[spec.parent];
      }

      if (i === 0 && options.rootNode) {
        node = options.rootNode;
        directSizeStage(session, spec.id, "created", node, "rootNode");
        await directApplyNode(node, spec, session, directBooleanAwarePlacement(spec, specById));
        directSizeStage(session, spec.id, "after-base-sizing", node);
      } else {
        var parent = spec.parent ? byId[spec.parent] : options.parentForRoot;
        if (!directCanHoldChildren(parent)) {
          directNote(session, "PARENT_MISSING");
          if (spec.kind === "INSTANCE") {
            var parentSpec = spec.parent ? specById[spec.parent] : null;
            directReconcileFailedInstance(session, spec, "PARENT_MISSING", {
              parentPlanned: !!parentSpec,
              parentBuilt: !!parent,
              parentKind: parentSpec ? parentSpec.kind || null : null,
              parentType: parentSpec ? parentSpec.type || null : null,
            });
          }
          continue;
        }
        if (spec.kind === "INSTANCE") {
          node = await directCreateInstance(spec, session);
          if (!node) continue;
          directSizeStage(session, spec.id, "created", node, "createInstance");
        } else {
          node = directCreateNode(spec);
          session.totals.ordinaryNodesCreated += 1;
          directSizeStage(session, spec.id, "created", node, "createNode");
        }
        try { parent.appendChild(node); }
        catch (_eAppend) { directNote(session, "APPEND_REJECTED"); continue; }
        directSizeStage(session, spec.id, "after-append", node, "appendChild");
        await directApplyNode(node, spec, session, directBooleanAwarePlacement(spec, specById));
        directSizeStage(session, spec.id, "after-base-sizing", node);
      }

      directApplyNativeBindings(node, spec, session);
      byId[spec.id] = node;
      if (spec.kind === "INSTANCE" && spec.isExposedInstance === true) {
        session.totals.exposedInstancesRequested += 1;
        var primaryExposure = true;
        var exposureParentId = spec.parent || null;
        while (exposureParentId) {
          var exposureParentSpec = specById[exposureParentId];
          if (!exposureParentSpec) break;
          if (exposureParentSpec.kind === "INSTANCE") { primaryExposure = false; break; }
          exposureParentId = exposureParentSpec.parent || null;
        }
        if (primaryExposure) exposureQueue.push({ node: node, spec: spec });
        else session.totals.exposedInstancesNonPrimarySkipped += 1;
      }
      if (spec.type === "BOOLEAN_OPERATION") booleanQueue.push({ node: node, spec: spec });
      if (spec.autoLayout) layoutQueue.push({ node: node, layout: spec.autoLayout, spec: spec });
      if (spec.childLayout) {
        childQueue.push({
          node: node, childLayout: spec.childLayout, spec: spec,
          parentLayoutMode: parentLayoutModes[spec.id] || null,
        });
      }
      if (spec.kind === "INSTANCE") {
        session.totals.nativeInstancesConsidered += 1;
        var audit = { node: node, spec: spec, reasons: Object.create(null) };
        instanceAudits.push(audit);
      }
      if (spec.kind === "INSTANCE" &&
          ((spec.overrides && spec.overrides.length) || (spec.nativeProperties && spec.nativeProperties.length))) {
        instanceQueue.push({
          node: node, overrides: spec.overrides || [], nativeProperties: spec.nativeProperties || [],
          spec: spec, audit: audit
        });
      }

      await yieldIfNeeded(slice);
    }
    // BooleanOperationNode owns its fitted position/size from the operand tree.
    // Do NOT reassert the boolean transform here: its operands were already
    // converted to Figma's container-relative coordinate space above, and
    // moving the fitted boolean again would apply the source translation a
    // second time. Keep only the bounds audit; differing editable bounds are
    // diagnostic, not a reason to move/scale the operation.
    for (var bq = 0; bq < booleanQueue.length; bq++) {
      var booleanItem = booleanQueue[bq];
      if (!isAlive(booleanItem.node)) continue;
      if (typeof booleanItem.spec.width === "number" && typeof booleanItem.spec.height === "number") {
        var bw = Math.abs((Number(booleanItem.node.width) || 0) - booleanItem.spec.width);
        var bh = Math.abs((Number(booleanItem.node.height) || 0) - booleanItem.spec.height);
        if (bw > 0.5 || bh > 0.5) directNote(session, "BOOLEAN_BOUNDS_DIFFER");
      }
    }

    session.timings.ordinaryBuildMs += Date.now() - ordinaryStartedAt;

    // От глубоких контейнеров к внешним: внутренний layout обязан устояться
    // раньше, чем внешний начнёт считать по нему свои размеры.
    for (var l = layoutQueue.length - 1; l >= 0; l--) {
      var container = layoutQueue[l];
      if (!isAlive(container.node)) continue;
      var effective = directApplyAutoLayout(container.node, container.layout);
      effectiveModes[container.spec.id] = effective;
      directSizeStage(session, container.spec.id, "after-layout", container.node, "directApplyAutoLayout");
      directRestoreLayoutSize(container.node, container.spec,
        parentLayoutModes[container.spec.id] || null, session, effective);
      directSizeStage(session, container.spec.id, "after-restore-container", container.node);
    }
    // Поведение внутри родителя — после того, как сами контейнеры устоялись:
    // `layoutGrow` и `layoutAlign` считаются от размера родителя, а он к
    // этому моменту уже свой. Размер возвращается сразу за правкой: следом
    // идёт соседний ребёнок, и его раскладка стартует от верного состояния.
    //
    // На headless-двойнике этот возврат — no-op на обоих проверенных корнях:
    // там ребёнок с собственной осью раскладкой не сбивается. Он оставлен
    // как страховка от побочных эффектов настоящего редактора, которых
    // двойник не воспроизводит, и он безопасен по построению: ось HUG или
    // FILL он не трогает никогда.
    for (var c = 0; c < childQueue.length; c++) {
      var child = childQueue[c];
      if (!isAlive(child.node)) continue;
      directApplyChildLayout(child.node, directEffectiveChildLayout(child.spec, child.parentLayoutMode, session));
      // min/max are accepted by Figma only after the node has acquired its
      // auto-layout child semantics on some node types.  The early write is
      // kept for containers; this second write is the authoritative retry.
      directApplySizeBounds(child.node, child.spec.sizeBounds, session);
      directSizeStage(session, child.spec.id, "after-child-layout", child.node, "directApplyChildLayout");
      directRestoreAbsoluteChild(child.node, child.spec, specById, session);
      directRestoreLayoutSize(child.node, child.spec, child.parentLayoutMode, session,
        effectiveModes[child.spec.id]);
      directSizeStage(session, child.spec.id, "after-restore-child", child.node);
    }

    var overrideStartedAt = Date.now();
    for (var o = 0; o < instanceQueue.length; o++) {
      if (!isAlive(instanceQueue[o].node)) continue;
      session.currentInstanceAudit = instanceQueue[o].audit;
      directSizeStage(session, instanceQueue[o].spec.id, "before-occurrence-overrides", instanceQueue[o].node);
      session.sizeTraceInstanceId = directSizeTraced(session, instanceQueue[o].spec.id)
        ? instanceQueue[o].spec.id : null;
      // Сначала только proven low-level swaps: они устанавливают активный
      // definition context, по которому адресуются вложенные native values.
      // Затем native setProperties, и только после него остальные low-level
      // дельты — они остаются последним визуальным oracle.
      var rootStageBefore = session.stageTrace ? directStageSnapshot(instanceQueue[o].node) : null;
      var swapStage = await directApplyOverrides(
        instanceQueue[o].node, instanceQueue[o].overrides, session, "swaps"
      );
      directStageRecord(session, "root-after-swaps", instanceQueue[o].node, rootStageBefore, null, false);
      rootStageBefore = session.stageTrace ? directStageSnapshot(instanceQueue[o].node) : null;
      await directApplyNativePropertyValues(instanceQueue[o].node, instanceQueue[o].nativeProperties, session);
      // D54: only now can a native-owned low-level swap be classified as
      // suppressed vs fallback. Replaying it earlier is exactly what changed
      // collapsed=true SideMenu tabs into collapsed=false after a valid public
      // property assignment.
      await directApplyDeferredNativeSwapFallbacks(
        instanceQueue[o].node, instanceQueue[o].overrides,
        swapStage && swapStage.deferredNativeSwaps, session
      );
      directStageRecord(session, "root-after-native", instanceQueue[o].node, rootStageBefore, null, false);
      rootStageBefore = session.stageTrace ? directStageSnapshot(instanceQueue[o].node) : null;
      await directApplyOverrides(
        instanceQueue[o].node, instanceQueue[o].overrides, session, "rest",
        swapStage && swapStage.skipped
      );
      directStageRecord(session, "root-after-low-level", instanceQueue[o].node, rootStageBefore, null, false);
      session.sizeTraceInstanceId = null;
      directSizeStage(session, instanceQueue[o].spec.id, "after-occurrence-overrides", instanceQueue[o].node);
      session.currentInstanceAudit = null;
      // Подмена компонента переводит инстанс на размер нового мастера. Свой
      // размер вхождения выставлен раньше — до того, как подмена случилась, —
      // поэтому после неё его нужно вернуть. Иначе строка таблицы, у которой
      // подменён вложенный компонент, приезжает высотой мастера.
      var finalRestoreBefore = session.stageTrace ? directStageSnapshot(instanceQueue[o].node) : null;
      // Native setProperties/swapComponent меняют содержимое инстанса, но не
      // должны менять его слот в auto-layout родителя. На живой Figma такие
      // операции иногда сбрасывают STRETCH/grow на значения нового master,
      // что превращает source FILL в FIXED/HUG. Source childLayout —
      // авторитет именно для occurrence-slot, поэтому возвращаем его после
      // всех внутренних component mutations и только затем решаем размер.
      if (instanceQueue[o].spec.childLayout) {
        directApplyChildLayout(instanceQueue[o].node, instanceQueue[o].spec.childLayout);
      }
      directApplySizeBounds(instanceQueue[o].node, instanceQueue[o].spec.sizeBounds, session);
      directRestoreInstanceSize(instanceQueue[o].node, instanceQueue[o].spec,
        instanceQueue[o].overrides, session, parentLayoutModes[instanceQueue[o].spec.id] || null);
      directStageRecord(session, "final-restore", instanceQueue[o].node, finalRestoreBefore, {
        op: "directRestoreInstanceSize"
      }, false);
      directSizeStage(session, instanceQueue[o].spec.id, "after-final-restore", instanceQueue[o].node,
        "directRestoreInstanceSize");
      await yieldIfNeeded(slice);
    }
    session.currentInstanceAudit = null;
    // Коробки вложенных узлов — ПОСЛЕ всех правок и нативных свойств каждого
    // вхождения: только тогда живое дерево уже в итоговой семантике, и
    // решение «чья это ось» принимается по нему, а не по промежуточному шагу.
    for (var sb = 0; sb < nodes.length; sb++) {
      var boxSpec = nodes[sb];
      if (!boxSpec || boxSpec.kind !== "INSTANCE" || !boxSpec.sourceBoxes) continue;
      var boxNode = byId[boxSpec.id];
      if (!isAlive(boxNode)) continue;
      directAuditSourceBoxes(boxNode, boxSpec, session);
      await yieldIfNeeded(slice);
    }
    for (var a = 0; a < instanceAudits.length; a++) {
      directFinalizeInstanceAudit(session, instanceAudits[a]);
    }
    session.timings.overrideApplyMs += Date.now() - overrideStartedAt;

    // Bounded read-back после всех стадий chunk. Мы уже держим map узлов,
    // поэтому не делаем отдельный обход Figma-дерева: сверяем только specs
    // текущего chunk. Это ловит классы FILL→HUG, потерянные bounds и TEXT,
    // даже когда итоговая геометрия случайно ещё похожа на source.
    // FINAL SEMANTIC COMMIT. Finish every resize/native/override mutation
    // first. Commit children before parents because child FILL/HUG can trigger
    // a parent resize; the parent receives its own final state afterwards.
    for (var sc = nodes.length - 1; sc >= 0; sc--) {
      var semanticSpec = nodes[sc];
      var semanticNode = byId[semanticSpec.id];
      if (!isAlive(semanticNode)) continue;
      var semanticModes = effectiveModes[semanticSpec.id];
      var sourceModes = semanticSpec.autoLayout;
      var intentionalHugFallback = !!(semanticModes && sourceModes &&
        ((sourceModes.primaryAxisSizingMode === "AUTO" && semanticModes.primaryAxisSizingMode === "FIXED") ||
         (sourceModes.counterAxisSizingMode === "AUTO" && semanticModes.counterAxisSizingMode === "FIXED")));
      directApplySizeBounds(semanticNode, semanticSpec.sizeBounds, session);
      if (!intentionalHugFallback) {
        directReassertSemanticSizing(semanticNode, semanticSpec,
          parentLayoutModes[semanticSpec.id] || null, session);
      }
    }

    // A parent semantic commit can make live Figma rewrite the sizing of a
    // TextNode child (most visibly WIDTH_AND_HEIGHT -> HEIGHT + layoutGrow=1)
    // while resolving a HUG/min-size parent. The first pass intentionally
    // commits children before parents so parent geometry settles correctly;
    // now re-commit TEXT children once more, after every parent is final.
    // This is semantic-only: no pixel resize is performed here.
    for (var ts = 0; ts < nodes.length; ts++) {
      var textSemanticSpec = nodes[ts];
      if (!textSemanticSpec || textSemanticSpec.type !== "TEXT") continue;
      var textSemanticNode = byId[textSemanticSpec.id];
      if (!isAlive(textSemanticNode)) continue;
      directReassertSemanticSizing(textSemanticNode, textSemanticSpec,
        parentLayoutModes[textSemanticSpec.id] || null, session);
      directReassertTextOverflow(textSemanticNode, textSemanticSpec.text, session);
    }

    // Возвращаем только родительское FILL после всех семантических правок.
    for (var pf = 0; pf < nodes.length; pf++) {
      var fillSpec = nodes[pf];
      var fillNode = byId[fillSpec.id];
      if (!isAlive(fillNode)) continue;
      directReassertParentOwnedFill(fillNode, fillSpec,
        parentLayoutModes[fillSpec.id] || null, session);
    }

    // D31 uniform border normalization, per Figma individual-stroke semantics.
    for (var sr = 0; sr < nodes.length; sr++) {
      var strokeSpec = nodes[sr];
      if (!strokeSpec || typeof strokeSpec.strokeWeight !== "number" || strokeSpec.borderWeights) continue;
      var strokeNode = byId[strokeSpec.id];
      if (!isAlive(strokeNode)) continue;
      var liveStrokeWeight = directVisualRead(strokeNode, "strokeWeight");
      if (liveStrokeWeight === figma.mixed || !directVisualNumberEqual(strokeSpec.strokeWeight, liveStrokeWeight, 0.0005)) {
        if (directSet(strokeNode, "strokeWeight", strokeSpec.strokeWeight)) session.totals.uniformStrokeWeightsReasserted = (session.totals.uniformStrokeWeightsReasserted || 0) + 1;
        else directNote(session, "UNIFORM_STROKE_REASSERT_REJECTED");
      }
    }

    // FINAL SOURCE-PLACEMENT COMMIT. Parent semantic sizing can re-run Figma
    // constraints and move *any* free-positioned child, not only an ABSOLUTE
    // child of auto-layout. This is especially visible for sidebars/navigation
    // rails: their parent is usually layoutMode NONE, so x/y is source-owned,
    // but a late parent resize can still apply LEFT/RIGHT/CENTER constraints.
    //
    // Geometry has exactly one owner:
    //   - flow child of HORIZONTAL/VERTICAL parent -> Figma auto-layout owns XY;
    //   - ABSOLUTE child of auto-layout -> source transform owns XY;
    //   - child of a non-auto-layout parent -> source transform owns XY.
    // Re-commit only source-owned placement after every sizing/layout mutation.
    // This avoids offsets without hard-coded coordinates and does not add any
    // tree walks beyond the final O(n) pass that already existed.
    for (var ap = 0; ap < nodes.length; ap++) {
      var placementSpec = nodes[ap];
      if (!placementSpec || !placementSpec.parent) continue;
      var sourceParentMode = parentLayoutModes[placementSpec.id] || null;
      var parentIsAutoLayout = sourceParentMode === "HORIZONTAL" || sourceParentMode === "VERTICAL";
      var isAbsoluteInAutoLayout = !!(placementSpec.childLayout &&
        placementSpec.childLayout.layoutPositioning === "ABSOLUTE");
      if (parentIsAutoLayout && !isAbsoluteInAutoLayout) continue;

      var placementNode = byId[placementSpec.id];
      if (!isAlive(placementNode)) continue;
      // Boolean operands use nearest-container coordinates in Figma; the helper
      // already performs that conversion. For every other free child it restores
      // the exact source relativeTransform (or source x/y fallback).
      var booleanPlacement = directBooleanAwarePlacement(placementSpec, specById);
      if (booleanPlacement) {
        directSet(placementNode, "relativeTransform", booleanPlacement);
      } else if (placementSpec.relativeTransform && placementSpec.relativeTransform.length === 2) {
        directSet(placementNode, "relativeTransform", placementSpec.relativeTransform);
      } else {
        var px = Number(placementSpec.x); if (!isFinite(px)) px = 0;
        var py = Number(placementSpec.y); if (!isFinite(py)) py = 0;
        if (typeof placementSpec.rotation === "number" && Math.abs(placementSpec.rotation) > 1e-7) {
          directSet(placementNode, "x", px);
          directSet(placementNode, "y", py);
          directSet(placementNode, "rotation", placementSpec.rotation);
        } else {
          directSet(placementNode, "relativeTransform", [[1, 0, px], [0, 1, py]]);
        }
      }
      directSizeStage(session, placementSpec.id, "after-final-source-placement", placementNode,
        "directFinalSourcePlacement");
    }

    // FINAL TEXT-OVERFLOW COMMIT. Placement and parent auto-layout writes can
    // rematerialize/reflow TextNode descendants in live Figma and clear
    // textTruncation/maxLines. Overflow is therefore the last text writer,
    // after every sizing and placement mutation.
    for (var ft = 0; ft < nodes.length; ft++) {
      var finalTextSpec = nodes[ft];
      if (!finalTextSpec || finalTextSpec.type !== "TEXT" || !finalTextSpec.text) continue;
      var finalTextNode = byId[finalTextSpec.id];
      if (!isAlive(finalTextNode)) continue;
      directReassertTextOverflow(finalTextNode, finalTextSpec.text, session);
    }

    // FINAL RESOLVED-VISIBILITY COMMIT. Native component properties, swaps and
    // late layout reconciliation are allowed to materialize/rebuild instance
    // descendants. Pixso's occurrence override stream is the resolved visual
    // state, so an explicit visibility value must be the last writer after all
    // structural/native mutations. This is deliberately a bounded replay over
    // existing visibility override records only (no tree traversal).
    //
    // BOOLEAN component properties are still transported through setProperties
    // above; this pass does not replace that semantic link. It only restores the
    // resolved occurrence state when Pixso also carries an explicit low-level
    // visibility delta. For destructive false we require exact target identity
    // (or the occurrence root itself), so a stale/index-only path can never hide
    // an unrelated sibling.
    for (var vc = 0; vc < instanceQueue.length; vc++) {
      var visibilityRoot = instanceQueue[vc].node;
      if (!isAlive(visibilityRoot)) continue;
      var visibilityOverrides = instanceQueue[vc].overrides || [];
      for (var vo = 0; vo < visibilityOverrides.length; vo++) {
        var visibilityEntry = visibilityOverrides[vo];
        if (!directOpExplicit(visibilityEntry, "visible")) continue;
        var resolvedVisible = visibilityEntry.ops && visibilityEntry.ops.visible;
        if (typeof resolvedVisible !== "boolean") continue;
        var visibilityResolution = directResolveTarget(visibilityRoot, visibilityEntry.path || [], session);
        var visibilityTarget = visibilityResolution.target;
        if (!visibilityTarget) continue;
        var rootVisibility = !(visibilityEntry.path && visibilityEntry.path.length);
        if (resolvedVisible === false && !rootVisibility && !visibilityResolution.targetIdentityProven) {
          session.totals.finalResolvedVisibilityRejectedUnproven =
            (session.totals.finalResolvedVisibilityRejectedUnproven || 0) + 1;
          continue;
        }
        var liveVisible = directVisualRead(visibilityTarget, "visible");
        if (liveVisible === resolvedVisible) continue;
        if (directSet(visibilityTarget, "visible", resolvedVisible)) {
          session.totals.finalResolvedVisibilityRestored =
            (session.totals.finalResolvedVisibilityRestored || 0) + 1;
        } else {
          session.totals.finalResolvedVisibilityRejected =
            (session.totals.finalResolvedVisibilityRejected || 0) + 1;
          directNote(session, "FINAL_RESOLVED_VISIBILITY_REJECTED");
        }
      }
    }

    // D40 final occurrence-name commit. createInstance/swapComponent/
    // setProperties are allowed to change component internals, but the layer
    // name of the occurrence belongs to the occurrence itself. Pixso's
    // technical `Instance N` raw names were already normalized in MigrationIR.
    for (var nr = 0; nr < nodes.length; nr++) {
      var nameSpec = nodes[nr];
      if (!nameSpec || nameSpec.kind !== "INSTANCE") continue;
      var nameNode = byId[nameSpec.id];
      if (!isAlive(nameNode)) continue;
      var actualOccurrenceName = null;
      try { actualOccurrenceName = nameNode.name; } catch (_eOccurrenceName) {}
      if (actualOccurrenceName !== nameSpec.name) {
        session.instanceNameParity.mismatches += 1;
        if (session.instanceNameParity.samples.length < session.instanceNameParity.limit) {
          session.instanceNameParity.samples.push({
            occurrenceId: nameSpec.id, expected: nameSpec.name || null, actual: actualOccurrenceName,
            rawSourceName: nameSpec.rawSourceOccurrenceName || null,
            nameSource: nameSpec.occurrenceNameSource || null
          });
        }
        if (directSet(nameNode, "name", nameSpec.name || "Instance")) {
          session.instanceNameParity.restored += 1;
        } else {
          directNote(session, "INSTANCE_SOURCE_NAME_RESTORE_REJECTED");
        }
      }
    }

    // Exposed nested instances are definition semantics. Apply them only
    // after the whole primary component subtree is materialized and after its
    // COMPONENT_SET membership is final, but before any external occurrence
    // can be created from this definition. Figma inherits exposure through
    // nested INSTANCE descendants automatically; only primary instances are
    // writable here.
    function directExposureRejectSample(exposure, reason, error) {
      if (!session.exposedInstanceRejectSamples || session.exposedInstanceRejectSamples.length >= 40) return;
      var definitionId = null;
      try {
        definitionId = options.rootNode && options.rootNode.getPluginData
          ? options.rootNode.getPluginData("pixsoDirectDefinitionId") || null : null;
      } catch (_eExposureDefinition) {}
      session.exposedInstanceRejectSamples.push({
        sourceId: exposure && exposure.spec ? exposure.spec.id || null : null,
        definitionId: definitionId,
        nodeId: exposure && exposure.node ? nodeIdentity(exposure.node) || null : null,
        reason: reason || "EXPOSED_INSTANCE_REJECTED",
        message: error && error.message ? String(error.message).slice(0, 240) : null,
      });
    }

    for (var ex = 0; ex < exposureQueue.length; ex++) {
      var exposure = exposureQueue[ex];
      if (!isAlive(exposure.node) || nodeType(exposure.node) !== "INSTANCE") {
        session.totals.exposedInstancesRejected += 1;
        directExposureRejectSample(exposure, "NODE_NOT_LIVE_INSTANCE", null);
        continue;
      }
      try {
        exposure.node.isExposedInstance = true;
        if (exposure.node.isExposedInstance === true) session.totals.exposedInstancesApplied += 1;
        else {
          session.totals.exposedInstancesRejected += 1;
          directExposureRejectSample(exposure, "WRITE_NOT_PERSISTED", null);
        }
      } catch (_eExpose) {
        session.totals.exposedInstancesRejected += 1;
        directExposureRejectSample(exposure, "HOST_WRITE_REJECTED", _eExpose);
        directNote(session, "EXPOSED_INSTANCE_REJECTED");
      }
    }
    // D52. Read-back читается ТАМ, ГДЕ ЖИВЁТ ФЛАГ, — на самих узлах.
    //
    // Прежняя редакция читала `options.rootNode.exposedInstances`. По
    // публичному Figma Plugin API `exposedInstances` — свойство InstanceNode,
    // а `rootNode` здесь COMPONENT: getter отдавал не массив, `Array.isArray`
    // не проходил, исключения тоже не было. Поэтому в прогоне 08:53 стояло
    // `exposedInstancesVerified: 0` при `Applied: 138` — ноль подставленный,
    // а не измеренный.
    //
    // Писуемое и читаемое свойство узла — `isExposedInstance`. Перечитываем
    // его отдельным проходом ПОСЛЕ всей очереди: это и ловит запись, принятую
    // синтаксически, но потерянную при переносе компонента в COMPONENT_SET.
    if (exposureQueue.length) {
      for (var ev = 0; ev < exposureQueue.length; ev++) {
        var verifyNode = exposureQueue[ev].node;
        var verified = false;
        if (isAlive(verifyNode) && nodeType(verifyNode) === "INSTANCE") {
          try { verified = verifyNode.isExposedInstance === true; }
          catch (_eExposedReadback) {
            verified = false;
            directNote(session, "EXPOSED_INSTANCES_READBACK_UNAVAILABLE");
            directExposureRejectSample(exposureQueue[ev], "READBACK_UNAVAILABLE", _eExposedReadback);
            continue;
          }
        }
        if (verified) {
          session.totals.exposedInstancesVerified += 1;
        } else {
          session.totals.exposedInstancesVerificationMissed += 1;
          directExposureRejectSample(exposureQueue[ev], "READBACK_MISSING", null);
        }
      }
    }

    // D59. The source text stream gets the final mutation slot. Native-owned
    // TEXT properties remain authoritative and are skipped above; everything
    // else is an explicit serialized Pixso value re-resolved against the final
    // post-swap/post-layout occurrence tree.
    for (var ft = 0; ft < instanceQueue.length; ft++) {
      if (!isAlive(instanceQueue[ft].node)) continue;
      await directReassertExplicitTextOverrides(instanceQueue[ft].node,
        instanceQueue[ft].overrides || [], session);
    }

    // Read-only parity pass. Audit must never mutate the state it measures.
    for (var pa = 0; pa < nodes.length; pa++) {
      var paritySpec = nodes[pa];
      var parityNode = byId[paritySpec.id];
      if (!isAlive(parityNode)) continue;
      directAuditLayoutTextNode(parityNode, paritySpec,
        parentLayoutModes[paritySpec.id] || null, session, "chunk-final",
        effectiveModes[paritySpec.id]);
      directAuditVisualNode(parityNode, paritySpec, specById, session);
      directAuditMaterializedInstance(parityNode, paritySpec, session);
    }
    // Re-read public component-property effects only after every low-level
    // override/layout/style pass has completed. Immediate setProperties
    // verification can succeed and still be invalidated by later nested
    // materialization; this is the class behind wrong bell/visibility/text
    // states that D29 could not observe.
    for (var np = 0; np < instanceQueue.length; np++) {
      if (!isAlive(instanceQueue[np].node)) continue;
      await directAuditFinalNativeProperties(instanceQueue[np].node,
        instanceQueue[np].nativeProperties || [], session, instanceQueue[np].spec);
    }
    for (var mp = 0; mp < instanceAudits.length; mp++) {
      if (!isAlive(instanceAudits[mp].node)) continue;
      await directAuditFinalMainComponent(instanceAudits[mp].node, instanceAudits[mp].spec, session);
    }

    if (session.sizeTrace) {
      for (var f = 0; f < nodes.length; f++) {
        if (!directSizeTraced(session, nodes[f].id)) continue;
        directSizeStage(session, nodes[f].id, "final", byId[nodes[f].id]);
      }
    }
    return byId;
  }

  /**
   * Возвращает вхождению его собственный размер после того, как правки
   * вхождения его сбили.
   *
   * Сбивают его две разные вещи, и обе приходят ПОСЛЕ раскладки:
   *
   *   — подмена компонента переводит инстанс на размер нового мастера;
   *   — правка собственной раскладки вхождения (`layout` / `childLayout`)
   *     меняет хозяина оси: `primaryAxisSizingMode: FIXED` в записи означает,
   *     что ось, которая до сих пор обнимала содержимое мастера, стала
   *     принадлежать вхождению — и её размер обязан вернуться исходным.
   *
   * Восстановление осевое: ось, оставшаяся HUG или FILL, принадлежит
   * раскладке, и её пиксели возвращать нельзя — это подменило бы семантику
   * визуальным совпадением.
   */
  /** Узлы, чей габарит выводится из детей: их коробку не задают, её считают. */
  var DIRECT_SOURCE_BOX_DERIVED_TYPES = { GROUP: true, BOOLEAN_OPERATION: true };
  var DIRECT_SOURCE_BOX_EPSILON = 0.5;

  function directSourceBoxCount(session, key) {
    session.totals[key] = (session.totals[key] || 0) + 1;
  }

  /**
   * Возвращает вложенным узлам вхождения их итоговые коробки из Pixso — по
   * тем и только тем осям, которые в ЖИВОМ итоговом дереве FIXED.
   *
   * Зачем. Правки вхождения описывают конечное состояние, а приёмник
   * применяет их по одной. Промежуточное состояние может быть циклом
   * раскладки, которого в источнике не было: корень уже HUG, а ребёнок ещё
   * STRETCH. Figma схлопывает такую ось в ноль, и когда следующая правка
   * снимает STRETCH, фиксированная ширина ребёнка остаётся схлопнутой —
   * вместе со всем, что заполняет его (текст переносится по букве). Число,
   * которое у этого узла получилось в Pixso, лежит в `derivedSymbolData`.
   *
   * Чего это НЕ делает. Ось HUG и ось FILL принадлежат раскладке, и их
   * пиксели не возвращаются никогда: иначе адаптивный компонент превратился
   * бы в физический размер. Владение оси не выводится из числа — оно читается
   * с живого узла ПОСЛЕ всех правок. Цель принимается только при полностью
   * доказанной идентичности каждого шага пути; иначе запись пропускается.
   */
  function directSourceBoxLive(node, parentMode) {
    var out = { type: nodeType(node) };
    ["width", "height", "layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode",
      "layoutGrow", "layoutAlign", "layoutPositioning", "textAutoResize"].forEach(function (field) {
      try {
        var value = node[field];
        if (value !== undefined && typeof value !== "object" && typeof value !== "function") {
          out[field] = typeof value === "number" ? directSizeNumber(value) : value;
        }
      } catch (_eLive) {}
    });
    out.widthSizing = directAxisSizingFromNode(node, parentMode, "width");
    out.heightSizing = directAxisSizingFromNode(node, parentMode, "height");
    return out;
  }

  /**
   * Ограниченная выборка самых грубых расхождений. Хранятся худшие по доле
   * расхождения, не больше двух на вхождение: иначе одно массово
   * повторённое вхождение вытеснило бы все остальные классы.
   */
  function directSourceBoxSample(session, instance, box, target, parentMode, decision, score) {
    var trace = session.sourceBoxTrace;
    if (!trace) trace = session.sourceBoxTrace = { samples: [], limit: 80, perInstance: Object.create(null) };
    var instanceId = directSourceId(instance) || null;
    var key = String(instanceId);
    if ((trace.perInstance[key] || 0) >= 2) return;
    if (trace.samples.length >= trace.limit) {
      var weakest = 0;
      for (var i = 1; i < trace.samples.length; i++) {
        if (trace.samples[i].score < trace.samples[weakest].score) weakest = i;
      }
      if (trace.samples[weakest].score >= score) return;
      var evicted = trace.samples.splice(weakest, 1)[0];
      trace.perInstance[String(evicted.instanceSourceId)] -= 1;
    }
    var parent = null;
    try { parent = target.parent; } catch (_eParent) {}
    trace.perInstance[key] = (trace.perInstance[key] || 0) + 1;
    trace.samples.push({
      score: directSizeNumber(score),
      instanceSourceId: instanceId,
      path: box.path.map(function (step) { return step && step.sourceId || null; }),
      decision: decision,
      probe: box.__probe || null,
      source: { width: directSizeNumber(box.width), height: directSizeNumber(box.height), sizing: box.sizing || null },
      live: directSourceBoxLive(target, parentMode),
      parent: parent ? directSourceBoxLive(parent, null) : null,
      instance: directSourceBoxLive(instance, null),
    });
  }

  function directAuditSourceBoxes(instance, spec, session) {
    var boxes = spec && spec.sourceBoxes;
    if (!boxes || !boxes.length || !isAlive(instance)) return;
    if (directDegradedInfo(session, instance)) return;
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      directSourceBoxCount(session, "sourceBoxesSeen");
      if (!box || !box.path || !box.path.length ||
          typeof box.width !== "number" || typeof box.height !== "number" ||
          !isFinite(box.width) || !isFinite(box.height) || box.width < 0 || box.height < 0) {
        directSourceBoxCount(session, "sourceBoxesInvalid");
        continue;
      }
      var resolution = directResolveTarget(instance, box.path, session, { noMetrics: true });
      var target = resolution && resolution.target;
      if (!target || target === instance || !isAlive(target) ||
          resolution.unverifiedSteps || resolution.identityUnprovenSteps) {
        directSourceBoxCount(session, "sourceBoxesUnresolved");
        continue;
      }
      if (DIRECT_SOURCE_BOX_DERIVED_TYPES[nodeType(target)]) {
        directSourceBoxCount(session, "sourceBoxesSkippedType");
        continue;
      }
      var hidden = false;
      try { hidden = target.visible === false; } catch (_eVisible) {}
      if (hidden) {
        directSourceBoxCount(session, "sourceBoxesSkippedHidden");
        continue;
      }
      var parentMode = null;
      try { parentMode = target.parent && target.parent.layoutMode; } catch (_eParentMode) {}
      if (parentMode !== "HORIZONTAL" && parentMode !== "VERTICAL") parentMode = null;
      var ownWidth = directAxisSizingFromNode(target, parentMode, "width") === "FIXED";
      var ownHeight = directAxisSizingFromNode(target, parentMode, "height") === "FIXED";
      var currentWidth = null, currentHeight = null;
      try { currentWidth = target.width; currentHeight = target.height; } catch (_eBox) {}
      if (typeof currentWidth !== "number" || typeof currentHeight !== "number") {
        directSourceBoxCount(session, "sourceBoxesUnresolved");
        continue;
      }
      var diverges = Math.abs(currentWidth - box.width) > DIRECT_SOURCE_BOX_EPSILON ||
        Math.abs(currentHeight - box.height) > DIRECT_SOURCE_BOX_EPSILON;
      if (!diverges) directSourceBoxCount(session, "sourceBoxesAlreadyMatching");
      else directSourceBoxCount(session, "sourceBoxesDiagnosticMismatch");
      // Probe v10: запись размера вложенному слою игнорируется всеми
      // публичными способами. sourceBoxes теперь только читает и считает;
      // решение AS_IS/TRANSLATE/FRAMES уже принял producer.
      directSourceBoxAudit(session, instance, box, target, parentMode,
        diverges ? "diagnostic-mismatch" : "matching");
    }
  }

  /**
   * Выборка расхождений, которые коробка источника НЕ вылечила: размер после
   * всех решений отличается от Pixso заметно. Только такие случаи и нужны
   * живому логу — совпавшие и штатно пересчитанные раскладкой не пишутся.
   */
  function directSourceBoxAudit(session, instance, box, target, parentMode, decision) {
    var width = null, height = null;
    try { width = target.width; height = target.height; } catch (_eAuditBox) { return; }
    var dw = Math.abs(width - box.width), dh = Math.abs(height - box.height);
    if (dw <= 1 && dh <= 1) return;
    directSourceBoxCount(session, "sourceBoxesStillDiverging");
    // В выборку — только грубые расхождения: метрики шрифта дают пиксели,
    // схлопнутая ось — десятки процентов.
    var gross = (dw > 4 && dw > box.width * 0.2) || (dh > 4 && dh > box.height * 0.2);
    if (!gross) return;
    var score = Math.max(box.width > 0 ? dw / box.width : 0, box.height > 0 ? dh / box.height : 0);
    directSourceBoxSample(session, instance, box, target, parentMode, decision, score);
  }

  function directRestoreInstanceSize(node, spec, overrides, session, parentLayoutMode) {
    if (!spec || typeof spec.width !== "number" || typeof spec.height !== "number") return;
    var touched = false;
    for (var i = 0; i < overrides.length; i++) {
      var ops = overrides[i].ops;
      if (!ops || overrides[i].path && overrides[i].path.length) {
        if (ops && ops.swapDefinitionId !== undefined) { touched = true; break; }
        continue;
      }
      if (ops.swapDefinitionId !== undefined || ops.layout || ops.childLayout || ops.sizeBounds) {
        touched = true;
        break;
      }
    }
    if (!touched) return;
    directRestoreLayoutSize(node, spec, parentLayoutMode || null, session);
  }

  // ===========================================================================
  // Жизненный цикл определения.
  //
  // Раньше вхождение, для которого определение недоступно, давало один общий
  // код `DEFINITION_MISSING`, а его пустой placeholder уезжал в
  // `ordinaryNodesCreated`. Причина при этом терялась: «в реестре нет записи»,
  // «запись есть, но узел мёртв» и «узел не того типа» лечатся по-разному, а
  // считались одинаково. Ниже — единственная точка, которая отвечает на
  // вопрос «почему определение недоступно» и делает это честно: то, что
  // прочитать не удалось, остаётся неизвестным, а не назначается причиной.
  // ===========================================================================

  /** Подпричины `INSTANCE_DEFINITION_UNAVAILABLE`. Порядок — от точного к общему. */
  var DEFINITION_UNAVAILABLE = {
    NOT_REGISTERED: "DEFINITION_NOT_REGISTERED",
    NODE_REMOVED: "DEFINITION_NODE_REMOVED",
    NODE_DETACHED: "DEFINITION_NODE_DETACHED",
    NODE_INACCESSIBLE: "DEFINITION_NODE_INACCESSIBLE",
    WRONG_NODE_TYPE: "DEFINITION_WRONG_NODE_TYPE",
    CREATE_INSTANCE_FAILED: "DEFINITION_CREATE_INSTANCE_FAILED",
    UNKNOWN: "DEFINITION_STATE_UNKNOWN",
  };

  /**
   * Состояние закешированного определения БЕЗ побочных эффектов.
   *
   * Каждое чтение отдельное: под `documentAccess: "dynamic-page"` часть
   * свойств узла бросает, и одно общее try/catch превратило бы любую такую
   * ошибку в «узел удалён». Неизвестное обязано остаться неизвестным.
   */
  function directDefinitionState(session, definitionId) {
    var state = {
      definitionId: definitionId || null,
      registered: false,
      component: null,
      removed: null,
      hasParent: null,
      type: null,
      available: false,
      subreason: DEFINITION_UNAVAILABLE.UNKNOWN,
    };
    if (!definitionId) {
      state.subreason = DEFINITION_UNAVAILABLE.NOT_REGISTERED;
      return state;
    }
    var component = session.definitions[definitionId];
    if (!component) {
      state.subreason = DEFINITION_UNAVAILABLE.NOT_REGISTERED;
      return state;
    }
    state.registered = true;
    state.component = component;

    var readFailed = false;
    try { state.removed = !!component.removed; } catch (_eRemoved) { readFailed = true; }
    try { state.hasParent = !!component.parent; } catch (_eParent) { readFailed = true; }
    try { state.type = component.type || null; } catch (_eType) { readFailed = true; }

    if (state.removed === true) { state.subreason = DEFINITION_UNAVAILABLE.NODE_REMOVED; return state; }
    if (readFailed) { state.subreason = DEFINITION_UNAVAILABLE.NODE_INACCESSIBLE; return state; }
    if (state.hasParent === false) { state.subreason = DEFINITION_UNAVAILABLE.NODE_DETACHED; return state; }
    // Тип проверяется только когда он прочитан: молчание хоста — не улика.
    if (state.type !== null && state.type !== "COMPONENT") {
      state.subreason = DEFINITION_UNAVAILABLE.WRONG_NODE_TYPE;
      return state;
    }
    if (typeof component.createInstance !== "function") {
      state.subreason = DEFINITION_UNAVAILABLE.WRONG_NODE_TYPE;
      return state;
    }
    state.available = true;
    state.subreason = null;
    return state;
  }

  /**
   * Один ограниченный след жизни определения для доказательства причины.
   *
   * Собирается ТОЛЬКО на неудачном обращении (или по явному trace-режиму), не
   * более одной записи на definitionId и не больше лимита на сессию: успешные
   * вхождения диагностику не оплачивают. Любое чтение здесь — диагностика, и
   * упасть она права не имеет.
   */
  async function directTraceDefinition(session, definitionId, state, occurrenceId) {
    var trace = session.definitionTrace;
    if (!trace) return null;
    if (trace.records.length >= trace.limit) return null;
    if (trace.seen[definitionId]) return null;
    trace.seen[definitionId] = true;

    var record = {
      definitionId: definitionId || null,
      // Вхождение, на котором определение впервые не нашлось. Причина
      // живёт на определении, а доказательство предъявляется на конкретном
      // узле источника: без него запись невозможно сопоставить с документом.
      occurrenceId: occurrenceId || null,
      registered: !!(state && state.registered),
      subreason: state ? state.subreason : DEFINITION_UNAVAILABLE.UNKNOWN,
      cachedRefUsable: !!(state && state.available),
      cachedRemoved: state ? state.removed : null,
      cachedHasParent: state ? state.hasParent : null,
      cachedType: state ? state.type : null,
      storedNodeId: null,
      registrationPageId: null,
      registrationPageName: null,
      registrationChunk: null,
      registrationSequence: null,
      rootsSinceCreation: null,
      chunksSinceCreation: null,
      currentPageId: null,
      servicePageAlive: null,
      servicePageId: null,
      // H1: живой узел по сохранённому id при мёртвой ссылке в кеше.
      asyncLookup: "NOT_ATTEMPTED",
      asyncNodeType: null,
      asyncNodeRemoved: null,
      asyncNodeHasParent: null,
    };

    var entry = session.definitionRegistry[definitionId] || null;
    if (entry) {
      record.storedNodeId = entry.nodeId || null;
      record.registrationPageId = entry.pageId || null;
      record.registrationPageName = entry.pageName || null;
      record.registrationChunk = entry.chunkIndex;
      record.registrationSequence = entry.sequence;
      record.rootsSinceCreation = session.totals.roots - entry.rootsAtCreation;
      record.chunksSinceCreation = session.definitionChunks - entry.chunkIndex;
      record.acknowledgedAtRegistration = !!entry.acknowledged;
    }
    try {
      var current = figma.currentPage;
      record.currentPageId = current && current.id ? String(current.id) : null;
    } catch (_eCurrent) { record.currentPageId = null; }
    var servicePage = session.registry && session.registry.directPage;
    record.servicePageAlive = servicePage ? isPageAlive(servicePage) : null;
    try {
      record.servicePageId = servicePage && servicePage.id ? String(servicePage.id) : null;
    } catch (_eServiceId) { record.servicePageId = null; }

    // Ключевое различение H1 и H3: ссылка в кеше мертва, а узел по
    // сохранённому id жив — значит терялась именно ССЫЛКА, а не компонент.
    if (record.storedNodeId && typeof figma.getNodeByIdAsync === "function") {
      try {
        var found = await figma.getNodeByIdAsync(record.storedNodeId);
        if (!found) {
          record.asyncLookup = "NULL";
        } else {
          record.asyncLookup = "FOUND";
          try { record.asyncNodeType = found.type || null; } catch (_eAsyncType) {}
          try { record.asyncNodeRemoved = !!found.removed; } catch (_eAsyncRemoved) {}
          try { record.asyncNodeHasParent = !!found.parent; } catch (_eAsyncParent) {}
        }
      } catch (_eAsync) { record.asyncLookup = "THREW"; }
    } else if (!record.storedNodeId) {
      record.asyncLookup = "NO_STORED_NODE_ID";
    } else {
      record.asyncLookup = "API_UNAVAILABLE";
    }

    trace.records.push(record);
    return record;
  }

  /**
   * Помечает placeholder причинной деградацией.
   *
   * Метка живёт и на узле (её видно в документе), и в сессии: подслой
   * placeholder-а не обязан отдавать plugin data в любом контексте, а
   * дальнейшие промахи под ним обязаны сохранить причину и НЕ попадать в
   * обычные счётчики адресации.
   */
  function directMarkDegraded(session, node, definitionId, subreason) {
    setPluginData(node, "pixsoDirectFallback", "INSTANCE_DEFINITION_UNAVAILABLE");
    setPluginData(node, "pixsoDirectFallbackReason", subreason || DEFINITION_UNAVAILABLE.UNKNOWN);
    if (definitionId) setPluginData(node, "pixsoDirectDefinitionId", String(definitionId));
    var identity = nodeIdentity(node);
    if (identity) {
      session.degradedInstances[identity] = {
        definitionId: definitionId || null,
        subreason: subreason || DEFINITION_UNAVAILABLE.UNKNOWN,
      };
    }
  }

  /** Деградировано ли вхождение из-за недоступного определения. */
  function directDegradedInfo(session, node) {
    if (!node) return null;
    var identity = nodeIdentity(node);
    if (identity && session.degradedInstances[identity]) return session.degradedInstances[identity];
    try {
      if (typeof node.getPluginData !== "function") return null;
      if (node.getPluginData("pixsoDirectFallback") !== "INSTANCE_DEFINITION_UNAVAILABLE") return null;
      return {
        definitionId: node.getPluginData("pixsoDirectDefinitionId") || null,
        subreason: node.getPluginData("pixsoDirectFallbackReason") || DEFINITION_UNAVAILABLE.UNKNOWN,
      };
    } catch (_e) { return null; }
  }

  function directCountDefinitionUnavailable(session, definitionId, subreason) {
    var code = subreason || DEFINITION_UNAVAILABLE.UNKNOWN;
    session.totals.instanceDefinitionUnavailable += 1;
    session.definitionUnavailableByReason[code] =
      (session.definitionUnavailableByReason[code] || 0) + 1;
    // Причинный код, а не общий «определение не доехало»: downstream промахи
    // под placeholder-ом обязаны читаться как следствие, а не как адресация.
    directNote(session, "INSTANCE_DEFINITION_UNAVAILABLE");
    if (session.definitionUnavailableSamples.length < 20) {
      session.definitionUnavailableSamples.push({
        definitionId: definitionId || null,
        subreason: code,
        storedNodeId: (session.definitionRegistry[definitionId] || {}).nodeId || null,
        definitionPageId: (session.definitionRegistry[definitionId] || {}).pageId || null,
        registryPresent: !!session.definitionRegistry[definitionId],
      });
    }
  }

  async function directCreateInstance(spec, session) {
    var state = directDefinitionState(session, spec.definitionId);
    if (!state.available) {
      // Определение недоступно: вхождение не выдумывается, а становится
      // помеченным пустым контейнером с ПРИЧИНОЙ этой деградации.
      await directTraceDefinition(session, spec.definitionId, state, spec.id);
      directCountDefinitionUnavailable(session, spec.definitionId, state.subreason);
      var placeholder = figma.createFrame();
      session.totals.placeholderFramesCreated += 1;
      directMarkDegraded(session, placeholder, spec.definitionId, state.subreason);
      directReconcileFailedInstance(session, spec, "INSTANCE_DEFINITION_UNAVAILABLE", { subreason: state.subreason });
      return placeholder;
    }
    var startedAt = Date.now();
    var instance;
    try { instance = state.component.createInstance(); }
    catch (_eInstance) {
      // Отказ createInstance — та же причинная семья: определение есть, но
      // вхождением стать не может. Считается как подпричина, а не как
      // отдельная безымянная потеря.
      await directTraceDefinition(session, spec.definitionId, {
        registered: true,
        available: false,
        subreason: DEFINITION_UNAVAILABLE.CREATE_INSTANCE_FAILED,
        removed: state.removed, hasParent: state.hasParent, type: state.type,
      }, spec.id);
      directCountDefinitionUnavailable(session, spec.definitionId,
        DEFINITION_UNAVAILABLE.CREATE_INSTANCE_FAILED);
      var failedPlaceholder = figma.createFrame();
      session.totals.placeholderFramesCreated += 1;
      directMarkDegraded(session, failedPlaceholder, spec.definitionId,
        DEFINITION_UNAVAILABLE.CREATE_INSTANCE_FAILED);
      directReconcileFailedInstance(session, spec, "CREATE_INSTANCE_FAILED", {
        subreason: DEFINITION_UNAVAILABLE.CREATE_INSTANCE_FAILED,
      });
      return failedPlaceholder;
    }
    session.timings.instanceCreateMs += Date.now() - startedAt;
    session.totals.instancesCreated += 1;
    directReconcileCreatedInstance(session, spec);
    // Отпечаток активного определения. Без него проверка контекста адреса
    // опирается на `mainComponent`, который под dynamic-page недоступен.
    setPluginData(instance, "pixsoDirectDefinitionId", spec.definitionId);
    if (session.componentIdentityLedger &&
        session.componentIdentityLedger.occurrences.length < session.componentIdentityLedger.limit) {
      session.componentIdentityLedger.occurrences.push({
        occurrenceId: spec.id || null,
        occurrenceName: spec.name || null,
        rawSourceName: spec.rawSourceOccurrenceName || null,
        nameSource: spec.occurrenceNameSource || null,
        sourceDefinitionId: spec.definitionId || null,
        finalInstanceId: nodeIdentity(instance) || null
      });
    }
    // Ограниченная выборка вхождений, чьё определение — участник семейства
    // вариантов. Держится ради ОДНОГО утверждения, которое иначе доказать
    // нечем: выбранный по `symbolData.symbolID` участник и есть мастер
    // созданного инстанса, и он остаётся им после объединения в набор.
    // Выборка ограничена и собирается только для таких определений.
    if (session.variantGroups[directVariantGroupOfDefinition(session, spec.definitionId)] &&
        session.variantInstanceSamples.length < VARIANT_SAMPLE_LIMIT) {
      session.variantInstanceSamples.push({
        definitionId: spec.definitionId,
        occurrenceId: spec.id || null,
        node: instance,
      });
    }
    return instance;
  }

  /**
   * Дельта Pixso поверх нативного инстанса.
   *
   * Адрес цели — индексный путь из канонического дерева определения, имя лишь
   * проверяет уже найденный узел. Неоднозначный адрес — это промах, который
   * считается, а не выбор наугад.
   */
  function directSourceId(node) {
    try {
      return node && typeof node.getPluginData === "function"
        ? node.getPluginData("pixsoDirectSourceId") || null
        : null;
    } catch (_e) { return null; }
  }

  /**
   * Активное определение узла — то, дельту которого он показывает сейчас.
   *
   * Читается ТОЛЬКО собственный отпечаток узла. Синхронный getter
   * `mainComponent` для этого не годится: манифест приёмника объявляет
   * `documentAccess: "dynamic-page"`, а под ним этот getter бросает. Обёрнутый
   * в try/catch, он превращал проверку контекста в мёртвый код — на реальном
   * файле `activeDefinitionId` был null во ВСЕХ промахах, то есть шлюз
   * «правка чужого определения» не срабатывал ни разу, и такая правка
   * ловилась лишь случайным несовпадением типа узла.
   *
   * Отпечаток ставит только этот приёмник: при создании инстанса и при
   * подмене компонента. Чужим он быть не может, а отсутствие отпечатка
   * (подслой инстанса отдаёт plugin data не в каждом контексте) означает
   * «контекст не доказан» — шаг проверяется остальными доказательствами.
   */
  function directDefinitionId(node, session) {
    if (!node) return null;
    // Подмена компонента могла случиться на подслое инстанса, куда запись
    // plugin data хостом не гарантирована. Результат подмены известен этой
    // сессии точно, и он старше отпечатка.
    if (session && session.swappedDefinitions) {
      var swapped = session.swappedDefinitions[nodeIdentity(node)];
      if (swapped) return swapped;
    }
    try {
      if (typeof node.getPluginData !== "function") return null;
      return node.getPluginData("pixsoDirectDefinitionId") || null;
    } catch (_e) { return null; }
  }

  /** Идентификатор узла хоста. Пустая строка означает «сравнивать нечем». */
  function nodeIdentity(node) {
    try { return node && node.id ? String(node.id) : ""; } catch (_e) { return ""; }
  }

  function directMarkUnsafe(session, reason, count) {
    if (!session.currentInstanceAudit) return;
    var amount = count || 1;
    session.currentInstanceAudit.reasons[reason] =
      (session.currentInstanceAudit.reasons[reason] || 0) + amount;
  }

  function directStructuralEntry(session, step) {
    if (!step || !step.definitionId || !Array.isArray(step.definitionPath)) return null;
    var map = session.definitionStructuralMaps[step.definitionId];
    return map ? map[step.definitionPath.join(".")] || null : null;
  }

  /**
   * Structural fingerprint of ONE proven subtree inside a component definition.
   *
   * Raw source GUIDs deliberately do not participate: a verified INSTANCE_SWAP
   * replaces the component namespace, so every GUID may legitimately change.
   * What must stay equal is the complete relative node-type shape and the
   * published identity of nested INSTANCE slots. This lets a descendant move
   * between sibling positions without turning "same shape somewhere nearby"
   * into an address heuristic.
   */
  function directStructuralSubtreeSignature(definitionId, path, session) {
    if (!definitionId || !Array.isArray(path)) return null;
    var map = session.definitionStructuralMaps[definitionId] || null;
    if (!map) return null;
    var prefix = path.join(".");
    var prefixDot = prefix ? prefix + "." : "";
    var rows = [];
    Object.keys(map).forEach(function (pathKey) {
      if (pathKey !== prefix && pathKey.indexOf(prefixDot) !== 0) return;
      var entry = map[pathKey] || {};
      var rel = pathKey === prefix ? "" : pathKey.slice(prefixDot.length);
      var nestedIdentity = "";
      if (entry.targetType === "INSTANCE" && entry.nestedDefinitionId) {
        var nestedId = entry.nestedDefinitionId;
        var componentKey = session.definitionComponentKeys[nestedId] || "";
        var variant = session.definitionVariantIdentities[nestedId] || "";
        // If no published identity exists, keep the local definition id.
        // Choosing a different anonymous component merely because its shape is
        // equal would be exactly the kind of sibling retargeting we forbid.
        nestedIdentity = componentKey ? (componentKey + "@" + variant) : ("#" + nestedId);
      }
      rows.push(rel + ":" + String(entry.targetType || "") + ":" + nestedIdentity);
    });
    if (!rows.length) return null;
    rows.sort();
    return rows.join("|");
  }

  /**
   * Relocate the FIRST descendant step after a verified native INSTANCE_SWAP.
   *
   * A public swap is authoritative provenance for the live replacement
   * component, but Pixso low-level overrides can still carry the pre-swap
   * child slot index. The same relative subtree may therefore be exposed at a
   * different sibling index. Search only direct children of the proven live
   * replacement and accept exactly one child whose COMPLETE structural subtree
   * equals the expected pre-swap subtree. Names, paints and geometry are never
   * used. Ambiguity fails closed.
   */
  function directFindVerifiedSwapRelocation(step, activeDefinitionId, session) {
    if (!step || !step.definitionId || !activeDefinitionId ||
        !Array.isArray(step.definitionPath) || step.definitionPath.length !== 1) return null;
    var expectedSignature = directStructuralSubtreeSignature(step.definitionId, step.definitionPath, session);
    var activeMap = session.definitionStructuralMaps[activeDefinitionId] || null;
    if (!expectedSignature || !activeMap) return null;

    var matches = [];
    Object.keys(activeMap).forEach(function (pathKey) {
      if (!/^\d+$/.test(pathKey)) return; // direct child of the swapped instance only
      var entry = activeMap[pathKey] || {};
      if (step.targetType && entry.targetType && step.targetType !== entry.targetType) return;
      var path = [Number(pathKey)];
      var signature = directStructuralSubtreeSignature(activeDefinitionId, path, session);
      if (signature === expectedSignature) matches.push(path);
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function directNodeAtIndexPath(root, path) {
    var node = root;
    for (var i = 0; node && i < path.length; i++) {
      var children = nodeChildren(node);
      node = children[path[i]] || null;
    }
    return node;
  }

  // Different copies/versions of one published Pixso component keep the same
  // componentKey while receiving new node GUIDs. Figma may therefore expose
  // an instance through a locally canonical copy different from the copy that
  // authored an override path. Such definitions are interchangeable for
  // index-addressed overrides only when their COMPLETE structural signatures
  // match. componentKey alone is deliberately insufficient (variants can share
  // it), and names never participate.
  function directEquivalentDefinition(expectedId, activeId, session) {
    if (!expectedId || !activeId || expectedId === activeId) return expectedId === activeId;
    // D52: см. `definitionEquivalenceCache`. Решение ниже не меняется.
    var equivalenceKey = expectedId + "" + activeId;
    var cachedEquivalence = session.definitionEquivalenceCache[equivalenceKey];
    if (cachedEquivalence !== undefined) return cachedEquivalence;
    var computedEquivalence = directComputeEquivalentDefinition(expectedId, activeId, session);
    session.definitionEquivalenceCache[equivalenceKey] = computedEquivalence;
    return computedEquivalence;
  }

  function directComputeEquivalentDefinition(expectedId, activeId, session) {
    // D48: exact publish identity + exact per-path overrideKey bijection is a
    // stronger cross-local proof than componentKey/shape. It is valid for
    // nested standalone components as well as variant members and keeps the
    // old path only as a fallback for documents without publication metadata.
    if (directOverrideKeyEquivalentDefinition(expectedId, activeId, session)) return true;
    var expectedKey = session.definitionComponentKeys[expectedId] || null;
    var activeKey = session.definitionComponentKeys[activeId] || null;
    if (!expectedKey || expectedKey !== activeKey) return false;
    var expectedVariant = session.definitionVariantIdentities[expectedId] || null;
    var activeVariant = session.definitionVariantIdentities[activeId] || null;
    // If either side is a member of a verified variant set, both sides must
    // name the exact same verified coordinate. Structural equality alone is
    // insufficient: selected/default or hover/default variants commonly have
    // identical node types and differ only in paints/visibility.
    if (expectedVariant || activeVariant) {
      if (!expectedVariant || !activeVariant || expectedVariant !== activeVariant) return false;
    }
    var expectedShape = session.definitionStructuralSignatures[expectedId] || null;
    var activeShape = session.definitionStructuralSignatures[activeId] || null;
    if (!expectedShape || expectedShape !== activeShape) return false;

    // Two library copies can keep the same published componentKey and the same
    // FRAME/INSTANCE node-type shape while changing WHICH nested components
    // occupy those slots. Such revisions are not safe override namespaces.
    // Compare nested INSTANCE lineage by published identity; raw GUID equality
    // is only the fast path because legitimate document copies get new GUIDs.
    var expectedMap = session.definitionStructuralMaps[expectedId] || null;
    var activeMap = session.definitionStructuralMaps[activeId] || null;
    if (!expectedMap || !activeMap) return false;
    var pathKeys = Object.keys(expectedMap);
    for (var pi = 0; pi < pathKeys.length; pi++) {
      var pathKey = pathKeys[pi];
      var expectedEntry = expectedMap[pathKey] || {};
      if (expectedEntry.targetType !== "INSTANCE") continue;
      var activeEntry = activeMap[pathKey] || {};
      var expectedNested = expectedEntry.nestedDefinitionId || null;
      var activeNested = activeEntry.nestedDefinitionId || null;
      if (expectedNested === activeNested) continue;
      if (!expectedNested || !activeNested) return false;
      var expectedNestedKey = session.definitionComponentKeys[expectedNested] || null;
      var activeNestedKey = session.definitionComponentKeys[activeNested] || null;
      if (!expectedNestedKey || expectedNestedKey !== activeNestedKey) return false;
      var expectedNestedVariant = session.definitionVariantIdentities[expectedNested] || null;
      var activeNestedVariant = session.definitionVariantIdentities[activeNested] || null;
      if (expectedNestedVariant || activeNestedVariant) {
        if (!expectedNestedVariant || !activeNestedVariant ||
            expectedNestedVariant !== activeNestedVariant) return false;
      }
    }
    return true;
  }

  /**
   * Relaxed cross-local proof for NON-DESTRUCTIVE value/layout replay only.
   * Exact published component key, exact verified variant coordinate and the
   * official slash-separated component naming hierarchy must all agree. Raw
   * visibility, paints and component swaps never use this lane.
   */
  function directPublishedEquivalentForValueReplay(expectedId, activeId, session, allowShapeDifference) {
    if (!expectedId || !activeId || expectedId === activeId) return expectedId === activeId;
    var expectedKey = session.definitionComponentKeys[expectedId] || null;
    var activeKey = session.definitionComponentKeys[activeId] || null;
    if (!expectedKey || expectedKey !== activeKey) return false;
    var expectedVariant = session.definitionVariantIdentities[expectedId] || null;
    var activeVariant = session.definitionVariantIdentities[activeId] || null;
    if (expectedVariant || activeVariant) {
      if (!expectedVariant || !activeVariant || expectedVariant !== activeVariant) return false;
    }
    var expectedHierarchy = session.definitionComponentNameHierarchies[expectedId] || [];
    var activeHierarchy = session.definitionComponentNameHierarchies[activeId] || [];
    if (!expectedHierarchy.length || !activeHierarchy.length ||
        expectedHierarchy.join(" / ").toLowerCase() !== activeHierarchy.join(" / ").toLowerCase()) return false;
    if (!allowShapeDifference) {
      var expectedShape = session.definitionStructuralSignatures[expectedId] || null;
      var activeShape = session.definitionStructuralSignatures[activeId] || null;
      if (!expectedShape || expectedShape !== activeShape) return false;
    }
    return true;
  }

  function directValueReplayPolicy(ops) {
    var keys = Object.keys(ops || {});
    if (!keys.length) return null;
    var allowed = { characters: true, childLayout: true, textBoxWidth: true, textAutoResize: true };
    for (var i = 0; i < keys.length; i++) if (!allowed[keys[i]]) return null;
    return {
      allowPublishedEquivalent: true,
      allowShapeDifference: keys.length === 1 && keys[0] === "characters"
    };
  }

  /**
   * Direct PIX никогда не ищет цель по имени.
   *
   * Адрес — индексный путь канонического дерева определения: приёмник сам его
   * и построил, поэтому индекс здесь первичен. sourceId из plugin data —
   * подтверждение и починка адреса, а НЕ право вето.
   *
   * Разница принципиальная. Внутри инстанса plugin data доступна не всегда:
   * подслои зеркалят master component, и читается она там не в каждом
   * контексте. Трактовка «sourceId не прочитался — значит цели нет» стоила
   * ~40% применённых правок на настоящем файле при полностью корректных
   * индексах. Поэтому:
   *
   *   sourceId совпал                     → цель найдена;
   *   sourceId прочитан и НЕ совпал       → индекс доказуемо неверен, ищем
   *                                         единственного ребёнка с нужным
   *                                         sourceId, иначе честный промах;
   *   sourceId не прочитался ни у кого    → доверяем индексу и считаем это
   *                                         отдельным счётчиком.
   *
   * Ни на одном шаге не участвует имя слоя.
   */
  /**
   * D52. Индекс `sourceOverrideKey → путь` в пределах одного определения.
   *
   * Раньше этот же ответ получался перебором всей структурной карты на каждом
   * шаге override-пути. Скан линеен по числу узлов определения, а шагов в
   * job-е десятки тысяч, поэтому на определениях в сотни узлов (таблица и её
   * вложенные сеты) он давал кратную просадку импорта при неизменном
   * результате. Содержание решения не меняется: ключ принимается только при
   * единственном носителе, неоднозначный ключ выбрасывается из индекса и
   * остаётся честным промахом.
   */
  function directDefinitionOverrideKeyIndex(session, definitionId) {
    if (!definitionId) return null;
    var cached = session.definitionOverrideKeyIndexes[definitionId];
    if (cached) return cached;
    var map = session.definitionStructuralMaps[definitionId] || null;
    if (!map) return null;
    var byKey = Object.create(null);
    var ambiguous = Object.create(null);
    var size = 0;
    // D52. Подпись определения по стабильным адресам. Она считается один раз
    // и заменяет посортовое сравнение двух полных карт путей, которым раньше
    // отвечали на вопрос об эквивалентности — на каждом межопределенческом
    // шаге разбора override-пути. Содержание проверки то же: совпадают
    // множества путей, типы узлов и `overrideKey` каждого узла. Если хотя бы
    // у одного узла ключа нет, подписи нет вовсе — угадывать здесь нечего, и
    // определения эквивалентными не считаются, ровно как раньше.
    var signatureRows = [];
    var signatureComplete = true;
    for (var pathKey in map) {
      if (!Object.prototype.hasOwnProperty.call(map, pathKey)) continue;
      size += 1;
      var entry = map[pathKey] || {};
      var key = entry.sourceOverrideKey;
      if (!key) signatureComplete = false;
      else signatureRows.push(pathKey + ":" + String(entry.targetType || "") + ":" + key);
      if (!key) continue;
      if (ambiguous[key]) continue;
      if (byKey[key]) { ambiguous[key] = true; delete byKey[key]; continue; }
      var parts = pathKey ? pathKey.split(".") : [];
      var path = [];
      var bad = false;
      for (var p = 0; p < parts.length; p++) {
        var part = Number(parts[p]);
        if (!isFinite(part)) { bad = true; break; }
        path.push(part);
      }
      if (bad) continue;
      byKey[key] = { path: path, targetType: entry.targetType || null };
    }
    var index = {
      byKey: byKey,
      size: size,
      signature: signatureComplete && signatureRows.length ? signatureRows.sort().join("|") : null,
    };
    session.definitionOverrideKeyIndexes[definitionId] = index;
    return index;
  }

  /** Сбрасывает производные индексы вместе с их источником. */
  function directInvalidateDefinitionIndexes(session, definitionId) {
    delete session.definitionOverrideKeyIndexes[definitionId];
    // Кеш эквивалентности ключуется парой, поэтому адресно снять его записи
    // дешевле целиком: структурные карты меняются только на сборке чанка
    // определений, то есть считаные разы за job.
    session.definitionEquivalenceCache = Object.create(null);
  }

  /**
   * D52. Определения одной публикации. Тот же ответ, что давал перебор всех
   * `definitionPublicationIdentities`, но за O(1) вместо O(определений).
   */
  function directRegisterPublicationIdentity(session, definitionId, publication) {
    var previous = session.definitionPublicationIdentities[definitionId] || null;
    if (previous === publication) return;
    if (previous && session.definitionPublicationGroups[previous]) {
      var old = session.definitionPublicationGroups[previous];
      var at = old.indexOf(definitionId);
      if (at >= 0) old.splice(at, 1);
    }
    session.definitionPublicationIdentities[definitionId] = publication || null;
    if (!publication) return;
    var group = session.definitionPublicationGroups[publication] ||
      (session.definitionPublicationGroups[publication] = []);
    if (group.indexOf(definitionId) < 0) group.push(definitionId);
  }

  function directFindOverrideKeyTranslation(step, activeDefinitionId, session) {
    if (!step || !step.definitionId || !activeDefinitionId || !step.sourceOverrideKey) return null;
    var expectedPublished = session.definitionPublicationIdentities[step.definitionId] || null;
    var activePublished = session.definitionPublicationIdentities[activeDefinitionId] || null;
    if (!expectedPublished || expectedPublished !== activePublished) return null;
    var index = directDefinitionOverrideKeyIndex(session, activeDefinitionId);
    var hit = index && index.byKey[step.sourceOverrideKey];
    if (!hit) return null;
    if (step.targetType && hit.targetType && step.targetType !== hit.targetType) return null;
    return hit.path;
  }

  // D52. `directFindPublishedRichTwinForStep` удалён вместе с мутацией, ради
  // которой существовал. Заглушка публикации разрешается на сборке
  // определения (alias по publishFile+publishID), а не на разборе пути:
  // у живого узла-заглушки нет детей, и адресовать внутрь него нечем.

  function directResolveTarget(instance, path, session, options) {
    options = options || {};
    if (!path || !path.length) return { target: instance, deepest: 0 };
    var current = instance;
    var previous = null;
    var unverified = 0;
    var equivalentDefinitionSteps = 0;
    var verifiedNativeSwapRebaseSteps = 0;
    var activeVariantSwapAncestorSteps = 0;
    // D57. Destructive state may cross a local Pixso namespace only when
    // every hop of the live path still has a formal identity proof. This is
    // deliberately stricter than ordinary value replay: exact source GUID
    // and unique overrideKey translation are accepted; index/name/shape
    // fallback is not.
    var identityProvenSteps = 0;
    var identityUnprovenSteps = 0;
    for (var i = 0; i < path.length; i++) {
      var step = path[i] || {};
      var forcedCandidate = null;
      var forcedCandidateIdentityProven = false;
      if (current && current.type === "INSTANCE" && session && session.swapProvenance) {
        var currentSwapProvenance = session.swapProvenance[nodeIdentity(current)] || null;
        if (currentSwapProvenance && currentSwapProvenance.sameVariantFamily) {
          activeVariantSwapAncestorSteps += 1;
        }
      }
      if (current && current.type === "INSTANCE" && step.definitionId) {
        var activeDefinitionId = directDefinitionId(current, session);

        // D52. Гидратация заглушки публикации здесь НЕ делается.
        //
        // Прежняя редакция вызывала на этом шаге `current.swapComponent(...)`,
        // то есть меняла документ внутри прохода, который его читает. Прогон
        // 08:53 показал обе цены этого решения:
        //
        //   1. Проверка пути шла ПОСЛЕ swap, и при неудаче откат не делался:
        //      узел оставался на чужом мастере без единой применённой правки.
        //      Счётчик при этом не увеличивался — отсюда
        //      `overrideStepsResolvedByOverrideKey: 0` при изменённом дереве.
        //   2. `swapComponent` пересоздаёт поддерево; вызов в самом горячем
        //      цикле разбора путей дал кратный рост времени импорта.
        //
        // Ветка к тому же недостижима по построению: заглушка потому и
        // заглушка, что у её компонента нет детей, а значит адресовать внутрь
        // живого узла нечего. Правильное место для этого случая — сборка
        // определения, где Direct PIX уже переводит заглушку на богатого
        // близнеца той же публикации (alias по publishFile+publishID).

        // D52: один вопрос — один ответ. Прежде `directEquivalentDefinition`
        // вызывался здесь дважды подряд с теми же аргументами, а внутри он
        // сортирует и сравнивает полные карты путей обоих определений.
        var crossDefinitionStep = !!(activeDefinitionId && activeDefinitionId !== step.definitionId);
        var equivalentDefinitions = crossDefinitionStep &&
          directEquivalentDefinition(step.definitionId, activeDefinitionId, session);
        if (equivalentDefinitions) {
          equivalentDefinitionSteps += 1;
        }
        if (crossDefinitionStep && !equivalentDefinitions) {
          // D48: copied/revised library mirrors can expose the same logical
          // node at a different local GUID/index path. Translate this exact
          // hop by Pixso overrideKey, but only inside the same published
          // component and only when the key resolves uniquely.
          var translatedOverridePath = directFindOverrideKeyTranslation(step, activeDefinitionId, session);
          if (translatedOverridePath) {
            var translatedCandidate = directNodeAtIndexPath(current, translatedOverridePath);
            if (translatedCandidate && (!step.targetType || translatedCandidate.type === step.targetType)) {
              forcedCandidate = translatedCandidate;
              forcedCandidateIdentityProven = true;
              equivalentDefinitionSteps += 1;
              if (!options.noMetrics) {
                session.totals.overrideKeyTranslationSteps =
                  (session.totals.overrideKeyTranslationSteps || 0) + 1;
              }
            }
          }
          if (forcedCandidate) {
            // Continue into normal source/type verification below with the
            // translated live node. The original local GUID remains evidence
            // only; no sibling/name search is performed.
          } else {
          var publishedValueReplay = options.allowPublishedEquivalent &&
            directPublishedEquivalentForValueReplay(
              step.definitionId, activeDefinitionId, session, !!options.allowShapeDifference
            );
          if (publishedValueReplay) {
            equivalentDefinitionSteps += 1;
            if (!options.noMetrics) {
              session.totals.publishedCopyValueReplaySteps =
                (session.totals.publishedCopyValueReplaySteps || 0) + 1;
            }
          } else {
          // A verified public INSTANCE_SWAP is the authoritative identity of
          // this exact nested slot. Pixso may nevertheless keep descendant
          // low-level overrides addressed through the pre-swap definition.
          // Rebase only when the live replacement exposes the SAME relative
          // structural path and target type; this is path provenance, not
          // component-name/paint similarity. It fixes e.g. an icon's explicit
          // fill override that must survive swapping the icon component.
          var verifiedNativeSwapDefinitionId = null;
          try {
            verifiedNativeSwapDefinitionId = current.getPluginData
              ? current.getPluginData("pixsoDirectVerifiedNativeSwapDefinitionId") || null : null;
          } catch (_eVerifiedSwap) { verifiedNativeSwapDefinitionId = null; }
          var nativeSwapRebase = false;
          var nativeSwapRelocatedCandidate = null;
          if (verifiedNativeSwapDefinitionId === activeDefinitionId && Array.isArray(step.definitionPath)) {
            var activeMap = session.definitionStructuralMaps[activeDefinitionId] || null;
            var activeEntry = activeMap ? activeMap[step.definitionPath.join(".")] || null : null;
            var liveChildren = nodeChildren(current);
            var liveCandidate = liveChildren[step.index];
            nativeSwapRebase = !!(activeEntry && liveCandidate &&
              (!step.targetType || liveCandidate.type === step.targetType) &&
              (!activeEntry.targetType || !step.targetType || activeEntry.targetType === step.targetType));

            // The replacement may expose the exact same proven subtree in a
            // different direct-child slot. This is common after a library
            // component revision inserts/removes a sibling around the bound
            // slot. Search the live replacement by complete structural subtree
            // identity, never by name or visual similarity.
            if (!nativeSwapRebase) {
              var relocatedPath = directFindVerifiedSwapRelocation(step, activeDefinitionId, session);
              if (relocatedPath) {
                nativeSwapRelocatedCandidate = directNodeAtIndexPath(current, relocatedPath);
                nativeSwapRebase = !!(nativeSwapRelocatedCandidate &&
                  (!step.targetType || nativeSwapRelocatedCandidate.type === step.targetType));
                if (nativeSwapRebase) {
                  if (!options.noMetrics) {
                    session.totals.nativeSwapDescendantPathsRelocated =
                      (session.totals.nativeSwapDescendantPathsRelocated || 0) + 1;
                  }
                }
              }
            }
          }
          if (nativeSwapRebase) {
            verifiedNativeSwapRebaseSteps += 1;
            // D60. A verified native INSTANCE_SWAP is itself a formal identity
            // proof for this slot. The live child may now carry the GUID of the
            // replacement variant, so sourceId equality is impossible on this
            // hop even though the binding was verified by setProperties() and
            // read-back. Mark the hop strongly identified so an explicit
            // descendant visible=false is not discarded merely because the
            // variant namespace changed (SideMenu collapsed rail case).
            forcedCandidateIdentityProven = true;
            if (!options.noMetrics) {
              session.totals.nativeSwapDescendantPathsRebased =
                (session.totals.nativeSwapDescendantPathsRebased || 0) + 1;
            }
            // Carry the relocated child into the normal source/structural
            // verification below. `var` is function-scoped intentionally.
            if (nativeSwapRelocatedCandidate) forcedCandidate = nativeSwapRelocatedCandidate;
          } else {
            // A path step is a canonical SLOT, not "any descendant with this
            // component". Re-targeting to a sibling/subtree on definition
            // identity alone can move an override between repeated menu/tab
            // slots and apply selected paint to the wrong icon. If a verified
            // native swap cannot rebase this exact slot, fail closed.
            return {
              target: null,
              reason: i === 0 ? "WRONG_CANONICAL_DEFINITION" : "WRONG_NESTED_SWAP_CONTEXT",
              deepest: i,
              expectedTargetGuid: step.sourceId || null,
              expectedDefinitionId: step.definitionId,
              activeDefinitionId: activeDefinitionId,
            };
          }
          }
          }
        }
      }
      var children = nodeChildren(current);
      var candidate = forcedCandidate || children[step.index];
      var expectedId = step.sourceId || null;
      var structural = directStructuralEntry(session, step);
      var structurallyVerified = !!(structural && structural.sourceId === expectedId &&
        (!structural.targetType || !candidate || candidate.type === structural.targetType));
      if (expectedId) {
        if (!candidate || directSourceId(candidate) !== expectedId) {
          var matches = children.filter(function (child) {
            return directSourceId(child) === expectedId;
          });
          if (matches.length === 1) {
            candidate = matches[0];
          } else if (matches.length > 1) {
            return {
              target: null,
              reason: "SOURCE_GUID_AMBIGUOUS",
              deepest: i,
              expectedTargetGuid: expectedId,
            };
          } else if (candidate && structurallyVerified) {
            if (!options.noMetrics) session.totals.structuralStepsVerified += 1;
          } else if (candidate && !directSourceId(candidate)) {
            // Старый protocol без definition-relative map: индекс остаётся
            // допустимым, но визуальная безопасность такого шага не доказана.
            unverified += 1;
          } else {
            // Две разные поломки, и лечатся они по-разному: индекс вне
            // диапазона означает, что приёмник построил меньше детей, чем
            // насчитал отправитель; несовпадение guid при живом индексе —
            // что дерево на этом уровне другое. Один код на оба случая не
            // позволял отличить их в отчёте.
            return {
              target: null,
              reason: candidate
                ? (structural ? "TARGET_STRUCTURAL_TYPE_MISMATCH" : "TARGET_GUID_NOT_IN_FIGMA_SUBTREE")
                : (structural ? "TARGET_NOT_EXPOSED_IN_INSTANCE_SUBTREE" : "TARGET_INDEX_OUT_OF_RANGE"),
              deepest: i,
              expectedTargetGuid: expectedId,
              childCount: children.length,
              wantedIndex: step.index,
              expectedDefinitionId: step.definitionId || null,
              activeDefinitionId: directDefinitionId(current, session),
            };
          }
        }
      } else {
        // Protocol v1 до sourceId: только точный индекс + проверка имени.
        // Поиск похожего имени запрещён — дубликаты имён обычны.
        if (!candidate || (step.name !== undefined && candidate.name !== step.name)) {
          return {
            target: null,
            reason: "LEGACY_INDEX_PATH_CHANGED",
            deepest: i,
            expectedTargetGuid: null,
          };
        }
      }
      // D57: record whether THIS canonical hop is strongly identified.
      // A direct source-id match is exact. A unique published/overrideKey
      // translation is also exact even though the local GUID changes.
      // Structural/index replay stays usable for non-destructive values but
      // cannot authorize hiding a layer.
      var candidateSourceId = candidate ? directSourceId(candidate) : null;
      // A structural-map hit is also an exact identity proof. Native Figma
      // instance descendants do not reliably retain our source-id pluginData,
      // but `structurallyVerified` means this exact definition-relative slot
      // was mapped from the expected Pixso source GUID and the live node type
      // still matches. Treating only pluginData equality as proof caused
      // explicit visible=false overrides to be silently discarded after a
      // component/variant namespace crossing, making hidden Pixso layers
      // visible in Figma. This remains fail-closed: plain index replay without
      // a structural-map proof is still unproven and cannot authorize a
      // destructive visibility change.
      var stepIdentityProven = !!(
        (expectedId && candidateSourceId === expectedId) || structurallyVerified
      );
      if (forcedCandidateIdentityProven) stepIdentityProven = true;
      if (stepIdentityProven) identityProvenSteps += 1;
      else identityUnprovenSteps += 1;

      if (!isAlive(candidate)) {
        return {
          target: null,
          reason: "TARGET_REMOVED",
          deepest: i,
          expectedTargetGuid: expectedId,
        };
      }
      previous = current;
      current = candidate;
    }
    return {
      target: current, deepest: path.length, unverifiedSteps: unverified,
      equivalentDefinitionSteps: equivalentDefinitionSteps,
      verifiedNativeSwapRebaseSteps: verifiedNativeSwapRebaseSteps,
      activeVariantSwapAncestorSteps: activeVariantSwapAncestorSteps,
      identityProvenSteps: identityProvenSteps,
      identityUnprovenSteps: identityUnprovenSteps,
      targetIdentityProven: path.length > 0 && identityProvenSteps === path.length && identityUnprovenSteps === 0
    };
  }

  /**
   * D57. `visible:false` is destructive, but crossing a swap/local mirror is
   * not by itself evidence that the field is stale. The .pix override stream
   * is ordered: a low-level swap may establish a new local namespace and a
   * following explicit visibility record may intentionally hide a descendant
   * in that namespace (SideMenu is a real example).
   *
   * Therefore we suppress only when path resolution had to rely on a weak
   * structural/index equivalence. If every hop is proven by exact source GUID
   * or unique publication+overrideKey translation, the explicit source state
   * wins and is replayed. Native BOOLEAN ownership is handled separately.
   */
  function directFilterCrossNamespaceDestructiveOps(ops, resolution, session, entry) {
    if (!ops || !resolution) return ops;
    var crossed = (resolution.equivalentDefinitionSteps || 0) +
      (resolution.verifiedNativeSwapRebaseSteps || 0) +
      (resolution.activeVariantSwapAncestorSteps || 0);
    if (!crossed || ops.visible !== false) return ops;

    if (resolution.targetIdentityProven) {
      session.totals.crossNamespaceVisibilityFalseAppliedExact =
        (session.totals.crossNamespaceVisibilityFalseAppliedExact || 0) + 1;
      directStageRecord(session, "low-level-cross-namespace-visible-authorized",
        resolution.target || null, null, {
          equivalentDefinitionSteps: resolution.equivalentDefinitionSteps || 0,
          verifiedNativeSwapRebaseSteps: resolution.verifiedNativeSwapRebaseSteps || 0,
          activeVariantSwapAncestorSteps: resolution.activeVariantSwapAncestorSteps || 0,
          identityProvenSteps: resolution.identityProvenSteps || 0,
          identityUnprovenSteps: resolution.identityUnprovenSteps || 0,
          sourcePathDepth: entry && entry.path ? entry.path.length : 0
        }, true);
      return ops;
    }

    var out = {};
    Object.keys(ops).forEach(function (key) {
      if (key !== "visible") out[key] = ops[key];
    });
    session.totals.crossNamespaceVisibilityFalseSuppressed =
      (session.totals.crossNamespaceVisibilityFalseSuppressed || 0) + 1;
    session.totals.crossNamespaceVisibilityFalseSuppressedUnproven =
      (session.totals.crossNamespaceVisibilityFalseSuppressedUnproven || 0) + 1;
    directStageRecord(session, "low-level-cross-namespace-visible-suppressed",
      resolution.target || null, null, {
        equivalentDefinitionSteps: resolution.equivalentDefinitionSteps || 0,
        verifiedNativeSwapRebaseSteps: resolution.verifiedNativeSwapRebaseSteps || 0,
        activeVariantSwapAncestorSteps: resolution.activeVariantSwapAncestorSteps || 0,
        identityProvenSteps: resolution.identityProvenSteps || 0,
        identityUnprovenSteps: resolution.identityUnprovenSteps || 0,
        sourcePathDepth: entry && entry.path ? entry.path.length : 0
      }, true);
    return out;
  }

  function directOpsWithoutSwap(ops) {
    var rest = {};
    var keys = Object.keys(ops || {});
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] !== "swapDefinitionId") rest[keys[i]] = ops[keys[i]];
    }
    return rest;
  }

  /**
   * Protocol v1 до presence-map допускал только `ops`. Такие пакеты
   * остаются совместимыми; новый отправитель всегда присылает `present`,
   * и в этом случае отсутствие флага запрещает запись.
   */
  function directOpExplicit(entry, key) {
    if (!entry || !entry.present) {
      return !!(entry && entry.ops && Object.prototype.hasOwnProperty.call(entry.ops, key));
    }
    return entry.present[key] === true;
  }

  function directRejectImplicitOp(session, entry, key, value) {
    session.totals.overridesMissed += 1;
    session.overrideMissReasons.OVERRIDE_FIELD_NOT_EXPLICIT =
      (session.overrideMissReasons.OVERRIDE_FIELD_NOT_EXPLICIT || 0) + 1;
    directMarkUnsafe(session, "OVERRIDE_FIELD_NOT_EXPLICIT", 1);
    directNote(session, "OVERRIDE_FIELD_NOT_EXPLICIT");
  }

  function directCountBlockedTextEffects(session, entry, target) {
    if (!entry || !entry.present || !target || target.type !== "TEXT") return;
    var ops = entry.ops || {};
    var before = directTextSnapshot(target);
    if (!entry.present.characters && ops.characters === "" && before && before.characters) {
      session.totals.textClearsBlocked += 1;
      session.totals.blockedImplicitTextClears += 1;
    }
    ["fills", "strokes"].forEach(function (key) {
      if (!entry.present[key] && Array.isArray(ops[key]) && !ops[key].length &&
          before && Array.isArray(before[key]) && before[key].length) {
        session.totals.paintClearsBlocked += 1;
      }
    });
    var blockedStyle = ops.textStyle;
    if (!entry.present.textStyle &&
        (blockedStyle === null || (blockedStyle &&
          Object.prototype.hasOwnProperty.call(blockedStyle, "textStyleId") &&
          (blockedStyle.textStyleId === "" || blockedStyle.textStyleId === null)))) {
      session.totals.textStyleClearsBlocked += 1;
    }
  }

  function directPresenceFilteredOps(entry, withoutSwap, session) {
    var source = entry && entry.ops || {};
    var out = {};
    Object.keys(source).forEach(function (key) {
      if (withoutSwap && key === "swapDefinitionId") return;
      if (directOpExplicit(entry, key)) out[key] = source[key];
      else directRejectImplicitOp(session, entry, key, source[key]);
    });
    return out;
  }

  function directTextValue(node, key) {
    try { return clone(node[key]); } catch (_e) { return undefined; }
  }

  function directTextSnapshot(node) {
    if (!node || node.type !== "TEXT") return null;
    return {
      characters: directTextValue(node, "characters"),
      visible: directTextValue(node, "visible"),
      textStyleId: directTextValue(node, "textStyleId"),
      fillStyleId: directTextValue(node, "fillStyleId"),
      fills: directTextValue(node, "fills"),
      strokes: directTextValue(node, "strokes"),
      fontSize: directTextValue(node, "fontSize"),
      fontName: directTextValue(node, "fontName"),
      opacity: directTextValue(node, "opacity"),
      blendMode: directTextValue(node, "blendMode"),
    };
  }

  function directRecordTextTrace(session, entry, before, after) {
    if (!session.traceTextOverrides || !before || !after ||
        session.textOverrideTraceSamples.length >= session.textOverrideTraceLimit) return;
    var diagnostic = entry && entry.diagnostic || {};
    var producerTrace = diagnostic.textTrace || {};
    var category = "NO_DESTRUCTIVE_CHANGE";
    if (before.characters && after.characters === "") category = "TEXT_CLEARED";
    else if (before.visible !== false && after.visible === false) category = "TEXT_HIDDEN";
    else if (before.textStyleId && !after.textStyleId) category = "TEXT_STYLE_CLEARED";
    else if (before.fillStyleId && !after.fillStyleId) category = "FILL_STYLE_CLEARED";
    else if (before.fills && before.fills.length && after.fills && !after.fills.length) category = "PAINT_CLEARED";
    session.textOverrideTraceSamples.push({
      targetGuid: producerTrace.targetGuid || diagnostic.expectedTargetGuid || null,
      targetRelativePath: producerTrace.targetRelativePath || (entry && entry.path || []),
      before: before,
      rawOverrides: producerTrace.rawOverrides || [],
      normalized: {
        fields: Object.keys(entry && entry.ops || {}),
        present: Object.assign({}, entry && entry.present || {}),
        values: clone(entry && entry.ops || {}),
      },
      after: after,
      category: category,
    });
  }

  /**
   * Шаг адреса, принятый по индексу без подтверждения sourceId. Не ошибка, но
   * и не полная уверенность: счётчик обязан это показывать, иначе «применено»
   * перестаёт быть проверяемым утверждением.
   */
  function directCountUnverified(session, resolution) {
    if (!resolution || !resolution.unverifiedSteps) return;
    session.totals.overrideStepsUnverified =
      (session.totals.overrideStepsUnverified || 0) + resolution.unverifiedSteps;
    directMarkUnsafe(session, "OVERRIDE_PATH_UNVERIFIED", resolution.unverifiedSteps);
  }

  function directCountMiss(session, count, reason, entry, resolution, instance) {
    session.totals.overridesMissed += count;
    session.unsupported.OVERRIDE_TARGET_NOT_FOUND =
      (session.unsupported.OVERRIDE_TARGET_NOT_FOUND || 0) + count;
    session.totals.unsupported += count;
    var code = reason || "OVERRIDE_TARGET_NOT_FOUND";
    directMarkUnsafe(session, code, count);
    session.overrideMissReasons[code] = (session.overrideMissReasons[code] || 0) + count;
    // Выборка собирается всегда: 908 промахов без единого образца в логе
    // ничего не доказывают. Ограниченная по умолчанию, расширенная — по
    // явному запросу отправителя.
    // Квота на причину: редкий код обязан получить образец даже рядом с
    // сотней промахов одного частого.
    if (directAdmitSample(session.overrideMissPool, [code])) {
      var diagnostic = entry && entry.diagnostic || {};
      session.overrideMissSamples.push({
        reason: code,
        count: count,
        instanceSourceId: diagnostic.instanceSourceId || directSourceId(instance) || null,
        sourceSymbolId: diagnostic.sourceSymbolId || null,
        canonicalDefinitionId: diagnostic.canonicalDefinitionId || null,
        componentKey: diagnostic.componentKey || null,
        overrideFields: diagnostic.overrideFields || Object.keys(entry && entry.ops || {}),
        overrideTypes: diagnostic.overrideTypes || {},
        guidPath: diagnostic.guidPath || [],
        expectedTargetGuid: resolution && resolution.expectedTargetGuid || diagnostic.expectedTargetGuid || null,
        deepestResolvedSegment: resolution && resolution.deepest || 0,
        // Сколько детей реально нашлось на шаге, где адрес сломался, и какой
        // индекс был нужен: без этой пары «цель не найдена» недоказуемо.
        childCountAtDeepest: resolution && resolution.childCount !== undefined ? resolution.childCount : null,
        wantedIndexAtDeepest: resolution && resolution.wantedIndex !== undefined ? resolution.wantedIndex : null,
        sourceNodeType: diagnostic.sourceNodeType || null,
        sourceNodeName: diagnostic.sourceNodeName || null,
        targetInstanceId: (function () { try { return instance && instance.id || null; } catch (_e) { return null; } })(),
        targetInstanceType: (function () { try { return instance && instance.type || null; } catch (_e) { return null; } })(),
        nestedComponentSwapEncountered: !!diagnostic.nestedComponentSwapEncountered,
        overriddenSymbolId: diagnostic.overriddenSymbolId || null,
        activeSymbolBefore: diagnostic.activeSymbolBefore || null,
        activeSymbolAfter: diagnostic.activeSymbolAfter || null,
        lineage: diagnostic.lineage || [],
        failureHop: diagnostic.failureHop !== undefined ? diagnostic.failureHop : null,
        expectedDefinitionId: resolution && resolution.expectedDefinitionId || null,
        activeDefinitionId: resolution && resolution.activeDefinitionId || null,
        // Причинная подпричина деградации, если промах — её следствие.
        definitionUnavailableReason:
          resolution && resolution.definitionUnavailableReason || null,
      });
    }
  }

  function directFilterNativeOwnedOps(instance, entry, ops, session) {
    if (!entry || !entry.nativeOwners || !ops) return ops;
    var out = {};
    var keys = Object.keys(ops);
    for (var i = 0; i < keys.length; i++) {
      var opKey = keys[i];
      var owner = entry.nativeOwners[opKey];
      if (!owner || !owner.propertyId) { out[opKey] = ops[opKey]; continue; }
      var ownerResolution = directResolveTarget(instance, owner.path || [], session);
      var ownerTarget = ownerResolution.target;
      // D42: if strict GUID addressing no longer reaches the owner after a
      // canonical/local-master transition, reuse only the owner that already
      // accepted AND verified this public property on the same root instance.
      // No name-based fallback is allowed in this suppression path.
      if (!ownerTarget || !directWasNativePropertyApplied(ownerTarget, owner.propertyId, session)) {
        var appliedOwner = directNativePropertyAppliedOwner(instance, owner.propertyId, session);
        if (appliedOwner) ownerTarget = appliedOwner;
      }
      if (ownerTarget && directWasNativePropertyApplied(ownerTarget, owner.propertyId, session)) {
        session.totals.nativeOwnedLowLevelSuppressed += 1;
        directStageRecord(session, "low-level-native-owned-suppressed", ownerTarget, null, {
          propertyId: owner.propertyId, propertyType: owner.propertyType || null,
          lowLevelOp: opKey, targetPath: entry.path || [], ownerPath: owner.path || []
        }, false);
        continue;
      }
      session.totals.nativeOwnedLowLevelFallback += 1;
      out[opKey] = ops[opKey];
    }
    return out;
  }

  function directExplicitTextOwnedByVerifiedNative(instance, entry, target, session) {
    if (!entry || !session) return false;
    var owner = entry.nativeOwners && entry.nativeOwners.characters;
    if (owner && owner.propertyId) {
      var ownerResolution = directResolveTarget(instance, owner.path || [], session);
      var ownerTarget = ownerResolution.target;
      if (!ownerTarget || !directWasNativePropertyApplied(ownerTarget, owner.propertyId, session)) {
        var appliedOwner = directNativePropertyAppliedOwner(instance, owner.propertyId, session);
        if (appliedOwner) ownerTarget = appliedOwner;
      }
      if (ownerTarget && directWasNativePropertyApplied(ownerTarget, owner.propertyId, session)) return true;
    }
    // A verified native TEXT property may be discoverable from the live
    // componentPropertyReferences even when the producer did not annotate the
    // low-level record with nativeOwners. Never overwrite a verified public
    // property during the final authoritative replay.
    var identity = target ? nodeIdentity(target) : null;
    var effectOwner = identity && session.nativeEffectOwners
      ? session.nativeEffectOwners[identity] : null;
    return !!(effectOwner && effectOwner.characters);
  }

  /**
   * D59 final explicit TEXT commit.
   *
   * Live Figma may rematerialize an INSTANCE subtree during later component
   * sizing/layout commits. A deep explicit Pixso `characters` override can be
   * accepted earlier and then disappear when an ancestor occurrence is
   * resized/reconciled. The serialized .pix value is still authoritative.
   * Re-resolve the path against the FINAL live tree and reassert only an
   * explicit, non-native-owned TEXT value. This is not a heuristic: the same
   * formal path/value replay policy used by the ordinary override phase is
   * applied again after every component mutation has finished.
   */
  async function directReassertExplicitTextOverrides(instance, overrides, session) {
    if (!instance || !overrides || !overrides.length) return;
    for (var i = 0; i < overrides.length; i++) {
      var entry = overrides[i] || {};
      var ops = entry.ops || {};
      if (typeof ops.characters !== "string" || !directOpExplicit(entry, "characters")) continue;
      var valueReplayPolicy = directValueReplayPolicy({ characters: ops.characters }) || {};
      valueReplayPolicy.noMetrics = true;
      var resolution = directResolveTarget(instance, entry.path || [], session, valueReplayPolicy);
      var target = resolution.target;
      if (!target || target.type !== "TEXT") {
        session.totals.finalExplicitTextReassertMissed =
          (session.totals.finalExplicitTextReassertMissed || 0) + 1;
        continue;
      }
      // The path already proves the exact definition namespace and structural
      // slot. Use that same proof to restore ENDING/maxLines on the final live
      // descendant; names and visual similarity never participate.
      var overflow = null;
      for (var op = (entry.path || []).length - 1; op >= 0; op--) {
        var structural = directStructuralEntry(session, entry.path[op]);
        if (structural && structural.targetType === "TEXT") {
          overflow = structural.textOverflow || null;
          break;
        }
      }
      if (overflow) directReassertTextOverflow(target, overflow, session);

      // D61. An explicit resolved Pixso text override and a native TEXT
      // component property are not competing values: when both address the
      // same bound field, the public property must carry the resolved
      // occurrence text. Earlier stages can successfully verify a stale
      // serialized property value (for example the component default) and
      // then suppress the explicit characters replay. Reconcile at the final
      // live-tree barrier, after swaps/rematerialization, using only the
      // schema-backed native owner recorded by MigrationIR.
      var nativeTextOwner = entry.nativeOwners && entry.nativeOwners.characters;
      if (nativeTextOwner && nativeTextOwner.propertyId) {
        var nativeOwnerResolution = directResolveTarget(instance, nativeTextOwner.path || [], session);
        var nativeOwnerTarget = nativeOwnerResolution.target;
        if (!nativeOwnerTarget || nodeType(nativeOwnerTarget) !== "INSTANCE") {
          var rememberedNativeOwner = directNativePropertyAppliedOwner(
            instance, nativeTextOwner.propertyId, session
          );
          if (rememberedNativeOwner) nativeOwnerTarget = rememberedNativeOwner;
        }
        if (nativeOwnerTarget && nodeType(nativeOwnerTarget) === "INSTANCE" &&
            typeof nativeOwnerTarget.setProperties === "function") {
          var nativeTextNames = await directNativePropertyNamesForInstance(nativeOwnerTarget, session);
          var nativeTextActualName = nativeTextNames && nativeTextNames[nativeTextOwner.propertyId];
          if (nativeTextActualName) {
            var nativeTextOne = {};
            nativeTextOne[nativeTextActualName] = ops.characters;
            try {
              nativeOwnerTarget.setProperties(nativeTextOne);
              var nativeTextVerified = directVerifyNativeProperty(nativeOwnerTarget, nativeTextActualName, {
                type: "TEXT", propertyId: nativeTextOwner.propertyId,
                value: ops.characters, path: nativeTextOwner.path || []
              }, session);
              if (nativeTextVerified) {
                directMarkNativePropertyApplied(nativeOwnerTarget, nativeTextOwner.propertyId, session);
                directMarkNativePropertyAppliedOwner(instance, nativeOwnerTarget, nativeTextOwner.propertyId, session);
                session.totals.finalNativeTextPropertyReconciled =
                  (session.totals.finalNativeTextPropertyReconciled || 0) + 1;
                continue;
              }
              session.totals.finalNativeTextPropertyReconcileMissed =
                (session.totals.finalNativeTextPropertyReconcileMissed || 0) + 1;
            } catch (_eFinalNativeText) {
              session.totals.finalNativeTextPropertyReconcileMissed =
                (session.totals.finalNativeTextPropertyReconcileMissed || 0) + 1;
              directNote(session, "FINAL_NATIVE_TEXT_PROPERTY_RECONCILE_REJECTED");
            }
          }
        }
      }

      // If a verified native TEXT owner already produces the exact resolved
      // characters, no low-level write is needed. Otherwise fall through to
      // the existing exact-path visual replay instead of preserving a stale
      // default merely because setProperties succeeded earlier.
      if (directExplicitTextOwnedByVerifiedNative(instance, entry, target, session) &&
          directTextValue(target, "characters") === ops.characters) continue;
      var current = directTextValue(target, "characters");
      if (current === ops.characters) continue;
      var fontStartedAt = Date.now();
      var ready = await directLoadNodeFont(target);
      session.timings.fontMs += Date.now() - fontStartedAt;
      if (!ready) {
        session.totals.finalExplicitTextReassertMissed =
          (session.totals.finalExplicitTextReassertMissed || 0) + 1;
        directNote(session, "FINAL_EXPLICIT_TEXT_FONT_UNAVAILABLE");
        continue;
      }
      var before = session.stageTrace ? directStageSnapshot(target) : null;
      try { target.characters = ops.characters; }
      catch (_eFinalText) {
        session.totals.finalExplicitTextReassertMissed =
          (session.totals.finalExplicitTextReassertMissed || 0) + 1;
        directNote(session, "FINAL_EXPLICIT_TEXT_REASSERT_REJECTED");
        continue;
      }
      var after = directTextValue(target, "characters");
      if (after === ops.characters) {
        session.totals.finalExplicitTextReasserted =
          (session.totals.finalExplicitTextReasserted || 0) + 1;
        directStageRecord(session, "final-explicit-text-reassert", target, before, {
          sourcePathDepth: entry.path ? entry.path.length : 0,
          expectedLength: ops.characters.length
        }, true);
      } else {
        session.totals.finalExplicitTextReassertMissed =
          (session.totals.finalExplicitTextReassertMissed || 0) + 1;
        directNote(session, "FINAL_EXPLICIT_TEXT_REASSERT_NOT_PERSISTED");
      }
    }
  }

  async function directApplyDeferredNativeSwapFallbacks(instance, overrides, indices, session) {
    indices = indices || [];
    for (var i = 0; i < indices.length; i++) {
      var entry = overrides[indices[i]] || {};
      var ops = entry.ops || {};
      if (ops.swapDefinitionId === undefined) continue;
      var filtered = directFilterNativeOwnedOps(instance, entry, { swapDefinitionId: ops.swapDefinitionId }, session);
      if (filtered.swapDefinitionId === undefined) continue;
      if (!directOpExplicit(entry, "swapDefinitionId")) {
        directRejectImplicitOp(session, entry, "swapDefinitionId", filtered.swapDefinitionId);
        continue;
      }
      var resolution = directResolveTarget(instance, entry.path || [], session);
      var target = resolution.target;
      if (!target) {
        directCountMiss(session, 1, resolution.reason, entry, resolution, instance);
        continue;
      }
      directCountUnverified(session, resolution);
      await directApplyOps(target, { swapDefinitionId: filtered.swapDefinitionId }, session, entry, "swaps");
    }
  }

  async function directApplyOverrides(instance, overrides, session, phase, priorSkipped) {
    phase = phase || "all";
    var skipped = priorSkipped ? priorSkipped.slice() : new Array(overrides.length);
    var deferredNativeSwaps = [];
    // Счётчики относятся к логической записи override, а не к внутренним
    // стадиям исполнения. При двухфазном вызове считаем их ровно на rest.
    if (phase !== "swaps") {
      for (var a = 0; a < overrides.length; a++) {
        var attemptedOps = overrides[a].ops || {};
        session.totals.overridesAttempted += Object.keys(attemptedOps).length;
        if (Object.prototype.hasOwnProperty.call(attemptedOps, "characters")) {
          session.totals.textOverridesSeen += 1;
        }
      }
    }

    // Вхождение выродилось в placeholder: у него НЕТ поддерева, и обход
    // адресов по нему даёт только производные симптомы вроде
    // TARGET_INDEX_OUT_OF_RANGE. Это ложь о причине и инфляция счётчиков
    // адресации: настоящая причина одна, и она уже известна.
    var degraded = directDegradedInfo(session, instance);
    if (degraded) {
      if (phase === "swaps") return { skipped: skipped, deferredNativeSwaps: deferredNativeSwaps };
      for (var d = 0; d < overrides.length; d++) {
        var degradedOps = overrides[d].ops || {};
        var degradedCount = Object.keys(degradedOps).length;
        if (!degradedCount) continue;
        directCountMiss(
          session, degradedCount, "OVERRIDE_SKIPPED_DEFINITION_UNAVAILABLE",
          overrides[d],
          {
            deepest: 0,
            expectedDefinitionId: degraded.definitionId || null,
            definitionUnavailableReason: degraded.subreason || null,
          },
          instance
        );
      }
      return;
    }

    // Фаза 1 — подмены вложенных компонентов. Они меняют поддерево инстанса.
    // Deep nesting требует строгого shallow -> deep порядка независимо от
    // порядка symbolOverrides в .pix: parent swap может уничтожить и заново
    // материализовать все descendant INSTANCE.  Каждая следующая цель поэтому
    // разрешается заново от ЖИВОГО root instance после предыдущей подмены.
    if (phase !== "rest") {
      var swapPlan = [];
      for (var si = 0; si < overrides.length; si++) {
        var swapOps = overrides[si].ops || {};
        if (swapOps.swapDefinitionId === undefined) continue;
        swapPlan.push({ index: si, entry: overrides[si], ops: swapOps });
      }
      swapPlan.sort(function (a, b) {
        var ad = a.entry && a.entry.path ? a.entry.path.length : 0;
        var bd = b.entry && b.entry.path ? b.entry.path.length : 0;
        if (ad !== bd) return ad - bd;
        return a.index - b.index;
      });
      for (var spi = 0; spi < swapPlan.length; spi++) {
        var planned = swapPlan[spi];
        var i = planned.index;
        var ops = planned.ops;
        // D54: a swap carrying formal native ownership is a materialized
        // shadow of componentPropAssignment. It must NOT mutate topology before
        // setProperties() gets a chance to apply the public property. Defer it
        // and replay only if the native owner later fails verification.
        var swapOwner = planned.entry && planned.entry.nativeOwners
          ? planned.entry.nativeOwners.swapDefinitionId : null;
        if (swapOwner && swapOwner.propertyId) {
          deferredNativeSwaps.push(i);
          continue;
        }
        if (!directOpExplicit(planned.entry, "swapDefinitionId")) {
          directRejectImplicitOp(session, planned.entry, "swapDefinitionId", ops.swapDefinitionId);
          continue;
        }
        var swapResolution = directResolveTarget(instance, planned.entry.path, session);
        var swapTarget = swapResolution.target;
        if (!swapTarget) {
          directCountMiss(session, Object.keys(ops).length, swapResolution.reason, planned.entry, swapResolution, instance);
          skipped[i] = true;
          continue;
        }
        directCountUnverified(session, swapResolution);
        await directApplyOps(swapTarget, { swapDefinitionId: ops.swapDefinitionId }, session, planned.entry, "swaps");
      }
    }

    if (phase === "swaps") return { skipped: skipped };

    // Фаза 2 — адреса всех остальных целей вычисляются ДО того, как хоть одно
    // имя изменено. Имя в пути служит проверкой найденного по индексу узла, и
    // правка имени соседней записью не имеет права ломать адресацию: иначе
    // «переименовали слой» превращалось бы в тихую потерю всех правок под ним.
    var plan = [];
    for (var j = 0; j < overrides.length; j++) {
      if (skipped[j]) continue;
      var originalRest = directOpsWithoutSwap(overrides[j].ops);
      var rest = directPresenceFilteredOps(overrides[j], true, session);
      rest = directFilterNativeOwnedOps(instance, overrides[j], rest, session);
      var restKeys = Object.keys(rest);
      if (!restKeys.length) {
        // Полностью заблокированная запись всё равно попадает в TEXT trace:
        // иначе в отчёте не будет видно самого срабатывания guard.
        if (session.traceTextOverrides && Object.keys(originalRest).length) {
          var blockedResolution = directResolveTarget(instance, overrides[j].path, session);
          if (blockedResolution.target) {
            directCountBlockedTextEffects(session, overrides[j], blockedResolution.target);
            var blockedBefore = directTextSnapshot(blockedResolution.target);
            directRecordTextTrace(session, overrides[j], blockedBefore, directTextSnapshot(blockedResolution.target));
          }
        }
        continue;
      }
      var valueReplayPolicy = directValueReplayPolicy(rest);
      var resolution = directResolveTarget(instance, overrides[j].path, session, valueReplayPolicy || {});
      var target = resolution.target;
      if (!target) {
        directCountMiss(session, restKeys.length, resolution.reason, overrides[j], resolution, instance);
        continue;
      }
      directCountUnverified(session, resolution);
      directCountBlockedTextEffects(session, overrides[j], target);
      rest = directFilterCrossNamespaceDestructiveOps(rest, resolution, session, overrides[j]);
      rest = directFilterVerifiedNativeEffectOps(target, rest, session, overrides[j]);
      if (!Object.keys(rest).length) continue;
      plan.push({ target: target, ops: rest, entry: overrides[j] });
    }

    for (var p = 0; p < plan.length; p++) {
      // Оверрайдов на документ — десятки тысяч, и все они применяются внутри
      // задачи корня. Общий бюджет сессии не даёт им занять поток целиком.
      await yieldIfNeeded(session.slice);
      await directApplyOps(plan[p].target, plan[p].ops, session, plan[p].entry, "rest");
    }
    return { skipped: skipped };
  }

  /**
   * Операции привязки к нативному стилю. Применяются ПОСЛЕ всех остальных:
   * назначенные следом сырые краски или типографика отцепили бы стиль.
   */
  var DIRECT_STYLE_OPS = {
    fillStyleId: { setter: "setFillStyleIdAsync", counter: "fillStyleBindings" },
    strokeStyleId: { setter: "setStrokeStyleIdAsync", counter: "strokeStyleBindings" },
    effectStyleId: { setter: "setEffectStyleIdAsync", counter: "effectStyleBindings" },
    textStyleId: { setter: "setTextStyleIdAsync", counter: "textStyleBindings" },
  };

  /**
   * Какие оси размера вложенного instance действительно принадлежат самому
   * вхождению перед swapComponent. Figma при swap переводит коробку на новый
   * master. Старый код безусловно возвращал обе старые оси, из-за чего HUG
   * компонент после подмены оставался шириной прежнего master (типичный итог:
   * текст badge переносится на две строки).
   *
   * Правило не знает имён компонентов: FIXED сохраняем, HUG/FILL отдаём
   * раскладке/новому master. Если API не даёт достаточной семантики —
   * консервативно сохраняем прежнее legacy-поведение по этой оси.
   */
  function directSwapSizeOwnership(target) {
    var out = { width: true, height: true };
    if (!target) return out;

    var mode = null, primary = null, counter = null;
    try { mode = target.layoutMode; } catch (_eMode) {}
    try { primary = target.primaryAxisSizingMode; } catch (_ePrimary) {}
    try { counter = target.counterAxisSizingMode; } catch (_eCounter) {}
    if (mode === "HORIZONTAL") {
      if (primary === "AUTO") out.width = false;
      if (counter === "AUTO") out.height = false;
    } else if (mode === "VERTICAL") {
      if (counter === "AUTO") out.width = false;
      if (primary === "AUTO") out.height = false;
    }

    // Размер, который отдаётся родителю auto layout, тоже не принадлежит
    // ребёнку. Не прибиваем его старым числом после подмены.
    var parentMode = null, grow = 0, align = null;
    try { parentMode = target.parent && target.parent.layoutMode; } catch (_eParent) {}
    try { grow = target.layoutGrow; } catch (_eGrow) {}
    try { align = target.layoutAlign; } catch (_eAlign) {}
    if (parentMode === "HORIZONTAL") {
      if (grow > 0) out.width = false;
      if (align === "STRETCH") out.height = false;
    } else if (parentMode === "VERTICAL") {
      if (grow > 0) out.height = false;
      if (align === "STRETCH") out.width = false;
    }
    return out;
  }

  /**
   * Коробка вхождения после подмены компонента.
   *
   * D56. Ось, которой вхождение владеет, возвращается прежним числом:
   * подмена компонента коробку вхождения не меняет.
   *
   * Ось, которую вхождение обнимает (HUG), принадлежит МАСТЕРУ — и берётся у
   * НОВОГО мастера, а не остаётся результатом пересчёта Figma. Пересчёт здесь
   * неверен, потому что считается уже после того, как вторая ось зажата
   * коробкой слота.
   *
   * Оба измеренных случая сходятся на этом правиле:
   *
   *   - вложенный HUG-swap: старый мастер 89 (hug), новый 109 → 109;
   *   - таб бокового меню: слот 32×32, новый мастер 232×32 при
   *     `primaryAxisSizingMode: FIXED` → высота 32. Без правила Figma
   *     переносила текст по ширине 32 и высота уходила на 252, из-за чего
   *     подпись «Главная» вставала в колонку по одной букве.
   *
   * Если источник действительно хочет другой размер, он приезжает отдельной
   * операцией `size` следом и перекрывает эту коробку, как и раньше.
   */
  function directRestoreOwnedSwapSize(target, before, owned, session, newMaster) {
    if (!before || !owned || typeof target.resizeWithoutConstraints !== "function") return;
    var width = before.width, height = before.height;
    // Размер нового мастера берётся ТОЛЬКО по тем осям, которые он сам
    // объявляет HUG. Ось, объявленную FIXED, мастер не пересчитывает, и
    // подставлять его натуральное число вместо коробки вхождения нельзя:
    // у таба бокового меню это растянуло бы слот с 32 до 232.
    var masterWidth = null, masterHeight = null;
    if (newMaster) {
      var masterMode = null, masterPrimary = null, masterCounter = null;
      try { masterMode = newMaster.layoutMode; } catch (_eMasterMode) {}
      try { masterPrimary = newMaster.primaryAxisSizingMode; } catch (_eMasterPrimary) {}
      try { masterCounter = newMaster.counterAxisSizingMode; } catch (_eMasterCounter) {}
      var masterHugsWidth = masterMode === "HORIZONTAL" ? masterPrimary === "AUTO" :
        (masterMode === "VERTICAL" ? masterCounter === "AUTO" : false);
      var masterHugsHeight = masterMode === "HORIZONTAL" ? masterCounter === "AUTO" :
        (masterMode === "VERTICAL" ? masterPrimary === "AUTO" : false);
      if (masterHugsWidth) { try { masterWidth = newMaster.width; } catch (_eMasterWidth) { masterWidth = null; } }
      if (masterHugsHeight) { try { masterHeight = newMaster.height; } catch (_eMasterHeight) { masterHeight = null; } }
    }
    try {
      if (!owned.width) width = typeof masterWidth === "number" && masterWidth > 0 ? masterWidth : target.width;
      if (!owned.height) height = typeof masterHeight === "number" && masterHeight > 0 ? masterHeight : target.height;
    } catch (_eRead) { directNote(session, "RESIZE_REJECTED"); return; }
    directResizePreservingTextSizing(target, width, height, session);
  }


  function directAuditMaterializedInstance(node, spec, session) {
    if (!node || !spec || spec.kind !== "INSTANCE" || !spec.definitionId) return;
    var activeDefinitionId = directDefinitionId(node, session);
    if (!activeDefinitionId) {
      directVisualMismatch(session, spec, "materializedDefinition.unverified",
        spec.definitionId, null);
      return;
    }
    if (activeDefinitionId !== spec.definitionId &&
        !directEquivalentDefinition(spec.definitionId, activeDefinitionId, session)) {
      directVisualMismatch(session, spec, "materializedDefinition",
        spec.definitionId, activeDefinitionId, {
          expectedVariant: session.definitionVariantIdentities[spec.definitionId] || null,
          actualVariant: session.definitionVariantIdentities[activeDefinitionId] || null,
          expectedComponentKey: session.definitionComponentKeys[spec.definitionId] || null,
          actualComponentKey: session.definitionComponentKeys[activeDefinitionId] || null,
        });
    }
  }

  async function directNativeEffectSnapshot(target, actualName, entry, session) {
    var kind = entry && entry.type === "INSTANCE_SWAP" ? "mainComponent" :
      (entry && entry.type === "BOOLEAN" ? "visible" :
      (entry && entry.type === "TEXT" ? "characters" : null));
    var bound = kind ? directNativeBoundNodes(target, actualName, kind, entry, session, true) : [];
    var out = [];
    if (entry && entry.type === "INSTANCE_SWAP") {
      var propertyDefinition = directInstanceSwapPropertyDefinition(target, actualName, session);
      var rawProperty = null;
      try { rawProperty = target.componentProperties && target.componentProperties[actualName] || null; } catch (_eRawProperty) {}
      out.push({
        via: "componentProperties",
        definitionId: propertyDefinition,
        figmaComponentId: rawProperty && rawProperty.value ? String(rawProperty.value) : null,
      });
    }
    for (var i = 0; i < bound.length && i < 8; i++) {
      var node = bound[i], row = { sourceId: directSourceId(node), type: nodeType(node) };
      if (entry.type === "BOOLEAN") row.visible = directVisualRead(node, "visible");
      else if (entry.type === "TEXT") row.characters = directVisualRead(node, "characters");
      else if (entry.type === "INSTANCE_SWAP") { row.definitionId = await directLiveMainDefinitionId(node, session); row.stampedDefinitionId = directDefinitionId(node, session); }
      out.push(row);
    }
    return out;
  }

  async function directAuditFinalMainComponent(instance, spec, session) {
    if (!instance || nodeType(instance) !== "INSTANCE" || !session || !session.finalMainComponentParity) return;
    var expected = directDefinitionId(instance, session) || (spec && spec.definitionId) || null;
    var main = null;
    try {
      if (typeof instance.getMainComponentAsync === "function") main = await instance.getMainComponentAsync();
      else main = instance.mainComponent || null;
    } catch (_eMainRead) { main = null; }
    var actual = null;
    try { actual = main && typeof main.getPluginData === "function"
      ? main.getPluginData("pixsoDirectDefinitionId") || null : null; } catch (_eDefRead) {}
    if (expected && actual && expected !== actual) {
      session.finalMainComponentParity.mismatches += 1;
      if (session.finalMainComponentParity.samples.length < session.finalMainComponentParity.limit) {
        session.finalMainComponentParity.samples.push({
          occurrenceId: spec && spec.id || directSourceId(instance) || null,
          occurrenceName: spec && spec.name || null, expectedDefinitionId: expected,
          actualDefinitionId: actual, instanceId: nodeIdentity(instance) || null,
          mainComponentId: nodeIdentity(main) || null
        });
      }
    }
    var ledger = session.componentIdentityLedger;
    if (ledger) {
      for (var i = ledger.occurrences.length - 1; i >= 0; i--) {
        var row = ledger.occurrences[i];
        if (row.occurrenceId !== (spec && spec.id)) continue;
        row.finalExpectedDefinitionId = expected;
        row.finalActualDefinitionId = actual;
        row.finalMainComponentId = nodeIdentity(main) || null;
        try { row.finalComponentSetId = main && main.parent && main.parent.type === "COMPONENT_SET"
          ? nodeIdentity(main.parent) : null; } catch (_eSet) { row.finalComponentSetId = null; }
        try { row.finalVariantProperties = instance.componentProperties ? clone(instance.componentProperties) :
          (instance.variantProperties ? clone(instance.variantProperties) : null); } catch (_eProps) {}
        break;
      }
    }
  }

  async function directAuditFinalNativeProperties(root, entries, session, rootSpec) {
    if (!root || !entries || !entries.length || !session.visualParity) return;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i] || {};
      var routedFinal = await directResolveNativePropertyTarget(root, entry, session);
      var resolution = routedFinal.resolution || {};
      var target = routedFinal.target;
      if (!target || nodeType(target) !== "INSTANCE") {
        directVisualMismatch(session, rootSpec, "native.target", entry.path || [], null, {
          propertyId: entry.propertyId || null, propertyType: entry.type || null,
          reason: resolution.reason || "TARGET_NOT_INSTANCE", deepest: resolution.deepest || 0,
        });
        continue;
      }
      var names = routedFinal.names || await directNativePropertyNamesForInstance(target, session);
      var actualName = routedFinal.actualName || (names && names[entry.propertyId]);
      if (!actualName) {
        directVisualMismatch(session, rootSpec, "native.propertyName", entry.propertyId || null, null, {
          propertyType: entry.type || null, path: entry.path || [],
        });
        continue;
      }
      var finalVerified = await directVerifyNativePropertyAsync(target, actualName, entry, session);
      await directSemanticEffectRecord(session, "final", target, actualName, entry, finalVerified);
      if (!finalVerified) {
        directVisualMismatch(session, rootSpec, "native." + (entry.type || "UNKNOWN") + ".effect",
          entry.type === "INSTANCE_SWAP" ? entry.swapDefinitionId : entry.value,
          await directNativeEffectSnapshot(target, actualName, entry, session), {
            propertyId: entry.propertyId || null, actualName: actualName, path: entry.path || [],
          });
      }
    }
  }

  function directAuditVisualOverride(target, ops, session, entry) {
    if (!target || !ops || !session || !session.visualParity) return;
    var pseudo = {
      id: directSourceId(target) || null,
      kind: target.type === "INSTANCE" ? "INSTANCE" : "OVERRIDE_TARGET",
      type: nodeType(target),
      definitionId: entry && entry.path && entry.path.length
        ? entry.path[entry.path.length - 1].definitionId || null : null,
      parent: null,
    };
    function mismatch(field, expected, actual, detail) {
      directVisualMismatch(session, pseudo, "override." + field, expected, actual, detail);
    }
    if (typeof ops.visible === "boolean") {
      var visible = directVisualRead(target, "visible");
      if (visible !== ops.visible) mismatch("visible", ops.visible, visible, { path: entry && entry.path || [] });
    }
    if (typeof ops.opacity === "number") {
      var opacity = directVisualRead(target, "opacity");
      if (!directVisualNumberEqual(ops.opacity, opacity, 0.0005)) mismatch("opacity", ops.opacity, opacity);
    }
    if (typeof ops.characters === "string" && target.type === "TEXT") {
      var characters = directVisualRead(target, "characters");
      if (characters !== ops.characters) mismatch("characters", ops.characters, characters);
    }
    if (typeof ops.clipsContent === "boolean") {
      var clipsContent = directVisualRead(target, "clipsContent");
      if (clipsContent !== ops.clipsContent) mismatch("clipsContent", ops.clipsContent, clipsContent);
    }
    if (ops.fills !== undefined) {
      var ef = directPaints(ops.fills, session), af = directVisualRead(target, "fills");
      if (ef && !directVisualPaintsEqual(ef, af)) mismatch("fills", ef, af, { fillStyleId: directVisualRead(target, "fillStyleId") || null });
    }
    if (ops.strokes !== undefined) {
      var es = directPaints(ops.strokes, session), as = directVisualRead(target, "strokes");
      if (es && !directVisualPaintsEqual(es, as)) mismatch("strokes", es, as, { strokeStyleId: directVisualRead(target, "strokeStyleId") || null });
    }
    if (ops.strokeWeight !== undefined) {
      var sw = directVisualRead(target, "strokeWeight");
      var sameWeight = directVisualNumberEqual(ops.strokeWeight, sw, 0.0005);
      // `figma.mixed` — не значение, а признак того, что толщина живёт во
      // втором представлении. Сверяется она там же, по сторонам: иначе
      // применённая толщина читалась бы как промах.
      if (!sameWeight && sw === figma.mixed) {
        sameWeight = DIRECT_STROKE_SIDE_KEYS.every(function (side) {
          return directVisualNumberEqual(ops.strokeWeight, directVisualRead(target, side), 0.0005);
        });
      }
      if (!sameWeight) {
        mismatch("strokeWeight", ops.strokeWeight, sw, {
          top: directVisualRead(target, "strokeTopWeight"), right: directVisualRead(target, "strokeRightWeight"),
          bottom: directVisualRead(target, "strokeBottomWeight"), left: directVisualRead(target, "strokeLeftWeight")
        });
      }
    }
    if (ops.strokeStyle) {
      var ss = ops.strokeStyle;
      ["strokeAlign", "strokeJoin", "strokeCap", "dashPattern"].forEach(function (field) {
        if (ss[field] === undefined) return;
        var actual = directVisualRead(target, field);
        if (!directVisualEqual(ss[field], actual)) mismatch(field, ss[field], actual);
      });
      if (ss.borderWeights) {
        [["strokeTopWeight","top"],["strokeRightWeight","right"],["strokeBottomWeight","bottom"],["strokeLeftWeight","left"]].forEach(function (pair) {
          if (ss.borderWeights[pair[1]] === undefined) return;
          var actual = directVisualRead(target, pair[0]);
          if (!directVisualNumberEqual(ss.borderWeights[pair[1]], actual, 0.0005)) mismatch(pair[0], ss.borderWeights[pair[1]], actual);
        });
      }
    }
    [["fillStyleId", "fillStyleId"], ["strokeStyleId", "strokeStyleId"],
      ["effectStyleId", "effectStyleId"], ["textStyleId", "textStyleId"]].forEach(function (pair) {
      var sourceStyleId = ops[pair[0]];
      if (!sourceStyleId) return;
      var expectedHostId = directExpectedStyleHostId(sourceStyleId, session);
      if (!expectedHostId) return;
      var actualHostId = directVisualRead(target, pair[1]);
      if (actualHostId !== expectedHostId) {
        mismatch(pair[1] + ".binding",
          { sourceStyleId: sourceStyleId, figmaStyleId: expectedHostId },
          { figmaStyleId: actualHostId || null });
      }
    });

    if (ops.placement) {
      var expectedX = ops.placement.relativeTransform ? ops.placement.relativeTransform[0][2] : ops.placement.x;
      var expectedY = ops.placement.relativeTransform ? ops.placement.relativeTransform[1][2] : ops.placement.y;
      var transform = directVisualRead(target, "relativeTransform");
      var actualX = transform && transform[0] ? transform[0][2] : directVisualRead(target, "x");
      var actualY = transform && transform[1] ? transform[1][2] : directVisualRead(target, "y");
      if ((typeof expectedX === "number" && !directVisualNumberEqual(expectedX, actualX, 0.25)) ||
          (typeof expectedY === "number" && !directVisualNumberEqual(expectedY, actualY, 0.25))) {
        mismatch("placement", { x: expectedX, y: expectedY }, { x: actualX, y: actualY }, { path: entry && entry.path || [] });
      }
    }
  }

  async function directApplyOps(target, ops, session, entry, phase) {
    var textBefore = directTextSnapshot(target);
    // Ключи переупорядочены намеренно: привязка стиля обязана лечь поверх
    // уже применённой дельты, иначе следующая же сырая операция её снимет.
    var keys = Object.keys(ops).sort(function (left, right) {
      return (DIRECT_STYLE_OPS[left] ? 1 : 0) - (DIRECT_STYLE_OPS[right] ? 1 : 0);
    });
    // Диагностика: снимок ДО каждой операции. Стоит она ровно столько, сколько
    // стоит проверка на null, пока список guid не задан.
    var tracedOp = session.sizeTrace ? (session.sizeTraceInstanceId || null) : null;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var applied = true;
      // Причина промаха именно ЭТОЙ операции. Пусто — значит причина общая
      // («хост отказал»), и тогда работает прежний обобщённый код. Операция,
      // которая знает свою причину, обязана её назвать: иначе отказ по
      // жизненному циклу определения растворяется в
      // `OVERRIDE_OPERATION_REJECTED` и снова читается как отказ адресации.
      var opMissReason = null;
      var stageBeforeOp = session.stageTrace ? directStageSnapshot(target) : null;
      var boxBeforeOp = null;
      if (tracedOp) {
        try { boxBeforeOp = { w: target.width, h: target.height }; } catch (_eOpBox) { boxBeforeOp = null; }
      }
      switch (key) {
        case "swapDefinitionId": {
          var swapState = directDefinitionState(session, ops.swapDefinitionId);
          if (!swapState.available) {
            // Подмена не состоялась по той же причинной семье, что и
            // несозданный инстанс: определение недоступно. Общий
            // OVERRIDE_SWAP_REJECTED прятал это среди отказов хоста.
            applied = false;
            opMissReason = "OVERRIDE_SWAP_DEFINITION_UNAVAILABLE";
            await directTraceDefinition(session, ops.swapDefinitionId, swapState,
              directSourceId(target));
            directCountDefinitionUnavailable(session, ops.swapDefinitionId, swapState.subreason);
            directNote(session, "OVERRIDE_SWAP_DEFINITION_UNAVAILABLE");
            break;
          }
          var component = swapState.component;
          if (target.type !== "INSTANCE" || typeof target.swapComponent !== "function") {
            applied = false;
            directNote(session, "OVERRIDE_SWAP_REJECTED");
            break;
          }
          // Подмена переводит инстанс на габарит нового мастера. В Pixso
          // подмена компонента коробку вхождения не меняет, поэтому размер
          // возвращается. Если источник действительно хочет другой размер,
          // он приедет отдельной операцией `size` следом.
          var sizeBefore = null;
          var definitionBeforeSwap = directDefinitionId(target, session);
          var fromVariantGroup = definitionBeforeSwap ? directVariantGroupOfDefinition(session, definitionBeforeSwap) : "";
          var toVariantGroup = directVariantGroupOfDefinition(session, ops.swapDefinitionId);
          var fromVariantFamily = fromVariantGroup && session.variantGroups[fromVariantGroup]
            ? session.variantGroups[fromVariantGroup].stableFamilyKey || "" : "";
          var toVariantFamily = toVariantGroup && session.variantGroups[toVariantGroup]
            ? session.variantGroups[toVariantGroup].stableFamilyKey || "" : "";
          var sameVariantFamily = !!(fromVariantGroup && toVariantGroup &&
            (fromVariantGroup === toVariantGroup ||
             (fromVariantFamily && toVariantFamily && fromVariantFamily === toVariantFamily)));
          var sizeOwnedBefore = directSwapSizeOwnership(target);
          var childSlotBefore = directChildSlotSnapshot(target);
          try { sizeBefore = { width: target.width, height: target.height }; }
          catch (_eBox) { sizeBefore = null; }
          // D57. This is replay of Pixso's serialized low-level
          // `overriddenSymbolID`, not an interactive editor swap. Figma's
          // swapComponent() intentionally PRESERVES overrides by editor
          // heuristics; that can keep stale children/state from the old master
          // (e.g. text surviving a text->icon cell swap, or an old pagination
          // glyph surviving an icon swap). The .pix stream already contains
          // the authoritative descendant overrides, so use a clean component
          // assignment and replay those records afterwards. Figma documents
          // `mainComponent = ...` as the non-preserving swap path.
          // D60. Clear direct overrides on the OLD nested instance before the
          // clean master assignment. In live Figma an ancestor instance can
          // leave materialized descendant overrides attached to the nested
          // slot even though `mainComponent = ...` changes the master. Those
          // stale descendants are exactly how a text-cell label can survive a
          // text->icon Pixso swap. The .pix override stream is authoritative
          // and is replayed below, so preserving old direct overrides here is
          // always wrong. `resetOverrides()` is the public API equivalent
          // (deprecated name, still public; `removeOverrides` is partner-only).
          if (typeof target.resetOverrides === "function") {
            try {
              target.resetOverrides();
              session.totals.lowLevelSwapOverridesReset =
                (session.totals.lowLevelSwapOverridesReset || 0) + 1;
            } catch (_eResetSwapOverrides) {
              directNote(session, "LOW_LEVEL_SWAP_RESET_OVERRIDES_REJECTED");
            }
          }
          try { target.mainComponent = component; }
          catch (_eSwap) { applied = false; directNote(session, "OVERRIDE_SWAP_REJECTED"); break; }
          session.totals.cleanLowLevelSwaps = (session.totals.cleanLowLevelSwaps || 0) + 1;
          // Подмена сменила активное определение узла: отпечаток обязан
          // поехать вместе с ней, иначе следующие шаги будут проверяться
          // против определения, которого здесь уже нет.
          setPluginData(target, "pixsoDirectDefinitionId", ops.swapDefinitionId);
          var swappedIdentity = nodeIdentity(target);
          if (swappedIdentity) {
            session.swappedDefinitions[swappedIdentity] = ops.swapDefinitionId;
            session.swapProvenance[swappedIdentity] = {
              fromDefinitionId: definitionBeforeSwap || null,
              toDefinitionId: ops.swapDefinitionId,
              fromVariantGroup: fromVariantGroup || null,
              toVariantGroup: toVariantGroup || null,
              fromVariantFamily: fromVariantFamily || null,
              toVariantFamily: toVariantFamily || null,
              sameVariantFamily: sameVariantFamily
            };
          }
          directRestoreChildSlot(target, childSlotBefore, session);
          directRestoreOwnedSwapSize(target, sizeBefore, sizeOwnedBefore, session, component);
          break;
        }
        case "characters": {
          if (target.type !== "TEXT") { applied = false; directNote(session, "OVERRIDE_TEXT_ON_NON_TEXT"); break; }
          if (typeof ops.characters !== "string") {
            applied = false;
            directNote(session, "OVERRIDE_TEXT_VALUE_INVALID");
            break;
          }
          var charactersBefore = directTextValue(target, "characters");
          var fontStartedAt = Date.now();
          var ready = await directLoadNodeFont(target);
          session.timings.fontMs += Date.now() - fontStartedAt;
          if (!ready) { applied = false; directNote(session, "FONT_UNAVAILABLE"); break; }
          try { target.characters = ops.characters; }
          catch (_eText) { applied = false; directNote(session, "OVERRIDE_TEXT_REJECTED"); }
          if (applied) {
            var charactersAfter = directTextValue(target, "characters");
            // Даже после presence-фильтра проверяем фактический результат:
            // host/API не имеет права опустошить текст при непустой правке.
            if (charactersBefore && charactersAfter === "" && ops.characters !== "") {
              try { target.characters = charactersBefore; } catch (_eRestoreText) {}
              applied = false;
              session.totals.textClearsBlocked += 1;
              session.totals.blockedImplicitTextClears += 1;
              directNote(session, "OVERRIDE_IMPLICIT_TEXT_CLEAR_BLOCKED");
            } else {
              session.totals.textOverridesApplied += 1;
              if (charactersBefore === charactersAfter) session.totals.textOverridesNoOp += 1;
              else session.totals.explicitTextChanges += 1;
              if (charactersBefore && charactersAfter === "" && ops.characters === "") {
                session.totals.textClearsExplicit += 1;
                session.totals.explicitTextClears += 1;
              }
            }
          }
          break;
        }
        case "size": {
          if (typeof target.resizeWithoutConstraints !== "function") { applied = false; break; }
          applied = directResizePreservingTextSizing(target, ops.size.width, ops.size.height, session);
          if (!applied) directNote(session, "OVERRIDE_RESIZE_REJECTED");
          break;
        }
        case "textBoxWidth": {
          if (target.type !== "TEXT" || typeof ops.textBoxWidth !== "number" ||
              typeof target.resizeWithoutConstraints !== "function") {
            applied = false;
            directNote(session, "OVERRIDE_TEXT_BOX_WIDTH_REJECTED");
            break;
          }
          applied = directResizePreservingTextSizing(target, ops.textBoxWidth, target.height, session);
          if (!applied) directNote(session, "OVERRIDE_TEXT_BOX_WIDTH_REJECTED");
          break;
        }
        case "placement": {
          applied = false;
          if (ops.placement && ops.placement.relativeTransform) {
            applied = directSet(target, "relativeTransform", ops.placement.relativeTransform) || applied;
          } else {
            if (ops.placement && ops.placement.x !== undefined) {
              applied = directSet(target, "x", ops.placement.x) || applied;
            }
            if (ops.placement && ops.placement.y !== undefined) {
              applied = directSet(target, "y", ops.placement.y) || applied;
            }
            if (ops.placement && ops.placement.rotation !== undefined) {
              applied = directSet(target, "rotation", ops.placement.rotation) || applied;
            }
          }
          if (!applied) directNote(session, "OVERRIDE_TRANSFORM_REJECTED");
          break;
        }
        case "fills": {
          var expectedFillsNoOp = directPaints(ops.fills, session);
          var liveFillsNoOp = directVisualRead(target, "fills");
          if (expectedFillsNoOp && directVisualPaintsEqual(expectedFillsNoOp, liveFillsNoOp)) {
            applied = true;
            session.totals.redundantPaintOverridesSuppressed =
              (session.totals.redundantPaintOverridesSuppressed || 0) + 1;
          } else {
            applied = directApplyPaintOp(session, target, "fills", ops.fills);
          }
          if (!applied) directNote(session, "OVERRIDE_FILLS_REJECTED");
          break;
        }
        case "strokes": {
          var expectedStrokesNoOp = directPaints(ops.strokes, session);
          var liveStrokesNoOp = directVisualRead(target, "strokes");
          if (expectedStrokesNoOp && directVisualPaintsEqual(expectedStrokesNoOp, liveStrokesNoOp)) {
            applied = true;
            session.totals.redundantPaintOverridesSuppressed =
              (session.totals.redundantPaintOverridesSuppressed || 0) + 1;
          } else {
            applied = directApplyPaintOp(session, target, "strokes", ops.strokes);
          }
          if (!applied) directNote(session, "OVERRIDE_STROKES_REJECTED");
          break;
        }
        case "corners":
          applied = directApplyCorners(target, ops.corners);
          break;
        case "effects":
          applied = Array.isArray(ops.effects) && directSet(target, "effects", ops.effects);
          if (!applied) directNote(session, "OVERRIDE_EFFECTS_REJECTED");
          break;
        case "layout": {
          // Раскладка уже стоит из определения: запись override приходит
          // частичной и меняет только перечисленные в ней поля. layoutMode
          // здесь не трогается намеренно.
          applied = false;
          var layoutKeys = Object.keys(ops.layout || {});
          // Габарит ДО правки: если правка вернула оси HUG, а обнимать по ней
          // нечего, вернуть придётся именно его.
          var layoutWidth = target.width;
          var layoutHeight = target.height;
          for (var lk = 0; lk < layoutKeys.length; lk++) {
            applied = directSet(target, layoutKeys[lk], ops.layout[layoutKeys[lk]]) || applied;
          }
          if (!applied) directNote(session, "OVERRIDE_LAYOUT_REJECTED");
          break;
        }
        case "sizeBounds": {
          directApplySizeBounds(target, ops.sizeBounds, session);
          applied = true;
          break;
        }
        case "childLayout": {
          applied = directApplyChildLayout(target, ops.childLayout);
          if (!applied) directNote(session, "OVERRIDE_CHILD_LAYOUT_REJECTED");
          break;
        }
        case "aspectRatioLocked":
          try {
            if (ops.aspectRatioLocked && typeof target.lockAspectRatio === "function") target.lockAspectRatio();
            else if (!ops.aspectRatioLocked && typeof target.unlockAspectRatio === "function") target.unlockAspectRatio();
            else directSet(target, "constrainProportions", !!ops.aspectRatioLocked);
            applied = true;
          } catch (_eAspectOverride) { directNote(session, "ASPECT_RATIO_REJECTED"); }
          break;
        case "constraints": {
          // Figma does not allow every constraint mutation below a native
          // INSTANCE. This is a semantic-editability limitation, not
          // necessarily a visual failure: constraints affect future parent
          // resizes and do not change the current box by themselves. First
          // accept an already-equal readback as a verified no-op. If the host
          // still rejects a nested INSTANCE constraint, keep it as an explicit
          // semantic diagnostic without poisoning current visual safety.
          applied = directSet(target, "constraints", ops.constraints);
          if (!applied) {
            var actualConstraints = null;
            try { actualConstraints = target.constraints; } catch (_eConstraintRead) {}
            if (actualConstraints && ops.constraints &&
                actualConstraints.horizontal === ops.constraints.horizontal &&
                actualConstraints.vertical === ops.constraints.vertical) {
              applied = true;
            } else if (target.type === "INSTANCE" && entry && entry.path && entry.path.length) {
              opMissReason = "OVERRIDE_CONSTRAINTS_UNSUPPORTED";
              directNote(session, "OVERRIDE_CONSTRAINTS_UNSUPPORTED");
            } else {
              opMissReason = "OVERRIDE_CONSTRAINTS_REJECTED";
              directNote(session, "OVERRIDE_CONSTRAINTS_REJECTED");
            }
          }
          break;
        }
        case "strokeStyle": {
          applied = false;
          var style = ops.strokeStyle || {};
          ["strokeAlign", "strokeJoin", "strokeCap", "dashPattern"].forEach(function (key) {
            if (style[key] !== undefined) applied = directSet(target, key, style[key]) || applied;
          });
          if (style.borderWeights) {
            applied = directApplyStrokeWeights(target, undefined, style.borderWeights) || applied;
          }
          if (!applied) directNote(session, "OVERRIDE_STROKE_STYLE_REJECTED");
          break;
        }
        case "textStyle": {
          if (target.type !== "TEXT") { applied = false; directNote(session, "OVERRIDE_TEXT_ON_NON_TEXT"); break; }
          // Любая правка типографики требует загруженного шрифта — включая
          // смену самого шрифта: Figma грузит тот, который назначается.
          var textFontStartedAt = Date.now();
          var textReady = await directLoadNodeFont(target);
          var textStyle = ops.textStyle || {};
          var newFontReady = true;
          if (textStyle.fontName) {
            try { await loadFontCached(textStyle.fontName); }
            catch (_eNewFont) { newFontReady = false; directNote(session, "FONT_UNAVAILABLE"); }
          }
          session.timings.fontMs += Date.now() - textFontStartedAt;
          if (!textReady) { applied = false; directNote(session, "FONT_UNAVAILABLE"); break; }
          applied = false;
          var textKeys = Object.keys(textStyle);
          // A partial text override can create the incompatible pair without
          // mentioning textAutoResize at all (for example it only enables
          // ENDING/maxLines over a WIDTH_AND_HEIGHT master). Evaluate the
          // merged final state, not just the fields present in this delta.
          var finalOverrideAuto = textStyle.textAutoResize;
          var finalOverrideTruncation = textStyle.textTruncation;
          var finalOverrideMaxLines = textStyle.maxLines;
          try {
            if (finalOverrideAuto === undefined) finalOverrideAuto = target.textAutoResize;
            if (finalOverrideTruncation === undefined) finalOverrideTruncation = target.textTruncation;
            if (finalOverrideMaxLines === undefined) finalOverrideMaxLines = target.maxLines;
          } catch (_eTextTruncationRead) {}
          var effectiveOverrideAuto = directEffectiveTextAutoResize({
            textAutoResize: finalOverrideAuto,
            textTruncation: finalOverrideTruncation,
            maxLines: finalOverrideMaxLines,
          });
          for (var tk = 0; tk < textKeys.length; tk++) {
            // The sizing trio has ordering semantics and is committed below.
            if (textKeys[tk] === "textAutoResize" || textKeys[tk] === "textTruncation" ||
                textKeys[tk] === "maxLines") continue;
            // Недоступный шрифт роняет только смену шрифта: размер, трекинг и
            // выравнивание того же вхождения переносятся как обычно.
            if (textKeys[tk] === "fontName" && !newFontReady) continue;
            applied = directSet(target, textKeys[tk], textStyle[textKeys[tk]]) || applied;
          }
          // Characters are already present here. Commit width ownership
          // first, then truncation and its line cap, matching directApplyText.
          // Also write the effective mode for a partial ENDING override: that
          // is the case that previously left the inherited width-HUG active.
          var overrideSizingConflict = effectiveOverrideAuto !== finalOverrideAuto;
          if (textStyle.textAutoResize !== undefined || overrideSizingConflict) {
            applied = directSet(target, "textAutoResize", effectiveOverrideAuto) || applied;
          }
          if (textStyle.textTruncation !== undefined) {
            applied = directSet(target, "textTruncation", textStyle.textTruncation) || applied;
          }
          if (textStyle.maxLines !== undefined) {
            applied = directSet(target, "maxLines", textStyle.maxLines) || applied;
          }
          if (applied && Object.prototype.hasOwnProperty.call(textStyle, "textStyleId") &&
              (textStyle.textStyleId === "" || textStyle.textStyleId === null)) {
            session.totals.textStyleClearsExplicit += 1;
            session.totals.styleClears += 1;
          }
          if (!applied) directNote(session, "OVERRIDE_TEXT_STYLE_REJECTED");
          // Nested instance children are not part of the root-spec final
          // semantic pass.  When Pixso explicitly changes textAutoResize on
          // such a child, commit the corresponding Figma W/H dropdowns here
          // as well; otherwise the child can keep the canonical FIXED width
          // while characters update, producing one-letter wrapping.
          if (Object.prototype.hasOwnProperty.call(textStyle, "textAutoResize")) {
            var nestedAuto = effectiveOverrideAuto;
            if (nestedAuto === "WIDTH_AND_HEIGHT") {
              directSet(target, "layoutSizingHorizontal", "HUG");
              directSet(target, "layoutSizingVertical", "HUG");
            } else if (nestedAuto === "HEIGHT") {
              directSet(target, "layoutSizingHorizontal", "FIXED");
              directSet(target, "layoutSizingVertical", "HUG");
            } else if (nestedAuto === "NONE") {
              directSet(target, "layoutSizingHorizontal", "FIXED");
              directSet(target, "layoutSizingVertical", "FIXED");
            }
          }
          break;
        }
        case "clipsContent":
          applied = directSet(target, "clipsContent", ops.clipsContent);
          break;
        case "locked":
          applied = directSet(target, "locked", ops.locked);
          break;
        case "name":
          applied = directSet(target, "name", ops.name);
          break;
        case "visible":
          var visibleBefore = directTextValue(target, "visible");
          applied = typeof ops.visible === "boolean" && directSet(target, "visible", ops.visible);
          if (applied && target.type === "TEXT" && visibleBefore !== ops.visible) {
            session.totals.textVisibilityChanges += 1;
            session.totals.visibilityChanges += 1;
          }
          break;
        case "opacity":
          applied = typeof ops.opacity === "number" && directSet(target, "opacity", ops.opacity);
          break;
        case "blendMode":
          applied = directSet(target, "blendMode", ops.blendMode);
          break;
        case "isMask":
          applied = directSet(target, "isMask", ops.isMask);
          break;
        case "maskType":
          applied = directSet(target, "maskType", ops.maskType);
          break;
        case "strokeWeight":
          applied = directApplyStrokeWeights(target, ops.strokeWeight,
            ops.strokeStyle && ops.strokeStyle.borderWeights, true);
          break;
        case "fillStyleId":
        case "strokeStyleId":
        case "effectStyleId":
        case "textStyleId": {
          if (key === "textStyleId" && target.type !== "TEXT") {
            applied = false;
            directNote(session, "OVERRIDE_TEXT_ON_NON_TEXT");
            break;
          }
          var binding = DIRECT_STYLE_OPS[key];
          var boundBefore = session.totals[binding.counter];
          await directBindStyle(target, ops[key], session, binding.setter, binding.counter);
          applied = session.totals[binding.counter] > boundBefore;
          break;
        }
        default:
          applied = false;
          directNote(session, "OVERRIDE_OP_UNKNOWN");
      }
      // Операция, ИЗМЕНИВШАЯ габарит, называется поимённо. Остальные в след
      // не идут: диагностика должна показывать виновника, а не поток.
      if (tracedOp && boxBeforeOp) {
        var boxAfterOp = null;
        try { boxAfterOp = { w: target.width, h: target.height }; } catch (_eAfterBox) { boxAfterOp = null; }
        if (boxAfterOp &&
            (boxAfterOp.w !== boxBeforeOp.w || boxAfterOp.h !== boxBeforeOp.h)) {
          directSizeStage(session, tracedOp, "after-op:" + key, target,
            "габарит " + boxBeforeOp.w + "x" + boxBeforeOp.h +
            " → " + boxAfterOp.w + "x" + boxAfterOp.h +
            " (цель " + (entry && entry.path && entry.path.length ? "вложенная" : "корень вхождения") +
            ", применено=" + applied + ")");
        }
      }
      directStageRecord(session, "low-level-" + (phase || "unknown"), target, stageBeforeOp, {
        path: entry && entry.path || [], op: key, applied: applied,
        explicit: entry ? directOpExplicit(entry, key) : null,
      }, false);
      if (applied) session.totals.overridesApplied += 1;
      else {
        session.totals.overridesMissed += 1;
        var reason = opMissReason || "OVERRIDE_OPERATION_REJECTED";
        // A constraint mutation rejected below a native instance loses only
        // future resize semantics. The current source geometry is already
        // materialized, so it must not be reported as a visual-fidelity loss.
        if (reason !== "OVERRIDE_CONSTRAINTS_UNSUPPORTED") {
          directMarkUnsafe(session, reason, 1);
        }
        session.overrideMissReasons[reason] = (session.overrideMissReasons[reason] || 0) + 1;
      }
    }
    directAuditVisualOverride(target, ops, session, entry);
    directRecordTextTrace(session, entry, textBefore, directTextSnapshot(target));
  }

  // -------------------------------------------------------------------------
  // Определения
  // -------------------------------------------------------------------------

  /** Кладёт определение на полку служебной страницы, не перекрывая соседей. */
  function directPlaceOnShelf(session, component) {
    var width = 0;
    var height = 0;
    try { width = component.width; height = component.height; } catch (_eBox) { width = height = 0; }
    if (session.shelf.x > 0 && session.shelf.x + width > DIRECT_SHELF_WIDTH) {
      session.shelf.x = 0;
      session.shelf.y += session.shelf.rowHeight + DIRECT_SHELF_GAP;
      session.shelf.rowHeight = 0;
    }
    setValue(component, "x", session.shelf.x);
    setValue(component, "y", session.shelf.y);
    session.shelf.x += width + DIRECT_SHELF_GAP;
    if (height > session.shelf.rowHeight) session.shelf.rowHeight = height;
  }

  // -------------------------------------------------------------------------
  // Финальная раскладка служебной страницы
  //
  // Полка времени сборки раскладывает определение в порядке поступления и по
  // габариту, известному НА ТОТ МОМЕНТ. Для набора вариантов этот габарит —
  // не его: набор собирается ДО наполнения участников содержимым (иначе
  // переселение мастера переразрешает уже созданные вхождения), то есть в
  // момент постановки на полку он состоит из пустых компонентов и вырастает
  // потом. Отсюда и наложения соседей, и «обрезанный» набор: его коробка
  // осталась от пустых участников, лежащих к тому же все в одной точке.
  //
  // Лечится это не подпоркой на полке, а вторым проходом: когда доехало всё,
  // страница раскладывается один раз по окончательным габаритам. Проход
  // ничего не создаёт и не удаляет — меняются только x/y верхнего уровня,
  // x/y участников внутри наборов и коробка самих наборов. Вхождения от
  // этого не двигаются: мастер и вхождение в Figma имеют независимые
  // координаты.
  // -------------------------------------------------------------------------

  /** Габарит узла. Мёртвый или нечитаемый узел даёт нули, а не исключение. */
  function directBoxOf(node) {
    try { return { w: Number(node.width) || 0, h: Number(node.height) || 0 }; }
    catch (_eBox) { return { w: 0, h: 0 }; }
  }

  function directResizeBox(node, width, height) {
    var w = Math.max(1, Math.round(width));
    var h = Math.max(1, Math.round(height));
    try {
      if (typeof node.resizeWithoutConstraints === "function") { node.resizeWithoutConstraints(w, h); return true; }
      if (typeof node.resize === "function") { node.resize(w, h); return true; }
    } catch (_eResize) {}
    return false;
  }

  /**
   * Имя участника, разобранное в оси: «Size=M, State=Hover» → пары.
   * Имя, не раскладывающееся в пары целиком, координатой не считается.
   */
  function directVariantAxisPairs(component) {
    var name = "";
    try { name = String(component.name || ""); } catch (_eName) { return null; }
    if (!name) return null;
    var parts = name.split(",");
    var pairs = [];
    for (var i = 0; i < parts.length; i++) {
      var at = parts[i].indexOf("=");
      if (at < 0) return null;
      var axisName = parts[i].slice(0, at).trim();
      if (!axisName) return null;
      pairs.push({ axis: axisName, value: parts[i].slice(at + 1).trim() });
    }
    return pairs.length ? pairs : null;
  }

  /**
   * Клетка сетки для каждого участника: столбец — значение ПОСЛЕДНЕЙ оси,
   * строка — комбинация остальных. Это раскладка самой Figma, и семейство
   * читается по ней так же, как читалось бы в редакторе.
   *
   * Семейство, чьи имена в оси не раскладываются или раскладываются
   * по-разному, укладывается квадратом по порядку следования. Это не попытка
   * угадать семантику, а гарантия, что участники не лягут друг на друга.
   */
  function directVariantGridCells(members) {
    var pairsOf = [], signature = null, uniform = members.length > 0;
    for (var i = 0; i < members.length; i++) {
      var pairs = directVariantAxisPairs(members[i]);
      pairsOf.push(pairs);
      if (!pairs) { uniform = false; continue; }
      var own = pairs.map(function (pair) { return pair.axis; }).join("|");
      if (signature === null) signature = own;
      else if (signature !== own) uniform = false;
    }
    if (!uniform || signature === null) {
      var columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
      return members.map(function (_member, index) {
        return { row: Math.floor(index / columns), column: index % columns };
      });
    }
    var columnKeys = [], rowKeys = [], cells = [];
    for (var m = 0; m < members.length; m++) {
      var memberPairs = pairsOf[m];
      var multiAxis = memberPairs.length > 1;
      var last = memberPairs[memberPairs.length - 1];
      var columnKey = multiAxis ? last.axis + "=" + last.value : "";
      var rowKey = (multiAxis ? memberPairs.slice(0, -1) : memberPairs)
        .map(function (pair) { return pair.axis + "=" + pair.value; }).join(", ");
      if (columnKeys.indexOf(columnKey) < 0) columnKeys.push(columnKey);
      if (rowKeys.indexOf(rowKey) < 0) rowKeys.push(rowKey);
      cells.push({ columnKey: columnKey, rowKey: rowKey });
    }
    return cells.map(function (cell) {
      return { row: rowKeys.indexOf(cell.rowKey), column: columnKeys.indexOf(cell.columnKey) };
    });
  }

  /**
   * Раскладывает участников набора сеткой с шагом DIRECT_VARIANT_GAP и
   * подгоняет коробку набора под них. Возвращает итоговый габарит либо null,
   * если раскладывать нечего.
   */
  function directLayoutVariantSet(set) {
    if (nodeType(set) !== "COMPONENT_SET") return null;
    var mode = null;
    try { mode = set.layoutMode; } catch (_eMode) { mode = null; }
    // Набор с auto layout распоряжается детьми сам: чужая раскладка поверх
    // него была бы не порядком, а спором двух раскладок.
    if (mode && mode !== "NONE") return null;
    var children = [];
    try { children = (set.children || []).slice(); } catch (_eChildren) { return null; }
    var members = children.filter(function (child) {
      return isAlive(child) && nodeType(child) === "COMPONENT";
    });
    if (!members.length) return null;

    var cells = directVariantGridCells(members);
    var columnWidth = [], rowHeight = [];
    for (var i = 0; i < members.length; i++) {
      var box = directBoxOf(members[i]);
      var cell = cells[i];
      columnWidth[cell.column] = Math.max(columnWidth[cell.column] || 0, box.w);
      rowHeight[cell.row] = Math.max(rowHeight[cell.row] || 0, box.h);
    }
    var columnX = [], rowY = [], offset = DIRECT_VARIANT_PADDING;
    for (var c = 0; c < columnWidth.length; c++) {
      columnX[c] = offset;
      offset += (columnWidth[c] || 0) + DIRECT_VARIANT_GAP;
    }
    var totalWidth = offset - DIRECT_VARIANT_GAP + DIRECT_VARIANT_PADDING;
    offset = DIRECT_VARIANT_PADDING;
    for (var r = 0; r < rowHeight.length; r++) {
      rowY[r] = offset;
      offset += (rowHeight[r] || 0) + DIRECT_VARIANT_GAP;
    }
    var totalHeight = offset - DIRECT_VARIANT_GAP + DIRECT_VARIANT_PADDING;

    // Сначала места участников, потом коробка: все координаты положительны,
    // поэтому набор может только вырасти вправо и вниз — начало отсчёта не
    // уезжает и разложенные участники не сдвигаются под ним.
    for (var m = 0; m < members.length; m++) {
      setValue(members[m], "x", columnX[cells[m].column]);
      setValue(members[m], "y", rowY[cells[m].row]);
    }
    directResizeBox(set, totalWidth, totalHeight);
    return { width: totalWidth, height: totalHeight, members: members.length };
  }

  /**
   * Ключ семейства для группировки на полке: след, оставленный сборкой
   * набора, а если его нет — имя определения до первого «/». Видимое имя
   * здесь запасной вариант: группировать по нему одному значило бы
   * группировать по случайности.
   */
  function directShelfFamilyKey(node) {
    var family = "";
    try {
      if (typeof node.getPluginData === "function") family = node.getPluginData("pixsoDirectVariantFamily") || "";
    } catch (_eFamily) { family = ""; }
    if (family) return family;
    var name = "";
    try { name = String(node.name || ""); } catch (_eName) { name = ""; }
    var slash = name.indexOf("/");
    return slash > 0 ? name.slice(0, slash).trim() : name;
  }

  /**
   * Пересобирает служебную страницу по окончательным габаритам: наборы
   * раскладываются внутри, верхний уровень группируется по семействам, каждое
   * семейство начинается с новой строки.
   */
  function directLayoutServicePage(session) {
    var page = session.registry && session.registry[DIRECT_SERVICE_PAGE.slot];
    if (!isPageAlive(page)) page = findServicePage(DIRECT_SERVICE_PAGE.role);
    if (!isPageAlive(page)) return null;
    var children = [];
    try { children = (page.children || []).slice(); } catch (_eChildren) { return null; }

    var items = [], setsLaidOut = 0;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (!isAlive(child)) continue;
      var type = nodeType(child);
      if (type !== "COMPONENT" && type !== "COMPONENT_SET") continue;
      if (type === "COMPONENT_SET" && directLayoutVariantSet(child)) setsLaidOut += 1;
      var itemName = "";
      try { itemName = String(child.name || ""); } catch (_eItemName) { itemName = ""; }
      items.push({ node: child, family: directShelfFamilyKey(child), name: itemName, box: directBoxOf(child) });
    }
    if (!items.length) return { families: 0, items: 0, sets: 0 };

    var families = [], byFamily = Object.create(null);
    for (var it = 0; it < items.length; it++) {
      if (!byFamily[items[it].family]) { byFamily[items[it].family] = []; families.push(items[it].family); }
      byFamily[items[it].family].push(items[it]);
    }
    families.sort(function (left, right) { return left < right ? -1 : left > right ? 1 : 0; });

    var y = 0;
    for (var f = 0; f < families.length; f++) {
      var members = byFamily[families[f]];
      members.sort(function (left, right) {
        if (left.name !== right.name) return left.name < right.name ? -1 : 1;
        return 0;
      });
      var x = 0, rowHeight = 0;
      for (var m = 0; m < members.length; m++) {
        var box = members[m].box;
        if (x > 0 && x + box.w > DIRECT_SHELF_WIDTH) {
          x = 0; y += rowHeight + DIRECT_SHELF_GAP; rowHeight = 0;
        }
        setValue(members[m].node, "x", x);
        setValue(members[m].node, "y", y);
        x += box.w + DIRECT_SHELF_GAP;
        if (box.h > rowHeight) rowHeight = box.h;
      }
      y += rowHeight + DIRECT_FAMILY_GAP;
    }
    // Полка продолжается с чистой строки: определение, доехавшее после
    // финальной раскладки, ляжет ПОД неё, а не поверх разложенного.
    session.shelf.x = 0;
    session.shelf.y = y;
    session.shelf.rowHeight = 0;
    return { families: families.length, items: items.length, sets: setsLaidOut };
  }

  function directIndexDefinitionStructure(definition) {
    var map = Object.create(null);
    var pathsById = Object.create(null);
    var childCounts = Object.create(null);
    var nodes = definition.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      var spec = nodes[i];
      var path;
      if (Array.isArray(spec.definitionPath)) {
        path = spec.definitionPath.slice();
      } else if (!spec.parent) {
        path = [];
      } else {
        var parentPath = pathsById[spec.parent];
        if (!parentPath) continue;
        var index = childCounts[spec.parent] || 0;
        childCounts[spec.parent] = index + 1;
        path = parentPath.concat([index]);
      }
      pathsById[spec.id] = path;
      map[path.join(".")] = {
        sourceId: spec.id,
        sourceType: spec.sourceType || null,
        targetType: spec.type,
        sourceOverrideKey: spec.sourceOverrideKey || null,
        nestedDefinitionId: spec.kind === "INSTANCE" ? (spec.definitionId || null) : null,
        // D54: keep the formal public-property binding next to the structural
        // path. Live Figma occurrence descendants do not always expose
        // componentPropertyReferences, even though setProperties() applies the
        // property. The source binding + exact definition path is therefore a
        // stronger read-back locator than a name scan and remains independent
        // of layer/component names.
        componentPropertyReferences: spec.componentPropertyReferences
          ? clone(spec.componentPropertyReferences) : null,
        // Minimal semantic payload for an exact occurrence-path replay. Keep
        // only overflow fields instead of retaining the entire definition.
        textOverflow: spec.type === "TEXT" && spec.text ? {
          textTruncation: spec.text.textTruncation,
          maxLines: spec.text.maxLines,
        } : null,
      };
    }
    return map;
  }

  /**
   * Опись созданного определения.
   *
   * Стабильный `nodeId` пишется РЯДОМ с закешированной ссылкой, а не вместо
   * неё: ссылка остаётся быстрым путём, а id — тем, что переживает её и даёт
   * проверяемый ответ на вопрос «а был ли вообще создан этот компонент».
   */
  function directRegisterDefinition(session, definition, component, chunkIndex, sequence) {
    var nodeId = nodeIdentity(component) || null;
    var pageId = null;
    var pageName = null;
    try {
      var parent = component.parent;
      if (parent) {
        pageId = parent.id ? String(parent.id) : null;
        pageName = parent.name || null;
      }
    } catch (_ePage) { pageId = null; pageName = null; }
    var type = null;
    try { type = component.type || null; } catch (_eType) { type = null; }
    session.definitionRegistry[definition.definitionId] = {
      definitionId: definition.definitionId,
      nodeId: nodeId,
      type: type,
      pageId: pageId,
      pageName: pageName,
      chunkIndex: chunkIndex,
      sequence: sequence,
      rootsAtCreation: session.totals.roots,
      // Подтверждение ставится только после проверки годности: «создан» и
      // «пригоден» — разные утверждения, и отправитель имеет право знать
      // именно второе.
      acknowledged: false,
    };
    return session.definitionRegistry[definition.definitionId];
  }

  /**
   * Снимает с учёта определение, сборка которого не удалась.
   *
   * Убирается ВСЁ, что успела создать неудачная попытка: закешированная
   * ссылка, запись реестра и сам узел. Половина отката хуже, чем его
   * отсутствие: оставленная запись реестра переводит переотправку в ветку
   * пересборки, а оставленный узел становится вторым каноническим
   * определением того же definitionId.
   */
  // -------------------------------------------------------------------------
  // Дедупликация определений по ДОКАЗАТЕЛЬСТВУ
  //
  // Идентичность определения — это guid символа в исходнике. Две копии одного
  // опубликованного компонента приезжают двумя разными definitionId, и до сих
  // пор каждая становилась отдельным физическим COMPONENT. Копий в реальном
  // документе много: библиотеку копируют между файлами и страницами, и каждая
  // копия живёт в своём GUID-пространстве.
  //
  // Доказательство здесь не новое — это тот же `directEquivalentDefinition`,
  // которым приёмник уже пользуется для адресации overrides: точная
  // публикация плюс биекция overrideKey, запасным путём componentKey плюс
  // структурная подпись плюс опубликованная родословная вложенных вхождений.
  // Ни имя, ни визуальное сходство в нём не участвуют, и ни одно определение
  // не схлопывается «похоже — значит то же».
  //
  // Участник семейства вариантов сюда НЕ попадает. У него своя, более узкая
  // канонизация (`directCanonicalVariantAlias`), а общим правилом его трогать
  // нельзя: он уже живёт внутри своего COMPONENT_SET, и переселение его в
  // чужой набор разрушило бы оба.
  // -------------------------------------------------------------------------

  /**
   * Узкие признаки, по которым определение вообще может оказаться копией.
   * Обе ветки доказательства требуют совпадения одного из них, поэтому
   * сравнивать приходится только внутри такой корзины, а не со всем реестром.
   */
  function directIdentityBucketKeys(definition) {
    var keys = [];
    var publication = definition.publicationIdentity ||
      (definition.variantSet && definition.variantSet.publicationIdentity) || null;
    if (publication) keys.push("publish:" + publication);
    if (definition.componentKey) keys.push("key:" + String(definition.componentKey));
    return keys;
  }

  function directIndexDefinitionIdentity(session, definition) {
    if (!definition || !definition.definitionId) return;
    var keys = directIdentityBucketKeys(definition);
    for (var i = 0; i < keys.length; i++) {
      var bucket = session.definitionsByIdentityBucket[keys[i]] ||
        (session.definitionsByIdentityBucket[keys[i]] = []);
      if (bucket.indexOf(definition.definitionId) < 0) bucket.push(definition.definitionId);
    }
  }

  /**
   * Уже собранная копия этого же определения либо null.
   *
   * Отказ здесь — штатный исход: недоказанная пара остаётся двумя
   * компонентами, как и была. Цена ошибки в другую сторону несравнимо выше —
   * вхождения указывали бы на чужое дерево.
   */
  function directEquivalentDefinitionAlias(session, definition) {
    if (definition.variantSet && definition.variantSet.variantName) return null;
    var keys = directIdentityBucketKeys(definition);
    if (!keys.length) return null;
    var seen = Object.create(null);
    for (var k = 0; k < keys.length; k++) {
      var bucket = session.definitionsByIdentityBucket[keys[k]] || [];
      for (var i = 0; i < bucket.length; i++) {
        var candidateId = bucket[i];
        if (!candidateId || candidateId === definition.definitionId || seen[candidateId]) continue;
        seen[candidateId] = true;
        // Цепочек алиасов не заводим: канон у семейства копий один.
        if (session.definitionAliases[candidateId]) continue;
        // Каноном не может быть участник набора: его пришлось бы переселять.
        if (session.definitionVariantIdentities[candidateId]) continue;
        var state = directDefinitionState(session, candidateId);
        if (!state.available) continue;
        if (!directEquivalentDefinition(definition.definitionId, candidateId, session)) continue;
        return { definitionId: candidateId, component: state.component };
      }
    }
    return null;
  }

  /** Переиспользование чужого компонента с сохранением своей идентичности. */
  function directAliasDefinitionToProvenCopy(session, definition, alias, chunkIndex, sequence) {
    session.definitions[definition.definitionId] = alias.component;
    session.definitionAliases[definition.definitionId] = alias.definitionId;
    var entry = directRegisterDefinition(session, definition, alias.component, chunkIndex, sequence);
    entry.acknowledged = true;
    session.totals.definitionsReused += 1;
    session.totals.definitionsAliasedByProof += 1;
    if (session.definitionAliasSamples.length < session.definitionAliasSampleLimit) {
      session.definitionAliasSamples.push({
        from: definition.definitionId,
        to: alias.definitionId,
        componentKey: definition.componentKey || null,
        publicationIdentity: session.definitionPublicationIdentities[definition.definitionId] || null,
        // Какой именно веткой доказано. Ответ на вопрос «чему верить в этом
        // документе»: публикация с overrideKey или componentKey со структурой.
        via: directOverrideKeyEquivalentDefinition(definition.definitionId, alias.definitionId, session)
          ? "PUBLICATION_OVERRIDE_KEY" : "COMPONENT_KEY_SHAPE",
      });
    }
    return entry;
  }

  /** Снимает копии, переиспользовавшие компонент этого определения. */
  function directRejectProvenCopiesOf(session, definitionId, onRejected) {
    Object.keys(session.definitionAliases).forEach(function (aliasId) {
      if (session.definitionAliases[aliasId] !== definitionId) return;
      delete session.definitionAliases[aliasId];
      delete session.definitions[aliasId];
      delete session.definitionRegistry[aliasId];
      session.totals.definitionsAliasedByProof -= 1;
      onRejected(aliasId);
    });
  }

  function directDiscardDefinition(session, definitionId, component) {
    delete session.definitions[definitionId];
    delete session.definitionRegistry[definitionId];
    delete session.definitionStructuralMaps[definitionId];
    directInvalidateDefinitionIndexes(session, definitionId);
    directRegisterPublicationIdentity(session, definitionId, null);
    delete session.definitionStructuralSignatures[definitionId];
    delete session.definitionComponentKeys[definitionId];
    delete session.definitionComponentNameHierarchies[definitionId];
    delete session.definitionNodeCounts[definitionId];
    delete session.definitionVariantIdentities[definitionId];
    try { if (component && typeof component.remove === "function") component.remove(); }
    catch (_eDiscard) { /* недоступный узел убрать нельзя; учёт уже снят */ }
  }

  // ===========================================================================
  // Нативные семейства вариантов (COMPONENT_SET).
  //
  // Приёмник здесь НЕ разбирает имён. Координата варианта, её каноническое
  // имя и порядок участников приезжают уже проверенными: их построил
  // отправитель по `stateGroupPropertyValueOrders` исходной группы. Всё, что
  // делает эта часть, — объединяет уже созданные и уже подтверждённые
  // определения в один набор.
  //
  // Объединение — последний шаг job, а не шаг сборки определения. Причина
  // архитектурная: определения приезжают чанками и вперемешку с корнями, и
  // «все ли участники группы уже доехали» на середине job неизвестно.
  // Поэтому набор собирается один раз, когда доехало всё, что доедет.
  // Годность определения от этого не зависит: она подтверждена раньше и
  // отдельно (инвариант Ticket 01), а вхождения создаются по определению
  // участника, а не по набору.
  //
  // Набор — контейнер семейства, а не замена идентичности участника:
  // `definitionId → member ComponentNode` остаётся верным и после сборки.
  // ===========================================================================

  /** Потолок выборки доказательств: отчёт обязан быть ограниченным. */
  var VARIANT_SAMPLE_LIMIT = 12;

  /** Причины, по которым семейство осталось набором самостоятельных компонентов. */
  var VARIANT_FALLBACK = {
    // Хост не умеет combineAsVariants: собрать набор нечем.
    COMBINE_UNSUPPORTED: "VARIANT_COMBINE_UNSUPPORTED",
    // Определение участника к моменту объединения непригодно.
    MEMBER_UNAVAILABLE: "VARIANT_MEMBER_DEFINITION_UNAVAILABLE",
    // Два участника с одной координатой. Отправитель такую группу отклоняет,
    // здесь это страховка: половину набора собирать нельзя.
    DUPLICATE_COORDINATE: "VARIANT_DUPLICATE_COORDINATE",
    // Хост отказал в объединении.
    COMBINE_REJECTED: "VARIANT_COMBINE_REJECTED",
    // Вызов прошёл, но набора не появилось.
    SET_NOT_CREATED: "VARIANT_SET_NOT_CREATED",
    NO_MEMBERS: "VARIANT_NO_MEMBERS_DELIVERED",
    // Объединение выключено диагностическим шлюзом.
    DISABLED: "VARIANT_COMBINE_DISABLED",
    // Участник приехал позже, чем собрался его набор, и хост отказался
    // принять его в уже существующий набор. Отказ поимённый: набор и его
    // прежние участники остаются нетронутыми.
    LATE_MEMBER_REJECTED: "VARIANT_LATE_MEMBER_REJECTED",
  };

  function directVariantFallback(session, group, reason, detail) {
    session.totals.variantGroupsFallback += 1;
    session.totals.variantMembersFallback += group.order.length;
    session.variantFallbackByReason[reason] = (session.variantFallbackByReason[reason] || 0) + 1;
    group.status = reason;
    directNote(session, reason);
    if (session.variantFallbackSamples.length >= 12) return;
    session.variantFallbackSamples.push({
      groupId: group.groupId,
      // Имя — диагностика: ни одно решение по нему не принято.
      groupName: String(group.name || "").slice(0, 80),
      members: group.order.length,
      reason: reason,
      detail: detail === undefined || detail === null ? null : String(detail).slice(0, 160),
    });
  }

  /**
   * Записывает подтверждённое определение участником семейства.
   *
   * Порядок участника задан источником (`stateGroupPropertyValueOrders`) и
   * приезжает числом: пересортировать его по имени здесь было бы возвратом
   * к алфавитной догадке.
   */
  function directVariantCoordinateSet(list) {
    var out = Object.create(null);
    for (var i = 0; i < (list || []).length; i++) {
      var value = list[i];
      if (value !== undefined && value !== null && String(value)) out[String(value)] = true;
    }
    return out;
  }

  function directVariantCoordinateSetsOverlap(left, right) {
    if (!left || !right) return true;
    var keys = Object.keys(left);
    for (var i = 0; i < keys.length; i++) {
      if (right[keys[i]]) return true;
    }
    return false;
  }

  /**
   * D42 cross-local set aggregation.
   *
   * Two local Pixso state groups can be fragments of the same published
   * component family (for example one document copy contains First/Middle and
   * another contains Last). They may share one Figma COMPONENT_SET without
   * sharing a physical ComponentNode or GUID namespace iff:
   *   - stable published family + verified axis schema match;
   *   - component naming hierarchy of the group name matches (supporting evidence);
   *   - complete source coordinate domains are known and DISJOINT.
   *
   * Overlapping coordinate domains are never merged here. Those require a
   * separate exact-variant canonicalization proof; otherwise two components
   * would claim the same Figma variant coordinate.
   */
  function directCompatibleVariantAggregate(session, descriptor) {
    // D48: disjoint demanded coordinates from mirrors of the same *published*
    // Pixso ComponentSet may share one physical Figma COMPONENT_SET while
    // keeping their ComponentNode definitions and GUID namespaces separate.
    // Publication identity + exact axis schema lives in stableFamilyKey.
    // Overlapping coordinates are handled only by the per-member overrideKey
    // proof below; otherwise duplicate coordinates fail closed.
    if (!descriptor || !descriptor.stableFamilyKey || !descriptor.publicationIdentity) return null;
    var ids = session.variantGroupsByStableFamily[descriptor.stableFamilyKey] || [];
    var incoming = directVariantCoordinateSet(descriptor.demandedCoordinates || [descriptor.coordinateKey]);
    var incomingName = directComponentNameHierarchySegments(descriptor.groupName || "").join(" / ").toLowerCase();
    for (var i = 0; i < ids.length; i++) {
      var group = session.variantGroups[ids[i]] || null;
      if (!group || group.status && group.status !== "COMBINED") continue;
      if (!group.publicationIdentity || group.publicationIdentity !== descriptor.publicationIdentity) continue;
      var groupName = directComponentNameHierarchySegments(group.name || "").join(" / ").toLowerCase();
      if (incomingName && groupName && incomingName !== groupName) continue;
      if (directVariantCoordinateSetsOverlap(group.sourceCoordinateSet, incoming)) continue;
      return group;
    }
    return null;
  }

  function directMergeVariantGroupRegistries(session, sourceGroupId, targetGroupId) {
    if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) return session.variantGroups[targetGroupId] || null;
    var source = session.variantGroups[sourceGroupId] || null;
    var target = session.variantGroups[targetGroupId] || null;
    if (!target) return null;
    session.variantAggregateByLocalGroup[sourceGroupId] = targetGroupId;
    if (target.sourceGroupIds.indexOf(sourceGroupId) < 0) target.sourceGroupIds.push(sourceGroupId);
    if (!source) return target;

    (source.sourceGroupIds || []).forEach(function (localId) {
      session.variantAggregateByLocalGroup[localId] = targetGroupId;
      if (target.sourceGroupIds.indexOf(localId) < 0) target.sourceGroupIds.push(localId);
    });
    Object.keys(source.sourceCoordinateSet || {}).forEach(function (coordinate) {
      target.sourceCoordinateSet[coordinate] = true;
    });
    (source.order || []).forEach(function (member) {
      if (!target.members[member.definitionId]) {
        target.members[member.definitionId] = member;
        target.order.push(member);
      }
      session.variantGroupByDefinition[member.definitionId] = targetGroupId;
    });
    delete session.variantGroups[sourceGroupId];
    var family = source.stableFamilyKey && session.variantGroupsByStableFamily[source.stableFamilyKey];
    if (family) {
      session.variantGroupsByStableFamily[source.stableFamilyKey] = family.filter(function (id) {
        return id !== sourceGroupId;
      });
    }
    session.totals.variantLocalGroupsMergedByStableFamily =
      (session.totals.variantLocalGroupsMergedByStableFamily || 0) + 1;
    return target;
  }

  function directAttachAliasedLocalVariantGroup(session, descriptor, canonicalGroupId) {
    if (!descriptor || !descriptor.groupId || !canonicalGroupId) return;
    var localGroupId = descriptor.groupId;
    var existingAggregate = session.variantAggregateByLocalGroup[localGroupId] || null;
    if (existingAggregate && existingAggregate !== canonicalGroupId) {
      directMergeVariantGroupRegistries(session, existingAggregate, canonicalGroupId);
    }
    var target = session.variantGroups[canonicalGroupId] || null;
    if (!target) return;
    session.variantAggregateByLocalGroup[localGroupId] = canonicalGroupId;
    if (target.sourceGroupIds.indexOf(localGroupId) < 0) {
      target.sourceGroupIds.push(localGroupId);
      session.totals.variantLocalGroupsMergedByStableFamily =
        (session.totals.variantLocalGroupsMergedByStableFamily || 0) + 1;
    }
    var incoming = directVariantCoordinateSet(descriptor.demandedCoordinates || []);
    Object.keys(incoming).forEach(function (coordinate) { target.sourceCoordinateSet[coordinate] = true; });
  }

  function directRegisterVariantMember(session, definition, component) {
    var descriptor = definition && definition.variantSet;
    if (!descriptor || !descriptor.groupId || !descriptor.variantName) return null;
    var localGroupId = descriptor.groupId;
    var aggregateId = session.variantAggregateByLocalGroup[localGroupId] || null;
    var group = aggregateId ? session.variantGroups[aggregateId] : null;

    if (!group) {
      group = directCompatibleVariantAggregate(session, descriptor);
      if (group) {
        aggregateId = group.groupId;
        session.variantAggregateByLocalGroup[localGroupId] = aggregateId;
        if (group.sourceGroupIds.indexOf(localGroupId) < 0) group.sourceGroupIds.push(localGroupId);
        var incomingCoordinates = directVariantCoordinateSet(descriptor.demandedCoordinates || []);
        Object.keys(incomingCoordinates).forEach(function (coordinate) {
          group.sourceCoordinateSet[coordinate] = true;
        });
        session.totals.variantLocalGroupsMergedByStableFamily =
          (session.totals.variantLocalGroupsMergedByStableFamily || 0) + 1;
      }
    }

    if (!group) {
      group = {
        groupId: localGroupId,
        sourceGroupIds: [localGroupId],
        stableFamilyKey: descriptor.stableFamilyKey || null,
        publicationIdentity: descriptor.publicationIdentity || null,
        publishFile: descriptor.publishFile || null,
        publishID: descriptor.publishID || null,
        name: descriptor.groupName || "",
        componentKey: descriptor.groupComponentKey || null,
        axisCount: descriptor.axisCount || 0,
        memberCountSource: descriptor.memberCountSource || 0,
        memberCountDemanded: descriptor.memberCountDemanded || 0,
        sourceCoordinateSet: directVariantCoordinateSet(descriptor.demandedCoordinates || []),
        members: Object.create(null),
        order: [],
        setNodeId: null,
        status: null,
      };
      session.variantGroups[localGroupId] = group;
      session.variantAggregateByLocalGroup[localGroupId] = localGroupId;
      if (group.stableFamilyKey) {
        var familyGroups = session.variantGroupsByStableFamily[group.stableFamilyKey] ||
          (session.variantGroupsByStableFamily[group.stableFamilyKey] = []);
        familyGroups.push(localGroupId);
      }
      session.totals.variantGroupsSeen += 1;
    }

    // Full source-family cardinality is evidence from Pixso, while the
    // demanded coordinate domain is only the subset materialized in this job.
    // Never collapse the former to the latter when several local GUID-spaces
    // are aggregated into one logical Figma set.
    if (descriptor.memberCountSource) {
      group.memberCountSource = Math.max(group.memberCountSource || 0, descriptor.memberCountSource || 0);
    }
    if (descriptor.memberCountDemanded) {
      group.memberCountDemanded = Math.max(
        group.memberCountDemanded || 0,
        Object.keys(group.sourceCoordinateSet || {}).length,
        descriptor.memberCountDemanded || 0
      );
    }
    if (group.members[definition.definitionId]) return group;
    var member = {
      definitionId: definition.definitionId,
      sourceGroupId: localGroupId,
      variantName: descriptor.variantName,
      sourceName: descriptor.sourceName || descriptor.variantName,
      coordinateKey: descriptor.coordinateKey || descriptor.variantName,
      order: Number(descriptor.order) || 0,
      sortKey: (descriptor.sortKey || []).slice(),
      joined: false,
    };
    group.members[definition.definitionId] = member;
    group.order.push(member);
    session.variantGroupByDefinition[definition.definitionId] = group.groupId;
    session.totals.variantMembersSeen += 1;
    return group;
  }

  function directVariantGroupOfDefinition(session, definitionId) {
    return session.variantGroupByDefinition[definitionId] || "";
  }


  function directVariantCanonicalKey(definition) {
    var descriptor = definition && definition.variantSet;
    if (!descriptor || !descriptor.stableFamilyKey || !descriptor.coordinateKey) return "";
    return String(descriptor.stableFamilyKey) + "\u001d" + String(descriptor.coordinateKey);
  }

  /**
   * Canonicalize copied local variants only when they are already proven to be
   * the very same published component + coordinate + complete nested lineage.
   * This is deliberately stronger than stableFamilyKey: copied groups with a
   * revised nested master stay separate. The alias keeps the source
   * definitionId for override addressing while reusing one physical Figma
   * ComponentNode, so duplicate local copies do not produce duplicate sets.
   */
  function directDefinitionStructureCount(definitionId, session) {
    var count = session.definitionNodeCounts && session.definitionNodeCounts[definitionId];
    return typeof count === "number" ? count : 0;
  }

  /**
   * A local Pixso library stub can carry the exact published component key,
   * exact variant coordinate and exact slash-separated component-set name but
   * omit the variant's child tree entirely. Such a stub is not a second visual
   * definition; it is an incomplete local materialization of the same formal
   * component. Reusing the richer definition is safe only for this one-sided
   * completeness case. Two populated but different trees are NOT collapsed.
   */
  function directEquivalentStubVariantAlias(expectedId, activeId, session) {
    if (!expectedId || !activeId || expectedId === activeId) return false;
    var expectedKey = session.definitionComponentKeys[expectedId] || null;
    var activeKey = session.definitionComponentKeys[activeId] || null;
    if (!expectedKey || expectedKey !== activeKey) return false;
    var expectedVariant = session.definitionVariantIdentities[expectedId] || null;
    var activeVariant = session.definitionVariantIdentities[activeId] || null;
    if (expectedVariant || activeVariant) {
      if (!expectedVariant || expectedVariant !== activeVariant) return false;
    }
    var expectedHierarchy = session.definitionComponentNameHierarchies[expectedId] || [];
    var activeHierarchy = session.definitionComponentNameHierarchies[activeId] || [];
    if (!expectedHierarchy.length || !activeHierarchy.length ||
        expectedHierarchy.join(" / ").toLowerCase() !== activeHierarchy.join(" / ").toLowerCase()) return false;
    var expectedCount = directDefinitionStructureCount(expectedId, session);
    var activeCount = directDefinitionStructureCount(activeId, session);
    // One node means only the COMPONENT root exists in the serialized source.
    // Alias only FROM the current root-only stub TO an already-built richer
    // canonical definition. Never collapse a richer definition into an earlier
    // stub; that would erase the very subtree needed for overrides.
    return expectedCount === 1 && activeCount > 1;
  }


  function directRecursivelyEquivalentDefinition(expectedId, activeId, session, seen) {
    if (!expectedId || !activeId || expectedId === activeId) return expectedId === activeId;
    seen = seen || Object.create(null);
    var pairKey = expectedId + "\u001d" + activeId;
    if (seen[pairKey]) return true;
    seen[pairKey] = true;
    if (!directEquivalentDefinition(expectedId, activeId, session)) return false;
    var expectedMap = session.definitionStructuralMaps[expectedId] || null;
    var activeMap = session.definitionStructuralMaps[activeId] || null;
    if (!expectedMap || !activeMap) return false;
    var keys = Object.keys(expectedMap);
    for (var i = 0; i < keys.length; i++) {
      var pathKey = keys[i];
      var left = expectedMap[pathKey] || {};
      var right = activeMap[pathKey] || {};
      if (left.targetType !== "INSTANCE") continue;
      var leftNested = left.nestedDefinitionId || null;
      var rightNested = right.nestedDefinitionId || null;
      if (leftNested === rightNested) continue;
      if (!leftNested || !rightNested ||
          !directRecursivelyEquivalentDefinition(leftNested, rightNested, session, seen)) return false;
    }
    return true;
  }


  function directOverrideKeyEquivalentDefinition(expectedId, activeId, session) {
    if (!expectedId || !activeId || expectedId === activeId) return expectedId === activeId;
    var expectedPublished = session.definitionPublicationIdentities[expectedId] || null;
    var activePublished = session.definitionPublicationIdentities[activeId] || null;
    if (!expectedPublished || expectedPublished !== activePublished) return false;
    var expectedVariant = session.definitionVariantIdentities[expectedId] || null;
    var activeVariant = session.definitionVariantIdentities[activeId] || null;
    // Требуется СОВПАДЕНИЕ координаты, а не её наличие. Прежнее условие
    // отвергало пару, у которой координаты нет ни у одной стороны, то есть
    // структурно не могло признать эквивалентными два НЕ-вариантных
    // определения — а это ровно копии обычного опубликованного компонента.
    // Разная координата (в том числе «есть» против «нет») по-прежнему отказ.
    if (expectedVariant !== activeVariant) return false;
    // D52: то же сравнение, но по заранее посчитанной подписи определения.
    // `overrideKey` — стабильный адрес Pixso между локальными зеркалами;
    // отсутствующий ключ не угадывается, и определение без полной подписи
    // эквивалентным не признаётся.
    var expectedIndex = directDefinitionOverrideKeyIndex(session, expectedId);
    var activeIndex = directDefinitionOverrideKeyIndex(session, activeId);
    if (!expectedIndex || !activeIndex) return false;
    if (!expectedIndex.signature || !activeIndex.signature) return false;
    return expectedIndex.signature === activeIndex.signature;
  }

  function directOverrideKeyEntryMap(definitionId, session) {
    var structural = session.definitionStructuralMaps[definitionId] || null;
    if (!structural) return null;
    var byKey = Object.create(null);
    var duplicate = false;
    Object.keys(structural).forEach(function (pathKey) {
      var entry = structural[pathKey] || {};
      var key = entry.sourceOverrideKey || null;
      if (!key) { duplicate = true; return; }
      if (byKey[key]) { duplicate = true; return; }
      byKey[key] = entry;
    });
    return duplicate ? null : byKey;
  }

  function directRecursivelyOverrideKeyEquivalentDefinition(expectedId, activeId, session, seen) {
    if (!expectedId || !activeId || expectedId === activeId) return expectedId === activeId;
    seen = seen || Object.create(null);
    var pair = expectedId + "\u001d" + activeId;
    if (seen[pair]) return true;
    seen[pair] = true;

    // One-sided root-only mirrors are explicit incomplete materializations.
    if (directEquivalentStubVariantAlias(expectedId, activeId, session)) return true;

    var expectedPublished = session.definitionPublicationIdentities[expectedId] || null;
    var activePublished = session.definitionPublicationIdentities[activeId] || null;
    if (!expectedPublished || expectedPublished !== activePublished) return false;

    // The proof is a bijection by Pixso overrideKey, not by local GUID or child
    // index. This is the missing D39 translation layer: a library revision may
    // reorder children or rename variant axes while every published node keeps
    // the same stable overrideKey. Any missing/duplicate key fails closed.
    var expectedByKey = directOverrideKeyEntryMap(expectedId, session);
    var activeByKey = directOverrideKeyEntryMap(activeId, session);
    if (!expectedByKey || !activeByKey) return false;
    var expectedKeys = Object.keys(expectedByKey).sort();
    var activeKeys = Object.keys(activeByKey).sort();
    if (expectedKeys.length !== activeKeys.length) return false;
    for (var i = 0; i < expectedKeys.length; i++) {
      var key = expectedKeys[i];
      if (key !== activeKeys[i]) return false;
      var left = expectedByKey[key] || {};
      var right = activeByKey[key] || {};
      if (left.targetType !== right.targetType) return false;
      if (left.targetType !== "INSTANCE") continue;
      var leftNested = left.nestedDefinitionId || null;
      var rightNested = right.nestedDefinitionId || null;
      if (leftNested === rightNested) continue;
      if (!leftNested || !rightNested ||
          !directRecursivelyOverrideKeyEquivalentDefinition(leftNested, rightNested, session, seen)) return false;
    }
    return true;
  }


  function directCanonicalVariantAlias(session, definition) {
    // D47: collapse a duplicate local variant only when the exact published
    // coordinate already has a live canonical component AND the two definition
    // trees pass the strict structural + nested published-lineage proof. This
    // keeps raw override addressing local unless interchangeability is proven.
    // A root-only local library stub may also reuse a richer proven canonical
    // copy. This is intentionally NOT the broad D43 componentKey equivalence.
    var key = directVariantCanonicalKey(definition);
    if (!key) return null;
    var canonicalId = session.variantCanonicalByStableCoordinate[key] || "";
    if (!canonicalId || canonicalId === definition.definitionId) return null;
    var state = directDefinitionState(session, canonicalId);
    var canonicalComponent = state.available ? state.component : session.definitions[canonicalId] || null;
    if (!canonicalComponent) return null;
    var currentRichness = session.definitionCanonicalRichness[definition.definitionId] || 0;
    var canonicalRichness = session.definitionCanonicalRichness[canonicalId] || 0;
    if (canonicalRichness < currentRichness) return null;
    if (!directRecursivelyOverrideKeyEquivalentDefinition(definition.definitionId, canonicalId, session) &&
        !directEquivalentStubVariantAlias(definition.definitionId, canonicalId, session)) return null;
    if (session.variantAliasSamples && session.variantAliasSamples.length < 80) {
      session.variantAliasSamples.push({
        from: definition.definitionId, to: canonicalId,
        family: definition.variantSet && definition.variantSet.stableFamilyKey || null,
        coordinate: definition.variantSet && definition.variantSet.coordinateKey || null,
        name: definition.variantSet && definition.variantSet.groupName || null
      });
    }
    return { definitionId: canonicalId, component: canonicalComponent };
  }

  /**
   * D40 diagnostic alias layer. Stable family identity links copied local
   * Pixso state groups for explanation only; it never changes the local
   * materialization parent or override GUID namespace.
   */
  function directLogicalFamilyReport(session) {
    var byStable = Object.create(null);
    Object.keys(session.variantGroups || {}).forEach(function (groupId) {
      var group = session.variantGroups[groupId];
      var key = group && group.stableFamilyKey;
      if (!key) return;
      var family = byStable[key] || (byStable[key] = {
        stableFamilyKey: key, componentKey: group.componentKey || null,
        publicationIdentity: group.publicationIdentity || null,
        publishFile: group.publishFile || null, publishID: group.publishID || null,
        localGroups: []
      });
      var coordinates = group.order.map(function (member) { return member.coordinateKey; }).sort();
      var shapes = group.order.map(function (member) {
        return session.definitionStructuralSignatures[member.definitionId] || null;
      }).filter(Boolean).sort();
      family.localGroups.push({
        groupId: group.groupId, groupName: group.name || null, memberCount: group.order.length,
        coordinates: coordinates, structuralSignatures: shapes, setNodeId: group.setNodeId || null
      });
    });
    return Object.keys(byStable).map(function (key) {
      var family = byStable[key];
      family.localGroupCount = family.localGroups.length;
      family.physicallyMerged = false;
      family.reason = family.localGroups.length > 1
        ? "LOCAL_GUID_NAMESPACE_PRESERVED" : "SINGLE_LOCAL_GROUP";
      return family;
    }).filter(function (family) { return family.localGroupCount > 1; }).slice(0, 80);
  }

  /**
   * D42 universal reconstruction manifest. Every observed formal Pixso state
   * group is reported; no known component/family names are selected here.
   * Slash hierarchy is evidence, not an identity key. The decision is the
   * actual receiver outcome (COMPONENT_SET or conservative fallback).
   */
  function directReconstructionFamilyManifest(session) {
    var out = [];
    var groupIds = Object.keys(session.variantGroups || {}).sort();
    for (var i = 0; i < groupIds.length && out.length < 120; i++) {
      var group = session.variantGroups[groupIds[i]];
      if (!group) continue;
      var coordinates = (group.order || []).map(function (member) {
        return member.coordinateKey || member.variantName || null;
      }).filter(Boolean);
      out.push({
        sourceGroupId: group.groupId || null,
        componentSetName: group.name || null,
        componentNameHierarchy: directComponentNameHierarchySegments(group.name || ""),
        stableFamilyKey: group.stableFamilyKey || null,
        publicationIdentity: group.publicationIdentity || null,
        publishFile: group.publishFile || null,
        publishID: group.publishID || null,
        publishedComponentKey: group.componentKey || null,
        axisCount: group.axisCount || 0,
        memberCountSource: group.memberCountSource || 0,
        memberCountDemanded: group.memberCountDemanded || group.order.length || 0,
        coordinates: coordinates,
        decision: group.status === "COMBINED" ? "COMPONENT_SET" : "STANDALONE_COMPONENTS",
        reason: group.status === "COMBINED" ? "FORMAL_PIXSO_STATE_GROUP" : (group.status || "NOT_COMBINED"),
        figmaComponentSetId: group.setNodeId || null
      });
    }
    return out;
  }

  /**
   * Собирает нативные наборы из доехавших участников.
   *
   * Вызывается СРАЗУ после сборки чанка определений — до того, как хоть одно
   * вхождение этих определений создано. Порядок здесь не косметика.
   *
   * Измерено на живой Figma: `combineAsVariants` переселяет компонент в новый
   * родительский узел, и хост заново разрешает УЖЕ СУЩЕСТВУЮЩИЕ вхождения
   * этого компонента. Для поддеревьев, выключенных из потока раскладки
   * (`visible = false`), пересчёт берёт геометрию мастера, а не применённую
   * дельту вхождения: скрытая внутренность приезжала разложенной по
   * умолчаниям определения. Видимый результат при этом не менялся, но
   * состояние документа становилось внутренне противоречивым — текст один,
   * а соседи разложены под другой.
   *
   * Лечится это не подпоркой, а порядком: участник обязан оказаться внутри
   * своего набора ДО первого вхождения. Тогда переселять нечего и
   * пересчитывать нечего.
   *
   * Участник, приехавший позже собранного набора, добавляется в него
   * `appendChild` — это тоже происходит раньше его собственных вхождений,
   * потому что определение всегда едет впереди корня, который его использует.
   *
   * Откат — ПОГРУППНЫЙ: несобравшееся семейство остаётся набором
   * самостоятельных компонентов со всеми своими вхождениями, и ни одна
   * соседняя группа от этого не страдает. Ни одного визуального узла при
   * откате не теряется: объединение ничего не создаёт и не удаляет, оно
   * только меняет родителя уже готовых компонентов.
   */
  /**
   * Координата варианта живого узла — В ТОЙ ЖЕ форме, что у отправителя.
   *
   * Идентичность координаты не зависит от порядка осей: `variantProperties`
   * отдаёт их в порядке набора, имя — в порядке источника, а один и тот же
   * вариант обязан дать один ключ. Иначе сравнение «такой вариант уже есть»
   * сравнивает разные формы одного и того же и всегда отвечает «нет»:
   * дубль не отклоняется, а дописывается `appendChild` в УЖЕ СОБРАННЫЙ набор,
   * и живая Figma на каждый такой append переразрешает все его вхождения.
   * Измерено: 12 лишних поздних участников стоили +170 с ожидания хоста при
   * неизменной собственной работе плагина.
   */
  function directVariantCoordinateKeyFromNode(component) {
    if (!component) return null;
    try {
      var pairs = null;
      var props = component.variantProperties || null;
      if (props && typeof props === "object") {
        var keys = Object.keys(props);
        if (keys.length) {
          pairs = keys.map(function (key) { return key + "=" + props[key]; });
        }
      }
      if (!pairs) {
        var name = component.name ? String(component.name) : null;
        if (!name) return null;
        if (name.indexOf("=") < 0) return name;
        pairs = name.split(",").map(function (part) { return part.trim(); });
      }
      pairs.sort();
      return pairs.join(", ");
    } catch (_eCoordinate) { return null; }
  }

  function directVariantSetHealth(set, session) {
    var result = { healthy: true, reason: null, detail: null };
    if (!set || nodeType(set) !== "COMPONENT_SET") {
      return { healthy: false, reason: "VARIANT_SET_NOT_CREATED", detail: null };
    }
    var children = [];
    try { children = set.children || []; } catch (_eChildren) { children = []; }
    var seen = Object.create(null);
    for (var i = 0; i < children.length; i++) {
      if (nodeType(children[i]) !== "COMPONENT") continue;
      var key = directVariantCoordinateKeyFromNode(children[i]);
      if (!key) continue;
      if (seen[key]) {
        result = { healthy: false, reason: VARIANT_FALLBACK.DUPLICATE_COORDINATE, detail: key };
        break;
      }
      seen[key] = true;
    }
    session.totals.variantSetsHealthChecked += 1;
    if (!result.healthy) {
      session.totals.variantSetsInErrorState += 1;
      directNote(session, "VARIANT_SET_HEALTH_REJECTED");
    }
    return result;
  }

  function directSetHasCoordinate(set, coordinateKey) {
    if (!set || !coordinateKey) return false;
    var children = [];
    try { children = set.children || []; } catch (_eChildren) { children = []; }
    for (var i = 0; i < children.length; i++) {
      if (nodeType(children[i]) !== "COMPONENT") continue;
      if (directVariantCoordinateKeyFromNode(children[i]) === coordinateKey) return true;
    }
    return false;
  }

  async function directCombineVariantGroups(session, onlyGroupIds) {
    var phaseStartedAt = Date.now();
    var slice = { startedAt: phaseStartedAt };
    var groupIds = onlyGroupIds || Object.keys(session.variantGroups);
    if (!groupIds.length) return;
    var canCombine = session.variantCombine && typeof figma.combineAsVariants === "function";
    var page = null;

    for (var g = 0; g < groupIds.length; g++) {
      var group = session.variantGroups[groupIds[g]];
      if (!group) continue;
      // Уже откатившееся семейство второй попытки не получает: причина
      // отказа не лечится повтором, а половину набора собирать нельзя.
      if (group.status && group.status !== "COMBINED") continue;

      var pending = group.order.filter(function (member) { return !member.joined; });
      if (!pending.length) continue;

      if (!canCombine) {
        directVariantFallback(session, group,
          session.variantCombine ? VARIANT_FALLBACK.COMBINE_UNSUPPORTED : VARIANT_FALLBACK.DISABLED);
        continue;
      }
      if (!page) page = await ensureServicePage(session.registry, session.jobId, DIRECT_SERVICE_PAGE);

      // Порядок участников — исходный порядок осей и значений Pixso.
      pending.sort(function (left, right) {
        var ls = left.sortKey || [], rs = right.sortKey || [];
        var count = Math.max(ls.length, rs.length);
        for (var si = 0; si < count; si++) {
          var lv = ls[si], rv = rs[si];
          if (lv === undefined && rv !== undefined) return -1;
          if (rv === undefined && lv !== undefined) return 1;
          if (lv !== rv) return lv - rv;
        }
        if (left.order !== right.order) return left.order - right.order;
        return left.definitionId < right.definitionId ? -1 : 1;
      });

      if (group.status === "COMBINED") {
        // Набор уже есть: опоздавшие участники входят в него поимённо.
        var set = directVariantSetOf(session, group);
        if (!set) {
          for (var lost = 0; lost < pending.length; lost++) {
            session.totals.variantMembersFallback += 1;
            pending[lost].joined = true;
          }
          directNote(session, VARIANT_FALLBACK.LATE_MEMBER_REJECTED);
          continue;
        }
        for (var late = 0; late < pending.length; late++) {
          var lateState = directDefinitionState(session, pending[late].definitionId);
          pending[late].joined = true;
          if (!lateState.available) {
            session.totals.variantMembersFallback += 1;
            directNote(session, VARIANT_FALLBACK.MEMBER_UNAVAILABLE);
            continue;
          }
          var lateCoordinate = pending[late].coordinateKey || pending[late].variantName;
          if (directSetHasCoordinate(set, lateCoordinate)) {
            session.totals.variantMembersFallback += 1;
            session.totals.variantMembersRejectedAsDuplicate += 1;
            session.variantFallbackByReason[VARIANT_FALLBACK.DUPLICATE_COORDINATE] =
              (session.variantFallbackByReason[VARIANT_FALLBACK.DUPLICATE_COORDINATE] || 0) + 1;
            directNote(session, VARIANT_FALLBACK.DUPLICATE_COORDINATE);
            continue;
          }
          var previousParent = null;
          try { previousParent = lateState.component.parent || page; } catch (_eParent) { previousParent = page; }
          var joined = false;
          try {
            set.appendChild(lateState.component);
            joined = lateState.component.parent === set;
          } catch (_eAppend) { joined = false; }
          if (joined) {
            var lateHealth = directVariantSetHealth(set, session);
            if (!lateHealth.healthy) {
              try { (previousParent && typeof previousParent.appendChild === "function" ? previousParent : page).appendChild(lateState.component); }
              catch (_eRollbackLate) { /* best effort */ }
              joined = false;
              session.totals.variantMembersRejectedAsDuplicate +=
                lateHealth.reason === VARIANT_FALLBACK.DUPLICATE_COORDINATE ? 1 : 0;
            }
          }
          if (joined) {
            session.totals.variantMembersCombined += 1;
            session.totals.variantMembersJoinedLate += 1;
          } else {
            session.totals.variantMembersFallback += 1;
            session.variantFallbackByReason[VARIANT_FALLBACK.LATE_MEMBER_REJECTED] =
              (session.variantFallbackByReason[VARIANT_FALLBACK.LATE_MEMBER_REJECTED] || 0) + 1;
            directNote(session, VARIANT_FALLBACK.LATE_MEMBER_REJECTED);
          }
        }
        await yieldIfNeeded(slice);
        continue;
      }

      // D37: completeness is relative to the demanded subset of THIS job, not
      // to the full Pixso design-system catalog. Unused sibling variants stay
      // lazy and must not turn a healthy import into an "incomplete family".
      var demandedCount = group.memberCountDemanded || group.order.length;
      if (demandedCount > 0 && group.order.length === demandedCount) {
        session.totals.variantFamiliesCompleteAtCombine += 1;
      } else if (demandedCount > 0) {
        session.totals.variantFamiliesIncompleteAtCombine += 1;
        directNote(session, "VARIANT_DEMAND_SUBSET_INCOMPLETE_AT_COMBINE");
      }
      if (group.memberCountSource > demandedCount) {
        session.totals.variantFamilyMembersDeferred += group.memberCountSource - demandedCount;
      }

      var components = [];
      var seenNames = Object.create(null);
      var blocked = null;
      for (var m = 0; m < pending.length; m++) {
        var state = directDefinitionState(session, pending[m].definitionId);
        if (!state.available) {
          blocked = { reason: VARIANT_FALLBACK.MEMBER_UNAVAILABLE, detail: pending[m].definitionId + " " + state.subreason };
          break;
        }
        var coordinateKey = pending[m].coordinateKey || pending[m].variantName;
        if (seenNames[coordinateKey]) {
          blocked = { reason: VARIANT_FALLBACK.DUPLICATE_COORDINATE, detail: coordinateKey };
          break;
        }
        seenNames[coordinateKey] = true;
        components.push(state.component);
      }
      if (blocked) { directVariantFallback(session, group, blocked.reason, blocked.detail); continue; }
      if (!components.length) { directVariantFallback(session, group, VARIANT_FALLBACK.NO_MEMBERS); continue; }

      var created = null;
      try { created = figma.combineAsVariants(components, page); }
      catch (eCombine) {
        directVariantFallback(session, group, VARIANT_FALLBACK.COMBINE_REJECTED,
          eCombine && eCombine.message);
        continue;
      }
      var setType = null;
      try { setType = created && created.type; } catch (_eSetType) { setType = null; }
      if (!created || setType !== "COMPONENT_SET") {
        directVariantFallback(session, group, VARIANT_FALLBACK.SET_NOT_CREATED, setType);
        continue;
      }

      var initialHealth = directVariantSetHealth(created, session);
      if (!initialHealth.healthy) {
        var rollbackChildren = [];
        try { rollbackChildren = (created.children || []).slice(); } catch (_eRollbackChildren) { rollbackChildren = []; }
        for (var rc = 0; rc < rollbackChildren.length; rc++) {
          try { page.appendChild(rollbackChildren[rc]); } catch (_eRollbackMember) { /* best effort */ }
        }
        try { if (typeof created.remove === "function") created.remove(); } catch (_eRemoveBadSet) { /* best effort */ }
        directVariantFallback(session, group, initialHealth.reason || VARIANT_FALLBACK.COMBINE_REJECTED, initialHealth.detail);
        continue;
      }

      setValue(created, "name", group.name || "Variants");
      setPluginData(created, "pixsoDirectVariantGroup", group.sourceGroupIds && group.sourceGroupIds.length ? group.sourceGroupIds[0] : group.groupId);
      setPluginData(created, "pixsoDirectVariantFamily", group.stableFamilyKey || "");
      directPlaceOnShelf(session, created);
      group.setNodeId = nodeIdentity(created) || null;
      group.status = "COMBINED";
      for (var j = 0; j < pending.length; j++) pending[j].joined = true;
      session.totals.variantGroupsCombined += 1;
      session.totals.variantMembersCombined += components.length;

      // Годность участника проверяется ПОСЛЕ объединения тем же кодом, что и
      // до него: утверждение «набор собран» не имеет права быть сильнее, чем
      // «его участники всё ещё отдают вхождения».
      for (var v = 0; v < pending.length; v++) {
        if (directDefinitionState(session, pending[v].definitionId).available) continue;
        session.totals.variantMembersLostAfterCombine += 1;
        directNote(session, "VARIANT_MEMBER_LOST_AFTER_COMBINE");
      }
      await yieldIfNeeded(slice);
    }
    session.timings.variantCombineMs += Date.now() - phaseStartedAt;
  }

  /** Узел набора семейства: находится через любого уже вошедшего участника. */
  function directVariantSetOf(session, group) {
    for (var i = 0; i < group.order.length; i++) {
      if (!group.order[i].joined) continue;
      var state = directDefinitionState(session, group.order[i].definitionId);
      if (!state.available) continue;
      var parent = null;
      try { parent = state.component.parent; } catch (_eParent) { parent = null; }
      var type = null;
      try { type = parent ? parent.type : null; } catch (_eType) { type = null; }
      if (parent && type === "COMPONENT_SET") return parent;
    }
    return null;
  }

  /**
   * Доказательство нативной сборки, прочитанное из документа.
   *
   * Счётчик говорит «мы вызвали combineAsVariants», и это не то же самое, что
   * «в документе есть COMPONENT_SET, его участники — COMPONENT, а вхождение
   * указывает на нужного участника». Здесь читается именно второе, и читается
   * ограниченной выборкой: отчёт не имеет права расти с документом.
   *
   * Всё чтение — диагностика: упасть она права не имеет, а непрочитанное
   * остаётся null, а не назначается фактом.
   */
  async function directVerifyVariantSets(session) {
    var sets = [];
    var instances = [];
    var groupIds = Object.keys(session.variantGroups);
    for (var g = 0; g < groupIds.length && sets.length < VARIANT_SAMPLE_LIMIT; g++) {
      var group = session.variantGroups[groupIds[g]];
      if (group.status !== "COMBINED") continue;
      var first = group.order.length ? directDefinitionState(session, group.order[0].definitionId) : null;
      var setNode = null;
      try { setNode = first && first.component ? first.component.parent : null; } catch (_eParent) { setNode = null; }
      var record = {
        groupId: group.groupId,
        sourceGroupIds: group.sourceGroupIds ? group.sourceGroupIds.slice(0, 12) : [],
        sourceGroupCount: group.sourceGroupIds ? group.sourceGroupIds.length : 1,
        componentKey: group.componentKey || null,
        stableFamilyKey: group.stableFamilyKey || null,
        setNodeId: group.setNodeId,
        setType: null,
        setName: null,
        setChildren: null,
        membersDelivered: group.order.length,
        membersSource: group.memberCountSource,
        // Схема набора глазами Figma. Читается ЕДИНСТВЕННОЙ безопасной
        // точкой чтения: у варианта внутри набора этот getter бросает.
        // Это чтение, а не объявление свойств: ни одно из них здесь не
        // создаётся и не редактируется.
        propertyDefinitions: null,
        // Порядок, в котором участники были ПОДАНЫ на объединение: порядок
        // осей и значений источника.
        sourceOrder: group.order.slice().sort(function (left, right) {
          if (left.order !== right.order) return left.order - right.order;
          return left.definitionId < right.definitionId ? -1 : 1;
        }).map(function (entry) { return entry.variantName; }),
        // Порядок, в котором участники лежат в наборе ПОСЛЕ объединения.
        // Две эти величины печатаются рядом: совпадают они или нет — факт
        // о Figma, и объявлять его вместо измерения нельзя.
        members: [],
      };
      try { record.setType = setNode ? setNode.type : null; } catch (_eType) { record.setType = null; }
      try { record.setName = setNode ? setNode.name : null; } catch (_eName) { record.setName = null; }
      try { record.setChildren = setNode && setNode.children ? setNode.children.length : null; }
      catch (_eChildren) { record.setChildren = null; }
      try {
        var definitions = readComponentPropertyDefinitions(setNode);
        if (definitions) {
          record.propertyDefinitions = Object.keys(definitions).map(function (name) {
            var entry = definitions[name] || {};
            return {
              name: name,
              type: entry.type || null,
              variantOptions: entry.variantOptions || null,
              defaultValue: entry.defaultValue === undefined ? null : entry.defaultValue,
            };
          });
        }
      } catch (_eDefs) { record.propertyDefinitions = null; }

      // Участники читаются в порядке ДЕТЕЙ НАБОРА, а не в порядке реестра:
      // отчёт обязан показывать то, что получилось, а не то, что подавали.
      var childOrder = [];
      try { childOrder = (setNode && setNode.children ? setNode.children : []).slice(); }
      catch (_eOrder) { childOrder = []; }
      for (var m = 0; m < childOrder.length && m < 4; m++) {
        var childDefinitionId = null;
        try {
          childDefinitionId = typeof childOrder[m].getPluginData === "function"
            ? childOrder[m].getPluginData("pixsoDirectDefinitionId") || null : null;
        } catch (_eChildData) { childDefinitionId = null; }
        var known = childDefinitionId ? group.members[childDefinitionId] : null;
        var memberState = directDefinitionState(session, childDefinitionId);
        var memberRecord = {
          definitionId: childDefinitionId,
          expectedName: known ? known.variantName : null,
          sourceName: known ? known.sourceName : null,
          type: memberState.type,
          available: memberState.available,
          name: null,
          parentIsSet: null,
          variantProperties: null,
        };
        try { memberRecord.name = memberState.component ? memberState.component.name : null; }
        catch (_eMemberName) { memberRecord.name = null; }
        try {
          var parent = memberState.component ? memberState.component.parent : null;
          memberRecord.parentIsSet = !!(parent && setNode && parent === setNode);
        } catch (_eMemberParent) { memberRecord.parentIsSet = null; }
        try {
          memberRecord.variantProperties = memberState.component
            ? memberState.component.variantProperties || null : null;
        } catch (_eMemberVariant) { memberRecord.variantProperties = null; }
        record.members.push(memberRecord);
      }
      sets.push(record);
    }

    for (var i = 0; i < session.variantInstanceSamples.length; i++) {
      var sample = session.variantInstanceSamples[i];
      var entry = {
        occurrenceId: sample.occurrenceId,
        expectedDefinitionId: sample.definitionId,
        type: null,
        mainComponentId: null,
        mainComponentDefinitionId: null,
        mainComponentMatches: null,
        variantProperties: null,
      };
      try { entry.type = sample.node.type; } catch (_eInstanceType) { entry.type = null; }
      // `mainComponent` — синхронный getter, и под `documentAccess:
      // "dynamic-page"` он бросает. Мастер читается только асинхронно.
      var main = null;
      try {
        if (typeof sample.node.getMainComponentAsync === "function") {
          main = await sample.node.getMainComponentAsync();
        }
      } catch (_eMain) { main = null; }
      if (main) {
        try { entry.mainComponentId = main.id ? String(main.id) : null; } catch (_eMainId) { entry.mainComponentId = null; }
        try {
          entry.mainComponentDefinitionId =
            typeof main.getPluginData === "function" ? main.getPluginData("pixsoDirectDefinitionId") || null : null;
        } catch (_eMainData) { entry.mainComponentDefinitionId = null; }
        if (entry.mainComponentDefinitionId !== null) {
          entry.mainComponentMatches = entry.mainComponentDefinitionId === sample.definitionId;
        }
      }
      try { entry.variantProperties = sample.node.variantProperties || null; }
      catch (_eVariantProps) { entry.variantProperties = null; }
      instances.push(entry);
    }

    return { sets: sets, instances: instances };
  }

  // ===========================================================================
  // Диагностическая сверка построенного дерева.
  //
  // Включается ТОЛЬКО явным флагом и ничего не меняет в документе. Нужна для
  // одного вопроса, на который счётчики не отвечают: два прогона одного и
  // того же корня с разными шлюзами дали одинаковый результат или нет.
  // Читается то, что видит пользователь: тип, габарит, положение, раскладка,
  // видимость, текст и количество заливок.
  // ===========================================================================

  var VERIFY_TREE_CAP = 40000;

  var VERIFY_FIELDS = [
    "type", "width", "height", "x", "y", "visible", "opacity", "rotation",
    "layoutMode", "itemSpacing", "primaryAxisSizingMode", "counterAxisSizingMode",
    "primaryAxisAlignItems", "counterAxisAlignItems",
    "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
    "layoutAlign", "layoutGrow", "layoutPositioning", "characters", "fontSize",
    "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textCase",
    "cornerRadius", "clipsContent", "name", "blendMode",
    "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId",
    "strokeWeight", "strokeAlign",
  ];

  /** Компактная подпись набора красок: тип, цвет, прозрачность, видимость. */
  function directPaintSignature(paints) {
    if (!paints || !paints.length) return [];
    var out = [];
    for (var i = 0; i < paints.length && i < 6; i++) {
      var paint = paints[i] || {};
      var color = paint.color || {};
      out.push([
        paint.type || "?",
        color.r === undefined ? "-" : Math.round(color.r * 255),
        color.g === undefined ? "-" : Math.round(color.g * 255),
        color.b === undefined ? "-" : Math.round(color.b * 255),
        paint.opacity === undefined ? 1 : Math.round(paint.opacity * 100) / 100,
        paint.visible === false ? "off" : "on",
        paint.imageHash ? "img" : "",
      ].join(":"));
    }
    return out;
  }

  async function directSnapshotNode(node, treePath) {
    var entry = { path: treePath };
    for (var f = 0; f < VERIFY_FIELDS.length; f++) {
      var field = VERIFY_FIELDS[f];
      var value;
      try { value = node[field]; } catch (_eField) { value = "<throws>"; }
      if (value === undefined) continue;
      if (typeof value === "number") value = Math.round(value * 100) / 100;
      if (value === figma.mixed) value = "<mixed>";
      if (typeof value === "object" && value !== null) continue;
      entry[field] = value;
    }
    // Заливки и обводки сверяются ЗНАЧЕНИЯМИ, а не количеством: серый блок
    // вместо содержимого — это ровно тот дефект, который счёт красок
    // пропускает.
    try { entry.fills = directPaintSignature(node.fills); } catch (_eFills) { entry.fills = "<throws>"; }
    try { entry.strokes = directPaintSignature(node.strokes); } catch (_eStrokes) { entry.strokes = "<throws>"; }
    try { entry.effects = (node.effects || []).length; } catch (_eEffects) { entry.effects = null; }
    try { entry.childCount = node.children ? node.children.length : null; } catch (_eCount) { entry.childCount = null; }
    try {
      entry.fontName = node.fontName && node.fontName !== figma.mixed
        ? node.fontName.family + "/" + node.fontName.style : null;
    } catch (_eFont) { entry.fontName = null; }
    // Мастер и variant-координата вхождения: под dynamic-page мастер
    // читается только асинхронно.
    if (entry.type === "INSTANCE") {
      var main = null;
      try {
        if (typeof node.getMainComponentAsync === "function") main = await node.getMainComponentAsync();
      } catch (_eMain) { main = null; }
      try { entry.mainComponentId = main && main.id ? String(main.id) : null; } catch (_eMainId) { entry.mainComponentId = null; }
      try { entry.mainComponentName = main ? main.name : null; } catch (_eMainName) { entry.mainComponentName = null; }
      try {
        entry.mainDefinitionId = main && typeof main.getPluginData === "function"
          ? main.getPluginData("pixsoDirectDefinitionId") || null : null;
      } catch (_eMainDef) { entry.mainDefinitionId = null; }
      try {
        entry.mainParentType = main && main.parent ? main.parent.type : null;
      } catch (_eMainParent) { entry.mainParentType = null; }
      var variant = null;
      try { variant = node.variantProperties || null; } catch (_eVariant) { variant = null; }
      if (variant) {
        var keys = Object.keys(variant).sort();
        entry.variantProperties = keys.map(function (key) { return key + "=" + variant[key]; }).join(", ");
      } else {
        entry.variantProperties = null;
      }
    }
    try {
      entry.sourceId = typeof node.getPluginData === "function"
        ? node.getPluginData("pixsoDirectSourceId") || "" : "";
    } catch (_eSource) { entry.sourceId = ""; }
    try {
      entry.definitionId = typeof node.getPluginData === "function"
        ? node.getPluginData("pixsoDirectDefinitionId") || "" : "";
    } catch (_eDefinition) { entry.definitionId = ""; }
    try {
      entry.fallback = typeof node.getPluginData === "function"
        ? node.getPluginData("pixsoDirectFallback") || "" : "";
    } catch (_eFallback) { entry.fallback = ""; }
    return entry;
  }

  /**
   * `options.storedState` — сверка по сохранённому состоянию. Чтение слоёв
   * инстанса сразу после правок в живой Figma
   * показывает закешированную геометрию; правду о сохранённом состоянии
   * показала только копия инстанса (FIGMA_CAPABILITIES.md). Поэтому у каждого
   * вхождения собственный узел читается живым (его размер задаёт родитель), а
   * содержимое — с временной копии на той же странице, которая сразу удаляется.
   */
  async function directVerifyTree(session, options) {
    var storedState = !!(options && options.storedState);
    var clonesRead = 0;
    var cloneFailures = 0;
    var out = [];
    var slice = { startedAt: Date.now() };
    // Single-root режим кладёт корень на ТЕКУЩУЮ страницу и в `session.pages`
    // её не заводит: без неё сверка не нашла бы ничего.
    var candidates = [];
    Object.keys(session.pages).forEach(function (key) { candidates.push(session.pages[key]); });
    if (session.firstPage && candidates.indexOf(session.firstPage) < 0) candidates.push(session.firstPage);

    // На одну страницу могло приехать несколько прогонов одного корня.
    // Берётся ПОСЛЕДНИЙ: Figma добавляет новых детей в конец, и сверять надо
    // результат этого прогона, а не соседнего.
    var latest = Object.create(null);
    for (var p = 0; p < candidates.length; p++) {
      var page = candidates[p];
      if (!isPageAlive(page)) continue;
      var children = [];
      try { children = page.children || []; } catch (_eChildren) { children = []; }
      for (var c = 0; c < children.length; c++) {
        var sourceId = "";
        try {
          sourceId = typeof children[c].getPluginData === "function"
            ? children[c].getPluginData("pixsoDirectSourceId") || "" : "";
        } catch (_eRootData) { sourceId = ""; }
        if (sourceId && session.importedRootIds.indexOf(sourceId) >= 0) latest[sourceId] = children[c];
      }
    }
    var roots = session.importedRootIds
      .map(function (id) { return latest[id]; })
      .filter(function (node) { return !!node; });
    var stack = [];
    for (var r = roots.length - 1; r >= 0; r--) {
      stack.push({ node: roots[r], path: String(r), page: directVerifyPageOf(roots[r]) });
    }
    var pendingClones = [];
    try {
      while (stack.length && out.length < VERIFY_TREE_CAP) {
        var frame = stack.pop();
        var entry = await directSnapshotNode(frame.node, frame.path);
        if (frame.stored) entry.storedState = true;
        out.push(entry);
        var childrenOwner = frame.node;
        if (storedState && !frame.stored && entry.type === "INSTANCE" && entry.sourceId && frame.page) {
          var copy = null;
          try {
            copy = frame.node.clone();
            frame.page.appendChild(copy);
            copy.x = -100000;
            copy.y = -100000;
            pendingClones.push(copy);
            clonesRead += 1;
          } catch (_eClone) {
            cloneFailures += 1;
            copy = null;
          }
          if (copy) childrenOwner = copy;
        }
        var kids = [];
        try { kids = childrenOwner.children || []; } catch (_eKids) { kids = []; }
        for (var k = kids.length - 1; k >= 0; k--) {
          stack.push({ node: kids[k], path: frame.path + "/" + k, page: frame.page,
            stored: frame.stored || childrenOwner !== frame.node });
        }
        await yieldIfNeeded(slice);
      }
    } finally {
      for (var pc = 0; pc < pendingClones.length; pc++) {
        try { pendingClones[pc].remove(); } catch (_eRemoveClone) {}
      }
    }
    return {
      roots: roots.length, nodes: out.length, truncated: out.length >= VERIFY_TREE_CAP,
      storedState: storedState, clonesRead: clonesRead, cloneFailures: cloneFailures,
      tree: out,
    };
  }

  function directVerifyPageOf(node) {
    var current = node;
    var guard = 0;
    while (current && guard++ < 512) {
      if (current.type === "PAGE") return current;
      try { current = current.parent; } catch (_ePageParent) { return null; }
    }
    return null;
  }

  /**
   * Снимок ОПРЕДЕЛЕНИЙ по списку id. Тоже только по явному флагу.
   *
   * Отвечает на вопрос, который снимок корня не берёт: пришёл ли дефект из
   * самого определения или появился уже на вхождении.
   */
  async function directVerifyDefinitions(session, definitionIds) {
    var out = [];
    var slice = { startedAt: Date.now() };
    for (var i = 0; i < definitionIds.length; i++) {
      var state = directDefinitionState(session, String(definitionIds[i]));
      var record = {
        definitionId: String(definitionIds[i]),
        available: state.available,
        subreason: state.subreason,
        parentType: null,
        tree: [],
      };
      try { record.parentType = state.component && state.component.parent ? state.component.parent.type : null; }
      catch (_eParent) { record.parentType = null; }
      if (state.component) {
        var stack = [{ node: state.component, path: "" }];
        while (stack.length && record.tree.length < 2000) {
          var frame = stack.pop();
          record.tree.push(await directSnapshotNode(frame.node, frame.path || "0"));
          var kids = [];
          try { kids = frame.node.children || []; } catch (_eKids) { kids = []; }
          for (var k = kids.length - 1; k >= 0; k--) {
            stack.push({ node: kids[k], path: (frame.path || "0") + "/" + k });
          }
          await yieldIfNeeded(slice);
        }
      }
      out.push(record);
    }
    return out;
  }

  /**
   * Сборка чанка определений.
   *
   * Порядок фаз здесь — не стиль, а измеренное требование живой Figma:
   *
   *   1. создать пустые ComponentNode и назвать их канонической координатой;
   *   2. объединить участников семейств в COMPONENT_SET;
   *   3. только теперь наполнить определения содержимым — вместе с
   *      вложенными вхождениями других определений;
   *   4. проверить годность и подтвердить доставку.
   *
   * Между 2 и 3 стоит ровно то, ради чего фазы и разведены: `combineAsVariants`
   * переселяет компонент к новому родителю, и хост заново разрешает все УЖЕ
   * существующие вхождения этого компонента. Пока вхождений нет, переселять
   * нечего. Обратный порядок измеримо портил документ: вложенные вхождения,
   * выключенные из потока раскладки (`visible = false`), после объединения
   * приезжали разложенными по геометрии определения, а не по применённой
   * дельте — текст один, а соседи расставлены под другой.
   *
   * Имя участника присваивается в фазе 1, до объединения: Figma выводит
   * variant-координату набора из имён его участников в момент сборки.
   */
  async function directBuildDefinitions(definitions, session) {
    var page = await ensureServicePage(session.registry, session.jobId, DIRECT_SERVICE_PAGE);
    var startedAt = Date.now();
    session.definitionChunks += 1;
    var chunkIndex = session.definitionChunks;
    // Подтверждение доставки: отправитель помечает определение отправленным
    // только по этим спискам. Оптимистичная отметка «отправлено» до создания
    // превращала единичный отказ в постоянную потерю всех вхождений.
    var ready = [];
    var failed = [];
    // Копии, снятые вместе со своим непригодным каноном. Они уже попали в
    // ready на первой фазе, и вернуть их подтверждёнными нельзя.
    var disowned = Object.create(null);
    // Семейства, которых коснулся этот чанк: только их и нужно собирать.
    var touchedGroups = [];
    var pendingBuilds = [];

    function reject(definitionId, reason) {
      failed.push({ definitionId: definitionId, reason: reason });
      directNote(session, reason);
    }

    // Source identity metadata is indexed for the whole chunk before any
    // component is materialized. This lets copied state-groups prove exact
    // equivalence even when the canonical and alias definitions arrive in the
    // same chunk and their nested masters appear later in the array.
    for (var metaIndex = 0; metaIndex < definitions.length; metaIndex++) {
      var metaDefinition = definitions[metaIndex];
      if (!metaDefinition || !metaDefinition.definitionId) continue;
      // Axis semantics belong to the source definition id, not only to the
      // physical ComponentNode selected as its canonical copy. Aliased
      // definitions used to skip this registry entry entirely, so a nested
      // occurrence of a HUG definition was interpreted as FIXED and retained
      // the default master's pixel width after a text override. Index every
      // delivered definition before any alias/reuse early return.
      if (metaDefinition.nodes && metaDefinition.nodes.length) {
        for (var rootIndex = 0; rootIndex < metaDefinition.nodes.length; rootIndex++) {
          var metaRoot = metaDefinition.nodes[rootIndex];
          if (!metaRoot || metaRoot.parent) continue;
          session.definitionRootSpecs[metaDefinition.definitionId] = metaRoot;
          break;
        }
      }
      var metaMap = directIndexDefinitionStructure(metaDefinition);
      session.definitionStructuralMaps[metaDefinition.definitionId] = metaMap;
      directInvalidateDefinitionIndexes(session, metaDefinition.definitionId);
      session.definitionComponentKeys[metaDefinition.definitionId] = metaDefinition.componentKey || null;
      directRegisterPublicationIdentity(session, metaDefinition.definitionId,
        metaDefinition.publicationIdentity || metaDefinition.variantSet && metaDefinition.variantSet.publicationIdentity || null);
      session.definitionComponentNameHierarchies[metaDefinition.definitionId] =
        directComponentNameHierarchySegments(
          metaDefinition.variantSet && metaDefinition.variantSet.groupName || metaDefinition.name || ""
        );
      session.definitionNodeCounts[metaDefinition.definitionId] =
        Array.isArray(metaDefinition.nodes) ? metaDefinition.nodes.length : 0;
      session.definitionCanonicalRichness[metaDefinition.definitionId] =
        Number(metaDefinition.canonicalRichness || metaDefinition.variantSet && metaDefinition.variantSet.canonicalRichness) || 0;
      session.definitionVariantIdentities[metaDefinition.definitionId] =
        metaDefinition.variantSet && metaDefinition.variantSet.variantName
          ? String(metaDefinition.variantSet.variantName) : null;
      session.definitionStructuralSignatures[metaDefinition.definitionId] = Object.keys(metaMap)
        .sort()
        .map(function (pathKey) {
          var entry = metaMap[pathKey] || {};
          return pathKey + ":" + String(entry.targetType || "");
        })
        .join("|");
      directIndexDefinitionIdentity(session, metaDefinition);
    }

    // D48: choose the richest demanded mirror for each exact published
    // family+coordinate before creating any ComponentNode. This avoids making
    // discovery order the canonical copy (notably root-only Internal Canvas
    // stubs). An already materialized canonical from an earlier chunk remains
    // authoritative; replacing live components mid-job would invalidate
    // existing instances.
    var canonicalChoice = Object.create(null);
    for (var choiceIndex = 0; choiceIndex < definitions.length; choiceIndex++) {
      var choiceDefinition = definitions[choiceIndex];
      var choiceKey = directVariantCanonicalKey(choiceDefinition);
      if (!choiceKey) continue;
      var existingCanonical = session.variantCanonicalByStableCoordinate[choiceKey] || null;
      if (existingCanonical && (directDefinitionState(session, existingCanonical).available || session.definitions[existingCanonical])) {
        canonicalChoice[choiceKey] = existingCanonical;
        continue;
      }
      var selected = canonicalChoice[choiceKey] || null;
      var selectedRichness = selected ? (session.definitionCanonicalRichness[selected] || 0) : -1;
      var choiceRichness = session.definitionCanonicalRichness[choiceDefinition.definitionId] || 0;
      if (!selected || choiceRichness > selectedRichness) canonicalChoice[choiceKey] = choiceDefinition.definitionId;
    }
    Object.keys(canonicalChoice).forEach(function (choiceKey) {
      var existingCanonical = session.variantCanonicalByStableCoordinate[choiceKey] || null;
      if (!existingCanonical || !directDefinitionState(session, existingCanonical).available) {
        session.variantCanonicalByStableCoordinate[choiceKey] = canonicalChoice[choiceKey];
      }
    });

    var originalSequenceByDefinition = Object.create(null);
    definitions.forEach(function (definition, index) { originalSequenceByDefinition[definition.definitionId] = index; });
    var phaseDefinitions = definitions.slice().sort(function (left, right) {
      var leftKey = directVariantCanonicalKey(left);
      var rightKey = directVariantCanonicalKey(right);
      var leftCanonical = leftKey && session.variantCanonicalByStableCoordinate[leftKey] === left.definitionId;
      var rightCanonical = rightKey && session.variantCanonicalByStableCoordinate[rightKey] === right.definitionId;
      if (leftCanonical !== rightCanonical) return leftCanonical ? -1 : 1;
      return originalSequenceByDefinition[left.definitionId] - originalSequenceByDefinition[right.definitionId];
    });

    // --- Фаза 1: пустые компоненты, имена и принадлежность семейству --------
    for (var i = 0; i < phaseDefinitions.length; i++) {
      // Сборка определений — самый долгий непрерывный кусок всего импорта
      // (в замерах до 66 секунд на один chunk). Без уступки потока Figma
      // всё это время не перерисовывается и выглядит зависшей, а UI плагина
      // не успевает даже отправить heartbeat.
      await yieldIfNeeded(session.slice);
      var definition = phaseDefinitions[i];
      var sourceSequence = originalSequenceByDefinition[definition.definitionId];
      var existing = directDefinitionState(session, definition.definitionId);
      if (existing.available) {
        // Уникальное определение собирается один раз на job: повторная
        // встреча в другом chunk даёт ссылку, а не второе дерево.
        session.totals.definitionsReused += 1;
        ready.push(definition.definitionId);
        continue;
      }

      if (existing.registered) {
        // Запись есть, но она непригодна. Пересоздать её здесь — не
        // «восстановление вслепую»: это ровно тот же путь первичной сборки
        // из того же материала, а прежняя ссылка уже доказано мертва.
        delete session.definitions[definition.definitionId];
        directNote(session, "DEFINITION_REBUILT_AFTER_" + existing.subreason);
      }

      var canonicalAlias = directCanonicalVariantAlias(session, definition);
      if (canonicalAlias) {
        session.definitions[definition.definitionId] = canonicalAlias.component;
        var canonicalGroupId = directVariantGroupOfDefinition(session, canonicalAlias.definitionId);
        if (canonicalGroupId) {
          session.variantGroupByDefinition[definition.definitionId] = canonicalGroupId;
          directAttachAliasedLocalVariantGroup(session, definition.variantSet, canonicalGroupId);
        }
        session.variantCanonicalAliases[definition.definitionId] = canonicalAlias.definitionId;
        var aliasEntry = directRegisterDefinition(session, definition, canonicalAlias.component, chunkIndex, sourceSequence);
        aliasEntry.acknowledged = true;
        session.totals.definitionsReused += 1;
        session.totals.variantCanonicalAliases = (session.totals.variantCanonicalAliases || 0) + 1;
        ready.push(definition.definitionId);
        continue;
      }

      // Копия обычного (не вариантного) определения. Доказательство то же,
      // которым приёмник адресует overrides; недоказанная пара остаётся двумя
      // компонентами.
      var provenAlias = directEquivalentDefinitionAlias(session, definition);
      if (provenAlias) {
        directAliasDefinitionToProvenCopy(session, definition, provenAlias, chunkIndex, sourceSequence);
        ready.push(definition.definitionId);
        continue;
      }

      var component = figma.createComponent();
      try { page.appendChild(component); }
      catch (_eAppend) {
        // Незакреплённый компонент остаётся висеть на текущей странице
        // документа. Он не в реестре, вхождений не даст, но переотправка
        // создаст рядом второй такой же — это и есть дубликат канонического
        // определения на повторе. Неудачная сборка обязана убирать за собой.
        directDiscardDefinition(session, definition.definitionId, component);
        reject(definition.definitionId, "DEFINITION_PAGE_REJECTED");
        continue;
      }
      setPluginData(component, "pixsoDirectDefinitionId", definition.definitionId);
      setPluginData(component, "pixsoDirectComponentKey", definition.componentKey || "");
      if (definition.variantGroupId) {
        // Признак «лежал в группе состояний» у источника. Он остаётся у
        // ЛЮБОГО такого определения, в том числе у отклонённой группы: сам
        // по себе он нативной сборки не обещает.
        setPluginData(component, "pixsoDirectVariantGroup", definition.variantGroupId);
      }
      if (definition.variantSet && definition.variantSet.variantName) {
        // Исходное имя Pixso остаётся следом рядом с координатой: нативная
        // семантика строится на второй, а первое нужно, чтобы участника
        // набора можно было сопоставить с документом-источником.
        setPluginData(component, "pixsoDirectVariantName", definition.variantSet.variantName);
        setPluginData(component, "pixsoDirectSourceName", definition.variantSet.sourceName || "");
        // Имя — ДО объединения: из него Figma выводит variant-координату.
        setValue(component, "name", definition.variantSet.variantName);
      }
      session.definitions[definition.definitionId] = component;
      if (definition.nodes && definition.nodes.length) {
        for (var rs = 0; rs < definition.nodes.length; rs++) {
          var candidateRoot = definition.nodes[rs];
          if (!candidateRoot || candidateRoot.parent) continue;
          session.definitionRootSpecs[definition.definitionId] = candidateRoot;
          break;
        }
      }
      // Участник семейства записывается здесь, до наполнения содержимым:
      // набор обязан существовать раньше первого вхождения его участников,
      // включая вложенные вхождения внутри соседних определений.
      var joinedGroup = directRegisterVariantMember(session, definition, component);
      if (joinedGroup && touchedGroups.indexOf(joinedGroup.groupId) < 0) {
        touchedGroups.push(joinedGroup.groupId);
      }
      var canonicalKey = directVariantCanonicalKey(definition);
      if (canonicalKey && !session.variantCanonicalByStableCoordinate[canonicalKey]) {
        session.variantCanonicalByStableCoordinate[canonicalKey] = definition.definitionId;
      }
      pendingBuilds.push({ definition: definition, component: component, sequence: sourceSequence });
    }

    // --- Фаза 2: наборы вариантов, пока вхождений ещё нет -------------------
    if (touchedGroups.length) await directCombineVariantGroups(session, touchedGroups);

    // --- Фаза 3+4: содержимое, годность, подтверждение ----------------------
    pendingBuilds.sort(function (left, right) { return left.sequence - right.sequence; });
    for (var b = 0; b < pendingBuilds.length; b++) {
      var build = pendingBuilds[b];
      // После combine владелец схемы уже окончателен: standalone COMPONENT
      // либо родительский COMPONENT_SET. Объявляем native properties до
      // наполнения, чтобы componentPropertyReferences можно было назначить
      // тем же проходом, который создаёт слои определения.
      var nativeNames = directEnsureNativeProperties(build.definition, build.component, session);
      directResolveNativeBindings(build.definition.nodes, nativeNames, session);
      session.definitionStructuralMaps[build.definition.definitionId] =
        directIndexDefinitionStructure(build.definition);
      directInvalidateDefinitionIndexes(session, build.definition.definitionId);
      session.definitionComponentKeys[build.definition.definitionId] =
        build.definition.componentKey || null;
      directRegisterPublicationIdentity(session, build.definition.definitionId,
        build.definition.publicationIdentity || build.definition.variantSet && build.definition.variantSet.publicationIdentity || null);
      session.definitionComponentNameHierarchies[build.definition.definitionId] =
        directComponentNameHierarchySegments(
          build.definition.variantSet && build.definition.variantSet.groupName || build.definition.name || ""
        );
      session.definitionNodeCounts[build.definition.definitionId] =
        Array.isArray(build.definition.nodes) ? build.definition.nodes.length : 0;
      session.definitionCanonicalRichness[build.definition.definitionId] =
        Number(build.definition.canonicalRichness || build.definition.variantSet && build.definition.variantSet.canonicalRichness) || 0;
      session.definitionVariantIdentities[build.definition.definitionId] =
        build.definition.variantSet && build.definition.variantSet.variantName
          ? String(build.definition.variantSet.variantName) : null;
      var directShapeMap = session.definitionStructuralMaps[build.definition.definitionId];
      session.definitionStructuralSignatures[build.definition.definitionId] = Object.keys(directShapeMap)
        .sort()
        .map(function (pathKey) {
          var entry = directShapeMap[pathKey] || {};
          return pathKey + ":" + String(entry.targetType || "");
        })
        .join("|");
      if (session.componentIdentityLedger &&
          session.componentIdentityLedger.definitions.length < session.componentIdentityLedger.limit) {
        var variantDescriptor = build.definition.variantSet || null;
        session.componentIdentityLedger.definitions.push({
          sourceDefinitionId: build.definition.definitionId || null,
          localStateGroupId: build.definition.variantGroupId || null,
          stableFamilyKey: variantDescriptor && variantDescriptor.stableFamilyKey || null,
          componentKey: build.definition.componentKey || null,
          sourceVariantName: variantDescriptor && variantDescriptor.sourceName || null,
          variantCoordinate: variantDescriptor && variantDescriptor.variantName || null,
          structuralSignature: session.definitionStructuralSignatures[build.definition.definitionId] || null,
          finalFigmaComponentId: nodeIdentity(build.component) || null,
          finalFigmaComponentSetId: directInsideVariantSet(build.component) ? nodeIdentity(build.component.parent) : null
        });
      }
      await directBuildNodes(build.definition.nodes, session, { rootNode: build.component });
      // Имя участника набора — его variant-координата, и сборка содержимого
      // не имеет права её переписать: Figma читает координату из имени.
      // В здоровом пакете корень определения и дескриптор несут одну и ту же
      // строку, поэтому здесь обычно ничего не происходит.
      if (build.definition.variantSet && build.definition.variantSet.variantName) {
        // Keep the canonical `Axis=Value` coordinate on the actual Figma
        // ComponentNode. The raw Pixso child name is preserved in plugin data
        // (`pixsoDirectSourceName`) only; renaming a variant after combine can
        // mutate the set's variant schema.
        setValue(build.component, "name", build.definition.variantSet.variantName);
      }
      // Участник внутри набора раскладкой набора и распоряжается: полка —
      // для самостоятельных определений.
      if (!directInsideVariantSet(build.component)) directPlaceOnShelf(session, build.component);
      var entry = directRegisterDefinition(session, build.definition, build.component, chunkIndex, build.sequence);

      // Годность проверяется ПОСЛЕ сборки и ровно тем же кодом, что и на
      // использовании. Иначе «ok» подтверждал бы намерение, а не результат.
      var built = directDefinitionState(session, build.definition.definitionId);
      if (!built.available) {
        // Непригодная сборка снимается целиком: и ссылка, и запись реестра,
        // и сам узел. Иначе следующая попытка увидит «запись есть» и уйдёт
        // в пересборку, оставив на служебной странице первый экземпляр —
        // два канонических определения на один definitionId.
        directDiscardDefinition(session, build.definition.definitionId, build.component);
        reject(build.definition.definitionId, "DEFINITION_UNUSABLE_AFTER_BUILD");
        // Копии, схлопнутые в этот компонент, — доказано то же дерево. Если
        // оно не собралось, не собралось и у них: оставить их указывать на
        // снятый узел значило бы обещать вхождения, которых не будет.
        directRejectProvenCopiesOf(session, build.definition.definitionId, function (aliasId) {
          disowned[aliasId] = true;
          reject(aliasId, "DEFINITION_UNUSABLE_AFTER_BUILD");
        });
        continue;
      }
      entry.acknowledged = true;
      ready.push(build.definition.definitionId);
      session.totals.definitionsCreated += 1;
      session.totals.definitionNodes += build.definition.nodes.length;
    }
    session.timings.definitionBuildMs += Date.now() - startedAt;
    return {
      ready: ready.filter(function (definitionId) { return !disowned[definitionId]; }),
      failed: failed,
    };
  }

  /** Лежит ли компонент внутри набора вариантов. */
  function directInsideVariantSet(component) {
    try {
      var parent = component && component.parent;
      return !!(parent && parent.type === "COMPONENT_SET");
    } catch (_eInside) { return false; }
  }

  // -------------------------------------------------------------------------
  // Ассеты
  // -------------------------------------------------------------------------

  // Figma отвергает некоторые корректные raster-ресурсы Pixso, в частности
  // изображения, чья сторона превышает host-limit. Main thread не имеет
  // canvas/image decoder, зато UI iframe имеет. Запрос идёт только ПОСЛЕ
  // реального reject createImage: здоровые ассеты не декодируются повторно.
  var directImageFallbackSeq = 0;
  var directImageFallbackPending = Object.create(null);

  function directRequestImageDownsample(asset, maxDimension) {
    return new Promise(function (resolve, reject) {
      if (!figma || !figma.ui || typeof figma.ui.postMessage !== "function") {
        reject(new Error("IMAGE_DOWNSAMPLE_UI_UNAVAILABLE"));
        return;
      }
      directImageFallbackSeq += 1;
      var requestId = "direct-image-" + directImageFallbackSeq;
      var timer = setTimeout(function () {
        delete directImageFallbackPending[requestId];
        reject(new Error("IMAGE_DOWNSAMPLE_TIMEOUT"));
      }, 20000);
      directImageFallbackPending[requestId] = {
        resolve: function (result) { clearTimeout(timer); resolve(result); },
        reject: function (error) { clearTimeout(timer); reject(error); },
      };
      figma.ui.postMessage({
        type: "image-downsample-request",
        requestId: requestId,
        assetId: asset.assetId,
        extension: asset.extension || "png",
        bytesBase64: asset.bytesBase64,
        maxDimension: maxDimension || 4096,
      });
    });
  }

  function directResolveImageDownsample(message) {
    var pending = message && directImageFallbackPending[message.requestId];
    if (!pending) return false;
    delete directImageFallbackPending[message.requestId];
    if (message.type === "image-downsample-result" && message.bytesBase64) pending.resolve(message);
    else pending.reject(new Error((message && message.message) || "IMAGE_DOWNSAMPLE_FAILED"));
    return true;
  }

  async function directRegisterAssets(assets, session) {
    var startedAt = Date.now();
    for (var i = 0; i < assets.length; i++) {
      var asset = assets[i];
      if (session.assets[asset.assetId]) continue;
      if (!asset.bytesBase64) { directNote(session, "ASSET_WITHOUT_BYTES"); continue; }
      var image = null;
      try {
        image = figma.createImage(bytesFromBase64(asset.bytesBase64));
      } catch (_eImage) {
        // Универсальный visual fallback для валидного raster source, который
        // не принимает host. Сначала максимально сохраняем разрешение.
        try {
          var normalized = await directRequestImageDownsample(asset, 4096);
          image = figma.createImage(bytesFromBase64(normalized.bytesBase64));
          session.totals.assetsDownsampled += 1;
        } catch (_eFallback) {
          directNote(session, "ASSET_REJECTED");
        }
      }
      if (image) {
        session.assets[asset.assetId] = image.hash;
        session.totals.assetsCreated += 1;
      }
    }
    session.timings.assetMs += Date.now() - startedAt;
  }

  // -------------------------------------------------------------------------
  // Страницы и задачи
  // -------------------------------------------------------------------------

  function directSourceFileKey(session) {
    var source = session && session.source || {};
    return String(source.fileKey || source.fileName || "");
  }

  function directFindPage(sourcePageId, session) {
    var all = [];
    try { all = figma.root.children || []; } catch (_eRoot) { return null; }
    for (var i = 0; i < all.length; i++) {
      try {
        if (all[i].getPluginData("pixsoDirectSourcePageId") === String(sourcePageId || "") &&
            all[i].getPluginData("pixsoDirectSourceFile") === directSourceFileKey(session)) return all[i];
      } catch (_eData) { /* недоступная страница не подходит */ }
    }
    return null;
  }

  async function directEnsurePage(name, sourcePageId, session, options) {
    if (!options.createPages && !session.fullDocument) {
      var current = figma.currentPage;
      await ensurePageLoaded(current);
      if (!isPageAlive(session.firstPage)) session.firstPage = current;
      return current;
    }
    var key = String(sourcePageId || name || "Pixso Direct");
    if (!isPageAlive(session.pages[key])) {
      var existing = directFindPage(key, session);
      if (existing) {
        session.pages[key] = existing;
      } else {
        var page = figma.createPage();
        page.name = String(name || "Pixso Direct");
        setPluginData(page, "pixsoDirectSourcePageId", key);
        setPluginData(page, "pixsoDirectSourceFile", directSourceFileKey(session));
        session.pages[key] = page;
      }
    }
    var target = session.pages[key];
    // Переименование исходной страницы между прогонами воспроизводится, но
    // чужая одноимённая страница без ownership marker не затрагивается.
    setValue(target, "name", String(name || "Pixso Direct"));
    await ensurePageLoaded(target);
    await ensureCurrentPage(target);
    if (!isPageAlive(session.firstPage)) session.firstPage = target;
    return target;
  }

  // ===========================================================================
  // Лаборатория живой Figma (DIRECT_PIX_PROBE).
  //
  // Отвечает на вопрос, который тестовый двойник ответить не может: что именно
  // живая Figma делает с правкой слоя внутри инстанса. Каждый опыт строит свой
  // маленький компонент, делает ОДНО действие и читает результат четырежды:
  //
  //   immediate — сразу после действия;
  //   afterTick — после паузы (ленивый пересчёт раскладки);
  //   clone     — на копии инстанса: копия собирается из сохранённых правок,
  //               а не из закешированной геометрии;
  //   recompute — после того как мастер заставил инстанс пересчитаться
  //               (itemSpacing мастера +1 и обратно).
  //
  // Опыты живут на своей служебной странице, опознаваемой только по plugin
  // data; прошлая страница опытов удаляется. Документ пользователя не
  // трогается. Результат — карта возможностей живой Figma.
  // ===========================================================================

  var PROBE_PAGE_ROLE = "figma-probe";
  var PROBE_PAGE_NAME = "Pixso2Figma Probe";
  var PROBE_VERSION = 14;
  var PROBE_TOLERANCE = 0.5;

  function probeWait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function probeNumber(value) {
    return typeof value === "number" && isFinite(value) ? Math.round(value * 100) / 100 : null;
  }

  /**
   * Эталонный «аккордеон»: вертикальный корень (Hug по высоте, Fixed по
   * ширине 600), внутри шапка — горизонтальный Fixed-фрейм 600×36 со
   * слоями «заголовок» (Fill) и «бейдж» (Fixed 54).
   */
  function probeAccordion(options) {
    var opts = options || {};
    var component = figma.createComponent();
    component.name = "probe/" + (opts.name || "accordion");
    component.layoutMode = "VERTICAL";
    component.itemSpacing = 0;
    component.resize(600, 36);
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "FIXED";

    var header = figma.createFrame();
    header.name = "Header";
    component.appendChild(header);
    header.layoutMode = "HORIZONTAL";
    header.itemSpacing = 6;
    header.resize(600, 36);
    header.primaryAxisSizingMode = "FIXED";
    header.counterAxisSizingMode = "AUTO";
    header.layoutAlign = opts.headerAlign || "STRETCH";

    var title = figma.createRectangle();
    title.name = "Title";
    title.resize(100, 20);
    header.appendChild(title);
    title.layoutGrow = 1;

    var badge = figma.createRectangle();
    badge.name = "Badge";
    badge.resize(54, 20);
    header.appendChild(badge);
    badge.layoutGrow = 0;
    return component;
  }

  async function probeTextComponent(autoResize) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    var component = figma.createComponent();
    component.name = "probe/text-" + autoResize;
    component.layoutMode = "HORIZONTAL";
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "AUTO";
    var text = figma.createText();
    text.fontName = { family: "Inter", style: "Regular" };
    text.characters = "Short";
    component.appendChild(text);
    text.textAutoResize = autoResize;
    if (autoResize === "HEIGHT") text.resize(80, text.height);
    return component;
  }

  /**
   * Контейнер Fixed 44×44 (padding 4) с единственным слоем 36×36, который
   * скрыт ещё в мастере: в потоке нет ни одного видимого ребёнка. Форма
   * фикстуры `AutoLayoutSizingTest` («Empty hug»).
   */
  function probeHiddenOnly(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.paddingLeft = component.paddingRight = component.paddingTop = component.paddingBottom = 4;
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "FIXED";
    component.resize(44, 44);
    var hidden = figma.createRectangle();
    hidden.name = "Hidden";
    hidden.resize(36, 36);
    component.appendChild(hidden);
    hidden.visible = false;
    return component;
  }

  /**
   * Цикл Hug + Fill, собранный в порядке приёмника: узлы получают размеры
   * источника, дети добавляются, затем контейнеру ставится auto layout с Hug
   * и только после этого детям — растягивание. Вопрос — держит ли так
   * построенный узел размеры Pixso без перевода ребёнка в FIXED.
   */
  function probeCycleCross(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.resize(200, 48);
    var text = figma.createRectangle();
    text.name = "Header";
    text.resize(120, 48);
    component.appendChild(text);
    var icon = figma.createRectangle();
    icon.name = "Icon";
    icon.resize(48, 48);
    component.appendChild(icon);
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "AUTO";
    text.layoutAlign = "STRETCH";
    icon.layoutAlign = "STRETCH";
    return component;
  }

  function probeCycleMain(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.resize(160, 40);
    var a = figma.createFrame();
    a.name = "Fill A";
    a.resize(80, 40);
    component.appendChild(a);
    var b = figma.createFrame();
    b.name = "Fill B";
    b.resize(80, 40);
    component.appendChild(b);
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "FIXED";
    a.layoutGrow = 1;
    b.layoutGrow = 1;
    return component;
  }

  /**
   * Смешанный цикл по контр-оси, как колонка на реальном файле: вертикальный
   * Hug-контейнер, широкий ребёнок 380 и узкий 105. Pixso обнимает оба —
   * контейнер 380; вопрос, что делает Figma, когда широкий растянут
   * (`stretchWide`) и когда нет (равнозначная форма без растягивания).
   */
  function probeCycleCrossMixed(name, stretchWide) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.resize(380, 64);
    var wide = figma.createFrame();
    wide.name = "Wide";
    wide.resize(380, 40);
    component.appendChild(wide);
    var button = figma.createFrame();
    button.name = "Button";
    button.resize(105, 24);
    component.appendChild(button);
    component.layoutMode = "VERTICAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "AUTO";
    if (stretchWide) wide.layoutAlign = "STRETCH";
    return component;
  }

  /**
   * Пересчёт раскладки на инстансе без смены размеров: второй ребёнок скрыт и
   * снова показан. Так на реальном импорте раскладку пересчитывает любая
   * поздняя правка содержимого.
   */
  function probeToggleSecondChild(instance) {
    var second = instance.children[1];
    second.visible = false;
    second.visible = true;
  }

  /**
   * Hug по контр-оси, где растянуты ВСЕ дети, но у них есть содержимое уже
   * своей ширины — как колонка «Input + список переключателей» на реальном
   * файле. `built-hug-counter-over-stretch` мерил пустые прямоугольники.
   * Дети — вертикальные auto layout 380 с содержимым 170 и 120.
   */
  function probeCycleCrossContent(name, stretch) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.resize(380, 80);
    [170, 120].forEach(function (inner, index) {
      var child = figma.createFrame();
      child.name = "List " + index;
      child.resize(380, 40);
      var item = figma.createFrame();
      item.name = "Item";
      item.resize(inner, 20);
      child.appendChild(item);
      child.layoutMode = "VERTICAL";
      child.itemSpacing = 0;
      child.primaryAxisSizingMode = "AUTO";
      child.counterAxisSizingMode = "FIXED";
      component.appendChild(child);
    });
    component.layoutMode = "VERTICAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "AUTO";
    if (stretch) component.children.forEach(function (child) { child.layoutAlign = "STRETCH"; });
    return component;
  }

  /** Смешанный цикл по главной оси: растущий ребёнок 300 и фиксированный 60. */
  function probeCycleMainMixed(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.resize(360, 40);
    var grow = figma.createFrame();
    grow.name = "Grow";
    grow.resize(300, 40);
    component.appendChild(grow);
    var fixed = figma.createFrame();
    fixed.name = "Fixed";
    fixed.resize(60, 40);
    component.appendChild(fixed);
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "FIXED";
    grow.layoutGrow = 1;
    return component;
  }

  /** Тот же цикл, но растянут текст с HEIGHT — форма `AutoLayoutSizingTest` («Header»). */
  async function probeCycleCrossText(name) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.resize(200, 48);
    var text = figma.createText();
    text.fontName = { family: "Inter", style: "Regular" };
    text.characters = "Header";
    component.appendChild(text);
    text.textAutoResize = "HEIGHT";
    text.resize(120, 48);
    text.textAutoResize = "HEIGHT";
    var icon = figma.createRectangle();
    icon.name = "Icon";
    icon.resize(48, 48);
    component.appendChild(icon);
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "AUTO";
    text.layoutAlign = "STRETCH";
    icon.layoutAlign = "STRETCH";
    return component;
  }

  function probeReadCycleText(root) {
    var out = probeReadCycle(root);
    var text = root && root.children && root.children[0];
    out.textAutoResize = text && text.textAutoResize || null;
    return out;
  }

  function probeReadCycle(root) {
    var first = root && root.children && root.children[0];
    var second = root && root.children && root.children[1];
    return {
      rootWidth: probeNumber(root && root.width),
      rootHeight: probeNumber(root && root.height),
      rootPrimary: root && root.primaryAxisSizingMode || null,
      rootCounter: root && root.counterAxisSizingMode || null,
      firstWidth: probeNumber(first && first.width),
      firstHeight: probeNumber(first && first.height),
      firstSizingH: first && first.layoutSizingHorizontal || null,
      firstSizingV: first && first.layoutSizingVertical || null,
      secondWidth: probeNumber(second && second.width),
      secondHeight: probeNumber(second && second.height),
    };
  }

  /**
   * Hug-контейнер с обводкой 1 px и ребёнком 100×36, собранный без явного
   * `strokesIncludedInLayout`: каково умолчание Figma и входит ли обводка в Hug.
   */
  function probeStrokedHug(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "AUTO";
    var child = figma.createRectangle();
    child.name = "Content";
    child.resize(100, 36);
    component.appendChild(child);
    component.strokes = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 } }];
    component.strokeWeight = 1;
    return component;
  }

  function probeReadStroked(root) {
    var included = null;
    try { included = root ? root.strokesIncludedInLayout : null; } catch (_e) { included = "THROWS"; }
    var align = null;
    try { align = root ? root.strokeAlign : null; } catch (_eAlign) { align = "THROWS"; }
    return {
      rootWidth: probeNumber(root && root.width),
      rootHeight: probeNumber(root && root.height),
      strokesIncludedInLayout: included === undefined ? null : included,
      strokeAlign: align,
    };
  }

  /** Hug-контейнер с одним текстом WIDTH_AND_HEIGHT заданного содержимого. */
  async function probeAutoText(name, characters) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "AUTO";
    component.strokesIncludedInLayout = false;
    var text = figma.createText();
    text.fontName = { family: "Inter", style: "Regular" };
    text.fontSize = 12;
    text.characters = characters;
    component.appendChild(text);
    text.textAutoResize = "WIDTH_AND_HEIGHT";
    return component;
  }

  function probeReadAutoText(root) {
    var text = root && root.children && root.children[0];
    var width = probeNumber(text && text.width);
    return {
      rootWidth: probeNumber(root && root.width),
      textWidth: width,
      textWidthPositive: typeof width === "number" ? width > 0 : null,
      characters: text ? JSON.stringify(text.characters) : null,
    };
  }

  /**
   * Правки слоёв внутри инстанса — массовые классы `NESTED_LOW_LEVEL_OVERRIDE`
   * (probe v11). Мастер: auto layout с прямоугольником Shape, текстом Label,
   * auto layout-фреймом Box и фреймом Free без раскладки с прямоугольником Pin.
   * Уровень `deep` — тот же мастер вложенным инстансом внутри внешнего
   * компонента: правка адресует слой второго уровня.
   */
  async function probeOverrideHost(name, deep) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    await figma.loadFontAsync({ family: "Inter", style: "Medium" });
    var inner = figma.createComponent();
    inner.name = "probe/" + name + "-inner";
    inner.layoutMode = "HORIZONTAL";
    inner.itemSpacing = 4;
    inner.primaryAxisSizingMode = "AUTO";
    inner.counterAxisSizingMode = "AUTO";
    inner.strokesIncludedInLayout = false;
    var shape = figma.createRectangle();
    shape.name = "Shape";
    shape.resize(20, 20);
    shape.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }];
    inner.appendChild(shape);
    var label = figma.createText();
    label.name = "Label";
    label.fontName = { family: "Inter", style: "Regular" };
    label.fontSize = 12;
    label.characters = "Label";
    inner.appendChild(label);
    label.textAutoResize = "WIDTH_AND_HEIGHT";
    var box = figma.createFrame();
    box.name = "Box";
    inner.appendChild(box);
    box.layoutMode = "HORIZONTAL";
    box.itemSpacing = 0;
    box.primaryAxisSizingMode = "AUTO";
    box.counterAxisSizingMode = "AUTO";
    box.strokesIncludedInLayout = false;
    box.fills = [];
    box.clipsContent = true;
    box.strokes = [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 } }];
    box.strokeWeight = 1;
    var dot = figma.createRectangle();
    dot.name = "Dot";
    dot.resize(10, 10);
    box.appendChild(dot);
    var free = figma.createFrame();
    free.name = "Free";
    free.resize(40, 40);
    inner.appendChild(free);
    var pin = figma.createRectangle();
    pin.name = "Pin";
    pin.resize(10, 10);
    free.appendChild(pin);
    pin.x = 5;
    pin.y = 5;
    // Вложенный инстанс для опыта подмены (probe v12): лист A пустой,
    // лист B несёт один слой — подмену видно по числу детей.
    var leafA = figma.createComponent();
    leafA.name = "probe/" + name + "-leaf-a";
    leafA.resize(20, 20);
    var leafB = figma.createComponent();
    leafB.name = "probe/" + name + "-leaf-b";
    leafB.resize(20, 20);
    var leafMark = figma.createRectangle();
    leafMark.name = "Mark";
    leafMark.resize(10, 10);
    leafB.appendChild(leafMark);
    var slot = leafA.createInstance();
    slot.name = "Slot";
    inner.appendChild(slot);
    var paintStyle = figma.createPaintStyle();
    paintStyle.name = "probe/" + name + "-paint";
    paintStyle.paints = [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1 } }];
    var textStyle = figma.createTextStyle();
    textStyle.name = "probe/" + name + "-text";
    textStyle.fontName = { family: "Inter", style: "Medium" };
    textStyle.fontSize = 18;
    var effectStyle = figma.createEffectStyle();
    effectStyle.name = "probe/" + name + "-effect";
    effectStyle.effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.3 },
      offset: { x: 0, y: 1 }, radius: 2, spread: 0, visible: true, blendMode: "NORMAL" }];
    var built = { component: inner, leaves: [leafA, leafB], styles: [paintStyle, textStyle, effectStyle],
      paintStyle: paintStyle, textStyle: textStyle, effectStyle: effectStyle, swapTarget: leafB, deep: !!deep };
    if (deep) {
      var outer = figma.createComponent();
      outer.name = "probe/" + name + "-outer";
      outer.layoutMode = "VERTICAL";
      outer.primaryAxisSizingMode = "AUTO";
      outer.counterAxisSizingMode = "AUTO";
      var nested = inner.createInstance();
      nested.name = "Inner";
      outer.appendChild(nested);
      built.component = outer;
      built.leaves = [inner, leafA, leafB];
    }
    return built;
  }

  /** Слои мастера адресуются позицией: опыт с переименованием меняет имя. */
  var PROBE_OVERRIDE_INDEX = { Shape: 0, Label: 1, Box: 2, Free: 3, Slot: 4 };

  function probeOverrideLayer(root, deep, layerName) {
    var host = deep ? root && root.children && root.children[0] : root;
    var kids = host && host.children || [];
    return kids[PROBE_OVERRIDE_INDEX[layerName]] || null;
  }

  function probeHex(paints) {
    var paint = Array.isArray(paints) ? paints[0] : null;
    if (!paint || paint.type !== "SOLID" || !paint.color) return null;
    function two(v) { var h = Math.round(v * 255).toString(16); return h.length < 2 ? "0" + h : h; }
    return "#" + two(paint.color.r) + two(paint.color.g) + two(paint.color.b);
  }

  function probeReadOverrideHost(deep) {
    return function (root) {
      function layer(name) { return probeOverrideLayer(root, deep, name); }
      function safe(fn) { try { var v = fn(); return v === undefined ? null : v; } catch (_e) { return "THROWS"; } }
      var shape = layer("Shape"), label = layer("Label"), box = layer("Box"), free = layer("Free");
      var pin = free && free.children && free.children[0];
      return {
        shapeVisible: safe(function () { return shape.visible; }),
        shapeFill: safe(function () { return probeHex(shape.fills); }),
        shapeFillStyle: safe(function () { return !!shape.fillStyleId && shape.fillStyleId !== figma.mixed; }),
        shapeOpacity: safe(function () { return probeNumber(shape.opacity); }),
        shapeRadius: safe(function () { return probeNumber(shape.cornerRadius); }),
        shapeLocked: safe(function () { return shape.locked; }),
        shapeName: safe(function () { return shape.name; }),
        labelFontSize: safe(function () { return probeNumber(label.fontSize); }),
        labelTextStyle: safe(function () { return !!label.textStyleId && label.textStyleId !== figma.mixed; }),
        boxSpacing: safe(function () { return probeNumber(box.itemSpacing); }),
        boxStroke: safe(function () { return probeHex(box.strokes); }),
        boxStrokeWeight: safe(function () { return probeNumber(box.strokeWeight); }),
        boxClips: safe(function () { return box.clipsContent; }),
        boxEffects: safe(function () { return (box.effects || []).length; }),
        pinConstraint: safe(function () { return pin.constraints.horizontal; }),
        slotChildren: safe(function () { return layer("Slot").children.length; }),
        boxStrokeStyle: safe(function () { return !!box.strokeStyleId && box.strokeStyleId !== figma.mixed; }),
        boxStrokeAlign: safe(function () { return box.strokeAlign; }),
        boxDash: safe(function () { return (box.dashPattern || []).join(","); }),
        boxEffectStyle: safe(function () { return !!box.effectStyleId && box.effectStyleId !== figma.mixed; }),
        shapeAspectLocked: safe(function () { return shape.targetAspectRatio !== null && shape.targetAspectRatio !== undefined; }),
        swappedWidth: null,
      };
    };
  }

  /** Опыт правки слоя: `deep` — второй уровень вложенности. */
  function probeOverrideExperiment(id, question, deep, act, expect) {
    return {
      id: (deep ? "deep-" : "nested-") + id,
      question: (deep ? "второй уровень: " : "слой инстанса: ") + question,
      build: function () { return probeOverrideHost(id, deep); },
      act: function (instance, built) {
        return act(function (name) { return probeOverrideLayer(instance, deep, name); }, built);
      },
      read: probeReadOverrideHost(deep),
      expect: expect,
      cleanup: function (built) { (built.styles || []).forEach(function (style) { try { style.remove(); } catch (_e) {} }); },
    };
  }

  var PROBE_OVERRIDE_CASES = [
    ["visible", "Shape.visible = false", function (layer) { layer("Shape").visible = false; },
      { shapeVisible: false }],
    ["fills", "Shape.fills — другой цвет", function (layer) {
      layer("Shape").fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]; }, { shapeFill: "#ff0000" }],
    ["fill-style", "Shape — привязка к локальному PaintStyle", async function (layer, built) {
      var node = layer("Shape");
      if (typeof node.setFillStyleIdAsync === "function") await node.setFillStyleIdAsync(built.paintStyle.id);
      else node.fillStyleId = built.paintStyle.id;
    }, { shapeFillStyle: true, shapeFill: "#0066ff" }],
    ["name", "Shape.name — переименование", function (layer) { layer("Shape").name = "Renamed"; },
      { shapeName: "Renamed" }],
    ["text-style", "Label.fontSize = 18", function (layer) { layer("Label").fontSize = 18; },
      { labelFontSize: 18 }],
    ["text-style-id", "Label — привязка к локальному TextStyle (18)", async function (layer, built) {
      var node = layer("Label");
      if (typeof node.setTextStyleIdAsync === "function") await node.setTextStyleIdAsync(built.textStyle.id);
      else node.textStyleId = built.textStyle.id;
    }, { labelTextStyle: true, labelFontSize: 18 }],
    ["layout", "Box.itemSpacing = 12", function (layer) { layer("Box").itemSpacing = 12; },
      { boxSpacing: 12 }],
    ["strokes", "Box.strokes + strokeWeight = 3", function (layer) {
      var node = layer("Box");
      node.strokes = [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }];
      node.strokeWeight = 3;
    }, { boxStroke: "#00ff00", boxStrokeWeight: 3 }],
    ["corners", "Shape.cornerRadius = 6", function (layer) { layer("Shape").cornerRadius = 6; },
      { shapeRadius: 6 }],
    ["opacity", "Shape.opacity = 0.5", function (layer) { layer("Shape").opacity = 0.5; },
      { shapeOpacity: 0.5 }],
    // Новый фрейм Figma создаётся с включённой обрезкой (мастер probe v11:
    // boxClips=true), поэтому правка — выключение.
    ["clips-off", "Box.clipsContent = false (мастер обрезает)", function (layer) {
      layer("Box").clipsContent = false; }, { boxClips: false }],
    ["effects", "Box.effects — тень", function (layer) {
      layer("Box").effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL" }];
    }, { boxEffects: 1 }],
    // Первый прогон (probe v11) показал отказ API: «This property cannot be
    // overridden in an instance: vertical-constraint». Отказ — ответ опыта,
    // поэтому он ловится, и вердикт получается IGNORED, а не ERROR.
    ["constraints", "Pin.constraints по горизонтали = MAX", function (layer) {
      var pin = layer("Free").children[0];
      try { pin.constraints = { horizontal: "MAX", vertical: "MIN" }; } catch (_eConstraints) {}
    }, { pinConstraint: "MAX" }],
    ["locked", "Shape.locked = true", function (layer) { layer("Shape").locked = true; },
      { shapeLocked: true }],
    // --- probe v12 ---
    ["swap", "Slot.swapComponent на лист со слоем", function (layer, built) {
      layer("Slot").swapComponent(built.swapTarget); }, { slotChildren: 1 }],
    ["stroke-style-id", "Box — привязка обводки к PaintStyle", async function (layer, built) {
      var node = layer("Box");
      if (typeof node.setStrokeStyleIdAsync === "function") await node.setStrokeStyleIdAsync(built.paintStyle.id);
      else node.strokeStyleId = built.paintStyle.id;
    }, { boxStrokeStyle: true }],
    ["stroke-props", "Box.strokeAlign = OUTSIDE и dashPattern = 2,2", function (layer) {
      var node = layer("Box");
      node.strokeAlign = "OUTSIDE";
      node.dashPattern = [2, 2];
    }, { boxStrokeAlign: "OUTSIDE", boxDash: "2,2" }],
    ["effect-style-id", "Box — привязка к EffectStyle", async function (layer, built) {
      var node = layer("Box");
      if (typeof node.setEffectStyleIdAsync === "function") await node.setEffectStyleIdAsync(built.effectStyle.id);
      else node.effectStyleId = built.effectStyle.id;
    }, { boxEffectStyle: true }],
    ["aspect-lock", "Shape.lockAspectRatio()", function (layer) {
      var node = layer("Shape");
      if (typeof node.lockAspectRatio === "function") node.lockAspectRatio();
    }, { shapeAspectLocked: true }],
  ];

  /** Контейнер Fixed 44×44 (padding 4) совсем без детей. */
  function probeChildless(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.paddingLeft = component.paddingRight = component.paddingTop = component.paddingBottom = 4;
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "FIXED";
    component.resize(44, 44);
    return component;
  }

  function probeReadBox(root) {
    return {
      rootWidth: probeNumber(root && root.width),
      rootHeight: probeNumber(root && root.height),
      rootPrimary: root && root.primaryAxisSizingMode || null,
      rootCounter: root && root.counterAxisSizingMode || null,
    };
  }

  /**
   * Вертикальный контейнер Fixed 300 с текстом WIDTH_AND_HEIGHT без
   * растягивания. Форма фикстуры `TextSizingTest` («Auto ellipsis»).
   */
  async function probeColumnText(name) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "VERTICAL";
    component.itemSpacing = 0;
    component.resize(300, 40);
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "FIXED";
    var text = figma.createText();
    text.fontName = { family: "Inter", style: "Regular" };
    text.characters = "Short";
    component.appendChild(text);
    text.textAutoResize = "WIDTH_AND_HEIGHT";
    text.layoutAlign = "INHERIT";
    text.layoutGrow = 0;
    return component;
  }

  function probeReadTextSizing(root) {
    var text = root && root.children && root.children[0];
    function field(name) {
      try { return text && typeof text[name] !== "undefined" ? text[name] : null; } catch (_e) { return "THROWS"; }
    }
    return {
      textAutoResize: field("textAutoResize"),
      textSizingH: field("layoutSizingHorizontal"),
      textSizingV: field("layoutSizingVertical"),
      textTruncation: field("textTruncation"),
      maxLines: field("maxLines"),
    };
  }

  /** Замер аккордеона: корень, шапка, бейдж. Структура одинакова у инстанса и копии. */
  function probeReadAccordion(root) {
    var header = root && root.children && root.children[0];
    var badge = header && header.children && header.children[1];
    return {
      rootWidth: probeNumber(root && root.width),
      rootCounter: root && root.counterAxisSizingMode || null,
      headerWidth: probeNumber(header && header.width),
      headerAlign: header && header.layoutAlign || null,
      headerSizing: header && header.layoutSizingHorizontal || null,
      badgeWidth: probeNumber(badge && badge.width),
    };
  }

  function probeReadText(root) {
    var text = root && root.children && root.children[0];
    return {
      rootWidth: probeNumber(root && root.width),
      textWidth: probeNumber(text && text.width),
      textAutoResize: text && text.textAutoResize || null,
    };
  }

  /** Маленький компонент-лист: прямоугольник заданной ширины. */
  function probeLeaf(name, width) {
    var leaf = figma.createComponent();
    leaf.name = "probe/leaf-" + name;
    leaf.resize(width, 20);
    return leaf;
  }

  /** Горизонтальный корень Fixed 600 с одним растягиваемым по главной оси фреймом. */
  function probeRow(name) {
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "HORIZONTAL";
    component.itemSpacing = 0;
    component.resize(600, 36);
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "AUTO";
    var body = figma.createFrame();
    body.name = "Body";
    component.appendChild(body);
    body.resize(200, 36);
    body.layoutGrow = 1;
    return component;
  }

  function probeReadRow(root) {
    var body = root && root.children && root.children[0];
    return {
      rootWidth: probeNumber(root && root.width),
      rootPrimary: root && root.primaryAxisSizingMode || null,
      bodyWidth: probeNumber(body && body.width),
      bodyGrow: body ? body.layoutGrow : null,
    };
  }

  /** Аккордеон со шапкой-текстом внутри растянутой шапки: для смены содержимого. */
  async function probeTextAccordion(name) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    var component = probeAccordion({ name: name });
    var header = component.children[0];
    var text = figma.createText();
    text.fontName = { family: "Inter", style: "Regular" };
    text.characters = "Short";
    header.appendChild(text);
    text.textAutoResize = "WIDTH_AND_HEIGHT";
    return component;
  }

  function probeReadTextAccordion(root) {
    var out = probeReadAccordion(root);
    var header = root && root.children && root.children[0];
    var text = header && header.children && header.children[2];
    out.textWidth = probeNumber(text && text.width);
    return out;
  }

  /** Вертикальный корень Fixed 600 с вложенным инстансом листа 100×20 (INHERIT). */
  function probeSlotComponent(name) {
    var leafA = probeLeaf(name + "-a", 100);
    var leafB = probeLeaf(name + "-b", 140);
    var component = figma.createComponent();
    component.name = "probe/" + name;
    component.layoutMode = "VERTICAL";
    component.itemSpacing = 0;
    component.resize(600, 20);
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "FIXED";
    var slot = leafA.createInstance();
    slot.name = "Slot";
    component.appendChild(slot);
    slot.layoutAlign = "INHERIT";
    // Узлы живой Figma нерасширяемы: служебные ссылки опыта живут рядом с
    // узлом, а не на нём.
    return { component: component, leaves: [leafA, leafB], swapTarget: leafB };
  }

  function probeReadSlot(root) {
    var slot = root && root.children && root.children[0];
    return {
      rootWidth: probeNumber(root && root.width),
      slotWidth: probeNumber(slot && slot.width),
      slotAlign: slot && slot.layoutAlign || null,
      slotName: slot && slot.name || null,
    };
  }

  /** Внешний компонент с вложенным инстансом аккордеона (шапка INHERIT, корень Fixed). */
  function probeOuterComponent(name) {
    var inner = probeAccordion({ name: name + "-inner", headerAlign: "INHERIT" });
    var outer = figma.createComponent();
    outer.name = "probe/" + name;
    outer.layoutMode = "VERTICAL";
    outer.itemSpacing = 0;
    outer.resize(600, 36);
    outer.primaryAxisSizingMode = "AUTO";
    outer.counterAxisSizingMode = "FIXED";
    var nested = inner.createInstance();
    nested.name = "Inner";
    outer.appendChild(nested);
    nested.layoutAlign = "INHERIT";
    return { component: outer, leaves: [inner] };
  }

  function probeReadOuter(root) {
    var nested = root && root.children && root.children[0];
    var header = nested && nested.children && nested.children[0];
    return {
      rootWidth: probeNumber(root && root.width),
      innerWidth: probeNumber(nested && nested.width),
      innerAlign: nested && nested.layoutAlign || null,
      headerWidth: probeNumber(header && header.width),
      headerAlign: header && header.layoutAlign || null,
    };
  }


  /** Каталог опытов. `expect` — числа, которые означали бы «Figma приняла действие». */
  var PROBE_EXPERIMENTS = [
    {
      id: "nested-frame-resize",
      question: "resize() вложенного Fixed-фрейма инстанса",
      build: function () { return probeAccordion({ name: "nested-frame-resize", headerAlign: "INHERIT" }); },
      act: function (instance) { var h = instance.children[0]; h.resize(380, h.height); },
      read: probeReadAccordion,
      expect: { headerWidth: 380 },
    },
    {
      id: "nested-frame-resize-without-constraints",
      question: "resizeWithoutConstraints() вложенного Fixed-фрейма",
      build: function () { return probeAccordion({ name: "nested-frame-rwc", headerAlign: "INHERIT" }); },
      act: function (instance) { var h = instance.children[0]; h.resizeWithoutConstraints(380, h.height); },
      read: probeReadAccordion,
      expect: { headerWidth: 380 },
    },
    {
      id: "nested-frame-sizing-fixed-then-resize",
      question: "layoutSizingHorizontal = FIXED, затем resize() вложенного фрейма",
      build: function () { return probeAccordion({ name: "nested-frame-sizing", headerAlign: "INHERIT" }); },
      act: function (instance) {
        var h = instance.children[0];
        h.layoutSizingHorizontal = "FIXED";
        h.resize(380, h.height);
      },
      read: probeReadAccordion,
      expect: { headerWidth: 380 },
    },
    {
      id: "nested-rect-resize",
      question: "resize() вложенного прямоугольника (бейдж 54 → 90)",
      build: function () { return probeAccordion({ name: "nested-rect-resize" }); },
      act: function (instance) { var b = instance.children[0].children[1]; b.resize(90, b.height); },
      read: probeReadAccordion,
      expect: { badgeWidth: 90 },
    },
    {
      id: "nested-frame-min-max",
      question: "minWidth = maxWidth = 380 у вложенного фрейма",
      build: function () { return probeAccordion({ name: "nested-frame-minmax", headerAlign: "INHERIT" }); },
      act: function (instance) { var h = instance.children[0]; h.minWidth = 380; h.maxWidth = 380; },
      read: probeReadAccordion,
      expect: { headerWidth: 380 },
    },
    {
      id: "root-resize-stretch-child",
      question: "resize() корня инстанса 600 → 380, шапка растянута",
      build: function () { return probeAccordion({ name: "root-resize" }); },
      act: function (instance) { instance.resize(380, instance.height); },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "nested-stretch-to-inherit",
      question: "корень 380, затем шапка STRETCH → INHERIT: сохранится ли 380 у шапки",
      build: function () { return probeAccordion({ name: "stretch-to-inherit" }); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.children[0].layoutAlign = "INHERIT";
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "root-hug-over-stretch-child",
      question: "корень 380, затем корень Hug при растянутой шапке",
      build: function () { return probeAccordion({ name: "hug-over-stretch" }); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.counterAxisSizingMode = "AUTO";
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "pixso-order-hug-then-inherit",
      question: "порядок Pixso-правок: корень Hug, затем шапка INHERIT (случай Accordion)",
      build: function () { return probeAccordion({ name: "hug-then-inherit" }); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.counterAxisSizingMode = "AUTO";
        instance.children[0].layoutAlign = "INHERIT";
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "pixso-order-inherit-then-hug",
      question: "обратный порядок: шапка INHERIT, затем корень Hug",
      build: function () { return probeAccordion({ name: "inherit-then-hug" }); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.children[0].layoutAlign = "INHERIT";
        instance.counterAxisSizingMode = "AUTO";
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "fixed-root-fill-child",
      question: "контроль: корень Fixed 380, шапка растянута (форма representFixedHugAsFill)",
      build: function () { return probeAccordion({ name: "fixed-root-fill-child", headerAlign: "INHERIT" }); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.counterAxisSizingMode = "FIXED";
        instance.children[0].layoutAlign = "STRETCH";
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "nested-sizing-fill",
      question: "layoutSizingHorizontal = FILL у вложенной шапки при корне 380",
      build: function () { return probeAccordion({ name: "nested-sizing-fill", headerAlign: "INHERIT" }); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.children[0].layoutSizingHorizontal = "FILL";
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "nested-text-characters-hug",
      question: "длинный текст во вложенном тексте с WIDTH_AND_HEIGHT: растёт ли ширина",
      build: function () { return probeTextComponent("WIDTH_AND_HEIGHT"); },
      act: function (instance) { instance.children[0].characters = "A considerably longer replacement label"; },
      read: probeReadText,
      // Относительно мастера, а не в пикселях: абсолютная ширина зависит от
      // метрик шрифта, а вопрос опыта — растёт ли текст вообще.
      expectRatio: { textWidth: 2 },
    },
    {
      id: "nested-text-fixed-width-resize",
      question: "resize() вложенного текста с HEIGHT (80 → 300)",
      build: function () { return probeTextComponent("HEIGHT"); },
      act: function (instance) { var t = instance.children[0]; t.resize(300, t.height); },
      read: probeReadText,
      expect: { textWidth: 300 },
    },
    // --- Вторая партия (probe v3) ------------------------------------------
    {
      id: "main-axis-hug-over-grow",
      question: "корень Hug по главной оси над единственным растягиваемым (layoutGrow) слоем",
      build: function () { return probeRow("main-axis-hug"); },
      act: function (instance) { instance.primaryAxisSizingMode = "AUTO"; },
      read: probeReadRow,
      expect: { rootWidth: 600, bodyWidth: 600 },
    },
    {
      id: "hug-over-stretch-content-grows",
      question: "корень Hug над растянутой шапкой: текст в шапке стал длиннее 380 — растёт ли корень",
      build: function () { return probeTextAccordion("hug-content"); },
      act: function (instance) {
        instance.resize(380, instance.height);
        instance.counterAxisSizingMode = "AUTO";
        instance.children[0].children[2].characters =
          "A much longer header label that clearly does not fit into three hundred eighty pixels";
      },
      read: probeReadTextAccordion,
      expect: { rootWidth: 380, headerWidth: 380 },
    },
    {
      id: "set-properties-keeps-fill",
      question: "вложенная шапка FILL при корне 380, затем setProperties (BOOLEAN): Fill сохраняется",
      build: function () {
        var component = probeAccordion({ name: "props-keep-fill", headerAlign: "INHERIT" });
        var property = component.addComponentProperty("Badge", "BOOLEAN", true);
        component.children[0].children[1].componentPropertyReferences = { visible: property };
        return { component: component, property: property };
      },
      act: function (instance, built) {
        instance.resize(380, instance.height);
        instance.children[0].layoutSizingHorizontal = "FILL";
        var values = {};
        values[built.property] = false;
        instance.setProperties(values);
      },
      read: probeReadAccordion,
      expect: { rootWidth: 380, headerWidth: 380, headerAlign: "STRETCH" },
    },
    {
      id: "swap-keeps-fill",
      question: "вложенный инстанс растянут (STRETCH), затем swapComponent на другой лист: растяжение сохраняется",
      build: function () { return probeSlotComponent("swap-fill"); },
      act: function (instance, built) {
        instance.resize(380, instance.height);
        var slot = instance.children[0];
        slot.layoutAlign = "STRETCH";
        slot.swapComponent(built.swapTarget);
      },
      read: probeReadSlot,
      expect: { rootWidth: 380, slotWidth: 380, slotAlign: "STRETCH" },
    },
    {
      id: "nested-text-autoresize-change",
      question: "вложенный текст HEIGHT (80) → textAutoResize = WIDTH_AND_HEIGHT",
      build: function () { return probeTextComponent("HEIGHT"); },
      act: function (instance) { instance.children[0].textAutoResize = "WIDTH_AND_HEIGHT"; },
      read: probeReadText,
      expect: { textAutoResize: "WIDTH_AND_HEIGHT" },
    },
    {
      id: "second-level-nested-fill",
      question: "второй уровень: вложенный инстанс и его шапка растянуты при корне 380",
      build: function () { return probeOuterComponent("second-level"); },
      act: function (instance) {
        instance.resize(380, instance.height);
        var nested = instance.children[0];
        nested.layoutAlign = "STRETCH";
        nested.children[0].layoutAlign = "STRETCH";
      },
      read: probeReadOuter,
      expect: { rootWidth: 380, innerWidth: 380, headerWidth: 380, headerAlign: "STRETCH" },
    },
    // --- Третья партия (probe v5): вопросы старых тестов --------------------
    {
      id: "hug-over-hidden-only",
      question: "корень 44×44 без видимых детей переключён в Hug: держит ли размер или схлопывается в padding",
      build: function () { return probeHiddenOnly("hug-hidden-only"); },
      act: function (instance) {
        instance.primaryAxisSizingMode = "AUTO";
        instance.counterAxisSizingMode = "AUTO";
      },
      read: probeReadBox,
      expect: { rootWidth: 44, rootHeight: 44, rootPrimary: "AUTO", rootCounter: "AUTO" },
    },
    {
      id: "hug-over-no-children",
      question: "корень 44×44 совсем без детей переключён в Hug: держит ли размер или схлопывается в padding",
      build: function () { return probeChildless("hug-no-children"); },
      act: function (instance) {
        instance.primaryAxisSizingMode = "AUTO";
        instance.counterAxisSizingMode = "AUTO";
      },
      read: probeReadBox,
      expect: { rootWidth: 44, rootHeight: 44, rootPrimary: "AUTO", rootCounter: "AUTO" },
    },
    // --- Четвёртая партия (probe v7): цикл Hug + Fill у построенных узлов --
    // Действие — пустое: вопрос о состоянии, в котором узел собран. Мастер
    // собран в порядке приёмника, чтения на инстансе, копии и после пересчёта
    // показывают, устойчиво ли это состояние.
    {
      id: "built-hug-counter-over-stretch",
      question: "собран как в приёмнике: Hug по контр-оси 200×48, оба ребёнка растянуты — держит ли 48 без FIXED у детей",
      build: function () { return probeCycleCross("built-cycle-cross"); },
      act: function () {},
      read: probeReadCycle,
      expect: { rootHeight: 48, rootCounter: "AUTO", firstHeight: 48, firstWidth: 120, secondHeight: 48 },
    },
    // --- probe v13: смешанный цикл — растянут не каждый ребёнок -------------
    {
      id: "built-hug-counter-over-stretch-mixed",
      question: "собран как в приёмнике: вертикальный Hug, широкий ребёнок 380 растянут, узкий 105 нет — держит ли 380",
      build: function () { return probeCycleCrossMixed("built-cycle-cross-mixed", true); },
      act: function () {},
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 105 },
    },
    {
      id: "built-hug-counter-over-stretch-mixed-inherit",
      question: "как built-hug-counter-over-stretch-mixed, но широкий ребёнок не растянут: держит ли 380 (форма перевода)",
      build: function () { return probeCycleCrossMixed("built-cycle-cross-mixed-inherit", false); },
      act: function () {},
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 105 },
    },
    {
      id: "built-hug-counter-over-stretch-mixed-relayout",
      question: "как built-hug-counter-over-stretch-mixed, затем пересчёт раскладки (узкий ребёнок скрыт и показан): держит ли 380",
      build: function () { return probeCycleCrossMixed("built-cycle-cross-mixed-relayout", true); },
      act: probeToggleSecondChild,
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 105 },
    },
    {
      id: "built-hug-counter-over-stretch-mixed-inherit-relayout",
      question: "как built-hug-counter-over-stretch-mixed-inherit, затем тот же пересчёт: держит ли 380 (форма перевода)",
      build: function () { return probeCycleCrossMixed("built-cycle-cross-mixed-inherit-relayout", false); },
      act: probeToggleSecondChild,
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 105 },
    },
    // --- probe v14: растянуты все, но у детей есть своё содержимое ----------
    {
      id: "built-hug-counter-over-stretch-content",
      question: "вертикальный Hug, оба ребёнка — auto layout 380 с содержимым 170/120, оба растянуты — держит ли 380",
      build: function () { return probeCycleCrossContent("built-cycle-cross-content", true); },
      act: function () {},
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 380 },
    },
    {
      id: "built-hug-counter-over-stretch-content-relayout",
      question: "как built-hug-counter-over-stretch-content, затем пересчёт раскладки (второй ребёнок скрыт и показан): держит ли 380",
      build: function () { return probeCycleCrossContent("built-cycle-cross-content-relayout", true); },
      act: probeToggleSecondChild,
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 380 },
    },
    {
      id: "built-hug-counter-over-stretch-content-inherit-relayout",
      question: "как built-hug-counter-over-stretch-content-relayout, но дети не растянуты, ширина FIXED 380: держит ли 380 (форма перевода)",
      build: function () { return probeCycleCrossContent("built-cycle-cross-content-inherit-relayout", false); },
      act: probeToggleSecondChild,
      read: probeReadCycle,
      expect: { rootWidth: 380, rootCounter: "AUTO", firstWidth: 380, secondWidth: 380 },
    },
    {
      id: "built-hug-main-over-grow-mixed",
      question: "собран как в приёмнике: Hug по главной оси, ребёнок 300 растёт, 60 фиксирован — держит ли 360",
      build: function () { return probeCycleMainMixed("built-cycle-main-mixed"); },
      act: function () {},
      read: probeReadCycle,
      expect: { rootWidth: 360, rootPrimary: "AUTO", firstWidth: 300, secondWidth: 60 },
    },
    {
      id: "built-hug-counter-over-stretch-text",
      question: "как built-hug-counter-over-stretch, но растянут текст с HEIGHT: держит ли 48 и режим текста",
      build: function () { return probeCycleCrossText("built-cycle-cross-text"); },
      act: function () {},
      read: probeReadCycleText,
      expect: { rootCounter: "AUTO", firstWidth: 120, firstHeight: 48, textAutoResize: "HEIGHT" },
    },
    {
      id: "stroke-hug-default",
      question: "Hug-контейнер с обводкой 1 px, strokesIncludedInLayout не задан: обводка не входит в размер (100×36)",
      build: function () { return probeStrokedHug("stroke-hug-default"); },
      act: function () {},
      read: probeReadStroked,
      expect: { rootWidth: 100, rootHeight: 36 },
    },
    {
      id: "text-single-space-width",
      question: "текст из одного пробела с WIDTH_AND_HEIGHT (Inter 12): ширина больше нуля, как в Pixso (4)",
      build: function () { return probeAutoText("text-space", " "); },
      act: function () {},
      read: probeReadAutoText,
      expect: { textWidthPositive: true },
    },
    {
      id: "text-trailing-space-width",
      question: "к тексту «Ab» с WIDTH_AND_HEIGHT добавлен пробел в конце: ширина растёт",
      build: function () { return probeAutoText("text-trailing-space", "Ab"); },
      act: function (instance) { instance.children[0].characters = "Ab "; },
      read: probeReadAutoText,
      expect: { characters: JSON.stringify("Ab ") },
      expectRatio: { textWidth: 1.01 },
    },
    {
      id: "text-nbsp-width",
      question: "текст из неразрывного пробела (U+00A0) с WIDTH_AND_HEIGHT: ширина больше нуля",
      build: function () { return probeAutoText("text-nbsp", "\u00a0"); },
      act: function () {},
      read: probeReadAutoText,
      expect: { textWidthPositive: true },
    },
    {
      id: "nested-swap-width",
      question: "вложенный инстанс 100×20 подменён на лист 140×20 без растягивания: ширина 140",
      build: function () { return probeSlotComponent("swap-width"); },
      act: function (instance, built) { instance.children[0].swapComponent(built.swapTarget); },
      read: probeReadSlot,
      expect: { slotWidth: 140 },
    },
    {
      id: "built-hug-main-over-grow",
      question: "собран как в приёмнике: Hug по главной оси 160×40, оба ребёнка растут — держит ли 160 без FIXED у детей",
      build: function () { return probeCycleMain("built-cycle-main"); },
      act: function () {},
      read: probeReadCycle,
      expect: { rootWidth: 160, rootPrimary: "AUTO", firstWidth: 80, secondWidth: 80 },
    },
    {
      id: "text-layout-sizing-hug",
      question: "текст WIDTH_AND_HEIGHT в вертикальном auto layout, затем ENDING + maxLines 1: layoutSizingHorizontal читается как HUG",
      build: function () { return probeColumnText("text-sizing"); },
      act: function (instance) {
        var text = instance.children[0];
        text.textTruncation = "ENDING";
        text.maxLines = 1;
      },
      read: probeReadTextSizing,
      expect: { textAutoResize: "WIDTH_AND_HEIGHT", textSizingH: "HUG", textTruncation: "ENDING" },
    },
  ];

  PROBE_OVERRIDE_CASES.forEach(function (item) {
    PROBE_EXPERIMENTS.push(probeOverrideExperiment(item[0], item[1], false, item[2], item[3]));
    PROBE_EXPERIMENTS.push(probeOverrideExperiment(item[0], item[1], true, item[2], item[3]));
  });

  function probeMatches(experiment, values, master) {
    if (!values) return false;
    var ok = true;
    Object.keys(experiment.expect || {}).forEach(function (key) {
      var wanted = experiment.expect[key];
      if (typeof wanted === "number") {
        if (typeof values[key] !== "number" || Math.abs(values[key] - wanted) > PROBE_TOLERANCE) ok = false;
      } else if (values[key] !== wanted) {
        ok = false;
      }
    });
    Object.keys(experiment.expectRatio || {}).forEach(function (key) {
      var base = master && master[key];
      if (typeof values[key] !== "number" || typeof base !== "number" ||
          !(values[key] > base * experiment.expectRatio[key])) ok = false;
    });
    return ok;
  }

  /**
   * Вердикт по четырём чтениям:
   *   PERSISTED          — действие видно во всех чтениях;
   *   IGNORED            — не видно ни в одном;
   *   LOST_ON_RECOMPUTE  — видно сразу, но копия или пересчёт его теряют;
   *   DEFERRED           — сразу не видно, позже видно;
   *   MIXED              — прочие сочетания.
   */
  function probeVerdict(experiment, reads, master) {
    // Недоступное чтение (у хоста нет API) в вердикт не входит, а не считается
    // провалом: иначе отсутствие clone() выглядело бы как «правка потеряна».
    function check(read) { return read && read.unavailable ? null : probeMatches(experiment, read, master); }
    var immediate = check(reads.immediate);
    var tick = check(reads.afterTick);
    var later = [check(reads.clone), check(reads.recompute)].filter(function (v) { return v !== null; });
    var laterAll = later.every(function (v) { return v; });
    var laterNone = later.every(function (v) { return !v; });
    if (immediate && tick && laterAll) return "PERSISTED";
    if (!immediate && !tick && laterNone) return "IGNORED";
    if (immediate && !laterAll) return "LOST_ON_RECOMPUTE";
    if (!immediate && later.length && laterAll) return "DEFERRED";
    return "MIXED";
  }

  async function probeRunExperiment(experiment, page, index) {
    var record = { id: experiment.id, question: experiment.question,
      expect: experiment.expect || null, expectRatio: experiment.expectRatio || null };
    var component = null, instance = null, clone = null;
    try {
      var built = await experiment.build();
      if (built && built.component) {
        component = built.component;
      } else {
        component = built;
        built = { component: component };
      }
      page.appendChild(component);
      component.x = 0;
      component.y = index * 160;
      (built.leaves || []).forEach(function (leaf, leafIndex) {
        page.appendChild(leaf);
        leaf.x = -800 + leafIndex * 200;
        leaf.y = index * 160;
      });
      instance = component.createInstance();
      page.appendChild(instance);
      instance.name = experiment.id;
      instance.x = 700;
      instance.y = index * 160;
      record.master = experiment.read(component);
      record.before = experiment.read(instance);

      var reads = {};
      await experiment.act(instance, built);
      reads.immediate = experiment.read(instance);
      await probeWait(60);
      reads.afterTick = experiment.read(instance);

      if (typeof instance.clone === "function") {
        clone = instance.clone();
        page.appendChild(clone);
        clone.x = 1400;
        clone.y = index * 160;
        clone.name = experiment.id + " (clone)";
        reads.clone = experiment.read(clone);
      } else {
        reads.clone = { unavailable: true };
      }

      var spacing = component.itemSpacing;
      component.itemSpacing = spacing + 1;
      await probeWait(30);
      component.itemSpacing = spacing;
      await probeWait(60);
      reads.recompute = experiment.read(instance);

      record.reads = reads;
      record.verdict = probeVerdict(experiment, reads, record.master);
      if (typeof experiment.cleanup === "function") {
        try { experiment.cleanup(built); } catch (_eCleanup) {}
      }
    } catch (error) {
      record.verdict = "ERROR";
      record.error = String(error && error.message || error).slice(0, 300);
    }
    return record;
  }

  async function runFigmaProbe(payload) {
    var startedAt = Date.now();
    var previousPage = null;
    try { previousPage = figma.currentPage; } catch (_eCurrent) { previousPage = null; }

    // Прошлая страница опытов — наша по plugin data, её можно удалить целиком.
    // Текущую страницу Figma удалить не даёт: сначала уходим с неё на любую
    // другую, ПОСЛЕ создания новой страницы опытов (она и будет «другой»).
    var stale = [];
    var pages = [];
    try { pages = figma.root.children || []; } catch (_eRoot) { pages = []; }
    for (var p = 0; p < pages.length; p++) {
      if (isPageAlive(pages[p]) && servicePageRole(pages[p]) === PROBE_PAGE_ROLE) stale.push(pages[p]);
    }
    if (stale.indexOf(previousPage) >= 0) previousPage = null;
    var page = figma.createPage();
    page.name = PROBE_PAGE_NAME;
    setPluginData(page, "pixso2figmaRole", PROBE_PAGE_ROLE);
    setPluginData(page, "pixso2figmaVersion", RECEIVER_VERSION);
    await ensurePageLoaded(page);
    await switchToPage(page);
    for (var sp = 0; sp < stale.length; sp++) {
      try { stale[sp].remove(); } catch (_eRemove) {}
    }

    var wanted = payload && Array.isArray(payload.experiments) && payload.experiments.length
      ? payload.experiments : null;
    var results = [];
    for (var i = 0; i < PROBE_EXPERIMENTS.length; i++) {
      var experiment = PROBE_EXPERIMENTS[i];
      if (wanted && wanted.indexOf(experiment.id) < 0) continue;
      setReceiverPhase("probe.experiment", { experiment: experiment.id, index: i, total: PROBE_EXPERIMENTS.length });
      results.push(await probeRunExperiment(experiment, page, results.length));
    }

    if (previousPage && isPageAlive(previousPage)) {
      try { await switchToPage(previousPage); } catch (_eBack) {}
    }
    var verdicts = {};
    results.forEach(function (item) { verdicts[item.verdict] = (verdicts[item.verdict] || 0) + 1; });
    return {
      ok: true,
      probeVersion: PROBE_VERSION,
      receiverVersion: RECEIVER_VERSION,
      editorType: typeof figma.editorType === "string" ? figma.editorType : null,
      apiVersion: typeof figma.apiVersion === "string" ? figma.apiVersion : null,
      elapsedMs: Date.now() - startedAt,
      verdicts: verdicts,
      experiments: results,
    };
  }

  /**
   * Диспетчер задач Direct PIX. Отдельная функция и отдельная сессия: ни одно
   * состояние Fast/Full здесь не читается и не пишется.
   */
  async function handleDirectTask(task, options) {
    var type = String(task.type || "");
    var payload = task.payload || {};
    // Между задачами плагин простаивает: начинать новую с уже потраченным
    // бюджетом значит уступить поток на первой же итерации впустую.
    if (directSession && directSession.slice) directSession.slice.startedAt = Date.now();
    setReceiverPhase("direct.task", {
      taskType: type,
      taskId: task.taskId || null,
      sequence: task.sequence === undefined ? null : task.sequence,
      page: payload.pageName || null,
      root: payload.rootName || null,
    });

    // Лаборатория не зависит от job-сессии миграции и её не создаёт.
    if (type === DIRECT_TASK_PREFIX + "PROBE") {
      directValidate(payload);
      return runFigmaProbe(payload);
    }

    if (type === DIRECT_TASK_PREFIX + "START") {
      directValidate(payload);
      directSession = newDirectSession(task.jobId, payload.source, {
        debugOverrides: !!payload.debugOverrides,
        traceTextOverrides: !!payload.traceTextOverrides,
        textOverrideTraceLimit: payload.textOverrideTraceLimit,
        fullDocument: !!payload.fullDocument || !!(payload.plan && payload.plan.fullDocument),
        sizeTraceIds: payload.sizeTraceIds,
        sizeTraceLimit: payload.sizeTraceLimit,
        // D52. Бюджет трассы стадий приходит от отправителя. По умолчанию он
        // остаётся прежним (240), но при `--debug-overrides` его можно поднять:
        // на реальном файле 9302 записи из 9542 отбрасывались, и именно та,
        // ради которой трассу открывали, в выборку не попадала.
        stageTraceLimit: payload.stageTraceLimit,
        variantCombine: payload.variantCombine !== false,
      });
      directSession.startedAt = Date.now();
      return {
        ok: true,
        sourceMode: "DIRECT_PIX",
        protocol: DIRECT_PROTOCOL,
        directVersion: DIRECT_PROTOCOL_VERSION,
        receiverVersion: RECEIVER_VERSION,
        // Отпечаток ЗАГРУЖЕННОГО файла приёмника. `receiverVersion` —
        // константа и на вопрос «какой код сейчас в Figma» не отвечает:
        // после правки Main.js она та же самая. Здесь же перечислено то,
        // что в этой сборке физически есть.
        receiverBuild: directBuildFingerprint(),
        sizeTraceIds: directSession.sizeTrace
          ? Object.keys(directSession.sizeTrace.ids) : null,
      };
    }

    if (!directSession || directSession.jobId !== task.jobId) {
      // Приёмник подключился после старта Direct-задачи. Своей сессии у него
      // нет, а брать чужую нельзя: продолжаем с чистой.
      directSession = newDirectSession(task.jobId, payload.source, {
        debugOverrides: !!payload.debugOverrides,
        traceTextOverrides: !!payload.traceTextOverrides,
        textOverrideTraceLimit: payload.textOverrideTraceLimit,
        fullDocument: !!payload.fullDocument,
      });
      directSession.startedAt = Date.now();
    }
    if (directSession.processedTasks[task.taskId]) return directSession.processedTasks[task.taskId];
    directValidate(payload);

    var session = directSession;
    var result;

    // Каждая задача отчитывается ПРИРОСТОМ своих счётчиков, а не накопленным
    // итогом: продюсер складывает ответы, и накопительное значение он бы
    // сложил само с собой.
    var unsupportedBefore = session.totals.unsupported;
    var sizeTraceBefore = session.sizeTrace ? session.sizeTrace.records.length : 0;

    if (type === DIRECT_TASK_PREFIX + "ASSETS") {
      var assetsBefore = session.totals.assetsCreated;
      var downsampledBefore = session.totals.assetsDownsampled;
      var assetMsBefore = session.timings.assetMs;
      await directRegisterAssets(payload.assets || [], session);
      result = {
        ok: true,
        assetsCreated: session.totals.assetsCreated - assetsBefore,
        assetsDownsampled: session.totals.assetsDownsampled - downsampledBefore,
        assetMs: session.timings.assetMs - assetMsBefore,
        unsupported: session.totals.unsupported - unsupportedBefore,
      };
    } else if (type === DIRECT_TASK_PREFIX + "STYLES") {
      var paintBefore = session.totals.paintStylesCreated;
      var textStylesBefore = session.totals.textStylesCreated;
      var effectStylesBefore = session.totals.effectStylesCreated;
      var stylesReusedBefore = session.totals.paintStylesReused +
        session.totals.textStylesReused + session.totals.effectStylesReused;
      var styleMsBefore = session.timings.styleBuildMs;
      await directBuildStyles(payload.styles || [], session);
      result = {
        ok: true,
        paintStylesCreated: session.totals.paintStylesCreated - paintBefore,
        textStylesCreated: session.totals.textStylesCreated - textStylesBefore,
        effectStylesCreated: session.totals.effectStylesCreated - effectStylesBefore,
        stylesReused: (session.totals.paintStylesReused + session.totals.textStylesReused +
          session.totals.effectStylesReused) - stylesReusedBefore,
        styleBuildMs: session.timings.styleBuildMs - styleMsBefore,
        unsupported: session.totals.unsupported - unsupportedBefore,
      };
    } else if (type === DIRECT_TASK_PREFIX + "DEFINITIONS") {
      var createdBefore = session.totals.definitionsCreated;
      var reusedBefore = session.totals.definitionsReused;
      var definitionNodesBefore = session.totals.definitionNodes;
      var definitionMsBefore = session.timings.definitionBuildMs;
      var delivery = await directBuildDefinitions(payload.definitions || [], session);
      result = {
        ok: true,
        definitionsCreated: session.totals.definitionsCreated - createdBefore,
        definitionsReused: session.totals.definitionsReused - reusedBefore,
        definitionNodes: session.totals.definitionNodes - definitionNodesBefore,
        definitionBuildMs: session.timings.definitionBuildMs - definitionMsBefore,
        // Подтверждение доставки. `ready` — определения, ПРИГОДНЫЕ к
        // созданию вхождений прямо сейчас; `failed` — те, которые обязаны
        // приехать снова. Отказ одного определения по-прежнему не роняет
        // job: ответ остаётся `ok`.
        ready: delivery.ready,
        failed: delivery.failed,
        unsupported: session.totals.unsupported - unsupportedBefore,
      };
    } else if (type === DIRECT_TASK_PREFIX + "PAGE") {
      var pageKey = String(payload.pageId || payload.pageName || "Pixso Direct");
      var pageWasKnown = isPageAlive(session.pages[pageKey]);
      var directPage = await directEnsurePage(payload.pageName, payload.pageId, session, options);
      if (!pageWasKnown) session.totals.pages += 1;
      result = {
        ok: true,
        pageId: payload.pageId || null,
        page: directPage.name,
        created: !pageWasKnown,
        unsupported: session.totals.unsupported - unsupportedBefore,
      };
    } else if (type === DIRECT_TASK_PREFIX + "ROOT") {
      var rootStartedAt = Date.now();
      var page = await directEnsurePage(payload.pageName, payload.pageId, session, options);
      var ordinaryBefore = session.totals.ordinaryNodesCreated;
      var instancesBefore = session.totals.instancesCreated;
      var expectedInstancesBefore = session.totals.expectedInstances;
      var definitionUnavailableBefore = session.totals.instanceDefinitionUnavailable;
      var placeholdersBefore = session.totals.placeholderFramesCreated;
      var appliedBefore = session.totals.overridesApplied;
      var missedBefore = session.totals.overridesMissed;
      var attemptedBefore = session.totals.overridesAttempted;
      var unverifiedBefore = session.totals.overrideStepsUnverified || 0;
      var structurallyVerifiedBefore = session.totals.structuralStepsVerified || 0;
      var safeBefore = session.totals.nativeInstancesVisualSafe || 0;
      var unsafeBefore = session.totals.nativeInstancesUnsafe || 0;
      var textOverflowReassertedBefore = session.totals.textOverflowSemanticsReasserted || 0;
      var missReasonsBefore = Object.assign({}, session.overrideMissReasons);
      var missSamplesBefore = session.overrideMissSamples.length;
      var textTraceBefore = session.textOverrideTraceSamples.length;
      var textCounterKeys = [
        "textOverridesSeen", "textOverridesApplied", "textOverridesNoOp",
        "textClearsExplicit", "textClearsBlocked", "textVisibilityChanges",
        "textStyleClearsExplicit", "textStyleClearsBlocked",
        "explicitTextChanges", "explicitTextClears", "blockedImplicitTextClears",
        "visibilityChanges", "styleClears", "paintClearsExplicit", "paintClearsBlocked",
        "paintOverridePresent", "paintOverrideApplied", "paintDefaultArrayIgnored",
        "paintClearRefused",
      ];
      var textCountersBefore = {};
      textCounterKeys.forEach(function (key) { textCountersBefore[key] = session.totals[key] || 0; });
      var styleBindingKeys = [
        "fillStyleBindings", "strokeStyleBindings", "effectStyleBindings",
        "textStyleBindings", "styleBindingsFailed", "styleBindingsMissingStyle",
      ];
      var styleBindingsBefore = {};
      styleBindingKeys.forEach(function (key) { styleBindingsBefore[key] = session.totals[key] || 0; });
      var ordinaryMsBefore = session.timings.ordinaryBuildMs;
      var instanceMsBefore = session.timings.instanceCreateMs;
      var overrideMsBefore = session.timings.overrideApplyMs;

      var incomingProvenance = payload.deepOverrideProvenanceSamples || [];
      for (var dp = 0; dp < incomingProvenance.length &&
        session.deepOverrideProvenanceSamples.length < session.deepOverrideProvenanceLimit; dp++) {
        session.deepOverrideProvenanceSamples.push(incomingProvenance[dp]);
      }
      var incomingSourceAudit = payload.sourceSemanticReport || null;
      if (incomingSourceAudit) {
        session.sourceSemanticReport.nodesAudited += Number(incomingSourceAudit.nodesAudited) || 0;
        session.sourceSemanticReport.overridesAudited += Number(incomingSourceAudit.overridesAudited) || 0;
        Object.keys(incomingSourceAudit.counts || {}).forEach(function (field) {
          session.sourceSemanticReport.counts[field] = (session.sourceSemanticReport.counts[field] || 0) +
            (Number(incomingSourceAudit.counts[field]) || 0);
        });
        var sourceSamples = incomingSourceAudit.samples || [];
        for (var ss = 0; ss < sourceSamples.length && session.sourceSemanticReport.samples.length < session.sourceSemanticReport.sampleLimit; ss++) {
          session.sourceSemanticReport.samples.push(sourceSamples[ss]);
        }
        var propertySamples = incomingSourceAudit.componentPropertySamples || [];
        for (var sp = 0; sp < propertySamples.length && session.sourceSemanticReport.componentPropertySamples.length < session.sourceSemanticReport.componentSampleLimit; sp++) {
          session.sourceSemanticReport.componentPropertySamples.push(propertySamples[sp]);
        }
      }
      await directBuildNodes(payload.nodes || [], session, { parentForRoot: page });
      session.totals.roots += 1;
      if (payload.rootId && session.importedRootIds.indexOf(String(payload.rootId)) < 0) {
        session.importedRootIds.push(String(payload.rootId));
      }
      // Снимок СРАЗУ после сборки корня — до объединения семейств. Вместе со
      // снимком на FINISH он отвечает на вопрос, который счётчики не берут:
      // на каком именно переходе результат разошёлся.
      var rootTreeVerification = payload.verifyTree
        ? await directVerifyTree(session, { storedState: !!payload.verifyStoredState }) : null;

      result = {
        ok: true,
        rootId: payload.rootId || null,
        treeVerification: rootTreeVerification || undefined,
        page: page.name,
        ordinaryNodesCreated: session.totals.ordinaryNodesCreated - ordinaryBefore,
        instancesCreated: session.totals.instancesCreated - instancesBefore,
        expectedInstances: session.totals.expectedInstances - expectedInstancesBefore,
        instanceDefinitionUnavailable:
          session.totals.instanceDefinitionUnavailable - definitionUnavailableBefore,
        placeholderFramesCreated:
          session.totals.placeholderFramesCreated - placeholdersBefore,
        overridesApplied: session.totals.overridesApplied - appliedBefore,
        overridesMissed: session.totals.overridesMissed - missedBefore,
        overridesAttempted: session.totals.overridesAttempted - attemptedBefore,
        overrideStepsUnverified: (session.totals.overrideStepsUnverified || 0) - unverifiedBefore,
        structuralStepsVerified: (session.totals.structuralStepsVerified || 0) - structurallyVerifiedBefore,
        nativeInstancesVisualSafe: (session.totals.nativeInstancesVisualSafe || 0) - safeBefore,
        nativeInstancesUnsafe: (session.totals.nativeInstancesUnsafe || 0) - unsafeBefore,
        textOverflowSemanticsReasserted:
          (session.totals.textOverflowSemanticsReasserted || 0) - textOverflowReassertedBefore,
        overrideMissReasons: Object.keys(session.overrideMissReasons).reduce(function (out, code) {
          var delta = session.overrideMissReasons[code] - (missReasonsBefore[code] || 0);
          if (delta) out[code] = delta;
          return out;
        }, {}),
        // Образцы, собранные именно этим корнем. Выборка ограничена на всю
        // сессию, поэтому дельта пустеет сама и лог не разрастается.
        overrideMissSamples: session.overrideMissSamples.slice(missSamplesBefore),
        textOverrideCounters: textCounterKeys.reduce(function (out, key) {
          out[key] = (session.totals[key] || 0) - textCountersBefore[key];
          return out;
        }, {}),
        textOverrideTraceSamples: session.textOverrideTraceSamples.slice(textTraceBefore),
        styleBindings: styleBindingKeys.reduce(function (out, key) {
          out[key] = (session.totals[key] || 0) - styleBindingsBefore[key];
          return out;
        }, {}),
        ordinaryBuildMs: session.timings.ordinaryBuildMs - ordinaryMsBefore,
        instanceCreateMs: session.timings.instanceCreateMs - instanceMsBefore,
        overrideApplyMs: session.timings.overrideApplyMs - overrideMsBefore,
        importMs: Date.now() - rootStartedAt,
        unsupported: session.totals.unsupported - unsupportedBefore,
        // Диагностика едет ПРИРОСТОМ и в результате КОРНЯ, а не только в
        // FINISH: до FINISH прогон может и не дойти, а мост пишет каждый
        // ответ отдельной записью.
        sizeTrace: session.sizeTrace
          ? session.sizeTrace.records.slice(sizeTraceBefore) : undefined,
        occurrenceStageTrace: session.stageTrace ? {
          summary: session.stageTrace.summary,
          records: session.stageTrace.records.slice(),
          dropped: session.stageTrace.dropped,
          limit: session.stageTrace.limit,
        } : undefined,
      };
    } else if (type === DIRECT_TASK_PREFIX + "FINISH") {
      // Семейства вариантов собираются здесь — когда доехало всё, что
      // доедет. Отказ любой отдельной группы финал не роняет: она остаётся
      // набором самостоятельных компонентов со своими вхождениями.
      // Страховка: семейство, участники которого приехали, но чей чанк
      // почему-то не дошёл до сборки, собирается здесь. На здоровом прогоне
      // собирать уже нечего — все участники вошли в наборы на своём чанке.
      await directCombineVariantGroups(session);
      // Порядок на служебной странице наводится ОДИН раз и здесь: раньше
      // габариты наборов ещё не окончательны, а значит и раскладка по ним
      // была бы раскладкой по промежуточному состоянию.
      var servicePageLayout = directLayoutServicePage(session);
      var variantVerification = await directVerifyVariantSets(session);
      // Полная сверка дерева — только по явному флагу: это тяжёлое чтение,
      // и обычному прогону оно не нужно.
      var treeVerification = payload.verifyTree
        ? await directVerifyTree(session, { storedState: !!payload.verifyStoredState }) : null;
      var definitionVerification = (payload.verifyDefinitionIds && payload.verifyDefinitionIds.length)
        ? await directVerifyDefinitions(session, payload.verifyDefinitionIds) : null;
      markServicePageReady(session.registry, DIRECT_SERVICE_PAGE);
      session.timings.totalImportMs = Date.now() - (session.startedAt || Date.now());
      try {
        if (isPageAlive(session.firstPage)) {
          await ensureCurrentPage(session.firstPage);
          var children = (session.firstPage.children || []).filter(isAlive);
          if (children.length) figma.viewport.scrollAndZoomIntoView(children.slice(0, 50));
        }
      } catch (_eFocus) { /* косметика не может ломать финал */ }
      result = {
        ok: true,
        protocol: DIRECT_PROTOCOL,
        directVersion: DIRECT_PROTOCOL_VERSION,
        totals: session.totals,
        timings: session.timings,
        totalImportMs: session.timings.totalImportMs,
        // Чего стоила отзывчивость интерфейса: число уступок, суммарное
        // ожидание и самый долгий непрерывный кусок работы.
        mainThreadYieldReport: {
          budgetMs: DIRECT_SLICE_MS,
          yields: session.sliceReport.yieldCount,
          yieldWaitMs: session.sliceReport.yieldWaitMs,
          longestBlockingMs: session.sliceReport.maxSliceMs,
          workBetweenYieldsMs: session.sliceReport.sliceTotalMs,
        },
        unsupportedByCode: session.unsupported,
        receiverBuild: directBuildFingerprint(),
        sizeTrace: session.sizeTrace ? session.sizeTrace.records : undefined,
        occurrenceStageTrace: session.stageTrace ? {
          summary: session.stageTrace.summary,
          records: session.stageTrace.records,
          dropped: session.stageTrace.dropped,
          limit: session.stageTrace.limit,
        } : undefined,
        treeVerification: treeVerification || undefined,
        definitionVerification: definitionVerification || undefined,
        servicePageLayout: servicePageLayout || undefined,
        overrideResolutionReport: {
          totalMisses: session.totals.overridesMissed,
          reasons: session.overrideMissReasons,
          samples: session.overrideMissSamples,
          samplesByReason: session.overrideMissPool.perCode || {},
          samplesPerReasonLimit: session.overrideMissPool.perCodeLimit,
        },
        deepOverrideProvenanceReport: {
          samples: session.deepOverrideProvenanceSamples,
          sampleLimit: session.deepOverrideProvenanceLimit,
        },
        sourceSemanticReport: session.sourceSemanticReport,
        variantAliasSamples: session.variantAliasSamples,
        // Сколько копий одного и того же определения привёз исходник и по
        // какой ветке доказательства они схлопнуты. Величина видна на любом
        // файле и отвечает на вопрос «дедупликация вообще сработала».
        definitionDedupReport: {
          aliasedByProof: session.totals.definitionsAliasedByProof,
          samples: session.definitionAliasSamples,
          sampleLimit: session.definitionAliasSampleLimit,
        },
        semanticEffectTrace: session.semanticEffectTrace,
        // Нативные семейства вариантов: сколько семейств приехало, сколько
        // стало COMPONENT_SET и почему остальные остались набором
        // самостоятельных компонентов. Откат здесь не является потерей
        // визуала и в счётчики определений не попадает.
        nativePropertyReport: {
          declared: session.totals.nativePropertiesDeclared,
          created: session.totals.nativePropertiesCreated,
          bindingsApplied: session.totals.nativePropertyBindingsApplied,
          bindingsMissed: session.totals.nativePropertyBindingsMissed,
          valuesApplied: session.totals.nativePropertyValuesApplied,
          valuesMissed: session.totals.nativePropertyValuesMissed,
          valuesVerified: session.totals.nativePropertyValuesVerified,
          valuesUnverified: session.totals.nativePropertyValuesUnverified,
          ownedLowLevelSuppressed: session.totals.nativeOwnedLowLevelSuppressed,
          ownedLowLevelFallback: session.totals.nativeOwnedLowLevelFallback,
          verifiedEffectLowLevelSuppressed: session.totals.nativeEffectLowLevelSuppressed || 0,
          redundantPaintOverridesSuppressed: session.totals.redundantPaintOverridesSuppressed || 0,
          swapChildLayoutRestored: session.totals.nativeSwapChildLayoutRestored,
          rejectedSamples: session.nativePropertyRejectSamples,
          // D54. `targetsReboundByIndex` / `BySchema` / `ByHierarchy` и
          // `targetAmbiguous` удалены вместе с путями, которые их увеличивали.
          // Счётчик, который некому увеличить, — подставленный ноль, а не
          // измеренный, и правилами проекта он запрещён.
          exposedInstancesRequested: session.totals.exposedInstancesRequested,
          exposedInstancesApplied: session.totals.exposedInstancesApplied,
          exposedInstancesVerified: session.totals.exposedInstancesVerified,
          exposedInstancesVerificationMissed: session.totals.exposedInstancesVerificationMissed,
          exposedInstancesRejected: session.totals.exposedInstancesRejected,
          exposedInstanceRejectSamples: session.exposedInstanceRejectSamples,
          exposedInstancesNonPrimarySkipped: session.totals.exposedInstancesNonPrimarySkipped,
        },
        layoutTextParityReport: {
          mismatchesByField: session.layoutTextParity.counts,
          samples: session.layoutTextParity.samples,
          sampleLimit: session.layoutTextParity.limit,
          samplesByField: session.layoutTextParity.perCode,
          textSamples: session.layoutTextParity.textSamples,
          textSampleLimit: session.layoutTextParity.textLimit,
        },
        visualParityReport: {
          mismatchesByField: session.visualParity.counts,
          samples: session.visualParity.samples,
          sampleLimit: session.visualParity.limit,
          samplesByField: session.visualParity.perCode || {},
          samplesPerFieldLimit: session.visualParity.perCodeLimit,
        },
        semanticSizingReport: {
          samples: session.semanticSizingTrace.samples,
          sampleLimit: session.semanticSizingTrace.limit,
        },
        sourceBoxReport: {
          samples: session.sourceBoxTrace ? session.sourceBoxTrace.samples : [],
          sampleLimit: session.sourceBoxTrace ? session.sourceBoxTrace.limit : 80,
        },
        destructiveOverwriteReport: {
          counts: session.destructiveOverwriteReport.counts,
          byStage: session.destructiveOverwriteReport.byStage,
          samples: session.destructiveOverwriteReport.samples,
          sampleLimit: session.destructiveOverwriteReport.limit,
          // Сколько образцов взято по каждому коду: видно, что редкий код
          // не остался без доказательств.
          samplesByReason: session.destructiveOverwriteReport.perCode || {},
          samplesPerReasonLimit: session.destructiveOverwriteReport.perCodeLimit || null,
          visibilitySamples: session.destructiveOverwriteReport.visibilitySamples,
          visibilitySampleLimit: session.destructiveOverwriteReport.visibilityLimit,
        },
        instanceNameReport: session.instanceNameParity,
        finalMainComponentReport: session.finalMainComponentParity,
        componentIdentityLedger: session.componentIdentityLedger,
        reconstructionManifest: {
          families: directReconstructionFamilyManifest(session),
          propertyRoutes: session.reconstructionManifest.propertyRoutes,
          propertyRouteLimit: session.reconstructionManifest.limit,
        },
        variantSetReport: {
          groupsSeen: session.totals.variantGroupsSeen,
          groupsCombined: session.totals.variantGroupsCombined,
          groupsFallback: session.totals.variantGroupsFallback,
          localGroupsMergedByStableFamily: session.totals.variantLocalGroupsMergedByStableFamily || 0,
          localGroupParentAuthority: true,
          logicalFamilies: directLogicalFamilyReport(session),
          membersSeen: session.totals.variantMembersSeen,
          membersCombined: session.totals.variantMembersCombined,
          membersFallback: session.totals.variantMembersFallback,
          membersLostAfterCombine: session.totals.variantMembersLostAfterCombine,
          membersJoinedLate: session.totals.variantMembersJoinedLate,
          membersRejectedAsDuplicate: session.totals.variantMembersRejectedAsDuplicate,
          setsHealthChecked: session.totals.variantSetsHealthChecked,
          setsInErrorState: session.totals.variantSetsInErrorState,
          familyMembersDeferred: session.totals.variantFamilyMembersDeferred,
          lazySingletonFamilies: session.totals.variantLazySingletonFamilies,
          familiesCompleteAtCombine: session.totals.variantFamiliesCompleteAtCombine,
          familiesIncompleteAtCombine: session.totals.variantFamiliesIncompleteAtCombine,
          fallbackByReason: session.variantFallbackByReason,
          fallbackSamples: session.variantFallbackSamples,
          combineMs: session.timings.variantCombineMs,
          // Доказательство, читаемое из документа, а не из счётчика:
          // ограниченная выборка настоящих узлов Figma.
          verification: variantVerification,
        },
        // Жизненный цикл определений: чего ждали, что получилось, почему нет
        // и чем это доказано. Отчёт ограничен по объёму на всю сессию.
        definitionLifetimeReport: {
          expectedInstances: session.totals.expectedInstances,
          instancesCreated: session.totals.instancesCreated,
          ordinaryNodesCreated: session.totals.ordinaryNodesCreated,
          instanceDefinitionUnavailable: session.totals.instanceDefinitionUnavailable,
          placeholderFramesCreated: session.totals.placeholderFramesCreated,
          definitionsCreated: session.totals.definitionsCreated,
          definitionsReused: session.totals.definitionsReused,
          definitionsRegistered: Object.keys(session.definitionRegistry).length,
          unavailableByReason: session.definitionUnavailableByReason,
          unavailableSamples: session.definitionUnavailableSamples,
          trace: session.definitionTrace ? session.definitionTrace.records : [],
          instanceReconciliation: directInstanceReconciliationReport(session),
        },
        textOverrideReport: {
          textOverridesSeen: session.totals.textOverridesSeen,
          textOverridesApplied: session.totals.textOverridesApplied,
          textOverridesNoOp: session.totals.textOverridesNoOp,
          textClearsExplicit: session.totals.textClearsExplicit,
          textClearsBlocked: session.totals.textClearsBlocked,
          textVisibilityChanges: session.totals.textVisibilityChanges,
          textStyleClearsExplicit: session.totals.textStyleClearsExplicit,
          textStyleClearsBlocked: session.totals.textStyleClearsBlocked,
          explicitTextChanges: session.totals.explicitTextChanges,
          explicitTextClears: session.totals.explicitTextClears,
          blockedImplicitTextClears: session.totals.blockedImplicitTextClears,
          visibilityChanges: session.totals.visibilityChanges,
          styleClears: session.totals.styleClears,
          paintClearsExplicit: session.totals.paintClearsExplicit,
          paintClearsBlocked: session.totals.paintClearsBlocked,
          paintOverridePresent: session.totals.paintOverridePresent,
          paintOverrideApplied: session.totals.paintOverrideApplied,
          paintDefaultArrayIgnored: session.totals.paintDefaultArrayIgnored,
          paintClearRefused: session.totals.paintClearRefused,
          overrideMisses: session.totals.overridesMissed,
          samples: session.textOverrideTraceSamples,
        },
        styleReport: {
          paintStylesCreated: session.totals.paintStylesCreated,
          paintStylesReused: session.totals.paintStylesReused,
          textStylesCreated: session.totals.textStylesCreated,
          textStylesReused: session.totals.textStylesReused,
          effectStylesCreated: session.totals.effectStylesCreated,
          effectStylesReused: session.totals.effectStylesReused,
          stylesUnsupported: session.totals.stylesUnsupported,
          styleFontFallbacks: session.totals.styleFontFallbacks,
          fillStyleBindings: session.totals.fillStyleBindings,
          strokeStyleBindings: session.totals.strokeStyleBindings,
          effectStyleBindings: session.totals.effectStyleBindings,
          textStyleBindings: session.totals.textStyleBindings,
          styleBindingsFailed: session.totals.styleBindingsFailed,
          styleBindingsMissingStyle: session.totals.styleBindingsMissingStyle,
          styleBuildMs: session.timings.styleBuildMs,
        },
        visualSafetyReport: {
          considered: session.totals.nativeInstancesConsidered,
          safe: session.totals.nativeInstancesVisualSafe,
          unsafe: session.totals.nativeInstancesUnsafe,
          reasons: session.nativeUnsafeByReason,
          directReasons: session.nativeUnsafeDirectByReason,
          inheritedReasons: session.nativeUnsafeInheritedByReason,
          inheritedByDefinition: Object.keys(session.nativeUnsafeInheritedByDefinition)
            .map(function (definitionId) {
              var bucket = session.nativeUnsafeInheritedByDefinition[definitionId];
              return {
                definitionId: definitionId,
                occurrences: bucket.occurrences,
                reasons: bucket.reasons,
                samples: bucket.samples,
              };
            })
            .sort(function (a, b) { return b.occurrences - a.occurrences; })
            .slice(0, 30),
          samples: session.nativeUnsafeSamples,
          structuralStepsVerified: session.totals.structuralStepsVerified,
          unverifiedSteps: session.totals.overrideStepsUnverified,
        },
      };
    } else {
      // Тип из более новой версии Direct PIX: не роняем job.
      result = { ok: true, skipped: true, type: type };
    }

    session.processedTasks[task.taskId] = result;
    return result;
  }

  function setup() {
    figma.showUI(__html__, { width: 400, height: 460, title: "Pixso2Figma" });
    function sendHello() {
      figma.ui.postMessage({
        type: "receiver-hello",
        receiverVersion: RECEIVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        documentName: (function () { try { return figma.root.name; } catch (_e) { return "Figma"; } })(),
      });
    }
    figma.ui.onmessage = async function (message) {
      if (!message || !message.type) return;

      if (message.type === "image-downsample-result" || message.type === "image-downsample-failed") {
        directResolveImageDownsample(message);
        return;
      }

      if (message.type === "ui-ready") { sendHello(); return; }

      // Ручной импорт: путь без bridge, поведение не изменилось.
      if (message.type === "import-package") {
        try { var report = await importPackage(message.pkg, message.options); figma.ui.postMessage({ type: "import-result", report: report }); figma.notify("Pixso screen import готов"); }
        catch (error) { figma.ui.postMessage({ type: "import-error", message: error && error.message || String(error) }); }
        return;
      }

      // Receiver: chunk из bridge проходит через тот же importPackage.
      if (message.type === "receiver-task") {
        try {
          var result = await handleReceiverTask(message.task, message.options || {});
          // Единственная точка, где результат покидает плагин. Отчёт о работе
          // не имеет права уронить саму работу: то, что не переживёт
          // structured clone, заменяется меткой, а не роняет задачу.
          var plain = directPlainValue(result);
          if (plain.stripped.length) {
            plain.value = plain.value && typeof plain.value === "object" ? plain.value : {};
            plain.value.unserializableFields = plain.stripped;
          }
          figma.ui.postMessage({ type: "receiver-task-done", taskId: message.task.taskId, result: plain.value });
          if (message.task.type === "FINISH_JOB") figma.notify("Pixso migration завершена");
        } catch (error) {
          // Ошибку нельзя проглатывать: без фазы и стека «лог обрывается»
          // невозможно диагностировать вообще.
          figma.ui.postMessage({
            type: "receiver-task-failed",
            taskId: message.task && message.task.taskId,
            code: "IMPORT_FAILED",
            message: error && error.message || String(error),
            errorName: (error && error.name) || "Error",
            stack: (error && error.stack) ? String(error.stack).slice(0, 2000) : null,
            phase: {
              taskType: receiverPhase.taskType,
              taskId: receiverPhase.taskId,
              sequence: receiverPhase.sequence,
              page: receiverPhase.page,
              root: receiverPhase.root,
              stage: receiverPhase.stage,
              createdBeforeFailure: receiverPhase.created,
            },
          });
        }
        return;
      }

      if (message.type === "receiver-reset") { session = null; directSession = null; return; }
    };
  }
  if (typeof figma !== "undefined") setup();
  if (typeof module !== "undefined") module.exports = { directPlainValue: directPlainValue, directAdmitSample: directAdmitSample, directParityMismatch: directParityMismatch, MIGRATION_MODE: MIGRATION_MODE, DEFAULT_MIGRATION_MODE: DEFAULT_MIGRATION_MODE, normalizeMigrationMode: normalizeMigrationMode, importPackage: importPackage, handleReceiverTask: handleReceiverTask, handleDirectTask: handleDirectTask, isDirectTask: isDirectTask, directLayoutServicePage: directLayoutServicePage, directLayoutVariantSet: directLayoutVariantSet, directVariantGridCells: directVariantGridCells, newDirectSession: newDirectSession, runFigmaProbe: runFigmaProbe, PROBE_EXPERIMENTS: PROBE_EXPERIMENTS, DIRECT_PROTOCOL: DIRECT_PROTOCOL, DIRECT_PROTOCOL_VERSION: DIRECT_PROTOCOL_VERSION, DIRECT_SERVICE_PAGE: DIRECT_SERVICE_PAGE, validate: validate, importDefinitions: importDefinitions, DEFINITION_UNAVAILABLE: DEFINITION_UNAVAILABLE, directDefinitionState: directDefinitionState, applyPropertyStage: applyPropertyStage, resolvePropertyBinding: resolvePropertyBinding, propertyValue: propertyValue, MISS: MISS, findServicePage: findServicePage, ensureServicePage: ensureServicePage, markServicePageReady: markServicePageReady, SERVICE_PAGE_ROLE: SERVICE_PAGE_ROLE, SERVICE_PAGE_NAME: SERVICE_PAGE_NAME, FAST_SERVICE_PAGE_ROLE: FAST_SERVICE_PAGE_ROLE, FAST_SERVICE_PAGE_NAME: FAST_SERVICE_PAGE_NAME, SERVICE_PAGES: SERVICE_PAGES, promoteSnapshotsToComponents: promoteSnapshotsToComponents, promoteFastSnapshotsToComponents: promoteFastSnapshotsToComponents, variantSetKey: variantSetKey, collectSemanticGroups: collectSemanticGroups, yieldIfNeeded: yieldIfNeeded, createSlice: createSlice, applyInstanceProperties: applyInstanceProperties, isStyleAlive: isStyleAlive, readComponentPropertyDefinitions: readComponentPropertyDefinitions, getComponentPropertyDefinitions: getComponentPropertyDefinitions, propertyDefinitionOwner: propertyDefinitionOwner, newReport: newReport, findByIndexPath: findByIndexPath, directStructuralSubtreeSignature: directStructuralSubtreeSignature, directFindVerifiedSwapRelocation: directFindVerifiedSwapRelocation, directInstanceSwapPropertyDefinition: directInstanceSwapPropertyDefinition, directDefinitionIdFromFigmaComponentId: directDefinitionIdFromFigmaComponentId, directAuditVisualNode: directAuditVisualNode, directApplyStrokeWeights: directApplyStrokeWeights, resolvePropertyName: resolvePropertyName, applyFastInstance: applyFastInstance, bytesFromBase64: bytesFromBase64, directResolveImageDownsample: directResolveImageDownsample, collectRequiredComponents: collectRequiredComponents, rootOffset: rootOffset, hasResolvedScreenInstances: hasResolvedScreenInstances, screenNeedsComponentDefinitions: screenNeedsComponentDefinitions, semanticSignature: semanticSignature, variantComponentName: variantComponentName, applyFigmaChildSizing: applyFigmaChildSizing, applyChildConstraints: applyChildConstraints, sanitizeChildLayout: sanitizeChildLayout, isStrokeVectorFallback: isStrokeVectorFallback, isSvgRootNode: isSvgRootNode, applyCommon: applyCommon, isAlive: isAlive, isPageAlive: isPageAlive, loadFontCached: loadFontCached, ensurePageLoaded: ensurePageLoaded, ensureCurrentPage: ensureCurrentPage, newSession: newSession, RECEIVER_VERSION: RECEIVER_VERSION, PROTOCOL_VERSION: PROTOCOL_VERSION };
})();
