/**
 * Direct PIX: нативные стили на стороне приёмника Figma.
 *
 *   node FigmaImporter/Tests/DirectPixStyleTest.js
 *
 * Тест гоняет НАСТОЯЩИЙ код приёмника на headless-двойнике хоста
 * (`DirectPix/FigmaHost.js`). Двойник моделирует то свойство Figma, ради
 * которого и задан порядок применения: назначенный стиль ПЕРЕЗАПИСЫВАЕТ
 * соответствующее значение узла, а сырое значение, назначенное следом, стиль
 * отцепляет. Хост, который бы этого не делал, пропустил бы ровно тот регресс,
 * от которого страхует этот файл.
 *
 * Утверждения:
 *
 *   — описание стиля превращается в один нативный стиль на job;
 *   — повторная встреча того же styleId даёт ссылку, а не второй стиль;
 *   — узлы, ссылающиеся на один стиль, указывают на ОДИН объект Figma;
 *   — привязка ложится ПОСЛЕ сырых значений: и картинка, и связь на месте;
 *   — TextStyle владеет типографикой и не трогает текст и цвет;
 *   — привязка из записи override применяется последней и не стирается;
 *   — стиль, которого нет в реестре, даёт счётчик, а не потерю красок;
 *   — подмена компонента приносит стили НОВОГО определения, а не старого;
 *   — реестр стилей одной миграции не виден другой.
 */
"use strict";

var assert = require("assert");
var path = require("path");

var FigmaHost = require("../../DirectPix/FigmaHost");

var checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message + " (получено: " + JSON.stringify(actual) + ")");
  checks += 1;
}

var host = FigmaHost.install(path.join(__dirname, "..", "Main.js"));
var receiver = host.receiver;

var DIRECT = { protocol: "PIXSO2FIGMA_DIRECT_PIX", directVersion: 1 };
var taskSequence = 0;

function task(jobId, type, payload) {
  taskSequence += 1;
  return receiver.handleDirectTask({
    jobId: jobId,
    taskId: jobId + "-" + type + "-" + taskSequence,
    type: "DIRECT_PIX_" + type,
    payload: Object.assign({}, DIRECT, payload || {}),
    // Страницы создаются явно: так корни отделены друг от друга и узел
    // ищется в известном месте.
  }, { createPages: true });
}

// ---------------------------------------------------------------------------
// Материал
// ---------------------------------------------------------------------------

var ACCENT = { r: 0, g: 0.33333, b: 1 };
var DANGER = { r: 1, g: 0, b: 0 };

function solid(color) { return { type: "SOLID", color: color, opacity: 1, blendMode: "NORMAL" }; }

var STYLES = [
  {
    styleId: "pxs-accent", styleType: "PAINT", sourceStyleType: "FILL",
    sourceKey: "key-accent", name: "brand/accent", description: "Акцент",
    paints: [solid(ACCENT)],
  },
  {
    styleId: "pxs-danger", styleType: "PAINT", sourceStyleType: "FILL",
    sourceKey: "key-danger", name: "brand/danger", paints: [solid(DANGER)],
  },
  {
    styleId: "pxs-body", styleType: "TEXT", sourceStyleType: "TEXT",
    sourceKey: "key-body", name: "web/body/m",
    text: {
      fontName: { family: "Inter", style: "Medium" }, fontSize: 16,
      lineHeight: { value: 24, unit: "PIXELS" },
    },
  },
  {
    styleId: "pxs-shadow", styleType: "EFFECT", sourceStyleType: "EFFECT",
    sourceKey: "key-shadow", name: "shadow/m",
    effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 },
      offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" }],
  },
];

function findStyle(styleId) {
  var all = host.styles();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getPluginData("pixsoDirectStyleId") === styleId) return all[i];
  }
  return null;
}

function findNode(root, sourceId) {
  var stack = [root];
  while (stack.length) {
    var current = stack.pop();
    if (current.getPluginData && current.getPluginData("pixsoDirectSourceId") === sourceId) return current;
    var children = current.children || [];
    for (var i = 0; i < children.length; i++) stack.push(children[i]);
  }
  return null;
}

function pageByName(name) {
  var pages = host.pages();
  for (var i = 0; i < pages.length; i++) if (pages[i].name === name) return pages[i];
  return null;
}

// ---------------------------------------------------------------------------

async function run() {
  var jobA = "job-styles-a";
  await task(jobA, "START", { source: { fileName: "styles.pix" } });

  // --- создание стилей ------------------------------------------------------
  var created = await task(jobA, "STYLES", { styles: STYLES });
  eq(created.paintStylesCreated, 2, "два PaintStyle созданы");
  eq(created.textStylesCreated, 1, "один TextStyle создан");
  eq(created.effectStylesCreated, 1, "один EffectStyle создан");
  eq(created.stylesReused, 0, "переиспользовать в первом chunk нечего");
  eq(host.calls.createPaintStyle, 2, "createPaintStyle вызван ровно дважды");

  var accent = findStyle("pxs-accent");
  ok(accent, "стиль опознаётся по отпечатку источника, а не по видимому имени");
  eq(accent.name, "brand/accent", "имя стиля источника воспроизведено");
  eq(accent.description, "Акцент", "описание перенесено");
  eq(accent.getPluginData("pixsoDirectStyleKey"), "key-accent",
    "общая идентичность источника осталась на стиле");
  eq(JSON.stringify(accent.paints), JSON.stringify([solid(ACCENT)]), "краски стиля на месте");

  var body = findStyle("pxs-body");
  eq(body.typography.fontSize, 16, "TextStyle несёт размер");
  eq(JSON.stringify(body.typography.fontName), JSON.stringify({ family: "Inter", style: "Medium" }),
    "TextStyle несёт шрифт");

  // --- повторная встреча того же описания ----------------------------------
  var again = await task(jobA, "STYLES", { styles: STYLES });
  eq(again.paintStylesCreated, 0, "повторный chunk новых стилей не создаёт");
  eq(again.stylesReused, 4, "все четыре опознаны как уже созданные");
  eq(host.calls.createPaintStyle, 2, "и хост второй раз не вызывался");

  // --- сборка корня ---------------------------------------------------------
  await task(jobA, "PAGE", { pageId: "p1", pageName: "Экран" });
  var rootResult = await task(jobA, "ROOT", {
    pageId: "p1", pageName: "Экран", rootId: "2:100", rootName: "Экран",
    nodes: [
      { id: "2:100", parent: null, kind: "ORDINARY", type: "FRAME", name: "Экран",
        x: 0, y: 0, width: 400, height: 400 },
      // Сырые краски совпадают со стилем: так и приходит настоящий документ.
      { id: "2:101", parent: "2:100", kind: "ORDINARY", type: "RECTANGLE", name: "Карточка A",
        x: 0, y: 0, width: 100, height: 40,
        fills: [solid(ACCENT)], styles: { fill: "pxs-accent" } },
      { id: "2:102", parent: "2:100", kind: "ORDINARY", type: "RECTANGLE", name: "Карточка B",
        x: 0, y: 50, width: 100, height: 40,
        fills: [solid(ACCENT)], styles: { fill: "pxs-accent" } },
      { id: "2:103", parent: "2:100", kind: "ORDINARY", type: "TEXT", name: "Заголовок",
        x: 0, y: 100, width: 200, height: 24,
        text: {
          characters: "Привет", fills: [solid(DANGER)],
          fontName: { family: "Inter", style: "Medium" }, fontSize: 16,
          lineHeight: { value: 24, unit: "PIXELS" }, textAlignHorizontal: "CENTER",
        },
        styles: { text: "pxs-body", fill: "pxs-danger" } },
      { id: "2:104", parent: "2:100", kind: "ORDINARY", type: "RECTANGLE", name: "Тень",
        x: 0, y: 150, width: 100, height: 40,
        effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" }],
        styles: { effect: "pxs-shadow" } },
      // Ссылка на стиль, которого в пакете не было: краски узла обязаны выжить.
      { id: "2:105", parent: "2:100", kind: "ORDINARY", type: "RECTANGLE", name: "Осиротевшая",
        x: 0, y: 200, width: 100, height: 40,
        fills: [solid(DANGER)], styles: { fill: "pxs-missing" } },
    ],
  });

  eq(rootResult.styleBindings.fillStyleBindings, 3, "три привязки заливки");
  eq(rootResult.styleBindings.textStyleBindings, 1, "одна привязка типографики");
  eq(rootResult.styleBindings.effectStyleBindings, 1, "одна привязка эффекта");
  eq(rootResult.styleBindings.styleBindingsMissingStyle, 1,
    "неизвестный стиль посчитан отдельной величиной");

  var page = pageByName("Экран");
  var cardA = findNode(page, "2:101");
  var cardB = findNode(page, "2:102");
  eq(cardA.fillStyleId, cardB.fillStyleId, "два узла указывают на ОДИН стиль Figma");
  eq(cardA.fillStyleId, accent.id, "и это именно созданный из источника стиль");
  eq(JSON.stringify(cardA.fills), JSON.stringify([solid(ACCENT)]),
    "картинка на месте: привязка легла ПОСЛЕ сырых красок и не отцепилась");

  var heading = findNode(page, "2:103");
  eq(heading.textStyleId, findStyle("pxs-body").id, "текст привязан к TextStyle");
  eq(heading.fillStyleId, findStyle("pxs-danger").id,
    "и отдельно — к PaintStyle цвета: это разные связи");
  eq(heading.characters, "Привет", "TextStyle текст не трогает");
  eq(JSON.stringify(heading.fills), JSON.stringify([solid(DANGER)]),
    "TextStyle не владеет цветом текста");
  eq(heading.textAlignHorizontal, "CENTER", "выравнивание остаётся свойством узла");
  eq(heading.fontSize, 16, "типографика узла соответствует стилю");

  var shadow = findNode(page, "2:104");
  eq(shadow.effectStyleId, findStyle("pxs-shadow").id, "эффект привязан");
  ok(shadow.effects && shadow.effects.length === 1, "и сами эффекты на узле есть");

  var orphan = findNode(page, "2:105");
  ok(!orphan.fillStyleId, "к несуществующему стилю узел не привязан");
  eq(JSON.stringify(orphan.fills), JSON.stringify([solid(DANGER)]),
    "но его собственные краски целы: пропущенная привязка не стирает картинку");

  // --- привязка из записи override -----------------------------------------
  var buttonDefinition = {
    definitionId: "2:20", componentKey: "key-button", name: "Кнопка",
    nodes: [
      { id: "2:20", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Кнопка",
        x: 0, y: 0, width: 120, height: 40 },
      { id: "2:21", parent: "2:20", kind: "ORDINARY", type: "RECTANGLE", name: "Фон",
        x: 0, y: 0, width: 120, height: 40,
        fills: [solid(ACCENT)], styles: { fill: "pxs-accent" } },
    ],
  };
  var swapTarget = {
    definitionId: "2:30", componentKey: "key-button-danger", name: "Кнопка опасная",
    nodes: [
      { id: "2:30", parent: null, kind: "ORDINARY", type: "COMPONENT", name: "Кнопка опасная",
        x: 0, y: 0, width: 120, height: 40 },
      { id: "2:31", parent: "2:30", kind: "ORDINARY", type: "RECTANGLE", name: "Фон",
        x: 0, y: 0, width: 120, height: 40,
        fills: [solid(DANGER)], styles: { fill: "pxs-danger" } },
    ],
  };
  await task(jobA, "DEFINITIONS", { definitions: [buttonDefinition, swapTarget] });

  var overrideResult = await task(jobA, "ROOT", {
    pageId: "p1", pageName: "Экран", rootId: "2:200", rootName: "Кнопки",
    nodes: [
      { id: "2:200", parent: null, kind: "ORDINARY", type: "FRAME", name: "Кнопки",
        x: 0, y: 0, width: 400, height: 200 },
      // Вхождение переопределяет фон ссылкой на другой стиль. Порядок обязан
      // быть таким: сначала краски правки, затем её привязка.
      { id: "2:201", parent: "2:200", kind: "INSTANCE", type: "INSTANCE",
        definitionId: "2:20", name: "Кнопка опасная", x: 0, y: 0, width: 120, height: 40,
        overrides: [{
          path: [{ index: 0, sourceId: "2:21", sourceType: "RECTANGLE",
            definitionId: "2:20", definitionPath: "0" }],
          ops: { fills: [solid(DANGER)], fillStyleId: "pxs-danger" },
          present: { fills: true, fillStyleId: true },
        }] },
      // Вхождение с подменой компонента: стиль обязан приехать от НОВОГО
      // определения, а не остаться от старого.
      { id: "2:202", parent: "2:200", kind: "INSTANCE", type: "INSTANCE",
        definitionId: "2:20", name: "Кнопка подменённая", x: 0, y: 60, width: 120, height: 40,
        overrides: [{
          path: [],
          ops: { swapDefinitionId: "2:30" },
          present: { swapDefinitionId: true },
        }] },
    ],
  });

  var buttons = pageByName("Экран");
  var dangerous = findNode(buttons, "2:201");
  var dangerousBackground = dangerous.children[0];
  eq(dangerousBackground.fillStyleId, findStyle("pxs-danger").id,
    "правка привязала фон к своему стилю");
  eq(JSON.stringify(dangerousBackground.fills), JSON.stringify([solid(DANGER)]),
    "и краски правки уцелели: привязка идёт последней и с ней согласована");
  ok(overrideResult.overridesMissed === 0,
    "операция привязки не считается промахом: приёмник её знает");

  var swapped = findNode(buttons, "2:202");
  var swappedBackground = swapped.children[0];
  eq(swappedBackground.fillStyleId, findStyle("pxs-danger").id,
    "подменённое вхождение несёт стиль НОВОГО определения");
  ok(swappedBackground.fillStyleId !== accent.id,
    "и не сохраняет чужой стиль подменённого определения");

  var finish = await task(jobA, "FINISH", {});
  eq(finish.styleReport.paintStylesCreated, 2, "итог: два PaintStyle на весь job");
  eq(finish.styleReport.textStylesCreated, 1, "итог: один TextStyle");
  eq(finish.styleReport.effectStylesCreated, 1, "итог: один EffectStyle");
  eq(finish.styleReport.styleBindingsMissingStyle, 1, "итог: одна привязка без стиля");
  ok(finish.styleReport.fillStyleBindings >= 4, "итог: привязки заливки посчитаны");

  // --- изоляция миграций ----------------------------------------------------
  var stylesBefore = host.styles().length;
  var jobB = "job-styles-b";
  await task(jobB, "START", { source: { fileName: "other.pix" } });
  var otherResult = await task(jobB, "STYLES", { styles: [STYLES[0]] });
  eq(otherResult.paintStylesCreated, 1,
    "чужая миграция создаёт свой стиль: реестр прошлой ей не виден");
  eq(otherResult.stylesReused, 0, "и ничего не переиспользует");
  eq(host.styles().length, stylesBefore + 1, "в документе появился ровно один новый стиль");

  process.stdout.write("DirectPixStyleTest: " + checks + " проверок пройдено\n");
}

run().catch(function (error) {
  process.stderr.write(String(error && error.stack || error) + "\n");
  process.exit(1);
});
