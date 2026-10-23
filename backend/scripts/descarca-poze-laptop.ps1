# Descarcă pe laptop (Windows) toate pozele produselor de pe i3, prin Tailscale.
# Rezultat: <Destinatie>\<cod_produs>\<en|ro|hu|bg>\01.jpg ...
#
# Rulare din PowerShell pe laptop:
#   powershell -ExecutionPolicy Bypass -File .\descarca-poze-laptop.ps1
#   powershell -ExecutionPolicy Bypass -File .\descarca-poze-laptop.ps1 -Destinatie D:\Poze-eMAG
param(
  [string]$Server = "gxg@i3",
  [string]$Destinatie = "$HOME\Desktop\Poze-eMAG",
  [string]$ScriptServer = "~/2_aplicatie_emag/backend/scripts/export-poze.sh",
  [string]$ExportServer = "emag-poze-export"
)
$ErrorActionPreference = "Stop"

Write-Host "1/2 Export poze pe $Server ..."
ssh $Server "bash $ScriptServer ~/$ExportServer"
if ($LASTEXITCODE -ne 0) { throw "Exportul pe server a eșuat." }

# Folder curat, ca pozele șterse din aplicație să dispară și de pe laptop.
if (Test-Path $Destinatie) { Remove-Item -Recurse -Force $Destinatie }
$Parinte = Split-Path -Parent $Destinatie
New-Item -ItemType Directory -Force -Path $Parinte | Out-Null

Write-Host "2/2 Copiez cu scp în $Destinatie ..."
scp -r -q "${Server}:$ExportServer" $Destinatie
if ($LASTEXITCODE -ne 0) { throw "scp a eșuat." }

$Produse = (Get-ChildItem -Directory $Destinatie).Count
$Poze = (Get-ChildItem -Recurse -File $Destinatie).Count
Write-Host "Gata: $Poze poze, $Produse produse în $Destinatie"
