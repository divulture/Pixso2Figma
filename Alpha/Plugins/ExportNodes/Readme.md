# Portable Exporter

Плагин для Pixso: извлекает **все данные** по выбранным узлам в переносимый JSON-пакет
`pixso-portable-package`. Это «полный режим» экспорта: дерево узлов со всеми свойствами,
определения компонентов и Component Set, пресеты инстансов, стили, переменные,
изображения, ссылки на иконки, шрифты, реакции прототипа, fingerprints и граф зависимостей.

Режим «только структура» реализован отдельным плагином `Plugin/structure-exporter`.

Только экспорт: плагин ничего не создаёт и не меняет в документе.

## Использование

1. Импортировать `Manifest.json` этой папки как dev-плагин в Pixso.
2. Выделить один или несколько узлов: `COMPONENT`, `COMPONENT_SET`, `INSTANCE`,
   `FRAME`/экран, `GROUP`, `SECTION`, текст, фигуры — поддерживается множественное выделение.
   Для миграции полного дизайна включить опцию **«Вся текущая страница»**: она экспортирует
   все canvas-узлы страницы в исходном порядке, а выделение при этом не требуется.
3. Запустить `Plugins → Portable Exporter`.
4. При необходимости нажать `Проанализировать` — счётчики зависимостей и предупреждения
   до экспорта.
5. Нажать `Экспортировать JSON` — файл скачивается автоматически; JSON можно также
   скопировать в буфер.

## Опции экспорта

| Опция | По умолчанию | Что делает |
|---|---|---|
| Зависимости компонентов | ✓ | Для каждого инстанса выгружает определение: `COMPONENT` или весь `COMPONENT_SET` с вариантами, свойствами и вложенными зависимостями |
| Стили | ✓ | Применённые style bindings (`fillStyleId` и др.) → сущности `styles` со значениями |
| Переменные | ✓ | `boundVariables` узлов → сущности `variables`/`variableCollections` (если Variables API доступен) |
| Изображения (base64) | ✓ | Байты картинок из `IMAGE`-заливок + content hash и mime |
| Реакции прототипа | ✓ | `reactions` узлов с разрешением целей в portable id |
| SVG для векторов | ✓ | `VECTOR`/`BOOLEAN_OPERATION` дополнительно сохраняются как SVG в `svgAssets`. Внутри поддеревьев инстансов SVG не дублируется (вектора уже есть в определении компонента); исключение — snapshot-поддерево при недоступном `mainComponent` |
| SVG-снимки иконок | ☐ | Векторный fallback для распознанных иконок (иначе иконка — только ссылка) |
| Поддеревья инстансов | ☐ | Разворачивать resolved-дерево каждого инстанса (пакет заметно тяжелеет) |
| Plugin data узлов | ☐ | Копировать plugin data всех узлов |
| Форматированный JSON | ✓ | Отступы 2 пробела; выключить для минификации |

## Формат пакета (верхний уровень)

```json
{
  "format": "pixso-portable-package",
  "schemaVersion": "1.0.0",
  "exportMode": "FULL",
  "createdAt": "…",
  "source": { "fileKey": "…", "fileName": "…", "pageName": "…", "pluginVersion": "…" },
  "roots": [{ "nodeRef": "node:…", "absolutePosition": { "x": 0, "y": 0 }, "zIndex": 0 }],
  "nodes": {},
  "components": {},
  "componentSets": {},
  "instances": {},
  "styles": {},
  "variableCollections": {},
  "variables": {},
  "images": {},
  "svgAssets": {},
  "iconDependencies": {},
  "fonts": [],
  "reactions": [],
  "dependencies": { "edges": [], "order": [] },
  "fingerprints": {},
  "diagnostics": []
}
```

Ключевые правила:

- У каждой сущности собственный стабильный `portableId`
  (`node:…`, `component:…`, `set:…`, `style:…`, `image:…`, `variable:…`).
  Pixso `node.id` не используется как идентичность — он сохраняется только в
  `source.pixsoNodeId` для диагностики. `portableId` детерминирован
  (hash от `fileKey + nodeId`), поэтому повторный экспорт даёт те же id.
- `nodes` — плоская карта; иерархия через `children: [id...]`. У узлов: размеры,
  позиция, auto layout (`layoutMode`, sizing, паддинги, spacing…), child-layout
  (`layoutAlign`, `layoutGrow`, min/max…), constraints, заливки/обводки/эффекты/скругления,
  style-ссылки, текстовые свойства (включая rich-text `segments`, если API позволяет).
- Инстанс = ссылка на определение + пресет (`instances[id].preset`):
  `variantProperties`, `componentProperties` (по логическим именам, суффикс `#12:34`
  срезан, но raw-имя сохранено в определении), `overrides` с путями
  `targetPath: [{name,type,index}]`, `exposedInstances`, `textOverrides`.
  Значения `INSTANCE_SWAP` разрешаются в `swapComponentRef` (компонент выгружается
  как зависимость).
- `Component Set`: `variantGroupProperties` (или восстановление из имён
  `Prop=Value`), свойства уровня сета, упорядоченные `componentRefs`,
  `defaultVariantRef`; каждый вариант — полноценный `COMPONENT` со своим деревом.
- `mainComponent === null` не ломает экспорт: инстанс помечается
  `availability: "SNAPSHOT_ONLY"`, его resolved-поддерево сохраняется как snapshot
  (диагностики `MAIN_COMPONENT_UNAVAILABLE`, `SNAPSHOT_FALLBACK_USED`).
- `dependencies.order` — топологический порядок: зависимости раньше зависимых
  (иконка → вариант → сет → экран). Циклы фиксируются диагностикой `DEPENDENCY_CYCLE`.
- `fingerprints` — для компонентов и сетов `contractHash` (имя, свойства, варианты)
  и `structuralHash` (контракт + нормализованное дерево без ID, позиций на канвасе
  и нестабильных суффиксов); считаются через канонический JSON + SHA-256 и стабильны
  между файлами/экспортами. Пригодятся будущему импортёру для поиска полных аналогов.

## Иконки

Узел считается библиотечной иконкой, если:

1. `pluginData.assetType === "icon"` или задан `pluginData.iconName`;
2. имя слоя начинается с `Icon/` (для контейнеров — при размере ≤ 128 px,
   чтобы фрейм `Icons/Overview` не считался одной иконкой);
3. это инстанс компонента с именем `Icon/…`.

Иконка экспортируется **ссылкой** (`type: "ICON"`, нормализованное имя
`Icon / Arrow_Left.svg → arrow-left`, размер, fill/stroke override), а не полным
векторным деревом; учёт — в `iconDependencies` с `usageCount`. SVG-снимок
добавляется только опцией «SVG-снимки иконок».

## Ограничения и деградация

Весь необязательный API определяется в рантайме. Если возможности нет, экспорт
продолжается, а в `diagnostics` появляется код:

| Код | Когда |
|---|---|
| `MAIN_COMPONENT_UNAVAILABLE` / `SNAPSHOT_FALLBACK_USED` | mainComponent инстанса недоступен |
| `COMPONENT_SET_UNAVAILABLE` | сет не прочитался |
| `PROPERTY_BINDING_LOST` | привязка свойства вне экспортируемых определений |
| `INSTANCE_OVERRIDE_PARTIAL` | часть override сохранена только именем поля |
| `VARIABLES_API_UNAVAILABLE` / `VARIABLE_BINDING_LOST` | Variables API нет / переменная не прочиталась (остаётся ссылка) |
| `STYLE_RESOLVED_TO_RAW_VALUE` | стиль не прочитался, значения остались на узле |
| `IMAGE_DATA_UNAVAILABLE` | байты картинки недоступны (остаётся ссылка на hash) |
| `SVG_EXPORT_FAILED` / `ICON_ASSET_UNAVAILABLE` | exportAsync не дал SVG |
| `SVG_JOBS_LIMIT` | векторов больше лимита (500) — часть узлов сохранена без SVG |
| `REACTION_TARGET_UNRESOLVED` | цель реакции вне выделения (сохраняется имя) |
| `UNSUPPORTED_NODE_TYPE` | неизвестный тип узла (базовые свойства + дети сохраняются) |
| `MIXED_VALUE_SKIPPED` | смешанное значение (mixed) пропущено |
| `DEPENDENCY_CYCLE` | цикл в графе зависимостей |

Не входит в MVP: импорт пакета, native scene stream
(`exportSceneNodeListStream`), встроенный каталог SVG-иконок.

### Полевые заметки Pixso

- `node.exportAsync` в Pixso принимает `format: "JPG" | "PNG" | "SVG" | "PDF"` —
  формата `SVG_STRING` (как в Figma) нет, на него wasm-валидатор отвечает ZodError.
  Плагин пробует `SVG` первым, конвертирует байты в строку и кэширует сработавший
  формат на весь прогон, поэтому в консоли хоста нет шума от проб.
- Каждый `exportAsync`/`getBytesAsync` обёрнут таймаутом (15/20 с): один зависший
  вызов не вешает экспорт, узел просто остаётся без SVG/байтов с диагностикой.
- Прогресс SVG-стадии показывается как `k/n` в панели.

## Smoke test

```bash
node Plugin/portable-exporter/tests/ExportSmokeTest.js
```

85 проверок на фейковом Pixso API: утилиты (SHA-256, канонический JSON,
нормализация имён), распознавание иконок, полный экспорт (сет с вариантами и
свойствами, пресет инстанса с overrides, стили, изображение, SVG, шрифты, реакции,
fingerprints, топологический порядок, snapshot-fallback, мультивыделение),
детерминизм fingerprints и анализ выделения.

Обновить образец пакета:

```bash
SAMPLE_OUT=samples/SampleFull.json node tests/ExportSmokeTest.js
```

## Файлы

- `Manifest.json` — манифест dev-плагина (`Main.js` + `Ui.html`, без сборки);
- `Main.js` — сериализация, зависимости, fingerprints, граф, диагностика;
- `Ui.html` — панель: выделение, опции, анализ, экспорт/копирование, диагностика;
- `tests/ExportSmokeTest.js` — smoke-тест;
- `samples/SampleFull.json` — образец экспортированного пакета.
