/**
 * Публичная идентичность свойства компонента (`parentPropDefId`).
 *
 * Измеренный факт формата: `componentPropAssignment.defID` и
 * `componentPropRef.defID` часто называют РАЗНЫЕ локальные определения одного
 * и того же публичного свойства. Локальные определения заводит каждый вариант
 * группы состояний, а сходятся они в корне цепочки `parentPropDefId`:
 *
 *   FRAME isStateGroup
 *     public P                       parentPropDefId = 0:0
 *     SYMBOL вариант A   local A  →  P
 *     SYMBOL вариант B   local B  →  P
 *
 * Вхождение варианта A может прислать назначение на defID варианта B. Сырое
 * сравнение `assignment.defID == ref.defID` такую запись теряет; сравнение
 * `publicOf(assignment.defID) == publicOf(ref.defID)` — находит.
 *
 * Фикстура проверяет ровно это и ничего сверх: разрешается идентичность, а
 * низкоуровневые операции остаются прежними. Ни одно решение здесь не
 * принимается по имени свойства, слоя или компонента — имена в фикстуре
 * намеренно расставлены так, чтобы совпадение по имени давало ДРУГОЙ ответ.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var Fixture = require("./Fixture");
var PixContainer = require("../PixContainer");
var PixDocument = require("../PixDocument");
var MigrationIR = require("../MigrationIR");
var ComponentProperties = require("../ComponentProperties");

var checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }
function eq(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }
function guid(id) { return Fixture.guid(id); }
function parent(id, position) { return { guid: guid(id), position: position }; }
function matrix(x, y) { return { m00: 1, m01: 0, m02: x || 0, m10: 0, m11: 1, m12: y || 0 }; }
function ref(id, field) { return { defID: guid(id), componentPropNodeField: field }; }

/** Определение свойства. `parentId` = null означает публичный корень. */
function def(id, name, type, parentId, initialValue) {
  var out = {
    id: guid(id), name: name, type: type,
    parentPropDefId: parentId ? guid(parentId) : guid("0:0"),
  };
  if (initialValue !== undefined) out.initialValue = initialValue;
  return out;
}

var ids = {
  document: "9:1", library: "9:2", page: "9:3",
  group: "9:10",
  variantA: "9:11", aText: "9:12", aBool: "9:13", aIcon: "9:14", aDeep: "9:15",
  variantB: "9:20", bText: "9:21", bBool: "9:22",
  defaultIcon: "9:30", defaultIconChild: "9:31",
  assignedIcon: "9:32", assignedIconChild: "9:33",
  root: "9:40", occurrenceA: "9:41", occurrenceB: "9:42",

  // Публичные определения группы состояний.
  pText: "9:100", pBool: "9:101", pIcon: "9:102", pDeep: "9:103", pStale: "9:104",
  // Испорченные цепочки: оборванный родитель и цикл.
  danglingDef: "9:110", missingParent: "9:199",
  cycleOne: "9:120", cycleTwo: "9:121",
  // Локальные определения варианта A.
  aTextDef: "9:130", aBoolDef: "9:131", aIconDef: "9:132",
  aDeepMid: "9:133", aDeepLeaf: "9:134", aStaleDef: "9:135", aStale: "9:16",
  // Локальные определения варианта B.
  bTextDef: "9:140", bBoolDef: "9:141",
  // Определение, которого в документе нет вовсе (внешняя библиотека).
  externalDef: "9:150",
  // Начало цепочки длиннее потолка обхода.
  deepChainHead: "9:200",
};

/** Цепочка родителей длиннее `ComponentProperties.MAX_DEPTH`. */
var overlongChain = [];
var OVERLONG = ComponentProperties.MAX_DEPTH + 8;
for (var c = 0; c < OVERLONG; c++) {
  var self = "9:" + (200 + c);
  var next = c === OVERLONG - 1 ? null : "9:" + (201 + c);
  overlongChain.push(def(self, "chain" + c, "BOOL", next));
}

function iconSymbol(symbolId, childId, name) {
  return [
    {
      guid: guid(symbolId), type: "SYMBOL", name: name, componentKey: "icon-" + name,
      parentIndex: parent(ids.library, symbolId), transform: matrix(), size: { x: 20, y: 20 },
    },
    {
      guid: guid(childId), type: "FRAME", name: "Vector",
      parentIndex: parent(symbolId, "a"), transform: matrix(), size: { x: 20, y: 20 },
    },
  ];
}

var nodes = [
  { guid: guid(ids.document), type: "DOCUMENT", name: "Doc" },
  { guid: guid(ids.library), type: "CANVAS", name: "Library", parentIndex: parent(ids.document, "a"), internalOnly: true },
  { guid: guid(ids.page), type: "CANVAS", name: "Screen", parentIndex: parent(ids.document, "b") },
]
  .concat(iconSymbol(ids.defaultIcon, ids.defaultIconChild, "default"))
  .concat(iconSymbol(ids.assignedIcon, ids.assignedIconChild, "assigned"))
  .concat([
    // --- Группа состояний: здесь живут ПУБЛИЧНЫЕ определения ---------------
    {
      guid: guid(ids.group), type: "FRAME", name: "Группа", isStateGroup: true,
      parentIndex: parent(ids.library, "z"), transform: matrix(), size: { x: 200, y: 60 },
      componentPropDef: [
        def(ids.pText, "label", "TEXT", null, { textValue: { characters: "По умолчанию" } }),
        def(ids.pBool, "extra", "BOOL", null, { boolValue: true }),
        def(ids.pIcon, "icon", "INSTANCE_SWAP", null, { guidValue: guid(ids.defaultIcon) }),
        def(ids.pDeep, "deep", "BOOL", null, { boolValue: true }),
        // Stale public metadata from an old library revision: the public def
        // still says INSTANCE_SWAP, while the local consumer is VISIBLE and
        // assignments are boolValue. D34 must trust unanimous consumer refs.
        def(ids.pStale, "stale-visible", "INSTANCE_SWAP", null, { guidValue: guid(ids.defaultIcon) }),
        // Определение, объявленный родитель которого в документе отсутствует.
        def(ids.danglingDef, "оборванное", "BOOL", ids.missingParent),
        // Два определения, замкнутые друг на друга.
        def(ids.cycleOne, "цикл-один", "BOOL", ids.cycleTwo),
        def(ids.cycleTwo, "цикл-два", "BOOL", ids.cycleOne),
      ].concat(overlongChain),
    },

    // --- Вариант A ---------------------------------------------------------
    {
      guid: guid(ids.variantA), type: "SYMBOL", name: "state=default", componentKey: "row",
      parentIndex: parent(ids.group, "a"), transform: matrix(), size: { x: 200, y: 24 },
      componentPropDef: [
        def(ids.aTextDef, "label", "TEXT", ids.pText),
        def(ids.aBoolDef, "extra", "BOOL", ids.pBool),
        def(ids.aIconDef, "icon", "INSTANCE_SWAP", ids.pIcon),
        // Цепочка глубины 2: лист → середина → публичный корень.
        def(ids.aDeepMid, "deep", "BOOL", ids.pDeep),
        def(ids.aDeepLeaf, "deep", "BOOL", ids.aDeepMid),
        def(ids.aStaleDef, "stale-visible", "INSTANCE_SWAP", ids.pStale),
      ],
    },
    {
      guid: guid(ids.aText), type: "TEXT", name: "Подпись A",
      parentIndex: parent(ids.variantA, "a"), transform: matrix(), size: { x: 100, y: 20 },
      textData: { characters: "По умолчанию" },
      componentPropRef: [ref(ids.aTextDef, "TEXT_DATA")],
    },
    {
      guid: guid(ids.aBool), type: "FRAME", name: "Довесок A",
      parentIndex: parent(ids.variantA, "b"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropRef: [ref(ids.aBoolDef, "VISIBLE")],
    },
    {
      guid: guid(ids.aIcon), type: "INSTANCE", name: "Иконка A",
      parentIndex: parent(ids.variantA, "c"), transform: matrix(), size: { x: 20, y: 20 },
      symbolData: { symbolID: guid(ids.defaultIcon) },
      componentPropRef: [ref(ids.aIconDef, "OVERRIDDEN_SYMBOL_ID")],
    },
    {
      // Узел читает ЛИСТ цепочки глубины 2, а назначение придёт на её середину.
      guid: guid(ids.aDeep), type: "FRAME", name: "Глубина A",
      parentIndex: parent(ids.variantA, "d"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropRef: [ref(ids.aDeepLeaf, "VISIBLE")],
    },
    {
      guid: guid(ids.aStale), type: "FRAME", name: "Stale metadata visibility",
      parentIndex: parent(ids.variantA, "e"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropRef: [ref(ids.aStaleDef, "VISIBLE")],
    },

    // --- Вариант B: те же публичные свойства, свои локальные псевдонимы ----
    {
      guid: guid(ids.variantB), type: "SYMBOL", name: "state=hover", componentKey: "row",
      parentIndex: parent(ids.group, "b"), transform: matrix(0, 30), size: { x: 200, y: 24 },
      componentPropDef: [
        def(ids.bTextDef, "label", "TEXT", ids.pText),
        def(ids.bBoolDef, "extra", "BOOL", ids.pBool),
      ],
    },
    {
      guid: guid(ids.bText), type: "TEXT", name: "Подпись B",
      parentIndex: parent(ids.variantB, "a"), transform: matrix(), size: { x: 100, y: 20 },
      textData: { characters: "По умолчанию" },
      componentPropRef: [ref(ids.bTextDef, "TEXT_DATA")],
    },
    {
      guid: guid(ids.bBool), type: "FRAME", name: "Довесок B",
      parentIndex: parent(ids.variantB, "b"), transform: matrix(), size: { x: 20, y: 20 },
      componentPropRef: [ref(ids.bBoolDef, "VISIBLE")],
    },

    // --- Сцена -------------------------------------------------------------
    { guid: guid(ids.root), type: "FRAME", name: "Root", parentIndex: parent(ids.page, "a"), transform: matrix(), size: { x: 400, y: 200 } },
    {
      guid: guid(ids.occurrenceA), type: "INSTANCE", name: "Строка A",
      parentIndex: parent(ids.root, "a"), transform: matrix(), size: { x: 200, y: 24 },
      symbolData: {
        symbolID: guid(ids.variantA),
        symbolOverrides: [
          {
            guidPath: { guids: [] },
            componentPropAssignment: [
              // A. Псевдоним СОСЕДНЕГО варианта: узел-цель читает свой defID.
              { defID: guid(ids.bTextDef), value: { textValue: { characters: "Из соседа" } } },
              // C. Сырая идентичность: назначение называет defID самого варианта.
              { defID: guid(ids.aBoolDef), value: { boolValue: false } },
              // I. INSTANCE_SWAP через собственный псевдоним варианта.
              { defID: guid(ids.aIconDef), value: { guidValue: guid(ids.assignedIcon) } },
              // B. Цепочка глубины >1: назначение на середину, чтение — с листа.
              { defID: guid(ids.aDeepMid), value: { boolValue: false } },
              { defID: guid(ids.aStaleDef), value: { boolValue: false } },
              // D. Определения нет в документе: внешняя библиотека.
              { defID: guid(ids.externalDef), value: { boolValue: true } },
              // E. Родитель определения отсутствует.
              { defID: guid(ids.danglingDef), value: { boolValue: true } },
              // F. Цепочка родителей замкнута.
              { defID: guid(ids.cycleOne), value: { boolValue: true } },
              // Цепочка длиннее потолка обхода.
              { defID: guid(ids.deepChainHead), value: { boolValue: true } },
            ],
          },
          // J. Raw запись на том же bound-узле может присутствовать в source, но
          // componentPropertyReferences делает BOOLEAN официальным владельцем visible.
          { guidPath: { guids: [guid(ids.aBool)] }, visible: true, opacity: 0.25 },
          // K. То же для TEXT: когда characters привязан к component property,
          // значение occurrence маршрутизируется через этот property.
          { guidPath: { guids: [guid(ids.aText)] }, textData: { characters: "Фактический текст" } },
        ],
      },
    },
    {
      guid: guid(ids.occurrenceB), type: "INSTANCE", name: "Строка B",
      parentIndex: parent(ids.root, "b"), transform: matrix(0, 40), size: { x: 200, y: 24 },
      symbolData: {
        symbolID: guid(ids.variantB),
        symbolOverrides: [
          {
            guidPath: { guids: [] },
            componentPropAssignment: [
              // G. То же ПУБЛИЧНОЕ свойство, но другой вариант: цель обязана
              // остаться своей, а не схлопнуться с целью варианта A.
              { defID: guid(ids.aBoolDef), value: { boolValue: false } },
            ],
          },
        ],
      },
    },
  ]);

var temp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-public-props-"));
try {
  var file = path.join(temp, "public-props.pix");
  fs.writeFileSync(file, Fixture.buildContainer({ build: { nodes: nodes, blobs: [], resources: [] } }).zip);
  var doc = PixDocument.load(PixContainer.open(file));

  // ======================================================================
  // Резолвер: статусы, глубина, цикл, потолок
  // ======================================================================
  var resolver = doc.componentProperties;
  ok(resolver, "документ отдаёт реестр публичной идентичности свойств");

  var S = ComponentProperties.STATUS;

  // C. Публичное определение разрешается в само себя, глубина 0.
  var publicRoot = resolver.publicOf(ids.pBool);
  eq(publicRoot.status, S.RESOLVED, "публичное определение разрешено");
  eq(publicRoot.publicId, ids.pBool, "публичный корень — оно само");
  eq(publicRoot.depth, 0, "глубина публичного определения равна нулю");

  // A. Псевдонимы двух вариантов сходятся в одном публичном корне.
  eq(resolver.publicOf(ids.aBoolDef).publicId, ids.pBool, "псевдоним варианта A ведёт к публичному");
  eq(resolver.publicOf(ids.bBoolDef).publicId, ids.pBool, "псевдоним варианта B ведёт к тому же публичному");
  ok(ids.aBoolDef !== ids.bBoolDef, "сырые идентичности вариантов действительно различны");

  // B. Глубина больше единицы.
  var deep = resolver.publicOf(ids.aDeepLeaf);
  eq(deep.status, S.RESOLVED, "цепочка глубины 2 разрешена");
  eq(deep.publicId, ids.pDeep, "лист цепочки ведёт к публичному корню");
  eq(deep.depth, 2, "глубина цепочки посчитана, а не предположена");

  // D. Определения нет в документе.
  eq(resolver.publicOf(ids.externalDef).status, S.MISSING_DEF,
    "отсутствующее определение названо отсутствующим, а не разрешено по имени");

  // E. Родитель отсутствует.
  eq(resolver.publicOf(ids.danglingDef).status, S.DANGLING_PARENT,
    "оборванная цепочка типизирована отдельно от отсутствующего определения");

  // F. Цикл.
  eq(resolver.publicOf(ids.cycleOne).status, S.CYCLE, "цикл обнаружен, а не пройден бесконечно");
  eq(resolver.publicOf(ids.cycleTwo).status, S.CYCLE, "обе стороны цикла типизированы одинаково");

  // Потолок глубины.
  eq(resolver.publicOf(ids.deepChainHead).status, S.DEPTH_EXCEEDED,
    "цепочка длиннее потолка остановлена потолком");

  // `0:0` значения не имеет.
  eq(resolver.publicOf("0:0").status, S.MISSING_DEF, "`0:0` — не идентичность");

  // Кэш отвечает тем же результатом.
  eq(resolver.publicOf(ids.aDeepLeaf).publicId, ids.pDeep, "повторное разрешение отдаёт тот же корень");
  ok(resolver.stats.cacheHits > 0, "успешные и неуспешные разрешения кэшируются");

  // Имена намеренно совпадают у разных публичных свойств — резолвер обязан
  // различать их только по guid.
  ok(resolver.publicOf(ids.aDeepMid).publicId !== resolver.publicOf(ids.aBoolDef).publicId,
    "одинаковые имена свойств не сливаются в одну идентичность");

  // ======================================================================
  // IR: идентичность разрешается, низкоуровневые операции прежние
  // ======================================================================
  var ir = MigrationIR.build(doc, { roots: [doc.tree.byKey.get(ids.root)], debugOverrides: true });
  var rootNodes = ir.roots[0].nodes;
  var occA = rootNodes.filter(function (n) { return n.id === ids.occurrenceA; })[0];
  var occB = rootNodes.filter(function (n) { return n.id === ids.occurrenceB; })[0];
  ok(occA && occB, "оба вхождения попали в IR");

  // Ticket 05: те же публичные identities теперь едут и как нативная схема,
  // не заменяя проверенный low-level replay ниже.
  var defA = ir.definitions.filter(function (d) { return d.definitionId === ids.variantA; })[0];
  ok(defA, "определение варианта A присутствует");
  var nativeById = Object.create(null);
  (defA.nativeProperties || []).forEach(function (p) { nativeById[p.propertyId] = p; });
  eq(nativeById[ids.pText].type, "TEXT", "TEXT объявлен нативным свойством");
  eq(nativeById[ids.pText].defaultValue, "По умолчанию", "TEXT default взят из публичного def");
  eq(nativeById[ids.pBool].type, "BOOLEAN", "BOOL объявлен BOOLEAN");
  eq(nativeById[ids.pBool].defaultValue, true, "BOOL default взят из публичного def");
  eq(nativeById[ids.pIcon].type, "INSTANCE_SWAP", "INSTANCE_SWAP объявлен нативно");
  eq(nativeById[ids.pIcon].defaultValue, ids.defaultIcon,
    "INSTANCE_SWAP default нормализован до канонического definitionId");
  eq(nativeById[ids.pStale].type, "BOOLEAN",
    "stale INSTANCE_SWAP metadata восстанавливается как BOOLEAN по unanimous VISIBLE refs");

  var defTextNode = defA.nodes.filter(function (n) { return n.id === ids.aText; })[0];
  var defBoolNode = defA.nodes.filter(function (n) { return n.id === ids.aBool; })[0];
  var defIconNode = defA.nodes.filter(function (n) { return n.id === ids.aIcon; })[0];
  eq(defTextNode.componentPropertyReferences.characters, ids.pText,
    "TEXT binding ссылается на public identity, не локальный alias");
  eq(defBoolNode.componentPropertyReferences.visible, ids.pBool,
    "BOOL binding ссылается на public identity");
  eq(defIconNode.componentPropertyReferences.mainComponent, ids.pIcon,
    "INSTANCE_SWAP binding ссылается на public identity");

  var nativeOcc = Object.create(null);
  (occA.nativeProperties || []).forEach(function (p) { nativeOcc[p.propertyId] = p; });
  eq(nativeOcc[ids.pText].type, "TEXT", "назначение TEXT едет как native value");
  eq(nativeOcc[ids.pText].value, "Из соседа", "native TEXT сохраняет formal assignment");
  eq(nativeOcc[ids.pBool].type, "BOOLEAN", "назначение BOOL едет как native value");
  eq(nativeOcc[ids.pBool].value, false, "native BOOL сохраняет formal assignment");
  eq(nativeOcc[ids.pIcon].type, "INSTANCE_SWAP", "назначение swap едет как native value");
  eq(nativeOcc[ids.pIcon].swapDefinitionId, ids.assignedIcon,
    "native swap ссылается на каноническое определение назначения");
  eq(nativeOcc[ids.pStale].type, "BOOLEAN", "stale metadata assignment едет BOOLEAN");
  eq(nativeOcc[ids.pStale].value, false, "boolValue stale metadata сохраняет false");

  function opOn(occurrence, sourceId, field) {
    var hits = (occurrence.overrides || []).filter(function (entry) {
      return entry.path.length === 1 && entry.path[0].sourceId === sourceId &&
        entry.ops[field] !== undefined;
    });
    return hits.length ? hits[0] : null;
  }

  // A. Псевдоним соседнего варианта доехал до узла ЭТОГО варианта.
  var textOp = opOn(occA, ids.aText, "characters");
  ok(textOp, "назначение по псевдониму соседнего варианта нашло свою привязку");
  eq(textOp.ops.characters, "Из соседа", "bound characters следуют formal TEXT component property");
  ok(textOp.nativeOwners && textOp.nativeOwners.characters,
    "formal native TEXT владеет characters");

  // I + C. Сырая идентичность продолжает работать, операции те же.
  var boolOp = opOn(occA, ids.aBool, "visible");
  ok(boolOp, "BOOL по собственному псевдониму варианта по-прежнему привязывается");
  eq(boolOp.ops.visible, false,
    "bound visibility следует formal BOOL component property");
  ok(boolOp.nativeOwners && boolOp.nativeOwners.visible,
    "formal native BOOL владеет visibility");

  var swapOp = opOn(occA, ids.aIcon, "swapDefinitionId");
  ok(swapOp, "INSTANCE_SWAP по-прежнему привязывается");
  eq(swapOp.ops.swapDefinitionId, ids.assignedIcon, "подменяется именно назначенный символ");

  // B. Назначение на середину цепочки нашло узел, читающий её лист.
  var deepOp = opOn(occA, ids.aDeep, "visible");
  ok(deepOp, "назначение на середину цепочки нашло узел, читающий её лист");
  eq(deepOp.ops.visible, false, "цепочка глубины >1 опустилась в ту же ops.visible");
  var staleOp = opOn(occA, ids.aStale, "visible");
  ok(staleOp, "stale public INSTANCE_SWAP не теряет VISIBLE consumer");
  eq(staleOp.ops.visible, false, "stale public type не превращает boolValue в swap");

  // G. Одно публичное свойство, два варианта — цели НЕ схлопнуты.
  var boolOpB = opOn(occB, ids.bBool, "visible");
  ok(boolOpB, "вариант B получил свою правку по тому же публичному свойству");
  eq(boolOpB.ops.visible, false, "значение доехало и во втором варианте");
  ok(!opOn(occB, ids.aBool, "visible"),
    "цель варианта A не появилась во вхождении варианта B");
  ok(!opOn(occA, ids.bBool, "visible"),
    "цель варианта B не появилась во вхождении варианта A");
  ok(boolOp.path[0].sourceId !== boolOpB.path[0].sourceId,
    "общее публичное свойство не схлопнуло идентичность целей");

  // H. Между копиями ничего не наводится: узлы чужого определения не
  // адресуются ни одним вхождением.
  (occA.overrides || []).forEach(function (entry) {
    entry.path.forEach(function (step) {
      ok(step.sourceId !== ids.bText && step.sourceId !== ids.bBool,
        "вхождение варианта A не адресует узлы варианта B");
    });
  });

  // J. Неуправляемые поля raw override сохраняются, но bound visible остаётся
  // во владении formal component property.
  eq(boolOp.ops.opacity, 0.25, "явная запись override не потеряна и не переупорядочена");
  eq(boolOp.ops.visible, false, "bound visible следует formal component property");

  // ======================================================================
  // Отчёт: причинные классы разделены и измеримы
  // ======================================================================
  var report = ir.componentPropertyReport;
  ok(report, "отчёт об идентичности свойств присутствует");
  eq(report.assignmentsTotal, 10, "посчитаны все назначения обоих вхождений");
  eq(report.resolvedPublicIdentity, 6, "пять назначений нашли привязку");
  // Псевдоним соседнего варианта — ровно тот случай, ради которого заведена
  // публичная идентичность: по сырому defID он бы не совпал. Таких здесь три:
  // текст соседа и середина цепочки во вхождении A, плюс всё вхождение B,
  // которому прислали псевдоним варианта A.
  eq(report.recoveredByPublicIdentity, 3,
    "восстановлены оба псевдонима соседнего варианта и назначение на середину цепочки");
  eq(report.resolvedRawIdentity, 3, "два назначения совпали бы и по сырому defID");
  eq(report.externalDef, 1, "отсутствующее определение отнесено к внешним");
  eq(report.danglingParent, 1, "оборванный родитель посчитан отдельно");
  eq(report.resolutionCycle, 1, "цикл посчитан отдельно");
  eq(report.resolutionDepthExceeded, 1, "переполнение глубины посчитано отдельно");
  eq(report.notBound, 0, "настоящих «никто не читает» в этой фикстуре нет");
  eq(report.recoveredByType.TEXT, 1, "разбивка по типам сохранена: TEXT");
  eq(report.recoveredByType.BOOL, 2, "разбивка по типам сохранена: BOOL");
  ok(report.recoveredSamples.length >= 1, "восстановленные случаи представлены образцами");
  var sample = report.recoveredSamples.filter(function (s) {
    return s.assignmentDefId === ids.bTextDef;
  })[0];
  ok(sample, "образец псевдонима соседнего варианта присутствует");
  eq(sample.publicDefId, ids.pText, "образец называет общий публичный корень");
  eq(sample.bindingDefIds[0], ids.aTextDef, "образец называет локальный def привязки");
  eq(sample.targetNodeIds[0], ids.aText, "образец называет узел-цель");

  // Причины отказа доехали до общей таксономии resolver.
  eq(ir.overrideResolution.COMPONENT_PROPERTY_EXTERNAL_DEF, 1, "внешнее определение названо своим кодом");
  eq(ir.overrideResolution.COMPONENT_PROPERTY_PUBLIC_DEF_DANGLING, 1, "оборванный родитель назван своим кодом");
  eq(ir.overrideResolution.COMPONENT_PROPERTY_RESOLUTION_CYCLE, 1, "цикл назван своим кодом");
  eq(ir.overrideResolution.COMPONENT_PROPERTY_RESOLUTION_DEPTH_EXCEEDED, 1, "переполнение названо своим кодом");
  ok(!ir.overrideResolution.COMPONENT_PROPERTY_NOT_BOUND,
    "сбой разрешения идентичности не выдаётся за «свойство никто не читает»");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// D58: raw ComponentPropDef GUIDs are scoped, not document-global.
// The same raw id can be a local BOOL alias in one published family and an
// unrelated INSTANCE_SWAP root in another. Context must select the family.
var collisionTree = { records: [], byKey: new Map() };
function collisionRecord(key, parentKey, type, isStateGroup, publishFile, publishId, defs) {
  var rec = { key: key, parentKey: parentKey || null, type: type, isStateGroup: !!isStateGroup,
    publishFile: publishFile || null, publishID: publishId ? guid(publishId) : null, propDefs: defs || [] };
  collisionTree.records.push(rec); collisionTree.byKey.set(key, rec); return rec;
}
collisionRecord("20:1", null, "FRAME", true, "footer-lib", "20:100", [
  def("30:1", "sirin", "BOOL", null),
]);
collisionRecord("20:2", "20:1", "SYMBOL", false, "footer-lib", "20:101", [
  def("31:1", "sirin", "BOOL", "30:1"),
]);
collisionRecord("21:1", null, "FRAME", true, "avatar-lib", "21:100", [
  // Deliberate collision with footer's local alias.
  def("31:1", "iconBadge 24", "INSTANCE_SWAP", null),
]);
var collisionResolver = ComponentProperties.build(collisionTree);
var footerScoped = collisionResolver.publicOfScoped("31:1", "20:2");
var avatarScoped = collisionResolver.publicOfScoped("31:1", "21:1");
eq(footerScoped.status, ComponentProperties.STATUS.RESOLVED, "collision: footer alias resolves in footer namespace");
eq(footerScoped.publicId, "30:1", "collision: footer alias does not become avatar property");
eq(avatarScoped.status, ComponentProperties.STATUS.RESOLVED, "collision: avatar root resolves in avatar namespace");
eq(avatarScoped.publicId, "31:1", "collision: avatar property keeps its own raw id");
eq(collisionResolver.publicOf("31:1").status, ComponentProperties.STATUS.AMBIGUOUS_DEF,
  "collision: context-free lookup fails closed instead of choosing last writer");

// D59: a raw local alias may collide with a sibling variant inside the SAME
// published ComponentSet. The ref's concrete owner disambiguates depth 0; the
// parent hop then resolves against the public set namespace.
var siblingTree = { records: [], byKey: new Map() };
function siblingRecord(key, parentKey, type, isStateGroup, publishFile, publishId, defs) {
  var rec = { key: key, parentKey: parentKey || null, type: type, isStateGroup: !!isStateGroup,
    publishFile: publishFile || null, publishID: publishId ? guid(publishId) : null, propDefs: defs || [] };
  siblingTree.records.push(rec); siblingTree.byKey.set(key, rec); return rec;
}
siblingRecord("40:1", null, "FRAME", true, "fn-lib", "40:100", [
  def("50:1", "iconLeft", "BOOL", null),
  def("50:2", "iconLeft 16", "INSTANCE_SWAP", null),
]);
siblingRecord("40:2", "40:1", "SYMBOL", false, "fn-lib", "40:101", [
  def("51:1", "iconLeft", "BOOL", "50:1"),
  def("51:2", "iconLeft 16", "INSTANCE_SWAP", "50:2"),
]);
// Same raw ids reused by another variant as stale roots. Namespace-only lookup
// is ambiguous, but a componentPropRef on 40:2 must still resolve formally.
siblingRecord("40:3", "40:1", "SYMBOL", false, "fn-lib", "40:102", [
  def("51:1", "iconLeft", "BOOL", null),
  def("51:2", "iconLeft 16", "INSTANCE_SWAP", null),
]);
var siblingResolver = ComponentProperties.build(siblingTree);
var leftBool = siblingResolver.publicOfScoped("51:1", "40:2");
var leftSwap = siblingResolver.publicOfScoped("51:2", "40:2");
eq(leftBool.status, ComponentProperties.STATUS.RESOLVED, "sibling collision: BOOL alias resolves by concrete owner");
eq(leftBool.publicId, "50:1", "sibling collision: BOOL reaches set-level public property");
eq(leftSwap.status, ComponentProperties.STATUS.RESOLVED, "sibling collision: swap alias resolves by concrete owner");
eq(leftSwap.publicId, "50:2", "sibling collision: swap reaches set-level public property");
eq(siblingResolver.publicOfScoped("51:1", "40:1").status, ComponentProperties.STATUS.AMBIGUOUS_DEF,
  "sibling collision: set-only context remains fail-closed");

process.stdout.write("OK: Direct PIX публичная идентичность свойств — " + checks + " проверок пройдено\n");
