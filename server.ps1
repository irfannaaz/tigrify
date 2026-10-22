# Tiger local server: serves this folder on http://localhost only, read-only.
# Quits by itself a few minutes after the last Tiger tab is closed.
param([int]$Port = 47123)

$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.wasm' = 'application/wasm'; '.json' = 'application/json'; '.png' = 'image/png'
  '.md' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { exit 1 }

$lastSeen = [DateTime]::UtcNow
$idleLimit = [TimeSpan]::FromMinutes(3)

while ($listener.IsListening) {
  $pending = $listener.GetContextAsync()
  while (-not $pending.AsyncWaitHandle.WaitOne(5000)) {
    if (([DateTime]::UtcNow - $lastSeen) -gt $idleLimit) { $listener.Stop(); exit 0 }
  }
  try { $ctx = $pending.Result } catch { break }
  $lastSeen = [DateTime]::UtcNow
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($ctx.Request.HttpMethod -ne 'GET' -and $ctx.Request.HttpMethod -ne 'HEAD') {
      $res.StatusCode = 405
    } elseif ($path -eq '__ping') {
      $res.StatusCode = 204
    } else {
      if (-not $path) { $path = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))
      if ($file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        $type = $types[[IO.Path]::GetExtension($file).ToLower()]
        $res.ContentType = if ($type) { $type } else { 'application/octet-stream' }
        $res.Headers['Cache-Control'] = 'no-cache'
        $res.Headers['X-Content-Type-Options'] = 'nosniff'
        $stream = [IO.File]::OpenRead($file)
        try {
          $res.ContentLength64 = $stream.Length
          if ($ctx.Request.HttpMethod -eq 'GET') { $stream.CopyTo($res.OutputStream) }
        } finally { $stream.Dispose() }
      } else {
        $res.StatusCode = 404
      }
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
