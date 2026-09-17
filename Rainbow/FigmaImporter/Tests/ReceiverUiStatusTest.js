"use strict";
var fs = require("fs");
var path = require("path");
var assert = require("assert");
var html = fs.readFileSync(path.join(__dirname, "..", "Ui.html"), "utf8");
assert.ok(html.indexOf('id="receiver-stats"') >= 0, "Receiver UI показывает отдельный счётчик времени/слоёв");
assert.ok(html.indexOf('image-downsample-request') >= 0, "UI умеет принять raster fallback request");
assert.ok(html.indexOf('createImageBitmap') >= 0, "raster fallback декодирует изображение в UI iframe");
assert.ok(html.indexOf('Direct PIX завершён за ') >= 0, "финальный статус содержит время сборки");

// Receiver lease (transport protocol 2). Поведение проверяет
// ReceiverLeaseUiTest.js; здесь — что константы и статусы не потерялись.
assert.ok(/var PROTOCOL_VERSION = 2;/.test(html), "UI объявляет transport protocolVersion 2");
assert.ok(html.indexOf("receiverId=") >= 0, "poll приёмника несёт receiverId");
assert.ok(html.indexOf("RECEIVER_SUPERSEDED") >= 0, "UI знает про перебитый lease");
assert.ok(html.indexOf("RECEIVER_SWITCH_BLOCKED") >= 0, "UI знает про блокировку смены во время migration");
assert.ok(html.indexOf("Отключён — активирован другой документ: ") >= 0,
  "статус superseded называет новый активный документ");
console.log("ReceiverUiStatusTest: OK");
