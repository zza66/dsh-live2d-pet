param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Left = 0, [int]$Top = 0, [int]$Width = 0, [int]$Height = 0
)
# 抓当前屏幕到 BMP（BMP 是为了让 Node 侧不用引 PNG 解码器：28 字节头 + 裸像素）。
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
if ($Width -le 0 -or $Height -le 0) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $Left = $bounds.Left; $Top = $bounds.Top; $Width = $bounds.Width; $Height = $bounds.Height
}
$bmp = New-Object System.Drawing.Bitmap($Width, $Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($Left, $Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$gfx.Dispose(); $bmp.Dispose()
Write-Output ("{0} {1}x{2} {3}" -f $Out, $Width, $Height, (Get-Item $Out).Length)
