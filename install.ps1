# lu-minal installer for Windows (Windows PowerShell 5.1 and PowerShell 7+): downloads the
# standalone lu-minal.exe for this PC from the GitHub releases, checks it against the release's
# SHA256SUMS, installs it to %LOCALAPPDATA%\Programs\lu-minal, adds that folder to your user PATH
# and offers a lu-minal profile for Windows Terminal.
#
#   irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 | iex
#
# Settings (environment variables):
#   LU_MINAL_VERSION           a release to install ("0.2.0" or "v0.2.0"); default: the latest
#   LU_MINAL_INSTALL_DIR       where lu-minal.exe goes; default: %LOCALAPPDATA%\Programs\lu-minal
#   LU_MINAL_ARCH              "x64" or "arm64" instead of detecting it
#   LU_MINAL_BASE_URL          download from this URL (or local folder) instead of GitHub
#   LU_MINAL_NO_VERIFY=1       skip the checksum check (not recommended)
#   LU_MINAL_NO_PATH=1         don't change the user PATH
#   LU_MINAL_WINDOWS_TERMINAL  1 = add the Windows Terminal profile without asking, 0 = don't

# Everything runs inside a function: with "irm | iex" the script shares the caller's session, so it
# must never call exit (that would close the user's window) and must not leave variables behind.
function Install-LuMinal {
  [CmdletBinding()]
  param()

  $ErrorActionPreference = 'Stop'
  $repo = 'Luna-OS/lu-minal'

  function Write-Step([string]$Text) { Write-Host '* ' -ForegroundColor Magenta -NoNewline; Write-Host $Text }
  function Write-Ok([string]$Text) { Write-Host '* ' -ForegroundColor Green -NoNewline; Write-Host $Text }
  function Write-Note([string]$Text) { Write-Host "! $Text" -ForegroundColor Yellow }

  # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  # ---- what to download ----------------------------------------------------------------------

  $arch = $env:LU_MINAL_ARCH
  if (-not $arch) {
    # The registry holds the machine's own architecture even when this PowerShell runs emulated
    # (an x64 PowerShell on Windows on Arm reports AMD64 in $env:PROCESSOR_ARCHITECTURE).
    try {
      $arch = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
    } catch { }
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  }
  switch -Regex ($arch) {
    '^(AMD64|x64|x86_64)$' { $arch = 'x64'; break }
    '^(ARM64|arm64|aarch64)$' { $arch = 'arm64'; break }
    default { throw "There is no lu-minal binary for the $arch CPU. Build it from source instead (Node 22+): https://github.com/Luna-OS/lu-minal#from-source" }
  }
  $asset = "lu-minal-windows-$arch.exe"

  if ($env:LU_MINAL_BASE_URL) {
    $base = $env:LU_MINAL_BASE_URL.TrimEnd('/', '\')
  } elseif ($env:LU_MINAL_VERSION -and $env:LU_MINAL_VERSION -ne 'latest') {
    $tag = $env:LU_MINAL_VERSION
    if (-not $tag.StartsWith('v')) { $tag = "v$tag" }
    $base = "https://github.com/$repo/releases/download/$tag"
  } else {
    $base = "https://github.com/$repo/releases/latest/download"
  }

  $dir = $env:LU_MINAL_INSTALL_DIR
  if (-not $dir) {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = Join-Path $HOME 'AppData\Local' }
    $dir = Join-Path $local 'Programs\lu-minal'
  }
  $exe = Join-Path $dir 'lu-minal.exe'

  # Downloads a release file, or copies it when $base is a local folder (mirrors, tests).
  function Get-ReleaseFile([string]$Name, [string]$Destination) {
    if ($base -match '^(https?|file)://') {
      $old = $ProgressPreference
      # The progress bar slows Invoke-WebRequest down a lot in Windows PowerShell 5.1.
      $ProgressPreference = 'SilentlyContinue'
      try {
        Invoke-WebRequest -Uri "$base/$Name" -OutFile $Destination -UseBasicParsing
      } finally {
        $ProgressPreference = $old
      }
    } else {
      Copy-Item -LiteralPath (Join-Path $base $Name) -Destination $Destination -Force
    }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("lu-minal-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Write-Step "Downloading $asset from $base"
    $download = Join-Path $tmp $asset
    try {
      Get-ReleaseFile $asset $download
    } catch {
      throw "Download failed: $base/$asset ($($_.Exception.Message))"
    }
    if (-not (Test-Path -LiteralPath $download) -or (Get-Item -LiteralPath $download).Length -eq 0) {
      throw "The download is empty: $base/$asset"
    }

    # ---- checking it -------------------------------------------------------------------------

    if ($env:LU_MINAL_NO_VERIFY -eq '1') {
      Write-Note 'Skipping the checksum check (LU_MINAL_NO_VERIFY=1).'
    } else {
      $sums = Join-Path $tmp 'SHA256SUMS'
      try {
        Get-ReleaseFile 'SHA256SUMS' $sums
      } catch {
        throw "Could not download SHA256SUMS from $base to check the download. (Set LU_MINAL_NO_VERIFY=1 to install without checking - not recommended.)"
      }
      $want = $null
      foreach ($line in (Get-Content -LiteralPath $sums)) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $asset) {
          $want = $Matches[1].ToLowerInvariant()
          break
        }
      }
      if (-not $want) { throw "SHA256SUMS has no entry for $asset." }
      $got = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($got -ne $want) {
        throw "Checksum mismatch for ${asset}: expected $want, got $got. The download is broken or was tampered with; nothing was installed."
      }
      Write-Ok "Checksum OK ($want)"
    }

    # ---- installing it -----------------------------------------------------------------------

    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if (Test-Path -LiteralPath $exe) {
      # A running lu-minal.exe cannot be overwritten or deleted, but it can be renamed out of the
      # way - to a new name each time, since an older copy may still be running too.
      $previous = Join-Path $dir ('lu-minal.old-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.exe')
      try {
        Move-Item -LiteralPath $exe -Destination $previous -Force
      } catch {
        throw "Cannot replace $exe - close lu-minal and run the installer again."
      }
    }
    Copy-Item -LiteralPath $download -Destination $exe -Force
    # Old copies that are no longer running (the ones that are stay until the next update).
    Get-ChildItem -LiteralPath $dir -Filter 'lu-minal.old*.exe' -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $version = $null
  try { $version = (& $exe --version 2>$null | Select-Object -First 1) } catch { }
  if ($version) {
    Write-Ok "Installed lu-minal $version to $exe"
  } else {
    Write-Ok "Installed lu-minal to $exe"
    Write-Note "It did not start ($exe --version failed)."
  }

  # ---- PATH ----------------------------------------------------------------------------------

  if ($env:LU_MINAL_NO_PATH -ne '1') {
    # Read and write the raw registry value: [Environment]::SetEnvironmentVariable would turn
    # entries like %USERPROFILE%\bin into fixed paths.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($raw -split ';' | Where-Object { $_ -ne '' })
      $present = $false
      foreach ($e in $entries) {
        if ([Environment]::ExpandEnvironmentVariables($e).TrimEnd('\') -ieq $dir.TrimEnd('\')) { $present = $true }
      }
      if (-not $present) {
        $key.SetValue('Path', (($entries + $dir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Tell Explorer (and new terminals) that the environment changed.
        [Environment]::SetEnvironmentVariable('LU_MINAL_INSTALLER', '1', 'User')
        [Environment]::SetEnvironmentVariable('LU_MINAL_INSTALLER', $null, 'User')
        Write-Ok "Added $dir to your user PATH (new terminals will have it)."
      }
    } finally {
      $key.Close()
    }
    if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$env:Path;$dir" }
  }

  # ---- Windows Terminal ----------------------------------------------------------------------

  $wtInstalled = [bool](Get-Command 'wt.exe' -ErrorAction SilentlyContinue)
  if (-not $wtInstalled -and $env:LOCALAPPDATA) {
    $wtInstalled = [bool](Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages') -Filter 'Microsoft.WindowsTerminal*' -ErrorAction SilentlyContinue)
  }
  $addProfile = $false
  if ($env:LU_MINAL_WINDOWS_TERMINAL -eq '1') {
    $addProfile = $true
  } elseif ($env:LU_MINAL_WINDOWS_TERMINAL -ne '0' -and $wtInstalled -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    $answer = Read-Host 'Add a lu-minal profile (Moon Dark colours) to Windows Terminal? [Y/n]'
    $addProfile = ($answer -eq '' -or $answer -match '^(y|yes)$')
  }
  if ($addProfile) {
    try {
      & $exe setup windows-terminal
      if ($LASTEXITCODE -eq 0) {
        Write-Ok 'Windows Terminal: open a new tab and pick "lu-minal" (restart Windows Terminal if it is open).'
      } else {
        Write-Note 'Adding the Windows Terminal profile failed; run "lu-minal setup windows-terminal" later.'
      }
    } catch {
      Write-Note 'Adding the Windows Terminal profile failed; run "lu-minal setup windows-terminal" later.'
    }
  } elseif (-not $wtInstalled) {
    Write-Note 'Windows Terminal is recommended (true colour, better keys): https://aka.ms/terminal'
  }

  Write-Host ''
  Write-Host '  Run ' -NoNewline
  Write-Host 'lu-minal' -ForegroundColor Magenta -NoNewline
  Write-Host ' in a project folder to start. Docs: https://github.com/Luna-OS/lu-minal/blob/main/docs/install.md'
}

Install-LuMinal
