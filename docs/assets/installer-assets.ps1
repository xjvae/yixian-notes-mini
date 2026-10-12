Add-Type -AssemblyName System.Drawing
# Installer bitmaps for NSIS: crop/resize from docs/assets/ref-*.png into the two hard sizes.
# Outputs land in docs/assets/ ; the design doc references these files directly.
# NOTE: keep this file ASCII-only. A Chinese comment here got decoded as a line-continuation
#       and silently swallowed the next Make call (no error, no output, no file written).
$dir = 'E:\zcode\yixian-notes-mini\docs\assets'

function Make([string]$src, [string]$base, [int]$sx, [int]$sy, [int]$sw, [int]$sh, [int]$dw, [int]$dh) {
  $img = New-Object System.Drawing.Bitmap($src)
  $rr = $sw / $sh; $need = $dw / $dh
  $bmp = New-Object System.Drawing.Bitmap($dw, $dh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $rect = New-Object System.Drawing.Rectangle(0, 0, $dw, $dh)
  $g.DrawImage($img, $rect, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  # NSIS takes only 24-bit uncompressed BMP here; the PNG is for the design doc preview
  $bmp.Save((Join-Path $dir ($base + '.bmp')), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Save((Join-Path $dir ($base + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $img.Dispose()
  Write-Output ('{0}  src {1}x{2} ratio {3:N4} vs {4:N4}' -f $base, $sw, $sh, $rr, $need)
}

# header: the wordmark band, no laptop, 1:1 at 150x57
Make (Join-Path $dir 'ref-hero.png')      'installer-header'  71 60 821 312 150 57
# sidebar: whole image, resize only, no crop. 1481x2831 (0.5231) vs 164x314 (0.5223) = 0.15% off
# ref-sidebar-clean.png = the user's image with the bottom-right watermark patched out (wm-patch.ps1)
Make (Join-Path $dir 'ref-sidebar-clean.png') 'installer-sidebar' 0 0 1481 2831 164 314

foreach ($f in Get-ChildItem $dir -Filter 'installer-*.bmp') {
  $fs = [System.IO.File]::ReadAllBytes($f.FullName)
  Write-Output ('{0}  {1} bytes  bpp={2}' -f $f.Name, $f.Length, [BitConverter]::ToUInt16($fs, 28))
}
