# Puts the MSVC toolchain on PATH in the CURRENT PowerShell session.
#
#   . Scripts\msvc-env.ps1        # note the leading dot: it must be dot-sourced
#
# Visual Studio's install path moves with every edition and every year, so it is
# never hardcoded - a hardcoded "...\2022\Enterprise\..." is exactly what broke
# the first Windows CI run, because the runner had a different edition. vswhere
# ships with every VS installer since 2017 and is the supported way to ask.
$ErrorActionPreference = "Stop"

if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
    return  # already in a Developer PowerShell
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    $vswhere = Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe"
}
if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found. Install the Visual Studio Build Tools with the C++ workload."
}

$vs = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
if (-not $vs) {
    throw "No Visual Studio installation with the C++ tools was found."
}

$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
    throw "Found Visual Studio at $vs but no vcvars64.bat - the C++ workload is not installed."
}

Write-Host "using the MSVC toolchain at $vs"
# vcvars64.bat sets a few dozen variables; run it and copy the result across.
cmd /c "`"$vcvars`" && set" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") {
        Set-Item -Path "env:$($matches[1])" -Value $matches[2]
    }
}

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe still not on PATH after running vcvars64.bat."
}
