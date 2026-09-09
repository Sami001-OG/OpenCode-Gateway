# Installs the `opencode setup` / `opencode gateway ...` shortcuts for PowerShell.
# Run once from the repo root:  powershell -ExecutionPolicy Bypass -File .\install-wrapper.ps1
# Then restart your terminal. The real opencode CLI is untouched — the function
# only intercepts the words `setup` and `gateway`, everything else passes through.

$markerBegin = "# >>> opencode-gateway wrapper >>>"
$markerEnd = "# <<< opencode-gateway wrapper <<<"
$snippet = @'
# >>> opencode-gateway wrapper >>>
function opencode {
  if ($args.Count -gt 0 -and $args[0] -eq 'setup') {
    # Open the TUI with the /setup wizard prompt (from this repo's .opencode/commands)
    $rest = @($args | Select-Object -Skip 1)
    if ($rest.Count -gt 0) { & opencode.exe --prompt ("/setup " + ($rest -join ' ')) }
    else { & opencode.exe --prompt "/setup" }
  } elseif ($args.Count -gt 0 -and $args[0] -eq 'gateway') {
    opencode-gateway @($args | Select-Object -Skip 1)
  } else {
    & opencode.exe @args
  }
}
# <<< opencode-gateway wrapper <<<
'@

$profilePath = $PROFILE
if ([string]::IsNullOrEmpty($profilePath)) {
  $dir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) (
    if ($PSVersionTable.PSEdition -eq "Core") { "PowerShell" } else { "WindowsPowerShell" }
  )
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $profilePath = Join-Path $dir "Microsoft.PowerShell_profile.ps1"
}
if (!(Test-Path $profilePath)) { New-Item -ItemType File -Path $profilePath -Force | Out-Null }
$profile = Get-Content -LiteralPath $profilePath -Raw -ErrorAction SilentlyContinue
if ($profile -and $profile.Contains($markerBegin)) {
  $pattern = "(?s)" + [regex]::Escape($markerBegin) + ".*?" + [regex]::Escape($markerEnd)
  $profile = [regex]::Replace($profile, $pattern, $snippet.Trim())
  Set-Content -LiteralPath $profilePath -Value $profile
  Write-Output "Wrapper updated in $profilePath"
} else {
  Add-Content -LiteralPath $profilePath -Value ("`r`n" + $snippet.Trim() + "`r`n")
  Write-Output "Wrapper installed in $profilePath"
}
Write-Output "Restart your terminal, then:  opencode setup"
