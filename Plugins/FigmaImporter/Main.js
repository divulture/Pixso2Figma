/* Pixso → Figma Importer. Deliberately dependency-free for Figma dev-plugin use. */
(function () {
  "use strict";
  var FORMAT = "pixso-portable-package";

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

  function setValue(node, key, value) { try { if (value !== undefined) node[key] = value; } catch (_e) {} }
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
  function attachInstanceMetadata(node, src, state, isSnapshot) {
    if (!src || src.type !== "INSTANCE") return;
    var instance = state.pkg.instances && state.pkg.instances[src.id];
    var preset = instance && instance.preset;
    if (!preset) return;
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
  async function createLocalStyles(state) {
    var entries = state.pkg.styles || {};
    var ids = Object.keys(entries);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], source = entries[id], style = null;
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
            try { await figma.loadFontAsync(textProps.fontName); style.fontName = textProps.fontName; }
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
      try { await figma.loadFontAsync(data.fontName); node.fontName = data.fontName; }
      catch (_e) { warn(report, "Шрифт недоступен: " + data.fontName.family + " — оставлен шрифт Figma"); }
    }
    ["fontSize", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textTruncation", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent", "letterSpacing", "lineHeight", "maxLines"].forEach(function (key) { setValue(node, key, data[key]); });
    node.characters = data.characters || "";
    applyPaints(node, "fills", data.fills, images, report);
    if (data.segments && data.segments.length) {
      for (var i = 0; i < data.segments.length; i++) {
        var s = data.segments[i];
        if (s.fontName) { try { await figma.loadFontAsync(s.fontName); node.setRangeFontName(s.start, s.end, s.fontName); } catch (_e) {} }
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
  async function buildTree(id, parent, state, mode, positionOffset) {
    var src = state.pkg.nodes[id];
    if (!src) { warn(state.report, "Не найден узел " + id); return null; }
    var node;
    // Развёрнутый instance из экранного экспорта — источник истины для
    // визуального переноса. Не заменяем его definition-компонентом: в таком
    // случае теряются overrides и Figma собирает дефолтный вариант.
    var resolvedScreenInstance = src.type === "INSTANCE" && mode === "screen" && src.children && src.children.length;
    if (resolvedScreenInstance) {
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
    attachInstanceMetadata(node, src, state, !!resolvedScreenInstance);
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
    if (mode === "screen" && state.report.created % 250 === 0) {
      try { figma.ui.postMessage({ type: "import-progress", created: state.report.created }); } catch (_eProgress) {}
    }
    if (src.type === "INSTANCE" && state.pkg.instances[id] && !resolvedScreenInstance) await applyInstancePreset(node, state.pkg.instances[id].preset, state);
    if (src.children && src.children.length && canHaveChildren(node)) {
      for (var i = 0; i < src.children.length; i++) await buildTree(src.children[i], node, state, mode, null);
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
  function semanticSignature(preset) {
    if (!preset || (!preset.definitionName && !preset.definitionSetName)) return "";
    return JSON.stringify({
      set: preset.definitionSetName || "",
      component: preset.definitionName || "",
      variants: sortedObject(preset.variantProperties || {}),
    });
  }
  function variantComponentName(preset) {
    var variants = preset && preset.variantProperties || {};
    var names = Object.keys(variants).sort();
    if (names.length) return names.map(function (name) { return name + "=" + variants[name]; }).join(", ");
    return preset && preset.definitionName || "Pixso Component";
  }
  function collectSemanticGroups(pkg, state) {
    var groups = {};
    function walk(ref, depth) {
      var source = pkg.nodes && pkg.nodes[ref];
      if (!source) return;
      if (source.type === "INSTANCE") {
        var entity = pkg.instances && pkg.instances[source.id];
        var preset = entity && entity.preset;
        var signature = semanticSignature(preset);
        var target = state.nodes[source.id];
        if (signature && target && target.type === "FRAME") {
          if (!groups[signature]) groups[signature] = { signature: signature, preset: preset, candidates: [], maxDepth: depth };
          groups[signature].candidates.push({ ref: source.id, source: source, depth: depth });
          groups[signature].maxDepth = Math.max(groups[signature].maxDepth, depth);
        }
      }
      (source.children || []).forEach(function (childRef) { walk(childRef, depth + 1); });
    }
    (pkg.roots || []).forEach(function (root) { walk(root.nodeRef, 0); });
    return Object.keys(groups).map(function (key) { return groups[key]; }).sort(function (a, b) { return b.maxDepth - a.maxDepth; });
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

    var pairs = matchingChildren(source, target);
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i][1]) await copySnapshotOverrides(pairs[i][0], pairs[i][1], state);
    }
  }
  async function replaceSnapshotWithInstance(candidate, component, state) {
    var target = state.nodes[candidate.ref];
    if (!target || !target.parent || target.removed) return null;
    var parent = target.parent;
    var index = parent.children ? parent.children.indexOf(target) : -1;
    var instance = component.createInstance();
    if (index >= 0 && typeof parent.insertChild === "function") parent.insertChild(index, instance);
    else if (canHaveChildren(parent)) parent.appendChild(instance);
    applyCommon(instance, candidate.source, state.images, state.report);
    attachInstanceMetadata(instance, candidate.source, state, false);
    if (candidate.source.childLayout) {
      var instanceLayout = sanitizeChildLayout(candidate.source.childLayout, candidate.source.size);
      Object.keys(instanceLayout).forEach(function (key) { setValue(instance, key, instanceLayout[key]); });
      applyFigmaChildSizing(instance, instanceLayout, null);
    }
    await copySnapshotOverrides(target, instance, state);
    try { target.remove(); } catch (_eRemove) {}
    state.nodes[candidate.ref] = instance;
    state.report.nativeInstances += 1;
    return instance;
  }
  async function promoteSnapshotsToComponents(state) {
    if (typeof figma.createComponentFromNode !== "function") {
      warn(state.report, "Эта версия Figma не поддерживает createComponentFromNode; оставлены snapshot-фреймы.");
      return;
    }
    var groups = collectSemanticGroups(state.pkg, state);
    if (!groups.length) {
      warn(state.report, "В snapshot не найдено узлов с component metadata.");
      return;
    }

    var componentPage = figma.createPage();
    componentPage.name = "Pixso Components (native)";
    await componentPage.loadAsync();
    var bySet = {};
    var nextX = 0, nextY = 0, rowHeight = 0;

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var representative = null;
      for (var c = 0; c < group.candidates.length; c++) {
        var possible = state.nodes[group.candidates[c].ref];
        if (possible && possible.type === "FRAME" && possible.parent && !possible.removed) { representative = possible; break; }
      }
      if (!representative) continue;
      try {
        var clone = representative.clone();
        componentPage.appendChild(clone);
        clone.x = nextX; clone.y = nextY;
        var component = figma.createComponentFromNode(clone);
        component.name = variantComponentName(group.preset);
        setPluginData(component, "pixsoSemanticSignature", group.signature);
        setPluginData(component, "pixsoDefinitionName", group.preset.definitionName || "");
        setPluginData(component, "pixsoDefinitionSetName", group.preset.definitionSetName || "");
        state.report.nativeComponents += 1;

        rowHeight = Math.max(rowHeight, component.height);
        nextX += component.width + 80;
        if (nextX > 4000) { nextX = 0; nextY += rowHeight + 120; rowHeight = 0; }

        if (group.preset.definitionSetName) {
          if (!bySet[group.preset.definitionSetName]) bySet[group.preset.definitionSetName] = [];
          bySet[group.preset.definitionSetName].push(component);
        }
        for (var r = 0; r < group.candidates.length; r++) {
          await replaceSnapshotWithInstance(group.candidates[r], component, state);
        }
        if (i % 20 === 0) {
          try { figma.ui.postMessage({ type: "component-progress", current: i + 1, total: groups.length }); } catch (_eProgress) {}
        }
      } catch (_eComponent) {
        warn(state.report, "Не удалось создать Figma-компонент «" + (group.preset.definitionName || "без имени") + "»");
      }
    }

    Object.keys(bySet).forEach(function (setName) {
      var components = bySet[setName].filter(function (node) { return node && node.type === "COMPONENT" && node.parent; });
      if (components.length < 2) return;
      try {
        var set = figma.combineAsVariants(components, componentPage);
        set.name = setName;
        state.report.nativeComponentSets += 1;
      } catch (_eSet) { warn(state.report, "Не удалось объединить варианты «" + setName + "»"); }
    });
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
        if (type === "VARIANT") return; // Figma creates variant properties when variants combine.
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
    if (!preset || node.type !== "INSTANCE") return;
    var props = {};
    var main = null;
    try { main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : node.mainComponent; } catch (_e0) {}
    var definitions = main && main.componentPropertyDefinitions || {};
    Object.keys(preset.componentProperties || {}).forEach(function (logical) {
      var entry = preset.componentProperties[logical];
      if (!entry || entry.type === "INSTANCE_SWAP") return;
      var exact = Object.keys(definitions).filter(function (name) { return name === logical || name.indexOf(logical + "#") === 0; })[0] || logical;
      props[exact] = entry.value;
    });
    try { if (Object.keys(props).length) node.setProperties(props); }
    catch (_e) { warn(state.report, "Часть properties не применена к instance «" + node.name + "»"); }
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
  async function switchToPage(page) {
    if (typeof figma.setCurrentPageAsync === "function") return figma.setCurrentPageAsync(page);
    figma.currentPage = page;
  }
  async function importPackage(pkg, options) {
    validate(pkg);
    // documentAccess: dynamic-page требует явной загрузки page до appendChild.
    if (figma.currentPage && typeof figma.currentPage.loadAsync === "function") await figma.currentPage.loadAsync();
    options = options || {};
    var report = { created: 0, warnings: [], roots: 0, components: 0, detachedInstances: 0, resolvedInstances: 0, semanticSnapshots: 0, nativeComponents: 0, nativeInstances: 0, nativeComponentSets: 0, textOverridesRestored: 0, nestedSwapsRestored: 0, styleOverridesRestored: 0, strokeOverridesRestored: 0, vectorLineFallbacks: 0, svgNodesCreated: 0, stylesCreated: 0, mode: options.includeLibrary ? "library" : "screen" };
    var state = { pkg: pkg, report: report, nodes: {}, components: {}, componentSets: {}, propertyNames: {}, styles: {}, images: styleImages(pkg, report) };
    await createLocalStyles(state);
    if (Object.keys(pkg.variables || {}).length) warn(report, "Variables применены как значения; semantic bindings пока не переносятся.");
    if ((pkg.reactions || []).length) warn(report, "Prototype reactions сохранены в JSON, но пока не применяются.");
    // Если пакет уже содержит хотя бы одно resolved-поддерево, это экранный
    // snapshot. В screen-only режиме не строим библиотечные definitions:
    // именно их сборка раньше обрывала импорт до создания корневого экрана.
    var visualSnapshot = !options.includeLibrary && hasResolvedScreenInstances(pkg);
    var needComponentDefinitions = !!options.includeLibrary || (!visualSnapshot && screenNeedsComponentDefinitions(pkg));
    var componentIds = needComponentDefinitions ? collectRequiredComponents(pkg, !!options.includeLibrary) : [];
    var screenPage = figma.currentPage;
    if (componentIds.length) {
      var componentPage = figma.createPage(); componentPage.name = "Pixso Components";
      await componentPage.loadAsync();
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
    await switchToPage(screenPage);
    var offset = rootOffset(pkg), roots = [];
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
    report.roots = roots.length;
    if (options.promoteComponents && visualSnapshot) await promoteSnapshotsToComponents(state);
    await switchToPage(screenPage);
    figma.currentPage.selection = roots; figma.viewport.scrollAndZoomIntoView(roots);
    return report;
  }
  function setup() {
    figma.showUI(__html__, { width: 390, height: 250, title: "Pixso → Figma" });
    figma.ui.onmessage = async function (message) {
      if (!message || message.type !== "import-package") return;
      try { var report = await importPackage(message.pkg, message.options); figma.ui.postMessage({ type: "import-result", report: report }); figma.notify("Pixso screen import готов"); }
      catch (error) { figma.ui.postMessage({ type: "import-error", message: error && error.message || String(error) }); }
    };
  }
  if (typeof figma !== "undefined") setup();
  if (typeof module !== "undefined") module.exports = { validate: validate, bytesFromBase64: bytesFromBase64, collectRequiredComponents: collectRequiredComponents, rootOffset: rootOffset, hasResolvedScreenInstances: hasResolvedScreenInstances, screenNeedsComponentDefinitions: screenNeedsComponentDefinitions, semanticSignature: semanticSignature, variantComponentName: variantComponentName, applyFigmaChildSizing: applyFigmaChildSizing, applyChildConstraints: applyChildConstraints, sanitizeChildLayout: sanitizeChildLayout, isStrokeVectorFallback: isStrokeVectorFallback, isSvgRootNode: isSvgRootNode, applyCommon: applyCommon };
})();
