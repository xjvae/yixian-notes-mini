Add-Type -AssemblyName System.Drawing
# Patch out the bottom-right "Doubao AI" watermark WITHOUT cropping:
# fill the box by vertical interpolation between two clean bands, then smooth inside it.
$src = 'E:\zcode\yixian-notes-mini\docs\assets\ref-sidebar-1.png'
$dst = 'E:\zcode\yixian-notes-mini\docs\assets\ref-sidebar-clean.png'

# watermark glyphs measured at x 1231..1461 / y 2763..2807 (lum>250 scan)
$px0 = 1221; $px1 = 1471; $py0 = 2755; $py1 = 2815
$ty0 = 2747; $ty1 = 2823

$img = New-Object System.Drawing.Bitmap($src)
Write-Output ('loaded {0}x{1}' -f $img.Width, $img.Height)
if ($px1 -ge $img.Width -or $py1 -ge $img.Height) { throw 'patch box outside image' }

for ($x = $px0; $x -le $px1; $x++) {
  $a = $img.GetPixel($x, $ty0); $b = $img.GetPixel($x, $ty1)
  for ($y = $py0; $y -le $py1; $y++) {
    $t = ($y - $py0) / ($py1 - $py0)
    $r = [int]($a.R + ($b.R - $a.R) * $t)
    $g = [int]($a.G + ($b.G - $a.G) * $t)
    $bl = [int]($a.B + ($b.B - $a.B) * $t)
    $img.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $g, $bl))
  }
}

# 3x3 average strictly inside the box, so the seams at its border stay untouched
$sx0 = $px0 + 3; $sx1 = $px1 - 3; $sy0 = $py0 + 3; $sy1 = $py1 - 3
$copy = New-Object System.Drawing.Bitmap($img)
for ($y = $sy0; $y -le $sy1; $y++) {
  for ($x = $sx0; $x -le $sx1; $x++) {
    $sr = 0; $sg = 0; $sb = 0
    for ($dy = -1; $dy -le 1; $dy++) {
      for ($dx = -1; $dx -le 1; $dx++) {
        $p = $copy.GetPixel($x + $dx, $y + $dy)
        $sr += $p.R; $sg += $p.G; $sb += $p.B
      }
    }
    $img.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, [int]($sr / 9), [int]($sg / 9), [int]($sb / 9)))
  }
}
$copy.Dispose()

$img.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ('patched x {0}..{1} y {2}..{3} -> {4}' -f $px0, $px1, $py0, $py1, (Split-Path $dst -Leaf))

# 4x zoom of the same bottom band, for eyeball check.
# The 164x314 output maps 1 source px -> 1481/164 = 9.03 px, so its bottom 40 rows
# are source rows 2473..2831 (358 tall) across the full 1481 width.
$zoom = New-Object System.Drawing.Bitmap(656, 160)
$g = [System.Drawing.Graphics]::FromImage($zoom)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, 656, 160)), 0, 2473, 1481, 358, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$zoom.Save('E:\zcode\yixian-notes-mini\docs\assets\sidebar-bottom-4x.png', [System.Drawing.Imaging.ImageFormat]::Png)
$zoom.Dispose(); $img.Dispose()
Write-Output 'sidebar-bottom-4x.png rewritten'
