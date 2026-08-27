---
description: Configura (o reconfigura) este proyecto para que genere tareas en ClickUp — elige espacio, lista y modo de trabajo, o lo excluye del flujo
---

Argumento recibido: `$ARGUMENTS`

Configurás **este proyecto** dentro del flujo de tareas de ClickUp. Es una vez y queda: la
respuesta se guarda en la configuración global y ninguna sesión futura vuelve a preguntar.

Si el argumento es `excluir`, salteá directo al **Paso 4**.

---

## Paso 0 — Mirá qué hay ya configurado

```bash
{{CLI}} status
```

Tres situaciones, y no se tratan igual:

- **Ya configurado y no excluido** → mostrale al usuario la configuración actual y **preguntale qué
  quiere cambiar** antes de tocar nada. Reconfigurar a ciegas un proyecto que ya funciona es cómo
  se terminan creando tareas en la lista equivocada.
- **Excluido** → decíselo, con el motivo registrado, y preguntale si quiere **volver a activarlo**.
  Solo seguí si dice que sí.
- **Sin configurar** → seguí al Paso 1.

## Paso 0.5 — Resolvé la identidad si falta

Si `status` dice `identidad SIN RESOLVER`, resolvela **ahora**, antes de configurar el proyecto:
sin ella el protocolo no puede asignar y todo el punto de la herramienta se cae.

```
ToolSearch(query: "select:clickup_get_workspace_members,clickup_find_member_by_name")
```

1. Buscá el miembro con el dato que dejó el instalador (`{{CLI}} identity show` lo muestra en
   `dato del install`), o pedile al usuario su email o usuario de ClickUp.
2. **Mostrale los candidatos y esperá que confirme uno.** Si hay más de uno plausible, mostrá
   todos: un match por parecido de apellido **no es evidencia**. Los workspaces grandes tienen
   nombres repetidos y gente con dos cuentas.
3. Con la confirmación:

```bash
{{CLI}} identity set --id <id numérico> --email <email de ClickUp> --name "<nombre>" --confirmed
```

**Nunca uses `"me"`** como reemplazo, ni guardes un id que el usuario no confirmó.

---

## Paso 1 — Preguntá si este proyecto va a ClickUp

Antes de listar nada, la pregunta de entrada:

> **¿Querés que el trabajo de este proyecto quede registrado como tareas en ClickUp?**

Si dice **no** → Paso 4 (excluir). No insistas y no lo dejes sin registrar: un "no" sin registrar
significa que la próxima sesión vuelve a preguntar, y eso es exactamente la molestia que hay que
eliminar.

---

## Paso 2 — Elegí espacio y lista

```
ToolSearch(query: "select:clickup_get_workspace_hierarchy,clickup_get_list,clickup_get_folder")
```

```
clickup_get_workspace_hierarchy
```

Presentale la jerarquía **de forma legible y numerada** — espacios, y dentro de cada uno las
carpetas y listas — y que elija **la lista donde se crean las tareas de este proyecto**.

Guías para presentarla bien:

- Si el nombre del proyecto o del repo coincide con un espacio o lista, **señalalo como candidato**
  pero **no lo elijas solo**.
- Si hay muchísimos espacios, mostrá primero los que tienen coincidencia y ofrecé ver el resto.
- La lista es **obligatoria**. Un espacio sin lista no alcanza: las tareas se crean en listas.

Anotá el `workspace_id`, `space_id` + nombre, `folder_id` + nombre si la lista está en una carpeta,
y `list_id` + nombre.

### Y capturá los estados REALES de la lista

**Este paso no es opcional y es el que más silenciosamente rompe todo si se saltea.** El protocolo
escribe `status: "in progress"`, `status: "complete"`, etc. Si el espacio llama a sus estados de
otra forma —`En progreso`, `Done`, `Blocked`— **cada `clickup_update_task` va a fallar**, y el
síntoma se ve como "el protocolo no hizo nada".

```
clickup_get_list  list_id:"<la lista elegida>"
```

Devuelve `statuses[]` con el `status` (el nombre exacto) y su `type`:

| `type` | Qué significa |
| --- | --- |
| `open` | La tarea está abierta. Suele ser el "libre" |
| `custom` | Estado intermedio |
| `done` | Cierra la tarea en la UI, **pero ClickUp NO le estampa `date_closed`** |
| `closed` | Cierra la tarea **y sí** recibe `date_closed` |

Mapeá los cinco roles del protocolo contra esos nombres. Si hay uno que coincide literalmente
(`to do`, `in progress`, `on hold`, `update required`, `complete`), usalo sin preguntar. Si no
coincide, **mostrale la lista al usuario y que él elija cuál cumple cada rol**:

| Rol | Qué tiene que ser |
| --- | --- |
| `todo` | Libre, nadie la tomó |
| `in_progress` | Lo que **reserva** la tarea |
| `on_hold` | Detenida / trabada / a medias |
| `handoff` | Solo si hay handoff: "un lado terminó, falta el otro" |
| `done` | Cerrada del todo. **Preferí uno de `type: closed`** sobre uno de `type: done`, porque el de tipo `closed` es el único que recibe `date_closed` |

Los estados que sobren **no se mapean**: quedan como "sin significado declarado en este flujo", y
el protocolo va a decir que se pregunte antes de asumir. No les inventes un significado.

---

## Paso 3 — Elegí el modo de trabajo

Esta es la decisión que cambia cómo se ve el tablero, así que explicale las dos opciones con lo que
implican de verdad:

> **¿Cómo genera tareas este proyecto?**
>
> **1. Varias tareas normales** (`tasks`)
>    Cada trabajo es una tarea suelta en la raíz de la lista. Las subtareas son la excepción.
>    Conviene cuando el proyecto es de larga vida, con trabajo variado y un tablero compartido con
>    más gente.
>
> **2. Una tarea principal con subtareas** (`umbrella`)
>    Hay una tarea paraguas y **cada trabajo es una subtarea suya**. Conviene cuando el proyecto es
>    una iniciativa acotada y querés verla como una sola unidad en el tablero.
>    **Necesita el id de la tarea paraguas, y tiene que existir ya en ClickUp.**

Si elige `umbrella`, pedile el id de la tarea paraguas y **verificalo** antes de guardar:

```
clickup_get_task  task_id:"<id>"
```

Si el id no existe, o está en otra lista que la elegida, **decíselo y no lo guardes**: un paraguas
mal apuntado hace que todas las subtareas caigan en otro lado.

### Paso 3.5 — El ROL del proyecto en la cadena de entrega

**Esta pregunta decide la dirección de las entregas, y saltearla produce tareas que esperan a
nadie.** Preguntá siempre:

> **¿Qué hace este proyecto?**
>
> **1. `backend`** — entrega trabajo que otro proyecto consume (API, servicio, motor).
> **2. `frontend`** — consume lo que el backend deja listo (SPA, app, interfaz).
> **3. `fullstack`** — hace las dos puntas. **El caso más simple, y el default.**

Y si eligió `backend` o `frontend`, la segunda mitad de la pregunta:

> **¿Hay OTRO proyecto que sea su contraparte, y está registrado con esta herramienta?**

Con eso el protocolo se deriva solo. Lo que cambia según la respuesta:

| Rol | Contraparte | Al cerrar | Bandeja de entrada |
| --- | --- | --- | --- |
| `fullstack` | — | siempre cierra | sus propias tareas |
| `backend` | sí | puede dejar en el estado de handoff si toca el contrato | el backlog + pedidos en `on hold` |
| `backend` | **no** | **siempre cierra** | el backlog |
| `frontend` | sí o no | siempre cierra: es el final de la cadena | **el estado de handoff**, no `to do` |

**La fila que importa es la tercera.** Un `backend` sin contraparte registrada que parkea una tarea
en el estado de handoff la deja esperando a **nadie**: no hay quien mire ese filtro, y la tarea
parece entregada. Por eso, sin contraparte, ese estado no se usa.

**Un `frontend` puede pedirle trabajo al backend exista o no su repositorio**, dejando una tarea en
`on hold` con el pedido escrito. El pedido es a una persona, no a un repositorio: una tarea con el
pedido adentro la encuentra cualquiera, no hace falta que nadie vigile un filtro.

Si la contraparte todavía no está registrada, **anotala igual**: el comando avisa que falta y
funciona cuando la registres.

---

Después, una pregunta más — con default, para que se pueda contestar con Enter:

- **¿Los títulos llevan un prefijo de ID** tipo `T-260827-atorres-slug`, o son **descriptivos
  libres**? El prefijo hace el anti-duplicados más fuerte (se compara por id, no por texto), pero
  **solo tiene sentido si el equipo ya lo usa** — meter un esquema nuevo entre las tareas de los
  demás es cambiarles la convención sin avisarles. Default: **descriptivos**.

---

## Paso 4 — Guardá la respuesta

**Si va a usar ClickUp:**

```bash
{{CLI}} project set \
  --mode tasks|umbrella \
  --name "<nombre del proyecto>" \
  --workspace-id <id> \
  --space-id <id> --space-name "<nombre>" \
  [--folder-id <id> --folder-name "<nombre>"] \
  --list-id <id> --list-name "<nombre>" \
  [--umbrella-task-id <id>] \
  --role backend|frontend|fullstack \
  [--counterpart <ruta del proyecto contraparte>] \
  [--naming prefixed] \
  --status-todo "<nombre real>" \
  --status-in-progress "<nombre real>" \
  --status-on-hold "<nombre real>" \
  [--status-handoff "<nombre real>"] \
  --status-done "<nombre real>" \
  --available-statuses "<todos|los|estados|de|la|lista>"
```

`--available-statuses` valida los otros cinco: si mapeaste un estado que no existe en la lista, el
comando **falla ahí** en vez de dejarte descubrirlo en el primer update que no anda.

**Overrides por proyecto** (opcionales). Solo pasalos si este proyecto necesita algo distinto del
default global — un flag omitido sigue heredando el global, que es lo que querés casi siempre:

```
--end-date-field description|due_date|custom_field
--search-window-days <N>
--use-dates true|false
--use-priorities true|false
--auto-assign true|false
```

El que más importa es `--end-date-field`. **Si el equipo ya usa `due_date` como fecha de fin en
ese tablero, pasalo explícitamente**; y si lo usa como **fecha límite**, no lo pases — escribir ahí
borra el vencimiento que puso otra persona, en silencio. Ante la duda, preguntale al usuario cómo
usa su equipo ese campo antes de decidir.

**Si NO va a usar ClickUp:**

```bash
{{CLI}} project exclude --reason "<lo que dijo el usuario>"
```

El motivo importa: en seis meses, "excluido" sin motivo es indistinguible de un olvido.

---

## Paso 5 — Verificá y mostrale el resultado

```bash
{{CLI}} context
```

Leelo vos y confirmale al usuario, en dos o tres líneas: dónde se van a crear las tareas, con qué
modo, a quién se asignan, y que el candado de escritura ya está activo en esta carpeta.

**Si `context` marca algo como faltante, decilo** en vez de dejarlo pasar.

---

## Paso 6 — Opcional: dejá una nota en el `CLAUDE.md` del proyecto

Preguntale al usuario si quiere una nota en el `CLAUDE.md` del proyecto. **No es necesaria** —el
protocolo funciona por hooks globales, sin tocar el repo— pero sirve para que cualquier persona que
abra el repo sepa que hay un flujo de tareas.

**Si dice que sí:** insertá **solo** este bloque, tal cual, sin reescribir ni reordenar nada de lo
que ya está en el archivo. Si el archivo no existe, creálo con el bloque. Si el bloque ya está
(buscá los marcadores), **actualizá lo que hay entre marcadores** y no agregues un segundo.

```markdown
<!-- clickup-flow:start -->
## Tareas en ClickUp

El trabajo de este proyecto se registra como tareas en ClickUp. Antes de implementar, arreglar o
refactorizar algo, corré `/tarea <descripción>` — valida contra el tablero que nadie más lo esté
haciendo, y reclama la tarea antes de la primera línea de código.

Un hook cancela las escrituras si no hay tarea reclamada ni exención declarada. Si te frena, o
reclamás la tarea o declarás la exención con su motivo: no lo rodees.

Responder preguntas, leer código o investigar **no** requiere tarea.
<!-- clickup-flow:end -->
```

**Nunca borres ni reescribas contenido existente del `CLAUDE.md`.** Se agrega al final, o se
actualiza entre marcadores. Nada más.
