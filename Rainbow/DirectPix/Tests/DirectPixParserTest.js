/**
 * Direct PIX: контейнер, декодер Kiwi, дерево документа, анализатор и IR.
 *
 *   node DirectPix/Tests/DirectPixParserTest.js
 *
 * Всё проверяется на синтетической фикстуре: ни один байт реального `.pix`
 * сюда не попадает, поэтому тест ловит именно привязку к формату, а не к
 * конкретному документу.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var Fixture = require("./Fixture");
var PixContainer = require("../PixContainer");
var PixDocument = require("../PixDocument");
var Analyzer = require("../Analyzer");
var MigrationIR = require("../MigrationIR");
var PixNormalizer = require("../PixNormalizer");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "directpix-"));
function writeFixture(name, options) {
  var built = Fixture.buildContainer(options);
  var file = path.join(tempDir, name);
  fs.writeFileSync(file, built.zip);
  return { file: file, ids: built.scene.ids };
}

// ---------------------------------------------------------------------------
// Контейнер
// ---------------------------------------------------------------------------

var fixture = writeFixture("scene.pix", {});
var container = PixContainer.open(fixture.file);

eq(container.payloadHeader.tag, "compress:zstd", "payload распакован из zstd");
eq(container.version.kiwi_version, "v10.01", "VERSION прочитан");
eq(container.entries.length, 5, "перечислены все записи ZIP");
ok(container.resourceIds.indexOf("abcdef") >= 0, "ресурс найден по имени без расширения");
ok(!container.hasResource("нет-такого"), "несуществующий ресурс не находится");
eq(container.thumbnail, "abc123.thumb.png", "превью опознано и не спутано с payload");
// Payload ищется по магии, а не по имени: имя документа тут в кириллице.
ok(/\.pix$/.test(container.payloadName), "payload опознан по сигнатуре");

var noCompression = writeFixture("plain.pix", { codec: "none" });
eq(PixContainer.open(noCompression.file).payloadHeader.tag, "compress:none", "несжатый payload читается");

// Имя документа не участвует в разборе.
var renamed = writeFixture("renamed.pix", { documentName: "совершенно другое имя.pix" });
ok(PixContainer.open(renamed.file).documentBuffer.length > 0, "документ найден при другом имени");

// Внятная ошибка вместо мусорного разбора.
var brokenPath = path.join(tempDir, "broken.pix");
fs.writeFileSync(brokenPath, Buffer.from("это вообще не zip"));
assert.throws(function () { PixContainer.open(brokenPath); }, /End of Central Directory/, "не-ZIP даёт понятную ошибку");
checks += 1;

var noSchema = path.join(tempDir, "noschema.pix");
fs.writeFileSync(noSchema, Fixture.zipStore([{ name: "VERSION", data: Buffer.from("{}") }]));
assert.throws(function () { PixContainer.open(noSchema); }, /pixso\.binary/, "контейнер без схемы отвергается с объяснением");
checks += 1;

// ---------------------------------------------------------------------------
// Документ
// ---------------------------------------------------------------------------

var doc = PixDocument.load(container);
var ids = fixture.ids;

eq(doc.header.type, "FIC_DOCUMENT", "тип сообщения разобран как enum");
eq(doc.nodeCount, 17, "разобраны все узлы");
eq(doc.blobCount, 1, "blob-ы посчитаны");
eq(doc.tree.orphans.length, 0, "потерянных узлов нет");
eq(doc.tree.pages.length, 2, "страницы найдены по типу CANVAS");
ok(doc.timings.kiwiDecodeMs >= 0 && doc.timings.normalizeMs >= 0, "тайминги измерены, а не подставлены");

var screen = doc.tree.byKey.get(ids.screenRoot);
eq(screen.type, "FRAME", "корень экрана — фрейм");
eq(screen.children.length, 5, "дети корня собраны");
eq(screen.children[0].key, ids.plainInstance, "порядок детей взят из parentIndex.position");
eq(screen.children[4].key, ids.unsupportedNode, "последний ребёнок на своём месте");

var instance = doc.tree.byKey.get(ids.overriddenInstance);
eq(instance.symbolId, ids.buttonNormal, "инстанс связан с исходным SYMBOL");
eq(doc.tree.byKey.get(ids.buttonNormal).children.length, 2, "символ содержит своё поддерево");
eq(doc.symbols.instances.length, 3, "инстансы найдены, включая вложенный");
eq(doc.symbols.unresolvedInstances.length, 0, "все ссылки на символы разрешились");
eq(doc.symbols.familiesByKey.get("key-button").length, 2,
  "два SYMBOL делят один componentKey — это разные состояния");

// Детальный разбор идёт по сохранённому смещению.
var detail = doc.detail(instance);
eq(detail.symbolData.symbolOverrides.length, 4, "overrides прочитаны при детальном разборе");
eq(doc.detail(doc.tree.byKey.get(ids.text)).textData.characters, "Кнопка", "текст прочитан");

// ---------------------------------------------------------------------------
// Анализатор
// ---------------------------------------------------------------------------

var report = Analyzer.analyze(doc, {});
eq(report.totals.symbols, 3, "SYMBOL посчитаны");
eq(report.totals.instances, 3, "INSTANCE посчитаны");
eq(report.totals.usedSymbols, 2, "используются два символа из трёх");
eq(report.totals.componentFamilies, 2, "componentKey сгруппированы");
eq(report.sharedComponentKeyCount, 1, "видно, что один ключ делят несколько SYMBOL");
eq(report.totals.overrideRecords, 4, "записи override посчитаны");
eq(report.totals.overridePathsEmpty, 1, "override без адреса виден отдельно");
eq(report.totals.vectorGeometryBlobs, 1, "blob геометрии учтён");
eq(report.totals.vectorGeometryUndecodable, 0, "путь разобрался");
eq(report.totals.imageResourcesReferenced, 1, "используемое изображение найдено в контейнере по своему хешу");
ok(report.unsupportedNodeTypes.some(function (entry) { return entry.key === "PROD_TABLE"; }),
  "неподдерживаемый тип узла назван, а не спрятан");

var listing = Analyzer.listRoots(doc, "Экран");
eq(listing.length, 1, "фильтр по странице работает");
eq(listing[0].roots[0].id, ids.screenRoot, "корень страницы перечислен с id");
eq(listing[0].roots[0].nodes, 6, "размер поддерева посчитан");

// ---------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------

var ir = MigrationIR.build(doc, { roots: [screen] });

eq(ir.protocol, "PIXSO2FIGMA_DIRECT_PIX", "объявлен собственный протокол");
eq(ir.version, 1, "версия протокола объявлена");
eq(ir.roots.length, 1, "собран один корень");
eq(ir.roots[0].pageName, "Экран", "страница взята из документа");

var rootNodes = ir.roots[0].nodes;
eq(rootNodes.length, 5, "неподдерживаемый узел не подменён похожим, а пропущен и посчитан");
eq(rootNodes[0].kind, "ORDINARY", "корень — обычный узел");
eq(rootNodes[0].autoLayout.layoutMode, "VERTICAL", "auto layout перенесён");
eq(rootNodes[0].autoLayout.itemSpacing, 12, "шаг auto layout перенесён");
eq(rootNodes[0].effects.length, 1, "эффект перенесён");
eq(rootNodes[0].effects[0].type, "DROP_SHADOW", "тип эффекта переведён в модель Figma");
eq(rootNodes[0].constraints.horizontal, "MIN", "constraints перенесены");
eq(rootNodes[0].fills[0].color.r, 0.96078, "цвет переведён из 0..255 в 0..1");
eq(ir.unsupported.NODE_TYPE, 1, "пропущенный тип узла посчитан");

// Определения: одно на исходный SYMBOL, вложенное собрано отдельно.
eq(ir.definitions.length, 2, "собраны определения кнопки и вложенной иконки");
var iconDefinition = ir.definitions[0];
eq(iconDefinition.definitionId, ids.icon, "вложенное определение собрано раньше внешнего");
var buttonDefinition = ir.definitions[1];
eq(buttonDefinition.definitionId, ids.buttonNormal, "идентичность определения — guid исходного SYMBOL");
eq(buttonDefinition.componentKey, "key-button", "componentKey сохранён как семейство");
eq(buttonDefinition.variantGroupId, ids.stateGroup, "вариантная группа названа, но состояния не схлопнуты");
eq(buttonDefinition.nodes[0].type, "COMPONENT", "корень определения — компонент");
eq(buttonDefinition.nodes.length, 3, "определение содержит своё поддерево один раз");
eq(buttonDefinition.nodes[2].kind, "INSTANCE", "вложенный инстанс остался инстансом");
eq(buttonDefinition.nodes[2].definitionId, ids.icon, "вложенный инстанс ссылается на своё определение");
eq(buttonDefinition.nodes[1].text.characters, "Кнопка", "текст определения перенесён");
eq(buttonDefinition.nodes[1].childLayout.layoutAlign, "STRETCH",
  "растяжение по поперечной оси перенесено");

// Второе состояние не собирается, пока на него нет вхождения.
ok(!ir.definitions.some(function (definition) { return definition.definitionId === ids.buttonPressed; }),
  "неиспользуемое состояние не тащится в job");

// Вхождения.
var occurrences = rootNodes.filter(function (node) { return node.kind === "INSTANCE"; });
eq(occurrences.length, 2, "оба вхождения остались инстансами");
eq(occurrences[0].definitionId, ids.buttonNormal, "вхождение ссылается на определение");
ok(!occurrences[0].overrides, "инстанс без правок не тащит пустой список overrides");
eq(ir.stats.definitionsBuilt, 2, "определение собрано один раз на job");
eq(ir.stats.instancesEmitted, 3, "посчитаны все вхождения, включая вложенное");

// Overrides.
var overrides = occurrences[1].overrides;
eq(overrides.length, 2, "две адресуемые цели override");
eq(overrides[0].path.length, 0, "правка корня инстанса адресуется пустым путём");
// Пустой guidPath и guidPath из одного guid самого символа — две записи об
// одной цели: корне инстанса. Они сливаются в одну правку, побеждает
// последняя. Раньше пустой путь считался неадресуемым и молча терялся.
eq(overrides[0].ops.fills[0].color.b, 0.01176,
  "пустой guidPath адресует корень инстанса, а не выбрасывается");
eq(overrides[1].path.length, 1, "правка вложенного текста адресуется индексным путём");
eq(overrides[1].path[0].index, 0, "индекс цели вычислен по дереву определения");
eq(overrides[1].path[0].name, "Подпись", "имя едет только как проверка найденного узла");
eq(overrides[1].ops.characters, "Отправить", "текстовая правка перенесена");
eq(ir.unsupported.OVERRIDE_FIELD, 1, "неподдерживаемое поле override посчитано");
eq(ir.overrideResolution.NO_SUPPORTED_OVERRIDE_FIELD, 1,
  "запись без единого переносимого поля отнесена к неподдержанным, а не к промахам адресации");
ok(!ir.overrideResolution.TARGET_GUID_NOT_IN_DEFINITION,
  "адресуемые цели фикстуры разрешены полностью");
ok(ir.unsupportedSamples.some(function (sample) { return sample.detail === "exportSettings"; }),
  "в выборке видно, какое именно поле потеряно");

// Векторы: геометрия переносится путём, а не растром и не SVG-экспортом.
var vector = rootNodes.filter(function (node) { return node.sourceType === "VECTOR"; })[0];
eq(vector.type, "VECTOR", "вектор остался вектором");
eq(vector.vectorPaths.length, 1, "путь собран из blob");
eq(vector.vectorPaths[0].windingRule, "EVENODD", "правило заливки переведено в модель Figma");
ok(/^M 0 0 L 10 0 L 10 10 Z$/.test(vector.vectorPaths[0].data), "команды пути разобраны точно");

// Изображение: ссылка на job-level таблицу, а не байты внутри узла.
var image = rootNodes.filter(function (node) { return node.id === ids.imageNode; })[0];
eq(image.fills[0].type, "IMAGE", "заливка изображением перенесена");
eq(image.fills[0].assetId, "abcdef", "заливка ссылается на ассет, а не несёт байты");
eq(ir.assets.length, 1, "ассет зарегистрирован в таблице уровня job");
eq(ir.assets[0].assetId, "abcdef", "идентификатор ассета — хеш из документа");
eq(ir.assets[0].extension, "png", "тип ресурса взят из контейнера");

// Изображение, ресурса для которого в контейнере нет: подставлять вместо него
// цвет нельзя — потеря обязана быть посчитана.
var withoutResource = Fixture.buildScene();
withoutResource.resources = [];
var orphanImageFile = path.join(tempDir, "no-image.pix");
fs.writeFileSync(orphanImageFile, Fixture.buildContainer({ build: withoutResource }).zip);
var orphanDoc = PixDocument.load(PixContainer.open(orphanImageFile));
var orphanIr = MigrationIR.build(orphanDoc, { roots: [orphanDoc.tree.byKey.get(ids.screenRoot)] });
var orphanImage = orphanIr.roots[0].nodes.filter(function (node) { return node.id === ids.imageNode; })[0];
eq(orphanImage.fills.length, 0, "изображение без ресурса не подменяется цветом");
eq(orphanIr.unsupported.PAINT_IMAGE_MISSING, 1, "отсутствующее изображение посчитано");
eq(orphanIr.assets.length, 0, "несуществующий ассет в таблицу не попадает");

// Stroke-only VECTOR: Pixso stores the exact expanded outline in
// strokeGeometry even when fillGeometry is absent. The old importer created
// an empty VectorNode and only a fraction of illustration layers survived.
var strokeOnlyScene = Fixture.buildScene();
var strokeOnlyVector = strokeOnlyScene.nodes.filter(function (node) { return node.guid.localID === 104; })[0];
delete strokeOnlyVector.fillGeometry;
delete strokeOnlyVector.fillPaints;
strokeOnlyVector.strokeGeometry = [{ blobIndex: 0, windingRule: "ODD" }];
strokeOnlyVector.strokePaints = [{ type: "SOLID", color: { r: 12, g: 34, b: 56, a: 255 }, visible: true, blendMode: "NORMAL" }];
strokeOnlyVector.strokeWeight = 2;
var strokeOnlyFile = path.join(tempDir, "stroke-only.pix");
fs.writeFileSync(strokeOnlyFile, Fixture.buildContainer({ build: strokeOnlyScene }).zip);
var strokeOnlyDoc = PixDocument.load(PixContainer.open(strokeOnlyFile));
var strokeOnlyIr = MigrationIR.build(strokeOnlyDoc, { roots: [strokeOnlyDoc.tree.byKey.get(ids.screenRoot)] });
var outlinedVector = strokeOnlyIr.roots[0].nodes.filter(function (node) { return node.id === ids.vectorNode; })[0];
eq(outlinedVector.vectorPaths.length, 1, "stroke-only vector uses Pixso expanded stroke geometry");
eq(outlinedVector.fills.length, 1, "expanded stroke outline is painted as a fill");
eq(outlinedVector.fills[0].color.g, 0.13333, "source stroke paint becomes outline fill without recoloring");
eq(outlinedVector.strokes.length, 0, "outlined fallback does not draw the source stroke a second time");
ok(strokeOnlyIr.stats.strokeOnlyVectorsOutlined >= 1, "stroke-only outline fallback is measured");

// Expanded strokeGeometry is NOT a centerline. A zero-height/zero-width source
// vector is a legitimate stroked line; flattening the expanded outline would
// turn it into a non-zero layout box and grow HUG parents. Keep the source
// stroke semantics until vectorNetworkBlob can be decoded properly.
var degenerateStrokeScene = Fixture.buildScene();
var degenerateStrokeVector = degenerateStrokeScene.nodes.filter(function (node) { return node.guid.localID === 104; })[0];
delete degenerateStrokeVector.fillGeometry;
delete degenerateStrokeVector.fillPaints;
degenerateStrokeVector.size = { x: 120, y: 0 };
degenerateStrokeVector.strokeGeometry = [{ blobIndex: 0, windingRule: "ODD" }];
degenerateStrokeVector.strokePaints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 255 }, visible: true, blendMode: "NORMAL" }];
degenerateStrokeVector.strokeWeight = 1;
var degenerateStrokeFile = path.join(tempDir, "stroke-line.pix");
fs.writeFileSync(degenerateStrokeFile, Fixture.buildContainer({ build: degenerateStrokeScene }).zip);
var degenerateStrokeDoc = PixDocument.load(PixContainer.open(degenerateStrokeFile));
var degenerateStrokeIr = MigrationIR.build(degenerateStrokeDoc, { roots: [degenerateStrokeDoc.tree.byKey.get(ids.screenRoot)] });
var degenerateVector = degenerateStrokeIr.roots[0].nodes.filter(function (node) { return node.id === ids.vectorNode; })[0];
ok(!degenerateVector.vectorPaths, "zero-height stroked vector is not flattened into expanded fill geometry");
eq(degenerateVector.height, 0, "zero-height stroked vector keeps its source layout box");
ok(degenerateVector.strokes && degenerateVector.strokes.length === 1, "unsafe outline fallback keeps original stroke paint");
ok(degenerateStrokeIr.stats.strokeOnlyVectorsDegenerate >= 1, "degenerate stroke-only vectors are measured separately");

// Preferred path: decode vectorNetworkBlob back to the ORIGINAL centerline.
// Unlike strokeGeometry this preserves a zero-height line as a zero-height
// vector while retaining its real stroke paint/weight.
var networkScene = Fixture.buildScene();
var networkVector = networkScene.nodes.filter(function (node) { return node.guid.localID === 104; })[0];
delete networkVector.fillGeometry;
delete networkVector.fillPaints;
networkVector.size = { x: 120, y: 0 };
networkVector.strokeGeometry = [{ blobIndex: 0, windingRule: "ODD" }];
networkVector.strokePaints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 255 }, visible: true, blendMode: "NORMAL" }];
networkVector.strokeWeight = 1;
var networkBlob = Buffer.alloc(64);
networkBlob.writeUInt32LE(2, 0); networkBlob.writeUInt32LE(1, 4); networkBlob.writeUInt32LE(0, 8);
networkBlob.writeUInt32LE(0, 12); networkBlob.writeFloatLE(0, 16); networkBlob.writeFloatLE(0, 20);
networkBlob.writeUInt32LE(0, 24); networkBlob.writeFloatLE(120, 28); networkBlob.writeFloatLE(0, 32);
networkBlob.writeUInt32LE(0, 36); networkBlob.writeUInt32LE(0, 40);
networkBlob.writeFloatLE(0, 44); networkBlob.writeFloatLE(0, 48);
networkBlob.writeUInt32LE(1, 52); networkBlob.writeFloatLE(0, 56); networkBlob.writeFloatLE(0, 60);
networkScene.blobs.push(networkBlob);
networkVector.vectorData = { vectorNetworkBlob: 1, normalizedSize: { x: 120, y: 0 } };
var networkFile = path.join(tempDir, "stroke-network.pix");
fs.writeFileSync(networkFile, Fixture.buildContainer({ build: networkScene }).zip);
var networkDoc = PixDocument.load(PixContainer.open(networkFile));
var networkIr = MigrationIR.build(networkDoc, { roots: [networkDoc.tree.byKey.get(ids.screenRoot)] });
var networkNode = networkIr.roots[0].nodes.filter(function (node) { return node.id === ids.vectorNode; })[0];
ok(networkNode.vectorPaths && networkNode.vectorPaths.length === 1, "vectorNetworkBlob restores stroke centerline geometry");
ok(/M 0 0 L 120 0/.test(networkNode.vectorPaths[0].data), "decoded centerline keeps exact line endpoints");
eq(networkNode.height, 0, "decoded centerline keeps zero-height source semantics");
ok(networkNode.strokes && networkNode.strokes.length === 1, "decoded centerline remains a stroke, not a fill outline");
eq(networkNode.fills.length, 0, "decoded stroke centerline does not invent a fill region");
ok(networkIr.stats.strokeOnlyVectorsNetworkDecoded >= 1, "vector-network centerline decoding is measured");

// BOOLEAN_OPERATION must remain an editable Figma boolean container rather
// than being flattened to its precomputed fillGeometry. This preserves source
// UNION/SUBTRACT/INTERSECT/EXCLUDE semantics and the operand tree.
var booleanScene = Fixture.buildScene();
var booleanVector = booleanScene.nodes.filter(function (node) { return node.guid.localID === 104; })[0];
booleanVector.type = "BOOLEAN_OPERATION";
booleanVector.name = "Subtract shape";
booleanVector.booleanOperation = "SUBTRACT";
booleanVector.fillPaints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 255 }, visible: true, blendMode: "NORMAL" }];
var boolOperandA = {
  guid: Fixture.guid("2:106"), type: "RECTANGLE", name: "Base",
  parentIndex: { guid: Fixture.guid("2:104"), position: "a" },
  transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  size: { x: 10, y: 10 }, fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 255 }, visible: true, blendMode: "NORMAL" }],
};
var boolOperandB = {
  guid: Fixture.guid("2:107"), type: "ELLIPSE", name: "Hole",
  parentIndex: { guid: Fixture.guid("2:104"), position: "b" },
  transform: { m00: 1, m01: 0, m02: 2, m10: 0, m11: 1, m12: 2 },
  size: { x: 6, y: 6 }, fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 255 }, visible: true, blendMode: "NORMAL" }],
};
booleanScene.nodes.push(boolOperandA, boolOperandB);
var booleanFile = path.join(tempDir, "boolean-operation.pix");
fs.writeFileSync(booleanFile, Fixture.buildContainer({ build: booleanScene }).zip);
var booleanDoc = PixDocument.load(PixContainer.open(booleanFile));
var booleanIr = MigrationIR.build(booleanDoc, { roots: [booleanDoc.tree.byKey.get(ids.screenRoot)] });
var booleanNode = booleanIr.roots[0].nodes.filter(function (node) { return node.id === ids.vectorNode; })[0];
eq(booleanNode.type, "BOOLEAN_OPERATION", "Pixso boolean operation remains a native boolean node");
eq(booleanNode.booleanOperation, "SUBTRACT", "boolean formula is preserved exactly");
eq(booleanIr.roots[0].nodes.filter(function (node) { return node.parent === ids.vectorNode; }).length, 2,
  "boolean operands remain editable children");
ok(!booleanIr.unsupported.FLATTENED_CHILDREN, "native boolean operands are no longer reported as flattened children");
ok(booleanIr.stats.booleanOperationsNative >= 1, "native boolean reconstruction is measured");

// Mask flags/types are source semantics, not inferred from names or geometry.
var maskScene = Fixture.buildScene();
var maskVector = maskScene.nodes.filter(function (node) { return node.guid.localID === 104; })[0];
maskVector.mask = true;
maskVector.maskType = "OUTLINE";
var maskFile = path.join(tempDir, "mask.pix");
fs.writeFileSync(maskFile, Fixture.buildContainer({ build: maskScene }).zip);
var maskDoc = PixDocument.load(PixContainer.open(maskFile));
var maskIr = MigrationIR.build(maskDoc, { roots: [maskDoc.tree.byKey.get(ids.screenRoot)] });
var maskNode = maskIr.roots[0].nodes.filter(function (node) { return node.id === ids.vectorNode; })[0];
eq(maskNode.isMask, true, "mask flag is preserved");
eq(maskNode.maskType, "VECTOR", "Pixso OUTLINE mask maps to Figma VECTOR mask");

var normalizer = PixNormalizer.createNormalizer();
ok(!normalizer.canOutlineStrokeGeometry({
  size: { x: 100, y: 100 }, strokeGeometry: [{}],
  strokePaints: [{ type: "GRADIENT_LINEAR", visible: true }], vectorData: { styleOverrideTable: [] },
}), "gradient stroke is not flattened into a fill outline");
ok(!normalizer.canOutlineStrokeGeometry({
  size: { x: 100, y: 100 }, strokeGeometry: [{}],
  strokePaints: [{ type: "SOLID", visible: true }],
  vectorData: { styleOverrideTable: [{ styleID: 3 }] },
}), "segment-styled vector network is not flattened into one paint");

// Root symbolOverride can be stale while the INSTANCE record itself already
// carries the resolved root appearance. The concrete occurrence must win.
var ownPaintScene = Fixture.buildScene();
var ownPaintOccurrence = ownPaintScene.nodes.filter(function (node) { return node.guid.localID === 102; })[0];
ownPaintOccurrence.fillPaints = [{ type: "SOLID", color: { r: 255, g: 255, b: 255, a: 255 }, visible: false, blendMode: "NORMAL" }];
var ownPaintFile = path.join(tempDir, "own-root-paint.pix");
fs.writeFileSync(ownPaintFile, Fixture.buildContainer({ build: ownPaintScene }).zip);
var ownPaintDoc = PixDocument.load(PixContainer.open(ownPaintFile));
var ownPaintIr = MigrationIR.build(ownPaintDoc, { roots: [ownPaintDoc.tree.byKey.get(ids.screenRoot)] });
var ownPaintNode = ownPaintIr.roots[0].nodes.filter(function (node) { return node.id === ids.overriddenInstance; })[0];
eq(ownPaintNode.fills.length, 0, "INSTANCE record hidden root fill remains visually authoritative");
var ownRootOp = (ownPaintNode.overrides || []).filter(function (entry) { return entry.path.length === 0; })[0];
ok(!ownRootOp || !ownRootOp.ops.fills, "stale root fill override cannot repaint the whole instance");

// Root visibility behaves like the other resolved INSTANCE appearance fields,
// except Pixso omits `visible` when the resolved value is the default true. A
// stale self-targeted symbolOverride must therefore not hide a visibly present
// occurrence merely because the occurrence record omits that default field.
var ownVisibilityScene = Fixture.buildScene();
var ownVisibilityOccurrence = ownVisibilityScene.nodes.filter(function (node) { return node.guid.localID === 102; })[0];
ownVisibilityOccurrence.componentPropRef = [{
  defID: Fixture.guid("4389:108"), zombieFallbackName: "Card visible",
  componentPropNodeField: "VISIBLE",
}];
ownVisibilityOccurrence.symbolData.symbolOverrides.push({
  guidPath: { guids: [Fixture.guid("2:20")] }, visible: false,
});
var ownVisibilityFile = path.join(tempDir, "own-root-visibility.pix");
fs.writeFileSync(ownVisibilityFile, Fixture.buildContainer({ build: ownVisibilityScene }).zip);
var ownVisibilityDoc = PixDocument.load(PixContainer.open(ownVisibilityFile));
var ownVisibilityIr = MigrationIR.build(ownVisibilityDoc, { roots: [ownVisibilityDoc.tree.byKey.get(ids.screenRoot)] });
var ownVisibilityNode = ownVisibilityIr.roots[0].nodes.filter(function (node) { return node.id === ids.overriddenInstance; })[0];
ok(ownVisibilityNode.visible !== false, "omitted INSTANCE visibility keeps the resolved default visible=true");
var ownVisibilityRootOp = (ownVisibilityNode.overrides || []).filter(function (entry) { return entry.path.length === 0; })[0];
ok(!ownVisibilityRootOp || ownVisibilityRootOp.ops.visible === undefined,
  "stale self-targeted visible=false cannot hide a resolved visible occurrence");

// Ошибка декодера не должна выглядеть как «просто пусто».
var truncated = path.join(tempDir, "truncated.pix");
var truncatedDocument = Fixture.encodeDocument(Fixture.buildScene().nodes, []).subarray(0, 40);
fs.writeFileSync(truncated, Fixture.zipStore([
  { name: "doc.pix", data: Fixture.wrapPayload(truncatedDocument, "none") },
  { name: "pixso.binary", data: Fixture.encodeSchema() },
]));
assert.throws(function () { PixDocument.load(PixContainer.open(truncated)); }, /Kiwi/, "обрыв данных даёт ошибку Kiwi");
checks += 1;

fs.rmSync(tempDir, { recursive: true, force: true });
process.stdout.write("OK: Direct PIX парсер и IR — " + checks + " проверок пройдено\n");
