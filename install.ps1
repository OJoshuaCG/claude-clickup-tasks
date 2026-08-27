<#
.SYNOPSIS
    clickup-flow — bootstrap para Windows (PowerShell 5.1 y PowerShell 7+).

.DESCRIPTION
    Este script hace UNA cosa: encontrar un node usable y pasarle el control al instalador real
    (src\installer.mjs). Toda la lógica interactiva vive ahí, en un solo lugar, así que la
    experiencia es idéntica en PowerShell y en bash y no hay dos versiones que se desincronicen.

    node no es una dependencia extra: Claude Code se distribuye como paquete de npm, así que si
    Claude Code funciona en esta máquina, node está.

.PARAMETER Uninstall
    Quita hooks, skill y comandos. Pregunta antes de borrar la configuración.

.PARAMETER Yes
    No preguntar nada: usa el valor por defecto de cada pregunta.

.PARAMETER Status
    Muestra qué hay instalado y sale.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Yes,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $scriptDir 'src\installer.mjs'

function Write-Err  ([string]$m) { Write-Host "X $m" -ForegroundColor Red }
function Write-Warn ([string]$m) { Write-Host "! $m" -ForegroundColor Yellow }
function Write-Note ([string]$m) { Write-Host "  $m" -ForegroundColor DarkGray }

# --- node -------------------------------------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCmd) {
    # Common install locations that are not always on the PATH of the shell you happen to be in.
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:APPDATA\nvm\node.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            $nodeCmd = [pscustomobject]@{ Source = $candidate }
            break
        }
    }
}

if (-not $nodeCmd) {
    Write-Err 'No encontre node.'
    Write-Host ''
    Write-Note 'Claude Code se instala con npm, asi que si Claude Code funciona en esta'
    Write-Note 'maquina, node esta - probablemente fuera del PATH de esta sesion.'
    Write-Host ''
    Write-Note 'Proba:  Get-Command claude   y usa el node de ese entorno,'
    Write-Note 'o instala node 18+ desde https://nodejs.org'
    exit 1
}

$nodeExe = $nodeCmd.Source

# La version se saca de `node -v` y se parsea EN PowerShell, a proposito.
#
# La version anterior de esto hacia `& $nodeExe -p 'process.versions.node.split(".")[0]'`, y
# fallaba en todas las maquinas: al pasar el argumento a un comando nativo, PowerShell altera las
# comillas dobles internas, node recibe JS invalido, y el catch dejaba $nodeMajor en 0. Resultado:
# "node v22 es demasiado viejo, hace falta 18" y la instalacion abortaba SIEMPRE.
#
# Encontrado corriendo el instalador de verdad en Windows; no lo detecta un chequeo de sintaxis.
$nodeVersion = (& $nodeExe -v) -join ''
$nodeMajor = 0
if ($nodeVersion -match '^v?(\d+)\.') {
    $nodeMajor = [int]$Matches[1]
}

if ($nodeMajor -lt 18) {
    Write-Err "node $nodeVersion es demasiado viejo. Hace falta 18 o superior."
    Write-Note "Si eso no parece una version, reporta este dato: '$nodeVersion'"
    exit 1
}

if (-not (Test-Path $installer)) {
    Write-Err "No encontre el instalador en $installer (el repo esta completo?)"
    exit 1
}

# --- aviso sobre WSL --------------------------------------------------------------------------
# La configuracion de Claude Code en Windows y la de WSL son DOS carpetas distintas. Instalar en
# una no instala en la otra, y descubrirlo despues de configurar seis proyectos es peor que leer
# esta linea ahora.
#
# Solo al instalar: al desinstalar o consultar el estado el aviso no aplica y es ruido.
if (-not $Uninstall -and -not $Status -and (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Warn 'Detecte WSL en esta maquina.'
    Write-Note 'Esto instala en la configuracion de Claude Code de WINDOWS'
    Write-Note "($env:USERPROFILE\.claude). Si tambien usas Claude Code dentro de WSL,"
    Write-Note 'corre ahi ./install.sh por separado.'
    Write-Host ''
}

# --- handoff ----------------------------------------------------------------------------------
$argsList = @()
if ($Uninstall) { $argsList += '--uninstall' }
if ($Yes)       { $argsList += '--yes' }
if ($Status)    { $argsList += '--status' }

& $nodeExe $installer @argsList
exit $LASTEXITCODE
