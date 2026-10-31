# Difuzorul vocii lui Claude + widgetul „Voce Claude”: ia de la containerul `voce` ultimul mesaj și îl redă pe boxe,
# iar în colțul din dreapta-sus arată câte un card pentru fiecare terminal (sesiune Claude) sau bot care a vorbit,
# cu buton Stop / Pornește. Un terminal nou apare dedesubt. Oprit = serverul nici nu-i mai sintetizează mesajele.
# Pornește la logare (task-ul „Claude voce”, vezi instaleaza.ps1). Iconița din tray: arată/ascunde, ieșire.
# Fișierul trebuie salvat UTF-8 cu BOM (PowerShell 5.1), altfel diacriticele ies stricate.
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Net.Http

$mutex = New-Object System.Threading.Mutex($false, "Local\ClaudeVoceWidget")
if (-not $mutex.WaitOne(0)) { exit }  # rulează deja

Add-Type -Namespace Voce -Name Win -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern int SendMessage(IntPtr h, int msg, int w, int l);
"@
[void][Voce.Win]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$BASE = "http://127.0.0.1:8100"
$TOKEN = ""
$envFile = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
if (Test-Path $envFile) {
    foreach ($l in Get-Content $envFile) { if ($l -match '^\s*VORBESTE_TOKEN\s*=\s*(.+?)\s*$') { $TOKEN = $Matches[1] } }
}

$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(40)
$player = New-Object System.Media.SoundPlayer
$wavFile = Join-Path $env:TEMP "claude-voce.wav"

# ---------- stare ----------
$script:dupa = 0
$script:taskUrm = $null
$script:pauzaUrm = [DateTime]::MinValue
$script:taskSurse = $null
$script:urmSurse = [DateTime]::MinValue
$script:surse = @()            # ce a trimis serverul
$script:semnatura = ""
$script:carduri = @{}          # id -> @{card; bara; nume; info; btn}
$script:vorbeste = ""          # sursa care vorbește acum
$script:panaLa = [DateTime]::MinValue
$script:ascunsManual = $false
$script:dreapta = $null
$script:sus = $null

# ---------- dimensiuni (DPI) ----------
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$k = $g.DpiX / 96.0
$g.Dispose()
function S([double]$n) { [int][Math]::Round($n * $k) }
$W = S 320
$culFundal = [System.Drawing.Color]::FromArgb(32, 32, 36)
$culCard = [System.Drawing.Color]::FromArgb(45, 45, 52)
$culText = [System.Drawing.Color]::FromArgb(235, 235, 240)
$culGri = [System.Drawing.Color]::FromArgb(150, 150, 160)
$culVerde = [System.Drawing.Color]::FromArgb(46, 160, 90)
$culRosu = [System.Drawing.Color]::FromArgb(200, 70, 70)
$fontNume = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
$fontInfo = New-Object System.Drawing.Font("Segoe UI", 8.5)
$fontBtn = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)

# ---------- HTTP ----------
function Cerere($metoda, $cale, $json) {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($metoda), "$BASE$cale")
    [void]$req.Headers.TryAddWithoutValidation("X-Token", $TOKEN)
    if ($json) { $req.Content = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, "application/json") }
    return $http.SendAsync($req)
}

function Seteaza($id, $json) {
    try {
        $t = Cerere "POST" ("/surse/" + [Uri]::EscapeDataString($id)) $json
        [void]$t.Wait(3000)
    } catch {}
    $script:urmSurse = [DateTime]::MinValue  # reîncarcă imediat
}

function Taci {
    $player.Stop()
    $script:vorbeste = ""
    $script:panaLa = [DateTime]::MinValue
}

function DurataWav([byte[]]$b) {
    try {
        $byteRate = [BitConverter]::ToInt32($b, 28)
        for ($i = 12; $i -lt [Math]::Min($b.Length - 8, 4096); $i++) {
            if ($b[$i] -eq 0x64 -and $b[$i + 1] -eq 0x61 -and $b[$i + 2] -eq 0x74 -and $b[$i + 3] -eq 0x61) {
                return [BitConverter]::ToInt32($b, $i + 4) / [double]$byteRate
            }
        }
        return ($b.Length - 44) / [double]$byteRate
    } catch { return 10 }
}

function CandText([int]$sec) {
    if ($sec -lt 60) { return "acum câteva secunde" }
    if ($sec -lt 3600) { return "acum $([int]($sec / 60)) min" }
    return "acum $([int]($sec / 3600)) h"
}

# ---------- fereastra ----------
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = "None"
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = "Manual"
$form.BackColor = $culFundal
$form.Width = $W
$form.Text = "Voce Claude"

$antet = New-Object System.Windows.Forms.Panel
$antet.Dock = "Top"
$antet.Height = S 26
$antet.BackColor = $culFundal
$titlu = New-Object System.Windows.Forms.Label
$titlu.Text = "Voce Claude"
$titlu.ForeColor = $culGri
$titlu.Font = $fontInfo
$titlu.Location = New-Object System.Drawing.Point((S 10), (S 5))
$titlu.AutoSize = $true
$antet.Controls.Add($titlu)
$btnMin = New-Object System.Windows.Forms.Label
$btnMin.Text = "—"
$btnMin.ForeColor = $culGri
$btnMin.Font = $fontInfo
$btnMin.Cursor = "Hand"
$btnMin.AutoSize = $true
$btnMin.Location = New-Object System.Drawing.Point(($W - (S 26)), (S 4))
$antet.Controls.Add($btnMin)
$deTras = {
    if ($_.Button -eq "Left") {
        [void][Voce.Win]::ReleaseCapture()
        [void][Voce.Win]::SendMessage($form.Handle, 0xA1, 2, 0)
        $script:dreapta = $form.Right
        $script:sus = $form.Top
    }
}
$antet.Add_MouseDown($deTras)
$titlu.Add_MouseDown($deTras)

$lista = New-Object System.Windows.Forms.FlowLayoutPanel
$lista.FlowDirection = "TopDown"
$lista.WrapContents = $false
$lista.Location = New-Object System.Drawing.Point(0, (S 26))
$lista.Width = $W
$lista.Padding = New-Object System.Windows.Forms.Padding((S 6), 0, (S 6), (S 6))
$form.Controls.Add($lista)
$form.Controls.Add($antet)

$tip = New-Object System.Windows.Forms.ToolTip

function Aseaza {
    $h = (S 26) + $lista.Padding.Bottom
    foreach ($c in $lista.Controls) { $h += $c.Height + $c.Margin.Vertical }
    $lista.Height = $h - (S 26)
    $form.Height = $h
    $ecran = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    if ($null -eq $script:dreapta) { $script:dreapta = $ecran.Right - (S 12); $script:sus = $ecran.Top + (S 12) }
    $form.Location = New-Object System.Drawing.Point(($script:dreapta - $form.Width), $script:sus)
}

function CardNou($s) {
    $lat = $W - (S 12)
    $card = New-Object System.Windows.Forms.Panel
    $card.Width = $lat
    $card.Height = S 58
    $card.BackColor = $culCard
    $card.Margin = New-Object System.Windows.Forms.Padding(0, (S 6), 0, 0)

    $bara = New-Object System.Windows.Forms.Panel
    $bara.Dock = "Left"
    $bara.Width = S 4
    $card.Controls.Add($bara)

    $nume = New-Object System.Windows.Forms.Label
    $nume.Font = $fontNume
    $nume.ForeColor = $culText
    $nume.AutoEllipsis = $true
    $nume.Location = New-Object System.Drawing.Point((S 12), (S 8))
    $nume.Size = New-Object System.Drawing.Size(($lat - (S 118)), (S 20))
    $card.Controls.Add($nume)

    $info = New-Object System.Windows.Forms.Label
    $info.Font = $fontInfo
    $info.ForeColor = $culGri
    $info.AutoEllipsis = $true
    $info.Location = New-Object System.Drawing.Point((S 12), (S 30))
    $info.Size = New-Object System.Drawing.Size(($lat - (S 118)), (S 20))
    $card.Controls.Add($info)

    $btn = New-Object System.Windows.Forms.Button
    $btn.FlatStyle = "Flat"
    $btn.FlatAppearance.BorderSize = 0
    $btn.Font = $fontBtn
    $btn.ForeColor = [System.Drawing.Color]::White
    $btn.Size = New-Object System.Drawing.Size((S 78), (S 30))
    $btn.Location = New-Object System.Drawing.Point(($lat - (S 104)), (S 14))
    $btn.Cursor = "Hand"
    $btn.Tag = $s.id
    $btn.Add_Click({
        $id = $this.Tag
        $sursa = $script:surse | Where-Object { $_.id -eq $id } | Select-Object -First 1
        if ($sursa -and $sursa.oprit) {
            Seteaza $id '{"oprit": false}'
        } else {
            if ($script:vorbeste -eq $id) { Taci }
            Seteaza $id '{"oprit": true}'
        }
    })
    $card.Controls.Add($btn)

    $x = New-Object System.Windows.Forms.Label
    $x.Text = "×"
    $x.Font = $fontBtn
    $x.ForeColor = $culGri
    $x.Cursor = "Hand"
    $x.AutoSize = $true
    $x.Location = New-Object System.Drawing.Point(($lat - (S 20)), (S 2))
    $x.Tag = $s.id
    $x.Add_Click({
        if ($script:vorbeste -eq $this.Tag) { Taci }
        Seteaza $this.Tag '{"ascuns": true}'
    })
    $tip.SetToolTip($x, "Ascunde (reapare când vorbește din nou)")
    $card.Controls.Add($x)

    return @{ card = $card; bara = $bara; nume = $nume; info = $info; btn = $btn }
}

function Reconstruieste {
    $lista.SuspendLayout()
    $lista.Controls.Clear()
    $script:carduri = @{}
    foreach ($s in $script:surse) {
        $c = CardNou $s
        $script:carduri[$s.id] = $c
        $lista.Controls.Add($c.card)
    }
    $lista.ResumeLayout()
    Aseaza
}

function Pune($ctl, $prop, $val) { if ($ctl.$prop -ne $val) { $ctl.$prop = $val } }

function Actualizeaza {
    foreach ($s in $script:surse) {
        $c = $script:carduri[$s.id]
        if (-not $c) { continue }
        Pune $c.nume "Text" $s.nume
        $vorbesteAcum = ($script:vorbeste -eq $s.id) -and ([DateTime]::Now -lt $script:panaLa)
        if ($s.oprit) {
            Pune $c.bara "BackColor" $culRosu
            Pune $c.info "Text" ("oprit · " + $s.detalii)
            Pune $c.btn "Text" "Pornește"
            Pune $c.btn "BackColor" $culVerde
        } else {
            Pune $c.bara "BackColor" $(if ($vorbesteAcum) { $culVerde } else { $culGri })
            $cand = $(if ($vorbesteAcum) { "vorbește acum…" } else { CandText $s.acum_sec })
            Pune $c.info "Text" ("$cand · " + $s.detalii)
            Pune $c.btn "Text" "Stop"
            Pune $c.btn "BackColor" $culRosu
        }
        $sfat = "$($s.nume)`n$($s.detalii)`n`n$($s.text)"
        if ($c.sfat -ne $sfat) { $c.sfat = $sfat; $tip.SetToolTip($c.nume, $sfat); $tip.SetToolTip($c.info, $sfat) }
    }
    $areCeva = $script:surse.Count -gt 0
    if ($areCeva -and -not $script:ascunsManual -and -not $form.Visible) { $form.Show(); Aseaza }
    if (-not $areCeva -and $form.Visible) { $form.Hide() }
}

# ---------- tray ----------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Information
$tray.Text = "Voce Claude"
$tray.Visible = $true
$meniu = New-Object System.Windows.Forms.ContextMenuStrip
$miArata = $meniu.Items.Add("Arată / ascunde")
$miTaci = $meniu.Items.Add("Oprește mesajul de acum")
[void]$meniu.Items.Add("-")
$miIesire = $meniu.Items.Add("Ieșire (fără voce până la repornire)")
$tray.ContextMenuStrip = $meniu
$comuta = {
    if ($form.Visible) { $script:ascunsManual = $true; $form.Hide() }
    else { $script:ascunsManual = $false; $form.Show(); Aseaza }
}
$miArata.Add_Click($comuta)
$tray.Add_DoubleClick($comuta)
$btnMin.Add_Click({ $script:ascunsManual = $true; $form.Hide() })
$miTaci.Add_Click({ Taci })
$miIesire.Add_Click({ $tray.Visible = $false; Taci; [System.Windows.Forms.Application]::Exit() })

# ---------- bucla ----------
$ceas = New-Object System.Windows.Forms.Timer
$ceas.Interval = 250
$ceas.Add_Tick({
    $acum = [DateTime]::Now

    # mesaje noi de redat (long-poll)
    if ($null -eq $script:taskUrm -and $acum -ge $script:pauzaUrm) {
        try { $script:taskUrm = $http.GetAsync("$BASE/urmator?dupa=$($script:dupa)&timeout=25") } catch { $script:pauzaUrm = $acum.AddSeconds(5) }
    } elseif ($script:taskUrm -and $script:taskUrm.IsCompleted) {
        $t = $script:taskUrm
        $script:taskUrm = $null
        try {
            if ($t.IsFaulted -or $t.IsCanceled) { throw "fără conexiune" }
            $r = $t.Result
            if ([int]$r.StatusCode -eq 200) {
                $script:dupa = [int]($r.Headers.GetValues("X-Id") | Select-Object -First 1)
                $sid = ""
                $vals = $null
                if ($r.Headers.TryGetValues("X-Sursa", [ref]$vals)) { $sid = $vals | Select-Object -First 1 }
                $bytes = $r.Content.ReadAsByteArrayAsync().Result
                $sursa = $script:surse | Where-Object { $_.id -eq $sid } | Select-Object -First 1
                if (-not ($sursa -and $sursa.oprit)) {
                    $player.Stop()
                    [IO.File]::WriteAllBytes($wavFile, $bytes)
                    $player.SoundLocation = $wavFile
                    $player.Load()
                    $player.Play()
                    $script:vorbeste = $sid
                    $script:panaLa = $acum.AddSeconds((DurataWav $bytes) + 0.5)
                    $script:urmSurse = [DateTime]::MinValue
                }
            }
        } catch {
            $script:pauzaUrm = $acum.AddSeconds(5)  # containerul nu merge încă (Docker pornește după logare)
        }
    }

    # lista de surse, la 2 secunde
    if ($null -eq $script:taskSurse -and $acum -ge $script:urmSurse) {
        try { $script:taskSurse = Cerere "GET" "/surse" $null } catch { $script:urmSurse = $acum.AddSeconds(5) }
    } elseif ($script:taskSurse -and $script:taskSurse.IsCompleted) {
        $t = $script:taskSurse
        $script:taskSurse = $null
        $script:urmSurse = $acum.AddSeconds(2)
        try {
            if ($t.IsFaulted -or $t.IsCanceled) { throw "fără conexiune" }
            $r = $t.Result
            if ($r.IsSuccessStatusCode) {
                $text = $r.Content.ReadAsStringAsync().Result
                $script:surse = @((ConvertFrom-Json $text).surse)
                $sem = ($script:surse | ForEach-Object { $_.id }) -join "|"
                if ($sem -ne $script:semnatura) { $script:semnatura = $sem; Reconstruieste }
            }
        } catch { $script:urmSurse = $acum.AddSeconds(5) }
    }

    if ($script:vorbeste -and $acum -ge $script:panaLa) { $script:vorbeste = "" }
    Actualizeaza
})
$ceas.Start()

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
$mutex.ReleaseMutex()
