"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var source = fs.readFileSync(path.join(__dirname, "..", "Main.js"), "utf8");
var setAt = source.indexOf("target.setProperties(one);");
assert(setAt >= 0, "native setProperties path must exist");
var before = source.slice(Math.max(0, setAt - 1800), setAt);
var after = source.slice(setAt, setAt + 700);
assert(before.indexOf("var targetSlotBefore = directChildSlotSnapshot(target);") >= 0,
  "every native property write must snapshot the target instance child slot");
assert(after.indexOf("directRestoreChildSlot(target, targetSlotBefore, session);") >= 0,
  "every native property write must restore the target instance child slot");
console.log("NestedNativePropertySlotRegressionTest: OK");
