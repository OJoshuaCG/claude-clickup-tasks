#!/usr/bin/env bash
#
# clickup-flow — bootstrap para Linux, macOS y Git Bash / WSL en Windows.
#
# Este script hace UNA cosa: encontrar un node usable y pasarle el control al instalador real
# (`src/installer.mjs`). Toda la lógica interactiva vive ahí, en un solo lugar, así que la
# experiencia es idéntica en bash y en PowerShell y no hay dos versiones que se desincronicen.
#
# node no es una dependencia extra: Claude Code se distribuye como paquete de npm, así que si
# Claude Code funciona en esta máquina, node está.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/src/installer.mjs"

bold=''; red=''; yellow=''; cyan=''; reset=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    bold=$'\033[1m'; red=$'\033[31m'; yellow=$'\033[33m'; cyan=$'\033[36m'; reset=$'\033[0m'
fi

die() {
    printf '%s\n' "${red}✖ $1${reset}" >&2
    exit 1
}

# --- node ------------------------------------------------------------------------------------
NODE_BIN=""
for candidate in node nodejs; do
    if command -v "$candidate" >/dev/null 2>&1; then
        NODE_BIN="$(command -v "$candidate")"
        break
    fi
done

# nvm installs node outside the PATH of a non-login shell, which is a common way for this to
# fail on a machine where node demonstrably works in the user's terminal.
if [ -z "$NODE_BIN" ] && [ -d "${HOME}/.nvm/versions/node" ]; then
    NODE_BIN="$(find "${HOME}/.nvm/versions/node" -maxdepth 3 -type f -name node 2>/dev/null | sort -V | tail -1 || true)"
fi

if [ -z "$NODE_BIN" ]; then
    printf '%s\n' "${red}✖ No encontré node.${reset}" >&2
    printf '%s\n' "" >&2
    printf '%s\n' "  Claude Code se instala con npm, así que si Claude Code funciona en esta" >&2
    printf '%s\n' "  máquina, node está — probablemente fuera del PATH de este shell." >&2
    printf '%s\n' "" >&2
    printf '%s\n' "  Probá:  ${cyan}command -v claude${reset} y usá el node de ese entorno," >&2
    printf '%s\n' "  o instalá node 18+ desde https://nodejs.org" >&2
    exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
    die "node $("$NODE_BIN" -v) es demasiado viejo. Hace falta 18 o superior."
fi

[ -f "$INSTALLER" ] || die "No encontré el instalador en $INSTALLER (¿el repo está completo?)"

# --- aviso sobre WSL -------------------------------------------------------------------------
# La configuración de Claude Code en WSL y la de Windows son DOS carpetas distintas. Instalar en
# una no instala en la otra, y descubrirlo después de configurar seis proyectos es peor que leer
# esta línea ahora.
if grep -qi microsoft /proc/version 2>/dev/null; then
    printf '%s\n' "${yellow}▲ Estás en WSL.${reset}"
    printf '%s\n' "  Esto instala en la configuración de Claude Code de WSL"
    printf '%s\n' "  (${HOME}/.claude). Si también usás Claude Code en Windows,"
    printf '%s\n' "  corré ahí ${cyan}install.ps1${reset} por separado."
    printf '%s\n' ""
fi

exec "$NODE_BIN" "$INSTALLER" "$@"
