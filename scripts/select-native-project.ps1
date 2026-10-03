param(
  [Parameter(Mandatory=$true)][int]$OwnerProcessId,
  [Parameter(Mandatory=$true)][string]$Folder
)

# Test harness only: drive the real Windows folder picker through UI Automation.
# No Electron handlers, service credentials or authorization are replaced.
$ErrorActionPreference = 'Stop'
$selectedFolder = (Resolve-Path -LiteralPath $Folder).Path
if (-not (Test-Path -LiteralPath $selectedFolder -PathType Container)) { throw 'Expected a folder' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativePickerControls {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")]
  public static extern IntPtr SetText(IntPtr handle, uint message, IntPtr parameter, string text);
  [DllImport("user32.dll", EntryPoint="SendMessageW")]
  public static extern IntPtr Click(IntPtr handle, uint message, IntPtr parameter, IntPtr value);
}
'@
$rootElement = [System.Windows.Automation.AutomationElement]::RootElement
$processCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnerProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds(25)
$expectedTitle = -join ([char[]]@(0x6253,0x5f00,0x9879,0x76ee,0x76ee,0x5f55))
$dialogElement = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $dialogElement) {
  $windows = $rootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $processCondition)
  foreach ($candidate in $windows) {
    if ($candidate.Current.Name -eq $expectedTitle) { $dialogElement = $candidate; break }
  }
  if (-not $dialogElement) { Start-Sleep -Milliseconds 200 }
}
if (-not $dialogElement) { throw 'Native project folder picker did not appear' }
$editCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1152')
$pathEdit = $dialogElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
if (-not $pathEdit) { throw 'Native folder-name control was not found' }
$editHandle = [IntPtr]$pathEdit.Current.NativeWindowHandle
if ($editHandle -eq [IntPtr]::Zero) { throw 'Native folder-name control has no HWND' }
$setResult = [NativePickerControls]::SetText($editHandle, 0x000C, [IntPtr]::Zero, $selectedFolder)
if ($setResult -eq [IntPtr]::Zero) { throw 'Native folder-name text could not be set' }
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')
$selectButton = $dialogElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
if (-not $selectButton) { throw 'Native folder selection button was not found' }
$buttonHandle = [IntPtr]$selectButton.Current.NativeWindowHandle
if ($buttonHandle -eq [IntPtr]::Zero) { throw 'Native folder selection button has no HWND' }
[void][NativePickerControls]::Click($buttonHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output 'Native folder selection invoked'
