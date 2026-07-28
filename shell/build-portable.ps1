# Builds Glyph for Windows.
#
#   shell\build-portable.ps1              # build
#   shell\build-portable.ps1 -Selftest    # build, then run the suites in it
#
# Needs the MSVC toolchain (Build Tools for Visual Studio) and Python 3. Run it
# from a "Developer PowerShell for VS" so cl.exe is on PATH, or let it find one.
param([switch]$Selftest)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$out = Join-Path $root "shell\build"
New-Item -ItemType Directory -Path $out -Force | Out-Null

# The interface is compiled in, so regenerate it whenever it changes. This also
# refuses CRLF: a checkout with core.autocrlf=true would otherwise ship a
# viewer.html that differs from the one macOS ships, and the typing rules would
# fail on Windows only.
$py = if (Get-Command python -ErrorAction SilentlyContinue) { "python" } else { "python3" }
& $py Scripts\embed-resources.py shell\resources.h
if ($LASTEXITCODE -ne 0) { throw "embedding the interface failed" }

& powershell -ExecutionPolicy Bypass -File Scripts\fetch-webview2.ps1
if ($LASTEXITCODE -ne 0) { throw "fetching the WebView2 SDK failed" }

. (Join-Path $root "Scripts\msvc-env.ps1")

# /utf-8 is not optional: without it MSVC reads the source in the machine's
# codepage, and a Romanian or Japanese Windows would decode the file
# differently. The generated header is pure ASCII for the same reason.
$args = @(
    "/nologo", "/std:c++17", "/EHsc", "/O2", "/W3", "/utf-8",
    "/DWEBVIEW_STATIC", "/DUNICODE", "/D_UNICODE",
    "/I", "shell\vendor\webview", "/I", "shell", "/I", "shell\vendor\webview2\include",
    "shell\glyph.cc",
    "/Fe:$out\glyph.exe", "/Fo:$out\\",
    "/link",
    # A GUI app: no console window follows the user around. --selftest reattaches
    # to whatever console launched it, so CI still sees the output.
    "/SUBSYSTEM:WINDOWS", "/ENTRY:mainCRTStartup",
    "user32.lib", "ole32.lib", "oleaut32.lib", "shell32.lib", "shlwapi.lib",
    "comdlg32.lib", "advapi32.lib", "version.lib"
)
Write-Host "compiling"
& cl.exe @args
if ($LASTEXITCODE -ne 0) { throw "the build failed" }

Write-Host "built $out\glyph.exe"

if ($Selftest) {
    & "$out\glyph.exe" --selftest
    if ($LASTEXITCODE -ne 0) { throw "the selftest failed" }
}
