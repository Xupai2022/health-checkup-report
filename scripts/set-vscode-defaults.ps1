param(
    [string[]]$Extensions = @(
        ".ps1", ".psm1", ".psd1",
        ".py", ".pyw",
        ".js", ".mjs", ".cjs",
        ".ts", ".tsx", ".jsx",
        ".sh", ".bash", ".zsh",
        ".bat", ".cmd",
        ".rb", ".php", ".pl", ".lua",
        ".go", ".rs", ".java", ".kt", ".kts",
        ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
        ".cs", ".fs", ".fsx",
        ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env",
        ".html", ".htm", ".css", ".scss", ".less", ".xml",
        ".sql", ".r", ".R", ".ipynb"
    )
)

$ErrorActionPreference = "Stop"

$codeCommand = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCommand) {
    throw "VS Code command 'code' was not found on PATH."
}

$codeCmd = $codeCommand.Source
$codeExe = Join-Path (Split-Path (Split-Path $codeCmd -Parent) -Parent) "Code.exe"
if (-not (Test-Path -LiteralPath $codeExe)) {
    throw "Could not find Code.exe next to '$codeCmd'."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $PSScriptRoot "file-association-backups"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$fileExtsBackup = Join-Path $backupDir "HKCU-Explorer-FileExts-$timestamp.reg"
$classesBackup = Join-Path $backupDir "HKCU-Software-Classes-$timestamp.reg"
& reg.exe export "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts" $fileExtsBackup /y | Out-Null
& reg.exe export "HKCU\Software\Classes" $classesBackup /y | Out-Null

$progId = "VSCode.ScriptFile"
$progIdRoot = "Registry::HKEY_CURRENT_USER\Software\Classes\$progId"
New-Item -Path $progIdRoot -Force | Out-Null
New-ItemProperty -Path $progIdRoot -Name "(default)" -Value "VS Code Script File" -PropertyType String -Force | Out-Null
New-Item -Path "$progIdRoot\DefaultIcon" -Force | Out-Null
New-ItemProperty -Path "$progIdRoot\DefaultIcon" -Name "(default)" -Value "`"$codeExe`",0" -PropertyType String -Force | Out-Null
New-Item -Path "$progIdRoot\shell\open\command" -Force | Out-Null
New-ItemProperty -Path "$progIdRoot\shell\open\command" -Name "(default)" -Value "`"$codeExe`" `"%1`"" -PropertyType String -Force | Out-Null

$helperPath = Join-Path $PSScriptRoot "SFTA.ps1"
if (-not (Test-Path -LiteralPath $helperPath)) {
    $uri = "https://raw.githubusercontent.com/DanysysTeam/PS-SFTA/master/SFTA.ps1"
    Invoke-WebRequest -Uri $uri -OutFile $helperPath
}
. $helperPath
if (-not (Get-Command Set-FTA -ErrorAction SilentlyContinue)) {
    throw "Failed to load Set-FTA from helper script."
}

$results = foreach ($ext in $Extensions) {
    if (-not $ext.StartsWith(".")) {
        $ext = ".$ext"
    }

    $setChoice = $false
    try {
        $classKey = "Registry::HKEY_CURRENT_USER\Software\Classes\$ext"
        New-Item -Path $classKey -Force | Out-Null
        New-ItemProperty -Path $classKey -Name "(default)" -Value $progId -PropertyType String -Force | Out-Null
        Set-FTA $progId $ext | Out-Null
        $setChoice = $true
    }
    catch {
        $setChoice = $false
    }

    [pscustomobject]@{
        Extension = $ext
        ProgId = $progId
        UserChoiceSet = $setChoice
    }
}

Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Process explorer.exe

$results | Sort-Object Extension | Format-Table -AutoSize
Write-Host ""
Write-Host "Backups saved to: $backupDir"
Write-Host "VS Code executable: $codeExe"
