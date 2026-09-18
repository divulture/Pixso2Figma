/**
 * Runtime bootstrap contract.
 *
 * The macOS bootstrap is exercised through its no-network cache hit. Windows
 * PowerShell is not available on every development host, so its download
 * contract and wrapper integration are checked statically here; the hashes are
 * pinned values from the official Node.js v24.21.0 SHASUMS256.txt.
 */
"use strict";

var assert = require("assert");
var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var projectDir = path.join(__dirname, "..", "..");
var bootstrapSh = path.join(projectDir, "Launcher", "BootstrapNode.sh");
var bootstrapPs = path.join(projectDir, "Launcher", "BootstrapNode.ps1");
var starterPs = path.join(projectDir, "Launcher", "StartWindows.ps1");
var wrapperSh = path.join(projectDir, "Pixso2Figma.command");
var wrapperCmd = path.join(projectDir, "Pixso2Figma.cmd");

var checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function includes(text, fragment, message) {
  ok(text.indexOf(fragment) >= 0, message + " (not found: " + fragment + ")");
}

var shText = fs.readFileSync(bootstrapSh, "utf8");
var psText = fs.readFileSync(bootstrapPs, "utf8");
var starterPsText = fs.readFileSync(starterPs, "utf8");
var wrapperShText = fs.readFileSync(wrapperSh, "utf8");
var wrapperCmdText = fs.readFileSync(wrapperCmd, "utf8");

includes(shText, 'NODE_VERSION="24.21.0"', "macOS bootstrap pins the runtime version");
includes(psText, '$NodeVersion = "24.21.0"', "Windows bootstrap pins the runtime version");
includes(shText, "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe",
  "macOS arm64 official archive hash is pinned");
includes(shText, "0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299",
  "macOS x64 official archive hash is pinned");
includes(psText, "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
  "Windows arm64 official archive hash is pinned");
includes(psText, "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  "Windows x64 official archive hash is pinned");
includes(shText, "shasum -a 256", "macOS verifies the archive before extraction");
includes(psText, "Get-FileHash -LiteralPath $archivePath -Algorithm SHA256",
  "Windows verifies the archive before extraction");
includes(wrapperShText, 'NODE="$(find_compatible_node)"', "macOS prefers a compatible system Node");
includes(wrapperShText, 'NODE="$(/bin/bash "$BOOTSTRAP")"', "macOS falls back to the private runtime");
includes(starterPsText, "Get-Command node.exe", "Windows prefers a system Node executable");
includes(starterPsText, "Get-PixsoPrivateNode", "Windows falls back to the private runtime");
includes(starterPsText, "launcher.log", "Windows writes an early-start diagnostic log");
includes(starterPsText, "& $nodePath $Launcher @LauncherArgs", "PowerShell launches Terminal.js directly");
includes(wrapperCmdText, "StartWindows.ps1", "cmd delegates startup to one PowerShell process");
ok(!/^\s*for \/f/im.test(wrapperCmdText), "cmd does not pipe a Unicode runtime path through for /f");
includes(wrapperCmdText, "pause >nul", "cmd keeps every startup failure visible");
ok(/^[\x00-\x7f]*$/.test(wrapperCmdText), "cmd stays ASCII for legacy Windows command processors");
ok(/^[\x00-\x7f]*$/.test(psText), "Windows bootstrap stays ASCII for PowerShell 5.1");
ok(/^[\x00-\x7f]*$/.test(starterPsText), "Windows starter stays ASCII for PowerShell 5.1");
ok(!/(^|[^\r])\n/.test(wrapperCmdText), "cmd uses Windows CRLF line endings");
ok(!/(^|[^\r])\n/.test(psText), "Windows bootstrap uses CRLF line endings");
ok(!/(^|[^\r])\n/.test(starterPsText), "Windows starter uses CRLF line endings");

// A valid cached runtime must be returned without touching the network. The
// fake executable implements only the exact version probe used by bootstrap.
if (process.platform === "darwin") {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-runtime-test-"));
  try {
    var machine = childProcess.execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
    var translated = "";
    if (machine === "x86_64") {
      try {
        translated = childProcess.execFileSync("sysctl", ["-in", "sysctl.proc_translated"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch (_error) { /* Intel Mac: the sysctl key does not exist. */ }
    }
    var arch = machine === "arm64" || translated === "1" ? "arm64" : "x64";
    var fakeNode = path.join(tmp, "v24.21.0-darwin-" + arch, "bin", "node");
    fs.mkdirSync(path.dirname(fakeNode), { recursive: true });
    fs.writeFileSync(fakeNode, "#!/bin/sh\nprintf '%s\\n' '24.21.0'\n", { mode: 0o755 });

    var result = childProcess.spawnSync("/bin/bash", [bootstrapSh], {
      encoding: "utf8",
      env: Object.assign({}, process.env, { PIXSO2FIGMA_RUNTIME_DIR: tmp }),
    });
    assert.strictEqual(result.status, 0, "cached macOS runtime is accepted: " + result.stderr);
    checks += 1;
    assert.strictEqual(result.stdout.trim(), fakeNode, "bootstrap returns the cached runtime path only");
    checks += 1;
    assert.strictEqual(result.stderr, "", "cache hit does not claim to download anything");
    checks += 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("RuntimeBootstrapTest: OK (" + checks + " checks)");
