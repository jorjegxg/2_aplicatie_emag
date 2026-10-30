# Difuzorul vocii lui Claude: ia de la containerul `voce` ultimul mesaj și îl redă pe boxele PC-ului.
# Un mesaj nou îl oprește pe cel vechi. Pornește la logare (task-ul „Claude voce”, vezi instaleaza.ps1).
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Net.Http
$url = "http://127.0.0.1:8100/urmator"
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(40)
$player = New-Object System.Media.SoundPlayer
$dupa = 0
$fisier = Join-Path $env:TEMP "claude-voce.wav"

while ($true) {
    try {
        $r = $http.GetAsync("${url}?dupa=$dupa&timeout=25").Result
        if ([int]$r.StatusCode -eq 200) {
            $dupa = [int]($r.Headers.GetValues("X-Id") | Select-Object -First 1)
            $bytes = $r.Content.ReadAsByteArrayAsync().Result
            $player.Stop()
            [IO.File]::WriteAllBytes($fisier, $bytes)
            $player.SoundLocation = $fisier
            $player.Load()
            $player.Play()
        }
    } catch {
        Start-Sleep -Seconds 5  # containerul nu merge încă (Docker pornește după logare)
    }
}
