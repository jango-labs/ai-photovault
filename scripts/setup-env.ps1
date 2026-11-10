# Windows PowerShell: creates .env from .env.example with freshly generated random secrets. Never overwrites an existing .env.
#   powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1 [-Photos "C:\Users\you\Pictures\Exports"]
param([string]$Photos = "")
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root ".env"
if (Test-Path $target) { Write-Error ".env already exists; not touching it."; exit 1 }
function New-Hex([int]$bytes) { $b = New-Object byte[] $bytes; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString("x2") }) }
$text = Get-Content (Join-Path $root ".env.example") -Raw
$text = [regex]::Replace($text, "=__GENERATED_HEX__", { param($m) "=" + (New-Hex 32) })
$text = [regex]::Replace($text, "=__GENERATED__", { param($m) "=" + (New-Hex 24) })
if ($Photos) { $text = [regex]::Replace($text, "(?m)^PHOTOVAULT_PHOTOS_DIR=.*$", "PHOTOVAULT_PHOTOS_DIR=" + ($Photos -replace "\\", "/")) }
Set-Content -Path $target -Value $text -NoNewline
Write-Host "Created .env with new random secrets. Edit PHOTOVAULT_PHOTOS_DIR to point at your photo folder."
