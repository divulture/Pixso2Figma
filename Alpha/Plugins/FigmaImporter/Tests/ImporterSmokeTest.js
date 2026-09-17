"use strict";
var assert = require("assert");
var importer = require("../Main.js");

var pkg = {
  format: "pixso-portable-package",
  roots: [{ nodeRef: "node:screen" }],
  nodes: {
    "node:screen": { id: "node:screen", type: "FRAME", position: { x: -1589, y: -160 }, children: ["node:button"] },
    "node:button": { id: "node:button", type: "INSTANCE" },
    "node:component-a": { id: "node:component-a", type: "COMPONENT", children: ["node:nested"] },
    "node:nested": { id: "node:nested", type: "INSTANCE" },
    "node:component-b": { id: "node:component-b", type: "COMPONENT" },
    "node:unused": { id: "node:unused", type: "COMPONENT" }
  },
  instances: {
    "node:button": { preset: { definitionRef: "component:a" } },
    "node:nested": { preset: { definitionRef: "component:b" } }
  },
  components: {
    "component:a": { portableId: "component:a", rootNodeRef: "node:component-a" },
    "component:b": { portableId: "component:b", rootNodeRef: "node:component-b" },
    "component:unused": { portableId: "component:unused", rootNodeRef: "node:unused" }
  },
  componentSets: {},
  dependencies: { order: ["component:b", "component:a", "component:unused"] }
};

assert.deepStrictEqual(importer.collectRequiredComponents(pkg, false), ["component:b", "component:a"]);
assert.deepStrictEqual(importer.collectRequiredComponents(pkg, true), ["component:b", "component:a", "component:unused"]);
assert.deepStrictEqual(importer.rootOffset(pkg), { x: 1589, y: 160 });

assert.strictEqual(importer.screenNeedsComponentDefinitions(pkg), true);
assert.strictEqual(importer.hasResolvedScreenInstances(pkg), false);

var snapshotPkg = JSON.parse(JSON.stringify(pkg));
snapshotPkg.transferMode = "VISUAL_SNAPSHOT";
snapshotPkg.nodes["node:button"].children = ["node:snapshot-label"];
snapshotPkg.nodes["node:snapshot-label"] = { id: "node:snapshot-label", type: "TEXT", children: [] };
assert.strictEqual(importer.hasResolvedScreenInstances(snapshotPkg), true);
var variantPreset = { definitionSetName: "Button", definitionName: "State=Default, Size=M", variantProperties: { Size: "M", State: "Default" } };
assert.strictEqual(importer.semanticSignature(variantPreset), '{"set":"Button","component":"State=Default, Size=M","variants":{"Size":"M","State":"Default"}}');
assert.strictEqual(importer.variantComponentName(variantPreset), "Size=M, State=Default");

var verticalFillTarget = { parent: { layoutMode: "VERTICAL" }, layoutMode: "NONE" };
importer.applyFigmaChildSizing(verticalFillTarget, { layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" });
assert.strictEqual(verticalFillTarget.layoutAlign, "STRETCH");
assert.strictEqual(verticalFillTarget.layoutGrow, 0);

var horizontalFillFrame = { parent: { layoutMode: "HORIZONTAL" }, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO" };
importer.applyFigmaChildSizing(horizontalFillFrame, { layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" });
assert.strictEqual(horizontalFillFrame.layoutGrow, 1);
assert.strictEqual(horizontalFillFrame.primaryAxisSizingMode, "FIXED");

var constrainedTarget = {};
importer.applyChildConstraints(constrainedTarget, { constraints: { horizontal: "STRETCH", vertical: "CENTER" } });
assert.deepStrictEqual(constrainedTarget.constraints, { horizontal: "STRETCH", vertical: "CENTER" });

assert.strictEqual(importer.isStrokeVectorFallback({
  type: "VECTOR",
  size: { width: 640, height: 1 },
  geometry: { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }
}), true);
assert.strictEqual(importer.isStrokeVectorFallback({
  type: "VECTOR",
  size: { width: 24, height: 24 },
  geometry: { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }
}), false);

var svgWrapper = {
  type: "FRAME",
  fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
  strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
  resizeWithoutConstraints: function (width, height) { this.width = width; this.height = height; },
  getPluginData: function (key) { return key === "pixsoSvgRoot" ? "1" : ""; },
  setPluginData: function () {}
};
assert.strictEqual(importer.isSvgRootNode(svgWrapper), true);
importer.applyCommon(svgWrapper, {
  id: "node:icon",
  type: "ICON",
  name: "Icon/search",
  size: { width: 20, height: 20 },
  geometry: {
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }],
    strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }]
  }
}, {}, { warnings: [] });
assert.deepStrictEqual(svgWrapper.fills, []);
assert.deepStrictEqual(svgWrapper.strokes, []);

assert.deepStrictEqual(importer.sanitizeChildLayout({
  layoutSizingHorizontal: "FILL",
  layoutSizingVertical: "HUG",
  minHeight: 40,
  minWidth: 20,
  maxWidth: 120
}, { width: 68, height: 32 }), {
  layoutSizingHorizontal: "FILL",
  layoutSizingVertical: "HUG",
  minWidth: 20,
  maxWidth: 120
});
console.log("OK: Figma importer screen-only dependency tests passed");
