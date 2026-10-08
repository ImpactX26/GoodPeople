# Start Luna locally: the food checker + NGO agent (Python, port 8000) and the website (Next.js, port 3000).
# Each opens in its own window so you can see its logs; close a window to stop that server.
#
#   powershell -ExecutionPolicy Bypass -File .\start-luna.ps1
#   (or right-click start-luna.ps1 > "Run with PowerShell")

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Port($port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Path "$root\.venv\Scripts\python.exe")) {
    Write-Host "Python environment missing. Run once:  python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path "$root\web\node_modules")) {
    Write-Host "Installing website dependencies (first run only)..." -ForegroundColor Yellow
    Push-Location "$root\web"; npm install; Pop-Location
}

if (Test-Port 8000) {
    Write-Host "Food checker already running on port 8000." -ForegroundColor Green
} else {
    Start-Process powershell -WorkingDirectory $root -ArgumentList @(
        "-NoExit", "-Command",
        "`$Host.UI.RawUI.WindowTitle = 'Luna - food checker (port 8000)'; & '$root\.venv\Scripts\python.exe' run.py"
    )
    Write-Host "Starting the food checker on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
}

if (Test-Port 3000) {
    Write-Host "Website already running on port 3000." -ForegroundColor Green
} else {
    Start-Process powershell -WorkingDirectory "$root\web" -ArgumentList @(
        "-NoExit", "-Command",
        "`$Host.UI.RawUI.WindowTitle = 'Luna - website (port 3000)'; npm run dev"
    )
    Write-Host "Starting the website on https://localhost:3000 ..." -ForegroundColor Cyan
}

# wait until both answer, then open the browser
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline -and -not ((Test-Port 8000) -and (Test-Port 3000))) { Start-Sleep -Seconds 2 }
if ((Test-Port 8000) -and (Test-Port 3000)) {
    Write-Host "Luna is up: https://localhost:3000" -ForegroundColor Green
    Start-Process "https://localhost:3000"
} else {
    Write-Host "Still starting. Check the two server windows for errors." -ForegroundColor Yellow
}
