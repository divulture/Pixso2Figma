# Pixso → Figma

Two standalone development plugins for transferring editable interfaces from
Pixso to Figma. The exporter saves a screen as a portable JSON package, while
the importer reconstructs native Figma layers, styles, SVG assets, and component
structure.

> The project does not export the screen as a single flattened image. The result
> remains editable at the layer level.

## Features

- export a selected Pixso frame or the entire current page;
- preserve layer hierarchy and stacking order;
- transfer dimensions, coordinates, constraints, sizing, and auto layout;
- transfer text and mixed text styles;
- transfer fills, strokes, per-side stroke weights, corner radii, and effects;
- embed raster images as base64;
- transfer vector layers and icons as SVG;
- transfer local paint, text, and effect styles;
- preserve resolved snapshots of Pixso instances;
- create native Figma components, variants, and instances from repeated snapshot
  components;
- report data that cannot be reconstructed exactly because of editor API
  limitations.

## How it works

```text
Pixso document
      │
      ▼
Portable Exporter
      │  pixso-portable-package.json
      ▼
Pixso to Figma Importer
      │
      ▼
Editable Figma layers + local components
```

The plugins require no build step, `npm install`, external dependencies, or local
server.

## Repository structure

```text
Plugins/
├── ExportNodes/          # Pixso: export to portable JSON
│   ├── Main.js
│   ├── Manifest.json
│   ├── Ui.html
│   ├── Readme.md
│   ├── Samples/
│   └── Tests/
└── FigmaImporter/        # Figma: import portable JSON
    ├── Main.js
    ├── manifest.json
    ├── Ui.html
    ├── Readme.md
    └── Tests/
```

## Installation

### Pixso exporter

1. Open the development plugins section in Pixso.
2. Import [`Plugins/ExportNodes/Manifest.json`](Plugins/ExportNodes/Manifest.json).
3. Run **Portable Exporter**.

### Figma importer

1. In Figma, open `Plugins → Development → Import plugin from manifest…`.
2. Select [`Plugins/FigmaImporter/manifest.json`](Plugins/FigmaImporter/manifest.json).
3. Run **Pixso to Figma Importer**.

## Recommended screen migration workflow

1. Select the root screen frame in Pixso.
2. Enable the following options in Portable Exporter:
   - **Styles** (`Стили`);
   - **Variables** (`Переменные`);
   - **SVG for vectors** (`SVG для векторов`);
   - **SVG icon snapshots** (`SVG-снимки иконок`);
   - **Exact instance contents for Figma**
     (`Точное содержимое инстансов (для Figma)`).
3. Click **Export JSON** (`Экспортировать JSON`).
4. Open the importer in Figma and select the exported file.
5. Keep native Figma component and instance creation enabled.
6. Import the package into a clean page and compare it with the source screen.

SVG and image export can be disabled temporarily when testing only the document
structure. Enable both for the final migration.

## Package format

The exporter generates JSON in the `pixso-portable-package` format. The package
contains a flat node map and references from which the importer reconstructs the
document tree. It may include:

- roots and nodes;
- components, component sets, and instance presets;
- styles and variables;
- images and SVG assets;
- fonts and prototype reactions;
- dependency graph, fingerprints, and diagnostics.

A complete example is available at
[`Plugins/ExportNodes/Samples/SampleFull.json`](Plugins/ExportNodes/Samples/SampleFull.json).
See the dedicated documentation for the
[`exporter`](Plugins/ExportNodes/Readme.md) and
[`importer`](Plugins/FigmaImporter/Readme.md) for technical details.

## Limitations

Pixso and Figma use different document models and do not expose identical data
through their plugin APIs. Migration therefore follows a best-effort approach.

Exact one-to-one transfer is not guaranteed for:

- remote library links;
- video fills;
- some prototype reactions;
- some variable and style bindings;
- complex vector geometry when Pixso does not return SVG;
- fonts that are unavailable in Figma.

When native reconstruction is impossible, the importer preserves the available
visual value or a fallback and adds a warning to the import report.

## Tests

Only Node.js is required.

```bash
node --check Plugins/ExportNodes/Main.js
node --check Plugins/FigmaImporter/Main.js
node Plugins/ExportNodes/Tests/ExportSmokeTest.js
node Plugins/FigmaImporter/Tests/ImporterSmokeTest.js
```

The smoke tests use mocked editor APIs and do not modify Pixso or Figma documents.

## License

[MIT](LICENSE) © 2026 divulture
