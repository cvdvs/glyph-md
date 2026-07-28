# Fetches the WebView2 SDK headers the Windows build needs.
#
#   powershell -ExecutionPolicy Bypass -File Scripts\fetch-webview2.ps1
#
# The vendored webview.h does `#include "WebView2.h"`, which comes from
# Microsoft's NuGet package. Only headers are taken: the library has a built-in
# loader, so WebView2Loader.dll is not linked and nothing is redistributed.
#
# The version and its hash are PINNED. A build that silently picked up whatever
# NuGet served today would be a build nobody could reproduce, and this is the
# one dependency that is fetched rather than committed - the package is 9MB of
# mostly-unused binaries, which does not belong in a repo this small.
$ErrorActionPreference = "Stop"

$Version = "1.0.4078.44"
$Sha256  = "DC4D1D9168DF26B830398303E50210B6E1729F6CE5A7AC69D2C766852F489962"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root "shell\vendor\webview2"
$marker = Join-Path $dest "VERSION.txt"

if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $Version)) {
    Write-Host "WebView2 SDK $Version already present"
    exit 0
}

$url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
# .zip, not .nupkg: Expand-Archive refuses any other extension, though a
# nupkg is an ordinary zip underneath.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "webview2-$Version.zip"

Write-Host "downloading WebView2 SDK $Version"
# TLS 1.2 is not the default on older PowerShell and nuget.org refuses anything less.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

$got = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash
if ($got -ne $Sha256) {
    Remove-Item $tmp -Force
    throw "WebView2 SDK checksum mismatch. Expected $Sha256, got $got. Refusing to use it."
}
Write-Host "checksum ok"

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "webview2-extract-$Version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
Expand-Archive -Path $tmp -DestinationPath $staging -Force

$include = Join-Path $dest "include"
New-Item -ItemType Directory -Path $include -Force | Out-Null
Copy-Item (Join-Path $staging "build\native\include\WebView2.h") $include
Copy-Item (Join-Path $staging "build\native\include\WebView2EnvironmentOptions.h") $include
Copy-Item (Join-Path $staging "LICENSE.txt") $dest
Set-Content -Path $marker -Value $Version -NoNewline

Remove-Item $tmp -Force
Remove-Item $staging -Recurse -Force
Write-Host "WebView2 headers in shell\vendor\webview2\include"
