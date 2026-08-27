---
description: Decide si el trabajo amerita tarea, la valida contra ClickUp para que nadie duplique trabajo, la reclama o la cierra siguiendo el protocolo del proyecto
---

Argumento recibido: `$ARGUMENTS`

**Paso obligatorio antes de cualquier modo** — traé el protocolo resuelto de ESTE proyecto:

```bash
{{CLI}} context
```

Si dice que el proyecto **no está configurado**, ofrecele `/clickup-setup` y pará acá. Si dice que
está **excluido**, decíselo y pará: no se gestionan tareas en esta carpeta.

Después cargá la skill `clickup-task-flow` y ejecutá el modo que corresponda.

## Modos

| Argumento | Modo | Qué hacés |
| --- | --- | --- |
| `<descripción del trabajo>` | **RECLAMAR** | Decidir si amerita tarea, buscarla, y tomarla o crearla |
| `<id de ClickUp>` | **RECLAMAR** | Ir directo a esa tarea y tomarla |
| `fin` / `fin <id>` / `fin <id> <notas>` | **CERRAR** | Cerrar la tarea reclamada |
| `pausa <motivo>` | **PAUSAR** | Dejarla en `on hold` diciendo dónde quedó |
| `bloqueo <id> <motivo>` | **BLOQUEAR CON PEDIDO** | `on hold` + pedido concreto al otro rol, con notificación |
| `nueva <descripción>` | **RECLAMAR** | Igual que reclamar: trabajo nacido en este repo |
| `handoff` | **PENDIENTES DEL OTRO ROL** | Listar lo que espera trabajo del otro lado |
| `bloqueos` | **DEVUELTAS / TRABADAS** | Listar `on hold` con un pedido concreto adentro |
| `estado` (o vacío) | **CONSULTAR** | Qué hay en curso, quién lo tiene y qué está libre |

---

## Modo RECLAMAR

**0. Si ClickUp no responde, PARÁ.** Conector caído, `Needs authentication`, timeout o error =
**no se pudo validar**. Decíselo al usuario y no escribas código. **Nunca** interpretes un error
del conector como "está libre".

**1. ¿Amerita tarea?** Aplicá el Paso 0 de la skill: *¿alguien más del equipo necesitaría saber
que esto pasó?* Responder preguntas, leer código o investigar **sin** terminar en un cambio **no**
amerita — decilo, declará la exención con `{{CLI}} exempt --reason "…"` y seguí con el trabajo sin
tocar el tablero. Ante la duda, preguntá.

**2. Identidad.** Las dos que imprime `context`: el **email de git** para el texto de los
comentarios, y el **id numérico** para asignar. Si el id no está resuelto, resolvelo primero
(`clickup_get_workspace_members`), **confirmalo con el usuario**, y guardalo con
`{{CLI}} identity set`. **Nunca `"me"`.**

**3. Fecha de solicitud.** Si este proyecto usa fechas: determiná **cuándo el usuario pidió este
trabajo**, que no es hoy si viene de una conversación anterior. Va en la descripción
(`**Solicitado:**`), porque `date_created` lo estampa el servidor y no se puede definir por API.
Si no la podés determinar, **preguntá** — no la inventes ni uses la de hoy por defecto.

**4. Buscá antes de crear.** Las tres pasadas exactas están en el output de `context`. Compará por
**significado**, no por título literal, y probá varios términos.

**5. Según lo que encuentres**, seguí la tabla que imprimió `context`. Los dos casos que más se
equivocan:

- **`in progress`** → leé el último `INICIO`: quién, desde cuándo, qué rol. Si venís a hacer lo
  mismo → **PARÁ e informá quién la tiene**. No sigas sin confirmación del usuario.
- **`complete`** → **PARÁ Y AVISÁ: este trabajo ya se hizo.** Mostrá el resumen del `FIN`, quién lo
  cerró y cuándo, y **esperá confirmación antes de tocar una línea.** Recién con su OK aplicás la
  prueba del objetivo declarado: fix reciente → reabrir; trabajo distinto o cierre viejo → tarea
  nueva vinculada.

**6. Reclamala** con la llamada que imprimió `context` (estado + fecha de inicio + unión de
asignados, en **una sola** llamada), publicá el comentario `INICIO`, **re-verificá que ganaste la
carrera**, y registrá el claim:

```bash
{{CLI}} claim --task-id <id> --title "<título>"
```

**7. Recién ahora** empezá a trabajar. Confirmale al usuario que quedó reservada, con el id y la URL.

---

## Modo CERRAR

1. Traé la tarea y verificá que esté en `in progress`. Si está en otro estado, **decilo** en vez de
   forzar: cerrar algo que nadie reclamó suele significar que se salteó el paso de reclamar.
2. Si el proyecto tiene handoff, **la pregunta obligatoria**: ¿esto necesita trabajo del otro rol?
   No alcanza con que *vos* no lo hayas tocado — hay que poder afirmar que **nada de lo que el otro
   lado ya consume cambió** (rutas, forma de la respuesta, códigos de error, campos obligatorios).
   **Si dudás, va al handoff.**
3. Cerrá con el estado y la fecha de fin **en el campo que dice `context`** — no lo adivines, en
   algunos proyectos escribir en `due_date` borra el vencimiento que puso otra persona.
4. Comentario `FIN`, con `Sin verificar:` completo y honesto.
5. Si te sumaste a una tarea que trabajó otro, **agregate a los asignados por unión** — nunca
   reemplaces la lista.
6. Soltá el claim **diciendo qué tarea cerrás**:

```bash
{{CLI}} release --task-id <id>
```

El id no es decorativo: si otra sesión de Claude reclamó algo en este mismo repo, soltar sin
decir cuál la dejaría bloqueada a mitad del trabajo. Con el id, el comando se niega y te avisa.

**Nunca pongas `reviewed`** salvo que `context` lo declare como estado usado en este proyecto.

---

## Modo PAUSAR

`status: "on hold"` + comentario que diga **dónde quedó** y qué falta. **Ninguna fecha de fin**: la
tarea no terminó. Los asignados **no se tocan** — quien la dejó a medias es quien sabe dónde quedó.

Después, `{{CLI}} release --task-id <id>`.

Nunca se deja una tarea colgada en `in progress`: bloquea a todos los demás por nada.

---

## Modo BLOQUEAR CON PEDIDO (`bloqueo <id> <motivo>`)

Distinto de `pausa`, y la diferencia importa: `pausa` dice *"quedó a medias por mi lado"*. Esto dice
*"no puedo seguir porque falta algo del otro lado, y acá está el pedido concreto"*. Hay alguien del
otro lado que tiene que enterarse.

Sirve en las dos direcciones:

- **El otro rol entregó y no cumple lo prometido** (el endpoint devuelve otra forma, falta un campo,
  el código de error no es el documentado, la ruta no existe).
- **Necesitás algo del otro rol para poder seguir** (un endpoint, un campo, un comportamiento).

**1. Verificá el bloqueo antes de declararlo.** Reproducí lo que falla. Hay tres salidas honestas y
las dos últimas se saltean seguido:

- **El bloqueo es real** → seguí al paso 2.
- **El otro lado SÍ cumple y leíste mal el contrato** → **no pidas que cambien nada.** Dejá un
  comentario con la evidencia (el request correcto y su respuesta) y seguí con tu trabajo. Pedir un
  cambio para acomodar una lectura equivocada es cómo se rompe lo que ya funcionaba en producción.
- **El contrato estaba mal escrito pero el código está bien** → se arregla **el documento**, no el
  código.

**2. Estado y comentario, con notificación:**

```
clickup_update_task   task_id:"<id>"  status:"<el estado 'detenida' que imprime context>"
clickup_create_comment  entity_id:"<id>"  notify_all:true  comment_text:<el bloque de abajo>
```

**`notify_all: true` no es opcional acá.** Una tarea detenida en silencio es una tarea que nadie
va a retomar.

**3. NO la devuelvas al estado de handoff.** Ese estado significa "falta el otro rol": devolverla ahí
la deja en el filtro de quien ya terminó, y quien tiene que arreglarlo no se entera nunca. Por eso va
al estado de *detenida*.

**4. Ninguna fecha de fin, y no saques a nadie de los asignados.** La tarea no terminó, y quien la
trabajó es quien sabe dónde quedó.

```
**Ejecutor:** <email de git>
**Rol:** <tu rol>
**Acción:** BLOQUEADO — <nombre de la tarea>
**Qué esperaba:** <lo prometido, citando el comentario de handoff y su fecha>
**Qué encontré:** <la respuesta real, código de estado, forma del payload>
**Cómo lo reproduzco:** <request concreto — SIN credenciales ni datos reales>
**Qué necesito:** <concreto. No "arreglarlo">
**Dónde quedé:** <qué parte de tu trabajo ya está hecha y sigue siendo válida>
**Bloquea a:** <la tarea que quedó esperando, con su id — o "nada, seguí igual">
```

Los dos campos que más se omiten y más cuestan:

- **`Dónde quedé`** le dice al otro lado **qué no puede romper**. Si hay media implementación hecha,
  cualquier cambio que vaya más allá de lo necesario para desbloquear la tira a la basura.
- **`Qué necesito`** tiene que ser concreto. Un pedido mal escrito produce trabajo que no sirve, que
  es peor que no haberlo hecho.

Después: `{{CLI}} release --task-id <id>`. Y decile al usuario que la tarea quedó detenida esperando al otro rol.

---

## Modo PENDIENTES DEL OTRO ROL (`handoff`)

Solo aplica si `context` dice que este proyecto usa handoff.

```
clickup_filter_tasks  list_ids:["<la lista de context>"]  statuses:["update required"]  subtasks:true
```

Para cada una, leé el comentario de handoff y presentá: id y título, **breaking changes primero**
(rompen lo que ya está en producción), endpoints nuevos o cambiados, la referencia al contrato con
su commit, y qué tiene que hacer el otro lado.

Marcá aparte:
- Las que están en `update required` **sin** comentario de handoff: es un cierre mal hecho, y hay
  que **pedirle el contexto a quien la dejó ahí**, no adivinarlo leyendo el código.
- Los handoff **invalidados**: una tarea que volvió a `in progress` desaparece de este filtro, pero
  el otro lado necesita saber que le va a volver.

---

## Modo BLOQUEOS

Las tareas en `on hold` cuyo último comentario es un pedido concreto. **No aparecen en ningún
filtro que se mire por costumbre** —no están en `to do`, ni `in progress`, ni `update required`— y
del otro lado suele haber una implementación parada esperando.

```
clickup_filter_tasks  list_ids:["<la lista de context>"]  statuses:["on hold"]  subtasks:true
```

Leé el último comentario de cada una y presentá qué se necesita, para qué, y qué quedó esperando.
Ordenalas por antigüedad del pedido. Si el pedido está **incompleto** —no dice qué necesita o para
qué—, no lo adivines: pedile el contexto a quien lo dejó. Un pedido mal escrito produce trabajo que
no sirve, que es peor que no haberlo hecho.

---

## Modo CONSULTAR

Corré las pasadas de búsqueda de `context` (lo abierto entero, lo cerrado de la ventana), paginá
hasta el final y presentá agrupado por estado:

- Qué está `in progress` y **quién lo tiene** (del comentario `INICIO`).
- Qué está esperando al otro rol.
- Qué está `on hold` y por qué.
- **Duplicados sospechosos**: dos tareas con el mismo alcance, con sus `date_created`.
- Cualquiera en `reviewed`, como anomalía.

Y tres cosas que hay que buscar explícitamente porque nadie las mira:

1. **`in progress` con `INICIO` de hace más de 3 días** → candidatas a tarea abandonada: alguien la
   reclamó y no la cerró ni la pausó, así que está bloqueando a los demás por nada. **No las
   liberes por tu cuenta** — listalas con quién las tiene y desde cuándo, y que decida el usuario.
2. **Dos `INICIO` de emails distintos sin `FIN` entre medio** → es una colisión que ya ocurrió y
   que nadie detectó. Reportala con los dos emails y sus timestamps.
3. **Tareas sin asignado** → si el tablero se filtra por asignado, son invisibles.

Es un tablero compartido y puede ser grande: agrupá y no vuelques cien tareas.

---

## Reglas que no se negocian en ningún modo

- **`context` primero.** Las coordenadas y los campos salen de ahí, no de tu memoria ni de otro repo.
- **Buscar antes de crear**, con varios términos y `include_closed` encendido.
- **`in progress` va ANTES de escribir código**, no después.
- **La identidad de los comentarios es el EMAIL**, dentro del texto. Para asignar, el **id numérico**.
  **`"me"` está prohibido**: resuelve al dueño del token y le asigna todo a la misma persona.
- **`assignees` se lee, se une y se escribe.** Mandar solo tu id borra a los demás en silencio.
- **Re-verificar después de reclamar y después de crear.** La colisión no se previene, se detecta.
- **Si ClickUp falla, se para.** Un error del conector nunca significa "está libre".
- **Nada de credenciales, `.env` ni datos de clientes** en comentarios ni adjuntos.
- **El candado es real**: sin claim ni exención vigente, la escritura se cancela. Si te frena, no
  busques cómo rodearlo — o reclamás la tarea, o declarás la exención con su motivo.
