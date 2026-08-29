---
description: Muestra y ajusta la configuración global del flujo de tareas de ClickUp — identidad, preferencias, proyectos registrados y diagnóstico
---

Argumento recibido: `$ARGUMENTS`

Administrás la configuración **global** del flujo de tareas (la que comparten todos los proyectos).
Para configurar *un* proyecto, el comando es `/clickup-setup`.

## Sin argumento — mostrá el panorama

```bash
{{CLI}} doctor
{{CLI}} project list
```

Presentalo en dos bloques, corto y legible:

1. **Salud de la instalación**: hooks registrados, identidad resuelta, config legible.
2. **Proyectos**: cuáles están configurados, con qué modo, y cuáles están excluidos.

Si `doctor` reporta problemas, decí **cuál** y **qué lo arregla** — no vuelques el output crudo.

---

## `identidad` — resolver o corregir a quién se asignan las tareas

Este es el ajuste que más importa: si está mal, las tareas se asignan a la persona equivocada, y
ese error **no falla, no avisa** y se descubre semanas después cuando alguien filtra el tablero.

```bash
{{CLI}} identity show
```

Para (re)solverla:

```
ToolSearch(query: "select:clickup_get_workspace_members,clickup_find_member_by_name")
```

1. Pedile al usuario su email o usuario de ClickUp (o usá el `dato del install` si está).
2. Buscá los candidatos y **mostráselos todos**. Si hay más de uno plausible, no elijas: los
   workspaces grandes tienen apellidos repetidos y gente con dos cuentas.
3. Con la confirmación explícita:

```bash
{{CLI}} identity set --id <id numérico> --email <email ClickUp> --name "<nombre>" --confirmed
```

**`"me"` nunca es la respuesta.** Resuelve al dueño del token de la integración, así que en un
equipo le asigna todo a la misma persona — el bug que esta configuración existe para eliminar.

---

## `equipo` — mapear compañeros

Solo hace falta si asignás tareas a **otra** gente. El email de git y el de ClickUp suelen no
coincidir (dominio corporativo en el tablero, gmail en los commits), así que el mapeo es explícito:

```bash
{{CLI}} team list
{{CLI}} team add --git-email <email git> --clickup-id <id> --name "<nombre>" --confirmed
```

Sin `--confirmed` la entrada queda marcada como **deducida**, y con eso **no se asigna sin
preguntar**. `confirmado: false` no es "casi sí": significa que el mapeo lo dedujo un agente y
nadie lo validó.

---

## `preferencias` — los interruptores globales

```bash
{{CLI}} config show
```

| Campo | Qué hace |
| --- | --- |
| `use_dates` | Escribir fecha de solicitud, inicio y fin |
| `use_priorities` | Fijar prioridad al crear |
| `auto_assign` | Asignar automáticamente al usuario configurado |
| `end_date_field` | **Dónde va la fecha de fin** — ver abajo, importa |
| `search_window_days` | Cuántos días hacia atrás se buscan las tareas **cerradas**. `0` = sin límite |
| `track_time` | Usar el cronómetro de ClickUp. **Apagado por default** — ver abajo |
| `block_writes_without_task` | El candado `PreToolUse` |
| `exemption_hours` | Cuánto dura una exención antes de vencer |

```bash
{{CLI}} config set --key defaults.<campo> --value <valor>
```

### `track_time` — por qué viene apagado, y por qué puede quedar bloqueado

Encendido, el cronómetro sigue al claim: arranca al reclamar y para antes de cerrar. Se activa por
proyecto (`project set --track-time true`), no global: en un mismo equipo conviven el repo que se
factura por hora y la herramienta interna donde registrar tiempo es puro ruido.

Pero encenderlo **no alcanza**. Las herramientas de tiempo del MCP no reciben a quién se le carga
la hora: el reloj corre siempre a nombre del **dueño del token OAuth**. Si ese no es el usuario,
sus horas se le cargan a otra persona sin que nada falle. Por eso hace falta verificarlo una vez:

```bash
{{CLI}} timer status                      # ¿en qué estado está?
{{CLI}} timer verify --user-id <id>       # el id que devuelve clickup_resolve_assignees(["me"])
```

Si el id del token no coincide con el id confirmado del usuario, el cronómetro queda desactivado a
propósito y no hay flag para saltearlo.

### `end_date_field` — la decisión con consecuencias

- **`description`** (default) — la fecha va como línea `**Finalizado:** YYYY-MM-DD` en la
  descripción, y ClickUp estampa `date_closed` solo. **No toca `due_date`.**
- **`due_date`** — la fecha de fin se escribe en `due_date`. Elegilo **solo** si el equipo ya usa
  ese campo así. ⚠️ Si el equipo usa `due_date` como **fecha límite**, esto **borra el vencimiento
  que puso otra persona**, en silencio y sin forma de recuperarlo.
- **`custom_field`** — un campo Date llamado `Fecha de fin`. Hay que crearlo a mano en la UI de
  ClickUp: el conector MCP **no puede crear custom fields**, solo leerlos y escribirlos si existen.

Antes de cambiarlo a `due_date`, **preguntale al usuario si el equipo usa `due_date` como fecha
límite**. Si la respuesta es sí o no está seguro, dejalo en `description`.

### `search_window_days` — el intercambio, en las dos direcciones

Lo que está **abierto** se busca siempre completo, sin límite de fecha: eso no se configura y no se
negocia. Lo que se acota es lo **cerrado**.

- **Ventana corta** (7–15) → cada búsqueda es barata, pero una tarea cerrada hace más tiempo no
  aparece y se puede rehacer trabajo viejo.
- **Ventana larga** (90, 365) → se escapa menos, cada reclamo pagina más.
- **`0` = sin límite** → no se pierde nada. El protocolo **quita el filtro de fecha** y colapsa a
  dos pasadas, porque `include_closed: true` sin filtro ya trae todo. **Con un tablero chico es la
  mejor opción**: es barato y estrictamente más seguro.

Se puede definir global o **por proyecto** (`project set --search-window-days`), que es lo correcto
cuando un tablero tiene 20 tareas y otro más de cien.

Si el usuario menciona que *"esto ya se hizo alguna vez"* y no aparece en la búsqueda, la ventana es
la primera sospechosa: ampliála a mano en ese momento en vez de asumir que la tarea no existe.

### `block_writes_without_task` — apagarlo tiene un precio

Es lo único del protocolo que el modelo no puede saltearse. Apagado, todo lo demás vuelve a ser
una instrucción que se puede diluir cuando el contexto se comprime en una sesión larga. Si el
usuario lo quiere apagar, **decile eso una vez** y hacelo — es su decisión.

---

## `proyectos` — ver, olvidar, reactivar

```bash
{{CLI}} project list
{{CLI}} project show            # el del directorio actual
{{CLI}} project forget          # borra la entrada de ESTA carpeta; se vuelve a preguntar
```

Para reactivar un proyecto excluido, o cambiarle el espacio o el modo: `/clickup-setup`.

**`project forget` borra una entrada.** Confirmá con el usuario antes de correrlo, y decile que la
próxima sesión en esa carpeta va a volver a preguntar.
