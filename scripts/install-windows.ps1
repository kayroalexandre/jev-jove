# Installs and configures TypeSafe Jev on OpenRouter (jev-openrouter) for Antigravity Desktop/IDE/CLI on Windows.
# Supports both local execution (.\scripts\install-windows.ps1) and one-line web execution:
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/kayroalexandre/jev-jove/main/scripts/install-windows.ps1 | iex"
[CmdletBinding()]
param(
  [string]$ApiKey = $env:OPENROUTER_API_KEY,
  [switch]$WriteGlobalMcp,
  [switch]$SkipMcpPrompt,
  [string]$Branch = "main",
  [string]$TargetHome = $env:USERPROFILE
)

$ErrorActionPreference = "Stop"

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

Write-Host ""
Write-Host "=== TypeSafe Jev on OpenRouter (Antigravity Windows Setup) ===" -ForegroundColor Cyan

# 1. Verify Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "[ERRO] Node.js (>= 20) nao encontrado no PATH." -ForegroundColor Red
  Write-Host "Instale em https://nodejs.org/ ou rode: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
  throw "Node.js >= 20 is required."
}
$nodeVerRaw = (& node -v).Trim()
$nodeMajor = 0
if ($nodeVerRaw -match '^v?(\d+)') {
  $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -lt 20) {
  Write-Host "[ERRO] Node.js encontrado ($nodeVerRaw), mas este servidor MCP requer Node.js >= 20." -ForegroundColor Red
  Write-Host "Atualize em https://nodejs.org/ ou rode: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
  throw "Node.js >= 20 is required."
}
Write-Host "[OK] Node.js $nodeVerRaw detectado." -ForegroundColor Green

# 2. Resolve Windows ~/.gemini/config paths
if ([string]::IsNullOrWhiteSpace($TargetHome)) {
  $TargetHome = $HOME
}
$GeminiConfigDir = Join-Path $TargetHome ".gemini\config"
$PluginsRoot     = Join-Path $GeminiConfigDir "plugins"
$PluginDest      = Join-Path $PluginsRoot "jev-openrouter"
$DataDir         = Join-Path $GeminiConfigDir "plugin-data\jev-openrouter"
$GlobalMcpPath   = Join-Path $GeminiConfigDir "mcp_config.json"

New-Item -ItemType Directory -Force -Path $PluginsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# 3. Stage plugin runtime files from local repo or GitHub archive (no git or npm required)
$LocalRepoRoot = $null
if ($PSScriptRoot) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if ((Test-Path (Join-Path $candidate "plugin.json")) -and (Test-Path (Join-Path $candidate "dist\mcp-server.mjs"))) {
    $LocalRepoRoot = $candidate
  }
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("jev-openrouter-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

try {
  $sourceDir = $null
  if ($LocalRepoRoot) {
    Write-Host "[OK] Usando arquivos locais do repositorio: $LocalRepoRoot" -ForegroundColor Green
    $sourceDir = $LocalRepoRoot
  } else {
    $zipUrl = "https://github.com/kayroalexandre/jev-jove/archive/refs/heads/$Branch.zip"
    $zipFile = Join-Path $tmpDir "jev-jove.zip"
    Write-Host "Baixando plugin TypeSafe Jev ($Branch) do GitHub..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
    Expand-Archive -Path $zipFile -DestinationPath $tmpDir -Force
    $extracted = Get-ChildItem -Path $tmpDir -Directory | Select-Object -First 1
    if (-not $extracted) {
      throw "Falha ao extrair o pacote do GitHub: $zipUrl"
    }
    $sourceDir = $extracted.FullName
  }

  $distSrc = Join-Path $sourceDir "dist\mcp-server.mjs"
  if (-not (Test-Path $distSrc)) {
    throw "Arquivo dist\mcp-server.mjs nao encontrado em $sourceDir"
  }

  $stagingDest = Join-Path $tmpDir "plugin-stage"
  New-Item -ItemType Directory -Force -Path $stagingDest | Out-Null
  $copyItems = @("plugin.json", "mcp_config.json", "README.md", "LICENSE", "assets", "dist", "rules", "skills", "agents", "scripts")
  foreach ($item in $copyItems) {
    $srcPath = Join-Path $sourceDir $item
    if (Test-Path $srcPath) {
      Copy-Item -Path $srcPath -Destination (Join-Path $stagingDest $item) -Recurse -Force
    }
  }

  if (Test-Path $PluginDest) {
    Remove-Item -Path $PluginDest -Recurse -Force
  }
  Copy-Item -Path $stagingDest -Destination $PluginDest -Recurse -Force
} finally {
  if (Test-Path $tmpDir) {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$InstalledDist = Join-Path $PluginDest "dist\mcp-server.mjs"
& node --check $InstalledDist
if ($LASTEXITCODE -ne 0) {
  throw "Falha na verificacao de sintaxe do servidor MCP instalado em $InstalledDist"
}
Write-Host "[OK] Plugin instalado em: $PluginDest" -ForegroundColor Green
Write-Host "[OK] Dados persistentes em: $DataDir" -ForegroundColor Green

# 4. Handle OPENROUTER_API_KEY & optional global mcp_config.json
$resolvedKey = if ($ApiKey) { $ApiKey.Trim() } else { "" }
if ($resolvedKey.StartsWith('${') -or $resolvedKey -eq "YOUR_API_KEY") {
  $resolvedKey = ""
}

if ([string]::IsNullOrWhiteSpace($resolvedKey) -and (-not $SkipMcpPrompt)) {
  Write-Host ""
  Write-Host "Para ja deixar o MCP conectado no Antigravity Desktop ($GlobalMcpPath)," -ForegroundColor Cyan
  Write-Host "cole sua OpenRouter API Key abaixo (entrada oculta; crie em https://openrouter.ai/settings/keys)." -ForegroundColor Gray
  Write-Host "Ou pressione ENTER em branco para configurar a chave depois pela UI (Customizations > Installed)." -ForegroundColor Gray
  try {
    $secure = Read-Host -Prompt "OPENROUTER_API_KEY (opcional)" -AsSecureString
    if ($secure -and $secure.Length -gt 0) {
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try {
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        if ($plain) {
          $resolvedKey = $plain.Trim()
        }
      } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
    }
  } catch {
    # Non-interactive host or redirected stdin: continue silently without prompting.
  }
}

$shouldWriteGlobalMcp = $WriteGlobalMcp -or (-not [string]::IsNullOrWhiteSpace($resolvedKey))
if ($shouldWriteGlobalMcp) {
  $existing = [PSCustomObject]@{
    mcpServers = [PSCustomObject]@{}
  }
  if (Test-Path $GlobalMcpPath) {
    $rawJson = [System.IO.File]::ReadAllText($GlobalMcpPath).Trim()
    if (-not [string]::IsNullOrWhiteSpace($rawJson)) {
      try {
        $parsed = $rawJson | ConvertFrom-Json
        if ($parsed) {
          $existing = $parsed
        }
      } catch {
        throw "O arquivo existente $GlobalMcpPath contem JSON invalido; abortando para nao sobrescrever suas configuracoes existentes."
      }
    }
  }
  if (-not ($existing.PSObject.Properties.Name -contains "mcpServers") -or ($null -eq $existing.mcpServers)) {
    $existing | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value ([PSCustomObject]@{}) -Force
  }

  $envKeyVal = if ([string]::IsNullOrWhiteSpace($resolvedKey)) { '${OPENROUTER_API_KEY}' } else { $resolvedKey }
  $jevEntry = [PSCustomObject]@{
    command = "node"
    args = [string[]]@($InstalledDist)
    env = [PSCustomObject]@{
      OPENROUTER_API_KEY = $envKeyVal
      PLUGIN_ROOT = $PluginDest
      PLUGIN_DATA = $DataDir
    }
    timeoutSeconds = 180
    tools = [PSCustomObject]@{
      jev_decide = [PSCustomObject]@{
        eager = $true
      }
      jev_run_recipe = [PSCustomObject]@{
        eager = $true
      }
    }
  }

  $existing.mcpServers | Add-Member -MemberType NoteProperty -Name "jev-openrouter_jev" -Value $jevEntry -Force
  $serialized = ($existing | ConvertTo-Json -Depth 10) + "`n"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($GlobalMcpPath, $serialized, $utf8NoBom)

  Write-Host "[OK] MCP global atualizado em: $GlobalMcpPath" -ForegroundColor Green
} else {
  Write-Host "[INFO] mcp_config.json global nao modificado (nenhuma API key informada)." -ForegroundColor Yellow
}

$agyCmd = Get-Command agy -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Proximos passos no Antigravity Desktop (Windows):" -ForegroundColor Cyan
Write-Host "  1. Reinicie ou recarregue o Antigravity Desktop App / IDE."
if ($shouldWriteGlobalMcp -and (-not [string]::IsNullOrWhiteSpace($resolvedKey))) {
  Write-Host "  2. Abra Customizations > Installed: verifique o plugin 'TypeSafe Jev on OpenRouter' e o servidor MCP 'jev-openrouter_jev'."
} else {
  Write-Host "  2. Abra Customizations > Installed > TypeSafe Jev on OpenRouter, ative o plugin e cole sua OPENROUTER_API_KEY."
}
if ($agyCmd) {
  Write-Host "  3. (Opcional via CLI) Rode: agy plugin list"
}
Write-Host ""
