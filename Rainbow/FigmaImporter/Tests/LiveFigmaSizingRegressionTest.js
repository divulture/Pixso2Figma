"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var FigmaHost = require("../../DirectPix/FigmaHost");

// Regression 1: the double must reproduce the live-host side effect that made
// old tests lie: resize() converts an auto-layout HUG box into FIXED.
var host = FigmaHost.createHost();
var frame = host.figma.createFrame();
frame.layoutMode = "HORIZONTAL";
frame.primaryAxisSizingMode = "AUTO";
frame.counterAxisSizingMode = "AUTO";
frame.resize(120, 40);
assert.strictEqual(frame.primaryAxisSizingMode, "FIXED");
assert.strictEqual(frame.counterAxisSizingMode, "FIXED");

// Regression 2: HUG parent whose only flow child is FILL on the main axis.
// Measured in live Figma (FIGMA_CAPABILITIES.md, main-axis-hug-over-grow): the
// host does NOT collapse such an axis, it keeps the previous size. The double
// must reproduce that instead of an assumed collapse.
var parent = host.figma.createFrame();
parent.layoutMode = "HORIZONTAL";
parent.primaryAxisSizingMode = "AUTO";
parent.resizeWithoutConstraints(300, 40);
parent.primaryAxisSizingMode = "AUTO";
var child = host.figma.createFrame();
child.resizeWithoutConstraints(100, 20);
parent.appendChild(child);
child.layoutGrow = 1;
assert.strictEqual(parent.width, 100, "HUG over an all-FILL main axis keeps its last size (hugged 100), not collapses, as in live Figma");

// Regression 3: late layout writes can invalidate maxLines; receiver must have
// a final overflow commit after final source placement.
var text = host.figma.createText();
text.textTruncation = "ENDING";
text.maxLines = 1;
text.layoutGrow = 1;
assert.strictEqual(text.maxLines, null, "layout rewrite must invalidate maxLines in the host double");

var source = fs.readFileSync(path.join(__dirname, "..", "Main.js"), "utf8");
var placement = source.indexOf("// FINAL SOURCE-PLACEMENT COMMIT");
var overflow = source.indexOf("// FINAL TEXT-OVERFLOW COMMIT");
var visibility = source.indexOf("// FINAL RESOLVED-VISIBILITY COMMIT");
assert(placement >= 0 && overflow > placement && visibility > overflow,
  "text overflow must be committed after placement and before final visibility");
assert(source.indexOf("directEffectiveOwnLayout(spec, session)") >= 0,
  "instance semantic commit must inherit canonical definition layout");
assert(source.indexOf("directDegenerateFillFixedAxes") >= 0,
  "receiver must resolve HUG/FILL cycles on the child");
console.log("LiveFigmaSizingRegressionTest: OK");
