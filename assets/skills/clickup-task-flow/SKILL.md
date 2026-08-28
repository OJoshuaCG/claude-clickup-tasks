---
name: clickup-task-flow
description: Protocolo de gestión de tareas en ClickUp vía MCP, resuelto por proyecto. Decidir si un trabajo amerita tarea, validar que nadie más la esté haciendo antes de empezar, crear o reclamar la tarea, asignarla al usuario correcto, fijar fechas y prioridad, comentar el avance y cerrarla. Usar SIEMPRE antes de empezar cualquier implementación, fix, migración o refactor, y otra vez al terminarlo. También al preguntar qué hay pendiente, en qué estado está algo, o quién está trabajando en qué.
---

# Gestión de tareas en ClickUp

Este protocolo existe para **dos personas no trabajen lo mismo en paralelo**, y para que quede
registro de por qué se tocó cada cosa. En un tablero compartido, un cambio sin rastro no es
desprolijidad: es trabajo que alguien va a rehacer, o un incidente que nadie puede reconstruir
después.

## Paso 1 (siempre, y antes que nada): traé el contexto del proyecto

```bash
{{CLI}} context
```

**No sigas de memoria.** Ese comando imprime, para el directorio en el que estás:

- Las coordenadas reales (workspace, espacio, carpeta, lista, y si hay tarea paraguas).
- El **modo**: varias tareas normales, o una tarea principal con subtareas.
- **A qué id numérico se asignan las tareas** — el dato que más se equivoca.
- Qué campos usa este proyecto (fechas, prioridades) y **dónde va la fecha de fin**.
- Si hay una tarea reclamada ahora mismo, o una exención vigente.

Cada proyecto puede tener reglas distintas y **las de `context` ganan** sobre cualquier convención
de ClickUp que tengas cargada de otro lado. Si el output dice que el proyecto está **excluido**,
no gestionás tareas acá: seguí trabajando normalmente y no le preguntes al usuario si quiere
configurarlo, porque ya respondió que no.

Si dice que el proyecto **no está configurado**, ofrecele `/clickup-setup` y **no inventes
coordenadas**. Crear tareas en el espacio equivocado de un tablero compartido es mucho más difícil
de deshacer que preguntar.

## Las herramientas de ClickUp son deferred

Antes de invocarlas hay que traer su esquema:

```
ToolSearch(query: "select:clickup_filter_tasks,clickup_search,clickup_get_task,clickup_get_task_comments,clickup_create_task,clickup_update_task,clickup_create_comment,clickup_resolve_assignees,clickup_get_workspace_members")
```

## Si ClickUp no responde, se PARA. No se asume que está libre

El conector MCP es **por cuenta de cada persona**, no del repositorio: que funcione en una máquina
no dice nada de las demás.

Si **cualquier** llamada falla —conector desconectado, `Needs authentication`, timeout, error del
servidor— el protocolo **falla cerrado**:

1. **PARÁ.** No escribas código.
2. Decile al usuario, textualmente, que **no se pudo validar contra ClickUp** y que por lo tanto
   **no se sabe si alguien más está haciendo ese trabajo**.
3. Sugerí `claude mcp list` y reconectar desde *Settings → Connectors* en claude.ai.
4. Seguir sin validar es una decisión **del usuario, explícita**. Si te la da, dejá dicho en el
   resumen final que el trabajo se hizo **sin validación de colisiones**.

**Nunca interpretes un error del conector como "no hay tarea, está libre".** Un agente que no
puede consultar y avanza igual produce exactamente el trabajo duplicado que este protocolo existe
para evitar — y encima con la falsa confianza de haber chequeado.

## Paso 0 — ¿Esto amerita una tarea?

**No todo lo que se hace va al tablero.** Crear una tarea por consulta llena de ruido un tablero
compartido; no crearla para un cambio real deja el cambio sin rastro.

La prueba, en una línea:

> **¿Alguien más del equipo necesitaría saber que esto pasó?**

| Amerita tarea | NO amerita tarea |
| --- | --- |
| Cambia código, esquema, configuración o documentación que se commitea | Responder una pregunta, explicar código, leer para entender |
| Es un fix de algo que se reportó o que se rompió | Investigar o diagnosticar **sin** terminar en un cambio |
| Produce un entregable que otro consume | Ajustes del entorno local de quien trabaja |
| Va a quedar a medias y hay que retomarlo | Un rename hecho dentro de un trabajo ya reclamado |

**Si el diagnóstico termina en un cambio, ahí sí amerita** — y la tarea se crea con la fecha en
que el usuario lo pidió, no con la de cuando terminaste de investigar.

**Ante la duda, preguntale al usuario.** Una tarea de más es ruido; una de menos es trabajo sin
rastro en un tablero que otros miran para saber qué está pasando.

Si decidís que **no** amerita y vas a escribir código igual, declaralo por escrito o el candado te
va a frenar:

```bash
{{CLI}} exempt --reason "<motivo concreto>"
```

La exención **vence sola**, a propósito: una exención olvidada desactivaría el candado para
siempre y en silencio, que es justo el modo de fallo que el candado existe para evitar. Y **no es
un atajo para saltearse la búsqueda** — usarla para eso es exactamente lo que produce duplicados.

## Identidad: son DOS cosas distintas y conviene tenerlo claro

| Para qué | Qué se usa |
| --- | --- |
| **Escribir en los comentarios** (detectar colisiones) | El **email de git** (`git config user.email`) |
| **Asignar la tarea** | El **id numérico** de ClickUp que imprime `context` |

**La identidad de los comentarios es el email y nada más.** No se usa `user.name`: un mismo email
suele tener varios nombres en el historial de un repo (`Ana T.`, `atorres`, `ana-torres`, …), así que
incluirlo haría que la misma persona trabajando desde dos máquinas se viera como dos y el
protocolo la interrumpiría contra sí misma.

**Va escrito DENTRO del texto del comentario.** Todos los comentarios se publican con la cuenta
del token del MCP, sin importar quién ejecute, así que el campo "autor" de ClickUp es **inútil
para detectar colisiones**.

### 🛑 `"me"` está PROHIBIDO como assignee

`clickup_resolve_assignees(["me"])` devuelve **el dueño del token de la integración**, no la
persona que está ejecutando. En un equipo eso le asigna **todas** las tareas a la misma persona.
Es un error que no falla, no avisa, y se descubre semanas después cuando alguien filtra el tablero
por asignado.

El id correcto lo imprime `context`. **Si `context` dice que la identidad no está resuelta, no
asignes nada**: resolvela primero con `clickup_get_workspace_members` o
`clickup_find_member_by_name`, **mostrale los candidatos al usuario, esperá que confirme uno**, y
recién entonces:

```bash
{{CLI}} identity set --id <id numérico> --email <email de ClickUp> --name "<nombre>" --confirmed
```

**Un match por parecido de apellido no es evidencia de nada.** El email de git y el de ClickUp
pueden no parecerse: es normal que la cuenta del tablero esté en un dominio corporativo y los
commits vengan de un gmail. Con esa distancia, "se parece" no alcanza.

Para asignarle trabajo a **otra** persona hace falta su mapeo, con el mismo criterio:

```bash
{{CLI}} team add --git-email <email git> --clickup-id <id> --name "<nombre>" --confirmed
```

Sin `--confirmed`, la entrada queda marcada como deducida y **no se asigna con ella sin preguntar**.

## Paso 2 — Buscar ANTES de crear, siempre

`context` imprime las tres pasadas con la lista y la ventana ya resueltas. Lo que no cambia nunca:

- **`include_closed` viene apagado por defecto.** Sin encenderlo, una tarea ya `complete` no
  aparece y se crea un duplicado exacto.
- **`date_closed_from` devuelve SOLO tareas cerradas.** Nunca va en la búsqueda principal: haría
  desaparecer todo lo que está `to do`, `in progress`, `on hold` y `update required` — justo el
  trabajo que importa.
- **Lo que está esperando a alguien no se acota por fecha.** Un handoff de hace tres meses sigue
  siendo un handoff pendiente.
- **Probá varios términos**: el módulo, el síntoma y el nombre técnico. Una tarea que dice "los
  mensajes se guardan sin su contenido" no aparece buscando `text_content`.
- **Paginá** hasta el final (`has_more` / `next_cursor`).
- **Compará por significado**, no por coincidencia literal de título.

### ¿Tarea nueva, o va sobre una que ya existe?

**No se decide por tamaño** — nadie estima igual. Se decide con una prueba verificable:

> **¿El trabajo nuevo se puede describir sin cambiar el objetivo declarado de la tarea original?**

**Sí → va sobre la misma tarea. No → tarea nueva, vinculada a la original.**

| Situación | Qué se hace |
| --- | --- |
| **Fix** de algo que la tarea entregó mal, y sigue abierta | **Misma tarea** + comentario del fix |
| **Fix** de algo `complete` **hace poco** (ver la ventana en `context`) | **Misma tarea: se REABRE** a `in progress` con comentario `REAPERTURA` |
| **Fix** de algo `complete` de **hace mucho** | **No se reabre.** Tarea nueva, vinculada |
| **Feature** que extiende la tarea sin cambiar su objetivo | **Misma tarea**, se actualiza la descripción |
| **Feature** que cambia el objetivo, o toca módulos que la original no tocaba | **Tarea nueva, vinculada** |
| Alguien quiere **rehacer** desde cero algo ya `complete` | **Tarea nueva, vinculada.** No es un fix: es trabajo distinto sobre el mismo terreno |

Por qué no se reabre lo viejo: una tarea de hace meses arrastra un hilo de comentarios que ya no
describe el estado del código, y el `FIN` original —que alguien va a leer como el resumen de lo
entregado— pasa a describir algo que ya no es. La vinculación conserva la historia sin resucitar
el hilo.

Cuando corresponde tarea nueva, la relación se registra:

```
clickup_add_task_link  task_id:"<la nueva>"  links_to:"<la original>"
```

**Ante la duda, preguntá antes de crear nada.** El humano tiene contexto que el protocolo no.

## Un estado del tablero NO le veta el trabajo al usuario

Esto vale para todo el protocolo y es fácil de exagerar en la dirección equivocada.

Cuando encontrás que el trabajo **ya está tomado o ya se hizo**, eso **no cancela nada**. La
herramienta existe para que nadie duplique **por accidente**, no para negar trabajo por un estado
en un tablero. Y el usuario suele tener el contexto que falta: sabe que la otra persona no está,
sabe que es urgente, o sabe que en realidad es otra tarea que se parece.

**La regla:**

1. **Se plantea UNA vez**, con la información completa: quién la tiene, desde cuándo, con qué rol,
   y el resumen del `FIN` si estaba cerrada. "Alguien la tiene" no es información.
2. **Se ofrecen las tres salidas**, explícitamente: *no es la misma tarea* (tarea nueva vinculada —
   el caso más frecuente), *sí es la misma y la hago igual*, o *no la hago*.
3. **Decide el usuario, y se cumple.** Si elige seguir, se sigue.
4. **No se vuelve a plantear.** Repetir la advertencia cada turno es lo que hace que la gente deje
   de leerla.

Lo único que **no** es opcional cuando el usuario elige seguir sobre una tarea ajena: sumarse a los
asignados y dejar un comentario `TRABAJO EN PARALELO` con `notify_all: true`. Es lo que evita que
la otra persona descubra el trabajo duplicado en el merge. `context` trae el formato exacto.

## Paso 3 — Reclamar, antes de la primera línea de código

`context` imprime la llamada exacta. Las dos reglas que se rompen solas si no tenés cuidado:

**1. `assignees` recibe la lista COMPLETA y no tiene `add`/`rem`.** Mandar solo tu id sobre una
tarea que ya tenía dos asignados **borra a esas dos personas**, en silencio y sin aviso. Siempre:
`clickup_get_task` → unión → `clickup_update_task`. Y **nadie saca a nadie**, ni al cerrar ni al
reabrir.

**2. Re-verificá que ganaste la carrera, TAMBIÉN al tomar una tarea que ya existía.** Dos personas
pueden ver la misma tarea en `to do` con segundos de diferencia y ponerla las dos en
`in progress`: el segundo update **no falla** —el estado ya era ese— así que sin esta verificación
el caso más común del tablero es justo el que queda sin detectar.

Después de publicar tu `INICIO` y antes de escribir una línea: leé los comentarios, buscá un
`INICIO` de **otro email** sin `FIN` ni `on hold` posterior, y **gana el más antiguo** (si empatan,
el `id` de comentario menor). **Si perdiste: PARÁ**, dejá un comentario de `RETIRO`, **no toques el
estado** (la tarea es del otro), soltá el claim e informale al usuario quién la tiene.

Si ganaste, registrá el claim — es lo que desbloquea la escritura:

```bash
{{CLI}} claim --task-id <id> --title "<título>" [--role backend|frontend]
```

La misma lógica vale al **crear**: la ventana entre buscar y crear no se puede cerrar (ClickUp no
tiene "crear si no existe" atómico), solo se puede detectar. Volvé a buscar después de crear.

## Paso 4 — Cerrar

`context` imprime la bifurcación y **dónde va la fecha de fin en este proyecto** (no es igual en
todos, y escribirla en el campo equivocado borra datos de otra gente). Al terminar:

```bash
{{CLI}} release
```

**Si se abandona a mitad, nunca se deja en `in progress`.** Pasa a `on hold` con un comentario que
diga **dónde quedó**. Una tarea colgada en `in progress` bloquea a todos los demás por nada.

**`Sin verificar:` no es opcional** en el comentario de cierre. Es normal que algo quede sin
probar; lo que no es aceptable es que no esté dicho.

## Esto no depende de que vos te acuerdes

Tres hooks los ejecuta **el harness, no el modelo**. Ninguno se puede olvidar, diluir en una
compactación, ni omitir por conveniencia.

**1. `PreToolUse` — no se escribe sin tarea.**
Cancela toda escritura si el proyecto está registrado y no hay ni tarea reclamada ni exención
vigente. Cubre `Edit`, `Write`, `MultiEdit`, `NotebookEdit` **y `Bash`**: un heredoc, un `sed -i`,
un `tee`, un `git apply` o un `python -c` que escriba archivos se bloquean igual que un `Write`.
Y en un proyecto que la herramienta nunca vio, ese mismo hook **pregunta una vez** si acá se
gestionan tareas — no espera a que alguien se acuerde de ofrecer `/clickup-setup`.

**2. `PostToolUse` — la evidencia no la ponés vos.**
Cada llamada de escritura al MCP de ClickUp queda registrada leyendo el **resultado real** de la
herramienta. Un claim no está verificado porque lo digas: está verificado porque el harness vio
la mutación. Por eso `release` rechaza soltar una tarea sobre la que no hay ninguna.

**3. `Stop` — no se cierra el turno dejando el tablero desactualizado.**
Si hay una tarea reclamada y ninguna mutación registrada para ella, el turno **no puede
terminar**. Después de dos avisos suelta —un hook que bloquea para siempre cuelga la sesión— pero
deja `sync_failed` escrito, y entonces el candado de escritura no vuelve a abrirse en ese proyecto
hasta reconciliar. El fallo no se pierde: se traslada.

Los hooks 2 y 3 **se arman solos**: mientras el `PostToolUse` no haya corrido ni una vez en esta
instalación, no se exige nada y se falla abierto. La razón es simple — si el matcher no coincide
con el nombre de las herramientas de tu conector, exigir evidencia trabaría el proyecto acusándote
de algo que hiciste bien. `clickup-flow doctor` dice si está armada o no.

**Lo que sigue dependiendo de vos, dicho sin adornos:** el CLI **no puede escribir en ClickUp**.
El conector es OAuth de claude.ai, no hay token en disco, y ningún proceso fuera de una sesión de
Claude puede llamarlo. Crear la tarea, comentarla y cerrarla lo hacés vos por MCP. Lo que cambió
es que ya no sos la única fuente sobre si lo hiciste.

## Qué NO va a ClickUp

Credenciales, contenido de `.env`, tokens, claves, volcados de datos de clientes, ni fragmentos de
consultas con datos reales. ClickUp es un sistema externo: lo que se escribe ahí sale del repo.
**Vale también para los adjuntos.**

## El contrato se REFERENCIA, no se adjunta

Cuando un comentario tiene que apuntar a documentación: ruta + sección + **hash del commit**
(`git rev-parse --short HEAD`). Un adjunto queda congelado — en cuanto el doc cambia, miente, y
del otro lado alguien implementa contra un contrato viejo.
