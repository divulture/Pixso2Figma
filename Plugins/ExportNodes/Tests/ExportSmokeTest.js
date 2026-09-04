/**
 * Smoke-тест Portable Exporter: node tests/ExportSmokeTest.js
 * Без зависимостей: фейковый Pixso API + assert.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var exporter = require(path.join(__dirname, "..", "Main.js"));

var checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

// ---------------------------------------------------------------------------
// 1. Чистые утилиты
// ---------------------------------------------------------------------------

eq(
  exporter.sha256Hex("abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "sha256(abc) — известный вектор"
);
eq(
  exporter.sha256Hex(""),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sha256(пустая строка)"
);
eq(
  exporter.canonicalStringify({ b: 1.00001, a: 2 }),
  '{"a":2,"b":1}',
  "canonicalStringify: сортировка ключей + нормализация чисел"
);
eq(
  exporter.canonicalStringify({ x: [3, 1, 2] }),
  '{"x":[3,1,2]}',
  "canonicalStringify: порядок массивов сохраняется"
);
eq(exporter.normalizeIconName("Icon / Arrow_Left.svg"), "arrow-left", "normalizeIconName");
eq(exporter.normalizeIconName("Icons/Search"), "search", "normalizeIconName: множественный префикс");
eq(exporter.stripPropertySuffix("Label#12:34"), "Label", "stripPropertySuffix");
assert.deepStrictEqual(
  exporter.parseVariantName("State=Hover, Size=M"),
  { State: "Hover", Size: "M" },
  "parseVariantName"
);
checks += 1;
eq(exporter.base64FromBytes([72, 105]), "SGk=", "base64FromBytes");

var utf8Sample = "Привет ✓ <svg/>";
eq(
  exporter.utf8FromBytes(Array.from(Buffer.from(utf8Sample, "utf8"))),
  utf8Sample,
  "utf8FromBytes: кириллица и спецсимволы"
);

// ---------------------------------------------------------------------------
// 2. Фейковое дерево Pixso
// ---------------------------------------------------------------------------

var nodeRegistry = {};
var idCounter = 0;

function makeNode(props) {
  var node = Object.assign(
    {
      id: props.id || "n:" + (++idCounter),
      type: "FRAME",
      name: "Node",
      visible: true,
      children: undefined,
      parent: null,
      getPluginData: function () { return ""; },
    },
    props
  );
  if (node.children) {
    node.children.forEach(function (child) {
      child.parent = node;
    });
  }
  nodeRegistry[node.id] = node;
  return node;
}

function svgExporter(markup) {
  return function (settings) {
    if (settings && settings.format === "SVG_STRING") return Promise.resolve(markup);
    return Promise.reject(new Error("only SVG_STRING in fake"));
  };
}

// --- Component Set "Button" с двумя вариантами ---

function makeVariant(stateName, variantId) {
  var label = makeNode({
    id: variantId + "-label",
    type: "TEXT",
    name: "Label",
    characters: "Button",
    fontName: { family: "Inter", style: "Medium" },
    fontSize: 14,
    componentPropertyReferences: { characters: "Label#1:2" },
    width: 60,
    height: 20,
    x: 28,
    y: 10,
  });
  var icon = makeNode({
    id: variantId + "-icon",
    type: "VECTOR",
    name: "Icon/search",
    width: 16,
    height: 16,
    x: 8,
    y: 12,
    componentPropertyReferences: { visible: "Show icon#1:3" },
    exportAsync: svgExporter('<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5"/></svg>'),
  });
  return makeNode({
    id: variantId,
    type: "COMPONENT",
    name: "State=" + stateName,
    variantProperties: { State: stateName },
    width: 120,
    height: 40,
    x: 0,
    y: stateName === "Default" ? 0 : 60,
    layoutMode: "HORIZONTAL",
    itemSpacing: 8,
    paddingLeft: 16,
    paddingRight: 16,
    primaryAxisSizingMode: "AUTO",
    counterAxisAlignItems: "CENTER",
    fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }],
    cornerRadius: 8,
    children: [icon, label],
  });
}

var variantDefault = makeVariant("Default", "comp-default");
var variantHover = makeVariant("Hover", "comp-hover");

var buttonSet = makeNode({
  id: "set-button",
  type: "COMPONENT_SET",
  name: "Button",
  description: "Primary button",
  key: "lib-key-button",
  width: 140,
  height: 120,
  componentPropertyDefinitions: {
    "State": { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
    "Label#1:2": { type: "TEXT", defaultValue: "Button" },
    "Show icon#1:3": { type: "BOOLEAN", defaultValue: true },
  },
  variantGroupProperties: { State: { values: ["Default", "Hover"] } },
  children: [variantDefault, variantHover],
});
buttonSet.defaultVariant = variantDefault;

// --- Инстанс кнопки с переопределённым текстом ---

var instanceLabel = makeNode({
  id: "inst-label",
  type: "TEXT",
  name: "Label",
  characters: "Buy now",
  fontName: { family: "Inter", style: "Medium" },
  fontSize: 14,
});
// Вектор внутри resolved-поддерева обычного инстанса: SVG для него НЕ выгружается
// (определение компонента уже несёт свои вектора) — шпион фиксирует вызовы.
var sepExportCalls = 0;
var instanceSep = makeNode({
  id: "inst-sep",
  type: "VECTOR",
  name: "Sep",
  width: 100,
  height: 1,
  exportAsync: function () {
    sepExportCalls += 1;
    return Promise.reject(new Error("must not be called"));
  },
});
var buttonInstance = makeNode({
  id: "inst-button",
  type: "INSTANCE",
  name: "Button",
  width: 132,
  height: 40,
  x: 24,
  y: 300,
  mainComponent: variantDefault,
  variantProperties: { State: "Default" },
  componentProperties: {
    "State": { type: "VARIANT", value: "Default" },
    "Label#1:2": { type: "TEXT", value: "Buy now" },
    "Show icon#1:3": { type: "BOOLEAN", value: true },
  },
  overrides: [{ id: "inst-label", overriddenFields: ["characters"] }],
  reactions: [
    {
      trigger: { type: "ON_CLICK" },
      action: { type: "NODE", destinationId: "comp-hover", transition: { type: "DISSOLVE", duration: 0.2 } },
    },
  ],
  children: [instanceLabel, instanceSep],
});

// --- Экран ---

var title = makeNode({
  id: "text-title",
  type: "TEXT",
  name: "Title",
  characters: "Экран покупки",
  fontName: { family: "Inter", style: "Bold" },
  fontSize: 24,
  textAlignHorizontal: "LEFT",
  width: 280,
  height: 32,
  x: 24,
  y: 24,
});
var photo = makeNode({
  id: "rect-photo",
  type: "RECTANGLE",
  name: "Photo",
  width: 280,
  height: 160,
  x: 24,
  y: 72,
  cornerRadius: 12,
  fills: [{ type: "IMAGE", imageHash: "img123", scaleMode: "FILL" }],
});
var closeIcon = makeNode({
  id: "icon-close",
  type: "FRAME",
  name: "Icon/close",
  width: 24,
  height: 24,
  x: 280,
  y: 24,
  children: [
    makeNode({
      id: "icon-close-vector",
      type: "VECTOR",
      name: "Vector",
      width: 16,
      height: 16,
      exportAsync: svgExporter('<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/></svg>'),
    }),
  ],
  exportAsync: svgExporter('<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'),
});
var divider = makeNode({
  id: "vector-divider",
  type: "VECTOR",
  name: "Divider",
  width: 280,
  height: 2,
  x: 24,
  y: 260,
  layoutSizingHorizontal: "FILL",
  layoutSizingVertical: "FIXED",
  constraints: { horizontal: "STRETCH", vertical: "CENTER" },
  exportAsync: svgExporter('<svg viewBox="0 0 280 2"><path d="M0 1h280"/></svg>'),
});

var screen = makeNode({
  id: "frame-screen",
  type: "FRAME",
  name: "Screen / Checkout",
  width: 328,
  height: 380,
  x: 100,
  y: 200,
  absoluteTransform: [[1, 0, 100], [0, 1, 200]],
  layoutMode: "VERTICAL",
  itemSpacing: 16,
  paddingTop: 24,
  paddingBottom: 24,
  paddingLeft: 24,
  paddingRight: 24,
  primaryAxisSizingMode: "AUTO",
  counterAxisSizingMode: "FIXED",
  clipsContent: true,
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
  strokes: [{ type: "SOLID", color: { r: 0.8, g: 0.82, b: 0.86 } }],
  strokeWeight: 1,
  strokeTopWeight: 0,
  strokeRightWeight: 0,
  strokeBottomWeight: 1,
  strokeLeftWeight: 0,
  strokeAlign: "INSIDE",
  strokeMiterLimit: 4,
  fillStyleId: "S:style-bg",
  children: [title, photo, closeIcon, divider, buttonInstance],
});

// --- Второй корень: инстанс без mainComponent (snapshot fallback) ---

var brokenChild = makeNode({
  id: "broken-rect",
  type: "RECTANGLE",
  name: "Body",
  width: 100,
  height: 40,
  fills: [{ type: "SOLID", color: { r: 0.9, g: 0.1, b: 0.1 } }],
});
// Вектор в snapshot-поддереве: SVG обязателен — это единственный источник данных
var brokenWave = makeNode({
  id: "broken-wave",
  type: "VECTOR",
  name: "Wave",
  width: 100,
  height: 8,
  exportAsync: svgExporter('<svg viewBox="0 0 100 8"><path d="M0 4q25-8 50 0t50 0"/></svg>'),
});
var brokenInstance = makeNode({
  id: "inst-broken",
  type: "INSTANCE",
  name: "Detached widget",
  width: 100,
  height: 40,
  mainComponent: null,
  componentProperties: {},
  children: [brokenChild, brokenWave],
});
var brokenFrame = makeNode({
  id: "frame-broken",
  type: "FRAME",
  name: "Broken area",
  width: 200,
  height: 100,
  x: 600,
  y: 200,
  minHeight: 200,
  strokes: [{ type: "SOLID", color: { r: 0.4, g: 0.4, b: 0.4 } }],
  strokeWeight: 0,
  children: [brokenInstance],
});

var page = makeNode({
  id: "page-1",
  type: "PAGE",
  name: "Page 1",
  children: [screen, brokenFrame, buttonSet],
});
page.selection = [screen, brokenFrame];

var paintStyle = {
  id: "S:style-bg",
  type: "PAINT",
  name: "bg/surface",
  description: "",
  paints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
};

var fakeApi = {
  apiVersion: "1.0-fake",
  fileKey: "filekey-abc",
  root: { id: "doc-1", name: "TestFile", type: "DOCUMENT" },
  currentPage: page,
  getNodeById: function (id) { return nodeRegistry[id] || null; },
  getLocalPaintStyles: function () { return [paintStyle]; },
  getLocalTextStyles: function () { return []; },
  getLocalEffectStyles: function () { return []; },
  getImageByHash: function (hash) {
    if (hash !== "img123") return null;
    return {
      getBytesAsync: function () {
        return Promise.resolve([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 3. detectIcon
// ---------------------------------------------------------------------------

var detected = exporter.detectIcon(closeIcon);
ok(detected && detected.normalizedName === "close", "detectIcon: фрейм Icon/close по префиксу");
var bigIconFrame = makeNode({ id: "big-icons", type: "FRAME", name: "Icons/Overview", width: 800, height: 600 });
eq(exporter.detectIcon(bigIconFrame), null, "detectIcon: большой фрейм Icons/Overview не иконка");
eq(exporter.detectIcon(divider), null, "detectIcon: обычный вектор не иконка");

// ---------------------------------------------------------------------------
// 4. Полный экспорт
// ---------------------------------------------------------------------------

exporter
  .exportFullPackage(fakeApi, { includeInstanceSubtrees: true }, { collectBinary: true })
  .then(function (pkg) {
    // Опционально сохраняем пакет как образец: SAMPLE_OUT=path node tests/ExportSmokeTest.js
    if (process.env.SAMPLE_OUT) {
      require("fs").writeFileSync(process.env.SAMPLE_OUT, JSON.stringify(pkg, null, 2), "utf8");
      console.log("sample written: " + process.env.SAMPLE_OUT);
    }

    // Формат пакета
    eq(pkg.format, "pixso-portable-package", "format");
    eq(pkg.exportMode, "FULL", "exportMode");
    eq(pkg.schemaVersion, "1.0.0", "schemaVersion");
    eq(pkg.source.fileKey, "filekey-abc", "source.fileKey");
    eq(pkg.roots.length, 2, "два корня (мультивыделение)");
    ok(pkg.roots[0].absolutePosition.x === 100 && pkg.roots[0].absolutePosition.y === 200, "absolutePosition из absoluteTransform");

    // Component Set + варианты
    var setIds = Object.keys(pkg.componentSets);
    eq(setIds.length, 1, "один componentSet");
    var setEntity = pkg.componentSets[setIds[0]];
    eq(setEntity.name, "Button", "имя сета");
    eq(setEntity.libraryKey, "lib-key-button", "library key");
    assert.deepStrictEqual(
      setEntity.variantGroupProperties.State.values,
      ["Default", "Hover"],
      "variantGroupProperties"
    );
    checks += 1;
    eq(setEntity.componentRefs.length, 2, "два варианта в сете");
    ok(setEntity.defaultVariantRef === setEntity.componentRefs[0], "defaultVariantRef → первый вариант");

    var componentIds = Object.keys(pkg.components);
    eq(componentIds.length, 2, "два компонента-варианта");
    var defaultComponent = pkg.components[setEntity.componentRefs[0]];
    assert.deepStrictEqual(defaultComponent.variantProperties, { State: "Default" }, "variantProperties варианта");
    checks += 1;
    eq(defaultComponent.componentSetRef, setEntity.portableId, "обратная ссылка на сет");
    ok(defaultComponent.rootNodeRef && pkg.nodes[defaultComponent.rootNodeRef], "дерево варианта сериализовано");

    // Свойства сета: VARIANT + TEXT + BOOLEAN, суффиксы срезаны
    var propNames = setEntity.properties.map(function (p) { return p.logicalPropertyName; }).sort();
    assert.deepStrictEqual(propNames, ["Label", "Show icon", "State"], "логические имена свойств");
    checks += 1;
    var labelProp = setEntity.properties.filter(function (p) { return p.logicalPropertyName === "Label"; })[0];
    eq(labelProp.propertyType, "TEXT", "тип свойства Label");
    eq(labelProp.rawPixsoPropertyName, "Label#1:2", "raw имя свойства сохранено");

    // Привязка свойства к слою внутри варианта
    var variantTree = pkg.nodes[defaultComponent.rootNodeRef];
    var labelNodeRef = variantTree.children.filter(function (ref) {
      return pkg.nodes[ref].type === "TEXT";
    })[0];
    ok(labelNodeRef, "текстовый слой внутри варианта");
    eq(
      pkg.nodes[labelNodeRef].componentPropertyReferences.characters,
      labelProp.portableId,
      "componentPropertyReferences → portable id свойства"
    );

    // Иконки: search внутри вариантов + close на экране; definition иконок не разворачивается
    ok(pkg.iconDependencies.search, "иконка search в зависимостях");
    eq(pkg.iconDependencies.search.usageCount, 2, "search используется в двух вариантах");
    ok(pkg.iconDependencies.close, "иконка close в зависимостях");
    var iconNodes = Object.keys(pkg.nodes).filter(function (id) { return pkg.nodes[id].type === "ICON"; });
    eq(iconNodes.length, 3, "три ICON-узла");

    // Инстанс: пресет
    var instanceIds = Object.keys(pkg.instances);
    eq(instanceIds.length, 2, "два инстанса (обычный + snapshot)");
    var normalInstance = null;
    var snapshotInstance = null;
    instanceIds.forEach(function (id) {
      var preset = pkg.instances[id].preset;
      if (preset.availability === "SNAPSHOT_ONLY") snapshotInstance = pkg.instances[id];
      else normalInstance = pkg.instances[id];
    });
    ok(normalInstance, "обычный инстанс найден");
    eq(normalInstance.preset.definitionSetRef, setEntity.portableId, "пресет ссылается на сет");
    eq(normalInstance.preset.definitionRef, setEntity.componentRefs[0], "пресет ссылается на вариант Default");
    eq(normalInstance.preset.variantProperties.State, "Default", "variantProperties пресета");
    eq(normalInstance.preset.componentProperties.Label.value, "Buy now", "значение TEXT-свойства");
    eq(normalInstance.preset.componentProperties["Show icon"].value, true, "значение BOOLEAN-свойства");

    // Overrides
    eq(normalInstance.preset.overrides.length, 1, "один override");
    var override = normalInstance.preset.overrides[0];
    eq(override.changes.characters, "Buy now", "override characters");
    eq(override.targetPath[0].name, "Label", "путь override");
    ok(normalInstance.preset.textOverrides.length >= 1, "textOverrides захвачены");

    // Snapshot fallback
    ok(snapshotInstance, "snapshot-инстанс найден");
    var snapshotNode = pkg.nodes[snapshotInstance.nodeRef];
    ok(snapshotNode.children && snapshotNode.children.length === 2, "snapshot-поддерево сохранено");
    var hasMainUnavailable = pkg.diagnostics.some(function (d) { return d.code === "MAIN_COMPONENT_UNAVAILABLE"; });
    ok(hasMainUnavailable, "диагностика MAIN_COMPONENT_UNAVAILABLE");

    // Стили
    var styleIds = Object.keys(pkg.styles);
    eq(styleIds.length, 1, "один стиль");
    eq(pkg.styles[styleIds[0]].name, "bg/surface", "имя стиля");
    var screenNode = pkg.nodes[pkg.roots[0].nodeRef];
    eq(screenNode.styleRefs.fill, styleIds[0], "styleRefs.fill экрана");
    ok(screenNode.autoLayout && screenNode.autoLayout.layoutMode === "VERTICAL", "autoLayout экрана");
    eq(screenNode.geometry.strokeBottomWeight, 1, "нижняя индивидуальная обводка");
    eq(screenNode.geometry.strokeTopWeight, 0, "нулевая верхняя обводка не потеряна");
    eq(screenNode.geometry.strokeMiterLimit, 4, "stroke miter limit");
    var brokenRootNode = pkg.nodes[pkg.roots[1].nodeRef];
    eq(brokenRootNode.geometry.strokeWeight, 0, "нулевая толщина stroke сохранена");
    ok(!brokenRootNode.childLayout || brokenRootNode.childLayout.minHeight === undefined, "противоречащий snapshot size minHeight отброшен");

    // Изображения
    var imageIds = Object.keys(pkg.images);
    eq(imageIds.length, 1, "одно изображение");
    var image = pkg.images[imageIds[0]];
    ok(image.contentHash.indexOf("sha256:") === 0, "contentHash изображения");
    eq(image.mimeType, "image/png", "mime изображения");
    ok(image.bytesBase64 && image.bytesBase64.length > 0, "байты изображения в base64");

    // SVG векторов (не иконок): Divider на экране + Wave в snapshot-поддереве.
    // Sep внутри поддерева обычного инстанса SVG не получает.
    var svgAssetIds = Object.keys(pkg.svgAssets);
    eq(svgAssetIds.length, 2, "svg-ассеты: Divider + Wave (иконки без снапшотов по умолчанию)");
    function nodeByName(name) {
      var id = Object.keys(pkg.nodes).filter(function (nid) { return pkg.nodes[nid].name === name; })[0];
      return id ? pkg.nodes[id] : null;
    }
    var dividerNode = nodeByName("Divider");
    ok(dividerNode.svgRef && pkg.svgAssets[dividerNode.svgRef], "svgRef вектора Divider");
    eq(dividerNode.childLayout.layoutSizingHorizontal, "FILL", "Divider сохранил FILL по ширине");
    assert.deepStrictEqual(dividerNode.constraints, { horizontal: "STRETCH", vertical: "CENTER" }, "Divider сохранил constraints");
    checks += 1;
    var waveNode = nodeByName("Wave");
    ok(waveNode && waveNode.svgRef && pkg.svgAssets[waveNode.svgRef], "svgRef вектора Wave в snapshot-поддереве");
    var sepNode = nodeByName("Sep");
    ok(sepNode && !sepNode.svgRef, "вектор Sep в поддереве инстанса без svgRef");
    eq(sepExportCalls, 0, "exportAsync для Sep не вызывался");
    var hasSvgFailed = pkg.diagnostics.some(function (d) { return d.code === "SVG_EXPORT_FAILED"; });
    ok(!hasSvgFailed, "нет диагностик SVG_EXPORT_FAILED");

    // Шрифты
    var fontKeys = pkg.fonts.map(function (f) { return f.family + "/" + f.style; });
    ok(fontKeys.indexOf("Inter/Bold") >= 0, "шрифт Inter Bold");
    ok(fontKeys.indexOf("Inter/Medium") >= 0, "шрифт Inter Medium");

    // Реакции
    eq(pkg.reactions.length, 1, "одна реакция");
    var reaction = pkg.reactions[0];
    ok(reaction.destinationRef && pkg.nodes[reaction.destinationRef], "цель реакции разрешена в portable id");
    eq(reaction.actionType, "NODE", "тип действия реакции");

    // Fingerprints
    var setFingerprint = pkg.fingerprints[setEntity.portableId];
    ok(setFingerprint && setFingerprint.contractHash.indexOf("sha256:") === 0, "contractHash сета");
    ok(setFingerprint.structuralHash.indexOf("sha256:") === 0, "structuralHash сета");
    ok(pkg.fingerprints[pkg.roots[0].nodeRef], "fingerprint корня");

    // Граф зависимостей: иконка → вариант → сет → корень
    var order = pkg.dependencies.order;
    var iconIndex = order.indexOf("icon:search");
    var memberIndex = order.indexOf(setEntity.componentRefs[0]);
    var setIndex = order.indexOf(setEntity.portableId);
    var rootIndex = order.indexOf(pkg.roots[0].nodeRef);
    ok(iconIndex >= 0 && memberIndex > iconIndex, "иконка раньше варианта");
    ok(setIndex > memberIndex, "вариант раньше сета");
    ok(rootIndex > setIndex, "сет раньше корня");
    var styleIndex = order.indexOf(styleIds[0]);
    ok(styleIndex >= 0 && styleIndex < rootIndex, "стиль раньше корня");

    // JSON-сериализуемость
    var json = JSON.stringify(pkg);
    ok(json.length > 1000, "пакет сериализуется в JSON");
    ok(json.indexOf("undefined") < 0, "нет строки 'undefined' в JSON");

    return exporter.exportFullPackage(fakeApi, { includeInstanceSubtrees: true }, { collectBinary: true }).then(function (pkg2) {
      // Детерминизм: повторный экспорт даёт те же fingerprints
      assert.deepStrictEqual(pkg2.fingerprints, pkg.fingerprints, "fingerprints стабильны между экспортами");
      checks += 1;

      return exporter.exportFullPackage(fakeApi, {
        includeInstanceSubtrees: true,
        visualSnapshotMode: true,
        includeVectorSvg: true,
        includeIconSnapshots: true,
      }, { collectBinary: true }).then(function (visualPkg) {
        eq(visualPkg.transferMode, "VISUAL_SNAPSHOT", "visual snapshot mode помечен в пакете");
        eq(Object.keys(visualPkg.components).length, 0, "visual snapshot не экспортирует component definitions");
        var visualPresets = Object.keys(visualPkg.instances).map(function (id) { return visualPkg.instances[id].preset; });
        ok(visualPresets.length > 0 && visualPresets.every(function (preset) { return preset.availability === "SNAPSHOT_ONLY"; }), "visual instances экспортированы как snapshot");
        var visualIconNodes = Object.keys(visualPkg.nodes).map(function (id) { return visualPkg.nodes[id]; }).filter(function (node) { return node.type === "ICON"; });
        ok(visualIconNodes.length > 0 && visualIconNodes.every(function (node) { return !!node.svgRef; }), "включённые SVG-снимки иконок попали в visual snapshot");

        // Анализ
        return exporter.analyzeSelection(fakeApi, {});
      });
    });
  })
  .then(function (analysis) {
    eq(analysis.counts.componentSets, 1, "анализ: один сет");
    eq(analysis.counts.components, 2, "анализ: два компонента");
    eq(analysis.counts.instances, 2, "анализ: два инстанса");
    eq(analysis.counts.iconsUnique, 2, "анализ: две уникальные иконки");
    eq(analysis.counts.iconsUsage, 3, "анализ: три использования иконок");
    eq(analysis.counts.images, 1, "анализ: одно изображение");
    ok(analysis.estimatedSizeBytes > 0, "анализ: оценка размера");
    eq(analysis.roots.length, 2, "анализ: два корня");
    ok(analysis.warnings.length >= 1, "анализ: есть предупреждение о snapshot");

    console.log("OK: " + checks + " проверок пройдено");
  })
  .catch(function (error) {
    console.error("FAILED after " + checks + " checks");
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
