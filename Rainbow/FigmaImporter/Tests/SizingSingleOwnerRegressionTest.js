"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var source = fs.readFileSync(path.join(__dirname, "..", "Main.js"), "utf8");
function body(name, nextMarker) {
  var a = source.indexOf("function " + name + "(");
  assert(a >= 0, name + " must exist");
  var b = source.indexOf(nextMarker, a);
  assert(b > a, name + " end marker must exist");
  return source.slice(a, b);
}
var semantic = body("directReassertSemanticSizing", "// Re-apply only parent-owned FILL axes");
assert(!/directSet\(node,\s*[\"']layoutSizingHorizontal[\"']/.test(semantic),
  "final semantic commit must not write Figma layoutSizingHorizontal shorthand");
assert(!/directSet\(node,\s*[\"']layoutSizingVertical[\"']/.test(semantic),
  "final semantic commit must not write Figma layoutSizingVertical shorthand");
assert(semantic.indexOf('directSet(node, "textAutoResize"') >= 0,
  "textAutoResize must be the final intrinsic text sizing owner");
assert(semantic.indexOf("directApplyChildLayout(node, directEffectiveChildLayout(spec, parentLayoutMode, session))") >= 0,
  "parent auto-layout slot must be committed from Pixso childLayout");
var fill = body("directReassertParentOwnedFill", "function directParityMismatch");
assert(!/layoutSizingHorizontal[\"']\s*,\s*[\"']FILL/.test(fill),
  "FILL repair must not use layoutSizingHorizontal shorthand");
assert(!/layoutSizingVertical[\"']\s*,\s*[\"']FILL/.test(fill),
  "FILL repair must not use layoutSizingVertical shorthand");
assert(fill.indexOf("directApplyChildLayout(node, directEffectiveChildLayout(spec, parentLayoutMode, session))") >= 0,
  "FILL repair must use canonical Pixso layoutGrow/layoutAlign slot");
console.log("SizingSingleOwnerRegressionTest: OK");
