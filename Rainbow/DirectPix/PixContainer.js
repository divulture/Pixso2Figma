/**
 * Контейнер `.pix`.
 *
 * Файл Pixso — это обычный ZIP, внутри которого лежат:
 *   pixso.binary            бинарная схема Kiwi для документа
 *   VERSION                 {"app_version":…,"kiwi_version":…}
 *   <имя документа>.pix     payload: заголовок `pixso-kw\0` + сжатые данные
 *   <sha1>.png              ресурсы (растровые изображения)
 *   <sha1>.thumb.png        превью документа
 *
 * Ничего из перечисленного не опознаётся по имени конкретного тестового файла:
 * payload ищется по магии заголовка, ресурсы — по остаточному признаку.
 *
 * Зависимостей нет: ZIP читается вручную, распаковка — через стандартный zlib.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var EOCD_SIGNATURE = 0x06054b50;
var EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
var EOCD64_SIGNATURE = 0x06064b50;
var CENTRAL_SIGNATURE = 0x02014b50;
var LOCAL_SIGNATURE = 0x04034b50;

var PAYLOAD_MAGIC = "pixso-kw\u0000";
var SCHEMA_ENTRY = "pixso.binary";
var VERSION_ENTRY = "VERSION";

/** Сколько байт в хвосте файла просматриваем в поисках EOCD. */
var EOCD_SCAN_BYTES = 64 * 1024 + 22;

function fail(message) {
  var error = new Error(message);
  error.code = "PIX_CONTAINER";
  throw error;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

function findEocd(buffer) {
  var from = Math.max(0, buffer.length - EOCD_SCAN_BYTES);
  for (var i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * ZIP64 EOCD: нужен, когда обычный EOCD хранит 0xFFFFFFFF вместо смещения или
 * размера. Реальные `.pix` в это пока не упираются, но контейнер на 4 ГБ —
 * вопрос размера документа, а не формата.
 */
function readZip64(buffer, eocdOffset) {
  var locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) return null;
  if (buffer.readUInt32LE(locatorOffset) !== EOCD64_LOCATOR_SIGNATURE) return null;
  var recordOffset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
  if (recordOffset < 0 || recordOffset + 56 > buffer.length) return null;
  if (buffer.readUInt32LE(recordOffset) !== EOCD64_SIGNATURE) return null;
  return {
    entryCount: Number(buffer.readBigUInt64LE(recordOffset + 32)),
    directoryOffset: Number(buffer.readBigUInt64LE(recordOffset + 48)),
  };
}

/** Разбор extra field 0x0001 — там лежат «настоящие» размеры ZIP64-записи. */
function applyZip64Extra(entry, extra) {
  var offset = 0;
  while (offset + 4 <= extra.length) {
    var headerId = extra.readUInt16LE(offset);
    var size = extra.readUInt16LE(offset + 2);
    var body = offset + 4;
    if (headerId === 0x0001) {
      var cursor = body;
      if (entry.uncompressedSize === 0xffffffff && cursor + 8 <= body + size) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(cursor)); cursor += 8;
      }
      if (entry.compressedSize === 0xffffffff && cursor + 8 <= body + size) {
        entry.compressedSize = Number(extra.readBigUInt64LE(cursor)); cursor += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && cursor + 8 <= body + size) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(cursor)); cursor += 8;
      }
    }
    offset = body + size;
  }
}

function readCentralDirectory(buffer) {
  var eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) fail("Файл не похож на ZIP: не найдена запись End of Central Directory.");

  var entryCount = buffer.readUInt16LE(eocdOffset + 10);
  var directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  var zip64 = readZip64(buffer, eocdOffset);
  if (zip64 && (entryCount === 0xffff || directoryOffset === 0xffffffff)) {
    entryCount = zip64.entryCount;
    directoryOffset = zip64.directoryOffset;
  }

  var entries = [];
  var cursor = directoryOffset;
  for (var i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail("Повреждён каталог ZIP: запись " + i + " из " + entryCount + " не читается.");
    }
    var flags = buffer.readUInt16LE(cursor + 8);
    var nameLength = buffer.readUInt16LE(cursor + 28);
    var extraLength = buffer.readUInt16LE(cursor + 30);
    var commentLength = buffer.readUInt16LE(cursor + 32);
    var entry = {
      name: buffer.toString(flags & 0x800 ? "utf8" : "latin1", cursor + 46, cursor + 46 + nameLength),
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
    };
    if (extraLength) {
      applyZip64Extra(entry, buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    }
    entries.push(entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  var offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    fail("Повреждена запись ZIP «" + entry.name + "»: нет локального заголовка.");
  }
  var nameLength = buffer.readUInt16LE(offset + 26);
  var extraLength = buffer.readUInt16LE(offset + 28);
  var start = offset + 30 + nameLength + extraLength;
  var end = start + entry.compressedSize;
  if (end > buffer.length) fail("Повреждена запись ZIP «" + entry.name + "»: данные обрезаны.");
  var raw = buffer.subarray(start, end);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(raw); }
    catch (error) { fail("Не удалось распаковать «" + entry.name + "»: " + error.message); }
  }
  fail("Запись «" + entry.name + "» сжата неподдерживаемым методом " + entry.method + ".");
}

// ---------------------------------------------------------------------------
// Payload документа
// ---------------------------------------------------------------------------

function looksLikePayload(buffer) {
  return buffer.length > PAYLOAD_MAGIC.length &&
    buffer.toString("latin1", 0, PAYLOAD_MAGIC.length) === PAYLOAD_MAGIC;
}

/**
 * Заголовок payload: магия, версия заголовка, длина и текст тега сжатия.
 * Тег проверяется на печатаемость: непонятный заголовок должен дать внятную
 * ошибку, а не мусорную распаковку.
 */
function parsePayloadHeader(buffer) {
  if (!looksLikePayload(buffer)) {
    fail("Payload документа не начинается с сигнатуры «pixso-kw»: " +
      buffer.subarray(0, 16).toString("hex"));
  }
  var offset = PAYLOAD_MAGIC.length;
  var headerVersion = buffer[offset++];
  var tagLength = buffer[offset++];
  if (!tagLength || tagLength > 64 || offset + tagLength > buffer.length) {
    fail("Нечитаемый заголовок payload: длина тега " + tagLength + ".");
  }
  var tag = buffer.toString("latin1", offset, offset + tagLength);
  offset += tagLength;
  if (!/^[\x20-\x7e]+$/.test(tag)) {
    fail("Нечитаемый тег payload: " + JSON.stringify(tag));
  }
  return { headerVersion: headerVersion, tag: tag, bodyOffset: offset };
}

function decompressPayload(buffer, header) {
  var body = buffer.subarray(header.bodyOffset);
  var match = /^compress:(.+)$/.exec(header.tag);
  var codec = match ? match[1] : header.tag;
  if (codec === "none" || codec === "raw") return body;
  if (codec === "zstd") {
    if (typeof zlib.zstdDecompressSync !== "function") {
      fail("Payload сжат zstd, а в этой сборке Node нет zlib.zstdDecompressSync. Нужен Node 22.15+ / 24+.");
    }
    return zlib.zstdDecompressSync(body);
  }
  if (codec === "deflate") return zlib.inflateSync(body);
  if (codec === "gzip") return zlib.gunzipSync(body);
  fail("Неизвестный способ сжатия payload: «" + header.tag + "».");
}

// ---------------------------------------------------------------------------
// Публичное API
// ---------------------------------------------------------------------------

function classify(entries) {
  var schema = null;
  var version = null;
  var thumbnail = null;
  var payloads = [];
  var resources = [];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var base = entry.name.replace(/^.*\//, "");
    if (base === SCHEMA_ENTRY) { schema = entry; continue; }
    if (base === VERSION_ENTRY) { version = entry; continue; }
    if (/\.thumb\.(png|jpe?g|webp)$/i.test(base)) { thumbnail = entry; continue; }
    if (/\.(png|jpe?g|webp|gif|svg|mp4|webm|ttf|otf|woff2?)$/i.test(base)) {
      resources.push(entry);
      continue;
    }
    payloads.push(entry);
  }
  return { schema: schema, version: version, thumbnail: thumbnail, payloads: payloads, resources: resources };
}

/**
 * Открывает `.pix` и возвращает его части. Payload и схема распаковываются
 * сразу — без них дальше делать нечего; ресурсы остаются лениво читаемыми,
 * иначе документ с сотней изображений держал бы их все в памяти.
 */
function open(filePath) {
  var timings = { containerOpenMs: 0, decompressMs: 0 };
  var startedAt = Date.now();

  var stat;
  try { stat = fs.statSync(filePath); }
  catch (_e) { fail("Файл не найден: " + filePath); }
  if (!stat.isFile()) fail("Это не файл: " + filePath);

  var buffer = fs.readFileSync(filePath);
  var entries = readCentralDirectory(buffer);
  var parts = classify(entries);

  if (!parts.schema) {
    fail("В контейнере нет «" + SCHEMA_ENTRY + "»: это не файл Pixso или он сохранён другой версией.");
  }

  var schemaBuffer = readEntry(buffer, parts.schema);

  // Payload опознаётся по магии, а не по имени: имя совпадает с именем
  // документа и по-русски приезжает как есть.
  var payloadEntry = null;
  for (var i = 0; i < parts.payloads.length; i++) {
    var candidate = readEntry(buffer, parts.payloads[i]);
    if (looksLikePayload(candidate)) {
      payloadEntry = { entry: parts.payloads[i], buffer: candidate };
      break;
    }
  }
  if (!payloadEntry) {
    fail(
      "В контейнере нет payload с сигнатурой «pixso-kw». Записи: " +
      entries.map(function (e) { return e.name; }).slice(0, 20).join(", ")
    );
  }

  var header = parsePayloadHeader(payloadEntry.buffer);
  timings.containerOpenMs = Date.now() - startedAt;

  var decompressStartedAt = Date.now();
  var document = decompressPayload(payloadEntry.buffer, header);
  timings.decompressMs = Date.now() - decompressStartedAt;

  var versionInfo = null;
  if (parts.version) {
    try { versionInfo = JSON.parse(readEntry(buffer, parts.version).toString("utf8")); }
    catch (_eVersion) { versionInfo = null; }
  }

  var resourceIndex = Object.create(null);
  parts.resources.forEach(function (entry) {
    var base = entry.name.replace(/^.*\//, "");
    var id = base.replace(/\.[^.]+$/, "");
    resourceIndex[id] = entry;
  });

  return {
    filePath: filePath,
    fileName: path.basename(filePath),
    fileSize: stat.size,
    version: versionInfo,
    payloadName: payloadEntry.entry.name,
    payloadHeader: header,
    schemaBuffer: schemaBuffer,
    documentBuffer: document,
    entries: entries.map(function (entry) {
      return {
        name: entry.name,
        method: entry.method,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
      };
    }),
    resourceIds: Object.keys(resourceIndex),
    hasResource: function (id) { return !!resourceIndex[id]; },
    /** Байты ресурса по его идентификатору (обычно sha1 без расширения). */
    readResource: function (id) {
      var entry = resourceIndex[id];
      return entry ? readEntry(buffer, entry) : null;
    },
    resourceInfo: function (id) {
      var entry = resourceIndex[id];
      if (!entry) return null;
      var base = entry.name.replace(/^.*\//, "");
      var extension = (/\.([^.]+)$/.exec(base) || [null, "bin"])[1].toLowerCase();
      return { name: base, extension: extension, size: entry.uncompressedSize };
    },
    thumbnail: parts.thumbnail ? parts.thumbnail.name : null,
    timings: timings,
  };
}

module.exports = {
  open: open,
  parsePayloadHeader: parsePayloadHeader,
  readCentralDirectory: readCentralDirectory,
  looksLikePayload: looksLikePayload,
};
