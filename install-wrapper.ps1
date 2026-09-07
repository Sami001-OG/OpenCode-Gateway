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

if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
$profile = Get-Content -LiteralPath $PROFILE -Raw -ErrorAction SilentlyContinue
if ($profile -and $profile.Contains($markerBegin)) {
  $pattern = "(?s)" + [regex]::Escape($markerBegin) + ".*?" + [regex]::Escape($markerEnd)
  $profile = [regex]::Replace($profile, $pattern, $snippet.Trim())
  Set-Content -LiteralPath $PROFILE -Value $profile
  Write-Output "Wrapper updated in $PROFILE"
} else {
  Add-Content -LiteralPath $PROFILE -Value ("`r`n" + $snippet.Trim() + "`r`n")
  Write-Output "Wrapper installed in $PROFILE"
}
Write-Output "Restart your terminal, then:  opencode setup"
