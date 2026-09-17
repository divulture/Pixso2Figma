"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var source = fs.readFileSync(path.join(__dirname, "..", "PixNormalizer.js"), "utf8");
assert(source.indexOf('out.layoutGrow = detail.stackChildPrimarySizing === "RESIZE_TO_FIT" ? 1 : 0;') >= 0,
  "base DirectPix child-slot serialization must be restored; v25 omission heuristic must not remain");
console.log("V25RollbackRegressionTest: OK");
