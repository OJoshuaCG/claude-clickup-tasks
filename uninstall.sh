#!/usr/bin/env bash
# Atajo de `install.sh --uninstall`. Quita hooks, skill y comandos; pregunta antes de borrar
# la configuración, porque ahí viven los proyectos registrados y los mapeos del equipo.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/install.sh" --uninstall "$@"
