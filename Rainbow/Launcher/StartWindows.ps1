param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LauncherArgs
)

# Windows entry point. It deliberately owns the whole sequence from runtime
# discovery to launching Terminal.js: passing a Unicode path through cmd.exe
# stdout/for-f is fragile and caused the double-click window to disappear on
# some Windows virtual machines.

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot "Terminal.js"
$Bootstrap = Join-Path $PSScriptRoot "BootstrapNode.ps1"
$StateDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Pixso2Figma"
$LogPath = Join-Path $StateDir "launcher.log"

function Write-LauncherLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    Add-Content -LiteralPath $LogPath -Value "$stamp $Message" -Encoding UTF8
  } catch {
    # Logging must never prevent the launcher from starting.
  }
}

function Test-CompatibleNode([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $raw = (& $Path -p "process.versions.node" 2>$null | Select-Object -First 1)
    $parts = ([string]$raw).Trim().Split(".")
    if ($parts.Count -lt 2) { return $false }
    $major = 0
    $minor = 0
    if (-not [int]::TryParse($parts[0], [ref]$major)) { return $false }
    if (-not [int]::TryParse($parts[1], [ref]$minor)) { return $false }
    return ($major -ge 24) -or (($major -eq 22) -and ($minor -ge 15))
  } catch {
    return $false
  }
}

function Find-SystemNode {
  $seen = @{}
  $commands = @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)
  foreach ($command in $commands) {
    $candidate = [string]$command.Source
    if ([string]::IsNullOrWhiteSpace($candidate) -or $seen.ContainsKey($candidate)) { continue }
    $seen[$candidate] = $true
    if (Test-CompatibleNode $candidate) { return $candidate }
  }
  return $null
}

try {
  Write-LauncherLog "start"
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
    throw "Terminal.js was not found at '$Launcher'. Restore the complete Pixso2Figma folder."
  }
  if (-not (Test-Path -LiteralPath $Bootstrap -PathType Leaf)) {
    throw "BootstrapNode.ps1 was not found at '$Bootstrap'. Restore the complete Pixso2Figma folder."
  }

  $nodePath = Find-SystemNode
  if ($nodePath) {
    Write-LauncherLog "using system Node: $nodePath"
  } else {
    Write-LauncherLog "compatible system Node not found; preparing private runtime"
    . $Bootstrap -LibraryMode
    $nodePath = Get-PixsoPrivateNode
    Write-LauncherLog "using private Node: $nodePath"
  }

  if (-not (Test-CompatibleNode $nodePath)) {
    throw "The selected Node.js runtime failed the compatibility check: '$nodePath'."
  }

  $nodeVersion = (& $nodePath -v 2>$null | Select-Object -First 1)
  [Console]::Out.WriteLine("Node:  $nodePath ($nodeVersion)")
  [Console]::Out.WriteLine("")
  Write-LauncherLog "launching Terminal.js with Node $nodeVersion"

  & $nodePath $Launcher @LauncherArgs
  $status = $LASTEXITCODE
  if ($null -eq $status) { $status = 1 }
  Write-LauncherLog "Terminal.js exited with code $status"
  exit $status
} catch {
  $message = $_.Exception.Message
  Write-LauncherLog "failed: $message"
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("Pixso2Figma could not start: $message")
  [Console]::Error.WriteLine("Diagnostic log: $LogPath")
  exit 1
}
