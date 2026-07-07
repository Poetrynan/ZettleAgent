$ErrorActionPreference = "Stop"
$landingDir = Join-Path $PSScriptRoot "landing-page"

if (!(Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "ffmpeg not found. Install via: winget install ffmpeg" -ForegroundColor Red
    exit 1
}

Write-Host "=== ZettelAgent Media Compression ===" -ForegroundColor Cyan

Write-Host "`n[1/4] Compressing Hero MP4 ..." -ForegroundColor Yellow
$mp4Input = Join-Path $landingDir "knowledge-graph-demo.mp4"
$mp4Output = Join-Path $landingDir "knowledge-graph-demo-compressed.mp4"
if (Test-Path $mp4Input) {
    $orig = (Get-Item $mp4Input).Length
    ffmpeg -i $mp4Input -vcodec libx264 -crf 28 -preset slow -profile:v high -level 4.1 -movflags +faststart -an $mp4Output -y 2>&1 | Out-Null
    if (Test-Path $mp4Output) {
        $new = (Get-Item $mp4Output).Length
        Write-Host "  $([math]::Round($orig/1MB,1))MB -> $([math]::Round($new/1MB,1))MB ($([math]::Round((1-$new/$orig)*100,1))% smaller)" -ForegroundColor Green
        Remove-Item $mp4Input -Force
        Rename-Item $mp4Output "knowledge-graph-demo.mp4" -Force
    }
}

Write-Host "`n[2/4] Converting GIFs to WebM ..." -ForegroundColor Yellow
foreach ($gif in @("knowledge-graph-interactive.gif", "showcase-knowledge-graph.gif", "showcase-graph-view.gif")) {
    $input = Join-Path $landingDir $gif
    $output = Join-Path $landingDir ($gif -replace '\.gif$', '.webm')
    if (Test-Path $input) {
        $orig = (Get-Item $input).Length
        ffmpeg -i $input -c vp9 -b:v 0 -crf 41 -row-mt=1 $output -y 2>&1 | Out-Null
        if (Test-Path $output) {
            $new = (Get-Item $output).Length
            Write-Host "  $gif $([math]::Round($orig/1MB,1))MB -> $([math]::Round($new/1KB,0))KB ($([math]::Round((1-$new/$orig)*100,1))% smaller)" -ForegroundColor Green
        }
    }
}

Write-Host "`n[3/4] Converting logo PNG to WebP ..." -ForegroundColor Yellow
$pngInput = Join-Path $landingDir "new_logo.png"
$webpOutput = Join-Path $landingDir "new_logo.webp"
if (Test-Path $pngInput) {
    $orig = (Get-Item $pngInput).Length
    ffmpeg -i $pngInput -q:v 80 $webpOutput -y 2>&1 | Out-Null
    if (Test-Path $webpOutput) {
        $new = (Get-Item $webpOutput).Length
        Write-Host "  new_logo.png $([math]::Round($orig/1KB,0))KB -> $([math]::Round($new/1KB,0))KB ($([math]::Round((1-$new/$orig)*100,1))% smaller)" -ForegroundColor Green
    }
}

Write-Host "`n[4/4] Generating video poster ..." -ForegroundColor Yellow
$mp4 = Join-Path $landingDir "knowledge-graph-demo.mp4"
$poster = Join-Path $landingDir "knowledge-graph-demo-poster.webp"
if (Test-Path $mp4) {
    ffmpeg -i $mp4 -ss 00:00:00.100 -frames:v 1 -q:v 80 $poster -y 2>&1 | Out-Null
    if (Test-Path $poster) { Write-Host "  Created poster.webp" -ForegroundColor Green }
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
