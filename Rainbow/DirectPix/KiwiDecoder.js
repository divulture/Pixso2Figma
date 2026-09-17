/**
 * Kiwi decoder.
 *
 * Pixso хранит документ в формате Kiwi (evanw/kiwi): схема лежит в контейнере
 * отдельным файлом `pixso.binary`, данные — в бинарном payload. Декодер здесь
 * schema-driven: никаких зашитых offset-ов и никаких предположений о конкретном
 * документе. Меняется схема — меняется разбор, код остаётся прежним.
 *
 * Зависимостей нет: модуль работает на стандартной библиотеке Node.
 */
"use strict";

/** Порядок соответствует кодировке типа в схеме: индекс = ~type. */
var NATIVE_TYPES = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];
var KINDS = ["ENUM", "STRUCT", "MESSAGE"];

var FLOAT_BITS = new Uint32Array(1);
var FLOAT_VIEW = new Float32Array(FLOAT_BITS.buffer);

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

/**
 * Курсор по буферу. Отдельный объект, а не замыкание: индекс читается снаружи
 * (нам нужны байтовые offset-ы узлов для последующего random access).
 */
function ByteReader(buffer, index) {
  this.data = buffer;
  this.index = index || 0;
}

ByteReader.prototype.byte = function () {
  if (this.index >= this.data.length) throw new Error("Kiwi: чтение за концом буфера");
  return this.data[this.index++];
};

ByteReader.prototype.bool = function () {
  return !!this.byte();
};

ByteReader.prototype.varUint = function () {
  var value = 0;
  var shift = 0;
  var current;
  do {
    if (this.index >= this.data.length) throw new Error("Kiwi: обрыв varuint");
    current = this.data[this.index++];
    if (shift < 32) value |= (current & 127) << shift;
    shift += 7;
  } while (current & 128);
  return value >>> 0;
};

ByteReader.prototype.varInt = function () {
  var value = this.varUint();
  return value & 1 ? ~(value >>> 1) : value >>> 1;
};

ByteReader.prototype.varUint64 = function () {
  var value = 0n;
  var shift = 0n;
  var current;
  do {
    if (this.index >= this.data.length) throw new Error("Kiwi: обрыв varuint64");
    current = this.data[this.index++];
    value |= BigInt(current & 127) << shift;
    shift += 7n;
  } while (current & 128);
  return value;
};

ByteReader.prototype.varInt64 = function () {
  var value = this.varUint64();
  return value & 1n ? ~(value >> 1n) : value >> 1n;
};

/**
 * Kiwi хранит float «повёрнутым»: нулевой байт — это ровно 0.0, иначе четыре
 * байта little-endian с перенесённой экспонентой.
 */
ByteReader.prototype.varFloat = function () {
  if (this.index >= this.data.length) throw new Error("Kiwi: обрыв float");
  var first = this.data[this.index];
  if (first === 0) {
    this.index += 1;
    return 0;
  }
  if (this.index + 4 > this.data.length) throw new Error("Kiwi: обрыв float32");
  var bits =
    first |
    (this.data[this.index + 1] << 8) |
    (this.data[this.index + 2] << 16) |
    (this.data[this.index + 3] << 24);
  this.index += 4;
  bits = (bits << 23) | (bits >>> 9);
  FLOAT_BITS[0] = bits >>> 0;
  return FLOAT_VIEW[0];
};

ByteReader.prototype.string = function () {
  var start = this.index;
  while (this.index < this.data.length && this.data[this.index] !== 0) this.index++;
  if (this.index >= this.data.length) throw new Error("Kiwi: незавершённая строка");
  var text = this.data.toString("utf8", start, this.index);
  this.index += 1;
  return text;
};

ByteReader.prototype.skipString = function () {
  while (this.index < this.data.length && this.data[this.index] !== 0) this.index++;
  if (this.index >= this.data.length) throw new Error("Kiwi: незавершённая строка");
  this.index += 1;
};

// ---------------------------------------------------------------------------
// Схема
// ---------------------------------------------------------------------------

/**
 * Разбирает бинарную схему Kiwi (`pixso.binary`).
 *
 * definitions: varuint
 *   name: string, kind: byte, fields: varuint
 *     name: string, type: varint, flags: byte, value: varuint
 */
function decodeSchema(buffer) {
  var reader = new ByteReader(buffer, 0);
  var count = reader.varUint();
  if (!count || count > 100000) {
    throw new Error("Не похоже на бинарную схему Kiwi: заявлено определений — " + count);
  }
  var definitions = [];
  for (var i = 0; i < count; i++) {
    var name = reader.string();
    var kindIndex = reader.byte();
    var kind = KINDS[kindIndex];
    if (!kind) throw new Error("Схема: неизвестный kind " + kindIndex + " у «" + name + "»");
    var fieldCount = reader.varUint();
    var fields = [];
    var byId = Object.create(null);
    var byName = Object.create(null);
    for (var j = 0; j < fieldCount; j++) {
      var field = {
        name: reader.string(),
        type: reader.varInt(),
        isArray: !!(reader.byte() & 1),
        value: reader.varUint(),
      };
      fields.push(field);
      byId[field.value] = field;
      byName[field.name] = field;
    }
    definitions.push({ index: i, name: name, kind: kind, fields: fields, byId: byId, byName: byName });
  }

  var byName = Object.create(null);
  for (var d = 0; d < definitions.length; d++) byName[definitions[d].name] = definitions[d];

  return {
    definitions: definitions,
    byName: byName,
    /** Человекочитаемое имя типа поля — только для диагностики и отчётов. */
    typeName: function (type) {
      if (type < 0) return NATIVE_TYPES[~type] || ("native" + type);
      var def = definitions[type];
      return def ? def.name : "def#" + type;
    },
    require: function (name) {
      var def = byName[name];
      if (!def) throw new Error("В схеме документа нет определения «" + name + "»");
      return def;
    },
  };
}

// ---------------------------------------------------------------------------
// Значения
// ---------------------------------------------------------------------------

function Codec(schema) {
  this.schema = schema;
  /** enum-индекс: definitionIndex -> { value: name }. Строится лениво. */
  this.enums = Object.create(null);
}

Codec.prototype.enumMap = function (definition) {
  var cached = this.enums[definition.index];
  if (cached) return cached;
  var map = Object.create(null);
  for (var i = 0; i < definition.fields.length; i++) {
    map[definition.fields[i].value] = definition.fields[i].name;
  }
  this.enums[definition.index] = map;
  return map;
};

/** Читает одно скалярное значение указанного типа. */
Codec.prototype.readScalar = function (reader, type, options) {
  if (type < 0) {
    switch (type) {
      case -1: return reader.bool();
      case -2: return reader.byte();
      case -3: return reader.varInt();
      case -4: return reader.varUint();
      case -5: return reader.varFloat();
      case -6: return reader.string();
      case -7: return reader.varInt64();
      case -8: return reader.varUint64();
      default: throw new Error("Kiwi: неизвестный встроенный тип " + type);
    }
  }
  var definition = this.schema.definitions[type];
  if (!definition) throw new Error("Kiwi: ссылка на несуществующее определение " + type);
  if (definition.kind === "ENUM") {
    var raw = reader.varUint();
    var name = this.enumMap(definition)[raw];
    // Значение из более новой версии Pixso: возвращаем сырое, а не падаем.
    return name === undefined ? raw : name;
  }
  if (definition.kind === "STRUCT") return this.readStruct(reader, definition, options);
  return this.readMessage(reader, definition, options);
};

Codec.prototype.skipScalar = function (reader, type) {
  if (type < 0) {
    switch (type) {
      case -1: case -2: reader.index += 1; return;
      case -3: case -4: reader.varUint(); return;
      case -5: reader.varFloat(); return;
      case -6: reader.skipString(); return;
      case -7: case -8: reader.varUint64(); return;
      default: throw new Error("Kiwi: неизвестный встроенный тип " + type);
    }
  }
  var definition = this.schema.definitions[type];
  if (!definition) throw new Error("Kiwi: ссылка на несуществующее определение " + type);
  if (definition.kind === "ENUM") { reader.varUint(); return; }
  if (definition.kind === "STRUCT") { this.skipStruct(reader, definition); return; }
  this.skipMessage(reader, definition);
};

Codec.prototype.readField = function (reader, field, options) {
  if (!field.isArray) return this.readScalar(reader, field.type, options);
  var length = reader.varUint();
  // byte[] — это blob: держим его Buffer-ом, а не массивом чисел.
  if (field.type === -2) {
    if (reader.index + length > reader.data.length) throw new Error("Kiwi: обрыв byte[]");
    var slice = reader.data.subarray(reader.index, reader.index + length);
    reader.index += length;
    return slice;
  }
  var out = new Array(length);
  for (var i = 0; i < length; i++) out[i] = this.readScalar(reader, field.type, options);
  return out;
};

Codec.prototype.skipField = function (reader, field) {
  if (!field.isArray) return this.skipScalar(reader, field.type);
  var length = reader.varUint();
  if (field.type === -2) {
    reader.index += length;
    if (reader.index > reader.data.length) throw new Error("Kiwi: обрыв byte[]");
    return;
  }
  for (var i = 0; i < length; i++) this.skipScalar(reader, field.type);
};

Codec.prototype.readStruct = function (reader, definition, options) {
  var out = {};
  for (var i = 0; i < definition.fields.length; i++) {
    var field = definition.fields[i];
    out[field.name] = this.readField(reader, field, options);
  }
  return out;
};

Codec.prototype.skipStruct = function (reader, definition) {
  for (var i = 0; i < definition.fields.length; i++) this.skipField(reader, definition.fields[i]);
};

/**
 * Message: последовательность (id, значение) до нулевого id.
 *
 * options.only — карта `имя определения -> Set имён полей`: берём только их.
 * options.skip — карта `имя определения -> Set имён полей`: берём всё, кроме них.
 *
 * Поля вне набора структурно пропускаются. Полный разбор документа на 17 МБ
 * породил бы сотни мегабайт объектов, а анализатору нужно полтора десятка
 * полей; миграции — всё, кроме заведомо тяжёлых (`derivedSymbolData`, глифы).
 */
Codec.prototype.readMessage = function (reader, definition, options) {
  var only = options && options.only ? options.only[definition.name] : null;
  var skip = options && options.skip ? options.skip[definition.name] : null;
  var out = {};
  for (;;) {
    var id = reader.varUint();
    if (id === 0) return out;
    var field = definition.byId[id];
    if (!field) {
      // Поле из более новой схемы, чем та, что лежит в контейнере. Пропустить
      // его нельзя — Kiwi не хранит длину. Молча оборвать разбор тем более.
      throw new Error(
        "Kiwi: поле " + id + " отсутствует в определении «" + definition.name + "»"
      );
    }
    if ((only && !only.has(field.name)) || (skip && skip.has(field.name))) {
      this.skipField(reader, field);
      continue;
    }
    out[field.name] = this.readField(reader, field, options);
  }
};

Codec.prototype.skipMessage = function (reader, definition) {
  for (;;) {
    var id = reader.varUint();
    if (id === 0) return;
    var field = definition.byId[id];
    if (!field) {
      throw new Error(
        "Kiwi: поле " + id + " отсутствует в определении «" + definition.name + "»"
      );
    }
    this.skipField(reader, field);
  }
};

module.exports = {
  NATIVE_TYPES: NATIVE_TYPES,
  ByteReader: ByteReader,
  decodeSchema: decodeSchema,
  Codec: Codec,
};
