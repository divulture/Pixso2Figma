param(
  [switch]$LibraryMode
)

# Downloads a private Node.js runtime when Windows has no compatible system
# Node. The file can be executed directly or dot-sourced by StartWindows.ps1.
# Keep source text ASCII-only: Windows PowerShell 5.1 does not reliably decode
# UTF-8 scripts without a BOM.

$ErrorActionPreference = "Stop"
$NodeVersion = "24.21.0"
$DistBase = "https://nodejs.org/download/release/v$NodeVersion"

function Write-RuntimeProgress([string]$Message) {
  [Console]::Error.WriteLine($Message)
}

function Test-PinnedNodeRuntime([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $detected = (& $Path -p "process.versions.node" 2>$null | Select-Object -First 1)
    return ([string]$detected).Trim() -eq $NodeVersion
  } catch {
    return $false
  }
}

function Get-PixsoPrivateNode {
  $nativeArch = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrWhiteSpace($nativeArch)) {
    $nativeArch = $env:PROCESSOR_ARCHITECTURE
  }
  if ([string]::IsNullOrWhiteSpace($nativeArch)) {
    throw "Windows architecture is unavailable."
  }

  switch ($nativeArch.ToUpperInvariant()) {
    "ARM64" {
      $nodeArch = "arm64"
      $archiveSha256 = "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921"
      $downloadSizeMb = 34
    }
    "AMD64" {
      $nodeArch = "x64"
      $archiveSha256 = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"
      $downloadSizeMb = 38
    }
    default { throw "Unsupported Windows architecture '$nativeArch'." }
  }

  $archiveName = "node-v$NodeVersion-win-$nodeArch.zip"
  $archiveUrl = "$DistBase/$archiveName"
  $defaultBase = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Pixso2Figma\runtime"
  $runtimeBase = if ($env:PIXSO2FIGMA_RUNTIME_DIR) { $env:PIXSO2FIGMA_RUNTIME_DIR } else { $defaultBase }
  $targetDir = Join-Path $runtimeBase "v$NodeVersion-win-$nodeArch"
  $nodePath = Join-Path $targetDir "node.exe"

  if (Test-PinnedNodeRuntime $nodePath) { return $nodePath }

  New-Item -ItemType Directory -Path $runtimeBase -Force | Out-Null
  $mutexName = "Local\Pixso2FigmaNodeRuntime-v$NodeVersion-$nodeArch"
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  $lockHeld = $false
  $stageDir = $null

  try {
    try {
      $lockHeld = $mutex.WaitOne([TimeSpan]::FromMinutes(5))
    } catch [System.Threading.AbandonedMutexException] {
      $lockHeld = $true
    }
    if (-not $lockHeld) { throw "Another launch did not finish preparing Node.js in five minutes." }

    if (Test-PinnedNodeRuntime $nodePath) { return $nodePath }

    $stageDir = Join-Path $runtimeBase (".install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $stageDir | Out-Null
    $archivePath = Join-Path $stageDir $archiveName

    Write-RuntimeProgress "Compatible Node.js was not found. Downloading Node.js $NodeVersion runtime (~$downloadSizeMb MB)..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $client = New-Object Net.WebClient
    try {
      $client.Headers.Add("User-Agent", "Pixso2Figma runtime bootstrap")
      $client.DownloadFile($archiveUrl, $archivePath)
    } finally {
      $client.Dispose()
    }

    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $archiveSha256) {
      throw "Downloaded Node.js archive failed the SHA-256 check; it will not be executed."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $stageDir -Force
    $sourceDir = Join-Path $stageDir "node-v$NodeVersion-win-$nodeArch"
    $sourceNode = Join-Path $sourceDir "node.exe"
    if (-not (Test-Path -LiteralPath $sourceNode -PathType Leaf)) {
      throw "The official Node.js archive does not contain the expected node.exe."
    }

    # DirectPix and Bridge need only node.exe. npm, headers and docs are not
    # retained, which keeps the private runtime much smaller.
    $preparedDir = Join-Path $stageDir "prepared-runtime"
    New-Item -ItemType Directory -Path $preparedDir | Out-Null
    Copy-Item -LiteralPath $sourceNode -Destination (Join-Path $preparedDir "node.exe")
    $sourceLicense = Join-Path $sourceDir "LICENSE"
    if (Test-Path -LiteralPath $sourceLicense -PathType Leaf) {
      Copy-Item -LiteralPath $sourceLicense -Destination (Join-Path $preparedDir "LICENSE")
    }

    if (Test-Path -LiteralPath $targetDir) {
      Remove-Item -LiteralPath $targetDir -Recurse -Force
    }
    Move-Item -LiteralPath $preparedDir -Destination $targetDir

    if (-not (Test-PinnedNodeRuntime $nodePath)) {
      throw "The downloaded Node.js runtime failed its launch check."
    }

    Write-RuntimeProgress "Ready. Runtime was saved to $targetDir"
    return $nodePath
  } finally {
    if ($stageDir -and (Test-Path -LiteralPath $stageDir)) {
      Remove-Item -LiteralPath $stageDir -Recurse -Force
    }
    if ($lockHeld) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

if (-not $LibraryMode) {
  try {
    [Console]::Out.WriteLine((Get-PixsoPrivateNode))
    exit 0
  } catch {
    Write-RuntimeProgress ""
    Write-RuntimeProgress ("Could not prepare Node.js: " + $_.Exception.Message)
    Write-RuntimeProgress "Check the internet connection and start Pixso2Figma again."
    exit 1
  }
}
