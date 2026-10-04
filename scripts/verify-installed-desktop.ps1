param(
  [string]$Installer,
  [string]$ReportDirectory
)

# Installs only a new test copy. An existing installation stops the run before
# NSIS is invoked. User projects are never removed by this verification script.
$ErrorActionPreference = 'Stop'
$taskRegistryRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$taskProductName = -join ([char[]]@(0x5b66,0x79d1,0x5907,0x8003,0x5de5,0x4f5c,0x53f0))
if (-not $Installer) { $Installer = Join-Path $PSScriptRoot ('../apps/desktop/release/' + $taskProductName + '-0.1.0-setup.exe') }
foreach ($taskRegistryRoot in $taskRegistryRoots) {
  if (Test-Path -LiteralPath $taskRegistryRoot) {
    $taskExisting = Get-ChildItem -LiteralPath $taskRegistryRoot | ForEach-Object {
      Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    } | Where-Object { $_.DisplayName -eq $taskProductName }
    if ($taskExisting) { throw 'Existing product installation found; use a separate test Windows account or VM' }
  }
}
$taskInstallerPath = (Resolve-Path -LiteralPath $Installer).Path
$taskTimestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ssZ')
if (-not $ReportDirectory) {
  $taskRepositoryRelease = Join-Path $PSScriptRoot '../apps/desktop/release'
  $ReportDirectory = if (Test-Path -LiteralPath $taskRepositoryRelease) { $taskRepositoryRelease } else { Join-Path $PSScriptRoot 'reports' }
}
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$taskReportDirectory = (Resolve-Path -LiteralPath $ReportDirectory).Path
$taskOs = Get-CimInstance Win32_OperatingSystem
$taskEnvironment = [ordered]@{
  osCaption = $taskOs.Caption
  osVersion = $taskOs.Version
  osBuild = $taskOs.BuildNumber
  osArchitecture = $taskOs.OSArchitecture
  developerNodeDetected = [bool](Get-Command node.exe -ErrorAction SilentlyContinue)
  repositoryPresent = Test-Path -LiteralPath (Join-Path $PSScriptRoot '../package.json')
  independentCleanEnvironmentVerified = $false
  note = 'Observed environment facts only; a clean Windows acceptance requires independent operator/environment evidence.'
}
$taskEnvironment | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskReportDirectory ('m0-environment-' + $taskTimestamp + '.json')) -Encoding UTF8
$taskTempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$taskRunRoot = Join-Path $taskTempRoot ('sew-m0-' + [guid]::NewGuid().ToString('N'))
$taskInstallDir = Join-Path $taskRunRoot ($taskProductName + ' installed app')
$taskProjectDir = Join-Path $taskRunRoot 'retained project'
New-Item -ItemType Directory -Path $taskRunRoot | Out-Null
Write-Output "Installing an isolated test copy at $taskInstallDir"
$taskInstallerProcess = Start-Process -FilePath $taskInstallerPath -ArgumentList @('/S', "/D=$taskInstallDir") -PassThru -WindowStyle Hidden
if (-not $taskInstallerProcess.WaitForExit(600000)) { throw "Installer timeout; test files retained at $taskRunRoot" }
if ($taskInstallerProcess.ExitCode -ne 0) { throw "Installer failed with exit $($taskInstallerProcess.ExitCode); files retained at $taskRunRoot" }
$taskExe = Join-Path $taskInstallDir ($taskProductName + '.exe')
if (-not (Test-Path -LiteralPath $taskExe -PathType Leaf)) { throw 'Installed executable missing' }
$taskBundledNode = Join-Path $taskInstallDir 'resources/node/runtime/node.exe'
$taskUiScript = Join-Path $PSScriptRoot 'verify-classroom-desktop.mjs'
$taskReport = Join-Path $taskRunRoot 'installed-classroom-ui.json'
Write-Output 'Running the installed classroom with bundled Node'
& $taskBundledNode $taskUiScript --installed-app $taskInstallDir --project-dir $taskProjectDir --report $taskReport
$taskUiExitCode = $LASTEXITCODE
if (Test-Path -LiteralPath $taskReport -PathType Leaf) {
  Copy-Item -LiteralPath $taskReport -Destination (Join-Path $taskReportDirectory ('m0-installed-classroom-' + $taskTimestamp + '.json'))
}
if ($taskUiExitCode -ne 0) { throw "Installed classroom check failed; test installation retained at $taskInstallDir" }
$taskProjectManifest = Join-Path $taskProjectDir 'project.json'
if (-not (Test-Path -LiteralPath $taskProjectManifest -PathType Leaf)) { throw 'Project manifest was not created' }
$taskManifestHash = (Get-FileHash -LiteralPath $taskProjectManifest -Algorithm SHA256).Hash
$taskDatabase = Join-Path $taskProjectDir '.study/study.db'
if (-not (Test-Path -LiteralPath $taskDatabase -PathType Leaf)) { throw 'Project database missing after UI verification' }
$taskDatabaseHash = (Get-FileHash -LiteralPath $taskDatabase -Algorithm SHA256).Hash
$taskResolvedInstall = (Resolve-Path -LiteralPath $taskInstallDir).Path
$taskRunPrefix = (Resolve-Path -LiteralPath $taskRunRoot).Path.TrimEnd('\') + '\'
if (-not $taskResolvedInstall.StartsWith($taskRunPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall target escaped test directory' }
$taskUninstaller = Join-Path $taskResolvedInstall ('Uninstall ' + $taskProductName + '.exe')
if (-not (Test-Path -LiteralPath $taskUninstaller -PathType Leaf)) { throw 'Test uninstaller missing' }
$taskUninstallProcess = Start-Process -FilePath $taskUninstaller -ArgumentList @('/S', "_?=$taskResolvedInstall") -PassThru -WindowStyle Hidden
if (-not $taskUninstallProcess.WaitForExit(120000)) { throw 'Test uninstall timeout; files retained' }
if ($taskUninstallProcess.ExitCode -ne 0) { throw 'Test uninstall failed' }
if (Test-Path -LiteralPath $taskExe) { throw 'Application executable remains after uninstall' }
if (-not (Test-Path -LiteralPath $taskProjectManifest) -or
    (Get-FileHash -LiteralPath $taskProjectManifest -Algorithm SHA256).Hash -ne $taskManifestHash) {
  throw 'Uninstall changed the external project manifest'
}
if (-not (Test-Path -LiteralPath $taskDatabase) -or
    (Get-FileHash -LiteralPath $taskDatabase -Algorithm SHA256).Hash -ne $taskDatabaseHash) {
  throw 'Uninstall changed the external project database'
}
$taskSummary = [ordered]@{
  date = [DateTime]::UtcNow.ToString('o')
  environment = 'isolated installed application; environment facts recorded, independent clean Windows acceptance not certified by this script'
  environmentFacts = $taskEnvironment
  installerSha256 = (Get-FileHash -LiteralPath $taskInstallerPath -Algorithm SHA256).Hash
  classroomReport = $taskReport
  installExitCode = $taskInstallerProcess.ExitCode
  uninstallExitCode = $taskUninstallProcess.ExitCode
  projectRetained = $true
  projectManifestSha256 = $taskManifestHash
  projectDatabaseSha256 = $taskDatabaseHash
}
$taskSummary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRunRoot 'installation-verification.json') -Encoding UTF8
$taskSummary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskReportDirectory ('m0-install-uninstall-' + $taskTimestamp + '.json')) -Encoding UTF8
Write-Output "PASS installed application and uninstall; project and verification report retained at $taskRunRoot"
