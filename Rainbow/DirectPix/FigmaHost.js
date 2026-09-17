/**
 * Headless-двойник хоста Figma.
 *
 * Нужен для одного: прогнать НАСТОЯЩИЙ код приёмника
 * (`FigmaImporter/Main.js`, ветка Direct PIX) вне редактора и прочитать
 * результат обратно. Без этого «что приёмник присвоил узлу» остаётся
 * недоказуемым: отчёт со счётчиками говорит, сколько правок применилось, но не
 * говорит, каким стало итоговое значение.
 *
 * Двойник реализует ровно те методы, которые вызывает ветка Direct PIX, и
 * ничего сверх: лишний вызов обязан упасть, а не молча пройти.
 *
 * Он НЕ является моделью Figma и не заменяет проверку в настоящем редакторе.
 * Два места, где он заведомо оптимистичнее реального хоста, названы явно:
 *
 *   — `createInstance()` копирует поддерево мастера целиком, включая
 *     plugin data. Настоящая Figma отдаёт plugin data подслоёв инстанса не в
 *     каждом контексте, и приёмник это учитывает отдельной веткой;
 *   — `swapComponent()` заменяет детей детьми нового мастера. Настоящая Figma
 *     дополнительно переносит на них совпавшие overrides.
 *
 * Поэтому «ноль промахов на двойнике» означает «адресация согласована с той
 * моделью дерева, которую строит сам приёмник», а не «в Figma всё сойдётся».
 */
"use strict";

/** Типы, которые в этой модели держат детей. */
var CONTAINER_TYPES = {
  FRAME: true, COMPONENT: true, COMPONENT_SET: true, INSTANCE: true,
  GROUP: true, SECTION: true, PAGE: true, BOOLEAN_OPERATION: true,
};

/**
 * Габарит набора путей.
 *
 * Разбираются только команды, которые пишет `PixNormalizer.pathFromBlob`:
 * M, L, C, Z. Кубическая кривая считается точно — по экстремумам её
 * производной, а не по оболочке контрольных точек: оболочка систематически
 * шире кривой, и «иконка приехала на 0.1 больше» было бы ложной тревогой на
 * каждой скруглённой иконке. Незнакомая команда означает отказ, а не
 * приблизительный ответ.
 */
function cubicExtremes(p0, p1, p2, p3) {
  var values = [p0, p3];
  var a = -p0 + 3 * p1 - 3 * p2 + p3;
  var b = 2 * (p0 - 2 * p1 + p2);
  var c = p1 - p0;
  function at(t) {
    var u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  }
  function consider(t) { if (t > 0 && t < 1) values.push(at(t)); }
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) consider(-c / b);
  } else {
    var discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      var root = Math.sqrt(discriminant);
      consider((-b + root) / (2 * a));
      consider((-b - root) / (2 * a));
    }
  }
  return values;
}


/**
 * Копия сети вектора. Двойник хранит СВОЁ значение, а не ссылку вызывающего:
 * иначе «узел показывает то, что ему записали» было бы невозможно отличить
 * от «тест смотрит на свой же объект».
 */
function normalizeVectorNetwork(value) {
  if (!value || !Array.isArray(value.regions)) return null;
  return {
    vertices: (value.vertices || []).map(function (vertex) {
      return { x: vertex.x, y: vertex.y };
    }),
    segments: (value.segments || []).map(function (segment) {
      return {
        start: segment.start,
        end: segment.end,
        tangentStart: segment.tangentStart || { x: 0, y: 0 },
        tangentEnd: segment.tangentEnd || { x: 0, y: 0 },
      };
    }),
    regions: value.regions.map(function (region) {
      var copy = { windingRule: region.windingRule, loops: region.loops };
      if (region.fills) copy.fills = region.fills;
      return copy;
    }),
  };
}

function pathBounds(paths) {
  if (!Array.isArray(paths) || !paths.length) return null;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function include(x, y) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (var i = 0; i < paths.length; i++) {
    var tokens = String(paths[i] && paths[i].data || "").trim().split(/\s+/).filter(Boolean);
    var cursor = { x: 0, y: 0 };
    var start = { x: 0, y: 0 };
    var t = 0;
    while (t < tokens.length) {
      var command = tokens[t++];
      if (command === "Z") { cursor = { x: start.x, y: start.y }; continue; }
      var need = command === "C" ? 6 : 2;
      if (command !== "M" && command !== "L" && command !== "C") return null;
      if (t + need > tokens.length) return null;
      var numbers = [];
      for (var n = 0; n < need; n++) {
        var value = Number(tokens[t++]);
        if (!isFinite(value)) return null;
        numbers.push(value);
      }
      if (command === "M") {
        cursor = { x: numbers[0], y: numbers[1] };
        start = { x: numbers[0], y: numbers[1] };
        include(cursor.x, cursor.y);
      } else if (command === "L") {
        cursor = { x: numbers[0], y: numbers[1] };
        include(cursor.x, cursor.y);
      } else {
        var xs = cubicExtremes(cursor.x, numbers[0], numbers[2], numbers[4]);
        var ys = cubicExtremes(cursor.y, numbers[1], numbers[3], numbers[5]);
        for (var e = 0; e < xs.length; e++) include(xs[e], minY === Infinity ? ys[0] : ys[0]);
        for (var f = 0; f < ys.length; f++) include(xs[0], ys[f]);
        cursor = { x: numbers[4], y: numbers[5] };
        include(cursor.x, cursor.y);
      }
    }
  }
  if (minX === Infinity) return null;
  return {
    width: Math.round((maxX - minX) * 1000) / 1000,
    height: Math.round((maxY - minY) * 1000) / 1000,
  };
}

/** Пары «сырое значение → id стиля, который оно отцепляет». */
/** Поля, которыми в Figma владеет `TextStyle`. */
var TEXT_STYLE_FIELDS = [
  "fontName", "fontSize", "lineHeight", "letterSpacing",
  "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "leadingTrim",
];

var APPEARANCE_FIELDS = [
  { value: "fills", style: "fillStyleId" },
  { value: "strokes", style: "strokeStyleId" },
  { value: "effects", style: "effectStyleId" },
];

/**
 * Минимальная модель auto layout Figma.
 *
 * Двойник не раскладывает детей по координатам и не переносит строки: ему
 * нужно воспроизвести ровно те побочные эффекты API, ради которых в приёмнике
 * и задан порядок присваиваний. Их четыре, и каждый наблюдаем в редакторе:
 *
 *   1. контейнер с `AUTO` по оси имеет размер СВОЕГО содержимого, а не тот,
 *      который ему присвоили (HUG);
 *   2. ребёнок с `layoutGrow > 0` получает остаток главной оси контейнера
 *      с фиксированной главной осью (FILL);
 *   3. ребёнок с `layoutAlign = "STRETCH"` получает внутренний размер
 *      контейнера по контр-оси, и только если сама контр-ось контейнера
 *      фиксирована: растягиваться до HUG-оси не по чему;
 *   4. ребёнок с `layoutPositioning = "ABSOLUTE"` из раскладки выключен —
 *      он не растягивается и не участвует в HUG-размере контейнера.
 *
 * Невидимый ребёнок исключён из потока: так же ведёт себя редактор.
 *
 * Чего модель НЕ делает: переноса строк (`layoutWrap`), координат внутри
 * контейнера, измерения текста и раскладки GRID. Поэтому она отвечает на
 * вопрос «сохранился ли размер и режим», а не «где именно лежит слой».
 */
var LAYOUT_DEFAULTS = {
  layoutMode: "NONE",
  // Измерено (built-hug-counter-over-stretch-content-inherit-relayout): фрейм
  // 380 с содержимым 170, которому сначала включили auto layout, а потом
  // режимы размеров, держит 380 — включение раскладки размер не обнимает.
  primaryAxisSizingMode: "FIXED",
  counterAxisSizingMode: "FIXED",
  itemSpacing: 0,
  paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
  layoutWrap: "NO_WRAP",
  // Измерено (stroke-hug-default): у нового auto layout обводка входит в
  // раскладку — Hug 100×36 с обводкой 1 px становится 102×38.
  strokesIncludedInLayout: true,
};

/** Поля контейнера, любое из которых меняет раскладку его детей. */
var LAYOUT_CONTAINER_FIELDS = Object.keys(LAYOUT_DEFAULTS);
var LAYOUT_CONTAINER_FIELD_SET = LAYOUT_CONTAINER_FIELDS.reduce(function (set, name) {
  set[name] = true;
  return set;
}, Object.create(null));

/** Поля ребёнка, любое из которых меняет его размер внутри контейнера. */
var LAYOUT_CHILD_FIELDS = ["layoutGrow", "layoutAlign", "layoutPositioning"];

var LAYOUT_CHILD_DEFAULTS = {
  layoutGrow: 0, layoutAlign: "INHERIT", layoutPositioning: "AUTO",
};

/** Границы размера auto layout. `null` — граница не объявлена. */
var LAYOUT_BOUND_FIELDS = ["minWidth", "maxWidth", "minHeight", "maxHeight"];

function clampBound(node, axis, value) {
  var min = axis === "width" ? node.minWidth : node.minHeight;
  var max = axis === "width" ? node.maxWidth : node.maxHeight;
  if (typeof min === "number" && value < min) value = min;
  if (typeof max === "number" && value > max) value = max;
  return value;
}

function inFlowChildren(container) {
  var out = [];
  var children = container.children || [];
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child.layoutPositioning === "ABSOLUTE") continue;
    if (child.visible === false) continue;
    out.push(child);
  }
  return out;
}

/**
 * Размер содержимого auto layout-ребёнка по оси `axis` или null, если
 * содержимого в потоке нет (тогда ребёнок входит текущим размером).
 */
function stretchedContentSize(child, axis) {
  var layout = child.__layout;
  if (!layout || (layout.layoutMode !== "HORIZONTAL" && layout.layoutMode !== "VERTICAL")) return null;
  var flow = inFlowChildren(child);
  if (!flow.length) return null;
  var horizontal = layout.layoutMode === "HORIZONTAL";
  var along = (axis === "width") === horizontal;
  var pad = axis === "width" ? layout.paddingLeft + layout.paddingRight : layout.paddingTop + layout.paddingBottom;
  var total = 0;
  for (var i = 0; i < flow.length; i++) {
    total = along ? total + flow[i][axis] : Math.max(total, flow[i][axis]);
  }
  if (along && flow.length > 1) total += layout.itemSpacing * (flow.length - 1);
  return total + pad;
}

function hasVisibleStrokes(node) {
  var strokes = node.strokes;
  if (!Array.isArray(strokes)) return false;
  for (var i = 0; i < strokes.length; i++) if (strokes[i] && strokes[i].visible !== false) return true;
  return false;
}

/** Один проход раскладки одного контейнера. Дети уже имеют свои размеры. */
function applyLayoutOnce(container) {
  var layout = container.__layout;
  var horizontal = layout.layoutMode === "HORIZONTAL";
  var flow = inFlowChildren(container);
  var mainAxis = horizontal ? "width" : "height";
  var crossAxis = horizontal ? "height" : "width";
  var padMain = horizontal
    ? layout.paddingLeft + layout.paddingRight
    : layout.paddingTop + layout.paddingBottom;
  var padCross = horizontal
    ? layout.paddingTop + layout.paddingBottom
    : layout.paddingLeft + layout.paddingRight;
  // Обводка, включённая в раскладку, занимает место внутри контейнера по
  // каждой стороне, как отступ.
  if (layout.strokesIncludedInLayout && hasVisibleStrokes(container)) {
    var stroke = typeof container.strokeWeight === "number" ? container.strokeWeight : 1;
    padMain += stroke * 2;
    padCross += stroke * 2;
  }
  var gaps = flow.length > 1 ? layout.itemSpacing * (flow.length - 1) : 0;
  var i;
  // Измерено (hug-over-hidden-only, hug-over-no-children): если в потоке нет
  // ни одного ребёнка (все скрыты, абсолютные или детей нет вовсе), Hug держит
  // прежний размер по обеим осям, а не садится на padding.
  var emptyFlow = !flow.length;

  // Контр-ось. Растянутый ребёнок в обнимающем контейнере входит в измерение
  // своим текущим размером: цикл Hug ↔ Fill Figma не рвёт, а замораживает.
  // Измерено: root-hug-over-stretch-child, built-hug-counter-over-stretch
  // (узел, собранный в порядке приёмника, держит размеры Pixso).
  // Но только когда растянуты ВСЕ: если в потоке есть хоть один нерастянутый,
  // Hug обнимает только нерастянутых, а растянутые садятся на их размер.
  // Измерено: built-hug-counter-over-stretch-mixed (380 → 105) и тот же
  // опыт с пересчётом; без растягивания широкий ребёнок держит 380
  // (built-hug-counter-over-stretch-mixed-inherit).
  if (layout.counterAxisSizingMode === "AUTO" && !emptyFlow) {
    var content = 0;
    var anyFixedCross = false;
    for (i = 0; i < flow.length; i++) if (flow[i].layoutAlign !== "STRETCH") anyFixedCross = true;
    for (i = 0; i < flow.length; i++) {
      if (anyFixedCross && flow[i].layoutAlign === "STRETCH") continue;
      // Растянуты все: растянутый ребёнок со своим содержимым входит размером
      // этого содержимого, пустой — текущим размером. Измерено:
      // built-hug-counter-over-stretch-content (380 → 170) против
      // built-hug-counter-over-stretch (пустые прямоугольники держат).
      // Инстанс и его слои размер держат: переключение в Hug там замораживает
      // ширину (root-hug-over-stretch-child, hug-over-stretch-content-grows).
      var frozen = container.type === "INSTANCE" || insideInstance(container);
      var measure = flow[i].layoutAlign === "STRETCH" && !frozen ? stretchedContentSize(flow[i], crossAxis) : null;
      content = Math.max(content, measure === null ? flow[i][crossAxis] : measure);
    }
    container[crossAxis] = clampBound(container, crossAxis, content + padCross);
  }
  var innerCross = Math.max(0, container[crossAxis] - padCross);
  for (i = 0; i < flow.length; i++) {
    if (flow[i].layoutAlign !== "STRETCH") continue;
    flow[i][crossAxis] = clampBound(flow[i], crossAxis, innerCross);
  }

  // Главная ось. Перенос строк модель не считает: при WRAP главная ось
  // остаётся такой, какой её присвоили.
  if (layout.layoutWrap === "WRAP") return;
  // Hug по главной оси: растущий ребёнок входит в сумму текущим размером и
  // остаток не перераспределяется. Измерено: main-axis-hug-over-grow,
  // built-hug-main-over-grow — там дети получают grow по одному, и
  // промежуточное состояние «один растёт, другой нет» размеров не теряет.
  if (layout.primaryAxisSizingMode === "AUTO") {
    if (emptyFlow) return;
    var total = 0;
    for (i = 0; i < flow.length; i++) total += flow[i][mainAxis];
    container[mainAxis] = clampBound(container, mainAxis, total + gaps + padMain);
    return;
  }
  var growTotal = 0;
  var fixedSum = 0;
  for (i = 0; i < flow.length; i++) {
    if (flow[i].layoutGrow > 0) growTotal += flow[i].layoutGrow;
    else fixedSum += flow[i][mainAxis];
  }
  if (!growTotal) return;
  var leftover = Math.max(0, container[mainAxis] - padMain - gaps - fixedSum);
  for (i = 0; i < flow.length; i++) {
    if (!(flow[i].layoutGrow > 0)) continue;
    flow[i][mainAxis] = clampBound(flow[i], mainAxis, leftover * (flow[i].layoutGrow / growTotal));
  }
}

/**
 * Пересчёт от узла вверх по дереву. Вверх — потому что HUG-родитель обязан
 * увидеть новый размер ребёнка; предел глубины страхует от цикла в дереве,
 * а не от нормальной вложенности.
 */
/**
 * Лежит ли узел ВНУТРИ инстанса (сам инстанс — нет).
 *
 * Измерено в живой Figma (FIGMA_CAPABILITIES.md): запись размера такому слою —
 * `resize`, `resizeWithoutConstraints`, min/max — молча игнорируется. Размер
 * слою инстанса задаёт только раскладка (растягивание) или размер корня.
 */
function insideInstance(node) {
  var current = node && node.parent;
  var guard = 0;
  while (current && guard++ < 256) {
    if (current.type === "INSTANCE") return true;
    current = current.parent;
  }
  return false;
}

/** Раскладка всего поддерева снизу вверх: так редактор собирает сохранённое состояние. */
function relayoutSubtree(root) {
  if (!root) return;
  var children = root.children || [];
  for (var i = 0; i < children.length; i++) relayoutSubtree(children[i]);
  if (root.__layout && root.__layout.layoutMode !== "NONE" && root.children) applyLayoutOnce(root);
}

function relayoutFrom(node) {
  var current = node;
  var guard = 0;
  while (current && guard++ < 128) {
    if (current.__layout && current.__layout.layoutMode !== "NONE" && current.children) {
      applyLayoutOnce(current);
    }
    current = current.parent;
  }
}

function createHost() {
  var sequence = 0;
  var pages = [];
  var styles = [];
  var stylesById = Object.create(null);

  function styleById(id) { return stylesById[id] || null; }

  /**
   * Привязка узла к стилю. Значение стиля пишется под флагом, который
   * отключает отцепление: назначение стиля обязано ПЕРЕЗАПИСАТЬ сырое
   * значение узла, а не снять само себя.
   */
  function bindStyle(node, id, valueField, styleField, styleValueField) {
    var style = styleById(id);
    if (!style) return Promise.reject(new Error("нет стиля " + id));
    node.__bindingStyle = true;
    try {
      node[valueField] = style[styleValueField];
      node[styleField] = id;
      // Node-level style assignment in Figma owns the whole text range for
      // the corresponding field. Model that destructive effect explicitly:
      // importer tests must prove that mixed range overrides are replayed
      // AFTER base fill/text style binding, not merely that setRange* was ever
      // called at some earlier point.
      if (node.type === "TEXT" && Array.isArray(node.__rangeStyles)) {
        if (valueField === "fills") {
          node.__rangeStyles = node.__rangeStyles.filter(function (entry) { return entry.field !== "fills"; });
        }
      }
    } finally {
      node.__bindingStyle = false;
    }
    return Promise.resolve();
  }

  /**
   * Локальный стиль двойника. Это НЕ scene node: у него нет родителя, и
   * приёмник проверяет его живость отдельной веткой (`isStyleAlive`).
   */
  function makeStyle(kind) {
    var style = {
      id: "style-" + (sequence += 1),
      kind: kind,
      name: "",
      description: "",
      removed: false,
      pluginData: Object.create(null),
      paints: [],
      effects: [],
      // Реальный Figma TextStyle начинается с fontSize=12. Двойник
      // должен ловить пропущенное receiver-ом source-значение.
      typography: kind === "TEXT" ? { fontSize: 12 } : Object.create(null),
      setPluginData: function (key, value) { this.pluginData[key] = String(value); },
      getPluginData: function (key) { return this.pluginData[key] || ""; },
    };
    if (kind === "TEXT") {
      // Поля типографики стиля пишутся приёмником напрямую; двойник
      // запоминает их, чтобы привязка узла могла их воспроизвести.
      ["fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing",
        "paragraphIndent", "textCase", "textDecoration"].forEach(function (key) {
        Object.defineProperty(style, key, {
          enumerable: true,
          get: function () { return style.typography[key]; },
          set: function (value) { style.typography[key] = value; },
        });
      });
    }
    styles.push(style);
    stylesById[style.id] = style;
    return style;
  }
  var calls = {
    createComponent: 0, createInstance: 0, createFrame: 0, createText: 0,
    createVector: 0, createImage: 0, swapComponent: 0, createPage: 0,
    combineAsVariants: 0, addComponentProperty: 0, setProperties: 0, resetOverrides: 0,
    createPaintStyle: 0, createTextStyle: 0, createEffectStyle: 0,
    nestedResizeIgnored: 0,
  };
  var nodesById = Object.create(null);
  var propertySequence = 0;

  function makeNode(type) {
    var node = {
      id: "sim-" + (sequence += 1),
      type: type,
      name: "",
      removed: false,
      parent: null,
      children: CONTAINER_TYPES[type] ? [] : undefined,
      pluginData: Object.create(null),
      x: 0, y: 0, width: 10, height: 10,
      opacity: 1, locked: false,
      fillStyleId: "", strokeStyleId: "", effectStyleId: "", textStyleId: "",
      setPluginData: function (key, value) { this.pluginData[key] = String(value); },
      getPluginData: function (key) { return this.pluginData[key] || ""; },
      resizeWithoutConstraints: function (width, height) {
        if (insideInstance(this)) { calls.nestedResizeIgnored += 1; return; }
        this.width = width;
        this.height = height;
        // У настоящего TextNode явный resize сбрасывает WIDTH_AND_HEIGHT в
        // фиксированную коробку. Приёмник обязан после ЛЮБОГО позднего resize
        // вернуть source textAutoResize, иначе HUG переживает base-build, но
        // теряется на restore/override стадии. Двойник моделирует именно этот
        // побочный эффект, не пытаясь измерять метрики шрифта.
        if (this.type === "TEXT" && this.textAutoResize === "WIDTH_AND_HEIGHT") {
          this.textAutoResize = "NONE";
        }
        // Настоящая Figma пересчитывает раскладку сразу: собственную, если
        // узел — контейнер, и родительскую, если родитель обнимает контент.
        relayoutFrom(this);
      },
      // Привязка к нативному стилю. Двойник моделирует то свойство Figma,
      // ради которого и задан порядок применения: назначенный стиль
      // ПЕРЕЗАПИСЫВАЕТ соответствующее значение узла. Без этого «сначала
      // стиль, потом сырое значение» выглядело бы здесь безобидно.
      setFillStyleIdAsync: function (id) { return bindStyle(node, id, "fills", "fillStyleId", "paints"); },
      setStrokeStyleIdAsync: function (id) { return bindStyle(node, id, "strokes", "strokeStyleId", "paints"); },
      setEffectStyleIdAsync: function (id) { return bindStyle(node, id, "effects", "effectStyleId", "effects"); },
      remove: function () {
        this.removed = true;
        var previous = this.parent;
        if (previous && previous.children) {
          var index = previous.children.indexOf(this);
          if (index >= 0) previous.children.splice(index, 1);
        }
        this.parent = null;
        if (previous) relayoutFrom(previous);
      },
    };
    nodesById[node.id] = node;
    // `clone()` Figma: копия кладётся к тому же родителю. Копия инстанса
    // собирается из СОХРАНЁННОГО состояния, а не из текущей геометрии.
    node.clone = function () {
      var copy = cloneNode(node);
      if (node.parent && typeof node.parent.appendChild === "function") node.parent.appendChild(copy);
      if (node.type === "INSTANCE") materializeStoredInstance(copy);
      return copy;
    };

    // Видимость — свойство с побочным эффектом: скрытый слой выпадает из
    // потока auto layout, и родитель, обнимающий содержимое, пересчитывается.
    // Именно этим вхождение с выключенным элементом отличается по размеру от
    // своего мастера.
    var visible = true;
    Object.defineProperty(node, "visible", {
      enumerable: true,
      get: function () { return visible; },
      set: function (next) { visible = next; relayoutFrom(node.parent); },
    });

    // Поведение узла внутри auto layout родителя. Свойства есть у КАЖДОГО
    // типа: ребёнком контейнера может быть и текст, и вектор. Присваивание
    // пересчитывает раскладку родителя — ровно это и делает редактор.
    LAYOUT_CHILD_FIELDS.forEach(function (field) {
      var value = LAYOUT_CHILD_DEFAULTS[field];
      Object.defineProperty(node, field, {
        enumerable: true,
        get: function () { return value; },
        set: function (next) {
          value = next;
          // Live Figma can invalidate text overflow state when a TextNode's
          // auto-layout slot is rewritten. Model the destructive side effect
          // so receiver tests must restore truncation/maxLines at the end.
          if (node.type === "TEXT" && node.__textOverflowInitialized) node.maxLines = null;
          // Измерено (built-hug-counter-over-stretch-text): текст с HEIGHT,
          // растянутый по высоте в горизонтальном auto layout, теряет
          // авторазмер — Figma переводит его в NONE. Прочие сочетания не
          // измерялись и не моделируются.
          if (node.type === "TEXT" && field === "layoutAlign" && next === "STRETCH" &&
              node.textAutoResize === "HEIGHT" && node.parent && node.parent.__layout &&
              node.parent.__layout.layoutMode === "HORIZONTAL") {
            node.textAutoResize = "NONE";
          }
          relayoutFrom(node.parent);
        },
      });
    });
    // Измерено (nested-constraints, deep-constraints): у слоя внутри инстанса
    // Figma отказывает в записи constraints ошибкой API.
    var constraintsValue = { horizontal: "MIN", vertical: "MIN" };
    Object.defineProperty(node, "constraints", {
      enumerable: true,
      get: function () { return constraintsValue; },
      set: function (next) {
        if (insideInstance(node)) {
          throw new Error("in set_constraints: This property cannot be overridden in an instance: vertical-constraint");
        }
        constraintsValue = next;
      },
    });
    LAYOUT_BOUND_FIELDS.forEach(function (field) {
      var value = null;
      Object.defineProperty(node, field, {
        enumerable: true,
        get: function () { return value; },
        set: function (next) {
          if (insideInstance(node)) { calls.nestedResizeIgnored += 1; return; }
          value = next;
          relayoutFrom(node);
        },
      });
    });

    // Public Figma W/H sizing dropdowns. The receiver uses these as the final
    // semantic owner; the headless host keeps their explicit read-back so a
    // test cannot accidentally declare TextNode HUG only from textAutoResize
    // while the actual layoutSizingHorizontal getter would still say FIXED.
    ["layoutSizingHorizontal", "layoutSizingVertical"].forEach(function (field) {
      var stored = null;
      var axis = field === "layoutSizingHorizontal" ? "width" : "height";
      function parentSlot() {
        var parent = node.parent;
        var mode = parent && parent.__layout && parent.__layout.layoutMode;
        if (mode !== "HORIZONTAL" && mode !== "VERTICAL") return null;
        if (node.layoutPositioning === "ABSOLUTE") return null;
        return (mode === "HORIZONTAL") === (axis === "width") ? "main" : "cross";
      }
      Object.defineProperty(node, field, {
        enumerable: true,
        // В Figma это вид на раскладку, а не отдельное значение: чтение
        // отражает растягивание ребёнка и режим собственной оси. Текст
        // сохраняет прежнее хранимое значение: его режим несёт textAutoResize.
        get: function () {
          var slot = parentSlot();
          if (node.type === "TEXT") {
            // Измерено (text-layout-sizing-hug): у текста в auto layout чтение
            // отражает растягивание, иначе режим textAutoResize. Текст вне
            // auto layout не измерялся — прежнее хранимое значение.
            if (!slot) return stored;
            if (slot === "main" && node.layoutGrow > 0) return "FILL";
            if (slot === "cross" && node.layoutAlign === "STRETCH") return "FILL";
            if (node.textAutoResize === "WIDTH_AND_HEIGHT") return "HUG";
            if (node.textAutoResize === "HEIGHT") return axis === "height" ? "HUG" : "FIXED";
            return "FIXED";
          }
          if (slot === "main" && node.layoutGrow > 0) return "FILL";
          if (slot === "cross" && node.layoutAlign === "STRETCH") return "FILL";
          var layout = node.__layout;
          if (layout && (layout.layoutMode === "HORIZONTAL" || layout.layoutMode === "VERTICAL")) {
            var own = axis === (layout.layoutMode === "HORIZONTAL" ? "width" : "height")
              ? layout.primaryAxisSizingMode : layout.counterAxisSizingMode;
            return own === "AUTO" ? "HUG" : "FIXED";
          }
          return stored === null && !slot ? null : "FIXED";
        },
        set: function (next) {
          stored = next;
          var slot = parentSlot();
          // FILL — это растягивание по родителю (FIGMA_CAPABILITIES.md,
          // nested-sizing-fill: принимается и у слоя внутри инстанса).
          if (next === "FILL" && slot) {
            if (slot === "main") node.layoutGrow = 1; else node.layoutAlign = "STRETCH";
            return;
          }
          if ((next === "FIXED" || next === "HUG") && slot) {
            if (slot === "main" && node.layoutGrow > 0) node.layoutGrow = 0;
            if (slot === "cross" && node.layoutAlign === "STRETCH") node.layoutAlign = "INHERIT";
          }
          if (node.__layout && (next === "FIXED" || next === "HUG")) {
            var horizontal = node.__layout.layoutMode === "HORIZONTAL";
            var ownField = axis === (horizontal ? "width" : "height")
              ? "primaryAxisSizingMode" : "counterAxisSizingMode";
            if (node.__layout.layoutMode === "HORIZONTAL" || node.__layout.layoutMode === "VERTICAL") {
              node.__layout[ownField] = next === "HUG" ? "AUTO" : "FIXED";
            }
          }
          relayoutFrom(node.parent);
        },
      });
    });

    // Заливки, обводки и эффекты — свойства с поведением настоящей Figma:
    // назначение СЫРОГО значения ОТЦЕПЛЯЕТ стиль. Без этого «сначала стиль,
    // потом сырое значение» выглядело бы здесь безобидным, и порядок
    // применения в приёмнике нечем было бы проверить.
    APPEARANCE_FIELDS.forEach(function (pair) {
      var raw = [];
      Object.defineProperty(node, pair.value, {
        enumerable: true,
        get: function () { return raw; },
        set: function (next) {
          raw = next;
          if (!node.__bindingStyle) node[pair.style] = "";
          // Заливка САМОГО VectorNode красит весь вектор: собственные краски
          // регионов сети после такой записи перестают существовать. Именно
          // поэтому сеть в приёмнике пишется последней, и без этой модели
          // «краски регионов затёрты заливкой узла» здесь было бы не увидеть.
          if (pair.value === "fills" && node.__vectorNetwork) {
            node.__vectorNetwork.regions.forEach(function (region) { delete region.fills; });
          }
        },
      });
    });
    node.resize = function (width, height) {
      if (insideInstance(this)) { calls.nestedResizeIgnored += 1; return; }
      this.width = width;
      this.height = height;
      // In live Figma an explicit resize owns the physical box. For an
      // auto-layout container that means AUTO/HUG axes become FIXED. This is
      // intentionally different from the old test double, which only changed
      // numbers and therefore hid HUG->FIXED regressions in the receiver.
      if (this.__layout && (this.__layout.layoutMode === "HORIZONTAL" || this.__layout.layoutMode === "VERTICAL")) {
        if (this.__layout.primaryAxisSizingMode === "AUTO") this.__layout.primaryAxisSizingMode = "FIXED";
        if (this.__layout.counterAxisSizingMode === "AUTO") this.__layout.counterAxisSizingMode = "FIXED";
      }
      if (this.type === "TEXT" && (this.textAutoResize === "WIDTH_AND_HEIGHT" || this.textAutoResize === "HEIGHT")) {
        this.textAutoResize = "NONE";
      }
      relayoutFrom(this);
    };
    if (CONTAINER_TYPES[type]) {
      // Состояние auto layout контейнера. Каждое поле — свойство с побочным
      // эффектом: редактор перекладывает содержимое в момент присваивания, и
      // без этого порядок присваиваний в приёмнике нечем проверить.
      node.__layout = Object.assign({}, LAYOUT_DEFAULTS);
      LAYOUT_CONTAINER_FIELDS.forEach(function (field) {
        Object.defineProperty(node, field, {
          enumerable: true,
          get: function () { return node.__layout[field]; },
          set: function (next) {
            node.__layout[field] = next;
            relayoutFrom(node);
          },
        });
      });
      node.appendChild = function (child) {
        if (!child) throw new Error("appendChild(null)");
        if (child.parent && child.parent.children) {
          var previous = child.parent;
          var index = previous.children.indexOf(child);
          if (index >= 0) previous.children.splice(index, 1);
          relayoutFrom(previous);
        }
        child.parent = this;
        this.children.push(child);
        relayoutFrom(this);
      };
    }
    if (type === "VECTOR" || type === "LINE") {
      // Настоящая Figma пересчитывает габарит вектора по назначенным путям.
      // Двойник делает то же самое: без этого «иконка приехала другого
      // размера» невозможно было бы увидеть offline.
      var paths = null;
      Object.defineProperty(node, "vectorPaths", {
        enumerable: true,
        get: function () { return paths; },
        set: function (value) {
          paths = value;
          var box = pathBounds(value);
          if (!box) return;
          node.width = box.width;
          node.height = box.height;
          relayoutFrom(node);
        },
      });
      // Сеть вектора. Двойник моделирует то свойство Figma, ради которого она
      // и пишется: краска принадлежит региону, а заливка САМОГО узла её
      // перекрывает. Без этого «цвет уехал, но был затёрт заливкой узла»
      // offline было бы не отличить от «цвет уехал».
      Object.defineProperty(node, "vectorNetwork", {
        enumerable: true,
        // Настраиваемое намеренно: отказ редактора принять сеть — реальное
        // состояние Figma (узел внутри инстанса), и тест обязан уметь его
        // выразить, не переписывая двойник.
        configurable: true,
        get: function () { return node.__vectorNetwork || null; },
        set: function (value) { node.__vectorNetwork = normalizeVectorNetwork(value); },
      });
      node.setVectorNetworkAsync = function (value) {
        node.__vectorNetwork = normalizeVectorNetwork(value);
        return Promise.resolve();
      };
    }
    if (type === "TEXT") {
      // Порядок присваиваний текстовых свойств. Двойник его НЕ моделирует —
      // подобрать ширину строки без метрик шрифта честно нельзя, — но
      // записывает: в Figma `textAutoResize` фиксирует ТЕКУЩИЙ габарит узла,
      // поэтому «режим до символов» и «режим после символов» — это два
      // разных результата, а не одно и то же в другом порядке.
      node.__textWriteOrder = [];
      var characters = "";
      Object.defineProperty(node, "characters", {
        enumerable: true,
        get: function () { return characters; },
        set: function (next) {
          var previous = characters;
          characters = next;
          node.__textWriteOrder.push("characters");
          // Измерено (nested-text-characters-hug): текст с WIDTH_AND_HEIGHT
          // растёт вместе со строкой. Метрик шрифта у двойника нет, поэтому
          // ширина масштабируется длиной строки от уже известной ширины.
          // Измерено (text-single-space-width, text-trailing-space-width):
          // конечные пробелы в авто-ширину не входят, строка из пробелов — 0.
          if (node.textAutoResize === "WIDTH_AND_HEIGHT" && typeof next === "string") {
            // Неразрывный пробел ширину имеет (text-nbsp-width): отрезаются
            // только обычные пробельные символы.
            var before = String(previous || "").replace(/[ \t\r\n]+$/, "").length;
            var after = next.replace(/[ \t\r\n]+$/, "").length;
            if (!after) {
              node.width = 0;
              relayoutFrom(node.parent);
            } else if (before && after !== before) {
              node.width = Math.max(1, node.width * after / before);
              relayoutFrom(node.parent);
            }
          }
        },
      });
      // Поля, у которых в Figma есть предусловие по порядку. Кроме
      // `textAutoResize` это пара обрезания: `maxLines` действует только при
      // включённом `textTruncation`, поэтому «сначала maxLines» и «сначала
      // textTruncation» — тоже два разных результата.
      ["textAutoResize", "textTruncation", "maxLines"].forEach(function (field) {
        var value;
        Object.defineProperty(node, field, {
          enumerable: true,
          get: function () { return value; },
          set: function (next) {
            value = next;
            node.__textWriteOrder.push(field);
            if (field === "textAutoResize" && next === "WIDTH_AND_HEIGHT" &&
                !String(node.characters || "").replace(/[ \t\r\n]+$/, "").length) {
              node.width = 0;
            }
            if (field === "textTruncation" || field === "maxLines") node.__textOverflowInitialized = true;
          },
        });
      });
      node.__rangeStyles = [];
      function setRange(field, start, end, value) {
        node.__rangeStyles.push({ field: field, start: start, end: end, value: value });
      }
      node.getRangeFontName = function () { return this.fontName; };
      node.setRangeFontName = function (start, end, value) { setRange("fontName", start, end, value); };
      node.setRangeFontSize = function (start, end, value) { setRange("fontSize", start, end, value); };
      node.setRangeTextCase = function (start, end, value) { setRange("textCase", start, end, value); };
      node.setRangeTextDecoration = function (start, end, value) { setRange("textDecoration", start, end, value); };
      node.setRangeLetterSpacing = function (start, end, value) { setRange("letterSpacing", start, end, value); };
      node.setRangeLineHeight = function (start, end, value) { setRange("lineHeight", start, end, value); };
      node.setRangeParagraphIndent = function (start, end, value) { setRange("paragraphIndent", start, end, value); };
      node.setRangeParagraphSpacing = function (start, end, value) { setRange("paragraphSpacing", start, end, value); };
      node.setRangeFills = function (start, end, value) { setRange("fills", start, end, value); };
      node.setTextStyleIdAsync = function (id) {
        var style = styleById(id);
        if (!style) return Promise.reject(new Error("нет стиля " + id));
        node.__bindingStyle = true;
        try {
          // TextStyle Figma владеет типографикой узла и ничем больше: ни
          // цветом, ни выравниванием, ни самим текстом.
          Object.keys(style.typography).forEach(function (key) { node[key] = style.typography[key]; });
          node.textStyleId = id;
          if (Array.isArray(node.__rangeStyles)) {
            var typographyFields = {
              fontName: true, fontSize: true, textCase: true, textDecoration: true,
              letterSpacing: true, lineHeight: true, paragraphIndent: true,
              paragraphSpacing: true,
            };
            node.__rangeStyles = node.__rangeStyles.filter(function (entry) {
              return !typographyFields[entry.field];
            });
          }
        } finally {
          node.__bindingStyle = false;
        }
        return Promise.resolve();
      };
      TEXT_STYLE_FIELDS.forEach(function (field) {
        var raw;
        Object.defineProperty(node, field, {
          enumerable: true,
          get: function () { return raw; },
          set: function (next) {
            raw = next;
            if (!node.__bindingStyle) node.textStyleId = "";
          },
        });
      });
      // Значение по умолчанию ставится ПОСЛЕ установки свойств: свежий
      // текстовый узел Figma приходит со своим шрифтом, и узел без него
      // ронял бы любую правку типографики по FONT_UNAVAILABLE.
      node.__bindingStyle = true;
      node.fontName = { family: "Inter", style: "Regular" };
      node.__bindingStyle = false;
    }
    return node;
  }

  /** Глубокая копия узла: ровно так инстанс наследует дерево мастера. */
  function cloneNode(source) {
    var copy = makeNode(source.type);
    Object.keys(source).forEach(function (key) {
      if (key === "children" || key === "parent" || key === "id" || key === "pluginData") return;
      // Раскладка контейнера копируется отдельно и целиком. Через свойства
      // её копировать нельзя: каждое присваивание перекладывает содержимое,
      // а детей у клона в этот момент ещё нет — контейнер схлопнулся бы
      // до нуля прямо посреди копирования.
      if (key === "__layout" || LAYOUT_CONTAINER_FIELD_SET[key]) return;
      if (typeof source[key] === "function") return;
      copy[key] = source[key];
    });
    if (source.__layout && copy.__layout) copy.__layout = Object.assign({}, source.__layout);
    // Копирование сырых значений отцепило бы стили: восстанавливаем связи
    // после него, как это делает настоящий клон поддерева мастера.
    copy.__bindingStyle = true;
    copy.fillStyleId = source.fillStyleId;
    copy.strokeStyleId = source.strokeStyleId;
    copy.effectStyleId = source.effectStyleId;
    copy.textStyleId = source.textStyleId;
    copy.__bindingStyle = false;
    copy.pluginData = Object.assign(Object.create(null), source.pluginData);
    copy.removed = false;
    copy.parent = null;
    if (source.type === "INSTANCE") attachInstance(copy, instanceMain(source));
    if (source.children) {
      for (var i = 0; i < source.children.length; i++) copy.appendChild(cloneNode(source.children[i]));
    }
    // Габарит — последним и напрямую: копия поддерева редактора совпадает с
    // оригиналом, а не пересчитывается заново по мере наполнения.
    copy.width = source.width;
    copy.height = source.height;
    return copy;
  }

  /**
   * Размеры мастера у слоёв инстанса — то, что Figma хранит, пока у слоя нет
   * собственной правки размера (а её слою инстанса задать нельзя).
   */
  function recordMasterSizes(instance, component) {
    // Размеры берутся у МАСТЕРА, слой к слою по структуре: копия внутри
    // только что созданного инстанса в этот момент ещё разложена по
    // размеру по умолчанию, и её числа мастером не являются.
    function pair(copy, master) {
      if (!copy || !master) return;
      if (copy !== instance) {
        copy.__masterWidth = master.width;
        copy.__masterHeight = master.height;
      }
      var copies = copy.children || [];
      var masters = master.children || [];
      for (var i = 0; i < copies.length && i < masters.length; i++) pair(copies[i], masters[i]);
    }
    pair(instance, component);
  }

  /**
   * Сохранённое состояние инстанса: у слоёв, чья ось FIXED, размер мастера;
   * растянутые и обнимающие оси пересчитывает раскладка. Измерено
   * (nested-stretch-to-inherit, pixso-order-*): размер, полученный от
   * раскладки, в сохранённое состояние не попадает — его видно на `clone()`.
   */
  function materializeStoredInstance(instance) {
    walkNode(instance, function (node) {
      if (node === instance) return;
      if (typeof node.__masterWidth !== "number") return;
      if (node.type === "TEXT" && node.textAutoResize === "WIDTH_AND_HEIGHT") return;
      if (node.layoutSizingHorizontal !== "FILL" && node.layoutSizingHorizontal !== "HUG") node.width = node.__masterWidth;
      if (node.type === "TEXT" && node.textAutoResize === "HEIGHT") return;
      if (node.layoutSizingVertical !== "FILL" && node.layoutSizingVertical !== "HUG") node.height = node.__masterHeight;
    });
    relayoutSubtree(instance);
  }

  /** Мастер инстанса двойника: читается кодом двойника, но не приёмником. */
  function instanceMain(instance) {
    return (instance && instance.__mainComponent) || null;
  }

  /**
   * Инстанс двойника.
   *
   * `mainComponent` — getter, который БРОСАЕТ. Манифест приёмника объявляет
   * `documentAccess: "dynamic-page"`, и настоящая Figma на синхронном чтении
   * этого поля тоже бросает. Двойник, отдающий его молча, скрывал бы ровно тот
   * дефект, ради которого он и запускается: код, выводящий активное
   * определение через `mainComponent`, в реальном редакторе не работает
   * никогда. Мастер доступен там же, где и в Figma, — `getMainComponentAsync`.
   */
  function nativeSchemaOwner(component) {
    if (!component) return null;
    return component.type === "COMPONENT" && component.parent && component.parent.type === "COMPONENT_SET"
      ? component.parent : component;
  }

  function addComponentProperty(owner, name, type, defaultValue) {
    if (!owner.componentPropertyDefinitions) owner.componentPropertyDefinitions = Object.create(null);
    propertySequence += 1;
    // Настоящая Figma возвращает фактическое имя, которое может отличаться
    // от логического. Суффикс здесь намеренный: тест обязан пользоваться
    // возвращённым именем, а не надеяться на исходную строку.
    var actual = String(name) + "#p" + propertySequence;
    owner.componentPropertyDefinitions[actual] = { type: type, defaultValue: defaultValue };
    calls.addComponentProperty += 1;
    return actual;
  }

  function walkNode(root, visit) {
    if (!root) return;
    visit(root);
    var children = root.children || [];
    for (var i = 0; i < children.length; i++) walkNode(children[i], visit);
  }

  function applyBoundProperty(instance, propertyName, value) {
    walkNode(instance, function (node) {
      var refs = node.componentPropertyReferences || {};
      Object.keys(refs).forEach(function (field) {
        if (refs[field] !== propertyName) return;
        if (field === "mainComponent") {
          var next = nodesById[String(value)] || null;
          if (!next || next.type !== "COMPONENT" || node.type !== "INSTANCE") {
            throw new Error("INSTANCE_SWAP property points outside COMPONENT");
          }
          node.swapComponent(next);
          return;
        }
        node[field] = value;
      });
    });
  }

  function attachNativeInstanceProperties(instance) {
    instance.componentProperties = Object.create(null);
    instance.setProperties = function (values) {
      var main = instanceMain(instance);
      var owner = nativeSchemaOwner(main);
      var definitions = owner && owner.componentPropertyDefinitions || {};
      var keys = Object.keys(values || {});
      for (var i = 0; i < keys.length; i++) {
        var name = keys[i];
        if (!definitions[name]) throw new Error("unknown component property: " + name);
        applyBoundProperty(instance, name, values[name]);
        instance.componentProperties[name] = { type: definitions[name].type, value: values[name] };
      }
      calls.setProperties += keys.length;
    };
  }

  function attachInstance(instance, component) {
    instance.__mainComponent = component;
    if (instance.isExposedInstance === undefined) instance.isExposedInstance = false;
    attachNativeInstanceProperties(instance);
    Object.defineProperty(instance, "mainComponent", {
      configurable: true,
      get: function () {
        throw new Error("mainComponent недоступен под documentAccess: dynamic-page");
      },
      set: function (value) {
        // Figma documents direct mainComponent assignment as the clean swap
        // path: unlike swapComponent(), it clears overrides. Reflect the new
        // master subtree immediately so headless tests can distinguish the
        // two semantics.
        instance.__mainComponent = value;
        if (value && value.type === "COMPONENT") {
          while (instance.children.length) instance.children[0].remove();
          instance.__layout = Object.assign({}, value.__layout);
          for (var i = 0; i < value.children.length; i++) instance.appendChild(cloneNode(value.children[i]));
          instance.width = value.width;
          instance.height = value.height;
          recordMasterSizes(instance, value);
        }
      },
    });
    instance.getMainComponentAsync = function () {
      return Promise.resolve(instanceMain(instance));
    };
    instance.resetOverrides = function () {
      calls.resetOverrides += 1;
      // The real API clears direct overrides without detaching the instance.
      // The headless host has no separate override ledger; the call counter is
      // enough to assert the receiver takes this explicit clean-swap barrier.
    };
    // Координата варианта вхождения — ПРОИЗВОДНАЯ от мастера, а не копия,
    // снятая в момент создания. Именно поэтому инстанс, созданный до
    // объединения в набор, показывает координату сразу после него: копия
    // скрывала бы этот факт и делала бы проверку бессмысленной.
    Object.defineProperty(instance, "variantProperties", {
      configurable: true,
      enumerable: true,
      get: function () {
        var main = instanceMain(instance);
        return (main && main.variantProperties) || null;
      },
    });
    instance.swapComponent = function (next) {
      if (!next || next.type !== "COMPONENT") throw new Error("swapComponent ждёт COMPONENT");
      calls.swapComponent += 1;
      // Не через сеттер mainComponent: тот моделирует прямое назначение
      // мастера и берёт его размер, а подмена размер вложенного слоя сохраняет.
      instance.__mainComponent = next;
      while (instance.children.length) instance.children[0].remove();
      instance.__layout = Object.assign({}, next.__layout);
      for (var i = 0; i < next.children.length; i++) instance.appendChild(cloneNode(next.children[i]));
      // Измерено (nested-swap-width): вложенный инстанс после подмены
      // сохраняет прежний размер, а не берёт размер нового мастера.
      if (!insideInstance(instance)) {
        instance.width = next.width;
        instance.height = next.height;
      }
      recordMasterSizes(instance, next);
      // Измерено (swap-keeps-fill): подмена не отменяет слот в родителе —
      // растянутый инстанс после неё снова получает размер от раскладки.
      relayoutFrom(instance);
      relayoutFrom(instance.parent);
    };
  }

  function makeComponent() {
    var component = makeNode("COMPONENT");
    calls.createComponent += 1;
    Object.defineProperty(component, "exposedInstances", {
      configurable: true,
      enumerable: true,
      get: function () {
        var exposed = [];
        walkNode(component, function (node) {
          if (node !== component && node.type === "INSTANCE" && node.isExposedInstance === true) exposed.push(node);
        });
        return exposed;
      },
    });
    // Сколько вхождений этого мастера уже создано. Двойник держит это число
    // ради одного инварианта, который иначе не проверить (см.
    // `assertNoInstances`).
    component.__instanceCount = 0;
    component.componentPropertyDefinitions = Object.create(null);
    component.addComponentProperty = function (name, type, defaultValue) {
      return addComponentProperty(component, name, type, defaultValue);
    };
    component.createInstance = function () {
      calls.createInstance += 1;
      component.__instanceCount += 1;
      var instance = makeNode("INSTANCE");
      instance.name = component.name;
      // Инстанс наследует раскладку и заливки мастера: без этого нельзя
      // проверить, что частичная правка меняет только свои поля. Раскладка
      // копируется ЦЕЛИКОМ — отступы мастера входят в его HUG-размер так же,
      // как режимы осей, и инстанс без них обнимает содержимое иначе.
      instance.__layout = Object.assign({}, component.__layout);
      instance.fills = component.fills;
      instance.strokes = component.strokes;
      attachInstance(instance, component);
      for (var i = 0; i < component.children.length; i++) {
        instance.appendChild(cloneNode(component.children[i]));
      }
      instance.width = component.width;
      instance.height = component.height;
      // Дети добавлялись, пока у инстанса был размер по умолчанию: раскладка
      // успела ужать растущие слои. В Figma инстанс сразу равен мастеру.
      relayoutSubtree(instance);
      recordMasterSizes(instance, component);
      return instance;
    };
    return component;
  }

  /**
   * Разбор имени участника набора вариантов — тот же, что делает Figma.
   *
   * Двойник СТРОЖЕ редактора намеренно: настоящая Figma принимает и то, что
   * в `axis=value` не раскладывается, дописывая собственные «Property 1».
   * Здесь такой вызов падает, потому что для приёмника это дефект: имя
   * участника обязано приезжать уже проверенной координатой.
   */
  function variantPairsFromName(name) {
    var parts = String(name === undefined || name === null ? "" : name).split(",");
    var pairs = [];
    for (var i = 0; i < parts.length; i++) {
      var separator = parts[i].indexOf("=");
      if (separator < 0) return null;
      var axis = parts[i].slice(0, separator).trim();
      var value = parts[i].slice(separator + 1).trim();
      if (!axis || !value) return null;
      pairs.push({ axis: axis, value: value });
    }
    return pairs.length ? pairs : null;
  }

  /**
   * `figma.combineAsVariants(components, parent)`.
   *
   * Моделируется ровно то, на что опирается приёмник: набор становится
   * родителем участников, участники ОСТАЮТСЯ узлами COMPONENT со своей
   * идентичностью, а их variant-координата выводится из имени. Существующие
   * инстансы при этом не трогаются — именно поэтому объединение можно делать
   * после создания вхождений.
   */
  /**
   * Переселять мастер, у которого УЖЕ есть вхождения, запрещено.
   *
   * Это не придирка двойника, а воспроизведение измеренного поведения живой
   * Figma: при смене родителя компонента хост заново разрешает существующие
   * вхождения, и выключенные из потока (`visible = false`) поддеревья
   * приезжают разложенными по геометрии мастера, а не по применённой дельте.
   * Дефект тихий — на видимых узлах он не проявляется, — поэтому здесь он
   * обязан быть громким.
   */
  function assertNoInstances(component, operation) {
    if (component && component.__instanceCount > 0) {
      throw new Error(operation + ": у участника «" + component.name + "» уже есть " +
        component.__instanceCount + " вхождений; переселение мастера после создания " +
        "вхождений переразрешает их по геометрии мастера");
    }
  }

  function combineAsVariants(components, parent) {
    if (!Array.isArray(components) || !components.length) {
      throw new Error("combineAsVariants ждёт непустой список компонентов");
    }
    if (!parent || !parent.children) throw new Error("combineAsVariants ждёт родителя-контейнер");
    var axesOrder = [];
    var axisValues = Object.create(null);
    var coordinates = Object.create(null);
    var parsed = [];
    for (var i = 0; i < components.length; i++) {
      var component = components[i];
      if (!component || component.type !== "COMPONENT") {
        throw new Error("combineAsVariants ждёт COMPONENT");
      }
      assertNoInstances(component, "combineAsVariants");
      var pairs = variantPairsFromName(component.name);
      if (!pairs) throw new Error("имя участника не раскладывается в variant-координату: " + component.name);
      var signature = pairs.map(function (pair) { return pair.axis; }).join("|");
      if (i === 0) {
        for (var a = 0; a < pairs.length; a++) {
          axesOrder.push(pairs[a].axis);
          axisValues[pairs[a].axis] = [];
        }
      } else if (signature !== axesOrder.join("|")) {
        throw new Error("участники набора объявляют разные оси: " + component.name);
      }
      var key = pairs.map(function (pair) { return pair.axis + "=" + pair.value; }).join(",");
      if (coordinates[key]) throw new Error("две одинаковые variant-координаты: " + key);
      coordinates[key] = true;
      for (var v = 0; v < pairs.length; v++) {
        if (axisValues[pairs[v].axis].indexOf(pairs[v].value) < 0) {
          axisValues[pairs[v].axis].push(pairs[v].value);
        }
      }
      parsed.push(pairs);
    }

    var set = makeNode("COMPONENT_SET");
    set.name = components[0].name;
    parent.appendChild(set);
    for (var m = 0; m < components.length; m++) {
      set.appendChild(components[m]);
      var map = Object.create(null);
      for (var p = 0; p < parsed[m].length; p++) map[parsed[m][p].axis] = parsed[m][p].value;
      components[m].variantProperties = map;
    }
    var definitions = Object.create(null);
    for (var d = 0; d < axesOrder.length; d++) {
      definitions[axesOrder[d]] = {
        type: "VARIANT",
        variantOptions: axisValues[axesOrder[d]].slice(),
        defaultValue: axisValues[axesOrder[d]][0],
      };
    }
    set.componentPropertyDefinitions = definitions;
    set.addComponentProperty = function (name, type, defaultValue) {
      return addComponentProperty(set, name, type, defaultValue);
    };
    // Опоздавший участник входит в готовый набор тем же путём и под тем же
    // запретом: у него самого вхождений ещё быть не должно. Обёртка ставится
    // ПОСЛЕ первичной сборки — до неё схемы набора ещё не существует.
    var appendToSet = set.appendChild;
    set.appendChild = function (child) {
      var isLateMember = !!(child && child.type === "COMPONENT" && child.parent !== set);
      if (isLateMember) assertNoInstances(child, "COMPONENT_SET.appendChild");
      var result = appendToSet.call(set, child);
      if (!isLateMember) return result;
      var latePairs = variantPairsFromName(child.name);
      if (!latePairs) throw new Error("имя участника не раскладывается в variant-координату: " + child.name);
      var lateMap = Object.create(null);
      for (var lp = 0; lp < latePairs.length; lp++) {
        lateMap[latePairs[lp].axis] = latePairs[lp].value;
        var definition = set.componentPropertyDefinitions[latePairs[lp].axis];
        if (!definition) {
          throw new Error("участник объявляет ось, которой в наборе нет: " + latePairs[lp].axis);
        }
        if (definition.variantOptions.indexOf(latePairs[lp].value) < 0) {
          definition.variantOptions.push(latePairs[lp].value);
        }
      }
      child.variantProperties = lateMap;
      return result;
    };
    calls.combineAsVariants += 1;
    return set;
  }

  function makePage(name) {
    var page = makeNode("PAGE");
    page.name = name;
    page.selection = [];
    page.loadAsync = function () { return Promise.resolve(); };
    pages.push(page);
    return page;
  }

  var firstPage = makePage("Page 1");
  var figma = {
    mixed: { mixed: true },
    root: { name: "Headless", get children() { return pages; } },
    currentPage: firstPage,
    setCurrentPageAsync: function (page) { figma.currentPage = page; return Promise.resolve(); },
    createPage: function () { calls.createPage += 1; return makePage("Page " + (pages.length + 1)); },
    createFrame: function () { calls.createFrame += 1; return makeNode("FRAME"); },
    createSection: function () { return makeNode("SECTION"); },
    createText: function () { calls.createText += 1; return makeNode("TEXT"); },
    createRectangle: function () { return makeNode("RECTANGLE"); },
    createEllipse: function () { return makeNode("ELLIPSE"); },
    createLine: function () { return makeNode("LINE"); },
    createPolygon: function () { return makeNode("POLYGON"); },
    createStar: function () { return makeNode("STAR"); },
    createVector: function () { calls.createVector += 1; return makeNode("VECTOR"); },
    createBooleanOperation: function () { return makeNode("BOOLEAN_OPERATION"); },
    createComponent: makeComponent,
    combineAsVariants: combineAsVariants,
    createPaintStyle: function () { calls.createPaintStyle += 1; return makeStyle("PAINT"); },
    createTextStyle: function () { calls.createTextStyle += 1; return makeStyle("TEXT"); },
    createEffectStyle: function () { calls.createEffectStyle += 1; return makeStyle("EFFECT"); },
    createImage: function (bytes) {
      calls.createImage += 1;
      return { hash: "image-" + (bytes ? bytes.length : 0) };
    },
    loadFontAsync: function () { return Promise.resolve(); },
    viewport: { scrollAndZoomIntoView: function () {} },
    ui: { postMessage: function () {} },
    notify: function () {},
  };

  return {
    figma: figma,
    calls: calls,
    pages: function () { return pages; },
    /**
     * Приводит все инстансы к СОХРАНЁННОМУ состоянию — тому, что живая Figma
     * покажет после пересчёта (раскрытия слоя, перезагрузки файла). Чтение
     * сразу после правок в живой Figma закешировано и скрывает размеры,
     * которые не сохранились (FIGMA_CAPABILITIES.md). Сверки результата
     * импорта обязаны читать это состояние.
     */
    materializeStoredState: function () {
      pages.forEach(function (page) {
        if (page.removed) return;
        walkNode(page, function (node) { if (node.type === "INSTANCE") materializeStoredInstance(node); });
        relayoutSubtree(page);
      });
    },
    styles: function () { return styles; },
  };
}

/**
 * Ставит двойника глобальным `figma` и отдаёт модуль приёмника.
 *
 * Порядок обязателен: модуль приёмника читает `typeof figma` при загрузке и,
 * увидев хост, вызвал бы `setup()` с UI. Поэтому он загружается ДО установки
 * глобали, а хост появляется уже после.
 */
function install(receiverPath) {
  var receiver = require(receiverPath);
  var host = createHost();
  global.figma = host.figma;
  host.receiver = receiver;
  return host;
}

module.exports = { createHost: createHost, install: install };
