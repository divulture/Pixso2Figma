/**
 * Синтетическая фикстура `.pix` для тестов Direct PIX.
 *
 * Файл собирается целиком в памяти: ZIP, бинарная схема Kiwi и документ.
 * Тест обязан проверять формат, а не конкретный документ пользователя —
 * поэтому здесь нет ни одного байта из реального `.pix`, и в схеме ровно те
 * определения и поля, которыми пользуется фикстура.
 *
 * Заодно это кодировщик Kiwi: он симметричен декодеру и ловит расхождения,
 * которые «просто разобралось без ошибок» не ловит.
 */
"use strict";

var zlib = require("zlib");

// ---------------------------------------------------------------------------
// Запись байтов
// ---------------------------------------------------------------------------

var FLOAT_BITS = new Uint32Array(1);
var FLOAT_VIEW = new Float32Array(FLOAT_BITS.buffer);

function Writer() {
  this.bytes = [];
}

Writer.prototype.byte = function (value) { this.bytes.push(value & 255); return this; };

Writer.prototype.varUint = function (value) {
  var current = value >>> 0;
  do {
    var part = current & 127;
    current >>>= 7;
    this.bytes.push(current ? part | 128 : part);
  } while (current);
  return this;
};

Writer.prototype.varInt = function (value) {
  return this.varUint(value < 0 ? ~value * 2 + 1 : value * 2);
};

Writer.prototype.varFloat = function (value) {
  if (value === 0) return this.byte(0);
  FLOAT_VIEW[0] = value;
  var bits = FLOAT_BITS[0];
  // Обратная перестановка к той, что делает декодер.
  bits = ((bits >>> 23) | (bits << 9)) >>> 0;
  this.bytes.push(bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255);
  return this;
};

Writer.prototype.string = function (text) {
  var buffer = Buffer.from(String(text), "utf8");
  for (var i = 0; i < buffer.length; i++) this.bytes.push(buffer[i]);
  this.bytes.push(0);
  return this;
};

Writer.prototype.buffer = function () { return Buffer.from(this.bytes); };

// ---------------------------------------------------------------------------
// Схема
// ---------------------------------------------------------------------------

var NATIVE = { bool: -1, byte: -2, int: -3, uint: -4, float: -5, string: -6, int64: -7, uint64: -8 };
var KIND_INDEX = { ENUM: 0, STRUCT: 1, MESSAGE: 2 };

/** Определения ровно в том виде, в каком их отдаёт настоящий `pixso.binary`. */
var SCHEMA = [
  { name: "PixsoMsgType", kind: "ENUM", fields: [["NODE_CHANGES", 2], ["FIC_DOCUMENT", 14]] },
  {
    name: "NodeType", kind: "ENUM", fields: [
      ["DOCUMENT", 2], ["CANVAS", 3], ["GROUP", 4], ["FRAME", 5], ["VECTOR", 7],
      ["BOOLEAN_OPERATION", 9], ["ELLIPSE", 10], ["RECTANGLE", 11], ["TEXT", 14], ["SYMBOL", 16], ["INSTANCE", 17],
      ["PROD_TABLE", 32],
    ],
  },
  { name: "PaintType", kind: "ENUM", fields: [["SOLID", 1], ["GRADIENT_LINEAR", 2], ["IMAGE", 6], ["PATTERN", 10]] },
  { name: "BlendMode", kind: "ENUM", fields: [["PASS_THROUGH", 1], ["NORMAL", 2], ["MULTIPLY", 4]] },
  { name: "StackMode", kind: "ENUM", fields: [["NONE", 1], ["HORIZONTAL", 2], ["VERTICAL", 3], ["GRID", 4]] },
  { name: "StackSize", kind: "ENUM", fields: [["FIXED", 1], ["RESIZE_TO_FIT", 2]] },
  { name: "StackAlignItemMode", kind: "ENUM", fields: [["MIN", 1], ["CENTER", 2], ["MAX", 3], ["SPACE_EVENLY", 4]] },
  { name: "StackCounterAlign", kind: "ENUM", fields: [["MIN", 1], ["CENTER", 2], ["MAX", 3], ["STRETCH", 4]] },
  { name: "ConstraintType", kind: "ENUM", fields: [["MIN", 1], ["CENTER", 2], ["MAX", 3], ["STRETCH", 4], ["FIXED_MIN", 6]] },
  { name: "StrokeAlign", kind: "ENUM", fields: [["CENTER", 1], ["INSIDE", 2], ["OUTSIDE", 3]] },
  { name: "StrokeJoin", kind: "ENUM", fields: [["MITER", 1], ["BEVEL", 2], ["ROUND", 3]] },
  { name: "StrokeCap", kind: "ENUM", fields: [["NONE", 1], ["ROUND", 2], ["TRIANGLE_FILLED", 6]] },
  { name: "EffectType", kind: "ENUM", fields: [["INNER_SHADOW", 1], ["DROP_SHADOW", 2], ["FOREGROUND_BLUR", 3], ["GRAIN", 7]] },
  { name: "WindingRule", kind: "ENUM", fields: [["NONZERO", 1], ["ODD", 2]] },
  { name: "BooleanOperation", kind: "ENUM", fields: [["UNION", 1], ["INTERSECT", 2], ["SUBTRACT", 3], ["EXCLUDE", 4]] },
  { name: "MaskType", kind: "ENUM", fields: [["ALPHA", 1], ["OUTLINE", 2], ["LUMINANCE", 3]] },
  { name: "TextAlignHorizontal", kind: "ENUM", fields: [["LEFT", 1], ["CENTER", 2], ["RIGHT", 3]] },
  { name: "TextAutoResize", kind: "ENUM", fields: [["NONE", 1], ["WIDTH_AND_HEIGHT", 2], ["HEIGHT", 3]] },
  // Нумерация повторяет схему настоящего `.pix`: у обрезания ЕСТЬ нулевое
  // значение, у авторазмера выше его нет. Различие не косметическое — от
  // него зависит, что означает отсутствие поля в записи.
  { name: "TextTruncation", kind: "ENUM", fields: [["DISABLED", 0], ["ENDING", 1]] },
  { name: "NumberUnits", kind: "ENUM", fields: [["RAW", 1], ["PIXELS", 2], ["PERCENT", 3]] },
  { name: "StyleType", kind: "ENUM", fields: [["FILL", 1], ["TEXT", 2], ["EFFECT", 3], ["STROKE", 4], ["GRID", 5]] },
  { name: "TextCase", kind: "ENUM", fields: [["ORIGINAL", 1], ["UPPER", 2], ["LOWER", 3]] },
  { name: "TextDecoration", kind: "ENUM", fields: [["NONE", 1], ["UNDERLINE", 2], ["STRIKETHROUGH", 3]] },

  { name: "GUID", kind: "STRUCT", fields: [["sessionID", "uint"], ["localID", "uint"]] },
  { name: "Vector", kind: "STRUCT", fields: [["x", "float"], ["y", "float"]] },
  { name: "Matrix", kind: "STRUCT", fields: [["m00", "float"], ["m01", "float"], ["m02", "float"], ["m10", "float"], ["m11", "float"], ["m12", "float"]] },
  { name: "Color", kind: "STRUCT", fields: [["r", "float"], ["g", "float"], ["b", "float"], ["a", "float"]] },

  { name: "ParentIndex", kind: "MESSAGE", fields: [["guid", "GUID"], ["position", "string"]] },
  { name: "GUIDPath", kind: "MESSAGE", fields: [["guids", "GUID", true]] },
  { name: "ColorStop", kind: "MESSAGE", fields: [["color", "Color"], ["position", "float"]] },
  { name: "ImageMessage", kind: "MESSAGE", fields: [["hash", "byte", true], ["name", "string"]] },
  {
    name: "Paint", kind: "MESSAGE", fields: [
      ["type", "PaintType"], ["color", "Color"], ["opacity", "float"], ["visible", "bool"],
      ["blendMode", "BlendMode"], ["stops", "ColorStop", true], ["transform", "Matrix"],
      ["image", "ImageMessage"],
    ],
  },
  { name: "Path", kind: "MESSAGE", fields: [["blobIndex", "int"], ["windingRule", "WindingRule"]] },
  // Таблица красок регионов вектора: у настоящего документа `regionId`
  // адресует позицию пути в `fillGeometry`.
  { name: "VectorPaint", kind: "MESSAGE", fields: [["regionId", "int"], ["paints", "Paint", true]] },
  { name: "VectorStyle", kind: "MESSAGE", fields: [["regionId", "int"], ["id", "GUID"]] },
  { name: "VectorData", kind: "MESSAGE", fields: [["vectorNetworkBlob", "int"], ["normalizedSize", "Vector"]] },
  {
    name: "Effect", kind: "MESSAGE", fields: [
      ["type", "EffectType"], ["color", "Color"], ["offset", "Vector"], ["radius", "float"],
      ["visible", "bool"], ["blendMode", "BlendMode"], ["spread", "float"],
    ],
  },
  { name: "FontName", kind: "MESSAGE", fields: [["family", "string"], ["style", "string"]] },
  // Общая идентичность стиля. Настоящий `.pix` несёт её у каждого узла-стиля:
  // именно `styleKey` связывает десятки копий одного стиля дизайн-системы.
  { name: "SharedStyleReference", kind: "MESSAGE", fields: [["styleKey", "string"], ["versionHash", "string"]] },
  { name: "Number", kind: "MESSAGE", fields: [["value", "float"], ["units", "NumberUnits"]] },
  { name: "TextStyleData", kind: "MESSAGE", fields: [["styleID", "int"], ["fontSize", "float"], ["fontName", "FontName"], ["letterSpacing", "Number"], ["lineHeight", "Number"], ["textCase", "TextCase"], ["textDecoration", "TextDecoration"], ["fillPaints", "Paint", true], ["paragraphSpacing", "float"], ["paragraphIndent", "float"]] },
  {
    name: "Glyph", kind: "MESSAGE", fields: [
      ["blobIndex", "int"], ["position", "Vector"], ["styleID", "int"],
      ["fontSize", "float"], ["firstCharacter", "int"], ["advance", "float"],
    ],
  },
  {
    name: "TextData", kind: "MESSAGE", fields: [
      ["characters", "string"], ["characterStyleIDs", "int", true],
      ["styleOverrideTable", "TextStyleData", true], ["glyphs", "Glyph", true],
    ],
  },
  {
    name: "ComponentPropValue", kind: "MESSAGE", fields: [
      ["boolValue", "bool"], ["guidValue", "GUID"], ["textValue", "TextData"],
    ],
  },
  {
    // `parentPropDefId` — ссылка локального определения варианта на публичное
    // определение группы состояний. Ровно это поле несёт идентичность
    // свойства: без него локальные псевдонимы вариантов ничем не связаны.
    name: "ComponentPropDef", kind: "MESSAGE", fields: [
      ["id", "GUID"], ["name", "string"], ["type", "string"], ["parentPropDefId", "GUID"],
      ["initialValue", "ComponentPropValue"],
    ],
  },
  { name: "ComponentPropAssignment", kind: "MESSAGE", fields: [["defID", "GUID"], ["value", "ComponentPropValue"]] },
  // Словарь осей и значений группы состояний в ИСХОДНОМ порядке. Единственный
  // авторитетный источник variant-координаты в формате `.pix`: типа свойства
  // VARIANT в схеме нет.
  {
    name: "PropValueData", kind: "MESSAGE", fields: [
      ["property", "string"], ["values", "string", true],
      ["aliasProperty", "string"], ["aliasValues", "string", true],
    ],
  },
  // Узел объявляет, какое из его полей читается из свойства компонента.
  {
    name: "ComponentPropRef", kind: "MESSAGE", fields: [
      ["defID", "GUID"], ["componentPropNodeField", "string"],
    ],
  },
  { name: "SymbolData", kind: "MESSAGE", fields: [["symbolID", "GUID"], ["symbolOverrides", "PixsoNode", true]] },
  { name: "Blob", kind: "MESSAGE", fields: [["bytes", "byte", true]] },
  {
    name: "PixsoNode", kind: "MESSAGE", fields: [
      ["guid", "GUID"], ["guidPath", "GUIDPath"], ["parentIndex", "ParentIndex"],
      ["transform", "Matrix"], ["type", "NodeType"], ["name", "string"],
      ["vectorData", "VectorData"], ["visible", "bool"], ["size", "Vector"],
      ["blendMode", "BlendMode"], ["cornerRadius", "float"], ["opacity", "float"],
      ["effects", "Effect", true], ["fillGeometry", "Path", true], ["strokeGeometry", "Path", true], ["fillPaints", "Paint", true],
      ["vectorPaints", "VectorPaint", true], ["vectorStyles", "VectorStyle", true],
      ["stackMode", "StackMode"], ["stackSpacing", "float"], ["stackPrimarySizing", "StackSize"],
      ["stackCounterSizing", "StackSize"], ["stackPrimaryAlignItems", "StackAlignItemMode"],
      ["stackCounterAlignItems", "StackAlignItemMode"], ["stackCounterAlign", "StackCounterAlign"],
      ["stackChildPrimarySizing", "StackSize"], ["stackChildCounterSizing", "StackSize"],
      ["stackPaddingLeft", "float"], ["stackPaddingTop", "float"],
      ["strokeAlign", "StrokeAlign"], ["strokeCap", "StrokeCap"], ["strokeJoin", "StrokeJoin"],
      ["strokePaints", "Paint", true], ["strokeWeight", "float"], ["styleType", "StyleType"],
      ["symbolData", "SymbolData"], ["mask", "bool"], ["maskType", "MaskType"], ["booleanOperation", "BooleanOperation"],
      ["fontName", "FontName"], ["fontSize", "float"], ["textAlignHorizontal", "TextAlignHorizontal"],
      ["textAutoResize", "TextAutoResize"], ["textData", "TextData"], ["lineHeight", "Number"],
      ["horizontalConstraint", "ConstraintType"], ["verticalConstraint", "ConstraintType"],
      ["derivedSymbolData", "PixsoNode", true], ["componentKey", "string"],
      ["publishFile", "string"], ["publishID", "GUID"], ["publishedVersion", "int"], ["version", "int"],
      ["inheritFillStyleID", "GUID"], ["overriddenSymbolID", "GUID"], ["overrideKey", "GUID"],
      ["propsAreBubbled", "bool"],
      ["isStateGroup", "bool"], ["stateGroupPropertyValueOrders", "PropValueData", true],
      ["componentPropDef", "ComponentPropDef", true],
      ["componentPropAssignment", "ComponentPropAssignment", true],
      ["componentPropRef", "ComponentPropRef", true],
      ["frameMaskDisabled", "bool"], ["locked", "bool"], ["exportSettings", "int", true],
      ["internalOnly", "bool"],
      ["sharedStyleReference", "SharedStyleReference"], ["styleDescription", "string"],
      ["isSoftDeletedStyle", "bool"], ["inheritGridStyleID", "GUID"],
      // Поля, документированные спецификациями как содержимое
      // `symbolOverrides[]`: без них тесты не могли бы проверить перенос
      // углов, стилей, обводки, auto layout и типографики вхождения.
      ["rectangleTopLeftCornerRadius", "float"], ["rectangleTopRightCornerRadius", "float"],
      ["rectangleBottomLeftCornerRadius", "float"], ["rectangleBottomRightCornerRadius", "float"],
      ["rectangleCornerRadiiIndependent", "bool"], ["rectangleCornerToolIndependent", "bool"],
      ["inheritStrokeStyleID", "GUID"], ["inheritEffectStyleID", "GUID"], ["inheritTextStyleID", "GUID"],
      ["borderTopWeight", "float"], ["borderRightWeight", "float"],
      ["borderBottomWeight", "float"], ["borderLeftWeight", "float"],
      ["borderStrokeWeightsIndependent", "bool"],
      ["autoLayoutAbsolutePos", "bool"], ["stackPaddingRight", "float"], ["stackPaddingBottom", "float"],
      // Границы размера auto layout: ими Pixso удерживает HUG-контейнер на
      // размере больше содержимого.
      ["minSize", "Vector"], ["maxSize", "Vector"],
      ["textCase", "TextCase"], ["textDecoration", "TextDecoration"],
      ["textTruncation", "TextTruncation"], ["maxLines", "int"], ["leadingTrim", "string"], ["hangingPunctuation", "bool"], ["hangingList", "bool"], ["proportionsConstrained", "bool"],
      ["letterSpacing", "Number"], ["paragraphSpacing", "float"],
      ["stackChildPrimarySizing", "StackSize"],
      // Признак символа, вынесенного на служебное полотно.
      ["ancestorPathBeforeDeletion", "GUID", true],
    ],
  },
  {
    name: "PixsoMsg", kind: "MESSAGE", fields: [
      ["type", "PixsoMsgType"], ["sessionID", "int"], ["pixsoNodes", "PixsoNode", true],
      ["blobs", "Blob", true], ["createVersion", "string"],
    ],
  },
];

function buildSchemaIndex() {
  var byName = Object.create(null);
  SCHEMA.forEach(function (definition, index) { byName[definition.name] = { index: index, definition: definition }; });
  return byName;
}

var SCHEMA_INDEX = buildSchemaIndex();

function typeCode(name) {
  if (NATIVE[name] !== undefined) return NATIVE[name];
  var entry = SCHEMA_INDEX[name];
  if (!entry) throw new Error("Фикстура: в схеме нет типа " + name);
  return entry.index;
}

function encodeSchema() {
  var writer = new Writer();
  writer.varUint(SCHEMA.length);
  SCHEMA.forEach(function (definition) {
    writer.string(definition.name);
    writer.byte(KIND_INDEX[definition.kind]);
    writer.varUint(definition.fields.length);
    definition.fields.forEach(function (field, position) {
      if (definition.kind === "ENUM") {
        writer.string(field[0]);
        writer.varInt(0);
        writer.byte(0);
        writer.varUint(field[1]);
        return;
      }
      writer.string(field[0]);
      writer.varInt(typeCode(field[1]));
      writer.byte(field[2] ? 1 : 0);
      writer.varUint(position + 1);
    });
  });
  return writer.buffer();
}

// ---------------------------------------------------------------------------
// Кодирование значений
// ---------------------------------------------------------------------------

function enumValue(typeName, name) {
  var entry = SCHEMA_INDEX[typeName];
  for (var i = 0; i < entry.definition.fields.length; i++) {
    if (entry.definition.fields[i][0] === name) return entry.definition.fields[i][1];
  }
  throw new Error("Фикстура: в перечислении " + typeName + " нет " + name);
}

function writeScalar(writer, typeName, value) {
  switch (typeName) {
    case "bool": return writer.byte(value ? 1 : 0);
    case "byte": return writer.byte(value);
    case "int": return writer.varInt(value);
    case "uint": return writer.varUint(value);
    case "float": return writer.varFloat(value);
    case "string": return writer.string(value);
    default: break;
  }
  var entry = SCHEMA_INDEX[typeName];
  if (!entry) throw new Error("Фикстура: неизвестный тип " + typeName);
  if (entry.definition.kind === "ENUM") return writer.varUint(enumValue(typeName, value));
  if (entry.definition.kind === "STRUCT") return writeStruct(writer, typeName, value);
  return writeMessage(writer, typeName, value);
}

function writeField(writer, field, value) {
  if (!field[2]) return writeScalar(writer, field[1], value);
  writer.varUint(value.length);
  for (var i = 0; i < value.length; i++) writeScalar(writer, field[1], value[i]);
}

function writeStruct(writer, typeName, value) {
  var definition = SCHEMA_INDEX[typeName].definition;
  definition.fields.forEach(function (field) {
    writeField(writer, field, value[field[0]]);
  });
}

function writeMessage(writer, typeName, value) {
  var definition = SCHEMA_INDEX[typeName].definition;
  definition.fields.forEach(function (field, position) {
    var fieldValue = value[field[0]];
    if (fieldValue === undefined) return;
    writer.varUint(position + 1);
    writeField(writer, field, fieldValue);
  });
  writer.byte(0);
}

// ---------------------------------------------------------------------------
// Конструкторы значений
// ---------------------------------------------------------------------------

function guid(id) {
  var parts = String(id).split(":");
  return { sessionID: Number(parts[0]), localID: Number(parts[1]) };
}

function color(r, g, b, a) {
  return { r: r, g: g, b: b, a: a === undefined ? 255 : a };
}

function transform(x, y) {
  return { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y };
}

function solid(r, g, b) {
  return { type: "SOLID", color: color(r, g, b), visible: true, blendMode: "NORMAL" };
}

/** Бинарный путь: те же опкоды, что и в настоящем документе. */
function pathBlob(commands) {
  var writer = new Writer();
  commands.forEach(function (command) {
    writer.byte(command[0]);
    for (var i = 1; i < command.length; i++) {
      var bits = new Uint32Array(1);
      var view = new Float32Array(bits.buffer);
      view[0] = command[i];
      writer.bytes.push(bits[0] & 255, (bits[0] >>> 8) & 255, (bits[0] >>> 16) & 255, (bits[0] >>> 24) & 255);
    }
  });
  return writer.buffer();
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

function zipStore(entries) {
  var locals = [];
  var central = [];
  var offset = 0;

  entries.forEach(function (entry) {
    var name = Buffer.from(entry.name, "utf8");
    var data = entry.data;
    var crc = crc32(data);
    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    var record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += 30 + name.length + data.length;
  });

  var localBuffer = Buffer.concat(locals);
  var centralBuffer = Buffer.concat(central);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localBuffer.length, 16);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var i = 0; i < 256; i++) {
    var value = i;
    for (var bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  var crc = -1;
  for (var i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// Сборка документа
// ---------------------------------------------------------------------------

function encodeDocument(nodes, blobs) {
  var writer = new Writer();
  writeMessage(writer, "PixsoMsg", {
    type: "FIC_DOCUMENT",
    sessionID: 2,
    pixsoNodes: nodes,
    blobs: (blobs || []).map(function (bytes) { return { bytes: Array.from(bytes) }; }),
    createVersion: "fixture",
  });
  return writer.buffer();
}

/**
 * Payload с заголовком настоящего формата. zstd используется, когда он есть
 * в сборке Node: путь распаковки тоже должен проверяться, а не только «none».
 */
function wrapPayload(document, codec) {
  var body = document;
  var tag = "compress:none";
  if (codec === "zstd" && typeof zlib.zstdCompressSync === "function") {
    body = zlib.zstdCompressSync(document);
    tag = "compress:zstd";
  }
  var head = Buffer.concat([
    Buffer.from("pixso-kw\u0000", "latin1"),
    Buffer.from([2, tag.length]),
    Buffer.from(tag, "latin1"),
  ]);
  return Buffer.concat([head, body]);
}

function png(seed) {
  // Минимально валидная сигнатура: содержимое ассета Direct PIX не разбирает,
  // он переносит байты как есть.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([seed & 255, (seed >> 8) & 255]),
  ]);
}

function buildContainer(options) {
  options = options || {};
  var built = options.build || buildScene();
  var payload = wrapPayload(encodeDocument(built.nodes, built.blobs), options.codec || "zstd");
  var entries = [
    { name: "abc123.thumb.png", data: png(1) },
    { name: options.documentName || "Тестовый документ.pix", data: payload },
    { name: "VERSION", data: Buffer.from(JSON.stringify({ app_version: "v3.0.0.0", kiwi_version: "v10.01" })) },
    { name: "pixso.binary", data: encodeSchema() },
  ];
  (built.resources || []).forEach(function (resource) {
    entries.splice(2, 0, { name: resource.id + ".png", data: resource.data });
  });
  return { zip: zipStore(entries), scene: built };
}

/**
 * Сцена фикстуры.
 *
 *   DOCUMENT
 *     CANVAS «Библиотека»          — символы (аналог служебного канваса Pixso)
 *       SYMBOL Icon                — вложенный компонент
 *       FRAME Кнопка (state group)
 *         SYMBOL Кнопка/обычная    — содержит TEXT и INSTANCE Icon
 *         SYMBOL Кнопка/нажатая    — тот же componentKey, другое состояние
 *       RECTANGLE стиля FILL       — локальный стиль документа
 *     CANVAS «Экран»
 *       FRAME Экран (auto layout)
 *         INSTANCE Кнопки ×2       — второй с override текста и заливки
 *         RECTANGLE с изображением
 *         VECTOR с геометрией
 *         PROD_TABLE               — тип, который Direct PIX не строит
 */
function buildScene() {
  var geometry = pathBlob([[1, 0, 0], [2, 10, 0], [2, 10, 10], [0]]);
  var nodes = [];
  var iconGuid = "2:20";
  var stateGroupGuid = "2:30";
  var buttonNormalGuid = "2:31";
  var buttonPressedGuid = "2:40";
  var styleGuid = "2:50";

  function node(spec) { nodes.push(spec); return spec; }

  node({ guid: guid("2:1"), type: "DOCUMENT", name: "Документ" });
  node({ guid: guid("2:2"), type: "CANVAS", name: "Библиотека", parentIndex: { guid: guid("2:1"), position: "a" } });
  node({ guid: guid("2:3"), type: "CANVAS", name: "Экран", parentIndex: { guid: guid("2:1"), position: "b" } });

  // --- Библиотека
  node({
    guid: guid(iconGuid), type: "SYMBOL", name: "Иконка", componentKey: "key-icon",
    parentIndex: { guid: guid("2:2"), position: "a" },
    transform: transform(0, 0), size: { x: 16, y: 16 }, fillPaints: [],
  });
  node({
    guid: guid("2:21"), type: "VECTOR", name: "Контур",
    parentIndex: { guid: guid(iconGuid), position: "a" },
    transform: transform(0, 0), size: { x: 16, y: 16 },
    fillPaints: [solid(0, 0, 0)],
    fillGeometry: [{ blobIndex: 0, windingRule: "NONZERO" }],
  });

  node({
    guid: guid(stateGroupGuid), type: "FRAME", name: "Кнопка", isStateGroup: true,
    parentIndex: { guid: guid("2:2"), position: "b" },
    transform: transform(0, 100), size: { x: 200, y: 100 },
  });
  node({
    guid: guid(buttonNormalGuid), type: "SYMBOL", name: "state=normal", componentKey: "key-button",
    parentIndex: { guid: guid(stateGroupGuid), position: "a" },
    transform: transform(0, 0), size: { x: 120, y: 40 },
    fillPaints: [solid(255, 255, 255)], cornerRadius: 8,
    stackMode: "HORIZONTAL", stackSpacing: 8, stackPaddingLeft: 12, stackPaddingTop: 6,
    stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED",
    stackPrimaryAlignItems: "CENTER", stackCounterAlignItems: "CENTER",
  });
  node({
    guid: guid("2:32"), type: "TEXT", name: "Подпись",
    parentIndex: { guid: guid(buttonNormalGuid), position: "a" },
    transform: transform(12, 10), size: { x: 60, y: 20 },
    fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
    textAlignHorizontal: "LEFT", textAutoResize: "WIDTH_AND_HEIGHT",
    textData: { characters: "Кнопка" },
    fillPaints: [solid(20, 20, 20)],
    stackCounterAlign: "STRETCH",
  });
  node({
    guid: guid("2:33"), type: "INSTANCE", name: "Иконка",
    parentIndex: { guid: guid(buttonNormalGuid), position: "b" },
    transform: transform(80, 12), size: { x: 16, y: 16 },
    symbolData: { symbolID: guid(iconGuid) },
  });
  node({
    guid: guid(buttonPressedGuid), type: "SYMBOL", name: "state=pressed", componentKey: "key-button",
    parentIndex: { guid: guid(stateGroupGuid), position: "b" },
    transform: transform(0, 50), size: { x: 120, y: 40 },
    fillPaints: [solid(0, 90, 200)], cornerRadius: 8,
  });
  node({
    guid: guid(styleGuid), type: "RECTANGLE", name: "brand/primary", styleType: "FILL",
    parentIndex: { guid: guid("2:2"), position: "c" },
    fillPaints: [solid(255, 0, 80)],
  });

  // --- Экран
  node({
    guid: guid("2:100"), type: "FRAME", name: "Экран",
    parentIndex: { guid: guid("2:3"), position: "a" },
    transform: transform(0, 0), size: { x: 400, y: 300 },
    fillPaints: [solid(245, 245, 245)],
    stackMode: "VERTICAL", stackSpacing: 12, stackPaddingLeft: 16, stackPaddingTop: 16,
    effects: [{ type: "DROP_SHADOW", color: color(0, 0, 0, 64), offset: { x: 0, y: 2 }, radius: 6, visible: true, blendMode: "NORMAL", spread: 0 }],
    horizontalConstraint: "MIN", verticalConstraint: "MIN",
  });
  node({
    guid: guid("2:101"), type: "INSTANCE", name: "Кнопка",
    parentIndex: { guid: guid("2:100"), position: "a" },
    transform: transform(16, 16), size: { x: 120, y: 40 },
    symbolData: { symbolID: guid(buttonNormalGuid) },
  });
  node({
    guid: guid("2:102"), type: "INSTANCE", name: "Кнопка изменённая",
    parentIndex: { guid: guid("2:100"), position: "b" },
    transform: transform(16, 68), size: { x: 160, y: 40 },
    symbolData: {
      symbolID: guid(buttonNormalGuid),
      symbolOverrides: [
        // Текст внутри определения: доказуемая операция.
        { guidPath: { guids: [guid("2:32")] }, textData: { characters: "Отправить" } },
        // Заливка корня инстанса.
        { guidPath: { guids: [guid(buttonNormalGuid)] }, fillPaints: [solid(0, 120, 255)] },
        // Поле, которое первая версия не применяет: обязано попасть в отчёт.
        { guidPath: { guids: [guid(buttonNormalGuid)] }, exportSettings: [1] },
        // Путь без адреса: тоже обязан быть посчитан, а не угадан.
        { guidPath: { guids: [] }, fillPaints: [solid(1, 2, 3)] },
      ],
    },
  });
  node({
    guid: guid("2:103"), type: "RECTANGLE", name: "Картинка",
    parentIndex: { guid: guid("2:100"), position: "c" },
    transform: transform(16, 120), size: { x: 100, y: 60 },
    fillPaints: [{ type: "IMAGE", visible: true, blendMode: "NORMAL", image: { hash: [0xab, 0xcd, 0xef], name: "photo" } }],
  });
  node({
    guid: guid("2:104"), type: "VECTOR", name: "Галочка",
    parentIndex: { guid: guid("2:100"), position: "d" },
    transform: transform(16, 190), size: { x: 10, y: 10 },
    fillPaints: [solid(0, 0, 0)],
    fillGeometry: [{ blobIndex: 0, windingRule: "ODD" }],
  });
  node({
    guid: guid("2:105"), type: "PROD_TABLE", name: "Прототипная таблица",
    parentIndex: { guid: guid("2:100"), position: "e" },
    transform: transform(200, 16), size: { x: 100, y: 100 },
  });

  return {
    nodes: nodes,
    blobs: [geometry],
    resources: [{ id: "abcdef", data: png(2) }],
    ids: {
      libraryCanvas: "2:2", screenCanvas: "2:3", screenRoot: "2:100",
      icon: iconGuid, stateGroup: stateGroupGuid,
      buttonNormal: buttonNormalGuid, buttonPressed: buttonPressedGuid,
      overriddenInstance: "2:102", plainInstance: "2:101",
      unsupportedNode: "2:105", imageNode: "2:103", vectorNode: "2:104",
      text: "2:32", styleNode: styleGuid,
    },
  };
}

module.exports = {
  buildContainer: buildContainer,
  buildScene: buildScene,
  encodeSchema: encodeSchema,
  encodeDocument: encodeDocument,
  wrapPayload: wrapPayload,
  zipStore: zipStore,
  pathBlob: pathBlob,
  guid: guid,
  Writer: Writer,
};
