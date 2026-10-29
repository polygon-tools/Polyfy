<#
  Polyfy - maandelijkse back-up van alle gegevens naar deze pc (Windows).

  Eenmalig installeren (PowerShell, in de map waar dit bestand staat):
      powershell -ExecutionPolicy Bypass -File .\polyfy-backup.ps1 -Install

  -Install vraagt je Polyfy-wachtwoord (beheerdersaccount), bewaart het versleuteld voor jouw
  Windows-gebruiker (DPAPI), kopieert dit script naar %APPDATA%\Polyfy en maakt een geplande taak
  "Polyfy back-up" die elke dag bij aanmelden en om 12:00 kijkt of de back-up van deze maand er al is.
  Zo niet, dan wordt ze gemaakt (ook als de pc op de 1e van de maand uit stond).

  Elke back-up = 1 zip in Documenten\Polyfy-backups (bv. polyfy-backup-2026-10.zip) met:
    - registraties.csv  : alle uren, leesbaar in Excel (datum, start, einde, duur, medewerker, klant, project, ...)
    - <tabel>.json      : volledige ruwe tabellen (profiles, clients, projects, tags, time_entries, invites),
                          genoeg om de database terug op te bouwen.

  Andere opties:
      -Now        meteen een back-up maken, ook als die van deze maand al bestaat
      -Uninstall  geplande taak en opgeslagen wachtwoord verwijderen (back-ups blijven staan)
#>
param([switch]$Install, [switch]$Uninstall, [switch]$Now, [string]$Folder)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # de voortgangsbalk maakt downloads in PowerShell 5.1 erg traag
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Url = 'https://yufmwzrtsznvjfijwvur.supabase.co'
$Key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1Zm13enJ0c3pudmpmaWp3dnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyODYyMTIsImV4cCI6MjEwNjg2MjIxMn0.QooQ-wfuI1Wtlu0lzNXQF7s74HsNwYHqIEe9P8IV2Zk'
$Home2 = Join-Path $env:APPDATA 'Polyfy'
$CredFile = Join-Path $Home2 'login.xml'
$CfgFile = Join-Path $Home2 'map.txt'
$TaskName = 'Polyfy back-up'
$Tables = 'profiles', 'clients', 'projects', 'tags', 'time_entries', 'invites'

function Get-BackupFolder {
  if ($Folder) { return $Folder }
  if (Test-Path $CfgFile) { return (Get-Content $CfgFile -Raw).Trim() }
  return Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Polyfy-backups'
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $CredFile, $CfgFile -ErrorAction SilentlyContinue
  Write-Host 'Geplande taak en opgeslagen wachtwoord verwijderd. De back-ups zelf blijven staan.'
  exit 0
}

if ($Install) {
  New-Item -ItemType Directory -Force $Home2 | Out-Null
  $cred = Get-Credential -Message 'Polyfy: je e-mailadres en wachtwoord (beheerdersaccount)'
  if (-not $cred) { Write-Host 'Geannuleerd.'; exit 1 }
  $cred | Export-Clixml $CredFile   # versleuteld, enkel leesbaar door jouw Windows-gebruiker op deze pc
  $dest = Get-BackupFolder
  Set-Content $CfgFile $dest
  Copy-Item $PSCommandPath (Join-Path $Home2 'polyfy-backup.ps1') -Force
  # Dagelijks om 12:00 en bij aanmelden (gemiste keren worden ingehaald); het script zelf slaat over als deze maand al gedaan is
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Home2\polyfy-backup.ps1`""
  $trig = @((New-ScheduledTaskTrigger -Daily -At '12:00'), (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"))
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trig -Settings $set -Description 'Maandelijkse back-up van Polyfy (tools/polyfy-backup.ps1)' -Force | Out-Null
  Write-Host "Geplande taak '$TaskName' gemaakt. Back-ups komen in: $dest"
  Write-Host 'Eerste back-up wordt nu gemaakt...'
  $Now = $true
}

$dest = Get-BackupFolder
New-Item -ItemType Directory -Force $dest | Out-Null
$month = Get-Date -Format 'yyyy-MM'
$zip = Join-Path $dest "polyfy-backup-$month.zip"
$log = Join-Path $dest 'backup-log.txt'
$failFile = Join-Path $dest 'LAATSTE-BACKUP-MISLUKT.txt'
function Log($msg) { Add-Content $log ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $msg) -Encoding UTF8; Write-Host $msg }

if ((Test-Path $zip) -and -not $Now) { exit 0 }   # deze maand al gedaan

try {
  if (-not (Test-Path $CredFile)) { throw "Geen opgeslagen login. Voer eerst uit: polyfy-backup.ps1 -Install" }
  $cred = Import-Clixml $CredFile
  $body = @{ email = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json
  try {
    $auth = Invoke-RestMethod -Method Post -Uri "$Url/auth/v1/token?grant_type=password" -Headers @{ apikey = $Key } -ContentType 'application/json' -Body $body
  } catch { throw "Inloggen mislukt (wachtwoord gewijzigd? Voer -Install opnieuw uit). $($_.Exception.Message)" }
  $hdr = @{ apikey = $Key; Authorization = "Bearer $($auth.access_token)" }

  # JSON-tekst -> lijst (Windows PowerShell 5.1 geeft een JSON-array als een enkel object terug)
  function As-List($json) { $o = ConvertFrom-Json $json; if ($null -eq $o) { return ,@() }; return ,@($o | ForEach-Object { $_ }) }
  # Alle rijen ophalen, per blok (Supabase geeft max. 1000 per keer) tot er niets meer komt. Geeft de ruwe JSON (exact zoals in de database) en de rijen.
  function Get-All($table) {
    $rows = New-Object System.Collections.ArrayList; $parts = New-Object System.Collections.ArrayList
    $off = 0
    do {
      $raw = (Invoke-WebRequest -UseBasicParsing -Uri "$Url/rest/v1/${table}?select=*&order=$(if ($table -eq 'invites') { 'email' } else { 'id' })&limit=1000&offset=$off" -Headers $hdr).Content
      if ($raw -is [byte[]]) { $raw = [Text.Encoding]::UTF8.GetString($raw) }
      $page = As-List $raw
      if ($page.Count) { [void]$rows.AddRange($page); [void]$parts.Add($raw.Trim().TrimStart('[').TrimEnd(']')) }
      $off += $page.Count
    } while ($page.Count -gt 0)
    return @{ rows = $rows; json = '[' + ($parts -join ',') + ']' }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) "polyfy-backup-$([guid]::NewGuid())"
  New-Item -ItemType Directory $tmp | Out-Null
  $data = @{}
  foreach ($t in $Tables) {
    try { $r = Get-All $t }
    catch { Log "Tabel $t overgeslagen: $($_.Exception.Message)"; $r = @{ rows = (New-Object System.Collections.ArrayList); json = '[]' } }
    $data[$t] = $r.rows
    [IO.File]::WriteAllText((Join-Path $tmp "$t.json"), $r.json, (New-Object Text.UTF8Encoding $false))
  }
  if ($data['time_entries'].Count -eq 0) { throw 'Geen registraties ontvangen; is dit een beheerdersaccount?' }

  # Leesbare lijst van alle uren
  function Index($list) { $h = @{}; foreach ($r in $list) { $h[[string]$r.id] = $r }; return $h }
  $prof = Index $data['profiles']; $cli = Index $data['clients']; $proj = Index $data['projects']; $tag = Index $data['tags']
  function ToLocal($v) { if ($null -eq $v -or $v -eq '') { return $null }; if ($v -is [datetime]) { return $v.ToLocalTime() }; return ([DateTimeOffset]::Parse([string]$v)).LocalDateTime }
  $csv = foreach ($e in ($data['time_entries'] | Sort-Object start_at)) {
    $s = ToLocal $e.start_at; $en = ToLocal $e.end_at
    $u = if ($e.user_id) { $prof[[string]$e.user_id] } else { $null }
    $p = if ($e.project_id) { $proj[[string]$e.project_id] } else { $null }
    $c = if ($p -and $p.client_id) { $cli[[string]$p.client_id] } else { $null }
    $mins = if ($en) { [math]::Round(($en - $s).TotalMinutes) } else { $null }
    [pscustomobject][ordered]@{
      Date        = $s.ToString('dd/MM/yyyy', [Globalization.CultureInfo]::InvariantCulture)
      Start       = $s.ToString('HH:mm')
      End         = if ($en) { $en.ToString('HH:mm') } else { 'running' }
      Duration    = if ($null -ne $mins) { '{0}:{1:00}' -f [math]::Floor($mins / 60), ($mins % 60) } else { '' }
      Hours       = if ($null -ne $mins) { ([math]::Round($mins / 60, 2)).ToString([Globalization.CultureInfo]'nl-BE') } else { '' }
      User        = if ($u) { if ($u.full_name) { $u.full_name } else { $u.email } } else { $e.import_name }
      Email       = if ($u) { $u.email } else { ([string]$e.import_email) -replace '^deleteduser:', '' }
      Client      = if ($c) { $c.name } else { '' }
      Project     = if ($p) { $p.name } else { '' }
      Description = $e.description
      Tags        = (@($e.tag_ids) | Where-Object { $_ } | ForEach-Object { $tag[[string]$_].name }) -join ', '
      Billable    = if ($e.billable) { 'Yes' } else { 'No' }
    }
  }
  $csv | Export-Csv (Join-Path $tmp 'registraties.csv') -Delimiter ';' -NoTypeInformation -Encoding UTF8

  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip
  Remove-Item $tmp -Recurse -Force
  Remove-Item $failFile -ErrorAction SilentlyContinue
  Log ("Back-up gemaakt: {0} ({1} registraties, {2} projecten, {3} medewerkers)" -f $zip, $data['time_entries'].Count, $data['projects'].Count, $data['profiles'].Count)
} catch {
  if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  Log "MISLUKT: $($_.Exception.Message)"
  Set-Content $failFile ("De Polyfy-back-up van {0} is mislukt:`r`n{1}`r`n`r`nZie backup-log.txt. Opnieuw proberen: polyfy-backup.ps1 -Now (in %APPDATA%\Polyfy)." -f (Get-Date -Format 'dd/MM/yyyy HH:mm'), $_.Exception.Message) -Encoding UTF8
  exit 1
}
