# ZettelAgent Landing Page - 媒体压缩脚本
# ============================================================
# 使用方法：
#   1. 安装 ffmpeg: https://ffmpeg.org/download.html (Windows builds from gyan.dev)
#   2. 把 ffmpeg.exe 所在目录加入系统 PATH
#   3. 右键此文件 → "使用 PowerShell 运行"，或在终端执行: .\compress-media.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$landingDir = Join-Path $PSScriptRoot "landing-page"

Write-Host "=== ZettelAgent 媒体压缩 ===" -ForegroundColor Cyan
Write-Host ""

# 检查 ffmpeg
try {
    $ffmpegVersion = (ffmpeg -version 2>&1 | Select-Object -First 1)
    Write-Host "✓ $ffmpegVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ ffmpeg 未安装！请先安装 ffmpeg 并加入 PATH" -ForegroundColor Red
    Write-Host "  下载地址: https://github.com/BtbN/FFmpeg-Builds/releases" -ForegroundColor Yellow
    Write-Host "  安装后重新运行此脚本" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "开始压缩..." -ForegroundColor Cyan
Write-Host ""

# ── 1. MP4 重压缩 (12MB → ~2MB) ──
Write-Host "[1/4] 压缩 knowledge-graph-demo.mp4 ..." -ForegroundColor Yellow
$mp4Input = Join-Path $landingDir "knowledge-graph-demo.mp4"
$mp4Output = Join-Path $landingDir "knowledge-graph-demo-compressed.mp4"
if (Test-Path $mp4Input) {
    $originalSize = (Get-Item $mp4Input).Length
    ffmpeg -i $mp4Input -vcodec libx264 -crf 28 -preset slow -profile:v high -level 4.1 -movflags +faststart -an $mp4Output -y 2>&1 | Out-Null
    if (Test-Path $mp4Output) {
        $newSize = (Get-Item $mp4Output).Length
        $ratio = [math]::Round((1 - $newSize / $originalSize) * 100, 1)
        Write-Host "  ✓ $originalSize → $newSize ($ratio% 缩小)" -ForegroundColor Green
        Remove-Item $mp4Input -Force
        Rename-Item $mp4Output "knowledge-graph-demo.mp4" -Force
    }
} else {
    Write-Host "  ✗ 文件不存在，跳过" -ForegroundColor DarkGray
}

# ── 2. GIF → WebM 转换 ──
Write-Host "[2/4] 转换 GIF → WebM ..." -ForegroundColor Yellow
$gifFiles = @(
    "knowledge-graph-interactive.gif",
    "showcase-knowledge-graph.gif",
    "showcase-graph-view.gif"
)

foreach ($gif in $gifFiles) {
    $input = Join-Path $landingDir $gif
    $outputName = $gif -replace '\.gif$', '.webm'
    $output = Join-Path $landingDir $outputName
    
    if (Test-Path $input) {
        $originalSize = (Get-Item $input).Length
        ffmpeg -i $input -c vp9 -b:v 0 -crf 41 -lag-in-filters=0 -row-mt=1 $output -y 2>&1 | Out-Null
        if (Test-Path $output) {
            $newSize = (Get-Item $output).Length
            $ratio = [math]::Round((1 - $newSize / $originalSize) * 100, 1)
            Write-Host "  ✓ $gif → $outputName ($ratio% 缩小)" -ForegroundColor Green
            # 保留 .gif 作为 fallback（HTML 已处理回退）
        }
    } else {
        Write-Host "  ✗ $gif 不存在，跳过" -ForegroundColor DarkGray
    }
}

# ── 3. Logo PNG → WebP ──
Write-Host "[3/4] 转换 logo PNG → WebP ..." -ForegroundColor Yellow
$pngInput = Join-Path $landingDir "new_logo.png"
$webpOutput = Join-Path $landingDir "new_logo.webp"
if (Test-Path $pngInput) {
    # 尝试用 ffmpeg 转换
    ffmpeg -i $pngInput -q:v 80 $webpOutput -y 2>&1 | Out-Null
    if (Test-Path $webpOutput) {
        $originalSize = (Get-Item $pngInput).Length
        $newSize = (Get-Item $webpOutput).Length
        $ratio = [math]::Round((1 - $newSize / $originalSize) * 100, 1)
        Write-Host "  ✓ new_logo.png → new_logo.webp ($ratio% 缩小)" -ForegroundColor Green
    }
} else {
    Write-Host "  ✗ new_logo.png 不存在，跳过" -ForegroundColor DarkGray
}

# ── 4. 生成视频 poster 截图 ──
Write-Host "[4/4] 生成视频 poster 截图 ..." -ForegroundColor Yellow
$mp4File = Join-Path $landingDir "knowledge-graph-demo.mp4"
$posterOutput = Join-Path $landingDir "knowledge-graph-demo-poster.webp"
if (Test-Path $mp4File) {
    ffmpeg -i $mp4File -ss 00:00:00.100 -frames:v 1 -q:v 80 $posterOutput -y 2>&1 | Out-Null
    if (Test-Path $posterOutput) {
        Write-Host "  ✓ 生成 knowledge-graph-demo-poster.webp" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== 压缩完成 ===" -ForegroundColor Cyan
Write-Host "安装以上改动后，运行: git add -A && git commit -m 'perf: optimize landing page media' && git push origin master" -ForegroundColor White
