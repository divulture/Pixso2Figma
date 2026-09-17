/**
 * FigmaImporter: все тесты папки одним прогоном.
 *
 *   node FigmaImporter/Tests/RegressionSuite.js
 *
 * Запускает каждый *Test.js этой папки отдельным процессом и падает, если упал
 * хотя бы один. Список не ведётся вручную: новый тест попадает в прогон сам.
 */
"use strict";
var cp = require("child_process");
var fs = require("fs");
var path = require("path");

var tests = fs.readdirSync(__dirname).filter(function (name) {
  return /Test\.js$/.test(name);
}).sort();
var failed = [];
tests.forEach(function (name) {
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(name);
});
if (failed.length) {
  console.error("FigmaImporter RegressionSuite: упало " + failed.length + " из " + tests.length + ": " + failed.join(", "));
  process.exit(1);
}
console.log("FigmaImporter RegressionSuite: OK (" + tests.length + " тестов)");
